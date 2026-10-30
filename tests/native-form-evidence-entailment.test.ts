import { describe, expect, it, vi } from 'vitest';
import { nativeFormAssessmentHash, NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT, qualificationSources, verifyNativeFormAnswers } from '../functions/src/lib/qualificationEvidence.js';

function fixture() {
  const sources = qualificationSources({ sourceText: 'Senior IT Manager\nMaster’s Degree in Computer Science\nWorked as a software engineer for eight years' });
  const claims = [
    { fieldId: 'degree', nativeFormContract: { question: 'Do you hold a university degree?', context: 'Education', options: ['Yes', 'No'] }, proposedAnswer: 'Yes' as string | number | boolean },
    { fieldId: 'years', nativeFormContract: { question: 'How many years have you worked as a software engineer?', context: 'Professional experience', options: [], unit: 'years' }, proposedAnswer: 8 as string | number | boolean },
  ];
  const generate = vi.fn(async (_system: string, user: string, _schema?: any, _options?: any) => {
    const payload = JSON.parse(user);
    return { assessments: payload.claims.map((claim: any) => ({ index: claim.index, sourceId: payload.sources.find((source: any) => source.quote.includes(claim.index ? 'eight years' : 'Master’s Degree')).sourceId, verdict: 'supported', reason: 'explicit_fact' })) };
  });
  return { claims, sources, generate, scope: { orderId: 'fixture-order', round: 2, jobId: 'fixture-job' } };
}

describe('blind native form answer evidence selection', () => {
  it('selects only server primary source IDs in one bounded call, without first-planner assertions', async () => {
    const f = fixture();
    const result = await verifyNativeFormAnswers({ ...f, claims: f.claims.map(claim => ({ ...claim, rationale: 'untrusted planner says yes', status: 'met' })) });
    expect(result.status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(1);
    const [system, user, schema, options] = f.generate.mock.calls[0];
    expect(system).toBe(NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT);
    const payload = JSON.parse(user);
    expect(payload.claims.map((claim: any) => claim.proposedAnswer)).toEqual(['Yes', 8]);
    expect(user).not.toContain('untrusted planner');
    expect(user).not.toContain('"status":"met"');
    expect(schema.properties.assessments.items.properties.sourceId.enum).toEqual(['', ...payload.sources.map((source: any) => source.sourceId)]);
    expect(options).toEqual({ maxTokens: 2048 });
    expect(result.verification.checks).toHaveLength(2);
    expect(JSON.stringify(result.verification)).not.toContain('[[cv:');
  });

  it.each(['missing', 'duplicate', 'unknown_index', 'unknown_source', 'unsupported', 'uncertain', 'invalid_reason', 'contradiction_reason'])('fails technically closed on %s', async violation => {
    const f = fixture();
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => {
      const raw = await original(...args);
      if (violation === 'missing') raw.assessments.pop();
      if (violation === 'duplicate') raw.assessments[1] = raw.assessments[0];
      if (violation === 'unknown_index') raw.assessments[0].index = 99;
      if (violation === 'unknown_source') raw.assessments[0].sourceId = '[[profile:9999]]';
      if (violation === 'unsupported') raw.assessments[0].verdict = 'unsupported';
      if (violation === 'uncertain') raw.assessments[0].verdict = 'uncertain';
      if (violation === 'contradiction_reason') raw.assessments[0].reason = 'contradiction';
      if (violation === 'invalid_reason') raw.assessments[0].reason = 'title_without_activity';
      return raw;
    });
    expect(await verifyNativeFormAnswers(f)).toMatchObject({ status: 'unverified', reason: 'evidence_entailment_unverified' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps a deferred verdict bound to its owned input snapshot', async () => {
    const f = fixture();
    const counter = { correction: 'Current statement' };
    const originalKey = nativeFormAssessmentHash({ ...f, unverifiedContext: counter });
    let release!: (value: any) => void;
    let payload: any;
    f.generate.mockImplementation(async (_system, user) => {
      payload = JSON.parse(user);
      return new Promise(resolve => { release = resolve; });
    });
    const pending = verifyNativeFormAnswers({ ...f, unverifiedContext: counter });
    f.claims[0].proposedAnswer = 'No';
    f.claims[0].fieldId = 'changed-field';
    f.scope.round = 3;
    counter.correction = 'Changed while waiting';
    f.sources.evidenceCatalog().forEach(source => { source.documentHash = 'changed-source'; });
    release({ assessments: payload.claims.map((claim: any) => ({ index: claim.index,
      sourceId: payload.sources.find((source: any) => source.quote.includes(claim.index ? 'eight years' : 'Master’s Degree')).sourceId,
      verdict: 'supported', reason: 'explicit_fact' })) });
    const result = await pending;
    expect(result.status).toBe('supported');
    expect(result.verification.assessmentHash).toBe(originalKey);
    expect(result.verification.assessmentHash).not.toBe(nativeFormAssessmentHash({ ...f, unverifiedContext: counter }));
    expect(result.verification.checks[0].fieldId).toBe('degree');
    expect(result.verification.checks[0].sourceHash).not.toBe('changed-source');
  });

  it('does not stamp a verdict with another day when the judge crosses UTC midnight', async () => {
    vi.useFakeTimers();
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const midnight = today.getTime();
      vi.setSystemTime(midnight - 500);
      const f = fixture();
      const original = f.generate.getMockImplementation()!;
      f.generate.mockImplementation(async (...args) => {
        const result = await original(...args);
        vi.setSystemTime(midnight + 500);
        return result;
      });
      expect(await verifyNativeFormAnswers(f)).toMatchObject({ status: 'unverified', verification: { failure: 'date_changed' } });
    } finally { vi.useRealTimers(); }
  });

  it('preserves neighboring role/date attribution by original source IDs without duplicating CV text', async () => {
    const f = fixture();
    const sources = qualificationSources({ sourceText: `Software Engineer — Example Systems\n${new Date().getUTCFullYear() - 8} – Present` });
    f.generate.mockImplementation(async (_system, user) => {
      const payload = JSON.parse(user);
      const date = payload.sources.find((source: any) => source.quote.includes('Present'));
      const role = payload.sources.find((source: any) => source.quote.includes('Software Engineer'));
      expect(date.contextSourceIds).toContain(role.sourceId);
      expect(date).not.toHaveProperty('context');
      return { assessments: [{ index: 0, sourceId: date.sourceId, verdict: 'supported', reason: 'relevant_role_or_tenure' }] };
    });
    expect((await verifyNativeFormAnswers({ ...f, sources, claims: [{ fieldId: 'tenure', nativeFormContract: { question: 'Have you worked as a software engineer for at least five years?' }, proposedAnswer: 'Yes' }] })).status).toBe('supported');
  });

  it('does not skip a negative answer or interpret a printed option as the actual attested answer', async () => {
    const f = fixture();
    const record = { id: 'answer-record', key: 'question_fixture', question: { question: 'Do you need sponsorship?', options: ['Yes', 'No'] }, answer: 'Yes', category: 'work_authorization', unit: 'boolean', scope: 'job', provenance: { actor: 'candidate', round: 2, userId: 'private-user', orderId: 'private-order' } };
    const sources = qualificationSources({ sourceText: '', answerEvidence: [record] });
    f.generate.mockImplementation(async (_system, user) => {
      const payload = JSON.parse(user);
      expect(payload.claims[0].proposedAnswer).toBe(false);
      expect(payload.sources).toHaveLength(1);
      expect(payload.sources[0].answerRecord.answer).toBe('Yes');
      expect(payload.sources[0].answerRecord.question.options).toEqual(['Yes', 'No']);
      expect(user).not.toContain('private-user');
      expect(user).not.toContain('private-order');
      return { assessments: [{ index: 0, sourceId: payload.sources[0].sourceId, verdict: 'unsupported', reason: 'contradiction' }] };
    });
    const result = await verifyNativeFormAnswers({ ...f, claims: [{ fieldId: 'sponsor', nativeFormContract: { question: 'Do you need sponsorship?' }, proposedAnswer: false }], sources });
    expect(result.status).toBe('unverified');
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('does not use a profile projection or raw answer map as primary evidence', async () => {
    const f = fixture();
    const result = await verifyNativeFormAnswers({ ...f, sources: qualificationSources({ profile: { degree: 'Master’s Degree' }, answers: { question_unknown: 'Yes' } }) });
    expect(result).toMatchObject({ status: 'unverified', verification: { failure: 'source_unbound' } });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('binds cache identity to full native contract, value, original sources, policy, counter-context and round', () => {
    const f = fixture();
    const key = nativeFormAssessmentHash(f);
    expect(nativeFormAssessmentHash({ ...f, scope: { jobId: 'fixture-job', round: 2, orderId: 'fixture-order' } })).toBe(key);
    expect(nativeFormAssessmentHash({ ...f, scope: { ...f.scope, round: 3 } })).not.toBe(key);
    expect(nativeFormAssessmentHash({ ...f, claims: [{ ...f.claims[0], proposedAnswer: 'No' }] })).not.toBe(key);
    expect(nativeFormAssessmentHash({ ...f, claims: [{ ...f.claims[0], nativeFormContract: { ...f.claims[0].nativeFormContract, options: ['Yes', 'No', 'In progress'] } }] })).not.toBe(key);
    expect(nativeFormAssessmentHash({ ...f, sources: qualificationSources({ sourceText: 'Different original CV' }) })).not.toBe(key);
    expect(nativeFormAssessmentHash({ ...f, unverifiedContext: { correction: 'The old degree assertion is incorrect.' } })).not.toBe(key);
  });

  it('rejects malformed, excessive or oversized input and provider failure without selecting convenient text', async () => {
    const f = fixture();
    for (const claims of [[f.claims[0], f.claims[0]], [{ ...f.claims[0], proposedAnswer: '' }], Array.from({ length: 13 }, (_, index) => ({ ...f.claims[0], fieldId: `field-${index}` }))]) {
      expect((await verifyNativeFormAnswers({ ...f, claims })).status).toBe('unverified');
    }
    expect((await verifyNativeFormAnswers({ ...f, sources: qualificationSources({ sourceText: 'Original CV statement.\n'.repeat(1800) }) })).status).toBe('unverified');
    expect(f.generate).not.toHaveBeenCalled();
    f.generate.mockRejectedValue(new Error('broker unavailable'));
    expect(await verifyNativeFormAnswers(f)).toMatchObject({ status: 'unverified', verification: { failure: 'judge_unavailable' } });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});
