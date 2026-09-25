import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  PROTECTAS_KEY,
  PROTECTAS_COMPANY_NAME,
  PROTECTAS_CAREER_URL,
  fetchAllProtectasJobs,
  extractProtectasLocation,
  extractProtectasVacancyUrls,
  isPhysicalSecurityVacancy,
  isProtectasJob,
  isTrustedDomain,
  parseProtectasJobDetail,
  parseProtectasJobPostingJsonLd,
} from '../scripts/lib/protectas-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const DETAIL_URL = 'https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/744000150722610/';
const DETAIL_DESCRIPTION = [
  'La posizione garantisce la sorveglianza fisica dei siti dei clienti nel Luganese.',
  'La persona effettua ronde diurne e notturne, controlla gli accessi, mantiene l’ordine',
  'e segnala ogni evento al superiore. Il servizio richiede disponibilità, patente B e',
  'formazione di sicurezza privata riconosciuta in Svizzera.',
].join(' ');
const DETAIL_HTML = `<html><body>
  <h1>Agente di sicurezza ausiliario - Luganese - contratto orario - Ronde &amp; Sorveglianza</h1>
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Agente di sicurezza ausiliario - Luganese - contratto orario - Ronde & Sorveglianza',
    description: DETAIL_DESCRIPTION,
    datePosted: '2026-09-20',
    employmentType: 'PART_TIME',
    url: DETAIL_URL,
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Lugano',
        addressRegion: 'Ticino',
        postalCode: '6900',
        addressCountry: 'CH',
      },
    },
  })}</script>
</body></html>`;
const LISTING_HTML = `<a href="${DETAIL_URL}">Agente di sicurezza ausiliario</a>
  <a href="https://jobup.ch/offerte/123">Unrelated aggregate result</a>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Protectas SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PROTECTAS_KEY).toBe('protectas');
    expect(PROTECTAS_COMPANY_NAME).toBe('Protectas SA');
  });

  // ── isCompanyJob ──
  describe('isProtectasJob', () => {
    it('matches by companyKey', () => {
      expect(isProtectasJob({ companyKey: 'protectas' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isProtectasJob({ company: 'Protectas SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isProtectasJob({ url: 'https://protectas.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isProtectasJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isProtectasJob(null)).toBe(false);
      expect(isProtectasJob(undefined)).toBe(false);
      expect(isProtectasJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://protectas.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.protectas.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('official inventory and physical-security boundary', () => {
    it('extracts only official numeric vacancy links', () => {
      expect(extractProtectasVacancyUrls(LISTING_HTML)).toEqual([DETAIL_URL]);
    });

    it('parses a JobPosting JSON-LD object with a Swiss physical location', () => {
      const posting = parseProtectasJobPostingJsonLd(DETAIL_HTML);
      expect(posting?.title).toContain('Agente di sicurezza');

      const location = extractProtectasLocation(posting);
      expect(location).toMatchObject({ locality: 'Lugano', postalCode: '6900', country: 'CH' });
      const parsed = parseProtectasJobDetail(DETAIL_HTML, DETAIL_URL);
      expect(parsed).toMatchObject({ canton: 'TI', addressLocality: 'Lugano', sourceLang: 'it' });
    });

    it('rejects cyber or descriptive security mentions', () => {
      expect(isPhysicalSecurityVacancy(
        'Security Solution Specialist',
        'Consulenza su cyber security, governance e architetture di rete.',
      )).toBe(false);
      expect(isPhysicalSecurityVacancy(
        'Agente di sicurezza ausiliario',
        DETAIL_DESCRIPTION,
      )).toBe(true);
      for (const title of [
        'Agente di sicurezza informatica',
        'Agent de sécurité informatique',
        'IT-Sicherheitsmitarbeiter',
      ]) {
        expect(isPhysicalSecurityVacancy(title, DETAIL_DESCRIPTION)).toBe(false);
      }
    });

    it('fails closed when a pagination page cannot be fetched', async () => {
      const page2 = `${PROTECTAS_CAREER_URL}?page=2`;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input) === PROTECTAS_CAREER_URL) {
          return new Response(`<a href="${page2}">2</a>${LISTING_HTML}`, { status: 200 });
        }
        throw new Error('upstream unavailable');
      });

      await expect(fetchAllProtectasJobs()).rejects.toThrow(/pagination page failed.*page=2/);
    });

    it('fails closed when pagination reaches the safety limit with more pages queued', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        const page = Number(new URL(url).searchParams.get('page') || 1);
        const next = page < 13 ? `<a href="${PROTECTAS_CAREER_URL}?page=${page + 1}">${page + 1}</a>` : '';
        return new Response(`${next}${LISTING_HTML}`, { status: 200 });
      });

      await expect(fetchAllProtectasJobs()).rejects.toThrow(/pagination exceeded the safety limit/);
    });

    it('fails closed when the official page exposes no vacancy links', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html><body>Nessuna offerta</body></html>', { status: 200 }),
      );
      await expect(fetchAllProtectasJobs()).rejects.toThrow('no official vacancy detail links');
      expect(fetchMock).toHaveBeenCalledWith(
        PROTECTAS_CAREER_URL,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('imports only a verified physical TI vacancy from the official page', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url === PROTECTAS_CAREER_URL) return new Response(LISTING_HTML, { status: 200 });
        if (url === DETAIL_URL) return new Response(DETAIL_HTML, { status: 200 });
        return new Response('not found', { status: 404 });
      });

      const jobs = await fetchAllProtectasJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        companyKey: 'protectas',
        canton: 'TI',
        category: 'Sicurezza',
        addressLocality: 'Lugano',
        url: DETAIL_URL,
        employmentType: 'PART_TIME',
      });
      expect(jobs[0].title).toContain('Agente di sicurezza');
      expect(jobs[0].description).toContain('sorveglianza fisica');
      expect(isPhysicalSecurityVacancy(jobs[0].title, jobs[0].description)).toBe(true);
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
      expect(slugify('Developer protectas ch')).toBe('developer-protectas-ch');
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
      id: 'protectas-abc123',
      slug: 'test-position-protectas-ch',
      slugByLocale: { it: 'test-position-protectas-ch' },
      company: 'Protectas SA',
      companyKey: 'protectas',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://protectas.com/jobs/test',
      source: 'Protectas SA Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^protectas-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
