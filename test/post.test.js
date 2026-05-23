import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stepSummaryArgs } from '../src/post.js';

let oldEnv;

beforeEach(() => {
  oldEnv = { ...process.env };
  process.env.GITHUB_SERVER_URL = 'https://github.com';
  process.env.GITHUB_REPOSITORY = 'octo/repo';
  process.env.GITHUB_RUN_ID = '123456';
});

afterEach(() => {
  process.env = oldEnv;
});

describe('step summary command', () => {
  it('passes only the trusted HTML artifact URL for normal summaries', () => {
    assert.deepEqual(
      stepSummaryArgs({ htmlArtifactId: 987 }),
      [
        'report',
        'stepsummary',
        '--html-url',
        'https://github.com/octo/repo/actions/runs/123456/artifacts/987',
      ],
    );
  });

  it('passes health failure and debug artifact URL for failure summaries', () => {
    assert.deepEqual(
      stepSummaryArgs({ debugArtifactId: 654, healthFailed: true }),
      [
        'report',
        'stepsummary',
        '--debug-url',
        'https://github.com/octo/repo/actions/runs/123456/artifacts/654',
        '--health-failed',
      ],
    );
  });

  it('does not include output file or asset base flags', () => {
    const args = stepSummaryArgs({ htmlArtifactId: 987, debugArtifactId: 654, healthFailed: true });
    assert.equal(args.includes('--output-file'), false);
    assert.equal(args.includes('--asset-base-url'), false);
  });
});

describe('debug runtime telemetry artifact ordering', () => {
  it('moves runtime telemetry only after project result has returned', () => {
    const source = fs.readFileSync(new URL('../src/post.js', import.meta.url), 'utf8');
    const mainSource = source.slice(source.indexOf('async function main()'));
    const resultIndex = mainSource.indexOf('const resultOk = finishProjectAndEmitResultLog(socket, resultLogPath);');
    const moveIndex = mainSource.indexOf('fs.renameSync(DEBUG_RUNTIME_TELEMETRY_PATH, runtimeTelemetryPath)');
    assert.notEqual(resultIndex, -1);
    assert.notEqual(moveIndex, -1);
    assert.ok(resultIndex < moveIndex);

    const runtimeTelemetryPathIndex = mainSource.indexOf('const runtimeTelemetryPath =');
    const beforeResult = mainSource.slice(runtimeTelemetryPathIndex, resultIndex);
    assert.equal(/fs\.(copyFileSync|renameSync)\(DEBUG_RUNTIME_TELEMETRY_PATH/.test(beforeResult), false);
  });
});
