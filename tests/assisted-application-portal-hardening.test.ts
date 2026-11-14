import { describe, expect, it } from 'vitest';
import { fitToLength } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { birthDatePartOption, candidateAnswerForField, guardPlan, PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { applicationReceipt, applicationStage, gravityFormsSubmissionOutcome, inPageApplicationOpeners } from '../scripts/assisted-application/lib/portal/stages.mjs';
import { guardAgentStep } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { CREATE_ACCOUNT_RE, authPageKind, isExplicitSignInNavigationLabel } from '../scripts/assisted-application/lib/portal/account.mjs';
import {
  candidateForForm,
  COOKIE_ACCEPT_RE,
  COOKIE_REJECT_RE,
  isNonCvDocumentLabel,
  applicationEntryControls,
  formPostingMatch,
  hasVacancySpecificPostingEvidence,
  hasApplicationSurface,
  applicationEntryCarriesPostingId,
  initialPortalHandoffReason,
  namesAnotherEmployer,
  pageControls,
  sameEmployerFamily,
  REFRESH_ASKED_RE,
  removalsOf,
  ownAccountForm,
  sendsApplication,
  privacyConsentControls,
  postingMatch,
  PREREAD_CHANNELS,
  portalRequirementsFromMissingRequired,
  portalRequiredDocumentFromField,
  portalEntryUrl,
  portalContextOptions,
  postingAddressForPortal,
  verifiedUmantisPostingAddress,
  localizePortalQuestions,
  isPostingRouteBound,
  isVerifiedPostingEntry,
  isSafeEmployerSitePreread,
  readPortalQuestions,
  startsApplication,
  urlConfirms,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { portalAnswerForApplication, portalOptionMap } from '../scripts/assisted-application/lib/portal/question-key.mjs';
import { mergeRequiredDocuments } from '../functions/src/assistedApplicationExtraDocuments.js';
import { interviewPrepUserText } from '../functions/src/assistedApplicationInterviewPrep.js';
import { parseAltenDetailHtml } from '../scripts/lib/alten-job-parser.mjs';
import umantisAccountStepFixture from './fixtures/umantis-recruitingapp-2761-application-new-account.json';

describe('in-page application opener classification', () => {
  const url = 'https://jobs.example.test/apply?posting=fixture';
  const identityFields = (formId: string) => [
    { id: `${formId}-first`, label: 'Vorname', formId },
    { id: `${formId}-last`, label: 'Nachname', formId },
    { id: `${formId}-email`, label: 'E-Mail', inputType: 'email', formId },
  ];
  const opener = (id: string, patch = {}) => ({
    id,
    text: 'Jetzt bewerben',
    formId: '',
    href: `${url}#application`,
    ...patch,
  });

  it('ignores same-document apply openers when one applicant form owns the step controls', () => {
    const snapshot = {
      url,
      text: 'Bewerbung',
      fields: identityFields('application'),
      buttons: [opener('open-one'), opener('open-two'), { id: 'next', text: 'Weiter', formId: 'application' }],
    };

    expect(inPageApplicationOpeners(snapshot, url)).toHaveLength(2);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'form' });
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, url, { snapshot, applyUrl: url }))
      .toMatchObject({ submit: null, next: { text: 'Weiter' }, stage: { kind: 'form' } });
  });

  it('keeps an outside Apply action unknown beside an email-only contact form', () => {
    for (const action of ['Submit', 'Weiter']) {
      const snapshot = {
        url,
        fields: [{ id: 'contact-email', label: 'E-Mail', inputType: 'email', formId: 'contact-form' }],
        buttons: [opener('open', { href: '#' }), { id: 'contact-action', text: action, formId: 'contact-form' }],
      };
      expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
      expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'unknown_apply' });
      expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, url, { snapshot, applyUrl: url }))
        .toMatchObject({ submit: null, next: null, stage: { kind: 'unknown_apply' } });
    }
  });

  it('keeps an outside link to another document as an unknown Apply action', () => {
    const snapshot = {
      url,
      fields: identityFields('application'),
      buttons: [opener('open', { href: 'https://jobs.example.test/application/start', leavesDocument: true }),
        { id: 'next', text: 'Weiter', formId: 'application' }],
    };
    expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'unknown_apply' });
  });

  it('keeps an opener unknown when its form has no step or submit control', () => {
    const snapshot = { url, fields: identityFields('application'), buttons: [opener('open')] };
    expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'unknown_apply' });
  });

  it('keeps openers unknown when two applicant forms have their own step controls', () => {
    const snapshot = {
      url,
      fields: [...identityFields('first-form'), ...identityFields('second-form')],
      buttons: [opener('open-one'), opener('open-two'),
        { id: 'next-one', text: 'Weiter', formId: 'first-form' },
        { id: 'next-two', text: 'Weiter', formId: 'second-form' }],
    };
    expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'unknown_apply' });
  });

  it('recognizes a later page from its CV upload when the identity fields are hidden', () => {
    const snapshot = {
      url,
      text: 'Bewerbung',
      fields: [
        { id: 'cv', kind: 'file', inputType: 'file', label: 'Lebenslauf *', required: true, formId: 'application' },
        { id: 'start', label: 'Frühester Eintritt', formId: 'application' },
      ],
      buttons: [opener('open-one'), opener('open-two'),
        { id: 'previous', text: 'Previous', formId: 'application' },
        { id: 'submit', text: 'ABSCHICKEN', formId: 'application' }],
    };

    expect(inPageApplicationOpeners(snapshot, url)).toHaveLength(2);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'form' });
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, url, { snapshot, applyUrl: url }).submit)
      .toMatchObject({ text: 'ABSCHICKEN' });
  });

  it('uses a required same-form file only when the runner already proved the CV upload', () => {
    const snapshot = {
      url,
      uploadedCv: true,
      fields: [{ id: 'attachment', kind: 'file', inputType: 'file', label: 'Upload document', required: true, formId: 'application' }],
      buttons: [opener('open-one'), opener('open-two'), { id: 'submit', text: 'Submit application', formId: 'application' }],
    };

    expect(inPageApplicationOpeners(snapshot, url)).toHaveLength(2);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'form' });
  });

  it('does not qualify generic contact attachments, cover letters, multiple CV forms, Previous-only forms, or leaving openers', () => {
    const cv = (formId: string, label = 'CV') => ({ id: `${formId}-file`, kind: 'file', inputType: 'file', label, required: true, formId });
    const snapshots = [
      {
        fields: [{ id: 'email', label: 'E-Mail', inputType: 'email', formId: 'contact' },
          { id: 'attachment', kind: 'file', inputType: 'file', label: 'Attachment', required: true, formId: 'contact' }],
        buttons: [opener('open-contact', { href: '#' }), { id: 'contact-submit', text: 'Submit', formId: 'contact' }],
      },
      {
        fields: [cv('letter', 'Motivationsschreiben')],
        buttons: [opener('open-letter', { href: '#' }), { id: 'letter-submit', text: 'Submit', formId: 'letter' }],
      },
      {
        fields: [cv('first'), cv('second')],
        buttons: [opener('open-one', { href: '#' }), opener('open-two', { href: '#' }),
          { id: 'first-submit', text: 'Submit', formId: 'first' }, { id: 'second-submit', text: 'Submit', formId: 'second' }],
      },
      {
        fields: [cv('previous-only')],
        buttons: [opener('open-previous', { href: '#' }), { id: 'previous', text: 'Previous', formId: 'previous-only' }],
      },
      {
        fields: [cv('leaving')],
        buttons: [opener('open-leaving', { href: '/application/start', leavesDocument: true }),
          { id: 'leaving-submit', text: 'Submit', formId: 'leaving' }],
      },
    ];

    for (const scenario of snapshots) {
      const snapshot = { url, ...scenario };
      expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
      expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'unknown_apply' });
    }
  });

  it('keeps a generic Apply control inside its applicant form as the current final action', () => {
    const snapshot = {
      url,
      fields: [...identityFields('application'), { id: 'cv', kind: 'file', inputType: 'file', formId: 'application' }],
      buttons: [{ id: 'apply', text: 'Jetzt bewerben', formId: 'application' }],
    };
    expect(inPageApplicationOpeners(snapshot, url)).toEqual([]);
    expect(applicationStage(snapshot, { url, applyUrl: url })).toMatchObject({ kind: 'form' });
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, url, { snapshot, applyUrl: url }).submit)
      .toMatchObject({ text: 'Jetzt bewerben' });
  });
});

describe('Gravity Forms AJAX receipts', () => {
  const url = 'https://jobs.example.test/job/caregiver';
  const finalSubmission = { clicked: true, formId: '0\u0000gform_1', nativeFormId: 'gform_1' };
  const snapshot = {
    url,
    text: 'Vielen Dank für Ihre Bewerbung. Ihre Bewerbung ist eingegangen.',
    fields: [],
    buttons: [],
    errors: [],
    gravityForms: {
      formIds: [],
      validationError: false,
      confirmations: [{ formId: 'gform_1', visible: true, text: 'Vielen Dank für Ihre Bewerbung. Ihre Bewerbung ist eingegangen.' }],
    },
  };

  it('confirms a native receipt after the guarded final click replaces the same form', () => {
    expect(gravityFormsSubmissionOutcome(snapshot, { finalSubmission })).toBe('confirmed');
    expect(applicationReceipt(snapshot, { url, applyUrl: url, submissionUrl: url, finalSubmission })).toBe(true);
  });

  it('recognizes explicit German, French, Italian, and English receipt copy', () => {
    const messages = [
      'Ihre Bewerbung ist eingegangen.',
      'Merci pour votre candidature.',
      'Grazie per la candidatura.',
      'Thank you for your application.',
    ];
    for (const text of messages) {
      const localized = {
        ...snapshot,
        text,
        gravityForms: {
          ...snapshot.gravityForms,
          confirmations: [{ formId: 'gform_1', visible: true, text }],
        },
      };
      expect(gravityFormsSubmissionOutcome(localized, { finalSubmission })).toBe('confirmed');
      expect(applicationReceipt(localized, { url, applyUrl: url, submissionUrl: url, finalSubmission })).toBe(true);
    }
  });

  it('does not confirm the same text without proof of the final click', () => {
    expect(gravityFormsSubmissionOutcome(snapshot, {})).toBeNull();
    expect(applicationReceipt(snapshot, { url, applyUrl: url, submissionUrl: url })).toBe(false);
    const receiptRoute = 'https://jobs.example.test/job/thank-you';
    const unclickedReceipt = { ...snapshot, url: receiptRoute, text: 'Fachperson Betreuung: Thank you for your application.' };
    expect(applicationReceipt(unclickedReceipt, {
      url: receiptRoute, applyUrl: receiptRoute, submissionUrl: receiptRoute, job: { title: 'Fachperson Betreuung' },
    })).toBe(false);
  });

  it('does not confirm while the clicked Gravity Form is still present', () => {
    const stillPresent = { ...snapshot, gravityForms: { ...snapshot.gravityForms, formIds: ['gform_1'] } };
    expect(gravityFormsSubmissionOutcome(stillPresent, { finalSubmission })).toBeNull();
    expect(applicationReceipt(stillPresent, { url, applyUrl: url, submissionUrl: url, finalSubmission })).toBe(false);
  });

  it('requires the native receipt ID to match the guarded form and frame', () => {
    const wrongNativeForm = {
      ...snapshot,
      gravityForms: {
        ...snapshot.gravityForms,
        confirmations: [{ formId: '0\u0000gform_2', visible: true, text: 'Thank you for your application.' }],
      },
    };
    const misboundSubmission = { ...finalSubmission, nativeFormId: 'gform_2' };
    expect(gravityFormsSubmissionOutcome(wrongNativeForm, { finalSubmission: misboundSubmission })).toBeNull();
    expect(applicationReceipt(wrongNativeForm, { url, applyUrl: url, submissionUrl: url, finalSubmission: misboundSubmission })).toBe(false);

    const otherFrame = {
      ...snapshot,
      gravityForms: {
        ...snapshot.gravityForms,
        confirmations: [{ formId: '1\u0000gform_1', visible: true, text: 'Thank you for your application.' }],
      },
    };
    expect(gravityFormsSubmissionOutcome(otherFrame, { finalSubmission })).toBeNull();
  });

  it('does not let a same-path Gravity Forms receipt change the posting query key', () => {
    const otherPostingUrl = `${url}?jobid=2`;
    expect(applicationReceipt({ ...snapshot, url: otherPostingUrl }, {
      url: otherPostingUrl,
      applyUrl: `${url}?jobid=1`,
      finalSubmission,
    })).toBe(false);
  });

  it('treats a Gravity Forms validation response as validation, even with confirmation copy', () => {
    const validation = {
      ...snapshot,
      url: 'https://jobs.example.test/job/thank-you',
      text: 'Fachperson Betreuung: Thank you for your application.',
      gravityForms: { ...snapshot.gravityForms, formIds: ['gform_1'], validationError: true, validationFormIds: ['gform_1'] },
    };
    expect(gravityFormsSubmissionOutcome(validation, { finalSubmission })).toBe('validation');
    expect(applicationReceipt(validation, {
      url: validation.url, applyUrl: validation.url, submissionUrl: validation.url, finalSubmission,
      job: { title: 'Fachperson Betreuung' },
    })).toBe(false);
  });
});

describe('split birth date select options', () => {
  it('maps day, named month, and year to options in the observed catalogue', () => {
    const dob = '1990-05-12';
    const day = { label: 'Geburtstag', placeholder: 'Tag', options: Array.from({ length: 31 }, (_, index) => ({ label: `${index + 1}.`, value: `${String(index + 1).padStart(2, '0')}.` })) };
    const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    const month = { label: 'Geburtsdatum', placeholder: 'Monat', options: monthNames.map((label, index) => ({ label, value: String(index + 1).padStart(2, '0') })) };
    const year = { label: 'Geburtsdatum', placeholder: 'Jahr', options: Array.from({ length: 21 }, (_, index) => String(1980 + index)) };

    expect(birthDatePartOption(day, dob)).toBe('12.');
    expect(birthDatePartOption(month, dob)).toBe('Mai');
    expect(birthDatePartOption(year, dob)).toBe('1990');
    expect(birthDatePartOption({ ...day, options: day.options.slice(0, 11) }, dob)).toBeNull();
  });

  it('keeps a valid planned select choice when the deterministic date is not listed, and asks when neither is listed', () => {
    const field = {
      id: 'start-date', kind: 'select', label: 'Earliest start date', required: true,
      options: [{ label: 'Immediately' }, { label: 'In four weeks' }],
    };
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [
      { question: 'Earliest start date', answer: '15.01.2027', source: 'user' },
    ] };
    const planned = (value: string) => guardPlan({
      actions: [{ fieldId: field.id, action: 'select', value, source: 'answers', evidence: '' }], missingRequired: [],
    }, [field], candidate);

    expect(candidateAnswerForField(candidate, field)?.value).toBe('15.01.2027');
    expect(planned('Immediately').actions).toMatchObject([{ fieldId: field.id, value: 'Immediately' }]);
    expect(planned('Tomorrow')).toMatchObject({ actions: [], missingRequired: [{ fieldId: field.id }] });
  });
});

// career-ops comparison of 2026-10-01: what the portal runner still lacked.
describe('portal runner hardening (career-ops apply.md)', () => {
  it('recognizes the RHB Talentsoft resume-upload step as the matching posting form', () => {
    const title = 'Gesamtverantwortliche/r Kundeninformation (60-100%)';
    const job = { company: 'Ferrovia Retica (RhB)', title };
    const url = 'https://rhb-career.talent-soft.com/mein-portal/mein-lebenslauf-fuer-meine-bewerbung-fuer-gesamtverantwortliche-r-kundeninformation-60-100-_2233.aspx?ApplicationType=OfferApplication';
    const snapshot = {
      fields: [
        { id: 'search', kind: 'text', label: 'Suchbegriffe (z.B.: Projektleiter)' },
        { id: 'document', kind: 'select', label: 'Mein Lebenslauf' },
        { id: 'name', kind: 'text', label: 'Name des Anhangs :' },
        { id: 'cv', kind: 'file', label: 'Lebenslauf :', required: true },
      ],
      buttons: [
        { text: 'Suchen' },
        { text: 'Hinzufügen' },
        { text: 'Abbrechen' },
        { text: 'Weiter' },
      ],
    };
    const formText = [
      'Rhätische Bahn - Meine Bewerbung absenden',
      'Bezeichnung des Angebots',
      title,
      'Sie können nun Ihren Lebenslauf hochladen.',
      ...snapshot.fields.map((field) => field.label),
    ].join('\n');
    const postingUrl = url.replace('?ApplicationType=OfferApplication', '?source=paid-posting');

    expect(hasApplicationSurface(snapshot)).toBe(true);
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, url).next).toEqual(expect.objectContaining({ text: 'Weiter' }));
    expect(postingMatch('Senior Engineer Weiter', { company: 'Ferrovia Retica (RhB)', title: 'Senior Engineer' }, url)).toBe('match');
    expect(formPostingMatch(formText, job, { pageUrl: url, postingUrl, paidPostingUrl: postingUrl })).toBe('match');
    expect(formPostingMatch(formText.replace('Rhätische Bahn', 'Rhätische Bahn AG'), job, {
      pageUrl: url, postingUrl, paidPostingUrl: postingUrl,
    })).toBe('match');
    expect(formPostingMatch(formText, job, { pageUrl: url })).toBe('mismatch');
    expect(formPostingMatch(formText, job, {
      pageUrl: url, postingUrl, paidPostingUrl: postingUrl.replace('_2233.aspx', '_2234.aspx'),
    })).toBe('mismatch');
    expect(formPostingMatch(formText, job, {
      pageUrl: url,
      paidPostingUrl: postingUrl.replace('_2233.aspx', '_2234.aspx'),
      postingEntry: true,
    })).toBe('mismatch');
    expect(formPostingMatch(formText, job, {
      pageUrl: url,
      paidPostingUrl: postingUrl.replace('_2233.aspx', '_2234.aspx'),
      applicationEntry: true,
      postingMatched: true,
    })).toBe('mismatch');
    expect(formPostingMatch(formText, job, {
      pageUrl: url,
      paidPostingUrl: 'https://rhb-career.talent-soft.com/application?source=paid',
      postingEntry: true,
    })).toBe('mismatch');
    for (const suffix of ['/', '/step']) {
      expect(formPostingMatch(formText, job, {
        pageUrl: url.replace('_2233.aspx', `_2233.aspx${suffix}`),
        paidPostingUrl: postingUrl.replace('_2233.aspx', '_2234.aspx'),
        postingEntry: true,
      })).toBe('mismatch');
    }
    expect(formPostingMatch(formText.replace('Meine Bewerbung absenden', 'Other Resort - Meine Bewerbung absenden'), job, { pageUrl: url })).toBe('mismatch');
    expect(formPostingMatch(formText.replace('Meine Bewerbung absenden', 'Other Resort - Meine Bewerbung absenden'), job, {
      pageUrl: url, postingUrl, paidPostingUrl: postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch(formText.replace('Meine Bewerbung absenden', 'Rhätische Bahn - Other Resort - Meine Bewerbung absenden'), job, {
      pageUrl: url, postingUrl, paidPostingUrl: postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch(formText.replace('Rhätische Bahn - Meine Bewerbung absenden', 'Other Resort - Rhätische Bahn - Meine Bewerbung absenden'), job, {
      pageUrl: url, postingUrl, paidPostingUrl: postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch(formText.replace('Rhätische Bahn', 'Other Resort'), job, { pageUrl: url })).toBe('mismatch');
    expect(formPostingMatch(formText, job, { pageUrl: url.replace('rhb-career', 'other-career') })).toBe('mismatch');
    expect(formPostingMatch(formText, {
      ...job,
      title: 'Rangiermitarbeiter/in (50-100%)',
    })).toBe('mismatch');
  });

  it('rejects a TalentSoft form headed by another employer even when tenant alias and role match', () => {
    const job = { company: 'Acme AG (ACME)', title: 'Senior Engineer' };
    const heading = 'Greenfield Systems - My application';
    const formText = `${heading}\nSenior Engineer`;
    const talentSoftUrl = 'https://acme-career.talent-soft.com/job/fixture_123.aspx';

    expect(formPostingMatch(formText, job, { pageUrl: talentSoftUrl })).toBe('mismatch');
    expect(formPostingMatch(formText, job, { pageUrl: talentSoftUrl, paidPostingUrl: talentSoftUrl })).toBe('mismatch');
    expect(formPostingMatch(`ACME - Greenfield Systems\n${job.title}`, job, { pageUrl: talentSoftUrl })).toBe('mismatch');
    expect(formPostingMatch(`Research Hub - My application\n${job.title}`, job, { pageUrl: talentSoftUrl })).toBe('mismatch');
    expect(formPostingMatch(`${formText}\n${talentSoftUrl}`, job, {
      pageUrl: 'https://other-career.example/apply/fixture',
    })).toBe('mismatch');

    const mixedCaseAliasJob = { company: 'Acme AG (RhB)', title: 'Senior Engineer' };
    expect(formPostingMatch('Research High Bio - My application\nSenior Engineer', mixedCaseAliasJob, {
      pageUrl: 'https://rhb-career.talent-soft.com/apply/fixture',
    })).toBe('mismatch');
  });

  it('does not treat arbitrary names beginning with the letters of a mixed-case employer alias as equivalent', () => {
    const job = { company: 'Ferrovia Retica (RhB)', title: 'Senior Engineer' };
    const pageUrl = 'https://rhb-career.talent-soft.com/job/fixture_2233.aspx';
    const paidPostingUrl = 'https://rhb-career.talent-soft.com/job/fixture_2233.aspx?source=paid-posting';
    const wrongPaidPostingUrl = paidPostingUrl.replace('_2233.aspx', '_2234.aspx');
    const localizedDocumentTitle = `My application\nRhätische Bahn - My application\n${job.title}`;

    expect(formPostingMatch(localizedDocumentTitle, job, {
      pageUrl,
      paidPostingUrl,
      pageHeading: 'Rhätische Bahn - My application',
    })).toBe('match');
    expect(formPostingMatch(localizedDocumentTitle, job, {
      pageUrl,
      paidPostingUrl: wrongPaidPostingUrl,
      postingEntry: true,
      pageHeading: 'Rhätische Bahn - My application',
    })).toBe('mismatch');
    expect(formPostingMatch(localizedDocumentTitle, job, {
      pageUrl,
      paidPostingUrl,
      pageHeading: 'Other Resort - My application',
    })).toBe('mismatch');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl,
      paidPostingUrl,
      pageHeadings: ['Rhätische Bahn - My application', 'Other Resort - My application'],
    })).toBe('mismatch');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl,
      paidPostingUrl,
      pageHeadings: null,
    })).toBe('unknown');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl: 'https://rhb-career.talent-soft.com/application',
      pageHeadings: null,
    })).toBe('unknown');
    const wrongFinalRoute = pageUrl.replace('_2233.aspx', '_2234.aspx');
    for (const formText of ['My application\nSenior Engineer', 'My application']) {
      expect(formPostingMatch(formText, job, {
        pageUrl: wrongFinalRoute,
        paidPostingUrl,
        postingEntry: true,
        postingMatched: true,
        pageHeadings: [],
      })).toBe('mismatch');
    }

    for (const employer of ['Rhine Business', 'Rhodium Bank']) {
      expect(formPostingMatch(`${employer} - My application\n${job.title}`, job, {
        pageUrl,
        paidPostingUrl,
      })).toBe('mismatch');
    }
    expect(formPostingMatch(`Bahn AG - My application\n${job.title}`, job, {
      pageUrl,
      paidPostingUrl,
    })).toBe('mismatch');
  });

  it('does not treat a generic Workday information heading as another employer', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    for (const heading of [
      'My Information', 'My Experience', 'My Documents', 'Application Questions', 'Voluntary Disclosures', 'My Education',
      'Meine Ausbildung', 'Mes études', 'La mia formazione', 'Review', 'Review and Submit', 'Personal Details',
      'Contact Details', 'Your Profile', 'Work History', 'Candidate Details',
    ]) {
      expect(formPostingMatch(`${heading}\nSenior Engineer`, job, {
        pageUrl: 'https://careers.acme.example/application',
        postingMatched: true,
        applicationEntry: true,
        pageHeading: heading,
        pageHeadings: [heading],
      })).toBe('unknown');
    }
    expect(formPostingMatch('Review\nSenior Engineer', job, {
      pageUrl: 'https://careers.acme.example/application',
      postingMatched: true,
      applicationEntry: true,
      pageHeading: 'Review - Other Resort',
      pageHeadings: ['Review - Other Resort'],
    })).toBe('mismatch');
  });

  it('keeps the ambiguous “About You” heading unknown until a posting link is proved', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    const formText = 'About You\nSenior Engineer';
    const pageUrl = 'https://careers.example/application';

    expect(formPostingMatch(formText, job, {
      pageUrl,
      pageHeading: 'About You',
      pageHeadings: ['About You'],
    })).toBe('unknown');
    expect(formPostingMatch(formText, job, {
      pageUrl,
      postingMatched: true,
      applicationEntry: true,
      pageHeading: 'About You',
      pageHeadings: ['About You'],
    })).toBe('unknown');
    expect(formPostingMatch(formText, job, {
      pageUrl,
      postingMatched: true,
      applicationEntry: true,
      pageHeading: 'About You - Other Resort',
      pageHeadings: ['About You - Other Resort'],
    })).toBe('mismatch');
    expect(formPostingMatch(formText, { company: 'ABOUT YOU', title: 'Senior Engineer' }, {
      pageUrl,
      pageHeading: 'About You',
      pageHeadings: ['About You'],
    })).toBe('match');
  });

  it('opens a SuccessFactors application from its matching posting page', () => {
    const applyUrl = 'https://jobs.six-group.com/talentcommunity/apply/1448418433/?locale=en_US';
    const postingUrl = 'https://jobs.six-group.com/job/Zurich-Senior-IT-Manager/1448418433/';

    expect(portalEntryUrl({ applyUrl, postingUrl })).toBe(postingUrl);
    expect(portalEntryUrl({ applyUrl, postingUrl: postingUrl.replace('1448418433', '1448418434') })).toBe(applyUrl);
    expect(portalEntryUrl({ applyUrl, postingUrl: postingUrl.replace('jobs.six-group.com', 'www.six-group.com') })).toBe(applyUrl);
  });

  it('binds an external Career Site Builder module only to its source-backed posting', () => {
    const postingUrl = 'https://careers.helsana.ch/job/D%C3%BCbendorf-Stettbach-&-Homeoff-IT-Management-Assistenz-%28a%29-80/1426391333/';
    const moduleUrl = 'https://career5.successfactors.eu/career?company=Helsana&career_job_req_id=34525&lang=de_DE&career_ns=job_application';
    const moduleWithoutQuery = 'https://career5.successfactors.eu/career';
    const proof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };

    // The external module's requisition id is not the public posting id. URL
    // shape alone is therefore deliberately not enough to bind the routes.
    expect(isVerifiedPostingEntry({ applyUrl: moduleUrl, postingUrl })).toBe(false);
    expect(portalEntryUrl({ applyUrl: moduleUrl, postingUrl })).toBe(moduleUrl);
    expect(isVerifiedPostingEntry({ applyUrl: moduleWithoutQuery, postingUrl, postingRouteProof: proof })).toBe(false);
    expect(portalEntryUrl({ applyUrl: moduleUrl, postingUrl, postingRouteProof: proof })).toBe(postingUrl);
    const normalizedModuleUrl = 'https://career5.successfactors.eu/career?career_ns=job_application&career_job_req_id=34525&company=helsana&login_ns=login';
    expect(portalEntryUrl({ applyUrl: normalizedModuleUrl, postingUrl, postingRouteProof: proof })).toBe(postingUrl);
    const genericForm = 'Karrierechancen: Anmelden\nE-Mail-Adresse\nKennwort\nAnmelden';
    const job = { company: 'Helsana', title: 'IT Management Assistenz (a) 80%' };
    expect(formPostingMatch(genericForm, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: moduleUrl,
      postingUrl,
      postingRouteProof: proof,
    })).toBe('match');
    expect(isVerifiedPostingEntry({
      applyUrl: moduleUrl.replace('career_job_req_id=34525', 'career_job_req_id=34526'),
      postingUrl,
      postingRouteProof: proof,
    })).toBe(false);
    expect(formPostingMatch(genericForm, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: moduleUrl.replace('career_job_req_id=34525', 'career_job_req_id=34526'),
      postingUrl,
      postingRouteProof: proof,
    })).toBe('mismatch');
    expect(isVerifiedPostingEntry({
      applyUrl: moduleUrl,
      postingUrl: postingUrl.replace('1426391333', '1426391334'),
      postingRouteProof: proof,
    })).toBe(false);
  });

  it('binds a legacy SuccessFactors module when career_ns is omitted', () => {
    const postingUrl = 'https://jobs.admin.example/job/Example-Role/123456/';
    const moduleUrl = 'https://career2.successfactors.eu/career?company=STZH&career_job_req_id=1';
    const portalCareerUrl = 'https://career2.successfactors.eu/portalcareer';
    const proof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const job = { company: 'Stadt Zürich', title: 'Example Role' };
    const form = 'Karrierechancen: Anmelden\nE-Mail-Adresse\nKennwort\nBewerbung abschicken';

    expect(isVerifiedPostingEntry({ applyUrl: moduleUrl, postingUrl })).toBe(false);
    expect(isVerifiedPostingEntry({ applyUrl: moduleUrl, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(isVerifiedPostingEntry({ applyUrl: portalCareerUrl, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(isPostingRouteBound({ pageUrl: portalCareerUrl, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(formPostingMatch(form, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: portalCareerUrl,
      postingUrl,
      postingRouteProof: proof,
    })).toBe('match');

    expect(isVerifiedPostingEntry({
      applyUrl: `${moduleUrl}&career_ns=job_listing`,
      postingUrl,
      postingRouteProof: proof,
    })).toBe(false);
  });

  it('keeps a SuccessFactors portalcareer continuation bound to its source module', () => {
    const postingUrl = 'https://jobs.admin.example/job/Example-Role/123456/';
    const moduleUrl = 'https://career74.sapsf.eu/career?company=examplefed&career_job_req_id=34525&career_ns=job_application';
    const portalCareerUrl = 'https://career74.sapsf.eu/portalcareer';
    const proof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const job = { company: 'Bundesverwaltung', title: 'Example Role' };
    const form = [
      'Karrierechancen: Bewerbung',
      'Optionen',
      'Alle Abschnitte einblenden',
      'Alle Abschnitte ausblenden',
      'Meine Dokumente',
      'Lebenslauf Lebenslauf hinzufügen Öffnet ein Dialogfeld',
      'Motivationsschreiben Motivationsschreiben hinzufügen Öffnet ein Dialogfeld',
      'Zeugnisse, Diplome und weitere Dokumente Dokument hinzufügen Öffnet ein Dialogfeld',
      'Meine persönlichen Informationen',
      'Stellenspezifische Informationen',
      'Bewerbungsprofil anzeigen',
      'Sprache',
      'Speichern',
      'Bewerben',
    ].join('\n');

    expect(isVerifiedPostingEntry({ applyUrl: portalCareerUrl, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(isPostingRouteBound({ pageUrl: portalCareerUrl, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(formPostingMatch(form, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: portalCareerUrl,
      postingUrl,
      postingRouteProof: proof,
    })).toBe('match');

    const sameIdentity = `${portalCareerUrl}?company=examplefed&career_ns=job_application&career_job_req_id=34525&login_ns=login`;
    expect(isVerifiedPostingEntry({ applyUrl: sameIdentity, postingUrl, postingRouteProof: proof })).toBe(true);
    expect(isVerifiedPostingEntry({
      applyUrl: `${portalCareerUrl}?company=examplefed&career_ns=job_application&career_job_req_id=34526`,
      postingUrl,
      postingRouteProof: proof,
    })).toBe(false);
    expect(isVerifiedPostingEntry({ applyUrl: portalCareerUrl.replace('career74', 'career75'), postingUrl, postingRouteProof: proof })).toBe(false);
  });

  it('keeps a same-posting Jobs2Web shell bound while only the language control is visible', () => {
    const postingUrl = 'https://jobs.stadt-zuerich.ch/job/Application-Manager/1373719857/';
    const applyUrl = 'https://jobs.stadt-zuerich.ch/talentcommunity/apply/1373719857/?locale=de_DE';
    const job = { company: 'Stadt Zürich', title: 'Application Manager' };
    const snapshot = {
      fields: [],
      buttons: [{ text: 'Sprache', chrome: true }],
    };
    const shellText = `Application Manager Stellendetails | STZH\nSprache\n${postingUrl}`;

    expect(hasApplicationSurface(snapshot)).toBe(false);
    expect(isPostingRouteBound({ pageUrl: postingUrl, postingUrl })).toBe(true);
    expect(isPostingRouteBound({ pageUrl: applyUrl, postingUrl })).toBe(true);
    expect(isPostingRouteBound({
      pageUrl: 'https://jobs.stadt-zuerich.ch/job/Other-Role/999999999/',
      postingUrl,
    })).toBe(false);
    expect(isPostingRouteBound({
      pageUrl: 'https://jobs.example/vacancy?req=1',
      postingUrl: 'https://jobs.example/vacancy?req=2',
    })).toBe(false);
    expect(isPostingRouteBound({
      pageUrl: `${postingUrl}#job=2`,
      postingUrl: `${postingUrl}#job=1`,
    })).toBe(false);
    expect(isPostingRouteBound({
      pageUrl: `${postingUrl}#job=1`,
      postingUrl: `${postingUrl}#job=1`,
    })).toBe(true);
    const workdayUrl = 'https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/123';
    expect(isPostingRouteBound({ pageUrl: workdayUrl, postingUrl: workdayUrl })).toBe(false);
    expect(formPostingMatch(shellText, job, { pageUrl: postingUrl, postingUrl })).toBe('match');
    expect(hasApplicationSurface(snapshot, {
      pageUrl: postingUrl,
      postingUrl,
      postingMatch: 'match',
    })).toBe(true);
    expect(hasApplicationSurface(snapshot, {
      pageUrl: workdayUrl,
      postingUrl: workdayUrl,
      postingMatch: 'match',
    })).toBe(false);
    expect(hasApplicationSurface({}, {
      pageUrl: 'https://jobs.example/posting',
      postingUrl: 'https://jobs.example/posting',
      postingMatch: 'match',
    })).toBe(false);
    expect(hasApplicationSurface({}, {
      pageUrl: postingUrl,
      postingUrl,
      postingMatch: 'match',
    })).toBe(true);
    const umantisPostingUrl = 'https://company.umantis.com/Vacancies/123/Description/456';
    const umantisApplyUrl = 'https://company.umantis.com/Vacancies/123/Application/New/456';
    expect(isPostingRouteBound({ pageUrl: umantisApplyUrl, postingUrl: umantisPostingUrl })).toBe(true);
    expect(hasApplicationSurface(snapshot, {
      pageUrl: umantisApplyUrl,
      postingUrl: umantisPostingUrl,
      postingMatch: 'match',
    })).toBe(false);
  });

  it('opens a same-job employer apply route from its matching posting page', () => {
    const applyUrl = 'https://www.alten.ch/jobs/903-pipe-project-manager-it/apply';
    const postingUrl = 'https://www.alten.ch/jobs/903-pipe-project-manager-it/';

    expect(portalEntryUrl({ applyUrl, postingUrl })).toBe(postingUrl);
    const localizedApplyUrl = 'https://www.alten.ch/de/jobs/903-pipe-project-manager-it/apply';
    const localizedEntry = isVerifiedPostingEntry({ applyUrl: localizedApplyUrl, postingUrl });
    expect(localizedEntry).toBe(true);
    expect(portalEntryUrl({ applyUrl: localizedApplyUrl, postingUrl })).toBe(postingUrl);
    expect(formPostingMatch('Application Tracking System\nProject Manager - IT & Banking', {
      company: 'ALTEN Switzerland', title: 'Project Manager - IT & Banking',
    }, { postingMatched: localizedEntry, postingEntry: localizedEntry, pageUrl: localizedApplyUrl })).toBe('match');
    expect(portalEntryUrl({ applyUrl, postingUrl: postingUrl.replace('903-pipe-project-manager-it', '879-google-cloud-platform') })).toBe(applyUrl);
    expect(portalEntryUrl({ applyUrl, postingUrl: postingUrl.replace('www.alten.ch', 'alten.ch') })).toBe(applyUrl);
    expect(portalEntryUrl({ applyUrl: localizedApplyUrl, postingUrl: postingUrl.replace('/jobs/', '/portal/jobs/') })).toBe(localizedApplyUrl);

    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/careers/jobs/a/apply',
      postingUrl: 'https://h/careers/jobs/a/',
    })).toBe(true);
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/de/jobs/a/apply',
      postingUrl: 'https://h/jobs/a/',
    })).toBe(true);
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/careers/jobs/a/apply',
      postingUrl: 'https://h/jobs/a/',
    })).toBe(false);
  });

  it('rejects non-locale prefixes, moved locale segments, and duplicate slashes', () => {
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/hr/jobs/a/apply',
      postingUrl: 'https://h/jobs/a/',
    })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/de/careers/jobs/a/apply',
      postingUrl: 'https://h/careers/fr/jobs/a/',
    })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/jobs//a/apply',
      postingUrl: 'https://h/jobs/a/',
    })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: 'https://h/jobs/a/apply//',
      postingUrl: 'https://h/jobs/a/',
    })).toBe(false);
  });

  it('opens an Umantis Application/New form from its matching vacancy page', () => {
    const applyUrl = 'https://recruitingapp-2983.umantis.com/Vacancies/716/Application/CheckLogin/2?lang=eng';
    const postingUrl = 'https://recruitingapp-2983.umantis.com/Vacancies/716/Description/1';
    const job = { company: 'Grand Hotel Kronenhof', title: 'Chef de Rang - immediate start (m/w/d)' };
    const form = [
      'Application Tracking System',
      'Photo',
      'First name',
      'Last name',
      'Email address/login',
      'Password',
      'Cell phone',
      'Cover letter',
      'Resume',
      'Other documents',
      'Press the Enter key to upload the document.',
      'How did you hear about us?',
      'I am a current employee of your company',
      'I have worked for your company before',
      'I agree to the Privacy Policy Statement',
      'Title *:',
      'User language *:',
      'Data release *:',
      'Personal data',
      'User settings',
      'Contact data',
      'Documents',
      'Relationship with our company',
      'Data release',
      'Privacy policy statement',
      'Submit final application',
      'https://recruitingapp-2983.umantis.com/Vacancies/716/Application/New/2',
    ].join('\n');

    expect(portalEntryUrl({ applyUrl, postingUrl })).toBe(postingUrl);
    expect(isVerifiedPostingEntry({ applyUrl, postingUrl })).toBe(true);
    expect(portalEntryUrl({ applyUrl, postingUrl: 'https://careers.kronenhof.com/en/vacancies/716' })).toBe(applyUrl);
    expect(portalEntryUrl({ applyUrl, postingUrl: postingUrl.replace('/716', '/717') })).toBe(applyUrl);
    expect(formPostingMatch(form, job)).toBe('mismatch');
    const enteredFromMatchingPosting = isVerifiedPostingEntry({ applyUrl, postingUrl });
    expect(formPostingMatch(form, job, {
      postingMatched: enteredFromMatchingPosting,
      postingEntry: enteredFromMatchingPosting,
    })).toBe('match');
  });

  it('requires a same-origin Umantis vacancy binding before changing the entry URL', () => {
    const applyUrl = 'https://jobs.umantis.com/Vacancies/717/Application/New/2';
    const pairedPostingUrl = 'https://jobs.umantis.com/Vacancies/717/Description/1';

    expect(portalEntryUrl({ applyUrl, postingUrl: pairedPostingUrl })).toBe(pairedPostingUrl);
    expect(portalEntryUrl({ applyUrl, postingUrl: 'https://other.example/Vacancies/717' })).toBe(applyUrl);
  });

  it('opens the direct Umantis form when the saved apply URL is the exact vacancy page', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Description/4';
    const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Application/New/4';
    const job = { company: 'EOC', title: 'Assistente sociale (80-100%)' };
    const verified = isVerifiedPostingEntry({ applyUrl: applicationUrl, postingUrl });

    expect(portalEntryUrl({ applyUrl: postingUrl, postingUrl })).toBe(applicationUrl);
    expect(verified).toBe(true);
    expect(formPostingMatch('Assistente sociale - Candidatura | EOC candiDati\nApplication Tracking System', job, {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applicationUrl,
    })).toBe('match');
    expect(portalEntryUrl({ applyUrl: postingUrl, postingUrl: postingUrl.replace('/2806/', '/2807/') })).toBe(postingUrl);
    expect(portalEntryUrl({ applyUrl: postingUrl, postingUrl: postingUrl.replace('recruitingapp-2761', 'other') })).toBe(postingUrl);
  });

  it('accepts a route-bound neutral Umantis opener without weakening mismatch protection', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Description/4';
    const snapshot = {
      url: postingUrl,
      text: 'L’EOC Assistente sociale (80-100%)',
      fields: [],
      buttons: [{ text: 'cliccando qui', domId: 'click-open', formId: 'f2', frame: 0 }],
      links: [],
    };
    const context = {
      applyUrl: postingUrl,
      postingUrl,
      pageTitle: 'Assistente sociale - Ausschreibung',
      job: { company: 'EOC – Ente Ospedaliero Cantonale', title: 'Assistente sociale (80-100%)' },
      allowSingleExternalApplicationEntry: true,
    };

    expect(applicationEntryControls(snapshot, context)).toEqual([
      expect.objectContaining({ text: 'cliccando qui', domId: 'click-open' }),
    ]);
    expect(applicationEntryControls({ ...snapshot, url: postingUrl.replace('/2806/', '/2807/') }, context)).toEqual([]);
    expect(applicationEntryControls({
      ...snapshot,
      buttons: [...snapshot.buttons, { text: 'Candidati ora', href: 'https://example.test/apply', frame: 0 }],
    }, context)).toEqual([]);
  });

  it('binds Workday Apply and manual entry to the same tenant, site, location, and requisition route', () => {
    const postingUrl = 'https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Switzerland/Ticino/Consultant_R-12345-1';
    const applyUrl = `${postingUrl}/apply?locationCountry=CH`;
    const applyManuallyUrl = `${postingUrl}/apply/applyManually?locationCountry=CH`;
    const jobRoomUrl = 'https://jobs.example.test/room/consultant';
    const job = { title: 'Consulente vendite', company: 'Acme Switzerland' };
    const context = { applyUrl: postingUrl, postingUrl: jobRoomUrl, job };
    const postingSnapshot = {
      url: postingUrl,
      text: 'Apply for this job',
      fields: [],
      buttons: [],
      links: [{ text: 'Postuler', href: applyUrl, role: 'button', dataAutomationId: 'adventureButton', frame: 0 }],
    };
    const manualSnapshot = {
      url: applyUrl,
      fields: [],
      buttons: [
        { text: 'Apply with Autofill', frame: 0 },
        { text: 'Use my last application', frame: 0 },
        { text: 'Postuler manuellement', frame: 0 },
      ],
      links: [],
    };

    expect(isVerifiedPostingEntry({ applyUrl, postingUrl })).toBe(true);
    expect(isVerifiedPostingEntry({ applyUrl: applyUrl.replace('/en-US/', '/fr-CH/'), postingUrl })).toBe(true);
    expect(applicationEntryControls(postingSnapshot, context)).toEqual([
      expect.objectContaining({ text: 'Postuler', href: applyUrl, dataAutomationId: 'adventureButton' }),
    ]);
    expect(applicationEntryControls(manualSnapshot, context)).toEqual([
      expect.objectContaining({ text: 'Postuler manuellement' }),
    ]);
    for (const text of ['Apply Manually', 'Manuell bewerben', 'Candidati manualmente']) {
      expect(applicationEntryControls({ ...manualSnapshot, buttons: [{ text, frame: 0 }] }, context))
        .toEqual([expect.objectContaining({ text })]);
    }
    expect(isVerifiedPostingEntry({ applyUrl: applyManuallyUrl, postingUrl })).toBe(true);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], href: `${postingUrl.replace('R-12345', 'R-99999')}/apply` }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], href: `${applyUrl.replace('/Ticino/', '/Zurich/')}` }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], href: applyUrl.replace('/AcmeCareers/', '/OtherCareers/') }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], href: applyUrl.replace('acme.wd3', 'other.wd3') }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], href: applyUrl.replace('https:', 'http:') }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...postingSnapshot, links: [{ ...postingSnapshot.links[0], text: 'Démarrer', href: applyUrl }] }, context)).toEqual([]);
    expect(applicationEntryControls({ ...manualSnapshot, url: `${postingUrl}/apply?locationCountry=CH`.replace('/AcmeCareers/', '/OtherCareers/') }, context)).toEqual([]);
    expect(applicationEntryControls({ ...manualSnapshot, buttons: [{ text: 'Use my last application', frame: 0 }] }, context)).toEqual([]);
  });

  it('normalizes a Workday location in the popup while keeping the exact tenant, site, and requisition', () => {
    const postingUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio-Outlet-CHE/Seasonal-Sales-Consultant_R-12345';
    const applyUrl = 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio%2C-Outlet%2C-CHE/Seasonal-Sales-Consultant_R-12345/apply';
    const manualUrl = `${applyUrl}/applyManually`;
    const context = { applyUrl, postingUrl, job: { title: 'Seasonal Sales Consultant', company: 'Swarovski' } };
    const popup = {
      url: postingUrl,
      fields: [],
      buttons: [
        { text: 'Postuler', href: applyUrl, behindDialog: true, frame: 0 },
        { text: 'Démarrer', dataAutomationId: 'introduceYourselfButton', section: 'Présentez-vous', behindDialog: true, frame: 0 },
      ],
      links: [
        { text: 'Postuler manuellement', href: manualUrl, dialog: true, behindDialog: false, frame: 0 },
        { text: 'Postuler manuellement', href: manualUrl, ariaHidden: true, behindDialog: false, frame: 0 },
        { text: 'Apply with Autofill', href: `${postingUrl}/apply`, dialog: true, behindDialog: false, frame: 0 },
      ],
    };

    expect(isVerifiedPostingEntry({ applyUrl, postingUrl })).toBe(true);
    expect(isVerifiedPostingEntry({ applyUrl: applyUrl.replace('_R-12345', '_R-99999'), postingUrl })).toBe(false);
    expect(isVerifiedPostingEntry({ applyUrl: applyUrl.replace('/swarovski/', '/other-site/'), postingUrl })).toBe(false);
    expect(isVerifiedPostingEntry({ applyUrl: applyUrl.replace('swarovski.wd3', 'other.wd3'), postingUrl })).toBe(false);
    expect(applicationEntryControls(popup, context)).toEqual([
      expect.objectContaining({ text: 'Postuler manuellement', href: manualUrl }),
    ]);
  });

  it('accepts the sole Workday popup opener on the exact fieldless requisition route', () => {
    const postingUrl = 'https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Mendrisio-Outlet-CHE/Consultant_R-12345-1';
    const context = { applyUrl: postingUrl, postingUrl, job: { title: 'Verkaufsberater/in' } };
    const snapshot = {
      url: postingUrl,
      fields: [],
      buttons: [
        { text: 'Postuler', dataAutomationId: 'adventureButton', frame: 0 },
        { text: 'Démarrer', dataAutomationId: 'introduceYourselfButton', section: 'Présentez-vous', frame: 0 },
      ],
      links: [],
    };

    expect(isVerifiedPostingEntry({ applyUrl: postingUrl, postingUrl })).toBe(true);
    expect(applicationEntryControls(snapshot, context)).toEqual([
      expect.objectContaining({ text: 'Postuler', dataAutomationId: 'adventureButton' }),
    ]);
  });

  it.each([
    ['an external source posting', 'https://jobs.example.test/room/rituals'],
    ['an absent source posting', ''],
  ])('accepts the sole Workday Apply opener with %s on the exact requisition route', (_description, postingUrl) => {
    const applyUrl = 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Zurich/Conseiller-de-Vente-h-f_R-12345';
    const context = { applyUrl, postingUrl, job: { title: 'Conseiller de Vente (h/f)', company: 'Rituals' } };
    const snapshot = {
      url: applyUrl,
      fields: [],
      buttons: [
        { text: 'Read Full Privacy Message', frame: 0 },
        { text: 'Decline', frame: 0 },
        { text: 'Accept Cookies', frame: 0 },
        { text: 'Sign In', frame: 0 },
        { text: 'Rituals Careers', frame: 0 },
        { text: 'Apply', frame: 0 },
        { text: 'View All 4 Jobs', frame: 0 },
        { text: 'Read More', frame: 0 },
      ],
      links: [],
    };

    expect(applicationEntryControls(snapshot, context)).toEqual([
      expect.objectContaining({ text: 'Apply' }),
    ]);

    expect(applicationEntryControls(snapshot, {
      ...context,
      postingUrl: applyUrl.replace('R-12345', 'R-99999'),
    })).toEqual([]);
  });

  it.each([
    ['fr', 'Créer une alerte', 'Sélectionnez la fréquence (en jours) de réception d’une alerte :'],
    ['en', 'Create an alert', 'Select how often (in days) to receive an alert:'],
    ['en-job', 'Create a job alert', 'Select how often (in days) to receive an alert:'],
    ['en-job-no-article', 'Create job alert', 'Select how often (in days) to receive an alert:'],
    ['de', 'Benachrichtigung erstellen', 'Wählen Sie aus, wie oft (in Tagen) Sie eine Benachrichtigung erhalten möchten:'],
    ['it', 'Crea un avviso', 'Seleziona la frequenza (in giorni) di ricezione di un avviso:'],
  ])('accepts a Jobs2Web script Apply beside the public alert widget (%s)', (_locale, alertAction, alertField) => {
    const postingUrl = 'https://job.groupe-e.ch/job/cheffe-chef-equipe-infrastructures/123456/';
    const applyUrl = 'https://job.groupe-e.ch/talentcommunity/apply/123456/?locale=fr_FR';
    const apply = { text: 'Postuler »', frame: 0, disabled: false };
    const snapshot = {
      url: postingUrl,
      fields: [{ id: 'alert-frequency', kind: 'text', inputType: 'text', label: alertField, required: true, value: '7', formId: 'job-alert' }],
      buttons: [
        { text: 'Langue', chrome: true },
        { text: 'Afficher plus d’options', chrome: true },
        { text: 'Rechercher les offres', chrome: true },
        { text: 'Réinitialiser', chrome: true },
        { text: alertAction, chrome: true },
        apply,
        { text: 'Gestionnaire de consentements pour les cookies', chrome: true },
      ],
      links: [],
    };
    const context = {
      applyUrl,
      postingUrl,
      job: { company: 'Groupe E', title: 'Cheffe ou Chef d’équipe infrastructures' },
      allowSingleExternalApplicationEntry: true,
    };

    expect(applicationEntryControls(snapshot, context)).toEqual([apply]);
    expect(applicationEntryControls({
      ...snapshot,
      fields: [{ ...snapshot.fields[0], label: 'Quel est votre niveau de motivation pour ce poste ?' }],
    }, context)).toEqual([]);
  });

  it('rejects an alert-only script Apply on a non-Jobs2Web job route', () => {
    const postingUrl = 'https://careers.example.test/job/cheffe-chef-equipe-infrastructures/123456/';
    const snapshot = {
      url: postingUrl,
      fields: [{
        id: 'alert-frequency',
        kind: 'text',
        inputType: 'text',
        label: 'Select how often (in days) to receive an alert:',
        required: true,
        value: '7',
        formId: 'job-alert',
      }],
      buttons: [
        { text: 'Create a job alert', chrome: true },
        { text: 'Postuler »', frame: 0, disabled: false },
      ],
      links: [],
    };

    expect(applicationEntryControls(snapshot, {
      applyUrl: postingUrl,
      postingUrl,
      job: { company: 'Example', title: 'Cheffe ou Chef d’équipe infrastructures' },
      allowSingleExternalApplicationEntry: true,
    })).toEqual([]);
  });

  it('retains the Umantis posting route only when it binds the current application to the same vacancy', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
    const applyUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
    const otherVacancy = 'https://recruitingapp-2761.umantis.com/Vacancies/1154/Description/4';
    const publishedUrl = 'https://frontaliereticino.ch/it/lavoro/impiegato-amministrativo-eoc/';

    expect(verifiedUmantisPostingAddress({ applyUrl: postingUrl, postingUrls: [
      publishedUrl, postingUrl,
    ] })).toBe(postingUrl);
    expect(verifiedUmantisPostingAddress({ applyUrl: postingUrl, postingUrls: [otherVacancy] })).toBe('');
    expect(postingAddressForPortal({ applyUrl, postingUrls: [postingUrl], fallback: publishedUrl })).toBe(postingUrl);
    expect(postingAddressForPortal({ applyUrl, postingUrls: [otherVacancy], fallback: publishedUrl })).toBe('');
    expect(postingAddressForPortal({ applyUrl, postingUrls: null as any, fallback: publishedUrl })).toBe('');
    expect(postingAddressForPortal({ applyUrl: 'https://jobs.lever.co/example/1/apply', fallback: publishedUrl })).toBe(publishedUrl);
  });

  it('recovers the Umantis posting route for a legacy direct Application/New URL', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
    const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
    const job = { company: 'EOC – Ente Ospedaliero Cantonale', title: 'Impiegato/a amministrativo' };
    const form = [
      'Application Tracking System',
      'Attualmente ho un contratto con l\'EOC',
      'In passato ho già lavorato per l\'EOC',
      'Avanti',
    ].join('\n');

    expect(postingAddressForPortal({
      applyUrl: applicationUrl,
      postingUrls: [applicationUrl],
      fallback: 'https://frontaliereticino.ch/it/lavoro/impiegato-amministrativo-eoc/',
    })).toBe(postingUrl);
    expect(portalEntryUrl({ applyUrl: applicationUrl })).toBe(postingUrl);
    expect(isVerifiedPostingEntry({ applyUrl: applicationUrl, postingUrl })).toBe(true);
    expect(formPostingMatch(form, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: applicationUrl,
      postingUrl,
    })).toBe('match');
  });

  it('binds a direct Umantis form when submit liveness retained the published URL', () => {
    const applicationUrl = umantisAccountStepFixture.url;
    const publishedUrl = 'https://frontaliereticino.ch/it/lavoro/impiegato-amministrativo-eoc/';
    const conflictingPostingUrl = applicationUrl.replace('/Application/New/4', '/Description/4').replace('/2806/', '/2807/');
    const job = { company: 'EOC – Ente Ospedaliero Cantonale', title: 'Impiegato/a amministrativo' };
    const form = [
      'Application Tracking System',
      ...umantisAccountStepFixture.fields.map(field => field.label),
      'Avanti',
    ].join('\n');

    expect(formPostingMatch(form, job, {
      pageUrl: applicationUrl,
      postingUrl: publishedUrl,
    })).toBe('match');
    expect(formPostingMatch(form, job, {
      pageUrl: applicationUrl,
      postingUrl: conflictingPostingUrl,
    })).toBe('mismatch');
  });

  it('keeps an explicit cross-tenant Umantis vacancy authoritative', () => {
    const pageUrl = 'https://tenant-a.umantis.com/Vacancies/123/Application/New/1';
    const postingUrl = 'https://tenant-b.umantis.com/Vacancies/999/Description/1';
    const job = { title: 'EOC', company: 'EOC' };

    expect(formPostingMatch('Application', job, {
      pageUrl,
      postingUrl,
    })).toBe('mismatch');
  });

  it('uses a bound Umantis vacancy route when EOC application questions mention the employer', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
    const applyUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
    const job = { company: 'EOC – Ente Ospedaliero Cantonale', title: 'Impiegato/a amministrativo' };
    const form = [
      'Impiegato/a amministrativo - Candidatura | EOC candiDati',
      'Application Tracking System',
      'Selezionare collaboratori dell’EOC amici e conoscenti',
    ].join('\n');
    const verified = isVerifiedPostingEntry({ applyUrl, postingUrl });

    expect(verified).toBe(true);
    expect(namesAnotherEmployer(form, job)).toBe(true);
    expect(formPostingMatch(form, job, {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applyUrl,
      postingUrl,
    })).toBe('match');
    expect(formPostingMatch('Other Employer — Impiegato/a amministrativo', job, {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applyUrl,
      postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch(form, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: applyUrl,
      postingUrl: postingUrl.replace('/1153/', '/1154/'),
    })).toBe('mismatch');
  });

  it('treats Select one as a field label without neutralizing One in an employer name', () => {
    const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
    const applyUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
    const verified = isVerifiedPostingEntry({ applyUrl, postingUrl });
    const eocJob = { company: 'EOC', title: 'Impiegato/a amministrativo' };
    const bound = {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applyUrl,
      postingUrl,
    };

    expect(verified).toBe(true);
    expect(namesAnotherEmployer('EOC Select one', eocJob)).toBe(false);
    expect(formPostingMatch('EOC\nSelect one', eocJob, bound)).toBe('match');
    expect(formPostingMatch('EOC Select one', eocJob, bound)).toBe('match');
    expect(formPostingMatch('Coop One', { company: 'Coop One', title: 'Role' }, bound)).toBe('match');
    expect(formPostingMatch('Coop One', { company: 'Coop', title: 'Role' }, bound)).toBe('mismatch');
  });

  it('accepts a bound Umantis form with a generic heading and employer-owned fields', () => {
    const applicationUrl = umantisAccountStepFixture.url;
    const postingUrl = applicationUrl.replace('/Application/New/4', '/Description/4');
    const job = { company: 'EOC – Ente Ospedaliero Cantonale', title: 'Impiegato/a amministrativo' };
    const form = [
      'Application Tracking System',
      ...umantisAccountStepFixture.fields.map(field => field.label),
      'Avanti',
    ].join('\n');
    const verified = isVerifiedPostingEntry({ applyUrl: applicationUrl, postingUrl });

    expect(namesAnotherEmployer(form, job)).toBe(true);
    expect(formPostingMatch(form, job, {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applicationUrl,
      postingUrl,
    })).toBe('match');
    expect(formPostingMatch(`Other Employer — Application Tracking System\n${form}`, job, {
      postingMatched: verified,
      postingEntry: verified,
      pageUrl: applicationUrl,
      postingUrl,
    })).toBe('mismatch');
  });

  it('accepts ALTEN’s generic form only when the matching posting route was the entry', () => {
    const job = { company: 'ALTEN Switzerland', title: 'Project Manager – IT & Banking' };
    const genericForm = [
      'Apply',
      'Personal information',
      'First name',
      'Name',
      'E-mail',
      'Phone',
      'Birth date',
      'Address',
      'Upload your CV and your motivation letter*',
      'Degree',
      'Comment',
      'Send application',
      'https://www.alten.ch/jobs/903-pipe-project-manager-it/apply/',
    ].join('\n');

    expect(formPostingMatch(genericForm, job)).toBe('mismatch');
    expect(formPostingMatch(genericForm, job, { postingMatched: true })).toBe('mismatch');
    expect(formPostingMatch(genericForm, job, { postingMatched: true, postingEntry: true })).toBe('unknown');
    expect(formPostingMatch('Project Manager — Other Employer\nSend application', job, { postingMatched: true, postingEntry: true })).toBe('mismatch');
    expect(formPostingMatch('Grand Hotel — Other Resort', {
      title: 'Concierge',
      company: 'Grand Hotel',
    }, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: 'https://jobs.stadt-zuerich.ch/posting',
      postingUrl: 'https://jobs.stadt-zuerich.ch/posting',
    })).toBe('mismatch');
    expect(formPostingMatch('Grand Hotel — Other Resort', {
      title: 'Concierge',
      company: 'Grand Hotel',
    }, {
      pageUrl: 'https://jobs.stadt-zuerich.ch/posting',
      postingUrl: 'https://jobs.stadt-zuerich.ch/posting',
    })).toBe('mismatch');
  });

  it('keeps ALTEN posting provenance when the apply link has a trailing slash and query', () => {
    const postingUrl = 'https://www.alten.ch/jobs/903-pipe-project-manager-it/';
    const parsed = parseAltenDetailHtml(`
      <div class="wp-block-jobboard-offer">
        <h1>Project Manager - IT &amp; Banking</h1>
        <a href="/jobs/903-pipe-project-manager-it/apply/?locale=de">APPLY</a>
      </div>`, postingUrl);
    const applyUrl = parsed.applyUrl;
    const enteredFromMatchingPosting = isVerifiedPostingEntry({ applyUrl, postingUrl });
    const form = 'Application Tracking System\nProject Manager - IT & Banking\nPersonal information\nSend application';

    expect(applyUrl).toBe('https://www.alten.ch/jobs/903-pipe-project-manager-it/apply/?locale=de');
    expect(enteredFromMatchingPosting).toBe(true);
    expect(formPostingMatch(form, {
      company: 'ALTEN Switzerland', title: 'Project Manager - IT & Banking',
    }, { postingMatched: enteredFromMatchingPosting, postingEntry: enteredFromMatchingPosting, pageUrl: applyUrl })).toBe('match');
  });

  it('hands an unresolved initial anti-bot page to CAPTCHA, not posting mismatch', () => {
    expect(initialPortalHandoffReason({ snapshot: { captcha: true }, liveness: { code: 'bot_challenge' } })).toBe('captcha');
    expect(initialPortalHandoffReason({ snapshot: { captcha: false }, liveness: { code: 'bot_challenge' } })).toBe('captcha');
    expect(initialPortalHandoffReason({ snapshot: { captcha: false }, liveness: { code: 'no_apply_control' } })).toBeNull();
  });

  it('stops before filling a form that names neither the company nor the role', () => {
    const job = { company: 'Ospedale Regionale di Lugano SA', title: 'Infermiere/a diplomato/a' };
    expect(postingMatch('Ospedale Regionale di Lugano · Candidatura · Infermiera diplomata', job)).toBe('match');
    // Review of #10715: the WHOLE company name, as whole words; the title alone does not do.
    expect(postingMatch('Ospedale Regionale — Lavora con noi', job)).toBe('mismatch');
    expect(postingMatch('Candidatura · Infermiera diplomata · Reparto medicina', job)).toBe('mismatch');
    expect(postingMatch('Altra GmbH — Elektroinstallateur', { company: 'Muster Elektro AG', title: 'Elektroinstallateur EFZ' })).toBe('mismatch');
    // Second review: never the initials ("ME" is in "Tell me more"); a portal showing only "EOC" goes to Valerie.
    expect(postingMatch('Altra GmbH — Elektroinstallateur. Tell me more', { company: 'Muster Elektro AG', title: 'Elektroinstallateur EFZ' })).toBe('mismatch');
    expect(postingMatch('Lavora con noi https://eoc.wd3.myworkdayjobs.com/External', { company: 'Ente Ospedaliero Cantonale' })).toBe('mismatch');
    // No company in the order: every title word, a gender variant allowed.
    expect(postingMatch('Candidatura · Infermiera diplomata', { title: 'Infermiere/a diplomato/a' })).toBe('match');
    // The order names nothing to compare: no stop.
    expect(postingMatch('anything', {})).toBe('unknown');
  });

  it('reads "Coop Genossenschaft" as Coop: its SuccessFactors pages name only the tenant', () => {
    const job = { company: 'Coop Genossenschaft', title: 'Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)' };
    // Coop's sign-in page, 2026-10-02: the company is only in the address.
    expect(postingMatch('Karrierechancen: Anmelden https://career2.successfactors.eu/career?company=Coop&career_ns=job_application&career_job_req_id=170044', job)).toBe('match');
    expect(postingMatch('Karrierechancen: Anmelden https://career2.successfactors.eu/career?company=Migros&career_ns=job_application', job)).toBe('mismatch');
    expect(postingMatch('Coop Genossenschaft · Bäcker:in', job)).toBe('match');
  });

  // umantis for a hotel, 2026-10-03: the form names the role («Concierge - Application»), never the employer.
  it('reads the company on the posting and the role on the form its apply button opened', () => {
    const job = { company: 'Grand Hotel Esempio', title: 'Concierge (m/w/d)' };
    // As the runner composes it: the page's title, then its text, then its address.
    const form = 'Concierge - Application | Application Tracking System\nConcierge\nClick on Login if you have already set up your profile.\nhttps://recruitingapp-0000.umantis.com/Vacancies/717/Application/New/2';
    // The form alone: a stop, as before.
    expect(formPostingMatch(form, job)).toBe('mismatch');
    // Opened by the apply button of a posting that named the company: the role is enough.
    expect(formPostingMatch(form, job, { postingMatched: true })).toBe('match');
    // Never another role of the same employer, and never without a role to read.
    expect(formPostingMatch(form, { ...job, title: 'Chef de Rang' }, { postingMatched: true })).toBe('mismatch');
    expect(formPostingMatch(form, { company: job.company }, { postingMatched: true })).toBe('mismatch');
    // A form that names the company needs no posting; an order that names nothing is never stopped.
    expect(formPostingMatch(`Grand Hotel Esempio · ${form}`, job)).toBe('match');
    expect(formPostingMatch(`Concierge\nBewerbung bei Grand Hotel Esempio`, job, { postingMatched: true })).toBe('match');
    expect(formPostingMatch('anything', {}, { postingMatched: true })).toBe('unknown');
    // Review of #11033: a form that names another employer of the kind is a stop, whatever the posting said.
    expect(formPostingMatch('Concierge — Other Hotel', { company: 'Grand Hotel Esempio', title: 'Concierge' }, { postingMatched: true })).toBe('mismatch');
    expect(formPostingMatch('Concierge - Application | Esempio Resort', job, { postingMatched: true })).toBe('mismatch');
    // …while one that is silent about the employer goes on with the role alone.
    expect(formPostingMatch('Concierge — Application Tracking System', { company: 'Grand Hotel Esempio', title: 'Concierge' }, { postingMatched: true })).toBe('match');
  });

  it('recognizes the EOC formal Italian application link on a Umantis description page', () => {
    expect(startsApplication('Invii la sua candidatura')).toBe(true);
  });

  // Reviews of #11033 on the employer a form names. Their acceptances as written, for
  // company "Grand Hotel Esempio", title "Concierge", postingMatched true.
  it('takes for another employer only the word next to a word of the order’s company, whatever the case or the separator', () => {
    const job = { company: 'Grand Hotel Esempio', title: 'Concierge' };
    const viaPosting = (formText: string, order: Record<string, string> = job) => formPostingMatch(formText, order, { postingMatched: true });
    // First review: a form that names another employer with the same role is a stop.
    expect(viaPosting('Concierge — Other Hotel')).toBe('mismatch');
    // Second: a shared word proves nothing by itself.
    expect(viaPosting('Concierge — Hotel application')).toBe('match');
    // Third: neither a generic heading nor a company named elsewhere on the page (the ATS's own footer).
    expect(viaPosting('Concierge — Hotel Application Process\nPowered by Palace Resort AG')).toBe('match');
    // Third: the other employer in lower case, or joined by a hyphen, is still another employer.
    expect(viaPosting('Concierge — other hotel')).toBe('mismatch');
    expect(viaPosting('Concierge — Other-Hotel')).toBe('mismatch');

    // Fourth: an employer in the page's title with no word in common with the order's company.
    expect(viaPosting('Concierge — Other Resort')).toBe('mismatch');
    expect(viaPosting('Concierge — Palace Resort AG')).toBe('mismatch');

    // 1. The title (the first line) holds the role, the company's own words and the page's vocabulary, or it is a stop.
    expect(viaPosting('Concierge - Application | Application Tracking System\nConcierge\nPowered by Palace Resort AG')).toBe('match');
    expect(viaPosting('Hotel Concierge · Bewerbung im Hotel Bereich · Hotel Jobs')).toBe('match');
    expect(viaPosting('Concierge (m/w/d) 80-100% | Karriereportal')).toBe('match');
    expect(namesAnotherEmployer('Grand Hotel · Concierge', job)).toBe(false);
    expect(namesAnotherEmployer('Concierge — Hotel application', job)).toBe(false);
    expect(namesAnotherEmployer('CONCIERGE | HOTEL SPLENDIDE', job)).toBe(true);
    expect(namesAnotherEmployer('Concierge at the Hotel Splendide', job)).toBe(true);
    // Review of #11064: the kind of employer is the page's vocabulary too, whatever the order's company is called.
    const palace = { title: 'Concierge', company: 'Palace Resort AG' };
    // An account page's own words name no employer either: Workday keeps «Create Account» as the title of
    // every step of the form behind it (2026-10-07).
    for (const title of ['Create Account', 'Sign In', 'Konto erstellen', 'Anmelden', 'Créer un compte', 'Crea account', 'Weiter', 'Continue', 'Avanti', 'Suivant', 'Save and continue']) {
      expect(namesAnotherEmployer(`${title}\nConcierge\nMy Information`, palace)).toBe(false);
    }
    expect(namesAnotherEmployer('Weiter — Other Resort\nConcierge', palace)).toBe(true);
    expect(namesAnotherEmployer('Create Account — Other Resort\nConcierge', palace)).toBe(true);
    expect(formPostingMatch('Concierge — Hotel application', palace, { postingMatched: true })).toBe('match');
    expect(formPostingMatch('Concierge — Hotel Splendide', palace, { postingMatched: true })).toBe('mismatch');
    expect(formPostingMatch('Concierge — Other Hotel', palace, { postingMatched: true })).toBe('mismatch');
    expect(formPostingMatch('Infermiera — Hospital application', { title: 'Infermiera', company: 'Clinica Esempio' }, { postingMatched: true })).toBe('match');
    // …but next to a word of the order's company it is a name: «Esempio Resort» is not «Grand Hotel Esempio».
    expect(formPostingMatch('Concierge — Esempio Resort', job, { postingMatched: true })).toBe('mismatch');
    // A place in the title is a stop too (Valerie's retry goes on): never a guess about what the word is.
    expect(viaPosting('Concierge | Pontresina')).toBe('mismatch');
    // 2. Below the title, only the word next to a word of the order's company counts.
    expect(viaPosting('Concierge — Other Hotel', { ...job, company: 'Grand Hotel Esempio AG' })).toBe('mismatch');
    expect(viaPosting('Concierge\nWelcome to the Other Hotel careers page')).toBe('mismatch');
    expect(viaPosting('Concierge - Application\nhttps://jobs.other-hotel.example/apply')).toBe('mismatch');
    expect(viaPosting('Concierge\nBewerbung als Concierge (m/w/d) im Grand Resort')).toBe('mismatch');
    expect(viaPosting('Concierge\nDeine Bewerbung im Hotel Bereich. Splendide Aussichten\nhttps://careers.recruiting-0000.example/apply')).toBe('match');
    expect(viaPosting('Concierge\nFirst name\nLast name\nPalace Resort AG — all rights reserved')).toBe('match');
    expect(namesAnotherEmployer('anything', {})).toBe(false);

    // Without a posting that named the company there is no fallback at all.
    expect(formPostingMatch('Concierge — Application Tracking System', job)).toBe('mismatch');
    expect(formPostingMatch('Concierge — Application Tracking System', job, { postingMatched: false })).toBe('mismatch');
    const umantisPage = 'https://recruitingapp-0000.umantis.com/Vacancies/717/Application/New/2';
    const umantisPosting = 'https://recruitingapp-0000.umantis.com/Vacancies/717/Description/1';
    expect(formPostingMatch('Weiter', job, {
      pageUrl: umantisPage,
      postingUrl: umantisPosting,
      postingMatched: true,
      postingEntry: true,
    })).toBe('match');
    expect(formPostingMatch('Weiter — Other Hotel', job, {
      pageUrl: umantisPage,
      postingUrl: umantisPosting,
      postingMatched: true,
      postingEntry: true,
    })).toBe('mismatch');
    // The whole name on the form is the direct match, as ever.
    expect(viaPosting('Concierge — Grand Hotel Esempio')).toBe('match');
    expect(viaPosting('Concierge — Grand Hotel Esempio AG', { ...job, company: 'Grand Hotel Esempio AG' })).toBe('match');
  });

  it('keeps birth-date fields neutral and stops role evidence at the form surface', () => {
    const job = { company: 'Acme', title: 'Nurse' };
    for (const label of ['Date de naissance', 'Date of birth', 'Data di nascita', 'Geburtsdatum']) {
      expect(namesAnotherEmployer(label, job)).toBe(false);
    }
    expect(formPostingMatch('Application Tracking System\nFirst name:\nNurse', job, { postingMatched: true })).toBe('unknown');
  });

  it('takes an ATS careers section in the page title for no employer', () => {
    // SuccessFactors titles every page with its section («Opportunités de carrière : Créer un compte», read on a
    // real tenant on 2026-10-03; «Karrierechancen: Anmelden» on another): the section names nobody, and its
    // pages show the employer only as a logo. The role after the section is read as ever.
    const order = { title: "Apprentissage d'opérateur·trice en informatique CFC", company: 'Manifattura Esempio' };
    const viaPosting = (formText: string) => formPostingMatch(formText, order, { postingMatched: true });
    expect(viaPosting("Opportunités de carrière : Apprentissage d'opérateur∙trice en informatique CFC (1429968733)\nPrénom\nNom\nhttps://career5.example/career?company=manifatturasa")).toBe('match');
    expect(viaPosting('Karrierechancen: Apprentissage d’opérateur∙trice en informatique CFC')).toBe('match');
    expect(viaPosting('Career Opportunities: Apprentissage d’opérateur∙trice en informatique CFC')).toBe('match');
    expect(viaPosting('Opportunità di carriera: Apprentissage d’opérateur∙trice en informatique CFC')).toBe('match');
    // Another employer after the section is still another employer, another role still another role.
    expect(viaPosting("Opportunités de carrière : Apprentissage d'opérateur∙trice en informatique CFC — Autre Maison")).toBe('mismatch');
    expect(viaPosting('Opportunités de carrière : Horloger∙ère CFC')).toBe('mismatch');
    // And without a posting that named the company, the section is no match by itself.
    expect(formPostingMatch("Opportunités de carrière : Apprentissage d'opérateur∙trice en informatique CFC", order)).toBe('mismatch');
  });

  it('closes a cookie manager whose buttons name the cookies', () => {
    // SuccessFactors' own manager (2026-10-03): left open over the sign-in page, it took the click on «create account».
    for (const text of ['Refuser tous les cookies', 'Alle Cookies ablehnen', 'Reject All Cookies', 'Rifiuta tutti i cookie', 'Decline all cookies', 'Refuser', 'Tout refuser', 'Alle ablehnen', 'Rifiuta tutti']) {
      expect(COOKIE_REJECT_RE.test(text), text).toBe(true);
    }
    for (const text of ['Accepter tous les cookies', 'Alle Cookies akzeptieren', 'Accept All Cookies', 'Accetta tutti i cookie', 'Tout accepter', 'Alle akzeptieren']) {
      expect(COOKIE_ACCEPT_RE.test(text), text).toBe(true);
      expect(COOKIE_REJECT_RE.test(text), text).toBe(false);
    }
    // Neither the settings button nor an unrelated refusal is the banner's way out.
    for (const text of ['Modifier les préférences des cookies', 'Cookie-Einstellungen ändern', 'Modify Cookie Preferences', 'Refuser la candidature', 'Accepter l’offre']) {
      expect(COOKIE_REJECT_RE.test(text), text).toBe(false);
      expect(COOKIE_ACCEPT_RE.test(text), text).toBe(false);
    }
  });

  it('knows a page whose button sends an application, whatever else it asks', () => {
    // Third review of #11033: a password and «Submit final application», the CV field still in a closed section.
    const closed = { passwordVisible: true, fields: [{ id: 'f1', kind: 'text', inputType: 'password', label: 'Password', form: 0 }], buttons: [{ text: 'Expand all sections' }, { text: 'Submit final application' }] };
    expect(sendsApplication(closed)).toBe(true);
    expect(ownAccountForm(closed)).toBe(false);
    // Once the section is open the CV is sent with the password: the form, not a login page.
    expect(ownAccountForm({ ...closed, fields: [...closed.fields, { id: 'f2', kind: 'file', inputType: 'file', label: 'Resume', form: 0 }] })).toBe(true);
    // A login page sends no application.
    expect(sendsApplication({ buttons: [{ text: 'Anmelden' }, { text: 'Konto erstellen' }] })).toBe(false);
    expect(sendsApplication({ buttons: [{ text: 'Submit' }] })).toBe(false);
    expect(sendsApplication({})).toBe(false);
  });

  it('takes a form with its own password field for the form only when its button sends an application', () => {
    const fields = [{ id: 'f1', kind: 'text', inputType: 'password', label: 'Password', form: 0 }, { id: 'f2', kind: 'file', inputType: 'file', label: 'Resume', form: 0 }];
    const page = (text: string, extra: Record<string, unknown> = {}) => ({ passwordVisible: true, fields, buttons: [{ text: 'Login for recruiters' }, { text }], ...extra });
    expect(ownAccountForm(page('Submit final application'))).toBe(true);
    expect(ownAccountForm(page('Bewerbung absenden'))).toBe(true);
    expect(ownAccountForm(page('Invia candidatura'))).toBe(true);
    // A registration that also takes a CV: its button creates an account, the login pages handle it.
    expect(ownAccountForm(page('Konto erstellen'))).toBe(false);
    expect(ownAccountForm(page('Submit'))).toBe(false);
    // No password on the page, or no CV sent with it.
    expect(ownAccountForm(page('Submit final application', { passwordVisible: false }))).toBe(false);
    expect(ownAccountForm(page('Submit final application', { fields: [fields[0]] }))).toBe(false);
    expect(ownAccountForm(page('Submit final application', { fields: [fields[0], { ...fields[1], form: 1 }] }))).toBe(false);
  });

  it('recognizes Umantis profile creation when submitting the application creates the account', () => {
    const snapshot = {
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Application/New/4',
      text: 'Inviando la candidatura viene creato un profilo utente.',
      passwordVisible: true,
      fields: [
        { id: 'email', kind: 'text', inputType: 'email', form: 0, label: 'Indirizzo e-mail/login*' },
        { id: 'password', kind: 'text', inputType: 'password', form: 1, label: 'Password*' },
        { id: 'cv', kind: 'file', inputType: 'file', form: 2, label: 'Curriculum*' },
      ],
      buttons: [{ text: 'Invia candidatura definitiva' }],
    };

    expect(sendsApplication(snapshot)).toBe(true);
    expect(ownAccountForm(snapshot, 'umantis')).toBe(true);
    expect(ownAccountForm({ ...snapshot, text: 'Inviando la candidatura,\nviene creato un profilo utente.' }, 'umantis')).toBe(true);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('recruitingapp-2761.umantis.com', 'careers.example.org') }, 'umantis')).toBe(false);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('https:', 'http:') }, 'umantis')).toBe(false);
    expect(ownAccountForm({ ...snapshot, text: '' }, 'umantis')).toBe(false);
  });

  it('recognizes the observed Umantis account/application first step without treating it as login', () => {
    const snapshot = umantisAccountStepFixture;

    expect(authPageKind(snapshot)).toBe('sign_in');
    expect(sendsApplication(snapshot)).toBe(false);
    expect(ownAccountForm(snapshot, 'umantis')).toBe(true);
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.map(field => field.id === 'cover-letter'
        ? { ...field, id: 'upload-1', name: 'attachment', label: 'Document', context: 'Cover letter' }
        : field),
    }, 'umantis')).toBe(true);
    expect(ownAccountForm(snapshot)).toBe(false);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('/Application/New/4', '/Login') }, 'umantis')).toBe(false);
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.map(field => field.id === 'password' ? { ...field, label: 'Login password' } : field),
    }, 'umantis')).toBe(false);
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.filter(field => !['cover-letter', 'other-documents'].includes(field.id)),
    }, 'umantis')).toBe(false);
  });

  // Bank Cler, 8BhQom09 run 42990198426 (2026-11-11): the order's channel is the employer's career site, whose
  // Apply opens the bank's Umantis tenant; its Application/New form asks for the login e-mail and a new password
  // with the application, has technical field names (form_dataNN) and asks for «Zeugnisse/Diplome», not a cover
  // letter. The runner took it for a sign-in page and stopped with portal:account (no_create_button).
  // Rebuilt from the form's captions: no candidate data.
  it('recognizes an Umantis account/application step reached from the employer site, with certificates instead of a letter', () => {
    const field = (id: string, kind: string, label: string, extra: Record<string, unknown> = {}) => ({
      id, kind, inputType: kind === 'textarea' ? 'textarea' : kind, name: `form_data${id}`, label, form: 0,
      context: 'Ruolo di esempio (f/m) - Bewerbung', ...extra,
    });
    const snapshot = {
      url: 'https://recruitingapp-1234.umantis.com/Vacancies/567/Application/New/1',
      text: 'Ruolo di esempio (f/m) - Bewerbung\nLogin\nKlicke auf Login, wenn du dein Profil bereits früher online hinterlegt hast.',
      passwordVisible: true,
      fields: [
        field('6', 'file', 'Foto'),
        field('8', 'text', 'Vorname', { required: true }),
        field('9', 'text', 'Nachname', { required: true }),
        field('10', 'text', 'Geburtsdatum'),
        field('12', 'text', 'E-Mail-Adresse/Login', { required: true }),
        field('15', 'text', 'Passwort', { inputType: 'password', autocomplete: 'off', required: true }),
        field('18', 'text', 'Strasse', { required: true }),
        field('19', 'text', 'Hausnummer', { required: true }),
        field('20', 'text', 'PLZ', { required: true }),
        field('21', 'text', 'Ort', { required: true }),
        field('22', 'select', 'Land', { required: true }),
        field('23', 'text', 'Mobiltelefon', { required: true }),
        field('28', 'file', 'Lebenslauf', { required: true }),
        field('29', 'file', 'Zeugnisse/Diplome', { required: true }),
        field('30', 'file', 'Weitere Unterlagen'),
        field('38', 'textarea', 'Anmerkungen zur Bewerbung'),
      ],
      buttons: [{ text: 'Weiter' }],
      links: [{ text: 'Login' }],
    };

    expect(authPageKind(snapshot)).toBe('sign_in');
    expect(sendsApplication(snapshot)).toBe(false);
    expect(ownAccountForm(snapshot, 'employer_site')).toBe(true);
    expect(ownAccountForm(snapshot, 'umantis')).toBe(true);
    // Another channel, or none, keeps its own rules.
    expect(ownAccountForm(snapshot)).toBe(false);
    expect(ownAccountForm(snapshot, 'successfactors')).toBe(false);
    // Only the Umantis application route, over https.
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('recruitingapp-1234.umantis.com', 'careers.example.org') }, 'employer_site')).toBe(false);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('/Application/New/1', '/Login') }, 'employer_site')).toBe(false);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('https:', 'http:') }, 'employer_site')).toBe(false);
    // A sign-in password is never a new account's.
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.map(item => item.label === 'Passwort' ? { ...item, label: 'Aktuelles Passwort' } : item),
    }, 'employer_site')).toBe(false);
    // The applicant's details are read from the caption, not hidden by the technical name beside it.
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.filter(item => !['Geburtsdatum', 'PLZ'].includes(item.label)),
    }, 'employer_site')).toBe(false);
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.filter(item => item.label !== 'Geburtsdatum'),
    }, 'employer_site')).toBe(true);
  });

  it('recognizes the live EOC Umantis profile step without street or country fields', () => {
    const snapshot = {
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4',
      text: 'Impiegato/a amministrativo - Candidatura | EOC candiDati',
      passwordVisible: true,
      fields: [
        { id: 'email', kind: 'text', inputType: 'email', label: 'Indirizzo e-mail/login', form: 0 },
        { id: 'first-name', kind: 'text', inputType: 'text', label: 'Nome', form: 0 },
        { id: 'last-name', kind: 'text', inputType: 'text', label: 'Cognome', form: 0 },
        { id: 'birth-date', kind: 'text', inputType: 'text', label: 'Data di nascita', form: 0 },
        { id: 'password', kind: 'text', inputType: 'password', label: 'Password', form: 0 },
        { id: 'postal-code', kind: 'text', inputType: 'text', label: 'NAP', form: 0 },
        { id: 'city', kind: 'text', inputType: 'text', label: 'Località', form: 0 },
        { id: 'phone', kind: 'text', inputType: 'tel', label: 'Telefono', form: 0 },
        { id: 'cv', kind: 'file', inputType: 'file', label: 'Curriculum', form: 0 },
        { id: 'cover-letter', kind: 'file', inputType: 'file', label: 'Lettera di presentazione', form: 0 },
      ],
      buttons: [{ text: 'Avanti' }],
      links: [{ text: 'Login' }],
    };

    expect(authPageKind(snapshot)).toBe('sign_in');
    expect(ownAccountForm(snapshot, 'umantis')).toBe(true);
    expect(ownAccountForm({
      ...snapshot,
      fields: snapshot.fields.filter(field => !['birth-date', 'postal-code', 'city', 'phone'].includes(field.id)),
    }, 'umantis')).toBe(false);
    expect(ownAccountForm({ ...snapshot, buttons: [{ text: 'Login' }] }, 'umantis')).toBe(false);
    expect(ownAccountForm({ ...snapshot, url: snapshot.url.replace('/Application/New/4', '/Application/Login/4') }, 'umantis')).toBe(false);
  });

  it('recognizes a Umantis Application/New account step from an employer-site channel with certificates', () => {
    const text = (id: string, label: string, required = false) => ({ id, kind: 'text', inputType: 'text', label, required });
    const file = (id: string, label: string, required = false) => ({ id, kind: 'file', inputType: 'file', label, required });
    const snapshot = {
      url: 'https://recruitingapp-2839.umantis.com/Vacancies/2839/Application/New/1',
      text: '',
      passwordVisible: true,
      fields: [
        file('photo', 'Foto'),
        text('first-name', 'Vorname', true),
        text('last-name', 'Nachname', true),
        text('birth-date', 'Geburtsdatum'),
        text('email-login', 'E-Mail-Adresse/Login', true),
        { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort', required: true },
        text('street', 'Strasse', true),
        text('house-number', 'Hausnummer', true),
        text('postal-code', 'PLZ', true),
        text('city', 'Ort', true),
        { id: 'country', kind: 'select', inputType: 'select', label: 'Land', required: true },
        text('mobile', 'Mobiltelefon', true),
        file('cv', 'Lebenslauf', true),
        file('certificates', 'Zeugnisse/Diplome', true),
        file('other-documents', 'Weitere Unterlagen'),
        file('form-data-31', 'form_data31'),
        file('form-data-32', 'form_data32'),
        text('notes', 'Anmerkungen zur Bewerbung'),
        text('current-employer-other', 'Aktueller Arbeitgeber (andere)'),
        { id: 'referral', kind: 'select', inputType: 'select', label: 'Wie bist du auf uns aufmerksam geworden?', required: true },
        { id: 'privacy', kind: 'checkbox', inputType: 'checkbox', label: 'Ich habe die Datenschutzerklärung zur Kenntnis genommen.', required: true },
        { id: 'salutation', kind: 'radio', inputType: 'radio', label: 'Frau' },
        { id: 'language', kind: 'radio', inputType: 'radio', label: 'Deutsch' },
        { id: 'retention', kind: 'radio', inputType: 'radio', label: 'Ich bin damit einverstanden, dass meine Daten über diese Bewerbung hinaus gespeichert werden' },
      ],
      buttons: [{ id: 'next', text: 'Weiter', disabled: false }],
    };

    expect(authPageKind(snapshot)).toBe('sign_in');
    expect(ownAccountForm(snapshot, 'employer_site')).toBe(true);
    const certificateWithPermitContext = {
      ...snapshot,
      fields: snapshot.fields
        .filter(field => !['other-documents', 'form-data-31', 'form-data-32'].includes(field.id))
        .map(field => field.id === 'certificates' ? { ...field, context: 'Work permit documents' } : field),
    };
    expect(ownAccountForm(certificateWithPermitContext, 'employer_site')).toBe(true);

    expect(isNonCvDocumentLabel('Personalausweis')).toBe(true);
    const identityOnly = {
      ...snapshot,
      fields: snapshot.fields
        .filter(field => !['certificates', 'other-documents', 'form-data-31', 'form-data-32'].includes(field.id))
        .map(field => field.id === 'photo' ? { ...field, label: 'Personalausweis', id: 'identity-document' } : field),
    };
    expect(ownAccountForm(identityOnly, 'employer_site')).toBe(false);
  });

  it('recognizes the mixed SuccessFactors account/application page before its CV dialog opens', () => {
    const successFactors = {
      url: 'https://career5.successfactors.eu/careers',
      passwordVisible: true,
      fields: [
        { id: 'email', kind: 'text', inputType: 'email', form: 0, label: 'Email Address: *' },
        { id: 'password', kind: 'text', inputType: 'password', form: 0, label: 'Choose Password: *' },
        { id: 'password-repeat', kind: 'text', inputType: 'password', form: 0, label: 'Retype Password: *' },
        { id: 'permit', kind: 'combobox', form: 0, label: 'Do you hold a valid work permit for Switzerland?', required: true },
        { id: 'salary', kind: 'textarea', form: 0, label: 'What is your salary expectation?', required: true },
        { id: 'start', kind: 'textarea', form: 0, label: 'When would be your next possible starting date?', required: true },
      ],
      buttons: [{ id: 'cv-upload', text: '\uE1EF', disabled: false }, { id: 'apply', text: 'Apply', disabled: false }],
    };
    expect(sendsApplication(successFactors)).toBe(true);
    expect(ownAccountForm(successFactors)).toBe(true);

    // A separate cover-letter input must not count as the CV already being
    // present: the CV can still be behind the SuccessFactors upload dialog.
    expect(ownAccountForm({
      ...successFactors,
      fields: [...successFactors.fields, {
        id: 'cover-letter',
        kind: 'file',
        inputType: 'file',
        form: 1,
        label: 'Cover letter',
      }],
    })).toBe(true);
  });

  it('recognizes a mixed form whose only application document field is a cover letter', () => {
    const snapshot = {
      url: 'https://career5.successfactors.eu/careers',
      passwordVisible: true,
      fields: [
        { id: 'password', kind: 'text', inputType: 'password', form: 0, label: 'Choose Password: *' },
        { id: 'cover-letter', kind: 'file', inputType: 'file', form: 1, label: 'Cover letter' },
      ],
      buttons: [{ id: 'apply', text: 'Submit final application', disabled: false }],
    };

    expect(ownAccountForm(snapshot)).toBe(true);
  });

  it('does not treat another portal with generic CV application labels as a SuccessFactors account form', () => {
    const snapshot = {
      url: 'https://apply.example.org/careers',
      passwordVisible: true,
      fields: [{ label: 'CV' }],
      buttons: [{ text: 'Submit application' }],
    };

    expect(ownAccountForm(snapshot)).toBe(false);
  });

  it('does not treat a lookalike SuccessFactors hostname as a SuccessFactors account form', () => {
    const snapshot = {
      url: 'https://successfactors.attacker.example/careers',
      passwordVisible: true,
      fields: [{ label: 'CV' }],
      buttons: [{ text: 'Submit application' }],
    };

    expect(ownAccountForm(snapshot)).toBe(false);
  });

  it('finds SuccessFactors privacy review without selecting the optional job alert', () => {
    const controls = privacyConsentControls({
      buttons: [
        { id: 'outside-accept', text: 'Accept', disabled: false, dialog: true, dialogId: 'other-modal', frame: 0 },
        { id: 'privacy', text: 'Datenschutzerklärung lesen und akzeptieren.', disabled: false, dialog: false },
        { id: 'accept', text: 'Akzeptieren', disabled: true, dialog: true, dialogId: 'dpcs-modal', frame: 0 },
      ],
      fields: [
        { id: 'abo', kind: 'checkbox', name: 'abo', label: 'Job-Abo', checked: false, dialog: false },
        {
          id: 'outside-review',
          kind: 'checkbox',
          name: 'otherPrivacyReview',
          label: 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
          checked: true,
          dialog: true,
          dialogId: 'other-modal',
          frame: 0,
        },
        {
          id: 'review',
          kind: 'checkbox',
          name: 'dpcsReview',
          label: 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
          checked: false,
          dialog: true,
          dialogId: 'dpcs-modal',
          frame: 0,
        },
      ],
    });
    expect(controls.trigger).toMatchObject({ id: 'privacy' });
    expect(controls.review).toMatchObject({ id: 'review', checked: false });
    expect(controls.review?.id).not.toBe('abo');
    expect(controls.review?.id).not.toBe('outside-review');
    expect(controls.accept).toMatchObject({ id: 'accept', disabled: true });
    expect(controls.accept?.id).not.toBe('outside-accept');
  });

  it('binds the career74 registration CTA to its privacy trigger', () => {
    const snapshot = {
      url: 'https://career74.sapsf.eu/career',
      fields: [
        { id: 'email', kind: 'text', label: 'E-Mail-Adresse: *', form: 0 },
        { id: 'email-repeat', kind: 'text', label: 'E-Mail-Adresse wiederholen: *', form: 0 },
        { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort *', form: 0 },
        { id: 'password-repeat', kind: 'text', inputType: 'password', label: 'Passwort wiederholen: *', form: 0 },
        { id: 'first-name', kind: 'text', label: 'Vorname: *', form: 0 },
        { id: 'last-name', kind: 'text', label: 'Nachname: *', form: 0 },
        { id: 'country', kind: 'select', label: 'Land des Wohnorts:*', form: 0 },
      ],
      buttons: [
        { id: 'privacy', text: 'Lesen und akzeptieren Sie die Datenschutzerklärung', form: 0, disabled: false },
        { id: 'create', text: 'Bewerbungskonto erstellen', form: 0, disabled: true },
      ],
    };

    expect(CREATE_ACCOUNT_RE.test(snapshot.buttons[1].text)).toBe(true);
    expect(isExplicitSignInNavigationLabel('Anmelden / Bewerbungskonto erstellen')).toBe(false);
    expect(privacyConsentControls(snapshot).trigger).toMatchObject({ id: 'privacy', form: 0 });
  });

  it('prefers the newly opened DPCS dialog when an earlier modal has a matching review', () => {
    const controls = privacyConsentControls({
      buttons: [
        { id: 'outside-accept', text: 'Accept', disabled: false, dialog: true, dialogId: 'other-modal', frame: 0 },
        { id: 'dpcs-accept', text: 'Akzeptieren', disabled: true, dialog: true, dialogId: 'dpcs-modal', frame: 0 },
      ],
      fields: [
        {
          id: 'outside-review',
          kind: 'checkbox',
          name: 'otherReview',
          label: 'I have reviewed this privacy notice.',
          checked: false,
          dialog: true,
          dialogId: 'other-modal',
          frame: 0,
        },
        {
          id: 'dpcs-review',
          kind: 'checkbox',
          name: 'dpcsReview',
          label: 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
          checked: false,
          dialog: true,
          dialogId: 'dpcs-modal',
          frame: 0,
        },
      ],
    });
    expect(controls.review).toMatchObject({ id: 'dpcs-review' });
    expect(controls.accept).toMatchObject({ id: 'dpcs-accept', disabled: true });
    expect(controls.review?.id).not.toBe('outside-review');
    expect(controls.accept?.id).not.toBe('outside-accept');
  });

  it('prefers the newest DPCS dialog when matching modal accepts are both disabled', () => {
    const controls = privacyConsentControls({
      buttons: [
        { id: 'old-accept', text: 'Accept', disabled: true, dialog: true, dialogId: 'old-modal', frame: 0 },
        { id: 'dpcs-accept', text: 'Akzeptieren', disabled: true, dialog: true, dialogId: 'dpcs-modal', frame: 0 },
      ],
      fields: [
        {
          id: 'old-review',
          kind: 'checkbox',
          name: 'oldPrivacyReview',
          label: 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
          checked: false,
          dialog: true,
          dialogId: 'old-modal',
          frame: 0,
        },
        {
          id: 'dpcs-review',
          kind: 'checkbox',
          name: 'dpcsReview',
          label: 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
          checked: false,
          dialog: true,
          dialogId: 'dpcs-modal',
          frame: 0,
        },
      ],
    });
    expect(controls.review).toMatchObject({ id: 'dpcs-review' });
    expect(controls.accept).toMatchObject({ id: 'dpcs-accept', disabled: true });
  });

  it('never treats an address alone as a receipt, including a profile confirmation', () => {
    const sendButton = { buttons: [{ text: 'Submit application', disabled: false }] };
    expect(urlConfirms('https://jobs.example/apply/review-and-confirm', { buttons: [] })).toBe(false);
    expect(urlConfirms('https://jobs.example/apply/thank-you', sendButton)).toBe(false);
    expect(urlConfirms('https://jobs.example/apply/thank-you', { buttons: [{ text: 'Back to jobs' }] })).toBe(false);
    expect(urlConfirms('https://jobs.example/apply/confirmation?jobId=42', { text: 'Thank you for your application.', buttons: [] }, { applyUrl: 'https://jobs.example/apply?jobId=42' })).toBe(true);
    expect(urlConfirms('https://jobs.example/apply/step-3', { buttons: [] })).toBe(false);
  });

  it('shortens a long answer at a sentence end, never in the middle of one', () => {
    const text = 'Lavoro da otto anni in reparto. Coordino un team di sei persone e seguo la formazione dei nuovi colleghi.';
    expect(fitToLength(text, 200)).toBe(text);
    expect(fitToLength(text, 60)).toBe('Lavoro da otto anni in reparto.');
    // No sentence end in the second half of the limit: a word end, no dangling comma.
    expect(fitToLength('Coordino un team di sei persone, seguo la formazione', 34)).toBe('Coordino un team di sei persone');
  });

  it('keeps the native browser identity while setting the requested form locale', () => {
    const options = portalContextOptions({ language: 'fr' });
    expect(options).toEqual({
      locale: 'fr-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    });
    expect(options).not.toHaveProperty('userAgent');
  });

  it('answers a knock-out question only with a quote of the candidate data', () => {
    const fields = [
      { id: 'f1', kind: 'select', label: 'Deutschkenntnisse (Niveau)*', required: true, options: [{ label: 'B1' }, { label: 'B2' }, { label: 'C1' }] },
      { id: 'f2', kind: 'checkbox', label: 'Ich besitze einen Führerschein Kat. B', required: false },
    ];
    const candidate = { answers: {}, profile: { languages: ['Tedesco B2'] }, portalQuestionsAnswered: [] };
    // "C1" to meet the requirement, "B2" in the CV: the candidate says.
    const invented = guardPlan({ actions: [{ fieldId: 'f1', action: 'select', value: 'C1', source: 'rule', evidence: '' }], missingRequired: [] }, fields, candidate);
    expect(invented.actions).toEqual([]);
    expect(invented.missingRequired.map((item: any) => item.fieldId)).toEqual(['f1']);
    // A quote that is really in the data supports the answer; a made-up quote does not.
    const quoted = guardPlan({ actions: [{ fieldId: 'f1', action: 'select', value: 'B2', source: 'profile', evidence: 'Tedesco B2' }], missingRequired: [] }, fields, candidate);
    expect(quoted.actions).toHaveLength(1);
    const fake = guardPlan({ actions: [{ fieldId: 'f2', action: 'check', value: '', source: 'rule', evidence: 'Patente B' }], missingRequired: [] }, [fields[1]], candidate);
    expect(fake).toEqual({ actions: [], missingRequired: [] }); // optional: left unticked, not asked
    expect(Object.keys(PLAN_SCHEMA.properties.actions.items.properties)).toContain('evidence');
  });

  it('applies the same knock-out rule to the agent', () => {
    const candidate = { answers: {}, profile: { languages: ['Tedesco B2'] }, portalQuestionsAnswered: [] };
    const turn = (evidence: string, answer: string) => ({ status: 'ACT', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Livello di tedesco', answer, source: 'profile', evidence }] });
    expect(guardAgentStep(turn('', 'C1'), candidate)).toMatchObject({ status: 'NEEDS_CANDIDATE', actions: [] });
    expect(guardAgentStep(turn('Tedesco B2', 'B2'), candidate).actions).toHaveLength(1);
  });

  // Review of #10715: the quote must SUPPORT the answer, not just be in the data.
  it('never takes a "yes" to a higher level from a quote of a lower one', () => {
    const candidate = { answers: {}, profile: { languages: ['Deutsch B2'] }, portalQuestionsAnswered: [] };
    const field = { id: 'k1', kind: 'select', label: 'Deutsch C1?', required: true, options: [{ label: 'Ja' }, { label: 'Nein' }] };
    const plan = guardPlan({ actions: [{ fieldId: 'k1', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2' }], missingRequired: [] }, [field], candidate);
    expect(plan.actions).toEqual([]);
    expect(plan.missingRequired.map((item: any) => item.fieldId)).toEqual(['k1']);
    const agent = guardAgentStep({ status: 'ACT', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Deutsch C1?', answer: 'Ja', source: 'profile', evidence: 'Deutsch B2' }] }, candidate);
    expect(agent).toMatchObject({ status: 'NEEDS_CANDIDATE', actions: [] });
    // Second review: levels are read where the quote names the language asked.
    const mixed = { answers: {}, profile: { languages: ['Deutsch B2; Englisch C2'] }, portalQuestionsAnswered: [] };
    expect(guardPlan({ actions: [{ fieldId: 'k1', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2; Englisch C2' }], missingRequired: [] }, [field], mixed).actions).toEqual([]);
    expect(guardAgentStep({ status: 'ACT', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Deutsch C1?', answer: 'Ja', source: 'profile', evidence: 'Deutsch B2; Englisch C2' }] }, mixed)).toMatchObject({ status: 'NEEDS_CANDIDATE', actions: [] });
    // The same quote does support a "yes" to B2 or lower, in another language's words too.
    const b2 = guardPlan({ actions: [{ fieldId: 'k2', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2' }], missingRequired: [] }, [{ ...field, id: 'k2', label: 'Tedesco almeno B1?' }], candidate);
    expect(b2.actions).toHaveLength(1);
    // A countable requirement is never read off a quote; the candidate's own answer to it is.
    const years = { id: 'k3', kind: 'select', label: 'Mindestens 3 Jahre Berufserfahrung?', required: true, options: [{ label: 'Ja' }, { label: 'Nein' }] };
    expect(guardPlan({ actions: [{ fieldId: 'k3', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2' }], missingRequired: [] }, [years], candidate).actions).toEqual([]);
    const answered = { ...candidate, portalQuestionsAnswered: [{ question: 'Mindestens 3 Jahre Berufserfahrung?', answer: 'Ja' }] };
    expect(guardPlan({ actions: [{ fieldId: 'k3', action: 'select', value: 'Ja', source: 'answers', evidence: '' }], missingRequired: [] }, [years], answered).actions).toHaveLength(1);
  });

  it('gives the planner the work history and the education as the CV states them', () => {
    const form = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-test@candidature.example' },
      profile: {
        experience: [{ role: 'Infermiera', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', highlights: ['x'] }],
        education: [{ degree: 'Bachelor in cure infermieristiche', institution: 'SUPSI', start: '2014', end: '2017' }],
      },
      job: { title: 'Infermiera', company: 'Ospedale Civico' },
    });
    expect(form.job).toEqual({ title: 'Infermiera', company: 'Ospedale Civico', organization: '' });
    expect(form.profile.experience).toEqual([{ role: 'Infermiera', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023' }]);
    expect(form.profile.education[0]).toMatchObject({ degree: 'Bachelor in cure infermieristiche', institution: 'SUPSI' });
  });

  it('reads ahead accessible ATS forms, and never fails the draft', async () => {
    expect([...PREREAD_CHANNELS].sort()).toEqual(['greenhouse', 'jobs_ch', 'lever', 'manatal', 'personio', 'refline', 'smartrecruiters', 'softgarden', 'successfactors', 'umantis', 'workday']);
    expect(isSafeEmployerSitePreread('https://live.solique.ch/planzer/apply/id/1915412/')).toBe(true);
    expect(isSafeEmployerSitePreread('http://live.solique.ch/planzer/apply/id/1915412/')).toBe(false);
    expect(isSafeEmployerSitePreread('https://www.solique.ch/planzer/apply/id/1915412/')).toBe(false);
    // JOIN registers the e-mail on its first step: it is never read here. An
    // account ATS is attempted only as a guest form; a sign-in/create-account
    // page is caught and returns no requirements.
    const launch = () => { throw new Error('must not launch'); };
    expect(await readPortalQuestions({ channelType: 'employer_site', applyUrl: 'https://join.com/x', codex: async () => ({}), launch })).toEqual([]);
    expect(await readPortalQuestions({
      channelType: 'employer_site',
      applyUrl: 'https://jobs.six-group.com/talentcommunity/apply/1448418433/?locale=en_US',
      postingUrl: 'https://jobs.six-group.com/job/Zurich-Senior-IT-Manager/1448418434/',
      codex: async () => ({}), launch,
    })).toEqual([]);
    let soliqueLaunches = 0;
    expect(await readPortalQuestions({
      channelType: 'employer_site',
      applyUrl: 'https://live.solique.ch/planzer/apply/id/1915412/',
      codex: async () => ({}),
      launch: () => { soliqueLaunches += 1; throw new Error('synthetic browser failure'); },
    })).toEqual([]);
    expect(soliqueLaunches).toBe(1);
    expect(await readPortalQuestions({ channelType: 'workday', applyUrl: 'https://x.wd3.myworkdayjobs.com/a', codex: async () => ({}), launch })).toEqual([]);
    // A browser that fails: no questions, no error.
    expect(await readPortalQuestions({ channelType: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply', codex: async () => ({}), launch })).toEqual([]);
  });

  it('turns a readable required portal file into a document upload, not a text question', () => {
    const fields = [
      { id: 'ref', kind: 'file', inputType: 'file', label: 'Arbeitszeugnisse', required: true },
      { id: 'cv', kind: 'file', inputType: 'file', label: 'Lebenslauf / CV', required: true },
      { id: 'machine', kind: 'file', inputType: 'file', label: 'file:_r_3_:input', required: true },
      { id: 'salary', kind: 'text', label: 'Lohnvorstellung', required: true },
    ];
    const result = portalRequirementsFromMissingRequired(fields, [
      { question: 'Arbeitszeugnisse', why: '', type: 'text', options: [] },
      { fieldId: 'cv', question: 'Lebenslauf / CV', why: '', type: 'text', options: [] },
      { fieldId: 'machine', question: 'file:_r_3_:input', why: '', type: 'text', options: [] },
      { fieldId: 'salary', question: 'Lohnvorstellung', why: '', type: 'text', options: [] },
    ]);
    expect(result.documents).toEqual([expect.objectContaining({
      label: 'Arbeitszeugnisse', required: true, quote: 'Arbeitszeugnisse',
    })]);
    expect(result.questions.map((question: any) => question.question)).toEqual(['Lohnvorstellung']);
    expect(portalRequiredDocumentFromField(fields[1])).toBeNull();
    expect(portalRequiredDocumentFromField(fields[2])).toBeNull();
  });

  it('keeps the ATS wording and maps a localized candidate question back to it', async () => {
    const result = portalRequirementsFromMissingRequired([
      {
        id: 'ce-czv',
        kind: 'select',
        label: 'Verfügst du über einen gültigen Führerausweis der Kategorie CE + CZV-Ausweis (Code 95)?',
        required: true,
        options: [{ label: 'Bitte wählen' }, { label: 'Ja' }, { label: 'Nein' }],
      },
    ], [{
      fieldId: 'ce-czv',
      question: 'Hai una patente CE valida e il certificato CZV (Code 95)?',
      why: 'Il portale lo richiede.',
      type: 'choice',
      options: ['Seleziona', 'Sì', 'No'],
      validation: {},
    }]);
    const codex = async () => ({ questions: [{
      id: result.questions[0].id,
      sourceLocale: 'de',
      question: 'Hai una patente CE valida e il certificato CZV (Code 95)?',
      why: 'Il portale lo richiede.',
      options: ['Seleziona', 'Sì', 'No'],
    }] });
    const localized = await localizePortalQuestions(result.questions, {
      candidateLocale: 'it',
      applicationLocale: 'de',
      codex,
    });
    expect(localized[0]).toMatchObject({
      question: 'Hai una patente CE valida e il certificato CZV (Code 95)?',
      applicationQuestion: 'Verfügst du über einen gültigen Führerausweis der Kategorie CE + CZV-Ausweis (Code 95)?',
      options: ['Seleziona', 'Sì', 'No'],
      applicationOptions: ['Bitte wählen', 'Ja', 'Nein'],
    });
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      answers: { [localized[0].id]: 'Sì' },
      portalQuestions: localized,
    });
    expect(candidate.portalQuestionsAnswered).toEqual([expect.objectContaining({
      question: 'Verfügst du über einen gültigen Führerausweis der Kategorie CE + CZV-Ausweis (Code 95)?',
      answer: 'Ja',
      candidateQuestion: 'Hai una patente CE valida e il certificato CZV (Code 95)?',
    })]);
  });

  it('requires an explicit map for translated arbitrary options and never trusts their position', () => {
    expect(portalOptionMap({ options: ['Uno', 'Due'], applicationOptions: ['A', 'B'] })).toEqual([]);
    expect(portalAnswerForApplication({ options: ['Uno', 'Due'], applicationOptions: ['A', 'B'] }, 'Due')).toBe('');
    expect(portalOptionMap({ options: ['A', 'a'], applicationOptions: ['X', 'Y'] })).toEqual([]);
    expect(portalAnswerForApplication({ options: ['C++', 'C'], applicationOptions: ['C++', 'C'] }, 'C')).toBe('C');
    const question = {
      options: ['Uno', 'Due'],
      applicationOptions: ['A', 'B'],
      optionMap: [{ candidate: 'Uno', application: 'B' }, { candidate: 'Due', application: 'A' }],
    };
    expect(portalOptionMap(question)).toEqual(question.optionMap);
    expect(portalAnswerForApplication(question, 'Uno')).toBe('B');
  });

  it('keeps the actual ATS question readable when localization fails', async () => {
    const localized = await localizePortalQuestions([{
      id: 'q',
      question: 'Verfügst du über einen gültigen Führerausweis?',
      applicationQuestion: 'Verfügst du über einen gültigen Führerausweis?',
      options: ['Ja', 'Nein'],
      applicationOptions: ['Ja', 'Nein'],
      validation: { message: 'Pflichtfeld' },
    }], {
      candidateLocale: 'it',
      applicationLocale: 'de',
      codex: async () => { throw new Error('translation unavailable'); },
    });
    expect(localized[0]).toMatchObject({
      question: 'Verfügst du über einen gültigen Führerausweis?',
      applicationQuestion: 'Verfügst du über einen gültigen Führerausweis?',
      options: ['Sì', 'No'],
      applicationOptions: ['Ja', 'Nein'],
      localizationStatus: 'fallback',
    });
  });

  it('preserves EOC nationality options verbatim when duplicate labels prevent a complete map', async () => {
    const options = [
      'Selezionare', '-----------------------------------------', 'Svizzera', 'Tedesca', 'Italiana',
      'Afgano', 'Aland', 'Dominicano', 'Dominicano', 'Honduregno', 'Honduregno',
    ];
    const localized = await localizePortalQuestions([{
      id: 'nationality',
      question: 'Nazionalità',
      applicationQuestion: 'Nazionalità',
      options,
      applicationOptions: options,
    }], {
      candidateLocale: 'it',
      applicationLocale: 'it',
      codex: async () => { throw new Error('same-language nationality must not need translation'); },
    });

    expect(localized[0]).toMatchObject({
      question: 'Nazionalità',
      applicationQuestion: 'Nazionalità',
      options,
      applicationOptions: options,
      applicationQuestionLocale: null,
      localizationStatus: 'fallback',
    });
    expect(portalAnswerForApplication(localized[0], 'Italiana')).toBe('Italiana');
    expect(portalAnswerForApplication(localized[0], 'Dominicano')).toBe('');
  });

  it('does not treat foreign nationality options as Italian from the question label alone', async () => {
    const options = ['Nationality', 'Nationalité'];
    const localized = await localizePortalQuestions([{
      id: 'nationality',
      question: 'Nazionalità',
      applicationQuestion: 'Nazionalità',
      options,
      applicationOptions: options,
    }], { candidateLocale: 'it', applicationLocale: 'it' });

    expect(localized[0].localizationStatus).not.toBe('same_language');
    expect(localized[0].options).toEqual(options);
  });

  it('recognizes Unicode CV labels and keeps same-prefix portal file fields distinct', () => {
    expect(portalRequiredDocumentFromField({ kind: 'file', required: true, label: 'Résumé' })).toBeNull();
    const first = portalRequiredDocumentFromField({ id: 'field_same_prefix_alpha', kind: 'file', required: true, label: 'Same label with a long normalized prefix 1234567890' });
    const second = portalRequiredDocumentFromField({ id: 'field_same_prefix_beta', kind: 'file', required: true, label: 'Same label with a long normalized prefix 1234567890' });
    expect(first?.id).not.toBe(second?.id);
    expect(mergeRequiredDocuments([], [first, second])).toHaveLength(2);
  });

  it('tells the interview prep what the employer already received', () => {
    const text = interviewPrepUserText({
      invitation: {}, posting: { title: 'Infermiera', company: 'Ospedale' }, requirements: [], matches: [], profile: {}, answers: {},
      submitted: { coverLetter: 'Gentili Signori, …', portalAnswers: [{ question: 'Disponibilità', answer: 'Dal 1° dicembre', source: 'answers' }] },
    });
    expect(JSON.parse(text).submitted).toEqual({ coverLetter: 'Gentili Signori, …', portalAnswers: [{ question: 'Disponibilità', answer: 'Dal 1° dicembre' }] });
  });
});

// A real order of 2026-10-07 (Workday): the order names «Rituals Cosmetics Switzerland», the posting's page only
// the brand, and the posting's own data (Workday's answer for that address) «Rituals Cosmetics Germany GmbH».
describe('portal: one employer under two names', () => {
  it('takes two national entities of one company for the same employer, and nothing looser', () => {
    expect(sameEmployerFamily('Rituals Cosmetics Germany GmbH', 'Rituals Cosmetics Switzerland')).toBe(true);
    expect(sameEmployerFamily('Muster Elektro (Schweiz) AG', 'Muster Elektro Deutschland GmbH')).toBe(true);
    expect(sameEmployerFamily('Muster Elektro AG', 'Muster Elektro AG')).toBe(true);
    // Another company, a longer or a shorter name, or nothing that is a name once the country is gone.
    expect(sameEmployerFamily('Rituals Cosmetics Germany GmbH', 'Lush Cosmetics Switzerland')).toBe(false);
    expect(sameEmployerFamily('Rituals Germany GmbH', 'Rituals Cosmetics Switzerland')).toBe(false);
    expect(sameEmployerFamily('Muster Elektro Service AG', 'Muster Elektro AG')).toBe(false);
    expect(sameEmployerFamily('Hotel Deutschland GmbH', 'Hotel Schweiz AG')).toBe(false);
    expect(sameEmployerFamily('Schweiz AG', 'Deutschland GmbH')).toBe(false);
    // Review of #12292: a continent or «International» is no country of a branch.
    expect(sameEmployerFamily('Acme Europe', 'Acme International')).toBe(false);
    expect(sameEmployerFamily('Acme Europe GmbH', 'Acme Switzerland')).toBe(false);
    expect(sameEmployerFamily('', 'Rituals Cosmetics Switzerland')).toBe(false);
    expect(sameEmployerFamily(undefined as any, undefined as any)).toBe(false);
  });

  it('does not read the branch country on a form as the employer, nor the other entity as someone else', () => {
    const job = { title: 'Weihnachtsaushilfe (m/w/d)', company: 'Rituals Cosmetics Switzerland', organization: 'Rituals Cosmetics Germany GmbH' };
    // Workday's first step: the stale title, the brand next to the page's own word, the country as a country.
    const form = 'Create Account\nRituals Careers\nCandidate Home\nWeihnachtsaushilfe (m/w/d)\nMy Information\nCountry Switzerland\nPhone Device Type Mobile\nSave and Continue';
    expect(namesAnotherEmployer(form, job)).toBe(false);
    expect(formPostingMatch(form, job, { postingMatched: true })).toBe('match');
    // Without the posting having named the employer the form alone is still no match, and another role never is.
    expect(formPostingMatch(form, job)).toBe('mismatch');
    expect(formPostingMatch(form, { ...job, title: 'Store Manager' }, { postingMatched: true })).toBe('mismatch');
    // Review of #12292: the country is skipped only next to a word that labels a field. Next to anything
    // else it still declares someone else, as every other word of the company does.
    expect(namesAnotherEmployer('Switzerland Bank', { company: 'Acme Switzerland' })).toBe(true);
    expect(namesAnotherEmployer('Create Account\nOther Switzerland\nConcierge', { company: 'Acme Switzerland', title: 'Concierge' })).toBe(true);
    for (const line of ['Country Switzerland', 'Country* Switzerland', 'Nationality: Switzerland', 'Land Schweiz', 'Paese Svizzera', 'Phone Switzerland (+41)', 'Switzerland']) {
      expect(namesAnotherEmployer(`Create Account\n${line}`, { company: 'Acme Switzerland Schweiz Svizzera' })).toBe(false);
    }
    // The other entity's own words are the employer's: «Rituals Cosmetics Germany» on the form is nobody else.
    expect(namesAnotherEmployer(`${form}\nRituals Cosmetics Germany GmbH`, job)).toBe(false);
    // A legal form next to a word of the company is no one's name; the word after it still counts.
    expect(namesAnotherEmployer('Create Account\nAcme GmbH', { company: 'Acme AG' })).toBe(false);
    expect(namesAnotherEmployer('Create Account\nAcme GmbH Partners', { company: 'Acme AG' })).toBe(true);
    expect(namesAnotherEmployer(`${form}\nRituals Cosmetics Germany GmbH`, { ...job, organization: '' })).toBe(true);
    // Another employer next to the brand is still a stop; a data name of another company makes none of its
    // words the employer's («Rituals Retail» stays someone else when the data says «Lush Retail GmbH»).
    expect(namesAnotherEmployer(`${form}\nRituals Franchise Partner AG`, job)).toBe(true);
    expect(namesAnotherEmployer(`${form}\nRituals Retail`, { ...job, organization: 'Lush Retail GmbH' })).toBe(true);
    expect(namesAnotherEmployer('Zurich AG', {
      company: 'Coop Genossenschaft', title: 'Bäckerin', location: 'Zurich',
    })).toBe(true);
    expect(namesAnotherEmployer('Coop Genossenschaft\nStandort Rickenbach', {
      company: 'Coop Genossenschaft', title: 'Bäckerin', location: 'Rickenbach',
    }, { allowPostingLocation: true })).toBe(false);
    expect(namesAnotherEmployer('Bäckerin — Coop Genossenschaft Standort Rickenbach', {
      company: 'Coop Genossenschaft', title: 'Bäckerin', location: 'Rickenbach',
    }, { allowPostingLocation: true })).toBe(false);
  });
});

// 2026-10-07 (Workday): a run finds the application an earlier run left in progress.
describe('portal: an application in progress from an earlier run', () => {
  it('knows the portal’s own «refresh the page» from a page that only mentions a refresh', () => {
    for (const text of [
      'Something went wrong Please refresh the page and then try again. Error Code: VPS|0000',
      'Ein Fehler ist aufgetreten. Bitte laden Sie die Seite neu.',
      'Si è verificato un errore: ricarica la pagina e riprova.',
      'Une erreur est survenue. Veuillez actualiser la page.',
    ]) expect(REFRESH_ASKED_RE.test(text)).toBe(true);
    for (const text of ['Refresh your skills with our training', 'My Information Save and Continue', 'Seite 2 von 4']) expect(REFRESH_ASKED_RE.test(text)).toBe(false);
  });

  it('takes away only the file of the same name, by the button that names it', () => {
    const buttons = [
      { id: 'b1', text: 'Select files' },
      { id: 'b2', text: 'Delete CV_Luca_Bianchi.pdf' },
      { id: 'b3', text: 'Delete Zeugnis_2019.pdf' },
      { id: 'b4', text: 'CV_Luca_Bianchi.pdf entfernen' },
      { id: 'b5', text: 'Download CV_Luca_Bianchi.pdf' },
      { id: 'b6', text: 'Delete CV_Luca_Bianchi.pdf', disabled: true },
      { id: 'b7', text: 'Delete' },
    ];
    expect(removalsOf(buttons, ['CV_Luca_Bianchi.pdf']).map((button: any) => button.id)).toEqual(['b2', 'b4']);
    expect(removalsOf(buttons, ['Anschreiben_Luca_Bianchi.pdf'])).toEqual([]);
    expect(removalsOf(buttons, [''])).toEqual([]);
    expect(removalsOf(undefined as any, ['CV_Luca_Bianchi.pdf'])).toEqual([]);
  });
});

describe('phone-country search contracts', () => {
  const candidate = candidateForForm({
    identity: { phone: '+41 79 123 45 67' }, profile: {}, answers: {},
  });

  it('does not send a dial code to a generic searchable Country field', () => {
    expect(candidateAnswerForField(candidate, {
      label: 'Country', context: 'Phone', kind: 'text', inputType: 'text', search: true, options: [],
    })).toBeNull();
  });

  it('uses a dial code only for an explicit phone-country-code search', () => {
    expect(candidateAnswerForField(candidate, {
      label: 'Country Phone Code', kind: 'text', inputType: 'text', search: true, options: [],
    })).toEqual({ value: '+41', source: 'identity' });
  });
});


describe('translated language answer reuse', () => {
  it.each([['English', 'Professionale', 'Professional'], ['German', 'Conversazionale', 'Conversational']])(
    'uses the mapped %s answer without treating its original as a conflict', (language, original, translated) => {
      const id = `portal_${language.toLowerCase()}_fluency_required`;
      const label = `${language} Fluency?* (required)`;
      const question = { id, question: `Livello di ${language}?`, applicationQuestion: label,
        options: ['Seleziona', original], applicationOptions: ['Please select', translated],
        optionMap: [{ candidate: 'Seleziona', application: 'Please select' }, { candidate: original, application: translated }] };
      const candidate = candidateForForm({ identity: {}, answers: { [id]: original }, portalQuestions: [question] });
      const field = { label, kind: 'select', options: question.applicationOptions.map(label => ({ label })) };
      expect(candidateAnswerForField(candidate, field)).toEqual({ value: translated, source: 'answers' });
      // A genuinely different answer under another field id must still block reuse.
      candidate.answers[`portal_${language.toLowerCase()}_proficiency`] = 'Basic';
      expect(candidateAnswerForField(candidate, field)).toBeNull();
    },
  );

  it('preserves the mapped answer id when a regenerated question reuses a previous answer', () => {
    const candidate = candidateForForm({
      identity: {},
      answers: { portal_professionale: 'Professionale' },
      portalQuestions: [{
        id: 'portal_professionale_v2',
        question: 'Livello di inglese?',
        applicationQuestion: 'Professional',
        options: ['Professionale'],
        applicationOptions: ['Professional'],
        optionMap: [{ candidate: 'Professionale', application: 'Professional' }],
      }],
      draft: { portalAnswers: { answers: [{
        answerId: 'portal_professionale', question: 'Professional', answer: 'Professional',
      }] } },
    });

    expect(candidate.portalQuestionsAnswered).toEqual(expect.arrayContaining([
      expect.objectContaining({ answerId: 'portal_professionale', question: 'Professional', answer: 'Professional' }),
    ]));
    expect(candidateAnswerForField(candidate, { label: 'Professional', kind: 'select', options: [{ label: 'Professional' }] }))
      .toEqual({ value: 'Professional', source: 'answers' });
  });
});


describe('translated historical answer identity', () => {
  it('preserves the original answer id when the ATS regenerates the current field id', () => {
    const question = { id: 'portal_english_fluency_new', question: 'English proficiency?', options: ['Professional', 'Basic'] };
    const candidate = candidateForForm({ identity: {}, answers: { portal_english_fluency_old: 'Professionale' },
      portalQuestions: [question], draft: { portalAnswers: { answers: [{ answerId: 'portal_english_fluency_old', question: 'English fluency?', answer: 'Professional' }] } } });
    expect(candidate.portalQuestionsAnswered).toEqual([expect.objectContaining({ answerId: 'portal_english_fluency_old', answer: 'Professional' })]);
    expect(candidateAnswerForField(candidate, { label: question.question, kind: 'select', options: question.options.map(label => ({ label })) })).toEqual({ value: 'Professional', source: 'answers' });
  });
});

describe('portal: identity on an exact posting route without a heading', () => {
  const job = { company: 'Azienda Esempio SA', title: 'Project Manager' };
  const postingUrl = 'https://jobs.example.test/jobs/01234567-89ab-cdef-0123-456789abcdef/details/';
  const route = { pageUrl: postingUrl, postingUrl };
  const pageText = `open navigation\n${job.company}\nDescrizione del ruolo\n${job.title}`;

  it('uses the matching document title when the route has no h1 and ignores leading navigation chrome', () => {
    expect(hasVacancySpecificPostingEvidence(pageText, job, { ...route, pageTitle: job.title })).toBe(false);
    expect(hasVacancySpecificPostingEvidence(pageText, job, {
      ...route, pageTitle: job.title, uniqueApplicationEntryProven: true,
    })).toBe(true);
  });

  it.each([
    'open navigation', 'close navigation', 'menu', 'skip to content', 'Skip to main content',
    'Zum Hauptinhalt springen', 'Salta al contenuto', 'Aller au contenu',
  ])
  ('does not treat the «%s» row as an employer title candidate', (navigationLabel) => {
    const pageText = `${navigationLabel}
${job.company}
${job.title}`;
    expect(hasVacancySpecificPostingEvidence(pageText, job, {
      ...route, uniqueApplicationEntryProven: true,
    })).toBe(true);
  });

  it('rejects a different document title, another h1, and another employer in the page text', () => {
    expect(hasVacancySpecificPostingEvidence(pageText, job, { ...route, pageTitle: 'Office Coordinator' })).toBe(false);
    expect(hasVacancySpecificPostingEvidence(pageText, job, {
      ...route, pageTitle: job.title, pageHeading: 'Office Coordinator',
    })).toBe(false);
    const otherEmployerJob = { company: 'Grand Hotel Esempio', title: 'Concierge' };
    expect(hasVacancySpecificPostingEvidence('open navigation\nCONCIERGE | HOTEL SPLENDIDE', otherEmployerJob, {
      ...route, pageTitle: otherEmployerJob.title,
    })).toBe(false);
  });

  it('recognizes only standalone Italian application labels', () => {
    for (const label of ['Applica', 'Applica ora', 'Applica adesso', 'Applica subito']) {
      expect(startsApplication(label)).toBe(true);
    }
    expect(startsApplication('Si applica il CCL')).toBe(false);
  });

  it('does not read an Italian application label in the vacancy card as another employer', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const postingUrl = `https://jobs.example.test/jobs/${uuid}/details/`;
    const entry = {
      text: 'Applica ora',
      href: `https://apply.example.test/${uuid}/apply`,
      vacancyContext: 'Grand Hotel Esempio Concierge Host (m/w/d) Applica ora',
      frame: 0,
    };
    expect(applicationEntryControls({
      url: postingUrl,
      fields: [],
      buttons: [],
      links: [entry],
    }, {
      applyUrl: postingUrl,
      postingUrl,
      pageTitle: 'Concierge Host (m/w/d)',
      job: { company: 'Grand Hotel Esempio', title: 'Concierge Host (m/w/d)' },
      allowSingleExternalApplicationEntry: true,
    })).toEqual([entry]);
  });

  it('binds a full UUID posting segment and rejects a different UUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const otherUuid = 'fedcba98-7654-3210-fedc-ba9876543210';
    const addressedPosting = `https://jobs.example.test/jobs/${uuid}`;
    expect(applicationEntryCarriesPostingId(`https://apply.example.test/${uuid}/apply`, addressedPosting)).toBe(true);
    expect(applicationEntryCarriesPostingId(`https://apply.example.test/${otherUuid}/apply`, addressedPosting)).toBe(false);
    expect(applicationEntryCarriesPostingId('https://apply.example.test/555555555555/apply', addressedPosting)).toBe(false);
  });

  it('normalizes explicit posting ids before matching apply-link ids', () => {
    expect(applicationEntryCarriesPostingId(
      'https://ats.example.test/apply/?postingid=AbC',
      'https://jobs.example.test/role/?postingid=AbC',
    )).toBe(true);
  });

  it('does not bind an ATS link to a tenant UUID when the posting route has a later requisition UUID', () => {
    const tenantUuid = '01234567-89ab-cdef-0123-456789abcdef';
    const postingUuid = '11111111-2222-3333-4444-555555555555';
    const otherPostingUuid = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const postingUrl = `https://jobs.example.test/${tenantUuid}/${postingUuid}`;
    expect(applicationEntryCarriesPostingId(
      `https://ats.example.test/apply/${tenantUuid}/${otherPostingUuid}`,
      postingUrl,
    )).toBe(false);
    expect(applicationEntryCarriesPostingId(`https://ats.example.test/apply/${postingUuid}`, postingUrl)).toBe(true);
  });

  it('fails closed when a posting or its apply link has more than 128 route segments', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const deepPath = Array.from({ length: 129 }, (_, index) => `route${index}`).join('/');
    expect(applicationEntryCarriesPostingId(
      `https://ats.example.test/apply/${uuid}`,
      `https://jobs.example.test/${deepPath}/${uuid}`,
    )).toBe(false);
    expect(applicationEntryCarriesPostingId(
      `https://ats.example.test/${deepPath}/${uuid}`,
      `https://jobs.example.test/${uuid}`,
    )).toBe(false);
  });

  it('ignores oversized vacancy context before constructing label-matching expressions', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const postingUrl = `https://jobs.example.test/jobs/${uuid}`;
    const entry = {
      text: 'Applica ora',
      href: 'https://apply.example.test/apply',
      vacancyContext: `Grand Hotel Esempio Concierge Host (m/w/d)${' extra'.repeat(120)} Applica ora`,
      frame: 0,
    };
    expect(applicationEntryControls({
      url: postingUrl,
      fields: [],
      buttons: [],
      links: [entry],
    }, {
      applyUrl: postingUrl,
      postingUrl,
      pageTitle: 'Concierge Host (m/w/d)',
      job: { company: 'Grand Hotel Esempio', title: 'Concierge Host (m/w/d)' },
      allowSingleExternalApplicationEntry: true,
    })).toEqual([]);
  });
});
