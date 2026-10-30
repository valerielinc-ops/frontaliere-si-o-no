import { describe, expect, it } from 'vitest';
import { operationalDefaultAnswer, withOperationalQuestionAnswers, operationalEmailBody } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { evaluateRedFlags, transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { autoAnswersForPortalQuestions } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { openRequiredQuestions } from '../scripts/assisted-application/lib/submit.mjs';

const questions = [
  { id: 'notice', question: 'Qual è il tuo attuale periodo di preavviso?', applicationQuestion: 'Attuale periodo di preavviso *', type: 'choice', options: [], required: true, source: 'portal' },
  { id: 'whatsapp', question: 'Accetti la comunicazione tramite WhatsApp?', applicationQuestion: 'Comunicazione via WhatsApp *', type: 'yes_no', options: [], required: true, source: 'portal' },
  { id: 'workload', question: 'Qual è il grado di occupazione desiderato?', type: 'choice', options: [], required: true, source: 'portal' },
];
const draft = { status: 'ready', round: 1, job: { source: 'job_detail' }, channel: { type: 'portal' }, questions };
const approved = { state: 'needs_candidate_action', round: 1, heldBy: questions.map(q => `question:${q.id}`), dispatch: { mode: 'submit', round: 1, attempts: 1 } };

describe('operational preferences at every required-answer gate', () => {
  it('projects defaults without recording candidate facts', () => {
    const result = withOperationalQuestionAnswers(questions, {});
    expect(result.answers).toEqual({ notice: '3 mesi', whatsapp: 'Sì', workload: '100%' });
    expect(Object.values(result.defaults).every(item => item.source === 'policy_default')).toBe(true);
    expect(evaluateRedFlags(draft).candidate).toEqual([]);
    expect(openRequiredQuestions(draft)).toEqual([]);
    const actual = candidateWithEdits({ order: {}, draft, flow: {} });
    expect(actual.answers).toEqual({});
    expect(actual.profile.availability || '').toBe('');
  });

  it('preserves explicit answers and keeps genuinely hard questions open', () => {
    expect(withOperationalQuestionAnswers(questions, { notice: '1 mese', whatsapp: false, workload: 80 }).answers)
      .toEqual({ notice: '1 mese', whatsapp: false, workload: 80 });
    const mixed = { ...draft, questions: [...questions, { id: 'license', question: 'Hai la certificazione richiesta?', type: 'yes_no', required: true }] };
    expect(evaluateRedFlags(mixed).candidate).toEqual(['license']);
    expect(openRequiredQuestions(mixed).map(q => q.id)).toEqual(['license']);
    expect(transition(approved, { type: 'tick' }, { draft: mixed }).flow.state).toBe('needs_candidate_action');
  });

  it('resumes only an approved round with completely resolved, identified holds', () => {
    expect(transition(approved, { type: 'tick' }, { draft }).effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }]);
    for (const blocked of [
      { ...approved, dispatch: { mode: 'draft', round: 1 } },
      { ...approved, heldBy: ['question:unknown'] },
      { ...approved, heldBy: ['document:degree'] },
      { ...approved, postingExpiredAt: Date.now() },
    ]) expect(transition(blocked, { type: 'tick' }, { draft }).flow.state).toBe('needs_candidate_action');
    expect(transition(approved, { type: 'tick' }, { draft: { ...draft, factCheck: { unsupported: [{ field: 'letter', kind: 'skill', token: 'unknown' }] } } }).flow.state).toBe('needs_candidate_action');
  });

  it('keeps only unanswered questions in a portal wait', () => {
    const hard = { id: 'hard', question: 'Hai un permesso di lavoro?', type: 'text', required: true };
    const result = transition({ ...approved, state: 'submitting' }, { type: 'submit_needs_candidate', questions: [...questions, hard] }, { draft: { ...draft, questions: [...questions, hard] } });
    expect(result.flow.heldBy).toEqual(['question:hard']);
  });
});

describe('scope, languages and actual field options', () => {
  it.each([
    ['Notice period', '3 months'], ['Kündigungsfrist', '3 Monate'], ['Délai de préavis', '3 mois'], ['Periodo di preavviso', '3 mesi'],
  ])('uses the language of %s', (label, value) => expect(operationalDefaultAnswer({ label })?.value).toBe(value));

  it.each([
    'Can you start within 1 month?', 'Can you confirm a notice period of 1 month?',
    'Earliest start date', 'Notice period maximum 1 month', 'Do you have WhatsApp?',
    'Your WhatsApp number', 'Accetti marketing tramite WhatsApp?', 'WhatsApp privacy conditions',
    'Hai esperienza nella comunicazione via WhatsApp?', 'Can you work 100% shifts?',
    'Hai un diploma?', 'Confermi disponibilità al 100% richiesta?',
  ])('does not invent facts or consent: %s', label => expect(operationalDefaultAnswer({ label, type: 'yes_no' })).toBeNull());

  it('requires an available preference and respects validation bounds', () => {
    expect(operationalDefaultAnswer({ label: 'Notice period', options: [{ label: '3 months', value: 'notice_3' }] })?.value).toBe('3 months');
    expect(operationalDefaultAnswer({ label: 'Notice period', options: ['1 month', '6 months'] })).toBeNull();
    expect(operationalDefaultAnswer({ label: 'Notice period (months)', type: 'number', validation: { max: 2 } })).toBeNull();
    expect(operationalDefaultAnswer({ label: 'Notice period', type: 'date' })).toBeNull();
  });

  it('fills the portal without promoting defaults into confirmed CV facts', () => {
    const candidate = { identity: {}, profile: { availability: 'Immediately' }, answers: {} };
    const field = { id: 'notice', label: 'Notice period', kind: 'text', required: true, options: [] };
    expect(candidateAnswerForField(candidate, field)).toMatchObject({ value: '3 months', source: 'policy_default' });
    const guarded = guardPlan({ actions: [{ fieldId: 'notice', action: 'fill', value: '1 month', source: 'rule' }], missingRequired: [] }, [field], candidate);
    expect(guarded.actions).toEqual([expect.objectContaining({ value: '3 months', source: 'policy_default' })]);
    expect(guarded.missingRequired).toEqual([]);
    expect(autoAnswersForPortalQuestions({ questions, candidate })).toEqual({});
    expect(candidate.answers).toEqual({});
  });

  it('includes required defaults in an email without editing its stored draft', () => {
    const emailDraft = { ...draft, language: 'it', applicationEmail: { body: 'Buongiorno' } };
    expect(operationalEmailBody(emailDraft)).toContain('3 mesi');
    expect(operationalEmailBody(emailDraft)).toContain('100%');
    expect(emailDraft.applicationEmail.body).toBe('Buongiorno');
  });
});
