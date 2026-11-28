// @vitest-environment node
/**
 * Every deliberate `alias-verification` 503 says which check could not answer
 * (`stage`) and why (`cause`). The response itself is the same for all of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} };
const PROFILE = '/aziende/denner-sa/';
const JOB = '/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/';

beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function run(path: string, upstream: (url: URL) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => (
    upstream(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
  ));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await worker.fetch(new Request(`${APEX}${path}?token=secret`), {}, ctx);
  const lines = log.mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter((line) => line?.reason === 'alias-verification');
  return { response, lines };
}

const profileTarget = (answer: () => Response) => (url: URL) => (
  url.pathname === '/aziende/denner/' ? answer() : new Response('origin', { status: 404 })
);
const jobMap = (answer: () => Response) => (url: URL) => {
  if (url.pathname === '/cdn-build-id.txt') return new Response('1001');
  if (url.pathname.startsWith('/job-canon/')) return answer();
  return new Response('origin', { status: 404 });
};

describe('alias-verification log classification', () => {
  it.each([
    ['target status', PROFILE, profileTarget(() => new Response('', { status: 429 })),
      { stage: 'employer-profile-target', cause: 'http-status', upstreamStatus: 429 }],
    ['target network error', PROFILE, profileTarget(() => { throw new TypeError(`no route to ${APEX}/x?token=secret`); }),
      { stage: 'employer-profile-target', cause: 'exception', error: 'TypeError' }],
    ['job-canon map status', JOB, jobMap(() => new Response('', { status: 503 })),
      { stage: 'job-canon-map', cause: 'http-status', upstreamStatus: 503 }],
    ['job-canon map truncated', JOB, jobMap(() => new Response('{')),
      { stage: 'job-canon-map', cause: 'invalid-json' }],
    ['job-canon map wrong shape', JOB, jobMap(() => new Response('[]')),
      { stage: 'job-canon-map', cause: 'invalid-shape' }],
  ])('%s', async (_label, path, upstream, expected) => {
    const { response, lines } = await run(path, upstream);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('Redirect verification temporarily unavailable');
    expect(lines).toEqual([{ event: 'origin_failure', reason: 'alias-verification', path, ...expected }]);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});
