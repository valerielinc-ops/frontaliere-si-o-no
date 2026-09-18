import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPostJobs } from '../scripts/update-postch-jobs.mjs';

describe('Post.ch national pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails when a repeated page does not add unique source records', async () => {
    const repeatedRecord = { id: 'post-1' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      totalJobs: 2,
      jobSearchResult: [{ response: repeatedRecord }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPostJobs()).rejects.toThrow(/repeated source identity|no unique progress/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
