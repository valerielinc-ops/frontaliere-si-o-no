import { describe, expect, it, vi } from 'vitest';
import { qualificationSources, verifyQualificationEvidence, hasVerifiedQualificationEvidence,
  EVIDENCE_ENTAILMENT_VERSION, EVIDENCE_ENTAILMENT_SYSTEM_PROMPT } from '../functions/src/lib/qualificationEvidence.js';
import { qualificationEvidenceCases } from './fixtures/qualification-evidence-cases.mjs';

function fixture(cases = qualificationEvidenceCases().filter(item => item.group === 'yellowshark-positive')) {
  const sourceText = [...new Set(cases.map(item => item.evidence))].join('\n');
  const sources = qualificationSources({ sourceText });
  const requirements = { requirements: cases.map(item => ({ requirement: item.requirement, quote: item.quote, basis: 'stated', importance: 'high' })) };
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

  it('does not let a duplicate positive row bypass the document-purpose verifier', async () => {
    const f = fixture();
    const duplicate = { ...f.match, matches: [...f.match.matches, { ...f.match.matches[0], evidence: 'Unsupported second proof' }] };
    expect(await verifyQualificationEvidence({ ...f, match: duplicate, preliminary: { status: 'unverified' }, purpose: 'documents' }))
      .toMatchObject({ status: 'unverified', verification: { failure: 'invalid_match_rows' } });
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
});
