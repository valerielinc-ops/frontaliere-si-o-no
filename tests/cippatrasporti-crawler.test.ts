import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  assertCompleteCippatrasportiSnapshot,
  CIPPATRASPORTI_CAREER_URL,
  CIPPATRASPORTI_KEY,
  CIPPATRASPORTI_COMPANY_NAME,
  fetchAllCippatrasportiJobs,
  isCippatrasportiJob,
  isTrustedDomain,
  parseCippatrasportiDetailPage,
  parseCippatrasportiListingPage,
} from '../scripts/lib/cippatrasporti-job-parser.mjs';
import { restoreExistingSlugIdentity, slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const FIXTURES = new URL('./fixtures/cippatrasporti/', import.meta.url);
const daysAgo = (days: number) => {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};
const italianDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
};
const CUSTOMER_POSTED_DATE = daysAgo(7);
const OCEAN_POSTED_DATE = daysAgo(14);
const LISTING_HTML = fs.readFileSync(new URL('listing.html', FIXTURES), 'utf8')
  .replace('{{CUSTOMER_POSTED_DATE}}', italianDate(CUSTOMER_POSTED_DATE))
  .replace('{{OCEAN_POSTED_DATE}}', italianDate(OCEAN_POSTED_DATE));
const CUSTOMER_HTML = fs.readFileSync(new URL('customer-detail.html', FIXTURES), 'utf8')
  .replace('{{CUSTOMER_POSTED_DATE}}', CUSTOMER_POSTED_DATE);
const OCEAN_HTML = fs.readFileSync(new URL('ocean-detail.html', FIXTURES), 'utf8')
  .replace('{{OCEAN_POSTED_DATE}}', OCEAN_POSTED_DATE);
const CUSTOMER_URL = 'https://cippatrasporti.altamiraweb.com/annunci-lavoro/Customer-Service-Transport-Specialist-Commerciale-Trasporti-Chiasso-672753984.htm';
const OCEAN_URL = 'https://cippatrasporti.altamiraweb.com/annunci-lavoro/Ocean-Freight-Operations-Specialist-FCL-Project-Cargo-Trasporti-Chiasso-662670289.htm';

describe('Cippà Trasporti SA crawler parser', () => {
  it('reads the complete branded Altamira grid without navigation false positives', () => {
    expect(parseCippatrasportiListingPage(LISTING_HTML)).toEqual([
      {
        title: 'Customer Service Transport Specialist',
        url: CUSTOMER_URL,
        location: 'Chiasso',
        businessUnit: 'Commerciale; Trasporti',
        postedDate: CUSTOMER_POSTED_DATE,
      },
      {
        title: 'Ocean Freight Operations Specialist – FCL & Project Cargo',
        url: OCEAN_URL,
        location: 'Chiasso',
        businessUnit: 'Trasporti',
        postedDate: OCEAN_POSTED_DATE,
      },
    ]);
  });

  it('extracts rich source-backed JobPosting details and rejects thin or foreign content', () => {
    const listing = parseCippatrasportiListingPage(LISTING_HTML)[0];
    const detail = parseCippatrasportiDetailPage(CUSTOMER_HTML, CUSTOMER_URL, listing);

    expect(detail).toMatchObject({
      title: 'Customer Service Transport Specialist',
      location: 'Chiasso',
      canton: 'TI',
      postedDate: CUSTOMER_POSTED_DATE,
    });
    expect(detail.description.length).toBeGreaterThan(400);
    const fortyNineWords = Array.from({ length: 49 }, (_, index) => `competenza${index}`).join(' ');
    expect(() => parseCippatrasportiDetailPage(
      CUSTOMER_HTML.replace(/"description":\s*"[^"]+"/, `"description": "${fortyNineWords}"`),
      CUSTOMER_URL,
      listing,
    )).toThrow(/description is thin/);
    expect(() => parseCippatrasportiDetailPage(
      CUSTOMER_HTML.replace('"name": "Cippà Trasporti S.A."', '"name": "Unrelated Logistics AG"'),
      CUSTOMER_URL,
      listing,
    )).toThrow(/organization is missing or foreign/);
    expect(() => parseCippatrasportiDetailPage(
      CUSTOMER_HTML.replace('"addressLocality": "Chiasso"', '"addressLocality": "Lugano"'),
      CUSTOMER_URL,
      listing,
    )).toThrow(/Swiss geography is missing or contradictory/);
    expect(() => parseCippatrasportiDetailPage(
      CUSTOMER_HTML.replace(CUSTOMER_POSTED_DATE, daysAgo(6)),
      CUSTOMER_URL,
      listing,
    )).toThrow(/date disagrees/);
  });

  it('publishes two rich jobs with stable live IDs, URLs and slugs across repeated runs', async () => {
    const fetchPage = vi.fn(async (url: string, options: { validateRedirectUrl?: (url: string) => unknown }) => {
      options.validateRedirectUrl?.(url);
      if (url === CIPPATRASPORTI_CAREER_URL) return LISTING_HTML;
      if (url === CUSTOMER_URL) return CUSTOMER_HTML;
      if (url === OCEAN_URL) return OCEAN_HTML;
      throw new Error(`unexpected URL ${url}`);
    });
    const runtime = { fetchPage, sleep: async () => {}, detailConcurrency: 2 };
    const first = await fetchAllCippatrasportiJobs(runtime);
    const second = await fetchAllCippatrasportiJobs(runtime);

    expect(assertCompleteCippatrasportiSnapshot(first)).toBe(true);
    expect(first.map((job) => ({ id: job.id, url: job.url, slug: job.slug }))).toEqual([
      {
        id: 'cippatrasporti-c38396f76831',
        url: CUSTOMER_URL,
        slug: 'customer-service-transport-specialist-cippatrasporti-ch',
      },
      {
        id: 'cippatrasporti-5dd16ddc181a',
        url: OCEAN_URL,
        slug: 'ocean-freight-operations-specialist-fcl-project-cargo-cippatrasporti-ch',
      },
    ]);
    expect(first.every((job) => job.description.length > 400 && job.location === 'Chiasso')).toBe(true);
    expect(first.every((job) => job.category === 'Logistica')).toBe(true);
    const identity = (job: { id: string; url: string; slug: string; location: string }) => ({
      id: job.id,
      url: job.url,
      slug: job.slug,
      location: job.location,
    });
    expect(second.map(identity)).toEqual(first.map(identity));
    expect(fetchPage).toHaveBeenCalledTimes(6);

    const existing = JSON.parse(fs.readFileSync(
      new URL('../data/jobs/by-crawler/cippatrasporti.json', import.meta.url),
      'utf8',
    )).jobs;
    const persisted = restoreExistingSlugIdentity(
      existing,
      mergePreserveLocaleData(existing, first),
    ).jobs;
    const existingById = new Map(existing.map((job: any) => [job.id, job]));
    for (const job of persisted) {
      const old: any = existingById.get(job.id);
      expect(old).toBeDefined();
      expect(job.url).toBe(old.url);
      expect(job.slug).toBe(old.slug);
      expect(job.slugByLocale).toEqual(old.slugByLocale);
      expect(job.previousSlugs).toEqual(old.previousSlugs);
      expect(job.previousSlugsByLocale).toEqual(old.previousSlugsByLocale);
    }
  });

  it('keeps an authoritative source zero distinct from detail transport or parser errors', async () => {
    const emptyListing = LISTING_HTML.replace(/<tr class="GRID_DAT_ROW"[\s\S]*?<\/tr>[\s\S]*?<tr class="GRID_DAT_ROW_Alter"[\s\S]*?<\/tr>/, '');
    const empty = await fetchAllCippatrasportiJobs({
      fetchPage: async () => emptyListing,
      sleep: async () => {},
    });
    expect(empty).toEqual([]);
    expect(assertCompleteCippatrasportiSnapshot(empty)).toBe(true);
    expect(() => assertCompleteCippatrasportiSnapshot([])).toThrow(/not a proven complete/);

    const failedDetail = vi.fn(async (url: string) => {
      if (url === CIPPATRASPORTI_CAREER_URL) return LISTING_HTML;
      if (url === CUSTOMER_URL) throw new Error('socket timeout');
      return OCEAN_HTML;
    });
    await expect(fetchAllCippatrasportiJobs({
      fetchPage: failedDetail,
      sleep: async () => {},
    })).rejects.toThrow(/socket timeout/);

    expect(() => parseCippatrasportiListingPage(
      LISTING_HTML.replace('data-title="Business unit"', 'data-title="Department"'),
    )).toThrow(/authoritative listing boundary missing/);
    expect(() => parseCippatrasportiListingPage(
      LISTING_HTML.replace('.htm">Customer', '.htm?utm_source=tracker">Customer'),
    )).toThrow(/malformed listing row/);
  });

  it('wires empty-state proof and published slug pinning into the standard runner', () => {
    const runner = fs.readFileSync(new URL('../scripts/update-cippatrasporti-jobs.mjs', import.meta.url), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: assertCompleteCippatrasportiSnapshot');
    expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    expect(runner).toContain('preserveExistingSlugs: true');
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CIPPATRASPORTI_KEY).toBe('cippatrasporti');
    expect(CIPPATRASPORTI_COMPANY_NAME).toBe('Cippà Trasporti SA');
  });

  // ── isCompanyJob ──
  describe('isCippatrasportiJob', () => {
    it('matches by companyKey', () => {
      expect(isCippatrasportiJob({ companyKey: 'cippatrasporti' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCippatrasportiJob({ company: 'Cippà Trasporti SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCippatrasportiJob({ url: 'https://cippatrasporti.altamiraweb.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCippatrasportiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCippatrasportiJob(null)).toBe(false);
      expect(isCippatrasportiJob(undefined)).toBe(false);
      expect(isCippatrasportiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cippatrasporti.altamiraweb.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.cippatrasporti.altamiraweb.com/job/456')).toBe(true);
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
      expect(slugify('Developer cippatrasporti ch')).toBe('developer-cippatrasporti-ch');
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
      id: 'cippatrasporti-abc123',
      slug: 'test-position-cippatrasporti-ch',
      slugByLocale: { it: 'test-position-cippatrasporti-ch' },
      company: 'Cippà Trasporti SA',
      companyKey: 'cippatrasporti',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://cippatrasporti.altamiraweb.com/jobs/test',
      source: 'Cippà Trasporti SA Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^cippatrasporti-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
