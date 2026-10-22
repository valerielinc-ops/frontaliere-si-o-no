import {
  resolveFirstSeenPostingDate,
  resolveReportedPostingDate,
  resolveSchemaPostingDate,
} from './job-posting-date.mjs';

const JOB_POSTING_SAFE_DEFAULT_URLS = new Set([
  'https://frontaliereticino.ch/cerca-lavoro-berna/mansioni-richieste-hirslanden-klinik-search-a0f5e9/',
  'https://frontaliereticino.ch/cerca-lavoro-turgovia/apprendistato-come-impiegata-impiegato-in-logistica-cfc-distribuzione-recapito-misto-lettere-e-pacchi-die-daac6e/',
  'https://frontaliereticino.ch/de/jobs-im-wallis/personalberater-80-100-canton-du-valais-sion/',
  'https://frontaliereticino.ch/en/find-jobs-bern/internship-in-assisted-living-interessengemeinschaft-sozialpsychiatrie-bern-bern/',
  'https://frontaliereticino.ch/en/find-jobs-vaud/100-dpi-nurse-reference-hirslanden-klinik-hirslanden-clinique-cecil/',
  'https://frontaliereticino.ch/fr/trouver-emploi-soleure/mecanicien-de-maintenance-mecanicienne-de-maintenance-nouveau-batiment-oensingen-bell-schweiz-ag-oensingen/',
]);

/** Resolve the display date, preferring employer evidence over first observation.
 * The callback argument remains for compatibility but is never evaluated.
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, _legacyDate, now) {
  return resolveReportedPostingDate(input, now) || resolveFirstSeenPostingDate(input, now);
}

/**
 * Resolve the JobPosting date without changing upstream source provenance.
 * A first-seen timestamp is an intentional synthetic fallback; the stable
 * schema-only sentinel remains permitted only for the six canonical URLs.
 */
export function resolveRolloutSchemaPostingDate(input, now, url) {
  const reported = resolveReportedPostingDate(input, now);
  if (reported) return { value: reported, provenance: 'reported' };
  const firstSeen = resolveFirstSeenPostingDate(input, now);
  if (firstSeen) return { value: firstSeen, provenance: 'first-seen' };
  if (!JOB_POSTING_SAFE_DEFAULT_URLS.has(url)) return null;
  return resolveSchemaPostingDate(input, now, true);
}
