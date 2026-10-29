/** The TCS feed exposes collection time, not the last price change at the pump. */
export function fuelObservation(
  stations: ReadonlyArray<{ updatedAt?: string | null; dieselUpdatedAt?: string | null; observedAt?: string | null; dieselPriceChf?: number | null; sp95PriceChf?: number | null }>,
  fuel: 'diesel' | 'benzina',
  snapshotObservedAt?: string | null,
) {
  const priced = stations.filter((station) => {
    const price = fuel === 'diesel' ? station.dieselPriceChf : station.sp95PriceChf;
    return typeof price === 'number' && Number.isFinite(price) && price > 0;
  });
  const timestamps = priced.map((station) => fuel === 'diesel'
    ? station.dieselUpdatedAt ?? station.updatedAt ?? station.observedAt
    : station.updatedAt ?? station.observedAt)
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const fallback = typeof snapshotObservedAt === 'string' && Number.isFinite(Date.parse(snapshotObservedAt))
    ? snapshotObservedAt
    : null;
  const collectedAt = timestamps.length
    ? new Date(Math.max(...timestamps.map(Date.parse))).toISOString()
    : fallback;
  const prices = priced.map((station) => (fuel === 'diesel' ? station.dieselPriceChf : station.sp95PriceChf) as number);
  return { collectedAt, count: prices.length, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null };
}
