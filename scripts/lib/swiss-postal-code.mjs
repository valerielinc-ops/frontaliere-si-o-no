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

// Keep every catalogue value for a normalized locality. If a future refresh
// adds homonymous localities with different CAPs, a locality-only lookup must
// become unknown instead of silently choosing whichever entry was last loaded.
const POSTAL_CODES_BY_LOCALITY = new Map();
for (const [locality, postalCode] of Object.entries(POSTAL_CODES)) {
  const key = normalize(locality);
  if (!key) continue;
  const values = POSTAL_CODES_BY_LOCALITY.get(key) || new Set();
  values.add(String(postalCode));
  POSTAL_CODES_BY_LOCALITY.set(key, values);
}
const POSTAL_CODES_SET = new Set(
  [...POSTAL_CODES_BY_LOCALITY.values()].flatMap((values) => [...values]),
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
  if (explicit && POSTAL_CODES_SET.has(explicit[1])) {
    return explicit[1];
  }

  const candidates = [
    raw,
    ...raw.split(/[,;|]/).map((part) => part.trim()),
  ];
  for (const candidate of candidates) {
    const postalCodes = POSTAL_CODES_BY_LOCALITY.get(normalize(candidate));
    if (postalCodes?.size === 1) return postalCodes.values().next().value;
  }
  return '';
}
