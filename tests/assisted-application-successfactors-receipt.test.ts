import { describe, expect, it } from 'vitest';
import { applicationReceipt, applicationStage } from '../scripts/assisted-application/lib/portal/stages.mjs';

// Helsana, order s2Tbwwjd, run 42843745620 (2026-11-10): «Bewerben» pressed on career5.successfactors.eu/portalcareer;
// the page after the click, as the run's after_submit diagnostics read it (page text only, no candidate data).
const applyUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34525&lang=de_DE&career_ns=job_application';
const submissionUrl = 'https://career5.successfactors.eu/portalcareer?_s.crb=synthetic';
const job = { title: 'IT Management Assistenz (a) 80%', company: 'Helsana' };
const receiptPage = {
  url: submissionUrl,
  text: 'Vielen Dank für Ihre Bewerbung. Ihre Angaben wurden übermittelt.\n\nZurück zum Stellenüberblick\nProfil anzeigen',
  fields: [],
  buttons: [{ text: 'Zurück zum Stellenüberblick' }, { text: 'Profil anzeigen' }],
  errors: [],
};
const context = { url: submissionUrl, applyUrl, submissionUrl, job };

describe('SuccessFactors receipt at the same session route (Helsana s2Tbwwjd)', () => {
  it('is a receipt after the runner\'s final click', () => {
    expect(applicationReceipt(receiptPage, context)).toBe(true);
    // The site's own language selector in the header (marked `chrome` by the extractor) is no form left on the page.
    expect(applicationReceipt({ ...receiptPage, fields: [{ label: 'Sprache', kind: 'combobox', required: false, value: 'Deutsch', chrome: true }] }, context)).toBe(true);
    for (const text of [
      'Your application has been submitted. Thank you for applying.',
      'La sua candidatura è stata inviata.',
      'Votre candidature a été envoyée.',
    ]) expect(applicationReceipt({ ...receiptPage, text }, context)).toBe(true);
  });

  it('is not a receipt when the form is still there, or anything else is off', () => {
    const form = {
      ...receiptPage,
      text: `Vielen Dank für Ihre Bewerbung bei Helsana.\nProfilinformationen\n* Vorname\n* Name\n* E-Mail\nBewerben`,
      fields: [{ label: '* Vorname', kind: 'text', inputType: 'text', required: true, value: '' }, { label: '* E-Mail', kind: 'text', inputType: 'email', required: true, value: '' }],
      buttons: [{ text: 'Speichern' }, { text: 'Profil anzeigen' }],
    };
    // A thank-you text with the form still present.
    expect(applicationReceipt(form, context)).toBe(false);
    // A submit control left on the page, a validation error, an invalid field.
    expect(applicationReceipt({ ...receiptPage, buttons: [...receiptPage.buttons, { text: 'Bewerben' }] }, context)).toBe(false);
    expect(applicationReceipt({ ...receiptPage, errors: ['Lebenslauf ist erforderlich'] }, context)).toBe(false);
    expect(applicationReceipt({ ...receiptPage, fields: [{ label: 'Sprache', kind: 'combobox', required: false, invalid: true }] }, context)).toBe(false);
    // An optional question named like a language is still a form field unless the extractor marked it `chrome`
    // (review of #17993).
    expect(applicationReceipt({ ...receiptPage, fields: [{ label: 'Language', required: false, chrome: false, disabled: false, inputType: 'text' }] }, context)).toBe(false);
    // No explicit confirmation, or the portal saying it was not sent.
    expect(applicationReceipt({ ...receiptPage, text: 'Ihre Angaben wurden gespeichert.\nProfil anzeigen' }, context)).toBe(false);
    expect(applicationReceipt({ ...receiptPage, text: 'Vielen Dank für Ihre Bewerbung. Ihre Bewerbung konnte nicht übermittelt werden.' }, context)).toBe(false);
    // Another origin, another route, or no observed final click (the stage reader before any submit).
    expect(applicationReceipt({ ...receiptPage, url: submissionUrl.replace('career5', 'career4') }, { ...context, url: submissionUrl.replace('career5', 'career4') })).toBe(false);
    expect(applicationReceipt({ ...receiptPage, url: 'https://career5.successfactors.eu/xi/ui/rcmcareer' }, { ...context, url: 'https://career5.successfactors.eu/xi/ui/rcmcareer' })).toBe(false);
    expect(applicationReceipt(receiptPage, { url: submissionUrl, applyUrl, job })).toBe(false);
    expect(applicationStage(receiptPage, { url: submissionUrl, applyUrl, job }).kind).not.toBe('receipt');
  });
});
