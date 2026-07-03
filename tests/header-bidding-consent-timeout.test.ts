import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `services/headerBidding.ts` gates the whole auction behind the intentionally
// hardcoded `PREBID_ENABLED = false` flag, so these tests drive the internal
// plumbing directly via `__testing` (same pattern as
// tests/header-bidding-script-error.test.ts).
import { __testing } from '@/services/headerBidding';

describe('headerBidding — TCF consent timeout reconciliation (issue #2860 item 2)', () => {
  beforeEach(() => {
    __testing.resetForTests();
    (window as unknown as { pbjs?: unknown }).pbjs = undefined;
  });

  afterEach(() => {
    __testing.resetForTests();
    (window as unknown as { pbjs?: unknown }).pbjs = undefined;
  });

  it('configures consentManagement.gdpr.timeout at or below the requestBids window (DEFAULT_TIMEOUT_MS)', () => {
    const setConfig = vi.fn();
    // Pre-seed window.pbjs so `configurePrebid`'s internal `pbjs()` accessor
    // reuses this object (and its `que` array) instead of creating a fresh one.
    (window as unknown as { pbjs: { que: Array<() => void>; setConfig: typeof setConfig } }).pbjs = {
      que: [],
      setConfig,
    };

    __testing.configurePrebid();

    const que = (window as unknown as { pbjs: { que: Array<() => void> } }).pbjs.que;
    expect(que.length).toBe(1);
    // Drain the queue exactly like the real prebid.js bundle does on load.
    que[0]();

    expect(setConfig).toHaveBeenCalledTimes(1);
    const config = setConfig.mock.calls[0][0] as { consentManagement: { gdpr: { timeout: number } } };
    const consentTimeout = config.consentManagement.gdpr.timeout;

    expect(consentTimeout).toBeLessThanOrEqual(__testing.DEFAULT_TIMEOUT_MS);
    expect(consentTimeout).toBe(__testing.CONSENT_TIMEOUT_MS);
  });

  it('never lets the consent wait push total resolution past the 1500ms wall-clock guard ceiling', () => {
    // The wall-clock guard in `runAuction` fires at `timeoutMs + 500`. With the
    // default 1000ms auction timeout that ceiling is 1500ms — CH/EU users must
    // never wait longer than that for ad display, regardless of how slow the
    // CMP is, since a slow/absent CMP is exactly the scenario the guard exists
    // to protect against.
    const guardCeilingMs = __testing.DEFAULT_TIMEOUT_MS + 500;
    expect(__testing.CONSENT_TIMEOUT_MS).toBeLessThan(guardCeilingMs);
  });
});
