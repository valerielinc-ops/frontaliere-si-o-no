/** A listing links to a job detail; only that detail may declare JobPosting. */
import type { JobInput } from './jobPostingSchema';
import { sanitizeJobTitleForDisplay } from './stripLiteralMarkdown';
import { jobDisplayTitle } from '../../scripts/lib/job-title-identity.mjs';

export interface JobListEntryOptions {
  readonly locale: string;
  readonly url: string;
  readonly baseUrl: string;
}

export function buildJobListEntry(
  input: JobInput,
  opts: JobListEntryOptions,
): Record<string, unknown> | null {
  // The employer's title in every locale (scripts/lib/job-title-identity.mjs):
  // the list entry names the same title its detail page shows.
  const name = sanitizeJobTitleForDisplay(jobDisplayTitle(input)).trim();
  if (!name || !opts.url) return null;
  return { '@type': 'WebPage', name, url: opts.url };
}
