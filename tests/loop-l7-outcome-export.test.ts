import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL7ExperimentOutcome,
  buildUnavailableL7ExperimentOutcome,
  exportL7,
  fetchL7ExperimentCounts,
  L7_EXPERIMENT_EVENT_CONTRACT,
} from '../scripts/ci/export-l7-experiment-outcomes.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const WINDOW = {
  start: '2026-09-04T00:00:00.000Z',
  end: '2026-09-12T00:00:00.000Z',
};
const POLICY = {
  loopId: 'L7',
  primaryMetric: 'registered_outcome_per_eligible_cohort',
  minimumSample: 200,
  sourceRefs: ['experiment-assignment-exposure-outcome'],
  outcome: { outcomeId: 'registered-experiment-outcome', sourceRefs: ['experiment-assignment-exposure-outcome'] },
  guardrails: ['persistent assignment', 'minimum sample', 'explicit expiry', 'no automatic price change'],
  allocationPolicy: {
    persistent: true,
    assignmentMethod: 'stable-sha256',
    assignmentKey: 'experiment-session-id',
    contaminationPolicy: {
      controlled: true,
      key: 'experiment-session-id',
      rejectReassignment: true,
      rejectCrossCandidateExposure: true,
    },
    trafficMutationAllowed: false,
    priceMutationAllowed: false,
    noAutomaticPriceChange: true,
  },
  lifecycle: { candidateTtlHours: 168 },
};

const RESPONSE = {
  columns: [
    'eligibleCohort', 'assignments', 'exposures', 'primaryOutcomes',
    'controlSessions', 'benefitSessions', 'contaminatedAssignments',
    'guardrailBreaches', 'persistentAssignments',
  ],
  results: [[240, 240, 240, 38, 120, 120, 0, 0, 240]],
};

describe('read-only L7 experiment outcome exporter', () => {
  it('queries only categorical session-joined experiment events', async () => {
    let query = '';
    const counts = await fetchL7ExperimentCounts({
      config: { apiKey: 'test', projectId: 'test' },
      start: WINDOW.start,
      end: WINDOW.end,
      posthogRunner: async (value) => {
        query = value;
        return RESPONSE;
      },
    });
    expect(counts).toEqual({
      eligibleCohort: 240,
      assignments: 240,
      exposures: 240,
      primaryOutcomes: 38,
      guardrailBreaches: 0,
      persistentAssignments: 240,
      contaminatedAssignments: 0,
      variants: { control: 120, benefit: 120 },
    });
    expect(query).toContain('GROUP BY $session_id');
    expect(query).toContain("event = 'affiliate_experiment_exposure'");
    expect(query).toContain("event = 'affiliate_click'");
    expect(query).toContain("properties.campaign = 'g4-contextual'");
    expect(query).not.toMatch(/email|https?:\/\//i);
  });

  it('builds a registry-derived independent outcome without mutation authority', () => {
    const outcome = buildL7ExperimentOutcome({
      counts: {
        eligibleCohort: 240,
        assignments: 240,
        exposures: 240,
        primaryOutcomes: 38,
        guardrailBreaches: 0,
        persistentAssignments: 240,
        contaminatedAssignments: 0,
        variants: { control: 120, benefit: 120 },
      },
      policy: POLICY,
      now: NOW,
      telemetryWindow: WINDOW,
    });
    expect(outcome).toMatchObject({
      generatedAt: NOW.toISOString(),
      independent: true,
      eligibleCohort: 240,
      primaryOutcomes: 38,
      durationDays: 8,
      preRegistration: {
        outcomeId: 'registered-experiment-outcome',
        primaryMetric: 'registered_outcome_per_eligible_cohort',
        minimumSample: 200,
      },
      assignmentLedger: { persistent: true, method: 'stable-sha256', key: 'experiment-session-id' },
      contaminationPolicy: { controlled: true, key: 'experiment-session-id' },
      export: {
        readOnly: true,
        mutationsPerformed: false,
        trafficMutationAllowed: false,
        priceMutationAllowed: false,
        noAutomaticPriceChange: true,
      },
    });
  });

  it('writes an explicit unavailable placeholder with no measurements', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-export-test-'));
    const outputPath = path.join(directory, 'outcome.json');
    const registryPath = path.resolve('data/loop-fleet/loop-registry.json');
    const outcome = await exportL7({
      outputPath,
      registryPath,
      now: NOW,
      config: { apiKey: 'test', projectId: 'test' },
      posthogRunner: async () => RESPONSE,
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(outcome);
    expect(outcome.independent).toBe(true);

    const unavailable = buildUnavailableL7ExperimentOutcome({ policy: POLICY, now: NOW });
    expect(unavailable).toMatchObject({
      independent: false,
      eligibleCohort: null,
      primaryOutcomes: null,
      export: { unavailable: true, mutationsPerformed: false, noAutomaticPriceChange: true },
    });
  });

  it('rifiuta un registry L7 incompleto prima di interrogare PostHog', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-invalid-registry-'));
    const outputPath = path.join(directory, 'outcome.json');
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ loops: [POLICY] }));
    await expect(exportL7({
      outputPath,
      registryPath,
      now: NOW,
      config: { apiKey: 'test', projectId: 'test' },
      posthogRunner: async () => RESPONSE,
    })).rejects.toThrow(/schemaVersion|states|goal missing/);
  });

  it('rejects inconsistent persistent and contaminated session counts', async () => {
    await expect(fetchL7ExperimentCounts({
      config: { apiKey: 'test', projectId: 'test' },
      start: WINDOW.start,
      end: WINDOW.end,
      posthogRunner: async () => ({
        ...RESPONSE,
        results: [[240, 240, 240, 38, 120, 120, 1, 0, 240]],
      }),
    })).rejects.toThrow('do not reconcile');
  });

  it('keeps the event contract stable', () => {
    expect(L7_EXPERIMENT_EVENT_CONTRACT).toMatchObject({
      experimentId: 'g4-affiliate-contextual',
      exposureEvent: 'affiliate_experiment_exposure',
      outcomeEvent: 'affiliate_click',
      sessionJoin: '$session_id',
      contexts: ['exchange', 'banks'],
      variants: ['control', 'benefit'],
    });
  });
});
