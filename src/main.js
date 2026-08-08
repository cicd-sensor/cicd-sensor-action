#!/usr/bin/env node
// cicd-sensor-action — main step.
//
// Downloads cicd-sensor release tarballs, installs the binaries, then
// starts the agent under systemd. When the configured
// socket already points at a running agent (self-hosted), reuses it
// instead of re-installing.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as core from '@actions/core';

const REPO = 'cicd-sensor/cicd-sensor';
// Binary releases share the repo with rules releases under disjoint
// tag namespaces, so binary tags carry a `releases/` prefix.
const TAG_PREFIX = 'releases/';

// Read lazily so importing this module under tests does not require
// INPUT_CICD-SENSOR-VERSION to be set. Renovate bumps the value via
// action.yml's `cicd-sensor-version` input default.
function getAgentVersion() {
  const v = core.getInput('cicd-sensor-version').trim();
  if (!/^v\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`cicd-sensor-version must match vX.Y.Z, got '${v}'`);
  }
  return v;
}
const PROJECT_CONFIG_REPO_PATH = '.cicd-sensor/config.yaml';
const PROJECT_RULES_REPO_PATH = '.cicd-sensor/rules';
const PROVIDER = 'github';
const RUNNER = 'machine';
const DEFAULT_SOCKET = '/run/cicd-sensor/agent.sock';
const BIN_DIR = '/usr/local/bin';
const AGENT_UNIT_NAME = 'cicd-sensor-agent.service';
const PROXY_UNIT_NAME = 'cicd-sensor-proxy.service';
const APPARMOR_PROFILE_NAME = 'cicd-sensor-action-agent';
const APPARMOR_PROFILE_PATH = `/etc/apparmor.d/${APPARMOR_PROFILE_NAME}`;
const SOCKET_TIMEOUT_MS = 10_000;
// systemd must leave more time than the Agent's best-effort drain window;
// otherwise it can SIGKILL the Agent while manager logs are still flushing.
const AGENT_SHUTDOWN_GRACE_SECONDS = 20;
const AGENT_STOP_TIMEOUT_SECONDS = 30;

// Canonical paths for the dockerd takeover. The action hijacks
// /run/docker.sock via rename(2) so plain `docker` CLI keeps
// working transparently while every container create traverses
// cicd-sensor's proxy.
const DOCKER_SOCKET = '/run/docker.sock';
const DOCKER_UPSTREAM_SOCKET = '/run/docker-upstream.sock';
const DOCKER_PROXY_TIMEOUT_MS = 5_000;
const UNSAFE_ARG_CHARS = /[\s\x00-\x1f]/;

function rejectUnsafeArgValue(value, label) {
  if (UNSAFE_ARG_CHARS.test(value)) throw new Error(`${label} contains whitespace or control chars`);
}

// Validators run before any value reaches a systemd unit or argv.
// systemd's ExecStart parser splits on whitespace and the manager URL
// can flow into a CLI flag list, so we reject anything that could
// smuggle extra args. Inputs here come from workflow authors, not
// adversaries, but trusting their typos still produces a bad systemd
// failure mode (unit refuses to load, agent never starts).
function validateSocketPath(value) {
  if (!value.startsWith('/')) throw new Error(`socket-path must be absolute: ${value}`);
  rejectUnsafeArgValue(value, 'socket-path');
  return value;
}

function validateManagerUrl(value) {
  let url;
  try { url = new URL(value); } catch (err) {
    throw new Error(`manager-url is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:') throw new Error(`manager-url must use https:// (got ${url.protocol})`);
  rejectUnsafeArgValue(value, 'manager-url');
  return url.toString();
}

function validateAbsolutePath(value, label) {
  if (!value.startsWith('/')) throw new Error(`${label} must be absolute: ${value}`);
  rejectUnsafeArgValue(value, label);
  return value;
}

// The manager is a project-scope concern carried in `project start`.
// Agent start stays manager-agnostic so the action behaves the same
// whether it owns the agent lifecycle or reuses one started by a host
// operator.
function agentCommandArgs({ socketPath }) {
  return [
    path.join(BIN_DIR, 'cicd-sensor'),
    'agent', 'start',
    '--socket', socketPath,
    '--provider', PROVIDER,
    '--runner', RUNNER,
    '--shutdown-grace', `${AGENT_SHUTDOWN_GRACE_SECONDS}s`,
  ];
}

// Transient units keep CI cleanup simple: no unit files remain on the
// host, but post can still inspect systemd state for action-managed
// agents. The agent deliberately has no Restart= policy; if it dies,
// post should report that fact rather than hide the gap.
function renderAgentSystemdRunArgs({ socketPath, appArmorProfile }) {
  const args = [
    'systemd-run',
    `--unit=${AGENT_UNIT_NAME}`,
    '--collect',
    '--property=NoNewPrivileges=yes',
    '--property=PrivateTmp=yes',
    '--property=RuntimeDirectory=cicd-sensor',
    '--property=RuntimeDirectoryMode=0755',
    '--property=RefuseManualStop=yes',
    '--property=IgnoreOnIsolate=yes',
    '--property=OOMScoreAdjust=-1000',
    '--property=KillMode=mixed',
    `--property=TimeoutStopSec=${AGENT_STOP_TIMEOUT_SECONDS}s`,
  ];
  if (appArmorProfile) {
    args.push(`--property=AppArmorProfile=${appArmorProfile}`);
  }
  return [...args, ...agentCommandArgs({ socketPath })];
}

// The proxy is a recoverable socket relay, unlike the sensor itself.
// Restarting it avoids breaking Docker clients when only the proxy
// process crashes.
function renderProxySystemdRunArgs({ socketPath }) {
  return [
    'systemd-run',
    `--unit=${PROXY_UNIT_NAME}`,
    '--collect',
    `--property=Requires=${AGENT_UNIT_NAME}`,
    `--property=After=${AGENT_UNIT_NAME}`,
    '--property=Restart=on-failure',
    '--property=RestartSec=100ms',
    '--property=RefuseManualStop=yes',
    '--property=IgnoreOnIsolate=yes',
    '--property=OOMScoreAdjust=-1000',
    '--property=KillMode=mixed',
    '--property=TimeoutStopSec=5s',
    path.join(BIN_DIR, 'cicd-sensor'),
    'proxy', 'dockerd',
    '--provider', PROVIDER,
    '--upstream-socket', DOCKER_UPSTREAM_SOCKET,
    '--listen-socket', DOCKER_SOCKET,
    '--agent-socket', socketPath,
  ];
}

const SNAPSHOT_PROPERTIES = [
  'MainPID',
  'NRestarts',
  'ActiveEnterTimestampMonotonic',
  'ActiveState',
  'SubState',
  'Result',
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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited with status ${r.status}`);
}

function detectArch() {
  switch (process.arch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default: throw new Error(`unsupported runner arch: ${process.arch}`);
  }
}

function snapshotSystemd(unitName) {
  const propArg = '--property=' + SNAPSHOT_PROPERTIES.join(',');
  const r = spawnSync('systemctl', ['show', unitName, propArg], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl show ${unitName} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function waitForSocket(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fs.statSync(socketPath).isSocket()) return; } catch {}
    await sleep(200);
  }
  throw new Error(
    `agent socket ${socketPath} did not appear within ${timeoutMs}ms; ` +
    `check 'journalctl -u ${AGENT_UNIT_NAME}'`,
  );
}

function socketIsLive(socketPath) {
  try { return fs.statSync(socketPath).isSocket(); } catch { return false; }
}

function logRecentJournal(unitName) {
  spawnSync('sudo', [
    'journalctl', '-u', unitName,
    '--no-pager', '--since', '1 minute ago',
  ], { stdio: 'inherit' });
}

function commandAvailable(name) {
  const r = spawnSync('which', [name], { stdio: 'ignore' });
  return r.status === 0 || fs.existsSync(`/usr/sbin/${name}`) || fs.existsSync(`/sbin/${name}`);
}

function appArmorLSMEnabled(lsmPath = '/sys/kernel/security/lsm') {
  try {
    return fs.readFileSync(lsmPath, 'utf8').split(',').includes('apparmor');
  } catch {
    return false;
  }
}

function renderAppArmorProfile() {
  return [
    '#include <tunables/global>',
    '',
    `profile ${APPARMOR_PROFILE_NAME} /usr/local/bin/cicd-sensor flags=(attach_disconnected,mediate_deleted) {`,
    '  #include <abstractions/base>',
    '',
    '  capability,',
    '  network,',
    '  file,',
    '  mount,',
    '  umount,',
    '  ptrace,',
    '  signal,',
    '  dbus,',
    '  unix,',
    '',
    '  # Best-effort hardening: block simple SIGKILL against the agent.',
    '  deny signal (receive) set=(kill) peer=**,',
    '}',
    '',
  ].join('\n');
}

function setupAppArmorProfile(tmp) {
  if (!appArmorLSMEnabled()) {
    core.info('==> AppArmor LSM absent; starting agent without AppArmor profile');
    return '';
  }
  if (!commandAvailable('apparmor_parser')) {
    core.warning('AppArmor is enabled but apparmor_parser is missing; starting without AppArmor profile');
    return '';
  }

  const profileTmp = path.join(tmp, `${APPARMOR_PROFILE_NAME}.profile`);
  fs.writeFileSync(profileTmp, renderAppArmorProfile(), { mode: 0o644 });

  const install = spawnSync('sudo', ['install', '-m', '644', profileTmp, APPARMOR_PROFILE_PATH],
    { stdio: 'inherit' });
  if (install.status !== 0) {
    core.warning(`failed to install AppArmor profile (status ${install.status}); starting without AppArmor profile`);
    return '';
  }

  const load = spawnSync('sudo', ['apparmor_parser', '-r', APPARMOR_PROFILE_PATH], { stdio: 'inherit' });
  if (load.status !== 0) {
    core.warning(`failed to load AppArmor profile (status ${load.status}); starting without AppArmor profile`);
    return '';
  }

  core.info(`==> AppArmor profile loaded: ${APPARMOR_PROFILE_NAME}`);
  return APPARMOR_PROFILE_NAME;
}

function deriveProviderHost() {
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  return serverUrl
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/:.*$/, '')
    .toLowerCase();
}

function renderProjectStartArgs({
  socketPath,
  providerHost = deriveProviderHost(),
  projectConfigPath = '',
  projectRulesPath = '',
  managerUrl = '',
  managerTokenFile = '',
  enableDebug = false,
  env = process.env,
}) {
  const projectArgs = [
    'project', 'start',
    '--socket', socketPath,
    '--provider', PROVIDER,
    '--provider-host', providerHost,
    '--project-path', env.GITHUB_REPOSITORY || '',
    '--github-run-id', env.GITHUB_RUN_ID || '',
    '--github-job', env.GITHUB_JOB || '',
    '--github-run-attempt', env.GITHUB_RUN_ATTEMPT || '',
    '--github-runner-tracking-id', env.RUNNER_TRACKING_ID || '',
  ];
  const metadataPairs = [
    ['--commit-sha', env.GITHUB_SHA],
    ['--ref-name', env.GITHUB_REF_NAME],
    ['--trigger', env.GITHUB_EVENT_NAME],
    ['--actor-id', env.GITHUB_ACTOR_ID],
    ['--actor-name', env.GITHUB_ACTOR],
    ['--github-workflow-ref', env.GITHUB_WORKFLOW_REF],
    ['--github-workflow-sha', env.GITHUB_WORKFLOW_SHA],
    ['--github-workflow', env.GITHUB_WORKFLOW],
  ];
  for (const [flag, value] of metadataPairs) {
    if (value) projectArgs.push(flag, value);
  }

  if (managerUrl) {
    projectArgs.push('--manager-url', managerUrl, '--manager-token-file', managerTokenFile);
  } else {
    if (projectConfigPath) projectArgs.push('--config-file', projectConfigPath);
    if (projectRulesPath) projectArgs.push('--rules-file', projectRulesPath);
  }
  if (enableDebug) projectArgs.push('--enable-debug');
  return projectArgs;
}

// Hosted runners are ephemeral; reusing a stale agent socket here is
// always a bug. Self-hosted runners set RUNNER_ENVIRONMENT=self-hosted.
function isGitHubHostedRunner() {
  return process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted';
}

function repoContentsURL(repo, ref, repoPath) {
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
}

async function fetchRepoContents(token, repo, ref, repoPath, accept) {
  const url = repoContentsURL(repo, ref, repoPath);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'User-Agent': 'cicd-sensor-action',
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`GitHub Contents API ${r.status} for ${repoPath}: ${await r.text()}`);
  }
  return r;
}

// Fetch project files through the Contents API so the action can run
// before `actions/checkout`. Rules are a directory because project
// policies are easier to review as multiple YAML files.
async function fetchRepoFile(token, repo, ref, repoPath) {
  const r = await fetchRepoContents(token, repo, ref, repoPath, 'application/vnd.github.raw');
  return r === null ? null : await r.text();
}

async function fetchRepoDirectoryFiles(token, repo, ref, repoPath) {
  const r = await fetchRepoContents(token, repo, ref, repoPath, 'application/vnd.github+json');
  if (r === null) return [];
  const entries = await r.json();
  if (!Array.isArray(entries)) {
    throw new Error(`${repoPath} is not a directory`);
  }

  const files = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.type !== 'string') {
      continue;
    }
    if (entry.type === 'dir') {
      files.push(...await fetchRepoDirectoryFiles(token, repo, ref, entry.path));
      continue;
    }
    if (entry.type !== 'file') {
      core.warning(`skipping unsupported rules entry type ${entry.type}: ${entry.path}`);
      continue;
    }
    const content = await fetchRepoFile(token, repo, ref, entry.path);
    if (content !== null) files.push({ repoPath: entry.path, content });
  }
  return files;
}

function writeRepoDirectoryFiles(files, repoRootPath, dstDir) {
  for (const file of files) {
    if (!file.repoPath.startsWith(`${repoRootPath}/`)) {
      throw new Error(`unexpected repo path outside ${repoRootPath}: ${file.repoPath}`);
    }
    const relativePath = file.repoPath.slice(repoRootPath.length + 1);
    // Contents API never emits `..` segments, but path.join with a
    // crafted segment could escape dstDir. Cheap defense.
    if (relativePath.split('/').includes('..')) {
      throw new Error(`unexpected '..' segment in repo path: ${file.repoPath}`);
    }
    const dstPath = path.join(dstDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.writeFileSync(dstPath, file.content);
  }
}

function bundleProjectRules(rulesDir, outputPath, ctl) {
  run(ctl, [
    'rule', 'bundle',
    '--input-dir', rulesDir,
    '--output-file', outputPath,
  ]);
  run(ctl, ['rule', 'validate', outputPath]);
}

// Hijack /run/docker.sock so every container create traverses
// cicd-sensor. The proxy runs as a transient systemd unit with a
// restart policy because it is only a socket relay. Skipped on
// self-hosted reuse (operator owns the proxy lifecycle) and on hosts
// where docker is absent. Non-fatal — workloads that don't shell out
// to docker keep working with the agent alone.
async function setupDockerProxy(socketPath) {
  if (!fs.existsSync(DOCKER_SOCKET) && fs.existsSync(DOCKER_UPSTREAM_SOCKET)) {
    core.warning(`${DOCKER_UPSTREAM_SOCKET} left behind without ${DOCKER_SOCKET}; restoring docker socket`);
    spawnSync('sudo', ['mv', DOCKER_UPSTREAM_SOCKET, DOCKER_SOCKET], { stdio: 'inherit' });
  }
  if (!fs.existsSync(DOCKER_SOCKET)) {
    return { enabled: false };
  }
  if (fs.existsSync(DOCKER_UPSTREAM_SOCKET)) {
    core.warning(
      `${DOCKER_UPSTREAM_SOCKET} already present; previous run left state behind, skipping`,
    );
    return { enabled: false };
  }

  // Sanity check before hijacking. Keep /run/docker.sock intact until
  // the last moment so Docker keeps working if proxy setup bails early.
  const ping = spawnSync('sudo', [
    'curl', '--unix-socket', DOCKER_SOCKET,
    '--fail', '--silent', '--show-error', 'http://localhost/_ping',
  ], { encoding: 'utf8' });
  if (ping.status !== 0) {
    core.warning(`dockerd ping failed: ${ping.stderr || ping.stdout || `status ${ping.status}`}`);
    return { enabled: false };
  }

  // rename(2) atomic — dockerd keeps serving on its inode via the
  // original listening fd, while plain `docker` CLI starts hitting the
  // proxy as soon as systemd recreates the canonical path below.
  run('sudo', ['mv', DOCKER_SOCKET, DOCKER_UPSTREAM_SOCKET]);
  // If the runner is cancelled after the rename, the post step can
  // still restore the socket because this state is saved immediately.
  core.saveState(STATE.dockerProxyEnabled, 'true');

  core.info('==> Starting cicd-sensor-proxy');
  const start = spawnSync('sudo', renderProxySystemdRunArgs({ socketPath }), { stdio: 'inherit' });
  if (start.status !== 0) {
    core.warning(`failed to start ${PROXY_UNIT_NAME} transient unit (status ${start.status}); restoring upstream socket`);
    logRecentJournal(PROXY_UNIT_NAME);
    spawnSync('sudo', ['mv', DOCKER_UPSTREAM_SOCKET, DOCKER_SOCKET]);
    return { enabled: false };
  }

  try {
    await waitForSocket(DOCKER_SOCKET, DOCKER_PROXY_TIMEOUT_MS);
  } catch (err) {
    core.warning(`docker proxy did not bind ${DOCKER_SOCKET}: ${err.message}`);
    logRecentJournal(PROXY_UNIT_NAME);
    spawnSync('sudo', ['rm', '-f', DOCKER_SOCKET]);
    spawnSync('sudo', ['mv', DOCKER_UPSTREAM_SOCKET, DOCKER_SOCKET]);
    return { enabled: false };
  }

  // Restore the docker CLI's expected permissions. chgrp may fail on
  // hosts without a docker group — not fatal, root can still talk.
  spawnSync('sudo', ['chgrp', 'docker', DOCKER_SOCKET]);
  spawnSync('sudo', ['chmod', '660', DOCKER_SOCKET]);

  return { enabled: true };
}

function stageReleaseBinaries(tmp) {
  const arch = detectArch();
  const stagedDir = path.join(tmp, 'cicd-sensor-staging');
  const extractDir = path.join(stagedDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  const agentVersion = getAgentVersion();
  const versionNoV = agentVersion.slice(1);
  const releaseTag = `${TAG_PREFIX}${agentVersion}`;
  const tarball = `cicd-sensor_${versionNoV}_linux_${arch}.tar.gz`;
  const tarballPath = path.join(stagedDir, tarball);
  const downloadBase = `https://github.com/${REPO}/releases/download/${releaseTag}`;

  core.info(`==> Downloading ${tarball}`);
  run('curl', [
    '--fail', '--silent', '--show-error', '--location',
    '--output', tarballPath, `${downloadBase}/${tarball}`,
  ]);

  run('tar', ['xzf', tarballPath, '-C', extractDir]);

  const agentBin = path.join(extractDir, `cicd-sensor-linux-${arch}`);
  const ctlBin = path.join(extractDir, `cicd-sensorctl-linux-${arch}`);
  for (const f of [agentBin, ctlBin]) {
    if (!fs.existsSync(f)) throw new Error(`expected file missing from release tarball: ${path.basename(f)}`);
    fs.chmodSync(f, 0o755);
  }

  return { agentBin, ctlBin };
}

// Only the agent gets system-installed: systemd-run's ExecStart needs
// a stable absolute path. ctl is invoked directly from the staged copy
// so concurrent jobs on a shared self-hosted host never race on
// /usr/local/bin/cicd-sensorctl.
function installAgentBinary(agentBin) {
  core.info('==> Installing agent binary');
  run('sudo', ['install', '-m', '755', agentBin, path.join(BIN_DIR, 'cicd-sensor')]);
}

function writeManagerTokenFile({ managerUrl, managerToken, tmp }) {
  let managerTokenFile = '';
  if (managerUrl) {
    managerTokenFile = path.join(tmp, 'cicd-sensor-manager.token');
    fs.writeFileSync(managerTokenFile, managerToken, { mode: 0o600 });
    // managerTokenFile is action-generated under RUNNER_TEMP; validate
    // anyway since it flows into the unit's ExecStart.
    validateAbsolutePath(managerTokenFile, 'manager-token-file');
  }
  return managerTokenFile;
}

async function startManagedAgent({ socketPath, tmp }) {
  const appArmorProfile = setupAppArmorProfile(tmp);

  core.info('==> Starting cicd-sensor');
  run('sudo', renderAgentSystemdRunArgs({
    socketPath,
    appArmorProfile,
  }));

  try {
    await waitForSocket(socketPath, SOCKET_TIMEOUT_MS);
  } catch (err) {
    core.error('agent socket did not appear; dumping journal:');
    logRecentJournal(AGENT_UNIT_NAME);
    spawnSync('sudo', ['systemctl', 'status', AGENT_UNIT_NAME, '--no-pager'], { stdio: 'inherit' });
    throw err;
  }
}

async function installAndStartManagedAgent({ socketPath, tmp }) {
  // Keep all release download / binary install work before AppArmor
  // and systemd-run setup. If a release fetch fails, the host service
  // policy and Docker socket are untouched.
  const { agentBin, ctlBin } = stageReleaseBinaries(tmp);
  installAgentBinary(agentBin);
  await startManagedAgent({ socketPath, tmp });
  return { ctlBin };
}

async function main() {
  const githubToken = core.getInput('github-token', { required: true });
  // Default ${{ github.token }} is already runner-masked; explicit
  // setSecret protects custom PAT / GitHub App tokens against accidental
  // surfaces in error messages (e.g. Contents API response body).
  if (githubToken) core.setSecret(githubToken);
  const socketPath = validateSocketPath(core.getInput('socket-path') || DEFAULT_SOCKET);
  const managerUrlRaw = core.getInput('manager-url');
  const managerUrl = managerUrlRaw ? validateManagerUrl(managerUrlRaw) : '';
  const managerToken = core.getInput('manager-token');
  const enableHtmlReport = core.getBooleanInput('enable-html-report');
  const enableAttestationArtifact = core.getBooleanInput('enable-attestation-artifact');
  const enableDebug = core.getBooleanInput('enable-debug');

  if (managerToken && !managerUrl) throw new Error("'manager-token' set but 'manager-url' is empty");
  if (managerUrl && !managerToken) throw new Error("'manager-url' set but 'manager-token' is empty");
  if (managerToken) core.setSecret(managerToken);

  const tmp = process.env.RUNNER_TEMP || '/tmp';

  // Hosted runners are ephemeral, so a leftover socket here is stale
  // state rather than a pre-installed agent. Self-hosted only.
  const reuseAgent = !isGitHubHostedRunner() && socketIsLive(socketPath);

  // Token file is needed by `cicd-sensor project start --manager-token-file`
  // regardless of whether this step starts a managed agent or reuses one
  // that the host operator already started — the CLI forwards it into
  // the project-start request body.
  const managerTokenFile = writeManagerTokenFile({ managerUrl, managerToken, tmp });

  core.saveState(STATE.reusedExistingAgent, reuseAgent ? 'true' : 'false');

  let ctlPath;
  if (reuseAgent) {
    core.info(`==> Reusing existing cicd-sensor socket at ${socketPath}`);
    core.saveState(STATE.dockerProxyEnabled, 'false');
    // ctl is staged into RUNNER_TEMP even in reuse mode so the post
    // step never depends on host-installed paths and concurrent jobs
    // on the same self-hosted host don't race on /usr/local/bin.
    ({ ctlBin: ctlPath } = stageReleaseBinaries(tmp));
  } else {
    ({ ctlBin: ctlPath } = await installAndStartManagedAgent({ socketPath, tmp }));

    const snapshotPath = path.join(tmp, 'cicd-sensor-start.txt');
    fs.writeFileSync(snapshotPath, snapshotSystemd(AGENT_UNIT_NAME));
    core.saveState(STATE.snapshotPath, snapshotPath);

    // Managed mode owns the docker proxy lifecycle. Existing-agent
    // mode leaves proxy setup to the host operator.
    let dockerProxy = { enabled: false };
    try {
      dockerProxy = await setupDockerProxy(socketPath);
    } catch (err) {
      core.warning(`docker proxy setup failed: ${err && err.message ? err.message : err}`);
    }
    core.saveState(STATE.dockerProxyEnabled, dockerProxy.enabled ? 'true' : 'false');
  }

  core.saveState(STATE.socket, socketPath);
  core.saveState(STATE.ctlPath, ctlPath);
  core.saveState(STATE.managerTokenFile, managerTokenFile);
  core.saveState(STATE.enableHtmlReport, enableHtmlReport ? 'true' : 'false');
  core.saveState(STATE.enableAttestationArtifact, enableAttestationArtifact ? 'true' : 'false');
  core.saveState(STATE.enableDebug, enableDebug ? 'true' : 'false');

  // Project config / rules fetched via Contents API so the action can
  // run before `actions/checkout`.
  let projectConfigPath = '';
  let projectRulesPath = '';
  if (!managerUrl) {
    const repo = process.env.GITHUB_REPOSITORY || '';
    const ref = process.env.GITHUB_SHA || '';
    if (repo && ref) {
      const configDir = path.join(tmp, 'cicd-sensor-config');
      fs.mkdirSync(configDir, { recursive: true });
      try {
        const cfg = await fetchRepoFile(githubToken, repo, ref, PROJECT_CONFIG_REPO_PATH);
        if (cfg !== null) {
          projectConfigPath = path.join(configDir, 'config.yaml');
          fs.writeFileSync(projectConfigPath, cfg);
          core.info(`==> Loaded ${PROJECT_CONFIG_REPO_PATH} from repo`);
        }

        const ruleFiles = await fetchRepoDirectoryFiles(githubToken, repo, ref, PROJECT_RULES_REPO_PATH);
        if (ruleFiles.length > 0) {
          const rulesDir = path.join(configDir, 'rules');
          writeRepoDirectoryFiles(ruleFiles, PROJECT_RULES_REPO_PATH, rulesDir);
          projectRulesPath = path.join(configDir, 'rules.bundle.yaml');
          bundleProjectRules(rulesDir, projectRulesPath, ctlPath);
          core.info(`==> Loaded ${ruleFiles.length} project rule file(s) from ${PROJECT_RULES_REPO_PATH}`);
        }
      } catch (err) {
        core.warning(`project config fetch failed: ${err.message}; agent will run with baseline rules`);
      }
    }
  }

  core.info('==> Registering project start');
  const projectArgs = renderProjectStartArgs({
    socketPath,
    projectConfigPath,
    projectRulesPath,
    managerUrl,
    managerTokenFile,
    enableDebug,
  });

  // project start authenticates via SO_PEERCRED PID against the tracked
  // Job's cgroup, not by UID; the agent socket is mode 0777, so no sudo.
  run(path.join(BIN_DIR, 'cicd-sensor'), projectArgs);

  core.info('==> cicd-sensor-action main: ready');
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
  appArmorLSMEnabled,
  renderAgentSystemdRunArgs,
  renderAppArmorProfile,
  renderProjectStartArgs,
  renderProxySystemdRunArgs,
  setupDockerProxy,
  fetchRepoDirectoryFiles,
  repoContentsURL,
  validateManagerUrl,
  validateSocketPath,
  writeRepoDirectoryFiles,
};
