import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_CONNECTIONS = 8;
export const SOCKET_TIMEOUT_MS = 30_000;
export const CHILD_TIMEOUT_MS = 120_000;
export const RESPONSE_TIMEOUT_MS = SOCKET_TIMEOUT_MS + CHILD_TIMEOUT_MS;

// Global search is intentionally unavailable: it cannot be scoped to the
// current repository without turning the bridge into a broad read oracle.
const allowedCommands = new Set(['api', 'issue', 'label', 'pr', 'run']);
const blockedCommands = new Set([
  'auth', 'config', 'alias', 'extension', 'secret', 'secrets', 'variable',
  'variables', 'ssh-key', 'ssh-keys', 'gpg-key', 'gpg-keys', 'gist',
]);
const blockedApiPath = /(?:^|[/?])(secrets?|variables?|installations?|apps?|hooks?|ssh[_-]?keys?|gpg[_-]?keys?|settings)(?:[/?]|$)/i;
const blockedFlags = new Set([
  '--debug', '--verbose', '--trace', '--output', '-o', '--config', '--insecure-storage',
  '--with-token', '--pinentry-mode', '--jq', '--include', '--exclude',
]);
const fileFlags = new Set(['--body-file', '--input', '--template']);
const fieldFlags = new Set(['-F', '--field', '-f', '--raw-field']);
const apiEndpointValueFlags = new Set([
  '--method', '-X', '--header', '-H', '--hostname', '--repo',
  '--input', '--template', '-F', '--field', '-f', '--raw-field',
]);

function realRoot(value) {
  try { return fs.realpathSync(value); } catch { return ''; }
}

function commandIndexFor(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--repo' || args[index] === '--hostname') index += 2;
    else index += 1;
  }
  return index;
}

function normalizedHost(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\u0000-\u001f\u007f\s]/.test(raw)) return '';
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.host.toLowerCase();
  } catch {
    return '';
  }
}

function repositoryName(value) {
  const raw = String(value || '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(raw) ? raw : '';
}

function optionValue(args, index, name) {
  const arg = args[index];
  if (arg === name) return { value: args[index + 1] || '', consumed: 1 };
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
  return null;
}

function apiEndpoint(args, start) {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return args[index + 1] || '';
    if (!arg.startsWith('-')) return arg;
    if (!arg.includes('=') && apiEndpointValueFlags.has(arg)) index += 1;
  }
  return '';
}

function validateRepositoryAndHost(args, { repository, host } = {}) {
  const expectedRepository = repositoryName(repository);
  const expectedHost = normalizedHost(host);
  if (!expectedRepository || !expectedHost) return 'Codex GitHub bridge context is missing a valid repository/host';

  for (let index = 0; index < args.length; index += 1) {
    const repoOption = optionValue(args, index, '--repo');
    if (repoOption) {
      if (!repoOption.value || repoOption.value !== expectedRepository) {
        return `gh --repo is restricted to ${expectedRepository}`;
      }
      index += repoOption.consumed;
      continue;
    }
    const hostOption = optionValue(args, index, '--hostname');
    if (hostOption) {
      if (!hostOption.value || normalizedHost(hostOption.value) !== expectedHost) {
        return `gh --hostname is restricted to ${expectedHost}`;
      }
      index += hostOption.consumed;
    }
  }
  return '';
}

function validateApiEndpoint(args, commandIndex, repository) {
  const endpoint = apiEndpoint(args, commandIndex + 1);
  // Keep the historical validator contract for flag-only requests: gh itself
  // will reject a missing endpoint, but there is no remote target to broaden.
  if (!endpoint) return '';
  if (endpoint === '-' || endpoint.includes('://') || endpoint.startsWith('~')) {
    return 'gh api requires a relative endpoint for the current repository';
  }
  const pathPart = endpoint.split(/[?#]/, 1)[0];
  // Do not let encoded separators/dot segments become meaningful after gh or
  // an upstream URL parser decodes the request. Query encoding is harmless,
  // so only reject percent escapes in the endpoint path itself.
  if (pathPart.includes('%')) {
    return 'gh api endpoint must not contain percent-encoded path data';
  }
  if (pathPart.includes('\\') || pathPart.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'gh api endpoint must not contain dot segments or backslashes';
  }
  const normalized = pathPart.replace(/^\/+/, '');
  const match = /^repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/i.exec(normalized);
  if (!match || match[1] !== repository) {
    return 'gh api endpoint is restricted to the current repository';
  }
  return '';
}

function fileError(label, value, { cwd, allowedRoots }) {
  if (!value || value === '-') return `${label} must resolve to an existing workspace/scratch file`;
  const candidate = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const resolved = realRoot(candidate);
  let isFile = false;
  try { isFile = fs.statSync(resolved).isFile(); } catch { /* handled by the same safe error */ }
  const allowed = isFile && allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  return allowed ? '' : `${label} must resolve to an existing workspace/scratch file`;
}

function fieldFileError(value, context) {
  const marker = value.indexOf('=@');
  const candidate = marker >= 0 ? value.slice(marker + 2) : value.startsWith('@') ? value.slice(1) : '';
  return candidate ? fileError('gh field input', candidate, context) : '';
}

function fileArgumentError(flag, value, context) {
  if (flag === '--template' && value && !value.startsWith('@')) return '';
  const candidate = flag === '--template' ? value?.slice(1) : value;
  return fileError(flag, candidate, context);
}

function responseFor(client, { code, stdout = '', stderr = '' }) {
  if (client.destroyed) return;
  const response = `${JSON.stringify({ code, stdout, stderr })}\n`;
  if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
    client.end(JSON.stringify({
      code: 1,
      stdout: '',
      stderr: 'Codex GitHub bridge response exceeded its output limit\n',
    }) + '\n');
    return;
  }
  client.end(response);
}

/** Validate model-supplied gh arguments before the host-side token bridge runs. */
export function validateGhArgs(args, {
  cwd,
  workspaceRoot,
  scratchRoot,
  repository = process.env.CODEX_GH_REPOSITORY,
  host = process.env.CODEX_GH_HOST,
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return 'invalid args';
  const allowedRoots = [realRoot(workspaceRoot || cwd), realRoot(scratchRoot)].filter(Boolean);
  const commandIndex = commandIndexFor(args);
  const command = args[commandIndex];
  if (blockedCommands.has(command) || !allowedCommands.has(command)) {
    return `gh command is not permitted by the Codex fallback bridge: ${command || '<missing>'}`;
  }
  const scopeError = validateRepositoryAndHost(args, { repository, host });
  if (scopeError) return scopeError;
  const context = { cwd: cwd || process.cwd(), allowedRoots };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (blockedFlags.has(arg) || [...blockedFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      return `gh flag is not permitted by the Codex fallback bridge: ${arg}`;
    }
    const fileFlag = [...fileFlags].find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (fileFlag) {
      const value = arg === fileFlag ? args[index + 1] : arg.slice(fileFlag.length + 1);
      const error = fileArgumentError(fileFlag, value, context);
      if (error) return error;
      if (arg === fileFlag) index += 1;
    }
    if (fieldFlags.has(arg)) {
      const error = fieldFileError(args[index + 1] || '', context);
      if (error) return error;
      index += 1;
    } else {
      const flag = [...fieldFlags].find((candidate) => arg.startsWith(`${candidate}=`));
      if (flag) {
        const error = fieldFileError(arg.slice(flag.length + 1), context);
        if (error) return error;
      }
    }
  }
  if (command === 'api') {
    if (blockedApiPath.test(args.slice(commandIndex + 1).join(' '))) {
      return 'gh api endpoint is not permitted by the Codex fallback bridge';
    }
    const endpointError = validateApiEndpoint(args, commandIndex, repository);
    if (endpointError) return endpointError;
  }
  if (command === 'run' && args.slice(commandIndex + 1).includes('download')) {
    return 'gh run download is not permitted by the Codex fallback bridge';
  }
  return '';
}

function main() {
  const socketPath = process.env.CODEX_GH_SOCKET;
  const token = process.env.CODEX_GH_AUTH;
  const realGh = process.env.CODEX_REAL_GH;
  const cwd = process.env.CODEX_GH_CWD;
  const workspaceRoot = process.env.CODEX_GH_WORKSPACE || cwd;
  const scratchRoot = process.env.CODEX_GH_SCRATCH;
  const repository = repositoryName(process.env.CODEX_GH_REPOSITORY);
  const host = normalizedHost(process.env.CODEX_GH_HOST);
  if (!socketPath || !token || !realGh || !cwd || !workspaceRoot || !scratchRoot || !repository || !host) process.exit(2);
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    GH_TOKEN: token,
    GH_HOST: host,
    GH_REPO: repository,
  };
  let activeConnections = 0;
  const children = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      responseFor(client, { code: 2, stderr: 'Codex GitHub bridge is busy; retry later\n' });
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
        const validationError = validateGhArgs(args, {
          cwd, workspaceRoot, scratchRoot, repository, host,
        });
        if (validationError) throw new Error(validationError);
      } catch (error) {
        finish({ code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      client.setTimeout(RESPONSE_TIMEOUT_MS, timeoutClient);
      child = spawn(realGh, args, { cwd, env: baseEnv });
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
          ? `${stderr}Codex GitHub bridge child timed out\n`
          : outputTooLarge ? `${stderr}Codex GitHub bridge output exceeded its limit\n` : stderr;
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
