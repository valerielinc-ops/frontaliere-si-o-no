import { describe, expect, it } from 'vitest';

import {
  classifyDocument,
  collectSitemapInventory,
  crawlPartition,
  extractInternalLinks,
  folderFor,
  normalizeUrl,
  parseSitemapDocument,
  partitionFor,
} from '../../scripts/seo/bing-site-explorer-crawl.mjs';
import {
  aggregateCrawlReports,
  buildIssueBody,
  rescueTransientReports,
} from '../../scripts/seo/bing-site-explorer-report.mjs';

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

    const expectedJobConsolidation = classifyDocument({
      url: `${BASE}/en/find-jobs-geneva/a/`,
      status: 200,
      html: '<title>A</title><link rel="canonical" href="https://frontaliereticino.ch/en/find-jobs-geneva/b/">',
    });
    expect(expectedJobConsolidation.findings.map((item) => item.code)).toContain('canonical-expected');
    expect(expectedJobConsolidation.findings.map((item) => item.code)).not.toContain('canonical-drift');

    const expectedPreviousSlugBridge = classifyDocument({
      url: `${BASE}/blog/vecchio-slug/`,
      status: 200,
      html: '<title>Archivio</title><link rel="canonical" href="https://frontaliereticino.ch/blog/nuovo-slug/"><script>__BRIDGE_TARGET_SLUG__</script>',
    });
    expect(expectedPreviousSlugBridge.findings.map((item) => item.code)).toContain('canonical-expected');

    const thinBridge = classifyDocument({
      url: `${BASE}/blog/legacy/`,
      status: 200,
      html: '<title>Archivio</title><link rel="canonical" href="https://frontaliereticino.ch/blog/current/"><p>Versione canonica disponibile</p>',
    });
    expect(thinBridge.findings.map((item) => item.code)).toContain('canonical-drift');

    const gone = classifyDocument({ url: `${BASE}/missing/`, status: 200, html: '<title>404 — Pagina non trovata</title><h1>Pagina non trovata</h1>' });
    expect(gone.findings.map((item) => item.code)).toContain('soft-404');
    expect(classifyDocument({ url: `${BASE}/missing/`, status: 404 }).findings[0].code).toBe('http-error');
    const emptyCanonical = classifyDocument({ url: `${BASE}/empty-canonical/`, status: 200, html: '<title>Page</title><link rel="canonical">' });
    expect(emptyCanonical.findings.map((item) => item.code)).toContain('canonical-missing');
    const minified = classifyDocument({
      url: `${BASE}/minified/`,
      status: 200,
      html: '<title>Minified</title><link rel=canonical href="https://frontaliereticino.ch/minified/"><meta name=robots content=noindex>',
    });
    expect(minified.canonical).toBe(`${BASE}/minified/`);
    expect(minified.findings.map((item) => item.code)).toContain('noindex-in-sitemap');
    expect(minified.findings.map((item) => item.code)).not.toContain('canonical-missing');

    const pdf = classifyDocument({
      url: `${BASE}/guide.pdf`,
      status: 200,
      contentType: 'application/pdf',
      html: '%PDF-1.3',
    });
    expect(pdf.findings).toEqual([]);

    const nonHtmlNoindex = classifyDocument({
      url: `${BASE}/private.pdf`,
      status: 200,
      contentType: 'application/pdf',
      headers: new Headers({ 'x-robots-tag': 'noindex' }),
    });
    expect(nonHtmlNoindex.findings.map((item) => item.code)).toContain('noindex-in-sitemap');
  });

  it('keeps expected canonical consolidations out of the actionable issue body', () => {
    const expectedUrl = `${BASE}/blog/vecchio-slug/`;
    const driftUrl = `${BASE}/blog/old/`;
    const report = {
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: 2,
      partition: 0,
      partitions: 1,
      partitionTotal: 2,
      checkedCount: 2,
      codeCounts: { 'canonical-expected': 1, 'canonical-drift': 1 },
      statusCounts: { 200: 2 },
      folderStats: {
        '/blog/': {
          checked: 2,
          statuses: { 200: 2 },
          findings: { 'canonical-expected': 1, 'canonical-drift': 1 },
        },
      },
      findings: [
        {
          code: 'canonical-expected',
          url: expectedUrl,
          root: '/blog/',
          status: 200,
          detail: 'canonical consolidato (previous-slug-bridge)',
        },
        {
          code: 'canonical-drift',
          url: driftUrl,
          root: '/blog/',
          status: 200,
          detail: 'canonical diverso',
        },
      ],
      discoveredOutOfSitemap: [],
    };

    const summary = aggregateCrawlReports([report], { manifestCount: 2, sitemapCount: 1, baseUrl: BASE });
    const issueBody = buildIssueBody(summary);
    expect(summary.actionableCount).toBe(1);
    expect(issueBody).toContain('### canonical-drift (1)');
    expect(issueBody).not.toContain('### canonical-expected');
    expect(issueBody).not.toContain('`canonical-expected`');
    expect(issueBody).toContain('| `/blog/` | 2 | 0 | 1 |');
  });

  it('does not match SEO attributes inside other attribute names or values', () => {
    const metaInputs = [
      '<meta data-name=robots data-content=noindex>',
      '<meta data="name=robots content=noindex">',
    ];

    for (const meta of metaInputs) {
      const result = classifyDocument({
        url: `${BASE}/attribute-guard/`,
        status: 200,
        html: `<link rel=canonical href=${BASE}/attribute-guard/>${meta}`,
      });
      expect(result.findings.map((item) => item.code)).not.toContain('noindex-in-sitemap');
    }

    expect(extractInternalLinks(`<a data-href=/fake>fake</a>`, `${BASE}/`, BASE)).toEqual([]);
  });

  it('retries transient 5xx responses and does not apply HTML findings to PDFs', async () => {
    let calls = 0;
    const report = await crawlPartition({
      manifest: { baseUrl: BASE, urls: [`${BASE}/guide.pdf`] },
      partition: 0,
      partitions: 1,
      concurrency: 1,
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 503 });
        return new Response('%PDF-1.3', { status: 200, headers: { 'content-type': 'application/pdf' } });
      },
    });

    expect(calls).toBe(2);
    expect(report.findings).toEqual([]);
    expect(report.statusCounts).toEqual({ 200: 1 });
  });

  it('rescues a transient failure after the normal partition pass', async () => {
    let calls = 0;
    const report = await crawlPartition({
      manifest: { baseUrl: BASE, urls: [`${BASE}/rescue/`] },
      partition: 0,
      partitions: 1,
      concurrency: 1,
      retries: 0,
      rescueConcurrency: 1,
      rescueRetries: 0,
      rescueDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 503 });
        return new Response('<title>Rescued</title><link rel="canonical" href="https://frontaliereticino.ch/rescue/">', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    expect(calls).toBe(2);
    expect(report.findings).toEqual([]);
    expect(report.statusCounts).toEqual({ 200: 1 });
  });

  it('keeps a persistent transient failure actionable after rescue', async () => {
    let calls = 0;
    const report = await crawlPartition({
      manifest: { baseUrl: BASE, urls: [`${BASE}/persistent-503/`] },
      partition: 0,
      partitions: 1,
      concurrency: 1,
      retries: 0,
      rescueConcurrency: 1,
      rescueRetries: 1,
      rescueDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response('', { status: 503 });
      },
    });

    expect(calls).toBe(3);
    expect(report.findings.map((item) => item.code)).toEqual(['http-error']);
    expect(report.statusCounts).toEqual({ 503: 1 });
  });

  it('rescues transient findings globally after all partitions have drained', async () => {
    const url = `${BASE}/global-rescue/`;
    const report = {
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: 1,
      partition: 0,
      partitions: 1,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: { 'http-error': 1 },
      statusCounts: { 503: 1 },
      folderStats: { '/global-rescue/': { checked: 1, statuses: { 503: 1 }, findings: { 'http-error': 1 } } },
      findings: [{ code: 'http-error', url, detail: 'HTTP 503', root: '/global-rescue/', status: 503 }],
      discoveredOutOfSitemap: [],
    };
    let calls = 0;
    const result = await rescueTransientReports([report], { baseUrl: BASE, urls: [url] }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('<title>Recovered</title><link rel="canonical" href="https://frontaliereticino.ch/global-rescue/">', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      retries: 0,
      delayMs: 0,
      concurrency: 1,
    });

    const summary = aggregateCrawlReports([report], { manifestCount: 1, sitemapCount: 1, baseUrl: BASE });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ attempted: 1, rescued: 1, remaining: 0 });
    expect(summary.actionableCount).toBe(0);
    expect(summary.statusCounts).toEqual({ 200: 1 });
  });

  it('accounts for every queued URL left behind by the rescue deadline', async () => {
    const urls = ['one', 'two', 'three'].map((slug) => `${BASE}/${slug}/`);
    const reports = urls.map((url, partition) => ({
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: urls.length,
      partition,
      partitions: urls.length,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: { 'http-error': 1 },
      statusCounts: { 503: 1 },
      folderStats: { [`/${url.split('/').at(-2)}/`]: { checked: 1, statuses: { 503: 1 }, findings: { 'http-error': 1 } } },
      findings: [{ code: 'http-error', url, detail: 'HTTP 503', root: `/${url.split('/').at(-2)}/`, status: 503 }],
      discoveredOutOfSitemap: [],
    }));
    let calls = 0;
    const result = await rescueTransientReports(reports, { baseUrl: BASE, urls }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('', { status: 503 });
      },
      retries: 0,
      delayMs: 0,
      deadlineMs: 0,
      concurrency: 1,
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({ attempted: 0, rescued: 0, remaining: 3, skipped: 0, deadlineSkipped: 3 });
  });

  it('fails closed when a sitemap responds successfully with no supported entries', async () => {
    const inventory = await collectSitemapInventory({
      baseUrl: 'https://example.test',
      sitemapUrl: 'https://example.test/sitemap.xml',
      fetchImpl: async () => new Response('<html>ok</html>', { status: 200 }),
    });

    expect(inventory.sitemapCount).toBe(0);
    expect(inventory.errors).toHaveLength(1);
    expect(inventory.errors[0].error).toMatch(/vuoto|non supportato/);
  });

  it('extracts same-site HTML links without assets, externals or router actions', () => {
    const links = extractInternalLinks('<a href="/contattaci">Contatti</a><a href=/cerca-lavoro-ticino>Job board</a><a href="/assets/app.js">asset</a><a href="https://example.com/">external</a><a href="nav:pension">bad</a>', `${BASE}/`, BASE);
    expect(links).toEqual(['https://frontaliereticino.ch/cerca-lavoro-ticino/', 'https://frontaliereticino.ch/contattaci/']);
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
