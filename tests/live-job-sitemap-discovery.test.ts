import { describe, expect, it } from 'vitest';
import { extractJobDetailPathsFromSitemapXml } from '../tests/e2e/lib/live-jobs';

const BASE = 'https://frontaliereticino.ch';

describe('live job sitemap discovery', () => {
  it('reads canonical candidates and leaves prefix-shaped slugs to HTML validation', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>${BASE}/cerca-lavoro-ticino/tecnico-attivo</loc>
          <xhtml:link rel="alternate" hreflang="en" href="${BASE}/en/find-jobs-ticino/active-technician/" />
        </url>
        <url><loc>${BASE}/cerca-lavoro-ticino/azienda-acme/</loc></url>
        <url><loc>${BASE}/cerca-lavoro-zurigo/tecnico-zurigo/</loc></url>
        <url><loc>${BASE}/de/jobs-in-zurich/techniker-zurich/</loc></url>
        <url><loc>${BASE}/de/jobs-in-zurich/unternehmen-acme/</loc></url>
      </urlset>`;

    expect(extractJobDetailPathsFromSitemapXml(xml)).toEqual([
      '/cerca-lavoro-ticino/azienda-acme/',
      '/cerca-lavoro-ticino/tecnico-attivo/',
      '/cerca-lavoro-zurigo/tecnico-zurigo/',
      '/de/jobs-in-zurich/techniker-zurich/',
      '/de/jobs-in-zurich/unternehmen-acme/',
    ]);
  });

  it('keeps a real job slug containing a reserved-looking prefix', () => {
    const xml = `<urlset><url><loc>${BASE}/cerca-lavoro-ticino/company-manager/</loc></url></urlset>`;
    expect(extractJobDetailPathsFromSitemapXml(xml)).toEqual([
      '/cerca-lavoro-ticino/company-manager/',
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
