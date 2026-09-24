import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  HELSANA_KEY,
  HELSANA_COMPANY_NAME,
  fetchAllHelsanaJobs,
  isHelsanaJob,
  isTrustedDomain,
} from '../scripts/lib/helsana-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { parseCsbDetailPage } from '../scripts/lib/successfactors-shared-job-parser-common.mjs';

describe('Helsana crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HELSANA_KEY).toBe('helsana');
    expect(HELSANA_COMPANY_NAME).toBe('Helsana');
  });

  // ── isCompanyJob ──
  describe('isHelsanaJob', () => {
    it('matches by companyKey', () => {
      expect(isHelsanaJob({ companyKey: 'helsana' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHelsanaJob({ company: 'Helsana' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHelsanaJob({ url: 'https://helsana.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHelsanaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHelsanaJob(null)).toBe(false);
      expect(isHelsanaJob(undefined)).toBe(false);
      expect(isHelsanaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://helsana.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.helsana.ch/job/456')).toBe(true);
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
      expect(slugify('Developer helsana ch')).toBe('developer-helsana-ch');
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
      id: 'helsana-abc123',
      slug: 'test-position-helsana-ch',
      slugByLocale: { de: 'test-position-helsana-ch' },
      company: 'Helsana',
      companyKey: 'helsana',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://helsana.ch/jobs/test',
      source: 'Helsana Dedicated Parser',
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
      expect(validJob.id).toMatch(/^helsana-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Regression: microdata-only detail pages (issue #2823) ──
  // Live careers.helsana.ch job pages dropped `data-careersite-propertyid`
  // entirely and now express the description purely via schema.org
  // microdata (`itemprop="description"`, nested `<span>`/`<p>` blocks). The
  // shared CSB parser used to return an empty description in that case,
  // which tripped the downstream ≥30-unique-word boilerplate guard and
  // shipped synthesized filler instead of the real job text.
  describe('parseCsbDetailPage — itemprop="description" fallback (no propertyid)', () => {
    const microdataOnlyHtml = `
      <html lang="de"><body>
        <div class="jobDisplayShell" itemscope itemtype="http://schema.org/JobPosting">
          <span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
            <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
              <meta itemprop="streetAddress" content="Zürich, ZH, CH, 8000">
            </span>
          </span>
          <meta itemprop="datePosted" content="Fri Jul 03 02:00:00 UTC 2026">
          <meta itemprop="hiringOrganization" content="Helsana Versicherungen AG">
          <h1 id="job-title" itemprop="title">Sachbearbeiter Leistungen (a) 80-100%</h1>
          <span itemprop="description" class="jobdescription">
            <p><span style="font-size:18px"><strong>Machen Sie den Unterschied</strong></span></p>
            <p>Helsana ist führend im Schweizer Gesundheitswesen. Sie übernehmen die
            fallabschliessende Bearbeitung von Leistungsfällen in der Grundversicherung,
            beraten unsere Kundinnen und Kunden kompetent am Telefon und arbeiten eng mit
            internen Fachstellen zusammen, um eine hohe Servicequalität sicherzustellen.</p>
            <p>Wir bieten Ihnen ein modernes Arbeitsumfeld, flexible Arbeitszeiten und
            vielfältige Weiterbildungsmöglichkeiten in einem motivierten Team.</p>
          </span>
          <p class="job-location"><span class="jobmarkets"></span></p>
        </div>
      </body></html>
    `;

    it('extracts the real description text via itemprop fallback, not boilerplate', () => {
      const detail = parseCsbDetailPage(microdataOnlyHtml);
      expect(detail.descriptionText).toContain('fallabschliessende Bearbeitung');
      expect(detail.descriptionText).toContain('Weiterbildungsmöglichkeiten');
      const uniqueWords = new Set(
        detail.descriptionText.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
      );
      expect(uniqueWords.size).toBeGreaterThanOrEqual(30);
    });

    it('does not truncate at the first nested close tag', () => {
      const detail = parseCsbDetailPage(microdataOnlyHtml);
      // A naive non-greedy `itemprop="description"[^>]*?>([\s\S]*?)</` scan
      // would stop right after "Machen Sie den Unterschied" (first </span>).
      expect(detail.descriptionText.length).toBeGreaterThan(100);
    });

    it('still extracts datePosted via the content attribute (no regression)', () => {
      const detail = parseCsbDetailPage(microdataOnlyHtml);
      expect(detail.postedDate).toBe('2026-07-03');
    });
  });
});

describe('Helsana — hybrid-work location suffix (issue 5253)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const row = (id: string, title: string, location: string) => `
    <tr class="data-row">
      <td class="colTitle"><span class="jobTitle hidden-phone"><a href="/job/${encodeURIComponent(location)}-${id}/${id}/" class="jobTitle-link">${title}</a></span></td>
      <td class="colLocation hidden-phone" headers="hdrLocation"><span class="jobLocation"> ${location} </span></td>
      <td class="colDate hidden-phone"><span class="jobDate">24.09.2026</span></td>
    </tr>`;

  it('publishes the city before "& Homeoffice" with its own canton, not the HQ canton label', async () => {
    // Forme reali di careers.helsana.ch (2026-09-24): prima uscivano `Zurigo`
    // (Worblaufen, cantone di ripiego ZH) e `Grigioni` (Chur).
    const search = `<table><tbody>
      ${row('1429174233', 'Beratende Ärztin Krankentaggeld (a) 10-20%', 'Worblaufen &amp; Homeoffice')}
      ${row('1410914233', 'Versicherungsberater im Aussendienst (a) 80-100%', 'Chur &amp; Homeoffice')}
      ${row('1419913533', 'Junior IT Security Architect (a) 80-100%', 'Dübendorf-Stettbach &amp; Homeoff')}
    </tbody></table>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes('/search/')) {
        return new Response(href.includes('startrow=0') ? search : '<table></table>', { status: 200 });
      }
      return new Response('<html lang="de-DE"><body><h1>Stelle</h1></body></html>', { status: 200 });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const jobs = await fetchAllHelsanaJobs();
    const byLocation = Object.fromEntries(jobs.map((job: any) => [job.location, job.canton]));
    expect(byLocation).toEqual({ Worblaufen: 'BE', Chur: 'GR', 'Dübendorf-Stettbach': 'ZH' });
  });
});
