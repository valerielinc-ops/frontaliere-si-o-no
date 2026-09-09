/**
 * Small, dependency-free shell lexer for PreToolUse policy hooks.
 *
 * The hooks must recognize an executable command, not a phrase in an argument,
 * comment, or heredoc. This is intentionally a lexer, not a shell evaluator:
 * unresolved shell expansion is reported as an unknown value and the caller
 * remains fail-safe.
 */

const MAX_INPUT_BYTES = 512 * 1024;
const COMMAND_SEPARATORS = new Set([';', '\n', '&&', '||', '|', '&', '(', ')', '{', '}']);
const REDIRECTION_OPERATORS = new Set(['<', '>', '>>', '<<', '<<<', '>&', '<>', '>|']);
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  '!',
  'time',
]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir']);
const SIMPLE_WRAPPER_OPTIONS = new Set(['-p', '--']);
const BODY_FLAGS = new Set(['--body', '--body-file', '-b', '-F']);
const VALUE_FLAGS = new Set([
  '--repo',
  '-R',
  '--body',
  '--body-file',
  '-b',
  '-F',
  '--title',
  '-t',
  '--add-label',
  '--remove-label',
  '--add-assignee',
  '--remove-assignee',
  '--milestone',
  '--base',
  '--head',
  '--project',
  '--team',
  '--reviewer',
]);

/**
 * Read the hook payload without making malformed input fatal.
 *
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<{ok:boolean, command:string, cwd?:string}>}
 */
export async function readHookCommand(stream = process.stdin) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) return { ok: false, command: '' };
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return { ok: true, command: '' };

    try {
      const payload = JSON.parse(raw);
      const command = payload?.tool_input?.command ?? payload?.command;
      return typeof command === 'string'
        ? {
            ok: true,
            command,
            cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
          }
        : { ok: false, command: '' };
    } catch {
      // A PreToolUse payload is JSON. Do not reinterpret malformed JSON as
      // shell text: it may merely quote policy words from a brief.
      return { ok: false, command: '' };
    }
  } catch {
    return { ok: false, command: '' };
  }
}

/**
 * Split shell text into simple-command word arrays. Unknown shell syntax is
 * returned as `ok:false`; callers must allow the original tool call then.
 *
 * @param {unknown} input
 * @returns {{ok:boolean, commands:string[][]}}
 */
export function parseShellCommands(input) {
  const source = String(input ?? '');
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
    return { ok: false, commands: [] };
  }

  const heredoc = maskHeredocBodies(source);
  if (!heredoc.ok) return { ok: false, commands: [] };

  const tokenized = tokenizeShell(heredoc.text);
  if (!tokenized.ok) return { ok: false, commands: [] };

  const commands = [];
  let current = [];
  for (const token of tokenized.tokens) {
    if (token.type === 'operator' && COMMAND_SEPARATORS.has(token.value)) {
      if (current.length) commands.push(current);
      current = [];
    } else if (token.type === 'word') {
      current.push(token.value);
    } else if (token.type === 'operator') {
      // Redirections stay with their simple command so a command such as
      // `>log gh run rerun 123` can still be recognized.
      current.push(token.value);
    }
  }
  if (current.length) commands.push(current);
  return { ok: true, commands };
}

/**
 * Find an actual `gh run rerun|cancel` invocation.
 *
 * @param {unknown} input
 * @returns {{action:'rerun'|'cancel', runId?:string}|null}
 */
export function findGhRunMutation(input) {
  const parsed = parseShellCommands(input);
  if (!parsed.ok) return null;

  for (const segment of parsed.commands) {
    const words = executableWords(segment);
    if (words[0] !== 'gh') continue;

    let index = skipGhGlobalOptions(words, 1);
    if (index < 0) continue;
    if (words[index] !== 'run' || !['rerun', 'cancel'].includes(words[index + 1])) continue;

    const action = words[index + 1];
    const runId = words.slice(index + 2).find((word) => /^\d+$/.test(word));
    return { action, ...(runId ? { runId } : {}) };
  }
  return null;
}

/**
 * Find an actual `gh pr edit` that carries a body flag. A missing numeric PR
 * target is deliberately represented as unknown: the caller can allow rather
 * than associate state with the wrong PR.
 *
 * @param {unknown} input
 * @param {Record<string, unknown>} [env]
 * @returns {{prNumber?:string, repo?:string, bodyFlag:string}|null}
 */
export function findPrBodyWrite(input, env = process.env) {
  const parsed = parseShellCommands(input);
  if (!parsed.ok) return null;

  for (const segment of parsed.commands) {
    const words = executableWords(segment);
    if (words[0] !== 'gh') continue;
    const ghCommandIndex = skipGhGlobalOptions(words, 1);
    if (
      ghCommandIndex < 0 ||
      words[ghCommandIndex] !== 'pr' ||
      words[ghCommandIndex + 1] !== 'edit'
    ) {
      continue;
    }

    let bodyFlag;
    let prNumber;
    let repo;
    for (let index = ghCommandIndex + 2; index < words.length; index += 1) {
      const word = words[index];
      if (BODY_FLAGS.has(word)) {
        bodyFlag = word;
        index += 1; // Do not read the body value as a possible PR number.
        continue;
      }
      if ([...BODY_FLAGS].some((flag) => word.startsWith(`${flag}=`))) {
        bodyFlag = word.slice(0, word.indexOf('='));
        continue;
      }
      if (word === '--repo' || word === '-R') {
        repo = words[index + 1];
        index += 1;
        continue;
      }
      if (word.startsWith('--repo=')) {
        repo = word.slice('--repo='.length);
        continue;
      }
      if (word.startsWith('-')) {
        if (VALUE_FLAGS.has(word)) index += 1;
        continue;
      }
      if (!prNumber && /^\d+$/.test(word)) {
        prNumber = word;
        continue;
      }
      if (!prNumber) {
        const urlPr = word.match(/\/pull\/(\d+)(?:[/?#]|$)/);
        if (urlPr) {
          prNumber = urlPr[1];
          repo ??= repoFromPullUrl(word);
        }
      }
    }

    if (!bodyFlag) continue;
    const envRecord = env && typeof env === 'object' ? env : {};
    prNumber ??= firstNumericEnv(envRecord, ['FRONTALIERE_PR_NUMBER', 'PR_NUMBER', 'GITHUB_PR_NUMBER']);
    repo ??= firstStringEnv(envRecord, ['GITHUB_REPOSITORY', 'GH_REPO']);
    if (repo && /[$`]/.test(repo)) repo = undefined;
    return { prNumber, repo, bodyFlag };
  }
  return null;
}

function executableWords(segment) {
  let words = [...segment];
  let index = 0;

  while (SHELL_KEYWORDS.has(words[index])) index += 1;
  while (ASSIGNMENT_RE.test(words[index] ?? '')) index += 1;

  while (index < words.length) {
    const word = words[index];
    if (/^\d+$/.test(word) && REDIRECTION_OPERATORS.has(words[index + 1])) {
      index += 2;
      if (index < words.length && words[index] !== '>&') index += 1;
      continue;
    }
    if (REDIRECTION_OPERATORS.has(word)) {
      index += 1;
      if (index < words.length && words[index] !== '>&') index += 1;
      continue;
    }
    if (ASSIGNMENT_RE.test(word)) {
      index += 1;
      continue;
    }
    if (word === 'env') {
      index += 1;
      while (index < words.length) {
        const option = words[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (ASSIGNMENT_RE.test(option)) {
          index += 1;
          continue;
        }
        if (option.startsWith('-')) {
          index += 1;
          if (ENV_VALUE_OPTIONS.has(option)) index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (word === 'command' || word === 'exec' || word === 'builtin') {
      index += 1;
      if (SIMPLE_WRAPPER_OPTIONS.has(words[index])) index += 1;
      continue;
    }
    if (word === 'sudo') {
      index += 1;
      while (index < words.length && words[index].startsWith('-')) {
        const option = words[index];
        index += 1;
        if (option === '-u' || option === '--user' || option === '-C') index += 1;
      }
      continue;
    }
    break;
  }
  return words.slice(index);
}

function skipGhGlobalOptions(words, index) {
  const takesValue = new Set(['--repo', '-R', '--hostname']);
  const noValue = new Set(['--debug', '--verbose']);
  let cursor = index;
  while (cursor < words.length && words[cursor].startsWith('-')) {
    const option = words[cursor];
    if (option === '--help' || option === '-h') return -1;
    if (option.startsWith('--repo=') || option.startsWith('--hostname=')) {
      cursor += 1;
      continue;
    }
    if (!takesValue.has(option) && !noValue.has(option)) return -1;
    cursor += 1;
    if (takesValue.has(option)) cursor += 1;
  }
  return cursor;
}

function firstNumericEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  }
  return undefined;
}

function firstStringEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function repoFromPullUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 4 && parts[2] === 'pull') return `${parts[0]}/${parts[1]}`;
  } catch {
    // Unknown URL form → leave repository unknown and let the caller pass.
  }
  return undefined;
}

function tokenizeShell(source) {
  const tokens = [];
  let word = '';
  let wordStarted = false;
  let index = 0;

  const flush = () => {
    if (!wordStarted) return;
    tokens.push({ type: 'word', value: word });
    word = '';
    wordStarted = false;
  };

  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      wordStarted = true;
      if (index + 1 >= source.length) return { ok: false, tokens: [] };
      if (source[index + 1] === '\n') {
        index += 2;
      } else {
        word += source[index + 1];
        index += 2;
      }
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return { ok: false, tokens: [] };
      wordStarted = true;
      word += source.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(source, index + 1);
      if (!quoted.ok) return { ok: false, tokens: [] };
      wordStarted = true;
      word += quoted.value;
      index = quoted.nextIndex;
      continue;
    }
    if (char === '#' && !wordStarted) {
      index = skipToNewline(source, index);
      continue;
    }
    if (char === '\n') {
      flush();
      tokens.push({ type: 'operator', value: '\n' });
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      index += 1;
      continue;
    }

    const operator = readOperator(source, index);
    if (operator) {
      flush();
      tokens.push({ type: 'operator', value: operator.value });
      index += operator.length;
      continue;
    }

    wordStarted = true;
    word += char;
    index += 1;
  }
  flush();
  return { ok: true, tokens };
}

function readDoubleQuoted(source, start) {
  let value = '';
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') return { ok: true, value, nextIndex: index + 1 };
    if (char === '\\') {
      if (index + 1 >= source.length) return { ok: false };
      if (source[index + 1] === '\n') {
        index += 2;
      } else {
        value += source[index + 1];
        index += 2;
      }
      continue;
    }
    value += char;
    index += 1;
  }
  return { ok: false };
}

function readOperator(source, index) {
  for (const value of ['&&', '||', '<<<', '>>', '<<', '>&', '<>', '>|']) {
    if (source.startsWith(value, index)) return { value, length: value.length };
  }
  if (';|&(){}<>'.includes(source[index])) return { value: source[index], length: 1 };
  return null;
}

function skipToNewline(source, index) {
  const newline = source.indexOf('\n', index);
  return newline < 0 ? source.length : newline;
}

function maskHeredocBodies(source) {
  let text = source;
  for (let count = 0; count < 32; count += 1) {
    const heredoc = findNextHeredoc(text);
    if (!heredoc) return { ok: true, text };
    if (!heredoc.ok) return { ok: false, text: '' };

    // `findNextHeredoc()` reports JavaScript string offsets (UTF-16 code
    // units). `split('')` keeps the same indexing model; `[...text]` would
    // collapse surrogate pairs and shift every later mask boundary.
    const chars = text.split('');
    maskRange(chars, heredoc.operatorStart, heredoc.headerEnd);
    maskRange(chars, heredoc.bodyStart, heredoc.bodyEnd);
    text = chars.join('');
  }
  return { ok: false, text: '' };
}

function findNextHeredoc(source) {
  let index = 0;
  let wordStarted = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += Math.min(2, source.length - index);
      wordStarted = true;
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return { ok: false };
      index = end + 1;
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(source, index + 1);
      if (!quoted.ok) return { ok: false };
      index = quoted.nextIndex;
      wordStarted = true;
      continue;
    }
    if (char === '#' && !wordStarted) {
      index = skipToNewline(source, index);
      continue;
    }
    if (char === '\n') {
      wordStarted = false;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      wordStarted = false;
      index += 1;
      continue;
    }
    if (char === '<' && source[index + 1] === '<' && source[index + 2] !== '<') {
      const operatorEnd = index + 2 + (source[index + 2] === '-' ? 1 : 0);
      const stripTabs = source[index + 2] === '-';
      let delimiterStart = operatorEnd;
      while (delimiterStart < source.length && /[ \t]/.test(source[delimiterStart])) delimiterStart += 1;
      const delimiter = readDelimiter(source, delimiterStart);
      if (!delimiter) return { ok: false };

      const lineEnd = source.indexOf('\n', delimiter.end);
      if (lineEnd < 0) {
        return {
          ok: true,
          operatorStart: index,
          headerEnd: delimiter.end,
          bodyStart: source.length,
          bodyEnd: source.length,
        };
      }
      const terminator = findHeredocTerminator(source, lineEnd + 1, delimiter.value, stripTabs);
      if (!terminator) return { ok: false };
      return {
        ok: true,
        operatorStart: index,
        headerEnd: delimiter.end,
        bodyStart: lineEnd + 1,
        bodyEnd: terminator.end,
      };
    }
    const operator = readOperator(source, index);
    if (operator) {
      wordStarted = false;
      index += operator.length;
      continue;
    }
    wordStarted = true;
    index += 1;
  }
  return null;
}

function readDelimiter(source, start) {
  if (start >= source.length) return null;
  const quote = source[start];
  if (quote === "'" || quote === '"') {
    const end = source.indexOf(quote, start + 1);
    if (end < 0 || end === start + 1) return null;
    return { value: source.slice(start + 1, end), end: end + 1 };
  }
  let end = start;
  while (end < source.length && !/[\s;&|(){}<>]/.test(source[end])) end += 1;
  if (end === start) return null;
  return { value: source.slice(start, end), end };
}

function findHeredocTerminator(source, start, delimiter, stripTabs) {
  let lineStart = start;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
    if (candidate === delimiter) return { end: newline < 0 ? lineEnd : newline + 1 };
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return null;
}

function maskRange(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}
