import { describe, expect, it, vi } from 'vitest';
import { nativeEvidenceCatalog } from './helpers/nativeEvidenceCatalog';
import { nativeFormAssessmentHash, NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT, qualificationSources, verifyNativeFormAnswers } from '../functions/src/lib/qualificationEvidence.js';

function fixture() {
  const sources = qualificationSources({ sourceText: 'Senior IT Manager\nMaster’s Degree in Computer Science\nWorked as a software engineer for eight years' });
  const claims = [
    { fieldId: 'degree', nativeFormContract: { question: 'Do you hold a university degree?', context: 'Education', options: ['Yes', 'No'] }, proposedAnswer: 'Yes' as string | number | boolean },
    { fieldId: 'years', nativeFormContract: { question: 'How many years have you worked as a software engineer?', context: 'Professional experience', options: [], unit: 'years' }, proposedAnswer: 8 as string | number | boolean },
  ];
  const generate = vi.fn(async (system: string, user: string, _schema?: any, _options?: any) => {
    const payload = JSON.parse(user);
    if (payload.sourceColumns) payload.sources = nativeEvidenceCatalog(payload);
    if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) return { assessments: payload.claims.map((claim: any) => ({ index: claim.index,
      sourceIds: [payload.sources.find((source: any) => source.quote.includes(claim.index ? 'eight years' : 'Master’s Degree')).sourceId] })) };
    return { assessments: payload.claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) };
  });
  return { claims, sources, generate, scope: { orderId: 'fixture-order', round: 2, jobId: 'fixture-job' } };
}

describe('blind native form answer evidence selection', () => {
  it('selects only server primary source IDs in one bounded selection and one blind adjudication, without first-planner assertions', async () => {
    const f = fixture();
    const result = await verifyNativeFormAnswers({ ...f, claims: f.claims.map(claim => ({ ...claim, rationale: 'untrusted planner says yes', status: 'met' })) });
    expect(result.status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
    const [system, user, schema, options] = f.generate.mock.calls[0];
    expect(system).toBe(NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT);
    const payload = JSON.parse(user);
    if (payload.sourceColumns) payload.sources = nativeEvidenceCatalog(payload);
    expect(payload.claims.map((claim: any) => claim.proposedAnswer)).toEqual(['Yes', 8]);
    expect(user).not.toContain('untrusted planner');
    expect(user).not.toContain('"status":"met"');
    expect(schema.properties.assessments.items.properties.sourceIds.items.enum).toEqual(payload.sources.map((source: any) => source.sourceId));
    expect(options).toEqual({ maxTokens: 2048 });
    expect(result.verification.checks).toHaveLength(2);
    expect(JSON.stringify(result.verification)).not.toContain('[[cv:');
    const judged = JSON.parse(f.generate.mock.calls[1][1]);
    expect(judged).not.toHaveProperty('sources');
    expect(judged.claims[0].proof).toMatchObject({ kind: 'primary_bundle', quotes: [expect.objectContaining({ kind: 'cv_original', quote: 'Master’s Degree in Computer Science' })] });
    expect(judged.claims[0].proof.quotes[0]).not.toHaveProperty('context');
  });

  it.each(['missing', 'duplicate', 'unknown_index', 'unknown_source', 'unsupported', 'uncertain', 'invalid_reason', 'contradiction_reason'])('fails technically closed on %s', async violation => {
    const f = fixture();
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => {
      const raw = await original(...args);
      const selection = args[0] === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT;
      if (selection && violation === 'missing') raw.assessments.pop();
      if (selection && violation === 'duplicate') raw.assessments[1] = raw.assessments[0];
      if (selection && violation === 'unknown_index') raw.assessments[0].index = 99;
      if (selection && violation === 'unknown_source') raw.assessments[0].sourceIds = ['[[profile:9999]]'];
      if (!selection && violation === 'unsupported') raw.assessments[0].verdict = 'unsupported';
      if (!selection && violation === 'uncertain') raw.assessments[0].verdict = 'uncertain';
      if (!selection && violation === 'contradiction_reason') raw.assessments[0].reason = 'contradiction';
      if (!selection && violation === 'invalid_reason') raw.assessments[0].reason = 'title_without_activity';
      return raw;
    });
    expect(await verifyNativeFormAnswers(f)).toMatchObject({ status: 'unverified', reason: 'evidence_entailment_unverified' });
    expect(f.generate).toHaveBeenCalledTimes(['missing', 'duplicate', 'unknown_index', 'unknown_source'].includes(violation) ? 1 : 2);
  });

  it('keeps a deferred verdict bound to its owned input snapshot', async () => {
    const f = fixture();
    const counter = { correction: 'Current statement' };
    const originalKey = nativeFormAssessmentHash({ ...f, unverifiedContext: counter });
    let release!: (value: any) => void;
    let payload: any;
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (system, user, schema, options) => {
      if (system !== NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) return original(system, user, schema, options);
      payload = JSON.parse(user);
      if (payload.sourceColumns) payload.sources = nativeEvidenceCatalog(payload);
      return new Promise(resolve => { release = resolve; });
    });
    const pending = verifyNativeFormAnswers({ ...f, unverifiedContext: counter });
    f.claims[0].proposedAnswer = 'No';
    f.claims[0].fieldId = 'changed-field';
    f.scope.round = 3;
    counter.correction = 'Changed while waiting';
    f.sources.evidenceCatalog().forEach(source => { source.documentHash = 'changed-source'; });
    release({ assessments: payload.claims.map((claim: any) => ({ index: claim.index,
      sourceIds: [payload.sources.find((source: any) => source.quote.includes(claim.index ? 'eight years' : 'Master’s Degree')).sourceId],
      })) });
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
    f.generate.mockImplementation(async (system, user) => {
      const payload = JSON.parse(user);
    if (payload.sourceColumns) payload.sources = nativeEvidenceCatalog(payload);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) {
        const date = payload.sources.find((source: any) => source.quote.includes('Present'));
        const role = payload.sources.find((source: any) => source.quote.includes('Software Engineer'));
        expect(date.position.block).toBe(role.position.block);
        expect(date.position.ordinal).toBe(role.position.ordinal + 1);
        return { assessments: [{ index: 0, sourceIds: [role.sourceId, date.sourceId] }] };
      }
      expect(payload.claims[0].proof.quotes.map((proof: any) => proof.quote).join(' ')).toContain('Software Engineer');
      expect(payload.claims[0].proof.quotes.every((proof: any) => !('context' in proof))).toBe(true);
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'relevant_role_or_tenure' }] };
    });
    expect((await verifyNativeFormAnswers({ ...f, sources, claims: [{ fieldId: 'tenure', nativeFormContract: { question: 'Have you worked as a software engineer for at least five years?' }, proposedAnswer: 'Yes' }] })).status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it('rejects an attested opposite actual answer before inference, ignoring printed options', async () => {
    const f = fixture();
    const record = { id: 'answer-record', key: 'question_fixture', question: { question: 'Do you need sponsorship?', options: ['Yes', 'No'] }, answer: 'Yes', category: 'work_authorization', unit: 'boolean', scope: 'job', provenance: { actor: 'candidate', round: 2, userId: 'private-user', orderId: 'private-order' } };
    const sources = qualificationSources({ sourceText: '', answerEvidence: [record] });
    const result = await verifyNativeFormAnswers({ ...f, claims: [{ fieldId: 'sponsor', nativeFormContract: { question: 'Do you need sponsorship?' }, proposedAnswer: false }], sources });
    expect(result).toMatchObject({ status: 'unverified', verification: { failure: 'actual_answer_conflict' } });
    expect(f.generate).not.toHaveBeenCalled();
    expect(sources.evidenceCatalog()[1].answerRecord.answer).toBe('Yes');
    expect(JSON.stringify(sources.evidenceCatalog())).not.toContain('private-user');
  });

  it('permits a genuinely attested negative answer to the same complete native contract', async () => {
    const f = fixture();
    const question = { question: 'Do you need sponsorship?', context: 'Work authorization', options: ['Yes', 'No'] };
    const sources = qualificationSources({ answerEvidence: [{ id: 'answer-no', question, answer: false, category: 'work_authorization', unit: 'boolean', scope: 'job', provenance: { actor: 'candidate', round: 2 } }] });
    f.generate.mockImplementation(async (system, user) => {
      const payload = JSON.parse(user);
    if (payload.sourceColumns) payload.sources = nativeEvidenceCatalog(payload);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) return { assessments: [{ index: 0, sourceIds: [payload.sources[0].sourceId] }] };
      expect(payload.claims[0].proposedAnswer).toBe(false);
      expect(payload.claims[0].proof.quotes[0].answerRecord.answer).toBe(false);
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
    });
    expect((await verifyNativeFormAnswers({ ...f, sources, claims: [{ fieldId: 'sponsor', nativeFormContract: question, proposedAnswer: false }] })).status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
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

  it.each([1, 12])('preserves all 138 short CV units within the complete input budget for %s native claims', async count => {
    const f = fixture();
    const lines = Array.from({ length: 138 }, (_, index) => `Original curriculum unit ${index} content`);
    const sources = qualificationSources({ sourceText: lines.join('\n') });
    const claims = Array.from({ length: count }, (_, index) => ({ ...f.claims[0], fieldId: `field-${index}` }));
    f.generate.mockImplementation(async (system, user, schema) => {
      expect(system.length + user.length + JSON.stringify(schema).length).toBeLessThanOrEqual(24_000);
      const payload = JSON.parse(user);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) {
        const catalog = nativeEvidenceCatalog(payload);
        expect(catalog.map(source => source.quote)).toEqual(lines);
        return { assessments: payload.claims.map((claim: any) => ({ index: claim.index, sourceIds: [catalog[0].sourceId] })) };
      }
      return { assessments: payload.claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) };
    });
    expect((await verifyNativeFormAnswers({ ...f, claims, sources })).status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['2018–Present | Software engineer specialising in Python', true],
    ['2018 – Present', false],
    ['Python engineer\n2022 – Present\n\nSQL engineer\n2010 – 2018', false],
    ['SQL engineer\n2010 – 2018\n\nPython engineer\n2022 – Present', false],
  ])('keeps complete date/role units and rejects cross-experience fragment combinations: %s', async (text, supported) => {
    const f = fixture();
    const sources = qualificationSources({ sourceText: text as string });
    const claims = [{ fieldId: 'tenure', nativeFormContract: { question: 'Have you worked as a Python engineer since 2018?' }, proposedAnswer: 'Yes' }];
    f.generate.mockImplementation(async (system, user) => {
      const payload = JSON.parse(user);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) {
        const catalog = nativeEvidenceCatalog(payload);
        const ids = catalog.length === 1 ? [catalog[0].sourceId]
          : [catalog.find(source => source.quote === 'Python engineer').sourceId, catalog.find(source => source.quote === '2010 – 2018').sourceId];
        return { assessments: [{ index: 0, sourceIds: ids }] };
      }
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'relevant_role_or_tenure' }] };
    });
    const result = await verifyNativeFormAnswers({ ...f, claims, sources });
    expect(result.status).toBe(supported ? 'supported' : 'unverified');
    expect(f.generate).toHaveBeenCalledTimes(supported ? 2 : 1);
  });


  it('owns source Q/A descriptors and catalog entries rather than relabelling a stored document hash', () => {
    const record = { question: { question: 'Do you hold a degree?' }, answer: true, category: 'qualification', unit: 'boolean', provenance: { actor: 'candidate' } };
    const sources = qualificationSources({ sourceText: 'Degree in Computer Science', answerEvidence: [record] });
    const f = { ...fixture(), sources };
    const before = nativeFormAssessmentHash(f);
    record.question.question = 'Do you want a degree after training?';
    sources.evidenceCatalog()[0].quote = 'No degree';
    expect(nativeFormAssessmentHash(f)).toBe(before);
    expect(sources.evidenceCatalog()[0].quote).toBe('Degree in Computer Science');
    expect(sources.evidenceCatalog().find(source => source.kind === 'candidate_answer').answerRecord.question.question).toBe('Do you hold a degree?');
    const catalog = sources.evidenceCatalog();
    const injected = { ...f, sources: { ...sources, evidenceCatalog: () => catalog } };
    expect(nativeFormAssessmentHash(injected)).toBe(before);
    catalog[0].quote = 'No degree';
    expect(nativeFormAssessmentHash(injected)).not.toBe(before);
  });


  it('does not demand unrelated neighboring units for a complete role/date quotation within a flattened CV block', async () => {
    const f = fixture();
    const sourceText = 'Candidate Example\n2018–Present | Software engineer specialising in Python\nEnglish C1';
    f.generate.mockImplementation(async (system, user) => {
      const payload = JSON.parse(user);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) return { assessments: [{ index: 0,
        sourceIds: [nativeEvidenceCatalog(payload).find(source => source.quote.includes('2018–Present')).sourceId] }] };
      expect(payload.claims[0].proof.quotes).toHaveLength(1);
      expect(payload.claims[0].proof.quotes[0].quote).toContain('Software engineer');
      expect(JSON.stringify(payload.claims[0].proof)).not.toContain('English C1');
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'relevant_role_or_tenure' }] };
    });
    const result = await verifyNativeFormAnswers({ ...f, claims: [{ fieldId: 'tenure', nativeFormContract: { question: 'Have you worked as a Python engineer since 2018?' }, proposedAnswer: 'Yes' }],
      sources: qualificationSources({ sourceText }) });
    expect(result.status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

});
