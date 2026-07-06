#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/generate-crawler-group-workflows.mjs
//
// Generates the 23 consolidated `.github/workflows/crawler-group-NN.yml` files
// that replace the 581 individual `update-jobs-*.yml` per-crawler workflows.
//
// WHY: each individual crawler workflow, once dispatched, holds one of
// GitHub Free tier's 20 concurrent-job slots for its full run duration
// (mean ~27min, up to ~3h for Coop) — ~1160 dispatches/day starve all other
// CI (PR tests, review-loop) of runner slots. GitHub Actions' "parallel
// steps" feature (`background: true` + a later `wait-all: true` step) lets
// many crawlers run *concurrently inside ONE job*, so the job holds only
// ONE concurrent slot no matter how many crawlers it contains. A matrix
// strategy would NOT achieve this — matrix = one job per entry = still one
// slot per entry.
//
// CRITICAL CONSTRAINT (do not violate): each crawler's commit-and-push and
// error-reporting mechanism must be preserved EXACTLY as implemented in its
// own existing workflow — no shared/generic commit or error-reporting step.
// Real inspection of all 581 files (see scripts/extract-crawler-manifest.mjs)
// found meaningful per-crawler variance beyond commit-message text: some
// pass an extra `data/jobs-crawler-adapters/` path to git-commit-data.sh,
// some run `npm ci --ignore-scripts`, some need a Playwright browser install
// + `xvfb-run -a`, step names differ ("Housekeeping" vs "Scoped
// housekeeping"), and 2/581 lack a housekeeping step entirely. We therefore
// do NOT reconstruct these steps from a generic template — we splice each
// crawler's own extracted bespoke steps (data/crawler-manifest.json) into a
// composite shell script, byte-for-byte per `run:` body.
//
// GitHub Actions' `background: true` applies to exactly one step (one
// `run:` block), not a multi-step sub-job — so each crawler's ordered list
// of bespoke steps (install-deps, optional Playwright install, Firebase
// prep, RC secrets load, run-crawler, housekeeping, commit, report-failure)
// is collapsed into ONE composite shell script that:
//   - runs each sub-step's `run:` body in order, in the SAME shell process
//     (so `export FOO=bar` in one sub-step is visible to later sub-steps,
//     replicating the real $GITHUB_ENV-passing behavour without needing the
//     file trick)
//   - sets each sub-step's own `env:` vars as local `export`s scoped right
//     before that sub-step's body runs
//   - treats a step's own `continue-on-error: true` as "log and continue,
//     don't fail the composite step" (this is exactly Housekeeping and
//     Report-failure in the real corpus — verified: no OTHER step name
//     carries continue-on-error)
//   - treats a step's `if: failure()` as "only run if a PRIOR non-
//     continue-on-error sub-step in this composite failed"
//   - exits non-zero at the end iff any non-continue-on-error sub-step
//     failed, so the background step genuinely fails and `wait-all`
//     propagates it to the job (verified pattern already in this repo:
//     .github/workflows/build-evidence-and-tune.yml,
//     .github/workflows/post-deploy-validate-live.yml)
//
// THE SLUG-HISTORY-JOURNAL FIX: scripts/lib/slug-history-journal.mjs's
// defaultSummaryPath() writes per-run telemetry to
// `process.env.SLUG_HISTORY_SUMMARY_FILE || /tmp/slug-history-summary-${pid}.txt`.
// The consumer, scripts/lib/git-commit-data.sh, when SLUG_HISTORY_SUMMARY_FILE
// is unset, falls back to `ls -t /tmp/slug-history-summary-*.txt | head -1` —
// picks the globally-newest file in /tmp with NO crawler-name binding, reads
// it into THAT crawler's commit message, then deletes it. Once many crawlers
// share one job's /tmp as concurrent background steps, a crawler's commit
// step can steal + delete a SIBLING's telemetry file. Fix (belongs entirely
// here, NOT in slug-history-journal.mjs/git-commit-data.sh — those stay
// correct for any future single-crawler-per-job usage): every composite
// step's top-level `env:` sets
// `SLUG_HISTORY_SUMMARY_FILE: /tmp/slug-history-summary-<crawlerSlug>.txt`,
// unique per crawler name — no PID needed since it's explicitly name-scoped.
//
// BIN-PACKING: job wall-clock for a group = MAX duration among its
// background-step members (they run concurrently, not summed). We sort all
// crawlers descending by historical avg duration (data/crawler-workflow-
// duration-baseline.json) and round-robin assign into GROUP_COUNT groups,
// which is the standard longest-processing-time (LPT) heuristic for
// balancing makespan across a fixed number of bins. Extreme outliers (e.g.
// Coop's ~2h95) land in the same round as several other slow crawlers under
// round-robin — to actually isolate a true bottleneck instead of just placing
// it, we peel off crawlers above OUTLIER_THRESHOLD_MS into their own
// dedicated singleton groups FIRST, then round-robin the rest into the
// remaining groups. This ensures no group's bottleneck is worse than
// necessary and keeps groups well under GitHub's 6h job timeout with margin.
//
// Usage: node scripts/generate-crawler-group-workflows.mjs
// Inputs:
//   data/crawler-manifest.json                    (scripts/extract-crawler-manifest.mjs)
//   data/crawler-workflow-duration-baseline.json  (scripts/fetch-crawler-workflow-durations.mjs)
// Output: .github/workflows/crawler-group-01.yml .. crawler-group-23.yml
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { lptBins } from './ci/lpt-shard.mjs';

export const GROUP_COUNT = 23;
// A group whose single member exceeds this is better off alone: bundling it
// with others would make that group's wall-clock dominated by the outlier
// while contributing zero concurrency benefit for the outlier's own runtime.
export const OUTLIER_THRESHOLD_MS = 90 * 60 * 1000; // 90 minutes
// GitHub Actions job hard timeout is 6h (360min); keep real margin under it.
export const JOB_TIMEOUT_MINUTES = 300;

const MANIFEST_PATH = path.resolve('data/crawler-manifest.json');
const DURATION_BASELINE_PATH = path.resolve('data/crawler-workflow-duration-baseline.json');
const WORKFLOWS_DIR = path.resolve('.github/workflows');

// ── Bin-packing ──────────────────────────────────────────────────────────────
// Reuses the corpus's existing, already-tested LPT bin-packer
// (scripts/ci/lpt-shard.mjs, tests/lpt-shard.test.ts) instead of a bespoke
// implementation — same greedy longest-processing-time heuristic already
// used to balance the vitest shard split. `lptBins` sums weights per bin
// (correct for vitest's "shard wall = sum of its files' durations"); here a
// group's wall-clock is `max`, not `sum`, of its concurrent background
// steps. Feeding it pre-sorted, pre-outlier-isolated input and reading back
// `Math.max(...bin.items)` instead of `bin.load` reconciles the two models
// without forking the algorithm.
/**
 * Partition crawlers into `groupCount` groups so that the max-per-group
 * (concurrent wall-clock bottleneck) is as balanced as possible, isolating
 * extreme outliers into their own singleton groups first.
 *
 * @param {Array<{crawlerSlug: string, durationMs: number}>} crawlers
 * @param {number} groupCount
 * @param {number} outlierThresholdMs
 * @returns {Array<Array<{crawlerSlug: string, durationMs: number}>>}
 */
export function partitionIntoGroups(crawlers, groupCount, outlierThresholdMs = OUTLIER_THRESHOLD_MS) {
  if (crawlers.length === 0) return Array.from({ length: groupCount }, () => []);

  const sorted = [...crawlers].sort((a, b) => b.durationMs - a.durationMs);
  const outliers = sorted.filter((c) => c.durationMs > outlierThresholdMs);
  const rest = sorted.filter((c) => c.durationMs <= outlierThresholdMs);

  const groups = Array.from({ length: groupCount }, () => []);

  // Give the biggest outliers their own dedicated groups first (one outlier
  // per group, up to groupCount - 1 so at least one group remains for "rest"
  // even in a pathological all-outlier scenario).
  const dedicatedOutlierCount = Math.min(outliers.length, Math.max(groupCount - 1, 0));
  for (let i = 0; i < dedicatedOutlierCount; i += 1) {
    groups[i].push(outliers[i]);
  }
  const overflowOutliers = outliers.slice(dedicatedOutlierCount);
  const remaining = [...overflowOutliers, ...rest];
  const remainingGroupCount = groupCount - dedicatedOutlierCount;

  if (remaining.length > 0 && remainingGroupCount > 0) {
    const bins = lptBins(remaining, {
      count: remainingGroupCount,
      weightOf: (c) => c.durationMs,
      keyOf: (c) => c.crawlerSlug,
    });
    for (let i = 0; i < remainingGroupCount; i += 1) {
      groups[dedicatedOutlierCount + i].push(...bins[i].items);
    }
  } else if (remaining.length > 0) {
    // groupCount fully consumed by dedicated outliers (pathological: would
    // need >= groupCount crawlers all above the outlier threshold) — spill
    // the overflow round-robin onto existing groups rather than dropping them.
    remaining.forEach((c, i) => groups[i % groupCount].push(c));
  }

  return groups;
}

// ── Duration lookup ──────────────────────────────────────────────────────────
function loadDurationLookup() {
  const raw = JSON.parse(fs.readFileSync(DURATION_BASELINE_PATH, 'utf8'));
  // Shape: { "<workflow-file>": { crawlerSlug, avgDurationMs } , ... }
  const values = Object.values(raw)
    .map((v) => v.avgDurationMs)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const median = values.length > 0 ? values[Math.floor(values.length / 2)] : 20 * 60 * 1000;
  return { byFile: raw, corpusMedianMs: median };
}

function durationForCrawler(entry, durationLookup) {
  const rec = durationLookup.byFile[entry.file];
  if (rec && typeof rec.avgDurationMs === 'number' && Number.isFinite(rec.avgDurationMs) && rec.avgDurationMs > 0) {
    return rec.avgDurationMs;
  }
  return durationLookup.corpusMedianMs;
}

// ── Composite step body generation ───────────────────────────────────────────
const SPECIAL_STEP_ROLE = {
  isHousekeeping: (step) => step['continue-on-error'] === true && !step.if,
  isReportFailure: (step) => step.if === 'failure()',
};

/**
 * Render one crawler's bespoke steps as a single composite bash script,
 * preserving each sub-step's run body, env scoping, continue-on-error
 * (best-effort, never aborts the composite) and if:failure() (only runs
 * when a prior required sub-step failed) semantics.
 *
 * Each sub-step body runs inside its OWN subshell `( ... )`. This is load-
 * bearing, not stylistic: in the real per-crawler workflows every step is
 * its own separate `run:` shell invocation, so an `exit 0` inside e.g.
 * "Prepare Firebase credentials (optional)" (real body: `else … exit 0; fi`
 * when the secret is absent) only ends THAT step — later steps (Load RC
 * secrets, Run crawler, Commit) still execute. Collapsed into one shell
 * process without subshell isolation, that same `exit 0` would terminate
 * the ENTIRE composite early, silently skipping every later sub-step for
 * that crawler (verified against scripts/update-jobs-*.yml corpus — the
 * Firebase-prep step's early-exit-when-secret-absent is real, present in
 * 580/581 files). The subshell boundary reproduces "step ends, job
 * continues" instead of "step ends, everything after it in this crawler is
 * silently dropped".
 *
 * Sub-steps that write to `$GITHUB_ENV` (Firebase-prep sets
 * GOOGLE_APPLICATION_CREDENTIALS, RC-load sets GH_TOKEN) need that value
 * visible to LATER sub-steps — subshell `export`s don't escape to the
 * parent, so we redirect `$GITHUB_ENV` to a real per-crawler temp file and
 * `source` it back into the parent shell after each sub-step, exactly
 * mirroring what the real Actions runner does between steps.
 */
export function renderCompositeScript(entry) {
  const envFile = `/tmp/gh-env-${entry.crawlerSlug}.sh`;
  const lines = [];
  lines.push('set +e  # composite emulates per-step continue-on-error/if:failure(); no global -e');
  lines.push('__STEP_FAILED=0');
  lines.push(`__GITHUB_ENV_FILE="${envFile}"`);
  lines.push(': > "$__GITHUB_ENV_FILE"');
  lines.push('');

  entry.bespokeSteps.forEach((step, idx) => {
    const label = step.name || `step-${idx}`;
    const isHousekeeping = SPECIAL_STEP_ROLE.isHousekeeping(step);
    const isReportFailure = SPECIAL_STEP_ROLE.isReportFailure(step);

    lines.push(`echo "::group::${shellEscapeForEcho(label)}"`);

    if (isReportFailure) {
      lines.push('if [ "$__STEP_FAILED" != "0" ]; then');
      lines.push(renderStepSubshell(step, '  '));
      lines.push('else');
      lines.push(`  echo "(skipped — no prior failure in this crawler's steps)"`);
      lines.push('fi');
    } else {
      lines.push(renderStepSubshell(step, ''));
      lines.push('__THIS_STEP_EXIT=$?');
      // Re-import anything the sub-step wrote to $GITHUB_ENV so later
      // sub-steps see it (GOOGLE_APPLICATION_CREDENTIALS, GH_TOKEN).
      lines.push('set -a; source "$__GITHUB_ENV_FILE"; set +a');
      if (isHousekeeping) {
        lines.push('if [ "$__THIS_STEP_EXIT" != "0" ]; then');
        lines.push(`  echo "::warning::${shellEscapeForEcho(label)} failed (exit $__THIS_STEP_EXIT) — continue-on-error, not failing the crawler"`);
        lines.push('fi');
      } else {
        lines.push('if [ "$__THIS_STEP_EXIT" != "0" ]; then');
        lines.push('  __STEP_FAILED=1');
        lines.push(`  echo "::error::${shellEscapeForEcho(label)} failed (exit $__THIS_STEP_EXIT)"`);
        lines.push('fi');
      }
    }
    lines.push('echo "::endgroup::"');
    lines.push('');
  });

  lines.push('rm -f "$__GITHUB_ENV_FILE"');
  lines.push('if [ "$__STEP_FAILED" != "0" ]; then');
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('exit 0');

  return lines.join('\n');
}

function shellEscapeForEcho(s) {
  return String(s).replace(/"/g, '\\"');
}

/**
 * Render one sub-step as `( export ...; GITHUB_ENV="$__GITHUB_ENV_FILE" <body> )`
 * — a subshell so an `exit` inside the body only ends that sub-step, with
 * $GITHUB_ENV redirected to the shared per-crawler temp file so writes
 * survive the subshell boundary for later sub-steps to `source`.
 */
function renderStepSubshell(step, indent) {
  const lines = [];
  lines.push(`${indent}(`);
  lines.push(`${indent}  export GITHUB_ENV="$__GITHUB_ENV_FILE"`);
  const env = step.env || {};
  for (const [key, value] of Object.entries(env)) {
    // GitHub expression values pass through verbatim — they're substituted by
    // the Actions runner at YAML-render time (this string is inside the
    // generated workflow's `run:` block, so ${{ }} is resolved BEFORE bash
    // ever sees it, same as in the original per-crawler workflows).
    lines.push(`${indent}  export ${key}=${quoteForShellExport(value)}`);
  }
  const body = (step.run || '').replace(/\n$/, '');
  for (const line of body.split('\n')) {
    lines.push(`${indent}  ${line}`);
  }
  lines.push(`${indent})`);
  return lines.join('\n');
}

function quoteForShellExport(value) {
  // Values are either GitHub expressions (${{ ... }}) or plain literals.
  // Wrap in double quotes so ${{ }} expressions (already substituted by the
  // Actions runner) and any literal spaces are preserved; escape embedded
  // double quotes and backticks/$ to prevent unintended shell expansion of
  // literal (non-expression) content.
  const str = String(value);
  const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`');
  return `"${escaped}"`;
}

// ── workflow_dispatch.inputs union ───────────────────────────────────────────
function unionWorkflowDispatchInputs(groupEntries, originalDocsBySlug) {
  const inputs = {};
  for (const entry of groupEntries) {
    const doc = originalDocsBySlug.get(entry.crawlerSlug);
    const declared = (doc && doc.on && doc.on.workflow_dispatch && doc.on.workflow_dispatch.inputs) || {};
    for (const [name, spec] of Object.entries(declared)) {
      if (!inputs[name]) inputs[name] = spec;
    }
  }
  return inputs;
}

// ── Workflow doc assembly ────────────────────────────────────────────────────
function buildGroupWorkflowDoc(groupIndex, groupEntries, originalDocsBySlug) {
  const groupName = `crawler-group-${String(groupIndex).padStart(2, '0')}`;

  const steps = [];
  steps.push({
    name: 'Checkout',
    uses: 'actions/checkout@v5',
    with: { 'fetch-depth': 0 },
  });
  steps.push({
    name: 'Setup Node.js',
    uses: 'actions/setup-node@v5',
    with: { 'node-version': '22', cache: 'npm' },
  });

  for (const entry of groupEntries) {
    steps.push({
      name: `Crawler: ${entry.workflowName}`,
      id: `crawler-${entry.crawlerSlug}`,
      background: true,
      env: {
        SLUG_HISTORY_SUMMARY_FILE: `/tmp/slug-history-summary-${entry.crawlerSlug}.txt`,
      },
      run: renderCompositeScript(entry),
    });
  }

  steps.push({
    name: `Wait for all ${groupEntries.length} crawlers in ${groupName}`,
    'wait-all': true,
  });

  const inputs = unionWorkflowDispatchInputs(groupEntries, originalDocsBySlug);

  const doc = {
    name: `Crawler Group ${String(groupIndex).padStart(2, '0')} (${groupEntries.length} crawlers)`,
    on: {
      workflow_dispatch: Object.keys(inputs).length > 0 ? { inputs } : null,
    },
    concurrency: {
      group: `crawler-group-${String(groupIndex).padStart(2, '0')}`,
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
      [`run-${groupName}`]: {
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': JOB_TIMEOUT_MINUTES,
        steps,
      },
    },
  };

  return doc;
}

// ── Original workflow docs (needed for input-union + Playwright detection) ──
function loadOriginalDocsBySlug(manifest) {
  const map = new Map();
  for (const entry of manifest) {
    const fullPath = path.join(WORKFLOWS_DIR, entry.file);
    if (!fs.existsSync(fullPath)) continue; // generator re-run after deletion
    map.set(entry.crawlerSlug, YAML.parse(fs.readFileSync(fullPath, 'utf8')));
  }
  return map;
}

// ── Header comment (traceability) ────────────────────────────────────────────
function headerComment(groupIndex, groupEntries) {
  const slugs = groupEntries.map((e) => e.crawlerSlug).join(', ');
  return [
    '# AUTO-GENERATED — do not edit by hand.',
    `# Source: node scripts/generate-crawler-group-workflows.mjs`,
    '# Regenerate after adding/removing/renaming a crawler (edit the crawler\'s',
    '# own script + npm script, re-run: node scripts/extract-crawler-manifest.mjs',
    '# && node scripts/generate-crawler-group-workflows.mjs).',
    '#',
    `# Group ${String(groupIndex).padStart(2, '0')} members (${groupEntries.length}): ${slugs}`,
    '#',
    '# Each "Crawler: ..." step below is a background:true composite shell',
    "# script that runs that ONE crawler's own install/prep/run/housekeeping/",
    '# commit/error-report sequence, spliced verbatim from its former dedicated',
    '# workflow file (data/crawler-manifest.json) — commit-and-push and error-',
    '# reporting mechanisms are UNCHANGED per crawler, just co-located in one',
    '# job so the group holds a single GitHub Actions concurrent-job slot',
    '# instead of one slot per crawler.',
    '',
  ].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const durationLookup = loadDurationLookup();
  const originalDocsBySlug = loadOriginalDocsBySlug(manifest);

  const crawlersWithDuration = manifest.map((entry) => ({
    ...entry,
    durationMs: durationForCrawler(entry, durationLookup),
  }));

  const groups = partitionIntoGroups(crawlersWithDuration, GROUP_COUNT);

  const summary = [];
  for (let i = 0; i < groups.length; i += 1) {
    const groupIndex = i + 1;
    const groupEntries = groups[i];
    if (groupEntries.length === 0) {
      console.warn(`⚠️  Group ${groupIndex} is empty — skipping file emission.`);
      summary.push({ group: groupIndex, members: 0, estWallClockMin: 0 });
      continue;
    }

    const doc = buildGroupWorkflowDoc(groupIndex, groupEntries, originalDocsBySlug);
    const yamlBody = YAML.stringify(doc, { lineWidth: 0 });
    const fileContent = headerComment(groupIndex, groupEntries) + '\n' + yamlBody;

    const outFile = path.join(
      WORKFLOWS_DIR,
      `crawler-group-${String(groupIndex).padStart(2, '0')}.yml`
    );
    fs.writeFileSync(outFile, fileContent, 'utf8');

    const maxMs = Math.max(...groupEntries.map((e) => e.durationMs));
    summary.push({
      group: groupIndex,
      members: groupEntries.length,
      estWallClockMin: Math.round(maxMs / 60000),
      slugs: groupEntries.map((e) => e.crawlerSlug),
    });
  }

  console.log('✅ Generated group workflows:');
  for (const s of summary) {
    console.log(`   group-${String(s.group).padStart(2, '0')}: ${s.members} crawlers, est. wall-clock ~${s.estWallClockMin}min`);
  }

  const totalMembers = summary.reduce((acc, s) => acc + s.members, 0);
  console.log(`Total crawlers placed: ${totalMembers} / ${manifest.length}`);
  if (totalMembers !== manifest.length) {
    console.error('❌ Mismatch between placed crawlers and manifest size!');
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
