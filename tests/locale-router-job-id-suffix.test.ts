import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockFetch(prefix: string | null, { targetStatus = 200, expectedOrigin = '' } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes('/job-canon/')) return Response.json(prefix ? { 'known-job': { it: prefix, en: prefix, de: prefix, fr: prefix } } : {});
    if (prefix && url.pathname === `${prefix}/known-job/` && (!expectedOrigin || url.hostname === expectedOrigin)) {
      return new Response('job', { status: targetStatus });
    }
    return new Response('missing', { status: 404 });
  });
}

describe('registry-confirmed vacancy aliases with a source id suffix', () => {
  it.each([
    ['/cerca-lavoro-zurigo', 'it'], ['/en/find-jobs-zurich', 'en'],
    ['/de/jobs-in-zurich', 'de'], ['/fr/trouver-emploi-zurich', 'fr'],
  ])('301s a known alias within its language: %s', async (prefix) => {
    mockFetch(prefix);
    const response = await worker.fetch(new Request(`${APEX}${prefix}/known-job/5162?utm_source=gsc`), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${prefix}/known-job/?utm_source=gsc`);
  });

  it('verifies a canton migration on the destination shard', async () => {
    mockFetch('/cerca-lavoro-appenzello', { expectedOrigin: 'origin-appenzello-it.frontaliereticino.ch' });
    const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/known-job/1150`), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/cerca-lavoro-appenzello/known-job/');
  });

  it.each([404, 503])('retains 404 when the registered destination is unavailable (%s)', async (targetStatus) => {
    mockFetch('/cerca-lavoro-zurigo', { targetStatus });
    expect((await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo/known-job/5162`), {}, ctx)).status).toBe(404);
  });

  it.each(['/known-job/5162', '/known-job/extra/', '/known-job/5162/extra/'])('does not guess a target without registry evidence: %s', async (suffix) => {
    mockFetch(null);
    expect((await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo${suffix}`), {}, ctx)).status).toBe(404);
  });
});
