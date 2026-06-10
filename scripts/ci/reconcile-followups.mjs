#!/usr/bin/env node
/**
 * reconcile-followups.mjs — zero-Claude reconciliation of done-but-open follow-ups.
 *
 * Many `follow-up` issues are satisfied silently by a LATER organic PR that touches
 * the same file (adds the cited test / fix) without writing `Closes #N` — the author
 * didn't know the follow-up existed. They then accumulate as noise: they bloat the
 * issue list and (auto-routed to `agent:fix`) re-trigger the fixer on the shared Max
 * quota. `post-merge-followup.yml` only flags `🔗 Possibile supersede` on file-touch,
 * never on verified content. This closes that gap deterministically.
 *
 * For each open `follow-up` issue, it extracts the cited file(s) and the distinctive
 * CODE token(s) quoted in the body (`Original text` / `Suggested action`), then checks
 * whether those tokens are now present verbatim in the cited file. A hit means the
 * asserted behavior/symbol already exists → the item is likely done-but-open.
 *
 * SAFE BY DESIGN: it NEVER closes. It posts ONE idempotent advisory comment and adds
 * the `maybe-resolved` label. Final close stays human (FOLLOWUP.md philosophy: never
 * close on heuristic). Run on a schedule via followup-reconcile.yml.
 *
 * Env:
 *   GH_TOKEN     required for gh writes (provided by Actions).
 *   GH_REPO      optional `owner/repo` (else gh infers from cwd).
 *   DRY_RUN      "1" → detect + print, no comment/label writes.
 *   MAX_ISSUES   cap issues scanned (default 100).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { detectAlreadyResolved } from './followup-resolution-match.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 100);
const MARKER = '<!-- reconcile-bot -->';
const LABEL = 'maybe-resolved';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

// Matcher (isDistinctiveToken / citedFiles / citedTokens / detectAlreadyResolved) lives
// in ./followup-resolution-match.mjs — shared verbatim with the issue-fix.yml pre-flight
// gate (check-issue-already-resolved.mjs) so the two can never drift on what counts as
// "already resolved" (AGENTS.md #6). Disk-backed IO resolver for this scheduled pass:
const fileCache = new Map();
const diskIo = {
  fileExists: (p) => fs.existsSync(p),
  readFile: (p) => {
    if (!fileCache.has(p)) fileCache.set(p, fs.readFileSync(p, 'utf-8'));
    return fileCache.get(p);
  },
};

function alreadyCommented(number) {
  const out = gh(['issue', 'view', String(number), ...repoArgs, '--json', 'comments'], { allowFail: true });
  if (!out) return false;
  try {
    return JSON.parse(out).comments.some((c) => (c.body || '').includes(MARKER));
  } catch {
    return false;
  }
}

function main() {
  const raw = gh([
    'issue', 'list', '--label', 'follow-up', '--state', 'open',
    ...repoArgs, '--json', 'number,title,body', '--limit', String(MAX_ISSUES),
  ]);
  const issues = JSON.parse(raw || '[]');

  // In-flight exclusion: an open PR for issue #N means the work is in progress, NOT done
  // — its cited status-quo code is still in the file. Skip those (mirrors FOLLOWUP.md §
  // Dedup "in-flight overlap"). Match by `fix/issue-N` branch or `#N` in PR title/body.
  const openPrs = JSON.parse(
    gh(['pr', 'list', '--state', 'open', ...repoArgs, '--json', 'number,headRefName,title,body', '--limit', '100'], { allowFail: true }) || '[]',
  );
  function inFlight(n) {
    const tag = `#${n}`;
    return openPrs.some((pr) =>
      pr.headRefName?.includes(`issue-${n}`) ||
      new RegExp(`(^|[^\\d])${tag}([^\\d]|$)`).test(`${pr.title}\n${pr.body || ''}`),
    );
  }

  if (!DRY_RUN) {
    // Best-effort: ensure the advisory label exists (no-op if already there).
    gh(['label', 'create', LABEL, '--color', 'c5def5',
        '--description', 'Reconcile bot: cited code present in file — likely done-but-open',
        ...repoArgs], { allowFail: true });
  }

  const flagged = [];

  for (const iss of issues) {
    if (inFlight(iss.number)) { console.log(`#${iss.number}: in-flight PR open, skip`); continue; }
    const { resolved, evidence } = detectAlreadyResolved(iss.body || '', diskIo);
    if (!resolved) continue;
    if (alreadyCommented(iss.number)) { console.log(`#${iss.number}: already reconciled, skip`); continue; }

    flagged.push({ number: iss.number, title: iss.title, evidence });
  }

  for (const f of flagged) {
    const lines = f.evidence
      .slice(0, 6)
      .map((e) => `- \`${e.tok}\` già presente in \`${e.file}\``)
      .join('\n');
    const comment = `${MARKER}
🤖 **Reconcile (auto)**: i token citati da questa issue risultano già presenti nei file citati — probabile **done-but-open** (coperto da una PR successiva senza \`Closes #${f.number}\`).

${lines}

Verifica e chiudi a mano se lo scope è davvero coperto. Segnalazione automatica deterministica (presenza verbatim del token), **non chiusura**.`;

    console.log(`#${f.number} "${f.title}" → ${f.evidence.length} token match`);
    if (DRY_RUN) continue;
    gh(['issue', 'comment', String(f.number), ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', String(f.number), ...repoArgs, '--add-label', LABEL], { allowFail: true });
  }

  const summary = `Reconcile follow-ups: scanned ${issues.length}, flagged ${flagged.length}${DRY_RUN ? ' (dry-run)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const detail = flagged.map((f) => `- #${f.number} ${f.title} (${f.evidence.length} match)`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${detail}\n`);
  }
}

main();
