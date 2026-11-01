/**
 * Real "last changed" dates of content whose source has no date of its own.
 *
 * `data/content-dates.json` is written by `scripts/update-content-dates.ts` and
 * kept honest by `tests/content-dates.test.ts`. A date here says the text or the
 * parameters changed, nothing more: it is never a human review.
 */
import contentDates from '../data/content-dates.json';

interface DatedHash {
  readonly updatedAt: string;
  readonly hash: string;
}

const CONTENT_DATES: { readonly fiscalParams: DatedHash; readonly faq: Readonly<Record<string, DatedHash>> } = contentDates;

/** Last change to the parameters and formulas behind the calculators. */
export const FISCAL_PARAMS_UPDATED_AT = CONTENT_DATES.fiscalParams.updatedAt;

/** Last change to a FAQ entry's question, answer or sources. */
export function faqEntryUpdatedAt(id: string): string {
  const record = CONTENT_DATES.faq[id];
  if (!record) throw new Error(`faqEntryUpdatedAt: "${id}" missing from data/content-dates.json`);
  return record.updatedAt;
}
