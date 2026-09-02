import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ALBERGO_GARDENIA_COMPANY_DOMAIN,
  ALBERGO_GARDENIA_COMPANY_NAME,
  ALBERGO_GARDENIA_FETCH_BUDGET,
  ALBERGO_GARDENIA_HOME_URL,
  ALBERGO_GARDENIA_MAX_DEADLINE_OVERHANG_MS,
  ALBERGO_GARDENIA_KEY,
  ALBERGO_GARDENIA_SITEMAP_URL,
  ALBERGO_GARDENIA_TOTAL_BUDGET_MS,
  assertCompleteAlbergoGardeniaSnapshot,
  createAlbergoGardeniaBrowserTransport,
  createAlbergoGardeniaCleanEgressTransport,
  fetchAlbergoGardeniaSourcePage,
  assertNoGardeniaCareerSurface,
  fetchAllAlbergoGardeniaJobs,
  isAlbergoGardeniaJob,
  isTrustedDomain,
  parseAlbergoGardeniaSitemap,
} from '../scripts/lib/albergo-gardenia-job-parser.mjs';
import { buildExpiredEntry } from '../scripts/lib/expired-jobs-archive.mjs';
import { HOST_DELAY_MS } from '../scripts/lib/prospector/config.mjs';
import { isConnectionLevelFetchError } from '../scripts/lib/transient-fetch.mjs';
import { expiredJobSlugVariants } from '../build-plugins/shared/expiredSlugVariants';

const ROOT = path.resolve(import.meta.dirname, '..');
const FALSE_JOBS_FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/albergo-gardenia-false-jobs.json');
const RUNNER_PATH = path.join(ROOT, 'scripts/update-albergo-gardenia-jobs.mjs');

function representativeSitemap({ contentCount = 40, totalCount = 50 } = {}) {
  const urls = [];
  for (let i = 0; i < contentCount; i++) {
    const pathName = i % 5 === 0 ? 'index.php' : 'story.php';
    urls.push(`https://www.albergo-gardenia.ch/${pathName}?mid=${i + 1}&amp;amp;pid=1`);
  }
  for (let i = contentCount; i < totalCount; i++) {
    urls.push(`https://www.albergo-gardenia.ch/room.php?mid=${i + 1}&amp;amp;pid=1`);
  }
  return `${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
}

function gardeniaPage(extra = '') {
  return `<html><head><title>Villa Garni Gardenia - Caslano</title></head><body><main><h1>Gardenia</h1>${extra}</main></body></html>`;
}

describe('Albergo Gardenia authoritative crawler', () => {
  it('uses the real company identity and never claims HotellerieSuisse content', () => {
    expect(ALBERGO_GARDENIA_KEY).toBe('albergo-gardenia');
    expect(ALBERGO_GARDENIA_COMPANY_NAME).toBe('Albergo Gardenia');
    expect(ALBERGO_GARDENIA_COMPANY_DOMAIN).toBe('albergo-gardenia.ch');
    expect(isTrustedDomain('https://www.albergo-gardenia.ch/story.php?mid=1')).toBe(true);
    expect(isTrustedDomain('https://hotelleriesuisse.ch/it/politica/lavoro-e-istruzione')).toBe(false);
    expect(isAlbergoGardeniaJob({ companyKey: ALBERGO_GARDENIA_KEY })).toBe(true);
    expect(isAlbergoGardeniaJob({ company: 'Albergo Gardenia' })).toBe(true);
    expect(isAlbergoGardeniaJob({ url: 'https://www.albergo-gardenia.ch/story.php?mid=1' })).toBe(true);
    expect(isAlbergoGardeniaJob({ company: 'HotellerieSuisse', url: 'https://hotelleriesuisse.ch/jobs' })).toBe(false);
  });

  it('decodes the malformed live sitemap and proves a bounded content inventory', () => {
    const inventory = parseAlbergoGardeniaSitemap(representativeSitemap());
    expect(inventory.allUrls).toHaveLength(50);
    expect(inventory.contentUrls).toHaveLength(40);
    expect(inventory.contentUrls[0]).toContain('?mid=1&pid=1');
  });

  it('decodes <loc> entities identically in the injected Cloudflare script and the Node parser', () => {
    // Runs the injected script source in a plain `node` subprocess (as the
    // live crawler runs, `node scripts/update-*.mjs`, no bundler) instead of
    // `new Function` in-process — Vitest's SSR transform rewrites the ESM
    // imports the real `.toString()`'d functions close over, which would make
    // an in-process eval fail on rewritten identifiers that don't exist here.
    const cases = [
      'https://www.albergo-gardenia.ch/story.php?mid=1&amp;amp;pid=1',
      'https://www.albergo-gardenia.ch/index.php?mid=5&amp;pid=2',
      'Soci&egrave;t&eacute; caf&eacute;',
      '&#8220;quoted&#8221; &amp;amp; &#39;text&#39;',
      'plain text with no entities',
    ];
    const script = `
      import { gardeniaInjectedDecodeSource, decodeSitemapLocation } from ${JSON.stringify(
        path.join(ROOT, 'scripts/lib/albergo-gardenia-job-parser.mjs'),
      )};
      const decodeFromInjectedScript = new Function(\`return \${gardeniaInjectedDecodeSource()};\`)();
      const cases = ${JSON.stringify(cases)};
      const result = cases.map((raw) => [decodeFromInjectedScript(raw), decodeSitemapLocation(raw)]);
      process.stdout.write(JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const pairs = JSON.parse(output) as [string, string][];
    for (const [fromInjectedScript, fromNodeParser] of pairs) {
      expect(fromInjectedScript).toBe(fromNodeParser);
    }
  });

  it('returns only a marked authoritative zero after every content page succeeds', async () => {
    const sitemap = representativeSitemap();
    const fetchPage = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) {
        return { ok: true, status: 200, url, body: sitemap, host: new URL(url).hostname };
      }
      return { ok: true, status: 200, url, body: gardeniaPage(), host: new URL(url).hostname };
    });

    const first = await fetchAllAlbergoGardeniaJobs({ fetchPage });
    const second = await fetchAllAlbergoGardeniaJobs({ fetchPage });
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(Reflect.get(first, 'sourcePageCount')).toBe(40);
    expect(Reflect.get(first, 'discoveredCount')).toBe(0);
    expect(assertCompleteAlbergoGardeniaSnapshot(first)).toBe(true);
    expect(() => assertCompleteAlbergoGardeniaSnapshot([])).toThrow(/not a proven authoritative empty state/);
    expect(fetchPage).toHaveBeenCalledTimes(82);
  });

  it('retries a live-sized 69/56 inventory through the canonical alias with explicit budgets', async () => {
    const sitemap = representativeSitemap({ contentCount: 56, totalCount: 69 });
    const failedPrimary = new Set([
      ALBERGO_GARDENIA_SITEMAP_URL,
      'https://www.albergo-gardenia.ch/story.php?mid=17&pid=1',
    ]);
    const fetchPage = vi.fn(async (url: string) => {
      if (failedPrimary.has(url)) {
        return { ok: false, status: 0, url, body: '', host: new URL(url).hostname };
      }
      if (new URL(url).pathname === '/sitemap.xml') {
        return { ok: true, status: 200, url, body: sitemap, host: new URL(url).hostname };
      }
      return { ok: true, status: 200, url, body: gardeniaPage(), host: new URL(url).hostname };
    });

    const jobs = await fetchAllAlbergoGardeniaJobs({ fetchPage });
    expect(assertCompleteAlbergoGardeniaSnapshot(jobs)).toBe(true);
    expect(Reflect.get(jobs, 'sourcePageCount')).toBe(56);
    expect(fetchPage).toHaveBeenCalledWith(
      ALBERGO_GARDENIA_SITEMAP_URL,
      expect.objectContaining({
        ...ALBERGO_GARDENIA_FETCH_BUDGET.sitemap,
        accept: 'application/xml,text/xml,*/*',
      }),
    );
    expect(fetchPage).toHaveBeenCalledWith(
      'https://albergo-gardenia.ch/sitemap.xml',
      expect.objectContaining(ALBERGO_GARDENIA_FETCH_BUDGET.sitemap),
    );
    expect(fetchPage).toHaveBeenCalledWith(
      'https://www.albergo-gardenia.ch/story.php?mid=17&pid=1',
      expect.objectContaining(ALBERGO_GARDENIA_FETCH_BUDGET.content),
    );
    expect(fetchPage).toHaveBeenCalledWith(
      'https://albergo-gardenia.ch/story.php?mid=17&pid=1',
      expect.objectContaining(ALBERGO_GARDENIA_FETCH_BUDGET.content),
    );
  });

  it('switches once to bounded Chromium after both HTTP aliases exhaust and keeps that transport sticky', async () => {
    const sitemap = representativeSitemap();
    const fetchPage = vi.fn(async (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    }));
    const browserFetchPage = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      body: new URL(url).pathname === '/sitemap.xml' ? sitemap : gardeniaPage(),
      host: new URL(url).hostname,
    }));

    const jobs = await fetchAllAlbergoGardeniaJobs({ fetchPage, browserFetchPage });
    expect(assertCompleteAlbergoGardeniaSnapshot(jobs)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(browserFetchPage).toHaveBeenCalledTimes(41);
    expect(browserFetchPage).toHaveBeenNthCalledWith(
      1,
      ALBERGO_GARDENIA_SITEMAP_URL,
      expect.objectContaining(ALBERGO_GARDENIA_FETCH_BUDGET.sitemap),
    );
    expect(browserFetchPage).toHaveBeenNthCalledWith(
      2,
      'https://www.albergo-gardenia.ch/index.php?mid=1&pid=1',
      expect.objectContaining(ALBERGO_GARDENIA_FETCH_BUDGET.content),
    );
  });

  it('switches from exhausted runner Chromium to clean egress and keeps that rescue sticky', async () => {
    const sitemap = representativeSitemap();
    const failed = (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    });
    const fetchPage = vi.fn(async (url: string) => failed(url));
    const browserFetchPage = vi.fn(async (url: string) => failed(url));
    const cleanEgressFetchPage = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      body: new URL(url).pathname === '/sitemap.xml' ? sitemap : gardeniaPage(),
      host: new URL(url).hostname,
    }));

    const jobs = await fetchAllAlbergoGardeniaJobs({
      fetchPage,
      browserFetchPage,
      cleanEgressFetchPage,
    });
    expect(assertCompleteAlbergoGardeniaSnapshot(jobs)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(browserFetchPage).toHaveBeenCalledOnce();
    expect(cleanEgressFetchPage).toHaveBeenCalledTimes(41);
  });

  it('never turns an exhausted Chromium fallback into an authoritative empty snapshot', async () => {
    const failed = (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    });
    const fetchPage = vi.fn(async (url: string) => failed(url));
    const browserFetchPage = vi.fn(async (url: string) => failed(url));

    let failure: unknown;
    try {
      await fetchAllAlbergoGardeniaJobs({ fetchPage, browserFetchPage });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'ERR_GARDENIA_CONNECTION_EXHAUSTED',
      retryable: true,
    });
    expect(isConnectionLevelFetchError(failure)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(browserFetchPage).toHaveBeenCalledOnce();
  });

  it('fails hard when Chromium receives HTTP or redirects to another Gardenia resource', async () => {
    const failedDirect = vi.fn(async (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    }));
    const httpFailure = vi.fn(async (url: string) => ({
      ok: false,
      status: 503,
      url,
      body: '',
      host: new URL(url).hostname,
    }));
    await expect(fetchAllAlbergoGardeniaJobs({
      fetchPage: failedDirect,
      browserFetchPage: httpFailure,
    })).rejects.toMatchObject({ status: 503 });

    const redirected = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url: 'https://www.albergo-gardenia.ch/',
      body: representativeSitemap(),
      host: new URL(url).hostname,
    }));
    await expect(fetchAllAlbergoGardeniaJobs({
      fetchPage: failedDirect,
      browserFetchPage: redirected,
    })).rejects.toMatchObject({ code: 'ERR_GARDENIA_RESOURCE_IDENTITY' });
  });

  it('keeps the Chromium transport scoped to canonical Gardenia documents', async () => {
    let routeHandler: ((route: any) => Promise<void>) | undefined;
    const response = {
      status: vi.fn(() => 200),
      url: vi.fn(() => ALBERGO_GARDENIA_SITEMAP_URL),
      body: vi.fn(async () => Buffer.from(representativeSitemap())),
    };
    const page = {
      goto: vi.fn(async () => response),
      close: vi.fn(async () => {}),
    };
    const context = {
      route: vi.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => {
        routeHandler = handler;
      }),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    const launchBrowserImpl = vi.fn(async () => browser);
    let now = 1_000;
    const sleepImpl = vi.fn(async (ms: number) => { now += ms; });
    const transport = createAlbergoGardeniaBrowserTransport({
      launchBrowserImpl,
      nowImpl: () => now,
      sleepImpl,
    });

    const result = await transport.fetchPage(ALBERGO_GARDENIA_SITEMAP_URL, { timeoutMs: 12_345 });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      url: ALBERGO_GARDENIA_SITEMAP_URL,
    });
    expect(page.goto).toHaveBeenCalledWith(ALBERGO_GARDENIA_SITEMAP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 12_345,
    });
    await transport.fetchPage('https://www.albergo-gardenia.ch/story.php?mid=1&pid=1');
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(HOST_DELAY_MS);

    const trustedRoute = {
      request: () => ({
        resourceType: () => 'document',
        url: () => 'https://albergo-gardenia.ch/story.php?mid=1&pid=1',
      }),
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    };
    const foreignRoute = {
      request: () => ({ resourceType: () => 'document', url: () => 'https://attacker.example/' }),
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    };
    const assetRoute = {
      request: () => ({ resourceType: () => 'script', url: () => ALBERGO_GARDENIA_HOME_URL }),
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    };
    await routeHandler?.(trustedRoute);
    await routeHandler?.(foreignRoute);
    await routeHandler?.(assetRoute);
    expect(trustedRoute.continue).toHaveBeenCalledOnce();
    expect(foreignRoute.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(assetRoute.abort).toHaveBeenCalledWith('blockedbyclient');

    const rejected = await transport.fetchPage('https://attacker.example/jobs');
    expect(rejected).toMatchObject({ ok: false, status: 0, policyBlocked: true });
    expect(launchBrowserImpl).toHaveBeenCalledOnce();
    await transport.close();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('does not memoize a failed browser launch across fetchPage() calls', async () => {
    const response = {
      status: vi.fn(() => 200),
      url: vi.fn(() => ALBERGO_GARDENIA_SITEMAP_URL),
      body: vi.fn(async () => Buffer.from(representativeSitemap())),
    };
    const page = {
      goto: vi.fn(async () => response),
      close: vi.fn(async () => {}),
    };
    const context = {
      route: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    const launchBrowserImpl = vi.fn()
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockImplementationOnce(async () => browser);
    const transport = createAlbergoGardeniaBrowserTransport({
      launchBrowserImpl,
      nowImpl: () => 1_000,
      sleepImpl: vi.fn(async () => {}),
    });

    const failedResponse = await transport.fetchPage(ALBERGO_GARDENIA_SITEMAP_URL);
    expect(failedResponse).toMatchObject({ ok: false, error: 'launch failed' });
    const result = await transport.fetchPage(ALBERGO_GARDENIA_SITEMAP_URL);
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(launchBrowserImpl).toHaveBeenCalledTimes(2);
  });

  it('loads one Cloudflare browser inventory and binds every clean-egress resource identity', async () => {
    const sourceUrl = 'https://www.albergo-gardenia.ch/story.php?mid=142&pid=11';
    const snapshot = {
      homepageUrl: ALBERGO_GARDENIA_HOME_URL,
      sitemap: {
        status: 200,
        url: ALBERGO_GARDENIA_SITEMAP_URL,
        body: representativeSitemap(),
      },
      pages: [{
        requestedUrl: sourceUrl,
        status: 200,
        url: sourceUrl,
        body: gardeniaPage(),
      }],
    };
    const escaped = JSON.stringify(snapshot)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: `<pre id="gardenia-clean-egress-source">${escaped}</pre>`,
    }), { status: 200 }));
    const transport = createAlbergoGardeniaCleanEgressTransport({
      fetchImpl,
      gardeniaCfAccount: 'account-123',
      gardeniaCfKey: 'global-key',
      gardeniaCfEmail: 'owner@example.test',
    });

    const sitemap = await transport.fetchPage(ALBERGO_GARDENIA_SITEMAP_URL);
    const response = await transport.fetchPage(sourceUrl);
    expect(sitemap).toMatchObject({
      ok: true,
      status: 200,
      url: ALBERGO_GARDENIA_SITEMAP_URL,
    });
    expect(response).toMatchObject({
      ok: true,
      status: 200,
      url: sourceUrl,
      host: 'www.albergo-gardenia.ch',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [apiUrl, options] = fetchImpl.mock.calls[0];
    expect(apiUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-123/browser-rendering/content',
    );
    expect(options.headers).toMatchObject({
      'X-Auth-Email': 'owner@example.test',
      'X-Auth-Key': 'global-key',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toMatchObject({
      url: ALBERGO_GARDENIA_HOME_URL,
      waitForSelector: {
        selector: '#gardenia-clean-egress-source, #gardenia-clean-egress-error',
      },
    });
  });

  it('does not memoize a failed loadInventory() across fetchPage() calls', async () => {
    const sourceUrl = 'https://www.albergo-gardenia.ch/story.php?mid=142&pid=11';
    const snapshot = {
      homepageUrl: ALBERGO_GARDENIA_HOME_URL,
      sitemap: {
        status: 200,
        url: ALBERGO_GARDENIA_SITEMAP_URL,
        body: representativeSitemap(),
      },
      pages: [{
        requestedUrl: sourceUrl,
        status: 200,
        url: sourceUrl,
        body: gardeniaPage(),
      }],
    };
    const escaped = JSON.stringify(snapshot)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        success: true,
        result: `<pre id="gardenia-clean-egress-source">${escaped}</pre>`,
      }), { status: 200 }));
    const transport = createAlbergoGardeniaCleanEgressTransport({
      fetchImpl,
      gardeniaCfAccount: 'account-123',
      gardeniaCfKey: 'global-key',
      gardeniaCfEmail: 'owner@example.test',
    });

    const failedResponse = await transport.fetchPage(sourceUrl);
    expect(failedResponse).toMatchObject({ ok: false, error: 'network error' });
    const response = await transport.fetchPage(sourceUrl);
    expect(response).toMatchObject({
      ok: true,
      status: 200,
      url: sourceUrl,
      host: 'www.albergo-gardenia.ch',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the clean-egress browser loses homepage identity or a resource', async () => {
    const sourceUrl = 'https://www.albergo-gardenia.ch/story.php?mid=142&pid=11';
    const envelope = (snapshot: object) => {
      const escaped = JSON.stringify(snapshot)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return new Response(JSON.stringify({
        success: true,
        result: `<pre id="gardenia-clean-egress-source">${escaped}</pre>`,
      }), { status: 200 });
    };
    const mismatchedHomepage = createAlbergoGardeniaCleanEgressTransport({
      fetchImpl: vi.fn(async () => envelope({
        homepageUrl: 'https://attacker.example/',
        sitemap: {},
        pages: [],
      })),
      gardeniaCfAccount: 'account-123',
      gardeniaCfKey: 'global-key',
      gardeniaCfEmail: 'owner@example.test',
    });
    await expect(mismatchedHomepage.fetchPage(sourceUrl)).resolves.toMatchObject({
      ok: false,
      policyBlocked: true,
      error: expect.stringMatching(/homepage identity mismatch/),
    });

    const omittedResource = createAlbergoGardeniaCleanEgressTransport({
      fetchImpl: vi.fn(async () => envelope({
        homepageUrl: ALBERGO_GARDENIA_HOME_URL,
        sitemap: {},
        pages: [],
      })),
      gardeniaCfAccount: 'account-123',
      gardeniaCfKey: 'global-key',
      gardeniaCfEmail: 'owner@example.test',
    });
    await expect(omittedResource.fetchPage(sourceUrl)).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: expect.stringMatching(/omitted the requested resource/),
    });
  });

  it('turns a missing Chromium executable into a safe connection-level result', async () => {
    const transport = createAlbergoGardeniaBrowserTransport({
      launchBrowserImpl: vi.fn(async () => {
        throw new Error("Executable doesn't exist");
      }),
      sleepImpl: vi.fn(async () => {}),
    });
    const response = await transport.fetchPage(ALBERGO_GARDENIA_SITEMAP_URL);
    expect(response).toMatchObject({
      ok: false,
      status: 0,
      url: ALBERGO_GARDENIA_SITEMAP_URL,
    });
    expect(response.error).toMatch(/Executable doesn't exist/);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it.each([
    ['robots denial', { ok: false, status: 0, blockedByRobots: true }],
    ['URL-policy denial', { ok: false, status: 0, policyBlocked: true }],
    ['HTTP response', { ok: false, status: 503 }],
  ])('does not cross the host alias for %s', async (_label, result) => {
    const fetchPage = vi.fn(async (url: string) => ({ ...result, url, body: '', host: new URL(url).hostname }));
    const browserFetchPage = vi.fn();
    const response = await fetchAlbergoGardeniaSourcePage(ALBERGO_GARDENIA_SITEMAP_URL, {
      kind: 'sitemap',
      fetchPage,
      browserFetchPage,
    });
    expect(response).toEqual(expect.objectContaining(result));
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(browserFetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ['robots denial', { ok: false, status: 0, blockedByRobots: true }],
    ['URL-policy denial', { ok: false, status: 0, policyBlocked: true }],
    ['HTTP response', { ok: false, status: 503 }],
  ])('does not classify deterministic %s as a connection-level soft exit', async (_label, result) => {
    const fetchPage = vi.fn(async (url: string) => ({ ...result, url, body: '', host: new URL(url).hostname }));
    let failure: unknown;
    try {
      await fetchAllAlbergoGardeniaJobs({ fetchPage });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status: result.status });
    expect(isConnectionLevelFetchError(failure)).toBe(false);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('keeps connection exhaustion distinct from an authoritative source zero', async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    }));
    let failure: unknown;
    try {
      await fetchAllAlbergoGardeniaJobs({ fetchPage });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'ERR_GARDENIA_CONNECTION_EXHAUSTED',
      retryable: true,
    });
    expect(failure).not.toHaveProperty('status');
    expect(isConnectionLevelFetchError(failure)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not invent an apex/www fallback for another trusted subdomain', async () => {
    const sourceUrl = 'https://careers.albergo-gardenia.ch/story.php?mid=1&pid=1';
    const fetchPage = vi.fn(async (url: string) => ({
      ok: false,
      status: 0,
      url,
      body: '',
      host: new URL(url).hostname,
    }));
    const response = await fetchAlbergoGardeniaSourcePage(sourceUrl, { fetchPage });
    expect(response).toMatchObject({ ok: false, status: 0, url: sourceUrl });
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('enforces a crawler-wide deadline with an explicit connection-level outcome', async () => {
    let now = 1_000;
    const fetchPage = vi.fn(async (url: string) => {
      now = 1_101;
      return {
        ok: true,
        status: 200,
        url,
        body: representativeSitemap(),
        host: new URL(url).hostname,
      };
    });
    await expect(fetchAlbergoGardeniaSourcePage(ALBERGO_GARDENIA_SITEMAP_URL, {
      kind: 'sitemap',
      fetchPage,
      deadlineAt: 1_100,
      nowImpl: () => now,
    })).rejects.toMatchObject({
      code: 'ERR_GARDENIA_CONNECTION_EXHAUSTED',
      retryable: true,
    });
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('keeps the total Gardenia transport bound below the Group19 job timeout', () => {
    const group19TimeoutMs = 340 * 60_000;
    expect(ALBERGO_GARDENIA_TOTAL_BUDGET_MS).toBe(30 * 60_000);
    expect(ALBERGO_GARDENIA_TOTAL_BUDGET_MS + ALBERGO_GARDENIA_MAX_DEADLINE_OVERHANG_MS)
      .toBeLessThan(group19TimeoutMs);
    expect(ALBERGO_GARDENIA_MAX_DEADLINE_OVERHANG_MS).toBe(115_000);
  });

  it.each([
    ['truncated sitemap', representativeSitemap({ contentCount: 39, totalCount: 49 }), /sitemap is incomplete/],
    ['foreign URL', representativeSitemap().replace('https://www.albergo-gardenia.ch/story.php', 'https://attacker.example/story.php'), /escaped the trusted source/],
    ['new careers URL', representativeSitemap().replace('/room.php?mid=41', '/jobs?mid=41'), /career surface/],
  ])('fails closed on %s', (_label, xml, expected) => {
    expect(() => parseAlbergoGardeniaSitemap(xml)).toThrow(expected);
  });

  it('fails closed when one authoritative page is unreachable or redirects by path', async () => {
    const sitemap = representativeSitemap();
    const unreachable = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) {
        return { ok: true, status: 200, url, body: sitemap, host: new URL(url).hostname };
      }
      if (url.includes('mid=9')) {
        return { ok: false, status: 500, url, body: '', host: new URL(url).hostname };
      }
      return { ok: true, status: 200, url, body: gardeniaPage(), host: new URL(url).hostname };
    });
    await expect(fetchAllAlbergoGardeniaJobs({ fetchPage: unreachable })).rejects.toThrow(/content fetch failed/);

    const redirected = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) {
        return { ok: true, status: 200, url, body: sitemap, host: new URL(url).hostname };
      }
      const responseUrl = url.includes('mid=9') ? url.replace('mid=9', 'mid=999') : url;
      return {
        ok: true,
        status: 200,
        url: responseUrl,
        body: gardeniaPage(),
        host: new URL(responseUrl).hostname,
      };
    });
    await expect(fetchAllAlbergoGardeniaJobs({ fetchPage: redirected })).rejects.toThrow(
      /content identity mismatch/,
    );

    const sitemapRedirected = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      url: url === ALBERGO_GARDENIA_SITEMAP_URL ? 'https://albergo-gardenia.ch/' : url,
      body: url === ALBERGO_GARDENIA_SITEMAP_URL ? sitemap : gardeniaPage(),
      host: new URL(url).hostname,
    }));
    await expect(fetchAllAlbergoGardeniaJobs({ fetchPage: sitemapRedirected })).rejects.toThrow(
      /sitemap identity mismatch/,
    );
  });

  it('fails closed on missing source identity, career navigation, or JobPosting', () => {
    expect(() => assertNoGardeniaCareerSurface('<html><title>Unrelated site</title></html>', 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/source identity is missing/);
    expect(() => assertNoGardeniaCareerSurface(gardeniaPage('<a href="/lavora-con-noi">Lavora con noi</a>'), 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/career signal detected/);
    expect(() => assertNoGardeniaCareerSurface(gardeniaPage('<script type="application/ld+json">{"@type":"JobPosting"}</script>'), 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/JobPosting detected/);
  });

  it('opts the runner into source-validated authoritative empty publishing', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain('validateAuthoritativeSnapshot: assertCompleteAlbergoGardeniaSnapshot');
    expect(source).toContain('allowAuthoritativeEmptySnapshot: true');
  });

  it('retires exactly the three false identities through reachable archived routes', () => {
    const jobs = JSON.parse(fs.readFileSync(FALSE_JOBS_FIXTURE_PATH, 'utf8'));
    expect(jobs.map((job: { id: string }) => job.id).sort()).toEqual([
      'albergo-gardenia-261a6e43b839',
      'albergo-gardenia-a58372a459dc',
      'albergo-gardenia-bf0d61d0f1cd',
    ]);

    for (const job of jobs) {
      const before = new Set(expiredJobSlugVariants(job));
      const archived = buildExpiredEntry(job);
      const after = new Set(expiredJobSlugVariants(archived));
      expect(after).toEqual(before);
      for (const slug of before) {
        expect(expiredJobSlugVariants(archived)).toContain(slug);
      }
    }
  });

});
