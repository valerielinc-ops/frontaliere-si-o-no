import { describe, expect, it, vi } from 'vitest';
import {
  buildUsiSourceDescription,
  classifyUsiFetchError,
  dropUsiFabricatedText,
  fetchPage,
  fetchUsiPageViaBrowser,
  looksLikeUsiListingHtml,
  stripUsiWrapper,
} from '../scripts/update-usi-jobs.mjs';

// Minimized from the stored job of
// content.usi.ch/…/hru-docenza-economics-market-design.pdf (slice of
// 2026-09-29): an English call wrapped by the former Italian header/footer,
// stored as the `it` source, with an English and a German copy of the wrapper.
const CALL_TEXT = 'The Università della Svizzera italiana (USI) is a young and dynamic institution, continuously evolving and embracing new challenges, guided by its three core values: quality, openness, and responsibility.\n\nFor information: Prof. Raphael Parchet (raphael.parchet@usi.ch) Director of the Bachelor program in Economics Lugano, 23 March 2026';
const WRAPPED_IT = [
  'Posizione aperta presso Università della Svizzera italiana.',
  'Dipartimento/Istituto: Faculty of Economics.',
  'Ruolo: Call for Applications for a Contract Lecturer Position in Economics and Market Design.',
  'Sede: Lugano, Svizzera (Canton Ticino).',
  CALL_TEXT,
  'Bando ufficiale disponibile in PDF.',
].join('\n\n');
const WRAPPED_EN = [
  'Open position at Università della Svizzera italiana.',
  'Department/Institute: Faculty of Economics.',
  'Role: Call for Applications for a Contract Lecturer Position in Economics and Market Design.',
  'Location: Lugano, Switzerland (Canton Ticino).',
  CALL_TEXT,
  'Official call available as PDF.',
].join('\n\n');

describe('buildUsiSourceDescription', () => {
  it('publishes the call text only, without the former header/footer', () => {
    const description = buildUsiSourceDescription(CALL_TEXT);
    expect(description).toContain('guided by its three core values');
    expect(description).not.toMatch(/Posizione aperta|Open position|Ruolo:|Bando ufficiale disponibile/);
  });

  it('gives a call without text no description instead of a paragraph about USI', () => {
    expect(buildUsiSourceDescription('')).toBe('');
  });
});

describe('stripUsiWrapper', () => {
  it('recovers the call text from a wrapped description', () => {
    expect(stripUsiWrapper(WRAPPED_IT)).toBe(CALL_TEXT);
    expect(stripUsiWrapper(WRAPPED_EN)).toBe(CALL_TEXT);
  });

  it('leaves an unwrapped call untouched', () => {
    expect(stripUsiWrapper(CALL_TEXT)).toBe(CALL_TEXT);
  });
});

describe('dropUsiFabricatedText', () => {
  it('drops every slot built from the wrapper and keys the call by its language', () => {
    const job: any = {
      sourceLang: 'it',
      description: WRAPPED_IT,
      descriptionByLocale: {
        it: WRAPPED_IT,
        en: WRAPPED_EN,
        de: 'Posizione aperta presso Università della Svizzera italiana. Dipartimento/Istituto: Fakultät für Wirtschaftswissenschaften.',
      },
    };
    expect(dropUsiFabricatedText(job)).toBe(true);
    expect(job.description).toBe(CALL_TEXT);
    expect(job.sourceLang).toBe('en');
    expect(job.descriptionByLocale).toEqual({ en: CALL_TEXT });
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a clean job alone', () => {
    const job: any = { sourceLang: 'en', description: CALL_TEXT, descriptionByLocale: { en: CALL_TEXT, it: 'Testo tradotto.' } };
    expect(dropUsiFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('Testo tradotto.');
    expect(job.needsRetranslation).toBeUndefined();
  });
});

describe('classifyUsiFetchError', () => {
  it('keeps transport failures distinct from parser/source failures', () => {
    expect(classifyUsiFetchError(Object.assign(new Error('request timed out'), { name: 'AbortError' }))).toEqual({
      lastFetchOutcome: 'connection_error',
      abortKind: 'connection-level-fetch',
    });
    expect(classifyUsiFetchError(Object.assign(new Error('HTTP 503'), { status: 503, retryExhausted: true }))).toEqual({
      lastFetchOutcome: 'exhausted_retry',
      abortKind: 'connection-level-fetch',
    });
  });

  it('keeps an observed endpoint failure out of the transport bucket', () => {
    expect(classifyUsiFetchError(Object.assign(new Error('HTTP 404'), { status: 404 }))).toEqual({
      lastFetchOutcome: 'feed_endpoint_unavailable',
      abortKind: 'no-jobs-parsed',
    });
  });

  it('recognizes an IP-level anti-bot response', () => {
    expect(classifyUsiFetchError(Object.assign(new Error('HTTP 403'), { status: 403 }))).toEqual({
      lastFetchOutcome: 'anti_bot_block',
      abortKind: 'connection-level-fetch',
    });
  });
});

describe('USI listing transport rescue', () => {
  const listingUrl = 'https://www.usi.ch/it/universita/collabora-con-noi/concorsi-e-offerte-di-lavoro';
  const listingHtml = '<html><body><h1>Concorsi e le offerte di lavoro</h1></body></html>';

  it('keeps a verified listing after a non-2xx browser navigation response', async () => {
    const page = {
      goto: vi.fn(async () => ({ ok: () => false, status: () => 403 })),
      content: vi.fn(async () => listingHtml),
    };
    const context = { newPage: vi.fn(async () => page) };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };

    await expect(fetchUsiPageViaBrowser(listingUrl, 1000, {
      launchBrowser: vi.fn(async () => browser),
    })).resolves.toBe(listingHtml);
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      viewport: { width: 1280, height: 720 },
      timezoneId: 'Europe/Zurich',
    }));
    expect(page.goto).toHaveBeenCalledWith(listingUrl, expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('uses a stealth browser and retries an unverified WAF document', async () => {
    const firstPage = {
      goto: vi.fn(async () => ({ ok: () => false, status: () => 403 })),
      content: vi.fn(async () => '<html><title>Access denied</title></html>'),
      close: vi.fn(async () => {}),
    };
    const secondPage = {
      goto: vi.fn(async () => ({ ok: () => false, status: () => 403 })),
      content: vi.fn(async () => listingHtml),
      close: vi.fn(async () => {}),
    };
    const context = {
      addInitScript: vi.fn(async () => {}),
      newPage: vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    const launchBrowser = vi.fn(async () => browser);
    const sleepImpl = vi.fn(async () => {});

    await expect(fetchUsiPageViaBrowser(listingUrl, 1000, {
      launchBrowser,
      attempts: 2,
      sleepImpl,
    })).resolves.toBe(listingHtml);

    expect(launchBrowser).toHaveBeenCalledWith({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2500);
    expect(firstPage.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('allows a browser challenge to settle before rejecting the document', async () => {
    const challenge = '<html><body>Just a moment... enable JavaScript and cookies to continue</body></html>';
    const page = {
      goto: vi.fn(async () => ({ ok: () => false, status: () => 403 })),
      content: vi.fn()
        .mockResolvedValueOnce(challenge)
        .mockResolvedValueOnce(listingHtml),
      waitForTimeout: vi.fn(async () => {}),
    };
    const context = { newPage: vi.fn(async () => page) };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };

    await expect(fetchUsiPageViaBrowser(listingUrl, 1000, {
      launchBrowser: vi.fn(async () => browser),
    })).resolves.toBe(listingHtml);
    expect(page.waitForTimeout).toHaveBeenCalledWith(2500);
  });

  it('uses a browser-like source UA and escalates a WAF response to Chromium', async () => {
    const fetchHtmlImpl = vi.fn(async () => {
      const error: any = new Error('HTTP 403');
      error.status = 403;
      throw error;
    });
    const browserFetchImpl = vi.fn(async () => listingHtml);

    await expect(fetchPage(listingUrl, 1000, { fetchHtmlImpl, browserFetchImpl })).resolves.toBe(listingHtml);

    expect(fetchHtmlImpl).toHaveBeenCalledWith(listingUrl, expect.objectContaining({
      headers: expect.objectContaining({
        'User-Agent': expect.stringMatching(/^Mozilla\/5\.0.*Chrome\/130\.0\.0\.0/),
        'Sec-Fetch-Mode': 'navigate',
      }),
    }));
    expect(browserFetchImpl).toHaveBeenCalledWith(listingUrl, 1000);
  });

  it('rescues a known 200 challenge but does not browser-fallback a real endpoint error', async () => {
    const browserFetchImpl = vi.fn(async () => listingHtml);
    const challenge = '<html><body>Just a moment... enable JavaScript and cookies to continue</body></html>';

    await expect(fetchPage(listingUrl, 1000, {
      fetchHtmlImpl: async () => challenge,
      browserFetchImpl,
    })).resolves.toBe(listingHtml);
    expect(browserFetchImpl).toHaveBeenCalledTimes(1);

    browserFetchImpl.mockClear();
    const notFound: any = new Error('HTTP 404');
    notFound.status = 404;
    await expect(fetchPage(listingUrl, 1000, {
      fetchHtmlImpl: async () => { throw notFound; },
      browserFetchImpl,
    })).rejects.toBe(notFound);
    expect(browserFetchImpl).not.toHaveBeenCalled();
  });

  it('rescues an unverified 200 listing response and fails closed when rescue is unverified', async () => {
    const browserFetchImpl = vi.fn(async () => null);
    const unverified = '<html><title>not found</title></html>';

    await expect(fetchPage(listingUrl, 1000, {
      fetchHtmlImpl: async () => unverified,
      browserFetchImpl,
    })).rejects.toMatchObject({ status: 403, antiBotChallenge: true });
    expect(browserFetchImpl).toHaveBeenCalledTimes(1);
  });

  it('recognizes a legitimate empty listing document without requiring a PDF', () => {
    expect(looksLikeUsiListingHtml(listingHtml)).toBe(true);
    expect(looksLikeUsiListingHtml('<html><body>Just a moment...</body></html>')).toBe(false);
  });
});
