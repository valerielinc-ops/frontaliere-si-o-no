import { describe, it, expect } from 'vitest';
import {
  AROSA_LENZERHEIDE_KEY,
  AROSA_LENZERHEIDE_COMPANY_NAME,
  isArosaLenzerheideJob,
  isTrustedDomain,
} from '../scripts/lib/arosa-lenzerheide-job-parser.mjs';
import { parseReflineAnchorListing } from '../scripts/lib/refline-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

/**
 * Listing fixture recalced from the live Refline board on 2026-07-11:
 * https://app.reflinejobs.io/3316/positions.html?lang=de
 * (anchor-list + workName template — Lenzerheide Bergbahnen AG tenant).
 */
const LISTING_FIXTURE = `
<div class="gridtable grid3">
  <div class="listblock listcontent">
    <div class="main">
      <div class="item positiontitle" data-name="Stellentitel">
        <a href="https://app.reflinejobs.io/3316/0012/pub/9/index.html" target="_blank">Betriebselektriker:in</a>
      </div>
    </div>
    <div class="sub">
      <div class="item employment" data-name="Anstellungsverhältnis">Festanstellung</div>
      <div class="item workload" data-name="Pensum">80-100%</div>
      <div class="item workName" data-name="Arbeitsort">Lenzerheide Bergbahnen AG</div>
    </div>
  </div>
  <div class="listblock listcontent">
    <div class="main">
      <div class="item positiontitle" data-name="Stellentitel">
        <a href="https://app.reflinejobs.io/3316/0024/pub/15/index.html" target="_blank">Pistenmaschinenfahrer:in</a>
      </div>
    </div>
    <div class="sub">
      <div class="item employment" data-name="Anstellungsverhältnis">Temporär</div>
      <div class="item workload" data-name="Pensum"></div>
      <div class="item workName" data-name="Arbeitsort">Lenzerheide Bergbahnen AG</div>
    </div>
  </div>
  <div class="btn">
    <a href="https://app.reflinejobs.io/3316/apply-spontaneous.html" target="_blank">Spontanbewerbung</a>
  </div>
</div>
`;

describe('Arosa Lenzerheide crawler parser (Refline tenant 3316)', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AROSA_LENZERHEIDE_KEY).toBe('arosa-lenzerheide');
    expect(AROSA_LENZERHEIDE_COMPANY_NAME).toBe('Arosa Lenzerheide');
  });

  // ── isCompanyJob ──
  describe('isArosaLenzerheideJob', () => {
    it('matches by companyKey', () => {
      expect(isArosaLenzerheideJob({ companyKey: 'arosa-lenzerheide' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isArosaLenzerheideJob({ company: 'Arosa Lenzerheide' })).toBe(true);
    });

    it('matches the operating companies of the ski resort', () => {
      expect(isArosaLenzerheideJob({ company: 'Lenzerheide Bergbahnen AG' })).toBe(true);
      expect(isArosaLenzerheideJob({ company: 'Arosa Bergbahnen AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isArosaLenzerheideJob({ url: 'https://arosalenzerheide.swiss/jobs/123' })).toBe(true);
    });

    it('matches by Refline tenant listing URL', () => {
      expect(isArosaLenzerheideJob({ url: 'https://app.reflinejobs.io/3316/0012/pub/9/index.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isArosaLenzerheideJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isArosaLenzerheideJob(null)).toBe(false);
      expect(isArosaLenzerheideJob(undefined)).toBe(false);
      expect(isArosaLenzerheideJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://arosalenzerheide.swiss/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.arosalenzerheide.swiss/job/456')).toBe(true);
    });

    it('trusts the Refline tenant board', () => {
      expect(isTrustedDomain('https://app.reflinejobs.io/3316/0012/pub/9/index.html')).toBe(true);
    });

    it('rejects a Refline URL for a different tenant', () => {
      expect(isTrustedDomain('https://app.reflinejobs.io/1531/0052/pub/2/index.html')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Listing parse (fixture recalced from live board 2026-07-11) ──
  describe('Refline anchor-list parsing', () => {
    const listings = parseReflineAnchorListing(LISTING_FIXTURE, {
      listingHost: 'app.reflinejobs.io',
      tenant: '3316',
    });

    it('extracts every position row', () => {
      expect(listings).toHaveLength(2);
      expect(listings.map((l: { title: string }) => l.title)).toEqual([
        'Betriebselektriker:in',
        'Pistenmaschinenfahrer:in',
      ]);
    });

    it('extracts detail URL, posId and workName', () => {
      expect(listings[0].url).toBe('https://app.reflinejobs.io/3316/0012/pub/9/index.html');
      expect(listings[0].posId).toBe('0012');
      expect(listings[0].workplace).toBe('Lenzerheide Bergbahnen AG');
    });

    it('does not pick up the Spontanbewerbung link', () => {
      expect(listings.some((l: { url: string }) => /apply-spontaneous/.test(l.url))).toBe(false);
    });

    it('ignores rows from a different tenant', () => {
      const foreign = LISTING_FIXTURE.replace(/3316/g, '9999');
      expect(parseReflineAnchorListing(foreign, { listingHost: 'app.reflinejobs.io', tenant: '3316' })).toHaveLength(0);
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

    it('handles Refline-style inclusive titles', () => {
      expect(slugify('Betriebselektriker:in arosa-lenzerheide Lenzerheide')).toBe('betriebselektriker-in-arosa-lenzerheide-lenzerheide');
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
      id: 'arosa-lenzerheide-abc123',
      slug: 'test-position-arosa-lenzerheide-lenzerheide',
      slugByLocale: { de: 'test-position-arosa-lenzerheide-lenzerheide' },
      company: 'Arosa Lenzerheide',
      companyKey: 'arosa-lenzerheide',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lenzerheide',
      canton: 'GR',
      url: 'https://app.reflinejobs.io/3316/0012/pub/9/index.html',
      source: 'Arosa Lenzerheide Dedicated Parser (Refline 3316)',
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
      expect(validJob.id).toMatch(/^arosa-lenzerheide-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
