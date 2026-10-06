/**
 * Official Swiss directory of localities (swisstopo with Swiss Post, see
 * data/swiss-locality-postal-codes.json and
 * scripts/generate-swiss-locality-postal-codes.mjs): the canton or the CAP of
 * a locality the source names, never a guess among several.
 */
import SWISS_LOCALITY_POSTAL_CODES from '../../data/swiss-locality-postal-codes.json' with { type: 'json' };
import SWISS_POSTAL_CODE_INDEX from '../../data/swiss-postal-code-index.json' with { type: 'json' };

function directoryKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*\([a-z]{2}\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let localityDirectory = null;
// Official directory of localities (swisstopo/Swiss Post, see
// data/swiss-locality-postal-codes.json): name -> [{ canton, postalCode }],
// the name without its canton qualifier ("Rüti (ZH)" is "Rüti"). A longer
// official name is another locality: "Bremgarten bei Bern" is not indexed as
// "Bremgarten" — the VTG posting "Bremgarten" in region Espace Mittelland
// is the barracks at 5620 Bremgarten (AG), whatever the region says.
function swissLocalityDirectory() {
  if (localityDirectory) return localityDirectory;
  const byName = new Map();
  const byPostalCode = new Map();
  const add = (key, entry) => {
    if (!key) return;
    const list = byName.get(key) || [];
    list.push(entry);
    byName.set(key, list);
  };
  for (const [canton, localities] of Object.entries(SWISS_LOCALITY_POSTAL_CODES?.cantons || {})) {
    for (const [name, rawPostalCode] of Object.entries(localities || {})) {
      const postalCode = String(rawPostalCode || '');
      const key = directoryKey(name);
      add(key, { canton, postalCode });
      const cantons = byPostalCode.get(postalCode) || new Set();
      cantons.add(canton);
      byPostalCode.set(postalCode, cantons);
    }
  }
  localityDirectory = { byName, byPostalCode };
  return localityDirectory;
}

/**
 * Canton of a Swiss locality from the official directory, or '' when the
 * directory does not place it in exactly one canton. `postalCode` (the CAP
 * the source prints next to the locality) and `cantons` (the cantons the
 * source allows, e.g. its region facet) narrow the candidates; nothing is
 * guessed among several. Bronschhofen, a former municipality missing from
 * the BFS list, is "9552 Bronschhofen" in St. Gallen; "Rüti" is placed only
 * with a region that says Zürich.
 */
export function resolveSwissLocalityCanton(locality = '', { postalCode = '', cantons = null } = {}) {
  const key = directoryKey(locality);
  if (!key) return '';
  const allowed = cantons && [...cantons].length > 0 ? new Set(cantons) : null;
  const postal = String(postalCode || '').trim();
  const { byName, byPostalCode } = swissLocalityDirectory();
  const entries = byName.get(key) || [];
  const unique = (list) => {
    const found = new Set(list.map((entry) => entry.canton).filter((canton) => !allowed || allowed.has(canton)));
    if (found.size === 1) return [...found][0];
    return found.size > 1 ? null : '';
  };
  // The name listed with the source's own CAP.
  if (postal) {
    const exact = unique(entries.filter((entry) => entry.postalCode === postal));
    if (exact) return exact;
  }
  // The name alone.
  const byNameOnly = unique(entries);
  if (byNameOnly === null) return '';
  if (byNameOnly) {
    // A CAP the directory lists only in other cantons contradicts the name.
    const postalCantons = postal ? byPostalCode.get(postal) : null;
    if (postalCantons && !postalCantons.has(byNameOnly)) return '';
    return byNameOnly;
  }
  // A locality the directory does not list: its CAP alone, when unambiguous.
  if (postal && entries.length === 0) {
    const byPostal = unique([...(byPostalCode.get(postal) || [])].map((canton) => ({ canton })));
    if (byPostal) return byPostal;
  }
  return '';
}

/**
 * CAP of a Swiss locality from the official directory (one per canton-scoped
 * name), or '' when the directory does not list the name, or lists it in
 * several cantons and `canton` does not pick one. For crawlers whose source
 * names only the locality: the CAP follows the real locality ("Reiden" LU is
 * 6260), never a canton-level stand-in (Volg published Reiden as 5000, the
 * CAP of Aarau AG, and Winterthur as 8000).
 */
export function officialLocalityPostalCode(locality = '', canton = '') {
  const key = directoryKey(locality);
  if (!key) return '';
  const wanted = String(canton || '').trim().toUpperCase();
  const entries = (swissLocalityDirectory().byName.get(key) || [])
    .filter((entry) => !wanted || entry.canton === wanted);
  const postalCodes = new Set(entries.map((entry) => entry.postalCode).filter(Boolean));
  return postalCodes.size === 1 ? [...postalCodes][0] : '';
}

/**
 * Whether the official directory recognises a locality, even when its name
 * maps to more than one CAP and therefore cannot produce one unambiguous
 * answer. Callers may use this to distinguish "unknown place" (where a
 * conservative canton fallback can still be useful) from "known place but
 * ambiguous" (where inventing the canton capital would be wrong).
 *
 * @param {string} locality
 * @param {string} canton — retained for the resolver API; a canton mismatch
 * is still a known locality conflict, not an unknown free-text label.
 * @returns {boolean}
 */
export function hasOfficialSwissLocality(locality = '', canton = '') {
  const key = directoryKey(locality);
  if (!key) return false;
  // Do not turn a known locality plus a contradictory canton into an
  // invitation to use that canton's capital CAP. The contradiction needs
  // review; it is not the same as source free text that the directory cannot
  // identify at all.
  return (swissLocalityDirectory().byName.get(key) || []).length > 0;
}

/**
 * Resolve the CAP from the locality text that a crawler emitted. The return
 * value deliberately carries `known`: a known locality without one unique
 * CAP must block the later canton-capital fallback, while an unknown source
 * label may still use the legacy fallback for backward-compatible coverage.
 *
 * @param {string} location
 * @param {string} canton
 * @returns {{ postalCode: string, known: boolean }}
 */
export function officialPostalCodeForLocation(location = '', canton = '') {
  const raw = String(location || '').trim();
  if (!raw) return { postalCode: '', known: false };
  const withoutPostal = raw.replace(/\b\d{4}\b/g, ' ').replace(/\s+/g, ' ').trim();
  const candidates = [
    withoutPostal,
    ...withoutPostal.split(/[,·\-/]/).map((part) => part.trim()),
  ].filter(Boolean);
  let known = false;
  for (const candidate of candidates) {
    const postalCode = officialLocalityPostalCode(candidate, canton);
    if (postalCode) return { postalCode, known: true };
    if (hasOfficialSwissLocality(candidate, canton)) known = true;
  }
  return { postalCode: '', known };
}

/**
 * The locality and canton the official directory gives a Swiss postal code,
 * or null when the code is unknown or not unique (data/swiss-postal-code-index.json,
 * scripts/generate-swiss-postal-code-index.mjs): a code shared by several
 * cantons or several localities is never resolved, and Liechtenstein codes
 * have no entry. For a source that states an address, not a place name.
 *
 * @param {string|number} postalCode
 * @returns {{ canton: string, locality: string } | null}
 */
export function resolveSwissPostalCodePlace(postalCode = '') {
  const code = String(postalCode ?? '').trim();
  if (!/^\d{4}$/.test(code)) return null;
  const entry = SWISS_POSTAL_CODE_INDEX?.postalCodes?.[code];
  return Array.isArray(entry) && entry.length === 2 ? { canton: entry[0], locality: entry[1] } : null;
}
