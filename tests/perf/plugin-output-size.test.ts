/**
 * Performance guardrail: ensure build-plugin HTML renderers emit pages well
 * under the 200 KB Lighthouse document budget.
 *
 * Context: Semrush Site Audit (2026-04-24) flagged 6 pages as "slow" — typical
 * root cause for plugin-generated pages is inline JSON/markup bloat. This test
 * calls each pure renderer with realistic inputs and asserts a per-page
 * threshold of 150 KB (50 KB headroom below the hard 200 KB budget enforced
 * by `scripts/audit-page-weight.mjs`).
 */
import { describe, it, expect } from 'vitest';
import {
  renderWeeklyEmployersPage,
  renderCompanyCityPage,
} from '../../build-plugins/weeklyEmployersPlugin';
import {
  buildCurrentWeekPath,
  type WeeklyEmployersCity,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '../../build-plugins/weeklyEmployersData';

// 150 KB — 50 KB headroom under the 200 KB audit-page-weight hard gate.
const MAX_PAGE_BYTES = 150 * 1024;

const TODAY = new Date('2026-04-20T12:00:00Z');

function makeStats(city: WeeklyEmployersCity, companies = 10, roles = 8) {
  return {
    city,
    activeJobsCount: companies * 3,
    topCompanies: Array.from({ length: companies }, (_, i) => ({
      employer: `Company ${i + 1} SA`,
      employerKey: `company-${i + 1}`,
      active: 6 - (i % 5),
      delta: (i % 3) - 1,
    })),
    newcomers: Array.from({ length: 3 }, (_, i) => ({
      employer: `Newcomer ${i + 1} LLC`,
      employerKey: `newcomer-${i + 1}`,
      active: 2,
    })),
    topRoles: Array.from({ length: roles }, (_, i) => ({
      role: `role-${i + 1}`,
      count: 5 - (i % 4),
    })),
  };
}

describe('plugin-output-size (perf guardrail)', () => {
  it.each<WeeklyEmployersLocale>(['it', 'en', 'de', 'fr'])(
    'renderWeeklyEmployersPage stays under 150 KB for locale %s (lugano, realistic payload)',
    (locale) => {
      const city: WeeklyEmployersCity = 'lugano';
      const html = renderWeeklyEmployersPage({
        locale,
        city,
        variant: 'current',
        weekNum: 17,
        year: 2026,
        stats: makeStats(city, 12, 8),
        hasHistoricalDelta: true,
        canonicalPath: buildCurrentWeekPath(locale, city),
        today: TODAY,
        indexable: true,
      });
      const bytes = Buffer.byteLength(html, 'utf8');
      expect(bytes, `${locale}/${city} page weight ${(bytes / 1024).toFixed(1)} KB`).toBeLessThan(
        MAX_PAGE_BYTES,
      );
    },
  );

  it('renderWeeklyEmployersPage stays under 150 KB for ticino regional page (largest variant)', () => {
    const city: WeeklyEmployersCity = 'ticino';
    const html = renderWeeklyEmployersPage({
      locale: 'it',
      city,
      variant: 'current',
      weekNum: 17,
      year: 2026,
      stats: makeStats(city, 20, 12),
      hasHistoricalDelta: true,
      canonicalPath: buildCurrentWeekPath('it', city),
      today: TODAY,
      indexable: true,
    });
    const bytes = Buffer.byteLength(html, 'utf8');
    expect(bytes).toBeLessThan(MAX_PAGE_BYTES);
  });

  it('renderCompanyCityPage stays under 150 KB with 20 active job listings', () => {
    const city: WeeklyEmployersCompanyCity = 'lugano';
    const activeJobs = Array.from({ length: 20 }, (_, i) => ({
      slug: `job-${i + 1}`,
      title: `Sviluppatore Software ${i + 1}`,
      detailPath: `/cerca-lavoro-ticino/job-${i + 1}/`,
      postedDate: new Date(TODAY.getTime() - i * 86_400_000).toISOString().slice(0, 10),
    }));

    const html = renderCompanyCityPage({
      locale: 'it',
      city,
      companySlug: 'acme-sa',
      variant: 'current',
      weekNum: 17,
      year: 2026,
      stats: {
        city,
        companySlug: 'acme-sa',
        employer: 'Acme SA',
        employerKey: 'acme-sa',
        activeJobs,
        activeJobsCount: activeJobs.length,
        delta: 5,
        previousCount: 15,
        topRoles: [
          { role: 'sviluppatore software', count: 8 },
          { role: 'product manager', count: 3 },
        ],
        avgSalary: 85_000,
      },
      hasHistoricalDelta: true,
      canonicalPath: `/aziende-che-assumono/${city}/acme-sa/settimana-corrente/`,
      today: TODAY,
      indexable: true,
      companySiblingCities: [],
    });
    const bytes = Buffer.byteLength(html, 'utf8');
    expect(bytes, `companyCityPage bytes=${(bytes / 1024).toFixed(1)} KB`).toBeLessThan(
      MAX_PAGE_BYTES,
    );
  });
});
