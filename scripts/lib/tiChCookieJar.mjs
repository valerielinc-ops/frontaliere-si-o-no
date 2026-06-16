/**
 * Shared F5 BIG-IP session cookie jar for www4.ti.ch fetches.
 *
 * The F5 BIG-IP ASM in front of www4.ti.ch sets session cookies (dtCookie,
 * BIGipServer*, TS*) on the first response. Subsequent requests from the same IP
 * without those cookies get 403. This jar collects them from each response and
 * resends them on the next fetch, exactly as a browser would — restoring session
 * continuity across all feed fetches.
 *
 * The jar is module-level and therefore shared per-process: every importer in the
 * same Node process accumulates into and reads from the same Map, identical to the
 * previous inline copies that each held their own per-process Map.
 */

const tiChCookieJar = new Map();

/**
 * Build a `Cookie` request-header value from the current jar contents.
 * @returns {string|undefined} `name=value; name2=value2` or undefined when empty.
 */
function buildCookieHeader() {
  if (tiChCookieJar.size === 0) return undefined;
  return [...tiChCookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Absorb every Set-Cookie header from a fetch Response into the shared jar.
 * @param {Response} response
 */
function updateCookieJar(response) {
  // getSetCookie() returns each Set-Cookie header as a separate string (Node 20+).
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(';');
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) {
      tiChCookieJar.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
    }
  }
}

export { tiChCookieJar, buildCookieHeader, updateCookieJar };
