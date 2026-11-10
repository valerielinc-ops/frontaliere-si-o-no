/**
 * Answers «from the CV» (owner decisions of 2026-11-10: the applications fill in every value the CV
 * holds; a generic or behavioural question gets a plausible description built from the CV).
 *
 * The draft (scripts/assisted-application/lib/draft.mjs) asks the model to answer the open text
 * questions of the application (the portal's and the match's) from the CV, in one of two kinds:
 *
 *   - `technical`: a question about a technology, a tool, a method or hands-on technical experience.
 *     Answered only with what the CV says, with 1-3 CV excerpts as evidence. No pertinent excerpt, no
 *     answer: an invented technical experience is found out at the interview.
 *   - `behavioral`: a generic question (leadership, teamwork, conflicts, pressure, decisions in an
 *     emergency, structured work, motivation, strengths…). A plausible first-person description anchored
 *     to the roles, employers, sectors and skills of the CV, even when the CV does not report the episode.
 *
 * The kind is read from the question too (cvQuestionKind): a question that names a technology or asks
 * about studies is technical whatever the model calls it. Whatever the kind, the hard limit is checked
 * here, in code, on every read of the answer: at least one CV excerpt, verbatim in the CV, anchors it
 * (a technical answer names no tool beyond its excerpts), and it never introduces an employer, a school
 * or institute, a job title, a degree, a certification, a date, a month, a number or a quantity that the
 * CV does not contain (figures and dates in words too: lib/numberDateMentions.js). A failed check drops
 * the answer and the question goes back to the candidate.
 *
 * A verified answer is projected like a platform default (assistedApplicationOperationalAnswers.js,
 * `source: 'policy_default'`): shown and editable on the review page, it no longer holds the application,
 * and it never enters `answers`/`profile`, from which the letter and the CV are written.
 *
 * Pure JavaScript, no Node API: imported by the functions and by the runner scripts.
 */
import { validateAnswer } from './lib/answerRules.js';
import { unsupportedNumberDateMentions } from './lib/numberDateMentions.js';
import { toolTokens } from './assistedApplicationAiFactCheck.js';
import { vocabularyTools } from './lib/toolVocabulary.js';

export const CV_ANSWERS_VERSION = 'cv-answers-v1';
export const CV_ANSWER_KINDS = Object.freeze(['technical', 'behavioral']);
export const CV_ANSWER_QUESTION_SOURCES = Object.freeze(['portal', 'match']);
const MAX_ANSWER = 450;
const MAX_EVIDENCE = 3;

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The comparison the review page makes (assistedApplicationReview.js questionView): case and spacing only. */
const evidenceText = (value) => String(value ?? '').normalize('NFC').replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"')
  .replace(/\s+/gu, ' ').trim().toLowerCase();
const labelKey = (value) => fold(String(value ?? '').replace(/\s*(?:\((?:required|obligatoire|obbligatorio|pflichtfeld)\)|\*)\s*$/i, ''));

/** An open text question of the application the CV may answer: the portal's own or the match's. */
export function cvAnswerQuestionEligible(question) {
  if (!question?.id || !CV_ANSWER_QUESTION_SOURCES.includes(question.source)) return false;
  if ((question.type || 'text') !== 'text') return false;
  if (Array.isArray(question.options) && question.options.length) return false;
  return Boolean(String(question.applicationQuestion || question.question || '').trim());
}

// ── The hard limit ────────────────────────────────────────────────────────────

// A question about a technology, a tool, a method, studies or a qualification: answered only with what the
// CV names. Read from the question, never from the model's label (a technical question the model calls
// «behavioral» is still technical).
const TECHNICAL_QUESTION = /\b(?:experience (?:with|using|in using|of using)|hands on|working knowledge|knowledge of|proficien\w*|esperienz\w* (?:con|nell uso|nell utilizzo|di utilizzo|pratica con)|utilizz\w* (?:di|del|della|dei|degli)|erfahrung\w* (?:mit|im umgang|in der anwendung)|umgang mit|experience (?:avec|de l utilisation|pratique)|maitrise|conoscenz\w*|kenntnis\w*|connaissance\w*|software|tools?|strument\w*|werkzeug\w*|outils?|systems?|sistem\w*|system\w*|systeme\w*|technolog\w*|tecnologi\w*|technologie\w*|platforms?|piattaform\w*|plattform\w*|plateforme\w*|programm\w*|framework\w*|database\w*|cloud|network\w*|certific\w*|zertifi\w*|diplom\w*|degree\w*|laurea|qualific\w*|qualifikation\w*|licen[cs]\w*|patent\w*|abilitazion\w*|\w*(?:school|scuol|schul|ecole|lycee|gymnas|liceo)\w*|studi|studies|studium|education|formazione|ausbildung|lehre|apprenticeship|apprendistato|apprentissage|grades?|voti|noten|notes scolaires)\b/;

/** The kind the question itself asks for: `technical` when it names a technology or asks about one. */
export function cvQuestionKind(question) {
  const raw = [question?.applicationQuestion, question?.question, question?.label].filter((value) => typeof value === 'string').join(' ');
  if (toolTokens(raw).length || vocabularyTools(raw).length || TECHNICAL_QUESTION.test(fold(raw))) return 'technical';
  return 'behavioral';
}
// A degree or a certification the answer claims: its word must be in the CV.
const QUALIFICATION_STEMS = ['laurea', 'bachelor', 'master', 'mba', 'msc', 'bsc', 'dottorat', 'phd', 'doctorat', 'doktor', 'diplom',
  'maturita', 'matura', 'abitur', 'baccalaureat', 'certific', 'certified', 'zertifi', 'attestat', 'abilitazion', 'brevet',
  'efz', 'eba', 'lehrabschluss', 'fachausweis', 'eidg', 'licenza', 'licence', 'license', 'patente'];
const NOT_QUALIFICATION = /^(?:diplomat\w*|mastic\w*|masterclass)$/;
const LEGAL_FORM = /^(?:ag|sa|gmbh|sagl|srl|spa|sarl|snc|kg|ltd|inc|llc|plc|group|gruppo|gruppe|holding)$/;
// Words that introduce a name in any language: the name after them must be the CV's.
const INSTITUTION = /^(?:universita|university|universite|universitat|hochschule|fachhochschule|politecnico|polytechnic|istituto|institut|institute|scuola|schule|kantonsschule|gymnasium|liceo|lycee|college|accademia|academy|akademie|academie|ospedale|hospital|spital|klinik|clinica|clinique|banca|bank|banque|firma|unternehmen|arbeitgeber|betrieb|azienda|societa|company|entreprise|societe)$/;
// A role named as the candidate's: «come Capo progetto», «as Team Lead», «nel ruolo di responsabile».
const ROLE_INTRO = /(?:\b(?:nel ruolo di|in qualita di|nella posizione di|in the role of|in my role as|in the position of|au poste de|en tant que|dans le role de|in der funktion als|in der rolle als|position als)\s+)((?:[\p{L}-]+\s*){1,2})/giu;
const ROLE_INTRO_CAPITALISED = /(?:^|[\s(])(?:come|as|als|comme)\s+(?:(?:a|an|un|una|uno|une|ein|eine|einer)\s+)?(\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*){0,3})/gu;
const GERMAN = /\b(?:ich|und|habe|nicht|mit|bei|fur|meine[nmrs]?|wurde|konnte|einem|einer|dabei|immer|sowie|durch)\b/g;
const ENGLISH_ONLY_CAPITALS = new Set(['i', 'im', 'ive', 'id', 'ill']);

const SENTENCE_BREAK = /[.!?;:\n]["')\]»”]*$/;

function wordsOf(foldedText) {
  return new Set(foldedText.split(' ').filter(Boolean));
}

function stemIn(words, word, length = 5) {
  const stem = word.slice(0, Math.min(length, word.length));
  for (const candidate of words) if (candidate.startsWith(stem)) return true;
  return false;
}

/**
 * What an answer says that the CV does not: names, titles, qualifications, dates and figures.
 * @param {string} answer
 * @param {string} cvText the CV's text (draft.factSources.text)
 * @returns {Array<{kind:string, token:string}>} empty when the answer stays within the CV
 */
export function cvAnswerInventions(answer, cvText) {
  const text = String(answer ?? '');
  const cvFolded = fold(cvText);
  const cvWords = wordsOf(cvFolded);
  const findings = [];
  const add = (kind, token) => {
    if (!findings.some((item) => item.kind === kind && item.token === token)) findings.push({ kind, token });
  };
  // Figures, quantities and dates in digits or in words, it/de/fr/en (lib/numberDateMentions.js).
  for (const mention of unsupportedNumberDateMentions(text, cvText)) add(mention.kind, mention.token);
  const answerFolded = fold(text);
  const answerWords = answerFolded.split(' ').filter(Boolean);
  for (const word of answerWords) {
    if (!NOT_QUALIFICATION.test(word)) {
      const stem = QUALIFICATION_STEMS.find((item) => word.startsWith(item));
      if (stem && !cvFolded.includes(stem)) add('qualification', word);
    }
  }
  // Tokens with their position, to know the sentence start and the word before.
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}&.-]*/gu)].map((match) => ({
    raw: match[0].replace(/[.-]+$/, ''),
    index: match.index,
  }));
  const german = (fold(text).match(GERMAN) || []).length >= 2;
  tokens.forEach((token, position) => {
    const folded = fold(token.raw);
    if (!folded) return;
    const before = text.slice(0, token.index).trimEnd();
    const opened = /["(«“'‘]$/.test(before) ? before.slice(0, -1).trimEnd() : null;
    const sentenceStart = position === 0 || !before || SENTENCE_BREAK.test(before)
      || (opened !== null && (!opened || SENTENCE_BREAK.test(opened)));
    const capitalised = /^\p{Lu}/u.test(token.raw);
    const previous = position > 0 ? fold(tokens[position - 1].raw) : '';
    const next = position + 1 < tokens.length ? fold(tokens[position + 1].raw) : '';
    const known = folded.split(' ').every((part) => cvWords.has(part));
    // A name closed by a legal form («Contoso AG») or opened by an institution («Università di X»,
    // «Firma X»): every capitalised word of it must be the CV's, in every language.
    if (capitalised && !known && (LEGAL_FORM.test(next) || INSTITUTION.test(previous)
      || (position > 1 && INSTITUTION.test(fold(tokens[position - 2].raw)) && /^(?:di|de|of|der|des|du|von)$/.test(previous)))) {
      add('name', token.raw);
      return;
    }
    // Any other capitalised word inside a sentence is a proper name outside German, which capitalises
    // every noun: there only the name contexts above apply.
    if (capitalised && !sentenceStart && !german && !known && !ENGLISH_ONLY_CAPITALS.has(folded)) add('name', token.raw);
  });
  for (const [pattern, source] of [[ROLE_INTRO, answerFolded], [ROLE_INTRO_CAPITALISED, text]]) {
    for (const match of source.matchAll(pattern)) {
      const title = fold(match[1]).split(' ').filter((word) => word.length >= 4);
      const missing = title.filter((word) => !stemIn(cvWords, word));
      if (missing.length) add('title', match[1].trim());
    }
  }
  return findings;
}

/**
 * The deterministic check of one model answer.
 * @param {{kind?:string, answer?:string, evidence?:string[]}} proposal
 * @param {{cvText:string, question:object}} context
 * @returns {{ok:boolean, reasons:string[], value:string, kind:string, evidence:string[]}}
 */
export function verifyCvAnswer(proposal, { cvText, question }) {
  const reasons = [];
  const value = String(proposal?.answer ?? '').replace(/\s+/gu, ' ').trim();
  // The model may refuse (`factual`), never downgrade: a question that names a technology is technical.
  const modelKind = CV_ANSWER_KINDS.includes(proposal?.kind) ? proposal.kind : '';
  const kind = modelKind && (cvQuestionKind(question) === 'technical' ? 'technical' : modelKind);
  const evidence = (Array.isArray(proposal?.evidence) ? proposal.evidence : [])
    .map((item) => String(item ?? '').replace(/\s+/gu, ' ').trim()).filter(Boolean).slice(0, MAX_EVIDENCE);
  const cv = evidenceText(cvText);
  if (!cv) reasons.push('no_cv');
  if (!cvAnswerQuestionEligible(question)) reasons.push('question_not_eligible');
  if (!kind) reasons.push('kind_not_answerable');
  if (!value) reasons.push('empty');
  const maxLength = Math.min(MAX_ANSWER, Number(question?.validation?.maxLength) || MAX_ANSWER);
  if (value.length > maxLength) reasons.push('too_long');
  // A citation that is not in the CV is an invention, whatever the kind.
  if (evidence.some((quote) => !cv.includes(evidenceText(quote)))) reasons.push('evidence_not_in_cv');
  // Every answer stands on the CV: a technical one on the excerpts that state it, a plausible one on the
  // role, employer, sector or skill it is built from. No verified excerpt, no answer.
  if (!evidence.length) reasons.push(kind === 'technical' ? 'technical_without_evidence' : 'not_anchored_to_cv');
  // A technical answer names no tool beyond the excerpts it cites (not merely somewhere in the CV).
  if (kind === 'technical' && value && evidence.length) {
    const cited = evidence.join('\n');
    const citedTools = new Set(vocabularyTools(cited).map((tool) => tool.name));
    const citedFolded = ` ${fold(cited)} `;
    for (const tool of vocabularyTools(value)) if (!citedTools.has(tool.name)) reasons.push('tool_not_in_cited_evidence');
    for (const { token } of toolTokens(value)) if (!citedFolded.includes(` ${fold(token)} `)) reasons.push('tool_not_in_cited_evidence');
  }
  if (value && !validateAnswer(value, { ...question, required: true, type: 'text' }).ok) reasons.push('invalid_for_field');
  if (value && cv) for (const finding of cvAnswerInventions(value, cvText)) reasons.push(`invented_${finding.kind}`);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], value, kind, evidence };
}

/**
 * The verified CV answers of a draft, by question id, for the form-only platform facts
 * (candidateWithEdits → platformFacts.cvAnswers). Checked again on every read: a draft whose CV text
 * changed, or an answer that no longer passes, drops out.
 * @returns {Record<string,{value:string, kind:string, evidence:string[], labels:string[], version:string}>}
 */
export function verifiedCvAnswers(questions, cvText) {
  const out = {};
  if (!String(cvText ?? '').trim()) return out;
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!cvAnswerQuestionEligible(question) || !String(question.suggestedAnswer ?? '').trim()) continue;
    // A suggestion of a draft written before the kinds is a cited one: it holds as a technical answer.
    const kind = CV_ANSWER_KINDS.includes(question.answerKind) ? question.answerKind : 'technical';
    const checked = verifyCvAnswer({ kind, answer: question.suggestedAnswer, evidence: question.answerEvidence }, { cvText, question });
    if (!checked.ok) continue;
    const labels = [...new Set([question.applicationQuestion, question.question].map(labelKey).filter(Boolean))];
    out[question.id] = { value: checked.value, kind: checked.kind, evidence: checked.evidence, labels, version: CV_ANSWERS_VERSION };
  }
  return out;
}

/**
 * The CV answer of a question, as a platform default, or null: by its id in the draft, or by its label
 * for a field the runner reads live on the portal (one answer for that label only).
 * @returns {{value:string, topic:string, source:'policy_default', origin:string, evidence:string[], version:string}|null}
 */
export function cvAnswerFor(question, facts) {
  const answers = facts?.cvAnswers;
  if (!answers || typeof answers !== 'object' || !question) return null;
  const keys = [question.applicationQuestion, question.label, question.question].map(labelKey).filter(Boolean);
  let entry = question.id && Object.hasOwn(answers, question.id) ? answers[question.id] : null;
  if (entry && keys.length && Array.isArray(entry.labels) && !entry.labels.some((label) => keys.includes(label))) entry = null;
  if (!entry && keys.length) {
    const matching = Object.values(answers).filter((item) => Array.isArray(item?.labels) && item.labels.some((label) => keys.includes(label)));
    const values = new Set(matching.map((item) => item.value));
    if (values.size === 1) [entry] = matching;
  }
  if (!entry || !CV_ANSWER_KINDS.includes(entry.kind) || !String(entry.value ?? '').trim()) return null;
  const type = question.type || question.kind || question.inputType || 'text';
  if (!['text', 'textarea'].includes(type)) return null;
  if (!validateAnswer(entry.value, { ...question, type: 'text', required: true }).ok) return null;
  return {
    value: entry.value,
    topic: `cv_answer:${entry.kind}`,
    source: 'policy_default',
    origin: entry.kind === 'technical' ? 'cv_evidence' : 'cv_plausible',
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    version: CV_ANSWERS_VERSION,
  };
}

/** Whether a projected default is a CV answer (not shown as a separate e-mail line, shown with its evidence). */
export function isCvAnswerDefault(answer) {
  return typeof answer?.topic === 'string' && answer.topic.startsWith('cv_answer:');
}
