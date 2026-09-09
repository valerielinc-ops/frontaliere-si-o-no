import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_CONNECTIONS = 8;
export const SOCKET_TIMEOUT_MS = 30_000;
export const CHILD_TIMEOUT_MS = 120_000;
export const RESPONSE_TIMEOUT_MS = SOCKET_TIMEOUT_MS + CHILD_TIMEOUT_MS;

const allowedCommands = new Set(['push', 'fetch', 'pull', 'ls-remote']);
const blockedGlobalOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--config', '--global', '--system', '--local', '--worktree', '--upload-pack', '--receive-pack']);
const safeOptions = new Set(['--all', '--prune', '--tags', '--force', '--force-with-lease', '--set-upstream', '-u', '--rebase', '--no-rebase', '--ff-only', '--no-edit', '--dry-run', '--delete', '-d', '--heads', '--refs', '--mirror', '--verbose', '-v', '--quiet', '-q', '--no-tags']);

function responseFor(client, { code, stdout = '', stderr = '' }) {
  if (client.destroyed) return;
  const response = `${JSON.stringify({ code, stdout, stderr })}\n`;
  if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
    client.end(JSON.stringify({ code: 1, stdout: '', stderr: 'Codex Git bridge response exceeded its output limit\n' }) + '\n');
    return;
  }
  client.end(response);
}

function isSafeOption(arg) {
  if (safeOptions.has(arg)) return true;
  return /^--force-with-lease=[^\s/]+$/.test(arg)
    || /^--depth=[0-9]+$/.test(arg)
    || /^--deepen=[0-9]+$/.test(arg)
    || /^--jobs=[0-9]+$/.test(arg);
}

/** Validate that the request starts with an allowed network Git command. */
export function validateGitArgs(args, { allowedRemote = 'origin' } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return 'invalid args';
  if (args.some((arg) => blockedGlobalOptions.has(arg) || arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--exec-path=') || arg.startsWith('--config-env=') || arg.startsWith('--upload-pack=') || arg.startsWith('--receive-pack='))) {
    return 'Git config/exec/path options are not permitted by the Codex fallback bridge';
  }
  const command = args[0];
  if (!command) return 'Git network command is not permitted by the Codex fallback bridge';
  if (!allowedCommands.has(command)) return `Git network command is not permitted by the Codex fallback bridge: ${command}`;
  let separator = false;
  const positional = [];
  for (const arg of args.slice(1)) {
    if (arg === '--') {
      separator = true;
      continue;
    }
    if (!separator && arg.startsWith('-')) {
      if (!isSafeOption(arg)) return `Git option is not permitted by the Codex fallback bridge: ${arg}`;
      continue;
    }
    if (!arg || arg.includes('\0') || arg.includes('://') || arg.startsWith('/') || arg.startsWith('~')) {
      return 'Git network paths and URLs are not permitted by the Codex fallback bridge';
    }
    positional.push(arg);
  }
  if (positional.length > 0 && positional[0] !== allowedRemote) {
    return `Git remote is not permitted by the Codex fallback bridge: ${positional[0]}`;
  }
  return '';
}

function currentOrigin(realGit, cwd) {
  try {
    return execFileSync(realGit, ['config', '--local', '--get', 'remote.origin.url'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function main() {
  const socketPath = process.env.CODEX_GIT_SOCKET;
  const token = process.env.CODEX_GIT_AUTH;
  const realGit = process.env.CODEX_REAL_GIT;
  const cwd = process.env.CODEX_GIT_CWD;
  const expectedRemote = process.env.CODEX_GIT_REMOTE;
  if (!socketPath || !token || !realGit || !cwd || !expectedRemote || expectedRemote.includes('\n') || expectedRemote.includes('\r')) process.exit(2);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  let activeConnections = 0;
  const children = new Set();
  const server = net.createServer((client) => {
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      responseFor(client, { code: 2, stderr: 'Codex Git bridge is busy; retry later\n' });
      return;
    }
    activeConnections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeConnections -= 1;
    };
    client.once('close', release);
    let request = '';
    let requestBytes = 0;
    let requestTooLarge = false;
    let child = null;
    let childTimer = null;
    let forceKillTimer = null;
    let responseSent = false;
    let timedOut = false;
    const finish = (result) => {
      if (responseSent) return;
      responseSent = true;
      if (childTimer) clearTimeout(childTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      responseFor(client, result);
    };
    const timeoutClient = () => {
      timedOut = true;
      if (child && !child.killed) child.kill('SIGTERM');
      client.destroy();
    };
    client.setTimeout(SOCKET_TIMEOUT_MS, timeoutClient);
    client.setEncoding('utf8');
    client.on('error', () => {});
    client.on('data', (chunk) => {
      if (requestTooLarge) return;
      requestBytes += Buffer.byteLength(chunk);
      if (requestBytes > MAX_REQUEST_BYTES) {
        requestTooLarge = true;
        client.destroy();
        return;
      }
      request += chunk;
    });
    client.on('end', () => {
      if (requestTooLarge) return;
      let args;
      try {
        args = JSON.parse(request);
        const validationError = validateGitArgs(args);
        if (validationError) throw new Error(validationError);
        if (currentOrigin(realGit, cwd) !== expectedRemote) throw new Error('Git origin changed after host-side sanitization');
      } catch (error) {
        finish({ code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      client.setTimeout(RESPONSE_TIMEOUT_MS, timeoutClient);
      child = spawn(realGit, args, { cwd, env: baseEnv });
      children.add(child);
      childTimer = setTimeout(() => {
        timedOut = true;
        if (!child.killed) child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2_000);
      }, CHILD_TIMEOUT_MS);
      let stdout = '';
      let stderr = '';
      let outputTooLarge = false;
      const append = (current, chunk) => {
        const bytes = Buffer.from(chunk);
        const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
        if (remaining <= 0) {
          outputTooLarge = true;
          return current;
        }
        if (bytes.length > remaining) outputTooLarge = true;
        return current + bytes.subarray(0, remaining).toString('utf8');
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
        if (outputTooLarge) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
        if (outputTooLarge) child.kill('SIGTERM');
      });
      child.on('error', (error) => {
        children.delete(child);
        finish({ code: 1, stdout, stderr: `${stderr}${error.message}\n` });
      });
      child.on('close', (code) => {
        children.delete(child);
        const detail = timedOut
          ? `${stderr}Codex Git bridge child timed out\n`
          : outputTooLarge ? `${stderr}Codex Git bridge output exceeded its limit\n` : stderr;
        finish({ code: timedOut || outputTooLarge ? 1 : code ?? 1, stdout, stderr: detail });
      });
    });
  });
  server.maxConnections = MAX_ACTIVE_CONNECTIONS;
  server.listen(socketPath);
  const shutdown = () => {
    for (const child of children) child.kill('SIGTERM');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
