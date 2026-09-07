/**
 * Absolute form of a job URL — the normalization `jobUrlHost()` performs
 * before parsing, exposed on its own so the SAME string can be persisted and
 * fetched, not just measured.
 *
 * A scheme-less row that now passes the host gate (#7721/#7758) is still
 * scheme-less everywhere downstream: `fetch('med-ipersonal.ch/jobs/1')`
 * throws on the shape (a liveness verdict about the form, never about the
 * listing), and an `href="med-ipersonal.ch/jobs/1"` published on a job page
 * resolves RELATIVE to frontaliereticino.ch — an apply CTA that lands on a
 * 404 of our own site. Claiming the row without fixing its URL only moves the
 * silent drop one step further down the funnel.
 *
 * Conservative by construction: the prepend applies only when the result
 * actually parses, so an input this helper cannot make absolute is returned
 * untouched instead of being turned into an invented `https://` URL.
 *
 * @param {string} rawUrl
 * @returns {string} absolute URL when one can be derived, else the trimmed input.
 */
export function absoluteJobUrl(rawUrl = '') {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return '';
  // Anything already carrying a scheme is kept as-is: prepending `https://`
  // to `mailto:jobs@example.ch` would invent a host that was never there.
  //
  // `-` and `.` are legal scheme characters, so the bare scheme test also
  // matched the scheme-LESS `med-ipersonal.ch:8080/jobs/1`, which `new URL()`
  // then read as the protocol `med-ipersonal.ch:` with an empty hostname — the
  // same silent drop of a publishable row (#7721) this helper exists to close,
  // just in the form that carries a port. What tells the two apart is the
  // AUTHORITY shape, not a digit: a scheme-less host with a port is a dotted
  // registrable name followed by `:<port>` and then end-of-string or a
  // path/query/fragment. Negating a digit after the colon instead would
  // disarm the guard for real schemes whose OPAQUE part starts with one —
  // `mailto:24h@med-ipersonal.ch` would invent `med-ipersonal.ch` and
  // `tel:0041` would invent `tel`, exactly the host this comment forbids.
  const portAuthority = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+:\d{1,5}(?:[/?#]|$)/i.test(raw);
  if (!portAuthority && /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  const candidate = `https://${raw.replace(/^\/+/, '')}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return raw;
  }
}

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
  const candidate = absoluteJobUrl(rawUrl);
  if (!candidate) return '';
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}
