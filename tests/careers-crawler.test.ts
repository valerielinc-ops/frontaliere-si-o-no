import fs from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CAREERS_KEY,
  CAREERS_COMPANY_NAME,
  fetchAllCareersJobs,
  isCareersJob,
  isTrustedDomain,
  parseCareersRss,
} from '../scripts/lib/careers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const NEWEST_POSTED_DATE = daysAgo(1);
const FIRST_POSTED_DATE = daysAgo(2);
const SECOND_POSTED_DATE = daysAgo(3);
const RSS_FIXTURE = fs.readFileSync(
  new URL('./__fixtures__/careers-orior-rss.xml', import.meta.url),
  'utf8',
)
  .replace('{{PUB_DATE_0}}', NEWEST_POSTED_DATE.toUTCString())
  .replace('{{PUB_DATE_1}}', FIRST_POSTED_DATE.toUTCString())
  .replace('{{PUB_DATE_2}}', SECOND_POSTED_DATE.toUTCString());

const rssItemXml = ({
  title = '<title><![CDATA[Maintenance Mechanic (Böckten, BL)]]></title>',
  description = '<description><![CDATA[<p>Maintenance and repair work.</p>]]></description>',
  pubDate = `<pubDate>${SECOND_POSTED_DATE.toUTCString()}</pubDate>`,
  link = '<link>https://careers.orior.ch/job/Boeckten-Maintenance-BL/123/</link>',
} = {}) => `<item>${title}${description}${pubDate}${link}</item>`;
const rssFeed = (...items: string[]) => `<rss><channel>${items.join('')}</channel></rss>`;
const validRssItem = (overrides = {}) => rssFeed(rssItemXml(overrides));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lepatron crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CAREERS_KEY).toBe('careers');
    expect(CAREERS_COMPANY_NAME).toBe('lepatron');
  });

  // ── isCompanyJob ──
  describe('isCareersJob', () => {
    it('matches by companyKey', () => {
      expect(isCareersJob({ companyKey: 'careers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCareersJob({ company: 'lepatron' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCareersJob({ url: 'https://careers.orior.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCareersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCareersJob(null)).toBe(false);
      expect(isCareersJob(undefined)).toBe(false);
      expect(isCareersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://careers.orior.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.careers.orior.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('official ORIOR RSS feed', () => {
    it('extracts every observed listing with source-backed location and content', () => {
      const jobs = parseCareersRss(RSS_FIXTURE);

      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({
        title: 'Praktikant:in Product Manager Convenience, 80-100%',
        location: 'Böckten',
        canton: 'BL',
        postedDate: NEWEST_POSTED_DATE.toISOString().slice(0, 10),
      }), expect.objectContaining({
        title: 'Betriebsmechaniker: in Instandhaltung, 80-100%',
        location: 'Böckten',
        canton: 'BL',
        postedDate: SECOND_POSTED_DATE.toISOString().slice(0, 10),
      })]));
      expect(jobs.find((job) => job.title.startsWith('Betriebsmechaniker'))?.description)
        .toContain('Wartung und Reparatur der Anlagen');
    });

    it('builds stable identities and richer job fields from the feed', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(RSS_FIXTURE, { status: 200 })));

      const jobs = await fetchAllCareersJobs();
      expect(jobs).toHaveLength(2);
      const mechanic = jobs.find((job) => job.title.startsWith('Betriebsmechaniker'));
      const productManager = jobs.find((job) => job.title.startsWith('Praktikant:in'));
      expect(mechanic).toMatchObject({
        id: 'careers-74c7232eb1c8',
        slug: 'betriebsmechaniker-in-instandhaltung-80-100-careers-ch',
        location: 'Böckten',
        canton: 'BL',
        addressLocality: 'Böckten',
        addressRegion: 'BL',
        category: 'Tecnica',
        employmentType: 'FULL_TIME',
        sector: 'Alimentare',
      });
      expect(productManager).toMatchObject({
        id: 'careers-6445b15a4260',
        location: 'Böckten',
        canton: 'BL',
        employmentType: 'FULL_TIME',
        experienceLevel: 'intern',
      });
      expect(mechanic?.description.length).toBeGreaterThan(100);
      expect(productManager?.description.length).toBeGreaterThan(100);
    });

    it('canonicalizes tracking URLs without changing the stable job path', () => {
      const jobs = parseCareersRss(RSS_FIXTURE);
      const mechanic = jobs.find((job) => job.title.startsWith('Betriebsmechaniker'));

      expect(mechanic?.url).toBe(
        'https://careers.orior.ch/job/B%C3%B6ckten-Betriebsmechaniker-in-Instandhaltung%2C-80-100-BL/1402889733/',
      );
      expect(jobs.every((job) => !job.url.includes('?') && !job.url.includes('#'))).toBe(true);
    });

    it('preserves every indexed locale route while correcting legacy Lugano geography', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(RSS_FIXTURE, { status: 200 })));
      const freshJobs = await fetchAllCareersJobs();
      const freshMechanic = freshJobs.find((job) => job.id === 'careers-74c7232eb1c8');
      expect(freshMechanic).toBeDefined();

      const existing = [{
        ...freshMechanic,
        location: 'Lugano',
        canton: 'TI',
        addressLocality: 'Lugano',
        addressRegion: 'TI',
        slug: 'meccanico-operativo-in-manutenzione-80-100-lepatron-lugano',
        slugByLocale: {
          it: 'meccanico-operativo-in-manutenzione-80-100-lepatron-lugano',
          en: 'operational-mechanic-in-maintenance-80-100-lepatron-lugano',
          de: 'betriebsmechaniker-in-instandhaltung-80-100-lepatron-lugano',
          fr: 'mecanicien-operationnel-en-maintenance-80-100-lepatron-lugano',
        },
        previousSlugsByLocale: {
          it: ['betriebsmechaniker-in-instandhaltung-80-100-careers-ch'],
          de: ['betriebsmechaniker-in-instandhaltung-80-100-careers-ch'],
        },
      }];
      const routeSet = (job: {
        slugByLocale?: Record<string, string>;
        previousSlugsByLocale?: Record<string, string[]>;
      }, locale: string) => new Set([
        job.slugByLocale?.[locale],
        ...(job.previousSlugsByLocale?.[locale] || []),
      ].filter(Boolean));

      const [first] = mergePreserveLocaleData(existing, [structuredClone(freshMechanic)]);
      const [second] = mergePreserveLocaleData([structuredClone(first)], [structuredClone(freshMechanic)]);

      expect(first).toMatchObject({
        id: 'careers-74c7232eb1c8',
        location: 'Böckten',
        canton: 'BL',
        addressLocality: 'Böckten',
        addressRegion: 'BL',
      });
      for (const locale of ['it', 'en', 'de', 'fr']) {
        for (const route of routeSet(existing[0], locale)) {
          expect(routeSet(first, locale).has(route)).toBe(true);
        }
        expect(routeSet(second, locale)).toEqual(routeSet(first, locale));
      }
    });

    it('filters generic applications without filtering a concrete role', () => {
      const jobs = parseCareersRss(RSS_FIXTURE);
      const incompleteGeneric = parseCareersRss(validRssItem({
        title: '<title>Spontanbewerbung - Le Patron</title>',
      }));
      const concrete = parseCareersRss(validRssItem({
        title: '<title>Recruiter Spontanbewerbungen (Böckten, BL)</title>',
      }));

      expect(jobs.map((job) => job.title)).toEqual([
        'Praktikant:in Product Manager Convenience, 80-100%',
        'Betriebsmechaniker: in Instandhaltung, 80-100%',
      ]);
      expect(jobs.some((job) => /spontanbewerbung/i.test(job.title))).toBe(false);
      expect(incompleteGeneric).toEqual([]);
      expect(concrete).toHaveLength(1);
      expect(concrete[0].title).toBe('Recruiter Spontanbewerbungen');
    });

    it('fails loudly on shape drift but accepts a valid empty channel', () => {
      expect(() => parseCareersRss('<html>temporary challenge</html>')).toThrow(
        /missing the rss\.channel envelope/,
      );
      expect(parseCareersRss('<rss><channel><title>Le Patron</title></channel></rss>'))
        .toEqual([]);
      expect(parseCareersRss('<rss><channel></channel></rss>')).toEqual([]);
    });

    it('fails loudly when the RSS item is primitive', () => {
      expect(() => (
        parseCareersRss('<rss><channel><item>maintenance</item></channel></rss>')
      )).toThrow(/rss\.channel\.item must be an object or array/);
    });

    it('fails loudly when the RSS item element is renamed', () => {
      expect(() => (
        parseCareersRss(
          '<rss><channel><title>Le Patron</title><job><title>Maintenance</title></job></channel></rss>',
        )
      )).toThrow(/unexpected channel element: job/);
    });

    it('drops a partial row instead of publishing fabricated defaults, without aborting the rest of the feed', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const missingLocation = RSS_FIXTURE.replace(' (Böckten, BL)', '');
      const jobs = parseCareersRss(missingLocation);
      expect(jobs.map((job) => job.title)).toEqual(['Betriebsmechaniker: in Instandhaltung, 80-100%']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/missing location, Swiss canton/));
      warnSpy.mockRestore();
    });

    it.each([
      ['title', { title: '<title><strong>Maintenance Mechanic (Böckten, BL)</strong></title>' }],
      ['description', {
        description: '<description>First</description><description>Second</description>',
      }],
      ['pubDate', {
        pubDate: `<pubDate>${SECOND_POSTED_DATE.toUTCString()}</pubDate><pubDate>${FIRST_POSTED_DATE.toUTCString()}</pubDate>`,
      }],
      ['link', {
        link: '<link>https://careers.orior.ch/job/Boeckten-Maintenance-BL/123/</link><link>https://careers.orior.ch/job/Boeckten-Maintenance-BL/456/</link>',
      }],
    ])('drops a single item with a non-scalar or repeated %s leaf instead of aborting the whole feed', (field, override) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseCareersRss(validRssItem(override))).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${field} must be a single scalar string`)),
      );
      warnSpy.mockRestore();
    });

    it('keeps one malformed sibling but aborts when eligible-item drops exceed 50%', async () => {
      const valid = rssItemXml();
      const malformed = rssItemXml({
        link: '<link>https://careers.orior.ch/job/Boeckten-One-BL/123/</link><link>https://careers.orior.ch/job/Boeckten-Two-BL/456/</link>',
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(rssFeed(valid, malformed), { status: 200 }))
        .mockResolvedValueOnce(new Response(rssFeed(valid, malformed, malformed), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchAllCareersJobs()).resolves.toHaveLength(1);
      await expect(fetchAllCareersJobs()).rejects.toThrow(
        /\[careers-rss-drop-ratio\] dropped 2\/3 eligible items/,
      );
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each([
      '<rss><channel><item><title>Maintenance (Böckten, BL)</title></description></item></channel></rss>',
      '<rss><channel><item><title>Maintenance (Böckten, BL)</title></item>',
    ])('rejects malformed or truncated XML before parsing', (xml) => {
      expect(() => parseCareersRss(xml)).toThrow(/not well-formed XML/);
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
      expect(slugify('Developer careers ch')).toBe('developer-careers-ch');
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
      id: 'careers-abc123',
      slug: 'test-position-careers-ch',
      slugByLocale: { de: 'test-position-careers-ch' },
      company: 'lepatron',
      companyKey: 'careers',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Böckten',
      canton: 'BL',
      url: 'https://careers.orior.ch/job/B%C3%B6ckten-Test-BL/123/',
      source: 'lepatron Dedicated Parser',
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
      expect(validJob.id).toMatch(/^careers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
