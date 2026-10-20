import type { ProfessionLocale } from '../professionLandingsData';
import type { ReportedSalarySummary } from './realSalaryMedian';
import { escHtml } from './htmlEscape';

/** Collection statistics describe matching reported ranges, never the whole market. */
export function reportedSalaryNote(locale: ProfessionLocale, summary?: ReportedSalarySummary): string {
  const n = summary?.sampleCount ?? 0;
  const text = {
    it: `Campione: ${n} offerte pertinenti con fasce salariali dichiarate nella fonte, annualizzate in CHF lordi. Mediana dei punti medi delle fasce, pubblicata solo con almeno 5 osservazioni; stime e provenienza ignota escluse. Non rappresenta l’intero mercato. Verifica orario e mensilità negli annunci originali.`,
    en: `Sample: ${n} matching listings with source-reported salary ranges, annualised in gross CHF. Median of range midpoints, shown only with at least 5 observations; estimates and unknown provenance excluded. Not a market-wide statistic. Check hours and instalments in the original listings.`,
    de: `Stichprobe: ${n} passende Anzeigen mit Lohnspannen aus der Originalquelle, auf jährliche Brutto-CHF umgerechnet. Median der Spannenmittelpunkte, erst ab 5 Beobachtungen angezeigt; Schätzungen und unbekannte Herkunft ausgeschlossen. Keine Statistik des gesamten Arbeitsmarkts. Arbeitszeit und Auszahlungen in den Originalanzeigen prüfen.`,
    fr: `Échantillon : ${n} annonces pertinentes avec fourchettes déclarées dans la source, annualisées en CHF bruts. Médiane des points centraux, affichée à partir de 5 observations ; estimations et provenance inconnue exclues. Ce n’est pas une statistique de tout le marché. Vérifiez horaires et versements dans les annonces originales.`,
  }[locale];
  return `<p class="mt-3 text-sm text-body" data-salary-provenance="reported-sample">${escHtml(text)}</p>`;
}
