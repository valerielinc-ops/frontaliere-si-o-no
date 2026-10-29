import { describe, expect, it, vi } from 'vitest';
import {
  buildErrorSummary,
  loadArticleUrls,
  probe,
} from '../../scripts/canary-article-content.mjs';

const makeNoWait = () => vi.fn(async () => {});

describe('article-content canary live fetches', () => {
  it('retries a transient sitemap network error before parsing the sample', async () => {
    const sitemap = '<urlset><url><loc>https://frontaliereticino.ch/articoli-frontaliere/example/</loc></url></urlset>';
    const noWait = makeNoWait();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response(sitemap, { status: 200 }));

    await expect(loadArticleUrls({ fetchImpl, sleepImpl: noWait })).resolves.toEqual([
      'https://frontaliereticino.ch/articoli-frontaliere/example/',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx article response but keeps the final content checks', async () => {
    const url = 'https://frontaliereticino.ch/articoli-frontaliere/example/';
    const body = `<script src="/assets/index-test.js"></script>${'x'.repeat(5000)}`;
    const noWait = makeNoWait();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary outage', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

    await expect(probe(url, { fetchImpl, sleepImpl: noWait })).resolves.toMatchObject({
      url,
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a hard 4xx response', async () => {
    const noWait = makeNoWait();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));

    await expect(
      probe('https://frontaliereticino.ch/articoli-frontaliere/missing/', {
        fetchImpl,
        sleepImpl: noWait,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'HTTP 404' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noWait).not.toHaveBeenCalled();
  });

  it('serializes infrastructure failures for the JSON workflow artifact', () => {
    expect(buildErrorSummary(new Error('sitemap fetch 503'))).toMatchObject({
      sampleSize: 0,
      pass: 0,
      fail: 0,
      failures: [],
      error: 'sitemap fetch 503',
    });
  });
});
