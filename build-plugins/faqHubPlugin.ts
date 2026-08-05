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
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { formatUpdatedSentence } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import {
  ALL_FAQ_HUB,
  FAQ_HUB_CATEGORIES,
  FAQ_HUB_LOCALES,
  FAQ_HUB_CATEGORY_LABELS,
  buildFaqHubPath,
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
const GUIDA_HUB_PATH: Record<FaqHubLocale, string> = {
  it: '/guida-frontaliere/',
  en: '/en/cross-border-guide/',
  de: '/de/grenzgaenger-ratgeber/',
  fr: '/fr/guide-frontalier/',
};

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

function renderEntry(entry: FaqHubEntry, locale: FaqHubLocale): string {
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
  return `<article id="${esc(entry.id)}" class="fh-q">
  <h3 class="fh-qt">${esc(q)}</h3>
  <p class="fh-qa">${mdLinks(a)}</p>
  ${relatedHtml}
</article>`;
}

function renderCategorySection(
  category: FaqHubCategory,
  locale: FaqHubLocale,
): { html: string; entries: ReadonlyArray<FaqHubEntry> } {
  const entries = getFaqHubByCategory(category);
  const label = FAQ_HUB_CATEGORY_LABELS[category][locale];
  const body = entries.map((e) => renderEntry(e, locale)).join('');
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
): RenderResult {
  const copy = COPY[locale];
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
    const { html, entries } = renderCategorySection(cat, locale);
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
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'guida',
      activeSubTab: 'permits',
      hero: {
        title: copy.heroTitle,
        subtitle: copy.heroSubtitle,
        variant: 'green',
      },
    },
  });

  return { urlPath, html, wordCount, faqCount: allEntries.length };
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

      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;
      let itWasWritten = false;

      // ── Pass 2: render for real, with the settled alternate set ────────
      for (const locale of FAQ_HUB_LOCALES) {
        const rendered = renderPage(locale, dateStamp, distDir, eligibleLocales);

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
        `\x1b[36m[faq-hub]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s · total entries: ${ALL_FAQ_HUB.length}`,
      );
    },
  };
}
