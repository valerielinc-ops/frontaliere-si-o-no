// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
/**
 * Ads-consent gate — the exit criterion of #5842.
 *
 * ONE thing matters here: **not a single advertising script may reach the DOM
 * before the visitor has granted consent**. Everything else in this file exists
 * to make that assertion non-vacuous.
 *
 * ── Why the URL docblock above is load-bearing ────────────────────────
 *
 * `AdSenseBanner` and `GptAdSlot` compute `IS_PROD` at MODULE SCOPE from
 * `window.location.hostname`. Under the default jsdom URL (`localhost`) both are
 * inert: they inject nothing, consent or not. A test written without that
 * docblock therefore passes whether the gate exists or not — it would be the
 * sixteenth "guard that exists and does not look" in this workspace. The
 * docblock pins jsdom to the real production host so the ad path actually runs,
 * and `asserts the gate is reachable` below fails loudly if that ever stops
 * being true.
 *
 * ── Why the user agent is overridden ──────────────────────────────────
 *
 * Both the SPA and the inline loader are bot-gated. jsdom's default UA is not a
 * real browser's, and a UA that trips the bot gate would suppress the script for
 * the wrong reason — green test, absent gate. A real iPhone Safari UA keeps the
 * bot gate open so the only thing that can stop the injection is consent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ADSENSE_LOADER_CONTENT } from '@/build-plugins/constants';
import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED, ADS_CONSENT_DENIED } from '@/services/adsConsent';

const REAL_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const ADSENSE_SELECTOR = 'script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]';
const GPT_SELECTOR = 'script[src*="securepubads.g.doubleclick.net/tag/js/gpt.js"]';

/**
 * Every advertising script, whatever its origin — not just the one a given test
 * expects. Prebid is served first-party from `/assets/prebid.js`, so a filter
 * written only against third-party ad hosts would miss it entirely; that is why
 * this matches a path as well as the Google origins.
 */
function injectedAdScripts(): string[] {
  return Array.from(document.querySelectorAll('script'))
    .map((s) => s.getAttribute('src') || '')
    .filter((src) =>
      /pagead2\.googlesyndication\.com|securepubads\.g\.doubleclick\.net|fundingchoicesmessages\.google\.com|\/assets\/prebid\.js/.test(src),
    );
}

/**
 * Runs the inline loader that statically generated pages carry — the
 * highest-traffic ad path on the site, and the one the SPA components cannot
 * speak for. `requestIdleCallback` is made synchronous so the loader's idle
 * branch resolves within the test instead of after it.
 */
function runStaticLoader(): void {
  (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
  // eslint-disable-next-line no-new-func
  new Function(ADSENSE_LOADER_CONTENT)();
  // Also exercise the interaction path, which the loader wires on `observe()`.
  document.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'userAgent', { value: REAL_UA, configurable: true });
  localStorage.clear();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ads-consent gate — no ad script before consent', () => {
  it('static page loader injects NOTHING when no decision has been made', () => {
    runStaticLoader();
    expect(injectedAdScripts()).toEqual([]);
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();
  });

  it('static page loader injects NOTHING when consent is explicitly denied', () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    runStaticLoader();
    expect(injectedAdScripts()).toEqual([]);
  });

  it('static page loader injects NOTHING for a corrupted/unknown stored value', () => {
    // Fails closed: anything that is not the literal 'granted' blocks.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'true');
    runStaticLoader();
    expect(injectedAdScripts()).toEqual([]);
  });

  it('injects NOTHING when reading the consent key throws (fails closed)', async () => {
    // Found by the mutation harness: flipping the loader's `catch` from
    // `return false` to `return true` was NOT caught before this test existed.
    // Safari private mode and storage-partitioned iframes both make getItem
    // throw, and a gate that fails open there serves ads to everyone it cannot
    // read a decision for. Only the consent key throws, so the earlier
    // `reader_noads_active` read still succeeds and cannot mask the result.
    // NB: patching `Storage.prototype.getItem` does NOT work — jsdom's
    // localStorage does not dispatch through the prototype, so the override
    // never fires and the test passes for the ordinary "no decision" reason
    // while proving nothing. The first version of this test did exactly that
    // and the mutation harness caught it. Replace the object instead.
    const real = window.localStorage;
    const throwing: Storage = {
      getItem: (k: string) => {
        if (k === ADS_CONSENT_STORAGE_KEY) throw new DOMException('denied', 'SecurityError');
        return real.getItem(k);
      },
      setItem: (k: string, v: string) => real.setItem(k, v),
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
    };
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true });
    try {
      runStaticLoader();
      expect(injectedAdScripts()).toEqual([]);

      const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
      render(<AdSenseBanner adSlot="1234567890" adFormat="auto" />);
      expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', { value: real, configurable: true });
    }
  });

  it('SPA <AdSenseBanner> injects NOTHING for a corrupted/unknown stored value', async () => {
    // The SPA reads consent through services/adsConsent, the static loader reads
    // localStorage directly — so "anything that is not 'granted' blocks" has to
    // be asserted on BOTH paths. Covering only the loader left the legacy-blob
    // bug class (any stored value counting as consent) undetected in the SPA.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'true');
    const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
    render(<AdSenseBanner adSlot="1234567890" adFormat="auto" />);
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();
  });

  it('SPA <AdSenseBanner> injects NOTHING when no decision has been made', async () => {
    const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
    render(<AdSenseBanner adSlot="1234567890" adFormat="auto" />);
    expect(injectedAdScripts()).toEqual([]);
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();
  });

  it('Prebid (header bidding) injects NOTHING when no decision has been made', async () => {
    // Prebid broadcasts bid requests to third-party bidders and forwards the
    // TCF consent string, so it is squarely an advertising script.
    //
    // Reached through the module's own `__testing` handle. An earlier version
    // of this test called `requestHeaderBids()` and asserted "no script" — but
    // that returns early on `PREBID_ENABLED === false` long before the gate, so
    // it proved only that the feature is off. The mutation harness scored it as
    // a hole, and `__testing.ensurePrebidScript` is the entry point that
    // actually exercises the gate (it is what the existing
    // tests/header-bidding-script-error.test.ts uses for the same reason).
    const { __testing } = await import('@/services/headerBidding');
    __testing.resetForTests();
    __testing.ensurePrebidScript();
    expect(document.querySelector('script[src="/assets/prebid.js"]')).toBeNull();
    expect(injectedAdScripts()).toEqual([]);
  });

  it('Prebid DOES load once consent is granted', async () => {
    // The counterpart: proves the block above is caused by consent and not by
    // the feature simply being inert.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const { __testing } = await import('@/services/headerBidding');
    __testing.resetForTests();
    __testing.ensurePrebidScript();
    expect(document.querySelector('script[src="/assets/prebid.js"]')).not.toBeNull();
  });

  it('SPA <GptAdSlot> injects NOTHING when no decision has been made', async () => {
    const { default: GptAdSlot } = await import('@/components/shared/GptAdSlot');
    render(<GptAdSlot adUnitPath="/123/rail" sizes={[[300, 600]]} />);
    expect(document.querySelector(GPT_SELECTOR)).toBeNull();
  });
});

describe('ads-consent gate — the gate is reachable, and opens', () => {
  /**
   * The counterpart assertion. Without it, a gate that blocks unconditionally
   * (or a jsdom/host misconfiguration that makes the ad path inert) would sail
   * through the tests above while the site earned nothing. This is what makes
   * the block-assertions above mean "blocked BY CONSENT" rather than merely
   * "nothing happened".
   */
  it('static page loader DOES inject adsbygoogle.js once consent is granted', () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    runStaticLoader();
    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });

  it('SPA <AdSenseBanner> DOES inject adsbygoogle.js once consent is granted', async () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
    render(<AdSenseBanner adSlot="1234567890" adFormat="auto" />);
    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });
});

describe('ads-consent gate — banner wiring', () => {
  it('the banner grants consent and an already-mounted slot then loads', async () => {
    const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
    const { default: AdsConsentBanner } = await import('@/components/shared/AdsConsentBanner');
    const view = render(
      <>
        <AdsConsentBanner />
        <AdSenseBanner adSlot="1234567890" adFormat="auto" />
      </>,
    );
    // Nothing yet: the visitor has not answered.
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();

    const accept = view.getByRole('button', { name: /accetta gli annunci/i });
    await act(async () => {
      accept.click();
    });

    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
    // The slot re-armed in the same page view — this is what protects fill rate
    // for visitors who accept (no reload required).
    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });

  it('the banner disappears once answered and does not return', async () => {
    const { default: AdsConsentBanner } = await import('@/components/shared/AdsConsentBanner');
    const view = render(<AdsConsentBanner />);
    const decline = view.getByRole('button', { name: /continua senza annunci/i });
    await act(async () => {
      decline.click();
    });
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
    expect(view.queryByRole('dialog')).toBeNull();

    cleanup();
    const second = render(<AdsConsentBanner />);
    expect(second.queryByRole('dialog')).toBeNull();
  });
});

describe('ads-consent gate — storage contract', () => {
  it('the emitted static loader is built from the shared constants, not a re-typed literal', () => {
    // Guards the one drift this design can still suffer: the SPA and the static
    // shells disagreeing about which key/value means consent.
    expect(ADSENSE_LOADER_CONTENT).toContain(ADS_CONSENT_STORAGE_KEY);
    expect(ADSENSE_LOADER_CONTENT).toContain(`==='${ADS_CONSENT_GRANTED}'`);
  });

  it('the consent check runs BEFORE the loader wires any listener or observer', () => {
    // Ordering matters: the gate must short-circuit the whole IIFE. If it were
    // placed after `observe()`, a denied visitor would still get the
    // IntersectionObserver and the interaction listeners wired.
    const gateAt = ADSENSE_LOADER_CONTENT.indexOf(ADS_CONSENT_STORAGE_KEY);
    const observeAt = ADSENSE_LOADER_CONTENT.indexOf('IntersectionObserver');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(observeAt);
  });

  it('does NOT gate analytics — PostHog/GA4/Clarity stay outside this decision', () => {
    // Owner decision in #5842: the banner is advertising-only. If someone later
    // widens the gate to analytics, this fails and forces the conversation.
    expect(ADSENSE_LOADER_CONTENT).not.toContain('posthog');
    expect(ADSENSE_LOADER_CONTENT).not.toContain('clarity');
  });
});
