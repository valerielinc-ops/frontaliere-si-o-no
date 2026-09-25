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
 * The exploit arithmetic on its own. `decideVariant` reaches the same code
 * through a full history+KPI fixture (see the three-arm suite below); these
 * pin the two margins directly, because `uplift` and `lead` coincide at two
 * arms and telling them apart is the entire point of the function.
 */
describe('chooseExploitTarget', () => {
  const score = (ctr: number) => ({ ctr, samples: 3, impressions: 100_000, clicks: Math.round(ctr * 1000) });

  it('measures the uplift against the arm it would replace, not the runner-up', () => {
    // Two strong arms nearly tied, far above the incumbent. The runner-up
    // margin is 0.05 and would refuse the switch; the margin over the arm
    // actually being replaced is 2.0 and obviously worth taking.
    const scores = { a: score(3.0), b: score(2.95), c: score(1.0) };
    const out = chooseExploitTarget(scores, ['a', 'b', 'c'], 'c', 0.15);
    expect(out.winner).toBe('a');
    expect(out.runnerUp).toBe('b');
    expect(out.uplift).toBeCloseTo(2.0, 6);
    expect(out.lead).toBeCloseTo(0.05, 6);
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

  it('reports no switch margin at all when the winner is already live', () => {
    const scores = { a: score(3.0), b: score(2.0), c: score(1.0) };
    const out = chooseExploitTarget(scores, ['a', 'b', 'c'], 'a', 0.15);
    expect(out.shouldSwitch).toBe(false);
    // Nothing is being replaced, so the switch margin does not exist rather
    // than being zero — and the number worth reading is the lead over the
    // closest challenger, which is what `winner_already_active` carries.
    expect(out.uplift).toBeNull();
    expect(out.lead).toBeCloseTo(1.0, 6);
  });

  it('keeps the two-arm behaviour unchanged', () => {
    // The guard against a silent change to what runs in production today:
    // with two arms, replaced-arm and runner-up are the same arm, so the two
    // margins agree.
    const scores = { a: score(3.0), b: score(2.0) };
    const out = chooseExploitTarget(scores, ['a', 'b'], 'b', 0.15);
    expect(out.uplift).toBeCloseTo(1.0, 6);
    expect(out.lead).toBeCloseTo(1.0, 6);
    expect(out.shouldSwitch).toBe(true);
  });

  it('does not throw on a single-arm experiment, which has no runner-up', () => {
    // `variants` is injectable and `chooseNextVariant` already answers for one
    // arm, so this arity is reachable. Reading ranked[1] blind evaluates
    // `scores[undefined].ctr` and throws.
    const scores = { a: score(3.0) };
    let out: ReturnType<typeof chooseExploitTarget> | undefined;
    expect(() => { out = chooseExploitTarget(scores, ['a'], 'a', 0.15); }).not.toThrow();
    expect(out!.winner).toBe('a');
    expect(out!.runnerUp).toBe('a');
    expect(out!.uplift).toBeNull();
    expect(out!.lead).toBe(0);
    expect(out!.shouldSwitch).toBe(false);
  });
});

// Three arms was the whole point of making the mechanism n-ary, and it is the
// case that could not be written at all until `variants` became injectable —
// VARIANTS is a module constant with two entries, so the n-ary behaviour
// shipped untested and, as it turned out, wrong.
describe('decideVariant with three arms', () => {
  const ARMS = ['year_intent', 'intent_simulation', 'third_arm'];

  /** A leads, B is a hair behind, C is clearly worst. */
  function threeArmHistory(lastSwitchDaysAgo: number) {
    return {
      lastSwitchAt: iso(lastSwitchDaysAgo),
      snapshots: [
        snap('intent_simulation', 7, 100_000, 7_600), // 7.60%
        snap('intent_simulation', 14, 100_000, 7_600),
        snap('year_intent', 21, 100_000, 7_550),      // 7.55%
        snap('year_intent', 28, 100_000, 7_550),
        snap('third_arm', 35, 100_000, 6_000),        // 6.00%
        snap('third_arm', 42, 100_000, 6_000),
      ],
    };
  }

  it('switches off the worst arm even when the two leaders are close together', () => {
    // The margin that decides this is winner-minus-ACTIVE (1.60), not
    // winner-minus-runner-up (0.05, below the 0.15 threshold). Measuring it
    // the second way left the autopilot sitting on the worst arm forever.
    const d = decideVariant({
      currentVariant: 'third_arm',
      history: threeArmHistory(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
      variants: ARMS,
    });
    expect(d.mode).toBe('exploit');
    expect(d.nextVariant).toBe('intent_simulation');
    expect(d.reason).toMatch(/^switch_to_winner_uplift_1\.6/);
  });

  it('still refuses a switch whose real margin over the active arm is too small', () => {
    const d = decideVariant({
      currentVariant: 'year_intent', // 7.55 vs the winner's 7.60
      history: threeArmHistory(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
      variants: ARMS,
    });
    expect(d.nextVariant).toBe('year_intent');
    expect(d.reason).toBe('uplift_below_threshold');
  });

  it('reads the lead against the closest challenger once the winner is live', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: threeArmHistory(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
      variants: ARMS,
    });
    // 7.60 vs 7.55 is a thin lead, so this is honestly reported as thin
    // rather than as a settled win.
    expect(d.nextVariant).toBe('intent_simulation');
    expect(d.reason).toBe('uplift_below_threshold');
  });

  it('scores all three arms, not just the first two', () => {
    const d = decideVariant({
      currentVariant: 'intent_simulation',
      history: threeArmHistory(10),
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
      variants: ARMS,
    });
    expect(Object.keys(d.scores).sort()).toEqual([...ARMS].sort());
  });

  it('rotates to the arm nobody has sampled for longest', () => {
    // third_arm was last seen 35 days ago, year_intent 21 — the overdue one
    // wins, which is what stops a third arm from starving.
    expect(chooseNextVariant('intent_simulation', threeArmHistory(10), ARMS)).toBe('third_arm');
  });

  it('can actually switch TO the injected arm, not merely score it', () => {
    // Every other three-arm case here has the winner inside the VARIANTS
    // module constant, so all of them stay green even if the exploit branch
    // ranks VARIANTS instead of the injected `variants` — scoring an arm it
    // can never choose. Only a fixture where the injected arm WINS tells the
    // two apart: ranking VARIANTS would crown intent_simulation at 6.10 for an
    // uplift of 0.10 over the live arm, refuse the switch as below threshold,
    // and silently strand the best arm at 7.80.
    const d = decideVariant({
      currentVariant: 'year_intent',
      history: {
        lastSwitchAt: iso(10),
        snapshots: [
          snap('year_intent', 7, 100_000, 6_000),         // 6.00%
          snap('year_intent', 14, 100_000, 6_000),
          snap('intent_simulation', 21, 100_000, 6_100),  // 6.10%
          snap('intent_simulation', 28, 100_000, 6_100),
          snap('third_arm', 35, 100_000, 7_800),          // 7.80%
          snap('third_arm', 42, 100_000, 7_800),
        ],
      },
      currentKpi: HEALTHY_KPI,
      nowIso: new Date().toISOString(),
      variants: ARMS,
    });
    expect(d.mode).toBe('exploit');
    expect(d.nextVariant).toBe('third_arm');
    expect(d.reason).toMatch(/^switch_to_winner_uplift_1\.8/);
  });
});

