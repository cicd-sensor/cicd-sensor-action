// Only the invocation started by this action belongs to its post step.
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as core from '@actions/core';

export const AGENT_UNIT_NAME = 'cicd-sensor-agent.service';
export const OWNED_INVOCATION_STATE = 'managedAgentInvocationID';
const SHUTDOWN_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5_000;

export function readAgentState(timeout = COMMAND_TIMEOUT_MS) {
  const r = spawnSync('systemctl', [
    'show', AGENT_UNIT_NAME,
    '--property=LoadState,ActiveState,InvocationID,Transient,Restart,Result',
  ], { encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  const state = Object.fromEntries((r.stdout || '').trim().split('\n')
    .filter((line) => line.includes('='))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  // --collect removes inactive transient units. systemctl may return nonzero
  // for a missing unit, but transport/query errors must not imply exit.
  if (state.LoadState === 'not-found') return state;
  if (r.status !== 0 || !state.ActiveState) {
    throw new Error(`cannot inspect ${AGENT_UNIT_NAME}: ${r.stderr || r.stdout || r.status}`);
  }
  return state;
}

export function rememberManagedAgent({ read = readAgentState, save = core.saveState } = {}) {
  const state = read();
  if (!state.InvocationID || state.Transient !== 'yes' || state.Restart !== 'no') {
    throw new Error('cannot establish ownership of the managed agent invocation');
  }
  save(OWNED_INVOCATION_STATE, state.InvocationID);
}

function signalAgent(timeout) {
  // RefuseManualStop=yes deliberately prevents `systemctl stop`. SIGTERM
  // enters the Agent's existing finalize/drain path without weakening it.
  const r = spawnSync('sudo', [
    '-n', 'systemctl', 'kill', '--kill-who=main', '--signal=SIGTERM', AGENT_UNIT_NAME,
  ], { encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`agent SIGTERM failed: ${r.stderr || r.stdout || r.status}`);
}

export async function stopManagedAgent(invocationID, {
  read = readAgentState, signal = signalAgent, wait = sleep, now = Date.now,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
} = {}) {
  if (!invocationID) return; // Reused Agent, skipped main, or never launched.
  const deadline = now() + timeoutMs;
  let signalled = false;
  while (now() < deadline) {
    const state = read(Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - now())));
    if (state.LoadState === 'not-found') return;
    if (state.InvocationID && state.InvocationID !== invocationID) {
      throw new Error('managed agent invocation changed; refusing to signal a replacement');
    }
    if (state.ActiveState === 'failed' || (state.Result && state.Result !== 'success')) {
      throw new Error(`managed agent exited unsuccessfully: ${state.Result || state.ActiveState}`);
    }
    if (state.ActiveState === 'inactive') return;
    if (state.InvocationID !== invocationID || state.Transient !== 'yes' || state.Restart !== 'no') {
      throw new Error('managed agent ownership or service policy changed; refusing to signal');
    }
    if (!signalled) {
      signal(Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - now())));
      signalled = true;
    }
    await wait(Math.min(200, Math.max(0, deadline - now())));
  }
  throw new Error(`managed agent did not exit within ${timeoutMs}ms after SIGTERM; logs may be incomplete`);
}
