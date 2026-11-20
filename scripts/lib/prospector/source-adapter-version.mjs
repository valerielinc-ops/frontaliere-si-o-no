/**
 * Versioned identity of the extraction implementation that produced validation
 * evidence. Historical rows without a value came from this generic runner, so
 * they normalize to its first explicit version instead of meaning "no filter".
 * Bump this value when the generic runner's extraction semantics change.
 */
export const GENERIC_SOURCE_ADAPTER_VERSION = 'generic-runner-v1';

/** The identity used by a validation run; malformed dedicated adapters fail closed. */
export function sourceAdapterVersionFor(adapter) {
  if (adapter && typeof adapter.version !== 'string') {
    throw new Error('source adapter dedicato senza version stringa');
  }
  const version = String(adapter?.version || '').trim();
  if (adapter && !version) throw new Error('source adapter dedicato senza version');
  return version || GENERIC_SOURCE_ADAPTER_VERSION;
}

/** The identity recorded on a candidate/history row, including legacy generic rows. */
export function recordedSourceAdapterVersion(record) {
  const recorded = record?.sourceAdapterVersion;
  if (recorded != null && typeof recorded !== 'string') {
    throw new Error('sourceAdapterVersion persistita non valida');
  }
  return String(recorded || '').trim() || GENERIC_SOURCE_ADAPTER_VERSION;
}
