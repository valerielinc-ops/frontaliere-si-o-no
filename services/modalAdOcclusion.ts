/** Read-only observation: site promotions yield to Google overlays. Nothing
 * changes an ad's display, visibility, stacking order or lifetime. */
export function observeGoogleAdOverlays(onChange: (visible: boolean) => void, doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const scan = () => {
    const visible = Array.from(doc.querySelectorAll('iframe[id^="aswift_"], iframe[id^="google_ads_iframe"]')).some((iframe) => {
      let el = iframe.parentElement;
      while (el && el !== doc.body) {
        const style = view.getComputedStyle(el);
        if (style.position === 'fixed') {
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
            && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight;
        }
        el = el.parentElement;
      }
      return false;
    });
    onChange(visible);
  };
  const observer = new MutationObserver(scan);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-anchor-status'] });
  view.addEventListener('resize', scan);
  scan();
  return () => { observer.disconnect(); view.removeEventListener('resize', scan); };
}

/**
 * Room kept past a Google anchor ad for its own collapse tab, which sits
 * outside the anchor's box (about 33 px above a bottom anchor, live).
 */
export const GOOGLE_ANCHOR_TAB_ALLOWANCE_PX = 40;
const EDGE_SLACK_PX = 2;

export interface GoogleAdEdgeInsets {
  top: number;
  bottom: number;
}

/**
 * Read-only, like observeGoogleAdOverlays: how much of the viewport's top and
 * bottom edges a fixed Google ad (the anchor) takes, so a site dialog can
 * keep its controls clear of it. The anchor stacks above every site layer:
 * live on 2026-10-06 it covered the free button of the paid application
 * offer, and a click meant for the button opened the ad. A fixed ad that
 * touches neither edge, or takes half the viewport or more (a vignette), is
 * no edge inset. Reports only changes, starting with the current insets.
 */
export function observeGoogleAdEdgeInsets(
  onChange: (insets: GoogleAdEdgeInsets) => void,
  doc: Document = document,
): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  let last = '';
  const scan = () => {
    const height = view.innerHeight;
    let top = 0;
    let bottom = 0;
    for (const iframe of Array.from(doc.querySelectorAll('iframe[id^="aswift_"], iframe[id^="google_ads_iframe"]'))) {
      let el = iframe.parentElement;
      while (el && el !== doc.body) {
        const style = view.getComputedStyle(el);
        if (style.position === 'fixed') {
          const rect = el.getBoundingClientRect();
          const shown = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
            && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < height;
          if (shown && rect.height < height / 2) {
            if (rect.bottom >= height - EDGE_SLACK_PX) {
              bottom = Math.max(bottom, Math.ceil(height - rect.top) + GOOGLE_ANCHOR_TAB_ALLOWANCE_PX);
            } else if (rect.top <= EDGE_SLACK_PX) {
              top = Math.max(top, Math.ceil(rect.bottom) + GOOGLE_ANCHOR_TAB_ALLOWANCE_PX);
            }
          }
          break;
        }
        el = el.parentElement;
      }
    }
    const key = `${top}:${bottom}`;
    if (key === last) return;
    last = key;
    onChange({ top, bottom });
  };
  const observer = new MutationObserver(scan);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-anchor-status'] });
  view.addEventListener('resize', scan);
  scan();
  return () => { observer.disconnect(); view.removeEventListener('resize', scan); };
}
