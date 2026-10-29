import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import { buildJobPostingSchema, type BuildJobPostingOptions, type JobInput } from './jobPostingSchema';
import { jobDescriptionPlainText } from '../../services/jobs/descriptionPreview';

/** Historical metadata must never turn a closed vacancy into a live offer. */
export function buildArchivedJobPosting(job: JobInput, notice: string, options: BuildJobPostingOptions) {
  if (!job.title?.trim() || !job.company?.trim()) return null;
  const now = (options.now || new Date()).getTime();
  const validThrough = [job.expiredAt, job.crawledAt, job.datePosted, job.postedDate]
    .map((value) => value ? Date.parse(value) : NaN)
    .find((date) => Number.isFinite(date) && date < now);
  const datePosted = resolveReportedPostingDate(job);
  if (!datePosted || validThrough === undefined || Date.parse(datePosted) >= validThrough) return null;
  const description = jobDescriptionPlainText(job.description || '');
  const archivedDescription = description.length >= 50
    ? description
    : `${description} ${notice} ${job.title} — ${job.company}${job.addressLocality ? `, ${job.addressLocality}` : ''}`.trim();
  return buildJobPostingSchema({
    ...job,
    description: archivedDescription,
    datePosted,
    validThrough: new Date(validThrough).toISOString(),
  }, options);
}
