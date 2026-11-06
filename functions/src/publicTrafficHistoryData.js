/**
 * Shared, dependency-free contract for the public traffic-history read model.
 * The browser and the Admin SDK endpoint must use the same names and slugs;
 * keeping them here prevents a client/server query drift.
 */

export const PUBLIC_TRAFFIC_HISTORY_TARGETS = Object.freeze([
  Object.freeze({ name: 'Chiasso - Strada', slug: 'chiasso-strada' }),
  Object.freeze({ name: 'Chiasso - Brogeda', slug: 'chiasso-brogeda' }),
  Object.freeze({ name: 'Gaggiolo', slug: 'gaggiolo' }),
  Object.freeze({ name: 'Ponte Tresa', slug: 'ponte-tresa' }),
  Object.freeze({ name: 'Stabio', slug: 'san-pietro' }),
  Object.freeze({ name: 'Ponte Chiasso', slug: 'chiasso-centro' }),
]);

export const PUBLIC_TRAFFIC_HISTORY_PAGE_SIZE = 500;
export const PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS = 20;

/**
 * Aggregate the same bounded sample previously read by the browser. Invalid
 * rows are ignored, while a sample below the existing minimum remains absent
 * so the UI keeps its statistical fallback rather than inventing a trend.
 */
export function aggregateTrafficHistoryDocuments(
  documents,
  minimumSnapshots = PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS,
) {
  if (!Array.isArray(documents) || documents.length < minimumSnapshots) return null;

  const accumulator = {};
  for (const document of documents) {
    const data = typeof document?.data === 'function' ? document.data() : document;
    const day = Number(data?.dayOfWeek);
    const hour = Number(data?.hour);
    const minutes = data?.totalCrossingMinutes ?? data?.waitTimeMinutes;
    if (
      !Number.isInteger(day) || day < 0 || day > 6
      || !Number.isInteger(hour) || hour < 0 || hour > 23
      || typeof minutes !== 'number' || !Number.isFinite(minutes)
    ) continue;

    accumulator[day] ||= {};
    accumulator[day][hour] ||= { sum: 0, count: 0 };
    accumulator[day][hour].sum += minutes;
    accumulator[day][hour].count += 1;
  }

  const aggregated = {};
  for (const [day, hours] of Object.entries(accumulator)) {
    aggregated[day] = {};
    for (const [hour, value] of Object.entries(hours)) {
      aggregated[day][hour] = Math.round(value.sum / value.count);
    }
  }
  return Object.keys(aggregated).length > 0 ? aggregated : null;
}
