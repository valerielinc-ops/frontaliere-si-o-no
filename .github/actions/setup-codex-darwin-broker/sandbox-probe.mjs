/** No auth or model request: exercise the exact broker profile with the pinned CLI. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { brokerPermissionConfig } from '../setup-claude-haiku-fallback/broker-permissions.mjs';

const execute = promisify(execFile);
export async function probeDarwinSandbox({ cli, temporary, env }) {
  const root = fs.mkdtempSync(path.join(temporary, 'codex-darwin-probe.'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.toml'), brokerPermissionConfig(), { mode: 0o600 });
  const inside = path.join(workspace, 'readable.txt'); const outside = path.join(root, 'owner-canary.txt');
  fs.writeFileSync(inside, 'inside-readable'); fs.writeFileSync(outside, 'outside-must-not-be-readable');
  const options = { cwd: workspace, env: { ...env, CODEX_HOME: home }, timeout: 15_000, maxBuffer: 32_768 };
  const run = async (command, args) => {
    try { return { ok: true, ...(await execute(command, args, options)) }; }
    catch (error) { return { ok: false, stdout: String(error.stdout || '') }; }
  };
  const sandbox = args => run(cli, ['sandbox', '--permission-profile', 'codex-luna-max', '--cd', workspace, '--', ...args]);
  const server = http.createServer((_request, response) => response.end('reachable'));
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/`;
    if (!(await sandbox(['/usr/bin/true'])).ok) throw new Error('darwin_sandbox_positive_control_failed');
    const readable = await sandbox(['/bin/cat', inside]);
    if (!readable.ok || readable.stdout !== 'inside-readable') throw new Error('darwin_sandbox_workspace_read_failed');
    const forbidden = await sandbox(['/bin/cat', outside]);
    if (forbidden.ok || forbidden.stdout.includes('outside-must-not-be-readable')) throw new Error('darwin_sandbox_owner_read_not_denied');
    const write = path.join(workspace, 'forbidden-write.txt');
    if ((await sandbox(['/usr/bin/touch', write])).ok || fs.existsSync(write)) throw new Error('darwin_sandbox_workspace_write_not_denied');
    const args = ['--fail', '--silent', '--connect-timeout', '1', '--max-time', '2', url];
    if (!(await run('/usr/bin/curl', args)).ok) throw new Error('darwin_sandbox_network_control_failed');
    if ((await sandbox(['/usr/bin/curl', ...args])).ok) throw new Error('darwin_sandbox_network_not_denied');
    return { workspaceReadable: true, ownerCanaryDenied: true, workspaceWriteDenied: true, networkDenied: true };
  } finally { server.closeAllConnections?.(); server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
