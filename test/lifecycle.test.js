import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AGENT_UNIT_NAME, OWNED_INVOCATION_STATE, readAgentState, rememberManagedAgent, stopManagedAgent,
} from '../src/lifecycle.js';
import { runPost } from '../src/post.js';

let oldEnv;
beforeEach(() => { oldEnv = { ...process.env }; });
afterEach(() => { process.env = oldEnv; });

const active = {
  LoadState: 'loaded', ActiveState: 'active', InvocationID: 'original',
  Transient: 'yes', Restart: 'no', Result: 'success',
};
const absent = { LoadState: 'not-found', ActiveState: 'inactive' };

describe('managed invocation ownership', () => {
  it('saves the invocation before later setup can fail', () => {
    const saved = [];
    rememberManagedAgent({ read: () => active, save: (...args) => saved.push(args) });
    assert.deepEqual(saved, [[OWNED_INVOCATION_STATE, 'original']]);
  });
  for (const [name, change] of [
    ['missing identity', { InvocationID: '' }],
    ['installed service', { Transient: 'no' }],
    ['restart policy', { Restart: 'always' }],
  ]) {
    it(`does not claim ${name}`, () => {
      assert.throws(() => rememberManagedAgent({
        read: () => ({ ...active, ...change }), save: () => assert.fail('saved unsafe owner'),
      }));
    });
  }
});

describe('managed Agent SIGTERM and wait', () => {
  const cases = [
    { name: 'reused or never started Agent does not access systemd', id: '', states: [], signals: 0 },
    { name: 'waits for delayed drain after a single signal', states: [active, active, absent], signals: 1 },
    { name: 'accepts successful inactive exit', states: [active, { ...active, ActiveState: 'inactive' }], signals: 1 },
    { name: 'already collected Agent needs no signal', states: [absent], signals: 0 },
    { name: 'already inactive Agent needs no signal', states: [{ ...active, ActiveState: 'inactive' }], signals: 0 },
    { name: 'replacement is not signalled', states: [{ ...active, InvocationID: 'other' }], signals: 0, error: /invocation changed/ },
    { name: 'replacement during wait is detected', states: [active, { ...active, InvocationID: 'other' }], signals: 1, error: /invocation changed/ },
    { name: 'missing identity cannot authorize a signal', states: [{ ...active, InvocationID: '' }], signals: 0, error: /ownership/ },
    { name: 'installed service is not signalled', states: [{ ...active, Transient: 'no' }], signals: 0, error: /ownership/ },
    { name: 'restarting service is not signalled', states: [{ ...active, Restart: 'always' }], signals: 0, error: /ownership/ },
    { name: 'failed service surfaces failure', states: [{ ...active, ActiveState: 'failed', Result: 'exit-code' }], signals: 0, error: /unsuccessfully/ },
    { name: 'failed exit during drain surfaces failure', states: [active, { ...active, ActiveState: 'inactive', Result: 'signal' }], signals: 1, error: /unsuccessfully/ },
    { name: 'query error is not treated as exit', states: [new Error('query failed')], signals: 0, error: /query failed/ },
    { name: 'signal failure is reported without retry', states: [active], signalError: true, signals: 1, error: /signal failed/ },
    { name: 'deadline stops waiting without SIGKILL', states: [active], signals: 1, error: /did not exit/ },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      let calls = 0, signals = 0, clock = 0;
      const promise = stopManagedAgent(c.id ?? 'original', {
        read: (timeout) => {
          assert.ok(timeout > 0 && timeout <= 5000);
          const state = c.states[Math.min(calls++, c.states.length - 1)];
          assert.ok(state, 'unexpected systemd query');
          if (state instanceof Error) throw state;
          return state;
        },
        signal: () => { signals++; if (c.signalError) throw new Error('signal failed'); },
        wait: async (ms) => { clock += ms; }, now: () => clock, timeoutMs: 600,
      });
      if (c.error) await assert.rejects(promise, c.error);
      else await promise;
      assert.equal(signals, c.signals);
      if (c.id === '') assert.equal(calls, 0);
      assert.ok(clock <= 600);
    });
  }
});

describe('post cleanup on every path', () => {
  for (const c of [
    { name: 'reports finish before shutdown', socket: true },
    { name: 'report or health failure still shuts down', socket: true, reportFails: true },
    { name: 'failed main still shuts down its owned Agent', socket: false },
    { name: 'shutdown failure fails post', socket: true, stopFails: true },
    { name: 'original error survives an additional shutdown failure', socket: true, reportFails: true, stopFails: true },
  ]) {
    it(c.name, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-post-'));
      const token = path.join(tmp, 'token');
      fs.writeFileSync(token, 'test-only');
      process.env.STATE_socket = c.socket ? '/test.sock' : '';
      process.env[`STATE_${OWNED_INVOCATION_STATE}`] = 'original';
      process.env.STATE_managerTokenFile = token;
      const order = [];
      const original = new Error('report failed');
      try {
        const promise = runPost({
          processResults: async () => { order.push('report'); if (c.reportFails) throw original; },
          stop: async (id) => {
            assert.equal(id, 'original');
            assert.ok(fs.existsSync(token), 'token must survive until finalization');
            order.push('stop');
            if (c.stopFails) throw new Error('stop failed');
          },
        });
        if (c.reportFails) await assert.rejects(promise, (err) => err === original);
        else if (c.stopFails) await assert.rejects(promise, /stop failed/);
        else await promise;
        assert.deepEqual(order, c.socket ? ['report', 'stop'] : ['stop']);
        assert.equal(fs.existsSync(token), false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it('pre without main performs no report request or signal', async () => {
    process.env.STATE_socket = '';
    process.env[`STATE_${OWNED_INVOCATION_STATE}`] = '';
    process.env.STATE_managerTokenFile = '';
    await runPost({ processResults: () => assert.fail('main was skipped') });
  });
});

// Explicit opt-in: runs only on the disposable Ubuntu CI VM, never on a
// developer's host or a runner with an existing cicd-sensor service.
it('real systemd waits for SIGTERM drain on a protected transient unit', {
  skip: process.env.CICD_SENSOR_SYSTEMD_TEST !== '1',
}, async () => {
  assert.equal(readAgentState().LoadState, 'not-found', 'test needs an unused service name');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-systemd-'));
  const script = path.join(tmp, 'agent.sh');
  const ready = path.join(tmp, 'ready');
  const drained = path.join(tmp, 'drained');
  fs.writeFileSync(script, `#!/bin/bash\ntrap 'sleep 1; touch "$2"; exit 0' TERM\ntouch "$1"\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  const run = (...args) => {
    const result = spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    run('systemd-run', `--unit=${AGENT_UNIT_NAME}`, '--collect', '--property=RefuseManualStop=yes', script, ready, drained);
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(ready));
    let id;
    rememberManagedAgent({ save: (_, value) => { id = value; } });
    await stopManagedAgent(id);
    assert.ok(fs.existsSync(drained), 'must return after the TERM handler completed');
    assert.equal(readAgentState().LoadState, 'not-found');
  } finally {
    // Only this opt-in test's isolated fixture, if an assertion failed.
    spawnSync('sudo', ['-n', 'systemctl', 'kill', '--signal=SIGKILL', AGENT_UNIT_NAME], { timeout: 5000 });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
