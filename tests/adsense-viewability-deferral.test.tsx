// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
/**
 * Viewability deferral — an ad unit may not spend an ad request before the
 * visitor has come near it.
 *
 * ── What was wrong ────────────────────────────────────────────────────
 *
 * Both render paths loaded adsbygoogle.js lazily and then requested EVERY slot
 * on the page at once, wherever it sat:
 *   • the static shell loader pushed once per `<ins>` in `s.onload`;
 *   • the SPA banner treated "the script is already on the page" as "arm this
 *     slot", and the idle fallback puts the script on the page ~1.5s after
 *     mount — i.e. before the job list has finished rendering, so every in-feed
 *     unit mounted afterwards took that branch.
 *
 * Measured live on /cerca-lavoro-ticino/ at 412×915 (real Chrome, consent
 * granted, no interaction at all): 5 units requested together at t≈2.6s with
 * the visitor still at scrollY=0, sitting 270px, 1162px, 2044px and 2761px
 * below the fold. Zero were viewable. AdSense reports the consequence on the
 * unit those in-feed slots share (3205029282): 22.1% viewability over 92.7k
 * mobile impressions/30d, against 62.0% on desktop — where the same unit's only
 * placement renders at y=133. Same unit, same creatives; the only difference is
 * whether the request was spent on something the visitor could see.
 *
 * ── What these tests pin ──────────────────────────────────────────────
 *
 * Behaviour, not source text: both paths are EXECUTED against a scripted
 * IntersectionObserver, and the assertion is the count of `adsbygoogle.push`
 * calls after each simulated scroll. A source-pattern test would have stayed
 * green through the exact regression above, because the eager path was spelled
 * as an early `return`, not as a missing observer.
 *
 * NOT tested here (belongs to tests/adsense-lazy-load.test.ts): that the SCRIPT
 * still loads on idle / first interaction / slot approach. That is the
 * Auto Ads lifeline (~95% of revenue, AGENTS.md Non-Negotiable #7) and it is
 * deliberately untouched by the deferral — only the per-slot push moved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

import { ADSENSE_LOADER_CONTENT } from '@/build-plugins/constants';
import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED } from '@/services/adsConsent';
import { AD_SLOT_VIEWPORT_ROOT_MARGIN } from '@/services/adsenseSlots';

/** A real iPhone Safari UA. jsdom's default trips the bot gate in both paths,
 *  which would suppress every push for the WRONG reason — a green test with no
 *  deferral in it at all. */
const REAL_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const ADSENSE_SELECTOR = 'script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]';

// ── Scripted IntersectionObserver ───────────────────────────────────────
// jsdom ships none, so both paths would otherwise take their
// "IntersectionObserver unavailable" fallback and request everything eagerly —
// correct behaviour for a browser that cannot observe, useless as a test of the
// behaviour that matters.

interface StubIo {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  targets: Element[];
  disconnected: boolean;
}

let ioInstances: StubIo[] = [];

function installIntersectionObserver(): void {
  class Stub implements StubIo {
    callback: IntersectionObserverCallback;
    options?: IntersectionObserverInit;
    targets: Element[] = [];
    disconnected = false;
    constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = cb;
      this.options = options;
      ioInstances.push(this);
    }
    observe(el: Element) { this.targets.push(el); }
    unobserve(el: Element) { this.targets = this.targets.filter((t) => t !== el); }
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  }
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Stub;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Stub;
}

/** Simulates those elements scrolling into (near) view. */
function intersect(io: StubIo, elements: Element[]): void {
  io.callback(
    elements.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry),
    io as unknown as IntersectionObserver,
  );
}

function pushCount(): number {
  const q = (window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle;
  return Array.isArray(q) ? q.length : 0;
}

beforeEach(() => {
  ioInstances = [];
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
  delete (window as unknown as { adsbygoogle?: unknown }).adsbygoogle;
  Object.defineProperty(window.navigator, 'userAgent', { value: REAL_UA, configurable: true });
  // The loader schedules loadScript through requestIdleCallback; make it
  // synchronous so the whole arm sequence resolves inside the test.
  (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

// ════════════════════════════════════════════════════════════════════════
// Static shell loader (ADSENSE_LOADER_CONTENT) — the ~200k SEO pages
// ════════════════════════════════════════════════════════════════════════

/** Lays out N `<ins class="adsbygoogle">` the way an in-feed list does, runs the
 *  loader, and fires the injected script's `load` event. Returns the slots and
 *  the per-slot observer the loader created on load. */
function runStaticLoaderWithSlots(count: number): { slots: HTMLElement[]; slotIo: StubIo } {
  const slots: HTMLElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.setAttribute('data-ad-slot', `slot-${i}`);
    document.body.appendChild(ins);
    slots.push(ins);
  }

  // eslint-disable-next-line no-new-func
  new Function(ADSENSE_LOADER_CONTENT)();

  const script = document.querySelector<HTMLScriptElement>(ADSENSE_SELECTOR);
  expect(script, 'loader must still inject adsbygoogle.js — Auto Ads depend on it').not.toBeNull();
  script!.dispatchEvent(new Event('load'));

  // ioInstances[0] is the script-load observer created in observe();
  // the per-slot observer is the one created by armSlots() on script load.
  const slotIo = ioInstances[ioInstances.length - 1];
  return { slots, slotIo };
}

describe('static shell loader — per-slot request deferral', () => {
  beforeEach(() => { installIntersectionObserver(); });

  it('requests NOTHING when the script loads and no slot is near the viewport', () => {
    runStaticLoaderWithSlots(5);
    // The regression this file exists for: this used to be 5 — one push per
    // <ins> in s.onload, for units 1000s of px below the fold.
    expect(pushCount()).toBe(0);
  });

  it('requests exactly one unit when one slot comes near the viewport', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(5);
    intersect(slotIo, [slots[0]]);
    expect(pushCount()).toBe(1);
  });

  it('never requests the slots the visitor never reaches', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(5);
    intersect(slotIo, [slots[0]]);
    intersect(slotIo, [slots[1]]);
    // Visitor leaves after the second in-feed ad. Slots 2-4 stay unrequested.
    expect(pushCount()).toBe(2);
  });

  it('catches up in DOM order when a slot below is reached first (deep link / scroll restore)', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(5);
    intersect(slotIo, [slots[2]]);
    // 3, not 1. `adsbygoogle.push({})` is NOT bound to an element — it fills the
    // next `<ins>` in DOM order without a status. Pushing once here would have
    // bound to slot 0 (off-screen) and left the slot the visitor is actually
    // looking at empty, i.e. the deferral would have moved which unit is wasted
    // instead of removing the waste. Catching up keeps each push on the element
    // it was issued for.
    expect(pushCount()).toBe(3);
  });

  it('does not re-request a slot that scrolls back into view', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(5);
    intersect(slotIo, [slots[0]]);
    intersect(slotIo, [slots[0]]);
    intersect(slotIo, [slots[0], slots[1]]);
    expect(pushCount()).toBe(2);
  });

  it('spends no push on an <ins> that left the DOM (SPA replaced the static body)', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(5);
    slots[0].remove();
    slots[1].remove();
    intersect(slotIo, [slots[2]]);
    // Only slot 2 is still connected, so only one request is spent — and it
    // binds to slot 2, because a detached <ins> is not a push target either.
    expect(pushCount()).toBe(1);
  });

  it('stops observing once every slot has been requested', () => {
    const { slots, slotIo } = runStaticLoaderWithSlots(3);
    intersect(slotIo, [slots[2]]);
    expect(pushCount()).toBe(3);
    expect(slotIo.disconnected).toBe(true);
  });

  it('uses the shared root margin, so the two paths cannot drift apart', () => {
    const { slotIo } = runStaticLoaderWithSlots(2);
    expect(slotIo.options?.rootMargin).toBe(AD_SLOT_VIEWPORT_ROOT_MARGIN);
  });
});

describe('static shell loader — browsers without IntersectionObserver', () => {
  it('requests every slot eagerly rather than serving nothing', () => {
    // No stub installed: `'IntersectionObserver' in window` is false. A browser
    // that cannot observe must not be silently demonetised — falling back to
    // today's eager behaviour is the correct trade (AGENTS.md #7: never suppress
    // the ad system).
    runStaticLoaderWithSlots(4);
    expect(pushCount()).toBe(4);
  });
});

describe('static shell loader — source contract', () => {
  it('does not push inside the script onload handler', () => {
    // Behavioural tests above cover the outcome; this pins the specific line
    // that regressed, so a refactor reintroducing "push once per <ins> on load"
    // fails here with an unambiguous message rather than through a count.
    expect(ADSENSE_LOADER_CONTENT).toContain('s.onload=armSlots;');
    expect(ADSENSE_LOADER_CONTENT).not.toContain(
      "querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])')",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// SPA <AdSenseBanner> — the job board / job detail surfaces
// ════════════════════════════════════════════════════════════════════════

async function renderBanner() {
  const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
  render(<AdSenseBanner adSlot="3205029282" adFormat="auto" />);
}

/** The observer AdSenseBanner attaches to its own wrapper. */
function bannerIo(): StubIo {
  const io = ioInstances[ioInstances.length - 1];
  expect(io, 'AdSenseBanner must arm through an IntersectionObserver').toBeTruthy();
  return io;
}

describe('SPA <AdSenseBanner> — per-slot request deferral', () => {
  beforeEach(() => { installIntersectionObserver(); });

  it('renders the reserved box but no <ins> until the slot approaches the viewport', async () => {
    await renderBanner();
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
    // The reservation is what keeps CLS flat while the unit is un-armed, so it
    // must be present from first paint even though the <ins> is not.
    const wrapper = document.querySelector<HTMLElement>('div[aria-hidden="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.minHeight).not.toBe('');
    expect(wrapper!.style.minHeight).not.toBe('0px');
  });

  it('mounts the <ins> once the slot approaches the viewport', async () => {
    await renderBanner();
    const io = bannerIo();
    await act(async () => { intersect(io, io.targets); });
    const ins = document.querySelector('ins.adsbygoogle');
    expect(ins).not.toBeNull();
    expect(ins!.getAttribute('data-ad-slot')).toBe('3205029282');
  });

  it('is NOT armed by the script already being on the page', async () => {
    // The exact regression: the idle fallback injects adsbygoogle.js ~1.5s after
    // mount, before the SPA job list finishes rendering, so every in-feed banner
    // mounted afterwards saw a script tag and armed itself on the spot.
    const pre = document.createElement('script');
    pre.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8628054934855353';
    document.head.appendChild(pre);

    await renderBanner();
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
  });

  it('is NOT armed by a scroll anywhere on the page', async () => {
    // Every banner registers the first-interaction listeners on `document`, so a
    // single scroll used to arm all of them at once — including the ones twelve
    // cards further down.
    await renderBanner();
    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('pointerdown'));
    });
    expect(document.querySelector('ins.adsbygoogle')).toBeNull();
  });

  it('still loads adsbygoogle.js on first interaction (Auto Ads lifeline)', async () => {
    // The deferral moved the PUSH, never the script load: Auto Ads are ~95% of
    // revenue and must keep firing on a no-scroll bounce (AGENTS.md #7).
    await renderBanner();
    await act(async () => { document.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });

  it('arms through an observer that uses the shared root margin', async () => {
    await renderBanner();
    expect(bannerIo().options?.rootMargin).toBe(AD_SLOT_VIEWPORT_ROOT_MARGIN);
  });
});
