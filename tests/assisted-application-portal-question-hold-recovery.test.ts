import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { PORTAL_QUESTION_RECOVERY_MAX, reconcilePortalCode } from '../scripts/assisted-application/reconcile-portal-code.mjs';
import { portalQuestionDocumentSlotKind, successFactorsDocumentSlotKind } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { evaluateRedFlags, transition } from '../functions/src/assistedApplicationFlow.js';
import { platformDefaultAnswer } from '../functions/src/assistedApplicationPlatformDefaults.js';

// Owner mandate 2026-11-10: an application held on a portal question resumes by itself when the code published
// since answers it, or knows it for the document slot it is (Helsana s2Tbwwjd). No candidate data here.
const now = Date.now();
const version = 'c'.repeat(64);
const base = 'assisted_applications/order_question_hold_test';
const flowPath = `${base}/automation/flow`;
const draftPath = `${base}/ai_drafts/current`;
const submissionPath = `${base}/automation/submission`;
const portal = (id: string, applicationQuestion: string, extra = {}) => ({
  id, source: 'portal', question: applicationQuestion, applicationQuestion, required: true, type: 'text', options: [], ...extra,
});
const cvSlot = portal('portal_lebenslauf_zeugnisse_diplome_x', 'Lebenslauf - Zeugnisse - Diplome', { context: 'Meine Dokumente' });
const travel = portal('portal_travel', 'Sind Sie bereit, geschäftlich zu reisen?', { type: 'yes_no', options: ['Ja', 'Nein'] });
const birthDate = portal('portal_birth', 'Geburtsdatum', { type: 'date' });

function fixture(questions: object[], { submission = {}, order = {}, draft = {} } = {}) {
  const held = questions.filter((question: any) => question.required).map((question: any) => `question:${question.id}`);
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'needs_candidate_action', automationDueAt: null,
      consentVersion: 'assisted-application-v2', consentedAt: now, talentPoolConsent: true, cvStorageKey: 'cv/object', ...order },
    [flowPath]: { state: 'needs_candidate_action', round: 1, heldBy: held, portalCodeVersion: 'a'.repeat(64),
      dispatch: { mode: 'submit', round: 1, requestedAt: now }, portalAutoRetryCount: 2 },
    [draftPath]: { status: 'ready', round: 1, completedAt: now - 1, questions, job: { source: 'job_detail' }, factCheck: { ok: true },
      channel: { type: 'employer_site', applyUrl: 'https://jobs.example.test/apply' }, ...draft },
    [submissionPath]: { r1: { state: 'failed', channel: 'portal', releasedAt: now - 1000, clickedAt: null }, ...submission },
  });
}
const run = (store: ReturnType<typeof fixture>, apply = true) =>
  reconcilePortalCode({ db: store.db, version, apply, nowMs: now, isEnabled: async () => true });
const tickOf = (store: ReturnType<typeof fixture>) => transition(store.read(flowPath), { type: 'tick' }, {
  order: store.read(base), draft: store.read(draftPath), answers: {}, documents: {}, nowMs: now,
});

describe('portal question holds after a portal fix', () => {
  it('resumes a document slot held as a question, once per engine version', async () => {
    const store = fixture([cvSlot]);
    expect(await run(store, false)).toMatchObject({ eligible: 1, queued: 0, questionHoldsQueued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
    expect(store.read(draftPath).questions[0].required).toBe(true);

    expect(await run(store)).toMatchObject({ eligible: 1, queued: 1, questionHoldsQueued: 1 });
    expect(store.read(draftPath).questions[0]).toMatchObject({ required: false, portalDocumentSlot: { kind: 'cv', version } });
    expect(store.read(base).automationDueAt).toBe(now);
    expect(store.read(flowPath)).toMatchObject({ state: 'needs_candidate_action', portalRecoveryVersion: version });
    expect(store.read(submissionPath).portalCodeRecovery).toMatchObject({ version, round: 1, kind: 'portal_questions_resolved' });
    // The clock's own tick sends the application again.
    expect(tickOf(store).effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }),
    ]));
    expect(await run(store)).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(1);
  });

  it('resumes a question a platform rule now answers, without touching the draft', async () => {
    expect(platformDefaultAnswer(travel, null)?.value).toBeTruthy();
    const store = fixture([travel]);
    expect(await run(store)).toMatchObject({ eligible: 1, queued: 1, questionHoldsQueued: 1 });
    expect(store.read(draftPath).questions[0]).toEqual(travel);
    expect(store.read(base).automationDueAt).toBe(now);
    expect(tickOf(store).effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }),
    ]));
  });

  it('keeps a real question with the candidate, and the whole wait when one remains beside a slot', async () => {
    for (const questions of [[birthDate], [cvSlot, birthDate]]) {
      const store = fixture(questions);
      expect(evaluateRedFlags(store.read(draftPath), {}, {}, {}, store.read(flowPath), store.read(base)).candidate).toContain('portal_birth');
      expect(await run(store)).toMatchObject({ eligible: 0, queued: 0 });
      expect(store.read(base).automationDueAt).toBeNull();
      expect(store.read(draftPath).questions.every((question: any) => question.required)).toBe(true);
      expect(store.read(submissionPath).portalCodeRecovery).toBeUndefined();
    }
  });

  it('never resumes a submission that was clicked or is still in flight', async () => {
    for (const submission of [
      { r1: { state: 'failed', channel: 'portal', releasedAt: now - 1000, clickedAt: now - 2000, confirmedNotSent: false } },
      { r1: { state: 'failed', channel: 'portal', releasedAt: now - 1000 }, r0: { state: 'sending', channel: 'portal' } },
      { r1: { state: 'sent', channel: 'portal' } },
    ]) {
      const store = fixture([cvSlot], { submission });
      expect(await run(store)).toMatchObject({ eligible: 0, queued: 0 });
      expect(store.read(base).automationDueAt).toBeNull();
      expect(store.read(draftPath).questions[0].required).toBe(true);
    }
  });

  it('keeps a cover-letter slot when the order has no letter, and the CV slot without a CV', async () => {
    const letterSlot = portal('portal_letter', 'Motivationsschreiben');
    expect(await run(fixture([letterSlot]))).toMatchObject({ eligible: 0 });
    expect(await run(fixture([letterSlot], { draft: { coverLetterPdfKey: 'letter/object' } }))).toMatchObject({ queued: 1 });
    // An upload slot needs the letter's PDF: the runner never uploads the bare text (review of #17990).
    const letterUpload = portal('portal_letter_file', 'Motivationsschreiben', { type: 'file' });
    const textOnly = fixture([letterUpload], { draft: { coverLetter: 'Sehr geehrte Damen und Herren' } });
    expect(await run(textOnly)).toMatchObject({ eligible: 0 });
    expect(textOnly.read(draftPath).questions[0].required).toBe(true);
    expect(await run(fixture([letterUpload], { draft: { coverLetter: 'text', coverLetterPdfKey: 'letter/object' } }))).toMatchObject({ queued: 1 });
    expect(await run(fixture([cvSlot], { order: { cvStorageKey: '' } }))).toMatchObject({ eligible: 0 });
  });

  it('bounds the resumes of one wait across engine versions', async () => {
    const store = fixture([cvSlot], { submission: { portalQuestionRecovery: { key: 'other', attempts: 9 } } });
    expect(await run(store)).toMatchObject({ queued: 1 });
    const { key } = store.read(submissionPath).portalQuestionRecovery;
    const exhausted = fixture([cvSlot], { submission: { portalQuestionRecovery: { key, attempts: PORTAL_QUESTION_RECOVERY_MAX } } });
    expect(await run(exhausted)).toMatchObject({ eligible: 0, queued: 0 });
  });

  it('does not spend or retire the portal retry budget of a wait on questions', async () => {
    const store = fixture([cvSlot]);
    store.docs.set(flowPath, { ...store.read(flowPath), portalExhaustedRecoveryVersion: 'd'.repeat(64) });
    store.docs.set(base, { ...store.read(base), automationDueAt: now + 3600_000 });
    expect(await run(store)).toMatchObject({ queued: 1, questionHoldsQueued: 1 });
    expect(store.read(base).automationDueAt).toBe(now);
    expect(store.read(flowPath).portalExhaustedRecoveryVersion).toBe('d'.repeat(64));
  });

  it('reads a held question as a document slot only by the runner rule', () => {
    const kind = (label: string, extra = {}) => portalQuestionDocumentSlotKind(portal('q', label, extra));
    expect(['Lebenslauf - Zeugnisse - Diplome', '* Lebenslauf', 'Curriculum vitae e certificati', 'Lebenslauf hochladen',
      'Pièces jointes, CV'].map(label => kind(label))).toEqual(['cv', 'cv', 'cv', 'cv', 'cv']);
    expect(kind('Lettre de motivation')).toBe('cover_letter');
    expect(['Lebenslauf und Motivationsschreiben', 'Haben Sie einen Lebenslauf?', 'Lücken im Lebenslauf erklären',
      'Lebenslauf (Link)', 'Zeugnisse', 'Upload your CV and explain the gaps'].map(label => kind(label))).toEqual(['', '', '', '', '', '']);
    expect(kind('Lebenslauf', { type: 'yes_no' })).toBe('');
    expect(kind('Lebenslauf', { options: ['Ja'] })).toBe('');
    expect(kind('Lebenslauf', { validation: { pattern: '^https://' } })).toBe('');
    expect(portalQuestionDocumentSlotKind({ ...portal('q', 'Lebenslauf'), source: 'match' })).toBe('');
    // The live slot rule reads the same caption the same way.
    expect(successFactorsDocumentSlotKind({ text: '* Lebenslauf - Zeugnisse - Diplome Lebenslauf Öffnet ein Dialogfeld' })).toBe('cv');
  });
});
