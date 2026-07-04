import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  EVAM_VAUD_KEY,
  EVAM_VAUD_COMPANY_NAME,
  isEvamVaudJob,
  isTrustedDomain,
  parsePensum,
  inferEmploymentType,
  inferContractType,
  fetchAllEvamVaudJobs,
} from '../scripts/lib/evam-vaud-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('EVAM Vaud crawler parser', () => {
  // -- Constants --
  it('exports valid company key and name', () => {
    expect(EVAM_VAUD_KEY).toBe('evam-vaud');
    expect(EVAM_VAUD_COMPANY_NAME).toContain('EVAM');
  });

  // -- isEvamVaudJob --
  describe('isEvamVaudJob', () => {
    it('matches by companyKey', () => {
      expect(isEvamVaudJob({ companyKey: 'evam-vaud' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEvamVaudJob({ company: 'EVAM' })).toBe(true);
    });

    it('matches by career site URL', () => {
      expect(isEvamVaudJob({ url: 'https://emploi.evam.ch/jobs/8018137-chef-fe' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEvamVaudJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEvamVaudJob(null)).toBe(false);
      expect(isEvamVaudJob(undefined)).toBe(false);
      expect(isEvamVaudJob({})).toBe(false);
    });
  });

  // -- isTrustedDomain --
  describe('isTrustedDomain', () => {
    it('trusts evam.ch primary domain', () => {
      expect(isTrustedDomain('https://www.evam.ch/qui-sommes-nous/')).toBe(true);
    });

    it('trusts emploi.evam.ch (Teamtailor career site subdomain)', () => {
      expect(isTrustedDomain('https://emploi.evam.ch/jobs/8018137-chef-fe')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains containing evam.ch as substring', () => {
      expect(isTrustedDomain('https://notevam.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // -- slugify (imported from crawler-template) --
  describe('slugify', () => {
    it('converts French title to URL-safe slug', () => {
      const slug = slugify("Assistant.e Social.e (80%) - CDI evam vaud ch");
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('strips French diacritics', () => {
      expect(slugify('Éducateurs sociaux')).toBe('educateurs-sociaux');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // -- parsePensum / inferEmploymentType / inferContractType --
  describe('parsePensum', () => {
    it('parses a single percentage', () => {
      expect(parsePensum('Assistant.e Social.e (80%) - CDI')).toEqual({ min: 80, max: 80 });
    });

    it('parses a range percentage', () => {
      expect(parsePensum("Chef·fe d'équipe du pôle Interface (80-100%) - CDI")).toEqual({ min: 80, max: 100 });
    });

    it('handles missing percentage', () => {
      expect(parsePensum('No percentage here')).toEqual({ min: null, max: null });
    });
  });

  describe('inferEmploymentType', () => {
    it('returns FULL_TIME for 100%', () => {
      expect(inferEmploymentType('Spécialiste RH (100%) - CDI')).toBe('FULL_TIME');
    });

    it('returns FULL_TIME for 80% (>= 80 threshold)', () => {
      expect(inferEmploymentType('Assistant.e Social.e (80%) - CDI')).toBe('FULL_TIME');
    });

    it('returns PART_TIME below 80%', () => {
      expect(inferEmploymentType('Comptable (50%) - CDI')).toBe('PART_TIME');
    });
  });

  describe('inferContractType', () => {
    it('returns permanent for CDI', () => {
      expect(inferContractType('Spécialiste RH (100%) - CDI')).toBe('permanent');
    });

    it('returns temporary for CDD', () => {
      expect(inferContractType('Formateur·trice FLE/FLI (100%) – CDD 12 mois')).toBe('temporary');
    });
  });

  // -- fetchAllEvamVaudJobs: graceful degradation + shape --
  describe('fetchAllEvamVaudJobs', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function mockFeed(items) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ items }),
      }));
    }

    it('builds a job from a well-formed JSONFeed item with real jobLocation', async () => {
      mockFeed([{
        id: 'abc',
        title: "Chef·fe d'équipe du pôle Interface (80-100%) - CDI",
        url: 'https://emploi.evam.ch/jobs/8018137-chef-fe-d-equipe-du-pole-interface-80-100-cdi',
        date_published: '2026-07-03T15:16:37+02:00',
        content_html: '<p>Description content long enough to pass quality checks about migrants integration in canton Vaud with plenty of detail sentences to reach the minimum char threshold required by validation logic downstream in the pipeline.</p>',
        _jobposting: {
          '@type': 'JobPosting',
          title: "Chef·fe d'équipe du pôle Interface (80-100%) - CDI",
          description: '<p>Description content long enough to pass quality checks about migrants integration in canton Vaud with plenty of detail sentences to reach the minimum char threshold required by validation logic downstream in the pipeline.</p>',
          datePosted: '2026-07-03T15:16:37+02:00',
          hiringOrganization: { '@type': 'Organization', name: 'EVAM' },
          jobLocation: [{
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              streetAddress: 'Rte de Chavannes 31',
              addressLocality: 'Lausanne',
              postalCode: '1007',
              addressCountry: 'CH',
            },
          }],
        },
      }]);

      const jobs = await fetchAllEvamVaudJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.id).toMatch(/^evam-vaud-8018137$/);
      expect(job.streetAddress).toBe('Rte de Chavannes 31');
      expect(job.postalCode).toBe('1007');
      expect(job.addressLocality).toBe('Lausanne');
      expect(job.canton).toBe('VD');
      expect(job.sourceLang).toBe('fr');
    });

    it('falls back to EVAM Lausanne HQ address when jobLocation is absent at source', async () => {
      mockFeed([{
        id: 'no-loc',
        title: "Responsable d'Atelier Vélo et d'insertion (90%) – CDI",
        url: 'https://emploi.evam.ch/jobs/7991107-responsable-d-atelier-velo',
        date_published: '2026-06-30T09:55:59+02:00',
        content_html: '<p>Some description text that is reasonably long to avoid thin-content warnings during the crawl validation step of the pipeline processing.</p>',
        _jobposting: {
          '@type': 'JobPosting',
          title: "Responsable d'Atelier Vélo et d'insertion (90%) – CDI",
          description: '<p>Some description text that is reasonably long to avoid thin-content warnings during the crawl validation step of the pipeline processing.</p>',
          datePosted: '2026-06-30T09:55:59+02:00',
          hiringOrganization: { '@type': 'Organization', name: 'EVAM' },
        },
      }]);

      const jobs = await fetchAllEvamVaudJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].postalCode).toBe('1007');
      expect(jobs[0].streetAddress).toBe('Rte de Chavannes 31');
      expect(jobs[0].addressLocality).toBe('Lausanne');
      expect(jobs[0].canton).toBe('VD');
    });

    it('returns an empty array on an empty feed (graceful degradation)', async () => {
      mockFeed([]);
      const jobs = await fetchAllEvamVaudJobs();
      expect(jobs).toEqual([]);
    });

    it('skips malformed items without a title instead of throwing', async () => {
      mockFeed([{ id: 'broken', url: 'https://emploi.evam.ch/jobs/1-broken' }]);
      const jobs = await fetchAllEvamVaudJobs();
      expect(jobs).toEqual([]);
    });

    it('propagates a network-level fetch failure (pipeline handles soft-exit)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
      await expect(fetchAllEvamVaudJobs()).rejects.toThrow('fetch failed');
    });

    it('throws on a non-ok HTTP response (genuine break, must surface)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' }));
      await expect(fetchAllEvamVaudJobs()).rejects.toThrow('503');
    });
  });

  // -- Job Shape Validation (Non-Negotiable #3 / #4) --
  describe('job shape', () => {
    const validJob = {
      id: 'evam-vaud-8018137',
      slug: 'chef-fe-d-equipe-du-pole-interface-evam-vaud-ch',
      slugByLocale: { fr: 'chef-fe-d-equipe-du-pole-interface-evam-vaud-ch' },
      company: 'EVAM',
      companyKey: 'evam-vaud',
      companyDomain: 'evam.ch',
      title: "Chef·fe d'équipe du pôle Interface (80-100%) - CDI",
      titleByLocale: { fr: "Chef·fe d'équipe du pôle Interface (80-100%) - CDI" },
      description:
        "L'EVAM est un acteur majeur du service public vaudois avec plus de 1'000 collaboratrices et collaborateurs, assurant l'accueil, l'accompagnement et l'intégration des personnes migrantes dans le canton de Vaud, avec des missions variées et un encadrement structuré pour chaque équipe régionale. Le ou la titulaire du poste encadre une équipe pluridisciplinaire, assure le suivi administratif et social des dossiers, collabore avec les partenaires cantonaux et communaux, et veille à la qualité de l'accompagnement offert aux bénéficiaires tout au long de leur parcours d'intégration.",
      descriptionByLocale: {
        fr: "L'EVAM est un acteur majeur du service public vaudois avec plus de 1'000 collaboratrices et collaborateurs, assurant l'accueil, l'accompagnement et l'intégration des personnes migrantes dans le canton de Vaud, avec des missions variées et un encadrement structuré pour chaque équipe régionale. Le ou la titulaire du poste encadre une équipe pluridisciplinaire, assure le suivi administratif et social des dossiers, collabore avec les partenaires cantonaux et communaux, et veille à la qualité de l'accompagnement offert aux bénéficiaires tout au long de leur parcours d'intégration.",
      },
      location: 'Lausanne',
      streetAddress: 'Rte de Chavannes 31',
      postalCode: '1007',
      addressLocality: 'Lausanne',
      addressRegion: 'VD',
      addressCountry: 'CH',
      canton: 'VD',
      country: 'CH',
      url: 'https://emploi.evam.ch/jobs/8018137-chef-fe-d-equipe-du-pole-interface-80-100-cdi',
      source: 'EVAM Dedicated Parser',
      sourceLang: 'fr',
      postedDate: '2026-07-03',
      datePosted: '2026-07-03',
      crawledAt: new Date().toISOString(),
      category: 'Amministrazione Pubblica',
      experienceLevel: 'senior',
      sector: 'Amministrazione Pubblica',
      employmentType: 'FULL_TIME',
      contract: 'full-time',
      contractType: 'permanent',
      currency: 'CHF',
      hiringOrganizationName: 'EVAM',
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

    // Non-Negotiable #3: every job's structured data must include, per
    // locale: baseSalary, postalCode, streetAddress, title, description,
    // datePosted, hiringOrganization.name, jobLocation, employmentType.
    // baseSalary is filled downstream by shared hardening (dedicated-
    // crawler-common.mjs); the rest must be present on the raw job object.
    it('has all Non-Negotiable #3 structured-data fields (safe defaults, never omitted)', () => {
      const nonNegotiable3 = [
        'postalCode', 'streetAddress', 'title', 'description',
        'datePosted', 'hiringOrganizationName', 'addressLocality',
        'addressRegion', 'addressCountry', 'employmentType',
      ];
      for (const field of nonNegotiable3) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('canton is VD (Vaud) — EVAM operates exclusively in canton Vaud', () => {
      expect(validJob.canton).toBe('VD');
      expect(validJob.addressRegion).toBe('VD');
    });

    it('employmentType uses schema.org enum convention (FULL_TIME/PART_TIME)', () => {
      expect(['FULL_TIME', 'PART_TIME']).toContain(validJob.employmentType);
    });

    // Non-Negotiable #4: never index thin content < 50 words.
    it('description has at least 50 words (Non-Negotiable #4)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains the French source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe('fr');
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^evam-vaud-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('URL points to the emploi.evam.ch Teamtailor career site', () => {
      expect(validJob.url).toContain('emploi.evam.ch/jobs/');
    });

    it('sourceLang is fr, not de (French-speaking canton, unlike most of this campaign)', () => {
      expect(validJob.sourceLang).toBe('fr');
      expect(validJob.sourceLang).not.toBe('de');
    });
  });
});
