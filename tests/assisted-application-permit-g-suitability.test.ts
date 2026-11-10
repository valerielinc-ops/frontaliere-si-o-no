/**
 * Three owner decisions of 2026-11-10 on the questions the platform answers without the candidate.
 *
 *  1. Permit G deduced: «la persona lavora in Svizzera, quindi sicuramente ha il permesso G siccome vive in
 *     Italia». With no status stated by the candidate (upload, answer, correction), a CV town in a country
 *     bordering Switzerland and a current or recent employment in Switzerland in the CV give permit G, marked
 *     as deduced. Without a Swiss employment the permit stays unknown; a status the candidate stated wins.
 *  2. Suitability for the position: «Dichiara la propria idoneità alla funzione prevista dal bando?» is always
 *     yes; a fitness of health or of law is not touched.
 *  3. Tools and experience from the CV: «Ha conoscenza dello strumento gestionale RAI?» is decided by the
 *     engine, a description of experience with elderly people is a plausible text from the CV.
 *
 * The questions are the employer's wording (Lugano LIS, order YRpw1QFn); every candidate here is invented.
 */
import { describe, expect, it } from 'vitest';
import {
  deducedCrossBorderPermit,
  isSwissPlace,
  platformCandidateFacts,
  platformDefaultAnswer,
  platformQuestionTopic,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { operationalDefaultAnswer, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateOnlyCategory, experienceQuestionKind, verifyDecision } from '../functions/src/assistedApplicationDecisionAnswers.js';
import { cvAnswerQuestionEligible, cvQuestionKind } from '../functions/src/assistedApplicationCvAnswers.js';
import { PERMIT_STATUSES, permitOptions } from '../functions/src/lib/permitLabels.js';
import { decisionAnswerable } from '../scripts/assisted-application/lib/decision-answers.mjs';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';

const NOW = Date.UTC(2026, 10, 10, 12);
const PERMIT_QUESTION = 'Hai la cittadinanza svizzera o un permesso svizzero valido oggi?';
const permitQuestion = { id: 'work_permit', question: PERMIT_QUESTION, type: 'choice', options: permitOptions('it'), required: true, source: 'match' };
const permitG = permitOptions('it')[PERMIT_STATUSES.indexOf('permit_g')];

const swissJob = { kind: 'job', role: 'Contabile', employer: 'Alfa Servizi SA', location: 'Lugano', start: '03.2021', end: 'oggi' };
const italianJob = { kind: 'job', role: 'Contabile', employer: 'Beta Servizi Srl', location: 'Varese (VA)', start: '2015', end: 'oggi' };

const facts = ({ location = 'Como (CO)', experience = [swissJob], candidateFacts = null as object | null, answers = {}, workPermit = '' } = {}) => platformCandidateFacts({
  order: { userId: 'u-test', ...(candidateFacts ? { candidateFacts } : {}) },
  profile: { location, experience, ...(workPermit ? { workPermit } : {}) },
  identity: { name: 'Candidato Prova' },
  answers,
  nowMs: NOW,
});

describe('permit G deduced from the CV (owner decision 2026-11-10)', () => {
  it('a resident of Italy with a current job in Switzerland holds permit G, marked as deduced', () => {
    const known = facts();
    expect(known.permitStatus).toBe('permit_g');
    expect(known.permitStatusSource).toBe('deduced');
    const answer = platformDefaultAnswer(permitQuestion, known, { locale: 'it' });
    expect(answer).toMatchObject({ topic: 'platform:work_permit', source: 'policy_default', basis: 'deduced' });
    expect(answer?.value).toBe(permitG);
    // The yes/no form of the same question.
    const binary = { id: 'permit_yn', question: 'Possiede un permesso di lavoro svizzero valido?', type: 'yes_no', source: 'portal' };
    expect(platformDefaultAnswer(binary, known, { locale: 'it' })?.value).toBe('Sì');
  });

  it('reads the other bordering countries and a job ended within twelve months', () => {
    expect(facts({ location: 'Annemasse, France', experience: [{ ...swissJob, location: 'Genève, Suisse' }] }).permitStatus).toBe('permit_g');
    expect(facts({ location: 'Lörrach, Deutschland', experience: [{ ...swissJob, location: 'Basel, Schweiz', end: '02.2026' }] }).permitStatus).toBe('permit_g');
    expect(facts({ experience: [{ ...swissJob, location: 'Mendrisio (TI)', start: '2023', end: '2025' }] }).permitStatus).toBe('permit_g');
  });

  it('without an employment in Switzerland the permit stays unknown and the question stays open', () => {
    const known = facts({ experience: [italianJob] });
    expect(known.permitStatus).toBe('');
    expect(known.permitStatusSource).toBe('');
    expect(platformDefaultAnswer(permitQuestion, known, { locale: 'it' })).toBeNull();
  });

  it('a Swiss job of long ago, a volunteer post, an undated role or an Italian province «(CH)» deduce nothing', () => {
    expect(facts({ experience: [{ ...swissJob, start: '2016', end: '2019' }] }).permitStatus).toBe('');
    expect(facts({ experience: [{ ...swissJob, kind: 'volunteer' }] }).permitStatus).toBe('');
    expect(facts({ experience: [{ ...swissJob, start: '', end: '' }] }).permitStatus).toBe('');
    expect(facts({ experience: [{ ...swissJob, start: '2014', end: '' }] }).permitStatus).toBe('');
    expect(isSwissPlace('Ortona (CH)')).toBe(false);
    expect(isSwissPlace('Chiasso - Svizzera')).toBe(true);
  });

  it('a resident of Switzerland, or of a country not bordering it, is not a cross-border commuter', () => {
    expect(facts({ location: 'Lugano' }).permitStatus).toBe('');
    expect(deducedCrossBorderPermit({ residenceCountry: 'ES', experience: [swissJob], nowMs: NOW })).toBe('');
    expect(deducedCrossBorderPermit({ residenceCountry: 'IT', experience: [swissJob], nowMs: NOW })).toBe('permit_g');
  });

  it('the status declared at upload always wins, «no permit» included', () => {
    for (const workPermit of ['permit_b', 'permit_c', 'swiss', 'none']) {
      const known = facts({ candidateFacts: { workPermit, passport: 'eu_efta', nationality: 'Italiana' } });
      expect(known.permitStatus).toBe(workPermit);
      expect(known.permitStatusSource).toBe('candidate');
    }
  });

  it("the candidate's own answer, even one that names no status, and a CV naming another permit stop it", () => {
    expect(facts({ answers: { work_permit: 'Non lo so' } }).permitStatus).toBe('');
    expect(facts({ answers: { work_permit: 'Permesso B' } })).toMatchObject({ permitStatus: 'permit_b', permitStatusSource: 'candidate' });
    expect(facts({ workPermit: 'Permesso B' }).permitStatus).toBe('');
  });

  it('through candidateWithEdits: proposed on the form, never written as the candidate answer; a cleared correction wins', () => {
    const order = { userId: 'u-test', applicantName: 'Candidato Prova' };
    const draft = { language: 'it', profile: { fullName: 'Candidato Prova', location: 'Como (CO)', experience: [swissJob] }, questions: [permitQuestion] };
    const edited = candidateWithEdits({ order, draft, flow: {} });
    expect(edited.platformFacts.permitStatusSource).toBe('deduced');
    expect(edited.profile.permitStatus).toBe('');
    expect(edited.answers.work_permit).toBeUndefined();
    const { answers, defaults } = withOperationalQuestionAnswers(draft.questions, edited.answers, { locale: 'it', facts: edited.platformFacts });
    expect(answers.work_permit).toBe(permitG);
    expect(defaults.work_permit).toMatchObject({ basis: 'deduced', source: 'policy_default' });
    // An answer of the candidate stays theirs.
    const own = withOperationalQuestionAnswers(draft.questions, { work_permit: permitOptions('it')[1] }, { locale: 'it', facts: edited.platformFacts });
    expect(own.answers.work_permit).toBe(permitOptions('it')[1]);
    expect(own.defaults.work_permit).toBeUndefined();
    const cleared = candidateWithEdits({ order, draft, flow: { formOverrides: { workPermit: '' } } });
    expect(cleared.platformFacts.permitStatus).toBe('');
  });

  it('the runner fills the permit fields with the deduced status, never over an answer of the candidate', () => {
    const order = { userId: 'u-test', applicantName: 'Candidato Prova' };
    const draft = { language: 'it', profile: { fullName: 'Candidato Prova', location: 'Como (CO)', experience: [swissJob] }, questions: [] };
    const edited = candidateWithEdits({ order, draft, flow: {} });
    const form = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers, language: 'it', platformFacts: edited.platformFacts });
    expect(form.swissStatus?.code).toBe('permit_g');
    const answered = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: { work_permit: 'Non lo so' }, language: 'it', platformFacts: edited.platformFacts });
    expect(answered.swissStatus).toBeNull();
    const italian = candidateWithEdits({ order, draft: { ...draft, profile: { ...draft.profile, experience: [italianJob] } }, flow: {} });
    expect(candidateForForm({ identity: italian.identity, profile: italian.profile, answers: italian.answers, language: 'it', platformFacts: italian.platformFacts }).swissStatus).toBeNull();
  });
});

describe('suitability for the position: always yes (owner decision 2026-11-10)', () => {
  const ask = (question: string, extra: object = {}) => ({ id: 'q', question, applicationQuestion: question, type: 'yes_no', source: 'match', ...extra });

  it('the LIS question and its siblings are a platform yes', () => {
    const lis = ask('Dichiara la propria idoneità alla funzione prevista dal bando?');
    expect(platformQuestionTopic(lis)).toBe('function_suitability');
    expect(operationalDefaultAnswer(lis, { locale: 'it', facts: facts() })?.value).toBe('Sì');
    expect(platformDefaultAnswer({ ...lis, type: 'choice', options: ['Sì', 'No'] }, null, { locale: 'it' })?.value).toBe('Sì');
    expect(platformDefaultAnswer(ask('Sind Sie an dieser Stelle interessiert?'), null, { locale: 'de' })?.value).toBe('Ja');
    expect(platformDefaultAnswer(ask('Are you interested in this position?'), null, { locale: 'en' })?.value).toBe('Yes');
    expect(platformDefaultAnswer(ask('Vous estimez-vous apte pour ce poste ?'), null, { locale: 'fr' })?.value).toBe('Oui');
  });

  it('a fitness of health or of law, a conflict of interest, other positions, a workload or a text stay out', () => {
    for (const question of [
      "Dichiara la propria idoneità fisica alla funzione?",
      "Dichiara di possedere l'idoneità sanitaria alla mansione?",
      'Dichiara di godere dei diritti civili e di avere una condotta irreprensibile ai fini della funzione?',
      'Ha un conflitto di interessi con la funzione prevista dal bando?',
      'È interessato ad altre posizioni presso il nostro ente?',
      'È interessato a un posto a tempo parziale?',
    ]) expect(platformQuestionTopic(ask(question))).not.toBe('function_suitability');
    expect(platformQuestionTopic(ask('Perché è interessato alla funzione?', { type: 'text' }))).toBeNull();
  });
});

describe('tools and experience from the CV are the engine’s (owner decision 2026-11-10)', () => {
  const CV = 'Infermiera, Casa per anziani Gamma, Mendrisio, 2019 – oggi. Valutazioni con lo strumento RAI-NH; cura di persone anziane.';
  const rai = { id: 'rai_knowledge', question: 'Ha conoscenza dello strumento gestionale RAI?', type: 'choice', options: ['Sì', 'No'], source: 'match' };
  const elderly = { id: 'elderly_sensitivity', question: 'Descriva eventuali esperienze o attività svolte con persone anziane che dimostrino la sua sensibilità relazionale.', type: 'text', source: 'match' };

  it('the knowledge of a tool is decided: yes with the CV quote, else a plausible deduction', () => {
    expect(experienceQuestionKind(rai)).toBe('experience');
    expect(candidateOnlyCategory(rai)).toBeNull();
    expect(decisionAnswerable(rai, { facts: facts() })).toBe(true);
    const cited = verifyDecision({ decision: 'answer', value: 'Sì', principle: 'cv_fact', evidence: ['Valutazioni con lo strumento RAI-NH'], reason: 'The CV shows it.' }, { question: rai, cvText: CV });
    expect(cited).toMatchObject({ ok: true, value: 'Sì', principle: 'cv_fact' });
    const deduced = verifyDecision({ decision: 'answer', value: 'Sì', principle: 'cv_fact', evidence: [], reason: 'Plausible from the roles.' }, { question: rai, cvText: 'Operatrice sociosanitaria, Casa di cura Delta, 2018 – oggi.' });
    expect(deduced).toMatchObject({ ok: true, value: 'Sì', principle: 'plausible_deduction' });
  });

  it('a description of experience with elderly people is a plausible text from the CV, not a technical one', () => {
    expect(cvAnswerQuestionEligible(elderly)).toBe(true);
    expect(cvQuestionKind(elderly)).toBe('behavioral');
    expect(candidateOnlyCategory(elderly)).toBeNull();
  });
});
