/**
 * AdSenseBanner — Google AdSense display ad unit with width-aware lifecycle.
 *
 * Renders an <ins class="adsbygoogle"> element and pushes to the ad queue ONLY
 * after (a) the slot has come within 200px of the viewport, and (b) the
 * container satisfies the format width (In-article: at least 250px).
 *
 * (a) is the viewability contract: an impression served for a unit the visitor
 * never reaches is counted by Active View as non-viewable and drags the unit's
 * measured CPM down. Registry entries stay context-specific so placement
 * performance remains attributable instead of blending listing and detail data.
 *
 * State machine: idle → waiting_width → loading → waiting_response | filled | unfilled → collapsed
 * `idle` = in the DOM as a reserved box, but not yet requested.
 *
 * In development mode the component renders nothing (collapsed).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ReactAdsense } from './ReactAdsense';
import { createAdSlotRequests } from '@/services/adSlotRequest';
import { createAdScriptLoader } from '@/services/adScriptLoader';
import { emitAdDiagnostic } from '@/services/adDiagnostics';
import { isLikelyBot, trackAdEvent } from '@/services/adAnalytics';
import { classifyAdPageTemplate, documentHasJobPosting } from '@/services/adPageTemplate';
import { observeManualAd } from '@/services/manualAdLifecycle';
import { hasActiveReaderNoAdsEntitlement } from '@/services/readerEntitlement';
import { isAdSenseAllowed, onAdsConsentChange } from '@/services/adsConsent';
import { sanitizeTelemetryProperties } from '@/services/analyticsUrlPrivacy.js';
import { isSensitiveThirdPartyDocument } from '@/services/thirdPartyDocumentPrivacy.js';
import { wasNewsletterAutologinAttempted } from '@/services/newsletterAutologinSignal';
import {
 AD_BANNER_STATE_ATTR,
 AD_FILL_TIMEOUT_MS,
 AD_SLOT_VIEWPORT_ROOT_MARGIN,
 MULTIPLEX_DESKTOP_MIN_HEIGHT,
 MULTIPLEX_DESKTOP_MIN_WIDTH,
 resolveSlotPlaceholderMinHeight,
} from '@/services/adsenseSlots';

declare global {
 interface Window {
 adsbygoogle?: Array<Record<string, unknown>>;
 }
}

interface AdSenseBannerProps {
 placement?: string;
 experimentId?: string;
 experimentVariant?: string;
 adSlot?: string;
 adFormat?: string;
 fullWidthResponsive?: boolean;
 className?: string;
 adLayoutKey?: string;
 adLayout?: string;
 label?: string;
 enabled?: boolean;
 /** Per-slot placeholder height override. Overrides getPlaceholderMinHeight(adFormat).
 * Use when a specific slot renders taller than the format default (e.g. HOMEPAGE_MID_DISPLAY). */
 minHeight?: number;
 /** When true, always render the placeholder wrapper (even when disabled) to prevent CLS.
 * Use on pages where ads appear after an async action (e.g., calculator results). */
 reserveSpace?: boolean;
}

const CLIENT_ID = 'ca-pub-8628054934855353';
const ADSENSE_PRODUCTION_HOSTNAMES = new Set([
 'frontaliereticino.ch',
 'frontaliereticino.ch',
]);

export function isAdSenseProductionHost(hostname: string) {
 return ADSENSE_PRODUCTION_HOSTNAMES.has(hostname);
}

const IS_PROD =
 typeof window !== 'undefined' && isAdSenseProductionHost(window.location.hostname);

// Bot detection runs once per page load. The result is stable for the
// session, so cache it. isLikelyBot() returns true on Playwright/Selenium/
// scrapers/headless — these inflate AD_REQUESTS without monetizing
// (≤€0.10 RPM) and pollute coverage metrics.
const SKIP_FOR_BOT = typeof window !== 'undefined' && isLikelyBot();

type AdState = 'idle' | 'waiting_width' | 'loading' | 'waiting_response' | 'unfilled' | 'unavailable' | 'filled' | 'collapsed';


/**
 * Layout space reserved before the unit fills — the only CLS lever we have on
 * an ad whose real height Google decides at fill time (never gate/suppress the
 * unit itself, AGENTS.md §7).
 *
 * Resolution order:
 *   1. explicit `minHeight` prop (per-call-site override, wins over all),
 *   2. `AD_SLOTS[…].placeholderMinHeight` for this (slot, format, layout) —
 *      the registry is the declared source of truth and the SAME value the
 *      build-time emitter (`build-plugins/lib/adSlotHtml.ts`) reserves,
 *   3. the format heuristic below, for slots not in the registry.
 *
 * Step 2 used to be missing here: the component went straight to the format
 * heuristic, so a registry entry only took effect when a call site happened to
 * pass `minHeight` — 7 of 49 did. That silently reverted the #4302 CLS fix on
 * the SPA (JOBLIST_INFEED_* was raised 280 → 336 in the registry, but
 * `/cerca-lavoro-ticino/` kept reserving 280 live) and is the field-CLS
 * regression in issue #4677. See the resolver docblock in
 * `services/adsenseSlots.ts` for the full rationale.
 */
function getPlaceholderMinHeight(adFormat: string, adLayout?: string): number {
 // Fallback for slots that are NOT in AD_SLOTS. Registry slots resolve via
 // resolveSlotPlaceholderMinHeight and never reach this heuristic.
 if (adFormat === 'autorelaxed') {
   // Multiplex/autorelaxed renders ~380-450px on mobile but ~550-650px on
   // desktop (wider grid → more ad rows). A flat 400px under-reserves desktop
   // by ~200px, so the unit pushes content + footer down when it fills —
   // measured live on /cerca-lavoro-ticino/ricerca/ at 1440px (end multiplex
   // reserved 400px, rendered 600px → footer shift). Reserve per-viewport so
   // desktop matches the real render; SSR/build has no window → mobile floor.
   return (typeof window !== 'undefined' && window.innerWidth >= MULTIPLEX_DESKTOP_MIN_WIDTH)
     ? MULTIPLEX_DESKTOP_MIN_HEIGHT
     : 400;
 }
 if (adLayout === 'in-article') return 220;
 if (adFormat === 'fluid') return 220;
 return 280;
}

/** Full resolution chain (registry first, heuristic as fallback). Exported for
 *  the regression test that pins the registry↔runtime contract. */
export function resolvePlaceholderMinHeight(
 adSlot: string | undefined,
 adFormat: string,
 adLayout: string | undefined,
 viewportWidth: number | undefined,
): number {
 return (
   resolveSlotPlaceholderMinHeight(adSlot, adFormat, adLayout, viewportWidth) ??
   getPlaceholderMinHeight(adFormat, adLayout)
 );
}

export default function AdSenseBanner(props: AdSenseBannerProps) {
 // A new route/unit owns a fresh DOM node and request lifecycle.
 const route = typeof window !== 'undefined' ? window.location.pathname : '';
 return <AdSenseBannerInstance key={`${route}|${props.adSlot}|${props.adFormat}|${props.adLayout}|${props.adLayoutKey}`} {...props} />;
}

function AdSenseBannerInstance({
 placement,
 experimentId,
 experimentVariant,
 adSlot,
 adFormat = 'auto',
 fullWidthResponsive = true,
 className = '',
 adLayoutKey,
 adLayout,
 // Italian "Advertisement" disclosure label — required by Google Publisher
 // Policies and Italian consumer-transparency rules. Always rendered above
 // the ad slot once it fills (hidden via wrapper opacity while collapsed).
 // Pass an explicit empty string to opt out (not recommended).
 label = 'Pubblicità',
 enabled = true,
 minHeight,
 reserveSpace = false,
}: AdSenseBannerProps) {
 const adRef = useRef<HTMLModElement | null>(null);
 const registerAd = useCallback((element: HTMLModElement) => { adRef.current = element; }, []);
 const unsubscribeScript = useRef<(() => void) | null>(null);
 const wrapperRef = useRef<HTMLDivElement>(null);
 const pushed = useRef(false);
 const armed = useRef(false);
 const resizeObserverRef = useRef<ResizeObserver | null>(null);
 const lifecycleRef = useRef<ReturnType<typeof observeManualAd> | null>(null);
 const pagePath = useRef(typeof window !== 'undefined' ? window.location.pathname : '/');
 const pageTemplate = useRef(classifyAdPageTemplate(pagePath.current, typeof document !== 'undefined' && documentHasJobPosting(document)));
 const [state, setState] = useState<AdState>('idle');
 const [scriptReady, setScriptReady] = useState(false);
 const [scriptFailed, setScriptFailed] = useState(false);
 const readerNoAds = hasActiveReaderNoAdsEntitlement();
 // Bumped when the visitor answers the ads-consent banner (#5842). It is a dep
 // of the lazy-load effect below, so accepting re-arms the IntersectionObserver
 // and this slot fills in the same page view instead of only after a reload —
 // which is what protects the fill rate for visitors who accept.
 const [adsConsentTick, setAdsConsentTick] = useState(0);
 useEffect(() => onAdsConsentChange(() => setAdsConsentTick((t) => t + 1)), []);
 const placeholderMinHeight =
 minHeight ??
 resolvePlaceholderMinHeight(
 adSlot,
 adFormat,
 adLayout,
 typeof window !== 'undefined' ? window.innerWidth : undefined,
 );

 const cleanupAsyncWatchers = useCallback(() => {
 if (resizeObserverRef.current) {
 resizeObserverRef.current.disconnect();
 resizeObserverRef.current = null;
 }
 }, []);

 const ensureLifecycle = useCallback(() => {
 const el = adRef.current;
 const box = wrapperRef.current;
 if (!el || !box) return null;
 if (!lifecycleRef.current) lifecycleRef.current = observeManualAd(el, box, AD_FILL_TIMEOUT_MS,
   (next) => setState(next),
   (event, metrics) => trackAdEvent(event, {
     slot: adSlot || '', format: adFormat, page_path: pagePath.current, page_template: pageTemplate.current,
     placement: placement || adSlot || '', render_path: 'spa', ...metrics,
   }));
 return lifecycleRef.current;
 }, [adSlot, adFormat, placement]);

 const collapseWhenLayoutSafe = useCallback((reason: string) => {
 ensureLifecycle()?.fail(reason);
 }, [ensureLifecycle]);

 // ── Load the AdSense script (singleton) ──────────────────
 const loadAdSenseScript = useCallback(() => {
 if (typeof document === 'undefined') return;
 // Capture initial provenance even for a late chunk. Later SPA routes may
 // initialize only after URL/referrer and residual DOM URLs attest clean.
 if (isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, window, document, wasNewsletterAutologinAttempted())) return;
 // ── ADVERTISING CONSENT GATE (#5842) ──────────────────────
 // The single choke point for adsbygoogle.js in the SPA. Deliberately here and
 // not only in the effect below: this function is reached from four
 // independent paths (IntersectionObserver fill, already-present-script,
 // requestIdleCallback fallback, first-interaction listener), and a guard in
 // the effect would have to be repeated four times to be equivalent — one
 // missed path is a silent bypass. Also kept separate from the
 // `hasActiveReaderNoAdsEntitlement()` early return in that effect, which
 // never sees the idle/interaction callbacks that fire later.
 // Open once the visitor answered the CMP either way: without Purpose 1
 // consent Google serves Limited Ads (isAdSenseAllowed in services/adsConsent.ts).
 // Fails closed: any read failure means "no decision".
 // Analytics / PostHog / Clarity are NOT gated here — owner decision in #5842.
 if (!isAdSenseAllowed()) return;
 const loader = createAdScriptLoader('adsense', `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT_ID}`,
   () => isAdSenseAllowed() && !hasActiveReaderNoAdsEntitlement() &&
     !isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, window, document, wasNewsletterAutologinAttempted()), emitAdDiagnostic);
 if (!unsubscribeScript.current) unsubscribeScript.current = loader.subscribe((next) => {
   if (next === 'loaded') {
     if (!pushed.current) { lifecycleRef.current?.stop(); lifecycleRef.current = null; }
     setScriptReady(true);
     setScriptFailed(false);
     setState((prev) => !pushed.current && (prev === 'unavailable' || prev === 'collapsed') ? (armed.current ? 'waiting_width' : 'idle') : prev);
   } else if (next === 'failed') setScriptFailed(true);
 });
 loader.load();
 }, []);

 // ── Arm this slot via IntersectionObserver ────────────────
 // The observer governs TWO things, and the distinction is the whole point:
 //   • the SCRIPT load — also reachable from the idle fallback and the first
 //     interaction below, because Auto Ads (~95% of revenue) need
 //     adsbygoogle.js on the page whether or not any manual slot is in view.
 //     Never gate that (AGENTS.md Non-Negotiable #7).
 //   • this slot's PUSH — reachable from HERE ONLY. A slot the visitor has
 //     not come near must not spend an ad request, because the impression it
 //     buys is unviewable by construction.
 // Loading the script lazily also keeps the ~45KB third-party payload past LCP
 // and off pages whose ad never enters view (the original Semrush fix).
 useEffect(() => {
 if (!IS_PROD || !enabled || !adSlot || !isAdSenseAllowed()) return;
 // Per-visitor entitlement (#3655, part 2/2 of #2961): a reader with an
 // active CHF 2.99/month no-ads subscription never loads adsbygoogle.js.
 // NEVER a global/per-route toggle — see AGENTS.md Non-Negotiable #7.
 if (hasActiveReaderNoAdsEntitlement()) return;
 const wrapper = wrapperRef.current;
 if (!wrapper) return;

 // The script may already be present (another banner, the static shell
 // loader, or our own idle fallback injected it). Mark it ready — but do NOT
 // arm this slot's push here. Arming on script-presence is what made every
 // manual slot on the page request eagerly: the idle fallback below injects
 // the script ~1.5s after mount, i.e. BEFORE the SPA job list finishes
 // rendering, so every in-feed banner mounted afterwards took this branch and
 // pushed at once, thousands of px below the fold. Measured live on
 // /cerca-lavoro-ticino/ at 412×915: 5 units requested together at t≈2.6s with
 // the visitor still at scrollY=0 — 0 of them viewable. That is the 22%
 // mobile viewability on the former shared in-feed/auth-gate unit. The registry
 // now keeps listing and detail contexts on separate console units, so this
 // diagnosis can be made per surface. Issue: AdSense "Assicurati che i tuoi
 // annunci siano visualizzati" opportunity.
 if (typeof document !== 'undefined' &&
 document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]')) {
 loadAdSenseScript();
 }

 if (typeof IntersectionObserver === 'undefined') {
 // Older browsers — fall back to immediate load.
 loadAdSenseScript();
 armed.current = true;
 setState('waiting_width');
 return;
 }

 // Shared one-shot guard: this slot commits to width-wait exactly once. The
 // two paths that set state — IO fill and first interaction — mark `triggered`
 // and detach the interaction listeners, so a later mousemove/scroll can't call
 // setState('waiting_width') on an already-filled ad and hide it (viewability/
 // CLS regression). The idle fallback is NOT in this set: it only loads
 // adsbygoogle.js globally for Auto Ads while this manual slot still fills via a
 // later interaction/scroll — setting `triggered` there would wrongly freeze the
 // slot. Mirrors the idempotent `loadScript` guard in ADSENSE_LOADER_CONTENT
 // (build-plugins/constants.ts).
 const INTERACTION_EVENTS: Array<keyof DocumentEventMap> = ['scroll', 'touchstart', 'pointerdown', 'keydown', 'mousemove'];
 let triggered = false;
 const removeInteractionListeners = () => {
 if (typeof document === 'undefined') return;
 for (const ev of INTERACTION_EVENTS) {
 document.removeEventListener(ev, onFirstInteraction, true);
 }
 };

 const io = new IntersectionObserver((entries) => {
 for (const entry of entries) {
 if (entry.isIntersecting && !pushed.current) {
 triggered = true;
 removeInteractionListeners();
 io.disconnect();
 loadAdSenseScript();
 armed.current = true;
 setState('waiting_width');
 return;
 }
 }
 }, { rootMargin: AD_SLOT_VIEWPORT_ROOT_MARGIN });
 io.observe(wrapper);

 // Auto Ads idle fallback: load adsbygoogle.js once the page goes idle even
 // if this slot never scrolls into view. Without it, SPA routes whose static
 // shell omits the external adsense-loader (e.g. the homepage) never load the
 // script on a no-scroll / quick-bounce mobile session, so the anchor +
 // in-page Auto Ads (the top RPM earners) never fire. Mirrors the
 // requestIdleCallback fallback in ADSENSE_LOADER_CONTENT (build-plugins/
 // constants.ts). Bot-gated to avoid inflating AD_REQUESTS. Loading the
 // script alone enables Auto Ads; this slot's own push still waits for the
 // IntersectionObserver, so manual slots stay lazy.
 let idleHandle: number | undefined;
 let idleTimer: ReturnType<typeof setTimeout> | undefined;
 if (!SKIP_FOR_BOT) {
 const ric = (window as unknown as {
 requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
 }).requestIdleCallback;
 if (typeof ric === 'function') {
 idleHandle = ric(() => loadAdSenseScript(), { timeout: 1500 });
 } else {
 idleTimer = setTimeout(() => loadAdSenseScript(), 1500);
 }
 }

 // First-interaction trigger: load on the first real user engagement so a
 // quick-bounce mobile session that taps/scrolls before the idle fallback
 // fires still serves the anchor/in-page Auto Ads. Mirrors the interaction
 // listeners in ADSENSE_LOADER_CONTENT (build-plugins/constants.ts).
 //
 // It loads the SCRIPT ONLY and deliberately leaves the observer attached: a
 // single scroll anywhere on the page used to arm EVERY banner at once (each
 // one registers these listeners on `document`), which requested in-feed units
 // the visitor had not reached and could not see. Auto Ads are unaffected —
 // they need the script, not this slot's push — so AGENTS.md Non-Negotiable #7
 // still holds: nothing is suppressed, only the per-slot request is deferred
 // to the moment the slot approaches the viewport.
 function onFirstInteraction() {
 if (triggered || pushed.current) return;
 removeInteractionListeners();
 loadAdSenseScript();
 }
 if (!SKIP_FOR_BOT && typeof document !== 'undefined') {
 for (const ev of INTERACTION_EVENTS) {
 document.addEventListener(ev, onFirstInteraction, { once: true, passive: true, capture: true });
 }
 }

 return () => {
 io.disconnect();
 const cic = (window as unknown as {
 cancelIdleCallback?: (handle: number) => void;
 }).cancelIdleCallback;
 if (idleHandle !== undefined && typeof cic === 'function') cic(idleHandle);
 if (idleTimer !== undefined) clearTimeout(idleTimer);
 removeInteractionListeners();
 };
 }, [enabled, adSlot, loadAdSenseScript, adsConsentTick]);

 // ── Wait for measurable width, then push ─────────────────
 useEffect(() => {
 if (state !== 'waiting_width' || !scriptReady || !adSlot || pushed.current || !isAdSenseAllowed()) return;

 const wrapper = wrapperRef.current;
 if (!wrapper) return;

 cleanupAsyncWatchers();

 const requests = createAdSlotRequests();
 let waitingReported = false;
 const tryPush = () => {
   const el = adRef.current;
   if (!el) return false;
   const result = requests.request(el);
   if (result.state === 'waiting_width') {
     if (!waitingReported) {
       waitingReported = true;
       emitAdDiagnostic('ad_slot_waiting_width', { slot: adSlot, width: result.width, minimum_width: result.minimum, render_path: 'spa' });
     }
     return false;
   }
   wrapper.removeAttribute('data-ft-ad-width-wait');
   const lifecycle = ensureLifecycle();
   if (result.state === 'failed') {
     emitAdDiagnostic('ad_slot_error', { slot: adSlot, reason: result.code || 'unknown', error_name: result.errorName || 'Error', width: result.width, minimum_width: result.minimum, render_path: 'spa' });
     lifecycle?.fail('push_failed');
   } else {
     pushed.current = true;
     lifecycle?.request();
   }
   return true;
 };
 if (tryPush()) return;

 // A width deadline is diagnostic, not terminal. Keep observing so rotating
 // the device, zooming out or a container resize can recover the same node.
 let pushFrame: number | undefined;
 const schedulePush = () => {
   if (pushFrame !== undefined) return;
   pushFrame = requestAnimationFrame(() => {
     pushFrame = undefined;
     if (tryPush()) cleanupAsyncWatchers();
   });
 };
 if (typeof ResizeObserver !== 'undefined') {
   const observer = new ResizeObserver(schedulePush);
   observer.observe(wrapper);
   if (adRef.current) observer.observe(adRef.current);
   resizeObserverRef.current = observer;
 }
 window.addEventListener('resize', schedulePush);
 const timeout = setTimeout(() => {
   if (!pushed.current) {
     wrapper.setAttribute('data-ft-ad-width-wait', 'timed_out');
     const size = adRef.current ? requests.geometry(adRef.current) : { width: 0, minimum: 0 };
     emitAdDiagnostic('ad_slot_width_timeout', { slot: adSlot, width: size.width, minimum_width: size.minimum, render_path: 'spa' });
   }
 }, 8000);
 return () => {
   cleanupAsyncWatchers();
   window.removeEventListener('resize', schedulePush);
   clearTimeout(timeout);
   if (pushFrame !== undefined) cancelAnimationFrame(pushFrame);
 };
 }, [state, scriptReady, adSlot, cleanupAsyncWatchers, ensureLifecycle, adsConsentTick]);

 useEffect(() => {
 if (readerNoAds) collapseWhenLayoutSafe('reader_entitlement');
 }, [readerNoAds, collapseWhenLayoutSafe]);

 // Script errors are terminal for this attempt, but late successful loads can recover.
 useEffect(() => {
 if (scriptFailed) collapseWhenLayoutSafe('script_failed');
 }, [scriptFailed, collapseWhenLayoutSafe]);


 useEffect(() => () => {
 cleanupAsyncWatchers();
 unsubscribeScript.current?.();
 unsubscribeScript.current = null;
 lifecycleRef.current?.stop();
 lifecycleRef.current = null;
 }, [cleanupAsyncWatchers]);

 // ── Render nothing in dev or when slot is missing ─────────
 if (!IS_PROD || !adSlot) {
 return null;
 }

 // Skip rendering entirely for bots / headless — saves an ad_request and
 // keeps the AdSense coverage metric uncontaminated. Logged once per slot.
 if (SKIP_FOR_BOT) {
 if (!pushed.current) {
 pushed.current = true;
 trackAdEvent('ad_bot_skip', { slot: adSlot, format: adFormat, reason: 'navigator_bot' });
 }
 return null;
 }

 // When disabled but reserveSpace is true, render the placeholder wrapper
 // so the layout doesn't shift when the ad eventually loads (CLS fix).
 if (!enabled && !reserveSpace) {
 return null;
 }

 // ── Production ad unit ───────────────────────────────────
 // CLS-safe ad container:
 // - Loading/idle: reserve space with minHeight so the layout is stable
 // (maxHeight alone doesn't work when content is 0px tall — it's just a cap)
 // - Filled: natural height, fully visible
 // - Collapsed: zero space, reached only while outside the viewport
 const isVisible = state === 'filled';
 const isCollapsed = state === 'collapsed';

 // The wrapper carries `state` as AD_BANNER_STATE_ATTR: the per-page ad
 // diagnosis (services/adPageDiag.ts) counts a slot here as collapsed from it.

 return (
 <div
 ref={wrapperRef}
 className={className}
 {...{ [AD_BANNER_STATE_ATTR]: state }}
 data-ad-placement={placement || adSlot}
 data-ad-experiment={experimentId}
 data-ad-variant={experimentVariant}
 style={{
 contain: 'content',
 width: '100%',
 minWidth: 0,
 ...(isCollapsed ? { margin: 0, padding: 0 } : {}),
 // Reserve space via minHeight — keep it even after ad loads to prevent CLS
 // when the actual ad is shorter than the placeholder (FRO-299)
 minHeight: isCollapsed ? 0 : placeholderMinHeight,
 // Cap collapsed state to 0. Before a creative is confirmed the box is also
 // capped at its reserve: Google sizes the <ins> of a multiplex before
 // answering (1790px measured live on `/`, 2026-10-24) and an `unfilled`
 // answer may follow, so an uncapped box grew 400->1790px of invisible space
 // and pushed the page down for nothing. The <ins> keeps its own size (only
 // the wrapper clips it) and the cap lifts the moment the state is `filled`.
 maxHeight: isCollapsed ? 0 : (!isVisible && placeholderMinHeight ? placeholderMinHeight : undefined),
 opacity: isVisible ? 1 : 0,
 overflow: 'hidden',
 ...(isVisible ? {} : { pointerEvents: 'none' as const }),
 }}
 aria-hidden={!isVisible}
 >
 {label && (
 <p className="text-xs font-medium text-muted uppercase tracking-wider mb-1 text-center">
 {label}
 </p>
 )}
 {/* Mounted only once this slot is ARMED (state left `idle`), never while it
 is still waiting for the IntersectionObserver.

 This is what makes the deferral real rather than cosmetic.
 `adsbygoogle.push({})` is not bound to an element: it fills the next
 `<ins>` in DOM ORDER that has no `data-adsbygoogle-status` yet (see the
 note above ADSENSE_LOADER_CONTENT in build-plugins/constants.ts). With
 every banner's `<ins>` in the DOM from first paint, the push issued for
 the unit the visitor actually reached would bind to the first un-pushed
 `<ins>` above it instead — an off-screen unit — and viewability would not
 move at all. Keeping un-armed slots out of the DOM makes the set of
 push-eligible elements exactly the set of slots that came near the
 viewport, so each push lands on the unit that earned it.

 CLS is unaffected: the reservation lives on the wrapper's `minHeight`
 (resolved from the registry above), not on the `<ins>`. */}
 {(state !== 'idle' || scriptFailed || readerNoAds) && (
 <ReactAdsense
 request={registerAd}
 client={CLIENT_ID}
 slot={adSlot}
 format={adFormat}
 responsive={fullWidthResponsive}
 layoutKey={adLayoutKey}
 layout={adLayout}
 />
 )}
 </div>
 );
}
