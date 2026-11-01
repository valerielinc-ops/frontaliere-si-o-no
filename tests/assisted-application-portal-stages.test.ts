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

  it('accepts canonical trailing-slash routes without widening the posting boundary', () => {
    const slashReviewUrl = `${origin}/Careers/ApplicationReview/?jobId=42`;
    const slashReceiptUrl = `${origin}/Careers/ApplicationComplete/?jobId=42`;
    expect(applicationStage({ ...profile, buttons: [{ text: 'Apply', href: slashReviewUrl }] }, { applyUrl, job }))
      .toMatchObject({ kind: 'review_navigation', destination: slashReviewUrl });
    expect(applicationReceipt({ ...receipt, url: slashReceiptUrl }, { applyUrl, job })).toBe(true);
  });

  it('does not bind a repeated title without an explicit posting route or key', () => {
    const titleOnlyReceipt = { ...receipt, url: `${origin}/Careers/complete/` };
    expect(applicationReceipt(titleOnlyReceipt, { applyUrl, job })).toBe(false);
    const titleOnlyReview = { ...review, url: `${origin}/Careers/ApplicationReview/` };
    expect(applicationStage(titleOnlyReview, { applyUrl, job }).kind).toBe('unknown_apply');
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

  it('treats Resume / CV as a document label beside an application submit button', () => {
    const submit = { text: 'Submit application', formId: 'application', frame: 0 };
    const form = {
      url: applyUrl,
      text: [job.title, 'First Name *', 'Email Address *', 'Resume / CV *', 'What is your preferred workload? *', submit.text].join('\n'),
      fields: [
        { label: 'First Name *', kind: 'text', inputType: 'text', required: true, formId: 'application', frame: 0 },
        { label: 'Email Address *', kind: 'text', inputType: 'email', required: true, formId: 'application', frame: 0 },
        { label: 'Resume / CV *', kind: 'file', inputType: 'file', required: true, formId: 'application', frame: 0 },
        { label: 'What is your preferred workload? *', kind: 'text', inputType: 'text', required: true, formId: 'application', frame: 0 },
      ],
      buttons: [submit],
    };
    expect(applicationStage(form, { applyUrl, job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
  });

  it('does not treat a required Resume label as an incomplete-application instruction', () => {
    const submit = { text: 'Submit final application', formId: 'application', frame: 0 };
    const form = {
      url: applyUrl,
      text: [job.title, 'First name *', 'Email address/login *', 'Resume *', 'I would like my data to be deleted once the present application process is complete.', submit.text].join('\n'),
      fields: [
        { label: 'First name *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
        { label: 'Email address/login *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
      ],
      buttons: [submit],
    };
    expect(applicationStage(form, { applyUrl, job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
  });

  it('does not join an application mention to a later profile CTA across sentence boundaries', () => {
    const submit = { text: 'Submit final application', formId: 'application', frame: 0 };
    const form = {
      url: applyUrl,
      text: [job.title, 'First name *', 'Email address/login *', 'Resume *', 'Application information is shown here;', 'It takes two minutes to complete your profile.', submit.text].join(' '),
      fields: [
        { label: 'First name *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
        { label: 'Email address/login *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
      ],
      buttons: [submit],
    };
    expect(applicationStage(form, { applyUrl, job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
  });

  it('keeps an incomplete-state clause after a semicolon from becoming a receipt', () => {
    const incomplete = {
      ...receipt,
      text: `Thank you for your application for ${job.title}. Your application was saved; it still needs completion.`,
    };
    expect(applicationReceipt(incomplete, { applyUrl, job })).toBe(false);
    expect(applicationStage(incomplete, { applyUrl, job })).toMatchObject({ kind: 'unknown_apply', prefinal: true });
    expect(controls(incomplete).submit).toBeNull();
  });

  it.each([
    ['English', `Thank you for your application for ${job.title}. Your application was saved at https://careers.example/form. It still needs completion.`],
    ['German', `Vielen Dank für Ihre Bewerbung. Ihre Bewerbung wurde gespeichert. Sie ist noch unvollständig.`],
    ['Italian', `Grazie per la tua candidatura. La candidatura è stata salvata. È ancora da completare.`],
    ['Italian without ancora', `Grazie per la tua candidatura. La candidatura è stata salvata. Non è completa.`],
    ['Italian demonstrative', `Grazie per la tua candidatura. La candidatura è stata salvata. Questa è ancora da completare.`],
    ['French', `Merci pour votre candidature. Votre candidature a été enregistrée. Elle est encore incomplète.`],
    ['French without encore', `Merci pour votre candidature. Votre candidature a été enregistrée. Elle n’est pas complète.`],
  ])('keeps a localized anaphoric incomplete state from becoming a receipt: %s', (_language, text) => {
    const incomplete = { ...receipt, text };
    expect(applicationReceipt(incomplete, { applyUrl, job })).toBe(false);
    expect(applicationStage(incomplete, { applyUrl, job })).toMatchObject({ kind: 'unknown_apply', prefinal: true });
    expect(controls(incomplete).submit).toBeNull();
  });

  it('carries application context across a short explicit status chain', () => {
    const incomplete = {
      ...receipt,
      text: `Thank you for your application for ${job.title}. Your application was saved. It is ready for review. It still needs completion.`,
    };
    expect(applicationReceipt(incomplete, { applyUrl, job })).toBe(false);
    expect(applicationStage(incomplete, { applyUrl, job })).toMatchObject({ kind: 'unknown_apply', prefinal: true });
    expect(controls(incomplete).submit).toBeNull();
  });

  it('keeps a same-page CV upload proof when the portal removes the file input', () => {
    const submit = { text: 'Bewerben', formId: 'application', frame: 0 };
    const form = {
      url: applyUrl,
      text: [job.title, 'Vorname *', 'Nachname *', 'E-Mail *', 'Lebenslauf *', submit.text].join('\n'),
      uploadedCv: true,
      fields: [
        { label: 'Vorname *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
        { label: 'Nachname *', kind: 'text', inputType: 'text', formId: 'application', frame: 0 },
        { label: 'E-Mail *', kind: 'text', inputType: 'email', formId: 'application', frame: 0 },
      ],
      buttons: [submit],
    };
    expect(applicationStage(form, { applyUrl, job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
  });

  it.each(['Resume your application', 'Incomplete application'])('keeps an explicit incomplete state guarded: %s', text => {
    const submit = { text: 'Submit application', formId: 'application', frame: 0 };
    const form = { url: applyUrl, text: `${job.title}. Resume / CV. ${text}`, fields: [], buttons: [submit] };
    expect(applicationStage(form, { applyUrl, job })).toMatchObject({ kind: 'unknown_apply', prefinal: true });
    expect(controls(form).submit).toBeNull();
    expect(controls(form).next).toBeNull();
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

  it('does not let a Resume / CV navigation label hide a positive application receipt', () => {
    expect(applicationReceipt({ ...receipt, text: `Resume / CV. Thank you for your application for ${job.title}.` }, { applyUrl, job })).toBe(true);
  });

  it('keeps employer and ATS job-ID namespaces separate after a verified handoff', () => {
    const snapshot = { ...review, url: 'https://ats.example/review?jobId=internal99' };
    expect(applicationStage(snapshot, { applyUrl, job }).kind).toBe('final_review');
    expect(applicationReceipt({ ...receipt, url: 'https://ats.example/receipt?jobId=internal99', text: 'Thank you for your application.' },
      { applyUrl, submissionUrl: snapshot.url, job })).toBe(true);
    expect(applicationReceipt({ ...receipt, url: 'https://ats.example/receipt?jobId=other99' },
      { applyUrl, submissionUrl: snapshot.url, job })).toBe(false);
  });

  it('binds a receipt to a verified form origin after an employer-to-ATS handoff', () => {
    const target = { ...receipt, url: 'https://ats.example/thank-you' };
    expect(applicationReceipt(target, { applyUrl, submissionUrl: 'https://ats.example/review', job })).toBe(true);
    expect(applicationReceipt(target, { applyUrl, job })).toBe(false);
  });

  it('recognises an explicit receipt bound by the full known job title after an observed submission route', () => {
    expect(applicationReceipt({ ...receipt, url: `${origin}/thank-you` }, {
      applyUrl, submissionUrl: `${origin}/Careers/ApplicationReview?jobId=42`, job,
    })).toBe(true);
    expect(applicationReceipt({ ...receipt, text: 'Thank you for your application.', url: `${origin}/thank-you` }, { applyUrl, job })).toBe(false);
  });

  it('allows the fake portal transport only on loopback and still requires the same posting key', () => {
    const localApply = 'http://127.0.0.1:3000/apply?jobid=e2e-42';
    const localReceipt = {
      url: 'http://127.0.0.1:3000/complete?jobid=e2e-42',
      text: 'Vielen Dank für Ihre Bewerbung',
      buttons: [],
    };
    expect(applicationReceipt(localReceipt, { applyUrl: localApply })).toBe(true);
    expect(applicationReceipt({ ...localReceipt, url: localReceipt.url.replace('e2e-42', 'e2e-43') }, { applyUrl: localApply })).toBe(false);
    expect(applicationReceipt({ ...localReceipt, url: localReceipt.url.replace('127.0.0.1', 'ats.example') }, { applyUrl: localApply })).toBe(false);
    const publicHttpApply = 'http://ats.example:3000/apply?jobid=e2e-42';
    const publicHttpReceipt = { ...localReceipt, url: 'http://ats.example:3000/complete?jobid=e2e-42' };
    expect(applicationReceipt(publicHttpReceipt, { applyUrl: publicHttpApply })).toBe(false);
    const localSubdomain = {
      ...localReceipt,
      url: 'http://career.example.localhost:3000/complete?jobid=e2e-42',
    };
    expect(applicationReceipt(localSubdomain, { applyUrl: 'http://career.example.localhost:3000/apply?jobid=e2e-42' })).toBe(true);
  });

  it('makes a same-posting receipt terminal before a learned nonstandard send label can be selected', () => {
    const label = 'Finish application';
    const received = { ...receipt, buttons: [{ text: label }] };
    const learned = { nextButtons: [], finalButtons: [{ path: '/careers/applicationcomplete', label }] };
    const result = pageControls(received.buttons, learned, received.url, { snapshot: received, applyUrl, job });
    expect(result.stage).toMatchObject({ kind: 'receipt' });
    expect(result.submit).toBeNull();
    expect(result.next).toBeNull();
  });

  it.each([
    'Thank you for applying. Continue to complete your application.',
    "Thank you for applying. Your application hasn’t been submitted yet.",
    'Vielen Dank für Ihre Bewerbung. Ihre Bewerbung ist unvollständig.',
    'Vielen Dank für Ihre Bewerbung. Ihre Bewerbung wurde noch nicht eingereicht.',
    'Grazie per la tua candidatura. La candidatura non è completa.',
    'Grazie per la tua candidatura. La candidatura non è stata inviata.',
    "Merci pour votre candidature. Votre candidature n'est pas complète.",
    "Merci pour votre candidature. Votre candidature n'a pas été envoyée.",
  ])('does not treat a same-job acknowledgement of an incomplete application as a receipt: %s', text => {
    const label = 'Finish application';
    const incomplete = { ...receipt, text, buttons: [{ text: label }] };
    const learned = { nextButtons: [], finalButtons: [{ path: '/careers/applicationcomplete', label }] };
    expect(applicationReceipt(incomplete, { applyUrl, job })).toBe(false);
    const result = pageControls(incomplete.buttons, learned, incomplete.url, { snapshot: incomplete, applyUrl, job });
    expect(result.stage).toMatchObject({ kind: 'unknown_apply', prefinal: true });
    expect(result.submit).toBeNull();
    expect(result.next).toBeNull();
  });

  it.each([
    'Thank you for your application for Infrastructure Strategy Manager.',
    'Vielen Dank für Ihre Bewerbung als Infrastructure Strategy Manager.',
    'Grazie per la tua candidatura per Infrastructure Strategy Manager.',
    'Merci pour votre candidature pour Infrastructure Strategy Manager.',
  ])('continues to accept a completed receipt in the selected communication language: %s', text => {
    expect(applicationReceipt({ ...receipt, text }, { applyUrl, job })).toBe(true);
  });
});
