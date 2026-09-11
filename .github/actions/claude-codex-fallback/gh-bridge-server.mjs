import fs from 'node:fs';
import * as net from './bridge-transport.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  FORCE_KILL_GRACE_MS,
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

const allowedCommands = new Set(['api', 'issue', 'label', 'pr', 'run', 'search']);
const allowedSubcommands = new Map([
  ['issue', new Set(['view', 'list', 'create', 'comment', 'edit'])],
  ['label', new Set(['list', 'create'])],
  ['pr', new Set(['view', 'list', 'diff', 'comment', 'create', 'edit', 'review'])],
  ['run', new Set(['list', 'view'])],
  ['search', new Set(['issues'])],
]);
export const CORPUS_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
const corpusAllowedCommands = new Set(['issue']);
const corpusAllowedSubcommands = new Map([
  ['issue', new Set(['view', 'list', 'create', 'comment', 'edit'])],
]);
const mutatingSubcommands = new Map([
  ['issue', new Set(['create', 'comment', 'edit'])],
  ['label', new Set(['create'])],
  ['pr', new Set(['comment', 'create', 'edit', 'review'])],
]);
const operationValueFlags = new Set([
  '--repo', '-R', '--hostname', '--method', '-X', '--header', '-H', '--input', '--template',
  '--body-file', '--body', '--title', '--label', '--add-label', '--remove-label',
  '--color', '--description', '--json', '--jq', '--limit', '--state', '--match',
  '--workflow', '--branch', '--status', '--name', '--head', '--base', '--field',
  '--search', '--comment', '--milestone', '--assignee', '--project',
  '-F', '-f', '--raw-field',
]);
const blockedMutationFlags = new Set([
  '--close', '--reopen', '--lock', '--unlock', '--delete', '--delete-branch',
  '--reason', '--admin', '--merge', '--squash', '--rebase', '--approve',
  '--request-changes', '--dismiss', '--cancel',
]);
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
const apiBodyFlags = new Set(['--input', '-F', '--field', '-f', '--raw-field']);
const absoluteUrlPattern = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;
const apiEndpointValueFlags = new Set([
  '--method', '-X', '--header', '-H', '--hostname', '--repo', '-R',
  '--input', '--template', '-F', '--field', '-f', '--raw-field',
]);
const prBodyFileFlags = new Set(['--body-file', '-F']);
const prBodyInlineFlags = new Set(['--body', '-b']);
const MAX_PR_BODY_BYTES = 512 * 1024;
const IMPLEMENTED_HEADER_RE = /^[ \t]{0,3}#{2,3}[ \t]+Implementato\b/im;
const NON_IMPLEMENTED_HEADER_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*\(ancora\)/im;
const NON_IMPLEMENTED_ANY_HEADER_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato\b/im;
const CHAINED_PR_RE = /\bPR\s+concatenat[ao]\b/i;
const CHAINED_PR_NUMBER_RE = /\bPR\s+concatenat[ao]\s*#\s*\d+/i;
const BODY_STATE_RE = /\bin\s+questa\s+PR\b|\bPR\s+concatenat[ao]\s*#\s*\d+\b|\bper\s+scelta\b|\bby\s+construction\b|\bblocked\s*:\s*\S|\bfalso\s+positivo\b/i;

function realRoot(value) {
  try { return fs.realpathSync(value); } catch { return ''; }
}

function commandIndexFor(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--repo' || args[index] === '-R' || args[index] === '--hostname') index += 2;
    else index += 1;
  }
  return index;
}

function markSideEffect(sideEffectFile) {
  if (!sideEffectFile || !path.isAbsolute(sideEffectFile)) return;
  fs.writeFileSync(sideEffectFile, 'gh\n', { flag: 'a', mode: 0o600 });
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

function firstOperationArg(args, start) {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return args[index + 1] || '';
    if (!arg.startsWith('-')) return arg;
    if (!arg.includes('=') && operationValueFlags.has(arg)) index += 1;
  }
  return '';
}

/** Return whether a validated gh request can change remote state. */
export function isMutatingGhArgs(args) {
  if (!Array.isArray(args)) return false;
  const commandIndex = commandIndexFor(args);
  const command = args[commandIndex];
  return mutatingSubcommands.get(command)?.has(firstOperationArg(args, commandIndex + 1)) ?? false;
}

function hasExplicitOption(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function isApiBodyFlag(arg) {
  if (apiBodyFlags.has(arg)) return true;
  return arg.startsWith('--input=')
    || arg.startsWith('--field=')
    || arg.startsWith('--raw-field=')
    || (arg.startsWith('-F') && arg.length > 2)
    || (arg.startsWith('-f') && arg.length > 2);
}

function apiMethodError(args, start) {
  let method = 'GET';
  let explicitMethod = false;
  let hasBody = false;
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (isApiBodyFlag(arg)) hasBody = true;
    let value = null;
    if (arg === '--method' || arg === '-X') {
      value = args[index + 1] || '';
      index += 1;
      explicitMethod = true;
    } else if (arg.startsWith('--method=')) {
      value = arg.slice('--method='.length);
      explicitMethod = true;
    } else if (arg.startsWith('-X=')) {
      value = arg.slice(3);
      explicitMethod = true;
    } else if (arg.startsWith('-X') && arg.length > 2) {
      value = arg.slice(2);
      explicitMethod = true;
    }
    if (value !== null) method = value.toUpperCase();
  }
  if (hasBody && (!explicitMethod || method !== 'GET')) {
    return 'gh api body flags require an explicit GET method in the Codex fallback bridge';
  }
  return method === 'GET' ? '' : 'gh api mutations are not permitted by the Codex fallback bridge';
}

function validateOperation(args, commandIndex, command, repository, allowedSubcommandMap = allowedSubcommands) {
  if (command === 'api') return apiMethodError(args, commandIndex + 1);
  const operation = firstOperationArg(args, commandIndex + 1);
  if (!allowedSubcommandMap.get(command)?.has(operation)) {
    return `gh ${command} operation is not permitted by the Codex fallback bridge: ${operation || '<missing>'}`;
  }
  if (command === 'search' && ((!hasExplicitOption(args, '--repo') && !hasExplicitOption(args, '-R')) || !repository)) {
    return 'gh search requires an explicit current-repository --repo';
  }
  for (const arg of args.slice(commandIndex + 1)) {
    if (blockedMutationFlags.has(arg) || [...blockedMutationFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      return `gh mutation flag is not permitted by the Codex fallback bridge: ${arg}`;
    }
  }
  return '';
}

function explicitRepositories(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = optionValue(args, index, '--repo') || optionValue(args, index, '-R');
    if (!option) continue;
    values.push(option.value);
    index += option.consumed;
  }
  return values;
}

/** Select the host-side credential and command allow-list for one exact repo. */
export function resolveGhScope(args, {
  repository,
  host,
  siteToken,
  corpusToken = '',
  corpusRepository = CORPUS_REPOSITORY,
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return { error: 'invalid args' };
  const siteRepository = repositoryName(repository);
  const expectedCorpus = repositoryName(corpusRepository);
  const expectedHost = normalizedHost(host);
  if (!siteRepository || !expectedCorpus || expectedCorpus !== CORPUS_REPOSITORY || !expectedHost) {
    return { error: 'Codex GitHub bridge scope is missing its exact repository/host context' };
  }
  const repositories = explicitRepositories(args);
  if (repositories.some((value) => !repositoryName(value))) {
    return { error: 'gh --repo must name an exact owner/repository pair' };
  }
  const explicitRepository = repositories[0] || siteRepository;
  if (repositories.some((value) => value !== explicitRepository)) {
    return { error: 'gh --repo may not select multiple repositories in one request' };
  }
  // The corpus checkout can have the same value for siteRepository and
  // expectedCorpus. Match the exact corpus first so its PAT is never replaced
  // by the site token merely because the current checkout is the corpus.
  if (explicitRepository === expectedCorpus) {
    if (!corpusToken) return { error: 'Codex corpus bridge credential is unavailable' };
    return {
      kind: 'corpus',
      repository: expectedCorpus,
      token: corpusToken,
      allowedCommandSet: corpusAllowedCommands,
      allowedSubcommandMap: corpusAllowedSubcommands,
    };
  }
  if (explicitRepository === siteRepository) {
    if (!siteToken) return { error: 'Codex GitHub bridge site credential is unavailable' };
    return {
      kind: 'site',
      repository: siteRepository,
      token: siteToken,
      allowedCommandSet: allowedCommands,
      allowedSubcommandMap: allowedSubcommands,
    };
  }
  return { error: `gh --repo is restricted to ${siteRepository} or the exact corpus repository` };
}

function validateRepositoryAndHost(args, { repository, host } = {}) {
  const expectedRepository = repositoryName(repository);
  const expectedHost = normalizedHost(host);
  if (!expectedRepository || !expectedHost) return 'Codex GitHub bridge context is missing a valid repository/host';

  for (let index = 0; index < args.length; index += 1) {
    const repoOption = optionValue(args, index, '--repo') || optionValue(args, index, '-R');
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

function positionalUrlError(args, commandIndex) {
  let operationSeen = false;
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      for (const positional of args.slice(index + 1)) {
        if (absoluteUrlPattern.test(positional)) {
          return 'gh positional URLs are not permitted by the Codex fallback bridge';
        }
      }
      return '';
    }
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && operationValueFlags.has(arg)) index += 1;
      continue;
    }
    if (!operationSeen) {
      operationSeen = true;
      continue;
    }
    if (absoluteUrlPattern.test(arg)) {
      return 'gh positional URLs are not permitted by the Codex fallback bridge';
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

function fieldArgumentValue(arg) {
  for (const flag of fieldFlags) {
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    if ((flag === '-F' || flag === '-f') && arg.startsWith(flag) && arg.length > flag.length) {
      return arg.slice(flag.length);
    }
  }
  return null;
}

function stripBodyNonContent(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function bodySection(value, header) {
  const match = header.exec(value);
  if (!match) return null;
  const rest = value.slice(match.index + match[0].length);
  const nextHeading = /\n(?=#{1,6}[ \t])/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function bodyHasMeaningfulContent(value) {
  const clean = stripBodyNonContent(value);
  return clean.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}[ \t]/.test(trimmed)) return false;
    if (/^[-*+](?:[ \t]|$)/.test(trimmed)) return /^[-*+][ \t]+\S/.test(trimmed);
    return true;
  });
}

function bodyBullets(value) {
  return stripBodyNonContent(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*+][ \t]+\S/.test(line));
}

/** Validate the PR body contract without loading any repository code. */
export function validatePrBodyContract(body) {
  const value = String(body ?? '');
  const violations = [];
  const implemented = IMPLEMENTED_HEADER_RE.test(value);
  const nonImplemented = NON_IMPLEMENTED_HEADER_RE.test(value);
  if (!implemented) violations.push('missing ## Implementato');
  if (!nonImplemented) {
    violations.push(NON_IMPLEMENTED_ANY_HEADER_RE.test(value)
      ? 'missing (ancora) on ## Non implementato'
      : 'missing ## Non implementato (ancora)');
  }
  if (implemented && !bodyHasMeaningfulContent(bodySection(value, IMPLEMENTED_HEADER_RE) ?? '')) {
    violations.push('empty ## Implementato');
  }
  if (nonImplemented) {
    const section = bodySection(value, NON_IMPLEMENTED_HEADER_RE) ?? '';
    const bullets = bodyBullets(section);
    const hasNessuno = /\bnessun[oa]?\b/i.test(stripBodyNonContent(section));
    if (!hasNessuno && !bodyHasMeaningfulContent(section)) {
      violations.push('empty ## Non implementato (ancora)');
    }
    if (bullets.some((bullet) => CHAINED_PR_RE.test(bullet) && !CHAINED_PR_NUMBER_RE.test(bullet))) {
      violations.push('PR concatenata requires a #N');
    }
    if (bullets.some((bullet) => !BODY_STATE_RE.test(bullet))) {
      violations.push('every residual bullet requires a literal state');
    }
  }
  return { ok: violations.length === 0, violations };
}

function bodyFilePath(value, context) {
  if (!value || value === '-') return { error: 'gh PR body-file must name a readable workspace/scratch file' };
  const candidate = path.isAbsolute(value) ? value : path.resolve(context.cwd, value);
  const resolved = realRoot(candidate);
  let isFile = false;
  try { isFile = fs.statSync(resolved).isFile(); } catch { /* reported below */ }
  const allowed = isFile && context.allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!allowed) return { error: 'gh PR body-file must resolve under workspace/scratch' };
  try {
    const body = fs.readFileSync(resolved);
    if (body.length > MAX_PR_BODY_BYTES) return { error: 'gh PR body-file exceeds its size limit' };
    return { body: body.toString('utf8'), resolved };
  } catch {
    return { error: 'gh PR body-file is not readable' };
  }
}

function prBodyOption(args, start, flags) {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    for (const flag of flags) {
      if (arg === flag) return { flag, value: args[index + 1] || '', next: index + 1 };
      if (arg.startsWith(`${flag}=`)) return { flag, value: arg.slice(flag.length + 1), next: index };
    }
  }
  return null;
}

function validatePrBodyArgs(args, commandIndex, context) {
  const operation = firstOperationArg(args, commandIndex + 1);
  if (operation !== 'create' && operation !== 'edit') return '';
  const bodyFile = prBodyOption(args, commandIndex + 1, prBodyFileFlags);
  const bodyInline = prBodyOption(args, commandIndex + 1, prBodyInlineFlags);
  if (bodyInline) {
    return `gh pr ${operation} cannot use inline --body; use a validated --body-file`;
  }
  if (operation === 'create' && !bodyFile) {
    return 'gh pr create requires a validated --body-file';
  }
  if (!bodyFile) return '';
  const file = bodyFilePath(bodyFile.value, context);
  if (file.error) return file.error;
  const validation = validatePrBodyContract(file.body);
  return validation.ok ? '' : 'gh PR body contract is not satisfied';
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
  allowedCommandSet = allowedCommands,
  allowedSubcommandMap = allowedSubcommands,
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return 'invalid args';
  const allowedRoots = [realRoot(workspaceRoot || cwd), realRoot(scratchRoot)].filter(Boolean);
  const commandIndex = commandIndexFor(args);
  const command = args[commandIndex];
  if (blockedCommands.has(command) || !allowedCommandSet?.has(command)) {
    return `gh command is not permitted by the Codex fallback bridge: ${command || '<missing>'}`;
  }
  const scopeError = validateRepositoryAndHost(args, { repository, host });
  if (scopeError) return scopeError;
  const operationError = validateOperation(args, commandIndex, command, repository, allowedSubcommandMap);
  if (operationError) return operationError;
  const positionalUrlErrorMessage = positionalUrlError(args, commandIndex);
  if (positionalUrlErrorMessage) return positionalUrlErrorMessage;
  const context = { cwd: cwd || process.cwd(), allowedRoots };
  const bodyError = command === 'pr' ? validatePrBodyArgs(args, commandIndex, context) : '';
  if (bodyError) return bodyError;
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
      const value = fieldArgumentValue(arg);
      if (value !== null) {
        const error = fieldFileError(value, context);
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
  const siteToken = process.env.CODEX_GH_AUTH;
  const corpusToken = process.env.CODEX_GH_CORPUS_AUTH || '';
  const realGh = process.env.CODEX_REAL_GH;
  const sideEffectFile = process.env.CODEX_GH_SIDE_EFFECT_FILE || '';
  const cwd = process.env.CODEX_GH_CWD;
  const workspaceRoot = process.env.CODEX_GH_WORKSPACE || cwd;
  const scratchRoot = process.env.CODEX_GH_SCRATCH;
  const repository = repositoryName(process.env.CODEX_GH_REPOSITORY);
  const host = normalizedHost(process.env.CODEX_GH_HOST);
  const corpusRepository = process.env.CODEX_GH_CORPUS_REPOSITORY || CORPUS_REPOSITORY;
  if (!socketPath || !siteToken || !realGh || !cwd || !workspaceRoot || !scratchRoot || !repository || !host
    || corpusRepository !== CORPUS_REPOSITORY) process.exit(2);
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    GH_HOST: host,
  };
  let activeConnections = 0;
  const children = new Set();
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
      responseFor(client, { code: 2, stderr: 'Codex GitHub bridge is busy; retry later\n' });
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
    const terminateChild = (reason) => {
      if (!child || childExited) return;
      if (reason === 'child-timeout' || reason === 'socket-timeout') timedOut = true;
      if (terminationRequested) return;
      terminationRequested = true;
      childTerminationTimer = requestChildTermination(child);
    };
    client.once('close', () => {
      if (child && !childExited) terminateChild('client-disconnected');
      if (childExited) releaseSlot();
    });
    const finish = (result) => {
      if (responseSent) return;
      responseSent = true;
      if (childTimer) clearTimeout(childTimer);
      if (childTerminationTimer) clearTimeout(childTerminationTimer);
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
      let scope;
      try {
        args = JSON.parse(request);
        scope = resolveGhScope(args, {
          repository,
          host,
          siteToken,
          corpusToken,
          corpusRepository,
        });
        if (scope.error) throw new Error(scope.error);
        const validationError = validateGhArgs(args, {
          cwd,
          workspaceRoot,
          scratchRoot,
          repository: scope.repository,
          host,
          allowedCommandSet: scope.allowedCommandSet,
          allowedSubcommandMap: scope.allowedSubcommandMap,
        });
        if (validationError) throw new Error(validationError);
      } catch (error) {
        finish({ code: 2, stderr: `bridge request: ${error.message}\n` });
        return;
      }
      if (isMutatingGhArgs(args)) markSideEffect(sideEffectFile);
      client.setTimeout(RESPONSE_TIMEOUT_MS, timeoutClient);
      child = spawn(realGh, args, {
        cwd,
        env: {
          ...baseEnv,
          GH_TOKEN: scope.token,
          GH_REPO: scope.repository,
        },
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
        childExited = true;
        children.delete(child);
        finish({ code: 1, stdout, stderr: `${stderr}${error.message}\n` });
        if (shuttingDown && children.size === 0) finalizeShutdown();
      });
      child.on('close', (code) => {
        childExited = true;
        children.delete(child);
        releaseSlot();
        const detail = timedOut
          ? `${stderr}Codex GitHub bridge child timed out\n`
          : outputTooLarge ? `${stderr}Codex GitHub bridge output exceeded its limit\n` : stderr;
        finish({ code: timedOut || outputTooLarge ? 1 : code ?? 1, stdout, stderr: detail });
        if (shuttingDown && children.size === 0) finalizeShutdown();
      });
    });
  });
  server.maxConnections = MAX_ACTIVE_CONNECTIONS;
  server.listen(socketPath);
  const exitProcess = (code) => {
    if (exitStarted) return;
    exitStarted = true;
    if (hardExitTimer) clearTimeout(hardExitTimer);
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
      if (isChildRunning(child)) requestChildTermination(child);
    }
    shutdownTimer = setTimeout(() => {
      for (const child of children) {
        if (isChildRunning(child)) child.kill('SIGKILL');
      }
      finalizeShutdown();
    }, SHUTDOWN_TIMEOUT_MS);
    if (children.size === 0) finalizeShutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
