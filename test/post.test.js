import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runtimeTelemetryDebugSourcePath,
  stageRuntimeTelemetryDebugFile,
  stepSummaryArgs,
} from '../src/post.js';

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

describe('runtime telemetry debug staging', () => {
  it('uses the fixed GitHub Actions debug output path', () => {
    assert.equal(
      runtimeTelemetryDebugSourcePath(),
      '/home/runner/work/_temp/cicd_sensor_debug/job_runtime_telemetry_log.json.gz',
    );
  });

  it('stages root-owned telemetry into the artifact output directory', () => {
    const calls = [];
    const fakeRun = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    };

    assert.equal(
      stageRuntimeTelemetryDebugFile('/tmp/cicd-sensor-output', '/fixed/job_runtime_telemetry_log.json.gz', fakeRun),
      '/tmp/cicd-sensor-output/job_runtime_telemetry_log.json.gz',
    );
    assert.deepEqual(calls, [
      {
        cmd: 'sudo',
        args: ['test', '-s', '/fixed/job_runtime_telemetry_log.json.gz'],
        opts: { stdio: 'ignore' },
      },
      {
        cmd: 'sudo',
        args: [
          'install',
          '-m',
          '644',
          '/fixed/job_runtime_telemetry_log.json.gz',
          '/tmp/cicd-sensor-output/job_runtime_telemetry_log.json.gz',
        ],
        opts: { encoding: 'utf8' },
      },
    ]);
  });

  it('skips staging when telemetry is absent', () => {
    const calls = [];
    const fakeRun = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 1 };
    };

    assert.equal(
      stageRuntimeTelemetryDebugFile('/tmp/cicd-sensor-output', '/fixed/job_runtime_telemetry_log.json.gz', fakeRun),
      '',
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['test', '-s', '/fixed/job_runtime_telemetry_log.json.gz']);
  });
});
