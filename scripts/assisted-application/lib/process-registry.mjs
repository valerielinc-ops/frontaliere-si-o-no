/** Per-job process metadata authority. Only the unsandboxed trusted manager runs ps. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

const validPid = pid => Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647;
export function inspectProcess(pid, { timeoutMs = 1000 } = {}) {
  if (!validPid(pid)) throw new Error('process_registry_pid_invalid');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) throw new Error('process_registry_metadata_unknown');
  try {
    const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2048, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(value);
    if (!match) throw new Error('process_registry_metadata_unknown');
    return { pid, uid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] };
  } catch {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
    throw new Error('process_registry_metadata_unknown');
  }
}

export function registerDetachedProcessGroup(directory, pid, { expectedStarted = null } = {}) {
  const identity = inspectProcess(pid);
  if (!identity || identity.uid !== process.getuid() || identity.pgid !== pid
    || (expectedStarted && identity.started !== expectedStarted)) throw new Error('remote_browser_group_invalid');
  const pending = path.join(directory, `${pid}.pending`);
  fs.writeFileSync(pending, JSON.stringify({ pid, started: identity.started }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(pending, path.join(directory, `${pid}.json`));
  if (!fs.existsSync(path.join(directory, 'registration-open'))) throw new Error('remote_browser_registration_closed');
}

export async function createProcessRegistry({ jobRoot, authorizeBrowser, browserBundle = null }) {
  if (typeof authorizeBrowser !== 'function') throw new Error('process_registry_authority_missing');
  const directory = path.join(jobRoot, 'process-groups'); fs.mkdirSync(directory, { mode: 0o700 });
  const witness = randomBytes(32).toString('hex');
  if (browserBundle) {
    const bundle = fs.realpathSync(browserBundle);
    if (!bundle.endsWith('.app')) throw new Error('process_registry_browser_bundle_invalid');
    fs.writeFileSync(path.join(jobRoot, 'browser-ownership.json'), JSON.stringify({ version: 1, bundle, witness }), { mode: 0o600, flag: 'wx' });
  }
  fs.writeFileSync(path.join(directory, 'registration-open'), '', { mode: 0o400, flag: 'wx' });
  const socketRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aa-registry-')); fs.chmodSync(socketRoot, 0o700);
  const manager = inspectProcess(process.pid);
  if (!manager) throw new Error('process_registry_manager_unknown');
  fs.writeFileSync(path.join(jobRoot, 'process-registry.json'), JSON.stringify({ socketRoot, managerPid: manager.pid,
    managerStarted: manager.started }), { mode: 0o600, flag: 'wx' });
  const socketPath = path.join(socketRoot, 'ipc'); const nonce = randomUUID(); const clients = new Set(); const pending = new Set();
  let closed = false; let requests = 0; let agentGroup = null; let agent = null;
  const validNonce = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(nonce)
    && timingSafeEqual(Buffer.from(value), Buffer.from(nonce));
  const registration = async message => {
    if (closed || !agentGroup || Object.keys(message).sort().join(',') !== 'nonce,pid,role'
      || !validNonce(message.nonce) || !validPid(message.pid) || !['agent', 'browser'].includes(message.role)) throw new Error('process_registry_denied');
    const current = inspectProcess(message.pid);
    if (!current || current.uid !== process.getuid()) throw new Error('process_registry_denied');
    if (message.role === 'agent') {
      if (current.pgid !== agentGroup.pid || (agent && (agent.pid !== current.pid || agent.started !== current.started))) throw new Error('process_registry_denied');
      const group = inspectProcess(agentGroup.pid);
      if (group && group.started !== agentGroup.started) throw new Error('process_registry_denied');
      agent = current;
      fs.writeFileSync(path.join(jobRoot, 'process.json'), JSON.stringify({ state: 'running', pid: current.pid,
        pgid: current.pgid, started: current.started }), { mode: 0o600 });
    } else {
      if (!agent || current.pgid !== current.pid || current.pid === agent.pid || current.pgid === agentGroup.pid) throw new Error('process_registry_denied');
      let ancestor = current; let found = false; const deadline = Date.now() + 4000;
      for (let count = 0; count < 16 && Date.now() < deadline; count++) {
        if (ancestor.pid === agent.pid) { found = ancestor.started === agent.started; break; }
        if (!validPid(ancestor.ppid)) break;
        ancestor = inspectProcess(ancestor.ppid); if (!ancestor || ancestor.uid !== process.getuid()) break;
      }
      if (!found) throw new Error('process_registry_denied');
      let authorityTimer;
      try {
        const permitted = await Promise.race([Promise.resolve().then(authorizeBrowser), new Promise((_, reject) => {
          authorityTimer = setTimeout(() => reject(new Error('process_registry_authority_timeout')), 5000);
        })]);
        if (!permitted) throw new Error('process_registry_denied');
      } finally { clearTimeout(authorityTimer); }
      if (closed) throw new Error('process_registry_closed');
      const activeAgent = inspectProcess(agent.pid); const activeBrowser = inspectProcess(current.pid);
      if (!activeAgent || activeAgent.started !== agent.started || !activeBrowser
        || activeBrowser.started !== current.started || activeBrowser.ppid !== current.ppid) throw new Error('process_registry_denied');
      registerDetachedProcessGroup(directory, current.pid, { expectedStarted: current.started });
    }
    if (closed) throw new Error('process_registry_closed');
    return message.role === 'browser' ? { witness } : {};
  };
  const server = net.createServer(client => {
    if (closed || clients.size >= 8 || ++requests > 64) { client.destroy(); return; }
    clients.add(client); client.setTimeout(5000, () => client.destroy()); let input = ''; let handled = false;
    client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('data', chunk => {
      input += chunk.toString('utf8'); if (Buffer.byteLength(input) > 2048) { client.destroy(); return; }
      if (handled || !input.includes('\n')) return; handled = true;
      let message; try { message = JSON.parse(input.trim()); } catch { client.destroy(); return; }
      const task = registration(message).then(result => { if (!closed) client.end(`${JSON.stringify({ ok: true, ...result })}\n`); else client.destroy(); },
        () => client.end('{"ok":false}\n')).finally(() => pending.delete(task));
      pending.add(task);
    });
  });
  try { server.listen(socketPath); await once(server, 'listening'); fs.chmodSync(socketPath, 0o600); }
  catch (error) { server.close(); fs.rmSync(socketRoot, { recursive: true, force: true }); throw error; }
  return { socket: socketPath, nonce,
    bindAgentGroup(pid) {
      const identity = inspectProcess(pid);
      if (agentGroup || !identity || identity.uid !== process.getuid() || identity.pgid !== pid) throw new Error('process_registry_agent_group_invalid');
      agentGroup = identity;
      return identity;
    },
    async close() {
      if (closed) return; closed = true;
      fs.rmSync(path.join(directory, 'registration-open'), { force: true });
      for (const client of clients) client.destroy();
      await Promise.allSettled([...pending]);
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(socketRoot, { recursive: true, force: true });
      fs.rmSync(path.join(jobRoot, 'process-registry.json'), { force: true });
    },
  };
}

export function cleanupStaleProcessRegistry(jobRoot) {
  const file = path.join(jobRoot, 'process-registry.json'); if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const manager = inspectProcess(record.managerPid);
  if (manager?.started === record.managerStarted) throw new Error('process_registry_manager_still_alive');
  const root = record.socketRoot;
  if (typeof root !== 'string' || path.dirname(root) !== fs.realpathSync('/tmp') || !/^aa-registry-[A-Za-z0-9]+$/.test(path.basename(root))) throw new Error('process_registry_cleanup_unknown');
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('process_registry_cleanup_unknown');
    for (const name of fs.readdirSync(root)) {
      if (name !== 'ipc' || !fs.lstatSync(path.join(root, name)).isSocket()) throw new Error('process_registry_cleanup_unknown');
      fs.unlinkSync(path.join(root, name));
    }
    fs.rmdirSync(root);
  }
  fs.rmSync(file);
}

export function requestProcessRegistration({ socket, nonce, role, pid }) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socket }); let input = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; client.destroy(); error ? reject(error) : resolve(result); };
    client.setTimeout(5000, () => finish(new Error('process_registry_timeout')));
    client.on('error', () => finish(new Error('process_registry_unavailable')));
    client.once('connect', () => client.write(`${JSON.stringify({ nonce, role, pid })}\n`));
    client.on('data', chunk => {
      input += chunk.toString('utf8'); if (input.length > 2048) return finish(new Error('process_registry_response_invalid'));
      if (!input.includes('\n')) return;
      try { const result = JSON.parse(input.trim()); finish(result.ok === true ? null : new Error('process_registry_denied'), result); }
      catch { finish(new Error('process_registry_response_invalid')); }
    });
    client.once('end', () => { if (!settled) finish(new Error('process_registry_no_ack')); });
  });
}
