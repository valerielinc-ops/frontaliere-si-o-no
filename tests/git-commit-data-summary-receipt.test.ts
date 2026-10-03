// @vitest-environment node
//
// A per-crawler summary (data/jobs-crawler-summaries/by-crawler/*.json) is the
// receipt of ONE crawler run: crawler-template.mjs writes newCount /
// updatedCount / removedCount / unchangedCount as the lengths of the lists of
// one computeCrawlDiff partition. git-commit-data.sh used to send it through
// merge_json_3way against its deliberately stale base, which fused two
// receipts field by field: lists = union of different runs, counts = one run.
// On origin/main (2026-10-03) 164 of 631 summaries had a count different from
// its list. The fix keeps one whole file instead (the newest generatedAt).
//
// Failure title if this observer fires:
//   «Summary crawler fusa fra run diverse: liste più lunghe dei conteggi»
//
// The abraxas fixtures are the real blobs of the production case:
//   - abraxas-base.json   = origin/main 5fe4ef6a287 (2026-10-01 09:19Z run), the
//     checkout the 2026-10-02 21:17Z run started from;
//   - abraxas-remote.json = origin/main 04bdbfcce4a (2026-10-02 09:19Z run);
//   - abraxas-local.json  = the coherent receipt that run wrote, reconstructed
//     from e7d7f8760f3 (every count equals its list). Before the fix the
//     commit path turned these three into e7d7f8760f3 byte for byte: newCount
//     0 with 2 newJobs, removedCount 0 with 8 removedJobs, the same ids both
//     new and updated.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const FIXTURE_DIR = resolve(ROOT, 'tests/fixtures/git-commit-data-summary-receipt');

// The script uses `declare -A` (associative arrays), requiring bash 4+.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

// Writer cap on every list (crawler-template.mjs).
const SUMMARY_LIST_CAP = 30;
const SECTIONS = [
  ['newCount', 'newJobs'],
  ['updatedCount', 'updatedJobs'],
  ['removedCount', 'removedJobs'],
  ['unchangedCount', 'unchangedJobs'],
] as const;
const PARTITION = ['newJobs', 'updatedJobs', 'unchangedJobs'] as const;

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface Harness {
  originDir: string;
  repoDir: string;
  otherDir: string;
}

function initHarness(): Harness {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-receipt-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-receipt-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-receipt-other-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { originDir, repoDir, otherDir };
}

function cleanup(h: Harness): void {
  for (const d of [h.originDir, h.repoDir, h.otherDir]) rmSync(d, { recursive: true, force: true });
}

function writeRaw(dir: string, relPath: string, raw: string): void {
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), raw);
}

const toRaw = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function commitAndPush(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir });
}

/** The OTHER writer (an earlier run of the same crawler) that pushed after our checkout. */
function pushFromConcurrentWriter(h: Harness, files: Record<string, string>): void {
  const clone = join(h.otherDir, `clone-${Math.random().toString(36).slice(2, 8)}`);
  execFileSync('git', ['clone', '-q', h.originDir, clone]);
  execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Other'], { cwd: clone });
  for (const [relPath, raw] of Object.entries(files)) writeRaw(clone, relPath, raw);
  commitAndPush(clone, 'remote crawler run');
}

const scriptEnv = (h: Harness) => ({
  ...process.env,
  SKIP_AI_TRANSLATION: '1',
  SLUG_HISTORY_SUMMARY_FILE: join(h.repoDir, 'no-such-slug-history-summary.txt'),
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GITHUB_RUN_ID: '',
  GITHUB_REPOSITORY: '',
  GITHUB_OUTPUT: '',
});

/** Grouped-isolated commit path (crawler-group workers). */
function runGroupedCommit(h: Harness, crawlerKey: string): string {
  return execFileSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', `update ${crawlerKey}`], {
    cwd: h.repoDir,
    encoding: 'utf8',
    env: { ...scriptEnv(h), JOBS_SLICE_FILE: `data/jobs/by-crawler/${crawlerKey}.json` },
  });
}

/** Legacy path: stash → rebase → pop, conflicts resolved by restore_stashed_changes_with_safe_merge. */
function runLegacyCommit(h: Harness, extraPaths: string[]): string {
  return execFileSync(BASH_BIN, [SCRIPT_PATH, 'legacy update', ...extraPaths], {
    cwd: h.repoDir,
    encoding: 'utf8',
    env: { ...scriptEnv(h), JOBS_SLICE_FILE: '', DATA_PIPELINE_LEASE: '0' },
  });
}

function readRawFromOrigin(h: Harness, relPath: string): string {
  return execFileSync('git', ['show', `main:${relPath}`], {
    cwd: h.originDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

type Summary = Record<string, unknown> & {
  generatedAt?: string;
};

/**
 * Receipt invariant of a committed summary: every list within the writer cap,
 * every count at least its list (equal below the cap), and no job id in more
 * than one section of the partition.
 */
function expectCoherentReceipt(raw: string): void {
  const summary = JSON.parse(raw) as Summary;
  for (const [countField, listField] of SECTIONS) {
    const list = (summary[listField] ?? []) as unknown[];
    const count = summary[countField] as number;
    expect(list.length, `${listField} over the writer cap`).toBeLessThanOrEqual(SUMMARY_LIST_CAP);
    expect(count, `${countField} below ${listField}.length`).toBeGreaterThanOrEqual(list.length);
    if (count <= SUMMARY_LIST_CAP) expect(list.length, `${listField}.length != ${countField}`).toBe(count);
  }
  const owner = new Map<string, string>();
  for (const listField of PARTITION) {
    for (const job of (summary[listField] ?? []) as Array<{ id?: string }>) {
      if (!job.id) continue;
      expect(owner.get(job.id), `${job.id} in both ${owner.get(job.id)} and ${listField}`).toBeUndefined();
      owner.set(job.id, listField);
    }
  }
}

const job = (crawlerKey: string, n: number, crawledAt: string) => ({
  id: `${crawlerKey}-${String(n).padStart(4, '0')}`,
  url: `https://jobs.example.test/${crawlerKey}/${n}/`,
  title: `Posizione ${n}`,
  crawledAt,
});

/** A coherent receipt: counts are the lengths of the lists, as the writer emits them. */
function receipt(
  crawlerKey: string,
  generatedAt: string | undefined,
  lists: { newJobs?: number[]; updatedJobs?: number[]; removedJobs?: number[]; unchangedJobs?: number[] },
): Summary {
  const at = generatedAt ?? daysAgo(3);
  const build = (ids: number[] = []) => ids.map((n) => job(crawlerKey, n, at));
  const newJobs = build(lists.newJobs);
  const updatedJobs = build(lists.updatedJobs);
  const removedJobs = build(lists.removedJobs);
  const unchangedJobs = build(lists.unchangedJobs);
  return {
    key: crawlerKey,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    total: newJobs.length + updatedJobs.length + unchangedJobs.length,
    newCount: newJobs.length,
    updatedCount: updatedJobs.length,
    removedCount: removedJobs.length,
    unchangedCount: unchangedJobs.length,
    newJobs,
    updatedJobs,
    removedJobs,
    unchangedJobs,
  };
}

// Three runs of one crawler, same shape as abraxas. The checkout (base) is run
// N-1, the remote holds run N, the local worktree run N+1. Run N+1 found as
// many new jobs as run N-1 did, so the old field merge read newCount as
// "unchanged locally" and took run N's 0 while unioning the lists.
const KEY = 'receipt-probe';
const SUMMARY = `data/jobs-crawler-summaries/by-crawler/${KEY}.json`;
const SLICE = `data/jobs/by-crawler/${KEY}.json`;
const runBase = () => receipt(KEY, daysAgo(2), { newJobs: [1, 2], unchangedJobs: [5] });
const runRemote = () => receipt(KEY, daysAgo(1), { updatedJobs: [1, 2], removedJobs: [5] });
const runLocal = () => receipt(KEY, daysAgo(0), { newJobs: [3, 4], updatedJobs: [1, 2] });

describe('git-commit-data.sh — crawler summaries are receipts, never merged field by field', () => {
  it('reproduces the abraxas production case with the real blobs and keeps the local receipt', () => {
    const h = initHarness();
    const summaryPath = 'data/jobs-crawler-summaries/by-crawler/abraxas.json';
    const base = readFileSync(join(FIXTURE_DIR, 'abraxas-base.json'), 'utf8');
    const remote = readFileSync(join(FIXTURE_DIR, 'abraxas-remote.json'), 'utf8');
    const local = readFileSync(join(FIXTURE_DIR, 'abraxas-local.json'), 'utf8');
    try {
      // The fixtures themselves are coherent receipts: the incoherence can
      // only come from the commit path.
      for (const raw of [base, remote, local]) expectCoherentReceipt(raw);

      writeRaw(h.repoDir, summaryPath, base);
      commitAndPush(h.repoDir, 'checkout of the 2026-10-02 21:17Z run');
      pushFromConcurrentWriter(h, { [summaryPath]: remote });
      writeRaw(h.repoDir, summaryPath, local);

      const output = runGroupedCommit(h, 'abraxas');

      const published = readRawFromOrigin(h, summaryPath);
      expectCoherentReceipt(published);
      expect(published).toBe(local);
      expect(output).toContain(`summary receipt: kept local for ${summaryPath}`);
    } finally {
      cleanup(h);
    }
  });

  it('commits the local receipt byte for byte when the remote holds an older run', () => {
    const h = initHarness();
    try {
      writeRaw(h.repoDir, SUMMARY, toRaw(runBase()));
      commitAndPush(h.repoDir, 'seed');
      pushFromConcurrentWriter(h, { [SUMMARY]: toRaw(runRemote()) });
      const local = toRaw(runLocal());
      writeRaw(h.repoDir, SUMMARY, local);

      runGroupedCommit(h, KEY);

      const published = readRawFromOrigin(h, SUMMARY);
      expectCoherentReceipt(published);
      expect(published).toBe(local);
    } finally {
      cleanup(h);
    }
  });

  it('keeps the remote receipt when it comes from a more recent run', () => {
    const h = initHarness();
    try {
      writeRaw(h.repoDir, SUMMARY, toRaw(runBase()));
      commitAndPush(h.repoDir, 'seed');
      const remote = toRaw(receipt(KEY, daysAgo(0), { newJobs: [3], updatedJobs: [1, 2] }));
      pushFromConcurrentWriter(h, { [SUMMARY]: remote });
      writeRaw(h.repoDir, SUMMARY, toRaw(receipt(KEY, daysAgo(1), { newJobs: [2], updatedJobs: [1] })));

      const output = runGroupedCommit(h, KEY);

      const published = readRawFromOrigin(h, SUMMARY);
      expectCoherentReceipt(published);
      expect(published).toBe(remote);
      expect(output).toContain(`summary receipt: kept remote for ${SUMMARY}`);
    } finally {
      cleanup(h);
    }
  });

  it('keeps the local receipt when the remote one has no readable generatedAt', () => {
    const h = initHarness();
    try {
      writeRaw(h.repoDir, SUMMARY, toRaw(runBase()));
      commitAndPush(h.repoDir, 'seed');
      pushFromConcurrentWriter(h, {
        [SUMMARY]: toRaw(receipt(KEY, undefined, { newJobs: [2, 6], updatedJobs: [1] })),
      });
      const local = toRaw(runLocal());
      writeRaw(h.repoDir, SUMMARY, local);

      runGroupedCommit(h, KEY);

      const published = readRawFromOrigin(h, SUMMARY);
      expectCoherentReceipt(published);
      expect(published).toBe(local);
    } finally {
      cleanup(h);
    }
  });

  it('still 3-way merges the job slice committed together with the summary', () => {
    const h = initHarness();
    const slice = (urls: number[]) => toRaw({
      crawlerKey: KEY,
      jobs: urls.map((n) => job(KEY, n, daysAgo(1))),
    });
    try {
      writeRaw(h.repoDir, SUMMARY, toRaw(runBase()));
      writeRaw(h.repoDir, SLICE, slice([1]));
      commitAndPush(h.repoDir, 'seed');
      pushFromConcurrentWriter(h, { [SUMMARY]: toRaw(runRemote()), [SLICE]: slice([1, 2]) });
      const local = toRaw(runLocal());
      writeRaw(h.repoDir, SUMMARY, local);
      writeRaw(h.repoDir, SLICE, slice([1, 3]));

      runGroupedCommit(h, KEY);

      const publishedSummary = readRawFromOrigin(h, SUMMARY);
      expectCoherentReceipt(publishedSummary);
      expect(publishedSummary).toBe(local);
      const publishedSlice = JSON.parse(readRawFromOrigin(h, SLICE)) as { jobs: Array<{ url: string }> };
      // Remote-only and local-only jobs both survive: the slice merge is untouched.
      expect(publishedSlice.jobs.map((j) => j.url).sort()).toEqual(
        [1, 2, 3].map((n) => job(KEY, n, '').url).sort(),
      );
    } finally {
      cleanup(h);
    }
  });

  it('keeps the summary whole on the stash-restore merge path too', () => {
    const h = initHarness();
    try {
      writeRaw(h.repoDir, SUMMARY, toRaw(runBase()));
      commitAndPush(h.repoDir, 'seed');
      pushFromConcurrentWriter(h, { [SUMMARY]: toRaw(runRemote()) });
      const local = toRaw(runLocal());
      writeRaw(h.repoDir, SUMMARY, local);

      const output = runLegacyCommit(h, [SUMMARY]);

      // The rewrite of the same lines on both sides makes the stash pop
      // conflict, so the file reaches the safe-merge restore.
      expect(output).toContain('Stash-pop conflict');
      const published = readRawFromOrigin(h, SUMMARY);
      expectCoherentReceipt(published);
      expect(published).toBe(local);
      expect(output).toContain(`summary receipt: kept local for ${SUMMARY}`);
    } finally {
      cleanup(h);
    }
  });
});
