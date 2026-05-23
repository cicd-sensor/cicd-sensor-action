#!/usr/bin/env node
// cicd-sensor-action — post step.
//
// Runs after the user's workload. Existing-agent mode only talks to
// the configured socket: health check, project result/end, artifacts.
// Managed mode additionally checks systemd state because the action
// installed that agent. On health failure, uploads a debug bundle and
// throws without producing the normal report/attestation artifacts.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';

const SNAPSHOT_PROPERTIES = [
  'MainPID',
  'NRestarts',
  'ActiveEnterTimestampMonotonic',
  'ActiveState',
  'SubState',
  'Result',
];

const TAMPER_FIELDS = [
  'MainPID',
  'NRestarts',
  'ActiveEnterTimestampMonotonic',
  'ActiveState',
];

const STATE = {
  snapshotPath: 'snapshotPath',
  socket: 'socket',
  ctlPath: 'ctlPath',
  managerTokenFile: 'managerTokenFile',
  enableHtmlReport: 'enableHtmlReport',
  enableAttestationArtifact: 'enableAttestationArtifact',
  enableDebug: 'enableDebug',
  reusedExistingAgent: 'reusedExistingAgent',
  dockerProxyEnabled: 'dockerProxyEnabled',
};

const AGENT_UNIT_NAME = 'cicd-sensor-agent.service';
const PROXY_UNIT_NAME = 'cicd-sensor-proxy.service';

const ARTIFACT_REPORT = 'cicd-sensor-report';
const ARTIFACT_ATTESTATION = 'cicd-sensor-attestation';
const ARTIFACT_DEBUG = 'cicd-sensor-debug';

const PROVIDER = 'github';
const BIN = '/usr/local/bin/cicd-sensor';
const DEFAULT_SOCKET = '/run/cicd-sensor/agent.sock';
const DEBUG_RUNTIME_TELEMETRY_PATH = '/home/runner/work/_temp/cicd_sensor_debug/job_runtime_telemetry_log.json.gz';

// ─────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────

function parseShow(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function snapshotSystemd(unitName) {
  const propArg = '--property=' + SNAPSHOT_PROPERTIES.join(',');
  const r = spawnSync('systemctl', ['show', unitName, propArg], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl show ${unitName} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function deriveProviderHost() {
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  return serverUrl
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/:.*$/, '')
    .toLowerCase();
}

function jobIdentityArgs(socket) {
  return [
    '--socket', socket,
    '--provider', PROVIDER,
    '--provider-host', deriveProviderHost(),
    '--project-path', process.env.GITHUB_REPOSITORY || '',
    '--github-run-id', process.env.GITHUB_RUN_ID || '',
    '--github-run-attempt', process.env.GITHUB_RUN_ATTEMPT || '',
    '--github-job', process.env.GITHUB_JOB || '',
    '--github-runner-tracking-id', process.env.RUNNER_TRACKING_ID || '',
  ];
}

function artifactUrl(artifactId) {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  if (!repo || !runId || !artifactId) return '';
  return `${server}/${repo}/actions/runs/${runId}/artifacts/${artifactId}`;
}

// ─────────────────────────────────────────────────────────────────
// health check (early fail)
// ─────────────────────────────────────────────────────────────────

function checkAgentHealth(socket, checkSystemd = true) {
  // (1) socket present
  let isSock = false;
  try { isSock = fs.statSync(socket).isSocket(); } catch {}
  if (!isSock) {
    core.error(`agent socket ${socket} is not a live unix socket`);
    return false;
  }
  // (2) systemd reports active
  if (checkSystemd) {
    const sd = spawnSync('systemctl', ['is-active', AGENT_UNIT_NAME], { encoding: 'utf8' });
    const sdState = (sd.stdout || '').trim();
    if (sdState !== 'active') {
      core.error(`systemctl is-active ${AGENT_UNIT_NAME} = '${sdState}' (expected 'active')`);
      return false;
    }
  }
  // (3) agent answers `job health` for this job
  const h = spawnSync(BIN, ['job', 'health', ...jobIdentityArgs(socket)],
    { encoding: 'utf8' });
  if (h.status !== 0) {
    core.error(`cicd-sensor job health exited with status ${h.status}`);
    if (h.stderr) core.error(h.stderr.trim());
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// tamper verify (post-workload snapshot diff)
// ─────────────────────────────────────────────────────────────────

function verifyTamper() {
  const snapshotPath = core.getState(STATE.snapshotPath);
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { tampered: false, drift: [], current: {}, nowText: '' };
  }

  const startState = parseShow(fs.readFileSync(snapshotPath, 'utf8'));
  const nowText = snapshotSystemd(AGENT_UNIT_NAME);
  const nowState = parseShow(nowText);

  const drift = [];
  for (const f of TAMPER_FIELDS) {
    if (startState[f] !== nowState[f]) {
      drift.push(`${f}: ${startState[f] || '<unset>'} -> ${nowState[f] || '<unset>'}`);
    }
  }
  if (nowState.ActiveState !== 'active') {
    drift.push(`ActiveState=${nowState.ActiveState || '<unset>'} (expected active)`);
  }
  return { tampered: drift.length > 0, drift, current: nowState, nowText };
}

// ─────────────────────────────────────────────────────────────────
// artifact generation
// ─────────────────────────────────────────────────────────────────

function finishProjectAndEmitResultLog(socket, outputPath) {
  // `project result` is the action's final message to the agent for
  // this job. It closes the project-side tracking state and writes the
  // result document used by report / attestation generation.
  const args = ['project', 'result', ...jobIdentityArgs(socket),
    '--output-file', outputPath];
  const r = spawnSync(BIN, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    core.warning(`cicd-sensor project result exited with status ${r.status}`);
    return false;
  }
  return true;
}

function pipeIntoCtl(ctl, subcommand, resultLogPath, outputPath) {
  const input = fs.openSync(resultLogPath, 'r');
  try {
    const r = spawnSync(ctl, ['report', subcommand, '--output-file', outputPath], {
      stdio: [input, 'inherit', 'inherit'],
    });
    if (r.status !== 0) {
      core.warning(`${ctl} report ${subcommand} exited with status ${r.status}`);
      return false;
    }
  } finally {
    fs.closeSync(input);
  }
  return true;
}

function runOutput(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function captureJournal(outputPath) {
  // Filter to JSON lines only; systemd's own unit lifecycle messages
  // would confuse downstream jq parsing.
  const r = runOutput('sudo', [
    'journalctl', '-u', AGENT_UNIT_NAME,
    '--output=cat', '--no-pager',
  ]);
  if (r.status !== 0) {
    core.warning(`journal capture exited with status ${r.status}`);
    if (r.stderr) core.warning(r.stderr.trim());
    return;
  }
  const jsonLines = r.stdout.split('\n').filter((line) => line.startsWith('{'));
  fs.writeFileSync(outputPath, jsonLines.length > 0 ? `${jsonLines.join('\n')}\n` : '');
}

function captureProxyJournal(outputPath) {
  const r = runOutput('sudo', [
    'journalctl', '-u', PROXY_UNIT_NAME,
    '--no-pager',
  ]);
  if (r.status !== 0) {
    core.warning(`proxy journal capture exited with status ${r.status}`);
    if (r.stderr) core.warning(r.stderr.trim());
    return;
  }
  fs.writeFileSync(outputPath, r.stdout);
}

function writeSystemctlShow(outputPath, snapshotText) {
  fs.writeFileSync(outputPath, snapshotText || snapshotSystemd(AGENT_UNIT_NAME));
}

async function uploadOne(client, name, outDir, files, options = {}) {
  const existing = files.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
  if (existing.length === 0) return null;
  core.info(`==> Uploading ${existing.length} file(s) as artifact "${name}"`);
  const res = await client.uploadArtifact(name, existing, outDir, options);
  core.info(`Uploaded artifact "${name}" id=${res.id} size=${res.size} bytes`);
  return res;
}

function unlinkSilently(p) {
  try { fs.unlinkSync(p); } catch {}
}

// ─────────────────────────────────────────────────────────────────
// step summary
// ─────────────────────────────────────────────────────────────────

function appendStepSummaryMarkdown(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile || !markdown) return;
  fs.appendFileSync(summaryFile, markdown);
}

function stepSummaryArgs({ htmlArtifactId, debugArtifactId, healthFailed }) {
  const args = ['report', 'stepsummary'];
  const htmlUrl = artifactUrl(htmlArtifactId);
  const debugUrl = artifactUrl(debugArtifactId);
  if (htmlUrl) args.push('--html-url', htmlUrl);
  if (debugUrl) args.push('--debug-url', debugUrl);
  if (healthFailed) args.push('--health-failed');
  return args;
}

function writeStepSummaryWithCtl({ ctl, resultLogPath, htmlArtifactId, debugArtifactId, healthFailed }) {
  let input = 'ignore';
  let fd = null;
  if (resultLogPath && fs.existsSync(resultLogPath)) {
    fd = fs.openSync(resultLogPath, 'r');
    input = fd;
  }
  try {
    const args = stepSummaryArgs({ htmlArtifactId, debugArtifactId, healthFailed });
    const r = spawnSync(ctl, args, {
      encoding: 'utf8',
      stdio: [input, 'pipe', 'inherit'],
    });
    if (r.status !== 0) {
      core.warning(`${ctl} report stepsummary exited with status ${r.status}`);
      return false;
    }
    appendStepSummaryMarkdown(r.stdout);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────

async function failWithDebugBundle({ outDir, reason, snapshotText, dockerProxyEnabled, includeSystemd, ctl }) {
  core.error(reason);
  const journalPath = path.join(outDir, 'cicd-sensor-agent.log');
  const proxyJournalPath = path.join(outDir, 'cicd-sensor-proxy.log');
  const systemctlPath = path.join(outDir, 'systemctl-show.txt');
  const runtimeTelemetryPath = path.join(outDir, path.basename(DEBUG_RUNTIME_TELEMETRY_PATH));
  captureJournal(journalPath);
  try { fs.copyFileSync(DEBUG_RUNTIME_TELEMETRY_PATH, runtimeTelemetryPath); } catch {}
  if (dockerProxyEnabled) captureProxyJournal(proxyJournalPath);
  if (includeSystemd) {
    try { writeSystemctlShow(systemctlPath, snapshotText); } catch (err) {
      core.warning(`systemctl show snapshot failed: ${err && err.message ? err.message : err}`);
    }
  }

  let debugArtifact = null;
  const client = new DefaultArtifactClient();
  const bundle = [journalPath, proxyJournalPath, systemctlPath, runtimeTelemetryPath]
    .filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
  if (bundle.length > 0) {
    try {
      debugArtifact = await uploadOne(client, ARTIFACT_DEBUG, outDir, bundle);
    } catch (err) {
      core.warning(`debug artifact upload failed: ${err && err.message ? err.message : err}`);
    }
  }

  try {
    writeStepSummaryWithCtl({
      ctl,
      debugArtifactId: debugArtifact?.id,
      healthFailed: true,
    });
  } catch (err) {
    core.warning(`tampered step summary failed: ${err && err.message ? err.message : err}`);
  }

  core.setOutput('attestation-artifact-id', '');
  core.setOutput('attestation-artifact-url', '');

  const managerTokenFile = core.getState(STATE.managerTokenFile);
  if (managerTokenFile) unlinkSilently(managerTokenFile);

  throw new Error(reason);
}

async function main() {
  const socket = core.getState(STATE.socket) || DEFAULT_SOCKET;
  const ctl = core.getState(STATE.ctlPath);
  const enableHtmlReport = core.getState(STATE.enableHtmlReport) === 'true';
  const enableAttestation = core.getState(STATE.enableAttestationArtifact) === 'true';
  const enableDebug = core.getState(STATE.enableDebug) === 'true';
  const reusedExistingAgent = core.getState(STATE.reusedExistingAgent) === 'true';
  const dockerProxyEnabled = core.getState(STATE.dockerProxyEnabled) === 'true';
  const tmp = process.env.RUNNER_TEMP || '/tmp';
  const outDir = path.join(tmp, 'cicd-sensor-output');
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Early health check. Existing-agent mode deliberately skips
  // systemd because the host owns that lifecycle.
  const checkSystemd = !reusedExistingAgent;
  if (!checkAgentHealth(socket, checkSystemd)) {
    return await failWithDebugBundle({
      outDir,
      reason: 'cicd-sensor agent health check failed at post step',
      snapshotText: '',
      dockerProxyEnabled,
      includeSystemd: !reusedExistingAgent,
      ctl,
    });
  }

  // 2. Managed mode verifies the systemd snapshot taken in main.
  // Existing-agent mode is intentionally just socket protocol: start
  // was sent in main, result/end is sent below, and no systemd
  // invariant is assumed.
  let tamperResult = { tampered: false, drift: [], current: {}, nowText: '' };
  if (!reusedExistingAgent) {
    tamperResult = verifyTamper();
  } else {
    core.info('cicd-sensor post: existing-agent mode, skipping systemd tamper check');
  }
  let tamperErr = null;
  if (tamperResult.tampered) {
    core.error('cicd-sensor post: tampering detected');
    for (const d of tamperResult.drift) core.error(`  - ${d}`);
    tamperErr = new Error('cicd-sensor agent tampering detected');
  } else if (tamperResult.current.ActiveState) {
    core.info(
      `cicd-sensor post: state OK (MainPID=${tamperResult.current.MainPID} ` +
      `NRestarts=${tamperResult.current.NRestarts} ActiveState=${tamperResult.current.ActiveState})`,
    );
  }

  // 3. Emit result log + conditional artifact generation.
  const journalPath = path.join(outDir, 'cicd-sensor-agent.log');
  const proxyJournalPath = path.join(outDir, 'cicd-sensor-proxy.log');
  const resultLogPath = path.join(outDir, 'cicd-sensor-result-log.json');
  const htmlPath = path.join(outDir, 'cicd-sensor-report.html');
  const predicatePath = path.join(outDir, 'predicate.json');
  const systemctlPath = path.join(outDir, 'systemctl-show.txt');
  const runtimeTelemetryPath = path.join(outDir, path.basename(DEBUG_RUNTIME_TELEMETRY_PATH));

  const resultOk = finishProjectAndEmitResultLog(socket, resultLogPath);

  let htmlOk = false;
  if (enableHtmlReport && resultOk) htmlOk = pipeIntoCtl(ctl, 'html', resultLogPath, htmlPath);
  let predicateOk = false;
  if (enableAttestation && resultOk) predicateOk = pipeIntoCtl(ctl, 'attest', resultLogPath, predicatePath);

  if (enableDebug) {
    // Telemetry move runs after project result so the agent has
    // finalized the gzip stream and closed its fd.
    try { fs.renameSync(DEBUG_RUNTIME_TELEMETRY_PATH, runtimeTelemetryPath); } catch {}
    captureJournal(journalPath);
    if (dockerProxyEnabled) captureProxyJournal(proxyJournalPath);
    if (!reusedExistingAgent) {
      try { writeSystemctlShow(systemctlPath, tamperResult.nowText); } catch (err) {
        core.warning(`systemctl show snapshot failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  // 4. Upload each artifact independently.
  const client = new DefaultArtifactClient();
  let htmlArtifact = null;
  let attestationArtifact = null;
  let debugArtifact = null;
  if (enableHtmlReport && htmlOk) {
    try {
      // skipArchive keeps the HTML as a single file the UI opens inline.
      htmlArtifact = await uploadOne(client, ARTIFACT_REPORT, outDir, [htmlPath], { skipArchive: true });
    } catch (err) {
      core.warning(`html artifact upload failed: ${err && err.message ? err.message : err}`);
    }
  }
  if (enableAttestation && predicateOk) {
    try {
      attestationArtifact = await uploadOne(client, ARTIFACT_ATTESTATION, outDir, [predicatePath]);
    } catch (err) {
      core.warning(`attestation artifact upload failed: ${err && err.message ? err.message : err}`);
    }
  }
  if (enableDebug) {
    const bundle = [journalPath, proxyJournalPath, resultLogPath, systemctlPath, runtimeTelemetryPath]
      .filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
    if (bundle.length > 0) {
      try {
        debugArtifact = await uploadOne(client, ARTIFACT_DEBUG, outDir, bundle);
      } catch (err) {
        core.warning(`debug artifact upload failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  // 5. Step summary. The action passes only trusted artifact URLs;
  // result-log rendering belongs to cicd-sensorctl, not JavaScript.
  try {
    writeStepSummaryWithCtl({
      ctl,
      resultLogPath: resultOk ? resultLogPath : '',
      healthFailed: tamperResult.tampered,
      htmlArtifactId: htmlArtifact?.id,
      debugArtifactId: debugArtifact?.id,
    });
  } catch (err) {
    core.warning(`step summary write failed: ${err && err.message ? err.message : err}`);
  }

  // 6. Outputs — always set so consumers get '' rather than undefined.
  core.setOutput('attestation-artifact-id', attestationArtifact?.id ? String(attestationArtifact.id) : '');
  core.setOutput('attestation-artifact-url', artifactUrl(attestationArtifact?.id) || '');

  // 7. Unlink the staged manager token file.
  const managerTokenFile = core.getState(STATE.managerTokenFile);
  if (managerTokenFile) unlinkSilently(managerTokenFile);

  if (tamperErr) throw tamperErr;
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  main().catch((err) => {
    core.setFailed(err && err.message ? err.message : String(err));
  });
}

export {
  stepSummaryArgs,
};
