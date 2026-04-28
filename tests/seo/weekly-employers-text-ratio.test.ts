/**
 * Regression test for the "low text-to-HTML ratio" gate on weekly-employers
 * company × city pages.
 *
 * Why this exists
 * ---------------
 * The Apr 2026 Semrush audit flagged 82 weekly-employers pages with
 * `visibleText / totalHTML ≤ 10 %` — Google's threshold for "low
 * text/HTML ratio". The fix was to extend the `companyCityFrontalier`
 * paragraphs, add a `companyCityMethodology` section, and add two
 * frontaliere-specific FAQ entries (telework + title equivalence) to the
 * page template in `build-plugins/weeklyEmployersPlugin.ts`.
 *
 * This test renders a representative low-volume company × city page (the
 * worst-case shape: small `activeJobs.length`, no historical delta) and
 * asserts the visible-text-to-HTML ratio sits comfortably above the 10 %
 * threshold so a single regression in the template won't quietly tank
 * dozens of pages back below the gate.
 *
 * The visible-text extraction mirrors `scripts/audit-text-html-ratio.mjs`
 * exactly so this test catches the same regression the CI gate would.
 */
import { describe, it, expect } from 'vitest';
import {
  renderCompanyCityPage,
  type CompanyCityPageInputs,
} from '@/build-plugins/weeklyEmployersPlugin';
import type {
  CompanyCityStats,
  CompanyCityActiveJob,
} from '@/build-plugins/weeklyEmployersPlugin';

/** Mirrors `scripts/audit-text-html-ratio.mjs::extractVisibleText`. */
function extractVisibleText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function ratioPct(html: string): number {
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const text = extractVisibleText(html);
  const textBytes = Buffer.byteLength(text, 'utf8');
  return (textBytes / htmlBytes) * 100;
}

function buildLowVolumeFixture(): CompanyCityPageInputs {
  // The worst-case shape from the Apr 2026 audit: a single active job,
  // no historical delta. These pages had the smallest visible-text body
  // relative to the SPA-shell HTML, so they are the canonical regression
  // target.
  const activeJobs: CompanyCityActiveJob[] = [
    {
      slug: 'developer-fullstack',
      title: 'Developer Full-Stack',
      detailPath: '/cerca-lavoro-ticino/developer-fullstack-acme-lugano/',
      postedDate: '2026-04-21',
      employmentType: 'FULL_TIME',
      salaryMin: 90000,
      salaryMax: 110000,
      salaryCurrency: 'CHF',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      description:
        'Sviluppo applicazioni web full-stack su React + Node.js. Esperienza 3-5 anni richiesta.',
    },
  ];

  const stats: CompanyCityStats = {
    city: 'lugano',
    companySlug: 'acme-corporation',
    employer: 'Acme Corporation',
    employerKey: 'acme-corporation',
    activeJobs,
    activeJobsCount: activeJobs.length,
    delta: 0,
    previousCount: 0,
    topRoles: [{ role: 'developer', count: 1 }],
    avgSalary: 100000,
  };

  return {
    locale: 'it',
    city: 'lugano',
    companySlug: 'acme-corporation',
    variant: 'current',
    weekNum: 17,
    year: 2026,
    stats,
    hasHistoricalDelta: false,
    canonicalPath: '/aziende-che-assumono/lugano/acme-corporation/settimana-corrente/',
    today: new Date('2026-04-28T07:00:00.000Z'),
    indexable: true,
    knownSlugs: new Set<string>(),
  };
}

describe('weekly-employers company × city — text-to-HTML ratio', () => {
  it('low-volume company×city page clears the Semrush 10 % threshold with margin', () => {
    const html = renderCompanyCityPage(buildLowVolumeFixture());
    const pct = ratioPct(html);

    // The Semrush "low text/HTML ratio" threshold is 10 %. We assert the
    // rendered page sits at least 2 points above it (≥12 %) so a future
    // template change can wobble the ratio without instantly dropping the
    // worst-case page below the gate. The Apr 2026 audit measured these
    // pages at 7-9 % before the methodology + extra-FAQ additions.
    expect(pct).toBeGreaterThan(12);
  });

  it('all 4 locales clear the threshold for a typical 3-job page', () => {
    const base = buildLowVolumeFixture();
    base.stats = {
      ...base.stats,
      activeJobs: [
        ...base.stats.activeJobs,
        {
          slug: 'product-manager',
          title: 'Product Manager',
          detailPath: '/cerca-lavoro-ticino/product-manager-acme-lugano/',
          postedDate: '2026-04-22',
          employmentType: 'FULL_TIME',
          addressLocality: 'Lugano',
          addressRegion: 'TI',
        },
        {
          slug: 'qa-engineer',
          title: 'QA Engineer',
          detailPath: '/cerca-lavoro-ticino/qa-engineer-acme-lugano/',
          postedDate: '2026-04-23',
          employmentType: 'FULL_TIME',
          addressLocality: 'Lugano',
          addressRegion: 'TI',
        },
      ],
      activeJobsCount: 3,
      delta: 1,
    };
    base.hasHistoricalDelta = true;

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const localized: CompanyCityPageInputs = { ...base, locale };
      const html = renderCompanyCityPage(localized);
      const pct = ratioPct(html);
      expect(pct, `${locale} ratio ${pct.toFixed(2)}%`).toBeGreaterThan(12);
    }
  });
});
