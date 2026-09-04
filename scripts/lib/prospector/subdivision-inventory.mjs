/**
 * Foreign subdivision evidence used by the Swiss-only Prospector resolver.
 *
 * Snapshot: ISO 3166-2 Online Browsing Platform, checked 2026-08-31.
 * Source: https://www.iso.org/obp/ui/#iso:code:3166:US,
 * https://www.iso.org/obp/ui/#iso:code:3166:CA,
 * https://www.iso.org/obp/ui/#iso:code:3166:DE and
 * https://www.iso.org/obp/ui/#iso:code:3166:AU.
 *
 * US/CA two-letter subdivisions are the dangerous collision class: they look
 * exactly like Swiss canton suffixes in strings such as `Geneva NY` or
 * `Zurich ON`. German Länder cover the observed long-name collision
 * `Baden-Württemberg`. Structured `addressRegion` values are handled even more
 * conservatively by the resolver: any non-empty region that is not a Swiss
 * canton is foreign evidence, so this inventory is needed only for unstructured
 * terminal text.
 */
export const SUBDIVISION_INVENTORY_VERSION = 'ISO-3166-2:checked-2026-08-31; US+CA+DE+AU complete';

export const FOREIGN_SUBDIVISION_CODES = new Set(`
AL AK AS AZ AR CA CO CT DE DC FL GA GU HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PA PR RI SC SD TN TX UM UT VT VA VI WA WV WI WY
AB BC MB NB NL NS NT NU ON PE QC SK YT
BW BY BE BB HB HH HE MV NI NW RP SL SN ST SH TH
ACT NSW NT QLD SA TAS VIC WA
`.trim().split(/\s+/));

const RAW_NAMES = [
  'Alabama', 'Alaska', 'American Samoa', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'District of Columbia', 'Florida', 'Georgia', 'Guam', 'Hawaii',
  'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana',
  'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
  'North Carolina', 'North Dakota', 'Northern Mariana Islands', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Puerto Rico', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'United States Minor Outlying Islands', 'Utah', 'Vermont', 'Virginia',
  'Virgin Islands', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
  'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Québec', 'Saskatchewan', 'Yukon',
  'Baden-Württemberg', 'Bayern', 'Bavaria', 'Berlin', 'Brandenburg', 'Bremen', 'Hamburg',
  'Hessen', 'Hesse', 'Mecklenburg-Vorpommern', 'Niedersachsen', 'Lower Saxony',
  'Nordrhein-Westfalen', 'North Rhine-Westphalia', 'Rheinland-Pfalz', 'Rhineland-Palatinate',
  'Saarland', 'Sachsen', 'Saxony', 'Sachsen-Anhalt', 'Saxony-Anhalt',
  'Schleswig-Holstein', 'Thüringen', 'Thuringia',
  'Australian Capital Territory', 'New South Wales', 'Northern Territory',
  'Queensland', 'South Australia', 'Tasmania', 'Victoria', 'Western Australia',
];

const normalize = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const FOREIGN_SUBDIVISION_NAMES = new Set(RAW_NAMES.map(normalize));

/** @param {unknown} value */
export function isKnownForeignSubdivision(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return FOREIGN_SUBDIVISION_CODES.has(raw.toUpperCase())
    || FOREIGN_SUBDIVISION_NAMES.has(normalize(raw));
}

/** @param {unknown} value */
export function hasKnownForeignSubdivisionSuffix(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  // Subdivision evidence precedes the postal code in the common international
  // address shapes (`Geneva NY14456`, `Zurich ON N0J1Z0`, `Geneva NSW2000`).
  // Strip only a terminal postal token, then classify the subdivision. This is
  // deliberately done before generic location inference so the postal digits
  // cannot hide authoritative foreign evidence.
  const beforePostal = raw.replace(
    /(?:\s*[-,]?\s*)(?:[A-Z]\d[A-Z][ -]?\d[A-Z]\d|\d{5}(?:-\d{4})?|\d{4,10})[.!?:)]*$/i,
    '',
  ).trim();
  const code = beforePostal.match(/(?:^|[\s,;/|()])([A-Za-z]{2,3})[.!?:)]*$/)?.[1];
  if (code && FOREIGN_SUBDIVISION_CODES.has(code.toUpperCase())) return true;
  const normalized = normalize(beforePostal);
  return [...FOREIGN_SUBDIVISION_NAMES].some(
    (name) => normalized === name || normalized.endsWith(` ${name}`),
  );
}
