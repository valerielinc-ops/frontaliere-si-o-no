/**
 * BFS salary-by-age / salary-by-education landings (#4481) — Vite build plugin.
 *
 * Emits 36 static HTML pages:
 *   - 5 anchor ages (20/30/40/50/60) × 4 locales = 20 pages
 *   - 4 education levels × 4 locales             = 16 pages
 *
 * All numbers come from data/seo/bfs-salary-by-age.json (BFS LSE, STAT-TAB) —
 * refreshed by scripts/update-bfs-salary-by-age.mjs. Curated fixed set, no
 * floor/threshold loop → no below-floor bridge / searchConsoleCompat self-map.
 *
 * Every page's primary CTA points at the net-salary calculator. Pattern mirrors
 * costOfLivingLandingsPlugin. Env gate: SKIP_BFS_SALARY=1 fast-exits.
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname_bfs = np.dirname(fileURLToPath(import.meta.url));

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { CALC_HREF } from './shared/calcHref';
import { formatUpdatedDate } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import { resolveBfsSalaryFlushed } from './shared/buildSignals';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import {
  SALARY_LOCALES,
  SALARY_AGE_ANCHORS,
  SALARY_EDUCATION_IDS,
  buildSalaryAgeLandingPath,
  buildSalaryEducationLandingPath,
  type SalaryLocale,
  type SalaryAgeAnchor,
  type SalaryEducationId,
  type BfsSalaryDataset,
  type BfsAgeBand,
} from './bfsSalaryLandingsData';
import {
  H1_STYLE,
  H2_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  HERO_EYEBROW_STYLE,
  LINK_ACCENT_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<SalaryLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

// Net-salary calculator path per locale — shared single source of truth
// (build-plugins/shared/calcHref.ts), not a local duplicate.
const CALCULATOR_URL = CALC_HREF;

/** Swiss thousands separator: CHF 6'600. */
function chf(n: number): string {
  return `≈ CHF ${Math.round(n).toLocaleString('de-CH').replace(/[,.]/g, '’')}`;
}

// ── Dataset ─────────────────────────────────────────────────────────────────

let _dataset: BfsSalaryDataset | null = null;
function loadDataset(): BfsSalaryDataset {
  if (_dataset) return _dataset;
  const dataPath = np.resolve(__dirname_bfs, '..', 'data', 'seo', 'bfs-salary-by-age.json');
  _dataset = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as BfsSalaryDataset;
  return _dataset;
}

function bandForAge(ds: BfsSalaryDataset, age: number): BfsAgeBand {
  const exact = ds.ageBands.find((b) => b.anchorAges.includes(age));
  if (exact) return exact;
  // Defensive fallback: closest band by midpoint (never expected to fire —
  // every SALARY_AGE_ANCHOR is listed in some band's anchorAges).
  return ds.ageBands[Math.min(ds.ageBands.length - 1, 0)];
}

// ── Locale copy ──────────────────────────────────────────────────────────────

interface SalaryCopy {
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly breadcrumbHubPath: string;
  readonly updatedLabel: string;
  readonly ctaCalc: string;
  readonly relatedLabel: string;
  readonly faqTitle: string;
  readonly sourceNote: (wave: number) => string;
  readonly statMedianLabel: string;
  readonly statNationalLabel: string;
  readonly statDeltaLabel: string;
  readonly age: {
    eyebrow: string;
    title: (age: number) => string;
    description: (age: number, median: string) => string;
    h1: (age: number) => string;
    lede: (age: number, median: string, band: string) => string;
    intro: (age: number, band: string, median: string, national: string) => string;
    bandUnit: (band: string) => string;
    faq: (age: number, median: string) => ReadonlyArray<{ q: string; a: string }>;
    ctaLine: string;
  };
  readonly edu: {
    eyebrow: string;
    title: (level: string) => string;
    description: (level: string, median: string) => string;
    h1: (level: string) => string;
    lede: (level: string, median: string) => string;
    intro: (level: string, median: string, national: string) => string;
    faq: (level: string, median: string) => ReadonlyArray<{ q: string; a: string }>;
    ctaLine: string;
  };
}

const COPY: Record<SalaryLocale, SalaryCopy> = {
  it: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Calcolatore stipendio',
    breadcrumbHubPath: '/calcola-stipendio/',
    updatedLabel: 'Dati',
    ctaCalc: 'Calcola il tuo stipendio netto →',
    relatedLabel: 'Approfondisci',
    faqTitle: 'Domande frequenti',
    sourceNote: (w) =>
      `Fonte: BFS/UST — Rilevazione svizzera della struttura dei salari (RSS) ${w}. Valore mediano lordo mensile, standardizzato, economia totale (settore privato e pubblico). Valori indicativi.`,
    statMedianLabel: 'Salario mediano',
    statNationalLabel: 'Mediana nazionale',
    statDeltaLabel: 'Rispetto alla media',
    age: {
      eyebrow: 'Stipendi in Svizzera',
      title: (a) => `Stipendio medio in Svizzera a ${a} anni`,
      description: (a, m) =>
        `Quanto si guadagna in Svizzera a ${a} anni: salario mediano ${m} al mese (dati BFS). Confronto con la media nazionale e calcolo del netto.`,
      h1: (a) => `Stipendio medio in Svizzera a ${a} anni`,
      lede: (a, m, band) =>
        `A ${a} anni (fascia ${band}) il salario mediano lordo in Svizzera è ${m} al mese secondo i dati BFS. Ecco il confronto e come calcolare il tuo netto.`,
      intro: (a, band, m, nat) =>
        `Il salario in Svizzera cresce con l’età e l’esperienza. Per la fascia ${band} anni la Rilevazione della struttura dei salari indica un valore mediano lordo di ${m} al mese, contro una mediana nazionale di ${nat} su tutte le età. "Mediano" significa che metà dei lavoratori guadagna meno e metà di più: è un riferimento più realistico della media, meno influenzato dagli stipendi molto alti. Il dato è lordo e standardizzato; per stimare quanto ti resterebbe in tasca come frontaliere, dopo contributi e imposta alla fonte, usa il calcolatore.`,
      bandUnit: (band) => `fascia ${band} anni`,
      faq: (a, m) => [
        {
          q: `Quanto guadagna in media una persona di ${a} anni in Svizzera?`,
          a: `Il salario mediano lordo per questa fascia d’età è di circa ${m} al mese secondo i dati BFS. È un valore su tutta l’economia; il salario reale varia per professione, cantone, settore e livello di formazione.`,
        },
        {
          q: 'Questo importo è lordo o netto?',
          a: 'È il salario lordo mediano mensile. Il netto dipende dai contributi sociali e, per i frontalieri, dall’imposta alla fonte: usa il calcolatore per una stima personalizzata del netto.',
        },
      ],
      ctaLine:
        'Vuoi sapere quanto ti resterebbe come frontaliere? Calcola il netto in base al cantone e alla tua situazione.',
    },
    edu: {
      eyebrow: 'Stipendi in Svizzera',
      title: (l) => `Stipendio in Svizzera con ${l.toLowerCase()}`,
      description: (l, m) =>
        `Quanto si guadagna in Svizzera con ${l.toLowerCase()}: salario mediano lordo ${m} al mese (dati BFS). Confronto con la media nazionale e calcolo del netto.`,
      h1: (l) => `Stipendio in Svizzera con ${l.toLowerCase()}`,
      lede: (l, m) =>
        `Con ${l.toLowerCase()} il salario mediano lordo in Svizzera è ${m} al mese secondo i dati BFS. Ecco il confronto e come calcolare il netto da frontaliere.`,
      intro: (l, m, nat) =>
        `Il livello di formazione è uno dei fattori che più incidono sullo stipendio in Svizzera. Per chi ha ${l.toLowerCase()} la Rilevazione della struttura dei salari indica un valore mediano lordo di ${m} al mese, contro una mediana nazionale di ${nat}. Il dato è lordo, standardizzato e riferito all’intera economia: il salario effettivo dipende anche da professione, cantone ed esperienza. Per stimare il netto da frontaliere, dopo contributi e imposta alla fonte, usa il calcolatore.`,
      faq: (l, m) => [
        {
          q: `Quanto si guadagna in Svizzera con ${l.toLowerCase()}?`,
          a: `Il salario mediano lordo è di circa ${m} al mese secondo i dati BFS. È un riferimento su tutta l’economia; l’importo reale cambia per professione, settore e cantone.`,
        },
        {
          q: 'Il valore è lordo o netto?',
          a: 'È il salario lordo mediano mensile. Per il netto da frontaliere (contributi + imposta alla fonte) usa il calcolatore.',
        },
      ],
      ctaLine:
        'Scopri quanto ti resterebbe netto come frontaliere in base al cantone e alla tua situazione.',
    },
  },
  en: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Salary calculator',
    breadcrumbHubPath: '/en/calculate-salary/',
    updatedLabel: 'Data',
    ctaCalc: 'Calculate your net salary →',
    relatedLabel: 'Read more',
    faqTitle: 'Frequently asked questions',
    sourceNote: (w) =>
      `Source: BFS/FSO — Swiss Earnings Structure Survey (LSE) ${w}. Median gross monthly wage, standardised, total economy (private + public sector). Indicative values.`,
    statMedianLabel: 'Median wage',
    statNationalLabel: 'National median',
    statDeltaLabel: 'Vs. average',
    age: {
      eyebrow: 'Salaries in Switzerland',
      title: (a) => `Average salary in Switzerland at age ${a}`,
      description: (a, m) =>
        `How much you earn in Switzerland at age ${a}: median wage ${m} per month (BFS data). Comparison with the national median and net-salary calculation.`,
      h1: (a) => `Average salary in Switzerland at age ${a}`,
      lede: (a, m, band) =>
        `At age ${a} (${band} band) the median gross wage in Switzerland is ${m} per month according to BFS data. Here is the comparison and how to work out your net.`,
      intro: (a, band, m, nat) =>
        `Pay in Switzerland rises with age and experience. For the ${band} age band the Earnings Structure Survey reports a median gross wage of ${m} per month, against a national median of ${nat} across all ages. "Median" means half of workers earn less and half earn more — a more realistic reference than the average, less skewed by very high salaries. The figure is gross and standardised; to estimate what you would actually keep as a cross-border worker, after social contributions and withholding tax, use the calculator.`,
      bandUnit: (band) => `${band} age band`,
      faq: (a, m) => [
        {
          q: `How much does a ${a}-year-old earn on average in Switzerland?`,
          a: `The median gross wage for this age band is about ${m} per month according to BFS data. It covers the whole economy; actual pay varies by occupation, canton, sector and education.`,
        },
        {
          q: 'Is this gross or net?',
          a: 'It is the median gross monthly wage. Net pay depends on social contributions and, for cross-border workers, on withholding tax: use the calculator for a personalised net estimate.',
        },
      ],
      ctaLine:
        'Want to know what you would keep as a cross-border worker? Work out the net by canton and your situation.',
    },
    edu: {
      eyebrow: 'Salaries in Switzerland',
      title: (l) => `Salary in Switzerland with ${l.toLowerCase()}`,
      description: (l, m) =>
        `How much you earn in Switzerland with ${l.toLowerCase()}: median gross wage ${m} per month (BFS data). Comparison with the national median and net calculation.`,
      h1: (l) => `Salary in Switzerland with ${l.toLowerCase()}`,
      lede: (l, m) =>
        `With ${l.toLowerCase()} the median gross wage in Switzerland is ${m} per month according to BFS data. Here is the comparison and how to work out your cross-border net.`,
      intro: (l, m, nat) =>
        `Education level is one of the strongest drivers of pay in Switzerland. For ${l.toLowerCase()} the Earnings Structure Survey reports a median gross wage of ${m} per month, against a national median of ${nat}. The figure is gross, standardised and covers the whole economy: actual pay also depends on occupation, canton and experience. To estimate your cross-border net, after contributions and withholding tax, use the calculator.`,
      faq: (l, m) => [
        {
          q: `How much do you earn in Switzerland with ${l.toLowerCase()}?`,
          a: `The median gross wage is about ${m} per month according to BFS data. It is a whole-economy reference; the real amount changes by occupation, sector and canton.`,
        },
        {
          q: 'Is the value gross or net?',
          a: 'It is the median gross monthly wage. For the cross-border net (contributions + withholding tax) use the calculator.',
        },
      ],
      ctaLine:
        'Find out what you would keep net as a cross-border worker, based on the canton and your situation.',
    },
  },
  de: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Lohnrechner',
    breadcrumbHubPath: '/de/gehalt-berechnen/',
    updatedLabel: 'Daten',
    ctaCalc: 'Nettolohn berechnen →',
    relatedLabel: 'Mehr erfahren',
    faqTitle: 'Häufige Fragen',
    sourceNote: (w) =>
      `Quelle: BFS — Schweizerische Lohnstrukturerhebung (LSE) ${w}. Medianer Bruttomonatslohn, standardisiert, Gesamtwirtschaft (privater und öffentlicher Sektor). Richtwerte.`,
    statMedianLabel: 'Medianlohn',
    statNationalLabel: 'Nationaler Median',
    statDeltaLabel: 'Ggü. Durchschnitt',
    age: {
      eyebrow: 'Löhne in der Schweiz',
      title: (a) => `Durchschnittslohn in der Schweiz mit ${a} Jahren`,
      description: (a, m) =>
        `Wie viel man in der Schweiz mit ${a} Jahren verdient: Medianlohn ${m} pro Monat (BFS-Daten). Vergleich mit dem nationalen Median und Nettolohn-Berechnung.`,
      h1: (a) => `Durchschnittslohn in der Schweiz mit ${a} Jahren`,
      lede: (a, m, band) =>
        `Mit ${a} Jahren (Klasse ${band}) liegt der mediane Bruttolohn in der Schweiz laut BFS bei ${m} pro Monat. Hier der Vergleich und wie Sie Ihren Netto berechnen.`,
      intro: (a, band, m, nat) =>
        `Der Lohn in der Schweiz steigt mit Alter und Erfahrung. Für die Altersklasse ${band} weist die Lohnstrukturerhebung einen medianen Bruttolohn von ${m} pro Monat aus, gegenüber einem nationalen Median von ${nat} über alle Altersklassen. "Median" bedeutet, dass die Hälfte weniger und die Hälfte mehr verdient — ein realistischerer Bezug als der Durchschnitt, weniger durch sehr hohe Löhne verzerrt. Der Wert ist brutto und standardisiert; um zu schätzen, was Ihnen als Grenzgänger nach Sozialabgaben und Quellensteuer bleibt, nutzen Sie den Rechner.`,
      bandUnit: (band) => `Altersklasse ${band}`,
      faq: (a, m) => [
        {
          q: `Wie viel verdient man in der Schweiz mit ${a} Jahren im Durchschnitt?`,
          a: `Der mediane Bruttolohn für diese Altersklasse liegt laut BFS bei rund ${m} pro Monat. Er umfasst die gesamte Wirtschaft; der tatsächliche Lohn variiert nach Beruf, Kanton, Branche und Ausbildung.`,
        },
        {
          q: 'Ist das brutto oder netto?',
          a: 'Es ist der mediane Bruttomonatslohn. Der Nettolohn hängt von den Sozialabgaben und für Grenzgänger von der Quellensteuer ab: für eine persönliche Schätzung nutzen Sie den Rechner.',
        },
      ],
      ctaLine:
        'Möchten Sie wissen, was Ihnen als Grenzgänger bleibt? Berechnen Sie den Netto nach Kanton und Situation.',
    },
    edu: {
      eyebrow: 'Löhne in der Schweiz',
      title: (l) => `Lohn in der Schweiz mit ${l}`,
      description: (l, m) =>
        `Wie viel man in der Schweiz mit ${l} verdient: medianer Bruttolohn ${m} pro Monat (BFS-Daten). Vergleich mit dem nationalen Median und Netto-Berechnung.`,
      h1: (l) => `Lohn in der Schweiz mit ${l}`,
      lede: (l, m) =>
        `Mit ${l} liegt der mediane Bruttolohn in der Schweiz laut BFS bei ${m} pro Monat. Hier der Vergleich und wie Sie Ihren Grenzgänger-Netto berechnen.`,
      intro: (l, m, nat) =>
        `Das Ausbildungsniveau ist einer der stärksten Lohntreiber in der Schweiz. Für ${l} weist die Lohnstrukturerhebung einen medianen Bruttolohn von ${m} pro Monat aus, gegenüber einem nationalen Median von ${nat}. Der Wert ist brutto, standardisiert und umfasst die Gesamtwirtschaft: der tatsächliche Lohn hängt auch von Beruf, Kanton und Erfahrung ab. Für den Grenzgänger-Netto nach Abgaben und Quellensteuer nutzen Sie den Rechner.`,
      faq: (l, m) => [
        {
          q: `Wie viel verdient man in der Schweiz mit ${l}?`,
          a: `Der mediane Bruttolohn liegt laut BFS bei rund ${m} pro Monat. Es ist ein gesamtwirtschaftlicher Bezug; der reale Betrag ändert sich nach Beruf, Branche und Kanton.`,
        },
        {
          q: 'Ist der Wert brutto oder netto?',
          a: 'Es ist der mediane Bruttomonatslohn. Für den Grenzgänger-Netto (Abgaben + Quellensteuer) nutzen Sie den Rechner.',
        },
      ],
      ctaLine:
        'Finden Sie heraus, was Ihnen als Grenzgänger netto bleibt — je nach Kanton und Situation.',
    },
  },
  fr: {
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Calculateur de salaire',
    breadcrumbHubPath: '/fr/calculer-salaire/',
    updatedLabel: 'Données',
    ctaCalc: 'Calculez votre salaire net →',
    relatedLabel: 'Pour aller plus loin',
    faqTitle: 'Questions fréquentes',
    sourceNote: (w) =>
      `Source : OFS — Enquête suisse sur la structure des salaires (ESS) ${w}. Salaire brut mensuel médian, standardisé, économie totale (secteur privé et public). Valeurs indicatives.`,
    statMedianLabel: 'Salaire médian',
    statNationalLabel: 'Médiane nationale',
    statDeltaLabel: 'Vs moyenne',
    age: {
      eyebrow: 'Salaires en Suisse',
      title: (a) => `Salaire moyen en Suisse à ${a} ans`,
      description: (a, m) =>
        `Combien on gagne en Suisse à ${a} ans : salaire médian ${m} par mois (données OFS). Comparaison avec la médiane nationale et calcul du net.`,
      h1: (a) => `Salaire moyen en Suisse à ${a} ans`,
      lede: (a, m, band) =>
        `À ${a} ans (tranche ${band}) le salaire brut médian en Suisse est de ${m} par mois selon les données OFS. Voici la comparaison et comment calculer votre net.`,
      intro: (a, band, m, nat) =>
        `Le salaire en Suisse augmente avec l’âge et l’expérience. Pour la tranche d’âge ${band} ans, l’Enquête sur la structure des salaires indique un salaire brut médian de ${m} par mois, contre une médiane nationale de ${nat} tous âges confondus. "Médian" signifie que la moitié des salariés gagne moins et l’autre moitié plus — une référence plus réaliste que la moyenne, moins tirée par les très hauts salaires. La valeur est brute et standardisée ; pour estimer ce qui vous resterait comme frontalier, après cotisations et impôt à la source, utilisez le calculateur.`,
      bandUnit: (band) => `tranche ${band} ans`,
      faq: (a, m) => [
        {
          q: `Combien gagne en moyenne une personne de ${a} ans en Suisse ?`,
          a: `Le salaire brut médian pour cette tranche d’âge est d’environ ${m} par mois selon les données OFS. Il couvre toute l’économie ; le salaire réel varie selon la profession, le canton, la branche et la formation.`,
        },
        {
          q: 'Ce montant est-il brut ou net ?',
          a: 'C’est le salaire brut mensuel médian. Le net dépend des cotisations sociales et, pour les frontaliers, de l’impôt à la source : utilisez le calculateur pour une estimation personnalisée du net.',
        },
      ],
      ctaLine:
        'Vous voulez savoir ce qui vous resterait comme frontalier ? Calculez le net selon le canton et votre situation.',
    },
    edu: {
      eyebrow: 'Salaires en Suisse',
      title: (l) => `Salaire en Suisse avec ${l.toLowerCase()}`,
      description: (l, m) =>
        `Combien on gagne en Suisse avec ${l.toLowerCase()} : salaire brut médian ${m} par mois (données OFS). Comparaison avec la médiane nationale et calcul du net.`,
      h1: (l) => `Salaire en Suisse avec ${l.toLowerCase()}`,
      lede: (l, m) =>
        `Avec ${l.toLowerCase()} le salaire brut médian en Suisse est de ${m} par mois selon les données OFS. Voici la comparaison et comment calculer votre net de frontalier.`,
      intro: (l, m, nat) =>
        `Le niveau de formation est l’un des facteurs qui pèsent le plus sur le salaire en Suisse. Pour ${l.toLowerCase()}, l’Enquête sur la structure des salaires indique un salaire brut médian de ${m} par mois, contre une médiane nationale de ${nat}. La valeur est brute, standardisée et couvre toute l’économie : le salaire réel dépend aussi de la profession, du canton et de l’expérience. Pour estimer votre net de frontalier, après cotisations et impôt à la source, utilisez le calculateur.`,
      faq: (l, m) => [
        {
          q: `Combien gagne-t-on en Suisse avec ${l.toLowerCase()} ?`,
          a: `Le salaire brut médian est d’environ ${m} par mois selon les données OFS. C’est une référence pour toute l’économie ; le montant réel change selon la profession, la branche et le canton.`,
        },
        {
          q: 'La valeur est-elle brute ou nette ?',
          a: 'C’est le salaire brut mensuel médian. Pour le net de frontalier (cotisations + impôt à la source), utilisez le calculateur.',
        },
      ],
      ctaLine:
        'Découvrez ce qui vous resterait net comme frontalier, selon le canton et votre situation.',
    },
  },
};

// ── Render ────────────────────────────────────────────────────────────────

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function deltaTile(median: number, national: number): { value: string; tone: 'success' | 'warning' } {
  const pct = Math.round(((median - national) / national) * 100);
  return { value: `${pct >= 0 ? '+' : ''}${pct}%`, tone: pct >= 0 ? 'success' : 'warning' };
}

function renderCommon(opts: {
  locale: SalaryLocale;
  urlPath: string;
  h1: string;
  title: string;
  description: string;
  eyebrow: string;
  lede: string;
  intro: string;
  median: number;
  national: number;
  faqs: ReadonlyArray<{ q: string; a: string }>;
  ctaLine: string;
  alternates: string;
  dateStamp: string;
  distDir?: string;
  relatedLinks: ReadonlyArray<{ href: string; label: string }>;
}): RenderResult {
  const {
    locale, urlPath, h1, title, description, eyebrow, lede, intro,
    median, national, faqs, ctaLine, alternates, dateStamp, distDir, relatedLinks,
  } = opts;
  const L = COPY[locale];
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubUrl = `${BASE_URL}${L.breadcrumbHubPath}`;
  const calcUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;
  const delta = deltaTile(median, national);

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: L.breadcrumbHub, item: hubUrl },
      { '@type': 'ListItem', position: 3, name: h1, item: canonicalUrl },
    ],
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
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: h1,
    description: guardArticleJsonLdDescription(description),
    image: `${BASE_URL}/og-image.png`,
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

  const styleBlock = `<style>.sf{margin:0 0 10px;padding:14px 16px;background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:12px}.sfs{font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45}.sfa{margin:10px 0 0;color:var(--color-body);line-height:1.65}</style>`;

  const statTilesHtml = renderStatGrid([
    { label: L.statMedianLabel, value: chf(median), tone: 'accent' },
    { label: L.statNationalLabel, value: chf(national), tone: 'neutral' },
    { label: L.statDeltaLabel, value: delta.value, tone: delta.tone },
  ]);

  const faqHtml = faqs
    .map((f) => `<details class="sf"><summary class="sfs">${esc(f.q)}</summary><p class="sfa">${esc(f.a)}</p></details>`)
    .join('');

  const relatedHtml = relatedLinks
    .map((r) => `<li style="margin:4px 0"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`)
    .join('');

  const body = `
    ${styleBlock}
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(L.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubUrl)}" class="s-bcl">${esc(L.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(h1)}</span>
    </nav>
    <header>
      <p style="${HERO_EYEBROW_STYLE}">${esc(eyebrow)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(lede)}</p>
    </header>
    <p class="text-sm font-medium text-accent mt-1">${esc(L.updatedLabel)}: ${esc(formatUpdatedDate(dateStamp, locale))}</p>
    ${statTilesHtml}
    <div class="s-KZc0LQ"><a href="${esc(calcUrl)}" class="s-cta">${esc(L.ctaCalc)}</a></div>
    <section class="s-KZc0LQ">
      <p style="${BODY_STYLE};max-width:820px">${esc(intro)}</p>
    </section>
    <section class="s-KZc0LQ">
      <p style="${BODY_STYLE};max-width:820px">${esc(ctaLine)}</p>
      <p style="margin-top:10px"><a href="${esc(calcUrl)}" class="s-cta">${esc(L.ctaCalc)}</a></p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <section class="s-KZc0LQ">
      <p style="${BODY_STYLE};max-width:820px;font-size:13px;opacity:.85">${esc(L.sourceNote(loadDataset().meta.waveYear))}</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.relatedLabel)}</h2>
      <ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul>
    </section>`;

  const bodyHtml = `<main class="s-xzWvwM">${body}</main>`;
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(articleLd), JSON.stringify(faqLd)],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

function renderAgePage(opts: {
  locale: SalaryLocale;
  age: SalaryAgeAnchor;
  dateStamp: string;
  distDir?: string;
  /**
   * Locales whose page for THIS age anchor the build will actually write. The
   * `MIN_INDEXABLE_WORDS` floor in `emit()` is evaluated per (anchor, locale),
   * so it can drop DE while keeping IT — and an hreflang block built from the
   * full locale list would then advertise a page nothing wrote (the #5114
   * class). Pass 1 of the caller's two-pass render supplies an empty set: it
   * only needs `wordCount`, which is computed from the body and does not
   * depend on the hreflang block.
   */
  eligibleLocales?: ReadonlySet<string>;
}): RenderResult {
  const { locale, age, dateStamp, distDir, eligibleLocales = new Set<string>() } = opts;
  const ds = loadDataset();
  const L = COPY[locale];
  const band = bandForAge(ds, age);
  const median = band.medianChf;
  const national = ds.nationalMedianChf;
  const medianFmt = chf(median);
  const nationalFmt = chf(national);
  const bandLabel = band.label;

  const urlPath = buildSalaryAgeLandingPath(locale, age);
  // Hreflang (4 locales + x-default), emitted only when every locale's page
  // for this anchor is actually written this build — otherwise nothing, since
  // a partial set trades audit-hreflang's [missingTarget] for [tooFew] (#5114).
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildSalaryAgeLandingPath(alt as SalaryLocale, age)}`,
    indent: '    ',
  });

  // Related: neighbouring age pages + calculator.
  const others = SALARY_AGE_ANCHORS.filter((a) => a !== age).slice(0, 3);
  const related = others.map((a) => ({
    href: `${BASE_URL}${buildSalaryAgeLandingPath(locale, a)}`,
    label: L.age.title(a),
  }));

  return renderCommon({
    locale,
    urlPath,
    h1: L.age.h1(age),
    title: L.age.title(age),
    description: L.age.description(age, medianFmt),
    eyebrow: L.age.eyebrow,
    lede: L.age.lede(age, medianFmt, bandLabel),
    intro: L.age.intro(age, bandLabel, medianFmt, nationalFmt),
    median,
    national,
    faqs: L.age.faq(age, medianFmt),
    ctaLine: L.age.ctaLine,
    alternates,
    dateStamp,
    distDir,
    relatedLinks: related,
  });
}

function renderEducationPage(opts: {
  locale: SalaryLocale;
  eduId: SalaryEducationId;
  dateStamp: string;
  distDir?: string;
  /** Same contract as {@link renderAgePage}, per education level (#5114). */
  eligibleLocales?: ReadonlySet<string>;
}): RenderResult {
  const { locale, eduId, dateStamp, distDir, eligibleLocales = new Set<string>() } = opts;
  const ds = loadDataset();
  const L = COPY[locale];
  const level = ds.educationLevels.find((e) => e.id === eduId);
  if (!level) throw new Error(`[bfs-salary] unknown education level ${eduId}`);
  const median = level.medianChf;
  const national = ds.nationalMedianChf;
  const medianFmt = chf(median);
  const nationalFmt = chf(national);
  const levelName = level.name[locale];

  const urlPath = buildSalaryEducationLandingPath(locale, eduId);
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildSalaryEducationLandingPath(alt as SalaryLocale, eduId)}`,
    indent: '    ',
  });

  const others = SALARY_EDUCATION_IDS.filter((e) => e !== eduId).slice(0, 3);
  const related = others.map((e) => {
    const lv = ds.educationLevels.find((x) => x.id === e)!;
    return { href: `${BASE_URL}${buildSalaryEducationLandingPath(locale, e)}`, label: L.edu.title(lv.name[locale]) };
  });

  return renderCommon({
    locale,
    urlPath,
    h1: L.edu.h1(levelName),
    title: L.edu.title(levelName),
    description: L.edu.description(levelName, medianFmt),
    eyebrow: L.edu.eyebrow,
    lede: L.edu.lede(levelName, medianFmt),
    intro: L.edu.intro(levelName, medianFmt, nationalFmt),
    median,
    national,
    faqs: L.edu.faq(levelName, medianFmt),
    ctaLine: L.edu.ctaLine,
    alternates,
    dateStamp,
    distDir,
    relatedLinks: related,
  });
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
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-bfs-salary.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-bfs-salary.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-bfs-salary\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[bfs-salary] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ────────────────────────────────────────────────────────────

export function bfsSalaryLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'bfs-salary-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_BFS_SALARY === '1') {
        console.log('\x1b[33m[bfs-salary]\x1b[0m Skipped (SKIP_BFS_SALARY=1)');
        resolveBfsSalaryFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveBfsSalaryFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'bfsSalaryLandingsPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: readonly string[] }> = [];
      const emittedPaths: string[] = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      const emit = (rendered: RenderResult, altLinks: readonly string[], isIt: boolean, itSeen: () => boolean, markIt: () => void) => {
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
          thinSkipped++;
          console.warn(`\x1b[33m[bfs-salary]\x1b[0m ${rendered.urlPath} thin (${rendered.wordCount}) — skipping`);
          return;
        }
        const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);
        if (isIt) {
          markIt();
          sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
        } else if (itSeen()) {
          sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
        }
        emittedPaths.push(rendered.urlPath);
        pagesWritten++;
      };

      // Age pages
      for (const age of SALARY_AGE_ANCHORS) {
        // Pass 1: which locales clear the indexability floor for THIS anchor?
        // The floor is per (anchor, locale), so it can drop DE while keeping
        // IT; settling it before any page is written is what makes it
        // impossible to advertise a page nothing writes (#5114). `wordCount`
        // is derived from the body alone, so the empty hreflang block this
        // pass renders with does not perturb it.
        const eligibleLocales = new Set<string>(
          SALARY_LOCALES.filter(
            (alt) => renderAgePage({ locale: alt, age, dateStamp, distDir }).wordCount >= MIN_INDEXABLE_WORDS,
          ),
        );
        // Sitemap alternates track the same set: an ineligible locale has no
        // page, so advertising it would point the crawler at a 404.
        const altLinks = SALARY_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildSalaryAgeLandingPath(alt, age)}`,
        );
        if (eligibleLocales.has('it')) {
          altLinks.push(`x-default|${BASE_URL}${buildSalaryAgeLandingPath('it', age)}`);
        }
        let itWritten = false;
        // Pass 2: render for real, with the settled alternate set.
        for (const locale of SALARY_LOCALES) {
          emit(renderAgePage({ locale, age, dateStamp, distDir, eligibleLocales }), altLinks, locale === 'it', () => itWritten, () => { itWritten = true; });
        }
      }
      // Education pages
      for (const eduId of SALARY_EDUCATION_IDS) {
        // Same two-pass shape as the age loop above, per education level (#5114).
        const eligibleLocales = new Set<string>(
          SALARY_LOCALES.filter(
            (alt) => renderEducationPage({ locale: alt, eduId, dateStamp, distDir }).wordCount >= MIN_INDEXABLE_WORDS,
          ),
        );
        const altLinks = SALARY_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildSalaryEducationLandingPath(alt, eduId)}`,
        );
        if (eligibleLocales.has('it')) {
          altLinks.push(`x-default|${BASE_URL}${buildSalaryEducationLandingPath('it', eduId)}`);
        }
        let itWritten = false;
        for (const locale of SALARY_LOCALES) {
          emit(renderEducationPage({ locale, eduId, dateStamp, distDir, eligibleLocales }), altLinks, locale === 'it', () => itWritten, () => { itWritten = true; });
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          fs.writeFileSync(np.join(distDir, 'sitemap-bfs-salary.xml'), buildSitemapXml(sitemapEntries, dateStamp), 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[bfs-salary]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[bfs-salary]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} thin-skipped) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      if (fs.existsSync(np.join(distDir, 'sitemap-bfs-salary.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
      resolveBfsSalaryFlushed(emittedPaths);
    },
  };
}

// Test-only exports.
export {
  renderAgePage as __renderAgePageForTest,
  renderEducationPage as __renderEducationPageForTest,
};
