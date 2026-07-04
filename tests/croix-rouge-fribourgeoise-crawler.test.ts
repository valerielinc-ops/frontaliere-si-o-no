import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  CROIX_ROUGE_FRIBOURGEOISE_KEY,
  CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME,
  CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN,
  isCroixRougeFribourgeoiseJob,
  isTrustedDomain,
  resolveAddress,
  extractListingLinks,
  fetchAllCroixRougeFribourgeoiseJobs,
} from '../scripts/lib/croix-rouge-fribourgeoise-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Croix-Rouge fribourgeoise crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(CROIX_ROUGE_FRIBOURGEOISE_KEY).toBe('croix-rouge-fribourgeoise');
    expect(CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME).toBe('Croix-Rouge fribourgeoise');
    expect(CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN).toBe('croix-rouge-fr.ch');
  });

  // ── isCompanyJob ──
  describe('isCroixRougeFribourgeoiseJob', () => {
    it('matches by companyKey', () => {
      expect(isCroixRougeFribourgeoiseJob({ companyKey: 'croix-rouge-fribourgeoise' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCroixRougeFribourgeoiseJob({ company: 'Croix-Rouge fribourgeoise' })).toBe(true);
    });

    it('matches by URL domain (public marketing domain)', () => {
      expect(isCroixRougeFribourgeoiseJob({ url: 'https://www.croix-rouge-fr.ch/fr/emploi' })).toBe(true);
    });

    it('matches a JobCloud company-page URL that carries the listing id (in path or query)', () => {
      expect(isCroixRougeFribourgeoiseJob({
        url: 'https://company.jobcloud.ch/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd?list=1773421929172x328595190866247700',
      })).toBe(true);
      expect(isCroixRougeFribourgeoiseJob({
        url: 'https://company.jobcloud.ch/fr/job-list/1773421929172x328595190866247700',
      })).toBe(true);
    });

    it('does NOT match a different JobCloud company-page listing id', () => {
      expect(isCroixRougeFribourgeoiseJob({
        url: 'https://company.jobcloud.ch/fr/job-list/9999999999999x999999999999999999',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isCroixRougeFribourgeoiseJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCroixRougeFribourgeoiseJob(null)).toBe(false);
      expect(isCroixRougeFribourgeoiseJob(undefined)).toBe(false);
      expect(isCroixRougeFribourgeoiseJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the JobCloud company-page host', () => {
      expect(isTrustedDomain('https://company.jobcloud.ch/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd')).toBe(true);
    });

    it('trusts the primary marketing domain (with and without www)', () => {
      expect(isTrustedDomain('https://croix-rouge-fr.ch/fr/emploi')).toBe(true);
      expect(isTrustedDomain('https://www.croix-rouge-fr.ch/fr/emploi')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects lookalike domains', () => {
      expect(isTrustedDomain('https://croix-rouge-fr.ch.evil.example/jobs')).toBe(false);
    });

    it('rejects an unrelated JobCloud subdomain-style host', () => {
      expect(isTrustedDomain('https://other.jobcloud.ch/fr/jobs/x')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAddress — city-gated HQ fallback, NEVER canton-gated (AGENTS.md #7) ──
  describe('resolveAddress', () => {
    it('resolves the Fribourg HQ street address for a "postal, city" Fribourg posting', () => {
      expect(resolveAddress('1700, Fribourg')).toEqual({
        city: 'Fribourg',
        canton: 'FR',
        postalCode: '1700',
        streetAddress: 'Rue G.-Techtermann 2',
      });
    });

    it('matches Fribourg case-insensitively and without a postal prefix', () => {
      const resolved = resolveAddress('FRIBOURG');
      expect(resolved.postalCode).toBe('1700');
      expect(resolved.streetAddress).toBe('Rue G.-Techtermann 2');
    });

    it('does NOT inherit the HQ street/postal address for a same-canton (FR) but different city', () => {
      // Regression guard: gating must key off the resolved CITY TEXT, never
      // off the canton alone (AGENTS.md non-negotiable #7 / recurring bug
      // class). "Bulle" resolves to canton FR, exactly like Fribourg, but
      // must NOT get the Fribourg street/postal code.
      const bulle = resolveAddress('1630, Bulle');
      expect(bulle.canton).toBe('FR');
      expect(bulle.city).toBe('Bulle');
      expect(bulle.streetAddress).toBe('');
      expect(bulle.postalCode).toBe('1630');
    });

    it('falls back to the FULL HQ address (never dropped) for an empty location', () => {
      expect(resolveAddress('')).toEqual({
        city: 'Fribourg',
        canton: 'FR',
        postalCode: '1700',
        streetAddress: 'Rue G.-Techtermann 2',
      });
    });

    it('decodes a numeric HTML entity in the raw location before resolving', () => {
      const resolved = resolveAddress('1700, Fribourg&#x20;');
      expect(resolved.city).toBe('Fribourg');
    });
  });

  // ── extractListingLinks ──
  describe('extractListingLinks', () => {
    it('extracts unique job-detail hrefs from listing HTML', () => {
      const html = `
        <a href="/fr/jobs/962b0a39-e87f-4de4-a068-58083fcebac5">A</a>
        <a href="/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd">B</a>
        <a href="/fr/jobs/962b0a39-e87f-4de4-a068-58083fcebac5">A dup</a>
      `;
      expect(extractListingLinks(html)).toEqual([
        '/fr/jobs/962b0a39-e87f-4de4-a068-58083fcebac5',
        '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd',
      ]);
    });

    it('returns an empty array when no job links are present', () => {
      expect(extractListingLinks('<html><body>no jobs</body></html>')).toEqual([]);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('builds slug with company suffix inline', () => {
      expect(slugify('Coordinateur-trice croix-rouge-fribourgeoise Fribourg')).toBe('coordinateur-trice-croix-rouge-fribourgeoise-fribourg');
    });

    it('strips diacritics and apostrophes', () => {
      expect(slugify("Coordinateur-trice de l'Alarme Croix-Rouge")).toMatch(/^[a-z0-9-]+$/);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'croix-rouge-fribourgeoise-abc123',
      slug: 'test-position-croix-rouge-fribourgeoise-fribourg',
      slugByLocale: { fr: 'test-position-croix-rouge-fribourgeoise-fribourg' },
      company: 'Croix-Rouge fribourgeoise',
      companyKey: 'croix-rouge-fribourgeoise',
      companyDomain: 'croix-rouge-fr.ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation purposes only.',
      descriptionByLocale: { fr: 'A test job description for validation purposes only.' },
      location: 'Fribourg',
      canton: 'FR',
      url: 'https://company.jobcloud.ch/fr/jobs/00000000-0000-0000-0000-000000000000',
      source: 'Croix-Rouge fribourgeoise Dedicated Parser (JobCloud Company Page)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Fribourg',
      addressRegion: 'FR',
      streetAddress: 'Rue G.-Techtermann 2',
      postalCode: '1700',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      hiringOrganization: { name: 'Croix-Rouge fribourgeoise' },
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

    it('has fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults;
      // the parser is responsible for supplying its per-job inputs.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^croix-rouge-fribourgeoise-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('fetchAllCroixRougeFribourgeoiseJobs (JobCloud Company Page listing + detail-page scrape)', () => {
  beforeEach(() => { process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0'; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  });

  const LISTING_URL = 'https://company.jobcloud.ch/fr/job-list/1773421929172x328595190866247700';

  function listingHtml(hrefs: string[]) {
    const cards = hrefs.map((href) => `<a href="${href}" class="job_list_item-link">card</a>`).join('\n');
    return `<!doctype html><html><body><section id="Job-Listings">${cards}</section></body></html>`;
  }

  const FR_HEAD = 'La Croix-Rouge fribourgeoise (CRF) est une association cantonale fondée en 1909.';
  const FR_BODY = '<p>Vous assurez la coordination et le bon fonctionnement opérationnel du dispositif.</p>' +
    '<p><strong>Tâches principales</strong> :</p><p>- Réceptionner les demandes.</p>';

  function detailHtml({
    title = "Coordinateur-trice de l&#x27;Alarme Croix-Rouge",
    head = FR_HEAD,
    body = FR_BODY,
    datePosted = '30.6.2026',
    occupation = '80 - 80%',
    contractType = 'Temporaire',
    lieu = '1700, Fribourg',
    applyId = 'a55e0f5b-afe7-4406-a15c-d0a73ef159fd',
  }: Record<string, string> = {}) {
    return `<!doctype html><html><body>
<main class="main-wrapper"><section class="section_job_details">
<h1>${title}</h1>
<div class="text-rich-text w-richtext"><div class="C_PHEADHTML"><p>${head}</p></div>
<div class="C_PBODYHTML">${body}</div></div>
<div class="job_details_content-right">
<div class="job_action-wrapper"><a href="https://www.jobup.ch/fr/application/create/${applyId}?utm_source=x&amp;utm_medium=referral" id="job-ad-apply-btn" target="_blank">Postuler</a></div>
<div class="job_details_keyinfos"><div class="job_details_keyinfos-wrapper"><div class="job_details_keyinfo-details"><div class="text-weight-semibold">Date de publication</div><div class="text-size-small">${datePosted}</div></div></div>
<div class="job_details_keyinfos-wrapper"><div class="job_details_keyinfo-details"><div class="text-weight-semibold">Taux d’activité</div><div class="text-size-small">${occupation}</div></div></div>
<div class="job_details_keyinfos-wrapper"><div class="job_details_keyinfo-details"><div class="text-weight-semibold">Type de contrat:</div><div class="text-size-small">${contractType}</div></div></div>
<div class="job_details_keyinfos-wrapper"><div class="job_details_keyinfo-details"><div class="text-weight-semibold">Lieu de travail</div><div class="text-size-small">${lieu}</div></div></div>
</div></div>
</section></main>
</body></html>`;
  }

  function mockFetch(hrefs: string[], detailByHref: Record<string, string>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/job-list/')) {
        return { ok: true, status: 200, text: async () => listingHtml(hrefs) } as unknown as Response;
      }
      for (const [path, html] of Object.entries(detailByHref)) {
        if (href.endsWith(path)) {
          return { ok: true, status: 200, text: async () => html } as unknown as Response;
        }
      }
      return { ok: true, status: 200, text: async () => detailHtml() } as unknown as Response;
    });
  }

  it('maps a listing + detail page pair into a full job record', async () => {
    const href = '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd';
    mockFetch([href], { [href]: detailHtml() });

    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.title).toBe("Coordinateur-trice de l'Alarme Croix-Rouge");
    expect(j.location).toBe('Fribourg');
    expect(j.canton).toBe('FR');
    expect(j.postalCode).toBe('1700');
    expect(j.streetAddress).toBe('Rue G.-Techtermann 2');
    expect(j.sourceLang).toBe('fr');
    expect(j.employmentType).toBe('PART_TIME'); // 80% max < 90
    expect(j.contract).toBe('temporary');
    expect(j.description.length).toBeGreaterThan(50);
    expect(j.description).toMatch(/coordination/);
    expect(j.descriptionByLocale.fr).toBe(j.description);
    expect(j.url).toBe(`https://company.jobcloud.ch${href}`);
    expect(j.postedDate).toBe('2026-06-30');
    expect(j.applyUrl).toMatch(/^https:\/\/www\.jobup\.ch\/fr\/application\/create\//);
    expect(j.applyUrl).toContain('&utm_medium'); // decoded &amp; -> &, not double-decoded
    expect(j.hiringOrganization.name).toBe('Croix-Rouge fribourgeoise');
  });

  it('parses a "D.M.YYYY" single-digit publication date into ISO', async () => {
    const href = '/fr/jobs/fe286ed3-2d71-4453-a2b1-e4e469c69461';
    mockFetch([href], { [href]: detailHtml({ datePosted: '3.7.2026' }) });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs[0].postedDate).toBe('2026-07-03');
  });

  it('detects FULL_TIME employmentType for a 100% max-occupation posting', async () => {
    const href = '/fr/jobs/962b0a39-e87f-4de4-a068-58083fcebac5';
    mockFetch([href], { [href]: detailHtml({ occupation: '80 - 100%', contractType: 'Durée indéterminée' }) });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs[0].employmentType).toBe('FULL_TIME');
    expect(jobs[0].contract).toBe('full-time');
  });

  it('resolves the HQ street address only for the Fribourg posting, not for another FR-canton posting in the same batch', async () => {
    const hrefFribourg = '/fr/jobs/00000000-0000-0000-0000-000000000001';
    const hrefBulle = '/fr/jobs/00000000-0000-0000-0000-000000000002';
    mockFetch([hrefFribourg, hrefBulle], {
      [hrefFribourg]: detailHtml({ title: 'Poste à Fribourg', lieu: '1700, Fribourg' }),
      [hrefBulle]: detailHtml({ title: 'Poste à Bulle', lieu: '1630, Bulle' }),
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    const fribourgJob = jobs.find((j: { location: string }) => j.location === 'Fribourg');
    const bulleJob = jobs.find((j: { location: string }) => j.location === 'Bulle');
    expect(fribourgJob.streetAddress).toBe('Rue G.-Techtermann 2');
    expect(fribourgJob.postalCode).toBe('1700');
    expect(bulleJob.canton).toBe('FR');
    expect(bulleJob.streetAddress).toBe('');
    expect(bulleJob.postalCode).toBe('1630');
  });

  it('keeps two same-role postings in different source languages as two distinct job records', async () => {
    const hrefFr = '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd';
    const hrefDe = '/fr/jobs/fe286ed3-2d71-4453-a2b1-e4e469c69461';
    mockFetch([hrefFr, hrefDe], {
      [hrefFr]: detailHtml({ title: "Coordinateur-trice de l&#x27;Alarme Croix-Rouge" }),
      [hrefDe]: detailHtml({
        title: 'Koordinator-in des Rotkreuz-Notrufs',
        head: 'Das Freiburgische Rote Kreuz (SRK) ist ein 1909 gegründeter Kantonalverband.',
        body: '<p>Sie übernehmen die Koordination und den reibungslosen Betrieb des Alarmdienstes.</p>' +
          '<p><strong>Hauptaufgaben</strong>:</p><p>- Anfragen entgegennehmen und bearbeiten.</p>',
      }),
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(2);
    const langs = jobs.map((j: { sourceLang: string }) => j.sourceLang).sort();
    expect(langs).toEqual(['de', 'fr']);
  });

  it('deduplicates repeated listing hrefs', async () => {
    const href = '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd';
    mockFetch([href, href], { [href]: detailHtml() });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(1);
  });

  it('skips a detail page without a usable title', async () => {
    const href = '/fr/jobs/00000000-0000-0000-0000-000000000099';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href2 = String(url);
      if (href2.includes('/job-list/')) {
        return { ok: true, status: 200, text: async () => listingHtml([href]) } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => '<html><body>no h1 here</body></html>' } as unknown as Response;
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(0);
  });

  it('returns [] (no throw) when the listing page has no job links', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>no jobs here</body></html>',
    } as unknown as Response);
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toEqual([]);
  });

  it('does not throw when a single detail-page fetch rejects — other jobs in the batch still emitted', async () => {
    const hrefOk = '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd';
    const hrefBroken = '/fr/jobs/00000000-0000-0000-0000-000000000404';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/job-list/')) {
        return { ok: true, status: 200, text: async () => listingHtml([hrefOk, hrefBroken]) } as unknown as Response;
      }
      if (href.endsWith(hrefBroken)) throw new Error('network error');
      return { ok: true, status: 200, text: async () => detailHtml() } as unknown as Response;
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(1);
  });

  it('returns [] (no throw) when the listing fetch itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, text: async () => '' } as unknown as Response);
    await expect(fetchAllCroixRougeFribourgeoiseJobs()).resolves.toEqual([]);
  });

  it('falls back to a synthesized description (never drops the field) when the detail page has no rich-text block', async () => {
    const href = '/fr/jobs/a55e0f5b-afe7-4406-a15c-d0a73ef159fd';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href2 = String(url);
      if (href2.includes('/job-list/')) {
        return { ok: true, status: 200, text: async () => listingHtml([href]) } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => '<html><body><h1>Test Role</h1><div class="job_details_content-right"></div></body></html>' } as unknown as Response;
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description.length).toBeGreaterThan(0);
    expect(jobs[0].description).toMatch(/Croix-Rouge fribourgeoise/);
  });
});
