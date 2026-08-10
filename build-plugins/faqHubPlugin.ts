/**
 * FAQ Hub (AE-5) — Vite build plugin.
 *
 * Emits one static HTML landing per locale (4 total) grouped in 10
 * categories:
 *   IT:  /domande-frequenti-frontalieri/
 *   EN:  /en/frequently-asked-questions/
 *   DE:  /de/haeufige-fragen/
 *   FR:  /fr/questions-frequentes/
 *
 * Page body: TL;DR (100w) + table-of-contents + 10 sections (one per
 * category) with anchor IDs, every entry rendered as a semantic
 * <article>/<details> block so the FAQPage JSON-LD aggregates cleanly.
 * Total Q&A count and per-category counts (`TOTAL_FAQ_COUNT`, TOC labels)
 * are computed from `ALL_FAQ_HUB`/`getFaqHubByCategory` — never hardcoded —
 * so adding entries never desyncs the on-page copy.
 *
 * Structured data: FAQPage (one entry per Q&A), BreadcrumbList, Article,
 * SpeakableSpecification on TL;DR + category headings.
 *
 * Hub chrome: `guida` hub with `permits` sub-tab (most common user need
 * for a frontaliero seeking authoritative answers).
 *
 * Sitemap: writes `dist/sitemap-faq-hub.xml` — `sitemapAliasPlugin`
 * auto-discovers `sitemap-*.xml` and wires it into `sitemap.xml`.
 *
 * Routing: paths are registered as `staticOverlay` in `services/router.ts`
 * (FAQ_HUB_ROUTES + parseFaqHubPath). The SPA suppresses its generic guida
 * view on these paths so the static body (outside `#root` via
 * `seoContentOutsideRoot: true`) stays visible.
 *
 * Gate: SKIP_FAQ_HUB=1 fast-exits the plugin for local builds. CI must
 * always exercise it — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { GUIDE_HUB_HREF } from './shared/pillarGuideHrefs';
import {
  renderSeoHeroImage,
  seoHeroImageObject,
  seoHeroImageUrl,
  SEO_HERO_WIDTH,
  SEO_HERO_HEIGHT,
  type SeoHeroImageOpts,
} from './shared/seoHeroImage';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { formatUpdatedSentence } from './shared/humanDate';
import { differentiateH1FromTitle } from './shared/seoContentTokens';
import { WriteCollector } from './batchWrite';
import {
  ALL_FAQ_HUB,
  FAQ_HUB_CATEGORIES,
  FAQ_HUB_LOCALES,
  FAQ_HUB_CATEGORY_LABELS,
  buildFaqHubPath,
  buildFaqEntryPath,
  getFaqHubByCategory,
} from '../data/faq-hub';
import type { FaqHubCategory, FaqHubEntry, FaqHubLocale, FaqHubLocalizedString } from '../data/faq-hub';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';

// ── Locale-specific static copy ────────────────────────────────────

interface FaqHubCopy {
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly heroTitle: string;
  readonly heroSubtitle: string;
  readonly tldrTitle: string;
  readonly tldrParagraphs: ReadonlyArray<string>;
  readonly tocTitle: string;
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly updatedLabel: string;
  readonly disclaimer: string;
  readonly relatedTitle: string;
  readonly relatedLinks: ReadonlyArray<{ href: string; label: string }>;
}

// Total Q&A count, computed from the live data set — never hardcoded, so
// adding/removing entries can't desync the on-page copy below (see the
// hardcoded-"100"/"(10)" class of bug this replaces).
const TOTAL_FAQ_COUNT = ALL_FAQ_HUB.length;

const COPY: Record<FaqHubLocale, FaqHubCopy> = {
  it: {
    title:
      `${TOTAL_FAQ_COUNT} domande frequenti dei frontalieri — risposte complete | Frontaliere Ticino`,
    description:
      `${TOTAL_FAQ_COUNT} risposte dettagliate per frontalieri italiani in Ticino: fisco 2026, LAMal, permessi G/B, AVS/LPP, stipendi, trasporti, lavoro, famiglia, diritti. Fonti ufficiali AFC, UFAS, SEM, Agenzia Entrate, Fedlex.`,
    h1: `${TOTAL_FAQ_COUNT} domande frequenti dei frontalieri italiani in Ticino`,
    heroTitle: `Il tuo centro di riferimento: ${TOTAL_FAQ_COUNT} Q&A sul lavoro frontaliere`,
    heroSubtitle:
      `10 categorie, ${TOTAL_FAQ_COUNT} risposte, quattro lingue. Ogni risposta cita la fonte primaria (AFC, Fedlex, UFAS, SEM, Agenzia Entrate, INPS).`,
    tldrTitle: 'In sintesi',
    tldrParagraphs: [
      `Questo hub raccoglie ${TOTAL_FAQ_COUNT} risposte verificate alle domande più ricorrenti dei frontalieri italiani che lavorano in Ticino, con attenzione alla nuova legge 2024 (Accordo CH-IT del 23/12/2020 ratificato dalla Legge italiana 83/2023) e alle scadenze fiscali 2026.`,
      "Ogni risposta è lunga 80-180 parole, cita la norma applicabile (LAMal, LAVS, LPP, CO, LStrI, TUIR, dlgs 230/2021) e rinvia a fonti ufficiali Fedlex, AFC Ticino, UFAS, SEM, Agenzia Entrate, INPS. Il contenuto è aggiornato ai dati 2026 (aliquote, massimali, premi, minimi).",
    ],
    tocTitle: 'Categorie trattate',
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Guida frontaliere',
    updatedLabel: 'Aggiornato',
    disclaimer:
      'Le informazioni contenute in questa pagina hanno valore informativo e non sostituiscono la consulenza personalizzata di un commercialista, un avvocato o un patronato. Le norme fiscali, previdenziali e sui permessi cambiano con frequenza: verifica sempre le fonti ufficiali linkate in ogni risposta.',
    relatedTitle: 'Approfondisci',
    relatedLinks: [
      { href: '/calcolatore/', label: 'Calcolatore netto frontaliere' },
      { href: '/confronti-frontalieri/', label: 'Tabelle di confronto CH vs IT' },
      { href: '/guida-frontaliere/nuova-legge-frontalieri-2024/', label: 'Guida alla nuova legge 2024' },
      { href: '/fisco-frontalieri/', label: 'Hub fiscale frontalieri' },
      { href: '/costo-della-vita/', label: 'Costo della vita CH vs IT' },
      { href: '/frontaliere/', label: 'Frontaliere in Svizzera: la guida completa' },
    ],
  },
  en: {
    title:
      `${TOTAL_FAQ_COUNT} FAQs for Italian cross-border workers in Ticino — full answers | Frontaliere Ticino`,
    description:
      `${TOTAL_FAQ_COUNT} detailed answers for Italian cross-border workers in Ticino: 2026 tax, LAMal, G/B permits, AVS/LPP, salary, transport, work, family, rights. Primary sources: AFC, UFAS, SEM, Agenzia Entrate, Fedlex.`,
    h1: `${TOTAL_FAQ_COUNT} FAQs for Italian cross-border workers in Ticino`,
    heroTitle: `Your reference hub: ${TOTAL_FAQ_COUNT} Q&A on cross-border work`,
    heroSubtitle:
      `10 categories, ${TOTAL_FAQ_COUNT} answers, four languages. Every answer cites its primary source (AFC, Fedlex, UFAS, SEM, Agenzia Entrate, INPS).`,
    tldrTitle: 'In a nutshell',
    tldrParagraphs: [
      `This hub gathers ${TOTAL_FAQ_COUNT} verified answers to the most recurrent questions of Italian cross-border workers employed in Ticino, with focus on the 2024 new law (CH-IT Agreement of 23/12/2020 ratified by Italian Law 83/2023) and the 2026 tax deadlines.`,
      "Every answer is 80-180 words long, cites the applicable statute (LAMal, LAVS, LPP, CO, FNA, TUIR, dlgs 230/2021) and links to official sources on Fedlex, AFC Ticino, UFAS, SEM, Agenzia Entrate and INPS. Content is updated to 2026 data (rates, ceilings, premiums, minima).",
    ],
    tocTitle: 'Covered categories',
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Cross-border guide',
    updatedLabel: 'Updated',
    disclaimer:
      'The information on this page is for guidance only and does not replace personal advice from an accountant, lawyer or union office. Tax, social-security and permit rules change frequently: always verify with the official sources linked in each answer.',
    relatedTitle: 'Go deeper',
    relatedLinks: [
      { href: '/en/calculate-salary/', label: 'Cross-border net-salary calculator' },
      { href: '/en/cross-border-comparisons/', label: 'CH vs IT comparison tables' },
      { href: '/en/cross-border-guide/new-frontalieri-law-2026/', label: 'Guide to the 2026 cross-border law' },
      { href: '/en/cross-border-worker/', label: 'Cross-border worker in Switzerland: the full guide' },
    ],
  },
  de: {
    title:
      `${TOTAL_FAQ_COUNT} häufige Fragen italienischer Grenzgänger im Tessin — Antworten | Frontaliere Ticino`,
    description:
      `${TOTAL_FAQ_COUNT} detaillierte Antworten für italienische Grenzgänger im Tessin: Steuern 2026, KVG, G/B-Bewilligung, AHV/BVG, Lohn, Verkehr, Arbeit, Familie, Rechte. Primärquellen: AFC, BSV, SEM, Agenzia Entrate, Fedlex.`,
    h1: `${TOTAL_FAQ_COUNT} häufige Fragen italienischer Grenzgänger im Tessin`,
    heroTitle: `Ihre Nachschlagebasis: ${TOTAL_FAQ_COUNT} Q&A zur Grenzgängerarbeit`,
    heroSubtitle:
      `10 Kategorien, ${TOTAL_FAQ_COUNT} Antworten, vier Sprachen. Jede Antwort nennt die Primärquelle (AFC, Fedlex, BSV, SEM, Agenzia Entrate, INPS).`,
    tldrTitle: 'Kurz gefasst',
    tldrParagraphs: [
      `Dieser Hub sammelt ${TOTAL_FAQ_COUNT} geprüfte Antworten auf die häufigsten Fragen italienischer Grenzgänger im Tessin, mit Schwerpunkt auf dem neuen Gesetz 2024 (CH-IT-Abkommen vom 23.12.2020, ratifiziert durch das italienische Gesetz 83/2023) und den Steuerfristen 2026.`,
      'Jede Antwort umfasst 80-180 Wörter, nennt die anwendbare Norm (KVG, AHVG, BVG, OR, AIG, TUIR, GD 230/2021) und verweist auf offizielle Quellen (Fedlex, AFC Tessin, BSV, SEM, Agenzia Entrate, INPS). Inhalte entsprechen dem Stand 2026 (Sätze, Obergrenzen, Prämien, Mindestlöhne).',
    ],
    tocTitle: 'Behandelte Kategorien',
    breadcrumbHome: 'Start',
    breadcrumbHub: 'Grenzgängerleitfaden',
    updatedLabel: 'Aktualisiert',
    disclaimer:
      'Die Angaben dienen der Orientierung und ersetzen keine persönliche Beratung durch einen Treuhänder, Anwalt oder eine Gewerkschaft. Steuer-, Sozialversicherungs- und Bewilligungsregeln ändern sich häufig: immer die verlinkten Primärquellen prüfen.',
    relatedTitle: 'Vertiefen',
    relatedLinks: [
      { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Nettolohnrechner' },
      { href: '/de/grenzgaenger-vergleich/', label: 'Vergleichstabellen CH vs IT' },
      { href: '/de/grenzgaenger-ratgeber/neues-grenzgaengergesetz-2026/', label: 'Leitfaden Grenzgängergesetz 2026' },
      { href: '/de/grenzgaenger/', label: 'Grenzgänger in der Schweiz: der komplette Leitfaden' },
    ],
  },
  fr: {
    title:
      `${TOTAL_FAQ_COUNT} questions fréquentes des frontaliers au Tessin — réponses | Frontaliere Ticino`,
    description:
      `${TOTAL_FAQ_COUNT} réponses détaillées pour les frontaliers italiens au Tessin : impôts 2026, LAMal, permis G/B, AVS/LPP, salaire, transports, travail, famille, droits. Sources officielles : AFC, OFAS, SEM, Agenzia Entrate, Fedlex.`,
    h1: `${TOTAL_FAQ_COUNT} questions fréquentes des frontaliers italiens au Tessin`,
    heroTitle: `Votre centre de référence : ${TOTAL_FAQ_COUNT} Q&R sur le travail frontalier`,
    heroSubtitle:
      `10 catégories, ${TOTAL_FAQ_COUNT} réponses, quatre langues. Chaque réponse cite sa source primaire (AFC, Fedlex, OFAS, SEM, Agenzia Entrate, INPS).`,
    tldrTitle: 'En bref',
    tldrParagraphs: [
      `Ce hub rassemble ${TOTAL_FAQ_COUNT} réponses vérifiées aux questions les plus fréquentes des frontaliers italiens employés au Tessin, avec un focus sur la nouvelle loi 2024 (Accord CH-IT du 23/12/2020 ratifié par la loi italienne 83/2023) et les échéances fiscales 2026.`,
      "Chaque réponse compte 80-180 mots, cite la norme applicable (LAMal, LAVS, LPP, CO, LEI, TUIR, décret 230/2021) et renvoie aux sources officielles Fedlex, AFC Tessin, OFAS, SEM, Agenzia Entrate, INPS. Contenu à jour 2026 (taux, plafonds, primes, minima).",
    ],
    tocTitle: 'Catégories traitées',
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Guide frontalier',
    updatedLabel: 'Mis à jour',
    disclaimer:
      "Les informations de cette page sont indicatives et ne remplacent pas un conseil personnalisé (expert-comptable, avocat, syndicat). Les règles fiscales, de sécurité sociale et de permis changent régulièrement : vérifiez toujours les sources officielles indiquées.",
    relatedTitle: 'Approfondir',
    relatedLinks: [
      { href: '/fr/calculer-salaire/', label: 'Calculateur salaire net frontalier' },
      { href: '/fr/comparaisons-frontaliers/', label: 'Tableaux comparatifs CH vs IT' },
      { href: '/fr/guide-frontalier/nouvelle-loi-frontaliers-2026/', label: 'Guide de la nouvelle loi 2026' },
      { href: '/fr/frontalier/', label: 'Frontalier en Suisse : le guide complet' },
    ],
  },
};

const OG_LOCALE: Record<FaqHubLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

// Parent hub link (Guida sub-tab) for breadcrumb.
// Shared single source of truth (build-plugins/shared/pillarGuideHrefs.ts,
// derived from SLUG_TABLES[locale].guida). Seven copies of this table lived
// under build-plugins/; four held these values and three had drifted to a
// 404 EN and a noindex DE — see #5428.
const GUIDA_HUB_PATH: Record<FaqHubLocale, string> = GUIDE_HUB_HREF;

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Preserve `[label](href)` markdown and render as nofollow links.
 * Every FAQ answer cites sources inline using this syntax.
 */
function mdLinks(s: string): string {
  return esc(s).replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, href) =>
      `<a class="s-TKxoRL" href="${String(href).replace(/"/g, '&quot;')}" rel="nofollow" target="_blank">${label}</a>`,
  );
}

/**
 * Ordered, keyword-based root-domain map for the institutions cited inline
 * as `[fonte: X]` / `[source: X]` / `[Quelle: X]` / `[source : X]` across
 * `data/faq-hub/category-*.ts` (issue #4405 — 206 authoritative citations,
 * zero hyperlinked). First matching rule wins. Mechanical pass — no
 * invented deep paths, only verified real root domains; covers every
 * distinct citation label present in the dataset at authoring time
 * (298/298 unique labels across all 4 locales).
 */
const CITATION_FALLBACK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/eur-?lex|reg\.?\s*ue\s*\d|règl\.?\s*ue|eu[\s-]?vo|eu reg\./i, 'https://eur-lex.europa.eu/'],
  [/fedlex/i, 'https://www.fedlex.admin.ch/'],
  [/accordo ch-?it|accordo 23\/12\/2020|abkommen|agreement|accord\b/i, 'https://www.fedlex.admin.ch/'],
  [/redditi pf/i, 'https://www.agenziaentrate.gov.it/'],
  [/\bti\.ch\b|afc ticino|camera di commercio.*ticino|cc-ti|ustat/i, 'https://www.ti.ch/'],
  [/chambre de commerce|handelskammer|chamber of commerce/i, 'https://www.cc-ti.ch/'],
  [/\bestv\b/i, 'https://www.estv.admin.ch/'],
  [/\bafc\b(?!.*ticino)/i, 'https://www.estv.admin.ch/'],
  [/circolare agenzia entrate|agenzia (delle )?entrate|istruzioni redditi pf/i, 'https://www.agenziaentrate.gov.it/'],
  [/agenzia dogane|agenzia delle dogane/i, 'https://www.adm.gov.it/'],
  [/\bofdf\b|swiss federal customs administration/i, 'https://www.bazg.admin.ch/'],
  [/\bafd\b|bazg|amministrazione federale delle dogane|zollverwaltung/i, 'https://www.bazg.admin.ch/'],
  [/agcom/i, 'https://www.agcom.it/'],
  [/arcobaleno\.ch/i, 'https://www.arcobaleno.ch/'],
  [/\bffs\b|\bsbb\b|\bcff\b/i, 'https://www.sbb.ch/'],
  [/\bufas\b|\bbsv\b|ofas/i, 'https://www.bsv.admin.ch/'],
  [/\bufsp\b|\bbag\b|\bofsp\b/i, 'https://www.bag.admin.ch/'],
  [/\bufse\b|ufficio federale di statistica|\bbfs\b|\bust\b,|\bofs\b/i, 'https://www.bfs.admin.ch/'],
  [/\bseco\b/i, 'https://www.seco.admin.ch/'],
  [/\bseri\b|\bsbfi\b|sefri/i, 'https://www.sbfi.admin.ch/'],
  [/finma/i, 'https://www.finma.ch/'],
  [/gemeinsame einrichtung kvg|istituzione comune lamal|institution commune lamal/i, 'https://www.kvg.org/'],
  [/ministero (degli )?affari esteri|\bmfa\b|aussenministerium|mae italien/i, 'https://www.esteri.it/'],
  [/\bmef\b/i, 'https://www.mef.gov.it/'],
  [/normattiva|\bl\.?\s*83\/2023\b|13[./]06[./]2023|n[°.]?\s*83\b/i, 'https://www.normattiva.it/'],
  [/\b(art\.|§)?\s*(lac|laci|avig|\bco\b|\bor\b|\bll\b|lpga|lca|atsg|vvg)\b/i, 'https://www.fedlex.admin.ch/'],
];

/**
 * Resolve the best real URL for a `[fonte: <label>]`-style citation.
 * Prefers a curated deep link already present in `entry.sources` (an
 * authored, per-entry array of real source URLs that existed in the data
 * model but was never wired into rendering — see `data/faq-hub/types.ts`)
 * when its hostname matches the fallback root domain for the matched
 * institution; otherwise falls back to the verified root domain itself.
 * Returns `undefined` only if the label matches no known institution.
 */
function resolveCitationHref(label: string, sources: ReadonlyArray<string> | undefined): string | undefined {
  const rule = CITATION_FALLBACK_RULES.find(([re]) => re.test(label));
  if (!rule) return undefined;
  const [, fallbackUrl] = rule;
  if (sources && sources.length > 0) {
    try {
      const fallbackHost = new URL(fallbackUrl).hostname.replace(/^www\./, '');
      const deepMatch = sources.find((s) => {
        try {
          return new URL(s).hostname.replace(/^www\./, '') === fallbackHost;
        } catch {
          return false;
        }
      });
      if (deepMatch) return deepMatch;
    } catch {
      // Malformed fallback URL (shouldn't happen — all entries above are
      // static literals) — fall through to the plain fallback below.
    }
  }
  return fallbackUrl;
}

/**
 * Turn every inline `[fonte: X]` / `[source: X]` / `[Quelle: X]` /
 * `[source : X]` citation into the `[label](href)` markdown syntax already
 * understood by {@link mdLinks} (the exact convention used by
 * `comparisonsHubCopy.ts` / `professionLandingsCopy.ts`), so the existing
 * renderer hyperlinks it without further changes. No-op for a label that
 * matches no rule (defensive — every label in the dataset matched at
 * authoring time).
 */
function linkifyCitations(text: string, sources: ReadonlyArray<string> | undefined): string {
  return text.replace(/\[(fonte|source|Quelle)\s*:\s*([^\]]+)\]/g, (full, tag: string, label: string) => {
    const href = resolveCitationHref(label, sources);
    return href ? `[${tag}: ${label}](${href})` : full;
  });
}

function resolveRelatedHref(href: string | FaqHubLocalizedString, locale: FaqHubLocale): string {
  return typeof href === 'string' ? href : href[locale];
}

function renderEntry(
  entry: FaqHubEntry,
  locale: FaqHubLocale,
  linkedIds?: ReadonlySet<string>,
): string {
  const q = entry.question[locale];
  const a = linkifyCitations(entry.answer[locale], entry.sources);
  const related = entry.relatedLinks ?? [];
  const relatedHtml =
    related.length > 0
      ? `<ul class="fh-rel">${related
          .map(
            (l) =>
              `<li><a href="${esc(resolveRelatedHref(l.href, locale))}" class="fh-lnk">${esc(
                l.label[locale],
              )}</a></li>`,
          )
          .join('')}</ul>`
      : '';
  // Linked only when a page was actually emitted for this entry IN THIS
  // LOCALE — never optimistically. A dangling internal link is the silent-skip
  // failure the below-floor-bridge rule exists to prevent. The answer stays
  // inline either way, so the hub keeps working as one scannable page.
  const heading = linkedIds?.has(entry.id)
    ? `<a href="${esc(buildFaqEntryPath(locale, entry.id))}" class="fh-lnk">${esc(q)}</a>`
    : esc(q);
  return `<article id="${esc(entry.id)}" class="fh-q">
  <h3 class="fh-qt">${heading}</h3>
  <p class="fh-qa">${mdLinks(a)}</p>
  ${relatedHtml}
</article>`;
}

function renderCategorySection(
  category: FaqHubCategory,
  locale: FaqHubLocale,
  linkedIds?: ReadonlySet<string>,
): { html: string; entries: ReadonlyArray<FaqHubEntry> } {
  const entries = getFaqHubByCategory(category);
  const label = FAQ_HUB_CATEGORY_LABELS[category][locale];
  const body = entries.map((e) => renderEntry(e, locale, linkedIds)).join('');
  const html = `<section id="cat-${esc(category)}" class="fh-cat">
  <h2 data-speakable class="fh-cath">${esc(label)}</h2>
  ${body}
</section>`;
  return { html, entries };
}

function renderToc(locale: FaqHubLocale, copy: FaqHubCopy): string {
  const items = FAQ_HUB_CATEGORIES.map((cat) => {
    const label = FAQ_HUB_CATEGORY_LABELS[cat][locale];
    const count = getFaqHubByCategory(cat).length;
    return `<li class="fh-toci"><a href="#cat-${esc(cat)}" class="fh-lnk">${esc(label)}</a> <span class="fh-tocc">(${count})</span></li>`;
  }).join('');
  return `<nav aria-label="${esc(copy.tocTitle)}" class="fh-toc">
  <h2 class="fh-toch">${esc(copy.tocTitle)}</h2>
  <ul class="fh-tocl">${items}</ul>
</nav>`;
}

function renderRelatedLinks(copy: FaqHubCopy): string {
  const items = copy.relatedLinks
    .map(
      (l) =>
        `<li class="fh-rli"><a href="${esc(l.href)}" class="fh-lnk">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section class="fh-rls"><h2 class="fh-rlh">${esc(copy.relatedTitle)}</h2><ul class="fh-rll">${items}</ul></section>`;
}

// ── Page rendering ───────────────────────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
  faqCount: number;
}

/**
 * @param eligibleLocales Locales whose hub page this build will actually
 *   write. The `MIN_INDEXABLE_WORDS` floor below is evaluated per locale, so
 *   it can drop DE while keeping IT — and an hreflang block built from the
 *   full locale list would then advertise a page nothing wrote (the #5114
 *   class). Pass 1 of the caller's two-pass render supplies an empty set: it
 *   only needs `wordCount`, which is computed from the body and does not
 *   depend on the hreflang block.
 */
function renderPage(
  locale: FaqHubLocale,
  dateStamp: string,
  distDir?: string,
  eligibleLocales: ReadonlySet<string> = new Set(),
  /** Entry ids that have their own page IN THIS LOCALE; anything else stays unlinked. */
  linkedIds?: ReadonlySet<string>,
): RenderResult {
  const copy = COPY[locale];
  // One description of the hero, used three times: the <img>, `Article.image`
  // and `og:image`. Declared before the body because the body consumes it
  // first; all three derive their URL from this single (family, key, locale).
  const hero: SeoHeroImageOpts = {
    family: 'faq-hub', key: 'hub', locale, headline: copy.h1, eyebrow: copy.breadcrumbHub, alt: copy.h1,
  };
  const urlPath = buildFaqHubPath(locale);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubParentUrl = `${BASE_URL}${GUIDA_HUB_PATH[locale]}`;

  // Hreflang (4 locales + x-default), emitted only when every locale's hub
  // is actually written this build — otherwise nothing, since a partial set
  // trades audit-hreflang's [missingTarget] for [tooFew] (#5114).
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildFaqHubPath(alt as FaqHubLocale)}`,
    indent: '    ',
  });

  // Categories (10) → 10 sections (10 Q/A each).
  const sections: string[] = [];
  const allEntries: FaqHubEntry[] = [];
  for (const cat of FAQ_HUB_CATEGORIES) {
    const { html, entries } = renderCategorySection(cat, locale, linkedIds);
    sections.push(html);
    for (const e of entries) allEntries.push(e);
  }

  const tldrHtml = copy.tldrParagraphs
    .map(
      (p) => `<p class="fh-tldp">${esc(p)}</p>`,
    )
    .join('');

  const body = `
    <nav class="fh-bc" aria-label="Breadcrumb">
      <a href="${esc(homeUrl)}" class="fh-lnk">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubParentUrl)}" class="fh-lnk">${esc(copy.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header class="fh-hd">
      <p class="fh-eyebrow">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
      <!-- Demoted from <h1> to <h2> in Phase 4C: hubChrome's hero already emits
           the page's primary <h1>, and Semrush W6 / Issue 104 flagged the
           FAQ + comparisons hubs for shipping two H1 tags. The body heading
           remains the most descriptive copy for the page topic. -->
      <h2 class="fh-h1">${esc(copy.h1)}</h2>
    </header>
    ${renderSeoHeroImage(hero)}
    <section class="fh-tldr" data-speakable aria-label="TL;DR">
      <h2 class="fh-tldh">${esc(copy.tldrTitle)}</h2>
      ${tldrHtml}
    </section>
    ${renderToc(locale, copy)}
    ${sections.join('\n')}
    <p class="fh-disc">${esc(copy.disclaimer)}</p>
    ${renderRelatedLinks(copy)}
  `;

  const bodyHtml = `<main class="fh-main">${body}${endOfContentMultiplexHtml({ indexable: countHtmlBodyWords(body) >= MIN_INDEXABLE_WORDS })}</main>`;

  // ── Structured data ────────────────────────────────────────────
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbHub, item: hubParentUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: allEntries.map((e) => ({
      '@type': 'Question',
      name: e.question[locale],
      acceptedAnswer: {
        '@type': 'Answer',
        // Full answer text, matching what's visible in the HTML body
        // (#4398 — a 280-char truncation here made the JSON-LD read ~38
        // words average against a 114.7-word visible answer, contradicting
        // the page for AI crawlers/AI Overviews parsing structured data).
        // Strip markdown link syntax — Google parsers prefer plain text,
        // and the same citations are already real <a href> links in the
        // HTML body via linkifyCitations()+mdLinks() above.
        text: linkifyCitations(e.answer[locale], e.sources).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
      },
    })),
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: guardArticleJsonLdDescription(copy.description),
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
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    abstract: copy.tldrParagraphs[0],
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', '[data-speakable]'],
    },
  });

  // FAQ hub body CSS (.fh-* classes) now lives in public/assets/seo-static.css
  // (already linked on this page) instead of a per-page inline <style> block.
  // The classes keep the rendered HTML under the 200 KB page-weight gate; the
  // shared sheet drops the ~2 KB block from every FAQ hub page.
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    ogImage: seoHeroImageUrl(hero),
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: copy.h1,
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'guida',
      activeSubTab: 'permits',
      hero: {
        // The hero is this page's only <h1>, and when the copy makes it the
        // same sentence as the <title> the page ships a duplicate pair
        // (Semrush "Duplicate H1 and title tags", audit:h1-title-duplicates).
        // It hides in plain sight because the brand suffix normally tells the
        // two apart — but buildTitleWithBrand DROPS the brand once the
        // headline passes 45 chars, and every FAQ headline does. Measured on
        // the 2026-08-06 deploy: 67 of the 100 sampled offenders were these
        // pages. Differentiating the H1 (never the title) is the house rule:
        // titleSuffix.ts says to fix long headlines at source, not by cutting.
        title: differentiateH1FromTitle(copy.heroTitle, copy.title, locale),
        subtitle: copy.heroSubtitle,
        variant: 'green',
      },
    },
  });

  return { urlPath, html, wordCount, faqCount: allEntries.length };
}

// ── Per-question pages ───────────────────────────────────────────
//
// WHY THESE EXIST (issue #5008).
//
// The issue's premise is that Reddit outranks this site on informational
// queries — "permesso G", "tasse frontalieri", the practical questions people
// actually type. The half of that premise worth acting on is not "post on
// Reddit"; it is that a Reddit thread beats us because it is ONE URL whose
// entire content answers ONE question, and we had 103 researched, sourced
// answers hidden behind four URLs. A search engine ranking a page, and an LLM
// deciding what to cite, both work at the granularity of a URL. An answer that
// does not have one is an answer that cannot win.
//
// So each entry also gets its own page: 103 questions × 4 locales = 412 pages,
// each with the question as its <h1>, the full sourced answer as its body, and
// links to its sibling questions. The hub keeps every answer inline and becomes
// their index.
//
// Thin content was the obvious risk (Non-Negotiable #4) and was measured before
// building this, not after: 0 of 103 answers fall under MIN_INDEXABLE_WORDS on
// the answer text alone, before page chrome. The per-page word-count gate below
// is kept anyway, so an entry edited down to a stub demotes itself instead of
// shipping thin.
//
// WHAT THE WORD-COUNT GATE DID NOT CATCH, AND WHY THE SIBLING EXCERPTS EXIST.
//
// `audit:text-html-ratio` measures visible-text bytes over TOTAL page bytes,
// and a page can clear MIN_INDEXABLE_WORDS comfortably while failing it — these
// pages did, all 412 of them, at 7.31-9.79 % against a 10 % floor. The cause was
// never thin content: `<main>` is itself ~43 % text. It is that ONE answer
// (~2 KB) has to carry ~9.7 KB of <head>, ~8.9 KB of shared hub-chrome subnav
// and ~4.2 KB of JSON-LD — fixed chrome the hub pages amortise over 103 answers
// and these pages could not. Reducing that chrome was not on the table: it is
// shared with every other SEO template, and the JSON-LD is the point of the
// page. So the fix was to give the page more of what it was short of.
//
// The sibling block therefore renders each linked question WITH the opening of
// its answer (see `answerSnippet`), which roughly doubles the visible text and
// lands every locale at 13.6-16.7 % — measured by re-running the audit's own
// `extractVisibleText` over the rendered HTML, plus the fixed 651 bytes the
// later CDN-rewrite build stage adds to every page. If this block is ever cut
// back to bare links, the 10 % gate fails again on all 412 pages.

interface FaqEntryCopy {
  readonly backToHub: string;
  readonly answerHeading: string;
  readonly sourcesHeading: string;
  readonly siblingsHeading: string;
  readonly seeAlsoHeading: string;
  readonly heroSubtitle: (category: string) => string;
}

const ENTRY_COPY: Record<FaqHubLocale, FaqEntryCopy> = {
  it: {
    backToHub: 'Tutte le domande frequenti dei frontalieri',
    answerHeading: 'Risposta',
    sourcesHeading: 'Fonti ufficiali',
    siblingsHeading: 'Altre domande su questo tema',
    seeAlsoHeading: 'Approfondisci',
    heroSubtitle: (c) => `Risposta con fonti ufficiali — ${c}`,
  },
  en: {
    backToHub: 'All cross-border worker FAQs',
    answerHeading: 'Answer',
    sourcesHeading: 'Official sources',
    siblingsHeading: 'Other questions on this topic',
    seeAlsoHeading: 'Read more',
    heroSubtitle: (c) => `Answered with official sources — ${c}`,
  },
  de: {
    backToHub: 'Alle häufigen Fragen für Grenzgänger',
    answerHeading: 'Antwort',
    sourcesHeading: 'Offizielle Quellen',
    siblingsHeading: 'Weitere Fragen zu diesem Thema',
    seeAlsoHeading: 'Mehr dazu',
    heroSubtitle: (c) => `Antwort mit offiziellen Quellen — ${c}`,
  },
  fr: {
    backToHub: 'Toutes les questions fréquentes des frontaliers',
    answerHeading: 'Réponse',
    sourcesHeading: 'Sources officielles',
    siblingsHeading: 'Autres questions sur ce thème',
    seeAlsoHeading: 'Pour aller plus loin',
    heroSubtitle: (c) => `Réponse avec sources officielles — ${c}`,
  },
};

/**
 * How many sibling questions each entry page links to.
 *
 * Categories hold 10 entries (13 for `fisco`), so 8 links a clear majority of
 * each category's neighbours while still leaving the rotation in
 * {@link siblingEntries} something to rotate — the cluster stays a cluster
 * rather than every page emitting an identical index of its category.
 */
const SIBLING_LINKS = 8;

/**
 * Characters of a sibling's own answer shown beneath its link.
 *
 * Sized against the corpus, not picked round: the SHORTEST answer once
 * citations are dropped is 393 characters (de), so every sibling in every
 * locale has a full budget to give and no snippet is silently stubby. It is
 * also a snippet, deliberately — roughly a meta-description — so a page never
 * republishes enough of a sibling to compete with the sibling's own page for
 * the sibling's own question.
 */
const SIBLING_EXCERPT_CHARS = 240;

/** `[fonte: X]` / `[source: X]` / `[Quelle: X]`, with the space that precedes it. */
const CITATION_IN_SNIPPET_RX = /\s*\[(?:fonte|source|quelle)\s*:\s*[^\]]*\]/gi;

/**
 * A sentence end: terminal punctuation, any closing quote/bracket, whitespace,
 * and then something that opens a new sentence.
 *
 * The lookahead is the whole point. These answers are dense with `art. 38`,
 * `RS 831.10`, `8.7%` and `dlgs 230/2021`, so splitting on `.` alone truncates
 * mid-clause — requiring the next non-space character to be an opening capital
 * (or an opening quote/parenthesis) rejects every one of those.
 */
const SENTENCE_END_RX = /[.!?][)\]»"']*\s+(?=[A-ZÀ-ÖØ-Þ«"'(])/g;

/**
 * A clean, snippet-length opening of an answer — what each sibling link shows
 * beneath it, so the block reads as a set of answers rather than a set of
 * anchors.
 *
 * Citations are DROPPED here rather than flattened. `[fonte: Fedlex LAVS RS
 * 831.10]` earns its place where the full answer states the rule it supports,
 * but inside a 240-character teaser it spends a sixth of the budget on a
 * reference the reader cannot follow from here — the live link lives on the
 * sibling's own page, one click away. {@link plainAnswer} has already flattened
 * `[label](href)` markdown; this drops what that leaves behind.
 *
 * The cut prefers a sentence end and only falls back to a word boundary (with
 * an ellipsis) when the window holds none, so a snippet normally ends as a
 * finished thought.
 */
function answerSnippet(
  entry: FaqHubEntry,
  locale: FaqHubLocale,
  maxChars: number = SIBLING_EXCERPT_CHARS,
): string {
  const text = plainAnswer(entry, locale)
    .replace(CITATION_IN_SNIPPET_RX, '')
    // Dropping a citation can strand the space before the punctuation that
    // followed it ("… entro 8 giorni ." → "… entro 8 giorni.").
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;

  // Reach a little past the cap so a sentence ending just beyond it can still
  // close the snippet cleanly instead of being forced into an ellipsis.
  const window = text.slice(0, maxChars + 40);
  let cut = -1;
  for (const m of window.matchAll(SENTENCE_END_RX)) {
    const end = (m.index ?? 0) + m[0].replace(/\s+$/, '').length;
    // Keep the LAST qualifying end — the fullest snippet the budget allows.
    if (end >= maxChars * 0.55) cut = end;
  }
  if (cut > 0) return text.slice(0, cut);

  const hard = text.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(' ');
  const trimmed = lastSpace > maxChars * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${trimmed.replace(/[\s,;:]+$/, '')}…`;
}

/**
 * Per locale, the entries whose own page this build will write.
 *
 * The floor is evaluated PER LOCALE and BEFORE anything is rendered, which is
 * what lets two separate guarantees hold at once:
 *
 *  - the hub in locale L links only questions that have a page in L, so no
 *    internal link dangles (the silent-skip failure the below-floor-bridge
 *    rule exists to prevent);
 *  - the hreflang block is built by `buildLocaleAlternateBlock` from this same
 *    set, so a locale can never be advertised unless it was planned (#5114).
 *
 * This deliberately replaces the all-or-nothing skip this plugin carried
 * before: dropping a question from ALL FOUR locales because one was thin threw
 * away three good pages to avoid one bad hreflang block. The shared module
 * already expresses "incomplete set → emit no alternates", so the pages can
 * ship and simply go without hreflang — which `audit-hreflang` tolerates,
 * unlike a partial block.
 *
 * Conservative by construction: the rendered body is the answer PLUS fixed
 * chrome (breadcrumb, sources, sibling links, disclaimer), which can only add
 * words, so an entry that passes here cannot fail the real per-page gate.
 *
 * The answer is `esc()`d before counting because that is what the page
 * actually contains. 7 answers in the corpus use comparison operators in prose
 * — the French one reads `enfants < 21 ans … ordinaire >CHF 120 000` — and
 * `countHtmlBodyWords` strips `<…>` as a tag, which silently ate 53 of that
 * answer's 93 words. `mdLinks()` escapes before emitting, so the rendered HTML
 * was never affected; counting the raw string measured a page that does not
 * exist.
 */
function entryPageEligibleLocales(entry: FaqHubEntry): Set<FaqHubLocale> {
  return new Set(
    FAQ_HUB_LOCALES.filter(
      (loc) => countHtmlBodyWords(esc(plainAnswer(entry, loc))) >= MIN_INDEXABLE_WORDS,
    ),
  );
}

/** Entry ids that have a page in `locale` — what the hub uses to decide linking. */
function linkedIdsForLocale(locale: FaqHubLocale, byEntry: Map<string, Set<FaqHubLocale>>): Set<string> {
  const out = new Set<string>();
  for (const [id, locales] of byEntry) if (locales.has(locale)) out.add(id);
  return out;
}

/** Answer text with markdown link syntax flattened — for meta/JSON-LD. */
function plainAnswer(entry: FaqHubEntry, locale: FaqHubLocale): string {
  return entry.answer[locale].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * Sibling questions from the same category, chosen deterministically.
 *
 * Rotating the category list from this entry's own position — rather than
 * always taking the first N — is what stops every page in a category from
 * emitting the same six links and concentrating all the inbound link equity on
 * the category's first entries. Same failure mode, and same fix, as the
 * related-articles picker in packages/articles/engine/relatedArticlesIndex.ts.
 */
function siblingEntries(entry: FaqHubEntry, linkedIds: ReadonlySet<string>): FaqHubEntry[] {
  const siblings = getFaqHubByCategory(entry.category).filter((e) => linkedIds.has(e.id));
  const self = siblings.findIndex((e) => e.id === entry.id);
  const start = self < 0 ? 0 : self;
  const out: FaqHubEntry[] = [];
  for (let i = 1; i < siblings.length && out.length < SIBLING_LINKS; i++) {
    out.push(siblings[(start + i) % siblings.length]);
  }
  return out;
}

function renderEntryPage(
  entry: FaqHubEntry,
  locale: FaqHubLocale,
  dateStamp: string,
  linkedIds: ReadonlySet<string>,
  eligibleLocales: ReadonlySet<string>,
  distDir?: string,
): RenderResult {
  const copy = COPY[locale];
  const ecopy = ENTRY_COPY[locale];
  const question = entry.question[locale];
  // The <title> is the question, UNLESS the question overflows the 66-char
  // budget and an authored short form exists for this locale (see
  // FaqHubEntry.titleShort). Only <title> uses it: <h1>, JSON-LD and OG all
  // keep the question verbatim below.
  const titleTag = entry.titleShort?.[locale] ?? question;
  const categoryLabel = FAQ_HUB_CATEGORY_LABELS[entry.category][locale];
  // Per-entry hero: the question IS the headline on the card, in the JSON-LD
  // caption and in og:image:alt. `entry.id` keys it, so the 416 entry pages
  // get 416 distinct cards rather than one shared family image.
  const hero: SeoHeroImageOpts = {
    family: 'faq-hub', key: entry.id, locale, headline: question, eyebrow: categoryLabel, alt: question,
  };

  const urlPath = buildFaqEntryPath(locale, entry.id);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubParentUrl = `${BASE_URL}${GUIDA_HUB_PATH[locale]}`;
  const hubUrl = `${BASE_URL}${buildFaqHubPath(locale)}`;

  // Hreflang via the ONE builder every locale-scoped emitter now uses (#5179).
  // The all-or-nothing rule lives there, not here: an incomplete set emits
  // nothing, because a partial block only trades audit-hreflang's
  // [missingTarget] for [tooFew]. Keeping a local copy of that rule is exactly
  // the duplication that PR removed.
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildFaqEntryPath(alt as FaqHubLocale, entry.id)}`,
    indent: '    ',
  });

  const answerHtml = mdLinks(linkifyCitations(entry.answer[locale], entry.sources));

  const sourcesHtml =
    entry.sources && entry.sources.length > 0
      ? `<section class="fh-rls"><h2 class="fh-rlh">${esc(ecopy.sourcesHeading)}</h2><ul class="fh-rll">${entry.sources
          .map(
            (src) =>
              `<li class="fh-rli"><a href="${esc(src)}" class="fh-lnk" rel="nofollow noopener" target="_blank">${esc(
                src.replace(/^https?:\/\//, '').replace(/\/$/, ''),
              )}</a></li>`,
          )
          .join('')}</ul></section>`
      : '';

  const related = entry.relatedLinks ?? [];
  const relatedHtml =
    related.length > 0
      ? `<section class="fh-rls"><h2 class="fh-rlh">${esc(ecopy.seeAlsoHeading)}</h2><ul class="fh-rll">${related
          .map(
            (l) =>
              `<li class="fh-rli"><a href="${esc(resolveRelatedHref(l.href, locale))}" class="fh-lnk">${esc(
                l.label[locale],
              )}</a></li>`,
          )
          .join('')}</ul></section>`
      : '';

  // Each sibling carries the opening of its own answer, not just its question.
  // A bare list of questions asks the reader to click to find out whether any
  // of them is the one they actually meant; with the answer's first sentences
  // under it the block answers some of them outright and the click is an
  // informed one. It is also the only substantial body text on this page that
  // is not the single answer itself — see the text-to-HTML note in the
  // "Per-question pages" banner above before trimming it back.
  const siblings = siblingEntries(entry, linkedIds);
  const siblingsHtml =
    siblings.length > 0
      ? `<section class="fh-rls"><h2 class="fh-rlh">${esc(ecopy.siblingsHeading)}</h2><ul class="fh-rll">${siblings
          .map(
            (sib) =>
              `<li class="fh-rli"><a href="${esc(buildFaqEntryPath(locale, sib.id))}" class="fh-lnk">${esc(
                sib.question[locale],
              )}</a><p class="fh-tocc">${esc(answerSnippet(sib, locale))}</p></li>`,
          )
          .join('')}</ul></section>`
      : '';

  const body = `
    <nav class="fh-bc" aria-label="Breadcrumb">
      <a href="${esc(homeUrl)}" class="fh-lnk">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubParentUrl)}" class="fh-lnk">${esc(copy.breadcrumbHub)}</a>
      <span> / </span>
      <a href="${esc(hubUrl)}" class="fh-lnk">${esc(copy.h1)}</a>
      <span> / </span>
      <span>${esc(categoryLabel)}</span>
    </nav>
    <header class="fh-hd">
      <p class="fh-eyebrow">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
    </header>
    ${renderSeoHeroImage(hero)}
    <section class="fh-q" data-speakable>
      <h2 class="fh-qt">${esc(ecopy.answerHeading)}</h2>
      <p class="fh-qa">${answerHtml}</p>
    </section>
    ${sourcesHtml}
    ${relatedHtml}
    ${siblingsHtml}
    <p class="fh-disc">${esc(copy.disclaimer)}</p>
    <p class="fh-back"><a href="${esc(hubUrl)}" class="fh-lnk">${esc(ecopy.backToHub)}</a></p>
  `;

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `<main class="fh-main">${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}</main>`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbHub, item: hubParentUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: hubUrl },
      { '@type': 'ListItem', position: 4, name: question, item: canonicalUrl },
    ],
  });

  // One Question per page, with the full answer text — the same body the HTML
  // shows. A page whose structured data disagrees with its visible answer is
  // worse than one with no structured data (#4398).
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    url: canonicalUrl,
    mainEntity: [
      {
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: plainAnswer(entry, locale) },
      },
    ],
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: question,
    description: guardArticleJsonLdDescription(plainAnswer(entry, locale)),
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
    isPartOf: { '@type': 'WebPage', '@id': hubUrl },
    articleSection: categoryLabel,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '[data-speakable]'] },
  });

  const html = buildSeoPageHtml({
    locale,
    // The question IS the title. It is what the user typed, so it is also the
    // best possible title-tag: no keyword assembly, no promise the body has to
    // live up to separately. The one exception is length — a question past 66
    // chars is truncated in the SERP, so those carry an authored `titleShort`
    // and `titleTag` resolves to it.
    title: titleTag,
    description: plainAnswer(entry, locale),
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    ogImage: seoHeroImageUrl(hero),
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: question,
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'guida',
      activeSubTab: 'permits',
      // hubChrome's hero emits the page's only <h1> — so the <h1> is the
      // question verbatim, which is exactly the heading this page should have.
      //
      // But `title:` above is normally that SAME question, so <title> and <h1>
      // match word for word and the page ships a duplicate pair (Semrush
      // "Duplicate H1 and title tags"). The brand suffix normally tells the two
      // apart; buildTitleWithBrand drops it once the headline passes 45 chars,
      // and a question always does. So the H1 always gains the locale-aware tag
      // while the <title>, and its keywords, are left exactly as they are —
      // salaryHubArticles.ts does the same for the same reason.
      //
      // Argument order matters and is easy to get backwards: the signature is
      // (h1, title, locale) and the helper RETURNS THE FIRST ARGUMENT. So the
      // H1 is always `question` — the full, unshortened phrasing — and the
      // string it must differ FROM is `titleTag`, i.e. whatever the <title>
      // actually ended up being. Passing `titleTag` first would silently make
      // the H1 the shortened form on exactly the pages that carry a
      // `titleShort`, which is the opposite of what this file wants.
      //
      // With no `titleShort` the two are identical, so the H1 gains the
      // locale-aware tag exactly as before. With one, they already differ and
      // the helper returns the question untouched.
      hero: {
        title: differentiateH1FromTitle(question, titleTag, locale),
        subtitle: ecopy.heroSubtitle(categoryLabel),
        variant: 'green',
      },
    },
  });

  return { urlPath, html, wordCount, faqCount: 1 };
}

// ── Sitemap ──────────────────────────────────────────────────────

function buildSitemapXml(
  entries: Array<{ canonical: string; alternates: string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`,
        )
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.85</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

// ── Plugin entry ─────────────────────────────────────────────────

export function faqHubPlugin(rootDir: string): Plugin {
  return {
    name: 'faq-hub',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_FAQ_HUB === '1') {
        console.log('\x1b[33m[faq-hub]\x1b[0m Skipped (SKIP_FAQ_HUB=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'faqHubPlugin',
      });

      // ── Pass 1: which locales clear the indexability floor? ────────────
      // The floor is per-locale, so it can drop DE while keeping IT. Deciding
      // it BEFORE any page is rendered for real is what makes it impossible
      // to advertise a hub that never gets written (#5114 class). `wordCount`
      // is derived from the body alone, so this pass is not affected by the
      // empty hreflang block it renders with.
      const eligibleLocales = new Set<string>(
        FAQ_HUB_LOCALES.filter(
          (locale) => renderPage(locale, dateStamp, distDir).wordCount >= MIN_INDEXABLE_WORDS,
        ),
      );

      // Sitemap alternates track the same set: an ineligible locale has no
      // page, so advertising it would point the crawler at a 404.
      const alternates = FAQ_HUB_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
        (alt) => `${alt}|${BASE_URL}${buildFaqHubPath(alt)}`,
      );
      if (eligibleLocales.has('it')) {
        alternates.push(`x-default|${BASE_URL}${buildFaqHubPath('it')}`);
      }

      // Same idea one level down: which entries get their own page, per locale.
      // Settled here, before any render, so the hub can link only what exists
      // and the entry hreflang can advertise only what was planned.
      const entryLocales = new Map<string, Set<FaqHubLocale>>(
        ALL_FAQ_HUB.map((entry) => [entry.id, entryPageEligibleLocales(entry)] as const),
      );

      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;
      let itWasWritten = false;

      // ── Pass 2: render for real, with the settled alternate set ────────
      for (const locale of FAQ_HUB_LOCALES) {
        const rendered = renderPage(locale, dateStamp, distDir, eligibleLocales, linkedIdsForLocale(locale, entryLocales));

        if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
          thinSkipped++;
          console.warn(
            `\x1b[33m[faq-hub]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
          );
          continue;
        }

        const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);

        // Every locale gets its own reciprocal <loc> entry (all 4 carry the
        // same alternates set) — an IT-only push here would leave en/de/fr
        // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
        // Non-IT pushes require the IT anchor itself to have been written
        // this run (FAQ_HUB_LOCALES starts with 'it', so itWasWritten is
        // settled before en/de/fr) — an unconditional push would leave a
        // dangling IT alternate when the IT render is itself thin-skipped.
        if (locale === 'it') {
          itWasWritten = true;
          sitemapEntries.push({ canonical: rendered.urlPath, alternates });
        } else if (itWasWritten) {
          sitemapEntries.push({ canonical: rendered.urlPath, alternates });
        }
        pagesWritten++;
      }

      // ── Per-question pages ──────────────────────────────────────
      let entryPagesWritten = 0;
      let entryLocalesSkipped = 0;
      for (const entry of ALL_FAQ_HUB) {
        const locales = entryLocales.get(entry.id)!;
        entryLocalesSkipped += FAQ_HUB_LOCALES.length - locales.size;
        if (locales.size === 0) continue;

        const linkedIds = new Set([entry.id]);
        // Sitemap alternates FILTER rather than void — reciprocity only needs
        // every advertised alternate to be a <loc> the site publishes, and the
        // `tooFew` rule is an HTML-block rule, not a sitemap one (#5179).
        const entryAlternates = FAQ_HUB_LOCALES.filter((alt) => locales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildFaqEntryPath(alt, entry.id)}`,
        );
        if (locales.has('it')) {
          entryAlternates.push(`x-default|${BASE_URL}${buildFaqEntryPath('it', entry.id)}`);
        }

        for (const locale of locales) {
          const rendered = renderEntryPage(
            entry,
            locale,
            dateStamp,
            linkedIdsForLocale(locale, entryLocales),
            locales,
            distDir,
          );
          // Belt and braces: entryPageEligibleLocales() is conservative (chrome
          // only adds words), so this cannot fire. If it ever does, the
          // predicate and the renderer have drifted — skip rather than ship thin.
          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            console.warn(
              `\x1b[33m[faq-hub]\x1b[0m entry ${entry.id} rendered thin in ${locale} (${rendered.wordCount}) — skipped`,
            );
            continue;
          }
          collector.add(np.join(distDir, rendered.urlPath, 'index.html'), rendered.html);
          collector.add(np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html'), rendered.html);
          sitemapEntries.push({ canonical: rendered.urlPath, alternates: entryAlternates });
          entryPagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = np.join(distDir, 'sitemap-faq-hub.xml');
          fs.writeFileSync(sitemapPath, xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[faq-hub]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[faq-hub]\x1b[0m Generated ${pagesWritten} hub + ${entryPagesWritten} per-question pages ` +
          `(${thinSkipped} hub / ${entryLocalesSkipped} question-locale skipped as thin) — flushed ${written} files in ` +
          `${((Date.now() - t0) / 1000).toFixed(1)}s · total entries: ${ALL_FAQ_HUB.length}`,
      );
    },
  };
}

// ── Test hooks ───────────────────────────────────────────────────
// Named `__…ForTest` following holidaysLandingsPlugin / minimumWageLandingsPlugin:
// the renderers stay private, the tests drive them without a dist/ tree.
export const __renderFaqEntryPageForTest = renderEntryPage;
export const __renderFaqHubPageForTest = renderPage;
export const __faqEntryPageEligibleLocalesForTest = entryPageEligibleLocales;
export const __faqLinkedIdsForLocaleForTest = linkedIdsForLocale;
export const __faqSiblingEntriesForTest = siblingEntries;
