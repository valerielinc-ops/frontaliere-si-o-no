/**
 * `ad_page_diag` — one GA4 event per page view that says why the ads on that
 * page earned what they earned: which ad path ran, whether adsbygoogle.js and
 * Funding Choices loaded, how many manual slots filled, what the Auto Ads
 * anchor and vignette did, and when the first manual slot filled.
 *
 * Why: the AdSense reports give revenue and CPM per page, not the reason. On a
 * day the mobile job-board value drops, "fewer anchors per page" and "lower
 * CPM" look the same from the AdSense side; this event makes them separable
 * per page template × deviceCategory (GA4 already has deviceCategory).
 *
 * Two runtimes, one contract:
 *  - this module, started by the SPA on mount and on every route change
 *    (hooks/useAdPageDiag.ts);
 *  - its ES5 twin `AD_PAGE_DIAG_FN` (build-plugins/shared/adPageDiagInline.ts),
 *    run by the static AdSense loader (ADSENSE_LOADER_CONTENT) on the static
 *    pages, where most job-board page views never mount the SPA.
 * Both register the pending page view on `window.__ftAdDiag`: whoever starts
 * first owns that path, the other steps aside, and a route change flushes the
 * previous page view before starting the next. tests/ad-page-diag-parity.test.ts
 * runs both collectors on the same DOM and requires identical parameters.
 *
 * Timing: sent once, `AD_PAGE_DIAG_DELAY_MS` after the page view started, or
 * earlier on the first `visibilitychange` → hidden / `pagehide` / SPA route
 * change (then `diag_hidden = 1`: the snapshot is truncated). Transport beacon.
 *
 * Fails open: every step is wrapped, nothing here can delay, gate or break an
 * ad request (AGENTS.md Non-Negotiable #7). It reads the DOM and storage only.
 * No personal data: counts, flags and fixed enums, plus the page template.
 *
 * Bots: the bot gate suppresses the ad path, not GA4 (page_view is sent for
 * them too), so a bot page view is reported once with `ad_path = bot_gated`.
 * That share is the check against the gate misclassifying real mobile readers.
 */
import {
  ADS_CONSENT_DENIED,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_STORAGE_KEY,
  onAdsConsentChange,
} from './adsConsent';
import { classifyAdPageTemplate, documentHasJobPosting, type AdPageTemplate } from './adPageTemplate';
import { AD_BANNER_STATE_ATTR } from './adsenseSlots';
import { isManualSlot } from './adSlotKinds';
import { isLikelyBot } from './botPatterns';
import { READER_NOADS_ACTIVE_KEY } from './readerEntitlement';

export const AD_PAGE_DIAG_EVENT = 'ad_page_diag';
export const AD_PAGE_DIAG_DELAY_MS = 25_000;
/** Funding Choices' body-level consent message root. */
export const FC_CONSENT_ROOT_SELECTOR = '.fc-consent-root';

export type AdPathReason = 'loaded' | 'bot_gated' | 'noads_entitlement' | 'waiting_consent';
export type AdDiagConsentState = 'granted' | 'denied' | 'none';
export type AdDiagGateStatus = 'held' | 'released' | 'suppressed' | 'off_board' | 'absent';

export interface AdPageDiagParams {
  page_template: AdPageTemplate;
  consent_state: AdDiagConsentState;
  ad_path: AdPathReason;
  adsbygoogle_loaded: 0 | 1;
  fc_loaded: 0 | 1;
  gate_status: AdDiagGateStatus;
  slots_total: number;
  slots_filled: number;
  slots_unfilled: number;
  slots_collapsed: number;
  anchor_status: string;
  vignette_ready: 0 | 1;
  auto_placed: number;
  first_fill_ms: number;
  cmp_shown: 0 | 1;
  ad_blocked: 0 | 1;
  diag_hidden: 0 | 1;
}

/** What a pending page view exposes on `window.__ftAdDiag` (shared with the inline twin). */
export interface AdPageDiagHandle {
  path: string;
  done: boolean;
  collect: (hidden: 0 | 1) => AdPageDiagParams;
  flush: (hidden: 0 | 1) => void;
}

type DiagWindow = Window & {
  adsbygoogle?: { loaded?: boolean; push?: unknown };
  googlefc?: { getAdBlockerStatus?: unknown; showRevocationMessage?: unknown };
  __tcfapi?: unknown;
  __ftOfferwallGate?: { state?: string; release?: unknown };
  __ftAdBlock?: { blocked?: boolean };
  __ftAdDiag?: AdPageDiagHandle;
  gtag?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
};

interface CollectState {
  path: string;
  firstFill: number;
  cmp: 0 | 1;
}

function readStorage(win: DiagWindow, key: string): string | null {
  try {
    return win.localStorage.getItem(key);
  } catch {
    return null;
  }
}


/** True when a manual slot already carries a creative (`data-ad-status=filled`). */
function hasFilledManualSlot(doc: Document): boolean {
  const filled = doc.querySelectorAll('ins.adsbygoogle[data-ad-status="filled"]');
  for (let i = 0; i < filled.length; i++) {
    if (isManualSlot(filled[i])) return true;
  }
  return false;
}

/** Snapshot of the page's ad state. Pure read; the inline twin must return the same. */
export function collectAdPageDiag(
  win: DiagWindow,
  state: CollectState,
  hidden: 0 | 1,
  isBot: () => boolean = isLikelyBot,
): AdPageDiagParams {
  const doc = win.document;
  const stored = readStorage(win, ADS_CONSENT_STORAGE_KEY);
  const consent: AdDiagConsentState =
    stored === ADS_CONSENT_GRANTED ? 'granted' : stored === ADS_CONSENT_DENIED ? 'denied' : 'none';
  // Same precedence as the loader and <AdSenseBanner>: entitlement, bot gate, consent.
  const adPath: AdPathReason =
    readStorage(win, READER_NOADS_ACTIVE_KEY) === 'true'
      ? 'noads_entitlement'
      : isBot()
        ? 'bot_gated'
        : consent === 'none'
          ? 'waiting_consent'
          : 'loaded';

  const ads = win.adsbygoogle;
  const adsLoaded = !!ads && (ads.loaded === true || (typeof ads.push === 'function' && ads.push !== Array.prototype.push));
  const fc = win.googlefc;
  const fcLoaded =
    (!!fc && (typeof fc.getAdBlockerStatus === 'function' || typeof fc.showRevocationMessage === 'function')) ||
    typeof win.__tcfapi === 'function';
  const gate = win.__ftOfferwallGate;
  const gateState = gate ? gate.state : undefined;
  const gateStatus: AdDiagGateStatus =
    (gateState === 'held' && typeof gate?.release === 'function') ||
    gateState === 'released' ||
    gateState === 'suppressed' ||
    gateState === 'off_board'
      ? (gateState as AdDiagGateStatus)
      : 'absent';

  let total = 0;
  let filled = 0;
  let unfilled = 0;
  let collapsed = 0;
  const slots = doc.querySelectorAll('ins.adsbygoogle');
  for (let i = 0; i < slots.length; i++) {
    const el = slots[i];
    if (!isManualSlot(el)) continue;
    total++;
    const status = el.getAttribute('data-ad-status');
    if (status === 'filled') filled++;
    else if (status === 'unfilled') unfilled++;
    if (el.hasAttribute('data-ft-static-ad-collapsed') || el.closest(`[${AD_BANNER_STATE_ATTR}="collapsed"]`)) collapsed++;
  }

  const anchor = doc.querySelector('ins[data-anchor-status]');
  const anchorStatus = anchor
    ? String(anchor.getAttribute('data-anchor-status') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'none'
    : 'none';
  const cmp: 0 | 1 = state.cmp || doc.querySelector(FC_CONSENT_ROOT_SELECTOR) ? 1 : 0;

  return {
    page_template: classifyAdPageTemplate(state.path, documentHasJobPosting(doc)),
    consent_state: consent,
    ad_path: adPath,
    adsbygoogle_loaded: adsLoaded ? 1 : 0,
    fc_loaded: fcLoaded ? 1 : 0,
    gate_status: gateStatus,
    slots_total: total,
    slots_filled: filled,
    slots_unfilled: unfilled,
    slots_collapsed: collapsed,
    anchor_status: anchorStatus,
    vignette_ready: doc.querySelector('ins[data-vignette-loaded="true"]') ? 1 : 0,
    auto_placed: doc.querySelectorAll('.google-auto-placed').length,
    first_fill_ms: state.firstFill,
    cmp_shown: cmp,
    ad_blocked: win.__ftAdBlock && win.__ftAdBlock.blocked === true ? 1 : 0,
    diag_hidden: hidden,
  };
}

/**
 * Same channel as trackAdEvent (services/adAnalytics.ts): the page's gtag.
 * `page_location` pins the event to the page view it describes: a snapshot
 * flushed by an SPA navigation is sent after `pushState`, when gtag's default
 * location is already the next page. Origin + pathname only, never the query
 * (it can carry a one-shot autologin token the app strips later).
 */
function sendToGa4(win: DiagWindow, path: string, params: AdPageDiagParams): void {
  const payload = { ...params, page_location: `${win.location.origin}${path}`, transport_type: 'beacon' };
  if (typeof win.gtag === 'function') {
    win.gtag('event', AD_PAGE_DIAG_EVENT, payload);
    return;
  }
  // gtag.js not bootstrapped yet: queue the command the way gtag() itself does.
  const queue = (win.dataLayer = win.dataLayer || []);
  (function gtagShim(..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    queue.push(arguments);
  })('event', AD_PAGE_DIAG_EVENT, payload);
}

function now(win: DiagWindow): number {
  try {
    return win.performance.now();
  } catch {
    return 0;
  }
}

export interface StartAdPageDiagOptions {
  win?: DiagWindow;
  isBot?: () => boolean;
  delayMs?: number;
}

/**
 * Start the diagnosis for the page view at `pathname`. Idempotent per path:
 * a second call for the path already pending (or already sent) is a no-op,
 * and a call for a new path first flushes the previous page view.
 */
export function startAdPageDiag(pathname?: string, options: StartAdPageDiagOptions = {}): void {
  try {
    const win = options.win ?? (window as DiagWindow);
    const doc = win.document;
    const path = String(pathname ?? win.location.pathname);
    const current = win.__ftAdDiag;
    if (current && current.path === path) return;
    if (current && !current.done) {
      try {
        current.flush(1);
      } catch {
        /* the previous page view's snapshot is lost, not this one */
      }
    }

    const isBot = options.isBot ?? isLikelyBot;
    // The first page view counts from navigation start, a route change from now.
    const t0 = current ? now(win) : 0;
    const state: CollectState = { path, firstFill: -1, cmp: 0 };
    const cleanups: Array<() => void> = [];

    const noteCmp = () => {
      if (doc.querySelector(FC_CONSENT_ROOT_SELECTOR)) state.cmp = 1;
    };
    noteCmp();
    // A slot already filled when this page view starts (the SPA taking over a
    // static page, a loader that ran late) has no mutation left to observe:
    // date it to now, the closest time available.
    if (hasFilledManualSlot(doc)) state.firstFill = Math.max(0, Math.round(now(win) - t0));

    if (typeof MutationObserver !== 'undefined') {
      if (state.firstFill < 0) {
        const fillObserver = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target as Element;
            // Manual slots only, like slots_filled: an Auto ads anchor or
            // vignette filling first must not date the manual first fill.
            if (target.tagName === 'INS' && target.getAttribute('data-ad-status') === 'filled' && isManualSlot(target)) {
              state.firstFill = Math.max(0, Math.round(now(win) - t0));
              fillObserver.disconnect();
              return;
            }
          }
        });
        fillObserver.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-ad-status'] });
        cleanups.push(() => fillObserver.disconnect());
      }
      // Funding Choices appends its consent root directly to <body>; a root
      // that is still there at snapshot time is caught by collect() too.
      if (doc.body) {
        const cmpObserver = new MutationObserver(() => {
          noteCmp();
          if (state.cmp) cmpObserver.disconnect();
        });
        cmpObserver.observe(doc.body, { childList: true });
        cleanups.push(() => cmpObserver.disconnect());
      }
    }
    cleanups.push(onAdsConsentChange(() => {
      state.cmp = 1;
    }));

    const handle: AdPageDiagHandle = {
      path,
      done: false,
      collect: (hidden) => collectAdPageDiag(win, state, hidden, isBot),
      flush: (hidden) => {
        if (handle.done) return;
        handle.done = true;
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            /* keep going */
          }
        }
        try {
          sendToGa4(win, path, handle.collect(hidden));
        } catch {
          /* telemetry never breaks the page */
        }
      },
    };

    const timer = setTimeout(() => handle.flush(0), options.delayMs ?? AD_PAGE_DIAG_DELAY_MS);
    cleanups.push(() => clearTimeout(timer));
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') handle.flush(1);
    };
    const onPageHide = () => handle.flush(1);
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onPageHide);
    cleanups.push(() => {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
    });

    win.__ftAdDiag = handle;
  } catch {
    /* fail open */
  }
}
