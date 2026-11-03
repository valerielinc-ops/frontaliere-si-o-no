import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { installHouseAds } from '../services/houseAdRuntime';
import { createHouseAdCreative, HOUSE_AD_CREATIVE_CSS } from '../services/houseAdCreative';
import { sanitizeHouseAdAttribution } from '../functions/src/houseAdAttribution.js';

let dom: JSDOM;
let w: any;
const emit = vi.fn();
const config = { publicConfigUrl: 'https://example.test/public-config', consentKey: 'frontaliere_ads_consent', consentEvent: 'frontaliere:ads-consent' };
function frame(state: string, placement = 'article-inline') {
  const el = w.document.createElement('div'); el.dataset.ftHouseSlot = placement; el.dataset.ftHouseHeight = '250';
  const google = w.document.createElement('div'); google.dataset.ftHouseGoogle = ''; google.dataset.ftAdState = state;
  const host = w.document.createElement('div'); host.dataset.ftHouseHost = '';
  el.append(google, host); w.document.body.append(el); return { el, google, host };
}
async function start(allowed = () => true) {
  const install = w.eval(`(${installHouseAds.toString()})`);
  install(w.eval(`(${createHouseAdCreative.toString()})`), HOUSE_AD_CREATIVE_CSS, emit, allowed, config);
  await vi.advanceTimersByTimeAsync(12200);
}
beforeEach(() => {
  vi.useFakeTimers(); emit.mockClear();
  dom = new JSDOM('<!doctype html><html lang="it"><head></head><body></body></html>', { url: 'https://frontaliereticino.ch/articoli-frontaliere/esempio/', runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window; w.Date = Date; w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
  w.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ HOUSE_AD_CREATIVE_VARIANT: 'auto' }) });
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, width: 300, height: 250, right: 300, bottom: 250 }; };
  Object.defineProperty(w.document.documentElement, 'clientWidth', { value: 390 });
});
afterEach(() => { dom.window.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('per-slot first-party creative delivery', () => {
  it('leaves the independent recovery bootstrap usable without MutationObserver', async () => {
    w.MutationObserver = undefined; const empty = frame('unfilled');
    await expect(start()).resolves.toBeUndefined();
    expect(empty.host.childElementCount).toBe(0);
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it('fills only an empty owned slot even when another Google unit is filled, and yields to a late fill', async () => {
    const empty = frame('unfilled'); const filled = frame('filled', 'article-end');
    const googleIdentity = empty.google;
    await start();
    expect(empty.host.querySelector('a')).not.toBeNull();
    expect(filled.host.childElementCount).toBe(0);
    expect(empty.el.querySelector('[data-ft-house-google]')).toBe(googleIdentity);
    empty.google.dataset.ftAdState = 'filled'; await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.childElementCount).toBe(0);
    expect(empty.el.hasAttribute('data-ft-house-active')).toBe(false);
  });
  it.each(['loading', 'waiting_response', 'idle', 'waiting_width'])('does not cover a %s Google slot', async state => {
    const empty = frame(state); await start(); expect(empty.host.childElementCount).toBe(0);
  });
  it('fills a blocked SDK slot after retries are exhausted without touching Google markup', async () => {
    const empty = frame('waiting_width');
    const script = w.document.createElement('script'); script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'; script.dataset.failed = '1'; script.dataset.ftScriptState = 'retry_wait'; w.document.head.append(script);
    await start(); expect(empty.host.childElementCount).toBe(0);
    script.dataset.ftScriptState = 'failed'; await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.querySelector('a')).not.toBeNull(); expect(script.dataset.ftScriptState).toBe('failed');
  });
  it('uses unenrolled control when Firebase is unavailable', async () => {
    w.fetch.mockRejectedValue(new Error('offline')); const empty = frame('unfilled'); await start();
    expect(empty.host.querySelector('a')?.dataset.houseCreative).toBe('control_v1');
    empty.host.querySelector('a').click();
    expect(JSON.parse(w.sessionStorage.getItem('ft_house_ad_click_v1')).enrolled).toBe(false);
  });
  it('keeps assignment stable and counts one viewable impression per slot creative', async () => {
    const empty = frame('unfilled'); await start(); await vi.advanceTimersByTimeAsync(1200);
    const creative = empty.host.querySelector('a').dataset.houseCreative;
    expect(JSON.parse(w.sessionStorage.getItem('ft_house_ad_click_v1') || 'null')).toBeNull();
    expect(emit.mock.calls.filter(([name]) => name === 'house_ad_impression')).toHaveLength(1);
    w.__ftHouseAds.refresh(); await vi.advanceTimersByTimeAsync(1200);
    expect(empty.host.querySelector('a').dataset.houseCreative).toBe(creative);
    expect(emit.mock.calls.filter(([name]) => name === 'house_ad_impression')).toHaveLength(1);
  });
  it('does not let a hidden app menu suppress or inflate exposure measurement', async () => {
    const dialog = w.document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.style.visibility = 'hidden'; w.document.body.append(dialog);
    frame('unfilled'); await start(); await vi.advanceTimersByTimeAsync(1200);
    expect(emit.mock.calls.filter(([name]) => name === 'house_ad_impression')).toHaveLength(1);
  });
  it('removes first-party slots when entitlement/privacy excludes the page', async () => {
    let allowed = true; const empty = frame('unfilled'); await start(() => allowed);
    expect(empty.host.childElementCount).toBe(1); allowed = false; w.__ftHouseAds.refresh();
    expect(empty.host.childElementCount).toBe(0);
  });
  it('does not expose the campaign on the service page in any supported locale', async () => {
    dom.reconfigure({ url: 'https://frontaliereticino.ch/de/arbeitssuche-schweiz-automatisieren/' });
    const empty = frame('unfilled'); await start(); expect(empty.host.childElementCount).toBe(0);
  });
});

describe('bounded purchase attribution', () => {
  const click = () => ({ campaign: 'job_search_automation', variant: 'control', creativeId: 'control_v1', format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true, clickedAt: Date.now() - 1000 });
  it('keeps public campaign fields and strips arbitrary user data', () => {
    expect(sanitizeHouseAdAttribution({ ...click(), email: 'discard@example.test', url: 'https://example.test/private/' })).toEqual({ ...click(), experimentId: 'house_creatives_v1' });
  });
  it.each([
    { variant: 'unknown' }, { creativeId: 'mismatch_v1' }, { placement: 'https://example.test/private/' },
    { clickedAt: Infinity }, { clickedAt: Date.now() + 86400000 }, { clickedAt: Date.now() - 8 * 86400000 },
  ])('rejects invalid or expired metadata %j', bad => { expect(sanitizeHouseAdAttribution({ ...click(), ...bad })).toBeNull(); });
});
