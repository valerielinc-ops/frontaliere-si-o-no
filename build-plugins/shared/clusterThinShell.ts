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
import { stripScriptsAndStyles } from '../../scripts/lib/strip-scripts-styles.mjs';

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

// Splices 2-3 real per-URL job facts into the thin paragraph as an extra
// sentence (issue #4399). Without this, every cluster page under a given
// locale renders byte-identical prose save for the interpolated query —
// a find-replace signature at ~300k-URL scale that reads as doorway/
// near-duplicate content to a crawler. The `<ul class=cluster-seo-jobs>`
// list is already rendered per-URL (real employer/title/location from
// `ctx.matchingJobs`, see relatedSearchClustersPlugin.ts `jobLinksHtml`)
// and is about to be discarded wholesale by the `<main>` replace below —
// we pull a few entries out first so each thinned page keeps something
// that genuinely differs from its siblings beyond the query token.
const JOB_FACTS: Record<string, (count: number, samples: string[]) => string> = {
  it: (count, samples) =>
    samples.length
      ? `In quest'area risultano attualmente ${count} posizioni aperte; tra le più recenti: ${samples.join(', ')}.`
      : '',
  en: (count, samples) =>
    samples.length
      ? `This area currently lists ${count} open positions; among the most recent: ${samples.join(', ')}.`
      : '',
  de: (count, samples) =>
    samples.length
      ? `In diesem Bereich gibt es derzeit ${count} offene Stellen; zu den aktuellsten zählen: ${samples.join(', ')}.`
      : '',
  fr: (count, samples) =>
    samples.length
      ? `Cette zone compte actuellement ${count} postes ouverts ; parmi les plus récents : ${samples.join(', ')}.`
      : '',
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
  const m = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pull up to `max` short per-job facts (already-escaped "Company ·
 * Location" tail, or the job title when no meta was rendered) out of the
 * `<ul class=cluster-seo-jobs>` list, plus the total job count. Input is
 * post-`minifyHtml` (see relatedSearchClustersPlugin.ts call site), so the
 * single-token `class` attribute may be unquoted — same PR #478
 * `removeAttributeQuotes` quirk the `<main>` regex below already
 * tolerates. Text is reused verbatim (no re-escaping needed): the source
 * already HTML-escapes job title/company/location via `esc()`.
 */
function extractJobFacts(html: string, max: number): { count: number; samples: string[] } {
  const listMatch = html.match(/<ul\s+class=["']?cluster-seo-jobs(?=[\s>"'])[^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) return { count: 0, samples: [] };
  const items = listMatch[1].match(/<li>[\s\S]*?<\/li>/gi) || [];
  const samples: string[] = [];
  for (const item of items) {
    const anchor = item.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const text = anchor[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // relatedSearchClustersPlugin joins `title + " — " + meta`; prefer the
    // shorter "company · location" tail when present, else the full title.
    const dashIdx = text.indexOf(' — ');
    const fact = dashIdx >= 0 ? text.slice(dashIdx + 3).trim() : text;
    if (fact && !samples.includes(fact)) samples.push(fact);
    if (samples.length >= max) break;
  }
  return { count: items.length, samples };
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

  // Real per-URL facts (issue #4399) — pulled from the `cluster-seo-jobs`
  // list before it's discarded below. Appended as an extra sentence so
  // the boilerplate paragraph isn't the ONLY content differentiator
  // between the ~300k indexed cluster URLs.
  const { count: jobCount, samples: jobSamples } = extractJobFacts(fullHtml, 3);
  const factsFn = JOB_FACTS[locale] || JOB_FACTS.it;
  const factsSentence = factsFn(jobCount, jobSamples);

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
    `<p>${prose}${factsSentence ? ` ${factsSentence}` : ''}</p>` +
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
