import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/lib/jina-proxy.mjs', () => ({
  fetchViaJina: vi.fn(async () => ({ ok: true, text: async () => '<html>JINA-RECOVERED</html>' })),
}));

// @ts-expect-error — JS module without types
import { fetchHtml } from '../scripts/lib/crawler-template.mjs';

describe('fetchHtml egress proxy fallback', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
    vi.restoreAllMocks();
  });

  it('falls back to the Jina egress on a connection-level fetch failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as any;
    const html = await fetchHtml('https://example.test/jobs', { retries: 0 });
    expect(html).toContain('JINA-RECOVERED');
  });

  it('does NOT proxy a structural HTTP 404 (real error propagates)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as any;
    await expect(fetchHtml('https://example.test/jobs', { retries: 0 })).rejects.toThrow(/404/);
  });
});