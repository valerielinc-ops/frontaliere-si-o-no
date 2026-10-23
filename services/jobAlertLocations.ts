/**
 * Canonical alert location values are lowercase, locale-independent slugs.
 * Keep display labels separate so route titles never leak into alert configs.
 */
export const JOB_ALERT_LOCATIONS = [
  { value: 'lugano', label: 'Lugano' },
  { value: 'mendrisio', label: 'Mendrisio' },
  { value: 'bellinzona', label: 'Bellinzona' },
  { value: 'locarno', label: 'Locarno' },
  { value: 'chiasso', label: 'Chiasso' },
  { value: 'coira', label: 'Coira / Chur' },
] as const;

function normalizeLocationKey(value: string): string {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('en')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const KNOWN_LOCATION_VALUES = new Map<string, string>();
const KNOWN_LOCATION_LABELS = new Map<string, string>();
for (const location of JOB_ALERT_LOCATIONS) {
  KNOWN_LOCATION_VALUES.set(normalizeLocationKey(location.value), location.value);
  KNOWN_LOCATION_VALUES.set(normalizeLocationKey(location.label), location.value);
  KNOWN_LOCATION_LABELS.set(location.value, location.label);
  for (const alias of location.label.split('/')) {
    KNOWN_LOCATION_VALUES.set(normalizeLocationKey(alias), location.value);
  }
}

/** Normalize a route slug or city label to the value stored in JobAlertConfig. */
export function normalizeJobAlertLocationValue(location: string): string {
  const key = normalizeLocationKey(location);
  if (!key) return '';
  return KNOWN_LOCATION_VALUES.get(key) ?? key;
}

/** Normalize and deduplicate seeded selections before they enter component state. */
export function normalizeJobAlertLocationValues(locations: readonly string[]): string[] {
  return Array.from(new Set(locations.map(normalizeJobAlertLocationValue).filter(Boolean)));
}

/** Resolve a canonical value back to a human-readable label for the UI. */
export function getJobAlertLocationLabel(location: string): string {
  const value = normalizeJobAlertLocationValue(location);
  return KNOWN_LOCATION_LABELS.get(value)
    ?? value.split('-').map((part) => `${part.charAt(0).toLocaleUpperCase('en')}${part.slice(1)}`).join(' ');
}
