/**
 * Shared byte-based guard for committed accumulators.
 *
 * A reader that degrades a corrupt or unavailable accumulator to an empty
 * fallback can otherwise turn a small current snapshot into a destructive
 * rewrite. The post-push data-integrity workflow and the writers must use the
 * same conservative boundary so the failure is stopped before a commit.
 */

export const ACCUMULATOR_SANITY_FLOOR_BYTES = 1_000_000;
export const ACCUMULATOR_MAX_SHRINK_PCT = 70;

export function accumulatorShrinkPct(previousBytes, nextBytes) {
  const previous = Number(previousBytes);
  const next = Number(nextBytes);
  if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(next)) return null;
  return ((previous - next) / previous) * 100;
}

export function isCatastrophicAccumulatorShrink(previousBytes, nextBytes, options = {}) {
  const floorBytes = Number(options.floorBytes ?? ACCUMULATOR_SANITY_FLOOR_BYTES);
  const maxShrinkPct = Number(options.maxShrinkPct ?? ACCUMULATOR_MAX_SHRINK_PCT);
  const previous = Number(previousBytes);
  const shrinkPct = accumulatorShrinkPct(previousBytes, nextBytes);

  return Number.isFinite(floorBytes)
    && Number.isFinite(maxShrinkPct)
    && Number.isFinite(previous)
    && previous >= floorBytes
    && shrinkPct !== null
    && shrinkPct > maxShrinkPct;
}

/**
 * Throw before an accumulator write that matches the post-push truncation
 * detector. A next size of zero also covers an unsafe deletion.
 */
export function assertAccumulatorByteFloor(previousBytes, nextBytes, options = {}) {
  const label = options.label ?? 'accumulator';
  const floorBytes = Number(options.floorBytes ?? ACCUMULATOR_SANITY_FLOOR_BYTES);
  const maxShrinkPct = Number(options.maxShrinkPct ?? ACCUMULATOR_MAX_SHRINK_PCT);
  const previous = Number(previousBytes);
  const next = Number(nextBytes);

  if (isCatastrophicAccumulatorShrink(previous, next, { floorBytes, maxShrinkPct })) {
    const shrinkPct = accumulatorShrinkPct(previous, next);
    throw new Error(
      `❌ ABORT write to ${label}: ${next} B is a ${shrinkPct.toFixed(1)}% shrink `
      + `from existing ${previous} B (threshold >${maxShrinkPct}% for files `
      + `≥${floorBytes} B) — catastrophic truncation avoided. `
      + 'The accumulator read likely degraded to an empty fallback; NOT overwriting.',
    );
  }

  return { previousBytes: previous, nextBytes: next };
}
