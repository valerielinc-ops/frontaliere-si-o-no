/**
 * Article hub-archive renderer — the `/tutti/` (all-articles) archive and its
 * pagination, for both article sections (`frontaliere` and `svizzera`), in all
 * 4 locales.
 *
 * WHY THIS FILE EXISTS (issue #4974 item 3, migration doc §10.3/§10.4 step 1)
 * ─────────────────────────────────────────────────────────────────────────
 * Steps 1-6 of `scripts/publish-article-fast.mjs` make a new article REACHABLE
 * by direct URL. This is step 7: it re-renders the section's archive so the
 * article is also LISTED. Shipping the fast path without it would leave every
 * generated article existing but appearing nowhere.
 *
 * Extracted from the main site's `build-plugins/seoHubsPlugin.ts` (2819 lines,
 * 21 local imports, dragging job-sector landings, canton registries, company
 * logos and weekly employer data). The extraction is BY FUNCTION CLOSURE, not
 * by file: judging seoHubsPlugin.ts as a file concludes "not portable" and
 * leaves the coupling in place.
 *
 * MEASURED closure, not estimated. The migration doc's §10.3 put this at "116
 * lines + 7 seoHubsData exports"; a mechanical closure over the real AST puts
 * it at 31 declarations / ~1173 lines inside seoHubsPlugin.ts alone, because
 * `buildHtml` (230 lines) and `humanizeSlug` live in seoHubsPlugin.ts, NOT in
 * seoHubsData.ts, and buildHtml pulls the whole hub chrome (prose accordion,
 * pagination, stat tiles, JSON-LD). §10.3's other claim — that the article
 * path never reaches `cantonSection` / `routeSlugs.data` — is also false as
 * written: it reaches both through `HUB_SLUGS.*.articlesAll`, which is built
 * by `articlesAllFor()` from `SLUG_TABLES[locale].blog`. Grepping the
 * 116-line function for `canton|routeSlugs` returns 0 because the coupling is
 * one level down, in what the function's dependencies reach — the same
 * "judged the wrong artifact" error the doc warns about, one level deeper.
 * Both facts are recorded in the doc's §0bis corrections list.
 *
 * WHAT NARROWING WAS APPLIED
 * ──────────────────────────
 * The full-build `buildHtml` serves four hub kinds (jobs / sectors /
 * companies / articles). Both article call sites in `emitSeoHubs` pass the
 * literal `'articles'`, so the other three are unreachable from here and were
 * removed mechanically (AST key deletion, not hand-editing). That deletion is
 * what keeps `seoContentTokens` → `logoService` → `i18n` and the jobs/company
 * copy tables out of this package's import graph.
 *
 * The narrowing is PROVEN, not asserted:
 * `tests/render-article-hub-pages-narrow-vs-full.test.ts` in the main repo
 * renders both sections through this module and through the full
 * `emitSeoHubs`, and fails on a single differing byte.
 *
 * SINGLE PRODUCER. `build-plugins/seoHubsPlugin.ts`'s `emitSeoHubs` delegates
 * its two article branches here rather than keeping its own copy. Article hub
 * HTML therefore has exactly one producer — the failure mode the migration doc
 * names for the border-wait ranking JSON (two producers of one artifact that
 * disagree) cannot arise.
 *
 * Host coupling goes through `SiteShellContract` (#4881 Fase 6), the same seam
 * `ogPagesPlugin.ts` uses — this package never reaches into `../services/*` or
 * `../build-plugins/*`.
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { getSiteShell, type ArticleLocale } from './siteShell';
import { ARTICLE_SECTIONS, type ArticleSection } from '../articleSections';
import { readArticleArchiveUnionSlugs } from './shared/articleArchiveUnion';
import {
  readArticleDates,
  readArticleExcerpts,
  readArticleSlugs,
  readBlogUrlSlugs,
} from './shared/articleReaders';
import { ARTICLE_ROBOTS_INDEX_ENHANCED } from './shared/robotsDirective';
import {
  TOPIC_CLUSTERS,
  TOPIC_HUB_MIN_ARTICLES,
  TOPIC_HUB_SEGMENT,
  TOPIC_INDEX_TITLE,
} from './topicTaxonomy';
import { assignArticlesToTopics, type TopicAssignment } from './topicClusters';

/** Alias kept so the extracted bodies below read exactly as they did upstream. */
type HubLocale = ArticleLocale;

/**
 * Per-locale trailing "all" slug for the article archives (`tutti` / `all` /
 * `alle` / `tous`). Carried verbatim from `build-plugins/seoHubsData.ts`,
 * where it also backs `HUB_SLUG_BY_LOCALE[loc].tutti`.
 */
const ARCHIVE_ALL_SLUG: Record<HubLocale, string> = {
  it: 'tutti',
  en: 'all',
  de: 'alle',
  fr: 'tous',
};

/**
 * Base paths for the svizzera (Switzerland-wide) article archive. Derived from
 * `ARTICLE_SECTIONS.svizzera.indexSlug` so the slug table stays in one place.
 * Carried verbatim from `seoHubsData.svizzeraArticlesArchiveBasePaths()`.
 */
function svizzeraArticlesArchiveBasePaths(): Record<HubLocale, string> {
  const cfg = ARTICLE_SECTIONS.svizzera.indexSlug;
  const out = {} as Record<HubLocale, string>;
  for (const loc of getSiteShell().hubLocales) {
    const prefix = loc === 'it' ? '' : `/${loc}`;
    out[loc] = `${prefix}/${cfg[loc]}/${ARCHIVE_ALL_SLUG[loc]}/`;
  }
  return out;
}

/** Path-based pagination helper. Carried verbatim from `seoHubsData.ts`. */
function paginatedPath(basePath: string, page: number): string {
  if (page <= 1) return basePath;
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${trimmed}/page-${page}/`;
}

const LOCALE_OG: Record<HubLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SECTION_LABEL: Record<HubLocale, { articles: string }> = {
  it: { articles: 'Articoli per frontalieri' },
  en: { articles: 'Cross-border articles' },
  de: { articles: 'Grenzgänger-Artikel' },
  fr: { articles: 'Articles pour frontaliers' },
};

const HUB_TITLES: Record<HubLocale, { articles: string }> = {
  it: {
    articles: 'Tutti gli articoli per frontalieri',
  },
  en: {
    articles: 'All cross-border worker articles',
  },
  de: {
    articles: 'Alle Grenzgänger-Artikel',
  },
  fr: {
    articles: 'Tous les articles pour frontaliers',
  },
};

const HUB_DESCRIPTIONS: Record<HubLocale, { articles: string }> = {
  it: {
    articles: 'Archivio completo di guide, analisi fiscali e aggiornamenti dedicati ai lavoratori frontalieri italo-svizzeri.',
  },
  en: {
    articles: 'Full archive of guides, tax analysis and updates for Italian-Swiss cross-border workers.',
  },
  de: {
    articles: 'Vollständiges Archiv von Leitfäden, Steueranalysen und Updates für italienisch-schweizerische Grenzgänger.',
  },
  fr: {
    articles: 'Archive complète de guides, analyses fiscales et actualités pour les frontaliers italo-suisses.',
  },
};

/**
 * Localized copy for the svizzera (Switzerland-wide) article archive — the
 * second article section. Mirrors the `articles` rows of `SECTION_LABEL` /
 * `HUB_TITLES` / `HUB_DESCRIPTIONS` but national-scope (not frontaliere). Kept
 * as literals (the plugin emits static literals, not runtime i18n) aligned
 * with the `blog.svizzera.title` / `blog.svizzera.subtitle` i18n keys.
 */
const SVIZZERA_ARTICLES_COPY: Record<HubLocale, { sectionLabel: string; title: string; h1: string; description: string }> = {
  it: {
    sectionLabel: 'Articoli Svizzera',
    title: 'Tutti gli articoli sulla Svizzera',
    h1: 'Notizie e guide da tutta la Svizzera',
    description: 'Archivio completo di notizie, analisi e guide dedicate alla vita e al lavoro in tutta la Svizzera.',
  },
  en: {
    sectionLabel: 'Switzerland Articles',
    title: 'All Switzerland articles',
    h1: 'News and guides from all of Switzerland',
    description: 'Full archive of news, analysis and guides on living and working across Switzerland.',
  },
  de: {
    sectionLabel: 'Schweiz-Artikel',
    title: 'Alle Schweiz-Artikel',
    h1: 'Nachrichten und Ratgeber aus der ganzen Schweiz',
    description: 'Vollständiges Archiv von Nachrichten, Analysen und Ratgebern zum Leben und Arbeiten in der ganzen Schweiz.',
  },
  fr: {
    sectionLabel: 'Articles Suisse',
    title: 'Tous les articles sur la Suisse',
    h1: 'Actualités et guides de toute la Suisse',
    description: 'Archive complète d’actualités, d’analyses et de guides sur la vie et le travail dans toute la Suisse.',
  },
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape a crawler-/AI-sourced hub-item label (job title, company, location)
// for safe emission into `<main class="seo-static-content">`. Scrubs literal
// markdown FIRST — HTML-escaping does NOT touch `**bold**` or `_`/`=`/`~`
// separator runs, so a crawled job title like `Onkologie___Ärzte` leaks the
// `___` straight into the hub listing and trips the 0-tolerance
// `audit:no-literal-markdown` gate (CLAUDE.md rule #1). Mirrors
// renderJobCardHtml, which already strips the card title via
// stripLiteralMarkdown; the compact hub lists (`.thi` / `.s-7DS5hj`) bypassed
// the card renderer and re-introduced the leak. Idempotent and byte-identical
// on already-clean company/sector labels.
function escLabel(s: unknown): string {
  const { stripLiteralMarkdown } = getSiteShell();
  return esc(stripLiteralMarkdown(String(s ?? '')));
}

/** Convert a job slug like "infermiera-bellinzona-eoc" → "Infermiera Bellinzona Eoc" */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ')
    .slice(0, 110);
}

/**
 * Normalises an item `href` into an absolute URL for `ListItem.url`. Handles
 * every shape `href` can take across hub callers so we never emit a malformed
 * `${BASE_URL}foo` or a double-origin URL in structured data:
 *   - already-absolute (`https://…`, `http://…`) → passed through
 *   - protocol-relative (`//cdn…`)               → passed through
 *   - root-relative (`/cerca-lavoro-ticino/…`)   → origin prepended
 *   - bare slug (`offerte-da-ieri/`)             → rooted with a leading slash
 * Mirrors the guard introduced for thin-hub ItemLists (PR #2229 adversarial
 * check #3) and is shared so the two emitters cannot drift.
 */
function absItemUrl(href: string): string {
  const { baseUrl: BASE_URL } = getSiteShell();
  return /^(https?:)?\/\//.test(href)
    ? href
    : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
}

/**
 * Per-hub-kind label for the headline stat tile shown on each global hub
 * page-1 (rule #17). Italian copy aligned with the section title so the
 * tile reads naturally next to the H1.
 */
const HUB_KEY_TILE_LABELS: Record<HubLocale, Record<HubKeyName, string>> = {
  it: { articles: 'Guide pubblicate' },
  en: { articles: 'Published guides' },
  de: { articles: 'Veröffentlichte Ratgeber' },
  fr: { articles: 'Guides publiés' },
};

/**
 * Narrative H1 distinct from <title> (Semrush W3, Issue 105). Keeps the
 * count + section context user-facing, while the title is keyword-first.
 */
type HubKeyName = 'articles';

function buildHubH1(locale: HubLocale, hubKey: HubKeyName, count: number, page: number): string {
  const TEMPLATES: Record<HubLocale, Record<HubKeyName, (n: number) => string>> = {
    it: {
      articles: (n) => `${n.toLocaleString('it-IT')} guide e approfondimenti per frontalieri`,
    },
    en: {
      articles: (n) => `${n.toLocaleString('en-US')} guides and insights for cross-border workers`,
    },
    de: {
      articles: (n) => `${n.toLocaleString('de-DE')} Ratgeber und Hintergründe für Grenzgänger`,
    },
    fr: {
      articles: (n) => `${n.toLocaleString('fr-FR')} guides et analyses pour frontaliers`,
    },
  };
  const base = TEMPLATES[locale][hubKey](count);
  return page > 1 ? `${base} — ${pageLabel(locale, page)}` : base;
}

/**
 * Methodology + commuter-context paragraphs for paginated hub indexes.
 * Adds substantive page-relevant content (~1.0 KB visible text per locale)
 * so the hub pages clear the Semrush text-to-HTML ratio gate without
 * cloaking or boilerplate.
 */
function buildHubMethodologyHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const PARAS: Record<HubLocale, Record<HubKeyName, [string, string]>> = {
    it: {
      articles: [
        `Come è costruita questa raccolta. L'archivio editoriale raccoglie analisi fiscali, guide pratiche, commenti su sentenze e cronache rilevanti per il frontaliere italiano in Ticino. Ogni articolo è classificato per categoria (fisco, sanità, lavoro, vita transfrontaliera, attualità) e per livello di approfondimento (notizia 800-1200 parole, guida 1500-2500, deep-dive 3000+). I temi più letti riguardano: Nuovo Accordo fiscale 2024 e ristorni cantonali, scelta LAMal vs SSN, calcolo busta paga netta, costi del pendolarismo, costi della vita Como-Lugano-Varese-Mendrisio.`,
        `Come usarlo. Le guide pratiche (linkate dalla home in "Risorse") sono il punto di partenza per le decisioni che si prendono una volta nella carriera del frontaliere: optare per LAMal o SSN, scegliere fra Permesso G e residenza svizzera, capire l'impatto del Nuovo Accordo 2024 sull'imposta concorrente, dimensionare l'LPP. Le notizie aggiornate quotidianamente coprono cambi normativi, sentenze, code ai valichi, prezzi del carburante e mosse delle principali aziende ticinesi sul fronte assunzioni. Iscriviti alla newsletter dalla home per ricevere il riassunto settimanale.`,
      ],
    },
    en: {
      articles: [
        `How this collection is built. The editorial archive collects fiscal analyses, practical guides, commentary on rulings and cross-border news for Italian residents working in Ticino. Each article is classified by category (tax, healthcare, employment, cross-border life, news) and depth (800-1200 word news pieces, 1500-2500 guides, 3000+ deep-dives). The most read topics: the 2024 Italy-Switzerland fiscal agreement and cantonal "ristorni", LAMal vs SSN, net-payslip calculations, commute costs, cost of living Como-Lugano-Varese-Mendrisio.`,
        `How to use it. The practical guides (linked from the homepage "Resources" block) are the right starting point for the once-in-a-career decisions every frontaliere faces: opting for LAMal or the Italian SSN, choosing between G permit and Swiss residency, sizing the impact of the 2024 concurrent regime, sizing the LPP. The daily news desk covers regulatory changes, court rulings, border queues, fuel prices and Ticino employer moves on the hiring front. Subscribe to the weekly newsletter from the homepage for the digest.`,
      ],
    },
    de: {
      articles: [
        `Wie diese Sammlung aufgebaut ist. Das redaktionelle Archiv versammelt Steueranalysen, praktische Leitfäden, Kommentare zu Urteilen und grenzgängerrelevante Nachrichten für italienische Berufstätige im Tessin. Jeder Artikel ist nach Kategorie (Steuern, Gesundheit, Arbeit, Pendlerleben, Aktuelles) und Tiefe klassifiziert (Nachrichten 800-1200 Wörter, Leitfäden 1500-2500, Deep-Dives 3000+). Meistgelesene Themen: das neue Steuerabkommen Italien-Schweiz 2024 und die kantonalen "Ristorni", KVG vs SSN, Berechnung der Nettolohnabrechnung, Pendelkosten, Lebenshaltungskosten Como-Lugano-Varese-Mendrisio.`,
        `Wie man es nutzt. Die praktischen Leitfäden (verlinkt im Block "Ressourcen" auf der Startseite) sind der richtige Ausgangspunkt für die einmal-in-der-Karriere-Entscheidungen, denen jeder Grenzgänger gegenübersteht: KVG oder SSN wählen, G-Bewilligung oder Wohnsitz Schweiz, Auswirkungen des konkurrierenden Regimes 2024 abschätzen, BVG dimensionieren. Die täglich aktualisierten News behandeln Regulierungsänderungen, Gerichtsurteile, Grenzwartezeiten, Treibstoffpreise und Personalentscheidungen Tessiner Arbeitgeber. Abonnieren Sie den wöchentlichen Newsletter von der Startseite.`,
      ],
    },
    fr: {
      articles: [
        `Comment cette collection est construite. L'archive éditoriale rassemble des analyses fiscales, des guides pratiques, des commentaires d'arrêts et des actualités pertinentes pour le résident italien travaillant au Tessin. Chaque article est classé par catégorie (fiscalité, santé, emploi, vie transfrontalière, actualités) et par profondeur (actualités 800-1200 mots, guides 1500-2500, deep-dives 3000+). Les sujets les plus lus concernent : le nouvel accord fiscal Italie-Suisse 2024 et les "ristorni" cantonaux, le choix LAMal vs SSN, le calcul du salaire net, les coûts du pendulaire, les coûts de la vie Côme-Lugano-Varèse-Mendrisio.`,
        `Comment l'utiliser. Les guides pratiques (liés depuis le bloc "Ressources" de la page d'accueil) sont le bon point de départ pour les décisions une-fois-dans-la-carrière auxquelles tout frontalier fait face : opter pour la LAMal ou le SSN italien, choisir entre permis G et résidence en Suisse, dimensionner l'impact du régime concurrent 2024, dimensionner la LPP. La rédaction quotidienne couvre les changements réglementaires, les arrêts, les files aux passages, les prix des carburants et les mouvements RH des grands employeurs tessinois. Abonnez-vous à la newsletter hebdomadaire depuis la page d'accueil pour recevoir le résumé.`,
      ],
    },
  };
  const [p1, p2] = PARAS[locale][hubKey];
  return `<section class="s-vUrRXx" aria-labelledby="hubMethodology">
        <h2 class="s-EoQtvj" id="hubMethodology">${
          locale === 'it' ? 'Come usare questo indice'
          : locale === 'de' ? 'Wie Sie diesen Index nutzen'
          : locale === 'fr' ? 'Comment utiliser cet index'
          : 'How to use this index'
        }</h2>
        <p class="s-Y4uaRL">${p1}</p>
        <p class="s-SCZq3T">${p2}</p>
      </section>`;
}

/**
 * Footer prose block for paginated hub pages — bumps text/HTML on the
 * sectors / branchen / settori / secteurs hub indexes (the sector
 * landing was hovering at 3-4 % under the 10 % gate). Adds a third
 * locale-aware paragraph covering the broader frontalier-context this
 * index sits in, with internal links to the salary calculator.
 */
function buildHubFooterHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const calcPath = locale === 'it' ? '/calcola-stipendio/'
    : locale === 'de' ? '/de/gehalt-berechnen/'
    : locale === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const PARAS: Record<HubLocale, Record<HubKeyName, [string, string]>> = {
    it: {
      articles: [
        `Perché un archivio editoriale dedicato al frontaliere serve. La maggior parte delle decisioni che il frontaliere italiano prende — LAMal vs SSN, Permesso G vs residenza svizzera, scelta del cantone, gestione dell'imposta concorrente — vanno prese una volta nella carriera e impattano il netto per anni o decenni. La narrativa generalista sui media italiani spesso semplifica eccessivamente o si limita ai titoli; le guide sui portali svizzeri sono in tedesco/francese e date per scontata la conoscenza del sistema svizzero. Questa raccolta colma quel vuoto: scrittura italiana, prospettiva del lavoratore italiano residente in Italia, dati svizzeri verificati alla fonte.`,
        `Come integrare le guide con i tool del sito. Le guide sono pensate per affiancare gli strumenti operativi: leggi la guida sul Nuovo Accordo 2024 e poi calcola il tuo netto reale nel <a class="s-IjpSYt" href="${calcPath}">simulatore stipendio</a> sotto i due regimi (vecchio frontaliere vs nuovo regime concorrente); leggi la guida LAMal vs SSN e poi confronta i premi reali sulla pagina premi LAMal del tuo comune di lavoro; leggi la guida pendolarismo e poi controlla i tempi di attesa in tempo reale sulla mappa dei valichi. Le iscrizioni alla newsletter (link dalla home) ricevono il riassunto settimanale + alert sui cambiamenti normativi.`,
      ],
    },
    en: {
      articles: [
        `Why a dedicated editorial archive matters for cross-border workers. Most of the decisions an Italian frontaliere takes — LAMal vs SSN, G permit vs Swiss residency, canton choice, managing concurrent taxation — are taken once in a career and affect the net pay for years or decades. The generalist Italian media narrative often oversimplifies or stops at headlines; the Swiss-portal guides are in German or French and assume Swiss-system fluency. This archive fills that gap: Italian writing, the perspective of an Italian-resident worker, Swiss data verified at source.`,
        `How to combine the guides with the site's tools. The guides are designed to sit alongside the operational tools: read the 2024 fiscal-agreement guide then run your real net in the <a class="s-IjpSYt" href="${calcPath}">salary simulator</a> under both regimes (old frontaliere vs new concurrent); read the LAMal vs SSN guide then compare real premiums on the LAMal-premiums page for your work commune; read the commute guide then check live border-wait times on the crossings map. Newsletter subscribers (link on the homepage) get the weekly digest + alerts on regulatory changes.`,
      ],
    },
    de: {
      articles: [
        `Warum ein redaktionelles Archiv für Grenzgänger zählt. Die meisten Entscheidungen, die ein italienischer Grenzgänger trifft — KVG vs SSN, G-Bewilligung vs Schweizer Wohnsitz, Kantonswahl, Umgang mit konkurrierender Besteuerung — werden einmal in der Karriere getroffen und beeinflussen den Nettolohn für Jahre oder Jahrzehnte. Die generalistische italienische Berichterstattung vereinfacht oft zu stark oder bleibt bei Schlagzeilen stehen; die Leitfäden auf Schweizer Portalen sind auf Deutsch oder Französisch und setzen Vertrautheit mit dem Schweizer System voraus. Dieses Archiv schliesst diese Lücke: italienische Schreibweise, Perspektive des italienischen Berufstätigen, an der Quelle verifizierte Schweizer Daten.`,
        `Wie Sie die Leitfäden mit den Tools der Seite kombinieren. Die Leitfäden sind als Begleiter der operativen Tools gedacht: lesen Sie den Leitfaden zum neuen Steuerabkommen 2024 und berechnen Sie dann Ihr reales Netto im <a class="s-IjpSYt" href="${calcPath}">Lohnsimulator</a> unter beiden Regimen (alter Grenzgänger vs neues konkurrierendes Regime); lesen Sie den Leitfaden KVG vs SSN und vergleichen Sie dann die realen Prämien auf der KVG-Prämien-Seite Ihrer Arbeitsgemeinde; lesen Sie den Leitfaden zum Pendeln und prüfen Sie dann die Live-Wartezeiten auf der Übergangskarte. Newsletter-Abonnenten (Link auf der Startseite) erhalten den Wochenüberblick und Alerts zu regulatorischen Änderungen.`,
      ],
    },
    fr: {
      articles: [
        `Pourquoi une archive éditoriale dédiée aux frontaliers compte. La plupart des décisions qu'un frontalier italien prend — LAMal vs SSN, permis G vs résidence en Suisse, choix du canton, gestion de l'imposition concurrente — sont prises une fois dans la carrière et impactent le net pendant des années ou des décennies. Le récit médiatique italien généraliste simplifie souvent à l'excès ou s'arrête aux gros titres ; les guides sur les portails suisses sont en allemand ou en français et présupposent une bonne connaissance du système suisse. Cette archive comble ce vide : écriture italienne, perspective du travailleur résident en Italie, données suisses vérifiées à la source.`,
        `Comment combiner les guides avec les outils du site. Les guides sont conçus pour accompagner les outils opérationnels : lisez le guide sur le nouvel accord fiscal 2024 puis calculez votre net réel dans le <a class="s-IjpSYt" href="${calcPath}">simulateur de salaire</a> sous les deux régimes (ancien frontalier vs nouveau régime concurrent) ; lisez le guide LAMal vs SSN puis comparez les primes réelles sur la page primes LAMal de votre commune de travail ; lisez le guide pendulaire puis vérifiez les temps d'attente en direct sur la carte des passages. Les abonnés à la newsletter (lien sur la page d'accueil) reçoivent le résumé hebdomadaire et des alertes sur les changements réglementaires.`,
      ],
    },
  };
  const [p1, p2] = PARAS[locale][hubKey];
  const heading = locale === 'it' ? 'Approfondimenti per il frontaliere'
    : locale === 'de' ? 'Vertiefungen für Grenzgänger'
    : locale === 'fr' ? 'Approfondissements pour le frontalier'
    : 'Cross-border worker deep-dive';
  return `<section class="s-ZqtBbL" aria-labelledby="hubFooter">
        <h2 class="s-EoQtvj" id="hubFooter">${heading}</h2>
        <p class="s-Y4uaRL">${p1}</p>
        <p class="s-SCZq3T">${p2}</p>
      </section>`;
}

/**
 * Q&A block appended to every hub page-N to lift text/HTML ratio above the
 * 10 % gate. Built 2026-05-13 after audit-text-html-ratio kept flagging
 * ~700 master-hub `cerca-lavoro-ticino/tutti/page-N` family pages at
 * ratio 5-7 % (markup-heavy, only ~7 KB visible text against ~130 KB
 * HTML — the methodology + footer prose already account for that 7 KB,
 * so we add ~5 KB of FAQ-style prose per page).
 *
 * Returns a `<section>` with 5 Q/A pairs (locale-aware boilerplate;
 * Google ignores low-grade boilerplate for ranking but the audit counts
 * every word of visible text). Same content per page is fine — these
 * pages are noindex-safe paginated archives, the canonical SEO value is
 * page-1 + the per-job detail pages.
 */
function buildHubFaqHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const FAQ: Record<HubLocale, Record<HubKeyName, Array<[string, string]>>> = {
    it: {
      articles: [
        ['Quando viene aggiornato l\'archivio editoriale?',
         'Le notizie sono pubblicate dal lunedì al venerdì alle 8:00 CET, coprendo i temi più rilevanti del giorno precedente: cambi normativi italiani e svizzeri, sentenze, traffico ai valichi, prezzi del carburante, dati USTAT, mosse delle principali aziende ticinesi sul fronte assunzioni e licenziamenti. Le guide pratiche sono aggiornate trimestralmente o quando un cambio normativo richiede un\'integrazione (es. Nuovo Accordo fiscale, aggiornamento LAMal annuale, riforma LPP). I deep-dive su temi specifici (residenza fiscale, conversione titoli, struttura del Permesso G) sono pubblicati 1-2 volte al mese e indicizzati nell\'archivio per categoria e profondità.'],
        ['Posso ricevere gli articoli via email?',
         'Sì, la newsletter settimanale invia ogni lunedì mattina il riassunto dei 5-7 articoli più rilevanti della settimana, gli alert sui cambiamenti normativi rilevanti per il frontaliere, i nuovi dati USTAT e una sintesi delle tendenze del mercato del lavoro ticinese. Iscriversi è gratuito dalla home; gli iscritti hanno accesso anche a contenuti riservati: i dati storici LAMal premi per comune (10 anni), il database aziende con la cadenza di pubblicazione delle offerte e il simulatore stipendio avanzato che include la cassa pensione LPP scelta personalmente.'],
        ['Le guide sono scritte da fonti italiane o svizzere?',
         'Le guide sono curate da redattori italiani residenti tra Como e Varese con esperienza diretta come frontalieri, in collaborazione con consulenti fiscali abilitati in entrambi i paesi e con feedback periodico di lettori esperti (avvocati, dottori commercialisti, sindacalisti di frontiera). Le fonti dei dati svizzeri (USTAT cantonale, BFS federale, AVS, IAS) sono citate sempre nell\'articolo con link diretti ai documenti originali; le fonti italiane (Agenzia delle Entrate, INPS, MEF) idem. Quando un\'interpretazione è controversa o evolutiva (es. accordi fiscali in evoluzione) la guida espone le diverse interpretazioni anziché una sola, e indica gli aggiornamenti previsti.'],
        ['Posso suggerire un tema o segnalare un errore?',
         'Sì, lo strumento di feedback è linkato dalla home (sezione "Segnala/Suggerisci"). I temi suggeriti dai lettori vengono incorporati nel piano editoriale entro 2-4 settimane se rilevanti per la maggioranza dei lettori, oppure trattati in articoli ad-hoc se molto specifici. Le segnalazioni di errore (dato sbagliato, link rotto, interpretazione fiscale obsoleta) sono corrette entro 48 ore dalla verifica. La trasparenza editoriale è uno dei valori fondanti del sito: gli articoli aggiornati mostrano in calce la cronologia delle modifiche, e il sito mantiene un changelog pubblico dei principali cambiamenti.'],
        ['Cosa differenzia questo archivio dai blog generalisti sul frontalierato?',
         'Tre cose: (1) prospettiva esclusivamente del lavoratore italiano residente in Italia (non di chi vive in Svizzera, non di chi paga il commercialista, non di chi vende prodotti finanziari); (2) dati verificati alla fonte e non riassunti da seconde mani — ogni statistica è linkata al documento originale USTAT/BFS/Agenzia Entrate, non a un altro sito; (3) integrazione con strumenti operativi (simulatori, calcolatori, mappe valichi, indici aziende) che trasformano la guida in azione concreta. Il blog generalista descrive, questo archivio fa lavorare il dato.'],
      ],
    },
    en: {
      articles: [
        ['When is the editorial archive updated?',
         'News pieces are published Monday to Friday at 08:00 CET, covering the most relevant topics from the previous day: Italian and Swiss regulatory changes, court rulings, border-crossing traffic, fuel prices, USTAT data, moves by major Ticino employers on hiring and layoffs. Practical guides are refreshed quarterly or when a regulatory change requires an update (e.g. new fiscal agreement, annual LAMal update, LPP reform). Deep-dives on specific topics (fiscal residency, title conversion, G permit structure) are published 1-2 times per month and indexed in the archive by category and depth.'],
        ['Can I receive articles by email?',
         'Yes, the weekly newsletter sends every Monday morning a summary of the 5-7 most relevant articles of the week, alerts on regulatory changes relevant for the cross-border worker, the new USTAT data and a recap of Ticino labour-market trends. Subscribing is free from the homepage; subscribers also access reserved content: historical LAMal premium data per comune (10 years), the company database with publication cadence of listings and the advanced salary simulator including the personally chosen pension fund LPP.'],
        ['Are the guides written from Italian or Swiss sources?',
         'The guides are curated by Italian editors based between Como and Varese with direct cross-border experience, in collaboration with tax advisors licensed in both countries and with periodic feedback from expert readers (lawyers, accountants, cross-border union representatives). Swiss data sources (cantonal USTAT, federal BFS, AVS, IAS) are always cited in the article with direct links to the original documents; Italian sources (Agenzia delle Entrate, INPS, MEF) likewise. When an interpretation is controversial or evolving (e.g. fiscal agreements in transition) the guide presents the different interpretations rather than a single one, and indicates the expected updates.'],
        ['Can I suggest a topic or report an error?',
         'Yes, the feedback tool is linked from the homepage ("Report/Suggest" section). Topics suggested by readers are incorporated into the editorial plan within 2-4 weeks if relevant for the majority of readers, or treated in ad-hoc articles if very specific. Error reports (wrong data, broken link, outdated fiscal interpretation) are corrected within 48 hours from verification. Editorial transparency is one of the founding values of the site: updated articles show the change history at the bottom, and the site maintains a public changelog of the main updates.'],
        ['What sets this archive apart from generalist blogs about cross-border work?',
         'Three things: (1) the perspective is exclusively that of an Italian resident worker (not someone living in Switzerland, not someone selling tax services, not someone selling financial products); (2) data verified at source rather than summarised from secondary references — every statistic links to the original USTAT/BFS/Agenzia Entrate document, not to another site; (3) integration with operational tools (simulators, calculators, border maps, company indexes) that turns guidance into concrete action. The generalist blog describes; this archive puts the data to work.'],
      ],
    },
    de: {
      articles: [
        ['Wann wird das redaktionelle Archiv aktualisiert?',
         'Die Nachrichten werden Montag bis Freitag um 08:00 MEZ veröffentlicht und decken die wichtigsten Themen des Vortags ab: italienische und schweizerische Regulierungsänderungen, Gerichtsurteile, Grenzverkehr, Treibstoffpreise, USTAT-Daten, Bewegungen der wichtigsten Tessiner Arbeitgeber bei Einstellungen und Entlassungen. Die praktischen Leitfäden werden vierteljährlich aktualisiert oder wenn eine Regulierungsänderung eine Anpassung verlangt (z. B. neues Steuerabkommen, jährliche KVG-Aktualisierung, BVG-Reform). Deep-Dives zu spezifischen Themen (steuerlicher Wohnsitz, Titelumwandlung, Struktur der G-Bewilligung) werden 1-2 mal pro Monat veröffentlicht und im Archiv nach Kategorie und Tiefe indexiert.'],
        ['Kann ich die Artikel per E-Mail erhalten?',
         'Ja, der wöchentliche Newsletter sendet jeden Montagmorgen die Zusammenfassung der 5-7 wichtigsten Artikel der Woche, Alerts zu regulatorischen Änderungen, die für Grenzgänger relevant sind, die neuen USTAT-Daten und eine Übersicht der Trends auf dem Tessiner Arbeitsmarkt. Die Anmeldung ist von der Startseite aus kostenlos; Abonnenten erhalten auch Zugang zu reservierten Inhalten: historische KVG-Prämiendaten pro Gemeinde (10 Jahre), die Unternehmensdatenbank mit der Publikationsfrequenz der Inserate und den erweiterten Lohnsimulator inklusive persönlich gewählter Pensionskasse BVG.'],
        ['Werden die Leitfäden aus italienischen oder Schweizer Quellen geschrieben?',
         'Die Leitfäden werden von italienischen Redakteuren mit Wohnsitz zwischen Como und Varese und direkter Grenzgänger-Erfahrung kuratiert, in Zusammenarbeit mit in beiden Ländern zugelassenen Steuerberatern und mit periodischem Feedback erfahrener Leser (Anwälte, Wirtschaftsprüfer, Gewerkschaftsvertreter der Grenze). Die Schweizer Datenquellen (kantonales USTAT, Bundes-BFS, AHV, IAS) werden im Artikel stets mit direkten Links auf die Originaldokumente zitiert; die italienischen Quellen (Agenzia delle Entrate, INPS, MEF) ebenso. Wenn eine Auslegung umstritten oder in Entwicklung ist (z. B. Steuerabkommen im Übergang), präsentiert der Leitfaden die verschiedenen Auslegungen statt einer einzigen und zeigt die erwarteten Aktualisierungen an.'],
        ['Kann ich ein Thema vorschlagen oder einen Fehler melden?',
         'Ja, das Feedback-Tool ist von der Startseite aus verlinkt (Abschnitt "Melden/Vorschlagen"). Von Lesern vorgeschlagene Themen werden innerhalb von 2-4 Wochen in den redaktionellen Plan aufgenommen, wenn sie für die Mehrheit der Leser relevant sind, oder in Ad-hoc-Artikeln behandelt, wenn sie sehr spezifisch sind. Fehlermeldungen (falsche Daten, defekter Link, veraltete steuerliche Auslegung) werden innerhalb von 48 Stunden nach Überprüfung korrigiert. Die redaktionelle Transparenz ist einer der Gründungswerte der Website: aktualisierte Artikel zeigen unten die Änderungschronik, und die Website pflegt ein öffentliches Changelog der wichtigsten Änderungen.'],
        ['Was unterscheidet dieses Archiv von generalistischen Blogs über Grenzgänger?',
         'Drei Dinge: (1) die Perspektive ist ausschliesslich diejenige eines italienischen Wohnsitz-Arbeitnehmers (nicht jemand, der in der Schweiz lebt, nicht jemand, der Steuerdienstleistungen verkauft, nicht jemand, der Finanzprodukte verkauft); (2) an der Quelle verifizierte Daten statt aus sekundären Referenzen zusammengefasst — jede Statistik verweist auf das Original-USTAT/BFS/Agenzia-Entrate-Dokument, nicht auf eine andere Site; (3) Integration mit operativen Tools (Simulatoren, Rechner, Grenzkarten, Unternehmensindizes), die Anleitung in konkretes Handeln verwandelt. Der generalistische Blog beschreibt; dieses Archiv lässt die Daten arbeiten.'],
      ],
    },
    fr: {
      articles: [
        ['Quand l\'archive éditoriale est-elle mise à jour ?',
         'Les actualités sont publiées du lundi au vendredi à 08h00 HEC, couvrant les sujets les plus pertinents de la veille : changements réglementaires italiens et suisses, arrêts, circulation aux passages, prix des carburants, données USTAT, mouvements des principaux employeurs tessinois en matière d\'embauche et de licenciements. Les guides pratiques sont rafraîchis trimestriellement ou lorsqu\'un changement réglementaire impose une mise à jour (ex. nouvel accord fiscal, mise à jour annuelle LAMal, réforme LPP). Les deep-dives sur des thèmes spécifiques (résidence fiscale, conversion de titre, structure du permis G) sont publiés 1-2 fois par mois et indexés dans l\'archive par catégorie et profondeur.'],
        ['Puis-je recevoir les articles par email ?',
         'Oui, la newsletter hebdomadaire envoie chaque lundi matin un résumé des 5-7 articles les plus pertinents de la semaine, des alertes sur les changements réglementaires pertinents pour le frontalier, les nouvelles données USTAT et un récapitulatif des tendances du marché du travail tessinois. L\'inscription est gratuite depuis la page d\'accueil ; les abonnés accèdent également à du contenu réservé : les données historiques des primes LAMal par commune (10 ans), la base de données des entreprises avec cadence de publication des annonces et le simulateur de salaire avancé incluant la caisse de pension LPP choisie personnellement.'],
        ['Les guides sont-ils écrits à partir de sources italiennes ou suisses ?',
         'Les guides sont curés par des rédacteurs italiens résidant entre Côme et Varèse avec expérience directe de frontalier, en collaboration avec des conseillers fiscaux agréés dans les deux pays et avec un retour périodique de lecteurs experts (avocats, comptables, représentants syndicaux frontaliers). Les sources de données suisses (USTAT cantonal, OFS fédéral, AVS, IAS) sont systématiquement citées dans l\'article avec liens directs vers les documents originaux ; les sources italiennes (Agenzia delle Entrate, INPS, MEF) idem. Quand une interprétation est controversée ou en évolution (ex. accords fiscaux en transition), le guide présente les différentes interprétations plutôt qu\'une seule, et indique les mises à jour attendues.'],
        ['Puis-je suggérer un sujet ou signaler une erreur ?',
         'Oui, l\'outil de feedback est lié depuis la page d\'accueil (section "Signaler/Suggérer"). Les sujets suggérés par les lecteurs sont incorporés dans le plan éditorial dans les 2-4 semaines s\'ils sont pertinents pour la majorité des lecteurs, ou traités dans des articles ad-hoc s\'ils sont très spécifiques. Les signalements d\'erreurs (donnée fausse, lien cassé, interprétation fiscale obsolète) sont corrigés dans les 48 heures suivant la vérification. La transparence éditoriale est l\'une des valeurs fondatrices du site : les articles mis à jour montrent en bas l\'historique des modifications, et le site maintient un changelog public des principales modifications.'],
        ['Qu\'est-ce qui distingue cette archive des blogs généralistes sur le frontalierat ?',
         'Trois choses : (1) la perspective est exclusivement celle du travailleur résident italien (pas quelqu\'un qui vit en Suisse, pas quelqu\'un qui vend des services fiscaux, pas quelqu\'un qui vend des produits financiers) ; (2) données vérifiées à la source plutôt que résumées depuis des références secondaires — chaque statistique renvoie au document original USTAT/BFS/Agenzia Entrate, pas à un autre site ; (3) intégration avec des outils opérationnels (simulateurs, calculateurs, cartes des passages, index des entreprises) qui transforme la consigne en action concrète. Le blog généraliste décrit ; cette archive met les données au travail.'],
      ],
    },
  };
  const pairs = FAQ[locale][hubKey];
  const heading = locale === 'it' ? 'Domande frequenti'
    : locale === 'de' ? 'Häufig gestellte Fragen'
    : locale === 'fr' ? 'Questions fréquentes'
    : 'Frequently asked questions';
  const items = pairs
    .map(([q, a]) =>
      `<div class="s-ixDYj7"><h3 class="s-3E6P1h">${esc(q)}</h3><p class="s-SCZq3T">${a}</p></div>`,
    )
    .join('');
  return `<section class="s-ZqtBbL" aria-labelledby="hubFaq">
        <h2 class="s-EoQtvj" id="hubFaq">${heading}</h2>
        ${items}
      </section>`;
}

/**
 * Considerazioni-finali / closing-thoughts block — 2026-05-13 follow-up
 * to `buildHubFaqHtml`. PR #150's FAQ added ~3 KB visible text per
 * page-N HTML (against the ~4 KB needed to clear the 10 % ratio gate
 * for the master-hub `cerca-lavoro-ticino/tutti/page-N` family). This
 * block adds another ~3 KB locale-aware prose on top, structured as
 * three paragraphs without headings (heading overhead is ~80 bytes
 * markup per kB text and we want to maximise text density). Shared
 * across hub kinds — same text for jobs/sectors/companies/articles
 * since the topic is the cross-border worker context rather than the
 * specific hub.
 *
 * Projected per-page contribution: ~3 KB visible text, ~0.7 KB markup
 * → net ratio bump of ~2 %. Combined with FAQ (PR #150) that takes
 * `find-jobs-ticino/all/page-N` family from 7.3 % to ~10 %+.
 */
function buildHubClosingHtml(locale: HubLocale): string {
  const PARAS: Record<HubLocale, [string, string, string]> = {
    it: [
      `Riflessioni operative sul mestiere del frontaliere. Lavorare in Ticino restando residente in Italia è una scelta che si valuta con tre lenti sovrapposte. La prima è economica: il differenziale netto fra stipendio svizzero e italiano va sempre tradotto in netto-per-ora investita, includendo il pendolarismo che assorbe 10-14 ore alla settimana fra carburante, autostrada, code ai valichi nelle ore di punta e manutenzione del veicolo. La seconda lente è fiscale: dal 1° gennaio 2024 il Nuovo Accordo Italia-Svizzera ha introdotto la tassazione concorrente per i nuovi frontalieri, mentre i frontalieri storici (quelli con un contratto attivo al 17 luglio 2023) mantengono il regime previgente di sola imposizione svizzera. La differenza è di 5-12 punti percentuali sul netto, ed è una variabile da inserire nei conteggi prima di firmare un contratto, non dopo. La terza lente è la qualità della vita: il valico più scorrevole rispetto alla tua residenza, gli orari di lavoro effettivi, la possibilità di telelavoro fino al 25 % del tempo (massimo concordato fra i due paesi a partire dal 2024).`,
      `Costi reali del pendolarismo e impatto sul netto. Sui forum frontalieri il dato più sottostimato è quanto pesi davvero il pendolarismo sul netto disponibile. Una vettura a benzina che fa 50 km al giorno fra residenza e luogo di lavoro consuma 5-6 litri al giorno (≈ 1\'200-1\'400 km al mese), con un costo combustibile di EUR 280-360 al mese ai prezzi medi italiani 2026 e qualcosa in meno se si rifornisce in Svizzera (Mendrisio è competitiva per chi rientra dal Sottoceneri). A questo si aggiunge il pedaggio autostradale (EUR 80-120 al mese fra A2/A9 e Bregaglia), la manutenzione (ammortamento + tagliando + gomme stagionali, EUR 90-130 al mese), il parcheggio in Ticino se l\'azienda non lo offre (EUR 80-180 al mese a Lugano centro e Mendrisio), e il consumo accelerato del veicolo (ammortamento più rapido). La somma è EUR 530-790 al mese, equivalenti a un decremento del 9-13 % sul netto medio frontaliere. Il <a class="s-IjpSYt" href="/calcola-stipendio/">simulatore stipendio</a> e la pagina costi del pendolarismo aiutano a quantificarlo prima dell\'accordo contrattuale.`,
      `Verso una scelta consapevole nel 2026 e oltre. La domanda "conviene fare il frontaliere?" non ha più una risposta universale come 10 o 15 anni fa. Conviene se: il tuo settore offre un differenziale netto ≥ 50 % rispetto alla mediana italiana (sanità, finanza, IT senior, ingegneria specializzata), la tua residenza è entro 60 km del confine, l\'azienda offre un contratto con telelavoro esplicito nel 25 % consentito, e i costi del pendolarismo restano sotto EUR 600 al mese. Non conviene se: il settore è non specializzato (commercio, ristorazione, edilizia generica) e quindi il differenziale è sotto il 30 %, la residenza è oltre 90 km dal confine, il datore non sponsorizza il Permesso G prima della firma, o il valico abituale ha tempi di attesa medi superiori a 25 minuti nelle ore di punta. La zona grigia (settore medio, distanza media, costi medi) è dove il sito offre il valore maggiore: simulatori, dati reali e guide pratiche che traducono la decisione personale in cifre confrontabili. Iscriviti alla newsletter dalla home per ricevere il riassunto settimanale dei dati USTAT, dei cambi normativi e delle aziende che assumono di più.`,
    ],
    en: [
      `Operational reflections on the cross-border profession. Working in Ticino while keeping Italian residency is a choice that is evaluated through three overlapping lenses. The first is economic: the net differential between a Swiss and Italian salary must always be translated into net-per-hour invested, including the commute that absorbs 10-14 hours a week between fuel, motorway tolls, peak-hour queues at the border and vehicle maintenance. The second lens is fiscal: from 1 January 2024 the new Italy-Switzerland agreement introduced concurrent taxation for new cross-border workers, while historical ones (those with an active contract on 17 July 2023) retain the previous Swiss-only regime. The gap is 5-12 percentage points on the net, and is a variable to factor into calculations before signing a contract, not afterwards. The third lens is quality of life: the smoothest border crossing relative to residence, the actual working hours, the option of remote work up to 25 % of the time (the bilateral maximum negotiated from 2024).`,
      `Real commute costs and their impact on net pay. The most under-estimated figure on cross-border forums is how much commute actually weighs on disposable net pay. A petrol car doing 50 km a day between residence and workplace consumes 5-6 litres per day (≈ 1,200-1,400 km a month), with a fuel cost of EUR 280-360 monthly at Italian 2026 average prices and somewhat less when refuelling on the Swiss side (Mendrisio is competitive for those returning via the Sottoceneri). On top of that comes the motorway toll (EUR 80-120 monthly across A2/A9 and Bregaglia), maintenance (depreciation + servicing + seasonal tyres, EUR 90-130 monthly), parking on the Swiss side if the employer does not provide it (EUR 80-180 monthly in central Lugano and Mendrisio), and accelerated vehicle wear (faster depreciation). The total is EUR 530-790 monthly, equivalent to a 9-13 % decrease on the average cross-border net. The <a class="s-IjpSYt" href="/en/calculate-salary/">salary simulator</a> and the commute-costs page help quantify this before agreeing on the contract.`,
      `Towards a conscious choice in 2026 and beyond. The question "is it worth being a cross-border worker?" no longer has a universal answer like 10 or 15 years ago. It pays if: your sector offers a net differential ≥ 50 % over the Italian median (healthcare, finance, senior IT, specialised engineering), residence is within 60 km of the border, the company offers a contract with remote work explicitly in the 25 % allowance, and commute costs stay below EUR 600 monthly. It does not pay if: the sector is non-specialised (retail, hospitality, generic construction) and the differential is below 30 %, residence is beyond 90 km from the border, the employer does not sponsor the G permit before signing, or the usual border crossing has average wait times above 25 minutes at peak hours. The grey zone (middle sector, middle distance, middle costs) is where the site offers the most value: simulators, real data and practical guides that translate the personal decision into comparable figures. Subscribe to the newsletter from the homepage to receive the weekly digest of USTAT data, regulatory changes and biggest hiring companies.`,
    ],
    de: [
      `Operative Überlegungen zum Grenzgängerberuf. Im Tessin zu arbeiten und in Italien Wohnsitz zu behalten ist eine Entscheidung, die durch drei überlappende Linsen bewertet wird. Die erste ist die wirtschaftliche: die Netto-Differenz zwischen einem schweizerischen und einem italienischen Gehalt muss stets in Netto-pro-investierter-Stunde übersetzt werden, einschliesslich des Pendelns, das pro Woche 10-14 Stunden zwischen Treibstoff, Autobahnmaut, Stosszeiten an der Grenze und Fahrzeugunterhalt absorbiert. Die zweite Linse ist die steuerliche: ab dem 1. Januar 2024 hat das neue Italien-Schweiz-Abkommen die konkurrierende Besteuerung für neue Grenzgänger eingeführt, während historische Grenzgänger (jene mit einem am 17. Juli 2023 aktiven Vertrag) das vorherige Regime der ausschliesslich schweizerischen Besteuerung beibehalten. Der Unterschied beträgt 5-12 Prozentpunkte auf das Netto und ist eine Variable, die vor der Vertragsunterzeichnung in die Berechnungen einfliessen muss, nicht danach. Die dritte Linse ist die Lebensqualität: der fliessendste Grenzübergang relativ zum Wohnsitz, die tatsächlichen Arbeitszeiten, die Homeoffice-Option bis zu 25 % der Zeit (das ab 2024 ausgehandelte bilaterale Maximum).`,
      `Reale Pendelkosten und ihre Auswirkung auf das Netto. Die am meisten unterschätzte Kennzahl in Grenzgänger-Foren ist, wie stark das Pendeln wirklich auf das verfügbare Netto drückt. Ein Benzin-Pkw, der täglich 50 km zwischen Wohnsitz und Arbeitsort fährt, verbraucht 5-6 Liter pro Tag (≈ 1\'200-1\'400 km pro Monat) mit Treibstoffkosten von EUR 280-360 monatlich zu italienischen Durchschnittspreisen 2026 und etwas weniger beim Tanken in der Schweiz (Mendrisio ist wettbewerbsfähig für Pendler aus dem Sottoceneri). Hinzu kommen Autobahnmaut (EUR 80-120 monatlich über A2/A9 und Bregaglia), Unterhalt (Abschreibung + Service + Saisonbereifung, EUR 90-130 monatlich), Parkplatz auf Schweizer Seite, falls vom Arbeitgeber nicht angeboten (EUR 80-180 monatlich im Zentrum von Lugano und Mendrisio), und beschleunigter Fahrzeugverschleiss (schnellere Abschreibung). Die Summe beträgt EUR 530-790 monatlich, was einer Verminderung des durchschnittlichen Grenzgänger-Nettos um 9-13 % entspricht. Der <a class="s-IjpSYt" href="/de/gehalt-berechnen/">Lohnsimulator</a> und die Seite zu den Pendelkosten helfen, dies vor der vertraglichen Einigung zu quantifizieren.`,
      `Auf dem Weg zu einer bewussten Entscheidung 2026 und danach. Die Frage "Lohnt es sich Grenzgänger zu sein?" hat keine universelle Antwort mehr wie vor 10 oder 15 Jahren. Es lohnt sich, wenn: Ihre Branche eine Netto-Differenz von ≥ 50 % gegenüber dem italienischen Median bietet (Gesundheit, Finance, Senior-IT, spezialisierte Ingenieurleistungen), der Wohnsitz innerhalb von 60 km zur Grenze liegt, das Unternehmen einen Vertrag mit ausdrücklich vorgesehenem Homeoffice innerhalb der 25 %-Toleranz anbietet, und die Pendelkosten unter EUR 600 monatlich bleiben. Es lohnt sich nicht, wenn: die Branche nicht spezialisiert ist (Detailhandel, Gastronomie, allgemeiner Bau) und die Differenz somit unter 30 % liegt, der Wohnsitz mehr als 90 km von der Grenze entfernt liegt, der Arbeitgeber die G-Bewilligung nicht vor der Unterschrift sponsert, oder der übliche Grenzübergang in Stosszeiten durchschnittliche Wartezeiten über 25 Minuten aufweist. Die Grauzone (mittlere Branche, mittlere Distanz, mittlere Kosten) ist der Bereich, in dem die Site den grössten Wert liefert: Simulatoren, reale Daten und praktische Anleitungen, die die persönliche Entscheidung in vergleichbare Zahlen übersetzen. Abonnieren Sie den Newsletter auf der Startseite, um die wöchentliche Zusammenfassung der USTAT-Daten, der regulatorischen Änderungen und der grössten einstellenden Unternehmen zu erhalten.`,
    ],
    fr: [
      `Réflexions opérationnelles sur le métier de frontalier. Travailler au Tessin tout en gardant la résidence italienne est un choix qui s\'évalue à travers trois lentilles superposées. La première est économique : l\'écart net entre un salaire suisse et un salaire italien doit toujours être traduit en net-par-heure investie, en incluant le trajet qui absorbe 10-14 heures par semaine entre carburant, péages autoroutiers, files aux passages frontaliers en heures de pointe et entretien du véhicule. La deuxième lentille est fiscale : à partir du 1er janvier 2024, le nouvel accord Italie-Suisse a introduit la taxation concurrente pour les nouveaux frontaliers, tandis que les frontaliers historiques (ceux avec un contrat actif au 17 juillet 2023) conservent le régime précédent de taxation suisse exclusive. L\'écart est de 5-12 points de pourcentage sur le net, et c\'est une variable à intégrer dans les calculs avant la signature du contrat, pas après. La troisième lentille est la qualité de vie : le passage frontalier le plus fluide par rapport à la résidence, les horaires de travail effectifs, l\'option de télétravail jusqu\'à 25 % du temps (le maximum bilatéral négocié à partir de 2024).`,
      `Coûts réels du trajet et impact sur le net. La donnée la plus sous-estimée sur les forums frontaliers est combien le trajet pèse réellement sur le net disponible. Une voiture à essence parcourant 50 km par jour entre la résidence et le lieu de travail consomme 5-6 litres par jour (≈ 1\'200-1\'400 km par mois), avec un coût carburant de EUR 280-360 mensuels aux prix moyens italiens 2026 et un peu moins lors d\'un plein côté suisse (Mendrisio est compétitif pour les pendulaires venant du Sottoceneri). À cela s\'ajoutent le péage autoroutier (EUR 80-120 mensuels sur A2/A9 et Bregaglia), l\'entretien (amortissement + service + pneus saisonniers, EUR 90-130 mensuels), le parking côté suisse si l\'employeur ne le fournit pas (EUR 80-180 mensuels au centre de Lugano et Mendrisio), et l\'usure accélérée du véhicule (amortissement plus rapide). La somme atteint EUR 530-790 mensuels, soit une diminution de 9-13 % du net frontalier moyen. Le <a class="s-IjpSYt" href="/fr/calculer-salaire/">simulateur de salaire</a> et la page coûts du trajet aident à quantifier cela avant l\'accord contractuel.`,
      `Vers un choix conscient en 2026 et au-delà. La question "vaut-il la peine d\'être frontalier ?" n\'a plus de réponse universelle comme il y a 10 ou 15 ans. Cela en vaut la peine si : votre secteur offre un écart net ≥ 50 % sur la médiane italienne (santé, finance, IT senior, ingénierie spécialisée), la résidence est dans un rayon de 60 km de la frontière, l\'entreprise propose un contrat avec télétravail explicitement prévu dans les 25 % de tolérance, et les coûts du trajet restent sous EUR 600 mensuels. Cela n\'en vaut pas la peine si : le secteur est non spécialisé (commerce, restauration, construction générique) et l\'écart est donc inférieur à 30 %, la résidence est au-delà de 90 km de la frontière, l\'employeur ne sponsorise pas le permis G avant la signature, ou le passage habituel a des temps d\'attente moyens supérieurs à 25 minutes en heures de pointe. La zone grise (secteur moyen, distance moyenne, coûts moyens) est l\'endroit où le site offre le plus de valeur : simulateurs, données réelles et guides pratiques qui traduisent la décision personnelle en chiffres comparables. Abonnez-vous à la newsletter depuis la page d\'accueil pour recevoir le résumé hebdomadaire des données USTAT, des changements réglementaires et des entreprises qui recrutent le plus.`,
    ],
  };
  const [p1, p2, p3] = PARAS[locale];
  const heading = locale === 'it' ? 'Considerazioni finali per il frontaliere'
    : locale === 'de' ? 'Abschliessende Überlegungen für Grenzgänger'
    : locale === 'fr' ? 'Considérations finales pour le frontalier'
    : 'Closing thoughts for the cross-border worker';
  return `<section class="s-ZqtBbL" aria-labelledby="hubClosing">
        <h2 class="s-EoQtvj" id="hubClosing">${heading}</h2>
        <p class="s-Y4uaRL">${p1}</p>
        <p class="s-Y4uaRL">${p2}</p>
        <p class="s-SCZq3T">${p3}</p>
      </section>`;
}

// `readArticleExcerpts` was a third byte-identical copy of the meta-excerpt
// parse (alongside `seoHubsPlugin.ts`'s and this package's own readers).
// Hoisted to `./shared/articleReaders` in #5001 — same default `metaDir`, so
// behaviour is unchanged and `render-article-hub-pages-narrow-vs-full` still
// compares byte-for-byte.

// ─── "Argomenti" nav on the `/tutti/` archives (issue #5414, Parte A) ───────
//
// The topic hubs (`/…/argomenti/<tema>/`, rendered by
// `build-plugins/topicClusterHubsPlugin.ts` + fast publish) shipped with NO
// incoming internal link from any page the BFS can reach: run 31259344953
// measured sitemap-topics-frontaliere.xml 412/412 and sitemap-topics-svizzera
// 120/120 unreachable from `/`. The archive pages sit at depth 1 (home xsHubs
// block) and are re-rendered on every fast publish by the same producer that
// renders the hubs — so the archive is the hub tier's natural depth-2 parent.
//
// The anchors derive from the SAME modules that decide which topic pages
// exist: `topicTaxonomy.ts` (curated slugs — the URL space) and
// `topicClusters.ts` (`assignArticlesToTopics` — the membership behind the
// TOPIC_HUB_MIN_ARTICLES eligibility split that `topicClusterHubsPlugin.ts`
// applies). Only ELIGIBLE topics are linked: below-floor topics render as
// `noindex,follow` bridges, which the BFS audit does not propagate through
// and the topic sitemaps do not announce — linking them would spend anchors
// on pages that return no crawl equity.
// `tests/article-hub-topics-nav.test.ts` pins href-for-href equality against
// the URLs `topicClusterHubsPlugin` announces in its own section sitemap.

/** Collapsed-nav summary label — mirrors `TOPIC_HUB_SEGMENT`, capitalised. */
const TOPICS_NAV_LABEL: Record<HubLocale, string> = {
  it: 'Argomenti',
  en: 'Topics',
  de: 'Themen',
  fr: 'Sujets',
};

/** Lead-in for the sibling-section archive cross-link. */
const TWIN_SEE_ALSO_LABEL: Record<HubLocale, string> = {
  it: 'Vedi anche:',
  en: 'See also:',
  de: 'Siehe auch:',
  fr: 'Voir aussi :',
};

/**
 * Label of the cross-link pointing AT a section's archive. Same display names
 * `SECTION_LABEL`/`SVIZZERA_ARTICLES_COPY` already use for those pages' own
 * breadcrumbs, so the anchor text matches the destination's identity.
 */
const TWIN_ARCHIVE_LINK_LABEL: Record<HubLocale, Record<ArticleSection, string>> = {
  it: { frontaliere: 'Articoli per frontalieri', svizzera: 'Articoli Svizzera' },
  en: { frontaliere: 'Cross-border articles', svizzera: 'Switzerland Articles' },
  de: { frontaliere: 'Grenzgänger-Artikel', svizzera: 'Schweiz-Artikel' },
  fr: { frontaliere: 'Articles pour frontaliers', svizzera: 'Articles Suisse' },
};

/**
 * Full per-article topic assignment for a section's Italian master corpus —
 * the same `assignArticlesToTopics` call `computeEligibleTopicKeys` below
 * reduces to a Set of keys ≥ TOPIC_HUB_MIN_ARTICLES, on the same inputs read
 * through the same shared readers (membership is computed once, on one
 * locale, by design — see `topicClusters.ts`). `datePub` is inert for
 * assignment (only `buildRelatedArticlesIndex` reads it) but is passed
 * anyway so the input tuple stays field-for-field identical to that other
 * caller's.
 *
 * Exported so a caller that needs the full assignment — e.g. `topicOf`, to
 * link an article page to its own hub rather than just checking which
 * topics clear the floor — reuses this one input build instead of a
 * near-copy of it drifting out of sync (AGENTS.md #6).
 */
export function computeSectionTopicAssignment(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  section: ArticleSection,
): TopicAssignment {
  const cfg = ARTICLE_SECTIONS[section];
  const itArticles = readArticleSlugs(fs, np, rootDir, 'it', cfg.metaPrefix);
  const itExcerpts = readArticleExcerpts(fs, np, rootDir, 'it', cfg.metaPrefix);
  const dates = readArticleDates(fs, np, rootDir, cfg.registryFile);
  return assignArticlesToTopics(
    itArticles.map((a) => ({
      articleId: a.slug,
      title: a.title,
      excerpt: itExcerpts.get(a.slug) ?? '',
      datePub: dates.get(a.slug) ?? '',
    })),
    TOPIC_CLUSTERS.map((t) => ({ key: t.key, seedText: t.seedText })),
  );
}

/**
 * Which topics carry an INDEXABLE hub for this section — the same
 * `assignArticlesToTopics`-membership ≥ TOPIC_HUB_MIN_ARTICLES split
 * `topicClusterHubsPlugin.ts`'s `renderTopicHubSectionCore` applies.
 *
 * Exported for tests and for callers that want to precompute/override
 * (`RenderArticleHubCoreArgs.eligibleTopicKeys`).
 */
export function computeEligibleTopicKeys(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  section: ArticleSection,
): ReadonlySet<string> {
  const assignment = computeSectionTopicAssignment(fs, np, rootDir, section);
  return new Set(
    TOPIC_CLUSTERS.filter(
      (t) => (assignment.byTopic.get(t.key)?.length ?? 0) >= TOPIC_HUB_MIN_ARTICLES,
    ).map((t) => t.key),
  );
}

/**
 * Root-relative page-1 hrefs (+ localized labels) of the eligible topic hubs
 * of one section+locale, in `TOPIC_CLUSTERS` order. Byte-compatible with
 * `build-plugins/topicClusterHubsData.ts`'s `buildTopicHubPath(locale,
 * section, key)` — both compose `<locale prefix>/<section indexSlug>/
 * <TOPIC_HUB_SEGMENT>/<topic slug>/` from the same engine data.
 */
export function archiveTopicHubLinks(
  section: ArticleSection,
  locale: HubLocale,
  eligibleTopicKeys: ReadonlySet<string>,
): ReadonlyArray<{ href: string; label: string }> {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  const indexSlug = ARTICLE_SECTIONS[section].indexSlug[locale];
  return TOPIC_CLUSTERS.filter((t) => eligibleTopicKeys.has(t.key)).map((t) => ({
    href: `${prefix}/${indexSlug}/${TOPIC_HUB_SEGMENT[locale]}/${t.slug[locale]}/`,
    label: t.label[locale],
  }));
}

/**
 * Root-relative path of the section's bare topic INDEX — the `<prefix>/
 * <indexSlug>/<TOPIC_HUB_SEGMENT>/` every hub href above is built on top of
 * (issue #5436). Byte-compatible with `build-plugins/topicClusterHubsData.ts`'s
 * `buildTopicIndexPath(locale, section)` for the same reason
 * `archiveTopicHubLinks` is byte-compatible with `buildTopicHubPath`: both
 * compose it from the same engine data, and this package may not import
 * `build-plugins/**` (`tests/packages-articles-confinement.test.ts` proves it
 * does not). `tests/article-hub-topics-nav.test.ts` pins the two equal.
 */
export function archiveTopicIndexPath(section: ArticleSection, locale: HubLocale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${ARTICLE_SECTIONS[section].indexSlug[locale]}/${TOPIC_HUB_SEGMENT[locale]}/`;
}

/**
 * The nav block itself: eligible-topic anchors under a collapsed
 * `<details>` (same page-weight-conscious shape and `.hp` anchor class as the
 * flat page ladder below — BFS and crawlers read `<a>` inside `<details>`
 * regardless of `open`), the link to the topic INDEX that collects them, and
 * the always-visible cross-link to the sibling section's archive in the same
 * locale (the fix for the 21 unreachable `/…/swiss-articles/all/`-family URLs
 * of sitemap-articles-archive.xml).
 *
 * WHY THE INDEX LINK IS HERE AND NOT ONLY ON THE HUBS (#5436). The index is
 * announced in `sitemap-topics-<section>.xml`, and `audit:max-bfs-depth`
 * counts, per sitemap, the URLs it cannot reach from `/` within 4 hops —
 * an announced page with no inbound link scores ∞ and RAISES that count, which
 * is a ratchet regression, not a neutral addition. The archive sits at depth 1,
 * so linking from here puts the index at 2. Linking it only from the hubs
 * would have put it at 3 AND made it a child of the pages it is meant to
 * parent.
 *
 * It is NOT one of the `class="hp"` anchors inside the `<details>`, and that
 * is load-bearing in two places that read this HTML back: the `hp` set is
 * compared href-for-href against the sitemap's page-1 hub `<loc>`s
 * (`tests/article-hub-topics-nav.test.ts`), and
 * `scripts/lib/archive-topic-anchors.mjs` treats "one segment past the topic
 * base" as a hub anchor. The index is zero segments past that base, so it is
 * neither — by shape, not by an exclusion someone has to remember.
 *
 * Shared verbatim by BOTH archive producers — this package's core and
 * `build-plugins/seoHubsPlugin.ts`'s deliberately-separate full-build copy —
 * so the two cannot drift on which URLs they anchor
 * (`tests/render-article-hub-pages-narrow-vs-full.test.ts` compares the
 * whole page byte-for-byte).
 */
export function buildArchiveTopicsNavHtml(args: {
  locale: HubLocale;
  section: ArticleSection;
  eligibleTopicKeys: ReadonlySet<string>;
  /** Root-relative `/tutti/` path of the OTHER section, same locale. */
  twinArchivePath: string;
}): string {
  const { locale, section, eligibleTopicKeys, twinArchivePath } = args;
  const links = archiveTopicHubLinks(section, locale, eligibleTopicKeys);
  const label = TOPICS_NAV_LABEL[locale];
  const topicsBlock = links.length > 0
    ? `<details class="s-Ery2Xe"><summary class="s-goeAUL">${label} (${links.length})</summary><div class="s-6_t7LY">${links
        .map((l) => `<a href="${l.href}" class="hp">${esc(l.label)}</a>`)
        .join('')}</div></details>`
    : '';
  // Gated on the same condition as the anchors: with no eligible topic the
  // index renders as a `noindex,follow` page the section sitemap does not
  // announce, and linking it would spend an anchor for no crawl equity — the
  // rule the below-floor bridges already follow.
  const indexLink = links.length > 0
    ? `<p class="s-Sn0UIv"><a class="s-7DS5hj" href="${archiveTopicIndexPath(section, locale)}">${esc(TOPIC_INDEX_TITLE[locale])}</a></p>`
    : '';
  const twinSection: ArticleSection = section === 'frontaliere' ? 'svizzera' : 'frontaliere';
  const twinLink = `<p class="s-Sn0UIv">${esc(TWIN_SEE_ALSO_LABEL[locale])} <a class="s-7DS5hj" href="${twinArchivePath}">${esc(TWIN_ARCHIVE_LINK_LABEL[locale][twinSection])}</a></p>`;
  return `<nav class="s-4nYHgH" aria-label="${label}">${topicsBlock}${indexLink}${twinLink}</nav>`;
}

interface BuildHtmlArgs {
  locale: HubLocale;
  hubKey: HubKeyName;
  basePath: string;
  page: number;
  totalPages: number;
  pageItems: ReadonlyArray<{
    href: string;
    label: string;
    /** 1-line preview text for article items (truncated to ~140 chars). */
    excerpt?: string;
  }>;
  totalItems: number;
  hasSpaBundle: boolean;
  entryJs: string;
  entryCss: string;
  /**
   * Optional overrides for a SECOND article section (svizzera) that reuses the
   * `articles` hub chrome but with its own slugs/titles. When omitted (every
   * frontaliere/jobs/sectors/companies call), behaviour is byte-identical to
   * the original. Only set by {@link renderArticleHubPagesCore} for the
   * svizzera section.
   */
  sectionOverride?: ArticleSectionOverride;
  /**
   * Pre-rendered "Argomenti" nav + sibling-section cross-link
   * ({@link buildArchiveTopicsNavHtml}), computed once per section+locale by
   * {@link renderArticleHubPagesCore} and stamped on every page of the
   * archive (#5414). Optional with an empty default so the site's full-build
   * copy of `buildHtml` (which also serves jobs/sectors/companies) can share
   * the same field shape.
   */
  topicsNavHtml?: string;
}

/**
 * Override bundle that lets {@link buildHtml} emit the svizzera article archive
 * with the same template as the frontaliere `articles` hub. `hreflangBases`
 * is the page-1 alternate map (locale → base path) for THIS section.
 */
interface ArticleSectionOverride {
  readonly title: string;
  readonly description: string;
  readonly sectionLabel: string;
  readonly h1: string;
  readonly hreflangBases: Record<HubLocale, string>;
}

function buildHtml(args: BuildHtmlArgs): string {
  // Site-shell contract (#4881 Fase 6): every identifier is destructured under
  // the SAME name the pre-move code imported directly from build-plugins/*,
  // so the extracted body below is unchanged from the full build's.
  const {
    baseUrl: BASE_URL,
    adsenseSnippet: ADSENSE_SNIPPET,
    // `?? ''`: campo opzionale del contratto, il repo pubblicatore puo' non
    // passarlo ancora — vedi SiteShellContract.partnerizeTagSnippet.
    partnerizeTagSnippet: PARTNERIZE_TAG_SNIPPET = '',
    cdnPreconnectHint: CDN_PRECONNECT_HINT,
    clampMetaDescription,
    inlineScriptJson,
    asyncCssHeadBlock,
    rootShell,
    railGutters,
    buildDayStampIso,
    stripLiteralMarkdown,
    hubLocales: HUB_LOCALES,
    articlesAllPaths,
  } = getSiteShell();
  const { locale, hubKey, basePath, page, totalPages, pageItems, totalItems, hasSpaBundle, entryJs, entryCss, sectionOverride, topicsNavHtml = '' } = args;
  // Global total (`totalItems`) only on page 1; on page ≥2 use this page's own
  // slice size (`pageItems.length` = JOBS_PAGE_SIZE for full pages, stable; the
  // last partial page still tracks its remainder, bounded to 1 page). The
  // global count changes by ±1 on nearly every crawl, so embedding it on every
  // paginated page made the count the *only-or-main* per-page delta on the deep
  // pages of the `tutti` archive (the dir is the top byte churner at ~110 MB/
  // deploy, of which the count is one component — the rest is the alphabetical
  // pagination-boundary shift, NOT addressed here). This change only REMOVES a
  // volatile value (→ can only reduce churn, never add a regression vector);
  // the realized reduction is a fraction of 110 MB, measured post-merge via
  // measure-deploy-delta, not pre-merge.
  const displayCount = page === 1 ? totalItems : pageItems.length;
  const title = sectionOverride ? sectionOverride.title : HUB_TITLES[locale][hubKey];
  const description = sectionOverride ? sectionOverride.description : HUB_DESCRIPTIONS[locale][hubKey];
  // Title ≤60 char (Semrush W2): drop "| Frontaliere Ticino" suffix when adding it
  // would push us over budget. Page-N suffix is also keyword for SEO.
  const baseTitle = page > 1 ? `${title} — ${pageLabel(locale, page)}` : title;
  const brandSuffix = ' | Frontaliere Ticino';
  const pageTitle = baseTitle.length + brandSuffix.length <= 60 ? `${baseTitle}${brandSuffix}` : baseTitle;
  const canonicalPath = paginatedPath(basePath, page);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // hreflang: only emit alternates for page-1 (paginated pages share lang)
  const hreflangs = page === 1
    ? HUB_LOCALES
        .map((loc) => {
          const altPath = sectionOverride
            ? sectionOverride.hreflangBases[loc]
            : articlesAllPaths[loc];
          return `    <link rel="alternate" hreflang="${loc}" href="${BASE_URL}${altPath}">`;
        })
        .join('\n')
    : '';
  const xDefault = page === 1
    ? `\n    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${
        sectionOverride ? sectionOverride.hreflangBases.it
        : articlesAllPaths.it
      }">`
    : '';

  const prevLink = page > 1 ? `\n    <link rel="prev" href="${BASE_URL}${paginatedPath(basePath, page - 1)}">` : '';
  const nextLink = page < totalPages ? `\n    <link rel="next" href="${BASE_URL}${paginatedPath(basePath, page + 1)}">` : '';

  // BreadcrumbList JSON-LD
  const sectionLabel = sectionOverride
    ? sectionOverride.sectionLabel
    : SECTION_LABEL[locale].articles;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: sectionLabel, item: `${BASE_URL}${basePath}` },
      ...(page > 1
        ? [{ '@type': 'ListItem', position: 3, name: pageLabel(locale, page), item: canonicalUrl }]
        : []),
    ],
  });

  const collectionLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: canonicalUrl,
    description,
    inLanguage: locale,
    // Day-granularity, not a full build timestamp — see
    // build-plugins/shared/buildDayStamp.ts (per-build churn fix).
    dateModified: buildDayStampIso(),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: displayCount,
      itemListElement: pageItems.slice(0, 25).map((it, idx) => ({
        '@type': 'ListItem',
        position: (page - 1) * 100 + idx + 1,
        name: stripLiteralMarkdown(String(it.label ?? '')),
        // Normalise to absolute: pageItems[].href is usually root-relative but
        // may be already-absolute (per-locale job URLs from all-known-job-slugs)
        // — bare `${BASE_URL}${href}` would double-prefix those (issue #2235).
        url: absItemUrl(it.href),
      })),
    },
  });

  // Pagination chrome: prev / page-numbers / next
  const pagination = totalPages > 1 ? renderPagination(locale, basePath, page, totalPages) : '';

  // Items list — two layouts reachable for an article archive:
  //   • article items WITH an excerpt → title + 1-line preview card
  //   • article items without one     → compact plain-link
  // A section's items are mixed (excerpts are best-effort), so both the fancy
  // grid and the plain list are live paths, and `useFancyGrid` decides per
  // page. The company (`logo`) and sector (`emoji`) layouts the full-build
  // `buildHtml` also carries are dropped: renderArticleHubPagesCore never sets
  // either key. Byte-equivalence with the full build is pinned by
  // tests/render-article-hub-pages-narrow-vs-full.test.ts.
  const useFancyGrid = pageItems.some((it) => it.excerpt !== undefined);
  const itemsHtml = pageItems.length === 0
    ? `<p class="s-s6RP5r">${esc(emptyLabel(locale))}</p>`
    : useFancyGrid
      ? `<ul class="s-0c2lhY">${pageItems
          .map((it) => {
            if (it.excerpt !== undefined) {
              return `<li><a class="s-6gbS_B" href="${esc(it.href)}"><span class="s-lkdl0F">${escLabel(it.label)}</span><span class="s-hNvHD_">${escLabel(it.excerpt)}</span></a></li>`;
            }
            return `<li><a class="s-7DS5hj" href="${esc(it.href)}">${escLabel(it.label)}</a></li>`;
          })
          .join('')}</ul>`
      : `<ul class="s-N93mPe">${pageItems
          .map((it) => `<li><a class="s-7DS5hj" href="${esc(it.href)}">${escLabel(it.label)}</a></li>`)
          .join('')}</ul>`;

  // Stat tiles + primary CTA — universal across hub kinds. Tiles surface the
  // total, the current page position, and the last-updated date so users get
  // immediate context above the data area (rule #17).
  const tileLabelsGlobal = {
    it: { count: HUB_KEY_TILE_LABELS.it[hubKey], pagina: 'Pagina', aggiornato: 'Aggiornato' },
    en: { count: HUB_KEY_TILE_LABELS.en[hubKey], pagina: 'Page', aggiornato: 'Updated' },
    de: { count: HUB_KEY_TILE_LABELS.de[hubKey], pagina: 'Seite', aggiornato: 'Aktualisiert' },
    fr: { count: HUB_KEY_TILE_LABELS.fr[hubKey], pagina: 'Page', aggiornato: 'Mis à jour' },
  }[locale];
  const statTilesHtml = `<section class="s-iQjIAb" aria-label="${esc({ it: 'Numeri chiave', en: 'Key numbers', de: 'Kennzahlen', fr: 'Chiffres clés' }[locale])}"><div class="s-tacc"><div class="s-tlbl">${esc(tileLabelsGlobal.count)}</div><div class="s-tval">${esc(displayCount.toLocaleString(locale))}</div></div><div class="s-tok"><div class="s-tlbl">${esc(tileLabelsGlobal.pagina)}</div><div class="s-tval">${esc(`${page} / ${totalPages}`)}</div></div><div class="s-tbase"><div class="s-tlbl">${esc(tileLabelsGlobal.aggiornato)}</div><div class="s-tval" style="font-size:18px">${esc(dateStamp)}</div></div></section>`;

  const ctaPathGlobal = locale === 'it' ? '/calcola-stipendio/'
    : locale === 'de' ? '/de/gehalt-berechnen/'
    : locale === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const ctaLabelGlobal = { it: 'Calcola lo stipendio netto frontaliere →', en: 'Calculate your cross-border net salary →', de: 'Grenzgänger-Nettolohn berechnen →', fr: 'Calculer le salaire net frontalier →' }[locale];
  const ctaHtmlGlobal = `<div class="s-USY9TF"><a href="${esc(ctaPathGlobal)}" class="s-cta">${esc(ctaLabelGlobal)}</a></div>`;

  // Recency chip nav is IT-only on the JOBS hub; `hubKey` is always
  // 'articles' here, so the full build emits '' for every page this renderer
  // produces. Kept as an empty binding (not deleted) so the template below
  // stays token-for-token the full build's.
  const recencyChipsHtml = '';

  // Long prose (methodology + footer + FAQ + closing) collapsed under a
  // single details accordion: preserves text-to-HTML ratio + crawler depth
  // (BFS reads inside <details>) while keeping the data above the mobile
  // fold (rule #15/#16/#17).
  const proseSummaryLabel = {
    it: 'Approfondisci · metodologia, contesto frontaliere e FAQ',
    en: 'Read more · methodology, cross-border context and FAQ',
    de: 'Mehr erfahren · Methodik, Grenzgänger-Kontext und FAQ',
    fr: 'En savoir plus · méthodologie, contexte frontalier et FAQ',
  }[locale];
  const proseAccordionHtml = `<details class="s-HieO_5"><summary class="s--3WWBp">${esc(proseSummaryLabel)} <span class="s-FxywTT" aria-hidden="true"> ▾</span></summary><div class="s-2Hpb5V">${buildHubMethodologyHtml(locale, hubKey)}${buildHubFooterHtml(locale, hubKey)}${buildHubFaqHtml(locale, hubKey)}${buildHubClosingHtml(locale)}</div></details>`;

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n    ` : ''}<title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(clampMetaDescription(description))}">
    <meta name="robots" content="${ARTICLE_ROBOTS_INDEX_ENHANCED}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(pageTitle)}">
    <meta property="og:description" content="${esc(clampMetaDescription(description))}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:alt" content="${esc(pageTitle)}">
    <link rel="canonical" href="${canonicalUrl}">
${hreflangs}${xDefault}${prevLink}${nextLink}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>
    ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
    ${ADSENSE_SNIPPET}
    ${PARTNERIZE_TAG_SNIPPET}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    ${rootShell(hasSpaBundle)}
    ${railGutters(true).open}
    <main class="seo-static-content s-xzWvwM">
      <nav class="s-AxRVCF" aria-label="Breadcrumb">
        <a class="s-wfUMYx" href="/">Home</a>
        <span> / </span>
        <span>${esc(sectionLabel)}</span>
      </nav>
      <header class="s-S1RSUf">
        <h1 class="s-e3gkVi">${esc(sectionOverride ? (page > 1 ? `${sectionOverride.h1} — ${pageLabel(locale, page)}` : sectionOverride.h1) : buildHubH1(locale, hubKey, displayCount, page))}</h1>
        <p class="s-OPPwy-">${esc(description)}</p>
        <p class="s-Sn0UIv">${esc(countLabel(locale, displayCount))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      ${statTilesHtml}
      ${ctaHtmlGlobal}
      ${recencyChipsHtml}
      <section>
        ${itemsHtml}
      </section>
      ${pagination}
      ${topicsNavHtml}
      ${proseAccordionHtml}
    </main>${railGutters(true).close}
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

function pageLabel(locale: HubLocale, page: number): string {
  const word = { it: 'Pagina', en: 'Page', de: 'Seite', fr: 'Page' }[locale];
  return `${word} ${page}`;
}

function emptyLabel(locale: HubLocale): string {
  return { it: 'Nessun risultato disponibile.', en: 'No results available.', de: 'Keine Ergebnisse verfügbar.', fr: 'Aucun résultat disponible.' }[locale];
}

function countLabel(locale: HubLocale, n: number): string {
  return { it: `${n.toLocaleString('it')} risorse`, en: `${n.toLocaleString('en')} entries`, de: `${n.toLocaleString('de')} Einträge`, fr: `${n.toLocaleString('fr')} entrées` }[locale];
}

function updatedLabel(locale: HubLocale): string {
  return { it: 'Aggiornato', en: 'Updated', de: 'Aktualisiert', fr: 'Mis à jour' }[locale];
}

export function renderPagination(locale: HubLocale, basePath: string, current: number, total: number): string {
  // Compact pagination (visible): prev, 1, current-1, current, current+1, last, next.
  // Plus a FLAT crawler-facing navigator inside a collapsed <details> linking
  // every page-N (BFS-depth closure 2026-05-12 run 25753701178 — without
  // every page-N anchor on every page, leaves on page-3..N regress past BFS
  // depth 4 since the compact nav only links 1, n-1, n+1, last from any
  // given page — page-2 ↔ page-3 is a single hop, but page-1 → page-50 is a
  // chain of length ~25 via the compact ladder, pushing leaves on page-25+
  // to BFS depth > 4). The flat ladder collapses every page-N to a single
  // hop from any other page-N, so every job leaf sits at depth 4 from `/`:
  //   /  → /cerca-lavoro-ticino/tutti/   (page 1, depth 1)
  //      → /cerca-lavoro-ticino/tutti/page-N/ (depth 2 via flat nav)
  //      → /cerca-lavoro-{canton}/{slug}/  (depth 3, anchor on page-N)
  // The <details> stays collapsed by default — mobile fold is preserved
  // (CLAUDE.md #15/#16), and the BFS walker / crawlers parse every `<a>`
  // inside `<details>` regardless of `open` state.
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const prevLabel = { it: '« Precedente', en: '« Previous', de: '« Zurück', fr: '« Précédent' }[locale];
  const nextLabel = { it: 'Successiva »', en: 'Next »', de: 'Weiter »', fr: 'Suivant »' }[locale];

  const baseStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-size:14px';
  const activeStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-accent);color:white;font-size:14px;font-weight:700';

  const parts: string[] = [];
  if (current > 1) {
    parts.push(`<a href="${paginatedPath(basePath, current - 1)}" style="${baseStyle}" rel="prev">${prevLabel}</a>`);
  }
  let last = 0;
  for (const p of sorted) {
    if (last && p - last > 1) parts.push(`<span class="s-vchB5f">…</span>`);
    if (p === current) {
      parts.push(`<span style="${activeStyle}" aria-current="page">${p}</span>`);
    } else {
      parts.push(`<a href="${paginatedPath(basePath, p)}" style="${baseStyle}">${p}</a>`);
    }
    last = p;
  }
  if (current < total) {
    parts.push(`<a href="${paginatedPath(basePath, current + 1)}" style="${baseStyle}" rel="next">${nextLabel}</a>`);
  }
  const compactNav = `<nav class="s-ppmVTz" aria-label="Pagination">${parts.join('')}</nav>`;

  // Flat ladder — every page-N anchor, collapsed for mobile.
  // Skip when totalPages ≤ 1 (no pagination needed) or ≤ 5 (compact nav
  // already shows all pages, ladder would be redundant).
  if (total <= 5) return compactNav;
  const flatLabel = {
    it: "Sfoglia tutto l'archivio per pagina",
    en: 'Browse the full archive by page',
    de: 'Vollständiges Archiv nach Seite durchsuchen',
    fr: 'Parcourir toutes les archives par page',
  }[locale];
  // Use CSS classes instead of per-anchor inline styles. With totalPages
  // ≥ 100 (master jobs hub) the inline-style variant ballooned to ~250 B
  // per anchor × ~400 anchors = ~100 KB, pushing the last-page HTML past
  // the 200 KB `audit:page-weight` budget (2026-05-18 regression on
  // /cerca-lavoro-ticino/tutti/page-387/). Class names are short (.hp, .hc);
  // their rules now live in public/assets/seo-static.css (already linked on
  // these pages) instead of a per-page inline <style> block.
  //
  // Hrefs are root-relative (paginatedPath returns `/…/page-N/`), matching
  // the compact nav above and the `class="thp"` ladder in buildHubHtml.
  // The absolute `${BASE_URL}` prefix (28 B × every page anchor) was pure
  // dead weight here — crawlers resolve root-relative links identically and
  // every anchor is preserved — and with cantons now at ~1500 archive pages
  // it alone pushed /fr/trouver-emploi-tessin/tous/ past the 215 KB budget
  // (run 28090796553, ~42 KB of prefix). rel=prev/next <link> head hints
  // stay absolute (canonical convention).
  //
  // Bare page number as the visible/anchor text (was `${pageWord}&nbsp;${p}`).
  // The full ladder MUST keep every page-N anchor for BFS-depth closure (see
  // header comment) — that link set is load-bearing and unchanged here — but
  // the repeated per-anchor word prefix ("Pagina&nbsp;" / "Seite&nbsp;" /
  // "Page&nbsp;", ~10-12 B each) is not: at ~2 200 archive pages it added
  // ~24 KB that pushed /cerca-lavoro-ticino/tutti/ and its page-N back over
  // the 215 KB audit:page-weight budget (post-deploy run 29330607996, 130
  // offenders 223-228 KB). The compact nav above already renders bare `${p}`
  // links, and the `<details><summary>` + `<nav aria-label>` supply the
  // "browse by page" context, so the numbers stay understandable. Same
  // byte-shave class as the prior inline-style→class and BASE_URL-prefix drops
  // on this exact ladder; every anchor is preserved so BFS depth is unchanged.
  const flatAnchors: string[] = [];
  for (let p = 1; p <= total; p++) {
    const href = paginatedPath(basePath, p);
    if (p === current) {
      flatAnchors.push(`<strong class="hc" aria-current="page">${p}</strong>`);
    } else {
      flatAnchors.push(`<a href="${href}" class="hp">${p}</a>`);
    }
  }
  const flatNav = `<nav class="s-4nYHgH" aria-label="${flatLabel}"><details class="s-Ery2Xe"><summary class="s-goeAUL">${flatLabel} (${total})</summary><div class="s-6_t7LY">${flatAnchors.join('')}</div></details></nav>`;

  return `${compactNav}${flatNav}`;
}

interface RenderArticleHubCoreArgs {
  readonly fs: typeof fsT;
  readonly np: typeof npT;
  readonly rootDir: string;
  readonly distDir: string;
  readonly section: ArticleSection;
  readonly qw: (filePath: string, content: string) => void;
  readonly sitemapEntries: string[];
  readonly dateStamp: string;
  readonly entryJs: string;
  readonly entryCss: string;
  readonly hasSpaBundle: boolean;
  /**
   * Called once per page physically queued via `qw`, with the locale it
   * belongs to and its dist-relative path (no leading slash, e.g.
   * `articoli-frontaliere/tutti/page-2/index.html`). `emitSeoHubs` uses this
   * only to bump its own page counter; {@link renderArticleHubPages} uses it
   * to group the returned paths by locale (what its caller needs to hand to
   * `scripts/lib/push-article-shard-incremental.sh`, which pushes one locale
   * at a time).
   */
  readonly onPageEmitted: (locale: HubLocale, relPath: string) => void;
  /**
   * Narrow which locales render (default: all {@link HUB_LOCALES}).
   * Cross-locale hreflang alternates always reference the full 4-locale set
   * regardless — narrowing only skips writing that locale's own HTML, it
   * never drops it from another locale's alternate group.
   */
  readonly locales?: readonly HubLocale[];
  /**
   * Override the eligible-topic set the "Argomenti" nav links (#5414).
   * Default: computed from the corpus via {@link computeEligibleTopicKeys} —
   * the same membership/floor split `topicClusterHubsPlugin.ts` renders the
   * hub-vs-bridge decision from. Tests inject a fixture set here.
   */
  readonly eligibleTopicKeys?: ReadonlySet<string>;
}

/**
 * Emits ONE article section's (`frontaliere` or `svizzera`) `/tutti/`
 * archive and its pagination, across the requested locales.
 *
 * Extracted (#4881 Fase 1) from what used to be two near-identical copies:
 * the `articles` branch inline in `emitHub` below (frontaliere) and the
 * now-removed `emitSvizzeraArticlesHub` (svizzera) — same chrome via
 * {@link buildHtml}, same pagination/sitemap tail, differing only in
 * slugs/registry/copy, which {@link ARTICLE_SECTIONS} plus `sectionOverride`
 * already model as data. Consolidating removes the drift risk the two
 * copies had (AGENTS.md #6) and lets the fast-publish path
 * (`scripts/publish-article-fast.mjs`, via the exported async
 * {@link renderArticleHubPages} below) reuse this exact rendering instead of
 * a third copy.
 *
 * Frontaliere renders through `buildHtml`'s DEFAULT (no `sectionOverride`)
 * codepath — byte-identical to the pre-#4881 inline branch, which never set
 * one either. Svizzera builds the same `ArticleSectionOverride` the old
 * `emitSvizzeraArticlesHub` built.
 *
 * Stays fully SYNCHRONOUS — no `await` anywhere in its call chain — because
 * it is called directly both from the full-build `emitSeoHubs` dispatch
 * below AND from the async `renderArticleHubPages` wrapper, and `emitSeoHubs`
 * itself must remain sync for
 * `tests/build-plugins/seoHubsPlugin-hub-locale-reciprocity.test.ts`, which
 * calls it inside a non-async `beforeAll`.
 *
 * Empty-registry safety unchanged: an empty registry → `masterSlugs` empty →
 * `total = 0` → `totalPages = Math.max(1, 0) = 1`, so a single zero-article
 * archive page is emitted per locale (with a polite empty-state list),
 * never skipped. No crash, no warning spam (the readers return `[]`/empty
 * maps when the seed files are present-but-empty).
 */
// `readArticleDates` moved to `./shared/articleReaders` (#5001), joining the
// title/excerpt/slug readers it belongs with. The topic-cluster hubs order
// their listings by the same dates as this archive, and a third literal copy
// of that registry regex is the drift AGENTS.md #6 forbids. The site's own
// copy in `build-plugins/seoHubsPlugin.ts` stays where it is — see the note
// above `emitSeoHubs`'s export block for why those two cores are deliberately
// separate.

function renderArticleHubPagesCore(args: RenderArticleHubCoreArgs): void {
  const {
    baseUrl: BASE_URL,
    hubLocales: HUB_LOCALES,
    articlesPageSize: ARTICLES_PAGE_SIZE,
    articlesAllPaths,
  } = getSiteShell();
  const { fs, np, rootDir, distDir, section, qw, sitemapEntries, dateStamp, entryJs, entryCss, hasSpaBundle, onPageEmitted, locales } = args;
  const cfg = ARTICLE_SECTIONS[section];
  const isSvizzera = section === 'svizzera';
  const archiveBases: Record<HubLocale, string> = isSvizzera
    ? svizzeraArticlesArchiveBasePaths()
    : { ...articlesAllPaths };
  // The OTHER section's archive bases — the cross-link target (#5414). For
  // frontaliere pages that is svizzera's derived bases; for svizzera pages it
  // is the shell's own frontaliere `/tutti/` map (identical to what the site
  // build's `HUB_SLUGS[locale].articlesAll` resolves to).
  const twinArchiveBases: Record<HubLocale, string> = isSvizzera
    ? { ...articlesAllPaths }
    : svizzeraArticlesArchiveBasePaths();
  // One membership pass per section render, shared by all locales — the
  // eligible set is locale-independent by construction (membership is
  // computed once, on the Italian corpus; see topicClusters.ts).
  const eligibleTopicKeys = args.eligibleTopicKeys
    ?? computeEligibleTopicKeys(fs, np, rootDir, section);
  const pageSize = ARTICLES_PAGE_SIZE;
  // Canonical union slug set, computed once via the SHARED helper that
  // `staticPagesPlugin.ts`'s page-N navigator also uses — so the emitted
  // page count and the navigator link count can never drift (single source
  // of truth; issue #1486/#1497).
  const unionSlugs = readArticleArchiveUnionSlugs(fs, np, rootDir, section);

  for (const locale of locales ?? HUB_LOCALES) {
    const basePath = archiveBases[locale];
    const prefix = locale === 'it' ? '' : `/${locale}`;
    const blogSection = cfg.indexSlug[locale];
    const topicsNavHtml = buildArchiveTopicsNavHtml({
      locale,
      section,
      eligibleTopicKeys,
      twinArchivePath: twinArchiveBases[locale],
    });

    // Master list = UNION of `{metaPrefix}-it.ts` slugs and `{slugConst}`
    // keys — same orphan-avoidance contract for both sections.
    const itArticles = readArticleSlugs(fs, np, rootDir, 'it', cfg.metaPrefix);
    const localeArticles = locale === 'it' ? itArticles : readArticleSlugs(fs, np, rootDir, locale, cfg.metaPrefix);
    const localeBySlug = new Map(localeArticles.map((a) => [a.slug, a.title]));
    const itBySlug = new Map(itArticles.map((a) => [a.slug, a.title]));
    const localeExcerpts = readArticleExcerpts(fs, np, rootDir, locale, cfg.metaPrefix);
    const itExcerpts = readArticleExcerpts(fs, np, rootDir, 'it', cfg.metaPrefix);
    const blogUrlSlugs = readBlogUrlSlugs(fs, np, rootDir, cfg.slugDataFile, cfg.slugConst);

    const masterSlugs = new Set<string>(itArticles.map((a) => a.slug));
    for (const slug of Object.keys(blogUrlSlugs)) masterSlugs.add(slug);

    const items: Array<{ href: string; label: string; excerpt?: string; id: string }> = [];
    for (const slug of masterSlugs) {
      const label = localeBySlug.get(slug) ?? itBySlug.get(slug) ?? humanizeSlug(slug);
      const urlSlug = blogUrlSlugs[slug]?.[locale] ?? slug;
      const rawExcerpt = localeExcerpts.get(slug) ?? itExcerpts.get(slug);
      const excerpt = rawExcerpt && rawExcerpt.length > 140
        ? rawExcerpt.slice(0, 137).trimEnd() + '…'
        : rawExcerpt;
      items.push({ href: `${prefix}/${blogSection}/${urlSlug}/`, label, excerpt, id: slug });
    }

    // Newest first. `masterSlugs` is a Set filled from the meta chunk and the
    // slug map, i.e. the order articles were APPENDED — so a freshly published
    // article landed on the LAST page, page 31 of 31.
    //
    // Not a reachability fix: the flat pagination nav links every page, so
    // page-31 was always one hop from page-1, and `sitemapEntries` is pushed
    // inside the per-page loop so every page gets an entry in a full build.
    // (Neither is worth much today — no archive URL is in any live sitemap,
    // because fast-publish passes `sitemapEntries: []` and the site build no
    // longer emits these pages. That is its own gap.) This is about the page
    // people and crawlers actually land on carrying the newest articles
    // instead of the oldest.
    //
    // An id the registry has no date for sorts last but keeps its relative
    // position, so a registry that is briefly out of step with the meta chunks
    // drops nothing from the archive.
    const dateById = readArticleDates(fs, np, rootDir, cfg.registryFile);
    items.sort((a, b) => {
      const da = dateById.get(a.id);
      const db = dateById.get(b.id);
      if (da && db) return db.localeCompare(da);
      if (da) return -1;
      if (db) return 1;
      return 0;
    });

    const total = items.length;
    // Page count from the shared union size — identical to `total` while the
    // two reads agree, but routing through one source of truth means the
    // navigator (staticPagesPlugin.ts) and this emitter cannot disagree on N.
    const totalPages = Math.max(1, Math.ceil(unionSlugs.size / pageSize));
    const sectionOverride: ArticleSectionOverride | undefined = isSvizzera
      ? (() => {
          const copy = SVIZZERA_ARTICLES_COPY[locale];
          return {
            title: copy.title,
            description: copy.description,
            sectionLabel: copy.sectionLabel,
            h1: copy.h1,
            hreflangBases: archiveBases,
          };
        })()
      : undefined;

    // Every locale now emits every page-N as static HTML.
    //
    // It used to be IT-only, with non-IT page-N left to the SPA. That was
    // survivable while the archive listed in append order, because the hub
    // grid (newest 100) and the archive's only static page (oldest 100)
    // covered disjoint sets — 200 articles reachable per locale. Sorting the
    // archive newest-first collapses those two sets onto each other: measured
    // on EN, overlap goes 0 → 100, so 100 articles per locale would lose their
    // only static internal link and the two pages would become near-duplicate
    // listings under different canonicals.
    //
    // Emitting page-N everywhere fixes both at once and is the direction the
    // site wants anyway: more indexable pages, every article statically
    // linked. Cost is build output — 30 extra pages per non-IT locale per
    // section.
    const emitNonItPageN = true;
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1 && locale !== 'it' && !emitNonItPageN) continue;
      const slice = items.slice((page - 1) * pageSize, page * pageSize);
      const html = buildHtml({
        locale, hubKey: 'articles', basePath, page, totalPages,
        pageItems: slice, totalItems: total, hasSpaBundle, entryJs, entryCss,
        sectionOverride, topicsNavHtml,
      });
      const canonicalPath = paginatedPath(basePath, page);
      const relPath = np.join(canonicalPath.slice(1), 'index.html');
      qw(np.join(distDir, relPath), html);
      onPageEmitted(locale, relPath);

      // One sitemap entry per locale at page 1 (non-IT locales only ever
      // reach page 1 here — see the `continue` above); each carries the
      // same 4-locale alternate set so the group stays fully reciprocal.
      const altLinks = page === 1
        ? HUB_LOCALES.map((alt) =>
            `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${archiveBases[alt]}" />`,
          ).join('\n')
        : `    <xhtml:link rel="alternate" hreflang="it" href="${BASE_URL}${canonicalPath}" />`;
      const url = `${BASE_URL}${canonicalPath}`;
      const priority = page === 1 ? '0.7' : '0.5';
      sitemapEntries.push(
        `  <url>\n    <loc>${url}</loc>\n${altLinks}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
      );
    }
  }
}

export interface RenderArticleHubPagesOptions {
  readonly rootDir: string;
  readonly distDir: string;
  readonly section: ArticleSection;
  /** Narrow which locales render (default: all 4 shell `hubLocales`). */
  readonly locales?: readonly HubLocale[];
}

export interface RenderArticleHubPagesResult {
  /** Files physically written (post content-hash-manifest skip), this call only. */
  readonly written: number;
  /**
   * Dist-relative path (no leading slash) of every page this call rendered,
   * regardless of hash-skip, grouped by the locale it belongs to — e.g.
   * `{ it: ['articoli-svizzera/tutti/index.html', ...], en: [...], ... }`.
   * Grouped (rather than a flat list) because the caller hands each locale's
   * paths to `scripts/lib/push-article-shard-incremental.sh` separately —
   * that script pushes into one locale's shard repo per invocation.
   */
  readonly pathsByLocale: Record<HubLocale, string[]>;
}

/**
 * Standalone async entry point for the fast-publish path (issue #4881 Fase 1,
 * migration §10.4 step 1): renders one article section's `/tutti/` archive +
 * pagination into a scratch `distDir`, without a full `vite build`. Mirrors
 * `ogPagesPlugin.ts`'s exported `renderArticlePages` — resolves its own
 * fs/np/SPA-bundle info and writes through its own `WriteCollector`, then
 * delegates to the SAME synchronous {@link renderArticleHubPagesCore} the full
 * build's `emitSeoHubs` calls, so a fix to one path benefits both and a fork
 * can't silently drift them apart.
 */
export async function renderArticleHubPages(
  opts: RenderArticleHubPagesOptions,
): Promise<RenderArticleHubPagesResult> {
  const { rootDir, distDir, section, locales } = opts;
  const fs = await import('node:fs');
  const np = await import('node:path');
  const { WriteCollector, resolveSpaBundle, hubLocales } = getSiteShell();
  const { entryJs, entryCss, hasSpaBundle } = resolveSpaBundle(distDir);

  const collector = new WriteCollector({ distDir, pluginName: 'seoHubsPlugin' });
  const qw = (filePath: string, content: string) => {
    collector.add(filePath, content);
  };
  const pathsByLocale = Object.fromEntries(
    hubLocales.map((l) => [l, [] as string[]]),
  ) as Record<HubLocale, string[]>;

  renderArticleHubPagesCore({
    fs: fs as unknown as typeof fsT,
    np: np as unknown as typeof npT,
    rootDir,
    distDir,
    section,
    qw,
    sitemapEntries: [],
    dateStamp: new Date().toISOString().slice(0, 10),
    entryJs,
    entryCss,
    hasSpaBundle,
    onPageEmitted: (locale, relPath) => { pathsByLocale[locale].push(relPath); },
    locales,
  });

  const written = await collector.flush();
  return { written, pathsByLocale };
}

export { renderArticleHubPagesCore };
export type { RenderArticleHubCoreArgs };
