// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { AD_FILL_TIMEOUT_MS } from '@/services/adsenseSlots';

const { trackAdEvent, consent } = vi.hoisted(() => ({ trackAdEvent: vi.fn(), consent: { granted: true } }));
vi.mock('@/components/shared/AdSenseBanner', () => ({ isAdSenseProductionHost: () => true }));
vi.mock('@/services/adAnalytics', () => ({ trackAdEvent, isLikelyBot: () => false }));
vi.mock('@/services/headerBidding', () => ({ prebidActiveFor: () => false, requestHeaderBids: vi.fn() }));
vi.mock('@/services/adsConsent', () => ({ isAdsConsentGranted: () => consent.granted, onAdsConsentChange: () => () => {} }));
const sizes: GptSize[] = [[300, 600]];
let observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnected: boolean }>;
let handlers: Map<string, (event: unknown) => void>;
let commands: Array<() => void>;
let slot: { addService: () => unknown };
let top: number;
let display: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  consent.granted = true;
  trackAdEvent.mockClear();
  top = 100;
  observers = [];
  handlers = new Map();
  commands = [];
  display = vi.fn();
  slot = { addService: () => slot };
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, disconnected: false }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnected = true; }
  });
  vi.stubGlobal('googletag', {
    cmd: commands, defineSlot: () => slot, setConfig: vi.fn(), enableServices: vi.fn(), display,
    destroySlots: vi.fn(), pubads: () => ({ addEventListener: (name: string, cb: (event: unknown) => void) => handlers.set(name, cb), removeEventListener: (name: string) => handlers.delete(name) }),
  });
});
afterEach(() => { cleanup(); document.querySelectorAll('script[src*="gpt.js"]').forEach((el) => el.remove()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(collapseOnEmpty = true) {
  const onEmptyChange = vi.fn();
  const result = render(<GptAdSlot adUnitPath="/test/rail" sizes={sizes} minHeight={600} collapseOnEmpty={collapseOnEmpty} onEmptyChange={onEmptyChange} />);
  const box = result.container.firstElementChild as HTMLElement;
  box.getBoundingClientRect = () => ({ top, bottom: top + 600, left: 0, right: 300, width: 300, height: 600, x: 0, y: top, toJSON() {} });
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
    const script = document.createElement('script'); script.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'; document.head.append(script);
    act(() => script.dispatchEvent(new Event('error')));
    expect(box.dataset.adState).toBe('unavailable');
    expect(box.style.display).not.toBe('none');
    leaveViewport();
    expect(box.style.display).toBe('none');
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
  it('does not request before advertising consent', () => {
    consent.granted = false;
    mount();
    act(() => vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS));
    expect(commands).toHaveLength(0);
    expect(trackAdEvent).not.toHaveBeenCalled();
  });
});
