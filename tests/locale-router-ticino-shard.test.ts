/**
 * Ticino-section shard routing of the Cloudflare locale-router Worker.
 *
 * The Ticino job section (the single largest subtree in the build) is carved out
 * to ONE Pages repo PER LOCALE (origin-ticino-<loc>.frontaliereticino.ch) — a
 * single combined repo would be ~16 GB, over the 10 GB Pages cap itself — so the
 * IT apex and the en/de/fr locale shards each stay under the cap. The Worker must:
 *   - route the IT prefix /cerca-lavoro-ticino/** to origin-ticino-it;
 *   - route the localized prefixes /en/find-jobs-ticino/**, /de/jobs-im-tessin/**,
 *     /fr/trouver-emploi-tessin/** to origin-ticino-{loc} (NOT origin-{loc}),
 *     which requires the Ticino check to run BEFORE the locale check;
 *   - leave every other path untouched: non-Ticino /en|/de|/fr → origin-{loc},
 *     non-Ticino IT → apex passthrough, and look-alikes (…-ticino-altro) → apex.
 *
 * Same lightweight harness as locale-router-stale-if-error: import the default
 * export and call fetch() directly, mocking `fetch` (to capture the upstream
 * Host) and the Cache API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const TICINO_ORIGIN = {
  it: 'origin-ticino-it.frontaliereticino.ch',
  en: 'origin-ticino-en.frontaliereticino.ch',
  de: 'origin-ticino-de.frontaliereticino.ch',
  fr: 'origin-ticino-fr.frontaliereticino.ch',
};

/** Capture the upstream host the Worker fetches for a given public path. */
let lastUpstreamHost: string | null;

beforeEach(() => {
  lastUpstreamHost = null;
  const cacheStore = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (req: Request) => {
      const key = typeof req === 'string' ? req : req.url;
      const hit = cacheStore.get(key);
      return hit ? hit.clone() : undefined;
    }),
    put: vi.fn(async (req: Request, res: Response) => {
      const key = typeof req === 'string' ? req : req.url;
      cacheStore.set(key, res.clone());
    }),
  };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    lastUpstreamHost = new URL(reqUrl).hostname;
    return new Response('<html>page</html>', { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('locale-router Ticino-section shard routing', () => {
  it('routes the IT Ticino prefix to origin-ticino-it', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/consulente-vendita-jumbo-sant-antonino-ticino-abc123/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamHost).toBe(TICINO_ORIGIN.it);
  });

  it('routes the IT Ticino section root to origin-ticino-it', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/`), {}, ctx);
    expect(lastUpstreamHost).toBe(TICINO_ORIGIN.it);
  });

  it('routes /en/find-jobs-ticino to origin-ticino-en, not origin-en', async () => {
    await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/some-job-zurich/`), {}, ctx);
    expect(lastUpstreamHost).toBe(TICINO_ORIGIN.en);
  });

  it('routes /de/jobs-im-tessin to origin-ticino-de', async () => {
    await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/irgendein-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(TICINO_ORIGIN.de);
  });

  it('routes /fr/trouver-emploi-tessin to origin-ticino-fr', async () => {
    await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/un-emploi/`), {}, ctx);
    expect(lastUpstreamHost).toBe(TICINO_ORIGIN.fr);
  });

  it('still routes a non-Ticino EN path to origin-en (regression guard)', async () => {
    await worker.fetch(new Request(`${APEX}/en/find-jobs-zurich/some-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe('origin-en.frontaliereticino.ch');
  });

  it('does NOT route a look-alike section to the Ticino shard', async () => {
    // /cerca-lavoro-ticino-altro must not match the Ticino prefix; as a non-locale
    // IT path it is an apex passthrough (upstream host stays the public apex).
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino-altro/x/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
  });

  it('leaves a non-Ticino IT path as an apex passthrough', async () => {
    await worker.fetch(new Request(`${APEX}/calcola-stipendio/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
  });

  it('serves the Ticino 200 happy path with public Cache-Control', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/some-slug/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    expect(await res.text()).toBe('<html>page</html>');
  });
});
