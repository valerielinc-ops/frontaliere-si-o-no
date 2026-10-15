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
import { CALC_HREF } from './shared/calcHref';
import { renderNearestComparison } from './shared/nearestMunicipalityComparison';
import { formatSourceAttribution } from './shared/authoritativeSources';
import { CALCULATOR_REGIME_SCOPE_NOTICE, CALCULATOR_REGIME_SCOPE_TAG } from './shared/calculatorRegimeScope';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { resolveGermanBorderMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { differentiateH1FromTitle } from './shared/seoContentTokens';
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
// Keep the leaf attribution in the existing lede sentence: the information
// gain observer must not count a second shared source-only segment as page
// content. Expanding the German source's abbreviations preserves the facts
// while keeping the visible attribution a single sentence.
const INLINE_GERMAN_REGIME_SOURCE = GERMAN_REGIME_TAX.source
  .replace(/\bart\./g, 'articolo')
  .replace(/\bcpv\./g, 'comma')
  .replace(/\.$/, '');

function ledeWithGermanRegimeSource(locale: GermanLocale, lede: string): string {
  const attribution = formatSourceAttribution(locale, INLINE_GERMAN_REGIME_SOURCE);
  return lede.endsWith('.') ? `${lede.slice(0, -1)}; ${attribution}.` : `${lede} ${attribution}.`;
}

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
  crossTitle: string;
  calcLink: string;
  /** Column headers and prose labels of the nearest-comune comparison block. */
  colBorderDistance: string;
  colPopulation: string;
  colCrossing: string;
  spreadComparison: string;
  comparisonSource: string;
  profilePopulation: (rank: number, total: number, value: string, ahead: string, behind: string, tied: string) => string;
  profileDistance: (rank: number, total: number, value: string, ahead: string, behind: string, tied: string) => string;
  profileLandkreis: (landkreis: string, peers: string) => string;
  profileCrossing: (crossing: string, peers: string, hasPeers: boolean) => string;
  profileNearbyCrossings: (crossings: string) => string;
  noPeer: string;
  homeofficeNote: string;
  disclaimer: string;
  hubTitle: string;
  hubLede: string;
  hubContextTitle: string;
  hubContext: string;
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
    crossTitle: 'Approfondimenti utili',
    calcLink: 'Calcola il tuo stipendio netto',
    colBorderDistance: 'Distanza dal confine',
    colPopulation: 'Abitanti',
    colCrossing: 'Valico più vicino',
    spreadComparison: 'la distanza dal confine',
    comparisonSource: 'Distanza su strada dal valico più vicino e popolazione dal dataset comunale tedesco (Destatis, chiave AGS).',
    profilePopulation: (rank, total, value, ahead, behind, tied) =>
      `Per popolazione, questo comune è al posto ${rank} su ${total} con ${value} abitanti; subito sopra: ${ahead}; subito sotto: ${behind}${tied ? `; a pari merito: ${tied}` : ''}.`,
    profileDistance: (rank, total, value, ahead, behind, tied) =>
      `Per distanza stradale, questo comune è al posto ${rank} su ${total} con ${value}; subito sopra: ${ahead}; subito sotto: ${behind}${tied ? `; a pari merito: ${tied}` : ''}.`,
    profileLandkreis: (landkreis, peers) =>
      `Nel Landkreis ${landkreis}, i comuni confrontabili oltre a questa pagina sono ${peers}.`,
    profileCrossing: (crossing, peers, hasPeers) =>
      hasPeers ? `La direttrice ${crossing} serve anche ${peers}.` : `La direttrice ${crossing} è il riferimento per questa pagina.`,
    profileNearbyCrossings: (crossings) =>
      `I sei comuni più vicini a questa pagina collegano questi valichi: ${crossings}.`,
    noPeer: 'nessun comune',
    homeofficeNote: 'I giorni di telelavoro non contano come giorni di non rientro.',
    disclaimer:
      'Stime a scopo orientativo. La tassazione effettiva dipende da situazione familiare, deduzioni e certificazioni. Verifica sempre con un consulente fiscale o con il cantone di impiego.',
    hubTitle: 'Vivere in Germania e lavorare in Svizzera, comune per comune',
    hubLede:
      `Imposta alla fonte (${TAX_RATE_STR} uniforme, art. 15a), soglia dei ${NON_RETURN_DAYS} giorni di non rientro e diritto di opzione sull'assicurazione malattia per i comuni tedeschi del corridoio Baden-Württemberg (Lörrach, Waldshut, Costanza, Schwarzwald-Baar-Kreis).`,
    hubContextTitle: 'Le regole comuni del corridoio',
    hubContext:
      `In tutti i comuni del corridoio, il datore di lavoro svizzero trattiene alla fonte il ${TAX_RATE_STR} del reddito lordo secondo l'art. 15a DBA Germania-Svizzera, con certificato di residenza; la Germania evita la doppia imposizione riconoscendo un credito per l'imposta svizzera. Lo status di frontaliere si perde per l'INTERO anno fiscale se si superano ${NON_RETURN_DAYS} giorni lavorativi di non rientro al domicilio. Per chi lavora part-time la soglia è proporzionale: 5 giorni al mese lavorato più 1 giorno alla settimana lavorata. I giorni di telelavoro (homeoffice) NON contano come giorni di non rientro. Il frontaliere può scegliere di uscire dall'assicurazione malattia obbligatoria svizzera per restare nel sistema tedesco (diritto di opzione, base legale art. 2 cpv. 6 OAMal). La scelta va esercitata esplicitamente entro ${HEALTH_OPTION_MONTHS} mesi dall'inizio dell'attività: l'esercizio tacito non è valido.`,
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
    crossTitle: 'Useful reading',
    calcLink: 'Calculate your net salary',
    colBorderDistance: 'Distance to border',
    colPopulation: 'Population',
    colCrossing: 'Nearest crossing',
    spreadComparison: 'the distance to the border',
    comparisonSource: 'Road distance to the nearest crossing and population from the German municipal dataset (Destatis, AGS key).',
    profilePopulation: (rank, total, value, ahead, behind, tied) =>
      `By population, this town ranks ${rank} of ${total} with ${value} residents; immediately above: ${ahead}; immediately below: ${behind}${tied ? `; tied with: ${tied}` : ''}.`,
    profileDistance: (rank, total, value, ahead, behind, tied) =>
      `By road distance, this town ranks ${rank} of ${total} at ${value}; immediately above: ${ahead}; immediately below: ${behind}${tied ? `; tied with: ${tied}` : ''}.`,
    profileLandkreis: (landkreis, peers) =>
      `Within Landkreis ${landkreis}, the comparable towns besides this page are ${peers}.`,
    profileCrossing: (crossing, peers, hasPeers) =>
      hasPeers ? `The ${crossing} route also serves ${peers}.` : `The ${crossing} route is the reference crossing for this page.`,
    profileNearbyCrossings: (crossings) =>
      `The six nearest towns to this page connect to these crossings: ${crossings}.`,
    noPeer: 'no town',
    homeofficeNote: 'Homeoffice days do not count as non-return days.',
    disclaimer:
      'Estimates for guidance only. Actual taxation depends on family situation, deductions and certificates. Always check with a tax adviser or your canton of employment.',
    hubTitle: 'Living in Germany, working in Switzerland, town by town',
    hubLede:
      `Withholding tax (uniform ${TAX_RATE_STR}, §15a), the ${NON_RETURN_DAYS}-day non-return threshold and the health-insurance opt-out right for the German towns in the Baden-Württemberg corridor (Lörrach, Waldshut, Konstanz, Schwarzwald-Baar-Kreis).`,
    hubContextTitle: 'The shared rules across the corridor',
    hubContext:
      `Across the corridor, the Swiss employer withholds ${TAX_RATE_STR} of gross pay at source under §15a of the Germany-Switzerland treaty when a residence certificate is filed; Germany avoids double taxation through a credit for the Swiss tax. Cross-border status is lost for the ENTIRE fiscal year if you exceed ${NON_RETURN_DAYS} non-return working days. For part-time work the threshold is proportional: 5 days per month worked plus 1 day per week worked. Homeoffice days do NOT count as non-return days. A cross-border worker can opt out of compulsory Swiss health insurance to stay in the German system (Optionsrecht, legal basis Art. 2 para. 6 OAMal). The choice must be made explicitly within ${HEALTH_OPTION_MONTHS} months of starting work: tacit exercise is not valid.`,
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
    crossTitle: 'Nützliche Lektüre',
    calcLink: 'Nettolohn berechnen',
    colBorderDistance: 'Entfernung zur Grenze',
    colPopulation: 'Einwohner',
    colCrossing: 'Nächster Übergang',
    spreadComparison: 'die Entfernung zur Grenze',
    comparisonSource: 'Straßenentfernung zum nächsten Übergang und Einwohnerzahl aus dem deutschen Gemeindedatensatz (Destatis, AGS-Schlüssel).',
    profilePopulation: (rank, total, value, ahead, behind, tied) =>
      `Nach Einwohnerzahl liegt diese Gemeinde auf Rang ${rank} von ${total} (${value} Einwohner); direkt davor: ${ahead}; direkt dahinter: ${behind}${tied ? `; gleichauf mit: ${tied}` : ''}.`,
    profileDistance: (rank, total, value, ahead, behind, tied) =>
      `Nach Straßenentfernung liegt diese Gemeinde auf Rang ${rank} von ${total} (${value}); direkt davor: ${ahead}; direkt dahinter: ${behind}${tied ? `; gleichauf mit: ${tied}` : ''}.`,
    profileLandkreis: (landkreis, peers) =>
      `Im Landkreis ${landkreis} sind neben dieser Seite vergleichbare Gemeinden: ${peers}.`,
    profileCrossing: (crossing, peers, hasPeers) =>
      hasPeers ? `Die Strecke ${crossing} verbindet auch ${peers}.` : `Die Strecke ${crossing} ist der Referenzübergang für diese Seite.`,
    profileNearbyCrossings: (crossings) =>
      `Die sechs nächstgelegenen Gemeinden zu dieser Seite führen zu diesen Übergängen: ${crossings}.`,
    noPeer: 'keine Gemeinde',
    homeofficeNote: 'Homeoffice-Tage zählen nicht als Nichtrückkehrtage.',
    disclaimer:
      'Schätzungen nur zur Orientierung. Die tatsächliche Besteuerung hängt von Familiensituation, Abzügen und Bescheinigungen ab. Immer mit einer Steuerberatung oder dem Beschäftigungskanton prüfen.',
    hubTitle: 'In Deutschland leben, in der Schweiz arbeiten, Ort für Ort',
    hubLede:
      `Quellensteuer (einheitlich ${TAX_RATE_STR}, § 15a), die ${NON_RETURN_DAYS}-Tage-Nichtrückkehrschwelle und das Optionsrecht bei der Krankenversicherung für die deutschen Orte im Korridor Baden-Württemberg (Lörrach, Waldshut, Konstanz, Schwarzwald-Baar-Kreis).`,
    hubContextTitle: 'Die gemeinsamen Regeln im Korridor',
    hubContext:
      `Im gesamten Korridor behält der Schweizer Arbeitgeber nach Art. 15a des Abkommens Deutschland-Schweiz ${TAX_RATE_STR} des Bruttolohns an der Quelle ein, wenn eine Ansässigkeitsbescheinigung vorliegt; Deutschland vermeidet die Doppelbesteuerung durch Anrechnung der Schweizer Steuer. Der Grenzgängerstatus geht für das GESAMTE Steuerjahr verloren, wenn mehr als ${NON_RETURN_DAYS} Nichtrückkehr-Arbeitstage anfallen. Bei Teilzeitarbeit gilt die Schwelle anteilig: 5 Tage pro gearbeitetem Monat plus 1 Tag pro gearbeitete Woche. Homeoffice-Tage zählen NICHT als Nichtrückkehrtage. Ein Grenzgänger kann sich von der obligatorischen Schweizer Krankenversicherung befreien lassen, um im deutschen System zu bleiben (Optionsrecht, Rechtsgrundlage Art. 2 Abs. 6 KVV). Die Wahl muss innerhalb von ${HEALTH_OPTION_MONTHS} Monaten nach Arbeitsbeginn ausdrücklich getroffen werden: Eine stillschweigende Ausübung ist ungültig.`,
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
    crossTitle: 'À lire aussi',
    calcLink: 'Calculez votre salaire net',
    colBorderDistance: 'Distance de la frontière',
    colPopulation: 'Habitants',
    colCrossing: 'Passage le plus proche',
    spreadComparison: 'la distance de la frontière',
    comparisonSource: 'Distance routière du passage le plus proche et population issues du jeu de données communal allemand (Destatis, clé AGS).',
    profilePopulation: (rank, total, value, ahead, behind, tied) =>
      `Par population, cette commune est ${rank}e sur ${total} avec ${value} habitants ; juste devant : ${ahead} ; juste derrière : ${behind}${tied ? ` ; à égalité avec : ${tied}` : ''}.`,
    profileDistance: (rank, total, value, ahead, behind, tied) =>
      `Par distance routière, cette commune est ${rank}e sur ${total} avec ${value} ; juste devant : ${ahead} ; juste derrière : ${behind}${tied ? ` ; à égalité avec : ${tied}` : ''}.`,
    profileLandkreis: (landkreis, peers) =>
      `Dans le Landkreis ${landkreis}, les communes comparables en plus de cette page sont ${peers}.`,
    profileCrossing: (crossing, peers, hasPeers) =>
      hasPeers ? `L'axe ${crossing} dessert aussi ${peers}.` : `L'axe ${crossing} est le passage de référence pour cette page.`,
    profileNearbyCrossings: (crossings) =>
      `Les six communes les plus proches de cette page relient ces passages : ${crossings}.`,
    noPeer: 'aucune commune',
    homeofficeNote: 'Les jours de télétravail ne comptent pas comme jours de non-retour.',
    disclaimer:
      "Estimations à titre indicatif. L'imposition réelle dépend de la situation familiale, des déductions et des attestations. Vérifiez toujours avec un conseiller fiscal ou le canton d'emploi.",
    hubTitle: 'Vivre en Allemagne, travailler en Suisse, commune par commune',
    hubLede:
      `Impôt à la source (uniforme ${TAX_RATE_STR}, art. 15a), le seuil de ${NON_RETURN_DAYS} jours de non-retour et le droit d'option sur l'assurance maladie pour les communes allemandes du corridor Bade-Wurtemberg (Lörrach, Waldshut, Constance, Schwarzwald-Baar-Kreis).`,
    hubContextTitle: 'Les règles communes du corridor',
    hubContext:
      `Dans tout le corridor, l'employeur suisse retient ${TAX_RATE_STR} du salaire brut à la source selon l'art. 15a de la convention Allemagne-Suisse avec une attestation de résidence ; l'Allemagne évite la double imposition par un crédit pour l'impôt suisse. Le statut de frontalier est perdu pour TOUTE l'année fiscale si l'on dépasse ${NON_RETURN_DAYS} jours ouvrés de non-retour. Pour le temps partiel, le seuil est proportionnel : 5 jours par mois travaillé plus 1 jour par semaine travaillée. Les jours de télétravail (homeoffice) ne comptent PAS comme jours de non-retour. Un frontalier peut choisir de sortir de l'assurance maladie obligatoire suisse pour rester dans le système allemand (droit d'option, base légale art. 2 al. 6 OAMal). Le choix doit être exercé explicitement dans les ${HEALTH_OPTION_MONTHS} mois suivant le début de l'activité : l'exercice tacite n'est pas valable.`,
    groupLandkreis: (l) => `Landkreis ${l}`,
    bridgeLede: (n) =>
      `${n} est dans le corridor frontalier mais au-delà du seuil de distance/population : son guide dédié n'est pas encore publié. Utilisez le calculateur ou explorez les principales communes du corridor.`,
  },
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

const GERMAN_POPULATION_RANK = [...GERMAN_ABOVE_FLOOR].sort(
  (a, b) => b.population - a.population || a.slug.localeCompare(b.slug),
);
const GERMAN_DISTANCE_RANK = [...GERMAN_ABOVE_FLOOR].sort(
  (a, b) => a.distanceKm - b.distanceKm || a.slug.localeCompare(b.slug),
);

function groupGermanMunicipalities<T extends 'landkreis' | 'nearestCrossing'>(
  field: T,
): Map<GermanBorderMunicipality[T], GermanBorderMunicipality[]> {
  const groups = new Map<GermanBorderMunicipality[T], GermanBorderMunicipality[]>();
  for (const municipality of GERMAN_ABOVE_FLOOR) {
    const key = municipality[field];
    const group = groups.get(key);
    if (group) group.push(municipality);
    else groups.set(key, [municipality]);
  }
  return groups;
}

const GERMAN_BY_LANDKREIS = groupGermanMunicipalities('landkreis');
const GERMAN_BY_CROSSING = groupGermanMunicipalities('nearestCrossing');

function joinGermanNames(names: readonly string[], locale: GermanLocale, fallback: string): string {
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0];
  const conjunction = locale === 'it' ? ' e ' : locale === 'de' ? ' und ' : locale === 'fr' ? ' et ' : ' and ';
  return `${names.slice(0, -1).join(', ')}${conjunction}${names[names.length - 1]}`;
}

interface GermanRankDetails {
  rank: number;
  total: number;
  value: string;
  ahead: string[];
  behind: string[];
  tied: string[];
}

function germanRankDetails(
  rows: readonly GermanBorderMunicipality[],
  current: GermanBorderMunicipality,
  valueOf: (municipality: GermanBorderMunicipality) => number,
  higherIsBetter: boolean,
  formatValue: (value: number) => string,
): GermanRankDetails {
  const currentValue = valueOf(current);
  const isAhead = (value: number): boolean => (higherIsBetter ? value > currentValue : value < currentValue);
  const isBehind = (value: number): boolean => (higherIsBetter ? value < currentValue : value > currentValue);
  return {
    rank: rows.filter((municipality) => isAhead(valueOf(municipality))).length + 1,
    total: rows.length,
    value: formatValue(currentValue),
    ahead: rows
      .filter((municipality) => isAhead(valueOf(municipality)))
      .slice(-2)
      .map((municipality) => municipality.name),
    behind: rows
      .filter((municipality) => isBehind(valueOf(municipality)))
      .slice(0, 2)
      .map((municipality) => municipality.name),
    tied: rows
      .filter((municipality) => municipality.slug !== current.slug && valueOf(municipality) === currentValue)
      .map((municipality) => municipality.name),
  };
}

function buildGermanProfileProse(
  locale: GermanLocale,
  current: GermanBorderMunicipality,
  neighbours: Array<{ place: GermanBorderMunicipality }>,
): string[] {
  const c = COPY[locale];
  const formatNames = (names: readonly string[]) => joinGermanNames(names, locale, c.noPeer);
  const population = germanRankDetails(
    GERMAN_POPULATION_RANK,
    current,
    (municipality) => municipality.population,
    true,
    (value) => intFmt(value, locale),
  );
  const distance = germanRankDetails(
    GERMAN_DISTANCE_RANK,
    current,
    (municipality) => municipality.distanceKm,
    false,
    (value) => `${intFmt(value, locale)} km`,
  );
  const landkreisPeers = (GERMAN_BY_LANDKREIS.get(current.landkreis) ?? [])
    .filter((municipality) => municipality.slug !== current.slug)
    .map((municipality) => municipality.name);
  const crossingPeers = (GERMAN_BY_CROSSING.get(current.nearestCrossing) ?? [])
    .filter((municipality) => municipality.slug !== current.slug)
    .map((municipality) => municipality.name);
  const nearbyCrossings = [...new Set(neighbours.map(({ place }) => place.nearestCrossing))];

  return [
    c.profilePopulation(
      population.rank,
      population.total,
      population.value,
      formatNames(population.ahead),
      formatNames(population.behind),
      formatNames(population.tied),
    ),
    c.profileDistance(
      distance.rank,
      distance.total,
      distance.value,
      formatNames(distance.ahead),
      formatNames(distance.behind),
      formatNames(distance.tied),
    ),
    c.profileLandkreis(current.landkreis, formatNames(landkreisPeers)),
    c.profileCrossing(current.nearestCrossing, formatNames(crossingPeers), crossingPeers.length > 0),
    c.profileNearbyCrossings(formatNames(nearbyCrossings)),
  ];
}

// ── Page renderers ──────────────────────────────────────────────

/**
 * The comparison block that used to be a fixed link grid.
 *
 * Before (issue #5002): `GERMAN_ABOVE_FLOOR.filter(self).slice(0, 6)` — the SAME
 * six comuni on every page of the family, so the block carried no per-page
 * information and every inbound link inside the family pointed at those six
 * pages (the concentration PR #5107 fixed for articles). Measured 2026-08-24,
 * the municipality families scored a median Information Gain of 0-15 percent.
 *
 * After: the six geographically nearest comuni with the figures that differ
 * between them, plus prose stating where THIS comune sits in the group.
 * Page-specific by construction — a comune's neighbour set is unique to it.
 *
 * Renderer, determinism argument and shared copy: `nearestMunicipalityComparison`.
 */
function renderRelated(locale: GermanLocale, current: GermanBorderMunicipality): string {
  const c = COPY[locale];
  return renderNearestComparison<GermanBorderMunicipality>({
    locale,
    current,
    pool: GERMAN_ABOVE_FLOOR,
    hrefFor: (m) => germanMunicipalityPathFor(locale, m.slug),
    keyOf: (m) => m.slug,
    columns: [
      {
        header: c.colBorderDistance,
        value: (m) => `${intFmt(m.distanceKm, locale)} km`,
        numeric: (m) => m.distanceKm,
        formatNumeric: (value) => `${intFmt(value, locale)} km`,
        spreadLabel: c.spreadComparison,
      },
      {
        header: c.colPopulation,
        value: (m) => intFmt(m.population, locale),
      },
      {
        header: c.colCrossing,
        value: (m) => m.nearestCrossing,
      },
    ],
    sourceNote: c.comparisonSource,
    extraProse: ({ current, neighbours }) => buildGermanProfileProse(locale, current, neighbours),
  });
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
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(ledeWithGermanRegimeSource(locale, c.lede(n)))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tilePop, intFmt(municipality.population, locale), '')}
      ${tile(c.tileDistance, `${intFmt(municipality.distanceKm, locale)} ${c.distanceUnit}`, municipality.nearestCrossing)}
      ${tile(c.tilePlz, municipality.plz, municipality.landkreis)}
      ${tile(c.tileTax, TAX_RATE_STR, 'Art. 15a')}
    </dl>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${CALC_HREF[locale]}">${esc(c.calcLink)} <span class="font-normal text-muted">(${esc(CALCULATOR_REGIME_SCOPE_TAG[locale])})</span></a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${GERMAN_HUB_PATH[locale]}">${esc(c.hubTitle)}</a>
      </div>
      <p class="mt-3 text-xs leading-5 text-muted">${esc(CALCULATOR_REGIME_SCOPE_NOTICE[locale])}</p>
      <p class="mt-2 text-xs leading-5 text-muted">${esc(c.homeofficeNote)}</p>
    </section>

    ${renderRelated(locale, municipality)}

    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS, contentHtml: body })}`;

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
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl)],
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
      <li><a href="${CALC_HREF[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a> <span class="text-xs text-muted">(${esc(CALCULATOR_REGIME_SCOPE_TAG[locale])})</span></li>
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

// Exported for the h1-vs-title regression suite — see the FR plugin's twin.
export function renderHubPage(params: { locale: GermanLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const canonicalPath = GERMAN_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  // Same defect and same repair as the FR hub — see
  // frenchBorderMunicipalityPagesPlugin.ts's renderHubPage for the full
  // rationale. `c.hubTitle` is shipped as BOTH <title> and <h1>, and at
  // 54-61 chars per locale buildTitleWithBrand always drops the brand
  // suffix, so the two collapse into the Semrush "Duplicate H1 and title
  // tags" class that audit:h1-title-duplicates gates on.
  //
  // Second argument = the string handed to buildSeoPageHtml as `title`.
  // The helper returns its FIRST argument.
  const hubH1 = differentiateH1FromTitle(c.hubTitle, c.hubTitle, locale);

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
      <h1 class="text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(hubH1)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>
    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.hubContextTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.hubContext)}</p>
      <p class="mt-3 text-xs leading-5 text-muted">${esc(formatSourceAttribution(locale, GERMAN_REGIME_TAX.source))}</p>
    </section>
    ${groups}
    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS, contentHtml: body })}`;

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
    return `  <url>\n    <loc>${BASE_URL}${canonicalPath}</loc>\n${altLines}\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
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
