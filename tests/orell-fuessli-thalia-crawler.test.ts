import { describe, it, expect } from 'vitest';
import {
  ORELL_FUESSLI_THALIA_KEY,
  ORELL_FUESSLI_THALIA_COMPANY_NAME,
  isOrellFuessliThaliaJob,
  isTrustedDomain,
  detectCategory,
  detectExperienceLevel,
  detectEmploymentType,
  resolveAddress,
  extractJobPostingJsonLd,
  extractDescriptionHtml,
} from '../scripts/lib/orell-fuessli-thalia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Orell Füssli Thalia crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ORELL_FUESSLI_THALIA_KEY).toBe('orell-fuessli-thalia');
    expect(ORELL_FUESSLI_THALIA_COMPANY_NAME).toBe('Orell Füssli Thalia');
  });

  // ── isCompanyJob ──
  describe('isOrellFuessliThaliaJob', () => {
    it('matches by companyKey', () => {
      expect(isOrellFuessliThaliaJob({ companyKey: 'orell-fuessli-thalia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOrellFuessliThaliaJob({ company: 'Orell Füssli Thalia' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOrellFuessliThaliaJob({ url: 'https://karriere.orellfuessli.ch/de/offene-stellen/filialleitung-80' })).toBe(true);
    });

    it('matches by bare orellfuessli.ch domain', () => {
      expect(isOrellFuessliThaliaJob({ url: 'https://www.orellfuessli.ch/unternehmen/karriere-jobs' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOrellFuessliThaliaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOrellFuessliThaliaJob(null)).toBe(false);
      expect(isOrellFuessliThaliaJob(undefined)).toBe(false);
      expect(isOrellFuessliThaliaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://orellfuessli.ch/jobs')).toBe(true);
    });

    it('trusts the karriere subdomain', () => {
      expect(isTrustedDomain('https://karriere.orellfuessli.ch/de/offene-stellen/buchhaendlerin-80')).toBe(true);
    });

    it('trusts the leaked SAP SuccessFactors apply tenant (company=OFThalia)', () => {
      expect(
        isTrustedDomain('https://career74.sapsf.eu/careers?company=OFThalia&career_job_req_id=789&career_ns=job_application&lang=de_DE'),
      ).toBe(true);
    });

    it('rejects an unrelated SuccessFactors tenant', () => {
      expect(
        isTrustedDomain('https://career74.sapsf.eu/careers?company=SomeoneElse&career_job_req_id=1'),
      ).toBe(false);
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
      const slug = slugify('Filialleitung 80% (a)');
      expect(slug).toBe('filialleitung-80-a');
    });

    it('strips diacritics', () => {
      expect(slugify('Buchhändler*in 80% (a)')).toBe('buchhandler-in-80-a');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── detectEmploymentType (Swiss retail work-percentage convention,
  // mirrors scripts/lib/denner-job-parser.mjs's inferEmploymentType) ──
  describe('detectEmploymentType', () => {
    it('classifies a single percentage >= 80 as FULL_TIME', () => {
      expect(detectEmploymentType('Filialleitung 80% (a)')).toBe('FULL_TIME');
      expect(detectEmploymentType('Filialleitung 100% (a)')).toBe('FULL_TIME');
    });

    it('classifies a single percentage < 80 as PART_TIME', () => {
      expect(detectEmploymentType('Buchhändler*in 40% (a)')).toBe('PART_TIME');
      expect(detectEmploymentType('Buchhändler*in 70% (a)')).toBe('PART_TIME');
    });

    it('classifies a percentage range by its maximum', () => {
      expect(detectEmploymentType('Mitarbeiter/in Logistik 40 - 50% (a)')).toBe('PART_TIME');
      expect(detectEmploymentType('Abteilungsleitung 90-100% (a)')).toBe('FULL_TIME');
      expect(detectEmploymentType('Filialleitung 80 - 90% (a)')).toBe('FULL_TIME');
    });

    it('classifies apprenticeship titles as INTERN regardless of percentage', () => {
      expect(detectEmploymentType('Lernende*r Buchhandel EFZ')).toBe('INTERN');
    });

    it('defaults to FULL_TIME when no percentage or keyword is present', () => {
      expect(detectEmploymentType('Mitarbeiter/in Kundenservice')).toBe('FULL_TIME');
    });
  });

  // ── detectCategory / detectExperienceLevel ──
  describe('detectCategory', () => {
    it('classifies management roles', () => {
      expect(detectCategory('Filialleitung 80% (a)')).toBe('Management');
      expect(detectCategory('Abteilungsleitung 100% (a)')).toBe('Management');
    });

    it('classifies IT roles', () => {
      expect(detectCategory('ICT Supporter*in / Systemadministrator*in 80-100% (a)')).toBe('IT');
    });

    it('classifies logistics roles', () => {
      expect(detectCategory('Mitarbeiter/in Logistik Assistenz Filialleitung 40-50% (a)')).toBe('Logistica');
    });

    it('classifies apprenticeships', () => {
      expect(detectCategory('Lernende*r Buchhandel EFZ')).toBe('Apprendistato');
    });

    it('classifies bookseller/retail roles', () => {
      expect(detectCategory('Buchhändler*in 80% (a)')).toBe('Vendita');
    });

    it('falls back to Retail for unrecognized titles', () => {
      expect(detectCategory('Something Unrelated')).toBe('Retail');
    });
  });

  describe('detectExperienceLevel', () => {
    it('classifies apprenticeships as intern', () => {
      expect(detectExperienceLevel('Lernende*r Buchhandel EFZ')).toBe('intern');
    });

    it('classifies management titles as senior', () => {
      expect(detectExperienceLevel('Filialleitung 80% (a)')).toBe('senior');
      expect(detectExperienceLevel('Stv. Filialleitung 80-100% (a)')).toBe('senior');
    });

    it('defaults to mid for regular roles', () => {
      expect(detectExperienceLevel('Buchhändler*in 80% (a)')).toBe('mid');
    });
  });

  // ── resolveAddress: city-gated HQ fallback (Non-Negotiable / known
  // recurring bug class — NEVER gate on canton alone). Zürich is the real
  // HQ; Uster is the SAME canton (ZH) but a DIFFERENT city and must not
  // silently inherit the Dietzingerstrasse 3 / 8003 HQ address. ──
  describe('resolveAddress (city-gated, not canton-only)', () => {
    it('backfills HQ street/postal when the city is the HQ city (Zürich)', () => {
      const result = resolveAddress('Zürich');
      expect(result.city).toBe('Zürich');
      expect(result.postalCode).toBe('8003');
      expect(result.streetAddress).toBe('Dietzingerstrasse 3');
    });

    it('backfills HQ address when no city is given at all', () => {
      const result = resolveAddress('');
      expect(result.city).toBe('Zürich');
      expect(result.postalCode).toBe('8003');
      expect(result.streetAddress).toBe('Dietzingerstrasse 3');
    });

    it('does NOT backfill HQ street/postal for a same-canton (ZH) but different city', () => {
      // Uster is canton ZH, same as the Zürich HQ — a canton-only gate
      // would wrongly backfill the HQ street address here; a city-text gate
      // (correct) must not.
      const result = resolveAddress('Uster');
      expect(result.city).toBe('Uster');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });

    it('does NOT backfill HQ street/postal for an out-of-canton Swiss city', () => {
      const result = resolveAddress('Luzern');
      expect(result.city).toBe('Luzern');
      expect(result.postalCode).toBe('');
      expect(result.streetAddress).toBe('');
    });

    it('is case-insensitive on the HQ city match', () => {
      const result = resolveAddress('zürich');
      expect(result.postalCode).toBe('8003');
    });
  });

  // ── JSON-LD extraction ──
  describe('extractJobPostingJsonLd', () => {
    it('extracts a JobPosting node nested inside @graph', () => {
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'JobPosting',
            title: 'Filialleitung 80% (a)',
            datePosted: '2026-06-24T02:00:00+0200',
            hiringOrganization: { '@type': 'Organization', name: 'Orell Füssli' },
            jobLocation: { '@type': 'Place', name: 'Rapperswil', address: { addressLocality: 'Rapperswil', addressCountry: 'CH' } },
            description: 'Some description text.',
          },
        ],
      })}</script>`;
      const node = extractJobPostingJsonLd(html);
      expect(node).not.toBeNull();
      expect(node.title).toBe('Filialleitung 80% (a)');
      expect(node.jobLocation.address.addressLocality).toBe('Rapperswil');
    });

    it('extracts a bare (non-@graph) JobPosting node', () => {
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Buchhändler*in 80% (a)',
      })}</script>`;
      const node = extractJobPostingJsonLd(html);
      expect(node?.title).toBe('Buchhändler*in 80% (a)');
    });

    it('returns null when no JSON-LD script is present', () => {
      expect(extractJobPostingJsonLd('<html><body>No structured data here</body></html>')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      const html = '<script type="application/ld+json">{ not valid json </script>';
      expect(extractJobPostingJsonLd(html)).toBeNull();
    });

    it('returns null when JSON-LD is present but not a JobPosting', () => {
      const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Orell Füssli' })}</script>`;
      expect(extractJobPostingJsonLd(html)).toBeNull();
    });
  });

  // ── HTML description block extraction ──
  describe('extractDescriptionHtml', () => {
    it('extracts the c-text-block-layout content block', () => {
      const html = `
        <div class="c-text-block">
          <div class="c-text-block-layout c-text-block-layout--text">
            <h3>Heading</h3><p>Some paragraph text.</p>
          </div>
        </div>`;
      const block = extractDescriptionHtml(html);
      expect(block).toContain('Some paragraph text.');
      expect(block).toContain('<h3>Heading</h3>');
    });

    it('returns empty string when the block is absent', () => {
      expect(extractDescriptionHtml('<div class="something-else">no match here</div>')).toBe('');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllOrellFuessliThaliaJobs emits)
    const validJob = {
      id: 'orell-fuessli-thalia-abc123',
      slug: 'filialleitung-80-a-orell-fuessli-thalia-rapperswil',
      slugByLocale: { de: 'filialleitung-80-a-orell-fuessli-thalia-rapperswil' },
      company: 'Orell Füssli Thalia',
      companyKey: 'orell-fuessli-thalia',
      companyDomain: 'orellfuessli.ch',
      title: 'Filialleitung 80% (a)',
      titleByLocale: { de: 'Filialleitung 80% (a)' },
      description:
        'A test job description for validation purposes, well over fifty words long so it clears the thin-content floor comfortably in every locale check we run against it during CI. We are looking for a motivated bookseller to join our Rapperswil store team, advising customers, managing stock, and helping run the till on busy weekend shifts throughout the year.',
      descriptionByLocale: {
        de: 'A test job description for validation purposes, well over fifty words long so it clears the thin-content floor comfortably in every locale check we run against it during CI. We are looking for a motivated bookseller to join our Rapperswil store team, advising customers, managing stock, and helping run the till on busy weekend shifts throughout the year.',
      },
      location: 'Rapperswil',
      canton: 'SG',
      url: 'https://karriere.orellfuessli.ch/de/offene-stellen/filialleitung-80',
      source: 'Orell Füssli Thalia Dedicated Parser (Drupal career site)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, AGENTS.md Non-Negotiable #3) ──
      addressLocality: 'Rapperswil',
      addressRegion: 'SG',
      streetAddress: '',
      postalCode: '',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream via safe defaults;
      // per-job inputs are what the parser is responsible for supplying.
      // NOTE: postalCode/streetAddress are intentionally allowed to be
      // empty strings here (non-HQ city) — the field is present (never
      // dropped), the downstream structured-data builder applies its own
      // safe default when empty. Only presence-of-key is asserted for
      // those two; the rest must be truthy.
      const structuredDataInputs = [
        'title', 'description', 'addressLocality', 'addressCountry', 'employmentType',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^orell-fuessli-thalia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description clears the 50-word thin-content floor (Non-Negotiable #4)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });
});
