/**
 * GptAdSlot — generic Google Publisher Tag (GPT) display slot.
 *
 * Serves a GAM ad unit (via securepubads.g.doubleclick.net/tag/js/gpt.js) with
 * AdSense dynamic-allocation backfilling unsold impressions. GPT (pubads) is
 * independent of AdSense Auto Ads — this slot never touches adsbygoogle.js, so
 * Auto Ads (~95% of revenue) keep serving untouched. See issue #2273.
 *
 * This is the shared engine behind both the PoC below-content slot
 * ({@link GptPocSlot}) and the desktop article side-rail half-page units. The
 * GPT framework (script load + enableServices) initialises once per page; each
 * slot defines/displays into its own uniquely-id'd div, lazily via an
 * IntersectionObserver so it stays off the LCP critical path.
 *
 * SAFETY: `GPT_ENABLED` is the master flag for the whole GPT stack. Each slot
 * also takes a `killed` prop (wired to a Firebase Remote Config kill-switch by
 * the caller) so a regressing surface can be turned off within ~1 min with no
 * redeploy. Default-safe: renders `null` when inactive.
 */

import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { trackAdEvent } from '@/services/adAnalytics';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { isLikelyBot } from '@/services/adAnalytics';
import { prebidActiveFor, requestHeaderBids } from '@/services/headerBidding';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';
import { observeManualAd } from '@/services/manualAdLifecycle';
import { AD_FILL_TIMEOUT_MS, AD_SLOT_VIEWPORT_ROOT_MARGIN } from '@/services/adsenseSlots';

// Master flag for the GPT stack (PoC activated in #2289). Flip to `false`
// (one-line, then deploy) to disable every GPT slot if GPT serving regresses
// AdSense Auto Ads / RPM / CWV.
export const GPT_ENABLED = true;

const GPT_SCRIPT_SRC = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

const IS_PROD = typeof window !== 'undefined' && isAdSenseProductionHost(window.location.hostname);
const SKIP_FOR_BOT = typeof window !== 'undefined' && isLikelyBot();

/** A GPT slot size: a `[width, height]` pair or the responsive `'fluid'` token. */
export type GptSize = [number, number] | 'fluid';

let gptScriptRequested = false;
let gptServicesEnabled = false;
let slotSeq = 0;

// Minimal GPT access — @types/google-publisher-tag is not a dependency, so we
// reach googletag via an `any` view of window rather than a global type.
const gtag = (): any => {
  const w = window as any;
  // Ensure `cmd` exists even when `window.googletag` was already created by
  // another Google ad script WITHOUT a `cmd` queue — `|| { cmd: [] }` alone
  // returns that partial object as-is and `gt.cmd.push` then throws
  // "Cannot read properties of undefined (reading 'push')", so the slot never
  // defines/serves (observed live on article pages).
  const gt = (w.googletag = w.googletag || {});
  gt.cmd = gt.cmd || [];
  return gt;
};

/** Shared GPT access for out-of-page formats (for example rewarded ads). */
export const getGptTag = gtag;

function ensureGptScript(): void {
  // ── ADVERTISING CONSENT GATE (#5842) ────────────────────────────────
  // Placed BEFORE the `gptScriptRequested` latch on purpose: that latch is
  // sticky and module-scoped, so gating after it would mark the script as
  // "requested" on a blocked call and permanently lock out a visitor who
  // accepts later in the same page view. Fails closed — services/adsConsent.ts.
  if (!isAdsConsentGranted()) return;
  if (gptScriptRequested || typeof document === 'undefined') return;
  gptScriptRequested = true;
  gtag();
  if (document.querySelector(`script[src="${GPT_SCRIPT_SRC}"]`)) return;
  const s = document.createElement('script');
  s.src = GPT_SCRIPT_SRC;
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.addEventListener('error', () => { s.dataset.gptLoadFailed = 'true'; });
  document.head.appendChild(s);
}

/** Initialise the GPT framework once (post-load idle, not on scroll): the GAM
 *  Offerwall evaluates at page entry, so GPT must be present then. The ad slots
 *  themselves stay lazy to protect CWV. */
export function initGptFramework(): void {
  if (typeof window === 'undefined' || !GPT_ENABLED || !IS_PROD || SKIP_FOR_BOT) return;
  ensureGptScript();
  const gt = gtag();
  gt.cmd.push(() => {
    try {
      if (gptServicesEnabled || gt.__frontaliereGptServicesEnabled) return;
      // Modern GPT config API (pubads().enableSingleRequest()/collapseEmptyDivs() are deprecated).
      gt.setConfig({ singleRequest: true, collapseDiv: 'BEFORE_FETCH' });
      gt.enableServices();
      gt.__frontaliereGptServicesEnabled = true;
      gptServicesEnabled = true;
    } catch {
      /* fail-soft */
    }
  });
}

export interface GptAdSlotProps {
  /** Full GAM ad unit path, e.g. `/23355151813/article-rail-left`. */
  adUnitPath: string;
  /** Sizes to request; must match what the GAM ad unit allows. */
  sizes: GptSize[];
  /** Runtime kill-switch (caller wires it to Firebase Remote Config). */
  killed?: boolean;
  /**
   * Runtime kill-switch for the header-bidding auction ONLY (caller wires it to
   * Firebase Remote Config `KILL_HEADER_BIDDING`). When `true`, the slot still
   * serves via GPT/AdSense — only the Prebid pre-auction is skipped. Default `false`.
   */
  headerBiddingKilled?: boolean;
  /** Extra eligibility gate (e.g. article long enough). Default `true`. */
  enabled?: boolean;
  /** Reserved min-height (px) to prevent CLS before the creative fills. */
  minHeight?: number;
  /** Wrapper classes (positioning / sizing). */
  className?: string;
  /** Inline wrapper style merged after the CLS-reserve defaults. */
  style?: CSSProperties;
  /**
   * Called when the reserve can safely collapse after terminal no-fill/error
   * offscreen (`true`), or the slot needs its reserve (`false`). Parent gutters
   * must follow the same lifecycle to avoid shifting visible page content.
   */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Whether to collapse the wrapper to `display:none` when GPT reports the slot
   * empty and the wrapper leaves the viewport. Default `true` (rails / below-content slots: an unfilled slot should
   * vanish so it leaves no blank box). Set `false` for an ABOVE-THE-FOLD slot
   * (e.g. the desktop top banner) where collapsing would yank the content below
   * upward and register a Cumulative Layout Shift: there we keep the reserved
   * `minHeight` so the slot's footprint never changes (CLS-safe), at the cost of
   * a thin reserved band when no creative fills.
   */
  collapseOnEmpty?: boolean;
}

const GptAdSlot: React.FC<GptAdSlotProps> = ({
  adUnitPath,
  sizes,
  killed = false,
  headerBiddingKilled = false,
  enabled = true,
  minHeight = 250,
  className = 'mx-auto my-6 w-full max-w-[336px] text-center',
  style,
  onEmptyChange,
  collapseOnEmpty = true,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // GPT slot + its slotRenderEnded handler, kept so unmount can tear both down
  // (remove the global pubads listener and destroy the slot).
  const slotRef = useRef<any>(null);
  const slotHandlerRef = useRef<((event: any) => void) | null>(null);
  const viewableHandlerRef = useRef<((event: any) => void) | null>(null);
  // Stable, unique DOM id for this slot instance (GPT needs a real element id).
  const divIdRef = useRef<string>(`gpt-slot-${++slotSeq}`);
  const [rendered, setRendered] = useState(false);
  const [adState, setAdState] = useState('loading');
  const [collapsed, setCollapsed] = useState(false);
  // Kept in a ref so the once-bound slotRenderEnded handler always calls the
  // latest callback without re-running the define/display effect.
  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;
  const active = GPT_ENABLED && enabled && IS_PROD && !SKIP_FOR_BOT && !killed;
  // Re-arms the define/display effect when the visitor answers the ads-consent
  // banner (#5842), so accepting fills the rail in the same page view.
  const [adsConsentTick, setAdsConsentTick] = useState(0);
  useEffect(() => onAdsConsentChange(() => setAdsConsentTick((t) => t + 1)), []);

  useEffect(() => {
    if (!active || !isAdsConsentGranted()) return;
    const divId = divIdRef.current;

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    const ric: (cb: () => void) => void = typeof idleWindow.requestIdleCallback === 'function'
      ? (cb) => { idleWindow.requestIdleCallback?.(cb, { timeout: 3000 }); }
      : (cb) => window.setTimeout(cb, 1200);
    ric(initGptFramework);

    const wrapper = wrapperRef.current;
    const adElement = document.getElementById(divId);
    if (!wrapper || !adElement || typeof IntersectionObserver === 'undefined') return;
    let disposed = false;
    adElement.removeAttribute('data-ad-status');
    setCollapsed(false);
    onEmptyChangeRef.current?.(false);
    const lifecycle = observeManualAd(adElement, wrapper, AD_FILL_TIMEOUT_MS, (state) => {
      setAdState(state);
      if (state === 'filled') {
        setCollapsed(false);
        onEmptyChangeRef.current?.(false);
      } else if (state === 'collapsed' && collapseOnEmpty) {
        setCollapsed(true);
        // The rail gutter owns a second reserve. Only release it at the same
        // offscreen point, never on a timeout or a visible no-fill response.
        onEmptyChangeRef.current?.(true);
      }
    }, (event, metrics) => {
      // GPT's own Active View event remains authoritative for GAM viewability.
      if (event === 'ad_viewable' || (event === 'ad_collapsed' && !collapseOnEmpty)) return;
      trackAdEvent(event, { slot: adUnitPath, format: 'gpt', network: 'gpt', ...metrics });
    });
    const onScriptError = (event: Event) => {
      if (event.target instanceof HTMLScriptElement && event.target.src === GPT_SCRIPT_SRC) lifecycle.fail('gpt_script_error');
    };
    window.addEventListener('error', onScriptError, true);
    let defined = false;
    const defineAndDisplay = () => {
      if (defined) return;
      defined = true;
      // Start outside gt.cmd: a blocked/slow script may never drain its queue.
      // The shared deadline means waiting_response; it is not a no-fill.
      lifecycle.request();
      if (document.querySelector<HTMLScriptElement>(`script[src="${GPT_SCRIPT_SRC}"]`)?.dataset.gptLoadFailed === 'true') {
        lifecycle.fail('gpt_script_error');
      }
      // Queue the GPT framework (enableServices) BEFORE this slot's display().
      // An above-the-fold slot (e.g. the article side-rails on ≥1400px) has its
      // IntersectionObserver fire on mount — before the idle-deferred
      // initGptFramework() above runs — so without this its display() would be
      // queued ahead of enableServices() and pubads would never fetch: the slot
      // stays empty with zero gampad/ads requests (observed live). initGptFramework
      // is idempotent (guarded), so slots that intersect after the idle init are
      // unaffected; this only repairs the early-intersect race. It also calls
      // ensureGptScript() internally, so the script is still requested here.
      initGptFramework();
      const gt = gtag();
      gt.cmd.push(() => {
        if (disposed) return;
        try {
          const slot = gt.defineSlot(adUnitPath, sizes, divId)?.addService(gt.pubads());
          if (!slot) return;
          slotRef.current = slot;
          // Keep the listener after a no-fill: late creatives restore both
          // reserves. The shared controller waits until offscreen to collapse.
          const handler = (event: any) => {
            if (disposed || event?.slot !== slot) return;
            adElement.setAttribute('data-ad-status', event.isEmpty ? 'unfilled' : 'filled');
          };
          slotHandlerRef.current = handler;
          gt.pubads().addEventListener('slotRenderEnded', handler);
          // Viewability is the real RPM driver (AdSense ACTIVE_VIEW_VIEWABILITY
          // fell ~0.46→0.33 while fill stayed stable). Emit ad_viewable per slot
          // so the SPA can track per-page viewability of the rail units.
          const viewableHandler = (event: any) => {
            if (event?.slot !== slot) return;
            trackAdEvent('ad_viewable', { slot: adUnitPath, format: 'gpt', network: 'gpt' });
          };
          viewableHandlerRef.current = viewableHandler;
          gt.pubads().addEventListener('impressionViewable', viewableHandler);
          // Header bidding: run a Prebid auction for this slot and apply the
          // winning hb_* targeting BEFORE display(), so SSP demand competes with
          // AdSense dynamic-allocation inside the same GAM auction. AdSense Auto
          // Ads are unaffected. requestHeaderBids() is a no-op when disabled /
          // unconfigured and always resolves (fail-soft + hard timeout), so GPT
          // display is never blocked by the auction.
          if (!headerBiddingKilled && prebidActiveFor(adUnitPath)) {
            void requestHeaderBids({ code: divId, adUnitPath, sizes }).finally(() => {
              gt.cmd.push(() => {
                if (disposed) return;
                try {
                  gt.display(divId);
                } catch {
                  /* fail-soft */
                }
              });
            });
          } else {
            gt.display(divId);
          }
          setRendered(true);
        } catch {
          /* fail-soft: never let an ad break the page */
        }
      });
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            io.disconnect();
            defineAndDisplay();
            return;
          }
        }
      },
      // Third and last copy of this margin in the codebase — now the shared
      // constant, like the AdSense banner and the static-shell loader. GPT and
      // AdSense are different ad systems but this is one policy ("how close to
      // the viewport before an ad may be requested"), and the value had been
      // duplicated as a literal in all three (AGENTS.md Non-Negotiable #6).
      // This path was already correct: it has always deferred defineAndDisplay()
      // to the observer, which is why the GAM rails never had the viewability
      // problem the AdSense in-feed units had.
      { rootMargin: AD_SLOT_VIEWPORT_ROOT_MARGIN },
    );
    io.observe(wrapper);
    return () => {
      disposed = true;
      io.disconnect();
      lifecycle.stop();
      window.removeEventListener('error', onScriptError, true);
      // Tear down the slot + its listener so SPA navigations don't accumulate
      // global pubads listeners (each would re-fire for every other slot).
      try {
        const gt = gtag();
        if (slotHandlerRef.current) {
          gt.pubads().removeEventListener('slotRenderEnded', slotHandlerRef.current);
          slotHandlerRef.current = null;
        }
        if (viewableHandlerRef.current) {
          gt.pubads().removeEventListener('impressionViewable', viewableHandlerRef.current);
          viewableHandlerRef.current = null;
        }
        if (slotRef.current) {
          gt.destroySlots?.([slotRef.current]);
          slotRef.current = null;
        }
      } catch {
        /* fail-soft */
      }
    };
  }, [active, adUnitPath, sizes, adsConsentTick, collapseOnEmpty]);

  if (!active) return null;

  return (
    <div
      ref={wrapperRef}
      aria-hidden={!rendered || adState !== 'filled'}
      data-ad-state={adState}
      // Only an explicit terminal response may release the reserve offscreen.
      style={collapsed ? { display: 'none' } : { minHeight, contain: 'layout', ...style }}
      className={className}
    >
      <div id={divIdRef.current} />
    </div>
  );
};

export default GptAdSlot;
