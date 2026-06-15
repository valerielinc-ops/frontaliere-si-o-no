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
 * Scope: client-bundled paths only (components/, services/, hooks/, pages/, lib/,
 * src/). build-plugins/ and scripts/ run under Node (modern V8) at BUILD time and
 * never ship to the browser, so lookbehind there is fine — excluded.
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
 * Zero dependencies (git in PATH only); inspects tracked files via `git grep`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(
    'check-client-lookbehind.mjs — forbid regex lookbehind ((?<=/(?<!) in\n' +
      'client-bundled source (Safari/WebKit crash, #1996/#1999). build-plugins/ +\n' +
      'scripts/ are build-time (Node) and exempt.\n\nFlags: --json · --help   Exit: 0 clean, 1 violation.',
  );
  process.exit(0);
}

// Client-bundled code dirs (shipped to the browser). build-plugins/ + scripts/
// run under Node at build time → exempt.
const CLIENT_GLOBS = [
  'components/**/*.ts', 'components/**/*.tsx',
  'services/**/*.ts', 'services/**/*.tsx',
  'hooks/**/*.ts', 'hooks/**/*.tsx',
  'pages/**/*.ts', 'pages/**/*.tsx',
  'lib/**/*.ts', 'lib/**/*.tsx',
  'src/**/*.ts', 'src/**/*.tsx',
];

const LOOKBEHIND_RE = /\(\?<[=!]/;

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

function gitGrepLines(glob) {
  try {
    // -n line numbers; -E for the lookbehind alternation. git grep exits 1 on no
    // match (clean) — handled below.
    const out = execFileSync(
      'git', ['grep', '-nE', '\\(\\?<[=!]', '--', glob],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split('\n').filter(Boolean);
  } catch (e) {
    if (e && e.status === 1 && !e.stderr?.toString().trim()) return [];
    throw e;
  }
}

export function findViolations() {
  const violations = [];
  for (const glob of CLIENT_GLOBS) {
    for (const hit of gitGrepLines(glob)) {
      // format: path:lineno:content
      const m = hit.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineno, content] = m;
      if (file.includes('.test.') || file.includes('.spec.')) continue; // tests may document the antipattern
      if (lineHasClientLookbehind(content)) violations.push({ file, line: Number(lineno), content: content.trim() });
    }
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
        `((?<=/(?<!) — crashes older Safari/WebKit at parse time (#1996/#1999):\n`,
    );
    for (const v of violations) console.error(`  - ${v.file}:${v.line}  ${v.content.slice(0, 100)}`);
    console.error(
      '\nFix: rewrite the regex without a lookbehind (e.g. capture + reattach the boundary, ' +
        'or a sentinel split — see the #1996 JobBoard/seo-authors splits). Lookbehind is fine ' +
        'in build-plugins/ and scripts/ (build-time Node), not in browser-shipped code.',
    );
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
