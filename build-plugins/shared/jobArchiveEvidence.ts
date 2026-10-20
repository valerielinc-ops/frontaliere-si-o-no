type TitleRecord = { title?: unknown; titleByLocale?: Record<string, unknown>; source?: unknown };
const nonblank = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** The first argument is an exact alias match from the expired archive index.
 * GSC titles, source URLs and crawl/indexing signals alone are not job content:
 * sync-gsc-orphans also fills them by parsing the URL. Its cache/Wayback writers
 * preserve original localized titles and name the source explicitly.
 */
export function hasRecordedJobIdentity(archive?: TitleRecord | null, enriched?: TitleRecord | null): boolean {
  if (nonblank(archive?.title) || Object.values(archive?.titleByLocale || {}).some(nonblank)) return true;
  if (!Object.values(enriched?.titleByLocale || {}).some(nonblank) || !Array.isArray(enriched?.source)) return false;
  // The historical prefix matcher can pick another posting. Only the exact
  // cache producers (or the same URL's Wayback snapshot) establish identity.
  return enriched.source.some((source) => source === 'wayback' || source === 'translation-cache'
    || source === 'translation-cache:exact');
}

export const unverifiedJobCopy = {
  it: {
    title: 'Offerta non verificata',
    banner: 'Non abbiamo trovato l’annuncio originale per questo link. I riferimenti mostrati provengono dall’URL, non da un’offerta verificata. Consulta le posizioni attualmente disponibili.',
    details: 'Riferimenti ricavati dal link',
  },
  en: {
    title: 'Unverified job reference',
    banner: 'We could not find the original listing for this link. The references shown come from the URL, not a verified vacancy. Browse the positions currently available.',
    details: 'References derived from the link',
  },
  de: {
    title: 'Unbestätigte Stellenreferenz',
    banner: 'Wir haben das ursprüngliche Inserat zu diesem Link nicht gefunden. Die gezeigten Angaben stammen aus der URL, nicht aus einer bestätigten Stellenausschreibung. Sehen Sie sich die aktuell verfügbaren Stellen an.',
    details: 'Aus dem Link abgeleitete Angaben',
  },
  fr: {
    title: 'Référence d’emploi non vérifiée',
    banner: 'Nous n’avons pas trouvé l’annonce originale pour ce lien. Les références affichées proviennent de l’URL, pas d’une offre vérifiée. Consultez les postes actuellement disponibles.',
    details: 'Références déduites du lien',
  },
};
