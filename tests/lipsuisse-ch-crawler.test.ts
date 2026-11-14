import { describe, it, expect } from 'vitest';
import {
  LIPSUISSE_CH_KEY,
  LIPSUISSE_CH_COMPANY_NAME,
  isLipsuisseChJob,
  isTrustedDomain,
} from '../scripts/lib/lipsuisse-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  collectSpecListingRows,
  createSpecUrlPolicy,
  loadSpec,
  normalizeSpecPagination,
  readDeclaredListingTotal,
  templateToRegex,
} from '../scripts/lib/prospector/spec-crawler.mjs';
import { extractRuntimeDetailFields } from '../scripts/lib/prospector/detail-extract.mjs';

describe('LIP Suisse crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LIPSUISSE_CH_KEY).toBe('lipsuisse-ch');
    expect(LIPSUISSE_CH_COMPANY_NAME).toBe('LIP Suisse');
  });

  it('keeps the promoted spec on the live vacancy index', () => {
    const spec = loadSpec(LIPSUISSE_CH_KEY);
    const detailTemplate = templateToRegex(spec.detailTemplate);

    expect(spec.mode).toBe('template');
    expect(spec.seedUrls).toEqual([
      'https://www.lipsuisse.ch/offres-emploi/?ajax_filter=true&per-page=100',
    ]);
    expect(spec.detailEnrichment).toBe(true);
    expect(spec.detailPostalCodeLocation).toBe(true);
    expect(spec.pagination).toMatchObject({ maxPages: 1, minCoverage: 0.95 });
    expect(readDeclaredListingTotal(
      '<h2><span>30</span>&nbsp;<span>Offres d\'emploi trouvées</span></h2>',
      normalizeSpecPagination(spec),
      spec,
    )).toBe(30);
    expect(readDeclaredListingTotal(
      '<h2>30&nbsp;Offres d&#039;emploi trouvées</h2>',
      normalizeSpecPagination(spec),
      spec,
    )).toBe(30);
    expect(detailTemplate.test('/offres-emploi/assistant-de-direction-batiment-h-f-3/')).toBe(true);
    expect(detailTemplate.test('/offres-emploi/carreleur-2/')).toBe(true);
    expect(detailTemplate.test('/offres-emploi/')).toBe(false);
  });

  it('normalizes the source-shifted JSON-LD workplace field through the official directory', () => {
    const spec = loadSpec(LIPSUISSE_CH_KEY);
    const cases = [
      {
        address: {
          streetAddress: 'avenue industrielle',
          addressLocality: 'avenue industrielle',
          addressRegion: '12',
          addressCountry: '1227',
          postalCode: '1227',
        },
        expected: { addressRegion: 'GE', addressCountry: 'CH' },
        candidate: { postalCode: '1227' },
      },
      {
        address: { postalCode: '1700 ' },
        expected: { location: 'Fribourg', addressLocality: 'Fribourg', addressRegion: 'FR', addressCountry: 'CH' },
      },
      {
        address: { postalCode: 'Lausanne ' },
        expected: { location: 'Lausanne', addressLocality: 'Lausanne', addressRegion: 'VD', addressCountry: 'CH' },
      },
    ];

    for (const { address, expected, candidate } of cases) {
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Test vacancy',
        description: 'A source-backed vacancy description with enough words for the detail extractor.',
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', ...address } },
      })}</script>`;
      const detail = extractRuntimeDetailFields(
        spec,
        html,
        'https://www.lipsuisse.ch/offres-emploi/test-vacancy/',
      );
      expect(detail).toMatchObject(expected);
      if (candidate) expect(detail.locationCandidates[0]).toMatchObject(candidate);
    }
  });

  it('extracts vacancy links from the index shape instead of the retired detail seed', async () => {
    const spec = loadSpec(LIPSUISSE_CH_KEY);
    const listingUrl = spec.seedUrls[0];
    const vacancyUrls = [
      'https://www.lipsuisse.ch/offres-emploi/assistant-de-direction-batiment-h-f-3/',
      'https://www.lipsuisse.ch/offres-emploi/carreleur-2/',
      ...Array.from({ length: 28 }, (_, index) => (
        `https://www.lipsuisse.ch/offres-emploi/offre-${index + 1}/`
      )),
    ];
    const html = `<h2>30&nbsp;Offres d'emploi trouvées</h2><main>${vacancyUrls.map((url) => (
      `<a href="${url}">Vacancy</a>`
    )).join('')}</main>`;
    const fetchImpl = async (url: string) => {
      if (url === 'https://www.lipsuisse.ch/robots.txt') {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      expect(url).toBe(listingUrl);
      return new Response(html, { status: 200 });
    };
    const policy = createSpecUrlPolicy(spec, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      const rows = await collectSpecListingRows(spec, {
        fetchImpl,
        sleepImpl: async () => {},
        retries: 0,
        disableWafProxy: true,
      }, policy);
      expect(rows).toHaveLength(30);
      expect(rows.slice(0, 2).map((row) => row.url)).toEqual([
        'https://www.lipsuisse.ch/offres-emploi/assistant-de-direction-batiment-h-f-3/',
        'https://www.lipsuisse.ch/offres-emploi/carreleur-2/',
      ]);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('keeps template-matched vacancies when the source uses untitled overlay anchors', async () => {
    const spec = loadSpec(LIPSUISSE_CH_KEY);
    const listingUrl = spec.seedUrls[0];
    const vacancyUrls = [
      'https://www.lipsuisse.ch/offres-emploi/assistant-de-direction-batiment-h-f-3/',
      'https://www.lipsuisse.ch/offres-emploi/carreleur-2/',
      ...Array.from({ length: 28 }, (_, index) => (
        `https://www.lipsuisse.ch/offres-emploi/offre-${index + 1}/`
      )),
    ];
    const html = `<h2>30&nbsp;Offres d'emploi trouvées</h2><main>${vacancyUrls.map((url) => (
      `<a href="${url}" aria-hidden="true"></a>`
    )).join('')}</main>`;
    const fetchImpl = async (url: string) => {
      if (url === 'https://www.lipsuisse.ch/robots.txt') {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      expect(url).toBe(listingUrl);
      return new Response(html, { status: 200 });
    };
    const policy = createSpecUrlPolicy(spec, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      const rows = await collectSpecListingRows(spec, {
        fetchImpl,
        sleepImpl: async () => {},
        retries: 0,
        disableWafProxy: true,
      }, policy);
      expect(rows).toHaveLength(30);
      expect(rows.slice(0, 2).map((row) => row.title)).toEqual([
        'assistant de direction batiment h f 3',
        'carreleur 2',
      ]);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('fails closed if the source ignores the enlarged page-size request', async () => {
    const spec = loadSpec(LIPSUISSE_CH_KEY);
    const listingUrl = spec.seedUrls[0];
    const vacancyUrls = Array.from({ length: 10 }, (_, index) => (
      `https://www.lipsuisse.ch/offres-emploi/offre-${index + 1}/`
    ));
    const html = `<h2>30&nbsp;Offres d'emploi trouvées</h2><main>${vacancyUrls.map((url) => (
      `<a href="${url}">Vacancy</a>`
    )).join('')}</main>`;
    const fetchImpl = async (url: string) => {
      if (url === 'https://www.lipsuisse.ch/robots.txt') {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      expect(url).toBe(listingUrl);
      return new Response(html, { status: 200 });
    };
    const policy = createSpecUrlPolicy(spec, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      await expect(collectSpecListingRows(spec, {
        fetchImpl,
        sleepImpl: async () => {},
        retries: 0,
        disableWafProxy: true,
      }, policy)).rejects.toThrow(/listing incompleta: 10\/30/);
    } finally {
      await policy.dispatcher.close();
    }
  });

  // ── isCompanyJob ──
  describe('isLipsuisseChJob', () => {
    it('matches by companyKey', () => {
      expect(isLipsuisseChJob({ companyKey: 'lipsuisse-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLipsuisseChJob({ company: 'LIP Suisse' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLipsuisseChJob({ url: 'https://lipsuisse.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLipsuisseChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLipsuisseChJob(null)).toBe(false);
      expect(isLipsuisseChJob(undefined)).toBe(false);
      expect(isLipsuisseChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://lipsuisse.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.lipsuisse.ch/job/456')).toBe(true);
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
      expect(slugify('Developer lipsuisse-ch ch')).toBe('developer-lipsuisse-ch-ch');
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
      id: 'lipsuisse-ch-abc123',
      slug: 'test-position-lipsuisse-ch-ch',
      slugByLocale: { fr: 'test-position-lipsuisse-ch-ch' },
      company: 'LIP Suisse',
      companyKey: 'lipsuisse-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://lipsuisse.ch/jobs/test',
      source: 'LIP Suisse Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^lipsuisse-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
