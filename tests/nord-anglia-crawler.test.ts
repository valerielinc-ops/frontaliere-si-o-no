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
  parseNordAngliaSearchResults,
  parseNordAngliaRss,
} from '../scripts/lib/nord-anglia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { FeedEndpointUnavailableError } from '../scripts/lib/feed-endpoint-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Nord Anglia Education Switzerland crawler parser', () => {
  const rssItemXml = ({
    title = '<title><![CDATA[Teacher of Biology (Geneva, CH)]]></title>',
    link = '<link>https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/</link>',
    description = '<description><![CDATA[<p>Teach biology in Geneva.</p>]]></description>',
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
    expect(NORD_ANGLIA_COMPANY_NAME).toBe('Nord Anglia Education Switzerland');
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

    it('rejects a global marketing careers URL without a Swiss location signal', () => {
      expect(isNordAngliaJob({ url: 'https://www.nordangliaeducation.com/careers' })).toBe(false);
      expect(isNordAngliaJob({ url: 'https://www.nordangliaeducation.com/london/careers' })).toBe(false);
    });

    it('rejects an explicit Nord Anglia identity on a foreign marketing path', () => {
      expect(isNordAngliaJob({
        companyKey: 'nord-anglia',
        url: 'https://www.nordangliaeducation.com/london/careers',
      })).toBe(false);
    });

    it('matches by URL domain (jobs2web ATS host)', () => {
      expect(isNordAngliaJob({ url: 'https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/' })).toBe(true);
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
      expect(isTrustedDomain('https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/')).toBe(true);
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
      'https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/?feedId=null&utm_source=J2WRSS&utm_medium=rss&utm_campaign=J2W_RSS',
    )).toBe('https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/');
    expect(canonicalizeNordAngliaJobUrl('https://example.com/job/Geneva-Teacher/1/?utm_source=rss')).toBe('');
  });

  it('parses and deduplicates Swiss SuccessFactors search results across locations', () => {
    const html = `
      <a class="job-link" href="/job/Aubonne-PE-teacher/1428165033/">
        <span>PE teacher</span>
      </a>
      <a class="job-link mobile" href="https://careers.nordanglia.com/job/Aubonne-PE-teacher/1428165033/?source=mobile">
        PE teacher
      </a>
      <a class="job-link" href="/job/Geneva-Boarding-Activity-Leader/1432993533/">Geneva activity leader</a>
      <a class="job-link" href="/job/Pully-IB-Teachers/1142314801/">Pully IB teachers</a>
      <a class="job-link" href="/job/Villars-sur-Ollon-Boarding-Assistant/1436026633/">Villars assistant</a>
      <a class="job-link" href="/job/Paris-Teacher/1428165034/">Paris teacher</a>
    `;

    expect(parseNordAngliaSearchResults(html)).toEqual([
      {
        title: 'PE teacher',
        link: 'https://careers.nordanglia.com/job/Aubonne-PE-teacher/1428165033/',
        jobReqId: '1428165033',
        sourceFormat: 'html',
      },
      {
        title: 'Geneva activity leader',
        link: 'https://careers.nordanglia.com/job/Geneva-Boarding-Activity-Leader/1432993533/',
        jobReqId: '1432993533',
        sourceFormat: 'html',
      },
      {
        title: 'Pully IB teachers',
        link: 'https://careers.nordanglia.com/job/Pully-IB-Teachers/1142314801/',
        jobReqId: '1142314801',
        sourceFormat: 'html',
      },
      {
        title: 'Villars assistant',
        link: 'https://careers.nordanglia.com/job/Villars-sur-Ollon-Boarding-Assistant/1436026633/',
        jobReqId: '1436026633',
        sourceFormat: 'html',
      },
    ]);
  });

  it('falls back from a retired RSS endpoint to real SuccessFactors detail content across Swiss locations', async () => {
    const description = Array.from({ length: 60 }, (_, index) => `detail-word-${index}`).join(' ');
    const searchHtml = `
      <a href="/job/Aubonne-PE-teacher/1428165033/">PE teacher</a>
      <a href="/job/Geneva-Boarding-Activity-Leader/1432993533/">Geneva activity leader</a>
      <a href="/job/Paris-Teacher/1428165034/">Paris teacher</a>
    `;
    const aubonneDetailHtml = `
      <html lang="en">
        <span data-careersite-propertyid="title">PE teacher</span>
        <div data-careersite-propertyid="description"><p>${description}</p></div>
        <meta itemprop="datePosted" content="2026-09-18">
        <a href="/talentcommunity/apply/1428165033/?locale=en_GB">Apply</a>
      </html>
    `;
    const genevaDetailHtml = `
      <html lang="en">
        <span data-careersite-propertyid="title">Geneva activity leader</span>
        <div data-careersite-propertyid="description"><p>${description}</p></div>
        <meta itemprop="datePosted" content="2026-09-17">
        <a href="/talentcommunity/apply/1432993533/?locale=en_GB">Apply</a>
      </html>
    `;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('RSS unavailable', { status: 403 }))
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(aubonneDetailHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(genevaDetailHtml, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllNordAngliaJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'PE teacher',
        canton: 'VD',
        jobReqId: '1428165033',
        postedDate: '2026-09-18',
        source: 'Nord Anglia Education Switzerland Dedicated Parser (SuccessFactors HTML fallback)',
        applyUrl: 'https://careers.nordanglia.com/talentcommunity/apply/1428165033/?locale=en_GB',
        url: 'https://careers.nordanglia.com/job/Aubonne-PE-teacher/1428165033/',
      }),
      expect.objectContaining({
        title: 'Geneva activity leader',
        canton: 'GE',
        jobReqId: '1432993533',
        postedDate: '2026-09-17',
        applyUrl: 'https://careers.nordanglia.com/talentcommunity/apply/1432993533/?locale=en_GB',
        url: 'https://careers.nordanglia.com/job/Geneva-Boarding-Activity-Leader/1432993533/',
      }),
    ]));
    expect(jobs[0].description.split(/\s+/)).toHaveLength(60);
    expect(fetchMock.mock.calls[1][0]).toContain('locationsearch=Switzerland');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('tries the HTML fallback after a connection-level RSS failure', async () => {
    const previousRetries = process.env.JOBS_CRAWLER_RETRIES;
    const previousBaseMs = process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    process.env.JOBS_CRAWLER_RETRIES = '0';
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    const description = Array.from({ length: 60 }, (_, index) => `detail-word-${index}`).join(' ');
    const detailHtml = `
      <html lang="en">
        <span data-careersite-propertyid="title">PE teacher</span>
        <div data-careersite-propertyid="description"><p>${description}</p></div>
      </html>
    `;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('<a href="/job/Aubonne-PE-teacher/1428165033/">PE teacher</a>', { status: 200 }))
      .mockResolvedValueOnce(new Response(detailHtml, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const [job] = await fetchAllNordAngliaJobs();
      expect(job.jobReqId).toBe('1428165033');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      if (previousRetries === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
      else process.env.JOBS_CRAWLER_RETRIES = previousRetries;
      if (previousBaseMs === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      else process.env.JOBS_CRAWLER_RETRY_BASE_MS = previousBaseMs;
    }
  });

  it('keeps the crawler soft when both vendor endpoints are unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('RSS unavailable', { status: 403 }))
      .mockResolvedValueOnce(new Response('Search unavailable', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
    expect(error).toBeInstanceOf(FeedEndpointUnavailableError);
    expect(error).toMatchObject({ status: 403, feedEndpointUnavailable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the HTML fallback detail page has no substantive description', async () => {
    const searchHtml = '<a href="/job/Aubonne-PE-teacher/1428165033/">PE teacher</a>';
    const detailHtml = `
      <span data-careersite-propertyid="title">PE teacher</span>
      <div data-careersite-propertyid="description"><p>Short</p></div>
    `;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('RSS unavailable', { status: 403 }))
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(detailHtml, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 1\/1 items/,
    );
  });

  it('preserves the indexed slice when an HTML detail endpoint returns HTTP 403', async () => {
    const searchHtml = '<a href="/job/Aubonne-PE-teacher/1428165033/">PE teacher</a>';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('RSS unavailable', { status: 403 }))
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response('Detail unavailable', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
    expect(error).toBeInstanceOf(FeedEndpointUnavailableError);
    expect(error).toMatchObject({ status: 403, feedEndpointUnavailable: true });
    expect(error.message).toContain('detail endpoint unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the indexed slice when an HTML detail endpoint has a transport failure', async () => {
    const previousRetries = process.env.JOBS_CRAWLER_RETRIES;
    const previousBaseMs = process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    process.env.JOBS_CRAWLER_RETRIES = '0';
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    const searchHtml = '<a href="/job/Aubonne-PE-teacher/1428165033/">PE teacher</a>';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
      expect(error).toBeInstanceOf(FeedEndpointUnavailableError);
      expect(error).toMatchObject({ feedEndpointUnavailable: true });
      expect(error.message).toContain('detail endpoint unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      if (previousRetries === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
      else process.env.JOBS_CRAWLER_RETRIES = previousRetries;
      if (previousBaseMs === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      else process.env.JOBS_CRAWLER_RETRY_BASE_MS = previousBaseMs;
    }
  });

  it('rejects a bare homonymous locality without independent canton evidence', async () => {
    const bareBuchs = validRssItem({
      title: '<title><![CDATA[Teacher of Biology (Buchs, CH)]]></title>',
      link: '<link>https://careers.nordanglia.com/job/Buchs-Teacher-of-Biology/1399902133/</link>',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bareBuchs, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 1\/1 items/,
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('[nord-anglia-ambiguous-location-drop]');
    warnSpy.mockRestore();
  });

  it('accepts a homonymous route only when the route supplies a canton marker', async () => {
    const scopedBuchs = validRssItem({
      title: '<title><![CDATA[Teacher of Biology (Buchs, CH)]]></title>',
      link: '<link>https://careers.nordanglia.com/job/Buchs-SG-Teacher-of-Biology/1399902133/</link>',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(scopedBuchs, { status: 200 })));

    const [job] = await fetchAllNordAngliaJobs();
    expect(job).toMatchObject({ location: 'Buchs', canton: 'SG' });
  });

  it('reports a retired ATS host as an unavailable endpoint, not as malformed XML (#7853)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const html = new Response(
        '<!DOCTYPE html><html><head><script>a&&b</script></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
      Object.defineProperty(html, 'url', {
        value: 'https://www.nordangliaeducation.com/careers',
      });
      return html;
    }));

    const error = await fetchAllNordAngliaJobs().catch((err: any) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(
      /\[nord-anglia\] feed endpoint redirected off careers\.nordanglia\.com/,
    );
    expect(error.feedEndpointUnavailable).toBe(true);
  });

  it('isolates a hard failure to the Nord Anglia launch/result pair and its slice', () => {
    const workflowDir = join(ROOT, '.github', 'workflows');
    const groupFiles = readdirSync(workflowDir).filter((file) => /^crawler-group-\d+\.yml$/.test(file));
    const located = groupFiles.flatMap((file) => {
      const workflow = YAML.parse(readFileSync(join(workflowDir, file), 'utf8'));
      return Object.values(workflow?.jobs || {}).flatMap((job: any) => {
        const steps = Array.isArray(job?.steps) ? job.steps : [];
        const index = steps.findIndex((step: any) => step?.id === 'crawler-launch-nord-anglia');
        const resultIndex = steps.findIndex((step: any) => step?.id === 'crawler-nord-anglia');
        return index < 0 || resultIndex < 0 ? [] : [{ file, steps, index, resultIndex, step: steps[index], result: steps[resultIndex] }];
      });
    });

    expect(located).toHaveLength(1);
    const [{ steps, index, resultIndex, step, result }] = located;
    expect(step.env.JOBS_SLICE_FILE).toBe('data/jobs/by-crawler/nord-anglia.json');
    expect(step.run).toContain('node scripts/update-nord-anglia-jobs.mjs');
    expect(step.run).toMatch(/crawler_exit=\$\?/);
    expect(step.run).toMatch(/if \[ "\$crawler_exit" -eq 0 \]; then\s+\(node scripts\/cleanup-jobs\.mjs\)/);
    expect(step.run).toMatch(
      /if \[ "\$crawler_exit" -eq 0 \]; then\s+CRAWLER_GROUP_DEFER_COMMIT=1\s+flock .*git-commit-data\.sh/,
    );
    expect(result).toMatchObject({ if: 'always()' });
    expect(result.run).toContain('status_file=');
    expect(result.run).toContain('exit "$status"');
    expect(resultIndex).toBeGreaterThan(index);
    expect(steps.slice(0, index).some((candidate: any) => candidate?.id?.startsWith('crawler-launch-'))).toBe(true);
    expect(steps.slice(index + 1, resultIndex).some((candidate: any) => candidate?.id?.startsWith('crawler-launch-'))).toBe(true);
  });

  it('logs a canonical URL drop without exposing its query and fails on feed-wide URL drift', async () => {
    const driftedFeed = validRssItem({
      link: '<link>https://example.com/jobs/1399902133/?session=secret-token</link>',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 1\/1 items/,
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

  it('accepts route-only Swiss evidence when the title suffix is absent', async () => {
    const driftedFeed = validRssItem({
      title: '<title><![CDATA[Teacher of Biology - Geneva]]></title>',
      link: '<link>https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/?session=secret-token</link>',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    const [job] = await fetchAllNordAngliaJobs();
    expect(job.location).toBe('Geneva');
    expect(job.canton).toBe('GE');
    expect(job.streetAddress).toBeTruthy();
    expect(job.postalCode).toMatch(/^\d{4}$/);
  });

  it('resolves composed Swiss localities from route prefixes', async () => {
    const routeOnlyFeed = validRssItem({
      title: '<title><![CDATA[Teacher of Biology - St. Moritz]]></title>',
      link: '<link>https://careers.nordanglia.com/job/St-Moritz-Teacher-of-Biology/1399902134/</link>',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(routeOnlyFeed, { status: 200 })));

    const [job] = await fetchAllNordAngliaJobs();
    expect(job.location).toBe('St Moritz');
    expect(job.canton).toBe('GR');
    expect(job.streetAddress).toBeTruthy();
    expect(job.postalCode).toMatch(/^\d{4}$/);
  });

  it('keeps Swiss locations returned by the national full-text search', async () => {
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

    await expect(fetchAllNordAngliaJobs()).resolves.toHaveLength(3);
  });

  it('fails on feed-wide Swiss location conflicts instead of silently returning an empty slice', async () => {
    const splitDriftFeed = rssFeed(
      rssItemXml({
        title: '<title><![CDATA[Teacher of Biology (Geneva, CH)]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Paris-Teacher-of-Biology/1399902133/</link>',
      }),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics (Geneva, CH)]]></title>',
        link: '<link>https://example.com/new-job-template/1400000000/</link>',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(splitDriftFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 2\/2 items/,
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('[nord-anglia-location-conflict-drop]');
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('[nord-anglia-canonical-url-drop]');
    warnSpy.mockRestore();
  });

  it('fails closed when a non-empty feed has zero Swiss location signals', async () => {
    const driftedFeed = rssFeed(
      rssItemXml({
        title: '<title><![CDATA[Teacher of Biology]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Teacher-of-Biology/1399902133/</link>',
      }),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Teacher-of-Mathematics/1399902134/</link>',
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /no Swiss title or route signals found in 2 non-generic RSS items/,
    );
  });

  it('rejects a same-canton title and route locality conflict', async () => {
    const conflictingFeed = rssFeed(
      rssItemXml({
        title: '<title><![CDATA[Teacher of Biology (Zürich, CH)]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Winterthur-Teacher-of-Biology/1399902133/</link>',
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(conflictingFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 1\/1 items/,
    );
  });

  it('fails closed when unrecognized location drift exceeds the feed drop budget', async () => {
    const driftedFeed = rssFeed(
      rssItemXml(),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Teacher-of-Mathematics/1399902134/</link>',
      }),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Physics]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Teacher-of-Physics/1399902135/</link>',
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(
      /\[nord-anglia-drop-ratio\] Swiss location guard: dropped 2\/3 items/,
    );
  });

  it('keeps a valid job when location drops are exactly 50% of a small feed', async () => {
    const mixedFeed = rssFeed(
      rssItemXml(),
      rssItemXml({
        title: '<title><![CDATA[Teacher of Mathematics (Geneva, CH)]]></title>',
        link: '<link>https://careers.nordanglia.com/job/Paris-Teacher-of-Mathematics/1400000000/</link>',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mixedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).resolves.toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[nord-anglia-location-conflict-drop]'),
    );
    warnSpy.mockRestore();
  });

  it('derives new identity from the canonical URL, not rotating jobs2web query tokens', async () => {
    const base = 'https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/';
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
        title: 'Teacher of Biology (Geneva, CH)',
        link: 'https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/',
        description: '<p>Teach biology in Geneva.</p>',
        pubDate: 'Mon, 01 Apr 2026 12:00:00 +0000',
      }]);
    });

    it('repairs vendor bare ampersands without changing CDATA content', () => {
      const feed = validRssItem({
        link: '<link>https://careers.nordanglia.com/job/Geneva-Teacher/1/?feed=one&source=two</link>',
        description: '<description><![CDATA[Research & Development in Geneva.]]></description>',
      });

      expect(parseNordAngliaRss(feed)).toEqual([{
        title: 'Teacher of Biology (Geneva, CH)',
        link: 'https://careers.nordanglia.com/job/Geneva-Teacher/1/?feed=one&source=two',
        description: 'Research & Development in Geneva.',
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
      ['title', { title: '<title><strong>Teacher of Biology (Geneva, CH)</strong></title>' }],
      ['link', { link: '<link>https://careers.nordanglia.com/job/Geneva-One/1/</link><link>https://careers.nordanglia.com/job/Geneva-Two/2/</link>' }],
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
        link: '<link>https://careers.nordanglia.com/job/Geneva-One/1/</link><link>https://careers.nordanglia.com/job/Geneva-Two/2/</link>',
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

    it('classifies the live ATS redirect before handing the body to XML parsing', async () => {
      const response = new Response('<!DOCTYPE html><html><body>careers unavailable</body></html>', {
        status: 200,
      });
      Object.defineProperty(response, 'url', {
        value: 'https://www.nordangliaeducation.com/careers',
      });
      vi.stubGlobal('fetch', vi.fn(async () => response));

      const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
      expect(error).toBeInstanceOf(FeedEndpointUnavailableError);
      expect(error).toMatchObject({ feedEndpointUnavailable: true });
    });

    it('classifies an off-host non-OK redirect before the HTTP error path', async () => {
      const response = new Response('vendor unavailable', { status: 403 });
      Object.defineProperty(response, 'url', {
        value: 'https://www.nordangliaeducation.com/careers',
      });
      vi.stubGlobal('fetch', vi.fn(async () => response));

      const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
      expect(error).toBeInstanceOf(FeedEndpointUnavailableError);
      expect(error).toMatchObject({ feedEndpointUnavailable: true });
    });

    it('propagates the exhausted retry marker when the ATS keeps returning 503', async () => {
      const previousRetries = process.env.JOBS_CRAWLER_RETRIES;
      const previousBaseMs = process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      process.env.JOBS_CRAWLER_RETRIES = '1';
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      const fetchMock = vi.fn(() => {
        const response = new Response('vendor unavailable', { status: 503 });
        Object.defineProperty(response, 'url', {
          value: 'https://careers.nordanglia.com/services/rss/job/?locale=en_GB&keywords=(Switzerland)',
        });
        return response;
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        const error = await fetchAllNordAngliaJobs().catch((caught) => caught);
        expect(error).toMatchObject({ status: 503, retryBudgetExhausted: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        if (previousRetries === undefined) delete process.env.JOBS_CRAWLER_RETRIES;
        else process.env.JOBS_CRAWLER_RETRIES = previousRetries;
        if (previousBaseMs === undefined) delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
        else process.env.JOBS_CRAWLER_RETRY_BASE_MS = previousBaseMs;
      }
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Teacher of Biology (Geneva)');
      expect(slug).toBe('teacher-of-biology-geneva');
    });

    it('strips diacritics', () => {
      expect(slugify('Coordinateur des transports scolaires & concierge')).toBe('coordinateur-des-transports-scolaires-concierge');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Teacher of Mathematics nord-anglia geneva')).toBe('teacher-of-mathematics-nord-anglia-geneva');
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
      slug: 'teacher-of-biology-nord-anglia-geneva',
      slugByLocale: { en: 'teacher-of-biology-nord-anglia-geneva' },
      company: 'Nord Anglia Education Switzerland',
      companyKey: 'nord-anglia',
      companyDomain: 'nordangliaeducation.com',
      title: 'Teacher of Biology',
      titleByLocale: { en: 'Teacher of Biology' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Geneva',
      canton: 'GE',
      url: 'https://careers.nordanglia.com/job/Geneva-Teacher-of-Biology/1399902133/',
      source: 'Nord Anglia Education Switzerland Dedicated Parser (jobs2web RSS)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Geneva',
      addressRegion: 'GE',
      streetAddress: '',
      postalCode: '',
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

    it('derives the structured-data locality from the Swiss posting', () => {
      expect(validJob.canton).toBe('GE');
      expect(validJob.addressLocality).toBe('Geneva');
      expect(validJob.addressRegion).toBe('GE');
    });
  });
});
