/**
 * CV → job proposal workflow for the 30-day application concierge.
 *
 * Matching is intentionally explainable and conservative. It proposes only
 * HTTPS listings whose title/category/skills overlap with the private CV
 * projection; the candidate still accepts every position before an assisted
 * application child is created.
 */

import { CONCIERGE_ELIGIBILITY_VERSION, normalizeConciergeJobRecord, prepareConciergeEligibility } from './applicationConciergeEligibility.js';
import { locationMatchPoints } from './applicationConciergeGeography.js';
import { MAX_ELIGIBILITY_RETRIES_PER_RUN, dueEligibilityRetries, eligibilityRetryRef, eligibilityRetrySummary, recordEligibilityRetry } from './applicationConciergeEligibilityRetry.js';
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
import {
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_MATCHING_VERSION,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  serviceIsActive,
} from './applicationConciergeConstants.js';

const DEFAULT_JOB_INDEX_URL = 'https://cdn.frontaliereticino.ch/data/jobs-it-index.json';
const FETCH_TIMEOUT_MS = 90_000;
const MAX_PROPOSALS_PER_RUN = 10;
const MAX_ELIGIBILITY_WORK_PER_RUN = 40;
const MIN_MATCH_SCORE = 28;
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
const LANGUAGE_ALIASES = Object.freeze({
  italiano: /\b(?:italian|italiano|italiana|italien|italienisch(?:e|en|kenntnis(?:se|sen)?)?)\b/,
  tedesco: /\b(?:german|tedesco|tedesca|deutsch(?:e|en|kenntnis(?:se|sen)?)?|allemand|allemande)\b/,
  francese: /\b(?:french|francese|francais|franzosisch(?:e|en|kenntnis(?:se|sen)?)?)\b/,
  inglese: /\b(?:english|inglese|englisch(?:e|en|kenntnis(?:se|sen)?)?|anglais)\b/,
  spagnolo: /\b(?:spanish|spagnolo|spagnola|espanol|spanisch|espagnol)\b/,
  portoghese: /\b(?:portuguese|portoghese|portugues|portugiesisch)\b/,
  olandese: /\b(?:dutch|olandese|neerlandese|nederlands|neerlandais)\b/,
});
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

function stripEmployerSuffix(value) {
  return String(value || '').replace(/\s+(?:at|presso|bei|chez)\s+.+$/i, '');
}

function profileEvidence(profile) {
  const skillTokens = new Set((profile?.skills || []).flatMap((value) => [...tokenize(value)]));
  const currentTitleText = [profile?.workPosition, profile?.headline].map(stripEmployerSuffix).filter(Boolean);
  const previousPositionText = (profile?.previousPositions || []).map(stripEmployerSuffix).filter(Boolean);
  const titleText = [...currentTitleText, ...previousPositionText];
  const titleTokens = new Set(titleText.flatMap((value) => [...tokenize(value)]));
  const experienceTokens = new Set([...(profile?.experienceSummary || []), ...previousPositionText]
    .flatMap((value) => [...tokenize(stripEmployerSuffix(value))]));
  const allTokens = new Set([...skillTokens, ...titleTokens, ...experienceTokens]);
  const profileText = normalize([
    ...currentTitleText,
    ...previousPositionText,
    ...(profile?.skills || []),
    ...(profile?.experienceSummary || []).map(stripEmployerSuffix),
  ].join(' '));
  return { skillTokens, titleTokens, experienceTokens, allTokens, roleText: titleText.join(' '), profileText };
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

/** Pure scorer exported for tests and future ranking improvements. */
export function scoreJobForProfile(job, profile, candidateLocation = '') {
  const candidate = profileEvidence(profile);
  if (!candidate.allTokens.size && !candidate.roleText) return { score: 0, reasons: [] };
  const jobTitle = [job?.title, job?.category, job?.sector].filter(Boolean).join(' ');
  const titleTokens = tokenize(jobTitle);
  const allJobTokens = tokenize(jobText(job));
  const candidateRoles = roleSignals(candidate.roleText);
  const jobRoles = roleSignals(job?.title || '');
  const roleMatches = overlap(candidateRoles, jobRoles);
  const candidateLanguages = new Set((profile?.languages || [])
    .flatMap((value) => [...languageSignals(value)]));
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
  // Composite role signals already account for their anchor terms; do not
  // award the same IT/application words twice as plain title overlap.
  const roleCoveredTokens = new Set([
    ...(roleMatches.includes('technology_management') ? ['it'] : []),
    ...(roleMatches.includes('enterprise_applications') || roleMatches.includes('application_management') ? ['application'] : []),
  ]);
  const skillMatches = overlap(candidate.skillTokens, allJobTokens);
  const titleMatches = overlap(candidate.titleTokens, titleTokens)
    .filter((token) => !candidate.skillTokens.has(token) && !roleCoveredTokens.has(token));
  const titleInBody = [...candidate.titleTokens]
    .filter((token) => !candidate.skillTokens.has(token) && !roleCoveredTokens.has(token) && !titleTokens.has(token) && allJobTokens.has(token));
  const rawExperienceMatches = overlap(candidate.experienceTokens, allJobTokens);
  const experienceMatches = rawExperienceMatches
    .filter((token) => !candidate.skillTokens.has(token) && !candidate.titleTokens.has(token) && allJobTokens.has(token));
  // A matching title can rank relevant evidence, but it cannot replace proof
  // from a CV skill or experience entry on its own.
  if (!skillMatches.length && !rawExperienceMatches.length) return { score: 0, reasons: [] };
  const experienceInTitle = experienceMatches.filter((token) => titleTokens.has(token));
  const experienceInBody = experienceMatches.filter((token) => !titleTokens.has(token));
  const skillPoints = skillMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 16 : 9), 0);
  const titlePoints = titleMatches.length * 12 + titleInBody.length * 4;
  const experiencePoints = experienceInTitle.length * 7 + experienceInBody.length * 2;
  const rolePoints = roleMatches.reduce((sum, role) => sum + ROLE_SIGNAL_POINTS[role], 0);
  const languagePoints = Math.min(8, languageMatches.length * 4);
  const locationPoints = locationMatchPoints(candidateLocation, job);
  const relevanceScore = Math.max(0, Math.min(99,
    Math.min(48, skillPoints) + Math.min(36, titlePoints) + Math.min(12, experiencePoints) + Math.min(58, rolePoints) + languagePoints
      - specialtyPenalty(jobTitle, candidate.profileText, candidateRoles, jobRoles),
  ));
  if (relevanceScore < MIN_MATCH_SCORE) return { score: 0, reasons: [] };
  const rankScore = relevanceScore + locationPoints;
  const score = Math.min(99, rankScore);

  const reasons = [];
  if (roleMatches.length) reasons.push('Ruolo compatibile: ' + roleMatches.map((role) => ROLE_SIGNAL_LABELS[role]).join(', '));
  if (locationPoints) reasons.push('Località vicina alla zona di residenza');
  if (skillMatches.length) reasons.push('Competenze nel CV: ' + skillMatches.slice(0, 4).join(', '));
  if (languageMatches.length) reasons.push('Lingue richieste: ' + languageMatches.map((language) => LANGUAGE_LABELS[language]).join(', '));
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
    evidenceStrength: skillMatches.length * 3 + roleMatches.length * 2 + titleMatches.length + experienceMatches.length + languageMatches.length,
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
  const value = [job?.id, job?.jobId, job?.slug, job?.canonicalUrl, job?.url, url]
    .find((candidate) => String(candidate || '').trim());
  return String(value || url || `${job?.company || ''}|${job?.title || ''}|${job?.location || ''}`).trim();
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
    || String(before?.applicantLocation || '').trim() !== String(after.applicantLocation || '').trim();
}

/** Preference affects ordering only, after the CV relevance gate has passed. */
export function approvedRolePreference(job, proposals) {
  const tokens = tokenize(job?.title);
  const roles = roleSignals(job?.title || '');
  return proposals.some(proposal => proposal.status === 'accepted' && !proposal.withdrawnAt
    && (overlap(tokens, tokenize(proposal.jobTitle)).length >= 2
      || overlap(roles, roleSignals(proposal.jobTitle || '')).length > 0)) ? 8 : 0;
}

/** A bounded, durable frontier replaces the static top-40 window. */
export function conciergeMatchingWork(candidates, proposedUrls = new Set(), cursor = '', retryUrls = new Set(), recoveryUrls = [], deferredRecoveryUrls = new Set()) {
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
  const fresh = frontier.slice(start).filter(candidate => !retryUrls.has(candidate.url));
  return { work: [...priority, ...retries, ...recovery, ...fresh].slice(0, MAX_ELIGIBILITY_WORK_PER_RUN),
    frontier, cursorUrls: new Set(fresh.map(candidate => candidate.url)) };
}

async function updateExistingProposal(db, ref, update, expectedStatus, nextStatus = null) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (current.status !== expectedStatus) return false;
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

async function updateLegacyRecoveryProposal(db, serviceRef, ref, update, expectedCvStorageKey) {
  let appliedUpdate = null;
  const changed = await db.runTransaction(async (transaction) => {
    const [serviceSnapshot, snapshot] = await Promise.all([transaction.get(serviceRef), transaction.get(ref)]);
    const service = serviceSnapshot.data() || {};
    if (!serviceSnapshot.exists || !serviceIsActive(service) || service.cvStorageKey !== expectedCvStorageKey || !snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (!isLegacyUnverifiedRetraction(current)) return false;
    appliedUpdate = typeof update === 'function' ? update(current) : update;
    const cap = Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS;
    if (appliedUpdate.status === 'proposed' && acceptedPositionsCount(service) >= cap) return false;
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

  if (acceptedPositionsCount(service) >= (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS)) return { status: 'skipped', reason: 'position_limit_reached' };

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
    const available = Math.max(0, (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS) - acceptedPositionsCount(service));
    const candidateLocation = String(service.applicantLocation || '').trim();
    const matchingNowMs = Date.now();
    const existingData = existing.map(doc => doc.data() || {});
    const existingUrls = new Set(existingData.map(data => data.jobUrl).filter(Boolean));
    const excludedUrls = new Set(existingData.filter(data => !['proposed', 'retracted'].includes(data.status)).map(data => data.jobUrl));
    const rankedWork = jobs.map((job) => {
      const url = jobUrl(job);
      const scored = scoreJobForProfile(job, profile, candidateLocation);
      const preference = scored.score > 0 ? approvedRolePreference(job, existingData) : 0;
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
    const scanContext = createHash('sha256').update(JSON.stringify([APPLICATION_CONCIERGE_MATCHING_VERSION, service.cvStorageKey, profile])).digest('hex');
    const proposedUrls = new Set(existingData.filter(data => data.status === 'proposed').map(data => data.jobUrl));
    const recoveryRows = existing.map(doc => ({ id: doc.id, ref: doc.ref || doc, data: doc.data() || {} }));
    const retractionOwners = new Map();
    for (const row of recoveryRows.filter(row => row.data.status === 'retracted')
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
      const url = row.data.jobUrl;
      if (url && !proposedUrls.has(url) && !excludedUrls.has(url) && !retractionOwners.has(url)) retractionOwners.set(url, row.id);
    }
    const legacyRecovery = selectLegacyProposalRecovery(recoveryRows, {
      cursor: service.matchingLegacyRecoveryContext === scanContext ? service.matchingLegacyRecoveryCursor || '' : '',
      context: scanContext,
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
      const rescored = scoreJobForProfile(job, profile, candidateLocation);
      if (rescored.score < MIN_MATCH_SCORE) {
        recoveryPreflight.set(row.id, { kind: 'retry', reason: 'match_below_threshold' });
        continue;
      }
      recoveryPreflight.set(row.id, { kind: 'eligible', job, rescored });
      recoveryUrls.push(row.data.jobUrl);
    }
    const dueRetries = await dueEligibilityRetries(serviceRef, Date.now());
    const relevantUrls = new Set(rankedWork.map(entry => entry.url));
    for (const retry of dueRetries) if (!relevantUrls.has(retry.data()?.jobUrl)) await retry.ref.delete();
    const retryUrls = new Set(dueRetries.map(doc => doc.data()?.jobUrl).filter(url => relevantUrls.has(url)));
    const { work, frontier, cursorUrls } = conciergeMatchingWork(rankedWork, proposedUrls,
      service.matchingScanContext === scanContext ? service.matchingScanCursor : '', retryUrls,
      recoveryUrls, allLegacyRecoveryUrls);
    let scannedCursor = service.matchingScanContext === scanContext ? service.matchingScanCursor || '' : '';
    for (let offset = 0; offset < work.length; offset += 4) {
      // Stop starting batches early; the shared signal also bounds the last batch.
      if (Date.now() - runStartedAt > 280_000) break;
      const batch = work.slice(offset, offset + 4);
      await Promise.all(batch.map(async ({ job, url }) => {
        const retry = (await eligibilityRetryRef(serviceRef, url).get()).data();
        let result;
        if (retry?.context === scanContext && Number(retry.retryAt) > Date.now()) result = { status: 'unverified', reason: 'retry_backoff' };
        else {
          try { result = await evaluate(job); }
          catch { result = { status: 'unverified', reason: eligibilitySignal.aborted ? 'analysis_deferred' : 'analysis_unavailable' }; }
        }
        if (result?.status === 'incompatible' && !decisiveIncompatibility(result)) {
          result = { status: 'unverified', reason: 'incompatibility_not_proven' };
        }
        await recordEligibilityRetry({ db, serviceRef, url, result, context: scanContext, nowMs: Date.now() });
        checks.set(url, result);
      }));
      // Unverified results are retained in the independent retry queue. They
      // cannot pin new discovery; budget-deferred work remains at the cursor.
      for (const entry of batch) {
        const result = checks.get(entry.url);
        if (result?.reason === 'analysis_deferred') break;
        if (cursorUrls.has(entry.url)) scannedCursor = entry.url;
      }
      await serviceRef.set({ matchingScanCursor: scannedCursor, matchingScanContext: scanContext }, { merge: true });
      if (batch.some(entry => {
        const result = checks.get(entry.url);
        return result?.reason === 'analysis_deferred';
      })) break;
    }
    const candidates = rankedCandidates.filter(candidate => checks.get(candidate.url)?.status === 'compatible')
      .slice(0, Math.min(available, MAX_PROPOSALS_PER_RUN));
    const eligibilityFields = (result = { status: 'unverified' }) => ({
      eligibilityStatus: result.status,
      eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
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
      const rescored = job ? scoreJobForProfile(job, profile, candidateLocation) : { score: 0, reasons: [] };
      const result = checks.get(data.jobUrl) || { status: 'unverified' };
      const proposalRef = doc.ref || doc;
      const jobClosed = Boolean(job && explicitlyClosedJob(job, matchingNowMs));
      const isDecisivelyIncompatible = decisiveIncompatibility(result);
      if (!jobClosed && rescored.score >= MIN_MATCH_SCORE && result.status === 'compatible') {
        const changed = await updateExistingProposal(
          db,
          proposalRef,
          {
            ...eligibilityFields(result),
            matchScore: rescored.score,
            matchRankingScore: rescored.rankScore ?? rescored.score,
            matchReasons: rescored.reasons,
            matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
            matchedAt: Timestamp.now(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          data.status,
          data.status === 'retracted' ? 'proposed' : null,
        );
        if (changed) refreshedProposals += 1;
      } else if (data.status === 'proposed') {
        if (jobClosed || isDecisivelyIncompatible) {
          const changed = await updateExistingProposal(
            db,
            proposalRef,
            {
              matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
              ...eligibilityFields(result),
              retractionReason: jobClosed ? 'job_closed' : 'decisive_requirement_missing',
              matchScore: rescored.score,
              matchRankingScore: rescored.rankScore ?? rescored.score,
              matchReasons: rescored.reasons,
              updatedAt: FieldValue.serverTimestamp(),
            },
            'proposed',
            'retracted',
          );
          if (changed) retractedProposals += 1;
        } else {
          // A failed or incomplete qualification is not proof that an existing
          // proposal is incompatible. Keep its stable row visible; the API
          // serializes non-compatible eligibility as needs_verification, and
          // acceptProposal independently rejects it until a fresh compatible
          // result is durably recorded.
          await updateExistingProposal(
            db,
            proposalRef,
            {
              matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
              ...eligibilityFields(result.status === 'compatible' || result.status === 'incompatible'
                ? { ...result, status: 'unverified', reason: result.status === 'compatible' ? 'match_below_threshold' : 'incompatibility_not_proven' }
                : result),
              updatedAt: FieldValue.serverTimestamp(),
            },
            'proposed',
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
          ...legacyProposalRecoveryTerminalFields({ context: scanContext, nowMs: Date.now(), reason: preflight.reason }),
          retractionReason,
          updatedAt: FieldValue.serverTimestamp(),
        }, service.cvStorageKey);
        if (changed) recoveryOutcomes.set(row.id, { ...changed, eligibilityStatus: 'unverified', retractionReason });
        continue;
      }

      if (preflight.kind === 'retry') {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, current => ({
          ...legacyProposalRecoveryRetryFields(current, { context: scanContext, nowMs: Date.now(), reason: preflight.reason }),
          updatedAt: FieldValue.serverTimestamp(),
        }), service.cvStorageKey);
        if (changed) recoveryOutcomes.set(row.id, changed);
        continue;
      }

      const result = checks.get(row.data.jobUrl) || { status: 'unverified', reason: 'analysis_deferred' };
      if (result.status === 'compatible') {
        const rescored = preflight.rescored;
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, {
          ...eligibilityFields(result),
          matchScore: rescored.score,
          matchRankingScore: rescored.rankScore ?? rescored.score,
          matchReasons: rescored.reasons,
          matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
          matchedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
          status: 'proposed',
          reactivatedAt: FieldValue.serverTimestamp(),
          legacyRecoveryStatus: 'recovered',
          legacyRecoveryContext: scanContext,
          legacyRecoveryResolvedAt: Date.now(),
          legacyRecoveryNextAt: null,
          legacyRecoveryLastReason: 'verified_compatible',
        }, service.cvStorageKey);
        if (changed) {
          refreshedProposals += 1;
          recoveryOutcomes.set(row.id, { ...changed, status: 'proposed' });
        }
      } else if (decisiveIncompatibility(result)) {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, {
          ...eligibilityFields(result),
          ...legacyProposalRecoveryTerminalFields({ context: scanContext, nowMs: Date.now(), reason: 'decisive_requirement_missing' }),
          retractionReason: 'decisive_requirement_missing',
          matchScore: preflight.rescored.score,
          matchRankingScore: preflight.rescored.rankScore ?? preflight.rescored.score,
          matchReasons: preflight.rescored.reasons,
          matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
          updatedAt: FieldValue.serverTimestamp(),
        }, service.cvStorageKey);
        if (changed) recoveryOutcomes.set(row.id, { ...changed, retractionReason: 'decisive_requirement_missing', eligibilityStatus: result.status });
      } else {
        const changed = await updateLegacyRecoveryProposal(db, serviceRef, proposalRef, current => ({
          ...(result.status === 'unverified' || result.status === 'clarification_required'
            ? eligibilityFields({ ...result, status: 'unverified' })
            : {}),
          ...legacyProposalRecoveryRetryFields(current, {
            context: scanContext,
            nowMs: Date.now(),
            reason: result.reason || result.status || 'eligibility_unverified',
          }),
          updatedAt: FieldValue.serverTimestamp(),
        }), service.cvStorageKey);
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
          || acceptedPositionsCount(currentService) >= (Number(currentService.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS)) return false;
        transaction.set(ref, proposal);
        return true;
      });
      if (created) createdProposals += 1;
    }
    const retrySummary = await eligibilityRetrySummary(serviceRef);
    const legacyRecoverySummary = summarizeLegacyProposalRecovery(legacyRecovery.queued, recoveryOutcomes, {
      context: scanContext,
      nowMs: Date.now(),
    });
    await serviceRef.set({
      matchingStatus: 'complete',
      matchingPendingCount: Math.max(0, frontier.length - (frontier.findIndex(entry => entry.url === scannedCursor) + 1)),
      matchingUnverifiedCount: retrySummary.count,
      matchingRetryAt: retrySummary.retryAt,
      matchingLegacyRecoveryCursor: legacyRecovery.nextCursor,
      matchingLegacyRecoveryContext: scanContext,
      matchingLegacyRecoveryPendingCount: legacyRecoverySummary.count,
      matchingLegacyRecoveryRetryAt: legacyRecoverySummary.retryAt,
      matchingClarificationCount: [...checks.values()].filter(result => result.status === 'clarification_required').length,
      matchingJobCount: createdProposals + refreshedProposals,
      matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingCompletedAt: FieldValue.serverTimestamp(),
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'complete', proposals: createdProposals + refreshedProposals, retracted: retractedProposals };
  } catch (error) {
    // A failed top-level fetch/write is not evidence that any existing job is
    // incompatible or closed. Preserve proposal rows and let the lifecycle's
    // failed-run retry re-evaluate them on a later pass.
    await serviceRef.set({ matchingStatus: 'failed', matchingError: 'job_search_failed', matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}
// End of the explainable CV matcher module.
