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

import { EJP_STRIPPED_MARKER } from './ejpMarker';
import { stripScriptsAndStyles } from '../../scripts/lib/strip-scripts-styles.mjs';
import { extractJobPostingFacts, extractJobPostingFactsReference } from './jobPostingFacts';
import { SECTION_LEGACY_TI_PATH } from './cantonSection';

const LOCALE_LISTING_PATH: Record<string, string> = SECTION_LEGACY_TI_PATH;

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

// Splices the expired job's real employer/location into the thin
// paragraph as an extra sentence (issue #4399 sibling — same
// static-PROSE-per-locale construct as clusterThinShell.ts). Without
// this, SOFT_LANDING_PROSE is 100 % byte-identical across every
// soft-landing URL in a given locale — it doesn't even interpolate a
// query token like the cluster prose does, so it's the most extreme
// case of the doorway/near-duplicate signature in this template family.
const EXPIRED_JOB_FACTS: Record<string, (company: string, location: string) => string> = {
  it: (company, location) =>
    company ? `La posizione era presso ${company}${location ? `, ${location}` : ''}.` : '',
  en: (company, location) =>
    company ? `The position was at ${company}${location ? `, ${location}` : ''}.` : '',
  de: (company, location) =>
    company ? `Die Stelle war bei ${company}${location ? `, ${location}` : ''}.` : '',
  fr: (company, location) =>
    company ? `Le poste était chez ${company}${location ? `, ${location}` : ''}.` : '',
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reference behaviour for {@link extractH1}. Materialises a
 * script/style-stripped copy of the whole document to read a ~60-character
 * string out of it.
 */
function extractH1Reference(html: string): string {
  const m = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Single-scan tokeniser for the fast path below. Module level so it is
// compiled once; every use assigns `lastIndex` first, so no state leaks
// between calls (this module is only ever driven single-threaded from a
// build plugin's closeBundle). The five alternatives have five DISTINCT
// lengths, which is how the loop tells them apart without allocating a
// lowercased copy of each token.
const H1_SCAN = /<script|<\/script>|<style|<h1|<\/h1>/gi;
const SCRIPT_CLOSE_G = /<\/script>/gi;
/** Guards the `<h1[^>]*>` open tag against a script/style opening inside it. */
const TAG_HAS_MARKUP = /<script|<style/i;
/** Article block the thin shell swaps out. Non-global on purpose. */
const ARTICLE_RE = /<article\s+class=["']?ft-static-article(?=[\s>"'])[^>]*>[\s\S]*?<\/article>/i;
/** Head signal App.tsx reads to fire `thin_page_view`. */
const THIN_HEAD_MARKER = ` <script>window.__THIN_SHELL__=1;</script>\n </head>`;

/**
 * Text of the first `<h1>` in the script/style-stripped document.
 *
 * Why not just {@link extractH1Reference}: `stripScriptsAndStyles` is two
 * chained `.replace()` calls, so it allocates two more copies of a ~10 KB
 * document per page. On the `it` leg of run 31065272867 the thin-shell
 * rebuild (`ph:ejp:thin`) cost 219 s across 183 445 soft-landings — 12 % of
 * the whole plugin — in a process whose RSS peaks at 11.4 GB against a
 * 12 GB cap, which is why the transient garbage matters at least as much as
 * the CPU.
 *
 * The fast path walks the document once, tracking `<script>` regions by
 * index, and allocates only the `<h1>` content. It mirrors the strip regex
 * exactly, INCLUDING the lazy `<script` … first `</script>` pairing and the
 * unterminated-`<script>` case (where the regex does not match and the text
 * survives).
 *
 * It only runs when the document contains no `<style` at all — that makes
 * the second strip pass a no-op, so "strip then match" reduces to the
 * single-pass walk. Every other shape (a `<style>` anywhere, an `<h1` open
 * tag straddling a script boundary, an `<h1` with no `</h1>`) defers to
 * {@link extractH1Reference}, so the two agree on every input;
 * `tests/seo/soft-landing-thin-shell-equivalence.test.ts` fuzzes that claim.
 */
function extractH1(html: string): string {
  H1_SCAN.lastIndex = 0;
  let inScript = false;          // inside a `<script` … `</script>` the strip removes
  let scriptEnd = -1;            // end of the region currently being skipped
  let noMoreCloses = false;      // no `</script>` left anywhere after here
  let content: string | null = null;  // non-null once the <h1> tag is open
  let cursor = 0;                // start of the un-appended surviving run
  let m: RegExpExecArray | null;

  while ((m = H1_SCAN.exec(html))) {
    const len = m[0].length;     // 7 `<script`  9 `</script>`  6 `<style`  3 `<h1`  5 `</h1>`
    if (inScript) {
      if (len === 9 && m.index + 9 === scriptEnd) {
        inScript = false;
        cursor = scriptEnd;      // surviving text resumes after the removed run
      }
      continue;
    }
    if (len === 7) {
      // `<script`: the strip regex pairs it with the FIRST following
      // `</script>`; with none, the whole alternative fails to match and the
      // tag survives as ordinary text.
      if (noMoreCloses) continue;
      SCRIPT_CLOSE_G.lastIndex = m.index + 7;
      const close = SCRIPT_CLOSE_G.exec(html);
      if (!close) { noMoreCloses = true; continue; }
      if (content !== null && cursor < m.index) content += html.slice(cursor, m.index);
      inScript = true;
      scriptEnd = close.index + close[0].length;
      H1_SCAN.lastIndex = m.index + 7;
      continue;
    }
    if (len === 6) {
      // A `<style` reachable in surviving text before the <h1> closes: the
      // reference strips scripts FIRST and styles second, and the two orders
      // only agree when they do not nest. Hand it over rather than model it.
      // A `<style` AFTER the closing `</h1>` is never reached — removal only
      // ever deletes text forward of `<style`, so it cannot change the h1.
      return extractH1Reference(html);
    }
    if (len === 3) {
      if (content !== null) continue;          // `<h1` nested in the h1 text
      const gt = html.indexOf('>', m.index);
      if (gt < 0) return extractH1Reference(html);
      // `[^>]*` must be literal surviving text: a script/style opening inside
      // the tag would make the reference strip part of the tag itself.
      const tag = html.slice(m.index, gt);
      if (TAG_HAS_MARKUP.test(tag)) return extractH1Reference(html);
      content = '';
      cursor = gt + 1;
      H1_SCAN.lastIndex = gt + 1;
      continue;
    }
    if (len === 5 && content !== null) {
      if (cursor < m.index) content += html.slice(cursor, m.index);
      return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  // No `<h1` at all → the reference regex has no match either.
  if (content === null) return '';
  // `<h1` with no `</h1>`: the reference backtracks to a later `<h1`, so let
  // it decide.
  return extractH1Reference(html);
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
 * The replacement article, given the three facts read off the page. Shared by
 * the shipping builder and its reference twin so the copy can never diverge
 * between them — only the SCAN strategy differs, which is the whole point of
 * the equivalence test.
 */
function buildThinArticle(
  h1Raw: string,
  company: string,
  location: string,
  canonicalPath: string,
  locale: string,
): string {
  const h1Text = htmlEscape(h1Raw);
  const listingPath = LOCALE_LISTING_PATH[locale] || LOCALE_LISTING_PATH.it;
  const proseFn = SOFT_LANDING_PROSE[locale] || SOFT_LANDING_PROSE.it;
  const prose = proseFn(canonicalPath, listingPath);
  const factsFn = EXPIRED_JOB_FACTS[locale] || EXPIRED_JOB_FACTS.it;
  const factsSentence = factsFn(htmlEscape(company), htmlEscape(location));
  // Same `ft-static-article` class so the inline snapshot script
  // (last line of soft-landing body) still finds an element to read.
  // Its content is now the thin block — that's fine, JobOrphanView's
  // SPA mount path doesn't rely on this snapshot for data (it reads
  // `__EXPIRED_JOB_DATA__` from head).
  return (
    `<article class="ft-static-article">` +
    // audit:text-html-ratio skip marker — deliberately-thin shell, same
    // contract as legacy STRIP_* paths (uppercase survives minifier).
    EJP_STRIPPED_MARKER +
    `<h1>${h1Text}</h1>` +
    `<p>${prose}${factsSentence ? ` ${factsSentence}` : ''}</p>` +
    `</article>`
  );
}

/**
 * Build a thin variant of the soft-landing HTML.
 *
 * @param fullHtml  The output of buildSoftLandingHtml for this page.
 * @param locale    'it' | 'en' | 'de' | 'fr'.
 * @returns         Thin HTML (~3-5 KB instead of ~10-15 KB).
 */
export function buildSoftLandingThinHtml(fullHtml: string, locale: string): string {
  // Real per-URL facts (issue #4399 sibling) — the expired job's own
  // employer/location, pulled from the JobPosting JSON-LD before the
  // article body (which may or may not have repeated them as prose) is
  // discarded below.
  const { company, location } = extractJobPostingFacts(fullHtml);
  const thinArticle = buildThinArticle(
    extractH1(fullHtml),
    company,
    location,
    canonicalPathFromUrl(extractCanonicalUrl(fullHtml)),
    locale,
  );

  // Replace the entire heavy article with the thin one.
  // (Pattern hoisted to ARTICLE_RE — non-global, so `exec` carries no
  // `lastIndex` state between pages.)
  //
  // PR #478 (removeAttributeQuotes) strips quotes from single-token class
  // values, so the minified output is `<article class=ft-static-article>`
  // (no quotes) NOT `<article class="ft-static-article">`. The verified
  // artifact on 2026-05-28 confirmed the unquoted form is in dist. The
  // lookahead `(?=[\s>"'])` asserts the token ends cleanly (no accidental
  // match against `ft-static-article-xyz` if such a class is ever added).
  const match = ARTICLE_RE.exec(fullHtml);
  if (!match) return fullHtml;

  // `String.replace(re, string)` expands `$&`, `$1`, `` $` ``, `$'` and `$$`
  // in the replacement. `thinArticle` embeds the page's own h1 and employer
  // name, so a `$` in either goes through that expansion today — it mangles
  // the page, and it has done so since the thin shell shipped. Keep the
  // original two-`replace` path for those inputs: this change is a speed
  // change, and fixing the quirk here would alter live bytes under cover of
  // it. (Splitting that fix out is listed in the PR body.)
  if (thinArticle.includes('$')) {
    const withThinBody = fullHtml.replace(ARTICLE_RE, thinArticle);
    if (withThinBody === fullHtml) return fullHtml;
    return withThinBody.replace('</head>', THIN_HEAD_MARKER);
  }

  // Splice the article swap and the head signal in ONE pass. The two
  // chained `.replace()` calls this stands in for allocated two more copies
  // of the whole document per page, on top of the copy the caller already
  // holds — 183 445 times per build. Guarded on `</head>` preceding the
  // article (it always does: head before body) so the head marker lands on
  // the same occurrence `.replace('</head>', …)` would have picked.
  const headIdx = fullHtml.indexOf('</head>');
  if (headIdx < 0) {
    return fullHtml.slice(0, match.index) + thinArticle + fullHtml.slice(match.index + match[0].length);
  }
  if (headIdx >= match.index) {
    const withThinBody = fullHtml.slice(0, match.index) + thinArticle + fullHtml.slice(match.index + match[0].length);
    return withThinBody.replace('</head>', THIN_HEAD_MARKER);
  }
  return (
    fullHtml.slice(0, headIdx) +
    THIN_HEAD_MARKER +
    fullHtml.slice(headIdx + '</head>'.length, match.index) +
    thinArticle +
    fullHtml.slice(match.index + match[0].length)
  );
}

/**
 * Pre-optimisation implementation, kept executable as the DEFINITION of this
 * module's output: strip the whole document to find the `<h1>`, `JSON.parse`
 * every `<script>` body to find the JobPosting facts, then two whole-document
 * `.replace()` calls.
 *
 * Nothing in the build calls this — `tests/seo/soft-landing-thin-shell-equivalence.test.ts`
 * does, on every fixture and on 1 500 randomised structural mutations, and
 * requires byte equality with {@link buildSoftLandingThinHtml}. That test is
 * the only thing standing between a faster scan and 139 223 pages a build
 * shipping subtly different HTML, so the reference has to stay here rather
 * than be re-derived in the test where it could drift into agreeing with the
 * bug it is meant to catch.
 */
export function buildSoftLandingThinHtmlReference(fullHtml: string, locale: string): string {
  const thinArticle = buildThinArticle(
    extractH1Reference(fullHtml),
    extractJobPostingFactsReference(fullHtml).company,
    extractJobPostingFactsReference(fullHtml).location,
    canonicalPathFromUrl(extractCanonicalUrl(fullHtml)),
    locale,
  );
  const withThinBody = fullHtml.replace(
    /<article\s+class=["']?ft-static-article(?=[\s>"'])[^>]*>[\s\S]*?<\/article>/i,
    thinArticle,
  );
  if (withThinBody === fullHtml) return fullHtml;
  return withThinBody.replace(
    '</head>',
    ` <script>window.__THIN_SHELL__=1;</script>\n </head>`,
  );
}
