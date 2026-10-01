import { describe, expect, it } from 'vitest';
import { fitToLength } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { guardPlan, PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { guardAgentStep } from '../scripts/assisted-application/lib/portal/agent.mjs';
import {
  candidateForForm,
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
    expect(postingMatch('Candidatura · Infermiera diplomata · Reparto medicina', job)).toBe('match');
    expect(postingMatch('Ospedale Regionale — Lavora con noi', job)).toBe('match');
    expect(postingMatch('Elettricista di cantiere · Muster Elektro AG · Bewerben', job)).toBe('mismatch');
    // The order names nothing to compare: no stop.
    expect(postingMatch('anything', {})).toBe('unknown');
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
