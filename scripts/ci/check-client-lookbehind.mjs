#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * check-client-lookbehind.mjs — zero-Claude CI gate forbidding regex lookbehind
 * in client-bundled source.
 *
 * Root cause (#1996 → follow-up #1999): a client-shipped regex used a lookbehind
 * (`(?<=…)` / `(?<!…)`). Older Safari/WebKit throws "Invalid regular expression:
 * invalid group specifier name" at parse time, which crashed the job-detail
 * render for Google Jobs traffic — lost ad impressions (monetization). The hotfix
 * removed the offending split; without a guard a new client lookbehind can
 * silently re-enter on any future merge and replicate the crash.
 *
 * Scope: client entry paths plus their complete local import closure. Most
 * build-plugins/ and scripts/ run only under Node, but shared modules imported
 * by the SPA ship to browsers and must be checked too.
 *
 * Comment-aware: only flags lookbehind in CODE, not in comments describing the
 * old removed regex (the #1996 fix left several `// …the old /(?<=\s)/ split…`
 * notes). The scanner carries lexical state across lines, so `//` in a URL,
 * string, template, or regex literal is not mistaken for a comment and a code
 * line beginning with `*` is not discarded. Template interpolations are scanned
 * recursively as code, including nested templates.
 *
 * Exit codes: 0 = clean, 1 = violation(s). `--json` prints a machine report.
 *
 * Usage: node scripts/ci/check-client-lookbehind.mjs [--json]
 * Zero dependencies (git in PATH only); inspects tracked and untracked sources.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripSourceComments } from '../lib/source-comments.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(
    'check-client-lookbehind.mjs — forbid regex lookbehind ((?<=/(?<!) in\n' +
      'client-bundled source and its local import closure (Safari/WebKit crash,\n' +
      '#1996/#1999/#9539).\n\nFlags: --json · --help   Exit: 0 clean, 1 violation.',
  );
  process.exit(0);
}

const CLIENT_GLOBS = [
  'components/**/*.ts', 'components/**/*.tsx',
  'services/**/*.ts', 'services/**/*.tsx',
  'hooks/**/*.ts', 'hooks/**/*.tsx',
  'pages/**/*.ts', 'pages/**/*.tsx',
  'lib/**/*.ts', 'lib/**/*.tsx',
  'src/**/*.ts', 'src/**/*.tsx',
];

const LOOKBEHIND_RE = /\(\?<[=!]/;
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js'];

export const stripComments = stripSourceComments;

/**
 * True if a source line contains a regex lookbehind in CODE (not a comment).
 * For complete files `findViolations()` uses `stripComments()` once so comment
 * and string state is shared across line boundaries; this helper remains pure
 * and convenient for focused tests and callers with a single source line.
 * Pure → testable.
 */
export function lineHasClientLookbehind(line) {
  return LOOKBEHIND_RE.test(stripComments(line));
}

function resolveLocalImport(fromFile, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = path.resolve(specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(process.cwd(), candidate);
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(process.cwd(), candidate);
  }
  return null;
}

export function importedSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  // A template literal with interpolation is not statically resolvable; do not
  // guess its target and accidentally add an incomplete import closure.
  const staticTemplateImport = /import\s*\(\s*`([^`]*)`\s*\)/g;
  for (const match of code.matchAll(staticTemplateImport)) {
    if (!match[1].includes('${')) specifiers.push(match[1]);
  }
  return specifiers;
}

export function clientImportClosure() {
  const roots = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...CLIENT_GLOBS],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  ).split('\n').filter(Boolean);
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf-8');
    for (const specifier of importedSpecifiers(source)) {
      const imported = resolveLocalImport(file, specifier);
      if (imported && !seen.has(imported)) queue.push(imported);
    }
  }
  return [...seen].sort();
}

export function findViolations() {
  const violations = [];
  for (const file of clientImportClosure()) {
    const source = fs.readFileSync(file, 'utf-8');
    const codeLines = stripComments(source).split('\n');
    const sourceLines = source.split('\n');
    codeLines.forEach((content, index) => {
      if (LOOKBEHIND_RE.test(content)) {
        violations.push({ file, line: index + 1, content: sourceLines[index].trim() });
      }
    });
  }
  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

function main() {
  const violations = findViolations();
  if (JSON_OUT) console.log(JSON.stringify({ violations }, null, 2));

  if (violations.length === 0) {
    if (!JSON_OUT) {
      console.log('✓ check-client-lookbehind: no regex lookbehind in client-bundled source.');
    }
    process.exit(0);
  }

  if (!JSON_OUT) {
    console.error(
      `✗ check-client-lookbehind: ${violations.length} client-bundled regex lookbehind(s) ` +
        `((?<=/(?<!) — crashes older Safari/WebKit at parse time (#1996/#1999/#9539):\n`,
    );
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  ${v.content.slice(0, 100)}`);
    console.error(
      '\nFix: rewrite the regex without a lookbehind (e.g. capture + reattach the boundary, ' +
        'or a sentinel split — see the #1996 JobBoard/seo-authors splits). Lookbehind is fine ' +
        'in Node-only modules, not in any module reachable from browser entrypoints.',
    );
  }
  process.exit(1);
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  main();
}
