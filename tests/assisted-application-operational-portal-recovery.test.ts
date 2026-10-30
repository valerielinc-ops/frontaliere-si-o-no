import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcilePortalCode } from '../scripts/assisted-application/reconcile-portal-code.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';

const base = 'assisted_applications/operational_recovery_fixture';
const now = Date.now();
const version = 'b'.repeat(64);
const notice = { id: 'notice', source: 'portal', question: 'Attuale periodo di preavviso', type: 'choice', options: [], required: true };
function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'owner_takeover', automationDueAt: null, consentVersion: 'assisted-application-v2', consentedAt: now - 2000, cvUploadedAt: now - 2000 },
    [`${base}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal:portal_needs_candidate'], answers: { notice: '7 giorni' }, dispatch: { mode: 'submit', round: 1, requestedAt: now - 500 }, portalCodeVersion: 'a'.repeat(64) },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, completedAt: now - 1000, questions: [notice], job: { source: 'job_detail' }, channel: { type: 'employer_site' }, factCheck: { ok: true } },
    [`${base}/automation/submission`]: { r1: { state: 'failed', channel: 'portal', clickedAt: null, releasedAt: now - 100 } },
  });
}
const context = (store: any) => ({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true });

describe('source-version recovery of positively identified operational portal questions', () => {
  it('queues native discovery for an old empty catalogue once, preserving the explicit answer and approved round', async () => {
    const store = fixture();
    const flowBefore = store.read(`${base}/automation/flow`);
    const draftBefore = store.read(`${base}/ai_drafts/current`);
    expect(await reconcilePortalCode(context(store))).toMatchObject({ queued: 1 });
    const flow = store.read(`${base}/automation/flow`);
    expect(flow).toMatchObject({ state: 'owner_takeover', round: 1, answers: flowBefore.answers, dispatch: flowBefore.dispatch, portalRecoveryVersion: version });
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(draftBefore);
    expect(transition(flow, { type: 'portal_auto_retry' }, { draft: draftBefore, nowMs: now }).effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
    expect(await reconcilePortalCode(context(store))).toMatchObject({ queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(1);
  });

  it.each([
    ['Notice period', '3 months'], ['Kündigungsfrist', '2 Monate'], ['Délai de préavis', 'deux mois'],
    ['Grado di occupazione desiderato', '80%'], ['Comunicazione via WhatsApp', 'No'],
  ])('accepts an explicit operational answer only for its known question: %s', async (question, answer) => {
    const store = fixture();
    store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions: [{ ...notice, question }] });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), answers: { notice: answer } });
    expect(await reconcilePortalCode(context(store))).toMatchObject({ queued: 1 });
  });

  it('uses the owner default only when the operational answer is absent', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), answers: {} });
    expect(await reconcilePortalCode(context(store))).toMatchObject({ queued: 1 });
    expect(store.read(`${base}/automation/flow`).answers).toEqual({});
  });

  it.each(['hard', 'unknown', 'non_portal', 'no_questions', 'uncertain', 'incompatible_catalogue', 'file_missing', 'click', 'old_click', 'sent', 'attempt', 'withdrawn', 'round', 'not_approved', 'stale_approval', 'same_source', 'no_consent', 'retention', 'unpaid'])('does not queue %s', async kind => {
    const store = fixture();
    const flow = store.read(`${base}/automation/flow`);
    const draft = store.read(`${base}/ai_drafts/current`);
    if (kind === 'hard') draft.questions.push({ ...notice, id: 'degree', question: 'Do you hold a degree?', type: 'text' });
    if (kind === 'unknown') draft.questions.push({ ...notice, id: 'other', question: 'Additional information', type: 'text' });
    if (kind === 'non_portal') draft.questions[0].source = 'cv_match';
    if (kind === 'no_questions') draft.questions = [];
    if (kind === 'uncertain') flow.answers.notice = 'not sure';
    if (kind === 'incompatible_catalogue') draft.questions[0].options = ['3 mesi'];
    if (kind === 'file_missing') draft.requiredDocuments = [{ id: 'certificate', label: 'Certificate', kind: 'certificate', required: true }];
    if (kind === 'round') draft.round = 2;
    if (kind === 'not_approved') flow.dispatch.mode = 'draft';
    if (kind === 'stale_approval') flow.dispatch.requestedAt = draft.completedAt - 1;
    if (kind === 'same_source') flow.portalCodeVersion = version;
    if (kind === 'attempt') draft.sentAttempt = { at: now };
    store.docs.set(`${base}/automation/flow`, flow);
    store.docs.set(`${base}/ai_drafts/current`, draft);
    if (kind === 'click') store.docs.set(`${base}/automation/submission`, { r1: { state: 'failed', channel: 'portal', clickedAt: now, releasedAt: now } });
    if (kind === 'old_click') store.docs.set(`${base}/automation/submission`, { ...store.read(`${base}/automation/submission`), r0: { state: 'failed', channel: 'portal', clickedAt: now - 2000 } });
    if (kind === 'sent') store.docs.set(`${base}/automation/submission`, { r1: { state: 'sent', channel: 'portal', sentAt: now } });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'no_consent') store.docs.set(base, { ...store.read(base), consentVersion: 'unknown' });
    if (kind === 'retention') store.docs.set(base, { ...store.read(base), cvUploadedAt: now - 91 * 86400000 });
    if (kind === 'unpaid') store.docs.set(base, { ...store.read(base), paymentStatus: 'refunded' });
    const before = store.read(`${base}/automation/flow`);
    expect(await reconcilePortalCode(context(store))).toMatchObject({ queued: 0 });
    expect(store.read(`${base}/automation/flow`)).toEqual(before);
    expect(store.read(base).automationDueAt).toBeNull();
  });
});
