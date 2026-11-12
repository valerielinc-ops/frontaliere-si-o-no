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

// v2 (2026-11-12): deterministic Big Four/equivalent proposals from corroborated work-history entries.
export const CV_ANSWERS_VERSION = 'cv-answers-v2';
export const CV_ANSWER_KINDS = Object.freeze(['technical', 'behavioral']);
export const CV_ANSWER_QUESTION_SOURCES = Object.freeze(['portal', 'match']);
const MAX_ANSWER = 450;
const MAX_EVIDENCE = 3;
const MAX_CV_TEXT_CHARS = 40_000;
const MAX_COMPLETE_WORK_SECTION_EVIDENCE_CHARS = 1_000;

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

const BIG_FOUR_QUESTION = /\b(?:big\s*four|big\s*4|four\s+major\s+firms|four\s+largest\s+consult(?:ing|ancy)|consulting\s+(?:firm|company|environment)|societ[aà]\s+di\s+consulenza|cabinet\s+de\s+conseil|unternehmensberatung|beratungsgesellschaft)\b/i;
const CONSULTING_EMPLOYERS = Object.freeze([
  { name: 'Deloitte', aliases: ['deloitte'], family: 'big_four' },
  { name: 'PwC', aliases: ['pwc', 'pricewaterhousecoopers'], family: 'big_four' },
  { name: 'EY', aliases: ['ernst young', 'ey'], family: 'big_four' },
  { name: 'KPMG', aliases: ['kpmg'], family: 'big_four' },
  { name: 'Grant Thornton', aliases: ['grant thornton'], family: 'equivalent' },
  { name: 'BDO', aliases: ['bdo'], family: 'equivalent' },
  { name: 'RSM', aliases: ['rsm'], family: 'equivalent' },
  { name: 'Forvis Mazars', aliases: ['forvis mazars', 'mazars'], family: 'equivalent' },
  { name: 'Baker Tilly', aliases: ['baker tilly'], family: 'equivalent' },
  { name: 'Crowe', aliases: ['crowe'], family: 'equivalent' },
  { name: 'McKinsey', aliases: ['mckinsey'], family: 'equivalent' },
  { name: 'Boston Consulting Group', aliases: ['boston consulting group', 'bcg'], family: 'equivalent' },
  { name: 'Bain', aliases: ['bain company', 'bain'], family: 'equivalent' },
  { name: 'Accenture', aliases: ['accenture'], family: 'equivalent' },
  { name: 'Capgemini', aliases: ['capgemini'], family: 'equivalent' },
  { name: 'BearingPoint', aliases: ['bearingpoint'], family: 'equivalent' },
  { name: 'Arthur D. Little', aliases: ['arthur d little'], family: 'equivalent' },
  { name: 'L.E.K. Consulting', aliases: ['lek consulting'], family: 'equivalent' },
  { name: 'Oliver Wyman', aliases: ['oliver wyman'], family: 'equivalent' },
  { name: 'Roland Berger', aliases: ['roland berger'], family: 'equivalent' },
  { name: 'Kearney', aliases: ['kearney'], family: 'equivalent' },
]);
const EXPERIENCE_HEADINGS = new Set([
  'experience', 'work experience', 'professional experience', 'employment history', 'work history',
  'esperienza', 'esperienze', 'esperienza professionale', 'esperienze professionali', 'esperienza lavorativa', 'esperienze lavorative',
  'berufserfahrung', 'beruflicher werdegang', 'experience professionnelle', 'experiences professionnelles', 'parcours professionnel',
]);
const OTHER_SECTION_HEADINGS = new Set([
  'education', 'education and training', 'formation', 'formazione', 'ausbildung', 'studies', 'istruzione',
  'languages', 'lingue', 'sprachen', 'langues', 'skills', 'competencies', 'competences', 'competenze', 'kenntnisse',
  'certifications', 'certificazioni', 'certificats', 'zertifikate', 'references', 'referenze', 'referenzen',
  'interests', 'hobbies', 'interessi', 'hobbys', 'summary', 'profile', 'profilo', 'profil', 'kurzprofil',
]);
const CONSULTING_ACTIVITY_RE = /\b(?:consult(?:ing|ancy|ant)?|advisory|professional services|management consulting|strategy consulting|audit\w*|revisione|revision\w*|prufung\w*|consulenz\w*|societ\w* di consulenz\w*|conseil|cabinet de conseil|berater\w*|unternehmensberat\w*|beratungsgesellschaft)\b/i;

/** The matcher topic is text-based: generated question ids and tenant labels are never used. */
export function isBigFourExperienceQuestion(question) {
  if (!question || typeof question !== 'object') return false;
  return BIG_FOUR_QUESTION.test([question.applicationQuestion, question.question, question.label].filter(Boolean).join(' '));
}

/** Past-work and behavioral matcher prompts are not requirements of the portal form. */
export function isMatcherExperienceQuestion(question) {
  if (question?.source !== 'match') return false;
  return /\b(?:experience|experienc\w*|esperienz\w*|erfahr\w*|berufserfahrung|employment history|work history|career history|professional background|parcours professionnel|worked (?:for|at|with)|work(?:ed)? experience|previous (?:job|role|employer)|past (?:job|role|employer)|ancien(?:ne)?s? employeurs?|a travaill\w* chez|ha lavorat\w* presso|erfahrung bei|bei einem arbeitgeber|example (?:when|where)|exemple (?:ou|dans lequel)|esempio in cui|beispiel (?:wie|in dem))\b/
    .test(fold([question.applicationQuestion, question.question, question.label].filter(Boolean).join(' ')));
}

function surfacePhrase(text, phrase) {
  const expected = fold(phrase).split(' ').filter(Boolean);
  if (!expected.length) return '';
  const tokens = [...String(text ?? '').matchAll(/[\p{L}\p{N}]+/gu)];
  for (let index = 0; index <= tokens.length - expected.length; index += 1) {
    const group = tokens.slice(index, index + expected.length);
    if (group.map((token) => fold(token[0])).join(' ') !== expected.join(' ')) continue;
    const start = group[0].index;
    const end = group.at(-1).index + group.at(-1)[0].length;
    return String(text).slice(start, end);
  }
  return '';
}

function sectionHeading(value) {
  return fold(String(value ?? '').replace(/^[\s•·▪●○■□*–—-]+/u, '').replace(/[:*]+$/u, '').trim());
}

function experienceSection(cvText) {
  const lines = String(cvText ?? '').split(/\r?\n/u);
  const start = lines.findIndex((line) => EXPERIENCE_HEADINGS.has(sectionHeading(line)));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && OTHER_SECTION_HEADINGS.has(sectionHeading(line)));
  if (end < 0) end = lines.length;
  const content = lines.slice(start + 1, end).filter((line) => line.trim());
  return content.length ? { heading: lines[start].trim(), text: content.join('\n'), lines: content } : null;
}

function employerFamily(value) {
  const normalized = fold(value);
  if (!normalized) return null;
  return CONSULTING_EMPLOYERS.find(({ aliases }) => aliases.some((alias) => {
    return ` ${normalized} `.includes(` ${fold(alias)} `);
  })) || null;
}

function experienceEvidence(entry, lines, { consultingOnly = false } = {}) {
  const employer = employerFamily(entry?.employer);
  const role = fold(entry?.role);
  const employerText = fold(entry?.employer);
  if (!employerText || !role || (consultingOnly && !employer)) return null;
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const block = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).map((line) => line.trim()).filter(Boolean).join(' ');
    const normalized = fold(block);
    if (employer
      ? !employer.aliases.some((alias) => ` ${normalized} `.includes(` ${fold(alias)} `))
      : !` ${normalized} `.includes(` ${employerText} `)) continue;
    if (!normalized.includes(role)) continue;
    const periodParts = [entry.start, entry.end].map((value) => String(value ?? '').trim()).filter(Boolean);
    const period = periodParts.length && periodParts.every((value) => normalized.includes(fold(value)))
      ? periodParts.join(' – ') : '';
    const employerName = employer
      ? employer.aliases.map((alias) => surfacePhrase(block, alias)).find(Boolean) || employer.name
      : surfacePhrase(block, entry.employer) || String(entry.employer).trim();
    candidates.push({
      employer: employerName,
      role: surfacePhrase(block, entry.role) || String(entry.role).trim(),
      period,
      evidence: block,
    });
  }
  return candidates[0] || null;
}

function answerLanguage(question) {
  const text = fold([question?.applicationQuestion, question?.question, question?.label].filter(Boolean).join(' '));
  if (/\b(?:hai|societa|maturato|indica|organizzazione|ruolo|periodo|esperienza)\b/.test(text)) return 'it';
  if (/\b(?:haben sie|unternehmen|beratung|erfahrung|organisation|rolle|zeitraum)\b/.test(text)) return 'de';
  if (/\b(?:avez vous|cabinet|experience|organisation|poste|periode)\b/.test(text)) return 'fr';
  return 'en';
}

function experienceAnswerText(question, evidence) {
  const language = answerLanguage(question);
  if (!evidence) return ({
    it: 'Nessuna esperienza di questo tipo è riportata.',
    en: 'No such experience is listed.',
    de: 'Der Lebenslauf nennt keine solche Erfahrung.',
    fr: 'Aucune expérience de ce type ne figure dans le CV.',
  })[language];
  const period = evidence.period ? ` (${evidence.period})` : '';
  return ({
    it: `Esperienza${period} come ${evidence.role} presso ${evidence.employer}.`,
    en: `Experience${period} as ${evidence.role} at ${evidence.employer}.`,
    de: `Der Lebenslauf nennt Erfahrung${period} als ${evidence.role} bei ${evidence.employer}.`,
    fr: `Le CV indique une expérience${period} comme ${evidence.role} chez ${evidence.employer}.`,
  })[language];
}

/** A deterministic proposal from corroborated work history; absence requires a complete, structured CV section. */
function bigFourExperienceProposal(question, cvText, profile) {
  if (!cvAnswerQuestionEligible(question) || !isBigFourExperienceQuestion(question)) return null;
  const rawText = String(cvText ?? '');
  if (!rawText.trim()) return null;
  const section = experienceSection(rawText);
  const lines = section?.lines || rawText.split(/\r?\n/u).filter((line) => line.trim());
  const workEntries = (Array.isArray(profile?.experience) ? profile.experience : [])
    .filter((entry) => !['trial_apprenticeship', 'volunteer'].includes(entry?.kind));
  const relevant = workEntries.map((entry) => experienceEvidence(entry, lines, { consultingOnly: true })).filter(Boolean);
  if (relevant.length) {
    const evidence = relevant[0];
    return { kind: 'technical', answer: experienceAnswerText(question, evidence), evidence: [evidence.evidence] };
  }
  // Absence can only be stated when the source text is not capped and its explicit work-history section
  // agrees with every structured employment entry. A partial, unstructured or ambiguous CV remains unknown.
  if (!section || rawText.length >= MAX_CV_TEXT_CHARS || workEntries.length === 0 || workEntries.length >= 15) return null;
  const sectionEvidence = `${section.heading}\n${section.text}`;
  if (sectionEvidence.length > MAX_COMPLETE_WORK_SECTION_EVIDENCE_CHARS) return null;
  const corroborated = workEntries.map((entry) => experienceEvidence(entry, section.lines));
  if (corroborated.some((entry) => !entry)) return null;
  if (CONSULTING_ACTIVITY_RE.test(section.text)) return null;
  if (CONSULTING_EMPLOYERS.some(({ aliases }) => aliases.some((alias) => ` ${fold(section.text)} `.includes(` ${fold(alias)} `)))) return null;
  return { kind: 'technical', answer: experienceAnswerText(question, null), evidence: [sectionEvidence] };
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
export function verifiedCvAnswers(questions, cvText, profile = null) {
  const out = {};
  if (!String(cvText ?? '').trim()) return out;
  for (const question of Array.isArray(questions) ? questions : []) {
    if (isBigFourExperienceQuestion(question)) {
      const proposal = bigFourExperienceProposal(question, cvText, profile);
      if (!proposal) continue;
      const checked = verifyCvAnswer(proposal, { cvText, question });
      if (!checked.ok) continue;
      const labels = [...new Set([question.applicationQuestion, question.question].map(labelKey).filter(Boolean))];
      out[question.id] = { value: checked.value, kind: checked.kind, evidence: checked.evidence, labels, version: CV_ANSWERS_VERSION };
      continue;
    }
    if (!cvAnswerQuestionEligible(question) || !String(question.suggestedAnswer ?? '').trim()) continue;
    // The platform's own proposal mirrored on the draft (withPlatformSuggestions): not an answer of the CV.
    if (['platform_decision', 'platform_rule'].includes(question.answerOrigin)) continue;
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
