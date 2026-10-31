import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { answerContractRequired, answerContractsFor, localAnswerEvidence, currentAnswerReviewRequired } from '../functions/src/assistedApplicationAnswerConfirmation.js';
import { loadCandidateAnswerEvidence, loadRunnerAnswerContext, purgeCandidateAnswerEvidence, rememberCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { candidateQuestionAnswerKey, rememberCandidateQuestionAnswers } from '../functions/src/assistedApplicationCandidateEdits.js';
vi.mock('../functions/src/assistedApplicationAutomation.js', () => ({
  flowRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('automation').doc('flow'),
  draftRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('ai_drafts').doc('current'),
}));
vi.mock('../functions/src/assistedApplicationTailoredCvPdf.js', () => ({
  tailoredCvChanges: vi.fn(() => false), rebuildTailoredCvPdf: vi.fn(), supersededPhotoPdf: () => null,
}));
const { saveAnswersWithCv, commitRebuild } = await import('../functions/src/assistedApplicationCvCommit.js');
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
  it.each(['question', 'native'])('rejects explicit empty address ownership in the %s contract while keeping missing metadata compatible', async location => {
    const question: any = { ...q };
    const f = fixture(question); expect(answerContractsFor(f.input()).english).toMatch(/^[a-f0-9]{64}$/);
    const owned = { section: 'Candidate contact', owners: [], unknown: false };
    if (location === 'question') f.input().draft.questions[0].addressContext = owned;
    else f.input().draft.questions[0].originalNativeContract = { question: q.question, kind: 'text', options: [], addressContext: owned };
    await f.save({ english: 'C1' }); const contracts = answerContractsFor(f.input());
    expect(localAnswerEvidence(f.input())).toHaveLength(1);
    const target = location === 'question' ? f.input().draft.questions[0] : f.input().draft.questions[0].originalNativeContract;
    for (const empty of [{ section: '', owners: [], unknown: false }, { section: ' ', owners: ['\t'], unknown: false }]) {
      target.addressContext = empty;
      expect(answerContractsFor(f.input())).toEqual({});
      expect(localAnswerEvidence(f.input())).toEqual([]);
      await expect(f.save({ english: 'C1' }, { answerContracts: contracts })).rejects.toMatchObject({ code: 'answer_contract_changed' });
    }
  });
  it.each([{ state: 'sent', channel: 'portal' }, { state: 'sending', channel: 'portal', clickedAt: now }, { state: 'sending', channel: 'email' }])('refuses answer writes for any irreversible round: %j', async record => {
    const f = fixture(); f.docs.set('assisted_applications/source/automation/submission', { r3: record });
    await expect(f.save({ english: 'C1' })).rejects.toMatchObject({ status: 409 });
    expect(f.input().flow.answers).toEqual({}); expect(f.input().flow.answerConfirmations).toBeUndefined();
    await expect(commitRebuild({ db: f.db, bucket: null, orderId: 'source', flow: f.input().flow, draft: f.input().draft,
      draftPatch: { forbidden: true }, nowMs: now })).rejects.toMatchObject({ status: 409, details: { state: 'candidate_review' } });
    expect(f.input().draft.forbidden).toBeUndefined();
  });
  it('refuses a send that becomes irreversible during the answer PDF await and cleans only the new PDF', async () => {
    const f = fixture(); let finish!: (value: any) => void; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    vi.mocked(pdf.rebuildTailoredCvPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; enter(); }));
    const remove = vi.fn(async () => {});
    try {
      const pending = f.save({ english: 'C1' }, { bucket: { file: () => ({ delete: remove }) } });
      await entered; f.docs.set('assisted_applications/source/automation/submission', { r1: { state: 'sent', channel: 'portal' } });
      finish({ pdfKey: 'refused-sent.pdf', renderer: 'test', photo: null });
      await expect(pending).rejects.toMatchObject({ code: 'already_sent', status: 409, details: { state: 'submitted' } });
      expect(f.input().flow.answers).toEqual({}); expect(f.input().flow.answerConfirmations).toBeUndefined();
      expect(remove).toHaveBeenCalled();
    } finally { vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it('refuses answers on a submitted flow without any ledger, for the candidate and the owner, and writes nothing', async () => {
    for (const answerActor of ['candidate', 'owner']) {
      const f = fixture(); const flowPath = 'assisted_applications/source/automation/flow';
      f.read(flowPath).state = 'submitted';
      vi.mocked(pdf.rebuildTailoredCvPdf).mockClear(); const before = JSON.stringify([...f.docs]);
      await expect(f.save({ english: 'C1' }, { answerActor })).rejects.toMatchObject({ code: 'already_sent', status: 409, details: { state: 'submitted' } });
      expect(JSON.stringify([...f.docs])).toBe(before);
      expect(pdf.rebuildTailoredCvPdf).not.toHaveBeenCalled();
    }
  });
  it('refuses a stale request whose flow became submitted before it reached the writer', async () => {
    const f = fixture(); const stale = f.input(); const flowPath = 'assisted_applications/source/automation/flow';
    const shown = answerContractsFor(stale);
    const flow = structuredClone(stale.flow);
    f.docs.set(flowPath, { ...f.read(flowPath), state: 'submitted' });
    const before = JSON.stringify([...f.docs]);
    await expect(saveAnswersWithCv({ ...stale, flow, answers: { english: 'C1' }, answerContracts: shown })).rejects.toMatchObject({ code: 'already_sent', status: 409 });
    expect(JSON.stringify([...f.docs])).toBe(before);
  });
  it('does not publish answers or the rebuilt PDF when the flow becomes submitted during the PDF await', async () => {
    const f = fixture(); let finish!: (value: any) => void; let enter!: () => void;
    const flowPath = 'assisted_applications/source/automation/flow';
    const entered = new Promise<void>(resolve => { enter = resolve; });
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    vi.mocked(pdf.rebuildTailoredCvPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; enter(); }));
    const remove = vi.fn(async () => {});
    try {
      const pending = f.save({ english: 'C1' }, { bucket: { file: () => ({ delete: remove }) } });
      await entered;
      f.docs.set(flowPath, { ...f.read(flowPath), state: 'submitted' });
      const before = JSON.stringify([...f.docs]);
      finish({ pdfKey: 'refused-submitted.pdf', renderer: 'test', photo: null });
      // The field comparison alone would say changed_meanwhile: this is the commit's own refusal.
      await expect(pending).rejects.toMatchObject({ code: 'already_sent', status: 409 });
      expect(JSON.stringify([...f.docs])).toBe(before);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally { vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it.each(['candidate_review', 'needs_candidate_action'])('keeps saving answers and rebuilding the PDF in %s', async state => {
    const f = fixture(); f.read('assisted_applications/source/automation/flow').state = state;
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    vi.mocked(pdf.rebuildTailoredCvPdf).mockReset();
    vi.mocked(pdf.rebuildTailoredCvPdf).mockResolvedValue({ pdfKey: 'new.pdf', renderer: 'test', photo: null } as any);
    try {
      await expect(f.save({ english: 'C1' }, { bucket: { file: () => ({ delete: async () => {} }) } })).resolves.toMatchObject({ rebuilt: true });
      expect(f.input().flow.answers).toEqual({ english: 'C1' });
      expect(f.input().draft.tailoredCv).toMatchObject({ pdfKey: 'new.pdf' });
    } finally { vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it('keeps saving answers on a failed flow, whose PDF stays the record of what left', async () => {
    const f = fixture(); f.read('assisted_applications/source/automation/flow').state = 'failed';
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    vi.mocked(pdf.rebuildTailoredCvPdf).mockClear();
    try {
      await expect(f.save({ english: 'C1' })).resolves.toMatchObject({ rebuilt: false });
      expect(f.input().flow.answers).toEqual({ english: 'C1' });
      expect(f.input().flow.state).toBe('failed');
      expect(pdf.rebuildTailoredCvPdf).not.toHaveBeenCalled();
    } finally { vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it('allows recovery after a failed ledger even with stale sentAttempt/queue legacy payload', async () => {
    const f = fixture(); f.docs.set('assisted_applications/source/automation/submission', { r1: { state: 'failed', clickedAt: now } });
    Object.assign(f.input().order, { submissionStatus: 'ready_for_manual_submission', submittedAt: now });
    f.input().draft.sentAttempt = { at: now };
    await expect(f.save({ english: 'C1' })).resolves.toMatchObject({ answerConfirmation: { authority: true } });
  });
  it.each(['expired', 'purging'])('does not publish photo/CV/edit rebuilds while the source is %s', async reason => {
    const f = fixture();
    if (reason === 'expired') f.read('assisted_applications/source').cvUploadedAt = now - 90 * 86400000 - 1;
    else f.read('assisted_applications/source').retentionPurgingAt = now;
    const remove = vi.fn(async () => {});
    await expect(commitRebuild({ db: f.db, bucket: { file: () => ({ delete: remove }) }, orderId: 'source',
      flow: f.input().flow, draft: f.input().draft, created: ['new-private.pdf'], draftPatch: { tailoredCv: { pdfKey: 'new-private.pdf' } }, nowMs: now }))
      .rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });
    expect(f.read('assisted_applications/source/ai_drafts/current').tailoredCv).toBeUndefined();
    expect(remove).toHaveBeenCalled();
  });
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
  it.each(['intake', 'order_note'])('refuses a correction changed in %s between pre-read and deferred answer commit', async change => {
    const f = fixture(); let finish!: (value: any) => void;
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    let entered!: () => void; const rebuilding = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(pdf.rebuildTailoredCvPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; entered(); }));
    const remove = vi.fn(async () => {});
    try {
      const pending = f.save({ english: 'C1' }, { bucket: { file: () => ({ delete: remove }) } });
      await rebuilding;
      if (change === 'intake') f.docs.set('assisted_applications/source/automation/intake', { emailNotes: 'Current A2' });
      else f.read('assisted_applications/source').candidateNotes = 'Current A2';
      finish({ pdfKey: 'refused-counter.pdf', renderer: 'test', photo: null });
      await expect(pending).rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });
      expect(f.read('assisted_applications/source/automation/flow').answers).toEqual({});
      expect(f.read('assisted_applications/source/automation/flow').answerConfirmations).toBeUndefined();
      expect(f.read('assisted_applications/source/ai_drafts/current').tailoredCv).toBeUndefined();
      expect(remove).toHaveBeenCalled();
    } finally { vi.mocked(pdf.tailoredCvChanges).mockReturnValue(false); }
  });
  it('rechecks source deadline after an awaited PDF rebuild and never references its refused PDF', async () => {
    const f = fixture(); f.read('assisted_applications/source').cvUploadedAt = now - 90 * 86400000 + 5;
    let wall = now; const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    let finish!: (value: any) => void;
    vi.mocked(pdf.tailoredCvChanges).mockReturnValue(true);
    let entered!: () => void; const rebuilding = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(pdf.rebuildTailoredCvPdf).mockImplementation(() => new Promise(resolve => { finish = resolve; entered(); }));
    const remove = vi.fn(async () => {}); const bucket = { file: () => ({ delete: remove }) };
    try {
      const pending = f.save({ english: 'C1' }, { bucket });
      await rebuilding; wall = now + 10;
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
    const clock = f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence[candidateQuestionAnswerKey(question)];
    expect(clock).toMatchObject({ cleared: true });
    expect(clock).not.toHaveProperty('question'); expect(clock).not.toHaveProperty('answer');
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
  it.each(['clear', 'raw_changed', 'question_changed', 'round_changed'])('returns only property conflict metadata for a known assertion after %s', async change => {
    const f = fixture(); await f.save({ english: 'C1' });
    if (change === 'clear') await f.save({ english: '' }, { nowMs: now + 1 });
    if (change === 'raw_changed') f.read('assisted_applications/source/automation/flow').answers.english = 'A2';
    if (change === 'question_changed') f.read('assisted_applications/source/ai_drafts/current').questions[0].question = 'A different current question';
    if (change === 'round_changed') f.read('assisted_applications/source/automation/flow').round = 2;
    const load = await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 2 });
    const context = load({ id: 'child', url: 'https://example.test/child/' });
    expect(context.answerEvidence).toEqual([]);
    expect(context.answerSourceConflicts).toEqual([expect.objectContaining({ key: 'language_en_any_proficiency', property: 'language_proficiency', languageCode: 'en', scope: 'candidate', cvHash: hash })]);
    expect(JSON.stringify(context.answerSourceConflicts)).not.toContain('C1');
    expect(JSON.stringify(context.answerSourceConflicts)).not.toContain(q.question);
    f.read('assisted_applications/source').retentionPurgingAt = now + 3;
    const purging = await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 4 });
    expect(purging({ id: 'child', url: 'https://example.test/child/' }).answerSourceConflicts).toEqual([]);
  });
  it('lets a newer full native confirmation resolve an obsolete localized key for the same current property', async () => {
    const options = ['Yes', 'No'];
    const question: any = { id: 'pmp', question: 'Do you hold the PMP certification?', type: 'choice', options,
      applicationOptions: options, optionMap: options.map(value => ({ candidate: value, application: value })),
      originalNativeContract: { question: 'Do you hold the PMP certification?', kind: 'select', options } };
    const f = fixture(question); await f.save({ pmp: 'Yes' });
    const current = f.input().draft.questions[0];
    current.options = ['Oui', 'Non']; current.optionMap = [{ candidate: 'Oui', application: 'Yes' }, { candidate: 'Non', application: 'No' }];
    await f.save({ pmp: 'Oui' }, { nowMs: now + 2 });
    const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 3 });
    expect(context.answerEvidence).toEqual([expect.objectContaining({ answer: 'Oui', category: 'qualification', scope: 'job' })]);
    expect(context.answerSourceConflicts).toEqual([]);
  });
  it('keeps a German clear when a newer English declaration is confirmed, then resolves only a new German confirmation', async () => {
    const f = fixture({ id: 'german', question: 'What is your German proficiency level?', type: 'text' });
    const english = { id: 'english', question: 'What is your English proficiency level?', type: 'text' };
    f.input().draft.questions.push(english);
    await f.save({ german: 'C1' }); await f.save({ german: '' }, { nowMs: now + 1 });
    await f.save({ english: 'C1' }, { nowMs: now + 2 });
    const load = async () => (await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 5 }))({ id: 'child', url: 'https://example.test/child/' });
    expect((await load()).answerSourceConflicts).toContainEqual(expect.objectContaining({ languageCode: 'de', property: 'language_proficiency' }));
    await f.save({ german: 'C1' }, { nowMs: now + 4 });
    expect((await load()).answerSourceConflicts).toEqual([]);
  });
  it('does not resolve uncertainty about a different native credential with a newer unrelated answer', async () => {
    const options = ['Yes', 'No'];
    const native = { question: 'Do you hold the PMP certification?', kind: 'select', options };
    const f = fixture({ id: 'credential', question: native.question, type: 'choice', options, originalNativeContract: native });
    await f.save({ credential: 'Yes' });
    const current = f.input().draft.questions[0]; current.question = 'Do you hold the CISSP certification?';
    current.originalNativeContract.question = current.question;
    await f.save({ credential: 'Yes' }, { nowMs: now + 2 });
    const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 3 });
    expect(context.answerSourceConflicts).toHaveLength(1); expect(JSON.stringify(context.answerSourceConflicts)).not.toContain('PMP');
  });
  it.each(['guest', 'profile_missing'])('uses a confirmed local qualification without an account mirror (%s), then revokes it on clear', async mode => {
    const f = fixture();
    if (mode === 'guest') delete f.read('assisted_applications/source').userId;
    else f.docs.delete('user_cv_profiles/candidate');
    await f.save({ english: 'C1' });
    const current = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 1 });
    expect(current.answerEvidence).toEqual([expect.objectContaining({ answer: 'C1', category: 'language', unit: 'CEFR_or_stated_level', provenance: { ...f.input().flow.answerConfirmations.english.provenance, confirmationId: f.input().flow.answerConfirmations.english.id, contractHash: f.input().flow.answerConfirmations.english.contractHash } })]);
    await f.save({ english: '' }, { nowMs: now + 2 });
    const cleared = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 3 });
    expect(cleared.answerEvidence).toEqual([]);
    expect(cleared.answerSourceConflicts).toEqual([expect.objectContaining({ property: 'language_proficiency', languageCode: 'en', scope: 'job', cvHash: hash })]);
    expect(JSON.stringify(cleared.answerSourceConflicts)).not.toContain('C1');
    await f.save({ english: 'A2' }, { nowMs: now + 4 });
    const replaced = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 5 });
    expect(replaced.answerEvidence[0].answer).toBe('A2'); expect(replaced.answerSourceConflicts).toEqual([]);
  });
  it.each([
    [{ id: 'privacy', question: 'Do you accept the privacy policy?', type: 'yes_no' }, 'Yes', null],
    [{ id: 'salary', question: 'What is your requested salary in CHF per year?', type: 'number' }, '80000', 'form_preference'],
    [{ id: 'notice', question: 'What is your notice period in months?', type: 'number', source: 'policy_default' }, '3', null],
    [{ id: 'certificate', question: 'Do you hold the PMP certification?', type: 'yes_no' }, 'No', 'qualification'],
  ])('does not widen a local receipt into an arbitrary candidate fact: %j', async (question: any, answer: any, category: any) => {
    const f = fixture(question); delete f.read('assisted_applications/source').userId;
    await f.save({ [question.id]: answer });
    const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 1 });
    if (category) expect(context.answerEvidence[0]).toMatchObject({ answer, category, scope: 'job', unit: category === 'form_preference' ? 'question_specific_number' : 'boolean' });
    else expect(context.answerEvidence).toEqual([]);
    expect(context.localAnswerEvidence).toHaveLength(1);
  });
  it('does not restart the retention clock after an awaited profile/source load', async () => {
    const f = fixture(); await f.save({ english: 'C1' });
    f.read('assisted_applications/source').cvUploadedAt = now - 90 * 86400000 + 5;
    let wall = now; const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const collection = f.db.collection.bind(f.db);
    vi.spyOn(f.db, 'collection').mockImplementation((name: string) => {
      const result = collection(name); if (name !== 'user_cv_profiles') return result;
      const doc = result.doc.bind(result);
      return { ...result, doc: (id: string) => { const ref = doc(id); const get = ref.get.bind(ref);
        return { ...ref, get: async () => { const snapshot = await get(); wall = now + 10; return snapshot; } }; } };
    });
    try {
      const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now });
      expect(context.answerEvidence).toEqual([]); expect(context.localAnswerEvidence).toEqual([]);
      await expect(f.db.runTransaction(tx => context.answerSourceGuard.assertInTransaction(tx))).rejects.toMatchObject({ code: 'evidence_source_changed' });
    } finally { clock.mockRestore(); }
  });
  it('excludes all answer-derived channels after the canonical payload purge tombstone', async () => {
    const f = fixture(); await f.save({ english: 'C1' });
    f.read('assisted_applications/source').retentionPayloadPurgedAt = now + 1;
    const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 2 });
    expect(context.localAnswerEvidence).toEqual([]); expect(context.answerEvidence).toEqual([]); expect(context.answerSourceConflicts).toEqual([]);
    await expect(f.save({ english: 'C1' }, { nowMs: now + 3 })).rejects.toMatchObject({ status: 409 });
  });
  it.each(['retentionPurgingAt', 'retentionPurgedAt'])('drops all answer-derived channels after source flow %s', async flag => {
    const f = fixture(); await f.save({ english: 'C1' });
    f.read('assisted_applications/source/automation/flow')[flag] = now + 1;
    const context = await loadRunnerAnswerContext({ ...f.input(), nowMs: now + 2 });
    expect(context.localAnswerEvidence).toEqual([]); expect(context.answerEvidence).toEqual([]);
    expect(context.answerSourceConflicts).toEqual([]);
  });
  it('does not fence a child on an expired source that contributes no answer or conflict', async () => {
    const f = fixture(); await f.save({ english: 'C1' });
    f.read('assisted_applications/source').cvUploadedAt = now - 90 * 86400000 - 1;
    const order = { ...f.input().order, jobId: 'child', jobUrl: 'https://example.test/child/', cvStorageKey: 'copy.pdf', cvUploadedAt: now };
    const flow = { state: 'submitting', round: 1, answers: {}, questionAnswers: {} };
    const draft = { round: 1, status: 'ready', questions: [], cvKey: 'copy.pdf', sourceCvHash: hash };
    f.docs.set('assisted_applications/child', order); f.docs.set('assisted_applications/child/automation/flow', flow);
    f.docs.set('assisted_applications/child/ai_drafts/current', draft);
    const context = await loadRunnerAnswerContext({ db: f.db, orderId: 'child', order, flow, draft, nowMs: now + 1 });
    expect(context.answerEvidence).toEqual([]); expect(context.answerSourceConflicts).toEqual([]);
    const loaded = (await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 1 }))(order);
    expect(loaded.rawCounterAnswers).toEqual({}); expect(loaded.sourceOrderIds).toEqual([]);
    await expect(f.db.runTransaction(tx => context.answerSourceGuard.assertInTransaction(tx))).resolves.toBeUndefined();
  });
  it.each(['order_note', 'flow_note', 'feedback', 'correction', 'intake'])('keeps the historical assertion and fingerprints current origin %s before bootstrap', async change => {
    const f = fixture(); await f.save({ english: 'C1' });
    const load = async () => (await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 10 }))({ id: 'child', url: 'https://example.test/child/' });
    const before = await load(); expect(before.answerCounterContext[0].changedSinceConfirmation).toBe(false);
    const correction = 'Correction: my current English is A2. ' + 'Full original note. '.repeat(30);
    if (change === 'order_note') f.read('assisted_applications/source').candidateNotes = correction;
    if (change === 'flow_note') f.read('assisted_applications/source/automation/flow').candidateNotes = correction;
    if (change === 'feedback') f.read('assisted_applications/source/automation/flow').feedback = [{ round: 1, text: correction }];
    if (change === 'correction') f.read('assisted_applications/source/automation/flow').formOverrides = { other: correction };
    if (change === 'intake') f.docs.set('assisted_applications/source/automation/intake', { emailNotes: correction });
    const current = await load();
    expect(current.answerEvidence[0].answer).toBe('C1'); // Never silently fall back to old CV A2 / knownMissing.
    expect(current.answerCounterContext[0]).toMatchObject({ answerIds: [current.answerEvidence[0].id], changedSinceConfirmation: true });
    expect(JSON.stringify(current.answerCounterContext[0].context)).toContain(correction);
    expect(current.fingerprint).not.toBe(before.fingerprint);
    await f.save({ english: 'C1' }, { nowMs: now + 20 });
    const confirmed = await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 21 });
    expect(confirmed({ id: 'child', url: 'https://example.test/child/' }).answerCounterContext[0].changedSinceConfirmation).toBe(false);
  });
  it.each([false, 0, 'No', '0', 'Non accetto', 'Ich stimme nicht', 'Je refuse'])('retains the canonical legacy refusal %s only as a local veto', async refusal => {
    const f = fixture(); const raw = { ...f.input().flow, answers: { legacy_consent: refusal, legacy_yes: 'Yes' } };
    const context = await loadRunnerAnswerContext({ db: f.db, orderId: 'source', order: f.input().order, flow: raw, draft: f.input().draft, nowMs: now });
    expect(context.flow.answers).toEqual({ legacy_consent: refusal });
    expect(context.localAnswerEvidence).toEqual([]); expect(context.answerEvidence).toEqual([]);
    expect(raw.answers.legacy_yes).toBe('Yes');
  });
  it.each(['native_contract', 'file_choice_receipt'])('fences the current attachment purpose binding: %s', async change => {
    const { f, context } = await executionFixture({ requiredDocuments: [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true,
      originalNativeContract: { question: 'Diploma for this employer', kind: 'file', options: [] } }],
      documents: { diploma: { files: [{ key: 'assisted-application-uploads/child/diploma.pdf', detectedType: 'pdf', confirmationId: 'source-file-choice' }] } } });
    if (change === 'native_contract') f.read('assisted_applications/child/ai_drafts/current').requiredDocuments[0].originalNativeContract.question = 'A different diploma';
    else f.read('assisted_applications/child/automation/flow').documents.diploma.files[0].confirmationId = 'changed-file-choice';
    await expect(f.db.runTransaction(tx => context.answerSourceGuard.assertInTransaction(tx))).rejects.toMatchObject({ code: 'evidence_source_changed' });
  });
  async function executionFixture(material: any = {}) {
    const f = fixture(); await f.save({ english: 'C1' });
    const childOrder = { ...f.input().order, jobId: 'child', jobUrl: 'https://example.test/child/', cvStorageKey: 'copy.pdf', cvUploadedAt: now + 10 };
    const childFlow = { state: 'submitting', round: 1, answers: {}, questionAnswers: {}, feedback: [], documents: material.documents || {} };
    const childDraft = { round: 1, cvKey: 'copy.pdf', sourceCvHash: hash, questions: [], requiredDocuments: material.requiredDocuments || [] };
    f.docs.set('assisted_applications/child', childOrder); f.docs.set('assisted_applications/child/automation/flow', childFlow);
    f.docs.set('assisted_applications/child/ai_drafts/current', childDraft);
    const context = await loadRunnerAnswerContext({ db: f.db, orderId: 'child', order: childOrder, flow: childFlow, draft: childDraft, nowMs: now + 10 });
    return { f, context };
  }
  it('lets an origin finish normally without revoking an unchanged shared fact or the child approval', async () => {
    const { f, context } = await executionFixture();
    f.read('assisted_applications/source').submissionStatus = 'ready_for_manual_submission';
    f.read('assisted_applications/source').submittedAt = now + 11;
    f.read('assisted_applications/source/automation/flow').state = 'submitted';
    f.read('assisted_applications/source/automation/flow').questionAnswers = { cache_other: 'derived cached value' };
    f.read('assisted_applications/source/automation/flow').dispatch = { mode: 'submit', round: 1, requestedAt: now + 11 };
    f.read('assisted_applications/source/ai_drafts/current').status = 'submitted';
    f.read('assisted_applications/source/ai_drafts/current').questions.push({ id: 'other', question: 'Unrelated later question', type: 'text' });
    await expect(f.db.runTransaction((tx: any) => context.answerSourceGuard!.assertInTransaction(tx))).resolves.toBeUndefined();
  });
  it('accepts an unchanged source and identical CV-byte copy after confirmation', async () => {
    const { f, context } = await executionFixture();
    expect(context.answerEvidence[0].provenance.cvHash).toBe(hash);
    await expect(f.db.runTransaction((tx: any) => context.answerSourceGuard!.assertInTransaction(tx))).resolves.toBeUndefined();
    expect(JSON.stringify(context.flow)).not.toContain('assertInTransaction');
  });
  it.each(['global_pointer', 'local_no', 'local_clear', 'feedback', 'intake', 'purged_source', 'purging_source', 'owner_takeover', 'dispatch_replaced', 'draft_not_ready', 'order_candidate_notes', 'flow_candidate_notes', 'cv_language_baseline', 'identity', 'profile', 'letter_key', 'cv_key', 'required_document', 'mandate_version', 'mandate_timestamp', 'payment', 'withdrawal'])('stops before a send write when %s changes', async change => {
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
    else if (change === 'mandate_version') f.read('assisted_applications/child').consentVersion = 'unsupported';
    else if (change === 'mandate_timestamp') f.read('assisted_applications/child').consentedAt = now + 11;
    else if (change === 'payment') f.read('assisted_applications/child').paymentStatus = 'refunded';
    else if (change === 'withdrawal') f.read('assisted_applications/child').withdrawnAt = now + 11;
    else if (change === 'identity') f.read('assisted_applications/child').applicantName = 'Corrected candidate';
    else if (change === 'profile') f.read('assisted_applications/child/ai_drafts/current').profile = { nationality: 'italiana' };
    else if (change === 'letter_key') f.read('assisted_applications/child/ai_drafts/current').coverLetterPdfKey = 'changed-letter.pdf';
    else if (change === 'cv_key') f.read('assisted_applications/child/ai_drafts/current').tailoredCv = { status: 'ready', pdfKey: 'changed-cv.pdf' };
    else if (change === 'required_document') f.read('assisted_applications/child/ai_drafts/current').requiredDocuments = [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true }];
    else if (change === 'cv_language_baseline') f.read('assisted_applications/child/ai_drafts/current').qualificationCvLanguageProfile = { version: 'cv-language-profile-v1', purpose: 'conflict_only', cvHash: hash, profile: { languages: [{ language: 'en', level: 'A2' }] } };
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

describe('proposal publication uses the same source fact fence without child send authority', () => {
  it.each(['unchanged', 'source_finished', 'global_pointer', 'source_counter', 'clear', 'purge'])('checks %s in the publication transaction', async change => {
    const f = fixture(); await f.save({ english: 'C1' });
    const contextFor = await loadCandidateAnswerEvidence({ db: f.db, profileRecord: f.read('user_cv_profiles/candidate'), userId: 'candidate', nowMs: now + 1 });
    const context = contextFor({ id: 'new-job', url: 'https://example.test/new-job/' });
    expect(context.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (change === 'global_pointer') f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence = {};
    if (change === 'source_counter') f.input().order.candidateNotes = 'A new source correction';
    if (change === 'clear') await f.save({ english: '' }, { nowMs: now + 2 });
    if (change === 'purge') f.input().order.retentionPurgingAt = now + 2;
    if (change === 'source_finished') {
      Object.assign(f.input().order, { submissionStatus: 'ready_for_manual_submission', submittedAt: now + 2 });
      Object.assign(f.input().flow, { state: 'submitted', dispatch: { mode: 'submit', round: 1 } });
      f.input().draft.status = 'submitted';
    }
    let published = false;
    const publish = f.db.runTransaction(async (tx: any) => { await context.assertInTransaction(tx); published = true; });
    if (['unchanged', 'source_finished'].includes(change)) { await expect(publish).resolves.toBeUndefined(); expect(published).toBe(true); }
    else { await expect(publish).rejects.toMatchObject({ code: 'evidence_source_changed' }); expect(published).toBe(false); }
  });
});

describe('one bounded selection owns raw answers and evidence', () => {
  it('keeps the current answer after retiring 80 proven aliases in the same raw/evidence selection', async () => {
    const f = fixture({ id: 'pmp', question: 'Do you hold the PMP certification?', type: 'choice', options: ['Yes', 'No variant 0'] });
    const aliases: Record<string, any> = {};
    for (let index = 0; index < 80; index++) {
      f.input().draft.questions[0].options = ['Yes', `No variant ${index}`];
      await f.save({ pmp: 'Yes' }, { nowMs: now + index + 1 });
      const key = candidateQuestionAnswerKey(f.input().draft.questions[0]);
      aliases[key] = structuredClone(f.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence[key]);
    }
    // Model historical aliases produced before physical alias retirement was deployed.
    f.docs.set('user_cv_profiles/candidate', { applicationQuestionAnswerEvidence: aliases,
      applicationQuestionAnswers: Object.fromEntries(Object.keys(aliases).map(key => [key, 'Yes'])), applicationQuestionAnswersUpdatedAt: now + 80 });
    f.input().draft.questions[0].options = ['Yes', 'No current variant'];
    await f.save({ pmp: 'Yes' }, { nowMs: now + 100 });
    const current = f.read('user_cv_profiles/candidate'); const key = candidateQuestionAnswerKey(f.input().draft.questions[0]);
    expect(current.applicationQuestionAnswers[key]).toBe('Yes');
    expect(current.applicationQuestionAnswerEvidence[key].answer).toBe('Yes');
    expect(Object.keys(current.applicationQuestionAnswers)).toHaveLength(80);
    expect(Object.keys(current.applicationQuestionAnswerEvidence)).toHaveLength(80);
    for (const [aliasKey, record] of Object.entries(current.applicationQuestionAnswerEvidence) as [string, any][]) {
      if (aliasKey === key) continue;
      expect(record.question).toBeUndefined(); expect(record.answer).toBeUndefined(); expect(record.id).toBeUndefined();
      expect(current.applicationQuestionAnswers[aliasKey]).toBe('');
    }
  });
  it.each([true, false])('clears proven localized aliases in all stores without resurrecting an older save (hash=%s)', async withHash => {
    const options = ['Yes', 'No'];
    const question = { id: 'pmp', question: 'Do you hold the PMP certification?', type: 'choice', options, applicationOptions: options,
      optionMap: options.map(value => ({ candidate: value, application: value })), originalNativeContract: { question: 'Do you hold the PMP certification?', kind: 'select', options } };
    const f = fixture(question); await f.save({ pmp: 'Yes' });
    const profile = () => f.read('user_cv_profiles/candidate');
    const oldKey = Object.keys(profile().applicationQuestionAnswerEvidence)[0];
    f.input().draft.questions[0].options = ['Oui', 'Non'];
    f.input().draft.questions[0].optionMap = [{ candidate: 'Oui', application: 'Yes' }, { candidate: 'Non', application: 'No' }];
    await f.save({ pmp: 'Oui' }, { nowMs: now + 2 });
    const localizedKey = candidateQuestionAnswerKey(f.input().draft.questions[0]);
    expect(profile().applicationQuestionAnswerEvidence[oldKey].question).toBeUndefined();
    expect(profile().applicationQuestionAnswers[oldKey]).toBe('');
    const result = await f.save({ pmp: '' }, { nowMs: now + 4, ...(withHash ? {} : { answerContracts: {} }) });
    expect(result.answerConfirmation.authority).toBe(withHash);
    for (const key of [oldKey, localizedKey]) {
      const tombstone = profile().applicationQuestionAnswerEvidence[key];
      expect(tombstone).toMatchObject({ cleared: true });
      expect(tombstone.question).toBeUndefined(); expect(tombstone.answer).toBeUndefined(); expect(tombstone.id).toBeUndefined();
      expect(profile().applicationQuestionAnswers[key]).toBe('');
    }
    expect(f.input().flow.questionAnswers[oldKey]).toBeUndefined();
    expect(f.input().flow.questionAnswers[localizedKey]).toBe('');
    await expect(f.save({ pmp: 'Oui' }, { nowMs: now + 3 })).rejects.toMatchObject({ code: 'answer_contract_changed' });
    expect(profile().applicationQuestionAnswers[oldKey]).toBe('');
  });
  it('preserves other sources, newer aliases and unknown legacy memory during a source-specific clear', async () => {
    const options = ['Yes', 'No'];
    const question = { id: 'pmp', question: 'Do you hold the PMP certification?', type: 'choice', options };
    const f = fixture(question); await f.save({ pmp: 'Yes' });
    const profile = f.read('user_cv_profiles/candidate'); const record = Object.values(profile.applicationQuestionAnswerEvidence)[0] as any;
    const untouched = {
      other_source: { ...record, key: 'other_source', provenance: { ...record.provenance, orderId: 'other-order' } },
      newer_alias: { ...record, key: 'newer_alias', provenance: { ...record.provenance, confirmedAt: now + 10 } },
    };
    Object.assign(profile.applicationQuestionAnswerEvidence, untouched);
    Object.assign(profile.applicationQuestionAnswers, { other_source: 'Yes', newer_alias: 'Yes', unknown_legacy: 'Unattributed' });
    f.input().flow.questionAnswers.unknown_legacy = 'Unattributed';
    await f.save({ pmp: '' }, { nowMs: now + 2 });
    const current = f.read('user_cv_profiles/candidate');
    expect(current.applicationQuestionAnswerEvidence.other_source).toEqual(untouched.other_source);
    expect(current.applicationQuestionAnswerEvidence.newer_alias).toEqual(untouched.newer_alias);
    expect(current.applicationQuestionAnswers.unknown_legacy).toBe('Unattributed');
    expect(f.input().flow.questionAnswers.unknown_legacy).toBe('Unattributed');
  });
  it('can erase a proven old alias even when an unrelated newer global clock forbids inserting the new key', async () => {
    const f = fixture({ id: 'pmp', question: 'Do you hold the PMP certification?', type: 'choice', options: ['Yes', 'No'] });
    await f.save({ pmp: 'Yes' });
    const profile = f.read('user_cv_profiles/candidate'); const oldKey = Object.keys(profile.applicationQuestionAnswerEvidence)[0];
    f.input().draft.questions[0].options = ['Oui', 'Non'];
    profile.applicationQuestionAnswersUpdatedAt = now + 10;
    await f.save({ pmp: '' }, { nowMs: now + 2 });
    const current = f.read('user_cv_profiles/candidate');
    expect(current.applicationQuestionAnswerEvidence[oldKey]).toMatchObject({ cleared: true });
    expect(current.applicationQuestionAnswerEvidence[oldKey].question).toBeUndefined();
    expect(current.applicationQuestionAnswers[oldKey]).toBe('');
    expect(current.applicationQuestionAnswersUpdatedAt).toBe(now + 10);
  });
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
