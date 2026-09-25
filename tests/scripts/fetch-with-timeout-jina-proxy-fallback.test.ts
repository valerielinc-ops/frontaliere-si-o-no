import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #3797 recurrence (2026-07-07): fetchWithTimeout's JOBS_CRAWLER_FETCH_PROXY
// gated GET path used to `return` unconditionally on fetchViaJinaWithRetry's
// result, even when Jina had exhausted every retry and was still
// blocked/erroring. That silently lost the response with zero log trace —
// the caller's generic `if (!res.ok) continue` (shared by ~400 crawlers)
// swallowed it — and never attempted a direct (unproxied) fetch as a
// fallback, even though a plain direct fetch of the same URL worked fine in
// the very same CI run (confirmed via live reproduction). This covers the
// fix: a Jina failure now warns (diagnosable from CI output) and falls
// through to a genuine direct fetch of the original, non-proxied URL.
const { fetchViaJinaWithRetry } = vi.hoisted(() => ({
  fetchViaJinaWithRetry: vi.fn(),
}));

vi.mock('../../scripts/lib/jina-proxy.mjs', async (importOriginal) => {
  // Only fetchViaJinaWithRetry is stubbed — hostMatchesProxyList and
  // jinaProxiedRequest stay real so the env-var host-gating itself is
  // exercised, not assumed.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetchViaJinaWithRetry };
});

const { __testables } = await import('../../scripts/lib/shared-jobs-crawler.mjs');
const { fetchWithTimeout } = __testables;

const PROXY_HOST = 'cambiavalute.ch';
const TARGET_URL = `https://${PROXY_HOST}/annuncio-di-lavoro/test-job/`;

function jinaResponse(ok: boolean, opts: { status?: number; reason?: string } = {}) {
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 502),
    headers: new Headers(opts.reason ? { 'x-jina-retry-reason': opts.reason } : {}),
    text: async () => '<html>jina body</html>',
  };
}

describe('fetchWithTimeout — JOBS_CRAWLER_FETCH_PROXY Jina-exhaustion fallback (#3797)', () => {
  const origFetch = global.fetch;
  const origEnv = process.env.JOBS_CRAWLER_FETCH_PROXY;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.JOBS_CRAWLER_FETCH_PROXY = PROXY_HOST;
    fetchViaJinaWithRetry.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origEnv === undefined) delete process.env.JOBS_CRAWLER_FETCH_PROXY;
    else process.env.JOBS_CRAWLER_FETCH_PROXY = origEnv;
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('returns the Jina response directly on success, without attempting a direct fetch', async () => {
    fetchViaJinaWithRetry.mockResolvedValue(jinaResponse(true));
    global.fetch = vi.fn();
    const res = await fetchWithTimeout(TARGET_URL);
    expect(res.ok).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Real target pages are always well over detectJinaErrorBody's 200-char
  // short-body floor — pad with filler so this reads as genuine content, not
  // an accidental "too short" false-positive.
  const REAL_DIRECT_BODY = `<html><body>${'Real cambiavalute.ch job posting content. '.repeat(6)}</body></html>`;

  it('falls back to a genuine direct (unproxied) fetch when Jina is exhausted, and warns', async () => {
    fetchViaJinaWithRetry.mockResolvedValue(jinaResponse(false, { reason: 'all-egress-ips-blocked' }));
    global.fetch = vi.fn(async () => new Response(REAL_DIRECT_BODY, { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout(TARGET_URL);
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // The fallback must hit the plain, original URL — not a Jina-rewritten
    // target — or it would just re-hit the same exhausted proxy path.
    expect(calledUrl).toBe(TARGET_URL);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('all-egress-ips-blocked'));
  });

  // PR #3832 review finding (🔴): the direct-fetch fallback used to trust any
  // res.ok===true blindly. A CI datacenter IP can get the exact same sgcaptcha
  // WAF challenge cambiavalute.ch's Jina-blocked IPs get (#1363) — but as a
  // plain HTTP 200, so `!res.ok` never catches it. Must validate the body with
  // the same detector Jina's own retry path already uses before trusting it.
  it('treats a WAF challenge page on the direct-fetch fallback as a failed fetch, not real content', async () => {
    fetchViaJinaWithRetry.mockResolvedValue(jinaResponse(false, { reason: 'all-egress-ips-blocked' }));
    const challengeBody = `<html><body>${'Please wait while we verify your browser. sgcaptcha challenge. '.repeat(4)}</body></html>`;
    global.fetch = vi.fn(async () => new Response(challengeBody, { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout(TARGET_URL);
    expect(res.ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sgcaptcha'));
  });

  it('treats a suspiciously short direct-fetch fallback body as a failed fetch too', async () => {
    fetchViaJinaWithRetry.mockResolvedValue(jinaResponse(false, { reason: 'all-egress-ips-blocked' }));
    global.fetch = vi.fn(async () => new Response('<html>short</html>', { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout(TARGET_URL);
    expect(res.ok).toBe(false);
  });

  it('leaves fetch behavior untouched for hosts outside JOBS_CRAWLER_FETCH_PROXY', async () => {
    delete process.env.JOBS_CRAWLER_FETCH_PROXY;
    global.fetch = vi.fn(async () => new Response('<html>ok</html>', { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout('https://example.test/jobs');
    expect(res.ok).toBe(true);
    expect(fetchViaJinaWithRetry).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
