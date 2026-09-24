import { describe, expect, it } from 'vitest';
import {
  calibrateSemanticThreshold,
  createSemanticRunGuard,
  evaluateSemanticCandidate,
  evaluateSemanticRun,
  SEMANTIC_MAX_REGRESSION_RATE,
  SEMANTIC_SCORE_CUTOFF,
  semanticPolicyEnabled,
} from '../scripts/lib/local-mt-semantic-policy.mjs';
import {
  classifyMopupWrite,
  shouldApplyMopupWrite,
} from '../scripts/local-mt-mopup.mjs';

const calibration = {
  status: 'ready',
  source: 'issue-9674',
  scoreCutoff: 0.95,
};

const wrongLanguageSlot = () => ({
  sourceLang: 'de',
  title: 'Metzger 60-100%',
  company: '',
  location: '',
  titleByLocale: { de: 'Metzger 60-100%', it: 'Aiuto Metzger 60-100%' },
  descriptionByLocale: {},
});

describe('local MT semantic overwrite policy', () => {
  it('calibrates a high-precision cutoff from the labelled comparator cases', () => {
    const cases = [
      ...Array.from({ length: 10 }, (_, index) => ({
        source: `source-${index}`,
        sourceLang: 'de',
        targetLocale: 'it',
        existing: 'existing',
        candidate: 'candidate',
        score: 0.95 + index * 0.005,
        label: 'preserved',
        reason: 'meaning-preserved',
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        source: `source-negative-${index}`,
        sourceLang: 'de',
        targetLocale: 'it',
        existing: 'existing',
        candidate: 'candidate',
        score: 0.6 + index * 0.03,
        label: index % 2 ? 'equal' : 'inversion',
        reason: 'meaning-not-preserved',
      })),
    ];

    const result = calibrateSemanticThreshold(cases, { source: 'issue-9674' });
    expect(result).toMatchObject({ status: 'ready', source: 'issue-9674', cases: 20 });
    expect(result.scoreCutoff).toBeGreaterThanOrEqual(SEMANTIC_SCORE_CUTOFF);
    expect(result.precision).toBeGreaterThanOrEqual(0.95);
    expect(result.falsePositives).toBe(0);
  });

  it('refuses calibration when comparator scores are absent', () => {
    const result = calibrateSemanticThreshold({ cases: Array.from({ length: 20 }, () => ({ label: 'preserved' })) });
    expect(result.status).toBe('unavailable');
    expect(result.scoreCutoff).toBeNull();
  });

  it.each([
    [{ score: 0.94, verdict: 'better' }, 'score-below-cutoff'],
    [{ score: 0.97, verdict: 'unclear' }, 'semantic-unclear'],
    [{ score: 0.97, verdict: 'worse' }, 'semantic-worse'],
    [{ score: null, verdict: 'better' }, 'semantic-score-unavailable'],
    [{ score: 0.97, error: 'judge failed' }, 'semantic-error'],
  ])('keeps the existing value for %s', (assessment, reason) => {
    const result = evaluateSemanticCandidate(assessment, { calibration, requireCalibration: true });
    expect(result.shouldWrite).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('does not let a missing calibration become an implicit approval', () => {
    const result = evaluateSemanticCandidate({ score: 0.99, verdict: 'better' }, {
      requireCalibration: true,
    });
    expect(result).toMatchObject({ shouldWrite: false, verdict: 'unclear', reason: 'calibration-unavailable', rollback: true });
  });

  it('requires a semantic pass before the language-driven mopup overwrite', () => {
    const accepted = classifyMopupWrite({
      job: wrongLanguageSlot(),
      locale: 'it',
      field: 'title',
      rawText: 'Macellaio 60-100%',
      semanticPolicy: true,
      semanticCalibration: calibration,
      semanticAssessment: { score: 0.97, verdict: 'better' },
    });
    expect(accepted.decision).toBe('write');
    expect(shouldApplyMopupWrite({
      decision: accepted.decision,
      languageDriven: accepted.languageDriven,
      langAwareOverwrite: true,
      semanticPolicy: true,
      semanticResult: accepted.semantic,
    })).toBe(true);

    const belowCutoff = classifyMopupWrite({
      job: wrongLanguageSlot(),
      locale: 'it',
      field: 'title',
      rawText: 'Macellaio 60-100%',
      semanticPolicy: true,
      semanticCalibration: calibration,
      semanticAssessment: { score: 0.94, verdict: 'better' },
    });
    expect(belowCutoff.decision).toBe('skip:semantic-threshold');
    expect(shouldApplyMopupWrite({
      decision: belowCutoff.decision,
      languageDriven: belowCutoff.languageDriven,
      langAwareOverwrite: true,
      semanticPolicy: true,
      semanticResult: belowCutoff.semantic,
    })).toBe(false);
  });

  it('trips the rollback valve above the measured regression ceiling', () => {
    const healthy = evaluateSemanticRun({ attempted: 100, judged: 100, regressions: 4 });
    expect(healthy).toMatchObject({ enabled: true, rollback: false });

    const regression = evaluateSemanticRun({ attempted: 100, judged: 100, regressions: 13 });
    expect(regression).toMatchObject({ enabled: false, rollback: true, reason: 'regression-limit' });
    expect(regression.regressionRate).toBeCloseTo(0.13);
    expect(SEMANTIC_MAX_REGRESSION_RATE).toBeLessThan(0.123);
  });

  it('closes the run when evidence is unavailable and remains open below the limit', () => {
    const guard = createSemanticRunGuard();
    expect(guard.observe({ verdict: 'unclear', reason: 'semantic-score-unavailable', rollback: true })).toMatchObject({
      enabled: false,
      rollback: true,
    });

    const freshGuard = createSemanticRunGuard();
    for (let index = 0; index < 20; index += 1) {
      freshGuard.observe({ verdict: 'accept', shouldWrite: true, reason: 'score-clears-cutoff' });
    }
    expect(freshGuard.status()).toMatchObject({ enabled: true, rollback: false });
  });

  it('keeps the production semantic switch off unless explicitly enabled', () => {
    expect(semanticPolicyEnabled(undefined)).toBe(false);
    expect(semanticPolicyEnabled('0')).toBe(false);
    expect(semanticPolicyEnabled('true')).toBe(false);
    expect(semanticPolicyEnabled('1')).toBe(true);
  });
});
