// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} };
const aliases = {
  'denner-sa': 'denner',
  'denner-ag': 'denner',
  'kantonsspital-st-gallen-kssg-hoch': 'hoch-health-ostschweiz',
  'solothurner-spitaler-soh': 'solothurner-spitaler-ag-soh',
  'migros-genossenschafts-bund': 'migros-hq-zurich',
};
const paths = Object.entries(aliases).flatMap(([from, to]) => ['', '/en', '/de', '/fr'].map(prefix => ({
  from: `${prefix}/aziende/${from}/`, to: `${prefix}/aziende/${to}/`,
})));
beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockOrigin(from: string, to: string, sourceStatus = 200, targetStatus: number | 'network' = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === to) {
      if (targetStatus === 'network') throw new TypeError('Target unavailable');
      return new Response('canonical profile', { status: targetStatus });
    }
    return new Response('existing origin content', { status: url.pathname === from ? sourceStatus : 404 });
  });
}

describe.each(['GET', 'HEAD'])('exact employer profile display-name migrations (%s)', (method) => {
  for (const sourceStatus of [200, 404]) {
    it.each(paths)(`returns a verified same-locale 301 over an origin ${sourceStatus}: $from`, async ({ from, to }) => {
      const fetchMock = mockOrigin(from, to, sourceStatus);
      const response = await worker.fetch(new Request(`${APEX}${from}?utm_source=gsc`, { method }), {}, ctx);
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(`${to}?utm_source=gsc`);
      expect(await response.text()).toBe('');
      const probe = fetchMock.mock.calls.find(([input]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname === to);
      expect(probe).toBeDefined();
      expect(probe?.[1]?.method ?? 'GET').toBe('GET');
    });

    it.each([404, 410, 429, 503, 302])(`does not redirect an origin ${sourceStatus} to an unverified target (%s)`, async status => {
      const { from, to } = paths[0]; mockOrigin(from, to, sourceStatus, status);
      const response = await worker.fetch(new Request(`${APEX}${from}`, { method }), {}, ctx);
      expect(response.status).toBe([404, 410].includes(status) ? sourceStatus : 503);
      expect(response.headers.get('Location')).toBeNull();
      if (response.status === 503) {
        expect(response.headers.get('Retry-After')).toBe('60');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    });

    it(`keeps target network failure temporary over an origin ${sourceStatus}`, async () => {
      const { from, to } = paths[0]; mockOrigin(from, to, sourceStatus, 'network');
      expect((await worker.fetch(new Request(`${APEX}${from}`, { method }), {}, ctx)).status).toBe(503);
    });
  }

  it.each([
    '/fr/aziende/denner/', '/aziende/christ-orologi-gioielli/', '/aziende/spitex-mittleres-tosstal/',
    '/aziende/pkb-private-bank-sa/', '/fr/aziende/migros-hq-zurich/',
    '/en/aziende/solothurner-spitaler-soh/extra/', '/it/aziende/denner-sa/',
    '/en/companies/denner-sa/', '/en/aziende/constructor/',
  ])('never guesses an alias or probes a healthy canonical: %s', async from => {
    const fetchMock = mockOrigin(from, '/unused/');
    const response = await worker.fetch(new Request(`${APEX}${from}`, { method }), {}, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('existing origin content');
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it.each([410, 503])('does not override an explicit origin withdrawal or outage (%s)', async status => {
    const { from, to } = paths[0]; const fetchMock = mockOrigin(from, to, status);
    expect((await worker.fetch(new Request(`${APEX}${from}`, { method }), {}, ctx)).status).toBe(status);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(to))).toBe(false);
  });
});
