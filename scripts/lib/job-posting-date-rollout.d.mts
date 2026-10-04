import type { PostingDateInput } from './job-posting-date.mjs';
export function hasPostingDateProvenance(input: PostingDateInput): boolean;
export function resolveRolloutPostingDate(input: PostingDateInput, legacyDate: () => string | null, now?: Date): string | null;
