/**
 * The CV's answers to the open text questions of an application (owner decisions of 2026-11-10,
 * functions/src/assistedApplicationCvAnswers.js): one model call over the CV excerpts, then the
 * deterministic checks of sanitizeApplicationAnswerSuggestions. Used by the draft (lib/draft.mjs) and by
 * the backfill of orders written before (reconcile-cv-answers.mjs).
 */
import { sourceCitations } from '../../../functions/src/lib/sourceCitations.js';
import { sanitizeApplicationAnswerSuggestions } from '../../../functions/src/assistedApplicationAiDraftCore.js';
import {
  APPLICATION_ANSWERS_SCHEMA,
  applicationAnswersSystemPrompt,
  applicationAnswersUserText,
  codexPrompt,
} from '../../../functions/src/assistedApplicationAiPrompts.js';
import { cvAnswerQuestionEligible, isBigFourExperienceQuestion, verifyCvAnswer } from '../../../functions/src/assistedApplicationCvAnswers.js';
import { operationalDefaultAnswer } from '../../../functions/src/assistedApplicationOperationalAnswers.js';
import { questionTopic, SENSITIVE } from './portal/plan.mjs';

const MAX_SOURCE_CHARS = 30_000;
export const CV_ANSWERS_TIMEOUT_MS = 120_000;
const PERSONAL_OR_OPERATIONAL_RE = /\b(?:e-?mail|courriel|t[eé]l[eé]phone\w*|telefon\w*|mobiltelefon\w*|telefono\w*|phone|mobile(?!\s+device)|cellulaire|num[eé]ro de t[eé]l[eé]phone|religion|religious|faith|pregnan\w*|sexual orientation|political affiliation|political views|race|ethnic\w*|disabil\w*|consent|privacy|terms and conditions|newsletter|marketing)\b/i;
const NAME_FIELD_RE = /^\s*(?:first\s+name|given\s+name|last\s+name|family\s+name|full\s+name|surname|name|vorname|nachname|familienname|pr[eé]nom|nom\s+de\s+famille|nom|nome|nome\s+completo|cognome|nome\s+e\s+cognome)(?:\s*(?:\/|,|&|and|e)\s*(?:first\s+name|given\s+name|last\s+name|family\s+name|full\s+name|surname|name|vorname|nachname|familienname|pr[eé]nom|nom\s+de\s+famille|nom|nome|nome\s+completo|cognome|nome\s+e\s+cognome))*(?:\s*\((?:required|obligatoire|obbligatorio|pflichtfeld)\))?\s*[:*?]?\s*$/i;
const NAME_QUESTION_RE = /\b(?:what(?:'s| is)\s+(?:your|the applicant'?s|the candidate'?s)\s+(?:first\s+|last\s+|full\s+)?name|please state your name|quel est votre (?:pr[eé]nom|nom(?: de famille| complet)?)|comment\s+(?:vous\s+appelez(?:-vous)?|t['’]appelles(?:-tu)?)|come ti chiami|come si chiama|qual(?:['’]e|\s+è|\s+e)\s+(?:il|la)\s+(?:tuo|suo)\s+nome|wie (?:heisst|heißt) du|wie lautet (?:dein|ihr) (?:name|vorname|nachname)|wie (?:heisst|heißt) (?:ihr|dein) name|wie heissen sie|wie heißen sie)\b/i;

/** A question the CV may answer: open text, not personal, not a fact the planner or the platform owns. */
export function cvAnswerable(question, { answers = {}, facts = null } = {}) {
  if (!cvAnswerQuestionEligible(question) || String(answers?.[question.id] ?? '').trim()) return false;
  // Big Four experience is resolved only from structured, corroborated work history; a generic model
  // answer could turn an unrelated CV role into a personal experience claim.
  if (isBigFourExperienceQuestion(question)) return false;
  const text = [question.question, question.applicationQuestion, question.context, question.section].filter(Boolean).join(' ');
  const topic = questionTopic(question.applicationQuestion || question.question, question.context || '', question);
  if (topic && !String(topic).startsWith('language:')) return false;
  if (SENSITIVE.test(text) || PERSONAL_OR_OPERATIONAL_RE.test(text) || NAME_QUESTION_RE.test(text)) return false;
  if ([question.question, question.applicationQuestion].filter(Boolean).some((label) => NAME_FIELD_RE.test(label))) return false;
  // The platform answers it already (owner rules of 2026-11-09).
  return !(facts && operationalDefaultAnswer(question, { facts }));
}

/**
 * Ask the model for the CV's answers to the answerable questions and keep the verified ones.
 * @returns {Promise<{questions:Array, asked:string[], kept:string[]}>} the questions with
 *   suggestedAnswer / answerEvidence / answerKind / answerMissingDetail on the asked ones
 */
export async function draftCvAnswers({ questions, answers = {}, facts = null, cvText, codex, locale, log = () => {}, onlyIds = null }) {
  const all = Array.isArray(questions) ? questions : [];
  const answerable = all.filter((question) => cvAnswerable(question, { answers, facts })
    && (!onlyIds || onlyIds.includes(question.id)));
  const sourceText = String(cvText || '').slice(0, MAX_SOURCE_CHARS);
  const none = { questions: all, asked: [], kept: [], decisions: [] };
  if (!answerable.length || !sourceText.trim() || typeof codex !== 'function') return none;
  const citations = sourceCitations({ cv: sourceText });
  if (!citations.excerpts.length) return none;
  const schema = structuredClone(APPLICATION_ANSWERS_SCHEMA);
  schema.properties.answers.items.properties.id.enum = answerable.map((question) => question.id);
  schema.properties.answers.items.properties.evidence.items = {
    type: 'string',
    enum: ['', ...citations.excerpts.map((item) => item.id)],
    description: 'An exact CV excerpt id, or "" when no excerpt supports or anchors the answer.',
  };
  try {
    const raw = await codex({
      prompt: codexPrompt(applicationAnswersSystemPrompt(locale), applicationAnswersUserText({
        questions: answerable,
        candidateSourceExcerpts: citations.excerpts,
      })),
      schema,
      timeoutMs: CV_ANSWERS_TIMEOUT_MS,
    });
    const resolved = {
      ...raw,
      answers: Array.isArray(raw?.answers) ? raw.answers.map((item) => {
        const ids = (Array.isArray(item?.evidence) ? item.evidence : []).filter((id) => id !== '').slice(0, 3);
        let evidenceUnverified = false;
        const evidence = ids.map((id) => {
          const quote = citations.resolve(id);
          if (quote === null || quote === id) evidenceUnverified = true;
          return quote;
        }).filter(Boolean);
        return { ...item, evidence, evidenceUnverified };
      }) : [],
    };
    const updated = sanitizeApplicationAnswerSuggestions(resolved, answerable, sourceText);
    const byId = new Map(updated.map((question) => [question.id, question]));
    // Why each answer was kept or dropped, without its text: for the logs and the backfill's report.
    const decisions = answerable.map((question) => {
      const item = resolved.answers.find((answer) => answer?.id === question.id);
      const kept = Boolean(String(byId.get(question.id)?.suggestedAnswer || '').trim());
      if (!item) return { id: question.id, modelKind: '', kept, reasons: ['not_answered'] };
      const checked = verifyCvAnswer({ kind: item.kind, answer: item.suggestedAnswer, evidence: item.evidence }, { cvText: sourceText, question });
      const reasons = [...checked.reasons];
      if (item.evidenceUnverified) reasons.push('evidence_id_unknown');
      if (!kept && !reasons.length) reasons.push('fact_gate');
      return { id: question.id, modelKind: String(item.kind || ''), kept, reasons };
    });
    return {
      questions: all.map((question) => byId.get(question?.id) || question),
      asked: answerable.map((question) => question.id),
      kept: decisions.filter((decision) => decision.kept).map((decision) => decision.id),
      decisions,
    };
  } catch (error) {
    log('cv answers skipped', String(error?.message || error).split('\n')[0].slice(0, 160));
    return none;
  }
}
