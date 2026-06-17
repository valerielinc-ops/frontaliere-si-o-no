// Email finder for employer outreach.
//
// Empirically (research 2026-06-17): scraping company contact/impressum pages
// yields real DEPARTMENT/role emails (info@, hr@, lugano@…), while person-level
// emails are rarely exposed. The decisive noise filter is to keep ONLY emails on
// the company's own domain — that drops all the third-party tracker/JS/CSS junk
// (gstatic, squarespace, jquery.min.js…) that a naive regex picks up.
//
// Pure helpers (unit-tested); the network/DNS parts live in the calling script.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Non-global, anchored copy for validation — `.test()` on the /g regex above is
// stateful (advances lastIndex) and would drop valid emails intermittently.
const EMAIL_ONE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const BAD_LOCAL = /\.(css|js|jpe?g|png|webp|gif|svg|min|html?)$|^[0-9a-f]{8,}$/i;

/** Registrable domain (last 2 labels) from a URL or hostname. */
export function apexDomain(input) {
  let host = String(input || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(host)) host = new URL(host).hostname; } catch { /* keep raw */ }
  host = host.replace(/^www\./, '').replace(/\/.*$/, '');
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/** Cloudflare email-protection decoder (data-cfemail="hex"). */
export function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out.toLowerCase();
  } catch { return ''; }
}

const onDomain = (email, domain) => {
  const d = String(email).split('@')[1] || '';
  return d === domain || d.endsWith('.' + domain);
};

/**
 * Extract emails belonging to `companyDomain` (apex or subdomain) from HTML.
 * Decodes mailto:, Cloudflare cf-email, and HTML-entity addresses. The domain
 * filter is what removes third-party/code noise.
 */
export function extractCompanyEmails(html, companyDomain) {
  if (!html || !companyDomain) return [];
  const found = new Set();
  const add = (e) => {
    const email = String(e || '').toLowerCase().replace(/^mailto:/, '').replace(/[?#].*$/, '').trim();
    const local = email.split('@')[0] || '';
    if (EMAIL_ONE.test(email) && onDomain(email, companyDomain) && !BAD_LOCAL.test(local) && email.length < 60) found.add(email);
  };
  for (const m of (html.match(EMAIL_RE) || [])) add(m);
  for (const m of (html.match(/mailto:[^"'?>\s]+/gi) || [])) add(m);
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) { const e = decodeCfEmail(m[1]); if (e) add(e); }
  // HTML-entity-encoded "@" / "."
  const ent = html.replace(/&#0*64;|&commat;/gi, '@').replace(/&#0*46;|&period;/gi, '.');
  for (const m of (ent.match(EMAIL_RE) || [])) add(m);
  return [...found];
}

const ROLE_HR = /^(hr|risorse[-.]?umane|lavoro|lavora|candidatur|recruit|recruiting|recruitment|jobs?|career|careers|bewerbung|personal|personale|talent)/i;
const ROLE_CITY = /^(lugano|locarno|bellinzona|mendrisio|chiasso|ticino|geneve|lausanne|zurich|basel|bern)/i;
const ROLE_GENERAL = /^(info|contact|contatt|kontakt|hello|hallo|mail|segreteria|amministrazione|office|reception)/i;
const ROLE_LOW = /^(privacy|legal|dpo|gdpr|datenschutz|webmaster|postmaster|marketing|media|investors?|press|noreply|no-reply|abuse|sales|support)/i;

/** Outreach-usefulness score for an email's local part (higher = better target). */
export function scoreEmail(email) {
  const local = String(email).split('@')[0] || '';
  if (ROLE_LOW.test(local)) return 1;
  if (ROLE_HR.test(local)) return 10;
  if (ROLE_CITY.test(local)) return 7;
  if (ROLE_GENERAL.test(local)) return 5;
  return 3; // other on-domain (e.g. a named person, crm.admin)
}

/** Pick the best outreach email: highest score, ties → shortest local part. */
export function pickBestEmail(emails) {
  const list = [...new Set((emails || []).map((e) => String(e).toLowerCase()))];
  if (!list.length) return null;
  return list.sort((a, b) => {
    const s = scoreEmail(b) - scoreEmail(a);
    if (s) return s;
    return (a.split('@')[0].length) - (b.split('@')[0].length);
  })[0];
}

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, '').trim();

/**
 * Infer a PERSONAL email for `fullName` by learning the pattern from a found
 * on-domain person-email (e.g. mario.rossi@d → "{first}.{last}"). Returns null
 * if no person-pattern email is available. Flagged as inferred by the caller.
 */
export function inferPatternEmail(foundEmails, fullName, domain) {
  const name = stripAccents(fullName);
  const toks = name.split(/\s+/).filter(Boolean);
  if (toks.length < 2 || !domain) return null;
  const first = toks[0], last = toks[toks.length - 1];
  for (const email of (foundEmails || [])) {
    const [local, dom] = String(email).toLowerCase().split('@');
    if (!dom || (dom !== domain && !dom.endsWith('.' + domain))) continue;
    // Detect a two-token person pattern in the found local part. Order matters:
    // f.last (single-char first) is checked before first.last so "m.rossi" isn't
    // mis-read as first.last.
    if (/^[a-z]\.[a-z]{2,}$/.test(local)) return `${first[0]}.${last}@${domain}`;     // f.last
    if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return `${first}.${last}@${domain}`;    // first.last
    if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return `${first}_${last}@${domain}`;     // first_last
  }
  return null;
}
