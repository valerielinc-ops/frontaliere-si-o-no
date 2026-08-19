import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { detectAdBlock, detectAdBlockDetailed } from '@/services/adBlockDetection';

// services/adBlockDetection.ts prefers Funding Choices' own answer — Google
// already detects ad blockers on this page and does it about twice as well
// (measured 2026-06-16..08-17: ~5% extension rate vs 2.5% for the local probe)
// — and falls back to the two local signals (bait element + network probe,
// OR'd) only when Funding Choices never reports. Both run through window.setTimeout guards, so
// fake timers + vi.advanceTimersByTimeAsync are required to flush them
// deterministically — same pattern as tests/header-bidding-script-error.test.ts
// and tests/resilient-import.test.ts.

interface BaitStyle {
  height: number;
  display: string;
  visibility: string;
}

function mockBait({ height, display, visibility }: BaitStyle): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height,
    width: height,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    x: 0,
    y: 0,
    toJSON() { return {}; },
  } as DOMRect);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    display,
    visibility,
  } as CSSStyleDeclaration);
}

const CLEAN_BAIT: BaitStyle = { height: 1, display: 'block', visibility: 'visible' };

function mockNetworkResolved(): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
}

function mockNetworkRejected(): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('blocked'))));
}

function mockNetworkNeverResolves(): void {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => { /* never settles */ })));
}

describe('detectAdBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockBait(CLEAN_BAIT);
    mockNetworkResolved();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports blocked when the bait element collapses to zero height', async () => {
    mockBait({ height: 0, display: 'block', visibility: 'visible' });
    const result = detectAdBlock();
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(true);
  });

  it('reports blocked when the bait element is display:none', async () => {
    mockBait({ height: 1, display: 'none', visibility: 'visible' });
    const result = detectAdBlock();
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(true);
  });

  it('reports blocked when the bait element is visibility:hidden', async () => {
    mockBait({ height: 1, display: 'block', visibility: 'hidden' });
    const result = detectAdBlock();
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(true);
  });

  it('reports blocked when the network probe rejects even if the bait is clean', async () => {
    mockNetworkRejected();
    const result = detectAdBlock();
    // The bait is clean here, so the probe polls until BAIT_DEADLINE_MS (900ms)
    // instead of concluding after a single 120ms look — advance past it.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(true);
  });

  it('reports not blocked when neither signal trips', async () => {
    const result = detectAdBlock();
    // The bait is clean here, so the probe polls until BAIT_DEADLINE_MS (900ms)
    // instead of concluding after a single 120ms look — advance past it.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(false);
  });

  it('treats a network timeout as ambiguous, not blocked, when the bait is clean', async () => {
    mockNetworkNeverResolves();
    const result = detectAdBlock();
    // Past NETWORK_TIMEOUT_MS (1500ms) and SETTLE_DELAY_MS (120ms) both.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(false);
  });

  it('resolves false outside a browser context', async () => {
    vi.stubGlobal('window', undefined);
    await expect(detectAdBlock()).resolves.toBe(false);
  });
});

// The Funding Choices path. index.html's bridge sets __ftFcAdBlockBridge before
// the FC tag and stashes the answer on __ftAdBlock when AD_BLOCK_DATA_READY
// fires; this module just has to prefer it over its own guesswork.
describe('detectAdBlockDetailed — Funding Choices signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockBait(CLEAN_BAIT);
    mockNetworkResolved();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__ftAdBlock;
    delete (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge;
  });

  it('takes Google\'s verdict over the local probe when it is already there', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = {
      blocked: true, allowAds: null, adsAllowed: false, status: 'EXTENSION_LEVEL_AD_BLOCKER',
    };
    const result = await detectAdBlockDetailed();
    // The bait is clean and the network resolves, so the heuristic would have
    // said "not blocked" — this asserts the precedence, not just the value.
    expect(result).toEqual({
      blocked: true, adsAllowed: false, source: 'funding_choices', status: 'EXTENSION_LEVEL_AD_BLOCKER',
    });
  });

  it('reports adsAllowed so an allowlisted visitor is never gated again', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = {
      blocked: true, adsAllowed: true, status: 'EXTENSION_LEVEL_AD_BLOCKER',
    };
    const result = await detectAdBlockDetailed();
    expect(result.adsAllowed).toBe(true);
    expect(result.source).toBe('funding_choices');
  });

  it('picks up an answer that arrives after the call, not only one already present', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    const pending = detectAdBlockDetailed();
    (window as unknown as Record<string, unknown>).__ftAdBlock = { blocked: true, adsAllowed: false, status: null };
    window.dispatchEvent(new CustomEvent('frontaliere:adblock-data'));
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).source).toBe('funding_choices');
  });

  it('does not wait for a bridge that never ran — falls straight to the probe', async () => {
    // No __ftFcAdBlockBridge: nothing is coming, so waiting the full timeout
    // would delay the gate for every visitor to no purpose.
    mockBait({ height: 0, display: 'block', visibility: 'visible' });
    const pending = detectAdBlockDetailed();
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result.source).toBe('heuristic');
    expect(result.blocked).toBe(true);
  });

  it('falls back to the probe when the bridge ran but Funding Choices stayed silent', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    mockBait({ height: 0, display: 'block', visibility: 'visible' });
    const pending = detectAdBlockDetailed();
    // Past FC_WAIT_MS (6000ms, issue #6064) — set to outlast the worst-case
    // 4000ms requestIdleCallback scheduling floor for FC itself.
    await vi.advanceTimersByTimeAsync(6100);
    const result = await pending;
    expect(result.source).toBe('heuristic');
    expect(result.blocked).toBe(true);
  });

  it('keeps detectAdBlock as a boolean view of the same answer', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = { blocked: true, adsAllowed: false, status: null };
    await expect(detectAdBlock()).resolves.toBe(true);
  });

  // The snapshot on __ftAdBlock is written once, when AD_BLOCK_DATA_READY
  // fires, and nothing ever refreshes it. That is fine for the first read and
  // wrong for every later one — which is exactly what the gate's recheck
  // button is.
  it('does not let a stale Funding Choices verdict veto a live re-read', async () => {
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = {
      blocked: true, adsAllowed: false, status: 'EXTENSION_LEVEL_AD_BLOCKER',
    };
    // Bait clean and network resolving: the visitor has switched the blocker
    // off since the page loaded. Without `live` the load-time verdict wins for
    // the whole lifetime of the document and the recheck can never succeed.
    const pending = detectAdBlockDetailed({ live: true });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.blocked).toBe(false);
    expect(result.source).toBe('heuristic');
    // The status is still worth carrying: it says what was seen at load.
    expect(result.status).toBe('EXTENSION_LEVEL_AD_BLOCKER');
  });

  it('still reports a blocker that is live on a live re-read', async () => {
    // The other half of the same flag: `live` must read the probe, not decide
    // in advance that the answer is "clean".
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = {
      blocked: true, adsAllowed: false, status: 'EXTENSION_LEVEL_AD_BLOCKER',
    };
    mockBait({ height: 0, display: 'block', visibility: 'visible' });
    const pending = detectAdBlockDetailed({ live: true });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.blocked).toBe(true);
  });

  it('keeps an allowlisting across a live re-read', async () => {
    // adsAllowed can only ever open the gate, so the live path must not throw
    // it away: Funding Choices saw the allowlisting itself, which is not a
    // reading that goes stale the way a blocker verdict does.
    (window as unknown as Record<string, unknown>).__ftFcAdBlockBridge = 1;
    (window as unknown as Record<string, unknown>).__ftAdBlock = {
      blocked: true, adsAllowed: true, status: 'EXTENSION_LEVEL_AD_BLOCKER',
    };
    const result = await detectAdBlockDetailed({ live: true });
    expect(result.adsAllowed).toBe(true);
    expect(result.source).toBe('funding_choices');
  });
});
