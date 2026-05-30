// clusterThinShell.ts
//
// Thin-shell post-processor for cluster pages emitted by
// relatedSearchClustersPlugin (the `/cerca-lavoro-X/ricerca-Y/` family
// and locale equivalents — by far the largest jobs-seo sub-bucket,
// 517 k pages = 5.17 GB / 57 % on the 2026-05-28 dist).
//
// Operates on the rendered HTML returned by `renderClusterPage`. The
// page structure is:
//
//   <head>…</head>
//   <body>
//     <div id="root"></div>
//     <main class=cluster-seo-prose>
//       <div class=related-search-cluster>
//         <h1>…</h1>
//         <ul class=cluster-seo-jobs>… 30 job links …</ul>
//         <section>…related searches…</section>
//         <section>…commuter context…</section>
//         …
//       </div>
//     </main>
//     <div id=footer-root></div>
//     <script type=module src=/assets/index-X.js></script>
//   </body>
//
// Real artifact sample (cerca-lavoro-ticino/ricerca-mansioni-lingerie-80/):
//   total 10 306 B; `<main class=cluster-seo-prose>` block = 7 920 B (77 %).
//
// HEAD is preserved verbatim (canonical, hreflang, OG meta, JSON-LD
// BreadcrumbList) — every Google-visible signal stays identical. Only
// the `<main>` block shrinks to a slim h1 + ≥50-word paragraph linking
// back to the canonical hub.
//
// SPA hydration: the cluster URL routes through the SPA's
// JobBoard component which reads the slug + canton from the URL via
// `parsePath`/`parseSearchSlugFilter` and renders the filtered listing
// dynamically. App.tsx's static-overlay hider drops the thin static
// body for non-staticOverlay routes (cluster URLs resolve to a SPA
// view), so JS-enabled users see the full hydrated listing identical
// to today.
//
// Adds `window.__THIN_SHELL__=1` in head so App.tsx fires
// `thin_page_view` on PostHog + Firebase Analytics → hourly workflow
// lifts hit URLs into thin-page-promotions-active.json → next deploy
// returns 'full' for them. ≤25 h self-heal.

import { EJP_STRIPPED_MARKER } from './ejpMarker';

const LOCALE_LISTING_PATH: Record<string, string> = {
  it: '/cerca-lavoro-svizzera/',
  en: '/en/find-jobs-switzerland/',
  de: '/de/jobs-in-schweiz/',
  fr: '/fr/trouver-emploi-suisse/',
};

const PROSE: Record<string, (query: string, listingUrl: string) => string> = {
  it: (q, l) =>
    `Sul nostro job board indicizziamo ogni giorno migliaia di posizioni aperte presso aziende svizzere. Per esplorare tutte le offerte disponibili — comprese quelle pertinenti a "${q}" — apri la <a href="${l}">job board completa</a> con filtri per cantone, settore, contratto, fascia di stipendio e località. Gli annunci sono aggiornati quotidianamente dai datori di lavoro in Ticino, Grigioni, Zurigo, Berna, Basilea, Vaud e altri cantoni. Ogni offerta mostra stipendio, contratto, sede di lavoro e link diretto al sito dell'azienda. Le ricerche correlate ti aiutano a scoprire posizioni simili nello stesso settore o nella stessa zona geografica.`,
  en: (q, l) =>
    `Our job board indexes thousands of open positions at Swiss companies every day. To browse all available openings — including those relevant to "${q}" — open the <a href="${l}">complete job board</a> with filters by canton, sector, contract type, salary band and location. Listings are updated daily by employers across Ticino, Graubünden, Zurich, Bern, Basel, Vaud and other cantons. Each posting shows salary, contract type, work location, and a direct link to the employer's site. Related searches help you discover similar positions in the same sector or geographic area.`,
  de: (q, l) =>
    `Unser Job Board indiziert täglich tausende offene Stellen bei Schweizer Unternehmen. Um alle verfügbaren Angebote zu durchsuchen — auch jene, die zu "${q}" passen — öffnen Sie das <a href="${l}">vollständige Job Board</a> mit Filtern nach Kanton, Branche, Vertragsart, Lohnband und Arbeitsort. Die Angebote werden täglich von Arbeitgebern aus Tessin, Graubünden, Zürich, Bern, Basel, Waadt und weiteren Kantonen aktualisiert. Jedes Inserat zeigt Lohn, Vertragsart, Arbeitsort und einen direkten Link zur Webseite des Arbeitgebers. Verwandte Suchanfragen helfen Ihnen, ähnliche Positionen in derselben Branche oder geographischen Region zu finden.`,
  fr: (q, l) =>
    `Notre job board indexe quotidiennement des milliers de postes ouverts auprès d'entreprises suisses. Pour parcourir toutes les offres disponibles — y compris celles qui correspondent à "${q}" — ouvrez le <a href="${l}">job board complet</a> avec des filtres par canton, secteur, type de contrat, fourchette salariale et lieu. Les offres sont mises à jour quotidiennement par des employeurs au Tessin, dans les Grisons, à Zurich, Berne, Bâle, Vaud et d'autres cantons. Chaque annonce affiche le salaire, le type de contrat, le lieu de travail et un lien direct vers le site de l'employeur. Les recherches associées vous aident à découvrir des postes similaires dans le même secteur ou la même région.`,
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractH1(html: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a full cluster-prose HTML into its thin variant. HEAD is
 * preserved verbatim; the `<main class=cluster-seo-prose>` block is
 * replaced with a slim h1 + ≥50-word paragraph linking back to the
 * canonical Swiss-section hub.
 *
 * Defensive: if the regex doesn't match (unexpected HTML shape),
 * returns the input unchanged so the build can't corrupt a page —
 * the deploy log's `cluster tier: bytes_saved=0B` will surface the
 * miss.
 */
export function buildClusterThinHtml(fullHtml: string, locale: string): string {
  const h1Text = htmlEscape(extractH1(fullHtml));
  const listingPath = LOCALE_LISTING_PATH[locale] || LOCALE_LISTING_PATH.it;
  const proseFn = PROSE[locale] || PROSE.it;
  const prose = proseFn(h1Text || 'offerte di lavoro', listingPath);

  // Match the `<main class=cluster-seo-prose...>...</main>` block. The
  // class attribute is single-token (`cluster-seo-prose`), so the
  // upstream minifier (PR #478 removeAttributeQuotes) strips its
  // quotes. Tolerate both quoted and unquoted forms via the same
  // pattern PR #729 introduced for ft-static-article.
  const thinMain =
    `<main class="seo-static-content static-cluster">` +
    // audit:text-html-ratio skip marker — deliberately-thin shell, same
    // contract as legacy STRIP_* paths (uppercase survives minifier).
    EJP_STRIPPED_MARKER +
    `<article class="proposal">` +
    `<h1>${h1Text}</h1>` +
    `<p>${prose}</p>` +
    `</article>` +
    `</main>`;

  const withThinBody = fullHtml.replace(
    /<main\s+class=["']?cluster-seo-prose(?=[\s>"'])[^>]*>[\s\S]*?<\/main>/i,
    thinMain,
  );

  if (withThinBody === fullHtml) return fullHtml;

  // Inject the thin-shell signal so App.tsx fires thin_page_view.
  return withThinBody.replace(
    '</head>',
    ` <script>window.__THIN_SHELL__=1;</script>\n </head>`,
  );
}
