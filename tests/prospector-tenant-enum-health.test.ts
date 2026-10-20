import { describe, expect, it } from 'vitest';
import {
  enumerateTenants,
  enumerateViaCertSpotter,
  enumerateViaCommonCrawl,
} from '../scripts/lib/prospector/tenant-enum.mjs';

const response = (body: string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body,
  url: 'https://source.example/',
  host: 'source.example',
});

const platform = {
  domain: 'vendor.example',
  status: 'confirmed' as const,
  seenOn: [],
  markers: [],
  hostSamples: [],
  tenantShape: 'subdomain' as const,
  hostHits: {},
  pathHits: {},
  listingPaths: [],
  tenantCount: 0,
  discoveredAt: 'fixture',
};

describe('Prospector tenant enumeration source outcomes', () => {
  it('distinguishes a Common Crawl outage from an empty collection', async () => {
    const unavailable = await enumerateViaCommonCrawl('vendor.example', {
      collections: ['cc-one'],
      fetcher: async () => response('', 503),
    });
    const empty = await enumerateViaCertSpotter('vendor.example', {
      fetcher: async () => response('[]'),
    });

    expect(unavailable).toEqual({ hosts: [], outcome: 'unavailable', errorCode: 'http_503' });
    expect(empty).toEqual({ hosts: [], outcome: 'complete', errorCode: null });
  });

  it('reports partial Common Crawl coverage when only one collection fails', async () => {
    const result = await enumerateViaCommonCrawl('vendor.example', {
      collections: ['cc-good', 'cc-down'],
      fetcher: async (url) => url.includes('/cc-good-index?')
        ? response('{"url":"https://jobs.vendor.example/openings"}\n')
        : response('', 503),
    });

    expect(result).toEqual({
      hosts: ['jobs.vendor.example'],
      outcome: 'partial',
      errorCode: 'http_503',
    });
  });

  it('does not count an all-malformed Common Crawl collection as a source success', async () => {
    const result = await enumerateViaCommonCrawl('vendor.example', {
      collections: ['cc-malformed'],
      fetcher: async () => response('not-json'),
    });

    expect(result).toEqual({ hosts: [], outcome: 'malformed', errorCode: 'malformed_index_row' });
  });

  it('marks a Common Crawl response at the requested row cap as partial', async () => {
    const result = await enumerateViaCommonCrawl('vendor.example', {
      collections: ['cc-capped'],
      limit: 2,
      fetcher: async () => response([
        JSON.stringify({ url: 'https://alpha.vendor.example/jobs' }),
        JSON.stringify({ url: 'https://beta.vendor.example/jobs' }),
      ].join('\n')),
    });

    expect(result).toEqual({
      hosts: ['alpha.vendor.example', 'beta.vendor.example'],
      outcome: 'partial',
      errorCode: 'result_limit_reached',
    });
  });

  it('continues with CertSpotter after a Common Crawl outage and keeps the source results distinct', async () => {
    const result = await enumerateTenants(platform, {
      maxProbe: 0,
      fetcher: async (url) => {
        if (url.includes('commoncrawl.org/collinfo.json')) return response('[{"id":"cc-one"}]');
        if (url.includes('cc-one-index?')) return response('', 503);
        return response('[]');
      },
    });

    expect(result).toMatchObject({
      discovered: [],
      live: [],
      outcome: 'partial',
      sourceOutcomes: {
        commoncrawl: { outcome: 'unavailable', items: 0, errorCode: 'http_503' },
        certspotter: { outcome: 'complete', items: 0, errorCode: null },
      },
    });
  });

  it('reports transient tenant probe failures as partial expansion coverage', async () => {
    const result = await enumerateTenants({
      ...platform,
      hostSamples: ['tenant.vendor.example'],
    }, {
      maxProbe: 5,
      useCommonCrawl: false,
      useCertSpotter: false,
      fetcher: async () => response('', 503),
    });

    expect(result).toMatchObject({
      outcome: 'partial',
      probed: [{ host: 'tenant.vendor.example', retryable: true }],
      sourceOutcomes: {
        probes: { outcome: 'partial', items: 1, errorCode: 'transient_probe_failures' },
      },
    });
    expect(result.probed[0].failureStatuses).toContain(503);
  });

  it.each([
    ['robots.txt', { blockedByRobots: true }],
    ['public URL policy', { policyBlocked: true }],
  ])('keeps blocked tenant probes incomplete without marking them retryable (%s)', async (_label, denial) => {
    const result = await enumerateTenants({
      ...platform,
      hostSamples: ['tenant.vendor.example'],
    }, {
      maxProbe: 5,
      useCommonCrawl: false,
      useCertSpotter: false,
      fetcher: async (url) => ({
        ok: false,
        status: 0,
        body: '',
        url: String(url),
        host: new URL(String(url)).hostname,
        ...denial,
      }),
    });

    expect(result).toMatchObject({
      outcome: 'partial',
      probed: [{ host: 'tenant.vendor.example', retryable: false, blocked: true }],
      sourceOutcomes: {
        probes: { outcome: 'partial', items: 1, errorCode: 'blocked_probe_requests' },
      },
    });
  });

  it('classifies invalid CertSpotter JSON as malformed rather than zero tenants', async () => {
    const result = await enumerateViaCertSpotter('vendor.example', {
      fetcher: async () => response('{ not json'),
    });

    expect(result).toEqual({ hosts: [], outcome: 'malformed', errorCode: 'invalid_issuance_json' });
  });

  it('classifies an issuance missing expanded dns_names as malformed', async () => {
    const result = await enumerateViaCertSpotter('vendor.example', {
      fetcher: async () => response('[{}]'),
    });

    expect(result).toEqual({ hosts: [], outcome: 'malformed', errorCode: 'malformed_issuance_row' });
  });
});
