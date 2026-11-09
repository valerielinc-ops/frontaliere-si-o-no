import { createHash } from 'node:crypto';
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

it('declares the candidate willing to relocate in both funnels, never asking (owner decision 2026-11-09)', () => {
  const guarded = guardMobilityMatch(requirements, match, context);
  // The platform's declaration, not the permit G of the CV, meets the requirement.
  expect(guarded.matches[0]).toMatchObject({ status: 'met' });
  expect(guarded.matches[0].evidence).not.toContain('Permit G');
  expect(conciergeProposalEligibility(requirements, guarded, context).status).not.toBe('clarification_required');
  expect(fitNoticeOf({ requirements: requirements.requirements, matches: guarded.matches, verdict: guarded.verdict })?.gaps ?? []).toHaveLength(0);
  expect(guarded.questions).toHaveLength(0);
  expect(context.profile).toEqual({ location: 'Exampletown, Italy', workPermit: 'Permit G' });
});

it('keeps the candidate’s own «no» to relocating', () => {
  // The question id guardMobilityMatch derives from the whole clause (lib/mobilityRequirements.js questionFor).
  const folded = quote.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const id = `mobility_requirement_${createHash('sha256').update(folded).digest('hex').slice(0, 32)}`;
  const declined = guardMobilityMatch(requirements, match, { ...context, answers: { [id]: 'No' } });
  expect(declined.matches[0]).toMatchObject({ status: 'missing' });
  expect(declined.verdict).toBe('poor');
});

it.each([
  'Residenza in Svizzera o disponibilità al trasferimento.',
  'Wohnsitz in der Schweiz oder Bereitschaft zum Umzug.',
  'Résidence en Suisse ou volonté de déménager.',
  quote,
])('keeps the condition separate from authorization: %s', clause => {
  expect(swissMobilityRequirement(row(clause))).not.toBeNull();
  expect(guardMobilityMatch({ requirements: [row(clause)] }, match, context).matches[0].status).toBe('met');
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
  // The relocation alternative is met by the platform's declaration, never by the unrelated CV line.
  expect(result.matches[0]).toMatchObject({ status: 'met', evidence: 'Disponibile al trasferimento (dichiarato dalla piattaforma)' });
});

it('keeps a candidate answer specific to its whole clause', () => {
  const folded = (clause: string) => clause.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const idOf = (clause: string) => `mobility_requirement_${createHash('sha256').update(folded(clause)).digest('hex').slice(0, 32)}`;
  const question = { id: idOf(quote), question: 'Puoi soddisfare tutte le condizioni di residenza o trasferimento riportate qui?', applicationQuestion: quote, context: quote, type: 'yes_no' };
  const memory = rememberCandidateQuestionAnswers({ questions: [question], answers: { [question.id]: 'No' } });
  expect(guardMobilityMatch(requirements, match, { ...context, memory }).matches[0].status).toBe('missing');
  // A residence-only clause is a fact, not a willingness: it stays the candidate's question, with its own id.
  const residenceOnly = { requirements: [row('Must currently reside in Geneva, Switzerland.')] };
  const qualified = guardMobilityMatch(residenceOnly, match, { ...context, memory });
  expect(qualified.matches[0].status).toBe('partial');
  expect(qualified.questions[0].id).not.toBe(question.id);
  expect(qualified.questions[0].applicationQuestion).toContain('Geneva');
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


it.each([
  ['Must reside in Switzerland.', 'partial'],
  ['Currently residing in Switzerland.', 'partial'],
  ['Willing to move to Switzerland.', 'met'],
  ['Ready for moving to Switzerland.', 'met'],
  ['Deve risiedere in Svizzera.', 'partial'],
  ['Vous devez résider en Suisse.', 'partial'],
  ['Sie müssen in der Schweiz wohnen.', 'partial'],
])('guards ordinary residence and relocation verb forms: %s', (clause, status) => {
  expect(swissMobilityRequirement(row(clause))).not.toBeNull();
  expect(guardMobilityMatch({ requirements: [row(clause)] }, match, context).matches[0].status).toBe(status);
});

it.each([
  'Valid Swiss work permit and currently live in Switzerland.',
  'Permesso di lavoro svizzero e residenza in Svizzera.',
  'Permis de travail suisse et résidence en Suisse.',
  'Arbeitsbewilligung und Wohnsitz in der Schweiz.',
])('keeps independently required residence in a mixed legal clause: %s', clause => {
  const reqs = { requirements: [row(clause)] };
  const residenceOnly = { profile: { location: 'Examplecity, Switzerland' }, sourceText: 'Examplecity, Switzerland' };
  const guarded = guardMobilityMatch(reqs, match, residenceOnly);
  expect(guarded.matches[0].status).toBe('partial');
  const question = guarded.questions[0];
  expect(question.applicationQuestion).toBe(clause);
  expect(guardMobilityMatch(reqs, match, { ...context, answers: { [question.id]: 'yes' } }).matches[0].status).toBe('met');
});

it.each([
  'Swiss citizenship or currently reside in Switzerland.',
  'Permis de travail suisse ou résidence en Suisse.',
  'Swiss work permit and currently live in Italy.',
  'Permis de séjour suisse requis.',
  'Swiss residence permit or EU citizenship required.',
])('preserves legal alternatives and does not borrow a permit country: %s', clause => {
  expect(swissMobilityRequirement(row(clause))).toBeNull();
});
