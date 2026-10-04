import {
  buildJobPostingSchema,
  type JobInput,
  type BuildJobPostingOptions,
  type JobPostingSchema,
} from '../../build-plugins/shared/jobPostingSchema';

/** Explicit reported-date fixture for tests of unrelated mandatory schema fields. */
export function buildReportedJobPostingFixture(job: JobInput, options: BuildJobPostingOptions): JobPostingSchema {
  const now = options.now || new Date();
  const postedDate = new Date(now.getTime() - 86400000).toISOString();
  const schema = buildJobPostingSchema({ postingDateSource: 'reported', postedDate, ...job }, options);
  if (!schema) throw new Error('Reported fixture requires a valid employer publication date');
  return schema;
}
