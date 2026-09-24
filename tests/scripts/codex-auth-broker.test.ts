import crypto from 'node:crypto';
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
const realCodexVersion = (() => {
  const probe = spawnSync('codex', ['--version'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  return `${probe.stdout || ''}\n${probe.stderr || ''}`
    .match(/(?:OpenAI Codex v|codex-cli )([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] || '';
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

function writeFakeCodex(root: string, version = '0.153.4') {
  const fake = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    import fs from 'node:fs';
    if (process.argv.includes('--version')) {
      console.log('OpenAI Codex v${version}');
      process.exit(0);
    }
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

function writeHangingCodex(root: string, { descendant = false } = {}) {
  const fake = path.join(root, 'hanging-codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    if (process.argv.includes('--version')) {
      console.log('OpenAI Codex v0.153.4');
      process.exit(0);
    }
    const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
    const runtimeRoot = path.dirname(path.dirname(output));
    ${descendant ? `
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(runtimeRoot, 'descendant'), String(descendant.pid));
    ` : ''}
    fs.writeFileSync(path.join(runtimeRoot, 'started'), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  fs.chmodSync(fake, 0o700);
  return fake;
}

function codexPrefix(root: string) {
  const prefix = path.join(root, 'codex-luna-max-codex-cli.fixture');
  fs.mkdirSync(prefix, { mode: 0o700 });
  fs.chmodSync(prefix, 0o700);
  return prefix;
}

function codexAttestationArgs(codexBin: string, prefix: string) {
  const realpath = fs.realpathSync(codexBin);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(realpath)).digest('hex');
  return [
    '--codex-bin', realpath,
    '--codex-realpath', realpath,
    '--codex-sha256', sha256,
    '--codex-prefix', fs.realpathSync(prefix),
  ];
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
          .filter((name) => name.startsWith('codex-luna-max-broker-') && !existing.has(`${tempRoot}/${name}`));
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

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function waitForProcessGone(pid: number) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const timer = setInterval(() => {
      if (!processIsAlive(pid)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`process group descendant ${pid} did not terminate`));
      }
    }, 10);
  });
}

const profileConfig = `model_reasoning_effort = "medium"
default_permissions = "codex-luna-max"

[permissions.codex-luna-max]
description = "Read-only Codex fallback in an empty temporary workspace"
extends = ":read-only"

[permissions.codex-luna-max.network]
enabled = false

[permissions.codex-luna-max.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"

[permissions.codex-luna-max.filesystem.":workspace_roots"]
"." = "read"
`;

describe('Codex auth broker runtime contract', () => {
  const children: ReturnType<typeof spawn>[] = [];
  const roots: string[] = [];
  const descendants: number[] = [];

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
    for (const pid of descendants.splice(0)) {
      if (processIsAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    children.splice(0);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!realCodexAvailable)('parses the named permission profile with the installed Codex CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-smoke-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const tmpDir = path.join(root, 'tmp');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(tmpDir, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'config.toml'), profileConfig, { mode: 0o600 });

    const output: string[] = [];
    const child = spawn('codex', [
      'exec',
      '--ephemeral',
      '--strict-config',
      '--ignore-rules',
      '--profile', 'codex-luna-max',
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
    expect(log).toContain(`OpenAI Codex v${realCodexVersion}`);
    expect(log).toContain('reasoning effort: medium');
    expect(log).not.toMatch(/unknown (?:field|key)|failed to (?:load|parse).*config|could not load source profile|invalid permission profile/i);
  });

  it('rejects a PATH-only Codex binary before consuming the credential', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const pathBin = path.join(root, 'codex');
    const marker = path.join(root, 'path-binary-ran');
    fs.writeFileSync(pathBin, `#!/usr/bin/env node
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(marker)}, 'executed');
    `);
    fs.chmodSync(pathBin, 0o700);
    const socketPath = path.join(root, 'auth.sock');
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: `${root}:${process.env.PATH || '/usr/bin:/bin'}` },
    });
    children.push(child);
    child.stdin.on('error', () => {});
    child.stdin.end('{"access_token":"path-must-not-run"}');
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('broker did not reject a PATH-only Codex binary')), 2000,
      )),
    ]);
    expect(child.exitCode).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('rejects an attested Codex path when its reported version is not 0.153.4', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const prefix = codexPrefix(root);
    const fakeCodex = writeFakeCodex(prefix, '0.153.3');
    const socketPath = path.join(root, 'auth.sock');
    const stderr: string[] = [];
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    child.stdin.on('error', () => {});
    child.stdin.end('{"access_token":"wrong-version-must-not-run"}');
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('broker did not reject the Codex version mismatch')), 2000,
      )),
    ]);
    expect(child.exitCode).not.toBe(0);
    expect(stderr.join('')).toContain('version mismatch');
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('runs Codex with a private 0600 auth file, never returns auth, and cleans up', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = writeFakeCodex(prefix);
    const secret = '{"access_token":"runtime-only-secret"}';
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
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
    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit')), 2000)),
    ]);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('kills Codex and removes its private auth runtime when the client disconnects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const hangingCodex = writeHangingCodex(prefix);
    const existingRuntimes = new Set(
      brokerTempRoots().flatMap((tempRoot) => fs.readdirSync(tempRoot)
        .filter((name) => name.startsWith('codex-luna-max-broker-'))
        .map((name) => `${tempRoot}/${name}`)),
    );
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000', ...codexAttestationArgs(hangingCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
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

    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
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
    const prefix = codexPrefix(root);
    const hangingCodex = writeHangingCodex(prefix);
    const existingRuntimes = new Set(
      brokerTempRoots().flatMap((tempRoot) => fs.readdirSync(tempRoot)
        .filter((name) => name.startsWith('codex-luna-max-broker-'))
        .map((name) => `${tempRoot}/${name}`)),
    );
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000', ...codexAttestationArgs(hangingCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
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
    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after Codex timeout')), 2000)),
    ]);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('synchronously cleans auth/runtime and kills the Codex process group on SIGTERM', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const hangingCodex = writeHangingCodex(prefix, { descendant: true });
    const existingRuntimes = new Set(
      brokerTempRoots().flatMap((tempRoot) => fs.readdirSync(tempRoot)
        .filter((name) => name.startsWith('codex-luna-max-broker-'))
        .map((name) => `${tempRoot}/${name}`)),
    );
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000', ...codexAttestationArgs(hangingCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stdin.end('{"access_token":"signal-only"}');
    await waitForSocket(socketPath, child);

    const client = net.createConnection(socketPath);
    client.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject);
      client.once('connect', () => {
        client.removeListener('error', reject);
        client.write('{"op":"exec","prompt":"hang until SIGTERM","timeoutMs":600000,"schema":null}\n');
        resolve();
      });
    });
    const runtimeRoot = await waitForBrokerRuntime(existingRuntimes);
    const descendantPath = path.join(runtimeRoot, 'descendant');
    const descendantDeadline = Date.now() + 1000;
    while (!fs.existsSync(descendantPath) && Date.now() < descendantDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(descendantPath)).toBe(true);
    const descendantPid = Number(fs.readFileSync(descendantPath, 'utf8'));
    expect(descendantPid).toBeGreaterThan(1);
    descendants.push(descendantPid);

    const brokerExit = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([
      brokerExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after SIGTERM')), 2000)),
    ]);
    await waitForProcessGone(descendantPid);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
    client.destroy();
  });

  it('does not consume auth on malformed or unsupported requests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = writeFakeCodex(prefix);
    const secret = '{"access_token":"still-private"}';
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
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

  it('supports explicit cleanup before a bounded request is consumed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = writeFakeCodex(prefix);
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '600000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
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

  // Il profilo negava ":slash_tmp", ma il broker costruisce workspace,
  // CODEX_HOME e TMPDIR sotto os.tmpdir(), cioe' /tmp: il deny copriva il
  // workspace stesso e ogni chiamata Codex usciva con code 1 prima del modello
  // (gemello del corpus, run 36001495484). Il Codex finto registra dove il
  // broker lo lancia e quale profilo gli scrive, cosi' il contratto si verifica
  // sui percorsi reali e non sul testo.
  it('never denies the workspace it launches Codex in, while :root still hides auth', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = path.join(prefix, 'profile-codex.mjs');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
      import fs from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        console.log('OpenAI Codex v0.153.4');
        process.exit(0);
      }
      const output = args[args.indexOf('--output-last-message') + 1];
      process.stdin.resume();
      process.stdin.on('end', () => fs.writeFileSync(output, JSON.stringify({
        cwd: process.cwd(),
        cd: args[args.indexOf('--cd') + 1],
        tmpdir: process.env.TMPDIR,
        codexHome: process.env.CODEX_HOME,
        config: fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'),
      })));
    `);
    fs.chmodSync(fakeCodex, 0o700);
    // Come la setup action: `env -i PATH=...`, quindi nessun TMPDIR ereditato.
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stdin.end('{"access_token":"profile-check"}');
    await waitForSocket(socketPath, child);

    const response = await request(socketPath, { op: 'exec', prompt: 'profile', timeoutMs: 5000, schema: null });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    const seen = JSON.parse(String(response.result));
    expect(seen.cwd).toBe(seen.cd);

    const filesystem: Record<string, string> = {};
    let inFilesystem = false;
    for (const line of String(seen.config).split('\n')) {
      const header = line.match(/^\[(.+)\]\s*$/);
      if (header) {
        inFilesystem = /^permissions\.[^.]+\.filesystem$/.test(header[1]);
        continue;
      }
      const entry = inFilesystem ? line.match(/^"([^"]+)"\s*=\s*"([^"]+)"\s*$/) : null;
      if (entry) filesystem[entry[1]] = entry[2];
    }
    // ":root" resta il muro che nasconde auth.json: il workspace lo scavalca
    // per costruzione, ogni altro deny no.
    expect(filesystem[':root']).toBe('deny');
    const real = (target: string) => {
      try { return fs.realpathSync(target); } catch { return path.resolve(target); }
    };
    const special: Record<string, string> = { ':slash_tmp': '/tmp', ':tmpdir': String(seen.tmpdir) };
    const workspace = real(String(seen.cwd));
    for (const [rule, access] of Object.entries(filesystem)) {
      if (access !== 'deny' || rule === ':root') continue;
      const target = special[rule] ?? (path.isAbsolute(rule) ? rule : null);
      expect(target, `deny rule the test cannot resolve: ${rule}`).toBeTruthy();
      const relative = path.relative(real(String(target)), workspace);
      const coversWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      expect(coversWorkspace, `${rule} = "deny" covers the workspace ${workspace}`).toBe(false);
    }
    const homeInWorkspace = path.relative(workspace, real(String(seen.codexHome)));
    expect(homeInWorkspace.startsWith('..') || path.isAbsolute(homeInWorkspace)).toBe(true);
    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
  });

  it('returns the last Codex error line on a failed exit, redacted and bounded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const token = `eyJ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    const fakeCodex = path.join(prefix, 'failing-codex.mjs');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
      if (process.argv.includes('--version')) {
        console.log('OpenAI Codex v0.153.4');
        process.exit(0);
      }
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stderr.write('\\x1b[31m2026-09-24T13:59:26Z ERROR codex_models_manager: 401 with ${token}\\x1b[0m\\n');
        process.stderr.write('Error: thread/start failed: ' + 'error creating thread: '.repeat(15) + 'session ${token}: bwrap: Can\\'t mkdir parents for /tmp/w/tmp: Read-only file system (code -32603)\\n');
        process.exit(1);
      });
    `);
    fs.chmodSync(fakeCodex, 0o700);
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '10000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stdin.end('{"access_token":"failure-reason"}');
    await waitForSocket(socketPath, child);

    const response = await request(socketPath, { op: 'exec', prompt: 'fail', timeoutMs: 5000, schema: null });
    expect(response.ok).toBe(false);
    const error = String(response.error);
    expect(error).toMatch(/^Codex CLI exited with code 1: …/);
    expect(error).toMatch(/bwrap: Can't mkdir parents for \/tmp\/w\/tmp: Read-only file system \(code -32603\)$/);
    expect(error.length).toBeLessThanOrEqual(300);
    expect(error).toContain('[redacted]');
    expect(error).not.toMatch(/eyJ|[abc]{32,}|\x1b/);
  });

  // Il refresh token del login ChatGPT e' monouso e Codex riscrive il login
  // rinnovato in CODEX_HOME/auth.json. Con una home nuova per richiesta quella
  // scrittura si perdeva e ogni chiamata successiva rigiocava il token speso
  // («refresh token already used»). Il Codex finto qui fa il refresh a ogni
  // chiamata: la successiva deve partire dal login rinnovato, dalla stessa home.
  it('keeps one private CODEX_HOME per job so a refreshed login is reused by the next request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = path.join(prefix, 'refreshing-codex.mjs');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
      import fs from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        console.log('OpenAI Codex v0.153.4');
        process.exit(0);
      }
      const output = args[args.indexOf('--output-last-message') + 1];
      const workspace = args[args.indexOf('--cd') + 1];
      let prompt = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { prompt += chunk; });
      process.stdin.on('end', () => {
        const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
        const seen = fs.readFileSync(authPath, 'utf8');
        const login = JSON.parse(seen);
        if (prompt.includes('corrupt')) {
          fs.writeFileSync(authPath, '{"refresh_token":');
        } else {
          fs.writeFileSync(authPath, JSON.stringify({ ...login, refresh_token: 'rt-' + (login.generation + 1), generation: login.generation + 1 }));
        }
        fs.writeFileSync(output, JSON.stringify({
          seen: JSON.parse(seen),
          home: process.env.CODEX_HOME,
          homeMode: fs.statSync(process.env.CODEX_HOME).mode & 0o777,
          authMode: fs.statSync(authPath).mode & 0o777,
          workspace,
        }));
      });
    `);
    fs.chmodSync(fakeCodex, 0o700);
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '60000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stdin.end('{"refresh_token":"rt-0","generation":0}');
    await waitForSocket(socketPath, child);

    const exec = async (prompt: string) => {
      const response = await request(socketPath, { op: 'exec', prompt, timeoutMs: 5000, schema: null });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      return JSON.parse(String(response.result));
    };
    const first = await exec('first');
    const second = await exec('second');
    expect(first.seen).toEqual({ refresh_token: 'rt-0', generation: 0 });
    expect(second.seen).toEqual({ refresh_token: 'rt-1', generation: 1 });
    expect(second.home).toBe(first.home);
    expect(first.homeMode).toBe(0o700);
    expect(first.authMode).toBe(0o600);
    const relative = path.relative(path.resolve(first.workspace), path.resolve(first.home));
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
    expect(fs.existsSync(first.workspace)).toBe(false);

    // Un Codex ucciso a meta' riscrittura lascia auth.json illeggibile: la
    // richiesta dopo riparte dall'ultimo login buono, non dal secret iniziale.
    const corrupting = await exec('corrupt');
    expect(corrupting.seen).toEqual({ refresh_token: 'rt-2', generation: 2 });
    const afterCorruption = await exec('after');
    expect(afterCorruption.seen).toEqual({ refresh_token: 'rt-2', generation: 2 });

    expect(fs.existsSync(first.home)).toBe(true);
    await expect(request(socketPath, { op: 'cleanup' })).resolves.toEqual({ ok: true, cleaned: true });
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after cleanup')), 2000)),
    ]);
    expect(fs.existsSync(first.home)).toBe(false);
  });

  it('removes the per-job CODEX_HOME on SIGTERM', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-broker-test-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, 'auth.sock');
    const prefix = codexPrefix(root);
    const fakeCodex = path.join(prefix, 'home-codex.mjs');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
      import fs from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('OpenAI Codex v0.153.4');
        process.exit(0);
      }
      const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
      process.stdin.resume();
      process.stdin.on('end', () => fs.writeFileSync(output, process.env.CODEX_HOME));
    `);
    fs.chmodSync(fakeCodex, 0o700);
    const child = spawn(process.execPath, [brokerPath, '--socket', socketPath, '--ttl-ms', '60000', ...codexAttestationArgs(fakeCodex, prefix)], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    children.push(child);
    child.stdin.end('{"refresh_token":"sigterm"}');
    await waitForSocket(socketPath, child);
    const response = await request(socketPath, { op: 'exec', prompt: 'home', timeoutMs: 5000, schema: null });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    const home = String(response.result);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit after SIGTERM')), 2000)),
    ]);
    expect(fs.existsSync(home)).toBe(false);
  });
});
