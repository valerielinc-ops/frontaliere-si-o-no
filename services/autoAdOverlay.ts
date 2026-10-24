/**
 * Measures Google's fixed Auto Ads anchor so bottom prompts can sit above it.
 *
 * This only observes the ad layer and reserves clearance for the prompt. It
 * never hides, removes, delays, or opts out of an ad request.
 */

const AUTO_AD_CANDIDATE_SELECTOR = [
  '.google-auto-placed',
  'iframe[id^="aswift_"]',
  'iframe[name^="aswift_"]',
  '[id^="google_ads_iframe_"]',
].join(',');

type Listener = (clearance: number) => void;

let currentClearance = 0;
let listeners = new Set<Listener>();
let bodyObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let animationFrame: number | null = null;
let refreshTimer: number | null = null;
let knownCandidates: HTMLElement[] = [];
let observedOverlays: HTMLElement[] = [];
let visualViewport: VisualViewport | null = null;

function viewportSize(): { width: number; height: number } {
 if (typeof window === 'undefined' || typeof document === 'undefined') {
 return { width: 0, height: 0 };
 }
 return {
 width: window.innerWidth || document.documentElement.clientWidth,
 height: window.innerHeight || document.documentElement.clientHeight,
 };
}

function isHiddenByAncestor(candidate: HTMLElement): boolean {
 // An iframe can retain its old rectangle while a wrapper is hidden. Check
 // the entire chain before reserving space for that rectangle.
 for (let ancestor: HTMLElement | null = candidate; ancestor; ancestor = ancestor.parentElement) {
 const style = window.getComputedStyle(ancestor);
 if (style.display === 'none' || style.visibility === 'hidden'
 || style.visibility === 'collapse' || style.opacity === '0') return true;
 }
 return false;
}

function fixedBottomOverlayElements(candidates: HTMLElement[] = queryAutoAdCandidates()): HTMLElement[] {
 if (typeof document === 'undefined') return [];

 const { width: viewportWidth, height: viewportHeight } = viewportSize();
 if (viewportWidth <= 0 || viewportHeight <= 0) return [];

 const overlays = new Set<HTMLElement>();
 candidates.forEach((candidate) => {
 let element: HTMLElement | null = candidate;
 let anchor: HTMLElement | null = null;
 // Google nests the creative in a few wrappers. Stop at body so an in-flow
 // manual slot can never be mistaken for a fixed anchor.
 for (let depth = 0; element && element !== document.body && depth < 8; depth += 1) {
 const rect = element.getBoundingClientRect();
 const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
 // INP: the geometry is checked BEFORE the computed style. In-page Auto
 // Ads sit in the content flow, not on the viewport's bottom edge, so they
 // fail here and never pay for getComputedStyle; the conditions are the
 // same AND as before, only evaluated cheapest-first.
 const isBottomBand = visibleWidth >= Math.min(viewportWidth * 0.7, 320)
 && rect.height > 0
 // Fullscreen vignettes own the viewport, not an anchor band beneath the UI.
 && rect.top > 0
 && rect.top < viewportHeight
 && rect.bottom >= viewportHeight - 4;
 if (isBottomBand && window.getComputedStyle(element).position === 'fixed') {
 anchor = element;
 break;
 }
 element = element.parentElement;
 }
 if (anchor && !isHiddenByAncestor(candidate)) overlays.add(anchor);
 });

 return [...overlays];
}

function queryAutoAdCandidates(): HTMLElement[] {
 if (typeof document === 'undefined') return [];
 return [...document.querySelectorAll<HTMLElement>(AUTO_AD_CANDIDATE_SELECTOR)];
}

function clearanceFor(overlays: HTMLElement[]): number {
 const { height: viewportHeight } = viewportSize();
 if (viewportHeight <= 0) return 0;

 let clearance = 0;
 for (const element of overlays) {
 const rect = element.getBoundingClientRect();
 clearance = Math.max(clearance, viewportHeight - rect.top);
 }
 // The measured band is authoritative: a 250px anchor needs 250px even when
 // a shorter anchor is more usual. The prompt constrains its own scroll area.
 return Math.max(0, Math.ceil(clearance));
}

export function measureAutoAdOverlayClearance(): number {
 return clearanceFor(fixedBottomOverlayElements());
}

function sameElements(a: HTMLElement[], b: HTMLElement[]): boolean {
 return a.length === b.length && a.every((element, index) => element === b[index]);
}

function refresh(): void {
 animationFrame = null;
 refreshTimer = null;
 knownCandidates = queryAutoAdCandidates();
 // One walk feeds both the clearance and the ResizeObserver targets: the
 // previous version walked the candidates twice per refresh.
 const overlays = fixedBottomOverlayElements(knownCandidates);
 const nextClearance = clearanceFor(overlays);
 if (resizeObserver && !sameElements(overlays, observedOverlays)) {
 resizeObserver.disconnect();
 overlays.forEach((element) => resizeObserver?.observe(element));
 observedOverlays = overlays;
 }
 if (nextClearance === currentClearance) return;
 currentClearance = nextClearance;
 listeners.forEach((listener) => listener(currentClearance));
}

/**
 * INP: the measurement reads layout (getBoundingClientRect + getComputedStyle
 * on the ad chain). Run inside the rAF that precedes a paint, it forced a
 * synchronous style+layout of whatever the interaction had just committed,
 * inside that interaction's frame. Waiting for the task AFTER the frame reads
 * the layout the paint already computed, so the next paint is never delayed.
 */
function scheduleRefresh(): void {
 if (animationFrame !== null || refreshTimer !== null) return;
 if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
 refresh();
 return;
 }
 animationFrame = window.requestAnimationFrame(() => {
 animationFrame = null;
 refreshTimer = window.setTimeout(refresh, 0);
 });
}

function nodeTouchesAdLayer(node: Node): boolean {
 if (node.nodeType !== 1) return false;
 const element = node as Element;
 return element.matches(AUTO_AD_CANDIDATE_SELECTOR)
 || element.querySelector(AUTO_AD_CANDIDATE_SELECTOR) !== null;
}

/**
 * Only mutations that can change the anchor band are worth a measurement: an
 * ad candidate added/removed, or an attribute change on a candidate or on one
 * of its ancestors (a wrapper that hides it). A job-list or calculator
 * re-render rewrites hundreds of `class` attributes elsewhere in the body and
 * used to schedule a full layout read for each commit.
 */
export function mutationsTouchAutoAdLayer(records: readonly MutationRecord[], candidates: readonly Element[]): boolean {
 for (const record of records) {
 if (record.type === 'childList') {
 for (const node of record.addedNodes) if (nodeTouchesAdLayer(node)) return true;
 for (const node of record.removedNodes) if (nodeTouchesAdLayer(node)) return true;
 continue;
 }
 const target = record.target;
 if (target.nodeType !== 1) continue;
 const element = target as Element;
 if (element.matches(AUTO_AD_CANDIDATE_SELECTOR)) return true;
 for (const candidate of candidates) if (element.contains(candidate)) return true;
 }
 return false;
}

function onBodyMutation(records: MutationRecord[]): void {
 if (mutationsTouchAutoAdLayer(records, knownCandidates)) scheduleRefresh();
}

function stopObserving(): void {
 if (animationFrame !== null && typeof window !== 'undefined') {
 window.cancelAnimationFrame(animationFrame);
 }
 animationFrame = null;
 if (refreshTimer !== null && typeof window !== 'undefined') window.clearTimeout(refreshTimer);
 refreshTimer = null;
 knownCandidates = [];
 observedOverlays = [];
 bodyObserver?.disconnect();
 bodyObserver = null;
 resizeObserver?.disconnect();
 resizeObserver = null;
 if (typeof window !== 'undefined') {
 window.removeEventListener('resize', scheduleRefresh);
 }
 visualViewport?.removeEventListener('resize', scheduleRefresh);
 visualViewport = null;
 currentClearance = 0;
}

function startObserving(): void {
 if (bodyObserver || typeof document === 'undefined' || !document.body) return;

 bodyObserver = new MutationObserver(onBodyMutation);
 bodyObserver.observe(document.body, {
 childList: true,
 subtree: true,
 attributes: true,
 attributeFilter: ['class', 'id', 'name', 'style', 'hidden'],
 });
 if (typeof ResizeObserver !== 'undefined') {
 resizeObserver = new ResizeObserver(scheduleRefresh);
 }
 window.addEventListener('resize', scheduleRefresh, { passive: true });
 visualViewport = window.visualViewport ?? null;
 visualViewport?.addEventListener('resize', scheduleRefresh, { passive: true });
 scheduleRefresh();
}

export function getAutoAdOverlayClearance(): number {
 return currentClearance;
}

export function subscribeToAutoAdOverlay(listener: Listener): () => void {
 listeners.add(listener);
 startObserving();
 listener(currentClearance);
 return () => {
 listeners.delete(listener);
 if (listeners.size === 0) stopObserving();
 };
}
