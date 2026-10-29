/** SumUp references are unique per merchant; expired checkouts need a new one.
 * First attempts keep their historical entity id. A reserved renewal attempt
 * is deterministic so retrying a crashed creator still finds the same checkout.
 */
const RENEWAL_MARKER = '~sumup~';

export function sumUpCheckoutReference(entityId, checkoutAttempt = 1) {
  const id = String(entityId ?? '').trim();
  const attempt = Number(checkoutAttempt);
  if (!id || id.includes(RENEWAL_MARKER) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('sumup_checkout_reference_invalid');
  }
  const reference = attempt === 1 ? id : `${id}${RENEWAL_MARKER}${attempt}`;
  if (reference.length > 64) throw new Error('sumup_checkout_reference_invalid');
  return reference;
}

export function sumUpCheckoutEntityId(reference) {
  if (typeof reference !== 'string' || !reference || reference.length > 64 || reference.trim() !== reference) return '';
  const markerAt = reference.indexOf(RENEWAL_MARKER);
  if (markerAt < 0) return reference;
  const id = reference.slice(0, markerAt);
  const rawAttempt = reference.slice(markerAt + RENEWAL_MARKER.length);
  const attempt = Number(rawAttempt);
  if (!id || !Number.isSafeInteger(attempt) || attempt < 2 || String(attempt) !== rawAttempt) return '';
  return id;
}

export function matchesSumUpCheckoutReference(reference, entityId) {
  return Boolean(entityId) && sumUpCheckoutEntityId(reference) === entityId;
}
