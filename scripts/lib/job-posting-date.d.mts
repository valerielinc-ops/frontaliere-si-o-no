export interface PostingDateInput {
  readonly postingDateSource?: 'reported' | 'unknown' | string | null;
  readonly datePosted?: string | null;
  readonly postedDate?: string | null;
  readonly crawledAt?: string | null;
  readonly firstSeenAt?: string | null;
  readonly scrapedAt?: string | null;
}
/** A validated employer publication date, or null for unverifiable/invalid dates. */
export function resolveReportedPostingDate(input: PostingDateInput, now?: Date): string | null;
/** A schema-safe date; unknown provenance remains non-reported. */
export function resolveSchemaPostingDate(input: PostingDateInput, now?: Date): string | null;
