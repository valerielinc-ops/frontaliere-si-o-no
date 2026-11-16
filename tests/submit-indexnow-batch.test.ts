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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractAlternateUrls,
  extractUrls,
  getUrlsFromSitemaps,
  SUB_SITEMAPS,
} from '../scripts/submit-indexnow-batch.mjs';
import {
  extractUrls as extractPostDeployUrls,
  INDEXNOW_SITEMAPS,
  runSubmitToIndexNow,
} from '../scripts/submit-indexnow.js';
import { INDEXNOW_KEY, KEY_LOCATION } from '../scripts/lib/indexnow-submit.mjs';
import { SKIP_LIVE_DATA } from './helpers/live-data';

const BASE = 'https://frontaliereticino.ch/';
const temporaryDirectories: string[] = [];

function createSummaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'indexnow-tiered-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'step-summary.md');
}

function snapshot(
  perSitemap: Record<string, string[]>,
  perSitemapDigests: Record<string, string>,
) {
  return {
    version: 3,
    perSitemap,
    perSitemapDigests,
    perSitemapLastmod: Object.fromEntries(Object.keys(perSitemap).map((key) => [key, {}])),
  };
}

function parseSummaryLog(logs: ReturnType<typeof vi.spyOn>) {
  const line = logs.mock.calls.map(([value]) => String(value))
    .find((value) => value.startsWith('[indexnow-summary] '));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice('[indexnow-summary] '.length));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A fresh Response per call: a Response body is single-use, so reusing one
// object across the sub-sitemap fetches would throw on the 2nd read and
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

describe('pharmacy sitemap coverage', () => {
  it('keeps sitemap-farmacie.xml in both IndexNow collectors', () => {
    expect(INDEXNOW_SITEMAPS).toContain('sitemap-farmacie.xml');
    expect(SUB_SITEMAPS).toContain('sitemap-farmacie.xml');
  });

  it('extracts the pharmacy surface URLs in the post-deploy collector', () => {
    const urls = new Set<string>();
    const pharmacyXml = `<urlset>
      <url><loc>https://frontaliereticino.ch/farmacie/</loc></url>
      <url><loc>https://frontaliereticino.ch/en/pharmacies/</loc></url>
      <url><loc>https://frontaliereticino.ch/de/apotheken/</loc></url>
      <url><loc>https://frontaliereticino.ch/fr/pharmacies/</loc></url>
    </urlset>`;

    extractPostDeployUrls(pharmacyXml, urls);

    expect([...urls].sort()).toEqual([
      'https://frontaliereticino.ch/de/apotheken/',
      'https://frontaliereticino.ch/en/pharmacies/',
      'https://frontaliereticino.ch/farmacie/',
      'https://frontaliereticino.ch/fr/pharmacies/',
    ]);
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

    // The production crawl retries transient edge failures. This branch only
    // tests the terminal fail-closed result, so disable the retry wait here to
    // keep the fixture bounded even when every sitemap is unavailable.
    await expect(getUrlsFromSitemaps({ fetchAttempts: 1, fetchDelayMs: 0 })).rejects.toThrow('process.exit:1');
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

  it('fetches and includes sitemap-farmacie.xml without submitting anything', async () => {
    const pharmacyXml = '<urlset><url><loc>https://frontaliereticino.ch/farmacie/</loc></url></urlset>';
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      input.endsWith('/sitemap-farmacie.xml')
        ? pharmacyXml
        : '<urlset></urlset>',
      { status: 200, headers: { 'Content-Type': 'application/xml' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const urls = await getUrlsFromSitemaps();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sitemap-farmacie.xml'),
      expect.any(Object),
    );
    expect(urls).toContain('https://frontaliereticino.ch/farmacie/');
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/indexnow'))).toBe(true);
  });

  // Prende l'alternate atteso da `public/sitemap-blog.xml` (e il collector legge `public/sitemap-guides.xml`), sitemap che `sync-articles-sitemaps.yml` ripubblica su main.
  it.skipIf(SKIP_LIVE_DATA)('unions the EN/DE/FR alternates from the public/ registry even when the live sitemaps carry none (issue #3474)', async () => {
    // The deployed sitemaps no longer annotate one-sided hreflang groups
    // (build-plugins/sitemapAliasPlugin.ts strips them), so the locale
    // article URLs MUST come from the committed public/ sources — a live
    // response with zero annotations must not shrink the submission set.
    vi.stubGlobal('fetch', xmlResponder('<urlset></urlset>'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const blogXml = fs.readFileSync(path.join(root, 'public', 'sitemap-blog.xml'), 'utf-8');
    const enAlternate = blogXml.match(/hreflang="en"\s+href="([^"]+)"/)?.[1];
    expect(enAlternate).toBeTruthy();

    const urls = await getUrlsFromSitemaps();
    expect(urls).toContain(enAlternate);
  });
});

describe('extractAlternateUrls (public/-registry compensation)', () => {
  it('extracts only hreflang alternate hrefs, never <loc> entries', () => {
    const urls = new Set<string>();
    const xml = `<urlset>
      <url>
        <loc>https://frontaliereticino.ch/articoli-frontaliere/esempio/</loc>
        <xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/cross-border-articles/example/" />
      </url>
    </urlset>`;

    const count = extractAlternateUrls(xml, urls);

    expect(count).toBe(1);
    expect([...urls]).toEqual(['https://frontaliereticino.ch/en/cross-border-articles/example/']);
  });
});

describe('tiered post-deploy IndexNow submission', () => {
  it('sends graph additions, removals and then a non-archive digest URL, and records the summary', async () => {
    const added = [
      `${BASE}fr/recherche/emploi-jysk/`,
      `${BASE}fr/recherche/jysk-emploi-suisse/`,
      `${BASE}ricerca/jysk-lavora-con-noi/`,
      `${BASE}ricerca/jysk-offerte-di-lavoro/`,
      `${BASE}ricerca/lavoro-part-time-mendrisio/`,
      `${BASE}ricerca/offerte-di-lavoro-part-time-mendrisio/`,
      `${BASE}ricerca/offerte-di-lavoro-presso-jysk/`,
    ].sort();
    const removed = Array.from({ length: 13 }, (_, index) => `${BASE}ricerca/orphan-old-${index}/`).sort();
    const digestUrl = `${BASE}temi/digest/`;
    const current = snapshot(
      { 'sitemap-orphan-landings.xml': added, 'sitemap-topics-it.xml': [digestUrl] },
      { 'sitemap-orphan-landings.xml': 'orphan-new', 'sitemap-topics-it.xml': 'topics-new' },
    );
    const previous = snapshot(
      { 'sitemap-orphan-landings.xml': removed, 'sitemap-topics-it.xml': [digestUrl] },
      { 'sitemap-orphan-landings.xml': 'orphan-old', 'sitemap-topics-it.xml': 'topics-old' },
    );
    const summaryFile = createSummaryFile();
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    vi.stubEnv('INDEXNOW_BUDGET_MS', '60000');
    vi.stubEnv('BING_API_KEY', '');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === KEY_LOCATION) return new Response(INDEXNOW_KEY, { status: 200 });
      return new Response(null, { status: init?.method === 'POST' ? 202 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runSubmitToIndexNow({ current, previous });

    const submitted = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .flatMap(([, init]) => JSON.parse(String(init?.body)).urlList as string[]);
    expect(exitCode).toBe(0);
    expect(submitted).toEqual([...added, ...removed, digestUrl]);
    expect(parseSummaryLog(logs)).toMatchObject({
      graph: 8,
      added: 7,
      removed: 13,
      movedIntoArchive: 0,
      movedOutOfArchive: 0,
      lastmod: 0,
      digest: 1,
      suppressedArchiveDigest: { sitemaps: 0, urls: 0 },
      accepted: 21,
      remaining: 0,
      stoppedByDeadline: false,
    });
    const stepSummary = fs.readFileSync(summaryFile, 'utf8');
    expect(stepSummary).toContain('| Grafo | 8 |');
    expect(stepSummary).toContain('| Added | 7 |');
    expect(stepSummary).toContain('| Removed | 13 |');
    expect(stepSummary).toContain('| Moved into archive | 0 |');
    expect(stepSummary).toContain('| Moved out of archive | 0 |');
    expect(stepSummary).toContain('| Accepted | 21 |');
    expect(stepSummary).toContain('| Remaining | 0 |');
    expect(logs.mock.calls.some(([value]) => String(value).includes('movedIn=0 movedOut=0'))).toBe(true);
  });

  it('sends active-to-archive moves before a non-archive digest tier', async () => {
    const movedUrl = `${BASE}annunci/scaduto/`;
    const digestUrl = `${BASE}temi/digest/`;
    const current = snapshot(
      { 'sitemap-jobs-expired-004.xml': [movedUrl], 'sitemap-topics-it.xml': [digestUrl] },
      { 'sitemap-jobs-expired-004.xml': 'expired', 'sitemap-topics-it.xml': 'topics-new' },
    );
    const previous = snapshot(
      { 'sitemap-jobs-active.xml': [movedUrl], 'sitemap-topics-it.xml': [digestUrl] },
      { 'sitemap-jobs-active.xml': 'active', 'sitemap-topics-it.xml': 'topics-old' },
    );
    const summaryFile = createSummaryFile();
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    vi.stubEnv('INDEXNOW_BUDGET_MS', '60000');
    vi.stubEnv('BING_API_KEY', '');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === KEY_LOCATION) return new Response(INDEXNOW_KEY, { status: 200 });
      return new Response(null, { status: init?.method === 'POST' ? 202 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runSubmitToIndexNow({ current, previous });

    const submitted = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .flatMap(([, init]) => JSON.parse(String(init?.body)).urlList as string[]);
    expect(exitCode).toBe(0);
    expect(submitted).toEqual([movedUrl, digestUrl]);
    expect(parseSummaryLog(logs)).toMatchObject({
      movedIntoArchive: 1,
      movedOutOfArchive: 0,
      digest: 1,
      accepted: 2,
      remaining: 0,
    });
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('| Moved into archive | 1 |');
  });

  it('does not submit a URL that only moves between expired archive shards', async () => {
    const url = `${BASE}annunci/scaduto/`;
    const current = snapshot(
      { 'sitemap-jobs-expired-005.xml': [url] },
      { 'sitemap-jobs-expired-005.xml': 'shard-005' },
    );
    const previous = snapshot(
      { 'sitemap-jobs-expired-004.xml': [url] },
      { 'sitemap-jobs-expired-004.xml': 'shard-004' },
    );
    const summaryFile = createSummaryFile();
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    vi.stubEnv('INDEXNOW_BUDGET_MS', '60000');
    vi.stubEnv('BING_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runSubmitToIndexNow({ current, previous });

    expect(exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseSummaryLog(logs)).toMatchObject({
      added: 0,
      removed: 0,
      movedIntoArchive: 0,
      movedOutOfArchive: 0,
      lastmod: 0,
      digest: 0,
      suppressedArchiveDigest: { sitemaps: 1, urls: 1 },
      accepted: 0,
      remaining: 0,
    });
  });

  it('returns exit code 1 and reports the remaining URL when the budget is already exhausted', async () => {
    const newUrl = `${BASE}settore/nuovo/`;
    const current = snapshot({ 'sitemap-sector.xml': [newUrl] }, { 'sitemap-sector.xml': 'new' });
    const previous = snapshot({ 'sitemap-sector.xml': [] }, { 'sitemap-sector.xml': 'old' });
    const summaryFile = createSummaryFile();
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    vi.stubEnv('INDEXNOW_BUDGET_MS', '0');
    vi.stubEnv('BING_API_KEY', '');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runSubmitToIndexNow({ current, previous });

    expect(exitCode).toBe(1);
    expect(parseSummaryLog(logs)).toMatchObject({
      graph: 1,
      added: 1,
      accepted: 0,
      remaining: 1,
      stoppedByDeadline: true,
    });
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('| Stopped by deadline | true |');
  });
});
