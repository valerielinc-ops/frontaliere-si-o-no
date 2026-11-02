import {
  DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS,
  DIRECT_EMPLOYER_SOURCE_KEY,
  buildDirectEmployerJob,
} from '../../functions/src/directEmployerCore.js';
import { slugifyPublisher, truncatePublisherSlug } from './publisherJobProjection.mjs';

const SITE_ORIGIN = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

function wordCount(value) {
  const text = String(value || '').trim();
  return text ? text.split(/\s+/u).filter(Boolean).length : 0;
}
function asDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value && typeof value.toMillis === 'function') return new Date(value.toMillis());
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Convert one approved, verified Firestore submission into the same flat job
 * record consumed by assemble-jobs-dataset. Contact details never cross this
 * boundary: candidates resolve them through the App Check protected function.
 */
export function directEmployerSubmissionToRecords(submission, { now = new Date() } = {}) {
  if (!submission || submission.status !== 'approved') return [];
  const nowDate = asDate(now) || new Date();
  const expiry = asDate(submission.expiresAt);
  if (!expiry || expiry.getTime() <= nowDate.getTime()) return [];
  if (wordCount(submission.description) < DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS) return [];
  if (!submission.contactEmail && !submission.contactPhone) return [];

  const job = buildDirectEmployerJob(submission, nowDate);
  const baseSlug = truncatePublisherSlug(slugifyPublisher(`${job.title}-${job.location}-${job.company}`));
  const url = `${SITE_ORIGIN}/lavoro/${baseSlug}/`;
  const titleByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, job.title]));
  const descriptionByLocale = { it: job.description };
  const slugByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, baseSlug]));

  return [{
    ...job,
    slug: baseSlug,
    url,
    applyUrl: job.applyUrl,
    titleByLocale,
    slugByLocale,
    descriptionByLocale,
    id: `direct-${submission.id}`,
    source: DIRECT_EMPLOYER_SOURCE_KEY,
    postedDate: job.datePosted,
    postingDateSource: 'employer_verified_and_moderated',
    validThroughSource: 'employer_listing_30_day_expiry',
    directEmployerSubmissionId: submission.id,
    companyWebsite: job.companyWebsite || null,
    publisherJobId: null,
    publisherUid: null,
  }];
}

export function directEmployerSubmissionsToSlice(submissions, options = {}) {
  if (!Array.isArray(submissions)) return [];
  return submissions.flatMap((submission) => directEmployerSubmissionToRecords(submission, options));
}
