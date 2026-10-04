export interface PostingDateInput {
  readonly postingDateSource?: 'reported' | 'unknown' | string | null;
  readonly datePosted?: string | null;
  readonly postedDate?: string | null;
}
/** A validated employer publication date, or null for unverifiable/invalid dates. */
export function resolveReportedPostingDate(input: PostingDateInput, now?: Date): string | null;
