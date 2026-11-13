/**
 * The concierge's clarification questions, answered by the platform (owner mandate 2026-11-10: «le candidature
 * sono automatiche: ogni domanda la risponde la piattaforma … al candidato restano solo i documenti»).
 *
 * The eligibility check of a proposal (applicationConciergeEligibility.js) asks a question for every decisive
 * requirement the CV does not show. Those questions go through the same pipeline as the assisted application's:
 *
 *   1. the platform rules and owner preferences (operationalDefaultAnswer → platformDefaultAnswer): permit,
 *      start date three months ahead, workload 100 %, the maximum of the salary estimate, languages from the CV,
 *      relocation, hybrid work, on-call duty and travel yes;
 *   2. the decision engine (assistedApplicationDecisionAnswers.js) for experience, skills and the rest: yes with a
 *      verified citation of the CV, else the plausible deduction that maximizes the application's success; never
 *      yes to a formal certification, licence or degree the CV does not name (that yes becomes a no in code).
 *
 * What only the candidate can give (CANDIDATE_ONLY_CATEGORIES) and what nothing answers stays with the
 * candidate, unknown. Every platform answer is evidence of provenance `platform`, never `candidate_confirmed`,
 * and a candidate's own answer to the same question always wins.
 */
import { operationalDefaultAnswer, OPERATIONAL_DEFAULTS_VERSION } from './assistedApplicationOperationalAnswers.js';
import { platformCandidateFacts, platformQuestionTopic, PLATFORM_DEFAULTS_VERSION, withVerifiedPassportAnswers } from './assistedApplicationPlatformDefaults.js';
import {
  DECISIONS_SCHEMA,
  DECISION_ANSWERS_VERSION,
  candidateOnlyCategory,
  decisionAnswerFor,
  decisionLabels,
  decisionQuestionEligible,
  decisionRecord,
  decisionsSystemPrompt,
  decisionsUserText,
  experienceQuestionKind,
  verifyDecision,
} from './assistedApplicationDecisionAnswers.js';
import { CANDIDATE_LANGUAGE_OPTIONS, isLanguageAbilityQuestion, languageCodesIn } from './lib/languageFacts.js';

export const CONCIERGE_PLATFORM_ANSWERS_VERSION = 'concierge-platform-answers-v2';
export const CONCIERGE_PLATFORM_ANSWER_PROVENANCE = 'platform';
const MAX_QUESTIONS = 6;
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const NATIVE = { it: 'Madrelingua', en: 'Native', de: 'Muttersprache', fr: 'Langue maternelle' };
const NO = /^(?:no|nein|non|false|0|n)\b/;
const LEVEL_WORDS = /\b(?:livell\w*|level\w*|niveau\w*|sprachniveau\w*|\w*kenntnis\w*|conoscenz\w*|connaissance\w*|proficien\w*|padronanz\w*|maitrise|fluent\w*|fluid\w*|flie(?:ss|ß)end\w*|verhandlungssicher\w*|courant\w*)\b/iu;
// What the shared language reader does not inflect: «lingua tedesca», «Deutschkenntnisse», «im Deutschen».
const LANGUAGE_FORMS = [
  [/\blingua (\p{L}+?)a\b/giu, 'lingua $1o'],
  [/\bdeutsch\p{L}*/giu, 'Deutsch'],
  [/\bfranz(?:o|ö)sisch\p{L}*/giu, 'Französisch'],
  [/\benglisch\p{L}*/giu, 'Englisch'],
  [/\bitalienisch\p{L}*/giu, 'Italienisch'],
];

/** The one spoken language whose level a question asks, or ''. */
export function languageLevelCode(text) {
  const value = String(text || '');
  if (!LEVEL_WORDS.test(value) && !isLanguageAbilityQuestion(value)) return '';
  for (const variant of [value, LANGUAGE_FORMS.reduce((current, [re, to]) => current.replace(re, to), value)]) {
    const codes = languageCodesIn(variant);
    if (codes.length === 1) return codes[0];
    if (codes.length > 1) return '';
  }
  return '';
}

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const localeOf = (value) => (['it', 'en', 'de', 'fr'].includes(String(value || '').slice(0, 2)) ? String(value).slice(0, 2) : 'it');
const bounded = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The inputs the platform's answers depend on, for the eligibility cache fingerprint (never the answers
 * themselves): the service's facts and the listing's salary estimate, which answers a salary question.
 */
export function conciergePlatformInputs(service = {}, job = {}) {
  return JSON.stringify([
    CONCIERGE_PLATFORM_ANSWERS_VERSION, PLATFORM_DEFAULTS_VERSION, OPERATIONAL_DEFAULTS_VERSION, DECISION_ANSWERS_VERSION,
    service.candidateFacts || null, String(service.applicantLocation || ''), String(service.applicantLocationCountry || ''),
    localeOf(service.locale),
    Number(job?.salaryMin) || null, Number(job?.salaryMax) || null, String(job?.salaryCurrency || job?.currency || ''),
    job?.baseSalary ?? null,
  ]);
}

/**
 * The platform facts of a concierge candidate: the service plays the order (upload answers, residence, locale)
 * and the listing gives the salary estimate. The CV's structured profile is the one eligibility reads.
 */
export function conciergePlatformFacts({ service = {}, profile = {}, job = {}, nowMs = Date.now() } = {}) {
  const order = {
    userId: service.userId || '',
    candidateFacts: service.candidateFacts || null,
    applicantLocation: service.applicantLocation || '',
    applicantLocationCountry: service.applicantLocationCountry || '',
    salaryMin: Number(job.salaryMin) || undefined,
    salaryMax: Number(job.salaryMax) || undefined,
    salaryCurrency: job.salaryCurrency || job.currency || undefined,
    baseSalary: job.baseSalary,
  };
  return platformCandidateFacts({ order, profile, locale: localeOf(service.locale), nowMs, seed: service.userId || '' });
}

/**
 * A match question in the shape the assisted pipeline reads. A spoken-language level asked as free text is the
 * level scale, which the CV's languages answer; an experience or skill asked as free text is, for eligibility,
 * whether the candidate has it.
 */
export function platformQuestionShape(question, locale = 'it') {
  const text = bounded(question?.question, 300);
  const base = {
    id: bounded(question?.id, 60),
    asked: text,
    question: text,
    applicationQuestion: text,
    type: ['text', 'yes_no', 'choice', 'number', 'date'].includes(question?.type) ? question.type : 'text',
    options: Array.isArray(question?.options) ? question.options.map((item) => bounded(item, 120)).filter(Boolean) : [],
    required: question?.required === true,
    source: 'match',
    ...(question?.validation && typeof question.validation === 'object' ? { validation: question.validation } : {}),
  };
  if (base.type === 'text' || (base.type === 'choice' && !base.options.length)) {
    const code = languageLevelCode(text);
    if (code) {
      // The platform's language rule reads a field label («Level of German»); the match words its question freely.
      const name = CANDIDATE_LANGUAGE_OPTIONS.find((option) => option.code === code)?.label;
      return { ...base, ...(name ? { question: `Level of ${name}`, applicationQuestion: `Level of ${name}` } : {}), type: 'choice',
        options: [...CEFR, NATIVE[localeOf(locale)]], languageLevel: true };
    }
    if (experienceQuestionKind(base)) return { ...base, type: 'yes_no', options: [] };
  }
  return base;
}

function negativeAnswer(value) {
  return NO.test(fold(value));
}

/** The answer key the eligibility language rules read (conciergeProposalEligibility). */
function languageAnswerKey(question) {
  const code = languageLevelCode(question.question);
  return code ? `language_${code}_any_proficiency` : '';
}

function entryFor(question, answer, extra = {}) {
  return {
    questionId: question.id,
    question: question.asked || question.question,
    answer: bounded(answer.value, 500),
    origin: bounded(answer.origin || answer.topic, 80),
    ...(answer.principle ? { principle: answer.principle } : {}),
    ...(Array.isArray(answer.evidence) && answer.evidence.length ? { evidence: answer.evidence.slice(0, 3).map((item) => bounded(item, 300)) } : {}),
    ...extra,
  };
}

/**
 * Answer the required clarification questions the candidate has not answered.
 * `generate(systemPrompt, userPrompt, schema)` is the eligibility check's JSON model call; null runs the rules
 * and the decisions already in `facts.decisionAnswers` only. A failing model call throws: the eligibility retry
 * queue owns it, the questions are not handed to the candidate for a technical failure.
 * @returns {Promise<{entries:Array, left:Array, refusals:Array, decisions:Record<string,object>}>}
 */
export async function answerConciergeClarifications({ questions, facts, cvText = '', generate = null, candidateAnswers = {},
  answered = [], employer = '', jobTitle = '', locale = 'it' }) {
  const required = (Array.isArray(questions) ? questions : [])
    .filter((question) => question?.required === true && question?.id && String(question.question || '').trim())
    .slice(0, MAX_QUESTIONS)
    .map((question) => ({ original: question, shaped: platformQuestionShape(question, locale) }));
  const decisions = { ...(facts?.decisionAnswers || {}) };
  const passportQuestions = required.map((item) => item.shaped).filter((question) => platformQuestionTopic(question)?.startsWith('passport_'));
  const candidatePassportAnswers = passportQuestions.flatMap((question) => {
    const value = candidateAnswers?.[question.id];
    return Object.hasOwn(candidateAnswers || {}, question.id) && typeof value === 'string' ? [{ question, value }] : [];
  });
  if (candidatePassportAnswers.length) {
    for (const question of passportQuestions) delete decisions[question.id];
  }
  // A passport type comes from the shared candidate fact, never from an independent model choice.
  for (const item of required) {
    if (platformQuestionTopic(item.shaped) === 'passport_type') delete decisions[item.shaped.id];
  }
  const passportContext = { questions: passportQuestions, decisionAnswers: decisions, candidatePassportAnswers };
  const factsForRules = withVerifiedPassportAnswers({ ...facts, decisionAnswers: decisions }, passportContext);
  const known = new Map(answered.map((entry) => [fold(entry.question), entry]));
  const entries = [];
  const pending = [];
  for (const item of required) {
    if (String(candidateAnswers?.[item.shaped.id] ?? '').trim()) continue;
    const previous = known.get(fold(item.shaped.asked));
    if (previous) {
      entries.push({ ...previous, questionId: item.shaped.id });
      continue;
    }
    // Experience, skills and formal titles are the decision engine's (owner mandate 2026-11-10): a keyword
    // rule must not read «contabilità salariale» as a salary expectation. A spoken-language level is the CV's.
    const engineFirst = !item.shaped.languageLevel && Boolean(experienceQuestionKind(item.shaped));
    const rule = engineFirst ? null : operationalDefaultAnswer(item.shaped, { locale, facts: factsForRules });
    if (rule) entries.push(entryFor(item.shaped, rule, { principle: rule.principle || 'platform_rule' }));
    else if (decisionQuestionEligible(item.shaped) && !candidateOnlyCategory(item.shaped)
      && platformQuestionTopic(item.shaped) !== 'passport_type'
      && !(candidatePassportAnswers.length && platformQuestionTopic(item.shaped)?.startsWith('passport_'))) pending.push(item);
  }
  if (pending.length && typeof generate === 'function' && String(cvText || '').trim()) {
    const schema = structuredClone(DECISIONS_SCHEMA);
    schema.properties.decisions.items.properties.id.enum = pending.map((item) => item.shaped.id);
    const raw = await generate(decisionsSystemPrompt(),
      decisionsUserText({ questions: pending.map((item) => item.shaped), employer, jobTitle, cvText }), schema);
    const proposals = Array.isArray(raw?.decisions) ? raw.decisions : [];
    for (const item of pending) {
      const proposal = proposals.find((candidate) => candidate?.id === item.shaped.id);
      if (!proposal) continue;
      const checked = verifyDecision(proposal, { question: item.shaped, cvText });
      if (checked.ok) decisions[item.shaped.id] = { ...decisionRecord(checked), labels: decisionLabels(item.shaped) };
    }
  }
  const decidedFacts = withVerifiedPassportAnswers({ ...facts, decisionAnswers: decisions }, {
    ...passportContext, decisionAnswers: decisions,
  });
  for (const item of pending) {
    const passportRule = platformQuestionTopic(item.shaped)?.startsWith('passport_')
      ? operationalDefaultAnswer(item.shaped, { locale, facts: decidedFacts }) : null;
    if (passportRule) {
      entries.push(entryFor(item.shaped, passportRule, { principle: passportRule.principle || 'platform_rule' }));
      continue;
    }
    const decision = decisionAnswerFor(item.shaped, decidedFacts);
    if (decision) entries.push(entryFor(item.shaped, decision));
    else {
      const rule = operationalDefaultAnswer(item.shaped, { locale, facts: decidedFacts });
      if (rule) entries.push(entryFor(item.shaped, rule, { principle: rule.principle || 'platform_rule' }));
    }
  }
  // A choice with no options cannot be decided directly, but the verified binary answer above may now establish
  // the shared passport fact that supplies its localized catalog fallback.
  for (const item of required) {
    if (String(candidateAnswers?.[item.shaped.id] ?? '').trim()
      || entries.some((entry) => entry.questionId === item.shaped.id)) continue;
    const rule = operationalDefaultAnswer(item.shaped, { locale, facts: decidedFacts });
    if (rule) entries.push(entryFor(item.shaped, rule, { principle: rule.principle || 'platform_rule' }));
  }
  const answeredIds = new Set(entries.map((entry) => entry.questionId));
  const left = required.filter((item) => !answeredIds.has(item.shaped.id)
    && !String(candidateAnswers?.[item.shaped.id] ?? '').trim()).map((item) => item.original);
  // A no on experience, a skill or a formal qualification the posting makes decisive is a known gap.
  const refusals = entries.filter((entry) => {
    const item = required.find((candidate) => candidate.shaped.id === entry.questionId);
    return item && experienceQuestionKind(item.shaped) && negativeAnswer(entry.answer);
  });
  return { entries, left, refusals, decisions };
}

/** The answers map and the typed record the eligibility match reads, with the platform's provenance. */
export function platformAnswerInputs(entries, questions = []) {
  const answers = {};
  for (const entry of entries) {
    answers[entry.questionId] = entry.answer;
    const question = (Array.isArray(questions) ? questions : []).find((item) => item?.id === entry.questionId);
    const key = question ? languageAnswerKey({ question: String(question.question || '') }) : '';
    if (key && !negativeAnswer(entry.answer)) answers[key] = entry.answer;
  }
  return {
    answers,
    record: entries.length ? {
      provenance: CONCIERGE_PLATFORM_ANSWER_PROVENANCE,
      version: CONCIERGE_PLATFORM_ANSWERS_VERSION,
      answers: entries.map(({ questionId, question, answer }) => ({ questionId, question, answer })),
    } : null,
  };
}

/** What the cached result keeps of the platform's answers: shown and editable in the application it leads to. */
export function platformAnswersView(entries) {
  return entries.map(({ questionId, question, answer, origin, principle, evidence }) => ({
    questionId, question, answer, provenance: CONCIERGE_PLATFORM_ANSWER_PROVENANCE, origin: origin || '',
    ...(principle ? { principle } : {}), ...(evidence?.length ? { evidence } : {}),
  }));
}
