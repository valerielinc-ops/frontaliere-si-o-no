import { describe, expect, it } from 'vitest';
import {
  CRAWL_EVENTS_REFRESH_BRANCH,
  CRAWL_EVENTS_REFRESH_TITLE,
  selectCrawlEventsRefreshBranch,
} from '../scripts/ci/select-crawl-events-refresh-branch.mjs';

const repository = 'valerielinc-ops/frontaliere-si-o-no';

function pr(number: number, headRefName: string, state: string, createdAt: string, mergedAt: string | null = null) {
  return {
    number,
    title: CRAWL_EVENTS_REFRESH_TITLE,
    headRefName,
    headRepository: { nameWithOwner: repository },
    state,
    createdAt,
    mergedAt,
  };
}

describe('crawl events refresh branch selection', () => {
  it('continues the newest open refresh PR branch', () => {
    expect(selectCrawlEventsRefreshBranch({
      repository,
      runId: '500',
      runAttempt: '2',
      pullRequests: [
        pr(12456, CRAWL_EVENTS_REFRESH_BRANCH, 'CLOSED', '2026-10-08T10:00:00Z'),
        pr(12601, 'chore/crawl-events-refresh-499-1', 'OPEN', '2026-10-09T10:00:00Z'),
      ],
    })).toEqual({
      branch: 'chore/crawl-events-refresh-499-1',
      requireNewBranch: false,
      requireExistingBranch: true,
      reason: 'continuing open PR #12601',
    });
  });

  it('starts a unique branch after the latest refresh PR closed or merged', () => {
    for (const latest of [
      pr(12601, CRAWL_EVENTS_REFRESH_BRANCH, 'CLOSED', '2026-10-09T10:00:00Z'),
      pr(12601, CRAWL_EVENTS_REFRESH_BRANCH, 'CLOSED', '2026-10-09T10:00:00Z', '2026-10-09T11:00:00Z'),
    ]) {
      expect(selectCrawlEventsRefreshBranch({
        repository,
        runId: '500',
        runAttempt: '2',
        pullRequests: [pr(12456, CRAWL_EVENTS_REFRESH_BRANCH, 'OPEN', '2026-10-08T10:00:00Z'), latest],
      })).toMatchObject({
        branch: 'chore/crawl-events-refresh-500-2',
        requireNewBranch: true,
        requireExistingBranch: false,
      });
    }
  });

  it('uses the canonical first-run branch and ignores unrelated or fork PRs', () => {
    expect(selectCrawlEventsRefreshBranch({ repository, runId: '500', pullRequests: [] })).toMatchObject({
      branch: CRAWL_EVENTS_REFRESH_BRANCH,
      requireNewBranch: false,
    });
    expect(selectCrawlEventsRefreshBranch({
      repository,
      runId: '500',
      pullRequests: [
        { ...pr(12601, CRAWL_EVENTS_REFRESH_BRANCH, 'OPEN', '2026-10-09T10:00:00Z'), title: 'other refresh' },
        { ...pr(12602, CRAWL_EVENTS_REFRESH_BRANCH, 'OPEN', '2026-10-10T10:00:00Z'), headRepository: { nameWithOwner: 'fork/other' } },
      ],
    })).toMatchObject({ branch: CRAWL_EVENTS_REFRESH_BRANCH, requireNewBranch: false });
  });
});
