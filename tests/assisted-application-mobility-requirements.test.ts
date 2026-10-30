import { expect, it } from 'vitest';
import { guardMobilityMatch, swissMobilityRequirement } from '../functions/src/lib/mobilityRequirements.js';
import { conciergeProposalEligibility, fitNoticeOf } from '../functions/src/assistedApplicationFitNotice.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { rememberCandidateQuestionAnswers } from '../functions/src/assistedApplicationCandidateEdits.js';
import { ensureRequiredQuestions } from '../functions/src/assistedApplicationAiDraftCore.js';
import { operationalDefaultAnswer } from '../functions/src/assistedApplicationOperationalAnswers.js';

const quote = 'Resident in Switzerland or willingness to relocate.';
const row = (quote: string) => ({ requirement: quote, quote, importance: 'high', basis: 'stated' });
const requirements = { requirements: [row(quote)] };
const match = { matches: [{ index: 0, status: 'met', evidence: 'Permit G', evidenceUnverified: false }], verdict: 'good', questions: [] };
const context = { profile: { location: 'Exampletown, Italy', workPermit: 'Permit G' }, sourceText: 'Exampletown, Italy\nPermit G' };

it('does not treat a cross-border permit as residence or willingness in either funnel', () => {
  const guarded = guardMobilityMatch(requirements, match, context);
  expect(guarded.matches[0]).toMatchObject({ status: 'partial', evidence: '' });
  expect(conciergeProposalEligibility(requirements, guarded, context).status).toBe('clarification_required');
  expect(fitNoticeOf({ requirements: requirements.requirements, matches: guarded.matches, verdict: guarded.verdict })?.gaps).toHaveLength(1);
  expect(guarded.questions).toHaveLength(1);
  const question = guarded.questions[0];
  expect(question).toMatchObject({ required: true, type: 'yes_no', applicationQuestion: quote });
  expect(operationalDefaultAnswer(question)).toBeNull();
  expect(evaluateRedFlags({ status: 'ready', round: 1, questions: guarded.questions, job: { source: 'job_detail' }, channel: { type: 'email' } }).candidate).toContain(question.id);
  expect(context.profile).toEqual({ location: 'Exampletown, Italy', workPermit: 'Permit G' });
});

it.each([
  'Residenza in Svizzera o disponibilità al trasferimento.',
  'Wohnsitz in der Schweiz oder Bereitschaft zum Umzug.',
  'Résidence en Suisse ou volonté de déménager.',
  quote,
])('keeps the condition separate from authorization: %s', clause => {
  expect(swissMobilityRequirement(row(clause))).not.toBeNull();
  expect(guardMobilityMatch({ requirements: [row(clause)] }, match, context).matches[0].status).toBe('partial');
});

it.each([
  'Valid Swiss residence permit required.',
  'Swiss citizen or resident in Switzerland.',
  'Residenza in Svizzera non richiesta.',
  'Wohnsitz in der Schweiz nicht erforderlich.',
  'Résidence en Suisse non obligatoire.',
  'Office in Switzerland; infrastructure management required.',
])('does not invent a mobility requirement from a different condition: %s', clause => {
  expect(swissMobilityRequirement(row(clause))).toBeNull();
});

it('uses actual current residence or explicit relocation evidence, without changing either fact', () => {
  const resident = { profile: { location: 'Examplecity, Switzerland' }, sourceText: 'Examplecity, Switzerland\nPermit G' };
  expect(guardMobilityMatch(requirements, match, resident).matches[0]).toMatchObject({ status: 'met', evidence: 'Examplecity, Switzerland' });
  const evidence = 'Available to relocate to Switzerland';
  expect(guardMobilityMatch(requirements, { ...match, matches: [{ ...match.matches[0], evidence }] }, { ...context, sourceText: evidence }).matches[0].status).toBe('met');
  expect(guardMobilityMatch(requirements, match, { profile: { location: 'Exampletown, Italy', availability: evidence }, sourceText: evidence }).questions).toEqual([]);
});

it.each(['Swiss citizenship', 'Company resident in Switzerland', 'Not willing to relocate to Switzerland', 'Lived in Switzerland previously'])('does not repurpose unrelated or negated evidence: %s', evidence => {
  const result = guardMobilityMatch(requirements, { ...match, matches: [{ ...match.matches[0], evidence }] }, { ...context, sourceText: evidence });
  expect(result.matches[0].status).toBe('partial');
});

it('requires the whole qualified clause and keeps its answer specific to that clause', () => {
  const withDeadline = { requirements: [row('Resident in Geneva, Switzerland or willing to relocate within 30 days.')] };
  const first = guardMobilityMatch(requirements, match, context);
  const question = first.questions[0];
  const memory = rememberCandidateQuestionAnswers({ questions: [question], answers: { [question.id]: 'Sì' } });
  expect(guardMobilityMatch(requirements, match, { ...context, memory }).matches[0].status).toBe('met');
  expect(conciergeProposalEligibility(requirements, guardMobilityMatch(requirements, { ...match, verdict: 'weak' }, { ...context, memory }), context).status).toBe('compatible');
  const qualified = guardMobilityMatch(withDeadline, match, { ...context, memory, profile: { location: 'Examplecity, Switzerland' }, sourceText: 'Examplecity, Switzerland' });
  expect(qualified.matches[0].status).toBe('partial');
  expect(qualified.questions[0].id).not.toBe(question.id);
  expect(qualified.questions[0].applicationQuestion).toContain('30 days');
  const negative = guardMobilityMatch(requirements, match, { ...context, answers: { [question.id]: false } });
  expect(conciergeProposalEligibility(requirements, negative, context).status).toBe('incompatible');
});


it('never truncates required facts when adding rule-derived questions', () => {
  const hard = Array.from({ length: 8 }, (_, i) => ({ id: `hard_${i}`, question: `Required answer ${i}`, type: 'text', required: true }));
  const questions = ensureRequiredQuestions(hard, { requirements: { salaryRequested: true }, profile: {}, locale: 'it' });
  expect(questions).toHaveLength(9);
  expect(questions.some(q => q.id === 'salary_expectation' && q.required)).toBe(true);
  expect(hard.every(q => questions.some(result => result.id === q.id))).toBe(true);
});
