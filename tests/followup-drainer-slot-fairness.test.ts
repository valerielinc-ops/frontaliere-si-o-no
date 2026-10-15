import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  SLOT_FAIRNESS_SCAN_MAX,
  slotFairnessOrder,
  slotFairnessWindow,
} from '../scripts/ci/followup-drainer.mjs';

const T0 = Date.parse('2026-09-06T09:00:00Z');
const HOUR = 3_600_000;
const issue = (number: number, priority: 'high' | 'low' = 'low') => ({
  number,
  createdAt: new Date(T0 + number * HOUR).toISOString(),
  labels: [{ name: `fu-prio:${priority}` }],
});

describe('fairness bounded dello slot issue-fix', () => {
  it('misura solo la classe di priorità della testa', () => {
    expect(slotFairnessWindow([issue(1, 'high'), issue(2, 'high'), issue(3, 'low')])
      .map((entry) => entry.number)).toEqual([1, 2]);
  });

  it('resta bounded e non cambia una coda con un solo candidato', () => {
    const queue = Array.from({ length: SLOT_FAIRNESS_SCAN_MAX + 2 }, (_, index) => issue(index + 1));
    expect(slotFairnessWindow(queue)).toHaveLength(SLOT_FAIRNESS_SCAN_MAX);
    expect(slotFairnessWindow([issue(1)])).toEqual([]);
    expect(slotFairnessOrder([issue(1)], new Map([[1, T0]])).map((entry) => entry.number)).toEqual([1]);
  });

  it('porta davanti chi non ha una promozione leggibile senza scavalcare la priorità', () => {
    const queue = [issue(10), issue(20), issue(30), issue(40, 'high')];
    const promoted = new Map<number, number | null>([
      [10, T0 + 20 * HOUR],
      [20, null],
      [30, T0 + 2 * HOUR],
    ]);

    expect(slotFairnessOrder(queue, promoted).map((entry) => entry.number)).toEqual([20, 30, 10, 40]);
  });

  it('a parità di timestamp mantiene l ordine creato dalla coda', () => {
    const queue = [issue(10), issue(20), issue(30)];
    const promoted = new Map([[10, T0], [20, T0], [30, T0]]);
    expect(slotFairnessOrder(queue, promoted).map((entry) => entry.number)).toEqual([10, 20, 30]);
  });

  it('valida env malformato e clampa env enorme al massimo operativo', () => {
    const moduleUrl = new URL('../scripts/ci/followup-drainer.mjs', import.meta.url).href;
    const code = `import { SLOT_FAIRNESS_SCAN_MAX } from ${JSON.stringify(moduleUrl)}; console.log(SLOT_FAIRNESS_SCAN_MAX);`;
    const run = (value: string) => Number(execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', code],
      {
        encoding: 'utf8',
        env: { ...process.env, FOLLOWUP_SLOT_FAIRNESS_SCAN_MAX: value },
      },
    ).trim().split('\n').at(-1));

    expect(run('NaN')).toBe(5);
    expect(run('999999')).toBe(25);
  });
});
