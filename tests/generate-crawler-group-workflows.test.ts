/**
 * Guards scripts/generate-crawler-group-workflows.mjs's `packGroups`
 * bin-packing logic — the algorithm that decides which of the 581 crawler
 * scripts get bundled into which of the 23 grouped GitHub Actions workflows
 * (each group is one job holding multiple `background: true` steps, so the
 * job's wall-clock is bounded by its SLOWEST member, not the sum of all
 * members).
 *
 * An earlier iteration of this function had a real bug caught during
 * development: naive "always add to the currently lowest-wallClockMs group"
 * greedy degenerates once every group already has one member, because
 * adding a smaller item never raises a group's `wallClockMs` past its
 * existing max — so the greedy kept dumping the entire remaining corpus into
 * whichever anchor happened to be smallest, producing 22 near-empty groups
 * and 1 giant group of 559. These tests guard against that regression by
 * asserting group SIZE balance, not just wall-clock balance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { packGroups, GROUP_COUNT, OUTLIER_MEDIAN_MULTIPLE, generate } from '../scripts/generate-crawler-group-workflows.mjs';

interface Crawler {
  slug: string;
  durationMs: number;
}

function makeCrawlers(n: number, durationFn: (i: number) => number): Crawler[] {
  return Array.from({ length: n }, (_, i) => ({ slug: `crawler-${i}`, durationMs: durationFn(i) }));
}

describe('packGroups', () => {
  it('produces exactly GROUP_COUNT groups', () => {
    const crawlers = makeCrawlers(581, (i) => 60_000 + (i % 50) * 60_000);
    const median = 1_500_000;
    const groups = packGroups(crawlers, GROUP_COUNT, median);
    expect(groups).toHaveLength(GROUP_COUNT);
  });

  it('every input crawler appears in exactly one group — no missing, no duplicated', () => {
    const crawlers = makeCrawlers(581, (i) => 60_000 + (i % 97) * 90_000);
    const median = 1_500_000;
    const groups = packGroups(crawlers, GROUP_COUNT, median);

    const seen = new Map<string, number>();
    for (const g of groups) {
      for (const m of g.members) {
        seen.set(m.slug, (seen.get(m.slug) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(crawlers.length);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  it('reproduces the real-corpus regression scenario: no group balloons to near-total membership', () => {
    // Mirrors the actual duration distribution shape: one extreme outlier
    // (~6.5x median, like Coop), then a long, gently-declining tail of
    // similarly-sized crawlers (like the real corpus top-40), then a bulk of
    // small/medium crawlers.
    const median = 1_466_500; // ~24.4min, the real corpus median
    const crawlers: Crawler[] = [
      { slug: 'coop', durationMs: 9_597_000 }, // ~160min, real outlier
      ...Array.from({ length: 40 }, (_, i) => ({
        slug: `big-${i}`,
        durationMs: 5_167_500 - i * 40_000, // gently declining from ~86min
      })),
      ...Array.from({ length: 540 }, (_, i) => ({
        slug: `small-${i}`,
        durationMs: 60_000 + (i % 30) * 30_000, // 1-16min range
      })),
    ];
    const groups = packGroups(crawlers, GROUP_COUNT, median);

    expect(groups).toHaveLength(GROUP_COUNT);
    const sizes = groups.map((g) => g.members.length);
    const total = crawlers.length;

    // No single group should hold more than a small fraction of the corpus.
    // A regression of the old bug produced one group with 559/581 (~96%).
    const maxShare = Math.max(...sizes) / total;
    expect(maxShare).toBeLessThan(0.15);

    // Every non-outlier group should have a reasonably comparable member
    // count (the tail should spread ~evenly across regular groups).
    const nonOutlierSizes = groups.filter((g) => g.members.length > 0 && g.wallClockMs < median * OUTLIER_MEDIAN_MULTIPLE).map((g) => g.members.length);
    if (nonOutlierSizes.length > 1) {
      const spread = Math.max(...nonOutlierSizes) - Math.min(...nonOutlierSizes);
      expect(spread).toBeLessThanOrEqual(3);
    }
  });

  it('isolates genuine duration outliers (> OUTLIER_MEDIAN_MULTIPLE * median) into their own group', () => {
    const median = 1_000_000;
    const crawlers: Crawler[] = [
      { slug: 'huge-outlier', durationMs: median * (OUTLIER_MEDIAN_MULTIPLE + 2) },
      ...makeCrawlers(100, (i) => 200_000 + (i % 20) * 50_000),
    ];
    const groups = packGroups(crawlers, GROUP_COUNT, median);
    const outlierGroup = groups.find((g) => g.members.some((m) => m.slug === 'huge-outlier'));
    expect(outlierGroup).toBeDefined();
    expect(outlierGroup!.members).toHaveLength(1);
  });

  it('no group wall-clock exceeds the max single-member duration in that group (max, not sum)', () => {
    const crawlers = makeCrawlers(200, (i) => 100_000 + (i % 40) * 200_000);
    const median = 1_000_000;
    const groups = packGroups(crawlers, GROUP_COUNT, median);
    for (const g of groups) {
      if (g.members.length === 0) continue;
      const trueMax = Math.max(...g.members.map((m) => m.durationMs));
      expect(g.wallClockMs).toBe(trueMax);
    }
  });

  it('no group exceeds a sane wall-clock ceiling (safety margin under the 6h GH Actions job limit)', () => {
    const crawlers = makeCrawlers(581, (i) => 60_000 + (i % 160) * 60_000);
    const median = 1_500_000;
    const groups = packGroups(crawlers, GROUP_COUNT, median);
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    for (const g of groups) {
      expect(g.wallClockMs).toBeLessThan(SIX_HOURS_MS);
    }
  });

  it('handles fewer crawlers than groups without crashing or creating empty-group errors', () => {
    const crawlers = makeCrawlers(5, (i) => 100_000 * (i + 1));
    const median = 200_000;
    const groups = packGroups(crawlers, GROUP_COUNT, median);
    const total = groups.reduce((sum, g) => sum + g.members.length, 0);
    expect(total).toBe(5);
    expect(groups).toHaveLength(GROUP_COUNT);
  });

  it('is deterministic given the same inputs', () => {
    const crawlers = makeCrawlers(581, (i) => 60_000 + (i % 71) * 45_000);
    const median = 1_400_000;
    const a = packGroups(crawlers, GROUP_COUNT, median);
    const b = packGroups(crawlers, GROUP_COUNT, median);
    expect(a.map((g) => g.members.map((m) => m.slug))).toEqual(b.map((g) => g.members.map((m) => m.slug)));
  });
});

describe('generate() — shared install step reflects per-crawler prep requirements', () => {
  // Regression guard (PR #3701 review finding): the shared "Install
  // dependencies" step is sequential and shared by an ENTIRE group. If any
  // member's original workflow required `npm ci --ignore-scripts` and the
  // generator silently drops that flag, two things go wrong: (1) that
  // crawler's install semantics silently change, and (2) since the step has
  // no `continue-on-error`, a flaky dependency postinstall script failing
  // there blocks the group's shared install step outright — which blocks
  // EVERY background crawler step in that group from ever starting, not
  // just the one crawler that needed the flag. The fix: if ANY member
  // requires `--ignore-scripts`, the whole group's shared install step must
  // use it (safe superset — harmless for members that didn't strictly
  // require it).
  let tmpDir: string;
  let manifestPath: string;
  let baselinePath: string;
  let outDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-group-gen-test-'));
    manifestPath = path.join(tmpDir, 'manifest.json');
    baselinePath = path.join(tmpDir, 'baseline.json');
    outDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function baseCrawler(slug, installRun = 'npm ci') {
    return {
      slug,
      file: `update-jobs-${slug}.yml`,
      jobKey: `update-${slug}-jobs`,
      timeoutMinutes: 360,
      prepSteps: [{ name: 'Install dependencies', run: installRun }],
      runStep: { name: `Run ${slug}`, env: {}, run: `node scripts/update-${slug}-jobs.mjs` },
      postSteps: [
        { name: 'Commit and push', id: 'changes', env: {}, run: `bash scripts/lib/git-commit-data.sh --slice-only "Auto-update ${slug} jobs"` },
        { name: 'Report failure to GitHub Issues', if: 'failure()', 'continue-on-error': true, env: {}, run: 'node scripts/lib/github-issue-creator.mjs --title "x"' },
      ],
    };
  }

  // GROUP_COUNT (23) crawlers of similar duration each become their own
  // group "anchor" in packGroups' first phase — to reliably land MULTIPLE
  // synthetic crawlers in the SAME group (reproducing the real corpus
  // scenario where a group has ~25 members), use more crawlers than
  // GROUP_COUNT so the "spread the tail by member count" phase kicks in.
  const CRAWLER_COUNT = GROUP_COUNT * 3;

  function writeManifestAndBaseline(crawlers) {
    fs.writeFileSync(manifestPath, JSON.stringify({ manifest: crawlers, anomalies: [] }));
    const crawlerBaseline = Object.fromEntries(
      crawlers.map((c) => [
        c.file.replace(/^update-jobs-/, 'update-jobs-').replace(/\.yml$/, ''),
        { avgDurationMs: 500_000, sampleCount: 1 },
      ]),
    );
    fs.writeFileSync(baselinePath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      medianDurationMs: 500_000,
      crawlers: crawlerBaseline,
    }));
  }

  it('applies --ignore-scripts to the shared install step when any group member requires it', () => {
    // One crawler whose ORIGINAL workflow used `npm ci --ignore-scripts` as
    // its own "Install dependencies" prep step (mirrors the real afry/
    // agroscope/pwc/etc. shape found in the actual 581-crawler corpus),
    // plus enough same-duration crawlers that several of them are forced
    // into the SAME group as it (reproducing the real "~25 members share
    // one job" scenario, not an isolated singleton group).
    const crawlers = [
      baseCrawler('lean-crawler', 'npm ci --ignore-scripts'),
      ...Array.from({ length: CRAWLER_COUNT - 1 }, (_, i) => baseCrawler(`normal-${i}`)),
    ];
    writeManifestAndBaseline(crawlers);

    const results = generate({ manifestPath, baselinePath, outDir, write: true });
    const groupWithLean = results.find((r) => r.members.includes('lean-crawler'));
    expect(groupWithLean, 'expected lean-crawler to be placed in some group').toBeDefined();
    expect(groupWithLean!.members.length, 'expected lean-crawler to share a group with other crawlers, not be isolated').toBeGreaterThan(1);

    const doc = YAML.parse(groupWithLean!.content);
    const jobKey = Object.keys(doc.jobs)[0];
    const installStep = doc.jobs[jobKey].steps.find((s) => s.name === 'Install dependencies');
    expect(installStep.run).toBe('npm ci --ignore-scripts');

    // Every OTHER group (none of whose members required the flag) must keep
    // plain `npm ci` — the fix should not force `--ignore-scripts`
    // repo-wide, only for groups that actually contain a member needing it.
    const otherGroups = results.filter((r) => !r.members.includes('lean-crawler'));
    for (const g of otherGroups) {
      const gDoc = YAML.parse(g.content);
      const gJobKey = Object.keys(gDoc.jobs)[0];
      const gInstall = gDoc.jobs[gJobKey].steps.find((s) => s.name === 'Install dependencies');
      expect(gInstall.run, `group ${g.fileName} should not have --ignore-scripts`).toBe('npm ci');
    }
  });

  it('keeps plain `npm ci` when no group member requires --ignore-scripts', () => {
    const crawlers = Array.from({ length: CRAWLER_COUNT }, (_, i) => baseCrawler(`normal-${i}`));
    writeManifestAndBaseline(crawlers);

    const results = generate({ manifestPath, baselinePath, outDir, write: true });
    for (const g of results) {
      const doc = YAML.parse(g.content);
      const jobKey = Object.keys(doc.jobs)[0];
      const installStep = doc.jobs[jobKey].steps.find((s) => s.name === 'Install dependencies');
      expect(installStep.run).toBe('npm ci');
    }
  });
});
