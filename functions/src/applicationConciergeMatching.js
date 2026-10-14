/**
 * CV → job proposal workflow for the 30-day application concierge.
 *
 * Matching is intentionally explainable and conservative. It proposes only
 * HTTPS listings whose title/category/skills overlap with the private CV
 * projection; the candidate still accepts every position before an assisted
 * application child is created.
 */

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
const STOP_WORDS = new Set([
  'and', 'con', 'per', 'the', 'with', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'in', 'a', 'da', 'su', 'il', 'lo', 'la', 'le', 'un', 'una', 'uno',
  'job', 'lavoro', 'stellen', 'emploi', 'arbeit', 'switzerland', 'svizzera', 'suisse', 'schweiz', 'full', 'time', 'part', 'tempo', 'pieno',
]);

function normalize(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#.]+/g, ' ').trim();
}
export function tokenize(value) {
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function profileTokens(profile) {
  return new Set([
    ...(profile?.skills || []),
    profile?.workPosition,
    profile?.headline,
    ...(profile?.experienceSummary || []),
  ].flatMap((value) => [...tokenize(value)]));
}

function jobText(job) {
  return [job?.title, job?.category, job?.sector, job?.description, job?.requirements, job?.company].filter(Boolean).join(' ');
}

/** Pure scorer exported for tests and future ranking improvements. */
export function scoreJobForProfile(job, profile) {
  const candidate = profileTokens(profile);
  if (!candidate.size) return { score: 0, reasons: [] };
  const titleTokens = tokenize([job?.title, job?.category, job?.sector].filter(Boolean).join(' '));
  const allJobTokens = tokenize(jobText(job));
  const titleOverlap = [...candidate].filter((token) => titleTokens.has(token));
  const skillOverlap = [...candidate].filter((token) => allJobTokens.has(token));
  if (titleOverlap.length === 0 && skillOverlap.length < 2) return { score: 0, reasons: [] };
  const titlePoints = Math.min(55, titleOverlap.length * 22);
  const skillPoints = Math.min(35, skillOverlap.length * 7);
  const locationPoints = job?.canton || job?.location ? 5 : 0;
  const score = Math.min(99, 45 + titlePoints + skillPoints + locationPoints);
  const reasons = [];
  if (titleOverlap.length) reasons.push(`Ruolo compatibile: ${titleOverlap.slice(0, 4).join(', ')}`);
  if (skillOverlap.length) reasons.push(`Competenze rilevate: ${skillOverlap.slice(0, 4).join(', ')}`);
  if (job?.location) reasons.push(`Sede: ${String(job.location).slice(0, 80)}`);
  return { score, reasons };
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

function proposalRef(serviceRef) {
  return serviceRef.collection('proposals').doc();
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
      .sort((left, right) => right.score - left.score || String(right.job.datePosted || '').localeCompare(String(left.job.datePosted || '')))
      .slice(0, Math.min(available, MAX_PROPOSALS_PER_RUN));

    const batch = db.batch();
    for (const candidate of candidates) {
      const ref = proposalRef(serviceRef);
      batch.set(ref, {
        jobId: String(candidate.job.id || candidate.job.slug || ref.id).slice(0, 200),
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
        matchingVersion: 'cv-overlap-v1',
        matchedAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
        proposedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (candidates.length) await batch.commit();
    await serviceRef.set({
      matchingStatus: 'complete',
      matchingJobCount: candidates.length,
      matchingCompletedAt: FieldValue.serverTimestamp(),
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'complete', proposals: candidates.length };
  } catch (error) {
    await serviceRef.set({ matchingStatus: 'failed', matchingError: 'job_search_failed', matchingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}
// End of the explainable CV matcher module.
