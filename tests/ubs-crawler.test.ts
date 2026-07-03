import { describe, it, expect } from 'vitest';
import {
  UBS_KEY,
  UBS_COMPANY_NAME,
  isUbsJob,
  isTrustedDomain,
  __internals,
} from '../scripts/lib/ubs-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Item 1 (issue #3055): Taleo siteid loop ──
describe('Taleo siteid loop (issue #3055 item 1)', () => {
  it('fetches the main, apprenticeship, and graduate UBS Switzerland tenants', () => {
    expect(__internals.SITE_IDS).toEqual(['5012', '5054', '5131']);
  });
});

// ── Items 2/3 (issue #3055): inferAnyCanton(city) must not bypass the
// isSwissRegion guard — sibling fix, see update-galenica-jobs.test.ts for the
// Galenica counterpart. ──
describe('resolveSwissLocation region guard (issue #3055 item 2)', () => {
  it('rejects a foreign region even when the city aliases a Swiss canton', () => {
    // "Lugano" resolves to TI purely via the shared inferAnyCanton fuzzy
    // city-name match (not one of inferCanton's explicit canton-name
    // substring checks) — confirm the alias exists, then confirm a clearly
    // non-Swiss region blocks it from resolving.
    const foreignRegion = 'France - Auvergne-Rhône-Alpes';
    expect(__internals.isSwissRegion(foreignRegion)).toBe(false);
    expect(__internals.inferCanton('Lugano', foreignRegion)).toBe('TI');

    // Pre-fix this would have returned { city: 'Lugano', canton: 'TI' } purely
    // from the city alias, ignoring the foreign region. Post-fix it must be
    // rejected.
    expect(__internals.resolveSwissLocation('Lugano', foreignRegion)).toBeNull();
  });

  it('still resolves a genuine Swiss region normally (no regression)', () => {
    const swissRegion = 'Schweiz - Ticino';
    expect(__internals.isSwissRegion(swissRegion)).toBe(true);
    expect(__internals.resolveSwissLocation('Lugano', swissRegion)).toEqual({
      city: 'Lugano',
      canton: 'TI',
    });
  });

  it('still resolves a bare Swiss city with a blank region (no regression)', () => {
    // Cathedral CH-wide expansion: Taleo entries can have an empty region
    // string yet a clearly Swiss city — this must keep working.
    expect(__internals.resolveSwissLocation('Lugano', '')).toEqual({
      city: 'Lugano',
      canton: 'TI',
    });
  });

  it('rejects a genuine real-world namesake: Baden bei Wien (Austria), not Baden (AG)', () => {
    // "Baden" is both an Aargau (AG) municipality and a town near Vienna,
    // Austria — the exact kind of foreign-city/Swiss-placename collision
    // called out in issue #3055 item 2. inferAnyCanton matches the city
    // string alone; the region guard must still reject it.
    const austrianRegion = 'Österreich - Niederösterreich';
    expect(__internals.isSwissRegion(austrianRegion)).toBe(false);
    expect(__internals.inferCanton('Baden', austrianRegion)).toBe('AG');
    expect(__internals.resolveSwissLocation('Baden', austrianRegion)).toBeNull();
  });
});

describe('UBS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UBS_KEY).toBe('ubs');
    expect(UBS_COMPANY_NAME).toBe('UBS');
  });

  describe('Taleo token parsing', () => {
    it('extracts the RFT token from the current hidden input shape', () => {
      const html = `<input name="__RequestVerificationToken" type="hidden" value="abc-123" />`;

      expect(__internals.extractRequestVerificationToken(html)).toBe('abc-123');
    });

    it('handles attributes before the token name', () => {
      const html = `<input type='hidden' value='token-456' name='__RequestVerificationToken'>`;

      expect(__internals.extractRequestVerificationToken(html)).toBe('token-456');
    });
  });

  // ── isCompanyJob ──
  describe('isUbsJob', () => {
    it('matches by companyKey', () => {
      expect(isUbsJob({ companyKey: 'ubs' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUbsJob({ company: 'UBS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUbsJob({ url: 'https://ubs.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUbsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUbsJob(null)).toBe(false);
      expect(isUbsJob(undefined)).toBe(false);
      expect(isUbsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ubs.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ubs.com/job/456')).toBe(true);
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
      expect(slugify('Developer ubs ch')).toBe('developer-ubs-ch');
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
      id: 'ubs-abc123',
      slug: 'test-position-ubs-ch',
      slugByLocale: { en: 'test-position-ubs-ch' },
      company: 'UBS',
      companyKey: 'ubs',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ubs.com/jobs/test',
      source: 'UBS Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^ubs-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
