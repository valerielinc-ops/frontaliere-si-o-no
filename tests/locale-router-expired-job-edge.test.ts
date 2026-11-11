import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral dataset helpers have no separate declarations.
import {
  EXPIRED_JOB_EDGE_DATASET_PREFIX,
  EXPIRED_JOB_EDGE_SCHEMA_VERSION,
  EXPIRED_JOB_EDGE_SHARD_COUNT,
  expiredJobEdgeShardId,
} from '../scripts/lib/expired-job-edge-dataset.mjs';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const PAGE_PATH = '/en/find-jobs-zurich/expired-engineer/';
const TEMPLATE = `<!doctype html><html lang="en"><head><title>__FT_EDGE_TITLE__</title>
<meta property="og:title" content="__FT_EDGE_SOCIAL_TITLE__"><meta property="og:description" content="__FT_EDGE_SOCIAL_DESCRIPTION__">
<meta name="description" content="__FT_EDGE_DESCRIPTION__"><meta name="robots" content="noindex, follow">
<link rel="canonical" href="https://frontaliereticino.ch/__FT_EDGE_CANONICAL_PATH__">
__FT_EDGE_HREFLANG____FT_EDGE_JSONLD__<script>window.__EXPIRED_JOB_DATA__=__FT_EDGE_DATA__;</script>
__FT_EDGE_AD_SNIPPET__
<script defer src="/assets/site-support.js"></script>
<script defer src="/assets/adsense-loader.js"></script>
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script></head><body>__FT_EDGE_BODY__</body></html>`;
const page = {
  slug: 'expired-engineer',
  canonicalPath: PAGE_PATH,
  title: 'Engineer',
  metaDescription: 'This listing has expired.',
  employer: 'Example GmbH',
  place: 'Zürich',
  canton: 'ZH',
  expiredAt: '2026-10-01',
  expiredMessage: 'This listing has expired.',
  similarHeading: 'Other active positions',
  boardUrl: '/en/find-jobs-zurich/',
  similarActiveJobs: [{ href: '/en/find-jobs-zurich/active-engineer/', title: 'Active engineer' }],
  alternates: [{ locale: 'en', href: PAGE_PATH }],
  breadcrumbs: [{ name: 'Home', href: '/en/' }],
};

let originStatus = 404;
let datasetMode: 'hit' | 'missing' | 'unavailable' | 'disabled' | 'inactive' = 'hit';
let fetchedPaths: string[];

beforeEach(() => {
  originStatus = 404;
  datasetMode = 'hit';
  fetchedPaths = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    fetchedPaths.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === 'cdn.frontaliereticino.ch') {
      if (url.pathname === `${EXPIRED_JOB_EDGE_DATASET_PREFIX}/en/manifest.json`) {
        if (datasetMode === 'unavailable') return new Response('temporarily unavailable', { status: 503 });
        if (datasetMode === 'disabled') return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({
          version: EXPIRED_JOB_EDGE_SCHEMA_VERSION,
          datasetPrefix: EXPIRED_JOB_EDGE_DATASET_PREFIX,
          locale: 'en',
          generation: 'test-build-1',
          activeSections: datasetMode === 'hit' || datasetMode === 'missing' ? ['zurigo'] : [],
          shardCount: EXPIRED_JOB_EDGE_SHARD_COUNT,
          shardIds: [expiredJobEdgeShardId(PAGE_PATH)],
          coverage: { complete: true },
          template: TEMPLATE,
          adSnippetHtml: '<script>adsbygoogle</script>',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.startsWith(`${EXPIRED_JOB_EDGE_DATASET_PREFIX}/en/test-build-1/`)) {
        if (datasetMode === 'unavailable') return new Response('temporarily unavailable', { status: 503 });
        const shardId = expiredJobEdgeShardId(PAGE_PATH);
        return new Response(JSON.stringify({
          version: EXPIRED_JOB_EDGE_SCHEMA_VERSION,
          locale: 'en',
          generation: 'test-build-1',
          shardId,
          coverage: { complete: true },
          pages: datasetMode === 'hit' || datasetMode === 'inactive' ? { [PAGE_PATH]: page } : {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }
    if (url.hostname.startsWith('origin-zurigo-en.')) {
      return new Response(originStatus === 200 ? '<html>static shard page</html>' : 'not found', { status: originStatus });
    }
    return new Response('not found', { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('locale-router expired job R2 soft landings', () => {
  it('serves an active dataset record before the known-job 404 redirect recovery', async () => {
    const response = await worker.fetch(new Request(`${APEX}${PAGE_PATH}`), {}, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toMatch(/noindex,\s*follow/i);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('noindex, follow');
    expect(html).toContain('href="https://frontaliereticino.ch/en/find-jobs-zurich/active-engineer/"');
    expect(html).toContain('adsbygoogle.js');
    expect(html).toContain('googletagmanager.com/gtag/js');
    expect(html).not.toContain('JobPosting');
    expect(fetchedPaths.some((path) => path.startsWith('cdn.frontaliereticino.ch/edge/expired-jobs/v1/en/'))).toBe(true);
    expect(fetchedPaths.some((path) => path.startsWith('cdn.frontaliereticino.ch/job-canon/'))).toBe(false);
  });

  it('leaves an origin 200 untouched without reading R2', async () => {
    originStatus = 200;
    const response = await worker.fetch(new Request(`${APEX}${PAGE_PATH}`), {}, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('static shard page');
    expect(fetchedPaths.some((path) => path.includes('/edge/expired-jobs/'))).toBe(false);
  });

  it('renders the published edge record through the verification header while static output remains', async () => {
    originStatus = 200;
    datasetMode = 'inactive';
    const response = await worker.fetch(new Request(`${APEX}${PAGE_PATH}`, {
      headers: { 'x-frontaliere-expired-job-edge-verify': '1' },
    }), {}, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Frontaliere-Edge-Verification')).toBe('expired-job-dataset');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toMatch(/noindex,\s*follow/i);
    expect(html).toContain(`rel="canonical" href="${APEX}${PAGE_PATH}"`);
    expect(html).toContain(`hreflang="en" href="${APEX}${PAGE_PATH}"`);
    expect(html).toContain('href="https://frontaliereticino.ch/en/find-jobs-zurich/active-engineer/"');
    expect(html).toContain('src="/assets/site-support.js"');
    expect(html).toContain('src="/assets/adsense-loader.js"');
    expect(html).toContain('adsbygoogle.js');
    expect(html).toContain('googletagmanager.com/gtag/js');
    expect(html).not.toContain('JobPosting');
    expect(fetchedPaths.some((path) => path.startsWith('cdn.frontaliereticino.ch/edge/expired-jobs/v1/en/'))).toBe(true);
    expect(fetchedPaths.some((path) => path.startsWith('origin-zurigo-en.'))).toBe(false);
  });

  it('keeps a transient R2 failure out of the section-root redirect recovery', async () => {
    datasetMode = 'unavailable';
    const response = await worker.fetch(new Request(`${APEX}${PAGE_PATH}`), {}, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchedPaths.some((path) => path.startsWith('cdn.frontaliereticino.ch/job-canon/'))).toBe(false);
  });

  it('falls through to today’s shard behavior when the manifest has no record', async () => {
    datasetMode = 'disabled';
    const response = await worker.fetch(new Request(`${APEX}${PAGE_PATH}`), {}, ctx);

    expect(response.status).toBe(404);
  });
});
