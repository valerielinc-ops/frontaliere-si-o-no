import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL7ExperimentOutcome,
  buildUnavailableL7ExperimentOutcome,
  DEFAULT_ACTIVE_EXPERIMENTS_PATH,
  exportL7,
  fetchL7ExperimentCounts,
  L7_EXPERIMENT_EVENT_CONTRACT,
  parseActiveExperiments,
  readActiveExperiments,
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

const REGISTERED_EXPERIMENT = {
  experimentId: L7_EXPERIMENT_EVENT_CONTRACT.experimentId,
  exposureEvent: L7_EXPERIMENT_EVENT_CONTRACT.exposureEvent,
  outcomeEvent: L7_EXPERIMENT_EVENT_CONTRACT.outcomeEvent,
  variants: [...L7_EXPERIMENT_EVENT_CONTRACT.variants],
  rcParam: 'AFFILIATE_G4_VARIANT',
  startedAt: '2026-09-01T00:00:00.000Z',
};

function activeExperimentsFile(directory: string, experiments: unknown[]) {
  const file = path.join(directory, 'active-experiments.json');
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, experiments })}\n`);
  return file;
}

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
    expect(query).toContain('GROUP BY properties.$session_id');
    expect(query).toContain('properties.$session_id IS NOT NULL');
    expect(query).toContain('properties.$session_id != \'\'');
    expect(query).toContain('mismatchedOutcomeEvents');
    expect(query).toContain("properties.variant = 'control'");
    expect(query).toContain("properties.variant = 'benefit'");
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
      schemaVersion: 1,
      loopId: 'L7',
      status: 'observed',
      quality: 'observed',
      generatedAt: NOW.toISOString(),
      independent: true,
      eligibleCohort: 240,
      primaryOutcomes: 38,
      durationDays: 8,
      metrics: { eligibleCohort: 240, primaryOutcomes: 38, durationDays: 8 },
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
      activeExperimentsPath: activeExperimentsFile(directory, [REGISTERED_EXPERIMENT]),
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(outcome);
    expect(outcome.independent).toBe(true);

    const unavailable = buildUnavailableL7ExperimentOutcome({ policy: POLICY, now: NOW });
    expect(unavailable).toMatchObject({
      loopId: 'L7',
      status: 'unmeasurable',
      quality: 'unmeasurable',
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
      sessionJoin: 'properties.$session_id',
      contexts: ['exchange', 'banks'],
      variants: ['control', 'benefit'],
    });
  });
});

describe('L7 declared idle state', () => {
  it('writes an idle export and queries no source when no experiment is registered', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-idle-'));
    const outputPath = path.join(directory, 'outcome.json');
    let posthogCalls = 0;
    let remoteConfigReads = 0;
    const outcome = await exportL7({
      outputPath,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
      now: NOW,
      client: { remoteConfig: async () => { remoteConfigReads += 1; return {}; } },
      posthogRunner: async () => { posthogCalls += 1; return RESPONSE; },
      activeExperimentsPath: activeExperimentsFile(directory, []),
    });
    expect(posthogCalls).toBe(0);
    expect(remoteConfigReads).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(outcome);
    expect(outcome).toMatchObject({
      loopId: 'L7',
      activeExperiments: 0,
      status: 'idle',
      quality: 'zero',
      independent: true,
      assignments: null,
      exposures: null,
      export: { readOnly: true, idle: true, mutationsPerformed: false, noAutomaticPriceChange: true },
    });
    expect(outcome.reason).toContain('no experiment is registered as active');
    expect(JSON.stringify(outcome)).not.toMatch(/posthog|hogql/i);
  });

  it('runs the registered reader when an experiment is declared active', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-active-'));
    let posthogCalls = 0;
    const outcome = await exportL7({
      outputPath: path.join(directory, 'outcome.json'),
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
      now: NOW,
      config: { apiKey: 'test', projectId: 'test' },
      posthogRunner: async () => { posthogCalls += 1; return RESPONSE; },
      activeExperimentsPath: activeExperimentsFile(directory, [REGISTERED_EXPERIMENT]),
    });
    expect(posthogCalls).toBe(1);
    expect(outcome).toMatchObject({ activeExperiments: 1, status: 'observed', assignments: 240 });
  });

  it('never reads a missing or malformed declaration as idle', () => {
    expect(() => parseActiveExperiments({ experiments: [] })).toThrow('schemaVersion: 1');
    expect(() => parseActiveExperiments({ schemaVersion: 1 })).toThrow('schemaVersion: 1');
    expect(() => parseActiveExperiments({ schemaVersion: 1, experiments: [{ ...REGISTERED_EXPERIMENT, rcParam: '' }] }))
      .toThrow('rcParam is missing');
    expect(() => parseActiveExperiments({ schemaVersion: 1, experiments: [{ ...REGISTERED_EXPERIMENT, variants: ['control'] }] }))
      .toThrow('at least two variants');
    expect(() => parseActiveExperiments({ schemaVersion: 1, experiments: [REGISTERED_EXPERIMENT, REGISTERED_EXPERIMENT] }))
      .toThrow('duplicated');
    expect(() => readActiveExperiments(path.join(os.tmpdir(), 'loop-l7-no-such-file.json'))).toThrow();
  });
});

/**
 * Code/data coherence for "which experiment is active". The client is the
 * only thing that can assign and expose a variant, so the declaration in
 * data/experiments/active-experiments.json must match what the client emits:
 * - the L7 exposure event (L7_EXPERIMENT_EVENT_CONTRACT.exposureEvent) emitted
 *   by the client while nothing is declared = an unregistered experiment that
 *   L7 would call idle;
 * - a declared experiment whose exposure event nobody emits = a retired
 *   experiment that would keep L7 complaining about a ledger with no data.
 *
 * Failure title: "L7: esperimento attivo senza emettitore o senza sorgente viva".
 */
const CLIENT_DIRS = ['services', 'components', 'hooks'];
const CLIENT_ROOT_FILES = ['App.tsx', 'index.tsx'];
const ANALYTICS_FILE = 'services/analytics.ts';

function readClientSources() {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Symlinks point at generated data outside the client (e.g. services/blogArticleIds.ts).
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files[full.split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  for (const dir of CLIENT_DIRS) if (fs.existsSync(dir)) walk(dir);
  for (const file of CLIENT_ROOT_FILES) if (fs.existsSync(file)) files[file] = fs.readFileSync(file, 'utf8');
  return files;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names of the `Analytics` methods whose body logs `event`. */
function analyticsMethodsLogging(analytics: string, event: string) {
  const starts = [...analytics.matchAll(/^[ \t]*(\w+)[ \t]*:[ \t]*\(/gm)];
  const literal = new RegExp(`\\blog\\(\\s*['"]${escapeRegExp(event)}['"]`);
  return starts
    .filter((match, index) => literal.test(analytics.slice(match.index, starts[index + 1]?.index ?? analytics.length)))
    .map((match) => match[1]);
}

/** Client files that emit `event`: a call to an Analytics method that logs it, or the literal outside analytics.ts. */
function clientEmitters(files: Record<string, string>, event: string) {
  const methods = analyticsMethodsLogging(files[ANALYTICS_FILE] || '', event);
  const callers = methods.map((method) => new RegExp(`\\b${escapeRegExp(method)}\\s*\\(`));
  const literal = new RegExp(`['"\`]${escapeRegExp(event)}['"\`]`);
  return Object.keys(files).filter((file) => callers.some((caller) => caller.test(files[file]))
    || (file !== ANALYTICS_FILE && literal.test(files[file])));
}

function findExperimentRegistryViolations({
  experiments,
  emittersOf,
  l7ExposureEvent,
}: {
  experiments: Array<{ experimentId: string; exposureEvent: string }>;
  emittersOf: (event: string) => string[];
  l7ExposureEvent: string;
}) {
  const violations: string[] = [];
  const l7Emitters = emittersOf(l7ExposureEvent);
  if (l7Emitters.length && !experiments.some((entry) => entry.exposureEvent === l7ExposureEvent)) {
    violations.push(`the client emits ${l7ExposureEvent} (${l7Emitters.join(', ')}) but no active experiment declares it`);
  }
  for (const entry of experiments) {
    if (!emittersOf(entry.exposureEvent).length) {
      violations.push(`${entry.experimentId} is declared active but nothing in the client emits ${entry.exposureEvent}`);
    }
  }
  return violations;
}

describe('active experiments match the client emitters', () => {
  const files = readClientSources();
  const emittersOf = (event: string) => clientEmitters(files, event);

  it('reads the client and finds the method that logs the L7 exposure event', () => {
    expect(files[ANALYTICS_FILE]).toBeDefined();
    if (files[ANALYTICS_FILE].includes(`'${L7_EXPERIMENT_EVENT_CONTRACT.exposureEvent}'`)) {
      expect(analyticsMethodsLogging(files[ANALYTICS_FILE], L7_EXPERIMENT_EVENT_CONTRACT.exposureEvent).length).toBeGreaterThan(0);
    }
  });

  it('declares exactly the experiments the client exposes', () => {
    const experiments = readActiveExperiments(DEFAULT_ACTIVE_EXPERIMENTS_PATH);
    expect(findExperimentRegistryViolations({
      experiments,
      emittersOf,
      l7ExposureEvent: L7_EXPERIMENT_EVENT_CONTRACT.exposureEvent,
    })).toEqual([]);
  });

  it('turns red on an unregistered emitter and on a registered experiment without emitter', () => {
    const analytics = " trackX: (a: string) => {\n  log('x_exposure', { a });\n },\n trackY: () => {\n  log('y_click', {});\n },\n";
    const fixture = {
      [ANALYTICS_FILE]: analytics,
      'components/Widget.tsx': 'Analytics.trackX("a");',
    };
    expect(analyticsMethodsLogging(analytics, 'x_exposure')).toEqual(['trackX']);
    expect(clientEmitters(fixture, 'x_exposure')).toEqual(['components/Widget.tsx']);
    expect(clientEmitters(fixture, 'y_click')).toEqual([]);
    const fixtureEmitters = (event: string) => clientEmitters(fixture, event);
    expect(findExperimentRegistryViolations({ experiments: [], emittersOf: fixtureEmitters, l7ExposureEvent: 'x_exposure' }))
      .toEqual([expect.stringContaining('the client emits x_exposure (components/Widget.tsx)')]);
    expect(findExperimentRegistryViolations({
      experiments: [{ experimentId: 'retired', exposureEvent: 'y_click' }],
      emittersOf: fixtureEmitters,
      l7ExposureEvent: 'x_exposure',
    })).toEqual([
      expect.stringContaining('the client emits x_exposure'),
      expect.stringContaining('retired is declared active but nothing in the client emits y_click'),
    ]);
    expect(findExperimentRegistryViolations({
      experiments: [{ experimentId: 'live', exposureEvent: 'x_exposure' }],
      emittersOf: fixtureEmitters,
      l7ExposureEvent: 'x_exposure',
    })).toEqual([]);
  });
});

