import { describe, expect, it, vi } from 'vitest';
import { fetchTichJobDetailUrls } from '../scripts/update-tich-jobs.mjs';

const LISTING_URL = 'https://www.concorsi.ti.ch/';
const RSS_URL = 'https://www.concorsi.ti.ch/rss_generator-rss0.php?unit=act&lang=it';

const listingHtml = `<!doctype html>
<html>
  <head><title>Amministrazione Cantonale Ticino Jobportal</title></head>
  <body><div class="jobsearch">
    <a href="/offerte-d'impieghi.html?yid=4101&amp;sid=transient">Offerta</a>
  </div></body>
</html>`;

const rssXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Amministrazione Cantonale Ticino Jobportal</title>
</feed>`;

describe('fetchTichJobDetailUrls', () => {
  it('retries a transient discovery failure before falling back to the RSS source', async () => {
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (url: string) => {
      const attempt = (attempts.get(url) || 0) + 1;
      attempts.set(url, attempt);

      if (url === LISTING_URL && attempt === 1) {
        throw new TypeError('fetch failed');
      }
      if (url === LISTING_URL) return new Response(listingHtml, { status: 200 });
      if (url === RSS_URL) return new Response(rssXml, { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await fetchTichJobDetailUrls({
      fetchImpl,
      retries: 1,
      retryBaseMs: 0,
      timeoutMs: 1_000,
    });

    expect(result.listingSucceeded).toBe(true);
    expect(result.rssSucceeded).toBe(true);
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4101",
    ]);
    expect(attempts.get(LISTING_URL)).toBe(2);
    expect(attempts.get(RSS_URL)).toBe(1);
  });
});
