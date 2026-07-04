/**
 * jina-proxy — regression test per il rilevamento "200-but-not-target" della
 * proxy egress Jina (scripts/lib/jina-proxy.mjs, #1422 item 1).
 *
 * Jina risponde 200 anche quando NON ha raggiunto il target (pagina di
 * challenge/error, body vuoto): `res.ok` è true e il parser riceve una
 * non-job-page → 0 link/ruoli → skip silenzioso indistinguibile da "sorgente
 * vuota". `detectJinaErrorBody` deve segnalare il body sospetto (per un warning
 * esplicito) senza falsi positivi su una pagina target reale.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { detectJinaErrorBody, fetchViaJinaWithRetry, fetchHtmlViaJinaWithRetry, jinaBreakerOpen, looksLikeAntiBotChallenge, rescueHtmlIfChallenged, __resetJinaBreaker } from '../scripts/lib/jina-proxy.mjs';

describe('detectJinaErrorBody', () => {
  it('flags an empty / whitespace-only body', () => {
    expect(detectJinaErrorBody('')).toBe('empty body');
    expect(detectJinaErrorBody('   \n\t  ')).toBe('empty body');
    expect(detectJinaErrorBody(null)).toBe('empty body');
    expect(detectJinaErrorBody(undefined)).toBe('empty body');
  });

  it('flags a suspiciously short body', () => {
    const reason = detectJinaErrorBody('<html><body>nope</body></html>');
    expect(reason).toMatch(/body too short/);
  });

  it('flags a Jina failure-to-fetch envelope', () => {
    const body = `<html><body>Failed to fetch the target URL after 3 attempts. ${'x'.repeat(300)}</body></html>`;
    expect(detectJinaErrorBody(body)).toMatch(/error\/challenge marker/);
  });

  it('flags a WAF/anti-bot challenge page served on a 200', () => {
    const body = `<!doctype html><title>Just a moment...</title><body>Checking your browser before accessing the site. ${'x'.repeat(300)}</body>`;
    expect(detectJinaErrorBody(body)).toMatch(/error\/challenge marker/);
  });

  it('returns null for a genuine target page', () => {
    const realPage = `<!doctype html><html><head><title>Opportunities</title></head><body>` +
      `<h2 class="wp-block-heading">Frontend Developer</h2>` +
      `<p>We are hiring a frontend developer to join our team in Lugano. ${'job description '.repeat(40)}</p>` +
      `</body></html>`;
    expect(detectJinaErrorBody(realPage)).toBeNull();
  });

  it('respects a custom minLength floor', () => {
    const body = `<html><body>${'x'.repeat(120)}</body></html>`;
    expect(detectJinaErrorBody(body, { minLength: 100 })).toBeNull();
    expect(detectJinaErrorBody(body, { minLength: 500 })).toMatch(/body too short/);
  });

  it('flags a SiteGround sgcaptcha IP-reputation challenge even when long', () => {
    // The challenge a blocked egress IP gets on a 200 — padded past the too-short
    // floor so this proves the explicit marker (not just the length heuristic).
    const body =
      `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fcareer-sitemap.xml&y=ipr:34.96.49.15">` +
      `</head><body>${'x'.repeat(400)}</body></html>`;
    expect(detectJinaErrorBody(body)).toMatch(/error\/challenge marker/);
  });
});

describe('fetchViaJinaWithRetry', () => {
  // Padded past detectJinaErrorBody's too-short floor so these tests exercise the
  // explicit `sgcaptcha` marker (not the length heuristic) — a long real challenge
  // variant, which is exactly what the marker exists to catch. (The short form
  // was caught only by "body too short", so the exhaustion assertion below — which
  // checks for the marker reason specifically — needs the marker to fire.)
  const SGCAPTCHA =
    `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?y=ipr:34.96.49.15"></head>` +
    `<body>${'x'.repeat(400)}</body></html>`;
  const REAL_SITEMAP =
    `<html><body>` +
    `<a href="https://cambiavalute.ch/annuncio-di-lavoro/legal-compliance-officer/">job</a>` +
    `<a href="https://cambiavalute.ch/annuncio-di-lavoro/sales-marketing-mercato-tedesco/">job</a>` +
    `${'real sitemap content '.repeat(20)}</body></html>`;

  it('retries on a fresh Jina IP when a 200 challenge is returned, then returns the clean page', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      // First two attempts land on blocked IPs (challenge), third is clean.
      return new Response(calls < 3 ? SGCAPTCHA : REAL_SITEMAP, { status: 200 });
    };
    const res = await fetchViaJinaWithRetry('https://cambiavalute.ch/career-sitemap.xml', {
      attempts: 4,
      retryDelayMs: 0,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
    const body = await res.text();
    expect(body).toContain('legal-compliance-officer');
    expect(detectJinaErrorBody(body)).toBeNull();
  });

  it('returns the last response shape (no throw) when every attempt is blocked', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(SGCAPTCHA, { status: 200 });
    };
    const res = await fetchViaJinaWithRetry('https://cambiavalute.ch/career-sitemap.xml', {
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl,
    });
    expect(calls).toBe(3);
    // Graceful: caller's existing detectJinaErrorBody warning + skip path runs.
    expect(detectJinaErrorBody(await res.text())).toMatch(/error\/challenge marker/);
  });

  it('retries (and cancels the body) on a Jina non-2xx, then returns the clean page', async () => {
    let calls = 0;
    let drained = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        // 429 from Jina rate-limit — body must be cancelled (socket reclaimed)
        // before the next attempt, without reading it unbounded.
        const r = new Response('rate limited', { status: 429 });
        const stream = r.body;
        if (stream) {
          const origCancel = stream.cancel.bind(stream);
          stream.cancel = async (reason?: unknown) => { drained += 1; return origCancel(reason); };
        }
        return r;
      }
      return new Response(REAL_SITEMAP, { status: 200 });
    };
    const res = await fetchViaJinaWithRetry('https://cambiavalute.ch/career-sitemap.xml', {
      attempts: 4,
      retryDelayMs: 0,
      fetchImpl,
    });
    expect(calls).toBe(3);
    expect(drained).toBe(2); // both 429 bodies cancelled
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('legal-compliance-officer');
  });

  it('returns immediately on a clean first attempt (no wasted retries)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(REAL_SITEMAP, { status: 200 });
    };
    const res = await fetchViaJinaWithRetry('https://cambiavalute.ch/career-sitemap.xml', {
      attempts: 4,
      retryDelayMs: 0,
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(res.ok).toBe(true);
  });
});

describe('looksLikeAntiBotChallenge', () => {
  it('flags WAF challenge banners (sgcaptcha, Cloudflare, Incapsula)', () => {
    expect(looksLikeAntiBotChallenge('<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?y=ipr:1.2.3.4">')).toBe(true);
    expect(looksLikeAntiBotChallenge('<title>Just a moment...</title>')).toBe(true);
    expect(looksLikeAntiBotChallenge('<h1>Attention Required!</h1> Cloudflare')).toBe(true);
    expect(looksLikeAntiBotChallenge('Checking your browser before accessing the site.')).toBe(true);
    expect(looksLikeAntiBotChallenge('window.__CF$cv$params; cf_chl_opt')).toBe(true);
    expect(looksLikeAntiBotChallenge('<script>_Incapsula_Resource</script>')).toBe(true);
  });

  it('does NOT flag a genuine jobs page (marker-only, no length heuristic)', () => {
    // A real (even short) jobs page must pass through — this is what makes it safe
    // to run on EVERY successful fetch across all crawlers.
    expect(looksLikeAntiBotChallenge('<h1>Offene Stellen</h1><a href="/job/1">Pflegefachperson HF</a>')).toBe(false);
    expect(looksLikeAntiBotChallenge('')).toBe(false);
    expect(looksLikeAntiBotChallenge(null)).toBe(false);
    expect(looksLikeAntiBotChallenge('Posizioni aperte: nessuna al momento.')).toBe(false);
  });
});

describe('rescueHtmlIfChallenged', () => {
  it('returns a genuine page unchanged without any network call', async () => {
    const genuine = '<html><body><h1>Stellenangebote</h1><a href="/job/42">Kardiologe</a></body></html>';
    // No fetch stub installed — if it tried to hit the network the test env would
    // fail; passing proves the genuine-page fast path never calls Jina.
    const out = await rescueHtmlIfChallenged(genuine, 'https://example.ch/jobs', { timeoutMs: 1000 });
    expect(out).toBe(genuine);
  });
});

describe('Jina egress circuit breaker (#1461 item 2)', () => {
  // Under a broad egress outage every URL fails connection-level and routes
  // through a Jina retry helper; without a breaker each pays (retries+1) ×
  // timeoutMs + backoff, piling latency that can blow the job timeout. The
  // breaker fast-fails after N consecutive exhaustions; a success resets it.
  const CHALLENGE = `<html><body>Just a moment... ${'x'.repeat(300)}</body></html>`;
  const REAL = `<html><body>${'<a href="/job/Lugano-Nurse/1/">Nurse</a>'.repeat(6)} ${'x'.repeat(200)}</body></html>`;
  const origFetch = global.fetch;

  beforeEach(() => {
    __resetJinaBreaker();
    process.env.JOBS_JINA_RETRY_BASE_MS = '1'; // negligible backoff in tests
  });
  afterEach(() => {
    global.fetch = origFetch;
    __resetJinaBreaker();
    delete process.env.JOBS_JINA_BREAKER_THRESHOLD;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    vi.restoreAllMocks();
  });

  it('trips after N consecutive fetchHtml exhaustions, then fast-fails with no attempt', async () => {
    process.env.JOBS_JINA_BREAKER_THRESHOLD = '3';
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => CHALLENGE }));
    global.fetch = fetchMock as any;

    // 3 exhausting calls (retries:0 → 1 attempt each) push the counter to 3.
    for (let i = 0; i < 3; i += 1) {
      expect(await fetchHtmlViaJinaWithRetry('https://example.test/jobs', { timeoutMs: 50, retries: 0 } as any)).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jinaBreakerOpen()).toBe(true);

    // 4th call: breaker open → fast-fail, NO new fetch attempt.
    expect(await fetchHtmlViaJinaWithRetry('https://example.test/jobs', { timeoutMs: 50, retries: 0 } as any)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resets the counter on a successful rescue (sprinkled flakiness never trips)', async () => {
    process.env.JOBS_JINA_BREAKER_THRESHOLD = '2';
    // exhaust, success, exhaust, success, exhaust — never 2 consecutive failures.
    const bodies = [CHALLENGE, REAL, CHALLENGE, REAL, CHALLENGE];
    let i = 0;
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => bodies[i++] })) as any;
    for (const expectNull of [true, false, true, false, true]) {
      const html = await fetchHtmlViaJinaWithRetry('https://example.test/jobs', { timeoutMs: 50, retries: 0 } as any);
      expect(html === null).toBe(expectNull);
    }
    expect(jinaBreakerOpen()).toBe(false);
  });

  it('shares one breaker across fetchHtmlViaJinaWithRetry and fetchViaJinaWithRetry', async () => {
    process.env.JOBS_JINA_BREAKER_THRESHOLD = '2';
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => CHALLENGE })) as any;
    // One exhaustion from each helper → counter reaches 2.
    expect(await fetchHtmlViaJinaWithRetry('https://example.test/a', { timeoutMs: 50, retries: 0 } as any)).toBeNull();
    const blockedFetch = vi.fn(async () => new Response(CHALLENGE, { status: 200 }));
    const r1 = await fetchViaJinaWithRetry('https://example.test/b', { attempts: 1, retryDelayMs: 0, fetchImpl: blockedFetch });
    expect(detectJinaErrorBody(await r1.text())).toMatch(/error\/challenge marker/);
    expect(jinaBreakerOpen()).toBe(true);

    // Breaker open: fetchViaJinaWithRetry fast-fails with the exhausted shape, no fetch.
    blockedFetch.mockClear();
    const r2 = await fetchViaJinaWithRetry('https://example.test/c', { attempts: 4, retryDelayMs: 0, fetchImpl: blockedFetch });
    expect(blockedFetch).not.toHaveBeenCalled();
    expect(r2.status).toBe(502);
    expect(r2.headers.get('x-jina-retry-reason')).toBe('circuit-breaker-open');
  });

  it('threshold 0 disables the breaker (never trips)', async () => {
    process.env.JOBS_JINA_BREAKER_THRESHOLD = '0';
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => CHALLENGE }));
    global.fetch = fetchMock as any;
    for (let i = 0; i < 12; i += 1) {
      expect(await fetchHtmlViaJinaWithRetry('https://example.test/jobs', { timeoutMs: 50, retries: 0 } as any)).toBeNull();
    }
    expect(jinaBreakerOpen()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});

describe('JOBS_JINA_RETRIES / JOBS_JINA_RETRY_BASE_MS env override (falsy-zero regression)', () => {
  // `Number(env) || fallback` silently discards an explicit '0' (0 is falsy),
  // so JOBS_JINA_RETRIES=0 used to still run the default 2 retries (3 attempts
  // total). Discovered while wiring a deterministic env-based test elsewhere
  // (Pfister crawler #3342 round 2) — the override had no effect.
  const origFetch = global.fetch;

  beforeEach(() => {
    __resetJinaBreaker();
  });
  afterEach(() => {
    global.fetch = origFetch;
    __resetJinaBreaker();
    delete process.env.JOBS_JINA_RETRIES;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    vi.restoreAllMocks();
  });

  it('honors JOBS_JINA_RETRIES=0 (exactly 1 attempt, no retries)', async () => {
    process.env.JOBS_JINA_RETRIES = '0';
    process.env.JOBS_JINA_RETRY_BASE_MS = '0';
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as any;

    const html = await fetchHtmlViaJinaWithRetry('https://example.test/jobs', { timeoutMs: 50 } as any);

    expect(html).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
