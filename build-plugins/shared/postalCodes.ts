/**
 * Swiss postal-code lookup by city name — fallback when source job data
 * lacks an explicit `postalCode`. Focused on Ticino + Grigioni (our
 * primary audience) plus the major Swiss cities that appear regularly
 * in crawler output.
 *
 * CLAUDE.md rule #3: `JobPosting.jobLocation.address.postalCode` must
 * always be present. This map + the canton-capital fallback guarantees
 * we never emit an empty postal code.
 */

import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json';
import SWISS_LOCALITY_POSTAL_CODES from '../../data/swiss-locality-postal-codes.json';

/** Ticino primary cities → postal codes. */
export const TICINO_POSTAL_BY_CITY: Record<string, string> = {
  'lugano': '6900',
  'bellinzona': '6500',
  'locarno': '6600',
  'mendrisio': '6850',
  'chiasso': '6830',
  'biasca': '6710',
  'acquarossa': '6716',
  'agno': '6982',
  'manno': '6928',
  'stabio': '6855',
  'giubiasco': '6512',
  'ascona': '6612',
  'paradiso': '6900',
  'massagno': '6900',
  'cadenazzo': '6593',
  'mezzovico': '6805',
  'balerna': '6828',
  'bedano': '6930',
  'airolo': '6780',
  'faido': '6760',
  'rivera': '6802',
  'castione': '6532',
  'arbedo': '6517',
  'pregassona': '6963',
  'montagnola': '6926',
  'castel san pietro': '6874',
  'quartino': '6572',
  's. antonino': '6592',
  'sant antonino': '6592',
  'muralto': '6600',
  'minusio': '6648',
  'losone': '6616',
  'tenero': '6598',
  'tesserete': '6950',
  'taverne': '6807',
  'melide': '6815',
  'morcote': '6922',
  'caslano': '6987',
  'ponte tresa': '6988',
  'porza': '6948',
  'viganello': '6962',
  'canobbio': '6952',
  'gordola': '6596',
};

/** Grigioni (Italian-speaking) postal codes. */
export const GRIGIONI_POSTAL_BY_CITY: Record<string, string> = {
  'chur': '7000',
  'coira': '7000',
  'davos': '7270',
  'st. moritz': '7500',
  'saint moritz': '7500',
  'landquart': '7302',
  'ilanz': '7130',
  'thusis': '7430',
  'poschiavo': '7742',
  'samedan': '7503',
};

/** Major Swiss cities (outside TI / GR) — postal codes for their central district. */
export const MAJOR_CH_POSTAL_BY_CITY: Record<string, string> = {
  'zurich': '8001',
  'zürich': '8001',
  'zurigo': '8001',
  'winterthur': '8400',
  'bern': '3001',
  'berna': '3001',
  'basel': '4001',
  'basilea': '4001',
  'geneva': '1201',
  'genève': '1201',
  'ginevra': '1201',
  'genf': '1201',
  'lausanne': '1003',
  'losanna': '1003',
  'luzern': '6000',
  'lucerna': '6000',
  'lucerne': '6000',
  'st. gallen': '9000',
  'san gallo': '9000',
  'fribourg': '1700',
  'friburgo': '1700',
  'neuchâtel': '2000',
  'zug': '6300',
  'schaffhausen': '8200',
  'solothurn': '4500',
  'frauenfeld': '8500',
  'sion': '1950',
  'brig': '3900',
  'visp': '3930',
  'sierre': '3960',
  'martigny': '1920',
};

/**
 * Unified city → postal-code lookup. Order matters: TI wins over GR
 * over major cities if a slug happens to collide.
 */
export const POSTAL_BY_CITY: Record<string, string> = {
  ...MAJOR_CH_POSTAL_BY_CITY,
  ...GRIGIONI_POSTAL_BY_CITY,
  ...TICINO_POSTAL_BY_CITY,
};

/**
 * Known city/postal pairs used as a coherence guard, not as an exhaustive
 * address directory. The source snapshot intentionally contains only one
 * representative postal code for some municipalities, so unknown postcodes
 * remain admissible; a known postcode belonging to another known locality does
 * not. This catches the recurring "valid CAP, wrong city" class without
 * rejecting legitimate secondary CAPs that are absent from the snapshot.
 */
export function normalizePostalCityKey(value: string | undefined | null): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalized lookup for the complete snapshot, with curated aliases taking
 * precedence. The curated table is intentionally small; the snapshot fills
 * the gap for valid municipalities such as Novaggio that are not frequent
 * enough to need a hand-maintained alias.
 */
const NORMALIZED_POSTAL_BY_CITY = new Map<string, string>(
  [
    ...Object.entries(SWISS_POSTAL_CODES as Record<string, string>),
    ...Object.entries(POSTAL_BY_CITY),
  ]
    .map(([city, postalCode]) => [normalizePostalCityKey(city), String(postalCode || '').trim()] as const)
    .filter(([city, postalCode]) => city.length > 0 && /^\d{4}$/.test(postalCode)),
);

const KNOWN_CITY_KEYS_BY_POSTAL = new Map<string, Set<string>>();
for (const [city, postalCode] of [
  ...Object.entries(SWISS_POSTAL_CODES as Record<string, string>),
  ...Object.entries(POSTAL_BY_CITY),
]) {
  const postal = String(postalCode || '').trim();
  const cityKey = normalizePostalCityKey(city);
  if (!/^\d{4}$/.test(postal) || !cityKey) continue;
  const cities = KNOWN_CITY_KEYS_BY_POSTAL.get(postal) || new Set<string>();
  cities.add(cityKey);
  KNOWN_CITY_KEYS_BY_POSTAL.set(postal, cities);
}

/**
 * Return false only when the source postcode is known to belong to a different
 * locality than the already-sanitised schema city. Unknown postcodes return
 * true deliberately: this guard rejects contradictions, it does not pretend
 * the representative fallback dataset is a complete postal registry.
 */
export function isPostalCodeCoherentWithCity(
  city: string | undefined | null,
  postalCode: string | undefined | null,
): boolean {
  const postal = String(postalCode || '').trim();
  const knownCities = KNOWN_CITY_KEYS_BY_POSTAL.get(postal);
  if (!knownCities || knownCities.size === 0) return true;
  return knownCities.has(normalizePostalCityKey(city));
}

/**
 * Canton-scoped CAP of every BFS municipality and official locality, from the
 * swisstopo/Swiss Post directory of localities with postcodes (see
 * `scripts/generate-swiss-locality-postal-codes.mjs` for the source and the
 * principal-CAP rule). Keys drop the lookup canton's code as a trailing token
 * (BFS "Küsnacht (ZH)", Swiss Post "Küsnacht ZH", crawler "Kirchberg BE -"),
 * so the three spellings reach 8700 in ZH and never Küssnacht SZ, and fold
 * "Sankt"/"Saint" to "St" and "bei" to "b" (Swiss Post abbreviations).
 */
function officialLocalityKey(name: string | undefined | null, canton: string): string {
  const key = normalizePostalCityKey(name)
    .replace(/\b(?:sankt|saint)\b/g, 'st')
    .replace(/\bbei\b/g, 'b');
  const suffix = ` ${canton.toLowerCase()}`;
  return key.endsWith(suffix) ? key.slice(0, -suffix.length).trim() : key;
}

const OFFICIAL_POSTAL_BY_CANTON_LOCALITY = new Map<string, string>();
const OFFICIAL_CANTONS_BY_LOCALITY = new Map<string, Set<string>>();
{
  const cantonEntries = Object.entries(
    (SWISS_LOCALITY_POSTAL_CODES as { cantons: Record<string, Record<string, string>> }).cantons,
  );
  const add = (canton: string, key: string, postalCode: string) => {
    if (!key || !/^\d{4}$/.test(postalCode)) return;
    if (!OFFICIAL_POSTAL_BY_CANTON_LOCALITY.has(`${canton}|${key}`)) {
      OFFICIAL_POSTAL_BY_CANTON_LOCALITY.set(`${canton}|${key}`, postalCode);
    }
    const cantons = OFFICIAL_CANTONS_BY_LOCALITY.get(key) || new Set<string>();
    cantons.add(canton);
    OFFICIAL_CANTONS_BY_LOCALITY.set(key, cantons);
  };
  for (const [canton, entries] of cantonEntries) {
    for (const [name, postalCode] of Object.entries(entries)) add(canton, officialLocalityKey(name, canton), postalCode);
  }
  // Bilingual names ("Biel/Bienne", "Lenzerheide/Lai", "Vaz/Obervaz") are also
  // reachable by each half, unless that half is already a name of its own.
  for (const [canton, entries] of cantonEntries) {
    for (const [name, postalCode] of Object.entries(entries)) {
      if (!name.includes('/')) continue;
      for (const part of name.split('/')) {
        const key = officialLocalityKey(part, canton);
        if (key && !OFFICIAL_POSTAL_BY_CANTON_LOCALITY.has(`${canton}|${key}`)) add(canton, key, postalCode);
      }
    }
  }
}

/**
 * The CAP of the locality itself, or '' when no table knows it. Never falls
 * back to another locality: an unknown locality must not borrow the canton
 * capital's CAP (issue 9852, `Pully` next to Lausanne's 1003).
 *
 * The curated aliases and the snapshot keep precedence, as before. They are
 * keyed by name only, so for a name that exists in several cantons (Gossau SG
 * and ZH, Buchs AG/LU/SG/ZH) the canton-scoped official entry wins: the
 * name-only value is right for one canton at most.
 */
export function resolveLocalityPostalCode(
  city: string | undefined | null,
  canton: string | undefined | null,
): string {
  const cantonCode = String(canton || '').toUpperCase().trim();
  const key = normalizePostalCityKey(city);
  if (!key) return '';
  const officialKey = cantonCode ? officialLocalityKey(city, cantonCode) : '';
  const official = officialKey ? OFFICIAL_POSTAL_BY_CANTON_LOCALITY.get(`${cantonCode}|${officialKey}`) || '' : '';
  const isCrossCantonHomonym = (OFFICIAL_CANTONS_BY_LOCALITY.get(officialKey)?.size || 0) > 1;
  if (official && isCrossCantonHomonym) return official;
  return NORMALIZED_POSTAL_BY_CITY.get(key) || official;
}

/**
 * Same contract as `isPostalCodeCoherentWithCity`, for a locality that may
 * still carry a suffix ("Dübendorf-Stettbach", "Gossau SG",
 * "Bedano, CH, 6930"): the postcode belongs to it when the locality is, or
 * starts with, one of the localities the snapshot binds to that postcode.
 * A place merely mentioning that locality later ("Muri bei Bern") does not
 * inherit its postcode. Unknown postcodes and empty localities stay
 * admissible. Used wherever a page prints a CAP next to a city (job sidebar,
 * SPA location snapshot), so a company-HQ CAP stamped on every vacancy never
 * reaches the reader next to another city (#9841).
 */
export function postalCodeBelongsToLocality(
  locality: string | undefined | null,
  postalCode: string | undefined | null,
): boolean {
  const postal = String(postalCode || '').trim();
  const knownCities = KNOWN_CITY_KEYS_BY_POSTAL.get(postal);
  if (!knownCities || knownCities.size === 0) return true;
  const localityKey = normalizePostalCityKey(locality);
  if (!localityKey) return true;
  for (const cityKey of knownCities) {
    if (localityKey === cityKey || localityKey.startsWith(`${cityKey} `)) return true;
  }
  return false;
}

/** Canton → capital postal code (last-resort fallback). */
export const CANTON_CAPITAL_POSTAL: Record<string, string> = {
  TI: '6500',
  GR: '7000',
  ZH: '8001',
  BE: '3001',
  BS: '4001',
  GE: '1201',
  VD: '1003',
  LU: '6000',
  SG: '9000',
  AG: '5000',
  AI: '9050',
  AR: '9100',
  BL: '4410',
  FR: '1700',
  NE: '2000',
  GL: '8750',
  JU: '2800',
  NW: '6370',
  OW: '6060',
  ZG: '6300',
  SH: '8200',
  SO: '4500',
  SZ: '6430',
  TG: '8500',
  UR: '6460',
  VS: '1950',
};

/** Default postal code when nothing else resolves — canton capital of Ticino. */
export const DEFAULT_POSTAL_CODE = '6500';

/**
 * Resolve a postal code for a given city string, falling back to the
 * canton capital and finally to the Ticino default. Never returns an
 * empty string. The capital fallback is a CAP of ANOTHER locality: a
 * JobPosting address must use `resolveLocalityPostalCode` instead and never
 * pair it with a different `addressLocality`.
 */
export function resolvePostalCode(
  city: string | undefined | null,
  canton: string | undefined | null,
): string {
  const localityPostalCode = resolveLocalityPostalCode(city, canton);
  if (localityPostalCode) return localityPostalCode;
  if (canton) {
    const cap = CANTON_CAPITAL_POSTAL[String(canton).toUpperCase().trim()];
    if (cap) return cap;
  }
  return DEFAULT_POSTAL_CODE;
}

/**
 * A postal code is valid only when it is exactly 4 digits (CH format)
 * or 5 digits (European-wide acceptance — e.g. crawlers that leak Italian
 * CAPs). Used by the canonical `buildJobPostingSchema` to decide whether
 * to trust a source value before falling back.
 */
export function isValidPostalCode(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^\d{4,5}$/.test(String(value).trim());
}
