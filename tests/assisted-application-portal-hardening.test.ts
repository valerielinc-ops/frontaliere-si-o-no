import { describe, expect, it } from 'vitest';
import { fitToLength } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { guardPlan, PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { guardAgentStep } from '../scripts/assisted-application/lib/portal/agent.mjs';
import {
  candidateForForm,
  COOKIE_ACCEPT_RE,
  COOKIE_REJECT_RE,
  formPostingMatch,
  namesAnotherEmployer,
  ownAccountForm,
  sendsApplication,
  privacyConsentControls,
  postingMatch,
  PREREAD_CHANNELS,
  readPortalQuestions,
  realisticUserAgent,
  urlConfirms,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { interviewPrepUserText } from '../functions/src/assistedApplicationInterviewPrep.js';

// career-ops comparison of 2026-10-01: what the portal runner still lacked.
describe('portal runner hardening (career-ops apply.md)', () => {
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
    // The whole name on the form is the direct match, as ever.
    expect(viaPosting('Concierge — Grand Hotel Esempio')).toBe('match');
    expect(viaPosting('Concierge — Grand Hotel Esempio AG', { ...job, company: 'Grand Hotel Esempio AG' })).toBe('match');
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

  it('takes an address as a confirmation only when it is not a review step and the send button is gone', () => {
    const sendButton = { buttons: [{ text: 'Submit application', disabled: false }] };
    expect(urlConfirms('https://jobs.example/apply/review-and-confirm', { buttons: [] })).toBe(false);
    expect(urlConfirms('https://jobs.example/apply/thank-you', sendButton)).toBe(false);
    expect(urlConfirms('https://jobs.example/apply/thank-you', { buttons: [{ text: 'Back to jobs' }] })).toBe(true);
    expect(urlConfirms('https://jobs.example/apply/step-3', { buttons: [] })).toBe(false);
  });

  it('shortens a long answer at a sentence end, never in the middle of one', () => {
    const text = 'Lavoro da otto anni in reparto. Coordino un team di sei persone e seguo la formazione dei nuovi colleghi.';
    expect(fitToLength(text, 200)).toBe(text);
    expect(fitToLength(text, 60)).toBe('Lavoro da otto anni in reparto.');
    // No sentence end in the second half of the limit: a word end, no dangling comma.
    expect(fitToLength('Coordino un team di sei persone, seguo la formazione', 34)).toBe('Coordino un team di sei persone');
  });

  it('presents the browser as the Chrome it is, without "Headless", on the real system', () => {
    expect(realisticUserAgent('151.0.7922.34', 'linux')).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');
    expect(realisticUserAgent('151.0.7922.34', 'darwin')).toContain('Macintosh');
    expect(realisticUserAgent('', 'linux')).not.toMatch(/headless/i);
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
    const turn = (evidence: string, answer: string) => ({ status: 'act', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Livello di tedesco', answer, source: 'profile', evidence }] });
    expect(guardAgentStep(turn('', 'C1'), candidate)).toMatchObject({ status: 'needs_candidate', actions: [] });
    expect(guardAgentStep(turn('Tedesco B2', 'B2'), candidate).actions).toHaveLength(1);
  });

  // Review of #10715: the quote must SUPPORT the answer, not just be in the data.
  it('never takes a "yes" to a higher level from a quote of a lower one', () => {
    const candidate = { answers: {}, profile: { languages: ['Deutsch B2'] }, portalQuestionsAnswered: [] };
    const field = { id: 'k1', kind: 'select', label: 'Deutsch C1?', required: true, options: [{ label: 'Ja' }, { label: 'Nein' }] };
    const plan = guardPlan({ actions: [{ fieldId: 'k1', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2' }], missingRequired: [] }, [field], candidate);
    expect(plan.actions).toEqual([]);
    expect(plan.missingRequired.map((item: any) => item.fieldId)).toEqual(['k1']);
    const agent = guardAgentStep({ status: 'act', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Deutsch C1?', answer: 'Ja', source: 'profile', evidence: 'Deutsch B2' }] }, candidate);
    expect(agent).toMatchObject({ status: 'needs_candidate', actions: [] });
    // Second review: levels are read where the quote names the language asked.
    const mixed = { answers: {}, profile: { languages: ['Deutsch B2; Englisch C2'] }, portalQuestionsAnswered: [] };
    expect(guardPlan({ actions: [{ fieldId: 'k1', action: 'select', value: 'Ja', source: 'profile', evidence: 'Deutsch B2; Englisch C2' }], missingRequired: [] }, [field], mixed).actions).toEqual([]);
    expect(guardAgentStep({ status: 'act', reason: '', advanceRef: '', questions: [], actions: [{ ref: 'e5', action: 'click', value: '', document: 'none', question: 'Deutsch C1?', answer: 'Ja', source: 'profile', evidence: 'Deutsch B2; Englisch C2' }] }, mixed)).toMatchObject({ status: 'needs_candidate', actions: [] });
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
    });
    expect(form.profile.experience).toEqual([{ role: 'Infermiera', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023' }]);
    expect(form.profile.education[0]).toMatchObject({ degree: 'Bachelor in cure infermieristiche', institution: 'SUPSI' });
  });

  it('reads ahead only the single-page forms, and never fails the draft', async () => {
    expect([...PREREAD_CHANNELS].sort()).toEqual(['greenhouse', 'lever', 'personio', 'smartrecruiters', 'softgarden']);
    // JOIN registers the e-mail on its first step, Workday starts with an account: not read.
    const launch = () => { throw new Error('must not launch'); };
    expect(await readPortalQuestions({ channelType: 'employer_site', applyUrl: 'https://join.com/x', codex: async () => ({}), launch })).toEqual([]);
    expect(await readPortalQuestions({ channelType: 'workday', applyUrl: 'https://x.wd3.myworkdayjobs.com/a', codex: async () => ({}), launch })).toEqual([]);
    // A browser that fails: no questions, no error.
    expect(await readPortalQuestions({ channelType: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply', codex: async () => ({}), launch })).toEqual([]);
  });

  it('tells the interview prep what the employer already received', () => {
    const text = interviewPrepUserText({
      invitation: {}, posting: { title: 'Infermiera', company: 'Ospedale' }, requirements: [], matches: [], profile: {}, answers: {},
      submitted: { coverLetter: 'Gentili Signori, …', portalAnswers: [{ question: 'Disponibilità', answer: 'Dal 1° dicembre', source: 'answers' }] },
    });
    expect(JSON.parse(text).submitted).toEqual({ coverLetter: 'Gentili Signori, …', portalAnswers: [{ question: 'Disponibilità', answer: 'Dal 1° dicembre' }] });
  });
});
