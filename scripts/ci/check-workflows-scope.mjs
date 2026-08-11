#!/usr/bin/env node
/**
 * check-workflows-scope.mjs — zero-Claude PRE-FLIGHT capability guard for issue-fix.yml.
 *
 * STRUCTURAL partial fix for the recurring `fix-outcome:blocked-workflows-scope` burn
 * (escalation #3887, bucket 6×/14d: #3869 #3839 #3820 #3800 #3776). The autonomous
 * `issue-fix` agent repeatedly spent ~1M tokens diagnosing and implementing fixes that
 * require .github/workflows/** changes, only to fail at `git push` (GH_TOKEN lacks
 * `workflows` scope). The prose rule ("detect early, terminate") was not load-bearing.
 *
 * This script makes the detection EXECUTABLE and deterministic for issues that
 * EXPLICITLY cite .github/workflows/** paths anywhere in their body — code blocks,
 * backtick refs, or plain markdown prose/bullets (e.g. a "File di partenza" list item,
 * see issue #4518). For such issues it short-circuits BEFORE Claude runs, posting the
 * blocked comment + FIX_OUTCOME marker and emitting `workflows_blocked=true` so the
 * Claude job is skipped via its `if:` condition → zero Max OAuth quota spent.
 *
 * COMPLEMENT: The .githooks/pre-commit hook handles the harder case where the fix target
 * is discovered DURING diagnosis (agent implements, commits, hook fires at commit time
 * with a clear "use PAT" message). Three guards now cover the class:
 *   - Mode 1 (this file, body-explicit paths): zero implementation tokens wasted.
 *   - Mode 2 (this file, recurrence — see below): zero DIAGNOSIS tokens wasted on a
 *     repeat of an already-diagnosed-and-blocked failure.
 *   - pre-commit hook: catches diagnosis-discovered paths → implementation tokens spent
 *     but push/confusion tokens saved and a clean FIX_OUTCOME posted.
 *
 * WIRING: this script was originally built (escalation #3887) but never actually wired
 * into issue-fix.yml — the docstring here used to say wiring "requires a human with
 * `workflows` scope PAT", which was WRONG: adding a plain step to a workflow YAML file is
 * a normal code change pushed through a PR by a human/interactive session (this repo's own
 * `Valerie Linc` git identity, not the constrained `issue-fix` runtime GH_TOKEN) — no scope
 * grant needed. That confusion is exactly why the bucket kept recurring after this script
 * existed (issue #4227): a real, designed gate sat orphaned. Fixed by #4227 — see
 * .github/workflows/issue-fix.yml, step "Pre-flight — workflows-scope capability guard".
 *
 * ─── Mode 2: CI-timeout recurrence detector (issue #4227) ──────────────────────────────
 *
 * Mode 1 only fires when the issue BODY explicitly cites a `.github/workflows/**` path.
 * The actual dominant recurring case (verified against #4140/#4160/#4189/#4244/#4256/
 * #4322/#4365/#4375 — the 13 examples cited by the #4227 escalation) is auto-filed
 * `scan-job-timeouts.mjs` issues ("CI Failure: <workflow display name>", label
 * `ci-timeout`): the body only says `**Workflow:** <name>` + a run URL, NEVER a
 * `.github/workflows/**` path — so Mode 1 never fires on them. In every sampled case
 * Claude still correctly diagnosed root cause (checkout eating the timeout, or
 * `timeout-minutes` too low) and correctly self-terminated with `blocked-workflows-scope`
 * — but paid the FULL diagnosis cost every single time, because each recurrence of the
 * SAME underlying workflow failure opens a FRESH issue (the old one auto-closes when a
 * later run happens to go green, per `scan-job-timeouts.mjs`'s dedup-only-while-open
 * convention) with the IDENTICAL stable title. Verified live: `CI Failure: Refresh
 * thin-page promotions` recurred across 8 distinct issue numbers (#4100→#4375) in one
 * week, each independently re-diagnosing the identical `refresh-thin-promotions.yml`
 * checkout-timeout root cause the fixer had already found — and already correctly
 * reported as blocked — days earlier.
 *
 * Mode 2 closes that gap: for ANY issue with a title, search for a PRIOR issue with the
 * EXACT SAME title (GitHub search + client-side exact-match filter, not fuzzy) that
 * already carries a `<!-- FIX_OUTCOME: blocked-workflows-scope -->` marker in one of its
 * comments. A match is unambiguous evidence that THIS exact recurring failure was already
 * root-caused and is durably blocked on a human/PAT applying the workflow-file fix — so
 * short-circuit immediately instead of re-running the same diagnosis for the Nth time.
 *
 * ─── Mode 2 generalized beyond ci-timeout (escalation #4749) ───────────────────────────
 *
 * Mode 2 originally only ran when `isCiTimeoutIssue()` matched (the `ci-timeout` label or
 * the scan-job-timeouts.mjs signature string) — it was designed against the 13 CI-timeout
 * examples cited by #4227. Escalation #4749 (bucket recurred 11×/14d AFTER #4227 shipped)
 * found the identical exact-stable-title recurrence pattern in OTHER monitor-filed
 * categories that the ci-timeout-only gate was silently excluding from Mode 2 entirely —
 * each one re-paid the FULL diagnosis cost despite a prior identically-titled issue
 * already carrying the marker:
 *   - "Deploy: en locale shard push failed (stale live locale)": #4658 already marked,
 *     #4706 re-diagnosed from scratch.
 *   - "Traffic data is stale — cron may have failed": #3839/#3869/#4166/#4390 already
 *     marked (FOUR priors), #4705 still re-diagnosed from scratch.
 *   - "Pages publish lag: built content not yet live": #4538 already marked, #4670
 *     re-diagnosed from scratch.
 * None of these carry the `ci-timeout` label or the scan-job-timeouts.mjs signature, so
 * `isCiTimeoutIssue()` returned false and Mode 2 never even attempted the recurrence
 * lookup for them — the PROCEED-SAFE exact-title+marker check below never got a chance to
 * fire. That gate was an accident of Mode 2's original scope, not a safety requirement:
 * the exact-title-match + verbatim-marker check is what makes a match trustworthy,
 * regardless of which monitor auto-filed the issue. Mode 2 now runs for every issue with
 * a title (isCiTimeoutIssue is kept as a named/tested predicate but no longer gates it).
 *
 * PROCEED-SAFE for Mode 2 specifically: requires an EXACT title match (not substring/
 * fuzzy) to a PRIOR issue (excludes itself) that carries the marker VERBATIM. No title
 * match, no marker, or any `gh`/parse failure → proceeds normally (bias to let the normal
 * fixer diagnose fresh rather than risk dropping a issue whose fix has since changed shape).
 *
 * WIRING (documented here as a PR diff, applied by #4227):
 *   In .github/workflows/issue-fix.yml, add after the `preflight` step:
 *
 *     - name: Pre-flight — workflows-scope capability guard (zero-Claude)
 *       id: scope_guard
 *       if: steps.preflight.outputs.already_resolved != 'true'
 *       continue-on-error: true
 *       env:
 *         GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
 *         GH_REPO: ${{ github.repository }}
 *         ISSUE_NUMBER: ${{ github.event.issue.number }}
 *       run: node scripts/ci/check-workflows-scope.mjs
 *
 *   Then add `&& steps.scope_guard.outputs.workflows_blocked != 'true'` to every downstream
 *   step `if:` that already gates on `already_resolved != 'true'` (tier, resume, git
 *   identity, headroom, Run Claude fix, usage metrics, max-turns telemetry, backstop
 *   telemetry, classify outcome).
 *
 * ─── Mode 1 delegates to the shared detector (issue #5595) ────────────────────────────
 *
 * `isExclusivelyWorkflowScoped` re-derived its verdict here instead of calling
 * `detectWorkflowScoped`, and the two had drifted apart again — the #4437 asymmetry with
 * the signs swapped. It also read the BODY alone, so the monitor-auto-file family, whose
 * workflow subject is stated in the TITLE ("Workflow Failure: <name>"), could not be seen
 * by Mode 1 at all. Both are fixed by delegating and by passing title+labels. The
 * false-positive half of the same issue (a planning issue citing one optional workflow
 * alongside six code targets written as `src/foo/bar.*`) is fixed inside the shared
 * module — see its docstring, "The bias was DECLARED but not HONOURED".
 *
 * PROCEED-SAFE (bias to proceed — a false positive silently drops a legitimate fix,
 * far worse than a false negative that lets the pre-commit hook or prose rule handle it):
 *   - Mode 1 triggers on workflow file reference(s) with NO non-workflow code path
 *     co-cited, or on a monitor auto-file whose title/label names a failed workflow.
 *     Prose mentions ("the workflow was failing") are ignored.
 *   - Mode 2 only triggers on an EXACT prior-title match carrying the marker verbatim.
 *   - Any ambiguity or parse failure → emit workflows_blocked=false, proceed normally.
 *   - Aggregate issues are NOT short-circuited (one item non-blocked ≠ all safe).
 *
 * ─── Two outcome codes, not one (issue #5288) ─────────────────────────────────────────
 *
 * Mode 1 and Mode 2 used to post the SAME `<!-- FIX_OUTCOME: blocked-workflows-scope -->`
 * marker, which made the marker mean two different things:
 *   - Mode 1 / the agent: "this run genuinely could not push a `.github/workflows/**`
 *     file" — a capability failure, and legitimate recurring-burn signal.
 *   - Mode 2: "an identically-titled prior issue already carries that verdict, so this
 *     run is deliberately NOT re-paying for the same diagnosis" — a guard doing exactly
 *     its job, at zero cost.
 * Counting the second as the first makes a WORKING guard raise the very bucket whose
 * recurrence triggers the escalation, so the escalation can re-fire precisely because the
 * fix is working. Mode 2 therefore emits its own code, `skip-duplicate-diagnosis`:
 *   - carved out of `isEscalationDriver` (harvest-agent-lessons.mjs) — a deterministic
 *     zero-Claude skip is not a rule an agent violated, so it can never drive a proposal;
 *   - kept in `NON_RETRYABLE` (followup-drainer.mjs) — the verdict is deterministic, so
 *     re-queueing reproduces it; parking immediately is the pre-existing behaviour and
 *     must not regress with the rename.
 * The `blocked-workflows-scope` LABEL stays on both paths on purpose: the durable state
 * of the issue really is "blocked on workflows scope" either way, and the escalation
 * buckets on the marker, not on the label.
 *
 * Scope note, measured not assumed: harvest-agent-lessons.mjs already skips comments
 * containing `Pre-flight (auto, zero-Claude)` — this script's own signature — so Mode 2
 * was NOT inflating the live bucket through the harvester tally today (the 5288 examples
 * #5222/#5256/#5279/#5282 are all `claude`-authored real runs). The separation removes the
 * ambiguity at the source rather than leaving it to a substring filter that any comment
 * rewording would silently defeat.
 *
 * On detection: removes `agent:fix` label, adds `blocked-workflows-scope` advisory,
 * posts ONE comment (paths found, or the prior-issue link for Mode 2) + FIX_OUTCOME
 * marker (`blocked-workflows-scope` for Mode 1, `skip-duplicate-diagnosis` for Mode 2).
 * Does NOT close the issue.
 *
 * Output (GITHUB_OUTPUT): `workflows_blocked=true|false`.
 * issue-fix.yml gates the Claude step on `workflows_blocked != 'true'`.
 *
 * Env:
 *   GH_TOKEN       required for gh reads/writes
 *   GH_REPO        optional `owner/repo`
 *   ISSUE_NUMBER   required
 *   DRY_RUN        "1" → detect + print, no side effects, still emits output
 *   GITHUB_OUTPUT  optional Actions step output file
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_PATH_RE,
  detectWorkflowScoped,
  extractWorkflowRefs,
  isMonitorFiledWorkflowFailure,
} from '../lib/workflow-scope-detect.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const OUTCOME_MARKER = '<!-- FIX_OUTCOME: blocked-workflows-scope -->';
const OUTCOME_MARKER_RE = /<!--\s*FIX_OUTCOME:\s*blocked-workflows-scope\s*-->/i;
// Mode 2 has its OWN outcome code (issue #5288). See `hasPriorDiagnosisMarker` below for
// why conflating the two was wrong: `blocked-workflows-scope` means "this run could not
// push a workflow file", while Mode 2 means "a prior identically-titled issue already
// carries that verdict, so we are not paying for the diagnosis a second time". The second
// is a guard WORKING, not a capability failure, and the two must not share a bucket key.
const DUP_OUTCOME_MARKER = '<!-- FIX_OUTCOME: skip-duplicate-diagnosis -->';
const DUP_OUTCOME_MARKER_RE = /<!--\s*FIX_OUTCOME:\s*skip-duplicate-diagnosis\s*-->/i;
const BLOCKED_LABEL = 'blocked-workflows-scope';
const PARKED_LABEL = 'fu-parked';
// Signature string scan-job-timeouts.mjs stamps into every issue it auto-files —
// see that script's issue-body template. Used (Mode 2) to recognize the auto-filed
// CI-timeout shape without depending on the `ci-timeout` label alone (label taxonomy
// can drift; the body signature is the script's own literal output).
const SCAN_JOB_TIMEOUTS_SIGNATURE = 'scripts/ci/scan-job-timeouts.mjs';
// Cap on how many same-titled prior issues Mode 2 inspects for a marker — bounds the
// `gh issue view` fan-out per run. 8 distinct recurrences of the same title were
// observed live in one week (#4100→#4375, "CI Failure: Refresh thin-page promotions");
// 10 gives headroom without letting a pathological title balloon the API calls.
const RECURRENCE_SCAN_CAP = 10;

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function setOutput(blocked) {
  console.log(`workflows_blocked=${blocked}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `workflows_blocked=${blocked}\n`);
  }
}

// Matches `.github/workflows/<name>.yml` (or `.yaml`) ANYWHERE in the body text —
// backticks, fenced code blocks, or bare markdown prose/bullets. The extension
// anchor (`\.ya?ml\b`) makes this precise even outside backticks/fences: no bare
// `.yml` name matches without the literal `.github/workflows/` prefix, and no
// generic prose ("the traffic-scheduler workflow") matches without the literal
// path substring. Imported from ../lib/workflow-scope-detect.mjs, shared with
// followup-drainer.mjs's `detectWorkflowScoped` — see issue #4518 module
// docstring below for why the previous backtick/fence-only version under-detected,
// and #4437 (module docstring "Mode 1 exclusivity gate") for why plain path
// extraction alone is not sufficient to decide BLOCKED.

/**
 * Extract explicit .github/workflows/** path references from an issue body.
 *
 * Scans the ENTIRE body text, not just backtick refs or fenced code blocks (issue
 * #4518: the original version only matched those two shapes and missed the common
 * "File di partenza" bullet-list shape — `- .github/workflows/foo.yml (cron gia
 * attivo)`, plain markdown, no backticks/fence — sampled live on issue #4453,
 * which slipped through Mode 1 and cost a full Claude turn-1 self-termination
 * instead of a zero-Claude short-circuit).
 *
 * Returns an array of unique matched paths (empty if none found).
 */
export function extractWorkflowPaths(body) {
  const text = body || '';
  return [...new Set(text.match(WORKFLOW_PATH_RE) || [])];
}

/**
 * Mode 1 exclusivity gate (issue #4437): a body citing a `.github/workflows/**` path is
 * BLOCKED only if it does NOT also cite a non-workflow code path (scripts/build-plugins/
 * services/components/hooks/build/src/...). A false positive was observed live on issue
 * #4437: the body mentioned `.github/workflows/send-job-alerts.yml` only in passing (a
 * "live-verification, manual post-deploy" checklist bullet pointing at where the cron
 * runs), while the actual required fix lived entirely in `scripts/send-job-alerts.mjs` —
 * a normal script file. Because `extractWorkflowPaths` alone had no exclusion,
 * check-workflows-scope.mjs blocked the issue every time it got promoted, while
 * followup-drainer.mjs's OWN pre-flight (`detectWorkflowScoped`, which DOES exclude on
 * code refs) correctly judged it promotable — the asymmetry drove an infinite
 * block→unroute→requeue→promote→block loop (~4h cadence, 51 comments over 9 days) and
 * the real funnel-monetization bug never got a genuine fix attempt.
 * CONSERVATIVE (bias to PROMOTE): mirrors followup-drainer.mjs's `detectWorkflowScoped`.
 *
 * "Mirrors" is now literal — this DELEGATES to that detector instead of re-deriving the
 * verdict from `extractWorkflowPaths` + `hasNonWorkflowCodeRefs` (issue #5595). The
 * re-derivation had drifted back into an asymmetry of exactly the #4437 shape, only
 * reversed: the drainer counts a bare `<name>.yml` as a workflow reference and Mode 1 did
 * not, so the two guards disagreed on every issue that names a workflow without its
 * `.github/workflows/` prefix. Sharing one function is the property this module was
 * extracted to guarantee; deriving it twice is how it was lost.
 *
 * `meta` carries the issue title and labels, which the shared detector needs for the
 * monitor-auto-file check (`isMonitorFiledWorkflowFailure`) — Mode 1 used to read the
 * body alone, so an issue whose workflow subject is stated only in its TITLE
 * ("Workflow Failure: Generate Blog Article") was invisible to it. Omitting `meta` keeps
 * the pre-#5595 body-only semantics for callers that have nothing else.
 *
 * @param {string} body
 * @param {{ title?: string, labels?: Array<string|{name?: string}> }} [meta]
 */
export function isExclusivelyWorkflowScoped(body, meta = {}) {
  const title = (meta && meta.title) || '';
  return detectWorkflowScoped(`${title}\n${body || ''}`, {
    title,
    labels: meta && meta.labels,
  });
}

/**
 * Does this issue look like a `scan-job-timeouts.mjs` auto-file ("Job cancellato per
 * timeout")? Two independent signals (either is sufficient) so a missing/renamed label
 * doesn't blind the detector to the script's own literal output:
 *   - the `ci-timeout` label, or
 *   - the scan script's signature string verbatim in title+body.
 *
 * NOT used to gate Mode 2 (broadened by #4749 — see module docstring "Mode 2
 * generalized"); kept as a named/tested predicate for callers that specifically need to
 * distinguish CI-timeout auto-files from other monitor-filed categories.
 */
export function isCiTimeoutIssue({ title, body, labels } = {}) {
  const text = `${title || ''}\n${body || ''}`;
  const labelNames = (labels || [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
  return labelNames.includes('ci-timeout') || text.includes(SCAN_JOB_TIMEOUTS_SIGNATURE);
}

/** True if any comment body carries the blocked-workflows-scope FIX_OUTCOME marker. */
export function hasBlockedWorkflowsScopeMarker(commentBodies) {
  return (commentBodies || []).some((b) => OUTCOME_MARKER_RE.test(String(b || '')));
}

/** True if any comment body carries the skip-duplicate-diagnosis FIX_OUTCOME marker. */
export function hasSkipDuplicateDiagnosisMarker(commentBodies) {
  return (commentBodies || []).some((b) => DUP_OUTCOME_MARKER_RE.test(String(b || '')));
}

/**
 * Mode 2's recurrence test: has this prior issue ALREADY been settled on the
 * workflows-scope root cause, by either route?
 *
 * Both markers count, and the chain breaks without that (issue #5288). The first
 * occurrence of a recurring failure is settled with `blocked-workflows-scope` — by the
 * agent itself or by Mode 1. Every later occurrence is now settled with
 * `skip-duplicate-diagnosis`. If the lookup only accepted the first code, the Nth
 * recurrence could only be recognised via the ORIGINAL issue, and the original falls out
 * of view as soon as the newest RECURRENCE_SCAN_CAP same-titled issues are all
 * skip-marked — at which point the guard would silently stop firing and the full
 * diagnosis cost would come back. Accepting either marker keeps each recurrence able to
 * seed the next, which is the behaviour the single shared marker used to provide.
 */
export function hasPriorDiagnosisMarker(commentBodies) {
  return hasBlockedWorkflowsScopeMarker(commentBodies) || hasSkipDuplicateDiagnosisMarker(commentBodies);
}

/**
 * From a list of `gh issue list --json number,title,createdAt` candidates, return the
 * most recent prior issues (excluding `currentIssueNumber`) whose title EXACTLY matches
 * `title` — GitHub search is a fuzzy full-text match server-side, so the exact-equality
 * filter here is what makes this PROCEED-SAFE (no substring/near-title false positives).
 * Sorted newest-first, capped at RECURRENCE_SCAN_CAP.
 */
export function filterExactTitleRecurrences(candidates, title, currentIssueNumber) {
  return (candidates || [])
    .filter((c) => c && c.title === title && String(c.number) !== String(currentIssueNumber))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, RECURRENCE_SCAN_CAP);
}

/**
 * Shared side-effects for a BLOCKED verdict (either mode): post the advisory comment
 * (body already includes the OUTCOME_MARKER), remove `agent:fix` (no re-dispatch),
 * ensure the `blocked-workflows-scope` label exists, apply it, and add `fu-parked`.
 * Best-effort (`allowFail: true` throughout) — a comment/label API hiccup must never
 * throw past the `workflows_blocked=true` output already decided.
 *
 * `fu-parked` is required (issue #4437): without a `ROUTING_LABELS` member on the
 * issue, `issue-triage.yml`'s sweep treats a blocked issue as "unrouted" and re-queues
 * it every ~4h, which the drainer then re-promotes and this script re-blocks — forever.
 * Adding `fu-parked` here marks it terminal so the sweep leaves it alone.
 */
function applyBlockedOutcome(comment) {
  gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
  gh(['issue', 'edit', ISSUE, ...repoArgs, '--remove-label', 'agent:fix'], { allowFail: true });
  gh(
    [
      'label',
      'create',
      BLOCKED_LABEL,
      '--color',
      'e4e669',
      '--description',
      'Fix requires .github/workflows scope PAT — auto-fix skipped',
      ...repoArgs,
    ],
    { allowFail: true },
  );
  gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', BLOCKED_LABEL], { allowFail: true });
  gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', PARKED_LABEL], { allowFail: true });
}

/**
 * gh-backed half of Mode 2: search for prior issues with the exact same title, then
 * check each (newest-first, capped) for a blocked-workflows-scope marker in its
 * comments. Returns `{ issueNumber, createdAt }` of the first (most recent) match, or
 * `null`. Any `gh`/parse failure at any stage → `null` (bias to proceed).
 */
function findRecentBlockedRecurrence(title) {
  const searchRaw = gh(
    [
      'issue',
      'list',
      ...repoArgs,
      '--state',
      'all',
      '--search',
      `in:title "${title}"`,
      '--json',
      'number,title,createdAt',
      '--limit',
      '15',
    ],
    { allowFail: true },
  );
  if (!searchRaw) return null;

  let candidates;
  try {
    candidates = JSON.parse(searchRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(candidates)) return null;

  const recurrences = filterExactTitleRecurrences(candidates, title, ISSUE);
  for (const cand of recurrences) {
    const commentsRaw = gh(
      ['issue', 'view', String(cand.number), ...repoArgs, '--json', 'comments'],
      { allowFail: true },
    );
    if (!commentsRaw) continue;
    let commentsJson;
    try {
      commentsJson = JSON.parse(commentsRaw);
    } catch {
      continue;
    }
    const bodies = (commentsJson.comments || []).map((c) => c && c.body);
    if (hasPriorDiagnosisMarker(bodies)) {
      return { issueNumber: cand.number, createdAt: cand.createdAt };
    }
  }
  return null;
}

function main() {
  if (!ISSUE) {
    console.error('ISSUE_NUMBER not set — proceeding (no gate).');
    setOutput(false);
    return;
  }

  const raw = gh(
    ['issue', 'view', ISSUE, ...repoArgs, '--json', 'number,title,body,labels,state'],
    { allowFail: true },
  );
  if (!raw) {
    console.log('Issue fetch failed — proceeding.');
    setOutput(false);
    return;
  }

  let iss;
  try {
    iss = JSON.parse(raw);
  } catch {
    console.log('Issue parse failed — proceeding.');
    setOutput(false);
    return;
  }

  // Closed issues: issue-fix.yml already guards on OPEN state; this is belt-and-suspenders.
  if (String(iss.state || '').toUpperCase() === 'CLOSED') {
    console.log(`Issue #${ISSUE} is CLOSED — skip guard (no work on a closed issue).`);
    setOutput(false);
    return;
  }

  const body = iss.body || '';
  const title = iss.title || '';

  // Extract explicit .github/workflows/** path references from the issue body.
  const workflowPaths = extractWorkflowPaths(body);
  const monitorFiled = isMonitorFiledWorkflowFailure({ title, labels: iss.labels });

  if (!isExclusivelyWorkflowScoped(body, { title, labels: iss.labels })) {
    // Mode 1 found no *exclusive* workflow-scope signal — either no path at all, or a
    // path co-cited with a non-workflow code path (issue #4437: the real fix may live in
    // that code file — see `isExclusivelyWorkflowScoped` docstring). Mode 2: does a PRIOR
    // issue with the exact same stable title already carry a blocked-workflows-scope
    // marker? (issue #4227, broadened by #4749 — see module docstring "Mode 2" for the full
    // rationale/evidence.) Applied to EVERY issue with a title, not just
    // scan-job-timeouts.mjs ci-timeout auto-files: escalation #4749 found the same
    // exact-stable-title recurrence pattern in several other monitor-filed categories
    // (post-deploy validate-dist, locale-shard-stale, traffic-freshness,
    // publish-lag-watchdog) that the ci-timeout-only gate was silently excluding —
    // e.g. #4658 already carried the marker for "Deploy: en locale shard push failed
    // (stale live locale)" yet #4706 re-ran the full diagnosis from scratch; likewise
    // #3839/#3869/#4166/#4390 for "Traffic data is stale — cron may have failed" before
    // #4705 repeated it, and #4538 for "Pages publish lag: built content not yet live"
    // before #4670 repeated it. The exact-title-match + verbatim-marker requirement
    // (filterExactTitleRecurrences / hasBlockedWorkflowsScopeMarker) is already the
    // PROCEED-SAFE guardrail — it does not depend on the issue being a CI-timeout
    // auto-file, so restricting it to that one category was an unnecessary gap, not a
    // safety requirement. isCiTimeoutIssue is kept as a named predicate (still used/
    // tested) but no longer gates whether Mode 2 runs.
    if (title) {
      const recurrence = findRecentBlockedRecurrence(title);
      if (recurrence) {
        console.log(
          `Issue #${ISSUE}: BLOCKED (recurrence) — issue #${recurrence.issueNumber} ` +
            `(created ${recurrence.createdAt}, identical title) already diagnosed and ` +
            `marked blocked-workflows-scope. Skipping re-diagnosis.`,
        );
        if (!DRY_RUN) {
          const comment =
            `⏭️ **Pre-flight (auto, zero-Claude) — recurrence, blocco scope \`workflows\`**\n\n` +
            `Questa issue ha lo STESSO titolo esatto di #${recurrence.issueNumber} ` +
            `(${recurrence.createdAt}), già diagnosticata e chiusa con \`blocked-workflows-scope\`: ` +
            `la root cause è nel workflow YAML e richiede una PAT con scope \`workflows\` o ` +
            `intervento manuale, non ancora applicato. Ri-diagnosticare da zero brucerebbe di ` +
            `nuovo l'intero budget del run senza convergere — vedi la diagnosi completa su ` +
            `#${recurrence.issueNumber}.\n\n` +
            `Rimossa la label \`agent:fix\` (no re-dispatch). Gate strutturale #4227/#4749.\n\n` +
            DUP_OUTCOME_MARKER;
          applyBlockedOutcome(comment);
        }
        setOutput(true);
        return;
      }
      console.log(
        `Issue #${ISSUE}: no prior issue with the exact same title carries a ` +
          `blocked-workflows-scope marker — proceeding (fresh diagnosis).`,
      );
    }

    // Not exclusively workflow-scoped, no recurrence match → proceed. The pre-commit hook
    // handles fixes discovered during agent diagnosis.
    console.log(
      workflowPaths.length > 0
        ? `Issue #${ISSUE}: workflow path(s) co-cited with non-workflow code path(s) — ` +
            `proceeding (fix may live in code; pre-commit hook guards diagnosis-time ` +
            `discoveries).`
        : `Issue #${ISSUE}: no explicit .github/workflows/** paths in body — proceeding ` +
            `(pre-commit hook guards diagnosis-time discoveries).`,
    );
    setOutput(false);
    return;
  }

  // STRONG SIGNAL: either the monitor that filed this issue named a failing workflow as
  // its subject, or the body cites workflow file(s) and no non-workflow code path.
  const wfRefs = extractWorkflowRefs(`${title}\n${body}`);
  console.log(
    monitorFiled
      ? `Issue #${ISSUE}: BLOCKED — monitor auto-file on a workflow failure (title/label), ` +
          `subject is a .github/workflows/** file.`
      : `Issue #${ISSUE}: BLOCKED — workflow file reference(s), no non-workflow code path:\n` +
          wfRefs.map((p) => `  ${p}`).join('\n'),
  );

  if (!DRY_RUN) {
    // `workflowPaths` (full `.github/workflows/**` paths) when we have them, else the
    // bare `<name>.yml` refs; a monitor auto-file usually has neither in its body — its
    // subject is the workflow named in the title.
    const shown = (workflowPaths.length ? workflowPaths : wfRefs).map((p) => `- \`${p}\``).join('\n');
    const why = monitorFiled
      ? `Issue aperta automaticamente da un monitor CI su un **fallimento di workflow** ` +
        `(titolo \`Workflow Failure:\`/\`CI Failure:\` o label \`ci-timeout\`): il soggetto ` +
        `è un file \`.github/workflows/**\`.${shown ? `\n${shown}` : ''}`
      : `L'issue cita file di workflow e nessun path di codice non-workflow:\n${shown}`;
    const comment =
      `⏭️ **Pre-flight (auto, zero-Claude) — blocco scope \`workflows\`**\n\n` +
      `${why}\n\n` +
      `L'ambiente \`issue-fix.yml\` usa \`GH_TOKEN\` (GitHub App — nessun scope \`workflows\`): ` +
      `il push di questi file fallisce sempre. Fix richiede una PAT con scope \`workflows\` ` +
      `o intervento manuale.\n\n` +
      `Rimossa la label \`agent:fix\` (no re-dispatch). Gate strutturale #3887/#5595. ` +
      `**Riapribile**: togli \`fu-parked\` se il contesto cambia (PAT abilitato, oppure il ` +
      `fix si rivela vivere nel codice e non nel workflow).\n\n` +
      OUTCOME_MARKER;

    applyBlockedOutcome(comment);
  }

  setOutput(true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(
      'Scope-guard error — proceeding (normal fixer runs):',
      e && e.message ? e.message : e,
    );
    setOutput(false);
    process.exit(0);
  }
}
