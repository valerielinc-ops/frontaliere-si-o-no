import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  invalidateTranslationCandidateV2,
  lookupTranslationMemoryV2,
  recordTranslationCandidateV2,
  serializeTranslationMemoryV2,
  validateTranslationMemoryV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createTranslationAttemptKeyV2,
  createTranslationUnitIdentityV2,
  translationShardForIdentityV2,
} from '../scripts/lib/translation-unit-identity-v2.mjs';

const evidenceDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const BASE_UNIT = {
  kind: 'job',
  fieldPath: 'description',
  sourceLocale: 'de',
  targetLocale: 'it',
  sourceText: 'SRC_A',
  context: { company: 'COMPANY_A', location: 'LOCATION_A' },
};
const OUTCOME = {
  engineVersion: 'engine-1',
  gateVersion: 'gate-1',
  outputText: 'OUT_A',
  status: 'validated' as const,
  evidence: [{ code: 'gate_pass', digest: evidenceDigest('EVIDENCE_A') }],
};

function identityFromJob(job: Record<string, unknown>) {
  return createTranslationUnitIdentityV2({
    kind: job.kind,
    fieldPath: job.fieldPath,
    sourceLocale: job.sourceLocale,
    targetLocale: job.targetLocale,
    sourceText: job.sourceText,
    context: job.context,
  });
}

describe('translation memory v2 contracts', () => {
  it('survives delete/re-add and URL/id rotation because job metadata is not identity', () => {
    const firstJob = { ...BASE_UNIT, jobId: 'ID_A', jobUrl: 'URL_A' };
    const firstIdentity = identityFromJob(firstJob);
    const stored = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity: firstIdentity,
      ...OUTCOME,
    });
    const afterDelete = validateTranslationMemoryV2(JSON.parse(serializeTranslationMemoryV2(stored)));
    const readdedJob = { ...BASE_UNIT, jobId: 'ID_B', jobUrl: 'URL_B' };
    const readdedIdentity = identityFromJob(readdedJob);

    expect(readdedIdentity).toEqual(firstIdentity);
    expect(lookupTranslationMemoryV2(afterDelete, {
      identity: readdedIdentity,
      engineVersion: OUTCOME.engineVersion,
      gateVersion: OUTCOME.gateVersion,
    }).status).toBe('exact_validated_hit');
  });

  it('hits across URL-only rotation and misses when source or canonical context changes', () => {
    const identity = identityFromJob({ ...BASE_UNIT, jobUrl: 'URL_A' });
    const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity,
      ...OUTCOME,
    });
    const rotated = identityFromJob({ ...BASE_UNIT, jobUrl: 'URL_B' });
    const changedSource = createTranslationUnitIdentityV2({ ...BASE_UNIT, sourceText: 'SRC_B' });
    const changedContext = createTranslationUnitIdentityV2({
      ...BASE_UNIT,
      context: { ...BASE_UNIT.context, location: 'LOCATION_B' },
    });

    expect(rotated.key).toBe(identity.key);
    for (const changed of [changedSource, changedContext]) {
      expect(lookupTranslationMemoryV2(memory, {
        identity: changed,
        engineVersion: OUTCOME.engineVersion,
        gateVersion: OUTCOME.gateVersion,
      }).status).toBe('missing');
    }
  });

  it('negative-caches an exact rejection but a new engine or gate gets a new attempt', () => {
    const identity = createTranslationUnitIdentityV2(BASE_UNIT);
    const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity,
      ...OUTCOME,
      status: 'rejected',
    });

    expect(lookupTranslationMemoryV2(memory, {
      identity,
      engineVersion: 'engine-1',
      gateVersion: 'gate-1',
    }).status).toBe('negative_cache');
    expect(lookupTranslationMemoryV2(memory, {
      identity,
      engineVersion: 'engine-2',
      gateVersion: 'gate-1',
    }).status).toBe('missing');
    expect(lookupTranslationMemoryV2(memory, {
      identity,
      engineVersion: 'engine-1',
      gateVersion: 'gate-2',
    }).status).toBe('missing');
    expect(lookupTranslationMemoryV2(memory, {
      identity: createTranslationUnitIdentityV2({ ...BASE_UNIT, sourceText: 'SRC_B' }),
      engineVersion: 'engine-1',
      gateVersion: 'gate-1',
    }).status).toBe('missing');
    expect(lookupTranslationMemoryV2(memory, {
      identity: createTranslationUnitIdentityV2({
        ...BASE_UNIT,
        context: { ...BASE_UNIT.context, company: 'COMPANY_B' },
      }),
      engineVersion: 'engine-1',
      gateVersion: 'gate-1',
    }).status).toBe('missing');
    expect(() => recordTranslationCandidateV2(memory, {
      identity,
      ...OUTCOME,
      outputText: 'OUT_B',
    })).toThrow(/negative-cached/);
    expect(createTranslationAttemptKeyV2({ identity, engineVersion: 'engine-1', gateVersion: 'gate-1' }))
      .not.toBe(createTranslationAttemptKeyV2({ identity, engineVersion: 'engine-2', gateVersion: 'gate-1' }));
  });

  it('preserves invalidated candidates for audit while a new engine can produce another', () => {
    const identity = createTranslationUnitIdentityV2(BASE_UNIT);
    const initial = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity,
      ...OUTCOME,
    });
    const oldCandidate = initial.records[0].candidates[0];
    const invalidated = invalidateTranslationCandidateV2(initial, {
      identityKey: identity.key,
      candidateId: oldCandidate.candidateId,
      reasonCode: 'needs_retranslation',
    });

    expect(lookupTranslationMemoryV2(invalidated, {
      identity,
      engineVersion: 'engine-1',
      gateVersion: 'gate-1',
    }).status).toBe('missing');
    expect(invalidated.records[0].candidates[0]).toMatchObject({
      candidateId: oldCandidate.candidateId,
      applicability: 'invalidated',
      invalidationReason: 'needs_retranslation',
    });

    const updated = recordTranslationCandidateV2(invalidated, {
      identity,
      ...OUTCOME,
      engineVersion: 'engine-2',
      outputText: 'OUT_B',
    });
    expect(updated.records[0].candidates).toHaveLength(2);
    expect(lookupTranslationMemoryV2(updated, {
      identity,
      engineVersion: 'engine-2',
      gateVersion: 'gate-1',
    }).status).toBe('exact_validated_hit');
  });

  it('retains conflicting outputs with hashes and statuses and never selects silently', () => {
    const identity = createTranslationUnitIdentityV2(BASE_UNIT);
    const one = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity,
      ...OUTCOME,
    });
    const two = recordTranslationCandidateV2(one, {
      identity,
      ...OUTCOME,
      outputText: 'OUT_B',
    });
    const lookup = lookupTranslationMemoryV2(two, {
      identity,
      engineVersion: 'engine-1',
      gateVersion: 'gate-1',
    });

    expect(lookup.status).toBe('conflicting_candidates');
    expect(lookup.candidates.map((candidate) => candidate.status)).toEqual(['validated', 'validated']);
    expect(lookup.candidates.every((candidate) => /^[a-f0-9]{64}$/.test(candidate.outputHash))).toBe(true);
    expect(lookup).not.toHaveProperty('selectedCandidate');
  });

  it('is immutable, strict, bounded and canonically serialized/sharded', () => {
    const identity = createTranslationUnitIdentityV2(BASE_UNIT);
    const input = createEmptyTranslationMemoryV2();
    const forward = recordTranslationCandidateV2(input, { identity, ...OUTCOME });
    const reverseEvidence = recordTranslationCandidateV2(input, {
      identity,
      ...OUTCOME,
      evidence: [...OUTCOME.evidence].reverse(),
    });

    expect(Object.isFrozen(forward.records[0].candidates[0].evidence)).toBe(true);
    expect(input.records).toHaveLength(0);
    expect(serializeTranslationMemoryV2(forward)).toBe(serializeTranslationMemoryV2(reverseEvidence));
    expect(translationShardForIdentityV2(identity)).toBe(`v2/${identity.identityHash.slice(0, 2)}`);
    expect(() => createTranslationUnitIdentityV2({ ...BASE_UNIT, jobId: 'NOT_IDENTITY' })).toThrow();
    expect(() => recordTranslationCandidateV2(input, {
      identity,
      ...OUTCOME,
      evidence: Array.from({ length: 9 }, (_, index) => ({
        code: `gate_${index}`,
        digest: evidenceDigest(`EVIDENCE_${index}`),
      })),
    })).toThrow(/bounded/);
  });
});
