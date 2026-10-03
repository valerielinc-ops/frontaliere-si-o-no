import { describe, expect, it } from 'vitest';
import { fitToLength } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { guardPlan, PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { guardAgentStep } from '../scripts/assisted-application/lib/portal/agent.mjs';
import {
  candidateForForm,
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
