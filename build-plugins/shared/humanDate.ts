/**
 * Human-readable "Aggiornato <data>" date for static SEO landings.
 *
 * Every landing plugin used to print the raw ISO `dateStamp` (e.g.
 * "Aggiornato 2026-06-11") — machine format shown to users. One definition
 * here so the profession / career / cost-of-living / nursing landings can't
 * drift apart (AGENTS.md rule: shared construct → one module).
 */

export type LandingLocale = 'it' | 'en' | 'de' | 'fr';

const INTL_LOCALE: Record<LandingLocale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

/**
 * Format a build `dateStamp` (YYYY-MM-DD) as a long localized date, e.g.
 * it → "11 giugno 2026", de → "11. Juni 2026". Falls back to the raw stamp
 * when the input is unparsable.
 */
export function formatUpdatedDate(dateStamp: string, locale: LandingLocale): string {
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Zurich',
    }).format(new Date(`${dateStamp}T12:00:00Z`));
  } catch {
    return dateStamp;
  }
}

/**
 * Full "updated" sentence with the locale-correct preposition/article, e.g.
 * it → "Aggiornato l'11 giugno 2026", de → "Aktualisiert am 11. Juni 2026".
 * Italian elides the article before vowel-initial day numerals (l'1, l'8, l'11).
 */
export function formatUpdatedSentence(dateStamp: string, locale: LandingLocale): string {
  const date = formatUpdatedDate(dateStamp, locale);
  if (date === dateStamp) {
    // Unparsable stamp — neutral label + raw value, never a broken sentence.
    return `${{ it: 'Aggiornato', en: 'Updated', de: 'Aktualisiert', fr: 'Mis à jour' }[locale]} ${dateStamp}`;
  }
  switch (locale) {
    case 'it': {
      const day = Number(dateStamp.slice(8, 10));
      const article = [1, 8, 11].includes(day) ? "l'" : 'il ';
      return `Aggiornato ${article}${date}`;
    }
    case 'en':
      return `Updated ${date}`;
    case 'de':
      return `Aktualisiert am ${date}`;
    case 'fr':
      return `Mis à jour le ${date}`;
  }
}
