export interface PostingDateInput {
  readonly postingDateSource?: 'reported' | 'unknown' | string | null;
  readonly datePosted?: string | null;
  readonly postedDate?: string | null;
  readonly firstSeenAt?: string | null;
  readonly crawledAt?: string | null;
  readonly scrapedAt?: string | null;
  readonly updatedAt?: string | null;
}
/** Sign-only comparison of validated ISO dates, retaining up to microsecond precision. */
export function compareValidatedPostingDates(first: string, second: string): number;
/** Original ISO string (up to six fractional digits), or null for unverifiable/invalid dates. */
export function resolveReportedPostingDate(input: PostingDateInput, now?: Date): string | null;
/** First observation ISO string, or null for missing/invalid/future timestamps. */
export function resolveFirstSeenPostingDate(input: PostingDateInput, now?: Date): string | null;
/** Earliest valid crawler observation (crawledAt/scrapedAt/updatedAt), or null. */
export function resolveObservedPostingDate(input: PostingDateInput, now?: Date): string | null;
export interface ResolvedSchemaPostingDate {
  readonly value: string;
  readonly provenance: JobPostingDateProvenance;
}
export type JobPostingDateProvenance = 'reported' | 'first-seen' | 'observed' | 'build-clock';
/** Mandatory JSON-LD value plus explicit provenance. Never null: an active job always has a datePosted. */
export function resolveSchemaPostingDate(input: PostingDateInput, now?: Date): ResolvedSchemaPostingDate;
