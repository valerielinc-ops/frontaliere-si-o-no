/**
 * Swiss minimum-wage landings (#4479, epic #4478) — Vite build plugin.
 *
 * Emits 28 static HTML pages (7 page types × 4 locales):
 *   hub    — /salario-minimo/                 overview + cantonal comparison
 *   canton — /salario-minimo/{canton}/        one per canton with a legal min
 *   ccl    — /salario-minimo/contratti-collettivi/  main sector CCL minimums
 *
 * All content is derived from data/seo/swiss-minimum-wage.json (refreshed by
 * scripts/update-minimum-wage-dataset.mjs). No floor/threshold loop — the page
 * set is fixed and curated, so no below-floor bridge / searchConsoleCompat
 * self-map is required.
 *
 * Pattern mirrors holidaysLandingsPlugin: buildSeoPageHtml shell,
 * seoContentOutsideRoot, WriteCollector, sitemap-minimum-wage.xml + index patch.
 * The end-of-content multiplex (endOfContentMultiplexHtml) is emitted ONLY on
 * the hub (index) page, gated on index,follow — leaf/detail pages keep Auto Ads
 * only. Env gate: SKIP_MINWAGE=1 fast-exits (local builds only; CI always runs).
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname_minwage = np.dirname(fileURLToPath(import.meta.url));

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  renderSeoHeroImage,
  seoHeroImageObject,
  seoHeroImageUrl,
  SEO_HERO_WIDTH,
  SEO_HERO_HEIGHT,
  type SeoHeroImageOpts,
} from './shared/seoHeroImage';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { CALC_HREF } from './shared/calcHref';
import { COMPLETE_WORK_GUIDE_HREF } from './shared/pillarGuideHrefs';
import { formatUpdatedDate } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import {
  MINWAGE_LOCALES,
  MINWAGE_PAGES,
  CANTON_IDS,
  buildMinWageLandingPath,
  type MinWageLocale,
  type MinWagePage,
  type CantonId,
  type MinWageDataset,
  type CantonMinWage,
  type CclMinWage,
  type CclUnit,
} from './minimumWageLandingsData';
import {
  H1_STYLE,
  H2_STYLE,
  H3_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  HERO_EYEBROW_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<MinWageLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

// Work/permits guide URL per locale — reciprocal in-page link. Shared single
// source of truth (build-plugins/shared/pillarGuideHrefs.ts), not a local
// duplicate: the copy this replaced was byte-identical to holidaysLandings'
// and carried the same dead EN (404) and noindex DE targets (#5428).
const PERMITS_GUIDE_URL: Record<MinWageLocale, string> = COMPLETE_WORK_GUIDE_HREF;

const CCL_UNIT_WORD: Record<MinWageLocale, Record<CclUnit, string>> = {
  it: { month: 'mese', hour: 'ora' },
  en: { month: 'month', hour: 'hour' },
  de: { month: 'Monat', hour: 'Stunde' },
  fr: { month: 'mois', hour: 'heure' },
};

// ── Dataset load (module-cached) ──────────────────────────────────────────

let _dataset: MinWageDataset | null = null;
function loadDataset(): MinWageDataset {
  if (_dataset) return _dataset;
  const dataPath = np.resolve(__dirname_minwage, '..', 'data', 'seo', 'swiss-minimum-wage.json');
  const raw = fs.readFileSync(dataPath, 'utf-8');
  _dataset = JSON.parse(raw) as MinWageDataset;
  return _dataset;
}

/** Swiss thousands separator (apostrophe). */
function chfMonthly(n: number): string {
  return `CHF ${Math.round(n).toLocaleString('de-CH').replace(/[’',.]/g, '’')}`;
}

/** `CHF 24.59/h` or `CHF 20.00–20.50/h` for a canton. */
function fmtHourly(c: CantonMinWage): string {
  const fmt = (v: number) => v.toFixed(2);
  return c.hourlyMin === c.hourlyMax
    ? `CHF ${fmt(c.hourlyMin)}/h`
    : `CHF ${fmt(c.hourlyMin)}–${fmt(c.hourlyMax)}/h`;
}

/** `≈ CHF 4’475` or `≈ CHF 3’640–3’731` for a canton. */
function fmtMonthly(c: CantonMinWage): string {
  return c.monthlyMin === c.monthlyMax
    ? `≈ ${chfMonthly(c.monthlyMin)}`
    : `≈ CHF ${Math.round(c.monthlyMin).toLocaleString('de-CH').replace(/[’',.]/g, '’')}–${Math.round(
        c.monthlyMax,
      ).toLocaleString('de-CH').replace(/[’',.]/g, '’')}`;
}

function fmtCclRow(amount: string, unit: CclUnit, locale: MinWageLocale): string {
  return `CHF ${amount}/${CCL_UNIT_WORD[locale][unit]}`;
}

// ── Locale copy ───────────────────────────────────────────────────────────

interface MinWageCopy {
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly updatedLabel: string;
  readonly ctaCalc: string;
  readonly ctaGuide: string;
  readonly relatedLabel: string;
  readonly sourceLabel: string;
  readonly tableCanton: string;
  readonly tableLaw: string;
  readonly tableHourly: string;
  readonly tableMonthly: string;
  readonly sinceLabel: string;
  readonly hub: {
    readonly title: (y: number) => string;
    readonly description: (y: number) => string;
    readonly eyebrow: string;
    readonly h1: (y: number) => string;
    readonly lede: (top: string, y: number) => string;
    readonly intro: string;
    readonly tableTitle: (y: number) => string;
    readonly cclTitle: string;
    readonly cclIntro: string;
    readonly cclLinkLabel: string;
    readonly statHighestLabel: string;
    readonly statLowestLabel: string;
    readonly statCountLabel: string;
  };
  readonly canton: {
    readonly title: (name: string, y: number) => string;
    readonly description: (name: string, hourly: string, y: number) => string;
    readonly eyebrow: string;
    readonly h1: (name: string, y: number) => string;
    readonly lede: (name: string, hourly: string, y: number) => string;
    readonly statHourlyLabel: string;
    readonly statMonthlyLabel: string;
    readonly statSinceLabel: string;
    readonly lawTitle: string;
    readonly compareTitle: string;
    readonly compareIntro: string;
    readonly faqs: (name: string, hourly: string, y: number) => ReadonlyArray<{ q: string; a: string }>;
  };
  readonly ccl: {
    readonly title: (y: number) => string;
    readonly description: (y: number) => string;
    readonly eyebrow: string;
    readonly h1: (y: number) => string;
    readonly lede: string;
    readonly intro: string;
    readonly scopeLabel: string;
    readonly statSectorsLabel: string;
    readonly faqs: ReadonlyArray<{ q: string; a: string }>;
  };
  readonly hubFaqs: ReadonlyArray<{ q: string; a: string }>;
  readonly faqTitle: string;
}

const COPY: Record<MinWageLocale, MinWageCopy> = {
  it: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Salario minimo',
    updatedLabel: 'Aggiornato il',
    ctaCalc: 'Calcola il tuo stipendio netto →',
    ctaGuide: 'Guida completa al lavoro frontaliere',
    relatedLabel: 'Approfondisci',
    sourceLabel: 'Fonte',
    tableCanton: 'Cantone',
    tableLaw: 'In vigore dal',
    tableHourly: 'Salario minimo orario',
    tableMonthly: 'Stima mensile',
    sinceLabel: 'In vigore dal',
    faqTitle: 'Domande frequenti',
    hub: {
      title: (y) => `Salario minimo in Svizzera ${y}: cantoni e CCL`,
      description: (y) =>
        `Salario minimo ${y} in Svizzera: i cinque cantoni con salario minimo legale (Ginevra, Basilea Città, Giura, Neuchâtel, Ticino) e i minimi dei principali contratti collettivi. Valori orari e mensili per i frontalieri.`,
      eyebrow: 'Guida frontalieri',
      h1: (y) => `Salario minimo in Svizzera ${y}`,
      lede: (top, y) =>
        `La Svizzera non ha un salario minimo nazionale: solo cinque cantoni lo prevedono per legge (il più alto è ${top}) e per il resto vale il minimo dei contratti collettivi. Ecco il quadro completo ${y} per i frontalieri.`,
      intro:
        'A differenza dell’Italia e di molti Paesi europei, la Svizzera non ha un salario minimo legale federale. Il tema è regolato a due livelli: alcuni cantoni hanno introdotto per legge un salario minimo cantonale (dopo votazioni popolari), mentre in tutto il resto del Paese il minimo salariale deriva dai contratti collettivi di lavoro (CCL/GAV) di settore, spesso dichiarati di obbligatorietà generale. Per un frontaliere conta il valore in vigore nel luogo di lavoro: quando esistono sia un minimo cantonale sia un minimo da CCL, si applica quello più favorevole al lavoratore.',
      tableTitle: (y) => `Salari minimi legali cantonali ${y}`,
      cclTitle: 'Salari minimi dei contratti collettivi (CCL)',
      cclIntro:
        'Nei settori senza salario minimo cantonale — o dove il CCL fissa un minimo più alto — il riferimento sono i contratti collettivi. Questi sono i quattro settori che impiegano più frontalieri, con salari minimi vincolanti:',
      cclLinkLabel: 'Vedi tutti i minimi dei CCL principali',
      statHighestLabel: 'Più alto (Ginevra)',
      statLowestLabel: 'Più basso (Ticino)',
      statCountLabel: 'Cantoni con salario minimo',
    },
    canton: {
      title: (name, y) => `Salario minimo ${name} ${y}: quanto è e chi lo riceve`,
      description: (name, hourly, y) =>
        `Salario minimo ${name} ${y}: ${hourly} lordi all’ora. Valore legale, importo mensile stimato, base giuridica e cosa significa per i frontalieri con permesso G.`,
      eyebrow: 'Salario minimo cantonale',
      h1: (name, y) => `Salario minimo ${name} ${y}`,
      lede: (name, hourly, y) =>
        `Nel ${y} il salario minimo legale del Canton ${name} è di ${hourly} lordi: ecco l’importo mensile stimato, la base giuridica e cosa comporta per i frontalieri.`,
      statHourlyLabel: 'Salario minimo orario',
      statMonthlyLabel: 'Stima mensile lorda',
      statSinceLabel: 'In vigore dal',
      lawTitle: 'Base giuridica e come funziona',
      compareTitle: 'Come si colloca rispetto agli altri cantoni',
      compareIntro:
        'Solo cinque cantoni svizzeri hanno un salario minimo legale. Ecco il confronto orario per l’anno in corso:',
      faqs: (name, hourly, y) => [
        {
          q: `Qual è il salario minimo in ${name} nel ${y}?`,
          a: `Nel ${y} il salario minimo legale del Canton ${name} è di ${hourly} lordi. Il valore è indicizzato ogni anno al costo della vita.`,
        },
        {
          q: `Il salario minimo di ${name} vale anche per i frontalieri?`,
          a: 'Sì. Il salario minimo cantonale si applica a tutti i lavoratori impiegati nel cantone, compresi i frontalieri con permesso G, a prescindere dal Paese di residenza.',
        },
        {
          q: 'Un contratto collettivo può prevedere un minimo più alto?',
          a: 'Sì. Se il CCL di settore fissa un salario minimo superiore a quello cantonale, si applica il valore più favorevole al lavoratore.',
        },
      ],
    },
    ccl: {
      title: (y) => `Salari minimi dei CCL ${y}: edilizia, ristorazione, pulizie`,
      description: (y) =>
        `Salari minimi ${y} dei principali contratti collettivi svizzeri (CCL/GAV): edilizia, alberghi e ristorazione, pulizie e personale interinale. Valori vincolanti per i frontalieri.`,
      eyebrow: 'Contratti collettivi',
      h1: (y) => `Salari minimi dei contratti collettivi ${y}`,
      lede:
        'Dove non c’è un salario minimo legale cantonale, il minimo lo fissano i contratti collettivi (CCL/GAV) di settore, spesso di obbligatorietà generale. Ecco i quattro settori che impiegano più frontalieri.',
      intro:
        'Un contratto collettivo di lavoro (CCL, in tedesco GAV) è un accordo tra le associazioni dei datori di lavoro e i sindacati che fissa condizioni minime — tra cui i salari minimi — per un intero settore. Quando è dichiarato di obbligatorietà generale, vale per tutte le aziende del ramo, comprese quelle che impiegano frontalieri. Questi minimi sono vincolanti: un’azienda non può pagare meno, e se convivono con un salario minimo cantonale si applica il valore più alto.',
      scopeLabel: 'Ambito',
      statSectorsLabel: 'Settori principali',
      faqs: [
        {
          q: 'Cosa sono i salari minimi da CCL?',
          a: 'Sono i salari minimi fissati dai contratti collettivi di lavoro di settore. Quando il CCL è di obbligatorietà generale, il minimo è vincolante per tutte le aziende del ramo, indipendentemente dal cantone.',
        },
        {
          q: 'Il salario minimo da CCL vale per i frontalieri?',
          a: 'Sì. Il minimo del contratto collettivo si applica a tutti i dipendenti del settore, compresi i frontalieri con permesso G impiegati in Svizzera.',
        },
        {
          q: 'Cosa succede se il cantone ha già un salario minimo legale?',
          a: 'Si applica il valore più favorevole al lavoratore. Se il salario minimo cantonale è più alto del minimo del CCL, prevale quello cantonale, e viceversa.',
        },
      ],
    },
    hubFaqs: [
      {
        q: 'Esiste un salario minimo nazionale in Svizzera?',
        a: 'No. La Svizzera non ha un salario minimo legale federale. Solo cinque cantoni — Ginevra, Basilea Città, Giura, Neuchâtel e Ticino — hanno introdotto un salario minimo cantonale; altrove il minimo deriva dai contratti collettivi di settore.',
      },
      {
        q: 'Qual è il salario minimo più alto della Svizzera?',
        a: 'Ginevra, con CHF 24.59 lordi all’ora nel 2026, ha il salario minimo legale più alto della Svizzera e uno dei più alti al mondo.',
      },
      {
        q: 'Il salario minimo vale anche per i frontalieri?',
        a: 'Sì. Il salario minimo — legale o da CCL — si applica a tutti i lavoratori impiegati nel cantone, compresi i frontalieri con permesso G, indipendentemente dalla residenza in Italia.',
      },
    ],
  },
  en: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Minimum wage',
    updatedLabel: 'Updated on',
    ctaCalc: 'Calculate your net salary →',
    ctaGuide: 'Complete cross-border work guide',
    relatedLabel: 'Read more',
    sourceLabel: 'Source',
    tableCanton: 'Canton',
    tableLaw: 'In force since',
    tableHourly: 'Hourly minimum wage',
    tableMonthly: 'Monthly estimate',
    sinceLabel: 'In force since',
    faqTitle: 'Frequently asked questions',
    hub: {
      title: (y) => `Minimum wage in Switzerland ${y}: cantons & collective agreements`,
      description: (y) =>
        `Minimum wage ${y} in Switzerland: the five cantons with a statutory minimum wage (Geneva, Basel-Stadt, Jura, Neuchâtel, Ticino) and the main collective-agreement minimums. Hourly and monthly figures for cross-border workers.`,
      eyebrow: 'Cross-border guide',
      h1: (y) => `Minimum wage in Switzerland ${y}`,
      lede: (top, y) =>
        `Switzerland has no national minimum wage: only five cantons legislate one (the highest is ${top}) and elsewhere the floor comes from collective agreements. Here is the full ${y} picture for cross-border workers.`,
      intro:
        'Unlike Italy and most European countries, Switzerland has no federal statutory minimum wage. The matter is regulated on two levels: some cantons introduced a statutory cantonal minimum wage (after popular votes), while everywhere else the wage floor comes from sector collective labour agreements (CCL/GAV), often declared universally applicable. What matters to a cross-border worker is the figure in force at the workplace: where both a cantonal minimum and a collective-agreement minimum exist, the one more favourable to the employee applies.',
      tableTitle: (y) => `Statutory cantonal minimum wages ${y}`,
      cclTitle: 'Collective-agreement (CCL) minimum wages',
      cclIntro:
        'In sectors without a cantonal minimum wage — or where the collective agreement sets a higher floor — the reference is the collective agreements. These are the four sectors that employ the most cross-border workers, with binding minimum wages:',
      cclLinkLabel: 'See all the main collective-agreement minimums',
      statHighestLabel: 'Highest (Geneva)',
      statLowestLabel: 'Lowest (Ticino)',
      statCountLabel: 'Cantons with a minimum wage',
    },
    canton: {
      title: (name, y) => `${name} minimum wage ${y}: how much and who gets it`,
      description: (name, hourly, y) =>
        `${name} minimum wage ${y}: ${hourly} gross per hour. Statutory figure, estimated monthly amount, legal basis and what it means for cross-border workers with a G permit.`,
      eyebrow: 'Cantonal minimum wage',
      h1: (name, y) => `${name} minimum wage ${y}`,
      lede: (name, hourly, y) =>
        `In ${y} the statutory minimum wage in the canton of ${name} is ${hourly} gross: here is the estimated monthly amount, the legal basis and what it means for cross-border workers.`,
      statHourlyLabel: 'Hourly minimum wage',
      statMonthlyLabel: 'Estimated gross monthly',
      statSinceLabel: 'In force since',
      lawTitle: 'Legal basis and how it works',
      compareTitle: 'How it compares with the other cantons',
      compareIntro:
        'Only five Swiss cantons have a statutory minimum wage. Here is the hourly comparison for the current year:',
      faqs: (name, hourly, y) => [
        {
          q: `What is the minimum wage in ${name} in ${y}?`,
          a: `In ${y} the statutory minimum wage in the canton of ${name} is ${hourly} gross. The figure is indexed to the cost of living every year.`,
        },
        {
          q: `Does the ${name} minimum wage also apply to cross-border workers?`,
          a: 'Yes. The cantonal minimum wage applies to every worker employed in the canton, including cross-border workers with a G permit, regardless of their country of residence.',
        },
        {
          q: 'Can a collective agreement set a higher minimum?',
          a: 'Yes. If the sector collective agreement sets a minimum wage above the cantonal one, the figure more favourable to the employee applies.',
        },
      ],
    },
    ccl: {
      title: (y) => `Sector minimum wages ${y}: construction, catering, cleaning`,
      description: (y) =>
        `${y} minimum wages of the main Swiss collective agreements (CCL/GAV): construction, hotels and catering, cleaning and temporary agency work. Binding figures for cross-border workers.`,
      eyebrow: 'Collective agreements',
      h1: (y) => `Collective-agreement minimum wages ${y}`,
      lede:
        'Where there is no statutory cantonal minimum wage, the floor is set by sector collective agreements (CCL/GAV), often universally applicable. These are the four sectors that employ the most cross-border workers.',
      intro:
        'A collective labour agreement (CCL, in German GAV) is a deal between employer associations and trade unions that sets minimum conditions — including minimum wages — for a whole sector. When it is declared universally applicable, it covers every company in the branch, including those that employ cross-border workers. These minimums are binding: a company cannot pay less, and where they coexist with a cantonal minimum wage the higher figure applies.',
      scopeLabel: 'Scope',
      statSectorsLabel: 'Main sectors',
      faqs: [
        {
          q: 'What are collective-agreement minimum wages?',
          a: 'They are the minimum wages set by sector collective labour agreements. When the agreement is universally applicable, the minimum is binding for every company in the branch, regardless of the canton.',
        },
        {
          q: 'Do collective-agreement minimums apply to cross-border workers?',
          a: 'Yes. The collective-agreement minimum applies to every employee in the sector, including cross-border workers with a G permit employed in Switzerland.',
        },
        {
          q: 'What if the canton already has a statutory minimum wage?',
          a: 'The figure more favourable to the employee applies. If the cantonal minimum wage is higher than the collective-agreement minimum, the cantonal one prevails, and vice versa.',
        },
      ],
    },
    hubFaqs: [
      {
        q: 'Is there a national minimum wage in Switzerland?',
        a: 'No. Switzerland has no federal statutory minimum wage. Only five cantons — Geneva, Basel-Stadt, Jura, Neuchâtel and Ticino — have introduced a cantonal minimum wage; elsewhere the floor comes from sector collective agreements.',
      },
      {
        q: 'What is the highest minimum wage in Switzerland?',
        a: 'Geneva, at CHF 24.59 gross per hour in 2026, has the highest statutory minimum wage in Switzerland and one of the highest in the world.',
      },
      {
        q: 'Does the minimum wage also apply to cross-border workers?',
        a: 'Yes. The minimum wage — statutory or collective-agreement — applies to every worker employed in the canton, including cross-border workers with a G permit, regardless of their residence in Italy.',
      },
    ],
  },
  de: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Mindestlohn',
    updatedLabel: 'Aktualisiert am',
    ctaCalc: 'Nettolohn berechnen →',
    ctaGuide: 'Vollständiger Grenzgänger-Leitfaden',
    relatedLabel: 'Mehr erfahren',
    sourceLabel: 'Quelle',
    tableCanton: 'Kanton',
    tableLaw: 'In Kraft seit',
    tableHourly: 'Mindestlohn pro Stunde',
    tableMonthly: 'Monatliche Schätzung',
    sinceLabel: 'In Kraft seit',
    faqTitle: 'Häufige Fragen',
    hub: {
      title: (y) => `Mindestlohn in der Schweiz ${y}: Kantone und GAV`,
      description: (y) =>
        `Mindestlohn ${y} in der Schweiz: die fünf Kantone mit gesetzlichem Mindestlohn (Genf, Basel-Stadt, Jura, Neuenburg, Tessin) und die Mindestlöhne der wichtigsten Gesamtarbeitsverträge. Stunden- und Monatswerte für Grenzgänger.`,
      eyebrow: 'Grenzgänger-Leitfaden',
      h1: (y) => `Mindestlohn in der Schweiz ${y}`,
      lede: (top, y) =>
        `Die Schweiz hat keinen nationalen Mindestlohn: Nur fünf Kantone kennen einen gesetzlichen (der höchste ist ${top}), sonst gilt der Mindestlohn aus den Gesamtarbeitsverträgen. Hier das vollständige Bild ${y} für Grenzgänger.`,
      intro:
        'Anders als Italien und die meisten europäischen Länder hat die Schweiz keinen bundesweiten gesetzlichen Mindestlohn. Das Thema ist auf zwei Ebenen geregelt: Einige Kantone haben (nach Volksabstimmungen) einen gesetzlichen kantonalen Mindestlohn eingeführt, während im Rest des Landes der Lohnsockel aus den branchenbezogenen Gesamtarbeitsverträgen (GAV) stammt, oft allgemeinverbindlich erklärt. Für einen Grenzgänger zählt der am Arbeitsort geltende Wert: Bestehen sowohl ein kantonaler als auch ein GAV-Mindestlohn, gilt der für den Arbeitnehmer günstigere.',
      tableTitle: (y) => `Gesetzliche kantonale Mindestlöhne ${y}`,
      cclTitle: 'Mindestlöhne der Gesamtarbeitsverträge (GAV)',
      cclIntro:
        'In Branchen ohne kantonalen Mindestlohn — oder wo der GAV einen höheren Sockel setzt — sind die Gesamtarbeitsverträge massgebend. Dies sind die vier Branchen mit den meisten Grenzgängern, mit verbindlichen Mindestlöhnen:',
      cclLinkLabel: 'Alle Mindestlöhne der wichtigsten GAV ansehen',
      statHighestLabel: 'Höchster (Genf)',
      statLowestLabel: 'Niedrigster (Tessin)',
      statCountLabel: 'Kantone mit Mindestlohn',
    },
    canton: {
      title: (name, y) => `Mindestlohn ${name} ${y}: Höhe und wer ihn erhält`,
      description: (name, hourly, y) =>
        `Mindestlohn ${name} ${y}: ${hourly} brutto pro Stunde. Gesetzlicher Wert, geschätzter Monatsbetrag, Rechtsgrundlage und was er für Grenzgänger mit G-Bewilligung bedeutet.`,
      eyebrow: 'Kantonaler Mindestlohn',
      h1: (name, y) => `Mindestlohn ${name} ${y}`,
      lede: (name, hourly, y) =>
        `${y} beträgt der gesetzliche Mindestlohn im Kanton ${name} ${hourly} brutto: hier der geschätzte Monatsbetrag, die Rechtsgrundlage und was das für Grenzgänger bedeutet.`,
      statHourlyLabel: 'Mindestlohn pro Stunde',
      statMonthlyLabel: 'Geschätzt brutto/Monat',
      statSinceLabel: 'In Kraft seit',
      lawTitle: 'Rechtsgrundlage und Funktionsweise',
      compareTitle: 'Im Vergleich zu den anderen Kantonen',
      compareIntro:
        'Nur fünf Schweizer Kantone haben einen gesetzlichen Mindestlohn. Hier der Stundenvergleich für das laufende Jahr:',
      faqs: (name, hourly, y) => [
        {
          q: `Wie hoch ist der Mindestlohn in ${name} ${y}?`,
          a: `${y} beträgt der gesetzliche Mindestlohn im Kanton ${name} ${hourly} brutto. Der Wert wird jährlich an die Teuerung angepasst.`,
        },
        {
          q: `Gilt der Mindestlohn von ${name} auch für Grenzgänger?`,
          a: 'Ja. Der kantonale Mindestlohn gilt für alle im Kanton beschäftigten Arbeitnehmer, einschliesslich Grenzgänger mit G-Bewilligung, unabhängig vom Wohnsitzland.',
        },
        {
          q: 'Kann ein GAV einen höheren Mindestlohn vorsehen?',
          a: 'Ja. Setzt der Branchen-GAV einen höheren Mindestlohn als der kantonale, gilt der für den Arbeitnehmer günstigere Wert.',
        },
      ],
    },
    ccl: {
      title: (y) => `GAV-Mindestlöhne ${y}: Bau, Gastgewerbe, Reinigung, Temporärarbeit`,
      description: (y) =>
        `Mindestlöhne ${y} der wichtigsten Schweizer Gesamtarbeitsverträge (GAV): Bauhauptgewerbe, Gastgewerbe, Reinigung und Personalverleih. Verbindliche Werte für Grenzgänger.`,
      eyebrow: 'Gesamtarbeitsverträge',
      h1: (y) => `Mindestlöhne der Gesamtarbeitsverträge ${y}`,
      lede:
        'Wo es keinen gesetzlichen kantonalen Mindestlohn gibt, setzen die branchenbezogenen Gesamtarbeitsverträge (GAV) den Sockel, oft allgemeinverbindlich. Dies sind die vier Branchen mit den meisten Grenzgängern.',
      intro:
        'Ein Gesamtarbeitsvertrag (GAV, italienisch CCL) ist eine Vereinbarung zwischen Arbeitgeberverbänden und Gewerkschaften, die Mindestbedingungen — darunter Mindestlöhne — für eine ganze Branche festlegt. Ist er allgemeinverbindlich erklärt, gilt er für alle Betriebe der Branche, auch für solche mit Grenzgängern. Diese Mindestlöhne sind verbindlich: Ein Betrieb darf nicht weniger zahlen, und bestehen sie neben einem kantonalen Mindestlohn, gilt der höhere Wert.',
      scopeLabel: 'Geltungsbereich',
      statSectorsLabel: 'Wichtigste Branchen',
      faqs: [
        {
          q: 'Was sind GAV-Mindestlöhne?',
          a: 'Es sind die von den branchenbezogenen Gesamtarbeitsverträgen festgelegten Mindestlöhne. Ist der GAV allgemeinverbindlich, ist der Mindestlohn für alle Betriebe der Branche verbindlich, unabhängig vom Kanton.',
        },
        {
          q: 'Gelten GAV-Mindestlöhne für Grenzgänger?',
          a: 'Ja. Der GAV-Mindestlohn gilt für alle Arbeitnehmer der Branche, einschliesslich Grenzgänger mit G-Bewilligung, die in der Schweiz beschäftigt sind.',
        },
        {
          q: 'Was, wenn der Kanton bereits einen gesetzlichen Mindestlohn hat?',
          a: 'Es gilt der für den Arbeitnehmer günstigere Wert. Ist der kantonale Mindestlohn höher als der GAV-Mindestlohn, gilt der kantonale, und umgekehrt.',
        },
      ],
    },
    hubFaqs: [
      {
        q: 'Gibt es einen nationalen Mindestlohn in der Schweiz?',
        a: 'Nein. Die Schweiz hat keinen bundesweiten gesetzlichen Mindestlohn. Nur fünf Kantone — Genf, Basel-Stadt, Jura, Neuenburg und Tessin — haben einen kantonalen Mindestlohn eingeführt; sonst stammt der Sockel aus den Branchen-GAV.',
      },
      {
        q: 'Wie hoch ist der höchste Mindestlohn der Schweiz?',
        a: 'Genf hat mit CHF 24.59 brutto pro Stunde im Jahr 2026 den höchsten gesetzlichen Mindestlohn der Schweiz und einen der höchsten weltweit.',
      },
      {
        q: 'Gilt der Mindestlohn auch für Grenzgänger?',
        a: 'Ja. Der Mindestlohn — gesetzlich oder aus GAV — gilt für alle im Kanton beschäftigten Arbeitnehmer, einschliesslich Grenzgänger mit G-Bewilligung, unabhängig vom Wohnsitz in Italien.',
      },
    ],
  },
  fr: {
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Salaire minimum',
    updatedLabel: 'Mis à jour le',
    ctaCalc: 'Calculez votre salaire net →',
    ctaGuide: 'Guide complet du travail frontalier',
    relatedLabel: 'Pour aller plus loin',
    sourceLabel: 'Source',
    tableCanton: 'Canton',
    tableLaw: 'En vigueur depuis',
    tableHourly: 'Salaire minimum horaire',
    tableMonthly: 'Estimation mensuelle',
    sinceLabel: 'En vigueur depuis',
    faqTitle: 'Questions fréquentes',
    hub: {
      title: (y) => `Salaire minimum en Suisse ${y} : cantons et CCT`,
      description: (y) =>
        `Salaire minimum ${y} en Suisse : les cinq cantons avec un salaire minimum légal (Genève, Bâle-Ville, Jura, Neuchâtel, Tessin) et les minimums des principales conventions collectives. Valeurs horaires et mensuelles pour les frontaliers.`,
      eyebrow: 'Guide frontalier',
      h1: (y) => `Salaire minimum en Suisse ${y}`,
      lede: (top, y) =>
        `La Suisse n’a pas de salaire minimum national : seuls cinq cantons en prévoient un par la loi (le plus élevé est ${top}) et ailleurs le plancher vient des conventions collectives. Voici le panorama complet ${y} pour les frontaliers.`,
      intro:
        'Contrairement à l’Italie et à la plupart des pays européens, la Suisse n’a pas de salaire minimum légal fédéral. Le sujet est réglé à deux niveaux : certains cantons ont introduit (après votations populaires) un salaire minimum cantonal légal, tandis que dans le reste du pays le plancher salarial provient des conventions collectives de travail (CCT/GAV) de branche, souvent déclarées de force obligatoire. Ce qui compte pour un frontalier, c’est la valeur en vigueur au lieu de travail : lorsqu’il existe à la fois un minimum cantonal et un minimum de CCT, c’est le plus favorable au salarié qui s’applique.',
      tableTitle: (y) => `Salaires minimums cantonaux légaux ${y}`,
      cclTitle: 'Salaires minimums des conventions collectives (CCT)',
      cclIntro:
        'Dans les branches sans salaire minimum cantonal — ou lorsque la CCT fixe un plancher plus élevé — la référence est la convention collective. Voici les quatre branches qui emploient le plus de frontaliers, avec des salaires minimums contraignants :',
      cclLinkLabel: 'Voir tous les minimums des principales CCT',
      statHighestLabel: 'Le plus élevé (Genève)',
      statLowestLabel: 'Le plus bas (Tessin)',
      statCountLabel: 'Cantons avec salaire minimum',
    },
    canton: {
      title: (name, y) => `Salaire minimum ${name} ${y} : combien et pour qui`,
      description: (name, hourly, y) =>
        `Salaire minimum ${name} ${y} : ${hourly} brut de l’heure. Valeur légale, montant mensuel estimé, base légale et ce que cela signifie pour les frontaliers avec permis G.`,
      eyebrow: 'Salaire minimum cantonal',
      h1: (name, y) => `Salaire minimum ${name} ${y}`,
      lede: (name, hourly, y) =>
        `En ${y}, le salaire minimum légal du canton de ${name} est de ${hourly} brut : voici le montant mensuel estimé, la base légale et ce que cela implique pour les frontaliers.`,
      statHourlyLabel: 'Salaire minimum horaire',
      statMonthlyLabel: 'Estimation brute/mois',
      statSinceLabel: 'En vigueur depuis',
      lawTitle: 'Base légale et fonctionnement',
      compareTitle: 'Comparaison avec les autres cantons',
      compareIntro:
        'Seuls cinq cantons suisses ont un salaire minimum légal. Voici la comparaison horaire pour l’année en cours :',
      faqs: (name, hourly, y) => [
        {
          q: `Quel est le salaire minimum à ${name} en ${y} ?`,
          a: `En ${y}, le salaire minimum légal du canton de ${name} est de ${hourly} brut. La valeur est indexée chaque année sur le coût de la vie.`,
        },
        {
          q: `Le salaire minimum de ${name} s’applique-t-il aussi aux frontaliers ?`,
          a: 'Oui. Le salaire minimum cantonal s’applique à tous les travailleurs employés dans le canton, y compris les frontaliers avec permis G, quel que soit leur pays de résidence.',
        },
        {
          q: 'Une convention collective peut-elle prévoir un minimum plus élevé ?',
          a: 'Oui. Si la CCT de branche fixe un salaire minimum supérieur au minimum cantonal, c’est la valeur la plus favorable au salarié qui s’applique.',
        },
      ],
    },
    ccl: {
      title: (y) => `Salaires minimums CCT ${y} : construction, restauration, nettoyage`,
      description: (y) =>
        `Salaires minimums ${y} des principales conventions collectives suisses (CCT/GAV) : construction, hôtellerie-restauration, nettoyage et travail temporaire. Valeurs contraignantes pour les frontaliers.`,
      eyebrow: 'Conventions collectives',
      h1: (y) => `Salaires minimums des conventions collectives ${y}`,
      lede:
        'Là où il n’y a pas de salaire minimum cantonal légal, le plancher est fixé par les conventions collectives (CCT/GAV) de branche, souvent de force obligatoire. Voici les quatre branches qui emploient le plus de frontaliers.',
      intro:
        'Une convention collective de travail (CCT, en allemand GAV) est un accord entre les associations patronales et les syndicats qui fixe des conditions minimales — dont les salaires minimums — pour toute une branche. Lorsqu’elle est déclarée de force obligatoire, elle s’applique à toutes les entreprises de la branche, y compris celles qui emploient des frontaliers. Ces minimums sont contraignants : une entreprise ne peut pas payer moins, et lorsqu’ils coexistent avec un salaire minimum cantonal, c’est la valeur la plus élevée qui s’applique.',
      scopeLabel: 'Champ d’application',
      statSectorsLabel: 'Branches principales',
      faqs: [
        {
          q: 'Que sont les salaires minimums de CCT ?',
          a: 'Ce sont les salaires minimums fixés par les conventions collectives de branche. Lorsque la CCT est de force obligatoire, le minimum est contraignant pour toutes les entreprises de la branche, quel que soit le canton.',
        },
        {
          q: 'Les minimums de CCT s’appliquent-ils aux frontaliers ?',
          a: 'Oui. Le minimum de la convention collective s’applique à tous les salariés de la branche, y compris les frontaliers avec permis G employés en Suisse.',
        },
        {
          q: 'Que se passe-t-il si le canton a déjà un salaire minimum légal ?',
          a: 'C’est la valeur la plus favorable au salarié qui s’applique. Si le salaire minimum cantonal est plus élevé que le minimum de la CCT, c’est le cantonal qui prévaut, et inversement.',
        },
      ],
    },
    hubFaqs: [
      {
        q: 'Existe-t-il un salaire minimum national en Suisse ?',
        a: 'Non. La Suisse n’a pas de salaire minimum légal fédéral. Seuls cinq cantons — Genève, Bâle-Ville, Jura, Neuchâtel et Tessin — ont introduit un salaire minimum cantonal ; ailleurs le plancher vient des conventions collectives de branche.',
      },
      {
        q: 'Quel est le salaire minimum le plus élevé de Suisse ?',
        a: 'Genève, avec CHF 24.59 brut de l’heure en 2026, a le salaire minimum légal le plus élevé de Suisse et l’un des plus élevés au monde.',
      },
      {
        q: 'Le salaire minimum s’applique-t-il aussi aux frontaliers ?',
        a: 'Oui. Le salaire minimum — légal ou de CCT — s’applique à tous les travailleurs employés dans le canton, y compris les frontaliers avec permis G, quelle que soit leur résidence en Italie.',
      },
    ],
  },
};

// ── Render ────────────────────────────────────────────────────────────────

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function pageKey(page: MinWagePage): string {
  return page.kind === 'canton' ? `canton-${page.canton}` : page.kind;
}

function renderPage(opts: {
  locale: MinWageLocale;
  page: MinWagePage;
  dateStamp: string;
  distDir?: string;
  /**
   * Locales whose page for THIS `page` the build will actually write. The
   * `MIN_INDEXABLE_WORDS` floor below is evaluated per locale (and per page),
   * so it can drop DE while keeping IT for the same page — and an hreflang
   * block built from the full `MINWAGE_LOCALES` list would then advertise a
   * page nothing wrote (the #5114 `missingTarget` class). Pass 1 of the
   * caller's two-pass render leaves this at the empty default: it only reads
   * `wordCount`, which is derived from the body and does not depend on the
   * hreflang block.
   */
  eligibleLocales?: ReadonlySet<string>;
}): RenderResult {
  const { locale, page, dateStamp, distDir, eligibleLocales = new Set<string>() } = opts;
  const L = COPY[locale];
  const ds = loadDataset();
  const year = ds.meta.year;
  const cantons = [...ds.cantons].sort((a, b) => b.hourlyMin - a.hourlyMin);
  const ge = cantons.find((c) => c.id === 'ge')!;
  const ti = cantons.find((c) => c.id === 'ti')!;

  const urlPath = buildMinWageLandingPath(locale, page);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubUrl = `${BASE_URL}${buildMinWageLandingPath(locale, { kind: 'hub' })}`;
  const cclUrl = `${BASE_URL}${buildMinWageLandingPath(locale, { kind: 'ccl' })}`;
  const calcUrl = `${BASE_URL}${CALC_HREF[locale]}`;
  const guideUrl = `${BASE_URL}${PERMITS_GUIDE_URL[locale]}`;

  // hreflang (4 locales + x-default IT), emitted only when every locale's
  // page for this `page` is actually written this build — otherwise nothing,
  // since a partial set only trades audit-hreflang's [missingTarget] for
  // [tooFew] (#5114).
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildMinWageLandingPath(alt as MinWageLocale, page)}`,
    indent: '    ',
  });

  // Shared style block (table + FAQ).
  const styleBlock = `<style>.mwd{${TABLE_HEAD_STYLE}}.mwc{${TABLE_CELL_STYLE}}.mwf{margin:0 0 10px;padding:14px 16px;background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:12px}.mwfs{font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45}.mwfa{margin:10px 0 0;color:var(--color-body);line-height:1.65}.mwsrc{font-size:13px;color:var(--color-body);opacity:.85;margin:6px 0 0}</style>`;

  // Cantonal comparison table (used by hub + canton pages).
  function cantonTable(highlight?: CantonId): string {
    const rows = cantons
      .map((c) => {
        const hl = c.id === highlight ? ' style="background:var(--color-surface-alt);font-weight:600"' : '';
        const cantonUrl = buildMinWageLandingPath(locale, { kind: 'canton', canton: c.id });
        const nameCell =
          c.id === highlight
            ? esc(c.name[locale])
            : `<a href="${esc(cantonUrl)}" style="${LINK_ACCENT_STYLE}">${esc(c.name[locale])}</a>`;
        return `<tr${hl}><td class="mwc">${nameCell}</td><td class="mwc">${esc(c.since)}</td><td class="mwc" style="text-align:right;white-space:nowrap">${esc(fmtHourly(c))}</td><td class="mwc" style="text-align:right;white-space:nowrap">${esc(fmtMonthly(c))}</td></tr>`;
      })
      .join('');
    return `<div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px"><table style="width:100%;border-collapse:collapse"><thead><tr><th class="mwd">${esc(L.tableCanton)}</th><th class="mwd">${esc(L.tableLaw)}</th><th class="mwd" style="text-align:right">${esc(L.tableHourly)}</th><th class="mwd" style="text-align:right">${esc(L.tableMonthly)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const faqTitle = L.faqTitle;
  const updatedLine = `<p class="text-sm font-medium text-accent mt-1">${esc(L.updatedLabel)} ${esc(formatUpdatedDate(dateStamp, locale))}</p>`;
  const ctaBlock = `<div class="s-KZc0LQ"><a href="${esc(calcUrl)}" class="s-cta">${esc(L.ctaCalc)}</a></div>`;

  function faqSection(faqs: ReadonlyArray<{ q: string; a: string }>): string {
    const items = faqs
      .map((f) => `<details class="mwf"><summary class="mwfs">${esc(f.q)}</summary><p class="mwfa">${esc(f.a)}</p></details>`)
      .join('');
    return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(faqTitle)}</h2>${items}</section>`;
  }

  function relatedSection(links: ReadonlyArray<{ href: string; label: string }>): string {
    const items = links
      .map((r) => `<li style="margin:4px 0"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`)
      .join('');
    return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(L.relatedLabel)}</h2><ul style="list-style:none;padding:0;margin:0">${items}</ul></section>`;
  }

  let title: string;
  let description: string;
  let eyebrow: string;
  let h1: string;
  let lede: string;
  let mainSections: string;
  let faqs: ReadonlyArray<{ q: string; a: string }>;
  let statTilesHtml: string;
  const isHub = page.kind === 'hub';

  if (page.kind === 'hub') {
    title = L.hub.title(year);
    description = L.hub.description(year);
    eyebrow = L.hub.eyebrow;
    h1 = L.hub.h1(year);
    lede = L.hub.lede(fmtHourly(ge), year);
    faqs = L.hubFaqs;
    statTilesHtml = renderStatGrid([
      { label: L.hub.statHighestLabel, value: fmtHourly(ge), tone: 'accent' },
      { label: L.hub.statLowestLabel, value: fmtHourly(ti), tone: 'success' },
      { label: L.hub.statCountLabel, value: String(cantons.length), tone: 'warning' },
    ]);
    const cclItems = ds.ccls
      .map(
        (ccl) =>
          `<li style="margin:6px 0"><a href="${esc(cclUrl)}" style="${LINK_ACCENT_STYLE}">${esc(ccl.sector[locale])}</a> — ${esc(ccl.cclName)}</li>`,
      )
      .join('');
    mainSections = `
      <section class="s-KZc0LQ"><p style="${BODY_STYLE};max-width:820px">${esc(L.hub.intro)}</p></section>
      <section class="s-KZc0LQ">
        <h2 style="${H2_STYLE}">${esc(L.hub.tableTitle(year))}</h2>
        ${cantonTable()}
      </section>
      <section class="s-KZc0LQ">
        <h2 style="${H2_STYLE}">${esc(L.hub.cclTitle)}</h2>
        <p style="${BODY_STYLE};max-width:820px">${esc(L.hub.cclIntro)}</p>
        <ul style="margin:8px 0 0;padding-left:20px;line-height:1.7">${cclItems}</ul>
        <p style="margin:12px 0 0"><a href="${esc(cclUrl)}" style="${LINK_ACCENT_STYLE}">${esc(L.hub.cclLinkLabel)} →</a></p>
      </section>`;
  } else if (page.kind === 'ccl') {
    title = L.ccl.title(year);
    description = L.ccl.description(year);
    eyebrow = L.ccl.eyebrow;
    h1 = L.ccl.h1(year);
    lede = L.ccl.lede;
    faqs = L.ccl.faqs;
    statTilesHtml = renderStatGrid([
      { label: L.ccl.statSectorsLabel, value: String(ds.ccls.length), tone: 'accent' },
      { label: L.hub.statHighestLabel, value: fmtHourly(ge), tone: 'success' },
      { label: L.hub.statCountLabel, value: String(cantons.length), tone: 'warning' },
    ]);
    const cclCards = ds.ccls
      .map((ccl: CclMinWage) => {
        const rows = ccl.rows
          .map(
            (r) =>
              `<tr><td class="mwc">${esc(r.label[locale])}</td><td class="mwc" style="text-align:right;white-space:nowrap">${esc(fmtCclRow(r.amount, r.unit, locale))}</td></tr>`,
          )
          .join('');
        return `<section class="s-card" style="padding:16px 18px;margin:0 0 14px">
          <h3 style="${H3_STYLE};margin-top:0">${esc(ccl.sector[locale])}</h3>
          <p style="${BODY_STYLE};margin:0 0 6px"><strong>${esc(ccl.cclName)}</strong></p>
          <p style="${BODY_STYLE};margin:0 0 10px;font-size:14px">${esc(L.ccl.scopeLabel)}: ${esc(ccl.scope[locale])}</p>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">${rows}</table></div>
          <p class="mwfa" style="font-size:14px">${esc(ccl.note[locale])}</p>
          <p class="mwsrc">${esc(L.sourceLabel)}: <a href="${esc(ccl.sourceUrl)}" rel="nofollow noopener" style="${LINK_ACCENT_STYLE}">${esc(ccl.source)}</a></p>
        </section>`;
      })
      .join('');
    mainSections = `
      <section class="s-KZc0LQ"><p style="${BODY_STYLE};max-width:820px">${esc(L.ccl.intro)}</p></section>
      <section class="s-KZc0LQ">${cclCards}</section>`;
  } else {
    const c = cantons.find((x) => x.id === page.canton)!;
    const name = c.name[locale];
    const hourly = fmtHourly(c);
    title = L.canton.title(name, year);
    description = L.canton.description(name, hourly, year);
    eyebrow = L.canton.eyebrow;
    h1 = L.canton.h1(name, year);
    lede = L.canton.lede(name, hourly, year);
    faqs = L.canton.faqs(name, hourly, year);
    statTilesHtml = renderStatGrid([
      { label: L.canton.statHourlyLabel, value: hourly, tone: 'accent' },
      { label: L.canton.statMonthlyLabel, value: fmtMonthly(c), tone: 'success' },
      { label: L.canton.statSinceLabel, value: String(c.since), tone: 'warning' },
    ]);
    mainSections = `
      <section class="s-KZc0LQ">
        <p style="${BODY_STYLE};max-width:820px">${esc(c.note[locale])}</p>
      </section>
      <section class="s-KZc0LQ">
        <h2 style="${H2_STYLE}">${esc(L.canton.lawTitle)}</h2>
        <p style="${BODY_STYLE};max-width:820px">${esc(c.law[locale])}.</p>
        <p class="mwsrc">${esc(L.sourceLabel)}: <a href="${esc(c.sourceUrl)}" rel="nofollow noopener" style="${LINK_ACCENT_STYLE}">${esc(c.source)}</a></p>
      </section>
      <section class="s-KZc0LQ">
        <h2 style="${H2_STYLE}">${esc(L.canton.compareTitle)}</h2>
        <p style="${BODY_STYLE};max-width:820px">${esc(L.canton.compareIntro)}</p>
        ${cantonTable(c.id)}
      </section>`;
  }

  // JSON-LD
  const breadcrumbItems: Array<{ '@type': string; position: number; name: string; item: string }> = [
    { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
  ];
  if (isHub) {
    breadcrumbItems.push({ '@type': 'ListItem', position: 2, name: h1, item: canonicalUrl });
  } else {
    breadcrumbItems.push({ '@type': 'ListItem', position: 2, name: L.breadcrumbHub, item: hubUrl });
    breadcrumbItems.push({ '@type': 'ListItem', position: 3, name: h1, item: canonicalUrl });
  }
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbItems,
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  // One description of the hero, used three times: the <img>, `Article.image`
  // and `og:image`. Declared once so all three name the same card — and via
  // `pageKey(page)`, never `String(page)`: that produced "[object Object]" and
  // collapsed all seven pages of this family onto one shared card.
  const hero: SeoHeroImageOpts = {
    family: 'minimum-wage', key: pageKey(page), locale, headline: h1, eyebrow, alt: h1,
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: h1,
    description: guardArticleJsonLdDescription(description),
    image: seoHeroImageObject(hero),
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({ url: `${BASE_URL}/icons/icon-512x512.png`, width: 512, height: 512 }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  };

  // Related links — cross-link hub / ccl / guide / calculator.
  const relatedLinks: Array<{ href: string; label: string }> = [];
  if (!isHub) relatedLinks.push({ href: hubUrl, label: L.hub.h1(year) });
  if (page.kind !== 'ccl') relatedLinks.push({ href: cclUrl, label: L.ccl.h1(year) });
  relatedLinks.push({ href: guideUrl, label: L.ctaGuide });
  relatedLinks.push({ href: calcUrl, label: L.ctaCalc.replace(' →', '') });

  const breadcrumbNav = isHub
    ? `<nav class="s-bcr"><a href="${esc(homeUrl)}" class="s-bcl">${esc(L.breadcrumbHome)}</a><span> / </span><span>${esc(h1)}</span></nav>`
    : `<nav class="s-bcr"><a href="${esc(homeUrl)}" class="s-bcl">${esc(L.breadcrumbHome)}</a><span> / </span><a href="${esc(hubUrl)}" class="s-bcl">${esc(L.breadcrumbHub)}</a><span> / </span><span>${esc(h1)}</span></nav>`;

  const body = `
    ${styleBlock}
    ${breadcrumbNav}
    <header>
      <p style="${HERO_EYEBROW_STYLE}">${esc(eyebrow)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(lede)}</p>
    </header>
    ${renderSeoHeroImage(hero)}
    ${updatedLine}
    ${statTilesHtml}
    ${ctaBlock}
    ${mainSections}
    ${faqSection(faqs)}
    ${relatedSection(relatedLinks)}`;

  const wordCount = countHtmlBodyWords(body);
  const indexable = wordCount >= MIN_INDEXABLE_WORDS;
  // End-of-content multiplex ONLY on the hub (index) page, gated on
  // index,follow — leaf/detail pages keep Auto Ads only.
  const multiplex = isHub ? endOfContentMultiplexHtml({ indexable }) : '';
  const bodyHtml = `<main class="s-xzWvwM">${body}${multiplex}</main>`;

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: indexable ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    ogImage: seoHeroImageUrl(hero),
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: h1,
    hreflangHtml: alternates,
    jsonLdScripts: [
      JSON.stringify(breadcrumbLd),
      JSON.stringify(articleLd),
      JSON.stringify(faqLd),
    ],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────────────

function buildSitemapXml(
  entries: ReadonlyArray<{ canonical: string; alternates: readonly string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => {
          const [lang, ...rest] = a.split('|');
          return `    <xhtml:link rel="alternate" hreflang="${lang}" href="${rest.join('|')}" />`;
        })
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-minimum-wage.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-minimum-wage.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-minimum-wage\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[minimum-wage] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ────────────────────────────────────────────────────────────

export function minimumWageLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'minimum-wage-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_MINWAGE === '1') {
        console.log('\x1b[33m[minimum-wage]\x1b[0m Skipped (SKIP_MINWAGE=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'minimumWageLandingsPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: readonly string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const page of MINWAGE_PAGES) {
        // ── Pass 1: which locales clear the indexability floor? ────────────
        // The floor is per-locale AND per page, so it can drop DE while
        // keeping IT for the same page. Settling the set BEFORE any page is
        // rendered for real is what makes it impossible to advertise a
        // landing that never gets written (#5114 class). `wordCount` derives
        // from the body alone, so this pass is unaffected by the empty
        // hreflang block it renders with.
        const eligibleLocales = new Set<string>(
          MINWAGE_LOCALES.filter(
            (locale) =>
              renderPage({ locale, page, dateStamp, distDir }).wordCount >= MIN_INDEXABLE_WORDS,
          ),
        );

        // Sitemap alternates track the same set: an ineligible locale has no
        // page, so advertising it would point the crawler at a 404.
        const altLinks = MINWAGE_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildMinWageLandingPath(alt, page)}`,
        );
        if (eligibleLocales.has('it')) {
          altLinks.push(`x-default|${BASE_URL}${buildMinWageLandingPath('it', page)}`);
        }

        // ── Pass 2: render for real, with the settled alternate set ────────
        for (const locale of MINWAGE_LOCALES) {
          const rendered = renderPage({ locale, page, dateStamp, distDir, eligibleLocales });
          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[minimum-wage]\x1b[0m ${locale}/${pageKey(page)} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }
          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);
          sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          fs.writeFileSync(
            np.join(distDir, 'sitemap-minimum-wage.xml'),
            buildSitemapXml(sitemapEntries, dateStamp),
            'utf-8',
          );
        } catch (err) {
          console.warn('\x1b[33m[minimum-wage]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[minimum-wage]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} thin-skipped) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      if (fs.existsSync(np.join(distDir, 'sitemap-minimum-wage.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}

// Test-only export.
export { renderPage as __renderMinWagePageForTest };
