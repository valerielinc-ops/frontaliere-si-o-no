// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeManualAd } from '@/services/manualAdLifecycle';
import { AD_FILL_TIMEOUT_MS } from '@/services/adsenseSlots';

let observers: Array<{ callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element; disconnected: boolean }>;
let cleanups: Array<() => void>;
let top: number;
const rect = (y: number, height = 336) => ({ top: y, bottom: y + height, left: 0, right: 390, width: 390, height, x: 0, y, toJSON() {} });
beforeEach(() => {
  vi.useFakeTimers();
  top = 100;
  observers = [];
  cleanups = [];
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.record = { callback, options, disconnected: false }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnected = true; }
  });
});
afterEach(() => { cleanups.forEach((f) => f()); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(height = 336) {
  const box = document.createElement('div');
  box.style.minHeight = `${height}px`;
  const el = document.createElement('ins');
  box.append(el); document.body.append(box);
  box.getBoundingClientRect = () => rect(top, height);
  el.getBoundingClientRect = () => rect(top, height);
  const states = vi.fn(); const events = vi.fn();
  const lifecycle = observeManualAd(el, box, AD_FILL_TIMEOUT_MS, states, events);
  cleanups.push(lifecycle.stop);
  return { box, el, lifecycle, states, events };
}
async function status(el: Element, value: string) { if (value === 'filled' && !el.querySelector('iframe')) { const frame = document.createElement('iframe'); frame.getBoundingClientRect = () => el.getBoundingClientRect(); el.append(frame); } el.setAttribute('data-ad-status', value); await Promise.resolve(); }
function intersect(index: number, ratio: number) {
  const record = observers[index];
  record.callback([{ target: record.target, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver);
}
describe('manual ad lifecycle shared by SPA and static', () => {
  it('starts no response deadline before a real request (consent or below fold)', () => {
    const { states, events } = setup();
    vi.advanceTimersByTime(60_000);
    expect(states).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  });
  it.each([422, 1534])('preserves a slow filled company/fuel creative of %ipx', async (height) => {
    const { el, states, events, lifecycle } = setup(1100);
    lifecycle.request();
    vi.advanceTimersByTime(30_000);
    expect(states).toHaveBeenLastCalledWith('waiting_response');
    expect(states).not.toHaveBeenCalledWith('collapsed', expect.anything());
    el.style.minHeight = '1100px';
    const frame = document.createElement('iframe');
    frame.getBoundingClientRect = () => rect(top, height);
    el.append(frame);
    await status(el, 'filled');
    expect(states).toHaveBeenLastCalledWith('filled');
    expect(events).toHaveBeenCalledWith('ad_filled', expect.objectContaining({ creative_height: height, reserved_height: 1100 }));
  });
  it('does not mistake a scaffold iframe for a filled creative', () => {
    const { el, states, lifecycle } = setup();
    el.append(document.createElement('iframe'));
    lifecycle.request(); vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS);
    expect(states).toHaveBeenLastCalledWith('waiting_response');
  });
  it.each(['unfilled', 'script_failed'])('keeps visible %s reserve and collapses only offscreen', async (reason) => {
    const { el, states, lifecycle, events } = setup();
    if (reason === 'unfilled') { lifecycle.request(); await status(el, 'unfilled'); } else lifecycle.fail(reason);
    expect(states).toHaveBeenLastCalledWith(reason === 'unfilled' ? 'unfilled' : 'unavailable', reason);
    intersect(0, 1);
    expect(states).not.toHaveBeenCalledWith('collapsed', reason);
    top = 1200; intersect(0, 0);
    expect(states).toHaveBeenLastCalledWith('collapsed', reason);
    expect(events.mock.calls.filter(([event]) => event === 'ad_collapsed')).toHaveLength(1);
  });
  it('recovers a late fill after failure and cancels the deferred collapse', async () => {
    const { el, states, lifecycle } = setup();
    lifecycle.fail('script_failed'); await status(el, 'filled');
    top = 1200; intersect(0, 0);
    expect(states).toHaveBeenLastCalledWith('filled');
  });
  it('waits for scroll offscreen without IntersectionObserver as well', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { states, lifecycle } = setup(); lifecycle.fail('script_failed');
    expect(states).not.toHaveBeenCalledWith('collapsed', 'script_failed');
    top = 1200; window.dispatchEvent(new Event('scroll'));
    expect(states).toHaveBeenLastCalledWith('collapsed', 'script_failed');
  });
  it('emits one request identity and viewability only after 50% for one continuous second', async () => {
    const { el, events, lifecycle } = setup(); lifecycle.request(); lifecycle.request();
    await status(el, 'filled');
    intersect(0, 0.49); vi.advanceTimersByTime(2000);
    expect(events.mock.calls.some(([event]) => event === 'ad_viewable')).toBe(false);
    intersect(0, 0.6); vi.advanceTimersByTime(800); intersect(0, 0);
    vi.advanceTimersByTime(2000);
    expect(events.mock.calls.some(([event]) => event === 'ad_viewable')).toBe(false);
    intersect(0, 0.6); vi.advanceTimersByTime(1000); intersect(0, 0.8); vi.advanceTimersByTime(1000);
    expect(events.mock.calls.filter(([event]) => event === 'ad_request')).toHaveLength(1);
    expect(events.mock.calls.filter(([event]) => event === 'ad_viewable')).toHaveLength(1);
    expect(new Set(events.mock.calls.map(([, props]) => props.request_id)).size).toBe(1);
  });
  it('restarts the continuous view timer when Google replaces the creative frame', async () => {
    const { el, events, lifecycle } = setup(); lifecycle.request(); await status(el, 'filled');
    intersect(0, 0.6); vi.advanceTimersByTime(900);
    el.querySelector('iframe')!.remove();
    const replacement = document.createElement('iframe'); replacement.getBoundingClientRect = () => rect(top);
    el.append(replacement); await Promise.resolve();
    vi.advanceTimersByTime(200);
    expect(events.mock.calls.some(([event]) => event === 'ad_viewable')).toBe(false);
    intersect(1, 0.6); vi.advanceTimersByTime(999);
    expect(events.mock.calls.some(([event]) => event === 'ad_viewable')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(events.mock.calls.filter(([event]) => event === 'ad_viewable')).toHaveLength(1);
  });
  it('stops all deferred work when SPA navigation removes the owner', async () => {
    const { el, states, lifecycle } = setup(); lifecycle.request(); lifecycle.stop();
    await status(el, 'filled'); vi.advanceTimersByTime(30_000);
    expect(states).toHaveBeenCalledTimes(1);
  });
});
