/** Searches without a static page: 200 noindex from the board, never a soft 404. */
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import { serveUnknownSearchCluster } from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const notFound = () => new Response('missing', { status: 404 });
const board = () => new Response('<html>board</html>', { status: 200, headers: { ETag: '"x"', 'Content-Type': 'text/html' } });

describe('serveUnknownSearchCluster', () => {
  it.each([
    ['/cerca-lavoro-svizzera/ricerca-treno-lenzburg/', '/cerca-lavoro-svizzera/'],
    ['/en/find-jobs-switzerland/search-relax-bern/', '/en/find-jobs-switzerland/'],
    ['/de/jobs-in-schweiz/suche-senevita-wohlen/', '/de/jobs-in-schweiz/'],
    ['/fr/trouver-emploi-suisse/recherche-soudage-bulach-zurich/', '/fr/trouver-emploi-suisse/'],
    ['/en/find-jobs-ticino/search-manno-internship/', '/en/find-jobs-switzerland/'],
  ])('serves %s from the national board under noindex', async (pathname, boardPath) => {
    const dispatch = vi.fn(async () => board());
    const res = await serveUnknownSearchCluster(new Request(`${APEX}${pathname}`), notFound(), dispatch);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(res.headers.get('ETag')).toBeNull();
    expect(await res.text()).toBe('<html>board</html>');
    expect(new URL(dispatch.mock.calls[0][0].url).pathname).toBe(boardPath);
  });

  it.each([
    '/cerca-lavoro-svizzera/ricerca-/',
    '/en/find-jobs-switzerland/ricerca-wrong-locale/',
    '/cerca-lavoro-svizzera/search-wrong-locale/',
    '/cerca-lavoro-svizzera/azienda-ubs/',
    '/ricerca-senza-sezione/',
    '/cerca-lavoro-svizzera/ricerca-a/extra/',
    `/cerca-lavoro-svizzera/ricerca-${'a'.repeat(120)}/`,
  ])('leaves %s a real 404', async (pathname) => {
    const dispatch = vi.fn(async () => board());
    const res = await serveUnknownSearchCluster(new Request(`${APEX}${pathname}`), notFound(), dispatch);
    expect(res.status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the 404 when the board itself is unavailable', async () => {
    const res = await serveUnknownSearchCluster(
      new Request(`${APEX}/cerca-lavoro-svizzera/ricerca-a-b/`),
      notFound(),
      async () => new Response('', { status: 503 }),
    );
    expect(res.status).toBe(404);
  });

  it('does not touch a page that exists', async () => {
    const live = new Response('ok', { status: 200 });
    const dispatch = vi.fn();
    expect(await serveUnknownSearchCluster(new Request(`${APEX}/cerca-lavoro-svizzera/ricerca-a-b/`), live, dispatch)).toBe(live);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers a HEAD without a body', async () => {
    const res = await serveUnknownSearchCluster(
      new Request(`${APEX}/cerca-lavoro-svizzera/ricerca-a-b/`, { method: 'HEAD' }),
      notFound(),
      async () => board(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});
