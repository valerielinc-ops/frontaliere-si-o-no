const VISIBLE_OVERLAY_SELECTOR = [
  '[data-bottom-prompt]',
  '[data-bottom-overlay]',
  '[class*="z-[9999]"]',
  '[class*="z-[70]"]',
  '[role="dialog"][aria-modal="true"]',
].join(',');

function isVisibleOverlay(element: Element): boolean {
  if (typeof window === 'undefined' || !(element instanceof HTMLElement)) return false;

  const computed = window.getComputedStyle(element);
  if (
    element.hidden
    || element.getAttribute('aria-hidden') === 'true'
    || computed.display === 'none'
    || computed.visibility === 'hidden'
    || computed.opacity === '0'
    || computed.pointerEvents === 'none'
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.top < window.innerHeight;
}

/** True when a visible popup/overlay could collide with the floating button. */
export function hasVisibleBottomOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll(VISIBLE_OVERLAY_SELECTOR)).some(isVisibleOverlay);
}
