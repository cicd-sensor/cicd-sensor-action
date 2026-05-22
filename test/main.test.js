import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appArmorLSMEnabled,
  repoContentsURL,
  renderAgentSystemdRunArgs,
  renderAppArmorProfile,
  renderProjectStartArgs,
  renderProxySystemdRunArgs,
  validateManagerUrl,
  validateSocketPath,
  writeRepoDirectoryFiles,
} from '../src/main.js';

describe('input validation', () => {
  it('requires absolute socket paths without whitespace or control characters', () => {
    assert.equal(validateSocketPath('/run/cicd-sensor/agent.sock'), '/run/cicd-sensor/agent.sock');
    assert.throws(() => validateSocketPath('relative.sock'), /must be absolute/);
    assert.throws(() => validateSocketPath('/run/cicd sensor/agent.sock'), /whitespace or control/);
    assert.throws(() => validateSocketPath('/run/cicd-sensor/\nagent.sock'), /whitespace or control/);
  });

  it('requires https manager URLs without whitespace or control characters', () => {
    assert.equal(validateManagerUrl('https://manager.example.com/base'), 'https://manager.example.com/base');
    assert.throws(() => validateManagerUrl('http://manager.example.com'), /must use https/);
    assert.throws(() => validateManagerUrl('not a url'), /not a valid URL/);
    assert.throws(() => validateManagerUrl('https://manager.example.com/\n--flag'), /whitespace or control/);
  });
});

describe('systemd-run rendering', () => {
  it('does not use CICD_SENSOR_EXTRA_ARGS in agent transient units', () => {
    const withoutManager = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: '',
      managerTokenFile: '',
      appArmorProfile: '',
    });
    assert.equal(withoutManager.includes('CICD_SENSOR_EXTRA_ARGS'), false);
    assert.equal(withoutManager.includes('--socket'), true);
    assert.equal(withoutManager.includes('/run/cicd-sensor/agent.sock'), true);
    assert.equal(withoutManager.includes('--manager-url'), false);

    const withManager = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: 'https://manager.example.com/',
      managerTokenFile: '/tmp/cicd-sensor-manager.token',
      appArmorProfile: '',
    });
    assert.equal(withManager.includes('CICD_SENSOR_EXTRA_ARGS'), false);
    assert.equal(withManager.includes('--manager-url'), true);
    assert.equal(withManager.includes('https://manager.example.com/'), true);
    assert.equal(withManager.includes('--manager-token-file'), true);
    assert.equal(withManager.includes('/tmp/cicd-sensor-manager.token'), true);
  });

  it('renders proxy transient unit with the validated agent socket path', () => {
    const args = renderProxySystemdRunArgs({ socketPath: '/run/cicd-sensor/agent.sock' });
    assert.equal(args.includes('--agent-socket'), true);
    assert.equal(args.includes('/run/cicd-sensor/agent.sock'), true);
    assert.equal(args.includes('${CICD_SENSOR_SOCKET}'), false);
  });

  it('does not ask systemd to restart the agent automatically', () => {
    const agent = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: '',
      managerTokenFile: '',
      appArmorProfile: '',
    });

    assert.equal(agent.some((arg) => arg === '--property=Restart=on-failure'), false);
    assert.equal(agent.some((arg) => arg.startsWith('--property=RestartSec=')), false);
    assert.equal(agent.some((arg) => arg.startsWith('--property=StartLimitIntervalSec=')), false);
  });

  it('restarts the proxy transient unit on failure', () => {
    const proxy = renderProxySystemdRunArgs({ socketPath: '/run/cicd-sensor/agent.sock' });
    assert.equal(proxy.includes('--property=Restart=on-failure'), true);
    assert.equal(proxy.includes('--property=RestartSec=100ms'), true);
  });

  it('uses stop/isolate/OOM hardening for transient units', () => {
    const agent = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: '',
      managerTokenFile: '',
      appArmorProfile: '',
    });
    const proxy = renderProxySystemdRunArgs({ socketPath: '/run/cicd-sensor/agent.sock' });

    for (const args of [agent, proxy]) {
      assert.equal(args.includes('--property=RefuseManualStop=yes'), true);
      assert.equal(args.includes('--property=IgnoreOnIsolate=yes'), true);
      assert.equal(args.includes('--property=OOMScoreAdjust=-1000'), true);
    }
  });

  it('adds AppArmorProfile only when a profile is provided', () => {
    const withoutProfile = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: '',
      managerTokenFile: '',
      appArmorProfile: '',
    });
    assert.equal(withoutProfile.some((arg) => arg.startsWith('--property=AppArmorProfile=')), false);

    const withProfile = renderAgentSystemdRunArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      managerUrl: '',
      managerTokenFile: '',
      appArmorProfile: 'cicd-sensor-action-agent',
    });
    assert.equal(withProfile.includes('--property=AppArmorProfile=cicd-sensor-action-agent'), true);
  });
});

describe('project start args', () => {
  it('uses JobLogContext flag names for identity and optional metadata', () => {
    const args = renderProjectStartArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      providerHost: 'github.example.com',
      projectConfigPath: '/tmp/config.yaml',
      projectRulesPath: '/tmp/rules.bundle.yaml',
      enableDebug: true,
      env: {
        GITHUB_REPOSITORY: 'acme/example',
        GITHUB_RUN_ID: '123',
        GITHUB_JOB: 'build',
        GITHUB_RUN_ATTEMPT: '2',
        RUNNER_TRACKING_ID: 'runner-1',
        GITHUB_SHA: 'abc123',
        GITHUB_REF_NAME: 'main',
        GITHUB_REF: 'refs/heads/ignored',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_ACTOR_ID: '1001',
        GITHUB_ACTOR: 'alice',
        GITHUB_WORKFLOW_REF: 'acme/example/.github/workflows/build.yml@refs/heads/main',
        GITHUB_WORKFLOW_SHA: 'def456',
        GITHUB_WORKFLOW: 'build',
      },
    });

    assert.deepEqual(args, [
      'project', 'start',
      '--socket', '/run/cicd-sensor/agent.sock',
      '--provider', 'github',
      '--provider-host', 'github.example.com',
      '--project-path', 'acme/example',
      '--github-run-id', '123',
      '--github-job', 'build',
      '--github-run-attempt', '2',
      '--github-runner-tracking-id', 'runner-1',
      '--commit-sha', 'abc123',
      '--ref-name', 'main',
      '--trigger', 'push',
      '--actor-id', '1001',
      '--actor-name', 'alice',
      '--github-workflow-ref', 'acme/example/.github/workflows/build.yml@refs/heads/main',
      '--github-workflow-sha', 'def456',
      '--github-workflow', 'build',
      '--config-file', '/tmp/config.yaml',
      '--rules-file', '/tmp/rules.bundle.yaml',
      '--enable-debug',
    ]);
    for (const oldFlag of ['--branch', '--actor', '--workflow', '--workflow-ref', '--workflow-sha']) {
      assert.equal(args.includes(oldFlag), false);
    }
  });

  it('does not fall back from GITHUB_REF to ref_name metadata', () => {
    const args = renderProjectStartArgs({
      socketPath: '/run/cicd-sensor/agent.sock',
      providerHost: 'github.com',
      env: {
        GITHUB_REPOSITORY: 'acme/example',
        GITHUB_RUN_ID: '123',
        GITHUB_JOB: 'build',
        GITHUB_RUN_ATTEMPT: '2',
        RUNNER_TRACKING_ID: 'runner-1',
        GITHUB_REF: 'refs/heads/main',
      },
    });

    assert.equal(args.includes('--ref-name'), false);
  });
});

describe('AppArmor helpers', () => {
  it('detects apparmor in the LSM list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cicd-sensor-lsm-'));
    const lsmPath = path.join(tmp, 'lsm');
    fs.writeFileSync(lsmPath, 'lockdown,capability,apparmor,bpf\n');
    assert.equal(appArmorLSMEnabled(lsmPath), true);
    fs.writeFileSync(lsmPath, 'lockdown,capability,bpf\n');
    assert.equal(appArmorLSMEnabled(lsmPath), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders a SIGKILL-only AppArmor receive denial', () => {
    const profile = renderAppArmorProfile();
    assert.match(profile, /deny signal \(receive\) set=\(kill\) peer=\*\*,/);
    assert.doesNotMatch(profile, /set=\(term\)/);
  });
});

describe('project config fetch helpers', () => {
  it('encodes nested Contents API paths segment-by-segment', () => {
    const url = repoContentsURL('owner/repo', 'abc123', '.cicd-sensor/rules/a file.yaml');
    assert.equal(
      url,
      'https://api.github.com/repos/owner/repo/contents/.cicd-sensor/rules/a%20file.yaml?ref=abc123',
    );
  });

  it('writes fetched rule files under the local rules directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cicd-sensor-action-'));
    writeRepoDirectoryFiles([
      { repoPath: '.cicd-sensor/rules/a.yaml', content: 'a: 1\n' },
      { repoPath: '.cicd-sensor/rules/nested/b.yaml', content: 'b: 2\n' },
    ], '.cicd-sensor/rules', tmp);

    assert.equal(fs.readFileSync(path.join(tmp, 'a.yaml'), 'utf8'), 'a: 1\n');
    assert.equal(fs.readFileSync(path.join(tmp, 'nested/b.yaml'), 'utf8'), 'b: 2\n');
  });
});
