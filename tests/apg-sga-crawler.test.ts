import { describe, it, expect } from 'vitest';
import {
  APG_SGA_KEY,
  APG_SGA_COMPANY_NAME,
  isApgSgaJob,
  isTrustedDomain,
  extractOstendisToken,
  parseJobPostingJsonLd,
} from '../scripts/lib/apg-sga-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('APG|SGA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APG_SGA_KEY).toBe('apg-sga');
    expect(APG_SGA_COMPANY_NAME).toBe('APG|SGA');
  });

  // ── isCompanyJob ──
  describe('isApgSgaJob', () => {
    it('matches by companyKey', () => {
      expect(isApgSgaJob({ companyKey: 'apg-sga' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isApgSgaJob({ company: 'APG|SGA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isApgSgaJob({ url: 'https://apgsga.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isApgSgaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isApgSgaJob(null)).toBe(false);
      expect(isApgSgaJob(undefined)).toBe(false);
      expect(isApgSgaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://apgsga.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.apgsga.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── extractOstendisToken (OJP embed discovery) ──
  describe('extractOstendisToken', () => {
    // Mirrors the live markup on /de/ueber-uns/offene-stellen-karriere/jobs/
    const embedHtml = `
      <script src="https://odm.ostendis.ch/ojp/assets/loader"
        data-token="ai4f0o0e7r5cjud6rmdsrljzq3jhjl4r" id="ostendisLoader"></script>
      <div id="ostendisJobs" class="ost-jobs"></div>
      <script>
        document.addEventListener("ostendisLoaderReady", function () {
          OSTENDISJOBS.embed(
            "ai4f0o0e7r5cjud6rmdsrljzq3jhjl4r",
            "DE",
            "#ostendisJobs",
            {}
          );
        });
      </script>`;

    it('extracts the token from the OSTENDISJOBS.embed call', () => {
      expect(extractOstendisToken(embedHtml)).toBe('ai4f0o0e7r5cjud6rmdsrljzq3jhjl4r');
    });

    it('falls back to the loader data-token attribute', () => {
      const html = '<script data-token="zzzz9o0e7r5cjud6rmdsrljzq3jhjl4r" id="ostendisLoader"></script>';
      expect(extractOstendisToken(html)).toBe('zzzz9o0e7r5cjud6rmdsrljzq3jhjl4r');
    });

    it('returns null when no embed is present', () => {
      expect(extractOstendisToken('<html><body>Keine Stellen</body></html>')).toBeNull();
      expect(extractOstendisToken('')).toBeNull();
    });

    it('ignores short attribute values that are not tokens', () => {
      expect(extractOstendisToken('<div data-token="abc123"></div>')).toBeNull();
    });
  });

  // ── parseJobPostingJsonLd (publication detail pages) ──
  describe('parseJobPostingJsonLd', () => {
    // Trimmed copy of the live JSON-LD served by jobs.apgsga.ch publications
    const detailHtml = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      "title": "Key Account Manager:in Direktkunden 80-100%, Z\\u00fcrich",
      "description": "<div><h1>Key Account Manager:in</h1><p>APG|SGA ist ein dynamisches Dienstleistungsunternehmen.</p></div>",
      "datePosted": "2026-05-12",
      "employmentType": ["PART_TIME", "FULL_TIME"],
      "hiringOrganization": { "@type": "Organization", "name": "APG|SGA, Allgemeine Plakatgesellschaft AG" },
      "jobLocation": {
        "@type": "Place",
        "address": {
          "@type": "PostalAddress",
          "addressLocality": "Z\\u00fcrich",
          "postalCode": "8027",
          "addressCountry": "CH"
        }
      }
    }</script></head><body></body></html>`;

    it('parses title, description, date, employment types and address', () => {
      const parsed = parseJobPostingJsonLd(detailHtml);
      expect(parsed).not.toBeNull();
      expect(parsed!.title).toBe('Key Account Manager:in Direktkunden 80-100%, Zürich');
      expect(parsed!.descriptionHtml).toContain('dynamisches Dienstleistungsunternehmen');
      expect(parsed!.datePosted).toBe('2026-05-12');
      expect(parsed!.employmentTypes).toEqual(['PART_TIME', 'FULL_TIME']);
      expect(parsed!.addressLocality).toBe('Zürich');
      expect(parsed!.postalCode).toBe('8027');
    });

    it('handles a scalar employmentType', () => {
      const html = detailHtml.replace('["PART_TIME", "FULL_TIME"]', '"FULL_TIME"');
      expect(parseJobPostingJsonLd(html)!.employmentTypes).toEqual(['FULL_TIME']);
    });

    it('returns null when no JobPosting JSON-LD is present', () => {
      expect(parseJobPostingJsonLd('<html><body>404</body></html>')).toBeNull();
      expect(parseJobPostingJsonLd('')).toBeNull();
    });

    it('ignores non-JobPosting JSON-LD nodes', () => {
      const html = '<script type="application/ld+json">{"@type":"Organization","name":"APG|SGA"}</script>';
      expect(parseJobPostingJsonLd(html)).toBeNull();
    });

    it('survives malformed JSON-LD', () => {
      const html = '<script type="application/ld+json">{not json</script>';
      expect(parseJobPostingJsonLd(html)).toBeNull();
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
      expect(slugify('Developer apg-sga ch')).toBe('developer-apg-sga-ch');
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
      id: 'apg-sga-abc123',
      slug: 'test-position-apg-sga-ch',
      slugByLocale: { de: 'test-position-apg-sga-ch' },
      company: 'APG|SGA',
      companyKey: 'apg-sga',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://apgsga.ch/jobs/test',
      source: 'APG|SGA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apg-sga-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
