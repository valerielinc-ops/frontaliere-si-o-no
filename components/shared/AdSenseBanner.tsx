/**
 * AdSenseBanner — Google AdSense display ad unit with width-aware lifecycle.
 *
 * Renders an <ins class="adsbygoogle"> element and pushes to the ad queue
 * ONLY after the container has measurable width (> 0px).
 *
 * State machine: idle → waiting_width → loading → filled | collapsed
 *
 * In development mode the component renders nothing (collapsed).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { isLikelyBot, trackAdEvent } from '@/services/adAnalytics';
import { isElementInViewport } from '@/services/adViewport';
import { hasActiveReaderNoAdsEntitlement } from '@/services/readerEntitlement';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';
import {
 AD_FILL_TIMEOUT_MS,
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

type AdState = 'idle' | 'waiting_width' | 'loading' | 'filled' | 'collapsed';
const initializedAdElements = new WeakSet<Element>();

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

export default function AdSenseBanner({
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
 const adRef = useRef<HTMLModElement>(null);
 const wrapperRef = useRef<HTMLDivElement>(null);
 const pushed = useRef(false);
 const fillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const statusObserverRef = useRef<MutationObserver | null>(null);
 const resizeObserverRef = useRef<ResizeObserver | null>(null);
 const collapseObserverRef = useRef<IntersectionObserver | null>(null);
 const [state, setState] = useState<AdState>('idle');
 const [scriptReady, setScriptReady] = useState(false);
 const [scriptFailed, setScriptFailed] = useState(false);
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
 if (fillTimeoutRef.current) {
 clearTimeout(fillTimeoutRef.current);
 fillTimeoutRef.current = null;
 }
 if (statusObserverRef.current) {
 statusObserverRef.current.disconnect();
 statusObserverRef.current = null;
 }
 if (resizeObserverRef.current) {
 resizeObserverRef.current.disconnect();
 resizeObserverRef.current = null;
 }
 if (collapseObserverRef.current) {
 collapseObserverRef.current.disconnect();
 collapseObserverRef.current = null;
 }
 }, []);

 const collapseWhenLayoutSafe = useCallback((reason: string) => {
 const wrapper = wrapperRef.current;
 if (!wrapper || typeof window === 'undefined' || typeof document === 'undefined') {
 setState('collapsed');
 return;
 }

 collapseObserverRef.current?.disconnect();
 collapseObserverRef.current = null;

 if (!isElementInViewport(wrapper) || typeof IntersectionObserver === 'undefined') {
 console.info(`[AdSense] ${reason} for slot=${adSlot}, collapsing banner`);
 setState('collapsed');
 return;
 }

 console.info(`[AdSense] ${reason} for slot=${adSlot}, deferring collapse until offscreen`);
 const observer = new IntersectionObserver((entries) => {
 const entry = entries[0];
 if (!entry?.isIntersecting) {
 observer.disconnect();
 collapseObserverRef.current = null;
 console.info(`[AdSense] deferred collapse for slot=${adSlot}`);
 setState('collapsed');
 }
 });
 observer.observe(wrapper);
 collapseObserverRef.current = observer;
 }, [adSlot]);

 // ── Load the AdSense script (singleton) ──────────────────
 const loadAdSenseScript = useCallback(() => {
 if (typeof document === 'undefined') return;
 // ── ADVERTISING CONSENT GATE (#5842) ──────────────────────
 // The single choke point for adsbygoogle.js in the SPA. Deliberately here and
 // not only in the effect below: this function is reached from four
 // independent paths (IntersectionObserver fill, already-present-script,
 // requestIdleCallback fallback, first-interaction listener), and a guard in
 // the effect would have to be repeated four times to be equivalent — one
 // missed path is a silent bypass. Also kept separate from the
 // `hasActiveReaderNoAdsEntitlement()` early return in that effect, which
 // never sees the idle/interaction callbacks that fire later.
 // Fails closed: any read failure means "no consent". See services/adsConsent.ts.
 // Analytics / PostHog / Clarity are NOT gated here — owner decision in #5842.
 if (!isAdsConsentGranted()) return;
 const existing = document.querySelector<HTMLScriptElement>('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
 if (existing) {
 // adsbygoogle global means the script has already loaded (e.g. via
 // index.html head) before this component mounted — load event won't
 // fire again, so mark ready immediately.
 if (typeof (window as unknown as { adsbygoogle?: unknown }).adsbygoogle !== 'undefined') {
 existing.setAttribute('data-loaded', '1');
 setScriptReady(true);
 return;
 }
 if (existing.getAttribute('data-loaded') === '1') setScriptReady(true);
 else if (existing.getAttribute('data-failed') === '1') setScriptFailed(true);
 else {
 existing.addEventListener('load', () => {
 existing.setAttribute('data-loaded', '1');
 setScriptReady(true);
 }, { once: true });
 existing.addEventListener('error', () => {
 existing.setAttribute('data-failed', '1');
 setScriptFailed(true);
 }, { once: true });
 }
 return;
 }
 const script = document.createElement('script');
 script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT_ID}`;
 script.async = true;
 script.crossOrigin = 'anonymous';
 // Force anchor/overlay ads to bottom only — prevents covering navbar on mobile
 script.setAttribute('data-overlays', 'bottom');
 // Reduce vignette/interstitial frequency — SPA triggers on every pushState
 script.setAttribute('data-ad-frequency-hint', '60s');
 script.addEventListener('load', () => {
 script.setAttribute('data-loaded', '1');
 setScriptReady(true);
 }, { once: true });
 script.addEventListener('error', () => {
 script.setAttribute('data-failed', '1');
 console.warn(`[AdSense] script load failed for slot=${adSlot}`);
 setScriptFailed(true);
 }, { once: true });
 document.head.appendChild(script);
 }, [adSlot]);

 // ── Lazy-load script via IntersectionObserver ─────────────
 // Only load adsbygoogle.js when the ad slot is within 200px of the viewport.
 // This eliminates Semrush "uncompressed JS" flags on pages where the ad
 // never enters view, and defers the ~45KB third-party payload past LCP.
 useEffect(() => {
 if (!IS_PROD || !enabled || !adSlot) return;
 // Per-visitor entitlement (#3655, part 2/2 of #2961): a reader with an
 // active CHF 2.99/month no-ads subscription never loads adsbygoogle.js.
 // NEVER a global/per-route toggle — see AGENTS.md Non-Negotiable #7.
 if (hasActiveReaderNoAdsEntitlement()) return;
 const wrapper = wrapperRef.current;
 if (!wrapper) return;

 // If the script is already present (e.g. another banner already triggered
 // load on this page), skip the observer and proceed to width-wait.
 if (typeof document !== 'undefined' &&
 document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]')) {
 loadAdSenseScript();
 setState('waiting_width');
 return;
 }

 if (typeof IntersectionObserver === 'undefined') {
 // Older browsers — fall back to immediate load.
 loadAdSenseScript();
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
 if (entry.isIntersecting) {
 triggered = true;
 removeInteractionListeners();
 io.disconnect();
 loadAdSenseScript();
 setState('waiting_width');
 return;
 }
 }
 }, { rootMargin: '200px 0px' });
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
 // listeners in ADSENSE_LOADER_CONTENT (build-plugins/constants.ts). Guarded
 // by `triggered` AND `pushed.current` so it never re-enters width-wait after
 // the IO/idle path has already filled this slot.
 function onFirstInteraction() {
 if (triggered || pushed.current) return;
 triggered = true;
 removeInteractionListeners();
 io.disconnect();
 loadAdSenseScript();
 setState('waiting_width');
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
 if (state !== 'waiting_width' || !scriptReady || !adSlot || pushed.current) return;

 const wrapper = wrapperRef.current;
 if (!wrapper) return;

 cleanupAsyncWatchers();

 const tryPush = () => {
 const width = wrapper.getBoundingClientRect().width;
 if (width <= 0) return false;

 console.info(`[AdSense] width ready for slot=${adSlot} (${Math.round(width)}px), initializing`);
 setState('loading');

 const el = adRef.current;
 if (!el) { collapseWhenLayoutSafe('missing ins element'); return true; }

 const currentStatus = el.getAttribute('data-ad-status');
 if (currentStatus === 'filled') {
 pushed.current = true;
 initializedAdElements.add(el);
 setState('filled');
 return true;
 }
 if (currentStatus === 'unfilled') {
 pushed.current = true;
 initializedAdElements.add(el);
 collapseWhenLayoutSafe('unfilled');
 return true;
 }

 const alreadyInitialized =
 initializedAdElements.has(el) ||
 el.getAttribute('data-adsbygoogle-status') !== null;

 try {
 if (!alreadyInitialized) {
 (window.adsbygoogle = window.adsbygoogle || []).push({});
 initializedAdElements.add(el);
 }
 pushed.current = true;
 } catch (err) {
 console.warn(`[AdSense] push() failed for slot=${adSlot}`, err);
 collapseWhenLayoutSafe('push failed');
 return true;
 }

 const observer = new MutationObserver(() => {
 const status = el.getAttribute('data-ad-status');
 if (status === 'filled') {
 cleanupAsyncWatchers();
 setState('filled');
 } else if (status === 'unfilled') {
 cleanupAsyncWatchers();
 collapseWhenLayoutSafe('unfilled');
 }
 });
 observer.observe(el, { attributes: true, attributeFilter: ['data-ad-status'] });
 statusObserverRef.current = observer;

 // Collapse the placeholder when the ad doesn't fill quickly. Was 90s
 // historically — Privacy Sandbox / Attestation / adblockers now block
 // AdSense before it can report unfilled, leaving a 400px reservation
 // on every blocked slot for 90s. Multiple slots × 400px = 800-1200px
 // of visible dead-space below the fold on every page load (S7).
 // The budget itself lives in `AD_FILL_TIMEOUT_MS` (services/adsenseSlots.ts)
 // because the containers Google injects need the same one — see
 // `services/autoAdCollapse.ts`.
 fillTimeoutRef.current = setTimeout(() => {
 const status = el.getAttribute('data-ad-status');
 if (status === 'filled') return;
 cleanupAsyncWatchers();
 collapseWhenLayoutSafe(`fill timeout (status=${status})`);
 }, AD_FILL_TIMEOUT_MS);

 return true;
 };

 // Try immediately
 if (tryPush()) return;

 // Otherwise observe for width changes
 console.info(`[AdSense] waiting for measurable width for slot=${adSlot}`);
 const observer = new ResizeObserver((entries) => {
 for (const entry of entries) {
 if (entry.contentRect.width > 0) {
 observer.disconnect();
 resizeObserverRef.current = null;
 tryPush();
 break;
 }
 }
 });
 observer.observe(wrapper);
 resizeObserverRef.current = observer;

 // Safety timeout — collapse if width never materializes
 const timeout = setTimeout(() => {
 observer.disconnect();
 if (!pushed.current) {
 collapseWhenLayoutSafe('width timeout');
 }
 }, 8000);

 return () => {
 cleanupAsyncWatchers();
 clearTimeout(timeout);
 };
 }, [state, scriptReady, adSlot, cleanupAsyncWatchers, collapseWhenLayoutSafe]);

 // ── Collapse on script failure ───────────────────────────
 useEffect(() => {
 if (scriptFailed && state !== 'collapsed') {
 collapseWhenLayoutSafe('script failed');
 }
 }, [scriptFailed, state, collapseWhenLayoutSafe]);

 // ── Telemetry: emit one event per terminal state transition ──────
 const reportedStateRef = useRef<AdState | null>(null);
 useEffect(() => {
 if (!IS_PROD || !adSlot) return;
 if (state !== 'filled' && state !== 'collapsed') return;
 if (reportedStateRef.current === state) return;
 reportedStateRef.current = state;
 const event = state === 'filled' ? 'ad_filled' : 'ad_collapsed';
 const reason = state === 'collapsed'
 ? (scriptFailed ? 'script_failed' : 'unfilled_or_timeout')
 : undefined;
 trackAdEvent(event, { slot: adSlot, format: adFormat, reason });
 }, [state, adSlot, adFormat, scriptFailed]);

 useEffect(() => () => {
 cleanupAsyncWatchers();
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
 // - Collapsed: smooth transition to 0 height
 const isVisible = state === 'filled';
 const isCollapsed = state === 'collapsed';
 const isReservingSpace = !isVisible && !isCollapsed;

 return (
 <div
 ref={wrapperRef}
 className={className}
 style={{
 contain: 'content',
 transition: 'min-height 300ms ease-out, max-height 300ms ease-out, opacity 200ms ease',
 // Reserve space via minHeight — keep it even after ad loads to prevent CLS
 // when the actual ad is shorter than the placeholder (FRO-299)
 minHeight: isCollapsed ? 0 : placeholderMinHeight,
 // Cap collapsed state to 0
 maxHeight: isCollapsed ? 0 : undefined,
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
 <ins
 ref={adRef}
 className="adsbygoogle"
 style={{ display: 'block', textAlign: adLayout === 'in-article' ? 'center' as const : undefined }}
 data-ad-client={CLIENT_ID}
 data-ad-slot={adSlot}
 data-ad-format={adFormat}
 {...(fullWidthResponsive ? { 'data-full-width-responsive': 'true' } : {})}
 {...(adLayoutKey ? { 'data-ad-layout-key': adLayoutKey } : {})}
 {...(adLayout ? { 'data-ad-layout': adLayout } : {})}
 />
 </div>
 );
}
