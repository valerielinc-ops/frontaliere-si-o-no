import { describe, it, expect } from 'vitest';
import {
  GRISCHAPERSONAL_KEY,
  GRISCHAPERSONAL_COMPANY_NAME,
  isGrischapersonalJob,
  isTrustedDomain,
  grischapersonalPublicUrl,
  grischapersonalMatchKey,
} from '../scripts/lib/grischapersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { extractJsonLd } from '../scripts/lib/prospector/extract.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';
import { checkSourceDetailsBatch, sourceDetailSamplesForCrawler } from '../scripts/audit-parser-quality.mjs';

describe('Grischa Personal AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GRISCHAPERSONAL_KEY).toBe('grischapersonal');
    expect(GRISCHAPERSONAL_COMPANY_NAME).toBe('Grischa Personal AG');
  });

  // ── isCompanyJob ──
  describe('isGrischapersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isGrischapersonalJob({ companyKey: 'grischapersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGrischapersonalJob({ company: 'Grischa Personal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGrischapersonalJob({ url: 'https://grischapersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGrischapersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGrischapersonalJob(null)).toBe(false);
      expect(isGrischapersonalJob(undefined)).toBe(false);
      expect(isGrischapersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://grischapersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.grischapersonal.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer grischapersonal ch')).toBe('developer-grischapersonal-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'grischapersonal-abc123',
      slug: 'test-position-grischapersonal-ch',
      slugByLocale: { de: 'test-position-grischapersonal-ch' },
      company: 'Grischa Personal AG',
      companyKey: 'grischapersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://grischapersonal.ch/jobs/test',
      source: 'Grischa Personal AG Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^grischapersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// ── The published URL leads to the posting (issue 5253, run 36571839273) ──
// /stellen/ lists every vacancy as a table row: an inline JobPosting without
// `url`, then the title in an <h1>. No element id per vacancy, so the
// `#job-<digest>` identity named nothing on the page.
describe('grischapersonalPublicUrl', () => {
  const PAGE = 'https://grischapersonal.ch/stellen/';
  const body = (what: string) => `Für unseren Kunden suchen wir per sofort eine/n engagierte/n ${what}. Aufgaben: Planung, Ausführung und Dokumentation der Arbeiten auf der Baustelle, Koordination mit Bauleitung und Kunden. Profil: abgeschlossene Ausbildung, Berufserfahrung, selbständige und zuverlässige Arbeitsweise.`;
  const posting = (title: string) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title, description: body(title), jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Graubünden', addressCountry: 'CH' } } })}</script>
<tr><td class="job-description"><h1>${title}</h1><div class="mini-job-infos">Ort: Graubünden</div><div class="accordion-body"><p>${body(title)}</p></div></td><td class="contact-column"><h2>Kontakt</h2></td></tr>`;
  const html = `<html><head><link rel="canonical" href="${PAGE}" /></head><body><table id="job-offers"><tbody>${posting('CAD-ZEICHNER (m/w/d)')}${posting('METALLBAUMONTEUR (m/w/d)')}</tbody></table></body></html>`;
  const listings = extractJsonLd(html, PAGE);

  it('keeps the listing digest as identity and adds the text fragment of the title', () => {
    expect(listings.map((listing) => listing.url)).toEqual([expect.stringMatching(/#job-[0-9a-f]{12}$/), expect.stringMatching(/#job-[0-9a-f]{12}$/)]);
    const digest = listings[0].url.split('#job-')[1];
    expect(grischapersonalPublicUrl(listings[0], listings[0].title))
      .toBe(`${PAGE}?jobid=${digest}#:~:text=CAD%2DZEICHNER%20(m%2Fw%2Fd)`);
  });

  it('gives every posting its own identity in the URL-keyed layers', () => {
    const jobs = listings.map((listing) => ({ url: grischapersonalPublicUrl(listing, listing.title), title: listing.title, company: 'Grischa Personal AG' }));
    const fps = jobs.map((job) => fingerprintJob(job));
    expect(new Set(fps).size).toBe(2);
    for (const fp of fps) expect(fp).toMatch(/^id\|grischapersonal\.ch\|[0-9a-f]{12}$/);
  });

  it('merges a stored #job-<digest> record with the same posting under its new URL (id match)', () => {
    expect(grischapersonalMatchKey({ id: 'grischapersonal-7320dd4cedf4', url: `${PAGE}#job-a49cb87c8254` }))
      .toBe(grischapersonalMatchKey({ id: 'grischapersonal-7320dd4cedf4', url: grischapersonalPublicUrl(listings[0], listings[0].title) }));
  });

  it('lets the parser-quality audit read each row as its posting, with a URL that leads there', async () => {
    const jobs = listings.map((listing) => ({ url: grischapersonalPublicUrl(listing, listing.title), title: listing.title, location: 'Chur', sourceLang: 'de', description: body(listing.title) }));
    const results = await checkSourceDetailsBatch(sourceDetailSamplesForCrawler('grischapersonal', jobs), 1, {
      fetchPage: async (url: string) => ({ ok: true, status: 200, url: url.split('#')[0], body: html, host: 'grischapersonal.ch' }),
    });
    for (const result of results) {
      expect(result).toMatchObject({ sourceScope: 'fragment-anchor', sharedBy: 'query', descriptionMismatch: false });
      expect(result.urlAddressesPosting).toBeUndefined();
    }
  });
});
