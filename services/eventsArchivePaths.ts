import type { Locale } from './i18n';

/** Client-safe route vocabulary shared by the event producer and SPA router. */
export const EVENTS_ARCHIVE_SEGMENT: Record<Locale, string> = {
  it: 'archivio', en: 'archive', de: 'archiv', fr: 'archives',
};

export function eventArchivePath(basePath: string, locale: Locale, page = 1): string {
  const archive = `${basePath}${EVENTS_ARCHIVE_SEGMENT[locale]}/`;
  return page <= 1 ? archive : `${archive}page-${page}/`;
}
