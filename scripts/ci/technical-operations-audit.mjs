/**
 * Audit deterministico dell'intero inventario GitHub Actions.
 *
 * L'audit non si limita ai workflow cambiati nella PR e non usa il nome del
 * file per decidere se un workflow appartiene alla flotta: un cron laterale o
 * un workflow di deploy rotto può invalidare un loop perfettamente sano.
 *
 * Controlla tre classi di difetti:
 *   1. struttura YAML e schema locale dei job/step;
 *   2. riferimenti irrisolti (needs, inputs, steps, script e action locali);
 *   3. segnali di estrazione dati senza una validazione visibile.
 *
 * Le azioni esterne sono intenzionalmente limitate: `--issue` apre o aggiorna
 * una issue canonica con le prove e lascia che il normale ciclo issue→PR→review
 * scelga la correzione. Il comando non modifica workflow o dati da solo.
 *
 * Uso:
 *   node scripts/ci/technical-operations-audit.mjs
 *   node scripts/ci/technical-operations-audit.mjs --json --report /tmp/a.json
 *   node scripts/ci/technical-operations-audit.mjs --issue --strict
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { createGithubIssue, ensureLabelsExist } from '../lib/github-issue-creator.mjs';
import { loadLoopPolicy } from '../lib/loop-fleet-contract.mjs';
import { auditLoopFleetBindings } from './loop-fleet-registry-audit.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WORKFLOW_DIR_NAME = path.join('.github', 'workflows');
export const DEFAULT_ISSUE_TITLE = 'Technical operations audit: workflow/data contract regressions';
export const L11_LOOP_ID = 'L11';
export const L11_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const L11_METADATA_SCHEMA_VERSION = 1;
export const L11_ISSUE_CONTRACT_SCHEMA_VERSION = 1;
export const L11_ISSUE_CONTRACT_MARKER = '<!-- L11_ISSUE_CONTRACT:';
const HOUR_MS = 3_600_000;
const MAX_ISSUE_BODY_LENGTH = 60_000;
// `renderL11IssueContract` emits one JSON line; the greedy close captures the
// outer object even though the contract contains the nested `ttl` object.
const L11_ISSUE_CONTRACT_RE = /<!-- L11_ISSUE_CONTRACT:\s*(\{.*\})\s*-->/m;
export const PERMISSION_KEYS = new Set([
  'actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions',
  'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests',
  'repository-projects', 'security-events', 'statuses',
]);
const INPUT_TYPES = new Set(['boolean', 'choice', 'environment', 'string']);
const WORKFLOW_RUN_TYPES = new Set(['completed', 'requested', 'in_progress']);
const STEP_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PATH_RE = /\b((?:scripts|functions|tests|\.github\/actions|\.github\/scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|sh|yml|yaml))\b/g;
const DATA_PATH_RE = /\b((?:data|public\/data)\/[A-Za-z0-9_./-]+\.(?:json|jsonl|csv|ts))\b/g;
const OUTPUT_RE = /(?:echo|printf)\s+["']?([A-Za-z_][A-Za-z0-9_-]*)(?:=|<<)/g;
const SHELL_ASSIGNMENT_RE = /(?:^|[;\n])\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm;
const SHELL_OUTPUT_ALIAS_RE = /(?:^|[;\n])\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\{GITHUB_OUTPUT(?::-[^"$`(){};\s]+)?\}"|\$\{GITHUB_OUTPUT(?::-[^"$`(){};\s]+)?\}|\$GITHUB_OUTPUT)(?=\s*(?:#.*)?(?:;|\n|$))/gm;
const OUTPUT_HELPER_CALL_RE = /\b(?:write_output|writeOutput|set_output|setOutput|emit_output|emitOutput)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_-]*)["']/g;
const OUTPUT_HELPER_SHELL_RE = /\b(?:write_output|writeOutput|set_output|setOutput|emit_output|emitOutput)\s+["']?([A-Za-z_][A-Za-z0-9_-]*)["']?/g;
const OUTPUT_ACTIONS_FILE_RE = /\bappendActionsFile\s*\(\s*["']GITHUB_OUTPUT["']\s*,\s*["']([A-Za-z_][A-Za-z0-9_-]*)["']/g;
const LOCAL_MODULE_RE = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const INVOKED_COMMAND_RE = /\b(?:node|bash|sh|tsx|bun|deno)\s+["']?((?:scripts|functions|tests|\.github\/actions|\.github\/scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|sh|yml|yaml))\b/g;
const SCRIPT_DIR_COMMAND_RE = /\b(?:bash|sh|source|\.)\s+["']?\$\{SCRIPT_DIR\}\/([^"'\s]+)/g;
const FILE_EXISTENCE_PATH_RE = /^(?:scripts|functions|tests|\.github\/actions|\.github\/scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|sh|yml|yaml)$/;
const MAX_OUTPUT_REFERENCE_FILES = 16;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lineFor(source, needle) {
  const index = typeof needle === 'string' ? source.indexOf(needle) : source.search(needle);
  return index < 0 ? 1 : source.slice(0, index).split(/\r?\n/).length;
}

function finding(file, rule, severity, message, line = 1, evidence = null) {
  return {
    file,
    line,
    rule,
    severity,
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = [item.file, item.line, item.rule, item.severity, item.message].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function workflowFiles(root = ROOT) {
  const directory = path.join(root, WORKFLOW_DIR_NAME);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(WORKFLOW_DIR_NAME, entry.name))
    .sort();
}

export function normalizeTriggers(on) {
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [String(name), null]));
  return isRecord(on) ? on : {};
}

export function cronError(cron) {
  if (typeof cron !== 'string' || cron.trim() === '') return 'cron mancante o non stringa';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `cron con ${fields.length} campi: GitHub Actions richiede 5 campi`;

  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex];
    for (const part of field.split(',')) {
      const [rangePart, stepPart] = part.split('/');
      if (part.split('/').length > 2 || !rangePart) {
        return `campo ${fieldIndex + 1} non valido: ${part}`;
      }
      if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) {
        return `step cron non valido: ${part}`;
      }
      const range = rangePart === '*' ? ['*'] : rangePart.split('-');
      if (range.length > 2 || range.some((value) => value !== '*' && !/^\d+$/.test(value))) {
        return `intervallo cron non valido: ${part}`;
      }
      const [minimum, maximum] = limits[fieldIndex];
      const numbers = range.filter((value) => value !== '*').map(Number);
      if (numbers.some((number) => number < minimum || number > maximum)) {
        return `valore cron fuori intervallo nel campo ${fieldIndex + 1}: ${part}`;
      }
      if (numbers.length === 2 && numbers[0] > numbers[1]) {
        return `intervallo cron decrescente: ${part}`;
      }
    }
  }
  return null;
}

function inputDefinitions(triggers) {
  const inputs = new Set();
  for (const triggerName of ['workflow_dispatch', 'workflow_call']) {
    const body = triggers[triggerName];
    if (!isRecord(body) || !isRecord(body.inputs)) continue;
    for (const name of Object.keys(body.inputs)) inputs.add(name);
  }
  return inputs;
}

function localReferenceExists(root, rawPath, workingDirectory = '.', exists = fs.existsSync) {
  if (rawPath.includes('${{')) return true;
  const cleanPath = rawPath.replace(/[),;:'"`]+$/g, '');
  const base = path.resolve(root, workingDirectory);
  if (cleanPath.startsWith('./.github/workflows/')) {
    return exists(path.resolve(base, cleanPath.slice(2)));
  }
  if (cleanPath.startsWith('./.github/actions/')) {
    const actionRoot = path.resolve(base, cleanPath.slice(2));
    return exists(path.join(actionRoot, 'action.yml'))
      || exists(path.join(actionRoot, 'action.yaml'));
  }
  return exists(path.resolve(base, cleanPath));
}

function staticWorkingDirectory(root, rawWorkingDirectory) {
  const value = typeof rawWorkingDirectory === 'string' && rawWorkingDirectory.trim()
    ? rawWorkingDirectory.trim()
    : '.';
  if (/\$\{\{|\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:\})?/.test(value)) return null;
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function staticCheckoutPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const value = rawPath.trim().replaceAll('\\', '/');
  if (value.includes('${{') || value.includes('$(') || value.startsWith('/')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '.' : normalized.replace(/^\.\//u, '');
}

function checkoutPathFromStep(step) {
  if (!isRecord(step) || typeof step.uses !== 'string') return null;
  const action = step.uses.split('@', 1)[0].toLowerCase();
  return action === 'actions/checkout' ? staticCheckoutPath(step.with?.path) : null;
}

function checkoutPathForWorkingDirectory(root, workingRoot, checkoutPaths) {
  if (workingRoot === null) return null;
  const relative = path.relative(root, workingRoot).split(path.sep).join('/');
  return [...checkoutPaths]
    .filter((checkoutPath) => checkoutPath !== '.'
      && (relative === checkoutPath || relative.startsWith(`${checkoutPath}/`)))
    .sort((a, b) => b.length - a.length)[0] || null;
}

function localReusableWorkflowPath(value) {
  if (typeof value !== 'string' || !value.startsWith('./.github/workflows/')) return null;
  return value.split('@', 1)[0].slice(2);
}

function isShellComment(source, offset) {
  const raw = String(source || '');
  const lineStart = raw.lastIndexOf('\n', offset) + 1;
  let quote = null;
  let escaped = false;
  for (let index = lineStart; index < offset; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#') {
      const previous = index === lineStart ? '' : raw[index - 1];
      if (previous === '' || /\s/u.test(previous) || ';|&(){}<>'.includes(previous)) return true;
    }
  }
  return false;
}

function extractCommandPaths(run) {
  const paths = [];
  const source = String(run || '');
  for (const match of source.matchAll(PATH_RE)) {
    const candidate = match[1].replace(/[),;:'"`]+$/g, '');
    if (!candidate.includes('${{') && !isShellComment(source, match.index ?? 0)) paths.push(candidate);
  }
  return [...new Set(paths)];
}

function extractLocalModulePaths(source) {
  return [...new Set([...String(source || '').matchAll(LOCAL_MODULE_RE)].map((match) => match[1]))];
}

function extractInvokedCommandReferences(source) {
  return [...String(source || '').matchAll(INVOKED_COMMAND_RE)].map((match) => ({
    path: match[1].replace(/[),;:'"`]+$/g, ''),
    index: match.index ?? 0,
  }));
}

function extractInvokedCommandPaths(source) {
  return [...new Set(extractInvokedCommandReferences(source).map((match) => match.path))];
}

function extractScriptDirCommands(source) {
  return [...new Set([...String(source || '').matchAll(SCRIPT_DIR_COMMAND_RE)].map((match) => match[1]))];
}

function extractDataPaths(run) {
  return [...new Set([...String(run || '').matchAll(DATA_PATH_RE)].map((match) => match[1]))];
}

const SHELL_KEYWORDS = new Set(['case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in', 'then', 'until', 'while']);
const SHELL_COMMENT_PRECEDERS = new Set([';', '&', '|', '(', ')', '{', '}', '<', '>']);
const SHELL_OPERATORS = [';&', ';;&', '||', '&&', '|&', ';;', '>>', '<<', '>&', '<&', '>|', ';', '|', '&', '(', ')', '{', '}', '<', '>'];

function shellTokens(source) {
  const raw = String(source || '');
  const tokens = [];
  let value = '';
  let start = -1;
  let unquoted = false;
  let quote = null;
  let escaped = false;
  let comment = false;

  const append = (char, isUnquoted, index) => {
    if (start < 0) start = index;
    value += char;
    if (isUnquoted) unquoted = true;
  };
  const flush = (end) => {
    if (start < 0) return;
    tokens.push({
      type: 'word',
      value,
      start,
      end,
      quotedOnly: !unquoted,
    });
    value = '';
    start = -1;
    unquoted = false;
  };
  const operatorAt = (index) => SHELL_OPERATORS.find((operator) => raw.startsWith(operator, index)) || null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (comment) {
      if (char === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && escaped) {
        append(char, false, index);
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        append(char, false, index);
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      append(char, false, index);
      continue;
    }
    if (escaped) {
      if (char !== '\n') append(char, true, index);
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (start < 0) start = index;
      escaped = true;
      unquoted = true;
      continue;
    }
    if (char === '\'' || char === '"') {
      if (start < 0) start = index;
      quote = char;
      continue;
    }
    if (char === '#'
      && start < 0
      && (index === 0 || /\s/u.test(raw[index - 1]) || SHELL_COMMENT_PRECEDERS.has(raw[index - 1]))) {
      comment = true;
      continue;
    }
    if (char === '\n') {
      flush(index);
      tokens.push({ type: 'operator', value: '\n', start: index, end: index + 1 });
      continue;
    }
    if (/\s/u.test(char)) {
      flush(index);
      continue;
    }
    const operator = operatorAt(index);
    if (operator) {
      flush(index);
      tokens.push({ type: 'operator', value: operator, start: index, end: index + operator.length });
      index += operator.length - 1;
      continue;
    }
    append(char, true, index);
  }
  if (escaped) append('\\', true, raw.length - 1);
  flush(raw.length);
  return tokens;
}

function parseShellCommands(source) {
  const tokens = shellTokens(source);
  const commands = [];
  const keywordTokens = [];
  let segment = [];
  let operatorBefore = null;

  const flush = (operatorAfter = null) => {
    if (segment.length === 0) return;
    const prefixKeywords = [];
    let commandIndex = -1;
    for (let index = 0; index < segment.length; index += 1) {
      const token = segment[index];
      if (commandIndex < 0 && token.type === 'word' && !token.quotedOnly && SHELL_KEYWORDS.has(token.value)) {
        prefixKeywords.push(token.value);
        keywordTokens.push(token);
        continue;
      }
      if (commandIndex < 0 && token.type === 'word') {
        commandIndex = index;
      }
    }
    if (commandIndex >= 0) {
      const commandToken = segment[commandIndex];
      commands.push({
        name: commandToken.value,
        nameToken: commandToken,
        args: segment.slice(commandIndex + 1),
        start: commandToken.start,
        end: segment.at(-1).end,
        operatorBefore,
        operatorAfter,
        prefixKeywords,
      });
    }
    segment = [];
    operatorBefore = operatorAfter;
  };

  for (const token of tokens) {
    if (token.type === 'operator') flush(token.value);
    else segment.push(token);
  }
  flush();
  return { tokens, commands, keywordTokens };
}

function shellConditionalBranches(parsed) {
  const branches = [];
  const stack = [];
  for (const token of parsed.keywordTokens) {
    if (token.value === 'if') {
      const branch = { conditionStart: token, then: null, bodyEnd: null };
      stack.push({ branches: [branch], current: branch });
      branches.push(branch);
    } else if (token.value === 'elif') {
      const block = stack.at(-1);
      if (!block) continue;
      if (block.current.then && !block.current.bodyEnd) block.current.bodyEnd = token;
      const branch = { conditionStart: token, then: null, bodyEnd: null };
      block.branches.push(branch);
      block.current = branch;
      branches.push(branch);
    } else if (token.value === 'then') {
      const block = stack.at(-1);
      if (block && !block.current.then) block.current.then = token;
    } else if (token.value === 'else') {
      const block = stack.at(-1);
      if (block && block.current.then && !block.current.bodyEnd) block.current.bodyEnd = token;
    } else if (token.value === 'fi') {
      const block = stack.pop();
      if (block && block.current.then && !block.current.bodyEnd) block.current.bodyEnd = token;
    }
  }
  return branches.filter((branch) => branch.then && branch.bodyEnd);
}

function fileExistencePath(command) {
  if (command.nameToken.quotedOnly) return null;
  const values = command.args.map((token) => token.value);
  const path = command.name === 'test' && values.length === 2 && values[0] === '-f'
    ? values[1]
    : command.name === '[' && values.length === 3 && values[0] === '-f' && values[2] === ']'
      ? values[1]
      : null;
  return path && FILE_EXISTENCE_PATH_RE.test(path) ? path : null;
}

function hasShellOperator(parsed, start, end, value) {
  return parsed.tokens.some((token) => token.type === 'operator'
    && token.value === value
    && token.start >= start
    && token.end <= end);
}

/**
 * Return literal files checked by the same shell step before it invokes a
 * command. A dynamic checkout is not statically inspectable from the control
 * checkout, but an explicit runtime `test -f` is a real, fail-closed proof of
 * the file that the following command will execute. Variable-based checks are
 * deliberately not accepted: the audit must not turn an unbounded loop into a
 * claim about a particular script.
 */
function extractFileExistenceAssertions(run) {
  const parsed = parseShellCommands(run);
  const branches = shellConditionalBranches(parsed);
  const assertions = new Map();
  const addAssertion = (path, assertion) => {
    const current = assertions.get(path) || [];
    current.push(assertion);
    assertions.set(path, current);
  };
  for (const command of parsed.commands) {
    const path = fileExistencePath(command);
    if (!path || command.prefixKeywords.includes('!')) continue;
    const conditionBranch = branches
      .filter((branch) => command.start > branch.conditionStart.end
        && command.end <= branch.then.start)
      .sort((left, right) => right.conditionStart.start - left.conditionStart.start)[0];
    if (conditionBranch) {
      if (hasShellOperator(parsed, command.end, conditionBranch.then.start, '||')) continue;
      addAssertion(path, {
        index: command.start,
        scope: { start: conditionBranch.then.end, end: conditionBranch.bodyEnd.start },
      });
      continue;
    }
    // GitHub's default bash shell is fail-fast. Only a complete command
    // followed by a command-list boundary is accepted here; constructs such
    // as `test -f file || true` are intentionally not proof of execution.
    if (command.prefixKeywords.length === 0
      && (command.operatorAfter === null || ['\n', ';', ')', '}'].includes(command.operatorAfter))) {
      addAssertion(path, { index: command.start, scope: null });
    }
  }
  return assertions;
}

/**
 * Remove shell string contents before looking for operational commands.
 * Workflow steps often print a copy/paste recipe containing `git add` and a
 * data path; those words are documentation, not a write performed by the
 * step. Preserve newlines so finding line numbers remain stable. When enabled,
 * preserve a quoted data path only after an operational `git add` or shell
 * redirection, so real quoted writes remain visible without reviving recipes.
 */
function shellOperationalText(run, { preserveQuotedWritePaths = false } = {}) {
  const source = String(run || '');
  const output = [];
  let line = '';
  let doubleQuoted = false;
  let comment = false;
  let escaped = false;
  let quote = null;
  let quotePrefix = '';
  let quoteContent = '';
  // This is the current shell command, not the current physical line. Keep it
  // separate from the masked output so a quoted data path can still inherit
  // the operational `git add`/redirection prefix across escaped newlines.
  let logicalCommand = '';
  let trailingBackslashes = 0;

  const append = (text) => {
    output.push(text);
    const parts = text.split('\n');
    line = parts.length > 1 ? parts.at(-1) : `${line}${text}`;
    for (const char of text) {
      // GitHub's YAML parser normally gives us LF, but accepting CRLF here
      // keeps the shell-context state independent of the source line ending.
      if (char === '\r') continue;
      if (char === '\n') {
        // A shell continuation is present only after an odd number of trailing
        // backslashes. Remove the continuation slash but retain the command
        // prefix while the next physical line is appended.
        if (trailingBackslashes % 2 === 1) logicalCommand = logicalCommand.slice(0, -1);
        else logicalCommand = '';
        trailingBackslashes = 0;
      } else {
        logicalCommand += char;
        trailingBackslashes = char === '\\' ? trailingBackslashes + 1 : 0;
      }
    }
  };
  const mask = (text) => append([...text].map((char) => char === '\n' ? '\n' : ' ').join(''));
  const quotedPathIsOperational = (content) => {
    if (!preserveQuotedWritePaths || !/^((?:data|public\/data)\/[A-Za-z0-9_./-]+\.(?:json|jsonl|csv|ts))$/i.test(content)) return false;
    const command = quotePrefix.split(/&&|\|\||[;|]/).at(-1) || '';
    return /\bgit\s+add\b[^\n]*$|(?:>>|>)\s*$/i.test(command);
  };

  for (const char of source) {
    if (quote) {
      if (doubleQuoted && escaped) {
        quoteContent += char;
        escaped = false;
        continue;
      }
      if (doubleQuoted && char === '\\') {
        quoteContent += char;
        escaped = true;
        continue;
      }
      if (char === quote) {
        if (quotedPathIsOperational(quoteContent)) append(quoteContent);
        else mask(quoteContent);
        mask(char);
        quote = null;
        doubleQuoted = false;
        escaped = false;
        quoteContent = '';
        continue;
      }
      quoteContent += char;
      continue;
    }
    if (comment) {
      if (char === '\n') comment = false;
      mask(char);
      continue;
    }
    if (escaped) {
      escaped = false;
      mask(char);
      continue;
    }
    if (doubleQuoted && char === '\\') {
      escaped = true;
      mask(char);
      continue;
    }
    if (!doubleQuoted && char === '#') {
      comment = true;
      mask(char);
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      doubleQuoted = char === '"';
      quotePrefix = logicalCommand;
      quoteContent = '';
      mask(char);
      continue;
    }
    append(char);
  }
  if (quoteContent) {
    mask(quoteContent);
  }
  return output.join('');
}

function stringLiterals(source) {
  const raw = String(source || '');
  const literals = [];
  let quote = null;
  let start = -1;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        literals.push({ value: raw.slice(start, index), start, end: index + 1 });
        quote = null;
        start = -1;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '#') {
      lineComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      start = index + 1;
    }
  }
  return literals;
}

function matchingParen(source, openingIndex) {
  const raw = String(source || '');
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingIndex; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function heredocOutputRanges(source) {
  const raw = String(source || '');
  const ranges = [];
  const heredocRes = [
    /(?:>>|>)\s*["']?\$GITHUB_OUTPUT["']?\s+<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))[^\r\n]*(?:\r?\n|$)/g,
    /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))\s+(?:>>|>)\s*["']?\$GITHUB_OUTPUT["']?[^\r\n]*(?:\r?\n|$)/g,
  ];
  for (const heredocRe of heredocRes) {
    for (const match of raw.matchAll(heredocRe)) {
      const rangeStart = match.index ?? 0;
      const bodyStart = rangeStart + match[0].length;
      const delimiter = match[2] || match[3] || match[5] || match[6];
      const indentation = match[0].includes('<<-') ? '[\\t]*' : '';
      const terminatorRe = new RegExp(`^${indentation}${delimiter}[ \\t]*(?:\\r?\\n|$)`, 'm');
      const terminator = raw.slice(bodyStart).match(terminatorRe);
      ranges.push({
        start: rangeStart,
        end: terminator ? bodyStart + (terminator.index ?? 0) : raw.length,
      });
    }
  }
  return ranges;
}

function assignmentNameStart(match) {
  return (match.index ?? 0) + match[0].lastIndexOf(match[1]);
}

/**
 * Track only shell variables whose current assignment is a direct, static
 * alias of GITHUB_OUTPUT. Dynamic aliases stay unknown so an audit warning is
 * still emitted when the destination cannot be proven from the source.
 */
function shellOutputAliasBindings(source) {
  const raw = String(source || '');
  if (!raw.includes('$GITHUB_OUTPUT') && !raw.includes('${GITHUB_OUTPUT')) return [];
  const aliases = [...raw.matchAll(SHELL_OUTPUT_ALIAS_RE)];
  if (aliases.length === 0) return [];
  const outputAliasStarts = new Set(aliases.map((match) => assignmentNameStart(match)));
  return [...raw.matchAll(SHELL_ASSIGNMENT_RE)].map((match) => ({
    name: match[1],
    index: assignmentNameStart(match),
    outputAlias: outputAliasStarts.has(assignmentNameStart(match)),
  }));
}

function latestShellAssignment(bindings, name, beforeIndex) {
  let latest = null;
  for (const binding of bindings) {
    if (binding.name !== name || binding.index >= beforeIndex) continue;
    if (!latest || binding.index > latest.index) latest = binding;
  }
  return latest;
}

/**
 * Find shell redirections to GITHUB_OUTPUT or to a proven shell alias. The
 * scanner ignores quoted text and comments, then limits each range to the
 * command's physical line so unrelated literals cannot become outputs.
 */
function shellOutputRedirectRanges(source, bindings) {
  const raw = String(source || '');
  if (!raw.includes('>') || (bindings.length === 0 && !raw.includes('$GITHUB_OUTPUT'))) return [];
  const ranges = [];
  let lineStart = 0;
  while (lineStart < raw.length) {
    const newline = raw.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? raw.length : newline;
    const line = raw.slice(lineStart, lineEnd);
    if (!/^\s*(?:#|\/\/)/u.test(line)) {
      let quote = null;
      let escaped = false;
      for (let offset = 0; offset < line.length; offset += 1) {
        const char = line[offset];
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === quote) {
            quote = null;
          }
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '#' && (offset === 0 || /\s/u.test(line[offset - 1]))) break;
        if (char !== '>') continue;

        let targetOffset = offset + 1;
        if (line[targetOffset] === '>') targetOffset += 1;
        while (/\s/u.test(line[targetOffset] || '')) targetOffset += 1;
        const quoted = line[targetOffset] === '"';
        if (quoted) targetOffset += 1;
        if (line[targetOffset] === "'") continue;

        const variable = line.slice(targetOffset).match(
          /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]+)?\}|^\$([A-Za-z_][A-Za-z0-9_]*)/u,
        );
        if (!variable) continue;
        const name = variable[1] || variable[2];
        const variableEnd = targetOffset + variable[0].length;
        const targetEndsHere = quoted
          ? line[variableEnd] === '"'
          : !/[A-Za-z0-9_$/{]/u.test(line[variableEnd] || '');
        if (!targetEndsHere) continue;
        const isOutput = name === 'GITHUB_OUTPUT'
          || latestShellAssignment(bindings, name, lineStart + offset)?.outputAlias === true;
        if (isOutput) {
          ranges.push({ start: lineStart, end: lineEnd });
          break;
        }
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return ranges;
}

function outputSinkRanges(source) {
  const raw = String(source || '');
  const shellBindings = shellOutputAliasBindings(raw);
  const outputVariables = new Set(['process.env.GITHUB_OUTPUT', 'env.GITHUB_OUTPUT']);
  for (const match of raw.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*process\.env\.GITHUB_OUTPUT\b/g)) {
    outputVariables.add(match[1]);
  }
  const variableAlternation = [...outputVariables]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const sinkRe = new RegExp(
    '\\b(?:appendFileSync|writeFileSync)\\(\\s*(?:'
      + variableAlternation
      + ')\\s*,',
    'g',
  );
  const ranges = [];
  for (const match of raw.matchAll(sinkRe)) {
    const openingIndex = raw.indexOf('(', match.index ?? 0);
    const closingIndex = matchingParen(raw, openingIndex);
    let rangeStart = match.index ?? 0;
    if (closingIndex >= 0) {
      const argument = raw.slice((match.index ?? 0) + match[0].length, closingIndex).trim();
      const variableMatch = argument.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (variableMatch) {
        const escapedVariable = variableMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declarationRe = new RegExp(`\\b(?:const|let|var)\\s+${escapedVariable}\\s*=`, 'g');
        for (const declaration of raw.slice(0, match.index ?? 0).matchAll(declarationRe)) {
          rangeStart = declaration.index ?? rangeStart;
        }
      }
    }
    ranges.push({
      start: rangeStart,
      end: closingIndex >= 0 ? closingIndex + 1 : raw.length,
    });
  }
  return [
    ...ranges,
    ...shellOutputRedirectRanges(raw, shellBindings),
    ...heredocOutputRanges(raw),
  ];
}

function literalOutputKeys(source, sinkRanges = outputSinkRanges(source)) {
  const keys = new Set();
  const outputKeyRe = /(?:^|\r?\n|\\n|\\r\\n)([A-Za-z_][A-Za-z0-9_-]*)(?:=|<<)/g;
  for (const literal of stringLiterals(source)) {
    const belongsToSink = sinkRanges.some(({ start, end }) => literal.start >= start && literal.start < end);
    if (!belongsToSink) continue;
    for (const match of literal.value.matchAll(outputKeyRe)) keys.add(match[1]);
  }
  return keys;
}

function matchingBrace(source, openingIndex) {
  const raw = String(source || '');
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingIndex; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function objectEntryOutputKeys(source, sinkRanges = outputSinkRanges(source)) {
  const raw = String(source || '');
  const keys = new Set();
  if (sinkRanges.length === 0) return keys;
  const declarationRe = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{/g;
  for (const declaration of raw.matchAll(declarationRe)) {
    const variable = declaration[1];
    const declarationStart = declaration.index ?? 0;
    const openingIndex = raw.indexOf('{', declarationStart);
    const closingIndex = matchingBrace(raw, openingIndex);
    if (closingIndex < 0) continue;
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entriesRe = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*Object\\.entries\\(\\s*${escapedVariable}\\s*\\)[^;]*;`,
      'g',
    );
    const entries = [...raw.slice(closingIndex + 1).matchAll(entriesRe)];
    const reachesOutputSink = entries.some((entry) => {
      const derivedVariable = entry[1];
      const entriesStart = closingIndex + 1 + (entry.index ?? 0);
      const entriesEnd = entriesStart + entry[0].length;
      return sinkRanges.some(({ start, end }) => {
        if (start < entriesEnd) return false;
        return new RegExp(`\\b${derivedVariable.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\b`).test(raw.slice(start, end));
      });
    });
    if (!reachesOutputSink) continue;
    const body = raw.slice(openingIndex + 1, closingIndex);
    for (const entry of body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/gm)) keys.add(entry[1]);
  }
  return keys;
}

function outputKeysFromSource(source) {
  const raw = String(source || '');
  if (!/\$GITHUB_OUTPUT\b|\$\{GITHUB_OUTPUT\b|(?:process|env)\.GITHUB_OUTPUT\b|appendActionsFile\s*\(\s*["']GITHUB_OUTPUT["']/.test(raw)) return new Set();
  const keys = new Set([...raw.matchAll(OUTPUT_RE)].map((match) => match[1]));
  for (const match of raw.matchAll(OUTPUT_HELPER_CALL_RE)) keys.add(match[1]);
  for (const match of raw.matchAll(OUTPUT_HELPER_SHELL_RE)) keys.add(match[1]);
  for (const match of raw.matchAll(OUTPUT_ACTIONS_FILE_RE)) keys.add(match[1]);
  const sinkRanges = outputSinkRanges(raw);
  for (const key of literalOutputKeys(raw, sinkRanges)) keys.add(key);
  for (const key of objectEntryOutputKeys(raw, sinkRanges)) keys.add(key);

  // A workflow commonly delegates its output writer to a first-party script.
  // Follow only a statically-known output file (the literal env expression or
  // a variable assigned from it) and only literal output prefixes. This keeps
  // the audit conservative: dynamic keys remain unknown and still warn.
  for (const { start, end } of sinkRanges) {
    const sink = raw.slice(start, end);
    const firstLiteralKey = sink.match(/(?:[`'\"])([A-Za-z_][A-Za-z0-9_-]*)(?:=|<<)/);
    if (firstLiteralKey) keys.add(firstLiteralKey[1]);
  }
  return keys;
}

function stepOutputKeys(run, {
  root = ROOT,
  workingRoot = root,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  followReferences = true,
} = {}) {
  const source = String(run || '');
  const keys = outputKeysFromSource(source);
  if (!followReferences || workingRoot === null) return keys;
  const visited = new Set();
  const visit = (absolute, depth) => {
    if (depth > 4 || visited.size >= MAX_OUTPUT_REFERENCE_FILES || visited.has(absolute) || !exists(absolute)) return;
    visited.add(absolute);
    let delegated;
    try {
      delegated = readFile(absolute, 'utf8');
    } catch {
      // A runtime checkout or a permission failure is not proof of an output
      // contract. Leave the key unknown so the existing warning is retained.
      return;
    }
    const delegatedKeys = outputKeysFromSource(delegated);
    for (const key of delegatedKeys) keys.add(key);
    // Once a delegated writer exposes literal keys, traversing all of its
    // dependencies adds cost without making the contract more certain. Keep
    // following only when the current file is itself an output-aware wrapper.
    if (delegatedKeys.size > 0) return;
    for (const candidate of extractInvokedCommandPaths(delegated)) {
      const commandPath = path.resolve(workingRoot, candidate);
      if (exists(commandPath)) visit(commandPath, depth + 1);
    }
    for (const candidate of extractScriptDirCommands(delegated)) {
      const commandPath = path.resolve(path.dirname(absolute), candidate);
      if (exists(commandPath)) visit(commandPath, depth + 1);
    }
    for (const candidate of extractLocalModulePaths(delegated)) {
      const modulePath = path.resolve(path.dirname(absolute), candidate);
      if (exists(modulePath)) visit(modulePath, depth + 1);
    }
  };
  for (const candidate of extractCommandPaths(source)) visit(path.resolve(workingRoot, candidate), 0);
  return keys;
}

function expressionIsInComment(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset) + 1;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let i = lineStart; i < offset; i += 1) {
    const char = source[i];
    if (doubleQuoted && char === '\\') {
      i += 1;
      continue;
    }
    if (!doubleQuoted && char === "'") {
      if (singleQuoted && source[i + 1] === "'") i += 1;
      else singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === '#') {
      const previous = i === lineStart ? '' : source[i - 1];
      if (previous === '' || /\s/u.test(previous) || ';|&(){}<>'.includes(previous)) return true;
    }
  }
  return false;
}

function expressions(source) {
  const raw = String(source || '');
  return [...raw.matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
    // The audit receives the raw YAML source for workflow-level input checks,
    // and also receives multiline `run:` strings for job checks. An expression
    // in a full-line YAML/shell comment is documentation, not an evaluated
    // Actions expression; treating it as live creates a false error (for
    // example a deliberately unsafe `${{ inputs.x }}` shown in a guard comment).
    .filter((match) => !expressionIsInComment(raw, match.index ?? 0))
    .map((match) => ({
      text: match[1],
      offset: match.index ?? 0,
    }));
}

function validateInputs(triggers, file, source, findings) {
  const inputNames = inputDefinitions(triggers);
  for (const triggerName of ['workflow_dispatch', 'workflow_call']) {
    const body = triggers[triggerName];
    if (!isRecord(body) || body.inputs === undefined) continue;
    if (!isRecord(body.inputs)) {
      findings.push(finding(file, 'workflow.inputs-shape', 'error', `${triggerName}.inputs deve essere una mappa`, lineFor(source, `${triggerName}:`)));
      continue;
    }
    for (const [name, spec] of Object.entries(body.inputs)) {
      if (!isRecord(spec)) {
        findings.push(finding(file, 'workflow.input-definition', 'error', `${triggerName}.inputs.${name} deve essere una mappa`, lineFor(source, name)));
        continue;
      }
      if (spec.type !== undefined && !INPUT_TYPES.has(String(spec.type))) {
        findings.push(finding(file, 'workflow.input-type', 'error', `${triggerName}.inputs.${name} ha type non supportato: ${String(spec.type)}`, lineFor(source, name)));
      }
      if (spec.required !== undefined && typeof spec.required !== 'boolean') {
        findings.push(finding(file, 'workflow.input-required', 'error', `${triggerName}.inputs.${name}.required deve essere boolean`, lineFor(source, name)));
      }
      if (spec.type === 'choice' && (!Array.isArray(spec.options) || spec.options.length === 0)) {
        findings.push(finding(file, 'workflow.choice-options', 'error', `${triggerName}.inputs.${name} di tipo choice senza options`, lineFor(source, name)));
      }
    }
  }

  for (const expression of expressions(source)) {
    const line = lineFor(source, source.slice(expression.offset));
    for (const match of expression.text.matchAll(/\b(?:github\.event\.)?inputs\.([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
      if (!inputNames.has(match[1])) {
        findings.push(finding(file, 'workflow.input-reference', 'error', `input non dichiarato usato nell'espressione: ${match[1]}`, line, expression.text.trim()));
      }
    }
  }
  return inputNames;
}

function validatePermissions(workflow, file, source, findings) {
  const permissions = workflow.permissions;
  const locations = [];
  if (permissions !== undefined) locations.push(['workflow', permissions]);
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    if (isRecord(job) && job.permissions !== undefined) locations.push([`job ${jobName}`, job.permissions]);
  }
  for (const [scope, value] of locations) {
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) {
      if (!PERMISSION_KEYS.has(key)) {
        findings.push(finding(file, 'workflow.permission-key', 'error', `permission sconosciuto in ${scope}: ${key}`, lineFor(source, key)));
      }
    }
  }
  const writes = /\b(?:git\s+(?:commit|push)|gh\s+(?:issue|pr)\s+(?:create|comment|edit|close|reopen|merge)|firebase\s+deploy)\b/i.test(source);
  if (writes && locations.length === 0) {
    findings.push(finding(file, 'workflow.permissions-missing', 'warning', 'il workflow scrive su GitHub/produzione ma non dichiara permissions; verificare il least privilege e il motivo del write', 1));
  }
}

function validateTriggers(triggers, knownWorkflowNames, file, source, findings) {
  if (Object.keys(triggers).length === 0) {
    findings.push(finding(file, 'workflow.trigger-missing', 'error', 'workflow senza trigger `on` valido', lineFor(source, 'on:')));
  }
  if (Object.prototype.hasOwnProperty.call(triggers, 'schedule')) {
    if (!Array.isArray(triggers.schedule) || triggers.schedule.length === 0) {
      findings.push(finding(file, 'workflow.schedule-shape', 'error', 'on.schedule deve contenere almeno una voce', lineFor(source, 'schedule:')));
    } else {
      triggers.schedule.forEach((entry, index) => {
        const cron = isRecord(entry) ? entry.cron : null;
        const error = cronError(cron);
        if (error) findings.push(finding(file, 'workflow.cron', 'error', `schedule #${index + 1}: ${error}`, lineFor(source, 'cron:')));
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(triggers, 'workflow_run')) {
    const body = triggers.workflow_run;
    if (isRecord(body)) {
      const types = body.types;
      if (types !== undefined) {
        if (!Array.isArray(types) || types.some((type) => !WORKFLOW_RUN_TYPES.has(String(type)))) {
          findings.push(finding(file, 'workflow.workflow-run-type', 'error', 'workflow_run.types contiene un tipo non supportato', lineFor(source, 'types:')));
        }
      }
      if (Array.isArray(body.workflows) && knownWorkflowNames.size > 0) {
        for (const target of body.workflows) {
          if (!knownWorkflowNames.has(String(target))) {
            findings.push(finding(file, 'workflow.workflow-run-target', 'warning', `workflow_run.workflows non corrisponde a nessun name noto: ${String(target)}`, lineFor(source, String(target))));
          }
        }
      }
    }
  }
}

function walkStringValues(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkStringValues(item, visit));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => walkStringValues(item, visit));
  }
}

function normalizeNeeds(rawNeeds) {
  if (typeof rawNeeds === 'string') return new Set([rawNeeds]);
  if (Array.isArray(rawNeeds)) return new Set(rawNeeds.map((item) => String(item)));
  return new Set();
}

function validateExpressionText(source, file, text, {
  jobName,
  jobNames,
  inputNames,
  stepIds,
  stepOutputMap,
  declaredNeeds,
  jobOutputMap,
  workflowCallSecrets,
}, findings) {
  for (const expression of expressions(text)) {
    const expressionText = expression.text.trim();
    const line = lineFor(source, expressionText || text);
    for (const match of expression.text.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)\.(?:outputs\.([A-Za-z_][A-Za-z0-9_-]*)|(?:outcome|conclusion))\b/g)) {
      const stepId = match[1];
      const outputKey = match[2];
      if (!stepIds.has(stepId)) {
        findings.push(finding(file, 'workflow.step-reference', 'error', `step non dichiarato usato nell'espressione: ${stepId}`, line, expressionText));
      } else if (outputKey) {
        const outputInfo = stepOutputMap.get(stepId);
        if (outputInfo?.known && !outputInfo.keys.has(outputKey)) {
          findings.push(finding(file, 'workflow.output-not-produced', 'warning', `l'output ${stepId}.${outputKey} è referenziato ma non è prodotto dal run staticamente osservabile`, line, expressionText));
        }
      }
    }
    for (const match of expression.text.matchAll(/\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.outputs\.([A-Za-z_][A-Za-z0-9_-]*))?\b/g)) {
      const dependency = match[1];
      const outputKey = match[2];
      if (!jobNames.has(dependency)) {
        findings.push(finding(file, 'workflow.needs-reference', 'error', `job non dichiarato usato nell'espressione: ${dependency}`, line, expressionText));
        continue;
      }
      if (!declaredNeeds.has(dependency)) {
        findings.push(finding(file, 'workflow.needs-reference', 'error', `job ${dependency} usato nell'espressione del job ${jobName} ma non dichiarato in needs`, line, expressionText));
      }
      if (outputKey && declaredNeeds.has(dependency)) {
        const outputKeys = jobOutputMap.get(dependency) || new Set();
        if (!outputKeys.has(outputKey)) {
          findings.push(finding(file, 'workflow.needs-output-reference', 'error', `output del job ${dependency} non dichiarato: ${outputKey}`, line, expressionText));
        }
      }
    }
    for (const match of expression.text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
      if (match[1] === 'GITHUB_TOKEN') continue;
      // Repository secrets non sono enumerabili staticamente. La verifica è
      // fail-closed solo per reusable workflows, dove la dichiarazione è parte
      // del contratto e una secret assente rende il chiamante invalido.
      if (workflowCallSecrets && !workflowCallSecrets.has(match[1])) {
        findings.push(finding(file, 'workflow.secret-reference', 'error', `secret non dichiarata in workflow_call: ${match[1]}`, line, expressionText));
      }
    }
    for (const match of expression.text.matchAll(/\b(?:github\.event\.)?inputs\.([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
      if (!inputNames.has(match[1])) {
        findings.push(finding(file, 'workflow.input-reference', 'error', `input non dichiarato usato nell'espressione: ${match[1]}`, line, expressionText));
      }
    }
  }
}

function validateJobExpressions(source, file, context, findings, workflowCallSecrets = null) {
  walkStringValues(context.job, (text) => validateExpressionText(source, file, text, {
    ...context,
    workflowCallSecrets,
  }, findings));
}

function validateWorkflowLevel(workflow, file, source, findings) {
  if (!isRecord(workflow)) {
    findings.push(finding(file, 'workflow.document-shape', 'error', 'documento workflow non rappresentato da una mappa', 1));
    return;
  }
  if (typeof workflow.name !== 'string' || workflow.name.trim() === '') {
    findings.push(finding(file, 'workflow.name', 'warning', 'workflow senza name leggibile', lineFor(source, 'name:')));
  }
  if (!isRecord(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    findings.push(finding(file, 'workflow.jobs', 'error', 'workflow senza jobs eseguibili', lineFor(source, 'jobs:')));
  }
  if (isRecord(workflow.concurrency)) {
    for (const key of Object.keys(workflow.concurrency)) {
      if (!['group', 'cancel-in-progress', 'queue'].includes(key)) {
        findings.push(finding(file, 'workflow.concurrency-key', 'error', `chiave concurrency non supportata: ${key}`, lineFor(source, key)));
      }
    }
    if (Object.hasOwn(workflow.concurrency, 'queue')
      && !['single', 'max'].includes(workflow.concurrency.queue)) {
      findings.push(finding(
        file,
        'workflow.concurrency-value',
        'error',
        `valore concurrency.queue non supportato: ${String(workflow.concurrency.queue)}`,
        lineFor(source, 'queue:'),
      ));
    }
  }
}

function validateJobs(workflow, file, source, root, exists, readFile, knownWorkflowNames, findings, reusableWorkflowOutputs) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const jobNames = new Set(Object.keys(jobs));
  const inputNames = inputDefinitions(normalizeTriggers(workflow.on));
  const jobContexts = new Map();
  const jobOutputMap = new Map();
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = isRecord(rawJob) ? rawJob : {};
    const idsForJob = new Set();
    const outputsForJob = new Map();
    const reusable = typeof job.uses === 'string';
    const localReusable = reusable ? localReusableWorkflowPath(job.uses) : null;
    jobOutputMap.set(jobName, isRecord(job.outputs)
      ? new Set(Object.keys(job.outputs))
      : localReusable && reusableWorkflowOutputs.has(localReusable)
        ? reusableWorkflowOutputs.get(localReusable)
        : new Set());
    jobContexts.set(jobName, {
      jobName,
      job,
      stepIds: idsForJob,
      stepOutputMap: outputsForJob,
      declaredNeeds: normalizeNeeds(job.needs),
    });
    if (typeof job.needs === 'string') {
      if (!jobNames.has(job.needs)) findings.push(finding(file, 'workflow.needs-reference', 'error', `job ${jobName} dipende da job inesistente: ${job.needs}`, lineFor(source, job.needs)));
    } else if (Array.isArray(job.needs)) {
      for (const dependency of job.needs) {
        if (!jobNames.has(String(dependency))) findings.push(finding(file, 'workflow.needs-reference', 'error', `job ${jobName} dipende da job inesistente: ${String(dependency)}`, lineFor(source, String(dependency))));
      }
    } else if (job.needs !== undefined) {
      findings.push(finding(file, 'workflow.needs-shape', 'error', `needs del job ${jobName} deve essere stringa o array`, lineFor(source, 'needs:')));
    }

    if (!reusable && job['runs-on'] === undefined) {
      findings.push(finding(file, 'workflow.runs-on', 'error', `job ${jobName} senza runs-on`, lineFor(source, `${jobName}:`)));
    }
    if (reusable && typeof job.uses === 'string' && job.uses.startsWith('./')) {
      const local = job.uses.split('@', 1)[0];
      if (!localReferenceExists(root, local, '.', exists)) findings.push(finding(file, 'workflow.local-reusable-workflow', 'error', `reusable workflow locale non trovato: ${local}`, lineFor(source, local)));
    }
    if (reusable) {
      if (job.steps !== undefined) findings.push(finding(file, 'workflow.reusable-job-steps', 'error', `job ${jobName} usa un reusable workflow e non può avere steps`, lineFor(source, 'steps:')));
      continue;
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      findings.push(finding(file, 'workflow.steps', 'error', `job ${jobName} senza steps`, lineFor(source, `${jobName}:`)));
      continue;
    }
    const checkoutPaths = new Set();

    job.steps.forEach((rawStep, index) => {
      const stepLine = lineFor(source, typeof rawStep?.name === 'string' ? rawStep.name : '- name:');
      if (!isRecord(rawStep)) {
        findings.push(finding(file, 'workflow.step-shape', 'error', `step ${jobName}#${index + 1} non è una mappa`, stepLine));
        return;
      }
      const keys = Object.keys(rawStep);
      const hasRun = typeof rawStep.run === 'string';
      const hasUses = typeof rawStep.uses === 'string';
      const checkoutPath = hasUses ? checkoutPathFromStep(rawStep) : null;
      if (checkoutPath) checkoutPaths.add(checkoutPath);
      for (const unsupportedKey of ['background', 'wait-all']) {
        if (Object.prototype.hasOwnProperty.call(rawStep, unsupportedKey)) {
          findings.push(finding(
            file,
            'workflow.unsupported-step-key',
            'error',
            `chiave step non supportata da GitHub Actions: ${unsupportedKey}`,
            stepLine,
          ));
        }
      }
      if (hasRun === hasUses) findings.push(finding(file, 'workflow.step-executor', 'error', `step ${jobName}#${index + 1} deve avere esattamente uno tra run e uses`, stepLine));
      if (hasUses && rawStep.uses.startsWith('./') && !localReferenceExists(root, rawStep.uses, '.', exists)) {
        findings.push(finding(file, 'workflow.local-action', 'error', `local action non trovata: ${rawStep.uses}`, stepLine));
      }
      let outputKeys = new Set();
      if (hasRun) {
        const workingRoot = staticWorkingDirectory(root, rawStep['working-directory']);
        const dynamicDirectory = workingRoot === null
          || /\b(?:cd|pushd)\s+["']?\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:\})?|\bgit\s+clone\b/i.test(rawStep.run);
        const runtimeCheckout = checkoutPathForWorkingDirectory(root, workingRoot, checkoutPaths);
        outputKeys = stepOutputKeys(rawStep.run, {
          root,
          workingRoot,
          exists,
          readFile,
          followReferences: !dynamicDirectory && !runtimeCheckout,
        });
        const runtimeFileAssertions = extractFileExistenceAssertions(rawStep.run);
        const invokedCommandReferences = extractInvokedCommandReferences(rawStep.run);
        for (const candidate of extractCommandPaths(rawStep.run)) {
          const inWorkingDirectory = workingRoot !== null && exists(path.resolve(workingRoot, candidate));
          const invocations = invokedCommandReferences.filter((reference) => reference.path === candidate);
          const assertions = runtimeFileAssertions.get(candidate) || [];
          const verifiedAtRuntime = assertions.length > 0
            && (invocations.length === 0 || invocations.every((invocation) => assertions.some((assertion) => {
              if (assertion.index >= invocation.index) return false;
              return assertion.scope === null
                || (invocation.index > assertion.scope.start && invocation.index < assertion.scope.end);
            })));
          if (!inWorkingDirectory && !verifiedAtRuntime) {
            const runtimeOnly = dynamicDirectory || runtimeCheckout;
            findings.push(finding(
              file,
              'workflow.script-reference',
              runtimeOnly ? 'warning' : 'error',
              runtimeOnly
                ? runtimeCheckout
                  ? `script referenziato in una directory popolata da actions/checkout (${runtimeCheckout}), non verificabile dal checkout statico: ${candidate}`
                  : `script referenziato in una directory dinamica, non verificabile dal checkout statico: ${candidate}`
                : `script referenziato ma non trovato: ${candidate}`,
              stepLine,
              rawStep.run.trim().slice(0, 300),
            ));
          }
        }
        const operationalRun = shellOperationalText(rawStep.run, { preserveQuotedWritePaths: true });
        const operationalDataPaths = extractDataPaths(operationalRun);
        const dataPaths = operationalDataPaths;
        const writesData = /\bgit\s+(?:add|commit)\b|(?:>>|>)\s*(?:\\\r?\n\s*)*["']?(?:data|public\/data)\//i.test(operationalRun);
        const hasValidation = /\b(?:validat(?:e|ion)|audit|check|assert|test|strict|quality|schema|diff)\b/i.test(operationalRun);
        if (writesData && dataPaths.length > 0 && !hasValidation) {
          for (const dataPath of dataPaths) findings.push(finding(file, 'workflow.data-write-without-check', 'warning', `scrittura di ${dataPath} senza validazione visibile nello step; verificare completezza/timestamp/schema prima del commit`, stepLine, rawStep.run.trim().slice(0, 300)));
        }
      }

      if (rawStep.id !== undefined) {
        if (typeof rawStep.id !== 'string' || !STEP_ID_RE.test(rawStep.id)) {
          findings.push(finding(file, 'workflow.step-id', 'error', `step id non valido: ${String(rawStep.id)}`, stepLine));
        } else if (idsForJob.has(rawStep.id)) {
          findings.push(finding(file, 'workflow.duplicate-step-id', 'error', `step id duplicato nel job ${jobName}: ${rawStep.id}`, stepLine));
        } else {
          idsForJob.add(rawStep.id);
          outputsForJob.set(rawStep.id, hasRun
            ? { keys: outputKeys, known: true }
            : { keys: new Set(), known: false });
        }
      }
    });
  }

  const workflowCall = normalizeTriggers(workflow.on).workflow_call;
  const callSecrets = isRecord(workflowCall) ? workflowCall.secrets : null;
  // Repository secrets are intentionally not enumerable. Only a reusable
  // workflow's explicit `workflow_call.secrets` contract is statically
  // checkable; `secrets: inherit` delegates the contract to the caller.
  const workflowCallSecrets = isRecord(callSecrets) ? new Set(Object.keys(callSecrets)) : null;
  for (const context of jobContexts.values()) {
    validateJobExpressions(source, file, {
      ...context,
      jobNames,
      inputNames,
      jobOutputMap,
    }, findings, workflowCallSecrets);
  }
  void knownWorkflowNames;
}

export function auditWorkflowText(file, source, {
  root = ROOT,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
  knownWorkflowNames = new Set(),
  reusableWorkflowOutputs = new Map(),
} = {}) {
  const findings = [];
  let document;
  try {
    document = parseDocument(String(source || ''), { prettyErrors: true });
  } catch (error) {
    findings.push(finding(file, 'yaml.parse', 'error', `YAML non parsabile: ${error.message}`, 1));
    return findings;
  }
  for (const warning of document.warnings || []) {
    findings.push(finding(file, 'yaml.warning', 'warning', warning.message, warning.linePos?.[0]?.line || 1));
  }
  if (document.errors?.length > 0) {
    for (const error of document.errors) findings.push(finding(file, 'yaml.parse', 'error', error.message, error.linePos?.[0]?.line || 1));
    return dedupeFindings(findings);
  }
  const workflow = document.toJS({ mapAsMap: false });
  validateWorkflowLevel(workflow, file, source, findings);
  if (!isRecord(workflow)) return dedupeFindings(findings);
  const triggers = normalizeTriggers(workflow.on);
  validateTriggers(triggers, knownWorkflowNames, file, source, findings);
  const inputNames = validateInputs(triggers, file, source, findings);
  validatePermissions(workflow, file, source, findings);
  validateJobs(workflow, file, source, root, exists, readFile, knownWorkflowNames, findings, reusableWorkflowOutputs);
  void inputNames;
  return dedupeFindings(findings);
}

export function auditWorkflowFiles(root = ROOT) {
  const files = workflowFiles(root);
  const contents = new Map();
  const names = new Set();
  const reusableWorkflowOutputs = new Map();
  const parseFindings = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const source = fs.readFileSync(absolute, 'utf8');
    contents.set(file, source);
    try {
      const document = parseDocument(source, { prettyErrors: true });
      if ((document.errors || []).length === 0) {
        const workflow = document.toJS({ mapAsMap: false });
        if (isRecord(workflow)) {
          if (typeof workflow.name === 'string' && workflow.name.trim()) names.add(workflow.name.trim());
          const workflowCall = normalizeTriggers(workflow.on).workflow_call;
          if (isRecord(workflowCall) && isRecord(workflowCall.outputs)) {
            reusableWorkflowOutputs.set(file, new Set(Object.keys(workflowCall.outputs)));
          }
        }
      }
    } catch (error) {
      parseFindings.push(finding(file, 'yaml.parse', 'error', `YAML non parsabile: ${error.message}`, 1));
    }
  }
  const findings = [...parseFindings];
  for (const [file, source] of contents) {
    findings.push(...auditWorkflowText(file, source, {
      root,
      knownWorkflowNames: names,
      reusableWorkflowOutputs,
    }));
  }
  return {
    generatedAt: new Date().toISOString(),
    commit: currentCommit(root),
    filesScanned: files.length,
    // The recorder uses this independently enumerated inventory to avoid
    // promoting a report that merely claims a clean file count to a measured
    // L11 outcome.
    workflowFiles: [...files],
    workflowNames: [...names].sort(),
    findings: dedupeFindings(findings).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)),
  };
}

function currentCommit(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function summarize(report) {
  const summary = { error: 0, warning: 0, info: 0, total: report.findings.length };
  for (const item of report.findings) summary[item.severity] = (summary[item.severity] || 0) + 1;
  return summary;
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeIsoTimestamp(value) {
  const timestamp = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function addHoursOrNull(startAt, hours) {
  const startMs = Date.parse(startAt || '');
  return Number.isFinite(startMs) && Number.isInteger(hours) && hours > 0
    ? new Date(startMs + hours * HOUR_MS).toISOString()
    : null;
}

/**
 * Metadata duraturi per un avviso L11.
 *
 * L'owner resta il ruolo dichiarato dal registry, mai una persona scelta dal
 * runner. Le deadline partono dal timestamp del report: la deadline owner è
 * lo SLA di presa in carico, mentre expiresAt è il TTL del candidato. Il
 * prossimo riesame è la deadline dello SLA owner, che per L11 coincide con la
 * cadenza giornaliera dichiarata.
 *
 * Se policy o timestamp non sono osservabili, il risultato è esplicitamente
 * `unmeasurable` e non sostituisce i valori mancanti con default locali.
 */
export function buildL11OperationalMetadata({
  policy = null,
  generatedAt = null,
  registryPath = L11_REGISTRY_PATH,
  reason = null,
} = {}) {
  const isL11Policy = policy?.loopId === L11_LOOP_ID;
  const lifecycle = isL11Policy && policy.lifecycle && typeof policy.lifecycle === 'object'
    ? policy.lifecycle
    : {};
  const owner = isL11Policy && typeof policy.owner === 'string' && policy.owner.trim()
    ? policy.owner.trim()
    : null;
  const cadence = isL11Policy && typeof policy.cadence === 'string' && policy.cadence.trim()
    ? policy.cadence.trim()
    : null;
  const observedAt = normalizeIsoTimestamp(generatedAt);
  const candidateTtlHours = positiveIntegerOrNull(lifecycle.candidateTtlHours);
  const ownerSlaHours = positiveIntegerOrNull(lifecycle.ownerSlaHours);
  const postMergeVerificationHours = positiveIntegerOrNull(lifecycle.postMergeVerificationHours);
  const actionPolicy = {
    healthy: isL11Policy && typeof policy.actionPolicy?.healthy === 'string'
      && policy.actionPolicy.healthy.trim() ? policy.actionPolicy.healthy.trim() : null,
    needsReview: isL11Policy && typeof policy.actionPolicy?.needsReview === 'string'
      && policy.actionPolicy.needsReview.trim() ? policy.actionPolicy.needsReview.trim() : null,
  };
  const deadlineAt = addHoursOrNull(observedAt, ownerSlaHours);
  const expiresAt = addHoursOrNull(observedAt, candidateTtlHours);
  const complete = Boolean(
    observedAt
      && owner
      && cadence
      && candidateTtlHours
      && ownerSlaHours
      && postMergeVerificationHours
      && deadlineAt
      && expiresAt
      && actionPolicy.healthy
      && actionPolicy.needsReview,
  );

  return {
    schemaVersion: L11_METADATA_SCHEMA_VERSION,
    loopId: L11_LOOP_ID,
    status: complete ? 'available' : 'unmeasurable',
    owner,
    ownerType: owner ? 'registry-role' : null,
    registryPath,
    generatedAt: observedAt,
    cadence,
    lifecycle: {
      candidateTtlHours,
      ownerSlaHours,
      postMergeVerificationHours,
    },
    // Keep the lifecycle limits flat as well: existing status consumers expose
    // these names and older readers can ignore this additive metadata block.
    candidateTtlHours,
    ownerSlaHours,
    postMergeVerificationHours,
    actionPolicy,
    deadlineAt,
    expiresAt,
    nextReviewAt: deadlineAt,
    ...(reason ? { reason } : {}),
  };
}

/** Missing L11 lifecycle policy is an audit error, not an ordinary warning. */
export function l11OperationalMetadataFinding(metadata, registryPath = L11_REGISTRY_PATH) {
  if (metadata?.status === 'available') return null;
  return finding(
    registryPath,
    'loop-registry.l11-operational-metadata',
    'error',
    'L11 operational metadata is unavailable; owner, TTL and SLA cannot be verified',
    1,
    metadata?.reason || 'metadata status is not available',
  );
}

/** Read the validated L11 policy without weakening the audit on bad input. */
export function loadL11OperationalMetadata({
  root = ROOT,
  generatedAt = null,
  registryPath = L11_REGISTRY_PATH,
} = {}) {
  try {
    const { policy } = loadLoopPolicy(path.resolve(root, registryPath), L11_LOOP_ID);
    return buildL11OperationalMetadata({ policy, generatedAt, registryPath });
  } catch (error) {
    return buildL11OperationalMetadata({
      generatedAt,
      registryPath,
      reason: `L11 registry metadata unavailable: ${error?.message || String(error)}`,
    });
  }
}

/**
 * Keep the L11 issue route proportional to the evidence actually observed.
 *
 * Errors are deterministic defects that the bounded issue-fix path may inspect
 * and propose through a PR. Warnings are intentionally ambiguous signals: they
 * remain visible and durable, but must not consume fixer quota or be presented
 * as an approved remediation candidate. The separate review label also makes a
 * warning-only recurrence distinguishable from a fixable one without using the
 * `needs-human` label, which has its own rescue/sweep semantics. A missing or
 * malformed registry action policy is review-only too: routing cannot be
 * inferred from the finding count alone.
 */
export function auditIssueRouting(summary, metadata) {
  const provenError = Number(summary?.error || 0) > 0;
  const reviewAction = metadata?.status === 'available' && metadata.actionPolicy?.needsReview;
  const issueAllowed = typeof reviewAction === 'string'
    && reviewAction.split('+').map((part) => part.trim()).includes('issue');
  const canQueue = provenError && issueAllowed;
  return {
    labels: [
      'operations-audit',
      canQueue ? 'agent:fix-queued' : 'operations-audit-review',
      'agent:no-age-out',
    ],
    add: canQueue ? 'agent:fix-queued' : 'operations-audit-review',
    remove: canQueue ? 'operations-audit-review' : 'agent:fix-queued',
    route: canQueue ? 'bounded-fix-queue' : 'review-only',
  };
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function findingIdentity(item) {
  return [
    item?.file || '',
    item?.line || '',
    item?.rule || '',
    item?.severity || '',
    item?.message || '',
    item?.evidence || '',
  ].join('\u0000');
}

/**
 * Machine-readable handoff for the normal issue → triage → fixer path.
 *
 * L11 itself remains observe/report-only. `remediationPr` is deliberately
 * empty here: the fixer may later attach proof after it has actually opened a
 * PR. The IDs make that proof correlate to this candidate and observation,
 * while a missing registry/TTL keeps the contract ineligible fail-closed.
 */
export function buildL11IssueContract({
  report = {},
  metadata = null,
  routing = null,
  repository = process.env.GITHUB_REPOSITORY || process.env.GH_REPO || null,
  runId = process.env.GITHUB_RUN_ID || null,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT || null,
} = {}) {
  const findings = Array.isArray(report.findings)
    ? report.findings.map(findingIdentity).sort()
    : [];
  const candidateId = `lf-candidate-${shortHash(JSON.stringify({
    loopId: L11_LOOP_ID,
    registryPath: metadata?.registryPath || L11_REGISTRY_PATH,
    actionClass: metadata?.actionPolicy?.needsReview || null,
    findings,
  }))}`;
  const generatedAt = normalizeIsoTimestamp(report.generatedAt || metadata?.generatedAt);
  const sourceRecordId = `lf-source-${shortHash(JSON.stringify({
    loopId: L11_LOOP_ID,
    repository,
    workflow: 'technical-operations-supervisor',
    runId,
    runAttempt,
    commit: report.commit || null,
    generatedAt,
  }))}`;
  const candidateTtlHours = positiveIntegerOrNull(metadata?.candidateTtlHours);
  const expiresAt = normalizeIsoTimestamp(metadata?.expiresAt);
  return {
    schemaVersion: L11_ISSUE_CONTRACT_SCHEMA_VERSION,
    loopId: L11_LOOP_ID,
    mode: 'observe-report-only',
    candidateId,
    sourceRecordId,
    sourceCommit: report.commit || null,
    registryPath: metadata?.registryPath || null,
    generatedAt,
    candidateTtlHours,
    expiresAt,
    ttl: { hours: candidateTtlHours, expiresAt },
    actionClass: metadata?.actionPolicy?.needsReview || null,
    route: routing?.route || 'review-only',
    remediationPrProofRequired: true,
    remediationPr: null,
  };
}

export function renderL11IssueContract(contract) {
  return `${L11_ISSUE_CONTRACT_MARKER} ${JSON.stringify(contract)} -->`;
}

/** Keep the latest contract in the issue body, including deduplicated recurrences. */
function syncAuditIssueContract(issueNumber, contract, fallbackBody) {
  if (!issueNumber) return;
  const marker = renderL11IssueContract(contract);
  try {
    const currentJson = execFileSync('gh', [
      'issue', 'view', String(issueNumber), '--json', 'body',
      ...(process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : []),
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const current = JSON.parse(currentJson).body || '';
    const body = L11_ISSUE_CONTRACT_RE.test(current)
      ? current.replace(L11_ISSUE_CONTRACT_RE, marker)
      : [marker, current || fallbackBody || '_no details provided_'].filter(Boolean).join('\n\n');
    const boundedBody = body.length > MAX_ISSUE_BODY_LENGTH
      ? `${body.slice(0, MAX_ISSUE_BODY_LENGTH - 30)}\n\n...(truncated)`
      : body;
    execFileSync('gh', [
      'issue', 'edit', String(issueNumber), '--body', boundedBody,
      ...(process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : []),
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    console.log(`Issue audit #${issueNumber}: contratto L11 aggiornato nel body`);
  } catch (error) {
    // The issue/comment remains durable even if this reconciliation is
    // temporarily unavailable. The next audit recurrence retries it; triage
    // must not infer eligibility from a missing body marker.
    console.error(`Impossibile sincronizzare il contratto L11 dell'issue #${issueNumber}: ${error.message}`);
  }
}

/**
 * Synchronise routing labels on both a newly-created issue and a deduplicated
 * recurrence. `createGithubIssue` applies labels on creation, but intentionally
 * does not mutate arbitrary labels on an existing twin; without this explicit
 * reconciliation, a warning-only tracker could remain stuck in `agent:fix-queued`
 * forever after the audit became warning-only.
 */
function syncAuditIssueRouting(issueNumber, summary, metadata) {
  if (!issueNumber) return;
  const routing = auditIssueRouting(summary, metadata);
  try {
    // Deduplicated issues return before createGithubIssue's normal label
    // provisioning path. Provision the target label here too, otherwise the
    // first warning-only recurrence can fail to leave the durable review route.
    ensureLabelsExist([routing.add]);
    execFileSync('gh', [
      'issue', 'edit', String(issueNumber),
      '--add-label', routing.add,
      '--remove-label', routing.remove,
      ...(process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : []),
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    console.log(`Issue audit #${issueNumber}: routing=${routing.route}`);
  } catch (error) {
    // The issue itself is already persisted by createGithubIssue. A label-sync
    // failure must stay visible, but must not turn a successful evidence write
    // into a false audit failure; the next recurrence retries idempotently.
    console.error(`Impossibile sincronizzare il routing dell'issue audit #${issueNumber}: ${error.message}`);
  }
}

function compactFindings(findings) {
  const groups = new Map();
  for (const item of findings) {
    const key = [item.file, item.rule, item.severity, item.message].join('\u0000');
    const group = groups.get(key) || { ...item, lines: [] };
    if (!group.lines.includes(item.line)) group.lines.push(item.line);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    message: group.lines.length > 1
      ? `${group.message} (${group.lines.length} occorrenze; linee ${group.lines.slice(0, 8).join(', ')}${group.lines.length > 8 ? ', …' : ''})`
      : group.message,
  }));
}

export function renderMarkdown(report, { maxFindings = 240, compact = true } = {}) {
  const summary = summarize(report);
  const lines = [
    '## Technical operations audit',
    '',
    `- Workflow scansionati: **${report.filesScanned}**`,
    `- Binding registry flotta: **${report.registry?.loopsScanned ?? 'n/d'} loop**`,
    `- Errori: **${summary.error}** · warning: **${summary.warning}** · totale: **${summary.total}**`,
    `- Commit osservato: \`${report.commit || 'sconosciuto'}\``,
    `- Generato: ${report.generatedAt}`,
    '',
  ];
  if (report.operationalMetadata) {
    lines.push(
      '### Metadata operativi L11',
      '',
      '```json',
      JSON.stringify(report.operationalMetadata, null, 2),
      '```',
      '',
    );
  }
  const visibleFindings = compact ? compactFindings(report.findings) : report.findings;
  const selected = visibleFindings.slice(0, maxFindings);
  for (const item of selected) {
    const icon = item.severity === 'error' ? '🔴' : item.severity === 'warning' ? '🟡' : '🔵';
    lines.push(`${icon} \`${item.file}:${item.line}\` **${item.rule}** — ${item.message}`);
    if (item.evidence) lines.push(`  - prova: \`${String(item.evidence).replace(/`/g, "'")}\``);
  }
  if (visibleFindings.length > maxFindings) lines.push(`\n… altre ${visibleFindings.length - maxFindings} classi di finding nell'artifact JSON (${report.findings.length} finding completi).`);
  if (report.findings.length === 0) lines.push('✅ Nessun finding strutturale o logico nelle regole attive.');
  return lines.join('\n');
}

function cliValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const workflowReport = auditWorkflowFiles(ROOT);
  const registryReport = auditLoopFleetBindings({ root: ROOT });
  const operationalMetadata = loadL11OperationalMetadata({
    root: ROOT,
    generatedAt: workflowReport.generatedAt,
    registryPath: registryReport.registryPath,
  });
  const operationalMetadataFinding = l11OperationalMetadataFinding(
    operationalMetadata,
    registryReport.registryPath,
  );
  const report = {
    ...workflowReport,
    registry: {
      path: registryReport.registryPath,
      loopsScanned: registryReport.loopsScanned,
      loopIds: registryReport.loopIds,
    },
    operationalMetadata,
    findings: dedupeFindings([
      ...workflowReport.findings,
      ...registryReport.findings,
      ...(operationalMetadataFinding ? [operationalMetadataFinding] : []),
    ])
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule)),
  };
  const summary = summarize(report);
  const routing = auditIssueRouting(summary, operationalMetadata);
  const issueContract = buildL11IssueContract({
    report,
    metadata: operationalMetadata,
    routing,
  });
  report.operationalMetadata = {
    ...report.operationalMetadata,
    routing: {
      route: routing.route,
      add: routing.add,
      remove: routing.remove,
    },
    issueContract,
  };
  const reportPath = cliValue(argv, '--report');
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify({ ...report, summary }, null, 2)}\n`);
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...report, summary }, null, 2));
  else console.log(renderMarkdown(report));

  let issuePersisted = false;
  if (argv.includes('--issue') && report.findings.length > 0) {
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
    const description = [
      renderL11IssueContract(issueContract),
      '',
      renderMarkdown(report),
      '',
      '### Azione del supervisore',
      '',
      '- Questo report è stato prodotto senza modificare workflow o dati.',
      `- Routing: **${routing.route}** — gli errori provati possono entrare nell’issue-fix bounded; i warning restano da confermare con una prova runtime.`,
      '- Un dato non osservabile resta `unmeasurable`, non viene trasformato in zero.',
      runUrl ? `- Run: ${runUrl}` : '',
    ].filter(Boolean).join('\n');
    try {
      const result = await createGithubIssue({
        title: DEFAULT_ISSUE_TITLE,
        description,
        priority: summary.error > 0 ? 2 : 3,
        labels: routing.labels,
        workflow: 'technical-operations-supervisor',
        signals: {
          comando: 'node scripts/ci/technical-operations-audit.mjs --issue --strict',
          evidenza: [`${report.filesScanned} workflow`, `${summary.error} errori`, `${summary.warning} warning`],
        },
      });
      issuePersisted = Boolean(result?.persisted);
      if (issuePersisted) {
        syncAuditIssueContract(result.number, issueContract, description);
        syncAuditIssueRouting(result.number, summary, operationalMetadata);
      }
      console.log(issuePersisted ? `Issue audit persistita: #${result.number || '?'}\n` : 'Issue audit non persistita.\n');
    } catch (error) {
      console.error(`Impossibile persistere l'issue audit: ${error.message}`);
    }
  }
  setOutput('files_scanned', report.filesScanned);
  setOutput('finding_count', summary.total);
  setOutput('error_count', summary.error);
  setOutput('warning_count', summary.warning);
  setOutput('issue_reported', issuePersisted ? 'true' : 'false');

  if (argv.includes('--strict') && summary.error > 0 && !issuePersisted) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 2;
});
