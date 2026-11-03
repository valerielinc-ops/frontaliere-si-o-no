// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { AD_FILL_TIMEOUT_MS } from '@/services/adsenseSlots';

const { trackAdEvent, consent, bidding, requestHeaderBids } = vi.hoisted(() => ({ trackAdEvent: vi.fn(), consent: { granted: true }, bidding: { active: false }, requestHeaderBids: vi.fn() }));
vi.mock('@/components/shared/AdSenseBanner', () => ({ isAdSenseProductionHost: () => true }));
vi.mock('@/services/adAnalytics', () => ({ trackAdEvent, isLikelyBot: () => false }));
vi.mock('@/services/headerBidding', () => ({ prebidActiveFor: () => bidding.active, requestHeaderBids }));
vi.mock('@/services/adsConsent', () => ({ isAdsConsentGranted: () => consent.granted, onAdsConsentChange: () => () => {} }));
const sizes: GptSize[] = [[300, 600]];
let observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnected: boolean }>;
let handlers: Map<string, (event: unknown) => void>;
let commands: Array<() => void>;
let slot: { addService: () => unknown };
let top: number;
let display: ReturnType<typeof vi.fn>;
let defineSlot: ReturnType<typeof vi.fn>;
let width: number;

beforeEach(() => {
  vi.useFakeTimers();
  consent.granted = true;
  bidding.active = false; requestHeaderBids.mockReset().mockResolvedValue(undefined);
  trackAdEvent.mockClear();
  top = 100;
  width = 300;
  observers = [];
  handlers = new Map();
  commands = [];
  display = vi.fn();
  slot = { addService: () => slot };
  defineSlot = vi.fn(() => slot);
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, disconnected: false }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnected = true; }
  });
  vi.stubGlobal('googletag', {
    cmd: commands, defineSlot, setConfig: vi.fn(), enableServices: vi.fn(), display,
    destroySlots: vi.fn(), pubads: () => ({ addEventListener: (name: string, cb: (event: unknown) => void) => handlers.set(name, cb), removeEventListener: (name: string) => handlers.delete(name) }),
  });
});
afterEach(() => { cleanup(); document.querySelectorAll('script[src*="gpt.js"]').forEach((el) => el.remove()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(collapseOnEmpty = true, slotSizes = sizes) {
  const onEmptyChange = vi.fn();
  const result = render(<GptAdSlot adUnitPath="/test/rail" sizes={slotSizes} minHeight={600} collapseOnEmpty={collapseOnEmpty} onEmptyChange={onEmptyChange} />);
  const box = result.container.querySelector('[data-ft-house-google]') as HTMLElement;
  box.getBoundingClientRect = () => ({ top, bottom: top + 600, left: 0, right: width, width, height: 600, x: 0, y: top, toJSON() {} });
  act(() => observers[0]?.callback([{ target: box, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  return { ...result, box, onEmptyChange };
}
function loadGpt() { act(() => { for (const command of commands.splice(0)) command(); }); }
async function response(isEmpty: boolean) { await act(async () => { handlers.get('slotRenderEnded')?.({ slot, isEmpty }); await Promise.resolve(); }); }
function leaveViewport() {
  top = 2000;
  act(() => { for (const observer of [...observers]) if (!observer.disconnected) observer.callback([{ target: observer.target, isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver); });
}

describe('GPT manual reserve lifecycle', () => {
  it('remeasures sizes when the delayed GPT command drains after a shrink', () => {
    width = 400;
    mount(true, [[300, 250], [160, 600]]);
    width = 240; loadGpt();
    expect(defineSlot).toHaveBeenCalledWith('/test/rail', [[160, 600]], expect.any(String));
  });
  it('waits for width again if no size fits when the queued command drains', async () => {
    width = 400; const { box } = mount();
    expect(box.hasAttribute('data-ft-ad-request-pending')).toBe(true);
    width = 240; loadGpt();
    expect(defineSlot).not.toHaveBeenCalled();
    expect(box.hasAttribute('data-ft-ad-request-pending')).toBe(false);
    expect(box.hasAttribute('data-ft-ad-width-wait')).toBe(true);
    width = 400; act(() => window.dispatchEvent(new Event('resize'))); loadGpt();
    expect(defineSlot).toHaveBeenCalledOnce();
    expect(box.hasAttribute('data-ft-ad-request-pending')).toBe(true);
    expect(box.hasAttribute('data-ft-ad-width-wait')).toBe(false);
    await response(false);
    expect(box.hasAttribute('data-ft-ad-request-pending')).toBe(false);
  });
  it('bids only on the sizes accepted by the current GPT definition', async () => {
    width = 320; bidding.active = true;
    mount(true, [[300, 250], [728, 90]]); loadGpt();
    expect(requestHeaderBids).toHaveBeenCalledWith(expect.objectContaining({ sizes: [[300, 250]] }));
    await act(async () => { await Promise.resolve(); });
    loadGpt();
  });
  it('keeps the reserve while the script queue is slow, then accepts a late fill', async () => {
    const { box, onEmptyChange } = mount();
    act(() => vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS));
    expect(box.dataset.adState).toBe('waiting_response');
    expect(box.style.minHeight).toBe('600px');
    expect(onEmptyChange).not.toHaveBeenCalledWith(true);
    loadGpt();
    await response(false);
    expect(box.dataset.adState).toBe('filled');
    expect(box.style.display).not.toBe('none');
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
    expect(display).toHaveBeenCalledOnce();
  });
  it('retains a visible no-fill reserve, collapses offscreen, and restores on late fill', async () => {
    const { box, onEmptyChange } = mount(); loadGpt();
    await response(true);
    expect(box.style.display).not.toBe('none');
    expect(onEmptyChange).not.toHaveBeenCalledWith(true);
    leaveViewport();
    expect(box.style.display).toBe('none');
    expect(onEmptyChange).toHaveBeenLastCalledWith(true);
    expect(handlers.has('slotRenderEnded')).toBe(true);
    await response(false);
    expect(box.style.minHeight).toBe('600px');
    expect(box.style.display).not.toBe('none');
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
  });
  it('only collapses a terminal script error after the wrapper leaves the viewport', () => {
    const { box } = mount();
    (window as any).__ftAdBlock = { blocked: true };
    const script = document.querySelector<HTMLScriptElement>('script[src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"]')!;
    act(() => script.dispatchEvent(new Event('error')));
    expect(box.dataset.adState).toBe('unavailable');
    expect(box.style.display).not.toBe('none');
    leaveViewport();
    expect(box.style.display).toBe('none');
    delete (window as any).__ftAdBlock;
  });
  it('keeps the above-fold reserve even for terminal offscreen no-fill', async () => {
    const { box, onEmptyChange } = mount(false); loadGpt(); await response(true); leaveViewport();
    expect(box.style.minHeight).toBe('600px');
    expect(onEmptyChange).not.toHaveBeenCalledWith(true);
    expect(trackAdEvent.mock.calls.some(([name]) => name === 'ad_collapsed')).toBe(false);
  });
  it('does not create a stale slot when the script loads after unmount', () => {
    const { unmount } = mount(); unmount(); loadGpt();
    expect(display).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
  it('does not retry or display after the route becomes credential-bearing', () => {
    mount();
    window.history.replaceState(null, '', '/?ac=synthetic-code');
    const selector = 'script[src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"]';
    const initial = document.querySelector(selector)!;
    act(() => { initial.dispatchEvent(new Event('error')); vi.advanceTimersByTime(10000); });
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(initial);
    loadGpt();
    expect(display).not.toHaveBeenCalled();
  });
  it('does not request before advertising consent', () => {
    consent.granted = false;
    const { box, onEmptyChange } = mount();
    expect(box.style.display).toBe('none');
    expect(onEmptyChange).toHaveBeenLastCalledWith(true);
    act(() => vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS));
    expect(commands).toHaveLength(0);
    expect(trackAdEvent).not.toHaveBeenCalled();
  });
});
