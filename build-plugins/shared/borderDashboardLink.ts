import { buildRootHubPath, type BorderWaitLocale } from '../borderWaitData';

/** A crawlable next step from the directory to current traffic observations. */
export function renderBorderDashboardLink(locale: string): string {
  const labels: Record<BorderWaitLocale, [string, string, string]> = {
    it: ['Prima di partire, confronta le', 'attese aggiornate ai valichi', 'Controlla la fonte e l’ora della rilevazione prima di scegliere il percorso.'],
    en: ['Before leaving, compare', 'current border wait estimates', 'Check the source and observation time before choosing your route.'],
    de: ['Vergleiche vor der Abfahrt die', 'aktuellen Wartezeiten an den Grenzübergängen', 'Prüfe Quelle und Beobachtungszeit, bevor du die Route wählst.'],
    fr: ['Avant de partir, comparez les', 'attentes actualisées aux passages frontaliers', 'Vérifiez la source et l’heure de la mesure avant de choisir votre trajet.'],
  };
  const lang = (locale in labels ? locale : 'it') as BorderWaitLocale;
  const [intro, anchor, detail] = labels[lang];
  return `<p class="s-N03jFT">${intro} <a class="s-U9K6Vf" href="${buildRootHubPath(lang)}">${anchor}</a>. ${detail}</p>`;
}
