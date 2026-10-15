/**
 * Surface attribution carried through the LinkedIn OAuth round trip.
 *
 * The browser parks `{ page, cta, component, routeFamily }` before leaving for
 * LinkedIn and forwards it with the authorization code; the callback runs on
 * /auth/linkedin/callback (or `/` when the SPA restoration fails), so without
 * this the subscriber row only ever saw the callback page.
 *
 * Everything here is untrusted client input: the page must be a same-origin
 * pathname (no scheme, no `//host`, no backslash, no query) and the ids use a
 * strict charset. The helper only ever writes the last-touch fields; the
 * first-touch `source` / `source_channel` are never part of its output.
 */

const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const FORBIDDEN_PATH_CHARS_RE = /[\u0000-\u001f\u007f\\]/;

/** Same-origin pathname (query and fragment dropped), or null. */
export function sanitizeSignupPath(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.length > 512 || FORBIDDEN_PATH_CHARS_RE.test(value)) return null;
  const pathname = value.split(/[?#]/)[0];
  return pathname || null;
}

function sanitizeToken(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return TOKEN_RE.test(value) ? value : null;
}

/**
 * @param {unknown} raw - `req.body.attribution`
 * @returns {{ page: string|null, cta: string|null, component: string|null, routeFamily: string|null } | null}
 */
export function sanitizeSignupAttribution(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const attribution = {
    page: sanitizeSignupPath(raw.page),
    cta: sanitizeToken(raw.cta),
    component: sanitizeToken(raw.component),
    routeFamily: sanitizeToken(raw.routeFamily),
  };
  if (!attribution.page && !attribution.cta && !attribution.component) return null;
  return attribution;
}

const FIELD_MAP = [
  ['page', 'source_page'],
  ['cta', 'source_cta'],
  ['component', 'source_component'],
  ['routeFamily', 'source_route_family'],
];

/**
 * Subscriber fields to merge for a LinkedIn login.
 *
 * A login started by a surface (cta or component present) is a real touch and
 * overwrites the last-touch fields. A generic login (page only) fills what the
 * row lacks and never erases an earlier box attribution.
 *
 * @param {unknown} rawAttribution
 * @param {Record<string, unknown> | null | undefined} existing - current row, null when missing
 * @returns {Record<string, string>}
 */
export function buildSignupAttributionFields(rawAttribution, existing) {
  const attribution = sanitizeSignupAttribution(rawAttribution);
  if (!attribution) return {};
  const explicitSurface = Boolean(attribution.cta || attribution.component);
  const fields = {};
  for (const [key, field] of FIELD_MAP) {
    const value = attribution[key];
    if (!value) continue;
    const current = existing && typeof existing[field] === 'string' ? existing[field].trim() : '';
    if (explicitSurface || !current) fields[field] = value;
  }
  return fields;
}
