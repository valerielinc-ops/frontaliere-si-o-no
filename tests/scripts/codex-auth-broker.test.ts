import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const brokerPath = path.resolve(
  process.cwd(),
  '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs',
);
const realCodexAvailable = (() => {
  const probe = spawnSync('codex', ['--version'], {
    stdio: 'ignore',
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  return probe.status === 0;
})();

function waitForSocket(socketPath: string, child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        clearInterval(timer);
        resolve();
      } else if (child.exitCode !== null || Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Codex auth broker did not become ready (exit ${child.exitCode})`));
      }
    }, 10);
  });
}

function request(socketPath: string, payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let response = '';
    client.setEncoding('utf8');
    client.setTimeout(5000, () => reject(new Error('broker request timed out')));
    client.on('error', reject);
    client.on('data', (chunk) => {
      let data = String(chunk);
      if (response.length === 0 && data.startsWith('\0')) data = data.slice(1);
      response += data;
    });
    client.on('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
    client.on('connect', () => client.end(`${JSON.stringify(payload)}\n`));
  });
}

function writeFakeCodex(root: string) {
  const fake = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    import fs from 'node:fs';
    const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
    const authPath = process.env.CODEX_HOME + '/auth.json';
    const auth = fs.readFileSync(authPath, 'utf8');
    const authMode = fs.statSync(authPath).mode & 0o777;
    const hasRawEnv = Object.keys(process.env).some((key) => key === 'CODEX_AUTH_JSON' || key === 'OPENAI_API_KEY');
    fs.writeFileSync(output, JSON.stringify({ auth, authMode, hasRawEnv }));
  `);
  fs.chmodSync(fake, 0o700);
  return fake;
}

function writeHangingCodex(root: string) {
  const fake = path.join(root, 'hanging-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    import fs from 'node:fs';
    import path from 'node:path';
    const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
    const runtimeRoot = path.dirname(path.dirname(output));
    fs.writeFileSync(path.join(runtimeRoot, 'started'), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  fs.chmodSync(fake, 0o700);
  return fake;
}

function brokerTempRoots() {
  return [...new Set([os.tmpdir(), '/tmp'])];
}

function waitForBrokerRuntime(existing: Set<string>) {
  return new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      for (const tempRoot of brokerTempRoots()) {
        const candidates = fs.readdirSync(tempRoot)
          .filter((name) => name.startsWith('codex-haiku-broker-') && !existing.has(`${tempRoot}/${name}`));
        const runtime = candidates.find((name) => fs.existsSync(path.join(tempRoot, name, 'started')));
        if (runtime) {
          clearInterval(timer);
          resolve(path.join(tempRoot, runtime));
          return;
        }
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('hanging Codex test process did not start'));
      }
    }, 10);
  });
}

const profileConfig = `model_reasoning_effort = "medium"
default_permissions = "claude-haiku-fallback"

[permissions.claude-haiku-fallback]
description = "Read-only Codex fallback in an empty temporary workspace"
extends = ":read-only"

[permissions.claude-haiku-fallback.network]
enabled = false

[permissions.claude-haiku-fallback.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"

[permissions.claude-haiku-fallback.filesystem.":workspace_roots"]
"." = "read"
`;

describe('Codex auth broker runtime contract', () => {
  const children: ReturnType<typeof spawn>[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
      if (child.exitCode === null) {
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    }
    children.splice(0);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!realCodexAvailable)('parses the named permission profile with the real Codex 0.153.4 CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-smoke-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const tmpDir = path.join(root, 'tmp');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(tmpDir, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'claude-haiku-fallback.config.toml'), profileConfig, { mode: 0o600 });

    const output: string[] = [];
    const child = spawn('codex', [
      'exec',
      '--ephemeral',
      '--strict-config',
      '--ignore-rules',
      '--profile', 'claude-haiku-fallback',
      '--cd', workspace,
      '--skip-git-repo-check',
      '--model', 'definitely-not-a-real-model',
      // Exercise the real read-only profile/sandbox path. The fake key and
      // invalid model make the process stop during startup without a model
      // completion; no danger bypass is allowed in this smoke.
      '--sandbox', 'read-only',
      '--output-last-message', path.join(root, 'last-message.txt'),
      '-',
    ], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        TERM: 'xterm',
        CODEX_HOME: root,
        CODEX_API_KEY: 'invalid-profile-smoke-key',
        TMPDIR: tmpDir,
      },
    });
    children.push(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref?.();
    child.stdin.end('profile parsing smoke\n');
    await once(child, 'close');
    clearTimeout(killTimer);
    const log = output.join('');
    expect(log).toContain('OpenAI Codex v0.153.4');
    expect(log).toContain('reasoning effort: medium');
    expect(log).not.toMatch(/unknown (?:field|key)|failed to (?:load|parse).*config|could not load source profile|invalid permission profile/i);
  });

  it('runs Codex with a private 0600 auth file, never returns auth, and cleans up', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const fakeCodex = writeFakeCodex(root);
    const secret = '{"access_token":"runtime-only-secret"}';
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CODEX_CLI_BIN: fakeCodex },
    });
    children.push(child);
    child.stdin.end(secret);
    await waitForSocket(socketPath, child);
    expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);

    const response = await request(socketPath, {
      op: 'exec',
      prompt: 'return a JSON object',
      timeoutMs: 1000,
      schema: null,
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response).not.toHaveProperty('auth');
    expect(JSON.parse(String(response.result))).toEqual({ auth: secret, authMode: 0o600, hasRawEnv: false });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit')), 2000)),
    ]);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(['fake-codex.mjs']);
  });

  it('kills Codex and removes its private auth runtime when the client disconnects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const hangingCodex = writeHangingCodex(root);
    const existingRuntimes = new Set(
      brokerTempRoots().flatMap((tempRoot) => fs.readdirSync(tempRoot)
        .filter((name) => name.startsWith('codex-haiku-broker-'))
        .map((name) => `${tempRoot}/${name}`)),
    );
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CODEX_CLI_BIN: hangingCodex },
    });
    children.push(child);
    child.stdin.end('{"access_token":"disconnect-only"}');
    await waitForSocket(socketPath, child);

    const client = net.createConnection(socketPath);
    client.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject);
      client.once('connect', () => {
        client.removeListener('error', reject);
        client.write('{"op":"exec","prompt":"hang","timeoutMs":600000,"schema":null}\n');
        resolve();
      });
    });
    const runtimeRoot = await waitForBrokerRuntime(existingRuntimes);
    const clientClosed = once(client, 'close');
    client.destroy();
    await Promise.race([
      clientClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test client did not close')), 1000)),
    ]);

    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `broker did not clean up after disconnect (exit=${child.exitCode}, runtime=${fs.existsSync(runtimeRoot)}, socket=${fs.existsSync(socketPath)})`,
      )), 2000)),
    ]);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('kills a hung Codex child and cleans its auth runtime on timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const hangingCodex = writeHangingCodex(root);
    const existingRuntimes = new Set(
      brokerTempRoots().flatMap((tempRoot) => fs.readdirSync(tempRoot)
        .filter((name) => name.startsWith('codex-haiku-broker-'))
        .map((name) => `${tempRoot}/${name}`)),
    );
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CODEX_CLI_BIN: hangingCodex },
    });
    children.push(child);
    child.stdin.end('{"access_token":"timeout-only"}');
    await waitForSocket(socketPath, child);

    const runtimePromise = waitForBrokerRuntime(existingRuntimes);
    const response = await request(socketPath, {
      op: 'exec',
      prompt: 'hang until the broker timeout',
      timeoutMs: 500,
      schema: null,
    });
    const runtimeRoot = await runtimePromise;
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after Codex timeout')), 2000)),
    ]);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('does not consume auth on malformed or unsupported requests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const fakeCodex = writeFakeCodex(root);
    const secret = '{"access_token":"still-private"}';
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CODEX_CLI_BIN: fakeCodex },
    });
    children.push(child);
    child.stdin.end(secret);
    await waitForSocket(socketPath, child);

    await expect(request(socketPath, { op: 'peek' })).resolves.toEqual({ ok: false, error: 'unsupported request' });
    const response = await request(socketPath, {
      op: 'exec',
      prompt: 'return a JSON object',
      timeoutMs: 1000,
      schema: null,
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
  });

  it('supports explicit cleanup before the one-shot request is consumed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const fakeCodex = writeFakeCodex(root);
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CODEX_CLI_BIN: fakeCodex },
    });
    children.push(child);
    child.stdin.end('{"access_token":"cleanup-only"}');
    await waitForSocket(socketPath, child);

    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after explicit cleanup')), 2000)),
    ]);
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
