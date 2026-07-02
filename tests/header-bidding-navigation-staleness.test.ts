import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `services/headerBidding.ts` gates the whole auction behind the intentionally
// hardcoded `PREBID_ENABLED = false` flag, so these tests drive `runAuction`
// and `invalidateHeaderBiddingOnNavigation` directly via `__testing` / the
// module export (same pattern as tests/header-bidding-script-error.test.ts).
import { __testing, invalidateHeaderBiddingOnNavigation } from '@/services/headerBidding';

interface MockPbjs {
  que: Array<() => void>;
  addAdUnits: ReturnType<typeof vi.fn>;
  removeAdUnit: ReturnType<typeof vi.fn>;
  requestBids: ReturnType<typeof vi.fn>;
  setTargetingForGPTAsync: ReturnType<typeof vi.fn>;
}

function installMockPbjs(): MockPbjs {
  const mock: MockPbjs = {
    que: [],
    addAdUnits: vi.fn(),
    removeAdUnit: vi.fn(),
    // Never calls bidsBackHandler — these tests only care about the
    // addAdUnits/removeAdUnit ordering, not auction resolution.
    requestBids: vi.fn(),
    setTargetingForGPTAsync: vi.fn(),
  };
  (window as unknown as { pbjs: MockPbjs }).pbjs = mock;
  return mock;
}

function drainQueue(mock: MockPbjs): void {
  const pending = mock.que.splice(0, mock.que.length);
  pending.forEach((fn) => fn());
}

describe('headerBidding — bid-cache staleness across SPA navigation (issue #2860 item 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __testing.resetForTests();
  });

  afterEach(() => {
    __testing.resetForTests();
    vi.useRealTimers();
    (window as unknown as { pbjs?: unknown }).pbjs = undefined;
  });

  it('does NOT call removeAdUnit the first time a fresh ad-unit code runs an auction', () => {
    const mock = installMockPbjs();
    void __testing.runAuction(
      { code: 'gpt-slot-1', adUnitPath: '/1234/rail-left', sizes: [[300, 600]] },
      1000,
      [{ bidder: 'criteo', params: {} }],
      [[300, 600]],
    );
    drainQueue(mock);

    expect(mock.removeAdUnit).not.toHaveBeenCalled();
    expect(mock.addAdUnits).toHaveBeenCalledTimes(1);
    expect(__testing.knownAdUnitCodeCount()).toBe(1);
  });

  it('purges the prior ad-unit definition before re-adding it when a code is reused with different content', () => {
    const mock = installMockPbjs();

    // First auction for this GPT div id — e.g. article A's content.
    void __testing.runAuction(
      { code: 'gpt-slot-reused', adUnitPath: '/1234/rail-left', sizes: [[300, 600]] },
      1000,
      [{ bidder: 'criteo', params: {} }],
      [[300, 600]],
    );
    drainQueue(mock);
    expect(mock.removeAdUnit).not.toHaveBeenCalled();

    // Same code reused for a *different* logical slot — e.g. article B's
    // content after an SPA navigation that didn't remount the component.
    void __testing.runAuction(
      { code: 'gpt-slot-reused', adUnitPath: '/1234/rail-right', sizes: [[160, 600]] },
      1000,
      [{ bidder: 'sovrn', params: {} }],
      [[160, 600]],
    );
    drainQueue(mock);

    // The stale definition/bids for the old adUnitPath must be purged BEFORE
    // the new one is registered under the same code.
    expect(mock.removeAdUnit).toHaveBeenCalledTimes(1);
    expect(mock.removeAdUnit).toHaveBeenCalledWith('gpt-slot-reused');
    const removeOrder = mock.removeAdUnit.mock.invocationCallOrder[0];
    const secondAddOrder = mock.addAdUnits.mock.invocationCallOrder[1];
    expect(removeOrder).toBeLessThan(secondAddOrder);
  });

  it('invalidateHeaderBiddingOnNavigation purges every known ad-unit code and clears tracking', () => {
    const mock = installMockPbjs();

    void __testing.runAuction(
      { code: 'gpt-slot-a', adUnitPath: '/1234/rail-left', sizes: [[300, 600]] },
      1000,
      [{ bidder: 'criteo', params: {} }],
      [[300, 600]],
    );
    void __testing.runAuction(
      { code: 'gpt-slot-b', adUnitPath: '/1234/poc', sizes: [[300, 250]] },
      1000,
      [{ bidder: 'sovrn', params: {} }],
      [[300, 250]],
    );
    drainQueue(mock);
    expect(__testing.knownAdUnitCodeCount()).toBe(2);

    invalidateHeaderBiddingOnNavigation();
    // Tracking is cleared synchronously; the actual pbjs.removeAdUnit calls are
    // queued (the bundle may not have loaded yet) and run once drained.
    expect(__testing.knownAdUnitCodeCount()).toBe(0);

    drainQueue(mock);
    expect(mock.removeAdUnit).toHaveBeenCalledWith('gpt-slot-a');
    expect(mock.removeAdUnit).toHaveBeenCalledWith('gpt-slot-b');
    expect(mock.removeAdUnit).toHaveBeenCalledTimes(2);
  });

  it('invalidateHeaderBiddingOnNavigation is a safe no-op when no auction has ever run', () => {
    const mock = installMockPbjs();
    expect(() => invalidateHeaderBiddingOnNavigation()).not.toThrow();
    expect(mock.que.length).toBe(0);
    expect(mock.removeAdUnit).not.toHaveBeenCalled();
  });
});
