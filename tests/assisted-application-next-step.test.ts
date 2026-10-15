// services/assistedApplicationNextStep.ts: whose move it is on each order of
// the owner queue. Owner request 2026-10-03: every order read «Pronte»; the
// cases below are the queue of that morning.
import { describe, expect, it } from 'vitest';
import { nextStepFor, type NextStepOrder } from '../services/assistedApplicationNextStep';
import { heldLabel } from '../components/pages/AssistedApplicationAutomationPanel';

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
    const heldReview = step({ state: 'owner_review', heldBy: ['fact_check'] });
    expect(heldReview).toMatchObject({ group: 'owner', code: 'review_held' });
    // #11026: a profile that is not a full match holds nothing any more, so it is no warning to confirm.
    expect(heldReview.detail).not.toContain('requisito mancante');
    // Rolex: taken over to ask for the documents the posting requires.
    const taken = step({ state: 'owner_takeover', heldBy: ['owner'] });
    expect(taken).toMatchObject({ group: 'owner', code: 'owner_took_over', label: 'Presa in carico da te' });
    expect(taken.detail).toContain('«Rigenera»');
    // TSMG: an anti-robot check, the form itself was fine.
    for (const held of ['portal:captcha', 'portal_refused', 'portal:rejected']) {
      expect(step({ state: 'owner_takeover', heldBy: [held] })).toMatchObject({ group: 'owner', code: 'complete_with_extension', label: 'Completa con l’estensione' });
    }
    // A send of unknown outcome may be at the employer: checked first, never straight to a second send (review of #11016).
    for (const held of ['portal_ambiguous', 'portal_antibot_ambiguous', 'email_ambiguous']) {
      const check = step({ state: 'owner_takeover', heldBy: [held] });
      expect(check).toMatchObject({ group: 'owner', code: 'check_if_received', label: 'Verifica se è arrivata' });
      expect(check.detail).toContain('Controlla se il datore l’ha ricevuta');
    }
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

  // #11161: a WhatsApp application (PastaHR, Coop's apprenticeships) has no form to fix or to fill. A retry
  // completes the order by e-mail when the channel has a PastaHR https link; otherwise it goes to the candidate.
  it('is the owner\'s move on a WhatsApp-only application: a retry with a PastaHR link, or the candidate', () => {
    const whatsapp = step({ state: 'owner_takeover', heldBy: ['portal:whatsapp'] });
    expect(whatsapp).toMatchObject({ group: 'owner', code: 'whatsapp', label: 'Solo via WhatsApp' });
    expect(whatsapp.detail).toContain('nella chat WhatsApp del datore');
    expect(whatsapp.detail).toContain('Se il canale ha un link PastaHR (https), «Riprova l’invio automatico» chiude l’ordine');
    expect(whatsapp.detail).toContain('altrimenti «Affida al candidato»');
    expect(whatsapp.detail).not.toContain('estensione');
    // The panel's «Fermo per» says the same two outcomes.
    const label = heldLabel('portal:whatsapp');
    expect(label).toContain('PastaHR (https)');
    expect(label).toContain('«Riprova l’invio automatico»');
    expect(label).toContain('«Affida al candidato»');
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

  // Close-out of 2026-10-03: the runner checks the facts again right before sending. A plain retry
  // would stop on the same facts: the owner confirms them (or corrects the texts) first.
  it('says how to release a send the fact gate stopped', () => {
    const stopped = step({ state: 'owner_takeover', heldBy: ['fact_check_not_acknowledged'] });
    expect(stopped).toMatchObject({ group: 'owner', code: 'confirm_facts', label: 'Conferma i fatti e riprova' });
    expect(stopped.detail).toContain('si è fermato prima di partire');
    expect(stopped.detail).toContain('«Ho verificato»');
    expect(stopped.detail).toContain('«Riprova l’invio automatico»');
    // Any other failed send keeps the generic move.
    expect(step({ state: 'owner_takeover', heldBy: ['email_failed'] })).toMatchObject({ group: 'owner', code: 'retry_or_complete' });
  });
});
