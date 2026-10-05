export interface PostingDateInput {
  readonly postingDateSource?: 'reported' | 'unknown' | string | null;
  readonly datePosted?: string | null;
  readonly postedDate?: string | null;
}
/** Sign-only comparison of validated ISO dates, retaining up to microsecond precision. */
export function compareValidatedPostingDates(first: string, second: string): number;
/** Original ISO string (up to six fractional digits), or null for unverifiable/invalid dates. */
export function resolveReportedPostingDate(input: PostingDateInput, now?: Date): string | null;
