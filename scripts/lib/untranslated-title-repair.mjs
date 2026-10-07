// Reasons with a source-language marker strong enough to enter the title
// repair lane. `source-overlap` stays out: overlap alone is deliberately a
// secondary signal and can describe a valid title containing a shared term.
// Gender codes are reported by titleLooksUntranslated(), but are not an
// untranslated verdict unless the caller explicitly opts into that policy.
export const TITLE_REPAIR_QUEUE_REASONS = Object.freeze([
  'source-copy',
  'llm-reasoning',
  'source-function-word',
  'source-orthography',
  'binnen-i',
  'compound-residue',
]);

const TITLE_REPAIR_QUEUE_REASON_SET = new Set(TITLE_REPAIR_QUEUE_REASONS);

/**
 * Whether a detector verdict is safe to hand to the title repair cascade.
 *
 * The cascade still validates its output with the same detector before it
 * writes. This helper only broadens the input queue to marker-backed
 * wrong-language titles; it does not turn the detector's low-confidence
 * overlap signal or a gender-code marker into a write permission.
 */
export function isTitleRepairQueueVerdict(verdict) {
  return verdict?.untranslated === true
    && TITLE_REPAIR_QUEUE_REASON_SET.has(String(verdict.reason || ''));
}
