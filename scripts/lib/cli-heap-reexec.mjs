/**
 * Relaunch a CLI entry point once with a larger V8 old space (#9608).
 *
 * `assemble-jobs-dataset.mjs` outgrew Node's default heap (~4 GB on a 16 GB
 * runner) and dozens of workflow steps invoke it without NODE_OPTIONS. The
 * floor lives with the script so every caller gets it.
 *
 * Only an entry point may call this: an importer must never be relaunched.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import v8 from 'node:v8';

export const HEAP_REEXEC_TARGET_MB = 8192;
/** Share of physical (or cgroup) memory the old space may claim. */
const MAX_RAM_SHARE = 0.75;
/** A relaunch that gains less than this is not worth a second process. */
const MIN_GAIN_MB = 512;
const MB = 1024 * 1024;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const HEAP_FLAG_RX = /^--max[-_]old[-_]space[-_]size(=|$)/;

/** Physical memory, reduced to the cgroup limit when a container imposes one. */
export function availableMemoryBytes({
  totalBytes = os.totalmem(),
  constrainedBytes = process.constrainedMemory?.() ?? 0,
} = {}) {
  return constrainedBytes > 0 ? Math.min(totalBytes, constrainedBytes) : totalBytes;
}

/**
 * @returns {number|null} old-space size (MB) to relaunch with, or null to keep
 * running in this process (limit already adequate, or RAM cannot offer more).
 */
export function planHeapReexec({
  heapLimitBytes = v8.getHeapStatistics().heap_size_limit,
  memoryBytes = availableMemoryBytes(),
  targetMb = HEAP_REEXEC_TARGET_MB,
} = {}) {
  const affordableMb = Math.min(targetMb, Math.floor((memoryBytes / MB) * MAX_RAM_SHARE));
  return affordableMb - heapLimitBytes / MB >= MIN_GAIN_MB ? affordableMb : null;
}

/**
 * Command-line flags win over NODE_OPTIONS, so NODE_OPTIONS is inherited as is
 * and only a heap flag already present in execArgv has to be replaced.
 */
export function buildReexecArgs({ execArgv, scriptPath, args, heapMb }) {
  const kept = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const match = HEAP_FLAG_RX.exec(execArgv[i]);
    if (!match) kept.push(execArgv[i]);
    else if (match[1] !== '=') i += 1; // space-separated form: drop the value too
  }
  return [...kept, `--max-old-space-size=${heapMb}`, scriptPath, ...args];
}

/**
 * If this process has too little heap, run the same command in a child with
 * more, then end this process the way the child ended (exit code or signal).
 *
 * @param {object} options
 * @param {string} options.guardEnvVar marker set on the child only; it makes a
 *   second relaunch impossible and is removed there, so that processes the
 *   child spawns decide for themselves.
 * @returns {boolean} true when a child was started: the caller must not do the
 *   work itself.
 */
export function reexecWithLargerHeap({ guardEnvVar }) {
  if (process.env[guardEnvVar]) {
    delete process.env[guardEnvVar];
    return false;
  }
  const heapMb = planHeapReexec();
  if (heapMb === null) return false;

  const currentMb = Math.round(v8.getHeapStatistics().heap_size_limit / MB);
  console.error(`🧠 Heap limit ${currentMb} MB: relaunching once with --max-old-space-size=${heapMb}`);

  const child = spawn(
    process.execPath,
    buildReexecArgs({
      execArgv: process.execArgv,
      scriptPath: process.argv[1],
      args: process.argv.slice(2),
      heapMb,
    }),
    { stdio: 'inherit', env: { ...process.env, [guardEnvVar]: '1' } },
  );

  const forwarders = FORWARDED_SIGNALS.map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward];
  });
  const stopForwarding = () => {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  };

  child.on('error', (err) => {
    stopForwarding();
    console.error(`❌ Heap relaunch failed: ${err?.message || err}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    stopForwarding();
    if (!signal) process.exit(code ?? 1);
    // Die by the same signal so the caller sees it (an OOM abort stays 134).
    // The timer is the fallback for a signal that does not terminate Node.
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 1000);
  });
  return true;
}
