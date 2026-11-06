/**
 * Verifies the per-crossing rolling-30-day averages script
 * (`scripts/compute-border-wait-averages.mjs`).
 *
 * The script reads `data/border-wait-history/*.json` and emits
 * `data/border-wait-averages.json`. We exercise the formatting + the
 * degenerate-range filter through a temp repo root and a minimal fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'compute-border-wait-averages.mjs');

function nDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function bucket(avg: number) {
  return { min: avg, avg, max: avg, samples: 1 };
}

describe('compute-border-wait-averages', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-averages-'));
    fs.mkdirSync(path.join(tmp, 'data', 'border-wait-history'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    // The script resolves repo root via `__dirname/..`, so when copied into
    // `<tmp>/scripts/` it will treat `<tmp>` as the repo root.
    fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'compute-border-wait-averages.mjs'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes morning/evening ranges per crossing and drops degenerate values', () => {
    const day = nDaysAgo(1);
    const hours: Array<{ min: number; avg: number; max: number; samples: number } | null> =
      Array(24).fill(null);
    // Morning peak (06-09): avg 5..8 → range "5-8 min"
    [5, 6, 7, 8].forEach((v, i) => (hours[6 + i] = bucket(v)));
    // Evening peak (16-19): avg 12..18 → range "12-18 min"
    [12, 14, 16, 18].forEach((v, i) => (hours[16 + i] = bucket(v)));

    const degenerateHours: Array<{ min: number; avg: number; max: number; samples: number } | null> =
      Array(24).fill(null);
    [0, 0, 1, 1].forEach((v, i) => (degenerateHours[6 + i] = bucket(v)));
    [0, 1, 0, 1].forEach((v, i) => (degenerateHours[16 + i] = bucket(v)));

    fs.writeFileSync(
      path.join(tmp, 'data', 'border-wait-history', `${day}.json`),
      JSON.stringify({
        date: day,
        perCrossing: {
          'chiasso-strada': hours,
          'biegno-indemini': degenerateHours,
        },
      }),
    );

    execFileSync('node', [path.join(tmp, 'scripts', 'compute-border-wait-averages.mjs')]);

    const out = JSON.parse(
      fs.readFileSync(path.join(tmp, 'data', 'border-wait-averages.json'), 'utf-8'),
    );

    expect(out['chiasso-strada']).toBeDefined();
    expect(out['chiasso-strada'].morning).toMatch(/\b\d+-\d+ min\b/);
    expect(out['chiasso-strada'].evening).toMatch(/\b\d+-\d+ min\b/);

    // Degenerate (high < 2) → filtered out, editorial fallback wins.
    expect(out['biegno-indemini']).toBeUndefined();
  });

  it('returns an empty object when no history files are present', () => {
    execFileSync('node', [path.join(tmp, 'scripts', 'compute-border-wait-averages.mjs')]);
    const out = JSON.parse(
      fs.readFileSync(path.join(tmp, 'data', 'border-wait-averages.json'), 'utf-8'),
    );
    expect(out).toEqual({});
  });
});
