import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtmlViaJinaWithRetry } = vi.hoisted(() => ({
  fetchHtmlViaJinaWithRetry: vi.fn(),
}));
vi.mock('../scripts/lib/jina-proxy.mjs', async (importOriginal) => {
  // fetchHtml imports fetchHtmlViaJinaWithRetry from this module — stub it so we
  // test fetchHtml's gating/safe-fail wiring. The retry/validation logic of the
  // helper itself is covered by its own describe block below (real helper).
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtmlViaJinaWithRetry };
});

// @ts-expect-error — JS module without types
import { fetchHtml } from '../scripts/lib/crawler-template.mjs';

// A realistic target page body (>200 chars, no error markers) — passes detectJinaErrorBody.
const REAL_HTML = `<html><body><table>${'<tr><td class="jobTitle-column"><a href="/job/Lugano-Nurse/123456/">Nurse</a></td></tr>'.repeat(
  6,
)}</table></body></html>`;
const CHALLENGE_BODY = '<html><body>Just a moment...</body></html>';

describe('fetchHtml egress proxy fallback (gating + safe-fail)', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
    fetchHtmlViaJinaWithRetry.mockReset();
    vi.restoreAllMocks();
  });

  it('routes a connection-level fetch failure through the proxy helper', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    fetchHtmlViaJinaWithRetry.mockResolvedValue(REAL_HTML);
    const html = await fetchHtml('https://example.test/jobs', { retries: 0 });
    expect(html).toContain('/job/Lugano-Nurse/123456/');
    expect(fetchHtmlViaJinaWithRetry).toHaveBeenCalledOnce();
  });

  it('safe-fails (re-throws original) when the proxy helper returns null', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    fetchHtmlViaJinaWithRetry.mockResolvedValue(null);
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it('does NOT proxy a structural HTTP 404 (real error propagates)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as any;
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(/404/);
    expect(fetchHtmlViaJinaWithRetry).not.toHaveBeenCalled();
  });

  it('does NOT proxy a persistent (retryable) HTTP 503 — server responded, egress works', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })) as any;
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(/503/);
    expect(fetchHtmlViaJinaWithRetry).not.toHaveBeenCalled();
  });
});

describe('fetchHtmlViaJinaWithRetry', () => {
  const orig = global.fetch;
  let realHelper: (url: string, opts?: any) => Promise<string | null>;
  beforeAll(async () => {
    const actual = (await vi.importActual('../scripts/lib/jina-proxy.mjs')) as any;
    realHelper = actual.fetchHtmlViaJinaWithRetry;
  });
  beforeEach(() => {
    process.env.JOBS_JINA_RETRY_BASE_MS = '1'; // negligible backoff in tests
  });
  afterEach(() => {
    global.fetch = orig;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    vi.restoreAllMocks();
  });

  it('recovers when an earlier Jina egress IP was blocked (challenge → challenge → real)', async () => {
    // fetchViaJina uses global.fetch internally; each call simulates a different
    // Jina egress IP. First two are blocked (200 challenge), the third is clean.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => CHALLENGE_BODY })
      .mockResolvedValueOnce({ ok: true, text: async () => CHALLENGE_BODY })
      .mockResolvedValueOnce({ ok: true, text: async () => REAL_HTML });
    global.fetch = fetchMock as any;
    const html = await realHelper('https://example.test/jobs', { timeoutMs: 5000 });
    expect(html).toContain('/job/Lugano-Nurse/123456/');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null after exhausting retries on a persistently blocked egress', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => CHALLENGE_BODY })) as any;
    const html = await realHelper('https://example.test/jobs', { timeoutMs: 5000, retries: 2 });
    expect(html).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('returns null (not throw) when every proxy attempt errors', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    const html = await realHelper('https://example.test/jobs', { timeoutMs: 5000, retries: 1 });
    expect(html).toBeNull();
  });
});