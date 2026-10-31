import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  OPACC_SOFTWARE_AG_KEY,
  OPACC_SOFTWARE_AG_COMPANY_NAME,
  OPACC_SOFTWARE_AG_COMPANY_DOMAIN,
  isOpaccSoftwareAgJob,
  isTrustedDomain,
} from '../scripts/lib/opacc-software-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { loadSpec, runSpecInProduction, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
    clone: () => response(url, body),
  } as any;
}

function detailPage(url: string, title: string, locality: string, postalCode: string) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    url,
    title,
    description: `${title}: Eine source-backed Beschreibung dieser offenen Stelle mit Aufgaben, Anforderungen und Arbeitsort bei Opacc Software AG.`,
    hiringOrganization: { '@type': 'Organization', name: 'Opacc Software AG' },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Wahligenpark 1',
        postalCode,
        addressLocality: locality,
        addressRegion: locality === 'Münchenstein' ? 'BL' : 'LU',
        addressCountry: 'CH',
      },
    },
  })}</script>`;
}

describe('Opacc Software AG crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OPACC_SOFTWARE_AG_KEY).toBe('opacc-software-ag');
    expect(OPACC_SOFTWARE_AG_COMPANY_NAME).toBe('Opacc Software AG');
    expect(OPACC_SOFTWARE_AG_COMPANY_DOMAIN).toBe('jobs.opacc.ch');
  });

  // ── isCompanyJob ──
  describe('isOpaccSoftwareAgJob', () => {
    it('matches by companyKey', () => {
      expect(isOpaccSoftwareAgJob({ companyKey: 'opacc-software-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOpaccSoftwareAgJob({ company: 'Opacc Software AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOpaccSoftwareAgJob({ url: 'https://my.jobalino.ch/jobs/123' })).toBe(true);
      expect(isOpaccSoftwareAgJob({ url: 'https://jobs.opacc.ch/kunden-bedienen/role.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOpaccSoftwareAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOpaccSoftwareAgJob(null)).toBe(false);
      expect(isOpaccSoftwareAgJob(undefined)).toBe(false);
      expect(isOpaccSoftwareAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the official careers domain', () => {
      expect(isTrustedDomain('https://jobs.opacc.ch/kunden-bedienen/role.html')).toBe(true);
    });

    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://my.jobalino.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.my.jobalino.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('official source spec', () => {
    it('extracts vacancies from both official job sections', async () => {
      const spec = loadSpec(OPACC_SOFTWARE_AG_KEY);
      const currentUrls = [
        'https://jobs.opacc.ch/kunden-bedienen/teamleiterin-support-128.html',
        'https://jobs.opacc.ch/kunden-bedienen/projektleiterin-erp-junior-senior.html',
        'https://jobs.opacc.ch/fundament-ausbauen/system-engineer-junior-professional.html',
      ];
      const homepage = `<a href="${currentUrls[0]}">TeamleiterIn Support</a>
        <a href="${currentUrls[1]}">ProjektleiterIn ERP Junior / Senior</a>
        <a href="${currentUrls[2]}">Cloud Engineer (Betrieb)</a>`;
      const pages = new Map([
        [currentUrls[0], detailPage(currentUrls[0], 'TeamleiterIn Support', 'Rothenburg', '6023')],
        [currentUrls[1], detailPage(currentUrls[1], 'ProjektleiterIn ERP Junior / Senior', 'Rothenburg', '6023')],
        [currentUrls[2], detailPage(currentUrls[2], 'Cloud Engineer (Betrieb)', 'Rothenburg', '6023')],
      ]);
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://jobs.opacc.ch/robots.txt') return response(url, 'User-agent: *\nAllow: /');
        if (url === 'https://jobs.opacc.ch/') return response(url, homepage);
        if (pages.has(url)) return response(url, pages.get(url)!);
        throw new Error(`unexpected URL ${url}`);
      });

      expect(spec.seedUrls).toEqual(['https://jobs.opacc.ch/']);
      expect(spec.mode).toBe('template');
      const template = templateToRegex(spec.detailTemplate);
      expect(template.test('/kunden-bedienen/teamleiterin-support-128.html')).toBe(true);
      expect(template.test('/fundament-ausbauen/system-engineer-junior-professional.html')).toBe(true);
      expect(template.test('/de/jobpreview/3197')).toBe(false);

      const rows = await runSpecInProduction(spec, {
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });

      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.url)).toEqual(currentUrls);
      expect(rows.every((row) => row.company === 'Opacc Software AG')).toBe(true);
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
      expect(slugify('Developer opacc-software-ag ch')).toBe('developer-opacc-software-ag-ch');
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
      id: 'opacc-software-ag-abc123',
      slug: 'test-position-opacc-software-ag-ch',
      slugByLocale: { de: 'test-position-opacc-software-ag-ch' },
      company: 'Opacc Software AG',
      companyKey: 'opacc-software-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://my.jobalino.ch/jobs/test',
      source: 'Opacc Software AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^opacc-software-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
