import { articleSourceDate } from '../packages/articles/engine/shared/sourceDates';
export { articleSourceDate, isUnknownArticleDate } from '../packages/articles/engine/shared/sourceDates';

export function articleSchemaDates(article: { date?: string; updatedAt?: string }, now = new Date()): {
  datePublished?: string;
  dateModified?: string;
} {
  const published = articleSourceDate(article.date, now);
  const modified = articleSourceDate(article.updatedAt, now);
  return {
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
  };
}

/** Unknown dates follow dated entries, with a stable identity order. */
export function compareArticleSourceDates(
  a: { id: string; date?: string },
  b: { id: string; date?: string },
): number {
  const aDate = articleSourceDate(a.date);
  const bDate = articleSourceDate(b.date);
  if (!aDate && !bDate) return a.id.localeCompare(b.id);
  if (!aDate) return 1;
  if (!bDate) return -1;
  return Date.parse(bDate) - Date.parse(aDate);
}
