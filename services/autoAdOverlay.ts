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

export const MAX_AUTO_AD_OVERLAY_CLEARANCE_PX = 160;

type Listener = (clearance: number) => void;

let currentClearance = 0;
let listeners = new Set<Listener>();
let bodyObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let animationFrame: number | null = null;
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

function fixedBottomOverlayElements(): HTMLElement[] {
 if (typeof document === 'undefined') return [];

 const { width: viewportWidth, height: viewportHeight } = viewportSize();
 if (viewportWidth <= 0 || viewportHeight <= 0) return [];

 const overlays = new Set<HTMLElement>();
 document.querySelectorAll<HTMLElement>(AUTO_AD_CANDIDATE_SELECTOR).forEach((candidate) => {
 let element: HTMLElement | null = candidate;
 // Google nests the creative in a few wrappers. Stop at body so an in-flow
 // manual slot can never be mistaken for a fixed anchor.
 for (let depth = 0; element && element !== document.body && depth < 8; depth += 1) {
 const rect = element.getBoundingClientRect();
 const style = window.getComputedStyle(element);
 const isBottomFixed = style.position === 'fixed'
 && rect.width >= Math.min(viewportWidth * 0.7, 320)
 && rect.height > 0
 && rect.top < viewportHeight
 && rect.bottom >= viewportHeight - 4;
 if (isBottomFixed) {
 overlays.add(element);
 break;
 }
 element = element.parentElement;
 }
 });

 return [...overlays];
}

export function measureAutoAdOverlayClearance(): number {
 const { height: viewportHeight } = viewportSize();
 if (viewportHeight <= 0) return 0;

 let clearance = 0;
 for (const element of fixedBottomOverlayElements()) {
 const rect = element.getBoundingClientRect();
 clearance = Math.max(clearance, viewportHeight - rect.top);
 }
 return Math.min(MAX_AUTO_AD_OVERLAY_CLEARANCE_PX, Math.max(0, Math.ceil(clearance)));
}

function refreshObservedElements(): void {
 if (!resizeObserver) return;
 resizeObserver.disconnect();
 fixedBottomOverlayElements().forEach((element) => resizeObserver?.observe(element));
}

function refresh(): void {
 animationFrame = null;
 const nextClearance = measureAutoAdOverlayClearance();
 refreshObservedElements();
 if (nextClearance === currentClearance) return;
 currentClearance = nextClearance;
 listeners.forEach((listener) => listener(currentClearance));
}

function scheduleRefresh(): void {
 if (animationFrame !== null) return;
 if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
 refresh();
 return;
 }
 animationFrame = window.requestAnimationFrame(refresh);
}

function stopObserving(): void {
 if (animationFrame !== null && typeof window !== 'undefined') {
 window.cancelAnimationFrame(animationFrame);
 }
 animationFrame = null;
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

 bodyObserver = new MutationObserver(scheduleRefresh);
 bodyObserver.observe(document.body, {
 childList: true,
 subtree: true,
 attributes: true,
 attributeFilter: ['class', 'id', 'name', 'style'],
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
