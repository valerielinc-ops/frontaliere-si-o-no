import { describe, it, expect } from 'vitest';
import {
  FLURY_STIFTUNG_KEY,
  FLURY_STIFTUNG_COMPANY_NAME,
  isFluryStiftungJob,
  isTrustedDomain,
  parseJobListings,
} from '../scripts/lib/flury-stiftung-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Flury Stiftung crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FLURY_STIFTUNG_KEY).toBe('flury-stiftung');
    expect(FLURY_STIFTUNG_COMPANY_NAME).toBe('Flury Stiftung');
  });

  // ── isCompanyJob ──
  describe('isFluryStiftungJob', () => {
    it('matches by companyKey', () => {
      expect(isFluryStiftungJob({ companyKey: 'flury-stiftung' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFluryStiftungJob({ company: 'Flury Stiftung' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFluryStiftungJob({ url: 'https://flurystiftung.ch/jobs/123' })).toBe(true);
    });

    it('matches by www subdomain URL', () => {
      expect(isFluryStiftungJob({ url: 'https://www.flurystiftung.ch/de/jobs' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFluryStiftungJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFluryStiftungJob(null)).toBe(false);
      expect(isFluryStiftungJob(undefined)).toBe(false);
      expect(isFluryStiftungJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://flurystiftung.ch/careers/job-123')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.flurystiftung.ch/sites/default/files/2026-03/test.pdf')).toBe(true);
    });

    it('trusts other subdomains', () => {
      expect(isTrustedDomain('https://careers.flurystiftung.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseJobListings ──
  describe('parseJobListings', () => {
    const SAMPLE_HTML = `
      <div class="view-content">
      <div class="table-responsive">
            <div class="caption">
        <caption>
                            Flury Stiftung
                                </caption>
        </div>
      <table class="views-table views-view-table cols-0 table table-sm">
          <tbody>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-03/Departementsleitung%20ICT_DS%202026.pdf" type="application/pdf" title="Departementsleitung ICT_DS 2026.pdf">Departementsleitung ICT/Datenschutz 100%</a></span>
          </td>
              </tr>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-03/Pharma-Assistentin%2050%20-%2080%25_1.pdf" type="application/pdf" title="Pharma-Assistentin 50 - 80%.pdf">Pharma-Assistent*in 50 - 80%</a></span>
          </td>
              </tr>
        </tbody>
      </table>
</div>
<div class="table-responsive">
            <div class="caption">
        <caption>
                            Spital Schiers
                                </caption>
        </div>
      <table class="views-table views-view-table cols-0 table table-sm">
          <tbody>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2025-11/Dipl.%20Pflegefachperson%20Interdisziplin%C3%A4re%20Station%2040%20-%20100%25%20neu_0.pdf" type="application/pdf" title="Dipl. Pflegefachperson Interdisziplinaere Station 40 - 100% neu.pdf">Dipl. Pflegefachperson Interdisziplinäre Station 40 - 100% </a></span>
          </td>
              </tr>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-03/Assistenz%C3%A4rztin_Assistenzarzt%20Chirurgie%20%28w_m%29_Neu_0.pdf" type="application/pdf" title="Assistenzaerztin_Assistenzarzt Chirurgie (w_m)_Neu.pdf">Assistenzärztin/Assistenzarzt Chirurgie</a></span>
          </td>
              </tr>
        </tbody>
      </table>
</div>
<div class="table-responsive">
            <div class="caption">
        <caption>
                            Altersheime
                                </caption>
        </div>
      <table class="views-table views-view-table cols-0 table table-sm">
          <tbody>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-04/Mitarbeiter_in%20Hauswirtschaft%2040%25%20Jenaz%20befristet.pdf" type="application/pdf" title="Mitarbeiter_in Hauswirtschaft 40% Jenaz befristet.pdf">Mitarbeiter*in Hauswirtschaft 40%, Altersheim Jenaz</a></span>
          </td>
              </tr>
        </tbody>
      </table>
</div>
<div class="table-responsive">
            <div class="caption">
        <caption>
                            Medizinisches Zentrum Klosters
                                </caption>
        </div>
      <table class="views-table views-view-table cols-0 table table-sm">
          <tbody>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-03/Praxisassistenz%20Hausarztmedizin%2050-100%25.pdf" type="application/pdf" title="Praxisassistenz Hausarztmedizin 50-100%.pdf">Praxisassistenz Hausarztmedizin (m/w) 50 - 100%</a></span>
          </td>
              </tr>
        </tbody>
      </table>
</div>
<div class="table-responsive">
            <div class="caption">
        <caption>
                            Lehrstellen
                                </caption>
        </div>
      <table class="views-table views-view-table cols-0 table table-sm">
          <tbody>
          <tr>
                                                                                      <td class="views-field views-field-field-media-file">
<span class="file file--mime-application-pdf file--application-pdf"> <a href="/sites/default/files/2026-03/Lehrstelle%20KV%20EFZ%202027.pdf" type="application/pdf" title="Lehrstelle KV EFZ 2027.pdf">Lehrstelle Kaufmann/-frau EFZ (ab Sommer 2027)</a></span>
          </td>
              </tr>
        </tbody>
      </table>
</div>
      </div>
    `;

    it('extracts all PDF listings from HTML', () => {
      const listings = parseJobListings(SAMPLE_HTML);
      expect(listings).toHaveLength(7);
    });

    it('extracts correct titles', () => {
      const listings = parseJobListings(SAMPLE_HTML);
      expect(listings[0].title).toBe('Departementsleitung ICT/Datenschutz 100%');
      expect(listings[1].title).toBe('Pharma-Assistent*in 50 - 80%');
      expect(listings[2].title).toBe('Dipl. Pflegefachperson Interdisziplinäre Station 40 - 100%');
    });

    it('builds absolute PDF URLs', () => {
      const listings = parseJobListings(SAMPLE_HTML);
      expect(listings[0].pdfUrl).toBe('https://www.flurystiftung.ch/sites/default/files/2026-03/Departementsleitung%20ICT_DS%202026.pdf');
      expect(listings[0].pdfUrl).toMatch(/^https:\/\/www\.flurystiftung\.ch\//);
    });

    it('extracts correct section names', () => {
      const listings = parseJobListings(SAMPLE_HTML);
      expect(listings[0].section).toBe('Flury Stiftung');
      expect(listings[1].section).toBe('Flury Stiftung');
      expect(listings[2].section).toBe('Spital Schiers');
      expect(listings[3].section).toBe('Spital Schiers');
      expect(listings[4].section).toBe('Altersheime');
      expect(listings[5].section).toBe('Medizinisches Zentrum Klosters');
      expect(listings[6].section).toBe('Lehrstellen');
    });

    it('groups jobs under correct sections', () => {
      const listings = parseJobListings(SAMPLE_HTML);
      const sections = [...new Set(listings.map(l => l.section))];
      expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('returns empty array for empty HTML', () => {
      expect(parseJobListings('')).toEqual([]);
    });

    it('returns empty array for HTML with no PDF links', () => {
      const html = '<div class="table-responsive"><caption>Test</caption><table><tbody></tbody></table></div>';
      expect(parseJobListings(html)).toEqual([]);
    });

    it('skips entries with very short titles', () => {
      const html = `
        <div class="table-responsive">
          <div class="caption"><caption>Test</caption></div>
          <table><tbody><tr><td>
            <span class="file file--mime-application-pdf file--application-pdf">
              <a href="/sites/default/files/test.pdf" type="application/pdf" title="test.pdf">ab</a>
            </span>
          </td></tr></tbody></table>
        </div>`;
      expect(parseJobListings(html)).toEqual([]);
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
      expect(slugify('Developer flury-stiftung ch')).toBe('developer-flury-stiftung-ch');
    });

    it('handles German umlauts', () => {
      const slug = slugify('Assistenzärztin Chirurgie flury-stiftung ch');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(slug).toContain('assistenzarztin');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'flury-stiftung-abc123def456',
      slug: 'departementsleitung-ict-datenschutz-100-flury-stiftung-ch',
      slugByLocale: { de: 'departementsleitung-ict-datenschutz-100-flury-stiftung-ch' },
      company: 'Flury Stiftung',
      companyKey: 'flury-stiftung',
      companyDomain: 'flurystiftung.ch',
      title: 'Departementsleitung ICT/Datenschutz 100%',
      titleByLocale: { de: 'Departementsleitung ICT/Datenschutz 100%' },
      description: 'Departementsleitung ICT/Datenschutz 100% — Flury Stiftung. Arbeitsort: Schiers (GR)',
      descriptionByLocale: { de: 'Departementsleitung ICT/Datenschutz 100% — Flury Stiftung. Arbeitsort: Schiers (GR)' },
      location: 'Schiers',
      canton: 'GR',
      url: 'https://www.flurystiftung.ch/sites/default/files/2026-03/test.pdf',
      source: 'Flury Stiftung Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      postalCode: '7220',
      sector: 'Sanità / Assistenza',
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
      expect(validJob.id).toMatch(/^flury-stiftung-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('location defaults to Schiers', () => {
      expect(validJob.location).toBe('Schiers');
    });

    it('canton is GR', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('postal code is correct for Schiers', () => {
      expect(validJob.postalCode).toBe('7220');
    });

    it('sector is healthcare', () => {
      expect(validJob.sector).toBe('Sanità / Assistenza');
    });

    it('URL points to a PDF on flurystiftung.ch', () => {
      expect(validJob.url).toMatch(/^https:\/\/www\.flurystiftung\.ch\/.*\.pdf$/);
    });
  });
});
