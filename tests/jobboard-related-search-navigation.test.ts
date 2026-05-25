import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('JobBoard company link navigation', () => {
  it('routes company links through the SPA callback from job detail instead of reparsing staticOverlay URLs', () => {
    const source = readFileSync(join(process.cwd(), 'components/community/JobBoard.tsx'), 'utf8');
    const helperBody = source.match(/const openCompanyFilter = \(e: React\.MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];

    expect(helperBody).toContain('onJobRouteChange(companySearchSlug)');
    expect(helperBody).toContain("window.history.pushState({ route: { activeTab: 'job-board', jobSlug: companySearchSlug } }, '', companySearchHref.split('?')[0]);");
    expect(source.match(/onClick=\{openCompanyFilter\}/g)).toHaveLength(2);
  });
});
