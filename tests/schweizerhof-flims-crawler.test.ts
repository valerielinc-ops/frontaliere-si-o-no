import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  SCHWEIZERHOF_FLIMS_KEY,
  SCHWEIZERHOF_FLIMS_COMPANY_NAME,
  extractSchweizerhofFlimsDetailFields,
  isSchweizerhofFlimsJob,
  isTrustedDomain,
} from '../scripts/lib/schweizerhof-flims-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  loadSpec,
  runSpecInProduction,
} from '../scripts/lib/prospector/spec-crawler.mjs';
import { SKIP_LIVE_DATA } from './helpers/live-data';

describe('Schweizerhof crawler parser', () => {
  it('keeps a real HCM4all vacancy when tenant identity is in the job-body heading', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const detailUrl = 'https://romantik.example/list/19839';
    const detailHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    );
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(`<a href="${detailUrl}">Portier Housekeeping</a>`);
      if (url === detailUrl) return new Response(detailHtml);
      throw new Error(`unexpected fixture URL ${url}`);
    };

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
    } as any, {
      fetchImpl,
      detailExtractor: extractSchweizerhofFlimsDetailFields,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Portier Housekeeping (m/w/d)', location: 'Flims, Graubünden' });
  });

  it('rejects a generic Schweizerhof heading when the source locality is Grindelwald BE', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const detailUrl = 'https://romantik.example/list/19839';
    const detailHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    )
      .replaceAll('Flims', 'Grindelwald')
      .replaceAll('Graubünden', 'Bern')
      .replaceAll('7018', '3818')
      .replace('</main>', '<footer>Schweizerhof Flims</footer></main>');
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(`<a href="${detailUrl}">Portier Housekeeping</a>`);
      if (url === detailUrl) return new Response(detailHtml);
      throw new Error(`unexpected fixture URL ${url}`);
    };

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
    } as any, {
      fetchImpl,
      detailExtractor: extractSchweizerhofFlimsDetailFields,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
    });

    expect(rows).toHaveLength(0);
  });

  it('requires source-owned Schweizerhof tenant evidence as well as Flims locality', () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    );
    const edelweissFields = extractSchweizerhofFlimsDetailFields(
      fixture.replace(
        '<h2>Warum Sie zu uns in den Schweizerhof kommen sollten</h2>',
        '<h2>Hotel Edelweiss</h2><p>Jobs near Schweizerhof Flims</p>',
      ),
      'https://romantikhotels.hcm4all.de/list/19839',
    );
    const schweizerhofFields = extractSchweizerhofFlimsDetailFields(
      fixture.replace(
        '<h2>Warum Sie zu uns in den Schweizerhof kommen sollten</h2>',
        '<h2>Schweizerhof</h2><p>Jobs near Schweizerhof Flims</p>',
      ),
      'https://romantikhotels.hcm4all.de/list/19839',
    );

    expect(edelweissFields.workplaceLabels || []).not.toContain('Schweizerhof Flims');
    expect(schweizerhofFields.workplaceLabels || []).toContain('Schweizerhof Flims');
    expect(edelweissFields.tenantHeading).toBe('Hotel Edelweiss');
    expect(schweizerhofFields.tenantHeading).toBe('Schweizerhof Flims');
  });

  it('treats a native heading for another tenant as an expected out-of-scope detail', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const details = Array.from({ length: 20 }, (_, index) => (
      `https://romantik.example/list/${18000 + index}`
    ));
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    );
    const otherTenant = fixture.replace(
      '<h2>Warum Sie zu uns in den Schweizerhof kommen sollten</h2>',
      '<h2>Hotel Other</h2><h2>Jobs at Schweizerhof Flims</h2>',
    );
    expect(extractSchweizerhofFlimsDetailFields(
      otherTenant,
      'https://romantikhotels.hcm4all.de/list/18010',
    ).tenantHeading).toBe('Hotel Other');
    const listing = details.map((url, index) => `<a href="${url}">Hospitality role ${index + 1}</a>`).join('');
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(listing);
      const index = details.indexOf(url);
      if (index < 0) throw new Error(`unexpected fixture URL ${url}`);
      return new Response(index < 10 ? fixture : otherTenant);
    };

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
      tenantScope: {
        nativeMarker: 'tenantHeading',
        expectedText: 'Schweizerhof Flims',
        foreignLocationOutOfScope: true,
      },
    } as any, {
      fetchImpl,
      detailExtractor: extractSchweizerhofFlimsDetailFields,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    });

    expect(rows).toHaveLength(10);
    expect((rows as any).detailDrop).toEqual({
      candidates: 10, gone: 0, rejected: 0, dropped: 0,
    });
  });

  it('requires exact normalized detail tenant identity', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const detailUrl = 'https://romantik.example/list/20040';
    const detail = {
      title: 'Hospitality role',
      location: 'Flims, Graubünden',
      addressCountry: 'CH',
      locationCandidates: [{ location: 'Flims, Graubünden', addressCountry: 'CH' }],
      description: 'A source-backed hospitality vacancy with a complete description and workplace in Flims.',
      tenantHeading: 'Schweizerhof Flims Careers',
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response('<a href="' + detailUrl + '">Hospitality role</a>');
      if (url === detailUrl) return new Response('<h1>Hospitality role</h1>');
      throw new Error('unexpected fixture URL ' + url);
    };

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
      tenantScope: {
        nativeMarker: 'tenantHeading',
        expectedText: 'Schweizerhof Flims',
        foreignLocationOutOfScope: true,
      },
    } as any, {
      fetchImpl,
      detailExtractor: () => detail,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    });

    expect(rows).toHaveLength(0);
    expect((rows as any).detailDrop).toEqual({
      candidates: 1, gone: 1, rejected: 0, dropped: 1,
    });
  });

  it('does not attach a global listing marker to an unrelated anchor', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const detailUrls = Array.from({ length: 10 }, (_, index) => (
      'https://romantik.example/list/' + (21000 + index)
    ));
    const targetHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    );
    const missingHtml = '<h1>Hospitality role</h1><h2>Team</h2><div class="job-location">Flims</div>'
      + '<article class="vacancy-description">'
      + 'A source-backed hospitality role with supportive colleagues, fair working hours, '
      + 'professional training and an attractive workplace in the region.'
      + '</article>';
    const listing = '<div class="job-ads-unit-icon__tooltip">Hotel Other</div>'
      + detailUrls.map((url, index) => (
        '<a href="' + url + '">Hospitality role ' + (index + 1) + '</a>'
      )).join('');
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(listing);
      if (url === detailUrls[0]) return new Response(targetHtml);
      if (detailUrls.includes(url)) return new Response(missingHtml);
      throw new Error('unexpected fixture URL ' + url);
    };

    await expect(runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
      tenantScope: {
        nativeMarker: 'tenantHeading',
        expectedText: 'Schweizerhof Flims',
        foreignLocationOutOfScope: true,
        listingMarker: {
          tag: 'div',
          class: 'job-ads-unit-icon__tooltip',
          containerTag: 'div',
          containerClass: 'job-ad-block',
        },
      },
    } as any, {
      fetchImpl,
      detailExtractor: extractSchweizerhofFlimsDetailFields,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    })).rejects.toMatchObject({
      specDetailDrop: { candidates: 10, gone: 9, rejected: 0, dropped: 9 },
      specDiscoveredCount: 10,
    });
  });

  it('decodes entity-encoded listing hrefs before attaching the row marker', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const targetUrls = Array.from({ length: 9 }, (_, index) => (
      'https://romantik.example/list/' + (22000 + index)
    ));
    const otherUrl = 'https://romantik.example/list/20040?lang=de&foo=1';
    const detailUrls = [...targetUrls, otherUrl];
    const targetHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'schweizerhof-flims', 'detail-tenant-heading.html'),
      'utf8',
    );
    const missingHtml = '<h1>Hospitality role</h1><h2>Team</h2><div class="job-location">Flims</div>'
      + '<article class="vacancy-description">'
      + 'A source-backed hospitality role with supportive colleagues, fair working hours, '
      + 'professional training and an attractive workplace in the region.'
      + '</article>';
    const listing = detailUrls.map((url, index) => {
      const href = index === detailUrls.length - 1
        ? '/list/20040?lang=de&amp;foo=1'
        : url.replace('https://romantik.example', '');
      const marker = index === detailUrls.length - 1
        ? '<div class="job-ads-unit-icon__tooltip">Hotel Other</div>'
        : '';
      return '<div class="job-ad-block">' + marker
        + '<a href="' + href + '">Hospitality role ' + (index + 1) + '</a></div>';
    }).join('');
    const structuredListings = detailUrls.map((url, index) => ({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      url,
      title: 'Hospitality role ' + (index + 1),
    }));
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) {
        return new Response(
          '<script type="application/ld+json">' + JSON.stringify(structuredListings) + '</script>' + listing,
        );
      }
      if (targetUrls.includes(url)) return new Response(targetHtml);
      if (url === otherUrl) return new Response(missingHtml);
      throw new Error('unexpected fixture URL ' + url);
    };

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
      tenantScope: {
        nativeMarker: 'tenantHeading',
        expectedText: 'Schweizerhof Flims',
        foreignLocationOutOfScope: true,
        listingMarker: {
          tag: 'div',
          class: 'job-ads-unit-icon__tooltip',
          containerTag: 'div',
          containerClass: 'job-ad-block',
        },
      },
    } as any, {
      fetchImpl,
      detailExtractor: extractSchweizerhofFlimsDetailFields,
      lookupImpl: async () => [{ address: '93.184.216.216', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    });

    expect(rows).toHaveLength(9);
    expect((rows as any).detailDrop).toEqual({
      candidates: 9, gone: 0, rejected: 0, dropped: 0,
    });
  });

  it('fails closed when the detail has no native tenant marker', async () => {
    const seed = 'https://romantik.example/list/?l=de';
    const details = Array.from({ length: 10 }, (_, index) => (
      `https://romantik.example/list/${19000 + index}`
    ));
    const listing = details.map((url, index) => `<a href="${url}">Hospitality role ${index + 1}</a>`).join('');
    const detailHtml = '<h1>Hospitality role</h1><h2>Team</h2><div class="job-location">Flims</div>'
      + '<article class="vacancy-description">'
      + 'Schweizerhof Flims offers a varied hospitality role with supportive colleagues, '
      + 'fair working hours, professional training and an attractive workplace in the region.'
      + '</article>';
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url === seed) return new Response(listing);
      if (!details.includes(url)) throw new Error(`unexpected fixture URL ${url}`);
      return new Response(detailHtml);
    };

    await expect(runSpecInProduction({
      companyKey: 'schweizerhof-flims',
      companyName: 'Schweizerhof',
      companyHost: 'romantik.example',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/list/*',
      detailEnrichment: true,
      detailCandidateText: 'Schweizerhof Flims',
      tenantScope: {
        nativeMarker: 'tenantHeading',
        expectedText: 'Schweizerhof Flims',
        foreignLocationOutOfScope: true,
      },
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      jinaRetries: 0,
      disableWafProxy: true,
    })).rejects.toMatchObject({
      specDetailDrop: { candidates: 10, gone: 10, rejected: 0, dropped: 10 },
      specDiscoveredCount: 10,
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SCHWEIZERHOF_FLIMS_KEY).toBe('schweizerhof-flims');
    expect(SCHWEIZERHOF_FLIMS_COMPANY_NAME).toBe('Schweizerhof');
  });

  // ── isCompanyJob ──
  describe('isSchweizerhofFlimsJob', () => {
    it('matches by companyKey', () => {
      expect(isSchweizerhofFlimsJob({ companyKey: 'schweizerhof-flims' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSchweizerhofFlimsJob({ company: 'Schweizerhof' })).toBe(true);
    });

    it('matches by HotelCareer company URL', () => {
      expect(isSchweizerhofFlimsJob({ url: 'https://hotelcareer.ch/jobs/romantik-hotel-schweizerhof-11933/123' })).toBe(true);
    });

    it('matches an HCM4all ATS detail URL without company fields', () => {
      expect(isSchweizerhofFlimsJob({ url: 'https://romantikhotels.hcm4all.de/list/123' })).toBe(true);
    });

    it('does not treat the HCM4all index as a detail listing', () => {
      expect(isSchweizerhofFlimsJob({ url: 'https://romantikhotels.hcm4all.de/list/?l=de' })).toBe(false);
    });

    it('rejects unrelated HotelCareer listings', () => {
      expect(isSchweizerhofFlimsJob({ url: 'https://hotelcareer.ch/jobs/blatter-s-hotel-arosa-4340/123' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isSchweizerhofFlimsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSchweizerhofFlimsJob(null)).toBe(false);
      expect(isSchweizerhofFlimsJob(undefined)).toBe(false);
      expect(isSchweizerhofFlimsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hotelcareer.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hotelcareer.ch/job/456')).toBe(true);
    });

    it('trusts the official Romantik jobs source', () => {
      expect(isTrustedDomain('https://www.romantikhotels.com/de/romantik-jobs/jobs/job/146/')).toBe(true);
    });

    it('trusts the official HCM4all ATS source', () => {
      expect(isTrustedDomain('https://romantikhotels.hcm4all.de/list/?l=de')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // Legge la spec VIVA in data/prospector/crawlers/ (loadSpec), che il bot
  // prospector riscrive: fuori dal gate delle PR, nel monitor post-merge
  // (replay del 2026-09-30: l'esito cambia con i dati di 7 e 14 giorni fa).
  it.skipIf(SKIP_LIVE_DATA)('uses the official HCM4all ATS index as its production source', () => {
    const spec = loadSpec('schweizerhof-flims');

    expect(spec.companyHost).toBe('romantikhotels.hcm4all.de');
    expect(spec.seedUrls).toEqual(['https://romantikhotels.hcm4all.de/list/?l=de']);
    expect(spec.detailTemplate).toBe('/list/*');
    expect(spec.listingCandidateText).toBeUndefined();
    expect(spec.detailCandidateText).toBe('Schweizerhof Flims');
    expect(spec.tenantScope).toEqual({
      nativeMarker: 'tenantHeading',
      expectedText: 'Schweizerhof Flims',
      listingExpectedText: 'Romantik Hotel Schweizerhof Flims',
      foreignLocationOutOfScope: true,
      listingMarker: {
        tag: 'div',
        class: 'job-ads-unit-icon__tooltip',
        containerTag: 'div',
        containerClass: 'job-ad-block',
      },
    });
    expect(spec.rescueOnEmptyListing).toBe(true);
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
      expect(slugify('Developer schweizerhof-flims ch')).toBe('developer-schweizerhof-flims-ch');
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
      id: 'schweizerhof-flims-abc123',
      slug: 'test-position-schweizerhof-flims-ch',
      slugByLocale: { de: 'test-position-schweizerhof-flims-ch' },
      company: 'Schweizerhof',
      companyKey: 'schweizerhof-flims',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: 'Schweizerhof Dedicated Parser',
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
      expect(validJob.id).toMatch(/^schweizerhof-flims-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
