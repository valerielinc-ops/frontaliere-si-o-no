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

  it('returns 410 noindex for the retired calculator with no substitute', async () => {
    const response = apexLegacyResponse(new URL(`${APEX}/calcolatore-5x1000/`));
    expect(response?.status).toBe(410);
    expect(response?.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await response?.text()).toContain('Pagina rimossa');
  });

  it('does not hijack an unrelated apex path and keeps Wrangler routes explicit', () => {
    expect(apexLegacyResponse(new URL(`${APEX}/contattaci/`))).toBeNull();
    expect(Object.keys(EDGE_LEGACY_REDIRECTS)).toHaveLength(25);
    expect(Object.keys(EDGE_LEGACY_GONE_PATHS)).toEqual(['/calcolatore-5x1000/']);
    const wrangler = readFileSync(path.resolve(__dirname, '..', 'infra/cloudflare-worker/wrangler.toml'), 'utf8');
    for (const pathname of [...Object.keys(EDGE_LEGACY_REDIRECTS), ...Object.keys(EDGE_LEGACY_GONE_PATHS)]) {
      const routePrefix = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      expect(wrangler).toContain(`frontaliereticino.ch${routePrefix}*`);
    }
  });
});
