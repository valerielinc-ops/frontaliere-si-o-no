import type { ProfessionLocale } from '../professionLandingsData';
import { cantonAnnualMedianChf } from './cantonSalaryIndex';
import { escHtml } from './htmlEscape';
import { MIN_REPORTED_SALARY_SAMPLES, type ReportedSalarySummary } from './realSalaryMedian';

const BFS_SALARY_SOURCE = 'https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-0304010000_203/';

const COPY = {
  it: {
    sample: 'Mediana fasce dichiarate nel campione',
    benchmark: 'Benchmark generale della grande regione',
    year: 'lordi/anno',
    sampleNote: (n: number) => `Fonte: ${n} offerte pertinenti con fasce annue CHF di provenienza identificata. Mediana dei punti medi delle fasce, arrotondata a CHF 100; stime automatiche e provenienza ignota escluse. Non rappresenta l’intero mercato. Verifica orario e mensilità negli annunci originali.`,
    benchmarkNote: 'Campione salariale pertinente insufficiente (meno di 5 offerte documentate). Riferimento generale della grande regione del cantone, non della professione o città. UST, RSS 2024: mediana mensile standardizzata a tempo pieno × 12, arrotondata a CHF 100. Non è una retribuzione offerta.',
    source: 'Fonte UST / RSS 2024',
  },
  en: {
    sample: 'Median of reported ranges in the sample',
    benchmark: 'General major-region benchmark',
    year: 'gross/year',
    sampleNote: (n: number) => `Source: ${n} matching listings with identified annual CHF salary provenance. Median of range midpoints, rounded to CHF 100; automatic estimates and unknown provenance excluded. Not a market-wide statistic. Check hours and instalments in the original listings.`,
    benchmarkNote: 'Insufficient matching salary sample (fewer than 5 documented listings). General benchmark for the canton’s major region, not this profession or city. FSO, SES 2024: standardised full-time monthly median × 12, rounded to CHF 100. Not an offered salary.',
    source: 'FSO / SES 2024 source',
  },
  de: {
    sample: 'Median gemeldeter Lohnspannen der Stichprobe',
    benchmark: 'Allgemeiner Vergleichswert der Grossregion',
    year: 'brutto/Jahr',
    sampleNote: (n: number) => `Quelle: ${n} passende Anzeigen mit nachvollziehbaren jährlichen CHF-Lohnangaben. Median der Spannenmittelpunkte, auf CHF 100 gerundet; automatische Schätzungen und unbekannte Herkunft ausgeschlossen. Keine Statistik des gesamten Arbeitsmarkts. Arbeitszeit und Auszahlungen in den Originalanzeigen prüfen.`,
    benchmarkNote: 'Unzureichende passende Lohnstichprobe (weniger als 5 dokumentierte Anzeigen). Allgemeiner Vergleichswert der Grossregion des Kantons, nicht dieses Berufs oder dieser Stadt. BFS, LSE 2024: standardisierter Vollzeit-Monatsmedian × 12, auf CHF 100 gerundet. Kein angebotener Lohn.',
    source: 'Quelle BFS / LSE 2024',
  },
  fr: {
    sample: 'Médiane des fourchettes déclarées de l’échantillon',
    benchmark: 'Repère général de la grande région',
    year: 'bruts/an',
    sampleNote: (n: number) => `Source : ${n} annonces pertinentes avec fourchettes annuelles en CHF de provenance identifiée. Médiane des points centraux, arrondie à CHF 100 ; estimations automatiques et provenance inconnue exclues. Ce n’est pas une statistique de tout le marché. Vérifiez horaires et versements dans les annonces originales.`,
    benchmarkNote: 'Échantillon salarial pertinent insuffisant (moins de 5 annonces documentées). Repère général de la grande région du canton, pas de ce métier ou de cette ville. OFS, ESS 2024 : médiane mensuelle standardisée à plein temps × 12, arrondie à CHF 100. Ce n’est pas un salaire proposé.',
    source: 'Source OFS / ESS 2024',
  },
} satisfies Record<ProfessionLocale, {
  sample: string;
  benchmark: string;
  year: string;
  sampleNote: (n: number) => string;
  benchmarkNote: string;
  source: string;
}>;

/** These collection pages never describe a benchmark as a JobPosting salary. */
export function professionSalaryPresentation(
  locale: ProfessionLocale,
  cantonKey: string,
  summary?: ReportedSalarySummary,
): { label: string; value: string; noteHtml: string; source: 'sample' | 'benchmark' } {
  const c = COPY[locale];
  const hasSample = Boolean(summary && Number.isInteger(summary.sampleCount)
    && summary.sampleCount >= MIN_REPORTED_SALARY_SAMPLES
    && typeof summary.medianChf === 'number' && Number.isFinite(summary.medianChf)
    && summary.medianChf >= 20000 && summary.medianChf <= 300000);
  const value = hasSample ? summary!.medianChf! : cantonAnnualMedianChf(cantonKey);
  const formatted = Math.round(value / 100) * 100;
  const amount = new Intl.NumberFormat({ it: 'it-CH', en: 'en-US', de: 'de-CH', fr: 'fr-CH' }[locale]).format(formatted);
  const note = hasSample ? c.sampleNote(summary!.sampleCount) : c.benchmarkNote;
  const citation = hasSample ? '' : ` <a class="text-accent underline" href="${BFS_SALARY_SOURCE}">${escHtml(c.source)}</a>`;
  return {
    source: hasSample ? 'sample' : 'benchmark',
    label: hasSample ? c.sample : c.benchmark,
    value: `≈ CHF ${amount} ${c.year}`,
    noteHtml: `<p class="mt-3 text-sm text-body" data-salary-provenance="${hasSample ? 'sample' : 'benchmark'}">${escHtml(note)}${citation}</p>`,
  };
}
