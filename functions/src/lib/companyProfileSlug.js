/**
 * CompanyAlert canonicalisation for the Cloud Functions boundary.
 *
 * The canonical source is build-plugins/shared/companyProfileSlug.mjs, but the
 * Firebase bundle cannot import outside functions/. This is its deliberately
 * small runtime mirror, with parity fixtures for the aliases that matter to
 * CompanyAlert. Unknown slugs pass through after slugification; an empty input
 * is the only non-canonicalisable result and is rejected by the caller.
 */

const BRAND_CANONICAL = Object.freeze({
  'guess-europe-sagl': ['guess', 'guess-europe', 'guess-sagl', 'guess-europe-switzerland', 'guess-ticino'],
  'medacta-international-sa': ['medacta', 'medacta-international', 'medacta-sa', 'medacta-italia', 'medacta-rancate'],
  'casale-sa': ['casale', 'casale-lugano', 'casale-chemical', 'casale-group'],
  migros: ['migros-ticino', 'gruppo-migros'],
  'soh-solothurner-spitaeler': ['solothurner-spitaeler'],
  'hoch-health': ['kssg'],
  paraplegie: ['spz'],
  'spital-thurgau': ['stgag'],
  tschuggen: ['bewerbermanagement-stellen'],
  'buergenstock-hotels': ['burgenstock-collection'],
  gkb: ['gkb-jobservice'],
  'spital-davos': ['bewerbungsmanagement-spital-davos'],
  kzu: ['kzu-recruiting'],
  'spital-zollikerberg': ['diakoniewerk-neumuenster'],
});

const ALIAS_TO_CANONICAL = new Map(
  Object.entries(BRAND_CANONICAL).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
);

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rawCompanySlug(company) {
  return norm(company).replace(/\s+/g, '-');
}

export function canonicalCompanyProfileSlug(company, companyKey) {
  const key = norm(companyKey);
  const name = norm(company);
  if (!key && !name) return '';
  const base = key.includes('lidl') || name.includes('lidl')
    ? 'lidl'
    : rawCompanySlug(company);
  return ALIAS_TO_CANONICAL.get(base) || base;
}
