import fs from 'node:fs';
import * as net from './bridge-transport.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  FORCE_KILL_GRACE_MS,
  POSIX_PROCESS_GROUPS,
  childSpawnOptions,
  forceChildTermination,
  isChildRunning,
  requestChildTermination,
} from './child-lifecycle.mjs';

export { FORCE_KILL_GRACE_MS };

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_CONNECTIONS = 8;
export const SOCKET_TIMEOUT_MS = 30_000;
export const CHILD_TIMEOUT_MS = 120_000;
export const RESPONSE_TIMEOUT_MS = SOCKET_TIMEOUT_MS + CHILD_TIMEOUT_MS;
export const SHUTDOWN_TIMEOUT_MS = FORCE_KILL_GRACE_MS + 500;

const allowedCommands = new Set(['push', 'fetch', 'pull', 'ls-remote']);
const blockedGlobalOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--config', '--global', '--system', '--local', '--worktree', '--upload-pack', '--receive-pack']);
const safeOptions = new Set(['--all', '--prune', '--tags', '--force', '--force-with-lease', '--set-upstream', '-u', '--rebase', '--no-rebase', '--ff-only', '--no-edit', '--dry-run', '--delete', '-d', '--heads', '--refs', '--mirror', '--verbose', '-v', '--quiet', '-q', '--no-tags']);
const shadowEntries = ['objects', 'refs', 'logs', 'info', 'hooks', 'packed-refs'];

function markSideEffect(sideEffectFile) {
  if (!sideEffectFile || !path.isAbsolute(sideEffectFile)) return;
  fs.writeFileSync(sideEffectFile, 'git\n', { flag: 'a', mode: 0o600 });
}

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

/** Return whether a validated Git request can change local or remote state. */
export function isMutatingGitArgs(args) {
  return Array.isArray(args) && ['push', 'fetch', 'pull'].includes(args[0]);
}

function firstPositionalIndex(args) {
  let separator = false;
  for (let index = 1; index < args.length; index += 1) {
    if (!separator && args[index] === '--') {
      separator = true;
      continue;
    }
    if (!separator && args[index].startsWith('-')) continue;
    return index;
  }
  return -1;
}

/** Return a canonical, credential-free HTTPS remote for the trusted runner context. */
export function canonicalGitRemote({ host, repository } = {}) {
  const rawHost = String(host || '').trim();
  const rawRepository = String(repository || '').trim();
  if (!rawHost || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawRepository) || /[\u0000-\u001f\u007f\s]/.test(rawHost)) return '';
  try {
    const url = new URL(rawHost.includes('://') ? rawHost : `https://${rawHost}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return `${url.origin}/${rawRepository}.git`;
  } catch {
    return '';
  }
}

function safeExpectedRemote(value) {
  const raw = String(value || '');
  if (!raw || /[\u0000-\u001f\u007f\s%\\]/.test(raw)) return '';
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || segments.length !== 2 || !segments[1].endsWith('.git')) return '';
    if (segments.some((segment) => segment === '.' || segment === '..')) return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Replace the model's mutable `origin` lookup with the host-approved URL. */
export function buildGitNetworkArgs(args, expectedRemote) {
  const remote = safeExpectedRemote(expectedRemote);
  if (!remote) {
    throw new Error('Git bridge expected remote is invalid');
  }
  const result = [...args];
  const remoteIndex = firstPositionalIndex(result);
  if (remoteIndex >= 0) result[remoteIndex] = remote;
  else result.push(remote);
  return result;
}

function writeShadowCommonDir(hostScratch, commonGitDir, expectedRemote) {
  if (!path.isAbsolute(hostScratch) || !path.isAbsolute(commonGitDir)) {
    throw new Error('Git bridge metadata paths must be absolute');
  }
  fs.mkdirSync(hostScratch, { recursive: true, mode: 0o700 });
  const shadow = fs.mkdtempSync(path.join(hostScratch, 'common-'));
  try {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tbare = false',
      '[remote "origin"]',
      `\turl = ${expectedRemote}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(shadow, 'config'), config, { mode: 0o600 });
    for (const entry of shadowEntries) {
      const source = path.join(commonGitDir, entry);
      if (!fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      if (!stat.isDirectory() && !stat.isFile()) continue;
      fs.symlinkSync(source, path.join(shadow, entry), stat.isDirectory() ? 'dir' : 'file');
    }
    return shadow;
  } catch (error) {
    fs.rmSync(shadow, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const socketPath = process.env.CODEX_GIT_SOCKET;
  const token = process.env.CODEX_GIT_AUTH;
  const realGit = process.env.CODEX_REAL_GIT;
  const cwd = process.env.CODEX_GIT_CWD;
  const gitDir = process.env.CODEX_GIT_DIR;
  const commonGitDir = process.env.CODEX_GIT_COMMON_DIR;
  const hostScratch = process.env.CODEX_GIT_HOST_SCRATCH;
  const sideEffectFile = process.env.CODEX_GIT_SIDE_EFFECT_FILE || '';
  const expectedRemote = canonicalGitRemote({
    host: process.env.CODEX_GIT_HOST,
    repository: process.env.CODEX_GIT_REPOSITORY,
  });
  const configuredRemote = process.env.CODEX_GIT_REMOTE || expectedRemote;
  if (!socketPath || !token || !realGit || !cwd || !gitDir || !commonGitDir || !hostScratch || !expectedRemote || configuredRemote !== expectedRemote) process.exit(2);
  let shadowCommonDir;
  try {
    shadowCommonDir = writeShadowCommonDir(hostScratch, commonGitDir, expectedRemote);
  } catch {
    process.exit(2);
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const configEntries = [
    ['http.extraheader', `AUTHORIZATION: basic ${basic}`],
    ['http.proxy', ''],
    ['http.sslVerify', 'true'],
    ['credential.helper', ''],
    ['core.hooksPath', '/dev/null'],
    ['core.sshCommand', ''],
    ['core.gitProxy', ''],
    ['remote.origin.url', expectedRemote],
    ['remote.origin.uploadpack', ''],
    ['remote.origin.receivepack', ''],
  ];
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: shadowCommonDir,
    GIT_WORK_TREE: cwd,
    GIT_CONFIG_COUNT: String(configEntries.length),
  };
  for (const [index, [key, value]] of configEntries.entries()) {
    baseEnv[`GIT_CONFIG_KEY_${index}`] = key;
    baseEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  let activeConnections = 0;
  const children = new Set();
  const pendingProcessGroups = new Set();
  const useProcessGroups = POSIX_PROCESS_GROUPS;
  const clients = new Set();
  let shuttingDown = false;
  let shutdownFinalized = false;
  let shutdownTimer = null;
  let hardExitTimer = null;
  let exitStarted = false;
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      responseFor(client, { code: 2, stderr: 'Codex Git bridge is busy; retry later\n' });
      return;
    }
    activeConnections += 1;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeConnections -= 1;
    };
    let request = '';
    let requestBytes = 0;
    let requestTooLarge = false;
    let child = null;
    let childExited = true;
    let childTimer = null;
    let childTerminationTimer = null;
    let terminationRequested = false;
    let responseSent = false;
    let timedOut = false;
    const completeProcessGroupTermination = () => {
      pendingProcessGroups.delete(child);
      if (shuttingDown && children.size === 0 && pendingProcessGroups.size === 0) finalizeShutdown();
    };
    const terminateChild = (reason) => {
      if (!child || (childExited && !useProcessGroups)) return;
      if (reason === 'child-timeout' || reason === 'socket-timeout') timedOut = true;
      if (terminationRequested) return;
      terminationRequested = true;
      const timer = requestChildTermination(child, {
        processGroup: useProcessGroups,
        onComplete: completeProcessGroupTermination,
      });
      childTerminationTimer = timer;
      if (useProcessGroups && timer) pendingProcessGroups.add(child);
    };
    client.once('close', () => {
      if (child && (!childExited || useProcessGroups)) terminateChild('client-disconnected');
      if (childExited) releaseSlot();
    });
    const finish = (result) => {
      if (responseSent) return;
      responseSent = true;
      if (childTimer) clearTimeout(childTimer);
      if (childTerminationTimer && !useProcessGroups) clearTimeout(childTerminationTimer);
      if (childExited) releaseSlot();
      responseFor(client, result);
    };
    const timeoutClient = () => {
      timedOut = true;
      terminateChild('socket-timeout');
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
      } catch (error) {
        finish({ code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      client.setTimeout(RESPONSE_TIMEOUT_MS, timeoutClient);
      let childArgs;
      try {
        childArgs = buildGitNetworkArgs(args, expectedRemote);
      } catch (error) {
        finish({ code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      if (isMutatingGitArgs(args)) markSideEffect(sideEffectFile);
      child = spawn(realGit, childArgs, {
        cwd,
        env: baseEnv,
        ...childSpawnOptions({ processGroup: useProcessGroups }),
      });
      childExited = false;
      children.add(child);
      childTimer = setTimeout(() => terminateChild('child-timeout'), CHILD_TIMEOUT_MS);
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
        if (outputTooLarge) terminateChild('output-limit');
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
        if (outputTooLarge) terminateChild('output-limit');
      });
      child.on('error', (error) => {
        if (useProcessGroups && !terminationRequested) terminateChild('child-exited');
        childExited = true;
        children.delete(child);
        finish({ code: 1, stdout, stderr: `${stderr}${error.message}\n` });
        if (shuttingDown && children.size === 0 && pendingProcessGroups.size === 0) finalizeShutdown();
      });
      child.on('close', (code) => {
        // A Git transport helper can outlive the git leader. Reap the whole
        // dedicated group even after the leader has emitted close.
        if (useProcessGroups && !terminationRequested) terminateChild('child-exited');
        childExited = true;
        children.delete(child);
        releaseSlot();
        const detail = timedOut
          ? `${stderr}Codex Git bridge child timed out\n`
          : outputTooLarge ? `${stderr}Codex Git bridge output exceeded its limit\n` : stderr;
        finish({ code: timedOut || outputTooLarge ? 1 : code ?? 1, stdout, stderr: detail });
        if (shuttingDown && children.size === 0 && pendingProcessGroups.size === 0) finalizeShutdown();
      });
    });
  });
  server.maxConnections = MAX_ACTIVE_CONNECTIONS;
  server.listen(socketPath);
  const exitProcess = (code) => {
    if (exitStarted) return;
    exitStarted = true;
    if (hardExitTimer) clearTimeout(hardExitTimer);
    fs.rmSync(shadowCommonDir, { recursive: true, force: true });
    process.exit(code);
  };
  function finalizeShutdown() {
    if (shutdownFinalized) return;
    shutdownFinalized = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    hardExitTimer = setTimeout(() => exitProcess(1), 500);
    hardExitTimer.unref?.();
    if (server.listening) server.close(() => exitProcess(0));
    else exitProcess(0);
  }
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const client of clients) client.destroy();
    for (const child of children) {
      if (isChildRunning(child)) {
        const timer = requestChildTermination(child, {
          processGroup: useProcessGroups,
          onComplete: () => {
            pendingProcessGroups.delete(child);
            if (shuttingDown && children.size === 0 && pendingProcessGroups.size === 0) finalizeShutdown();
          },
        });
        if (useProcessGroups && timer) pendingProcessGroups.add(child);
      }
    }
    shutdownTimer = setTimeout(() => {
      for (const child of children) forceChildTermination(child, { processGroup: useProcessGroups });
      for (const child of pendingProcessGroups) forceChildTermination(child, { processGroup: useProcessGroups });
      pendingProcessGroups.clear();
      finalizeShutdown();
    }, SHUTDOWN_TIMEOUT_MS);
    if (children.size === 0) finalizeShutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
