import process from 'node:process';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM still means the process exists. Any other uncertainty is treated
    // as alive so the caller will not start TSC over an unverified gate.
    return true;
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

async function waitUntilStopped(pid, pgid, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(-pgid) || processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/**
 * Wait for one isolated gate process group to exit. If it does not exit in
 * time, terminate the whole group and confirm both the group and its launcher
 * have disappeared before allowing the caller to continue to TSC.
 *
 * @param {{
 *   pid: number;
 *   pgid: number;
 *   protectedPgid: number;
 *   initialWaitMs?: number;
 *   termGraceMs?: number;
 *   killWaitMs?: number;
 *   pollIntervalMs?: number;
 * }} options
 * @returns {Promise<
 *   | { action: 'natural'; stopped: true }
 *   | { action: 'terminated'; stopped: true; signal: 'SIGTERM' | 'SIGKILL' }
 *   | { action: 'unsafe'; stopped: false; reason: string }
 * >}
 */
export async function waitForDetachedGate({
  pid,
  pgid,
  protectedPgid,
  initialWaitMs = 5_000,
  termGraceMs = 5_000,
  killWaitMs = 10_000,
  pollIntervalMs = 100,
}) {
  for (const [name, value] of Object.entries({ pid, pgid, protectedPgid })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { action: 'unsafe', stopped: false, reason: `${name} must be a positive integer` };
    }
  }
  for (const [name, value] of Object.entries({ initialWaitMs, termGraceMs, killWaitMs, pollIntervalMs })) {
    if (!Number.isFinite(value) || value < 0) {
      return { action: 'unsafe', stopped: false, reason: `${name} must be non-negative` };
    }
  }
  if (pgid === protectedPgid) {
    return { action: 'unsafe', stopped: false, reason: 'refusing to signal the collector process group' };
  }

  if (await waitUntilStopped(pid, pgid, initialWaitMs, pollIntervalMs)) {
    return { action: 'natural', stopped: true };
  }

  if (!signalGroup(pgid, 'SIGTERM')) {
    return { action: 'unsafe', stopped: false, reason: 'could not signal the detached gate process group with SIGTERM' };
  }
  if (await waitUntilStopped(pid, pgid, termGraceMs, pollIntervalMs)) {
    return { action: 'terminated', stopped: true, signal: 'SIGTERM' };
  }

  if (!signalGroup(pgid, 'SIGKILL')) {
    return { action: 'unsafe', stopped: false, reason: 'could not signal the detached gate process group with SIGKILL' };
  }
  if (await waitUntilStopped(pid, pgid, killWaitMs, pollIntervalMs)) {
    return { action: 'terminated', stopped: true, signal: 'SIGKILL' };
  }
  return { action: 'unsafe', stopped: false, reason: 'detached gate process group or launcher is still alive after SIGKILL' };
}

async function main() {
  const [pidRaw, pgidRaw, protectedPgidRaw, mode = 'wait'] = process.argv.slice(2);
  const pid = Number(pidRaw);
  const pgid = Number(pgidRaw);
  const protectedPgid = Number(protectedPgidRaw);
  if (![pid, pgid, protectedPgid].every(Number.isSafeInteger) || !['wait', 'terminate-now'].includes(mode)) {
    console.error('Usage: node wait-for-detached-gate.mjs <pid> <pgid> <protected-pgid> [wait|terminate-now]');
    process.exitCode = 64;
    return;
  }

  const result = await waitForDetachedGate({
    pid,
    pgid,
    protectedPgid,
    initialWaitMs: mode === 'terminate-now' ? 0 : 5_000,
  });
  if (result.stopped) {
    if (result.action === 'natural') {
      console.log(`[detached-gate] process group ${pgid} exited`);
      return;
    }
    console.log(`[detached-gate] process group ${pgid} stopped with ${result.signal}`);
    process.exitCode = 2;
    return;
  }
  console.error(`[detached-gate] ${result.reason}`);
  process.exitCode = 1;
}

if (isInvokedDirectly(import.meta.url)) {
  await main();
}
