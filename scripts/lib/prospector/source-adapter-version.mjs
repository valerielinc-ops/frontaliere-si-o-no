/**
 * Versioned identity of the extraction implementation that produced validation
 * evidence. Historical rows without a value came from this generic runner, so
 * they normalize to its frozen first explicit version instead of meaning "no
 * filter". Only CURRENT_GENERIC_SOURCE_ADAPTER_VERSION is bumpable: the legacy
 * identity must never move with it or old rows would be reclassified as new.
 */
export const LEGACY_GENERIC_SOURCE_ADAPTER_VERSION = 'generic-runner-v1';
export const CURRENT_GENERIC_SOURCE_ADAPTER_VERSION = 'generic-runner-v1';

/** The identity used by a validation run; malformed dedicated adapters fail closed. */
export function sourceAdapterVersionFor(adapter) {
  if (adapter && typeof adapter.version !== 'string') {
    throw new Error('source adapter dedicato senza version stringa');
  }
  const version = String(adapter?.version || '').trim();
  if (adapter && !version) throw new Error('source adapter dedicato senza version');
  return version || CURRENT_GENERIC_SOURCE_ADAPTER_VERSION;
}

/** The identity recorded on a candidate/history row, including legacy generic rows. */
export function recordedSourceAdapterVersion(record) {
  const recorded = record?.sourceAdapterVersion;
  if (recorded != null && typeof recorded !== 'string') {
    throw new Error('sourceAdapterVersion persistita non valida');
  }
  return String(recorded || '').trim() || LEGACY_GENERIC_SOURCE_ADAPTER_VERSION;
}
