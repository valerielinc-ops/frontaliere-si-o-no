import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launchStealthOrChromiumMock } = vi.hoisted(() => ({
  launchStealthOrChromiumMock: vi.fn(),
}));

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: launchStealthOrChromiumMock,
}));

import {
  createWorkdayRequestContext,
  fetchWorkdayJobDetail,
  fetchWorkdayJobs,
  resetWorkdayImplicitRateLimitStateForTests,
  WorkdayRateLimitError,
} from '../scripts/lib/ats-clients/workday-client.mjs';

// #20279: Workday answers HTTP 429 to GitHub runner egress. The #19723 contract
// forbids replaying an exhausted 429 on the SAME egress (browser included); the
// source relay leaves from another egress, so it is admitted, but only after
// the direct circuit opens, sequentially per tenant, inside finite budgets, and
// halted at the first 429 or relay failure. No browser is ever involved.

const API_BASE = 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon';
const LISTING_URL = `${API_BASE}/jobs`;
const LISTING_BODY = JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
const LISTING_JSON = { total: 1, jobPostings: [{ title: 'Engineer', externalPath: '/job/Zurich/Engineer_R-1' }] };

function upstream(status: number, payload: unknown = {}) {
  return { status, text: typeof payload === 'string' ? payload : JSON.stringify(payload), upstream: true };
}

function openContext(relayFallback: unknown, extra: Record<string, unknown> = {}) {
  return createWorkdayRequestContext(API_BASE, {
    relayFallback,
    browserFallback: null,
    fallbackCooldownMs: 0,
    egressStateDir: null,
    relayBackoffMs: 0,
    relaySleep: async () => {},
    ...extra,
  } as never);
}

// One direct 429 (below the circuit threshold of 2) with no relay involvement:
// the next request of the context takes the second 429, which opens the
// circuit and is the first one the relay may answer.
async function openCircuit(context: ReturnType<typeof openContext>) {
  await expect(context.request(`${API_BASE}/job/Zurich/Probe_R0`, {
    retries: 0,
    retryBaseMs: 0,
  })).rejects.toBeInstanceOf(WorkdayRateLimitError);
}

beforeEach(() => {
  vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
  vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
});

afterEach(() => {
  resetWorkdayImplicitRateLimitStateForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  launchStealthOrChromiumMock.mockReset();
});

describe('Workday source-relay fallback (#20279, compatible with #19723)', () => {
  it('sends the listing through the relay once two direct 429s opened the circuit', async () => {
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', directFetch);
    const relayFallback = vi.fn().mockResolvedValue(upstream(200, LISTING_JSON));
    const context = openContext(relayFallback);

    try {
      await openCircuit(context);
      expect(relayFallback).not.toHaveBeenCalled();

      const data = await context.request(LISTING_URL, {
        method: 'POST',
        body: LISTING_BODY,
        retries: 0,
        retryBaseMs: 0,
      });

      expect(data).toEqual(LISTING_JSON);
      expect(directFetch).toHaveBeenCalledTimes(2);
      expect(relayFallback).toHaveBeenCalledTimes(1);
      expect(relayFallback).toHaveBeenCalledWith(expect.objectContaining({
        url: LISTING_URL,
        method: 'POST',
        body: LISTING_BODY,
      }));
    } finally {
      await context.close();
    }
  });

  it('keeps routing the rest of the tenant through the relay without new direct attempts', async () => {
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', directFetch);
    const relayFallback = vi.fn()
      .mockResolvedValueOnce(upstream(200, LISTING_JSON))
      .mockResolvedValueOnce(upstream(200, { jobPostingInfo: { jobDescription: '<p>Detail</p>' } }));
    const context = openContext(relayFallback);

    try {
      await openCircuit(context);
      await context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY });
      const directBefore = directFetch.mock.calls.length;
      const detail = await context.request(`${API_BASE}/job/Zurich/Engineer_R-1`, { method: 'GET' });

      expect(detail).toEqual({ jobPostingInfo: { jobDescription: '<p>Detail</p>' } });
      expect(directFetch).toHaveBeenCalledTimes(directBefore);
      expect(relayFallback).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
    }
  });

  it('returns the listing from fetchWorkdayJobs when the relay answers 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn().mockResolvedValue(upstream(200, LISTING_JSON));
    const context = openContext(relayFallback);

    try {
      await openCircuit(context);
      const jobs: unknown[] = [];
      for await (const posting of fetchWorkdayJobs(API_BASE, {
        requestContext: context,
        minDelayMs: 0,
        maxPages: 1,
      } as never)) jobs.push(posting);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ title: 'Engineer' });
    } finally {
      await context.close();
    }
  });

  it('stops at the first relay 429 with WorkdayRateLimitError and never asks the relay again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn().mockResolvedValue(upstream(429, { error: 'upstream_rate_limited' }));
    const context = openContext(relayFallback);

    try {
      await openCircuit(context);
      await expect(context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY }))
        .rejects.toMatchObject({ name: 'WorkdayRateLimitError', circuitOpen: true });
      await expect(context.request(`${API_BASE}/job/Zurich/Engineer_R-1`, { method: 'GET' }))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      expect(relayFallback).toHaveBeenCalledTimes(1);
    } finally {
      await context.close();
    }
  });

  it.each([
    ['unavailable (not configured, unauthenticated or capped)', null],
    ['a relay-own error (HTTP 403, not marked upstream)', { status: 403, text: '{"error":"forbidden"}' }],
    ['a relay that throws', 'throw'],
  ])('stops the tenant when the relay is %s and surfaces the typed 429', async (_label, outcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn(async () => {
      if (outcome === 'throw') throw new Error('relay down');
      return outcome;
    });
    const context = openContext(relayFallback);

    try {
      await openCircuit(context);
      await expect(context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY }))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      await expect(context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY }))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      expect(relayFallback).toHaveBeenCalledTimes(1);
    } finally {
      await context.close();
    }
  });

  it('never exceeds the per-tenant listing and detail budgets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn().mockResolvedValue(upstream(200, { ok: true }));
    const context = openContext(relayFallback, { listingRelayBudget: 2, detailRelayBudget: 1 });

    try {
      await openCircuit(context);
      for (let page = 0; page < 5; page += 1) {
        const outcome = context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY });
        if (page < 2) await expect(outcome).resolves.toEqual({ ok: true });
        else await expect(outcome).rejects.toBeInstanceOf(WorkdayRateLimitError);
      }
      for (let detail = 0; detail < 4; detail += 1) {
        const outcome = context.request(`${API_BASE}/job/Zurich/D_R${detail}`, { method: 'GET' });
        if (detail < 1) await expect(outcome).resolves.toEqual({ ok: true });
        else await expect(outcome).rejects.toBeInstanceOf(WorkdayRateLimitError);
      }
      expect(relayFallback).toHaveBeenCalledTimes(3);
    } finally {
      await context.close();
    }
  });

  it('shares the budget across contexts of one tenant and caps an oversized override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn().mockResolvedValue(upstream(200, { ok: true }));
    const first = openContext(relayFallback, { detailRelayBudget: 1_000_000 });
    const second = openContext(relayFallback, { detailRelayBudget: 1_000_000 });

    try {
      await openCircuit(first);
      // The second context keeps its own direct circuit but shares the tenant ledger.
      await openCircuit(second);
      let served = 0;
      for (let index = 0; index < 150; index += 1) {
        const context = index % 2 === 0 ? first : second;
        try {
          await context.request(`${API_BASE}/job/Zurich/D_R${index}`, { method: 'GET' });
          served += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(WorkdayRateLimitError);
        }
      }
      // Hard ceiling of 100 whatever the caller asked for, shared by both contexts.
      expect(served).toBe(100);
      expect(relayFallback).toHaveBeenCalledTimes(100);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('stops once the wall-clock budget is spent, with an injectable clock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    let clock = 0;
    const relayFallback = vi.fn(async () => {
      clock += 400;
      return upstream(200, { ok: true });
    });
    const context = openContext(relayFallback, { relayWallBudgetMs: 700, relayNow: () => clock });

    try {
      await openCircuit(context);
      await context.request(`${API_BASE}/job/Zurich/A_R1`, { method: 'GET' });
      await context.request(`${API_BASE}/job/Zurich/B_R2`, { method: 'GET' });
      await expect(context.request(`${API_BASE}/job/Zurich/C_R3`, { method: 'GET' }))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      expect(relayFallback).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
    }
  });

  it.each([
    ['listingRelayBudget', -1],
    ['detailRelayBudget', Number.NaN],
    ['relayBackoffMs', 31_000],
    ['relayWallBudgetMs', 900_001],
    ['relayWallBudgetMs', '600' as unknown as number],
  ])('rejects an invalid %s (%s) with a TypeError before any request', (name, value) => {
    expect(() => openContext(vi.fn(), { [name]: value })).toThrow(TypeError);
  });

  it('is strictly sequential per tenant and spaces relay requests by the backoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    let inFlight = 0;
    let maxInFlight = 0;
    const relayFallback = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return upstream(200, { ok: true });
    });
    const relaySleep = vi.fn(async () => {});
    const clock = 10_000;
    const context = openContext(relayFallback, { relayBackoffMs: 1_500, relaySleep, relayNow: () => clock });

    try {
      await openCircuit(context);
      await Promise.all([1, 2, 3].map((n) => context.request(`${API_BASE}/job/Zurich/P_R${n}`, { method: 'GET' })));
      expect(maxInFlight).toBe(1);
      // The injected clock never advances, so every request after the first waits the full backoff.
      expect(relaySleep).toHaveBeenCalled();
      expect(relaySleep.mock.calls.every(([ms]) => ms === 1_500)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('does not touch the relay on a single terminal 429 below the circuit threshold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const relayFallback = vi.fn().mockResolvedValue(upstream(200, { ok: true }));
    const context = openContext(relayFallback, { rateLimitCircuitThreshold: 5 });

    try {
      await expect(context.request(`${API_BASE}/job/Zurich/Only_R1`, { retries: 0, retryBaseMs: 0 }))
        .rejects.toBeInstanceOf(WorkdayRateLimitError);
      expect(relayFallback).not.toHaveBeenCalled();
    } finally {
      await context.close();
    }
  });

  it('never launches a browser on a 429, whether the relay answers, fails or is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const browserFallback = vi.fn().mockResolvedValue({ recovered: true });

    for (const relayFallback of [
      vi.fn().mockResolvedValue(upstream(200, { ok: true })),
      vi.fn().mockResolvedValue(upstream(429, {})),
      vi.fn().mockResolvedValue(null),
      null,
    ]) {
      resetWorkdayImplicitRateLimitStateForTests();
      const context = createWorkdayRequestContext(API_BASE, {
        browserFallback,
        relayFallback,
        fallbackCooldownMs: 0,
        egressStateDir: null,
        relayBackoffMs: 0,
        relaySleep: async () => {},
      } as never);
      try {
        await openCircuit(context as never).catch(() => {});
        await context.request(`${API_BASE}/job/Zurich/X_R1`, { method: 'GET' }).catch(() => {});
        await context.request(LISTING_URL, { method: 'POST', body: LISTING_BODY }).catch(() => {});
      } finally {
        await context.close();
      }
    }
    expect(browserFallback).not.toHaveBeenCalled();
    expect(launchStealthOrChromiumMock).not.toHaveBeenCalled();
  });

  it('is off without a relay: no JOBS_SOURCE_RELAY_URL keeps the direct-only behavior', async () => {
    vi.stubEnv('JOBS_SOURCE_RELAY_URL', '');
    const directFetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', directFetch);

    await expect(fetchWorkdayJobDetail(API_BASE, '/job/Zurich/Swiss_R1', {
      browserFallback: null,
      fallbackCooldownMs: 0,
      retries: 1,
    })).rejects.toBeInstanceOf(WorkdayRateLimitError);
    // Direct 429 x2 then the typed error: not one extra request anywhere.
    expect(directFetch).toHaveBeenCalledTimes(2);
  });
});
