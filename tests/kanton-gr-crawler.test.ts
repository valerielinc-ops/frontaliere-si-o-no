import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  KANTON_GR_KEY,
  KANTON_GR_COMPANY_NAME,
  isKantonGrJob,
  isTrustedDomain,
  fetchAllKantonGrJobs,
} from '../scripts/lib/kanton-gr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kantonale Verwaltung Graubünden crawler parser', () => {
  // -- Constants --
  it('exports valid company key and name', () => {
    expect(KANTON_GR_KEY).toBe('kanton-gr');
    expect(KANTON_GR_COMPANY_NAME).toBe('Kantonale Verwaltung Graubünden');
  });

  // -- isCompanyJob --
  describe('isKantonGrJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonGrJob({ companyKey: 'kanton-gr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonGrJob({ company: 'Kantonale Verwaltung Graubünden' })).toBe(true);
    });

    it('matches by Refline URL', () => {
      expect(isKantonGrJob({ url: 'https://apply.refline.ch/514915/2652/pub/1/index.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKantonGrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonGrJob(null)).toBe(false);
      expect(isKantonGrJob(undefined)).toBe(false);
      expect(isKantonGrJob({})).toBe(false);
    });
  });

  // -- isTrustedDomain --
  describe('isTrustedDomain', () => {
    it('trusts gr.ch primary domain', () => {
      expect(isTrustedDomain('https://gr.ch/careers/job-123')).toBe(true);
    });

    it('trusts gr.ch subdomains', () => {
      expect(isTrustedDomain('https://www.gr.ch/DE/Seiten/welcome.aspx')).toBe(true);
    });

    it('trusts refline.ch (ATS platform)', () => {
      expect(isTrustedDomain('https://apply.refline.ch/514915/2652/pub/1/index.html')).toBe(true);
    });

    it('trusts refline.ch root domain', () => {
      expect(isTrustedDomain('https://refline.ch/some-page')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains containing gr.ch as substring', () => {
      expect(isTrustedDomain('https://notgr.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // -- slugify (imported from crawler-template) --
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('handles German umlauts', () => {
      const slug = slugify('Staatsanwältinnen Graubünden');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain('ä');
      expect(slug).not.toContain('ü');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer kanton-gr ch')).toBe('developer-kanton-gr-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // -- Job Shape Validation --
  describe('job shape', () => {
    const validJob = {
      id: 'kanton-gr-abc123def456',
      slug: 'sachbearbeiter-in-kanton-gr-ch',
      slugByLocale: { de: 'sachbearbeiter-in-kanton-gr-ch' },
      company: 'Kantonale Verwaltung Graubünden',
      companyKey: 'kanton-gr',
      companyDomain: 'gr.ch',
      title: 'Sachbearbeiter/-in',
      titleByLocale: { de: 'Sachbearbeiter/-in' },
      description: 'Sachbearbeiter/-in -- Kantonale Verwaltung Graubünden. Amt: Sozialamt. Arbeitsort: Chur (GR)',
      descriptionByLocale: { de: 'Sachbearbeiter/-in -- Kantonale Verwaltung Graubünden. Amt: Sozialamt. Arbeitsort: Chur (GR)' },
      location: 'Chur',
      canton: 'GR',
      url: 'https://apply.refline.ch/514915/2635/pub/1/index.html',
      source: 'Kantonale Verwaltung Graubünden Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Chur',
      postalCode: '7000',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Amministrazione',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
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

    it('has all recommended fields', () => {
      const recommended = [
        'addressLocality', 'postalCode', 'addressCountry', 'country',
        'category', 'contract', 'employmentType', 'experienceLevel',
        'sector', 'currency',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-gr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description has minimum 30 chars', () => {
      expect(validJob.description.length).toBeGreaterThanOrEqual(30);
    });

    it('sector is Amministrazione Pubblica', () => {
      expect(validJob.sector).toBe('Amministrazione Pubblica');
    });

    it('URL points to Refline detail page', () => {
      expect(validJob.url).toContain('apply.refline.ch/514915');
    });
  });
});

// Only the posting's own text is published (issue 5253): a detail page without
// a body used to be replaced by a stub of listing metadata ("{title} --
// Kantonale Verwaltung Graubünden. Amt: … Arbeitsort: … Pensum: …"). Shapes of
// the Refline tenant (listing table, #bDescription/#bDuty detail blocks).
describe('fetchAllKantonGrJobs — listing without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.JOBS_CRAWLER_DELAY_MS;
  });

  it('publishes the listing with a body and skips the one without, never inventing text', async () => {
    process.env.JOBS_CRAWLER_DELAY_MS = '1';
    const row = (id: string, title: string) => `<tr class="even"><td class="position"><a href="https://apply.refline.ch/845721/${id}/pub/1/index.html">${title}</a></td>`
      + '<td class="department">Amt für Informatik</td><td class="workplace">Chur</td><td class="deadline">15.10.2026</td></tr>';
    const listing = `<table>${row('0101', 'Systemingenieur/in 80-100%')}${row('0102', 'Sachbearbeiter/in 60%')}</table>`;
    const detail = (withBody: boolean) => '<html><body><h1 id="bTitle">x</h1><h2 id="bSubTitle">Amt für Informatik | 80-100% | Chur</h2>'
      + (withBody ? '<div id="bDescription"><p>Sie betreiben die Server- und Netzwerkinfrastruktur der kantonalen Verwaltung. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig und bringen Ideen zur Verbesserung der Abläufe ein. Wir bieten flexible Arbeitszeiten, Weiterbildungen und ein kollegiales Team in einem modernen Umfeld.</p></div><div id="bDuty"><ul><li>Betrieb der Serverlandschaft</li><li>Projektarbeit im Team</li></ul></div>' : '')
      + '</body></html>';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('search.html')) return new Response(listing, { status: 200 });
      if (u.includes('apprentice.html') || u.includes('stage.html')) return new Response('<table></table>', { status: 200 });
      return new Response(detail(u.includes('/0101/')), { status: 200 });
    }));

    const jobs = await fetchAllKantonGrJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Systemingenieur/in 80-100%']);
    expect(jobs[0].description).toContain('Betrieb der Serverlandschaft');
    for (const job of jobs) expect(job.description).not.toMatch(/-- Kantonale Verwaltung Graubünden/);
  }, 20_000);
});
