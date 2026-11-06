import { describe, expect, it } from 'vitest';
import {
  TRANSLATION_GENERATION_ARTIFACT_NAME,
  TRANSLATION_GENERATION_WORKFLOW_FILE,
  createTranslationGenerationClosure,
  digestTranslationGenerationClosure,
} from '../scripts/lib/translation-generation-closure-v2.mjs';
import {
  evaluateTranslationGenerationSeries,
  runTranslationGenerationLiveTally,
} from '../scripts/audit-translation-generation-live-tally.mjs';

const REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';

function hexValue(generation: number, prefix: string, length: number) {
  const pair = `${generation.toString(16)}${prefix}`;
  return pair.repeat(length / pair.length);
}

function makeClosure(generation: number) {
  const planHash = `translation-schedule:v2:${hexValue(generation, 'd', 64)}`;
  return createTranslationGenerationClosure({
    schemaVersion: 1,
    scopeKey: 'translation-shadow-v2',
    generation,
    sourceCommit: hexValue(generation, 'a', 40),
    stateRef: 'refs/heads/translation-state-v2',
    stateTip: hexValue(generation, 'f', 40),
    providerContract: {
      schemaVersion: 3,
      costClass: 'zero',
      engineVersion: 'shadow-engine-v2',
      executionClass: 'isolated_callback',
      exportName: 'translate',
      gateVersion: 'translation-quality-v2',
      module: 'scripts/lib/translation-shadow-provider-v2.mjs',
    },
    canary: {
      name: 'translation-schedule-v2-shadow',
      mode: 'shadow',
      generationEnabled: true,
      mainPublish: false,
    },
    runBinding: {
      event: 'schedule',
      repository: REPOSITORY,
      runAttempt: '1',
      runId: String(10_000 + generation),
      workflow: TRANSLATION_GENERATION_WORKFLOW_FILE,
      workflowRef: 'refs/heads/main',
      workflowSha: hexValue(1, 'b', 40),
    },
    plan: {
      hash: planHash,
      scanDigest: `sha256:${hexValue(generation, 'c', 64)}`,
      cursorBeforeHash: hexValue(generation, 'e', 64),
      cursorAfterHash: hexValue(generation, '1', 64),
      generation,
    },
    settlement: {
      hash: hexValue(generation, '2', 64),
      planHash,
      cursorHash: hexValue(generation, '3', 64),
      metrics: {
        generated: 1,
        jobsCompleted: 1,
        patchesApplied: 1,
        patchesQueued: 1,
        queueJobsIn: 1,
        queueJobsOut: 0,
        queueUnitsIn: 1,
        queueUnitsOut: 0,
        rejected: 0,
        validated: 1,
        outcomeCounts: { validated: 1 },
      },
    },
    result: {
      status: 'settled',
      selectedJobs: 1,
      selectedUnits: 1,
      outcomeCounts: { validated: 1 },
      candidateCounts: { rejected: 0, validated: 1 },
    },
  });
}

function makeRecord(generation: number) {
  const closure = makeClosure(generation);
  const runId = Number(closure.runBinding.runId);
  return {
    report: {
      status: 'settled',
      sourceCommit: closure.sourceCommit,
      scanDigest: closure.plan.scanDigest,
      planHash: closure.plan.hash,
      stateRef: closure.stateRef,
      state: { after: closure.stateTip, settled: true },
      scheduler: {
        selectedJobs: closure.result.selectedJobs,
        selectedUnits: closure.result.selectedUnits,
        outcomeCounts: closure.result.outcomeCounts,
        settlement: closure.settlement.metrics,
      },
      candidates: closure.result.candidateCounts,
      closure,
      closureDigest: digestTranslationGenerationClosure(closure),
    },
    artifact: {
      id: 20_000 + generation,
      name: TRANSLATION_GENERATION_ARTIFACT_NAME,
      expired: false,
      size_in_bytes: 1_024,
      workflow_run: { id: runId },
    },
    run: {
      id: String(runId),
      run_attempt: 1,
      path: TRANSLATION_GENERATION_WORKFLOW_FILE,
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      head_sha: closure.sourceCommit,
      repository: { full_name: REPOSITORY },
    },
    stateVerification: { verified: true },
  };
}

function makeRecords(generations: number[]) {
  return generations.map(makeRecord);
}

describe('translation generation live tally', () => {
  it('verifies fourteen settled live generations with closure and state bindings', () => {
    const tally = evaluateTranslationGenerationSeries({
      records: makeRecords(Array.from({ length: 14 }, (_, index) => index + 1)),
      required: 14,
      repository: REPOSITORY,
    });

    expect(tally).toMatchObject({
      status: 'complete',
      complete: true,
      validGenerations: 14,
      requiredGenerations: 14,
      violations: [],
    });
    expect(tally.generations.map(({ generation }) => generation))
      .toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
  });

  it('rejects a tampered closure digest instead of counting the report', () => {
    const records = makeRecords([1, 2, 3]);
    records[1].report.closureDigest = `sha256:${'0'.repeat(64)}`;

    const tally = evaluateTranslationGenerationSeries({
      records,
      required: 3,
      repository: REPOSITORY,
    });

    expect(tally.status).toBe('invalid');
    expect(tally.validGenerations).toBe(2);
    expect(tally.violations).toContain('closure_digest_invalid');
  });

  it('rejects duplicate and missing generations fail-closed', () => {
    const duplicate = evaluateTranslationGenerationSeries({
      records: [...makeRecords([1, 2, 3]), makeRecord(3)],
      required: 3,
      repository: REPOSITORY,
    });
    const gap = evaluateTranslationGenerationSeries({
      records: makeRecords([1, 2, 4]),
      required: 3,
      repository: REPOSITORY,
    });

    expect(duplicate.violations).toContain('generation_duplicate');
    expect(duplicate.status).toBe('invalid');
    expect(gap.violations).toContain('generation_gap');
    expect(gap.status).toBe('invalid');
  });

  it('does not treat a bare fixture as live evidence', () => {
    const tally = evaluateTranslationGenerationSeries({
      records: [{ report: makeRecord(1).report }],
      required: 1,
      repository: REPOSITORY,
    });

    expect(tally.status).toBe('invalid');
    expect(tally.validGenerations).toBe(0);
    expect(tally.violations).toEqual(expect.arrayContaining([
      'actions_run_missing',
      'artifact_binding_missing',
      'state_closure_unverified',
    ]));
  });

  it('loads the bounded Actions artifact set and verifies each state tip', async () => {
    const records = makeRecords(Array.from({ length: 14 }, (_, index) => index + 1));
    const byArtifactId = new Map(records.map((record) => [record.artifact.id, record]));
    let verified = 0;
    const client = {
      json: async (pathname: string) => {
        if (pathname.includes('/actions/artifacts?')) {
          return {
            total_count: records.length,
            artifacts: records.map(({ artifact }) => artifact),
          };
        }
        const runId = Number(pathname.split('/').at(-1));
        return records.find((record) => Number(record.run.id) === runId)?.run;
      },
    };

    const tally = await runTranslationGenerationLiveTally({
      repository: REPOSITORY,
      required: 14,
      client,
      readArtifact: async (artifact) => byArtifactId.get(artifact.id)?.report,
      stateVerifier: async ({ closure }) => {
        expect(closure.stateRef).toBe('refs/heads/translation-state-v2');
        verified += 1;
        return { verified: true };
      },
      runnerTemp: process.cwd(),
      now: () => 'now',
    });

    expect(tally.status).toBe('complete');
    expect(tally.checkedAt).toBe('now');
    expect(verified).toBe(14);
  });
});
