import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPoliteFetchStateForTests,
  politeFetch,
} from '../scripts/lib/prospector/polite-fetch.mjs';
import { createSpecUrlPolicy } from '../scripts/lib/prospector/public-fetch-policy.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';

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
});
