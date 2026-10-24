/**
 * The contract types a job listing declares, resolved ONCE for every surface
 * that shows them: the JobPosting `employmentType` (build-plugins/shared/
 * jobPostingSchema.ts), the "Contratto" label of the static job page and of
 * its mobile block, the per-job FAQ, and the rich-results audit
 * (scripts/validate-jobs-rich-results-sample.mjs).
 *
 * Owner decision 2026-10-24: a JobPosting field is present if and only if the
 * source states it. The previous builder mapped an unknown or missing value to
 * `FULL_TIME`, so a temporary agency listing ("A tempo pieno, Interinale",
 * `contractType: "temporary"`) was declared FULL_TIME in JSON-LD while the
 * page printed "Contratto: other". Here an unknown value contributes nothing,
 * a listing with no recognisable value resolves to `[]` (no employmentType at
 * all), and a listing that states several (full-time AND temporary) keeps all
 * of them: schema.org `employmentType` accepts an array.
 *
 * Inputs, in this order: `employmentType` (usually the source JSON-LD value),
 * `contract`, `contractType` (crawler normalisations of the same listing).
 * When none of them names a type, the workload the title states decides
 * (#15009, `employment-workload.mjs`): "Verkäufer/in 60%" is PART_TIME,
 * "Projektleiter 80-100%" FULL_TIME — the listing's own words. A title without
 * a workload states nothing. `OTHER` is how a crawler records that it could
 * not read the type (1,440 of 1,448 prospected jobs, measured 2026-10-24), so
 * it is not a statement either.
 */

import { PART_TIME_MAX_WORKLOAD, statedWorkloadPercent } from './employment-workload.mjs';

export const JOB_EMPLOYMENT_TYPES = Object.freeze([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
  'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

// Values that record the absence of a statement, not a contract type.
const NOT_A_STATEMENT = new Set(['OTHER', 'UNKNOWN', 'N/A', 'NA']);

const ENUM = new Set(JOB_EMPLOYMENT_TYPES);

// Matched on the lower-cased value with every non-letter turned into a space,
// so "full-time", "FULL_TIME", "Full time" and "fulltime" read the same.
// Word boundaries keep "indeterminato" from matching "determinato".
// "permanent"/"indeterminato"/"CDI" state a duration, not the hours: schema.org
// has no permanent type, and reading them as FULL_TIME would declare hours the
// listing never stated (a permanent part-time role). They contribute nothing.
const PATTERNS = Object.freeze([
  ['FULL_TIME', /\b(?:full ?time|vollzeit|temps plein|tempo pieno)\b/],
  ['PART_TIME', /\b(?:part ?time|teilzeit|temps partiel|tempo parziale)\b/],
  ['TEMPORARY', /\b(?:temporary|temp|temporaire|temporaneo|interim|interinale|fixed term|befristet|determinato|cdd|seasonal|saisonnier|stagionale)\b/],
  ['INTERN', /\b(?:intern|internship|stage|stagiaire|tirocinio|praktikum|apprentice|apprenticeship|apprendista|apprentissage|lehrstelle|trainee)\b/],
  ['CONTRACTOR', /\b(?:contractor|freelance|freelancer|mandato)\b|^contract$/],
  ['VOLUNTEER', /\b(?:volunteer|volontario|benevole|bénévole)\b/],
  ['PER_DIEM', /\bper diem\b/],
]);

function typesOf(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  const upper = value.toUpperCase();
  if (NOT_A_STATEMENT.has(upper)) return [];
  if (ENUM.has(upper)) return [upper];
  const text = value.toLowerCase().replace(/[^a-zà-ÿ]+/g, ' ').trim();
  if (!text) return [];
  return PATTERNS.filter(([, re]) => re.test(text)).map(([type]) => type);
}

/**
 * @param {{ employmentType?: unknown, contract?: unknown, contractType?: unknown } | null | undefined} job
 * @param {unknown} [title] the (localized) title, read for a stated workload only
 *   when no contract field names a type
 * @returns {string[]} schema.org EmploymentType tokens stated by the source,
 *   deduplicated, in input order.
 */
export function resolveJobEmploymentTypes(job, title) {
  const out = [];
  for (const raw of [job?.employmentType, job?.contract, job?.contractType]) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      for (const type of typesOf(value)) if (!out.includes(type)) out.push(type);
    }
  }
  if (out.length > 0) return out;
  const workload = statedWorkloadPercent(title ?? '');
  if (!Number.isFinite(workload) || workload <= 0) return [];
  return [workload < PART_TIME_MAX_WORKLOAD ? 'PART_TIME' : 'FULL_TIME'];
}

/**
 * The JSON-LD shape: absent, one token, or an array of tokens.
 * @param {string[]} types
 * @returns {string | string[] | undefined}
 */
export function employmentTypeJsonLdValue(types) {
  if (!Array.isArray(types) || types.length === 0) return undefined;
  return types.length === 1 ? types[0] : [...types];
}

const LABELS = Object.freeze({
  it: { FULL_TIME: 'Tempo pieno', PART_TIME: 'Tempo parziale', CONTRACTOR: 'Mandato/freelance', TEMPORARY: 'Temporaneo', INTERN: 'Stage/tirocinio', VOLUNTEER: 'Volontariato', PER_DIEM: 'A giornata', OTHER: 'Altro' },
  en: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contractor/freelance', TEMPORARY: 'Temporary', INTERN: 'Internship', VOLUNTEER: 'Volunteer', PER_DIEM: 'Per diem', OTHER: 'Other' },
  de: { FULL_TIME: 'Vollzeit', PART_TIME: 'Teilzeit', CONTRACTOR: 'Mandat/Freelance', TEMPORARY: 'Befristet', INTERN: 'Praktikum', VOLUNTEER: 'Ehrenamtlich', PER_DIEM: 'Tagessatz', OTHER: 'Sonstiges' },
  fr: { FULL_TIME: 'Temps plein', PART_TIME: 'Temps partiel', CONTRACTOR: 'Mandat/freelance', TEMPORARY: 'Temporaire', INTERN: 'Stage', VOLUNTEER: 'Bénévolat', PER_DIEM: 'À la journée', OTHER: 'Autre' },
});

const NOT_STATED = Object.freeze({
  it: 'non indicato',
  en: 'not specified',
  de: 'nicht angegeben',
  fr: 'non indiqué',
});

/**
 * Visible label of the same resolution the JSON-LD carries.
 * @param {string[]} types
 * @param {string} locale
 * @returns {string} e.g. "Tempo pieno, Temporaneo"; the localised "not specified" when empty.
 */
export function formatJobEmploymentTypes(types, locale) {
  const short = String(locale || 'it').slice(0, 2).toLowerCase();
  const labels = LABELS[short] || LABELS.it;
  if (!Array.isArray(types) || types.length === 0) return NOT_STATED[short] || NOT_STATED.it;
  return types.map((type) => labels[type] || type).join(', ');
}
