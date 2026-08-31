import { describe, expect, it } from 'vitest';

import { detectChurnAnomalies } from '../scripts/lib/job-dataset-churn-guard.mjs';

function quietEntry(date: string, added: number, removed: number) {
  return { date, totalJobs: 22000, added, removed, addedKeys: [], removedKeys: [] };
}

function addedKeysFor(host: string, count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => `url:https://${host}/job-${offset + i}`);
}

function entryWithTotals(
  date: string,
  totalJobs: number,
  added: number,
  updated: number,
  removed: number
) {
  return { date, totalJobs, added, updated, removed, addedKeys: [], removedKeys: [] };
}

describe('detectChurnAnomalies', () => {
  it('returns no anomalies when there is not enough baseline history yet (bootstrap)', () => {
    const history = {
      entries: [
        quietEntry('2026-08-24', 500, 480),
        quietEntry('2026-08-25', 520, 490),
      ],
    };
    expect(detectChurnAnomalies(history)).toEqual([]);
  });

  it('returns no anomalies when today is within the trailing baseline distribution', () => {
    const baseline = Array.from({ length: 10 }, (_, i) =>
      quietEntry(`2026-08-${10 + i}`, 450 + i * 5, 460 + i * 3)
    );
    const history = { entries: [...baseline, quietEntry('2026-08-20', 470, 470)] };
    expect(detectChurnAnomalies(history)).toEqual([]);
  });

  it('flags an added-side spike and attributes it to the dominant host (2026-08-24 fachkraft.ch case)', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => quietEntry(`2026-08-${10 + i}`, 500, 500));
    const today = {
      date: '2026-08-24',
      totalJobs: 26186,
      added: 3779,
      removed: 452,
      addedKeys: [
        ...addedKeysFor('www.fachkraft.ch', 3015),
        ...addedKeysFor('www.coopjobs.ch', 165),
        ...addedKeysFor('www.admin.ch', 32),
      ],
      removedKeys: [],
    };
    const history = { entries: [...baseline, today] };

    const anomalies = detectChurnAnomalies(history);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ date: '2026-08-24', metric: 'added', observed: 3779 });
    expect(anomalies[0].topHosts[0]).toEqual({ host: 'www.fachkraft.ch', count: 3015 });
  });

  it('flags a removed-side reabsorption spike a few days later', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => quietEntry(`2026-08-${10 + i}`, 500, 500));
    const today = quietEntry('2026-08-28', 984, 4719);
    const history = { entries: [...baseline, today] };

    const anomalies = detectChurnAnomalies(history);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ metric: 'removed', observed: 4719 });
  });

  it('does not flag a statistically large jump that stays under the absolute floor', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => quietEntry(`2026-08-${10 + i}`, 10, 10));
    const today = quietEntry('2026-08-20', 200, 10); // many sigma out, but well under the 1500 floor
    const history = { entries: [...baseline, today] };
    expect(detectChurnAnomalies(history)).toEqual([]);
  });

  it('flags a stale snapshot when the two most recent entries are identical on all four fields (#6713)', () => {
    const history = {
      entries: [
        entryWithTotals('2026-08-29', 22943, 33, 22557, 3),
        entryWithTotals('2026-08-30', 22943, 33, 22557, 3),
      ],
    };
    const anomalies = detectChurnAnomalies(history);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ date: '2026-08-30', metric: 'stale-snapshot' });
    expect(anomalies[0].observed).toContain('totalJobs=22943');
    expect(anomalies[0].observed).toContain('added=33');
    expect(anomalies[0].observed).toContain('updated=22557');
    expect(anomalies[0].observed).toContain('removed=3');
  });

  it('does not flag a stale snapshot when any of the four fields differ from the previous day', () => {
    const history = {
      entries: [
        entryWithTotals('2026-08-29', 22943, 33, 22557, 3),
        entryWithTotals('2026-08-30', 22943, 34, 22557, 3),
      ],
    };
    expect(detectChurnAnomalies(history)).toEqual([]);
  });
});
