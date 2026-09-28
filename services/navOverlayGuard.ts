/**
 * Keeps third-party fixed overlays from sitting on top of the sticky site nav.
 *
 * Seen live on article pages (2026-09-28): the AdSense "ad intents" anchor chip
 * (a ~500x48 floating topic pill, e.g. "Permessi di lavoro") rendered at
 * top:14px on desktop, right over the nav's search / language / notification /
 * account controls. `data-overlays="bottom"` on the adsbygoogle.js tag
 * (AdSenseBanner + the static adsense-loader) keeps classic anchors at the
 * bottom but does not bind this format.
 *
 * What this does: when an element that React did not render covers the nav
 * band, its outermost fixed/absolute box is translated down so its top edge
 * sits just below the nav. The overlay is never hidden, removed, resized or
 * delayed (AGENTS.md Non-Negotiable #7) — it stays fully visible and
 * clickable, only lower. The offset is recomputed from the overlay's own
 * position on every refresh and dropped as soon as that position no longer
 * overlaps the nav, so Google stays in charge of where the chip goes.
 * `translate` is a transform: moving the box is not a layout shift.
 *
 * Layers that span the viewport — as wide as it (≥90%) or taller than 40% of
 * it — and take clicks are panels meant to cover the page (consent banner or
 * dialog, vignette, offerwall, full-width anchor): they are left alone, and so
 * is everything inside them. Only a click-through (`pointer-events: none`)
 * spanning layer is looked into, because it merely positions what it hosts.
 */

/** Space kept between the nav's bottom edge and a moved overlay. */
export const NAV_OVERLAY_GAP_PX = 8;
/** Overlays taller than this share of the viewport are panels, not chips. */
const MAX_OVERLAY_HEIGHT_RATIO = 0.4;
/** Overlays at least this share of the viewport wide are panels, not chips. */
const MAX_OVERLAY_WIDTH_RATIO = 0.9;
/** Horizontal distance between probes along the nav band. */
const PROBE_STEP_PX = 48;
/** Scroll only re-runs discovery this often; moved overlays update every frame. */
const SCROLL_DISCOVERY_INTERVAL_MS = 1000;
/**
 * Extra discovery passes after an overlay mutation: a style change often only
 * STARTS a CSS transition, and the box reaches the nav band later without any
 * further mutation, scroll or resize.
 */
const MUTATION_FOLLOW_UP_MS = [300, 1000];
/** Diagnostic marker carrying the applied offset in px. */
export const NAV_OVERLAY_SHIFT_ATTR = 'data-ft-nav-clear';

const APP_ROOT_IDS = ['root', 'footer-root'];

function isReactManaged(node: Node): boolean {
 return Object.keys(node).some((key) => key.startsWith('__reactFiber$'));
}

function parentAcrossShadow(node: Element): Element | null {
 if (node.parentElement) return node.parentElement;
 const parent = node.parentNode;
 return typeof ShadowRoot !== 'undefined' && parent instanceof ShadowRoot ? parent.host : null;
}

/** `elementFromPoint`, descending into open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
 if (typeof document.elementFromPoint !== 'function') return null;
 let element = document.elementFromPoint(x, y);
 for (let depth = 0; element?.shadowRoot && depth < 4; depth += 1) {
 const inner = element.shadowRoot.elementFromPoint(x, y);
 if (!inner || inner === element) break;
 element = inner;
 }
 return element;
}

/**
 * The box to move for an element found on the nav band: the outermost
 * fixed/absolute ancestor that React did not render and that does not span
 * the viewport. `null` when the hit is our own UI or sits inside a panel that
 * spans the viewport and takes clicks.
 */
export function findCoveringOverlay(hit: Element, viewportWidth: number, viewportHeight: number): HTMLElement | null {
 const positioned: HTMLElement[] = [];
 let element: Element | null = hit;
 for (let depth = 0; element && depth < 16; depth += 1) {
 if (element === document.body || element === document.documentElement) break;
 if (isReactManaged(element)) break;
 if (element instanceof HTMLElement) {
 const position = window.getComputedStyle(element).position;
 if (position === 'fixed' || position === 'absolute') positioned.push(element);
 }
 element = parentAcrossShadow(element);
 }
 for (let index = positioned.length - 1; index >= 0; index -= 1) {
 const candidate = positioned[index];
 const rect = candidate.getBoundingClientRect();
 if (rect.height <= 0) continue;
 const spansViewport = rect.width >= viewportWidth * MAX_OVERLAY_WIDTH_RATIO
 || rect.height > viewportHeight * MAX_OVERLAY_HEIGHT_RATIO;
 if (!spansViewport) return candidate;
 if (window.getComputedStyle(candidate).pointerEvents !== 'none') return null;
 }
 return null;
}

/**
 * Offset (px) that moves a box whose un-shifted top is `naturalTop` below the
 * nav, or 0 when that box does not overlap the nav band.
 */
export function navOverlayShift(naturalTop: number, height: number, navTop: number, navBottom: number): number {
 const overlapsNav = naturalTop < navBottom && naturalTop + height > navTop;
 return overlapsNav ? Math.ceil(navBottom + NAV_OVERLAY_GAP_PX - naturalTop) : 0;
}

/**
 * Starts guarding `nav`. Returns the teardown, which also drops every offset
 * it applied.
 */
export function installNavOverlayGuard(nav: HTMLElement): () => void {
 if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

 const shifted = new Map<HTMLElement, number>();
 let frame: number | null = null;
 let pendingDiscovery = false;
 let lastDiscovery = 0;
 let followUps: number[] = [];

 const apply = (element: HTMLElement, px: number): void => {
 if (px <= 0) {
 if (!shifted.has(element)) return;
 element.style.removeProperty('translate');
 element.removeAttribute(NAV_OVERLAY_SHIFT_ATTR);
 shifted.delete(element);
 return;
 }
 if (shifted.get(element) === px) return;
 element.style.setProperty('translate', `0 ${px}px`, 'important');
 element.setAttribute(NAV_OVERLAY_SHIFT_ATTR, String(px));
 shifted.set(element, px);
 };

 const refresh = (): void => {
 frame = null;
 const discover = pendingDiscovery;
 pendingDiscovery = false;
 if (!nav.isConnected) return;
 const navRect = nav.getBoundingClientRect();
 if (navRect.height <= 0 || navRect.bottom <= 0) return;

 shifted.forEach((applied, element) => {
 if (!element.isConnected) {
 shifted.delete(element);
 return;
 }
 const rect = element.getBoundingClientRect();
 apply(element, navOverlayShift(rect.top - applied, rect.height, navRect.top, navRect.bottom));
 });

 if (discover) {
 lastDiscovery = Date.now();
 const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
 const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
 const rows = [navRect.top + navRect.height / 2, navRect.bottom - 4].filter((y) => y >= 0);
 for (let x = PROBE_STEP_PX / 2; x < viewportWidth; x += PROBE_STEP_PX) {
 for (const y of rows) {
 const hit = deepElementFromPoint(x, y);
 if (!hit || nav.contains(hit)) continue;
 const overlay = findCoveringOverlay(hit, viewportWidth, viewportHeight);
 if (!overlay || shifted.has(overlay)) continue;
 const rect = overlay.getBoundingClientRect();
 apply(overlay, navOverlayShift(rect.top, rect.height, navRect.top, navRect.bottom));
 }
 }
 }

 // A moved overlay can travel with no event we could observe (a CSS
 // transition, a move inside a closed shadow root): while one is moved,
 // re-measure it on every frame. The loop stops by itself once none is.
 if (shifted.size > 0) schedule(false);
 };

 const schedule = (withDiscovery: boolean): void => {
 if (withDiscovery) pendingDiscovery = true;
 if (frame !== null) return;
 if (typeof window.requestAnimationFrame !== 'function') {
 refresh();
 return;
 }
 frame = window.requestAnimationFrame(refresh);
 };

 const appRoots = APP_ROOT_IDS
 .map((id) => document.getElementById(id))
 .filter((root): root is HTMLElement => root !== null);
 // React re-renders inside the app roots on every scroll tick (reading
 // progress, TOC highlight); overlays are injected outside them.
 const observer = typeof MutationObserver === 'undefined'
 ? null
 : new MutationObserver((records) => {
 if (!records.some((record) => !appRoots.some((root) => root.contains(record.target)))) return;
 schedule(true);
 followUps.forEach((timer) => window.clearTimeout(timer));
 followUps = MUTATION_FOLLOW_UP_MS.map((delay) => window.setTimeout(() => schedule(true), delay));
 });
 observer?.observe(document.documentElement, {
 childList: true,
 subtree: true,
 attributes: true,
 attributeFilter: ['class', 'style', 'hidden'],
 });
 // Moved overlays are already re-measured every frame by `refresh`; scrolling
 // additionally looks for new ones at most once a second.
 const onScroll = (): void => schedule(Date.now() - lastDiscovery >= SCROLL_DISCOVERY_INTERVAL_MS);
 const onResize = (): void => schedule(true);
 window.addEventListener('scroll', onScroll, { passive: true });
 window.addEventListener('resize', onResize, { passive: true });
 schedule(true);

 return () => {
 observer?.disconnect();
 followUps.forEach((timer) => window.clearTimeout(timer));
 followUps = [];
 window.removeEventListener('scroll', onScroll);
 window.removeEventListener('resize', onResize);
 if (frame !== null) window.cancelAnimationFrame(frame);
 frame = null;
 [...shifted.keys()].forEach((element) => apply(element, 0));
 };
}
