/**
 * Event sources whose data must never leave the private store.
 *
 * Eventfrog Public API (AGB v1.28, §17, accepted by the owner on 2026-10-05,
 * decision D5): the data may only be shown on our own pages to announce the
 * event (§17(1), §17(6)), may not be handed to third parties (§17(3)), and may
 * no longer be used once the API stops returning it (§17(5)). Both repositories
 * are public and the corpus republishes `public/data/events.json` as an open
 * JSON API, so a record of these sources is allowed in exactly one place: the
 * private snapshot read by the events page builder at build time
 * (scripts/lib/private-event-snapshots.mjs). It must never reach:
 *
 *   - data/events.json, data/events/by-source/** or public/data/events.json
 *     (tracked, public, and fetched by the corpus digest);
 *   - the Facebook poster, the weekend digest article, the newsletter or any
 *     other reuse that is not the event's own announcement page.
 *
 * This module is a leaf (no imports) so every reader of the events dataset can
 * apply the same predicate without pulling in the page builder.
 */

/** Source keys whose records live only in the private snapshot store. */
export const PRIVATE_EVENT_SOURCE_KEYS = Object.freeze(['eventfrog']);

/**
 * Attribution records for the private sources, shaped like `EVENT_SOURCES`
 * entries of scripts/lib/events-utils.mjs. Kept here, not in the shared
 * registry, because that registry is mirrored to the public corpus, which must
 * never handle these sources.
 */
export const PRIVATE_EVENT_SOURCES = Object.freeze({
  eventfrog: Object.freeze({
    key: 'eventfrog',
    label: 'Eventfrog',
    homepage: 'https://eventfrog.ch/',
    canton: null,
  }),
});

/**
 * Whether an event record comes from a private source. Checks every field that
 * can carry the provenance (`sourceKey`, the `<source>:` id prefix and the
 * `ephemeral` marker set by the snapshot mapper), so a record stripped of one
 * of them is still caught.
 *
 * @param {unknown} event
 * @returns {boolean}
 */
export function isPrivateEventRecord(event) {
  if (!event || typeof event !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (event);
  if (record.ephemeral === true) return true;
  const sourceKey = typeof record.sourceKey === 'string' ? record.sourceKey.trim().toLowerCase() : '';
  if (PRIVATE_EVENT_SOURCE_KEYS.includes(sourceKey)) return true;
  const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
  return PRIVATE_EVENT_SOURCE_KEYS.some((key) => id.startsWith(`${key}:`));
}

/**
 * The events that may be published or reused outside their own announcement
 * page. Non-array input yields [].
 *
 * @template T
 * @param {T[]} events
 * @returns {T[]}
 */
export function withoutPrivateEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => !isPrivateEventRecord(event));
}

/**
 * Throws when a list that is about to be written to a public surface still
 * holds a private record. The message carries only the count and the surface,
 * never a title or an id of the record.
 *
 * @param {unknown[]} events
 * @param {string} surface human label of the destination, for the error
 */
export function assertNoPrivateEvents(events, surface) {
  const leaked = Array.isArray(events) ? events.filter(isPrivateEventRecord).length : 0;
  if (leaked > 0) {
    throw new Error(`${leaked} private-source event record(s) would be written to ${surface}; refusing (Eventfrog AGB §17(3)).`);
  }
}
