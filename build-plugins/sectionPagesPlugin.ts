/**
 * Section / topic SSR pages — Vite build plugin (C3 Google News compliance).
 *
 * Emits 28 static HTML pages (7 sections × 4 locales) that aggregate the
 * latest blog articles by topic area. Google News requires section pages to
 * be server-rendered HTML so the article list is crawlable without
 * executing JavaScript — the SPA tabs in this app are client-side and do
 * not satisfy that requirement.
 *
 * Sections (canonical IT path / EN / DE / FR variants):
 *   - Fisco                /fisco/                  /en/tax/                  /de/steuern/                /fr/fiscalite/
 *   - Lavoro frontaliere   /lavoro-frontaliere/     /en/cross-border-work/    /de/grenzgaenger-arbeit/    /fr/travail-frontalier/
 *   - Salari               /salari/                 /en/salaries/             /de/loehne/                 /fr/salaires/
 *   - Cambio valuta        /cambio-valuta/          /en/currency-exchange/    /de/waehrung/               /fr/change/
 *   - Trasporti            /trasporti/              /en/transport/            /de/verkehr/                /fr/transports/
 *   - Pensioni             /pensioni/               /en/pensions/             /de/renten/                 /fr/retraites/
 *   - Dogana               /dogana/                 /en/customs/              /de/zoll/                   /fr/douane/
 *
 * Each page renders:
 *   - SEO `<title>`, meta description, canonical, hreflang alternates
 *   - JSON-LD CollectionPage with ItemList of the latest 20 matching articles
 *   - Visible H1, lede paragraph, and article list with date + author byline
 *   - Site shell (header/footer hydrate via the SPA chunk)
 *
 * Article matching: keyword search across the article `id` (slug) — the
 * article ids are descriptive Italian slugs (e.g. `tredicesima-frontaliere`,
 * `cambio-valuta-frontalieri`) so they are the most reliable filter signal.
 * Categories are too coarse (1 320 of 1 896 articles share `novita`).
 *
 * Locale-specific blog slugs are resolved via `services/routerBlogData.ts`
 * (BLOG_SLUGS) so each link points to the locale's canonical article URL.
 *
 * No SPA navigation: these pages are static-only. They are NOT registered
 * as SPA routes in `services/router.ts`. The 6-tab top-level cap is
 * preserved (these are footer/sitemap-only entry points).
 *
 * Gate: SKIP_SECTION_PAGES=1 fast-exits the plugin for local builds. CI
 * (`npm run build:ci`) always exercises it — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_BODY_STYLE,
  CARD_PADDING_STYLE,
  H1_STYLE,
  H2_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  esc,
} from './shared/seoContentTokens';
import { ARTICLES } from '../data/blog-articles-data';
import { BLOG_SLUGS } from '../services/routerBlogData';
import type { BlogArticleId } from '../services/router';

// ── Types ─────────────────────────────────────────────────────────

type SectionLocale = 'it' | 'en' | 'de' | 'fr';

type SectionId =
  | 'fisco'
  | 'lavoro'
  | 'salari'
  | 'cambio'
  | 'trasporti'
  | 'pensioni'
  | 'dogana';

const SECTION_IDS: readonly SectionId[] = [
  'fisco',
  'lavoro',
  'salari',
  'cambio',
  'trasporti',
  'pensioni',
  'dogana',
] as const;

const LOCALES: readonly SectionLocale[] = ['it', 'en', 'de', 'fr'] as const;

const OG_LOCALE: Record<SectionLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

// ── Locale-specific labels and copy ───────────────────────────────

interface LocaleCopy {
  readonly homeBreadcrumb: string;
  readonly publishedLabel: string;
  readonly authorLabel: string;
  readonly readMoreLabel: string;
  readonly relatedLabel: string;
  readonly latestLabel: string;
  readonly editorialOrg: string;
  readonly editorialFallbackAuthor: string;
}

const LOCALE_COPY: Record<SectionLocale, LocaleCopy> = {
  it: {
    homeBreadcrumb: 'Home',
    publishedLabel: 'Pubblicato',
    authorLabel: 'Autore',
    readMoreLabel: 'Leggi l’articolo',
    relatedLabel: 'Altri articoli della sezione',
    latestLabel: 'Articoli più recenti',
    editorialOrg: 'Frontaliere Ticino',
    editorialFallbackAuthor: 'Redazione Frontaliere Ticino',
  },
  en: {
    homeBreadcrumb: 'Home',
    publishedLabel: 'Published',
    authorLabel: 'Author',
    readMoreLabel: 'Read the article',
    relatedLabel: 'More articles in this section',
    latestLabel: 'Latest articles',
    editorialOrg: 'Frontaliere Ticino',
    editorialFallbackAuthor: 'Frontaliere Ticino editorial team',
  },
  de: {
    homeBreadcrumb: 'Startseite',
    publishedLabel: 'Veröffentlicht',
    authorLabel: 'Autor',
    readMoreLabel: 'Artikel lesen',
    relatedLabel: 'Weitere Artikel dieser Rubrik',
    latestLabel: 'Neueste Artikel',
    editorialOrg: 'Frontaliere Ticino',
    editorialFallbackAuthor: 'Frontaliere Ticino Redaktion',
  },
  fr: {
    homeBreadcrumb: 'Accueil',
    publishedLabel: 'Publié',
    authorLabel: 'Auteur',
    readMoreLabel: 'Lire l’article',
    relatedLabel: 'Autres articles de cette rubrique',
    latestLabel: 'Derniers articles',
    editorialOrg: 'Frontaliere Ticino',
    editorialFallbackAuthor: 'Rédaction Frontaliere Ticino',
  },
};

// ── Section catalog ───────────────────────────────────────────────

interface SectionCopy {
  readonly title: string;
  readonly h1: string;
  readonly description: string;
  readonly lede: string;
  /** 4–6 sentence supporting paragraph for the section context block. */
  readonly context: string;
}

interface SectionConfig {
  readonly id: SectionId;
  readonly paths: Record<SectionLocale, string>;
  readonly copy: Record<SectionLocale, SectionCopy>;
  /**
   * Lower-cased keywords scanned against `Article.id` (slug). An article
   * matches the section when at least one keyword is a substring of the
   * slug. Order does not matter; matches are de-duplicated downstream.
   */
  readonly keywords: readonly string[];
}

const SECTIONS: Record<SectionId, SectionConfig> = {
  fisco: {
    id: 'fisco',
    paths: {
      it: '/fisco/',
      en: '/en/tax/',
      de: '/de/steuern/',
      fr: '/fr/fiscalite/',
    },
    keywords: [
      'fisco',
      'fiscal',
      'tasse',
      'tassa',
      'imposta',
      'imposte',
      'irpef',
      'tax',
      'steuer',
      'iva',
      'vat',
      'mwst',
      'tva',
      'ristorni',
      'dichiarazione',
      'cu-',
      'tax-',
      'detrazion',
      'agenzia-entrate',
    ],
    copy: {
      it: {
        title: 'Fisco frontalieri Italia-Svizzera: novità e guide',
        h1: 'Fisco frontalieri Italia-Svizzera',
        description:
          'Ultime novità fiscali per i frontalieri Italia-Svizzera: nuovo accordo 2026, ristorni, IRPEF, dichiarazione dei redditi, CU e tasse comunali.',
        lede:
          'Tutto ciò che un frontaliere deve sapere sulle tasse italiane e svizzere: nuovo accordo, ristorni, dichiarazione dei redditi e novità del fisco aggiornate.',
        context:
          "Le tasse sono il capitolo più sensibile per chi lavora in Svizzera ma vive in Italia. " +
          "Dal 2026 il nuovo Accordo fiscale Italia-Svizzera ha cambiato le regole su imposta alla fonte, ristorni e tassazione dei nuovi frontalieri. " +
          "In questa sezione raccogliamo gli articoli che spiegano gli effetti pratici sulla busta paga, gli adempimenti dichiarativi (CU, modello redditi PF, quadro RW) e i conflitti politici tra Ticino, Berna e Roma sui ristorni. " +
          "Ogni articolo è scritto pensando al frontaliere reale: con esempi numerici, scadenze e link al simulatore fiscale di Frontaliere Ticino. " +
          "Aggiorniamo la sezione ogni volta che cambia una norma, una circolare dell’Agenzia delle Entrate o un’ordinanza del Cantone Ticino.",
      },
      en: {
        title: 'Cross-border tax (Italy-Switzerland): news and guides',
        h1: 'Italy–Switzerland cross-border taxation',
        description:
          'Latest tax news for Italy–Switzerland cross-border workers: 2026 agreement, tax restitutions, IRPEF, annual return, CU form and municipal taxes.',
        lede:
          'Everything a cross-border worker needs to know about Italian and Swiss taxes: the new agreement, restitutions, annual return and tax news, updated regularly.',
        context:
          'Taxation is the most sensitive chapter for workers commuting from Italy to Switzerland. ' +
          'Since 2026 the new bilateral agreement has reshaped withholding tax, restitutions and the taxation of new cross-border workers. ' +
          'This section gathers the articles that explain the real impact on take-home pay, filing duties (CU form, Italian tax return, RW form) and the political tug-of-war between Ticino, Bern and Rome over restitutions. ' +
          'Every article is written for a real frontaliere: with worked numerical examples, deadlines and links back to the Frontaliere Ticino fiscal simulator. ' +
          'We refresh this section every time a tax rule, an Agenzia delle Entrate circular or a Cantone Ticino ordinance changes.',
      },
      de: {
        title: 'Steuern Grenzgänger Italien-Schweiz: News und Ratgeber',
        h1: 'Steuern für Grenzgänger Italien–Schweiz',
        description:
          'Aktuelle Steuer-News für Grenzgänger Italien-Schweiz: Abkommen 2026, Steuerrückerstattungen, IRPEF, Steuererklärung, CU-Formular und Gemeindesteuern.',
        lede:
          'Alles, was Grenzgänger über italienische und Schweizer Steuern wissen müssen: das neue Abkommen, Rückerstattungen, Steuererklärung und aktuelle Neuigkeiten.',
        context:
          'Steuern sind das heikelste Kapitel für alle, die in der Schweiz arbeiten und in Italien wohnen. ' +
          'Seit 2026 hat das neue Abkommen Italien–Schweiz die Quellensteuer, die Rückerstattungen und die Besteuerung neuer Grenzgänger neu geregelt. ' +
          'In dieser Rubrik bündeln wir Artikel, die die konkreten Auswirkungen auf den Lohnzettel, die Steuerpflichten (CU, italienische Steuererklärung, RW) und die politischen Auseinandersetzungen zwischen Tessin, Bern und Rom über die Rückerstattungen erklären. ' +
          'Jeder Artikel ist für reale Grenzgänger geschrieben: mit Rechenbeispielen, Fristen und Links zum Steuersimulator von Frontaliere Ticino. ' +
          'Wir aktualisieren diese Rubrik bei jeder Änderung einer Norm, eines Rundschreibens der Agenzia delle Entrate oder einer Tessiner Verordnung.',
      },
      fr: {
        title: 'Fiscalité frontaliers Italie-Suisse : actualités et guides',
        h1: 'Fiscalité des frontaliers Italie–Suisse',
        description:
          'Dernières actualités fiscales pour les frontaliers Italie-Suisse : accord 2026, ristournes, IRPEF, déclaration de revenus, CU et taxes communales.',
        lede:
          'Tout ce qu’un frontalier doit savoir sur les impôts italiens et suisses : nouvel accord, ristournes, déclaration et actualités fiscales mises à jour.',
        context:
          'La fiscalité est le chapitre le plus sensible pour ceux qui travaillent en Suisse et vivent en Italie. ' +
          'Depuis 2026, le nouvel accord Italie–Suisse a redéfini la retenue à la source, les ristournes et la fiscalité des nouveaux frontaliers. ' +
          'Cette rubrique rassemble les articles qui expliquent l’impact réel sur le salaire net, les obligations déclaratives (CU, déclaration de revenus, cadre RW) et le bras de fer politique entre le Tessin, Berne et Rome sur les ristournes. ' +
          'Chaque article est écrit pour un frontalier réel : avec des exemples chiffrés, des échéances et des liens vers le simulateur fiscal de Frontaliere Ticino. ' +
          'Nous mettons cette rubrique à jour à chaque évolution réglementaire, circulaire de l’Agenzia delle Entrate ou ordonnance du Canton du Tessin.',
      },
    },
  },
  lavoro: {
    id: 'lavoro',
    paths: {
      it: '/lavoro-frontaliere/',
      en: '/en/cross-border-work/',
      de: '/de/grenzgaenger-arbeit/',
      fr: '/fr/travail-frontalier/',
    },
    keywords: [
      'lavoro',
      'lavor',
      'frontalier',
      'frontaliere',
      'frontalieri',
      'permesso-g',
      'permesso-b',
      'permit-g',
      'permit-b',
      'cross-border',
      'grenzgaenger',
      'telelavoro',
      'telework',
      'home-office',
      'teletravail',
      'disoccupazione',
      'unemployment',
      'arbeitslos',
      'chomage',
      'contratti',
      'contract',
      'dumping',
      'job',
      'work',
      'arbeit',
    ],
    copy: {
      it: {
        title: 'Lavoro frontaliere: contratti, permessi e mercato del lavoro',
        h1: 'Lavoro frontaliere Italia-Svizzera',
        description:
          'Notizie sul mercato del lavoro frontaliere: contratti, permessi B/G, telelavoro, disoccupazione e dinamiche degli stipendi in Ticino.',
        lede:
          'Mercato del lavoro per i frontalieri: contratti svizzeri, permessi B e G, telelavoro, dumping salariale e disoccupazione, raccontati con dati concreti.',
        context:
          'Il lavoro frontaliere non è solo "andare a lavorare in Ticino": è un sistema fatto di permessi (G, B, S), CCL, telelavoro fino a 25/45 giorni, dumping salariale, disoccupazione e transizione dopo il licenziamento. ' +
          'In questa sezione monitoriamo le decisioni del Consiglio di Stato ticinese, le statistiche USTAT/SECO sulla disoccupazione e i temi caldi del CCL nei principali settori (industria, sanità, vendita, gastronomia, edilizia). ' +
          'Ogni articolo cita le fonti ufficiali e collega al calcolatore stipendio o alla guida pratica corrispondente. ' +
          'L’obiettivo è dare al frontaliere uno strumento aggiornato per leggere il proprio contratto, capire se vale la pena cambiare azienda e prepararsi a ogni novità del mercato.',
      },
      en: {
        title: 'Cross-border work: contracts, permits and labour market',
        h1: 'Italy–Switzerland cross-border work',
        description:
          'Cross-border labour market news: contracts, B/G permits, telework, unemployment and wage dynamics in Ticino, with verified sources.',
        lede:
          'Labour market for cross-border workers: Swiss employment contracts, B and G permits, telework, wage dumping and unemployment — explained with real data.',
        context:
          'Cross-border work is more than "commuting to Ticino": it is a system of permits (G, B, S), collective bargaining agreements, telework caps (25 / 45 days), wage dumping and post-redundancy paths. ' +
          'This section tracks decisions by the Cantonal Government, USTAT/SECO unemployment statistics and the most heated CCL topics in industry, healthcare, retail, hospitality and construction. ' +
          'Every article cites the official source and links to the relevant salary calculator or practical guide. ' +
          'The goal is to give cross-border workers an up-to-date toolkit to read their contracts, decide whether to switch employer and prepare for every market shift.',
      },
      de: {
        title: 'Grenzgänger-Arbeit: Verträge, Bewilligungen und Arbeitsmarkt',
        h1: 'Grenzgänger-Arbeitsmarkt Italien–Schweiz',
        description:
          'News zum Grenzgänger-Arbeitsmarkt: Verträge, B/G-Bewilligungen, Home-Office, Arbeitslosigkeit und Lohnentwicklung im Tessin.',
        lede:
          'Arbeitsmarkt für Grenzgänger: Schweizer Verträge, B- und G-Bewilligungen, Home-Office, Lohndumping und Arbeitslosigkeit — mit echten Daten erklärt.',
        context:
          'Grenzgänger-Arbeit ist mehr als "ins Tessin pendeln": es ist ein System aus Bewilligungen (G, B, S), GAV, Home-Office-Limits (25 / 45 Tage), Lohndumping und Wegen nach einer Kündigung. ' +
          'In dieser Rubrik verfolgen wir Beschlüsse des Tessiner Staatsrats, USTAT/SECO-Statistiken zur Arbeitslosigkeit und die heissesten GAV-Themen in Industrie, Gesundheit, Detailhandel, Gastronomie und Bau. ' +
          'Jeder Artikel zitiert die offiziellen Quellen und verlinkt zum passenden Lohnrechner oder Praxis-Ratgeber. ' +
          'Ziel ist ein aktuelles Instrument, mit dem Grenzgänger ihren Vertrag lesen, einen Stellenwechsel abwägen und Marktveränderungen vorausschauend einordnen können.',
      },
      fr: {
        title: 'Travail frontalier : contrats, permis et marché de l’emploi',
        h1: 'Marché du travail frontalier Italie–Suisse',
        description:
          'Actualités du marché du travail frontalier : contrats, permis B/G, télétravail, chômage et dynamique des salaires au Tessin.',
        lede:
          'Marché de l’emploi pour les frontaliers : contrats suisses, permis B et G, télétravail, dumping salarial et chômage — analysés avec des données réelles.',
        context:
          'Le travail frontalier ne se résume pas à "aller travailler au Tessin" : c’est un système de permis (G, B, S), de CCT, de plafonds de télétravail (25 / 45 jours), de dumping salarial et de transitions après licenciement. ' +
          'Cette rubrique suit les décisions du Conseil d’État tessinois, les statistiques USTAT/SECO sur le chômage et les sujets chauds des CCT dans l’industrie, la santé, le commerce, l’hôtellerie et la construction. ' +
          'Chaque article cite la source officielle et renvoie vers le calculateur de salaire ou le guide pratique correspondant. ' +
          'L’objectif : offrir au frontalier un outil à jour pour lire son contrat, décider de changer d’employeur et anticiper les évolutions du marché.',
      },
    },
  },
  salari: {
    id: 'salari',
    paths: {
      it: '/salari/',
      en: '/en/salaries/',
      de: '/de/loehne/',
      fr: '/fr/salaires/',
    },
    keywords: [
      'salar',
      'stipend',
      'busta-paga',
      'salaire',
      'salary',
      'gehalt',
      'lohn',
      'tredicesima',
      '13-',
      '13eme',
      'thirteenth',
      'aumento-contributi',
      'avs',
      'minimo-salariale',
      'minimum-wage',
      'mindestlohn',
    ],
    copy: {
      it: {
        title: 'Salari frontalieri Ticino: novità, statistiche e analisi',
        h1: 'Salari dei frontalieri in Ticino',
        description:
          'Aggiornamenti sui salari dei frontalieri in Ticino: tredicesima, salari minimi cantonali, dumping, contributi AVS e analisi settoriale.',
        lede:
          'Salari, tredicesima, minimi cantonali e contributi AVS: come si muovono le buste paga dei frontalieri in Ticino, raccontato con dati e tabelle.',
        context:
          'Lo stipendio è il primo motivo per cui un italiano lavora in Svizzera, ma è anche il punto in cui le differenze fra Italia e Ticino diventano più complesse. ' +
          'In questa sezione raccontiamo l’andamento dei salari nominali, l’impatto della tredicesima AVS, i salari minimi cantonali, il dumping nei settori a rischio e le statistiche USTAT più recenti. ' +
          'Ogni articolo è collegato al simulatore stipendio netto e al confronto stipendi Italia-Svizzera, così da trasformare la notizia in un calcolo concreto sulla propria busta paga. ' +
          'Aggiorniamo la sezione quando il Consiglio di Stato pubblica nuovi dati o quando un CCL viene rinegoziato.',
      },
      en: {
        title: 'Ticino cross-border salaries: news, statistics, analysis',
        h1: 'Cross-border salaries in Ticino',
        description:
          'Salary updates for cross-border workers in Ticino: 13th-month pay, cantonal minimum wages, dumping, AVS contributions and sector analysis.',
        lede:
          'Salaries, 13th-month pay, cantonal minimums and AVS contributions: how cross-border pay slips evolve in Ticino, with data and tables.',
        context:
          'Salary is the primary reason an Italian works in Switzerland — and the area where differences with Italy become most complex. ' +
          'This section tracks nominal wage growth, the impact of the new 13th AVS pension, cantonal minimum wages, dumping in vulnerable sectors and the latest USTAT statistics. ' +
          'Every article links back to the net salary calculator and the Italy–Switzerland salary comparator, turning each piece of news into a concrete computation on your own pay slip. ' +
          'We refresh this section whenever the Cantonal Government publishes new data or a sector CBA is renegotiated.',
      },
      de: {
        title: 'Tessin-Grenzgängerlöhne: News, Statistik und Analyse',
        h1: 'Grenzgängerlöhne im Tessin',
        description:
          'Lohn-News für Tessin-Grenzgänger: 13. Monatslohn, kantonale Mindestlöhne, Lohndumping, AHV-Beiträge und Sektoranalyse.',
        lede:
          'Löhne, 13. Monatslohn, kantonale Mindestlöhne und AHV-Beiträge: wie sich die Lohnzettel der Grenzgänger im Tessin entwickeln — mit Daten und Tabellen.',
        context:
          'Der Lohn ist der Hauptgrund, warum Italiener in der Schweiz arbeiten, und genau hier werden die Unterschiede zu Italien am komplexesten. ' +
          'In dieser Rubrik verfolgen wir die nominale Lohnentwicklung, die Auswirkungen der 13. AHV-Rente, die kantonalen Mindestlöhne, Lohndumping in gefährdeten Sektoren und die jüngsten USTAT-Statistiken. ' +
          'Jeder Artikel verlinkt auf den Netto-Lohnrechner und den Lohnvergleich Italien–Schweiz und macht aus News konkrete Zahlen auf dem eigenen Lohnzettel. ' +
          'Wir aktualisieren die Rubrik, sobald der Tessiner Staatsrat neue Daten publiziert oder ein GAV neu verhandelt wird.',
      },
      fr: {
        title: 'Salaires frontaliers Tessin : actualités et statistiques',
        h1: 'Salaires des frontaliers au Tessin',
        description:
          'Actualités salariales pour les frontaliers au Tessin : 13e salaire, salaires minimums cantonaux, dumping, cotisations AVS et analyses sectorielles.',
        lede:
          'Salaires, 13e salaire, minimums cantonaux et cotisations AVS : comment évoluent les fiches de paie des frontaliers au Tessin, avec données et tableaux.',
        context:
          'Le salaire est la raison première pour laquelle un Italien travaille en Suisse, et c’est là que les différences avec l’Italie deviennent les plus complexes. ' +
          'Cette rubrique suit l’évolution nominale des salaires, l’impact de la nouvelle 13e rente AVS, les salaires minimums cantonaux, le dumping dans les secteurs à risque et les statistiques USTAT les plus récentes. ' +
          'Chaque article renvoie au calculateur de salaire net et au comparateur Italie–Suisse, transformant l’actualité en calcul concret sur votre fiche de paie. ' +
          'Nous mettons la rubrique à jour à chaque publication de données par le Conseil d’État ou à chaque renégociation de CCT.',
      },
    },
  },
  cambio: {
    id: 'cambio',
    paths: {
      it: '/cambio-valuta/',
      en: '/en/currency-exchange/',
      de: '/de/waehrung/',
      fr: '/fr/change/',
    },
    keywords: [
      'cambio',
      'cambi-',
      'currency',
      'exchange',
      'waehrung',
      'wechselkurs',
      'change',
      'franc',
      'franco',
      'eur-chf',
      'chf-eur',
      'forex',
      'banca',
      'bank',
      'transfer',
      'bonifico',
      'wise',
      'revolut',
      'snb',
    ],
    copy: {
      it: {
        title: 'Cambio CHF/EUR per frontalieri: tassi e strategie',
        h1: 'Cambio CHF/EUR per frontalieri',
        description:
          'Aggiornamenti su cambio franco-euro, decisioni della BNS, costi di bonifico e strategie di conversione per frontalieri.',
        lede:
          'Cambio CHF/EUR per frontalieri: tassi quotidiani, decisioni della BNS, fintech come Wise e Revolut e strategie per non perdere franchi sul cambio.',
        context:
          'Per un frontaliere il tasso CHF/EUR è la seconda variabile dopo lo stipendio: bastano due-tre centesimi di euro a margine di cambio per perdere oltre cento franchi al mese. ' +
          'In questa sezione raccogliamo gli articoli sul franco forte e debole, le decisioni di politica monetaria della Banca nazionale svizzera, l’andamento di banche tradizionali, fintech (Wise, Revolut, n26) e cambiavalute storici di confine. ' +
          'Ogni articolo è collegato al comparatore cambio valuta di Frontaliere Ticino, che mostra il tasso reale al netto delle commissioni. ' +
          'Aggiorniamo la sezione ogni volta che la BNS interviene o che le condizioni delle banche italiane cambiano sui conti multivaluta.',
      },
      en: {
        title: 'CHF/EUR exchange for cross-border workers: rates and tips',
        h1: 'CHF/EUR exchange for cross-border workers',
        description:
          'CHF/EUR rate updates, SNB decisions, transfer costs and conversion strategies for Italy–Switzerland cross-border workers.',
        lede:
          'CHF/EUR rates for cross-border workers: daily quotes, SNB policy moves, fintechs like Wise and Revolut, plus strategies to avoid hidden FX losses.',
        context:
          'For a cross-border worker the CHF/EUR rate is the second variable after the salary itself: a 2–3 cent FX margin can wipe out more than CHF 100 per month. ' +
          'This section gathers articles about a strong vs weak Swiss franc, monetary-policy moves by the Swiss National Bank, traditional banks vs fintechs (Wise, Revolut, n26) and the legacy bureaux de change at the border. ' +
          'Every article links to the Frontaliere Ticino currency comparator, which displays the real rate net of fees. ' +
          'We refresh the section whenever the SNB intervenes or Italian banks change conditions on multi-currency accounts.',
      },
      de: {
        title: 'CHF/EUR-Wechsel für Grenzgänger: Kurse und Strategien',
        h1: 'CHF/EUR-Wechsel für Grenzgänger',
        description:
          'Aktuelle CHF/EUR-Kurse, SNB-Entscheidungen, Überweisungskosten und Wechselstrategien für Grenzgänger Italien–Schweiz.',
        lede:
          'CHF/EUR-Kurse für Grenzgänger: tägliche Kurse, SNB-Entscheidungen, Fintechs wie Wise und Revolut sowie Strategien gegen versteckte FX-Verluste.',
        context:
          'Für Grenzgänger ist der CHF/EUR-Kurs die zweitwichtigste Variable nach dem Lohn selbst: 2–3 Cent FX-Marge bedeuten über CHF 100 weniger pro Monat. ' +
          'Diese Rubrik bündelt Artikel zu starkem und schwachem Franken, geldpolitischen Entscheiden der Schweizerischen Nationalbank, klassischen Banken und Fintechs (Wise, Revolut, n26) sowie historischen Wechselstuben an der Grenze. ' +
          'Jeder Artikel verlinkt zum Wechselkurs-Vergleich von Frontaliere Ticino, der den realen Kurs nach Gebühren zeigt. ' +
          'Wir aktualisieren die Rubrik, sobald die SNB interveniert oder italienische Banken die Konditionen für Multiwährungskonten ändern.',
      },
      fr: {
        title: 'Change CHF/EUR pour frontaliers : taux et stratégies',
        h1: 'Change CHF/EUR pour frontaliers',
        description:
          'Actualité du taux CHF/EUR, décisions de la BNS, coûts de virement et stratégies de change pour frontaliers Italie–Suisse.',
        lede:
          'Taux CHF/EUR pour frontaliers : cours quotidiens, décisions de la BNS, fintechs comme Wise et Revolut et stratégies pour éviter les pertes cachées au change.',
        context:
          'Pour un frontalier le cours CHF/EUR est la seconde variable après le salaire : 2 à 3 centimes de marge de change suffisent à effacer plus de 100 CHF par mois. ' +
          'Cette rubrique réunit les articles sur le franc fort et faible, les décisions de politique monétaire de la Banque nationale suisse, les banques traditionnelles et les fintechs (Wise, Revolut, n26) et les bureaux de change historiques à la frontière. ' +
          'Chaque article renvoie au comparateur de change Frontaliere Ticino, qui affiche le taux réel net de frais. ' +
          'Nous actualisons la rubrique à chaque intervention de la BNS ou changement de conditions des banques italiennes sur les comptes multidevises.',
      },
    },
  },
  trasporti: {
    id: 'trasporti',
    paths: {
      it: '/trasporti/',
      en: '/en/transport/',
      de: '/de/verkehr/',
      fr: '/fr/transports/',
    },
    keywords: [
      'trasport',
      'transport',
      'verkehr',
      'pendolarismo',
      'pendel',
      'commute',
      'trajet',
      'frontiera',
      'border',
      'grenze',
      'frontiere',
      'auto',
      'autostrada',
      'bus',
      'treno',
      'train',
      'sbb',
      'ffs',
      'tilo',
      'parcheggio',
      'parking',
      'webcam',
      'tempo-attesa',
      'wait',
      'carburante',
      'benzina',
      'diesel',
      'petrol',
      'gasolio',
      'fuel',
      'essence',
      'kraftstoff',
      'kraftstoffe',
    ],
    copy: {
      it: {
        title: 'Trasporti frontalieri: dogana, treni, auto e carburanti',
        h1: 'Trasporti per frontalieri',
        description:
          'Notizie e guide sui trasporti frontalieri: dogana, tempi di attesa, treni TILO, autostrade, parcheggi e prezzi dei carburanti al confine.',
        lede:
          'Trasporti per frontalieri: dogane, tempi di attesa al confine, treni TILO, parcheggi P+R e prezzi dei carburanti, raccontati con dati aggiornati.',
        context:
          'Andare a lavorare in Ticino significa fare i conti ogni giorno con la frontiera: code a Brogeda e Stabio, treni TILO, autostrada A2, parcheggi P+R e prezzi dei carburanti che oscillano fra Italia e Svizzera. ' +
          'In questa sezione raccogliamo gli articoli sui tempi di attesa al confine, i nuovi orari ferroviari, le webcam delle dogane e i servizi di carpooling fra frontalieri. ' +
          'Ogni articolo è collegato alle pagine pratiche di Frontaliere Ticino su prezzi carburante giornalieri, mappa webcam dogana e calcolatore costo pendolarismo. ' +
          'Aggiorniamo la rubrica quando AGE, USTRA, FFS o il TPL Lugano cambiano qualcosa che impatta lo spostamento quotidiano.',
      },
      en: {
        title: 'Cross-border transport: customs, trains, cars and fuel',
        h1: 'Transport for cross-border workers',
        description:
          'News and guides on cross-border transport: customs wait times, TILO trains, motorways, P+R parking and fuel prices at the border.',
        lede:
          'Transport for cross-border workers: customs, border wait times, TILO trains, P+R parking and fuel prices — covered with up-to-date data.',
        context:
          'Working in Ticino means dealing with the border every single day: queues at Brogeda and Stabio, TILO trains, the A2 motorway, P+R car parks and fuel prices that swing between Italy and Switzerland. ' +
          'This section gathers articles on customs wait times, new rail timetables, customs webcams and carpooling services among cross-border workers. ' +
          'Each article links to the Frontaliere Ticino tools on daily fuel prices, the customs webcam map and the commute cost calculator. ' +
          'We refresh this section whenever AGE, USTRA, FFS or the TPL Lugano change anything that affects the daily commute.',
      },
      de: {
        title: 'Grenzgänger-Verkehr: Zoll, Züge, Auto und Treibstoff',
        h1: 'Verkehr für Grenzgänger',
        description:
          'News und Ratgeber zum Grenzgänger-Verkehr: Zoll, Wartezeiten an der Grenze, TILO-Züge, Autobahnen, P+R-Parkplätze und Treibstoffpreise.',
        lede:
          'Verkehr für Grenzgänger: Zoll, Wartezeiten an der Grenze, TILO-Züge, P+R-Parkplätze und Treibstoffpreise — mit aktuellen Daten erklärt.',
        context:
          'Wer im Tessin arbeitet, hat täglich mit der Grenze zu tun: Staus an Brogeda und Stabio, TILO-Züge, Autobahn A2, P+R-Parkplätze und Treibstoffpreise zwischen Italien und der Schweiz. ' +
          'In dieser Rubrik bündeln wir Artikel zu Wartezeiten an der Grenze, neuen Fahrplänen, Zoll-Webcams und Mitfahrdiensten unter Grenzgängern. ' +
          'Jeder Artikel verlinkt zu den Frontaliere-Ticino-Tools für tägliche Treibstoffpreise, Zoll-Webcam-Karte und Pendel-Kostenrechner. ' +
          'Wir aktualisieren die Rubrik, sobald BAZG, ASTRA, SBB oder TPL Lugano etwas ändern, das den Pendelverkehr beeinflusst.',
      },
      fr: {
        title: 'Transports frontaliers : douane, trains, voiture et carburant',
        h1: 'Transports pour frontaliers',
        description:
          'Actualités et guides sur les transports frontaliers : douane, temps d’attente, trains TILO, autoroutes, parkings P+R et carburants à la frontière.',
        lede:
          'Transports pour frontaliers : douane, temps d’attente, trains TILO, parkings P+R et prix des carburants — analysés avec des données à jour.',
        context:
          'Travailler au Tessin, c’est composer chaque jour avec la frontière : files à Brogeda et Stabio, trains TILO, autoroute A2, parkings P+R et prix des carburants entre l’Italie et la Suisse. ' +
          'Cette rubrique réunit les articles sur les temps d’attente, les nouveaux horaires ferroviaires, les webcams douanières et les services de covoiturage frontaliers. ' +
          'Chaque article renvoie aux outils Frontaliere Ticino : prix quotidiens des carburants, carte des webcams douanières et calculateur de coût des trajets. ' +
          'Nous actualisons la rubrique dès qu’OFDF, OFROU, CFF ou TPL Lugano modifient quelque chose qui touche au trajet quotidien.',
      },
    },
  },
  pensioni: {
    id: 'pensioni',
    paths: {
      it: '/pensioni/',
      en: '/en/pensions/',
      de: '/de/renten/',
      fr: '/fr/retraites/',
    },
    keywords: [
      'pension',
      'pensione',
      'pensioni',
      'rente',
      'retraite',
      'avs',
      'ahv',
      'lpp',
      'bvg',
      'pilastro',
      'pillar',
      'saeule',
      'pilier',
      '3a',
      '2-pilastro',
      'previdenza',
      'inps',
      'totalizzazione',
      'tredicesima-avs',
      '13-avs',
      '13-ahv',
      '13-rente',
    ],
    copy: {
      it: {
        title: 'Pensioni frontalieri: AVS, LPP e terzo pilastro',
        h1: 'Pensioni dei frontalieri Italia-Svizzera',
        description:
          'Aggiornamenti sulle pensioni dei frontalieri: AVS, LPP, terzo pilastro, totalizzazione INPS-AVS e tredicesima AVS.',
        lede:
          'Pensioni per frontalieri: AVS, LPP, pilastro 3a, totalizzazione INPS-AVS e tredicesima AVS — con guide pratiche e simulazioni.',
        context:
          'La pensione è la parte meno visibile della busta paga frontaliera, ma è quella che decide il tenore di vita post-lavoro. ' +
          'In questa sezione spieghiamo come funziona il sistema svizzero a tre pilastri (AVS, LPP, 3a/3b), la totalizzazione con l’INPS, il riscatto del LPP al rientro in Italia e gli effetti della tredicesima AVS sui contributi. ' +
          'Ogni articolo è collegato al simulatore di Frontaliere Ticino e alle guide pratiche per scegliere fra prelievo capitale, rendita e pilastro 3a deducibile. ' +
          'Aggiorniamo la rubrica a ogni decisione del Consiglio federale, riforma INPS o cambiamento delle convenzioni bilaterali.',
      },
      en: {
        title: 'Cross-border pensions: AVS, LPP and pillar 3a',
        h1: 'Italy–Switzerland cross-border pensions',
        description:
          'Pension updates for cross-border workers: AVS, LPP, pillar 3a, INPS-AVS aggregation and the new 13th AVS pension.',
        lede:
          'Cross-border pensions: AVS, LPP, pillar 3a, INPS-AVS aggregation and the new 13th AVS — explained with practical guides and simulations.',
        context:
          'The pension is the least visible piece of a cross-border pay slip, yet it determines post-retirement living standards. ' +
          'This section explains the Swiss three-pillar system (AVS, LPP, 3a/3b), aggregation with the Italian INPS, the LPP buy-out when returning to Italy and the impact of the new 13th AVS pension on contributions. ' +
          'Each article links to the Frontaliere Ticino simulator and to practical guides on the lump-sum vs annuity decision and on the deductible pillar 3a. ' +
          'We refresh this section after every Federal Council decision, INPS reform or change in the bilateral agreements.',
      },
      de: {
        title: 'Grenzgänger-Renten: AHV, BVG und Säule 3a',
        h1: 'Grenzgänger-Renten Italien–Schweiz',
        description:
          'Renten-News für Grenzgänger: AHV, BVG, Säule 3a, Zusammenrechnung INPS-AHV und 13. AHV-Rente.',
        lede:
          'Renten für Grenzgänger: AHV, BVG, Säule 3a, INPS-AHV-Zusammenrechnung und 13. AHV-Rente — mit Ratgebern und Simulationen.',
        context:
          'Die Rente ist der unsichtbarste Teil des Grenzgänger-Lohnzettels und entscheidet über den Lebensstandard nach dem Erwerbsleben. ' +
          'In dieser Rubrik erklären wir das Schweizer Drei-Säulen-System (AHV, BVG, 3a/3b), die Zusammenrechnung mit der italienischen INPS, die BVG-Auszahlung bei Rückkehr nach Italien und die Auswirkungen der 13. AHV-Rente auf die Beiträge. ' +
          'Jeder Artikel verlinkt zum Frontaliere-Ticino-Simulator und zu Praxisratgebern zur Wahl zwischen Kapitalbezug und Rente sowie zur abzugsfähigen Säule 3a. ' +
          'Wir aktualisieren die Rubrik nach jedem Entscheid des Bundesrats, jeder INPS-Reform oder Änderung der bilateralen Abkommen.',
      },
      fr: {
        title: 'Retraites frontalières : AVS, LPP et 3e pilier',
        h1: 'Retraites frontalières Italie–Suisse',
        description:
          'Actualités retraite pour frontaliers : AVS, LPP, 3e pilier, totalisation INPS-AVS et 13e rente AVS.',
        lede:
          'Retraites frontalières : AVS, LPP, 3e pilier, totalisation INPS-AVS et 13e rente AVS — avec guides pratiques et simulations.',
        context:
          'La retraite est la partie la plus invisible de la fiche de paie frontalière, mais elle détermine le niveau de vie après le travail. ' +
          'Cette rubrique explique le système suisse à trois piliers (AVS, LPP, 3a/3b), la totalisation avec l’INPS italien, le rachat du LPP au retour en Italie et l’impact de la nouvelle 13e rente AVS sur les cotisations. ' +
          'Chaque article renvoie au simulateur Frontaliere Ticino et aux guides pratiques pour choisir entre capital et rente, et pour optimiser le 3e pilier déductible. ' +
          'Nous actualisons la rubrique à chaque décision du Conseil fédéral, réforme INPS ou modification des accords bilatéraux.',
      },
    },
  },
  dogana: {
    id: 'dogana',
    paths: {
      it: '/dogana/',
      en: '/en/customs/',
      de: '/de/zoll/',
      fr: '/fr/douane/',
    },
    keywords: [
      'dogana',
      'dogane',
      'customs',
      'zoll',
      'douane',
      'ufficio-doganale',
      'brogeda',
      'stabio',
      'chiasso',
      'gandria',
      'denaro-non-dichiarato',
      'undeclared',
      'franchigia',
      'duty-free',
      'iva-confine',
      'border-tax',
    ],
    copy: {
      it: {
        title: 'Dogana e regole di confine per frontalieri',
        h1: 'Dogana e regole di confine per frontalieri',
        description:
          'Aggiornamenti sulla dogana per frontalieri: franchigie, controlli, denaro contante, IVA al confine e nuovi varchi automatici.',
        lede:
          'Dogana per frontalieri: franchigie, controlli, denaro contante, IVA al confine e novità sui valichi di Brogeda, Stabio e Gandria.',
        context:
          'La dogana è il vero spartiacque della giornata di un frontaliere: pochi minuti separano la fila dal lavoro, ma una dichiarazione sbagliata può costare migliaia di franchi di sanzione. ' +
          'In questa sezione raccogliamo articoli sui controlli a Brogeda, Stabio, Gandria e Chiasso, sulle franchigie doganali, sull’importazione di denaro contante e sulle novità sui varchi automatici di nuova generazione. ' +
          'Ogni articolo cita le fonti ufficiali dell’Ufficio federale della dogana (UDSC) e dell’Agenzia delle Dogane italiana, e collega ai tool di Frontaliere Ticino per la mappa webcam e i tempi di attesa. ' +
          'Aggiorniamo la rubrica a ogni cambio operativo dei valichi o aggiornamento dei limiti di franchigia.',
      },
      en: {
        title: 'Customs and border rules for cross-border workers',
        h1: 'Customs and border rules for cross-border workers',
        description:
          'Customs updates for cross-border workers: allowances, checks, cash declarations, VAT at the border and new automated lanes.',
        lede:
          'Customs for cross-border workers: allowances, checks, cash, border VAT and updates on the Brogeda, Stabio and Gandria crossings.',
        context:
          'The customs check is the real watershed in a cross-border worker’s day: minutes separate the queue from work, but a wrong declaration can cost thousands of francs in fines. ' +
          'This section gathers articles on checks at Brogeda, Stabio, Gandria and Chiasso, on customs allowances, on cash imports and on the new automated lanes. ' +
          'Every article cites the official sources of the Federal Office for Customs (FOCBS / UDSC) and the Italian Customs Agency, and links to the Frontaliere Ticino webcam map and wait-time tracker. ' +
          'We refresh this section every time crossing rules or allowance limits are updated.',
      },
      de: {
        title: 'Zoll und Grenzregeln für Grenzgänger',
        h1: 'Zoll und Grenzregeln für Grenzgänger',
        description:
          'Zoll-News für Grenzgänger: Freimengen, Kontrollen, Bargeld, MwSt an der Grenze und neue automatische Spuren.',
        lede:
          'Zoll für Grenzgänger: Freimengen, Kontrollen, Bargeld, Grenz-MwSt und Updates zu den Übergängen Brogeda, Stabio und Gandria.',
        context:
          'Der Zoll ist der wahre Wendepunkt im Tag eines Grenzgängers: Minuten trennen die Schlange von der Arbeit, eine falsche Deklaration kostet schnell Tausende Franken. ' +
          'In dieser Rubrik bündeln wir Artikel zu Kontrollen an Brogeda, Stabio, Gandria und Chiasso, zu Freimengen, zur Einfuhr von Bargeld und zu den neuen automatischen Spuren. ' +
          'Jeder Artikel zitiert die offiziellen Quellen des Bundesamts für Zoll (BAZG/UDSC) und der italienischen Zollagentur und verlinkt zur Frontaliere-Ticino-Webcam-Karte und zum Wartezeit-Tool. ' +
          'Wir aktualisieren die Rubrik bei jeder operativen Änderung der Übergänge oder Anpassung der Freimengen.',
      },
      fr: {
        title: 'Douane et règles de frontière pour frontaliers',
        h1: 'Douane et règles de frontière pour frontaliers',
        description:
          'Actualités douanières pour frontaliers : franchises, contrôles, espèces, TVA à la frontière et nouvelles voies automatiques.',
        lede:
          'Douane pour frontaliers : franchises, contrôles, espèces, TVA à la frontière et nouveautés sur les passages de Brogeda, Stabio et Gandria.',
        context:
          'La douane est le vrai point de bascule de la journée d’un frontalier : quelques minutes séparent la file du travail, mais une mauvaise déclaration coûte vite des milliers de francs. ' +
          'Cette rubrique réunit des articles sur les contrôles à Brogeda, Stabio, Gandria et Chiasso, sur les franchises douanières, l’importation d’espèces et les nouvelles voies automatiques. ' +
          'Chaque article cite les sources officielles de l’Office fédéral de la douane (OFDF/UDSC) et de l’Agence des douanes italienne, et renvoie à la carte des webcams douanières et au tracker des temps d’attente de Frontaliere Ticino. ' +
          'Nous actualisons la rubrique à chaque évolution opérationnelle des passages ou ajustement des franchises.',
      },
    },
  },
};

const MAX_ARTICLES_PER_SECTION = 20;

// ── Helpers ───────────────────────────────────────────────────────

interface MatchedArticle {
  readonly id: BlogArticleId;
  readonly date: string;
  readonly authorName: string;
  readonly localeSlug: string;
  /** Pretty title derived from the canonical IT slug for the article. */
  readonly displayTitle: string;
}

/**
 * Convert a kebab-case slug into a human-readable title:
 *   `tredicesima-avs-iva-contributi` → `Tredicesima AVS IVA contributi`
 *
 * The raw slug is in Italian, so per-locale display can re-use it: it is
 * the most reliable signal we have without a translated title field. We
 * keep multi-letter acronyms (3+ chars in the original) capitalised.
 */
function humanizeSlug(slug: string): string {
  const ACRONYMS = new Set([
    'avs',
    'ahv',
    'lpp',
    'bvg',
    'iva',
    'vat',
    'mwst',
    'tva',
    'cu',
    'rsi',
    'ti',
    'ch',
    'eu',
    'usa',
    'snb',
    'bns',
    'tcs',
    'eoc',
    'osc',
    'oss',
    'lis',
    'inps',
    'irpef',
    'imu',
    'tasi',
    'isee',
    'ats',
    'asl',
    'tpl',
    'ffs',
    'sbb',
    'p2',
    'p3',
  ]);
  const words = slug.split('-').filter((w) => w.length > 0);
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      // Numerics like "2026", "13" stay as-is.
      if (/^[0-9]+$/.test(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function isSlugMatch(slug: string, keywords: readonly string[]): boolean {
  const lower = slug.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

interface BlogArticleLite {
  id: string;
  date: string;
  authorName?: string;
}

function safeArticles(): readonly BlogArticleLite[] {
  if (!Array.isArray(ARTICLES)) return [];
  // Only keep entries whose id has a known BLOG_SLUGS row — otherwise we
  // cannot build a per-locale URL and the link would 404.
  return ARTICLES.filter((a): a is typeof a => {
    if (!a || typeof a.id !== 'string' || typeof a.date !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(BLOG_SLUGS, a.id);
  });
}

function pickLatestArticles(
  section: SectionConfig,
  locale: SectionLocale,
  fallbackAuthor: string,
): MatchedArticle[] {
  const all = safeArticles();
  if (all.length === 0) return [];

  const matched: MatchedArticle[] = [];
  for (const a of all) {
    if (!isSlugMatch(a.id, section.keywords)) continue;
    const slugRow = BLOG_SLUGS[a.id as BlogArticleId];
    if (!slugRow) continue;
    const localeSlug = slugRow[locale] ?? slugRow.it ?? a.id;
    matched.push({
      id: a.id as BlogArticleId,
      date: a.date,
      authorName: a.authorName?.trim() || fallbackAuthor,
      localeSlug,
      displayTitle: humanizeSlug(slugRow.it ?? a.id),
    });
  }

  matched.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  return matched.slice(0, MAX_ARTICLES_PER_SECTION);
}

const BLOG_PREFIX_BY_LOCALE: Record<SectionLocale, string> = {
  it: '/articoli-frontaliere',
  en: '/en/cross-border-articles',
  de: '/de/grenzgaenger-artikel',
  fr: '/fr/articles-frontalier',
};

function buildArticleHref(localeSlug: string, locale: SectionLocale): string {
  const prefix = BLOG_PREFIX_BY_LOCALE[locale];
  return `${prefix}/${localeSlug}/`;
}

function formatDate(iso: string, locale: SectionLocale): string {
  // Strip a possible time portion (`...T16:33:18.777Z`) — articles use
  // ISO datetimes for cron-published items and bare YYYY-MM-DD for legacy.
  const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso;
  // Use a stable, locale-aware format via Intl. Falls back to ISO on error.
  try {
    const d = new Date(datePart + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return datePart;
    return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale === 'en' ? 'en-GB' : locale === 'de' ? 'de-CH' : 'fr-CH', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(d);
  } catch {
    return datePart;
  }
}

function renderArticleList(
  articles: readonly MatchedArticle[],
  locale: SectionLocale,
): string {
  const copy = LOCALE_COPY[locale];
  if (articles.length === 0) {
    // Defensive: shouldn't happen given keyword breadth, but keep a polite
    // empty-state so the page never renders an empty <ul>.
    return `<p style="margin:0 0 12px;color:var(--color-body)">${esc(
      locale === 'it'
        ? 'Articoli in arrivo.'
        : locale === 'en'
        ? 'Articles coming soon.'
        : locale === 'de'
        ? 'Artikel folgen in Kürze.'
        : 'Articles à venir.',
    )}</p>`;
  }

  const items = articles
    .map((a) => {
      const href = buildArticleHref(a.localeSlug, locale);
      const dateLabel = formatDate(a.date, locale);
      return `
        <li style="${CARD_PADDING_STYLE};${CARD_BODY_STYLE};margin:0 0 12px;list-style:none">
          <h3 style="margin:0 0 6px;font-size:18px;line-height:1.3"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(a.displayTitle)}</a></h3>
          <p style="margin:0;font-size:13px;color:var(--color-subtle)">
            <time datetime="${esc(a.date.slice(0, 10))}">${esc(dateLabel)}</time>
            <span aria-hidden="true"> · </span>
            <span>${esc(a.authorName)}</span>
          </p>
          <p style="margin:6px 0 0"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(copy.readMoreLabel)} →</a></p>
        </li>`;
    })
    .join('');

  return `<ul style="list-style:none;padding:0;margin:0">${items}</ul>`;
}

function buildItemListLd(
  articles: readonly MatchedArticle[],
  locale: SectionLocale,
): Record<string, unknown> {
  return {
    '@type': 'ItemList',
    itemListElement: articles.map((a, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: a.displayTitle,
      url: `${BASE_URL}${buildArticleHref(a.localeSlug, locale)}`,
    })),
  };
}

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
}

function renderSectionPage(opts: {
  section: SectionConfig;
  locale: SectionLocale;
  distDir: string;
  dateStamp: string;
}): RenderResult {
  const { section, locale, distDir, dateStamp } = opts;
  const copy = section.copy[locale];
  const localeCopy = LOCALE_COPY[locale];
  const urlPath = section.paths[locale];
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;

  const articles = pickLatestArticles(section, locale, localeCopy.editorialFallbackAuthor);

  // Hreflang — all 4 locales + x-default → IT canonical.
  const hreflangLines = LOCALES.map(
    (alt) =>
      `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${section.paths[alt]}">`,
  );
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${section.paths.it}">`,
  );
  const alternates = hreflangLines.join('\n');

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: localeCopy.homeBreadcrumb, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.h1, item: canonicalUrl },
    ],
  });

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.h1,
    headline: copy.h1,
    description: copy.description,
    inLanguage: locale,
    url: canonicalUrl,
    isPartOf: {
      '@type': 'WebSite',
      name: localeCopy.editorialOrg,
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: localeCopy.editorialOrg,
      url: BASE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      },
    },
    dateModified: dateStamp,
    mainEntity: buildItemListLd(articles, locale),
  });

  const articlesHtml = renderArticleList(articles, locale);

  const body = `
    <nav style="${BREADCRUMB_STYLE}" aria-label="breadcrumb">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(localeCopy.homeBreadcrumb)}</a>
      <span aria-hidden="true"> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin:0 0 24px">
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.lede)}</p>
    </header>
    <section style="margin:0 0 28px">
      <p style="margin:0 0 12px;color:var(--color-body);line-height:1.65;max-width:62ch">${esc(copy.context)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(localeCopy.latestLabel)}</h2>
      ${articlesHtml}
    </section>
    <section style="margin:32px 0 0">
      <p style="margin:0"><a href="${esc(homeUrl)}" style="${LINK_ACCENT_STYLE}">← ${esc(localeCopy.editorialOrg)}</a></p>
    </section>`;

  const bodyHtml = `<div style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">${body}</div>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.title)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, collectionLd],
    bodyHtml,
    distDir,
  });

  return { urlPath, html };
}

// ── Plugin entry ──────────────────────────────────────────────────

export function sectionPagesPlugin(): Plugin {
  return {
    name: 'section-pages',
    apply: 'build',
    async closeBundle() {
      try {
        if (process.env.SKIP_SECTION_PAGES === '1') {
          console.log('\x1b[33m[section-pages]\x1b[0m Skipped (SKIP_SECTION_PAGES=1)');
          return;
        }

        // Resolve dist relative to CWD (Vite always runs `closeBundle` after
        // emitting the bundle so `process.cwd()` is the project root in every
        // supported invocation; no separate rootDir argument needed).
        const distDir = np.resolve(process.cwd(), 'dist');
        if (!fs.existsSync(distDir)) {
          console.warn('\x1b[33m[section-pages]\x1b[0m dist/ missing — skipping');
          return;
        }

        const collector = new WriteCollector({ distDir, pluginName: 'sectionPagesPlugin' });
        const dateStamp = new Date().toISOString().slice(0, 10);

        let pagesWritten = 0;
        const t0 = Date.now();

        for (const sectionId of SECTION_IDS) {
          const section = SECTIONS[sectionId];
          for (const locale of LOCALES) {
            const rendered = renderSectionPage({ section, locale, distDir, dateStamp });
            const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
            collector.add(indexPath, rendered.html);
            pagesWritten++;
          }
        }

        const written = await collector.flush();
        console.log(
          `\x1b[36m[section-pages]\x1b[0m Generated ${pagesWritten} section pages — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.error('\x1b[31m[section-pages]\x1b[0m Plugin error:', err);
        throw err;
      }
    },
  };
}
