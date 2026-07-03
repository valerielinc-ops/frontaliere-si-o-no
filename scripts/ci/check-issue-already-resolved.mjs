#!/usr/bin/env node
/**
 * check-issue-already-resolved.mjs — zero-Claude PRE-FLIGHT gate for issue-fix.yml.
 *
 * STRUCTURAL fix for the recurring `fix-outcome:already-fixed` burn (escalation #1647,
 * bucket 10×/14d: #1594 #1554 #1474 #1444 #1442). The autonomous `issue-fix` agent
 * repeatedly spent a full expensive Claude run "fixing" a follow-up that a LATER organic
 * PR had already resolved on main without `Closes #N` (done-but-open). The prose rule
 * ("grep the cited file before fixing") never prevented it — prompt-only guidance is not
 * load-bearing. This makes the wasted run IMPOSSIBLE BY CONSTRUCTION: it runs BEFORE the
 * Claude step and, on a STRONG deterministic already-resolved signal, short-circuits the
 * workflow (label removed, advisory comment, `already_resolved=true` output) so the
 * Claude job is skipped via its `if:` condition → zero Max OAuth quota spent.
 *
 * SIGNAL = the same conservative matcher the scheduled reconciler uses
 * (scripts/ci/followup-resolution-match.mjs, single source of truth): a DISTINCTIVE code
 * token quoted in the issue's `Suggested action` region appears VERBATIM in the cited
 * file's CURRENT content on main. Tokens are scoped to `Suggested action` (the prescribed
 * fix), never `Original text` (the status-quo the issue wants changed). Bare prose /
 * plain identifiers are rejected; only code-punctuation tokens qualify.
 *
 * FALSE-POSITIVE SAFETY (bias to PROCEED — a false short-circuit drops a REAL bug, far
 * worse than a wasted run):
 *   - Only follow-up issues are eligible (label `follow-up`). Non-follow-up issues
 *     (crawler/validation/etc.) never carry the cited-file/suggested-action structure and
 *     are always let through.
 *   - Aggregate multi-item follow-ups ("N items deferred", N>=2) are NEVER short-circuited
 *     — one item resolved ≠ all resolved.
 *   - If an open PR already references the issue (in-flight) → proceed (work in progress,
 *     status-quo token still present is expected).
 *   - Ambiguous / weak / no match → DO NOTHING, exit 0 with already_resolved=false → the
 *     normal fixer runs unchanged. The cascade (issue-fix → pr-review-loop → auto-merge)
 *     is untouched for every non-short-circuited issue.
 *
 * On short-circuit it removes `agent:fix` (so the issue is not re-dispatched), adds
 * `maybe-resolved`, posts ONE advisory comment with the verbatim evidence + a
 * `<!-- FIX_OUTCOME: already-fixed -->` telemetry marker (so the lessons-harvester sees
 * the deterministic resolution, NOT another Claude-run miss). It does NOT close the issue
 * — final close stays human (FOLLOWUP.md philosophy: never close on heuristic).
 *
 * Output (GITHUB_OUTPUT): `already_resolved=true|false`. issue-fix.yml gates the Claude
 * job on `already_resolved != 'true'`.
 *
 * Env:
 *   GH_TOKEN      required for gh reads/writes (Actions GITHUB_TOKEN is enough —
 *                 issue label/comment, no `workflows` scope needed).
 *   GH_REPO       optional `owner/repo` (else gh infers from cwd).
 *   ISSUE_NUMBER  required, the candidate issue.
 *   DRY_RUN       "1" → detect + print, no comment/label writes, still emits output.
 *   GITHUB_OUTPUT optional, Actions step output file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAlreadyResolved, closingMergedPr } from './followup-resolution-match.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const MARKER = '<!-- reconcile-bot -->';
const OUTCOME = '<!-- FIX_OUTCOME: already-fixed -->';
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

function setOutput(resolved) {
  console.log(`already_resolved=${resolved}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `already_resolved=${resolved}\n`);
  }
}

/**
 * IO resolver: the gate must judge whether the fix is present ON MAIN. issue-fix.yml
 * checks out the default branch at full depth, so the working tree === main — but we do
 * NOT trust that blindly. We read `git show origin/main:<path>` as the authoritative ref
 * and use the working-tree copy only as an optimisation when it is verifiably the same
 * commit as origin/main; otherwise we go straight to origin/main so a stray ref/checkout
 * can never make us read a wrong-ref file as if it were main.
 *
 * PROCEED-SAFE: if BOTH the working tree and `git show origin/main:<path>` are
 * unavailable, readFile returns null → the matcher skips that file → `resolved=false`
 * → the fixer runs. A failed ref resolution can never produce a false short-circuit.
 */
const DISK_IS_MAIN = (() => {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const originMain = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf-8' }).trim();
    return head.length > 0 && head === originMain;
  } catch {
    return false; // can't prove HEAD === origin/main → never read disk as main
  }
})();

function readFromOriginMain(p) {
  try {
    return execFileSync('git', ['show', `origin/main:${p}`], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const cache = new Map();
const io = {
  fileExists: (p) => {
    // origin/main is authoritative; disk only counts when it is provably main.
    try {
      execFileSync('git', ['cat-file', '-e', `origin/main:${p}`], { stdio: 'ignore' });
      return true;
    } catch {
      return DISK_IS_MAIN && fs.existsSync(p);
    }
  },
  readFile: (p) => {
    if (cache.has(p)) return cache.get(p);
    let content = null;
    if (DISK_IS_MAIN) {
      try {
        content = fs.readFileSync(p, 'utf-8');
      } catch {
        content = readFromOriginMain(p);
      }
    } else {
      content = readFromOriginMain(p); // disk not provably main → only trust the ref
    }
    cache.set(p, content);
    return content;
  },
};

/**
 * Aggregate follow-up: never short-circuit on one match (one item resolved ≠ all). Two
 * detectors, OR'd:
 *   1. Numeric count "N items deferred" with N>=2.
 *   2. Keyword fallback `sweep|batch|bulk` — a sweep enumerates many targets WITHOUT an
 *      "N items deferred" count (e.g. "Sweep: ~30 crawlers", #1826). Without it the sweep
 *      scores single-item and the preflight short-circuits after the FIRST resolved target,
 *      removing `agent:fix` and dropping the rest of the sweep. Bias-to-PROCEED holds: a
 *      false aggregate just lets the normal fixer run (safe), never a false short-circuit.
 *      Mirrors the same fallback in reconcile-followups.mjs / issue-fix.yml (single bug
 *      class across the sibling aggregate detectors).
 */
export function isAggregate(title, body) {
  const text = `${title}\n${body}`;
  const m = text.match(/(\d+)\s+items?\s+deferred/i);
  // An explicit count is authoritative once stated — trust it fully rather
  // than falling through to the keyword heuristic below, which exists ONLY
  // for aggregates that never state a count (e.g. "Sweep: ~30 crawlers").
  // Without this short-circuit, a genuinely single-item follow-up whose
  // title happens to contain "batch"/"sweep"/"bulk" as an ordinary word
  // (e.g. "batch backfill re-checks tier-3...") was misclassified as an
  // aggregate despite explicitly saying "1 item deferred" — a false-positive
  // that wrongly blocked `pr-body-contract` on a fully-completed single item
  // (#3378).
  if (m) return Number(m[1]) >= 2;
  return /\b(?:sweep|batch|bulk)\b/i.test(text);
}

function main() {
  if (!ISSUE) {
    console.error('ISSUE_NUMBER not set — proceeding (no gate).');
    setOutput(false);
    return;
  }

  const raw = gh(['issue', 'view', ISSUE, ...repoArgs, '--json', 'number,title,body,labels,state'], { allowFail: true });
  if (!raw) { console.log('Issue fetch failed — proceeding.'); setOutput(false); return; }

  let iss;
  try { iss = JSON.parse(raw); } catch { console.log('Issue parse failed — proceeding.'); setOutput(false); return; }

  // CLOSED short-circuit (#3116-class): if the issue was already closed (resolved organically,
  // or by close-recovered-failure-issues) before the `agent:fix` labeled-event reached the
  // fixer, a Claude run reproduces a closed issue's fix for nothing. Skip with NO side-effects
  // (no label churn on a closed issue). issue-fix routing already skips non-OPEN; this closes
  // the race where the close lands between label and run. Proceed-safe: unknown state → fall through.
  if (String(iss.state || '').toUpperCase() === 'CLOSED') {
    console.log(`Issue #${ISSUE} is CLOSED — short-circuit, skip Claude fixer (no work on a closed issue).`);
    setOutput(true);
    return;
  }

  const labels = (iss.labels || []).map((l) => l.name);
  // Only follow-up issues carry the cited-file / suggested-action structure this matcher
  // reads. Anything else (crawler, validation-failure, free-form) → proceed unconditionally.
  if (!labels.includes('follow-up')) {
    console.log('Not a follow-up issue — proceeding (gate scope: follow-up only).');
    setOutput(false);
    return;
  }

  const body = iss.body || '';
  if (isAggregate(iss.title || '', body)) {
    console.log('Aggregate multi-item follow-up — proceeding (one item resolved ≠ all).');
    setOutput(false);
    return;
  }

  // In-flight: an open PR referencing this issue means the work is in progress, NOT done.
  // issue-fix names its branch `fix/issue-<N>` (issue-fix.yml § "Branch isolato"), so the
  // `issue-<N>` substring catches the autonomous fixer's own PR; the `#<N>` title/body
  // regex catches organic PRs. Bias to PROCEED on ANY doubt: if the PR list can't be read
  // or parsed, treat as in-flight (don't short-circuit) rather than risk dropping a real
  // fix while a PR is open.
  let inFlight = false;
  try {
    const openPrs = JSON.parse(
      gh(['pr', 'list', '--state', 'open', ...repoArgs, '--json', 'number,headRefName,title,body', '--limit', '100'], { allowFail: true }) || '[]',
    );
    inFlight = openPrs.some((pr) =>
      (pr.headRefName || '').includes(`issue-${ISSUE}`) ||
      new RegExp(`(^|[^\\d])#${ISSUE}([^\\d]|$)`).test(`${pr.title || ''}\n${pr.body || ''}`),
    );
  } catch {
    inFlight = true; // unreadable PR state → assume in-flight, proceed-safe.
  }
  if (inFlight) {
    console.log('Open PR references this issue (or PR state unreadable) — proceeding (in-flight, not done).');
    setOutput(false);
    return;
  }

  // Side-effects shared by every short-circuit path: advisory comment (with a
  // signal-specific `reason` line), drop `agent:fix` (no re-dispatch), tag
  // `maybe-resolved`. Never closes the issue — human confirms (FOLLOWUP.md).
  function shortCircuit(reason, evidenceMd) {
    if (!DRY_RUN) {
      const comment = `${MARKER}
${reason}
${evidenceMd ? `\n${evidenceMd}\n` : ''}
Rimossa la label \`agent:fix\` (no re-dispatch). **Non chiudo** la issue: verifica e chiudi a mano se lo scope è davvero coperto; se invece il fix serve ancora, ri-aggiungi \`agent:fix\`. Gate strutturale #1647.

${OUTCOME}`;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
      // Remove agent:fix so the fixer is not re-dispatched; add maybe-resolved advisory.
      gh(['issue', 'edit', ISSUE, ...repoArgs, '--remove-label', 'agent:fix'], { allowFail: true });
      gh(['label', 'create', LABEL, '--color', 'c5def5',
          '--description', 'Reconcile bot: cited code present in file — likely done-but-open',
          ...repoArgs], { allowFail: true });
      gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', LABEL], { allowFail: true });
    }
    setOutput(true);
  }

  // SIGNAL 1 (explicit declaration): a MERGED PR names this issue with a closing/supersede
  // keyword. Catches the multi-issue `Closes #a #b #c` gotcha (GitHub closes only #a → the
  // rest stay open) and `Supersedes #N`, which the verbatim-token matcher structurally
  // cannot see (it reads file content, not PR cross-refs). Proceed-safe: if the PR list is
  // unreadable/unparseable we skip this signal and fall through to the token matcher.
  let closer = null;
  const MERGED_PR_LIMIT = 50;
  try {
    const mergedPrs = JSON.parse(
      gh(['pr', 'list', '--state', 'merged', '--search', `#${ISSUE} in:body,title`, ...repoArgs,
          '--json', 'number,title,body', '--limit', String(MERGED_PR_LIMIT)], { allowFail: true }) || '[]',
    );
    // Coverage cap (proceed-safe but worth surfacing): if the search saturates the
    // limit, a declaring PR older than the 50 most-recent hits is missed → SIGNAL 1
    // silently falls through to the token matcher / fixer. Direction is safe (never a
    // false short-circuit), but log it so the cap isn't invisible (reviewer adv #3).
    if (mergedPrs.length >= MERGED_PR_LIMIT) {
      console.log(`Issue #${ISSUE}: merged-PR search hit the ${MERGED_PR_LIMIT}-result cap — a declaring PR beyond it would be missed by SIGNAL 1 (proceed-safe).`);
    }
    closer = closingMergedPr(ISSUE, mergedPrs);
  } catch { closer = null; }
  if (closer) {
    console.log(`Issue #${ISSUE}: MERGED PR #${closer} explicitly closes/supersedes it (done-but-open) → short-circuit, skip Claude fixer.`);
    shortCircuit(
      `⏭️ **Pre-flight (auto, zero-Claude)**: la PR **#${closer}** (già mergiata) dichiara esplicitamente di chiudere/superare questa issue (\`Closes\`/\`Supersedes #${ISSUE}\`) ma GitHub non l'ha auto-chiusa — probabile **done-but-open** (es. \`Closes #a #b\` multi-issue: chiude solo la prima). Salto il fixer autonomo per non sprecare quota Max OAuth.`,
      `- dichiarata risolta da #${closer} (merged)`,
    );
    return;
  }

  // SIGNAL 1b (own-branch merge): the autonomous fixer names its branch `fix/issue-<N>`
  // (issue-fix.yml § "Branch isolato"). A MERGED PR on EXACTLY that head means the fixer
  // already landed this (non-aggregate) follow-up's fix — even when the PR carried no
  // `Closes #N` keyword (SIGNAL 1 requires one). This is the #3116-class waste: the drainer
  // re-applies `agent:fix` AFTER the fix merged → a full Claude run reproduces an
  // already-merged fix and burns shared Max quota (often ending in error_max_turns + a RED
  // job). Aggregates already returned above (one item merged ≠ all), so this only fires for
  // single-item follow-ups whose own fix-branch landed. Proceed-safe: unreadable/empty list
  // → skip this signal, fall through to the token matcher.
  let mergedOwnBranch = null;
  try {
    const ownBranchPrs = JSON.parse(
      gh(['pr', 'list', '--state', 'merged', '--head', `fix/issue-${ISSUE}`, ...repoArgs,
          '--json', 'number,mergedAt', '--limit', '5'], { allowFail: true }) || '[]',
    );
    const m = ownBranchPrs.find((pr) => pr.mergedAt);
    mergedOwnBranch = m ? m.number : null;
  } catch { mergedOwnBranch = null; }
  if (mergedOwnBranch) {
    console.log(`Issue #${ISSUE}: the fixer's own branch fix/issue-${ISSUE} already merged in PR #${mergedOwnBranch} → short-circuit, skip Claude fixer.`);
    shortCircuit(
      `⏭️ **Pre-flight (auto, zero-Claude)**: il branch del fixer autonomo \`fix/issue-${ISSUE}\` risulta **già mergiato** nella PR **#${mergedOwnBranch}** — il fix per questa follow-up single-item è già landato (anche senza \`Closes #${ISSUE}\`). La re-label \`agent:fix\` (drainer) farebbe ripartire una run Claude che riproduce un fix già fatto (classe #3116). Salto il fixer per non sprecare quota Max OAuth.`,
      `- fix già mergiato in #${mergedOwnBranch} (branch \`fix/issue-${ISSUE}\`)`,
    );
    return;
  }

  // SIGNAL 2 (content match): every distinctive token prescribed in `Suggested action` is
  // already present verbatim in a cited file on main.
  const { resolved, evidence } = detectAlreadyResolved(body, io);
  if (!resolved) {
    console.log('No strong already-resolved signal — proceeding (normal fixer runs).');
    setOutput(false);
    return;
  }

  const ev = evidence.slice(0, 6).map((e) => `- \`${e.tok}\` già presente in \`${e.file}\``).join('\n');
  console.log(`Issue #${ISSUE}: STRONG already-resolved signal (${evidence.length} token match) → short-circuit, skip Claude fixer.`);
  shortCircuit(
    `⏭️ **Pre-flight (auto, zero-Claude)**: i token prescritti da questa follow-up risultano **già presenti verbatim** nei file citati — probabile **already-fixed / done-but-open** (coperto da una PR successiva senza \`Closes #${ISSUE}\`). Salto il fixer autonomo per non sprecare quota Max OAuth.`,
    ev,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Pre-flight already-resolved gate: issue #${ISSUE} short-circuited\n${ev}\n`,
    );
  }
}

// Run only as a CLI entrypoint — importing for tests (pure helpers like isAggregate above)
// must not trigger the gh-driven gate. Mirrors reconcile-followups.mjs's guard.
//
// TOTAL / PROCEED-SAFE: the preflight step in issue-fix.yml has no continue-on-error and
// every Claude step gates on `already_resolved != 'true'`. If main() ever throws (malformed
// body, gh fault, ref error), the job would fail WITHOUT removing `agent:fix` → the issue is
// stranded labeled-but-undispatched (the very failure mode this gate exists to prevent). So
// any uncaught error is swallowed → emit `already_resolved=false` and exit 0 → the normal
// fixer runs unchanged. A throw can NEVER strand the issue.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Pre-flight gate error — proceeding (normal fixer runs):', e && e.message ? e.message : e);
    setOutput(false);
    process.exit(0);
  }
}
