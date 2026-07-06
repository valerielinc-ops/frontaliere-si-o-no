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
 */
function buildCrawlerShellBody(crawler) {
  const lines = [];
  lines.push('set -uo pipefail');
  lines.push('');
  lines.push(`# ---- ${crawler.slug}: run crawler (verbatim from original workflow) ----`);
  lines.push(renderEnvExports(crawler.runStep.env));
  lines.push(crawler.runStep.run.trimEnd());
  lines.push(`crawler_exit=$?`);
  lines.push('');

  for (const step of crawler.postSteps) {
    const isFailureReport = step.if === 'failure()';
    const isCommitStep = step.name === 'Commit and push';

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
      const crawlerWorkflowId = `Run ${crawler.slug}`;
      const literalizedRun = step.run
        .split('${{ github.workflow }}')
        .join(crawlerWorkflowId);
      lines.push(`# ---- ${crawler.slug}: ${step.name} (verbatim except github.workflow -> literal per-crawler id, only on crawler failure) ----`);
      lines.push('if [ "$crawler_exit" -ne 0 ]; then');
      lines.push(indentBlock(renderEnvExports(step.env), 2));
      lines.push(indentBlock(literalizedRun.trimEnd(), 2));
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
    lines.push(indentBlock(renderEnvExports(step.env), 2));

    if (isCommitStep) {
      // HAZARD FIX 2: serialize the local git index mutation across
      // concurrent background steps sharing this job's working copy.
      // Only the commit+push moment is serialized (seconds), not the
      // crawl itself. See file header for rationale.
      lines.push(
        indentBlock(`flock /tmp/crawler-group-git.lock -c ${shellQuote(step.run.trimEnd())} || true`, 2),
      );
    } else {
      // Housekeeping already has continue-on-error semantics in the
      // original workflow (never fails the job) — preserve with `|| true`.
      lines.push(indentBlock(`(${step.run.trimEnd()}) || true`, 2));
    }
    lines.push('fi');
    lines.push('');
  }

  lines.push('exit "$crawler_exit"');
  return lines.join('\n');
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render `export KEY=value` lines for a step's env map, preserving each
 * value's original quoting semantics from the source workflow YAML.
 *
 * Values containing a GitHub Actions expression (`${{ ... }}`) are emitted
 * double-quoted, NOT single-quoted: GitHub substitutes `${{ ... }}` with its
 * final literal text BEFORE the shell ever parses the line (exactly as it
 * already does for every step-level YAML `env:` value in the original 581
 * workflows) — a hand-escaped single-quote wrapper would corrupt any
 * single-quoted fallback literal already inside the expression itself (e.g.
 * `${{ github.event.inputs.timeout_ms || '' }}`). Double-quoting is safe
 * here because these expressions only ever resolve to plain identifiers,
 * booleans, or simple strings (crawler slugs, "0"/"1", empty string) with no
 * embedded double-quotes or un-escaped `$`/backticks.
 *
 * Plain literal values (no `${{ }}`) are single-quoted as usual.
 */
function renderEnvExports(env) {
  if (!env) return '';
  const lines = Object.entries(env).map(([k, v]) => {
    const value = String(v);
    if (value.includes('${{')) {
      return `export ${k}="${value}"`;
    }
    return `export ${k}=${shellQuote(value)}`;
  });
  return lines.join('\n');
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

  for (const crawler of group.members) {
    const stepId = `crawler-${crawler.slug}`;
    const summaryFile = `/tmp/slug-history-summary-${crawler.slug}.txt`;

    steps.push({
      name: `Run ${crawler.slug}`,
      id: stepId,
      background: true,
      env: {
        // HAZARD FIX 1: unique per-crawler telemetry file so concurrent
        // background steps sharing this job's /tmp can never steal or
        // delete a sibling's slug-history summary. See file header.
        SLUG_HISTORY_SUMMARY_FILE: summaryFile,
      },
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

    if (write) {
      fs.writeFileSync(filePath, fileContent, 'utf8');
    }

    results.push({
      fileName,
      filePath,
      groupIndex,
      memberCount: group.members.length,
      wallClockMs: group.wallClockMs,
      members: group.members.map((m) => m.slug),
      content: fileContent,
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
