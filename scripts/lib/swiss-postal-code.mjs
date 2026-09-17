import POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const POSTAL_CODES_BY_LOCALITY = new Map(
  Object.entries(POSTAL_CODES).map(([locality, postalCode]) => [normalize(locality), String(postalCode)]),
);

/**
 * Resolve a Swiss postal code only when the source locality is present in the
 * repository's postal catalogue. Unknown localities intentionally return an
 * empty value so the structured-data layer can apply its own canton-safe
 * fallback without pairing a guessed CAP with the wrong city.
 */
export function lookupSwissPostalCode(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const explicit = raw.match(/\b(\d{4})\b/);
  if (explicit && !(Number(explicit[1]) >= 2020 && Number(explicit[1]) <= 2039)) {
    return explicit[1];
  }

  const candidates = [
    raw,
    ...raw.split(/[,;|]/).map((part) => part.trim()),
  ];
  for (const candidate of candidates) {
    const postalCode = POSTAL_CODES_BY_LOCALITY.get(normalize(candidate));
    if (postalCode) return postalCode;
  }
  return '';
}
