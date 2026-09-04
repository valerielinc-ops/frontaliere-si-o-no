import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  INTERDISCOUNT_KEY,
  INTERDISCOUNT_COMPANY_NAME,
  isInterdiscountJob,
  isTrustedDomain,
  htmlToMarkdown,
} from '../scripts/lib/interdiscount-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { applyCoopSourceDetailToJob } from '../scripts/lib/coop-job-parser.mjs';
import { fingerprintsForCrawler } from '../scripts/audit-parser-quality.mjs';

describe('Interdiscount crawler parser', () => {
  it('wires strict source-detail enrichment and stable-route preservation', () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/update-interdiscount-jobs.mjs'), 'utf8');
    expect(runner).toContain('enrichCoopSourceBackedJobs');
    expect(runner).toContain("allowedHosts: ['jobs.coopjobs.ch']");
    expect(runner).toContain('preserveExistingSlugs: true');
  });
  // ── htmlToMarkdown ──
  describe('htmlToMarkdown', () => {
    it('preserves newlines between adjacent list items (regression: a \\s-based per-line trim glued lines together)', () => {
      const html = '<ul><li>Erste Anforderung</li><li>Zweite Anforderung</li></ul>';
      const lines = htmlToMarkdown(html).split('\n').map((l) => l.trim()).filter(Boolean);
      expect(lines).toContain('• Erste Anforderung');
      expect(lines).toContain('• Zweite Anforderung');
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(INTERDISCOUNT_KEY).toBe('interdiscount');
    expect(INTERDISCOUNT_COMPANY_NAME).toBe('Interdiscount');
  });

  // ── isCompanyJob ──
  describe('isInterdiscountJob', () => {
    it('matches by companyKey', () => {
      expect(isInterdiscountJob({ companyKey: 'interdiscount' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isInterdiscountJob({ company: 'Interdiscount' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isInterdiscountJob({ url: 'https://jobs.interdiscount.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isInterdiscountJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isInterdiscountJob(null)).toBe(false);
      expect(isInterdiscountJob(undefined)).toBe(false);
      expect(isInterdiscountJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.interdiscount.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.interdiscount.ch/job/456')).toBe(true);
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
      expect(slugify('Developer interdiscount ch')).toBe('developer-interdiscount-ch');
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
      id: 'interdiscount-abc123',
      slug: 'test-position-interdiscount-ch',
      slugByLocale: { de: 'test-position-interdiscount-ch' },
      company: 'Interdiscount',
      companyKey: 'interdiscount',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.interdiscount.ch/jobs/test',
      source: 'Interdiscount Dedicated Parser',
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
      expect(validJob.id).toMatch(/^interdiscount-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Multi-branch listings must not collapse onto the employer HQ (issue #7349)
//
// The Coop-family detail page publishes the EMPLOYER's registered address in
// its JSON-LD `jobLocation`: every Interdiscount branch vacancy carries
// "Bernstrasse 90, 3303 Jegenstorf" (head office). When the enrichment let that
// overwrite the per-branch `sza_workplace.*` geography from the listing row,
// 255/265 published records ended up at the same address — and because the
// audit's duplicate-listing fingerprint is `title || location || description`,
// 238 of them (90%) then read as the same vacancy re-posted (CRITICAL), i.e.
// duplicate content on distinct indexable URLs (Non-Negotiable #4).
// ──────────────────────────────────────────────────────────────
describe('Interdiscount multi-branch enrichment (#7349)', () => {
  const detailDescription = `<h2>Deine Aufgaben</h2><ul>${Array.from({ length: 26 }, (_, index) => `<li>Source-backed Aufgabe ${index + 1} mit Verantwortung und sorgfältiger Zusammenarbeit im Team.</li>`).join('')}</ul>`;
  // One and the same head-office payload is returned for every branch.
  const hqDetail = {
    '@type': 'JobPosting',
    title: 'Detailhandelsfachfrau:mann',
    description: detailDescription,
    jobLocation: {
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Jegenstorf',
        addressRegion: 'Jegenstorf',
        addressCountry: 'Schweiz',
        postalCode: '3303',
        streetAddress: 'Bernstrasse 90',
      },
    },
  };
  const branches = [
    ['Baar', 'ZG'],
    ['Aarau', 'AG'],
    ['Baden', 'AG'],
    ['Lyssach', 'BE'],
    ['Biel/Bienne', 'BE'],
  ] as const;
  const listings = branches.map(([city, canton], index) => ({
    id: `interdiscount-branch-${index}`,
    companyKey: INTERDISCOUNT_KEY,
    url: `https://jobs.coopjobs.ch/offene-stellen/detailhandelsfachfrau-mann/0000000${index}-0000-4000-8000-000000000000`,
    title: 'Detailhandelsfachfrau:mann',
    description: 'Listing boilerplate that must disappear',
    location: city,
    addressLocality: city,
    canton,
    addressRegion: canton,
    addressCountry: 'CH',
    sourceLang: 'de',
  }));

  it('keeps the branch geography instead of the head office the detail page advertises', () => {
    const enriched = listings.map((job) => applyCoopSourceDetailToJob(job, hqDetail));

    expect(enriched.map((job) => job.location)).toEqual(branches.map(([city]) => city));
    expect(enriched.map((job) => job.canton)).toEqual(branches.map(([, canton]) => canton));
    // A head-office street/CAP pinned to a branch city is a wrong address, not
    // a safe default — it must not travel with the overridden locality.
    expect(enriched.some((job) => job.streetAddress === 'Bernstrasse 90')).toBe(false);
    expect(enriched.some((job) => job.postalCode === '3303')).toBe(false);
  });

  it('publishes no record sharing both title and description with another', () => {
    const enriched = listings.map((job) => applyCoopSourceDetailToJob(job, hqDetail));
    const fingerprints = fingerprintsForCrawler(enriched, 'title-aware');

    expect(new Set(fingerprints).size).toBe(enriched.length);
  });

  it('still takes the detail geography when the listing has only a generic fallback', () => {
    const fallbackListing = { ...listings[0], location: 'Schweiz', addressLocality: 'Schweiz', canton: 'BE', addressRegion: 'BE' };

    expect(applyCoopSourceDetailToJob(fallbackListing, hqDetail)).toMatchObject({
      location: 'Jegenstorf',
      postalCode: '3303',
      streetAddress: 'Bernstrasse 90',
    });
  });

  // The listing `location` degrades to the REGION label when
  // `sza_workplace.city` is empty, and several region labels are ALSO
  // municipality names — so a region-only row would resolve here and look like
  // branch evidence, overriding the detail page that on those rows carries the
  // only real municipality. The crawler withholds `addressLocality` for those
  // rows and the override reads that field only.
  it('does not let a region-only listing row override the detail municipality', () => {
    const { addressLocality, ...regionOnlyListing } = listings[0];
    // `location` is the region label "Bern", which IS a Swiss municipality.
    const listing = { ...regionOnlyListing, location: 'Bern', canton: 'BE', addressRegion: 'BE' };
    const detail = structuredClone(hqDetail);
    detail.jobLocation.address.addressLocality = 'Ostermundigen';
    detail.jobLocation.address.addressRegion = 'Ostermundigen';

    expect(applyCoopSourceDetailToJob(listing, detail)).toMatchObject({
      location: 'Ostermundigen',
      addressLocality: 'Ostermundigen',
      canton: 'BE',
    });
  });

  // Guard the field contract the override above depends on: the crawlers must
  // publish `addressLocality` only when a real workplace city exists.
  it.each([
    ['interdiscount', '../scripts/lib/interdiscount-job-parser.mjs'],
    ['jumbo', '../scripts/lib/jumbo-job-parser.mjs'],
  ])('%s emits addressLocality only for a real workplace city', (_key, modulePath) => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, modulePath), 'utf8');

    expect(src).toContain('...(city ? { addressLocality: city } : {})');
    expect(src).not.toContain('addressLocality: city || location');
  });
});
