import { beforeEach, describe, expect, it, vi } from 'vitest';

const { launchChromium } = vi.hoisted(() => ({
  launchChromium: vi.fn(),
}));
vi.mock('../scripts/lib/ensure-chromium.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, launchChromium };
});

import {
  clearPoliteFetchStateForTests,
  politeFetch,
} from '../scripts/lib/prospector/polite-fetch.mjs';
import { createSpecUrlPolicy } from '../scripts/lib/prospector/public-fetch-policy.mjs';
import {
  fetchHtmlViaBrowser,
  fetchRuntimePage,
  runSpecInProduction,
} from '../scripts/lib/prospector/spec-crawler.mjs';
import { isConnectionLevelFetchError } from '../scripts/lib/transient-fetch.mjs';

function response(url: string, status: number, location: string | null = null, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name: string) => name.toLowerCase() === 'location' ? location : null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('prospector public-only polite transport', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('accepts a usable DOM after a non-2xx browser navigation', async () => {
    const html = '<html><body><a href="/jobs/chef-de-partie">Chef de partie</a></body></html>';
    const page = {
      goto: vi.fn(async () => ({ ok: () => false, status: () => 403 })),
      waitForTimeout: vi.fn(async () => {}),
      title: vi.fn(async () => 'Hotelcareer jobs'),
      locator: vi.fn(() => ({ textContent: vi.fn(async () => 'Chef de partie Klosters') })),
      content: vi.fn(async () => html),
    };
    const browser = {
      newContext: vi.fn(async () => ({ newPage: vi.fn(async () => page) })),
      close: vi.fn(async () => {}),
    };
    launchChromium.mockResolvedValue(browser);

    await expect(fetchHtmlViaBrowser('https://hotelcareer.example/jobs', { attempts: 1 }))
      .resolves.toBe(html);
    expect(page.content).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it.each([
    'file:///etc/passwd',
    'http://127.0.0.1/jobs',
    'http://[::ffff:7f00:1]/jobs',
    'http://169.254.169.254/latest/meta-data',
    'http://[64:ff9b::7f00:1]/jobs',
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data',
    'http://[64:ff9b::a00:1]/jobs',
    'http://[64:ff9b::c000:201]/jobs',
  ])('rejects %s before robots or the target fetch', async (url) => {
    const fetchImpl = vi.fn();
    const sleepImpl = vi.fn(async () => {});
    const result = await politeFetch(url, { fetchImpl, retries: 3, sleepImpl });
    expect(result).toMatchObject({ ok: false, status: 0, policyBlocked: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('validates a robots redirect and never follows it to metadata', async () => {
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      fetched.push(url);
      return response(url, 302, 'http://169.254.169.254/latest/meta-data');
    });
    const result = await politeFetch('https://jobs.example.test/openings', { fetchImpl });
    expect(result).toMatchObject({ ok: false, policyBlocked: true });
    expect(fetched).toEqual(['https://jobs.example.test/robots.txt']);
  });

  it('validates every main-response redirect before another fetch', async () => {
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      fetched.push(url);
      return response(url, 302, 'https://evil.example.test/jobs');
    });
    const result = await politeFetch('https://jobs.example.test/openings', {
      fetchImpl,
      ignoreRobots: true,
    });
    expect(result).toMatchObject({ ok: false, policyBlocked: true });
    expect(fetched).toEqual(['https://jobs.example.test/openings']);
  });

  it('stops after one socket-time DNS rejection with no retry backoff', async () => {
    const lookupImpl = vi.fn(async () => [{ address: '10.0.0.7', family: 4 }]);
    const sleepImpl = vi.fn(async () => {});
    const result = await politeFetch('http://jobs.rebinding.invalid/openings', {
      lookupImpl,
      sleepImpl,
      retries: 4,
      retryBaseMs: 0,
    });
    expect(result).toMatchObject({ ok: false, status: 0, policyBlocked: true });
    // robots.txt is the first network operation. Its pinned lookup rejects the
    // private answer, so neither the target request nor a retry is attempted.
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('keeps four total default attempts and re-applies polite transport on a transient 503', async () => {
    const url = 'https://jobs.example.test/openings';
    const requested: string[] = [];
    let mainAttempts = 0;
    const fetchImpl = vi.fn(async (requestedUrl: string) => {
      requested.push(requestedUrl);
      if (requestedUrl.endsWith('/robots.txt')) {
        return response(requestedUrl, 200, null, 'User-agent: *\nAllow: /');
      }
      mainAttempts++;
      return mainAttempts < 4
        ? response(requestedUrl, 503)
        : response(requestedUrl, 200, null, '<h1>Recovered</h1>');
    });
    const result = await politeFetch(url, { fetchImpl, sleepImpl: async () => {} });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(mainAttempts).toBe(4);
    expect(requested).toEqual(['https://jobs.example.test/robots.txt', url, url, url, url]);
  });

  it.each([408, 425, 429])('retries transient HTTP %s under the shared classifier', async (status) => {
    const url = `https://jobs-${status}.example.test/openings`;
    let mainAttempts = 0;
    const fetchImpl = vi.fn(async (requestedUrl: string) => {
      if (requestedUrl.endsWith('/robots.txt')) return response(requestedUrl, 200, null, 'User-agent: *\nAllow: /');
      mainAttempts++;
      return mainAttempts === 1
        ? response(requestedUrl, status)
        : response(requestedUrl, 200, null, '<h1>Recovered</h1>');
    });
    const result = await politeFetch(url, { fetchImpl, retries: 1, sleepImpl: async () => {} });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(mainAttempts).toBe(2);
  });

  it('does not retry a persistent non-transient 404', async () => {
    const url = 'https://jobs-404.example.test/openings';
    let mainAttempts = 0;
    const fetchImpl = vi.fn(async (requestedUrl: string) => {
      if (requestedUrl.endsWith('/robots.txt')) return response(requestedUrl, 200, null, 'User-agent: *\nAllow: /');
      mainAttempts++;
      return response(requestedUrl, 404);
    });
    const result = await politeFetch(url, { fetchImpl, sleepImpl: async () => {} });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mainAttempts).toBe(1);
  });

  it('checks robots and throttles again on an allowlisted cross-origin redirect', async () => {
    const seed = 'https://employer.example/jobs';
    const target = 'https://ats.example/openings';
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      if (url === 'https://employer.example/robots.txt') return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 302, target);
      if (url === 'https://ats.example/robots.txt') return response(url, 200, null, 'User-agent: *\nAllow: /openings');
      return response(url, 200, null, '<h1>Jobs</h1>');
    });
    const policy = createSpecUrlPolicy({
      seedUrls: [seed],
      allowedDetailOrigins: ['https://ats.example'],
    }, { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
    try {
      const result = await politeFetch(seed, {
        fetchImpl,
        urlPolicy: policy,
        dispatcher: policy.dispatcher,
        sleepImpl: async () => {},
      });
      expect(result).toMatchObject({ ok: true, url: target });
      expect(requested).toEqual([
        'https://employer.example/robots.txt',
        seed,
        'https://ats.example/robots.txt',
        target,
      ]);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('enforces robots in the production spec runtime before the seed', async () => {
    const seed = 'https://employer.example/jobs';
    const fetchImpl = vi.fn(async (url: string) => response(
      url,
      200,
      null,
      url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /jobs' : '<h1>must not fetch</h1>',
    ));
    await expect(runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
    })).rejects.toThrow(/robots\.txt/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://employer.example/robots.txt');
  });

  it('uses the effective redirected seed URL as the base for relative vacancy links', async () => {
    const seed = 'https://employer.example/start';
    const effective = 'https://employer.example/careers/index/';
    const detail = 'https://employer.example/careers/detail/1';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 302, effective);
      if (url === effective) return response('', 200, null, '<a href="../detail/1">Platform Engineer</a>');
      if (url === detail) return response(url, 200, null,
        '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>' +
        '<article class="vacancy-description">Build reliable systems for our engineering organisation, ' +
        'coordinate production releases, improve observability and support colleagues across the platform team.</article>');
      throw new Error(`unexpected URL ${url}`);
    });
    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
    });
    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(fetchImpl).toHaveBeenCalledWith(detail, expect.objectContaining({ redirect: 'manual' }));
  });

  it('filters a multi-employer listing feed before detail enrichment', async () => {
    const seed = 'https://romantik.example/list/';
    const wanted = 'https://romantik.example/list/146';
    const unrelated = 'https://romantik.example/list/19310';
    const listing = `<a href="/list/146">Housekeeping-Mitarbeiter/in im Romantik Hotel Schweizerhof Flims</a>`
      + `<a href="/list/19310">Chef de Rang im Romantik Hotel Schweizerhof Grindelwald</a>`;
    const detailHtml = '<h1>Housekeeping-Mitarbeiter/in</h1><div class="job-location">Flims</div>'
      + '<article class="vacancy-description">'
      + 'Unterstützen Sie unser Housekeeping-Team im Romantik Hotel Schweizerhof Flims. '
      + 'Wir bieten eine verantwortungsvolle Tätigkeit, faire Arbeitszeiten und ein familiäres Umfeld.'
      + '</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, listing);
      if (url === wanted) return response(url, 200, null, detailHtml);
      if (url === unrelated) throw new Error('unrelated listing must be filtered before detail fetch');
      throw new Error(`unexpected URL ${url}`);
    });

    const rows = await runSpecInProduction({
      companyKey: 'schweizerhof-flims', companyName: 'Schweizerhof',
      companyHost: 'romantik.example', mode: 'template', seedUrls: [seed],
      detailTemplate: '/list/*', listingCandidateText: 'Schweizerhof Flims',
      detailEnrichment: true,
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Housekeeping-Mitarbeiter/in', url: wanted, location: 'Flims', canton: 'GR',
    })]);
    expect(fetchImpl).not.toHaveBeenCalledWith(unrelated, expect.anything());
  });

  it('rescues a WAF 403 through Jina while keeping the prospector URL policy in front', async () => {
    const seed = 'https://employer.example/jobs';
    const detail = 'https://employer.example/careers/detail/1';
    const listing = `<a href="/careers/detail/1">Platform Engineer</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>'
      + '<article class="vacancy-description">Build reliable systems for our engineering organisation, '
      + 'coordinate production releases, improve observability, support colleagues across the platform team, '
      + 'and document resilient operational practices for every service owner.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 403, null, 'Forbidden by edge policy');
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected direct URL ${url}`);
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 200, null, listing));

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(jinaFetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('https://r.jina.ai/'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Return-Format': 'html' }) }),
    );
  });

  it('uses an opt-in browser rescue after the direct page and Jina both hit the WAF', async () => {
    const seed = 'https://hotelcareer.example/jobs/vereina';
    const detail = 'https://hotelcareer.example/jobs/vereina/chef-de-partie-123';
    const listing = `<a href="/jobs/vereina/chef-de-partie-123">Chef de partie</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Chef de partie</h1><div class="job-location">Klosters</div>'
      + '<article class="vacancy-description">Prepare and coordinate kitchen service for the hotel team, '
      + 'maintain food quality and hygiene standards, and support the daily operation with colleagues across '
      + 'the restaurant and guest service departments in Klosters.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 403, null, 'Challenge Validation');
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected direct URL ${url}`);
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 403, null, 'Challenge Validation'));
    const browserFetchImpl = vi.fn(async () => listing);

    const rows = await runSpecInProduction({
      companyKey: 'vereinaklosters', companyName: 'Vereina', companyHost: 'hotelcareer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/jobs/vereina/*', detailEnrichment: true,
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      browserFetchImpl,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Chef de partie', url: detail, location: 'Klosters', canton: 'GR',
    })]);
    expect(browserFetchImpl).toHaveBeenCalledWith(seed, expect.objectContaining({ timeoutMs: undefined }));
    expect(jinaFetchImpl).toHaveBeenCalledOnce();
  });

  it('rescues an Akamai challenge served as HTTP 200 instead of treating it as an empty listing', async () => {
    const seed = 'https://employer.example/jobs';
    const detail = 'https://employer.example/careers/detail/1';
    const challenge = '<html><head><title>Challenge Validation</title></head>'
      + '<body><meta name="sec-cpt-if" content="provider=crypto">'
      + `${' blocked'.repeat(30)}</body></html>`;
    const listing = `<a href="/careers/detail/1">Platform Engineer</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>'
      + '<article class="vacancy-description">Build reliable systems for our engineering organisation, '
      + 'coordinate production releases, improve observability, support colleagues across the platform team, '
      + 'and document resilient operational practices for every service owner.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, challenge);
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected direct URL ${url}`);
    });
    let jinaCalls = 0;
    const jinaFetchImpl = vi.fn(async (url: string) => response(
      url,
      200,
      null,
      jinaCalls++ === 0 ? challenge : listing,
    ));

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      jinaRetries: 1,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(jinaFetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rotates Jina again when a marked challenge is followed by an empty 200 proxy page', async () => {
    const seed = 'https://employer.example/jobs';
    const detail = 'https://employer.example/careers/detail/1';
    const challenge = '<html><head><title>Challenge Validation</title></head>'
      + '<body><meta name="sec-cpt-if" content="provider=crypto">'
      + `${' blocked'.repeat(30)}</body></html>`;
    const emptyProxyPage = `<html><body>${'No positions available right now. '.repeat(20)}</body></html>`;
    const listing = `<a href="/careers/detail/1">Platform Engineer</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>'
      + '<article class="vacancy-description">Build reliable systems for our engineering organisation, '
      + 'coordinate production releases, improve observability, support colleagues across the platform team, '
      + 'and document resilient operational practices for every service owner.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, challenge);
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected direct URL ${url}`);
    });
    let jinaCalls = 0;
    const jinaFetchImpl = vi.fn(async (url: string) => response(
      url,
      200,
      null,
      jinaCalls++ === 0 ? emptyProxyPage : listing,
    ));

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
      rescueOnEmptyListing: true,
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(jinaFetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rescues a spec-scoped unmarked HTTP 200 interstitial after empty extraction', async () => {
    const seed = 'https://employer.example/jobs';
    const detail = 'https://employer.example/careers/detail/1';
    const interstitial = '<html><head><title>Access Denied</title></head>'
      + '<body><p>Request could not be completed.</p></body></html>';
    const listing = `<a href="/careers/detail/1">Platform Engineer</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>'
      + '<article class="vacancy-description">Build reliable systems for our engineering organisation, '
      + 'coordinate production releases, improve observability, support colleagues across the platform team, '
      + 'and document resilient operational practices for every service owner.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, interstitial);
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected direct URL ${url}`);
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 200, null, listing));

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
      rescueOnEmptyListing: true,
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(jinaFetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps an explicit zero outcome when every source rescue still yields no accepted detail link', async () => {
    const seed = 'https://hotelcareer.example/jobs/vereina';
    const interstitial = '<html><head><title>Access Denied</title></head>'
      + '<body><p>Request could not be completed.</p></body></html>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, interstitial);
      throw new Error(`unexpected direct URL ${url}`);
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 200, null, interstitial));
    const browserFetchImpl = vi.fn(async () => interstitial);

    const rows = await runSpecInProduction({
      companyKey: 'vereinaklosters', companyName: 'Vereina', companyHost: 'hotelcareer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/jobs/vereina/*',
      rescueOnEmptyListing: true, emptyListingOutcome: 'anti_bot_block',
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      browserFetchImpl,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([]);
    expect(rows).toHaveProperty('fetchOutcome', 'anti_bot_block');
    expect(rows).toHaveProperty('discoveredCount', 0);
    expect(rows).toHaveProperty('fetchDetail', expect.stringContaining('Access Denied'));
    expect(browserFetchImpl).toHaveBeenCalledOnce();
  });

  it('does not invent a fetch outcome for an unconfigured legitimate empty listing', async () => {
    const seed = 'https://employer.example/jobs';
    const empty = '<html><head><title>Open positions</title></head><body>No positions.</body></html>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) return response(url, 200, null, empty);
      throw new Error(`unexpected direct URL ${url}`);
    });

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
    });

    expect(rows).toEqual([]);
    expect(rows).not.toHaveProperty('fetchOutcome');
  });

  it('rescues a connection-level seed failure through Jina instead of returning zero listings', async () => {
    const seed = 'https://employer.example/jobs';
    const detail = 'https://employer.example/careers/detail/1';
    const listing = `<a href="/careers/detail/1">Platform Engineer</a>${' listing'.repeat(60)}`;
    const detailHtml = '<h1>Platform Engineer</h1><div class="job-location">Zürich</div>'
      + '<article class="vacancy-description">Build reliable systems for our engineering organisation, '
      + 'coordinate production releases, improve observability, support colleagues across the platform team, '
      + 'and document resilient operational practices for every service owner.</article>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      if (url === seed) throw new TypeError('fetch failed');
      if (url === detail) return response(url, 200, null, detailHtml);
      throw new Error(`unexpected URL ${url}`);
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 200, null, listing));

    const rows = await runSpecInProduction({
      companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
      mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
    } as any, {
      fetchImpl,
      jinaFetchImpl,
      retries: 0,
      jinaRetries: 0,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      jinaSleepImpl: async () => {},
    });

    expect(rows).toEqual([expect.objectContaining({
      title: 'Platform Engineer', url: detail, location: 'Zürich', canton: 'ZH',
    })]);
    expect(jinaFetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps an exhausted connection rescue retryable instead of marking it anti-bot', async () => {
    const seed = 'https://employer.example/jobs';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, null, 'User-agent: *\nAllow: /');
      const error = Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' });
      throw error;
    });
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 502));
    const policy = createSpecUrlPolicy({ seedUrls: [seed] }, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    let error: any;
    try {
      await fetchRuntimePage(seed, policy, {
        fetchImpl,
        jinaFetchImpl,
        retries: 0,
        jinaRetries: 0,
        sleepImpl: async () => {},
        jinaSleepImpl: async () => {},
      });
    } catch (caught) {
      error = caught;
    } finally {
      await policy.dispatcher.close();
    }

    expect(error).toMatchObject({ retryable: true });
    expect(error).not.toHaveProperty('status');
    expect(isConnectionLevelFetchError(error)).toBe(true);
    expect(error).not.toHaveProperty('antiBotExhausted');
    expect(jinaFetchImpl).toHaveBeenCalledOnce();
  });

  it('marks an exhausted WAF rescue as anti-bot so the prior slice can be preserved', async () => {
    const seed = 'https://employer.example/jobs';
    const fetchImpl = vi.fn(async (url: string) => response(
      url,
      url.endsWith('/robots.txt') ? 200 : 403,
      null,
      url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : 'Forbidden by edge policy',
    ));
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 502));

    let error: any;
    try {
      await runSpecInProduction({
        companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
        mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
      } as any, {
        fetchImpl,
        jinaFetchImpl,
        jinaRetries: 0,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        jinaSleepImpl: async () => {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 403, antiBotExhausted: true });
    expect(jinaFetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unrecognised 200 WAF challenge from Jina as an empty listing', async () => {
    const seed = 'https://employer.example/jobs';
    const fetchImpl = vi.fn(async (url: string) => response(
      url,
      url.endsWith('/robots.txt') ? 200 : 403,
      null,
      url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : 'Forbidden by edge policy',
    ));
    const challenge = '<html><body><script>var cf = "cf-browser-verification";</script>'
      + ' challenge'.repeat(80) + '</body></html>';
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 200, null, challenge));

    let error: any;
    try {
      await runSpecInProduction({
        companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
        mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
      } as any, {
        fetchImpl,
        jinaFetchImpl,
        jinaRetries: 0,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        jinaSleepImpl: async () => {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 403, antiBotExhausted: true });
    expect(jinaFetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks an exhausted HTTP 200 challenge as anti-bot instead of returning zero rows', async () => {
    const seed = 'https://employer.example/jobs';
    const challenge = '<html><head><title>Challenge Validation</title></head>'
      + '<body><meta name="sec-cpt-if" content="provider=crypto">'
      + `${' blocked'.repeat(30)}</body></html>`;
    const fetchImpl = vi.fn(async (url: string) => response(
      url,
      200,
      null,
      url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : challenge,
    ));
    const jinaFetchImpl = vi.fn(async (url: string) => response(url, 502));

    let error: any;
    try {
      await runSpecInProduction({
        companyKey: 'employer', companyName: 'Employer', companyHost: 'employer.example',
        mode: 'template', seedUrls: [seed], detailTemplate: '/careers/detail/*',
      } as any, {
        fetchImpl,
        jinaFetchImpl,
        jinaRetries: 0,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        jinaSleepImpl: async () => {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 200, antiBotExhausted: true });
    expect(jinaFetchImpl).toHaveBeenCalledOnce();
  });
});
