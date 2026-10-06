import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runPost, stopManagedAgent } from '../src/post.js';

let oldEnv, oldExitCode;
beforeEach(() => {
  oldEnv = { ...process.env };
  oldExitCode = process.exitCode;
  process.env.STATE_reusedExistingAgent = 'false';
  process.env.STATE_managedAgentStarted = 'true';
  process.env.STATE_socket = '';
  process.env.STATE_managerTokenFile = '';
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  process.env = oldEnv;
  process.exitCode = oldExitCode;
});

// Mock the command boundary, without adding injection options to production code.
function systemd(states, signalResult = { status: 0 }) {
  const calls = [];
  let reads = 0;
  mock.method(childProcess, 'spawnSync', (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'sudo') return signalResult;
    assert.equal(cmd, 'systemctl');
    const value = states[Math.min(reads++, states.length - 1)];
    assert.ok(value, 'unexpected systemd query');
    return typeof value === 'string' ? { status: value === 'active' ? 0 : 3, stdout: value } : value;
  });
  syncBuiltinESMExports();
  return calls;
}

describe('managed Agent shutdown', () => {
  for (const c of [
    { name: 'reused Agent never touches systemd', reuse: 'true', states: [], signals: 0 },
    { name: 'skipped main never touches systemd', reuse: '', started: '', states: [], signals: 0 },
    { name: 'failed launch never touches systemd', started: '', states: [], signals: 0 },
    { name: 'waits for drain after exactly one SIGTERM', states: ['active', 'deactivating', 'inactive'], signals: 1 },
    { name: 'collected unit counts as exited', states: ['active', 'unknown'], signals: 1 },
    { name: 'already exited needs no signal', states: ['inactive'], signals: 0 },
    { name: 'failed unit surfaces failure', states: ['failed'], signals: 0, error: /cannot wait/ },
    { name: 'query failure is not treated as exit', states: [{ status: 1, stderr: 'bus unavailable' }], signals: 0, error: /bus unavailable/ },
    { name: 'query timeout surfaces failure', states: [{ error: new Error('query timeout') }], signals: 0, error: /query timeout/ },
    { name: 'signal failure surfaces failure', states: ['active'], signalResult: { status: 1 }, signals: 1, error: /SIGTERM failed/ },
    { name: 'signal timeout surfaces failure', states: ['active'], signalResult: { error: new Error('signal timeout') }, signals: 1, error: /signal timeout/ },
    { name: 'deadline ends the wait without SIGKILL', states: ['active'], timeout: true, signals: 1, error: /within 30s/ },
  ]) {
    it(c.name, async () => {
      if (c.reuse !== undefined) process.env.STATE_reusedExistingAgent = c.reuse;
      if (c.started !== undefined) process.env.STATE_managedAgentStarted = c.started;
      const calls = systemd(c.states, c.signalResult);
      if (c.timeout) {
        let ticks = 0;
        mock.method(Date, 'now', () => ticks++ === 0 ? 0 : 30_000);
      }
      if (c.error) await assert.rejects(stopManagedAgent(), c.error);
      else await stopManagedAgent();
      const signals = calls.filter(([cmd]) => cmd === 'sudo');
      assert.equal(signals.length, c.signals);
      for (const [, args] of signals) assert.deepEqual(args, [
        '-n', 'systemctl', 'kill', '--kill-who=main', '--signal=SIGTERM', 'cicd-sensor-agent.service',
      ]);
      if (c.states.length === 0) assert.equal(calls.length, 0);
    });
  }
});

describe('post cleanup', () => {
  for (const c of [
    { name: 'startup failure still stops a successfully launched Agent' },
    { name: 'report failure still stops the Agent', reportFails: true },
    { name: 'shutdown failure still removes the token', stopFails: true },
    { name: 'both failures fail post and still remove the token', reportFails: true, stopFails: true },
  ]) {
    it(c.name, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-post-'));
      const token = path.join(tmp, 'token');
      fs.writeFileSync(token, 'test-only');
      process.env.STATE_managerTokenFile = token;
      const calls = systemd(['active', 'inactive'], c.stopFails ? { status: 1 } : undefined);
      if (c.reportFails) {
        process.env.STATE_socket = '/test.sock';
        mock.method(fs, 'mkdirSync', () => { throw new Error('report directory unavailable'); });
      }
      try {
        await runPost();
        assert.equal(calls.filter(([cmd]) => cmd === 'sudo').length, 1);
        assert.equal(fs.existsSync(token), false);
        assert.equal(process.exitCode, c.reportFails || c.stopFails ? 1 : oldExitCode);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

// Explicit opt-in: a disposable Ubuntu CI VM with no existing Agent.
it('real systemd waits for SIGTERM drain on a protected transient unit', {
  skip: process.env.CICD_SENSOR_SYSTEMD_TEST !== '1',
}, async () => {
  const unit = 'cicd-sensor-agent.service';
  const state = () => childProcess.spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).stdout.trim();
  assert.ok(['inactive', 'unknown'].includes(state()), 'test needs an unused service name');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-systemd-'));
  const script = path.join(tmp, 'agent.sh');
  const ready = path.join(tmp, 'ready');
  const drained = path.join(tmp, 'drained');
  fs.writeFileSync(script, `#!/bin/bash\ntrap 'sleep 1; touch "$2"; exit 0' TERM\ntouch "$1"\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  try {
    const launched = childProcess.spawnSync('sudo', ['-n', 'systemd-run', `--unit=${unit}`, '--collect',
      '--property=RefuseManualStop=yes', script, ready, drained], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(launched.status, 0, launched.stderr);
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(ready));
    await stopManagedAgent();
    assert.ok(fs.existsSync(drained), 'must return after the TERM handler completed');
    assert.ok(['inactive', 'unknown'].includes(state()));
  } finally {
    childProcess.spawnSync('sudo', ['-n', 'systemctl', 'kill', '--signal=SIGKILL', unit], { timeout: 5000 });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
