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
  FR: '1700',
  NE: '2000',
  ZG: '6300',
  SH: '8200',
  SO: '4500',
  TG: '8500',
  VS: '1950',
};

/** Default postal code when nothing else resolves — canton capital of Ticino. */
export const DEFAULT_POSTAL_CODE = '6500';

/**
 * Resolve a postal code for a given city string, falling back to the
 * canton capital and finally to the Ticino default. Never returns an
 * empty string.
 */
export function resolvePostalCode(
  city: string | undefined | null,
  canton: string | undefined | null,
): string {
  if (city) {
    const key = String(city).trim().toLowerCase();
    if (POSTAL_BY_CITY[key]) return POSTAL_BY_CITY[key];
  }
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
