import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyDocument,
  collectDiscoveredInventory,
  collectSitemapInventory,
  crawlPartition,
  extractInternalLinks,
  folderFor,
  normalizeUrl,
  parseSitemapDocument,
  partitionFor,
} from '../../scripts/seo/bing-site-explorer-crawl.mjs';
import {
  BING_FRONTIER_CANONICAL_DRIFT,
  BING_FRONTIER_CANONICAL_EXPECTED,
  BING_FRONTIER_HTTP_ERROR,
  BING_FRONTIER_NOINDEX,
  BING_FRONTIER_NOINDEX_BRIDGE,
  BING_FRONTIER_REDIRECT,
} from '../../scripts/seo/bing-finding-codes.mjs';
import {
  aggregateCrawlReports,
  buildIssueBody,
  readPartitionReports,
  rescueTransientReports,
} from '../../scripts/seo/bing-site-explorer-report.mjs';
import { BING_TEMPLATE_TABLE, templateIndexFor } from '../../scripts/seo/bing-template-inventory.mjs';
import { REDIRECT_STUB_MARKER } from '../../build-plugins/shared/redirectStubMarker.mjs';

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
    const noindex = classifyDocument({ url: `${BASE}/partner/`, status: 200, headers: new Headers({ 'x-robots-tag': 'noindex' }), html: '<title>Partner</title><link rel="canonical" href="https://frontaliereticino.ch/partner/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare la pagina partner nel controllo SEO completo del sito e mantenere il contratto di crawling."/><meta name="robots" content="noindex">' });
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

    const metadata = classifyDocument({
      url: `${BASE}/metadata/`,
      status: 200,
      html: '<title>Questo titolo supera intenzionalmente il limite SEO definito dal crawler per la verifica</title><link rel="canonical" href="https://frontaliereticino.ch/metadata/"><meta name="description" content="Descrizione breve">',
    });
    expect(metadata.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'title-too-long',
      'meta-description-too-short',
    ]));

    const newsHeadline = 'Un titolo storico molto lungo che resta identico nel NewsArticle per preservare la sua elegibilità editoriale';
    const newsInvariant = classifyDocument({
      url: `${BASE}/articoli-frontaliere/storico/`,
      status: 200,
      html: `<title>${newsHeadline}</title><link rel="canonical" href="${BASE}/articoli-frontaliere/storico/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare la pagina storica nel controllo SEO completo e mantenere il contratto di crawling."><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: newsHeadline })}</script>`,
    });
    expect(newsInvariant.findings.map((item) => item.code)).not.toContain('title-too-long');

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

  it('classifies the same document according to sitemap or internal-frontier scope', () => {
    const bridgeUrl = `${BASE}/en/find-jobs-geneva/old-slug/`;
    const bridgeHtml = `<title>Bridge</title><link rel="canonical" href="${BASE}/en/find-jobs-geneva/new-slug/"><meta name="robots" content="noindex,follow"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare il bridge dichiarato nel controllo SEO completo del sito e mantenere il contratto di crawling.">`;
    const sitemapBridge = classifyDocument({ url: bridgeUrl, status: 200, scope: 'sitemap', html: bridgeHtml });
    const frontierBridge = classifyDocument({ url: bridgeUrl, status: 200, scope: 'discovered-frontier', html: bridgeHtml });

    expect(sitemapBridge.findings.map((item) => item.code)).toEqual(expect.arrayContaining(['noindex-in-sitemap', 'canonical-expected']));
    expect(frontierBridge.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      BING_FRONTIER_NOINDEX_BRIDGE,
      BING_FRONTIER_CANONICAL_EXPECTED,
    ]));
    expect(frontierBridge.findings.map((item) => item.code)).not.toContain('noindex-in-sitemap');

    const nonBridge = classifyDocument({
      url: `${BASE}/frontiera-noindex/`,
      status: 200,
      scope: 'discovered-frontier',
      html: `<title>Noindex</title><link rel="canonical" href="${BASE}/frontiera-noindex/"><meta name="robots" content="noindex,follow">`,
    });
    expect(nonBridge.findings.map((item) => item.code)).toContain(BING_FRONTIER_NOINDEX);

    const sitemapDrift = classifyDocument({
      url: `${BASE}/sitemap-drift/`,
      status: 200,
      scope: 'sitemap',
      html: `<title>Drift</title><link rel="canonical" href="${BASE}/other/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare il drift nel controllo SEO completo del sito e mantenere il contratto di crawling.">`,
    });
    const frontierDrift = classifyDocument({
      url: `${BASE}/frontiera-drift/`,
      status: 200,
      scope: 'discovered-frontier',
      html: `<title>Drift</title><link rel="canonical" href="${BASE}/other/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare il drift nel controllo SEO completo del sito e mantenere il contratto di crawling.">`,
    });
    expect(sitemapDrift.findings.map((item) => item.code)).toContain('canonical-drift');
    expect(frontierDrift.findings.map((item) => item.code)).toContain(BING_FRONTIER_CANONICAL_DRIFT);

    for (const status of [301, 404]) {
      const sitemap = classifyDocument({ url: `${BASE}/status-${status}/`, status, scope: 'sitemap', finalUrl: `${BASE}/target/` });
      const frontier = classifyDocument({ url: `${BASE}/frontier-status-${status}/`, status, scope: 'discovered-frontier', finalUrl: `${BASE}/target/` });
      expect(sitemap.findings[0].code).toBe(status === 301 ? 'redirect' : 'http-error');
      expect(frontier.findings[0].code).toBe(status === 301 ? BING_FRONTIER_REDIRECT : BING_FRONTIER_HTTP_ERROR);
    }
  });

  it('recognizes localized below-floor search bridges only in the frontier scope', () => {
    const bridgeHtml = (canonical: string) => `${REDIRECT_STUB_MARKER}<title>Bridge</title><meta name="robots" content="noindex,follow"><link rel="canonical" href="${canonical}"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare il bridge di ricerca nel controllo SEO completo del sito e mantenere il contratto di crawling.">`;
    const cases = [
      {
        url: `${BASE}/cerca-lavoro-svizzera/ricerca-migros-otelfingen/`,
        canonical: `${BASE}/cerca-lavoro-svizzera/`,
      },
      {
        url: `${BASE}/en/find-jobs-switzerland/search-migros-otelfingen/`,
        canonical: `${BASE}/en/find-jobs-switzerland/`,
      },
      {
        url: `${BASE}/de/jobs-in-schweiz/suche-migros-otelfingen/`,
        canonical: `${BASE}/de/jobs-in-schweiz/`,
      },
      {
        url: `${BASE}/fr/trouver-emploi-suisse/recherche-migros-otelfingen/`,
        canonical: `${BASE}/fr/trouver-emploi-suisse/`,
      },
    ];

    for (const { url, canonical } of cases) {
      const frontier = classifyDocument({
        url,
        status: 200,
        scope: 'discovered-frontier',
        html: bridgeHtml(canonical),
      });
      expect(frontier.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        BING_FRONTIER_NOINDEX_BRIDGE,
        BING_FRONTIER_CANONICAL_EXPECTED,
      ]));
      expect(frontier.findings.map((item) => item.code)).not.toContain(BING_FRONTIER_NOINDEX);
      expect(frontier.findings.map((item) => item.code)).not.toContain(BING_FRONTIER_CANONICAL_DRIFT);

      const sitemap = classifyDocument({ url, status: 200, scope: 'sitemap', html: bridgeHtml(canonical) });
      expect(sitemap.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'noindex-in-sitemap',
        'canonical-drift',
      ]));
    }
  });

  it('does not infer a search bridge from a loose slug or canonical shape', () => {
    const bridgeMarkerHtml = (canonical: string) => `${REDIRECT_STUB_MARKER}<title>Bridge</title><meta name="robots" content="noindex,follow"><link rel="canonical" href="${canonical}">`;
    const cases = [
      {
        url: `${BASE}/en/find-jobs-switzerland/ricerca-migros/`,
        canonical: `${BASE}/en/find-jobs-switzerland/`,
        html: bridgeMarkerHtml(`${BASE}/en/find-jobs-switzerland/`),
      },
      {
        url: `${BASE}/en/find-jobs-switzerland/search-migros/details/`,
        canonical: `${BASE}/en/find-jobs-switzerland/`,
        html: bridgeMarkerHtml(`${BASE}/en/find-jobs-switzerland/`),
      },
      {
        url: `${BASE}/en/find-jobs-switzerland/search-migros/`,
        canonical: `${BASE}/en/find-jobs-switzerland/other/`,
        html: bridgeMarkerHtml(`${BASE}/en/find-jobs-switzerland/other/`),
      },
      {
        url: `${BASE}/en/find-jobs-switzerland/search-migros/`,
        canonical: `${BASE}/en/find-jobs-switzerland/`,
        html: bridgeMarkerHtml(`${BASE}/en/find-jobs-switzerland/`),
        scope: 'sitemap',
      },
    ];

    for (const { url, canonical, html, scope = 'discovered-frontier' } of cases) {
      const result = classifyDocument({ url, status: 200, scope, html });
      const codes = result.findings.map((item) => item.code);
      expect(codes).toContain(scope === 'sitemap' ? 'noindex-in-sitemap' : BING_FRONTIER_NOINDEX);
      expect(codes).toContain(scope === 'sitemap' ? 'canonical-drift' : BING_FRONTIER_CANONICAL_DRIFT);
      expect(codes).not.toContain(BING_FRONTIER_NOINDEX_BRIDGE);
      expect(codes).not.toContain(BING_FRONTIER_CANONICAL_EXPECTED);
    }
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
    expect(issueBody).toContain('| `canonical-expected` | informativo | 1 |');
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
        return new Response('<title>Rescued</title><link rel="canonical" href="https://frontaliereticino.ch/rescue/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare la pagina recuperata nel controllo SEO completo del sito e mantenere il contratto di crawling.">', {
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
        return new Response('<title>Recovered</title><link rel="canonical" href="https://frontaliereticino.ch/global-rescue/"><meta name="description" content="Una descrizione sufficientemente lunga per rappresentare la pagina recuperata nel controllo SEO completo del sito e mantenere il contratto di crawling.">', {
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

  it('cancels an invalid streamed sitemap chunk before recording the read error', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: '<urlset>' }),
      cancel,
      releaseLock,
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: vi.fn(() => reader) },
    };
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const inventory = await collectSitemapInventory({
      baseUrl: 'https://example.test',
      sitemapUrl: 'https://example.test/sitemap.xml',
      fetchImpl,
    });
    expect(inventory.errors).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('reads a sitemap streamed as bare ArrayBuffer chunks that the producer reuses', async () => {
    const xml = '<urlset><url><loc>https://example.test/a/</loc></url><url><loc>https://example.test/b/</loc></url></urlset>';
    const bytes = new TextEncoder().encode(xml);
    const half = Math.ceil(bytes.byteLength / 2);
    const parts = [bytes.subarray(0, half), bytes.subarray(half)];
    // One buffer for every read, as a pooling producer does: a chunk kept as a
    // view on it would be rewritten by the next read.
    const shared = new ArrayBuffer(half);
    let index = 0;
    const reader = {
      read: vi.fn(async () => {
        if (index >= parts.length) return { done: true, value: undefined };
        const view = new Uint8Array(shared);
        view.fill(0x20);
        view.set(parts[index]);
        index += 1;
        return { done: false, value: shared };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: vi.fn(() => reader) },
    };
    const inventory = await collectSitemapInventory({
      baseUrl: 'https://example.test',
      sitemapUrl: 'https://example.test/sitemap.xml',
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    expect(inventory.errors).toEqual([]);
    expect(inventory.urls).toEqual(['https://example.test/a/', 'https://example.test/b/']);
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('keeps same-site link evidence while excluding externals and router actions', () => {
    const links = extractInternalLinks('<a href="/contattaci">Contatti</a><a href=/cerca-lavoro-ticino>Job board</a><a href="/?calc=1">query</a><a href="/assets/app.js">asset</a><a href="https://example.com/">external</a><a href="nav:pension">router action</a><a href="<nav:calculator>">malformed editor token</a>', `${BASE}/`, BASE);
    expect(links).toEqual([
      '<nav:calculator>',
      'https://frontaliereticino.ch/?calc=1',
      'https://frontaliereticino.ch/assets/app.js',
      'https://frontaliereticino.ch/cerca-lavoro-ticino/',
      'https://frontaliereticino.ch/contattaci/',
    ]);
  });

  it('carries malformed, dynamic and non-HTML links into the discovery report', async () => {
    const report = await crawlPartition({
      manifest: { baseUrl: BASE, urls: [`${BASE}/source/`] },
      partition: 0,
      partitions: 1,
      concurrency: 1,
      retries: 0,
      rescueDelayMs: 0,
      fetchImpl: async () => new Response(
        '<a href="<nav:calculator>">malformed</a><a href="/?calc=1">query</a><a href="/asset.js">asset</a>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    });

    expect(report.discoveredOutOfSitemap).toEqual([
      '<nav:calculator>',
      `${BASE}/?calc=1`,
      `${BASE}/asset.js`,
    ]);
  });

  it('stores compact referrer and template indexes for discovered links', async () => {
    const source = `${BASE}/en/find-jobs-geneva/source/`;
    const target = `${BASE}/en/find-jobs-geneva/target/`;
    const report = await crawlPartition({
      manifest: { kind: 'sitemap', baseUrl: BASE, urls: [source] },
      partition: 0,
      partitions: 1,
      concurrency: 1,
      retries: 0,
      rescueDelayMs: 0,
      fetchImpl: async () => new Response(`<a href="${target}">target</a>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    });

    expect(report.scope).toBe('sitemap');
    expect(report.discoveredOutOfSitemap).toEqual([target]);
    expect(report.discoveredReferrers).toEqual([[[0, templateIndexFor(source)]]]);

    const frontier = collectDiscoveredInventory({
      manifest: { baseUrl: BASE, urls: [source] },
      reports: [report],
    });
    expect(frontier.urls).toEqual([target]);
    expect(frontier.referrerRefs).toEqual([[[0, templateIndexFor(source)]]]);
    expect(frontier.templateTable).toEqual(BING_TEMPLATE_TABLE);

    const capped = collectDiscoveredInventory({
      manifest: { baseUrl: BASE, urls: [source] },
      reports: [{
        discoveredOutOfSitemap: [target, target, target, target],
        discoveredReferrers: [[[3, 0]], [[2, 0]], [[1, 0]], [[0, 0]]],
      }],
    });
    expect(capped.referrerRefs[0]).toHaveLength(3);
  });

  it('builds a bounded second frontier and keeps dynamic or malformed links as evidence', () => {
    const frontier = collectDiscoveredInventory({
      manifest: { baseUrl: BASE, urls: [`${BASE}/in-sitemap/`] },
      reports: [{
        discoveredOutOfSitemap: [
          `${BASE}/in-sitemap/`,
          `${BASE}/storico/settimana-18-2026/`,
          `${BASE}/calcola-stipendio/?reddito=100000`,
          `${BASE}/articoli/test/%3Cnav:calculator%3E/`,
          `${BASE}/assets/app.js`,
          '<nav:calculator>',
        ],
      }],
    });

    expect(frontier.urls).toEqual([`${BASE}/storico/settimana-18-2026/`]);
    expect(frontier.sourceDiscoveredCount).toBe(5);
    expect(frontier.excludedByReason).toEqual({
      'dynamic-query': 1,
      'malformed-route': 2,
      'non-html-or-private': 1,
    });
    expect(frontier.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'internal-link-malformed',
        url: `${BASE}/articoli/test/%3Cnav:calculator%3E/`,
      }),
      expect.objectContaining({ code: 'internal-link-malformed', url: '<nav:calculator>' }),
    ]));
    expect(frontier.folders).toEqual({ '/storico/': 1 });
  });

  it('fails closed when a partition is missing or duplicated', () => {
    const base = (partition) => ({ schemaVersion: 1, baseUrl: BASE, manifestCount: 2, partition, partitions: 2, partitionTotal: 1, checkedCount: 1, codeCounts: {}, statusCounts: { 200: 1 }, folderStats: {}, findings: [], discoveredOutOfSitemap: [] });
    const summary = aggregateCrawlReports([base(0), base(0)], { manifestCount: 2, sitemapCount: 1, baseUrl: BASE });
    expect(summary.coverageOk).toBe(false);
    expect(summary.coverageErrors.join(' ')).toMatch(/duplicata|mancante|diversa/);
  });

  it('aggregates sitemap coverage with the internally linked HTML frontier', () => {
    const sitemapUrl = `${BASE}/in-sitemap/`;
    const frontierUrl = `${BASE}/storico/settimanale-18-2026/`;
    const makeReport = (url, partition = 0) => ({
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: 1,
      partition,
      partitions: 1,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: { 'http-error': 1 },
      statusCounts: { 404: 1 },
      folderStats: { '/storico/': { checked: 1, statuses: { 404: 1 }, findings: { 'http-error': 1 } } },
      findings: [{ code: 'http-error', url, root: '/storico/', status: 404, detail: 'HTTP 404' }],
      discoveredOutOfSitemap: [],
    });
    const summary = aggregateCrawlReports(
      [makeReport(sitemapUrl)],
      { baseUrl: BASE, sitemapCount: 1, manifestCount: 1, urls: [sitemapUrl] },
      {
        supplementalReports: [makeReport(frontierUrl)],
        supplementalManifest: { baseUrl: BASE, kind: 'discovered-frontier', manifestCount: 1, urls: [frontierUrl] },
      },
    );

    expect(summary.coverageOk).toBe(true);
    expect(summary.manifestCount).toBe(2);
    expect(summary.checkedCount).toBe(2);
    expect(summary.supplementalManifestCount).toBe(1);
    expect(summary.scopes.map((scope) => scope.name)).toEqual(['sitemap', 'frontiera interna']);
    expect(summary.actionableCount).toBe(2);
    expect(buildIssueBody(summary)).toContain('Frontiera interna crawlable: **1 URL**');
    expect(summary.findings.every((item) => item.scope === 'sitemap' || item.scope === 'discovered-frontier')).toBe(true);
  });

  it('separates frontier actionability and attributes findings to the referrer template', () => {
    const source = `${BASE}/en/find-jobs-geneva/source/`;
    const bridge = `${BASE}/en/find-jobs-geneva/bridge/`;
    const redirect = `${BASE}/en/find-jobs-geneva/redirect/`;
    const sourceTemplate = templateIndexFor(source);
    const targetTemplate = templateIndexFor(bridge);
    const sitemapReport = {
      schemaVersion: 1,
      scope: 'sitemap',
      baseUrl: BASE,
      manifestCount: 1,
      partition: 0,
      partitions: 1,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: {},
      statusCounts: { 200: 1 },
      folderStats: { '/en/': { checked: 1, statuses: { 200: 1 }, findings: {} } },
      findings: [],
      discoveredOutOfSitemap: [],
    };
    const frontierReport = {
      schemaVersion: 2,
      scope: 'discovered-frontier',
      baseUrl: BASE,
      manifestCount: 2,
      partition: 0,
      partitions: 1,
      partitionTotal: 2,
      checkedCount: 2,
      codeCounts: {
        [BING_FRONTIER_NOINDEX_BRIDGE]: 1,
        [BING_FRONTIER_REDIRECT]: 1,
      },
      statusCounts: { 200: 1, 301: 1 },
      folderStats: { '/en/': { checked: 2, statuses: { 200: 1, 301: 1 }, findings: {
        [BING_FRONTIER_NOINDEX_BRIDGE]: 1,
        [BING_FRONTIER_REDIRECT]: 1,
      } } },
      findings: [
        { code: BING_FRONTIER_NOINDEX_BRIDGE, url: bridge, root: '/en/', status: 200, detail: 'bridge dichiarato' },
        { code: BING_FRONTIER_REDIRECT, url: redirect, root: '/en/', status: 301, detail: 'redirect' },
      ],
      discoveredOutOfSitemap: [],
    };
    const frontierUrls = [bridge, redirect].sort();
    const summary = aggregateCrawlReports([sitemapReport], {
      baseUrl: BASE,
      sitemapCount: 1,
      manifestCount: 1,
      urls: [source],
    }, {
      supplementalReports: [frontierReport],
      supplementalManifest: {
        baseUrl: BASE,
        kind: 'discovered-frontier',
        manifestCount: frontierUrls.length,
        urls: frontierUrls,
        referrerRefs: frontierUrls.map(() => [[0, sourceTemplate]]),
        templateTable: BING_TEMPLATE_TABLE,
      },
    });

    expect(summary.actionableCount).toBe(1);
    expect(summary.scopeSummaries.find((scope) => scope.kind === 'discovered-frontier')).toMatchObject({
      findingCount: 2,
      actionableCount: 1,
      informativeCount: 1,
    });
    const row = summary.frontierAttribution.rows.find((item) => item.code === BING_FRONTIER_REDIRECT);
    expect(row).toMatchObject({ referrerTemplate: sourceTemplate, targetTemplate });
    expect(row.samples).toEqual([[source, redirect]]);
    expect(buildIssueBody(summary)).toContain('### Template referente della frontiera interna');
    expect(buildIssueBody(summary)).toContain(`\`${source}\` → \`${redirect}\``);
  });

  it('reads the frontier partition filename prefix used by the workflow artifacts', () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'bing-site-frontier-reports-'));
    try {
      writeFileSync(join(reportsDir, 'frontier-partition-0.json'), JSON.stringify({ partition: 0 }));
      writeFileSync(join(reportsDir, 'partition-0.json'), JSON.stringify({ partition: 99 }));

      expect(readPartitionReports(reportsDir, 'frontier-partition-')).toEqual([{ partition: 0 }]);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }
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

  it('fails closed when the internal-link frontier job fails before reporting', () => {
    const summary = aggregateCrawlReports([], {
      baseUrl: BASE,
      sitemapCount: 1,
      manifestCount: 0,
      errors: [],
    }, {
      supplementalCoverageErrors: ['frontiera interna: tree-discovered-inventory=failure; manifest non disponibile'],
    });

    expect(summary.coverageOk).toBe(false);
    expect(summary.coverageErrors).toContain('frontiera interna: tree-discovered-inventory=failure; manifest non disponibile');
  });
});
