import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GOOGLE_SWITZERLAND_KEY,
  GOOGLE_SWITZERLAND_COMPANY_NAME,
  isGoogleSwitzerlandJob,
  isTrustedDomain,
  parseGoogleListingHtml,
  parseGoogleDeclaredTotal,
  extractGoogleDetailDescription,
} from '../scripts/lib/google-switzerland-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Trimmed real markup from the server-rendered careers search
// (fetched live 2026-08-07, no proxy): the search sidebar's own <h3>s, two job
// cards, and the pager sentence carrying the source-declared total.
const LISTING_HTML = readFileSync(
  path.join(__dirname, 'fixtures', 'google-switzerland-listing.html'),
  'utf8',
);

// Trimmed real detail page: a leading fragment of app-shell script, the four
// body sections, and the start of the legal footer.
const DETAIL_HTML = readFileSync(
  path.join(__dirname, 'fixtures', 'google-switzerland-detail.html'),
  'utf8',
);

describe('Google Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GOOGLE_SWITZERLAND_KEY).toBe('google-switzerland');
    expect(GOOGLE_SWITZERLAND_COMPANY_NAME).toBe('Google Switzerland');
  });

  // ── isCompanyJob ──
  describe('isGoogleSwitzerlandJob', () => {
    it('matches by companyKey', () => {
      expect(isGoogleSwitzerlandJob({ companyKey: 'google-switzerland' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGoogleSwitzerlandJob({ company: 'Google Switzerland' })).toBe(true);
      expect(isGoogleSwitzerlandJob({ company: 'Google' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isGoogleSwitzerlandJob({ url: 'https://www.google.com/about/careers/applications/jobs/results/123-test' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isGoogleSwitzerlandJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('rejects unrelated google.com pages outside careers', () => {
      expect(isGoogleSwitzerlandJob({ url: 'https://www.google.com/search?q=jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGoogleSwitzerlandJob(null)).toBe(false);
      expect(isGoogleSwitzerlandJob(undefined)).toBe(false);
      expect(isGoogleSwitzerlandJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(
        isTrustedDomain('https://www.google.com/about/careers/applications/jobs/results/123-test'),
      ).toBe(true);
    });

    it('trusts apex domain', () => {
      expect(isTrustedDomain('https://google.com/about/careers/applications/')).toBe(true);
    });

    it('rejects unrelated subdomains', () => {
      expect(isTrustedDomain('https://mail.google.com/about')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Direct server-rendered HTML extraction (#5295) ──
  //
  // These lock down the path that replaced the Jina proxy after Jina blocked
  // all anonymous access to www.google.com. They deliberately assert on
  // accessibility/heading anchors and NOT on CSS classes: Google's classes are
  // build-generated (QJPWVe, l103df, Xsxa1e) and rotate on every deploy, so a
  // class-based extractor would pass here and be dead within days.
  describe('parseGoogleListingHtml', () => {
    it('extracts one entry per job card', () => {
      expect(parseGoogleListingHtml(LISTING_HTML)).toHaveLength(2);
    });

    it('builds the canonical URL without the search-result query string', () => {
      // The href in the page carries `?location=Zurich,+Switzerland`. Job ids
      // are a sha1 of this URL, so keeping the query would re-key every job.
      const [first] = parseGoogleListingHtml(LISTING_HTML);
      expect(first.canonicalUrl).toBe(
        'https://www.google.com/about/careers/applications/jobs/results/'
        + '106855447041843910-software-engineer-iii-aiml-shopping-creator-youtube',
      );
      expect(first.canonicalUrl).not.toContain('?');
      expect(first.jobId).toBe('106855447041843910');
    });

    it('reads the title from the accessibility label, not from a CSS class', () => {
      const [first] = parseGoogleListingHtml(LISTING_HTML);
      expect(first.title).toBe('Software Engineer III, AI/ML Shopping Creator, YouTube');
    });

    it('splits the card summary line into org and location', () => {
      const [first] = parseGoogleListingHtml(LISTING_HTML);
      expect(first.org).toBe('YouTube');
      expect(first.location).toBe('Zürich, Switzerland');
    });

    it('reads the experience level from the filter chip label', () => {
      const [first] = parseGoogleListingHtml(LISTING_HTML);
      expect(first.level).toBe('Mid');
    });

    it('collects the Minimum qualifications bullets', () => {
      const [first] = parseGoogleListingHtml(LISTING_HTML);
      expect(first.minQuals.length).toBeGreaterThanOrEqual(3);
      expect(first.minQuals[0]).toBe("Bachelor's degree or equivalent practical experience.");
    });

    it('never lets the first card swallow the page prologue', () => {
      // Each card's body starts at its own <h3>, not at the previous anchor.
      // Without that, card 1 reaches back over ~1MB of bootstrap script whose
      // JSON is full of `|`, and the Org | Location split reads WIZ_global_data.
      const withPrologue = `<script>window.WIZ_global_data = {"a":"x|y","b":"c|d"};</script>${LISTING_HTML}`;
      const [first] = parseGoogleListingHtml(withPrologue);
      expect(first.org).toBe('YouTube');
      expect(first.org).not.toContain('WIZ_global_data');
    });

    it('is not confused by the search sidebar headings that precede the cards', () => {
      // The sidebar renders its own <h3>Locations</h3>/<h3>Experience</h3>
      // before the first card; anchoring on the Learn-more link keeps them out.
      expect(LISTING_HTML).toContain('<h3 class="mUzaXb">Locations</h3>');
      const entries = parseGoogleListingHtml(LISTING_HTML);
      expect(entries.map((e) => e.title)).not.toContain('Locations');
    });

    it('deduplicates repeated job ids', () => {
      expect(parseGoogleListingHtml(LISTING_HTML + LISTING_HTML)).toHaveLength(2);
    });

    it('returns [] for a page with no cards, and for empty input', () => {
      // A client-rendered app shell is exactly this case — it is what routes
      // the fetch to the Jina fallback rather than silently reporting success.
      expect(parseGoogleListingHtml('<html><body><div id="app"></div></body></html>')).toEqual([]);
      expect(parseGoogleListingHtml('')).toEqual([]);
      expect(parseGoogleListingHtml(null as unknown as string)).toEqual([]);
    });
  });

  describe('parseGoogleDeclaredTotal', () => {
    it('reads the total from the pager sentence', () => {
      expect(parseGoogleDeclaredTotal(LISTING_HTML)).toBe(34);
    });

    it('falls back to the "N jobs matched" sentence', () => {
      expect(parseGoogleDeclaredTotal('<div><span class="SWhIm">61</span>  jobs matched</div>')).toBe(61);
    });

    it('returns null when neither is present', () => {
      expect(parseGoogleDeclaredTotal('<div>nothing</div>')).toBeNull();
      expect(parseGoogleDeclaredTotal('')).toBeNull();
    });
  });

  describe('extractGoogleDetailDescription', () => {
    it('returns the job body, starting at the first content heading', () => {
      const body = extractGoogleDetailDescription(DETAIL_HTML);
      expect(body.startsWith('Minimum qualifications')).toBe(true);
      expect(body.length).toBeGreaterThan(500);
    });

    it('keeps list structure as bullets', () => {
      expect(extractGoogleDetailDescription(DETAIL_HTML)).toContain('• ');
    });

    it('never leaks the surrounding app shell into the description', () => {
      const body = extractGoogleDetailDescription(DETAIL_HTML);
      expect(body).not.toContain('WIZ_global_data');
      expect(body).not.toContain('<script');
    });

    it('trims the boilerplate legal footer', () => {
      expect(DETAIL_HTML).toContain('Information collected and processed as part of your Google Careers profile');
      const body = extractGoogleDetailDescription(DETAIL_HTML);
      expect(body).not.toContain('Information collected and processed');
    });

    it('returns "" when no body section is present', () => {
      expect(extractGoogleDetailDescription('<html><body><div id="app"></div></body></html>')).toBe('');
      expect(extractGoogleDetailDescription('')).toBe('');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer III, AI/ML');
      expect(slug).toBe('software-engineer-iii-ai-ml');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer google-switzerland Zürich')).toBe('developer-google-switzerland-zurich');
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
      id: 'google-switzerland-abc123',
      slug: 'test-position-google-switzerland-zurich',
      slugByLocale: { en: 'test-position-google-switzerland-zurich' },
      company: 'Google Switzerland',
      companyKey: 'google-switzerland',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://www.google.com/about/careers/applications/jobs/results/123-test-position',
      source: 'Google Switzerland Dedicated Parser (server-rendered HTML)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),

      // Structured-data-completeness fields (AGENTS.md Non-Negotiable #3)
      baseSalary: undefined,
      postalCode: '8002',
      streetAddress: 'Brandschenkestrasse 110',
      datePosted: new Date().toISOString().split('T')[0],
      hiringOrganization: { name: 'Google Switzerland' },
      jobLocation: { addressLocality: 'Zürich', addressRegion: 'ZH', postalCode: '8002', addressCountry: 'CH' },
      employmentType: 'FULL_TIME',
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
      expect(validJob.id).toMatch(/^google-switzerland-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('has structured-data-completeness fields (AGENTS.md Non-Negotiable #3)', () => {
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob).toHaveProperty('title');
      expect(validJob).toHaveProperty('description');
      expect(validJob).toHaveProperty('datePosted');
      expect(validJob.hiringOrganization).toHaveProperty('name');
      expect(validJob).toHaveProperty('jobLocation');
      expect(validJob).toHaveProperty('employmentType');
    });
  });
});
