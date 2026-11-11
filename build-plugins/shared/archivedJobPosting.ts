import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import { buildJobPostingSchema, isEmployerOwnedApplyUrl, type BuildJobPostingOptions, type JobInput } from './jobPostingSchema';
import { jobDescriptionPlainText } from '../../services/jobs/descriptionPreview';

/**
 * Historical metadata must never turn a closed vacancy into a live offer.
 *
 * `validThrough` is a fact of the archived RECORD, never of the build: the
 * persisted `expiredAt`, else the last crawler observation (`crawledAt`, when
 * the vacancy was last seen open), else its publication date. A record with
 * none of them gets NO JobPosting. It used to get "build clock − 1 day": a
 * deadline that was invented, and that moved at every build, so every such
 * soft landing changed bytes at every deploy (the dominant churn of the
 * berna/zurigo section shards, `reason=inline-content-changed` on
 * `"validThrough"`). Google's guidance for an expired posting is a past
 * `validThrough` or no markup; with no evidence of when it closed, no markup.
 *
 * The clock is used only to REJECT evidence dated in the future (a record
 * whose expiry has not happened yet is not an archive): that verdict changes
 * once, when the date passes, not at every build.
 */
export function buildArchivedJobPosting(job: JobInput, notice: string, options: BuildJobPostingOptions) {
  const clock = options.now || new Date();
  const now = clock.getTime();
  const archiveDates = [job.expiredAt, job.crawledAt, job.datePosted, job.postedDate]
    .map((value) => value ? Date.parse(value) : NaN);
  if (archiveDates.some((date) => Number.isFinite(date) && date >= now)) return null;
  const archiveValidThrough = archiveDates.find((date) => Number.isFinite(date));
  if (archiveValidThrough === undefined) return null;
  const datePosted = resolveReportedPostingDate(job, clock);
  if (datePosted && Date.parse(datePosted) >= archiveValidThrough) return null;

  const title = String(job.title || '').trim();
  const company = String(job.company || '').trim();
  const description = jobDescriptionPlainText(job.description || '');
  const identity = [title, company].filter(Boolean).join(' — ');
  const archiveNotice = String(notice || '').trim();
  const safeNotice = archiveNotice.length >= 50
    ? archiveNotice
    : `${archiveNotice} This archived vacancy is no longer available.`.trim();
  const archivedDescription = description.length >= 50
    ? description
    : [description, safeNotice, identity ? `${identity}${job.addressLocality ? `, ${job.addressLocality}` : ''}` : '']
      .filter(Boolean)
      .join(' ')
      .trim();

  // With no reported date, keep the schema fallback before the archive cutoff.
  // This is an archive boundary, not a fabricated posting date or expiry claim,
  // and it is read from the record: every archive date is already in the past.
  const schemaNow = datePosted
    ? clock
    : new Date(archiveValidThrough - 1);

  return buildJobPostingSchema({
    ...job,
    description: archivedDescription,
    datePosted: datePosted || undefined,
    validThrough: new Date(archiveValidThrough).toISOString(),
    validThroughSource: 'archive-evidence',
  }, {
    ...options,
    now: schemaNow,
    // The assisted application (directApply: true on active pages, owner
    // decision 2026-11-10) is not offered for a closed vacancy, so an archive
    // keeps the evidence-only rule: true only when the recorded apply URL is
    // on the employer's own domain.
    directApply: isEmployerOwnedApplyUrl(job),
  });
}
