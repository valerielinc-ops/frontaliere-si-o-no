import { describe, it, expect } from 'vitest';
import {
  parseSitemapOfferUrls,
  parseSitemapIndexLocs,
  extractJobPostingLd,
} from '../scripts/lib/ukbb-job-parser.mjs';

/**
 * Regression coverage for issue #4699: the portal switched `sitemap.xml`
 * from a flat urlset to a `<sitemapindex>` pointing at `sitemap-jobs.xml`,
 * renamed offer URLs from `/offer/{slug}/{uuid}` to `/jobs/{slug}/{uuid}`,
 * and started emitting extra attributes on the JSON-LD `<script>` tag.
 */

describe('parseSitemapIndexLocs', () => {
  it('extracts child sitemap URLs from a sitemapindex document', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://jobs.ukbb.ch/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://jobs.ukbb.ch/sitemap-jobs.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemapIndexLocs(xml)).toEqual([
      'https://jobs.ukbb.ch/sitemap-pages.xml',
      'https://jobs.ukbb.ch/sitemap-jobs.xml',
    ]);
  });

  it('returns [] for a plain urlset (no index wrapper)', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://jobs.ukbb.ch/jobs/foo/abc</loc></url>
    </urlset>`;
    expect(parseSitemapIndexLocs(xml)).toEqual([]);
  });
});

describe('parseSitemapOfferUrls', () => {
  it('matches current /jobs/{slug}/{uuid} URLs', () => {
    const xml = `<urlset>
      <url><loc>https://jobs.ukbb.ch/jobs/terminkoordinator-in/0f5298d2-65a5-460c-831e-46a1761c5691</loc></url>
    </urlset>`;
    const offers = parseSitemapOfferUrls(xml);
    expect(offers).toHaveLength(1);
    expect(offers[0].uuid).toBe('0f5298d2-65a5-460c-831e-46a1761c5691');
  });

  it('still matches legacy /offer/{slug}/{uuid} URLs', () => {
    const xml = `<urlset>
      <url><loc>https://jobs.ukbb.ch/offer/oberarzt/1cb676e3-f106-43fa-b498-924913fd0aa5</loc></url>
    </urlset>`;
    const offers = parseSitemapOfferUrls(xml);
    expect(offers).toHaveLength(1);
    expect(offers[0].uuid).toBe('1cb676e3-f106-43fa-b498-924913fd0aa5');
  });

  it('dedupes by UUID and ignores non-offer locs', () => {
    const xml = `<urlset>
      <url><loc>https://jobs.ukbb.ch</loc></url>
      <url><loc>https://jobs.ukbb.ch/jobs/foo/32cb67ef-2767-46fe-9291-c3e157a0c537</loc></url>
      <url><loc>https://jobs.ukbb.ch/jobs/foo/32cb67ef-2767-46fe-9291-c3e157a0c537?utm=x</loc></url>
    </urlset>`;
    expect(parseSitemapOfferUrls(xml)).toHaveLength(1);
  });
});

describe('extractJobPostingLd', () => {
  it('extracts JobPosting from a @graph script tag carrying extra attributes', () => {
    const html = `<html><body>
      <script type="application/ld+json" data-nuxt-schema-org="true" data-hid="schema-org-graph">
        {"@context":"https://schema.org","@graph":[
          {"@type":"WebSite","name":"UKBB"},
          {"@type":"JobPosting","title":"Oberarzt*in Radiologie","datePosted":"2026-05-05"}
        ]}
      </script>
    </body></html>`;
    const ld = extractJobPostingLd(html);
    expect(ld?.title).toBe('Oberarzt*in Radiologie');
  });

  it('still matches a bare script tag with no extra attributes', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Foo"}</script>`;
    expect(extractJobPostingLd(html)?.title).toBe('Foo');
  });

  it('returns null when no JobPosting is present', () => {
    const html = `<script type="application/ld+json">{"@type":"WebSite","name":"UKBB"}</script>`;
    expect(extractJobPostingLd(html)).toBeNull();
  });
});
