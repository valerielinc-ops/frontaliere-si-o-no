/**
 * Tests for the IndexNow batch submission URL-collection path.
 *
 * `extractUrls` + `getUrlsFromSitemaps` decide which URLs are submitted to
 * IndexNow (the "what gets indexed" funnel-critical path). The live dry-run
 * covers the happy path but not the fail-loud (abort) and empty-warn branches,
 * where a silent regression (regex break, abort not firing) would submit zero
 * URLs without a visible error. These tests pin that behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractUrls, getUrlsFromSitemaps } from '../scripts/submit-indexnow-batch.mjs';

// A fresh Response per call: a Response body is single-use, so reusing one
// object across the 6 sub-sitemap fetches would throw on the 2nd read and
// trip fetchSitemapXml's retry/sleep path (slow test, wrong branch).
const xmlResponder = (body: string) =>
  vi.fn().mockImplementation(() =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
  );

describe('extractUrls (happy path, XML fixture)', () => {
  it('extracts <loc> entries and hreflang alternates, de-duped into the accumulator', () => {
    const urls = new Set<string>();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset>
        <url>
          <loc>https://frontaliereticino.ch/lavoro</loc>
          <xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/jobs" />
          <xhtml:link rel="alternate" hreflang="de" href="https://frontaliereticino.ch/de/jobs" />
        </url>
        <url>
          <loc>https://frontaliereticino.ch/lavoro</loc>
        </url>
      </urlset>`;

    const count = extractUrls(xml, urls);

    // 4 raw entries matched (2 <loc> + 2 hreflang), but the duplicate <loc>
    // collapses to 3 unique URLs in the Set.
    expect(count).toBe(4);
    expect([...urls].sort()).toEqual([
      'https://frontaliereticino.ch/de/jobs',
      'https://frontaliereticino.ch/en/jobs',
      'https://frontaliereticino.ch/lavoro',
    ]);
  });

  it('returns 0 for a 200-OK sitemap with no <loc> entries', () => {
    const urls = new Set<string>();
    const count = extractUrls('<?xml version="1.0"?><urlset></urlset>', urls);
    expect(count).toBe(0);
    expect(urls.size).toBe(0);
  });
});

describe('getUrlsFromSitemaps (live mode branches)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts (exit 1) when any expected sub-sitemap fails to fetch', async () => {
    // Every sub-sitemap 404s → all land in `failed` → fail-loud abort, so a
    // partial fetch never silently drops a whole content type.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response('not found', { status: 404 })));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getUrlsFromSitemaps()).rejects.toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('warns (no abort) when a fetched sitemap returns 200 but zero URLs', async () => {
    // All sub-sitemaps 200-OK with an empty urlset → none `failed`, all `empty`
    // → loud warning but the run continues and still returns the extra key URLs.
    vi.stubGlobal('fetch', xmlResponder('<urlset></urlset>'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const urls = await getUrlsFromSitemaps();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('returned 200 but 0 URLs'));
    // EXTRA_URLS are still added even when every sitemap is empty.
    expect(urls).toContain('https://frontaliereticino.ch/');
  });

  it('returns sorted URLs on the happy path (all sitemaps populated)', async () => {
    vi.stubGlobal(
      'fetch',
      xmlResponder('<urlset><url><loc>https://frontaliereticino.ch/lavoro</loc></url></urlset>'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const urls = await getUrlsFromSitemaps();

    expect(urls).toContain('https://frontaliereticino.ch/lavoro');
    expect(urls).toContain('https://frontaliereticino.ch/');
    expect([...urls]).toEqual([...urls].sort());
  });
});
