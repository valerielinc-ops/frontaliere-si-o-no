/**
 * Provenance predicates for source-owned JobPosting values, shared by the
 * builder (build-plugins/shared/jobPostingSchema.ts) and the audit that checks
 * its output against data/jobs.json (scripts/validate-jobs-rich-results-sample.mjs).
 *
 * Owner decision 2026-10-24: the schema is always emitted; source values win,
 * while the canonical builder supplies safe defaults for omitted non-critical
 * fields. One definition here keeps producer and observer aligned on what
 * counts as source evidence.
 */

/**
 * Only a salary the listing (or the employer, for publisher ads) reported.
 * `estimated` is the sector band of the crawler pipeline; `existing` and a
 * missing value are structured salaries of unknown origin — the job cards
 * already label them "fonte non verificata" (build-plugins/shared/
 * salaryEstimateSuffix.ts), so they do not become employer statements here.
 *
 * @param {{ salarySource?: unknown } | null | undefined} job
 */
export function isSalaryReportedBySource(job) {
  return String(job?.salarySource ?? '').trim().toLowerCase() === 'reported';
}

const STREET_KEYWORD_RE = /\b(?:via|viale|vicolo|vicoletto|piazza|piazzale|piazzetta|corso|strada|stradone|salita|sentiero|contrada|largo|riva|lungolago|rampa|passaggio|rue|route|chemin|avenue|place|quai|boulevard|impasse|ruelle|sentier|allée)\b|(?:strasse|straße|weg|platz|gasse|allee)\b/i;

/**
 * Does the source value read as a street of the locality, rather than a city,
 * a region or a crawler artefact? Crawler/enrichment pipelines have stored the
 * locality itself as `streetAddress` ("Lugano"), and scraped navigation text.
 *
 * @param {unknown} raw source streetAddress
 * @param {unknown} locality the emitted addressLocality
 */
export function isSourceStreetAddress(raw, locality) {
  const street = String(raw ?? '').trim();
  if (street.length < 3 || street.length > 100) return false;
  if ((street.match(/\s/g) || []).length > 8) return false;
  if (/stampa|segnalazione|descrizione|annuncio|verifica|attività|dillo/i.test(street)) return false;
  const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (fold(street) === fold(locality)) return false;
  if (!/[a-zà-ÿ]/i.test(street)) return false;
  return /\d/.test(street) || STREET_KEYWORD_RE.test(street);
}
