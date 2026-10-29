/** Keep email credentials out of telemetry while retaining campaign attribution.
 * Self-contained so the static bootstraps can embed the same implementation.
 */
/** @template {Record<string, any>} T
 * @param {T} properties
 * @returns {T}
 */
export function sanitizeTelemetryProperties(properties) {
 const sensitive = /^(?:ac|at|authToken|ne|newsletter_email|email|newsletter_autologin|subscriber_key|token|access_token|id_token|refresh_token|oobCode)$/i;
 /** @param {string} value @param {number} [depth] @returns {string} */
 const cleanUrl = (value, depth = 0) => {
  if (depth > 3) return value.split(/[?#]/, 1)[0];
  if (!value.includes('?') && !value.includes('#')) return value;
  try {
   const absolute = /^https?:\/\//i.test(value);
   const queryOnly = value.startsWith('?');
   const hashOnly = value.startsWith('#');
   const url = new URL(value, 'https://telemetry.invalid/');
   let changed = Boolean(url.username || url.password);
   /** @param {URLSearchParams} params */
   const cleanParams = (params) => {
    let updated = false;
    for (const key of [...params.keys()]) {
     if (sensitive.test(key)) { params.delete(key); updated = true; }
     else {
      const values = params.getAll(key);
      const cleaned = values.map((entry) => /^(?:https?:\/\/|\/|\?|#)/i.test(entry) ? cleanUrl(entry, depth + 1) : entry);
      if (cleaned.some((entry, index) => entry !== values[index])) {
       updated = true;
       params.delete(key);
       cleaned.forEach((entry) => params.append(key, entry));
      }
     }
    }
    return updated;
   };
   changed = cleanParams(url.searchParams) || changed;
   if (url.hash.includes('?')) {
    const cleanedHash = '#' + cleanUrl(url.hash.slice(1), depth + 1);
    if (cleanedHash !== url.hash) { url.hash = cleanedHash; changed = true; }
   } else if (url.hash.includes('=')) {
    const hash = new URLSearchParams(url.hash.slice(1));
    changed = cleanParams(hash) || changed;
    url.hash = hash.toString();
   }
   url.username = '';
   url.password = '';
   if (!changed) return value;
   return absolute ? url.toString() : hashOnly ? url.hash : queryOnly ? url.search + url.hash : url.pathname + url.search + url.hash;
  } catch {
   // A malformed URL cannot provide useful attribution. Do not forward its query.
   return value.split(/[?#]/, 1)[0];
  }
 };
 /** @param {any} value @param {string} key @returns {any} */
 const clean = (value, key) => {
  if (typeof value === 'string' && (/^(?:https?:\/\/|\/|\?|#)/i.test(value) || /(?:url|path|location|referrer)$/i.test(key))) return cleanUrl(value);
  if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
  if (value && Object.prototype.toString.call(value) === '[object Object]') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, clean(entry, name)]));
  return value;
 };
 return clean(properties, '');
}
