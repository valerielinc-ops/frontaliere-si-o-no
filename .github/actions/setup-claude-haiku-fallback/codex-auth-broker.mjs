#!/usr/bin/env node
/**
 * Host-side one-shot runner for the Claude -> Codex subscription fallback.
 *
 * The setup action passes CODEX_AUTH_JSON over stdin and never writes it to a
 * file or to GITHUB_ENV. This process keeps the credential in memory, serves
 * one structured Codex request over a private Unix socket, and is the only
 * process that materializes CODEX_HOME/auth.json. The caller receives only
 * Codex's result; the credential never crosses the socket or enters a child
 * environment.
 *
 * The socket is deliberately the only job-wide hand-off. Its parent directory
 * is 0700 and the socket is 0600, and the broker removes both after the first
 * request, on expiry, or on termination. A malformed request never receives
 * auth and does not consume the one-shot slot. The short idle TTL is a backstop
 * for persistent runners; callers should still invoke the explicit cleanup
 * operation at the end of a job.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const CODEX_MODEL = 'gpt-5.6-luna';
const CODEX_EFFORT = 'medium';
const CODEX_CLI_VERSION = '0.153.4';
const CODEX_PROFILE = 'claude-haiku-fallback';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 600_000;
const CLIENT_LIVENESS_PROBE = '\0';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const socketArgument = argument('--socket');
const socketPath = socketArgument ? path.resolve(socketArgument) : '';
const codexCliArgument = argument('--codex-bin');
const codexCliRealpathArgument = argument('--codex-realpath');
const codexCliSha256Argument = argument('--codex-sha256').toLowerCase();
const codexCliPrefixArgument = argument('--codex-prefix');
const ttlRaw = Number(argument('--ttl-ms', String(DEFAULT_TTL_MS)));
const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS;

if (!socketArgument || !socketPath || socketPath === path.dirname(socketPath)) {
  console.error('Codex auth broker socket is required');
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_AUTH_BYTES) {
        reject(new Error('Codex auth broker input exceeds its limit'));
        process.stdin.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function validateSocketParent() {
  const parent = path.dirname(socketPath);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Codex auth broker parent must be a private 0700 directory');
  }
  if (fs.existsSync(socketPath)) {
    const socketStat = fs.lstatSync(socketPath);
    if (socketStat.isSymbolicLink()) throw new Error('Codex auth broker socket must not be a symlink');
    throw new Error('Codex auth broker socket already exists');
  }
}

function permissionConfig() {
  return `default_permissions = "${CODEX_PROFILE}"

[permissions.${CODEX_PROFILE}]
description = "Read-only Codex fallback in an empty temporary workspace"
extends = ":read-only"

[permissions.${CODEX_PROFILE}.network]
enabled = false

[permissions.${CODEX_PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"

[permissions.${CODEX_PROFILE}.filesystem.":workspace_roots"]
"." = "read"
`;
}

function childEnv(codexHome, codexTmp) {
  const env = {
    PATH: safePath(),
    CODEX_HOME: codexHome,
    TMPDIR: codexTmp,
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function safePath() {
  const nodeDir = path.dirname(process.execPath);
  return process.platform === 'win32'
    ? `${nodeDir};C:\\Windows\\System32;C:\\Windows`
    : `${nodeDir}:/usr/bin:/bin`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertOutsideWorkspace(target, label) {
  let workspace;
  try { workspace = fs.realpathSync(process.cwd()); } catch { return; }
  const relative = path.relative(workspace, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Codex CLI ${label} must be outside the mutable workspace`);
  }
}

/**
 * Validate the action-attested CLI before reading CODEX_AUTH_JSON. The
 * consumer only gets the Unix socket and cannot choose this path; the broker
 * accepts an absolute path from the setup action only after checking that it
 * remains in the private temporary prefix, has the expected digest, and
 * reports the pinned version without inheriting credentials.
 */
function validateCodexCli() {
  if (!path.isAbsolute(codexCliArgument) || !path.isAbsolute(codexCliRealpathArgument) || !path.isAbsolute(codexCliPrefixArgument)) {
    throw new Error('Codex CLI requires absolute --codex-bin, --codex-realpath, and --codex-prefix');
  }
  if (!/^[a-f0-9]{64}$/.test(codexCliSha256Argument)) {
    throw new Error('Codex CLI requires a valid --codex-sha256 attestation');
  }

  const prefixStat = fs.lstatSync(codexCliPrefixArgument);
  if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory() || (prefixStat.mode & 0o777) !== 0o700) {
    throw new Error('Codex CLI prefix must be a real private 0700 directory');
  }
  const prefix = fs.realpathSync(codexCliPrefixArgument);
  if (!path.basename(prefix).startsWith('claude-haiku-codex-cli.')) {
    throw new Error('Codex CLI prefix is not an action-owned temporary directory');
  }
  assertOutsideWorkspace(prefix, 'prefix');

  const cliStat = fs.lstatSync(codexCliArgument);
  if (cliStat.isSymbolicLink() || !cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
    throw new Error('Codex CLI path must be a real file, not a symlink');
  }
  const cli = fs.realpathSync(codexCliArgument);
  const expectedCli = fs.realpathSync(codexCliRealpathArgument);
  if (cli !== expectedCli) throw new Error('Codex CLI realpath attestation does not match');
  const relative = path.relative(prefix, cli);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Codex CLI must remain inside its private temporary prefix');
  }
  assertOutsideWorkspace(cli, 'binary');
  if (sha256File(cli) !== codexCliSha256Argument) {
    throw new Error('Codex CLI digest attestation does not match');
  }

  const versionProbe = spawnSync(cli, ['--version'], {
    cwd: prefix,
    env: {
      PATH: safePath(),
      CODEX_HOME: prefix,
      TMPDIR: prefix,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (versionProbe.error) throw new Error(`Codex CLI version probe failed: ${versionProbe.error.message}`);
  const versionOutput = `${versionProbe.stdout || ''}\n${versionProbe.stderr || ''}`;
  const versionMatch = versionOutput.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?:[^0-9]|$)/);
  if (versionProbe.status !== 0 || versionMatch?.[1] !== CODEX_CLI_VERSION) {
    throw new Error(`Codex CLI version mismatch: expected ${CODEX_CLI_VERSION}`);
  }
  return { cli, prefix };
}

/**
 * The broker is a long-lived host process, so killing only the direct Codex
 * child is not enough: the CLI may have helper processes in the same process
 * group. `detached: true` below makes the child a group leader on POSIX; send
 * the signal to the negative PGID there and fall back to ChildProcess.kill on
 * platforms where process groups are not available.
 */
function terminateChild(child, signal = 'SIGKILL') {
  const pid = Number(child?.pid);
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      // The group may have exited between the signal and this call. For any
      // other failure, still try the direct child handle below.
      if (!['ESRCH', 'EINVAL', 'EPERM'].includes(error?.code)) {
        console.error(`Codex auth broker process-group cleanup failed: ${error.message}`);
      }
    }
  }
  try { child?.kill?.(signal); } catch { /* child already exited */ }
}

function assertPrivateRuntime(runtimeRoot, directories, files) {
  const root = path.resolve(runtimeRoot);
  const assertInside = (target) => {
    const relative = path.relative(root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Codex auth broker runtime path escaped its private root');
    }
  };
  const assertEntry = (target, kind, mode) => {
    assertInside(target);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Codex auth broker ${kind} must be a real filesystem entry`);
    }
    if ((stat.mode & 0o777) !== mode) {
      throw new Error(`Codex auth broker ${kind} has unexpected permissions`);
    }
  };
  assertEntry(root, 'directory', 0o700);
  for (const directory of directories) assertEntry(directory, 'directory', 0o700);
  for (const file of files) assertEntry(file, 'file', 0o600);
}

function runCodex({ authJson: credential, prompt, timeoutMs, schema }) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-haiku-broker-'));
  const codexHome = path.join(runtimeRoot, 'home');
  const codexWorkspace = path.join(runtimeRoot, 'workspace');
  const codexTmp = path.join(runtimeRoot, 'tmp');
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, `${CODEX_PROFILE}.config.toml`);
  const outputPath = path.join(codexHome, 'last-message.txt');
  const schemaPath = path.join(codexHome, 'output-schema.json');
  let child = null;
  let runtimeCleaned = false;

  const finish = () => {
    // `auth.json`, schema, prompt output, and the private workspace are all
    // below a fresh 0700 root. This runs on success, failure, and timeout.
    if (runtimeCleaned) return;
    runtimeCleaned = true;
    if (activeRuntimeCleanup === finish) activeRuntimeCleanup = null;
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  };
  // Register before any setup/spawn work: a signal can arrive while the
  // runtime tree is being materialized, before the child handle exists.
  activeRuntimeCleanup = finish;

  const run = new Promise((resolve, reject) => {
    try {
      fs.chmodSync(runtimeRoot, 0o700);
      fs.mkdirSync(codexHome, { mode: 0o700 });
      fs.mkdirSync(codexWorkspace, { mode: 0o700 });
      fs.mkdirSync(codexTmp, { mode: 0o700 });
      fs.chmodSync(codexHome, 0o700);
      fs.chmodSync(codexWorkspace, 0o700);
      fs.chmodSync(codexTmp, 0o700);
      fs.writeFileSync(authPath, credential, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(authPath, 0o600);
      fs.writeFileSync(configPath, permissionConfig(), { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(configPath, 0o600);
      fs.writeFileSync(outputPath, '', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(outputPath, 0o600);

      const args = [
        'exec',
        '--ephemeral',
        '--strict-config',
        '--ignore-rules',
        '--profile', CODEX_PROFILE,
        '--cd', codexWorkspace,
        '--skip-git-repo-check',
        '--model', CODEX_MODEL,
        '-c', `model_reasoning_effort=${CODEX_EFFORT}`,
        '-c', 'shell_environment_policy.ignore_default_excludes=false',
        '-c', 'shell_environment_policy.inherit=none',
        '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
        '--output-last-message', outputPath,
      ];
      if (schema) {
        fs.writeFileSync(schemaPath, JSON.stringify(schema), { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(schemaPath, 0o600);
        args.push('--output-schema', schemaPath);
      }
      assertPrivateRuntime(
        runtimeRoot,
        [codexHome, codexWorkspace, codexTmp],
        [authPath, configPath, outputPath, ...(schema ? [schemaPath] : [])],
      );
      args.push('-');

      if (fs.realpathSync(codexCliPath) !== codexCliPath || sha256File(codexCliPath) !== codexCliSha256) {
        throw new Error('Codex CLI changed after attestation');
      }
      child = spawn(codexCliPath, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: childEnv(codexHome, codexTmp),
        cwd: codexWorkspace,
        detached: process.platform !== 'win32',
      });
      activeChild = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateChild(child, 'SIGKILL');
        const error = new Error(`Codex CLI timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Codex CLI exited with code ${code}`));
          return;
        }
        try {
          const result = fs.readFileSync(outputPath, 'utf8').trim();
          if (!result) throw new Error('Codex CLI returned an empty last message');
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(prompt);
    } catch (error) {
      reject(error);
    }
  });
  return run.finally(finish);
}

function validateRequest(request) {
  if (request?.op === 'cleanup') return '';
  if (!request || request.op !== 'exec') return 'unsupported request';
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) return 'prompt is required';
  const timeoutMs = Number(request.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) return 'invalid timeout';
  if (request.schema !== null && request.schema !== undefined && typeof request.schema !== 'object') {
    return 'invalid output schema';
  }
  return '';
}

let authJson = '';
let activeChild = null;
let activeRuntimeCleanup = null;
let codexCliPath = '';
let codexCliSha256 = '';
let codexCliPrefix = '';
let server;
let closed = false;
let consumed = false;
let expiry;

function cleanup() {
  const firstCleanup = !closed;
  closed = true;
  clearTimeout(expiry);
  terminateChild(activeChild, 'SIGKILL');
  activeChild = null;
  authJson = '';
  const runtimeCleanup = activeRuntimeCleanup;
  activeRuntimeCleanup = null;
  try { runtimeCleanup?.(); } catch (error) {
    console.error(`Codex auth broker runtime cleanup failed: ${error.message}`);
  }
  if (codexCliPrefix) {
    try { fs.rmSync(codexCliPrefix, { recursive: true, force: true }); } catch (error) {
      console.error(`Codex auth broker CLI prefix cleanup failed: ${error.message}`);
    }
    codexCliPrefix = '';
  }
  if (!firstCleanup) return;
  try { server?.close(); } catch { /* already closed */ }
  try { fs.unlinkSync(socketPath); } catch { /* runner cleanup may win */ }
  try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* socket/client may remain */ }
}

function responseFor(client, body, onSent = cleanup) {
  if (client.destroyed) {
    onSent();
    return;
  }
  const response = `${JSON.stringify(body)}\n`;
  if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
    client.end(`${JSON.stringify({ ok: false, error: 'response exceeds its limit' })}\n`, onSent);
    return;
  }
  client.end(response, onSent);
}

function handleClient(client) {
  let request = '';
  let bytes = 0;
  let handled = false;
  let requestAccepted = false;
  let responseStarted = false;
  client.setEncoding('utf8');
  client.setTimeout(5000, () => client.destroy());
  const cancelOnDisconnect = () => {
    // `end` is handled below as a request EOF. `close`/`error` means the peer
    // really disappeared; once this one-shot request was accepted, terminate
    // Codex and remove its private auth runtime rather than waiting for the
    // child timeout/TTL.
    if (requestAccepted && !responseStarted) cleanup();
  };
  client.on('error', cancelOnDisconnect);
  client.on('close', cancelOnDisconnect);
  client.on('end', () => {
    // An accepted request has already consumed the client's request line and
    // may half-close here while Codex is still running. Probe the writable
    // side to distinguish that normal request EOF from a peer that destroyed
    // the connection: a normal half-close accepts the byte, while a reset
    // reports EPIPE/ECONNRESET and triggers cleanup. The client strips this
    // private probe before parsing the eventual JSON response.
    if (!handled) {
      handled = true;
      responseFor(client, { ok: false, error: 'request must end with a JSON line' }, () => {});
      return;
    }
    if (requestAccepted && !responseStarted && !closed) {
      client.write(CLIENT_LIVENESS_PROBE, (error) => {
        if (!error || closed) return;
        cleanup();
        client.destroy();
      });
    }
  });
  client.on('data', (chunk) => {
    if (handled) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) {
      handled = true;
      responseFor(client, { ok: false, error: 'request exceeds its limit' }, () => {});
      return;
    }
    request += chunk;
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    let parsed;
    try { parsed = JSON.parse(request.slice(0, newline)); } catch {
      responseFor(client, { ok: false, error: 'invalid request' }, () => {});
      return;
    }
    const validationError = validateRequest(parsed);
    if (validationError) {
      responseFor(client, { ok: false, error: validationError }, () => {});
      return;
    }
    if (parsed?.op === 'cleanup') {
      responseStarted = true;
      responseFor(client, { ok: true, cleaned: true });
      return;
    }
    if (consumed) {
      responseFor(client, { ok: false, error: 'already consumed' }, () => {});
      return;
    }
    consumed = true;
    requestAccepted = true;
    client.setTimeout(Math.max(5000, Number(parsed.timeoutMs) + 10_000), () => {
      terminateChild(activeChild, 'SIGKILL');
      client.destroy();
    });
    const credential = authJson;
    // Do not retain the credential while Codex is running. runCodex receives a
    // private closure copy solely to write CODEX_HOME/auth.json.
    authJson = '';
    runCodex({
      authJson: credential,
      prompt: parsed.prompt,
      timeoutMs: Number(parsed.timeoutMs),
      schema: parsed.schema ?? null,
    }).then(
      (result) => {
        responseStarted = true;
        responseFor(client, { ok: true, result });
      },
      (error) => {
        responseStarted = true;
        responseFor(client, { ok: false, error: String(error?.message || error).slice(0, 300) });
      },
    ).finally(() => { activeChild = null; });
    // `runCodex` receives the credential through this request-local binding,
    // never from process.env. Malformed requests cannot force an auth operation.
  });
}

/**
 * Ask a running broker to terminate itself. This mode never reads stdin, so
 * the cleanup step can use the action output socket without receiving or
 * exporting CODEX_AUTH_JSON.
 */
function requestCleanup() {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    let client;
    try {
      client = net.createConnection(socketPath);
    } catch (error) {
      reject(error);
      return;
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setEncoding('utf8');
    client.setTimeout(5000, () => finish(new Error('Codex auth broker cleanup timed out')));
    client.on('error', (error) => finish(error));
    client.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(response.slice(0, newline)); } catch {
        finish(new Error('Codex auth broker cleanup returned invalid JSON'));
        return;
      }
      if (!parsed?.ok) {
        finish(new Error(String(parsed?.error || 'Codex auth broker cleanup rejected')));
        return;
      }
      finish(null, parsed);
    });
    client.on('end', () => {
      if (!settled) finish(new Error('Codex auth broker cleanup closed without a response'));
    });
    client.on('close', (hadError) => {
      if (!settled) finish(new Error(`Codex auth broker cleanup connection closed${hadError ? ' with an error' : ''}`));
    });
    client.on('connect', () => {
      try { client.end('{"op":"cleanup"}\n'); } catch (error) { finish(error); }
    });
  });
}

function start(auth, cliConfig) {
  authJson = auth;
  codexCliPath = cliConfig.cli;
  codexCliSha256 = codexCliSha256Argument;
  codexCliPrefix = cliConfig.prefix;
  validateSocketParent();
  // The client half-closes after sending the request while Codex is still
  // running; keep the server side open until the response is written.
  server = net.createServer({ allowHalfOpen: true }, handleClient);
  server.on('error', (error) => {
    console.error(`Codex auth broker failed: ${error.message}`);
    cleanup();
    process.exitCode = 1;
  });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    expiry = setTimeout(cleanup, ttlMs);
  });
}

if (process.argv.includes('--cleanup')) {
  requestCleanup().catch((error) => {
    console.error(`Codex auth broker cleanup unavailable: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  let cliConfig;
  try {
    cliConfig = validateCodexCli();
  } catch (error) {
    console.error(`Codex auth broker unavailable: ${error.message}`);
    process.exitCode = 1;
  }
  if (cliConfig) {
    readStdin().then((auth) => {
      if (!auth.trim()) throw new Error('Codex auth broker received an empty credential');
      start(auth, cliConfig);
    }).catch((error) => {
      console.error(`Codex auth broker unavailable: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

process.once('SIGTERM', () => { cleanup(); process.exit(0); });
process.once('SIGINT', () => { cleanup(); process.exit(0); });
