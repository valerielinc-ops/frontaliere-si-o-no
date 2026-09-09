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
    if (char === ';' || char === '\n' || (char === '&' && text[i + 1] === '&')) {
      segments.push(text.slice(start, i));
      if (char === '&') i += 1;
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
 * Return paths that are operands of a simple, unpiped `cat` command. A
 * pipeline is deliberately ignored: its downstream command may already cap
 * the output, and an ambiguous command must fail toward preserving context.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function extractUnboundedCatPaths(command) {
  const text = String(command ?? '');
  if (!text || text.includes('|')) return [];

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
    if (tokens[commandIndex] !== 'cat') continue;

    const commandTokens = tokens.slice(commandIndex + 1);
    const stdoutRedirect = commandTokens.some((token, index) => {
      if (!/^>>?&?$/.test(token)) return false;
      const previous = commandTokens[index - 1];
      return previous !== '2' && previous !== '3';
    });
    if (stdoutRedirect) continue;

    let optionsEnded = false;
    for (let i = 0; i < commandTokens.length; i += 1) {
      const token = commandTokens[i];
      if (token === '>' || token === '>>' || token === '<<') break;
      if (token === '<') {
        const redirectedPath = commandTokens[i + 1];
        if (redirectedPath && !redirectedPath.startsWith('$') && !/[`*?[\]]/.test(redirectedPath)) {
          paths.push(redirectedPath);
          i += 1;
        }
        continue;
      }
      if (!optionsEnded && token === '--') {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && token.startsWith('-')) continue;
      if (token === '2' || token === '3') continue;
      if (token && !token.startsWith('$') && !/[`*?[\]]/.test(token)) paths.push(token);
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

/** @param {{relativePath:string,bytes:number}} violation */
export function formatReadBudgetViolation(violation) {
  return (
    `\n🚫 issue-fix read budget: lettura integrale bloccata per ${violation.relativePath} ` +
    `(${violation.bytes} byte; soglia ${MAX_SOURCE_BYTES}). ` +
    'Usa un intervallo `sed -n` o una ricerca `rg` mirata; il file resta disponibile.\n'
  );
}
