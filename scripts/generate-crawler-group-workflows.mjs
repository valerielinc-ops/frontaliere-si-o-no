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
 * deterministic given the same manifest + baseline + assignment inputs.
 *
 * Since #6482 the crawler -> group assignment is NOT re-derived on every run:
 * it is pinned in data/crawler-group-assignments.json and only reconciled
 * against the manifest, so adding or removing one crawler rewrites ONE file,
 * not all 23. See the STABLE ASSIGNMENT block below. Deliberate redistribution
 * of the whole corpus: `--rebalance`. Rebuild the pins from the committed .yml
 * (after a hand-edit or a rebase that touched a group): `--bootstrap-from-workflows`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { computeProfiledText } from './ci/apply-checkout-profiles.mjs';
// Stessa ragione di `generate-crawler-companies.mjs`, e stesso chiamante:
// `prospect-promote.mjs` invoca entrambi in una run non presidiata e committa
// cio' che trovano sul disco. `data/crawler-group-assignments.json` e' la
// sorgente di verita' di QUALE crawler gira in QUALE finestra: troncato a meta'
// non e' un dato brutto, e' il pin dell'intera schedulazione perso, committato.
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { writeFileAtomic } from './lib/atomic-shard-write.mjs';
import {
  canonicalJson,
  createCrawlerGenerationRoster,
  validateCrawlerGenerationRoster,
} from './lib/crawler-generation-contract.mjs';
import { CORPUS_OBSERVER_FILES } from './ci/prepare-crawler-workflow-corpus-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MANIFEST_PATH = path.join(REPO_ROOT, 'data/crawler-manifest.json');
const BASELINE_PATH = path.join(REPO_ROOT, 'data/crawler-workflow-duration-baseline.json');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');
const ASSIGNMENTS_PATH = path.join(REPO_ROOT, 'data/crawler-group-assignments.json');
const CHECKOUT_BUCKETS_PATH = path.join(REPO_ROOT, 'scripts/ci/checkout-buckets.json');
const TRANSLATE_LOGIC_PATH = path.join(WORKFLOWS_DIR, 'translate-pending-logic.yml');
const PORTABLE_CORPUS_DIR = path.join(REPO_ROOT, '.github/corpus-workflows');
const PORTABLE_CONTRACT_PATH = path.join(PORTABLE_CORPUS_DIR, 'contract.json');
const CORPUS_OBSERVER_SITE_SOURCES = new Map([
  ['observers/scripts/crawler-generation-observer-selector.mjs', 'scripts/crawler-generation-observer-selector.mjs'],
  ['observers/scripts/lib/canonical-json-digest.mjs', 'scripts/lib/canonical-json-digest.mjs'],
  ['observers/scripts/lib/crawler-generation-observer-report.mjs', 'scripts/lib/crawler-generation-observer-report.mjs'],
  ['observers/scripts/lib/github-actions-read-client.mjs', 'scripts/lib/github-actions-read-client.mjs'],
]);
const CRAWLER_GENERATION_ROSTER_PATH = path.join(REPO_ROOT, 'scripts/ci/crawler-generation-roster.json');
const CRAWLER_GENERATION_ARTIFACT_RETENTION_DAYS = 14;
const CRAWLER_GENERATION_RUNTIME_PATHS = Object.freeze([
  'functions/src/githubApiHeaders.js',
  'scripts/crawler-group-generation-finalizer.mjs',
  'scripts/lib/atomic-write-json.mjs',
  'scripts/lib/canonical-json-digest.mjs',
  'scripts/lib/crawler-generation-contract.mjs',
  'scripts/lib/crawler-generation-receipt.mjs',
  'scripts/lib/job-match-key.mjs',
  'scripts/lib/job-url-key.mjs',
  'scripts/lib/slug-history-journal.mjs',
  'scripts/lib/slug-preservation-guard.mjs',
]);

const SITE_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const CROSS_REPO_BACKOFF_SECONDS = 30;

// Solo bucket misurati e confermati estranei al ciclo crawler. L'allowlist e'
// deliberatamente sulle ESCLUSIONI: un nuovo bucket di checkout-buckets.json
// resta incluso by default, quindi non puo' sparire in silenzio dal runner.
const CROSS_REPO_SAFE_EXCLUDED_BUCKETS = new Set([
  'public/images/',
  'data/seo-404-compat/',
  'packages/articles/content/',
  'docs/',
  'public/data/',
  'data/related-search-candidates.json',
  'data/cf-hot-404s.json',
  'data/dist-size-history.jsonl',
  'data/evidence-index.json',
  'data/health-premiums/',
]);

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
 * ---------------------------------------------------------------------------
 * STABLE ASSIGNMENT (#6482) — why packGroups() no longer decides membership on
 * a normal run.
 * ---------------------------------------------------------------------------
 *
 * packGroups() below is a GLOBAL bin-pack: its phase 2 deals the tail of the
 * duration-sorted corpus round-robin across the groups. That makes every
 * crawler's group a function of its POSITION in the sorted corpus, so removing
 * (or adding) a single crawler shifts every crawler after it by one slot and
 * reshuffles all 23 groups at once. Measured on #6482: dropping one entry
 * (`eoc-candidati-posizioni`) from data/crawler-manifest.json moved 14 crawlers
 * out of crawler-group-02 and 14 different ones in, and rewrote all 23 files
 * (~5000 lines) — an unreviewable diff that changes WHICH crawler runs in WHICH
 * window in production, which nobody asked for. The practical outcome was the
 * worst of both worlds: the .yml got hand-edited instead (PR #6484), leaving
 * the generator even further adrift from its own output.
 *
 * Fix: the membership decision is PERSISTED, in
 * data/crawler-group-assignments.json, as an ORDERED member list per group
 * (order matters too — it is the order of the generated background steps, so
 * re-sorting it would rewrite every file for no reason). On a normal run the
 * generator READS that file:
 *
 *   - a crawler already pinned stays exactly where it is, at the same position;
 *   - a crawler removed from the manifest is spliced out of its own group only;
 *   - a crawler new to the manifest is APPENDED to one group, chosen
 *     deterministically (fewest members, then lowest wall-clock, then lowest
 *     index) so the choice never depends on corpus ordering;
 *   - the reconciled file is written back, so the pins cannot drift from the
 *     manifest without the drift showing up in the same commit.
 *
 * The diff of a one-crawler change is therefore one group's file, not 23.
 *
 * packGroups() is NOT dead: `--rebalance` runs it and overwrites the pins with
 * its result. That is the deliberate, reviewed "redistribute the whole corpus"
 * action — it simply no longer happens by accident on every unrelated edit.
 */

/**
 * Read the pin file. Missing file = no pins (every crawler is treated as new).
 *
 * `doc.groupCount` must match the caller's `groupCount`: a foreign/stale pin
 * file whose `groups` array has a different length would otherwise be
 * silently reshaped by the `Array.from({ length: groupCount }, ...)` below —
 * truncating any groups past `groupCount` (their crawlers would reappear as
 * `added` on the next reconcile, an untraceable reshuffle) or padding with
 * empty groups if it has fewer. That is exactly the class of silent-drift bug
 * the pin file exists to prevent (#6482), so a mismatch fails loudly instead.
 */
function loadAssignments(assignmentsPath, groupCount) {
  if (!fs.existsSync(assignmentsPath)) {
    return Array.from({ length: groupCount }, () => []);
  }
  const doc = loadJson(assignmentsPath);
  if (doc.groupCount !== groupCount) {
    throw new Error(
      `loadAssignments: ${assignmentsPath} has groupCount=${doc.groupCount}, expected ${groupCount} — ` +
        'refusing to silently truncate/pad a mismatched pin file. If this is deliberate, ' +
        're-run with --rebalance or --bootstrap-from-workflows to regenerate the pins.',
    );
  }
  const groups = Array.isArray(doc.groups) ? doc.groups : [];
  return Array.from({ length: groupCount }, (_, i) =>
    Array.isArray(groups[i]) ? groups[i].filter((s) => typeof s === 'string') : [],
  );
}

/**
 * Il documento, separato dalla sua serializzazione.
 *
 * Serve perche' la scrittura passa da `writeJsonAtomic`, che vuole il valore e
 * non la stringa. La forma emessa e' identica a prima —
 * `JSON.stringify(doc, null, 2)` + newline — quindi il passaggio non produce
 * nessun diff su `data/crawler-group-assignments.json`.
 */
function assignmentsDoc(memberSlugsByGroup) {
  return {
    _comment: [
      'PINNED crawler -> group assignment. Source of truth for which crawler runs in which',
      'crawler-group-NN.yml, and in which position (position = order of the generated',
      'background steps). Maintained BY scripts/generate-crawler-group-workflows.mjs: edit',
      'data/crawler-manifest.json and re-run the generator, never hand-edit this file.',
      'A deliberate redistribution of the whole corpus is an explicit --rebalance run (#6482).',
    ].join(' '),
    groupCount: memberSlugsByGroup.length,
    groups: memberSlugsByGroup,
  };
}

/**
 * Reconcile the pinned assignment against the crawlers actually in the manifest.
 *
 * Returns `{ groups, assignments, added, removed }`, where `groups` has exactly
 * the `{ members, wallClockMs }` shape packGroups() returns, so nothing
 * downstream needs to know which of the two produced it.
 *
 * A slug pinned in two groups (hand-edit accident) is kept at its FIRST position
 * only: tolerating the duplicate would emit the same crawler twice in one job,
 * i.e. two concurrent `git commit` racers on the same data file.
 */
export function assignGroupsStable(crawlers, pinnedGroups, medianMs) {
  const bySlug = new Map(crawlers.map((c) => [c.slug, c]));
  const groupCount = pinnedGroups.length;
  const memberSlugsByGroup = Array.from({ length: groupCount }, () => []);
  const placed = new Set();

  // Pass 1: keep every pin that still matches a manifest crawler, at its
  // recorded position. Pins whose crawler left the manifest simply do not
  // survive this pass — that is the "a removal touches one file" property.
  for (let i = 0; i < groupCount; i++) {
    for (const slug of pinnedGroups[i]) {
      if (!bySlug.has(slug) || placed.has(slug)) continue;
      memberSlugsByGroup[i].push(slug);
      placed.add(slug);
    }
  }

  const removed = pinnedGroups.flat().filter((slug) => !bySlug.has(slug));

  // Pass 2: crawlers the pin file has never seen. Sorted by slug (NOT by
  // duration): a stable, input-order-independent order, so promoting two
  // crawlers in either order lands on the same assignment.
  const added = crawlers.map((c) => c.slug).filter((slug) => !placed.has(slug)).sort();

  // A group holding a single genuine duration outlier (Coop's ~160min) is
  // reserved: its whole reason to exist is that nothing else pays that
  // wall-clock. Never grow it by accident.
  const isReserved = (i) =>
    memberSlugsByGroup[i].length === 1 &&
    (bySlug.get(memberSlugsByGroup[i][0])?.durationMs ?? 0) > medianMs * OUTLIER_MEDIAN_MULTIPLE;

  const wallClockOf = (i) =>
    memberSlugsByGroup[i].reduce((max, slug) => Math.max(max, bySlug.get(slug)?.durationMs ?? 0), 0);

  for (const slug of added) {
    let target = -1;
    for (let i = 0; i < groupCount; i++) {
      if (isReserved(i)) continue;
      if (target === -1) {
        target = i;
        continue;
      }
      const size = memberSlugsByGroup[i].length;
      const best = memberSlugsByGroup[target].length;
      if (size < best || (size === best && wallClockOf(i) < wallClockOf(target))) target = i;
    }
    // Every group reserved (only reachable with a tiny corpus): fail loudly
    // rather than silently growing a reserved group. A silent fallback to
    // group 0 would violate the "never grow a reserved outlier group"
    // invariant this function exists to enforce, whether or not group 0
    // itself happens to be reserved.
    if (target === -1) {
      throw new Error(
        `assignGroupsStable: cannot place '${slug}' — every group is reserved for a duration outlier`,
      );
    }
    memberSlugsByGroup[target].push(slug);
    placed.add(slug);
  }

  const groups = memberSlugsByGroup.map((slugs) => {
    const members = slugs.map((s) => bySlug.get(s));
    return {
      members,
      wallClockMs: members.reduce((max, m) => Math.max(max, m.durationMs), 0),
    };
  });

  return { groups, assignments: memberSlugsByGroup, added, removed };
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

function validateTargetTimeoutMinutes(crawler) {
  if (crawler.targetTimeoutMinutes == null) return null;
  const minutes = Number(crawler.targetTimeoutMinutes);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes >= JOB_TIMEOUT_MINUTES) {
    throw new Error(
      `${crawler.slug}: targetTimeoutMinutes must be a positive integer below the ${JOB_TIMEOUT_MINUTES} minute group timeout`,
    );
  }
  return minutes;
}

/**
 * Build the isolated work phase for a crawler with an explicit wall timeout.
 *
 * The timeout must cover more than the network fetch: housekeeping and the
 * serialized commit can also block a background target indefinitely. Failure
 * reporting deliberately remains outside this phase so a timeout is still
 * observable and the target exits non-zero without committing partial data.
 */
function buildTimedCrawlerShellBody(crawler, timeoutMinutes) {
  const outer = ['set -uo pipefail', 'set +e', ''];
  const work = ['set -uo pipefail', 'set +e', ''];

  work.push(`# ---- ${crawler.slug}: run crawler (bounded work phase) ----`);
  work.push(crawler.runStep.run.trimEnd());
  work.push('crawler_exit=$?');
  work.push('git_commit_exit=0');
  work.push('');

  for (const step of crawler.postSteps) {
    if (step.if === 'failure()') continue;
    const isCommitStep = /git-commit-data\.sh/.test(step.run || '');
    work.push(`# ---- ${crawler.slug}: ${step.name} (only if crawler succeeded) ----`);
    work.push('if [ "$crawler_exit" -eq 0 ]; then');
    if (isCommitStep) {
      work.push(indentBlock(`flock /tmp/crawler-group-git.lock -c ${shellQuote(step.run.trimEnd())}`, 2));
      work.push(indentBlock('git_commit_exit=$?', 2));
    } else {
      work.push(indentBlock(`(${step.run.trimEnd()}) || true`, 2));
    }
    work.push('fi');
    work.push('');
  }

  work.push('if [ "$crawler_exit" -eq 0 ] && [ "$git_commit_exit" -eq 42 ]; then');
  work.push(`  echo "::warning::${crawler.slug}: crawl OK but push lost the ref race after all retries (contention). Cycle lost, self-heals next scheduled run — no issue filed (systemic class)."`);
  work.push(`  echo "⚠️ ${crawler.slug}: push contention loss (exit 42) — crawl was fine, no issue filed" >> "$GITHUB_STEP_SUMMARY"`);
  work.push('  exit 0');
  work.push('fi');
  work.push('if [ "$crawler_exit" -ne 0 ] || [ "$git_commit_exit" -ne 0 ]; then');
  work.push('  exit 1');
  work.push('fi');
  work.push('exit 0');

  outer.push(`# ---- ${crawler.slug}: ${timeoutMinutes} minute target wall timeout ----`);
  outer.push('# shellcheck disable=SC2016 -- child-shell variables expand inside the quoted bash -c body');
  outer.push(
    `timeout --signal=TERM --kill-after=30s ${timeoutMinutes}m bash -c ${shellQuote(work.join('\n'))}`,
  );
  outer.push('target_exit=$?');
  outer.push('if [ "$target_exit" -eq 124 ]; then');
  outer.push(`  echo "::error::${crawler.slug}: target exceeded ${timeoutMinutes} minute wall timeout"`);
  outer.push(`  if [ -n "${'$'}{GITHUB_STEP_SUMMARY:-}" ]; then echo "❌ ${crawler.slug}: target timed out after ${timeoutMinutes} minutes" >> "$GITHUB_STEP_SUMMARY"; fi`);
  outer.push('fi');
  outer.push('');

  for (const step of crawler.postSteps) {
    if (step.if !== 'failure()') continue;
    const crawlerWorkflowId = `Run ${crawler.slug}`;
    const literalizedRun = step.run
      .split('${{ github.workflow }}')
      .join(crawlerWorkflowId);
    outer.push(`# ---- ${crawler.slug}: ${step.name} (outside timeout, only on target failure) ----`);
    outer.push('if [ "$target_exit" -ne 0 ]; then');
    outer.push(indentBlock(literalizedRun.trimEnd(), 2));
    outer.push('fi');
    outer.push('');
  }

  outer.push('if [ "$target_exit" -ne 0 ]; then');
  outer.push('  exit 1');
  outer.push('fi');
  outer.push('exit 0');
  return outer.join('\n');
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
  const targetTimeoutMinutes = validateTargetTimeoutMinutes(crawler);
  if (targetTimeoutMinutes != null) {
    return buildTimedCrawlerShellBody(crawler, targetTimeoutMinutes);
  }
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

function crawlerGenerationMembers(group) {
  return group.members
    .map((crawler) => {
      const env = buildCrawlerStepEnv(crawler, `/tmp/slug-history-summary-${crawler.slug}.txt`);
      if (typeof env.JOBS_HOUSEKEEPING_SCOPE !== 'string' || env.JOBS_HOUSEKEEPING_SCOPE.length === 0 ||
          typeof env.JOBS_SLICE_FILE !== 'string' || env.JOBS_SLICE_FILE.length === 0) {
        throw new Error(`${crawler.slug}: missing crawler generation identity or primary slice`);
      }
      return {
        crawlerId: env.JOBS_HOUSEKEEPING_SCOPE,
        primarySlice: env.JOBS_SLICE_FILE,
      };
    })
    .sort((left, right) => left.crawlerId < right.crawlerId ? -1 : left.crawlerId > right.crawlerId ? 1 : 0);
}

function crawlerGenerationRosterFromGroups(groups) {
  const rosterGroups = {};
  const primarySlices = {};
  groups.forEach((group, index) => {
    const groupId = String(index + 1).padStart(2, '0');
    const members = crawlerGenerationMembers(group);
    rosterGroups[groupId] = members.map(({ crawlerId }) => crawlerId);
    for (const { crawlerId, primarySlice } of members) primarySlices[crawlerId] = primarySlice;
  });
  return createCrawlerGenerationRoster(rosterGroups, primarySlices);
}

function crawlerGenerationTerminalSteps(groupIndex, expectedCrawlers) {
  const nn = String(groupIndex).padStart(2, '0');
  const output = `\${{ runner.temp }}/crawler-generation/crawler-group-${nn}-terminal.json`;
  return [
    {
      name: 'Finalize crawler generation manifest (shadow)',
      if: 'always()',
      'continue-on-error': true,
      env: {
        CRAWLER_GENERATION_GROUP: nn,
        CRAWLER_GENERATION_TOKEN: '${{ inputs.generation_token }}',
        CRAWLER_GENERATION_CALLER_REPOSITORY: '${{ github.repository }}',
        CRAWLER_GENERATION_CALLER_RUN_ID: '${{ github.run_id }}',
        CRAWLER_GENERATION_CALLER_RUN_ATTEMPT: '${{ github.run_attempt }}',
        // `wait-all` is a runner pseudo-step whose schema deliberately has no
        // `id`, so it cannot populate the `steps` context. At this point the
        // join has completed and `job.status` is the supported job-level
        // surface that preserves success/failure/cancelled distinctly.
        CRAWLER_GENERATION_WAIT_OUTCOME: '${{ job.status }}',
        CRAWLER_GENERATION_EXPECTED_CRAWLERS: JSON.stringify(expectedCrawlers),
        CRAWLER_GENERATION_OUTPUT: output,
      },
      run: 'node scripts/crawler-group-generation-finalizer.mjs',
    },
    {
      name: 'Upload crawler generation manifest (shadow)',
      if: 'always()',
      'continue-on-error': true,
      uses: 'actions/upload-artifact@v7',
      with: {
        name: `crawler-group-${nn}-terminal-\${{ github.run_id }}`,
        path: output,
        'if-no-files-found': 'error',
        overwrite: true,
        'retention-days': CRAWLER_GENERATION_ARTIFACT_RETENTION_DAYS,
      },
    },
  ];
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
  steps.push(...crawlerGenerationTerminalSteps(groupIndex, crawlerGenerationMembers(group)));

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
          generation_token: {
            description: 'Explicit generation correlation token (shadow only)',
            required: false,
            default: '',
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
        env: {
          // Job-level env is inherited by every background shell and avoids
          // hundreds of identical step overrides. The CLI resolves this relative
          // path strictly underneath the runner-provided RUNNER_TEMP.
          CRAWLER_GENERATION_RECEIPT_DIR: 'crawler-generation/receipts',
        },
        steps,
      },
    },
  };
}

const GENERATED_MARKER = '# AUTO-GENERATED by scripts/generate-crawler-group-workflows.mjs';

/**
 * Carry over a hand-written comment block sitting ABOVE the AUTO-GENERATED
 * marker of the file being overwritten.
 *
 * crawler-group-23.yml on main has a 30-line header explaining that the group
 * is disabled and dispatched cross-repo to frontaliere-articles instead (the
 * execution pilot). The generator used to drop it on every re-run, and the
 * header itself says so — "would silently drop this header ... Re-add this
 * header by hand if that happens". That is the same defect as #6482 seen from
 * the other side: a regeneration that is not surgical, so the artefact and the
 * generator drift apart and the artefact gets hand-maintained.
 *
 * Everything from the marker down is still regenerated from scratch, so this
 * cannot be used to smuggle body edits past the generator — only to keep the
 * "why is this file special" note attached to the file it describes.
 *
 * Only a leading run of comment/blank lines qualifies: anything else means the
 * file is not shaped the way we think, and we leave it out rather than splice
 * unknown text into a workflow.
 */
export function extractManualPreamble(existingText) {
  if (!existingText) return '';
  const markerAt = existingText.indexOf(GENERATED_MARKER);
  if (markerAt <= 0) return '';
  const prefix = existingText.slice(0, markerAt);
  const lines = prefix.split('\n');
  // The last element is the empty string before the marker's own line start.
  if (lines[lines.length - 1] !== '') return '';
  if (!lines.slice(0, -1).every((l) => l.trim() === '' || l.trimStart().startsWith('#'))) return '';
  return prefix;
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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Profilo comune dei job crawler eseguiti dal corpus.
 *
 * actions/checkout abilita il partial clone (`blob:none`) quando riceve uno
 * sparse-checkout. Il runner scarica quindi i bucket crawler necessari, non il
 * tarball codeload dell'intero sito che esauriva il timeout prima della logica.
 */
export function crossRepoCrawlerSparsePatterns({ bucketsPath = CHECKOUT_BUCKETS_PATH } = {}) {
  const table = loadJson(bucketsPath);
  const excluded = table.buckets
    .map((bucket) => bucket.id)
    .filter((id) => CROSS_REPO_SAFE_EXCLUDED_BUCKETS.has(id));
  return ['/*', ...excluded.map((id) => `!/${id}`)];
}

const SITE_RUNTIME_PATH_RE = /\b(?:scripts\/[A-Za-z0-9._/-]+\.(?:cjs|js|json|jsonc|mjs|sh|ts|yaml|yml)|functions\/src\/githubApiHeaders\.js)\b/g;
const CORPUS_OBSERVER_RUNTIME_TARGETS = new Set(
  CORPUS_OBSERVER_FILES.map(({ target }) => target).filter((target) => target.startsWith('scripts/')),
);

/**
 * Estrae il confine runtime del sito citato dagli artifact e lo valida prima
 * della pubblicazione. Il corpus puo' quindi allowlistare path esatti dal
 * contratto, mentre un typo nuovo fallisce nel repo che possiede quei file.
 *
 * @param {string[]} artifactContents
 * @param {{repoRoot?: string}} [options]
 */
export function collectSiteRuntimePaths(artifactContents, { repoRoot = REPO_ROOT } = {}) {
  const runtimePaths = [...new Set([
    ...CRAWLER_GENERATION_RUNTIME_PATHS,
    ...artifactContents.flatMap((content) =>
      [...content.matchAll(SITE_RUNTIME_PATH_RE)].map((match) => match[0]),
    ),
  ])].filter((runtimePath) => !CORPUS_OBSERVER_RUNTIME_TARGETS.has(runtimePath)).sort();
  const missing = runtimePaths.filter((runtimePath) =>
    !fs.existsSync(path.join(repoRoot, runtimePath)),
  );
  if (missing.length > 0) {
    throw new Error(`cross-repo artifact cites missing site runtime path(s): ${missing.join(', ')}`);
  }
  return runtimePaths;
}

function normalizedCrawlerStep(step) {
  const copy = structuredClone(step);
  const env = Object.fromEntries(
    Object.entries(copy.env ?? {})
      .filter(([key]) => key !== 'GH_TOKEN')
      .map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.replaceAll('github.event.inputs.skip_ai_translation', 'inputs.skip_ai_translation')
          : value,
      ]),
  );
  copy.env = env;
  return copy;
}

function logicPreamble(existingText, nn) {
  const bodyAt = existingText?.search(/^on:\s*$/m) ?? -1;
  if (bodyAt >= 0) return existingText.slice(0, bodyAt);
  return [
    `# Crawler Group ${nn} logic — generated source for corpus execution.`,
    '# AUTO-GENERATED job body: edit scripts/generate-crawler-group-workflows.mjs.',
    '',
  ].join('\n');
}

function localRemoteConfigStep() {
  return {
    name: 'Load secrets from Remote Config',
    env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
    run: 'node scripts/load-rc-env.mjs\necho "GH_TOKEN=$GH_TOKEN" >> "$GITHUB_ENV"',
  };
}

function logicRemoteConfigStep() {
  return { name: 'Load secrets from Remote Config', run: 'node scripts/load-rc-env.mjs' };
}

function logicWriteAuthStep(members) {
  return {
    name: 'Bootstrap write auth for frontaliere-si-o-no (GITHUB_PAT from Remote Config)',
    run: [
      'if [ -z "${GITHUB_PAT:-}" ]; then',
      `  echo "::error::GITHUB_PAT missing from Remote Config (RC_TO_ENV in scripts/load-rc-env.mjs) — cannot push crawler data to valerielinc-ops/frontaliere-si-o-no or file crawler-failure issues there. Aborting before any crawler runs so this fails loud, not as ${members} silent push failures."`,
      '  exit 1',
      'fi',
      'git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/valerielinc-ops/frontaliere-si-o-no.git"',
      'echo "GH_TOKEN=${GITHUB_PAT}" >> "$GITHUB_ENV"',
      'echo "GH_REPO=valerielinc-ops/frontaliere-si-o-no" >> "$GITHUB_ENV"',
    ].join('\n'),
  };
}

/** Deriva il workflow_call completo dalla stessa resa locale del generatore. */
export function buildCrawlerLogicWorkflow(generatedWorkflowText, {
  groupIndex,
  existingText = '',
} = {}) {
  const nn = String(groupIndex).padStart(2, '0');
  const workflow = YAML.parse(generatedWorkflowText);
  const job = Object.values(workflow.jobs ?? {})[0];
  if (!job?.steps) throw new Error(`crawler-group-${nn}: generated job missing`);
  const members = job.steps.filter((step) => step?.background === true).length;

  workflow.on = {
    workflow_call: {
      inputs: workflow.on.workflow_dispatch.inputs,
      secrets: {
        FIREBASE_SERVICE_ACCOUNT_JSON: { required: false },
        CLAUDE_CODE_OAUTH_TOKEN: { required: false },
      },
    },
  };
  delete workflow.concurrency;
  workflow.permissions = { contents: 'read' };

  const checkoutAt = job.steps.findIndex((step) => step?.uses?.startsWith('actions/checkout@'));
  const rcAt = job.steps.findIndex((step) => step?.name === 'Load secrets from Remote Config');
  if (checkoutAt < 0 || rcAt < 0) throw new Error(`crawler-group-${nn}: generated bootstrap steps missing`);
  const checkout = job.steps[checkoutAt];
  checkout.name = 'Checkout frontaliere-si-o-no (public, read-only)';
  checkout.with = { repository: SITE_REPOSITORY, 'fetch-depth': checkout.with?.['fetch-depth'] };

  job.steps[rcAt] = logicRemoteConfigStep();
  job.steps.splice(rcAt + 1, 0, logicWriteAuthStep(members));

  for (const step of job.steps) {
    if (step?.uses?.startsWith('./.github/actions/')) {
      step.uses = `${SITE_REPOSITORY}/${step.uses.slice(2)}@main`;
    }
    if (step?.background !== true) continue;
    delete step.env?.GH_TOKEN;
    for (const [key, value] of Object.entries(step.env ?? {})) {
      if (typeof value === 'string') {
        step.env[key] = value.replaceAll('github.event.inputs.skip_ai_translation', 'inputs.skip_ai_translation');
      }
    }
  }

  const body = YAML.stringify({
    on: workflow.on,
    permissions: workflow.permissions,
    env: workflow.env,
    jobs: workflow.jobs,
  }, { lineWidth: 0 });
  return `${logicPreamble(existingText, nn)}${body}`;
}

/**
 * @param {{
 *   groupResults?: Array<{groupIndex: number, content: string}>,
 *   workflowsDir?: string,
 *   write?: boolean,
 * }} [options]
 */
export function generateCrawlerLogicArtifacts({
  groupResults,
  workflowsDir = WORKFLOWS_DIR,
  write = true,
} = {}) {
  if (!Array.isArray(groupResults) || groupResults.length !== GROUP_COUNT) {
    throw new Error(`logic generation requires exactly ${GROUP_COUNT} generated groups`);
  }
  if (write) fs.mkdirSync(workflowsDir, { recursive: true });
  const rendered = groupResults.map((result) => {
    const nn = String(result.groupIndex).padStart(2, '0');
    const fileName = `crawler-group-${nn}-logic.yml`;
    const outputPath = path.join(workflowsDir, fileName);
    const existingText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    const content = buildCrawlerLogicWorkflow(result.content, {
      groupIndex: result.groupIndex,
      existingText,
    });
    YAML.parse(content);
    return { fileName, content };
  });
  if (write) {
    for (const artifact of rendered) {
      writeFileAtomic(path.join(workflowsDir, artifact.fileName), artifact.content);
    }
  }
  return rendered;
}

function normalizedContractStep(step, side, fileName, members) {
  const copy = structuredClone(step);

  if (typeof copy?.uses === 'string' && copy.uses.startsWith('actions/checkout@')) {
    const allowedWith = side === 'generated'
      ? new Set(['fetch-depth'])
      : new Set(['repository', 'fetch-depth']);
    const unexpected = Object.keys(copy.with ?? {}).filter((key) => !allowedWith.has(key));
    if (unexpected.length > 0) {
      throw new Error(`${fileName}: checkout ${side} has undeclared differences: ${unexpected.join(', ')}`);
    }
    if (side === 'logic' && copy.with?.repository !== SITE_REPOSITORY) {
      throw new Error(`${fileName}: logic checkout does not target ${SITE_REPOSITORY}`);
    }
    // Conserva ogni campo step-level presente o futuro (`if`, `timeout-*`,
    // shell, continue-on-error...). Le sole differenze dichiarate sono il nome
    // descrittivo e `with.repository` nel reusable cross-repo.
    copy.name = 'Checkout';
    delete copy.with.repository;
    return copy;
  }

  if (copy?.name === 'Load secrets from Remote Config') {
    const expected = side === 'generated' ? localRemoteConfigStep() : logicRemoteConfigStep();
    if (JSON.stringify(copy) !== JSON.stringify(expected)) {
      throw new Error(`${fileName}: ${side} RC bootstrap drifted from its complete allowed form`);
    }
    return { name: copy.name, run: 'node scripts/load-rc-env.mjs' };
  }

  if (copy?.name === 'Bootstrap write auth for frontaliere-si-o-no (GITHUB_PAT from Remote Config)') {
    if (side !== 'logic' || JSON.stringify(copy) !== JSON.stringify(logicWriteAuthStep(members))) {
      throw new Error(`${fileName}: undeclared write-auth bootstrap difference`);
    }
    return null;
  }

  const composite = /^valerielinc-ops\/frontaliere-si-o-no\/(\.github\/actions\/[^@]+)@main$/.exec(copy?.uses ?? '');
  if (composite) copy.uses = `./${composite[1]}`;
  return copy?.background === true ? normalizedCrawlerStep(copy) : copy;
}

function normalizedJobContract(workflow, side, fileName) {
  const jobEntries = Object.entries(workflow.jobs ?? {});
  if (jobEntries.length !== 1) throw new Error(`${fileName}: expected exactly one job`);
  const [jobName, job] = jobEntries[0];
  const normalizedJob = structuredClone(job);
  const members = (job.steps ?? []).filter((step) => step?.background === true).length;
  const steps = (job.steps ?? [])
    .map((step) => normalizedContractStep(step, side, fileName, members))
    .filter(Boolean);
  normalizedJob.steps = steps;
  return { jobName, env: workflow.env, job: normalizedJob };
}

/**
 * I 23 `*-logic.yml` erano copie manuali: la loro parita' col generatore era
 * solo accidentale. Questo confronto fail-closed copre l'intero job (setup,
 * roster, env, shell body e wait-all) e normalizza esclusivamente le differenze
 * dichiarate del workflow_call cross-repo: checkout esplicito, bootstrap PAT,
 * composite action assolute e token ambient rimosso dai crawler.
 */
export function assertCrawlerLogicParity(generatedWorkflowText, logicWorkflowText, fileName = 'crawler logic') {
  const generatedWorkflow = YAML.parse(generatedWorkflowText);
  const logicWorkflow = YAML.parse(logicWorkflowText);
  const generatedKeys = Object.keys(generatedWorkflow).sort();
  const logicKeys = Object.keys(logicWorkflow).sort();
  if (JSON.stringify(generatedKeys) !== JSON.stringify(['concurrency', 'env', 'jobs', 'name', 'on', 'permissions']) ||
      JSON.stringify(logicKeys) !== JSON.stringify(['env', 'jobs', 'on', 'permissions'])) {
    throw new Error(`${fileName}: undeclared top-level workflow metadata`);
  }
  const generatedJobName = Object.keys(generatedWorkflow.jobs ?? {})[0] ?? '';
  const nn = /_(\d{2})$/.exec(generatedJobName)?.[1];
  const generatedMembers = Object.values(generatedWorkflow.jobs ?? {})[0]?.steps
    ?.filter((step) => step?.background === true).length;
  if (!nn || generatedWorkflow.name !== `Crawler Group ${nn} (${generatedMembers} crawlers)` ||
      JSON.stringify(generatedWorkflow.concurrency) !== JSON.stringify({
    group: `jobs-crawler-group-${nn}`,
    'cancel-in-progress': false,
  }) || JSON.stringify(generatedWorkflow.permissions) !== JSON.stringify({ contents: 'write', issues: 'write' }) ||
      logicWorkflow.concurrency !== undefined ||
      JSON.stringify(logicWorkflow.permissions) !== JSON.stringify({ contents: 'read' })) {
    throw new Error(`${fileName}: reusable metadata drifted from the allowed cross-repo form`);
  }
  const generatedTrigger = generatedWorkflow.on;
  const logicTrigger = logicWorkflow.on;
  const expectedSecrets = {
        FIREBASE_SERVICE_ACCOUNT_JSON: { required: false },
        CLAUDE_CODE_OAUTH_TOKEN: { required: false },
  };
  if (JSON.stringify(Object.keys(generatedTrigger ?? {})) !== JSON.stringify(['workflow_dispatch']) ||
      JSON.stringify(Object.keys(generatedTrigger?.workflow_dispatch ?? {})) !== JSON.stringify(['inputs']) ||
      JSON.stringify(Object.keys(logicTrigger ?? {})) !== JSON.stringify(['workflow_call']) ||
      JSON.stringify(Object.keys(logicTrigger?.workflow_call ?? {}).sort()) !== JSON.stringify(['inputs', 'secrets']) ||
      JSON.stringify(generatedTrigger.workflow_dispatch.inputs) !== JSON.stringify(logicTrigger.workflow_call.inputs) ||
      JSON.stringify(logicTrigger.workflow_call.secrets) !== JSON.stringify(expectedSecrets)) {
    throw new Error(`${fileName}: workflow_call inputs/secrets drifted from the generated contract`);
  }
  const generated = normalizedJobContract(generatedWorkflow, 'generated', fileName);
  const logic = normalizedJobContract(logicWorkflow, 'logic', fileName);
  if (JSON.stringify(generated) !== JSON.stringify(logic)) {
    throw new Error(`${fileName} drifted from generate-crawler-group-workflows.mjs (full job mismatch)`);
  }
  return logic.job.steps
    .filter((step) => step?.background === true)
    .map((step) => step.id.replace(/^crawler-/, ''));
}

function checkoutWithSparse(sourceWith, sparsePatterns, ref = 'main') {
  return {
    ...(sourceWith ?? {}),
    repository: SITE_REPOSITORY,
    ref,
    clean: true,
    'sparse-checkout': sparsePatterns.join('\n'),
    'sparse-checkout-cone-mode': false,
  };
}

/**
 * Converte una logica workflow_call del sito in un workflow standalone del
 * corpus. Checkout e installazione possono essere ritentati prima di RC/crawl:
 * nessun retry puo' ripetere scritture parziali del crawler.
 */
export function buildStandaloneCrossRepoWorkflow({
  logicText,
  name,
  runName,
  workflowFile,
  trigger,
  concurrency,
  sparsePatterns = crossRepoCrawlerSparsePatterns(),
  runtimePaths = [],
  checkoutRef = 'main',
}) {
  if (!workflowFile) {
    throw new Error(`${name}: workflow file is required`);
  }
  const workflow = YAML.parse(logicText);
  const job = Object.values(workflow.jobs ?? {})[0];
  if (!job?.steps) throw new Error(`${name}: reusable logic has no runnable job steps`);

  const checkoutIndex = job.steps.findIndex((step) =>
    typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (checkoutIndex < 0) throw new Error(`${name}: reusable logic has no actions/checkout step`);

  const sourceCheckout = job.steps[checkoutIndex];
  const checkout = checkoutWithSparse(sourceCheckout.with, sparsePatterns, checkoutRef);
  const primaryId = 'site_checkout_primary';
  const primary = {
    name: 'Checkout frontaliere-si-o-no (attempt 1/2, sparse)',
    id: primaryId,
    uses: sourceCheckout.uses,
    'continue-on-error': true,
    with: { ...checkout },
  };
  const backoff = {
    name: `Backoff ${CROSS_REPO_BACKOFF_SECONDS}s before checkout retry`,
    if: `steps.${primaryId}.outcome == 'failure'`,
    run: [
      `echo "First sparse checkout failed; retrying in ${CROSS_REPO_BACKOFF_SECONDS}s"`,
      `sleep ${CROSS_REPO_BACKOFF_SECONDS}`,
    ].join('\n'),
  };
  const retry = {
    name: 'Checkout frontaliere-si-o-no (attempt 2/2, sparse)',
    id: 'site_checkout_retry',
    if: `steps.${primaryId}.outcome == 'failure'`,
    uses: sourceCheckout.uses,
    with: { ...checkout },
  };
  const reportCheckoutFailure = {
    name: 'Report exhausted site checkout',
    if: `always() && steps.${primaryId}.outcome == 'failure' && steps.site_checkout_retry.outcome == 'failure'`,
    env: {
      GH_TOKEN: '${{ github.token }}',
      // scan-failed-runs e close-recovered-failure-issues riconoscono questo
      // titolo canonico: il checkout esaurito commenta la stessa issue invece
      // di creare un secondo segnale non richiudibile.
      ISSUE_TITLE: `Workflow Failure: ${name}`,
      RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
    },
    run: [
      'message="Both sparse checkout attempts failed before crawler/translation logic started. Run: ${RUN_URL}"',
      'existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --limit 100 --json number,title --jq \'.[] | select(.title == env.ISSUE_TITLE) | .number\' | head -n 1)"',
      'if [ -n "$existing" ]; then',
      '  gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body "$message"',
      'else',
      '  gh issue create --repo "$GITHUB_REPOSITORY" --title "$ISSUE_TITLE" --body "$message"',
      'fi',
    ].join('\n'),
  };
  const checkoutReady = {
    name: 'Confirm site checkout succeeded',
    id: 'checkout',
    if: `always() && (steps.${primaryId}.outcome == 'success' || steps.site_checkout_retry.outcome == 'success')`,
    run: 'true',
  };
  job.steps.splice(checkoutIndex, 1, primary, backoff, retry, reportCheckoutFailure, checkoutReady);

  const diagnosticFailureCondition =
    `failure() && (steps.${primaryId}.outcome == 'success' || steps.site_checkout_retry.outcome == 'success')`;
  let diagnosticReporter = null;

  // Il repository del sito e' ora il working tree locale del job: le due
  // composite action non devono piu' provocare un secondo codeload cross-repo.
  for (const step of job.steps) {
    if (typeof step?.run === 'string') {
      if (/^npm ci(?:\s|$)/.test(step.run)) {
        step.run = `bash scripts/ci/crawler-retry-cmd.sh ${step.run}`;
      } else if (step.run === 'npx playwright install --with-deps chromium') {
        step.run = `bash scripts/ci/crawler-retry-cmd.sh ${step.run}`;
      }
    }
    if (typeof step?.uses !== 'string') continue;
    const match = /^valerielinc-ops\/frontaliere-si-o-no\/(\.github\/actions\/[^@]+)@main$/.exec(step.uses);
    if (match) step.uses = `./${match[1]}`;
    if (step.uses === './.github/actions/report-failure') {
      if (diagnosticReporter) {
        throw new Error(`${name}: standalone workflow has multiple diagnostic failure reporters`);
      }
      diagnosticReporter = step;
      step.if = diagnosticFailureCondition;
      step.with = {
        ...step.with,
        title: `Workflow Failure: ${name}`,
        'github-token': '${{ github.token }}',
        repo: '${{ github.repository }}',
        'workflow-name': name,
        // Il working tree del job e' il checkout SITO. La copia byte-identica
        // dell'artifact corpus vive nel bundle portabile, non sotto workflows/
        // dove esiste ancora il chiamante locale disabilitato.
        'workflow-file': `.github/corpus-workflows/${workflowFile}`,
      };
    }
  }

  // I gruppi crawler riportavano i guasti interni dei singoli crawler, ma non
  // quelli degli step condivisi fra checkout e avvio della logica (setup-node,
  // npm ci, Remote Config e composite action). Il reporter checkout resta uno
  // shell step separato perché, se entrambi i checkout falliscono, l'action
  // locale non esiste nel working tree. Dopo almeno un checkout riuscito,
  // invece, questo catch-all viene inserito PRIMA del primo background step:
  // vede i guasti del setup condiviso ma non duplica le issue per-crawler che
  // ogni background step crea gia' da solo.
  if (!diagnosticReporter) {
    const firstCrawlerAt = job.steps.findIndex((step) => step?.background === true);
    if (firstCrawlerAt < 0) {
      throw new Error(`${name}: no diagnostic reporter and no crawler boundary`);
    }
    job.steps.splice(firstCrawlerAt, 0, {
      name: 'Report shared setup failure to GitHub Issues',
      if: diagnosticFailureCondition,
      uses: './.github/actions/report-failure',
      with: {
        title: `Workflow Failure: ${name}`,
        'closed-by': 'close-recovered-failure-issues',
        'github-token': '${{ github.token }}',
        repo: '${{ github.repository }}',
        'workflow-name': name,
        'workflow-file': `.github/corpus-workflows/${workflowFile}`,
        priority: '2',
      },
    });
  }

  const standalone = {
    name,
    ...(runName ? { 'run-name': runName } : {}),
    on: trigger,
    concurrency,
    permissions: { actions: 'read', contents: 'read', issues: 'write' },
    env: workflow.env,
    jobs: workflow.jobs,
  };

  const yaml = YAML.stringify(standalone, { lineWidth: 0 });
  const runtimeDependencyHeader = runtimePaths.length > 0
    ? [
        '# Hash-bound site runtime dependencies used transitively by this workflow:',
        ...runtimePaths.map((runtimePath) => `# - ${runtimePath}`),
      ]
    : [];
  return [
    '# AUTO-GENERATED by frontaliere-si-o-no/scripts/generate-crawler-group-workflows.mjs — DO NOT EDIT.',
    '# Source logic stays in the site repo; this standalone artifact runs on the corpus pool.',
    '# Only pre-logic checkout/install setup is retryable, so a partial crawl is never replayed.',
    ...runtimeDependencyHeader,
    '',
    yaml,
  ].join('\n');
}

function groupTrigger(logic) {
  return {
    workflow_dispatch: {
      inputs: {
        ...logic.on.workflow_call.inputs,
        site_code_commit: {
          description: 'Full immutable site commit used by this generation (empty keeps legacy main)',
          required: false,
          default: '',
          type: 'string',
        },
        timeout_ms: {
          description: 'Per-crawler timeout override in milliseconds (empty uses the crawler default)',
          required: false,
          default: '',
          type: 'string',
        },
        strict_localization: {
          description: 'Require localized job data (1=yes)',
          required: false,
          default: '1',
          type: 'string',
        },
      },
    },
  };
}

function translateTrigger(logic) {
  return {
    schedule: [
      { cron: '0 7 * * *' },
      { cron: '0 13 * * *' },
      { cron: '0 1 * * *' },
      { cron: '20 1 * * *' },
      { cron: '20 4 * * *' },
    ],
    workflow_dispatch: { inputs: logic.on.workflow_call.inputs },
  };
}

/** Genera i 23 workflow crawler + translate-pending e il loro contratto hash. */
/**
 * @param {{
 *   groupResults?: Array<{groupIndex: number, content: string}>,
 *   outDir?: string,
 *   contractPath?: string,
 *   workflowsDir?: string,
 *   translateLogicPath?: string,
 *   write?: boolean,
 * }} [options]
 */
export function generateCrossRepoExecutionArtifacts({
  groupResults,
  outDir,
  contractPath,
  workflowsDir = WORKFLOWS_DIR,
  translateLogicPath = TRANSLATE_LOGIC_PATH,
  write = true,
} = {}) {
  if (!outDir || !contractPath) throw new Error('cross-repo generation requires outDir and contractPath');
  if (!Array.isArray(groupResults) || groupResults.length !== GROUP_COUNT) {
    throw new Error(`cross-repo generation requires exactly ${GROUP_COUNT} generated groups`);
  }
  if (!validateCrawlerGenerationRoster(groupResults.generationRoster).valid) {
    throw new Error('cross-repo generation requires a valid crawler generation roster');
  }

  const artifacts = [];
  const artifactContents = [];
  const workflowPayloads = new Map();
  for (const result of groupResults) {
    const nn = String(result.groupIndex).padStart(2, '0');
    const fileName = `crawler-group-${nn}.yml`;
    const logicPath = path.join(workflowsDir, `crawler-group-${nn}-logic.yml`);
    const logicText = fs.readFileSync(logicPath, 'utf8');
    const members = assertCrawlerLogicParity(result.content, logicText, path.basename(logicPath));
    const logic = YAML.parse(logicText);
    const content = buildStandaloneCrossRepoWorkflow({
      logicText,
      name: `Crawler Group ${nn} (sparse cross-repo execution)`,
      runName: `crawler-generation-\${{ inputs.generation_token }}-group-${nn}`,
      workflowFile: fileName,
      trigger: groupTrigger(logic),
      concurrency: { group: `jobs-crawler-group-${nn}`, 'cancel-in-progress': false },
      runtimePaths: CRAWLER_GENERATION_RUNTIME_PATHS,
      checkoutRef: "${{ inputs.site_code_commit || 'main' }}",
    });
    YAML.parse(content);
    workflowPayloads.set(fileName, content);
    artifactContents.push(content);
    artifacts.push({
      file: fileName,
      sourceLogic: path.basename(logicPath),
      sourceSha256: sha256(logicText),
      artifactSha256: sha256(content),
      members,
    });
  }

  const translateLogicText = fs.readFileSync(translateLogicPath, 'utf8');
  const translateLogic = YAML.parse(translateLogicText);
  const translateContent = buildStandaloneCrossRepoWorkflow({
    logicText: translateLogicText,
    name: 'Translate Pending Jobs (sparse cross-repo execution)',
    workflowFile: 'translate-pending.yml',
    trigger: translateTrigger(translateLogic),
    concurrency: { group: 'jobs-data-pipeline', 'cancel-in-progress': false },
  });
  YAML.parse(translateContent);
  workflowPayloads.set('translate-pending.yml', translateContent);
  artifactContents.push(translateContent);
  artifacts.push({
    file: 'translate-pending.yml',
    sourceLogic: path.basename(translateLogicPath),
    sourceSha256: sha256(translateLogicText),
    artifactSha256: sha256(translateContent),
    members: [],
  });

  const bucketTable = loadJson(CHECKOUT_BUCKETS_PATH);
  const excluded = bucketTable.buckets.filter((bucket) => CROSS_REPO_SAFE_EXCLUDED_BUCKETS.has(bucket.id));
  const crawlerMembers = artifacts.flatMap((artifact) => artifact.members);
  const observerPayloads = [];
  const observers = CORPUS_OBSERVER_FILES.map(({ source, target }) => {
    const siteSource = CORPUS_OBSERVER_SITE_SOURCES.get(source);
    const canonicalPath = siteSource
      ? path.join(REPO_ROOT, siteSource)
      : path.join(PORTABLE_CORPUS_DIR, source);
    const content = fs.readFileSync(canonicalPath);
    observerPayloads.push({ source, content });
    return { source, target, sha256: sha256(content) };
  });
  const siteRuntimePaths = collectSiteRuntimePaths([
    ...artifactContents,
    ...observerPayloads
      .filter(({ source }) => /\.ya?ml$/.test(source))
      .map(({ content }) => content.toString('utf8')),
  ]);
  const contract = {
    schemaVersion: 1,
    generatedBy: 'frontaliere-si-o-no/scripts/generate-crawler-group-workflows.mjs',
    generatorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    sourceRepository: SITE_REPOSITORY,
    groupCount: GROUP_COUNT,
    artifactCount: artifacts.length,
    observerCount: observers.length,
    crawlerCount: crawlerMembers.length,
    crawlerGeneration: {
      mode: 'shadow',
      rosterPath: 'scripts/ci/crawler-generation-roster.json',
      rosterDigest: groupResults.generationRoster.digest,
      artifactRetentionDays: CRAWLER_GENERATION_ARTIFACT_RETENTION_DAYS,
      dispatchesTranslation: false,
    },
    siteRuntimePaths,
    observers,
    checkout: {
      attempts: 2,
      backoffSeconds: CROSS_REPO_BACKOFF_SECONDS,
      retryScope: 'checkout-before-logic-only',
      reporter: 'corpus-issue-github-token',
      excludedBuckets: excluded.map((bucket) => bucket.id),
      excludedMb: excluded.reduce((sum, bucket) => sum + bucket.mb, 0),
      treeMb: bucketTable.treeMb,
    },
    artifacts,
  };
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    for (const [fileName, content] of workflowPayloads) {
      writeFileAtomic(path.join(outDir, fileName), content);
    }
    for (const { source, content } of observerPayloads) {
      const outputPath = path.join(outDir, source);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileAtomic(outputPath, content);
    }
    writeJsonAtomic(contractPath, contract);
  }
  return {
    artifacts,
    contract,
    translateContent,
    workflowContents: Object.fromEntries(workflowPayloads),
    observerContents: Object.fromEntries(observerPayloads.map(({ source, content }) => [source, content])),
  };
}

/** Render every generated artifact without writing and report committed drift. */
export function checkGeneratedArtifacts({ profileRenderer = computeProfiledText } = {}) {
  const groupResults = generate({ profileRenderer, write: false });
  const logicArtifacts = generateCrawlerLogicArtifacts({ groupResults, write: false });
  const cross = generateCrossRepoExecutionArtifacts({
    groupResults,
    outDir: PORTABLE_CORPUS_DIR,
    contractPath: PORTABLE_CONTRACT_PATH,
    write: false,
  });
  const changed = [];
  for (const result of groupResults) {
    if (fs.readFileSync(result.filePath, 'utf8') !== result.content) changed.push(result.filePath);
  }
  for (const artifact of logicArtifacts) {
    const filePath = path.join(WORKFLOWS_DIR, artifact.fileName);
    if (fs.readFileSync(filePath, 'utf8') !== artifact.content) changed.push(filePath);
  }
  for (const [fileName, content] of Object.entries(cross.workflowContents)) {
    const filePath = path.join(PORTABLE_CORPUS_DIR, fileName);
    if (fs.readFileSync(filePath, 'utf8') !== content) changed.push(filePath);
  }
  for (const [source, content] of Object.entries(cross.observerContents)) {
    const filePath = path.join(PORTABLE_CORPUS_DIR, source);
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(content)) changed.push(filePath);
  }
  if (canonicalJson(loadJson(CRAWLER_GENERATION_ROSTER_PATH)) !== canonicalJson(groupResults.generationRoster)) {
    changed.push(CRAWLER_GENERATION_ROSTER_PATH);
  }
  if (canonicalJson(loadJson(PORTABLE_CONTRACT_PATH)) !== canonicalJson(cross.contract)) {
    changed.push(PORTABLE_CONTRACT_PATH);
  }
  return { changed, groupResults, logicArtifacts, cross };
}

export function generate({
  manifestPath = MANIFEST_PATH,
  baselinePath = BASELINE_PATH,
  outDir = WORKFLOWS_DIR,
  // Il default SEGUE outDir, non e' fisso su data/: generare in una cartella
  // di scratch (test, dry-run, ispezione) non deve poter riscrivere i pin del
  // repo. Ci sono gia' cascati i test di generate() qui accanto, che passano un
  // outDir temporaneo e nessun assignmentsPath.
  assignmentsPath = outDir === WORKFLOWS_DIR
    ? ASSIGNMENTS_PATH
    : path.join(outDir, 'crawler-group-assignments.json'),
  crawlerGenerationRosterPath = outDir === WORKFLOWS_DIR
    ? CRAWLER_GENERATION_ROSTER_PATH
    : path.join(outDir, 'crawler-generation-roster.json'),
  profileRenderer = computeProfiledText,
  write = true,
  // `--rebalance`: throw the pins away and re-derive membership with the global
  // bin-pack. Rewrites all 23 files by design — a deliberate, reviewed action,
  // never a side effect of adding or removing one crawler (#6482).
  rebalance = false,
} = {}) {
  const { manifest } = loadJson(manifestPath);
  const baseline = loadJson(baselinePath);
  const medianMs = baseline.medianDurationMs;

  const crawlers = manifest.map((c) => {
    const baselineEntry = baseline.crawlers[c.file.replace(/^\.github\/workflows\//, '').replace(/\.yml$/, '')];
    const durationMs = baselineEntry ? baselineEntry.avgDurationMs : medianMs;
    return { ...c, durationMs };
  });

  // Membership comes from the persisted pins, not from a fresh global
  // bin-pack — see the STABLE ASSIGNMENT block above (#6482). `--rebalance` is
  // the one path that still lets packGroups() decide, and it then overwrites
  // the pins with its result.
  const pinned = rebalance
    ? packGroups(crawlers, GROUP_COUNT, medianMs).map((g) => g.members.map((m) => m.slug))
    : loadAssignments(assignmentsPath, GROUP_COUNT);

  const { groups, assignments, added, removed } = assignGroupsStable(crawlers, pinned, medianMs);

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
  // Validate every crawler identity and slice before the first generated file
  // is replaced. A malformed receipt roster must not leave a partial 23-group
  // render on disk.
  const generationRoster = crawlerGenerationRosterFromGroups(groups);

  const results = [];
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-group-render-'));
  try {
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
      const fileName = `crawler-group-${String(groupIndex).padStart(2, '0')}.yml`;
      const filePath = path.join(outDir, fileName);
      // Il preambolo scritto a mano sopra il marker AUTO-GENERATED sopravvive alla
      // rigenerazione: e' la nota che spiega perche' QUEL file e' speciale (il
      // pilota cross-repo di crawler-group-23), e riscriverla a mano a ogni giro e'
      // la stessa deriva che questa PR chiude. Il corpo resta rigenerato da zero.
      const preamble = extractManualPreamble(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '');
      const fileContent = `${preamble}${workflowHeaderComment(groupIndex, group)}\n\n${yamlBody}`;
      const stagingPath = path.join(stagingDir, fileName);
      fs.writeFileSync(stagingPath, fileContent, 'utf8');
      // Calcola il profilo su staging: tutti i 23 file sono renderizzati e
      // validati prima che una sola destinazione venga sostituita.
      const finalContent = profileRenderer(stagingPath, npmScriptsForAnalyzer()).text;
      YAML.parse(finalContent);
      results.push({
        fileName,
        filePath,
        groupIndex,
        memberCount: group.members.length,
        wallClockMs: group.wallClockMs,
        members: group.members.map((m) => m.slug),
        content: finalContent,
      });
    });
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  results.assignmentsAdded = added;
  results.assignmentsRemoved = removed;
  results.generationRoster = generationRoster;
  if (write) {
    // Commit phase: render/validation is complete. Every individual replace is
    // atomic; a late render/parity error above leaves every destination intact.
    fs.mkdirSync(outDir, { recursive: true });
    writeJsonAtomic(assignmentsPath, assignmentsDoc(assignments));
    for (const result of results) writeFileAtomic(result.filePath, result.content);
    writeJsonAtomic(crawlerGenerationRosterPath, generationRoster);
  }
  return results;
}

/**
 * Rebuild the pin file from the COMMITTED crawler-group-*.yml files.
 *
 * The recovery path, and the way the pins were seeded in the first place: the
 * .yml files are the artefact that actually describes production, so when the
 * pins and the .yml disagree (a hand-edit like PR #6484, a rebase onto a branch
 * that touched a group, a pin file lost in a merge) the .yml wins and this
 * reads the truth back out of them. Reads the ordered `id: crawler-<slug>`
 * background steps — the same identity the generator writes.
 */
export function extractAssignmentsFromWorkflows(outDir = WORKFLOWS_DIR) {
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^crawler-group-\d+\.yml$/.test(f))
    .sort();
  return files.map((f) => {
    const doc = YAML.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    const jobKey = Object.keys(doc.jobs)[0];
    return (doc.jobs[jobKey].steps || [])
      .filter((s) => s && s.background && typeof s.id === 'string')
      .map((s) => /^crawler-(.+)$/.exec(s.id))
      .filter(Boolean)
      .map((m) => m[1]);
  });
}

/** Write the pin file derived from the committed workflows. Returns the path. */
export function bootstrapAssignmentsFromWorkflows({
  outDir = WORKFLOWS_DIR,
  assignmentsPath = ASSIGNMENTS_PATH,
} = {}) {
  const groups = extractAssignmentsFromWorkflows(outDir);
  writeJsonAtomic(assignmentsPath, assignmentsDoc(groups));
  return { assignmentsPath, groups };
}

// CLI entry point
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  const bootstrap = process.argv.includes('--bootstrap-from-workflows');
  const rebalance = process.argv.includes('--rebalance');
  const crossRepoOutAt = process.argv.indexOf('--cross-repo-out-dir');
  const crossRepoContractAt = process.argv.indexOf('--cross-repo-contract');
  if (check && (bootstrap || rebalance || crossRepoOutAt >= 0 || crossRepoContractAt >= 0)) {
    throw new Error('--check cannot be combined with bootstrap, output or rebalance options');
  }
  if (bootstrap) {
    const { assignmentsPath, groups } = bootstrapAssignmentsFromWorkflows();
    console.log(`Pins rebuilt from the committed workflows -> ${assignmentsPath}`);
    console.log(`  ${groups.length} groups, ${groups.flat().length} crawlers`);
    process.exit(0);
  }
  if ((crossRepoOutAt >= 0) !== (crossRepoContractAt >= 0)) {
    throw new Error('--cross-repo-out-dir and --cross-repo-contract must be passed together');
  }
  if (check) {
    const { changed } = checkGeneratedArtifacts();
    if (changed.length > 0) {
      throw new Error(`Generated crawler artifacts are stale:\n${changed.map((filePath) => `  ${path.relative(REPO_ROOT, filePath)}`).join('\n')}`);
    }
    console.log('Generated crawler artifacts are up to date; wrote nothing.');
    process.exit(0);
  }
  // La generazione per il corpus legge il gruppo locale come sorgente ma non
  // deve riscriverlo: i due repo hanno PR/branch indipendenti e un export non
  // e' autorizzato a portarsi dietro un diff locale accidentale (es. stale pin).
  const results = generate({ rebalance, write: crossRepoOutAt < 0 });
  generateCrawlerLogicArtifacts({ groupResults: results, write: crossRepoOutAt < 0 });
  if (crossRepoOutAt >= 0) {
    const outDir = path.resolve(process.argv[crossRepoOutAt + 1]);
    const contractPath = path.resolve(process.argv[crossRepoContractAt + 1]);
    const cross = generateCrossRepoExecutionArtifacts({
      groupResults: results,
      outDir,
      contractPath,
    });
    console.log(`Generated ${cross.artifacts.length} standalone corpus workflows -> ${outDir}`);
    console.log(`Cross-repo contract -> ${contractPath}`);
  } else {
    const cross = generateCrossRepoExecutionArtifacts({
      groupResults: results,
      outDir: PORTABLE_CORPUS_DIR,
      contractPath: PORTABLE_CONTRACT_PATH,
    });
    console.log(`Generated ${cross.artifacts.length} portable corpus workflows -> ${PORTABLE_CORPUS_DIR}`);
  }
  if (rebalance) {
    console.log('⚠️  --rebalance: membership re-derived from scratch — expect all 23 files to change.');
  }
  for (const slug of results.assignmentsRemoved) console.log(`  - unassigned (gone from the manifest): ${slug}`);
  for (const slug of results.assignmentsAdded) console.log(`  + newly assigned: ${slug}`);
  console.log(`Generated ${results.length} group workflows:`);
  for (const r of results) {
    console.log(`  ${r.fileName}: ${r.memberCount} crawlers, ~${Math.round(r.wallClockMs / 60000)}min wall-clock`);
  }
}
