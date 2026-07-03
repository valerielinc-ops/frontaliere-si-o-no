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
 * TWO-TIER, double-confirm-across-time (replaces the old never-close rule, which left
 * the deterministically-detected `maybe-resolved` pile to a human who never came — the
 * #1 reason the follow-up backlog never converged):
 *   1. FIRST detection (issue not yet `maybe-resolved`): post ONE advisory comment + add
 *      the `maybe-resolved` label. A grace window — the human has until the next scheduled
 *      run to object (reopen scope / strip the label / add a keep-open signal).
 *   2. SECOND confirmation (issue ALREADY carries `maybe-resolved` from a prior run, is
 *      STILL resolved, is NOT a multi-item aggregate, and carries no keep-open/strategic
 *      label): AUTO-CLOSE with a citation comment + `fu-resolved-auto`, `--reason completed`.
 * Why this is safe (no quality loss): the close fires only on TWO independent deterministic
 * confirmations separated in time, after a human grace window, on the hardened matcher
 * (ALL distinctive prescribed code tokens present — the same bar that gates the issue-fix
 * pre-flight, which DROPS work, a strictly higher-stakes action than a reversible close).
 * Multi-item aggregates and keep-open/strategic issues never auto-close (a prose-only
 * sub-item contributes no gating token, so "all tokens present" can't prove every item is
 * done). A genuinely-pending fix recurs and reopens via the dedup-stable monitor title.
 *
 * Env:
 *   GH_TOKEN       required for gh writes (provided by Actions).
 *   GH_REPO        optional `owner/repo` (else gh infers from cwd).
 *   DRY_RUN        "1" → detect + print, no comment/label/close writes.
 *   MAX_ISSUES     cap issues scanned (default 100).
 *   NO_AUTOCLOSE   "1" → force tier-1 behavior only (flag, never close). Escape hatch.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAlreadyResolved } from './followup-resolution-match.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const NO_AUTOCLOSE = process.env.NO_AUTOCLOSE === '1';
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 100);
const MARKER = '<!-- reconcile-bot -->';
const CLOSE_MARKER = '<!-- reconcile-bot:autoclose -->';
const LABEL = 'maybe-resolved';
const CLOSED_LABEL = 'fu-resolved-auto';

// Labels that VETO auto-close (the issue wants human eyes regardless of token match):
// explicit keep-open pins + strategic trackers (revenue/tracker stay owner-gated).
const KEEP_OPEN_LABELS = new Set(['pinned', 'keep-open', 'revenue', 'tracker', 'do-not-close']);

/**
 * A title like "follow-up(#X): 3 item deferred — …" with N≥2 → multi-item aggregate.
 * These never auto-close: a prose-only sub-item contributes no gating code token, so the
 * matcher's "ALL tokens present" can be true while that sub-item is still undone — closing
 * would silently drop it. Single-item follow-ups (no count, or "1 item") are eligible.
 *
 * Two detectors, OR'd:
 *   1. Numeric count `N items` with N≥2.
 *   2. Keyword fallback `sweep|batch|bulk` — a sweep enumerates many targets WITHOUT an
 *      "N items" count (e.g. "Sweep: ~30 crawlers", #1826). Without this it scores as
 *      non-aggregate → `closeEligible` in decideReconcileAction can flip true and
 *      silently auto-close a partially-resolved sweep, dropping the remaining targets
 *      (29 of 30). Mirrors the same fallback added to issue-fix.yml / check-issue-
 *      already-resolved.mjs (single bug class across the sibling aggregate detectors).
 * @param {string} title
 * @returns {boolean}
 */
export function isAggregateTitle(title = '') {
  const t = String(title);
  const m = t.match(/\b(\d+)\s+items?\b/i);
  // An explicit count is authoritative once present — trust it fully instead
  // of falling through to the keyword fallback below, which exists ONLY for
  // aggregates that never state a count. Otherwise a genuinely single-item
  // follow-up whose title contains "batch"/"sweep"/"bulk" as an ordinary word
  // (e.g. "1 item deferred ... batch backfill...") is misclassified as an
  // aggregate despite explicitly saying "1 item" (#3378).
  if (m) return Number(m[1]) >= 2;
  return /\b(?:sweep|batch|bulk)\b/i.test(t);
}

/** Count of code-punctuation marks in a token (specificity proxy). */
function punctCount(t) {
  return (String(t).match(/[(){}[\]'"`.:;=<>+\-*/!&|?]/g) || []).length;
}

/**
 * Evidence strong enough to AUTO-CLOSE (vs merely flag). A single common dot-member like
 * `meta.model` matches in countless unrelated files → too coincidental to close on. Require
 * either MULTIPLE distinct prescribed tokens all present, OR a single RICH token (an actual
 * expression carrying ≥2 punctuation marks, e.g. `displayCount = page === 1 ? a : b` or
 * `window.__CDN_DATA_BASE__`), never a bare 1-dot member. Weak-but-resolved stays flagged
 * for a human (never silently closed).
 * @param {string[]} matchedTokens tokens that were found verbatim in a cited file
 * @returns {boolean}
 */
export function isStrongAutoCloseEvidence(matchedTokens) {
  const uniq = [...new Set((matchedTokens || []).map((t) => String(t)))];
  if (uniq.length >= 2) return true;
  if (uniq.length === 1) return punctCount(uniq[0]) >= 2;
  return false;
}

/**
 * Pure tier decision. Returns 'close' | 'flag' | 'none'.
 *   - not resolved                                          → 'none'  (leave alone)
 *   - human objection (we flagged before, label since gone) → 'none'  (respect, don't re-flag)
 *   - eligible + strong + flagged-before + still labelled   → 'close' (second confirmation)
 *   - resolved but not close-eligible, already flagged      → 'none'  (held, no dup comment)
 *   - resolved but not close-eligible, first seen           → 'flag'  (grace / explain)
 *
 * Close-eligible = single-item, unblocked, auto-close on, AND strong evidence. `hasPriorFlag`
 * = THIS bot already left its advisory comment on a prior run; auto-close requires BOTH that
 * prior flag AND the `maybe-resolved` label still present (two confirmations across time +
 * an un-rescinded grace window). Removing the label after a flag = human objection → quiet.
 * @param {{resolved:boolean, hasMaybeResolved:boolean, hasPriorFlag:boolean,
 *          isAggregate:boolean, blocked:boolean, noAutoclose?:boolean, strongEvidence?:boolean}} s
 * @returns {'close'|'flag'|'none'}
 */
export function decideReconcileAction({ resolved, hasMaybeResolved, hasPriorFlag, isAggregate, blocked, noAutoclose, strongEvidence }) {
  if (!resolved) return 'none';
  if (hasPriorFlag && !hasMaybeResolved) return 'none'; // label rescinded after our flag = objection
  const closeEligible = !noAutoclose && !blocked && !isAggregate && !!strongEvidence;
  if (closeEligible && hasPriorFlag && hasMaybeResolved) return 'close'; // second confirmation
  return hasPriorFlag ? 'none' : 'flag'; // held (already flagged) vs first detection
}

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

function evidenceLines(evidence) {
  return evidence
    .slice(0, 6)
    .map((e) => `- \`${e.tok}\` già presente in \`${e.file}\``)
    .join('\n');
}

function main() {
  const raw = gh([
    'issue', 'list', '--label', 'follow-up', '--state', 'open',
    ...repoArgs, '--json', 'number,title,body,labels', '--limit', String(MAX_ISSUES),
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
    // Best-effort: ensure the advisory + auto-close labels exist (no-op if already there).
    gh(['label', 'create', LABEL, '--color', 'c5def5',
        '--description', 'Reconcile bot: cited code present in file — likely done-but-open',
        ...repoArgs], { allowFail: true });
    gh(['label', 'create', CLOSED_LABEL, '--color', '0e8a16',
        '--description', 'Reconcile bot: auto-closed on second deterministic done-but-open confirmation',
        ...repoArgs], { allowFail: true });
  }

  const flagged = [];
  const closed = [];

  for (const iss of issues) {
    if (inFlight(iss.number)) { console.log(`#${iss.number}: in-flight PR open, skip`); continue; }
    const { resolved, evidence } = detectAlreadyResolved(iss.body || '', diskIo);
    if (!resolved) continue;

    const labelNames = (iss.labels || []).map((l) => l.name);
    const hasMaybeResolved = labelNames.includes(LABEL);
    const blocked = labelNames.some((n) => KEEP_OPEN_LABELS.has(n));
    const isAggregate = isAggregateTitle(iss.title);
    const hasPriorFlag = alreadyCommented(iss.number);
    const strongEvidence = isStrongAutoCloseEvidence(evidence.map((e) => e.tok));
    const action = decideReconcileAction({
      resolved, hasMaybeResolved, hasPriorFlag, isAggregate, blocked, noAutoclose: NO_AUTOCLOSE, strongEvidence,
    });

    if (action === 'close') {
      closed.push({ number: iss.number, title: iss.title, evidence });
    } else if (action === 'flag') {
      const reason = blocked ? 'keep-open'
        : isAggregate ? 'aggregate'
        : NO_AUTOCLOSE ? 'no-autoclose'
        : !strongEvidence ? 'weak-evidence'
        : 'first-seen';
      flagged.push({ number: iss.number, title: iss.title, evidence, reason });
    } else { // 'none' — leave alone (not resolved / objection / held at tier-1)
      if (hasPriorFlag) console.log(`#${iss.number}: held (objection / weak / tier-1), skip`);
    }
  }

  // Tier 1 — flag (grace window): comment + maybe-resolved label.
  for (const f of flagged) {
    const note = f.reason === 'aggregate'
      ? '\n\n⚠️ Multi-item: l\'auto-close non scatta (un sub-item prose-only potrebbe non essere coperto) — **chiusura umana**.'
      : f.reason === 'keep-open'
      ? '\n\n📌 Label keep-open/strategica: resta aperta per revisione umana, niente auto-close.'
      : f.reason === 'weak-evidence'
      ? '\n\nℹ️ Evidenza debole (singolo token poco specifico): **non** verrà auto-chiusa — verifica e chiudi a mano se lo scope è coperto.'
      : '\n\nSe al prossimo run risulterà ancora risolta, verrà **auto-chiusa** (finestra di grazia: obietta rimuovendo `maybe-resolved` o aggiungendo `keep-open`).';
    const comment = `${MARKER}
🤖 **Reconcile (auto)**: i token citati da questa issue risultano già presenti nei file citati — probabile **done-but-open** (coperto da una PR successiva senza \`Closes #${f.number}\`).

${evidenceLines(f.evidence)}${note}`;
    console.log(`#${f.number} "${f.title}" → flag (${f.reason}, ${f.evidence.length} match)`);
    if (DRY_RUN) continue;
    gh(['issue', 'comment', String(f.number), ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', String(f.number), ...repoArgs, '--add-label', LABEL], { allowFail: true });
  }

  // Tier 2 — auto-close (second confirmation, grace window elapsed, eligible).
  for (const c of closed) {
    const comment = `${CLOSE_MARKER}
✅ **Reconcile auto-close**: seconda conferma deterministica (\`maybe-resolved\` da un run precedente, finestra di grazia trascorsa senza obiezioni, ancora risolta, single-item, nessuna label keep-open). Tutti i token-codice prescritti sono presenti nei file citati:

${evidenceLines(c.evidence)}

Chiusa come **completed** (done-but-open). Si **riapre da sola** se il segnale sottostante ricorre (titoli monitor dedup-stabili) — o riapri a mano se lo scope non era davvero coperto.`;
    console.log(`#${c.number} "${c.title}" → AUTO-CLOSE (${c.evidence.length} match)`);
    if (DRY_RUN) continue;
    gh(['issue', 'comment', String(c.number), ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', String(c.number), ...repoArgs, '--add-label', CLOSED_LABEL], { allowFail: true });
    gh(['issue', 'close', String(c.number), ...repoArgs, '--reason', 'completed'], { allowFail: true });
  }

  const summary = `Reconcile follow-ups: scanned ${issues.length}, flagged ${flagged.length}, auto-closed ${closed.length}${DRY_RUN ? ' (dry-run)' : ''}${NO_AUTOCLOSE ? ' (no-autoclose)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fl = flagged.map((f) => `- 🟡 #${f.number} ${f.title} (flag: ${f.reason}, ${f.evidence.length} match)`).join('\n');
    const cl = closed.map((c) => `- ✅ #${c.number} ${c.title} (auto-closed, ${c.evidence.length} match)`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${[cl, fl].filter(Boolean).join('\n')}\n`);
  }
}

// Run only as a CLI entrypoint — importing for tests (pure decision helpers above) must
// not trigger the gh-driven scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
