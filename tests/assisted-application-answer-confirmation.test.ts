import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { answerContractRequired, answerContractsFor, localAnswerEvidence, currentAnswerReviewRequired } from '../functions/src/assistedApplicationAnswerConfirmation.js';
import { loadRunnerAnswerContext, purgeCandidateAnswerEvidence, rememberCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { candidateQuestionAnswerKey, rememberCandidateQuestionAnswers } from '../functions/src/assistedApplicationCandidateEdits.js';
vi.mock('../functions/src/assistedApplicationAutomation.js', () => ({
  flowRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('automation').doc('flow'),
  draftRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('ai_drafts').doc('current'),
}));
vi.mock('../functions/src/assistedApplicationTailoredCvPdf.js', () => ({
  tailoredCvChanges: vi.fn(() => false), rebuildTailoredCvPdf: vi.fn(), supersededPhotoPdf: () => null,
}));
const { saveAnswersWithCv } = await import('../functions/src/assistedApplicationCvCommit.js');
const pdf = await import('../functions/src/assistedApplicationTailoredCvPdf.js');
const now = Date.now(); const hash = 'a'.repeat(64);
const q = { id: 'english', question: 'What is your English proficiency level?', type: 'text' };
function fixture(question: any = q) {
  const order = { userId: 'candidate', jobId: 'source', jobUrl: 'https://example.test/source/', cvStorageKey: 'source.pdf', cvUploadedAt: now };
  const flow = { state: 'candidate_review', round: 1, answers: {}, questionAnswers: {} };
  const draft = { round: 1, cvKey: order.cvStorageKey, sourceCvHash: hash, questions: [question] };
  const f = createMemoryFirestore({ 'assisted_applications/source': order, 'assisted_applications/source/automation/flow': flow,
    'assisted_applications/source/ai_drafts/current': draft, 'user_cv_profiles/candidate': { profile: { languages: [] } } });
  const input = () => ({ db: f.db, bucket: null, orderId: 'source', order: f.read('assisted_applications/source'),
    flow: f.read('assisted_applications/source/automation/flow'), draft: f.read('assisted_applications/source/ai_drafts/current'), nowMs: now, answerActor: 'candidate' });
  return { ...f, input, save: (answers: any, extra: any = {}) => saveAnswersWithCv({ ...input(), answers, answerContracts: answerContractsFor(input()), ...extra }) };
}

describe('question confirmation protocol', () => {
  it('keeps the pending predicate safe before the first flow/draft exists', () => {
    expect(currentAnswerReviewRequired(null, null)).toBe(false);
  });
  it('keeps a different current pending question on hold, but lets withdrawn/empty question sets recover', async () => {
    const first = { ...q, id: 'first' }; const second = { id: 'second', question: 'Which value?', type: 'text' };
    const f = fixture(first); f.read('assisted_applications/source/ai_drafts/current').questions.push(second);
    await f.save({ first: 'C1', second: 'Synthetic' }, { answerContracts: {} });
    const partial = await f.save({ first: 'C1' });
    expect(partial.reviewRequired).toBe(true);
    expect(currentAnswerReviewRequired(f.input().flow, f.input().draft)).toBe(true);
    f.read('assisted_applications/source/ai_drafts/current').questions = [first];
    expect(currentAnswerReviewRequired(f.input().flow, f.input().draft)).toBe(false);
    f.read('assisted_applications/source/ai_drafts/current').questions = [];
    expect(currentAnswerReviewRequired(f.input().flow, f.input().draft)).toBe(false);
    expect(f.input().flow.answers.second).toBe('Synthetic');
  });
  it('does not claim confirmation for a supplied-hash value outside its original option catalog', async () => {
    const f = fixture({ id: 'choice', question: 'Which option?', type: 'choice', options: ['First', 'Second'] });
    await expect(f.save({ choice: 'Unlisted' })).rejects.toMatchObject({ code: 'invalid_answers', status: 400 });
    expect(f.read('assisted_applications/source/automation/flow').answers).toEqual({});
    expect(localAnswerEvidence(f.input())).toEqual([]);
  });
  it.each([101, 250])('confirms an unchanged complete native catalog of %i options, including beyond index100', async size => {
    const options = Array.from({ length: size }, (_, i) => `Country ${i}`);
    const question = { id: 'country', question: 'Country of birth', type: 'choice', options,
      originalNativeContract: { question: 'Country of birth', kind: 'select', options } };
    const f = fixture(question); const answerContracts = answerContractsFor(f.input());
    expect(answerContracts.country).toMatch(/^[a-f0-9]{64}$/);
    await f.save({ country: options[size - 1] }, { answerContracts });
    expect(localAnswerEvidence(f.input())[0].answer).toBe(options[size - 1]);
    expect(localAnswerEvidence(f.input())[0].question.originalNativeContract.options).toEqual(options);
  });
  it.each(['questionOwned', 'metadataComplete', 'ownershipUnknown', 'ownConsentQuestionOwned', 'ownConsentMetadataComplete', 'consentOwnershipUnknown'])('does not issue a hash for explicit invalid ownership %s at either level', field => {
    const metadata = { ownConsentText: ['I agree'], ownConsentQuestionLabels: ['I agree'], ownConsentLinks: [], ownConsentOwnerKey: '{"v":1,"scopes":[]}',
      ownConsentMetadataComplete: true, ownConsentQuestionOwned: true, consentOwnershipUnknown: false };
    for (const native of [false, true]) {
      const flags = { ...metadata, [field]: field.endsWith('Unknown') ? true : false };
      const question = { ...q, ...(native ? { originalNativeContract: { question: 'I agree', kind: 'checkbox', options: [], ...flags } } : flags) };
      const f = fixture(question); expect(answerContractsFor(f.input())).toEqual({});
    }
  });
  it('rechecks source deadline after an awaited PDF rebuild and never references its refused PDF', async () => {
    const f = fixture(); f.read('assisted_applications/source').cvUploadedAt = now - 90 * 86400000 + 5;
    let wall = now; const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    let finish!: (value: any) => void;
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    vi.mocked(pdf.rebuildTailoredCvPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const remove = vi.fn(async () => {}); const bucket = { file: () => ({ delete: remove }) };
    try {
      const pending = f.save({ english: 'C1' }, { bucket });
      await Promise.resolve(); wall = now + 10;
      finish({ pdfKey: 'refused.pdf', renderer: 'test', photo: null });
      await expect(pending).rejects.toMatchObject({ code: 'answer_contract_changed', status: 409 });
      expect(f.read('assisted_applications/source/automation/flow').answers).toEqual({});
      expect(f.read('assisted_applications/source/automation/flow').answerConfirmations).toBeUndefined();
      expect(f.read('assisted_applications/source/ai_drafts/current').tailoredCv).toBeUndefined();
      expect(remove).toHaveBeenCalled();
    } finally { clock.mockRestore(); vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it('binds the server hash to full original context, native ownership, order, round and CV bytes', async () => {
    const f = fixture(); const expected = answerContractsFor(f.input());
    await f.save({ english: 'C1' }, { answerContracts: expected });
    const records = localAnswerEvidence({ ...f.input(), nowMs: now });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ question: expect.objectContaining(q), answer: 'C1', contractHash: expected.english,
      provenance: { actor: 'candidate', orderId: 'source', round: 1, cvHash: hash } });
    const shared = f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence.language_en_any_proficiency;
    expect(shared.provenance).toMatchObject({ confirmationId: records[0].id, contractHash: expected.english, cvHash: hash });
  });
  it('stores legacy input provisionally, with no local/global authority or CV publication', async () => {
    const f = fixture(); const result = await f.save({ english: 'C1' }, { answerContracts: {} });
    expect(result).toMatchObject({ rebuilt: false, rawSaved: true, reviewRequired: true, answerConfirmation: { authority: false } });
    expect(f.read('assisted_applications/source/automation/flow').answers.english).toBe('C1');
    expect(localAnswerEvidence(f.input())).toEqual([]);
    expect(f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence).toBeUndefined();
  });
  it('changes only the missing-hash response when strict enforcement is enabled', async () => {
    const f = fixture(); await expect(f.save({ english: 'C1' }, { answerContracts: {}, requireAnswerContracts: true }))
      .rejects.toMatchObject({ code: 'answer_contract_required', status: 409 });
    expect(f.read('assisted_applications/source/automation/flow').answers).toEqual({});
    await expect(f.save({ english: 'C1' }, { requireAnswerContracts: true })).resolves.toMatchObject({ answerConfirmation: { authority: true } });
    expect(await answerContractRequired(async () => '')).toBe(false);
    expect(await answerContractRequired(async () => { throw Error('unavailable'); })).toBe(false);
    expect(await answerContractRequired(async () => 'true')).toBe(true);
  });
  it.each(['question', 'why', 'section', 'required', 'round', 'cv_hash'])('rejects a stale hash after changing %s before any write', async change => {
    const f = fixture(); const expected = answerContractsFor(f.input());
    const draft: any = f.read('assisted_applications/source/ai_drafts/current');
    if (change === 'round') { draft.round = 2; f.read('assisted_applications/source/automation/flow').round = 2; }
    else if (change === 'cv_hash') draft.sourceCvHash = 'b'.repeat(64);
    else draft.questions[0] = { ...q, [change]: change === 'required' ? true : 'A different requirement' };
    await expect(f.save({ english: 'C1' }, { answerContracts: expected })).rejects.toMatchObject({ code: 'answer_contract_changed' });
    expect(f.read('assisted_applications/source/automation/flow').answers).toEqual({});
  });
  it('same-ID privacy → marketing/permit redesign cannot reuse an old Yes', async () => {
    const question = { id: 'portal_agree', question: 'I agree', type: 'yes_no', originalNativeContract: {
      question: 'I agree', kind: 'checkbox', options: [], context: 'Privacy policy', required: true,
    } };
    const f = fixture(question); const contracts = answerContractsFor(f.input());
    await f.save({ portal_agree: 'Yes' });
    const draft: any = f.read('assisted_applications/source/ai_drafts/current');
    draft.questions[0].originalNativeContract.context = 'Marketing and valid work permit assertion';
    expect(localAnswerEvidence(f.input())).toEqual([]);
    await expect(f.save({ portal_agree: 'Yes' }, { answerContracts: contracts })).rejects.toMatchObject({ code: 'answer_contract_changed' });
    expect(f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence || {}).not.toHaveProperty(candidateQuestionAnswerKey(question));
  });
  it('clear removes Q/A from the local receipt and prevents a late positive save', async () => {
    const f = fixture(); await f.save({ english: 'C1' }, { nowMs: now + 1 });
    await f.save({ english: '' }, { nowMs: now + 3 });
    const clear = f.read('assisted_applications/source/automation/flow').answerConfirmations.english;
    expect(clear).toMatchObject({ cleared: true }); expect(clear).not.toHaveProperty('answer'); expect(clear).not.toHaveProperty('question');
    await expect(f.save({ english: 'C1' }, { nowMs: now + 2 })).rejects.toMatchObject({ code: 'answer_contract_changed' });
  });
});

describe('private final-send source fence', () => {
  it.each([false, 0, 'No', '0', 'Non accetto', 'Ich stimme nicht', 'Je refuse'])('retains the canonical legacy refusal %s only as a local veto', async refusal => {
    const f = fixture(); const raw = { ...f.input().flow, answers: { legacy_consent: refusal, legacy_yes: 'Yes' } };
    const context = await loadRunnerAnswerContext({ db: f.db, orderId: 'source', order: f.input().order, flow: raw, draft: f.input().draft, nowMs: now });
    expect(context.flow.answers).toEqual({ legacy_consent: refusal });
    expect(context.localAnswerEvidence).toEqual([]); expect(context.answerEvidence).toEqual([]);
    expect(raw.answers.legacy_yes).toBe('Yes');
  });
  async function executionFixture() {
    const f = fixture(); await f.save({ english: 'C1' });
    const childOrder = { ...f.input().order, jobId: 'child', jobUrl: 'https://example.test/child/', cvStorageKey: 'copy.pdf', cvUploadedAt: now + 10 };
    const childFlow = { state: 'submitting', round: 1, answers: {}, questionAnswers: {}, feedback: [] };
    const childDraft = { round: 1, cvKey: 'copy.pdf', sourceCvHash: hash, questions: [] };
    f.docs.set('assisted_applications/child', childOrder); f.docs.set('assisted_applications/child/automation/flow', childFlow);
    f.docs.set('assisted_applications/child/ai_drafts/current', childDraft);
    const context = await loadRunnerAnswerContext({ db: f.db, orderId: 'child', order: childOrder, flow: childFlow, draft: childDraft, nowMs: now + 10 });
    return { f, context };
  }
  it('accepts an unchanged source and identical CV-byte copy after confirmation', async () => {
    const { f, context } = await executionFixture();
    expect(context.answerEvidence[0].provenance.cvHash).toBe(hash);
    await expect(f.db.runTransaction((tx: any) => context.answerSourceGuard!.assertInTransaction(tx))).resolves.toBeUndefined();
    expect(JSON.stringify(context.flow)).not.toContain('assertInTransaction');
  });
  it.each(['global_pointer', 'local_no', 'local_clear', 'feedback', 'intake', 'purged_source', 'purging_source', 'owner_takeover', 'dispatch_replaced', 'draft_not_ready', 'order_candidate_notes', 'flow_candidate_notes'])('stops before a send write when %s changes', async change => {
    const { f, context } = await executionFixture();
    if (change === 'global_pointer') {
      const order = { ...f.input().order, jobId: 'newer-source', jobUrl: 'https://example.test/newer-source/' };
      const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
      const draft = { ...f.input().draft };
      f.docs.set('assisted_applications/newer-source', order);
      f.docs.set('assisted_applications/newer-source/automation/flow', flow);
      f.docs.set('assisted_applications/newer-source/ai_drafts/current', draft);
      const input = { db: f.db, bucket: null, orderId: 'newer-source', order, flow, draft, nowMs: now + 11, answerActor: 'candidate' };
      await saveAnswersWithCv({ ...input, answers: { english: 'A1' }, answerContracts: answerContractsFor(input) });
      // Old source remains valid and unchanged; only a genuine newer source replaced the global pointer.
    } else if (change === 'local_no') f.read('assisted_applications/child/automation/flow').answers = { consent: 'No' };
    else if (change === 'local_clear') f.read('assisted_applications/child/automation/flow').answers = { consent: '' };
    else if (change === 'feedback') f.read('assisted_applications/child/automation/flow').feedback = [{ round: 1, text: 'Correction' }];
    else if (change === 'intake') f.docs.set('assisted_applications/child/automation/intake', { emailNotes: 'New correction' });
    else if (change === 'purging_source') f.read('assisted_applications/source').retentionPurgingAt = now + 11;
    else if (change === 'order_candidate_notes') f.read('assisted_applications/child').candidateNotes = 'I do not hold a degree';
    else if (change === 'flow_candidate_notes') f.read('assisted_applications/child/automation/flow').candidateNotes = 'I do not hold a degree';
    else if (change === 'owner_takeover') f.read('assisted_applications/child/automation/flow').state = 'owner_takeover';
    else if (change === 'dispatch_replaced') f.read('assisted_applications/child/automation/flow').dispatch = { mode: 'draft', round: 1, requestedAt: now + 11 };
    else if (change === 'draft_not_ready') f.read('assisted_applications/child/ai_drafts/current').status = 'failed';
    else f.read('assisted_applications/source').retentionPurgedAt = now + 11;
    let clicked = false;
    await expect(f.db.runTransaction(async (tx: any) => { await context.answerSourceGuard!.assertInTransaction(tx); clicked = true; }))
      .rejects.toMatchObject({ code: 'evidence_source_changed' });
    expect(clicked).toBe(false);
  });
});

describe('one bounded selection owns raw answers and evidence', () => {
  it.each([false, true])('updates q00 after a new q80, never orphans q01, purges all source copies (legacy=%s)', async keepLegacy => {
    const f = fixture(); const order = f.input().order;
    const questions = Array.from({ length: 81 }, (_, i) => ({ id: `q${String(i).padStart(2, '0')}`, question: `How many years of experience do you have with tool${i}?`, type: 'number' }));
    const old = questions.slice(0, 80); const answers = Object.fromEntries(old.map(q => [q.id, '1']));
    const memory = rememberCandidateQuestionAnswers({ questions: old, answers });
    const evidence = rememberCandidateAnswerEvidence({ questions: old, changed: answers, orderId: 'source', order,
      flow: { round: 1 }, draft: { round: 1 }, actor: 'candidate', nowMs: now - 1 });
    f.docs.set('user_cv_profiles/candidate', { applicationQuestionAnswers: { ...memory, ...(keepLegacy ? { legacy: 'unattested' } : {}) }, applicationQuestionAnswerEvidence: evidence });
    f.docs.set('assisted_applications/source/automation/flow', { state: 'candidate_review', round: 1, answers, questionAnswers: memory });
    f.docs.set('assisted_applications/source/ai_drafts/current', { round: 1, questions: [questions[80], questions[0]] });
    await f.save({ q80: '2', q00: '2' });
    const profile = f.read('user_cv_profiles/candidate');
    expect(profile.applicationQuestionAnswers[candidateQuestionAnswerKey(questions[0])]).toBe('2');
    for (const key of Object.keys(profile.applicationQuestionAnswers)) if (key !== 'legacy') expect(profile.applicationQuestionAnswerEvidence[key]).toBeDefined();
    await purgeCandidateAnswerEvidence({ db: f.db, userId: 'candidate', orderId: 'source', nowMs: now + 1 });
    expect(f.read('user_cv_profiles/candidate').applicationQuestionAnswers).toEqual(keepLegacy ? { legacy: 'unattested' } : {});
  });
});
