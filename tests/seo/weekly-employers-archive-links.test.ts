/**
 * Regression test for the BFS-depth fix on `sitemap-weekly-employers.xml`.
 *
 * Background: post-deploy run 25415108203 (May 6 2026) failed
 * `audit:max-bfs-depth` with 151 vs baseline 148 URLs at depth > 4 — every
 * newly-rolled `settimana-NN-YYYY/<city>/` page emitted by the cron-driven
 * `snapshot-jobs-weekly.yml` was unreachable in ≤4 hops from `/`. Reason:
 * the city hub page (current-week and archive variants) only linked to the
 * per-employer leaves and other city hubs; archive weeks were never listed.
 *
 * The fix: every city hub now renders a flat `<a>` per past archive week
 * via `renderWeeklyArchiveListBlock`, so each `settimana-NN-YYYY` page is
 * reachable from the city hub at depth ≤ 3 from `/` (via top hub → city
 * hub → archive). This test guards the invariant by asserting the rendered
 * HTML for both variants contains the expected archive anchors.
 */
import { describe, it, expect } from 'vitest';
import {
  renderWeeklyEmployersPage,
  type CityWeeklyStats,
  type WeeklyEmployersPageInputs,
} from '@/build-plugins/weeklyEmployersPlugin';

function buildStats(): CityWeeklyStats {
  return {
    city: 'lugano',
    activeJobsCount: 5,
    topCompanies: [
      { employer: 'Acme Corp', employerKey: 'acme-corp', active: 3, delta: 1 },
    ],
    newcomers: [],
    topRoles: [{ role: 'developer', count: 2 }],
  };
}

function baseInputs(
  variant: 'current' | 'archive',
  weekNum: number,
  year: number,
): WeeklyEmployersPageInputs {
  return {
    locale: 'it',
    city: 'lugano',
    variant,
    weekNum,
    year,
    stats: buildStats(),
    hasHistoricalDelta: true,
    canonicalPath:
      variant === 'current'
        ? '/aziende-che-assumono/lugano/settimana-corrente/'
        : `/aziende-che-assumono/lugano/settimana-${String(weekNum).padStart(2, '0')}-${year}/`,
    today: new Date('2026-05-06T08:00:00Z'),
    indexable: true,
    knownSlugs: new Set<string>(),
  };
}

describe('weekly-employers — archive list block keeps BFS depth ≤ 3', () => {
  const archives = [
    { weekNum: 17, year: 2026 },
    { weekNum: 16, year: 2026 },
    { weekNum: 15, year: 2026 },
  ];

  it('current-week city hub links every available archive week', () => {
    const html = renderWeeklyEmployersPage({
      ...baseInputs('current', 18, 2026),
      availableArchives: archives,
    });
    for (const a of archives) {
      const slug = `settimana-${String(a.weekNum).padStart(2, '0')}-${a.year}`;
      expect(
        html,
        `current-week page must <a href> the ${slug} archive`,
      ).toContain(`/aziende-che-assumono/lugano/${slug}/`);
    }
  });

  it('archive page links every other archive but not itself', () => {
    const html = renderWeeklyEmployersPage({
      ...baseInputs('archive', 16, 2026),
      availableArchives: archives,
    });
    // Extract only the archive-list block so self-link checks ignore
    // canonical/og:url/breadcrumb/hreflang occurrences of the page's own URL.
    const blockMatch = html.match(
      /<section[^>]*aria-labelledby="weArchives"[\s\S]*?<\/section>/,
    );
    expect(blockMatch, 'archive list section must be rendered').not.toBeNull();
    const block = blockMatch![0];
    expect(block).toContain('/aziende-che-assumono/lugano/settimana-17-2026/');
    expect(block).toContain('/aziende-che-assumono/lugano/settimana-15-2026/');
    // Self-link suppression: an archive must not link to itself from the
    // archive-list block (the canonical <link rel> elsewhere in <head> is fine).
    expect(
      block,
      'archive list must not contain a link to its own week',
    ).not.toContain('/aziende-che-assumono/lugano/settimana-16-2026/');
  });

  it('omitting availableArchives produces no archive list block', () => {
    const html = renderWeeklyEmployersPage(baseInputs('current', 18, 2026));
    expect(html).not.toContain('id="weArchives"');
  });
});
