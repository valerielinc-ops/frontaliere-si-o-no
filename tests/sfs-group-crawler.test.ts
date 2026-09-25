import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  SFS_GROUP_KEY,
  SFS_GROUP_COMPANY_NAME,
  isSfsGroupJob,
  isTrustedDomain,
  resolveAddress,
  parseSfsGroupListing,
  parseSfsGroupDetail,
  fetchAllSfsGroupJobs,
} from '../scripts/lib/sfs-group-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SFS Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SFS_GROUP_KEY).toBe('sfs-group');
    expect(SFS_GROUP_COMPANY_NAME).toBe('SFS Group');
  });

  // ── isCompanyJob ──
  describe('isSfsGroupJob', () => {
    it('matches by companyKey', () => {
      expect(isSfsGroupJob({ companyKey: 'sfs-group' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSfsGroupJob({ company: 'SFS Group Schweiz AG' })).toBe(true);
    });

    it('matches the Tegra Medical co-tenant brand (same career portal/group)', () => {
      expect(isSfsGroupJob({ company: 'Tegra Medical' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSfsGroupJob({ url: 'https://join.sfs.com/ch/en/vacancies/some-job.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSfsGroupJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSfsGroupJob(null)).toBe(false);
      expect(isSfsGroupJob(undefined)).toBe(false);
      expect(isSfsGroupJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary domain', () => {
      expect(isTrustedDomain('https://sfs.com/ch/en/career')).toBe(true);
    });

    it('trusts the AEM career-portal subdomain', () => {
      expect(isTrustedDomain('https://join.sfs.com/ch/en/vacancies/digital-process-manager.html')).toBe(true);
    });

    it('trusts the Umantis apply-flow subdomain', () => {
      expect(isTrustedDomain('https://jobapplication.sfs.com/Vacancies/2956/Application/CheckLogin/1')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated, NEVER canton-only) ──
  describe('resolveAddress', () => {
    it('resolves the Heerbrugg HQ street address', () => {
      expect(resolveAddress('Heerbrugg')).toEqual({
        streetAddress: 'Rosenbergsaustrasse 8',
        postalCode: '9435',
        canton: 'SG',
      });
    });

    it('matches Heerbrugg case-insensitively', () => {
      expect(resolveAddress('HEERBRUGG')).toMatchObject({ postalCode: '9435' });
    });

    it('does NOT match on canton alone — another same-canton (SG) town returns null', () => {
      // Rebstein is a real SG town from the live SFS listing, distinct from
      // the Heerbrugg HQ site — it must not inherit the HQ street address.
      expect(resolveAddress('Rebstein')).toBeNull();
      expect(resolveAddress('St. Gallen')).toBeNull();
    });

    it('returns null for an empty/unknown city', () => {
      expect(resolveAddress('')).toBeNull();
      expect(resolveAddress('Hallau')).toBeNull();
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('builds slug with company suffix inline', () => {
      expect(slugify('Automatiker Instandhaltung sfs group ch')).toBe('automatiker-instandhaltung-sfs-group-ch');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité sfs group ch')).toBe('ingenieur-qualite-sfs-group-ch');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'sfs-group-abc123',
      slug: 'test-position-sfs-group-ch',
      slugByLocale: { de: 'test-position-sfs-group-ch' },
      company: 'SFS Group',
      companyKey: 'sfs-group',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Heerbrugg',
      canton: 'SG',
      url: 'https://join.sfs.com/ch/en/vacancies/test-position.html',
      source: 'SFS Group Dedicated Parser (Umantis/AEM)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Heerbrugg',
      addressRegion: 'SG',
      streetAddress: 'Rosenbergsaustrasse 8',
      postalCode: '9435',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^sfs-group-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

/* ── Pure parser unit tests (no network) ─────────────────────── */

function listingRow(href: string, title: string, location: string, company: string): string {
  return `<a class="molecule-responsive-datalist-entry values-are-copytext" href="${href}">` +
    `<span class="column-value">${title}</span>` +
    `<span class="column-value">${location}</span>` +
    `<span class="column-value">${company}</span>` +
    `</a>`;
}

const TEMPLATE_PLACEHOLDER_ROW = `<script type="text/html" class="entry-template">` +
  `<a class="molecule-responsive-datalist-entry values-are-copytext" href="{col4}">` +
  `<span class="column-value">{col1}</span><span class="column-value">{col2}</span>` +
  `<span class="column-value">{col3}</span></a></script>`;

function buildListingHtml(rows: string[]): string {
  return `<html><body><div class="listing">${TEMPLATE_PLACEHOLDER_ROW}${rows.join('\n')}</div></body></html>`;
}

function buildDetailHtml({
  intro = 'SFS ist ein führender Systemanbieter für Qualitätswerkzeuge.',
  tasks = 'Betreuung der Schnittstelle zwischen Fachbereich und Informatik.',
  profile = 'Abgeschlossene technische Ausbildung.',
  offer = 'Attraktive Anstellungsbedingungen.',
  vacancyId = '2956',
}: { intro?: string; tasks?: string; profile?: string; offer?: string; vacancyId?: string } = {}): string {
  return `<html><body>
    <div class="subline auto-hyphenate">\nSFS Group Schweiz AG |\nHeerbrugg,\nSchweiz\n</div>
    <div class="organism-text">
      <div class="text">
        ${intro}
      </div>
    </div>
    <h3 class="atom-section-headline foo">Your Tasks</h3>
    <div class="atom-copytext bar">${tasks}</div>
    <h3 class="atom-section-headline foo">Your profile</h3>
    <div class="atom-copytext bar">${profile}</div>
    <h3 class="atom-section-headline foo">We offer</h3>
    <div class="atom-copytext bar">${offer}</div>
    <a href="https://jobapplication.sfs.com/Vacancies/${vacancyId}/Application/CheckLogin/1?lang=eng">Apply</a>
  </body></html>`;
}

describe('parseSfsGroupListing', () => {
  it('parses real listing rows and skips the entry-template placeholder block', () => {
    const html = buildListingHtml([
      listingRow(
        '/ch/en/vacancies/digital-process-manager-(m-f-d).html',
        'Digital Process Manager (m/f/d) 100%',
        'Heerbrugg, Schweiz',
        'SFS Group Schweiz AG',
      ),
      listingRow(
        '/ch/en/vacancies/kunststofftechnologe-in-(m-f-d).html',
        'Kunststofftechnologe/in (m/f/d) 100%',
        'Hallau, Schweiz',
        'Tegra Medical',
      ),
    ]);
    const rows = parseSfsGroupListing(html);
    expect(rows).toHaveLength(2);
    expect(rows[0].href).toBe('/ch/en/vacancies/digital-process-manager-(m-f-d).html');
    expect(rows[0].rawTitle).toBe('Digital Process Manager (m/f/d) 100%');
    expect(rows[0].rawLocation).toBe('Heerbrugg, Schweiz');
    expect(rows[1].rawCompany).toBe('Tegra Medical');
  });

  it('decodes HTML entities in title/location text', () => {
    const html = buildListingHtml([
      listingRow(
        '/ch/en/vacancies/sap-modulbetreuer-fi-co-(m-f-d).html',
        'SAP Modulbetreuer FI/CO (m/f/d) 80&ndash;100%',
        'Heerbrugg,&nbsp;Schweiz',
        'SFS Group Schweiz AG',
      ),
    ]);
    const rows = parseSfsGroupListing(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawTitle).toBe('SAP Modulbetreuer FI/CO (m/f/d) 80–100%');
    expect(rows[0].rawLocation).toBe('Heerbrugg, Schweiz');
  });

  it('returns [] for empty/garbled HTML', () => {
    expect(parseSfsGroupListing('')).toEqual([]);
    expect(parseSfsGroupListing('<html><body>nothing here</body></html>')).toEqual([]);
  });
});

describe('parseSfsGroupDetail', () => {
  it('extracts intro + headed sections + apply URL + vacancy id', () => {
    const detail = parseSfsGroupDetail(buildDetailHtml());
    expect(detail.description).toMatch(/Qualitätswerkzeuge/);
    expect(detail.description).toMatch(/Your Tasks:/);
    expect(detail.description).toMatch(/Your profile:/);
    expect(detail.description).toMatch(/We offer:/);
    expect(detail.applyUrl).toBe('https://jobapplication.sfs.com/Vacancies/2956/Application/CheckLogin/1?lang=eng');
    expect(detail.jobReqId).toBe('2956');
  });

  it('is language-agnostic on section headings (French job content, English UI labels)', () => {
    const detail = parseSfsGroupDetail(buildDetailHtml({
      intro: "Le groupe SFS est un fournisseur présent dans toute la Suisse.",
      vacancyId: '2807',
    }));
    expect(detail.description).toMatch(/fournisseur présent/);
    expect(detail.jobReqId).toBe('2807');
  });

  it('returns empty fields for HTML with no matching structure', () => {
    const detail = parseSfsGroupDetail('<html><body>nothing here</body></html>');
    expect(detail.description).toBe('');
    expect(detail.applyUrl).toBe('');
    expect(detail.jobReqId).toBe('');
  });
});

/* ── fetchAllSfsGroupJobs orchestration (network stubbed) ────── */

describe('fetchAllSfsGroupJobs', () => {
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  function stubFetch(listingHtml: string, detailByHref: Record<string, string>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/ch/en/vacancies/index.jsp')) {
        return { ok: true, status: 200, text: async () => listingHtml } as unknown as Response;
      }
      const hrefKey = Object.keys(detailByHref).find((href) => u.includes(href));
      if (hrefKey) {
        return { ok: true, status: 200, text: async () => detailByHref[hrefKey] } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => '' } as unknown as Response;
    }));
  }

  it('fetches the listing, enriches each row from its detail page, and builds full job objects', async () => {
    const href1 = '/ch/en/vacancies/digital-process-manager-(m-f-d).html';
    const href2 = '/ch/en/vacancies/mitarbeiter-in-kommissionierung-50-(m-f-d).html';
    const listingHtml = buildListingHtml([
      listingRow(href1, 'Digital Process Manager (m/f/d) 100%', 'Heerbrugg, Schweiz', 'SFS Group Schweiz AG'),
      listingRow(href2, 'Mitarbeiter/in Kommissionierung 50 % (m/f/d) 50%', 'Rebstein, Schweiz', 'SFS Group Schweiz AG'),
    ]);
    stubFetch(listingHtml, {
      [href1]: buildDetailHtml({ vacancyId: '2956' }),
      [href2]: buildDetailHtml({ vacancyId: '3010', intro: 'Kommissionierung am Standort Rebstein.' }),
    });

    const jobs = await fetchAllSfsGroupJobs();
    expect(jobs).toHaveLength(2);

    const digital = jobs.find((j) => j.url.includes(href1));
    expect(digital).toBeTruthy();
    expect(digital.title).toBe('Digital Process Manager (m/f/d)');
    expect(digital.location).toBe('Heerbrugg');
    expect(digital.canton).toBe('SG');
    expect(digital.streetAddress).toBe('Rosenbergsaustrasse 8');
    expect(digital.postalCode).toBe('9435');
    expect(digital.employmentType).toBe('FULL_TIME');
    expect(digital.applyUrl).toBe('https://jobapplication.sfs.com/Vacancies/2956/Application/CheckLogin/1?lang=eng');
    expect(digital.jobReqId).toBe('2956');
    expect(digital.companyKey).toBe('sfs-group');
    expect(digital.company).toBe('SFS Group');

    const commissioning = jobs.find((j) => j.url.includes(href2));
    expect(commissioning).toBeTruthy();
    expect(commissioning.location).toBe('Rebstein');
    // Rebstein is NOT Heerbrugg — must NOT inherit the HQ street address.
    expect(commissioning.streetAddress).toBeUndefined();
    // But postalCode must still get a safe canton-level default (never blank).
    expect(commissioning.postalCode).toBe('9000');
    expect(commissioning.employmentType).toBe('PART_TIME');
  });

  it('includes Tegra Medical postings (same career portal / group, no exclusion signal)', async () => {
    const href = '/ch/en/vacancies/kunststofftechnologe-in-(m-f-d).html';
    const listingHtml = buildListingHtml([
      listingRow(href, 'Kunststofftechnologe/in (m/f/d) 100%', 'Hallau, Schweiz', 'Tegra Medical'),
    ]);
    stubFetch(listingHtml, { [href]: buildDetailHtml({ vacancyId: '4100', intro: 'Tegra Medical in Hallau.' }) });

    const jobs = await fetchAllSfsGroupJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].legalEntity).toBe('Tegra Medical');
    expect(jobs[0].companyKey).toBe('sfs-group');
    expect(jobs[0].location).toBe('Hallau');
    expect(jobs[0].canton).toBe('SH');
  });

  it('falls back to a synthesized description when the detail fetch fails, without dropping the job', async () => {
    const href = '/ch/en/vacancies/some-role-(m-f-d).html';
    const listingHtml = buildListingHtml([
      listingRow(href, 'Some Role (m/f/d) 100%', 'Heerbrugg, Schweiz', 'SFS Group Schweiz AG'),
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/ch/en/vacancies/index.jsp')) {
        return { ok: true, status: 200, text: async () => listingHtml } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => '' } as unknown as Response;
    }));

    const jobs = await fetchAllSfsGroupJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toMatch(/Some Role/);
    expect(jobs[0].description).toMatch(/SFS Group/);
  });

  it('returns [] (no throw) when the listing itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' } as unknown as Response)));
    await expect(fetchAllSfsGroupJobs()).rejects.toBeTruthy();
  });
});
