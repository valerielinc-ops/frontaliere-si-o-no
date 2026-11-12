import type { PostingDateInput } from './job-posting-date.mjs';
/** Most recent qualifying ISO date string for a job, or null when none exists. */
export function jobSitemapLastmodSource(job: PostingDateInput | null | undefined, now?: Date): string | null;
/** `YYYY-MM-DD` (UTC day) of jobSitemapLastmodSource, or undefined. */
export function jobSitemapLastmodDay(job: PostingDateInput | null | undefined, now?: Date): string | undefined;
