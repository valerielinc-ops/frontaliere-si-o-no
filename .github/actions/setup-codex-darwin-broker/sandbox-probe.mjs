/** No auth or model request: exercise the exact broker profile with the pinned CLI. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { brokerPermissionConfig } from '../setup-claude-haiku-fallback/broker-permissions.mjs';
import { probeProcessEnvironmentPrivacy } from './process-privacy-probe.mjs';

const execute = promisify(execFile);
export async function probeDarwinSandbox({ cli, temporary, env, assertRuntime = () => {} }) {
  const physical = fs.realpathSync(temporary);
  if (['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].some(value => physical === value || physical.startsWith(`${value}/`))) {
    throw new Error('darwin_sandbox_probe_inside_scratch');
  }
  const root = fs.mkdtempSync(path.join(temporary, 'codex-darwin-probe.'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.toml'), brokerPermissionConfig(), { mode: 0o600 });
  const auth = path.join(home, 'auth.json'); fs.writeFileSync(auth, 'synthetic-auth-not-a-credential', { mode: 0o600 });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deny-canary-'));
  const scratchCanary = path.join(scratch, 'read.txt'); fs.writeFileSync(scratchCanary, 'scratch-must-not-be-readable', { mode: 0o600 });
  const inside = path.join(workspace, 'readable.txt'); const outside = path.join(root, 'owner-canary.txt');
  fs.writeFileSync(inside, 'inside-readable'); fs.writeFileSync(outside, 'outside-must-not-be-readable');
  const options = { cwd: workspace, env: { ...env, CODEX_HOME: home }, timeout: 15_000, maxBuffer: 32_768 };
  const run = async (command, args) => {
    assertRuntime();
    try { return { ok: true, ...(await execute(command, args, options)) }; }
    catch (error) { return { ok: false, code: error.code, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }; }
  };
  const sandbox = args => run(cli, ['sandbox', '--permission-profile', 'codex-luna-max', '--cd', workspace, '--', ...args]);
  const denied = result => !result.ok && result.code === 1 && !result.stdout
    && /operation not permitted|permission denied/i.test(result.stderr);
  const server = http.createServer((_request, response) => response.end('reachable'));
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/`;
    if (!(await sandbox(['/usr/bin/true'])).ok) throw new Error('darwin_sandbox_positive_control_failed');
    const readable = await sandbox(['/bin/cat', inside]);
    if (!readable.ok || readable.stdout !== 'inside-readable') throw new Error('darwin_sandbox_workspace_read_failed');
    for (const target of [outside, auth, scratchCanary]) {
      if (!(await run('/bin/cat', [target])).ok || !denied(await sandbox(['/bin/cat', target]))) throw new Error('darwin_sandbox_owner_read_not_denied');
    }
    const write = path.join(workspace, 'forbidden-write.txt');
    for (const target of [write, path.join(root, 'forbidden-owner-write'), path.join(scratch, 'forbidden-write')]) {
      if (!denied(await sandbox(['/usr/bin/touch', target])) || fs.existsSync(target)) throw new Error('darwin_sandbox_workspace_write_not_denied');
    }
    const args = ['--fail', '--silent', '--connect-timeout', '1', '--max-time', '2', url];
    if (!(await run('/usr/bin/curl', args)).ok) throw new Error('darwin_sandbox_network_control_failed');
    const network = await sandbox(['/usr/bin/curl', ...args]);
    if (network.ok || network.code !== 7 || network.stdout || !(await run('/usr/bin/curl', args)).ok) throw new Error('darwin_sandbox_network_not_denied');
    // Record the OS limitation truthfully. Model capability isolation is the
    // separately mandatory tools-empty native probe, never a false Seatbelt claim.
    const privacy = await probeProcessEnvironmentPrivacy({ sandbox, requireDenied: false });
    return { workspaceReadable: true, ownerCanaryDenied: true, authCanaryDenied: true, scratchCanaryDenied: true,
      workspaceWriteDenied: true, ownerWriteDenied: true, scratchWriteDenied: true, networkDenied: true, ...privacy };
  } finally { server.closeAllConnections?.(); server.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
}
