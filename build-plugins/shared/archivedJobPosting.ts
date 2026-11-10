import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import { buildJobPostingSchema, isEmployerOwnedApplyUrl, type BuildJobPostingOptions, type JobInput } from './jobPostingSchema';
import { jobDescriptionPlainText } from '../../services/jobs/descriptionPreview';

const ARCHIVE_FALLBACK_DAYS = 1;

/** Historical metadata must never turn a closed vacancy into a live offer. */
export function buildArchivedJobPosting(job: JobInput, notice: string, options: BuildJobPostingOptions) {
  const clock = options.now || new Date();
  const now = clock.getTime();
  const archiveDates = [job.expiredAt, job.crawledAt, job.datePosted, job.postedDate]
    .map((value) => value ? Date.parse(value) : NaN);
  if (archiveDates.some((date) => Number.isFinite(date) && date >= now)) return null;
  const validThrough = archiveDates.find((date) => Number.isFinite(date) && date < now);
  const archiveValidThrough = validThrough ?? now - ARCHIVE_FALLBACK_DAYS * 24 * 60 * 60 * 1000;
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
  // This is an archive boundary, not a fabricated posting date or expiry claim.
  const schemaNow = datePosted
    ? clock
    : new Date(Math.min(now - 1, archiveValidThrough - 1));

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
