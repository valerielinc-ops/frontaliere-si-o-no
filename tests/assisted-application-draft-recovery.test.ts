import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import {
  DRAFT_CANDIDATE_EMAIL_MISSING_CODE,
  DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
  DRAFT_AUTO_RETRY_DELAY_MS,
  draftRetryDueAt,
} from '../functions/src/assistedApplicationDraftRetryPolicy.js';
import {
  isFirestoreIndexUnavailableError,
  reconcileCandidateDocumentEmails,
  reconcileDraftFailures,
} from '../scripts/assisted-application/reconcile-draft-failures.mjs';
import {
  DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION,
  DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS,
  recoverCandidateDocumentEmail,
} from '../functions/src/assistedApplicationCandidateDocumentEmailRecovery.js';
import { candidateDocumentIdentity } from '../functions/src/assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { tailoredCvDocumentFor } from '../functions/src/assistedApplicationTailoredCvPdf.js';
import { letterBlocksFor } from '../functions/src/assistedApplicationLetterPdf.js';

const now = Date.now();
const base = 'assisted_applications/draft_recovery_test';

function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'owner_takeover' },
    [`${base}/automation/flow`]: {
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, sent: null, sentAttempt: null },
    [`${base}/automation/submission`]: {
      r1: { state: 'failed', channel: 'portal', clickedAt: null, confirmedNotSent: true, releasedAt: now - 1_000 },
    },
  });
}

describe('automatic recovery after a failed draft run', () => {
  it('queues one delayed regeneration without granting send authority', async () => {
    const store = fixture();
    const context = { db: store.db, nowMs: now, isEnabled: async () => true };

    expect(await reconcileDraftFailures(context)).toMatchObject({ eligible: 1, queued: 0 });
    expect(store.read(`${base}/automation/flow`).draftAutoRetryAt).toBeUndefined();

    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({
      state: 'owner_takeover', heldBy: ['draft_failed'], draftAutoRetryCount: 0,
      draftAutoRetryAt: now + DRAFT_AUTO_RETRY_DELAY_MS,
    });
    expect(store.read(base).automationDueAt).toBe(now + DRAFT_AUTO_RETRY_DELAY_MS);
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
  });

  it('grants one versioned retry for a prior candidate-email failure after the ordinary retry was used', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, {
      ...store.read(`${base}/automation/flow`), draftAutoRetryCount: 1,
      draftRecoveryVersion: 'draft-recovery-v1',
    });
    store.docs.set(`${base}/automation_events/email-failure`, {
      type: 'draft_failed', round: 2, error: DRAFT_CANDIDATE_EMAIL_MISSING_CODE,
    });
    const context = { db: store.db, nowMs: now, isEnabled: async () => true };

    expect(await reconcileDraftFailures(context)).toMatchObject({ eligible: 1, queued: 0 });
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({
      state: 'owner_takeover', heldBy: ['draft_failed'], draftAutoRetryCount: 0,
      draftAutoRetryAt: now + DRAFT_AUTO_RETRY_DELAY_MS,
      draftCandidateEmailRecoveryVersion: DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
    });
    const scheduledEvents = store.list(`${base}/events/`).length;
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(scheduledEvents);
  });

  it('does not replenish an exhausted draft retry for an unrelated failure code', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, {
      ...store.read(`${base}/automation/flow`), draftAutoRetryCount: 1,
      draftRecoveryVersion: 'draft-recovery-v1',
    });
    store.docs.set(`${base}/automation_events/other-failure`, {
      type: 'draft_failed', round: 2, error: 'documents_empty',
    });

    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
  });

  it('regenerates only the missing round through the normal clock event', () => {
    const result = transition({
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      draftAutoRetryCount: 0, draftAutoRetryAt: now,
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    }, { type: 'draft_auto_retry' }, {
      draft: { status: 'ready', round: 1 }, nowMs: now,
    });

    expect(result.flow).toMatchObject({
      state: 'regenerating', round: 2, heldBy: [], draftAutoRetryCount: 1,
      draftAutoRetryAt: null,
    });
    expect(result.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'draft_auto_retry' }]);
    expect(draftRetryDueAt(result.flow)).toBeNull();
  });

  it('does not dispatch a queued retry after the posting expired', () => {
    const result = transition({
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      draftAutoRetryCount: 0, draftAutoRetryAt: now,
      postingExpiredAt: now - 1,
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    }, { type: 'draft_auto_retry' }, {
      draft: { status: 'ready', round: 1 }, nowMs: now,
    });

    expect(result.ignored).toBe('posting_expired');
    expect(result.effects).toEqual([]);
  });

  it.each(['sent', 'sending', 'clicked'])('does not queue when the application may have left: %s', async state => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, {
      r1: { state, channel: 'portal', clickedAt: state === 'clicked' ? now : null, releasedAt: now },
    });
    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
  });

  it.each([
    ['confirmed release', { state: 'failed', channel: 'portal', clickedAt: now - 10, confirmedNotSent: true, releasedAt: now - 1 }],
    ['legacy confirmed release', { state: 'failed', channel: 'portal', clickedAt: now - 10, releasedAt: now - 1 }],
  ])('allows draft recovery after a %s with retained click evidence', async (_label, record) => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: record });

    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 1, queued: 1 });
  });

  it('fails closed on a malformed persisted retry count', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), draftAutoRetryCount: ' ' });
    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeUndefined();
  });
});

describe('contact-only recovery of a draft generated without candidate email', () => {
  const orderId = 'contact_recovery_test';
  const orderPath = `assisted_applications/${orderId}`;

  function documentFixture({ clickedAt = null } = {}) {
    const store = createMemoryFirestore({
      [orderPath]: {
        userId: 'synthetic-user-id', applicantName: 'Test Candidate', applicantEmail: '', customerEmail: '',
        paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'candidate_review',
      },
      [`${orderPath}/automation/flow`]: {
        state: 'candidate_review', round: 2, deadlineAt: now + 10_000, reminderAt: now + 5_000,
        draftCandidateEmailRecoveryVersion: DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
        answers: { eligibility: 'unknown' }, questionAnswers: { q1: 'unknown' },
      },
      [`${orderPath}/ai_drafts/current`]: {
        status: 'ready', round: 2, completedAt: now - 10_000,
        coverLetterPdfKey: `assisted-application-uploads/${orderId}/old-letter.pdf`,
        coverLetter: { salutation: 'Gentili Signori', paragraphs: ['Testo già approvato.'], closing: 'Cordiali saluti' },
        questions: [{ id: 'q1', question: 'Dato verificato?', type: 'text' }],
        answerLedger: { q1: { source: 'candidate', value: 'unknown' } },
        tailoredCv: {
          status: 'ready', pdfKey: `assisted-application-uploads/${orderId}/old-cv.pdf`,
          cv: { type: 'qualified', sector: 'other', language: 'it', headline: 'Analista', summary: 'Esperienza documentata.', competencies: [], experience: [], skills: [], localized: {} },
        },
      },
      ...(clickedAt ? {
        [`${orderPath}/automation/submission`]: { r2: { state: 'failed', clickedAt, confirmedNotSent: true } },
      } : {}),
    });
    const files = new Map([
      [`assisted-application-uploads/${orderId}/old-letter.pdf`, Buffer.from('old letter without contact')],
      [`assisted-application-uploads/${orderId}/old-cv.pdf`, Buffer.from('old cv without contact')],
    ]);
    const bucket = {
      file(key: string) {
        return {
          async save(data: Buffer) { files.set(key, Buffer.from(data)); },
          async download() { return [files.get(key)]; },
          async delete() { files.delete(key); },
        };
      },
    };
    return { ...store, bucket, files };
  }

  const renderLetter = async ({ order, draft, flow, orderId: id, dateMs }: any) => {
    const blocks = letterBlocksFor({ order, orderId: id, draft, flow, nowMs: now, dateMs });
    return { pdf: Buffer.from(JSON.stringify(blocks)), renderer: 'test' };
  };
  const renderCv = async ({ bucket, order, draft, flow, orderId: id }: any) => {
    const cv = tailoredCvDocumentFor({ order, draft, flow });
    const email = candidateDocumentIdentity(candidateWithEdits({ order, draft, flow }).identity, order).email;
    const pdfKey = `assisted-application-uploads/${id}/recovered-cv.pdf`;
    const pdf = Buffer.from(JSON.stringify({ contact: cv?.contact, email }));
    await bucket.file(pdfKey).save(pdf);
    return { pdfKey, renderer: 'test', photo: false, size: pdf.length };
  };

  it('recognizes only failed-precondition errors that identify a missing index', () => {
    expect(isFirestoreIndexUnavailableError(Object.assign(new Error(
      '9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index for collection automation',
    ), { code: 9 }))).toBe(true);
    expect(isFirestoreIndexUnavailableError(Object.assign(new Error('query requires an index'), { code: 9 }))).toBe(true);
    expect(isFirestoreIndexUnavailableError(Object.assign(new Error('index is unavailable'), { code: 13 }))).toBe(false);
  });

  it('warns and defers candidate-document recovery while its collection-group index is unavailable', async () => {
    const indexError = Object.assign(new Error(
      '9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index for collection automation',
    ), { code: 9 });
    const get = vi.fn().mockRejectedValue(indexError);
    const limit = vi.fn(() => ({ get }));
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const collectionGroup = vi.fn(() => ({ where }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await reconcileCandidateDocumentEmails({ db: { collectionGroup }, nowMs: now });

      expect(collectionGroup).toHaveBeenCalledWith('automation');
      expect(where).toHaveBeenCalledWith(
        'draftCandidateEmailRecoveryVersion', '==', DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
      );
      expect(orderBy).toHaveBeenCalledWith('__name__');
      expect(result).toMatchObject({ scanned: 0, indexUnavailable: true, apply: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferred until a later deploy'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps unrelated Firestore failures fatal', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 7 });
    const get = vi.fn().mockRejectedValue(error);
    const db = {
      collectionGroup: () => ({
        where: () => ({ orderBy: () => ({ limit: () => ({ get }) }) }),
      }),
    };

    await expect(reconcileCandidateDocumentEmails({ db, nowMs: now })).rejects.toBe(error);
  });

  it('adds the registered email to rendered documents once without changing state, answers, or letter text', async () => {
    const store = documentFixture();
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };
    const beforeOrder = store.read(orderPath);
    const beforeFlow = store.read(`${orderPath}/automation/flow`);
    const beforeDraft = store.read(`${orderPath}/ai_drafts/current`);
    const result = await recoverCandidateDocumentEmail({
      db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter, renderCv,
    });

    expect(result).toMatchObject({ status: 'updated', documents: ['letter', 'tailored_cv'] });
    const flow = store.read(`${orderPath}/automation/flow`);
    const draft = store.read(`${orderPath}/ai_drafts/current`);
    expect(store.read(orderPath)).toEqual(beforeOrder);
    expect(flow).toMatchObject({
      state: beforeFlow.state, round: beforeFlow.round, deadlineAt: beforeFlow.deadlineAt,
      reminderAt: beforeFlow.reminderAt, answers: beforeFlow.answers, questionAnswers: beforeFlow.questionAnswers,
      draftCandidateEmailDocumentRecoveryVersion: DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION,
    });
    expect(draft).toMatchObject({
      questions: beforeDraft.questions, answerLedger: beforeDraft.answerLedger, coverLetter: beforeDraft.coverLetter,
    });
    const letterBytes = [...store.files.entries()].find(([key]) => key.includes('ai-cover-letter-r2-email-recovery-'))?.[1];
    const cvBytes = store.files.get(draft.tailoredCv.pdfKey);
    expect(letterBytes?.toString()).toContain('account@example.test');
    expect(letterBytes?.toString()).toContain('Testo già approvato.');
    expect(cvBytes?.toString()).toContain('account@example.test');
    expect(JSON.stringify(store.read(`${orderPath}/events/candidate-email-document-recovery-r2`)))
      .not.toContain('account@example.test');

    const fileCount = store.files.size;
    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now + 1,
      renderLetter, renderCv })).toMatchObject({ status: 'ineligible' });
    expect(store.files.size).toBe(fileCount);
  });

  it('does not modify a draft when the current submission round has click evidence', async () => {
    const store = documentFixture({ clickedAt: now - 1 });
    const beforeFlow = store.read(`${orderPath}/automation/flow`);
    const beforeDraft = store.read(`${orderPath}/ai_drafts/current`);
    const beforeFiles = new Map(store.files);
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };

    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter, renderCv })).toMatchObject({ status: 'ineligible', reason: 'send_evidence' });
    expect(store.read(`${orderPath}/automation/flow`)).toEqual(beforeFlow);
    expect(store.read(`${orderPath}/ai_drafts/current`)).toEqual(beforeDraft);
    expect(store.read(`${orderPath}/events/candidate-email-document-recovery-r2`)).toBeUndefined();
    expect(store.files).toEqual(beforeFiles);
  });

  it('does not render documents when a submit dispatch round is malformed', async () => {
    const store = documentFixture();
    const flowPath = `${orderPath}/automation/flow`;
    const draftPath = `${orderPath}/ai_drafts/current`;
    store.docs.set(flowPath, {
      ...store.read(flowPath), round: 1, dispatch: { mode: 'submit', round: 'unknown' },
    });
    store.docs.set(draftPath, { ...store.read(draftPath), round: 1 });
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };
    let letterRenderCount = 0;
    let cvRenderCount = 0;
    const trackedRenderLetter = async (input: any) => {
      letterRenderCount++;
      return renderLetter(input);
    };
    const trackedRenderCv = async (input: any) => {
      cvRenderCount++;
      return renderCv(input);
    };

    expect(await recoverCandidateDocumentEmail({
      db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter: trackedRenderLetter, renderCv: trackedRenderCv,
    })).toMatchObject({ status: 'ineligible', reason: 'send_evidence' });
    expect(letterRenderCount).toBe(0);
    expect(cvRenderCount).toBe(0);
  });

  it('leaves a ready in-place CV unchanged when the new DOCX cannot be page-verified and records a safe audit event', async () => {
    const store = documentFixture();
    const path = `${orderPath}/ai_drafts/current`;
    const beforeDraft = store.read(path);
    store.docs.set(path, {
      ...beforeDraft,
      tailoredCv: {
        ...beforeDraft.tailoredCv,
        inplace: {
          status: 'ready',
          docxKey: `assisted-application-uploads/${orderId}/inplace.docx`,
          baseKey: `assisted-application-uploads/${orderId}/base.docx`,
          verifiedKey: `assisted-application-uploads/${orderId}/verified.docx`,
        },
      },
    });
    const expectedDraft = store.read(path);
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };

    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter, renderCv })).toMatchObject({ status: 'skipped', reason: 'inplace_page_check_required' });
    expect(store.read(path)).toEqual(expectedDraft);
    expect(store.read(`${orderPath}/events/candidate-email-document-recovery-r2`)).toMatchObject({
      result: 'skipped', reason: 'inplace_page_check_required', documents: [],
    });
    expect(JSON.stringify(store.read(`${orderPath}/events/candidate-email-document-recovery-r2`)))
      .not.toContain('account@example.test');
  });

  it('keeps the page-verified in-place document selected when its rebuilt identity matches the verified file', async () => {
    const store = documentFixture();
    const path = `${orderPath}/ai_drafts/current`;
    const beforeDraft = store.read(path);
    const inplace = {
      status: 'ready', docxKey: `assisted-application-uploads/${orderId}/old-inplace.docx`,
      baseKey: `assisted-application-uploads/${orderId}/base.docx`,
      verifiedKey: `assisted-application-uploads/${orderId}/verified.docx`,
    };
    store.docs.set(path, { ...beforeDraft, tailoredCv: { ...beforeDraft.tailoredCv, inplace } });
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };
    const renderInPlace = async ({ order, draft, flow }: any) => {
      expect(candidateDocumentIdentity(candidateWithEdits({ order, draft, flow }).identity, order).email)
        .toBe('account@example.test');
      return { ...inplace, docxKey: inplace.verifiedKey };
    };

    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter, renderCv, renderInPlace })).toMatchObject({ status: 'updated' });
    expect(store.read(path).tailoredCv.inplace).toMatchObject({
      status: 'ready', docxKey: inplace.verifiedKey,
    });
  });

  it('persists a verified in-place repair when it is the only renderable document', async () => {
    const store = documentFixture();
    const path = `${orderPath}/ai_drafts/current`;
    const beforeDraft = store.read(path);
    const inplace = {
      status: 'ready', docxKey: `assisted-application-uploads/${orderId}/old-inplace.docx`,
      baseKey: `assisted-application-uploads/${orderId}/base.docx`,
      verifiedKey: `assisted-application-uploads/${orderId}/verified.docx`,
    };
    store.docs.set(path, {
      ...beforeDraft,
      coverLetterPdfKey: null,
      tailoredCv: { inplace, status: 'ready', cv: null, pdfKey: null },
    });
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };
    const renderInPlace = async ({ order, draft, flow }: any) => {
      expect(candidateDocumentIdentity(candidateWithEdits({ order, draft, flow }).identity, order).email)
        .toBe('account@example.test');
      return { ...inplace, docxKey: inplace.verifiedKey };
    };

    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter, renderCv, renderInPlace })).toMatchObject({ status: 'updated', documents: ['in_place_cv'] });
    expect(store.read(path).tailoredCv.inplace).toMatchObject({
      status: 'ready', docxKey: inplace.verifiedKey,
    });
  });

  it('retries a render failure once after backoff, then records a terminal event', async () => {
    const store = documentFixture();
    const auth = { getUser: async () => ({ email: 'account@example.test', emailVerified: true }) };
    let renderAttempts = 0;
    const failLetter = async () => {
      renderAttempts++;
      throw new Error('renderer_unavailable');
    };
    const first = await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now,
      renderLetter: failLetter, renderCv });
    expect(first).toMatchObject({ status: 'retry_scheduled', reason: 'render_unavailable' });
    expect(store.read(`${orderPath}/automation/flow`)).toMatchObject({
      state: 'candidate_review', deadlineAt: now + 10_000,
      draftCandidateEmailDocumentRecoveryAttemptCount: 1,
      draftCandidateEmailDocumentRecoveryStartedAt: 0,
      draftCandidateEmailDocumentRecoveryRetryAt: now + DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS,
    });
    expect(store.read(`${orderPath}/automation/flow`).draftCandidateEmailDocumentRecoveryVersion).toBeUndefined();

    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: now + 1,
      renderLetter: failLetter, renderCv })).toMatchObject({ status: 'ineligible', reason: 'backoff' });
    expect(renderAttempts).toBe(1);

    const retryAt = now + DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS;
    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: retryAt,
      renderLetter: failLetter, renderCv })).toMatchObject({ status: 'skipped', reason: 'render_unavailable' });
    expect(renderAttempts).toBe(2);
    expect(store.read(`${orderPath}/automation/flow`)).toMatchObject({
      state: 'candidate_review', deadlineAt: now + 10_000,
      draftCandidateEmailDocumentRecoveryAttemptCount: 2,
      draftCandidateEmailDocumentRecoveryVersion: DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION,
    });
    expect(await recoverCandidateDocumentEmail({ db: store.db, bucket: store.bucket, auth, orderId, nowMs: retryAt + 1,
      renderLetter: failLetter, renderCv })).toMatchObject({ status: 'ineligible' });
    expect(renderAttempts).toBe(2);
  });
});
