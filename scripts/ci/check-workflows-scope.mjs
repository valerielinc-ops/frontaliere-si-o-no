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
 * PROCEED-SAFE (bias to proceed — a false positive silently drops a legitimate fix,
 * far worse than a false negative that lets the pre-commit hook or prose rule handle it):
 *   - Mode 1 only triggers on EXPLICIT .github/workflows/** path mentions in backtick refs
 *     or code blocks. Prose mentions ("the workflow was failing") are ignored.
 *   - Mode 2 only triggers on an EXACT prior-title match carrying the marker verbatim.
 *   - Any ambiguity or parse failure → emit workflows_blocked=false, proceed normally.
 *   - Aggregate issues are NOT short-circuited (one item non-blocked ≠ all safe).
 *
 * On detection: removes `agent:fix` label, adds `blocked-workflows-scope` advisory,
 * posts ONE comment (paths found, or the prior-issue link for Mode 2) + FIX_OUTCOME
 * marker. Does NOT close the issue.
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

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const OUTCOME_MARKER = '<!-- FIX_OUTCOME: blocked-workflows-scope -->';
const OUTCOME_MARKER_RE = /<!--\s*FIX_OUTCOME:\s*blocked-workflows-scope\s*-->/i;
const BLOCKED_LABEL = 'blocked-workflows-scope';
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
// path substring. Mirrors the equivalent, already-proven full-text scan in
// followup-drainer.mjs's `detectWorkflowScoped` (WORKFLOW_PATH_RE) — see issue
// #4518 module docstring below for why the previous backtick/fence-only version
// under-detected.
const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/g;

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
 * ensure the `blocked-workflows-scope` label exists, and apply it. Best-effort
 * (`allowFail: true` throughout) — a comment/label API hiccup must never throw past
 * the `workflows_blocked=true` output already decided.
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
    if (hasBlockedWorkflowsScopeMarker(bodies)) {
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

  if (workflowPaths.length === 0) {
    // Mode 1 (explicit body paths) found nothing. Mode 2: does a PRIOR issue with the
    // exact same stable title already carry a blocked-workflows-scope marker? (issue
    // #4227, broadened by #4749 — see module docstring "Mode 2" for the full
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
            OUTCOME_MARKER;
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

    // No explicit workflow paths, no recurrence match → proceed. The pre-commit hook
    // handles fixes discovered during agent diagnosis.
    console.log(
      `Issue #${ISSUE}: no explicit .github/workflows/** paths in body — proceeding ` +
        `(pre-commit hook guards diagnosis-time discoveries).`,
    );
    setOutput(false);
    return;
  }

  // STRONG SIGNAL: explicit workflow paths found in the issue body.
  console.log(
    `Issue #${ISSUE}: BLOCKED — explicit .github/workflows/** paths found:\n` +
      workflowPaths.map((p) => `  ${p}`).join('\n'),
  );

  if (!DRY_RUN) {
    const pathList = workflowPaths.map((p) => `- \`${p}\``).join('\n');
    const comment =
      `⏭️ **Pre-flight (auto, zero-Claude) — blocco scope \`workflows\`**\n\n` +
      `L'issue body cita esplicitamente file in \`.github/workflows/\`:\n${pathList}\n\n` +
      `L'ambiente \`issue-fix.yml\` usa \`GH_TOKEN\` (GitHub App — nessun scope \`workflows\`): ` +
      `il push di questi file fallisce sempre. Fix richiede una PAT con scope \`workflows\` ` +
      `o intervento manuale.\n\n` +
      `Rimossa la label \`agent:fix\` (no re-dispatch). Gate strutturale #3887.\n\n` +
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
