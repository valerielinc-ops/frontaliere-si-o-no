/**
 * requestForensics.js — attribution fields for consent-changing HTTP writes.
 *
 * Every unsubscribe endpoint (job alerts, newsletter, saved-jobs digest,
 * employer outreach) accepts a bare GET from an email link and flips consent
 * immediately. That is required — RFC 8058 one-click and plain footer links
 * both have to keep working, and a non-200 to a mail provider degrades sender
 * reputation — but until now the write recorded nothing about WHO made the
 * request, so a link prefetch by a corporate mail-security scanner was
 * indistinguishable from a deliberate human click.
 *
 * Measured on production 2026-08-10 over 845 deactivated alerts carrying a
 * timestamp: 73 (8.6%) were deactivated <60s after the delivery event and 143
 * (17%) within 5 minutes — the window automated link-fetchers land in — and 252
 * of those 845 subscribers registered an open AFTER their unsubscribe. Neither
 * is proof (opens are proxy-inflated, a fast human click exists); the point is
 * that today the stored data cannot answer the question at all.
 *
 * The three fields below make it answerable:
 *   - `unsubscribe_method` — RFC 8058 one-click is a POST, and Gmail's native
 *     Unsubscribe button POSTs while a scanner GETs, so the verb alone is the
 *     highest-signal discriminator available.
 *   - `unsubscribe_user_agent` — truncated; scanners identify themselves far
 *     more often than they hide.
 *   - `unsubscribe_ip` — ANONYMIZED, never the raw address. See below.
 *
 * PRIVACY — why the IP is truncated before it is stored
 * ----------------------------------------------------
 * An IP address is personal data under GDPR Art. 4(1) and these are real users
 * in IT/CH. `AGENTS.md#privacy` governs what enters the repository, not what a
 * Cloud Function writes at runtime, so it does not decide this case by itself;
 * its posture (PII scan on every diff, never hard-code a personal address,
 * ask when a string is doubtful) is unambiguous about which way to resolve the
 * ambiguity. So the raw address is never persisted: `anonymizeIp` zeroes the
 * last IPv4 octet (/24) and keeps only the first three IPv6 hextets (/48) —
 * the same truncation analytics vendors document as IP anonymization. That is
 * enough for the forensic question actually being asked (datacenter vs.
 * residential range, "same network as the delivery scanner") and is not enough
 * to single out a household. There is no code path here that stores a full IP.
 *
 * The capture can never fail the unsubscribe: every export swallows its own
 * errors and degrades to fewer fields (or none), never throws.
 */

const MAX_USER_AGENT_CHARS = 256;
const MAX_METHOD_CHARS = 8;

/** Fields this module owns. Nothing else is ever copied onto a Firestore write. */
export const FORENSIC_FIELDS = Object.freeze([
  'unsubscribe_method',
  'unsubscribe_user_agent',
  'unsubscribe_ip',
]);

/**
 * @param {unknown} ua
 * @returns {string|null} trimmed + length-capped UA, or null when absent/blank.
 */
export function truncateUserAgent(ua) {
  if (typeof ua !== 'string') return null;
  const trimmed = ua.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_USER_AGENT_CHARS);
}

/**
 * First candidate client IP from the proxy chain, unvalidated and un-anonymized.
 *
 * Order matters: these endpoints sit behind the Cloudflare Worker
 * (infra/cloudflare-worker/locale-router.js) which sets `cf-connecting-ip`, and
 * that header is the only one an external caller cannot forge. The leftmost
 * `x-forwarded-for` hop IS caller-controllable — it is kept as a fallback
 * because a spoofed value is still a forensic signal, but it is never treated
 * as proof of anything.
 *
 * @param {{ get?: (h: string) => string|undefined, headers?: Record<string, unknown>, ip?: string }} req
 * @returns {string|null}
 */
export function extractClientIp(req) {
  try {
    const header = (name) => {
      if (req && typeof req.get === 'function') {
        const viaGetter = req.get(name);
        if (typeof viaGetter === 'string' && viaGetter) return viaGetter;
      }
      const raw = req?.headers?.[name];
      if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
      return typeof raw === 'string' ? raw : '';
    };

    const cf = header('cf-connecting-ip').trim();
    if (cf) return cf;

    const forwarded = header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }

    const real = header('x-real-ip').trim();
    if (real) return real;

    const direct = typeof req?.ip === 'string' ? req.ip.trim() : '';
    return direct || null;
  } catch {
    return null;
  }
}

function anonymizeIpv4(ip) {
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
}

/** Expand `::` shorthand into exactly 8 hextets; null when malformed. */
function expandIpv6(ip) {
  if (ip.includes('::')) {
    const halves = ip.split('::');
    if (halves.length !== 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill('0'), ...tail];
  }
  const parts = ip.split(':');
  return parts.length === 8 ? parts : null;
}

/**
 * Truncate an address so it can be stored: IPv4 → /24 (last octet zeroed),
 * IPv6 → /48 (first three hextets). Anything unparseable yields null rather
 * than a half-anonymized string.
 *
 * @param {string|null|undefined} ip
 * @returns {string|null}
 */
export function anonymizeIp(ip) {
  try {
    if (typeof ip !== 'string') return null;
    let candidate = ip.trim().toLowerCase();
    if (!candidate) return null;

    // `[2001:db8::1]:443` — bracketed IPv6 with a port.
    const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) candidate = bracketed[1];

    // IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is an IPv4 address in disguise.
    const mapped = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) candidate = mapped[1];

    // `203.0.113.7:51514` — IPv4 with a source port (some proxies append one).
    const withPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (withPort) candidate = withPort[1];

    if (candidate.includes('.') && !candidate.includes(':')) return anonymizeIpv4(candidate);

    if (candidate.includes(':')) {
      // Drop a zone index (`fe80::1%eth0`) before parsing.
      const zoneless = candidate.split('%')[0];
      const hextets = expandIpv6(zoneless);
      if (!hextets) return null;
      for (const hextet of hextets) {
        if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
      }
      return `${hextets[0]}:${hextets[1]}:${hextets[2]}::`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build the forensics payload for one unsubscribe request. Never throws: a
 * failure anywhere in here degrades to fewer fields (or `{}`), because the
 * unsubscribe itself must succeed regardless.
 *
 * @param {object} req Express-style request (Cloud Functions onRequest).
 * @returns {{ unsubscribe_method?: string, unsubscribe_user_agent?: string, unsubscribe_ip?: string }}
 */
export function buildUnsubscribeForensics(req) {
  const forensics = {};
  try {
    const method = String(req?.method || '').trim().toUpperCase();
    forensics.unsubscribe_method = (method || 'GET').slice(0, MAX_METHOD_CHARS);
  } catch {
    return {};
  }
  try {
    const ua = typeof req?.get === 'function' ? req.get('user-agent') : req?.headers?.['user-agent'];
    const truncated = truncateUserAgent(ua);
    if (truncated) forensics.unsubscribe_user_agent = truncated;
  } catch { /* missing/hostile UA header — method alone is still worth storing */ }
  try {
    const anonymized = anonymizeIp(extractClientIp(req));
    if (anonymized) forensics.unsubscribe_ip = anonymized;
  } catch { /* unparseable proxy chain — drop the field, keep the rest */ }
  return forensics;
}

/**
 * Allowlist-copy forensics onto a Firestore write payload. Callers spread the
 * result, so a hostile/partial input can only ever contribute known string
 * fields — and a throwing getter yields `{}` instead of propagating out and
 * failing the unsubscribe.
 *
 * @param {unknown} forensics
 * @returns {Record<string, string>}
 */
export function forensicsFields(forensics) {
  try {
    if (!forensics || typeof forensics !== 'object') return {};
    const out = {};
    for (const key of FORENSIC_FIELDS) {
      const value = forensics[key];
      if (typeof value === 'string' && value) {
        out[key] = value.slice(0, MAX_USER_AGENT_CHARS);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The same stamp, for the OTHER end of the relationship: the moment somebody
 * subscribes (#5676).
 *
 * Until now this module only recorded the IP of people LEAVING. Measured
 * 2026-08-12 over 8.605 `newsletter_subscribers` documents: `unsubscribe_ip`
 * on 28, and no IP field at all on the other 8.577 — we knew the network of
 * everyone who left and of nobody who arrived, which is the inverse of what
 * art. 25 nLPD asks for (date, time, IP, form URL).
 *
 * WHY THIS LIVES IN A CLOUD FUNCTION AND NOT IN THE CLIENT WRITE
 * -------------------------------------------------------------
 * `newsletter_subscribers` documents are written straight from the browser
 * (services/newsletterSubscribers.ts), and a browser cannot see its own public
 * address. It could be told — an edge endpoint echoing the IP back — but then
 * the value on the document would be one the SUBSCRIBER supplied, which is
 * worthless as proof of anything precisely when it matters. Every genuinely
 * new subscriber already reaches a Cloud Function on the way out of signup
 * (`newsletterSendConfirmation` for double opt-in, `newsletterSendWelcome` for
 * the ~82% that are pre-confirmed), and there `cf-connecting-ip` is set by our
 * own Worker and is not forgeable from outside. So the stamp is server-side,
 * costs no extra round trip, and reuses the truncation already proven here.
 *
 * TRUNCATED, for the reasons argued at the top of this file, and one more that
 * is specific to consent: a full address kept for years against a possible
 * future dispute is more retention than the dispute needs. /24 still answers
 * "was this a residential Italian line or a datacenter range?" — which is the
 * question a contested subscription actually turns on — while not singling out
 * a household. Choosing the weaker-but-smaller datum is only defensible because
 * the alternative on the table was, and is, nothing at all.
 *
 * @param {object} req Express-style request (Cloud Functions onRequest).
 * @param {string} nowIso Timestamp to record alongside it.
 * @returns {{ consent_ip: string, consent_ip_recorded_at: string }|null}
 */
export function buildConsentIpStamp(req, nowIso) {
  try {
    const anonymized = anonymizeIp(extractClientIp(req));
    if (!anonymized) return null;
    return {
      consent_ip: anonymized,
      consent_ip_recorded_at: typeof nowIso === 'string' && nowIso
        ? nowIso
        : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
