/**
 * playwright-runtime.fetchWithRateLimit retry semantics.
 *
 * Every Playwright-backed ATS crawler (Workday/SuccessFactors/Greenhouse-render/
 * ostendis/…) navigates through this single helper. A transient page.goto
 * timeout (#1308 Kantonsspital Obwalden) previously bricked the run on the first
 * attempt. The generalisation wraps navigation in the shared bounded retry —
 * but ONLY NavigationTimeout is transient: a persistent AntiBotBlockError
 * (403/429/522 / challenge title) must still fail fast so we don't hammer the
 * origin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWithRateLimit,
  NavigationTimeout,
  AntiBotBlockError,
} from '../scripts/lib/ats-clients/playwright-runtime.mjs';

interface FakePage {
  goto: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makePage(gotoImpl: () => Promise<unknown>, title = ''): FakePage {
  return {
    goto: vi.fn(gotoImpl),
    title: vi.fn(async () => title),
    close: vi.fn(async () => {}),
  };
}

function makeContext(pages: FakePage[]) {
  let i = 0;
  return {
    newPage: vi.fn(async () => pages[i++]),
  };
}

beforeEach(() => {
  process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
});

afterEach(() => {
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  vi.restoreAllMocks();
});

const okResponse = { status: () => 200 };

describe('fetchWithRateLimit retry', () => {
  it('retries a transient NavigationTimeout then returns the page', async () => {
    const failing = makePage(async () => {
      throw new Error('page.goto: Timeout 60000ms exceeded.');
    });
    const succeeding = makePage(async () => okResponse, 'Jobs at Acme');
    const ctx = makeContext([failing, succeeding]);

    const page = await fetchWithRateLimit(ctx as never, 'https://acme.test/jobs', { minDelayMs: 0 });

    expect(page).toBe(succeeding);
    expect(ctx.newPage).toHaveBeenCalledTimes(2); // one per attempt
    expect(failing.close).toHaveBeenCalled(); // failed attempt's page is closed
  });

  it('does NOT retry an AntiBotBlockError (403) — fails fast', async () => {
    const blocked = makePage(async () => ({ status: () => 403 }), 'Just a moment...');
    const ctx = makeContext([blocked, blocked]);

    await expect(
      fetchWithRateLimit(ctx as never, 'https://acme.test/jobs', { minDelayMs: 0 }),
    ).rejects.toBeInstanceOf(AntiBotBlockError);

    expect(ctx.newPage).toHaveBeenCalledTimes(1); // no retry on anti-bot
  });

  it('exhausts retries on persistent NavigationTimeout then throws', async () => {
    const pages = Array.from({ length: 5 }, () =>
      makePage(async () => {
        throw new Error('Navigation timeout of 60000 ms exceeded');
      }),
    );
    const ctx = makeContext(pages);

    await expect(
      fetchWithRateLimit(ctx as never, 'https://acme.test/jobs', { minDelayMs: 0 }),
    ).rejects.toBeInstanceOf(NavigationTimeout);

    // 1 initial + 3 default retries = 4 attempts
    expect(ctx.newPage).toHaveBeenCalledTimes(4);
  });
});
