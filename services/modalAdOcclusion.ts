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
