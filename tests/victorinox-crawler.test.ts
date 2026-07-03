import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VICTORINOX_KEY,
  VICTORINOX_COMPANY_NAME,
  isVictorinoxJob,
  isTrustedDomain,
  fetchAllVictorinoxJobs,
} from '../scripts/lib/victorinox-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Victorinox crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VICTORINOX_KEY).toBe('victorinox');
    expect(VICTORINOX_COMPANY_NAME).toBe('Victorinox');
  });

  // ── isCompanyJob ──
  describe('isVictorinoxJob', () => {
    it('matches by companyKey', () => {
      expect(isVictorinoxJob({ companyKey: 'victorinox' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVictorinoxJob({ company: 'Victorinox' })).toBe(true);
    });

    it('matches by victorinox.com URL', () => {
      expect(isVictorinoxJob({ url: 'https://www.victorinox.com/en/Careers/job/123' })).toBe(true);
    });

    it('matches by Talentsoft portal URL', () => {
      expect(isVictorinoxJob({ url: 'https://victorinox-career.talent-soft.com/offre/2026-245' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVictorinoxJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVictorinoxJob(null)).toBe(false);
      expect(isVictorinoxJob(undefined)).toBe(false);
      expect(isVictorinoxJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.victorinox.com/en/Careers/job/123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://shop.victorinox.com/en/')).toBe(true);
    });

    it('trusts the Talentsoft portal', () => {
      expect(isTrustedDomain('https://victorinox-career.talent-soft.com/offre/2026-245')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other-knife-maker.com/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── slugify (shared helper) ──
  describe('slugify', () => {
    it('lowercases and hyphenates', () => {
      expect(slugify('Product Innovation Manager')).toBe('product-innovation-manager');
    });

    it('strips diacritics', () => {
      expect(slugify('Delémont Café')).toBe('delemont-cafe');
    });

    it('collapses repeated separators', () => {
      expect(slugify('IT   Support -- Specialist')).toBe('it-support-specialist');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugify('--Sales Assistant--')).toBe('sales-assistant');
    });
  });

  // ── job shape / structured-data completeness (static) ──
  describe('job shape', () => {
    const validJob = {
      id: 'victorinox-abc123def456',
      slug: 'product-innovation-manager-victorinox-ibach-schwyz',
      slugByLocale: { de: 'product-innovation-manager-victorinox-ibach-schwyz' },
      company: 'Victorinox',
      companyKey: 'victorinox',
      companyDomain: 'victorinox.com',
      title: 'Product Innovation Manager 80-100% m/w/d',
      titleByLocale: { de: 'Product Innovation Manager 80-100% m/w/d' },
      description: 'A test job description for validation purposes only, well over thirty words long so the thin-content guard does not replace it with the synthesized fallback boilerplate text used for short detail pages.',
      descriptionByLocale: { de: 'A test job description for validation purposes only, well over thirty words long so the thin-content guard does not replace it with the synthesized fallback boilerplate text used for short detail pages.' },
      location: 'Ibach-Schwyz',
      canton: 'SZ',
      url: 'https://victorinox-career.talent-soft.com/offre/2026-245',
      source: 'Victorinox Dedicated Parser (Talentsoft)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Ibach-Schwyz',
      addressRegion: 'SZ',
      streetAddress: 'Schmiedgasse 57',
      postalCode: '6438',
      addressCountry: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
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
      expect(validJob.id).toMatch(/^victorinox-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('includes every structured-data completeness field (Non-Negotiable #3)', () => {
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob[field]).toBeTruthy();
      }
    });
  });

  // ── fetchAllVictorinoxJobs (mocked Talentsoft portal) ──
  describe('fetchAllVictorinoxJobs (mocked Talentsoft portal)', () => {
    const PORTAL_BASE = 'https://victorinox-career.talent-soft.com';

    function offerLi({ href, title, ref, dept, location }: { href: string; title: string; ref: string; dept: string; location: string }) {
      return `<li class="ts-offer-list-item offer" onclick="location.href='${href}';" tabindex="0">
        <div class="ts-offer-list-item__wrapper">
          <a class="ts-offer-list-item__title-link" href="${href}" title="${title} (Ref. : ${ref}) - ${dept}">${title}</a>
        </div>
        <ul class="ts-offer-list-item__description">
          <li>Ref. : ${ref}</li>
          <li>${location}</li>
          <li class="noBorder"></li>
        </ul>
      </li>`;
    }

    function detailHtml(bodyText: string) {
      return `<html><body><main><div id="contenu-ficheoffre" class="offer-detail">
        <h1>Stellenbeschreibung</h1>
        <p>${bodyText}</p>
      </div></main>
      <footer>Rechtliche Hinweise: Impressum, Datenschutz.</footer>
      </body></html>`;
    }

    const FULL_DETAIL_TEXT = 'Wir suchen eine engagierte Persönlichkeit, die unser Team am Standort verstärkt und '
      + 'gemeinsam mit uns die Zukunft von Victorinox mitgestaltet. Sie übernehmen vielfältige Aufgaben im Bereich '
      + 'Entwicklung, Planung und Umsetzung, arbeiten eng mit anderen Abteilungen zusammen und bringen eigene Ideen '
      + 'aktiv ein, um unsere Produkte kontinuierlich zu verbessern und unsere Kunden weltweit zu begeistern.';
    const THIN_DETAIL_TEXT = 'Kurze Stellenbeschreibung.';

    const ROWS = [
      {
        href: '/offre/2026-245',
        title: 'Product Innovation Manager 80-100% m/w/d',
        ref: '2026-245',
        dept: 'Product',
        location: 'Schmiedgasse 57 6438 Ibach-Schwyz',
        detail: FULL_DETAIL_TEXT,
      },
      {
        href: '/offre/2026-241',
        title: 'Sales Assistant - Zermatt m/w/d',
        ref: '2026-241',
        dept: 'Sales',
        location: 'Zermatt',
        detail: THIN_DETAIL_TEXT,
      },
      {
        href: '/offre/2026-229',
        title: 'Quality Coordinator H/F/D',
        ref: '2026-229',
        dept: 'Quality Management',
        location: 'Delémont',
        detail: FULL_DETAIL_TEXT,
      },
      {
        href: '/offre/2026-300',
        title: 'International Brand Manager m/w/d',
        ref: '2026-300',
        dept: 'Marketing',
        location: 'München, Deutschland',
        detail: FULL_DETAIL_TEXT,
      },
    ];

    function buildListingHtml(rows: typeof ROWS) {
      return `<html><body><ul class="ts-offer-list">${rows.map((r) => offerLi(r)).join('\n')}</ul></body></html>`;
    }

    function stubFetch(listingHtml: string, rows: typeof ROWS) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('list-of-all-jobs.aspx')) {
          return { ok: true, status: 200, text: async () => listingHtml } as unknown as Response;
        }
        const row = rows.find((r) => u.includes(r.href));
        if (row) {
          return { ok: true, status: 200, text: async () => detailHtml(row.detail) } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => '' } as unknown as Response;
      }));
    }

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('parses a successful multi-site listing, filters non-Swiss offices, and derives per-site canton/address', async () => {
      stubFetch(buildListingHtml(ROWS), ROWS);

      const jobs = await fetchAllVictorinoxJobs();
      const byTitle = Object.fromEntries(jobs.map((j: any) => [j.title, j]));

      // Foreign/unresolvable office (München, Deutschland) never fabricated
      // into a Swiss job — dropped instead of defaulting to the Ibach canton.
      expect(jobs).toHaveLength(3);
      expect(byTitle['International Brand Manager m/w/d']).toBeUndefined();

      // Ibach HQ (full street address in listing) → SZ, HQ street + postal.
      const ibachJob = byTitle['Product Innovation Manager 80-100% m/w/d'];
      expect(ibachJob).toBeDefined();
      expect(ibachJob.canton).toBe('SZ');
      expect(ibachJob.postalCode).toBe('6438');
      expect(ibachJob.streetAddress).toBe('Schmiedgasse 57');
      expect(ibachJob.description).toContain('Persönlichkeit');

      // Zermatt (bare city, secondary site) → VS, known postal code, never
      // the Ibach HQ street.
      const zermattJob = byTitle['Sales Assistant - Zermatt m/w/d'];
      expect(zermattJob).toBeDefined();
      expect(zermattJob.canton).toBe('VS');
      expect(zermattJob.postalCode).toBe('3920');
      expect(zermattJob.streetAddress).toBe('');

      // Delémont (bare city, secondary site) → JU, known postal code, never
      // the Ibach HQ street.
      const delemontJob = byTitle['Quality Coordinator H/F/D'];
      expect(delemontJob).toBeDefined();
      expect(delemontJob.canton).toBe('JU');
      expect(delemontJob.postalCode).toBe('2800');
      expect(delemontJob.streetAddress).toBe('');
    });

    it('applies the thin-description guard: short detail pages fall back to a synthesized description ≥30 words', async () => {
      stubFetch(buildListingHtml(ROWS), ROWS);

      const jobs = await fetchAllVictorinoxJobs();
      const zermattJob = jobs.find((j: any) => j.title === 'Sales Assistant - Zermatt m/w/d');

      expect(zermattJob).toBeDefined();
      // The raw detail text was too thin (< 30 words), so the fallback
      // summary (dept/location/ref + company boilerplate) was used instead
      // of the thin raw detail text.
      expect(zermattJob.description).not.toContain('Kurze Stellenbeschreibung');
      expect(zermattJob.description).toContain('Bereich: Sales');
      expect(zermattJob.description).toContain('Standort: Zermatt');
      expect(zermattJob.description).toContain('Referenz: 2026-241');
      expect(zermattJob.description).toContain('Victorinox');
    });

    it('includes structured-data completeness fields for every returned job (Non-Negotiable #3)', async () => {
      stubFetch(buildListingHtml(ROWS), ROWS);

      const jobs = await fetchAllVictorinoxJobs();
      expect(jobs.length).toBeGreaterThan(0);
      const structuredDataInputs = [
        'title', 'description', 'addressLocality', 'addressCountry',
        'employmentType', 'postedDate',
      ];
      for (const job of jobs) {
        for (const field of structuredDataInputs) {
          expect((job as any)[field]).toBeTruthy();
        }
        // postalCode/streetAddress are safe-defaulted (never omitted) even
        // when a secondary site legitimately has no HQ street on record.
        expect(job).toHaveProperty('postalCode');
        expect(job).toHaveProperty('streetAddress');
        expect(typeof (job as any).postalCode).toBe('string');
        expect(typeof (job as any).streetAddress).toBe('string');
      }
    });

    it('returns an empty array when the feed has no listings (end of pagination)', async () => {
      stubFetch('<html><body><ul class="ts-offer-list"></ul></body></html>', []);

      const jobs = await fetchAllVictorinoxJobs();
      expect(jobs).toEqual([]);
    });
  });
});
