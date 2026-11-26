/**
 * Park the description fields of expired entries outside the V8 heap while the
 * whole archive is deduplicated.
 *
 * The aggregate keeps every unique entry alive until the route collapse and the
 * publication cap have run, and the descriptions are most of their bytes
 * (71% on a 318 MB sample of the committed slices, 2026-11-26). The collapse
 * decides on routes, identities and timestamps and never reads them, so they
 * can wait in Buffers (not counted against --max-old-space-size) and come back
 * for the entries that survive the cap.
 *
 * CONTRACT: nothing between `detach` and `restore` may read or merge these
 * fields. A change to the collapse that needs a description must drop it from
 * SPILLED_FIELDS. tests/scripts/assemble-expired-memory.test.ts compares the
 * result with and without the spill.
 *
 * The placeholder replaces the value under the same key, so key order (and the
 * serialized bytes after `restore`) do not change. It is a plain object because
 * the collapse `structuredClone`s its survivors, and it carries a unique slot
 * so two different payloads never serialize alike.
 */
export const SPILLED_FIELDS = Object.freeze(['description', 'descriptionByLocale']);
const PLACEHOLDER_KEY = '__spilledExpiredField';
/** Below this, the placeholder and its Buffer would cost more than the value. */
const MIN_SPILL_CHARS = 256;

export function createExpiredDescriptionSpill() {
  const slots = [];
  return {
    /** Move the large description fields of `entry` out of the heap, in place. */
    detach(entry) {
      for (const field of SPILLED_FIELDS) {
        if (!Object.hasOwn(entry, field)) continue;
        const value = entry[field];
        if (value === null || (typeof value !== 'object' && typeof value !== 'string')) continue;
        const json = JSON.stringify(value);
        if (json.length < MIN_SPILL_CHARS) continue;
        entry[field] = { [PLACEHOLDER_KEY]: slots.push(Buffer.from(json, 'utf8')) - 1 };
      }
    },
    /** Put the parked values back, in place. Safe on entries never detached. */
    restore(entry) {
      for (const field of SPILLED_FIELDS) {
        const slot = entry[field]?.[PLACEHOLDER_KEY];
        if (slot === undefined) continue;
        entry[field] = JSON.parse(slots[slot].toString('utf8'));
      }
    },
  };
}

/** Shallow copy of an expired entry for consumers that never read descriptions. */
export function withoutDescriptions(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { description: _description, descriptionByLocale: _descriptionByLocale, ...rest } = entry;
  return rest;
}
