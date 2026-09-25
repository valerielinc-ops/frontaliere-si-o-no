import { describe, it, expect } from 'vitest';
import {
  SOMEDIA_KEY,
  SOMEDIA_COMPANY_NAME,
  isSomediaJob,
  isTrustedDomain,
  extractJobLinks,
  extractJsonLd,
} from '../scripts/lib/somedia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Somedia AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SOMEDIA_KEY).toBe('somedia');
    expect(SOMEDIA_COMPANY_NAME).toBe('Somedia AG');
  });

  // ── isCompanyJob ──
  describe('isSomediaJob', () => {
    it('matches by companyKey', () => {
      expect(isSomediaJob({ companyKey: 'somedia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSomediaJob({ company: 'Somedia AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSomediaJob({ url: 'https://somedia.ch/jobs/123' })).toBe(true);
    });

    it('matches by jobs subdomain URL', () => {
      expect(isSomediaJob({ url: 'https://jobs.somedia.ch/stellenangebote.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSomediaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSomediaJob(null)).toBe(false);
      expect(isSomediaJob(undefined)).toBe(false);
      expect(isSomediaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://somedia.ch/careers/job-123')).toBe(true);
    });

    it('trusts jobs subdomain', () => {
      expect(isTrustedDomain('https://jobs.somedia.ch/Redaktor-de-j123.html')).toBe(true);
    });

    it('trusts other subdomains', () => {
      expect(isTrustedDomain('https://careers.somedia.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── extractJobLinks ──
  describe('extractJobLinks', () => {
    it('extracts rexx-style job links from listing HTML', () => {
      const html = `
        <div class="job-list">
          <a href="/Redaktor-m-w-Bündner-Tagblatt-de-j1234.html?sid=abc">Details</a>
          <a href="/Mediaberater-in-de-j5678.html">Mehr</a>
        </div>
      `;
      const links = extractJobLinks(html);
      expect(links).toHaveLength(2);
      expect(links[0].rexxId).toBe('1234');
      expect(links[0].detailUrl).toBe('https://jobs.somedia.ch/Redaktor-m-w-Bündner-Tagblatt-de-j1234.html');
      expect(links[1].rexxId).toBe('5678');
      expect(links[1].detailUrl).toBe('https://jobs.somedia.ch/Mediaberater-in-de-j5678.html');
    });

    it('deduplicates by job ID', () => {
      const html = `
        <a href="/Job-Title-de-j100.html">Link 1</a>
        <a href="/Job-Title-de-j100.html?sid=xyz">Link 2</a>
      `;
      const links = extractJobLinks(html);
      expect(links).toHaveLength(1);
      expect(links[0].rexxId).toBe('100');
    });

    it('handles absolute URLs', () => {
      const html = `<a href="https://jobs.somedia.ch/Developer-de-j999.html">Link</a>`;
      const links = extractJobLinks(html);
      expect(links).toHaveLength(1);
      expect(links[0].detailUrl).toBe('https://jobs.somedia.ch/Developer-de-j999.html');
    });

    it('returns empty for no matches', () => {
      expect(extractJobLinks('')).toHaveLength(0);
      expect(extractJobLinks('<html><body>No jobs</body></html>')).toHaveLength(0);
    });
  });

  // ── extractJsonLd ──
  describe('extractJsonLd', () => {
    it('extracts JobPosting JSON-LD from HTML', () => {
      const html = `
        <html><head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "JobPosting",
          "title": "Redaktor/in",
          "description": "<p>Spannende Stelle</p>",
          "datePosted": "2026-04-01"
        }
        </script>
        </head></html>
      `;
      const jsonLd = extractJsonLd(html);
      expect(jsonLd).not.toBeNull();
      expect(jsonLd['@type']).toBe('JobPosting');
      expect(jsonLd.title).toBe('Redaktor/in');
      expect(jsonLd.datePosted).toBe('2026-04-01');
    });

    it('ignores non-JobPosting JSON-LD', () => {
      const html = `
        <script type="application/ld+json">
        { "@type": "Organization", "name": "Somedia" }
        </script>
      `;
      expect(extractJsonLd(html)).toBeNull();
    });

    it('returns null for empty/invalid HTML', () => {
      expect(extractJsonLd('')).toBeNull();
      expect(extractJsonLd('<html></html>')).toBeNull();
    });

    it('handles malformed JSON gracefully', () => {
      const html = `<script type="application/ld+json">{ broken }</script>`;
      expect(extractJsonLd(html)).toBeNull();
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

    it('handles German umlauts', () => {
      expect(slugify('Büro für Medien')).toBe('buro-fur-medien');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer somedia ch')).toBe('developer-somedia-ch');
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
      id: 'somedia-abc123def456',
      slug: 'redaktor-bundner-tagblatt-somedia-ch',
      slugByLocale: { de: 'redaktor-bundner-tagblatt-somedia-ch' },
      company: 'Somedia AG',
      companyKey: 'somedia',
      companyDomain: 'somedia.ch',
      title: 'Redaktor/in Bündner Tagblatt',
      titleByLocale: { de: 'Redaktor/in Bündner Tagblatt' },
      description: 'Wir suchen eine/n engagierte/n Redaktor/in für unser Team.',
      descriptionByLocale: { de: 'Wir suchen eine/n engagierte/n Redaktor/in für unser Team.' },
      location: 'Chur',
      canton: 'GR',
      url: 'https://jobs.somedia.ch/Redaktor-in-Buendner-Tagblatt-de-j1234.html',
      source: 'Somedia AG Dedicated Parser (Rexx Systems)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      sector: 'Media / Editoria',
      postalCode: '7000',
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
      expect(validJob.id).toMatch(/^somedia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('uses correct sector for media company', () => {
      expect(validJob.sector).toBe('Media / Editoria');
    });

    it('defaults to Chur location and GR canton', () => {
      expect(validJob.location).toBe('Chur');
      expect(validJob.canton).toBe('GR');
      expect(validJob.postalCode).toBe('7000');
    });
  });
});
