/**
 * Canton-root-validity guard + its two consumers in the Cloudflare
 * locale-router Worker (#3015, follow-up of #3001's "Non implementato").
 *
 * Two soft-404 categories are upgraded to a real HTTP 301, both landing on the
 * canton section root — the same target public/404.html's JS already falls
 * back to:
 *   (a) recoverPrunedCompanyHub — a company-hub 404 whose locale prefix is
 *       ALREADY correct (nothing for recoverCrossLocaleCompanyPrefix to swap)
 *       but the hub itself is gone (pruned from the build).
 *   (b) recoverExpiredJobToCantonRoot — a job-detail 404 whose slug is not a
 *       canton-drift (absent from /job-canon entirely, not just under this
 *       locale) and does not match any more specific recovery.
 *
 * Both are gated by redirectTargetIsLive: the canton section is free-form
 * (no allowlist), so the Worker verifies the target actually resolves to 200
 * on the shard origin before emitting a permanent redirect — a miss/non-200
 * falls through to the pre-existing soft-404, never a 301-into-a-dead-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

/**
 * Mock fetch with three distinct behaviours (unlike the sibling test files'
 * single `originStatus`, this one differentiates the guard's section-root
 * check from the original request path — the whole point of this feature is
 * that they can disagree):
 *   - /job-canon/<sk>.json           -> `map` (200) or a miss (404)
 *   - exactly `guardedPath`           -> `guardStatus` (the section-root check)
 *   - anything else (the original request path) -> always 404 (gh-pages 404,
 *     since every test here exercises the 404-recovery branch)
 */
function mockFetch(
  guardedPath: string,
  guardStatus: number,
  map: Record<string, Record<string, string>> | null = null,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('/job-canon/')) {
      return map
        ? new Response(JSON.stringify(map), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }
    const { pathname } = new URL(u);
    if (pathname === guardedPath) {
      return new Response(guardStatus === 200 ? 'ok' : 'gh-pages-404', { status: guardStatus });
    }
    return new Response('gh-pages-404', { status: 404 });
  });
}

describe('locale-router canton-root-validity guard — pruned company hub (#3015a)', () => {
  it('301s an already-correct-prefix FR hub whose section root resolves 200', async () => {
    mockFetch('/fr/trouver-emploi-tessin/', 200);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/entreprise-globex-pruned/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/');
  });

  it('301s an already-correct-prefix DE hub whose section root resolves 200', async () => {
    mockFetch('/de/jobs-im-tessin/', 200);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/unternehmen-globex-pruned/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/');
  });

  it('falls through to soft 404 when the section root does NOT resolve (guard refuses)', async () => {
    mockFetch('/fr/trouver-emploi-blahblah/', 404);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-blahblah/entreprise-globex-pruned/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });

  it('preserves query string and hash on the 301', async () => {
    mockFetch('/en/find-jobs-zurich/', 200);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-zurich/company-globex-pruned/?utm_source=x#top`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/?utm_source=x#top');
  });

  it('still swaps a WRONG prefix (deterministic swap, unaffected by the guard) even when the guard would fail', async () => {
    // recoverCrossLocaleCompanyPrefix runs BEFORE recoverPrunedCompanyHub and is
    // not guarded (documented false positive — deterministic same-resource
    // swap, not a guess). A 404 on the swapped-prefix target must not matter:
    // this test proves the guard's introduction did not regress that path.
    mockFetch(`/fr/trouver-emploi-tessin/entreprise-globex/`, 404);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/azienda-globex/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/entreprise-globex/');
  });

  it('does not fire for a non-company-hub orphan slug (no false match)', async () => {
    mockFetch('/fr/trouver-emploi-tessin/', 200);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/developpeur-acme-lugano/`),
      {},
      ctx,
    );

    // Falls to recoverExpiredJobToCantonRoot instead (also guarded, also 200 here) —
    // this asserts the ORDER: a non-company slug never gets pinned to
    // recoverPrunedCompanyHub's company-only branch, it flows to the generic
    // job-detail fallback further down the chain.
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/');
  });
});

describe('locale-router canton-root-validity guard — expired job-detail slug (#3015b)', () => {
  it('301s a DE job-detail orphan (slug absent from job-canon) to a live section root', async () => {
    mockFetch('/de/jobs-im-tessin/', 200, null);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/expired-old-job-slug/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/');
  });

  it('301s an FR job-detail orphan (slug absent from job-canon) to a live section root', async () => {
    mockFetch('/fr/trouver-emploi-tessin/', 200, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/expired-old-job-slug/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/');
  });

  it('301s an EN job-detail orphan (slug absent from job-canon) to a live section root', async () => {
    mockFetch('/en/find-jobs-zurich/', 200, null);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-zurich/expired-old-job-slug/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/');
  });

  it('falls through to soft 404 when the section root does NOT resolve (guard refuses — no dead end)', async () => {
    mockFetch('/de/jobs-im-fakecanton/', 404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-fakecanton/expired-old-job-slug/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });

  it('preserves query string and hash on the 301', async () => {
    mockFetch('/de/jobs-im-tessin/', 200, null);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/expired-old-job-slug/?ref=email#section`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/?ref=email#section');
  });

  it('does not shadow a known canton-drift slug (map hit still wins, more specific)', async () => {
    // A slug present in /job-canon must still resolve via recoverCantonDriftOrphan
    // (its exact canonical page), never the generic section-root fallback — even
    // though the section root itself also resolves 200 in this test.
    mockFetch('/de/jobs-im-zuerich/', 200, {
      'known-job-xyz': { de: '/de/jobs-in-zurich' },
    });

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-zuerich/known-job-xyz/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-in-zurich/known-job-xyz/');
  });

  it('leaves a healthy 200 origin response untouched (no guard subrequest)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u.includes('/job-canon/')) return new Response('not found', { status: 404 });
      return new Response('ok', { status: 200 });
    });

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/some-live-job/`),
      {},
      ctx,
    );

    expect(res.status).toBe(200);
    const calls = fetchMock.mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });
});
