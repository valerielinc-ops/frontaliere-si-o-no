/**
 * Experience questions and legal facts (owner mandate 2026-11-10: «fix strutturali, non voglio più vedere
 * candidature bloccate»; «l'utente paga per questa automazione, non per rispondere sempre a nuove domande»).
 *
 * SBB ifB89NW2 (run 42840691944): sign-in and form passed, then the run asked the candidate three questions of
 * the portal. The two on experience are now decided by the engine (yes on the CV's evidence, else the plausible
 * deduction; never a yes to a certification the CV lacks), in the run too. The one on the criminal record and
 * the debt-enforcement register is answered from the candidate's own answers at CV upload; an order uploaded
 * before has none, and only that question stays with the candidate. The CV here is invented.
 */
import { describe, expect, it } from 'vitest';
import {
  platformCandidateFacts,
  platformDefaultAnswer,
  platformQuestionTopic,
  sanitizeCandidateFacts,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import {
  DECISIONS_SCHEMA,
  candidateOnlyCategory,
  decisionsSystemPrompt,
  experienceQuestionKind,
  verifiedDecisionAnswers,
  verifyDecision,
} from '../functions/src/assistedApplicationDecisionAnswers.js';
import { decideLiveQuestions, decisionAnswerable } from '../scripts/assisted-application/lib/decision-answers.mjs';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

const CV = [
  'Candidato Prova — Product Owner',
  '2019 – 2025 Product Owner, Beta Logistica SA, Bellinzona',
  'Gestione del backlog per la piattaforma clienti; coordinamento con i team di sviluppo.',
  'Betrieb von PostgreSQL-Datenbanken und Kubernetes-Clustern in der Public Cloud (Azure).',
  'Competenze: Scrum, Jira, SQL',
].join('\n');

// The three questions of SBB ifB89NW2, as the portal shows them (no personal data).
const RECORD = '* Hast du einen Eintrag im Strafregister oder im Betreibungsregister?';
const PLATFORMS = '* Hast du Erfahrungen mit Datenbanken, Managed OS, Container-Plattformen und Public Cloud Services?';
const SAFE = '* Hast du SAFe Product Owner und Product Manager Erfahrung?';
const live = (id: string, applicationQuestion: string) => ({
  id, applicationQuestion, question: applicationQuestion, type: 'choice', options: ['Ja', 'Nein'], applicationOptions: ['Ja', 'Nein'],
});
const field = (label: string) => ({ label, kind: 'radio', required: true, options: [{ label: 'Nein', value: 'N' }, { label: 'Ja', value: 'Y' }] });

const factsOf = (candidateFacts: object | null) => platformCandidateFacts({
  order: { userId: 'u-test', ...(candidateFacts ? { candidateFacts } : {}) },
  profile: { experience: [{ role: 'Product Owner', employer: 'Beta Logistica SA' }] },
  identity: { name: 'Candidato Prova' },
});
const UPLOAD = { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' };

describe('experience and skill questions (SBB ifB89NW2)', () => {
  it('reads the two real questions as experience, which the engine decides', () => {
    for (const label of [PLATFORMS, SAFE]) {
      const question = { ...live('q', label), source: 'portal' };
      expect(experienceQuestionKind(question)).toBe('experience');
      expect(candidateOnlyCategory(question)).toBeNull();
      expect(decisionAnswerable(question, { facts: factsOf(UPLOAD) })).toBe(true);
    }
  });

  it('says yes on the CV\'s evidence, verbatim and pertinent, and keeps it', () => {
    const question = { ...live('platforms', PLATFORMS), source: 'portal' };
    const quote = 'Betrieb von PostgreSQL-Datenbanken und Kubernetes-Clustern in der Public Cloud (Azure).';
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'cv_fact', evidence: [quote], reason: 'The CV shows it.' }, { question, cvText: CV }))
      .toMatchObject({ ok: true, value: 'Ja', principle: 'cv_fact', evidence: [quote] });
    // A word found only inside another word of the CV is no quote of it: «SQL» in «NoSQL» (review of #17997).
    const sql = { ...live('sql', 'Do you have experience with SQL?'), source: 'portal' };
    const sqlDecision = verifyDecision({ decision: 'answer', value: 'Ja', principle: 'cv_fact', evidence: ['SQL'], reason: '' }, { question: sql, cvText: 'Datenhaltung mit NoSQL-Stores.' });
    expect(sqlDecision.principle).not.toBe('cv_fact');
    expect(sqlDecision.evidence || []).toEqual([]);
    // A quote the CV does not hold, or one that names nothing asked, is no evidence: the yes is a deduction.
    for (const evidence of [['Betrieb von Oracle-Datenbanken in der Public Cloud.'], ['Gestione del backlog per la piattaforma clienti']]) {
      expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'cv_fact', evidence, reason: '' }, { question, cvText: CV }))
        .toMatchObject({ ok: true, value: 'Ja', principle: 'plausible_deduction', evidence: [] });
    }
  });

  it('with nothing in the CV, takes the plausible deduction that maximizes the application', () => {
    const question = { ...live('safe', SAFE), source: 'portal' };
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'plausible_deduction', evidence: [], reason: 'A product owner role.' }, { question, cvText: CV }))
      .toMatchObject({ ok: true, value: 'Ja', principle: 'plausible_deduction' });
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'application_success', evidence: [], reason: '' }, { question, cvText: '' }).ok).toBe(true);
  });

  it('never says yes to a certification the CV does not name: no to the certificate, and yes on the CV\'s', () => {
    const certified = { id: 'cert', source: 'portal', type: 'choice', question: 'Sei certificato SAFe?', applicationQuestion: 'Bist du SAFe-zertifiziert?', options: ['Sì', 'No'], applicationOptions: ['Ja', 'Nein'] };
    expect(experienceQuestionKind(certified)).toBe('certification');
    // Whether the CV holds a qualification is no document only the candidate can hand over.
    expect(candidateOnlyCategory(certified)).toBeNull();
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'plausible_deduction', evidence: [], reason: '' }, { question: certified, cvText: CV }))
      .toMatchObject({ ok: true, value: 'No', applicationValue: 'Nein', principle: 'cv_fact' });
    const pmp = { id: 'pmp', source: 'portal', type: 'yes_no', question: 'Are you PMP certified?' };
    expect(verifyDecision({ decision: 'answer', value: 'yes', principle: 'application_success', evidence: ['Scrum, Jira, SQL'], reason: '' }, { question: pmp, cvText: CV }))
      .toMatchObject({ ok: true, value: 'no', principle: 'cv_fact' });
    const withCertificate = `${CV}\nCertified SAFe 6 Product Owner / Product Manager (POPM)`;
    expect(verifyDecision({ decision: 'answer', value: 'Ja', principle: 'cv_fact', evidence: ['Certified SAFe 6 Product Owner / Product Manager (POPM)'], reason: '' }, { question: certified, cvText: withCertificate }))
      .toMatchObject({ ok: true, value: 'Sì', applicationValue: 'Ja', principle: 'cv_fact' });
    // A certificate «or equivalent experience»: a yes does not claim the certificate.
    const either = { id: 'either', source: 'portal', type: 'yes_no', question: 'Hast du eine SAFe-Zertifizierung oder vergleichbare Erfahrung?' };
    expect(experienceQuestionKind(either)).toBe('experience');
    expect(verifyDecision({ decision: 'answer', value: 'yes', principle: 'plausible_deduction', evidence: [], reason: '' }, { question: either, cvText: CV }))
      .toMatchObject({ ok: true, value: 'yes' });
    // A role named «Master» is no degree.
    expect(experienceQuestionKind({ question: 'Hast du Erfahrung als Scrum Master?' })).toBe('experience');
    expect(experienceQuestionKind({ question: 'Haben Sie einen Master in Informatik?' })).toBe('certification');
  });

  it('still leaves the documents only the candidate can hand over', () => {
    for (const question of ['Bitte laden Sie Ihre Zertifikate hoch', 'Do you hold a valid driving licence?', 'Puoi fornire un estratto del casellario giudiziale?']) {
      expect(candidateOnlyCategory({ id: 'q', source: 'portal', type: 'yes_no', question })).toBe('candidate_document');
    }
  });

  it('a stored decision is checked again on read, with its evidence', () => {
    const quote = 'Betrieb von PostgreSQL-Datenbanken und Kubernetes-Clustern in der Public Cloud (Azure).';
    const question = { ...live('platforms', PLATFORMS), source: 'portal', platformDecision: { decision: 'answer', value: 'Ja', principle: 'cv_fact', evidence: [quote], reason: '' } };
    expect(verifiedDecisionAnswers([question], CV).platforms).toMatchObject({ value: 'Ja', principle: 'cv_fact', evidence: [quote] });
    // The CV changed: the quote no longer stands, the yes stays a deduction.
    expect(verifiedDecisionAnswers([question], 'Candidato Prova — Product Owner').platforms).toMatchObject({ value: 'Ja', principle: 'plausible_deduction' });
    expect(verifiedDecisionAnswers([question], 'Candidato Prova — Product Owner').platforms).not.toHaveProperty('evidence');
  });

  it('tells the model the rule and asks for the evidence', () => {
    const prompt = decisionsSystemPrompt();
    expect(prompt).toContain('Experience and skills');
    expect(prompt).toContain('Never yes to a formal certification');
    expect(DECISIONS_SCHEMA.properties.decisions.items.required).toContain('evidence');
  });
});

describe('the run of SBB ifB89NW2, before asking the candidate', () => {
  const quote = 'Betrieb von PostgreSQL-Datenbanken und Kubernetes-Clustern in der Public Cloud (Azure).';
  const questions = [live('portal_record', RECORD), live('portal_platforms', PLATFORMS), live('portal_safe', SAFE)];
  const candidateWith = (platformFacts: object) => ({
    platformFacts, answers: {}, identity: { email: 'x@example.test' },
    profile: { headline: 'Product Owner', experience: [{ role: 'Product Owner', employer: 'Beta Logistica SA' }] },
    job: { company: 'SBB', title: 'Product Owner' },
  });
  const model = (prompts: string[]) => async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return { decisions: [
      { id: 'portal_platforms', decision: 'answer', value: 'Ja', principle: 'cv_fact', category: '', evidence: [quote], reason: 'The CV shows it.' },
      { id: 'portal_safe', decision: 'answer', value: 'Ja', principle: 'plausible_deduction', category: '', evidence: [], reason: 'A product owner role.' },
    ] };
  };

  it('an order uploaded before the legal facts: the two experience questions are decided, the register is «no»', async () => {
    const platformFacts = factsOf(UPLOAD);
    expect(platformFacts).toMatchObject({ criminalRecord: '', debtRecord: '' });
    const prompts: string[] = [];
    const engine = await decideLiveQuestions({ questions, candidate: candidateWith(platformFacts), codex: model(prompts), cvText: CV });
    expect(engine.ids).toEqual(['portal_platforms', 'portal_safe']);
    // The engine ran on the portal's wording with the CV: the register question never reached it.
    expect(prompts[0]).toContain('Container-Plattformen');
    expect(prompts[0]).toContain('"subject":"experience"');
    expect(prompts[0]).toContain('Kubernetes-Clustern');
    expect(prompts[0]).not.toContain('Strafregister');
    expect(engine.decided.portal_platforms).toMatchObject({ principle: 'cv_fact', evidence: [quote] });
    const facts = { ...platformFacts, decisionAnswers: engine.decided };
    const candidate = candidateWith(facts);
    expect(candidateAnswerForField(candidate, field(PLATFORMS))).toMatchObject({ value: 'Ja', source: 'policy_default' });
    expect(candidateAnswerForField(candidate, field(SAFE))).toMatchObject({ value: 'Ja', source: 'policy_default' });
    // No upload answer: no entry in either register (owner decision 2026-11-11), never asked to the model.
    expect(candidateAnswerForField(candidate, field(RECORD))).toMatchObject({ value: 'Nein', source: 'policy_default' });
  });

  it('a new order: the register question is answered from the upload answers, never decided by the model', async () => {
    const platformFacts = factsOf({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'no' });
    const prompts: string[] = [];
    const engine = await decideLiveQuestions({ questions, candidate: candidateWith(platformFacts), codex: model(prompts), cvText: CV });
    expect(engine.ids).toEqual(['portal_platforms', 'portal_safe']);
    const facts = { ...platformFacts, decisionAnswers: engine.decided };
    expect(candidateAnswerForField(candidateWith(facts), field(RECORD))).toMatchObject({ value: 'Nein', source: 'policy_default' });
  });

  it('the planner fills a knock-out answered by the engine', () => {
    const certificate = 'Bist du SAFe-zertifiziert?';
    const facts = { ...factsOf(UPLOAD), decisionAnswers: {
      cert: { decision: 'answer', shape: 'choice', value: 'Nein', applicationValue: 'Nein', principle: 'cv_fact', reason: '', labels: ['bist du safe zertifiziert'], version: 'decision-answers-v2' },
    } };
    const candidate = candidateWith(facts);
    const knockOut = { id: 'f1', ...field(certificate) };
    const plan = guardPlan([{ fieldId: 'f1', action: 'select', value: 'Nein', source: 'policy_default', evidence: '' }], [knockOut], candidate);
    expect(plan.actions).toEqual([expect.objectContaining({ fieldId: 'f1', value: 'Nein' })]);
    expect(plan.missingRequired).toEqual([]);
  });
});

describe('the criminal record and the debt-enforcement register (owner decision 2026-11-10)', () => {
  const choice = (question: string, options = ['Nein', 'Ja']) => ({ id: 'q', source: 'portal', type: 'choice', question, options });

  it('answers the register questions from the upload answers', () => {
    const none = factsOf({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'no' });
    const debt = factsOf({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'yes' });
    expect(platformQuestionTopic(choice(RECORD))).toBe('criminal_or_debt_record');
    expect(platformDefaultAnswer(choice(RECORD), none)).toMatchObject({ value: 'Nein', topic: 'platform:criminal_or_debt_record', source: 'policy_default' });
    expect(platformDefaultAnswer(choice(RECORD), debt)?.value).toBe('Ja');
    expect(platformDefaultAnswer(choice('Hai iscrizioni nel casellario giudiziale?', ['Sì', 'No']), debt)?.value).toBe('No');
    expect(platformDefaultAnswer(choice('Laufen gegen Sie Betreibungen?'), debt)?.value).toBe('Ja');
    expect(platformDefaultAnswer(choice('Avez-vous des poursuites ou des actes de défaut de biens ?', ['Oui', 'Non']), none)?.value).toBe('Non');
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'yes_no', question: 'Do you have a criminal record?' }, none, { locale: 'en' })?.value).toBe('No');
  });

  it('answers «no» when the fact is unknown or half known, and leaves what is not the register entry', () => {
    // Owner decision 2026-11-11 («Sempre «no» se manca»): no upload answer, no entry in either register.
    const legacy = factsOf(UPLOAD);
    expect(platformDefaultAnswer(choice(RECORD), legacy)?.value).toBe('Nein');
    expect(platformDefaultAnswer(choice(RECORD), factsOf({ ...UPLOAD, criminalRecord: 'no' }))?.value).toBe('Nein');
    const none = factsOf({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'no' });
    for (const question of [
      'Können Sie einen aktuellen Strafregisterauszug vorlegen?',
      'Läuft gegen Sie ein Strafverfahren oder ein Betreibungsverfahren?',
    ]) expect(platformDefaultAnswer(choice(question), none)).toBeNull();
    // A bare caption in a free text field may be the slot of the extract: it stays with the candidate.
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'text', question: 'Strafregister' }, none)).toBeNull();
    // A request for proof is a document, never answered (review of #17997).
    const record = factsOf({ ...UPLOAD, criminalRecord: 'yes', debtRecord: 'no' });
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'yes_no', question: 'Do you have proof of a criminal record?' }, record, { locale: 'en' })).toBeNull();
    expect(platformDefaultAnswer(choice('Können Sie einen Nachweis über Ihren Strafregistereintrag erbringen?'), none)).toBeNull();
  });

  // Owner decision 2026-11-11: the criminal record alone is always «no conviction»; a question that names the
  // debt-enforcement register takes the upload answers, «no» when there are none.
  it('answers the criminal record alone by the platform rule, with its polarity, also on a legacy order', () => {
    const legacy = factsOf(UPLOAD);
    expect(platformDefaultAnswer(choice('Have you ever been convicted of a criminal offence?'), legacy)?.value).toBe('Nein');
    expect(platformDefaultAnswer(choice('Ich bestätige, dass ich keinen Eintrag im Strafregister habe'), legacy)?.value).toBe('Ja');
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'yes_no', question: 'Sind Sie ohne Einträge im Strafregister?' }, legacy, { locale: 'de' })?.value).toBe('Ja');
    // The candidate's own «yes» at upload wins: a register question is yes, and no statement of none is made for them.
    const record = factsOf({ ...UPLOAD, criminalRecord: 'yes', debtRecord: 'no' });
    expect(platformDefaultAnswer({ id: 'q', source: 'portal', type: 'yes_no', question: 'Do you have a criminal record?' }, record, { locale: 'en' })?.value).toBe('Yes');
    expect(platformDefaultAnswer(choice('Ich bestätige, dass ich keinen Eintrag im Strafregister habe'), record)).toBeNull();
    // An entry in the register is a conviction: the upload «yes» answers the conviction question too (review of #18085).
    expect(platformDefaultAnswer(choice('Have you ever been convicted of a criminal offence?'), record)?.value).toBe('Ja');
  });

  it('stores the two answers validated, and keeps the orders that predate them valid', () => {
    expect(sanitizeCandidateFacts({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'yes' }))
      .toEqual({ ...UPLOAD, criminalRecord: 'no', debtRecord: 'yes' });
    expect(sanitizeCandidateFacts(UPLOAD)).toEqual(UPLOAD);
    expect(sanitizeCandidateFacts({ ...UPLOAD, criminalRecord: '', debtRecord: null })).toEqual(UPLOAD);
    expect(sanitizeCandidateFacts({ ...UPLOAD, criminalRecord: 'maybe', debtRecord: 'no' })).toBeNull();
    expect(sanitizeCandidateFacts({ ...UPLOAD, debtRecord: true })).toBeNull();
  });
});
