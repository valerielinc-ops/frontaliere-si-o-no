/**
 * bfs-baseline-justification.test.ts
 *
 * Gating half of issue #5545: "a high baseline makes a family immune rather
 * than covered".
 *
 * `evaluateBfsGate` (tested in audit-bfs-depth-rate-gate.test.ts) compares each
 * sitemap against ITS OWN baseline entry, so it is structurally unable to
 * comment on whether that entry should have been accepted in the first place.
 * `sitemap-health-facilities.xml` sat at 388/436 (88.99%) with 380 pages linked
 * from nothing, and the gate was green for months because 88.99% was what it
 * had been told to expect (#5434, fixed by #5543).
 *
 * These tests run in the normal `tests` job — no dist, no crawl — so the check
 * fires when a high baseline is REGISTERED, not post-deploy once it shipped.
 *
 * Do NOT satisfy a failure here by raising a frozen ledger number or by
 * writing a reason you cannot defend: both reproduce the defect with extra
 * ceremony (AGENTS.md non-negotiables #1 and #5).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HIGH_BASELINE_MIN_BURIED,
  HIGH_BASELINE_RATE_PCT,
  UNJUSTIFIED_HIGH_BASELINES,
  WIDENING_EPSILON_PP,
  carryForwardReasons,
  evaluateBaselineJustification,
  isSubstantiveReason,
} from '../../scripts/lib/bfsBaselineJustification.mjs';
import { DEFAULT_BFS_TOL, evaluateBfsGate } from '../../scripts/audit-bfs-depth.mjs';

type Entry = { total: number; atDepthGtMax: number; ratePct?: number; reason?: string };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = join(REPO_ROOT, 'data', 'bfs-depth-baseline.json');

/** Build a minimal baseline document around the given entries. */
function baselineOf(perSitemap: Record<string, Entry>) {
  const out: Record<string, Entry> = {};
  for (const [name, e] of Object.entries(perSitemap)) {
    out[name] = { ...e, ratePct: e.ratePct ?? (e.total ? Number(((e.atDepthGtMax / e.total) * 100).toFixed(4)) : 0) };
  }
  return { version: 2, mode: 'rate', maxDepth: 4, tolerance: DEFAULT_BFS_TOL, perSitemap: out };
}

const A_REAL_REASON =
  'Legal-archive tier deliberately excluded from the hub navigation; each URL is reached from its own case page only.';

describe('evaluateBaselineJustification — registering a high baseline (#5545)', () => {
  it('a NEW high entry with no reason and no ledger line FAILS', () => {
    // The hole itself: today nothing stops a family being registered as
    // majority-unreachable, and once registered the ratchet defends the number
    // instead of questioning it.
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-new-tier.xml': { total: 500, atDepthGtMax: 440 } }),
      ledger: {},
    });
    expect(verdict.unjustified.map((u) => u.name)).toEqual(['sitemap-new-tier.xml']);
    expect(verdict.high[0].status).toBe('unjustified');
  });

  it('the same entry with a written reason PASSES', () => {
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-new-tier.xml': { total: 500, atDepthGtMax: 440, reason: A_REAL_REASON } }),
      ledger: {},
    });
    expect(verdict.unjustified).toHaveLength(0);
    expect(verdict.justified).toEqual(['sitemap-new-tier.xml']);
  });

  it('a placeholder reason does NOT satisfy the check', () => {
    // A `reason` field satisfiable by "TODO" would reproduce the original
    // defect: an unexamined acceptance, now with a field next to it.
    for (const reason of ['TODO', 'n/a', 'tbd', '-', 'da fare', 'see above', 'x'.repeat(60)]) {
      const verdict = evaluateBaselineJustification({
        baseline: baselineOf({ 'sitemap-new-tier.xml': { total: 500, atDepthGtMax: 440, reason } }),
        ledger: {},
      });
      expect(verdict.unjustified, `reason ${JSON.stringify(reason)} must not pass`).toHaveLength(1);
    }
    expect(isSubstantiveReason(A_REAL_REASON)).toBe(true);
  });

  it('below the rate threshold, or below the buried floor, nothing is demanded', () => {
    const belowRate = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-ok.xml': { total: 1000, atDepthGtMax: HIGH_BASELINE_RATE_PCT * 10 - 1 } }),
      ledger: {},
    });
    expect(belowRate.high).toHaveLength(0);

    // A tiny sitemap at 100% is a rounding artifact, not a content tier.
    const tiny = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-tiny.xml': { total: HIGH_BASELINE_MIN_BURIED - 1, atDepthGtMax: HIGH_BASELINE_MIN_BURIED - 1 } }),
      ledger: {},
    });
    expect(tiny.high).toHaveLength(0);
  });

  it('a hand-lowered ratePct cannot walk an entry out of the check', () => {
    // The rate is recomputed from the counts, so editing the stored ratePct
    // alone (the cheapest way to silence this) changes nothing.
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-liar.xml': { total: 500, atDepthGtMax: 440, ratePct: 1 } }),
      ledger: {},
    });
    expect(verdict.unjustified.map((u) => u.name)).toEqual(['sitemap-liar.xml']);
  });
});

describe('evaluateBaselineJustification — the ledger is carry-only and shrink-only', () => {
  const ledger = { 'sitemap-old.xml': { ratePct: 75, atDepthGtMax: 750 } };

  it('a grandfathered entry that held steady PASSES', () => {
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 1000, atDepthGtMax: 750 } }),
      ledger,
    });
    expect(verdict.unjustified).toHaveLength(0);
    expect(verdict.widened).toHaveLength(0);
    expect(verdict.high[0].status).toBe('grandfathered');
  });

  it('a grandfathered entry that WIDENED on both arms FAILS', () => {
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 1000, atDepthGtMax: 870 } }),
      ledger,
    });
    expect(verdict.widened).toHaveLength(1);
    expect(verdict.widened[0]).toMatchObject({ name: 'sitemap-old.xml', frozenRatePct: 75, frozenBuried: 750 });
  });

  it('organic growth at a FLAT rate is not widening', () => {
    // Count up 750 → 3000, rate unchanged. Same #1604 lesson the ratchet
    // itself encodes: this buries no new URL relative to the corpus.
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 4000, atDepthGtMax: 3000 } }),
      ledger,
    });
    expect(verdict.widened).toHaveLength(0);
  });

  it('a rate spike from pure denominator shrink is not widening', () => {
    // Corpus contraction: total 1000 → 800, buried flat at 750 → rate 93.75%.
    // No new URL is buried, so the count arm stays false and the AND holds.
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 800, atDepthGtMax: 750 } }),
      ledger,
    });
    expect(verdict.widened).toHaveLength(0);
  });

  it('rebaseline rounding under the epsilon does not trip the widening arm', () => {
    const nudged = 750 + 1;
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 1000, atDepthGtMax: nudged } }),
      ledger,
    });
    expect(nudged / 10 - 75).toBeLessThan(WIDENING_EPSILON_PP);
    expect(verdict.widened).toHaveLength(0);
  });

  it('a ledger line for an entry that has been FIXED must be deleted', () => {
    // Without this the ledger becomes the stale list nobody rereads — the exact
    // dynamic #5545 was opened against. Every removal is a real improvement.
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 1000, atDepthGtMax: 100 } }),
      ledger,
    });
    expect(verdict.staleLedger).toEqual([{ name: 'sitemap-old.xml', why: 'fixed', ratePct: 10 }]);
  });

  it('a ledger line for an entry that has since been given a reason must be deleted', () => {
    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-old.xml': { total: 1000, atDepthGtMax: 750, reason: A_REAL_REASON } }),
      ledger,
    });
    expect(verdict.staleLedger).toEqual([{ name: 'sitemap-old.xml', why: 'justified', ratePct: 75 }]);
  });

  it('a ledger line for an entry that vanished from the baseline must be deleted', () => {
    const verdict = evaluateBaselineJustification({ baseline: baselineOf({}), ledger });
    expect(verdict.staleLedger).toEqual([{ name: 'sitemap-old.xml', why: 'absent', ratePct: null }]);
  });
});

describe('this check is not redundant with the per-sitemap ratchet', () => {
  it('catches a widening the rate ratchet passes', () => {
    // Real numbers: sitemap-jobs-zurigo.xml is baselined at 2755/3673 (75.007%).
    // Its rate cap is 75.007 + min(75.007*0.15, 8) + 5 = 88.007%, so a rebaseline
    // recording 3200/3673 (87.12%) — 445 newly buried URLs — sits UNDER the cap.
    const zurigoBefore = { total: 3673, atDepthGtMax: 2755, deepest: 7 };
    const zurigoAfter = { total: 3673, atDepthGtMax: 3200, deepest: 7 };

    const { regressions } = evaluateBfsGate({
      perSitemap: { 'sitemap-jobs-zurigo.xml': zurigoAfter },
      baseline: baselineOf({ 'sitemap-jobs-zurigo.xml': zurigoBefore }),
    });
    expect(regressions, 'the rate ratchet does not see this — that is the gap').toHaveLength(0);

    const verdict = evaluateBaselineJustification({
      baseline: baselineOf({ 'sitemap-jobs-zurigo.xml': zurigoAfter }),
      ledger: { 'sitemap-jobs-zurigo.xml': { ratePct: 75.0068, atDepthGtMax: 2755 } },
    });
    expect(verdict.widened.map((w) => w.name)).toEqual(['sitemap-jobs-zurigo.xml']);
  });
});

describe('carryForwardReasons — a rebaseline must not erase the mechanism', () => {
  it('carries a reason onto an entry that did not get worse', () => {
    const next: Record<string, Entry> = { 'sitemap-a.xml': { total: 100, atDepthGtMax: 74, ratePct: 74 } };
    const { carried, dropped } = carryForwardReasons({
      previousPerSitemap: { 'sitemap-a.xml': { total: 100, atDepthGtMax: 75, ratePct: 75, reason: A_REAL_REASON } },
      nextPerSitemap: next,
    });
    expect(carried).toEqual(['sitemap-a.xml']);
    expect(dropped).toHaveLength(0);
    expect(next['sitemap-a.xml'].reason).toBe(A_REAL_REASON);
  });

  it('DROPS the reason when the rate regressed — it argued about the old number', () => {
    const next: Record<string, Entry> = { 'sitemap-a.xml': { total: 100, atDepthGtMax: 90, ratePct: 90 } };
    const { carried, dropped } = carryForwardReasons({
      previousPerSitemap: { 'sitemap-a.xml': { total: 100, atDepthGtMax: 75, ratePct: 75, reason: A_REAL_REASON } },
      nextPerSitemap: next,
    });
    expect(carried).toHaveLength(0);
    expect(dropped).toEqual([{ name: 'sitemap-a.xml', from: 75, to: 90 }]);
    expect(next['sitemap-a.xml'].reason).toBeUndefined();
  });

  it('never invents an entry the new baseline does not have', () => {
    const next: Record<string, Entry> = {};
    carryForwardReasons({
      previousPerSitemap: { 'sitemap-gone.xml': { total: 100, atDepthGtMax: 75, ratePct: 75, reason: A_REAL_REASON } },
      nextPerSitemap: next,
    });
    expect(Object.keys(next)).toHaveLength(0);
  });
});

describe('the shipped data/bfs-depth-baseline.json', () => {
  // `data/` is deliberately absent from the sparse worktrees agents use on this
  // machine (CLAUDE.md), so skip there rather than add a known false red — but
  // never let that skip hide a missing file in CI, where the checkout is full.
  const present = existsSync(BASELINE_PATH);

  it('is present in CI', () => {
    if (!process.env.CI) return; // local sparse worktree
    expect(present, `${BASELINE_PATH} missing in CI`).toBe(true);
  });

  describe.skipIf(!present)('content', () => {
    const baseline = present ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { perSitemap: {} };
    const verdict = evaluateBaselineJustification({ baseline });

    it('registers no high baseline without either a reason or a ledger line', () => {
      expect(
        verdict.unjustified.map((u) => `${u.name} ${u.ratePct.toFixed(2)}%`),
        'A sitemap family was registered as majority-unreachable with nothing written down.\n' +
          'Fix the internal linking so it drops below the threshold, or add a `reason` to the\n' +
          'entry in data/bfs-depth-baseline.json saying why the buried state is correct.',
      ).toEqual([]);
    });

    it('has not widened any grandfathered entry', () => {
      expect(
        verdict.widened.map((w) => `${w.name} ${w.frozenRatePct}% → ${w.ratePct.toFixed(2)}%`),
        'A grandfathered high baseline got worse. A carried defect may not be widened —\n' +
          'this is the rebaseline path that nothing else in the repo checks.',
      ).toEqual([]);
    });

    it('carries no stale ledger line', () => {
      expect(
        verdict.staleLedger.map((s) => `${s.name} (${s.why})`),
        'Delete these lines from UNJUSTIFIED_HIGH_BASELINES — they no longer describe a\n' +
          'high, unjustified entry. The ledger only ever shrinks.',
      ).toEqual([]);
    });

    it('the ledger describes entries that really are in the baseline', () => {
      for (const name of Object.keys(UNJUSTIFIED_HIGH_BASELINES)) {
        expect(baseline.perSitemap, `ledger names ${name}`).toHaveProperty(name);
      }
    });
  });
});
