import { describe, expect, it, vi } from 'vitest';
import { fetchViaMorssWithRetry, morssProxiedUrl } from '../scripts/lib/morss-proxy.mjs';

describe('Morss page proxy', () => {
  it('keeps the target URL and query intact under the page endpoint', () => {
    expect(morssProxiedUrl("https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4324")).toBe(
      "https://morss.it/:get=page/https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4324",
    );
    expect(morssProxiedUrl('file:///tmp/private.html')).toBe('');
  });

  it('retries a failed egress and returns a buffered response', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('<html>Ti.CH</html>', { status: 200 }));

    const response = await fetchViaMorssWithRetry('https://www.concorsi.ti.ch/', {
      fetchImpl,
      attempts: 2,
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response?.headers.get('x-frontaliere-egress')).toBe('morss');
    expect(await response?.text()).toBe('<html>Ti.CH</html>');
  });
});
