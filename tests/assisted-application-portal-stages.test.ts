import { describe, expect, it } from 'vitest';
import { applicationDestinationDiversionHint, applicationDiversionHint, applicationReceipt, applicationStage, isApplicationRegionUnsupported, portalJobKey } from '../scripts/assisted-application/lib/portal/stages.mjs';
import { applicationEntryControls, isVerifiedPostingEntry, pageControls, urlConfirms } from '../scripts/assisted-application/lib/portal/portal.mjs';

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
  it.each([
    'Introduce yourself',
    'Initiativbewerbung',
    'Candidature spontanée',
    'Candidatura spontanea',
    'Spontaneous application',
    'Job-Abo erstellen',
    'Create a job alert',
    'Job alert',
    'Créer une alerte emploi',
  ])('returns talent-pool and alert language as an agent hint, not a route stop: %s', (text) => {
    expect(applicationDiversionHint({ title: text })).toBe('talent_pool_or_job_alert');
  });

  it('keeps ambiguous self-introduction titles as hints, not final diversion proof', () => {
    expect(applicationDiversionHint({ title: 'Introduce yourself' })).toBe('talent_pool_or_job_alert');
    expect(applicationDestinationDiversionHint({ title: 'Introduce yourself' })).toBe('');
    expect(applicationDestinationDiversionHint({
      title: 'Application',
      url: 'https://careers.example/apply/REQ-42',
      pageHeadings: ['Personal information', 'Candidature spontanée'],
    })).toBe('talent_pool_or_job_alert');
  });

  it('does not call ordinary job-specific application labels a diversion', () => {
    expect(applicationDiversionHint({ title: 'Apply for Payroll Specialist', text: 'Continue your application.' })).toBe('');
  });

  it('recognizes a diversion route even when the page title is generic', () => {
    expect(applicationDiversionHint({
      title: 'Application',
      url: 'https://careers.example/talent-pool',
    })).toBe('talent_pool_or_job_alert');
  });

  it('does not treat a job-alert sidebar link as a diversion destination for final binding', () => {
    const snapshot = {
      title: 'Application',
      url: 'https://careers.example/apply/REQ-42',
      links: [{ text: 'Create a job alert' }],
    };
    expect(applicationDiversionHint(snapshot)).toBe('talent_pool_or_job_alert');
    expect(applicationDestinationDiversionHint(snapshot)).toBe('');
  });

  it('keeps an adjacent panel warning as an agent hint without overriding a bound job heading', () => {
    const snapshot = {
      title: 'Application',
      url: 'https://careers.example/en-US/job/Infrastructure-Strategy-Manager_R-12345',
      pageHeadings: ['Infrastructure Strategy Manager'],
      text: 'This is not an application for a specific job. Apply to this selected position.',
    };
    expect(applicationDiversionHint(snapshot)).toBe('talent_pool_or_job_alert');
    expect(applicationDestinationDiversionHint(snapshot)).toBe('');
  });

  it('does not promote a secondary accessibility heading to destination evidence', () => {
    const snapshot = {
      title: 'Application',
      url: 'https://careers.example/apply/REQ-42',
      text: '- heading "Application" [level=1] [ref=e1]\n- heading "Not an application for a specific job" [level=2] [ref=e2]',
    };
    expect(applicationDestinationDiversionHint(snapshot)).toBe('');
    expect(applicationDiversionHint(snapshot)).toBe('talent_pool_or_job_alert');
  });

  it('does not treat ordinary application copy containing Introduce yourself as a diversion', () => {
    expect(applicationDiversionHint({
      title: 'Payroll Specialist application',
      text: 'Payroll Specialist application\nIntroduce yourself\nSubmit application',
    })).toBe('');
  });

  it('recognizes a spontaneous-application warning in page text as a hint', () => {
    expect(applicationDiversionHint({ text: 'Candidature spontanée: présentez-vous à notre équipe.' })).toBe('talent_pool_or_job_alert');
  });

  it('ignores application copy and site job-alert links on a bound application form', () => {
    expect(applicationDiversionHint({
      title: 'Application',
      text: 'Seasonal Sales Consultant — Introduce yourself — Submit application',
      buttons: [{ text: 'Submit application', formId: 'application' }],
      links: [{ text: 'Create a job alert', chrome: true }],
    })).toBe('');
  });

  it.each([
    'Leider können wir Bewerbungen aus Ihrer Region aktuell nicht unterstützen.',
    'Applications from your region are not currently supported.',
    'We cannot accept applications from your region.',
    'Non possiamo supportare candidature dalla tua regione.',
  ])('recognizes an explicit application-region restriction: %s', (text) => {
    expect(isApplicationRegionUnsupported(text)).toBe(true);
  });

  it.each([
    'We welcome applications from every region.',
    'The role is based in the Zürich region.',
    'Bewerbungen sind willkommen.',
  ])('does not mistake ordinary regional or application copy for a restriction: %s', (text) => {
    expect(isApplicationRegionUnsupported(text)).toBe(false);
  });

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

  it('does not advance from the Workday posting into the talent-pool introduction', () => {
    const workdayApplyUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet-CHE/Seasonal-Sales-Consultant-m-w-d-Mendrisio-Outlet_R-12345';
    const start = { id: 'introduce-yourself', text: 'Démarrer', dataAutomationId: 'introduceYourselfButton', section: 'Présentez-vous', frame: 0, disabled: false };
    const workdaySnapshot = {
      url: workdayApplyUrl,
      text: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet Présentez-vous',
      fields: [],
      buttons: [
        { text: 'Lire tout le message sur la confidentialité', chrome: true },
        { text: 'Refuser', chrome: true },
        { text: 'Accepter les cookies', chrome: true },
        { text: 'Connexion', chrome: true },
        { text: 'Visite Swarovski.com', chrome: true },
        { text: 'Rechercher des emplois', chrome: true },
        { text: 'Présentez-vous', chrome: true },
        { text: 'Postuler', frame: 0, disabled: false },
        { text: 'Play video Créer un monde de merveilles', chrome: true },
        { text: 'En savoir plus', chrome: true },
        start,
      ],
    };
    const workdayJob = { title: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet' };

    expect(applicationStage(workdaySnapshot, { applyUrl: workdayApplyUrl, job: workdayJob }).kind).toBe('unknown_apply');
    const result = pageControls(workdaySnapshot.buttons, known, workdayApplyUrl, {
      snapshot: workdaySnapshot,
      applyUrl: workdayApplyUrl,
      job: workdayJob,
    });
    expect(result.submit).toBeNull();
    expect(result.next).toBeNull();
  });

  it.each([
    'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Ticino/Consultant_R-12345-1',
    'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Ticino/Consultant_R-12345-1/apply',
  ])('accepts Swarovski Workday one-segment job routes: %s', (workdayApplyUrl) => {
    const start = { id: 'start', text: 'Démarrer', frame: 0, disabled: false };
    const snapshot = {
      url: workdayApplyUrl,
      fields: [],
      buttons: [
        { text: 'Postuler', frame: 0, disabled: false },
        start,
      ],
    };

    expect(applicationStage(snapshot, { applyUrl: workdayApplyUrl, job: { title: 'Sales Consultant' } }))
      .toMatchObject({ kind: 'application_start', control: start });
  });

  it('treats the Swarovski Workday login route as account only after selected application entry proof', () => {
    const postingUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet-CHE/Seasonal-Sales-Consultant_R-12345';
    const loginUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/login';
    const snapshot = {
      url: loginUrl,
      text: 'Connexion Créer un compte Vous avez oublié votre mot de passe ?',
      fields: [
        { kind: 'text', inputType: 'text', label: 'Adresse e-mail*', required: true, value: '' },
        { kind: 'text', inputType: 'password', label: 'Mot de passe*', required: true, value: '' },
      ],
      buttons: [
        { text: 'Lire tout le message sur la confidentialité', chrome: true },
        { text: 'Refuser', chrome: true },
        { text: 'Accepter les cookies', chrome: true },
        { text: 'Visite Swarovski.com', chrome: true },
        { text: 'Rechercher des emplois', chrome: true },
        { text: 'Présentez-vous', chrome: true },
        { text: 'Connexion' },
        { text: 'Créer un compte' },
        { text: 'Vous avez oublié votre mot de passe ?' },
        { text: 'X', chrome: true },
        { text: 'YouTube', chrome: true },
        { text: 'LinkedIn', chrome: true },
        { text: 'Facebook', chrome: true },
      ],
    };

    expect(applicationStage(snapshot, {
      applyUrl: postingUrl,
      job: { title: 'Seasonal Sales Consultant' },
      workdayApplicationEntryProven: true,
    })).toMatchObject({ kind: 'account' });
    expect(applicationStage(snapshot, { applyUrl: postingUrl, job: { title: 'Seasonal Sales Consultant' } }))
      .toMatchObject({ kind: 'posting_mismatch' });
    expect(applicationStage({ ...snapshot, url: 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/other-site/login' }, {
      applyUrl: postingUrl,
      workdayApplicationEntryProven: true,
    }))
      .toMatchObject({ kind: 'posting_mismatch' });
    expect(applicationStage({ ...snapshot, url: 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/forgotPassword' }, { applyUrl: postingUrl }))
      .toMatchObject({ kind: 'posting_mismatch' });
  });

  it.each([
    ['a non-Workday host', 'https://careers.example/fr-FR/swarovski/job/Mendrisio-Outlet/Seasonal-Sales-Consultant_123'],
    ['a non-start label', 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet/Seasonal-Sales-Consultant_R-12345'],
  ])('keeps the generic Apply guard for %s', (_case, url) => {
    const buttons = [
      { text: 'Postuler', frame: 0, disabled: false },
      { text: _case === 'a non-start label' ? 'Démarrer la vidéo' : 'Démarrer', frame: 0, disabled: false },
    ];
    const snapshot = { url, text: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet', fields: [], buttons };
    expect(applicationStage(snapshot, { applyUrl: url, job: { title: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet' } }).kind)
      .toBe('unknown_apply');
  });

  it('does not bypass the field guard when Workday exposes a start label beside form controls', () => {
    const workdayApplyUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet/Seasonal-Sales-Consultant_R-12345';
    const snapshot = {
      url: workdayApplyUrl,
      text: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet',
      fields: [{ kind: 'text', inputType: 'email', label: 'E-mail', formId: 'application', frame: 0 }],
      buttons: [
        { text: 'Postuler', formId: 'application', frame: 0, disabled: false },
        { text: 'Démarrer', frame: 0, disabled: false },
      ],
    };
    expect(applicationStage(snapshot, { applyUrl: workdayApplyUrl, job: { title: 'Seasonal Sales Consultant (m/w/d) Mendrisio Outlet' } }).kind)
      .toBe('unknown_apply');
  });

  it.each([
    'Not an application for a specific job',
    'Pas une candidature pour un poste spécifique',
    'Keine Bewerbung für eine bestimmte Stelle',
    'Non è una candidatura per una posizione specifica',
  ])('keeps the selected Workday posting entry when a neighboring talent-pool panel says: %s', (copy) => {
    const postingUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet-CHE/Seasonal-Sales-Consultant-m-w-d-Mendrisio-Outlet_R-12345';
    const workdayApplyUrl = `${postingUrl}/apply/applyManually`;
    const selectedApply = { text: 'Postuler', dataAutomationId: 'adventureButton', frame: 0, disabled: false };
    const snapshot = {
      url: postingUrl,
      title: 'Introduce yourself',
      text: `Seasonal Sales Consultant — Introduce yourself — ${copy}`,
      fields: [],
      buttons: [
        selectedApply,
        { text: 'Démarrer', dataAutomationId: 'introduceYourselfButton', section: 'Présentez-vous', frame: 0, disabled: false },
      ],
    };
    const context = {
      applyUrl: workdayApplyUrl,
      postingUrl,
      job: { title: 'Seasonal Sales Consultant' },
    };

    expect(applicationStage(snapshot, { applyUrl: workdayApplyUrl, job: context.job }).kind).not.toBe('posting_mismatch');
    expect(applicationEntryControls(snapshot, context)).toEqual([selectedApply]);
  });

  it.each([
    'Not an application for a specific job',
    'Pas une candidature pour un poste spécifique',
    'Keine Bewerbung für eine bestimmte Stelle',
    'Non è una candidatura per una posizione specifica',
  ])('rejects the Workday talent-pool route before form handling: %s', (copy) => {
    const applyUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet-CHE/Seasonal-Sales-Consultant_R-12345/apply/applyManually';
    const talentPoolUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/introduceYourself';
    expect(applicationStage({ url: talentPoolUrl, text: `Démarrer — ${copy}` }, { applyUrl }).kind).toBe('posting_mismatch');
  });

  it('confirms a Workday receipt only after a final click on the same requisition and an empty form', () => {
    const submissionUrl = 'https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Mendrisio-Outlet-CHE/Consultant_R-12345-1/apply/applyManually?view=submit';
    const received = {
      url: submissionUrl,
      text: 'Vielen Dank für Ihre Bewerbung',
      fields: [],
      buttons: [],
    };
    const finalSubmission = { clicked: true };
    expect(applicationReceipt(received, { applyUrl: submissionUrl, submissionUrl, finalSubmission })).toBe(true);
    expect(applicationReceipt({ ...received, text: '' }, { applyUrl: submissionUrl, submissionUrl, finalSubmission })).toBe(false);
    expect(applicationReceipt(received, { applyUrl: submissionUrl, submissionUrl })).toBe(false);
    expect(applicationReceipt({ ...received, fields: [{ inputType: 'email', disabled: false }] }, {
      applyUrl: submissionUrl, submissionUrl, finalSubmission,
    })).toBe(false);
    expect(applicationReceipt({ ...received, url: submissionUrl.replace('Consultant_R-12345-1', 'Consultant_R-54321-1') }, {
      applyUrl: submissionUrl, submissionUrl, finalSubmission,
    })).toBe(false);
  });

  it('recognizes Helsana receipt copy after the verified SuccessFactors route redirects to root', () => {
    const helsanaApplyUrl = 'https://careers.helsana.ch/talentcommunity/apply/970403401/?locale=de_DE';
    const helsanaRoot = {
      url: 'https://careers.helsana.ch/',
      text: 'Mit der weiteren Nutzung dieser Website und der Navigation auf dieser Website stimmen Sie der Verwendung von Cookies zu. Vielen Dank. Wir haben deine Unterlagen erhalten.',
      fields: [],
      buttons: [{ text: 'Akzeptieren' }, { text: 'Schließen' }],
    };
    const context = {
      applyUrl: helsanaApplyUrl,
      postingUrl: 'https://careers.helsana.ch/Helsana/job/Group-Controller-a-80-100/970403401/',
      job: { title: 'Group Controller (a) 80-100%' },
    };
    const postingEntry = isVerifiedPostingEntry(context);
    expect(postingEntry).toBe(true);
    expect(applicationReceipt(helsanaRoot, { ...context, postingEntry })).toBe(true);
    expect(applicationStage(helsanaRoot, { ...context, postingEntry })).toMatchObject({ kind: 'receipt' });
  });

  it('limits a verified SuccessFactors receipt to the same-origin employer root', () => {
    const context = { applyUrl: 'https://portal.example/job/1', postingEntry: true };
    const snapshot = { text: 'Wir haben deine Unterlagen erhalten', buttons: [] };
    expect(applicationReceipt({ ...snapshot, url: 'https://other.example/path' }, context)).toBe(false);
    expect(applicationReceipt({ ...snapshot, url: 'https://portal.example/path' }, context)).toBe(false);
    expect(applicationReceipt({ ...snapshot, url: 'https://portal.example/' }, context)).toBe(true);
  });

  it('does not bind a repeated title without an explicit posting route or key', () => {
    const titleOnlyReceipt = { ...receipt, url: `${origin}/Careers/complete/` };
    expect(applicationReceipt(titleOnlyReceipt, { applyUrl, job })).toBe(false);
    const titleOnlyReview = { ...review, url: `${origin}/Careers/ApplicationReview/` };
    expect(applicationStage(titleOnlyReview, { applyUrl, job }).kind).toBe('unknown_apply');
  });

  it('does not treat an arbitrary observed same-origin route as a title-bound receipt', () => {
    const handoff = `${origin}/review/`;
    const arbitrary = {
      ...receipt,
      url: `${origin}/other/`,
      text: `Thank you for applying to ${job.title}.`,
    };
    expect(applicationReceipt(arbitrary, { applyUrl: `${origin}/job?jobid=42`, submissionUrl: handoff, job })).toBe(false);
    expect(applicationStage(arbitrary, { applyUrl: `${origin}/job?jobid=42`, job }).kind).toBe('unknown_apply');
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

  it('recognizes a SuccessFactors application page with job-specific questions before the final click', () => {
    const submit = { text: 'Bewerben', formId: 'successfactors-application', frame: 0 };
    const form = {
      url: 'https://career5.successfactors.eu/portalcareer',
      text: 'Profilinformationen Stellenspezifische Informationen',
      fields: [
        { label: '* Vorname', kind: 'text', inputType: 'text', required: true, formId: submit.formId, frame: 0 },
        { label: '* Name', kind: 'text', inputType: 'text', required: true, formId: submit.formId, frame: 0 },
        { label: '* E-Mail', kind: 'text', inputType: 'email', required: true, formId: submit.formId, frame: 0 },
        { label: '* Was hat dich motiviert, dich auf diese Stelle zu bewerben?', kind: 'textarea', inputType: 'textarea', required: true, formId: submit.formId, frame: 0 },
        { label: '* Übst du derzeit eine entgeltliche Nebenbeschäftigung aus?', kind: 'combobox', required: true, formId: submit.formId, frame: 0 },
      ],
      buttons: [submit, { text: 'Meine Dokumente', formId: submit.formId, frame: 0 }],
    };
    expect(applicationStage(form, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=103967', job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
  });

  it('recognizes the career5 SuccessFactors form when required text labels start with an asterisk', () => {
    const submit = { text: 'Bewerben', formId: 'career5-application', frame: 0 };
    const fields = [
      ['Sprache', 'combobox'],
      ['Anrede', 'combobox'],
      ['* Vorname', 'text'],
      ['* Name', 'text'],
      ['* E-Mail', 'text'],
      ['* Telefon Privat / Mobile', 'text'],
      ['Telefon Geschäft', 'text'],
      ['c/o', 'text'],
      ['* Strasse, Nr.', 'text'],
      ['PLZ', 'text'],
      ['Ort', 'text'],
      ['Land', 'combobox'],
      ['Nationalität', 'combobox'],
      ['Aufenthaltsgenehmigung (wenn nicht CH)', 'combobox'],
      ['Link auf LinkedIn Profil', 'text'],
      ['Link auf Xing Profil', 'text'],
      ['* Übst du derzeit eine entgeltliche Nebenbeschäftigung aus bzw. beabsichtigst du, eine Nebenbeschäftigung auszuüben?', 'combobox'],
      ['Arbeiten Sie bei Helsana?', 'combobox'],
      ['Hat Sie jemand empfohlen?', 'text'],
      ['* Wie haben Sie von dieser Stelle erfahren?', 'combobox'],
      ['Andere:', 'text'],
      ['* Was hat dich motiviert, dich auf diese Stelle zu bewerben?', 'textarea'],
      ['* Welche Erfahrungen bringst du für diese Stelle mit?', 'textarea'],
      ['Welchen Brutto-Jahreslohn stellst du dir bei 100% vor?', 'textarea'],
      ['Was möchtest du uns sonst noch mitteilen?', 'textarea'],
      ['Geburtsdatum', 'text'],
    ].map(([label, kind]) => ({
      label,
      kind,
      inputType: kind === 'textarea' ? 'textarea' : 'text',
      required: label.startsWith('*'),
      formId: submit.formId,
      frame: 0,
    }));
    const snapshot = {
      url: 'https://career5.successfactors.eu/portalcareer',
      text: 'Profilinformationen Stellenspezifische Informationen',
      fields,
      buttons: [
        'Optionen',
        'Alle Abschnitte einblenden',
        'Alle Abschnitte ausblenden',
        'Meine Dokumente',
        '* Lebenslauf - Zeugnisse - Diplome Lebenslauf Öffnet ein Dialogfeld',
        'Zusätzliche Dokumente Dokument hinzufügen Öffnet ein Dialogfeld',
        'Profilinformationen',
        '',
        'Stellenspezifische Informationen',
        'Profil anzeigen',
        'Speichern',
        submit.text,
      ].map((text) => ({ text, formId: submit.formId, frame: 0 })),
    };

    expect(applicationStage(snapshot, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=103967', job }).kind).toBe('form');
    expect(controls(snapshot).submit).toMatchObject({ text: submit.text });
  });

  it('recognizes a title-bound SuccessFactors application split across profile and question forms', () => {
    const submit = {
      text: 'Bewerben', formId: 'apply-actions', frame: 0,
      applicationScopeId: 'application-main',
      sectionGroupId: 'questions-group',
      sectionGroup: 'Stellenspezifische Informationen',
    };
    const form = {
      url: 'https://career5.successfactors.eu/portalcareer',
      text: [job.title, 'Profilinformationen', 'Stellenspezifische Informationen', 'Wie hat dich diese Stelle motiviert?', submit.text].join('\n'),
      fields: [
        { label: '* Vorname', kind: 'text', inputType: 'text', required: true, formId: 'profile', applicationScopeId: 'application-main', sectionGroupId: 'profile-group', sectionGroup: 'Profilinformationen', frame: 0 },
        { label: '* E-Mail', kind: 'text', inputType: 'email', required: true, formId: 'profile', applicationScopeId: 'application-main', sectionGroupId: 'profile-group', sectionGroup: 'Profilinformationen', frame: 0 },
        { label: '* Was hat dich motiviert, dich auf diese Stelle zu bewerben?', kind: 'textarea', inputType: 'textarea', required: true, formId: 'questions', applicationScopeId: 'application-main', sectionGroupId: 'questions-group', sectionGroup: 'Stellenspezifische Informationen', frame: 0 },
      ],
      buttons: [submit],
    };

    expect(applicationStage(form, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('form');
    expect(controls(form).submit).toBe(submit);
    expect(applicationStage({ ...form, buttons: [{ text: submit.text, frame: 0 }] }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
    expect(applicationStage({ ...form, text: 'Profilinformationen Stellenspezifische Informationen' }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
    expect(applicationStage({ ...form, fields: form.fields.map(field => ({ ...field, frame: 1 })) }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
    expect(applicationStage({ ...form, buttons: [{ ...submit, sectionGroupId: 'newsletter-group', sectionGroup: 'Newsletter' }] }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
    expect(applicationStage({
      ...form,
      fields: form.fields.map(field => field.formId === 'questions' ? { ...field, sectionGroupId: 'unrelated-group' } : field),
    }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
    expect(applicationStage({
      ...form,
      fields: form.fields.map(field => field.formId === 'profile' ? { ...field, applicationScopeId: 'other-main' } : field),
    }, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
  });

  it('does not join unrelated same-frame sign-in and salary forms to the Apply action', () => {
    const submit = { text: 'Apply', formId: 'apply', frame: 1 };
    const snapshot = {
      url: 'https://career5.successfactors.eu/portalcareer',
      text: [job.title, 'Sign in', 'Salary expectations', 'Apply'].join('\n'),
      fields: [
        { label: 'Email address', inputType: 'email', formId: 'sign-in', frame: 1 },
        { label: 'Salary expectations', inputType: 'text', formId: 'newsletter', frame: 1 },
      ],
      buttons: [submit],
    };

    expect(applicationStage(snapshot, { applyUrl: 'https://career5.successfactors.eu/career?career_job_req_id=42', job }).kind).toBe('unknown_apply');
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

  it('keeps employer and ATS job-ID namespaces separate until the handoff route is explicit', () => {
    const snapshot = { ...review, url: 'https://ats.example/review?jobId=internal99' };
    // A cross-origin page is not a verified handoff merely because it repeats
    // the role title and asks for the final Apply. The explicit submission
    // route below is the evidence that can bind the resulting receipt.
    expect(applicationStage(snapshot, { applyUrl, job }).kind).toBe('unknown_apply');
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

describe('Workday account route stages', () => {
  const workdayApplyUrl = 'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/job/Mendrisio-Outlet/Consultant_R-12345-1/apply/applyManually';
  const loginUrl = 'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login';
  const login = {
    url: loginUrl,
    text: 'Connexion Adresse e-mail Mot de passe Créer un compte',
    fields: [
      { id: 'email', inputType: 'email', label: 'Adresse e-mail' },
      { id: 'password', inputType: 'password', label: 'Mot de passe' },
    ],
    buttons: [{ id: 'sign-in', text: 'Connexion' }],
  };

  it('accepts the login page as an account stage only after this run entered the selected apply route', () => {
    expect(applicationStage(login, {
      applyUrl: workdayApplyUrl,
      workdayApplicationEntryProven: true,
    })).toEqual({ kind: 'account' });
    expect(applicationStage(login, { applyUrl: workdayApplyUrl })).toEqual({ kind: 'posting_mismatch' });
  });

  it.each([
    'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/introduceYourself',
    'https://acme.wd3.myworkdayjobs.com/fr-FR/OtherSite/login',
    'https://other.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/login',
    'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/job/Other/Consultant_R-54321-2',
  ])('keeps non-account and unselected routes mismatched even with entry proof: %s', (url) => {
    expect(applicationStage({ ...login, url }, {
      applyUrl: workdayApplyUrl,
      workdayApplicationEntryProven: true,
    })).toEqual({ kind: 'posting_mismatch' });
  });

  it('does not expose account controls as application next or submit buttons', () => {
    const result = pageControls(login.buttons, known, loginUrl, {
      snapshot: login,
      applyUrl: workdayApplyUrl,
      workdayApplicationEntryProven: true,
      job,
    });
    expect(result).toMatchObject({ stage: { kind: 'account' }, submit: null, next: null });
  });
});
