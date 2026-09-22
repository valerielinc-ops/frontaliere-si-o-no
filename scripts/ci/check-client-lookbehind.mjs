#!/usr/bin/env node
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
 * notes). Per line it strips the `//` line-comment tail and skips block-comment
 * body lines (trimmed start `*`). A `(?<` surviving in the code portion is a real
 * client lookbehind.
 *
 * Exit codes: 0 = clean, 1 = violation(s). `--json` prints a machine report.
 *
 * Usage: node scripts/ci/check-client-lookbehind.mjs [--json]
 * Zero dependencies (git in PATH only); inspects tracked and untracked sources.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * True if a source line contains a regex lookbehind in CODE (not a comment).
 * Strips the `//` line-comment tail and ignores block-comment body lines.
 * Pure → testable.
 */
export function lineHasClientLookbehind(line) {
  const s = String(line ?? '');
  const trimmed = s.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false; // comment line
  const code = s.split('//')[0]; // drop trailing line comment
  return LOOKBEHIND_RE.test(code);
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

function importedSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
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
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((content, index) => {
      if (lineHasClientLookbehind(content)) violations.push({ file, line: index + 1, content: content.trim() });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
