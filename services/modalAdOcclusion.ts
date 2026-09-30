/**
 * Hides Google's ad overlays while a site modal is open, and puts back
 * exactly what it hid when the modal closes.
 *
 * `body.modal-open` (index.css) already hides the in-flow slots, but the
 * wrappers Google injects around anchor, side-rail and vignette iframes have
 * no predictable id: they are the first `position: fixed|absolute` ancestor of
 * an `aswift_` iframe, and Auto ads live in `.google-auto-placed`. Those get
 * an inline `display: none !important` for as long as the modal is open.
 *
 * The restore is the point of this module. NewsletterPopup used to put back
 * only the `.google-auto-placed` containers, so the anchor and every other
 * fixed wrapper it had hidden stayed hidden until the next full page load:
 * the anchor (about 29% of the ad revenue, GA4 7 days to 2026-09-29) was lost
 * for the rest of the visit of everyone who saw the popup.
 */

interface HiddenDisplay {
  value: string;
  priority: string;
}

/** Google's fixed/absolute wrapper around an `aswift_` iframe, if any. */
function overlayWrapper(iframe: Element, doc: Document): HTMLElement | null {
  const view = doc.defaultView;
  if (!view) return null;
  let el = iframe.parentElement;
  while (el && el !== doc.body) {
    const { position } = view.getComputedStyle(el);
    if (position === 'fixed' || position === 'absolute') return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Hides the overlays now and every one Google adds while the modal is open.
 * Returns the restore function: it gives each hidden element back the inline
 * `display` it had before (usually none), and is safe to call twice.
 */
export function suppressGoogleAdOverlays(doc: Document = document): () => void {
  const hidden = new Map<HTMLElement, HiddenDisplay>();
  const hide = (el: HTMLElement) => {
    if (hidden.has(el)) return;
    hidden.set(el, {
      value: el.style.getPropertyValue('display'),
      priority: el.style.getPropertyPriority('display'),
    });
    el.style.setProperty('display', 'none', 'important');
  };
  const scan = () => {
    doc.querySelectorAll('iframe[id^="aswift_"]').forEach((iframe) => {
      const wrapper = overlayWrapper(iframe, doc);
      if (wrapper) hide(wrapper);
    });
    doc.querySelectorAll<HTMLElement>('.google-auto-placed').forEach(hide);
  };

  scan();
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(scan);
  observer?.observe(doc.body, { childList: true, subtree: true });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    observer?.disconnect();
    hidden.forEach(({ value, priority }, el) => {
      if (value) el.style.setProperty('display', value, priority);
      else el.style.removeProperty('display');
    });
    hidden.clear();
  };
}
