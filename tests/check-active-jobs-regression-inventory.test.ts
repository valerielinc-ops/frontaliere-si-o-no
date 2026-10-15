// @vitest-environment node
/**
 * Deploy gate scripts/check-active-jobs-regression.mjs con la soglia di
 * ammissione delle agenzie (decisione del proprietario 2026-10-03): il gate
 * misura l'inventario = pubblicati (`totals.activeJobs` di data/jobs-stats.json)
 * + trattenuti per traduzione (`translationHold.held` di data/jobs-meta.json,
 * scritto dalla stessa assemblea). Soglia (−25%) e baseline restano quelle.
 *
 * Lo script legge i file relativi alla cwd, quindi gira in una cartella
 * temporanea in un processo figlio: nessun file tracciato viene toccato.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-active-jobs-regression.mjs');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Scenario = {
  baseline: number;
  published: number;
  meta?: Record<string, unknown> | null;
};

function runGate({ baseline, published, meta }: Scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'active-jobs-gate-'));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'data'));
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(cwd, 'data', name), `${JSON.stringify(value, null, 2)}\n`);
  write('jobs-stats.json', { totals: { activeJobs: published } });
  write('active-jobs-baseline.json', { activeJobs: baseline, updatedAt: '2026-09-29T12:40:02.916Z', note: 'fixture' });
  if (meta) write('jobs-meta.json', meta);
  const env = { ...process.env };
  delete env.ACTIVE_JOBS_REGRESSION_THRESHOLD;
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
  const savedBaseline = JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'active-jobs-baseline.json'), 'utf8'));
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, savedBaseline };
}

const metaWithHeld = (published: number, held: number) => ({
  totalJobs: published,
  translationHold: { held, byCrawler: { sta: held }, oldestHeldSince: null },
});

describe('active-jobs gate counts the inventory: published + held for translation', () => {
  it('passes when the published count drops 30% because jobs were held, not lost', () => {
    const gate = runGate({ baseline: 1000, published: 700, meta: metaWithHeld(700, 300) });
    expect(gate.status).toBe(0);
    expect(gate.output).toContain('published=700 + held for translation=300 = 1000');
    expect(gate.savedBaseline.activeJobs).toBe(1000); // threshold and baseline untouched
  });

  it('still fails on a real loss, held count present', () => {
    const gate = runGate({ baseline: 1000, published: 700, meta: metaWithHeld(700, 0) });
    expect(gate.status).toBe(1);
    expect(gate.output).toContain('active-jobs regression');
  });

  it('a bug that drops held jobs counts as a loss', () => {
    // 700 published + 40 held left of the 300 that were waiting: −26%.
    const gate = runGate({ baseline: 1000, published: 700, meta: metaWithHeld(700, 40) });
    expect(gate.status).toBe(1);
  });

  it('ratchets the baseline on the inventory', () => {
    const gate = runGate({ baseline: 1000, published: 900, meta: metaWithHeld(900, 300) });
    expect(gate.status).toBe(0);
    expect(gate.savedBaseline).toMatchObject({ activeJobs: 1200, previousActiveJobs: 1000, publishedJobs: 900, heldForTranslation: 300 });
  });

  it('without a trustworthy held count it behaves exactly as before (no silent pass)', () => {
    for (const meta of [
      null, // no meta at all
      { totalJobs: 700 }, // assembler before the threshold
      { totalJobs: 650, translationHold: { held: 300 } }, // stale meta, other assembly
      { totalJobs: 700, translationHold: { held: -5 } },
      { totalJobs: 700, translationHold: { held: '300' } },
    ]) {
      const gate = runGate({ baseline: 1000, published: 700, meta });
      expect(gate.status, JSON.stringify(meta)).toBe(1);
      expect(gate.output).toContain('comparing published jobs only');
    }
    const ok = runGate({ baseline: 1000, published: 1100, meta: null });
    expect(ok.status).toBe(0);
    expect(ok.savedBaseline).toEqual(expect.objectContaining({ activeJobs: 1100, previousActiveJobs: 1000 }));
    expect(ok.savedBaseline).not.toHaveProperty('heldForTranslation');
  });
});
