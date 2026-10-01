// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ADSENSE_LOADER_CONTENT } from '@/build-plugins/constants';
import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_CHANGE_EVENT } from '@/services/adsConsent';

const eventSpy = vi.hoisted(() => vi.fn());
vi.mock('@/services/adAnalytics', () => ({ isLikelyBot: () => false, trackAdEvent: eventSpy }));
let observers: Array<{ cb: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[]; disconnected: boolean }>;
let position = 100;
const adScript = () => document.querySelector<HTMLScriptElement>('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
const boxRect = (top = position, height = 336) => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height, x: 0, y: top, toJSON() {} });
beforeEach(() => {
 vi.useFakeTimers(); observers = []; position = 100; eventSpy.mockClear();
 document.body.innerHTML = ''; document.head.innerHTML = ''; localStorage.clear();
 window.history.replaceState(null, '', '/cerca-lavoro-ticino/');
 localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
 Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' });
 window.adsbygoogle = [];
 vi.stubGlobal('requestIdleCallback', (cb: () => void) => { cb(); return 1; });
 vi.stubGlobal('cancelIdleCallback', () => {});
 vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
 vi.stubGlobal('IntersectionObserver', class {
  record: typeof observers[number];
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.record = { cb, options, targets: [], disconnected: false }; observers.push(this.record); }
  observe(el: Element) { this.record.targets.push(el); } disconnect() { this.record.disconnected = true; } unobserve() {}
 });
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => boxRect());
});
afterEach(async () => { cleanup(); document.body.innerHTML = ''; await Promise.resolve(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function near() {
 const observer = [...observers].reverse().find((io) => !io.disconnected && io.options?.rootMargin === '200px 0px');
 expect(observer).toBeTruthy();
 observer!.cb(observer!.targets.map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry)), {} as IntersectionObserver);
}
function exit() {
 position = 2000;
 for (const io of observers.filter((o) => !o.disconnected && !o.options?.rootMargin)) io.cb(io.targets.map((target) => ({ target, isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry)), {} as IntersectionObserver);
}
async function mount() { const { default: Banner } = await import('@/components/shared/AdSenseBanner'); return { Banner, ...render(<Banner adSlot="3205029282" placement="joblist-infeed-main-4" />) }; }

describe('SPA lifecycle and layout owner', () => {
 it.each(['granted', 'denied'])('requests once after %s and preserves a slow fill', async (decision) => {
  localStorage.removeItem(ADS_CONSENT_STORAGE_KEY);
  await mount(); expect(adScript()).toBeNull();
  await act(async () => { localStorage.setItem(ADS_CONSENT_STORAGE_KEY, decision); window.dispatchEvent(new Event(ADS_CONSENT_CHANGE_EVENT)); });
  await act(async () => { adScript()!.dispatchEvent(new Event('load')); near(); });
  expect(window.adsbygoogle).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(document.querySelector('[data-ft-ad-state]')?.getAttribute('data-ft-ad-state')).toBe('waiting_response');
  const el = document.querySelector('ins')!;
  await act(async () => { el.setAttribute('data-ad-status', 'filled'); });
  expect(document.querySelector('[data-ft-ad-state]')?.getAttribute('data-ft-ad-state')).toBe('filled');
  expect(eventSpy.mock.calls.filter(([event]) => event === 'ad_request')).toHaveLength(1);
 });
 it('keeps visible script failure stable, collapses offscreen, retries on online and resets for a SPA route', async () => {
  const { Banner, rerender } = await mount();
  await act(async () => { adScript()!.dispatchEvent(new Event('error')); });
  const wrapper = document.querySelector<HTMLElement>('[data-ft-ad-state]')!;
  expect(wrapper.style.minHeight).toBe('336px');
  expect(wrapper.dataset.ftAdState).toBe('unavailable');
  await act(async () => { exit(); });
  expect(parseFloat(wrapper.style.minHeight)).toBe(0);
  await act(async () => { window.dispatchEvent(new Event('online')); });
  position = 100;
  await act(async () => { adScript()!.dispatchEvent(new Event('load')); near(); });
  expect(window.adsbygoogle).toHaveLength(1);
  const previous = document.querySelector('ins');
  window.history.replaceState(null, '', '/cerca-lavoro-ticino/infermieri/');
  rerender(<Banner adSlot="3205029282" placement="joblist-infeed-main-4" />);
  expect(document.querySelector('ins')).toBeNull();
  await act(async () => { near(); });
  expect(document.querySelector('ins')).not.toBe(previous);
  expect(window.adsbygoogle).toHaveLength(2);
 });
 it('does not treat a queued adsbygoogle array as proof of a loaded script', async () => {
  await mount(); await act(async () => { near(); });
  expect(window.adsbygoogle).toHaveLength(0);
  await act(async () => { adScript()!.dispatchEvent(new Event('load')); });
  expect(window.adsbygoogle).toHaveLength(1);
 });
});

describe('static serialized lifecycle', () => {
 it('never includes anchor, vignette or automatic in-page slots in manual requests', () => {
  document.body.innerHTML = '<ins id="manual" class="adsbygoogle" data-ad-slot="1"></ins><ins class="adsbygoogle" data-ad-slot="2" data-anchor-status="displayed"></ins><ins class="adsbygoogle" data-ad-slot="3" data-vignette-loaded="true"></ins><div class="google-auto-placed"><ins class="adsbygoogle" data-ad-slot="4"></ins></div>';
  new Function(ADSENSE_LOADER_CONTENT)(); adScript()!.dispatchEvent(new Event('load')); near();
  expect(window.adsbygoogle).toHaveLength(1);
  adScript()!.dispatchEvent(new Event('error')); exit();
  expect(document.querySelectorAll('[data-ft-static-ad-collapsed]')).toHaveLength(1);
  expect(document.querySelector('#manual')).toHaveAttribute('data-ft-static-ad-collapsed');
 });
 it('does not leave permanent reserve for a no-ads entitlement', () => {
  localStorage.setItem('reader_noads_active', 'true');
  document.body.innerHTML = '<ins class="adsbygoogle" data-ad-slot="2093992129" style="min-height:1100px"></ins>';
  new Function(ADSENSE_LOADER_CONTENT)();
  expect(adScript()).toBeNull();
  expect(document.querySelector('ins')).not.toHaveAttribute('data-ft-static-ad-collapsed');
  exit(); expect(document.querySelector('ins')).toHaveAttribute('data-ft-static-ad-collapsed');
 });
});
