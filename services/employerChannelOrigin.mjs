const EMPLOYER_ORIGIN_INVALID_CHARACTERS = /[^a-z0-9_-]/giu;

/** Keep QR/source attribution technical, bounded, and free of personal data. */
export function normalizeEmployerOrigin(value) {
  return String(value ?? '').trim().replace(EMPLOYER_ORIGIN_INVALID_CHARACTERS, '').slice(0, 48);
}
