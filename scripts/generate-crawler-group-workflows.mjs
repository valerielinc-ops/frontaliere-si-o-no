#!/usr/bin/env node
/**
 * scripts/generate-crawler-group-workflows.mjs
 *
 * Generates the 23 grouped crawler GitHub Actions workflows
 * (.github/workflows/crawler-group-NN.yml) from:
 *   - data/crawler-manifest.json              (per-crawler step manifest)
 *   - data/crawler-workflow-duration-baseline.json (historical avg durations)
 *
 * WHY: 581 individual `update-jobs-*.yml` workflows each held one of
 * GitHub Free tier's 20 concurrent-job slots for their full duration
 * (mean ~26.6min, max ~160min for Coop), starving other CI (PR tests,
 * review-loop). GitHub Actions' "parallel steps" feature lets multiple
 * `background: true` run-steps execute concurrently WITHIN ONE job, which
 * holds only ONE concurrent slot no matter how many crawlers it contains.
 * A `wait-all: true` step rejoins them; a failed background step fails
 * the job.
 *
 * DESIGN CONSTRAINT (owner-mandated): every crawler's commit-and-push and
 * error-reporting mechanism must remain EXACTLY as implemented in its own
 * script — no shared/generic commit or error-reporting step. Because GitHub
 * Actions `background: true` applies to a single self-contained `run:`
 * step (not a group of steps), each crawler's entire per-crawler sequence
 * (run script -> housekeeping -> commit+push -> failure report) is inlined
 * as ONE shell script body per background step, using each crawler's own
 * verbatim `run:` bodies (extracted from its original workflow) concatenated
 * in original order — nothing shared/generic is introduced, only the
 * ORIGINAL per-crawler shell fragments spliced together.
 *
 * TWO CONCURRENCY HAZARDS this generator fixes at the callsite (not in the
 * shared libraries, which stay untouched and correct for standalone/manual
 * dispatch use):
 *
 *  1. scripts/lib/slug-history-journal.mjs writes per-run telemetry to
 *     `process.env.SLUG_HISTORY_SUMMARY_FILE || /tmp/slug-history-summary-${pid}.txt`.
 *     scripts/lib/git-commit-data.sh, when the env var is unset, falls back
 *     to `ls -t /tmp/slug-history-summary-*.txt | head -1` — the globally
 *     newest file, with NO crawler-name binding — reads it into THAT
 *     crawler's commit message, then deletes it. When multiple crawlers
 *     share one job's /tmp as concurrent background steps, one crawler's
 *     commit step can steal + delete a sibling's telemetry file
 *     (misattributed commit-message body + silent loss). Fix: every
 *     generated background step sets
 *     `SLUG_HISTORY_SUMMARY_FILE=/tmp/slug-history-summary-<slug>.txt`
 *     (unique per crawler name).
 *
 *  2. scripts/lib/git-commit-data.sh runs `git add`/`git commit` directly
 *     against the shared working-copy `.git/index` with no locking. That is
 *     safe when each crawler is its own separate runner/clone (today's
 *     architecture), but multiple background steps in ONE job share the
 *     SAME working directory and .git/index — concurrent `git add`/`git
 *     commit` invocations would race on the index. Fix: each crawler's
 *     commit+push invocation is wrapped in `flock` against a shared
 *     lockfile (`/tmp/crawler-group-git.lock`), serializing ONLY the
 *     commit-and-push moment (a few seconds) while the actual crawl/fetch
 *     work (the slow part) still runs fully concurrently. This does not
 *     change what is committed or how — it only serializes WHEN the git
 *     commands run relative to siblings, exactly mirroring how the retry
 *     logic already inside git-commit-data.sh handles remote-side
 *     conflicts (this closes the *local*-index race the same script has no
 *     visibility into).
 *
 * Re-run this script any time a crawler is added/removed/renamed, or the
 * duration baseline is refreshed (see
 * data/crawler-workflow-duration-baseline.json header). Output is fully
 * deterministic given the same manifest + baseline inputs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { applyProfilesToFile } from './ci/apply-checkout-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MANIFEST_PATH = path.join(REPO_ROOT, 'data/crawler-manifest.json');
const BASELINE_PATH = path.join(REPO_ROOT, 'data/crawler-workflow-duration-baseline.json');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');

export const GROUP_COUNT = 23;
// Coop's ~160min run is a wall-clock outlier ~2.75x the next-longest crawler,
// far above the corpus. Bundling it into an otherwise-balanced group would
// make that group's wall-clock dominated entirely by Coop, wasting the slot
// budget of every OTHER crawler bundled with it. Isolate any crawler whose
// avg duration exceeds this multiple of the corpus median into its own
// single-member group instead.
export const OUTLIER_MEDIAN_MULTIPLE = 4;
// GitHub Actions hard job timeout is 360min (6h). Keep meaningful margin.
export const JOB_TIMEOUT_MINUTES = 340;
export const SAFETY_CEILING_MS = JOB_TIMEOUT_MINUTES * 60 * 1000;

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Bin-pack crawlers into `groupCount` groups. Group wall-clock = MAX member
 * duration (background steps run concurrently, not summed) — NOT a sum, so
 * standard LPT-for-makespan-by-sum does not directly apply: once a group's
 * bottleneck (its largest member so far) is set, adding any SMALLER member
 * is "free" in the max-cost metric. A naive "always add to the group with
 * the current lowest wallClockMs" greedy therefore degenerates: after every
 * group has one anchor member, it keeps picking whichever anchor happens to
 * be smallest-so-far and dumps the entire remaining corpus into it (verified
 * during development — 22 groups of 1 + 1 group of 559).
 *
 * Strategy actually used:
 *  1. Split off genuine duration outliers (> OUTLIER_MEDIAN_MULTIPLE *
 *     median) into their own singleton groups (e.g. Coop's ~160min run,
 *     ~6.5x the corpus median and ~1.85x the next-longest crawler).
 *  2. Sort the remainder descending by duration and deal the top
 *     `groupCount` of them one per group as "anchors" (this alone already
 *     minimizes the max bottleneck per group, same idea as LPT).
 *  3. For every item after that, balance by MEMBER COUNT (round-robin: pick
 *     the group with the fewest members so far, ties broken by lowest
 *     wallClockMs) rather than by wallClockMs — because wallClockMs no
 *     longer moves for any group once its anchor exceeds the new item's
 *     duration, so it stops being a useful signal past the anchor phase.
 *     This keeps every group's wall-clock bounded by its anchor while
 *     spreading the (much larger) tail of small/medium crawlers evenly
 *     across all groups instead of piling them into one.
 */
export function packGroups(crawlers, groupCount, medianMs) {
  const sorted = [...crawlers].sort((a, b) => b.durationMs - a.durationMs);

  const outliers = [];
  const rest = [];
  for (const c of sorted) {
    if (c.durationMs > medianMs * OUTLIER_MEDIAN_MULTIPLE) {
      outliers.push(c);
    } else {
      rest.push(c);
    }
  }

  // Reserve one singleton group per outlier, but never so many that fewer
  // than 1 group remains for everyone else.
  const maxOutlierGroups = Math.max(0, groupCount - 1);
  const isolatedOutliers = outliers.slice(0, maxOutlierGroups);
  const foldedBackOutliers = outliers.slice(maxOutlierGroups);

  const groups = [];
  for (const o of isolatedOutliers) {
    groups.push({ members: [o], wallClockMs: o.durationMs });
  }

  const remainingGroupCount = groupCount - groups.length;
  const regularGroups = [];
  for (let i = 0; i < remainingGroupCount; i++) {
    regularGroups.push({ members: [], wallClockMs: 0 });
  }
  groups.push(...regularGroups);

  const toPlace = [...foldedBackOutliers, ...rest].sort((a, b) => b.durationMs - a.durationMs);

  // Phase 1 (anchors): deal the next-longest items one per regular group,
  // establishing each group's initial bottleneck. Minimizes the max.
  const anchorCount = Math.min(regularGroups.length, toPlace.length);
  for (let i = 0; i < anchorCount; i++) {
    const item = toPlace[i];
    const target = regularGroups[i];
    target.members.push(item);
    target.wallClockMs = Math.max(target.wallClockMs, item.durationMs);
  }

  // Phase 2 (spread tail by count): every remaining item goes to the
  // currently-smallest-membership group, tie-broken by lowest wallClockMs,
  // so the long tail of small/medium crawlers is spread evenly instead of
  // collapsing into whichever anchor happens to be smallest.
  for (let i = anchorCount; i < toPlace.length; i++) {
    const item = toPlace[i];
    regularGroups.sort((a, b) => (a.members.length - b.members.length) || (a.wallClockMs - b.wallClockMs));
    const target = regularGroups[0];
    target.members.push(item);
    target.wallClockMs = Math.max(target.wallClockMs, item.durationMs);
  }

  return groups;
}

/** Render a single YAML `run:` block body with correct indentation. */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

/**
 * Build the single inline shell script for one crawler's background step:
 * run -> [if success: housekeeping -> commit+push (flock-serialized)] ->
 * [if failure: failure report], using each step's ORIGINAL `run:` body
 * verbatim. The success/failure gating mirrors GitHub Actions' own default
 * step semantics from the original per-crawler workflows (a failing "Run"
 * step with no `continue-on-error` halts subsequent ungated steps; only the
 * `if: failure()`-gated report step still runs).
 *
 * COMMIT-FAILURE VISIBILITY (post-#3701 fix): in every original individual
 * workflow, "Commit and push" had NO `continue-on-error` / `|| true` — a
 * failed commit/push (network blip, push-retry exhaustion, prune-abort; see
 * scripts/lib/git-commit-data.sh's own `exit 1` paths) failed the whole job,
 * which both surfaced as a visibly-red workflow run AND satisfied the
 * `if: failure()` guard on "Report failure to GitHub Issues". The flock
 * wrapper this generator adds (HAZARD FIX 2 below) used `|| true` on the
 * whole commit invocation, which — combined with `crawler_exit` being
 * captured only from the CRAWL step, before the commit step ever runs —
 * silently discarded the commit's exit code entirely: a crawler could scrape
 * successfully, fail to commit/push, and still report full success with no
 * failure issue and no data persisted. `set -uo pipefail` plus an explicit
 * `set +e` (see below) is used deliberately for this whole script, so a bare
 * non-zero exit from the flock command would NOT abort the script anyway —
 * the `|| true` was never load-bearing for that, and has been REMOVED: the
 * commit invocation's own exit code is now captured directly into
 * `git_commit_exit` via `$?` on the line immediately after it runs (an
 * `|| true` on that same line would make `$?` always read as 0 — the exit
 * code of the `true`, not of `flock` — so removing it is required for the
 * capture to work, not just cosmetic). With `set +e` explicitly cancelling
 * GitHub Actions' own `bash -e {0}` default, nothing aborts the script early
 * even without `|| true`. `git_commit_exit` is then
 * treated as equally significant as `crawler_exit` for both the
 * failure-report gate and this background step's own final exit code.
 */
export function buildCrawlerShellBody(crawler) {
  const lines = [];
  lines.push('set -uo pipefail');
  // GitHub Actions invokes `run:` steps as `bash -e {0}` by default (errexit
  // ON) — confirmed from a real run's `shell: /usr/bin/bash -e {0}` log line.
  // Without this explicit `set +e`, the FIRST non-zero exit anywhere below
  // (e.g. the crawler's own `run:` command failing) aborts this whole
  // composite script immediately: `crawler_exit=$?` is never reached, the
  // failure-report `if` block never runs, and no GitHub Issue gets created.
  // This was the root cause of zero "Crawler Failure" issues being filed
  // despite ~160 real crawler failures overnight post-#3701 — every failing
  // crawler killed its own background step's script before the report gate.
  lines.push('set +e');
  lines.push('');
  lines.push(`# ---- ${crawler.slug}: run crawler (verbatim from original workflow) ----`);
  lines.push(crawler.runStep.run.trimEnd());
  lines.push(`crawler_exit=$?`);
  // Default to 0 (no commit attempted / not yet run): if the crawl step
  // fails, the commit step below is skipped entirely (matching original
  // per-crawler behavior), so there is no commit failure to report in that
  // case — only the crawl failure. This variable is only ever overwritten
  // with a real exit code when the commit step actually executes.
  lines.push('git_commit_exit=0');
  lines.push('');

  for (const step of crawler.postSteps) {
    const isFailureReport = step.if === 'failure()';
    // Detect by invocation, not just by the literal step name: across the
    // real 581-crawler corpus this step is named either "Commit and push"
    // or "Commit updated data" (e.g. avaloq, livingcircle) — both invoke
    // scripts/lib/git-commit-data.sh and both need the same exit-code
    // capture, so match on the actual command rather than one hardcoded
    // name (a name-only check silently misses the "Commit updated data"
    // variant and reintroduces the exact same swallowed-failure bug under
    // a different step label).
    const isCommitStep = /git-commit-data\.sh/.test(step.run || '');

    if (isFailureReport) {
      // HAZARD FIX 3: `${{ github.workflow }}` used to be unique per crawler
      // (one crawler = one workflow), and scripts/lib/github-issue-creator.mjs
      // keys its title-based dedup + consecutive-failure escalation gate on
      // that value; scripts/ci/close-recovered-failure-issues.mjs later
      // parses it back out of the issue title to look up the workflow's
      // recovery status. Post-consolidation `${{ github.workflow }}` resolves
      // to the shared GROUP's name for every crawler in that group — left
      // as-is, it would collapse all ~25 crawlers' failure issues/dedup/gate
      // into one shared bucket per group, and no longer identify which
      // crawler broke. Substitute the runtime expression with a literal,
      // per-crawler-unique identifier baked in at generation time: the exact
      // background step name (`Run <slug>`) also used as this step's `name:`
      // in the generated YAML, so close-recovered-failure-issues.mjs can
      // resolve it back to a real, lookup-able step via the Jobs API.
      //
      // Gate on EITHER crawler_exit OR git_commit_exit being non-zero: a
      // crawler that scraped fine but failed to commit/push is just as much
      // a failure needing a report as one that failed to scrape (see
      // COMMIT-FAILURE VISIBILITY note above buildCrawlerShellBody).
      const crawlerWorkflowId = `Run ${crawler.slug}`;
      const literalizedRun = step.run
        .split('${{ github.workflow }}')
        .join(crawlerWorkflowId);
      lines.push(`# ---- ${crawler.slug}: ${step.name} (verbatim except github.workflow -> literal per-crawler id, only on crawler OR commit failure) ----`);
      // PUSH-CONTENTION CLASS (exit 42 from git-commit-data.sh): the crawl
      // succeeded and only the ref race was lost after every retry. That is a
      // SYSTEMIC condition (a burst of concurrent groups), not a per-crawler
      // signal: opening ~1 issue per losing crawler flooded the backlog with
      // ~150 identical crawler-transient breadcrumbs on 2026-07-10. Skip the
      // per-crawler issue for this class — the lost cycle self-heals at the
      // next scheduled run and PERSISTENT loss still surfaces via the
      // crawler-health staleness monitor. Any other non-zero exit keeps the
      // original reporting behavior.
      lines.push('if [ "$crawler_exit" -ne 0 ] || { [ "$git_commit_exit" -ne 0 ] && [ "$git_commit_exit" -ne 42 ]; }; then');
      lines.push(indentBlock(literalizedRun.trimEnd(), 2));
      lines.push('fi');
      lines.push('if [ "$crawler_exit" -eq 0 ] && [ "$git_commit_exit" -eq 42 ]; then');
      lines.push(`  echo "::warning::${crawler.slug}: crawl OK but push lost the ref race after all retries (contention). Cycle lost, self-heals next scheduled run — no issue filed (systemic class)."`);
      lines.push(`  echo "⚠️ ${crawler.slug}: push contention loss (exit 42) — crawl was fine, no issue filed" >> "$GITHUB_STEP_SUMMARY"`);
      lines.push('fi');
      lines.push('');
      continue;
    }

    // IMPORTANT: in every original individual workflow, the "Run ..." step
    // had NO `continue-on-error` and Housekeeping/Commit-and-push had NO
    // `if:` guard — GitHub Actions' default behavior is that a failing step
    // halts all subsequent steps except those gated with `if: failure()` /
    // `if: always()`. So in the original architecture, Housekeeping and
    // Commit-and-push do NOT run if the crawler script itself fails (only
    // "Report failure", which has `if: failure()`, still runs). We must
    // reproduce that here: both steps are gated on `crawler_exit -eq 0`.
    lines.push(`# ---- ${crawler.slug}: ${step.name} (verbatim, only if crawler succeeded) ----`);
    lines.push('if [ "$crawler_exit" -eq 0 ]; then');

    if (isCommitStep) {
      // HAZARD FIX 2: serialize the local git index mutation across
      // concurrent background steps sharing this job's working copy.
      // Only the commit+push moment is serialized (seconds), not the
      // crawl itself. See file header for rationale.
      //
      // NOTE: no `|| true` here. `$?` must be captured from the `flock`
      // invocation ITSELF on the very next line — appending `|| true` to
      // this line would make `$?` always read as 0 (the exit code of the
      // `true` that just ran), silently re-swallowing the failure one line
      // later than before. This script explicitly runs `set +e` (see top),
      // so a non-zero exit here does not abort the rest of the body; the
      // `git_commit_exit=$?` capture on the next line is what makes the
      // failure-report gate and this step's final `exit` (below) see it.
      lines.push(
        indentBlock(`flock /tmp/crawler-group-git.lock -c ${shellQuote(step.run.trimEnd())}`, 2),
      );
      lines.push(indentBlock('git_commit_exit=$?', 2));
    } else {
      // Housekeeping already has continue-on-error semantics in the
      // original workflow (never fails the job) — preserve with `|| true`.
      lines.push(indentBlock(`(${step.run.trimEnd()}) || true`, 2));
    }
    lines.push('fi');
    lines.push('');
  }

  // Fail this background step (and therefore the job, and therefore make
  // the `if: failure()` failure-report step's condition true — it already
  // ran inline above, but a non-zero exit here is also what makes the
  // overall job/step show red in the Actions UI and what a future consumer
  // of this step's own exit status, e.g. `wait-all`, observes) if EITHER
  // the crawl OR the commit/push failed.
  // Contention loss (42) with a successful crawl does NOT fail the step: the
  // job conclusion is what close-recovered-failure-issues.mjs keys recovery
  // on, and one race loser turning the whole 26-crawler group red both
  // blocked the sweep from draining every sibling's recovered issue and made
  // real failures indistinguishable from herd noise. Real crawl/commit
  // failures (any other non-zero) still fail the step as before.
  lines.push('if [ "$crawler_exit" -ne 0 ] || { [ "$git_commit_exit" -ne 0 ] && [ "$git_commit_exit" -ne 42 ]; }; then');
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('exit 0');
  return lines.join('\n');
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Merge a crawler's runStep + postSteps env maps into one map for the
 * step's own YAML `env:` mapping (plus the per-crawler SLUG_HISTORY_SUMMARY_FILE).
 *
 * Root-cause fix for #3713: values containing a GitHub Actions expression
 * (`${{ ... }}`) must never be text-spliced into the shell script body as
 * `export KEY="${{ ... }}"` — GitHub substitutes `${{ ... }}` with its
 * resolved literal text BEFORE the shell parses the line, so a resolved
 * value containing `"` or a backtick (e.g. a dispatch input an actor
 * controls, like `skip_ai_translation`) breaks out of the quoting and the
 * rest of the line re-executes as shell (injection). Declaring the same
 * value in the step's YAML `env:` map instead means GitHub assigns it
 * directly as a process env var — never re-parsed by any shell — exactly
 * how step-level `env:` already worked in each of the 581 original
 * per-crawler workflows before consolidation.
 *
 * The 3 crawlers (hoch-health, hopital-de-lavaux, spital-lachen) where a key
 * appears in more than one source step (`GH_TOKEN` via both
 * `secrets.GITHUB_TOKEN` and `github.token`) are safe to merge: both
 * expressions resolve to the identical runtime token value.
 */
function buildCrawlerStepEnv(crawler, summaryFile) {
  const merged = {
    SLUG_HISTORY_SUMMARY_FILE: summaryFile,
    // Auth for the opt-in Claude CLI Haiku fallback (tier-0 by default since
    // 2026-07-29 — see AI_COMPETING_TIERS in ai-models.mjs; see the
    // "Setup Claude CLI Haiku fallback" step below). Harmless to always
    // pass: ai-models.mjs only offers the model when this AND the RC flag
    // are both set. Most crawlers route callLLM through
    // dedicated-crawler-common.mjs / shared-jobs-crawler.mjs.
    CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
  };
  Object.assign(merged, crawler.runStep.env || {});
  for (const step of crawler.postSteps) {
    Object.assign(merged, step.env || {});
  }
  return merged;
}

/** Gli script di package.json servono all'analizzatore per risolvere `npm run <x>`. */
let PKG_SCRIPTS = null;
function npmScriptsForAnalyzer() {
  if (!PKG_SCRIPTS) {
    const root = path.resolve(fileURLToPath(import.meta.url), '../..');
    PKG_SCRIPTS = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  }
  return PKG_SCRIPTS;
}

/** Build the YAML object (as a JS object, serialized via `yaml` lib) for one group workflow. */
function buildGroupWorkflowObject(groupIndex, group, needsPlaywright, needsIgnoreScripts) {
  const groupName = `crawler-group-${String(groupIndex).padStart(2, '0')}`;

  const steps = [];

  steps.push({
    name: 'Checkout',
    uses: 'actions/checkout@v5',
    with: { 'fetch-depth': 50 },
  });

  steps.push({
    name: 'Setup Node.js',
    uses: 'actions/setup-node@v5',
    with: { 'node-version': '22', cache: 'npm' },
  });

  // Some crawlers' original individual workflows used `npm ci --ignore-scripts`
  // (a leaner/faster install, skipping dependency lifecycle scripts like
  // native postinstalls). The group install step is shared+sequential across
  // ALL members, so if ANY member required the flag we must apply it here:
  // silently dropping it would (a) change that crawler's install semantics,
  // and worse (b) without `--ignore-scripts` a flaky postinstall script can
  // fail this non-continue-on-error step outright, blocking every background
  // crawler step in the group from ever starting — not just the one crawler
  // that needed the flag. Applying `--ignore-scripts` when not strictly
  // required by every member is harmless: it only skips dependency lifecycle
  // scripts for the shared top-level install, and doesn't affect any
  // per-crawler `npm install`/build calls a crawler's own script might run.
  steps.push({
    name: 'Install dependencies',
    run: needsIgnoreScripts ? 'npm ci --ignore-scripts' : 'npm ci',
  });

  if (needsPlaywright) {
    steps.push({
      name: 'Install Playwright browsers',
      run: 'npx playwright install --with-deps chromium',
    });
  }

  // Shared environment prep — pure setup, not a "commit/error mechanism".
  // Copied verbatim from the individual workflows (identical across all 581).
  steps.push({
    name: 'Prepare Firebase credentials (optional)',
    env: { FIREBASE_SERVICE_ACCOUNT_JSON: '${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}' },
    run: [
      'if [ -n "$FIREBASE_SERVICE_ACCOUNT_JSON" ]; then',
      '  printf \'%s\' "$FIREBASE_SERVICE_ACCOUNT_JSON" > /tmp/firebase-sa.json',
      'else',
      '  echo "ℹ️ Firebase secrets not set — crawler will use file config only."',
      '  exit 0',
      'fi',
      'echo "GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-sa.json" >> "$GITHUB_ENV"',
    ].join('\n'),
  });

  steps.push({
    name: 'Load secrets from Remote Config',
    env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
    run: [
      'node scripts/load-rc-env.mjs',
      'echo "GH_TOKEN=$GH_TOKEN" >> "$GITHUB_ENV"',
    ].join('\n'),
  });

  // OmniRoute (ON by default, RC kill-switch ENABLE_OMNIROUTE_FALLBACK='0')
  // — self-hosted local AI gateway, offered in ai-models.mjs's DEFAULT_CHAIN
  // as AI_MODELS.OMNIROUTE_AUTO. Since 2026-07-29 (AI_COMPETING_TIERS
  // default, see ai-models.mjs's _lastResortTier doc comment) this tier is
  // tier-0 BY DEFAULT — it competes on real score against the direct
  // free-tier providers, it is not pinned relative to LOCAL_FALLBACK/
  // CLAUDE_CLI_HAIKU by tier rank anymore (AI_COMPETING_TIERS='' restores
  // that). Shared composite action: see
  // .github/actions/setup-omniroute/action.yml for the full rationale +
  // incident history. Must run before the per-crawler steps below so
  // OMNIROUTE_ENABLED is set in $GITHUB_ENV in time for every background
  // step to inherit it (no per-step env: needed — GITHUB_ENV writes made by
  // a synchronous step before the loop are visible to every subsequent
  // background step in the same job, same mechanism the RC kill-switch flag
  // itself relies on below).
  steps.push({ uses: './.github/actions/setup-omniroute' });

  // Claude CLI Haiku fallback (ON by default, kill-switch '0') — tier-0 by
  // default in ai-models.mjs's DEFAULT_CHAIN since 2026-07-29
  // (AI_COMPETING_TIERS), competing on real score instead of being reached
  // only after every free-tier model has failed. Capped at
  // CLAUDE_CLI_MAX_CALLS_PER_RUN calls/run (default 25) since this quota is
  // shared with pr-review-loop.yml/issue-fix.yml. Shared composite action:
  // see .github/actions/setup-claude-haiku-fallback/action.yml for the full
  // rationale + incident history. Must run before the per-crawler steps
  // below so ENABLE_HAIKU_ARTICLE_FALLBACK is forced into $GITHUB_ENV in
  // time for every background step to inherit it.
  steps.push({ uses: './.github/actions/setup-claude-haiku-fallback' });

  for (const crawler of group.members) {
    const stepId = `crawler-${crawler.slug}`;
    const summaryFile = `/tmp/slug-history-summary-${crawler.slug}.txt`;

    steps.push({
      name: `Run ${crawler.slug}`,
      id: stepId,
      background: true,
      // HAZARD FIX 1 (SLUG_HISTORY_SUMMARY_FILE) + #3713 root-cause fix: every
      // env value the crawler's runStep/postSteps declared lives here, in the
      // step's own YAML env: map, instead of being text-spliced into the
      // shell body — see buildCrawlerStepEnv().
      env: buildCrawlerStepEnv(crawler, summaryFile),
      run: buildCrawlerShellBody(crawler),
    });
  }

  steps.push({
    name: 'Wait for all crawlers in this group',
    'wait-all': true,
  });

  return {
    name: `Crawler Group ${String(groupIndex).padStart(2, '0')} (${group.members.length} crawlers)`,
    on: {
      workflow_dispatch: {
        inputs: {
          skip_ai_translation: {
            description: 'Skip AI translation (1=yes, cache only)',
            required: false,
            default: '1',
            type: 'string',
          },
        },
      },
    },
    concurrency: {
      group: `jobs-${groupName}`,
      'cancel-in-progress': false,
    },
    permissions: {
      contents: 'write',
      issues: 'write',
    },
    env: {
      NODE_OPTIONS: '--disable-warning=DEP0040 --disable-warning=DEP0169',
    },
    jobs: {
      [groupName.replace(/-/g, '_')]: {
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': JOB_TIMEOUT_MINUTES,
        steps,
      },
    },
  };
}

function workflowHeaderComment(groupIndex, group) {
  const members = group.members.map((m) => `${m.slug} (~${Math.round(m.durationMs / 60000)}min)`).join(', ');
  const wallClockMin = Math.round(group.wallClockMs / 60000);
  return [
    `# AUTO-GENERATED by scripts/generate-crawler-group-workflows.mjs — DO NOT EDIT BY HAND.`,
    `# Re-run the generator after adding/removing/renaming a crawler.`,
    `#`,
    `# Group ${String(groupIndex).padStart(2, '0')}: ${group.members.length} crawlers, estimated wall-clock ~${wallClockMin}min`,
    `# (bounded by the slowest member; estimate from historical averages — actual`,
    `# runs can vary). Members: ${members}`,
  ].join('\n');
}

export function generate({ manifestPath = MANIFEST_PATH, baselinePath = BASELINE_PATH, outDir = WORKFLOWS_DIR, write = true } = {}) {
  const { manifest } = loadJson(manifestPath);
  const baseline = loadJson(baselinePath);
  const medianMs = baseline.medianDurationMs;

  const crawlers = manifest.map((c) => {
    const baselineEntry = baseline.crawlers[c.file.replace(/^\.github\/workflows\//, '').replace(/\.yml$/, '')];
    const durationMs = baselineEntry ? baselineEntry.avgDurationMs : medianMs;
    return { ...c, durationMs };
  });

  const groups = packGroups(crawlers, GROUP_COUNT, medianMs);

  // Sanity: every crawler appears exactly once.
  const seen = new Set();
  for (const g of groups) {
    for (const m of g.members) {
      if (seen.has(m.slug)) throw new Error(`Duplicate crawler in groups: ${m.slug}`);
      seen.add(m.slug);
    }
  }
  if (seen.size !== crawlers.length) {
    throw new Error(`Group membership mismatch: ${seen.size} placed vs ${crawlers.length} input crawlers`);
  }
  for (const g of groups) {
    if (g.wallClockMs > SAFETY_CEILING_MS) {
      throw new Error(`Group wall-clock ${g.wallClockMs}ms exceeds safety ceiling ${SAFETY_CEILING_MS}ms`);
    }
  }

  const results = [];
  groups.forEach((group, i) => {
    const groupIndex = i + 1;
    const needsPlaywright = group.members.some((m) =>
      m.prepSteps.some((s) => /playwright/i.test(s.name || '')),
    );
    const needsIgnoreScripts = group.members.some((m) =>
      m.prepSteps.some((s) => /^npm ci\b.*--ignore-scripts/.test(s.run || '')),
    );
    const obj = buildGroupWorkflowObject(groupIndex, group, needsPlaywright, needsIgnoreScripts);
    const yamlBody = YAML.stringify(obj, { lineWidth: 0 });
    const fileContent = `${workflowHeaderComment(groupIndex, group)}\n\n${yamlBody}`;
    const fileName = `crawler-group-${String(groupIndex).padStart(2, '0')}.yml`;
    const filePath = path.join(outDir, fileName);

    let finalContent = fileContent;
    if (write) {
      fs.writeFileSync(filePath, fileContent, 'utf8');
      // Lo sparse-checkout va riapplicato QUI, non lasciato al passaggio manuale:
      // senza, il primo `--write` cancellerebbe in silenzio i profili dei 23
      // crawler e ognuno tornerebbe a scaricare 6,7 GB. I gruppi non hanno tutti
      // lo stesso profilo (leggono file diversi), quindi la lista non puo' essere
      // fissa qui: la calcola l'analizzatore sul file appena scritto.
      finalContent = applyProfilesToFile(filePath, npmScriptsForAnalyzer());
    }

    results.push({
      fileName,
      filePath,
      groupIndex,
      memberCount: group.members.length,
      wallClockMs: group.wallClockMs,
      members: group.members.map((m) => m.slug),
      // In modalita' dry-run (`write=false`) il profilo non e' calcolabile:
      // l'analizzatore legge dal disco. Il contenuto resta quello pre-profilo,
      // che e' cio' che i test strutturali guardano.
      content: finalContent,
    });
  });

  return results;
}

// CLI entry point
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const results = generate();
  console.log(`Generated ${results.length} group workflows:`);
  for (const r of results) {
    console.log(`  ${r.fileName}: ${r.memberCount} crawlers, ~${Math.round(r.wallClockMs / 60000)}min wall-clock`);
  }
}
