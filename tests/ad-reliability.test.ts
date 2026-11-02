import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createAdSlotRequests } from '../services/adSlotRequest';
import { createAdScriptLoader } from '../services/adScriptLoader';
import { createStaticAdSlotEligibility } from '../services/staticAdSlotEligibility';
import { createStaticAdDelivery } from '../services/staticAdDelivery';
import { probeIabAdBlock } from '../services/iabAdBlockProbe';
import { installAdRecovery } from '../services/adRecovery';
import { FC_ENSURE_JS } from '../build-plugins/constants';

let dom: JSDOM;
let w: any;
const emit = vi.fn();
function local<T extends (...args: any[]) => any>(fn: T): T { return w.eval(`(${fn.toString()})`); }
function slot(width: number, layout = 'in-article') {
  const parent = w.document.createElement('div'); parent.dataset.width = String(width);
  const el = w.document.createElement('ins'); el.dataset.width = String(width); el.dataset.adSlot = 'example'; el.dataset.adLayout = layout;
  parent.appendChild(el); w.document.body.appendChild(parent); return el;
}
beforeEach(() => {
  vi.useFakeTimers(); emit.mockClear();
  dom = new JSDOM('<!doctype html><html lang="it"><head></head><body><main>Article</main></body></html>', { url: 'https://frontaliereticino.ch/articolo/', runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window; w.Date = Date;
  w.adsbygoogle = []; w.gtag = emit;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = Number(this.dataset.width || parseFloat(this.style.width) || 300);
    return { width, height: 100, top: 0, left: 0, bottom: 100, right: width };
  };
});
afterEach(() => { dom.window.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('shared manual-slot request contract', () => {
  it('does not push at 161/249px, then requests once at 250px', () => {
    const api = local(createAdSlotRequests)(); const el = slot(161);
    expect(api.request(el).state).toBe('waiting_width');
    expect(el.classList.contains('adsbygoogle')).toBe(false);
    el.dataset.width = '249'; el.parentElement.dataset.width = '249';
    expect(api.request(el).state).toBe('waiting_width');
    el.dataset.width = '250'; el.parentElement.dataset.width = '250';
    expect(api.request(el).state).toBe('requested');
    expect(local(createAdSlotRequests)().request(el).state).toBe('processed');
    expect(w.adsbygoogle).toHaveLength(1);
  });
  it('checks the ins and parent content width, not the padded wrapper width', () => {
    const el = slot(275); el.parentElement.style.padding = '0 24px';
    expect(local(createAdSlotRequests)().request(el)).toMatchObject({ state: 'waiting_width', width: 227, minimum: 250 });
  });
  it('keeps other formats independent of the in-article 250px requirement', () => {
    expect(local(createAdSlotRequests)().request(slot(160, '')).state).toBe('requested');
  });
  it('never re-pushes a node initialized by the static shell or Google', () => {
    const el = slot(300); el.setAttribute('data-adsbygoogle-status', 'done');
    expect(local(createAdSlotRequests)().request(el).state).toBe('processed');
    expect(w.adsbygoogle).toHaveLength(0);
  });
  it('classifies TagError and removes failed nodes from the implicit queue', () => {
    const el = slot(300); w.adsbygoogle = { push() { const err = new w.Error('No slot size for availableWidth'); err.name = 'TagError'; throw err; } };
    expect(local(createAdSlotRequests)().request(el)).toMatchObject({ state: 'failed', code: 'invalid_size', errorName: 'TagError' });
    expect(el.classList.contains('adsbygoogle')).toBe(false);
  });
  it('does not retry a partially initialized element after a throw', () => {
    const el = slot(300); w.adsbygoogle = { push() { el.setAttribute('data-adsbygoogle-status', 'done'); throw new w.Error('already filled'); } };
    expect(local(createAdSlotRequests)().request(el).state).toBe('processed');
  });
  it('static scheduling defers a narrow slot without consuming the next slot’s push', () => {
    const narrow = slot(161); const valid = slot(300);
    const watchers = new Map(); const watch = (el: Element) => { if (!watchers.has(el)) watchers.set(el, { request: vi.fn(), fail: vi.fn() }); return watchers.get(el); };
    const delivery = local(createStaticAdDelivery)(local(createAdSlotRequests)(), local(createStaticAdSlotEligibility)(), watch, () => true, emit, '200px 0px');
    delivery.arm();
    expect(w.adsbygoogle).toHaveLength(1); expect(watch(valid).request).toHaveBeenCalledOnce();
    expect(narrow.classList.contains('adsbygoogle')).toBe(false);
    narrow.dataset.width = '250'; narrow.parentElement.dataset.width = '250';
    w.dispatchEvent(new w.Event('resize')); vi.advanceTimersByTime(50);
    expect(w.adsbygoogle).toHaveLength(2); expect(watch(narrow).request).toHaveBeenCalledOnce();
    delivery.arm(); expect(w.adsbygoogle).toHaveLength(2);
  });
});

describe('singleton script recovery', () => {
  const src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  it('shares attempts across callers and recovers a transient error without an online event', () => {
    const factory = local(createAdScriptLoader);
    const first = factory('adsense', src, () => true, emit);
    expect(factory('adsense', src, () => true, emit)).toBe(first);
    first.load(); w.document.scripts[0].dispatchEvent(new w.Event('error'));
    expect(first.state()).toBe('retry_wait');
    vi.advanceTimersByTime(2000);
    expect(first.attempts()).toBe(2);
    w.document.scripts[0].dispatchEvent(new w.Event('load'));
    expect(first.state()).toBe('loaded');
    vi.advanceTimersByTime(60000); first.load(); expect(first.attempts()).toBe(2);
  });
  it('keeps a slow script pending without duplicate injection and accepts late success', () => {
    const loader = local(createAdScriptLoader)('adsense', src, () => true, emit);
    loader.load(); vi.advanceTimersByTime(30000);
    expect(loader.state()).toBe('waiting_response'); loader.load();
    expect(loader.attempts()).toBe(1); expect(w.document.scripts).toHaveLength(1);
    w.document.scripts[0].dispatchEvent(new w.Event('load'));
    expect(loader.state()).toBe('loaded');
  });
  it('recovers a removed bootstrap without resetting the attempt budget', () => {
    const loader = local(createAdScriptLoader)('adsense', src, () => true, emit);
    loader.load(); w.document.head.innerHTML = ''; loader.load();
    expect(loader.attempts()).toBe(2); expect(w.document.scripts).toHaveLength(1);
    w.document.head.innerHTML = ''; loader.load();
    w.document.head.innerHTML = ''; loader.load();
    expect(loader.attempts()).toBe(3); expect(w.document.scripts).toHaveLength(0);
    expect(loader.state()).toBe('failed');
  });
  it('bounds retries including repeated online events', () => {
    const loader = local(createAdScriptLoader)('adsense', src, () => true, emit);
    loader.load(); w.document.scripts[0].dispatchEvent(new w.Event('error')); vi.advanceTimersByTime(2000);
    w.document.scripts[0].dispatchEvent(new w.Event('error')); vi.advanceTimersByTime(6000);
    w.document.scripts[0].dispatchEvent(new w.Event('error'));
    for (let i = 0; i < 10; i++) w.dispatchEvent(new w.Event('online'));
    vi.advanceTimersByTime(60000); expect(loader.attempts()).toBe(3);
  });
  it('honors consent on every retry and never adds crossOrigin to the CMP', () => {
    let allowed = true;
    const loader = local(createAdScriptLoader)('cmp', 'https://fundingchoicesmessages.google.com/i/pub-example?ers=1', () => allowed, emit);
    loader.load(); expect(w.document.scripts[0].hasAttribute('crossorigin')).toBe(false);
    w.document.scripts[0].dispatchEvent(new w.Event('error')); allowed = false;
    vi.advanceTimersByTime(10000); expect(loader.attempts()).toBe(1);
  });
  it('reuses Funding Choices when the HTML bootstrap completed before recovery attached', () => {
    w.eval(`${FC_ENSURE_JS};ensureFc();`);
    const script = w.document.querySelector('script[data-fc-loader]');
    script.dispatchEvent(new w.Event('load'));
    const loader = local(createAdScriptLoader)('cmp', script.src, () => true, emit);
    loader.load();
    expect(loader.state()).toBe('loaded');
    expect(w.document.querySelectorAll('script[data-fc-loader]')).toHaveLength(1);
  });
  it('counts an earlier Funding Choices error and keeps the legacy/recovery race singleton', () => {
    w.eval(`${FC_ENSURE_JS};ensureFc();`);
    const first = w.document.querySelector('script[data-fc-loader]');
    first.dispatchEvent(new w.Event('error'));
    const loader = local(createAdScriptLoader)('cmp', first.src, () => true, emit);
    loader.load();
    const next = w.document.querySelector('script[data-fc-loader]');
    expect(next).not.toBe(first); expect(loader.attempts()).toBe(2);
    w.eval(`${FC_ENSURE_JS};ensureFc();`);
    next.dispatchEvent(new w.Event('load'));
    expect(loader.state()).toBe('loaded');
    expect(w.document.querySelectorAll('script[data-fc-loader]')).toHaveLength(1);
  });
  it('does not repeatedly probe a confirmed blocker, while preserving the first Auto Ads attempt', () => {
    w.__ftAdBlock = { blocked: true };
    const loader = local(createAdScriptLoader)('adsense', src, () => true, emit);
    loader.load(); expect(loader.attempts()).toBe(1);
    w.document.scripts[0].dispatchEvent(new w.Event('error')); vi.advanceTimersByTime(60000);
    expect(loader.attempts()).toBe(1);
  });
});

describe('IAB detection and independent recovery surface', () => {
  it('distinguishes real cosmetic filtering from an unmeasurable document', async () => {
    const style = w.document.createElement('style'); style.textContent = '.text-ad { display:none }'; w.document.head.appendChild(style);
    const result = local(probeIabAdBlock)(); await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe('blocked');
    expect(w.document.querySelector('.text-ad')).toBeNull();
    w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 0, height: 0 });
    const unknown = local(probeIabAdBlock)(); await vi.advanceTimersByTimeAsync(200);
    await expect(unknown).resolves.toBe('unknown');
  });
  function recovery(result = 'blocked', state = 'failed') {
    return local(installAdRecovery)(() => Promise.resolve(result), () => ({ load() {}, state: () => state, subscribe() { return () => {}; } }), emit, () => true, { consentKey: 'frontaliere_ads_consent', consentEvent: 'frontaliere:ads-consent', publisherId: 'pub-example' });
  }
  it('offers real instructions and reload, never silently grants consent', async () => {
    recovery(); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(13000);
    const dialog = w.document.querySelector('dialog[open]'); expect(dialog).not.toBeNull();
    const allow = Array.from(dialog.querySelectorAll('button')).find((el: any) => el.textContent === 'Come autorizzare il sito') as any;
    allow.click(); expect(dialog.textContent).toContain('icona del leone');
    expect(w.localStorage.getItem('frontaliere_ads_consent')).toBeNull();
    expect(w.document.querySelector('a[href="/automatizza-ricerca-lavoro-svizzera/"]')).not.toBeNull();
  });
  it('uses neutral error copy for a CMP failure without claiming an ad blocker', async () => {
    recovery('clear'); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(13000);
    expect(w.document.querySelector('dialog')?.textContent).toContain('Gli annunci non si caricano');
    expect(w.document.querySelector('dialog')?.textContent).not.toContain('Abbiamo rilevato un blocco pubblicitario');
    expect(w.localStorage.getItem('frontaliere_ads_consent')).toBeNull();
  });
  it('never stacks on a Google consent message and removes the promotion on late fill', async () => {
    w.localStorage.setItem('frontaliere_ads_consent', 'denied');
    const el = slot(300); el.setAttribute('data-ad-status', 'unfilled');
    recovery('clear', 'loaded'); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(13000);
    expect(w.document.querySelector('.ft-recovery-promo')).not.toBeNull();
    el.setAttribute('data-ad-status', 'filled');
    await vi.advanceTimersByTimeAsync(200);
    expect(w.document.querySelector('.ft-recovery-promo')).toBeNull();
  });
  it('leaves a working Safari-like filled page free of popup and fallback', async () => {
    const el = slot(366); el.setAttribute('data-ad-status', 'filled');
    recovery('blocked'); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(w.document.querySelector('dialog')).toBeNull();
    expect(w.document.querySelector('.ft-recovery-promo')).toBeNull();
  });
  it('degrades without dialog or MutationObserver and still removes fallback on late fill', async () => {
    w.MutationObserver = undefined; w.HTMLDialogElement = undefined;
    recovery(); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(13000);
    expect(w.document.querySelector('dialog')).toBeNull();
    expect(w.document.querySelector('.ft-recovery-promo')).not.toBeNull();
    slot(300).setAttribute('data-ad-status', 'filled');
    await vi.advanceTimersByTimeAsync(1200);
    expect(w.document.querySelector('.ft-recovery-promo')).toBeNull();
  });
  it('does not cover an existing Google consent message', async () => {
    const message = w.document.createElement('div'); message.className = 'fc-consent-root'; w.document.body.append(message);
    recovery('blocked'); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(w.document.querySelector('dialog')).toBeNull();
    expect(w.document.querySelector('.ft-recovery-promo')).toBeNull();
  });
  it('reopens the actual Google consent message without persisting a synthetic decision', async () => {
    const show = vi.fn(); w.googlefc = { showRevocationMessage: show };
    w.localStorage.setItem('frontaliere_ads_consent', 'denied');
    recovery('blocked', 'loaded'); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(13000);
    const preferences = Array.from(w.document.querySelectorAll('dialog button')).find((el: any) => el.textContent === 'Apri le preferenze privacy') as any;
    expect(preferences).toBeTruthy(); preferences.click();
    expect(show).toHaveBeenCalledOnce();
    expect(w.localStorage.getItem('frontaliere_ads_consent')).toBe('denied');
  });
});
