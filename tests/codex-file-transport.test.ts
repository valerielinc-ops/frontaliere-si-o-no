import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from '../.github/actions/claude-codex-fallback/bridge-transport.mjs';

const run = promisify(execFile);
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
function setup(handler: (client: any) => void) {
  vi.stubEnv('CODEX_BRIDGE_TRANSPORT', 'files');
  const root = mkdtempSync(join(tmpdir(), 'codex-ipc-'));
  roots.push(root);
  const endpoint = join(root, 'mailbox');
  const server = createServer({}, handler);
  server.listen(endpoint);
  servers.push(server);
  return { root, endpoint };
}
function request(endpoint: string, body: string) {
  return new Promise<string>((resolve, reject) => {
    const client = createConnection(endpoint);
    let output = '';
    client.setTimeout(1000, () => { client.destroy(); reject(new Error('response timeout')); });
    client.on('data', (data: string) => { output += data; });
    client.on('error', reject);
    client.on('end', () => resolve(output));
    client.end(body);
  });
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Codex file IPC', () => {
  it('delivers concurrent bounded requests without mixing responses and cleans mailboxes', async () => {
    const { endpoint } = setup(client => {
      let body = '';
      client.on('data', (data: string) => { body += data; });
      client.on('end', () => client.end(`response:${body}`));
    });
    const values = await Promise.all(Array.from({ length: 12 }, (_, n) => request(endpoint, `${n}`)));
    expect(values).toEqual(Array.from({ length: 12 }, (_, n) => `response:${n}`));
    expect(readdirSync(endpoint)).toEqual([]);
  });
  it('rejects oversized requests before publishing them', async () => {
    const handler = vi.fn();
    const { endpoint } = setup(handler);
    await expect(request(endpoint, 'x'.repeat(65537))).rejects.toThrow('limit');
    expect(handler).not.toHaveBeenCalled();
    expect(readdirSync(endpoint)).toEqual([]);
  });
  it('does not follow a request symlink or read an oversized attacker-written file', async () => {
    const handler = vi.fn();
    const { root, endpoint } = setup(handler);
    const outside = join(root, 'outside');
    writeFileSync(outside, 'private fixture');
    symlinkSync(outside, join(endpoint, `${randomUUID()}.request`));
    writeFileSync(join(endpoint, `${randomUUID()}.request`), 'x'.repeat(65537));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(handler).not.toHaveBeenCalled();
    expect(readFileSync(outside, 'utf8')).toBe('private fixture');
  });
  it('notifies the host when a waiting client disconnects', async () => {
    let peer: any;
    const { endpoint } = setup(client => { peer = client; });
    const client = createConnection(endpoint);
    client.end('[]');
    await vi.waitFor(() => expect(peer).toBeDefined());
    const closed = vi.fn();
    peer.on('close', closed);
    client.destroy();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });
  it('retains authenticated GH reads, auth denial, and repository scope through the real bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-files-'));
    roots.push(root);
    const endpoint = join(root, 'mailbox');
    const fakeGh = join(root, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\n[ "$GH_TOKEN" = fixture-token ] || exit 9\nprintf "owner/repo\\n"\n', { mode: 0o755 });
    const action = resolve('.github/actions/claude-codex-fallback');
    const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
      env: { PATH: '/usr/bin:/bin', CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
        CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
        CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo', CODEX_GH_HOST: 'github.com' },
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      const call = (args: string[]) => run(process.execPath, [join(action, 'gh-bridge-client.mjs'), ...args], {
        env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint }, timeout: 2000,
      });
      expect((await call(['api', 'repos/owner/repo'])).stdout.trim()).toBe('owner/repo');
      await expect(call(['auth', 'token'])).rejects.toMatchObject({ code: 2 });
      await expect(call(['api', 'repos/other/repo'])).rejects.toMatchObject({ code: 2 });
      expect(readdirSync(endpoint)).toEqual([]);
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
  });
});
