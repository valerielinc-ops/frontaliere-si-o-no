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
