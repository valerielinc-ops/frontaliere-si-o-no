/** HTTP contract for site-level aliases reported by the Bing audit. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHardcodedRedirects } from '../build-plugins/shared/articleRedirects.mjs';
import { buildOggiPath } from '../build-plugins/borderWaitData';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import { legacyRedirectsPlugin } from '../build-plugins/legacyRedirectsPlugin';
import { readAttr, readTagByAttr } from '../scripts/lib/html-attr.mjs';
import { loadJobsJson } from '../build-plugins/shared/loadJobsJson';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { apexLegacyResponse, EDGE_LEGACY_GONE_PATHS, EDGE_LEGACY_REDIRECTS } from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('locale-router apex legacy routes', () => {
  it('actually emits both legacy nav fallback variants without a competing refresh', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'legacy-nav-bridges-'));
    try {
      mkdirSync(path.join(root, 'dist'), { recursive: true });
      // Without an explicit fixture the native loader falls back to cwd's real
      // job corpus in full CI, emitting unrelated cathedral pages in this test.
      mkdirSync(path.join(root, 'data'), { recursive: true });
      writeFileSync(path.join(root, 'data/jobs.json'), '[]');
      expect(loadJobsJson(root)).toEqual([]);
      const hook = legacyRedirectsPlugin(root).closeBundle;
      if (!hook || typeof hook !== 'object' || typeof hook.handler !== 'function') throw new Error('Expected the ordered native producer hook');
      await hook.handler.call({} as never);
      const table = SLUG_TABLES.it;
      for (const [action, target] of [
        ['health', `/${table.confronti}/${table.health}/`], ['pension', `/${table.fisco}/${table.pension}/`],
      ]) for (const suffix of ['/index.html', '.html']) {
        const html = readFileSync(path.join(root, 'dist', `nav:${action}${suffix}`), 'utf8');
        expect(readAttr(readTagByAttr(html, 'rel', 'canonical'), ['href'])).toBe(`${APEX}${target}`);
        expect(readAttr(readTagByAttr(html, 'name', 'robots'), ['content'])?.replace(/\s/g, '')).toBe('noindex,follow');
        expect(readTagByAttr(html, 'http-equiv', 'refresh')).toBeFalsy();
        expect((html.match(/<a\b[^>]*>/g) || []).some(tag => {
          const href = readAttr(tag, ['href']);
          return href && new URL(href, APEX).href === `${APEX}${target}`;
        })).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['health', 'pension'] as const)('keeps the attested legacy nav:%s alias aligned with its native tool and static fallback', async (action) => {
    const table = SLUG_TABLES.it;
    const target = action === 'health' ? `/${table.confronti}/${table.health}/` : `/${table.fisco}/${table.pension}/`;
    const from = `/nav:${action}/`;
    const root = path.resolve(__dirname, '..');
    expect(readHardcodedRedirects(root)[from]).toBe(target);
    const source = readFileSync(path.join(root, 'build-plugins/legacyRedirectsPlugin.ts'), 'utf8');
    const edgePaths = source.match(/const EDGE_HTTP_REDIRECT_PATHS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    expect(edgePaths).toContain(`'${from}'`);
    for (const suffix of ['', '/', '/index.html']) for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(`${APEX}/nav:${action}${suffix}?utm_source=gsc`, { method }), {}, ctx);
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(`${target}?utm_source=gsc`);
    }
    expect(apexLegacyResponse(new URL(`${APEX}${target}`))).toBeNull();
  });

  it('does not reinterpret unknown or nested pseudo-navigation paths', () => {
    for (const pathname of ['/nav:unknown/', '/nav:health-extra/', '/nav:health/extra/', '/en/nav:health/', '/nav:healthier/']) {
      expect(apexLegacyResponse(new URL(`${APEX}${pathname}`)), pathname).toBeNull();
    }
  });

  it('does not redirect un-emitted weather crossing aliases or neighbouring dates', () => {
    for (const base of ['/en/border-traffic', '/de/grenze-verkehr', '/fr/trafic-frontalier']) {
      for (const tail of ['unknown/oggi/', 'chiasso-centro/oggi/', 'ponte-tresa/2026-04/', 'ponte-tresa/oggi/unknown/', 'ponte-tresa/oggix/']) {
        expect(apexLegacyResponse(new URL(`${APEX}${base}/${tail}`))).toBeNull();
      }
    }
  });

  it.each((['en', 'de', 'fr'] as const).flatMap(locale =>
    (['chiasso-brogeda', 'oria-gandria', 'rodero-stabio', 'gaggiolo', 'ponte-tresa'] as const).map(crossing => ({locale, crossing})),
  ))('HTTP GET/HEAD recover the weather alias $locale/$crossing', async ({locale, crossing}) => {
    const base = { en: '/en/border-traffic', de: '/de/grenze-verkehr', fr: '/fr/trafic-frontalier' }[locale];
    const from = `${APEX}${base}/${crossing}/oggi/?utm_source=gsc`;
    const expected = `${buildOggiPath(locale, crossing)}?utm_source=gsc`;
    expect(apexLegacyResponse(new URL(from))?.headers.get('Location')).toBe(expected);
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(from, {method}), {}, ctx);
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(expected);
    }
  });

  it.each([
    ['/cookie/', '/privacy/'],
    ['/fr/articles-frontalier/naspi-disoccupazione-frontalieri/', '/fr/articles-frontalier/naspi-anciens-frontaliers-2026/'],
    ['/jobs-im-tessin/', '/de/jobs-im-tessin/'],
    ['/grenzgaenger-artikel/', '/de/grenzgaenger-artikel/'],
    ['/trouver-emploi-tessin/', '/fr/trouver-emploi-tessin/'],
    ['/nav:pension/', '/tasse-e-pensione/calcola-previdenza/'],
    ['/servizi-partner/', '/'],
    ['/en/partner-services/', '/en/'],
    ['/de/partner-dienste/', '/de/'],
    ['/fr/services-partenaires/', '/fr/'],
    ['/job-board/', '/cerca-lavoro-svizzera/'],
    ['/calcola-stipendio/confronta-permesso-g-vs-b/', '/guida-frontaliere/confronta-permesso-g-vs-b/'],
    ['/guida-frontaliere/comuni-di-frontiera/', '/vivere-in-ticino/comuni-di-frontiera/'],
    ['/vivere-in-ticino/vivere-in-svizzera/', '/vivere-in-ticino/'],
    ['/statistiche/traffico-dogane/', '/traffico-dogane/'],
    ['/en/border-traffic/gaggiolo/oggi/', '/en/border-wait/gaggiolo/today/'],
    ['/eventi/ticino/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/', '/eventi/grigioni/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/'],
    ['/en/events/ticino/other-events/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/', '/en/events/graubunden/other-events/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/'],
    ['/de/veranstaltungen/tessin/weitere-veranstaltungen/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/', '/de/veranstaltungen/graubunden/weitere-veranstaltungen/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/'],
    ['/fr/evenements/tessin/autres-evenements/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/', '/fr/evenements/grisons/autres-evenements/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/'],
    ['/guida-frontaliere/tempi-attesa-dogana/', '/traffico-dogane/'],
    ['/guida-frontaliere/diritto-lavoro-frontalieri/', '/guida-frontaliere/'],
    ['/tfr-calculator/', '/tfr-liquidazione-frontaliere/'],
    ['/calcolatore/', '/calcola-stipendio/'],
    ['/guida-frontaliere/diritto-opzione-lamal/', '/guida-frontaliere/lamal-frontalieri/'],
    ['/statistiche/confronta-premi/', '/statistiche/premi-malattia-comuni/'],
    ['/stipendi-frontalieri-ticino/', '/statistiche/confronta-stipendi/'],
    ['/tredicesima-svizzera/', '/calcolo-tredicesima-frontaliere/'],
    ['/comparatori/cambio-valuta/', '/compara-servizi/cambio-franco-euro/'],
    ['/costo-della-vita/', '/compara-servizi/costo-della-vita/'],
    ['/guida-frontaliere/nuova-legge-frontalieri-2024/', '/guida-frontaliere/'],
    ['/fisco-frontalieri/', '/tasse-e-pensione/'],
  ])('301s %s to %s', async (from, target) => {
    const response = apexLegacyResponse(new URL(`${APEX}${from}`));
    expect(response?.status).toBe(301);
    expect(response?.headers.get('Location')).toBe(target);
    const workerResponse = await worker.fetch(new Request(`${APEX}${from}`), {}, ctx);
    expect(workerResponse.status).toBe(301);
    expect(workerResponse.headers.get('Location')).toBe(target);
  });

  it('preserves query strings and normalizes slashless/index variants', () => {
    expect(apexLegacyResponse(new URL(`${APEX}/jobs-im-tessin?utm_source=bing`))?.headers.get('Location')).toBe('/de/jobs-im-tessin/?utm_source=bing');
    expect(apexLegacyResponse(new URL(`${APEX}/grenzgaenger-artikel/index.html`))?.headers.get('Location')).toBe('/de/grenzgaenger-artikel/');
  });

  it('keeps the observed border alias exact, without guessing nearby routes', () => {
    for (const suffix of ['', '/', '/index.html']) {
      const from = `${APEX}/en/border-traffic/gaggiolo/oggi${suffix}?utm_source=gsc`;
      expect(apexLegacyResponse(new URL(from))?.headers.get('Location')).toBe('/en/border-wait/gaggiolo/today/?utm_source=gsc');
    }
    for (const pathname of ['/en/border-traffic/unknown/oggi/', '/en/border-traffic/gaggiolo/2026-04/', '/en/border-wait/gaggiolo/today/']) {
      expect(apexLegacyResponse(new URL(`${APEX}${pathname}`))).toBeNull();
    }
  });

  it('keeps observed legal/article aliases exact and aligned with static fallback', () => {
    const root = path.resolve(__dirname, '..');
    const staticMap = readHardcodedRedirects(root);
    const source = readFileSync(path.join(root, 'build-plugins/legacyRedirectsPlugin.ts'), 'utf8');
    const edgePaths = source.match(/const EDGE_HTTP_REDIRECT_PATHS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    for (const [from, target] of [
      ['/cookie/', '/privacy/'],
      ['/fr/articles-frontalier/naspi-disoccupazione-frontalieri/', '/fr/articles-frontalier/naspi-anciens-frontaliers-2026/'],
    ]) {
      expect(staticMap[from]).toBe(target);
      expect(edgePaths).toContain(`'${from}'`);
      for (const suffix of ['', '/', '/index.html']) {
        const url = `${APEX}${from.slice(0, -1)}${suffix}?utm_source=gsc`;
        expect(apexLegacyResponse(new URL(url))?.headers.get('Location')).toBe(`${target}?utm_source=gsc`);
      }
      expect(apexLegacyResponse(new URL(`${APEX}${target}`))).toBeNull();
    }
    for (const pathname of ['/cookies/', '/cookie-policy/', '/cookie/unknown/', '/fr/articles-frontalier/naspi-disoccupazione-frontalieri-unknown/', '/en/cross-border-articles/naspi-disoccupazione-frontalieri/']) {
      expect(apexLegacyResponse(new URL(`${APEX}${pathname}`))).toBeNull();
    }
  });

  it('returns 410 noindex for the retired calculator with no substitute', async () => {
    const response = apexLegacyResponse(new URL(`${APEX}/calcolatore-5x1000/`));
    expect(response?.status).toBe(410);
    expect(response?.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await response?.text()).toContain('Pagina rimossa');
  });

  it('does not infer a canton migration for a different event or date', () => {
    for (const pathname of ['/eventi/ticino/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-15/', '/eventi/ticino/altri-eventi/unknown-2026-10-14/', '/eventi/grigioni/altri-eventi/kino-tschlin-syngue-sabour-stein-der-geduld-2026-10-14/']) {
      expect(apexLegacyResponse(new URL(`${APEX}${pathname}`))).toBeNull();
    }
  });

  it('does not hijack an unrelated apex path and keeps Wrangler routes explicit', () => {
    expect(apexLegacyResponse(new URL(`${APEX}/contattaci/`))).toBeNull();
    expect(Object.keys(EDGE_LEGACY_REDIRECTS)).toHaveLength(47);
    expect(Object.keys(EDGE_LEGACY_GONE_PATHS)).toEqual(['/calcolatore-5x1000/']);
    const wrangler = readFileSync(path.resolve(__dirname, '..', 'infra/cloudflare-worker/wrangler.toml'), 'utf8');
    for (const pathname of [...Object.keys(EDGE_LEGACY_REDIRECTS), ...Object.keys(EDGE_LEGACY_GONE_PATHS)]) {
      const routePrefix = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      expect(wrangler).toContain(`frontaliereticino.ch${routePrefix}*`);
    }
  });
});
