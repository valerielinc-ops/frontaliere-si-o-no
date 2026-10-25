import { describe, expect, it } from 'vitest';
import { extractJobDetailPathsFromSitemapXml } from '../tests/e2e/lib/live-jobs';

const BASE = 'https://frontaliereticino.ch';

describe('live job sitemap discovery', () => {
  it('reads active TI details from the canonical job sitemap and ignores hubs', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>${BASE}/cerca-lavoro-ticino/tecnico-attivo</loc>
          <xhtml:link rel="alternate" hreflang="en" href="${BASE}/en/find-jobs-ticino/active-technician/" />
        </url>
        <url><loc>${BASE}/cerca-lavoro-ticino/azienda-acme/</loc></url>
        <url><loc>${BASE}/cerca-lavoro-zurigo/tecnico-zurigo/</loc></url>
      </urlset>`;

    expect(extractJobDetailPathsFromSitemapXml(xml)).toEqual([
      '/cerca-lavoro-ticino/tecnico-attivo/',
    ]);
  });

  it('rejects foreign-host sitemap URLs instead of probing them', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${BASE}/cerca-lavoro-ticino/locale-job/</loc></url>
      <url><loc>https://example.test/cerca-lavoro-ticino/foreign-job/</loc></url>
    </urlset>`;

    expect(extractJobDetailPathsFromSitemapXml(xml)).toEqual([
      '/cerca-lavoro-ticino/locale-job/',
    ]);
  });
});
