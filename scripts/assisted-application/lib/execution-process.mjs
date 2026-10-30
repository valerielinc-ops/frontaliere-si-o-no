/** Reap the whole detached browser group before releasing its private job or slot. */
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid < 2) return;
  try { process.kill(-pid, signal); } catch { /* The bounded liveness check fails closed if signalling failed. */ }
}
async function reapGroup(pid) {
  if (!processGroupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  for (let count = 0; count < 30 && processGroupAlive(pid); count++) await wait(100);
  if (processGroupAlive(pid)) signalGroup(pid, 'SIGKILL');
  for (let count = 0; count < 20 && processGroupAlive(pid); count++) await wait(100);
  if (processGroupAlive(pid)) {
    const error = new Error('remote_executor_descendants_active'); error.processGroupUnreaped = true; throw error;
  }
}
export async function waitForDetachedChild(child, timeoutMs) {
  let timedOut = false; let force; let abandoned; let timer;
  let result;
  try {
    result = await new Promise(resolve => {
      child.once('error', () => resolve({ failed: true }));
      child.once('exit', code => resolve({ failed: code !== 0 }));
      if (child.exitCode !== null || child.signalCode) resolve({ failed: child.exitCode !== 0 });
      timer = setTimeout(() => {
        timedOut = true; signalGroup(child.pid, 'SIGTERM');
        // A leader exiting after TERM must not cancel escalation for its children.
        force = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 3000);
        abandoned = setTimeout(() => resolve({ failed: true }), 5000);
      }, timeoutMs);
    });
    await reapGroup(child.pid);
  } finally { clearTimeout(timer); clearTimeout(force); clearTimeout(abandoned); }
  if (timedOut || result?.failed) throw new Error(timedOut ? 'remote_executor_timeout' : 'remote_executor_runtime_failed');
}
