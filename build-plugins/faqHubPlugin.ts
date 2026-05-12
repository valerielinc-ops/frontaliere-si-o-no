/**
 * FAQ Hub (AE-5) — Vite build plugin.
 *
 * Emits one static HTML landing per locale (4 total) with 100 Q&A grouped
 * in 10 categories:
 *   IT:  /domande-frequenti-frontalieri/
 *   EN:  /en/frequently-asked-questions/
 *   DE:  /de/haeufige-fragen/
 *   FR:  /fr/questions-frequentes/
 *
 * Page body: TL;DR (100w) + table-of-contents + 10 sections (one per
 * category) with anchor IDs, every entry rendered as a semantic
 * <article>/<details> block so the FAQPage JSON-LD aggregates cleanly.
 *
 * Structured data: FAQPage (100 Q&A), BreadcrumbList, Article,
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
import { WriteCollector } from './batchWrite';
import {
  ALL_FAQ_HUB,
  FAQ_HUB_CATEGORIES,
  FAQ_HUB_LOCALES,
  FAQ_HUB_CATEGORY_LABELS,
  buildFaqHubPath,
  getFaqHubByCategory,
} from '../data/faq-hub';
import type { FaqHubCategory, FaqHubEntry, FaqHubLocale } from '../data/faq-hub';
import { imageObjectLd } from '../services/seo/imageObjectLd';

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

const COPY: Record<FaqHubLocale, FaqHubCopy> = {
  it: {
    title:
      '100 domande frequenti dei frontalieri — risposte complete | Frontaliere Ticino',
    description:
      '100 risposte dettagliate per frontalieri italiani in Ticino: fisco 2026, LAMal, permessi G/B, AVS/LPP, stipendi, trasporti, lavoro, famiglia, diritti. Fonti ufficiali AFC, UFAS, SEM, Agenzia Entrate, Fedlex.',
    h1: '100 domande frequenti dei frontalieri italiani in Ticino',
    heroTitle: 'Il tuo centro di riferimento: 100 Q&A sul lavoro frontaliere',
    heroSubtitle:
      '10 categorie, 100 risposte, quattro lingue. Ogni risposta cita la fonte primaria (AFC, Fedlex, UFAS, SEM, Agenzia Entrate, INPS).',
    tldrTitle: 'In sintesi',
    tldrParagraphs: [
      "Questo hub raccoglie 100 risposte verificate alle domande più ricorrenti dei frontalieri italiani che lavorano in Ticino, con attenzione alla nuova legge 2024 (Accordo CH-IT del 23/12/2020 ratificato dalla Legge italiana 83/2023) e alle scadenze fiscali 2026.",
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
    ],
  },
  en: {
    title:
      '100 FAQs for Italian cross-border workers in Ticino — full answers | Frontaliere Ticino',
    description:
      '100 detailed answers for Italian cross-border workers in Ticino: 2026 tax, LAMal, G/B permits, AVS/LPP, salary, transport, work, family, rights. Primary sources: AFC, UFAS, SEM, Agenzia Entrate, Fedlex.',
    h1: '100 FAQs for Italian cross-border workers in Ticino',
    heroTitle: 'Your reference hub: 100 Q&A on cross-border work',
    heroSubtitle:
      '10 categories, 100 answers, four languages. Every answer cites its primary source (AFC, Fedlex, UFAS, SEM, Agenzia Entrate, INPS).',
    tldrTitle: 'In a nutshell',
    tldrParagraphs: [
      "This hub gathers 100 verified answers to the most recurrent questions of Italian cross-border workers employed in Ticino, with focus on the 2024 new law (CH-IT Agreement of 23/12/2020 ratified by Italian Law 83/2023) and the 2026 tax deadlines.",
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
    ],
  },
  de: {
    title:
      '100 häufige Fragen italienischer Grenzgänger im Tessin — Antworten | Frontaliere Ticino',
    description:
      '100 detaillierte Antworten für italienische Grenzgänger im Tessin: Steuern 2026, KVG, G/B-Bewilligung, AHV/BVG, Lohn, Verkehr, Arbeit, Familie, Rechte. Primärquellen: AFC, BSV, SEM, Agenzia Entrate, Fedlex.',
    h1: '100 häufige Fragen italienischer Grenzgänger im Tessin',
    heroTitle: 'Ihre Nachschlagebasis: 100 Q&A zur Grenzgängerarbeit',
    heroSubtitle:
      '10 Kategorien, 100 Antworten, vier Sprachen. Jede Antwort nennt die Primärquelle (AFC, Fedlex, BSV, SEM, Agenzia Entrate, INPS).',
    tldrTitle: 'Kurz gefasst',
    tldrParagraphs: [
      'Dieser Hub sammelt 100 geprüfte Antworten auf die häufigsten Fragen italienischer Grenzgänger im Tessin, mit Schwerpunkt auf dem neuen Gesetz 2024 (CH-IT-Abkommen vom 23.12.2020, ratifiziert durch das italienische Gesetz 83/2023) und den Steuerfristen 2026.',
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
    ],
  },
  fr: {
    title:
      '100 questions fréquentes des frontaliers au Tessin — réponses | Frontaliere Ticino',
    description:
      '100 réponses détaillées pour les frontaliers italiens au Tessin : impôts 2026, LAMal, permis G/B, AVS/LPP, salaire, transports, travail, famille, droits. Sources officielles : AFC, OFAS, SEM, Agenzia Entrate, Fedlex.',
    h1: '100 questions fréquentes des frontaliers italiens au Tessin',
    heroTitle: 'Votre centre de référence : 100 Q&R sur le travail frontalier',
    heroSubtitle:
      '10 catégories, 100 réponses, quatre langues. Chaque réponse cite sa source primaire (AFC, Fedlex, OFAS, SEM, Agenzia Entrate, INPS).',
    tldrTitle: 'En bref',
    tldrParagraphs: [
      "Ce hub rassemble 100 réponses vérifiées aux questions les plus fréquentes des frontaliers italiens employés au Tessin, avec un focus sur la nouvelle loi 2024 (Accord CH-IT du 23/12/2020 ratifié par la loi italienne 83/2023) et les échéances fiscales 2026.",
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
    ],
  },
};

const OG_LOCALE: Record<FaqHubLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
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
      `<a href="${String(href).replace(/"/g, '&quot;')}" rel="nofollow" target="_blank" style="color:var(--link,#1d4ed8);text-decoration:underline">${label}</a>`,
  );
}

/**
 * Condense a long FAQ answer into a SERP-friendly snippet for the JSON-LD
 * `acceptedAnswer.text` field. The full answer remains visible in the HTML
 * body (`<article>`), so users get the complete content; the schema only
 * needs a representative summary that Google can show in rich results.
 *
 * Cuts at a sentence boundary if one sits past 60% of the soft cap; falls
 * back to a word-boundary truncation with an ellipsis. Pure function — no
 * mutation of the input string.
 */
function truncateForSchema(text: string, maxChars = 280): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastSentence > maxChars * 0.6) {
    return slice.slice(0, lastSentence + 1);
  }
  const lastSpace = slice.lastIndexOf(' ');
  const safe = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${safe}…`;
}

function renderEntry(entry: FaqHubEntry, locale: FaqHubLocale): string {
  const q = entry.question[locale];
  const a = entry.answer[locale];
  const related = entry.relatedLinks ?? [];
  const relatedHtml =
    related.length > 0
      ? `<ul class="fh-rel">${related
          .map(
            (l) =>
              `<li><a href="${esc(l.href)}" class="fh-lnk">${esc(
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
    return `<li class="fh-toci"><a href="#cat-${esc(cat)}" class="fh-lnk">${esc(label)}</a> <span class="fh-tocc">(10)</span></li>`;
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

function renderPage(locale: FaqHubLocale, dateStamp: string, distDir?: string): RenderResult {
  const copy = COPY[locale];
  const urlPath = buildFaqHubPath(locale);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubParentUrl = `${BASE_URL}${GUIDA_HUB_PATH[locale]}`;

  // Hreflang (4 locales + x-default).
  const hreflangLines = FAQ_HUB_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildFaqHubPath(alt)}">`,
  );
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildFaqHubPath('it')}">`,
  );
  const alternates = hreflangLines.join('\n');

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
      <p class="fh-eyebrow">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
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

  const bodyHtml = `<main class="seo-static-content fh-main">${body}</main>`;

  // ── Structured data ────────────────────────────────────────────
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbHub, item: hubParentUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: allEntries.map((e) => ({
      '@type': 'Question',
      name: e.question[locale],
      acceptedAnswer: {
        '@type': 'Answer',
        // Strip markdown link syntax for the JSON-LD answer text — Google
        // parsers prefer plain text, and links are present in HTML body.
        // Truncate to a concise summary (~280 chars at sentence boundary)
        // to keep the page HTML under the 200 KB budget. The full answer
        // (80-180 words) remains in the rendered HTML body, so visible
        // content is unchanged — only the schema snippet is condensed.
        text: truncateForSchema(
          e.answer[locale].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
        ),
      },
    })),
  });

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: copy.description,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
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

  // Inline CSS for the FAQ hub static body. Extracted from per-element
  // `style="…"` attrs to keep the rendered HTML under the 200 KB page-weight
  // gate (100 Q&A × ~60 bytes of repeated wrapper styles = ~6 KB; the full
  // set of repeated styles saves ~38 KB per page). Visual output is
  // byte-identical to the previous inline-style version.
  const faqHubStyle = `    <style>.fh-main{max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--text-base,#0f172a);background:var(--bg,#f8fafc)}.fh-bc{margin:0 0 14px;font-size:13px;color:var(--text-muted,#475569)}.fh-lnk{color:var(--link,#1d4ed8);text-decoration:none}.fh-hd{margin-bottom:24px}.fh-eyebrow{margin:0 0 8px;color:var(--accent,#4f46e5);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.fh-h1{margin:0 0 16px;font-size:clamp(1.9rem,4vw,2.6rem);line-height:1.15;font-weight:800}.fh-tldr{margin:0 0 24px}.fh-tldh{margin:0 0 12px;font-size:22px;color:var(--text-base,#0f172a)}.fh-tldp{margin:0 0 14px;color:var(--text-base,#0f172a);line-height:1.7;max-width:860px}.fh-toc{margin:0 0 28px;padding:16px 20px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;background:var(--surface-alt,#f8fafc)}.fh-toch{margin:0 0 12px;font-size:18px;color:var(--text-base,#0f172a)}.fh-tocl{margin:0;padding:0 0 0 18px;color:var(--text-base,#0f172a);line-height:1.65}.fh-toci{margin:0 0 6px}.fh-tocc{color:var(--text-muted,#475569);font-size:13px}.fh-cat{margin:0 0 36px;scroll-margin-top:96px}.fh-cath{margin:0 0 14px;font-size:22px;color:var(--text-base,#0f172a);border-bottom:2px solid var(--surface-border,#e2e8f0);padding-bottom:8px}.fh-q{margin:0 0 14px;padding:16px 18px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;background:var(--surface,#ffffff);scroll-margin-top:96px}.fh-qt{margin:0 0 10px;font-size:17px;line-height:1.4;color:var(--text-base,#0f172a)}.fh-qa{margin:0;color:var(--text-base,#0f172a);line-height:1.65}.fh-rel{margin:10px 0 0;padding:0 0 0 18px;color:var(--text-base,#0f172a);font-size:13px;line-height:1.55}.fh-disc{margin:0 0 20px;color:var(--text-muted,#475569);font-size:13px;line-height:1.55;max-width:860px}.fh-rls{margin:0 0 28px}.fh-rlh{margin:0 0 12px;font-size:22px;color:var(--text-base,#0f172a)}.fh-rll{margin:0;padding:0 0 0 20px;color:var(--text-base,#0f172a);line-height:1.6;max-width:860px}.fh-rli{margin:0 0 8px}</style>`;

  const extraHead = `${faqHubStyle}
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

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
    extraHeadHtml: extraHead,
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

      const alternates = FAQ_HUB_LOCALES.map(
        (alt) => `${alt}|${BASE_URL}${buildFaqHubPath(alt)}`,
      );
      alternates.push(`x-default|${BASE_URL}${buildFaqHubPath('it')}`);

      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const locale of FAQ_HUB_LOCALES) {
        const rendered = renderPage(locale, dateStamp, distDir);

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

        if (locale === 'it') {
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
