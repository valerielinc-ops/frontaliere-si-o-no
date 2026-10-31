import { describe, expect, it, vi } from 'vitest';
import { qualificationSources, qualificationSourcesFingerprint, qualificationCounterContext, qualificationCounterContextHash, verifyQualificationEvidence, hasVerifiedQualificationEvidence,
  qualificationAssessmentHash, hasVerifiedQualificationAssessment, hasCurrentQualificationDocuments, EVIDENCE_ENTAILMENT_VERSION, EVIDENCE_ENTAILMENT_SYSTEM_PROMPT } from '../functions/src/lib/qualificationEvidence.js';
import { qualificationAnswerOriginContext } from '../functions/src/lib/qualificationCounterContext.js';
import { qualificationEvidenceCases } from './fixtures/qualification-evidence-cases.mjs';

function fixture(cases = qualificationEvidenceCases().filter(item => item.group === 'yellowshark-positive')) {
  const sourceText = [...new Set(cases.map(item => item.evidence))].join('\n');
  const sources = qualificationSources({ sourceText });
  const requirements = { requirements: cases.map(item => ({ requirement: item.requirement, quote: item.quote, basis: 'stated', importance: 'high', ...(item.nativeFormContract ? { nativeFormContract: item.nativeFormContract, proposedAnswer: item.proposedAnswer } : {}) })) };
  const match = { verdict: 'good', matches: cases.map((item, index) => ({ index, status: 'met', evidence: item.evidence, evidenceUnverified: false })) };
  const rawMatch = { matches: match.matches.map(item => ({ ...item, evidence: sources.citations.excerpts.find(source => source.text === item.evidence)?.id })) };
  const generate = vi.fn(async (_system: string, user: string, _schema?: any, _options?: any) => ({ assessments: JSON.parse(user).claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) }));
  return { requirements, match, rawMatch, sources, preliminary: { status: 'compatible', gaps: [] }, generate };
}

describe('semantic evidence, separate from literal quotation authenticity', () => {
  it('makes one blind bounded call for all positive rows and stores no request-local IDs', async () => {
    const f = fixture();
    const result = await verifyQualificationEvidence(f);
    expect(result.status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(1);
    const [system, user, schema, options] = f.generate.mock.calls[0];
    expect(system).toBe(EVIDENCE_ENTAILMENT_SYSTEM_PROMPT);
    const payload = JSON.parse(user);
    expect(payload).not.toHaveProperty('profile');
    expect(payload).not.toHaveProperty('verdict');
    expect(payload.claims).toHaveLength(7);
    expect(payload.claims.every((claim: any) => !('status' in claim) && claim.proof.kind === 'cv_original')).toBe(true);
    expect(schema.properties.assessments.maxItems).toBe(7);
    expect(options).toEqual({ maxTokens: 2048 });
    expect(JSON.stringify(result.verification)).not.toContain('[[cv:');
    const cached = { ...f, result: { status: 'compatible' }, entailment: result.verification };
    expect(hasVerifiedQualificationEvidence(cached)).toBe(true);
    expect(hasVerifiedQualificationEvidence({ ...cached, entailment: undefined })).toBe(false);
    expect(hasVerifiedQualificationEvidence({ ...cached, match: { matches: [{ ...f.match.matches[0], evidence: 'Different quotation' }] } })).toBe(false);
  });

  it.each(qualificationEvidenceCases().filter(item => item.expected === 'unsupported'))('does not turn authentic but unsupported evidence into a candidate gap: $name', async item => {
    const f = fixture([item]);
    f.generate.mockImplementation(async (_system: string, user: string, _schema?: any, _options?: any) => ({ assessments: JSON.parse(user).claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'unsupported', reason: 'unrelated_evidence' })) }));
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified', reason: 'evidence_entailment_unverified' });
  });

  it('checks a nondecisive positive too, because the document writer reuses it', async () => {
    const f = fixture([qualificationEvidenceCases()[3], qualificationEvidenceCases()[2]]);
    f.requirements.requirements[1].importance = 'meaningful';
    f.generate.mockImplementation(async (_system: string, user: string, _schema?: any, _options?: any) => ({ assessments: JSON.parse(user).claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id,
      verdict: claim.index ? 'unsupported' : 'supported', reason: claim.index ? 'chronology_without_behavior' : 'explicit_fact' })) }));
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified' });
    expect(JSON.parse(f.generate.mock.calls[0][1]).claims).toHaveLength(2);
  });

  it.each(['missing', 'duplicate', 'unknown_source', 'wrong_source', 'uncertain', 'invalid_reason'])('fails closed on verifier protocol violation: %s', async violation => {
    const f = fixture(qualificationEvidenceCases().filter(item => item.group === 'yellowshark-positive').slice(0, 2));
    f.generate.mockImplementation(async (_system: string, user: string, _schema?: any, _options?: any) => {
      const rows = JSON.parse(user).claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' }));
      if (violation === 'missing') rows.pop();
      if (violation === 'duplicate') rows[1] = rows[0];
      if (violation === 'unknown_source') rows[0].proofId = '[[cv:999999]]';
      if (violation === 'wrong_source') rows[0].proofId = rows[1].proofId;
      if (violation === 'uncertain') rows[0].verdict = 'uncertain';
      if (violation === 'invalid_reason') rows[0].reason = 'unrelated_evidence';
      return { assessments: rows };
    });
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified' });
  });

  it('preserves source uncertainty on provider failure and does not retry each row', async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new Error('provider unavailable'));
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified', verification: { failure: 'judge_unavailable' } });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('spends no inference on a server-established hard shortfall', async () => {
    const f = fixture();
    expect(await verifyQualificationEvidence({ ...f, preliminary: { status: 'incompatible', gaps: [{ knownMissing: true }] } })).toEqual({ status: 'not_required' });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('verifies document claims even when a missing hard requirement or source uncertainty already prevents a proposal', async () => {
    for (const preliminary of [{ status: 'incompatible', gaps: [{ knownMissing: true }] }, { status: 'unverified', gaps: [] }]) {
      const f = fixture();
      f.generate.mockRejectedValue(new Error('judge unavailable'));
      expect(await verifyQualificationEvidence({ ...f, preliminary, purpose: 'documents' })).toMatchObject({ status: 'unverified' });
      expect(f.generate).toHaveBeenCalledTimes(1);
    }
  });

  it('binds the entire match and employer scope, with stable object-key ordering', async () => {
    const f = fixture();
    const result = await verifyQualificationEvidence(f);
    const cached = { ...f, result: { status: 'compatible' }, entailment: result.verification };
    const reordered = { ...cached, match: { matches: f.match.matches.map(row => ({ evidence: row.evidence, status: row.status, index: row.index, evidenceUnverified: row.evidenceUnverified })), verdict: f.match.verdict } };
    expect(hasVerifiedQualificationEvidence(reordered)).toBe(true);
    expect(hasVerifiedQualificationEvidence({ ...cached, match: { ...f.match, verdict: 'poor' } })).toBe(false);
    expect(hasVerifiedQualificationEvidence({ ...cached, requirements: { requirements: f.requirements.requirements.map(row => ({ ...row, quote: 'Different employer condition' })) } })).toBe(false);
  });

  it('exposes raw corrections only as unverified context and attested declarations only with full question provenance', async () => {
    const f = fixture();
    const record = { id: 'answer-de', question: { question: 'What is your current German level?' }, answer: 'A2', category: 'language', provenance: { actor: 'candidate', round: 2 } };
    const sources = qualificationSources({ sourceText: f.match.matches.map(row => row.evidence).join('\n'), answerEvidence: [record] });
    await verifyQualificationEvidence({ ...f, sources, unverifiedContext: { values: { question_unknown: 'C1' } } });
    const payload = JSON.parse(f.generate.mock.calls[0][1]);
    expect(payload.verifiedDeclarations[0]).toMatchObject({ question: record.question, answer: 'A2', provenance: { actor: 'candidate', round: 2 } });
    expect(payload.unverifiedContext.values.question_unknown).toBe('C1');
    expect(payload.claims.every((claim: any) => claim.proof.kind === 'cv_original')).toBe(true);
  });

  it('verifies a proposed form answer against its complete native question contract', async () => {
    const f = fixture([qualificationEvidenceCases()[3]]);
    const nativeFormContract = { question: 'Do you hold a university degree?', context: 'Education', section: 'Qualifications', options: ['Yes', 'No'], validation: { required: true } };
    const requirements = { requirements: [{ ...f.requirements.requirements[0], quote: nativeFormContract.question, nativeFormContract, proposedAnswer: 'Yes' }] };
    const result = await verifyQualificationEvidence({ ...f, requirements, purpose: 'documents' });
    expect(result.status).toBe('supported');
    const claim = JSON.parse(f.generate.mock.calls[0][1]).claims[0];
    expect(claim.nativeFormContract).toEqual(nativeFormContract);
    expect(claim.proposedAnswer).toBe('Yes');
    expect(hasVerifiedQualificationEvidence({ requirements: { requirements: [{ ...requirements.requirements[0], proposedAnswer: 'No' }] }, match: f.match, result: { status: 'compatible' }, entailment: result.verification })).toBe(false);
    f.generate.mockClear();
    expect(await verifyQualificationEvidence({ ...f, requirements: { requirements: [{ ...requirements.requirements[0], proposedAnswer: undefined }] }, purpose: 'documents' }))
      .toMatchObject({ status: 'unverified', verification: { failure: 'form_contract_unbound' } });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('does not let a duplicate positive row bypass the document-purpose verifier', async () => {
    const f = fixture();
    const duplicate = { ...f.match, matches: [...f.match.matches, { ...f.match.matches[0], evidence: 'Unsupported second proof' }] };
    expect(await verifyQualificationEvidence({ ...f, match: duplicate, preliminary: { status: 'unverified' }, purpose: 'documents' }))
      .toMatchObject({ status: 'unverified', verification: { failure: 'invalid_match_rows' } });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('keeps the proposal witness bound to the match judged before an asynchronous mutation', async () => {
    const f = fixture();
    const expectedHash = qualificationAssessmentHash(f.requirements, f.match);
    let release!: (value: any) => void;
    let payload: any;
    f.generate.mockImplementation(async (_system, user) => {
      payload = JSON.parse(user);
      return new Promise(resolve => { release = resolve; });
    });
    const pending = verifyQualificationEvidence(f);
    f.match.verdict = 'poor';
    f.requirements.requirements[0].quote = 'Changed employer condition';
    release({ assessments: payload.claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) });
    const result = await pending;
    expect(result).toMatchObject({ status: 'unverified', verification: { failure: 'input_changed' } });
    expect(result).not.toHaveProperty('assessment');
    expect(expectedHash).not.toBe(qualificationAssessmentHash(f.requirements, f.match));
  });

  it('never supplies a neighboring CV action as evidence for an unrelated selected quote', async () => {
    const f = fixture([qualificationEvidenceCases()[3]]);
    const sources = qualificationSources({ sourceText: 'Master’s Degree in Computer Science\nWorked as a software engineer for eight years' });
    const requirements = { requirements: [{ basis: 'stated', importance: 'high', requirement: 'Experience', quote: 'How many years have you worked as a software engineer?',
      nativeFormContract: { question: 'How many years have you worked as a software engineer?' }, proposedAnswer: 8 }] };
    const evidence = 'Master’s Degree in Computer Science';
    f.generate.mockImplementation(async (_system, user) => {
      const payload = JSON.parse(user);
      expect(payload.claims[0].proof.quote).toBe(evidence);
      expect(payload.claims[0].proof).not.toHaveProperty('context');
      expect(user).not.toContain('Worked as a software engineer for eight years');
      return { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'unsupported', reason: 'unrelated_evidence' }] };
    });
    expect((await verifyQualificationEvidence({ ...f, sources, requirements, match: { matches: [{ index: 0, status: 'met', evidence }] }, rawMatch: { matches: [] }, purpose: 'documents' })).status).toBe('unverified');
  });

  it('records a current document assessment without asserting compatibility when there are no positive claims', async () => {
    const f = fixture();
    const match = { ...f.match, matches: f.match.matches.map(row => ({ ...row, status: 'missing', evidence: '' })) };
    const result = await verifyQualificationEvidence({ ...f, match, purpose: 'documents' });
    expect(result).toMatchObject({ status: 'not_required', verification: { status: 'no_positive_claims' } });
    const assessment = { requirements: f.requirements, match, entailment: result.verification };
    expect(hasVerifiedQualificationAssessment(assessment)).toBe(true);
    expect(hasVerifiedQualificationEvidence({ ...assessment, result: { status: 'compatible' } })).toBe(false);
    expect(hasVerifiedQualificationAssessment({ ...assessment, entailment: { ...result.verification, promptHash: 'old-policy' } })).toBe(false);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('does not label a profile projection or a bare answer as original primary evidence', async () => {
    const f = fixture([qualificationEvidenceCases()[3]]);
    const projection = qualificationSources({ profile: { degree: f.match.matches[0].evidence }, answers: { question_unknown: 'Yes' } });
    expect(projection.citations.excerpts.some(source => source.text === 'Yes')).toBe(false);
    expect(await verifyQualificationEvidence({ ...f, sources: projection })).toMatchObject({ status: 'unverified' });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('keeps literal fallback ambiguous instead of choosing the first source', async () => {
    const f = fixture([qualificationEvidenceCases()[3]]);
    const quote = f.match.matches[0].evidence;
    expect(await verifyQualificationEvidence({ ...f, sources: qualificationSources({ sourceText: `${quote}\n${quote}` }), rawMatch: { matches: [] } })).toMatchObject({ status: 'unverified' });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('binds the full attested question and actual answer, never a printed option or private identity', async () => {
    const f = fixture([qualificationEvidenceCases()[3]]);
    const answer = { id: 'confirmed-answer', version: 'confirmed-question-evidence-v1', key: 'question_example',
      question: { id: 'question_example', question: 'Do you prefer an online interview?', context: 'Interview format', type: 'choice', options: ['Yes', 'No'] },
      answer: 'No', category: 'posting_specific', unit: 'boolean', scope: 'job',
      provenance: { actor: 'candidate', round: 2, userId: 'private-user', orderId: 'private-order', jobUrl: 'https://private.example.test/' } };
    const sources = qualificationSources({ sourceText: 'Candidate CV.', answerEvidence: [answer] });
    const id = sources.citations.excerpts.find(source => source.id.startsWith('[[answer_0:')).id;
    const evidence = sources.citations.resolve(id);
    const match = { matches: [{ index: 0, status: 'met', evidence, evidenceUnverified: false }] };
    f.generate.mockImplementation(async (_system: string, user: string, _schema?: any, _options?: any) => {
      const payload = JSON.parse(user); const claim = payload.claims[0];
      expect(claim.proof.answerRecord.answer).toBe('No');
      expect(user).not.toContain('private-user');
      expect(user).not.toContain('private-order');
      expect(user).not.toContain('private.example');
      return { assessments: [{ index: 0, proofId: claim.proof.id, verdict: 'unsupported', reason: 'question_scope_mismatch' }] };
    });
    expect(await verifyQualificationEvidence({ ...f, sources, match, rawMatch: { matches: [{ index: 0, evidence: id }] } })).toMatchObject({ status: 'unverified' });
    expect(qualificationSources({ sourceText: 'CV.', answerEvidence: [{ ...answer, category: 'form_preference' }] }).citations.excerpts).toHaveLength(1);
  });

  it('refuses an oversized batch without truncating its conditions or calling a provider', async () => {
    const f = fixture();
    f.requirements.requirements[0].quote = 'condition '.repeat(3_000);
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified', verification: { failure: 'input_budget' } });
    expect(f.generate).not.toHaveBeenCalled();
    expect(EVIDENCE_ENTAILMENT_VERSION).toBeTruthy();
  });

  it('never expands a posting beyond twelve adjudication rows', async () => {
    const cases = qualificationEvidenceCases();
    const f = fixture(Array.from({ length: 13 }, (_, index) => cases[index % cases.length]));
    expect(await verifyQualificationEvidence(f)).toMatchObject({ status: 'unverified', verification: { failure: 'claim_budget' } });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('binds document source freshness to the full current attested declaration including CV bytes provenance', () => {
    const record = { id: 'answer-current', version: 'confirmed-question-evidence-v1', key: 'language_de',
      question: { question: 'What is your current German level?', type: 'choice' }, answer: 'C1', category: 'language', unit: 'CEFR_or_stated_level', scope: 'candidate',
      provenance: { actor: 'candidate', round: 1, confirmedAt: new Date().toISOString(), cvHash: 'a'.repeat(64) } };
    const make = (answerEvidence = [record]) => qualificationSources({ sourceText: 'German A2 in the original CV', answerEvidence });
    const original = make();
    expect(original.verifiedDeclarations[0].provenance.cvHash).toBe(record.provenance.cvHash);
    const key = qualificationSourcesFingerprint(original);
    expect(qualificationSourcesFingerprint(make())).toBe(key);
    expect(qualificationSourcesFingerprint(make([{ ...record, answer: 'A2' }]))).not.toBe(key);
    expect(qualificationSourcesFingerprint(make([{ ...record, provenance: { ...record.provenance, cvHash: 'b'.repeat(64) } }]))).not.toBe(key);
    expect(qualificationSourcesFingerprint(make([]))).not.toBe(key);
  });


  it('binds the document witness to its exact raw counter-context before a later bootstrap', async () => {
    const f = fixture();
    const flow = { answers: {}, feedback: [] as any[], formOverrides: {} };
    const counterContext = qualificationCounterContext({ flow });
    const result = await verifyQualificationEvidence({ ...f, unverifiedContext: counterContext, purpose: 'documents' });
    const assessment = { requirements: f.requirements, match: f.match, entailment: result.verification };
    expect(result.verification.counterContextHash).toBe(qualificationCounterContextHash(counterContext));
    expect(hasVerifiedQualificationAssessment({ ...assessment, counterContext: qualificationCounterContext({ flow }) })).toBe(true);
    flow.feedback.push({ text: 'Correction: I never managed external providers; my old CV is wrong.' });
    expect(counterContext.feedback).toEqual([]);
    expect(hasVerifiedQualificationAssessment({ ...assessment, counterContext: qualificationCounterContext({ flow }) })).toBe(false);
    expect(hasVerifiedQualificationAssessment({ ...assessment, counterContext: qualificationCounterContext({ intake: { emailNotes: 'I do not hold that degree.' } }) })).toBe(false);
  });

});


describe('attested answer origin corrections', () => {
  it('invalidates a document witness when its source assertion gains a correction without exposing the origin order', async () => {
    const f = fixture();
    const origin = { orderId: 'private-origin', answerIds: ['attested-answer'], round: 1, confirmedHash: 'old', currentHash: 'old',
      changedSinceConfirmation: false, context: qualificationAnswerOriginContext({ flow: {} }) };
    const before = qualificationCounterContext({ answerCounterContext: [origin] });
    const result = await verifyQualificationEvidence({ ...f, purpose: 'documents', unverifiedContext: before });
    const cached = { requirements: f.requirements, match: f.match, entailment: result.verification };
    expect(hasVerifiedQualificationAssessment({ ...cached, counterContext: before })).toBe(true);
    const after = qualificationCounterContext({ answerCounterContext: [{ ...origin, currentHash: 'new', changedSinceConfirmation: true,
      context: qualificationAnswerOriginContext({ flow: { candidateNotes: 'Correction: the asserted qualification is not current.' } }) }] });
    expect(hasVerifiedQualificationAssessment({ ...cached, counterContext: after })).toBe(false);
    const replay = await verifyQualificationEvidence({ ...f, purpose: 'documents', unverifiedContext: after });
    expect(replay.status).toBe('supported');
    const payload = JSON.parse(f.generate.mock.calls[1][1]);
    expect(payload.unverifiedContext.answerSources[0].context.flowNotes).toContain('not current');
    expect(JSON.stringify(payload)).not.toContain('private-origin');
  });

  it('keeps derived answer-cache normalization separate from source corrections', () => {
    const before = qualificationAnswerOriginContext({ flow: { answers: { source: 'C1' }, questionAnswers: { legacy: 'C1' }, candidateNotes: 'Call after 5pm.' } });
    const after = qualificationAnswerOriginContext({ flow: { answers: { source: 'C1' }, questionAnswers: { normalized: { value: 'C1' } }, candidateNotes: 'Call after 5pm.' } });
    expect(qualificationCounterContextHash(after)).toBe(qualificationCounterContextHash(before));
    expect(qualificationCounterContextHash(qualificationAnswerOriginContext({ flow: { candidateNotes: 'Current English A2.' } }))).not.toBe(qualificationCounterContextHash(before));
  });
});


it('preserves the complete private raw correction snapshot after the runtime answer map is filtered', async () => {
  const rawCounterContext = qualificationCounterContext({ flow: { answers: { source_question: 'I never managed providers.' }, candidateNotes: 'Call after 5pm.' } });
  const safeFlow = { answers: {} };
  const current = qualificationCounterContext({ flow: safeFlow, rawCounterContext });
  expect(current.values.source_question).toBe('I never managed providers.');
  rawCounterContext.values.source_question = 'mutated later';
  expect(current.values.source_question).toBe('I never managed providers.');
  expect(() => qualificationCounterContext({ rawCounterContext: {} })).toThrow('evidence_entailment_unverified');
});


it('shares the current document witness check across server and runner transports', async () => {
  const f = fixture(); const counterContext = qualificationCounterContext({ flow: {} });
  const checked = await verifyQualificationEvidence({ ...f, purpose: 'documents', unverifiedContext: counterContext });
  const fingerprint = qualificationSourcesFingerprint(f.sources);
  const draft = { sourceCvHash: 'a'.repeat(64), qualificationSourceFingerprint: fingerprint, requirementsRaw: f.requirements, qualificationMatch: f.match, entailment: checked.verification };
  const input = { draft, sourceCvHash: draft.sourceCvHash, sourceFingerprint: fingerprint, counterContext };
  expect(hasCurrentQualificationDocuments(input)).toBe(true);
  expect(hasCurrentQualificationDocuments({ ...input, sourceCvHash: 'b'.repeat(64) })).toBe(false);
  expect(hasCurrentQualificationDocuments({ ...input, sourceFingerprint: 'b'.repeat(64) })).toBe(false);
  expect(hasCurrentQualificationDocuments({ ...input, counterContext: qualificationCounterContext({ flow: { candidateNotes: 'Current correction.' } }) })).toBe(false);
  expect(hasCurrentQualificationDocuments({ ...input, draft: { ...draft, qualificationMatch: { ...f.match, summaryIt: 'changed full match' } } })).toBe(false);
});
