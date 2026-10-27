import { describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/jobs-url-helper.mjs', () => ({
  printPublishedJobUrls: vi.fn(),
  writeJobsSummary: vi.fn(),
  snapshotJobSlugs: vi.fn(() => new Map()),
  computeCrawlDiff: vi.fn(() => ({
    newJobs: [],
    updatedJobs: [],
    removedJobs: [],
    unchangedCount: 0,
    unchangedJobs: [],
  })),
  printCrawlChangeSummary: vi.fn(),
  writeCrawlChangeSummaryToGH: vi.fn(),
  setCrawlerStartTime: vi.fn(),
  getCrawlerElapsedMs: vi.fn(() => 0),
}));

const { buildTichFetchProxyHosts, fetchTichJobDetailUrls } = await import('../scripts/update-tich-jobs.mjs');
const { buildTichTranslateUrl } = await import('../scripts/scrape-concorsi-ti.mjs');

const LISTING_URL = 'https://www.concorsi.ti.ch/';
const RSS_URL = 'https://www.concorsi.ti.ch/rss_generator-rss0.php?unit=act&lang=it';
const OFFICIAL_LISTING_URL = 'https://www4.ti.ch/index.php?id=147427';

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

const officialListingHtml = `<!doctype html>
<html>
  <body>
    <h1>Concorsi generali</h1>
    <div class="ce-bodytext">
      <p>no. 02/26</p>
      <p><strong>Concorso generale Aiuto cucina<br> presso Ufficio della refezione, Bellinzona</strong></p>
      <p>Scadenza: 31.12.2026</p>
      <a href="https://www.concorsi.ti.ch/offerte-d%27impieghi.html?yid=4059">Vai al concorso</a>
    </div>
    <a href="https://www.concorsi.ti.ch/">Fonte ufficiale</a>
    <p>Scadenza: 31.12.2026</p>
  </body>
</html>`;

const translatedOfficialListingHtml = officialListingHtml.replace(
  'https://www.concorsi.ti.ch/offerte-d%27impieghi.html?yid=4059',
  'https://www-concorsi-ti-ch.translate.goog/offerte-d%27impieghi.html?yid=4059&_x_tr_sl=auto&_x_tr_tl=it&_x_tr_hl=it&_x_tr_pto=wapp',
);

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
    expect(result.officialSucceeded).toBe(false);
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4101",
    ]);
    expect(attempts.get(LISTING_URL)).toBe(2);
    expect(attempts.get(RSS_URL)).toBe(1);
  });

  it('uses the validated official Canton listing when both portal sources are unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === OFFICIAL_LISTING_URL) return new Response(officialListingHtml, { status: 200 });
      throw new TypeError('fetch failed');
    });

    const result = await fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      timeoutMs: 1_000,
    });

    expect(result.listingSucceeded).toBe(false);
    expect(result.rssSucceeded).toBe(false);
    expect(result.officialSucceeded).toBe(true);
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4059",
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(OFFICIAL_LISTING_URL, expect.anything());
  });

  it('uses the validated official listing through Jina when the runner egress is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) return new Response(officialListingHtml, { status: 200 });
      throw new TypeError('fetch failed');
    });

    const result = await fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      proxyRetries: 0,
      proxyRetryBaseMs: 0,
      timeoutMs: 1_000,
    });

    expect(result.listingSucceeded).toBe(false);
    expect(result.rssSucceeded).toBe(false);
    expect(result.officialSucceeded).toBe(true);
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4059",
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith('https://r.jina.ai/'))).toBe(true);
  });

  it('uses the validated official listing through Google Translate after direct and Jina egress fail', async () => {
    const translateUrl = buildTichTranslateUrl(OFFICIAL_LISTING_URL);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === translateUrl) return new Response(translatedOfficialListingHtml, { status: 200 });
      if (url === OFFICIAL_LISTING_URL) return new Response('<html>not the official listing</html>', { status: 200 });
      throw new TypeError('fetch failed');
    });

    const result = await fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      proxyRetries: 0,
      proxyRetryBaseMs: 0,
      translateAttempts: 1,
      translateRetryDelayMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      listingSucceeded: false,
      rssSucceeded: false,
      officialSucceeded: true,
    });
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4059",
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => url === translateUrl)).toBe(true);
  });
});

describe('Ticino official listing transport', () => {
  it('keeps the source query and restricts the proxy to the official listing', () => {
    expect(buildTichTranslateUrl(OFFICIAL_LISTING_URL)).toBe(
      'https://www4-ti-ch.translate.goog/index.php?id=147427&_x_tr_sl=auto&_x_tr_tl=it&_x_tr_hl=it&_x_tr_pto=wapp',
    );
    expect(buildTichTranslateUrl('https://www4.ti.ch/index.php?id=24469')).toBe('');
  });
});

describe('buildTichFetchProxyHosts', () => {
  it('keeps normal listing/RSS discovery on the inherited direct-fetch path', () => {
    expect(buildTichFetchProxyHosts({ officialSucceeded: false }, 'other.example')).toBe('other.example');
  });

  it('adds the egress proxy only when the official listing supplied the URLs', () => {
    expect(buildTichFetchProxyHosts({ officialSucceeded: true }, 'other.example')).toBe(
      'other.example,www.concorsi.ti.ch',
    );
  });
});
