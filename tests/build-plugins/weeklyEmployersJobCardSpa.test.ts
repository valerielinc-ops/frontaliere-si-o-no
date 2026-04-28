/**
 * Verify that the per-employer "open jobs" listing on F5 weekly-employers
 * company×city pages renders via the shared SPA-matching `renderJobCardHtml`.
 *
 * The shared renderer emits an `<article>` with the SPA-canonical Tailwind
 * classes (`rounded-xl border p-3 sm:p-4 …`). The test asserts that at
 * least one of the listed jobs carries that signature, and that the
 * surrounding numbered `<ol>` ranking wrapper is preserved.
 *
 * Owner: Agent B — shared job-card refactor (Apr 28).
 */

import { describe, expect, it } from 'vitest';
import {
  renderCompanyCityPage,
  type CompanyCityPageInputs,
} from '../../build-plugins/weeklyEmployersPlugin';
import type { WeeklyEmployersCompanyCity } from '../../build-plugins/weeklyEmployersData';

const fixture: CompanyCityPageInputs = {
  locale: 'it',
  city: 'lugano' as WeeklyEmployersCompanyCity,
  companySlug: 'eoc-ente-ospedaliero-cantonale',
  variant: 'current',
  weekNum: 17,
  year: 2026,
  stats: {
    city: 'lugano' as WeeklyEmployersCompanyCity,
    companySlug: 'eoc-ente-ospedaliero-cantonale',
    employer: 'EOC - Ente Ospedaliero Cantonale',
    employerKey: 'eoc-ente-ospedaliero-cantonale',
    activeJobs: [
      {
        slug: 'infermiere-eoc-lugano-0',
        title: 'Infermiere specialista reparto cardiologia',
        detailPath: '/cerca-lavoro-ticino/infermiere-eoc-lugano-0/',
        postedDate: '2026-04-25',
        employmentType: 'FULL_TIME',
        salaryMin: 70000,
        salaryMax: 90000,
        salaryCurrency: 'CHF',
        addressLocality: 'Lugano',
        addressRegion: 'TI',
      },
      {
        slug: 'tecnico-radiologia-eoc-lugano',
        title: 'Tecnico radiologia medica',
        detailPath: '/cerca-lavoro-ticino/tecnico-radiologia-eoc-lugano/',
        postedDate: '2026-04-22',
        employmentType: 'PART_TIME',
        addressLocality: 'Lugano',
        addressRegion: 'TI',
      },
      {
        slug: 'assistente-sociale-eoc-lugano',
        title: 'Assistente sociale ospedaliero',
        detailPath: '/cerca-lavoro-ticino/assistente-sociale-eoc-lugano/',
        postedDate: '2026-04-20',
        addressLocality: 'Lugano',
        addressRegion: 'TI',
      },
    ],
    activeJobsCount: 3,
    delta: 1,
    previousCount: 2,
    topRoles: [
      { role: 'infermiere specialista reparto', count: 1 },
      { role: 'tecnico radiologia medica', count: 1 },
    ],
    avgSalary: 80000,
  },
  hasHistoricalDelta: true,
  canonicalPath:
    '/aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
  today: new Date('2026-04-28T12:00:00Z'),
  indexable: true,
};

describe('weeklyEmployersPlugin — SPA job-card migration', () => {
  it('emits the SPA-canonical job-card <article> for at least one open job', () => {
    const html = renderCompanyCityPage(fixture);
    // The shared renderer's signature class block (must appear at least once
    // for the per-employer open-jobs list).
    expect(html).toContain('<article class="rounded-xl border p-3 sm:p-4');
  });

  it('renders one SPA card per active job', () => {
    const html = renderCompanyCityPage(fixture);
    const matches = html.match(/<article class="rounded-xl border p-3 sm:p-4/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(fixture.stats.activeJobs.length);
  });

  it('preserves the numbered <ol> ranking wrapper around the cards', () => {
    const html = renderCompanyCityPage(fixture);
    expect(html).toMatch(/<ol[^>]*>[\s\S]*<article class="rounded-xl border p-3 sm:p-4/);
  });

  it('keeps each job linked to its canonical detail path', () => {
    const html = renderCompanyCityPage(fixture);
    for (const job of fixture.stats.activeJobs) {
      expect(html).toContain(`href="${job.detailPath}"`);
    }
  });

  it('translates Schema.org employmentType (FULL_TIME / PART_TIME) into SPA contract chips', () => {
    const html = renderCompanyCityPage(fixture);
    // SPA card uses locale-specific contract labels — IT: "Tempo pieno" / "Part-time".
    expect(html).toContain('Tempo pieno');
    expect(html).toContain('Part-time');
  });

  it('renders salary chip via the shared formatter when salaryMin/Max are present', () => {
    const html = renderCompanyCityPage(fixture);
    // Shared renderer formats as "CHF 70k – 90k".
    expect(html).toMatch(/CHF\s+70k\s+–\s+90k/);
  });
});
