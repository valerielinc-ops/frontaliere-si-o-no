/**
 * follow-up(#2772) item 3 — `inferAnyCanton` off-target fill guard.
 *
 * `inferAnyCanton()` (scripts/lib/target-swiss-locations.mjs) scans all 26
 * Swiss cantons, not just TARGET_CANTONS — the funnel's set of cantons that
 * actually have a live `/cerca-lavoro-<canton>/` URL section. Before this
 * guard, assemble-jobs-dataset.mjs's canton-fill step accepted ANY inferred
 * canton unconditionally: a job whose location inferred to an off-target
 * canton would be filled with e.g. canton="ZZ", turning a recognizable
 * orphan-empty job (canton="") into a harder-to-spot orphan-non-target
 * (canton set, but no URL section to place it in).
 *
 * `acceptInferredCantonForFill()` is the extracted guard: it only lets an
 * inferred canton through if it's a TARGET_CANTONS member, otherwise returns
 * null so the caller leaves the canton unchanged (empty stays empty). At the
 * time of writing TARGET_CANTONS already covers all 26 Swiss cantons (2026-
 * 05-10 Cathedral CH-wide expansion), so this guard is defensive rather than
 * currently load-bearing on real data — this test exercises it directly with
 * synthetic off-target input so a future narrowing of TARGET_CANTONS (or any
 * other target/inference-universe drift) can't silently regress it.
 */
import { describe, expect, it } from 'vitest';
import { acceptInferredCantonForFill, isWeakCantonOnlyLabelOverride } from '../scripts/assemble-jobs-dataset.mjs';
// @ts-expect-error — plain .mjs lib, no type declarations
import { TARGET_CANTONS } from '../scripts/lib/target-swiss-locations.mjs';

describe('acceptInferredCantonForFill (#2772 item 3)', () => {
  it('rejects an inferred canton outside TARGET_CANTONS (synthetic off-target code)', () => {
    // 'ZZ' is not a real Swiss canton code — guaranteed off-target regardless
    // of how TARGET_CANTONS evolves. Proves the guard blocks fill-from-any-
    // of-26 when the inferred value isn't in the funnel's served set.
    expect(TARGET_CANTONS.includes('ZZ')).toBe(false);
    expect(acceptInferredCantonForFill('ZZ')).toBeNull();
  });

  it('accepts an inferred canton that IS a target (e.g. Ticino, the funnel home canton)', () => {
    expect(TARGET_CANTONS.includes('TI')).toBe(true);
    expect(acceptInferredCantonForFill('TI')).toBe('TI');
  });

  it('accepts every canton currently in TARGET_CANTONS (no regression across the whole set)', () => {
    for (const code of TARGET_CANTONS) {
      expect(acceptInferredCantonForFill(code)).toBe(code);
    }
  });

  it('passes through null/empty input unchanged (no inference signal, nothing to guard)', () => {
    expect(acceptInferredCantonForFill(null)).toBeNull();
    expect(acceptInferredCantonForFill('')).toBeNull();
    expect(acceptInferredCantonForFill(undefined)).toBeNull();
  });
});

/**
 * issue #4570 — a canton-only label ("Ticino", "TI") location string must
 * not be trusted to OVERRIDE an already-assigned, different canton. ETA
 * SA/Swatch Group jobs were correctly tagged canton=SO by the crawler, but
 * their location field was forged/corrupted to the literal string "Ticino"
 * — inferAnyCanton("Ticino") confidently matches the canton NAME, so the
 * fill/override step in assemble-jobs-dataset.mjs clobbered the correct SO
 * with TI, then the pin ledger froze it there forever.
 */
describe('isWeakCantonOnlyLabelOverride (#4570)', () => {
  it('blocks override when location is a bare canton name and a different canton is already set', () => {
    expect(isWeakCantonOnlyLabelOverride('SO', 'Ticino')).toBe(true);
    expect(isWeakCantonOnlyLabelOverride('SO', 'TI')).toBe(true);
  });

  it('allows fill when the existing canton is empty (UBS-roles case, #2772 item 2)', () => {
    expect(isWeakCantonOnlyLabelOverride('', 'Ticino')).toBe(false);
    expect(isWeakCantonOnlyLabelOverride(null as unknown as string, 'Ticino')).toBe(false);
  });

  it('allows override when location names a real city, not just the canton', () => {
    // A real municipality carries full location precision — it can still
    // correct a wrong HQ-default canton, exactly as before this guard.
    expect(isWeakCantonOnlyLabelOverride('ZH', 'Lugano')).toBe(false);
    expect(isWeakCantonOnlyLabelOverride('TI', 'Allschwil')).toBe(false);
  });

  it('does not block when location text is empty or not a canton label at all', () => {
    expect(isWeakCantonOnlyLabelOverride('SO', '')).toBe(false);
    expect(isWeakCantonOnlyLabelOverride('SO', 'some garbage company name')).toBe(false);
  });
});
