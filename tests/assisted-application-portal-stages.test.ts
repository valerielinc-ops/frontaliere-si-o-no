import { describe, expect, it } from 'vitest';
import { applicationReceipt, applicationStage, portalJobKey } from '../scripts/assisted-application/lib/portal/stages.mjs';
import { pageControls, urlConfirms } from '../scripts/assisted-application/lib/portal/portal.mjs';

const origin = 'https://careers.example';
const applyUrl = `${origin}/Careers/ApplicationMethods?jobId=42`;
const profileUrl = `${origin}/Careers/ApplicationConfirmation?jobId=42`;
const reviewUrl = `${origin}/Careers/ApplicationReview?jobId=42`;
const receiptUrl = `${origin}/Careers/ApplicationComplete?jobId=42`;
const known = { nextButtons: [], finalButtons: [] };
const job = { title: 'Infrastructure Strategy Manager' };
const instructions = 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.';
const profile = {
  url: profileUrl, fields: [], text: 'Thank you for your interest. Since you have already submitted your personal information, the application process will be simpler.',
  buttons: [{ id: 'continue', text: 'Apply', href: reviewUrl }, { text: 'My profile' }],
};
const review = { url: reviewUrl, fields: [], text: `${job.title}. ${instructions}`, buttons: [{ id: 'commit', text: 'Apply' }, { text: 'Cancel' }, { text: 'Edit profile' }] };
const receipt = { url: receiptUrl, fields: [], text: `Thank you for your application for ${job.title}.`, buttons: [{ text: 'My profile' }] };
const controls = (snapshot: any) => pageControls(snapshot.buttons, known, snapshot.url, { snapshot, applyUrl, job });

describe('application stage ownership', () => {
  it('separates Avature-style profile confirmation, review and posting receipt', async () => {
    const first = controls(profile);
    expect(first.submit).toBeNull();
    expect(first.next).toBe(profile.buttons[0]);
    expect(first.stage).toMatchObject({ kind: 'review_navigation', destination: reviewUrl });
    expect(applicationReceipt(profile, { applyUrl, job })).toBe(false);
    const final = controls(review);
    expect(final.submit).toBe(review.buttons[0]);
    expect(final.next).toBeNull();
    expect(applicationReceipt(receipt, { applyUrl, job })).toBe(true);
  });

  it.each([
    ['site search field', { ...profile, text: 'Thank you for your interest.', fields: [{ kind: 'text', inputType: 'search', label: 'Search jobs', formId: 'site-search' }], buttons: [{ text: 'Apply', formId: 'other' }] }],
    ['required field beside navigation', { ...profile, fields: [{ kind: 'text', inputType: 'text', label: 'First name', required: true, value: '' }] }],
    ['missing owned destination', { ...profile, buttons: [{ text: 'Apply' }] }],
    ['side effect parameter', { ...profile, buttons: [{ text: 'Apply', href: reviewUrl + '&submit=true' }] }],
    ['hash action', { ...profile, buttons: [{ text: 'Apply', href: reviewUrl + '#submit' }] }],
    ['different posting', { ...profile, buttons: [{ text: 'Apply', href: reviewUrl.replace('42', '43') }] }],
    ['foreign destination', { ...profile, buttons: [{ text: 'Apply', href: 'https://other.example/Careers/ApplicationReview?jobId=42' }] }],
    ['generic thank you', { ...profile, text: 'Thank you for your interest.' }],
    ['duplicate review targets', { ...profile, buttons: [profile.buttons[0], { ...profile.buttons[0], id: 'other' }] }],
    ['unreadable copy', { ...profile, text: '' }],
  ])('freezes %s instead of arming the final click', (_case, snapshot) => {
    expect(applicationStage(snapshot, { applyUrl, job }).kind).toBe('unknown_apply');
    expect(controls(snapshot).submit).toBeNull();
    expect(controls(snapshot).next).toBeNull();
  });

  it('does not infer a review route or submit from a profile confirmation URL', () => {
    expect(urlConfirms(profileUrl, { buttons: [] })).toBe(false);
    expect(urlConfirms(profileUrl, profile, { applyUrl, job })).toBe(false);
    expect(controls({ ...profile, buttons: [{ text: 'Apply', formAction: reviewUrl, formMethod: 'post' }] }).submit).toBeNull();
  });

  it('requires CV and identity controls in the Apply button own form and frame', () => {
    const form = { url: applyUrl, text: job.title, fields: [
      { kind: 'file', formId: 'application', frame: 0 },
      { kind: 'text', inputType: 'email', formId: 'application', frame: 0 },
    ], buttons: [{ text: 'Apply', formId: 'application', frame: 0 }] };
    expect(controls(form).submit).toBe(form.buttons[0]);
    expect(controls({ ...form, buttons: [{ text: 'Apply', formId: 'other' }] }).submit).toBeNull();
    expect(controls({ ...form, buttons: [{ text: 'Apply', formId: 'application', frame: 1 }] }).submit).toBeNull();
  });

  it('does not reinterpret an account ID or application ID as a job ID', () => {
    expect(portalJobKey(`${origin}/profile?applicationId=42`)).toBeNull();
    expect(portalJobKey(`${origin}/profile?jobId=42&JOBID=43`)).toBeNull();
    expect(portalJobKey(`${origin}/profile?jobId=42`)).toBe('42');
  });

  it.each([
    ['other role and footer words', { ...receipt, url: `${origin}/thank-you`, text: 'Thank you for your application for Sales Manager. Browse other Infrastructure Strategy opportunities.' }],
    ['exact title in footer', { ...receipt, url: `${origin}/thank-you`, text: `Thank you for your application for Sales Manager. Other vacancies: ${job.title}` }],
    ['foreign receipt origin', { ...receipt, url: 'https://other.example/thank-you' }],
    ['profile saved', { ...receipt, text: 'We have received your personal information. Application process is now simpler.' }],
    ['Italian registration', { ...receipt, text: 'Grazie per la tua registrazione. Profilo salvato.' }],
    ['Italian profile', { ...receipt, text: 'Grazie per aver inviato i tuoi dati.' }],
    ['account only', { ...receipt, text: 'Thank you for creating your profile.' }],
    ['other posting', { ...receipt, url: receiptUrl.replace('42', '43') }],
    ['no known posting', { ...receipt, url: `${origin}/thank-you`, text: 'Thank you for your application.' }],
    ['review instruction beside thanks', { ...review, text: `Thank you for your application. ${instructions}` }],
    ['send still offered', { ...receipt, buttons: [{ text: 'Apply', disabled: true }] }],
  ])('never certifies SENT for %s', (_case, snapshot) => {
    expect(applicationReceipt(snapshot, { applyUrl, job })).toBe(false);
  });

  it.each(['Thank you for applying', 'Thank you very much for applying', 'Thank you so much for applying', 'Grazie per la tua candidatura', 'Grazie per aver inviato la tua candidatura', 'Merci pour votre candidature', 'Vielen Dank für Ihre Bewerbung'])('retains explicit application receipts: %s', text => {
    expect(applicationReceipt({ ...receipt, text }, { applyUrl, job })).toBe(true);
  });

  it('recognises an explicit receipt bound by the full known job title when there is no job URL key', () => {
    expect(applicationReceipt({ ...receipt, url: `${origin}/thank-you` }, { applyUrl, job })).toBe(true);
    expect(applicationReceipt({ ...receipt, text: 'Thank you for your application.', url: `${origin}/thank-you` }, { applyUrl, job })).toBe(false);
  });
});
