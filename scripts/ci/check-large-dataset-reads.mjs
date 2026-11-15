#!/usr/bin/env node
/**
 * check-large-dataset-reads.mjs — AST lint: no whole-file read + JSON.parse of
 * a dataset that outgrew V8's string limit.
 *
 * `data/jobs.json` is 539 MB, past the ~512 MiB string limit (0x1fffffe8
 * characters): `readFileSync(..., 'utf8')` followed by `JSON.parse` throws
 * ERR_STRING_TOO_LONG. Between 2026-11-12 and 2026-11-14 that lost 21 deploy
 * runs, and the readers were migrated one at a time as each blew up. This lint
 * closes the class: it fails when a `JSON.parse` argument derives from
 * `readFileSync`/`readFile` of one of
 *
 *   data/jobs.json            public/data/jobs.json
 *   data/expired-jobs.json    data/slug-registry.json
 *   data/jobs-snapshots-history/**   data/all-known-job-slugs/**
 *
 * The safe readers are `readJsonFile` / `iterateJsonArrayFile` in
 * scripts/lib/read-large-json.mjs (and the build-plugins/shared wrappers).
 *
 * How the path is recovered. The first argument of the read is resolved through
 * string/template literals, `+`, `path.join`/`resolve`, `||`/`??`/ternaries and
 * `const` initializers of the same file. A part that cannot be resolved becomes
 * `*`. A path that only ever resolves to wildcards (a bare parameter) is
 * reported as UNKNOWN, which never fails the run: the lint must not guess.
 *
 * Exceptions: a comment `large-dataset-read-ok: <reason>` on the call line or
 * the three lines above, with a non-empty reason (the file is small and certain,
 * e.g. a per-week snapshot shard). The reason is the point: it records why the
 * size limit cannot apply.
 *
 * Usage: node scripts/ci/check-large-dataset-reads.mjs [--root <dir>] [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const require = createRequire(import.meta.url);

/** Normalised (forward-slash) path suffixes that are guarded datasets. */
export const LARGE_DATASET_PATTERNS = Object.freeze([
  /(?:^|\/)data\/(?:jobs|expired-jobs|slug-registry)\.json$/,
  /(?:^|\/)data\/(?:jobs-snapshots-history|all-known-job-slugs)(?:\/|$)/,
]);

export const SCAN_ROOTS = Object.freeze([
  'scripts', 'build-plugins', 'tests', 'services', 'server', 'infra', 'functions/src',
  'vite.config.ts', 'vitest.config.ts',
]);
const SOURCE_RE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.claude']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ALTERNATIVES = 12;
const MAX_DEPTH = 8;
const OK_MARKER = /large-dataset-read-ok:[ \t]*\S/;
const READ_NAMES = new Set(['readFileSync', 'readFile']);
const PASS_THROUGH_METHODS = new Set(['toString', 'trim', 'trimStart', 'trimEnd', 'replace', 'slice', 'normalize']);
const PATH_JOIN_NAMES = new Set(['join', 'resolve', 'normalize']);

let tsModule = null;
function loadTypeScript() {
  if (!tsModule) tsModule = require('typescript');
  return tsModule;
}

function cap(list) {
  return list.length > MAX_ALTERNATIVES ? list.slice(0, MAX_ALTERNATIVES) : list;
}

function product(parts) {
  let acc = [''];
  for (const part of parts) {
    const next = [];
    for (const left of acc) for (const right of part) next.push(left + right);
    acc = cap(next);
  }
  return acc;
}

/**
 * Initializers of every `const|let|var name = init` in the file, by name, each
 * tagged with its nearest enclosing function (or the file). Lookups are scoped:
 * `raw` in one function must not be confused with an unrelated `raw` elsewhere.
 */
function collectInitializers(ts, sourceFile) {
  const map = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = map.get(node.name.text) || [];
      list.push({ init: node.initializer, scope: enclosingScope(ts, node) });
      map.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
}

function enclosingScope(ts, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
  }
  return null;
}

/** Initializers visible for `name` from `from`: those of the innermost scope that declares it. */
function lookup(ts, vars, name, from) {
  const entries = vars.get(name);
  if (!entries) return [];
  for (let scope = enclosingScope(ts, from); scope; scope = enclosingScope(ts, scope)) {
    const here = entries.filter((entry) => entry.scope === scope);
    if (here.length > 0) return here.map((entry) => entry.init);
  }
  return [];
}

function calleeName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function unwrap(ts, node) {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)
        || ts.isAsExpression(current) || ts.isAwaitExpression(current)
        || (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(current))
        || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Candidate strings for a path expression; `*` stands for any unresolved part.
 */
function resolveStrings(ts, node, vars, depth = 0, seen = new Set()) {
  if (!node || depth > MAX_DEPTH) return ['*'];
  const n = unwrap(ts, node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) {
    const parts = [[n.head.text]];
    for (const span of n.templateSpans) {
      parts.push(resolveStrings(ts, span.expression, vars, depth + 1, seen));
      parts.push([span.literal.text]);
    }
    return product(parts);
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      return product([
        resolveStrings(ts, n.left, vars, depth + 1, seen),
        resolveStrings(ts, n.right, vars, depth + 1, seen),
      ]);
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return cap([
        ...resolveStrings(ts, n.left, vars, depth + 1, seen),
        ...resolveStrings(ts, n.right, vars, depth + 1, seen),
      ]);
    }
    return ['*'];
  }
  if (ts.isConditionalExpression(n)) {
    return cap([
      ...resolveStrings(ts, n.whenTrue, vars, depth + 1, seen),
      ...resolveStrings(ts, n.whenFalse, vars, depth + 1, seen),
    ]);
  }
  if (ts.isIdentifier(n)) {
    if (seen.has(n.text)) return ['*'];
    const inits = lookup(ts, vars, n.text, n);
    if (inits.length === 0) return ['*'];
    const nextSeen = new Set(seen).add(n.text);
    return cap(inits.flatMap((init) => resolveStrings(ts, init, vars, depth + 1, nextSeen)));
  }
  if (ts.isCallExpression(n)) {
    const name = calleeName(ts, n.expression);
    if (name && PATH_JOIN_NAMES.has(name)) {
      const args = n.arguments.map((arg) => resolveStrings(ts, arg, vars, depth + 1, seen));
      if (args.length === 0) return ['*'];
      const joined = [];
      let acc = args[0];
      for (const next of args.slice(1)) {
        const merged = [];
        for (const left of acc) for (const right of next) merged.push(`${left}/${right}`);
        acc = cap(merged);
      }
      joined.push(...acc);
      return joined.map((value) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
    }
    return ['*'];
  }
  return ['*'];
}

/** Path arguments of the whole-file read(s) a value derives from. */
function readTargets(ts, node, vars, depth = 0, seen = new Set()) {
  if (!node || depth > MAX_DEPTH) return [];
  const n = unwrap(ts, node);
  if (ts.isCallExpression(n)) {
    const name = calleeName(ts, n.expression);
    if (name && READ_NAMES.has(name) && n.arguments.length > 0) return [n.arguments[0]];
    if (ts.isPropertyAccessExpression(n.expression) && PASS_THROUGH_METHODS.has(n.expression.name.text)) {
      return readTargets(ts, n.expression.expression, vars, depth + 1, seen);
    }
    if (ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments.length === 1) {
      return readTargets(ts, n.arguments[0], vars, depth + 1, seen);
    }
    return [];
  }
  if (ts.isIdentifier(n)) {
    if (seen.has(n.text)) return [];
    const nextSeen = new Set(seen).add(n.text);
    return lookup(ts, vars, n.text, n).flatMap((init) => readTargets(ts, init, vars, depth + 1, nextSeen));
  }
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [...readTargets(ts, n.left, vars, depth + 1, seen), ...readTargets(ts, n.right, vars, depth + 1, seen)];
  }
  return [];
}

function isWildcardOnly(value) {
  return /^[*/]*$/.test(value);
}

/**
 * Scan one source text.
 *
 * @returns {{violations: Array<{file: string, line: number, path: string}>, unknown: Array<{file: string, line: number, path: string}>}}
 */
export function scanSource(text, fileName = 'input.ts') {
  const result = { violations: [], unknown: [] };
  if (!text.includes('JSON.parse') || !/readFile/.test(text)) return result;
  const ts = loadTypeScript();
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX
    : /\.(?:mjs|cjs|js)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const vars = collectInitializers(ts, sourceFile);
  const lines = text.split('\n');

  const visit = (node) => {
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'parse'
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'JSON'
        && node.arguments.length > 0) {
      const { line: zeroBased } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const line = zeroBased + 1;
      const window = lines.slice(Math.max(0, zeroBased - 3), zeroBased + 1).join('\n');
      if (!OK_MARKER.test(window)) {
        for (const target of readTargets(ts, node.arguments[0], vars)) {
          const candidates = resolveStrings(ts, target, vars);
          const hit = candidates.find((value) => LARGE_DATASET_PATTERNS.some((re) => re.test(value)));
          if (hit) {
            result.violations.push({ file: fileName, line, path: hit });
          } else if (candidates.every(isWildcardOnly)) {
            result.unknown.push({ file: fileName, line, path: candidates[0] ?? '*' });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function* walk(absolute, root) {
  let stat;
  try { stat = fs.statSync(absolute); } catch { return; }
  if (stat.isFile()) {
    if (SOURCE_RE.test(absolute) && stat.size <= MAX_FILE_BYTES) yield absolute;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    yield* walk(path.join(absolute, entry.name), root);
  }
}

export function scanTree(root, roots = SCAN_ROOTS) {
  const total = { violations: [], unknown: [], scanned: 0 };
  for (const rel of roots) {
    for (const file of walk(path.join(root, rel), root)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      total.scanned += 1;
      const display = path.relative(root, file).split(path.sep).join('/');
      const { violations, unknown } = scanSource(text, display);
      total.violations.push(...violations);
      total.unknown.push(...unknown);
    }
  }
  return total;
}

function main(argv) {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const verbose = argv.includes('--verbose');
  const { violations, unknown, scanned } = scanTree(root);

  if (unknown.length > 0) {
    console.log(`ℹ️  ${unknown.length} JSON.parse(readFile…) call(s) whose path could not be resolved (not a failure)`);
    if (verbose) for (const u of unknown) console.log(`   ${u.file}:${u.line}`);
  }
  if (violations.length > 0) {
    console.error(`❌ ${violations.length} whole-file read(s) of a dataset past V8's string limit:`);
    for (const v of violations) console.error(`   ${v.file}:${v.line}  ${v.path}`);
    console.error('   Use readJsonFile / iterateJsonArrayFile (scripts/lib/read-large-json.mjs) or, for a file that is');
    console.error('   certainly small, a `// large-dataset-read-ok: <reason>` comment on the call.');
    return 1;
  }
  console.log(`✅ no whole-file dataset reads (${scanned} source files scanned)`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) process.exit(main(process.argv.slice(2)));
