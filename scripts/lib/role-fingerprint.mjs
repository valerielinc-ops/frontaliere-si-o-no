import { createHash } from 'node:crypto';
import { decode } from 'html-entities';

const HTML_TAG_REGEX = /<[^>]*>/g;
const TRAILING_CLAUSE_REGEX = /(\s*,\s*|\s+[|@]\s*|\s+[-–—]\s*)[^,|@\-–—]*$/;
const RECORD_SEPARATOR = '\x1e';
const EMPLOYER_PLACEHOLDERS = new Set([
  'anonymous',
  'anonymous employer',
  'azienda',
  'azienda svizzera',
  'company',
  'confidential',
  'confidential company',
  'confidential employer',
  'confidential client',
  'company confidential',
  'company not specified',
  'datore di lavoro',
  'datore di lavoro svizzero',
  'employer',
  'employer not disclosed',
  'employer not specified',
  'n a',
  'no name',
  'no company',
  'no employer',
  'not available',
  'not disclosed',
  'not provided',
  'not specified',
  'not stated',
  'non disponibile',
  'non indicato',
  'non specificato',
  'nicht angegeben',
  'keine angabe',
  'unbekannt',
  'inconnu',
  'sconosciuto',
  'organization not specified',
  'private employer',
  'private company',
  'swiss employer',
  'tech company svizzera',
  'undisclosed',
  'undisclosed client',
  'undisclosed company',
  'undisclosed employer',
  'unknown',
  'unknown company',
  'unknown employer',
]);
const GENERIC_EMPLOYER_PLACEHOLDER_RE = /^(?:(?:anonymous|confidential|private|undisclosed|unknown|none|n a|no name|no (?:company|employer|client)(?: name)?|not (?:available|disclosed|known|provided|specified|stated))(?: (?:company|employer|client|organization|organisation|name))?|(?:company|employer|client|organization|organisation|name) (?:anonymous|confidential|private|undisclosed|unknown|not (?:available|disclosed|known|provided|specified|stated)))$/;

function normalizedEmployerText(value) {
  return normalizeRoleText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function employerIdentity(job, index) {
  for (const value of [job.companySlug, job.company]) {
    if (typeof value !== 'string') continue;
    const candidate = normalizedEmployerText(value);
    if (candidate && !EMPLOYER_PLACEHOLDERS.has(candidate) && !GENERIC_EMPLOYER_PLACEHOLDER_RE.test(candidate)) return candidate;
  }

  // With no real employer source there is no safe basis for cross-posting
  // collapse. A per-record key keeps unrelated employers separate.
  const recordKey = [job.id, job.applicationUrl || job.url, job.slug, index]
    .map(value => String(value ?? '').trim()).join(RECORD_SEPARATOR);
  return `unidentified-employer${RECORD_SEPARATOR}${recordKey}`;
}

/**
 * Normalizza il testo rimuovendo HTML, entità, maiuscole e spazi superflui.
 * @param {string} text
 * @returns {string}
 */
export function normalizeRoleText(text) {
  if (!text) return '';
  const withoutTags = String(text).replace(HTML_TAG_REGEX, ' ');
  const unescaped = decode(withoutTags);
  return unescaped.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Rimuove il suffisso geografico o qualificatore finale dal titolo (es. "Senior Dev, Lugano" -> "Senior Dev").
 * Include two-word guard: se la rimozione lascia meno di 2 parole, conserva il titolo originale.
 * @param {string} title
 * @returns {string}
 */
export function stripTrailingClause(title) {
  if (!title) return '';
  const raw = String(title).trim();
  const stripped = raw.replace(TRAILING_CLAUSE_REGEX, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return raw;
  }
  return stripped;
}

/**
 * Calcola il fingerprint crittografico univoco SHA-256 del ruolo.
 * Esclude deliberatamente la sede geografica e le date per permettere
 * il collasso multi-città (es. Lugano, Bellinzona, Zurigo).
 * @param {string} companySlug
 * @param {string} title
 * @param {string} description
 * @returns {string} SHA-256 hex string
 */
export function computeRoleFingerprint(companySlug, title, description) {
  const normSlug = String(companySlug || '').toLowerCase().trim();
  const normTitle = normalizeRoleText(stripTrailingClause(title));
  const normDesc = normalizeRoleText(description);

  const payload = `${normSlug}${RECORD_SEPARATOR}${normTitle}${RECORD_SEPARATOR}${normDesc}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Raggruppa un elenco di offerte di lavoro collassando gli annunci identici
 * pubblicati in più sedi/città sotto un unico annuncio canonico con copies: [...].
 * @param {Array<object>} jobs
 * @returns {Array<object>}
 */
export function collapseMultiCityRoles(jobs) {
  if (!Array.isArray(jobs)) return [];
  const clusters = new Map();

  for (const [index, job] of jobs.entries()) {
    if (!job) continue;
    const fingerprint = computeRoleFingerprint(employerIdentity(job, index), job.title, job.description || job.descriptionHtml);
    const jobWithFingerprint = { ...job, roleFingerprint: fingerprint };

    if (!clusters.has(fingerprint)) {
      clusters.set(fingerprint, {
        ...jobWithFingerprint,
        copies: []
      });
    } else {
      const canonical = clusters.get(fingerprint);
      canonical.copies.push({
        id: job.id,
        location: job.location,
        canton: job.canton,
        applicationUrl: job.applicationUrl || job.url,
        slug: job.slug
      });
    }
  }

  return Array.from(clusters.values());
}
