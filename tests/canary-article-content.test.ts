import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFailureReport,
  fetchWithTimeout,
} from '../scripts/canary-article-content.mjs';

describe('article-content canary transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient fetch failure before returning the response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('<urlset />', { status: 200 }));

    const response = await fetchWithTimeout('https://frontaliereticino.ch/sitemap-blog.xml', {}, {
      retryBaseMs: 0,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serializes a fatal sitemap failure so the issue has an actionable cause', () => {
    expect(createFailureReport(new TypeError('fetch failed'), { timestamp: '2026-10-29T03:00:00.000Z' })).toEqual({
      site: 'https://frontaliereticino.ch',
      sampleSize: 0,
      pass: 0,
      fail: 1,
      failures: [{
        url: 'https://frontaliereticino.ch/sitemap-blog.xml',
        reason: 'sitemap fetch failed: fetch failed',
      }],
      timestamp: '2026-10-29T03:00:00.000Z',
    });
  });
});
