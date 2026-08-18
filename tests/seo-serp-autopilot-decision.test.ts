/**
 * decideVariant() drives the SERP title/description experiment on every page of
 * the site, and until now it had no tests at all. The behaviour under test is
 * the one that was missing: a winner used to hold the slot until its
 * challenger's samples aged out of the 120-day scoring lookback — about four
 * months of silence, reached by accident rather than by design, with no way to
 * give a newly added arm a turn.
 */
import { describe, expect, it } from 'vitest';

const { decideVariant, chooseNextVariant, chooseExploitTarget } = await import('@/scripts/seo-serp-autopilot.mjs');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

/** Snapshots the scorer accepts: variant, when, and the KPI it carries. */
function snap(variant: string, daysAgo: number, impressions: number, clicks: number) {
  return { variant, createdAt: iso(daysAgo), kpi: { totalImpressions: impressions, totalClicks: clicks } };
}

/** Both arms well sampled: intent_simulation clearly ahead on CTR. */
function historyBothArms(lastSwitchDaysAgo: number) {
  return {
    lastSwitchAt: iso(lastSwitchDaysAgo),
    snapshots: [
      snap('year_intent', 40, 90_000, 6_000),        // 6.67%
      snap('year_intent', 47, 90_000, 6_100),        // 6.78%
      snap('intent_simulation', 7, 100_000, 7_600),  // 7.60%
      snap('intent_simulation', 14, 100_000, 7_550),
      snap('intent_simulation', 21, 100_000, 7_500),
    ],
  };
}

const HEALTHY_KPI = { totalImpressions: 100_000, totalClicks: 7_000 };

describe('decideVariant', () => {
  it('keeps the winner while it is still inside its validity window', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: historyBothArms(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
    });
    expect(d.mode).toBe('exploit');
    expect(d.nextVariant).toBe('intent_simulation');
    expect(d.reason).toBe('winner_already_active');
  });

  // The defect this file exists for: before revalidation, this case returned
  // 'exploit' forever, because the exploit branch returned before the rotation
  // branch could be reached.
  it('gives the challenger a turn again once the winner has held long enough', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: historyBothArms(75),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
    });
    expect(d.mode).toBe('explore');
    expect(d.nextVariant).toBe('year_intent');
    expect(d.reason).toMatch(/^revalidate_after_\d+d$/);
  });

  it('returns to the winner after the revalidation slot, rather than flip-flopping', () => {
    // The revalidation switch resets lastSwitchAt, so the next run is back
    // inside the window and exploit resumes — one slot for the challenger, not
    // a permanent handover.
    const d = decideVariant({
      currentVariant: 'year_intent',
      history: historyBothArms(7),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
    });
    expect(d.mode).toBe('exploit');
    expect(d.nextVariant).toBe('intent_simulation');
    expect(d.reason).toMatch(/^switch_to_winner_uplift_/);
  });

  it('does not revalidate on a window with too little current traffic', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: historyBothArms(75),
      currentKpi: { totalImpressions: 10, totalClicks: 1 },
      nowIso: new Date().toISOString(),
    });
    expect(d.reason).toBe('insufficient_current_data_keep');
    expect(d.nextVariant).toBe('intent_simulation');
  });

  it('scores every arm, so a third variant is comparable rather than invisible', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: historyBothArms(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
    });
    // Whatever VARIANTS holds, each entry gets a score — the old code only ever
    // read VARIANTS[0] and VARIANTS[1].
    for (const [name, score] of Object.entries(d.scores)) {
      expect(score, `score for ${name}`).toHaveProperty('ctr');
      expect(score).toHaveProperty('samples');
    }
    expect(Object.keys(d.scores).length).toBeGreaterThanOrEqual(2);
  });
});

describe('chooseNextVariant', () => {
  it('picks the arm sampled least recently, not simply the other one', () => {
    const history = {
      snapshots: [
        snap('year_intent', 3, 1, 1),
        snap('intent_simulation', 90, 1, 1),
      ],
    };
    // From year_intent the only other arm is intent_simulation; the point is
    // that the choice is driven by recency and so still works with more arms.
    expect(chooseNextVariant('year_intent', history)).toBe('intent_simulation');
  });

  it('treats a never-sampled arm as the most overdue', () => {
    const history = { snapshots: [snap('intent_simulation', 1, 1, 1)] };
    expect(chooseNextVariant('intent_simulation', history)).toBe('year_intent');
  });

  it('survives an empty history without throwing', () => {
    expect(() => chooseNextVariant('intent_simulation', { snapshots: [] })).not.toThrow();
  });
});

/**
 * The three-arm case, which is the whole point of this PR and which
 * `decideVariant` cannot reach from a test: `VARIANTS` is a module constant
 * with two entries. `chooseExploitTarget` is the same decision as a pure
 * function, so the arithmetic can be exercised at the arity the feature is
 * being built for.
 */
describe('chooseExploitTarget with three arms', () => {
  const score = (ctr: number) => ({ ctr, samples: 3, impressions: 100_000, clicks: Math.round(ctr * 1000) });

  it('measures the uplift against the arm it would replace, not the runner-up', () => {
    // Two strong arms nearly tied, far above the incumbent. Against the
    // runner-up the uplift is 0.05 and the switch is refused; against the
    // incumbent it is 2.0 and obviously worth taking.
    const scores = { a: score(3.0), b: score(2.95), c: score(1.0) };
    const out = chooseExploitTarget(scores, ['a', 'b', 'c'], 'c', 0.15);
    expect(out.winner).toBe('a');
    expect(out.runnerUp).toBe('b');
    expect(out.uplift).toBeCloseTo(2.0, 6);
    expect(out.shouldSwitch).toBe(true);
  });

  it('still refuses a switch that is genuinely marginal', () => {
    // Same shape, but this time the incumbent is one of the two leaders: the
    // gain really is 0.05, and the threshold really should block it.
    const scores = { a: score(3.0), b: score(2.95), c: score(1.0) };
    const out = chooseExploitTarget(scores, ['a', 'b', 'c'], 'b', 0.15);
    expect(out.winner).toBe('a');
    expect(out.uplift).toBeCloseTo(0.05, 6);
    expect(out.shouldSwitch).toBe(false);
  });

  it('never switches away from an arm that is already winning', () => {
    const scores = { a: score(3.0), b: score(2.0), c: score(1.0) };
    const out = chooseExploitTarget(scores, ['a', 'b', 'c'], 'a', 0.15);
    expect(out.shouldSwitch).toBe(false);
    // With nothing to replace, the reported uplift is the incumbent's margin
    // over the field — the number `winner_already_active` has always carried.
    expect(out.uplift).toBeCloseTo(1.0, 6);
  });

  it('keeps the two-arm behaviour byte for byte', () => {
    // The guard against a silent change to what runs in production today:
    // with two arms, replaced-arm and runner-up are the same arm.
    const scores = { a: score(3.0), b: score(2.0) };
    const out = chooseExploitTarget(scores, ['a', 'b'], 'b', 0.15);
    expect(out.uplift).toBeCloseTo(1.0, 6);
    expect(out.shouldSwitch).toBe(true);
  });

  it('does not throw when the active variant is not one of the arms', () => {
    // A stale Remote Config value naming a retired variant must not crash the
    // autopilot; it falls back to comparing against the runner-up.
    const scores = { a: score(3.0), b: score(2.0) };
    const out = chooseExploitTarget(scores, ['a', 'b'], 'retired_variant', 0.15);
    expect(out.winner).toBe('a');
    expect(out.shouldSwitch).toBe(true);
  });
});
