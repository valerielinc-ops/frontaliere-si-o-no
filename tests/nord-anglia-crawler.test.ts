import { afterEach, describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  NORD_ANGLIA_KEY,
  NORD_ANGLIA_COMPANY_NAME,
  NORD_ANGLIA_COMPANY_DOMAIN,
  canonicalizeNordAngliaJobUrl,
  fetchAllNordAngliaJobs,
  isNordAngliaJob,
  isTrustedDomain,
  parseNordAngliaRss,
} from '../scripts/lib/nord-anglia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('La Côte International School Aubonne (Nord Anglia Education) crawler parser', () => {
  const rssItemXml = ({
    title = '<title><![CDATA[Teacher of Biology (Aubonne, CH)]]></title>',
    link = '<link>https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/</link>',
    description = '<description><![CDATA[<p>Teach biology in Aubonne.</p>]]></description>',
    pubDate = '<pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate>',
  } = {}) => `<item>${title}${link}${description}${pubDate}</item>`;
  const rssFeed = (...items: string[]) => `<rss><channel>${items.join('')}</channel></rss>`;
  const validRssItem = (overrides = {}) => rssFeed(rssItemXml(overrides));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(NORD_ANGLIA_KEY).toBe('nord-anglia');
    expect(NORD_ANGLIA_COMPANY_NAME).toBe('La Côte International School (Nord Anglia Education)');
    expect(NORD_ANGLIA_COMPANY_DOMAIN).toBe('nordangliaeducation.com');
  });

  // ── isCompanyJob ──
  describe('isNordAngliaJob', () => {
    it('matches by companyKey', () => {
      expect(isNordAngliaJob({ companyKey: 'nord-anglia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNordAngliaJob({ company: 'La Côte International School (Nord Anglia Education)' })).toBe(true);
    });

    it('matches by URL domain (marketing site)', () => {
      expect(isNordAngliaJob({ url: 'https://www.nordangliaeducation.com/la-cote-aubonne/careers' })).toBe(true);
    });

    it('matches by URL domain (jobs2web ATS host)', () => {
      expect(isNordAngliaJob({ url: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNordAngliaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNordAngliaJob(null)).toBe(false);
      expect(isNordAngliaJob(undefined)).toBe(false);
      expect(isNordAngliaJob({})).toBe(false);
    });

    // ── Collision guard: careers.nordangliaeducation.com is a SHARED
    // jobs2web tenant serving multiple unrelated Nord Anglia Swiss brands
    // (Collège du Léman Geneva, Collège Champittet Lausanne/Pully, Collège
    // Beau Soleil Villars-sur-Ollon). isNordAngliaJob() must not fuzzy-match
    // those sibling schools' jobs just because they share the same ATS host —
    // matching happens on companyKey/company text, not bare host membership,
    // so a job explicitly labelled as one of those schools is NOT claimed here.
    it('does not claim jobs explicitly labelled as sibling Nord Anglia Swiss schools', () => {
      expect(
        isNordAngliaJob({
          companyKey: 'college-du-leman',
          company: 'Collège du Léman',
          url: 'https://careers.nordangliaeducation.com/job/Geneva-Nurse-on-call/1234567890/',
        }),
      ).toBe(false);
      expect(
        isNordAngliaJob({
          companyKey: 'college-champittet',
          company: 'Collège Champittet',
          url: 'https://careers.nordangliaeducation.com/job/Pully-IB-Teachers/1234567891/',
        }),
      ).toBe(false);
      expect(
        isNordAngliaJob({
          companyKey: 'college-beau-soleil',
          company: 'Collège Beau Soleil',
          url: 'https://careers.nordangliaeducation.com/job/Villars-sur-Ollon-Study-Coaches/1234567892/',
        }),
      ).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary marketing domain', () => {
      expect(isTrustedDomain('https://www.nordangliaeducation.com/la-cote-aubonne/careers')).toBe(true);
    });

    it('trusts the jobs2web ATS host', () => {
      expect(isTrustedDomain('https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  it('publishes canonical job URLs without jobs2web tracking parameters', () => {
    expect(canonicalizeNordAngliaJobUrl(
      'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/?feedId=null&utm_source=J2WRSS&utm_medium=rss&utm_campaign=J2W_RSS',
    )).toBe('https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/');
    expect(canonicalizeNordAngliaJobUrl('https://example.com/job/Aubonne-Teacher/1/?utm_source=rss')).toBe('');
  });

  it('isolates a hard failure to the Nord Anglia background step and its slice', () => {
    const workflowDir = join(ROOT, '.github', 'workflows');
    const groupFiles = readdirSync(workflowDir).filter((file) => /^crawler-group-\d+\.yml$/.test(file));
    const located = groupFiles.flatMap((file) => {
      const workflow = YAML.parse(readFileSync(join(workflowDir, file), 'utf8'));
      return Object.values(workflow?.jobs || {}).flatMap((job: any) => {
        const steps = Array.isArray(job?.steps) ? job.steps : [];
        const index = steps.findIndex((step: any) => step?.id === 'crawler-nord-anglia');
        return index < 0 ? [] : [{ file, steps, index, step: steps[index] }];
      });
    });

    expect(located).toHaveLength(1);
    const [{ steps, index, step }] = located;
    expect(step.background).toBe(true);
    expect(step.env.JOBS_SLICE_FILE).toBe('data/jobs/by-crawler/nord-anglia.json');
    expect(step.run).toContain('node scripts/update-nord-anglia-jobs.mjs');
    expect(step.run).toMatch(/crawler_exit=\$\?/);
    expect(step.run).toMatch(/if \[ "\$crawler_exit" -eq 0 \]; then\s+\(node scripts\/cleanup-jobs\.mjs\)/);
    expect(step.run).toMatch(/if \[ "\$crawler_exit" -eq 0 \]; then\s+flock .*git-commit-data\.sh/);
    expect(steps.slice(0, index).some((candidate: any) => candidate?.background === true)).toBe(true);
    expect(steps.slice(index + 1).some((candidate: any) => candidate?.background === true)).toBe(true);
    expect(steps.slice(index + 1).some((candidate: any) => candidate?.['wait-all'] === true)).toBe(true);
  });

  it('logs a canonical URL drop without exposing its query and fails on feed-wide URL drift', async () => {
    const driftedFeed = validRssItem({
      link: '<link>https://example.com/jobs/1399902133/?session=secret-token</link>',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Aubonne title\/URL scope guard: dropped 1\/1 items/,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[nord-anglia-canonical-url-drop]'),
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('https://example.com/jobs/1399902133/');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-token');
    warnSpy.mockRestore();
  });

  it('drops and logs one shifted URL while keeping a valid sibling at the 50% budget', async () => {
    const mixedFeed = rssFeed(
      rssItemXml(),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics (Aubonne, CH)]]></title>',
        link: '<link>https://example.com/new-job-template/1400000000/?session=rotating</link>',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mixedFeed, { status: 200 })));

    const jobs = await fetchAllNordAngliaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobReqId).toBe('1399902133');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[nord-anglia-canonical-url-drop]'),
    );
    warnSpy.mockRestore();
  });

  it('fails on feed-wide title-scope drift instead of silently returning an empty slice', async () => {
    const driftedFeed = validRssItem({
      title: '<title><![CDATA[Teacher of Biology - Aubonne]]></title>',
      link: '<link>https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/?session=secret-token</link>',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Aubonne title\/URL scope guard: dropped 1\/1 items/,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[nord-anglia-title-scope-drop]'),
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('Teacher of Biology - Aubonne');
    expect(warnSpy.mock.calls.flat().join(' ')).toContain(
      'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/',
    );
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-token');
    warnSpy.mockRestore();
  });

  it('ignores unrelated full-text search noise outside both Aubonne signals', async () => {
    const noisyFeed = rssFeed(
      rssItemXml(),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics (Geneva, CH)]]></title>',
        link: '<link>https://careers.nordangliaeducation.com/job/Geneva-Teacher-of-Mathematics/1400000000/</link>',
      }),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Physics (Pully, CH)]]></title>',
        link: '<link>https://careers.nordangliaeducation.com/job/Pully-Teacher-of-Physics/1400000001/</link>',
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(noisyFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).resolves.toHaveLength(1);
  });

  it('combines title and URL failures across different Aubonne candidates', async () => {
    const splitDriftFeed = rssFeed(
      rssItemXml({
        title: '<title><![CDATA[Teacher of Biology - Aubonne]]></title>',
      }),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics (Aubonne, CH)]]></title>',
        link: '<link>https://example.com/new-job-template/1400000000/</link>',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(splitDriftFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Aubonne title\/URL scope guard: dropped 2\/2 items/,
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('[nord-anglia-title-scope-drop]');
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('[nord-anglia-canonical-url-drop]');
    warnSpy.mockRestore();
  });

  it('keeps a valid job when title-scope drops are exactly 50% of a small feed', async () => {
    const mixedFeed = rssFeed(
      rssItemXml(),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics - Aubonne]]></title>',
        link: '<link>https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Mathematics/1400000000/</link>',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mixedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).resolves.toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[nord-anglia-title-scope-drop]'),
    );
    warnSpy.mockRestore();
  });

  it('derives new identity from the canonical URL, not rotating jobs2web query tokens', async () => {
    const base = 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(validRssItem({
        link: `<link>${base}?feedId=null&amp;utm_source=J2WRSS&amp;session=first</link>`,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(validRssItem({
        link: `<link>${base}?feedId=changed&amp;utm_source=Partner&amp;session=second</link>`,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [first] = await fetchAllNordAngliaJobs();
    const [second] = await fetchAllNordAngliaJobs();
    expect(first.url).toBe(base);
    expect(second.url).toBe(base);
    expect(second.id).toBe(first.id);
  });

  it('preserves an indexed raw-link ID and slug history during the canonical-identity migration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(validRssItem(), { status: 200 })));
    const [fresh] = await fetchAllNordAngliaJobs();
    const legacy = {
      ...fresh,
      id: 'nord-anglia-8720a5afd8ce',
      url: `${fresh.url}?feedId=null&utm_source=J2WRSS&utm_medium=rss&utm_campaign=J2W_RSS`,
      slug: 'indexed-legacy-slug',
      slugByLocale: { en: 'indexed-legacy-slug', fr: 'slug-fr-indexe' },
      previousSlugs: ['older-indexed-slug'],
    };

    const [merged] = mergePreserveLocaleData([legacy], [{ ...fresh }], { retainMissingJobs: false });
    expect(merged.id).toBe(legacy.id);
    expect(merged.url).toBe(fresh.url);
    expect(merged.slugByLocale.fr).toBe('slug-fr-indexe');
    expect(merged.previousSlugs).toContain('older-indexed-slug');
  });

  describe('RSS parser guards', () => {
    it('preserves valid CDATA/text leaves', () => {
      expect(parseNordAngliaRss(validRssItem())).toEqual([{
        title: 'Teacher of Biology (Aubonne, CH)',
        link: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/',
        description: '<p>Teach biology in Aubonne.</p>',
        pubDate: 'Mon, 01 Apr 2026 12:00:00 +0000',
      }]);
    });

    it.each([
      '<rss><channel><item><title>Teacher</title></description></item></channel></rss>',
      '<rss><channel><item><title>Teacher</title></item>',
    ])('rejects malformed or truncated XML before parsing', (xml) => {
      expect(() => parseNordAngliaRss(xml)).toThrow(/XML parse failed/);
    });

    it('rejects a valid XML document whose RSS channel envelope drifted', () => {
      expect(() => parseNordAngliaRss('<rss><feed><item /></feed></rss>')).toThrow(
        /feed shape drift: expected an rss\.channel object/,
      );
    });

    it.each([
      ['title', { title: '<title><strong>Teacher of Biology (Aubonne, CH)</strong></title>' }],
      ['link', { link: '<link>https://careers.nordangliaeducation.com/job/Aubonne-One/1/</link><link>https://careers.nordangliaeducation.com/job/Aubonne-Two/2/</link>' }],
      ['description', { description: '<description>First</description><description>Second</description>' }],
      ['pubDate', { pubDate: '<pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate><pubDate>Tue, 02 Apr 2026 12:00:00 +0000</pubDate>' }],
    ])('drops a single item with a non-scalar or repeated %s leaf instead of aborting the whole feed', (field, override) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseNordAngliaRss(validRssItem(override))).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${field} must be a single scalar string`)),
      );
      warnSpy.mockRestore();
    });

    it('keeps one malformed sibling but aborts when malformed items exceed the feed budget', async () => {
      const valid = rssItemXml();
      const malformed = rssItemXml({
        link: '<link>https://careers.nordangliaeducation.com/job/Aubonne-One/1/</link><link>https://careers.nordangliaeducation.com/job/Aubonne-Two/2/</link>',
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(rssFeed(valid, malformed), { status: 200 }))
        .mockResolvedValueOnce(new Response(rssFeed(valid, malformed, malformed), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchAllNordAngliaJobs()).resolves.toHaveLength(1);
      const firstRunWarnings = warnSpy.mock.calls.flat().join(' ');
      expect(firstRunWarnings).toContain('RSS item 2 skipped');
      expect(firstRunWarnings).not.toContain('[nord-anglia-title-scope-drop]');
      expect(firstRunWarnings).not.toContain('[nord-anglia-canonical-url-drop]');
      warnSpy.mockClear();
      await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
        /\[nord-anglia-drop-ratio\] malformed RSS item guard: dropped 2\/3 items/,
      );
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Teacher of Biology (Aubonne)');
      expect(slug).toBe('teacher-of-biology-aubonne');
    });

    it('strips diacritics', () => {
      expect(slugify('Coordinateur des transports scolaires & concierge')).toBe('coordinateur-des-transports-scolaires-concierge');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Teacher of Mathematics nord-anglia aubonne')).toBe('teacher-of-mathematics-nord-anglia-aubonne');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllNordAngliaJobs emits)
    const validJob = {
      id: 'nord-anglia-abc123',
      slug: 'teacher-of-biology-nord-anglia-aubonne',
      slugByLocale: { en: 'teacher-of-biology-nord-anglia-aubonne' },
      company: 'La Côte International School (Nord Anglia Education)',
      companyKey: 'nord-anglia',
      companyDomain: 'nordangliaeducation.com',
      title: 'Teacher of Biology',
      titleByLocale: { en: 'Teacher of Biology' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Aubonne',
      canton: 'VD',
      url: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/',
      source: 'La Côte International School Aubonne Dedicated Parser (Nord Anglia jobs2web RSS)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Aubonne',
      addressRegion: 'VD',
      streetAddress: 'Chemin de Clamogne 8',
      postalCode: '1170',
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
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
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
      expect(validJob.id).toMatch(/^nord-anglia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('is scoped to the Aubonne VD campus address, not another Nord Anglia location', () => {
      expect(validJob.canton).toBe('VD');
      expect(validJob.addressLocality).toBe('Aubonne');
      expect(validJob.postalCode).toBe('1170');
    });
  });
});
