/**
 * seo-defect-ratchet.test.ts
 *
 * Observer for the per-family SEO defect ledger (`data/seo-defect-families.json`)
 * and its ratchet (`scripts/lib/seoDefectRatchet.mjs`), which together make the
 * seven content-defect families aggregated by #5845 / #6222 trackable one by one
 * instead of as a flat list nobody can measure progress against.
 *
 * Structure mirrors tests/seo/audit-h1-title-duplicates-rate-gate.test.ts — the
 * repo's existing rate-ratchet unit-test shape: synthetic baseline, synthetic
 * draws, assert the AND-condition and the noise floor.
 *
 * WHAT THIS FILE IS FOR, beyond unit coverage. Three of the assertions below
 * are structural, and they are the ones that keep the mechanism from rotting:
 *
 *   - every ledger family names a gate that is really registered in
 *     `scripts/audit-all.mjs` — a family whose measure quietly disappears is
 *     the failure mode this whole ledger exists to prevent, and it is exactly
 *     what happened to `engine/` when its mirror was disabled and nothing said
 *     so (see the workspace CLAUDE.md);
 *   - every ceiling carries provenance — no number without the run it came from;
 *   - replaying the SEALED measurement through the ratchet passes — i.e. the
 *     committed ceilings were seeded from a real measurement and start green,
 *     rather than being a round number somebody liked.
 *
 * Do NOT relax a ceiling to make a build pass (AGENTS.md non-negotiable #1).
 * The ceiling descends via `npm run seo:families:tighten` after a
 * measured improvement, and `tightenLedger()` refuses to move it the other way.
 *
 * Runs in the ordinary vitest suite (tests.yml): it reads a committed JSON file
 * and a pure .mjs module, walks no `dist/`, and needs nothing under `data/jobs`
 * or `public/`, so it is green in a sparse agent worktree too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TOLERANCE,
  evaluateCeiling,
  familyEntry,
  readLedger,
  resolveLedgerPath,
  tightenLedger,
} from '../../scripts/lib/seoDefectRatchet.mjs';
import { ROOT } from '../../scripts/lib/audit-runner.mjs';

interface Measurement {
  observedOffenders?: number[];
  worstBucket?: { runId: string; offenders: number; filesScanned: number; ratePct: number };
  measuredAt?: string;
}
interface FamilyEntry {
  issue: string;
  gate: string;
  script?: string;
  enforcement: 'ratchet' | 'zero-tolerance' | 'existing-baseline' | 'unmeasured';
  ceilingRatePct: number | null;
  tolerance?: { relPct?: number; absPp?: number; minAbsDelta?: number };
  status: string;
  blocker?: string;
  unblockedBy?: string;
  baselineFile?: string;
  measurement?: Measurement;
}

const ledger = readLedger() as { version: number; families: Record<string, FamilyEntry> };
const families = Object.entries(ledger.families);

/** Auditor names really registered in the unified runner. Read as SOURCE, not
 *  imported: importing scripts/audit-all.mjs executes its CLI `main()`. */
const auditAllSource = readFileSync(join(ROOT, 'scripts', 'audit-all.mjs'), 'utf8');
const REGISTERED = new Set(
  [...auditAllSource.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
);

describe('seo defect ledger — structure', () => {
  it('is non-empty and covers both aggregate issues', () => {
    expect(families.length).toBeGreaterThan(0);
    const issues = families.map(([, e]) => e.issue).join(' ');
    expect(issues).toContain('#5845');
    expect(issues).toContain('#6222');
  });

  it('every family names a gate registered in audit-all.mjs, or says why it cannot', () => {
    expect(REGISTERED.size).toBeGreaterThan(10); // the regex actually matched something
    for (const [name, e] of families) {
      if (e.enforcement === 'unmeasured') {
        // A family with no measure must say what blocks it and what would
        // unblock it — otherwise "unmeasured" is just "fuori scope" wearing a
        // schema (AGENTS.md non-negotiable #8).
        expect(e.blocker, `${name} is unmeasured without a blocker`).toBeTruthy();
        expect(e.unblockedBy, `${name} is unmeasured without an unblock path`).toBeTruthy();
        continue;
      }
      const auditor = e.gate.replace(/^audit:all\//, '');
      expect(REGISTERED.has(auditor), `${name}: gate "${e.gate}" is not registered in scripts/audit-all.mjs`).toBe(true);
    }
  });

  it('every measured family carries provenance — no ceiling without an audit trail', () => {
    for (const [name, e] of families) {
      if (e.enforcement === 'unmeasured') continue;
      expect(e.measurement, `${name} has no measurement block`).toBeTruthy();
      expect(e.measurement?.measuredAt, `${name} has no measuredAt`).toBeTruthy();
      expect(
        Array.isArray(e.measurement?.observedOffenders) && e.measurement!.observedOffenders!.length > 0,
        `${name} records no observed offender counts`,
      ).toBe(true);
    }
  });

  it('a ratcheted family always seals its worst bucket, with the run id', () => {
    for (const [name, e] of families) {
      if (e.enforcement !== 'ratchet') continue;
      const w = e.measurement?.worstBucket;
      expect(w, `${name} is ratcheted without a worstBucket`).toBeTruthy();
      expect(w!.runId, `${name}'s worstBucket has no runId`).toMatch(/^\d+$/);
      expect(w!.offenders).toBe(Math.max(...(e.measurement!.observedOffenders ?? [])));
    }
  });

  it('zero-tolerance families keep ceiling 0 and do NOT read the ledger', () => {
    // The invariant that makes this PR additive rather than a relaxation: the
    // five families already at zero keep their untouched hard gate. Asserted on
    // the source, because a future edit wiring one of them to the ratchet would
    // silently turn a zero-tolerance gate into a ceiling gate.
    for (const [name, e] of families) {
      if (e.enforcement !== 'zero-tolerance') continue;
      expect(e.ceilingRatePct, `${name} is zero-tolerance with a non-zero ceiling`).toBe(0);
      const src = readFileSync(join(ROOT, e.script!), 'utf8');
      expect(
        src.includes('seoDefectRatchet'),
        `${name} (${e.script}) reads the ratchet but is declared zero-tolerance`,
      ).toBe(false);
    }
  });
});

describe('seo defect ledger — the committed ceilings start green', () => {
  it('replaying each sealed measurement through the ratchet PASSES', () => {
    // Requirement 2 of the ticket: the initial ceiling is the CURRENT
    // re-measured count, so the ratchet begins green and tightens from there.
    // If someone hand-edits a ceiling below its own sealing measurement, this
    // fails — which is the correct outcome, since the very next CI run would
    // have gone red with nothing to fix.
    for (const [name, e] of families) {
      if (e.enforcement !== 'ratchet') continue;
      const w = e.measurement!.worstBucket!;
      const verdict = evaluateCeiling({
        family: name,
        offenders: w.offenders,
        filesScanned: w.filesScanned,
        entry: familyEntry(ledger, name),
      });
      expect(verdict.ratcheted).toBe(true);
      expect(verdict.passed, `${name} is red on the very measurement it was sealed from: ${verdict.humanSummary}`).toBe(true);
    }
  });

  it('every observed bucket, not just the worst, passes its ceiling', () => {
    for (const [name, e] of families) {
      if (e.enforcement !== 'ratchet') continue;
      const w = e.measurement!.worstBucket!;
      for (const offenders of e.measurement!.observedOffenders!) {
        const verdict = evaluateCeiling({
          family: name,
          offenders,
          // Bucket denominators differ by <0.1 % across the four runs; using the
          // worst bucket's is close enough to prove none of them flaps, and
          // errs strict (the largest denominator is not the friendliest one for
          // the smallest counts).
          filesScanned: w.filesScanned,
          entry: familyEntry(ledger, name),
        });
        expect(verdict.passed, `${name} flaps on a real bucket draw of ${offenders}: ${verdict.humanSummary}`).toBe(true);
      }
    }
  });
});

describe('evaluateCeiling — verdict', () => {
  const entry = { enforcement: 'ratchet' as const, ceilingRatePct: 5, tolerance: { relPct: 0, absPp: 0.1, minAbsDelta: 50 } };

  it('at the ceiling → PASS', () => {
    const v = evaluateCeiling({ family: 'f', offenders: 500, filesScanned: 10_000, entry });
    expect(v.ratePct).toBe(5);
    expect(v.passed).toBe(true);
  });

  it('a real regression over the cap → FAIL, and the message carries both numbers', () => {
    const v = evaluateCeiling({ family: 'f', offenders: 900, filesScanned: 10_000, entry });
    expect(v.passed).toBe(false);
    expect(v.exceededBy).toBe(400);
    expect(v.humanSummary).toContain('REGRESSION');
    expect(v.humanSummary).toContain('5.000000 %'); // the ceiling it was judged against
    expect(v.humanSummary).toContain('900 offender(s)'); // and the draw
  });

  it('AND-condition: over the rate cap but under the absolute floor → PASS, and SAYS it is not a clean pass', () => {
    // 60/1000 = 6 % is over the 5.1 % cap, but only 10 offenders above the
    // ~50 the ceiling allows on this (shrunken) denominator — noise, not a
    // defect. Same guard as every other rate ratchet in the repo (class #1604).
    //
    // The message assertion is the load-bearing half. A pass whose rate is
    // above the cap must not print like a comfortable pass: that sentence is
    // how a real regression gets written off as a denominator artifact, which
    // scripts/lib/mixAdjustedRateGate.mjs records happening on 2026-08-06.
    const v = evaluateCeiling({ family: 'f', offenders: 60, filesScanned: 1000, entry });
    expect(v.ratePct).toBe(6);
    expect(v.passed).toBe(true);
    expect(v.heldByNoiseFloor).toBe(true);
    expect(v.humanSummary).toContain('ABOVE the ceiling');
    expect(v.humanSummary).toContain('noise floor');
    expect(v.humanSummary).not.toContain('at/within');
  });

  it('under the ceiling → PASS and proposes the exact tighten command', () => {
    const v = evaluateCeiling({ family: 'f', offenders: 300, filesScanned: 10_000, entry });
    expect(v.passed).toBe(true);
    expect(v.tightenToRatePct).toBe(3);
    expect(v.humanSummary).toContain('seo:families:tighten');
    expect(v.humanSummary).toContain('--rate=3');
  });

  it('a vacuous run (0 files scanned) takes NO verdict and proposes NO tightening', () => {
    // The trap this closes: a fully-sampled-out slice reports 0 offenders, and
    // a naive ratchet would read that as "improved to zero" and seal a ceiling
    // no real corpus can meet. Rate goes unmeasured, tightenToRatePct stays
    // null, and the summary says VACUOUS out loud.
    const v = evaluateCeiling({ family: 'f', offenders: 0, filesScanned: 0, entry });
    expect(v.measured).toBe(false);
    expect(v.passed).toBe(true);
    expect(v.tightenToRatePct).toBeNull();
    expect(v.humanSummary).toContain('VACUOUS');
  });

  it('no ledger entry → ratcheted:false, so the caller keeps its own strict verdict', () => {
    const v = evaluateCeiling({ family: 'f', offenders: 42, filesScanned: 10_000, entry: null });
    expect(v.ratcheted).toBe(false);
  });

  it('familyEntry refuses anything that is not enforcement:"ratchet"', () => {
    const l = { families: { z: { enforcement: 'zero-tolerance', ceilingRatePct: 0 } } };
    expect(familyEntry(l, 'z')).toBeNull();
    expect(familyEntry(l, 'absent')).toBeNull();
    expect(familyEntry(null, 'z')).toBeNull();
  });

  it('DEFAULT_TOLERANCE matches the repo rate-ratchet tolerance it is documented against', () => {
    expect(DEFAULT_TOLERANCE.relPct).toBe(20);
  });
});

describe('tightenLedger — the one-way valve', () => {
  const prov = { runId: '1', measuredAt: '2026-08-25', filesScanned: 10, sampleRate: 1, observedOffenders: 1 };

  it('lowering a ceiling works and records the previous value', () => {
    const next = tightenLedger({ ledger, family: 'duplicate-meta-description', ratePct: 4.0, provenance: prov });
    expect(next.families['duplicate-meta-description'].ceilingRatePct).toBe(4.0);
    expect(next.families['duplicate-meta-description'].previousCeilingRatePct).toBe(4.9043);
    // …and does not mutate the ledger it was given.
    expect(ledger.families['duplicate-meta-description'].ceilingRatePct).toBe(4.9043);
  });

  it('RAISING a ceiling throws — this is what makes it a ratchet', () => {
    expect(() =>
      tightenLedger({ ledger, family: 'duplicate-meta-description', ratePct: 9.9, provenance: prov }),
    ).toThrow(/refusing to RAISE/);
  });

  it('a raise is possible only by asking for it explicitly, and leaves a mark', () => {
    const next = tightenLedger({
      ledger, family: 'duplicate-meta-description', ratePct: 9.9, provenance: prov, allowRaise: true,
    });
    expect(next.families['duplicate-meta-description'].raised).toBe(true);
    expect(next.families['duplicate-meta-description'].previousCeilingRatePct).toBe(4.9043);
  });

  it('refuses a ceiling with no provenance — no number without the run behind it', () => {
    expect(() =>
      tightenLedger({ ledger, family: 'duplicate-meta-description', ratePct: 1, provenance: { runId: '1' } as never }),
    ).toThrow(/provenance/);
  });

  it('refuses to tighten a zero-tolerance family — 0 is already the tightest ceiling', () => {
    expect(() =>
      tightenLedger({ ledger, family: 'breadcrumb-coverage', ratePct: 0, provenance: prov }),
    ).toThrow(/not a ratchet/);
  });

  it('refuses an unknown family', () => {
    expect(() => tightenLedger({ ledger, family: 'nope', ratePct: 0, provenance: prov })).toThrow(/unknown family/);
  });

  it('the ledger path resolves inside the repo', () => {
    expect(resolveLedgerPath()).toBe(join(ROOT, 'data', 'seo-defect-families.json'));
  });
});
