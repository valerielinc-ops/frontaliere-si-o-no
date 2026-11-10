/**
 * Visible relative publication ages that static job HTML must never carry:
 * "10 giorni fa", "1 day ago", "vor 3 Tagen", "il y a 2 jours". Such text is
 * false the day after the build and rewrites every job page at every build.
 * Scripts are stripped first: the hydrated SPA may legitimately compute a
 * relative label at runtime, the static markup may not.
 */
export const RELATIVE_POSTED_TEXT =
  /\b\d+\s+giorn[io]\s+fa\b|\b\d+\s+days?\s+ago\b|\bvor\s+\d+\s+Tag(?:en)?\b|\bil\s+y\s+a\s+\d+\s+jours?\b/i;

export function findRelativePostedText(html: string): string | null {
  const visible = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return RELATIVE_POSTED_TEXT.exec(visible)?.[0] ?? null;
}
