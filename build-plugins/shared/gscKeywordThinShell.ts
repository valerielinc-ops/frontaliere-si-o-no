// gscKeywordThinShell.ts
//
// Thin-shell body for GSC keyword landing pages (the
// `/cerca-lavoro-X/ricerca-Y/`, `/en/find-jobs-X/search-Y/`, etc.
// family — emitted by 3 sites in jobsSeoPagesPlugin: predefined-keyword
// landings, search-stats landings, search-combo landings — all share
// the same URL shape and SPA route).
//
// SPA-side rendering: the JobBoard component reads the leaf slug from
// the URL via `parseSearchSlugFilter` (components/community/JobBoard.tsx
// ~line 1881) and renders the filtered listing dynamically. The static
// `<main class="seo-static-content">` payload is only the crawler-facing
// fallback — App.tsx's useLayoutEffect at App.tsx:204-212 hides it for
// non-staticOverlay routes (search routes resolve to a SPA view), so
// JS-enabled users see the full hydrated listing identical to the
// pre-thin behaviour.
//
// HEAD (canonical, hreflang, OG meta, JSON-LD BreadcrumbList +
// CollectionPage, og:image) is built by buildSeoPageHtml unchanged.
// Only the bodyHtml shrinks: full version is ~10 KB (intro + cta + job
// list + market section + commuter context); thin version is ~700 B
// (h1 + ≥50-word paragraph + link to the canonical listing).
//
// Adds `window.__THIN_SHELL__=1` via the caller's extraHeadHtml so
// App.tsx fires `thin_page_view` on mount → hourly workflow lifts the
// URL into thin-page-promotions-active.json → next deploy returns
// 'full' for it. Self-heal latency ≤25 h.

import { EJP_STRIPPED_MARKER } from './ejpMarker';

interface ThinBodyOpts {
  locale: string;
  /** Display string for the query, e.g. "infermieri turno notte". */
  query: string;
  /** Canonical hub URL (target of the "browse all" link), e.g.
   *  `https://frontaliereticino.ch/cerca-lavoro-ticino/`. */
  listingUrl: string;
  /** Title text already escaped for HTML interpolation. */
  h1Title: string;
  /**
   * Total matching job count (issue #4399) — the caller already computes
   * this (`kwJobs.length` / `matchingJobs.length`) to build the full-body
   * intro, so no extraction is needed here, just threading it through.
   */
  jobCount?: number;
  /**
   * Up to a few employer names, already HTML-escaped — same `esc()` call
   * the caller already applies when building the full body's
   * `kwTopCompanies` string. Real per-URL facts so each thinned keyword
   * landing keeps something that differs from its siblings beyond the
   * interpolated query token.
   */
  companies?: string[];
}

const PROSE: Record<string, (q: string, listingUrl: string) => string> = {
  it: (q, l) =>
    `Sul nostro job board indicizziamo ogni giorno migliaia di posizioni aperte presso aziende svizzere. Per esplorare tutte le offerte disponibili — incluse quelle che corrispondono a "${q}" — apri la <a href="${l}">job board completa</a> con filtri per cantone, settore, contratto, fascia di stipendio e località. Le offerte vengono aggiornate quotidianamente dai datori di lavoro nei cantoni di Ticino, Grigioni, Zurigo, Berna, Basilea, Vaud e altri. Ogni annuncio mostra stipendio, contratto, sede di lavoro e link diretto al sito dell'azienda.`,
  en: (q, l) =>
    `Our job board indexes thousands of open positions at Swiss companies every day. To browse all available openings — including those matching "${q}" — open the <a href="${l}">complete job board</a> with filters by canton, sector, contract type, salary band and location. Listings are updated daily by employers across Ticino, Graubünden, Zurich, Bern, Basel, Vaud and other cantons. Each posting shows salary, contract type, work location, and a direct link to the employer's site.`,
  de: (q, l) =>
    `Unser Job Board indiziert täglich tausende offene Stellen bei Schweizer Unternehmen. Um alle verfügbaren Angebote zu durchsuchen — auch jene, die zu "${q}" passen — öffnen Sie das <a href="${l}">vollständige Job Board</a> mit Filtern nach Kanton, Branche, Vertragsart, Lohnband und Arbeitsort. Die Angebote werden täglich von Arbeitgebern aus Tessin, Graubünden, Zürich, Bern, Basel, Waadt und weiteren Kantonen aktualisiert. Jedes Inserat zeigt Lohn, Vertragsart, Arbeitsort und einen direkten Link zur Webseite des Arbeitgebers.`,
  fr: (q, l) =>
    `Notre job board indexe quotidiennement des milliers de postes ouverts auprès d'entreprises suisses. Pour parcourir toutes les offres disponibles — y compris celles qui correspondent à "${q}" — ouvrez le <a href="${l}">job board complet</a> avec des filtres par canton, secteur, type de contrat, fourchette salariale et lieu. Les offres sont mises à jour quotidiennement par des employeurs au Tessin, dans les Grisons, à Zurich, Berne, Bâle, Vaud et d'autres cantons. Chaque annonce affiche le salaire, le type de contrat, le lieu de travail et un lien direct vers le site de l'employeur.`,
};

// Splices real per-URL job facts into the thin paragraph as an extra
// sentence (issue #4399 sibling — same static-PROSE-per-locale construct
// as clusterThinShell.ts). Unlike the other three thin-shell builders,
// this one never has a "full" HTML string to extract facts from and
// discard (its 3 call sites in jobsSeoPagesPlugin.ts build this thin
// body directly, without ever assembling the full one) — but those call
// sites already compute `jobCount`/`companies` for their OWN full-body
// intro (kwTopCompanies et al.), so no extraction step is needed here,
// just threading the same values through as opts.
const FACTS: Record<string, (count: number, companies: string[]) => string> = {
  it: (count, companies) =>
    companies.length
      ? `Al momento risultano ${count} posizioni aperte; tra le aziende che assumono: ${companies.join(', ')}.`
      : '',
  en: (count, companies) =>
    companies.length
      ? `There are currently ${count} open positions; hiring companies include: ${companies.join(', ')}.`
      : '',
  de: (count, companies) =>
    companies.length
      ? `Derzeit gibt es ${count} offene Stellen; einstellende Unternehmen: ${companies.join(', ')}.`
      : '',
  fr: (count, companies) =>
    companies.length
      ? `Il y a actuellement ${count} postes ouverts ; entreprises qui recrutent : ${companies.join(', ')}.`
      : '',
};

/**
 * Slim bodyHtml for a GSC keyword landing page. Returns a ≥50-word
 * paragraph wrapped in `<main class="seo-static-content static-search-landing">`
 * — the same class shape used by bridges/soft-landings so App.tsx's
 * static-overlay hider catches it for JS-enabled users.
 */
export function buildGscKeywordThinBody(opts: ThinBodyOpts): string {
  const proseFn = PROSE[opts.locale] || PROSE.it;
  const prose = proseFn(opts.query, opts.listingUrl);
  const companies = (opts.companies || []).slice(0, 3);
  const factsFn = FACTS[opts.locale] || FACTS.it;
  const factsSentence = opts.jobCount ? factsFn(opts.jobCount, companies) : '';
  return (
    // Deliberately-thin shell (zero-traffic, SPA-hydrated): mark it so
    // audit:text-html-ratio skips it, same contract as the legacy STRIP_*
    // paths. Uppercase comment survives the HTML minifier's strip pass.
    EJP_STRIPPED_MARKER +
    `<h1>${opts.h1Title}</h1>` +
    `<p>${prose}${factsSentence ? ` ${factsSentence}` : ''}</p>`
  );
}

/**
 * Inline `<script>` to add to `extraHeadHtml`. Sets `__THIN_SHELL__=1`
 * so App.tsx's mount effect fires `thin_page_view` on PostHog + Firebase
 * Analytics. Pair with buildGscKeywordThinBody() — they go together.
 */
export const GSC_KEYWORD_THIN_HEAD_SCRIPT =
  `<script>window.__THIN_SHELL__=1;</script>`;
