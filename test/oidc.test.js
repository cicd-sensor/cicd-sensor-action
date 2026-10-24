import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { main, renderProjectStartArgs, requireOIDCVersion, validateManagerAuth } from '../src/main.js';
import { runPost } from '../src/post.js';

const requestToken = 'test-only-request-secret';
const managerToken = 'test-only-manager-secret';
const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/token?api-version=2',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
};
const valid = { managerAuth: 'oidc', managerUrl: 'https://manager.example/base', managerToken: '', idTokenAudience: '', env: oidcEnv };

describe('Manager authentication validation', () => {
  for (const [name, input, error] of [
    ['OIDC default audience', {}, null],
    ['OIDC explicit audience', { idTokenAudience: 'urn:example:manager' }, null],
    ['legacy token', { managerAuth: 'manager-token', managerToken }, null],
    ['no Manager', { managerAuth: 'manager-token', managerUrl: '', env: {} }, null],
    ['unknown mode with URL', { managerAuth: 'other' }, /manager-auth must/],
    ['unknown mode without URL', { managerAuth: 'other', managerUrl: '' }, /manager-auth must/],
    ['OIDC without URL', { managerUrl: '' }, /requires manager-url/],
    ['mixed credentials', { managerToken }, /cannot be combined/],
    ['URL without token', { managerAuth: 'manager-token' }, /manager-token.*empty/],
    ['token without URL', { managerAuth: 'manager-token', managerUrl: '', managerToken }, /manager-url.*empty/],
    ['token audience', { managerAuth: 'manager-token', managerToken, idTokenAudience: 'a' }, /id-token-audience requires/],
    ['audience without Manager', { managerAuth: 'manager-token', managerUrl: '', idTokenAudience: 'a' }, /id-token-audience requires/],
    ['audience with control characters', { idTokenAudience: 'a\nb' }, /whitespace or control/],
    ['missing runner URL', { env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken } }, /ACTIONS_ID_TOKEN_REQUEST_URL.*permissions: id-token: write/],
    ['missing runner token', { env: { ACTIONS_ID_TOKEN_REQUEST_URL: oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL } }, /ACTIONS_ID_TOKEN_REQUEST_TOKEN.*permissions: id-token: write/],
    ['blank runner token', { env: { ...oidcEnv, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '  ' } }, /permissions: id-token: write/],
  ]) {
    it(name, () => {
      const check = () => validateManagerAuth({ ...valid, ...input });
      if (error) assert.throws(check, error);
      else assert.doesNotThrow(check);
    });
  }
  for (const version of ['v0.0.49', 'v0.0.50', 'v0.1.0', 'v1.0.0']) {
    it(`accepts ${version}`, () => assert.doesNotThrow(() => requireOIDCVersion(version, 'test')));
  }
  for (const version of ['v0.0.48', 'v0.0.9', 'dev', '', 'v0.0.49-rc1', 'not-a-version']) {
    it(`rejects unverified version ${version}`, () => assert.throws(() => requireOIDCVersion(version, 'test'), /v0.0.49 or newer/));
  }
});

describe('project start credential arguments', () => {
  for (const audience of ['', 'urn:example:manager']) {
    it(`OIDC audience ${audience || 'omitted'}`, () => {
      const args = renderProjectStartArgs({ ...valid, idTokenAudience: audience, socketPath: '/test.sock', managerTokenFile: '/must-not-use', env: oidcEnv });
      assert.equal(args[args.indexOf('--manager-auth') + 1], 'oidc');
      assert.equal(args.includes('--id-token-audience'), Boolean(audience));
      if (audience) assert.equal(args[args.indexOf('--id-token-audience') + 1], audience);
      assert.equal(args.includes('--manager-token-file'), false);
      assert.equal(args.includes('/must-not-use'), false);
      assert.equal(args.join(' ').includes(requestToken), false);
      assert.equal(args.join(' ').includes(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL), false);
    });
  }
  it('preserves the legacy flags for old pinned Agents', () => {
    const args = renderProjectStartArgs({ managerUrl: valid.managerUrl, managerTokenFile: '/token', socketPath: '/test.sock' });
    assert.deepEqual(args.slice(-4), ['--manager-url', valid.managerUrl, '--manager-token-file', '/token']);
    assert.equal(args.includes('--manager-auth'), false);
  });
});

// Exercise main + post through their existing process/filesystem boundaries.
// No network, sudo, systemd, or artifact upload is performed by these tests.
let oldEnv, oldExitCode, tmp, output, calls, writes, fetches;
beforeEach(() => {
  oldEnv = { ...process.env };
  oldExitCode = process.exitCode;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-oidc-'));
  process.env = { ...oldEnv, ...oidcEnv,
    RUNNER_TEMP: tmp, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'test/repo', GITHUB_SHA: 'test-sha',
    GITHUB_STATE: path.join(tmp, 'state'), GITHUB_OUTPUT: path.join(tmp, 'output'),
    'INPUT_GITHUB-TOKEN': 'test-only-github-secret', 'INPUT_SOCKET-PATH': '/test.sock',
    'INPUT_CICD-SENSOR-VERSION': 'v0.0.49', 'INPUT_MANAGER-AUTH': 'oidc',
    'INPUT_MANAGER-URL': valid.managerUrl, 'INPUT_MANAGER-TOKEN': '', 'INPUT_ID-TOKEN-AUDIENCE': '',
    'INPUT_ENABLE-HTML-REPORT': 'false', 'INPUT_ENABLE-ATTESTATION-ARTIFACT': 'false', 'INPUT_ENABLE-DEBUG': 'false',
  };
  for (const key of Object.keys(process.env)) if (key.startsWith('STATE_')) delete process.env[key];
  fs.writeFileSync(process.env.GITHUB_STATE, '');
  fs.writeFileSync(process.env.GITHUB_OUTPUT, '');
  output = []; calls = []; writes = []; fetches = [];
  mock.method(process.stdout, 'write', (data) => { output.push(String(data)); return true; });
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  process.env = oldEnv;
  process.exitCode = oldExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function boundaries({ reuse = false, version = 'v0.0.49', versionStatus = 0, startFails = false, launchFails = false, reportFails = false } = {}) {
  let launched = reuse, stopped = false;
  const stat = fs.statSync.bind(fs), exists = fs.existsSync.bind(fs), read = fs.readFileSync.bind(fs), write = fs.writeFileSync.bind(fs);
  mock.method(fs, 'statSync', (file, ...args) => file === '/test.sock' ? { isSocket: () => launched } : stat(file, ...args));
  mock.method(fs, 'existsSync', (file) => ['/run/docker.sock', '/run/docker-upstream.sock'].includes(file) ? false : exists(file));
  mock.method(fs, 'readFileSync', (file, ...args) => file === '/sys/kernel/security/lsm' ? '' : read(file, ...args));
  mock.method(fs, 'writeFileSync', (file, data, ...args) => { writes.push([file, String(data)]); return write(file, data, ...args); });
  mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); return { status: 404 }; });
  mock.method(childProcess, 'spawnSync', (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '--version') return { status: versionStatus, stdout: version + '\n' };
    if (cmd === 'tar') {
      for (const name of ['cicd-sensor', 'cicd-sensorctl']) {
        write(path.join(args.at(-1), `${name}-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`), 'fake binary');
      }
    } else if (cmd === 'sudo' && args[0] === 'systemd-run') {
      launched = !launchFails;
      if (launchFails) return { status: 1 };
    } else if (args[0] === 'project' && args[1] === 'start' && startFails) {
      return { status: 1 };
    } else if (args[0] === 'project' && args[1] === 'result') {
      if (reportFails) throw new Error('result failed');
      write(args.at(-1), '{}');
    } else if (cmd === 'sudo' && args.includes('--signal=SIGTERM')) {
      stopped = true;
    } else if (cmd === 'systemctl') {
      return { status: 0, stdout: args[0] === 'show' ? 'MainPID=1\nActiveState=active\n' : stopped ? 'inactive' : 'active' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
}

function restoreStateForPost() {
  const state = fs.readFileSync(process.env.GITHUB_STATE, 'utf8');
  const entries = [...state.matchAll(/([^\n]+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)];
  for (const [, key, , value] of entries) process.env[`STATE_${key}`] = value;
  return state;
}
function assertNoSecrets(state) {
  // add-mask is the runner's secret-registration protocol, not a log entry.
  const logs = output.filter((line) => !line.startsWith('::add-mask::')).join('');
  const publicData = JSON.stringify({ state, logs, writes: writes.filter(([file]) => !file.endsWith('.token')), commands: calls.map(({ cmd, args }) => ({ cmd, args })) });
  for (const secret of [requestToken, managerToken, 'test-only-github-secret']) assert.equal(publicData.includes(secret), false);
  assert.equal(output.some((line) => line.includes(`::add-mask::${requestToken}`)), Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
}

describe('main/post integration', () => {
  for (const reuse of [false, true]) {
    for (const mode of ['oidc', 'manager-token', 'none']) {
      for (const audience of mode === 'oidc' ? ['', 'urn:example:manager'] : ['']) {
        it(`${reuse ? 'reused' : 'managed'} ${mode} ${audience || 'default audience'}`, async () => {
          process.env.RUNNER_ENVIRONMENT = reuse ? 'self-hosted' : 'github-hosted';
          process.env['INPUT_MANAGER-AUTH'] = mode === 'oidc' ? mode : 'manager-token';
          process.env['INPUT_MANAGER-TOKEN'] = mode === 'manager-token' ? managerToken : '';
          process.env['INPUT_MANAGER-URL'] = mode === 'none' ? '' : valid.managerUrl;
          process.env['INPUT_ID-TOKEN-AUDIENCE'] = audience;
          if (mode !== 'oidc') {
            process.env['INPUT_CICD-SENSOR-VERSION'] = 'v0.0.48';
            delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
            delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
          }
          boundaries({ reuse });
          await main();
          const state = restoreStateForPost();
          const start = calls.find(({ args }) => args[0] === 'project' && args[1] === 'start');
          assert.equal(start.cmd, '/usr/local/bin/cicd-sensor');
          assert.equal(start.args.includes('--manager-auth'), mode === 'oidc');
          assert.equal(start.args.includes('--manager-url'), mode !== 'none');
          assert.equal(start.args.includes('--manager-token-file'), mode === 'manager-token');
          assert.equal(start.args.includes('--id-token-audience'), Boolean(audience));
          if (mode === 'oidc') {
            assert.equal(start.opts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, requestToken);
            assert.equal(start.opts.env.ACTIONS_ID_TOKEN_REQUEST_URL, oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL);
          }
          assert.equal(fetches.length > 0, mode === 'none');
          const tokenPath = path.join(tmp, 'cicd-sensor-manager.token');
          assert.equal(fs.existsSync(tokenPath), mode === 'manager-token');
          if (mode === 'manager-token') {
            assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
            assert.equal(fs.readFileSync(tokenPath, 'utf8'), managerToken);
          } else assert.equal(writes.some(([file]) => file.endsWith('.token')), false);
          assert.equal(process.env.STATE_managedAgentStarted, reuse ? undefined : 'true');
          assert.equal(process.env.STATE_reusedExistingAgent, String(reuse));
          assert.equal(calls.some(({ args }) => args[0] === '--version'), reuse && mode === 'oidc');
          if (reuse) assert.equal(calls.some(({ cmd }) => cmd === 'sudo'), false);
          await runPost();
          const resultIndex = calls.findIndex(({ args }) => args[0] === 'project' && args[1] === 'result');
          const stopIndex = calls.findIndex(({ args }) => args.includes('--signal=SIGTERM'));
          assert.ok(resultIndex > 0);
          if (reuse) assert.equal(stopIndex, -1);
          else assert.ok(stopIndex > resultIndex);
          assert.equal(fs.existsSync(tokenPath), false);
          assert.equal(process.exitCode, oldExitCode);
          assertNoSecrets(state);
        });
      }
    }
  }

  for (const [name, inputs, env, error] of [
    ['invalid URL', { 'manager-url': 'not-a-url' }, {}, /valid URL/],
    ['missing URL', { 'manager-url': '' }, {}, /requires manager-url/],
    ['mixed token', { 'manager-token': managerToken }, {}, /cannot be combined/],
    ['unknown mode', { 'manager-auth': requestToken }, {}, /manager-auth must/],
    ['audience in token mode', { 'manager-auth': 'manager-token', 'manager-token': managerToken, 'id-token-audience': 'a' }, {}, /audience requires/],
    ['no runner URL', {}, { ACTIONS_ID_TOKEN_REQUEST_URL: '' }, /permissions: id-token: write/],
    ['no runner token', {}, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, /permissions: id-token: write/],
    ['old selected release', { 'cicd-sensor-version': 'v0.0.48' }, {}, /v0.0.49 or newer/],
  ]) {
    it(`rejects ${name} before side effects, then post is harmless`, async () => {
      for (const [key, value] of Object.entries(inputs)) process.env[`INPUT_${key.toUpperCase()}`] = value;
      Object.assign(process.env, env);
      boundaries();
      await assert.rejects(main(), error);
      restoreStateForPost();
      await runPost();
      assert.equal(calls.length, 0);
      assert.equal(writes.length, 0);
      assert.equal(fs.readFileSync(process.env.GITHUB_STATE, 'utf8'), '');
    });
  }

  for (const options of [{ version: 'v0.0.48' }, { version: 'dev' }, { versionStatus: 1 }]) {
    it(`rejects unsupported installed CLI ${JSON.stringify(options)}`, async () => {
      process.env.RUNNER_ENVIRONMENT = 'self-hosted';
      boundaries({ reuse: true, ...options });
      await assert.rejects(main(), /installed cicd-sensor CLI v0.0.49 or newer/);
      restoreStateForPost();
      await runPost();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ['--version']);
      assert.equal(writes.length, 0);
    });
  }

  for (const reuse of [false, true]) {
    for (const failure of ['start', 'report']) {
      it(`${reuse ? 'reused' : 'managed'} ${failure} failure preserves cleanup ownership`, async () => {
        process.env.RUNNER_ENVIRONMENT = reuse ? 'self-hosted' : 'github-hosted';
        boundaries({ reuse, startFails: failure === 'start', reportFails: failure === 'report' });
        if (failure === 'start') {
          await assert.rejects(main(), reuse ? /running Agent.*restarted after upgrade/ : /exited with status/);
          assert.equal(output.some((line) => line.includes('main: ready')), false);
        } else await main();
        const state = restoreStateForPost();
        await runPost();
        assert.equal(calls.filter(({ args }) => args.includes('--signal=SIGTERM')).length, reuse ? 0 : 1);
        assert.equal(writes.some(([file]) => file.endsWith('.token')), false);
        assertNoSecrets(state);
        if (failure === 'report') assert.equal(process.exitCode, 1);
      });
    }
  }
  it('failed managed launch is never stopped in post', async () => {
    boundaries({ launchFails: true });
    await assert.rejects(main(), /exited with status/);
    restoreStateForPost();
    await runPost();
    assert.equal(process.env.STATE_managedAgentStarted, undefined);
    assert.equal(calls.some(({ args }) => args.includes('--signal=SIGTERM')), false);
  });
});
