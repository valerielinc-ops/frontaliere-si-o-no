/**
 * The decision engine of the assisted application (owner mandate 2026-11-10: the candidate pays for an
 * automation that applies on their behalf, not to answer new questions every time).
 *
 * Deterministic rules first (assistedApplicationPlatformDefaults.js): business travel is always yes, and the
 * visibility of the profile inside the employer takes the broadest internal audience (Stadt Zürich, order
 * fUHc8nmN). Then the model decides what nothing else covers, by the owner's principles, and the code checks
 * every decision; only the CANDIDATE_ONLY_CATEGORIES stay with the candidate. All CVs here are invented.
 */
import { describe, expect, it } from 'vitest';
import { platformDefaultAnswer, platformQuestionTopic } from '../functions/src/assistedApplicationPlatformDefaults.js';
import {
  CANDIDATE_ONLY_CATEGORIES,
  DECISION_PRINCIPLES,
  candidateOnlyCategory,
  decisionAnswerFor,
  decisionsSystemPrompt,
  verifiedDecisionAnswers,
  verifyDecision,
} from '../functions/src/assistedApplicationDecisionAnswers.js';
import { isOperationalDefaultValue, operationalDefaultAnswer, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { buildReviewPayload } from '../functions/src/assistedApplicationReview.js';
import { decideLiveQuestions, draftDecisionAnswers } from '../scripts/assisted-application/lib/decision-answers.mjs';
import { candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';

const CV = [
  'Candidata Prova — Impiegata di commercio',
  'Esperienza',
  '2018 – 2024 Impiegata di commercio, Gamma Servizi SA, Lugano',
  'Accoglienza dei clienti allo sportello e al telefono, gestione della corrispondenza e degli appuntamenti.',
  'Formazione: Attestato federale di capacità impiegata di commercio',
  'Lingue: italiano, tedesco, inglese',
].join('\n');
const order = { locale: 'it', applicantName: 'Candidata Prova', userId: 'u-test', companyName: 'Stadt Zürich' };
const draftOf = (questions: object[]) => ({
  verdict: 'good', job: { source: 'job_detail' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] },
  factSources: { text: CV }, questions, language: 'de',
});

// The question of order fUHc8nmN as the draft stores it: the portal read the first option as its label, the
// prompt is in the context.
const DE_ALL = 'Alle Recruiter*innen der Stadt Zürich (mehrere Hundert Personen in allen Organisationseinheiten; erforderlich, damit Ihre Bewerbung stadtintern weitergeleitet werden kann)';
const DE_ONLY = 'Nur Recruiter*innen, welche die Stellen betreuen, auf die ich mich bewerbe';
const IT_ALL = "Tutti/e i/le recruiter di Stadt Zürich (diverse centinaia di persone in tutte le unità organizzative; necessario affinché la Sua candidatura possa essere inoltrata internamente all'amministrazione cittadina)";
const IT_ONLY = 'Solo i/le recruiter che gestiscono le posizioni per le quali mi candido';
const visibility = {
  id: 'portal_alle_recruiter_innen_der_stadt_zurich', source: 'portal', type: 'choice', required: true,
  question: IT_ALL, applicationQuestion: DE_ALL, options: [IT_ALL, IT_ONLY], applicationOptions: [DE_ALL, DE_ONLY],
  optionMap: [{ candidate: IT_ALL, application: DE_ALL }, { candidate: IT_ONLY, application: DE_ONLY }],
  context: `Eigenes Profil sichtbar machen für:* · ${DE_ALL} · Nur Recruiter*innen, welche`,
  section: 'Karrierechancen: Konto anlegen',
  addressContext: { section: 'Karrierechancen: Konto anlegen', owners: ['Eigenes Profil sichtbar machen für:*', 'Karrierechancen:Konto anlegen'], unknown: false },
  applicationQuestionLocale: 'de',
};
// The same control read live by the runner.
const liveVisibility = {
  label: DE_ALL, kind: 'radio', required: true, context: visibility.context, section: visibility.section,
  options: [{ label: DE_ALL, value: '1' }, { label: DE_ONLY, value: '2' }],
};
const travel = {
  id: 'travel_availability', source: 'match', type: 'yes_no', required: true, options: [],
  question: 'Are you fully available for national and international business travel?',
};

describe('profile visibility inside the employer (Stadt Zürich, order fUHc8nmN)', () => {
  it('chooses all the recruiters of the employer, in the candidate\'s and in the portal\'s language', () => {
    expect(platformQuestionTopic(visibility)).toBe('profile_visibility');
    expect(platformDefaultAnswer(visibility, null, { locale: 'it' })).toMatchObject({ value: IT_ALL, topic: 'platform:profile_visibility', source: 'policy_default' });
    expect(platformDefaultAnswer({ ...visibility, options: [IT_ONLY, IT_ALL], applicationOptions: [DE_ONLY, DE_ALL] }, null, { locale: 'it' })?.value).toBe(IT_ALL);
    expect(platformDefaultAnswer(liveVisibility, null, { locale: 'de' })?.value).toBe(DE_ALL);
    expect(isOperationalDefaultValue(liveVisibility, DE_ALL)).toBe(true);
    expect(isOperationalDefaultValue(liveVisibility, DE_ONLY)).toBe(false);
  });

  it('no longer holds the application, and the planner fills the live control', () => {
    const draft = draftOf([visibility]);
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
    const { platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    expect(candidateAnswerForField({ platformFacts, answers: {}, profile: {}, identity: {} }, liveVisibility)).toMatchObject({ value: DE_ALL, source: 'policy_default' });
  });

  it('a yes/no on forwarding inside the employer is yes', () => {
    expect(platformDefaultAnswer({ question: 'Dürfen wir Ihre Bewerbung stadtintern an andere Stellen weiterleiten?', type: 'yes_no', options: ['Ja', 'Nein'] }, null, { locale: 'de' })?.value).toBe('Ja');
    expect(platformDefaultAnswer({ question: 'Rendere visibile il mio profilo ai recruiter di tutte le unità organizzative?', type: 'checkbox' }, null, { locale: 'it' })?.value).toBe('true');
  });

  it('never opens the profile beyond the employer, nor joins a talent pool', () => {
    // Third parties, the public, a group: not this rule.
    expect(platformQuestionTopic({ question: 'Profil sichtbar machen für Personalvermittler und Partnerfirmen?', type: 'yes_no', options: ['Ja', 'Nein'] })).toBeNull();
    // A broad option that reaches outside the employer is never the chosen one.
    expect(platformDefaultAnswer({ ...liveVisibility, options: [{ label: 'Alle Recruiter*innen und externe Personalvermittler', value: '1' }, { label: 'Recruiter*innen der Stadt Zürich', value: '2' }] }, null, { locale: 'de' })?.value)
      .toBe('Recruiter*innen der Stadt Zürich');
    // Being informed of other positions is a job alert, not a visibility: no rule, and the engine never says yes.
    const alert = { id: 'alert', source: 'portal', type: 'yes_no', required: true, question: 'Möchten Sie über weitere offene Stellen der Stadt Zürich informiert werden?' };
    expect(platformQuestionTopic(alert)).toBeNull();
    expect(verifyDecision({ decision: 'answer', value: 'yes', principle: 'application_success', reason: '' }, { question: alert, cvText: CV }).reasons).toContain('consent_beyond_employer');
    expect(verifyDecision({ decision: 'answer', value: 'no', principle: 'same_employer_consent', reason: '' }, { question: alert, cvText: CV }).ok).toBe(true);
    // A talent pool is marketing: declined.
    expect(platformDefaultAnswer({ question: 'Möchten Sie in unseren Talentpool aufgenommen werden, damit Recruiter Sie für weitere Stellen kontaktieren?', type: 'yes_no', options: ['Ja', 'Nein'] }, null, { locale: 'de' }))
      .toMatchObject({ value: 'Nein', topic: 'platform:marketing_opt_in' });
  });
});

describe('business travel (order rg82P9MP)', () => {
  it('is always available, like relocation and on-call duty', () => {
    expect(platformDefaultAnswer(travel, null, { locale: 'it' })).toMatchObject({ value: 'Sì', topic: 'platform:business_travel' });
    expect(platformDefaultAnswer({ question: 'Sind Sie bereit, gelegentlich Dienstreisen zu unternehmen?', type: 'yes_no', options: ['Ja', 'Nein'] }, null, { locale: 'de' })?.value).toBe('Ja');
    expect(platformDefaultAnswer({ question: 'Êtes-vous disponible pour des déplacements professionnels ?', type: 'yes_no' }, null, { locale: 'fr' })?.value).toBe('Oui');
    const draft = draftOf([travel]);
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
  });

  it('is not a question on travel costs or on how often', () => {
    expect(platformQuestionTopic({ question: 'Are you available for business travel? Who covers the travel costs?', type: 'text' })).toBeNull();
    expect(platformQuestionTopic({ question: 'How often are you available to travel?', type: 'choice', options: ['Rarely', 'Monthly', 'Weekly'] })).toBeNull();
  });
});

describe('what stays with the candidate', () => {
  it('lists the excluded categories in code', () => {
    expect(CANDIDATE_ONLY_CATEGORIES.map((item) => item.id)).toEqual(['candidate_document', 'identity_number', 'legal_declaration', 'sensitive_data']);
    expect(DECISION_PRINCIPLES.map((item) => item.id)).toEqual(['cv_fact', 'platform_rule', 'application_success', 'same_employer_consent', 'plausible_deduction']);
    const prompt = decisionsSystemPrompt();
    for (const item of [...CANDIDATE_ONLY_CATEGORIES, ...DECISION_PRINCIPLES]) expect(prompt).toContain(item.id);
  });

  it.each([
    ['Bitte laden Sie Ihre Arbeitszeugnisse hoch', 'candidate_document'],
    ['Puoi fornire un estratto del casellario giudiziale?', 'candidate_document'],
    ['Do you hold a valid driving licence?', 'candidate_document'],
    ['Please name two references', 'candidate_document'],
    ['AHV-Nummer', 'identity_number'],
    ['Numéro AVS', 'identity_number'],
    ['Numero del passaporto', 'identity_number'],
    ['Ausweisnummer', 'identity_number'],
    ['Wurden Sie in den letzten 10 Jahren strafrechtlich verurteilt?', 'legal_declaration'],
    ['Have you ever been convicted of a criminal offence?', 'legal_declaration'],
    ['Laufen gegen Sie Betreibungen?', 'legal_declaration'],
    ['Haben Sie gesundheitliche Einschränkungen?', 'sensitive_data'],
    ['Are there health reasons that limit your work?', 'sensitive_data'],
    ['Religione', 'sensitive_data'],
    ['Are you a member of a trade union?', 'sensitive_data'],
  ])('«%s» → %s', (question, category) => {
    expect(candidateOnlyCategory({ question })).toBe(category);
    const field = { id: 'q', source: 'portal', type: 'yes_no', required: true, question };
    // Whatever the model says.
    expect(verifyDecision({ decision: 'answer', value: 'yes', principle: 'application_success', reason: 'x' }, { question: field, cvText: CV }).reasons)
      .toContain(`candidate_only:${category}`);
  });

  it('decides an ordinary question that only looks alike', () => {
    for (const question of ['Haben Sie Erfahrung im Kundenkontakt?', 'Sind Sie bereit, im Schichtbetrieb zu arbeiten?', 'Sind Sie bereits bei der Stadt Zürich angestellt?']) {
      expect(candidateOnlyCategory({ question })).toBeNull();
    }
  });
});

describe('the deterministic checks of a decision', () => {
  const shifts = { id: 'shifts', source: 'portal', type: 'choice', required: true, question: 'Sei disponibile a lavorare a turni?', applicationQuestion: 'Sind Sie bereit, im Schichtbetrieb zu arbeiten?', options: ['Sì', 'No'], applicationOptions: ['Ja', 'Nein'] };

  it('maps a choice to the option shown and to the portal\'s own', () => {
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'application_success', reason: 'availability' }, { question: shifts, cvText: CV }))
      .toMatchObject({ ok: true, shape: 'choice', value: 'Sì', applicationValue: 'Ja' });
    expect(verifyDecision({ decision: 'answer', value: 'Vielleicht', principle: 'application_success', reason: '' }, { question: shifts, cvText: CV }).reasons).toContain('not_an_option');
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'gut_feeling', reason: '' }, { question: shifts, cvText: CV }).reasons).toContain('principle_unknown');
  });

  it('never says yes to marketing or to third parties (principle 4, in code)', () => {
    const partners = { id: 'partners', source: 'portal', type: 'yes_no', required: true, question: 'May we share your profile with our partner companies?' };
    expect(verifyDecision({ decision: 'answer', value: 'yes', principle: 'same_employer_consent', reason: '' }, { question: partners, cvText: CV }).reasons).toContain('consent_beyond_employer');
    expect(verifyDecision({ decision: 'answer', value: 'no', principle: 'same_employer_consent', reason: '' }, { question: partners, cvText: CV }).ok).toBe(true);
    const pool = { id: 'pool', source: 'portal', type: 'choice', required: true, question: 'Talent community', options: ['Yes, add me to the talent pool', 'No, thank you'] };
    expect(verifyDecision({ decision: 'answer', value: 'Yes, add me to the talent pool', principle: 'application_success', reason: '' }, { question: pool, cvText: CV }).reasons).toContain('consent_beyond_employer');
    expect(verifyDecision({ decision: 'answer', value: 'No, thank you', principle: 'same_employer_consent', reason: '' }, { question: pool, cvText: CV }).ok).toBe(true);
  });

  it('keeps a text answer within the CV, and needs the CV to check it', () => {
    const motivation = { id: 'sector', source: 'match', type: 'text', required: true, question: 'In quale settore hai lavorato finora?' };
    expect(verifyDecision({ decision: 'answer', value: 'Nei servizi, a contatto con i clienti allo sportello.', principle: 'cv_fact', reason: '' }, { question: motivation, cvText: CV }).ok).toBe(true);
    expect(verifyDecision({ decision: 'answer', value: 'Presso Contoso SA, dal 2015.', principle: 'cv_fact', reason: '' }, { question: motivation, cvText: CV }).reasons)
      .toEqual(expect.arrayContaining(['invented_number', 'invented_name']));
    expect(verifyDecision({ decision: 'answer', value: 'Nei servizi.', principle: 'cv_fact', reason: '' }, { question: motivation, cvText: '' }).reasons).toContain('text_needs_cv');
  });
});

describe('the engine at draft time', () => {
  const shifts = { id: 'shifts', source: 'portal', type: 'choice', required: true, question: 'Sei disponibile a lavorare a turni?', applicationQuestion: 'Sind Sie bereit, im Schichtbetrieb zu arbeiten?', options: ['Sì', 'No'], applicationOptions: ['Ja', 'Nein'], applicationQuestionLocale: 'de' };
  const employee = { id: 'already_employee', source: 'portal', type: 'yes_no', required: true, question: 'Sei già dipendente della Città di Zurigo?', applicationQuestion: 'Sind Sie bereits bei der Stadt Zürich angestellt?' };
  const ahv = { id: 'ahv', source: 'portal', type: 'text', required: true, question: 'Numero AVS', applicationQuestion: 'AHV-Nummer' };
  const health = { id: 'health', source: 'portal', type: 'yes_no', required: true, question: 'Haben Sie gesundheitliche Einschränkungen?' };
  const marketing = { id: 'newsletter', source: 'portal', type: 'yes_no', required: true, question: 'Desideri ricevere la nostra newsletter?' };

  it('decides what no rule covers in one call, leaves only the excluded categories, and never holds the application', async () => {
    const requests: Array<{ prompt: string, schema: { properties: { decisions: { items: { properties: { id: { enum: string[] } } } } } } }> = [];
    const codex = async (request: typeof requests[number]) => {
      requests.push(request);
      return { decisions: [
        { id: shifts.id, decision: 'answer', value: 'Ja', principle: 'application_success', category: '', reason: 'Availability raises the chances.' },
        { id: employee.id, decision: 'answer', value: 'no', principle: 'plausible_deduction', category: '', reason: 'The CV shows another employer.' },
      ] };
    };
    const questions = [visibility, travel, shifts, employee, ahv, health, marketing];
    const result = await draftDecisionAnswers({ questions, cvText: CV, codex, employer: 'Stadt Zürich', jobTitle: 'Sachbearbeiterin', facts: candidateWithEdits({ order, draft: draftOf([]), flow: {} }).platformFacts });
    expect(requests).toHaveLength(1);
    // Rules answered visibility, travel and the newsletter; AHV and health never reach the model.
    expect(requests[0].schema.properties.decisions.items.properties.id.enum).toEqual([shifts.id, employee.id]);
    expect(requests[0].prompt).not.toContain('"id":"ahv"');
    expect(requests[0].prompt).not.toContain('AHV-Nummer');
    expect(result.kept).toEqual([shifts.id, employee.id]);
    const draft = draftOf(result.questions);
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([ahv.id, health.id]);

    const { answers, profile, platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    // Form-only: never in the answers or the profile the letter and the CV are written from.
    expect(answers[shifts.id]).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain('Schicht');
    expect(platformFacts.decisionAnswers[shifts.id]).toMatchObject({ value: 'Sì', applicationValue: 'Ja', principle: 'application_success' });
    const { defaults } = withOperationalQuestionAnswers(draft.questions, answers, { facts: platformFacts });
    expect(defaults[shifts.id]).toMatchObject({ value: 'Sì', source: 'policy_default', origin: 'platform_decision' });
    expect(defaults[employee.id]).toMatchObject({ value: 'No', topic: 'decision:plausible_deduction' });

    // The review page shows them as editable platform proposals, with the principle.
    const payload = buildReviewPayload({ order, flow: { state: 'candidate_review', round: 1 }, draft, round: 1, coverLetterUrl: null });
    const shown = payload.questions.find((item: { id: string }) => item.id === shifts.id);
    expect(shown).toMatchObject({ answeredByPlatform: true, answerDecisionPrinciple: 'application_success' });
    expect(payload.answers[shifts.id]).toBe('Sì');
  });

  it('drops a decision that no longer passes on read, and one the model left', async () => {
    const codex = async () => ({ decisions: [
      { id: shifts.id, decision: 'candidate', value: '', principle: '', category: '', reason: '' },
      { id: employee.id, decision: 'answer', value: 'forse', principle: 'plausible_deduction', category: '', reason: '' },
    ] });
    const result = await draftDecisionAnswers({ questions: [shifts, employee], cvText: CV, codex });
    expect(result.kept).toEqual([]);
    expect(result.decisions).toEqual([
      expect.objectContaining({ id: shifts.id, kept: false, reasons: expect.arrayContaining(['left_to_candidate']) }),
      expect.objectContaining({ id: employee.id, kept: false, reasons: expect.arrayContaining(['not_yes_or_no']) }),
    ]);
    // A stored decision tampered into a marketing yes is not projected.
    const tampered = { ...marketing, platformDecision: { decision: 'answer', value: 'yes', principle: 'application_success', reason: '' } };
    expect(verifiedDecisionAnswers([tampered], CV)).toEqual({});
  });

  it('keeps the draft unchanged when the model fails', async () => {
    const codex = async () => { throw new Error('broker down'); };
    const result = await draftDecisionAnswers({ questions: [shifts], cvText: CV, codex });
    expect(result).toMatchObject({ asked: [], kept: [] });
    expect(result.questions[0]).toBe(shifts);
  });
});

describe('the engine in the run, before asking the candidate', () => {
  it('decides the live required controls, which the planner then fills by their label', async () => {
    const shiftsLive = { id: 'portal_shift', question: 'Sei disponibile a lavorare a turni?', applicationQuestion: 'Sind Sie bereit, im Schichtbetrieb zu arbeiten?', type: 'choice', options: ['Sì', 'No'], applicationOptions: ['Ja', 'Nein'] };
    const ahvLive = { id: 'portal_ahv', question: 'Numero AVS', applicationQuestion: 'AHV-Nummer', type: 'text' };
    const textLive = { id: 'portal_text', question: 'Perché questa posizione?', applicationQuestion: 'Warum diese Stelle?', type: 'text' };
    const prompts: string[] = [];
    const codex = async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { decisions: [{ id: shiftsLive.id, decision: 'answer', value: 'Ja', principle: 'application_success', category: '', reason: 'Availability.' }] };
    };
    const { platformFacts } = candidateWithEdits({ order, draft: draftOf([]), flow: {} });
    const candidate = { platformFacts, profile: { headline: 'Impiegata di commercio', experience: [{ role: 'Impiegata', employer: 'Gamma Servizi SA' }] }, job: { company: 'Stadt Zürich', title: 'Sachbearbeiterin' }, identity: { email: 'x@example.test' } };
    const engine = await decideLiveQuestions({ questions: [shiftsLive, ahvLive, textLive], candidate, codex });
    // Free text needs the CV's text to be checked: not in the run. AHV stays with the candidate.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('portal_shift');
    expect(prompts[0]).not.toContain('portal_ahv');
    expect(prompts[0]).not.toContain('portal_text');
    expect(prompts[0]).not.toContain('x@example.test');
    expect(engine.ids).toEqual([shiftsLive.id]);
    const facts = { ...platformFacts, decisionAnswers: engine.decided };
    const field = { label: 'Sind Sie bereit, im Schichtbetrieb zu arbeiten? *', kind: 'radio', required: true, options: [{ label: 'Ja', value: 'Y' }, { label: 'Nein', value: 'N' }] };
    expect(operationalDefaultAnswer(field, { facts })).toMatchObject({ value: 'Ja', origin: 'platform_decision' });
    expect(candidateAnswerForField({ platformFacts: facts, answers: {}, profile: {}, identity: {} }, field)).toMatchObject({ value: 'Ja', source: 'policy_default' });
    expect(isOperationalDefaultValue(field, 'Ja', { facts })).toBe(true);
    // Another control with another label is not answered by it.
    expect(decisionAnswerFor({ label: 'Arbeiten Sie gerne im Team?', kind: 'radio', options: [{ label: 'Ja', value: 'Y' }, { label: 'Nein', value: 'N' }] }, facts)).toBeNull();
  });

  it('does nothing without the model or the platform facts', async () => {
    const question = { id: 'q', question: 'Sind Sie bereit, im Schichtbetrieb zu arbeiten?', type: 'yes_no' };
    expect(await decideLiveQuestions({ questions: [question], candidate: { platformFacts: {} }, codex: null })).toMatchObject({ ids: [] });
    expect(await decideLiveQuestions({ questions: [question], candidate: {}, codex: async () => ({ decisions: [] }) })).toMatchObject({ ids: [] });
  });

});
