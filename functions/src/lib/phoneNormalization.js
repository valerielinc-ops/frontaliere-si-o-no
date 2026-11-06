/**
 * Canonical contact values shared by the portal runner and the owner's
 * browser extension.
 *
 * Phone numbers are stored as international values when the source provides a
 * country prefix. The visible grouping is deliberately applied only at the
 * form boundary: portals with a separate prefix control receive the national
 * part, while a single input receives a readable international value.
 */

const PHONE_COUNTRIES = [
  { code: 'IT', dial: '39', labels: { it: 'Italia', de: 'Italien', fr: 'Italie', en: 'Italy' } },
  { code: 'CH', dial: '41', labels: { it: 'Svizzera', de: 'Schweiz', fr: 'Suisse', en: 'Switzerland' } },
  { code: 'DE', dial: '49', labels: { it: 'Germania', de: 'Deutschland', fr: 'Allemagne', en: 'Germany' } },
  { code: 'FR', dial: '33', labels: { it: 'Francia', de: 'Frankreich', fr: 'France', en: 'France' } },
  { code: 'AT', dial: '43', labels: { it: 'Austria', de: 'Österreich', fr: 'Autriche', en: 'Austria' } },
  { code: 'BE', dial: '32', labels: { it: 'Belgio', de: 'Belgien', fr: 'Belgique', en: 'Belgium' } },
  { code: 'ES', dial: '34', labels: { it: 'Spagna', de: 'Spanien', fr: 'Espagne', en: 'Spain' } },
  { code: 'GB', dial: '44', labels: { it: 'Regno Unito', de: 'Vereinigtes Königreich', fr: 'Royaume-Uni', en: 'United Kingdom' } },
  { code: 'NL', dial: '31', labels: { it: 'Paesi Bassi', de: 'Niederlande', fr: 'Pays-Bas', en: 'Netherlands' } },
  { code: 'PT', dial: '351', labels: { it: 'Portogallo', de: 'Portugal', fr: 'Portugal', en: 'Portugal' } },
];

const fold = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ß/g, 'ss')
  .toLowerCase()
  .replace(/[^a-z0-9+]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const countryByCode = new Map(PHONE_COUNTRIES.map((country) => [country.code, country]));
const countryByDial = new Map(PHONE_COUNTRIES.map((country) => [country.dial, country]));

function countryFromDial(value) {
  const digits = String(value || '').replace(/\D/g, '');
  // Longest first prevents a short prefix from winning over a more specific
  // one (for example +351 versus +3).
  return [...countryByDial.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([dial]) => digits.startsWith(dial))?.[1] || null;
}

/** Return a compact international phone value, or a cleaned national value. */
export function normalizePhone(value) {
  const raw = String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const international = raw.startsWith('+') || /^00(?:\s|[.(\-]?\d)/.test(raw);
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (international) return `+${raw.startsWith('+') ? digits : digits.replace(/^00/, '')}`;
  // A national number must not be assigned a country by guesswork. Keep its
  // separators readable; the country is supplied by a separate form control
  // when the portal has one.
  return raw.replace(/[^\d()./ +\-]/g, '').replace(/\s+/g, ' ').trim();
}

export function phoneCountryCode(value) {
  const normalized = normalizePhone(value);
  if (!normalized.startsWith('+')) return '';
  return countryFromDial(normalized.slice(1))?.code || '';
}

export function phoneDialCode(value) {
  const normalized = normalizePhone(value);
  if (!normalized.startsWith('+')) return '';
  return countryFromDial(normalized.slice(1))?.dial || '';
}

/** Match a country option or a location suffix to a small, explicit ISO set. */
export function countryCodeOfLabel(value) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const text = fold(raw);
  if (!text) return '';
  for (const country of PHONE_COUNTRIES) {
    const names = [country.code.toLowerCase(), country.dial, ...Object.values(country.labels).map(fold)];
    if (names.some((name) => text === name || text.includes(` ${name}`) || text.includes(`${name} `))) return country.code;
    if (new RegExp(`(?:^|[ (\\[{: /\\-–—])\\+?${country.dial}(?=$|[ )\\]}: /\\-–—])`).test(raw)) return country.code;
  }
  return '';
}

export function phoneCountryLabel(value, locale = 'it') {
  const country = countryByCode.get(phoneCountryCode(value));
  if (!country) return '';
  const language = String(locale || '').slice(0, 2).toLowerCase();
  return country.labels[language] || country.labels.it;
}

export function countryLabelForCode(code, locale = 'it') {
  const country = countryByCode.get(String(code || '').trim().toUpperCase());
  if (!country) return '';
  const language = String(locale || '').slice(0, 2).toLowerCase();
  return country.labels[language] || country.labels.it;
}

export function phoneNationalPart(value, prefix = '') {
  const normalized = normalizePhone(value);
  if (!normalized.startsWith('+')) return normalized.replace(/\D/g, '');
  const dial = String(prefix || '').replace(/\D/g, '') || phoneDialCode(normalized);
  const digits = normalized.slice(1).replace(/\D/g, '');
  return dial && digits.startsWith(dial) ? digits.slice(dial.length) : digits;
}

function formatNationalPart(value, countryCode = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (countryCode === 'IT' && digits.length === 10 && digits.startsWith('3')) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  if (countryCode === 'CH' && digits.length === 9) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}`;
  return digits;
}

/** Readable value for one input that contains both country prefix and number. */
export function formatInternationalPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized.startsWith('+')) return normalized;
  const country = countryFromDial(normalized.slice(1));
  if (!country) return normalized;
  const national = phoneNationalPart(normalized, country.dial);
  return `+${country.dial} ${formatNationalPart(national, country.code)}`.trim();
}

/** Value to type into a specific form control. */
export function formatPhoneForField(value, { countryPrefix = '', separateCountryCode = false, maxLength = 0 } = {}) {
  const normalized = normalizePhone(value);
  if (!normalized) return '';
  const prefix = String(countryPrefix || '').trim();
  if (separateCountryCode || prefix) {
    const code = countryByDial.get(prefix.replace(/\D/g, ''))?.code || phoneCountryCode(normalized);
    const national = formatNationalPart(phoneNationalPart(normalized, prefix), code);
    return maxLength > 0 && national.length > maxLength ? national.replace(/\D/g, '') : national;
  }
  const formatted = formatInternationalPhone(normalized);
  return maxLength > 0 && formatted.length > maxLength ? normalized : formatted;
}

export const PHONE_COUNTRY_CATALOGUE = PHONE_COUNTRIES.map((country) => ({
  code: country.code,
  dial: country.dial,
  labels: { ...country.labels },
}));
