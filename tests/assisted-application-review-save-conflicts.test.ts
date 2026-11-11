import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken: mintToken } = await import('../functions/src/assistedApplicationReviewToken.js');
// The module's JSDoc documents the options only; the call takes the whole input object.
const mintReviewToken = mintToken as unknown as (input: Record<string, unknown>) => string;
const { candidateQuestionAnswerKey } = await import('../functions/src/assistedApplicationCandidateEdits.js');
const { loadRunnerAnswerContext: loadRunner, orderQuestionAnswerIdentity } = await import('../functions/src/assistedApplicationAnswerEvidence.js');
const loadRunnerAnswerContext = loadRunner as unknown as (input: Record<string, unknown>) => Promise<any>;

const SECRET = 's'.repeat(40);
const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
const ORDER = 'order_SAVE42';
const BASE = `assisted_applications/${ORDER}`;
const FLOW = `${BASE}/automation/flow`;

// A native portal control whose owner the portal does not prove: no candidate-wide answer key.
const unownedPortalQuestion = {
  id: 'portal_record_entry', question: 'Hast du einen Eintrag im Strafregister?', applicationQuestion: 'Hast du einen Eintrag im Strafregister?',
  why: 'Domanda del portale', type: 'choice', options: ['Ja', 'Nein'], required: true, source: 'portal',
  addressContext: { section: 'Fragen zur Stelle', owners: ['Fragen', 'Stelle', 'Bewerbung'], unknown: true },
};
const salaryQuestion = { id: 'salary_expectation', question: 'Qual è la tua aspettativa salariale?', type: 'text', required: false };
const noticeQuestion = { id: 'notice_period', question: 'Qual è il tuo periodo di preavviso?', type: 'text', required: false };

function draft(questions: any[]) {
  return {
    status: 'ready', round: 1,
    cvKey: `assisted-application-uploads/${ORDER}/cv.pdf`,
    profile: { fullName: 'Test Candidate', email: 'candidate@example.test', location: 'Como', languages: [] },
    job: { source: 'job_detail', title: 'Product Owner', applyUrl: 'https://jobs.example.test/apply' },
    channel: { type: 'lever', label: 'Lever', applyUrl: 'https://jobs.example.test/apply' },
    coverLetter: { subject: 'Candidatura', text: 'Gentili Signori,\n\nTesto.\n\nCordiali saluti' },
    applicationEmail: { to: '', subject: 'x', body: 'y' },
    formAnswers: [{ key: 'motivationShort', label: 'Motivazione', value: 'Mi motiva il ruolo.' }],
    questions,
    coverLetterPdfKey: `assisted-application-uploads/${ORDER}/ai-cover-letter-r1-1.pdf`,
  };
}

let store: ReturnType<typeof createMemoryFirestore>;
const runEffect = vi.fn(async () => ({ ok: true }));
const deps = () => ({ db: store.db, runEffect, getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/file.pdf', nowMs: T0 });
const reviewToken = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 });
const load = async (t = reviewToken()) => (await handleAssistedApplicationReview({ method: 'GET', query: { t } }, deps())).body;
const save = (shown: any, answers: Record<string, string>, t = reviewToken()) => handleAssistedApplicationReview({ method: 'POST', body: {
  t, action: 'answers', answers: { ...shown.answers, ...answers },
  answerQuestionSnapshots: shown.answerQuestionSnapshots, answerRevisions: shown.answerRevisions,
} }, deps());
const flowRef = () => store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow');

function seed(questions: any[], order: Record<string, any> = {}) {
  store = createMemoryFirestore({
    [BASE]: { userId: 'candidate-save-test', jobId: 'job-save-test', jobUrl: 'https://jobs.example.test/42',
      cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, cvUploadedAt: T0, paymentStatus: 'paid',
      submissionStatus: 'in_progress', jobTitle: 'Product Owner', companyName: 'Example AG', locale: 'it', ...order },
    [FLOW]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [], updatedAt: T0 - 60_000 },
    [`${BASE}/ai_drafts/current`]: draft(questions),
  });
}

beforeEach(() => {
  runEffect.mockClear();
  seed([unownedPortalQuestion, salaryQuestion, noticeQuestion]);
});

describe('review page save: contract and concurrency', () => {
  it('gives every shown question a contract, also one without a candidate-wide answer key', async () => {
    expect(candidateQuestionAnswerKey(unownedPortalQuestion)).toBe('');
    expect(orderQuestionAnswerIdentity(unownedPortalQuestion)).toMatch(/^order_local_[a-f0-9]{32}$/);
    const shown = await load();
    expect(Object.keys(shown.answerQuestionSnapshots).sort()).toEqual(['notice_period', 'portal_record_entry', 'salary_expectation']);
    expect(Object.keys(shown.answerRevisions).sort()).toEqual(['notice_period', 'portal_record_entry', 'salary_expectation']);

    const saved = await save(shown, { portal_record_entry: 'Nein' });
    expect(saved).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.read(FLOW)?.answers).toMatchObject({ portal_record_entry: 'Nein' });

    // The confirmed answer reaches the page again and the runner's context, and only this order:
    // nothing is written to the candidate-wide ledger under the order-local identity.
    const again = await load();
    expect(again.answers.portal_record_entry).toBe('Nein');
    const order = store.read(BASE); const flow = store.read(FLOW); const current = store.read(`${BASE}/ai_drafts/current`);
    const runner = await loadRunnerAnswerContext({ db: store.db, orderId: ORDER, order, flow, draft: current, nowMs: T0 });
    expect(runner.flow.answers.portal_record_entry).toBe('Nein');
    const ledger = store.read('user_cv_profiles/candidate-save-test') || {};
    expect(Object.keys(ledger.applicationQuestionAnswers || {}).some(key => key.startsWith('order_local_'))).toBe(false);
    expect(Object.keys(ledger.applicationQuestionAnswerEvidence || {}).some(key => key.startsWith('order_local_'))).toBe(false);
  });

  it('saves after a technical write between the page load and the save', async () => {
    seed([salaryQuestion, noticeQuestion]);
    const shown = await load();
    // A sweep, a reminder and a recovery stamp touch the flow, never an answer or a question.
    await flowRef().set({ updatedAt: T0 + 5_000, reminderAt: T0 + 3_600_000, portalCodeVersion: 'a'.repeat(64),
      sweepCheckedAt: T0 + 5_000 }, { merge: true });
    const saved = await save(shown, { salary_expectation: 'CHF 100000' });
    expect(saved).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.read(FLOW)?.answers).toMatchObject({ salary_expectation: 'CHF 100000' });

    // The letter/fields form too: its contract does not carry the flow's timestamp.
    const edit = await load();
    await flowRef().set({ updatedAt: T0 + 9_000 }, { merge: true });
    const fields = Object.fromEntries(edit.formAnswers.filter((field: any) => field.editable).map((field: any) => [field.key, field.value]));
    const edited = await handleAssistedApplicationReview({ method: 'POST', body: { t: reviewToken(), action: 'edit',
      editSnapshot: edit.editSnapshot, coverLetterText: edit.coverLetter.text, fields } }, deps());
    expect(edited).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('refuses the second of two tabs that changed the same answer, keeping the newer one', async () => {
    seed([salaryQuestion, noticeQuestion]);
    const tabA = await load();
    const tabB = await load();
    expect(await save(tabA, { salary_expectation: 'CHF 100000' })).toMatchObject({ status: 200 });
    const late = await save(tabB, { salary_expectation: 'CHF 90000' });
    expect(late).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    expect(store.read(FLOW)?.answers?.salary_expectation).toBe('CHF 100000');
  });

  // Review PRR_kwDORN5k2M8AAAABXP_Row (#18091): the revisions, the save's comparison and the commit guard
  // read the order-aware answer projection, the one an order-local answer is confirmed in.
  it('refuses the second of two saves from one loaded page on an order-local answer, keeping the first', async () => {
    const confirmed = await save(await load(), { portal_record_entry: 'Ja' });
    expect(confirmed).toMatchObject({ status: 200 });
    const order = store.read(BASE); const current = store.read(`${BASE}/ai_drafts/current`);
    const projected = await loadRunnerAnswerContext({ db: store.db, orderId: ORDER, order, flow: store.read(FLOW), draft: current, nowMs: T0 });
    expect(projected.orderAnswerSnapshots[orderQuestionAnswerIdentity(unownedPortalQuestion)]).toMatch(/^[a-f0-9]{64}$/);
    expect(projected.flow.answers.portal_record_entry).toBe('Ja');

    const page = await load();
    expect(page.answers.portal_record_entry).toBe('Ja');
    expect(await save(page, { portal_record_entry: 'Nein' })).toMatchObject({ status: 200, body: { ok: true } });
    // A value other than the one this page loaded (here: cleared). The loaded value itself is what an
    // untouched field sends back, which leaves another tab's newer answer alone (test below).
    const second = await save(page, { portal_record_entry: '' });
    expect(second).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    expect(store.read(FLOW)?.answers?.portal_record_entry).toBe('Nein');

    // The same answer changed between the save's read and its commit is refused by the transaction too.
    const reloaded = await load();
    const originalRunTransaction = store.db.runTransaction.bind(store.db);
    let raced = false;
    store.db.runTransaction = async (callback: (transaction: any) => Promise<any>) => {
      if (!raced) {
        raced = true;
        await flowRef().set({ answers: { portal_record_entry: 'Ja' } }, { merge: true });
      }
      return originalRunTransaction(callback);
    };
    const racing = await save(reloaded, { portal_record_entry: '' });
    expect(racing).toMatchObject({ status: 409, body: { error: 'changed_meanwhile' } });
    expect(store.read(FLOW)?.answers?.portal_record_entry).toBe('Ja');
  });

  it('keeps a newer answer from another tab that this tab did not touch, and saves the rest', async () => {
    seed([salaryQuestion, noticeQuestion]);
    const tabA = await load();
    const tabB = await load();
    expect(await save(tabA, { salary_expectation: 'CHF 100000' })).toMatchObject({ status: 200 });
    // Tab B still holds the empty salary it loaded and changes another answer only.
    const merged = await save(tabB, { notice_period: '3 mesi' });
    expect(merged).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.read(FLOW)?.answers).toMatchObject({ salary_expectation: 'CHF 100000', notice_period: '3 mesi' });
  });

  it('is idempotent: the same save sent twice goes through and stores one value', async () => {
    seed([salaryQuestion, noticeQuestion]);
    const shown = await load();
    expect(await save(shown, { salary_expectation: 'CHF 100000' })).toMatchObject({ status: 200 });
    expect(await save(shown, { salary_expectation: 'CHF 100000' })).toMatchObject({ status: 200 });
    expect(store.read(FLOW)?.answers?.salary_expectation).toBe('CHF 100000');
  });

  it('rechecks the stored answer inside the commit transaction', async () => {
    seed([salaryQuestion, noticeQuestion]);
    const shown = await load();
    const originalRunTransaction = store.db.runTransaction.bind(store.db);
    let raced = false;
    store.db.runTransaction = async (callback: (transaction: any) => Promise<any>) => {
      if (!raced) {
        raced = true;
        // Another tab's save lands after this request read the flow, before its commit.
        await flowRef().set({ answers: { salary_expectation: 'CHF 120000' } }, { merge: true });
      }
      return originalRunTransaction(callback);
    };
    const refused = await save(shown, { salary_expectation: 'CHF 90000' });
    expect(refused).toMatchObject({ status: 409, body: { error: 'changed_meanwhile' } });
    expect(store.read(FLOW)?.answers?.salary_expectation).toBe('CHF 120000');
  });

  it('saves from the concierge portal link (child order, locale from the service)', async () => {
    seed([unownedPortalQuestion, salaryQuestion], { locale: null, parentServiceId: 'service_save42', parentProposalId: 'proposal_1' });
    await store.db.collection('application_concierge_services').doc('service_save42').set({ userId: 'candidate-save-test', locale: 'de' });
    // The same token the concierge portal mints for a child order (applicationConciergeCore.js openChildReview).
    const conciergeToken = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0, ttlMs: 60 * 60 * 1000 });
    const shown = await load(conciergeToken);
    expect(shown.locale).toBe('de');
    expect(Object.keys(shown.answerQuestionSnapshots).sort()).toEqual(['portal_record_entry', 'salary_expectation']);
    await flowRef().set({ updatedAt: T0 + 5_000 }, { merge: true });
    const saved = await save(shown, { portal_record_entry: 'Nein', salary_expectation: 'CHF 100000' }, conciergeToken);
    expect(saved).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.read(FLOW)?.answers).toMatchObject({ portal_record_entry: 'Nein', salary_expectation: 'CHF 100000' });
  });
});
