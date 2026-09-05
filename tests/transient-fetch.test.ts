import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isTransientFetchError,
  isConnectionLevelFetchError,
  fetchWithRetry,
  httpFetchWithRetry,
  RETRYABLE_STATUS,
  transportErrorKind,
  TLS_ERROR_CODES,
} from '../scripts/lib/transient-fetch.mjs';

const mkResponse = (status: number) =>
  ({ ok: status >= 200 && status < 300, status, statusText: `S${status}` }) as Response;

describe('isTransientFetchError', () => {
  it('classifies node "fetch failed" TypeError as transient', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies SuccessFactors-style wrapped network error as transient', () => {
    // The SF client re-throws as a generic Error losing the TypeError name.
    const err = new Error('SuccessFactors network error: fetch failed');
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies Playwright navigation timeout as transient', () => {
    const err = new Error('page.goto: Timeout 60000ms exceeded.');
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies AbortError (our own timeout) as transient', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isTransientFetchError(err)).toBe(true);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('classifies retryable status %i as transient', (status) => {
    expect(RETRYABLE_STATUS.has(status)).toBe(true);
    expect(isTransientFetchError({ status })).toBe(true);
  });

  it.each([400, 401, 403, 404, 410])('does NOT classify persistent status %i as transient', (status) => {
    expect(RETRYABLE_STATUS.has(status)).toBe(false);
    expect(isTransientFetchError({ status })).toBe(false);
  });

  it('does NOT classify a generic 404 message as transient', () => {
    expect(isTransientFetchError(new Error('HTTP 404 from https://x.test'))).toBe(false);
  });

  it('honours an explicit retryable=true tag', () => {
    expect(isTransientFetchError(Object.assign(new Error('whatever'), { retryable: true }))).toBe(true);
  });

  it('pins the literal Node wording used by the substring fallback (#7093)', () => {
    // No `.code`/`.cause` at all — this isolates the message-substring
    // fallback (as opposed to the `code`-based checks above, which win first
    // whenever a `.cause.code`/`.code` is present). If Node/undici ever
    // changes this exact wording, THIS test — not just the regex — must be
    // updated in the same change, so a silent drift fails loud here instead
    // of quietly de-classifying every "fetch failed" as non-transient.
    const err = new TypeError('fetch failed');
    expect(err.cause).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('lets a wrapped DNS policy rejection override TypeError fetch-failed', () => {
    const policy = Object.assign(new Error('unsafe prospector DNS target: x.test'), {
      code: 'ERR_PUBLIC_FETCH_POLICY',
      retryable: false,
    });
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connector error'), { cause: policy }),
    });
    expect(isTransientFetchError(wrapped)).toBe(false);
  });
});

describe('isConnectionLevelFetchError (Jina egress fallback gate)', () => {
  it('classifies a node "fetch failed" network error as connection-level', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isConnectionLevelFetchError(err)).toBe(true);
  });

  it('classifies an AbortError (our own timeout) as connection-level', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isConnectionLevelFetchError(err)).toBe(true);
  });

  it.each([500, 502, 503, 504, 429, 408, 425])(
    'does NOT classify a retryable HTTP %i (server responded) as connection-level',
    (status) => {
      // Even though these are transient/retryable, the server WAS reached → the
      // egress works → the Jina fallback must NOT fire on them.
      const err = Object.assign(new Error(`HTTP ${status} from https://x.test`), {
        status,
        retryable: true,
      });
      expect(isTransientFetchError(err)).toBe(true);
      expect(isConnectionLevelFetchError(err)).toBe(false);
    },
  );

  it.each([400, 403, 404])('does NOT classify a persistent HTTP %i as connection-level', (status) => {
    expect(isConnectionLevelFetchError({ status })).toBe(false);
  });

  it('returns false for nullish input', () => {
    expect(isConnectionLevelFetchError(null)).toBe(false);
    expect(isConnectionLevelFetchError(undefined)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const result = await fetchWithRetry(attempt, { retryBaseMs: 0 });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a persistent (404-like) error', async () => {
    const attempt = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }));
    await expect(fetchWithRetry(attempt, { retryBaseMs: 0 })).rejects.toThrow(/404/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an Undici-wrapped DNS policy rejection', async () => {
    const policy = Object.assign(new Error('unsafe prospector DNS target: x.test'), {
      code: 'ERR_PUBLIC_FETCH_POLICY',
      retryable: false,
    });
    const attempt = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: policy }));
    await expect(fetchWithRetry(attempt, { retries: 4, retryBaseMs: 0 })).rejects.toThrow(/fetch failed/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries then throws the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithRetry(attempt, { retries: 2, retryBaseMs: 0 })).rejects.toThrow(/fetch failed/);
    expect(attempt).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('supports a custom isTransient predicate', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('weird-but-retryable'));
    await expect(
      fetchWithRetry(attempt, { retries: 1, retryBaseMs: 0, isTransient: () => true }),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('httpFetchWithRetry', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('retries a transient network throw then returns the Response', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
      )
      .mockResolvedValueOnce(mkResponse(200)) as unknown as typeof fetch;
    const res = await httpFetchWithRetry('https://x.test', {}, { retryBaseMs: 0 });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a retryable HTTP status (503) then returns the recovered Response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mkResponse(503))
      .mockResolvedValueOnce(mkResponse(200)) as unknown as typeof fetch;
    const res = await httpFetchWithRetry('https://x.test', {}, { retryBaseMs: 0 });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the final retryable Response (no throw) after exhausting retries', async () => {
    global.fetch = vi.fn().mockResolvedValue(mkResponse(503)) as unknown as typeof fetch;
    // Caller keeps its own res.ok handling — the helper must hand back the
    // Response rather than throwing so graceful-degradation paths run.
    const res = await httpFetchWithRetry('https://x.test', {}, { retries: 2, retryBaseMs: 0 });
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('does NOT retry a persistent non-ok status (404) and returns it once', async () => {
    global.fetch = vi.fn().mockResolvedValue(mkResponse(404)) as unknown as typeof fetch;
    const res = await httpFetchWithRetry('https://x.test', {}, { retryBaseMs: 0 });
    expect(res.status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a 2xx Response on the first try without retrying', async () => {
    global.fetch = vi.fn().mockResolvedValue(mkResponse(200)) as unknown as typeof fetch;
    const res = await httpFetchWithRetry('https://x.test', {}, { retryBaseMs: 0 });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('clears the connection-phase timer once headers arrive (body read not aborted)', async () => {
    // Regression: the helper must bound only the connection/header phase, not
    // the body read. An `AbortSignal.timeout` left armed through `.arrayBuffer()`
    // on a multi-MB BAG ZIP/XLSX would abort mid-stream → AbortError outside the
    // caller's try/catch → run crash (the very failure this helper prevents).
    let captured: AbortSignal | undefined;
    global.fetch = vi.fn((_url: unknown, options: { signal?: AbortSignal } = {}) => {
      captured = options.signal;
      return Promise.resolve(mkResponse(200));
    }) as unknown as typeof fetch;
    const res = await httpFetchWithRetry('https://x.test', {}, { timeout: 10, retryBaseMs: 0 });
    expect(res.status).toBe(200);
    // Wait past the 10ms connection-phase timeout. Because the timer was cleared
    // the instant headers arrived, the request signal must NOT abort — a slow
    // body read would survive instead of throwing AbortError.
    await new Promise((r) => setTimeout(r, 40));
    expect(captured?.aborted ?? false).toBe(false);
  });
});

describe('transportErrorKind — a failure with no status still names its cause', () => {
  // #7351: `isTransientFetchError` above answers «retry?»; this answers «what
  // happened?». Every network failure used to collapse into one bucket named
  // after the layer, so 65 of 120 source-detail failures were unactionable.
  const wrapped = (code: string) => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });

  it('reads the code through the fetch wrapper', () => {
    expect(transportErrorKind(wrapped('ENOTFOUND'))).toBe('dns');
    expect(transportErrorKind(wrapped('EAI_AGAIN'))).toBe('dns');
    expect(transportErrorKind(wrapped('ECONNRESET'))).toBe('reset');
    expect(transportErrorKind(wrapped('ECONNREFUSED'))).toBe('refused');
    expect(transportErrorKind(wrapped('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
  });

  it('names every TLS code the http fallback downgrades on', () => {
    // The set has one home now: mcdonalds-job-parser.mjs downgrades to http on
    // exactly these, and this classifier must call all of them `tls` — two
    // copies of the list would drift on the first code added to one of them.
    for (const code of TLS_ERROR_CODES) {
      expect(transportErrorKind(wrapped(code)), code).toBe('tls');
    }
  });

  it('an aborted request is a timeout, whatever the code says', () => {
    expect(transportErrorKind(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('timeout');
  });

  it('does not guess — an unrecognised failure says so', () => {
    expect(transportErrorKind(new Error('something else'))).toBe('other');
    expect(transportErrorKind(null)).toBe('other');
  });

  it('survives a self-referential cause chain', () => {
    const loop: any = new Error('loop');
    loop.cause = loop;
    expect(transportErrorKind(loop)).toBe('other');
  });
});
