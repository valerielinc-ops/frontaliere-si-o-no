import { resolveReportedPostingDate, resolveSchemaPostingDate } from './job-posting-date.mjs';

const JOB_POSTING_SAFE_DEFAULT_URLS = new Set([
  'https://frontaliereticino.ch/cerca-lavoro-berna/mansioni-richieste-hirslanden-klinik-search-a0f5e9/',
  'https://frontaliereticino.ch/cerca-lavoro-turgovia/apprendistato-come-impiegata-impiegato-in-logistica-cfc-distribuzione-recapito-misto-lettere-e-pacchi-die-daac6e/',
  'https://frontaliereticino.ch/de/jobs-im-wallis/personalberater-80-100-canton-du-valais-sion/',
  'https://frontaliereticino.ch/en/find-jobs-bern/internship-in-assisted-living-interessengemeinschaft-sozialpsychiatrie-bern-bern/',
  'https://frontaliereticino.ch/en/find-jobs-vaud/100-dpi-nurse-reference-hirslanden-klinik-hirslanden-clinique-cecil/',
  'https://frontaliereticino.ch/fr/trouver-emploi-soleure/mecanicien-de-maintenance-mecanicienne-de-maintenance-nouveau-batiment-oensingen-bell-schweiz-ag-oensingen/',
]);

/** Publication dates require explicit source evidence, including legacy records.
 * The callback argument remains for compatibility but is never evaluated.
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, _legacyDate, now) {
  // Keep the rollout boundary fail-closed even if a compatibility caller
  // reaches this wrapper before the stricter validator below.
  if (input?.postingDateSource !== 'reported') return null;
  return resolveReportedPostingDate(input, now);
}

/**
 * Preserve the existing fail-closed schema policy generally. The stable
 * schema-only date default is permitted only for the six canonical URLs in
 * issue #12937; source provenance remains unchanged.
 */
export function resolveRolloutSchemaPostingDate(input, now, url) {
  const reported = resolveReportedPostingDate(input, now);
  if (reported) return { value: reported, provenance: 'reported' };
  if (!JOB_POSTING_SAFE_DEFAULT_URLS.has(url)) return null;
  return resolveSchemaPostingDate(input, now, true);
}
