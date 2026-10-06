// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatPhaseTimingSummary,
  hasStablePhaseTimingRecovery,
  PHASE_TIMING_RECOVERY_RUNS,
  observePhaseTimings,
  parsePhaseMarkers,
} from '../scripts/ci/phase-timing-observer.mjs';

const HISTORY = [
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 100000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 200000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 110000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 210000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 100000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 220000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'cancelled', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 999999 }] },
  { kind: 'build-profile', locale: 'it', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 999999 }] },
].map((row) => JSON.stringify(row)).join('\n');

const RECOVERY_MARKER = 'related-search-clusters:closeBundle';

function profileRow(runId: number, ms = 100000, buildStatus = 'success', phases = [{ marker: RECOVERY_MARKER, ms }]) {
  return JSON.stringify({
    ts: `2026-10-06T00:00:${String(runId).padStart(2, '0')}.000Z`,
    kind: 'build-profile',
    locale: 'de',
    run_id: String(runId),
    build_status: buildStatus,
    phases,
  });
}

function runStatuses(runIds: number[], currentRunId: number, conclusions: Record<number, string> = {}) {
  return JSON.stringify(runIds.map((runId) => runId === currentRunId
    ? { databaseId: runId, status: 'in_progress', conclusion: null }
    : { databaseId: runId, status: 'completed', conclusion: conclusions[runId] ?? 'success' }));
}

function recoveryReady(historyRows: string[], runIds: number[], currentRunId: number, conclusions: Record<number, string> = {}) {
  return hasStablePhaseTimingRecovery({
    history: historyRows.join('\n'),
    runStatuses: runStatuses(runIds, currentRunId, conclusions),
    currentRunId: String(currentRunId),
    locales: ['de'],
  });
}

describe('phase-timing-observer', () => {
  it('parses only exact phase markers and orders the current table by cost', () => {
    const phases = parsePhaseMarkers([
      '[phase-timing-top] 1. ignored 9.00s',
      '[phase-timing] cheap:closeBundle 5ms calls=1',
      '[phase-timing] slow:closeBundle 1400ms calls=1',
    ].join('\n'));
    expect(phases).toEqual([
      { marker: 'slow:closeBundle', ms: 1400 },
      { marker: 'cheap:closeBundle', ms: 5 },
    ]);
  });

  it('raises an advisory only after the same-locale median is established', () => {
    const observation = observePhaseTimings({
      locale: 'de',
      history: HISTORY,
      log: [
        '[phase-timing] related-search-clusters:closeBundle 140000ms calls=1',
        '[phase-timing] jobs-seo-pages:closeBundle 230000ms calls=1',
      ].join('\n'),
    });
    expect(observation.historySamples).toBe(3);
    expect(observation.regressions.map((row) => row.marker)).toEqual(['related-search-clusters:closeBundle']);
    expect(observation.rows.find((row) => row.marker === 'jobs-seo-pages:closeBundle')?.regression).toBe(false);
    expect(formatPhaseTimingSummary(observation)).toContain('| `related-search-clusters:closeBundle` | 140.00s | 100.00s | +40.0% | ⚠️ oltre soglia |');
  });

  it('does not compare another locale or an insufficient baseline', () => {
    const observation = observePhaseTimings({
      locale: 'fr',
      history: HISTORY,
      log: '[phase-timing] related-search-clusters:closeBundle 999999ms calls=1',
    });
    expect(observation.historySamples).toBe(0);
    expect(observation.regressions).toEqual([]);
    expect(formatPhaseTimingSummary(observation)).toContain('baseline insufficiente');
  });

  it('ignores cancelled and failed build-profile rows', () => {
    const rows = observePhaseTimings({
      locale: 'de',
      history: [
        JSON.stringify({ kind: 'build-profile', locale: 'de', build_status: 'failure', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 1 }] }),
        JSON.stringify({ kind: 'build-profile', locale: 'de', build_status: 'cancelled', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 2 }] }),
      ].join('\n'),
      log: '[phase-timing] related-search-clusters:closeBundle 100ms calls=1',
    });
    expect(rows.historySamples).toBe(0);
    expect(rows.regressions).toEqual([]);
  });

  it('opens above the threshold but closes only after three consecutive measured green runs', () => {
    expect(PHASE_TIMING_RECOVERY_RUNS).toBe(3);
    const history = [
      profileRow(1),
      profileRow(2),
      profileRow(3),
      profileRow(4, 140000),
      profileRow(5, 105000),
      profileRow(6, 105000),
      profileRow(7, 105000),
    ];

    // The first 140% run is an opening regression; one good run after it is
    // deliberately insufficient to close the canonical issue.
    expect(recoveryReady(history.slice(0, 5), [3, 4, 5], 5)).toBe(false);
    expect(recoveryReady(history, [5, 6, 7], 7)).toBe(true);
  });

  it('does not close around the boundary: one later regression resets the window', () => {
    const history = [
      profileRow(1),
      profileRow(2),
      profileRow(3),
      profileRow(4, 105000),
      profileRow(5, 131000),
      profileRow(6, 105000),
      profileRow(7, 105000),
    ];
    expect(recoveryReady(history, [5, 6, 7], 7)).toBe(false);
  });

  it('never closes on a failed or cancelled run', () => {
    for (const outcome of ['failure', 'cancelled']) {
      const history = [
        profileRow(1),
        profileRow(2),
        profileRow(3),
        profileRow(4, 105000, outcome),
        profileRow(5, 105000),
        profileRow(6, 105000),
      ];
      expect(recoveryReady(history, [4, 5, 6], 6, { 4: outcome })).toBe(false);
    }
  });

  it('never closes when the current phase measurement is absent', () => {
    const history = [
      profileRow(1),
      profileRow(2),
      profileRow(3),
      profileRow(4, 105000),
      profileRow(5, 105000, 'success', []),
      profileRow(6, 105000),
    ];
    expect(recoveryReady(history, [4, 5, 6], 6)).toBe(false);
  });
});
