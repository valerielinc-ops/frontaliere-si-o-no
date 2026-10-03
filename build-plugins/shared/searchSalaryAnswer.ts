import { reportedSalarySummary, type SalaryCarrier } from './realSalaryMedian';

type SalaryLocale = 'it' | 'en' | 'de' | 'fr';

export { hasSalaryIntent } from '../../services/jobSearchIntent';

export function searchSalaryMedian(jobs: readonly (SalaryCarrier & { currency?: string })[]): number {
  return reportedSalarySummary(jobs).medianChf || 0;
}

export function buildSalaryAnswer(locale: SalaryLocale, med: string): string {
  const available: Record<SalaryLocale, string> = {
    it: `La mediana dei punti medi delle fasce salariali annue CHF nelle offerte pertinenti del campione attuale è ${med}. Sono necessarie almeno cinque schede con provenienza salariale identificata; le stime automatiche sono escluse. Non è una statistica dell'intero mercato. Verifica importo, orario e mensilità nell'annuncio originale.`,
    en: `The median midpoint of annual CHF salary ranges in the current matching sample is ${med}. At least five listings with identified salary provenance are required; automatic estimates are excluded. This is not a market-wide statistic. Check pay, hours and instalments in the original listing.`,
    de: `Der Median der Mittelpunkte jährlicher CHF-Lohnspannen in der aktuellen passenden Stichprobe beträgt ${med}. Mindestens fünf Anzeigen mit nachvollziehbarer Lohnherkunft sind erforderlich; automatische Schätzungen sind ausgeschlossen. Dies ist keine Statistik des gesamten Arbeitsmarkts. Prüfen Sie Lohn, Arbeitszeit und Auszahlungen in der Originalanzeige.`,
    fr: `La médiane des points centraux des fourchettes salariales annuelles en CHF de cet échantillon pertinent est ${med}. Il faut au moins cinq annonces dont la provenance salariale est identifiée ; les estimations automatiques sont exclues. Ce chiffre ne représente pas tout le marché. Vérifiez salaire, horaires et versements dans l’annonce originale.`,
  };
  const missing: Record<SalaryLocale, string> = {
    it: 'Non disponiamo di almeno cinque offerte pertinenti con dati salariali annui CHF di provenienza identificata per rispondere a questa ricerca. Non pubblichiamo una cifra stimata come salario del ruolo. Consulta gli annunci originali e chiedi la fascia retributiva al datore di lavoro; il calcolatore converte un lordo noto in una simulazione del netto.',
    en: 'There are fewer than five matching listings with identified annual CHF salary data for this search. We do not present an estimated figure as the salary for this role. Check the original listings and ask the employer for its pay range; the calculator converts a known gross salary into a net-pay simulation.',
    de: 'Für diese Suche liegen weniger als fünf passende Anzeigen mit nachvollziehbaren jährlichen CHF-Lohndaten vor. Wir geben keine Schätzung als Berufslohn aus. Prüfen Sie die Originalanzeigen und fragen Sie den Arbeitgeber nach der Lohnspanne; der Rechner simuliert den Nettolohn aus einem bekannten Bruttolohn.',
    fr: 'Cette recherche comporte moins de cinq annonces pertinentes avec des données salariales annuelles en CHF de provenance identifiée. Nous ne présentons pas une estimation comme le salaire du métier. Consultez les annonces originales et demandez la fourchette à l’employeur ; le calculateur simule le net à partir d’un brut connu.',
  };
  return med ? available[locale] : missing[locale];
}

