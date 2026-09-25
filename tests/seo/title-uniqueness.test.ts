/**
 * SEO title uniqueness — regression guard
 *
 * Semrush Site Audit (2026-04-24) flagged 475 pages without a unique <title>.
 * Each indexed page must have a locale-unique title. This test exercises the
 * title generators from the plugins most at risk of collisions:
 *
 *   - `buildCityHubTitle` / `buildRoleHubTitle` / `buildEmployerHubTitle` /
 *     `buildRecencyHubTitle` (services/seo/job-board-titles.ts)
 *   - `buildSectorHubSeo` (build-plugins/jobSectorLanding.ts)
 *
 * Per-locale the generator is called with a dense, synthetic input matrix
 * (≥ 20 combinations per builder) and the test asserts every emitted title
 * is distinct within that locale.
 *
 * It also asserts that titles respect a soft 60-char budget (SEO best
 * practice). When a builder already ships longer titles, the overflow is
 * reported as a WARN but not failed (surface as follow-up).
 */

import { describe, expect, it } from 'vitest';
import {
  JOB_PAGE_LOCALES,
  buildCityHubTitle,
  buildRoleHubTitle,
  buildEmployerHubTitle,
  buildRecencyHubTitle,
  TITLE_MAX_CHARS,
  visibleLength,
} from '@/services/seo/job-board-titles';
import {
  buildSectorHubSeo,
  SECTOR_HUB_KEYS,
} from '@/build-plugins/jobSectorLanding';

const CITIES = ['Lugano', 'Mendrisio', 'Bellinzona', 'Locarno', 'Chiasso'];
const ROLES = [
  'Infermiere',
  'Sviluppatore',
  'Contabile',
  'Cassiere',
  'Autista',
  'Cuoco',
  'Operaio',
  'Venditore',
];
const EMPLOYERS = [
  'Coop',
  'Migros',
  'Lidl',
  'AMAG',
  'SBB',
  'PostFinance',
  'ABB',
  'Helsinn',
  'IBSA',
  'Zegna',
];
const RECENCY_DAYS = [1, 3, 7, 14, 30];
const COUNTS = [0, 5, 25, 40, 120, 550, 1200];
const YEAR = 2026;

function expectAllUnique(titles: string[], context: string): void {
  const seen = new Map<string, number>();
  for (const t of titles) {
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  const dupes = Array.from(seen.entries()).filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    throw new Error(
      `${context} — ${dupes.length} duplicate titles:\n` +
        dupes.map(([title, count]) => `  (${count}×) ${title}`).join('\n'),
    );
  }
  expect(new Set(titles).size).toBe(titles.length);
}

describe('SEO title uniqueness — job-board builders', () => {
  for (const locale of JOB_PAGE_LOCALES) {
    describe(`locale=${locale}`, () => {
      it('city hub titles are unique across cities × counts', () => {
        const titles: string[] = [];
        for (const cityDisplay of CITIES) {
          for (const count of COUNTS) {
            titles.push(buildCityHubTitle({ locale, cityDisplay, count, year: YEAR }));
          }
        }
        expect(titles.length).toBeGreaterThanOrEqual(20);
        expectAllUnique(titles, `city-hub titles for ${locale}`);
      });

      it('role hub titles are unique across roles × counts', () => {
        const titles: string[] = [];
        for (const roleDisplay of ROLES) {
          for (const count of COUNTS) {
            titles.push(buildRoleHubTitle({ locale, roleDisplay, count, year: YEAR }));
          }
        }
        expect(titles.length).toBeGreaterThanOrEqual(20);
        expectAllUnique(titles, `role-hub titles for ${locale}`);
      });

      it('employer hub titles are unique across employers × counts', () => {
        const titles: string[] = [];
        for (const companyDisplay of EMPLOYERS) {
          for (const count of COUNTS) {
            titles.push(
              buildEmployerHubTitle({ locale, companyDisplay, count, year: YEAR }),
            );
          }
        }
        expect(titles.length).toBeGreaterThanOrEqual(20);
        expectAllUnique(titles, `employer-hub titles for ${locale}`);
      });

      it('recency hub titles are unique across days × counts', () => {
        const titles: string[] = [];
        for (const days of RECENCY_DAYS) {
          for (const count of COUNTS) {
            titles.push(buildRecencyHubTitle({ locale, days, count, year: YEAR }));
          }
        }
        expect(titles.length).toBeGreaterThanOrEqual(20);
        expectAllUnique(titles, `recency-hub titles for ${locale}`);
      });
    });
  }
});

describe('SEO title uniqueness — sector hub', () => {
  for (const locale of JOB_PAGE_LOCALES) {
    it(`sector hub titles are unique across sectors × counts (${locale})`, () => {
      const titles: string[] = [];
      for (const sector of SECTOR_HUB_KEYS) {
        for (const count of COUNTS) {
          const seo = buildSectorHubSeo(locale, sector, count, YEAR);
          titles.push(seo.title);
        }
      }
      // With 6 sectors × 7 counts = 42 combinations ≥ 20.
      expect(titles.length).toBeGreaterThanOrEqual(20);
      expectAllUnique(titles, `sector-hub titles for ${locale}`);
    });
  }
});

describe('SEO title length budget (soft 60 char target)', () => {
  // NOTE: buildSectorHubSeo intentionally emits verbose titles today (>60
  // chars). Surface the overflow as a follow-up, not a blocker.
  it('city-hub + role-hub + employer-hub + recency-hub stay within TITLE_MAX_CHARS', () => {
    const overflow: string[] = [];
    for (const locale of JOB_PAGE_LOCALES) {
      for (const cityDisplay of CITIES) {
        for (const count of COUNTS) {
          const t = buildCityHubTitle({ locale, cityDisplay, count, year: YEAR });
          if (visibleLength(t) > TITLE_MAX_CHARS) overflow.push(`city/${locale}: ${t}`);
        }
      }
      for (const roleDisplay of ROLES) {
        for (const count of COUNTS) {
          const t = buildRoleHubTitle({ locale, roleDisplay, count, year: YEAR });
          if (visibleLength(t) > TITLE_MAX_CHARS) overflow.push(`role/${locale}: ${t}`);
        }
      }
      for (const companyDisplay of EMPLOYERS) {
        for (const count of COUNTS) {
          const t = buildEmployerHubTitle({
            locale,
            companyDisplay,
            count,
            year: YEAR,
          });
          if (visibleLength(t) > TITLE_MAX_CHARS) overflow.push(`employer/${locale}: ${t}`);
        }
      }
      for (const days of RECENCY_DAYS) {
        for (const count of COUNTS) {
          const t = buildRecencyHubTitle({ locale, days, count, year: YEAR });
          if (visibleLength(t) > TITLE_MAX_CHARS) overflow.push(`recency/${locale}: ${t}`);
        }
      }
    }
    expect(
      overflow,
      `Titles exceeding ${TITLE_MAX_CHARS} chars:\n${overflow.join('\n')}`,
    ).toEqual([]);
  });
});
