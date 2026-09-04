import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { detectChurnAnomalies } from '../scripts/lib/job-dataset-churn-guard.mjs';

const TEST_NOW_MS = Date.now();

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

function daysAgo(days: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(TEST_NOW_MS - days * 86_400_000));
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
    expect(anomalies[0].issueTitle).toMatch(/^\[job-dataset-churn\] added spike [a-f0-9]{10}: www\.fachkraft\.ch$/);
    expect(anomalies[0].topHosts[0]).toEqual({ host: 'www.fachkraft.ch', count: 3015 });
  });

  it('keeps one cross-day issue key for the same metric and host, but separates new hosts (#6720)', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => quietEntry(daysAgo(11 - i), 500, 500));
    const anomalyFor = (date: string, host: string) =>
      detectChurnAnomalies({
        entries: [
          ...baseline,
          {
            ...quietEntry(date, 3000, 500),
            addedKeys: addedKeysFor(host, 3000),
          },
        ],
      })[0];

    const firstDay = anomalyFor(daysAgo(1), 'jobs.example.com');
    const secondDay = anomalyFor(daysAgo(0), 'jobs.example.com');
    const differentHost = anomalyFor(daysAgo(0), 'careers.example.org');

    expect(firstDay.issueTitle).toBe(secondDay.issueTitle);
    expect(differentHost.issueTitle).not.toBe(firstDay.issueTitle);
  });

  it('keeps the date in unattributed spike keys so unrelated unknown events are not collapsed (#6720)', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => quietEntry(daysAgo(11 - i), 500, 500));
    const issueTitleFor = (date: string) =>
      detectChurnAnomalies({ entries: [...baseline, quietEntry(date, 3000, 500)] })[0].issueTitle;

    expect(issueTitleFor(daysAgo(1))).not.toBe(issueTitleFor(daysAgo(0)));
  });

  it('wires the stable issue title into the workflow reporter (#6720)', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/persist-job-stats.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain(
      'title=$(jq -r ".[${i}].issueTitle" data/job-dataset-churn-issues.json)',
    );
    expect(workflow).not.toContain('title="[job-dataset-churn] ${date}: ${metric} spike"');
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
    expect(anomalies[0].issueTitle).toBe('[job-dataset-churn] stale snapshot');
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
