/**
 * rate-baseline-internal-consistency.test.ts
 *
 * Guards the SHIPPED `mode:'rate'` ratchet baselines under `data/` against
 * the half-edit failure mode — the one that actually produced #4828's
 * misleading numbers.
 *
 * Why this exists (a real incident, not a hypothetical):
 *   `data/text-html-ratio-baseline.json` is normally written whole by the
 *   auditor's own seeder (`--update-baseline`), which derives `ratePct` from
 *   `offenders / scanned`. But a baseline is a plain JSON file, and twice now
 *   a single feature key has been hand-edited in place instead:
 *     - #5329 raised `eventi` to 10427/12572 (82.9383 %) to accept a
 *       then-current regression;
 *     - the follow-up (this PR) lowered it again to the measured reality
 *       after #5337 fixed the emission.
 *   A hand edit that updates `offenders` but forgets `ratePct` (or vice
 *   versa) is INVISIBLE: `ratePct` alone drives the per-feature rate cap in
 *   scripts/lib/mixAdjustedRateGate.mjs, while `offenders` alone drives the
 *   `minAbsDelta` noise floor. Desynchronised, the two halves of the
 *   AND-condition `curRate > rateCap && curOff > baseOff + minAbsDelta`
 *   describe two different worlds, and the gate silently stops meaning what
 *   the file says it means. Nothing in CI noticed — the audits read the two
 *   fields independently and neither cross-checks the other.
 *
 * This test is deliberately NOT a quality threshold: it asserts only that
 * each feature's three stored numbers are mutually consistent. It therefore
 * never needs relaxing when a baseline is legitimately re-seeded, and it
 * cannot be satisfied by widening a gate. Re-seeding writes all three fields
 * together, so a correct re-seed passes by construction.
 *
 * Do NOT "fix" a failure here by editing `ratePct` to match a wrong
 * `offenders` (AGENTS.md non-negotiable #1). Re-seed the baseline from a real
 * run, or correct the emission.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface FeatureRow {
  scanned?: number;
  offenders?: number;
  ratePct?: number;
}

interface RateBaseline {
  mode?: string;
  byFeature?: Record<string, FeatureRow>;
}

const DATA_DIR = join(__dirname, '..', '..', 'data');

/**
 * Floor on how many baselines this test must find. A glob that silently
 * stops matching turns the whole file into a no-op that still reports green
 * — the exact "test became vacuous" class called out in #5337's review. If a
 * rate baseline is renamed or removed on purpose, lower this number in the
 * same commit and say why in the PR body.
 */
const MIN_RATE_BASELINES = 4;

function loadRateBaselines(): Array<{ file: string; baseline: RateBaseline }> {
  const out: Array<{ file: string; baseline: RateBaseline }> = [];
  for (const name of readdirSync(DATA_DIR)) {
    if (!name.endsWith('baseline.json')) continue;
    let parsed: RateBaseline;
    try {
      parsed = JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as RateBaseline;
    } catch {
      continue; // non-JSON / unrelated artefact — other tests own those
    }
    if (parsed?.mode !== 'rate') continue;
    if (!parsed.byFeature || Object.keys(parsed.byFeature).length === 0) continue;
    out.push({ file: name, baseline: parsed });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const baselines = loadRateBaselines();

describe('rate-mode ratchet baselines are internally consistent', () => {
  it(`finds at least ${MIN_RATE_BASELINES} rate baselines with per-feature rows`, () => {
    // Fails loudly instead of degrading to a vacuous pass.
    expect(baselines.length).toBeGreaterThanOrEqual(MIN_RATE_BASELINES);
  });

  for (const { file, baseline } of baselines) {
    describe(file, () => {
      const rows = Object.entries(baseline.byFeature ?? {});

      it('stores ratePct that matches offenders / scanned for every feature', () => {
        const mismatched: string[] = [];
        for (const [feature, row] of rows) {
          const scanned = Number(row.scanned ?? 0);
          const offenders = Number(row.offenders ?? 0);
          const stored = Number(row.ratePct ?? 0);
          const derived = scanned > 0 ? (offenders / scanned) * 100 : 0;
          // Baselines round ratePct to 4 decimals, so allow half a unit in
          // the last stored place plus a relative epsilon for large rates.
          const tolerance = 0.00005 + Math.abs(derived) * 1e-9;
          if (Math.abs(derived - stored) > tolerance) {
            mismatched.push(
              `${feature}: stored ratePct=${stored} but offenders/scanned = ${offenders}/${scanned} = ${derived.toFixed(6)}`,
            );
          }
        }
        expect(mismatched, `desynchronised baseline rows in data/${file}`).toEqual([]);
      });

      it('never records more offenders than pages scanned', () => {
        const impossible = rows
          .filter(([, row]) => Number(row.offenders ?? 0) > Number(row.scanned ?? 0))
          .map(([feature, row]) => `${feature}: ${row.offenders} offenders > ${row.scanned} scanned`);
        expect(impossible, `impossible baseline rows in data/${file}`).toEqual([]);
      });

      it('records non-negative, finite numbers for every feature', () => {
        const bad: string[] = [];
        for (const [feature, row] of rows) {
          for (const key of ['scanned', 'offenders', 'ratePct'] as const) {
            const v = row[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
              bad.push(`${feature}.${key} = ${String(v)}`);
            }
          }
        }
        expect(bad, `malformed baseline numbers in data/${file}`).toEqual([]);
      });
    });
  }
});
