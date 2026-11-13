import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { installHouseAds } from '../services/houseAdRuntime';
import { createHouseAdCreative, HOUSE_AD_CREATIVE_CSS, HOUSE_AD_VARIANTS } from '../services/houseAdCreative';
import { sanitizeHouseAdAttribution, sanitizeReaderSubscriptionAdAttribution } from '../functions/src/houseAdAttribution.js';
import { ARTICLE_DETAIL_ATF_PLACEHOLDER_HEIGHT } from '../packages/articles/engine/shared/articleAtfAdExperiment';

let dom: JSDOM;
let w: any;
const emit = vi.fn();
const config = { assignmentUrl: 'https://example.test/house-ad-assignment', consentKey: 'frontaliere_ads_consent', consentEvent: 'frontaliere:ads-consent', variants: HOUSE_AD_VARIANTS };
function frame(state: string, placement = 'article-inline') {
  const el = w.document.createElement('div'); el.dataset.house = placement; el.dataset.ftHouseHeight = '250';
  const google = w.document.createElement('div'); google.dataset.ftHouseGoogle = ''; google.dataset.ftAdState = state;
  const host = w.document.createElement('div'); host.dataset.ftHouseHost = '';
  el.append(google, host); w.document.body.append(el); return { el, google, host };
}
function blockerOnlyFrame(placement = 'article-atf') {
  const el = w.document.createElement('div'); el.dataset.house = placement;
  el.dataset.ftHouseBlockerOnly = 'true'; el.dataset.ftHouseHeight = String(ARTICLE_DETAIL_ATF_PLACEHOLDER_HEIGHT);
  const google = w.document.createElement('div'); google.dataset.ftHouseGoogle = '';
  el.append(google);
  w.document.body.append(el); return el;
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
  Object.defineProperty(w.crypto, 'randomUUID', { configurable: true, value: () => '123e4567-e89b-42d3-a456-426614174000' });
  w.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ variant: 'control', enrolled: false, experimentId: 'house_creatives_v2', assignmentSource: 'local_default' }) });
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.getBoundingClientRect = function () { const width = Number(this.dataset.width) || 300; return { top: 0, left: 0, width, height: 250, right: width, bottom: 250 }; };
  Object.defineProperty(w.document.documentElement, 'clientWidth', { value: 390 });
});
afterEach(() => { dom.window.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('per-slot first-party creative delivery', () => {
  it('announces a failed GPT fallback before a collapsed rail can provide width and revokes it for no-ads readers', async () => {
    let allowed = true; const empty = frame('loading'); empty.el.dataset.ftHouseLibrary = 'gpt'; empty.el.dataset.ftHouseHeight = '600';
    empty.el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    const script = w.document.createElement('script'); script.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'; script.dataset.failed = '1'; script.dataset.ftScriptState = 'failed'; w.document.head.append(script);
    await start(() => allowed);
    expect(empty.el.hasAttribute('data-ft-house-eligible')).toBe(true);
    expect(empty.host.childElementCount).toBe(0);
    allowed = false; w.__ftHouseAds.refresh();
    expect(empty.el.hasAttribute('data-ft-house-eligible')).toBe(false);
  });
  it('waits for a real GPT request even when its SDK also has a failure marker', async () => {
    const empty = frame('loading'); empty.el.dataset.ftHouseLibrary = 'gpt'; empty.google.setAttribute('data-google-query-id', 'requested');
    const script = w.document.createElement('script'); script.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'; script.dataset.failed = '1'; script.dataset.ftScriptState = 'failed'; w.document.head.append(script);
    await start(); expect(empty.el.hasAttribute('data-ft-house-eligible')).toBe(false); expect(empty.host.childElementCount).toBe(0);
  });
  it('upgrades compact static markup without duplicating reserve/placement metadata in every page', async () => {
    const el = w.document.createElement('section'); el.setAttribute('data-house', '');
    const ins = w.document.createElement('ins'); ins.dataset.adSlot = '1234567890'; ins.dataset.adStatus = 'unfilled'; ins.style.minHeight = '220px';
    el.append(ins); w.document.body.append(el);
    await start();
    expect(el.querySelector('[data-ft-house-host] a')).not.toBeNull();
    expect(el.querySelector('ins')).toBe(ins);
    expect(el.style.getPropertyValue('--ft-house-height')).toBe('220px');
    expect(el.querySelector('a').href).toContain('1234567890');
  });
  it('fills the actual 220px article reserve without increasing it to a standard 250px banner', async () => {
    const empty = frame('unfilled'); empty.el.dataset.width = '918'; empty.el.dataset.ftHouseHeight = '220';
    await start();
    expect(empty.host.querySelector('a')?.dataset.houseFormat).toBe('billboard');
    expect(empty.el.style.getPropertyValue('--ft-house-height')).toBe('220px');
    expect(empty.host.querySelector('img').src).toContain('-wide-v1.webp');
    empty.el.dataset.ftHouseHeight = '1100'; await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.querySelector('img').src).toContain('-portrait-v1.webp');
    empty.el.dataset.ftHouseHeight = '220'; await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.querySelector('img').src).toContain('-wide-v1.webp');
  });
  it.each([
    [300, 50, 'mobile_banner', 50],
    [320, 100, 'mobile_large', 100],
    [300, 250, 'rectangle', 250],
    [728, 90, 'leaderboard', 90],
    [728, 160, 'leaderboard', 160],
    [970, 250, 'billboard', 250],
    [300, 600, 'skyscraper', 600],
  ] as const)('selects a matching creative for %sx%s slots', async (width, height, format, preservedHeight) => {
    const empty = frame('unfilled'); empty.el.dataset.width = String(width); empty.el.dataset.ftHouseHeight = String(height);
    await start();
    expect(empty.host.querySelector('a')?.dataset.houseFormat).toBe(format);
    expect(empty.el.style.getPropertyValue('--ft-house-height')).toBe(`${preservedHeight}px`);
  });
  it('keeps the commute visual as a second time-saving concept at tall and billboard sizes', async () => {
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({ variant: 'time_saved', enrolled: true, experimentId: 'house_creatives_v2', assignmentSource: 'firebase_remote_config' }) });
    const tall = frame('unfilled'); tall.el.dataset.width = '300'; tall.el.dataset.ftHouseHeight = '600';
    const wide = frame('unfilled', 'article-end'); wide.el.dataset.width = '970'; wide.el.dataset.ftHouseHeight = '250';
    await start();
    expect(tall.host.querySelector('img')?.getAttribute('src')).toContain('commute-portrait-v1.webp');
    expect(wide.host.querySelector('img')?.getAttribute('src')).toContain('commute-wide-v1.webp');
  });
  it('keeps the Swiss-first claim and clear done-for-you promise in the compact banner', async () => {
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({ variant: 'control', enrolled: false, experimentId: 'house_creatives_v2', assignmentSource: 'local_default' }) });
    const empty = frame('unfilled'); empty.el.dataset.ftHouseHeight = '50';
    await start();
    const creative = empty.host.querySelector('a');
    expect(creative?.querySelector('.ft-house-title')?.textContent).toBe('Lavoro in Svizzera?');
    expect(creative?.querySelector('.ft-house-promise')?.textContent).toBe('Lo cerchiamo noi.');
    expect(creative?.getAttribute('aria-label')).toContain('prepariamo le candidature per te');
    expect(creative?.querySelector('.ft-house-cta')?.textContent).toBe('Scopri');
  });
  it('reflows the creative when a slot changes width without a window resize', async () => {
    let deliver: ResizeObserverCallback | undefined;
    w.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { deliver = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const empty = frame('unfilled'); empty.el.dataset.width = '660';
    await start();
    expect(empty.host.querySelector('a')?.dataset.houseFormat).toBe('rectangle');
    empty.el.dataset.width = '740';
    deliver?.([{ target: empty.el, contentRect: { width: 740, height: 250 } } as ResizeObserverEntry], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.querySelector('a')?.dataset.houseFormat).toBe('billboard');
  });
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
  it('yields to AdSense optimized empty-slot suggestions', async () => {
    const optimized = frame('waiting_response');
    const ins = w.document.createElement('ins'); ins.dataset.adStatus = 'unfill-optimized';
    optimized.google.append(ins);
    await start();
    expect(optimized.host.childElementCount).toBe(0);
    expect(optimized.el.hasAttribute('data-ft-house-active')).toBe(false);
  });
  it.each(['data-ad-state', 'data-ft-ad-state', 'data-ft-static-ad-state'])('yields to descendant %s=optimized state', async attribute => {
    const optimized = frame('waiting_response');
    const marker = w.document.createElement('span');
    marker.setAttribute(attribute, 'optimized');
    optimized.google.append(marker);
    await start();
    expect(optimized.host.childElementCount).toBe(0);
    expect(optimized.el.hasAttribute('data-ft-house-active')).toBe(false);
  });
  it('fills a still-pending slot when Funding Choices confirms an ad blocker', async () => {
    const empty = frame('waiting_response'); empty.google.setAttribute('data-ft-ad-request-pending', '1');
    w.__ftAdBlock = { blocked: true, adsAllowed: false };
    await start();
    expect(empty.host.querySelector('a')).not.toBeNull();
    expect(emit).toHaveBeenCalledWith('house_ad_rendered', expect.objectContaining({ fallback_reason: 'adblock_detected' }));
  });
  it('renders a blocker-only article anchor after a confirmed blocker signal with a static Google marker', async () => {
    const anchor = blockerOnlyFrame();
    await start();
    expect(anchor.querySelector('[data-ft-house-host] a')).toBeNull();

    w.__ftAdBlock = { blocked: true, adsAllowed: false };
    w.dispatchEvent(new w.Event('frontaliere:adblock-data'));
    await vi.advanceTimersByTimeAsync(200);

    expect(anchor.querySelector('[data-ft-house-host] a')).not.toBeNull();
    expect(anchor.style.getPropertyValue('--ft-house-height')).toBe('220px');
    expect(emit).toHaveBeenCalledWith('house_ad_rendered', expect.objectContaining({
      fallback_reason: 'adblock_detected', placement: 'article-atf', format: 'rectangle',
    }));
  });
  it('renders the article creative on first paint when the blocker is already confirmed', async () => {
    const anchor = blockerOnlyFrame();
    w.__ftAdBlock = { blocked: true, adsAllowed: false };
    await start();

    expect(anchor.querySelector('[data-ft-house-google]')).not.toBeNull();
    expect(anchor.querySelector('[data-ft-house-host] a')).not.toBeNull();
    expect(anchor.style.getPropertyValue('--ft-house-height')).toBe(`${ARTICLE_DETAIL_ATF_PLACEHOLDER_HEIGHT}px`);
    expect(ARTICLE_DETAIL_ATF_PLACEHOLDER_HEIGHT).toBe(220);
    expect(emit).toHaveBeenCalledWith('house_ad_rendered', expect.objectContaining({
      fallback_reason: 'adblock_detected', placement: 'article-atf',
    }));
  });
  it.each([
    ['no confirmed blocker', undefined],
    ['allowlisted blocker', { blocked: true, adsAllowed: true }],
  ] as const)('keeps a blocker-only marker collapsed for %s', async (_label, signal) => {
    const anchor = blockerOnlyFrame();
    if (signal) w.__ftAdBlock = signal;
    await start();

    expect(anchor.querySelector('[data-ft-house-host] a')).toBeNull();
    expect(anchor.hasAttribute('data-ft-house-active')).toBe(false);
    expect(w.document.querySelector('#ft-house-creative-style')?.textContent)
      .toContain('[data-ft-house-blocker-only]:not([data-ft-house-active])');
  });
  it('fills a stalled React/GPT wrapper without clearing its pending request marker', async () => {
    const empty = frame('waiting_response'); empty.google.setAttribute('data-ft-ad-request-pending', '1');
    const ins = w.document.createElement('ins'); ins.setAttribute('data-ft-ad-stalled', 'response_stalled'); empty.google.append(ins);
    await start();
    expect(empty.host.querySelector('a')).not.toBeNull();
    expect(empty.google.hasAttribute('data-ft-ad-request-pending')).toBe(true);
    expect(emit).toHaveBeenCalledWith('house_ad_rendered', expect.objectContaining({ fallback_reason: 'response_stalled' }));
  });
  it('starts the Firebase assignment during the definitive no-fill grace period', async () => {
    let resolveAssignment!: (response: { ok: boolean; json: () => Promise<{ variant: string; enrolled: boolean; assignmentSource: string }> }) => void;
    w.fetch = vi.fn(() => new Promise((resolve) => { resolveAssignment = resolve; }));
    const empty = frame('unfilled');
    const install = w.eval(`(${installHouseAds.toString()})`);
    install(w.eval(`(${createHouseAdCreative.toString()})`), HOUSE_AD_CREATIVE_CSS, emit, () => true, config);
    await vi.advanceTimersByTimeAsync(100);
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(empty.host.querySelector('a')).toBeNull();
    resolveAssignment({ ok: true, json: async () => ({ variant: 'time_saved', enrolled: true, assignmentSource: 'firebase_remote_config' }) });
    await vi.advanceTimersByTimeAsync(1100);
    expect(empty.host.querySelector('a')?.dataset.houseCreative).toBe('time_saved_v1');
  });
  it('refreshes on a Funding Choices blocker signal and respects an allowlisted result', async () => {
    const empty = frame('waiting_response'); empty.google.setAttribute('data-ft-ad-request-pending', '1');
    await start();
    w.__ftAdBlock = { blocked: true, adsAllowed: false };
    w.dispatchEvent(new w.Event('frontaliere:adblock-data'));
    await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.querySelector('a')).not.toBeNull();
    w.__ftAdBlock = { blocked: true, adsAllowed: true };
    w.dispatchEvent(new w.Event('frontaliere:adblock-data'));
    await vi.advanceTimersByTimeAsync(200);
    expect(empty.host.childElementCount).toBe(0);
  });
  it('fills a blocked SDK slot after retries are exhausted without touching Google markup', async () => {
    const empty = frame('waiting_width');
    const script = w.document.createElement('script'); script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'; script.dataset.failed = '1'; script.dataset.ftScriptState = 'retry_wait'; w.document.head.append(script);
    await start(); expect(empty.host.childElementCount).toBe(0);
    script.dataset.ftScriptState = 'failed';
    await Promise.resolve();
    w.__ftHouseAds.refresh();
    await vi.advanceTimersByTimeAsync(2500);
    expect(empty.host.querySelector('a')).not.toBeNull(); expect(script.dataset.ftScriptState).toBe('failed');
  });
  it('uses unenrolled control when Firebase is unavailable', async () => {
    w.fetch.mockRejectedValue(new Error('offline')); const empty = frame('unfilled'); await start();
    expect(empty.host.querySelector('a')?.dataset.houseCreative).toBe('control_v1');
    empty.host.querySelector('a').click();
    expect(JSON.parse(w.sessionStorage.getItem('ft_house_ad_click_v1')).enrolled).toBe(false);
  });
  it('starts Firebase assignment after analytics consent and uses the next unseen fallback slot', async () => {
    w.__ftAdsAuthState = 'anonymous';
    w.localStorage.setItem('frontaliere_consent', JSON.stringify({ analytics: false }));
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1',
      readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const first = frame('unfilled'); await start();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');

    w.localStorage.setItem('frontaliere_consent', JSON.stringify({ analytics: true }));
    w.dispatchEvent(new w.Event(config.consentEvent));
    const next = frame('unfilled', 'article-end');
    await vi.advanceTimersByTimeAsync(1600);

    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    expect(next.host.querySelector('a')?.dataset.houseCampaign).toBe('reader_subscription');
  });
  it('stores Firebase assignment metadata with the click for purchase attribution', async () => {
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({ variant: 'profile_match', enrolled: true, experimentId: 'house_creatives_v2', assignmentSource: 'firebase_remote_config' }) });
    const empty = frame('unfilled'); await start();
    empty.host.querySelector('a').click();
    expect(JSON.parse(w.sessionStorage.getItem('ft_house_ad_click_v1'))).toMatchObject({
      experimentId: 'house_creatives_v2', assignmentSource: 'firebase_remote_config', variant: 'profile_match', enrolled: true,
    });
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
  it('puts one subscription card in the next unseen adjacent fallback slot and keeps the following slot for jobs', async () => {
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1', readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const first = frame('unfilled'); await start();
    expect(w.__ftAdsAuthStateRequested).toBe(true);
    expect(first.host.querySelector('[data-house-campaign="reader_subscription"]')).toBeNull();
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    w.dispatchEvent(new w.CustomEvent('frontaliere:auth-state', { detail: 'anonymous' }));
    const next = frame('unfilled', 'article-inline-next');
    const following = frame('unfilled', 'article-end');
    await vi.advanceTimersByTimeAsync(1600);
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    expect(next.host.querySelector('a')?.dataset.houseCampaign).toBe('reader_subscription');
    expect(following.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
  });
  it('shows at most one subscription card to an anonymous treatment user and only in owned fallback slots', async () => {
    w.__ftAdsAuthState = 'anonymous';
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1', readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const first = frame('unfilled'); const second = frame('unfilled', 'article-end'); const paid = frame('filled', 'paid-slot');
    await start();
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('reader_subscription');
    expect(second.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    expect(second.host.querySelector('a')?.href).toContain('/automatizza-ricerca-lavoro-svizzera/');
    expect(paid.host.childElementCount).toBe(0);
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_ad_impression')).toHaveLength(1);
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_experiment_exposure')).toHaveLength(1);
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_experiment_impression')).toHaveLength(1);
    expect(JSON.parse(w.sessionStorage.getItem('ft_reader_subscription_attribution_v1'))).toMatchObject({
      campaign: 'reader_subscription', experimentId: 'reader_subscription_house_v1',
      variant: 'subscription', touchpoint: 'exposure', enrolled: true,
    });
  });
  it('measures one matched control slot impression and click for the subscription experiment', async () => {
    w.__ftAdsAuthState = 'anonymous';
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'control', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1', readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const first = frame('unfilled'); const second = frame('unfilled', 'article-end');
    await start();
    expect(first.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    expect(second.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_experiment_exposure')).toHaveLength(1);
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_experiment_impression')).toHaveLength(1);
    first.host.querySelector('a').click();
    second.host.querySelector('a').click();
    expect(emit.mock.calls.filter(([name]) => name === 'reader_subscription_experiment_click')).toHaveLength(1);
    expect(emit.mock.calls.find(([name]) => name === 'reader_subscription_experiment_impression')?.[1]).toMatchObject({
      experiment_id: 'reader_subscription_house_v1', experiment_variant: 'control',
    });
  });
  it('does not show the subscription card to a signed-in treatment user', async () => {
    w.__ftAdsAuthState = 'authenticated';
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1', readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const empty = frame('unfilled'); await start();
    expect(empty.host.querySelector('a')?.dataset.houseCampaign).toBe('job_search_automation');
  });
  it('keeps a viewable subscription impression stable and stores click attribution separately from job-search clicks', async () => {
    w.__ftAdsAuthState = 'anonymous';
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({
      variant: 'control', enrolled: false, assignmentSource: 'local_default',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1', readerSubscriptionAssignmentSource: 'firebase_remote_config',
    }) });
    const empty = frame('unfilled'); await start();
    const creative = empty.host.querySelector('a');
    expect(creative.dataset.houseCampaign).toBe('reader_subscription');
    creative.click();
    expect(JSON.parse(w.sessionStorage.getItem('ft_reader_subscription_ad_click_v1'))).toMatchObject({
      variant: 'subscription', creativeId: 'subscription_v1', touchpoint: 'click', enrolled: true,
    });
    expect(w.sessionStorage.getItem('ft_house_ad_click_v1')).toBeNull();
    w.__ftHouseAds.refresh(); await vi.advanceTimersByTimeAsync(1200);
    expect(empty.host.querySelector('a')?.dataset.houseCampaign).toBe('reader_subscription');
  });
  it('renders the localized subscription offer for a compact banner', () => {
    const render = w.eval(`(${createHouseAdCreative.toString()})`);
    const creative = render({ campaign: 'reader_subscription', variant: 'control', format: 'mobile_banner', locale: 'it', placement: 'article-inline' });
    expect(creative.href).toContain('/abbonamento/?');
    expect(creative.textContent).toContain('Naviga senza pubblicità');
    expect(creative.textContent).toContain('CHF 2.99 al mese');
    expect(creative.textContent).toContain('Scopri');
    expect(creative.dataset.houseCreative).toBe('subscription_v1');
  });
});

describe('bounded purchase attribution', () => {
  const click = () => ({ campaign: 'job_search_automation', variant: 'control', creativeId: 'control_v1', format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true, clickedAt: Date.now() - 1000 });
  it('keeps public campaign fields and strips arbitrary user data', () => {
    expect(sanitizeHouseAdAttribution({ ...click(), email: 'discard@example.test', url: 'https://example.test/private/' })).toEqual({ ...click(), experimentId: 'house_creatives_v1', assignmentSource: 'legacy_client_hash' });
  });
  it('preserves Firebase assignment through click attribution and purchase enrollment', () => {
    const current = { ...click(), experimentId: 'house_creatives_v2', assignmentSource: 'firebase_remote_config' };
    expect(sanitizeHouseAdAttribution(current)).toEqual(current);
    expect(sanitizeHouseAdAttribution({ ...current, assignmentSource: 'local_default' })).toMatchObject({ enrolled: false, assignmentSource: 'local_default' });
  });
  it.each([
    { variant: 'unknown' }, { experimentId: 'unreleased_experiment' }, { creativeId: 'mismatch_v1' }, { placement: 'https://example.test/private/' },
    { clickedAt: Infinity }, { clickedAt: Date.now() + 86400000 }, { clickedAt: Date.now() - 8 * 86400000 },
  ])('rejects invalid or expired metadata %j', bad => { expect(sanitizeHouseAdAttribution({ ...click(), ...bad })).toBeNull(); });
  it('accepts only bounded Firebase subscription experiment attribution', () => {
    const value = {
      campaign: 'reader_subscription', experimentId: 'reader_subscription_house_v1',
      assignmentSource: 'firebase_remote_config', variant: 'subscription', creativeId: 'subscription_v1',
      format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true,
      touchpoint: 'click', attributedAt: Date.now() - 1000, randomizationId: 'discard-this',
    };
    expect(sanitizeReaderSubscriptionAdAttribution(value)).toEqual({
      campaign: 'reader_subscription', experimentId: 'reader_subscription_house_v1',
      assignmentSource: 'firebase_remote_config', variant: 'subscription', creativeId: 'subscription_v1',
      format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true,
      touchpoint: 'click', attributedAt: value.attributedAt,
    });
    expect(sanitizeReaderSubscriptionAdAttribution({ ...value, variant: 'control', touchpoint: 'click', creativeId: 'control_v1' })).toBeNull();
    expect(sanitizeReaderSubscriptionAdAttribution({ ...value, placement: 'https://private.example/path' })).toBeNull();
  });
});
