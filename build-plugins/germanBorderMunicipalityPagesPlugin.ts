/**
 * Per-municipality GERMANY border pages (issue #4882, second of the FR/DE/LI
 * rollout after France #4545/#4878 — Baden-Württemberg corridor: Landkreise
 * Lörrach/Waldshut/Konstanz/Schwarzwald-Baar-Kreis).
 *
 * Emits, for every German Gemeinde in the corridor that is ABOVE the
 * population/distance floor (data/german-border-municipalities.json), a page:
 *
 *   /vivere-in-germania-lavorare-in-svizzera/{slug}/   (it, + 3 locale prefixes)
 *   "Vivere a {Gemeinde} e lavorare in Svizzera: frontaliere in Germania"
 *
 * with the sourced Art. 15a Grenzgänger regime facts (GERMAN_REGIME_TAX in
 * germanBorderMunicipalityData.ts — UNIFORM across every Gemeinde, unlike the
 * French per-canton REGIME_TAX split: this treaty gives every Gemeinde the
 * same mechanism regardless of which Swiss canton it borders).
 *
 * Gemeinden BELOW the floor get a noindex,follow bridge at the SAME URL
 * (never a silent 404 — AGENTS.md § Static SEO Pages), paired with the
 * self-map in build-plugins/searchConsoleCompat.ts.
 *
 * Architectural note: follows the FRANCE/FISCAL page pattern deliberately
 * (see germanBorderMunicipalityData.ts header) — self-contained module, no
 * hubChrome, no bespoke locale-rewrite in services/router.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { resolveGermanBorderMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { getCantonDisplayName } from './shared/cantonDisplay';
import {
  GERMAN_LOCALES,
  GERMAN_ABOVE_FLOOR,
  GERMAN_BELOW_FLOOR,
  GERMAN_HUB_PATH,
  GERMAN_REGIME_TAX,
  germanMunicipalityPathFor,
  type GermanLocale,
  type GermanBorderMunicipality,
  type GermanLandkreis,
} from './germanBorderMunicipalityData';

const OG_LOCALE: Record<GermanLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SITEMAP_NAME = 'sitemap-comuni-germania.xml';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intlLang(locale: GermanLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}
function intFmt(n: number, locale: GermanLocale): string {
  return new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 0 }).format(n);
}

/** "4.5%" — derived from the sourced decimal rate, never a second hard-coded
 *  literal of the same number (drift-safe). */
const TAX_RATE_STR = `${(GERMAN_REGIME_TAX.quellensteuerRate * 100).toFixed(1)}%`;
const NON_RETURN_DAYS = GERMAN_REGIME_TAX.nonReturnThresholdDaysPerYear;
const HEALTH_OPTION_MONTHS = GERMAN_REGIME_TAX.healthInsuranceOptionDeadlineMonths;

// ── Localized copy ──────────────────────────────────────────────

interface Copy {
  role: string;
  updated: string;
  home: string;
  hubLabel: string;
  h1: (n: string) => string;
  title: (n: string) => string;
  /** Second cascade rung for <title> (composePlaceTitle) — shorter than
   *  `title` but still keyword-bearing (issue #4886: a bare-name last
   *  candidate is CTR-dead, no query-intent signal). German Gemeinde names
   *  run long (e.g. "Bonndorf im Schwarzwald", 23 chars) so this regime
   *  needs the cascade more than the French one did. */
  titleMid: (n: string) => string;
  /** Shortest cascade rung for <title> — never the bare Gemeinde name. */
  titleShort: (n: string) => string;
  desc: (n: string) => string;
  lede: (n: string) => string;
  tilePop: string;
  tileDistance: string;
  tilePlz: string;
  tileTax: string;
  distanceUnit: string;
  explainTaxTitle: string;
  explainTax: (n: string) => string;
  explainNonReturnTitle: string;
  explainNonReturn: string;
  explainHealthTitle: string;
  explainHealth: string;
  crossTitle: string;
  calcLink: string;
  relatedTitle: string;
  faqTitle: string;
  faqQ1: (n: string) => string;
  faqA1: (n: string) => string;
  faqQ2: string;
  faqA2: string;
  faqQ3: string;
  faqA3: string;
  faqQ4: string;
  faqA4: string;
  disclaimer: string;
  hubTitle: string;
  hubLede: string;
  groupLandkreis: (landkreis: string) => string;
  bridgeLede: (n: string) => string;
}

const COPY: Record<GermanLocale, Copy> = {
  it: {
    role: 'Guida frontalieri',
    updated: 'Aggiornato',
    home: 'Home',
    hubLabel: 'Vivere in Germania e lavorare in Svizzera',
    h1: (n) => `Vivere a ${n} e lavorare in Svizzera: frontaliere in Germania (art. 15a)`,
    title: (n) => `Vivere a ${n} e lavorare in Svizzera`,
    titleMid: (n) => `${n}: frontaliere in Germania`,
    titleShort: (n) => `Vivere a ${n}`,
    desc: (n) => `Imposta alla fonte, giorni di non rientro e assicurazione malattia per chi vive a ${n} e lavora in Svizzera. Regime art. 15a.`,
    lede: (n) =>
      `${n} rientra nel regime frontalieri art. 15a DBA Germania-Svizzera: imposta alla fonte svizzera del ${TAX_RATE_STR} sul reddito lordo (con certificato di residenza), a condizione di non superare ${NON_RETURN_DAYS} giorni di non rientro all'anno.`,
    tilePop: 'Popolazione',
    tileDistance: 'Distanza dal valico',
    tilePlz: 'CAP',
    tileTax: 'Imposta alla fonte',
    distanceUnit: 'km',
    explainTaxTitle: 'Come funziona la tassazione',
    explainTax: (n) =>
      `Chi vive a ${n} e lavora come frontaliere in Svizzera è tassato secondo l'art. 15a dell'accordo Germania-Svizzera: il datore di lavoro svizzero trattiene alla fonte il ${TAX_RATE_STR} del reddito lordo, a condizione che il lavoratore presenti un certificato di residenza (Ansässigkeitsbescheinigung). La Germania evita la doppia imposizione riconoscendo un credito d'imposta (metodo dell'accreditamento) per quanto trattenuto in Svizzera. Il regime si applica su tutto il territorio, senza restrizioni di fascia geografica di confine.`,
    explainNonReturnTitle: `Giorni di non rientro: la soglia dei ${NON_RETURN_DAYS} giorni`,
    explainNonReturn:
      `Lo status di frontaliere si perde per l'INTERO anno fiscale se si superano ${NON_RETURN_DAYS} giorni lavorativi di non rientro al domicilio. Per chi lavora part-time la soglia è proporzionale: 5 giorni al mese lavorato più 1 giorno alla settimana lavorata. I giorni di telelavoro (homeoffice) NON contano come giorni di non rientro.`,
    explainHealthTitle: 'Assicurazione malattia: il diritto di opzione',
    explainHealth:
      `Il frontaliere può scegliere di uscire dall'assicurazione malattia obbligatoria svizzera per restare nel sistema tedesco (diritto di opzione, base legale art. 2 cpv. 6 OAMal). La scelta va esercitata esplicitamente entro ${HEALTH_OPTION_MONTHS} mesi dall'inizio dell'attività: l'esercizio tacito non è valido, e la scelta è generalmente irrevocabile una volta fatta.`,
    crossTitle: 'Approfondimenti utili',
    calcLink: 'Calcola il tuo stipendio netto',
    relatedTitle: 'Altri comuni del corridoio',
    faqTitle: 'Domande frequenti',
    faqQ1: (n) => `Che regime fiscale si applica a ${n}?`,
    faqA1: (n) => `${n} segue il regime frontalieri art. 15a DBA Germania-Svizzera: imposta alla fonte svizzera del ${TAX_RATE_STR} sul reddito lordo, uniforme indipendentemente dal cantone svizzero di impiego.`,
    faqQ2: `Cosa succede se non rientro a casa ogni giorno?`,
    faqA2:
      `Superare ${NON_RETURN_DAYS} giorni lavorativi di non rientro all'anno fa perdere lo status di frontaliere per l'intero anno. I giorni di telelavoro non contano ai fini di questa soglia.`,
    faqQ3: 'Posso restare assicurato con la cassa malattia tedesca?',
    faqA3: `Sì, tramite il diritto di opzione (art. 2 cpv. 6 OAMal): va esercitato esplicitamente entro ${HEALTH_OPTION_MONTHS} mesi dall'inizio del lavoro in Svizzera ed è generalmente irrevocabile.`,
    faqQ4: 'Servono moduli particolari per ottenere lo status di frontaliere?',
    faqA4:
      "La procedura amministrativa (moduli, certificazioni) può variare ed essere soggetta a cambiamenti: verifica sempre i requisiti aggiornati con il tuo cantone svizzero di impiego prima di iniziare l'attività.",
    disclaimer:
      'Stime a scopo orientativo. La tassazione effettiva dipende da situazione familiare, deduzioni e certificazioni. Verifica sempre con un consulente fiscale o con il cantone di impiego.',
    hubTitle: 'Vivere in Germania e lavorare in Svizzera, comune per comune',
    hubLede:
      `Imposta alla fonte (${TAX_RATE_STR} uniforme, art. 15a), soglia dei ${NON_RETURN_DAYS} giorni di non rientro e diritto di opzione sull'assicurazione malattia per i comuni tedeschi del corridoio Baden-Württemberg (Lörrach, Waldshut, Costanza, Schwarzwald-Baar-Kreis).`,
    groupLandkreis: (l) => `Landkreis ${l}`,
    bridgeLede: (n) =>
      `${n} è nel corridoio di confine ma è oltre la soglia di distanza/popolazione: la guida dedicata non è ancora pubblicata. Usa il calcolatore o esplora i comuni principali del corridoio.`,
  },
  en: {
    role: 'Cross-border guide',
    updated: 'Updated',
    home: 'Home',
    hubLabel: 'Living in Germany, working in Switzerland',
    h1: (n) => `Living in ${n} and working in Switzerland: German cross-border worker (§15a)`,
    title: (n) => `Living in ${n}, working in Switzerland`,
    titleMid: (n) => `${n}: German cross-border guide`,
    titleShort: (n) => `Living in ${n}`,
    desc: (n) => `Withholding tax, non-return days and health insurance for residents of ${n} working in Switzerland. §15a regime.`,
    lede: (n) =>
      `${n} falls under the §15a DBA Germany-Switzerland cross-border regime: Swiss withholding tax of ${TAX_RATE_STR} on gross pay (with a residence certificate on file), provided you don't exceed ${NON_RETURN_DAYS} non-return days per year.`,
    tilePop: 'Population',
    tileDistance: 'Distance to crossing',
    tilePlz: 'Postal code',
    tileTax: 'Withholding tax',
    distanceUnit: 'km',
    explainTaxTitle: 'How the taxation works',
    explainTax: (n) =>
      `Residents of ${n} working as cross-border commuters in Switzerland are taxed under §15a of the Germany-Switzerland treaty: the Swiss employer withholds ${TAX_RATE_STR} of gross pay at source, provided the worker files a residence certificate (Ansässigkeitsbescheinigung). Germany avoids double taxation via a tax credit (credit method) for the amount withheld in Switzerland. The regime applies across the whole territory, with no border-strip geographic restriction.`,
    explainNonReturnTitle: `Non-return days: the ${NON_RETURN_DAYS}-day threshold`,
    explainNonReturn:
      `Cross-border status is lost for the ENTIRE fiscal year if you exceed ${NON_RETURN_DAYS} non-return working days. For part-time work the threshold is proportional: 5 days per month worked plus 1 day per week worked. Homeoffice days do NOT count as non-return days.`,
    explainHealthTitle: 'Health insurance: the opt-out right',
    explainHealth:
      `A cross-border worker can opt out of compulsory Swiss health insurance to stay in the German system (Optionsrecht, legal basis Art. 2 para. 6 OAMal). The choice must be made explicitly within ${HEALTH_OPTION_MONTHS} months of starting work: tacit exercise is not valid, and the choice is generally irrevocable once made.`,
    crossTitle: 'Useful reading',
    calcLink: 'Calculate your net salary',
    relatedTitle: 'Other towns in the corridor',
    faqTitle: 'FAQ',
    faqQ1: (n) => `Which tax regime applies in ${n}?`,
    faqA1: (n) => `${n} follows the §15a DBA Germany-Switzerland regime: Swiss withholding tax of ${TAX_RATE_STR} on gross pay, uniform regardless of the Swiss canton of employment.`,
    faqQ2: 'What happens if I do not return home every day?',
    faqA2:
      `Exceeding ${NON_RETURN_DAYS} non-return working days per year loses cross-border status for the whole year. Homeoffice days do not count towards this threshold.`,
    faqQ3: 'Can I stay insured with German health insurance?',
    faqA3: `Yes, via the opt-out right (Art. 2 para. 6 OAMal): it must be exercised explicitly within ${HEALTH_OPTION_MONTHS} months of starting work in Switzerland and is generally irrevocable.`,
    faqQ4: 'Do I need special forms to get cross-border worker status?',
    faqA4:
      'The administrative procedure (forms, certificates) can vary and change: always check the current requirements with your Swiss canton of employment before starting work.',
    disclaimer:
      'Estimates for guidance only. Actual taxation depends on family situation, deductions and certificates. Always check with a tax adviser or your canton of employment.',
    hubTitle: 'Living in Germany, working in Switzerland, town by town',
    hubLede:
      `Withholding tax (uniform ${TAX_RATE_STR}, §15a), the ${NON_RETURN_DAYS}-day non-return threshold and the health-insurance opt-out right for the German towns in the Baden-Württemberg corridor (Lörrach, Waldshut, Konstanz, Schwarzwald-Baar-Kreis).`,
    groupLandkreis: (l) => `Landkreis ${l}`,
    bridgeLede: (n) =>
      `${n} is in the border corridor but beyond the distance/population floor, so its dedicated guide is not published yet. Use the calculator or explore the main towns in the corridor.`,
  },
  de: {
    role: 'Grenzgänger-Ratgeber',
    updated: 'Aktualisiert',
    home: 'Startseite',
    hubLabel: 'In Deutschland leben, in der Schweiz arbeiten',
    h1: (n) => `Leben in ${n} und Arbeiten in der Schweiz: Grenzgänger nach § 15a`,
    title: (n) => `Leben in ${n}, Arbeiten in der Schweiz`,
    titleMid: (n) => `${n}: Grenzgänger-Ratgeber Deutschland`,
    titleShort: (n) => `Leben in ${n}`,
    desc: (n) => `Quellensteuer, Nichtrückkehrtage und Krankenversicherung für Einwohner von ${n}, die in der Schweiz arbeiten. Regime § 15a.`,
    lede: (n) =>
      `${n} fällt unter das Grenzgänger-Regime nach Art. 15a DBA Deutschland-Schweiz: Schweizer Quellensteuer von ${TAX_RATE_STR} auf das Bruttoeinkommen (mit Ansässigkeitsbescheinigung), sofern nicht mehr als ${NON_RETURN_DAYS} Nichtrückkehrtage pro Jahr anfallen.`,
    tilePop: 'Einwohner',
    tileDistance: 'Distanz zum Grenzübergang',
    tilePlz: 'PLZ',
    tileTax: 'Quellensteuer',
    distanceUnit: 'km',
    explainTaxTitle: 'So funktioniert die Besteuerung',
    explainTax: (n) =>
      `Wer in ${n} wohnt und als Grenzgänger in der Schweiz arbeitet, wird nach Art. 15a des Abkommens Deutschland-Schweiz besteuert: Der Schweizer Arbeitgeber behält ${TAX_RATE_STR} des Bruttolohns an der Quelle ein, sofern eine Ansässigkeitsbescheinigung vorliegt. Deutschland vermeidet die Doppelbesteuerung durch Anrechnung (Anrechnungsmethode) der in der Schweiz einbehaltenen Steuer. Das Regime gilt im gesamten Gebiet, ohne geografische Grenzzonen-Beschränkung.`,
    explainNonReturnTitle: `Nichtrückkehrtage: die ${NON_RETURN_DAYS}-Tage-Schwelle`,
    explainNonReturn:
      `Der Grenzgängerstatus geht für das GESAMTE Steuerjahr verloren, wenn mehr als ${NON_RETURN_DAYS} Nichtrückkehr-Arbeitstage anfallen. Bei Teilzeitarbeit gilt die Schwelle anteilig: 5 Tage pro gearbeitetem Monat plus 1 Tag pro gearbeitete Woche. Homeoffice-Tage zählen NICHT als Nichtrückkehrtage.`,
    explainHealthTitle: 'Krankenversicherung: das Optionsrecht',
    explainHealth:
      `Ein Grenzgänger kann sich von der obligatorischen Schweizer Krankenversicherung befreien lassen, um im deutschen System zu bleiben (Optionsrecht, Rechtsgrundlage Art. 2 Abs. 6 KVV). Die Wahl muss innerhalb von ${HEALTH_OPTION_MONTHS} Monaten nach Arbeitsbeginn ausdrücklich getroffen werden: Eine stillschweigende Ausübung ist ungültig, und die Wahl ist in der Regel unwiderruflich.`,
    crossTitle: 'Nützliche Lektüre',
    calcLink: 'Nettolohn berechnen',
    relatedTitle: 'Weitere Orte im Korridor',
    faqTitle: 'Häufige Fragen',
    faqQ1: (n) => `Welches Steuerregime gilt in ${n}?`,
    faqA1: (n) => `${n} folgt dem Grenzgänger-Regime nach Art. 15a DBA Deutschland-Schweiz: Schweizer Quellensteuer von ${TAX_RATE_STR} auf das Bruttoeinkommen, unabhängig vom Schweizer Beschäftigungskanton.`,
    faqQ2: 'Was passiert, wenn ich nicht jeden Tag nach Hause zurückkehre?',
    faqA2:
      `Mehr als ${NON_RETURN_DAYS} Nichtrückkehr-Arbeitstage pro Jahr führen zum Verlust des Grenzgängerstatus für das ganze Jahr. Homeoffice-Tage zählen nicht zu dieser Schwelle.`,
    faqQ3: 'Kann ich in der deutschen Krankenversicherung bleiben?',
    faqA3: `Ja, über das Optionsrecht (Art. 2 Abs. 6 KVV): Es muss innerhalb von ${HEALTH_OPTION_MONTHS} Monaten nach Arbeitsbeginn in der Schweiz ausdrücklich ausgeübt werden und ist in der Regel unwiderruflich.`,
    faqQ4: 'Brauche ich besondere Formulare für den Grenzgängerstatus?',
    faqA4:
      'Das Verwaltungsverfahren (Formulare, Bescheinigungen) kann variieren und sich ändern: Prüfen Sie die aktuellen Anforderungen immer mit Ihrem Schweizer Beschäftigungskanton, bevor Sie die Arbeit aufnehmen.',
    disclaimer:
      'Schätzungen nur zur Orientierung. Die tatsächliche Besteuerung hängt von Familiensituation, Abzügen und Bescheinigungen ab. Immer mit einer Steuerberatung oder dem Beschäftigungskanton prüfen.',
    hubTitle: 'In Deutschland leben, in der Schweiz arbeiten, Ort für Ort',
    hubLede:
      `Quellensteuer (einheitlich ${TAX_RATE_STR}, § 15a), die ${NON_RETURN_DAYS}-Tage-Nichtrückkehrschwelle und das Optionsrecht bei der Krankenversicherung für die deutschen Orte im Korridor Baden-Württemberg (Lörrach, Waldshut, Konstanz, Schwarzwald-Baar-Kreis).`,
    groupLandkreis: (l) => `Landkreis ${l}`,
    bridgeLede: (n) =>
      `${n} liegt im Grenzkorridor, aber jenseits der Distanz-/Bevölkerungsschwelle, daher ist der eigene Ratgeber noch nicht veröffentlicht. Nutzen Sie den Rechner oder erkunden Sie die grösseren Orte im Korridor.`,
  },
  fr: {
    role: 'Guide frontalier',
    updated: 'Mis à jour',
    home: 'Accueil',
    hubLabel: 'Vivre en Allemagne, travailler en Suisse',
    h1: (n) => `Vivre à ${n} et travailler en Suisse : frontalier allemand (art. 15a)`,
    title: (n) => `Vivre à ${n}, travailler en Suisse`,
    titleMid: (n) => `${n} : guide frontalier Allemagne`,
    titleShort: (n) => `Vivre à ${n}`,
    desc: (n) => `Impôt à la source, jours de non-retour et assurance maladie pour les habitants de ${n} qui travaillent en Suisse. Régime art. 15a.`,
    lede: (n) =>
      `${n} relève du régime frontalier art. 15a CDI Allemagne-Suisse : impôt à la source suisse de ${TAX_RATE_STR} sur le revenu brut (avec attestation de résidence), à condition de ne pas dépasser ${NON_RETURN_DAYS} jours de non-retour par an.`,
    tilePop: 'Population',
    tileDistance: 'Distance à la frontière',
    tilePlz: 'Code postal',
    tileTax: 'Impôt à la source',
    distanceUnit: 'km',
    explainTaxTitle: 'Comment fonctionne la fiscalité',
    explainTax: (n) =>
      `Les habitants de ${n} qui travaillent comme frontaliers en Suisse sont imposés selon l'art. 15a de la convention Allemagne-Suisse : l'employeur suisse retient ${TAX_RATE_STR} du salaire brut à la source, à condition que le travailleur présente une attestation de résidence (Ansässigkeitsbescheinigung). L'Allemagne évite la double imposition par un crédit d'impôt (méthode de l'imputation) pour le montant retenu en Suisse. Le régime s'applique sur tout le territoire, sans restriction de zone frontalière.`,
    explainNonReturnTitle: `Jours de non-retour : le seuil de ${NON_RETURN_DAYS} jours`,
    explainNonReturn:
      `Le statut de frontalier est perdu pour TOUTE l'année fiscale si l'on dépasse ${NON_RETURN_DAYS} jours ouvrés de non-retour. Pour le temps partiel, le seuil est proportionnel : 5 jours par mois travaillé plus 1 jour par semaine travaillée. Les jours de télétravail (homeoffice) ne comptent PAS comme jours de non-retour.`,
    explainHealthTitle: "Assurance maladie : le droit d'option",
    explainHealth:
      `Un frontalier peut choisir de sortir de l'assurance maladie obligatoire suisse pour rester dans le système allemand (droit d'option, base légale art. 2 al. 6 OAMal). Le choix doit être exercé explicitement dans les ${HEALTH_OPTION_MONTHS} mois suivant le début de l'activité : l'exercice tacite n'est pas valable, et le choix est généralement irrévocable une fois fait.`,
    crossTitle: 'À lire aussi',
    calcLink: 'Calculez votre salaire net',
    relatedTitle: 'Autres communes du corridor',
    faqTitle: 'Questions fréquentes',
    faqQ1: (n) => `Quel régime fiscal s'applique à ${n} ?`,
    faqA1: (n) => `${n} suit le régime art. 15a CDI Allemagne-Suisse : impôt à la source suisse de ${TAX_RATE_STR} sur le revenu brut, uniforme quel que soit le canton suisse d'emploi.`,
    faqQ2: 'Que se passe-t-il si je ne rentre pas chez moi chaque jour ?',
    faqA2:
      `Dépasser ${NON_RETURN_DAYS} jours ouvrés de non-retour par an fait perdre le statut de frontalier pour toute l'année. Les jours de télétravail ne comptent pas dans ce seuil.`,
    faqQ3: "Puis-je rester assuré à l'assurance maladie allemande ?",
    faqA3: `Oui, via le droit d'option (art. 2 al. 6 OAMal) : il doit être exercé explicitement dans les ${HEALTH_OPTION_MONTHS} mois suivant le début du travail en Suisse et est généralement irrévocable.`,
    faqQ4: 'Faut-il des formulaires particuliers pour obtenir le statut de frontalier ?',
    faqA4:
      "La procédure administrative (formulaires, attestations) peut varier et changer : vérifiez toujours les exigences actuelles auprès de votre canton suisse d'emploi avant de commencer le travail.",
    disclaimer:
      "Estimations à titre indicatif. L'imposition réelle dépend de la situation familiale, des déductions et des attestations. Vérifiez toujours avec un conseiller fiscal ou le canton d'emploi.",
    hubTitle: 'Vivre en Allemagne, travailler en Suisse, commune par commune',
    hubLede:
      `Impôt à la source (uniforme ${TAX_RATE_STR}, art. 15a), le seuil de ${NON_RETURN_DAYS} jours de non-retour et le droit d'option sur l'assurance maladie pour les communes allemandes du corridor Bade-Wurtemberg (Lörrach, Waldshut, Constance, Schwarzwald-Baar-Kreis).`,
    groupLandkreis: (l) => `Landkreis ${l}`,
    bridgeLede: (n) =>
      `${n} est dans le corridor frontalier mais au-delà du seuil de distance/population : son guide dédié n'est pas encore publié. Utilisez le calculateur ou explorez les principales communes du corridor.`,
  },
};

const CALC_PATH: Record<GermanLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── hreflang / breadcrumb ───────────────────────────────────────

function hreflangFor(slug: string, locales: readonly GermanLocale[] = GERMAN_LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${germanMunicipalityPathFor(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${germanMunicipalityPathFor('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: GermanLocale, name: string, canonicalUrl: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: COPY[locale].home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: COPY[locale].hubLabel, item: `${BASE_URL}${GERMAN_HUB_PATH[locale]}` },
      { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
    ],
  });
}

// ── Page renderers ──────────────────────────────────────────────

function renderRelated(locale: GermanLocale, current: GermanBorderMunicipality): string {
  const others = GERMAN_ABOVE_FLOOR.filter((m) => m.slug !== current.slug).slice(0, 6);
  if (others.length === 0) return '';
  const links = others
    .map(
      (m) =>
        `<a class="rounded-md border border-edge bg-surface-raised p-3 text-sm font-semibold text-heading hover:border-accent-border" href="${germanMunicipalityPathFor(locale, m.slug)}">${esc(m.name)} <span class="font-normal text-muted">· ${esc(getCantonDisplayName(m.canton, locale))}</span></a>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(COPY[locale].relatedTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    </section>`;
}

export function renderAboveFloorPage(params: {
  municipality: GermanBorderMunicipality;
  locale: GermanLocale;
  dateStamp: string;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const canonicalPath = germanMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const tile = (label: string, value: string, sub: string) =>
    `<div class="rounded-md border border-edge bg-surface p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(label)}</dt>
        <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
        <dd class="mt-0.5 text-xs text-subtle">${esc(sub)}</dd>
      </div>`;

  const body = `<div class="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${GERMAN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(c.role)}</span>
        <span class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-subtle">${esc(municipality.landkreis)} · ${esc(getCantonDisplayName(municipality.canton, locale))} · ${esc(municipality.nearestCrossing)}</span>
      </div>
      <h1 class="mt-4 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.h1(n))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.lede(n))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tilePop, intFmt(municipality.population, locale), '')}
      ${tile(c.tileDistance, `${intFmt(municipality.distanceKm, locale)} ${c.distanceUnit}`, municipality.nearestCrossing)}
      ${tile(c.tilePlz, municipality.plz, municipality.landkreis)}
      ${tile(c.tileTax, TAX_RATE_STR, 'Art. 15a')}
    </dl>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainTaxTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainTax(n))}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainNonReturnTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainNonReturn)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainHealthTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainHealth)}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${CALC_PATH[locale]}">${esc(c.calcLink)}</a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${GERMAN_HUB_PATH[locale]}">${esc(c.hubTitle)}</a>
      </div>
    </section>

    ${renderRelated(locale, municipality)}

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">
        <details class="py-3" open><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ1(n))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA1(n))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ2)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA2)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ3)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA3)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ4)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA4)}</p></details>
      </div>
    </section>

    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: c.faqQ1(n), acceptedAnswer: { '@type': 'Answer', text: c.faqA1(n) } },
      { '@type': 'Question', name: c.faqQ2, acceptedAnswer: { '@type': 'Answer', text: c.faqA2 } },
      { '@type': 'Question', name: c.faqQ3, acceptedAnswer: { '@type': 'Answer', text: c.faqA3 } },
      { '@type': 'Question', name: c.faqQ4, acceptedAnswer: { '@type': 'Answer', text: c.faqA4 } },
    ],
  });

  // Budget-aware, keyword-preserving cascade (composePlaceTitle) — three
  // rungs, longest-first (issue #4886): `title` (full sentence) →
  // `titleMid` (name + role) → `titleShort` (the shortest form that still
  // carries this locale's core "living in {name}" keyword). The bare
  // Gemeinde name is NEVER a candidate. German names run notably longer than
  // the French dataset's (longest above-floor: "Bonndorf im Schwarzwald",
  // 23 chars) — this is the regime the #4886 cascade fix matters most for.
  const titleCandidates = [c.title(n), c.titleMid(n), c.titleShort(n)];
  const html = buildSeoPageHtml({
    locale,
    title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
    description: c.desc(n),
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl), faqLd],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html, wordCount };
}

export function renderBridgePage(params: {
  municipality: GermanBorderMunicipality;
  locale: GermanLocale;
  distDir: string;
}): string {
  const { municipality, locale, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const canonicalPath = germanMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const body = `<main class="seo-static-content mx-auto max-w-[760px] px-5 pt-8 pb-14 text-body">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${GERMAN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>
    <h1 class="text-2xl font-bold text-heading mb-3">${esc(c.h1(n))}</h1>
    <p class="text-body mb-5 leading-6">${esc(c.bridgeLede(n))}</p>
    <ul class="space-y-2 list-none p-0 m-0">
      <li><a href="${CALC_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a></li>
      <li><a href="${GERMAN_HUB_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.hubTitle)} →</a></li>
    </ul>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: c.title(n),
    description: c.desc(n),
    canonicalUrl,
    robots: 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl)],
    bodyHtml: body,
    distDir,
    skipMainWrap: true,
  });
}

function renderHubPage(params: { locale: GermanLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const canonicalPath = GERMAN_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const byLandkreis = new Map<GermanLandkreis, GermanBorderMunicipality[]>();
  for (const m of GERMAN_ABOVE_FLOOR) {
    const arr = byLandkreis.get(m.landkreis);
    if (arr) arr.push(m);
    else byLandkreis.set(m.landkreis, [m]);
  }
  const groups = [...byLandkreis.entries()]
    .map(([landkreis, list]) => {
      const cards = list
        .map(
          (m) =>
            `<a class="rounded-md border border-edge bg-surface-raised p-4 hover:border-accent-border" href="${germanMunicipalityPathFor(locale, m.slug)}">
              <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
              <span class="mt-1 block text-xs text-muted">${esc(getCantonDisplayName(m.canton, locale))}</span>
            </a>`,
        )
        .join('');
      return `<div class="mt-5">
          <h2 class="text-lg font-bold text-heading">${esc(c.groupLandkreis(landkreis))}</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
        </div>`;
    })
    .join('');

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <span>${esc(c.hubLabel)}</span>
    </nav>
    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7">
      <h1 class="text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.hubTitle)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>
    ${groups}
    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const hubHreflang = GERMAN_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${GERMAN_HUB_PATH[alt]}">`,
  )
    .concat(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${GERMAN_HUB_PATH.it}">`)
    .join('\n');

  const breadcrumb = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: c.hubLabel, item: canonicalUrl },
    ],
  });

  const html = buildSeoPageHtml({
    locale,
    title: c.hubTitle,
    description: c.hubLede,
    canonicalUrl,
    robots: 'index,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hubHreflang,
    jsonLdScripts: [breadcrumb],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html };
}

// ── Sitemap ─────────────────────────────────────────────────────

function buildSitemap(dateStamp: string): string {
  const entry = (canonicalPath: string, alts: Array<{ hreflang: string; href: string }>, priority: string) => {
    const altLines = alts
      .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`)
      .join('\n');
    return `  <url>\n    <loc>${BASE_URL}${canonicalPath}</loc>\n${altLines}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  };

  const urls: string[] = [];

  urls.push(
    entry(
      GERMAN_HUB_PATH.it,
      GERMAN_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${GERMAN_HUB_PATH[l]}` })).concat({
        hreflang: 'x-default',
        href: `${BASE_URL}${GERMAN_HUB_PATH.it}`,
      }),
      '0.7',
    ),
  );

  for (const m of GERMAN_ABOVE_FLOOR) {
    urls.push(
      entry(
        germanMunicipalityPathFor('it', m.slug),
        GERMAN_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${germanMunicipalityPathFor(l, m.slug)}` })).concat({
          hreflang: 'x-default',
          href: `${BASE_URL}${germanMunicipalityPathFor('it', m.slug)}`,
        }),
        '0.6',
      ),
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

export function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const sitemapPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;
  let idx = fs.readFileSync(sitemapPath, 'utf-8');
  if (!idx.includes(SITEMAP_NAME)) {
    idx = idx.replace(
      '</sitemapindex>',
      `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_NAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
    );
  } else {
    idx = idx.replace(
      new RegExp(`(<loc>${BASE_URL.replace(/\//g, '\\/')}/${SITEMAP_NAME}<\\/loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(<\\/lastmod>)`),
      `$1${dateStamp}$2`,
    );
  }
  fs.writeFileSync(sitemapPath, idx, 'utf-8');
}

// ── Plugin ──────────────────────────────────────────────────────

export function germanBorderMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'german-border-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_GERMAN_BORDER_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[german-border-municipalities]\x1b[0m skipped (SKIP_GERMAN_BORDER_MUNICIPALITY_PAGES=1)');
        resolveGermanBorderMunicipalitiesFlushed([]);
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveGermanBorderMunicipalitiesFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'germanBorderMunicipalityPagesPlugin' });
      const t0 = Date.now();
      let indexablePages = 0;
      let bridgePages = 0;
      let thinPages = 0;

      const hubPaths: string[] = [];
      for (const locale of GERMAN_LOCALES) {
        const { urlPath, html } = renderHubPage({ locale, dateStamp, distDir });
        collector.add(path.join(distDir, urlPath, 'index.html'), html);
        collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
        hubPaths.push(urlPath);
      }

      for (const municipality of GERMAN_ABOVE_FLOOR) {
        for (const locale of GERMAN_LOCALES) {
          const { urlPath, html, wordCount } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir });
          if (wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          indexablePages++;
        }
      }

      for (const municipality of GERMAN_BELOW_FLOOR) {
        for (const locale of GERMAN_LOCALES) {
          const urlPath = germanMunicipalityPathFor(locale, municipality.slug);
          const html = renderBridgePage({ municipality, locale, distDir });
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          bridgePages++;
        }
      }

      const written = await collector.flush();

      fs.writeFileSync(path.join(distDir, SITEMAP_NAME), buildSitemap(dateStamp), 'utf-8');
      patchSitemapIndex(distDir, dateStamp);

      console.log(
        `\x1b[36m[german-border-municipalities]\x1b[0m ${GERMAN_ABOVE_FLOOR.length} above-floor + ${GERMAN_BELOW_FLOOR.length} below-floor → ` +
          `${indexablePages} pages (${thinPages} thin) + ${bridgePages} bridges + ${GERMAN_LOCALES.length} hubs — ` +
          `flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Unblocks germanBorderMunicipalityLinksPlugin, which injects a hub link
      // into the per-locale HTML sitemap page — without it the whole
      // sitemap-comuni-germania.xml shard ships BFS-unreachable from `/`
      // (same orphan-tier hazard as the French family, audit:max-bfs-depth
      // regression #4593).
      resolveGermanBorderMunicipalitiesFlushed(hubPaths);
    },
  };
}
