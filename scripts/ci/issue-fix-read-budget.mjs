/**
 * Small, fail-safe read guard for the issue-fix Bash hook.
 *
 * It does not rewrite prompts or inspect file contents. It only recognizes a
 * plainly unbounded `cat` of a large source file, so the agent can retry with
 * a bounded range while keeping the source available when it is needed.
 */
import { statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

export const MAX_SOURCE_BYTES = 12_000;

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.js',
  '.jsx',
  '.mjs',
  '.scss',
  '.ts',
  '.tsx',
]);

const NON_SOURCE_ROOTS = new Set([
  '_newsletter_variants',
  'data',
  'public',
  'reports',
]);

/** @param {string} command */
function splitShellCommands(command) {
  const segments = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  const text = String(command ?? '').replace(/\\\n/g, ' ');

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      char === ';' ||
      char === '\n' ||
      (char === '&' && text[i + 1] === '&') ||
      char === '|'
    ) {
      segments.push(text.slice(start, i));
      if ((char === '&' || char === '|') && text[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

/** @param {string} segment */
function tokenizeShellSegment(segment) {
  const tokens = [];
  let token = '';
  let quote = '';
  let escaped = false;

  const push = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === '>' || char === '<') {
      push();
      let operator = char;
      if (segment[i + 1] === char) {
        operator += char;
        i += 1;
      }
      if (segment[i + 1] === '&') {
        operator += '&';
        i += 1;
      }
      tokens.push(operator);
      continue;
    }
    token += char;
  }
  push();
  return tokens;
}

/**
 * Return source paths whose command can emit an unbounded amount of text.
 * Pipelines are split into their individual stages so a large `cat` cannot
 * hide behind a downstream command. `head`/`tail` are accepted only when
 * their byte cap is larger than the transcript budget.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function extractUnboundedCatPaths(command) {
  const text = String(command ?? '');
  if (!text) return [];

  const paths = [];
  for (const segment of splitShellCommands(text)) {
    const tokens = tokenizeShellSegment(segment);
    if (tokens.length === 0) continue;

    let commandIndex = 0;
    while (
      commandIndex < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex]) ||
        tokens[commandIndex] === 'env' ||
        tokens[commandIndex] === 'command')
    ) {
      commandIndex += 1;
    }
    const commandName = tokens[commandIndex];
    if (!['cat', 'head', 'tail'].includes(commandName)) continue;

    const commandTokens = tokens.slice(commandIndex + 1);
    const stdoutRedirect = commandTokens.some((token, index) => {
      if (!/^>>?&?$/.test(token)) return false;
      const previous = commandTokens[index - 1];
      return previous !== '2' && previous !== '3';
    });
    if (stdoutRedirect) continue;

    const candidatePaths = [];
    const addCandidatePath = (token) => {
      if (token && !token.startsWith('$') && !/[`*?[\]]/.test(token)) {
        candidatePaths.push(token);
      }
    };

    if (commandName === 'cat') {
      let optionsEnded = false;
      for (let i = 0; i < commandTokens.length; i += 1) {
        const token = commandTokens[i];
        if (token === '>' || token === '>>' || token === '<<') break;
        if (token === '<') {
          addCandidatePath(commandTokens[i + 1]);
          i += 1;
          continue;
        }
        if (!optionsEnded && token === '--') {
          optionsEnded = true;
          continue;
        }
        if (!optionsEnded && token.startsWith('-')) continue;
        if (token === '2' || token === '3') continue;
        addCandidatePath(token);
      }
      paths.push(...candidatePaths);
      continue;
    }

    let optionsEnded = false;
    let byteLimit;
    let hasByteOption = false;
    for (let i = 0; i < commandTokens.length; i += 1) {
      const token = commandTokens[i];
      if (token === '>' || token === '>>' || token === '<<') break;
      if (token === '<') {
        addCandidatePath(commandTokens[i + 1]);
        i += 1;
        continue;
      }
      if (!optionsEnded && token === '--') {
        optionsEnded = true;
        continue;
      }

      if (!optionsEnded && (token === '-c' || token === '--bytes')) {
        const next = Number(commandTokens[i + 1]);
        if (Number.isFinite(next)) {
          byteLimit = Math.abs(next);
          hasByteOption = true;
          i += 1;
        }
        continue;
      }
      if (!optionsEnded && token.startsWith('--bytes=')) {
        const value = Number(token.slice('--bytes='.length));
        if (Number.isFinite(value)) {
          byteLimit = Math.abs(value);
          hasByteOption = true;
        }
        continue;
      }
      if (!optionsEnded && token.startsWith('-c') && token.length > 2) {
        const value = Number(token.slice(2));
        if (Number.isFinite(value)) {
          byteLimit = Math.abs(value);
          hasByteOption = true;
        }
        continue;
      }
      if (!optionsEnded && /^-\d+$/.test(token)) {
        byteLimit = Number(token.slice(1));
        hasByteOption = true;
        continue;
      }
      if (!optionsEnded && (token === '-n' || token === '--lines')) {
        i += 1;
        continue;
      }
      if (!optionsEnded && token.startsWith('--lines=')) continue;
      if (!optionsEnded && token.startsWith('-')) continue;
      if (token === '2' || token === '3') continue;
      addCandidatePath(token);
    }

    if (hasByteOption && (!Number.isFinite(byteLimit) || byteLimit > MAX_SOURCE_BYTES)) {
      paths.push(...candidatePaths);
    }
  }
  return paths;
}

/**
 * @param {string} rawPath
 * @param {string} cwd
 * @returns {{relativePath:string, bytes:number}|null}
 */
function largeSourceFile(rawPath, cwd) {
  if (!rawPath || !cwd || rawPath.startsWith('~')) return null;
  const absolutePath = resolve(cwd, rawPath);
  const relativePath = relative(cwd, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    relativePath.startsWith('/')
  ) return null;

  const parts = relativePath.split(sep);
  if (NON_SOURCE_ROOTS.has(parts[0]) || !SOURCE_EXTENSIONS.has(extname(relativePath))) return null;

  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size <= MAX_SOURCE_BYTES) return null;
    return { relativePath, bytes: stats.size };
  } catch {
    return null;
  }
}

/**
 * @param {{command?:string,cwd?:string}} input
 * @returns {{relativePath:string,bytes:number}|null}
 */
export function findIssueFixReadBudgetViolation({ command = '', cwd = process.cwd() } = {}) {
  for (const rawPath of extractUnboundedCatPaths(command)) {
    const violation = largeSourceFile(rawPath, cwd);
    if (violation) return violation;
  }
  return null;
}

/**
 * @param {{filePath?:string,path?:string,offset?:number,limit?:number|string|null,cwd?:string}} input
 * @returns {{relativePath:string,bytes:number}|null}
 */
export function findIssueFixReadToolViolation({
  filePath = '',
  path: alternatePath = '',
  offset: _offset,
  limit,
  cwd = process.cwd(),
} = {}) {
  const violation = largeSourceFile(filePath || alternatePath, cwd);
  if (!violation) return null;

  const hasExplicitLimit = typeof limit === 'number'
    || (typeof limit === 'string' && limit.trim() !== '');
  const numericLimit = hasExplicitLimit ? Number(limit) : Number.NaN;
  if (Number.isFinite(numericLimit) && numericLimit >= 0 && numericLimit <= MAX_SOURCE_BYTES) {
    return null;
  }
  return violation;
}

/** @param {{relativePath:string,bytes:number}} violation */
export function formatReadBudgetViolation(violation) {
  return (
    `\n🚫 issue-fix read budget: lettura integrale bloccata per ${violation.relativePath} ` +
    `(${violation.bytes} byte; soglia ${MAX_SOURCE_BYTES}). ` +
    'Usa un intervallo `sed -n` o una ricerca `rg` mirata; il file resta disponibile.\n'
  );
}
