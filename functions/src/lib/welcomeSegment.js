/**
 * welcomeSegment.js — safety layer for the personalized post-signup welcome
 * email: decides which narrative segment a new subscriber falls into and
 * sanitizes every personalization slot pulled from the Firestore subscriber
 * doc before it can reach an email template.
 *
 * WHY THIS EXISTS: `job_company` / `sector_interest` / `location_interest`
 * are filled by `derivePersonalizationPatch`
 * (functions/src/lib/subscriberPersonalization.js) from free-text sources
 * (viewed-job snippets, filter usage, alert keywords) with no shape
 * validation at write time. Verified on production data, these fields
 * sometimes hold mid-sentence prose fragments (truncated German copy that
 * happened to be adjacent to a scraped company name in the DOM) instead of
 * a real value. If that reaches an email, thousands of subscribers get
 * garbage in their greeting.
 *
 * DESIGN PRINCIPLE — degrade, never guess: every sanitize* function returns
 * `null` the moment it can't be confident, and `resolveWelcomeContext` never
 * throws for ANY input. Callers render an alternate, generic sentence when a
 * slot is null; they must never print an empty/undefined slot into HTML.
 *
 * NAME-VALIDATION IMPORT DECISION: `scripts/lib/deriveNameFromEmail.mjs`
 * exports `recognizeFirstName`, and its own relative imports (`node:fs`,
 * `../../services/newsletter-template.mjs`) resolve based on ITS OWN file
 * location, so a relative import from here down into `scripts/lib/` would
 * actually resolve fine under local Node/vitest. It is NOT safe in
 * production, though: `firebase.json`'s `functions` entry has
 * `"source": "functions"` with no bundler and no `.gcloudignore` carve-out —
 * the Cloud Functions deploy uploads the `functions/` directory as-is, so
 * any import reaching outside it (like `../../../scripts/lib/...`) 404s at
 * runtime as "module not found" even though it passed every local test. See
 * `docs/AGENTS-HISTORY.md` shared-module pattern for functions/ (canonical
 * copy must live inside functions/, cross-tree code gets re-exported via a
 * shim, never the other way around). So safeFirstName() below is a fresh,
 * self-contained structural validator — deliberately NOT the dataset-backed
 * `recognizeFirstName` (which also has a different contract: it requires an
 * exact match against a ~19.9k open-source first-name list, whereas the
 * hazards here — company-suffix names, all-caps initials, digits/HTML in the
 * name — are shape problems a small set of structural rules already catches
 * without needing that dataset).
 */

export const WELCOME_SEGMENTS = ['job', 'salary', 'utility', 'publisher', 'general'];

export const SECTOR_KEYS = [
  'health',
  'admin',
  'retail',
  'hospitality',
  'logistics',
  'finance',
  'tech',
  'industry',
  'education',
  'construction',
  'transport',
  'cleaning',
  'other',
];

export const TOOL_KEYS = ['lamal', 'wizard', 'leadmagnet', 'selfcert', 'calculator', 'comparator'];

// ─── Shared structural guards (company / location free-text hazards) ──────

// Reject values that don't start with a letter or digit — catches prose
// fragments truncated mid-sentence ("). Vorab erhältst du…", ", Planung…").
const STARTS_WITH_INVALID_RE = /^[^\p{L}\p{N}]/u;

// Unicode control chars (incl. \r \v \f, not just \n\t), bidi-override and
// zero-width/BOM characters, plus markup / links / email addresses — never
// belong in a company or location label. The hidden-character ranges are a
// text-spoofing hazard on top of the existing HTML-injection one: a
// RIGHT-TO-LEFT OVERRIDE (U+202E) can make "Acme Corp" + reversed filename
// render as something else entirely once the raw value reaches the email
// template.
const FORBIDDEN_CHARS_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF<>@]|https?:\/\//i;

// Sentence punctuation followed by a lowercase word — real company/location
// labels don't look like this ("St. Moritz" survives: capital after the
// period), truncated prose does ("…weißt du immer, was dich erwartet…").
const PROSE_PUNCT_RE = /[.,]\s+\p{Ll}/u;

// Common connector words that only show up mid-sentence, never inside a
// company/location label.
const PROSE_WORD_RE = /\b(du|dich|che|with|and|und)\b/i;

// Marketing/verb words that never appear in a Swiss company or place name —
// a second net for prose that IS grammatically Title-Cased ("Scopri Subito
// Le Nostre Posizioni Aperte") or short enough to slip past the word-count /
// prose-token checks below. Matched case-insensitively as whole words,
// it/de/en/fr.
const MARKETING_STOPWORDS = [
  'scopri', 'unisciti', 'candidati', 'invia', 'clicca', 'iscriviti', 'subito',
  'adesso', 'oggi', 'aperte', 'aperta', 'offerta', 'offerte', 'posizioni',
  'opportunità', 'cerchiamo', 'cercasi', 'entra', 'lavora', 'bewerben',
  'jetzt', 'heute', 'aktuell', 'unsere', 'deine', 'stelle', 'stellen',
  'nachfrage', 'apply', 'join', 'now', 'today', 'discover', 'hiring',
  'careers', 'postule', 'rejoins', 'découvrez', 'aujourd', 'nos', 'notre',
];
// Lookaround (not \b) on purpose: \b is ASCII-\w-only in JS, so it fails to
// anchor right after an accented final letter like the "à" in
// "opportunità" — a plain /\bopportunità\b/ never matches. \p{L}/\p{N}-aware
// lookaround handles every stopword above, accented or not. Tested against
// the already-lowercased input (see call sites) so no 'i' flag/case-folding
// reliance on accented casing either.
const MARKETING_STOPWORD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${MARKETING_STOPWORDS.join('|')})(?![\\p{L}\\p{N}_])`,
  'u',
);

// Connector/particle words that legitimately appear lowercase INSIDE a real
// name ("Città di Lugano", "La Chaux-de-Fonds") — excluded from the
// prose-token count below so a real name isn't penalized for containing one.
const CONNECTOR_WORDS = new Set([
  'di', 'de', 'del', 'della', 'dei', 'degli', 'da', 'du', 'des', 'van', 'von',
  'der', 'den', 'das', 'e', 'ed', 'et', 'and', 'und', 'y', 'la', 'le', 'il',
  'lo', 'gli', 'al', 'à', 'of', 'for', 'the', 'a',
]);

// Counts whitespace-split tokens that are entirely lowercase (contain at
// least one letter and none of them uppercase) and are not a connector word
// above — i.e. "prose tokens". A real company/location name is Capitalized
// or an acronym; ordinary marketing prose is written in lowercase apart from
// (at most) its very first word. This is the signal that tells a NAME apart
// from a SENTENCE, and is why "Unisciti al nostro team dinamico" (5 words,
// under the old >7-word bar) is still prose: "nostro", "team", "dinamico"
// are lowercase, non-connector tokens.
function countProseTokens(trimmed) {
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const token of tokens) {
    // Strip leading/trailing punctuation ("aperte." / "(subito") so the bare
    // word form is what gets checked — internal punctuation (apostrophes,
    // hyphens) is left alone.
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!bare || !/\p{L}/u.test(bare)) continue; // punctuation/digits-only token
    if (/\p{Lu}/u.test(bare)) continue; // has an uppercase letter — not prose
    if (CONNECTOR_WORDS.has(bare.toLowerCase())) continue;
    count += 1;
  }
  return count;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sanitizeCompany(raw) {
  try {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length < 2 || trimmed.length > 60) return null;
    if (STARTS_WITH_INVALID_RE.test(trimmed)) return null;
    if (FORBIDDEN_CHARS_RE.test(trimmed)) return null;
    if (PROSE_PUNCT_RE.test(trimmed)) return null;
    if (PROSE_WORD_RE.test(trimmed)) return null;
    if (MARKETING_STOPWORD_RE.test(trimmed.toLowerCase())) return null;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 6) return null;
    if (countProseTokens(trimmed) >= 2) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// 2-letter Swiss canton codes → display name, matched case-insensitively.
const CANTON_CODE_MAP = {
  ti: 'Ticino',
  gr: 'Grigioni',
  vs: 'Vallese',
  vd: 'Vaud',
  zh: 'Zurigo',
  be: 'Berna',
  ge: 'Ginevra',
  bs: 'Basilea',
  lu: 'Lucerna',
  sg: 'San Gallo',
  ag: 'Argovia',
  so: 'Soletta',
  ne: 'Neuchâtel',
  fr: 'Friborgo',
  ju: 'Giura',
  sh: 'Sciaffusa',
  tg: 'Turgovia',
  zg: 'Zugo',
  sz: 'Svitto',
  ur: 'Uri',
  ow: 'Obvaldo',
  nw: 'Nidvaldo',
  gl: 'Glarona',
  ar: 'Appenzello Esterno',
  ai: 'Appenzello Interno',
};

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sanitizeLocation(raw) {
  try {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length < 2 || trimmed.length > 40) return null;
    if (STARTS_WITH_INVALID_RE.test(trimmed)) return null;
    if (FORBIDDEN_CHARS_RE.test(trimmed)) return null;
    if (PROSE_PUNCT_RE.test(trimmed)) return null;
    if (PROSE_WORD_RE.test(trimmed)) return null;
    if (MARKETING_STOPWORD_RE.test(trimmed.toLowerCase())) return null;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 3) return null;
    if (words.length === 1) {
      const lower = trimmed.toLowerCase();
      const canton = CANTON_CODE_MAP[lower];
      if (canton) return canton;
      // All-lowercase single word ("lugano") → Capitalize. Anything that
      // already has a capital ("Lugano", "Zürich", "Genève") is left as-is.
      if (trimmed === lower) {
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      }
    } else if (countProseTokens(trimmed) >= 1) {
      // Multi-word values only — a lone lowercase word is handled (and
      // legitimately capitalized) above, it can't exhibit the "mostly
      // lowercase sentence" shape this guard targets.
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function stripDiacritics(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function normalizeSectorKey(s) {
  return stripDiacritics(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

// Exact matches for every raw sector_interest value verified in production
// (both normalized slugs and raw human labels), keyed by the accent-stripped
// lowercased form so "Sanita / Ospedali" and "Sanità / Ospedali" collapse to
// one entry. Exact match is checked BEFORE the keyword fallback so a
// compound label like "Ospedaliero/Medicale/Sanitario/Educativo" — which
// contains the word "Educativo" but is a hospital-sector label overall —
// resolves deterministically to 'health' instead of being ambiguous between
// 'health' and 'education'.
const SECTOR_EXACT_MAP = new Map([
  ['admin', 'admin'],
  ['tech', 'tech'],
  ['finance', 'finance'],
  ['other', 'other'],
  ['altro', 'other'],
  ['amministrazione', 'admin'],
  ['sanita / ospedali', 'health'],
  ['ospedaliero/medicale/sanitario/educativo', 'health'],
  ['vendita / retail', 'retail'],
  ['ristorazione / hotel', 'hospitality'],
  ['trasporti / logistica', 'logistics'],
  ['produzione / tecnica', 'industry'],
  ['finanza / banca', 'finance'],
  ['logistica', 'logistics'],
  ['it / tecnologia', 'tech'],
]);

// Keyword fallback for variants not in the exact map above — "obvious
// variants" per spec, kept conservative (word-boundary regexes only) so an
// unrecognized label falls through to null instead of a false match.
// Deliberately no bucket for 'other': an unrecognized value must return
// null, never a claimed-but-unverified 'other'.
const SECTOR_KEYWORD_BUCKETS = [
  ['health', [/sanit/, /ospedal/, /\bmedic/, /\bsalute\b/]],
  ['admin', [/amministraz/, /\badmin\b/]],
  ['retail', [/\bretail\b/, /\bvendita\b/, /\bnegozio\b/, /\bcommercio\b/]],
  ['hospitality', [/ristorazione/, /\bhotel\b/, /albergh/, /\bhospitality\b/]],
  ['logistics', [/logistic/, /trasporti/]],
  ['transport', [/\bautista\b/, /\bconducente\b/, /\bdriver\b/]],
  ['finance', [/finanz/, /\bfinance\b/, /\bbanca\b/, /\bbank\b/]],
  ['tech', [/tecnologia/, /informatic/, /\btech\b/, /\bit\b/]],
  ['industry', [/produzione/, /\btecnica\b/, /industria/, /manifattur/]],
  ['education', [/\bscuola\b/, /istruzione/, /formazione/, /universita/]],
  ['construction', [/costruzion/, /edilizia/, /cantiere/]],
  ['cleaning', [/pulizi/, /\bcleaning\b/, /\bfacility\b/]],
];

/**
 * @param {unknown} raw
 * @returns {string|null} a SECTOR_KEYS member, or null
 */
export function normalizeSector(raw) {
  try {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 60) return null;
    if (FORBIDDEN_CHARS_RE.test(trimmed)) return null;
    if (PROSE_PUNCT_RE.test(trimmed)) return null;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 8) return null;
    const key = normalizeSectorKey(trimmed);
    // Idempotence: an already-canonical key must map to itself. Five of them
    // (health, industry, education, construction, transport) only ever appear
    // as human labels today ("Sanita / Ospedali"), so nothing in production
    // feeds them back in — but a reader reasonably assumes normalize(normalize(x))
    // === normalize(x), and the day a writer stores the canonical key those
    // sectors would silently resolve to null and demote the reader from the
    // `job` segment to `general`.
    if (SECTOR_KEYS.includes(key)) return key;
    if (SECTOR_EXACT_MAP.has(key)) return SECTOR_EXACT_MAP.get(key);
    for (const [sectorKey, patterns] of SECTOR_KEYWORD_BUCKETS) {
      if (patterns.some((re) => re.test(key))) return sectorKey;
    }
    return null;
  } catch {
    return null;
  }
}

// Letters (incl. accented), with apostrophe/hyphen allowed only INTERNALLY
// ("D'Angelo", "Jean-Luc") — never leading/trailing/doubled.
const NAME_CHAR_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

// Trailing company-form token — legal-entity suffixes that prove a "name"
// field actually holds a business name, not a person ("Tenuta Ferraro srl").
const COMPANY_SUFFIX_RE = /\b(s\.?r\.?l\.?|s\.?p\.?a\.?|sagl|gmbh|ag|ltd|llc|inc|snc|sas|sa)\.?\s*$/i;
const COMPANY_FIGLI_RE = /(&|\be\b)\s+figli\s*$/i;

function isCompanyLikeName(name) {
  const n = name.trim();
  if (!n) return false;
  return COMPANY_SUFFIX_RE.test(n) || COMPANY_FIGLI_RE.test(n);
}

// Capitalize unless the value already carries an internal capital that looks
// deliberate (McDonald, D'Angelo, Jean-Luc) — those are left untouched.
function capitalizeName(s) {
  const hasInternalCap = /[a-z][A-Z]/.test(s) || /['-][A-Z]/.test(s);
  if (hasInternalCap) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * @param {unknown} doc
 * @returns {string|null}
 */
export function safeFirstName(doc) {
  try {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;

    const name = typeof doc.name === 'string' ? doc.name : null;
    // A company-suffixed `name` invalidates the candidate regardless of
    // which field it came from — this is what catches the production case
    // where `firstName` was already (wrongly) derived as "Tenuta" from
    // "Tenuta Ferraro srl".
    if (name && isCompanyLikeName(name)) return null;

    let candidate = null;
    if (typeof doc.firstName === 'string' && doc.firstName.trim()) {
      candidate = doc.firstName.trim();
    } else if (name) {
      candidate = name.trim().split(/\s+/)[0] || null;
    }
    if (!candidate) return null;

    if (candidate.length < 2 || candidate.length > 20) return null;
    if (/\d/.test(candidate)) return null;
    if (/[.@<>/]/.test(candidate)) return null;
    if (/\s/.test(candidate)) return null;
    if (!NAME_CHAR_RE.test(candidate)) return null;
    // All-caps initials shape ("AR", "PF") — a real short first name is
    // never fully uppercase.
    if (candidate.length <= 3 && candidate === candidate.toUpperCase() && candidate !== candidate.toLowerCase()) {
      return null;
    }

    return capitalizeName(candidate);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} doc
 * @returns {string|null} site-relative path, leading AND trailing slash
 */
export function resolveJobBackPath(doc) {
  try {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const raw = doc.source_page;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 300) return null;
    if (!trimmed.startsWith('/')) return null;
    if (trimmed === '/') return null;
    if (trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('://')) return null;
    const segments = trimmed.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  } catch {
    return null;
  }
}

function pickString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

const JOB_CTA_SET = new Set([
  'job_board_email_unlock',
  'job_board_social_unlock',
  'job_expired_email_unlock',
  'job_orphan_email_unlock',
  'job_bridge_email_unlock',
  'job_board_auth',
]);

const EMPTY_CONTEXT = {
  segment: 'general',
  firstName: null,
  company: null,
  sectorKey: null,
  locationLabel: null,
  jobBackPath: null,
  toolKey: null,
  acquisitionSource: null,
};

/**
 * @param {unknown} doc
 * @returns {{segment: string, firstName: string|null, company: string|null,
 *   sectorKey: string|null, locationLabel: string|null, jobBackPath: string|null,
 *   toolKey: string|null, acquisitionSource: string|null}}
 */
export function resolveWelcomeContext(doc) {
  try {
    const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};

    const firstName = safeFirstName(d);
    const company = sanitizeCompany(d.job_company);
    const sectorKey = normalizeSector(d.sector_interest);
    const locationLabel = sanitizeLocation(d.location_interest);
    const jobBackPath = resolveJobBackPath(d);

    const sourceCta = pickString(d.source_cta) || '';
    const source = pickString(d.source) || '';
    const sourceRouteFamily = pickString(d.source_route_family) || '';
    const acquisitionSource = pickString(d.source_cta) || pickString(d.source) || pickString(d.source_component) || null;

    let segment = 'general';
    let toolKey = null;

    if (sourceCta.startsWith('publisher_gate') || source.startsWith('publisher_gate') || sourceRouteFamily === 'publisher') {
      segment = 'publisher';
    } else {
      // 'job' is only chosen when at least one personalization slot survived
      // sanitization, or there is explicit proof of job origin — a doc whose
      // only job signal was corrupted prose (all four slots null) with no
      // job source_cta/source must fall through to 'general' instead.
      const hasPersonalizationSlot = jobBackPath !== null || company !== null || sectorKey !== null || locationLabel !== null;
      const hasExplicitJobProof = JOB_CTA_SET.has(sourceCta) || source.startsWith('job_');

      if (hasPersonalizationSlot || hasExplicitJobProof) {
        segment = 'job';
      } else if (
        source === 'post_calc_cta' ||
        source === 'analysis_gate' ||
        source === 'calculator_paywall' ||
        sourceCta === 'post_calc_newsletter_cta' ||
        sourceRouteFamily === 'calculator'
      ) {
        segment = 'salary';
        toolKey = 'calculator';
      } else if (
        source === 'lamal_ssn_tool' ||
        source.startsWith('lead_magnet') ||
        source.startsWith('self_cert') ||
        source === 'frontaliere_wizard' ||
        sourceCta.startsWith('self_cert')
      ) {
        segment = 'utility';
        if (source === 'lamal_ssn_tool') toolKey = 'lamal';
        else if (source === 'frontaliere_wizard') toolKey = 'wizard';
        else if (source.startsWith('self_cert') || sourceCta.startsWith('self_cert')) toolKey = 'selfcert';
        else if (source.startsWith('lead_magnet')) toolKey = 'leadmagnet';
      } else {
        segment = 'general';
      }
    }

    return {
      segment,
      firstName,
      company,
      sectorKey,
      locationLabel,
      jobBackPath,
      toolKey,
      acquisitionSource,
    };
  } catch {
    return { ...EMPTY_CONTEXT };
  }
}
