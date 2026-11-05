import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import { buildJobPostingSchema, type BuildJobPostingOptions, type JobInput } from './jobPostingSchema';
import { jobDescriptionPlainText } from '../../services/jobs/descriptionPreview';

const ARCHIVE_FALLBACK_DAYS = 1;

/** Historical metadata must never turn a closed vacancy into a live offer. */
export function buildArchivedJobPosting(job: JobInput, notice: string, options: BuildJobPostingOptions) {
  const clock = options.now || new Date();
  const now = clock.getTime();
  const archiveDates = [job.expiredAt, job.crawledAt, job.datePosted, job.postedDate]
    .map((value) => value ? Date.parse(value) : NaN);
  const validThrough = archiveDates.find((date) => Number.isFinite(date) && date < now);
  if (validThrough === undefined && archiveDates.some((date) => Number.isFinite(date) && date >= now)) return null;
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
  }, { ...options, now: schemaNow });
}
