/**
 * The decision engine's model call (functions/src/assistedApplicationDecisionAnswers.js): the questions no
 * platform rule and no CV answer cover, decided by the owner's principles, then checked in code.
 *
 *   - draftDecisionAnswers: at draft time, over the CV text; a kept decision is written on the draft question
 *     (`platformDecision`) and projected as a platform proposal (platformFacts.decisionAnswers).
 *   - decideLiveQuestions: in the run, when the portal shows required fields nobody answered, before the
 *     runner stops to ask the candidate (portal.mjs askCandidate). Over the structured profile and, when the
 *     draft holds it, the CV's text (owner mandate 2026-11-10: a yes on experience cites the CV, verified in
 *     code). Never free text in the run: choice, yes/no and checkbox fields only.
 */
import { codexPrompt } from '../../../functions/src/assistedApplicationAiPrompts.js';
import {
  DECISIONS_SCHEMA,
  candidateOnlyCategory,
  decisionLabels,
  decisionQuestionEligible,
  decisionRecord,
  decisionsSystemPrompt,
  decisionsUserText,
  verifyDecision,
} from '../../../functions/src/assistedApplicationDecisionAnswers.js';
import { operationalDefaultAnswer } from '../../../functions/src/assistedApplicationOperationalAnswers.js';
import { platformQuestionTopic, withVerifiedPassportAnswers } from '../../../functions/src/assistedApplicationPlatformDefaults.js';
import { questionTopic, SENSITIVE } from './portal/plan.mjs';

export const DECISIONS_TIMEOUT_MS = 120_000;

const hasValue = (value) => (Array.isArray(value) ? value.some((item) => String(item ?? '').trim()) : String(value ?? '').trim().length > 0);

/**
 * A question the engine may decide: eligible, not already answered (by the candidate, a platform rule or the
 * CV), not one of the categories that stay with the candidate, not a fact the planner owns or a sensitive one.
 */
export function decisionAnswerable(question, { answers = {}, facts = null, allowText = true } = {}) {
  if (!decisionQuestionEligible(question, { allowText }) || hasValue(answers?.[question.id])) return false;
  // Passport type is a personal fact. The model may answer a verified binary passport question; the type is
  // supplied only by the shared candidate fact (candidate declaration, known nationality, or binary + permit).
  if (platformQuestionTopic(question) === 'passport_type') return false;
  if (candidateOnlyCategory(question)) return false;
  const text = [question.question, question.applicationQuestion, question.label].filter(Boolean).join(' ');
  if (SENSITIVE.test(text)) return false;
  const topic = questionTopic(question.applicationQuestion || question.question || question.label, question.context || '', question);
  if (topic && !String(topic).startsWith('language:')) return false;
  return !(facts && operationalDefaultAnswer(question, { facts }));
}

/** Merge live verified decisions and derive the passport fact before the planner reads the next page. */
export function platformFactsAfterLiveDecisions(facts = {}, questions = [], decisions = {}) {
  const current = facts && typeof facts === 'object' ? facts : {};
  const decisionAnswers = { ...(current.decisionAnswers || {}), ...(decisions || {}) };
  return withVerifiedPassportAnswers({ ...current, decisionAnswers }, { questions, decisionAnswers });
}

async function decide({ questions, codex, cvText = '', profile = null, employer = '', jobTitle = '', postingRequirements = [], allowText, log }) {
  const schema = structuredClone(DECISIONS_SCHEMA);
  schema.properties.decisions.items.properties.id.enum = questions.map((question) => question.id);
  try {
    const raw = await codex({
      prompt: codexPrompt(decisionsSystemPrompt(), decisionsUserText({ questions, employer, jobTitle, cvText, profile, postingRequirements })),
      schema,
      timeoutMs: DECISIONS_TIMEOUT_MS,
    });
    const proposals = Array.isArray(raw?.decisions) ? raw.decisions : [];
    // Why each question was decided or left, without its value: for the logs.
    return questions.map((question) => {
      const proposal = proposals.find((item) => item?.id === question.id);
      if (!proposal) return { question, checked: null, reasons: ['not_decided'] };
      const checked = verifyDecision(proposal, { question, cvText, allowText, postingTitle: jobTitle, postingRequirements });
      return { question, checked, reasons: checked.reasons };
    });
  } catch (error) {
    log('decision engine skipped', String(error?.message || error).split('\n')[0].slice(0, 160));
    return null;
  }
}

const report = (results) => results.map(({ question, checked, reasons }) => ({
  id: question.id, kept: Boolean(checked?.ok), principle: checked?.principle || '', reasons,
}));

/**
 * At draft time: decide the answerable questions over the CV and keep the verified decisions on them.
 * `onlyIds` limits the call to those questions (the re-evaluation of an older draft,
 * reconcile-review-questions.mjs, asks only what still holds the review).
 * @returns {Promise<{questions:Array, asked:string[], kept:string[], decisions:Array}>}
 */
export async function draftDecisionAnswers({ questions, answers = {}, facts = null, cvText, codex, employer = '', jobTitle = '', postingRequirements = [], log = () => {}, onlyIds = null }) {
  const all = Array.isArray(questions) ? questions : [];
  const none = { questions: all, asked: [], kept: [], decisions: [] };
  const answerable = all.filter((question) => decisionAnswerable(question, { answers, facts })
    && (!onlyIds || onlyIds.includes(question.id)));
  if (!answerable.length || !String(cvText || '').trim() || typeof codex !== 'function') return none;
  const results = await decide({ questions: answerable, codex, cvText, employer, jobTitle, postingRequirements, allowText: true, log });
  if (!results) return none;
  const kept = new Map(results.filter((item) => item.checked?.ok).map((item) => [item.question.id, decisionRecord(item.checked)]));
  const asked = new Set(answerable.map((question) => question.id));
  return {
    questions: all.map((question) => {
      if (!asked.has(question?.id)) return question;
      const { platformDecision: _stale, ...rest } = question;
      return kept.has(question.id) ? { ...rest, platformDecision: kept.get(question.id) } : rest;
    }),
    asked: [...asked],
    kept: [...kept.keys()],
    decisions: report(results),
  };
}

/** The structured CV facts the runner carries (candidateForForm), without contact data. */
function profileForModel(candidate = {}) {
  const profile = candidate?.profile || {};
  return {
    headline: profile.headline || '',
    currentOrLatestRole: profile.currentOrLatestRole || '',
    experience: (profile.experience || []).map(({ role = '', employer = '', start = '', end = '' }) => ({ role, employer, start, end })),
    education: (profile.education || []).map(({ degree = '', institution = '', start = '', end = '' }) => ({ degree, institution, start, end })),
    languages: profile.languages || [],
    availability: profile.availability || '',
  };
}

/**
 * In the run: decide the live questions the portal requires before asking the candidate. Choice, yes/no and
 * checkbox fields only. Returns the decisions keyed like platformFacts.decisionAnswers (by question id, with
 * the labels the planner recognizes the live field by), and the ids decided.
 * @returns {Promise<{decided:Record<string,object>, ids:string[], decisions:Array}>}
 */
export async function decideLiveQuestions({ questions, candidate, codex, cvText = '', log = () => {} }) {
  const live = (Array.isArray(questions) ? questions : []).filter((question) => question?.id)
    .map((question) => (question.source ? question : { ...question, source: 'portal' }));
  const empty = { decided: {}, ids: [], decisions: [] };
  const facts = candidate?.platformFacts;
  if (typeof codex !== 'function' || !facts || typeof facts !== 'object') return empty;
  const answerable = live.filter((question) => decisionAnswerable(question, { facts, allowText: false }));
  if (!answerable.length) return empty;
  const results = await decide({
    questions: answerable,
    codex,
    // The CV's text, when the draft holds it: the evidence a yes on experience cites is checked against it.
    cvText: String(cvText || ''),
    profile: profileForModel(candidate),
    employer: candidate?.job?.company || candidate?.job?.organization || '',
    jobTitle: candidate?.job?.title || '',
    allowText: false,
    log,
  });
  if (!results) return empty;
  const decided = {};
  for (const { question, checked } of results) {
    if (checked?.ok) decided[question.id] = { ...decisionRecord(checked), labels: decisionLabels(question) };
  }
  return { decided, ids: Object.keys(decided), decisions: report(results) };
}
