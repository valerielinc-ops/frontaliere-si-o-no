/**
 * Great-circle distance, on its own.
 *
 * Six lines of trigonometry that used to live in events-utils.mjs, a 1061-line
 * module that pulls in data/canton-url-slugs.json. Anything wanting to measure
 * the distance between two points inherited that dependency — which is how a
 * canton slug table ended up in the transitive closure of the article
 * generator, whose only interest here is deciding which canton a comune is
 * nearest to (issue #4974 item 3).
 *
 * A leaf module has no imports, so it cannot drag anything along.
 */

/**
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in kilometres
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
