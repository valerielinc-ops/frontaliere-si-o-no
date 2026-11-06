/**
 * healthFacilitiesMatch.ts — pure matching helpers for the health-facilities
 * hub (epic #4455 / sub #4456).
 *
 * Matches the curated Swiss hospital directory (`data/swiss-hospitals.json`)
 * against the live job corpus (`data/jobs.json`) so each real health employer
 * (grouped by the crawler's stable `companyKey`) becomes one facility page.
 *
 * Two mechanisms, in precedence order:
 *
 *   1. Employer-name match (PRIMARY) — the hospital's folded "core" name
 *      (parentheticals + trailing ", City" qualifier stripped) is a substring
 *      of the crawler's company name (or vice-versa) AND the two share at
 *      least one *significant* token (a token that is neither a generic
 *      facility word like "Spital"/"Klinik"/"Ente" nor a legal suffix like
 *      "AG"). The shared-token guard is what keeps a bare geographic token
 *      ("Luzern", "Valais") from collapsing "Klinik Luzern" onto "Stadt
 *      Luzern".
 *
 *   2. Geo-proximity fallback (SECONDARY) — when no employer name-matches a
 *      hospital, a crawler employer whose name carries a hospital-type token
 *      (Spital/Klinik/Clinica/Ospedale/…) and whose dominant job city equals
 *      the hospital's own city (same canton) is linked. This recovers real
 *      facilities the crawler labels with a different trade name than the
 *      directory's official name. City strings are validated against the
 *      Swiss municipality list by the caller (generator).
 *
 * Pure + SPA-safe: no `fs`, no JSON imports, no side effects — importable by
 * both the Node generator script and (if ever needed) the SPA bundle. All the
 * data loading lives in `scripts/generate-health-facilities-jobs.mjs`.
 */

/** ASCII-fold + lowercase a name so diacritics never block a match. */
export function foldName(s: string): string {
  return (s || '')
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Reduce a facility/company name to its comparable "core": drop any
 * parenthetical (site/acronym qualifier), collapse every non-alphanumeric run
 * to a single space, and trim. Keeps word order so a substring test is
 * meaningful.
 */
export function facilityCore(name: string): string {
  return foldName(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generic tokens that carry no identifying signal on their own: facility-type
 * nouns, legal suffixes, and connective words across the four site locales.
 * A match anchored ONLY on these (or on a bare place name) is rejected.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'spital', 'spitaler', 'spitäler', 'klinik', 'kliniken', 'clinica', 'cliniche',
  'clinic', 'clinique', 'ente', 'gruppe', 'gruppo', 'group', 'groupe', 'groupement',
  'sa', 'ag', 'gmbh', 'srl', 'di', 'the', 'und', 'and', 'fondazione', 'fondation',
  'stiftung', 'foundation', 'ospedale', 'ospedaliero', 'ospedali', 'cantonale',
  'sede', 'standort', 'site', 'centre', 'center', 'centro', 'zentrum', 'hopital',
  'hospital', 'krankenhaus', 'medica', 'medical', 'de', 'du', 'des', 'le', 'la',
  'les', 'fur', 'für', 'im', 'in', 'am', 'reseau', 'réseau', 'santé', 'sante',
  'privatklinik', 'rehaklinik', 'rehabilitation', 'reha',
]);

/** Hospital-type tokens used by the geo fallback to confirm an employer is a
 * care facility even when its name doesn't match the directory. */
const HOSPITAL_TYPE_TOKENS: ReadonlySet<string> = new Set([
  'spital', 'spitaler', 'spitäler', 'klinik', 'kliniken', 'clinica', 'cliniche',
  'clinic', 'clinique', 'ospedale', 'ospedaliero', 'krankenhaus', 'hopital',
  'hospital', 'privatklinik', 'rehaklinik', 'psychiatrie', 'psychiatrische',
  'psychiatriezentrum', 'kinderspital', 'sanatorium', 'pflegezentrum', 'pflege',
]);

/** Significant (non-generic, length ≥ 3) tokens of a name. */
export function significantTokens(name: string): string[] {
  return facilityCore(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

/** Does a company name carry any hospital-type token? (geo-fallback guard) */
export function isHospitalTypeName(companyName: string): boolean {
  const toks = facilityCore(companyName).split(' ');
  return toks.some((t) => HOSPITAL_TYPE_TOKENS.has(t));
}

/**
 * PRIMARY match: employer company name ⟷ hospital directory name.
 * Returns true when the folded cores contain one another (either direction)
 * and the two names share at least one significant token.
 */
export function employerMatchesHospital(companyName: string, hospitalName: string): boolean {
  const cCore = facilityCore(companyName);
  const hCore = facilityCore(hospitalName);
  if (cCore.length < 4 || hCore.length < 4) return false;
  if (!(cCore.includes(hCore) || hCore.includes(cCore))) return false;
  const cSig = new Set(significantTokens(companyName));
  if (cSig.size === 0) return false;
  for (const t of significantTokens(hospitalName)) {
    if (cSig.has(t)) return true;
  }
  return false;
}

/**
 * Extract the hospital's own city from its directory name for the geo
 * fallback: the last comma-separated segment (e.g. "…, Bellinzona") or the
 * content of a parenthetical that names a site (e.g. "(Ospedale di Lugano)").
 * Returns the folded city token, or '' when none is discernible. The caller
 * validates the result against the Swiss municipality list.
 */
export function extractHospitalCity(hospitalName: string): string {
  const paren = hospitalName.match(/\(([^)]*)\)/);
  if (paren) {
    // "Ospedale di Lugano" / "Standort Horgen" / "site Hôpital de Sierre" → last word
    const words = facilityCore(paren[1]).split(' ').filter(Boolean);
    const last = words[words.length - 1];
    if (last && last.length >= 3 && !GENERIC_TOKENS.has(last)) return last;
  }
  const commaParts = hospitalName.split(',');
  if (commaParts.length > 1) {
    const tail = facilityCore(commaParts[commaParts.length - 1]);
    const words = tail.split(' ').filter(Boolean);
    const last = words[words.length - 1];
    if (last && last.length >= 3 && !GENERIC_TOKENS.has(last)) return last;
  }
  return '';
}

/** Normalized facility category keys derived from the directory's German
 * `category` strings. Localized labels live in `healthFacilitiesCopy.ts`. */
export type HealthFacilityCategory = 'acute' | 'rehab' | 'psychiatry' | 'birth' | 'other';

export function normalizeCategory(rawCategory: string | null | undefined): HealthFacilityCategory {
  const c = foldName(rawCategory || '');
  if (c.includes('akut')) return 'acute';
  if (c.includes('rehabilitation') || c.includes('reha')) return 'rehab';
  if (c.includes('psychiatr')) return 'psychiatry';
  if (c.includes('geburt')) return 'birth';
  return 'other';
}

// ── Healthcare-role classification ──────────────────────────────────────────
//
// Shared by the generator (snapshot role counts + median) and the build-time
// aggregate (live role counts + median) so the two can never drift
// (AGENTS.md Non-Negotiable #6). Multi-locale title stems, mirroring the
// nursing-landing matchers.

export type HealthcareRole =
  | 'infermiere'
  | 'oss'
  | 'medico'
  | 'terapista'
  | 'ostetrica'
  | 'tecnico'
  | 'altro';

const ROLE_PATTERNS: ReadonlyArray<{ role: HealthcareRole; rx: RegExp }> = [
  { role: 'oss', rx: /\b(operatore socio-?sanitari|\boss\b|fachperson betreuung|fa-?ge|assc|pflegehelfer|pflegeassist|aide-?soignant|nursing assistant|healthcare assistant|assistant.{0,5}sant)/i },
  { role: 'infermiere', rx: /\b(infermier|nurse|krankenpfleg|krankenschwester|pflegefach|registered nurse|fachfrau gesundheit|fachmann gesundheit|fachperson gesundheit|infirmier|infirmière|dipl\.?\s*pflege)/i },
  { role: 'ostetrica', rx: /\b(ostetric|levatric|sage-?femme|hebamme|midwife)/i },
  { role: 'terapista', rx: /\b(terapist|physiotherap|fisioterapist|ergoterapist|ergotherap|logopedist|logopäd|logoped|orthophonist|physiotherapeut)/i },
  { role: 'tecnico', rx: /\b(tecnico sanitario|laboratorio analisi|radiolog|tecnico di laboratorio|mtra|trm\b|biomedical|laborant)/i },
  { role: 'medico', rx: /\b(medico|médecin|[a-zäöü]*arzt|[a-zäöü]*ärztin|physician|doctor|primario|caposervizio medic|chirurg)/i },
];

/** Umbrella test — is this title a healthcare/care role at all? */
const HEALTHCARE_UMBRELLA_RX =
  /\b(infermier|nurse|krankenpfleg|krankenschwester|pflegefach|pflegehelfer|pflegeassist|fachperson gesundheit|fachfrau gesundheit|fachmann gesundheit|fachperson betreuung|operatore socio-?sanitari|\boss\b|fa-?ge|assc|aide-?soignant|nursing assistant|healthcare assistant|infirmier|infirmière|medico|médecin|[a-zäöü]*arzt|[a-zäöü]*ärztin|physician|doctor|primario|chirurg|terapist|physiotherap|fisioterapist|ergoterapist|ergotherap|logopedist|logopäd|caregiver|ostetric|levatric|sage-?femme|hebamme|midwife|radiolog|laboratorio analisi|tecnico sanitario|pflege)/i;

const NON_HEALTHCARE_RX = /\b(tierpfleg|tierarzt|veterinari|\bvet\b|assistenzpsycholog)/i;

/**
 * Classify a job title into a headline healthcare role, or `null` when the
 * title is not a healthcare/care role.
 *
 * Canonical `title` only — deliberately excludes `titleByLocale`. The
 * classification is computed once per job and reused across every locale's
 * facility page (see `buildSnapshot`), so a mistranslation in any one
 * locale's title must never be able to misclassify a job. Every job carries
 * a canonical `job.title` (confirmed against the live dataset), so this
 * costs no matching coverage. See #4715 (same construct fixed in
 * jobSectorLanding.ts::jobMatchesSector).
 */
export function classifyHealthcareRole(title: string | null | undefined): HealthcareRole | null {
  if (!title) return null;
  if (NON_HEALTHCARE_RX.test(title)) return null;
  if (!HEALTHCARE_UMBRELLA_RX.test(title)) return null;
  for (const { role, rx } of ROLE_PATTERNS) {
    if (rx.test(title)) return role;
  }
  return 'altro';
}

/** True when the job title describes any healthcare/care role. */
export function isHealthcareRole(title: string | null | undefined): boolean {
  return classifyHealthcareRole(title) !== null;
}

