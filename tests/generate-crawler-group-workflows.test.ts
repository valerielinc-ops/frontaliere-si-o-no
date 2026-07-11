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
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { packGroups, GROUP_COUNT, OUTLIER_MEDIAN_MULTIPLE, generate, buildCrawlerShellBody } from '../scripts/generate-crawler-group-workflows.mjs';

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

describe('buildCrawlerShellBody — commit/push failure visibility (post-#3701 fix)', () => {
  // Regression guard: a crawler that scrapes successfully but then fails to
  // commit/push (network blip, git-commit-data.sh push-retry exhaustion,
  // prune-abort, etc.) must make the generated background step exit
  // non-zero — that's what fails the job visibly in the Actions UI and
  // satisfies the `if: failure()` guard on the "Report failure to GitHub
  // Issues" step. Pre-fix, the commit step's exit code was captured nowhere
  // (swallowed by a blanket `|| true` on the flock-wrapped commit
  // invocation) and the step's final `exit "$crawler_exit"` only ever
  // reflected the CRAWL step's exit code — so a failed commit silently
  // reported full success.
  //
  // These tests actually EXECUTE the generated shell body with real bash
  // (not just string-match the generator's output), substituting a fake
  // "crawler" command and a fake git-commit-data.sh-shaped command that
  // exits non-zero, to prove the composite step body surfaces the failure
  // end-to-end exactly as GitHub Actions would evaluate it.
  //
  // `flock` (util-linux) is present on the real `ubuntu-latest` runners this
  // generates workflows for, but is not preinstalled on every dev/CI
  // sandbox (e.g. macOS). Since these tests are about exit-code propagation
  // through the composite shell body — not about the locking semantics
  // itself — provide a minimal `flock` shim on PATH that just runs the
  // wrapped command (`flock <lockfile> -c '<cmd>'` -> `bash -c '<cmd>'`),
  // preserving its exit code, so the tests exercise the real generated
  // `flock ... -c '...'` invocation shape on any platform.
  let binDir: string;
  let originalPath: string | undefined;
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-shim-bin-'));
    const flockShim = path.join(binDir, 'flock');
    fs.writeFileSync(
      flockShim,
      ['#!/usr/bin/env bash', '# Minimal flock(1) shim for tests: ignores the lockfile arg, runs the -c command.', 'lockfile="$1"; shift', 'flag="$1"; shift', 'exec bash -c "$1"', ''].join('\n'),
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function crawlerFixture(overrides: Partial<{ runCommand: string; commitCommand: string }> = {}) {
    const runCommand = overrides.runCommand ?? 'true'; // crawl succeeds by default
    const commitCommand = overrides.commitCommand ?? 'true'; // commit succeeds by default
    return {
      slug: 'test-crawler',
      runStep: { env: {}, run: runCommand },
      postSteps: [
        { name: 'Housekeeping', env: {}, run: 'true' },
        {
          name: 'Commit and push',
          id: 'changes',
          env: {},
          // Mirrors the real generated line's shape: a `bash
          // scripts/lib/git-commit-data.sh ...` invocation, detected by
          // buildCrawlerShellBody via the `git-commit-data.sh` substring —
          // substitute a fixture script standing in for the real one so
          // the test never touches the real git working copy, but keep the
          // literal filename so the generator's detection regex matches
          // the real code path (not a simplified stand-in for it).
          run: `bash ${commitCommand}/git-commit-data.sh`,
        },
        {
          name: 'Report failure to GitHub Issues',
          if: 'failure()',
          env: {},
          run: 'echo REPORTED_FAILURE',
        },
      ],
    };
  }

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-shell-body-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Writes a fixture standing in for scripts/lib/git-commit-data.sh, named
  // exactly `git-commit-data.sh` so buildCrawlerShellBody's detection regex
  // (which matches on that literal filename) recognizes it as the commit
  // step, and returns the CONTAINING DIRECTORY (the fixture's `run:` string
  // is `bash <dir>/git-commit-data.sh`, mirroring the real
  // `bash scripts/lib/git-commit-data.sh` shape).
  function writeFixtureCommitScript(exitCode: number): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'lib-'));
    const scriptPath = path.join(dir, 'git-commit-data.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 });
    return dir;
  }

  function runBody(body: string): { exitCode: number; stdout: string } {
    try {
      const stdout = execFileSync('bash', ['-c', body], { encoding: 'utf8' });
      return { exitCode: 0, stdout };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? '' };
    }
  }

  it('crawl succeeds, commit/push fails -> background step exits non-zero and the failure-report step fires', () => {
    const failingCommitDir = writeFixtureCommitScript(1);
    const crawler = crawlerFixture({ commitCommand: failingCommitDir });
    const body = buildCrawlerShellBody(crawler);

    // Sanity: this is the actual code path that used to swallow the
    // failure — assert the generated body really does route the commit
    // command through the flock wrapper (i.e. we're testing the real
    // composite construction, not a simplified stand-in for it).
    expect(body).toMatch(/flock \/tmp\/crawler-group-git\.lock -c/);

    const { exitCode, stdout } = runBody(body);

    expect(exitCode, 'background step must exit non-zero when commit/push fails').not.toBe(0);
    expect(stdout, 'failure-report step must fire when commit/push fails').toContain('REPORTED_FAILURE');
  });

  it('crawl succeeds, commit/push succeeds -> background step exits zero and no failure report fires', () => {
    const okCommitDir = writeFixtureCommitScript(0);
    const crawler = crawlerFixture({ commitCommand: okCommitDir });
    const body = buildCrawlerShellBody(crawler);

    const { exitCode, stdout } = runBody(body);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('REPORTED_FAILURE');
  });

  it('crawl fails -> background step exits non-zero, commit step never runs, failure report fires', () => {
    const crawler = crawlerFixture({ runCommand: 'false' });
    const body = buildCrawlerShellBody(crawler);

    const { exitCode, stdout } = runBody(body);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('REPORTED_FAILURE');
  });

  it('OLD (pre-fix) logic would have swallowed a commit failure — this documents the exact defect the fix closes', () => {
    // This test does not call production code; it pins down, in isolation,
    // why the pre-fix generated body was wrong, so a future refactor can't
    // silently reintroduce the same shape. The old body's tail was
    // equivalent to:
    //   if [ "$crawler_exit" -eq 0 ]; then
    //     flock ... -c '<commit>' || true      # exit code discarded here
    //   fi
    //   if [ "$crawler_exit" -ne 0 ]; then ... fi   # never sees commit failure
    //   exit "$crawler_exit"                         # always 0 if crawl succeeded
    const failingCommitDir = writeFixtureCommitScript(1);
    const oldStyleBody = [
      'set -uo pipefail',
      'true', // crawl
      'crawler_exit=$?',
      'if [ "$crawler_exit" -eq 0 ]; then',
      `  flock /tmp/crawler-group-git.lock -c 'bash ${failingCommitDir}/git-commit-data.sh' || true`,
      'fi',
      'if [ "$crawler_exit" -ne 0 ]; then',
      '  echo REPORTED_FAILURE',
      'fi',
      'exit "$crawler_exit"',
    ].join('\n');

    const { exitCode, stdout } = runBody(oldStyleBody);

    // This is the bug: despite the commit genuinely failing, the old body
    // reports success and never fires the failure report.
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('REPORTED_FAILURE');
  });

  it('handles the real corpus shape where the commit step is named "Commit updated data" (avaloq/livingcircle), not "Commit and push"', () => {
    // Regression guard for a second defect found while fixing the first:
    // detecting the commit step by literal step name alone misses the
    // "Commit updated data" variant used by a couple of real crawlers,
    // silently reintroducing the same swallowed-failure bug for them.
    const failingCommitDir = writeFixtureCommitScript(1);
    const crawler = {
      slug: 'avaloq-like',
      runStep: { env: {}, run: 'true' },
      postSteps: [
        { name: 'Commit updated data', env: {}, run: `bash ${failingCommitDir}/git-commit-data.sh` },
        { name: 'Report failure to GitHub Issues', if: 'failure()', env: {}, run: 'echo REPORTED_FAILURE' },
      ],
    };
    const body = buildCrawlerShellBody(crawler);

    expect(body).toContain('git_commit_exit=$?');

    const { exitCode, stdout } = runBody(body);
    expect(exitCode, 'background step must exit non-zero when the "Commit updated data" step fails').not.toBe(0);
    expect(stdout).toContain('REPORTED_FAILURE');
  });

  // GitHub Actions invokes `run:` steps as `bash -e {0}` (errexit ON) — a
  // real run's log line confirms `shell: /usr/bin/bash -e {0}`. The tests
  // above all use `runBody()`, which shells out via plain `bash -c` (no
  // `-e`) — that never enables errexit, so it could not have caught the
  // actual root cause of zero "Crawler Failure" issues being filed despite
  // ~160 real overnight failures post-#3701. These two tests specifically
  // invoke the body the way GitHub Actions really does (`bash -e <file>`)
  // to prove the `set +e` fix, and to pin down the defect it closes.
  function runBodyStrict(body: string): { exitCode: number; stdout: string } {
    const scriptPath = path.join(tmpDir, 'body.sh');
    fs.writeFileSync(scriptPath, body);
    try {
      const stdout = execFileSync('bash', ['-e', scriptPath], { encoding: 'utf8' });
      return { exitCode: 0, stdout };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? '' };
    }
  }

  it('crawl fails -> under real bash -e invocation (GitHub Actions default), the fix still reaches the failure-report gate', () => {
    const crawler = crawlerFixture({ runCommand: 'false' });
    const body = buildCrawlerShellBody(crawler);

    expect(body).toMatch(/^set -uo pipefail\nset \+e\n/);

    const { exitCode, stdout } = runBodyStrict(body);

    expect(exitCode, 'background step must exit non-zero when the crawl fails').not.toBe(0);
    expect(stdout, 'failure-report step must fire even under real bash -e semantics').toContain('REPORTED_FAILURE');
  });

  it('documents the defect: WITHOUT `set +e`, the same body aborts before crawler_exit is even captured under bash -e — the actual overnight root cause', () => {
    const crawler = crawlerFixture({ runCommand: 'false' });
    const body = buildCrawlerShellBody(crawler);
    // Reconstruct the exact pre-fix shape by stripping the injected `set +e`
    // line from the real generator output, rather than hand-building a
    // parallel body that could drift from what the generator actually emits.
    const oldStyleBody = body.replace(/^set \+e\n/m, '');
    expect(oldStyleBody).not.toContain('set +e');

    const { stdout } = runBodyStrict(oldStyleBody);

    // Under real bash -e, the crawl command's own non-zero exit aborts the
    // script immediately: `crawler_exit=$?` is never reached, so the
    // failure-report gate never fires. This is the mechanism that silenced
    // ~160 "Crawler Failure" issues overnight post-#3701.
    expect(stdout).not.toContain('REPORTED_FAILURE');
  });
});

describe('push-contention class (exit 42) in generated steps', () => {
  it('skips the per-crawler issue and keeps the step green for contention losses, everything else unchanged', () => {
    const WORKFLOWS_DIR = path.resolve(import.meta.dirname, '../.github/workflows');
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /^crawler-group-\d+\.yml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const y = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
      // the failure-report gate must exclude 42...
      expect(y).toContain('[ "$git_commit_exit" -ne 0 ] && [ "$git_commit_exit" -ne 42 ]');
      // ...and the contention branch must log loudly instead of filing an issue
      expect(y).toContain('push contention loss (exit 42)');
      // real failures still fail the step (the plain exit 1 path survives)
      expect(y).toContain('exit 1');
    }
  });
});

