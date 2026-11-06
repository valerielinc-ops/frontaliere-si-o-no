import { composeSerpJobTitle, finalizeJobBoardTitle, TITLE_MAX_CHARS } from './titleSuffix';

export const JOB_TITLE_LOCALE_LABELS = {
  it: 'Italiano', en: 'English', de: 'Deutsch', fr: 'Français',
} as const;
type Locale = keyof typeof JOB_TITLE_LOCALE_LABELS;

/** Compare both headline shapes that the job renderer can actually emit. */
export function jobTitleLocaleKeys(
  title: string, company: string, location: string, locale: string,
  measureLength: (value: string) => number,
): string[] {
  return [false, true].map((cityOptional) => {
    const composed = composeSerpJobTitle(title, company, location, locale, { cityOptional, measureLength });
    return finalizeJobBoardTitle(composed, TITLE_MAX_CHARS, measureLength)
      .replace(/\s+/g, ' ').trim().toLowerCase();
  });
}

/** A recorded archive identity is shared by every locale, even in shard builds. */
export function jobTitleLocaleQualifiers(
  title: string, company: string, location: string,
  measureLength: (value: string) => number,
  titlesByLocale: Partial<Record<Locale, string>> = {},
): Partial<Record<Locale, string>> {
  const locales = Object.keys(JOB_TITLE_LOCALE_LABELS) as Locale[];
  const keys = locales.map((locale) => jobTitleLocaleKeys(titlesByLocale[locale] || title, company, location, locale, measureLength));
  const qualifiers: Partial<Record<Locale, string>> = {};
  for (let index = 1; index < locales.length; index++) {
    if (keys[index].some((key) => keys.slice(0, index).some((earlier) => earlier.includes(key)))) {
      qualifiers[locales[index]] = JOB_TITLE_LOCALE_LABELS[locales[index]];
    }
  }
  return qualifiers;
}
