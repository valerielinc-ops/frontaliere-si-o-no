import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS,
  TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS,
  TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES,
  assertSafeTranslationShadowOutputPath,
  createTranslationShadowObservationV2 as createRawTranslationShadowObservationV2,
  createTranslationShadowPreflightDecisionV2 as createRawTranslationShadowPreflightDecisionV2,
  digestTranslationShadowDefaultCompanyKeyV2,
  runTranslationShadowPreflightV2,
  serializeTranslationShadowArtifactV2,
  validateTranslationShadowDecisionDigestV2,
  writeTranslationShadowArtifactAtomicV2,
} from '../scripts/lib/translation-shadow-preflight-v2.mjs';
import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';
import { buildTrafficPriority } from '../scripts/lib/job-traffic-priority.mjs';
import {
  cascadeStopReason,
  createObserverCompensatedClock,
  filterPendingForCompany,
  needsTranslation,
  orderPendingByTraffic,
} from '../scripts/relocalize-pending-jobs.mjs';
import {
  runTranslationShadowBindingCaptureCli,
  runTranslationShadowObservationCli,
} from '../scripts/translation-shadow-preflight-v2.mjs';

const BASELINE = 'a'.repeat(40);
const LONG_DESCRIPTION = 'Descrizione completa '.repeat(8);
const RUN_BINDING = Object.freeze({
  repository: 'valerielinc-ops/frontaliere-si-o-no',
  workflow: 'valerielinc-ops/frontaliere-si-o-no/.github/workflows/translate-pending-logic.yml@refs/heads/main',
  runId: '123',
  runAttempt: '2',
  sourceCommit: BASELINE,
  workflowBlobSha: 'b'.repeat(40),
});

function createTranslationShadowPreflightDecisionV2(input: any, options?: any) {
  return createRawTranslationShadowPreflightDecisionV2({
    ...input,
    runBinding: input?.runBinding ?? RUN_BINDING,
  }, options);
}

function createTranslationShadowObservationV2(input: any) {
  return createRawTranslationShadowObservationV2({
    ...input,
    expectedRunBinding: input?.expectedRunBinding ?? RUN_BINDING,
  });
}

function job(index: number, missingUnitCount = 1) {
  const titleByLocale: Record<string, string> = {
    it: `Titolo ${index}`,
    en: `Title ${index}`,
    de: `Stelle ${index}`,
    fr: `Poste ${index}`,
  };
  const descriptionByLocale: Record<string, string> = {
    it: LONG_DESCRIPTION,
    en: LONG_DESCRIPTION,
    de: LONG_DESCRIPTION,
    fr: LONG_DESCRIPTION,
  };
  const refs = [
    ['titleByLocale', 'en'],
    ['descriptionByLocale', 'en'],
    ['titleByLocale', 'de'],
    ['descriptionByLocale', 'de'],
    ['titleByLocale', 'fr'],
    ['descriptionByLocale', 'fr'],
    ['titleByLocale', 'it'],
    ['descriptionByLocale', 'it'],
  ] as const;
  for (const [field, locale] of refs.slice(0, missingUnitCount)) {
    if (field === 'titleByLocale') titleByLocale[locale] = '';
    else descriptionByLocale[locale] = '';
  }
  return {
    id: `job-${index}`,
    url: `https://example.test/jobs/${index}/`,
    slug: `job-${index}`,
    companyKey: `company-${index % 10}`,
    company: `Company ${index % 10}`,
    sourceLang: 'it',
    title: `Titolo ${index}`,
    description: LONG_DESCRIPTION,
    titleByLocale,
    descriptionByLocale,
    needsRetranslation: true,
  };
}

function preflightInput(jobs: any[], {
  orderedPending = jobs,
  capLength = Math.min(250, jobs.length),
  maxJobs = 250,
}: { orderedPending?: any[]; capLength?: number; maxJobs?: number } = {}) {
  const capWindow = orderedPending.slice(0, capLength);
  const capWindowCompanyKeys = capWindow.map((item) => item.companyKey || null);
  const counts = new Map<string, number>();
  for (const item of capWindow) {
    if (item.companyKey) counts.set(item.companyKey, (counts.get(item.companyKey) ?? 0) + 1);
  }
  return {
    baselineMainSha: BASELINE,
    runBinding: RUN_BINDING,
    dryRun: false,
    jobs,
    pendingJobs: jobs,
    orderedPending,
    capWindow,
    capWindowCompanyKeys,
    companyBudgets: [...counts].map(([companyKey, count]) => ({ companyKey, jobs: count })),
    traffic: {
      popularity: Object.fromEntries(jobs.map((item, index) => [item.slug, jobs.length - index])),
      stats: {
        queued: jobs.length,
        trafficEntries: jobs.length,
        matched: jobs.length,
        matchRate: jobs.length === 0 ? 0 : 1,
        totalViews: jobs.reduce((sum, _item, index) => sum + jobs.length - index, 0),
        reserveForOldest: 0.2,
        age: {
          count: jobs.length,
          withTimestamp: 0,
          oldestAgeDays: null,
          p50AgeDays: null,
          p90AgeDays: null,
          buckets: { '0-7d': 0, '7-30d': 0, '30-90d': 0, '90-180d': 0, '180d+': 0 },
          alert: false,
          alertDays: 150,
        },
      },
    },
    legacy: {
      allowNoTraffic: false,
      companyFilter: {
        population: 'assembled_company_filtered',
        value: null,
        before: jobs.length,
        after: jobs.length,
        reappliedAfterPreClear: false,
      },
      maxJobs,
      preClear: {
        direct: { population: 'all_per_crawler_occurrences', cleared: 0, reset: 0 },
        assembled: { population: 'all_assembled_jobs', flagsCleared: 0 },
        filteredPending: { population: 'assembled_company_filtered', before: jobs.length },
      },
      postClear: { population: 'assembled_company_filtered', pending: jobs.length },
      trafficSource: 'data/job-popularity.json',
    },
  };
}

function resignDecision(decision: any) {
  const { decisionDigest: _ignored, ...payload } = decision;
  return { ...payload, decisionDigest: digestDocument(payload) };
}

describe('translation shadow preflight v2 decision', () => {
  it('is measure-only, rejects without planning, and keeps state/providers/quality untouched', () => {
    const jobs = [job(1), job(2, 0)];
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput(jobs));
    expect(decision).toMatchObject({
      schemaVersion: 2,
      kind: 'translation_shadow_preflight_decision',
      mode: 'measure_only',
      verdict: { outcome: 'reject', primaryReason: 'mapping_incomplete' },
      legacy: {
        executionGranularity: 'company_budget',
        queuedAt: { availability: 'unavailable', value: null },
        capWindow: { certainty: 'queued_company_budgets_not_executed_jobs' },
      },
      mapping: { complete: false, completeness: 'lower_bound', demonstrableMissingUnits: 1 },
      v2: {
        state: { mode: 'not_read', reason: 'preflight_capacity_exceeded', value: null },
        plan: null,
        selection: null,
        cache: null,
        replay: null,
        fairness: { status: 'not_evaluated', numerator: 1, denominator: 5 },
        plannerCallCount: 0,
      },
      quality: { status: 'unchanged', gateInvocations: 0, productionWrites: 0, paidCalls: 0 },
    });
    expect(decision.snapshot.legacyCompanyBudgetSlice).toMatchObject({
      count: 2,
      source: 'post_traffic_cap_company_budgets',
    });
    expect(decision.snapshot.legacyCompanyBudgetSlice.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(decision.legacy.companyBudgets).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyKeyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
    ]));
    expect(decision.legacy.companyKeyWitness).toHaveLength(2);
    expect(decision.legacy.companyFilter.companyKeyDigest).toBeNull();
    expect(serializeTranslationShadowArtifactV2(decision)).not.toContain('company-1');
    expect(decision.capacity.observed.maxLegacyCompanyBudgetJobs).toBe(1);
    expect(validateTranslationShadowDecisionDigestV2(decision)).toBe(true);
    expect(serializeTranslationShadowArtifactV2(decision).endsWith('\n')).toBe(true);
  });

  it('enforces the exact 10k/25k/250/250 bounds and never calls a planner', () => {
    const exact = Array.from({ length: 10_000 }, (_, index) => (
      job(index, index < 250 ? 1 : index < 5_500 ? 3 : 2)
    ));
    const exactDecision = createTranslationShadowPreflightDecisionV2(preflightInput(exact));
    expect(exactDecision.capacity.observed).toMatchObject({
      pendingJobs: 10_000,
      demonstrableMissingUnits: 25_000,
      selectedDemonstrableMissingUnits: 250,
      capWindowJobs: 250,
    });
    expect(exactDecision.capacity.exceeded).toEqual([]);
    expect(exactDecision.verdict.primaryReason).toBe('mapping_incomplete');
    expect(exactDecision.verdict.primaryReason).not.toBe('observer_timeout');
    expect(exactDecision.v2.plannerCallCount).toBe(0);
    expect(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(Buffer.byteLength(serializeTranslationShadowArtifactV2(exactDecision)))
      .toBeLessThan(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES);
    const maxRunnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-max-'));
    const maxDecisionPath = path.join(maxRunnerTemp, 'decision.json');
    writeTranslationShadowArtifactAtomicV2(maxDecisionPath, exactDecision, {
      runnerTemp: maxRunnerTemp,
    });
    expect(fs.statSync(maxDecisionPath).size).toBeGreaterThan(1024 * 1024);
    expect(runTranslationShadowBindingCaptureCli([
      '--mode', 'capture', '--decision', maxDecisionPath,
    ], { runnerTemp: maxRunnerTemp })).toEqual({
      expectedDecisionDigest: exactDecision.decisionDigest,
      expectedContractDigest: exactDecision.snapshot.sourceRuntimeContractDigest,
    });
    fs.rmSync(maxRunnerTemp, { recursive: true, force: true });

    const tooManyJobs = Array.from({ length: 10_001 }, (_, index) => job(index));
    const jobsDecision = createTranslationShadowPreflightDecisionV2(preflightInput(tooManyJobs));
    expect(jobsDecision.verdict.primaryReason).toBe('capacity_exceeded');
    expect(jobsDecision.capacity.exceeded).toContain('input_jobs');
    expect(jobsDecision.v2.plannerCallCount).toBe(0);
    expect(jobsDecision.mapping).toMatchObject({
      completeness: 'not_evaluated_capacity_exceeded',
      records: [],
      samples: [],
      selectedRecords: [],
    });
    expect(jobsDecision.mapping.digest).toBe(digestDocument({
      pendingDigest: jobsDecision.snapshot.pending.digest,
      status: 'not_evaluated_capacity_exceeded',
    }));
    expect(createTranslationShadowObservationV2({
      decision: jobsDecision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: jobsDecision.decisionDigest,
      expectedContractDigest: jobsDecision.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });
    const forgedSkippedDigest = resignDecision({
      ...jobsDecision,
      mapping: { ...jobsDecision.mapping, digest: digestDocument({ arbitrary: true }) },
      v2: {
        ...jobsDecision.v2,
        deferred: { ...jobsDecision.v2.deferred, digest: digestDocument({ arbitrary: true }) },
      },
    });
    expect(createTranslationShadowObservationV2({
      decision: forgedSkippedDigest,
      sourceCommit: BASELINE,
      expectedDecisionDigest: forgedSkippedDigest.decisionDigest,
      expectedContractDigest: forgedSkippedDigest.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });

    const tooManyUnits = Array.from({ length: 10_000 }, (_, index) => (
      job(index, index < 250 ? 1 : index < 5_501 ? 3 : 2)
    ));
    const unitsDecision = createTranslationShadowPreflightDecisionV2(preflightInput(tooManyUnits));
    expect(unitsDecision.capacity.observed.demonstrableMissingUnits).toBe(25_001);
    expect(unitsDecision.capacity.exceeded).toContain('input_units_lower_bound');
    expect(unitsDecision.v2.plannerCallCount).toBe(0);
    const strippedInputUnitsReason = resignDecision({
      ...unitsDecision,
      verdict: {
        ...unitsDecision.verdict,
        reasons: unitsDecision.verdict.reasons.filter((reason: string) => (
          reason !== 'capacity_exceeded:input_units_lower_bound'
        )),
      },
      capacity: {
        ...unitsDecision.capacity,
        exceeded: unitsDecision.capacity.exceeded.filter((reason: string) => (
          reason !== 'input_units_lower_bound'
        )),
      },
    });
    expect(createTranslationShadowObservationV2({
      decision: strippedInputUnitsReason,
      sourceCommit: BASELINE,
      expectedDecisionDigest: strippedInputUnitsReason.decisionDigest,
      expectedContractDigest: strippedInputUnitsReason.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    expect(TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS).toEqual({
      inputJobs: 10_000,
      inputUnits: 25_000,
      selectedJobs: 250,
      selectedUnits: 250,
    });
  }, 20_000);

  it('applies selectedUnits to the full cap-window demonstrable-unit sum at 250/251', () => {
    const exact = Array.from({ length: 250 }, (_, index) => job(index, 1));
    const exactDecision = createTranslationShadowPreflightDecisionV2(preflightInput(exact));
    expect(exactDecision.capacity.observed.selectedDemonstrableMissingUnits).toBe(250);
    expect(exactDecision.mapping.selectedRecords).toHaveLength(250);
    expect(exactDecision.capacity.exceeded).not.toContain('selected_units_lower_bound');

    const over = [...exact];
    over[over.length - 1] = job(over.length - 1, 2);
    const overDecision = createTranslationShadowPreflightDecisionV2(preflightInput(over));
    expect(overDecision.capacity.observed.selectedDemonstrableMissingUnits).toBe(251);
    expect(overDecision.mapping.selectedRecords).toHaveLength(250);
    expect(overDecision.capacity.exceeded).toContain('selected_units_lower_bound');
    expect(overDecision.verdict.primaryReason).toBe('capacity_exceeded');
    expect(overDecision.v2.plannerCallCount).toBe(0);

    const strippedSelectedUnits = resignDecision({
      ...overDecision,
      verdict: {
        ...overDecision.verdict,
        reasons: overDecision.verdict.reasons.filter((reason: string) => (
          reason !== 'capacity_exceeded:selected_units_lower_bound'
        )),
      },
      capacity: {
        ...overDecision.capacity,
        exceeded: overDecision.capacity.exceeded.filter((reason: string) => (
          reason !== 'selected_units_lower_bound'
        )),
      },
    });
    expect(createTranslationShadowObservationV2({
      decision: strippedSelectedUnits,
      sourceCommit: BASELINE,
      expectedDecisionDigest: strippedSelectedUnits.decisionDigest,
      expectedContractDigest: strippedSelectedUnits.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });

    const overSelectedJobs = Array.from({ length: 251 }, (_, index) => job(index, 8));
    const boundedWitnessDecision = createTranslationShadowPreflightDecisionV2(preflightInput(
      overSelectedJobs, { capLength: 251, maxJobs: 251 },
    ));
    expect(boundedWitnessDecision.capacity.exceeded).toContain('selected_jobs');
    expect(boundedWitnessDecision.capacity.observed.selectedDemonstrableMissingUnits).toBeNull();
    expect(boundedWitnessDecision.mapping.selectedRecords).toEqual([]);
  });

  it('hashes the complete inventory, including the last item, without truncating it into samples', () => {
    const jobs = Array.from({ length: 1_001 }, (_, index) => job(index));
    const first = createTranslationShadowPreflightDecisionV2(preflightInput(jobs));
    const changed = [...jobs];
    changed[changed.length - 1] = { ...changed.at(-1), title: 'Ultimo elemento cambiato' };
    const second = createTranslationShadowPreflightDecisionV2(preflightInput(changed));
    expect(first.snapshot.jobs.count).toBe(1_001);
    expect(first.snapshot.jobs.digest).not.toBe(second.snapshot.jobs.digest);
    expect(first.mapping.samples.length).toBeLessThanOrEqual(20);
    expect(first.mapping.digest).toBeTruthy();
  });

  it('binds a complete PII-free occurrence witness while allowing duplicate legacy refs', () => {
    const first = job(7, 1);
    const duplicateRef = { ...job(7, 2), company: 'Same ref, distinct occurrence' };
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([first, duplicateRef]));
    expect(decision.mapping.records).toHaveLength(2);
    expect(decision.mapping.records.map((record: any) => record.jobRef)).toEqual([
      decision.mapping.records[0].jobRef,
      decision.mapping.records[0].jobRef,
    ]);
    expect(decision.mapping.records.map((record: any) => record.occurrenceOrdinal)).toEqual([0, 1]);
    expect(new Set(decision.mapping.records.map((record: any) => record.occurrenceKey)).size).toBe(2);
    expect(decision.mapping.samples).toEqual(decision.mapping.records);
    expect(decision.mapping.selectedRecords).toHaveLength(2);
    expect(serializeTranslationShadowArtifactV2(decision)).not.toContain('Same ref, distinct occurrence');
    expect(createTranslationShadowObservationV2({
      decision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });
  });

  it('is canonical and byte-stable across object-key permutations and replay', () => {
    const original = job(1);
    const permuted = Object.fromEntries(Object.entries(original).reverse());
    const first = createTranslationShadowPreflightDecisionV2(preflightInput([original]));
    const replay = createTranslationShadowPreflightDecisionV2(preflightInput([original]));
    const reordered = createTranslationShadowPreflightDecisionV2(preflightInput([permuted]));
    expect(serializeTranslationShadowArtifactV2(first)).toBe(serializeTranslationShadowArtifactV2(replay));
    expect(serializeTranslationShadowArtifactV2(first)).toBe(serializeTranslationShadowArtifactV2(reordered));
    const { decisionDigest: _ignored, ...payload } = first;
    expect(first.decisionDigest).not.toEqual((payload as any).decisionDigest);
  });

  it('binds trust to the independent run/attempt/workflow identity and rejects replay', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const replay = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    expect(serializeTranslationShadowArtifactV2(replay))
      .toBe(serializeTranslationShadowArtifactV2(decision));
    const observe = (expectedRunBinding: any) => createTranslationShadowObservationV2({
      decision,
      expectedRunBinding,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    }).decision;
    expect(observe(RUN_BINDING))
      .toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });
    for (const mismatch of [
      { ...RUN_BINDING, runId: '124' },
      { ...RUN_BINDING, runAttempt: '3' },
      { ...RUN_BINDING, workflow: `${RUN_BINDING.workflow}-other` },
    ]) {
      expect(observe(mismatch))
        .toMatchObject({ integrityValid: false, semanticValid: false, trusted: false });
    }

    const otherAttempt = createTranslationShadowPreflightDecisionV2({
      ...preflightInput([job(1)]),
      runBinding: { ...RUN_BINDING, runAttempt: '3' },
    });
    const replayedObservation = createTranslationShadowObservationV2({
      decision: otherAttempt,
      expectedRunBinding: RUN_BINDING,
      sourceCommit: BASELINE,
      expectedDecisionDigest: otherAttempt.decisionDigest,
      expectedContractDigest: otherAttempt.snapshot.sourceRuntimeContractDigest,
    });
    expect(replayedObservation.decision)
      .toMatchObject({ integrityValid: false, semanticValid: false, trusted: false });
    expect(replayedObservation.sourceRuntime.runBindingDigest).toBeNull();
  });

  it('uses fail-closed precedence and does not invent source/company/queuedAt fallbacks', () => {
    const unmapped = {
      ...job(1),
      sourceLang: undefined,
      companyKey: undefined,
      company: 'Fallback Company',
      addressLocality: 'Lugano',
    };
    const coherent = preflightInput([unmapped]);
    coherent.companyBudgets = [];
    const mappingDecision = createTranslationShadowPreflightDecisionV2(coherent);
    expect(mappingDecision.mapping.reasonCounts).toMatchObject({
      source_lang_unavailable: 1,
      explicit_company_key_unavailable: 1,
      queued_at_unavailable: 1,
    });
    expect(mappingDecision.legacy.keyless).toMatchObject({ count: 1, reasons: ['legacy_company_key_resolution_empty'] });
    expect(mappingDecision.legacy.queuedAt.value).toBeNull();

    const incoherent = preflightInput([job(2)]);
    incoherent.orderedPending = [];
    const incoherentDecision = createTranslationShadowPreflightDecisionV2(incoherent);
    expect(incoherentDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(incoherentDecision.v2.plannerCallCount).toBe(0);
  });

  it('returns bounded input_incoherent decisions for missing traffic and invalid not-attempted shapes', () => {
    const missingTraffic: any = preflightInput([job(1)]);
    delete missingTraffic.traffic;
    const missingDecision = createTranslationShadowPreflightDecisionV2(missingTraffic);
    expect(missingDecision.verdict).toMatchObject({
      outcome: 'reject',
      primaryReason: 'input_incoherent',
    });
    expect(missingDecision.verdict.reasons).toContain('traffic_capture_missing');
    expect(validateTranslationShadowDecisionDigestV2(missingDecision)).toBe(true);
    expect(missingDecision.v2.plannerCallCount).toBe(0);

    const emptyTraffic: any = preflightInput([job(2)]);
    emptyTraffic.traffic = {};
    const emptyDecision = createTranslationShadowPreflightDecisionV2(emptyTraffic);
    expect(emptyDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(emptyDecision.verdict.reasons).toEqual(expect.arrayContaining([
      'traffic_popularity_invalid',
      'traffic_stats_invalid',
    ]));

    const emptyReason: any = preflightInput([job(3)]);
    emptyReason.notAttemptedReason = '';
    const emptyReasonDecision = createTranslationShadowPreflightDecisionV2(emptyReason);
    expect(emptyReasonDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(emptyReasonDecision.verdict.reasons).toContain('not_attempted_reason_invalid');
    expect(Buffer.byteLength(serializeTranslationShadowArtifactV2(emptyReasonDecision)))
      .toBeLessThan(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES);
  });

  it('fails closed on per-job cycle/depth/bytes bounds and invalid hard budgets', () => {
    const oversized = job(1) as any;
    oversized.payload = 'x'.repeat(32 * 1024 * 1024);
    const oversizedDecision = createTranslationShadowPreflightDecisionV2(preflightInput([oversized]));
    expect(oversizedDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(oversizedDecision.verdict.reasons).toContain('input_bound_job_bytes_exceeded');

    const cyclic = job(2) as any;
    cyclic.self = cyclic;
    const cycleDecision = createTranslationShadowPreflightDecisionV2(preflightInput([cyclic]));
    expect(cycleDecision.verdict.reasons).toContain('input_bound_cycle_detected');

    const deep = job(3) as any;
    let cursor = deep;
    for (let depth = 0; depth < 65; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    const depthDecision = createTranslationShadowPreflightDecisionV2(preflightInput([deep]));
    expect(depthDecision.verdict.reasons).toContain('input_bound_depth_exceeded');

    for (const hardBudgetMs of [-1, 0, Number.NaN, 10_001]) {
      const invalid = createTranslationShadowPreflightDecisionV2(preflightInput([job(4)]), { hardBudgetMs });
      expect(invalid.verdict.primaryReason).toBe('input_incoherent');
      expect(invalid.verdict.reasons).toContain('hard_budget_invalid');
      expect(invalid.v2.plannerCallCount).toBe(0);
    }
    expect(TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS).toEqual({
      maxJobBytes: 1024 * 1024,
      maxAggregateBytes: 1024 * 1024 * 1024,
      maxMetadataBytes: 64 * 1024 * 1024,
      maxCompanyKeyCodeUnits: 256,
      maxCompanyKeyUtf8Bytes: 256,
      maxArrayLength: 100_000,
      maxJobFields: 256,
      maxDepth: 64,
    });
  });

  it('rejects hostile cardinality and accessors before clock or getter traversal', () => {
    const sparse = new Array(100_000_000);
    let clockReads = 0;
    const sparseDecision = createTranslationShadowPreflightDecisionV2({
      baselineMainSha: BASELINE,
      runBinding: RUN_BINDING,
      dryRun: false,
      jobs: sparse,
      pendingJobs: sparse,
    }, { now: () => { clockReads += 1; return 0; } });
    expect(clockReads).toBe(0);
    expect(sparseDecision.verdict).toMatchObject({
      outcome: 'reject',
      primaryReason: 'capacity_exceeded',
    });
    expect(sparseDecision.verdict.reasons).toContain('capacity_exceeded:input_jobs');
    expect(sparseDecision.verdict.primaryReason).not.toBe('observer_timeout');
    expect(sparseDecision.v2.plannerCallCount).toBe(0);
    expect(Buffer.byteLength(serializeTranslationShadowArtifactV2(sparseDecision)))
      .toBeLessThan(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES);

    const accessorJob = job(8) as any;
    let getterCalls = 0;
    Object.defineProperty(accessorJob, 'hostile', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    const accessorDecision = createTranslationShadowPreflightDecisionV2(preflightInput([accessorJob]));
    expect(getterCalls).toBe(0);
    expect(accessorDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(accessorDecision.verdict.reasons).toContain('input_bound_accessor_unsupported');
    expect(accessorDecision.v2.plannerCallCount).toBe(0);

    const runtime = fs.readFileSync(path.resolve('scripts/relocalize-pending-jobs.mjs'), 'utf8');
    const emitter = runtime.slice(
      runtime.indexOf('function emitTranslationShadowPreflightV2'),
      runtime.indexOf('// Time budget:', runtime.indexOf('function emitTranslationShadowPreflightV2')),
    );
    expect(emitter).toContain('return LEGACY_CLOCK.measureObserver');
    expect(emitter).toContain('catch (error)');
    expect(emitter).toContain('return null;');
  });

  it('rejects oversized company keys before clock, hashing, or artifact amplification', () => {
    const oversizedKeys = Array.from(
      { length: 250 }, (_, index) => `oversized-${index}-${'x'.repeat(100_000)}`,
    );
    const jobs = oversizedKeys.map((companyKey, index) => ({ ...job(index), companyKey }));
    const input = preflightInput(jobs);
    let clockReads = 0;
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const decision = createTranslationShadowPreflightDecisionV2(input, {
      now: () => { clockReads += 1; return 0; },
    });
    const elapsedMs = performance.now() - started;
    const rssDelta = Math.max(0, process.memoryUsage().rss - rssBefore);
    const artifact = serializeTranslationShadowArtifactV2(decision);
    expect(clockReads).toBe(0);
    expect(decision.verdict).toMatchObject({
      outcome: 'reject',
      primaryReason: 'input_incoherent',
    });
    expect(decision.verdict.reasons).toEqual([
      'input_bound_company_key_code_units_exceeded', 'input_incoherent',
    ]);
    expect(decision.verdict.primaryReason).not.toBe('observer_timeout');
    expect(decision.v2.plannerCallCount).toBe(0);
    expect(artifact).not.toContain('oversized-0-');
    expect(Buffer.byteLength(artifact)).toBeLessThan(64 * 1024);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(rssDelta).toBeLessThan(64 * 1024 * 1024);

    const multibyte = { ...job(999), companyKey: 'é'.repeat(200) };
    const multibyteDecision = createTranslationShadowPreflightDecisionV2(preflightInput([multibyte]));
    expect(multibyteDecision.verdict.reasons)
      .toEqual(['input_bound_company_key_bytes_exceeded', 'input_incoherent']);
    expect(multibyteDecision.v2.plannerCallCount).toBe(0);
  });

  it('counts a surrogate pair across a streaming chunk boundary at exactly 1 MiB', () => {
    const chunkBoundaryPrefix = 'a'.repeat((64 * 1024) - 1);
    const emoji = '😀';
    const shell = { id: 'surrogate-boundary', payload: '' };
    const shellBytes = Buffer.byteLength(JSON.stringify(shell));
    const suffixLength = TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxJobBytes
      - shellBytes - Buffer.byteLength(chunkBoundaryPrefix) - Buffer.byteLength(emoji);
    const exactJob = {
      ...shell,
      payload: `${chunkBoundaryPrefix}${emoji}${'b'.repeat(suffixLength)}`,
    };
    expect(exactJob.payload.indexOf(emoji)).toBe((64 * 1024) - 1);
    expect(Buffer.byteLength(JSON.stringify(exactJob)))
      .toBe(TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxJobBytes);
    const exactDecision = createTranslationShadowPreflightDecisionV2(preflightInput([exactJob]));
    expect(exactDecision.verdict.reasons).not.toContain('input_bound_job_bytes_exceeded');
    expect(exactDecision.v2.plannerCallCount).toBe(0);

    const overJob = { ...exactJob, payload: `${exactJob.payload}x` };
    expect(Buffer.byteLength(JSON.stringify(overJob)))
      .toBe(TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxJobBytes + 1);
    const overDecision = createTranslationShadowPreflightDecisionV2(preflightInput([overJob]));
    expect(overDecision.verdict.reasons).toContain('input_bound_job_bytes_exceeded');
    expect(overDecision.v2.plannerCallCount).toBe(0);
  });

  it('counts empty containers exactly and bounds every metadata tree before normalization', () => {
    const containerHeavy = job(5) as any;
    containerHeavy.payload = Array.from({ length: 350_000 }, () => []);
    const containerDecision = createTranslationShadowPreflightDecisionV2(preflightInput([containerHeavy]));
    expect(containerDecision.verdict.primaryReason).toBe('input_incoherent');
    expect(containerDecision.verdict.reasons).toContain('input_bound_job_bytes_exceeded');

    const cyclicTraffic: any = preflightInput([job(6)]);
    cyclicTraffic.traffic.self = cyclicTraffic.traffic;
    const cycleDecision = createTranslationShadowPreflightDecisionV2(cyclicTraffic);
    expect(cycleDecision.verdict.reasons).toContain('input_bound_cycle_detected');

    const oversizedMetadata: any = preflightInput([job(7)]);
    oversizedMetadata.legacy.trafficSource = 'x'.repeat(65 * 1024 * 1024);
    const metadataDecision = createTranslationShadowPreflightDecisionV2(oversizedMetadata);
    expect(metadataDecision.verdict.reasons).toContain('input_bound_metadata_bytes_exceeded');
    expect(metadataDecision.v2.plannerCallCount).toBe(0);
  }, 20_000);

  it('checks the deadline after digest work without a flaky wall clock', () => {
    let reads = 0;
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([]), {
      hardBudgetMs: 1,
      now: () => (reads++ < 7 ? 0 : 2),
    });
    expect(decision.verdict.primaryReason).toBe('observer_timeout');
    expect(decision.v2.state.reason).toBe('observer_timeout');
    expect(decision.v2.plannerCallCount).toBe(0);
  });

  it('binds company budgets exactly to aligned cap-window keys and redacts keyless samples', () => {
    const jobs = [job(1), job(2), job(3)];
    for (const mutate of [
      (input: any) => { input.companyBudgets[0].jobs += 1; },
      (input: any) => { input.companyBudgets.pop(); },
      (input: any) => { input.companyBudgets.push({ ...input.companyBudgets[0] }); },
      (input: any) => { input.capWindowCompanyKeys.reverse(); },
    ]) {
      const input = preflightInput(jobs);
      mutate(input);
      const decision = createTranslationShadowPreflightDecisionV2(input);
      expect(decision.verdict.primaryReason).toBe('input_incoherent');
      expect(decision.v2.plannerCallCount).toBe(0);
    }

    const boundDecision = createTranslationShadowPreflightDecisionV2(preflightInput(jobs));
    const observe = (candidate: any) => createTranslationShadowObservationV2({
      decision: candidate,
      sourceCommit: BASELINE,
      expectedDecisionDigest: candidate.decisionDigest,
      expectedContractDigest: candidate.snapshot.sourceRuntimeContractDigest,
    }).decision;
    expect(observe(boundDecision))
      .toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });
    for (const legacy of [
      {
        ...boundDecision.legacy,
        companyKeyWitness: [...boundDecision.legacy.companyKeyWitness].reverse(),
      },
      {
        ...boundDecision.legacy,
        companyBudgets: [
          boundDecision.legacy.companyBudgets[0],
          boundDecision.legacy.companyBudgets[0],
        ],
      },
      {
        ...boundDecision.legacy,
        companyBudgets: boundDecision.legacy.companyBudgets.map((entry: any) => ({
          companyKey: 'raw-key-must-not-be-accepted', jobs: entry.jobs,
        })),
      },
    ]) {
      expect(observe(resignDecision({ ...boundDecision, legacy })))
        .toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    }

    const keyless = {
      ...job(4),
      id: undefined,
      slug: undefined,
      url: 'https://user@example.test/jobs/?token=super-secret-token',
      companyKey: '',
      company: '',
    };
    const keylessInput = preflightInput([keyless]);
    const keylessDecision = createTranslationShadowPreflightDecisionV2(keylessInput);
    const bytes = serializeTranslationShadowArtifactV2(keylessDecision);
    expect(keylessDecision.legacy.keyless.samples[0]).toMatch(/^job-ref:v2:[a-f0-9]{64}$/);
    expect(bytes).not.toContain('user@example.test');
    expect(bytes).not.toContain('super-secret-token');
  });

  it('marks legacy dry-run and timeout as not-attempted/observer failures, never complete', () => {
    const jobs = [job(1)];
    const dry = createTranslationShadowPreflightDecisionV2({
      baselineMainSha: BASELINE,
      dryRun: true,
      jobs,
      pendingJobs: jobs,
      legacy: {
        maxJobs: 250,
        allowNoTraffic: false,
        companyFilter: {
          population: 'assembled_company_filtered', value: null, before: 1, after: 1,
        },
        preClear: { status: 'not_attempted', reason: 'legacy_dry_run_before_execution_plan' },
        postClear: null,
        trafficSource: 'data/job-popularity.json',
      },
    });
    expect(dry.verdict).toMatchObject({
      outcome: 'reject',
      primaryReason: 'legacy_dry_run_before_execution_plan',
      reasons: ['legacy_dry_run_before_execution_plan'],
    });
    expect(dry.legacy.preClear).toEqual({
      status: 'not_attempted',
      reason: 'legacy_dry_run_before_execution_plan',
    });
    expect(dry.legacy.postClear).toBeNull();
    const dryObservation = createTranslationShadowObservationV2({
      decision: dry,
      sourceCommit: BASELINE,
      expectedDecisionDigest: dry.decisionDigest,
      expectedContractDigest: dry.snapshot.sourceRuntimeContractDigest,
    });
    expect(dryObservation.decision).toMatchObject({
      integrityValid: true,
      semanticValid: true,
      trusted: true,
    });
    for (const forged of [
      resignDecision({ ...dry, legacy: { ...dry.legacy, preClear: { status: 'not_needed' } } }),
      resignDecision({
        ...dry,
        legacy: {
          ...dry.legacy,
          preClear: { status: 'not_attempted', reason: 'legacy_no_pending_before_execution_plan' },
        },
      }),
      resignDecision({ ...dry, legacy: { ...dry.legacy, postClear: { pending: 1 } } }),
      resignDecision({
        ...dry,
        legacy: {
          ...dry.legacy,
          companyFilter: { ...dry.legacy.companyFilter, after: 0 },
        },
      }),
    ]) {
      expect(createTranslationShadowObservationV2({
        decision: forged,
        sourceCommit: BASELINE,
        expectedDecisionDigest: forged.decisionDigest,
        expectedContractDigest: forged.snapshot.sourceRuntimeContractDigest,
      }).decision).toMatchObject({
        integrityValid: true,
        semanticValid: false,
        trusted: false,
      });
    }
    let clockReads = 0;
    const timedOut = createTranslationShadowPreflightDecisionV2(preflightInput(jobs), {
      hardBudgetMs: 1,
      now: () => (clockReads++ === 0 ? 0 : 2),
    });
    expect(timedOut.verdict).toMatchObject({ outcome: 'reject', primaryReason: 'observer_timeout' });
    expect(timedOut.mapping.complete).toBe(false);
    expect(timedOut.v2.state).toEqual({ mode: 'not_read', reason: 'observer_timeout', value: null });
    expect(timedOut.v2.plannerCallCount).toBe(0);
  });
});

describe('translation shadow preflight v2 artifact safety', () => {
  it('writes canonical artifacts atomically only below an explicit safe runner temp', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-'));
    const output = path.join(runnerTemp, 'decision.json');
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    runTranslationShadowPreflightV2(preflightInput([job(1)]), { outputPath: output, runnerTemp });
    expect(fs.readFileSync(output, 'utf8')).toBe(serializeTranslationShadowArtifactV2(decision));
    expect(fs.readdirSync(runnerTemp)).toEqual(['decision.json']);
    expect(fs.statSync(output).size).toBeLessThan(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES);
    expect(() => assertSafeTranslationShadowOutputPath(path.join(runnerTemp, '..', 'escape.json'), runnerTemp))
      .toThrow(/directly below runner temp/);
    expect(() => assertSafeTranslationShadowOutputPath(path.join(runnerTemp, 'nested', 'decision.json'), runnerTemp))
      .toThrow(/directly below runner temp/);
    expect(() => writeTranslationShadowArtifactAtomicV2(output, { padding: 'x'.repeat(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES) }, { runnerTemp }))
      .toThrow(/exceeds 8 MiB/);
  });

  it('rejects symlink components and git worktrees as output roots', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-outside-'));
    fs.symlinkSync(path.join(outside, 'decision.json'), path.join(runnerTemp, 'decision.json'));
    expect(() => assertSafeTranslationShadowOutputPath(path.join(runnerTemp, 'decision.json'), runnerTemp))
      .toThrow(/non-symlink/);
    expect(() => assertSafeTranslationShadowOutputPath(path.resolve('shadow.json'), path.resolve('.')))
      .toThrow(/git worktree/);
  });

  it('rejects the old swappable nested-parent shape and never writes outside runner temp', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-swap-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-swap-outside-'));
    const oldParent = path.join(runnerTemp, 'capsule');
    const output = path.join(oldParent, 'decision.json');
    fs.mkdirSync(oldParent);
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    expect(() => writeTranslationShadowArtifactAtomicV2(output, decision, { runnerTemp }))
      .toThrow(/directly below runner temp/);
    fs.renameSync(oldParent, path.join(runnerTemp, 'capsule-old'));
    fs.symlinkSync(outside, oldParent);
    expect(() => writeTranslationShadowArtifactAtomicV2(output, decision, { runnerTemp }))
      .toThrow(/directly below runner temp/);
    expect(fs.existsSync(path.join(outside, 'decision.json'))).toBe(false);
    expect(fs.readdirSync(runnerTemp).filter((name) => name.startsWith('.translation-shadow-preflight-v2-')))
      .toEqual([]);
  });

  it('captures no binding from an absent or symlinked decision file', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-read-'));
    const decisionPath = path.join(runnerTemp, 'decision.json');
    expect(runTranslationShadowBindingCaptureCli([
      '--mode', 'capture', '--decision', decisionPath,
    ], { runnerTemp })).toEqual({ expectedDecisionDigest: null, expectedContractDigest: null });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-read-outside-'));
    const outsideDecision = path.join(outside, 'decision.json');
    fs.writeFileSync(outsideDecision, serializeTranslationShadowArtifactV2(
      createTranslationShadowPreflightDecisionV2(preflightInput([job(1)])),
    ));
    fs.symlinkSync(outsideDecision, decisionPath);
    expect(runTranslationShadowBindingCaptureCli([
      '--mode', 'capture', '--decision', decisionPath,
    ], { runnerTemp })).toEqual({ expectedDecisionDigest: null, expectedContractDigest: null });
  });
});

describe('translation shadow preflight v2 mapping and run observation', () => {
  it('preserves traffic ordering/object identity while capturing the exact single-read source', () => {
    const popularity = JSON.parse(fs.readFileSync(path.resolve('data/job-popularity.json'), 'utf8'));
    const [hot, cold] = Object.keys(popularity).sort((left, right) => popularity[right] - popularity[left]);
    const pending = [
      { slug: cold, firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
      { slug: hot, firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() },
    ];
    const expected = buildTrafficPriority(pending, popularity).order;
    const capture: any = {};
    const actual = orderPendingByTraffic(pending, { capture });
    expect(actual).toEqual(expected);
    expect(actual.every((item, index) => item === expected[index])).toBe(true);
    expect(capture.popularity).toEqual(popularity);
    expect(capture.stats).toEqual(buildTrafficPriority(pending, popularity).stats);
    expect(pending.map((item) => item.slug)).toEqual([cold, hot]);
  });

  it('does not mutate legacy data, cap order, company budgets, or crawler arguments when enabled', () => {
    const jobs = [job(1), job(2), job(3)];
    const input = preflightInput(jobs, { orderedPending: [jobs[2], jobs[0], jobs[1]], capLength: 2 });
    const beforeBytes = JSON.stringify(input);
    const beforeOrder = input.orderedPending.map((item) => item.id);
    const beforeCrawlerArguments = input.companyBudgets.map((entry) => [entry.companyKey, entry.jobs]);
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-parity-'));
    runTranslationShadowPreflightV2(input, {
      outputPath: path.join(runnerTemp, 'decision.json'),
      runnerTemp,
    });
    expect(JSON.stringify(input)).toBe(beforeBytes);
    expect(input.orderedPending.map((item) => item.id)).toEqual(beforeOrder);
    expect(input.companyBudgets.map((entry) => [entry.companyKey, entry.jobs])).toEqual(beforeCrawlerArguments);

    const runtime = fs.readFileSync(path.resolve('scripts/relocalize-pending-jobs.mjs'), 'utf8');
    const companyKeysAt = runtime.indexOf('const companyKeys = [...companyJobCounts.keys()]');
    const shadowAt = runtime.indexOf('emitTranslationShadowPreflightV2(() => ({', companyKeysAt);
    const alignedKeysAt = runtime.indexOf('capWindowCompanyKeys: cappedPending.map', shadowAt);
    const noKeysAt = runtime.indexOf('if (companyKeys.length === 0)', companyKeysAt);
    const sideEffectAt = runtime.indexOf('invalidateCacheForIncompleteJobs(', companyKeysAt);
    const earlyReturnAt = runtime.indexOf("if (!SHADOW_PREFLIGHT_V2.outputPath) return null");
    const inputFactoryAt = runtime.indexOf('const input = inputFactory()');
    expect(companyKeysAt).toBeGreaterThan(0);
    expect(alignedKeysAt).toBeGreaterThan(0);
    expect(shadowAt).toBeGreaterThan(companyKeysAt);
    expect(alignedKeysAt).toBeGreaterThan(shadowAt);
    expect(shadowAt).toBeLessThan(noKeysAt);
    expect(shadowAt).toBeLessThan(sideEffectAt);
    expect(earlyReturnAt).toBeLessThan(inputFactoryAt);
    expect(runtime).toContain('await runSharedCrawler([key], companyJobCount)');
    expect(runtime).toContain("if (!SHADOW_PREFLIGHT_V2.outputPath) return null");
    expect(runtime).not.toContain('keylessSamples.push');
    expect(runtime.slice(shadowAt)).not.toContain('Date.now()');
    expect(runtime).toContain('CASCADE_LOCALIZATION_DEADLINE_MS - (LEGACY_CLOCK.now() - RUN_START_MS)');
  });

  it('compensates observer time at the legacy company/budget boundary', () => {
    let wallMs = 99;
    const shadowClock = createObserverCompensatedClock(() => wallMs);
    const baseNowMs = wallMs;
    const baseReason = cascadeStopReason({
      nowMs: baseNowMs,
      runStartMs: 0,
      cascadeDeadlineMs: 100,
      passStartMs: 0,
      timeBudgetMs: 1_000,
      timeBudgetFraction: 1,
    });
    let factoryCalls = 0;
    shadowClock.measureObserver(() => {
      factoryCalls += 1;
      wallMs += 2; // lazy cap-window/company-budget/argument preparation
      JSON.stringify({ capWindowCompanyKeys: ['company-1'], companyBudgets: [{ jobs: 1 }] });
      wallMs += 9_000; // observer execution
    });
    const shadowNowMs = shadowClock.now();
    const shadowReason = cascadeStopReason({
      nowMs: shadowNowMs,
      runStartMs: 0,
      cascadeDeadlineMs: 100,
      passStartMs: 0,
      timeBudgetMs: 1_000,
      timeBudgetFraction: 1,
    });
    expect(shadowNowMs).toBe(baseNowMs);
    expect(shadowReason).toBe(baseReason);
    expect(100 - shadowNowMs).toBe(100 - baseNowMs);
    expect(factoryCalls).toBe(1);

    const input = preflightInput([job(1), job(2)]);
    const beforeSelection = JSON.stringify({
      capWindow: input.capWindow.map((item) => item.id),
      companyBudgets: input.companyBudgets,
    });
    createTranslationShadowPreflightDecisionV2(input);
    expect(JSON.stringify({
      capWindow: input.capWindow.map((item) => item.id),
      companyBudgets: input.companyBudgets,
    })).toBe(beforeSelection);
  });

  it('preserves legacy suppression/source-change semantics without using identity v2', () => {
    const suppressed = {
      ...job(1),
      needsRetranslation: false,
      titleByLocale: { it: 'Titolo', en: '', de: '', fr: '' },
      localeMismatchSuppressed: true,
      localeMismatchSuppressedLen: LONG_DESCRIPTION.length,
    };
    expect(needsTranslation(suppressed)).toBe(false);
    expect(needsTranslation({ ...suppressed, description: `${LONG_DESCRIPTION} contenuto nuovo molto lungo` })).toBe(true);
    expect(needsTranslation({ ...suppressed, needsRetranslation: true })).toBe(true);
  });

  it('keeps observation run-scoped, non-authoritative, and binds only an observed translation commit', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const withoutCommit = createTranslationShadowObservationV2({
      decision,
      eventName: 'workflow_dispatch',
      runId: '123',
      runAttempt: '2',
      sourceRepository: 'valerielinc-ops/frontaliere-si-o-no',
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
      observedJobStatus: 'success',
    });
    expect(withoutCommit.finalTranslationCommit).toBeNull();
    expect(withoutCommit.conclusion).toEqual({
      observedJobStatus: 'success',
      authority: 'not_yet_terminal',
      terminalSuccess: null,
    });
    expect(withoutCommit.eligibility.status).toBe('external_not_evaluated');
    expect(withoutCommit.streak.status).toBe('external_not_evaluated');
    const withCommit = createTranslationShadowObservationV2({
      decision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
      finalTranslationCommit: 'b'.repeat(40),
    });
    expect(withCommit.finalTranslationCommit).toBe('b'.repeat(40));
    expect(withCommit.decision).toMatchObject({
      integrityValid: true,
      semanticValid: true,
      trusted: true,
    });
    expect(withCommit.decision.digest).toBe(decision.decisionDigest);
    expect(serializeTranslationShadowArtifactV2(withCommit).length)
      .toBeLessThan(TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES);
  });

  it('trusts a closed no-pending decision only through the captured external bindings', () => {
    const decision = createTranslationShadowPreflightDecisionV2({
      baselineMainSha: BASELINE,
      dryRun: false,
      notAttemptedReason: 'legacy_no_pending_before_execution_plan',
      jobs: [job(1, 0)],
      pendingJobs: [],
      legacy: {
        allowNoTraffic: false,
        companyFilter: {
          population: 'assembled_company_filtered', value: null, before: 0, after: 0,
        },
        maxJobs: 250,
        preClear: { status: 'not_needed' },
        postClear: { population: 'assembled_company_filtered', pending: 0 },
        trafficSource: 'data/job-popularity.json',
      },
    });
    const observation = createTranslationShadowObservationV2({
      decision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    });
    expect(observation.decision).toMatchObject({
      integrityValid: true,
      semanticValid: true,
      trusted: true,
      primaryReason: 'legacy_no_pending_before_execution_plan',
    });
    for (const forged of [
      resignDecision({
        ...decision,
        legacy: {
          ...decision.legacy,
          companyFilter: { ...decision.legacy.companyFilter, after: 1 },
        },
      }),
      resignDecision({
        ...decision,
        legacy: {
          ...decision.legacy,
          postClear: { ...decision.legacy.postClear, pending: 1 },
        },
      }),
    ]) {
      expect(createTranslationShadowObservationV2({
        decision: forged,
        sourceCommit: BASELINE,
        expectedDecisionDigest: forged.decisionDigest,
        expectedContractDigest: forged.snapshot.sourceRuntimeContractDigest,
      }).decision).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    }
  });

  it('binds full and sampled mapping witnesses to exact aggregates, reasons, and digest', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1), job(2)]));
    const observe = (candidate: any) => createTranslationShadowObservationV2({
      decision: candidate,
      sourceCommit: BASELINE,
      expectedDecisionDigest: candidate.decisionDigest,
      expectedContractDigest: candidate.snapshot.sourceRuntimeContractDigest,
    }).decision;
    expect(observe(decision)).toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });

    const mutations = [
      resignDecision({
        ...decision,
        mapping: { ...decision.mapping, demonstrableMissingUnits: 0 },
        capacity: {
          ...decision.capacity,
          observed: {
            ...decision.capacity.observed,
            demonstrableMissingUnits: 0,
            selectedDemonstrableMissingUnits: 0,
          },
        },
        v2: {
          ...decision.v2,
          deferred: {
            ...decision.v2.deferred,
            counts: { ...decision.v2.deferred.counts, demonstrableMissingUnits: 0 },
          },
        },
      }),
      resignDecision({
        ...decision,
        mapping: { ...decision.mapping, maxDemonstrableUnitsPerJob: 0 },
        capacity: {
          ...decision.capacity,
          observed: { ...decision.capacity.observed, maxDemonstrableUnitsPerJob: 0 },
        },
      }),
      resignDecision({
        ...decision,
        mapping: {
          ...decision.mapping,
          reasonCounts: { ...decision.mapping.reasonCounts, source_lang_unavailable: 1 },
        },
      }),
      (() => {
        const digest = digestDocument([]);
        return resignDecision({
          ...decision,
          mapping: { ...decision.mapping, digest },
          v2: { ...decision.v2, deferred: { ...decision.v2.deferred, digest } },
        });
      })(),
      (() => {
        const samples = [decision.mapping.samples[0], decision.mapping.samples[0]];
        const digest = digestDocument(samples);
        return resignDecision({
          ...decision,
          mapping: { ...decision.mapping, digest, samples },
          v2: { ...decision.v2, deferred: { ...decision.v2.deferred, digest, samples } },
        });
      })(),
      resignDecision({
        ...decision,
        capacity: {
          ...decision.capacity,
          observed: { ...decision.capacity.observed, selectedDemonstrableMissingUnits: 3 },
        },
      }),
      resignDecision({
        ...decision,
        mapping: {
          ...decision.mapping,
          selectedRecords: [
            decision.mapping.selectedRecords[0],
            decision.mapping.selectedRecords[0],
          ],
        },
      }),
      resignDecision({
        ...decision,
        mapping: {
          ...decision.mapping,
          selectedRecords: decision.mapping.selectedRecords.map((record: any, index: number) => (
            index === 0
              ? { ...record, occurrenceKey: `job-occurrence:v2:${'f'.repeat(64)}` }
              : record
          )),
        },
      }),
      resignDecision({
        ...decision,
        mapping: {
          ...decision.mapping,
          selectedRecords: [...decision.mapping.selectedRecords].reverse(),
        },
      }),
    ];
    for (const forged of mutations) {
      expect(observe(forged)).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    }

    const truncated = createTranslationShadowPreflightDecisionV2(preflightInput(
      Array.from({ length: 30 }, (_, index) => job(index)),
    ));
    expect(truncated.mapping.records).toHaveLength(30);
    expect(truncated.mapping.samples).toEqual(truncated.mapping.records.slice(0, 20));
    const belowSampleLowerBound = resignDecision({
      ...truncated,
      mapping: { ...truncated.mapping, demonstrableMissingUnits: 19 },
      capacity: {
        ...truncated.capacity,
        observed: {
          ...truncated.capacity.observed,
          demonstrableMissingUnits: 19,
          selectedDemonstrableMissingUnits: 19,
        },
      },
      v2: {
        ...truncated.v2,
        deferred: {
          ...truncated.v2.deferred,
          counts: { ...truncated.v2.deferred.counts, demonstrableMissingUnits: 19 },
        },
      },
    });
    expect(observe(belowSampleLowerBound))
      .toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
  });

  it('enforces monotonic filtered populations without comparing unrelated legacy populations', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const observe = (candidate: any) => createTranslationShadowObservationV2({
      decision: candidate,
      sourceCommit: BASELINE,
      expectedDecisionDigest: candidate.decisionDigest,
      expectedContractDigest: candidate.snapshot.sourceRuntimeContractDigest,
    }).decision;
    const independentPopulations = resignDecision({
      ...decision,
      legacy: {
        ...decision.legacy,
        preClear: {
          ...decision.legacy.preClear,
          direct: { ...decision.legacy.preClear.direct, cleared: 2, reset: 2 },
          assembled: { ...decision.legacy.preClear.assembled, flagsCleared: 2 },
        },
      },
    });
    expect(observe(independentPopulations))
      .toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });

    const forgedLegacyValues = [
      {
        ...decision.legacy,
        companyFilter: { ...decision.legacy.companyFilter, before: 0, after: 1 },
      },
      {
        ...decision.legacy,
        preClear: {
          ...decision.legacy.preClear,
          filteredPending: { ...decision.legacy.preClear.filteredPending, before: 0 },
        },
      },
      {
        ...decision.legacy,
        preClear: {
          ...decision.legacy.preClear,
          direct: { ...decision.legacy.preClear.direct, population: 'assembled_company_filtered' },
        },
      },
    ];
    for (const legacy of forgedLegacyValues) {
      expect(observe(resignDecision({ ...decision, legacy })))
        .toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    }

    const dryRun = createTranslationShadowPreflightDecisionV2({
      ...preflightInput([job(2)]),
      dryRun: true,
      orderedPending: undefined,
      capWindow: undefined,
      capWindowCompanyKeys: undefined,
      companyBudgets: undefined,
      traffic: undefined,
      legacy: {
        ...preflightInput([job(2)]).legacy,
        companyFilter: {
          population: 'assembled_company_filtered', value: null, before: 1, after: 1,
        },
        preClear: { status: 'not_attempted', reason: 'legacy_dry_run_before_execution_plan' },
        postClear: null,
      },
    });
    const forgedDryRun = resignDecision({
      ...dryRun,
      legacy: {
        ...dryRun.legacy,
        companyFilter: { ...dryRun.legacy.companyFilter, before: 0, after: 1 },
      },
    });
    expect(observe(forgedDryRun))
      .toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
  });

  it('decides pre-clear emptiness on the requested company population', () => {
    const completeTarget = { ...job(1, 0), companyKey: 'company-a', needsRetranslation: false };
    const pendingOther = { ...job(2), companyKey: 'company-b' };
    const filteredAfterPreClear = filterPendingForCompany([pendingOther], 'company-a');
    expect(filteredAfterPreClear).toEqual([]);
    expect(filterPendingForCompany([completeTarget, pendingOther], 'company-b'))
      .toEqual([pendingOther]);

    const decision = createTranslationShadowPreflightDecisionV2({
      baselineMainSha: BASELINE,
      runBinding: RUN_BINDING,
      dryRun: false,
      notAttemptedReason: 'legacy_preclear_emptied_execution_plan',
      jobs: [completeTarget, pendingOther],
      pendingJobs: filteredAfterPreClear,
      legacy: {
        allowNoTraffic: false,
        companyFilter: {
          population: 'assembled_company_filtered',
          value: 'company-a',
          before: 2,
          after: 0,
          reappliedAfterPreClear: true,
        },
        maxJobs: 250,
        preClear: {
          direct: { population: 'all_per_crawler_occurrences', cleared: 0, reset: 0 },
          assembled: { population: 'all_assembled_jobs', flagsCleared: 1 },
          filteredPending: { population: 'assembled_company_filtered', before: 1 },
        },
        postClear: { population: 'assembled_company_filtered', pending: 0 },
        trafficSource: 'data/job-popularity.json',
      },
    });
    expect(decision.verdict.primaryReason).toBe('legacy_preclear_emptied_execution_plan');
    expect(decision.verdict.primaryReason).not.toBe('mapping_incomplete');
    expect(decision.legacy.companyFilter.companyKeyDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(serializeTranslationShadowArtifactV2(decision)).not.toContain('company-a');
    expect(createTranslationShadowObservationV2({
      decision,
      expectedRunBinding: RUN_BINDING,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    }).decision).toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });

    const runtime = fs.readFileSync(path.resolve('scripts/relocalize-pending-jobs.mjs'), 'utf8');
    const postClearFilter = runtime.indexOf(
      'const filteredStillPendingJobs = filterPendingForCompany(stillPendingJobs, COMPANY_KEY_FILTER)',
    );
    const emptyCheck = runtime.indexOf('if (filteredStillPendingJobs.length === 0)', postClearFilter);
    expect(postClearFilter).toBeGreaterThan(0);
    expect(emptyCheck).toBeGreaterThan(postClearFilter);
  });

  it('company-scoped early return cannot skip another company\'s pending work (#7127 item 2)', () => {
    // PR #7109 review ❓: the post-preclear early return moved from the
    // dataset-wide `stillPendingJobs.length === 0` to the company-scoped
    // `filteredStillPendingJobs.length === 0`, so a `--company-key` rerun now
    // returns before `orderPendingByTraffic`/capWindow whenever ITS OWN
    // filtered queue is empty, even if some other company still has pending
    // jobs dataset-wide. That branch difference cannot change what gets
    // translated: `pending` is filtered to the requested company key before
    // either check runs, so the other company's job was never in scope of
    // this invocation to begin with, and ordering an empty, already-filtered
    // queue is a documented no-op (assertTrafficPriorityUsable returns
    // without throwing when `stats.queued === 0`).
    const other = { ...job(2), companyKey: 'company-b' };
    // Models `jobs.filter(needsTranslation)` right after the pre-clear:
    // company-a's own job is already done, only company-b's remains
    // dataset-wide.
    const datasetWideStillPending = [other];
    // Pre-#7109 branch condition: non-empty, so the OLD dataset-wide check
    // would NOT have returned early — it would have kept going into
    // orderPendingByTraffic/capWindow purely because of company-b.
    expect(datasetWideStillPending.length).toBeGreaterThan(0);
    // Post-#7109 branch condition: company-a's own queue is empty regardless.
    const filteredForTarget = filterPendingForCompany(datasetWideStillPending, 'company-a');
    expect(filteredForTarget).toEqual([]);

    const capture: Record<string, unknown> = {};
    const ordered = orderPendingByTraffic(filteredForTarget, { capture });
    expect(ordered).toEqual([]);
    expect(ordered.some((j: { companyKey?: string }) => j.companyKey === 'company-b')).toBe(false);
  });

  it('binds a preclear-empty decision to its filtered and post-clear pending counts', () => {
    const decision = createTranslationShadowPreflightDecisionV2({
      baselineMainSha: BASELINE,
      dryRun: false,
      notAttemptedReason: 'legacy_preclear_emptied_execution_plan',
      jobs: [job(1)],
      pendingJobs: [],
      legacy: {
        allowNoTraffic: false,
        companyFilter: {
          population: 'assembled_company_filtered',
          value: null,
          before: 1,
          after: 0,
          reappliedAfterPreClear: false,
        },
        maxJobs: 250,
        preClear: {
          direct: { population: 'all_per_crawler_occurrences', cleared: 0, reset: 0 },
          assembled: { population: 'all_assembled_jobs', flagsCleared: 1 },
          filteredPending: { population: 'assembled_company_filtered', before: 1 },
        },
        postClear: { population: 'assembled_company_filtered', pending: 0 },
        trafficSource: 'data/job-popularity.json',
      },
    });
    const observe = (candidate: any) => createTranslationShadowObservationV2({
      decision: candidate,
      sourceCommit: BASELINE,
      expectedDecisionDigest: candidate.decisionDigest,
      expectedContractDigest: candidate.snapshot.sourceRuntimeContractDigest,
    }).decision;
    expect(observe(decision)).toMatchObject({ integrityValid: true, semanticValid: true, trusted: true });
    for (const forged of [
      resignDecision({
        ...decision,
        legacy: {
          ...decision.legacy,
          companyFilter: { ...decision.legacy.companyFilter, after: 1 },
        },
      }),
      resignDecision({
        ...decision,
        legacy: {
          ...decision.legacy,
          postClear: { ...decision.legacy.postClear, pending: 1 },
        },
      }),
    ]) {
      expect(observe(forged)).toMatchObject({ integrityValid: true, semanticValid: false, trusted: false });
    }
  });

  it('trusts no digest-derived observation metadata after decision tampering', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const tampered = {
      ...decision,
      verdict: { ...decision.verdict, primaryReason: 'measure_only' },
    };
    const observation = createTranslationShadowObservationV2({
      decision: tampered,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    });
    expect(observation.decision).toEqual({
      integrityValid: false,
      semanticValid: false,
      trusted: false,
      digest: null,
      primaryReason: null,
    });
    expect(observation.sourceRuntime.contractDigest).toBeNull();
  });

  it('separates integrity from semantic/source/contract trust bindings', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const semanticForgeries = [
      resignDecision({ ...decision, schemaVersion: 3 }),
      resignDecision({ ...decision, mode: 'execute' }),
      resignDecision({ ...decision, verdict: { ...decision.verdict, outcome: 'accept' } }),
    ];
    for (const forged of semanticForgeries) {
      const observation = createTranslationShadowObservationV2({
        decision: forged,
        sourceCommit: BASELINE,
        expectedDecisionDigest: forged.decisionDigest,
        expectedContractDigest: forged.snapshot.sourceRuntimeContractDigest,
      });
      expect(observation.decision).toMatchObject({
        integrityValid: true,
        semanticValid: false,
        trusted: false,
        digest: null,
        primaryReason: null,
      });
      expect(observation.sourceRuntime.contractDigest).toBeNull();
    }

    const baselineMismatch = createTranslationShadowObservationV2({
      decision,
      sourceCommit: 'b'.repeat(40),
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    });
    expect(baselineMismatch.decision).toMatchObject({
      integrityValid: false,
      semanticValid: false,
      trusted: false,
      digest: null,
      primaryReason: null,
    });
    expect(baselineMismatch.sourceRuntime.contractDigest).toBeNull();

    const wrongContract = resignDecision({
      ...decision,
      snapshot: {
        ...decision.snapshot,
        sourceRuntimeContractDigest: `sha256:${'0'.repeat(64)}`,
      },
    });
    const contractMismatch = createTranslationShadowObservationV2({
      decision: wrongContract,
      sourceCommit: BASELINE,
      expectedDecisionDigest: wrongContract.decisionDigest,
      expectedContractDigest: wrongContract.snapshot.sourceRuntimeContractDigest,
    });
    expect(contractMismatch.decision).toMatchObject({
      integrityValid: true,
      semanticValid: true,
      trusted: false,
      digest: null,
      primaryReason: null,
    });
    expect(contractMismatch.sourceRuntime.contractDigest).toBeNull();
  });

  it('rejects coherently re-signed cross-field and closed-schema forgeries', () => {
    const decision = createTranslationShadowPreflightDecisionV2(preflightInput([job(1)]));
    const forged = resignDecision({
      ...decision,
      verdict: {
        outcome: 'reject',
        primaryReason: 'capacity_exceeded',
        reasons: ['capacity_exceeded:selected_jobs', 'mapping_incomplete', 'version_unbound'],
      },
      capacity: {
        ...decision.capacity,
        observed: { ...decision.capacity.observed, capWindowJobs: 251 },
        exceeded: ['selected_jobs'],
      },
      legacy: {
        ...decision.legacy,
        capWindow: { ...decision.legacy.capWindow, count: 251, forged: true },
      },
      mapping: {
        ...decision.mapping,
        demonstrableMissingUnits: decision.mapping.demonstrableMissingUnits + 1,
      },
    });
    expect(validateTranslationShadowDecisionDigestV2(forged)).toBe(true);
    const observation = createTranslationShadowObservationV2({
      decision: forged,
      sourceCommit: BASELINE,
      expectedDecisionDigest: forged.decisionDigest,
      expectedContractDigest: forged.snapshot.sourceRuntimeContractDigest,
    });
    expect(observation.decision).toMatchObject({
      integrityValid: true,
      semanticValid: false,
      trusted: false,
      digest: null,
      primaryReason: null,
    });
    expect(observation.sourceRuntime.contractDigest).toBeNull();

    const externallyUnbound = createTranslationShadowObservationV2({
      decision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: `sha256:${'0'.repeat(64)}`,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    });
    expect(externallyUnbound.decision.semanticValid).toBe(true);
    expect(externallyUnbound.decision.trusted).toBe(false);
    expect(externallyUnbound.decision.digest).toBeNull();
  });

  it('finalizes observation separately through the bounded CLI without consulting HEAD', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-shadow-v2-observe-'));
    const decisionPath = path.join(runnerTemp, 'decision.json');
    const observationPath = path.join(runnerTemp, 'observation.json');
    const marker = 'person-name-secret@example.test';
    const input = preflightInput([job(1)]);
    input.legacy.companyFilter.value = marker;
    const decision = createTranslationShadowPreflightDecisionV2(input);
    writeTranslationShadowArtifactAtomicV2(decisionPath, decision, { runnerTemp });
    const binding = runTranslationShadowBindingCaptureCli([
      '--mode', 'capture',
      '--decision', decisionPath,
    ], { runnerTemp });
    expect(binding).toEqual({
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    });
    const observeArgs = [
      '--mode', 'observe',
      '--decision', decisionPath,
      '--output', observationPath,
      '--expected-decision-digest', binding.expectedDecisionDigest!,
      '--expected-contract-digest', binding.expectedContractDigest!,
      '--event-name', 'workflow_dispatch',
      '--event-action', '',
      '--run-id', '123',
      '--run-attempt', '2',
      '--default-max-jobs', '900',
      '--default-mopup-max-jobs', '6000',
      '--default-company-key', marker,
      '--default-skip-housekeeping', 'false',
      '--default-skip-translate', 'false',
      '--default-dry-run', 'false',
      '--source-repository', 'valerielinc-ops/frontaliere-si-o-no',
      '--source-workflow', RUN_BINDING.workflow,
      '--source-commit', BASELINE,
      '--workflow-blob-sha', RUN_BINDING.workflowBlobSha,
      '--final-translation-commit', '',
      '--observed-job-status', 'success',
    ];
    const observation = runTranslationShadowObservationCli(observeArgs, { runnerTemp });
    expect(observation.sourceRuntime.sourceCommit).toBe(BASELINE);
    expect(observation.finalTranslationCommit).toBeNull();
    expect(observation.decision.digest).toBe(decision.decisionDigest);
    expect(observation.defaultInputs).toEqual({
      companyKeyDigest: digestTranslationShadowDefaultCompanyKeyV2(marker),
      dryRun: false,
      maxJobs: 900,
      mopupMaxJobs: 6000,
      skipHousekeeping: false,
      skipTranslate: false,
    });
    expect(serializeTranslationShadowArtifactV2(decision)).not.toContain(marker);
    expect(serializeTranslationShadowArtifactV2(observation)).not.toContain(marker);
    expect(fs.readFileSync(observationPath, 'utf8')).toBe(serializeTranslationShadowArtifactV2(observation));

    const commonObservationInput = {
      decision,
      sourceCommit: BASELINE,
      expectedDecisionDigest: decision.decisionDigest,
      expectedContractDigest: decision.snapshot.sourceRuntimeContractDigest,
    };
    const rawDefaultInput = createTranslationShadowObservationV2({
      ...commonObservationInput,
      defaultInputs: {
        companyKey: marker,
        dryRun: false,
        maxJobs: 900,
        mopupMaxJobs: 6000,
        skipHousekeeping: false,
        skipTranslate: false,
      },
    });
    expect(rawDefaultInput.defaultInputs).toBeNull();
    expect(rawDefaultInput.decision.trusted).toBe(false);
    expect(serializeTranslationShadowArtifactV2(rawDefaultInput)).not.toContain(marker);

    const mismatchedDigest = createTranslationShadowObservationV2({
      ...commonObservationInput,
      defaultInputs: {
        ...observation.defaultInputs,
        companyKeyDigest: digestTranslationShadowDefaultCompanyKeyV2('another-company'),
      },
    });
    expect(mismatchedDigest.decision).toMatchObject({
      integrityValid: true,
      semanticValid: true,
      trusted: false,
      digest: null,
      primaryReason: null,
    });
    expect(mismatchedDigest.sourceRuntime.contractDigest).toBeNull();

    const spawnedObservationPath = path.join(runnerTemp, 'spawned-observation.json');
    const spawnedArgs = observeArgs.map((value, index) => (
      index > 0 && observeArgs[index - 1] === '--output' ? spawnedObservationPath : value
    ));
    const spawned = spawnSync(process.execPath, [
      'scripts/translation-shadow-preflight-v2.mjs', ...spawnedArgs,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: runnerTemp },
    });
    expect(spawned.status).toBe(0);
    expect(spawned.stdout).toMatch(/^\{"observationDigest":"sha256:[a-f0-9]{64}"\}\n$/);
    expect(`${spawned.stdout}${spawned.stderr}`).not.toContain(marker);
    expect(fs.readFileSync(spawnedObservationPath, 'utf8')).not.toContain(marker);

    const failed = spawnSync(process.execPath, [
      'scripts/translation-shadow-preflight-v2.mjs',
      ...spawnedArgs.map((value, index) => (
        index > 0 && spawnedArgs[index - 1] === '--default-max-jobs' ? 'not-a-number' : value
      )),
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: runnerTemp },
    });
    expect(failed.status).toBe(1);
    expect(`${failed.stdout}${failed.stderr}`).not.toContain(marker);
    expect(failed.stderr).toBe('--default-max-jobs must be a bounded non-negative integer\n');

    const oversized = 'x'.repeat(100_000);
    const oversizedOutput = path.join(runnerTemp, 'oversized-observation.json');
    const oversizedArgs = observeArgs.map((value, index) => {
      if (index > 0 && observeArgs[index - 1] === '--output') return oversizedOutput;
      if (index > 0 && observeArgs[index - 1] === '--default-company-key') return oversized;
      return value;
    });
    expect(() => runTranslationShadowObservationCli(oversizedArgs, { runnerTemp }))
      .toThrow('input_bound_company_key_code_units_exceeded');
    expect(fs.existsSync(oversizedOutput)).toBe(false);

    const multibyte = 'é'.repeat(200);
    const multibyteArgs = observeArgs.map((value, index) => (
      index > 0 && observeArgs[index - 1] === '--default-company-key' ? multibyte : value
    ));
    expect(() => runTranslationShadowObservationCli(multibyteArgs, { runnerTemp }))
      .toThrow('input_bound_company_key_bytes_exceeded');
  });

  it('has no planner, provider, state-store, memory, checkpoint, CAS, reserve, or settle import', () => {
    const source = fs.readFileSync(path.resolve('scripts/lib/translation-shadow-preflight-v2.mjs'), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:ai-models|provider|translation-state-store|translation-memory|scheduler-v2)/);
    expect(source).not.toMatch(/\b(?:planTranslationScheduleV2|reserveSchedulerPlan|settleSchedulerPlan|checkpointRejectedCandidatesBatch)\b/);
    for (const ownedJavaScript of [
      'scripts/lib/translation-shadow-preflight-v2.mjs',
      'scripts/relocalize-pending-jobs.mjs',
      'scripts/translation-shadow-preflight-v2.mjs',
    ]) {
      expect(fs.readFileSync(path.resolve(ownedJavaScript)).includes(0), ownedJavaScript).toBe(false);
    }
  });
});
