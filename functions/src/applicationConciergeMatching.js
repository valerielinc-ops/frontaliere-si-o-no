/**
 * CV and verified candidate evidence → job proposal workflow for the 30-day application concierge.
 *
 * Matching is intentionally explainable and conservative. It proposes only
 * HTTPS listings whose title/category/skills overlap with the private CV
 * projection, direct answers or fact-checked sent letters; the candidate still
 * accepts every position before an assisted application child is created.
 */

import { CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID, CONCIERGE_ELIGIBILITY_VERSION, normalizeConciergeJobRecord, prepareConciergeEligibility } from './applicationConciergeEligibility.js';
import { locationMatchPoints } from './applicationConciergeGeography.js';
import { MAX_ELIGIBILITY_RETRIES_PER_RUN, eligibilityRetryRef, eligibilityRetryRows, eligibilityRetrySummary, recordEligibilityRetry } from './applicationConciergeEligibilityRetry.js';
import {
  isLegacyUnverifiedRetraction,
  legacyProposalRecoveryRetryFields,
  legacyProposalRecoveryTerminalFields,
  selectLegacyProposalRecovery,
  summarizeLegacyProposalRecovery,
} from './applicationConciergeProposalRecovery.js';
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { loadCandidateAnswerEvidence } from './assistedApplicationAnswerEvidence.js';
import { factCheckAcknowledged } from './assistedApplicationFlow.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { retentionPurgeDueAt } from './assistedApplicationRetention.js';
import { CANDIDATE_LANGUAGE_OPTIONS } from './lib/languageFacts.js';
import {
  APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION,
  APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS,
  APPLICATION_CONCIERGE_MATCHING_VERSION,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  openProposalsCount,
  serviceIsActive,
  servicePositionLimit,
  timestampMillis,
} from './applicationConciergeConstants.js';

const DEFAULT_JOB_INDEX_URL = 'https://cdn.frontaliereticino.ch/data/jobs-it-index.json';
const FETCH_TIMEOUT_MS = 90_000;
const MAX_PROPOSALS_PER_RUN = APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS;
const MAX_ELIGIBILITY_WORK_PER_RUN = 40;
const MIN_MATCH_SCORE = 28;
const LETTER_PREFERENCE_STOP_WORDS = new Set([
  'interested', 'interest', 'interesse', 'interessata', 'interessato', 'motivated', 'motivation', 'motivazione',
  'company', 'azienda', 'entreprise', 'unternehmen', 'position', 'posizione', 'stelle', 'role', 'ruolo', 'job',
  'application', 'candidatura', 'bewerbung', 'postulation', 'candidate', 'candidato', 'candidata', 'opportunity',
  'opportunita', 'contribute', 'contributing', 'contribution', 'team', 'organization', 'organisation', 'employer',
]);
const LETTER_EVIDENCE_STOP_WORDS = new Set([
  ...LETTER_PREFERENCE_STOP_WORDS,
  'career', 'careers', 'experience', 'experiences', 'expertise', 'professional', 'professionally', 'years',
  'experienced', 'skills', 'knowledge', 'fluent', 'fluency', 'proficient', 'proficiency', 'native', 'mother',
  'tongue', 'language', 'languages', 'conversational', 'speaking', 'spoken', 'written', 'strong', 'excellent',
  'successful', 'successfully',
]);
const COMMON_LANGUAGE_SIGNALS_BY_CODE = Object.freeze({
  it: 'italiano', de: 'tedesco', fr: 'francese', en: 'inglese', es: 'spagnolo', pt: 'portoghese', nl: 'olandese',
});
const LANGUAGE_CODE_SIGNALS = Object.freeze(Object.fromEntries(CANDIDATE_LANGUAGE_OPTIONS
  .map(({ code, label }) => [code, COMMON_LANGUAGE_SIGNALS_BY_CODE[code] || label.toLowerCase()])));
export { APPLICATION_CONCIERGE_MATCHING_VERSION } from './applicationConciergeConstants.js';
export const APPLICATION_CONCIERGE_REQUIREMENTS_VERIFIED = true;
const STOP_WORDS = new Set([
  'and', 'con', 'per', 'the', 'with', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'in', 'a', 'da', 'su', 'il', 'lo', 'la', 'le', 'un', 'una', 'uno',
  'job', 'lavoro', 'stellen', 'emploi', 'arbeit', 'switzerland', 'svizzera', 'suisse', 'schweiz', 'full', 'time', 'part', 'tempo', 'pieno',
  'senior', 'junior', 'manager', 'management', 'group', 'global', 'head', 'director', 'directeur', 'directrice', 'direttore', 'responsabile', 'responsable', 'leiter', 'leitung', 'chief', 'lead', 'leader',
  'at', 'bei', 'chez', 'presso', 'for', 'from', 'und', 'oder', 'mit', 'der', 'die', 'das', 'von', 'pour', 'avec', 'dans', 'des', 'les', 'une', 'est',
]);
const SHORT_TECH_TOKENS = new Set(['it', 'ict', 'cio', 'sap', 'aws', 'gcp', 'erp', 'crm', 'sql', 'api', 'qa', 'hr', 'ai', 'ml']);
const ROLE_SIGNAL_POINTS = Object.freeze({
  commercial_sales: 22,
  recruiting: 22,
  technology_management: 28,
  enterprise_applications: 16,
  application_management: 28,
  technology_strategy: 14,
});
const ROLE_SIGNAL_LABELS = Object.freeze({
  commercial_sales: 'vendite e sviluppo commerciale',
  recruiting: 'selezione del personale',
  technology_management: 'gestione IT',
  enterprise_applications: 'applicazioni aziendali',
  application_management: 'gestione applicazioni',
  technology_strategy: 'strategia IT',
});
const COMMON_LANGUAGE_ALIASES = {
  italiano: /\b(?:italian|italiano|italiana|italien|italienisch(?:e|en|kenntnis(?:se|sen)?)?)\b/,
  tedesco: /\b(?:german|tedesco|tedesca|deutsch(?:e|en|kenntnis(?:se|sen)?)?|allemand|allemande)\b/,
  francese: /\b(?:french|francese|francais|franzosisch(?:e|en|kenntnis(?:se|sen)?)?)\b/,
  inglese: /\b(?:english|inglese|englisch(?:e|en|kenntnis(?:se|sen)?)?|anglais)\b/,
  spagnolo: /\b(?:spanish|spagnolo|spagnola|espanol|spanisch|espagnol)\b/,
  portoghese: /\b(?:portuguese|portoghese|portugues|portugiesisch)\b/,
  olandese: /\b(?:dutch|olandese|neerlandese|nederlands|neerlandais)\b/,
};
const ADDITIONAL_LANGUAGE_ALIASES = Object.fromEntries(CANDIDATE_LANGUAGE_OPTIONS
  .filter(({ code }) => !Object.hasOwn(COMMON_LANGUAGE_SIGNALS_BY_CODE, code))
  .map(({ code, label }) => {
    const signal = LANGUAGE_CODE_SIGNALS[code];
    const escaped = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [signal, new RegExp(`\\b${escaped}\\b`)];
  }));
const LANGUAGE_ALIASES = Object.freeze({ ...COMMON_LANGUAGE_ALIASES, ...ADDITIONAL_LANGUAGE_ALIASES });
const LANGUAGE_PROFICIENCY_CONTEXT = /\b(?:fluent|fluency|proficient|proficiency|knowledge|command|written|spoken|speaking|mother tongue|native speaker|conoscenza|conoscenze|madrelingua|fluente|padronanza|livello|excellent|good|fliessend(?:e|er|es|em|en)?|verhandlungssicher(?:e|er|es|em|en)?|muttersprache|maitrise|courant|niveau|maternelle|kenntnisse|a[1-2]|b[1-2]|c[1-2])\b/;
const LANGUAGE_SECTION_HEADING = /^(?:languages?|lingue?|langues?|sprachen?)\b/;
const LANGUAGE_SKILL_CONTEXT_BEFORE = new RegExp(`${LANGUAGE_PROFICIENCY_CONTEXT.source}(?:\\s+\\w+){0,6}\\s*$`);
const LANGUAGE_REQUIREMENT_CONTEXT_BEFORE = /\b(?:required|requirement|requirements|must|mandatory|preferred|desirable|necessary|essential|richiest[oaie]|preferibilmente|erforderlich|requise|exige)\s*$/;
const NEGATED_LANGUAGE_CONTEXT_BEFORE = /\b(?:no|not|never|without|non|nicht|kein(?:e|en)?|pas|sans)\b(?:\s+\w+){0,3}\s+(?:requirement|requirements|proficiency|skill|skills|knowledge|fluency|command)\s+(?:for|in|of)\s*$/;
const NEGATED_LANGUAGE_CONTEXT_AFTER = /\b(?:not|never|no|without|non|nicht|kein(?:e|en)?|pas|sans)\b(?:\s+\w+){0,3}\s*\b(?:required|requirement|requirements|proficiency|skills?|must|mandatory|preferred|desirable|necessary|essential|needed|asset|advantage|richiest[oaie]|preferibilmente|erforderlich|requise|exige)\b/;
const LANGUAGE_SKILL_CONTEXT_AFTER = /^(?:language|languages|skills?|proficiency|fluency|fluent|speaking|spoken|written|knowledge|kenntnisse|conoscenza|courant|fliessend|verhandlungssicher|muttersprache|madrelingua|niveau|maternelle)\b/;
const LANGUAGE_REQUIREMENT_CONTEXT_AFTER = /^(?:(?:is|are|a|an|at|level)\s+){0,2}(?:required|requirement|requirements|must|mandatory|preferred|desirable|necessary|essential|optional|advantage|asset|plus|richiest[oaie]|preferibilmente|erforderlich|requise|exige|a[1-2]|b[1-2]|c[1-2])\b/;
const LANGUAGE_CONTEXT_CONTINUATION = /^(?:and|or|e|et|und|language|languages|skills?|proficiency|fluency|fluent|speaking|spoken|written|knowledge|kenntnisse|conoscenza|courant|fliessend|verhandlungssicher|muttersprache|madrelingua|niveau|maternelle|level|at|is|are|required|requirement|requirements|must|mandatory|preferred|desirable|necessary|essential|optional|advantage|asset|plus|richiest[oaie]|preferibilmente|erforderlich|requise|exige|a[1-2]|b[1-2]|c[1-2])\b/;
const LANGUAGE_LABELS = Object.freeze({
  italiano: 'italiano',
  tedesco: 'tedesco',
  francese: 'francese',
  inglese: 'inglese',
  spagnolo: 'spagnolo',
  portoghese: 'portoghese',
  olandese: 'olandese',
  ...Object.fromEntries(CANDIDATE_LANGUAGE_OPTIONS
    .filter(({ code }) => !Object.hasOwn(COMMON_LANGUAGE_SIGNALS_BY_CODE, code))
    .map(({ code, label }) => [LANGUAGE_CODE_SIGNALS[code], label])),
});
const SPECIALTY_MISMATCHES = [
  /\b(?:sales|key account|account executive|business development|vendite|vente|vertrieb)\b/,
  /\b(?:auditor|auditing|internal audit|audit manager)\b/,
  /\bregulatory affairs\b/,
  /\b(?:test manager|software testing|quality assurance|qa engineer)\b/,
  /\b(?:system engineer|systems engineer|software engineer|software developer|developer|engineer)\b/,
  /\b(?:project manager|program manager)\b/,
];

function normalize(value) {
  const lower = String(value || '').toLocaleLowerCase()
    .replace(/\bcan['’]t\b/g, 'can not')
    .replace(/\bwon['’]t\b/g, 'will not')
    .replace(/\b(is|are|was|were|do|does|did|has|have|had|would|should|could|must|might|need)n['’]t\b/g, '$1 not');
  return lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#.]+/g, ' ').trim();
}
export function tokenize(value) {
  return new Set(normalize(value).split(/\s+/)
    .filter((token) => !/^\d+$/.test(token) && (token.length >= 3 || SHORT_TECH_TOKENS.has(token)) && !STOP_WORDS.has(token))
    .map((token) => token === 'ict' ? 'it' : token));
}

function rankingTokens(value, signals) {
  const text = normalize(value);
  return [...new Set([...tokenize(value), ...signals.filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal)])];
}

function rankingSignals(value, signals) {
  const text = normalize(value);
  return signals.filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal);
}

function stripEmployerSuffix(value) {
  return String(value || '').replace(/\s+(?:at|presso|bei|chez)\s+.+$/i, '');
}

function answerMatchEvidence(answerEvidence) {
  const skills = new Set();
  const experience = new Set();
  const languages = [];
  const languageLevels = [];
  for (const record of Array.isArray(answerEvidence) ? answerEvidence : []) {
    if (record?.scope !== 'candidate' || record?.sourceKind !== 'direct_user') continue;
    const fact = record.fact || {};
    const answer = normalize(record.answer);
    if (record.category === 'language' && String(record.answer ?? '').trim()) {
      const candidateLanguages = candidateLanguageAnswerSignals(record.question?.question || '', record.answer);
      languages.push(...candidateLanguages);
      const level = normalizeLanguageLevel(record.answer);
      if (level && candidateLanguages.length === 1) languageLevels.push({ language: candidateLanguages[0], level, source: 'confirmed_answer' });
    } else if (fact.type === 'experience_duration' && Number(String(record.answer).replace(',', '.')) > 0) {
      for (const token of tokenize(fact.subject)) experience.add(token);
    } else if (fact.type === 'credential_held' && /^(?:yes|si|ja|oui|true)$/.test(answer)) {
      for (const token of tokenize(fact.subject)) skills.add(token);
    }
  }
  return { skills, experience, languages: [...new Set(languages)], languageLevels };
}

function profileEvidence(profile, matchSignals = {}) {
  const skillTokens = new Set((profile?.skills || []).flatMap((value) => [...tokenize(value)]));
  const confirmed = matchSignals.candidateAnswerSignals || answerMatchEvidence(matchSignals.candidateAnswerEvidence);
  const currentTitleText = [profile?.workPosition, profile?.headline].map(stripEmployerSuffix).filter(Boolean);
  const previousPositionText = (profile?.previousPositions || []).map(stripEmployerSuffix).filter(Boolean);
  const titleText = [...currentTitleText, ...previousPositionText];
  const titleTokens = new Set(titleText.flatMap((value) => [...tokenize(value)]));
  const experienceTokens = new Set([...(profile?.experienceSummary || []), ...previousPositionText]
    .flatMap((value) => [...tokenize(stripEmployerSuffix(value))]));
  const letterEvidenceTokens = new Set(matchSignals.letterEvidenceTokens instanceof Set
    ? matchSignals.letterEvidenceTokens : matchSignals.letterEvidenceTokens || []);
  const profileLanguages = (profile?.languages || []).map((value) => value && typeof value === 'object'
    ? `${value.language || ''} ${value.level || ''}` : value);
  const factLanguages = (Array.isArray(matchSignals.candidateLanguageFacts) ? matchSignals.candidateLanguageFacts : [])
    .map(item => LANGUAGE_CODE_SIGNALS[item?.languageCode]).filter(Boolean);
  const candidateLanguageLevels = [
    ...(confirmed.languageLevels || []),
    ...(Array.isArray(matchSignals.candidateLanguageFacts) ? matchSignals.candidateLanguageFacts : [])
      .filter(item => LANGUAGE_CODE_SIGNALS[item?.languageCode])
      .map(item => ({ language: LANGUAGE_CODE_SIGNALS[item.languageCode], level: normalizeLanguageLevel(item.level), source: 'candidate_confirmed' })),
  ];
  const allTokens = new Set([...skillTokens, ...titleTokens, ...experienceTokens, ...letterEvidenceTokens]);
  const profileText = normalize([
    ...currentTitleText,
    ...previousPositionText,
    ...(profile?.skills || []),
    ...(profile?.experienceSummary || []).map(stripEmployerSuffix),
    ...confirmed.skills,
    ...confirmed.experience,
    ...letterEvidenceTokens,
  ].join(' '));
  return { skillTokens, confirmedSkillTokens: confirmed.skills, titleTokens, experienceTokens, letterEvidenceTokens,
    confirmedExperienceTokens: confirmed.experience, profileLanguages,
    languages: [...profileLanguages, ...confirmed.languages, ...factLanguages], confirmedLanguages: [...confirmed.languages, ...factLanguages],
    candidateLanguageLevels, allTokens, roleText: titleText.join(' '), profileText };
}

function jobText(job) {
  return [job?.title, job?.category, job?.sector, job?.description, job?.requirements].filter(Boolean).join(' ');
}

function roleSignals(value) {
  const text = normalize(value)
    .replace(/\b(?:it|de|fr|en|ch)\s*(?:\/|,|&)\s*(?:it|de|fr|en|ch)\b/g, ' ')
    .replace(/\b(?:it|de|fr|en|ch)\s+(?:it|de|fr|en|ch)\b/g, ' ')
    .replace(/\btake it\b/g, ' ');
  const hasTechnology = /\b(?:ict|cio|technology|technologies|technologie|informatica|informatique|informatik|information technology)\b/.test(text)
    || /\bit\b/.test(text);
  const hasManagement = /\b(?:manager|management|head|director|directeur|directrice|direttore|responsabile|responsable|leiter|leitung|chief|cio)\b/.test(text);
  const hasApplications = /\b(?:application|applications|applicativo|applicativi|applicative|business systems|enterprise systems)\b/.test(text);
  const hasStrategy = /\b(?:strategy|strategic|operating model|governance|portfolio)\b/.test(text);
  const signals = new Set();
  if (/\b(?:sales|commerciale|commerciali|venditore|venditrice|consulente vendita|addett[oa] vendite|account executive|business development|vertrieb)\b/.test(text)) signals.add('commercial_sales');
  if (/\b(?:hr|human resources|risorse umane|recruiter|recruiting|consulente del personale|personalberater)\b/.test(text)) signals.add('recruiting');
  if (hasTechnology && hasManagement) signals.add('technology_management');
  if (hasTechnology && hasApplications) signals.add('enterprise_applications');
  if (hasApplications && hasManagement) signals.add('application_management');
  if (hasTechnology && hasStrategy) signals.add('technology_strategy');
  return signals;
}

function specialtyPenalty(jobTitle, candidateProfileText, candidateRoles, jobRoles) {
  const title = normalize(jobTitle);
  let penalty = 0;
  for (const pattern of SPECIALTY_MISMATCHES) {
    if (pattern.test(title) && !pattern.test(candidateProfileText)) penalty += 24;
  }
  if (candidateRoles.has('technology_management')
    && !jobRoles.has('technology_management')
    && !jobRoles.has('application_management')) penalty += 22;
  return Math.min(penalty, 42);
}

function overlap(left, right) {
  return [...left].filter((value) => right.has(value));
}

function firstLanguageMention(value) {
  let first = null;
  for (const [language, pattern] of Object.entries(LANGUAGE_ALIASES)) {
    const match = new RegExp(pattern.source).exec(value);
    if (match && (!first || match.index < first.match.index)) first = { language, match };
  }
  return first;
}

function nextLanguageOffset(value) {
  return firstLanguageMention(value)?.match.index ?? value.length;
}

function nextLanguageHasRequirementContext(clause, afterStart, afterFull) {
  const next = firstLanguageMention(afterFull);
  if (!next) return false;

  const untrimmedAfter = clause.slice(afterStart);
  const leadingWhitespace = untrimmedAfter.length - untrimmedAfter.trimStart().length;
  const position = afterStart + leadingWhitespace + next.match.index;
  const before = clause.slice(Math.max(0, position - 80), position);
  const followingText = clause.slice(position + next.match[0].length).trim();
  const after = followingText.slice(0, nextLanguageOffset(followingText)).trim();
  if (/\b(?:not|never|no|without|non|nicht|kein(?:e|en)?|pas|sans)\s*$/.test(before)
    || NEGATED_LANGUAGE_CONTEXT_BEFORE.test(before)
    || NEGATED_LANGUAGE_CONTEXT_AFTER.test(after)) return false;

  return /kenntnisse/.test(next.match[0])
    || LANGUAGE_REQUIREMENT_CONTEXT_AFTER.test(after)
    || ((LANGUAGE_SKILL_CONTEXT_AFTER.test(after) || hasLanguageContextBefore(before))
      && (!after || LANGUAGE_CONTEXT_CONTINUATION.test(after)));
}

function hasLanguageContextBefore(value) {
  return LANGUAGE_SKILL_CONTEXT_BEFORE.test(value) || LANGUAGE_REQUIREMENT_CONTEXT_BEFORE.test(value);
}

function isLanguageRequirement(clause, match) {
  const before = clause.slice(Math.max(0, match.index - 80), match.index);
  const afterStart = match.index + match[0].length;
  const afterFull = clause.slice(afterStart).trim();
  const after = afterFull.slice(0, nextLanguageOffset(afterFull)).trim();
  const negatedBefore = /\b(?:not|never|no|without|non|nicht|kein(?:e|en)?|pas|sans)\s*$/.test(before)
    || NEGATED_LANGUAGE_CONTEXT_BEFORE.test(before);
  const negatedAfter = NEGATED_LANGUAGE_CONTEXT_AFTER.test(after);
  if (negatedBefore || negatedAfter) return false;
  const hasLanguageHeading = LANGUAGE_SECTION_HEADING.test(clause);
  if (/kenntnisse/.test(match[0])) return true;
  if (hasLanguageHeading && !NEGATED_LANGUAGE_CONTEXT_AFTER.test(afterFull)) return true;

  const hasSkillContextBefore = hasLanguageContextBefore(before);
  const afterIsSkillCue = LANGUAGE_SKILL_CONTEXT_AFTER.test(after);
  const afterIsRequirement = LANGUAGE_REQUIREMENT_CONTEXT_AFTER.test(after);
  const afterIsCompatible = !after || LANGUAGE_CONTEXT_CONTINUATION.test(after);
  const continuesLanguageList = /^(?:and|or|e|et|und)\b/.test(after) || (!after && Boolean(afterFull));

  return afterIsRequirement
    || (afterIsSkillCue && afterIsCompatible)
    || (hasSkillContextBefore && afterIsCompatible)
    || (continuesLanguageList && nextLanguageHasRequirementContext(clause, afterStart, afterFull));
}

function languageSignals(value, { requireContext = false } = {}) {
  const signals = new Set();
  const values = Array.isArray(value) ? value : [value];
  const clauses = values.flatMap((entry) => requireContext
    ? String(entry || '').split(/[\n.;!?•|]+/).map(normalize).filter(Boolean)
    : [normalize(entry)]);
  for (const clause of clauses) {
    for (const [language, pattern] of Object.entries(LANGUAGE_ALIASES)) {
      if (!requireContext) {
        if (pattern.test(clause)) signals.add(language);
        continue;
      }
      const matcher = new RegExp(pattern.source, 'g');
      for (const match of clause.matchAll(matcher)) {
        if (isLanguageRequirement(clause, match)) signals.add(language);
      }
    }
  }
  return signals;
}

function languageMentionIsNegated(text, language) {
  const pattern = LANGUAGE_ALIASES[language];
  if (!pattern) return false;
  const normalized = normalize(text);
  const matcher = new RegExp(pattern.source, 'g');
  for (const match of normalized.matchAll(matcher)) {
    const before = normalized.slice(Math.max(0, match.index - 60), match.index)
      .split(/\b(?:but|however|although|though)\b/).at(-1).trim();
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 32);
    if (/\b(?:not|no|never|without|non|nicht|kein(?:e|en)?|pas|sans)\b(?:\s+\w+){0,5}\s*$/.test(before)
      || /^\s*(?:not|no|never|without|non|nicht|kein(?:e|en)?|pas|sans)\b/.test(after)) return true;
  }
  return false;
}

function candidateLanguageAnswerSignals(question, answer) {
  const answerText = normalize(answer);
  if (/^(?:no|non|nein|pas|not|false|0)\b/.test(answerText)) return [];
  const answerSignals = languageSignals(answerText);
  const questionSignals = languageSignals(question);
  const affirmativeOrLevel = /^(?:yes|si|ja|oui|true)\b/.test(answerText)
    || /\b(?:a[1-2]|b[1-2]|c[1-2]|native|fluent|beginner|elementary|intermediate|advanced|proficient|professional|conversational|business)\b/.test(answerText);
  const resolvedLanguages = answerSignals.size ? answerSignals
    : affirmativeOrLevel && questionSignals.size === 1 ? questionSignals : new Set();
  return [...resolvedLanguages]
    .filter(language => !languageMentionIsNegated(answerText, language) && !languageMentionIsNegated(question, language))
    .map(language => LANGUAGE_LABELS[language] || language);
}

function normalizeLanguageLevel(answer) {
  const value = normalize(answer);
  if (/\b(?:native|mother tongue|madrelingua|muttersprach|lingua materna)\b/.test(value)) return 'native';
  if (/\b(?:fluent|fluente|fliessend|courant|verhandlungssicher)\b/.test(value)) return 'fluent';
  if (/\b(?:professional|professionale|professionnel|beruflich|business)\b/.test(value)) return 'professional';
  if (/\b(?:conversational|conversazionale|conversationnel|conversacional)\b/.test(value)) return 'conversational';
  if (/\b(?:intermediate|intermedio|intermediaire|mittelstufe)\b/.test(value)) return 'intermediate';
  if (/\b(?:beginner|elementary|basic|principiante|base|grundkenntnisse)\b/.test(value)) return 'basic';
  return value.match(/\b(?:a1|a2|b1|b2|c1|c2)\b/)?.[0] || '';
}

function languageLevelRankingPenalty(job, languageLevels) {
  const rank = { basic: 1, a1: 1, a2: 2, conversational: 2, b1: 3, intermediate: 3, b2: 4, c1: 5,
    fluent: 5, professional: 5, c2: 6, native: 7 };
  const clauses = [job?.title, job?.description, job?.requirements, ...(Array.isArray(job?.languages) ? job.languages : [job?.languages])].filter(Boolean)
    .flatMap(value => String(value).split(/[\n.;!?•|]+/)).map(normalize).filter(Boolean);
  const levelsByLanguage = new Map();
  for (const entry of Array.isArray(languageLevels) ? languageLevels : []) {
    const level = rank[normalizeLanguageLevel(entry?.level)];
    const language = entry?.language;
    if (level && LANGUAGE_ALIASES[language]) levelsByLanguage.set(language, Math.max(level, levelsByLanguage.get(language) || 0));
  }
  let penalty = 0;
  for (const [language, candidateLevel] of levelsByLanguage) {
    const languagePattern = LANGUAGE_ALIASES[language];
    const requiredLevel = clauses.reduce((highest, clause) => {
      const matcher = new RegExp(languagePattern.source, 'g');
      for (const mention of clause.matchAll(matcher)) {
        if (!isLanguageRequirement(clause, mention)) continue;
        const tail = clause.slice(mention.index + mention[0].length);
        const before = clause.slice(Math.max(0, mention.index - 40), mention.index);
        const levelText = `${before} ${tail}`;
        const cefr = levelText.match(/\b(c2|c1|b2|b1|a2|a1)\b/);
        const explicit = cefr?.[1] || (/\b(?:native|mother tongue|fluent|business fluent|professional proficiency|excellent|proficient|verhandlungssicher)\b/.test(levelText)
          ? 'professional' : '');
        highest = Math.max(highest, rank[explicit] || 0);
      }
      return highest;
    }, 0);
    if (requiredLevel > candidateLevel) penalty += Math.min(4, (requiredLevel - candidateLevel) * 2);
  }
  return Math.min(8, penalty);
}

/** Pure scorer exported for tests and future ranking improvements. */
export function scoreJobForProfile(job, profile, candidateLocation = '', matchSignals = {}) {
  const candidate = profileEvidence(profile, matchSignals);
  if (!candidate.allTokens.size && !candidate.roleText && !candidate.confirmedSkillTokens.size && !candidate.confirmedExperienceTokens.size) return { score: 0, reasons: [] };
  const jobTitle = [job?.title, job?.category, job?.sector].filter(Boolean).join(' ');
  const titleTokens = tokenize(jobTitle);
  const allJobTokens = tokenize(jobText(job));
  const candidateRoles = roleSignals(candidate.roleText);
  const jobRoles = roleSignals(job?.title || '');
  const roleMatches = overlap(candidateRoles, jobRoles);
  const profileLanguages = new Set(candidate.profileLanguages
    .flatMap((value) => [...languageSignals(value)]));
  const candidateLanguages = new Set(candidate.languages.flatMap((value) => [...languageSignals(value)]));
  // Count languages only when the listing states a language requirement or
  // proficiency. A passing mention of a country or language is not evidence.
  const jobLanguageText = [job?.title, job?.description, job?.requirements].filter(Boolean);
  const explicitJobLanguages = Array.isArray(job?.languages)
    ? job.languages
    : typeof job?.languages === 'string' ? [job.languages] : [];
  const jobLanguages = new Set([
    ...languageSignals(jobLanguageText, { requireContext: true }),
    ...languageSignals(explicitJobLanguages),
  ]);
  const languageMatches = overlap(candidateLanguages, jobLanguages);
  const profileLanguageMatches = overlap(profileLanguages, jobLanguages);
  const confirmedLanguageSet = new Set(candidate.confirmedLanguages.flatMap((value) => [...languageSignals(value)]));
  const confirmedLanguageMatches = overlap(confirmedLanguageSet, jobLanguages);
  // Composite role signals already account for their anchor terms; do not
  // award the same IT/application words twice as plain title overlap.
  const roleCoveredTokens = new Set([
    ...(roleMatches.includes('technology_management') ? ['it'] : []),
    ...(roleMatches.includes('enterprise_applications') || roleMatches.includes('application_management') ? ['application'] : []),
  ]);
  const skillMatches = overlap(candidate.skillTokens, allJobTokens);
  const confirmedSkillMatches = overlap(candidate.confirmedSkillTokens, allJobTokens)
    .filter(token => !candidate.skillTokens.has(token));
  const titleMatches = overlap(candidate.titleTokens, titleTokens)
    .filter((token) => !candidate.skillTokens.has(token) && !roleCoveredTokens.has(token));
  const titleInBody = [...candidate.titleTokens]
    .filter((token) => !candidate.skillTokens.has(token) && !roleCoveredTokens.has(token) && !titleTokens.has(token) && allJobTokens.has(token));
  const rawExperienceMatches = overlap(candidate.experienceTokens, allJobTokens);
  const confirmedExperienceMatches = overlap(candidate.confirmedExperienceTokens, allJobTokens)
    .filter(token => !candidate.skillTokens.has(token) && !candidate.titleTokens.has(token) && !candidate.experienceTokens.has(token));
  const letterEvidenceMatches = overlap(candidate.letterEvidenceTokens, allJobTokens)
    .filter(token => !candidate.skillTokens.has(token) && !candidate.titleTokens.has(token)
      && !candidate.experienceTokens.has(token) && !candidate.confirmedSkillTokens.has(token)
      && !candidate.confirmedExperienceTokens.has(token));
  const experienceMatches = rawExperienceMatches
    .filter((token) => !candidate.skillTokens.has(token) && !candidate.titleTokens.has(token) && allJobTokens.has(token));
  // Candidate answers and fact-checked letters can add evidence; language
  // overlap alone still cannot create a proposal.
  if (!skillMatches.length && !rawExperienceMatches.length && !confirmedSkillMatches.length
    && !confirmedExperienceMatches.length && !letterEvidenceMatches.length) return { score: 0, reasons: [] };
  const experienceInTitle = experienceMatches.filter((token) => titleTokens.has(token));
  const experienceInBody = experienceMatches.filter((token) => !titleTokens.has(token));
  const skillPoints = skillMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 16 : 9), 0);
  const titlePoints = titleMatches.length * 12 + titleInBody.length * 4;
  const experiencePoints = experienceInTitle.length * 7 + experienceInBody.length * 2;
  const confirmedAnswerPoints = Math.min(16, confirmedSkillMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 8 : 4), 0)
    + confirmedExperienceMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 5 : 2), 0));
  const letterEvidencePoints = Math.min(32, letterEvidenceMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 8 : 4), 0));
  const rolePoints = roleMatches.reduce((sum, role) => sum + ROLE_SIGNAL_POINTS[role], 0);
  const languagePoints = Math.min(8, languageMatches.length * 4);
  const letterPreferenceTokens = matchSignals.letterPreferenceTokens instanceof Set
    ? matchSignals.letterPreferenceTokens : new Set(matchSignals.letterPreferenceTokens || []);
  const letterPreferenceMatches = overlap(letterPreferenceTokens, allJobTokens)
    .filter(token => !candidate.letterEvidenceTokens.has(token));
  const letterPreferencePoints = Math.min(10, letterPreferenceMatches.length * 2);
  const locationPoints = locationMatchPoints(candidateLocation, job);
  const languageRankingPenalty = languageLevelRankingPenalty(job, candidate.candidateLanguageLevels);
  const relevanceScore = Math.max(0, Math.min(99,
    Math.min(48, skillPoints) + Math.min(36, titlePoints) + Math.min(12, experiencePoints) + confirmedAnswerPoints + letterEvidencePoints
      + Math.min(58, rolePoints) + languagePoints
      - specialtyPenalty(jobTitle, candidate.profileText, candidateRoles, jobRoles),
  ));
  if (relevanceScore < MIN_MATCH_SCORE) return { score: 0, reasons: [] };
  const rankScore = relevanceScore + locationPoints + letterPreferencePoints - languageRankingPenalty;
  const score = Math.min(99, relevanceScore + locationPoints);

  const reasons = [];
  if (roleMatches.length) reasons.push('Ruolo compatibile: ' + roleMatches.map((role) => ROLE_SIGNAL_LABELS[role]).join(', '));
  if (confirmedSkillMatches.length || confirmedExperienceMatches.length) {
    reasons.push('Competenze o qualifiche confermate nelle risposte');
  }
  if (letterEvidenceMatches.length) reasons.push('Competenze emerse dalle lettere inviate e controllate');
  if (confirmedLanguageMatches.length) reasons.push('Lingue confermate: ' + confirmedLanguageMatches.map((language) => LANGUAGE_LABELS[language]).join(', '));
  if (letterPreferenceMatches.length) reasons.push('Interessi professionali ricorrenti nelle lettere inviate');
  if (locationPoints) reasons.push('Località vicina alla zona di residenza');
  if (skillMatches.length) reasons.push('Competenze nel CV: ' + skillMatches.slice(0, 4).join(', '));
  if (!confirmedLanguageMatches.length && profileLanguageMatches.length) {
    reasons.push('Lingue richieste: ' + profileLanguageMatches.map((language) => LANGUAGE_LABELS[language]).join(', '));
  }
  const titleEvidence = [...titleMatches, ...titleInBody]
    .filter((token) => token !== 'it' && !(token === 'application' && roleMatches.includes('enterprise_applications')));
  if (titleEvidence.length) reasons.push('Ambiti presenti nel CV: ' + titleEvidence.slice(0, 4).join(', '));
  if (!titleEvidence.length && experienceMatches.length) reasons.push('Esperienza pertinente: ' + experienceMatches.slice(0, 4).join(', '));
  return {
    score,
    // Keep the uncapped composite for sorting so proximity still matters when
    // the user-facing percentage reaches 99.
    rankScore,
    reasons: reasons.slice(0, 3),
    evidenceStrength: skillMatches.length * 3 + confirmedSkillMatches.length * 3 + roleMatches.length * 2
      + titleMatches.length + experienceMatches.length + confirmedExperienceMatches.length + letterEvidenceMatches.length * 2 + languageMatches.length,
  };
}

function validJobUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function jobUrl(job) {
  return job?.applyUrl || job?.url || job?.jobUrl || job?.canonicalUrl || '';
}

async function fetchJobs(url = process.env.APPLICATION_CONCIERGE_JOB_INDEX_URL || DEFAULT_JOB_INDEX_URL, signal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`job_index_http_${response.status}`);
    const value = await response.json();
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.jobs)) return value.jobs;
    throw new Error('job_index_invalid_shape');
  } finally {
    clearTimeout(timer);
  }
}

function stableJobIdentity(job, url) {
  // The listing URL is the atomic de-duplication key across index snapshots;
  // provider IDs can change while the same public listing remains live.
  const value = [jobUrl(job), url, job?.id, job?.jobId, job?.slug, job?.canonicalUrl]
    .find((candidate) => String(candidate || '').trim());
  return String(value || url || `${job?.company || ''}|${job?.title || ''}|${job?.location || ''}`).trim();
}

export function eligibilityRetryContext(scanContext, job, postingFingerprint = '') {
  const sourceInputs = [
    job?.id, job?.jobId, job?.slug, job?.canonicalUrl, job?.url, job?.applyUrl,
    job?.title, job?.company, job?.companyKey, job?.location, job?.category, job?.sector,
    job?.description, job?.requirements, job?.education, job?.employmentType, job?.jobType,
    job?.contractType, job?.experience, job?.experienceLevel, job?.languages, job?.dateModified,
    job?.validThrough, job?.validThroughSource, job?.status, job?.active, job?.isActive,
  ];
  const sourceFingerprintHash = createHash('sha256');
  for (const value of sourceInputs) {
    const boundedValue = Array.isArray(value)
      ? `${value.length}:${value.slice(0, 64).map(item => String(item ?? '').slice(0, 4_000)).join('\0')}`
      : typeof value === 'string'
        ? `${value.length}:${value.slice(0, 4_000)}`
        : String(value ?? '').slice(0, 1_000);
    sourceFingerprintHash.update(boundedValue).update('\0');
  }
  const sourceFingerprint = sourceFingerprintHash.digest('hex');
  const postingSourceFingerprint = /^[a-f0-9]{64}$/i.test(String(postingFingerprint || ''))
    ? String(postingFingerprint).toLowerCase()
    : '';
  return createHash('sha256').update(`${scanContext}|${sourceFingerprint}|${postingSourceFingerprint}`).digest('hex');
}

/**
 * Proposal IDs are stable across retries and concurrent trigger delivery.
 * Hashing keeps source IDs/URLs out of the Firestore document path while
 * scoping the same listing independently for each concierge service.
 */
export function proposalDocumentId(serviceId, job, url = jobUrl(job)) {
  const identity = stableJobIdentity(job, url);
  return `job-${createHash('sha256').update(`${serviceId}|${identity}`).digest('hex').slice(0, 40)}`;
}

export function shouldRunApplicationConciergeMatchingForServiceUpdate(before, after) {
  if (!after?.cvStorageKey) return false;
  return before?.cvStorageKey !== after.cvStorageKey
    || String(before?.applicantLocation || '').trim() !== String(after.applicantLocation || '').trim()
    || Number(before?.matchingFeedbackRevision || 0) !== Number(after.matchingFeedbackRevision || 0)
    || Number(before?.eligibilityFactsRevision || 0) !== Number(after.eligibilityFactsRevision || 0)
    || Number(before?.acceptedPositionsCount || 0) !== Number(after.acceptedPositionsCount || 0);
}

const FEATURE_WEIGHTS = Object.freeze({ role: 8, location: 2, contract: 2, schedule: 2, sector: 2, seniority: 2 });
const DECLINE_WEIGHTS = Object.freeze({ role: 6, location: 4, contract: 4, schedule: 4, sector: 4, seniority: 4 });
const DECLINE_REASONS = new Set(Object.keys(DECLINE_WEIGHTS));

export function rankingFeaturesForJob(job = {}) {
  const jobType = [job.employmentType, job.jobType, job.contractType].filter(Boolean).join(' ');
  const schedule = [job.workSchedule, job.schedule, job.workingTime, job.employmentPercentage, job.workload]
    .filter(Boolean).join(' ');
  const seniority = [job.seniority, job.experienceLevel, job.experience, job.title || job.jobTitle].filter(Boolean).join(' ');
  return {
    // Persist only Firestore-supported primitives; Set instances are used only
    // transiently while calculating overlap.
    role: [...tokenize(job.title || job.jobTitle)],
    roleSignals: [...roleSignals(job.title || job.jobTitle || '')],
    location: [...tokenize([job.location, job.canton, job.workplace].filter(Boolean).join(' '))],
    contract: rankingTokens(jobType, [
      ['full_time', /\b(?:full time|fulltime|vollzeit|tempo pieno|temps plein)\b/],
      ['part_time', /\b(?:part time|parttime|teilzeit|tempo parziale|temps partiel)\b/],
      ['temporary', /\b(?:temporary|temporar|temporaneo|temporanea|temporaire|befristet)\b/],
      ['permanent', /\b(?:permanent|unbefristet|indeterminato|indeterminata|indetermine)\b/],
      ['internship', /\b(?:internship|stage|praktikum|tirocinio|stagiaire)\b/],
    ]),
    schedule: rankingTokens(schedule, [
      ['weekend', /\b(?:weekends?|fine settimana|week-end)\b/],
      ['night_shift', /\b(?:night|night shift|notturno|notturna|nacht|nuits?)\b/],
      ['day_shift', /\b(?:day shift|daytime|diurno|diurna|tagschicht|journee)\b/],
      ['rotating_shift', /\b(?:rotating shifts?|turni|schichtarbeit|horaires alternants)\b/],
      ['remote', /\b(?:remote|remoto|remota|telelavoro|telerilavoro|home office|homeoffice)\b/],
    ]),
    sector: [...tokenize([job.sector, job.category].filter(Boolean).join(' '))],
    seniority: rankingSignals(seniority, [
      ['entry_level', /\b(?:entry level|graduate|trainee|apprentice|junior|neolaureat[oa]|tirocinante|praktikant)\b/],
      ['mid_level', /\b(?:mid level|intermediate|intermedio|intermedia|mittlere erfahrung)\b/],
      ['senior_level', /\b(?:senior|experienced|esperto|esperta|experimente)\b/],
      ['executive_level', /\b(?:executive|director|direttore|direttrice|directeur|directrice|vorstand)\b/],
      ['experience_3plus', /\b(?:[3-9]|[1-9]\d+)\s*(?:years?|ans?|anni|jahre)\b/],
      ['experience_5plus', /\b(?:[5-9]|[1-9]\d+)\s*(?:years?|ans?|anni|jahre)\b/],
      ['experience_10plus', /\b(?:1\d|[2-9]\d+)\s*(?:years?|ans?|anni|jahre)\b/],
    ]),
  };
}

function proposalFeatureSignals(proposal) {
  const stored = proposal?.rankingFeatures;
  if (stored && typeof stored === 'object') return stored;
  return rankingFeaturesForJob(proposal || {});
}

function acceptedSignals(proposals) {
  return (Array.isArray(proposals) ? proposals : [])
    .filter(proposal => proposal?.status === 'accepted' && !proposal.withdrawnAt)
    .sort((left, right) => timestampMillis(right.acceptedAt) - timestampMillis(left.acceptedAt))
    .slice(0, 3)
    .map(proposalFeatureSignals);
}

function declinedSignals(proposals) {
  return (Array.isArray(proposals) ? proposals : [])
    .filter(proposal => proposal?.status === 'declined' && !proposal.withdrawnAt)
    .sort((left, right) => timestampMillis(right.declinedAt) - timestampMillis(left.declinedAt))
    .slice(0, 8)
    .map(proposal => ({ reason: DECLINE_REASONS.has(proposal.declineReason) ? proposal.declineReason : '', features: proposalFeatureSignals(proposal) }));
}

export function rankingFeedbackContext(proposals) {
  return {
    accepted: acceptedSignals(proposals),
    declined: declinedSignals(proposals),
  };
}

function sameFeature(left, right, key) {
  return overlap(new Set(left?.[key] || []), new Set(right?.[key] || [])).length > 0;
}

function sameRole(left, right) {
  return overlap(new Set(left?.role || []), new Set(right?.role || [])).length >= 2
    || overlap(new Set(left?.roleSignals || []), new Set(right?.roleSignals || [])).length > 0;
}

/** Accepted roles provide a positive ranking signal only. */
export function approvedRolePreference(job, proposals) {
  const candidate = rankingFeaturesForJob(job);
  const accepted = acceptedSignals(proposals);
  let positive = 0;
  for (const [feature, weight] of Object.entries(FEATURE_WEIGHTS)) {
    const matched = accepted.some(signal => feature === 'role'
      ? sameRole(candidate, signal)
      : sameFeature(candidate, signal, feature));
    if (matched) positive += weight;
  }
  return Math.min(18, positive);
}

/** Candidate feedback affects ordering only and never changes eligibility. */
export function rankingFeedbackPreference(job, proposals) {
  const candidate = rankingFeaturesForJob(job);
  const declined = declinedSignals(proposals);
  let negative = 0;
  for (const decline of declined) {
    if (decline.reason) {
      const matchesReason = decline.reason === 'role'
        ? sameRole(candidate, decline.features)
        : sameFeature(candidate, decline.features, decline.reason);
      if (matchesReason) negative += DECLINE_WEIGHTS[decline.reason];
    } else if (sameRole(candidate, decline.features)) {
      // A reasonless decline is only a very weak, local ranking signal.
      negative += 1;
    }
  }
  return Math.max(-12, approvedRolePreference(job, proposals) - negative);
}

function letterPreferenceTokens(text, excludedTokens) {
  return [...tokenize(text)].filter(token => !excludedTokens.has(token) && !LETTER_PREFERENCE_STOP_WORDS.has(token)).slice(0, 40);
}

function letterEvidenceTokens(text, excludedTokens) {
  return [...tokenize(text)].filter(token => !excludedTokens.has(token)
    && !LETTER_EVIDENCE_STOP_WORDS.has(token) && languageSignals(token).size === 0).slice(0, 100);
}

function submittedLetterText(draft) {
  const paragraphs = Array.isArray(draft?.coverLetter?.paragraphs) ? draft.coverLetter.paragraphs : [];
  return paragraphs.map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 8_000);
}

async function loadSubmittedAcceptedLetters({ db, proposals, serviceId, userId, nowMs }) {
  const accepted = proposals.map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter(proposal => proposal.status === 'accepted' && !proposal.withdrawnAt
      && typeof proposal.childApplicationId === 'string' && proposal.childApplicationId.trim()
      && !proposal.childApplicationId.includes('/'));
  const rows = await Promise.all(accepted.map(async proposal => {
    const orderId = proposal.childApplicationId;
    const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
    let childSnapshot; let flowSnapshot; let draftSnapshot;
    try {
      [childSnapshot, flowSnapshot, draftSnapshot] = await Promise.all([
        childRef.get(),
        childRef.collection('automation').doc('flow').get(),
        childRef.collection('ai_drafts').doc('current').get(),
      ]);
    } catch {
      return null;
    }
    const child = childSnapshot.data() || {};
    const flow = flowSnapshot.data() || {};
    const draft = draftSnapshot.data() || {};
    const retentionDueAt = retentionPurgeDueAt(child);
    const sentLetterKey = String(draft.sent?.letterKey || '');
    if (!childSnapshot.exists || child.userId !== userId || child.parentServiceId !== serviceId
      || child.parentProposalId !== proposal.id || child.billingMode !== 'application_concierge'
      || child.submissionStatus !== 'submitted' || child.retentionPurgingAt != null || child.retentionPurgedAt != null
      || child.retentionPayloadPurgedAt != null || (retentionDueAt != null && nowMs >= retentionDueAt)
      || flow.retentionPurgingAt != null || flow.retentionPurgedAt != null || flow.state !== 'submitted'
      || Number(draft.round) !== (Number(flow.round) || 1)
      || (draft.factCheck?.ok !== true && !factCheckAcknowledged(draft))
      || !Number(draft.sent?.at) || Number(draft.sent.at) > nowMs
      || !sentLetterKey.startsWith(`assisted-application-uploads/${orderId}/`)) return null;
    const text = submittedLetterText(draft);
    if (text.length < 20) return null;
    const jobTitle = String(proposal.jobTitle || child.jobTitle || '');
    const companyName = String(proposal.companyName || child.companyName || '');
    return { jobTitle, companyName, text, factChecked: draft.factCheck?.ok === true };
  }));
  return rows.filter(Boolean);
}

async function loadConciergeMatchSignals({ db, serviceRef, service, serviceId, userId, profileRecord, proposals, nowMs }) {
  const answerEvidenceMap = profileRecord.applicationQuestionAnswerEvidence || {};
  const questionKeys = Object.entries(answerEvidenceMap)
    .filter(([, record]) => record?.scope === 'candidate' && record?.sourceKind === 'direct_user')
    .map(([key]) => key);
  let candidateAnswerEvidence = [];
  if (questionKeys.length) {
    try {
      const loadForCandidate = await loadCandidateAnswerEvidence({ db, profileRecord, userId, nowMs, questionKeys });
      candidateAnswerEvidence = loadForCandidate({}, { purpose: 'matching' }).answerEvidence;
    } catch {
      candidateAnswerEvidence = [];
    }
  }
  let candidateLanguageFacts = [];
  const purgeAt = timestampMillis(service?.eligibilityPurgeAt);
  if (purgeAt > nowMs && service.eligibilityPurgingAt == null && service.eligibilityPurgedAt == null) {
    try {
      const factsSnapshot = await serviceRef.collection('eligibility').doc(CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID).get();
      const facts = factsSnapshot.data() || {};
      if (facts.provenance === 'candidate_confirmed'
        && facts.schemaVersion === APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION
        && timestampMillis(facts.confirmedAt) > 0
        && timestampMillis(facts.confirmedAt) <= nowMs
        && Array.isArray(facts.languages)) {
        candidateLanguageFacts = facts.languages.map(item => ({
          languageCode: String(item?.languageCode || '').toLowerCase(),
          level: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(item?.level)
            ? item.level : ['native', 'unknown'].includes(item?.level) ? item.level : 'unknown',
        })).filter(item => LANGUAGE_CODE_SIGNALS[item.languageCode]);
      }
    } catch {
      candidateLanguageFacts = [];
    }
  }
  const letters = await loadSubmittedAcceptedLetters({ db, proposals, serviceId, userId, nowMs });
  const letterRows = letters.map(letter => ({
    ...letter,
    excludedTokens: new Set([...tokenize(letter.jobTitle), ...tokenize(letter.companyName)]),
  }));
  const letterPreferenceTokenSet = new Set(letterRows.flatMap(letter => letterPreferenceTokens(letter.text, letter.excludedTokens)));
  const letterEvidenceTokenSet = new Set(letterRows.filter(letter => letter.factChecked)
    .flatMap(letter => letterEvidenceTokens(letter.text, letter.excludedTokens)));
  const answerSignals = answerMatchEvidence(candidateAnswerEvidence);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    answers: {
      skills: [...answerSignals.skills].sort(),
      experience: [...answerSignals.experience].sort(),
      languages: answerSignals.languages.slice().sort(),
      languageLevels: answerSignals.languageLevels.slice().sort((left, right) =>
        `${left.language}:${left.level}`.localeCompare(`${right.language}:${right.level}`)),
    },
    candidateLanguageFacts: candidateLanguageFacts.map(item => [item.languageCode, item.level]).sort(([left], [right]) => left.localeCompare(right)),
    letterEvidence: [...letterEvidenceTokenSet].sort(),
    letterPreferences: [...letterPreferenceTokenSet].sort(),
  })).digest('hex');
  return { candidateAnswerEvidence, candidateAnswerSignals: answerSignals, candidateLanguageFacts,
    letterEvidenceTokens: letterEvidenceTokenSet, letterPreferenceTokens: letterPreferenceTokenSet, fingerprint };
}

function candidateAnswerProfileFingerprint(profileRecord) {
  const records = Object.entries(profileRecord?.applicationQuestionAnswerEvidence || {})
    .filter(([, record]) => record?.scope === 'candidate' && record?.sourceKind === 'direct_user')
    .map(([key, record]) => [key, String(record?.version || ''), String(record?.provenance?.orderId || ''),
      String(record?.category || ''), String(record?.question?.question || ''),
      String(record?.answer ?? ''), String(record?.fact?.type || ''), String(record?.fact?.subject || '')])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

/** Requeue active concierge services when verified candidate-scoped answers change. */
export async function queueConciergeMatchesForCandidateAnswerUpdate({ db, userId, before = null, after = null, eventTime = '', nowMs = Date.now() }) {
  const uid = String(userId || '').trim();
  if (!db || !uid || candidateAnswerProfileFingerprint(before) === candidateAnswerProfileFingerprint(after)) return 0;
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('userId', '==', uid).get();
  const active = (snapshot.docs || []).filter(doc => {
    const service = doc.data() || {};
    return Boolean(service.cvStorageKey && timestampMillis(service.consentedAt) > 0 && serviceIsActive(service, nowMs));
  });
  const eventAt = String(eventTime || '').trim();
  const eventMs = Date.parse(eventAt) || 0;
  if (!eventMs) return 0;
  let queued = 0;
  for (let offset = 0; offset < active.length; offset += 20) {
    const updates = await Promise.all(active.slice(offset, offset + 20).map(doc => db.runTransaction(async transaction => {
      const currentSnapshot = await transaction.get(doc.ref);
      const service = currentSnapshot.data() || {};
      if (!currentSnapshot.exists || !service.cvStorageKey || timestampMillis(service.consentedAt) <= 0 || !serviceIsActive(service, nowMs)) return false;
      const lastEventAt = String(service.matchingCandidateAnswerEventAt || '').trim();
      const lastEventMs = Date.parse(lastEventAt) || 0;
      if (lastEventAt && (lastEventMs > eventMs || (lastEventMs === eventMs && lastEventAt >= eventAt))) return false;
      transaction.set(doc.ref, {
        matchingCandidateAnswerEventAt: eventAt,
        matchingFeedbackRevision: FieldValue.increment(1),
        matchingStatus: 'queued', matchingError: null, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    })));
    queued += updates.filter(Boolean).length;
  }
  return queued;
}

/** Queue a ranking refresh only after an accepted concierge application's sent letter is proven. */
export async function queueSubmittedConciergeLetterFeedback({ db, orderId, nowMs = Date.now() }) {
  if (!db || typeof orderId !== 'string' || !orderId.trim() || orderId.includes('/')) return false;
  const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  return db.runTransaction(async transaction => {
    const childSnapshot = await transaction.get(childRef);
    if (!childSnapshot.exists) return false;
    const child = childSnapshot.data() || {};
    const serviceId = String(child.parentServiceId || '').trim();
    const proposalId = String(child.parentProposalId || '').trim();
    const purgeDueAt = retentionPurgeDueAt(child);
    if (child.billingMode !== 'application_concierge' || !child.userId || !serviceId || serviceId.includes('/')
      || !proposalId || proposalId.includes('/') || child.submissionStatus !== 'submitted'
      || child.retentionPurgingAt != null || child.retentionPurgedAt != null || child.retentionPayloadPurgedAt != null
      || (purgeDueAt != null && nowMs >= purgeDueAt)) return false;

    const flowRef = childRef.collection('automation').doc('flow');
    const draftRef = childRef.collection('ai_drafts').doc('current');
    const [flowSnapshot, draftSnapshot] = await Promise.all([transaction.get(flowRef), transaction.get(draftRef)]);
    const flow = flowSnapshot.data() || {};
    const draft = draftSnapshot.data() || {};
    const sentAt = Number(draft.sent?.at) || 0;
    const letterKey = String(draft.sent?.letterKey || '');
    const round = Number(draft.round) || 1;
    if (!flowSnapshot.exists || !draftSnapshot.exists || flow.state !== 'submitted'
      || Number(flow.round || 1) !== round || !Number.isFinite(sentAt) || sentAt <= 0 || sentAt > nowMs
      || !letterKey.startsWith(`assisted-application-uploads/${orderId}/`)
      || flow.retentionPurgingAt != null || flow.retentionPurgedAt != null
      || (draft.factCheck?.ok !== true && !factCheckAcknowledged(draft))) return false;

    const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
    const proposalRef = serviceRef.collection('proposals').doc(proposalId);
    const [serviceSnapshot, proposalSnapshot] = await Promise.all([transaction.get(serviceRef), transaction.get(proposalRef)]);
    const service = serviceSnapshot.data() || {};
    const proposal = proposalSnapshot.data() || {};
    if (!serviceSnapshot.exists || service.userId !== child.userId || timestampMillis(service.consentedAt) <= 0 || !serviceIsActive(service, nowMs)
      || !proposalSnapshot.exists || proposal.status !== 'accepted' || proposal.withdrawnAt
      || proposal.childApplicationId !== orderId) return false;

    const signature = createHash('sha256').update(JSON.stringify([orderId, round, sentAt, letterKey])).digest('hex');
    if (child.matchingLetterFeedbackSignature === signature) return false;
    transaction.set(childRef, { matchingLetterFeedbackSignature: signature }, { merge: true });
    transaction.set(serviceRef, { matchingFeedbackRevision: FieldValue.increment(1), matchingStatus: 'queued',
      matchingError: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

async function ensureOpenProposalCounter(db, serviceRef, fallbackCount) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(serviceRef);
    if (!snapshot.exists) return 0;
    const service = snapshot.data() || {};
    if (Number.isSafeInteger(Number(service.matchingOpenProposalCount))
      && Number(service.matchingOpenProposalCount) >= 0) return Number(service.matchingOpenProposalCount);
    const count = openProposalsCount({}, fallbackCount);
    transaction.set(serviceRef, { matchingOpenProposalCount: count }, { merge: true });
    return count;
  });
}

/** A bounded, durable frontier replaces the static top-40 window. */
export function conciergeMatchingWork(candidates, proposedUrls = new Set(), cursor = '', retryUrls = new Set(), recoveryUrls = [], deferredRecoveryUrls = new Set(), heldRetryUrls = retryUrls) {
  const priority = candidates.filter(candidate => proposedUrls.has(candidate.url)).slice(0, MAX_PROPOSALS_PER_RUN);
  const retries = candidates.filter(candidate => retryUrls.has(candidate.url) && !proposedUrls.has(candidate.url)).slice(0, MAX_ELIGIBILITY_RETRIES_PER_RUN);
  const priorityUrls = new Set([...priority, ...retries].map(candidate => candidate.url));
  const candidatesByUrl = new Map(candidates.map(candidate => [candidate.url, candidate]));
  const recovery = [...new Set(recoveryUrls)].map(url => candidatesByUrl.get(url))
    .filter(candidate => candidate && !priorityUrls.has(candidate.url));
  const recoveryUrlSet = new Set(recovery.map(candidate => candidate.url));
  const frontier = candidates.filter(candidate => !proposedUrls.has(candidate.url)
    && !deferredRecoveryUrls.has(candidate.url) && !recoveryUrlSet.has(candidate.url));
  const previous = frontier.findIndex(candidate => candidate.url === cursor);
  const start = previous >= 0 && previous + 1 < frontier.length ? previous + 1 : 0;
  const fresh = frontier.slice(start).filter(candidate => !heldRetryUrls.has(candidate.url));
  return { work: [...priority, ...retries, ...recovery, ...fresh].slice(0, MAX_ELIGIBILITY_WORK_PER_RUN),
    frontier, cursorUrls: new Set(fresh.map(candidate => candidate.url)) };
}

async function updateExistingProposal(db, serviceRef, ref, update, expectedStatus, nextStatus = null, fallbackOpenCount = 0) {
  return db.runTransaction(async (transaction) => {
    const [serviceSnapshot, snapshot] = await Promise.all([transaction.get(serviceRef), transaction.get(ref)]);
    if (!snapshot.exists) return false;
    const service = serviceSnapshot.data() || {};
    const current = snapshot.data() || {};
    if (current.status !== expectedStatus) return false;
    if (nextStatus === 'proposed' && current.status !== 'proposed') {
      const openCount = openProposalsCount(service, fallbackOpenCount);
      const cap = servicePositionLimit(service);
      if (!serviceIsActive(service) || acceptedPositionsCount(service) >= cap
        || openCount >= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS) return false;
      transaction.set(serviceRef, { matchingOpenProposalCount: openCount + 1 }, { merge: true });
    } else if (nextStatus && current.status === 'proposed' && nextStatus !== 'proposed') {
      const openCount = openProposalsCount(service, fallbackOpenCount);
      transaction.set(serviceRef, { matchingOpenProposalCount: Math.max(0, openCount - 1) }, { merge: true });
    }
    transaction.set(ref, {
      ...update,
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(nextStatus === 'retracted' ? {
        retractedAt: FieldValue.serverTimestamp(),
        retractionReason: update.retractionReason || (update.matchScore < MIN_MATCH_SCORE
          ? 'match_below_threshold'
          : update.eligibilityStatus && update.eligibilityStatus !== 'compatible'
            ? 'decisive_requirements_unverified'
            : 'match_below_threshold'),
      } : {}),
      ...(nextStatus === 'proposed' && current.status === 'retracted' ? { reactivatedAt: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });
    return true;
  });
}

async function updateLegacyRecoveryProposal(db, serviceRef, ref, update, expectedCvStorageKey, fallbackOpenCount = 0) {
  let appliedUpdate = null;
  const changed = await db.runTransaction(async (transaction) => {
    const [serviceSnapshot, snapshot] = await Promise.all([transaction.get(serviceRef), transaction.get(ref)]);
    const service = serviceSnapshot.data() || {};
    if (!serviceSnapshot.exists || !serviceIsActive(service) || service.cvStorageKey !== expectedCvStorageKey || !snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (!isLegacyUnverifiedRetraction(current)) return false;
    appliedUpdate = typeof update === 'function' ? update(current) : update;
    const cap = servicePositionLimit(service);
    if (appliedUpdate.status === 'proposed' && acceptedPositionsCount(service) >= cap) return false;
    const openCount = openProposalsCount(service, fallbackOpenCount);
    if (appliedUpdate.status === 'proposed' && current.status !== 'proposed') {
      if (openCount >= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS) return false;
      transaction.set(serviceRef, { matchingOpenProposalCount: openCount + 1 }, { merge: true });
    } else if (current.status === 'proposed' && appliedUpdate.status && appliedUpdate.status !== 'proposed') {
      transaction.set(serviceRef, { matchingOpenProposalCount: Math.max(0, openCount - 1) }, { merge: true });
    }
    transaction.set(ref, appliedUpdate, { merge: true });
    return true;
  });
  return changed ? appliedUpdate : null;
}

function expiryTimestamp(value, { calendarDateInclusive = false } = {}) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return Number(value?.toMillis?.());
  const normalized = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(normalized);
  if (dateOnly && calendarDateInclusive) {
    const [, year, month, day] = dateOnly;
    const startOfDate = Date.UTC(Number(year), Number(month) - 1, Number(day));
    const datePrefix = normalized.slice(0, 10);
    return new Date(startOfDate).toISOString().slice(0, 10) === datePrefix
      ? startOfDate + 86_400_000 - 1
      : Number.NaN;
  }
  return Date.parse(normalized);
}

function explicitlyClosedJob(job, nowMs = Date.now()) {
  const status = String(job?.status || '').trim().toLowerCase();
  if (['closed', 'expired', 'inactive', 'withdrawn', 'filled', 'retracted'].includes(status)) return true;
  if (job?.isActive === false || job?.active === false) return true;
  const archivedAt = expiryTimestamp(job?.expiredAt);
  if (Number.isFinite(archivedAt) && archivedAt > 0 && archivedAt <= nowMs) return true;
  // Only an employer-supplied validThrough is proof of closure. The build's
  // observation/type-cap deadlines are JobPosting metadata, not ATS evidence.
  if (job?.validThroughSource === 'source') {
    const validThrough = expiryTimestamp(job.validThrough, { calendarDateInclusive: true });
    if (Number.isFinite(validThrough) && validThrough > 0 && validThrough <= nowMs) return true;
  }
  return false;
}

function decisiveIncompatibility(result) {
  return result?.status === 'incompatible'
    && Array.isArray(result.gaps)
    && result.gaps.some(gap => gap?.knownMissing === true);
}

function canOfferClarification(result) {
  return result?.status === 'clarification_required'
    && Array.isArray(result.questions)
    && result.questions.some(question => question?.required === true && String(question.question || '').trim());
}

function safeEligibilityFailureReason(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'eligibility_provider_unavailable') return 'provider_unavailable';
  if (code === 'eligibility_invalid_json') return 'provider_invalid_json';
  if (code === 'eligibility_profile_incomplete') return 'profile_incomplete';
  return 'analysis_unavailable';
}

function readableTimestamp(value) {
  if (value == null) return null;
  const date = value?.toDate?.() || (value instanceof Date ? value : new Date(Number(value)));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function runApplicationConciergeMatching({ db = getAdminDb(), serviceId, jobIndexUrl, eligibility = null, deadlineMs = Date.now() + 480_000 } = {}) {
  const runStartedAt = Date.now();
  // The worker has 540s: cancel external reads/inference at 480s and reserve
  // a minute for durable proposals, retry metadata and completion writes.
  const eligibilitySignal = AbortSignal.timeout(Math.max(1, Math.min(480_000, deadlineMs - Date.now())));
  const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const serviceSnapshot = await serviceRef.get();
  if (!serviceSnapshot.exists) return { status: 'skipped', reason: 'service_not_found' };
  const service = serviceSnapshot.data() || {};
  if (!service.userId || service.paymentStatus !== 'paid' || !serviceIsActive(service)) return { status: 'skipped', reason: 'service_inactive' };

  if (acceptedPositionsCount(service) >= servicePositionLimit(service)) return { status: 'skipped', reason: 'position_limit_reached' };

  const profileSnapshot = await db.collection('user_cv_profiles').doc(service.userId).get();
  const profileRecord = profileSnapshot.exists ? profileSnapshot.data() || {} : {};
  const profile = profileRecord.profile || {};
  if (profileRecord.status !== 'ready' || !profile.searchText) {
    await serviceRef.set({ matchingStatus: 'needs_review', matchingError: null, matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'needs_review', reason: 'profile_not_ready' };
  }

  await serviceRef.set({ matchingStatus: 'running', matchingStartedAt: FieldValue.serverTimestamp(), matchingError: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  try {
    const jobs = (await fetchJobs(jobIndexUrl, eligibilitySignal)).map(normalizeConciergeJobRecord);
    const existingSnapshot = await serviceRef.collection('proposals').get();
    const existing = existingSnapshot.docs || [];
    const known = new Set(existing.map((doc) => {
      const data = doc.data() || {};
      return `${data.jobId || ''}|${data.jobUrl || ''}`;
    }));
    const available = Math.max(0, servicePositionLimit(service) - acceptedPositionsCount(service));
    const candidateLocation = String(service.applicantLocation || '').trim();
    const matchingNowMs = Date.now();
    const existingData = existing.map(doc => doc.data() || {});
    const matchSignals = await loadConciergeMatchSignals({ db, serviceRef, serviceId, userId: service.userId,
      profileRecord, proposals: existing, service, nowMs: matchingNowMs });
    const fallbackOpenCount = existingData.filter(data => data.status === 'proposed').length;
    await ensureOpenProposalCounter(db, serviceRef, fallbackOpenCount);
    const existingUrls = new Set(existingData.map(data => data.jobUrl).filter(Boolean));
    const excludedUrls = new Set(existingData.filter(data => !['proposed', 'retracted'].includes(data.status)).map(data => data.jobUrl));
    const rankedWork = jobs.map((job) => {
      const url = jobUrl(job);
      const scored = scoreJobForProfile(job, profile, candidateLocation, matchSignals);
      const preference = scored.score > 0 ? rankingFeedbackPreference(job, existingData) : 0;
      return { job, url, ...scored, rankScore: (scored.rankScore || 0) + preference };
    }).filter((entry) => entry.score > 0 && validJobUrl(entry.url) && !excludedUrls.has(entry.url)
      && !explicitlyClosedJob(entry.job, matchingNowMs))
      .sort((left, right) => right.rankScore - left.rankScore
        || right.score - left.score
        || right.evidenceStrength - left.evidenceStrength
        || String(right.job.datePosted || '').localeCompare(String(left.job.datePosted || ''))
        || left.url.localeCompare(right.url));
    const jobsByUrl = new Map(jobs.map((job) => [jobUrl(job), job]).filter(([url]) => Boolean(url)));
    const evaluate = eligibility || await prepareConciergeEligibility({ db, serviceRef, service, profileRecord, background: true, signal: eligibilitySignal });
    const checks = new Map();
    const rawEligibilityFactsRevision = Number(service.eligibilityFactsRevision);
    const eligibilityFactsRevision = Number.isSafeInteger(rawEligibilityFactsRevision) && rawEligibilityFactsRevision >= 0
      ? rawEligibilityFactsRevision
      : 0;
    const eligibilityContext = createHash('sha256').update(JSON.stringify([
      CONCIERGE_ELIGIBILITY_VERSION,
      service.cvStorageKey,
      profile,
      ...(eligibilityFactsRevision > 0 ? [eligibilityFactsRevision] : []),
    ])).digest('hex');
    // Candidate facts invalidate eligibility, while retry budgets stay scoped
    // to the stable CV/profile inputs and each listing's own fingerprint.
    const retryBudgetContext = createHash('sha256').update(JSON.stringify([
      CONCIERGE_ELIGIBILITY_VERSION,
      service.cvStorageKey,
      profile,
    ])).digest('hex');
    const rankingContext = createHash('sha256').update(JSON.stringify([
      APPLICATION_CONCIERGE_MATCHING_VERSION,
      service.cvStorageKey,
      profile,
      candidateLocation,
      rankingFeedbackContext(existingData),
      ...(eligibilityFactsRevision > 0 ? [eligibilityFactsRevision] : []),
      matchSignals.fingerprint,
    ])).digest('hex');
    const eligibilityRecoveryContext = createHash('sha256').update(JSON.stringify([
      CONCIERGE_ELIGIBILITY_VERSION,
      APPLICATION_CONCIERGE_MATCHING_VERSION,
      service.cvStorageKey,
      profile,
      candidateLocation,
      ...(eligibilityFactsRevision > 0 ? [eligibilityFactsRevision] : []),
    ])).digest('hex');
    const proposedUrls = new Set(existingData.filter(data => data.status === 'proposed').map(data => data.jobUrl));
    const recoveryRows = existing.map(doc => ({ id: doc.id, ref: doc.ref || doc, data: doc.data() || {} }));
    const retractionOwners = new Map();
    for (const row of recoveryRows.filter(row => row.data.status === 'retracted')
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
      const url = row.data.jobUrl;
      if (url && !proposedUrls.has(url) && !excludedUrls.has(url) && !retractionOwners.has(url)) retractionOwners.set(url, row.id);
    }
    const legacyRecovery = selectLegacyProposalRecovery(recoveryRows, {
      cursor: service.matchingLegacyRecoveryContext === eligibilityRecoveryContext ? service.matchingLegacyRecoveryCursor || '' : '',
      context: eligibilityRecoveryContext,
      nowMs: Date.now(),
    });
    const allLegacyRecoveryUrls = new Set(legacyRecovery.queued
      .filter(row => row.data.jobUrl && retractionOwners.get(row.data.jobUrl) === row.id)
      .map(row => row.data.jobUrl));
    const rankedCandidates = rankedWork.filter(entry => !known.has(`${entry.job.id || ''}|${entry.url}`)
      && !existingUrls.has(entry.url));
    const recoveryPreflight = new Map();
    const recoveryUrls = [];
    for (const row of legacyRecovery.selected) {
      if (row.data.jobUrl && (proposedUrls.has(row.data.jobUrl) || excludedUrls.has(row.data.jobUrl)
        || retractionOwners.get(row.data.jobUrl) !== row.id)) {
        recoveryPreflight.set(row.id, { kind: 'terminal', reason: 'duplicate_proposal' });
        continue;
      }
      const job = jobsByUrl.get(row.data.jobUrl);
      if (!job) {
        recoveryPreflight.set(row.id, { kind: 'retry', reason: 'listing_not_in_current_index' });
        continue;
      }
      if (explicitlyClosedJob(job, matchingNowMs)) {
        recoveryPreflight.set(row.id, { kind: 'terminal', reason: 'job_closed', job });
        continue;
      }
      const rescored = scoreJobForProfile(job, profile, candidateLocation, matchSignals);
      if (rescored.score < MIN_MATCH_SCORE) {
        recoveryPreflight.set(row.id, { kind: 'retry', reason: 'match_below_threshold' });
        continue;
      }
      recoveryPreflight.set(row.id, { kind: 'eligible', job, rescored });
      recoveryUrls.push(row.data.jobUrl);
    }
    const relevantUrls = new Set(rankedWork.map(entry => entry.url));
    const retryRows = await eligibilityRetryRows(serviceRef);
    const retryRowsByUrl = new Map();
    for (const retry of retryRows) {
      const url = retry.data()?.jobUrl;
      if (!url || !relevantUrls.has(url)) {
        await retry.ref.delete();
        continue;
      }
      retryRowsByUrl.set(url, retry);
    }
    const legacyFactsDependentReasons = new Set(['answer_source_conflict']);
    const retryScanContexts = new Map(rankedWork.map(({ job, url }) => {
      const retry = retryRowsByUrl.get(url)?.data() || {};
      const dependency = retry.candidateFactsDependency || {};
      const candidateFactsDependent = dependency.languages === true || dependency.answers === true
        || legacyFactsDependentReasons.has(retry.lastReason);
      return [url, candidateFactsDependent ? eligibilityContext : retryBudgetContext];
    }));
    const retryJobContexts = new Map(rankedWork.map(({ job, url }) =>
      [url, eligibilityRetryContext(retryScanContexts.get(url) || retryBudgetContext, job)]));
    const retryBudgetJobContexts = new Map(rankedWork.map(({ job, url }) => [url, eligibilityRetryContext(retryBudgetContext, job)]));
    const allRetryUrls = new Set(retryRowsByUrl.keys());
    const nowForRetries = Date.now();
    const retryCandidates = [...retryRowsByUrl.entries()].filter(([url, row]) => {
      const value = row.data() || {};
      const changedInputs = value.jobContext !== retryJobContexts.get(url);
      return changedInputs || (value.retryState !== 'exhausted' && Number(value.retryAt) <= nowForRetries);
    }).sort(([leftUrl, left], [rightUrl, right]) => {
      const leftChanged = left.data()?.jobContext !== retryJobContexts.get(leftUrl);
      const rightChanged = right.data()?.jobContext !== retryJobContexts.get(rightUrl);
      return Number(rightChanged) - Number(leftChanged)
        || (Number(left.data()?.retryAt) || 0) - (Number(right.data()?.retryAt) || 0)
        || leftUrl.localeCompare(rightUrl);
    });
    const selectedRetryCandidates = retryCandidates.slice(0, MAX_ELIGIBILITY_RETRIES_PER_RUN);
    const retrySourceFingerprints = new Map();
    const sourceProbeSlots = MAX_ELIGIBILITY_RETRIES_PER_RUN - selectedRetryCandidates.length;
    if (sourceProbeSlots > 0 && typeof evaluate.fingerprintFor === 'function') {
      const selectedUrls = new Set(selectedRetryCandidates.map(([url]) => url));
      const exhaustedToProbe = [...retryRowsByUrl.entries()]
        .filter(([url, row]) => !selectedUrls.has(url)
          && row.data()?.retryState === 'exhausted'
          && row.data()?.jobContext === retryJobContexts.get(url))
        .sort(([leftUrl, left], [rightUrl, right]) => {
          const leftData = left.data() || {};
          const rightData = right.data() || {};
          const leftAt = Number(leftData.lastAttemptAt) || Number(leftData.firstAttemptAt) || Number(leftData.retryExhaustedAt) || 0;
          const rightAt = Number(rightData.lastAttemptAt) || Number(rightData.firstAttemptAt) || Number(rightData.retryExhaustedAt) || 0;
          return leftAt - rightAt || leftUrl.localeCompare(rightUrl);
        });
      for (const [url, row] of exhaustedToProbe.slice(0, sourceProbeSlots)) {
        if (eligibilitySignal.aborted || Date.now() - runStartedAt > 280_000) break;
        const entry = rankedWork.find(candidate => candidate.url === url);
        if (!entry) continue;
        let fingerprint;
        try { fingerprint = await evaluate.fingerprintFor(entry.job); }
        catch { fingerprint = null; }
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) continue;
        const context = eligibilityRetryContext(retryScanContexts.get(url) || retryBudgetContext, entry.job, fingerprint);
        const previousFingerprint = row.data()?.fingerprint;
        const changed = typeof previousFingerprint === 'string'
          ? previousFingerprint !== fingerprint
          : row.data()?.context !== context;
        retrySourceFingerprints.set(url, { fingerprint: fingerprint.toLowerCase(), context, changed });
        if (changed) selectedRetryCandidates.push([url, row]);
      }
    }
    const retryUrls = new Set(selectedRetryCandidates.map(([url]) => url));
    const { work, frontier, cursorUrls } = conciergeMatchingWork(rankedWork, proposedUrls,
      service.matchingScanContext === rankingContext ? service.matchingScanCursor : '', retryUrls,
      recoveryUrls, allLegacyRecoveryUrls, allRetryUrls);
    let scannedCursor = service.matchingScanContext === rankingContext ? service.matchingScanCursor || '' : '';
    for (let offset = 0; offset < work.length; offset += 4) {
      // Stop starting batches early; the shared signal also bounds the last batch.
      if (Date.now() - runStartedAt > 280_000) break;
      const batch = work.slice(offset, offset + 4);
      await Promise.all(batch.map(async ({ job, url }) => {
        const retry = (await eligibilityRetryRef(serviceRef, url).get()).data();
        const retryJobContext = retryJobContexts.get(url) || eligibilityContext;
        const sourceFingerprint = retrySourceFingerprints.get(url);
        const sameJobContext = retry?.jobContext === retryJobContext;
        const retryInputsChanged = !sameJobContext || sourceFingerprint?.changed === true;
        let result;
        let shouldRecordRetry = true;
        if (!retryInputsChanged && retry?.retryState === 'exhausted') {
          result = { status: 'unverified', reason: retry.lastReason || 'unknown', fingerprint: retry.fingerprint || null };
          shouldRecordRetry = false;
        } else if (!retryInputsChanged && Number(retry?.retryAt) > Date.now()) {
          result = { status: 'unverified', reason: 'retry_backoff' };
          shouldRecordRetry = false;
        }
        else {
          try { result = await evaluate(job); }
          catch (error) {
            result = {
              status: 'unverified',
              reason: eligibilitySignal.aborted ? 'analysis_deferred' : safeEligibilityFailureReason(error),
              ...(typeof error?.eligibilityFingerprint === 'string' ? { fingerprint: error.eligibilityFingerprint } : {}),
              ...(typeof error?.eligibilitySourceFingerprint === 'string' ? { sourceFingerprint: error.eligibilitySourceFingerprint } : {}),
              ...(error?.candidateFactsDependency && typeof error.candidateFactsDependency === 'object'
                ? { candidateFactsDependency: error.candidateFactsDependency } : {}),
              ...(typeof error?.eligibilityCacheId === 'string' ? { cacheId: error.eligibilityCacheId } : {}),
              ...(Array.isArray(error?.providerFailures) ? { providerFailures: error.providerFailures } : {}),
            };
          }
        }
        if (!shouldRecordRetry && retry) {
          allRetryUrls.add(url);
          cursorUrls.delete(url);
        }
        if (result?.status === 'incompatible' && !decisiveIncompatibility(result)) {
          result = { ...result, status: 'unverified', reason: 'incompatibility_not_proven' };
        }
        if (shouldRecordRetry) {
          const retainedFingerprint = result?.fingerprint || sourceFingerprint?.fingerprint
            || (result?.reason === 'analysis_deferred' ? retry?.fingerprint : null);
          const retryContext = eligibilityRetryContext(retryScanContexts.get(url) || retryBudgetContext, job, retainedFingerprint);
          const retryBudgetJobContext = retryBudgetJobContexts.get(url) || retryBudgetContext;
          const retainedSourceFingerprint = result?.sourceFingerprint || retry?.sourceFingerprint || null;
          const retryBudgetSourceContext = eligibilityRetryContext(retryBudgetContext, job, retainedSourceFingerprint);
          const retryResult = retainedFingerprint && !result?.fingerprint
            ? { ...result, fingerprint: retainedFingerprint }
            : result;
          await recordEligibilityRetry({ db, serviceRef, url, result: retryResult, context: retryContext,
            jobContext: retryJobContext, budgetContext: retryBudgetSourceContext,
            budgetJobContext: retryBudgetJobContext, eligibilityFactsRevision, nowMs: Date.now() });
        }
        if (result?.reason === 'analysis_deferred') allRetryUrls.add(url);
        checks.set(url, result);
      }));
      // Unverified results are retained in the independent retry queue. They
      // cannot pin new discovery; budget-deferred work remains at the cursor.
      for (const entry of batch) {
        const result = checks.get(entry.url);
        if (result?.reason === 'analysis_deferred') break;
        if (cursorUrls.has(entry.url)) scannedCursor = entry.url;
      }
      await serviceRef.set({ matchingScanCursor: scannedCursor, matchingScanContext: rankingContext }, { merge: true });
      if (batch.some(entry => {
        const result = checks.get(entry.url);
        return result?.reason === 'analysis_deferred';
      })) break;
    }
    const candidates = rankedCandidates.filter(candidate => candidate.score >= MIN_MATCH_SCORE
      && (checks.get(candidate.url)?.status === 'compatible'
        || (checks.get(candidate.url)?.status === 'clarification_required'
          && Array.isArray(checks.get(candidate.url)?.questions)
          && checks.get(candidate.url).questions.some(question => question?.required === true))))
      .slice(0, Math.min(available, MAX_PROPOSALS_PER_RUN));
    const eligibilityFields = (result = { status: 'unverified' }) => ({
      eligibilityStatus: result.status,
      eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
      eligibilityFactsRevision,
      eligibilityFingerprint: result.fingerprint || null,
      eligibilityCacheId: result.cacheId || null,
      eligibilityCvStorageKey: service.cvStorageKey || null,
      eligibilityCheckedAt: Timestamp.now(),
    });
    let refreshedProposals = 0;
    let retractedProposals = 0;
    const recoveryOutcomes = new Map();
    for (const doc of existing) {
      const data = doc.data() || {};
      if (!['proposed', 'retracted'].includes(data.status)) continue;
      if (isLegacyUnverifiedRetraction(data)) continue;
      if (data.status === 'retracted' && (proposedUrls.has(data.jobUrl) || excludedUrls.has(data.jobUrl)
        || retractionOwners.get(data.jobUrl) !== doc.id)) continue;
      const job = jobsByUrl.get(data.jobUrl);
      const rescored = job ? scoreJobForProfile(job, profile, candidateLocation, matchSignals) : { score: 0, reasons: [] };
      const result = checks.get(data.jobUrl) || { status: 'unverified' };
      const proposalRef = doc.ref || doc;
      const jobClosed = Boolean(job && explicitlyClosedJob(job, matchingNowMs));
      const isDecisivelyIncompatible = decisiveIncompatibility(result);
      // An omitted listing cannot be rescored; preserve it as unverified
      // instead of treating the missing index row as a zero relevance score.
      const belowThreshold = Boolean(job) && rescored.score < MIN_MATCH_SCORE;
      if (!jobClosed && rescored.score >= MIN_MATCH_SCORE
        && (result.status === 'compatible' || canOfferClarification(result))) {
        const changed = await updateExistingProposal(
          db,
          serviceRef,
          proposalRef,
          {
            ...eligibilityFields(result),
            matchScore: rescored.score,
            matchRankingScore: rescored.rankScore ?? rescored.score,
            matchReasons: rescored.reasons,
            rankingFeatures: rankingFeaturesForJob(job),
            matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
            matchedAt: Timestamp.now(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          data.status,
          data.status === 'retracted' ? 'proposed' : null,
          fallbackOpenCount,
        );
        if (changed) refreshedProposals += 1;
      } else if (data.status === 'proposed') {
        if (jobClosed || isDecisivelyIncompatible) {
          const retractionReason = jobClosed ? 'job_closed' : 'decisive_requirement_missing';
          const changed = await updateExistingProposal(
            db,
            serviceRef,
            proposalRef,
            {
              matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
              ...eligibilityFields(result),
              retractionReason,
              matchScore: rescored.score,
              matchRankingScore: rescored.rankScore ?? rescored.score,
              matchReasons: rescored.reasons,
              rankingFeatures: rankingFeaturesForJob(job),
              updatedAt: FieldValue.serverTimestamp(),
            },
            'proposed',
            'retracted',
            fallbackOpenCount,
          );
          if (changed) retractedProposals += 1;
        } else {
          // A failed or incomplete qualification is not proof that an existing
          // proposal is incompatible. Keep its stable row visible; the API
          // serializes non-compatible eligibility as needs_verification, and
          // acceptProposal independently rejects it until a fresh compatible
          // result is durably recorded.
          const retainedResult = belowThreshold && (result.status === 'compatible' || result.status === 'incompatible')
            ? { ...result, status: 'unverified', reason: 'match_below_threshold' }
            : result;
          await updateExistingProposal(
            db,
            serviceRef,
            proposalRef,
            {
              matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
              ...eligibilityFields(retainedResult),
              ...(job && rescored.score >= MIN_MATCH_SCORE ? {
                matchScore: rescored.score,
                matchRankingScore: rescored.rankScore ?? rescored.score,
                matchReasons: rescored.reasons,
                rankingFeatures: rankingFeaturesForJob(job),
              } : {}),
              updatedAt: FieldValue.serverTimestamp(),
            },
            'proposed',
            null,
            fallbackOpenCount,
          );
        }
      }
    }

    for (const row of legacyRecovery.selected) {
      const proposalRef = row.ref;
      const preflight = recoveryPreflight.get(row.id) || { kind: 'retry', reason: 'analysis_deferred' };
      if (preflight.kind === 'terminal') {
        const retractionReason = preflight.reason === 'job_closed' ? 'job_closed' : 'duplicate_proposal';
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, {
          ...legacyProposalRecoveryTerminalFields({ context: eligibilityRecoveryContext, nowMs: Date.now(), reason: preflight.reason }),
          retractionReason,
          updatedAt: FieldValue.serverTimestamp(),
        }, service.cvStorageKey, fallbackOpenCount);
        if (changed) recoveryOutcomes.set(row.id, { ...changed, eligibilityStatus: 'unverified', retractionReason });
        continue;
      }

      if (preflight.kind === 'retry') {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, current => ({
          ...legacyProposalRecoveryRetryFields(current, { context: eligibilityRecoveryContext, nowMs: Date.now(), reason: preflight.reason }),
          updatedAt: FieldValue.serverTimestamp(),
        }), service.cvStorageKey, fallbackOpenCount);
        if (changed) recoveryOutcomes.set(row.id, changed);
        continue;
      }

      const result = checks.get(row.data.jobUrl) || { status: 'unverified', reason: 'analysis_deferred' };
      if (result.status === 'compatible' || canOfferClarification(result)) {
        const rescored = preflight.rescored;
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, {
          ...eligibilityFields(result),
          matchScore: rescored.score,
          matchRankingScore: rescored.rankScore ?? rescored.score,
          matchReasons: rescored.reasons,
          rankingFeatures: rankingFeaturesForJob(preflight.job),
          matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
          matchedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
          status: 'proposed',
          reactivatedAt: FieldValue.serverTimestamp(),
          legacyRecoveryStatus: 'recovered',
          legacyRecoveryContext: eligibilityRecoveryContext,
          legacyRecoveryResolvedAt: Date.now(),
          legacyRecoveryNextAt: null,
          legacyRecoveryLastReason: 'verified_compatible',
        }, service.cvStorageKey, fallbackOpenCount);
        if (changed) {
          refreshedProposals += 1;
          recoveryOutcomes.set(row.id, { ...changed, status: 'proposed' });
        }
      } else if (decisiveIncompatibility(result)) {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, {
          ...eligibilityFields(result),
          ...legacyProposalRecoveryTerminalFields({ context: eligibilityRecoveryContext, nowMs: Date.now(), reason: 'decisive_requirement_missing' }),
          retractionReason: 'decisive_requirement_missing',
          matchScore: preflight.rescored.score,
          matchRankingScore: preflight.rescored.rankScore ?? preflight.rescored.score,
          matchReasons: preflight.rescored.reasons,
          matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
          updatedAt: FieldValue.serverTimestamp(),
        }, service.cvStorageKey, fallbackOpenCount);
        if (changed) recoveryOutcomes.set(row.id, { ...changed, retractionReason: 'decisive_requirement_missing', eligibilityStatus: result.status });
      } else {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, current => ({
          ...(result.status === 'unverified' || result.status === 'clarification_required'
            ? eligibilityFields({ ...result, status: 'unverified' })
            : {}),
          ...legacyProposalRecoveryRetryFields(current, {
            context: eligibilityRecoveryContext,
            nowMs: Date.now(),
            reason: result.reason || result.status || 'eligibility_unverified',
          }),
          updatedAt: FieldValue.serverTimestamp(),
        }), service.cvStorageKey, fallbackOpenCount);
        if (changed) recoveryOutcomes.set(row.id, changed);
      }
    }

    let createdProposals = 0;
    for (const candidate of candidates) {
      const ref = serviceRef.collection('proposals').doc(proposalDocumentId(serviceId, candidate.job, candidate.url));
      const proposal = {
        jobId: String(candidate.job.id || candidate.job.jobId || candidate.job.slug || candidate.job.canonicalUrl || candidate.url).slice(0, 200),
        jobUrl: candidate.url,
        companyId: String(candidate.job.companyKey || candidate.job.company || 'company').slice(0, 200),
        companyName: String(candidate.job.company || candidate.job.companyKey || 'Azienda').slice(0, 200),
        jobTitle: String(candidate.job.title || 'Posizione').slice(0, 300),
        location: candidate.job.location || candidate.job.canton || null,
        applyMode: candidate.job.applyMode || 'portal',
        status: 'proposed',
        ...eligibilityFields(checks.get(candidate.url)),
        matchScore: candidate.score,
        matchRankingScore: candidate.rankScore,
        matchReasons: candidate.reasons,
        rankingFeatures: rankingFeaturesForJob(candidate.job),
        source: 'cv_match_workflow',
        createdBy: 'cv_match_workflow',
        matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
        matchedAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
        proposedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      const created = await db.runTransaction(async transaction => {
        const [currentServiceDoc, currentProposalDoc] = await Promise.all([transaction.get(serviceRef), transaction.get(ref)]);
        const currentService = currentServiceDoc.data();
        if (currentProposalDoc.exists || !serviceIsActive(currentService) || currentService.cvStorageKey !== service.cvStorageKey
          || acceptedPositionsCount(currentService) >= servicePositionLimit(currentService)
          || openProposalsCount(currentService, fallbackOpenCount) >= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS) return false;
        const openCount = openProposalsCount(currentService, fallbackOpenCount);
        transaction.set(serviceRef, { matchingOpenProposalCount: openCount + 1 }, { merge: true });
        transaction.set(ref, proposal);
        return true;
      });
      if (created) createdProposals += 1;
    }
    const retrySummary = await eligibilityRetrySummary(serviceRef);
    const legacyRecoverySummary = summarizeLegacyProposalRecovery(legacyRecovery.queued, recoveryOutcomes, {
      context: eligibilityRecoveryContext,
      nowMs: Date.now(),
    });
    const scannedIndex = frontier.findIndex(entry => entry.url === scannedCursor);
    const afterCursor = scannedIndex >= 0 ? frontier.slice(scannedIndex + 1) : frontier;
    const pendingCount = afterCursor.filter(entry => !allRetryUrls.has(entry.url)).length;
    const completionUpdate = {
      matchingStatus: 'complete',
      matchingPendingCount: pendingCount,
      matchingPendingReasonCounts: pendingCount ? { bounded_scan_frontier: pendingCount } : {},
      matchingUnverifiedCount: retrySummary.count,
      matchingRetryCount: retrySummary.retryCount,
      matchingRetryExhaustedCount: retrySummary.exhaustedCount,
      matchingRetryAt: retrySummary.retryAt,
      matchingRetryStatusCounts: retrySummary.statusCounts,
      matchingRetryReasonCounts: retrySummary.reasonCounts,
      matchingEligibilityRecoveryCount: retrySummary.recovery.count,
      matchingEligibilityRecoveryAverageMs: retrySummary.recovery.averageDurationMs,
      matchingEligibilityLastRecoveryMs: retrySummary.recovery.lastDurationMs,
      matchingEligibilityLastRecoveryStatus: retrySummary.recovery.lastStatus,
      matchingEligibilityLastRecoveryAt: retrySummary.recovery.lastAt,
      matchingLegacyRecoveryCursor: legacyRecovery.nextCursor,
      matchingLegacyRecoveryContext: eligibilityRecoveryContext,
      matchingLegacyRecoveryPendingCount: legacyRecoverySummary.count,
      matchingLegacyRecoveryRetryAt: legacyRecoverySummary.retryAt,
      matchingClarificationCount: [...checks.values()].filter(result => result.status === 'clarification_required').length,
      matchingJobCount: createdProposals + refreshedProposals,
      matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingCompletedAt: FieldValue.serverTimestamp(),
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Replace aggregate maps as whole fields so causes/statuses that disappeared
    // from the retry queue do not survive a recursive merge as stale counts.
    await serviceRef.set(completionUpdate, { mergeFields: Object.keys(completionUpdate) });
    const telemetry = {
      scanned: checks.size,
      pending: { count: pendingCount, reasons: pendingCount ? { bounded_scan_frontier: pendingCount } : {} },
      unverified: {
        count: retrySummary.count,
        retrying: retrySummary.retryCount,
        exhausted: retrySummary.exhaustedCount,
        nextRetryAt: readableTimestamp(retrySummary.retryAt),
        statuses: retrySummary.statusCounts,
        reasons: retrySummary.reasonCounts,
      },
      recovery: { ...retrySummary.recovery, lastAt: readableTimestamp(retrySummary.recovery.lastAt) },
      proposals: createdProposals + refreshedProposals,
      retracted: retractedProposals,
    };
    console.info('[applicationConciergeMatching]', JSON.stringify(telemetry));
    return { status: 'complete', proposals: createdProposals + refreshedProposals, retracted: retractedProposals, telemetry };
  } catch (error) {
    // A failed top-level fetch/write is not evidence that any existing job is
    // incompatible or closed. Preserve proposal rows and let the lifecycle's
    // failed-run retry re-evaluate them on a later pass.
    await serviceRef.set({ matchingStatus: 'failed', matchingError: 'job_search_failed', matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}
// End of the explainable CV matcher module.
