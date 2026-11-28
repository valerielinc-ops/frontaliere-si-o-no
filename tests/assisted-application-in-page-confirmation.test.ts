import { describe, expect, it } from 'vitest';
import { inPageConfirmation, inPageConfirmationText } from '../scripts/assisted-application/lib/portal/in-page-confirmation.mjs';
import { evidenceHoldsTheClick, inPageConfirmationFromEvidence, inPageReconcileBlocker, sendRunCandidates } from '../scripts/assisted-application/reconcile-inpage-confirmation.mjs';
import { createSubmissionReceipt, verifySubmissionReceipt } from '../functions/src/lib/submissionReceiptContract.js';

const page = 'https://employer.example/it/lavora-con-noi/';
const thanks = 'La tua candidatura è stata inviata correttamente. Se il tuo profilo è in linea con una figura da noi ricercata sarai ricontattato a breve. Grazie per esserti candidato!';
const intro = 'Lavora con noi\nCandidatura Spontanea\nNome\nCognome\nPosizione\nINVIA CANDIDATURA';
const goneForm = { url: page, text: `Lavora con noi\n${thanks}`, errors: [], fields: [], buttons: [{ text: 'Home', chrome: true }] };
const posted = [{ phase: 'submit', host: 'employer.example', method: 'POST', status: 200 }];
const run = (overrides: Record<string, unknown> = {}) => inPageConfirmation({
  beforeText: intro, afterSnapshot: goneForm, submissionUrl: page, responses: posted, ...overrides,
} as any);

describe('in-page confirmation after the final click', () => {
  it('confirms when the thank-you became visible, the form is gone and the send request was answered 2xx', () => {
    expect(run()).toEqual({ confirmed: true, reason: 'in_page_confirmation' });
  });

  it('reads the thank-yous of other sites, and never a negated one', () => {
    for (const text of ['Ihre Bewerbung wurde erfolgreich gesendet.', 'Vielen Dank für Ihre Bewerbung', 'Votre candidature a bien été envoyée', 'Thank you for applying', 'Your application has been submitted.']) {
      expect(inPageConfirmationText(text)).not.toBe('');
    }
    expect(inPageConfirmationText('La candidatura non è stata inviata.')).toBe('');
    expect(inPageConfirmationText('Lavora con noi')).toBe('');
  });

  it('stays ambiguous when the same text was already visible before the click', () => {
    expect(run({ beforeText: `${intro}\n${thanks}` })).toMatchObject({ confirmed: false, reason: 'confirmation_visible_before_click' });
  });

  it('stays ambiguous when the text before the click is unknown, unless the saved evidence of an older run is reconciled', () => {
    expect(run({ beforeText: null })).toMatchObject({ confirmed: false, reason: 'before_click_text_unknown' });
    expect(run({ beforeText: null, allowUnknownBefore: true }).confirmed).toBe(true);
  });

  it('stays ambiguous while the form or its send control is still visible', () => {
    const withField = { ...goneForm, fields: [{ inputType: 'file', disabled: false }] };
    const withButton = { ...goneForm, buttons: [{ text: 'INVIA CANDIDATURA', disabled: false }] };
    expect(run({ afterSnapshot: withField })).toMatchObject({ reason: 'form_still_visible' });
    expect(run({ afterSnapshot: withButton })).toMatchObject({ reason: 'form_still_visible' });
    // disabled controls are no live form
    expect(run({ afterSnapshot: { ...withButton, buttons: [{ text: 'INVIA CANDIDATURA', disabled: true }] } }).confirmed).toBe(true);
  });

  it('stays ambiguous with an error on screen', () => {
    expect(run({ afterSnapshot: { ...goneForm, errors: ['observed'] } })).toMatchObject({ confirmed: false, reason: 'error_visible' });
    expect(run({ afterSnapshot: { ...goneForm, text: `${goneForm.text}\nCampo obbligatorio` } })).toMatchObject({ reason: 'error_visible' });
    expect(run({ afterSnapshot: { ...goneForm, text: `${goneForm.text}\nNon siamo riusciti a inviare la tua candidatura.` } })).toMatchObject({ reason: 'error_visible' });
  });

  it('stays ambiguous without a 2xx answer to a same-origin send request of the submit phase', () => {
    expect(run({ responses: [] })).toMatchObject({ reason: 'no_submit_response' });
    expect(run({ responses: [{ phase: 'submit', host: 'employer.example', method: 'GET', status: 200 }] })).toMatchObject({ reason: 'no_submit_response' });
    expect(run({ responses: [{ phase: 'navigation', host: 'employer.example', method: 'POST', status: 200 }] })).toMatchObject({ reason: 'no_submit_response' });
    expect(run({ responses: [{ phase: 'submit', host: 'tracker.example', method: 'POST', status: 200 }] })).toMatchObject({ reason: 'no_submit_response' });
    expect(run({ responses: [...posted, { phase: 'submit', host: 'employer.example', method: 'POST', status: 500 }] })).toMatchObject({ reason: 'submit_response_failed' });
  });

  it('stays ambiguous when the page moved or says nothing', () => {
    expect(run({ afterSnapshot: { ...goneForm, url: 'https://employer.example/altro/' } })).toMatchObject({ reason: 'url_changed' });
    expect(run({ afterSnapshot: { ...goneForm, text: 'Lavora con noi' } })).toMatchObject({ reason: 'no_confirmation_text' });
  });
});

describe('reconciliation of orders stopped on portal_ambiguous', () => {
  const payload = (evidence: Record<string, unknown> = {}) => ({
    event: { type: 'submit_failed', error: 'portal_ambiguous' },
    evidence: {
      finalOutcomes: ['ambiguous'], finalButton: { label: 'INVIA CANDIDATURA', by: 'runner' }, submissionUrl: page, finalUrl: page,
      afterSubmitSnapshot: goneForm, diagnostics: { responses: posted }, ...evidence,
    },
  });

  it('applies the runner\'s rule to the saved fields', () => {
    expect(inPageConfirmationFromEvidence(payload()).confirmed).toBe(true);
    expect(inPageConfirmationFromEvidence(payload({ preSubmitConfirmationVisible: false })).confirmed).toBe(true);
    expect(inPageConfirmationFromEvidence(payload({ preSubmitConfirmationVisible: true }))).toMatchObject({ confirmed: false });
    expect(inPageConfirmationFromEvidence(payload({ diagnostics: { responses: [] } }))).toMatchObject({ confirmed: false, reason: 'no_submit_response' });
    expect(inPageConfirmationFromEvidence(payload({ afterSubmitSnapshot: { ...goneForm, fields: [{ inputType: 'file' }] } }))).toMatchObject({ confirmed: false });
    expect(inPageConfirmationFromEvidence(payload({ finalOutcomes: ['validation'] }))).toMatchObject({ confirmed: false });
    expect(inPageConfirmationFromEvidence(payload({ finalButton: { label: 'x', by: 'agent' } }))).toMatchObject({ confirmed: false });
    expect(inPageConfirmationFromEvidence({ event: { type: 'submit_failed', error: 'portal_refused' }, evidence: payload().evidence })).toMatchObject({ confirmed: false });
  });

  it('touches only an owner_takeover held by portal_ambiguous with a clicked, unreceipted, bound record', () => {
    const flow = { state: 'owner_takeover', heldBy: ['portal_ambiguous'] };
    const record = { state: 'sending', channel: 'portal', clickedAt: 1, attemptId: 'a1', formBinding: 'f'.repeat(64) };
    expect(inPageReconcileBlocker({ order: {}, flow, record })).toBe('');
    expect(inPageReconcileBlocker({ order: {}, flow: { ...flow, heldBy: ['other'] }, record })).toBe('not_held_by_portal_ambiguous');
    expect(inPageReconcileBlocker({ order: {}, flow: { state: 'submitted' }, record })).toBe('flow_not_owner_takeover');
    expect(inPageReconcileBlocker({ order: {}, flow, record: { ...record, state: 'sent' } })).toBe('record_not_sending');
    expect(inPageReconcileBlocker({ order: {}, flow, record: { ...record, clickedAt: 0 } })).toBe('no_click_or_already_receipted');
    expect(inPageReconcileBlocker({ order: {}, flow, record: { ...record, formBinding: '' } })).toBe('record_unbound');
    expect(inPageReconcileBlocker({ order: { submissionStatus: 'submitted' }, flow, record })).toBe('already_submitted');
  });

  it('has its own receipt kind, bound to the round and the page', () => {
    const receipt = createSubmissionReceipt({
      orderId: 'order-1', round: 1, attemptId: 'a1', channel: 'portal', proofKind: 'portal_in_page_confirmation',
      evidence: { finalUrl: page }, sentRecord: {}, observedAt: 5,
    });
    expect(receipt).toMatchObject({ proofKind: 'portal_in_page_confirmation' });
    expect(verifySubmissionReceipt(receipt, { orderId: 'order-1', round: 1, attemptId: 'a1', channel: 'portal', sentRecord: {} })).toBe(true);
    expect(createSubmissionReceipt({ orderId: 'order-1', round: 1, attemptId: 'a1', channel: 'portal', proofKind: 'portal_in_page_confirmation', evidence: {}, sentRecord: {}, observedAt: 5 })).toBeNull();
  });
});

describe('which stored run holds the click', () => {
  const file = (at: number, createdAt: number) => ({ name: `assisted-application-uploads/order-1/run-${at}-submit-portal-submit_failed.json.enc`, createdAt });
  const click = 1_000_000_000_000;
  it('takes the run that started before the click and wrote its evidence after it, the closest first', () => {
    expect(sendRunCandidates([file(click - 3_600_000, click + 5_000), file(click - 51_000, click + 20_000)], click).map((c) => c.at)).toEqual([click - 51_000, click - 3_600_000]);
  });
  it('drops a run that started after the click or too long before it', () => {
    expect(sendRunCandidates([file(click + 1, click + 9)], click)).toEqual([]);
    expect(sendRunCandidates([file(click - 151 * 60 * 1000, click + 9)], click)).toEqual([]);
    expect(sendRunCandidates([{ name: 'assisted-application-uploads/order-1/run-5-other.json.enc', createdAt: click + 1 }], click)).toEqual([]);
  });
  it('never takes the evidence of an earlier attempt, written before this click', () => {
    // click now at T; closest run (T-1) wrote nothing usable here, the older run (T-2) wrote its evidence before T
    expect(sendRunCandidates([file(click - 2_000_000, click - 1_000_000)], click)).toEqual([]);
    expect(sendRunCandidates([file(click - 51_000, click + 40 * 60 * 1000)], click)).toEqual([]);
    expect(sendRunCandidates([file(click - 51_000, Number.NaN)], click)).toEqual([]);
  });
  it('accepts only evidence that reached the final click and carries the same form binding when it has one', () => {
    const hit = { finalOutcomes: ['ambiguous'], finalButton: { by: 'runner' } };
    expect(evidenceHoldsTheClick({ evidence: hit }, { formBinding: 'a' })).toBe(true);
    expect(evidenceHoldsTheClick({ evidence: { ...hit, formBinding: 'a' } }, { formBinding: 'a' })).toBe(true);
    expect(evidenceHoldsTheClick({ evidence: { ...hit, formBinding: 'b' } }, { formBinding: 'a' })).toBe(false);
    expect(evidenceHoldsTheClick({ evidence: { finalOutcomes: [] } }, {})).toBe(false);
    expect(evidenceHoldsTheClick({}, {})).toBe(false);
  });
});

describe('only the form that was sent counts as still visible', () => {
  // The page after the send, as saved: the other forms of the page stay, the application form is gone.
  const otherForms = {
    fields: [
      { inputType: 'text' }, { inputType: 'text' }, { inputType: '' }, { inputType: '' }, { inputType: '' }, { inputType: 'text' },
      { inputType: 'text', formId: 'f-news' }, { inputType: 'email', formId: 'f-news' }, { inputType: 'checkbox', formId: 'f-news' },
    ],
    buttons: ['Prenota ora', 'ITA', 'Toggle navigation', 'Iscriviti', 'Accetta tutti i cookie', 'Seleziona i cookie'].map((text) => ({ text })),
  };
  const after = { ...goneForm, ...otherForms };
  const ask = (overrides: Record<string, unknown> = {}) => run({ afterSnapshot: after, finalLabel: 'INVIA CANDIDATURA', ...overrides });

  it('confirms with a booking widget and a newsletter form left on the page (saved evidence without form identity)', () => {
    expect(ask()).toEqual({ confirmed: true, reason: 'in_page_confirmation' });
  });

  it('confirms by form identity when the evidence has it, whatever the other forms hold', () => {
    expect(ask({ submittedFormId: 'f-application' }).confirmed).toBe(true);
  });

  it('stays ambiguous while the send control or the CV upload of the sent form is still there', () => {
    expect(ask({ afterSnapshot: { ...after, buttons: [...after.buttons, { text: 'INVIA CANDIDATURA' }] } })).toMatchObject({ reason: 'form_still_visible' });
    expect(ask({ afterSnapshot: { ...after, fields: [...after.fields, { inputType: 'file' }] } })).toMatchObject({ reason: 'form_still_visible' });
    expect(ask({ submittedFormId: 'f-application', afterSnapshot: { ...after, fields: [...after.fields, { inputType: 'text', formId: 'f-application' }] } })).toMatchObject({ reason: 'form_still_visible' });
    expect(ask({ submittedFormId: 'f-application', afterSnapshot: { ...after, buttons: [...after.buttons, { text: 'Invia', formId: 'f-application' }] } })).toMatchObject({ reason: 'form_still_visible' });
  });

  it('does not let a disabled or chrome control of the sent form keep it open', () => {
    expect(ask({ submittedFormId: 'f-application', afterSnapshot: { ...after, buttons: [...after.buttons, { text: 'Invia', formId: 'f-application', disabled: true }] } }).confirmed).toBe(true);
  });
});
