import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { buildFillKit } = await import('../functions/src/assistedApplicationFillKit.js');
const { handleAutomationAdminAction, recordOwnerSubmission } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
const { transition } = await import('../functions/src/assistedApplicationFlow.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const ORDER = 'order_FILL01';
const PATH = `assisted_applications/${ORDER}`;
const KEY = (name: string) => `assisted-application-uploads/${ORDER}/${name}`;

const order = {
  orderId: ORDER,
  paymentStatus: 'paid',
  submissionStatus: 'in_progress',
  applicantName: 'Maria Rossi',
  applicantEmail: 'maria@example.com',
  applicantPhone: '+39 333 1234567',
  jobTitle: 'Pflegefachperson',
  companyName: 'Ospedale',
  cvStorageKey: KEY('1-cv.docx'),
};
const draft = {
  round: 1,
  language: 'de',
  job: { title: 'Pflegefachperson 80%', applyUrl: 'https://jobs.example.ch/job/1' },
  channel: { type: 'employer_site', applyUrl: 'https://jobs.example.ch/job/1/apply' },
  profile: { dateOfBirth: '1990-05-12', location: 'Como, Italia', address: { street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' } },
  questions: [{ id: 'availability', question: 'Ab wann verfügbar?' }, { id: 'salary_expectation', question: 'Lohnvorstellung' }],
  portalAnswers: {
    status: 'submit_failed',
    at: T0,
    answers: [
      { question: 'Wann können Sie beginnen?', answer: 'Nach Vereinbarung', source: 'answers' },
      { question: 'Lohnvorstellung', answer: '6500', source: 'answers' },
      { question: 'Lebenslauf', answer: '[CV]', source: 'documents' },
      { question: 'Leer', answer: '', source: 'rule' },
    ],
  },
  coverLetter: { text: 'Sehr geehrte Damen und Herren' },
  coverLetterPdfKey: KEY('ai-cover-letter-r1-1.pdf'),
  tailoredCv: { status: 'ready', pdfKey: KEY('ai-cv-r1-1.pdf') },
  formAnswers: [{ key: 'motivationShort', value: 'Motiviert' }],
};
const takenOver = { state: 'owner_takeover', round: 1, heldBy: ['portal_refused'], answers: { availability: 'sofort', salary_expectation: 'CHF 80k' }, formOverrides: { firstName: 'Maria Luisa', lastName: 'Rossi' } };

// Owner decision 2026-10-01: a portal the robot cannot pass is sent by Valerie, the extension types for her.
describe('fill kit', () => {
  it('carries what the runner would type: its portal answers first, the candidate’s edits, the documents', () => {
    const kit = buildFillKit({
      orderId: ORDER,
      order,
      draft,
      flow: takenOver,
      documents: { cv: { url: 'https://signed/cv', extension: 'pdf' }, coverLetter: { url: 'https://signed/letter' } },
    });
    expect(kit.applyUrl).toBe('https://jobs.example.ch/job/1/apply');
    expect(kit.identity).toMatchObject({ firstName: 'Maria Luisa', lastName: 'Rossi', fullName: 'Maria Luisa Rossi', email: 'maria@example.com', phone: '+39 333 1234567', location: 'Como, Italia' });
    expect(kit.identity.address).toEqual({ street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' });
    expect(kit.profile).toMatchObject({ dateOfBirth: '1990-05-12', salary: 'CHF 80k' });
    // The portal's own wording wins over the draft's question; empty answers never travel.
    expect(kit.answers).toEqual([
      { question: 'Wann können Sie beginnen?', answer: 'Nach Vereinbarung', source: 'answers' },
      { question: 'Lohnvorstellung', answer: '6500', source: 'answers' },
      { question: 'Lebenslauf', answer: '[CV]', source: 'documents' },
      { question: 'Ab wann verfügbar?', answer: 'sofort', source: 'answers' },
    ]);
    expect(kit.texts).toMatchObject({ coverLetter: 'Sehr geehrte Damen und Herren', motivationShort: 'Motiviert' });
    expect(kit.documents).toEqual({
      cv: { url: 'https://signed/cv', fileName: 'CV_Maria_Luisa_Rossi.pdf' },
      // The names the runner gives them (lib/submit.mjs): in German the letter is a «Motivationsschreiben».
      coverLetter: { url: 'https://signed/letter', fileName: 'Motivationsschreiben_Maria_Luisa_Rossi.pdf' },
    });
  });
});

describe('owner queue: fill kit and «Segna come inviata»', () => {
  let store: ReturnType<typeof createMemoryFirestore>;
  let effects: any[];
  const runEffect = vi.fn(async (context: any) => {
    effects.push(context.effect);
    return { ok: true };
  });
  const signUrl = vi.fn(async (key: string) => `https://signed/${key.split('/').pop()}`);
  const originalCvUrl = vi.fn(async () => 'https://signed/original-cv');
  const seed = async (flow: Record<string, any>, extraDraft: Record<string, any> = {}) => {
    const ref = store.db.collection('assisted_applications').doc(ORDER);
    await ref.set(order);
    await ref.collection('ai_drafts').doc('current').set({ ...draft, ...extraDraft });
    await ref.collection('automation').doc('flow').set(flow);
  };
  const call = (action: string, extra: Record<string, unknown> = {}) => handleAutomationAdminAction(
    store.db, { action, orderId: ORDER, ...extra }, 'owner@example.com', { runEffect, signUrl, originalCvUrl, nowMs: T0 },
  );

  beforeEach(() => {
    store = createMemoryFirestore();
    effects = [];
    runEffect.mockClear();
    signUrl.mockClear();
  });

  it('hands the kit of an order the robot left to Valerie, with the CV that leaves', async () => {
    await seed(takenOver);
    const { kit } = await call('automationFillKit') as any;
    expect(kit.orderId).toBe(ORDER);
    expect(kit.documents.cv).toEqual({ url: 'https://signed/ai-cv-r1-1.pdf', fileName: 'CV_Maria_Luisa_Rossi.pdf' });
    expect(kit.documents.coverLetter.url).toBe('https://signed/ai-cover-letter-r1-1.pdf');
    // The candidate chose their own CV on the review page: the original, in its own format.
    await seed({ ...takenOver, cvChoice: 'original' });
    const original = (await call('automationFillKit') as any).kit;
    expect(original.documents.cv).toEqual({ url: 'https://signed/original-cv', fileName: 'CV_Maria_Luisa_Rossi.docx' });
  });

  it('gives no kit while the robot still owns the order, nor for a round already sent', async () => {
    await seed({ ...takenOver, state: 'submitting' });
    await expect(call('automationFillKit')).rejects.toMatchObject({ code: 'not_taken_over', status: 409 });
    await seed(takenOver);
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set({ r1: { state: 'sent' } });
    await expect(call('automationFillKit')).rejects.toMatchObject({ code: 'already_sent', status: 409 });
  });

  it('marks the order as sent by Valerie, so no retry presses it again', async () => {
    await seed(takenOver);
    expect(await call('automationMarkSubmitted', { via: 'extension' })).toEqual({ ok: true, state: 'submitted' });
    expect(store.read(`${PATH}/automation/flow`)).toMatchObject({ state: 'submitted', submittedVia: 'owner_extension', heldBy: [] });
    expect(store.read(`${PATH}/automation/submission`)).toMatchObject({ r1: { state: 'sent', channel: 'owner_extension', by: 'owner@example.com' } });
    expect(effects).toEqual([{ type: 'mark_submitted', by: 'owner' }]);
    await expect(call('automationMarkSubmitted')).rejects.toMatchObject({ code: 'not_taken_over', status: 409 });
  });

  it('closes the flow also when Valerie marks it sent in the classic queue, and only a flow left to her', async () => {
    await seed(takenOver);
    expect(await recordOwnerSubmission({ db: store.db, orderId: ORDER, adminEmail: 'owner@example.com', runEffect, nowMs: T0 })).toEqual({ ok: true, state: 'submitted' });
    expect(store.read(`${PATH}/automation/flow`)).toMatchObject({ state: 'submitted', submittedVia: 'owner' });
    expect(store.read(`${PATH}/automation/submission`)).toMatchObject({ r1: { state: 'sent', channel: 'owner' } });
    await seed({ ...takenOver, state: 'submitting' });
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set({ r1: { state: 'sending' } });
    expect(await recordOwnerSubmission({ db: store.db, orderId: ORDER, adminEmail: 'owner@example.com', runEffect, nowMs: T0 })).toEqual({ ok: false, ignored: 'not_taken_over' });
    expect(store.read(`${PATH}/automation/flow`)).toMatchObject({ state: 'submitting' });
    expect(store.read(`${PATH}/automation/submission`)).toMatchObject({ r1: { state: 'sending' } });
  });

  it('records the owner as the sender on the order', async () => {
    await store.db.collection('assisted_applications').doc(ORDER).set(order);
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'mark_submitted', by: 'owner' }, flow: { round: 1, submittedVia: 'owner_extension' }, nowMs: T0 });
    expect(store.read(PATH)).toMatchObject({ submissionStatus: 'submitted', submissionNotes: 'Candidatura inviata da Valerie sul portale, dopo lo stop del robot.' });
  });
});

describe('owner_submitted', () => {
  it('closes an order the robot stopped on, never one still running', () => {
    for (const state of ['owner_takeover', 'candidate_handoff']) {
      const step = transition({ state, round: 1, heldBy: ['portal_refused'], deadlineAt: null, reminderAt: T0 }, { type: 'owner_submitted' }, { draft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'submitted', heldBy: [], reminderAt: null });
      expect(step.effects).toEqual([{ type: 'mark_submitted', by: 'owner' }]);
    }
    expect(transition({ state: 'submitting', round: 1 }, { type: 'owner_submitted' }, { draft, nowMs: T0 }).ignored).toBe('not_taken_over');
    expect(transition({ state: 'submitted', round: 1 }, { type: 'owner_submitted' }, { draft, nowMs: T0 }).ignored).toBeTruthy();
  });
});
