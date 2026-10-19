/**
 * CV → job proposal workflow for the 30-day application concierge.
 *
 * Matching is intentionally explainable and conservative. It proposes only
 * HTTPS listings whose title/category/skills overlap with the private CV
 * projection; the candidate still accepts every position before an assisted
 * application child is created.
 */

import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import {
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  serviceIsActive,
} from './applicationConciergeConstants.js';

const DEFAULT_JOB_INDEX_URL = 'https://cdn.frontaliereticino.ch/data/jobs-it-index.json';
const FETCH_TIMEOUT_MS = 90_000;
const MAX_PROPOSALS_PER_RUN = 10;
const MIN_MATCH_SCORE = 28;
export const APPLICATION_CONCIERGE_MATCHING_VERSION = 'cv-relevance-v2';
const STOP_WORDS = new Set([
  'and', 'con', 'per', 'the', 'with', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'in', 'a', 'da', 'su', 'il', 'lo', 'la', 'le', 'un', 'una', 'uno',
  'job', 'lavoro', 'stellen', 'emploi', 'arbeit', 'switzerland', 'svizzera', 'suisse', 'schweiz', 'full', 'time', 'part', 'tempo', 'pieno',
  'senior', 'junior', 'manager', 'management', 'group', 'global', 'head', 'director', 'directeur', 'directrice', 'direttore', 'responsabile', 'responsable', 'leiter', 'leitung', 'chief', 'lead', 'leader',
  'at', 'bei', 'chez', 'presso', 'for', 'from', 'und', 'oder', 'mit', 'der', 'die', 'das', 'von', 'pour', 'avec', 'dans', 'des', 'les', 'une', 'est',
]);
const SHORT_TECH_TOKENS = new Set(['it', 'ict', 'cio', 'sap', 'aws', 'gcp', 'erp', 'crm', 'sql', 'api', 'qa', 'hr', 'ai', 'ml']);
const ROLE_SIGNAL_POINTS = Object.freeze({
  technology_management: 28,
  enterprise_applications: 16,
  application_management: 28,
  technology_strategy: 14,
});
const ROLE_SIGNAL_LABELS = Object.freeze({
  technology_management: 'gestione IT',
  enterprise_applications: 'applicazioni aziendali',
  application_management: 'gestione applicazioni',
  technology_strategy: 'strategia IT',
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
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#.]+/g, ' ').trim();
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
  const titleText = [profile?.workPosition, profile?.headline].map(stripEmployerSuffix).filter(Boolean);
  const titleTokens = new Set(titleText.flatMap((value) => [...tokenize(value)]));
  const experienceTokens = new Set((profile?.experienceSummary || [])
    .flatMap((value) => [...tokenize(stripEmployerSuffix(value))]));
  const allTokens = new Set([...skillTokens, ...titleTokens, ...experienceTokens]);
  const profileText = normalize([
    ...titleText,
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

/** Pure scorer exported for tests and future ranking improvements. */
export function scoreJobForProfile(job, profile) {
  const candidate = profileEvidence(profile);
  if (!candidate.allTokens.size && !candidate.roleText) return { score: 0, reasons: [] };
  const jobTitle = [job?.title, job?.category, job?.sector].filter(Boolean).join(' ');
  const titleTokens = tokenize(jobTitle);
  const allJobTokens = tokenize(jobText(job));
  const candidateRoles = roleSignals(candidate.roleText);
  const jobRoles = roleSignals(job?.title || '');
  const roleMatches = overlap(candidateRoles, jobRoles);
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
  const experienceMatches = [...candidate.experienceTokens]
    .filter((token) => !candidate.skillTokens.has(token) && !candidate.titleTokens.has(token) && allJobTokens.has(token));
  const experienceInTitle = experienceMatches.filter((token) => titleTokens.has(token));
  const experienceInBody = experienceMatches.filter((token) => !titleTokens.has(token));
  const skillPoints = skillMatches.reduce((sum, token) => sum + (titleTokens.has(token) ? 16 : 9), 0);
  const titlePoints = titleMatches.length * 12 + titleInBody.length * 4;
  const experiencePoints = experienceInTitle.length * 7 + experienceInBody.length * 2;
  const rolePoints = roleMatches.reduce((sum, role) => sum + ROLE_SIGNAL_POINTS[role], 0);
  const score = Math.max(0, Math.min(99,
    Math.min(48, skillPoints) + Math.min(36, titlePoints) + Math.min(12, experiencePoints) + Math.min(58, rolePoints)
      - specialtyPenalty(jobTitle, candidate.profileText, candidateRoles, jobRoles),
  ));
  if (score < MIN_MATCH_SCORE) return { score: 0, reasons: [] };

  const reasons = [];
  if (roleMatches.length) reasons.push('Ruolo compatibile: ' + roleMatches.map((role) => ROLE_SIGNAL_LABELS[role]).join(', '));
  if (skillMatches.length) reasons.push('Competenze nel CV: ' + skillMatches.slice(0, 4).join(', '));
  const titleEvidence = [...titleMatches, ...titleInBody]
    .filter((token) => token !== 'it' && !(token === 'application' && roleMatches.includes('enterprise_applications')));
  if (titleEvidence.length) reasons.push('Ambiti presenti nel CV: ' + titleEvidence.slice(0, 4).join(', '));
  if (!titleEvidence.length && experienceMatches.length) reasons.push('Esperienza pertinente: ' + experienceMatches.slice(0, 4).join(', '));
  return {
    score,
    reasons: reasons.slice(0, 3),
    evidenceStrength: skillMatches.length * 3 + roleMatches.length * 2 + titleMatches.length + experienceMatches.length,
  };
}

function validJobUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function jobUrl(job) {
  return job?.applyUrl || job?.url || '';
}

async function fetchJobs(url = process.env.APPLICATION_CONCIERGE_JOB_INDEX_URL || DEFAULT_JOB_INDEX_URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`job_index_http_${response.status}`);
    const value = await response.json();
    return Array.isArray(value) ? value : Array.isArray(value?.jobs) ? value.jobs : [];
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

async function updateExistingProposal(db, ref, update, expectedStatus, nextStatus = null) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (current.status !== expectedStatus) return false;
    transaction.set(ref, {
      ...update,
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(nextStatus === 'retracted' ? { retractedAt: FieldValue.serverTimestamp(), retractionReason: 'match_below_threshold' } : {}),
      ...(nextStatus === 'proposed' && current.status === 'retracted' ? { reactivatedAt: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });
    return true;
  });
}

export async function runApplicationConciergeMatching({ db = getAdminDb(), serviceId, jobIndexUrl } = {}) {
  const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const serviceSnapshot = await serviceRef.get();
  if (!serviceSnapshot.exists) return { status: 'skipped', reason: 'service_not_found' };
  const service = serviceSnapshot.data() || {};
  if (!service.userId || service.paymentStatus !== 'paid' || !serviceIsActive(service)) return { status: 'skipped', reason: 'service_inactive' };

  const profileSnapshot = await db.collection('user_cv_profiles').doc(service.userId).get();
  const profileRecord = profileSnapshot.exists ? profileSnapshot.data() || {} : {};
  const profile = profileRecord.profile || {};
  if (profileRecord.status !== 'ready' || !profile.searchText) {
    await serviceRef.set({ matchingStatus: 'needs_review', matchingError: null, matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'needs_review', reason: 'profile_not_ready' };
  }

  await serviceRef.set({ matchingStatus: 'running', matchingStartedAt: FieldValue.serverTimestamp(), matchingError: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  try {
    const jobs = await fetchJobs(jobIndexUrl);
    const existingSnapshot = await serviceRef.collection('proposals').get();
    const existing = existingSnapshot.docs || [];
    const known = new Set(existing.map((doc) => {
      const data = doc.data() || {};
      return `${data.jobId || ''}|${data.jobUrl || ''}`;
    }));
    const available = Math.max(0, (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS) - acceptedPositionsCount(service));
    const candidates = jobs.map((job) => {
      const url = jobUrl(job);
      const scored = scoreJobForProfile(job, profile);
      return { job, url, ...scored };
    }).filter((entry) => entry.score > 0 && validJobUrl(entry.url) && !known.has(`${entry.job.id || ''}|${entry.url}`))
      .sort((left, right) => right.score - left.score
        || right.evidenceStrength - left.evidenceStrength
        || String(right.job.datePosted || '').localeCompare(String(left.job.datePosted || '')))
      .slice(0, Math.min(available, MAX_PROPOSALS_PER_RUN));

    const jobsByUrl = new Map(jobs.map((job) => [jobUrl(job), job]).filter(([url]) => Boolean(url)));
    let refreshedProposals = 0;
    let retractedProposals = 0;
    for (const doc of existing) {
      const data = doc.data() || {};
      if (!['proposed', 'retracted'].includes(data.status)) continue;
      const job = jobsByUrl.get(data.jobUrl);
      if (!job) continue;
      const rescored = scoreJobForProfile(job, profile);
      const proposalRef = doc.ref || doc;
      if (rescored.score >= MIN_MATCH_SCORE) {
        const changed = await updateExistingProposal(
          db,
          proposalRef,
          {
            matchScore: rescored.score,
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
        const changed = await updateExistingProposal(
          db,
          proposalRef,
          {
            matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
            updatedAt: FieldValue.serverTimestamp(),
          },
          'proposed',
          'retracted',
        );
        if (changed) retractedProposals += 1;
      }
    }

    const batch = db.batch();
    for (const candidate of candidates) {
      const ref = serviceRef.collection('proposals').doc(proposalDocumentId(serviceId, candidate.job, candidate.url));
      batch.set(ref, {
        jobId: String(candidate.job.id || candidate.job.jobId || candidate.job.slug || candidate.job.canonicalUrl || candidate.url).slice(0, 200),
        jobUrl: candidate.url,
        companyId: String(candidate.job.companyKey || candidate.job.company || 'company').slice(0, 200),
        companyName: String(candidate.job.company || candidate.job.companyKey || 'Azienda').slice(0, 200),
        jobTitle: String(candidate.job.title || 'Posizione').slice(0, 300),
        location: candidate.job.location || candidate.job.canton || null,
        applyMode: candidate.job.applyMode || 'portal',
        status: 'proposed',
        matchScore: candidate.score,
        matchReasons: candidate.reasons,
        source: 'cv_match_workflow',
        createdBy: 'cv_match_workflow',
        matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
        matchedAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
        proposedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (candidates.length) await batch.commit();
    await serviceRef.set({
      matchingStatus: 'complete',
      matchingJobCount: candidates.length + refreshedProposals,
      matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingCompletedAt: FieldValue.serverTimestamp(),
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'complete', proposals: candidates.length + refreshedProposals, retracted: retractedProposals };
  } catch (error) {
    await serviceRef.set({ matchingStatus: 'failed', matchingError: 'job_search_failed', matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}
// End of the explainable CV matcher module.
