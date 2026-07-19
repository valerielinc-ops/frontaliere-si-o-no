/**
 * Employer acquisition CTA block (issue #4446) — contract tests.
 *
 * Guards the pieces the funnel depends on:
 *   - 4-locale coverage with benefit-first copy (owner rule: never "pay first")
 *   - localized target path mirrors SLUG_TABLES[locale].forEmployers in
 *     services/router.ts, WITH trailing slash (repo rule)
 *   - `data-employer-cta="<surface>"` tracking hook present (consumed by the
 *     employer_cta_view/click listener in services/analytics.ts)
 */
import { describe, it, expect } from 'vitest';
import {
  renderEmployerCtaBlock,
  renderEmployerCtaJobPage,
  FOR_EMPLOYERS_PATH,
  EMPLOYER_CTA_COPY,
} from '../build-plugins/shared/employerCtaBlock';
import { buildPath } from '../services/router';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('employer CTA block', () => {
  it('covers all 4 locales with non-empty benefit-first copy', () => {
    for (const locale of LOCALES) {
      const copy = EMPLOYER_CTA_COPY[locale];
      expect(copy.title.length).toBeGreaterThan(5);
      expect(copy.body.length).toBeGreaterThan(20);
      expect(copy.cta.length).toBeGreaterThan(3);
      // Owner rule: benefit-first — the copy must never lead with payment.
      for (const s of [copy.title, copy.body, copy.cta]) {
        expect(s.toLowerCase()).not.toMatch(/paga|pagare|pay first|prima paghi|zahlen sie zuerst|payez d'abord/);
      }
    }
  });

  it('target paths carry the locale prefix and a trailing slash', () => {
    expect(FOR_EMPLOYERS_PATH.it).toBe('/per-le-aziende/');
    expect(FOR_EMPLOYERS_PATH.en).toBe('/en/for-employers/');
    expect(FOR_EMPLOYERS_PATH.de).toBe('/de/fuer-unternehmen/');
    expect(FOR_EMPLOYERS_PATH.fr).toBe('/fr/pour-les-entreprises/');
    for (const locale of LOCALES) expect(FOR_EMPLOYERS_PATH[locale].endsWith('/')).toBe(true);
  });

  it('target paths never drift from the SPA router (buildPath parity)', () => {
    for (const locale of LOCALES) {
      expect(FOR_EMPLOYERS_PATH[locale]).toBe(buildPath({ activeTab: 'for-employers' }, locale));
    }
  });

  it('card variant renders link + tracking attribute for every locale', () => {
    for (const locale of LOCALES) {
      const html = renderEmployerCtaBlock(locale, 'weekly_employers_city');
      expect(html).toContain(`href="${FOR_EMPLOYERS_PATH[locale]}"`);
      expect(html).toContain('data-employer-cta="weekly_employers_city"');
      expect(html).toContain(EMPLOYER_CTA_COPY[locale].cta);
      expect(html).toContain('class="s-cta"');
    }
  });

  it('job-page variant uses the job template section classes', () => {
    const html = renderEmployerCtaJobPage('it', 'job_page');
    expect(html).toContain('<section class="section"');
    expect(html).toContain('data-employer-cta="job_page"');
    expect(html).toContain('href="/per-le-aziende/"');
  });

  it('falls back to Italian for unknown locales', () => {
    const html = renderEmployerCtaBlock('pt', 'job_page');
    expect(html).toContain('href="/per-le-aziende/"');
    expect(html).toContain(EMPLOYER_CTA_COPY.it.title);
  });
});
