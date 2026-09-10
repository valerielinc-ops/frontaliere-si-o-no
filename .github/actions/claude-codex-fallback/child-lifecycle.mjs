export const FORCE_KILL_GRACE_MS = 2_000;
export const POSIX_PROCESS_GROUPS = process.platform !== 'win32';

export function isChildRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** Spawn a child in its own process group where POSIX supports it. */
export function childSpawnOptions({ processGroup = false } = {}) {
  return processGroup && POSIX_PROCESS_GROUPS ? { detached: true } : {};
}

/** Send a signal to a child or, on POSIX, to its dedicated process group. */
export function signalChild(child, signal, { processGroup = false, allowExited = false } = {}) {
  if (!child) return false;
  const pid = Number(child.pid);
  if (processGroup && POSIX_PROCESS_GROUPS && Number.isInteger(pid) && pid > 1
    && (allowExited || isChildRunning(child))) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // ESRCH means the group already disappeared. For other failures, fall
      // back to the direct child so Windows/permission edge cases stay safe.
      if (error?.code === 'ESRCH') return false;
    }
  }
  if (!isChildRunning(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** Force a child/group down, including a group whose leader already exited. */
export function forceChildTermination(child, { processGroup = false } = {}) {
  return signalChild(child, 'SIGKILL', { processGroup, allowExited: processGroup });
}

/** Ask a child/group to stop, then force it after grace if it remains. */
export function requestChildTermination(child, {
  graceMs = FORCE_KILL_GRACE_MS,
  processGroup = false,
  onComplete,
} = {}) {
  const groupLeader = processGroup && POSIX_PROCESS_GROUPS && Number.isInteger(Number(child?.pid))
    && Number(child.pid) > 1;
  if (!isChildRunning(child) && !groupLeader) return null;
  const signaled = signalChild(child, 'SIGTERM', { processGroup, allowExited: groupLeader });
  // If a POSIX group no longer exists, there is no descendant left to reap.
  // Avoid retaining a pending cleanup timer in that common successful-exit
  // case. Non-group callers retain the historical grace/force behavior.
  if (processGroup && !signaled) {
    onComplete?.();
    return null;
  }
  const timer = setTimeout(() => {
    forceChildTermination(child, { processGroup });
    onComplete?.();
  }, graceMs);
  timer.unref?.();
  return timer;
}
