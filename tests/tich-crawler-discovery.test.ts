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

const {
  buildTichFetchProxyHosts,
  buildTichMorssProxyHosts,
  fetchTichHtml,
  fetchTichJobDetailUrls,
  isTichDetailHtmlForUrl,
} = await import('../scripts/update-tich-jobs.mjs');
const {
  buildTichTranslateUrl,
  OFFICIAL_LISTING_CANONICAL_URL,
  fetchTichOfficialListingViaTranslate,
} = await import('../scripts/scrape-concorsi-ti.mjs');

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
const morssListingHtml = listingHtml.replace('class="jobsearch"', 'id="jobslisting"');
const TICH_DETAIL_URL = "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4059";
const validTichDetailHtml = `<!doctype html>
<html><head><title>Offerta di lavoro Aiuto cucina presso Amministrazione Cantonale Ticino Jobportal</title>
<meta name="generator" content="Rexx Recruitment - Portal7"></head>
<body><div id="jobTplContainer">Concorso yid=4059</div>
<a href="forma-di-lavoro.html?yid=4059&amp;sid=transient">candidatura</a></body></html>`;
const morssInterstitialHtml = '<html><head><title>Checking your browser</title></head><body>Proxy unavailable</body></html>';

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

  it('treats a valid empty listing as a successful zero-source result', async () => {
    const emptyListingHtml = listingHtml.replace(
      '<a href="/offerte-d\'impieghi.html?yid=4101&amp;sid=transient">Offerta</a>',
      '',
    );
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === LISTING_URL) return new Response(emptyListingHtml, { status: 200 });
      throw new TypeError('fetch failed');
    });

    const result = await fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      listingSucceeded: true,
      rssSucceeded: false,
      officialSucceeded: false,
      morssSucceeded: false,
      sourceZero: true,
      urls: [],
    });
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

  it('uses the complete Ti.CH listing through Morss after every other egress fails', async () => {
    const morssUrl = 'https://morss.it/:get=page/https://www.concorsi.ti.ch/';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === morssUrl) return new Response(morssListingHtml, { status: 200 });
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
      morssAttempts: 1,
      morssRetryDelayMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      listingSucceeded: true,
      rssSucceeded: false,
      officialSucceeded: false,
      morssSucceeded: true,
    });
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4101",
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => url === morssUrl)).toBe(true);
  });

  it('tags an all-transport discovery outage for the crawler soft-exit guard', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) return new Response('', { status: 502 });
      if (url.includes('.translate.goog/')) return new Response('', { status: 408 });
      throw new TypeError('fetch failed');
    });

    await expect(fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      proxyRetries: 0,
      proxyRetryBaseMs: 0,
      translateAttempts: 1,
      translateRetryDelayMs: 0,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ feedEndpointUnavailable: true });
  });

  it('keeps a persistent Jina response hard after direct discovery transport failures', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) return new Response('', { status: 404 });
      if (url.includes('.translate.goog/')) return new Response('', { status: 408 });
      throw new TypeError('fetch failed');
    });

    let thrown: unknown;
    try {
      await fetchTichJobDetailUrls({
        fetchImpl,
        retries: 0,
        retryBaseMs: 0,
        proxyRetries: 0,
        proxyRetryBaseMs: 0,
        translateAttempts: 1,
        translateRetryDelayMs: 0,
        timeoutMs: 1_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { feedEndpointUnavailable?: boolean }).feedEndpointUnavailable).not.toBe(true);
  });

  it('preserves the soft-exit when Jina returns 200 but its body read fails', async () => {
    const bodyReadFailure = Object.assign(new Error('body read aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) {
        return {
          ok: true,
          status: 200,
          text: async () => { throw bodyReadFailure; },
          body: null,
        } as unknown as Response;
      }
      if (url.includes('.translate.goog/')) return new Response('', { status: 408 });
      throw new TypeError('fetch failed');
    });

    await expect(fetchTichJobDetailUrls({
      fetchImpl,
      retries: 0,
      retryBaseMs: 0,
      proxyRetries: 0,
      proxyRetryBaseMs: 0,
      translateAttempts: 1,
      translateRetryDelayMs: 0,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ feedEndpointUnavailable: true });
  });

  it('does not soften a source identity response into a transport outage', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>wrong source</html>', { status: 200 }));

    let thrown: unknown;
    try {
      await fetchTichJobDetailUrls({
        fetchImpl,
        retries: 0,
        retryBaseMs: 0,
        proxyRetries: 0,
        proxyRetryBaseMs: 0,
        translateAttempts: 1,
        translateRetryDelayMs: 0,
        timeoutMs: 1_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { feedEndpointUnavailable?: boolean }).feedEndpointUnavailable).not.toBe(true);
  });

  it('rejects a Morss interstitial and falls back to the direct detail page', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://morss.it/:get=page/' + TICH_DETAIL_URL) {
        return new Response(morssInterstitialHtml, { status: 200 });
      }
      if (url === TICH_DETAIL_URL) return new Response(validTichDetailHtml, { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(fetchTichHtml(TICH_DETAIL_URL, {
      fetchImpl,
      preferMorss: true,
      timeoutMs: 1_000,
    })).resolves.toBe(validTichDetailHtml);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://morss.it/:get=page/' + TICH_DETAIL_URL,
      TICH_DETAIL_URL,
    ]);
  });
});

describe('Ticino official listing transport', () => {
  it('keeps the source query and restricts the proxy to the official listing', () => {
    expect(buildTichTranslateUrl(OFFICIAL_LISTING_URL)).toBe(
      'https://www4-ti-ch.translate.goog/index.php?id=147427&_x_tr_sl=auto&_x_tr_tl=it&_x_tr_hl=it&_x_tr_pto=wapp',
    );
    expect(buildTichTranslateUrl(OFFICIAL_LISTING_CANONICAL_URL)).toBe(
      'https://www4-ti-ch.translate.goog/dfe/dr/sru/lavorare-per-lamministrazione-cantonale/concorsi-generali?_x_tr_sl=auto&_x_tr_tl=it&_x_tr_hl=it&_x_tr_pto=wapp',
    );
    expect(buildTichTranslateUrl('https://www4.ti.ch/index.php?id=24469')).toBe('');
    expect(buildTichTranslateUrl('https://www4.ti.ch/dfe/dr/sru/lavorare-per-lamministrazione-cantonale/concorsi-generali?cHash=untrusted')).toBe('');
  });

  it('tries the canonical official listing after the legacy Translate route times out', async () => {
    const legacyTranslateUrl = buildTichTranslateUrl(OFFICIAL_LISTING_URL);
    const canonicalTranslateUrl = buildTichTranslateUrl(OFFICIAL_LISTING_CANONICAL_URL);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === legacyTranslateUrl) return new Response('', { status: 408 });
      if (url === canonicalTranslateUrl) return new Response(translatedOfficialListingHtml, { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(fetchTichOfficialListingViaTranslate(OFFICIAL_LISTING_URL, {
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
      timeoutMs: 1_000,
    })).resolves.toContain('https://www.concorsi.ti.ch/offerte-d%27impieghi.html?yid=4059');

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      legacyTranslateUrl,
      canonicalTranslateUrl,
    ]);
  });

  it('keeps the bounded Google Translate rescue alive beyond the direct-source timeout', async () => {
    vi.useFakeTimers();
    try {
      const translateUrl = buildTichTranslateUrl(OFFICIAL_LISTING_URL);
      let signal;
      const fetchImpl = vi.fn((url: string, init: RequestInit) => {
        expect(url).toBe(translateUrl);
        signal = init.signal;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(translatedOfficialListingHtml, { status: 200 })), 1_500);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('This operation was aborted'));
          }, { once: true });
        });
      });

      const pending = fetchTichOfficialListingViaTranslate(OFFICIAL_LISTING_URL, {
        fetchImpl,
        timeoutMs: 1_000,
        attempts: 1,
        retryDelayMs: 0,
      });

      await vi.advanceTimersByTimeAsync(1_499);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toContain('https://www.concorsi.ti.ch/offerte-d%27impieghi.html?yid=4059');
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps Jina available when Morss supplied discovery as the primary egress', () => {
    expect(buildTichFetchProxyHosts({ officialSucceeded: false, morssSucceeded: true }, '')).toBe(
      'www.concorsi.ti.ch',
    );
  });

  it('routes detail pages through Morss only when Morss supplied discovery', () => {
    expect(buildTichMorssProxyHosts({ morssSucceeded: false }, 'other.example')).toBe('other.example');
    expect(buildTichMorssProxyHosts({ morssSucceeded: true }, 'other.example')).toBe(
      'other.example,www.concorsi.ti.ch',
    );
  });
});

describe('Ti.CH detail identity', () => {
  it('accepts only the requested canonical detail identity', () => {
    expect(isTichDetailHtmlForUrl(validTichDetailHtml, TICH_DETAIL_URL)).toBe(true);
    expect(isTichDetailHtmlForUrl(validTichDetailHtml, "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4101")).toBe(false);
    expect(isTichDetailHtmlForUrl(morssInterstitialHtml, TICH_DETAIL_URL)).toBe(false);
  });
});
