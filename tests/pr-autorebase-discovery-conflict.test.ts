import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_PER_RUN,
  classifyMergeTreeStatus,
  decideConflictScan,
  discoverOpenPullRequests,
  parsePaginatedPullRequests,
  preparePullRequestSweep,
} from '../scripts/ci/pr-autorebase.mjs';

function headSha(number: number): string {
  return number.toString(16).padStart(2, '0').slice(-2).repeat(20);
}

function apiPullRequest(number: number, draft = false) {
  return {
    number,
    draft,
    head: { ref: `fix/${number}`, sha: headSha(number) },
    labels: number % 2 === 0 ? [{ name: 'stale-review' }] : [],
  };
}

describe('pr-autorebase paginated PR discovery', () => {
  it('reads the complete pool, filters drafts, and rotates before the cap', () => {
    const firstPage = Array.from({ length: 60 }, (_, index) => apiPullRequest(index + 1));
    const secondPage = Array.from({ length: 61 }, (_, index) => apiPullRequest(index + 61));
    firstPage[0] = apiPullRequest(1, true);
    const calls: string[][] = [];

    const pullRequests = discoverOpenPullRequests((args) => {
      calls.push(args);
      return [firstPage, secondPage];
    }, 'owner/repo');

    expect(calls).toEqual([[
      'api', '--paginate', '--slurp',
      'repos/owner/repo/pulls?state=open&per_page=100',
    ]]);
    expect(pullRequests).toHaveLength(121);
    expect(new Set(pullRequests.map(({ number }) => number)).size).toBe(121);

    const sweep = preparePullRequestSweep(pullRequests, 3);
    expect(sweep).toHaveLength(120);
    expect(sweep.every(({ isDraft }) => !isDraft)).toBe(true);
    expect(sweep[0].number).toBe(5);
    expect(new Set(sweep.map(({ number }) => number)).size).toBe(120);
    expect(sweep.slice(0, MAX_PER_RUN)).toHaveLength(MAX_PER_RUN);
  });

  it('rejects malformed or incomplete API payloads instead of treating them as empty', () => {
    expect(() => parsePaginatedPullRequests({})).toThrow(/array of pages/i);
    expect(() => parsePaginatedPullRequests([{}])).toThrow(/page 1 is not an array/i);
    expect(() => parsePaginatedPullRequests([[{
      ...apiPullRequest(1),
      head: { ref: 'fix/1', sha: 'short' },
    }]])).toThrow(/invalid head/i);
    expect(() => parsePaginatedPullRequests([[{
      ...apiPullRequest(1),
      labels: null,
    }]])).toThrow(/invalid labels/i);
    expect(() => parsePaginatedPullRequests([
      [apiPullRequest(1)],
      [apiPullRequest(1)],
    ])).toThrow(/appears more than once/i);
  });

  it('propagates API failures to the caller', () => {
    expect(() => discoverOpenPullRequests(() => {
      throw new Error('rate limit from GitHub');
    }, 'owner/repo')).toThrow(/rate limit from GitHub/);
  });

  it('does not turn an unavailable discovery API into a green CLI run', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'pr-autorebase-gh-'));
    const fakeGh = join(fakeBin, 'gh');
    const script = fileURLToPath(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url));
    writeFileSync(fakeGh, '#!/bin/sh\nexit 42\n');
    chmodSync(fakeGh, 0o755);

    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'test-token',
          GITHUB_RUN_NUMBER: '1',
        },
      });
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(/discovery PR fallita/i);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('pr-autorebase conflict scan tri-state', () => {
  it('maps merge-tree exit statuses without treating unknown as clean', () => {
    expect(classifyMergeTreeStatus(0)).toBe('clean');
    expect(classifyMergeTreeStatus(1)).toBe('conflicted');
    expect(classifyMergeTreeStatus(null)).toBe('unknown');
    expect(classifyMergeTreeStatus(2)).toBe('unknown');
  });

  it.each([
    ['fetch failure', { fetchOk: false, mergeTreeState: 'clean', hasLabel: true }],
    ['merge-tree failure', { fetchOk: true, mergeTreeState: 'unknown', hasLabel: true }],
  ])('%s preserves the existing conflict state', (_label, input) => {
    expect(decideConflictScan(input)).toEqual({ state: 'unknown', action: 'none' });
  });

  it('allows mutations only for a verified clean or conflicted result', () => {
    expect(decideConflictScan({
      fetchOk: true, mergeTreeState: 'clean', hasLabel: true,
    })).toEqual({ state: 'clean', action: 'remove' });
    expect(decideConflictScan({
      fetchOk: true, mergeTreeState: 'conflicted', hasLabel: false,
    })).toEqual({ state: 'conflicted', action: 'add' });
  });

  it.each(['fetch', 'merge-tree'])('defers the whole near-merge PR when %s is unknown, before any mutation', (failStage) => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'pr-autorebase-unknown-'));
    const callLog = join(fakeBin, 'calls.log');
    const fakeGh = join(fakeBin, 'gh');
    const fakeGit = join(fakeBin, 'git');
    const script = fileURLToPath(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url));
    const sha = 'a'.repeat(40);
    const pullRequests = JSON.stringify([[{
      number: 1,
      draft: false,
      head: { ref: 'fix/1', sha },
      labels: [{ name: 'stale-review' }, { name: 'needs-human' }],
    }]]);
    writeFileSync(callLog, '');
    writeFileSync(fakeGh, `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *'pulls?state=open&per_page=100'*) printf '%s\\n' '${pullRequests}';;
  *'compare/main...'*) printf '1\\n';;
  *'/check-runs?per_page=100'*) printf '%s\\n' '{"check_runs":[]}';;
  *'/actions/workflows/tests.yml/runs?'*) printf '%s\\n' '{"workflow_runs":[]}';;
  *'/pulls/1/reviews'*) printf '%s\\n' '[]';;
  *'/pulls/1'*) printf '%s\\n' '{"body":"","head":{"sha":"${sha}"}}';;
  *'/issues/1/comments'*) printf '\\n';;
  *) printf '%s\\n' '[]';;
esac
`);
    writeFileSync(fakeGit, `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
if [ "$FAIL_STAGE" = fetch ] && [ "$1" = fetch ]; then
  printf 'simulated fetch failure\\n' >&2
  exit 42
fi
if [ "$FAIL_STAGE" = merge-tree ] && [ "$1" = merge-tree ]; then
  printf 'simulated merge-tree failure\\n' >&2
  exit 2
fi
if [ "$1" = fetch ]; then
  # A successful fetch has no stdout; it still makes the next merge-tree call
  # observable in the merge-tree failure case.
  exit 0
fi
if [ "$1" = merge-tree ]; then
  exit 0
fi
exit 0
`);
    chmodSync(fakeGh, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          CALL_LOG: callLog,
          FAIL_STAGE: failStage,
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'test-token',
          GITHUB_RUN_NUMBER: '1',
        },
      });
      const calls = readFileSync(callLog, 'utf8');
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/rinvio ogni azione questo tick/i);
      expect(calls).toMatch(/git fetch origin fix\/1 main/);
      if (failStage === 'merge-tree') expect(calls).toMatch(/git merge-tree --write-tree origin\/main/);
      expect(calls).not.toMatch(/gh (pr (comment|edit|close|reopen|update-branch)|workflow run|label create)/);
      expect(calls).not.toMatch(/gh .*--method (POST|PATCH|PUT|DELETE)/);
      expect(calls).not.toMatch(/git .*\b(checkout|reset|add|commit|push|branch)\b|git .*\bmerge\s/);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
