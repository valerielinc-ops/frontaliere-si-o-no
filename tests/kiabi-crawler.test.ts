import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  KIABI_KEY,
  KIABI_COMPANY_NAME,
  KIABI_COMPANY_DOMAIN,
  isKiabiJob,
  isTrustedDomain,
  resolveAddress,
  fetchAllKiabiJobs,
} from '../scripts/lib/kiabi-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kiabi Suisse crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(KIABI_KEY).toBe('kiabi');
    expect(KIABI_COMPANY_NAME).toBe('Kiabi Suisse');
    expect(KIABI_COMPANY_DOMAIN).toBe('kiabi.com');
  });

  // ── isCompanyJob ──
  describe('isKiabiJob', () => {
    it('matches by companyKey', () => {
      expect(isKiabiJob({ companyKey: 'kiabi' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKiabiJob({ company: 'Kiabi Suisse' })).toBe(true);
    });

    it('matches by URL domain (kiabi.com)', () => {
      expect(isKiabiJob({ url: 'https://www.kiabi.com/fr/recrutement' })).toBe(true);
    });

    it('matches by URL domain (kiabishop.com)', () => {
      expect(isKiabiJob({ url: 'https://www.kiabishop.com/fr-CH/magasins' })).toBe(true);
    });

    it('matches by SmartRecruiters tenant URL', () => {
      expect(isKiabiJob({ url: 'https://jobs.smartrecruiters.com/KIABI/744000134785679-conseiller-de-vente' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKiabiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKiabiJob(null)).toBe(false);
      expect(isKiabiJob(undefined)).toBe(false);
      expect(isKiabiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary kiabi.com domain', () => {
      expect(isTrustedDomain('https://www.kiabi.com/fr/recrutement')).toBe(true);
      expect(isTrustedDomain('https://kiabi.com/jobs')).toBe(true);
    });

    it('trusts kiabishop.com subdomains', () => {
      expect(isTrustedDomain('https://www.kiabishop.com/fr-CH/magasins')).toBe(true);
    });

    it('trusts SmartRecruiters ATS hosts', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/KIABI/744000134785679')).toBe(true);
      expect(isTrustedDomain('https://api.smartrecruiters.com/v1/companies/KIABI/postings')).toBe(true);
      expect(isTrustedDomain('https://careers.smartrecruiters.com/KIABI/france')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/kiabi/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Lausanne legal-seat address only when the resolved city is Lausanne', () => {
      const resolved = resolveAddress({ city: 'Lausanne' });
      expect(resolved.city).toBe('Lausanne');
      expect(resolved.postalCode).toBe('1003');
      expect(resolved.streetAddress).toBe('Rue de Bourg 16');
    });

    it('does NOT leak the Lausanne address for a same-canton-but-different-city posting (Nyon, VD)', () => {
      // Nyon is canton VD, the SAME canton as the Lausanne legal seat — this
      // is exactly the case a canton-only gate would get wrong. The gate
      // must be on the city TEXT, never the canton.
      const resolved = resolveAddress({ city: 'Nyon' });
      expect(resolved.city).toBe('Nyon');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT leak the Lausanne address for the live Fribourg store posting', () => {
      const resolved = resolveAddress({ city: 'Fribourg' });
      expect(resolved.city).toBe('Fribourg');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT leak the Lausanne address for the live Marin-Epagnier (NE) store posting', () => {
      const resolved = resolveAddress({ city: 'Marin-Epagnier' });
      expect(resolved.city).toBe('Marin-Epagnier');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Fribourg',
        postalCode: '1700',
        address: 'Centre Fribourg Sud, Route André-Piller 21',
      });
      expect(resolved).toEqual({
        city: 'Fribourg',
        postalCode: '1700',
        streetAddress: 'Centre Fribourg Sud, Route André-Piller 21',
        region: '',
      });
    });

    it('falls back to the Lausanne legal seat entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Lausanne');
      expect(resolved.postalCode).toBe('1003');
      expect(resolved.streetAddress).toBe('Rue de Bourg 16');
    });

    it('matches Lausanne case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  LAUSANNE  ' });
      expect(resolved.streetAddress).toBe('Rue de Bourg 16');
    });
  });

  // ── fetchAllKiabiJobs: SmartRecruiters integration (mocked network) ──
  describe('fetchAllKiabiJobs (SmartRecruiters API, mocked)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const FRIBOURG_POSTING = {
      id: '744000134785679',
      name: 'Conseiller de Vente en Renfort d’Équipe | KIABI Fribourg',
      releasedDate: '2026-06-29T12:56:36.303Z',
      applyUrl: 'https://jobs.smartrecruiters.com/KIABI/744000134785679-conseiller-de-vente',
      location: {
        city: 'Fribourg',
        country: 'ch',
        address: 'Fribourg',
        fullLocation: 'Fribourg, , Switzerland',
      },
      typeOfEmployment: { label: 'Part-time' },
      customField: [{ fieldId: '5b4706d56d8bc50530ca3e15', fieldLabel: 'Brands', valueLabel: 'Kiabi Suisse' }],
      jobAd: { sections: { jobDescription: { text: '<p>Rejoignez notre équipe à Fribourg.</p>' } } },
      creator: { name: 'Jane Recruiter', avatarUrl: 'https://example.com/avatar.jpg' },
    };

    const MARIN_POSTING = {
      id: '744000199999001',
      name: 'Conseiller de Vente | KIABI Marin Centre',
      releasedDate: '2026-06-20T09:00:00.000Z',
      applyUrl: 'https://jobs.smartrecruiters.com/KIABI/744000199999001-conseiller-de-vente-marin',
      location: {
        city: 'Marin-Epagnier',
        country: 'ch',
        address: 'Marin-Epagnier',
        region: 'Neuchâtel',
        fullLocation: 'Marin-Epagnier, Neuchâtel, Switzerland',
      },
      typeOfEmployment: { label: 'Full-time' },
      jobAd: { sections: { jobDescription: { text: '<p>Rejoignez notre boutique de Marin Centre.</p>' } } },
    };

    const LAUSANNE_POSTING = {
      id: '744000199999002',
      name: 'Responsable Juridique Suisse | KIABI Suisse',
      releasedDate: '2026-06-15T09:00:00.000Z',
      applyUrl: 'https://jobs.smartrecruiters.com/KIABI/744000199999002-responsable-juridique',
      location: { city: 'Lausanne', country: 'ch', address: '', fullLocation: 'Lausanne, , Switzerland' },
      typeOfEmployment: { label: 'Full-time' },
      jobAd: { sections: { jobDescription: { text: '<p>Poste basé au siège administratif suisse.</p>' } } },
    };

    const FRANCE_POSTING = {
      id: '744000135738589',
      name: 'Modéliste vêtements enfant',
      releasedDate: '2026-06-30T09:00:00.000Z',
      applyUrl: 'https://jobs.smartrecruiters.com/KIABI/744000135738589-modeliste',
      location: { city: 'Lille', country: 'fr', fullLocation: 'Lille, , France' },
      jobAd: { sections: { jobDescription: { text: '<p>Poste basé en France.</p>' } } },
    };

    /**
     * Mocks the SmartRecruiters public API surface: the list endpoint (URL
     * carries a `?limit=` query string) returns lightweight summaries, the
     * detail endpoint (`/postings/{id}`, no query string) returns the full
     * posting object keyed by id. Tracks every requested URL so tests can
     * assert non-Swiss postings never trigger a detail fetch.
     */
    function mockSmartRecruitersApi(postings: Array<Record<string, unknown>>) {
      const requestedUrls: string[] = [];
      const byId = new Map(postings.map((p) => [String(p.id), p]));
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('?limit=')) {
          return {
            ok: true,
            json: async () => ({ offset: 0, limit: 100, totalFound: postings.length, content: postings }),
          };
        }
        const id = url.split('/').pop() || '';
        const full = byId.get(id);
        return {
          ok: Boolean(full),
          json: async () => full || {},
        };
      }));
      return requestedUrls;
    }

    it('filters out non-Swiss postings (France) and keeps only Swiss ones', async () => {
      mockSmartRecruitersApi([FRIBOURG_POSTING, FRANCE_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toContain('Fribourg');
    });

    it('never fetches posting detail for a filtered-out non-Swiss posting', async () => {
      const requestedUrls = mockSmartRecruitersApi([FRIBOURG_POSTING, FRANCE_POSTING]);
      await fetchAllKiabiJobs();
      const detailUrls = requestedUrls.filter((u) => !u.includes('?limit='));
      expect(detailUrls).toHaveLength(1);
      expect(detailUrls[0]).toContain(FRIBOURG_POSTING.id);
      expect(detailUrls.some((u) => u.includes(FRANCE_POSTING.id))).toBe(false);
    });

    it('infers canton FR for the Fribourg store posting', async () => {
      mockSmartRecruitersApi([FRIBOURG_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs[0].canton).toBe('FR');
      expect(jobs[0].location).toBe('Fribourg');
    });

    it('infers canton NE for the Marin-Epagnier store posting', async () => {
      mockSmartRecruitersApi([MARIN_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs[0].canton).toBe('NE');
    });

    it('gates the Lausanne HQ street address correctly across the live pipeline', async () => {
      mockSmartRecruitersApi([FRIBOURG_POSTING, LAUSANNE_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      const fribourgJob = jobs.find((j) => j.location === 'Fribourg');
      const lausanneJob = jobs.find((j) => j.location === 'Lausanne');
      expect(fribourgJob?.streetAddress).toBe('');
      expect(fribourgJob?.postalCode).toBe('');
      expect(lausanneJob?.streetAddress).toBe('Rue de Bourg 16');
      expect(lausanneJob?.postalCode).toBe('1003');
      expect(lausanneJob?.canton).toBe('VD');
    });

    it('sets companyKey/company/source/sourceLang/country correctly end-to-end', async () => {
      mockSmartRecruitersApi([FRIBOURG_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      const job = jobs[0];
      expect(job.companyKey).toBe('kiabi');
      expect(job.company).toBe('Kiabi Suisse');
      expect(job.companyDomain).toBe('kiabi.com');
      expect(job.source).toContain('SmartRecruiters');
      expect(job.addressCountry).toBe('CH');
      expect(job.country).toBe('CH');
      expect(job.currency).toBe('CHF');
      expect(['fr', 'de', 'it', 'en']).toContain(job.sourceLang);
    });

    it('dedupes postings that resolve to the same applyUrl', async () => {
      const duplicate = { ...FRIBOURG_POSTING };
      mockSmartRecruitersApi([FRIBOURG_POSTING, duplicate]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs).toHaveLength(1);
    });

    it('skips postings with an empty or too-short title', async () => {
      const blank = { ...MARIN_POSTING, id: '744000199999999', name: '  ', applyUrl: 'https://jobs.smartrecruiters.com/KIABI/blank' };
      mockSmartRecruitersApi([blank]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs).toHaveLength(0);
    });

    it('returns an empty array when the API returns no Swiss postings at all', async () => {
      mockSmartRecruitersApi([FRANCE_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs).toEqual([]);
    });

    it('does not leak the raw posting’s recruiter/creator personal name into the assembled job', async () => {
      // FRIBOURG_POSTING carries a `creator.name`/`avatarUrl` (SR's recruiter
      // metadata) — the assembled ParsedJob must never surface it.
      mockSmartRecruitersApi([FRIBOURG_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      const serialized = JSON.stringify(jobs[0]);
      expect(serialized).not.toContain('Jane Recruiter');
      expect(serialized).not.toContain('avatar.jpg');
    });

    it('populates a non-empty description sourced from the SmartRecruiters jobAd sections', async () => {
      mockSmartRecruitersApi([FRIBOURG_POSTING]);
      const jobs = await fetchAllKiabiJobs();
      expect(jobs[0].description.length).toBeGreaterThan(10);
      expect(jobs[0].description).toContain('Fribourg');
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllKiabiJobs emits for a Fribourg store job.
    const validJob = {
      id: 'kiabi-abc123def456',
      slug: 'conseiller-de-vente-kiabi-fribourg',
      slugByLocale: { fr: 'conseiller-de-vente-kiabi-fribourg' },
      company: 'Kiabi Suisse',
      companyKey: 'kiabi',
      companyDomain: 'kiabi.com',
      title: 'Conseiller de Vente (H/F/NB)',
      titleByLocale: { fr: 'Conseiller de Vente (H/F/NB)' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Fribourg',
      canton: 'FR',
      url: 'https://jobs.smartrecruiters.com/KIABI/744000134785679-conseiller-de-vente',
      source: 'Kiabi Suisse Dedicated Parser (SmartRecruiters)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Fribourg',
      addressRegion: 'FR',
      streetAddress: '',
      postalCode: '',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'PART_TIME',
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
      // baseSalary itself is synthesized downstream with safe defaults;
      // per-job inputs are what the parser is responsible for supplying.
      // streetAddress/postalCode are intentionally allowed to be empty here
      // (safe default) since Fribourg is a real store, not the Lausanne HQ —
      // fabricating a street address would be worse than an honest gap.
      const structuredDataInputs = [
        'title', 'description', 'addressLocality', 'addressCountry',
        'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.company).toBe('Kiabi Suisse');
    });

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^kiabi-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(slugify(validJob.title)).toBeTruthy();
    });
  });
});
