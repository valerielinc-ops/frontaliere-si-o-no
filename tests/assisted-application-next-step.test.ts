// services/assistedApplicationNextStep.ts: whose move it is on each order of
// the owner queue. Owner request 2026-10-03: every order read «Pronte»; the
// cases below are the queue of that morning.
import { describe, expect, it } from 'vitest';
import { nextStepFor, type NextStepOrder } from '../services/assistedApplicationNextStep';

const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const order = (flow: Record<string, unknown> | null, extra: Partial<NextStepOrder> = {}): NextStepOrder => ({
  submissionStatus: 'ready_for_manual_submission',
  hasCv: true,
  paidAt: new Date(NOW - 48 * HOUR).toISOString(),
  automation: flow ? { flow: { heldBy: [], deadlineAt: null, history: [], ...flow } as any } : null,
  ...extra,
});
const step = (flow: Record<string, unknown> | null, extra: Partial<NextStepOrder> = {}) => nextStepFor(order(flow, extra), NOW);

describe('next step of an assisted-application order', () => {
  it('waits for the candidate: answers or documents missing, or their approval', () => {
    // Medbase: one answer only the candidate can give, first reminder sent.
    const held = step({ state: 'candidate_review', heldBy: ['question:school_performance'], reminderAt: NOW + 44 * HOUR, history: [{ at: NOW - 30 * HOUR, event: 'owner_approve', state: 'candidate_review' }] });
    expect(held).toMatchObject({ group: 'candidate', code: 'waiting_candidate_answers', label: 'Aspetta il candidato' });
    expect(held.detail).toContain('Mancano 1 risposta che solo lui può dare (da 30 ore)');
    expect(held.detail).toContain('promemoria a 24 e 72 ore');
    // Rolex after a new draft: school reports and two test results.
    expect(step({ state: 'candidate_review', heldBy: ['question:work_permit', 'document:reports', 'document:eva'] }).detail).toContain('Mancano 1 risposta e 2 documenti');
    const approving = step({ state: 'candidate_review', heldBy: [], deadlineAt: NOW + 6 * HOUR });
    expect(approving).toMatchObject({ group: 'candidate', code: 'waiting_candidate_approval' });
    expect(approving.detail).toContain('Se non risponde parte da sola');
    expect(step({ state: 'needs_candidate_action', heldBy: ['question:portal_q'] })).toMatchObject({ group: 'candidate', code: 'waiting_candidate_portal' });
    expect(step({ state: 'candidate_handoff', heldBy: ['owner_handoff'] })).toMatchObject({ group: 'candidate', code: 'candidate_handoff' });
  });

  it('waits for the CV, and says when it has been too long', () => {
    const recent = step(null, { hasCv: false, submissionStatus: 'awaiting_upload', paidAt: new Date(NOW - 20 * HOUR).toISOString() });
    expect(recent).toMatchObject({ group: 'candidate', code: 'waiting_cv', label: 'Aspetta il CV' });
    expect(recent.detail).toContain('promemoria dopo 48 ore');
    // Paid twelve days ago, never a CV.
    const old = step(null, { hasCv: false, submissionStatus: 'awaiting_upload', paidAt: new Date(NOW - 12 * 24 * HOUR).toISOString() });
    expect(old.detail).toContain('pagato da 12 giorni');
    expect(old.detail).toContain('scrivigli, oppure avvia il rimborso');
  });

  it('is the owner\'s move: a draft to review, an order she took over, a send the extension completes', () => {
    expect(step({ state: 'owner_review', deadlineAt: NOW + HOUR })).toMatchObject({ group: 'owner', code: 'review', label: 'Bozza da rivedere' });
    expect(step({ state: 'owner_review', heldBy: ['fact_check'] })).toMatchObject({ group: 'owner', code: 'review_held' });
    // Rolex: taken over to ask for the documents the posting requires.
    const taken = step({ state: 'owner_takeover', heldBy: ['owner'] });
    expect(taken).toMatchObject({ group: 'owner', code: 'owner_took_over', label: 'Presa in carico da te' });
    expect(taken.detail).toContain('«Rigenera»');
    // TSMG: an anti-robot check, the form itself was fine.
    for (const held of ['portal:captcha', 'portal_refused', 'portal_antibot_ambiguous', 'portal:rejected']) {
      expect(step({ state: 'owner_takeover', heldBy: [held] })).toMatchObject({ group: 'owner', code: 'complete_with_extension', label: 'Completa con l’estensione' });
    }
    expect(step({ state: 'owner_takeover', heldBy: ['portal_ambiguous'] })).toMatchObject({ group: 'owner', code: 'check_if_received' });
    expect(step({ state: 'owner_takeover', heldBy: ['draft_failed'] })).toMatchObject({ group: 'owner', code: 'regenerate', label: 'Da rigenerare' });
    expect(step({ state: 'owner_takeover', heldBy: ['max_rounds'] })).toMatchObject({ group: 'owner', code: 'contact_candidate' });
    expect(step({ state: 'owner_takeover', heldBy: ['email_failed'] })).toMatchObject({ group: 'owner', code: 'retry_or_complete' });
    expect(step(null, { hasCv: true })).toMatchObject({ group: 'owner', code: 'start', label: 'Da avviare' });
    expect(step(null, { submissionStatus: 'blocked' })).toMatchObject({ group: 'owner', code: 'blocked_by_owner' });
  });

  it('needs a fix the extension cannot replace: the portal\'s account, a page the robot cannot fill', () => {
    // Coop on SuccessFactors: the registration refused the account.
    for (const held of ['portal:account_create_refused', 'portal:account', 'portal:account_sign_in_failed', 'portal:account_verification_timeout']) {
      const blocked = step({ state: 'owner_takeover', heldBy: [held] });
      expect(blocked).toMatchObject({ group: 'fix', code: 'portal_account', label: 'Bloccata: account sul portale' });
      expect(blocked.detail).toContain('non crea account');
    }
    expect(step({ state: 'owner_takeover', heldBy: ['portal:portal_needs_candidate'] })).toMatchObject({ group: 'fix', code: 'portal_page' });
    expect(step({ state: 'owner_takeover', heldBy: ['portal_validation'] })).toMatchObject({ group: 'fix', code: 'portal_page' });
    expect(step({ state: 'owner_takeover', heldBy: ['portal:posting_mismatch'] })).toMatchObject({ group: 'owner', code: 'check_form' });
  });

  it('is the robot\'s, or over', () => {
    expect(step({ state: 'drafting', dispatch: { requestedAt: NOW - 5 * 60 * 1000 } })).toMatchObject({ group: 'robot', code: 'drafting' });
    expect(step({ state: 'regenerating' })).toMatchObject({ group: 'robot', code: 'drafting' });
    expect(step({ state: 'submitting' })).toMatchObject({ group: 'robot', code: 'submitting' });
    expect(step({ state: 'submitted' })).toMatchObject({ group: 'done', code: 'submitted', label: 'Inviata' });
    // Sent by hand, with no flow at all.
    expect(step(null, { submissionStatus: 'submitted' })).toMatchObject({ group: 'done', code: 'submitted' });
    expect(step(null, { submissionStatus: 'refunded' })).toMatchObject({ group: 'done', code: 'refunded' });
    expect(step({ state: 'owner_takeover', heldBy: ['posting_closed'] })).toMatchObject({ group: 'done', code: 'posting_closed' });
  });
});
