// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const OBSERVER_SCRIPT = fileURLToPath(new URL('../scripts/ci/phase-timing-observer.mjs', import.meta.url));

/** Runs the real `--recovery-ready` CLI the deploy workflow calls. */
function recoveryReadyCli(historyRows: string[], runIds: number[], currentRunId: number, recoveryRunsEnv?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-timing-observer-'));
  try {
    const historyPath = path.join(dir, 'memory-peaks.jsonl');
    const runsPath = path.join(dir, 'runs.json');
    fs.writeFileSync(historyPath, `${historyRows.join('\n')}\n`, 'utf8');
    fs.writeFileSync(runsPath, runStatuses(runIds, currentRunId), 'utf8');
    const env: Record<string, string | undefined> = {
      ...process.env,
      PHASE_TIMING_HISTORY: historyPath,
      PHASE_TIMING_RUNS_FILE: runsPath,
      PHASE_TIMING_RUN_ID: String(currentRunId),
      PHASE_TIMING_REQUIRED_LOCALES: 'de',
    };
    delete env.GITHUB_OUTPUT;
    delete env.PHASE_TIMING_RECOVERY_RUNS;
    if (recoveryRunsEnv !== undefined) env.PHASE_TIMING_RECOVERY_RUNS = recoveryRunsEnv;
    const result = spawnSync(process.execPath, [OBSERVER_SCRIPT, '--recovery-ready'], { env, encoding: 'utf8' });
    return { status: result.status, ready: result.stdout.trim(), stderr: result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  it('reads the recovery window from the environment without letting a malformed value disable the closer', () => {
    const history = [
      profileRow(1),
      profileRow(2),
      profileRow(3),
      profileRow(4, 140000),
      profileRow(5, 105000),
      profileRow(6, 105000),
      profileRow(7, 105000),
    ];

    const unset = recoveryReadyCli(history, [5, 6, 7], 7);
    expect(unset).toMatchObject({ status: 0, ready: 'true' });
    expect(unset.stderr).not.toContain('[int-from-env]');

    // A non-numeric or non-positive value used to reach the predicate as NaN
    // or 0, which made the recovery false forever with no signal: the alarm
    // could never be closed and nothing went red.
    for (const malformed of ['tre', '0', '-3', '1e1', '3 runs']) {
      const result = recoveryReadyCli(history, [5, 6, 7], 7, malformed);
      expect(result, malformed).toMatchObject({ status: 0, ready: 'true' });
      expect(result.stderr, malformed).toContain('::warning::[int-from-env] PHASE_TIMING_RECOVERY_RUNS=');
    }

    // A valid value is honoured: four runs are required, only three are listed.
    const stricter = recoveryReadyCli(history, [5, 6, 7], 7, '4');
    expect(stricter).toMatchObject({ status: 0, ready: 'false' });
    expect(stricter.stderr).not.toContain('[int-from-env]');
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
