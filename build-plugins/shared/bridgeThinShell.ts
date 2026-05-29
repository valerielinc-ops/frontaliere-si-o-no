// bridgeThinShell.ts
//
// Convert a full previousSlug-bridge cachedHtml into a thin shell by
// replacing only the body's `<main class="seo-static-content">` block
// with a slim h1 + paragraph (≥50 words including a link to the canonical).
//
// **HEAD is preserved verbatim** — every JSON-LD script (JobPosting,
// BreadcrumbList, WebPage, SpeakableSpecification), the canonical link,
// all hreflang alternates, OG meta, structured data, and the SEO static
// CSS link stay byte-identical to the full bridge. The body shrink is
// the only delta. Net saving: ~9-11 KB per bridge with zero loss of
// crawler signals.
//
// Two scripts are injected before `</head>`:
//
//   - `window.__BRIDGE_TARGET_SLUG__ = "..."` — read by the JobBoard SPA
//     mount path (components/community/JobBoard.tsx:1884) so SPA hydration
//     navigates to the canonical job page automatically.
//
//   - `window.__THIN_SHELL__ = 1` — feedback signal. App.tsx detects this
//     on mount and fires `log('thin_page_view', { page_path, url_class })`
//     to PostHog + Firebase Analytics. The hourly workflow
//     refresh-thin-promotions.yml lifts any URL with hits in last hour
//     into data/thin-page-promotions-active.json; the next build's
//     trafficEvidenceFilter sees it and falls back to 'full'. Self-heal
//     latency: ≤25 h (1 h refresh + ≤24 h deploy).
//
// SPA-side rendering: for non-staticOverlay routes (job-detail is one),
// App.tsx:204-212 hides the static `<main class="seo-static-content">`
// element via useLayoutEffect before paint, so JS-enabled users see the
// full SPA-hydrated job page — UX identical to today. Crawlers without
// JS see the thin static body (≥50 words + JSON-LD + canonical), which
// remains a valid indexable page.

import { EJP_STRIPPED_MARKER } from './ejpMarker';

const LOCALE_LISTING_PATH: Record<string, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

const BRIDGE_PROSE: Record<string, (canonicalPath: string, listingPath: string) => string> = {
  it: (canonicalPath, listingPath) =>
    `Questa offerta è stata aggiornata e ora vive alla nuova pagina canonica. Continua a vedere tutti i dettagli — stipendio, sede di lavoro, contratto, candidatura — sulla versione più recente dell'annuncio. Se la pagina non si carica automaticamente, vai alla <a href="${canonicalPath}">pagina aggiornata dell'offerta</a> oppure consulta tutte le <a href="${listingPath}">offerte di lavoro in Ticino</a>. La nostra piattaforma indicizza quotidianamente migliaia di posizioni aperte presso aziende svizzere per frontalieri italiani.`,
  en: (canonicalPath, listingPath) =>
    `This job listing has been updated and now lives on the new canonical page. Continue to see all the details — salary, location, contract, application — on the most recent version of the offer. If the page does not load automatically, go to the <a href="${canonicalPath}">updated job offer page</a> or browse all the <a href="${listingPath}">jobs in Ticino</a>. Our platform indexes thousands of open positions at Swiss companies for Italian cross-border workers every day.`,
  de: (canonicalPath, listingPath) =>
    `Dieses Stellenangebot wurde aktualisiert und befindet sich nun auf der neuen kanonischen Seite. Sehen Sie alle Details — Gehalt, Arbeitsort, Vertrag, Bewerbung — weiterhin auf der aktuellsten Version des Inserats. Falls die Seite nicht automatisch geladen wird, gehen Sie zur <a href="${canonicalPath}">aktualisierten Stellenangebot-Seite</a> oder schauen Sie sich alle <a href="${listingPath}">Stellen im Tessin</a> an. Unsere Plattform indiziert täglich tausende offene Positionen bei Schweizer Unternehmen für italienische Grenzgänger.`,
  fr: (canonicalPath, listingPath) =>
    `Cette offre d'emploi a été mise à jour et se trouve désormais sur la nouvelle page canonique. Continuez à voir tous les détails — salaire, lieu de travail, contrat, candidature — sur la version la plus récente de l'offre. Si la page ne se charge pas automatiquement, allez à la <a href="${canonicalPath}">page mise à jour de l'offre d'emploi</a> ou consultez toutes les <a href="${listingPath}">offres d'emploi au Tessin</a>. Notre plateforme indexe quotidiennement des milliers de postes ouverts auprès d'entreprises suisses pour les travailleurs frontaliers italiens.`,
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractH1(cachedHtml: string): string {
  const m = cachedHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  // Strip nested tags, collapse whitespace
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCanonicalUrl(cachedHtml: string): string {
  const m = cachedHtml.match(/<link\s+rel=["']?canonical["']?\s+href=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function canonicalPathFromUrl(url: string): string {
  if (!url) return '/';
  if (url.startsWith('/')) return url;
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return '/';
  }
}

/**
 * Build a thin variant of the bridge HTML.
 *
 * @param cachedHtml  The canonical job's full HTML (what the current bridge
 *                    pipeline reuses verbatim).
 * @param targetSlug  Canonical slug the bridge points to (injected into
 *                    `window.__BRIDGE_TARGET_SLUG__`).
 * @param locale      'it' | 'en' | 'de' | 'fr'.
 * @returns           Thin bridge HTML (~3-5 KB instead of ~30-50 KB).
 */
export function buildBridgeThinHtml(cachedHtml: string, targetSlug: string, locale: string): string {
  const h1Text = htmlEscape(extractH1(cachedHtml));
  const canonicalUrl = extractCanonicalUrl(cachedHtml);
  const canonicalPath = canonicalPathFromUrl(canonicalUrl);
  const listingPath = LOCALE_LISTING_PATH[locale] || LOCALE_LISTING_PATH.it;
  const proseFn = BRIDGE_PROSE[locale] || BRIDGE_PROSE.it;
  const prose = proseFn(canonicalPath, listingPath);

  // Match the existing class so App.tsx's static-overlay logic
  // (useLayoutEffect at App.tsx:204-212) finds and hides the static
  // block for JS-enabled users on non-staticOverlay routes.
  const thinMain =
    `<main class="seo-static-content static-bridge-page">` +
    // audit:text-html-ratio skip marker — deliberately-thin shell, same
    // contract as legacy STRIP_* paths (uppercase survives minifier).
    EJP_STRIPPED_MARKER +
    `<article class="proposal">` +
    `<h1>${h1Text}</h1>` +
    `<p>${prose}</p>` +
    `</article>` +
    `</main>`;

  // Replace the entire <main class="seo-static-content..."> block. The
  // regex is non-greedy across newlines and tolerates additional class
  // tokens (e.g. "seo-static-content static-job-page"). The minified
  // bridge HTML has no newlines between tags so `[\s\S]*?` is safe.
  //
  // The class attribute may be quoted or unquoted depending on token
  // count: a multi-token value like `seo-static-content static-job-page`
  // has a space and PR #478 (removeAttributeQuotes) keeps its quotes,
  // but a single-token `seo-static-content` would be unquoted. Today the
  // bridge always emits the multi-token form, but the regex tolerates
  // both shapes so a future change to the class list doesn't silently
  // disable thinning.
  const withThinBody = cachedHtml.replace(
    /<main\s+class=["']?seo-static-content(?=[\s>"'])[^>]*>[\s\S]*?<\/main>/i,
    thinMain,
  );

  // If the regex didn't match (defensive: unexpected HTML shape), return
  // the full HTML untouched rather than corrupting it. The caller will
  // see the byte size unchanged and the run-by-run report will surface
  // the missing thinning.
  if (withThinBody === cachedHtml) return cachedHtml;

  const bridgeScript =
    `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(targetSlug)};window.__THIN_SHELL__=1;</script>`;
  return withThinBody.replace('</head>', ` ${bridgeScript}\n </head>`);
}
