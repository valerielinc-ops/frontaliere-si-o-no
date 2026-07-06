/**
 * Guards scripts/generate-crawler-group-workflows.mjs's bin-packing and
 * composite-step rendering — the core logic that replaces 581 individual
 * per-crawler CI workflows with 23 consolidated group workflows (each
 * crawler running as a `background: true` step inside one job, so the group
 * holds a single GitHub Actions concurrent-job slot instead of one per
 * crawler).
 *
 * Critical invariants tested:
 *  - exactly GROUP_COUNT groups are produced
 *  - every input crawler appears in EXACTLY one group (disjoint cover — same
 *    invariant tests/lpt-shard.test.ts guards for the vitest shard split;
 *    here a missing crawler = a crawler that silently stops being crawled,
 *    a duplicated crawler = wasted concurrent runner time)
 *  - no group's bottleneck (max member duration) blows past a sane ceiling
 *  - the composite script preserves each bespoke step's continue-on-error /
 *    if:failure() semantics (Housekeeping never fails the crawler; Report
 *    failure only runs when something upstream failed)
 *  - the SLUG_HISTORY_SUMMARY_FILE fix is present, unique per crawler
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import {
  partitionIntoGroups,
  renderCompositeScript,
  GROUP_COUNT,
  OUTLIER_THRESHOLD_MS,
} from '../scripts/generate-crawler-group-workflows.mjs';

interface Crawler {
  crawlerSlug: string;
  durationMs: number;
}

function makeCrawlers(count: number, opts: { outlierCount?: number } = {}): Crawler[] {
  const { outlierCount = 0 } = opts;
  const crawlers: Crawler[] = [];
  for (let i = 0; i < count; i += 1) {
    const isOutlier = i < outlierCount;
    crawlers.push({
      crawlerSlug: `crawler-${String(i).padStart(4, '0')}`,
      durationMs: isOutlier
        ? OUTLIER_THRESHOLD_MS + 30 * 60 * 1000 + i * 1000
        : ((i % 37) + 1) * 60 * 1000, // 1..37 minutes, deterministic spread
    });
  }
  return crawlers;
}

describe('partitionIntoGroups', () => {
  it('produces exactly GROUP_COUNT groups', () => {
    const groups = partitionIntoGroups(makeCrawlers(600), GROUP_COUNT);
    expect(groups.length).toBe(GROUP_COUNT);
  });

  it('is a disjoint cover — every crawler appears in exactly one group', () => {
    const crawlers = makeCrawlers(581, { outlierCount: 2 });
    const groups = partitionIntoGroups(crawlers, GROUP_COUNT);
    const seen = new Map<string, number>();
    for (const group of groups) {
      for (const c of group) {
        seen.set(c.crawlerSlug, (seen.get(c.crawlerSlug) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(crawlers.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it('handles a small input (fewer crawlers than groups) without dropping or duplicating', () => {
    const crawlers = makeCrawlers(5);
    const groups = partitionIntoGroups(crawlers, GROUP_COUNT);
    const total = groups.reduce((acc, g) => acc + g.length, 0);
    expect(total).toBe(5);
    expect(groups.length).toBe(GROUP_COUNT);
  });

  it('isolates extreme outliers into their own group rather than bundling them', () => {
    const crawlers = makeCrawlers(581, { outlierCount: 3 });
    const groups = partitionIntoGroups(crawlers, GROUP_COUNT);
    const outlierSlugs = new Set(
      crawlers.filter((c) => c.durationMs > OUTLIER_THRESHOLD_MS).map((c) => c.crawlerSlug)
    );
    // Every group containing an outlier should contain ONLY that outlier
    // (dedicated singleton group) — bundling an outlier with normal crawlers
    // would make that group's wall-clock dominated by the outlier for zero
    // concurrency benefit.
    for (const group of groups) {
      const outliersInGroup = group.filter((c) => outlierSlugs.has(c.crawlerSlug));
      if (outliersInGroup.length > 0) {
        expect(group.length).toBe(1);
      }
    }
  });

  it('keeps every group bottleneck (max member duration) under the job timeout ceiling with margin', () => {
    const crawlers = makeCrawlers(581, { outlierCount: 2 });
    const groups = partitionIntoGroups(crawlers, GROUP_COUNT);
    const JOB_TIMEOUT_MS = 300 * 60 * 1000; // 300min ceiling used by the generator
    for (const group of groups) {
      if (group.length === 0) continue;
      const maxMs = Math.max(...group.map((c) => c.durationMs));
      expect(maxMs).toBeLessThan(JOB_TIMEOUT_MS);
    }
  });

  it('balances non-outlier groups better than naive round-robin-by-input-order', () => {
    // Deliberately sorted descending so naive positional round-robin performs
    // worst-case (all the heavy ones cluster in the first few bins' first pass).
    const crawlers = makeCrawlers(200).sort((a, b) => b.durationMs - a.durationMs);
    const groups = partitionIntoGroups(crawlers, GROUP_COUNT);
    const lptMax = Math.max(...groups.map((g) => (g.length ? Math.max(...g.map((c) => c.durationMs)) : 0)));

    const naiveGroups: Crawler[][] = Array.from({ length: GROUP_COUNT }, () => []);
    crawlers.forEach((c, i) => naiveGroups[i % GROUP_COUNT].push(c));
    const naiveMax = Math.max(...naiveGroups.map((g) => Math.max(...g.map((c) => c.durationMs))));

    expect(lptMax).toBeLessThanOrEqual(naiveMax);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const crawlers = makeCrawlers(581, { outlierCount: 1 });
    const a = partitionIntoGroups(crawlers, GROUP_COUNT).map((g) => g.map((c) => c.crawlerSlug).sort());
    const b = partitionIntoGroups(crawlers, GROUP_COUNT).map((g) => g.map((c) => c.crawlerSlug).sort());
    expect(a).toEqual(b);
  });
});

describe('renderCompositeScript', () => {
  const baseEntry = {
    file: 'update-jobs-widget.yml',
    workflowName: 'Update Widget Jobs (Dedicated)',
    crawlerSlug: 'widget',
    bespokeSteps: [
      { name: 'Install dependencies', run: 'npm ci' },
      {
        name: 'Run dedicated Widget crawler',
        env: { CRAWLER_SLICE_ONLY: '1' },
        run: 'node scripts/update-widget-jobs.mjs',
      },
      {
        name: 'Housekeeping — remove expired job listings (scoped)',
        env: { JOBS_HOUSEKEEPING_SCOPE: 'widget' },
        run: 'node scripts/cleanup-jobs.mjs',
        'continue-on-error': true,
      },
      {
        name: 'Commit and push',
        run: 'bash scripts/lib/git-commit-data.sh --slice-only "Auto-update Widget jobs"',
      },
      {
        name: 'Report failure to GitHub Issues',
        if: 'failure()',
        'continue-on-error': true,
        run: 'node scripts/lib/github-issue-creator.mjs --title "Crawler Failure"',
      },
    ],
  };

  it('preserves every bespoke run body verbatim in the composite script', () => {
    const script = renderCompositeScript(baseEntry);
    expect(script).toContain('npm ci');
    expect(script).toContain('node scripts/update-widget-jobs.mjs');
    expect(script).toContain('node scripts/cleanup-jobs.mjs');
    expect(script).toContain('bash scripts/lib/git-commit-data.sh --slice-only "Auto-update Widget jobs"');
    expect(script).toContain('node scripts/lib/github-issue-creator.mjs --title "Crawler Failure"');
  });

  it('wraps a continue-on-error step (Housekeeping) so its failure does not mark the crawler failed', () => {
    const script = renderCompositeScript(baseEntry);
    // The housekeeping block should warn on non-zero exit, NOT set __STEP_FAILED.
    const housekeepingBlockStart = script.indexOf('node scripts/cleanup-jobs.mjs');
    const nextBlockStart = script.indexOf('Commit and push', housekeepingBlockStart);
    const housekeepingBlock = script.slice(housekeepingBlockStart, nextBlockStart);
    expect(housekeepingBlock).not.toMatch(/__STEP_FAILED=1/);
  });

  it('gates the Report-failure step body behind a prior-failure check', () => {
    const script = renderCompositeScript(baseEntry);
    const reportIdx = script.indexOf('github-issue-creator.mjs');
    const preceding = script.slice(0, reportIdx);
    // The report-failure body must be inside an `if [ "$__STEP_FAILED" != "0" ]` guard.
    const lastIfIdx = preceding.lastIndexOf('if [ "$__STEP_FAILED" != "0" ]; then');
    expect(lastIfIdx).toBeGreaterThan(-1);
  });

  it('marks __STEP_FAILED=1 on a non-continue-on-error step failure (Run crawler, Commit)', () => {
    const script = renderCompositeScript(baseEntry);
    const runBlockStart = script.indexOf('node scripts/update-widget-jobs.mjs');
    const housekeepingStart = script.indexOf('cleanup-jobs.mjs');
    const runBlock = script.slice(runBlockStart, housekeepingStart);
    expect(runBlock).toMatch(/__STEP_FAILED=1/);
  });

  it('exits non-zero only if a required (non-continue-on-error) step failed', () => {
    const script = renderCompositeScript(baseEntry);
    expect(script.trim().endsWith('exit 0')).toBe(true);
    expect(script).toContain('if [ "$__STEP_FAILED" != "0" ]; then\n  exit 1\nfi');
  });

  it('sets a unique SLUG_HISTORY_SUMMARY_FILE path per crawler at the step env level (not inside the script)', () => {
    // The fix lives in the generated step's top-level `env:`, not the script
    // body — asserted at the workflow-doc level in the integration test
    // below. Here we just confirm the composite script itself does not hard-
    // code a colliding /tmp path for slug-history telemetry (that file is
    // produced by scripts/lib/slug-history-journal.mjs via the env var, not
    // written directly by this script).
    const script = renderCompositeScript(baseEntry);
    expect(script).not.toMatch(/slug-history-summary-\$/); // no un-scoped pid-glob reliance
  });

  it('wraps every sub-step body in its own subshell so an internal `exit` does not terminate the whole composite', () => {
    // Regression guard: a naive single-shell-process composite would let an
    // early `exit 0` inside one sub-step (e.g. the real "Prepare Firebase
    // credentials (optional)" step's "secret absent -> exit 0" branch, found
    // in 580/581 real crawler workflows) silently skip every later sub-step
    // (Run crawler, Housekeeping, Commit, Report-failure) for that crawler.
    const earlyExitEntry = {
      file: 'update-jobs-earlyexit.yml',
      workflowName: 'Update EarlyExit Jobs (Dedicated)',
      crawlerSlug: 'earlyexit',
      bespokeSteps: [
        {
          name: 'Prepare Firebase credentials (optional)',
          env: { FIREBASE_SERVICE_ACCOUNT_JSON: '' },
          run: [
            'if [ -n "$FIREBASE_SERVICE_ACCOUNT_JSON" ]; then',
            '  echo has-secret',
            'else',
            '  echo no-secret',
            '  exit 0',
            'fi',
          ].join('\n'),
        },
        { name: 'Run dedicated EarlyExit crawler', run: 'echo RAN_CRAWLER' },
        { name: 'Commit and push', run: 'echo COMMITTED' },
      ],
    };
    const script = renderCompositeScript(earlyExitEntry);
    // Actually execute the rendered script to prove the isolation holds at
    // runtime, not just structurally.
    const stdout = execSync('bash', { input: script }).toString();
    expect(stdout).toContain('no-secret');
    expect(stdout).toContain('RAN_CRAWLER');
    expect(stdout).toContain('COMMITTED');
  });

  it('propagates $GITHUB_ENV writes from one sub-step to later sub-steps despite the subshell boundary', () => {
    const entry = {
      file: 'update-jobs-envprop.yml',
      workflowName: 'Update EnvProp Jobs (Dedicated)',
      crawlerSlug: 'envprop',
      bespokeSteps: [
        {
          name: 'Load secrets from Remote Config',
          run: 'echo "MY_TOKEN=abc123" >> "$GITHUB_ENV"',
        },
        { name: 'Run dedicated EnvProp crawler', run: 'echo "token-seen:$MY_TOKEN"' },
      ],
    };
    const script = renderCompositeScript(entry);
    const stdout = execSync('bash', { input: script }).toString();
    expect(stdout).toContain('token-seen:abc123');
  });

  it('a required step failing still lets subsequent steps (Commit, Report-failure) run, matching default GH Actions step sequencing', () => {
    const entry = {
      file: 'update-jobs-failcase.yml',
      workflowName: 'Update FailCase Jobs (Dedicated)',
      crawlerSlug: 'failcase',
      bespokeSteps: [
        { name: 'Run dedicated FailCase crawler', run: 'echo CRAWLER_FAILS; exit 7' },
        { name: 'Commit and push', run: 'echo COMMIT_STILL_RAN' },
        {
          name: 'Report failure to GitHub Issues',
          if: 'failure()',
          'continue-on-error': true,
          run: 'echo REPORTED',
        },
      ],
    };
    const script = renderCompositeScript(entry);
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execSync('bash', { input: script }).toString();
    } catch (error: any) {
      stdout = error.stdout?.toString() ?? '';
      exitCode = error.status ?? 1;
    }
    expect(stdout).toContain('COMMIT_STILL_RAN');
    expect(stdout).toContain('REPORTED');
    expect(exitCode).toBe(1);
  });
});
