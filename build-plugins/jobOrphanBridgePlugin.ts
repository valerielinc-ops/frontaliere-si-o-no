/**
 * Job-orphan bridge plugin — emits 200 HTML pages for the 92 GSC
 * `Indicizzata Non trovata` job-detail URLs (Cohort 1).
 *
 * Why these URLs 404 today
 * ------------------------
 * The ingest script (`scripts/ingest-gsc-job-orphans.mjs`) classifies each
 * orphan URL from the GSC Coverage Drilldown CSV as one of:
 *
 *   - `matched`  → 21 URLs whose source job is still in `data/jobs.json`
 *                  but under a different slug. Three sub-causes:
 *                    a) 90-char truncation in `slugifyJobPart`
 *                       (services/relatedSearchClusters.ts:52). Old SPA
 *                       fallback emitted `<a href>` with slug cut at 90
 *                       chars; current code emits the full slug.
 *                    b) Translation drift (re-translated slug changed).
 *                    c) Tail-hash mutation (e.g. `-ncbhm0` → `-9yar0z`).
 *                  These never landed in `previousSlugs` because the
 *                  bridge pipeline doesn't capture translation/hash drift.
 *
 *   - `expired-tracked` / `expired` → 71 URLs whose source job has rotated
 *                  out of jobs.json and is not in expired-jobs.json either
 *                  (0/92 hits during ingest). These predate the expired-
 *                  job tracking infra OR weren't captured during rotation.
 *
 * Why not a 301
 * -------------
 * Same rationale as the calculator-legacy-alias plugin (PR #85): a 301
 * strips AdSense rendering. We need 200 pages that keep monetization,
 * carry a canonical signal so Google de-duplicates, and (for matched
 * cases) hand the user off to the live job page seamlessly.
 *
 * Output strategy
 * ---------------
 *   `matched` orphans:
 *     - canonical → current locale-canonical job URL
 *     - inline pre-hydration script `history.replaceState`s to the current
 *       URL (preserves query string + hash). SPA boots on the canonical
 *       and renders the full job detail.
 *     - body: forward-framed lede + "loading the latest version" prose.
 *
 *   `expired*` orphans:
 *     - canonical → section landing (`/cerca-lavoro-ticino/`, `/en/find-
 *       jobs-ticino/`, etc.). DO NOT canonical-redirect (no replaceState)
 *       — the orphan page must stay visible so the section search UX has
 *       the orphan as entry-point context.
 *     - body: "Annuncio scaduto" heading + extracted company hint (from
 *       slug trailing tokens) + a `<noscript>` fallback link to the
 *       section landing.
 *
 * Both kinds emit `robots: 'index,follow'` (per the
 * `never_noindex_without_approval` policy). Google de-duplicates via the
 * canonical signal; if a page genuinely should be dropped, Google decides.
 *
 * Plugin contract (CLAUDE.md non-negotiable #14)
 * ----------------------------------------------
 *   apply: 'build', enforce: 'post', emit in closeBundle.
 *   Uses `buildSeoPageHtml` so every emitted page gets the SPA shell
 *   (nav, footer, theme, AdSense markup, hashed entry JS/CSS).
 *   Pass `distDir` to every call.
 *
 * Sitemap policy
 * --------------
 * Orphan bridge pages are NOT added to any sitemap. The canonical URLs
 * already are; we don't want to advertise these as fresh crawl targets,
 * just to repair the existing 404 cohort.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { resolveCantonSection, isCompanyHubNamespaceSlug, type CantonLocale } from './shared/cantonSection';
import { getCantonForSlug } from './shared/slugCantonIndex';
import { buildBridgeBreadcrumbLd, JOBS_SECTION_LABEL } from './shared/bridgeBreadcrumb';
import { renderBridgePageProse } from './shared/bridgePageProse';
import type { Locale } from '../services/i18n';

const BASE_URL = 'https://frontaliereticino.ch';

// Legacy TI section table — used only as a fallback for section-canonical paths
// when no slug context is available. Per-slug paths use `sectionForSlug()` below
// so non-TI jobs land on their canton URL.
const SECTION_SLUG: Record<Locale, string> = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
  en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
  de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
  fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
};

/**
 * Resolve the job-board section for (locale, slug) using the slug→canton
 * reverse index. Falls back to TI legacy section when slug is unknown.
 */
function sectionForSlug(locale: Locale, slug: string): string {
  const canton = getCantonForSlug(slug);
  return resolveCantonSection(locale as CantonLocale, canton);
}

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

interface OrphanEntry {
  readonly locale: Locale;
  readonly slug: string;
  readonly url: string;
  readonly kind: 'matched' | 'expired-tracked' | 'expired';
  readonly jobId?: string;
  readonly currentSlug?: string;
  readonly matchType?: string;
  readonly expiredJobId?: string;
  readonly company?: string | null;
  readonly csvOrigin?: string;
}

interface OrphansFile {
  readonly generatedAt: string;
  readonly sources: string[];
  readonly counts: Record<string, number>;
  readonly orphans: OrphanEntry[];
}

/** Locale copy bundles for the static body. */
interface BridgeCopy {
  readonly matchedTitle: string;
  readonly matchedDescription: string;
  readonly matchedH1: string;
  readonly matchedLede: string;
  readonly expiredTitle: string;
  readonly expiredDescription: string;
  readonly expiredH1: (companyHint: string | null) => string;
  readonly expiredLede: string;
  readonly browseAllLabel: string;
}

const COPY: Record<Locale, BridgeCopy> = {
  it: {
    matchedTitle: 'Annuncio aggiornato — apertura in corso',
    matchedDescription: 'L\'annuncio che cerchi è stato aggiornato. Apri la versione corrente per leggere mansioni, requisiti, sede e candidarti direttamente.',
    matchedH1: 'Annuncio aggiornato',
    matchedLede: 'Questo annuncio è ancora aperto, ma il suo indirizzo è cambiato. Ti stiamo portando alla versione corrente — sede, requisiti e modulo di candidatura sono già pronti. Se la pagina non si apre, usa il link in fondo per tornare al job board e ritrovare l\'annuncio.',
    expiredTitle: 'Annuncio non più disponibile — alternative aggiornate ogni giorno',
    expiredDescription: 'Questa offerta di lavoro non è più online. Trova alternative simili nel Ticino con il nostro job board aggiornato ogni giorno: oltre 2000 annunci frontalieri attivi.',
    expiredH1: (hint) => hint ? `Annuncio scaduto — vedi le offerte recenti di ${hint}` : 'Annuncio scaduto — vedi le offerte recenti',
    expiredLede: 'L\'annuncio che cercavi è stato rimosso dall\'azienda inserzionista. Sul job board frontaliere trovi ogni giorno offerte simili filtrabili per ruolo, città, tipologia di contratto e azienda. Per chi vive in Italia e lavora in Svizzera, ogni risultato riporta il calcolo automatico dello stipendio netto Permit G vs Permit B, le tabelle di pendolarismo e le agevolazioni fiscali del Nuovo Accordo bilaterale 2026.',
    browseAllLabel: 'Sfoglia tutti gli annunci attivi',
  },
  en: {
    matchedTitle: 'Listing updated — opening the latest version',
    matchedDescription: 'The listing you were looking for has been updated. We are taking you to the current version with the latest role description, location and application form.',
    matchedH1: 'Listing updated',
    matchedLede: 'This listing is still live but its URL has changed. We are taking you to the current version — role description, requirements, location and apply button are all there. If the page does not open, use the link below to browse the latest cross-border openings.',
    expiredTitle: 'Listing no longer available — similar openings updated daily',
    expiredDescription: 'This job posting is no longer online. Find similar Ticino-based openings on our cross-border job board, updated daily — over 2000 active listings.',
    expiredH1: (hint) => hint ? `Listing closed — see recent openings from ${hint}` : 'Listing closed — see recent openings',
    expiredLede: 'The listing you were looking for has been removed by the employer. Our cross-border job board refreshes daily with new openings filtered by role, city, contract type and employer. Each result includes the automatic net-salary calculation under Permit G vs Permit B, commute timetables and the 2026 New Bilateral Agreement tax adjustments for Italian-Swiss frontalieri.',
    browseAllLabel: 'Browse all active listings',
  },
  de: {
    matchedTitle: 'Anzeige aktualisiert — Sie werden weitergeleitet',
    matchedDescription: 'Die gesuchte Stellenanzeige wurde aktualisiert. Wir leiten Sie zur aktuellen Version mit Tätigkeitsbeschreibung, Anforderungen und Bewerbungsformular weiter.',
    matchedH1: 'Anzeige aktualisiert',
    matchedLede: 'Diese Stelle ist weiterhin offen, ihre URL hat sich aber geändert. Wir leiten Sie zur aktuellen Version weiter — Tätigkeit, Anforderungen, Standort und Bewerbungsformular finden Sie dort. Falls die Seite nicht öffnet, nutzen Sie den Link unten, um zum Job-Board zurückzukehren.',
    expiredTitle: 'Anzeige nicht mehr verfügbar — täglich aktualisierte Alternativen',
    expiredDescription: 'Diese Stellenanzeige ist nicht mehr online. Finden Sie ähnliche Stellen im Tessin auf unserem Grenzgänger-Job-Board — täglich aktualisiert, über 2000 offene Stellen.',
    expiredH1: (hint) => hint ? `Anzeige geschlossen — aktuelle Stellen von ${hint}` : 'Anzeige geschlossen — aktuelle Stellen',
    expiredLede: 'Die gesuchte Stellenanzeige wurde vom Arbeitgeber entfernt. Unser Grenzgänger-Job-Board wird täglich aktualisiert und lässt sich nach Rolle, Stadt, Vertragsart und Unternehmen filtern. Jedes Ergebnis enthält die automatische Nettolohn-Berechnung unter Permit G vs Permit B, Pendlerfahrpläne und die steuerlichen Anpassungen des neuen bilateralen Abkommens 2026 für italienisch-schweizerische Grenzgänger.',
    browseAllLabel: 'Alle aktiven Stellen ansehen',
  },
  fr: {
    matchedTitle: 'Annonce mise à jour — ouverture en cours',
    matchedDescription: 'L\'annonce que vous cherchiez a été mise à jour. Nous vous dirigeons vers la version actuelle avec la description du poste, le lieu et le formulaire de candidature.',
    matchedH1: 'Annonce mise à jour',
    matchedLede: 'Cette annonce est toujours active, mais son adresse a changé. Nous vous dirigeons vers la version actuelle — description, exigences, lieu et formulaire de candidature y sont. Si la page ne s\'ouvre pas, utilisez le lien ci-dessous pour parcourir les annonces frontalières les plus récentes.',
    expiredTitle: 'Annonce non disponible — alternatives mises à jour quotidiennement',
    expiredDescription: 'Cette offre d\'emploi n\'est plus en ligne. Trouvez des alternatives similaires au Tessin sur notre job board frontalier — mis à jour quotidiennement, plus de 2000 annonces actives.',
    expiredH1: (hint) => hint ? `Annonce fermée — offres récentes de ${hint}` : 'Annonce fermée — offres récentes',
    expiredLede: 'L\'annonce que vous recherchiez a été retirée par l\'employeur. Notre job board frontalier s\'actualise quotidiennement avec de nouvelles offres filtrables par rôle, ville, type de contrat et entreprise. Chaque résultat inclut le calcul automatique du salaire net Permit G vs Permit B, les horaires de transport frontalier et les ajustements fiscaux du Nouvel Accord bilatéral 2026 pour les frontaliers italo-suisses.',
    browseAllLabel: 'Parcourir toutes les annonces actives',
  },
};

function esc(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a slug fragment like "lonza-visp" or "guess-europe-sagl-bioggio"
 *  back to a human label like "Lonza Visp" / "Guess Europe Sagl Bioggio". */
function humanizeCompanyHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  return hint
    .split('-')
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(' ')
    .trim() || null;
}

function withLeadingTrailingSlash(pathname: string): string {
  const clean = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}/`;
  return clean.replace(/\/+/g, '/');
}

function pathFromOrphanUrl(entry: OrphanEntry): string | null {
  try {
    const pathname = new URL(entry.url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    let cursor = 0;
    const expectedLocalePrefix = LOCALE_PREFIX[entry.locale].replace(/^\//, '');
    if (entry.locale !== 'it') {
      if (segments[0] !== expectedLocalePrefix) return null;
      cursor = 1;
    }
    if (segments[cursor + 1] !== entry.slug || segments.length !== cursor + 2) return null;
    return withLeadingTrailingSlash(pathname);
  } catch {
    return null;
  }
}

function buildOrphanPath(entry: OrphanEntry): string {
  // Emit at the URL Google actually reported. Older cohorts only used the
  // legacy Ticino section; newer GSC exports include canton-aware sections
  // such as /cerca-lavoro-zurigo/<slug>/ and /de/jobs-in-bern/<slug>/.
  return pathFromOrphanUrl(entry)
    ?? `${LOCALE_PREFIX[entry.locale]}/${SECTION_SLUG[entry.locale]}/${entry.slug}/`.replace(/\/+/g, '/');
}

function buildCurrentPathForMatched(locale: Locale, currentSlug: string): string {
  const section = sectionForSlug(locale, currentSlug);
  return `${LOCALE_PREFIX[locale]}/${section}/${currentSlug}/`.replace(/\/+/g, '/');
}

function buildCanonicalForMatched(locale: Locale, currentSlug: string): string {
  return `${BASE_URL}${buildCurrentPathForMatched(locale, currentSlug)}`.replace(/(?<!:)\/+/g, '/');
}

/**
 * Section landing canonical. `slugHint` (when present) lets us pick the
 * canton-aware section for the orphan's known job. When absent, fall back
 * to TI legacy (byte-identical pre-cathedral behavior).
 */
function buildSectionCanonical(locale: Locale, slugHint?: string): string {
  const section = slugHint ? sectionForSlug(locale, slugHint) : SECTION_SLUG[locale];
  return `${BASE_URL}${LOCALE_PREFIX[locale]}/${section}/`.replace(/(?<!:)\/+/g, '/');
}

function sectionPathFromOrphan(entry: OrphanEntry): string {
  const orphanPath = buildOrphanPath(entry);
  const parts = orphanPath.split('/').filter(Boolean);
  const sectionParts = entry.locale === 'it' ? parts.slice(0, 1) : parts.slice(0, 2);
  if (sectionParts.length > 0) return withLeadingTrailingSlash(sectionParts.join('/'));
  return `${LOCALE_PREFIX[entry.locale]}/${SECTION_SLUG[entry.locale]}/`.replace(/\/+/g, '/');
}

// `matched` orphans emit at the exact URL Google reported 404 for (`orphanPath`,
// e.g. legacy /cerca-lavoro-ticino/<oldSlug>/) but canonicalize to the job's
// CURRENT section (`buildCanonicalForMatched` → the live canton-aware URL).
// When the reported oldSlug happens to start with the reserved company-hub
// prefix (e.g. an old job titled "Azienda di consulenza…") that combination
// writes a page into the `/cerca-lavoro-ticino/azienda-*` namespace whose
// canonical points at a DIFFERENT, non-TI canton — the exact invariant
// tests/seo/cathedral-sector-hubs.test.ts guards against (issue #2976). This
// plugin is a 5th call site for that same class of bug, alongside the 4 in
// jobsSeoPagesPlugin.ts (isCompanyHubNamespaceSlug) — sibling-pattern fix,
// same PR. Skip emission for these rather than serve a self-contradicting
// company-hub-namespace page; the URL falls back to the normal 404/tombstone.
function orphanNamespaceCollides(entry: OrphanEntry): boolean {
  if (entry.kind !== 'matched' || !entry.currentSlug) return false;
  if (!isCompanyHubNamespaceSlug(entry.slug, entry.locale)) return false;
  const orphanSection = sectionPathFromOrphan(entry);
  const currentSection = withLeadingTrailingSlash(
    `${LOCALE_PREFIX[entry.locale]}/${sectionForSlug(entry.locale, entry.currentSlug)}`,
  );
  return currentSection !== orphanSection;
}

/** Inline pre-hydration rewrite for matched orphans. */
function buildMatchedRewriteScript(orphanPath: string, currentPath: string): string {
  const safeOrphan = JSON.stringify(orphanPath);
  const safeCurrent = JSON.stringify(currentPath);
  return `<script>(function(){try{if(location.pathname===${safeOrphan}){history.replaceState(null,'',${safeCurrent}+location.search+location.hash);}}catch(e){}})();</script>`;
}

function renderMatchedPage(entry: OrphanEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const orphanPath = buildOrphanPath(entry);
  const currentPath = buildCurrentPathForMatched(locale, entry.currentSlug!);
  const canonicalUrl = buildCanonicalForMatched(locale, entry.currentSlug!);
  const orphanAbsoluteUrl = `${BASE_URL}${orphanPath}`;

  // Shared bridge-page prose appended BELOW the CTA so the link stays
  // first interactive on mobile (CLAUDE.md non-negotiables #15-17).
  // Closes the `audit:text-html-ratio` Semrush gate (~5 % → ~13 %) for
  // the 60+ active-job orphan URLs in this cohort. Parametric + memoized.
  const bridgeProse = renderBridgePageProse({ locale, bridgeKind: 'job-matched' });

  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg">
      <h1 class="s-hiC5FI">${esc(copy.matchedH1)}</h1>
    </header>
    <p class="s-cbFAda">${esc(copy.matchedLede)}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(buildSectionCanonical(locale, entry.currentSlug || entry.slug))}">${esc(copy.browseAllLabel)} →</a></p>
    ${bridgeProse}
  </main>`;

  // Breadcrumb describes the orphan URL the visitor actually landed on
  // (canonical points to the live job, but the bridge is what's served).
  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: sectionPathFromOrphan(entry),
    pageLabel: copy.matchedH1,
    canonicalUrl: orphanAbsoluteUrl,
  });

  return buildSeoPageHtml({
    locale,
    title: copy.matchedTitle,
    description: copy.matchedDescription,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd],
    extraHeadHtml: buildMatchedRewriteScript(orphanPath, currentPath),
    bodyHtml,
    distDir,
    seoMainClass: 'cluster-seo-prose',
  });
}

function renderExpiredPage(entry: OrphanEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const companyHint = humanizeCompanyHint(entry.company);
  // Canonical points to the section landing that actually contained the
  // orphan URL. Slug→canton inference is unreliable for expired unknowns,
  // while the GSC URL already carries the user's section context.
  const sectionPath = sectionPathFromOrphan(entry);
  const canonicalUrl = `${BASE_URL}${sectionPath}`.replace(/(?<!:)\/+/g, '/');
  const orphanAbsoluteUrl = `${BASE_URL}${buildOrphanPath(entry)}`;

  // Same shared bridge-page prose appended after the CTA. The
  // bridgeKind 'job-expired' wording differs from 'job-matched' so
  // active vs closed listings never share the same opener (which would
  // raise a duplicate-content flag at scale).
  const bridgeProse = renderBridgePageProse({ locale, bridgeKind: 'job-expired' });

  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg">
      <h1 class="s-hiC5FI">${esc(copy.expiredH1(companyHint))}</h1>
    </header>
    <p class="s-cbFAda">${esc(copy.expiredLede)}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(canonicalUrl)}">${esc(copy.browseAllLabel)} →</a></p>
    ${bridgeProse}
  </main>`;

  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath,
    pageLabel: copy.expiredH1(companyHint),
    canonicalUrl: orphanAbsoluteUrl,
  });

  return buildSeoPageHtml({
    locale,
    title: copy.expiredTitle,
    description: copy.expiredDescription,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd],
    bodyHtml,
    distDir,
    seoMainClass: 'cluster-seo-prose',
  });
}

export function jobOrphanBridgePlugin(rootDir: string): Plugin {
  return {
    name: 'job-orphan-bridge',
    apply: 'build',
    enforce: 'post',
    // Issue #4263 item 4 (sibling of the eventsSeoPagesPlugin/legacyRedirectsPlugin/
    // cfHot404BridgePlugin race): the idempotency guard below (`fs.existsSync(indexTarget)`
    // — "skip if another plugin already wrote real content here") only holds if the
    // canonical page producer has actually finished writing by the time this runs,
    // which registration order alone does not guarantee under Rollup's default
    // async-parallel closeBundle. `order:'post'` + `sequential:true` makes Rollup
    // await every earlier-queued closeBundle promise first. Verified against the
    // installed rollup package; mirrors hreflangPostprocessPlugin.ts.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
      const dataPath = path.join(rootDir, 'data', 'gsc-job-orphans.json');
      if (!fs.existsSync(dataPath)) {
        console.warn('\x1b[33m[job-orphan-bridge]\x1b[0m data/gsc-job-orphans.json missing — skipping');
        return;
      }
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        console.warn('\x1b[33m[job-orphan-bridge]\x1b[0m dist/ missing — skipping');
        return;
      }

      let file: OrphansFile;
      try {
        file = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      } catch (err) {
        console.warn('\x1b[33m[job-orphan-bridge]\x1b[0m failed to parse data file:', err);
        return;
      }
      if (!Array.isArray(file.orphans) || file.orphans.length === 0) {
        console.warn('\x1b[33m[job-orphan-bridge]\x1b[0m no orphan entries — skipping');
        return;
      }

      let emitted = 0;
      let skippedCollision = 0;
      let skippedNamespaceGuard = 0;
      const start = Date.now();

      for (const entry of file.orphans) {
        // Reserved company-hub namespace guard (issue #2976, 5th call site) —
        // must run before path/collision checks: it depends on entry.slug /
        // entry.kind, not on dist/ state.
        if (orphanNamespaceCollides(entry)) {
          skippedNamespaceGuard++;
          continue;
        }

        const orphanPath = buildOrphanPath(entry);
        const indexTarget = path.join(distDir, orphanPath, 'index.html');
        const flatTarget = path.join(distDir, orphanPath.replace(/\/+$/, '') + '.html');

        // Skip if another plugin already wrote real content here (e.g. a
        // re-activated job that re-uses the same slug). Idempotency guard.
        if (fs.existsSync(indexTarget)) {
          skippedCollision++;
          continue;
        }

        const html = entry.kind === 'matched'
          ? renderMatchedPage(entry, distDir)
          : renderExpiredPage(entry, distDir);

        try {
          fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
          fs.writeFileSync(indexTarget, html, 'utf-8');
          fs.writeFileSync(flatTarget, html, 'utf-8');
          emitted += 2;
        } catch (err) {
          console.warn(`\x1b[33m[job-orphan-bridge]\x1b[0m failed to write ${indexTarget}:`, err);
        }
      }

      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `\x1b[36m[job-orphan-bridge]\x1b[0m emitted ${emitted} bridge files (${file.orphans.length - skippedCollision - skippedNamespaceGuard} pages, ${skippedCollision} skipped due to live-page collision, ${skippedNamespaceGuard} skipped due to reserved company-hub namespace) in ${dur}s`,
      );
      },
    },
  };
}
