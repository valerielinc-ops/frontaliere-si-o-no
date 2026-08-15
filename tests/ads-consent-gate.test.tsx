// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
/**
 * Ads-consent gate — the exit criterion of #5842, CMP-single-surface edition.
 *
 * ONE thing matters here: **not a single AD-SERVING script may reach the DOM
 * before the visitor has granted consent**. Ad-serving means adsbygoogle.js,
 * gpt.js and prebid.js — the scripts that request and render ads.
 *
 * Google Funding Choices is deliberately NOT in that set any more. It is the
 * CMP — the blocking TCF message that COLLECTS the consent the gate runs on —
 * so it must be able to load before a decision exists; gating it behind its
 * own output (what #5894 shipped) deadlocked cold visitors into a no-ads
 * session and produced a second, redundant consent prompt. The CMP's outcome
 * reaches the gate through FC_CONSENT_BRIDGE_JS, tested below.
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ADSENSE_LOADER_CONTENT, FC_CONSENT_BRIDGE_JS, FC_ENSURE_JS } from '@/build-plugins/constants';
import {
  ADS_CONSENT_STORAGE_KEY,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
  ADS_CONSENT_CHANGE_EVENT,
} from '@/services/adsConsent';

const REAL_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const ADSENSE_SELECTOR = 'script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]';
const GPT_SELECTOR = 'script[src*="securepubads.g.doubleclick.net/tag/js/gpt.js"]';
const FC_SELECTOR = 'script[src*="fundingchoicesmessages.google.com"]';

/**
 * Every AD-SERVING script, whatever its origin — not just the one a given test
 * expects. Prebid is served first-party from `/assets/prebid.js`, so a filter
 * written only against third-party ad hosts would miss it entirely; that is why
 * this matches a path as well as the Google origins. fundingchoicesmessages is
 * deliberately absent: the CMP is the consent surface, not an ad script — its
 * presence/absence is asserted explicitly via FC_SELECTOR where it matters.
 */
function injectedAdServingScripts(): string[] {
  return Array.from(document.querySelectorAll('script'))
    .map((s) => s.getAttribute('src') || '')
    .filter((src) =>
      /pagead2\.googlesyndication\.com|securepubads\.g\.doubleclick\.net|\/assets\/prebid\.js/.test(src),
    );
}

/**
 * Runs the inline loader that statically generated pages carry — the
 * highest-traffic ad path on the site, and the one the SPA components cannot
 * speak for. `requestIdleCallback` is made synchronous so the loader's idle
 * branches (the FC ensure AND the ad fallback) resolve within the test instead
 * of after it.
 */
function runStaticLoader(): void {
  (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
  // eslint-disable-next-line no-new-func
  new Function(ADSENSE_LOADER_CONTENT)();
  // Also exercise the interaction path, which the loader wires on `observe()`.
  document.dispatchEvent(new Event('scroll'));
}

const INDEX_HTML_SOURCE = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

/**
 * Extracts the JS body of index.html's Funding Choices loader `<script>` block
 * — the one containing `function loadFc()` — same extraction strategy as
 * tests/index-html-fc-loader.test.ts, reused here to actually EXECUTE it
 * rather than just pattern-match its source.
 */
function indexHtmlFcLoaderJs(): string {
  const fnStart = INDEX_HTML_SOURCE.indexOf('function loadFc()');
  const scriptStart = INDEX_HTML_SOURCE.lastIndexOf('<script>', fnStart);
  const scriptEnd = INDEX_HTML_SOURCE.indexOf('</script>', fnStart);
  return INDEX_HTML_SOURCE.slice(scriptStart + '<script>'.length, scriptEnd);
}

/**
 * NOT covered here on purpose: OFFERWALL_FC_SNIPPET.
 *
 * It looks like the natural twin of the index.html loader below, and a consent
 * gate was briefly added to it. It has to stay out, because
 * `offerwallFcSnippet` is a SCALAR FIELD OF `SiteShellContract` — the cross-repo
 * contract whose other half lives in nanakokyobashi-rgb/frontaliere-articles
 * under `host/`. Editing that string changes the digest asserted by
 * tests/articles-shell-contract-fingerprint.test.ts on BOTH repos, so it can
 * only move as a coordinated pair of PRs. That guard is the only thing covering
 * a contract with no import form; the last time the two halves diverged the
 * result was `TypeError: <member> is not a function` at render time with CI
 * green on both sides.
 *
 * Since the CMP-single-surface rework this is no longer even a gap: the FC
 * loader is meant to run unconditionally EVERYWHERE (it is the consent
 * surface), which is exactly what the untouched snippet does. The bridge the
 * snippet lacks arrives on the same static pages via adsense-loader.js
 * (ADSENSE_LOADER_CONTENT embeds FC_CONSENT_BRIDGE_JS), so article pages both
 * render the CMP and record its outcome, with zero contract churn.
 */
function runIndexHtmlFcLoader(): void {
  (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
  // eslint-disable-next-line no-new-func
  new Function(indexHtmlFcLoaderJs())();
}

// ── CMP simulation helpers ──────────────────────────────────────────────
//
// The bridge registers `{ CONSENT_DATA_READY }` on googlefc.callbackQueue and
// then reads TCF state via `__tcfapi('addEventListener')`. Funding Choices
// itself never runs in jsdom, so tests drain the queue by hand after
// installing a scripted `__tcfapi` — the same call order FC produces.

type TcData = {
  eventStatus?: string;
  gdprApplies?: boolean;
  purpose?: { consents?: Record<number, boolean> };
};

function installTcfapi(tcData: TcData, ok = true): void {
  (window as unknown as { __tcfapi: unknown }).__tcfapi = (
    cmd: string,
    _ver: number,
    cb: (d: TcData, success: boolean) => void,
  ) => {
    if (cmd === 'addEventListener') cb(tcData, ok);
  };
}

function drainFcCallbackQueue(): void {
  const q = (window as unknown as { googlefc?: { callbackQueue?: unknown[] } }).googlefc?.callbackQueue ?? [];
  for (const item of q) {
    const entry = item as { CONSENT_DATA_READY?: () => void };
    if (typeof entry?.CONSENT_DATA_READY === 'function') entry.CONSENT_DATA_READY();
  }
}

/** Registers the bridge alone (without the rest of the static loader). */
function runBridge(): void {
  // eslint-disable-next-line no-new-func
  new Function(FC_CONSENT_BRIDGE_JS)();
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'userAgent', { value: REAL_UA, configurable: true });
  localStorage.clear();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = '';
  // The bridge is idempotent per-window; tests need a fresh registration each.
  const w = window as unknown as { __ftFcConsentBridge?: number; googlefc?: unknown; __tcfapi?: unknown };
  delete w.__ftFcConsentBridge;
  delete w.googlefc;
  delete w.__tcfapi;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ads-consent gate — no ad-serving script before consent', () => {
  it('static page loader serves NO ads when no decision has been made — but DOES load the CMP that collects it', () => {
    runStaticLoader();
    expect(injectedAdServingScripts()).toEqual([]);
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();
    // The consent surface itself must be present, or no visitor could ever
    // consent on a static landing — the #5894 deadlock this rework removes.
    expect(document.querySelector(FC_SELECTOR)).not.toBeNull();
  });

  it('static page loader serves NO ads when consent is explicitly denied', () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    runStaticLoader();
    expect(injectedAdServingScripts()).toEqual([]);
  });

  it('static page loader serves NO ads for a corrupted/unknown stored value', () => {
    // Fails closed: anything that is not the literal 'granted' blocks.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'true');
    runStaticLoader();
    expect(injectedAdServingScripts()).toEqual([]);
  });

  it('serves NO ads when reading the consent key throws (fails closed)', async () => {
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
      expect(injectedAdServingScripts()).toEqual([]);

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
    expect(injectedAdServingScripts()).toEqual([]);
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
    expect(injectedAdServingScripts()).toEqual([]);
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

  it('index.html Funding Choices (CMP) loader DOES inject with no decision — it IS the consent surface', () => {
    // Inverted from the #5894 behaviour on purpose. The blocking Google
    // consent message is how a visitor grants (or refuses) ad consent at all;
    // a CMP gated behind its own output can never collect anything, which is
    // the deadlock that turned every undecided visitor into a permanent
    // no-ads session and stacked a second prompt on top of the CMP for
    // everyone else.
    runIndexHtmlFcLoader();
    expect(document.querySelector(FC_SELECTOR)).not.toBeNull();
    // Still no ad-serving script: the CMP collects, it does not serve.
    expect(injectedAdServingScripts()).toEqual([]);
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

  it('static page loader arms the ad path SAME-TAB when the CMP grants after page load', () => {
    // The highest-value moment on a cold SEO landing: the visitor answers the
    // CMP popup seconds after arrival. The loader must not require a reload —
    // it waits on the gate's CustomEvent and starts serving immediately.
    runStaticLoader();
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();

    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    window.dispatchEvent(new CustomEvent(ADS_CONSENT_CHANGE_EVENT, { detail: ADS_CONSENT_GRANTED }));

    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });
});

describe('ads-consent gate — CMP → gate bridge', () => {
  it('index.html carries a byte-identical copy of FC_CONSENT_BRIDGE_JS in an EXECUTABLE script tag', () => {
    // index.html cannot import build-plugins/constants.ts, so the bridge is
    // duplicated inline. This containment check is what keeps the two copies
    // from drifting on key, values, event name or decision logic — and the
    // surrounding bare `<script>` tags prove it is executable markup, not a
    // stray copy inside a comment or a `type="text/plain"` inert block.
    expect(INDEX_HTML_SOURCE).toContain(`<script>${FC_CONSENT_BRIDGE_JS}</script>`);
  });

  it('a TCF grant (purpose 1 consented) opens the gate and an already-mounted slot loads — no reload', async () => {
    const { default: AdSenseBanner } = await import('@/components/shared/AdSenseBanner');
    render(<AdSenseBanner adSlot="1234567890" adFormat="auto" />);
    expect(document.querySelector(ADSENSE_SELECTOR)).toBeNull();

    runBridge();
    installTcfapi({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true } } });
    await act(async () => {
      drainFcCallbackQueue();
    });

    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
    // The slot re-armed in the same page view — this is what protects fill rate
    // for visitors who accept (no reload required).
    expect(document.querySelector(ADSENSE_SELECTOR)).not.toBeNull();
  });

  it('a TCF refusal (purpose 1 withheld on useractioncomplete) records denied and serves nothing', () => {
    runBridge();
    installTcfapi({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: false } } });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
    expect(injectedAdServingScripts()).toEqual([]);
  });

  it('gdprApplies === false (no framework in the visitor\'s jurisdiction) grants', () => {
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded', gdprApplies: false });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
  });

  it('writes NOTHING while the CMP UI is still open (cmpuishown) — the gate stays fail-closed', () => {
    runBridge();
    installTcfapi({ eventStatus: 'cmpuishown', gdprApplies: true });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBeNull();
  });

  it('writes NOTHING when the TCF call reports failure', () => {
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded', gdprApplies: false }, false);
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBeNull();
  });

  it('grants when FC reports consent data ready but installed NO TCF API (non-TCF audience)', () => {
    // Funding Choices only instantiates `__tcfapi` where a TCF message is
    // targeted. For everyone else (non-EEA regions, US opt-out regimes)
    // CONSENT_DATA_READY still fires, no framework applies, and the gate must
    // open — a bare `return` here silently zeroed ad revenue for the whole
    // non-TCF audience, with no surface left to ever ask them anything.
    runBridge();
    drainFcCallbackQueue(); // no installTcfapi: window.__tcfapi is undefined
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
  });

  it('writes NOTHING on tcloaded with UNDETERMINED gdprApplies and no purposes', () => {
    // TCF `gdprApplies` is tri-state. `undefined` means the CMP has not
    // decided yet; fabricating a permanent `denied` out of that state was a
    // review round-1 bug. The gate simply stays as it was (fail-closed).
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded' });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBeNull();
  });

  it('a bare tcloaded without purpose 1 fabricates NO refusal (gate stays null)…', () => {
    // A refusal is only recorded when the visitor actually answered
    // (`useractioncomplete`) — an unanswered or freshly-loaded state must not
    // masquerade as one, or the communications panel would take the slot while
    // the CMP dialog is still on screen and the privacy page would show
    // "denied" for a question never asked. Null blocks ads all the same.
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: { 1: false } } });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBeNull();
  });

  it('…but tcloaded refuting a locally-stored grant corrects it to denied', () => {
    // The one tcloaded case that must write: local gate says granted, the TC
    // string says purpose 1 was withdrawn (revocation recorded elsewhere, or a
    // stale local grant). The CMP is the source of truth — the grant falls.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: { 1: false } } });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
  });

  it('a NON-interactive grant path respects a locally-stored denied (privacy-page revocation persists)', () => {
    // The privacy page is the only writer of a `denied` outside the CMP. For
    // a non-TCF visitor (Swiss audience: no message targeted, `__tcfapi`
    // never installed) no CMP prompt will ever re-ask — an unconditional
    // grant on CONSENT_DATA_READY silently undid an explicit art. 7.3 GDPR /
    // art. 6 nLPD revocation on the very next pageview (review round 2).
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    runBridge();
    drainFcCallbackQueue(); // no __tcfapi installed
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
  });

  it('a stored TC string read back on tcloaded does not overturn a local denied either', () => {
    // Same rule inside TCF scope: purpose 1 replayed from storage is not a
    // fresh user action — the revocation stands until the visitor actually
    // re-answers the (re-opened) message.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    runBridge();
    installTcfapi({ eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: { 1: true } } });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
  });

  it('an ANSWERED message (useractioncomplete) may flip a local denied back to granted', () => {
    // The counterpart that keeps the rule from becoming a one-way ratchet:
    // the visitor re-opening the message from /privacy and consenting is a
    // fresh affirmative act, and the CMP outcome wins.
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    runBridge();
    installTcfapi({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true } } });
    drainFcCallbackQueue();
    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
  });
});

describe('ads-consent gate — storage contract', () => {
  it('the emitted static loader is built from the shared constants, not a re-typed literal', () => {
    // Guards the one drift this design can still suffer: the SPA and the static
    // shells disagreeing about which key/value means consent.
    expect(ADSENSE_LOADER_CONTENT).toContain(ADS_CONSENT_STORAGE_KEY);
    expect(ADSENSE_LOADER_CONTENT).toContain(`==='${ADS_CONSENT_GRANTED}'`);
    expect(ADSENSE_LOADER_CONTENT).toContain(ADS_CONSENT_CHANGE_EVENT);
    // And the bridge ships inside the static loader, so every static page both
    // renders the CMP and records its outcome.
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_CONSENT_BRIDGE_JS);
  });

  it('the FC loader protocol ships as ONE shared string, with the CORS-regression pins on it', () => {
    // FC `/i/pub-XXX` serves no ACAO header: a `crossOrigin` attribute kills
    // the CMP and with it the whole TCF string (2026-05-04 regression, pinned
    // for index.html's copy in tests/index-html-fc-loader.test.ts). The static
    // loader's copy must carry the same invariants — asserted on FC_ENSURE_JS,
    // which ADSENSE_LOADER_CONTENT interpolates rather than re-typing.
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_ENSURE_JS);
    expect(FC_ENSURE_JS).toContain('fundingchoicesmessages.google.com/i/pub-8628054934855353?ers=1');
    expect(FC_ENSURE_JS).toContain('data-fc-loader');
    expect(FC_ENSURE_JS).toContain('googlefcPresent');
    expect(FC_ENSURE_JS).not.toMatch(/crossOrigin/i);
  });

  it('pre-consent interaction cannot load ads — the ad path is only reachable through the gate', () => {
    // The old single-check-at-the-top shape is gone (the loader now has
    // legitimate pre-consent work: the bridge and the CMP ensure), so this is
    // asserted behaviourally: every interaction trigger the loader wires fires
    // here, and still nothing ad-serving may load without the gate open.
    runStaticLoader(); // already dispatches 'scroll'
    for (const ev of ['touchstart', 'pointerdown', 'keydown', 'mousemove']) {
      document.dispatchEvent(new Event(ev));
    }
    expect(injectedAdServingScripts()).toEqual([]);
  });

  it('does NOT gate analytics — PostHog/GA4/Clarity stay outside this decision', () => {
    // Owner decision in #5842: the gate is advertising-only. If someone later
    // widens it to analytics, this fails and forces the conversation.
    expect(ADSENSE_LOADER_CONTENT).not.toContain('posthog');
    expect(ADSENSE_LOADER_CONTENT).not.toContain('clarity');
  });
});
