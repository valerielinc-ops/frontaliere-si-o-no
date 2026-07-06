import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { detectAdBlock } from '@/services/adBlockDetection';

// services/adBlockDetection.ts combines two independent signals (bait element
// + network probe) via OR. Both run through window.setTimeout guards, so
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
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(true);
  });

  it('reports not blocked when neither signal trips', async () => {
    const result = detectAdBlock();
    await vi.advanceTimersByTimeAsync(200);
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
