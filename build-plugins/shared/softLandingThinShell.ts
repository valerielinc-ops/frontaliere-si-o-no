// softLandingThinShell.ts
//
// Convert a full expired-job soft-landing HTML page into a thin shell by
// replacing only the `<article class="ft-static-article">` block with a
// slim h1 + paragraph (≥50 words). HEAD is preserved verbatim — every
// JSON-LD block, canonical, hreflang, OG meta, and the
// `window.__EXPIRED_JOB_DATA__` blob the SPA's JobOrphanView reads on
// mount survive byte-identical. Net saving: ~5-8 KB per soft-landing
// page (with STRIP_EXPIRED_JOB_PROSE on; more when prose is in).
//
// One script is added to the head: `window.__THIN_SHELL__ = 1`. The
// App.tsx mount effect fires `thin_page_view` via PostHog + Firebase
// Analytics; the hourly workflow lifts hit URLs into
// data/thin-page-promotions-active.json so the next build's filter
// returns 'full' for them. Self-heal latency: ≤25 h.
//
// SPA-side rendering: unlike previousSlug bridges, soft-landings emit
// their content INSIDE `<div id="root">` so React replaces it on mount
// anyway (the static body is a crawler-only first-paint). The thinning
// shrinks that first-paint payload; user UX after hydration is
// identical to today.

const LOCALE_LISTING_PATH: Record<string, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

const SOFT_LANDING_PROSE: Record<string, (canonicalPath: string, listingPath: string) => string> = {
  it: (canonicalPath, listingPath) =>
    `Questa offerta di lavoro non è più attiva. Per vedere le posizioni aperte equivalenti e i dettagli aggiornati su stipendio, sede e contratto, consulta tutte le <a href="${listingPath}">offerte di lavoro in Ticino</a>. Sul nostro job board indicizziamo ogni giorno migliaia di posizioni presso aziende svizzere per frontalieri italiani, con filtri per canton, settore, contratto e fascia di stipendio. La pagina attuale mantiene il riferimento storico per il motore di ricerca e si aggiorna automaticamente quando ricarichi la lista completa.`,
  en: (canonicalPath, listingPath) =>
    `This job listing is no longer active. To browse equivalent open positions with up-to-date salary, location and contract details, see all the <a href="${listingPath}">jobs in Ticino</a>. Our job board indexes thousands of positions at Swiss companies for Italian cross-border workers every day, with filters by canton, sector, contract type and salary band. This page is preserved as a historical reference and updates automatically when you reload the full listing.`,
  de: (canonicalPath, listingPath) =>
    `Dieses Stellenangebot ist nicht mehr aktiv. Um gleichwertige offene Stellen mit aktuellen Angaben zu Gehalt, Arbeitsort und Vertrag zu sehen, schauen Sie sich alle <a href="${listingPath}">Stellen im Tessin</a> an. Unser Job Board indiziert täglich tausende Positionen bei Schweizer Unternehmen für italienische Grenzgänger, mit Filtern nach Kanton, Branche, Vertragsart und Lohnband. Diese Seite bleibt als historische Referenz erhalten und aktualisiert sich automatisch, wenn Sie die vollständige Liste neu laden.`,
  fr: (canonicalPath, listingPath) =>
    `Cette offre d'emploi n'est plus active. Pour parcourir les postes ouverts équivalents avec les détails à jour sur le salaire, le lieu et le contrat, consultez toutes les <a href="${listingPath}">offres d'emploi au Tessin</a>. Notre job board indexe quotidiennement des milliers de postes auprès d'entreprises suisses pour les travailleurs frontaliers italiens, avec des filtres par canton, secteur, type de contrat et fourchette salariale. Cette page reste comme référence historique et se met à jour automatiquement lorsque vous rechargez la liste complète.`,
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

function extractCanonicalUrl(html: string): string {
  const m = html.match(/<link\s+rel=["']?canonical["']?\s+href=["']([^"']+)["']/i);
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
 * Build a thin variant of the soft-landing HTML.
 *
 * @param fullHtml  The output of buildSoftLandingHtml for this page.
 * @param locale    'it' | 'en' | 'de' | 'fr'.
 * @returns         Thin HTML (~3-5 KB instead of ~10-15 KB).
 */
export function buildSoftLandingThinHtml(fullHtml: string, locale: string): string {
  const h1Text = htmlEscape(extractH1(fullHtml));
  const canonicalUrl = extractCanonicalUrl(fullHtml);
  const canonicalPath = canonicalPathFromUrl(canonicalUrl);
  const listingPath = LOCALE_LISTING_PATH[locale] || LOCALE_LISTING_PATH.it;
  const proseFn = SOFT_LANDING_PROSE[locale] || SOFT_LANDING_PROSE.it;
  const prose = proseFn(canonicalPath, listingPath);

  // Same `ft-static-article` class so the inline snapshot script
  // (last line of soft-landing body) still finds an element to read.
  // Its content is now the thin block — that's fine, JobOrphanView's
  // SPA mount path doesn't rely on this snapshot for data (it reads
  // `__EXPIRED_JOB_DATA__` from head).
  const thinArticle =
    `<article class="ft-static-article">` +
    // audit:text-html-ratio skip marker — deliberately-thin shell, same
    // contract as legacy STRIP_* paths (uppercase survives minifier).
    `<!--EJP_STRIPPED-->` +
    `<h1>${h1Text}</h1>` +
    `<p>${prose}</p>` +
    `</article>`;

  // Replace the entire heavy article with the thin one.
  //
  // PR #478 (removeAttributeQuotes) strips quotes from single-token class
  // values, so the minified output is `<article class=ft-static-article>`
  // (no quotes) NOT `<article class="ft-static-article">`. The verified
  // artifact on 2026-05-28 confirmed the unquoted form is in dist. The
  // lookahead `(?=[\s>"'])` asserts the token ends cleanly (no accidental
  // match against `ft-static-article-xyz` if such a class is ever added).
  const withThinBody = fullHtml.replace(
    /<article\s+class=["']?ft-static-article(?=[\s>"'])[^>]*>[\s\S]*?<\/article>/i,
    thinArticle,
  );

  if (withThinBody === fullHtml) return fullHtml;

  // Add the thin-shell signal in head so App.tsx fires thin_page_view.
  return withThinBody.replace(
    '</head>',
    ` <script>window.__THIN_SHELL__=1;</script>\n </head>`,
  );
}
