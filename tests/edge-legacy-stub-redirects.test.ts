// @vitest-environment node
/**
 * legacyRedirectsPlugin's static map is served as REAL 301s by the apex Worker.
 *
 * The plugin answers each legacy URL with a 200 "Pagina spostata" stub
 * (noindex,follow + meta-refresh) — a fake page, not a redirect. The Worker
 * upgrades that stub to a 301 using a table GENERATED from the plugin's own
 * map. This file is the gate for the three properties that make it safe:
 *
 *   1. the generated table is byte-identical to a fresh render of the plugin
 *      map (no hand-kept second copy can drift);
 *   2. every listed path, requested at the edge while the origin serves the
 *      stub, answers 301 with the right Location, and the Location itself is
 *      answered 200 by the edge — one hop, never a chain;
 *   3. a LIVE page at a listed path wins: the Worker serves it unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEdgeLegacyStubRedirects,
  renderEdgeLegacyStubModule,
  EDGE_LEGACY_STUB_MODULE_PATH,
  EDGE_LEGACY_STUB_GENERATOR,
} from '../build-plugins/shared/edgeLegacyStubRedirects';
import { readHardcodedRedirects } from '../build-plugins/shared/articleRedirects.mjs';
import { buildCanonicalBridgePage } from '../build-plugins/constants';
import { renderProfessionBelowFloorBridge } from '../build-plugins/shared/professionJobsFloor';
import { renderSalaryStatsBridge, salaryStatsBridgeTarget } from '../build-plugins/shared/salaryStatsBridge';
import { listAllProfessionCantonPaths } from '../build-plugins/professionCantonData';
import { listAllSalaryProfessionCantonPaths } from '../build-plugins/salaryProfessionCantonData';
import { PROFESSION_IDS, PROFESSION_LOCALES, buildProfessionLandingPath } from '../build-plugins/professionLandingsData';
import { CH_CANTON_EMPLOYERS_CANTON_KEYS, buildCantonEmployersPath } from '../build-plugins/weeklyEmployersChCantonPathsData';
import { CH_CANTON_SNAPSHOT_CANTON_KEYS, buildCantonSnapshotPath } from '../build-plugins/jobMarketSnapshotChCantonPathsData';
import { SALARY_STATS_CANTON_SLUGS } from '../build-plugins/salaryStatsData';
// Imported (not only read) so scripts/ci/run-related-tests.mjs selects this
// file whenever the plugin's table changes.
import { legacyRedirectsPlugin } from '../build-plugins/legacyRedirectsPlugin';
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { EDGE_LEGACY_REDIRECTS, EDGE_RETIRED_PATHS, apexLegacyResponse, legacyStubTarget, lookupRetired, upgradeLegacyStub } from '../infra/cloudflare-worker/locale-router.js';
// @ts-expect-error — plain JS generated module.
import { EDGE_LEGACY_STUB_REDIRECTS } from '../infra/cloudflare-worker/legacy-stub-redirects.generated.mjs';

const ROOT = path.resolve(__dirname, '..');
const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const STUB_TABLE = EDGE_LEGACY_STUB_REDIRECTS as Record<string, string>;

const stubHtml = (to: string) => buildCanonicalBridgePage({
  canonicalUrl: `${APEX}${to}`,
  pathLabel: to,
  title: 'Pagina spostata',
  noindex: true,
  crossPageSignals: false,
});
const LIVE_HTML = '<!DOCTYPE html><html lang="it"><head><meta name="robots" content="index,follow"><title>Live</title></head><body>live page</body></html>';

describe('below-floor salary bridge HTTP recovery', () => {
  it('covers every producer of the shared salary-stats bridge in all locales', () => {
    const entries = [...listAllProfessionCantonPaths(), ...listAllSalaryProfessionCantonPaths()];
    for (const locale of PROFESSION_LOCALES) {
      for (const id of PROFESSION_IDS) entries.push({ path: buildProfessionLandingPath(locale, id), locale, cantonKey: 'TI', id });
      for (const cantonKey of CH_CANTON_EMPLOYERS_CANTON_KEYS) {
        expect(legacyStubTarget(buildCantonEmployersPath(locale, SALARY_STATS_CANTON_SLUGS[cantonKey][locale])))
          .toBe(salaryStatsBridgeTarget(locale, cantonKey).targetPath);
      }
      for (const cantonKey of CH_CANTON_SNAPSHOT_CANTON_KEYS) {
        expect(legacyStubTarget(buildCantonSnapshotPath(locale, SALARY_STATS_CANTON_SLUGS[cantonKey][locale])))
          .toBe(salaryStatsBridgeTarget(locale, cantonKey).targetPath);
      }
    }
    for (const { path, locale, cantonKey } of entries) {
      expect(legacyStubTarget(path), path).toBe(salaryStatsBridgeTarget(locale, cantonKey).targetPath);
    }
  });

  it.each(['logopedista', 'farmacista', 'assistente-dentale', 'tecnico-radiologia', 'architetto'] as const)(
    'upgrades the real %s bridge while preserving a live page at the same URL', async (id) => {
      const path = buildProfessionLandingPath('it', id);
      const bridge = renderProfessionBelowFloorBridge('it', 'TI', id);
      expect(bridge).toContain('http-equiv="refresh"');
      for (const method of ['GET', 'HEAD']) {
        const response = await upgradeLegacyStub(new Request(`${APEX}${path}?utm_source=audit`, { method }),
          new Response(method === 'HEAD' ? null : bridge, { headers: { 'Content-Type': 'text/html' } }),
          async () => new Response(bridge, { headers: { 'Content-Type': 'text/html' } }));
        expect(response.status).toBe(301);
        expect(response.headers.get('Location')).toBe('/stipendi-ticino/?utm_source=audit');
        expect(await response.text()).toBe('');
      }
      const live = await upgradeLegacyStub(new Request(`${APEX}${path}`), new Response(LIVE_HTML), async () => new Response(LIVE_HTML));
      expect(live.status).toBe(200);
      expect(await live.text()).toBe(LIVE_HTML);
    },
  );

  it('leaves an unlisted marked bridge untouched', async () => {
    const html = renderSalaryStatsBridge('it', 'TI', { title: 'Bridge', description: 'No inventory', ctaLabel: 'Open data' });
    const origin = new Response(html, { headers: { 'Content-Type': 'text/html' } });
    expect(await upgradeLegacyStub(new Request(`${APEX}/not-an-enumerated-profession/`), origin, async () => new Response(html))).toBe(origin);
  });
});

/**
 * Public directory form of whatever path the Worker asked the origin for. The
 * Ticino shard stores entries under `<prefix>/_tree/<bucket>/` (storage-only
 * fan-out); fold that back to the public URL.
 */
function dirForm(pathname: string): string {
  const p = pathname.replace(/\/_tree\/[^/]+\//, '/').replace(/index\.html$/, '').replace(/\.html$/, '');
  return p.endsWith('/') ? p : `${p}/`;
}

function mockOrigin(stubPaths: Set<string>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const html = stubPaths.has(dirForm(url.pathname)) ? stubHtml(STUB_TABLE[dirForm(url.pathname)] || '/') : LIVE_HTML;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
}

beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('generated edge table', () => {
  it('is byte-identical to a fresh render of the plugin map', () => {
    expect(typeof legacyRedirectsPlugin).toBe('function');
    const fresh = renderEdgeLegacyStubModule(buildEdgeLegacyStubRedirects(ROOT));
    const committed = fs.readFileSync(path.join(ROOT, EDGE_LEGACY_STUB_MODULE_PATH), 'utf-8');
    expect(committed === fresh, `${EDGE_LEGACY_STUB_MODULE_PATH} is stale — run: ${EDGE_LEGACY_STUB_GENERATOR}`).toBe(true);
  });

  it('covers every hand-authored literal entry', () => {
    const literal = readHardcodedRedirects(ROOT) as Record<string, string>;
    expect(Object.keys(literal).length).toBeGreaterThan(200);
    for (const [from, to] of Object.entries(literal)) {
      const key = from.endsWith('/') ? from : `${from}/`;
      expect(STUB_TABLE[key], key).toBe(to.endsWith('/') ? to : `${to}/`);
    }
  });

  it('never chains: no target is itself redirected or retired at the edge', () => {
    for (const [from, to] of Object.entries(STUB_TABLE)) {
      expect(legacyStubTarget(to), `${from} → ${to} → ${legacyStubTarget(to)}`).toBeUndefined();
      expect(apexLegacyResponse(new URL(`${APEX}${to}`)), `${from} → ${to} is an apex alias`).toBeNull();
      expect(lookupRetired(to), `${from} → ${to} is a retired path`).toBeUndefined();
    }
  });

  it('agrees with the edge tables that answer first', () => {
    for (const [from, to] of Object.entries(STUB_TABLE)) {
      const apex = (EDGE_LEGACY_REDIRECTS as Record<string, string>)[from];
      if (apex !== undefined) expect(apex, from).toBe(to);
      const retired = (EDGE_RETIRED_PATHS as Record<string, string | null>)[from];
      // null = 410 by design (no substitute); a 301 there must name the same page.
      if (retired) expect(retired, from).toBe(to);
    }
  });
});

describe('edge HTTP contract', () => {
  // Paths another edge table answers before the origin is ever asked.
  const ownPaths = Object.keys(STUB_TABLE).filter(from =>
    apexLegacyResponse(new URL(`${APEX}${from}`)) === null && lookupRetired(from) === undefined);

  it('resolves encoded and decoded non-ASCII legacy keys after path normalization', () => {
    const encoded = '/fr/articles-frontalier/s%C3%A9jours-irr%C3%A9guliers-2026-mendrisio/';
    const target = '/fr/articles-frontalier/baisse-sejours-irreguliers-juillet/';
    for (const variant of [encoded, decodeURI(encoded), encoded.toLowerCase(), `${encoded}index.html`, encoded.slice(0, -1)]) {
      expect(legacyStubTarget(variant), variant).toBe(target);
    }
  });

  it('leaves a non-trivial set of paths to the stub upgrade', () => {
    expect(ownPaths.length).toBeGreaterThan(700);
  });

  it('every listed path → 301 to its target in one hop (GET)', async () => {
    mockOrigin(new Set(ownPaths));
    for (const from of ownPaths) {
      const to = STUB_TABLE[from];
      const response = await worker.fetch(new Request(`${APEX}${from}?utm_source=gsc`), {}, ctx);
      expect(response.status, from).toBe(301);
      expect(response.headers.get('Location'), from).toBe(`${to}?utm_source=gsc`);
      const hop = await worker.fetch(new Request(`${APEX}${to}`), {}, ctx);
      expect(hop.status, `${from} → ${to} must land, not redirect again`).toBe(200);
      expect(hop.headers.get('Location')).toBeNull();
    }
  }, 120_000);

  it('answers the slashless and /index.html forms the same way', async () => {
    mockOrigin(new Set(ownPaths));
    for (const from of ownPaths.filter((_, i) => i % 40 === 0)) {
      for (const variant of [from.slice(0, -1), `${from}index.html`]) {
        const response = await worker.fetch(new Request(`${APEX}${variant}`), {}, ctx);
        expect(response.status, variant).toBe(301);
        expect(response.headers.get('Location'), variant).toBe(STUB_TABLE[from]);
      }
    }
  });

  it('HEAD gets the same 301 without a body', async () => {
    mockOrigin(new Set(ownPaths));
    for (const from of ownPaths.filter((_, i) => i % 25 === 0)) {
      const response = await worker.fetch(new Request(`${APEX}${from}`, { method: 'HEAD' }), {}, ctx);
      expect(response.status, from).toBe(301);
      expect(response.headers.get('Location'), from).toBe(STUB_TABLE[from]);
      expect(await response.text()).toBe('');
    }
  });

  it('a live page at a listed path wins over the table', async () => {
    mockOrigin(new Set());
    for (const from of ownPaths.filter((_, i) => i % 50 === 0)) {
      for (const method of ['GET', 'HEAD']) {
        const response = await worker.fetch(new Request(`${APEX}${from}`, { method }), {}, ctx);
        expect(response.status, `${method} ${from}`).toBe(200);
        expect(response.headers.get('Location')).toBeNull();
        if (method === 'GET') expect(await response.text()).toBe(LIVE_HTML);
      }
    }
  });

  it('a live page re-served after the body check carries no stale encoding headers', async () => {
    // The Workers runtime hands text() the decoded body but keeps the origin's
    // Content-Encoding/Content-Length; re-labelling decoded bytes as gzip would
    // make the page undecodable for the client.
    const listed = ownPaths[0];
    const origin = new Response(LIVE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': '123', 'Cache-Control': 'public, max-age=60' },
    });
    const out = await upgradeLegacyStub(new Request(`${APEX}${listed}`), origin, async () => origin);
    expect(out.status).toBe(200);
    expect(out.headers.get('Content-Encoding')).toBeNull();
    expect(out.headers.get('Content-Length')).toBeNull();
    expect(out.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await out.text()).toBe(LIVE_HTML);
  });

  it('does not touch unlisted paths, non-200 answers or other methods', async () => {
    const stub = () => new Response(stubHtml('/'), { status: 200, headers: { 'Content-Type': 'text/html' } });
    const listed = ownPaths[0];
    const refetch = async () => stub();
    const unlisted = stub();
    expect(await upgradeLegacyStub(new Request(`${APEX}/not-a-legacy-path/`), unlisted, refetch)).toBe(unlisted);
    const notFound = new Response(stubHtml('/'), { status: 404, headers: { 'Content-Type': 'text/html' } });
    expect(await upgradeLegacyStub(new Request(`${APEX}${listed}`), notFound, refetch)).toBe(notFound);
    const post = stub();
    expect(await upgradeLegacyStub(new Request(`${APEX}${listed}`, { method: 'POST', body: 'x' }), post, refetch)).toBe(post);
  });
});
