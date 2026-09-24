import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calibrateOverwriteCutoff,
  createSemanticRollbackGuard,
  evaluateOverwritePolicy,
  meaningGuardFindings,
  POLICY_VERDICT,
  SEMANTIC_ECHO_CEILING,
  SEMANTIC_OVERWRITE_CUTOFF,
  SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE,
  SEMANTIC_ROLLBACK_MIN_OBSERVATIONS,
} from '../scripts/lib/local-mt-semantic-policy.mjs';
import {
  classifyMopupStructure,
  classifyMopupWrite,
  commitMopupCandidate,
} from '../scripts/local-mt-mopup.mjs';

type Row = {
  id: string;
  label: string;
  source: string;
  sourceLang: string;
  targetLocale: string;
  existing: string;
  candidate: string;
  score: number;
};

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relative), 'utf8')) as T;
}

// The calibration dataset (#9674) with the e5-small cosine recorded for each
// case (#9675), plus the two #9675 report pairs. No model weights are loaded:
// the policy is evaluated on the recorded scores.
function labelledRows(): Row[] {
  const dataset = readJson<{ cases: Omit<Row, 'score'>[] }>('tests/fixtures/local-mt-semantic-cases.json');
  const recorded = readJson<{
    scores: Record<string, number>;
    reportCases: Array<Omit<Row, 'existing'>>;
  }>('tests/fixtures/local-mt-semantic-e5-scores.json');
  return [
    ...dataset.cases.map((item) => ({ ...item, score: recorded.scores[item.id] })),
    ...recorded.reportCases.map((item) => ({ ...item, existing: '' })),
  ];
}

function policyFor(row: Row) {
  return evaluateOverwritePolicy({
    sourceText: row.source,
    sourceLang: row.sourceLang,
    candidateText: row.candidate,
    targetLocale: row.targetLocale,
    existingText: row.existing,
    score: row.score,
  });
}

const rows = labelledRows();
const byLabel = (label: string) => rows.filter((row) => row.label === label);

describe('overwrite policy on the calibration dataset (#9676)', () => {
  it('the cosine alone cannot separate the classes: an inversion outscores every preserved case', () => {
    const preservedMax = Math.max(...byLabel('preserved').map(({ score }) => score));
    const inversionMax = Math.max(...byLabel('inversion').map(({ score }) => score));
    expect(inversionMax).toBeGreaterThan(preservedMax);
    expect(inversionMax).toBeGreaterThanOrEqual(SEMANTIC_OVERWRITE_CUTOFF);
  });

  it('deterministic guards reject every inversion, loss and equal case and no preserved one', () => {
    const guard = (row: Row) => meaningGuardFindings({
      sourceText: row.source,
      sourceLang: row.sourceLang,
      candidateText: row.candidate,
      targetLocale: row.targetLocale,
      existingText: row.existing,
    });
    for (const row of [
      ...byLabel('inversion').filter(({ id }) => !id.startsWith('report-')),
      ...byLabel('loss'),
      ...byLabel('equal'),
    ]) {
      expect(guard(row), row.id).not.toEqual([]);
    }
    for (const row of byLabel('preserved')) expect(guard(row), row.id).toEqual([]);
  });

  it('wrong-language candidates score as source echoes and preserved ones never do', () => {
    for (const row of byLabel('wrong-language')) expect(row.score, row.id).toBeGreaterThanOrEqual(SEMANTIC_ECHO_CEILING);
    for (const row of byLabel('preserved')) expect(row.score, row.id).toBeLessThan(SEMANTIC_ECHO_CEILING);
  });

  it('the cutoff is calibrated: strictly above every surviving negative, at or below an accepted preserved case', () => {
    const calibration = calibrateOverwriteCutoff(rows);
    expect(calibration.status).toBe('ready');
    expect(SEMANTIC_OVERWRITE_CUTOFF).toBeGreaterThan(calibration.maxNegativeScore);
    expect(SEMANTIC_OVERWRITE_CUTOFF).toBeLessThanOrEqual(calibration.lowestAcceptedScore);
    // What the guards cannot read: word-sense `unclear` cases and the two
    // report inversions. They are why the cutoff is high.
    expect([...calibration.survivingNegatives].sort()).toEqual([
      'report-prison-inverted',
      'report-reception-inverted',
      'unclear-01',
      'unclear-02',
      'unclear-03',
      'unclear-04',
    ]);
  });

  it('separates the dataset fail-closed: no negative writes, preserved writes only above the cutoff', () => {
    const verdicts = rows.map((row) => ({ row, policy: policyFor(row) }));
    const falseAccepts = verdicts.filter(({ row, policy }) => row.label !== 'preserved' && policy.shouldWrite);
    expect(falseAccepts.map(({ row }) => row.id)).toEqual([]);

    const expected: Record<string, string> = {
      inversion: POLICY_VERDICT.REJECT,
      loss: POLICY_VERDICT.REJECT,
      'wrong-language': POLICY_VERDICT.REJECT,
      equal: POLICY_VERDICT.REJECT,
      unclear: POLICY_VERDICT.UNCLEAR,
    };
    for (const { row, policy } of verdicts) {
      if (row.id.startsWith('report-') || row.label === 'preserved') continue;
      expect(policy.verdict, row.id).toBe(expected[row.label]);
    }

    const accepted = verdicts.filter(({ policy }) => policy.shouldWrite).map(({ row }) => row.id);
    expect(accepted).toEqual(['preserved-04']);
    // Recall is the declared price of precision: the other correct candidates
    // are `unclear`, which keeps the stored value.
    for (const { row, policy } of verdicts.filter(({ row }) => row.label === 'preserved')) {
      expect([POLICY_VERDICT.ACCEPT, POLICY_VERDICT.UNCLEAR], row.id).toContain(policy.verdict);
    }
  });

  it('a missing, non-finite or out-of-range score is unavailable and never writes', () => {
    const [row] = byLabel('preserved');
    for (const score of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '0.95']) {
      const policy = evaluateOverwritePolicy({
        sourceText: row.source,
        sourceLang: row.sourceLang,
        candidateText: row.candidate,
        targetLocale: row.targetLocale,
        score: score as number,
      });
      expect(policy.verdict, String(score)).toBe(POLICY_VERDICT.UNAVAILABLE);
      expect(policy.shouldWrite).toBe(false);
    }
    expect(evaluateOverwritePolicy({ ...row, score: 0.99, cutoff: Number.NaN }).shouldWrite).toBe(false);
  });

  it('refuses to invent a cutoff when nothing separates', () => {
    const inverted = byLabel('inversion')[0];
    expect(calibrateOverwriteCutoff([]).status).toBe('unavailable');
    expect(calibrateOverwriteCutoff([
      { ...byLabel('preserved')[0], score: 0.9 },
      { ...byLabel('unclear')[0], score: 0.95 },
      { ...inverted, score: 0.5 },
    ]).status).toBe('unavailable');
  });
});

describe('overwrite rollback guard (#9676)', () => {
  it('trips on the first unavailable verdict and stays tripped', () => {
    const guard = createSemanticRollbackGuard();
    guard.observe({ verdict: POLICY_VERDICT.ACCEPT });
    expect(guard.status().tripped).toBe(false);
    guard.observe({ verdict: POLICY_VERDICT.UNAVAILABLE });
    expect(guard.status()).toMatchObject({ tripped: true, reason: 'semantic-unavailable' });
    guard.observe({ verdict: POLICY_VERDICT.ACCEPT });
    expect(guard.status().tripped).toBe(true);
  });

  it('trips when the rejected share exceeds the limit, only after the minimum sample', () => {
    expect(SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE).toBeLessThan(0.123);
    const guard = createSemanticRollbackGuard();
    const rejectsAllowed = Math.floor(SEMANTIC_ROLLBACK_MIN_OBSERVATIONS * SEMANTIC_ROLLBACK_MAX_REGRESSION_RATE);
    for (let i = 0; i < rejectsAllowed + 1; i++) {
      guard.observe({ verdict: POLICY_VERDICT.REJECT, reason: 'meaning-guard' });
    }
    // Two rejects in two observations: 100%, but below the minimum sample.
    expect(guard.status().tripped).toBe(false);
    while (guard.status().observed < SEMANTIC_ROLLBACK_MIN_OBSERVATIONS) {
      guard.observe({ verdict: POLICY_VERDICT.ACCEPT });
    }
    expect(guard.status()).toMatchObject({ tripped: true, reason: 'regression-limit' });
  });

  it('does not count no-ops or unclear candidates as regressions', () => {
    const guard = createSemanticRollbackGuard({ minObservations: 1 });
    guard.observe({ verdict: POLICY_VERDICT.REJECT, reason: 'no-op' });
    guard.observe({ verdict: POLICY_VERDICT.UNCLEAR, reason: 'below-cutoff' });
    expect(guard.status()).toMatchObject({ tripped: false, regressions: 0, observed: 2 });
  });
});

// A German title in the Italian slot: the language arm wants to REPLACE it.
function overwriteJob(title: string) {
  return {
    sourceLang: 'de',
    title,
    company: '',
    location: '',
    slug: 'job-1',
    titleByLocale: { de: title, it: 'Aushilfe Verkauf' },
    descriptionByLocale: {},
    slugByLocale: {},
  };
}

const acceptingJudge = (score: number) => async () => ({
  accepted: true,
  score,
  threshold: 0.8,
  reason: 'semantic-match',
});

describe('mop-up overwrite arm under the policy (#9676)', () => {
  const target = { locale: 'it', field: 'title' } as const;

  it('an inverted overwrite the cosine accepts is no longer written', async () => {
    const job = overwriteJob('Verkäuferin Teilzeit');
    const before = structuredClone(job);
    const candidate = classifyMopupStructure({ job, ...target, rawText: 'Commessa a tempo pieno' });
    // The structural chain and the bootstrap judge both let it through.
    expect(candidate).toMatchObject({ decision: 'write', languageDriven: true });

    const result = await commitMopupCandidate({ job, ...target, candidate, judge: acceptingJudge(0.95) });

    expect(result).toMatchObject({ written: false, decision: 'skip:semantic-reject' });
    expect(result.judged.semanticPolicy.findings).toContain('polarity:part-time->full-time');
    expect(job).toEqual(before);
  });

  it('a clean overwrite below the cutoff is unclear and keeps the stored value', () => {
    const job = overwriteJob('Gefängnisseelsorger');
    expect(classifyMopupWrite({
      job,
      ...target,
      rawText: 'Cappellano carcerario',
      semanticVerdict: { accepted: true, score: 0.9123, threshold: 0.8 },
    }).decision).toBe('skip:semantic-unclear');
  });

  it('a clean overwrite above the cutoff is written', async () => {
    const job = overwriteJob('Gefängnisseelsorger');
    const candidate = classifyMopupStructure({ job, ...target, rawText: 'Cappellano carcerario' });
    const result = await commitMopupCandidate({ job, ...target, candidate, judge: acceptingJudge(0.95) });
    expect(result).toMatchObject({ written: true, decision: 'write' });
    expect(job.titleByLocale.it).toBe('Cappellano carcerario');
  });

  it('once the run guard trips, no later overwrite is written', async () => {
    const rollbackGuard = createSemanticRollbackGuard();
    const broken = overwriteJob('Gefängnisseelsorger');
    const first = await commitMopupCandidate({
      job: broken,
      ...target,
      candidate: classifyMopupStructure({ job: broken, ...target, rawText: 'Cappellano carcerario' }),
      judge: async () => {
        throw new Error('onnxruntime crashed');
      },
      rollbackGuard,
    });
    expect(first).toMatchObject({ written: false, decision: 'skip:semantic-unavailable' });
    expect(rollbackGuard.status().tripped).toBe(true);

    const job = overwriteJob('Gefängnisseelsorger');
    const before = structuredClone(job);
    const second = await commitMopupCandidate({
      job,
      ...target,
      candidate: classifyMopupStructure({ job, ...target, rawText: 'Cappellano carcerario' }),
      judge: acceptingJudge(0.95),
      rollbackGuard,
    });
    expect(second).toMatchObject({ written: false, decision: 'skip:semantic-rollback' });
    expect(job).toEqual(before);
    expect(rollbackGuard.status().withheld).toBe(1);
  });

  it('filling an empty slot keeps the bootstrap gate (policy scope is the overwrite arm)', async () => {
    const job = { ...overwriteJob('Gefängnisseelsorger'), titleByLocale: { de: 'Gefängnisseelsorger' } };
    const candidate = classifyMopupStructure({ job, ...target, rawText: 'Cappellano carcerario' });
    expect(candidate.languageDriven).toBeFalsy();
    const result = await commitMopupCandidate({ job, ...target, candidate, judge: acceptingJudge(0.85) });
    expect(result).toMatchObject({ written: true, decision: 'write' });
  });
});
