/** HTTP contract for site-level aliases reported by the Bing audit. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { apexLegacyResponse, EDGE_LEGACY_GONE_PATHS, EDGE_LEGACY_REDIRECTS } from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('locale-router apex legacy routes', () => {
  it.each([
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
    expect(Object.keys(EDGE_LEGACY_REDIRECTS)).toHaveLength(30);
    expect(Object.keys(EDGE_LEGACY_GONE_PATHS)).toEqual(['/calcolatore-5x1000/']);
    const wrangler = readFileSync(path.resolve(__dirname, '..', 'infra/cloudflare-worker/wrangler.toml'), 'utf8');
    for (const pathname of [...Object.keys(EDGE_LEGACY_REDIRECTS), ...Object.keys(EDGE_LEGACY_GONE_PATHS)]) {
      const routePrefix = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      expect(wrangler).toContain(`frontaliereticino.ch${routePrefix}*`);
    }
  });
});
