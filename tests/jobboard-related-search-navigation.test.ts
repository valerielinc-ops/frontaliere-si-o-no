import { describe, expect, it } from 'vitest';

import { buildSearchSlug, shouldRestoreJobBoardListState } from '@/components/community/JobBoard.tsx';
import { buildPath } from '@/services/router';

describe('JobBoard related search navigation', () => {
  it('builds crawlable related-search hrefs with localized job-board routes', () => {
    expect(
      buildPath({ activeTab: 'job-board', jobSlug: buildSearchSlug('HR specialist', 'it') }, 'it'),
    ).toBe('/cerca-lavoro-ticino/ricerca-hr-specialist/');

    expect(
      buildPath({ activeTab: 'job-board', jobSlug: buildSearchSlug('HR specialist', 'en') }, 'en'),
    ).toBe('/en/find-jobs-ticino/search-hr-specialist/');
  });

  it('restores list scroll only when returning to the plain job-board list', () => {
    expect(
      shouldRestoreJobBoardListState('software-engineer-board-international-chiasso-ticino', undefined),
    ).toBe(true);

    expect(
      shouldRestoreJobBoardListState('software-engineer-board-international-chiasso-ticino', 'ricerca-hr-specialist'),
    ).toBe(false);

    expect(
      shouldRestoreJobBoardListState('software-engineer-board-international-chiasso-ticino', 'azienda-boggi-milano'),
    ).toBe(false);
  });
});
