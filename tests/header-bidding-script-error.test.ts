import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `services/headerBidding.ts` gates the entire auction behind the
// intentionally hardcoded `PREBID_ENABLED = false` master flag (flipped to
// `true` only at go-live — see the module docstring). That flag can't be
// mocked from outside (it's a plain module-local const referenced directly
// by the module's own functions), so these tests exercise the
// script-load-error guard directly via `__testing`, which is exactly the
// same plumbing `requestHeaderBids` delegates to once the flag is on.
import { __testing } from '@/services/headerBidding';

const PREBID_SCRIPT_SRC = '/assets/prebid.js';

function getPrebidScriptEl(): HTMLScriptElement | null {
  return document.querySelector(`script[src="${PREBID_SCRIPT_SRC}"]`);
}

describe('headerBidding — script-load-error guard (issue #2860)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Prebid is now behind the advertising-consent gate (#5842):
    // `ensurePrebidScript()` returns before injecting unless consent is
    // granted. These tests are about the script-load-error guard, not about
    // consent, so they grant it and keep asserting exactly what they did
    // before. The gate's own behaviour is covered by tests/ads-consent-gate.test.tsx.
    localStorage.setItem('frontaliere_ads_consent', 'granted');
    __testing.resetForTests();
  });

  afterEach(() => {
    __testing.resetForTests();
    vi.useRealTimers();
  });

  it('wires an onerror handler onto the /assets/prebid.js <script> tag', () => {
    __testing.ensurePrebidScript();
    const script = getPrebidScriptEl();
    expect(script).not.toBeNull();
    // A real onerror handler is assigned (not left null / undefined).
    expect(typeof script?.onerror).toBe('function');
  });

  it('resolves the auction immediately on script error, without waiting for the 1500ms wall-clock guard', async () => {
    __testing.ensurePrebidScript();
    const script = getPrebidScriptEl();
    expect(script).not.toBeNull();

    const auctionPromise = __testing.runAuction(
      { code: 'div-gpt-rail-1', adUnitPath: '/1234/rail', sizes: [[300, 250]] },
      1000, // timeoutMs -> wall-clock guard fires at 1500ms
      [{ bidder: 'criteo', params: {} }],
      [[300, 250]],
    );

    let settled = false;
    void auctionPromise.then(() => {
      settled = true;
    });

    // Only 100ms elapsed — nowhere near the 1500ms wall-clock backstop.
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    // Simulate the browser reporting a load failure (404 / network error).
    script?.dispatchEvent(new Event('error'));
    // Let the microtask queue flush the promise resolution.
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(__testing.isScriptFailed()).toBe(true);
  });

  it('does not double-fire if the wall-clock guard also elapses after the error already resolved it', async () => {
    __testing.ensurePrebidScript();
    const script = getPrebidScriptEl();

    let resolveCount = 0;
    const auctionPromise = __testing.runAuction(
      { code: 'div-gpt-rail-2', adUnitPath: '/1234/rail', sizes: [[300, 250]] },
      1000,
      [{ bidder: 'criteo', params: {} }],
      [[300, 250]],
    );
    void auctionPromise.then(() => {
      resolveCount += 1;
    });

    script?.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveCount).toBe(1);

    // Let the 1500ms wall-clock guard elapse too — it must be a no-op now.
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolveCount).toBe(1);
  });

  it('a subsequent auction started after the script already failed resolves immediately, without queueing', async () => {
    __testing.ensurePrebidScript();
    const script = getPrebidScriptEl();
    script?.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(__testing.isScriptFailed()).toBe(true);

    let settled = false;
    void __testing
      .runAuction(
        { code: 'div-gpt-rail-3', adUnitPath: '/1234/rail', sizes: [[300, 250]] },
        1000,
        [{ bidder: 'criteo', params: {} }],
        [[300, 250]],
      )
      .then(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});
