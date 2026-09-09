import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const allowedCommands = new Set(['api', 'issue', 'label', 'pr', 'run', 'search']);
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
export function validateGhArgs(args, { cwd, workspaceRoot, scratchRoot } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return 'invalid args';
  const allowedRoots = [realRoot(workspaceRoot || cwd), realRoot(scratchRoot)].filter(Boolean);
  const commandIndex = commandIndexFor(args);
  const command = args[commandIndex];
  if (blockedCommands.has(command) || !allowedCommands.has(command)) {
    return `gh command is not permitted by the Codex fallback bridge: ${command || '<missing>'}`;
  }
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
  if (command === 'api' && blockedApiPath.test(args.slice(commandIndex + 1).join(' '))) {
    return 'gh api endpoint is not permitted by the Codex fallback bridge';
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
  if (!socketPath || !token || !realGh || !cwd || !workspaceRoot || !scratchRoot) process.exit(2);
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    GH_TOKEN: token,
  };
  const server = net.createServer((client) => {
    let request = '';
    let requestBytes = 0;
    let requestTooLarge = false;
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
        const validationError = validateGhArgs(args, { cwd, workspaceRoot, scratchRoot });
        if (validationError) throw new Error(validationError);
      } catch (error) {
        responseFor(client, { code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      const child = spawn(realGh, args, { cwd, env: baseEnv });
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
        responseFor(client, { code: 1, stdout, stderr: `${stderr}${error.message}\n` });
      });
      child.on('close', (code) => {
        const detail = outputTooLarge ? `${stderr}Codex GitHub bridge output exceeded its limit\n` : stderr;
        responseFor(client, { code: outputTooLarge ? 1 : code ?? 1, stdout, stderr: detail });
      });
    });
  });
  server.listen(socketPath);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
