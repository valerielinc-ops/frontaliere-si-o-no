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
import { packGroups, GROUP_COUNT, OUTLIER_MEDIAN_MULTIPLE, generate, buildCrawlerShellBody, assignGroupsStable, extractAssignmentsFromWorkflows, extractManualPreamble, generateCrossRepoExecutionArtifacts, assertCrawlerLogicParity, crossRepoCrawlerSparsePatterns, generateCrawlerLogicArtifacts, collectSiteRuntimePaths } from '../scripts/generate-crawler-group-workflows.mjs';
import { assertCrawlerManifestDelta, CORPUS_OBSERVER_FILES, CRAWLER_WORKFLOW_FILES, prepareCrawlerWorkflowCorpusSync } from '../scripts/ci/prepare-crawler-workflow-corpus-sync.mjs';

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
      runStep: {
        name: `Run ${slug}`,
        env: {
          JOBS_HOUSEKEEPING_SCOPE: slug,
          JOBS_SLICE_FILE: `data/jobs/by-crawler/${slug}.json`,
        },
        run: `node scripts/update-${slug}-jobs.mjs`,
      },
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
    const timeoutShim = path.join(binDir, 'timeout');
    fs.writeFileSync(
      timeoutShim,
      [
        '#!/usr/bin/env bash',
        '# Portable timeout(1) shim: tests can force expiry without sleeping.',
        'while [[ "$1" == --* ]]; do shift; done',
        'duration="$1"; shift',
        'if [ "${TEST_FORCE_TARGET_TIMEOUT:-0}" = "1" ]; then exit 124; fi',
        'exec "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
  });
  afterEach(() => {
    delete process.env.TEST_FORCE_TARGET_TIMEOUT;
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

  it('bounds the complete target work phase and keeps the failure reporter outside the timeout', () => {
    const okCommitDir = writeFixtureCommitScript(0);
    const crawler = {
      ...crawlerFixture({ commitCommand: okCommitDir }),
      targetTimeoutMinutes: 30,
    };
    const body = buildCrawlerShellBody(crawler);

    expect(body).toContain('timeout --signal=TERM --kill-after=30s 30m bash -c');
    expect(body.indexOf('timeout --signal=TERM')).toBeLessThan(body.indexOf('REPORTED_FAILURE'));
    expect(body.indexOf('flock /tmp/crawler-group-git.lock')).toBeLessThan(body.indexOf('REPORTED_FAILURE'));
    expect(body).toContain('outside timeout, only on target failure');

    const { exitCode, stdout } = runBody(body);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('REPORTED_FAILURE');
  });

  it('fails closed on target timeout, reports it, and never reaches commit', () => {
    const commitMarker = path.join(tmpDir, 'commit-ran');
    const commitDir = fs.mkdtempSync(path.join(tmpDir, 'lib-timeout-'));
    fs.writeFileSync(
      path.join(commitDir, 'git-commit-data.sh'),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(commitMarker)}\n`,
      { mode: 0o755 },
    );
    const crawler = {
      ...crawlerFixture({ commitCommand: commitDir }),
      targetTimeoutMinutes: 30,
    };
    process.env.TEST_FORCE_TARGET_TIMEOUT = '1';

    const { exitCode, stdout } = runBody(buildCrawlerShellBody(crawler));

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('target exceeded 30 minute wall timeout');
    expect(stdout).toContain('REPORTED_FAILURE');
    expect(fs.existsSync(commitMarker)).toBe(false);
  });

  it('rejects an invalid target timeout instead of silently falling back to the group limit', () => {
    const crawler = {
      ...crawlerFixture(),
      targetTimeoutMinutes: 340,
    };
    expect(() => buildCrawlerShellBody(crawler)).toThrow(/positive integer below the 340 minute group timeout/);
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

describe('#6882 — Apleona has one explicit full-target wall timeout', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');

  it('keeps the budget in the manifest and renders it in all three owned group-18 artifacts only', () => {
    const { manifest } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/crawler-manifest.json'), 'utf8'));
    const bounded = manifest.filter((crawler: any) => crawler.targetTimeoutMinutes != null);
    expect(bounded.map((crawler: any) => ({ slug: crawler.slug, minutes: crawler.targetTimeoutMinutes }))).toEqual([
      { slug: 'apleona-schweiz-ag', minutes: 60 },
    ]);

    const artifacts = [
      '.github/workflows/crawler-group-18.yml',
      '.github/workflows/crawler-group-18-logic.yml',
      '.github/corpus-workflows/crawler-group-18.yml',
    ];
    for (const relativePath of artifacts) {
      const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      expect(text.match(/timeout --signal=TERM --kill-after=30s 60m bash -c/g)).toHaveLength(1);
      expect(text).toContain('Run apleona-schweiz-ag');
      expect(text).toContain('outside timeout, only on target failure');
    }

    const otherGroups = fs.readdirSync(path.join(ROOT, '.github/workflows'))
      .filter((file) => /^crawler-group-(?!18(?:-logic)?\.yml$)\d+(?:-logic)?\.yml$/.test(file));
    for (const file of otherGroups) {
      expect(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')).not.toContain('target wall timeout');
    }
  });
});

describe('real-corpus invariant: every manifest crawler in exactly one committed crawler-group-*.yml', () => {
  // Guards the COMMITTED OUTPUT, not just packGroups() in isolation (which
  // the tests above already cover with synthetic data). generate() throws if
  // its own in-memory packGroups() result mismatches its input crawlers, but
  // that check never runs against what actually landed on disk — a
  // regeneration that silently skipped a file write, a stale file left over
  // from a previous manifest, or a manual edit to a crawler-group-*.yml would
  // all pass that in-memory check while still breaking the real invariant
  // (follow-up of #6320: a 22-file rebalance was verified only 5/5 on the new
  // entries, not against the full committed corpus). Extracts each group's
  // background-step crawler slugs the same way the generator names them
  // (`id: crawler-<slug>`) and diffs the union against
  // data/crawler-manifest.json's slugs.
  it('data/crawler-manifest.json slugs == union of all crawler-group-*.yml background steps, each exactly once', () => {
    const REPO_ROOT = path.resolve(import.meta.dirname, '..');
    const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');
    const { manifest } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/crawler-manifest.json'), 'utf8'));
    const manifestSlugs = manifest.map((c) => c.slug);

    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /^crawler-group-\d+\.yml$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const occurrences = new Map<string, string[]>(); // slug -> file names it was found in
    for (const f of files) {
      const doc = YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'));
      const jobKey = Object.keys(doc.jobs)[0];
      const steps = doc.jobs[jobKey].steps;
      for (const step of steps) {
        if (!step.background) continue;
        const match = /^crawler-(.+)$/.exec(step.id ?? '');
        expect(match, `background step in ${f} has no 'crawler-<slug>' id: ${JSON.stringify(step.id)}`).not.toBeNull();
        const slug = match[1];
        const list = occurrences.get(slug) ?? [];
        list.push(f);
        occurrences.set(slug, list);
      }
    }

    const missing = manifestSlugs.filter((slug) => !occurrences.has(slug));
    expect(missing, `crawlers in manifest but absent from every crawler-group-*.yml: ${missing.join(', ')}`).toEqual([]);

    const duplicated = [...occurrences.entries()].filter(([, files]) => files.length > 1);
    expect(duplicated, `crawlers present in more than one group: ${duplicated.map(([slug, files]) => `${slug} in [${files.join(', ')}]`).join('; ')}`).toEqual([]);

    const manifestSlugSet = new Set(manifestSlugs);
    const extraneous = [...occurrences.keys()].filter((slug) => !manifestSlugSet.has(slug));
    expect(extraneous, `crawlers in group workflows but absent from data/crawler-manifest.json: ${extraneous.join(', ')}`).toEqual([]);
  });
});

/**
 * ---------------------------------------------------------------------------
 * #6482 — the committed .yml ARE the generator's output, and a one-crawler
 * change costs one file.
 * ---------------------------------------------------------------------------
 *
 * The describe above proves the MEMBERSHIP SET matches the manifest. That is
 * strictly weaker than "the committed files are what the generator produces":
 * every hand-edit that keeps the slug list intact — a tweaked step body, a
 * stale install flag, a dropped env var, a `name:` that no longer matches the
 * member count — passes it. Worked example, live:
 *
 *   - PR #6484 removed a crawler from the manifest and hand-edited
 *     crawler-group-10.yml to match, precisely BECAUSE re-running the
 *     generator rewrote all 23 files.
 *
 * That was not detectable by the suite afterwards. These tests close the gap
 * from both ends: the output must be reproducible byte-for-byte, and
 * reproducing it after a single manifest edit must stay proportional to the
 * edit — otherwise the next person hand-edits again and the drift is back.
 */
describe('#6482 — committed crawler-group-*.yml are byte-identical to the generator output', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '..');
  const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');
  const MANIFEST_PATH = path.join(REPO_ROOT, 'data/crawler-manifest.json');
  const BASELINE_PATH = path.join(REPO_ROOT, 'data/crawler-workflow-duration-baseline.json');
  const ASSIGNMENTS_PATH = path.join(REPO_ROOT, 'data/crawler-group-assignments.json');

  const groupFiles = () =>
    fs.readdirSync(WORKFLOWS_DIR).filter((f) => /^crawler-group-\d+\.yml$/.test(f)).sort();

  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-groups-sync-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Regenerate into a scratch dir, never touching the repo's own
   * .github/workflows or pin file.
   *
   * The scratch dir is SEEDED with the committed files first, because that is
   * what a real run overwrites — and the generator carries each file's manual
   * preamble across the overwrite. Generating into an empty dir would compare
   * a first-ever generation against an incrementally-maintained tree.
   *
   * `write: true` matters too: the checkout-profile pass (applyProfilesToFile)
   * reads the file back off disk, so a dry run does not produce the bytes that
   * actually get committed.
   */
  function regenerate(manifestOverride?: (doc: any) => void) {
    const outDir = path.join(tmp, 'workflows');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of groupFiles()) fs.copyFileSync(path.join(WORKFLOWS_DIR, f), path.join(outDir, f));

    const manifestPath = path.join(tmp, 'manifest.json');
    const assignmentsPath = path.join(tmp, 'assignments.json');
    const doc = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    manifestOverride?.(doc);
    fs.writeFileSync(manifestPath, JSON.stringify(doc));
    fs.copyFileSync(ASSIGNMENTS_PATH, assignmentsPath);

    generate({ manifestPath, baselinePath: BASELINE_PATH, assignmentsPath, outDir, write: true });
    return { outDir, assignmentsPath };
  }

  function changedFiles(outDir: string): string[] {
    const committed = groupFiles();
    const produced = fs.readdirSync(outDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f)).sort();
    const changed: string[] = [];
    for (const f of new Set([...committed, ...produced])) {
      const a = committed.includes(f) ? fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8') : null;
      const b = produced.includes(f) ? fs.readFileSync(path.join(outDir, f), 'utf8') : null;
      if (a !== b) changed.push(f);
    }
    return changed.sort();
  }

  function crawlerCloneWithIdentity(proto: any, slug: string) {
    const crawler = JSON.parse(JSON.stringify(proto));
    crawler.slug = slug;
    crawler.file = `update-jobs-${slug}.yml`;
    for (const step of [crawler.runStep, ...crawler.postSteps]) {
      if (!step.env) continue;
      if (Object.prototype.hasOwnProperty.call(step.env, 'JOBS_HOUSEKEEPING_SCOPE')) {
        step.env.JOBS_HOUSEKEEPING_SCOPE = slug;
      }
      if (Object.prototype.hasOwnProperty.call(step.env, 'JOBS_SLICE_FILE')) {
        step.env.JOBS_SLICE_FILE = `data/jobs/by-crawler/${slug}.json`;
      }
    }
    return crawler;
  }

  it('re-running the generator on the committed manifest+baseline+pins is a no-op', () => {
    const { outDir } = regenerate();

    const produced = fs.readdirSync(outDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f)).sort();
    expect(produced, 'the generator no longer emits the same set of group files that is committed').toEqual(groupFiles());

    for (const f of produced) {
      const committedText = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
      const producedText = fs.readFileSync(path.join(outDir, f), 'utf8');
      expect(
        producedText === committedText,
        `${f} differs from what scripts/generate-crawler-group-workflows.mjs produces.\n` +
          `Either it was hand-edited, or the manifest/pins changed and nobody regenerated.\n` +
          `Fix: node scripts/generate-crawler-group-workflows.mjs (then commit BOTH the .yml and data/crawler-group-assignments.json).\n` +
          `If the .yml is the correct state and the pins are the stale side: node scripts/generate-crawler-group-workflows.mjs --bootstrap-from-workflows`,
      ).toBe(true);
    }
  });

  it('every manifest crawler is pinned, exactly once', () => {
    // NOT asserted: "no stale pin". A pin whose crawler left the manifest is
    // inert — assignGroupsStable drops it, and the next generator run prunes it
    // from the file. Requiring its absence would make this test red on main
    // purely as a function of MERGE ORDER: a concurrent PR that removes a
    // crawler (#6484 is exactly that) does not know this pin file exists.
    // What must hold is the other direction, which is not self-healing: an
    // unpinned crawler would get assigned to an arbitrary group on the next
    // run, and a doubly-pinned one would run twice in one job.
    const pins = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
    const { manifest } = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const pinned = pins.groups.flat();

    expect(pins.groupCount).toBe(pins.groups.length);
    const dupes = pinned.filter((s: string, i: number) => pinned.indexOf(s) !== i);
    expect(dupes, `pinned to more than one group: ${dupes.join(', ')}`).toEqual([]);

    const pinnedSet = new Set(pinned);
    const unpinned = manifest.map((c: any) => c.slug).filter((s: string) => !pinnedSet.has(s));
    expect(
      unpinned,
      `in data/crawler-manifest.json but not pinned in data/crawler-group-assignments.json: ${unpinned.join(', ')}. ` +
        'Fix: node scripts/generate-crawler-group-workflows.mjs',
    ).toEqual([]);
  });

  it('the pins and the committed .yml describe the same assignment, in the same order', () => {
    // The pins and the .yml are two renderings of one decision; comparing them
    // directly is what makes a hand-edit to a .yml legible as such. Restricted
    // to crawlers still in the manifest, for the stale-pin reason above.
    const pins = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
    const { manifest } = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const live = new Set(manifest.map((c: any) => c.slug));
    const expected = pins.groups.map((g: string[]) => g.filter((s) => live.has(s)));
    expect(extractAssignmentsFromWorkflows(WORKFLOWS_DIR)).toEqual(expected);
  });

  it('removing ONE crawler from the manifest rewrites ONE group file, not all 23', () => {
    // The exact regression: on the global bin-pack, dropping
    // `eoc-candidati-posizioni` moved 14 crawlers out of crawler-group-02 and
    // 14 different ones in, and rewrote all 23 files (~5000 lines) — i.e. it
    // silently changed which crawler runs in which window in production.
    const { manifest } = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const victim = manifest[Math.floor(manifest.length / 2)].slug;

    const { outDir } = regenerate((doc) => {
      doc.manifest = doc.manifest.filter((c: any) => c.slug !== victim);
    });

    const changed = changedFiles(outDir);
    expect(
      changed.length,
      `removing '${victim}' rewrote ${changed.length} files (${changed.join(', ')}); ` +
        'the assignment is being re-derived globally again instead of read from the pins',
    ).toBe(1);
  });

  it('adding ONE crawler to the manifest rewrites ONE group file, not all 23', () => {
    const { outDir } = regenerate((doc) => {
      doc.manifest.push(crawlerCloneWithIdentity(doc.manifest[0], 'zz-sync-test-crawler'));
      doc.manifest.sort((a: any, b: any) => a.slug.localeCompare(b.slug));
    });

    const changed = changedFiles(outDir);
    expect(
      changed.length,
      `adding one crawler rewrote ${changed.length} files (${changed.join(', ')})`,
    ).toBe(1);
  });

  it('two crawlers added in either order land on the same assignment', () => {
    // Order-independence is what makes the pin file mergeable: two agents
    // promoting one crawler each must not produce two different corpora.
    const add = (doc: any, slugs: string[]) => {
      for (const slug of slugs) doc.manifest.push(crawlerCloneWithIdentity(doc.manifest[0], slug));
    };
    const a = regenerate((doc) => add(doc, ['zz-alpha-crawler', 'zz-beta-crawler']));
    const b = regenerate((doc) => add(doc, ['zz-beta-crawler', 'zz-alpha-crawler']));
    expect(JSON.parse(fs.readFileSync(a.assignmentsPath, 'utf8')).groups).toEqual(
      JSON.parse(fs.readFileSync(b.assignmentsPath, 'utf8')).groups,
    );
  });

});

describe('#6482 — extractManualPreamble', () => {
  const MARKER = '# AUTO-GENERATED by scripts/generate-crawler-group-workflows.mjs — DO NOT EDIT BY HAND.\n';

  it('carries over a leading comment block', () => {
    expect(extractManualPreamble(`# note\n# more\n#\n${MARKER}name: x\n`)).toBe('# note\n# more\n#\n');
  });

  it('returns nothing when the file already starts at the marker', () => {
    expect(extractManualPreamble(`${MARKER}name: x\n`)).toBe('');
  });

  it('refuses to carry over anything that is not purely comments — a body edit is not a preamble', () => {
    expect(extractManualPreamble(`name: sneaky\n${MARKER}name: x\n`)).toBe('');
  });

  it('returns nothing for a file with no marker at all', () => {
    expect(extractManualPreamble('# just a comment\nname: x\n')).toBe('');
  });
});

describe('#6482 — assignGroupsStable', () => {
  const median = 1_000_000;
  const crawler = (slug: string, durationMs = median) => ({ slug, durationMs });

  it('keeps a pinned crawler in its group AND at its position', () => {
    const crawlers = [crawler('a'), crawler('b'), crawler('c')];
    const { groups } = assignGroupsStable(crawlers, [['c', 'a'], ['b']], median);
    expect(groups.map((g) => g.members.map((m) => m.slug))).toEqual([['c', 'a'], ['b']]);
  });

  it('drops a pin whose crawler left the manifest, without touching the other group', () => {
    const crawlers = [crawler('a'), crawler('b')];
    const { groups, removed } = assignGroupsStable(crawlers, [['a', 'gone'], ['b']], median);
    expect(groups.map((g) => g.members.map((m) => m.slug))).toEqual([['a'], ['b']]);
    expect(removed).toEqual(['gone']);
  });

  it('appends an unpinned crawler to the group with the fewest members', () => {
    const crawlers = [crawler('a'), crawler('b'), crawler('c'), crawler('new')];
    const { groups, added } = assignGroupsStable(crawlers, [['a', 'b'], ['c']], median);
    expect(added).toEqual(['new']);
    expect(groups.map((g) => g.members.map((m) => m.slug))).toEqual([['a', 'b'], ['c', 'new']]);
  });

  it('never grows a group reserved for a single duration outlier', () => {
    // crawler-group-01 exists to hold Coop alone: everything bundled with it
    // would pay its ~160min wall-clock for nothing.
    const crawlers = [crawler('coop', median * 8), crawler('a'), crawler('new')];
    const { groups } = assignGroupsStable(crawlers, [['coop'], ['a']], median);
    expect(groups[0].members.map((m) => m.slug)).toEqual(['coop']);
    expect(groups[1].members.map((m) => m.slug)).toEqual(['a', 'new']);
  });

  it('keeps a slug pinned twice only once — a duplicate would race two commits on one file', () => {
    const crawlers = [crawler('a'), crawler('b')];
    const { groups } = assignGroupsStable(crawlers, [['a', 'b'], ['a']], median);
    expect(groups.map((g) => g.members.map((m) => m.slug))).toEqual([['a', 'b'], []]);
  });
});

describe('cross-repo crawler execution artifacts', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const workflowsDir = path.join(repoRoot, '.github/workflows');
  const assignmentsPath = path.join(repoRoot, 'data/crawler-group-assignments.json');
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-cross-repo-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function generateArtifacts() {
    const groupResults = generate({
      outDir: workflowsDir,
      assignmentsPath,
      write: false,
    });
    const outDir = path.join(tmp, 'workflows');
    const contractPath = path.join(tmp, 'crawler-cross-repo-contract.json');
    const result = generateCrossRepoExecutionArtifacts({
      groupResults,
      outDir,
      contractPath,
    });
    return { ...result, outDir, contractPath };
  }

  function collectRelativeImportClosure(entrypoint: string) {
    const pending = [entrypoint];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const runtimePath = pending.pop()!;
      if (visited.has(runtimePath)) continue;
      visited.add(runtimePath);
      const source = fs.readFileSync(path.join(repoRoot, runtimePath), 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)\s+(?:(?:\{[\s\S]*?\}|[^'"\n]+)\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
        const importedPath = path.posix.normalize(path.posix.join(path.posix.dirname(runtimePath), match[1]));
        pending.push(importedPath);
      }
    }
    return [...visited].sort();
  }

  it('lega i 23 job completi *-logic.yml alla stessa sorgente del generatore', () => {
    const { contract } = generateArtifacts();
    const groups = contract.artifacts.filter((artifact: any) => /^crawler-group-/.test(artifact.file));
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/crawler-manifest.json'), 'utf8'));
    const currentCrawlerCount = manifest.manifest.length;

    expect(groups).toHaveLength(GROUP_COUNT);
    expect(contract.crawlerCount).toBe(currentCrawlerCount);
    expect(groups.flatMap((artifact: any) => artifact.members)).toHaveLength(currentCrawlerCount);
    expect(new Set(groups.flatMap((artifact: any) => artifact.members)).size).toBe(currentCrawlerCount);
  });

  it('pubblica soltanto runtime path del sito esistenti e fallisce su un typo citato', () => {
    const { contract, outDir } = generateArtifacts();
    const contents = [
      ...contract.artifacts.map((artifact: any) =>
        fs.readFileSync(path.join(outDir, artifact.file), 'utf8')),
      ...contract.observers
        .filter((observer: any) => /\.ya?ml$/.test(observer.source))
        .map((observer: any) => fs.readFileSync(path.join(outDir, observer.source), 'utf8')),
    ];
    const citedRuntimePaths = [...new Set(contents.flatMap((content: string) =>
      [...content.matchAll(/\b(?:scripts\/[A-Za-z0-9._/-]+\.(?:cjs|js|json|jsonc|mjs|sh|ts|yaml|yml)|functions\/src\/githubApiHeaders\.js)\b/g)]
        .map((match) => match[0]),
    ))].filter((runtimePath) => !CORPUS_OBSERVER_FILES.some(
      ({ target }) => target === runtimePath,
    )).sort();
    expect(contract.siteRuntimePaths).toEqual(collectSiteRuntimePaths(contents));
    expect(contract.siteRuntimePaths).toEqual(citedRuntimePaths);
    expect(contract.siteRuntimePaths.length).toBeGreaterThan(0);
    expect(contract.siteRuntimePaths).toContain('functions/src/githubApiHeaders.js');
    expect(() => collectSiteRuntimePaths([
      ...contents,
      'run: node scripts/typo-nonexistent.mjs\n',
    ])).toThrow(/missing site runtime path.*scripts\/typo-nonexistent\.mjs/);
  });

  it('hash-binda la closure import reale del finalizer in ogni artifact di gruppo', () => {
    const { contract, outDir } = generateArtifacts();
    const expectedClosure = collectRelativeImportClosure('scripts/crawler-group-generation-finalizer.mjs');
    expect(expectedClosure).not.toContain('scripts/ci/crawler-generation-roster.json');

    for (const artifact of contract.artifacts.filter((entry: any) => /^crawler-group-/.test(entry.file))) {
      const content = fs.readFileSync(path.join(outDir, artifact.file), 'utf8');
      const declaredClosure = [...content.matchAll(/^# - ((?:scripts\/[A-Za-z0-9._/-]+|functions\/src\/githubApiHeaders\.js))$/gm)]
        .map((match) => match[1]);
      expect(declaredClosure, artifact.file).toEqual(expectedClosure);
    }
  });

  it('rifiuta drift nel setup non-background, non soltanto nel roster', () => {
    const [generated] = generate({ outDir: workflowsDir, assignmentsPath, write: false });
    const logicPath = path.join(workflowsDir, 'crawler-group-01-logic.yml');
    const logic = fs.readFileSync(logicPath, 'utf8').replace('node-version: "22"', 'node-version: "20"');
    expect(() => assertCrawlerLogicParity(generated.content, logic, path.basename(logicPath)))
      .toThrow(/full job mismatch/);

    const checkoutDoc = YAML.parse(fs.readFileSync(logicPath, 'utf8'));
    const checkoutJob: any = Object.values(checkoutDoc.jobs)[0];
    checkoutJob.steps.find((step: any) => step.uses === 'actions/checkout@v5').if = 'always()';
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(checkoutDoc), path.basename(logicPath)))
      .toThrow(/full job mismatch/);
  });

  it('rifiuta campi futuri non normalizzati sui background step', () => {
    const [generated] = generate({ outDir: workflowsDir, assignmentsPath, write: false });
    const logicPath = path.join(workflowsDir, 'crawler-group-01-logic.yml');
    const doc = YAML.parse(fs.readFileSync(logicPath, 'utf8'));
    const job: any = Object.values(doc.jobs)[0];
    job.steps.find((step: any) => step.background === true).if = 'always()';
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(doc), path.basename(logicPath)))
      .toThrow(/full job mismatch/);
  });

  it('rifiuta campi futuri non dichiarati a livello job e workflow', () => {
    const [generated] = generate({ outDir: workflowsDir, assignmentsPath, write: false });
    const logicPath = path.join(workflowsDir, 'crawler-group-01-logic.yml');
    const jobDoc = YAML.parse(fs.readFileSync(logicPath, 'utf8'));
    const job: any = Object.values(jobDoc.jobs)[0];
    job.strategy = { 'fail-fast': false };
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(jobDoc), path.basename(logicPath)))
      .toThrow(/full job mismatch/);

    const workflowDoc = YAML.parse(fs.readFileSync(logicPath, 'utf8'));
    workflowDoc.defaults = { run: { shell: 'bash' } };
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(workflowDoc), path.basename(logicPath)))
      .toThrow(/undeclared top-level workflow metadata/);
  });

  it('rifiuta righe extra nei bootstrap RC/PAT e metadata trigger annidati', () => {
    const [generated] = generate({ outDir: workflowsDir, assignmentsPath, write: false });
    const logicPath = path.join(workflowsDir, 'crawler-group-01-logic.yml');
    const source = fs.readFileSync(logicPath, 'utf8');

    const rcDoc = YAML.parse(source);
    const rcJob: any = Object.values(rcDoc.jobs)[0];
    rcJob.steps.find((step: any) => step.name === 'Load secrets from Remote Config').run += '\necho unexpected';
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(rcDoc), path.basename(logicPath)))
      .toThrow(/complete allowed form/);

    const patDoc = YAML.parse(source);
    const patJob: any = Object.values(patDoc.jobs)[0];
    patJob.steps.find((step: any) => step.name?.startsWith('Bootstrap write auth')).run += '\necho unexpected';
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(patDoc), path.basename(logicPath)))
      .toThrow(/write-auth bootstrap/);

    const triggerDoc = YAML.parse(source);
    triggerDoc.on.workflow_call.unexpected = true;
    expect(() => assertCrawlerLogicParity(generated.content, YAML.stringify(triggerDoc), path.basename(logicPath)))
      .toThrow(/workflow_call inputs\/secrets/);
  });

  it('include by default ogni nuovo bucket non dichiarato sicuro da escludere', () => {
    const bucketsPath = path.join(tmp, 'checkout-buckets.json');
    fs.writeFileSync(bucketsPath, JSON.stringify({
      buckets: [
        { id: 'public/images/', mb: 4_409 },
        { id: 'data/future-crawler-input/', mb: 900 },
      ],
    }));
    const patterns = crossRepoCrawlerSparsePatterns({ bucketsPath });
    expect(patterns).toContain('!/public/images/');
    expect(patterns).not.toContain('!/data/future-crawler-input/');
  });

  it('gli artifact portabili committati includono hash del transformer e sono la sorgente del corpus', () => {
    const { contract, outDir, contractPath } = generateArtifacts();
    const portableDir = path.join(repoRoot, '.github/corpus-workflows');
    for (const artifact of contract.artifacts) {
      expect(fs.readFileSync(path.join(portableDir, artifact.file), 'utf8'))
        .toBe(fs.readFileSync(path.join(outDir, artifact.file), 'utf8'));
    }
    expect(fs.readFileSync(path.join(portableDir, 'contract.json'), 'utf8'))
      .toBe(fs.readFileSync(contractPath, 'utf8'));
    expect(contract.generatorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.observerCount).toBe(CORPUS_OBSERVER_FILES.length);
    expect(contract.observers.map(({ source, target }: any) => ({ source, target })))
      .toEqual(CORPUS_OBSERVER_FILES);
    for (const observer of contract.observers) {
      expect(fs.readFileSync(path.join(outDir, observer.source), 'utf8'))
        .toBe(fs.readFileSync(path.join(portableDir, observer.source), 'utf8'));
    }
  });

  it('add/remove arriva al corpus eseguito e una nuova data lascia baseline allineate byte-identiche', () => {
    const manifestPath = path.join(tmp, 'manifest.json');
    const baselinePath = path.join(repoRoot, 'data/crawler-workflow-duration-baseline.json');
    const pinsPath = path.join(tmp, 'assignments.json');
    const localDir = path.join(tmp, 'local');
    const logicDir = path.join(tmp, 'logic');
    const portableDir = path.join(tmp, 'portable');
    const contractPath = path.join(portableDir, 'contract.json');
    const corpusRoot = path.join(tmp, 'corpus');
    const corpusManifestPath = path.join(corpusRoot, 'scripts/ci/loop-sync-manifest.json');
    const sourceManifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'data/crawler-manifest.json'), 'utf8'),
    );
    const target = sourceManifest.manifest[0].slug;
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(path.dirname(corpusManifestPath), { recursive: true });
    fs.writeFileSync(corpusManifestPath, JSON.stringify({
      files: [
        ...CRAWLER_WORKFLOW_FILES.map((file) => ({
          path: `.github/workflows/${file}`,
          sitePath: `.github/corpus-workflows/${file}`,
          mode: 'identical',
          baseline: {},
        })),
        {
          path: 'generator/data/crawler-cross-repo-contract.json',
          sitePath: '.github/corpus-workflows/contract.json',
          mode: 'identical',
          baseline: {},
        },
      ],
    }));
    fs.copyFileSync(assignmentsPath, pinsPath);

    const render = (doc: any) => {
      fs.writeFileSync(manifestPath, JSON.stringify(doc));
      const groups = generate({
        manifestPath,
        baselinePath,
        assignmentsPath: pinsPath,
        outDir: localDir,
        write: true,
      });
      generateCrawlerLogicArtifacts({ groupResults: groups, workflowsDir: logicDir });
      const generated = generateCrossRepoExecutionArtifacts({
        groupResults: groups,
        workflowsDir: logicDir,
        outDir: portableDir,
        contractPath,
      });
      prepareCrawlerWorkflowCorpusSync({ sourceDir: portableDir, corpusRoot, alignedAt: '2026-08-31' });
      return generated;
    };
    const countInLogic = () => fs.readdirSync(logicDir)
      .filter((file) => /-logic\.yml$/.test(file))
      .map((file) => fs.readFileSync(path.join(logicDir, file), 'utf8'))
      .filter((text) => text.includes(`id: crawler-${target}\n`)).length;

    const without = structuredClone(sourceManifest);
    without.manifest = without.manifest.filter((crawler: any) => crawler.slug !== target);
    const removed = render(without);
    expect(countInLogic()).toBe(0);
    expect(removed.contract.artifacts.flatMap((artifact: any) => artifact.members)).not.toContain(target);

    const added = render(sourceManifest);
    expect(countInLogic()).toBe(1);
    expect(added.contract.artifacts.flatMap((artifact: any) => artifact.members)
      .filter((slug: string) => slug === target)).toHaveLength(1);
    const executedDir = path.join(corpusRoot, '.github/workflows');
    const executed = fs.readdirSync(executedDir)
      .filter((file) => /^crawler-group-/.test(file))
      .map((file) => fs.readFileSync(path.join(executedDir, file), 'utf8'))
      .filter((text) => text.includes(`id: crawler-${target}\n`) && text.includes('background: true'));
    expect(executed).toHaveLength(1);
    for (const observer of CORPUS_OBSERVER_FILES) {
      expect(fs.readFileSync(path.join(corpusRoot, observer.target), 'utf8'))
        .toBe(fs.readFileSync(path.join(portableDir, observer.source), 'utf8'));
    }
    const transportedManifest = JSON.parse(fs.readFileSync(corpusManifestPath, 'utf8'));
    const baselines = transportedManifest.files.map((entry: any) => entry.baseline);
    expect(baselines).toHaveLength(31);
    expect(baselines.every((baseline: any) => baseline.site === baseline.corpus && baseline.site.length === 16))
      .toBe(true);
    const stableManifest = fs.readFileSync(corpusManifestPath, 'utf8');
    prepareCrawlerWorkflowCorpusSync({ sourceDir: portableDir, corpusRoot, alignedAt: '2026-09-01' });
    expect(fs.readFileSync(corpusManifestPath, 'utf8')).toBe(stableManifest);
  }, 30_000);

  it('un artifact sorgente mancante fallisce prima di cancellare la destinazione', () => {
    const { outDir } = generateArtifacts();
    fs.renameSync(path.join(outDir, 'crawler-group-23.yml'), path.join(outDir, 'crawler-group-23.missing'));
    const corpusRoot = path.join(tmp, 'truncated-corpus');
    const sentinel = path.join(corpusRoot, '.github/workflows/crawler-group-23.yml');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'sentinel\n');
    expect(() => prepareCrawlerWorkflowCorpusSync({ sourceDir: outDir, corpusRoot }))
      .toThrow(/required crawler transport input missing/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('sentinel\n');
  });

  it('un observer sorgente mancante fallisce prima di sostituire il workflow corpus', () => {
    const { outDir } = generateArtifacts();
    const observer = CORPUS_OBSERVER_FILES.find(({ source }) => /\.ya?ml$/.test(source))!;
    fs.renameSync(path.join(outDir, observer.source), path.join(outDir, `${observer.source}.missing`));
    const corpusRoot = path.join(tmp, 'truncated-observer-corpus');
    const destination = path.join(corpusRoot, observer.target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'sentinel-workflow\n');
    expect(() => prepareCrawlerWorkflowCorpusSync({ sourceDir: outDir, corpusRoot }))
      .toThrow(/required crawler transport input missing/);
    expect(fs.readFileSync(destination, 'utf8')).toBe('sentinel-workflow\n');
  });

  it('rifiuta qualunque mutazione non-owned nel loop-sync manifest condiviso', () => {
    const baseManifest: any = {
      files: [
        { path: 'generator/data/other.json', mode: 'corpus-only', reason: 'owned by corpus' },
      ],
      schemaVersion: 1,
    };
    const allowed = structuredClone(baseManifest);
    allowed.files.push(
      ...CRAWLER_WORKFLOW_FILES.map((file) => ({
        path: `.github/workflows/${file}`,
        sitePath: `.github/corpus-workflows/${file}`,
        mode: 'identical',
        baseline: { site: 'new', corpus: 'new', alignedAt: '2026-08-31' },
      })),
      ...CORPUS_OBSERVER_FILES.map(({ source, target }) => ({
        path: target,
        sitePath: `.github/corpus-workflows/${source}`,
        mode: 'identical',
        baseline: { site: 'new', corpus: 'new', alignedAt: '2026-08-31' },
      })),
      {
        path: 'generator/data/crawler-cross-repo-contract.json',
        sitePath: '.github/corpus-workflows/contract.json',
        mode: 'identical',
        baseline: { site: 'new', corpus: 'new', alignedAt: '2026-08-31' },
      },
    );
    expect(() => assertCrawlerManifestDelta({ baseManifest, currentManifest: allowed })).not.toThrow();

    const contaminated = structuredClone(allowed);
    contaminated.files[0].reason = 'silently changed by transport branch';
    expect(() => assertCrawlerManifestDelta({ baseManifest, currentManifest: contaminated }))
      .toThrow(/outside the 31 owned baselines/);
  });

  it('non consente al vecchio one-shot di rigenerare il reusable workflow difettoso', () => {
    const legacyPath = path.join(repoRoot, 'scripts/migrate-crawler-groups-to-reusable-workflow.mjs');
    expect(() => execFileSync(process.execPath, [legacyPath], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/retired migration: use generate-crawler-group-workflows\.mjs/);
    expect(fs.readFileSync(legacyPath, 'utf8').split('\n').length).toBeLessThan(20);
  });

  it('genera 23 gruppi + translate senza reusable workflow o composite action cross-repo', () => {
    const { contract, outDir } = generateArtifacts();
    expect(contract.artifactCount).toBe(24);

    for (const artifact of contract.artifacts) {
      const text = fs.readFileSync(path.join(outDir, artifact.file), 'utf8');
      expect(text).not.toMatch(/uses:\s+valerielinc-ops\/frontaliere-si-o-no\/.github\/workflows\//);
      expect(text).not.toMatch(/uses:\s+valerielinc-ops\/frontaliere-si-o-no\/.github\/actions\//);
      expect(text).toContain('uses: ./.github/actions/');
    }
  });

  it('avvolge tutte le installazioni standalone nei retry site-owned', () => {
    const { contract, outDir } = generateArtifacts();
    expect(contract.siteRuntimePaths).toContain('scripts/ci/crawler-retry-cmd.sh');

    for (const artifact of contract.artifacts) {
      const text = fs.readFileSync(path.join(outDir, artifact.file), 'utf8');
      const lines = text.split('\n');
      expect(lines.filter((line) => /^\s*(run:\s*)?npm ci\b/.test(line)), artifact.file)
        .toEqual([]);
      expect(lines.filter((line) => (
        !/^\s*#/.test(line.trim()) && /(^|[\s;&|])npx\s/.test(line) &&
        !line.includes('crawler-retry-cmd.sh')
      )), artifact.file).toEqual([]);
      expect(text, artifact.file)
        .toMatch(/run: bash scripts\/ci\/crawler-retry-cmd\.sh npm ci(?: --ignore-scripts)?/);

      if (text.includes('playwright install --with-deps chromium')) {
        expect(text, artifact.file).toContain(
          'run: bash scripts/ci/crawler-retry-cmd.sh npx playwright install --with-deps chromium',
        );
      }
    }
  });

  it('ritenta soltanto il checkout sparse, con backoff prima di qualunque logica', () => {
    const { contract, outDir } = generateArtifacts();
    expect(contract.checkout).toMatchObject({
      attempts: 2,
      backoffSeconds: 30,
      retryScope: 'checkout-before-logic-only',
      reporter: 'corpus-issue-github-token',
    });
    expect(contract.checkout.excludedMb).toBeGreaterThan(5_000);

    for (const artifact of contract.artifacts) {
      const doc = YAML.parse(fs.readFileSync(path.join(outDir, artifact.file), 'utf8'));
      expect(Object.keys(doc.jobs)).toHaveLength(1);
      const job: any = Object.values(doc.jobs)[0];
      const checkouts = job.steps.filter((step: any) => step.uses === 'actions/checkout@v5');
      expect(checkouts).toHaveLength(2);
      expect(checkouts[0]).toMatchObject({
        id: 'site_checkout_primary',
        'continue-on-error': true,
      });
      expect(checkouts[1].if).toBe("steps.site_checkout_primary.outcome == 'failure'");

      const reporter = job.steps.find((step: any) => step.name === 'Report exhausted site checkout');
      expect(reporter).toMatchObject({
        if: "always() && steps.site_checkout_primary.outcome == 'failure' && steps.site_checkout_retry.outcome == 'failure'",
        env: {
          GH_TOKEN: '${{ github.token }}',
          ISSUE_TITLE: `Workflow Failure: ${doc.name}`,
        },
      });
      expect(reporter.env.ISSUE_TITLE).toMatch(/^Workflow Failure: .+/);
      expect(reporter.run).toContain('gh issue list --repo "$GITHUB_REPOSITORY"');
      expect(reporter.run).toContain('gh issue comment');
      expect(reporter.run).toContain('gh issue create');
      expect(reporter.run).not.toContain('GITHUB_PAT');
      expect(doc.permissions.issues).toBe('write');
      expect(doc.permissions.actions).toBe('read');

      const checkoutReady = job.steps.find((step: any) => step.id === 'checkout');
      expect(checkoutReady).toMatchObject({
        name: 'Confirm site checkout succeeded',
        run: 'true',
      });
      expect(checkoutReady.if).toContain("steps.site_checkout_retry.outcome == 'success'");

      const backoffAt = job.steps.findIndex((step: any) => /Backoff 30s/.test(step.name ?? ''));
      const firstLogicAt = job.steps.findIndex((step: any) =>
        step.background === true || /^Phase /.test(step.name ?? ''));
      expect(backoffAt).toBeGreaterThan(0);
      expect(job.steps[backoffAt].run).toContain('sleep 30');
      expect(firstLogicAt).toBeGreaterThan(backoffAt);
      expect(firstLogicAt).toBeGreaterThan(job.steps.indexOf(checkoutReady));
      expect(job.steps.indexOf(reporter)).toBeGreaterThan(job.steps.indexOf(checkouts[1]));
      expect(job.steps.indexOf(reporter)).toBeLessThan(job.steps.indexOf(checkoutReady));

      for (const checkout of checkouts) {
        expect(checkout.with.repository).toBe('valerielinc-ops/frontaliere-si-o-no');
        expect(checkout.with.token).toBeUndefined();
        expect(checkout.with['sparse-checkout']).toContain('!/public/images/');
        expect(checkout.with['sparse-checkout']).toContain('!/packages/articles/content/');
        expect(checkout.with['sparse-checkout']).not.toContain('!/data/jobs/');
      }
    }
  });

  it('adatta ogni reporter diagnostico al repo e al workflow standalone del corpus', () => {
    const { contract, outDir } = generateArtifacts();
    let diagnosticReporters = 0;
    for (const artifact of contract.artifacts) {
      const doc = YAML.parse(fs.readFileSync(path.join(outDir, artifact.file), 'utf8'));
      const job: any = Object.values(doc.jobs)[0];
      const reporters = job.steps.filter((step: any) => step.uses === './.github/actions/report-failure');
      expect(reporters, artifact.file).toHaveLength(1);
      for (const reporter of reporters) {
        diagnosticReporters += 1;
        expect(reporter.if).toBe(
          "failure() && (steps.site_checkout_primary.outcome == 'success' || steps.site_checkout_retry.outcome == 'success')",
        );
        expect(reporter.with).toMatchObject({
          title: `Workflow Failure: ${doc.name}`,
          'closed-by': 'close-recovered-failure-issues',
          'github-token': '${{ github.token }}',
          repo: '${{ github.repository }}',
          'workflow-name': doc.name,
          'workflow-file': `.github/corpus-workflows/${artifact.file}`,
        });
        expect(reporter.with.repo).not.toBe('valerielinc-ops/frontaliere-si-o-no');
        expect(reporter.with['workflow-file']).not.toContain('-logic.yml');
      }
      const firstCrawlerAt = job.steps.findIndex((step: any) => step.background === true);
      const reporterAt = job.steps.indexOf(reporters[0]);
      if (artifact.members.length > 0) {
        expect(reporterAt, artifact.file).toBeLessThan(firstCrawlerAt);
        expect(reporters[0].name).toBe('Report shared setup failure to GitHub Issues');
      } else {
        expect(firstCrawlerAt, artifact.file).toBe(-1);
        expect(reporters[0].name).toBe('Report failure to GitHub Issues');
      }
    }
    expect(diagnosticReporters).toBe(24);
  });

  it('un fallimento parziale non puo rilanciare i crawler gia eseguiti', () => {
    const { contract, outDir } = generateArtifacts();
    for (const artifact of contract.artifacts.filter((item: any) => item.members.length > 0)) {
      const doc = YAML.parse(fs.readFileSync(path.join(outDir, artifact.file), 'utf8'));
      const job: any = Object.values(doc.jobs)[0];
      const executed = job.steps.filter((step: any) => step.background === true);
      expect(executed.map((step: any) => step.id)).toEqual(
        artifact.members.map((member: string) => `crawler-${member}`),
      );
      expect(new Set(executed.map((step: any) => step.id)).size).toBe(executed.length);
      expect(job.needs).toBeUndefined();
    }
  });
});
