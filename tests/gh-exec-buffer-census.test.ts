import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Whoever reads `gh` through a synchronous exec declares its buffer.
 *
 * `execFileSync`, `spawnSync` and `execSync` stop reading the child at
 * `maxBuffer`, 1 MiB when it is not given, and fail with ENOBUFS. A REST
 * listing crosses that line without warning: the raw page of 60 deploy runs
 * weighs 1,074,863 bytes. PR 12277 read it through a bare `execFileSync` and
 * from its merge the deploy queue failed every read, retries included: no
 * deploy was requested for hours (issue 12308). The call looked exactly like
 * thirty others already in the tree.
 *
 * So the bare form is closed to new code. The files below are the reads that
 * existed on 2026-10-08, each with its count; none of them is known to be
 * near the limit, and none has been measured either. A new file, one more
 * call, or a file that drops below its number fails the test until this list
 * says so: lower the number when you give a call its `maxBuffer`, and remove
 * the entry at zero. `stdio: 'inherit'` is not a read and is not counted.
 *
 * The test reads the sources from disk and imports none of them: the selector
 * ties it to the diff through `sourceTreeLintTests` in
 * `scripts/ci/run-related-tests.mjs`, with the same perimeter as this scan.
 */
const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'scripts';
const GH_EXEC = /\b(?:execFileSync|spawnSync|execSync)\(\s*(['"])gh\1/g;

const KNOWN_UNBUFFERED_READS: Record<string, number> = {
  'scripts/assemble-jobs-dataset.mjs': 6,
  'scripts/ci/codex-auth-rotate.mjs': 1,
  'scripts/ci/decompose-route-check.mjs': 3,
  'scripts/ci/detect-aggregate.mjs': 1,
  'scripts/ci/explain-job-verdict.mjs': 1,
  'scripts/ci/loop-health-report.mjs': 1,
  'scripts/ci/native-automerge-gate.mjs': 1,
  'scripts/ci/pr-autorebase.mjs': 1,
  'scripts/ci/pr-watch-gate.mjs': 1,
  'scripts/ci/report-synced-article-factuality.mjs': 1,
  'scripts/ci/technical-operations-audit.mjs': 3,
  'scripts/cwv-attribution-report.mjs': 1,
  'scripts/experiments/jobgate-monitor.mjs': 1,
  'scripts/lib/monitor-issue-reconcile.mjs': 2,
  'scripts/monitor-sector-coverage.mjs': 2,
  'scripts/prospect-promote.mjs': 3,
  'scripts/prune-merged-worktrees.mjs': 1,
};

function moduleFiles(directory: string, found: string[] = []) {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules') continue;
    const full = path.join(directory, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) moduleFiles(full, found);
    else if (stat.isFile() && name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/** One call, from the function name to the parenthesis that closes it. */
function callText(source: string, start: number) {
  const limit = Math.min(source.length, start + 2000);
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start, limit);
}

export function unbufferedGhReads(source: string) {
  let count = 0;
  for (const match of source.matchAll(GH_EXEC)) {
    const call = callText(source, match.index ?? 0);
    if (/\bmaxBuffer\b/.test(call)) continue;
    if (/stdio:\s*(['"])inherit\1/.test(call)) continue;
    count += 1;
  }
  return count;
}

describe('synchronous reads of gh declare their buffer', () => {
  it('recognises the bare form and the two forms that are not a risk', () => {
    expect(unbufferedGhReads("execFileSync('gh', args, { encoding: 'utf8' })")).toBe(1);
    expect(unbufferedGhReads('spawnSync("gh", ["api", path])')).toBe(1);
    expect(unbufferedGhReads("execFileSync('gh', args, {\n  encoding: 'utf8',\n  maxBuffer: 64 * 1024 * 1024,\n})")).toBe(0);
    expect(unbufferedGhReads("spawnSync('gh', ['pr', 'checkout', n], { stdio: 'inherit' })")).toBe(0);
    expect(unbufferedGhReads("execFileSync('git', ['status'])")).toBe(0);
    // Two calls in one file are two reads, whatever sits between them.
    expect(unbufferedGhReads("a = execFileSync('gh', x);\nconst maxBuffer = 1;\nb = execFileSync('gh', y);")).toBe(2);
  });

  it('finds no read outside the list, and every listed file at its number', () => {
    const counted: Record<string, number> = {};
    for (const file of moduleFiles(path.join(ROOT, SCAN_ROOT))) {
      const reads = unbufferedGhReads(readFileSync(file, 'utf8'));
      if (reads > 0) counted[path.relative(ROOT, file).split(path.sep).join('/')] = reads;
    }
    expect(counted).toEqual(KNOWN_UNBUFFERED_READS);
  });

  it('keeps the deploy control plane off the list', () => {
    for (const file of ['scripts/ci/request-latest-deploy.mjs', 'scripts/ci/rearm-deploy-build.mjs', 'scripts/crawler-quarantine-review.mjs']) {
      expect(KNOWN_UNBUFFERED_READS, file).not.toHaveProperty(file);
      expect(unbufferedGhReads(readFileSync(path.join(ROOT, file), 'utf8')), file).toBe(0);
    }
  });
});
