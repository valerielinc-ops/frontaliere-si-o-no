import { formatUpdatedDate, type LandingLocale } from './humanDate';

const GENERATION_LABEL: Record<LandingLocale, string> = {
  it: 'Pagina generata',
  en: 'Page generated',
  de: 'Seite erstellt',
  fr: 'Page générée',
};

/** A build timestamp describes page generation, not source freshness or review. */
export function formatPageGenerationDate(dateStamp: string, locale: LandingLocale): string {
  return `${GENERATION_LABEL[locale]} · ${formatUpdatedDate(dateStamp, locale)}`;
}
