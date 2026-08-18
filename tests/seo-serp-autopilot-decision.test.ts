/**
 * decideVariant() drives the SERP title/description experiment on every page of
 * the site, and until now it had no tests at all. The behaviour under test is
 * the one that was missing: a winner used to hold the slot until its
 * challenger's samples aged out of the 120-day scoring lookback — about four
 * months of silence, reached by accident rather than by design, with no way to
 * give a newly added arm a turn.
 */
import { describe, expect, it } from 'vitest';

const { decideVariant, chooseNextVariant } = await import('@/scripts/seo-serp-autopilot.mjs');

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
});

