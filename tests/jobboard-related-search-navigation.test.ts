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
  it('full-navigates company links to the static company hub instead of SPA re-filtering', () => {
    const source = readFileSync(join(process.cwd(), 'components/community/JobBoard.tsx'), 'utf8');
    const helperBody = source.match(/const openCompanyFilter = \(e: React\.MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];
    const gateHelperBody = source.match(/const openGateCompanyFilter = \(e: React\.MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];

    // The href must stay on the static-backed canton hub (HTTP 200, lists the
    // company's jobs across all cantons), NOT the aggregator board
    // (/cerca-lavoro-svizzera/azienda-X/ is a 404 — no static page emitted).
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'azienda-pwc-switzerland' }, 'it'))
      .toBe('/cerca-lavoro-ticino/azienda-pwc-switzerland/');

    // Company links full-navigate to that static hub. An SPA re-filter scoped to
    // the current canton shard would clobber the static list with an empty result
    // (the cross-canton "0 results" bug, e.g. PwC: 109 static jobs vs 0 in TI).
    expect(helperBody).toContain("window.location.assign(companySearchHref.split('?')[0]);");
    expect(helperBody).not.toContain('onJobRouteChange(companySearchSlug)');
    expect(gateHelperBody).toContain("window.location.assign(gateCompanyHref.split('?')[0]);");
    expect(gateHelperBody).not.toContain('onJobRouteChange(gateCompanySlug)');
    expect(source.match(/onClickCapture=\{openCompanyFilter\}/g)).toHaveLength(2);
    expect(source.match(/onClickCapture=\{openGateCompanyFilter\}/g)).toHaveLength(2);
  });

  it('full-navigates company links on expired and orphan job views', () => {
    const expiredSource = readFileSync(join(process.cwd(), 'components/community/JobExpiredView.tsx'), 'utf8');
    const orphanSource = readFileSync(join(process.cwd(), 'components/community/JobOrphanView.tsx'), 'utf8');

    for (const source of [expiredSource, orphanSource]) {
      const helperBody = source.match(/const handleCompanyClick = \(e: MouseEvent<HTMLAnchorElement>\) => \{[\s\S]*?\n \};/)?.[0];
      expect(helperBody).toContain('e.nativeEvent.stopImmediatePropagation?.()');
      expect(helperBody).toContain('window.location.assign');
      expect(helperBody).not.toContain('window.history.pushState');
      expect(source.match(/onClickCapture=\{handleCompanyClick\}/g)).toHaveLength(2);
    }
  });
});
