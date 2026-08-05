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

/**
 * Per-locale copy for the ENRICHED shell (issue #5168).
 *
 * The `noindex` band from `trafficEvidenceFilter` removes the provably-inert
 * half of the cluster surface from the index. What is left thin AND indexed is
 * the band that is too young to judge on a 90-day impressions window — and it
 * is exactly that band that still reads as scaled content: one paragraph with
 * a query token swapped, ~140 words, Auto Ads on every one of them.
 *
 * These strings are still boilerplate, so they are deliberately the SMALL part
 * of the enriched page. The weight is carried by `buildJobList` below, which
 * emits real per-URL rows (title, employer, location) already computed by
 * `relatedSearchClustersPlugin`'s `jobLinksHtml` — data no sibling page shares.
 */
const JOBS_HEADING: Record<string, string> = {
  it: 'Posizioni aperte in questa ricerca',
  en: 'Open positions in this search',
  de: 'Offene Stellen in dieser Suche',
  fr: 'Postes ouverts dans cette recherche',
};

const COVERAGE: Record<string, (employers: number, locations: number, topLocations: string) => string> = {
  it: (e, l, top) =>
    `Gli annunci elencati qui sotto provengono da ${e} ${e === 1 ? 'datore di lavoro' : 'datori di lavoro'} e coprono ${l} ${l === 1 ? 'località' : 'località'} (${top}). Ogni riga porta direttamente all'annuncio completo, con contratto, sede e link al sito dell'azienda.`,
  en: (e, l, top) =>
    `The listings below come from ${e} ${e === 1 ? 'employer' : 'employers'} across ${l} ${l === 1 ? 'location' : 'locations'} (${top}). Each row links straight to the full posting, with contract type, workplace and a link to the employer's own site.`,
  de: (e, l, top) =>
    `Die unten aufgeführten Inserate stammen von ${e} ${e === 1 ? 'Arbeitgeber' : 'Arbeitgebern'} an ${l} ${l === 1 ? 'Standort' : 'Standorten'} (${top}). Jede Zeile führt direkt zum vollständigen Inserat, mit Vertragsart, Arbeitsort und Link zur Webseite des Arbeitgebers.`,
  fr: (e, l, top) =>
    `Les annonces ci-dessous proviennent de ${e} ${e === 1 ? 'employeur' : 'employeurs'} répartis sur ${l} ${l === 1 ? 'localité' : 'localités'} (${top}). Chaque ligne mène directement à l'annonce complète, avec le type de contrat, le lieu de travail et un lien vers le site de l'employeur.`,
};

/**
 * Word floor the enriched shell aims for.
 *
 * Not a repo non-negotiable -- that floor is `MIN_INDEXABLE_WORDS = 50` and
 * every cluster page already cleared it (the live audit measured min 122 words
 * across 200 samples, issue #5168). This is the *quality* target: the point of
 * the enriched shell is that the unique-per-page share of the text outweighs
 * the shared paragraph, and ~300 words of real listings is where that flips.
 *
 * Enforced by GROWING the real job list until the target is met rather than by
 * padding prose, so a page only gets as many bytes as it has genuine rows to
 * spend them on. Pages with few matching jobs land under the target and that is
 * the honest outcome -- there is nothing unique left to say about them.
 */
const ENRICHED_TARGET_WORDS = 300;

/** Hard ceiling on rows kept, so a 30-job cluster cannot undo the thinning. */
const ENRICHED_MAX_ROWS = 20;

export interface ThinShellOptions {
  /**
   * Emit the enriched block (coverage sentence + real listing rows).
   *
   * Set for thinned pages that REMAIN indexable; left off for pages the
   * inert-band gate is about to mark `noindex`, which gain nothing from more
   * text and would only pay its bytes. Defaults to `false`, so the shell is
   * unchanged for every caller that does not opt in.
   */
  readonly enrich?: boolean;
}

function countWords(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

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
function extractJobFacts(html: string, max: number): JobFacts {
  const empty: JobFacts = { count: 0, samples: [], rows: [], employers: [], locations: [] };
  const listMatch = html.match(/<ul\s+class=["']?cluster-seo-jobs(?=[\s>"'])[^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) return empty;
  const items = listMatch[1].match(/<li>[\s\S]*?<\/li>/gi) || [];
  const samples: string[] = [];
  const rows: JobRow[] = [];
  const employers: string[] = [];
  const locations: string[] = [];
  for (const item of items) {
    const anchor = item.match(/<a[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const href = anchor[1];
    const text = anchor[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // relatedSearchClustersPlugin joins `title + " — " + meta`, where meta is
    // `company + " · " + location` with either half possibly absent. Prefer the
    // shorter "company · location" tail when present, else the full title.
    const dashIdx = text.indexOf(' — ');
    const title = dashIdx >= 0 ? text.slice(0, dashIdx).trim() : text;
    const meta = dashIdx >= 0 ? text.slice(dashIdx + 3).trim() : '';
    if (meta && !samples.includes(meta)) samples.push(meta);
    rows.push({ href, title, meta, text });
    if (meta) {
      const dotIdx = meta.indexOf(' · ');
      const company = (dotIdx >= 0 ? meta.slice(0, dotIdx) : meta).trim();
      const place = dotIdx >= 0 ? meta.slice(dotIdx + 3).trim() : '';
      if (company && !employers.includes(company)) employers.push(company);
      if (place && !locations.includes(place)) locations.push(place);
    }
  }
  return { count: items.length, samples: samples.slice(0, max), rows, employers, locations };
}

interface JobRow {
  /** Already-relative href emitted by the plugin (BASE_URL stripped). */
  href: string;
  title: string;
  /** `company · location`, possibly empty. */
  meta: string;
  /** Full anchor text as rendered upstream. */
  text: string;
}

interface JobFacts {
  count: number;
  samples: string[];
  rows: JobRow[];
  employers: string[];
  locations: string[];
}

/**
 * Build the enriched block: a coverage sentence naming the real employer and
 * location spread, plus as many real listing rows as it takes to clear
 * {@link ENRICHED_TARGET_WORDS} (capped at {@link ENRICHED_MAX_ROWS}).
 *
 * The rows are re-emitted from `facts.rows`, i.e. from the very `<ul>` the thin
 * shell is about to discard. No new data is read, nothing is fetched and no
 * per-page work is added to the build -- the difference is only how much of
 * what was already rendered survives into the artifact.
 *
 * Returns `''` when there are no rows to show, so a cluster with no matching
 * jobs degrades to exactly today's shell instead of emitting an empty heading.
 */
function buildEnrichedBlock(facts: JobFacts, locale: string, baseWords: number): string {
  if (facts.rows.length === 0) return '';
  const heading = JOBS_HEADING[locale] || JOBS_HEADING.it;
  const coverageFn = COVERAGE[locale] || COVERAGE.it;
  // Reused VERBATIM, never re-escaped — same contract `extractJobFacts` has
  // always relied on for the prose samples. Everything here was read back out
  // of HTML that `relatedSearchClustersPlugin` already put through `esc()`, so
  // a second pass would render `&amp;` as `&amp;amp;` on every employer name
  // containing an ampersand.
  const topLocations = facts.locations.slice(0, 3).join(', ');
  const coverage = facts.employers.length && facts.locations.length
    ? `<p>${coverageFn(facts.employers.length, facts.locations.length, topLocations)}</p>`
    : '';

  let words = baseWords + countWords(coverage) + countWords(heading);
  const rows: string[] = [];
  for (const row of facts.rows) {
    if (rows.length >= ENRICHED_MAX_ROWS) break;
    // Grow only while the page is still short. Every row past the target is
    // bytes on ~140 k pages buying nothing, which is the cost side of the
    // trade the thin shell exists to manage in the first place.
    if (rows.length > 0 && words >= ENRICHED_TARGET_WORDS) break;
    rows.push(`<li><a href="${row.href}">${row.text}</a></li>`);
    words += countWords(row.text);
  }
  return `${coverage}<h2>${heading}</h2><ul class="cluster-seo-jobs">${rows.join('')}</ul>`;
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
export function buildClusterThinHtml(
  fullHtml: string,
  locale: string,
  opts?: ThinShellOptions,
): string {
  const h1Text = htmlEscape(extractH1(fullHtml));
  const listingPath = LOCALE_LISTING_PATH[locale] || LOCALE_LISTING_PATH.it;
  const proseFn = PROSE[locale] || PROSE.it;
  const prose = proseFn(h1Text || 'offerte di lavoro', listingPath);

  // Real per-URL facts (issue #4399) — pulled from the `cluster-seo-jobs`
  // list before it's discarded below. Appended as an extra sentence so
  // the boilerplate paragraph isn't the ONLY content differentiator
  // between the ~300k indexed cluster URLs.
  const facts = extractJobFacts(fullHtml, 3);
  const { count: jobCount, samples: jobSamples } = facts;
  const factsFn = JOB_FACTS[locale] || JOB_FACTS.it;
  const factsSentence = factsFn(jobCount, jobSamples);

  // Issue #5168. Off by default so every existing caller keeps today's
  // output byte-for-byte; the cluster plugin turns it on precisely for the
  // pages that stay in the index.
  const enrichedBlock = opts?.enrich
    ? buildEnrichedBlock(facts, locale, countWords(prose) + countWords(factsSentence) + countWords(h1Text))
    : '';

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
    enrichedBlock +
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
