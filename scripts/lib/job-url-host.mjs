/**
 * Punycode a host with the platform URL parser. This module is imported by
 * both Node-side crawlers and the browser build through jobDataNormalization;
 * `node:url` cannot be bundled for the latter because Vite externalizes it
 * without exporting `domainToASCII`.
 */
function domainToASCII(rawHost) {
  // `new URL()` accepts an authority prefix and silently treats the rest as
  // userinfo, a port, or a path. Reject authority delimiters before parsing so
  // a different raw identity cannot become a trusted hostname by truncation.
  const authorityDelimiter = /[/\\?#@:\s]/;
  const encodedAuthorityDelimiter = /%(?:2f|5c|3f|23|40|3a)/i;
  let candidate = rawHost;
  for (let decodePass = 0; decodePass < 2; decodePass += 1) {
    if (authorityDelimiter.test(candidate) || encodedAuthorityDelimiter.test(candidate)) return '';
    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      break;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  if (authorityDelimiter.test(candidate) || encodedAuthorityDelimiter.test(candidate)) return '';
  try {
    return new URL(`https://${rawHost}`).hostname;
  } catch {
    return '';
  }
}

/**
 * Canonical ASCII form of a host — the ONE spelling every host comparison in
 * this repo must be on.
 *
 * `new URL()` punycodes the authority: a URL written with an IDN host arrives
 * downstream as `xn--…`, while every check that consumes it compares against a
 * host taken from somewhere else — a source constant (`KOMAX_COMPANY_DOMAIN`,
 * `TRUSTED_HOSTS`), or a host scraped as raw TEXT out of a slice file, which
 * is still in its unicode spelling. Two spellings of the same front door then
 * never compare equal and the match goes mute: the row is not claimed by the
 * crawler that owns it, which is the same silent drop as #7721/#7758, only one
 * layer up. Putting both sides through this function makes the two spellings
 * one key.
 *
 * The browser-compatible `domainToASCII()` shim rejects authority delimiters
 * before parsing instead of letting `new URL()` truncate a raw host identity
 * into another hostname. That is a REJECTION of a host identity, not a
 * canonical form, so the lowercased input is kept instead — a comparison that
 * stays on the raw spelling cannot collide with the trusted truncated host,
 * while `''` would make two unrelated unmappable hosts compare EQUAL.
 *
 * @param {string} rawHost
 * @returns {string} lowercase punycoded host, or the lowercased input.
 */
export function canonicalJobHost(rawHost = '') {
  const host = String(rawHost ?? '')
    .trim()
    .toLowerCase()
    // A fully qualified host may carry a root label; `example.ch.` and
    // `example.ch` are the same name and must not be two keys.
    .replace(/\.$/, '');
  if (!host) return '';
  return domainToASCII(host) || host;
}

/**
 * A dotted registrable name, the authority shape `absoluteJobUrl()` accepts.
 *
 * The label class is deliberately NOT `[a-z0-9-]`: an IDN host is written in
 * its unicode spelling long before `new URL()` gets to punycode it, so an
 * ASCII-only class left the scheme-less `zürich-spital.ch/stelle/1` looking
 * like a bare path, returned it untouched, and `jobUrlHost()` answered `''` —
 * the row dropped for its alphabet, the exact silent drop #7758 closed for its
 * missing scheme. Non-ASCII is admitted here only as a CANDIDATE: the
 * `new URL()` round-trip below is what accepts or rejects it, so a name that
 * is not a mappable IDN still falls back to the untouched input.
 */
const AUTHORITY_CHAR = '[\\p{L}\\p{N}\\p{M}-]';
const AUTHORITY_NAME_SOURCE = `[\\p{L}\\p{N}]${AUTHORITY_CHAR}*(?:\\.${AUTHORITY_CHAR}+)+`;

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
 * Conservative by construction: the prepend applies only when the input
 * really starts with an AUTHORITY (a dotted registrable name, optionally with
 * a port, or a protocol-relative `//host/…`), so an input this helper cannot
 * make absolute is returned untouched instead of being turned into an
 * invented `https://` URL. "The result parses" is not a guard on its own:
 * `https://${anything-without-spaces}` always parses, which would turn the
 * root-relative `/en/jobs/123` into the host `en` and the bare path `jobs/1`
 * into the host `jobs` — strings this PR now PERSISTS as the apply CTA (and
 * as `url` of the `JobPosting` JSON-LD) and FETCHES for the liveness probe.
 * A confident URL to a host that does not exist is worse than the scheme-less
 * form: it never resolves, and `fetch()` on it lands in the fail-open
 * `network-error` branch — the "still alive" verdict about our own string
 * that this helper exists to remove. The same parsers that emit a raw
 * `med-ipersonal.ch/jobs/1` emit a raw `/jobs/1`.
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
  const portAuthority = new RegExp(`^${AUTHORITY_NAME_SOURCE}:\\d{1,5}(?:[/?#]|$)`, 'iu').test(raw);
  if (!portAuthority && /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  // A single leading slash is a root-relative PATH, never an authority:
  // `/careers.html` is host-shaped only by accident of the dot. Only the
  // protocol-relative `//host/x` puts an authority after the slashes.
  const protocolRelative = raw.startsWith('//');
  if (raw.startsWith('/') && !protocolRelative) return raw;
  const authority = protocolRelative ? raw.slice(2) : raw;
  // Same authority shape as `portAuthority` above: a dotted registrable name,
  // an optional port, then end-of-string or a path/query/fragment.
  if (!new RegExp(`^${AUTHORITY_NAME_SOURCE}(?::\\d{1,5})?(?=[/?#]|$)`, 'iu').test(authority)) return raw;
  const candidate = `https://${authority}`;
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
    return canonicalJobHost(new URL(candidate).hostname);
  } catch {
    return '';
  }
}
