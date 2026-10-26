import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFachkraftSnapshot,
  validateFachkraftAuthoritativeSnapshot,
} from '../scripts/lib/fachkraft-job-parser.mjs';
import { isConnectionLevelFetchError } from '../scripts/lib/transient-fetch.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const LISTING_URL = 'https://www.fachkraft.ch/stellen/';
const DETAIL_URL = 'https://www.fachkraft.ch/stellen/polymechaniker-in-luzern-123/';
const SECOND_DETAIL_URL = 'https://www.fachkraft.ch/stellen/elektriker-in-luzern-456/';
const TITLE = 'Polymechaniker/in';
const DESCRIPTION = Array.from({ length: 55 }, (_, index) => `detail${index + 1}`).join(' ');

const listingHtml = (detailUrls = [DETAIL_URL]) => `
  <html><body><div data-count="${detailUrls.length}"><ul>
    ${detailUrls.map((detailUrl) => `<li class="ff-job-entry" data-canton="LU">
      <a href="${detailUrl}">${TITLE}</a>
      <p class="ff-job-entry__description">Teaser text for the vacancy</p>
      <div class="ff-job-entry__region">Region: Luzern</div>
    </li>`).join('')}
  </ul></div></body></html>`;

const compactListingHtml = () => `<li class="ff-job-entry"><a href="${DETAIL_URL}">${TITLE}</a></li>`;

const detailHtml = () => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: TITLE,
  description: DESCRIPTION,
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Luzern',
      addressRegion: 'LU',
      addressCountry: 'CH',
    },
  },
})}</script></head><body></body></html>`;

const runtimeOptions = {
  spec: {
    companyKey: 'fachkraft',
    companyName: 'fachkraft.ch GmbH',
    seedUrls: [LISTING_URL],
  },
  requestTimeoutMs: 40,
  runTimeoutMs: 1_000,
  retries: 1,
  retryBaseMs: 0,
  detailWorkers: 1,
  lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  sleepImpl: async () => {},
  existingJobs: [],
};

describe('fachkraft crawler transport recovery', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('rescues a connection-level listing failure through Jina before parsing', async () => {
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      if (target === DETAIL_URL) return new Response(detailHtml(), { status: 200 });
      throw new Error(`unexpected fetch target: ${target}`);
    });
    const fetchJinaImpl = vi.fn().mockResolvedValue(listingHtml());

    const snapshot = await fetchFachkraftSnapshot({
      ...runtimeOptions,
      fetchImpl,
      fetchJinaImpl,
    });

    expect(fetchJinaImpl).toHaveBeenCalledWith(LISTING_URL, expect.objectContaining({
      timeoutMs: runtimeOptions.requestTimeoutMs,
    }));
    expect(snapshot).toHaveLength(1);
    expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
  });

  it('uses the bounded browser rescue after a WAF response and failed Jina rescue', async () => {
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) return new Response('blocked by WAF', { status: 406 });
      if (target === DETAIL_URL) return new Response(detailHtml(), { status: 200 });
      throw new Error(`unexpected fetch target: ${target}`);
    });
    const fetchJinaImpl = vi.fn().mockResolvedValue(null);
    const fetchBrowserImpl = vi.fn().mockResolvedValue(listingHtml());

    const snapshot = await fetchFachkraftSnapshot({
      ...runtimeOptions,
      fetchImpl,
      fetchJinaImpl,
      fetchBrowserImpl,
    });

    expect(fetchJinaImpl).toHaveBeenCalledOnce();
    expect(fetchBrowserImpl).toHaveBeenCalledWith(LISTING_URL, expect.objectContaining({
      timeoutMs: runtimeOptions.requestTimeoutMs,
      signal: expect.any(AbortSignal),
    }));
    expect(snapshot).toHaveLength(1);
    expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
  });

  it('rejects a short Jina error body before falling through to browser rescue', async () => {
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) return new Response('blocked by WAF', { status: 403 });
      if (target === DETAIL_URL) return new Response(detailHtml(), { status: 200 });
      throw new Error(`unexpected fetch target: ${target}`);
    });
    const fetchJinaImpl = vi.fn().mockResolvedValue('temporary upstream response '.repeat(4));
    const fetchBrowserImpl = vi.fn().mockResolvedValue(listingHtml());

    const snapshot = await fetchFachkraftSnapshot({
      ...runtimeOptions,
      fetchImpl,
      fetchJinaImpl,
      fetchBrowserImpl,
    });

    expect(fetchJinaImpl).toHaveBeenCalledOnce();
    expect(fetchBrowserImpl).toHaveBeenCalledWith(LISTING_URL, expect.objectContaining({
      timeoutMs: runtimeOptions.requestTimeoutMs,
      signal: expect.any(AbortSignal),
    }));
    expect(snapshot).toHaveLength(1);
    expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
  });

  it('accepts a valid compact browser rescue body without applying the Jina length floor', async () => {
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) return new Response('blocked by WAF', { status: 403 });
      if (target === DETAIL_URL) return new Response(detailHtml(), { status: 200 });
      throw new Error(`unexpected fetch target: ${target}`);
    });
    const fetchJinaImpl = vi.fn().mockResolvedValue(null);
    const fetchBrowserImpl = vi.fn().mockResolvedValue(compactListingHtml());

    const snapshot = await fetchFachkraftSnapshot({
      ...runtimeOptions,
      fetchImpl,
      fetchJinaImpl,
      fetchBrowserImpl,
    });

    expect(compactListingHtml().length).toBeLessThan(200);
    expect(snapshot).toHaveLength(1);
    expect(validateFachkraftAuthoritativeSnapshot(snapshot)).toBe(true);
  });

  it('cancels a pending browser rescue on sibling detail abort and preserves its reason', async () => {
    let browserStartedResolve: (() => void) | undefined;
    const browserStarted = new Promise<void>((resolve) => { browserStartedResolve = resolve; });
    let browserAbortReason: unknown;
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) return new Response(listingHtml([DETAIL_URL, SECOND_DETAIL_URL]), { status: 200 });
      if (target === DETAIL_URL) return new Response('blocked by WAF', { status: 406 });
      if (target === SECOND_DETAIL_URL) {
        await browserStarted;
        return new Response('broken detail', { status: 500 });
      }
      throw new Error(`unexpected fetch target: ${target}`);
    });
    const fetchJinaImpl = vi.fn().mockResolvedValue(null);
    const fetchBrowserImpl = vi.fn(async (_url: string, { signal }: { signal: AbortSignal }) => {
      browserStartedResolve?.();
      return new Promise<string>((_resolve, reject) => {
        const onAbort = () => {
          browserAbortReason = signal.reason;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    let failure: unknown;
    try {
      await fetchFachkraftSnapshot({
        ...runtimeOptions,
        detailWorkers: 2,
        fetchImpl,
        fetchJinaImpl,
        fetchBrowserImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBe(browserAbortReason);
    expect(fetchBrowserImpl).toHaveBeenCalledOnce();
    expect(fetchBrowserImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps an exhausted connection failure classifiable for the standard soft-exit', async () => {
    const fetchImpl = vi.fn(async (target: string) => {
      if (target.endsWith('/robots.txt')) return new Response('', { status: 200 });
      if (target === LISTING_URL) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      throw new Error(`unexpected fetch target: ${target}`);
    });

    let failure: any;
    try {
      await fetchFachkraftSnapshot({
        ...runtimeOptions,
        fetchImpl,
        fetchJinaImpl: vi.fn().mockResolvedValue(null),
        fetchBrowserImpl: undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure.status).toBeUndefined();
    expect(failure.retryable).toBe(true);
    expect(isConnectionLevelFetchError(failure)).toBe(true);
  });
});
