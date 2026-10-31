/** Reap the whole detached browser group before releasing its private job or slot. */
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../../lib/is-invoked-directly.mjs';
import { inspectProcess, requestProcessRegistration } from './process-registry.mjs';
import { proveLeaderlessBrowserGroup } from './browser-ownership.mjs';
export { registerDetachedProcessGroup } from './process-registry.mjs';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const unreapedError = () => Object.assign(new Error('remote_executor_descendants_active'), { processGroupUnreaped: true });

export function createProcessGroupRegistry(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'registration-open'), '', { mode: 0o400, flag: 'wx' });
}
export async function reapRegisteredProcessGroups(directory) {
  if (!fs.existsSync(directory)) return;
  fs.rmSync(path.join(directory, 'registration-open'), { force: true });
  let names = fs.readdirSync(directory);
  // A wrapper may be between write and rename when the gate closes. Give
  // that synchronous registration a bounded chance to finish and abort exec.
  for (let count = 0; count < 10 && names.some(name => /^[1-9]\d*\.pending$/.test(name)); count++) {
    await wait(50); names = fs.readdirSync(directory);
  }
  for (const name of names) {
    const match = /^([1-9]\d*)\.(json|pending)$/.exec(name);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid < 2 || pid > 2147483647) throw unreapedError();
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 2048) throw unreapedError();
    if (match[2] === 'pending' && !processGroupAlive(pid)) { fs.rmSync(file); continue; }
    let marker;
    try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw unreapedError(); }
    if (marker.pid !== pid || !marker.started || typeof marker.started !== 'string') throw unreapedError();
    if (!processGroupAlive(marker.pid)) continue;
    const current = inspectProcess(marker.pid);
    if (current ? current.started !== marker.started || current.uid !== process.getuid() || current.pgid !== marker.pid
      : !proveLeaderlessBrowserGroup(directory, marker.pid)) throw unreapedError();
    await reapGroup(marker.pid);
    if (match[2] === 'pending') fs.rmSync(file);
  }
}
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
    throw unreapedError();
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

if (isInvokedDirectly(import.meta.url)) {
  if (process.argv[2] !== '--register') throw new Error('remote_browser_registration_arguments');
  const result = await requestProcessRegistration({ socket: process.argv[3], pid: Number(process.argv[4]), role: 'browser', nonce: process.argv[5] });
  if (!/^[a-f0-9]{64}$/.test(result?.witness || '')) throw new Error('remote_browser_witness_missing');
  process.stdout.write(result.witness);
}
