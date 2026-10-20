#!/usr/bin/env node
/**
 * replay-parser-contract.mjs — misura di `check-parser-contract.mjs` sulle PR
 * storiche (issue 11674).
 *
 * Per ogni PR prende lo sha REVISIONATO: il commit su cui il revisore ha dato
 * il primo 🔴, cioe' la head prima del fix. La base e' il merge-base di quello
 * sha con `origin/main`. Sui file di parser del diff base..sha esegue lo stesso
 * confronto del gate, con la base al posto della baseline committata: un file
 * nuovo con una violazione o un conteggio per regola che sale = PR fallita.
 * Stampa una riga per PR e alla fine `fallite=N/M`.
 *
 * Rete: `gh pr view --json reviews` (via coordinatore) per trovare lo sha, e
 * `git fetch origin refs/pull/<N>/head` solo se il commit non e' nel clone.
 * Con `--reviews-dir <dir>` legge invece `<dir>/<N>.json` (stesso formato di
 * `gh pr view --json reviews`). Il lint in se' resta statico.
 *
 * Usage:
 *   node scripts/ci/replay-parser-contract.mjs --prs 11566,11303 [--reviews-dir d] [--verbose]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  PARSER_PATH_RE, RULES, compareFile, countByRule, scanParserFile,
} from './check-parser-contract.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const RED = '\u{1F534}';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

function hasCommit(sha) {
  try { git('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; }
}

function reviewsFor(pr, reviewsDir) {
  if (reviewsDir) return JSON.parse(readFileSync(path.join(reviewsDir, `${pr}.json`), 'utf8')).reviews || [];
  const out = execFileSync('gh', ['pr', 'view', String(pr), '--repo', REPO, '--json', 'reviews'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out).reviews || [];
}

export function reviewedSha(reviews) {
  const red = (reviews || [])
    .filter((r) => String(r?.body || '').includes(RED) && r?.commit?.oid)
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return red[0]?.commit?.oid || '';
}

function showOrNull(rev, file) {
  try { return git('show', `${rev}:${file}`); } catch { return null; }
}

export function replayPr(pr, { reviewsDir } = {}) {
  const sha = reviewedSha(reviewsFor(pr, reviewsDir));
  if (!sha) return { pr, status: 'no-red-review', regressions: [] };
  if (!hasCommit(sha)) {
    try { git('fetch', '-q', 'origin', `refs/pull/${pr}/head`); } catch { /* resta assente */ }
  }
  if (!hasCommit(sha)) return { pr, sha, status: 'sha-missing', regressions: [] };
  const base = git('merge-base', sha, 'origin/main').trim();
  const files = git('diff', '--name-only', '--diff-filter=AMR', base, sha)
    .split('\n').filter((f) => PARSER_PATH_RE.test(f));
  const regressions = [];
  for (const file of files) {
    const head = showOrNull(sha, file);
    if (head == null) continue;
    const readAt = (rev) => (f) => {
      const text = showOrNull(rev, f);
      if (text == null) throw Object.assign(new Error(`${rev}:${f} assente`), { code: 'ENOENT' });
      return text;
    };
    const before = showOrNull(base, file);
    const baseEntry = before == null ? undefined : countByRule(scanParserFile(file, before, readAt(base)));
    regressions.push(...compareFile(file, scanParserFile(file, head, readAt(sha)), baseEntry).regressions);
  }
  return { pr, sha, base, parserFiles: files.length, status: regressions.length ? 'fallita' : 'passata', regressions };
}

function main(argv) {
  const value = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const prs = String(value('--prs') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!prs.length) {
    console.error('usage: replay-parser-contract.mjs --prs 1,2,3 [--reviews-dir dir] [--verbose]');
    return 2;
  }
  const reviewsDir = value('--reviews-dir');
  const verbose = argv.includes('--verbose');
  let failed = 0;
  for (const pr of prs) {
    const result = replayPr(pr, { reviewsDir });
    if (result.status === 'fallita') failed += 1;
    const rules = [...new Set(result.regressions.map((r) => r.rule))].join(',');
    console.log(`PR ${pr} ${result.status}${rules ? ` [${rules}]` : ''} sha=${(result.sha || '-').slice(0, 10)} parser=${result.parserFiles ?? 0}`);
    if (verbose) {
      for (const r of result.regressions) {
        for (const v of r.lines) console.log(`    parser-contract ${v.rule} ${RULES[v.rule]}: ${r.file}:${v.line} (base ${r.allowed}, head ${r.now})  ${v.text}`);
      }
    }
  }
  console.log(`fallite=${failed}/${prs.length}`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
