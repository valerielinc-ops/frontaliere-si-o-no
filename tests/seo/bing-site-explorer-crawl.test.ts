import { describe, expect, it } from 'vitest';

import {
  classifyDocument,
  extractInternalLinks,
  folderFor,
  normalizeUrl,
  parseSitemapDocument,
  partitionFor,
} from '../../scripts/seo/bing-site-explorer-crawl.mjs';
import { aggregateCrawlReports } from '../../scripts/seo/bing-site-explorer-report.mjs';

const BASE = 'https://frontaliereticino.ch';

describe('Bing-compatible full-tree crawler', () => {
  it('parses sitemap indexes and normalizes only page URLs to slash form', () => {
    const index = parseSitemapDocument('<sitemapindex><sitemap><loc>https://frontaliereticino.ch/sitemap-pages.xml</loc></sitemap></sitemapindex>', BASE);
    expect(index.kind).toBe('sitemapindex');
    expect(index.sitemapUrls).toEqual(['https://frontaliereticino.ch/sitemap-pages.xml']);
    const pages = parseSitemapDocument('<urlset><url><loc>https://frontaliereticino.ch/contattaci</loc></url><url><loc>/rss-it.xml</loc></url></urlset>', BASE);
    expect(pages.pageUrls).toEqual(['https://frontaliereticino.ch/contattaci/', 'https://frontaliereticino.ch/rss-it.xml']);
    expect(normalizeUrl('https://frontaliereticino.ch/articoli/?utm_source=x#top')).toBe('https://frontaliereticino.ch/articoli/?utm_source=x');
  });

  it('keeps root grouping and deterministic partition ownership stable', () => {
    const urls = [`${BASE}/`, `${BASE}/contattaci/`, `${BASE}/de/jobs-im-tessin/`, `${BASE}/articoli-frontaliere/test/`, `${BASE}/rss-it.xml`];
    expect(folderFor(urls[0])).toBe('/');
    expect(folderFor(urls[2])).toBe('/de/');
    expect(folderFor(urls[3])).toBe('/articoli-frontaliere/');
    expect([...new Set(urls.map((url) => partitionFor(url, 4)))].every((value) => value >= 0 && value < 4)).toBe(true);
    expect(partitionFor(urls[1], 4)).toBe(partitionFor(urls[1], 4));
  });

  it('classifies noindex, canonical drift, soft 404 and HTTP errors', () => {
    const noindex = classifyDocument({ url: `${BASE}/partner/`, status: 200, headers: new Headers({ 'x-robots-tag': 'noindex' }), html: '<title>Partner</title><link rel="canonical" href="https://frontaliereticino.ch/partner/"><meta name="robots" content="noindex">' });
    expect(noindex.findings.map((item) => item.code)).toContain('noindex-in-sitemap');
    const drift = classifyDocument({ url: `${BASE}/a/`, status: 200, html: '<title>A</title><link rel="canonical" href="https://frontaliereticino.ch/b/">' });
    expect(drift.findings.map((item) => item.code)).toContain('canonical-drift');
    const gone = classifyDocument({ url: `${BASE}/missing/`, status: 200, html: '<title>404 — Pagina non trovata</title><h1>Pagina non trovata</h1>' });
    expect(gone.findings.map((item) => item.code)).toContain('soft-404');
    expect(classifyDocument({ url: `${BASE}/missing/`, status: 404 }).findings[0].code).toBe('http-error');
  });

  it('extracts same-site HTML links without assets, externals or router actions', () => {
    const links = extractInternalLinks('<a href="/contattaci">Contatti</a><a href="/assets/app.js">asset</a><a href="https://example.com/">external</a><a href="nav:pension">bad</a>', `${BASE}/`, BASE);
    expect(links).toEqual(['https://frontaliereticino.ch/contattaci/']);
  });

  it('fails closed when a partition is missing or duplicated', () => {
    const base = (partition) => ({ schemaVersion: 1, baseUrl: BASE, manifestCount: 2, partition, partitions: 2, partitionTotal: 1, checkedCount: 1, codeCounts: {}, statusCounts: { 200: 1 }, folderStats: {}, findings: [], discoveredOutOfSitemap: [] });
    const summary = aggregateCrawlReports([base(0), base(0)], { manifestCount: 2, sitemapCount: 1, baseUrl: BASE });
    expect(summary.coverageOk).toBe(false);
    expect(summary.coverageErrors.join(' ')).toMatch(/duplicata|mancante|diversa/);
  });

  it('treats a partially unread sitemap graph as incomplete coverage', () => {
    const report = {
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: 1,
      partition: 0,
      partitions: 1,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: {},
      statusCounts: { 200: 1 },
      folderStats: {},
      findings: [],
      discoveredOutOfSitemap: [],
    };
    const summary = aggregateCrawlReports([report], {
      manifestCount: 1,
      sitemapCount: 1,
      errors: [{ url: `${BASE}/sitemap-extra.xml`, error: 'HTTP 503' }],
      baseUrl: BASE,
    });
    expect(summary.coverageOk).toBe(false);
    expect(summary.coverageErrors.join(' ')).toContain('sitemap non letto');
  });
});
