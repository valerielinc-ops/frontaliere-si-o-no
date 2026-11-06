import { afterEach, describe, it, expect, vi } from 'vitest';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import {
  STIFTUNG_DIACONIS_KEY,
  STIFTUNG_DIACONIS_COMPANY_NAME,
  LISTING_URL,
  LISTING_API_URL,
  isStiftungDiaconisJob,
  isTrustedDomain,
  parseListing,
  parseApiListing,
  parseApiDescription,
  parseDetailDescription,
  fetchAllStiftungDiaconisJobs,
} from '../scripts/lib/stiftung-diaconis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Stiftung Diaconis crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STIFTUNG_DIACONIS_KEY).toBe('stiftung-diaconis');
    expect(STIFTUNG_DIACONIS_COMPANY_NAME).toBe('Stiftung Diaconis');
  });

  it('uses the canonical public JobPortal listing and API', () => {
    expect(LISTING_URL).toBe('https://karriere.diaconis.ch/job-overview');
    expect(LISTING_API_URL).toContain('api.jobportal.abaservices.ch/api/publication/publications/job-portal/');
    expect(LISTING_API_URL).toContain(encodeURIComponent(LISTING_URL));
  });

  // ── isCompanyJob ──
  describe('isStiftungDiaconisJob', () => {
    it('matches by companyKey', () => {
      expect(isStiftungDiaconisJob({ companyKey: 'stiftung-diaconis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStiftungDiaconisJob({ company: 'Stiftung Diaconis' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStiftungDiaconisJob({ url: 'https://diaconis.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStiftungDiaconisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStiftungDiaconisJob(null)).toBe(false);
      expect(isStiftungDiaconisJob(undefined)).toBe(false);
      expect(isStiftungDiaconisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://diaconis.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.diaconis.ch/job/456')).toBe(true);
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
      expect(slugify('Developer stiftung-diaconis ch')).toBe('developer-stiftung-diaconis-ch');
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
      id: 'stiftung-diaconis-abc123',
      slug: 'test-position-stiftung-diaconis-ch',
      slugByLocale: { de: 'test-position-stiftung-diaconis-ch' },
      company: 'Stiftung Diaconis',
      companyKey: 'stiftung-diaconis',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://diaconis.ch/jobs/test',
      source: 'Stiftung Diaconis Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stiftung-diaconis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('parseListing', () => {
    const fixture = `
      <a href="https://diaconis.abacuscity.ch/de/job_1_86/K%C3%B6chin-Koch-100%25">K&ouml;chin / Koch 100%</a>
      <a href="https://diaconis.abacuscity.ch/de/job_1_129/Dipl.-Pflegefachfrau-Pflegefachmann-HF-FH-Pall">Dipl. Pflegefachfrau / Pflegefachmann HF / FH Palliative Care</a>
      <a href="https://diaconis.abacuscity.ch/de/job_1_2/Spontanbewerbung">Spontanbewerbung</a>
      <a href="https://diaconis.abacuscity.ch/de/job_1_4/Spontananfrage-Freiwilliges-Engagement">Spontananfrage Freiwilliges Engagement</a>
      <a href="https://diaconis.abacuscity.ch/de/job_1_95/Berufswahlpraktikum-Schnuppern">Berufswahlpraktikum (Schnuppern) als Köchin</a>
      <a href="https://diaconis.abacuscity.ch/de/job_1_86/K%C3%B6chin-Koch-100%25">K&ouml;chin / Koch 100%</a>
    `;

    it('keeps real openings and drops Spontan / Schnupper / Berufswahlpraktikum', () => {
      const rows = parseListing(fixture);
      expect(rows.length).toBe(2);
      expect(rows[0].jobId).toBe('86');
      expect(rows[0].title).toBe('Köchin / Koch 100%');
      expect(rows[1].jobId).toBe('129');
      expect(rows[1].title).toContain('Pflegefachfrau');
    });

    it('returns empty array when no abacuscity anchors present', () => {
      expect(parseListing('<a href="https://other.example/x">foo</a>')).toEqual([]);
    });

    it('normalizes relative and single-quoted portal links', () => {
      const rows = parseListing(`
        <a class="job-link" href="/de/job_1_130/Dipl.-Pflegefachfrau">Nachtdienst</a>
        <a href='/de/job_1_103/Poolmitarbeiter-in-Pflege'>Poolmitarbeiter/in Pflege</a>
      `);
      expect(rows).toEqual([
        {
          url: 'https://diaconis.abacuscity.ch/de/job_1_130/Dipl.-Pflegefachfrau',
          jobId: '130',
          title: 'Nachtdienst',
        },
        {
          url: 'https://diaconis.abacuscity.ch/de/job_1_103/Poolmitarbeiter-in-Pflege',
          jobId: '103',
          title: 'Poolmitarbeiter/in Pflege',
        },
      ]);
    });

    it('rejects same-shaped links outside the trusted portal host', () => {
      expect(parseListing('<a href="https://example.com/de/job_1_130/Nachtdienst">Nachtdienst</a>')).toEqual([]);
    });
  });

  describe('parseDetailDescription', () => {
    const fixture = `
      <div class="col-xs-12 introduction">Diaconis ist eine Stiftung in Bern.</div>
      <div class="col-xs-12 jobtitle">Köchin / Koch 100%</div>
      <div class="col-xs-12 tasks"><ul><li>Speisen zubereiten</li></ul></div>
      <div class="col-xs-12 benefits">Attraktive Anstellungsbedingungen.</div>
      <div class="col-xs-12 requirements">Abgeschlossene Ausbildung als Köchin / Koch EFZ.</div>
      <div class="col-xs-12 contact">Marcel Spring, Leiter Küche.</div>
      <div class="col-xs-12 closure">Wir freuen uns auf deine Bewerbung.</div>
    `;

    it('concatenates every known section in order', () => {
      const text = parseDetailDescription(fixture);
      expect(text).toContain('Diaconis ist eine Stiftung');
      expect(text).toContain('Köchin / Koch 100%');
      expect(text).toContain('Speisen zubereiten');
      expect(text).toContain('Attraktive Anstellungsbedingungen');
      expect(text).toContain('Abgeschlossene Ausbildung');
      expect(text).toContain('Marcel Spring');
      expect(text).toContain('Bewerbung');
    });

    it('falls back to <main> when no col-xs-12 section divs exist', () => {
      const html = '<main>Bare main content here.</main>';
      expect(parseDetailDescription(html)).toContain('Bare main content');
    });

    it('returns empty when no main and no sections', () => {
      expect(parseDetailDescription('<div>nothing useful</div>')).toBe('');
    });
  });

  describe('Abacus JobPortal API', () => {
    const apiRecord = {
      PublicationId: 'publication-123',
      JobTitle: 'Köchin / Koch 60 %',
      PublicationUrlAbacusJobPortal: 'https://karriere.diaconis.ch/job-advertisement/publication-123',
      ApplicationUrl: 'https://karriere.diaconis.ch/application-process/publication-123',
      PlaceOfWorkCity: 'Bern',
      PlaceOfWorkState: 'BE',
      PlaceOfWorkZip: '3013',
      PublicationStartDateSortkey: '2026-10-28',
      Introduction: '&lt;p&gt;Wir suchen eine engagierte Person.&lt;/p&gt;',
      Tasks: '&lt;ul&gt;&lt;li&gt;Speisen zubereiten&lt;/li&gt;&lt;li&gt;Team unterstützen&lt;/li&gt;&lt;/ul&gt;',
      Requirements: '&lt;p&gt;Ausbildung als Köchin oder Koch.&lt;/p&gt;',
      Benefits: '&lt;p&gt;Mindestens sechs Wochen Ferien.&lt;/p&gt;',
      Contact: '&lt;p&gt;HR Diaconis&lt;/p&gt;',
    };

    it('keeps trusted real openings and drops spontaneous/non-trusted records', () => {
      const rows = parseApiListing([
        apiRecord,
        { ...apiRecord, PublicationId: 'spontaneous', JobTitle: 'Spontanbewerbung' },
        { ...apiRecord, PublicationId: 'external', PublicationUrlAbacusJobPortal: 'https://example.com/job/1' },
        { ...apiRecord, JobTitle: 'Duplicate title' },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        jobId: 'publication-123',
        title: 'Köchin / Koch 60 %',
        url: apiRecord.PublicationUrlAbacusJobPortal,
      });
      expect(rows[0].sourceRecord).toBe(apiRecord);
    });

    it('decodes the API HTML fields and preserves reported publication dates', () => {
      const parsed = parseApiDescription(apiRecord);
      expect(parsed.body).not.toContain('&lt;');
      expect(parsed.body).not.toContain('<p>');
      expect(parsed.body).toContain('Wir suchen eine engagierte Person');
      expect(parsed.body).toContain('• Speisen zubereiten');
      expect(parsed.body).toContain('Mindestens sechs Wochen');
      expect(parsed).toMatchObject({
        datePosted: '2026-10-28',
        postedDate: '2026-10-28',
        postingDateSource: 'reported',
      });
    });

    it('marks only a successful explicit API zero as an authoritative empty snapshot', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const jobs = await fetchAllStiftungDiaconisJobs({ fetchApi: async () => [] });
      expect(jobs).toEqual([]);
      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    });

    it('fails closed when the API and legacy fallback both yield no trusted rows', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(fetchAllStiftungDiaconisJobs({
        fetchApi: async () => { throw new Error('temporary API failure'); },
        fetchLegacyHtml: async () => '<html><body>No trusted job rows</body></html>',
      })).rejects.toThrow(/fail-closed; source state is not proven empty/);
    });
  });
});
