/**
 * Per-municipality FRANCE border pages (issue #4545, first of the FR/DE/AT/LI
 * rollout — Genève/Vaud/Neuchâtel/Jura/Valais corridor).
 *
 * Emits, for every French commune in the corridor that is ABOVE the
 * population/distance floor (data/french-border-municipalities.json), a page:
 *
 *   /vivere-in-francia-lavorare-in-svizzera/{slug}/   (it, + 3 locale prefixes)
 *   "Vivere a {commune} e lavorare in Svizzera: regime {Ginevra|otto cantoni}"
 *
 * with the sourced fixed-regime annual tax figure (REGIME_TAX in
 * frenchBorderMunicipalityData.ts — ONE regime per canton, no old/new toggle:
 * unlike the Italian fiscal family, the FR/CH accords give each commune a
 * single fixed mechanism depending on which canton it borders), plus rent and
 * distance-to-crossing data.
 *
 * Communes BELOW the floor get a noindex,follow bridge at the SAME URL (never
 * a silent 404 — AGENTS.md § Static SEO Pages), paired with the self-map in
 * build-plugins/searchConsoleCompat.ts.
 *
 * Architectural note: follows the FISCAL-page pattern deliberately (see
 * frenchBorderMunicipalityData.ts header) — self-contained module, no
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
import { resolveFrenchBorderMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { getCantonDisplayName } from './shared/cantonDisplay';
import {
  FRENCH_LOCALES,
  FRENCH_ABOVE_FLOOR,
  FRENCH_BELOW_FLOOR,
  FRENCH_HUB_PATH,
  REGIME_TAX,
  frenchMunicipalityPathFor,
  type FrenchLocale,
  type FrenchBorderMunicipality,
  type FrenchRegime,
} from './frenchBorderMunicipalityData';

const OG_LOCALE: Record<FrenchLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SITEMAP_NAME = 'sitemap-comuni-francia.xml';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intlLang(locale: FrenchLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}
function money(amount: number, currency: 'CHF' | 'EUR', locale: FrenchLocale): string {
  return new Intl.NumberFormat(intlLang(locale), {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}
function eur(amount: number, locale: FrenchLocale): string {
  return money(amount, 'EUR', locale);
}
function intFmt(n: number, locale: FrenchLocale): string {
  return new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 0 }).format(n);
}

function taxAmountStr(regime: FrenchRegime, locale: FrenchLocale): string {
  const t = REGIME_TAX[regime];
  return money(t.amount, t.currency, locale);
}

// ── Localized copy ──────────────────────────────────────────────

const REGIME_LABEL: Record<FrenchRegime, Record<FrenchLocale, string>> = {
  geneve: {
    it: 'Ginevra (imposta alla fonte)',
    en: 'Geneva (source tax)',
    de: 'Genf (Quellensteuer)',
    fr: 'Genève (impôt à la source)',
  },
  'huit-cantons': {
    it: 'otto cantoni (dichiarazione in Francia)',
    en: 'eight cantons (declared in France)',
    de: 'acht Kantone (Erklärung in Frankreich)',
    fr: 'huit cantons (déclaration en France)',
  },
};

interface Copy {
  role: string;
  updated: string;
  home: string;
  hubLabel: string;
  h1: (name: string, regime: string) => string;
  title: (name: string) => string;
  /**
   * Second cascade rung for <title> (composePlaceTitle) — shorter than
   * `title` but still keyword-bearing (issue #4886: a bare-name last
   * candidate is CTR-dead, no query-intent signal).
   */
  titleMid: (name: string) => string;
  /**
   * Shortest cascade rung for <title> — never the bare commune name.
   * Reuses this locale's core "living in X" phrase so even the minimal
   * form still carries the page's local-SEO keyword.
   */
  titleShort: (name: string) => string;
  desc: (name: string, regime: string) => string;
  lede: (name: string, regime: string, tax: string) => string;
  tilePop: string;
  tileDistance: string;
  tileRent: string;
  tileTax: string;
  perMonth: string;
  perYear: string;
  distanceUnit: string;
  explainTitle: string;
  explainGeneve: (name: string) => string;
  explainHuitCantons: (name: string, tax: string) => string;
  crossTitle: string;
  calcLink: string;
  relatedTitle: string;
  faqTitle: string;
  faqQ1: (name: string) => string;
  faqA1: (name: string, regime: string) => string;
  faqQ2: string;
  faqA2: string;
  faqQ3: (name: string) => string;
  faqA3: (name: string, rent: string) => string;
  disclaimer: string;
  hubTitle: string;
  hubLede: string;
  groupGeneve: string;
  groupHuitCantons: string;
  bridgeLede: (name: string) => string;
}

const COPY: Record<FrenchLocale, Copy> = {
  it: {
    role: 'Guida frontalieri',
    updated: 'Aggiornato',
    home: 'Home',
    hubLabel: 'Vivere in Francia e lavorare in Svizzera',
    h1: (n, r) => `Vivere a ${n} e lavorare in Svizzera: regime ${r}`,
    title: (n) => `Vivere a ${n} e lavorare in Svizzera`,
    titleMid: (n) => `${n}: Guida frontalieri`,
    titleShort: (n) => `Vivere a ${n}`,
    desc: (n, r) => `Affitti, distanza dal valico e tassazione per chi vive a ${n} e lavora in Svizzera. Regime ${r}.`,
    lede: (n, r, t) =>
      `${n} rientra nel regime ${r}: per un profilo tipo frontaliere significa circa ${t} di imposta annua sul reddito svizzero.`,
    tilePop: 'Popolazione',
    tileDistance: 'Distanza dal valico',
    tileRent: 'Affitto medio',
    tileTax: 'Imposta annua stimata',
    perMonth: '/mese',
    perYear: '/anno',
    distanceUnit: 'km',
    explainTitle: 'Come funziona la tassazione',
    explainGeneve: (n) =>
      `${n} è nel canton Ginevra, coperto dall'accordo frontalieri del 1973: il datore di lavoro svizzero trattiene l'imposta alla fonte secondo il barème A0. Ginevra retrocede il 3.5% della massa salariale dei frontalieri alla Francia, che concede credito d'imposta pieno — nessuna doppia imposizione.`,
    explainHuitCantons: (n, t) =>
      `${n} è nel gruppo degli otto cantoni (Vaud, Neuchâtel, Giura o Vallese — accordo del 1983): qui è la Francia a tassare per intero il reddito svizzero in dichiarazione, con un abattement forfaitario del 10% e il barème progressivo francese. La Svizzera riceve in cambio una compensazione del 4.5% dalla Francia. Per il profilo di riferimento l'imposta annua è circa ${t}.`,
    crossTitle: 'Approfondimenti utili',
    calcLink: 'Calcola il tuo stipendio netto',
    relatedTitle: 'Altri comuni del corridoio',
    faqTitle: 'Domande frequenti',
    faqQ1: (n) => `Che regime fiscale si applica a ${n}?`,
    faqA1: (n, r) => `${n} segue il regime ${r}, determinato dal cantone svizzero di confine più vicino, non da una scelta personale.`,
    faqQ2: 'Ginevra e gli otto cantoni tassano allo stesso modo?',
    faqA2:
      'No. A Ginevra il datore di lavoro trattiene l\'imposta alla fonte svizzera (barème A0) e la Francia riconosce credito pieno. Nel gruppo Vaud/Neuchâtel/Giura/Vallese è la Francia a tassare per intero in dichiarazione, con un abattement forfaitario del 10%, mentre la Svizzera riceve una compensazione finanziaria diretta dalla Francia.',
    faqQ3: (n) => `Quanto costa affittare a ${n}?`,
    faqA3: (n, rent) =>
      `L'affitto medio mensile stimato a ${n} è di circa ${rent} (dato DGALN/DHUP "Carte des loyers" su un riferimento di 50 m²).`,
    disclaimer:
      'Stime a scopo orientativo. La tassazione effettiva dipende da situazione familiare, deduzioni e dichiarazione. Verifica sempre con un consulente fiscale.',
    hubTitle: 'Vivere in Francia e lavorare in Svizzera, comune per comune',
    hubLede:
      'Affitti, distanza dal valico e regime fiscale (Ginevra vs otto cantoni) per i comuni francesi del corridoio Ginevra-Vaud-Neuchâtel-Giura-Vallese.',
    groupGeneve: 'Regime Ginevra',
    groupHuitCantons: 'Regime otto cantoni',
    bridgeLede: (n) =>
      `${n} è nel corridoio di confine ma è oltre la soglia di distanza/popolazione: la guida dedicata non è ancora pubblicata. Usa il calcolatore o esplora i comuni principali del corridoio.`,
  },
  en: {
    role: 'Cross-border guide',
    updated: 'Updated',
    home: 'Home',
    hubLabel: 'Living in France, working in Switzerland',
    h1: (n, r) => `Living in ${n} and working in Switzerland: ${r} regime`,
    title: (n) => `Living in ${n}, working in Switzerland`,
    titleMid: (n) => `${n}: Cross-border guide`,
    titleShort: (n) => `Living in ${n}`,
    desc: (n, r) => `Rent, distance to the border crossing and taxation for residents of ${n} working in Switzerland. ${r} regime.`,
    lede: (n, r, t) =>
      `${n} falls under the ${r} regime: for a typical cross-border profile that means about ${t} of annual tax on Swiss income.`,
    tilePop: 'Population',
    tileDistance: 'Distance to crossing',
    tileRent: 'Average rent',
    tileTax: 'Estimated annual tax',
    perMonth: '/month',
    perYear: '/year',
    distanceUnit: 'km',
    explainTitle: 'How the taxation works',
    explainGeneve: (n) =>
      `${n} is in canton Geneva, covered by the 1973 cross-border agreement: the Swiss employer withholds tax at source under barème A0. Geneva retrocedes 3.5% of the cross-border payroll mass to France, which grants a full tax credit — no double taxation.`,
    explainHuitCantons: (n, t) =>
      `${n} is in the eight-canton group (Vaud, Neuchâtel, Jura or Valais — 1983 agreement): here France taxes the full Swiss income via the annual return, with a flat-rate 10% allowance and the French progressive scale. Switzerland receives a 4.5% compensation from France in return. For the reference profile the annual tax is about ${t}.`,
    crossTitle: 'Useful reading',
    calcLink: 'Calculate your net salary',
    relatedTitle: 'Other towns in the corridor',
    faqTitle: 'FAQ',
    faqQ1: (n) => `Which tax regime applies in ${n}?`,
    faqA1: (n, r) => `${n} follows the ${r} regime, determined by the nearest Swiss border canton, not by personal choice.`,
    faqQ2: 'Do Geneva and the eight cantons tax the same way?',
    faqA2:
      'No. In Geneva the employer withholds Swiss tax at source (barème A0) and France grants a full credit. In the Vaud/Neuchâtel/Jura/Valais group, France taxes the full income via the annual return with a flat 10% allowance, while Switzerland receives a direct financial compensation from France.',
    faqQ3: (n) => `How much does renting cost in ${n}?`,
    faqA3: (n, rent) =>
      `The estimated average monthly rent in ${n} is about ${rent} (DGALN/DHUP "Carte des loyers" data, 50 m² reference).`,
    disclaimer:
      'Estimates for guidance only. Actual taxation depends on family situation, deductions and the tax return. Always check with a tax adviser.',
    hubTitle: 'Living in France, working in Switzerland, town by town',
    hubLede:
      'Rent, distance to the border crossing and tax regime (Geneva vs eight cantons) for the French towns in the Geneva-Vaud-Neuchâtel-Jura-Valais corridor.',
    groupGeneve: 'Geneva regime',
    groupHuitCantons: 'Eight-canton regime',
    bridgeLede: (n) =>
      `${n} is in the border corridor but beyond the distance/population floor, so its dedicated guide is not published yet. Use the calculator or explore the main towns in the corridor.`,
  },
  de: {
    role: 'Grenzgänger-Ratgeber',
    updated: 'Aktualisiert',
    home: 'Startseite',
    hubLabel: 'In Frankreich leben, in der Schweiz arbeiten',
    h1: (n, r) => `Leben in ${n} und Arbeiten in der Schweiz: Regime ${r}`,
    title: (n) => `Leben in ${n}, Arbeiten in der Schweiz`,
    titleMid: (n) => `${n}: Grenzgänger-Ratgeber`,
    titleShort: (n) => `Leben in ${n}`,
    desc: (n, r) => `Miete, Distanz zum Grenzübergang und Besteuerung für Einwohner von ${n}, die in der Schweiz arbeiten. Regime ${r}.`,
    lede: (n, r, t) =>
      `${n} fällt unter das Regime ${r}: für ein typisches Grenzgänger-Profil bedeutet das rund ${t} Jahressteuer auf das Schweizer Einkommen.`,
    tilePop: 'Einwohner',
    tileDistance: 'Distanz zum Grenzübergang',
    tileRent: 'Durchschnittsmiete',
    tileTax: 'Geschätzte Jahressteuer',
    perMonth: '/Monat',
    perYear: '/Jahr',
    distanceUnit: 'km',
    explainTitle: 'So funktioniert die Besteuerung',
    explainGeneve: (n) =>
      `${n} liegt im Kanton Genf, abgedeckt vom Grenzgänger-Abkommen von 1973: Der Schweizer Arbeitgeber behält die Quellensteuer nach Tarif A0 ein. Genf überweist 3.5% der Grenzgänger-Lohnsumme an Frankreich, das im Gegenzug volle Anrechnung gewährt — keine Doppelbesteuerung.`,
    explainHuitCantons: (n, t) =>
      `${n} gehört zur Acht-Kantone-Gruppe (Waadt, Neuenburg, Jura oder Wallis — Abkommen von 1983): Hier besteuert Frankreich das gesamte Schweizer Einkommen über die Steuererklärung, mit einem Pauschalabzug von 10% und dem französischen Progressionstarif. Die Schweiz erhält im Gegenzug eine Ausgleichszahlung von 4.5% von Frankreich. Für das Referenzprofil beträgt die Jahressteuer rund ${t}.`,
    crossTitle: 'Nützliche Lektüre',
    calcLink: 'Nettolohn berechnen',
    relatedTitle: 'Weitere Orte im Korridor',
    faqTitle: 'Häufige Fragen',
    faqQ1: (n) => `Welches Steuerregime gilt in ${n}?`,
    faqA1: (n, r) => `${n} folgt dem Regime ${r}, bestimmt vom nächstgelegenen Schweizer Grenzkanton, nicht durch persönliche Wahl.`,
    faqQ2: 'Besteuern Genf und die acht Kantone gleich?',
    faqA2:
      'Nein. In Genf behält der Arbeitgeber die Schweizer Quellensteuer ein (Tarif A0), Frankreich gewährt volle Anrechnung. In der Gruppe Waadt/Neuenburg/Jura/Wallis besteuert Frankreich das gesamte Einkommen über die Steuererklärung mit einem Pauschalabzug von 10%, während die Schweiz eine direkte Ausgleichszahlung von Frankreich erhält.',
    faqQ3: (n) => `Wie teuer ist Wohnen in ${n}?`,
    faqA3: (n, rent) =>
      `Die geschätzte Durchschnittsmiete in ${n} beträgt rund ${rent} (DGALN/DHUP "Carte des loyers"-Daten, Referenz 50 m²).`,
    disclaimer:
      'Schätzungen nur zur Orientierung. Die tatsächliche Besteuerung hängt von Familiensituation, Abzügen und der Steuererklärung ab. Immer mit einer Steuerberatung prüfen.',
    hubTitle: 'In Frankreich leben, in der Schweiz arbeiten, Ort für Ort',
    hubLede:
      'Miete, Distanz zum Grenzübergang und Steuerregime (Genf vs. acht Kantone) für die französischen Orte im Korridor Genf-Waadt-Neuenburg-Jura-Wallis.',
    groupGeneve: 'Regime Genf',
    groupHuitCantons: 'Regime acht Kantone',
    bridgeLede: (n) =>
      `${n} liegt im Grenzkorridor, aber jenseits der Distanz-/Bevölkerungsschwelle, daher ist der eigene Ratgeber noch nicht veröffentlicht. Nutzen Sie den Rechner oder erkunden Sie die grösseren Orte im Korridor.`,
  },
  fr: {
    role: 'Guide frontalier',
    updated: 'Mis à jour',
    home: 'Accueil',
    hubLabel: 'Vivre en France, travailler en Suisse',
    h1: (n, r) => `Vivre à ${n} et travailler en Suisse : régime ${r}`,
    title: (n) => `Vivre à ${n}, travailler en Suisse`,
    titleMid: (n) => `${n} : Guide frontalier`,
    titleShort: (n) => `Vivre à ${n}`,
    desc: (n, r) => `Loyers, distance à la frontière et fiscalité pour les habitants de ${n} qui travaillent en Suisse. Régime ${r}.`,
    lede: (n, r, t) =>
      `${n} relève du régime ${r} : pour un profil frontalier type, cela représente environ ${t} d'impôt annuel sur le revenu suisse.`,
    tilePop: 'Population',
    tileDistance: 'Distance à la frontière',
    tileRent: 'Loyer moyen',
    tileTax: 'Impôt annuel estimé',
    perMonth: '/mois',
    perYear: '/an',
    distanceUnit: 'km',
    explainTitle: 'Comment fonctionne la fiscalité',
    explainGeneve: (n) =>
      `${n} est dans le canton de Genève, couvert par l'accord frontalier de 1973 : l'employeur suisse retient l'impôt à la source selon le barème A0. Genève rétrocède 3.5% de la masse salariale frontalière à la France, qui accorde un crédit d'impôt intégral — pas de double imposition.`,
    explainHuitCantons: (n, t) =>
      `${n} est dans le groupe des huit cantons (Vaud, Neuchâtel, Jura ou Valais — accord de 1983) : ici la France impose l'intégralité du revenu suisse via la déclaration, avec un abattement forfaitaire de 10% et le barème progressif français. La Suisse reçoit en retour une compensation de 4.5% de la France. Pour le profil de référence, l'impôt annuel est d'environ ${t}.`,
    crossTitle: 'À lire aussi',
    calcLink: 'Calculez votre salaire net',
    relatedTitle: 'Autres communes du corridor',
    faqTitle: 'Questions fréquentes',
    faqQ1: (n) => `Quel régime fiscal s'applique à ${n} ?`,
    faqA1: (n, r) => `${n} suit le régime ${r}, déterminé par le canton suisse frontalier le plus proche, pas par un choix personnel.`,
    faqQ2: 'Genève et les huit cantons imposent-ils de la même façon ?',
    faqA2:
      'Non. À Genève, l\'employeur retient l\'impôt suisse à la source (barème A0) et la France accorde un crédit intégral. Dans le groupe Vaud/Neuchâtel/Jura/Valais, la France impose l\'intégralité du revenu via la déclaration avec un abattement forfaitaire de 10%, tandis que la Suisse reçoit une compensation financière directe de la France.',
    faqQ3: (n) => `Combien coûte la location à ${n} ?`,
    faqA3: (n, rent) =>
      `Le loyer mensuel moyen estimé à ${n} est d'environ ${rent} (données DGALN/DHUP « Carte des loyers », référence 50 m²).`,
    disclaimer:
      'Estimations à titre indicatif. L\'imposition réelle dépend de la situation familiale, des déductions et de la déclaration. Vérifiez toujours avec un conseiller fiscal.',
    hubTitle: 'Vivre en France, travailler en Suisse, commune par commune',
    hubLede:
      'Loyers, distance à la frontière et régime fiscal (Genève vs huit cantons) pour les communes françaises du corridor Genève-Vaud-Neuchâtel-Jura-Valais.',
    groupGeneve: 'Régime Genève',
    groupHuitCantons: 'Régime huit cantons',
    bridgeLede: (n) =>
      `${n} est dans le corridor frontalier mais au-delà du seuil de distance/population : son guide dédié n'est pas encore publié. Utilisez le calculateur ou explorez les principales communes du corridor.`,
  },
};

const CALC_PATH: Record<FrenchLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── hreflang / breadcrumb ───────────────────────────────────────

function hreflangFor(slug: string, locales: readonly FrenchLocale[] = FRENCH_LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${frenchMunicipalityPathFor(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${frenchMunicipalityPathFor('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: FrenchLocale, name: string, canonicalUrl: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: COPY[locale].home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: COPY[locale].hubLabel, item: `${BASE_URL}${FRENCH_HUB_PATH[locale]}` },
      { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
    ],
  });
}

// ── Page renderers ──────────────────────────────────────────────

function renderRelated(locale: FrenchLocale, current: FrenchBorderMunicipality): string {
  const others = FRENCH_ABOVE_FLOOR.filter((m) => m.slug !== current.slug).slice(0, 6);
  if (others.length === 0) return '';
  const links = others
    .map(
      (m) =>
        `<a class="rounded-md border border-edge bg-surface-raised p-3 text-sm font-semibold text-heading hover:border-accent-border" href="${frenchMunicipalityPathFor(locale, m.slug)}">${esc(m.name)} <span class="font-normal text-muted">· ${esc(getCantonDisplayName(m.canton, locale))}</span></a>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(COPY[locale].relatedTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    </section>`;
}

export function renderAboveFloorPage(params: {
  municipality: FrenchBorderMunicipality;
  locale: FrenchLocale;
  dateStamp: string;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const regimeLabel = REGIME_LABEL[municipality.regime][locale];
  const taxStr = taxAmountStr(municipality.regime, locale);
  const rentStr = eur(municipality.avgRentMonthly, locale);
  const canonicalPath = frenchMunicipalityPathFor(locale, municipality.slug);
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
      <a class="text-link hover:text-link-hover" href="${FRENCH_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(c.role)}</span>
        <span class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-subtle">${esc(getCantonDisplayName(municipality.canton, locale))} · ${esc(municipality.nearestCrossing)}</span>
      </div>
      <h1 class="mt-4 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.h1(n, regimeLabel))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.lede(n, regimeLabel, taxStr))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tilePop, intFmt(municipality.population, locale), '')}
      ${tile(c.tileDistance, `${intFmt(municipality.distanceKm, locale)} ${c.distanceUnit}`, municipality.nearestCrossing)}
      ${tile(c.tileRent, rentStr, c.perMonth)}
      ${tile(c.tileTax, taxStr, c.perYear)}
    </dl>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(municipality.regime === 'geneve' ? c.explainGeneve(n) : c.explainHuitCantons(n, taxStr))}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${CALC_PATH[locale]}">${esc(c.calcLink)}</a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${FRENCH_HUB_PATH[locale]}">${esc(c.hubTitle)}</a>
      </div>
    </section>

    ${renderRelated(locale, municipality)}

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">
        <details class="py-3" open><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ1(n))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA1(n, regimeLabel))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ2)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA2)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ3(n))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA3(n, rentStr))}</p></details>
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
      { '@type': 'Question', name: c.faqQ1(n), acceptedAnswer: { '@type': 'Answer', text: c.faqA1(n, regimeLabel) } },
      { '@type': 'Question', name: c.faqQ2, acceptedAnswer: { '@type': 'Answer', text: c.faqA2 } },
      { '@type': 'Question', name: c.faqQ3(n), acceptedAnswer: { '@type': 'Answer', text: c.faqA3(n, rentStr) } },
    ],
  });

  // Budget-aware, keyword-preserving cascade (composePlaceTitle) — three
  // rungs, longest-first (issue #4886): `title` (full sentence) →
  // `titleMid` (name + role, e.g. "{name}: Guida frontalieri") → `titleShort`
  // (the shortest form that still carries this locale's core "living in
  // {name}" keyword). The bare commune name is NEVER a candidate: it stays
  // under the char cap but carries zero query-intent signal, so it would be
  // SEO-dead if ever selected. `title` alone (34 fixed chars) already fits
  // every commune in today's dataset (longest name: 24 chars,
  // "Saint-Julien-en-Genevois") — the extra rungs only matter for
  // hypothetical future entries with much longer names, same regression
  // class as audit:title-length #4593.
  const titleCandidates = [c.title(n), c.titleMid(n), c.titleShort(n)];
  const html = buildSeoPageHtml({
    locale,
    title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
    description: c.desc(n, regimeLabel),
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
  municipality: FrenchBorderMunicipality;
  locale: FrenchLocale;
  distDir: string;
}): string {
  const { municipality, locale, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const regimeLabel = REGIME_LABEL[municipality.regime][locale];
  const canonicalPath = frenchMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const body = `<main class="seo-static-content mx-auto max-w-[760px] px-5 pt-8 pb-14 text-body">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${FRENCH_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>
    <h1 class="text-2xl font-bold text-heading mb-3">${esc(c.h1(n, regimeLabel))}</h1>
    <p class="text-body mb-5 leading-6">${esc(c.bridgeLede(n))}</p>
    <ul class="space-y-2 list-none p-0 m-0">
      <li><a href="${CALC_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a></li>
      <li><a href="${FRENCH_HUB_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.hubTitle)} →</a></li>
    </ul>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: c.title(n),
    description: c.desc(n, regimeLabel),
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

function renderHubPage(params: { locale: FrenchLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const canonicalPath = FRENCH_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const groupLabel: Record<FrenchRegime, string> = {
    geneve: c.groupGeneve,
    'huit-cantons': c.groupHuitCantons,
  };
  const byRegime = new Map<FrenchRegime, FrenchBorderMunicipality[]>();
  for (const m of FRENCH_ABOVE_FLOOR) {
    const arr = byRegime.get(m.regime);
    if (arr) arr.push(m);
    else byRegime.set(m.regime, [m]);
  }
  const groups = [...byRegime.entries()]
    .map(([regime, list]) => {
      const cards = list
        .map(
          (m) =>
            `<a class="rounded-md border border-edge bg-surface-raised p-4 hover:border-accent-border" href="${frenchMunicipalityPathFor(locale, m.slug)}">
              <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
              <span class="mt-1 block text-xs text-muted">${esc(getCantonDisplayName(m.canton, locale))}</span>
            </a>`,
        )
        .join('');
      return `<div class="mt-5">
          <h2 class="text-lg font-bold text-heading">${esc(groupLabel[regime])}</h2>
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

  const hubHreflang = FRENCH_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${FRENCH_HUB_PATH[alt]}">`,
  )
    .concat(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${FRENCH_HUB_PATH.it}">`)
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
      FRENCH_HUB_PATH.it,
      FRENCH_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${FRENCH_HUB_PATH[l]}` })).concat({
        hreflang: 'x-default',
        href: `${BASE_URL}${FRENCH_HUB_PATH.it}`,
      }),
      '0.7',
    ),
  );

  for (const m of FRENCH_ABOVE_FLOOR) {
    urls.push(
      entry(
        frenchMunicipalityPathFor('it', m.slug),
        FRENCH_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${frenchMunicipalityPathFor(l, m.slug)}` })).concat({
          hreflang: 'x-default',
          href: `${BASE_URL}${frenchMunicipalityPathFor('it', m.slug)}`,
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

export function frenchBorderMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'french-border-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_FRENCH_BORDER_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[french-border-municipalities]\x1b[0m skipped (SKIP_FRENCH_BORDER_MUNICIPALITY_PAGES=1)');
        resolveFrenchBorderMunicipalitiesFlushed([]);
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveFrenchBorderMunicipalitiesFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'frenchBorderMunicipalityPagesPlugin' });
      const t0 = Date.now();
      let indexablePages = 0;
      let bridgePages = 0;
      let thinPages = 0;

      const hubPaths: string[] = [];
      for (const locale of FRENCH_LOCALES) {
        const { urlPath, html } = renderHubPage({ locale, dateStamp, distDir });
        collector.add(path.join(distDir, urlPath, 'index.html'), html);
        collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
        hubPaths.push(urlPath);
      }

      for (const municipality of FRENCH_ABOVE_FLOOR) {
        for (const locale of FRENCH_LOCALES) {
          const { urlPath, html, wordCount } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir });
          if (wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          indexablePages++;
        }
      }

      for (const municipality of FRENCH_BELOW_FLOOR) {
        for (const locale of FRENCH_LOCALES) {
          const urlPath = frenchMunicipalityPathFor(locale, municipality.slug);
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
        `\x1b[36m[french-border-municipalities]\x1b[0m ${FRENCH_ABOVE_FLOOR.length} above-floor + ${FRENCH_BELOW_FLOOR.length} below-floor → ` +
          `${indexablePages} pages (${thinPages} thin) + ${bridgePages} bridges + ${FRENCH_LOCALES.length} hubs — ` +
          `flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Unblocks frenchBorderMunicipalityLinksPlugin, which injects a hub link
      // into the per-locale HTML sitemap page — without it the whole
      // sitemap-comuni-francia.xml shard ships BFS-unreachable from `/`
      // (same orphan-tier hazard as the fiscal family, audit:max-bfs-depth
      // regression #4593).
      resolveFrenchBorderMunicipalitiesFlushed(hubPaths);
    },
  };
}
