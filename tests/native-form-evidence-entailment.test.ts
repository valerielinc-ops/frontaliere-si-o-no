import { createHash } from 'node:crypto';
import { nativeQualificationContext } from '../functions/src/lib/nativeQualificationContext.js';
import { describe, expect, it, vi } from 'vitest';
import { nativeEvidenceCatalog } from './helpers/nativeEvidenceCatalog';
import { nativeFormAssessmentHash, NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT, qualificationSources, originalCvLanguageProfile, nativeLanguageEvidenceConflict, verifyNativeFormAnswers } from '../functions/src/lib/qualificationEvidence.js';

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


  it.each(['changed', 'same', 'legacy', 'other_language'])('checks original CV revision conflicts for ATS-only language requirements: %s', async scenario => {
    const f = fixture();
    const sourceText = 'Languages: German A2\nDegree in computer science';
    const cvHash = scenario === 'same' ? 'a'.repeat(64) : 'b'.repeat(64);
    const record = { id: 'answer-de', key: 'language_de', question: { question: 'What is your current German level?', type: 'choice', options: ['A2', 'C1'] },
      answer: 'C1', category: 'language', unit: 'CEFR_or_stated_level', scope: 'candidate',
      provenance: { actor: 'candidate', confirmedAt: Date.now(), cvHash: 'a'.repeat(64), round: 1 } };
    const raw = originalCvLanguageProfile({ profile: { languages: [{ language: 'German', level: 'A2' }] }, cvHash, sourceText });
    const scope = { sourceCvHash: cvHash, ...(scenario === 'legacy' ? {} : { cvLanguageProfile: raw }) };
    f.generate.mockImplementation(async (system, user) => {
      const payload = JSON.parse(user);
      if (system === NATIVE_FORM_ENTAILMENT_SYSTEM_PROMPT) return { assessments: [{ index: 0,
        sourceIds: [nativeEvidenceCatalog(payload).find(source => scenario === 'other_language' ? source.quote.includes('Degree') : source.kind === 'candidate_answer').sourceId] }] };
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
    });
    const result = await verifyNativeFormAnswers({ ...f, scope, sources: qualificationSources({ sourceText, answerEvidence: [record], purpose: 'native_form' }),
      claims: [{ fieldId: 'ats-extra', nativeFormContract: { question: scenario === 'other_language' ? 'Do you hold a degree?' : 'Do you speak German at C1?', context: 'Languages' }, proposedAnswer: 'Yes' }] });
    expect(result.status).toBe(['changed', 'legacy'].includes(scenario) ? 'unverified' : 'supported');
    expect(f.generate).toHaveBeenCalledTimes(['changed', 'legacy'].includes(scenario) ? 0 : 2);
    expect(raw.profile.languages[0].level).toBe('A2');
  });

});


describe('native-only local candidate receipts', () => {
  it('uses a genuine guest receipt only for its identical native contract, order and round', async () => {
    const nativeFormContract = { question: 'Do you hold a degree?', context: 'Education', options: ['Yes', 'No'],
      optionValues: [{ label: 'Yes', value: '1' }, { label: 'No', value: '0' }] };
    const receipt = { id: 'local-degree', version: 'native-answer-confirmation-v1', category: 'local_answer', unit: 'boolean', scope: 'job',
      question: { originalNativeContract: nativeFormContract }, answer: true, provenance: { actor: 'candidate', orderId: 'guest-order', round: 1 } };
    expect(qualificationSources({ localAnswerEvidence: [receipt] }).evidenceCatalog()).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'candidate_answer' })]));
    const sources = qualificationSources({ localAnswerEvidence: [receipt], purpose: 'native_form' });
    const generate = vi.fn(async (_system: string, user: string) => {
      const payload = JSON.parse(user);
      return payload.sourceColumns ? { assessments: [{ index: 0, sourceIds: [payload.sources[0][0]] }] }
        : { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
    });
    const input = { sources, generate, scope: { orderId: 'guest-order', round: 1 }, claims: [{ fieldId: 'degree', nativeFormContract, proposedAnswer: '1' }] };
    expect((await verifyNativeFormAnswers(input)).status).toBe('supported');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(generate.mock.calls)).not.toContain('guest-order');
    expect((await verifyNativeFormAnswers({ ...input, scope: { orderId: 'other-order', round: 1 } })).status).toBe('unverified');
    expect((await verifyNativeFormAnswers({ ...input, scope: { orderId: 'guest-order', round: 2 } })).status).toBe('unverified');
    expect((await verifyNativeFormAnswers({ ...input, claims: [{ ...input.claims[0], nativeFormContract: { ...nativeFormContract, context: 'Spouse education' } }] })).status).toBe('unverified');
    expect((await verifyNativeFormAnswers({ ...input, claims: [{ ...input.claims[0], proposedAnswer: '0' }] })).status).toBe('unverified');
  });
});

describe('retained source revocation metadata', () => {
  it('holds a pertinent cleared language before inference without retaining the old answer', async () => {
    const f = fixture();
    const marker = { key: 'language_en_any_proficiency', property: 'language_proficiency', languageCode: 'en', scope: 'candidate',
      cvHash: 'a'.repeat(64), reason: 'explicit_clear', at: 1 };
    const claims = [{ fieldId: 'language', nativeFormContract: { question: 'Do you speak English at C1?', context: 'Languages' }, proposedAnswer: 'Yes' }];
    const result = await verifyNativeFormAnswers({ ...f, claims, scope: { ...f.scope, sourceCvHash: marker.cvHash, answerSourceConflicts: [marker] } });
    expect(result).toMatchObject({ status: 'unverified', verification: { failure: 'answer_source_conflict' } });
    expect(f.generate).not.toHaveBeenCalled();
    expect((await verifyNativeFormAnswers({ ...f, scope: { ...f.scope, sourceCvHash: marker.cvHash, answerSourceConflicts: [marker] } })).status).toBe('supported');
  });
});


describe('native boolean option ambiguity', () => {
  it.each([false, true])('never interprets a label/value collision as the attested boolean (%s)', async reverse => {
    for (const actual of [false, true]) {
      const optionValues = [{ label: 'Yes', value: 'No' }, { label: 'No', value: 'Yes' }];
      if (reverse) optionValues.reverse();
      const nativeFormContract = { question: 'Do you hold a degree?', optionValues };
      const receipt = { id: 'local-degree', version: 'native-answer-confirmation-v1', category: 'local_answer', unit: 'boolean', scope: 'job',
        question: { originalNativeContract: nativeFormContract }, answer: actual, provenance: { actor: 'candidate', orderId: 'guest-order', round: 1 } };
      const generate = vi.fn();
      expect((await verifyNativeFormAnswers({ sources: qualificationSources({ localAnswerEvidence: [receipt], purpose: 'native_form' }), generate,
        scope: { orderId: 'guest-order', round: 1 }, claims: [{ fieldId: 'degree', nativeFormContract, proposedAnswer: actual ? 'Yes' : 'No' }] })).status).toBe('unverified');
      expect(generate).not.toHaveBeenCalled();
    }
  });
});


it('vetoes a retained German clear for a native compound proficiency caption before either model pass', async () => {
  const generate = vi.fn();
  const marker = { key: 'language_de_any_proficiency', property: 'language_proficiency', languageCode: 'de', scope: 'candidate', cvHash: 'a'.repeat(64), reason: 'explicit_clear', at: 1 };
  const result = await verifyNativeFormAnswers({ sources: qualificationSources({ sourceText: 'Current German A2' }), generate,
    scope: { sourceCvHash: marker.cvHash, answerSourceConflicts: [marker] },
    claims: [{ fieldId: 'german', nativeFormContract: { question: 'Verfügen Sie über verhandlungssichere Deutschkenntnisse?' }, proposedAnswer: 'Nein' }] });
  expect(result).toMatchObject({ status: 'unverified', verification: { failure: 'answer_source_conflict' } });
  expect(generate).not.toHaveBeenCalled();
});


describe('actual CV bytes versus previously attested language answers', () => {
  it.each(['portable', 'local', 'unknown_bytes'])('holds %s before selection when the original CV is no longer bound', async mode => {
    const bytesA = Buffer.from('Original synthetic CV A');
    const bytesB = Buffer.from('Replacement synthetic CV B');
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const oldHash = sha(bytesA);
    const originalNativeContract = { question: 'Do you speak English at C1?', kind: 'text', controlType: 'text', options: [] };
    const portable = { id: 'answer-language', version: 'confirmed-question-evidence-v1', key: 'language_en_any_proficiency',
      question: { question: 'What is your current English proficiency level?', type: 'text' }, answer: 'C1', category: 'language',
      scope: 'candidate', unit: 'CEFR_or_stated_level', provenance: { actor: 'candidate', round: 1, confirmedAt: Date.now(), cvHash: oldHash } };
    const local = { id: 'local-language', version: 'native-answer-confirmation-v1', category: 'local_answer', scope: 'job', unit: 'boolean',
      question: { originalNativeContract }, answer: true, provenance: { actor: 'candidate', orderId: 'fixture-order', round: 1, confirmedAt: Date.now(), cvHash: oldHash } };
    const record = mode === 'local' ? local : portable;
    const context = nativeQualificationContext({ orderId: 'fixture-order', order: { cvStorageKey: 'same-key.pdf' },
      draft: { round: 1, cvKey: 'same-key.pdf', sourceCvHash: oldHash, factSources: { text: 'English A2' } },
      cvBuffer: mode === 'unknown_bytes' ? undefined : bytesB,
      answerEvidence: mode === 'local' ? [] : [portable], localAnswerEvidence: mode === 'local' ? [local] : [] });
    const claim = { fieldId: 'language', nativeFormContract: mode === 'local' ? originalNativeContract
      : { question: portable.question.question, kind: 'text', controlType: 'text', options: [] }, proposedAnswer: mode === 'local' ? true : 'C1' };
    expect(context.scope.sourceCvHash).toBe(mode === 'unknown_bytes' ? null : sha(bytesB));
    expect(context.scope.sourceUnbound).toBe(true);
    expect(context.documentsCurrent).toBe(false);
    expect(context.sources.evidenceCatalog().some(source => source.kind === 'cv_original')).toBe(false);
    expect(nativeLanguageEvidenceConflict({ claim, record, scope: context.scope, sources: context.sources })).toBe(true);
    const generate = vi.fn();
    expect(await verifyNativeFormAnswers({ claims: [claim], sources: context.sources, scope: context.scope,
      unverifiedContext: context.unverifiedContext, generate })).toMatchObject({ status: 'unverified', verification: { failure: 'language_revision_unverified' } });
    expect(generate).not.toHaveBeenCalled();
  });
});
