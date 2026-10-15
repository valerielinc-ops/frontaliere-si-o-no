import { describe, it, expect } from 'vitest';
import {
  HUBER_SUHNER_KEY,
  HUBER_SUHNER_COMPANY_NAME,
  isHuberSuhnerJob,
  isTrustedDomain,
  parseListing,
  resolveLocation,
  isSwissListingLocation,
  parseWorkload,
  detectContractDuration,
  extractHeaderMeta,
  extractDetailSections,
} from '../scripts/lib/huber-suhner-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Huber+Suhner AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HUBER_SUHNER_KEY).toBe('huber-suhner');
    expect(HUBER_SUHNER_COMPANY_NAME).toBe('Huber+Suhner AG');
  });

  // ── isCompanyJob ──
  describe('isHuberSuhnerJob', () => {
    it('matches by companyKey', () => {
      expect(isHuberSuhnerJob({ companyKey: 'huber-suhner' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHuberSuhnerJob({ company: 'Huber+Suhner AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHuberSuhnerJob({ url: 'https://hubersuhner.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHuberSuhnerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHuberSuhnerJob(null)).toBe(false);
      expect(isHuberSuhnerJob(undefined)).toBe(false);
      expect(isHuberSuhnerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hubersuhner.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hubersuhner.com/job/456')).toBe(true);
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
      expect(slugify('Developer huber-suhner ch')).toBe('developer-huber-suhner-ch');
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
      id: 'huber-suhner-abc123',
      slug: 'test-position-huber-suhner-ch',
      slugByLocale: { de: 'test-position-huber-suhner-ch' },
      company: 'Huber+Suhner AG',
      companyKey: 'huber-suhner',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hubersuhner.com/jobs/test',
      source: 'Huber+Suhner AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^huber-suhner-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Bespoke Umantis (older UI) listing-row parsing ──
  describe('parseListing', () => {
    const fixture = `
      <table>
        <tr class="tableaslist_contentrow1">
          <td><a href="/Vacancies/7355/Description/1">Automatiker/in EFZ</a>
          <span class="tableaslist_element_1152495">&nbsp;|&nbsp; Herisau (AR)</span>
          Online since: 12.05.2026</td>
        </tr>
        <tr class="tableaslist_contentrow2">
          <td><a href="/Vacancies/7806/Description/2">Corporate Controller</a>
          <span class="tableaslist_element_1152495">&nbsp;|&nbsp; Pf&auml;ffikon (ZH)</span>
          Online since: 03.06.2026</td>
        </tr>
        <tr class="tableaslist_contentrow1">
          <td><a href="/Vacancies/9999/Description/1">Initiativbewerbung</a>
          <span class="tableaslist_element_1152495">&nbsp;|&nbsp; Herisau (AR)</span>
          Online since: 01.01.2026</td>
        </tr>
        <tr class="tableaslist_contentrow2">
          <td><a href="/Vacancies/6120/Description/5">Sales Manager</a>
          <span class="tableaslist_element_1152495">&nbsp;|&nbsp; Shanghai</span>
          Online since: 20.04.2026</td>
        </tr>
      </table>`;

    it('extracts id, per-row langCode, title and raw location', () => {
      const rows = parseListing(fixture);
      expect(rows).toHaveLength(3); // 9999 blind-application row excluded
      expect(rows[0]).toMatchObject({ id: '7355', langCode: '1', title: 'Automatiker/in EFZ' });
      expect(rows[0].rawLocation).toContain('Herisau');
    });

    it('preserves the HTML-entity-encoded raw location untouched (decoding happens downstream)', () => {
      const rows = parseListing(fixture);
      const controller = rows.find((r) => r.id === '7806');
      expect(controller?.rawLocation).toContain('Pf&auml;ffikon');
    });

    it('reads distinct per-job langCode values instead of a computed constant', () => {
      const rows = parseListing(fixture);
      const langCodes = new Set(rows.map((r) => r.langCode));
      expect(langCodes.has('1')).toBe(true);
      expect(langCodes.has('2')).toBe(true);
      expect(langCodes.has('5')).toBe(true);
    });

    it('excludes blind/spontaneous application placeholder rows', () => {
      const rows = parseListing(fixture);
      expect(rows.some((r) => r.id === '9999')).toBe(false);
    });
  });

  // ── HTML-entity decoding + Swiss-only scope filter ──
  describe('isSwissListingLocation', () => {
    it('matches HTML-entity-encoded "Pf&auml;ffikon"', () => {
      expect(isSwissListingLocation('Pf&auml;ffikon (ZH)')).toBe(true);
    });

    it('matches plain Herisau', () => {
      expect(isSwissListingLocation('Herisau (AR)')).toBe(true);
    });

    it('rejects non-Swiss locations', () => {
      expect(isSwissListingLocation('Shanghai')).toBe(false);
      expect(isSwissListingLocation('Pforzheim, Germany')).toBe(false);
    });
  });

  describe('resolveLocation', () => {
    it('resolves Herisau HQ address', () => {
      const loc = resolveLocation('Herisau (AR)');
      expect(loc).toMatchObject({ city: 'Herisau', canton: 'AR', postalCode: '9100' });
      expect(loc.streetAddress).toBeTruthy();
    });

    it('resolves entity-encoded Pfäffikon site address', () => {
      const loc = resolveLocation('Pf&auml;ffikon (ZH)');
      expect(loc).toMatchObject({ city: 'Pfäffikon', canton: 'ZH', postalCode: '8330' });
    });
  });

  // ── Workload % parsing ──
  describe('parseWorkload', () => {
    it('parses a fixed 100% workload', () => {
      expect(parseWorkload('100%')).toEqual({ min: 100, max: 100 });
    });

    it('parses a range like "60 bis 100 %"', () => {
      expect(parseWorkload('60 bis 100 %')).toEqual({ min: 60, max: 100 });
    });

    it('returns null for empty/garbage input', () => {
      expect(parseWorkload('')).toBeNull();
      expect(parseWorkload('n/a')).toBeNull();
    });
  });

  // ── Contract-duration detection (DE + EN, substring-collision safe) ──
  describe('detectContractDuration', () => {
    it('detects German "Unbefristet" as permanent (not confused by "befristet" substring)', () => {
      expect(detectContractDuration('Unbefristet')).toBe('permanent');
    });

    it('detects German "Befristet" as temporary', () => {
      expect(detectContractDuration('Befristet auf 12 Monate')).toBe('temporary');
    });

    it('detects English "Unlimited" as permanent (not confused by "limited" substring)', () => {
      expect(detectContractDuration('Unlimited')).toBe('permanent');
    });

    it('detects English "Limited" as temporary', () => {
      expect(detectContractDuration('Limited to 1 year')).toBe('temporary');
    });

    it('defaults to permanent when contract text is missing', () => {
      expect(detectContractDuration('')).toBe('permanent');
    });
  });

  // ── Third, previously-undocumented Umantis detail-page layout ──
  describe('extractHeaderMeta', () => {
    it('extracts title + pipe-separated header spans', () => {
      const html = `
        <h1 class="mbottom--small">Automatiker/in EFZ</h1>
        <p class="section__header__subtitle text--muted">
          <span>m/w/d</span><span>Herisau (AR)</span><span>100%</span><span>Unbefristet</span>
        </p>`;
      const { title, spans } = extractHeaderMeta(html);
      expect(title).toBe('Automatiker/in EFZ');
      expect(spans).toEqual(['m/w/d', 'Herisau (AR)', '100%', 'Unbefristet']);
    });

    it('ignores stale HTML-comment leftover header markup from another posting', () => {
      const html = `
        <!-- <h1 class="mbottom--small">WRONG Old Posting</h1>
        <p class="section__header__subtitle text--muted"><span>x</span><span>Pf&auml;ffikon</span><span>100%</span><span>Befristet</span></p> -->
        <h1 class="mbottom--small">Real Title</h1>
        <p class="section__header__subtitle text--muted"><span>m/w/d</span><span>Herisau (AR)</span><span>80%</span><span>Unbefristet</span></p>`;
      const { title, spans } = extractHeaderMeta(html);
      expect(title).toBe('Real Title');
      expect(spans[3]).toBe('Unbefristet');
    });
  });

  describe('extractDetailSections', () => {
    it('extracts h4/p body sections in order', () => {
      const html = `
        <div class="section__main__row__column">
          <h4>Ihr Aufgabengebiet</h4><p>Montage von Kabelkonfektionen und Steckverbindern.</p>
        </div>
        <div class="section__main__row__column">
          <h4>Ihr Profil</h4><p>Abgeschlossene Grundbildung im technischen Bereich.</p>
        </div>
        <div class="section__main__row__column">
          <h4>Wieso HUBER+SUHNER?</h4><p>Weil wir Technologie mit Verantwortung verbinden.</p>
        </div>`;
      const sections = extractDetailSections(html);
      expect(sections).toHaveLength(3);
      expect(sections[0]).toContain('Ihr Aufgabengebiet');
      expect(sections[0]).toContain('Montage von Kabelkonfektionen');
      expect(sections[2]).toContain('Wieso HUBER+SUHNER?');
    });

    it('returns an empty array (not throw) for unrecognised markup', () => {
      expect(extractDetailSections('<div>no h4/p pairs here</div>')).toEqual([]);
    });

    it('strips stale HTML-comment leftover sections before extraction', () => {
      const html = `
        <!-- <h4>Old Heading</h4><p>Stale leftover body text.</p> -->
        <h4>Ihr Profil</h4><p>Live body text that must be kept.</p>`;
      const sections = extractDetailSections(html);
      expect(sections).toHaveLength(1);
      expect(sections[0]).not.toContain('Stale leftover');
      expect(sections[0]).toContain('Live body text');
    });
  });
});
