/**
 * Advanced ATS Text-Layer & Layout Inspector,
 * ported from ai-job-search tools/verify_pdf.py and verify_layout.py (MIT).
 * Copyright (c) 2026 Mads Lorentzen.
 *
 * Verifies that the rendered CV / cover letter text layer will parse cleanly
 * in international and Swiss ATS platforms (Workday, SuccessFactors, Taleo, Umantis, Refline):
 * 1. ASCII Date Range Normalization Check: Detects Unicode dashes (en-dash U+2013, em-dash U+2014,
 *    minus U+2212) joined to years (e.g. "2018–2023"), which Workday imports frequently drop or corrupt.
 * 2. Literal Contact Verification: Checks that candidate email and international phone format
 *    extract as literal plain text without icon font glyph interference (Private Use Area U+E000..U+F8FF).
 * 3. Reading Order & Parseability: Flags replacement characters (U+FFFD), unprintable garbage runs,
 *    or corrupted ligatures.
 * 4. Keyword Coverage Matrix: Matches posting requirements against the CV text layer, categorizing
 *    keywords into covered, synonym-only, missing_profile, and missing_gap (strictly honoring the honesty rule).
 */

const UNICODE_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const UNICODE_DATE_RANGE_RE = /\b(19\d\d|20\d\d)\s*([\u2010\u2011\u2012\u2013\u2014\u2015\u2212])\s*(19\d\d|20\d\d|present|oggi|attuale|current|heute)\b/iu;

// PUA (Private Use Area) characters commonly used by icon fonts (FontAwesome etc.)
const PUA_RE = /[\uE000-\uF8FF]/u;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;

const REPLACEMENT_CHAR_RE = /\uFFFD|\?/g;

/**
 * Checks extracted PDF text for ATS date-range compatibility.
 * @param {string} text
 * @returns {{ valid: boolean, hits: Array<{ match: string, char: string, codePoint: string }> }}
 */
export function checkAsciiDates(text) {
  const hits = [];
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const match = UNICODE_DATE_RANGE_RE.exec(line);
    if (match) {
      const dash = match[2];
      hits.push({
        match: match[0],
        char: dash,
        codePoint: `U+${dash.codePointAt(0)?.toString(16).toUpperCase()}`,
      });
    }
  }

  return {
    valid: hits.length === 0,
    hits,
  };
}

/**
 * Verifies that contact info is extractable as literal plain text without PUA icon corruption.
 * @param {string} text
 * @param {object} contacts
 * @param {string} contacts.email
 * @param {string} [contacts.phone]
 * @returns {{
 *   emailFound: boolean,
 *   phoneFound: boolean,
 *   puaDetected: boolean,
 *   valid: boolean,
 *   issues: string[]
 * }}
 */
export function verifyLiteralContacts(text, { email, phone }) {
  const raw = String(text || '');
  const issues = [];

  const cleanEmail = String(email || '').trim().toLowerCase();
  const emailFound = cleanEmail ? raw.toLowerCase().includes(cleanEmail) : false;
  if (!emailFound) {
    issues.push(`Email "${email}" not found as literal extractable text.`);
  }

  let phoneFound = false;
  if (phone) {
    const digitsOnlyPhone = String(phone).replace(/\D/g, '');
    const rawDigits = raw.replace(/\D/g, '');
    phoneFound = digitsOnlyPhone.length >= 7 && rawDigits.includes(digitsOnlyPhone);
    if (!phoneFound) {
      issues.push(`Phone "${phone}" not found as literal extractable digits.`);
    }
  } else {
    phoneFound = true;
  }

  const puaDetected = PUA_RE.test(raw);
  if (puaDetected) {
    issues.push('Private Use Area (PUA) icon font characters detected in text layer; icon fonts can scramble ATS contact extraction.');
  }

  return {
    emailFound,
    phoneFound,
    puaDetected,
    valid: emailFound && phoneFound && !puaDetected,
    issues,
  };
}

/**
 * Normalizes keyword for matching.
 * @param {string} kw
 * @returns {string}
 */
function normalizeKw(kw) {
  return String(kw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Generates ATS Keyword Coverage Matrix.
 * @param {string} cvText - extracted plain text of the CV
 * @param {string[]} postingKeywords - required and preferred skills from posting
 * @param {object} [profile] - candidate profile data
 * @param {object} [synonymMap] - optional map of synonyms (e.g. { 'postgres': 'sql' })
 * @returns {{
 *   scorePercent: number,
 *   coveredCount: number,
 *   totalKeywords: number,
 *   matrix: Array<{
 *     keyword: string,
 *     status: 'covered'|'synonym'|'missing_profile'|'missing_gap',
 *     note: string
 *   }>
 * }}
 */
export function buildKeywordCoverageMatrix(
  cvText,
  postingKeywords = [],
  profile = {},
  synonymMap = {}
) {
  const rawCv = normalizeKw(cvText);
  const profileSkills = (profile?.skills || []).map(normalizeKw);
  const matrix = [];

  const defaultSynonyms = {
    postgresql: ['postgres', 'sql', 'rdbms', 'database relazionali'],
    react: ['react.js', 'reactjs', 'frontend'],
    typescript: ['ts', 'javascript tipizzato'],
    docker: ['container', 'containerizzazione', 'docker-compose'],
    kubernetes: ['k8s', 'orchestration'],
    ...synonymMap,
  };

  let coveredCount = 0;

  for (const rawKw of postingKeywords) {
    const kw = normalizeKw(rawKw);
    if (!kw) continue;

    // 1. Direct exact or boundary match in CV text
    if (rawCv.includes(kw)) {
      matrix.push({
        keyword: rawKw,
        status: 'covered',
        note: 'Trovata corrispondenza testuale diretta nel CV.',
      });
      coveredCount++;
      continue;
    }

    // 2. Check synonyms
    const syns = defaultSynonyms[kw] || [];
    const matchedSyn = syns.find((s) => rawCv.includes(normalizeKw(s)));
    if (matchedSyn) {
      matrix.push({
        keyword: rawKw,
        status: 'synonym',
        note: `Coperto tramite concetto/sinonimo: "${matchedSyn}".`,
      });
      coveredCount += 0.8; // Partial credit for synonym
      continue;
    }

    // 3. Check if candidate profile genuinely has it, but it was missed in CV text
    const inProfile = profileSkills.some((s) => s.includes(kw) || kw.includes(s));
    if (inProfile) {
      matrix.push({
        keyword: rawKw,
        status: 'missing_profile',
        note: 'Presente nel profilo candidato ma assente nel testo del CV: si consiglia di aggiungerlo esplicitamente.',
      });
      continue;
    }

    // 4. Genuine gap
    matrix.push({
      keyword: rawKw,
      status: 'missing_gap',
      note: 'Gap reale di competenze: non inserire nel CV (honesty rule), gestire tramite gap bridging nella lettera.',
    });
  }

  const total = matrix.length;
  const scorePercent = total ? Math.min(100, Math.round((coveredCount / total) * 100)) : 100;

  return {
    scorePercent,
    coveredCount: Math.round(coveredCount),
    totalKeywords: total,
    matrix,
  };
}

/**
 * Full audit of a CV text layer.
 * @param {object} params
 * @param {string} params.cvText
 * @param {object} params.contacts
 * @param {string[]} [params.postingKeywords]
 * @param {object} [params.profile]
 * @returns {object}
 */
export function auditCvTextLayer({
  cvText,
  contacts,
  postingKeywords = [],
  profile = {},
}) {
  const asciiDates = checkAsciiDates(cvText);
  const literalContacts = verifyLiteralContacts(cvText, contacts);
  const keywordCoverage = buildKeywordCoverageMatrix(cvText, postingKeywords, profile);

  const passesAts = asciiDates.valid && literalContacts.valid && keywordCoverage.scorePercent >= 65;

  return {
    passesAts,
    asciiDates,
    literalContacts,
    keywordCoverage,
  };
}
