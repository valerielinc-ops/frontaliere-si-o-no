/**
 * privateRequestParams.js — the one place a request's parameters are assembled,
 * and the one place the OUT-OF-URL transport for the sensitive ones is read
 * (#5746).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Cloud Run writes one `run.googleapis.com/requests` row per invocation, and
 * that row contains `httpRequest.requestUrl` — the full URL, query string
 * included. Nothing in this process emits it and nothing in this process can
 * suppress it: it is written by the infrastructure, beside our own logs, into
 * the `_Default` bucket, readable by anybody holding `logging.viewer`.
 *
 * So every call that carried `?email=…&token=…` deposited an ADDRESS and a
 * CREDENTIAL, appaired, in a place neither belongs. Measured over the seven days
 * to 2026-08-13: 3.131 requests across FOUR endpoints
 * (newsletterManageSubscription, jobAlertUnsubscribe, savedJobsDigestUnsubscribe,
 * outreachUnsubscribe), 995 distinct real addresses. #5719 gave `ac` a lifetime,
 * #5725 gave it a perimeter, #5726 separated the HMAC domains, #5724 added
 * structured lines that deliberately omit both — and two metres away the request
 * log wrote the pair verbatim for every call.
 *
 * ── Why a header, and not the body ──────────────────────────────────────────
 *
 * `httpRequest.requestUrl` is the URL. Neither the body nor the headers appear
 * in that row, so either would do — but the body is not available to every
 * caller here:
 *
 *  - the SPA (services/newsletterSubscribers.ts) CAN use the body, and does:
 *    it POSTs a JSON payload and leaves only `action`/`format` on the query.
 *    That is ~89% of the measured volume and it needs nothing from this module;
 *  - a link in an email is a GET performed by a mail client. A GET has no body,
 *    and the credential cannot move to the fragment either — these four
 *    endpoints answer with a rendered HTML page precisely so the exit works in a
 *    client that never runs JavaScript, and a fragment never reaches a server.
 *    The RFC 8058 one-click POST is worse still: RFC 8058 puts the identifiers
 *    in the URI and fixes the body to `List-Unsubscribe=One-Click`.
 *
 * What those links DO pass through is the Cloudflare Worker
 * (infra/cloudflare-worker/locale-router.js), which proxies /disiscrivi-* to
 * these functions. It strips the sensitive parameters off the upstream URL and
 * re-attaches them as PRIVATE_PARAMS_HEADER — same method, same body, same
 * response, and a request URL Cloud Run can log without harm. The header is the
 * only transport that survives a GET from a client with no JavaScript, which is
 * the most common way these links are followed.
 *
 * ── The header grants nothing ───────────────────────────────────────────────
 *
 * It is a TRANSPORT, not an authorisation: every value it carries is verified
 * exactly as before (HMAC over the address/alert/company, autologin grading,
 * the #5711 verb gate). A caller sending the header directly to the function
 * gains nothing it could not do by sending the same string on the query — which
 * is still accepted, and must be: the links in question live in mailboxes and
 * will keep arriving in their original shape for years.
 *
 * ── The acknowledgement header ──────────────────────────────────────────────
 *
 * The Worker and these functions are deployed by two different workflows
 * (deploy-worker.yml, deploy-cloud-functions.yml) that both fire on the same
 * push to main and finish minutes apart. In the window where the Worker already
 * strips and the function cannot yet read, every unsubscribe would answer "link
 * non valido" — the exact failure the LPD art. 25/32 complaint was about.
 *
 * So a function that UNDERSTOOD the header says so, on the response, and the
 * Worker only replays the legacy full-URL request when that acknowledgement is
 * absent. Deploy skew costs one extra upstream call and nothing else; once both
 * halves are live the replay can never fire again, so a genuinely invalid
 * credential is refused without its second, logged, legacy round trip.
 */

/** Request header carrying the parameters that must stay out of the URL. */
export const PRIVATE_PARAMS_HEADER = 'x-fte-private-params';

/**
 * Response header this module stamps when it actually read PRIVATE_PARAMS_HEADER.
 * The Worker's legacy replay is gated on its ABSENCE — see the module header.
 */
export const PRIVATE_PARAMS_ACK_HEADER = 'x-fte-private-params-read';

/**
 * Anything longer is not one of ours and is ignored whole. The real payload is
 * an address (≤254) plus a hex digest (64) plus parameter names; 2 KiB is an
 * order of magnitude of headroom, and the cap keeps a hostile header from
 * turning into a parse cost.
 */
export const PRIVATE_PARAMS_MAX_LENGTH = 2048;

/**
 * Read one header off either an Express-style req or a plain object.
 *
 * Case-insensitive on every path. Node lowercases the keys of `req.headers`
 * before Express ever sees them, so in production this is a no-op — but the
 * name travels as `X-Fte-Private-Params` on the wire, and a caller building a
 * request object by hand (a test, a future in-process invoker) would otherwise
 * miss the header and silently resolve a request with no address in it, which
 * looks exactly like a link somebody tampered with.
 */
function headerValue(req, name) {
  const wanted = String(name).toLowerCase();
  try {
    if (req && typeof req.get === 'function') {
      const viaGetter = req.get(wanted);
      if (typeof viaGetter === 'string') return viaGetter;
    }
    const headers = req?.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      const viaHeaders = headers.get(wanted);
      return typeof viaHeaders === 'string' ? viaHeaders : '';
    }
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === wanted) return typeof value === 'string' ? value : '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Parse PRIVATE_PARAMS_HEADER into a plain params object.
 *
 * The wire format is a query string — `URLSearchParams` on both sides — so the
 * Worker's `toString()` and this `URLSearchParams` are inverse by construction
 * and no ad-hoc escaping rule can drift between them.
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parsePrivateParams(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > PRIVATE_PARAMS_MAX_LENGTH) return {};
  const out = {};
  try {
    for (const [key, value] of new URLSearchParams(raw)) {
      if (key) out[key] = value;
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * Assemble the parameters for one request, from every source it may use.
 *
 * Precedence is deliberately UNCHANGED from the inline expression this replaces
 * (`req.method === 'GET' ? req.query : { ...req.query, ...req.body }`): the
 * header is merged UNDERNEATH both, so a request that carries nothing new
 * resolves byte-identically to the way it did before this module existed. There
 * is no collision in practice — the Worker deletes from the URL exactly what it
 * moves to the header — and where there could be one, the older, more public
 * source still wins.
 *
 * The body is only spread when it really is a plain object. Express hands back a
 * Buffer or a string for a body it could not parse, and spreading either turns
 * character offsets into parameter names; none of them is ever `email` or
 * `token`, so this changes no outcome, it just stops the merge from inventing
 * keys.
 *
 * @param {object} req Express-style request.
 * @param {object} [res] Express-style response; stamped with
 *   PRIVATE_PARAMS_ACK_HEADER when the header was present and usable. Optional
 *   so tests and future callers can resolve params without a response.
 * @returns {Record<string, any>}
 */
export function resolveRequestParams(req, res) {
  const privateParams = parsePrivateParams(headerValue(req, PRIVATE_PARAMS_HEADER));
  if (Object.keys(privateParams).length > 0 && res && typeof res.set === 'function') {
    // Never allowed to be the reason a request fails: this is an
    // interoperability marker, not part of the answer.
    try { res.set(PRIVATE_PARAMS_ACK_HEADER, '1'); } catch { /* no-op */ }
  }
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  const rawBody = req?.method === 'GET' ? null : req?.body;
  const body =
    rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && !ArrayBuffer.isView(rawBody)
      ? rawBody
      : {};
  return { ...privateParams, ...query, ...body };
}
