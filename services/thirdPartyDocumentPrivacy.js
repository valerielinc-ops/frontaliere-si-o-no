/** Keep autonomous advertising/affiliate SDKs off credential-bearing documents.
 * Self-contained so static producers embed exactly the same sticky guard.
 * The canonical sanitizer is supplied by each caller, without changing it.
 * @param {(properties: Record<string, any>) => Record<string, any>} sanitize
 * @param {Window & { __FT_SENSITIVE_DOCUMENT__?: boolean }} win
 * @param {{ referrer?: string } | undefined} doc
 * @param {boolean} [attempted]
 * @returns {boolean}
 */
export function isSensitiveThirdPartyDocument(sanitize, win, doc, attempted = false) {
 if (!win) return false;
 if (win.__FT_SENSITIVE_DOCUMENT__ || attempted) {
  win.__FT_SENSITIVE_DOCUMENT__ = true;
  return true;
 }
 try {
  const context = { page_location: win.location.href, page_referrer: doc?.referrer || '' };
  const safe = sanitize(context);
  if (context.page_location === safe.page_location && context.page_referrer === safe.page_referrer) return false;
 } catch { /* An unreadable context must not authorize an autonomous SDK. */ }
 win.__FT_SENSITIVE_DOCUMENT__ = true;
 return true;
}
