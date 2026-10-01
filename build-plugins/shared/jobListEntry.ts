/** A listing links to a job detail; only that detail may declare JobPosting. */
import type { JobInput } from './jobPostingSchema';
import { sanitizeJobTitleForDisplay } from './stripLiteralMarkdown';

export interface JobListEntryOptions {
  readonly locale: string;
  readonly url: string;
  readonly baseUrl: string;
}

export function buildJobListEntry(
  input: JobInput,
  opts: JobListEntryOptions,
): Record<string, unknown> | null {
  const name = sanitizeJobTitleForDisplay(String(input.titleByLocale?.[opts.locale] || input.title || '')).trim();
  if (!name || !opts.url) return null;
  return { '@type': 'WebPage', name, url: opts.url };
}
