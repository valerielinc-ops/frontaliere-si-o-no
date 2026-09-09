export const FORCE_KILL_GRACE_MS = 2_000;

export function isChildRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** Ask a child to stop, then force it only if it remains alive after grace. */
export function requestChildTermination(child, { graceMs = FORCE_KILL_GRACE_MS } = {}) {
  if (!isChildRunning(child)) return null;
  child.kill('SIGTERM');
  return setTimeout(() => {
    if (isChildRunning(child)) child.kill('SIGKILL');
  }, graceMs);
}
