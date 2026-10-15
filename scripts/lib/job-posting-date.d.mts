export interface PostingDateInput {
  readonly postingDateSource?: 'reported' | 'unknown' | string | null;
  readonly datePosted?: string | null;
  readonly postedDate?: string | null;
}
/** Sign-only comparison of validated ISO dates, retaining up to microsecond precision. */
export function compareValidatedPostingDates(first: string, second: string): number;
/** Original ISO string (up to six fractional digits), or null for unverifiable/invalid dates. */
export function resolveReportedPostingDate(input: PostingDateInput, now?: Date): string | null;
/** Stable schema-only sentinel; never derived from collection or build clocks. */
export const JOB_POSTING_DATE_SAFE_DEFAULT: '1970-01-01';
export interface ResolvedSchemaPostingDate {
  readonly value: string;
  readonly provenance: 'reported' | 'safe-default';
}
/** Mandatory JSON-LD value plus explicit provenance. */
export function resolveSchemaPostingDate(input: PostingDateInput, now?: Date, allowSafeDefault?: boolean): ResolvedSchemaPostingDate | null;
