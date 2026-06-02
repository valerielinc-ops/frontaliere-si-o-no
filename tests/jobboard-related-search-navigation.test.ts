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
    const gateHelperBody = source.match(/const openGateCompanyFilter = \(e: React\.MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];

    // Company links route nationally (aggregator board), not the current canton,
    // so an employer with no jobs in the active canton doesn't yield an empty page.
    expect(helperBody).toContain('onJobRouteChange(companySearchSlug, JOB_BOARD_CANTON_AGGREGATE)');
    expect(helperBody).toContain("window.history.pushState({ route: { activeTab: 'job-board', jobBoardCanton: JOB_BOARD_CANTON_AGGREGATE, jobSlug: companySearchSlug } }, '', companySearchHref.split('?')[0]);");
    expect(gateHelperBody).toContain('onJobRouteChange(gateCompanySlug, JOB_BOARD_CANTON_AGGREGATE)');
    expect(gateHelperBody).toContain("window.history.pushState({ route: { activeTab: 'job-board', jobBoardCanton: JOB_BOARD_CANTON_AGGREGATE, jobSlug: gateCompanySlug } }, '', gateCompanyHref.split('?')[0]);");
    expect(source.match(/onClickCapture=\{openCompanyFilter\}/g)).toHaveLength(2);
    expect(source.match(/onClickCapture=\{openGateCompanyFilter\}/g)).toHaveLength(2);
  });

  it('uses the same capture-phase company routing on expired and orphan job views', () => {
    const expiredSource = readFileSync(join(process.cwd(), 'components/community/JobExpiredView.tsx'), 'utf8');
    const orphanSource = readFileSync(join(process.cwd(), 'components/community/JobOrphanView.tsx'), 'utf8');

    for (const source of [expiredSource, orphanSource]) {
      const helperBody = source.match(/const handleCompanyClick = \(e: MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];
      expect(helperBody).toContain('e.nativeEvent.stopImmediatePropagation?.()');
      expect(helperBody).toContain('window.history.pushState');
      expect(source.match(/onClickCapture=\{handleCompanyClick\}/g)).toHaveLength(2);
    }
  });
});
