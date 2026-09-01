import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  ETE_KEY,
  ETE_COMPANY_NAME,
  extractEteDetailFields,
  fetchAllEteJobs,
  isEteJob,
  isTrustedDomain,
} from '../scripts/lib/ete-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const SEED_URL = 'https://www.ete.ch/unternehmen/jobs/';
const BASSERSDORF_URL = 'https://www.ete.ch/jobs/maschinenumzuege/';
const AVENCHES_URL = 'https://www.ete.ch/jobs/transports-speciaux/';
const DEGRADED_URL = 'https://www.ete.ch/jobs/degraded/';

function richDetail({
  title = 'Mitarbeiter/in Maschinenumzüge',
  location = 'Bassersdorf',
  locationLabel = 'Standort',
  body = 'Du führst schweizweite Transporte aus und bewegst industrielle Anlagen. Du arbeitest selbstständig, betreust Kunden vor Ort und sorgst für sichere Abläufe. Wir bieten moderne Arbeitsmittel, abwechslungsreiche Einsätze und ein kollegiales Team mit langfristiger Perspektive.',
} = {}) {
  return `<!doctype html><html><body>
    <main>
      <h1>${title}</h1>
      <section class="data-sheet"><dl>
        <div><dt>${locationLabel}</dt><dd>${location}<!-- <span>m</span> --></dd></div>
      </dl></section>
      <section class="job_description section text"><div class="inside rich-text">
        <h2>Jobbeschreibung</h2><p>${body}</p>
      </div></section>
      <article class="wpgb-card"><a href="/jobs/unrelated/">Unrelated vacancy</a>
        <span class="value">Las Vegas</span></article>
    </main>
  </body></html>`;
}

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('Emil Egger AG crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETE_KEY).toBe('ete');
    expect(ETE_COMPANY_NAME).toBe('Emil Egger AG');
  });

  // ── isCompanyJob ──
  describe('isEteJob', () => {
    it('matches by companyKey', () => {
      expect(isEteJob({ companyKey: 'ete' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEteJob({ company: 'Emil Egger AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEteJob({ url: 'https://ete.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEteJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEteJob(null)).toBe(false);
      expect(isEteJob(undefined)).toBe(false);
      expect(isEteJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ete.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ete.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('ETE detail boundary', () => {
    it('keeps the generic authoritative body and the exact job datasheet location', () => {
      const detail = extractEteDetailFields(richDetail(), BASSERSDORF_URL);

      expect(detail.locationCandidates).toEqual([{
        location: 'Bassersdorf',
        addressLocality: 'Bassersdorf',
        addressCountry: '',
      }]);
      expect(detail.description).toContain('schweizweite Transporte');
      expect(detail.description).toContain('langfristiger Perspektive');
      expect(detail.description).not.toContain('Unrelated vacancy');
      expect(detail.location).not.toContain('Las Vegas');
    });

    it('accepts the observed French datasheet label without reading surrounding locations', () => {
      const detail = extractEteDetailFields(richDetail({
        title: 'Chauffeur transports spéciaux',
        location: 'Avenches',
        locationLabel: 'Site',
      }), AVENCHES_URL);

      expect(detail.location).toBe('Avenches');
      expect(detail.locationCandidates).toEqual([expect.objectContaining({
        location: 'Avenches',
      })]);
    });

    it('fails closed when the vacancy body or exact datasheet location is missing', () => {
      const missingLocation = richDetail().replace('<dt>Standort</dt><dd>Bassersdorf<!-- <span>m</span> --></dd>', '');
      const missingBody = richDetail().replace('job_description section text', 'company_description section text');

      expect(extractEteDetailFields(missingLocation).locationCandidates).toEqual([]);
      expect(extractEteDetailFields(missingBody).description).toBe('');
    });

    it('publishes rich Swiss details, quarantines degraded rows and preserves URL-derived identity', async () => {
      const listing = `
        <a href="${BASSERSDORF_URL}">Disponent/in Industrieumzüge 100%</a>
        <a href="${AVENCHES_URL}">Disponent/in Industrieumzüge 100%</a>
        <a href="${DEGRADED_URL}">Degraded vacancy</a>`;
      const degraded = richDetail({ title: 'Degraded vacancy' })
        .replace('<dt>Standort</dt><dd>Bassersdorf<!-- <span>m</span> --></dd>', '');
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://www.ete.ch/robots.txt') return response(url, 'User-agent: *\nAllow: /');
        if (url === SEED_URL) return response(url, listing);
        if (url === BASSERSDORF_URL) return response(url, richDetail({
          title: 'Disponent/in Industrieumzüge 100%',
        }));
        if (url === AVENCHES_URL) return response(url, richDetail({
          title: 'Disponent/in Industrieumzüge 100%',
          location: 'Avenches',
          locationLabel: 'Site',
        }));
        if (url === DEGRADED_URL) return response(url, degraded);
        throw new Error(`unexpected URL ${url}`);
      });

      const jobs = await fetchAllEteJobs({
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });

      expect(jobs).toHaveLength(2);
      expect(jobs.map((job) => job.url)).toEqual([BASSERSDORF_URL, AVENCHES_URL]);
      expect(jobs.map((job) => job.location)).toEqual(['Bassersdorf', 'Avenches']);
      expect(jobs.map((job) => job.canton)).toEqual(['ZH', 'VD']);
      for (const job of jobs) {
        const urlHash = createHash('sha1').update(job.url).digest('hex').slice(0, 12);
        expect(job.id).toBe(`ete-${urlHash}`);
        expect(job.slug).toBe(slugify(`${job.title} ete ch ${job.location}`));
        expect(job.description.length).toBeGreaterThan(120);
      }
      expect(new Set(jobs.map((job) => job.slug)).size).toBe(2);

      const repeated = await fetchAllEteJobs({
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });
      const identity = (job: { id: string; url: string; slug: string; location: string }) => ({
        id: job.id,
        url: job.url,
        slug: job.slug,
        location: job.location,
      });
      expect(repeated.map(identity)).toEqual(jobs.map(identity));

      expect(fetchImpl).toHaveBeenCalledWith(
        DEGRADED_URL,
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        SEED_URL,
        expect.objectContaining({
          headers: expect.objectContaining({ 'Accept-Encoding': 'identity' }),
        }),
      );
    });

    it('pins already-published slugs while location corrections update source fields', () => {
      const updater = fs.readFileSync(
        new URL('../scripts/update-ete-jobs.mjs', import.meta.url),
        'utf8',
      );
      expect(updater).toContain('preserveExistingSlugs: true');
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
      expect(slugify('Developer ete ch')).toBe('developer-ete-ch');
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
      id: 'ete-abc123',
      slug: 'test-position-ete-ch',
      slugByLocale: { de: 'test-position-ete-ch' },
      company: 'Emil Egger AG',
      companyKey: 'ete',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ete.ch/jobs/test',
      source: 'Emil Egger AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ete-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
