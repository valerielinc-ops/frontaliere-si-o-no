/** Keep autonomous advertising/affiliate SDKs off credential-bearing contexts.
 * Self-contained so static producers embed exactly the same initial capture
 * and permit later initialization only after the exposed context is clean.
 * The canonical sanitizer is supplied by each caller, without changing it.
 * @param {(properties: Record<string, any>) => Record<string, any>} sanitize
 * @param {Window & { __FT_SENSITIVE_DOCUMENT__?: boolean }} win
 * @param {{ referrer?: string, querySelectorAll?: Document['querySelectorAll'], documentElement?: Element } | undefined} doc
 * @param {boolean} [attempted]
 * @param {() => void} [retry] Re-enter a static producer after cleanup/SPA changes.
 * @returns {boolean}
 */
export function isSensitiveThirdPartyDocument(sanitize, win, doc, attempted = false, retry) {
 if (!win) return false;
 const deny = () => {
  win.__FT_SENSITIVE_DOCUMENT__ = true;
  try {
   if (retry && doc?.documentElement && typeof win.MutationObserver === 'function') {
   const changed = () => {
    if (isSensitiveThirdPartyDocument(sanitize, win, doc)) return;
    observer.disconnect();
    win.removeEventListener('popstate', changed);
    retry();
   };
   const observer = new win.MutationObserver(changed);
   observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
   win.addEventListener('popstate', changed);
   }
  } catch { /* An unreadable DOM stays denied; a later SPA mount can retry. */ }
  return true;
 };
 if (attempted) win.__FT_SENSITIVE_DOCUMENT__ = true;
 try {
  const context = { page_location: win.location.href, page_referrer: doc?.referrer || '' };
  const safe = sanitize(context);
  if (context.page_location === safe.page_location && context.page_referrer === safe.page_referrer) {
   if (!win.__FT_SENSITIVE_DOCUMENT__) return false;
   // URL cleanup alone cannot authorize loading: an old iframe/src or JSON-LD
   // URL can still expose the signed URL. Inspect the live, decoded DOM without
   // rewriting it, and retain the initial-origin fact for every later retry.
   if (typeof doc?.querySelectorAll !== 'function') return deny();
   /** @param {string} value */
   const unchanged = (value) => sanitize({ page_location: value }).page_location === value;
   for (const element of doc.querySelectorAll('*')) {
    for (const attribute of element.attributes) if (!unchanged(attribute.value)) return deny();
    for (const node of element.childNodes) {
     if ((node.nodeType === 3 || node.nodeType === 4) && !unchanged(node.textContent || '')) return deny();
    }
    if (element.tagName === 'SCRIPT' && element.getAttribute('type') === 'application/ld+json') {
     const data = JSON.parse(element.textContent || '');
     if (JSON.stringify(data) !== JSON.stringify(sanitize(data))) return deny();
    }
   }
   return false;
  }
 } catch { /* An unreadable context must not authorize an autonomous SDK. */ }
 return deny();
}
