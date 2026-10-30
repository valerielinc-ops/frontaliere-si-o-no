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
   // URL cleanup alone cannot authorize loading: an old iframe/src or JSON-LD
   // URL can still expose the signed URL. Inspect live, decoded URL fields without
   // rewriting it, and retain the initial-origin fact for every later retry.
   if (typeof doc?.querySelectorAll !== 'function') return deny();
   /** @param {string} value */
   const unchanged = (value) => sanitize({ page_location: value }).page_location === value;
   /** @param {any} value @param {string} [key] @returns {boolean} */
   const structuredUrlsClean = (value, key = '') => {
    if (Array.isArray(value)) return value.every((entry) => structuredUrlsClean(entry, key));
    if (value && typeof value === 'object') return Object.entries(value).every(([name, entry]) => structuredUrlsClean(entry, name));
    if (typeof value !== 'string') return true;
    const urlField = /^(?:@id|sameAs|image|logo|mainEntityOfPage|isBasedOn|license|target|item|hasMap)$/i.test(key) || /(?:url|uri|href|src)$/i.test(key);
    return !(urlField || /^(?:https?:|\/\/)[^\s]*$/i.test(value)) || unchanged(value);
   };
   for (const element of doc.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
     // Attribute semantics identify URL inputs. CSS, JavaScript and ordinary
     // prose can contain #/?/% syntax but are not whole URL references.
     if (/^(?:href|src|action|formaction|poster|data|cite|background|longdesc|manifest|xlink:href)$/i.test(attribute.name) || /(?:^|[-_:])(?:url|href|src)$/i.test(attribute.name)) {
      if (!unchanged(attribute.value)) return deny();
     }
    }
    if (element.tagName === 'SCRIPT' && element.getAttribute('type') === 'application/ld+json') {
     const data = JSON.parse(element.textContent || '');
     if (!structuredUrlsClean(data)) return deny();
    }
   }
   return false;
  }
 } catch { /* An unreadable context must not authorize an autonomous SDK. */ }
 return deny();
}
