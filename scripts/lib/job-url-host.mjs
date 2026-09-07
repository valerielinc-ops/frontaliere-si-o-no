/**
 * Hostname of a job URL — single source of truth for the host-based checks
 * that decide which crawler owns a row.
 *
 * `new URL()` is the right parser for this (it is the only way to keep the
 * host check EXACT, so `https://evil.com/med-ipersonal.ch` never claims
 * `med-ipersonal.ch` — the substring match #7474 removed), but it THROWS on a
 * scheme-less URL: `new URL('med-ipersonal.ch/jobs/1')` is a `TypeError`. Every
 * caller wrapped it in a `try/catch` returning `false`, so a row whose `url`
 * arrives without `https://` — a shape the aggregated dataset does carry —
 * was silently dropped by the keyless fallback of the owning parser (#7721),
 * exactly where the pre-#7570 `url.includes('med-ipersonal.ch')` used to catch
 * it.
 *
 * Normalizing the scheme BEFORE parsing keeps both properties: scheme-less
 * rows resolve to their real host, and the host stays whatever the authority
 * component says — a look-alike host in the PATH is still not this host.
 *
 * @param {string} rawUrl
 * @returns {string} lowercase hostname, or `''` when the URL cannot be parsed.
 */
export function jobUrlHost(rawUrl = '') {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return '';
  // Anything already carrying a scheme is parsed as-is: prepending `https://`
  // to `mailto:jobs@example.ch` would invent a host that was never there.
  //
  // The `(?!\d)` matters: `-` and `.` are legal scheme characters, so the bare
  // test also matched the scheme-LESS `med-ipersonal.ch:8080/jobs/1`, which
  // `new URL()` then read as the protocol `med-ipersonal.ch:` with an empty
  // hostname — the same silent drop of a publishable row (#7721) this helper
  // exists to close, just in the form that carries a port. No scheme is ever
  // followed by a digit, while a scheme-less authority with a port always is.
  const candidate = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)
    ? raw
    : `https://${raw.replace(/^\/+/, '')}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}
