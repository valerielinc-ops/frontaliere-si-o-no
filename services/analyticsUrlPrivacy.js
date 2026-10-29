/** Keep email credentials out of telemetry while retaining campaign attribution.
 * Self-contained so the static bootstraps can embed the same implementation.
 */
/** @template {Record<string, any>} T
 * @param {T} properties
 * @returns {T}
 */
export function sanitizeTelemetryProperties(properties) {
 const sensitive = /^(?:ac|at|authToken|ne|newsletter_email|email|newsletter_autologin|subscriber_key|token|access_token|id_token|refresh_token|oobCode)$/i;
 // WHATWG URL parsing strips ASCII tabs/newlines and surrounding C0/space.
 /** @param {string} value */
 const normalizeReference = (value) => value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
 /** @param {string} value */
 const looksLikeUrl = (value) => /^(?:https?:|[\\/]|\.{1,2}[\\/]|[?#])/i.test(normalizeReference(value));
 const urlField = /(?:url|path|location|referrer|href|src)$/i;
 /** @param {string} value @param {number} [depth] @returns {string} */
 const cleanUrl = (value, depth = 0) => {
  try {
   const reference = normalizeReference(value);
   const absolute = /^[a-z][a-z0-9+.-]*:/i.test(reference);
   const protocolRelative = /^[\\/]{2}/.test(reference);
   const queryOnly = reference.startsWith('?');
   const hashOnly = reference.startsWith('#');
   const url = absolute ? new URL(reference) : new URL(reference, 'https://telemetry.invalid/');
   let changed = Boolean(url.username || url.password);
   /** @param {URLSearchParams} params */
   const cleanParams = (params) => {
    let updated = false;
    for (const key of [...params.keys()]) {
     if (sensitive.test(key)) { params.delete(key); updated = true; }
     else {
      const values = params.getAll(key);
      const cleaned = values.map((entry) => (looksLikeUrl(entry) || urlField.test(key)) ? cleanUrl(entry, depth + 1) : entry);
      if (cleaned.some((entry, index) => entry !== values[index])) {
       updated = true;
       params.delete(key);
       cleaned.forEach((entry) => params.append(key, entry));
      }
     }
    }
    return updated;
   };
   if (depth > 3) {
    // Beyond the URL nesting budget, omit query and fragment data.
    changed = Boolean(url.search || url.hash) || changed;
    url.search = '';
    url.hash = '';
   } else {
    changed = cleanParams(url.searchParams) || changed;
    if (url.hash.includes('?')) {
     const cleanedHash = '#' + cleanUrl(url.hash.slice(1), depth + 1);
     if (cleanedHash !== url.hash) { url.hash = cleanedHash; changed = true; }
    } else if (url.hash.includes('=')) {
     const hash = new URLSearchParams(url.hash.slice(1));
     changed = cleanParams(hash) || changed;
     url.hash = hash.toString();
    }
   }
   url.username = '';
   url.password = '';
   if (!changed) return value;
   if (absolute) return url.toString();
   if (protocolRelative) return '//' + url.host + url.pathname + url.search + url.hash;
   if (hashOnly) return url.hash;
   if (queryOnly) return url.search + url.hash;
   return reference.split(/[?#]/, 1)[0] + url.search + url.hash;
  } catch {
   // A malformed URL may carry userinfo too: drop it rather than forward credentials.
   return '';
  }
 };
 /** @param {any} value @param {string} key @returns {any} */
 const clean = (value, key) => {
  if (typeof value === 'string' && (looksLikeUrl(value) || urlField.test(key))) return cleanUrl(value);
  if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
  if (value && Object.prototype.toString.call(value) === '[object Object]') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, clean(entry, name)]));
  return value;
 };
 return clean(properties, '');
}
