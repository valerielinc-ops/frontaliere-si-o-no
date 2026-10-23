import {
  isCantonOnlyLabel,
  isKnownSwissMunicipalityInCanton,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Keep Medimeo's structured locality source-backed when the source advertises
 * several areas. A bare/ambiguous canton token such as `Biel` or `Soletta`
 * cannot survive the assembler's canton reconciliation when the resolved
 * canton is SO; use the concrete municipality named by the same source
 * location instead (`Solothurn`).
 *
 * @param {string} location source display location
 * @param {string} addressLocality structured locality selected from the source
 * @param {string} canton resolved Swiss canton code
 * @returns {string}
 */
export function selectMedimeoAddressLocality(location = '', addressLocality = '', canton = '') {
  const sourceLocation = normalizeSpace(location);
  const sourceLocality = normalizeSpace(addressLocality);
  if (!sourceLocality || !sourceLocation || !isCantonOnlyLabel(sourceLocality)) {
    return sourceLocality || sourceLocation.split(/[,;/|]/)[0].trim();
  }

  const sourceMunicipality = sourceLocation
    .split(/[,;/|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => swissCityFromLocationField(part, canton))
    .find((candidate) => candidate
      && isKnownSwissMunicipalityInCanton(candidate, canton, { allowOfficialLocality: true }));

  return sourceMunicipality || sourceLocation;
}
