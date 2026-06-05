import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchViaJina } = vi.hoisted(() => ({ fetchViaJina: vi.fn() }));
vi.mock('../scripts/lib/jina-proxy.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchViaJina };
});

// @ts-expect-error — JS module without types
import { fetchHtml } from '../scripts/lib/crawler-template.mjs';

// A realistic target page body (>200 chars, no error markers) — passes detectJinaErrorBody.
const REAL_HTML = `<html><body><table>${'<tr><td class="jobTitle-column"><a href="/job/Lugano-Nurse/123456/">Nurse</a></td></tr>'.repeat(
  6,
)}</table></body></html>`;

describe('fetchHtml egress proxy fallback', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
    fetchViaJina.mockReset();
    vi.restoreAllMocks();
  });

  it('falls back to the Jina egress on a connection-level fetch failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    fetchViaJina.mockResolvedValue({ ok: true, text: async () => REAL_HTML });
    const html = await fetchHtml('https://example.test/jobs', { retries: 0 });
    expect(html).toContain('/job/Lugano-Nurse/123456/');
    expect(fetchViaJina).toHaveBeenCalledOnce();
  });

  it('safe-fails (re-throws original) when Jina returns a 200 challenge/empty body', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    // Jina 200 but the body is a Cloudflare challenge — not the target page.
    fetchViaJina.mockResolvedValue({
      ok: true,
      text: async () => '<html><body>Just a moment...</body></html>',
    });
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it('re-throws the ORIGINAL error when the Jina fetch itself throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    fetchViaJina.mockRejectedValue(new Error('jina abort'));
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it('does NOT proxy a structural HTTP 404 (real error propagates)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as any;
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(/404/);
    expect(fetchViaJina).not.toHaveBeenCalled();
  });
});