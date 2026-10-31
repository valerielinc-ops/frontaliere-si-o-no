import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluateConciergePosting } from '../functions/src/applicationConciergeEligibility.js';
import { REQUIREMENTS_SYSTEM_PROMPT } from '../functions/src/assistedApplicationAiPrompts.js';
import { EVIDENCE_ENTAILMENT_SYSTEM_PROMPT } from '../functions/src/lib/qualificationEvidence.js';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';

function fixture(patch = {}) {
  const sourceText = 'Current English level A2. Infrastructure engineer with demonstrated experience.';
  const cvHash = createHash('sha256').update(sourceText).digest('hex');
  const job = { id: 'synthetic-job', url: 'https://example.test/synthetic-job/', title: 'Engineer' };
  const question = 'What is your current English proficiency level?';
  const record = { id: 'confirmed-job-english', version: 'confirmed-question-evidence-v1', category: 'language',
    scope: 'job', unit: 'CEFR_or_stated_level', answer: 'C1', question: { question, type: 'text',
      originalNativeContract: nativeFormContract({ id: 'english', label: question, kind: 'text', inputType: 'text',
        nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application'], unknown: false }], options: [] }) },
    provenance: { actor: 'candidate', round: 1, confirmedAt: Date.now(), cvHash, jobId: job.id, jobUrl: job.url }, ...patch };
  const profile = { languages: [{ language: 'en', level: 'A2' }] };
  const blind = vi.fn(async (_system: string, user: string) => ({ assessments: JSON.parse(user).claims.map((claim: any) => ({
    index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) }));
  const generate = vi.fn(async (system: string, user: string) => {
    if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [{ requirement: 'English C1', quote: 'English C1 is required.', basis: 'stated', importance: 'critical' }] };
    if (system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT) return blind(system, user);
    const payload = JSON.parse(user.split('\n\n<<<POSTING EXCERPT')[0]);
    return { matches: [{ index: 0, status: 'met', evidence: payload.candidateSourceExcerpts.find((source: any) => source.id.startsWith('[[answer_')).id }], verdict: 'good', questions: [] };
  });
  const run = () => evaluateConciergePosting({ job, profile, sourceText, cvHash, answerEvidence: [record], generate,
    readPosting: async () => ({ text: 'English C1 is required. ' + 'Maintain infrastructure services. '.repeat(10), textTruncated: false }) });
  return { run, profile, record, blind };
}

describe('current-job language reassessment after a supported source-bound witness', () => {
  it('uses current same-CV job-scoped C1 for this requirement without changing original CV facts or Q/A scope', async () => {
    const f = fixture(); const original = structuredClone({ profile: f.profile, record: f.record });
    expect(await f.run()).toMatchObject({ status: 'compatible', gaps: [] });
    expect(f.blind).toHaveBeenCalledTimes(1);
    expect({ profile: f.profile, record: f.record }).toEqual(original);
  });
  it('does not use a different-job answer to neutralize the original A2 shortfall', async () => {
    const base = fixture();
    const f = fixture({ provenance: { ...base.record.provenance, jobId: 'another-job', jobUrl: 'https://example.test/another-job/' } });
    const result = await f.run();
    expect(result.status).toBe('incompatible');
    expect(result.gaps.some((gap: any) => gap.knownMissing)).toBe(true);
    expect(f.blind).not.toHaveBeenCalled();
  });
  it('holds a current-job assertion bound to another CV without reviving the old A2 gap', async () => {
    const base = fixture(); const f = fixture({ provenance: { ...base.record.provenance, cvHash: 'a'.repeat(64) } });
    expect(await f.run()).toMatchObject({ status: 'unverified', gaps: [], questions: [] });
    expect(f.blind).not.toHaveBeenCalled();
  });
});
