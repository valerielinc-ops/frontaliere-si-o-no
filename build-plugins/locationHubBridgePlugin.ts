/**
 * Location-hub bridge plugin — emits 200 HTML pages for the 60 GSC
 * `Indicizzata Non trovata` URLs of the form
 * `/{locale}/{section}/(localita|location|standort|localite)-{city}/`
 * (Cohort 2).
 *
 * Why these 404 today
 * -------------------
 * JobBoard.tsx renders `<a href>` to location-filtered URLs from the
 * job-detail "gate" (JobBoard.tsx:5881 → `buildLocationSearchSlug`).
 * Google crawls these links and expects pages — but until today no
 * build plugin emitted static HTML for the `localita-*` namespace.
 * The SPA's `parseLocationSlugFilter` (JobBoard.tsx:2250) handles the
 * filter on hydration, but a cold visit to the URL hits GH Pages' 404
 * before any JS runs → indexed as "Indicizzata Non trovata".
 *
 * Approach (200, no 301)
 * ----------------------
 * One static page per orphan via `buildSeoPageHtml` (rule 14 compliant).
 * The SPA hydrates `#root` with its JobBoard component, sees the
 * `localita-{city}` slug in the URL, applies the location filter, and
 * renders the city's job listings. AdSense fires natively.
 *
 *   `matched`   (38 URLs, city present in jobs.json):
 *     - canonical → self (the page is a legitimate city-filter view)
 *     - body: H1 "Offerte di lavoro a {City}" + job count + lede
 *     - SPA renders the filtered listings post-hydration
 *
 *   `unmatched` (22 URLs, no active job for that city — bogus or expired):
 *     - canonical → section landing (`/cerca-lavoro-ticino/` etc.)
 *       so Google de-duplicates these into the section
 *     - body: "Località non disponibile" + browse-all CTA
 *
 * Both kinds: `robots: 'index,follow'` (never-noindex policy).
 *
 * Sitemap policy: bridge pages NOT added to any sitemap. The
 * cityJobsHubPlugin owns the canonical city hubs (Lugano/Mendrisio/
 * Bellinzona/Locarno/Chiasso). The `localita-{city}` pattern is a
 * secondary filter URL we only emit to repair the 404 cohort.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildBridgeBreadcrumbLd, JOBS_SECTION_LABEL } from './shared/bridgeBreadcrumb';
import { renderCantonSeoProse, buildCantonSeoProseFaqItems, type CantonSeoLocale } from './shared/cantonSeoProse';
import type { Locale } from '../services/i18n';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { composePlaceTitle } from './shared/titleSuffix';

const BASE_URL = 'https://frontaliereticino.ch';

const SECTION_SLUG: Record<Locale, string> = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
  en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
  de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
  fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
};

const LOC_PREFIX: Record<Locale, string> = {
  it: 'localita',
  en: 'location',
  de: 'standort',
  fr: 'localite',
};
const LOCATION_SEGMENT_PREFIXES = new Set(['localita', 'location', 'standort', 'ort', 'stadt', 'localite', 'ville', 'lieu']);

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

interface HubEntry {
  readonly locale: Locale;
  readonly citySlug: string;
  readonly url: string;
  readonly kind: 'matched' | 'unmatched';
  readonly displayName: string;
  readonly jobCount: number;
}

interface HubsFile {
  readonly generatedAt: string;
  readonly sources: string[];
  readonly counts: Record<string, number>;
  readonly hubs: HubEntry[];
}

interface BridgeCopy {
  readonly matchedTitle: (city: string, count: number) => string;
  readonly matchedDescription: (city: string, count: number) => string;
  readonly matchedH1: (city: string, count: number) => string;
  readonly matchedLede: (city: string, count: number) => string;
  readonly unmatchedTitle: string;
  readonly unmatchedDescription: string;
  readonly unmatchedH1: (city: string) => string;
  readonly unmatchedLede: string;
  readonly browseAllLabel: string;
}

const COPY: Record<Locale, BridgeCopy> = {
  it: {
    matchedTitle: (c, n) => composePlaceTitle([
      `Offerte di lavoro a ${c} — ${n} annunci aggiornati`,
      `Offerte di lavoro a ${c} — ${n} annunci`,
      `Offerte di lavoro a ${c}`,
    ], undefined, (s) => esc(s).length),
    matchedDescription: (c, n) => `${n} offerte di lavoro a ${c} per frontalieri italo-svizzeri, aggiornate ogni giorno. Stipendio netto Permit G/B, fiscalità Accordo bilaterale 2026, mappa pendolarismo TILO.`,
    matchedH1: (c, n) => `${n} annunci a ${c}`,
    matchedLede: (c, n) => `Trovi ${n} annunci di lavoro a ${c} aggiornati ogni giorno. Ogni offerta riporta il calcolo automatico dello stipendio netto Permit G (vivere in Italia) vs Permit B (vivere in Svizzera), le tempistiche di pendolarismo verso il confine ticinese e le agevolazioni fiscali introdotte dal Nuovo Accordo bilaterale italo-svizzero del 2026. Filtra per ruolo, contratto o azienda per restringere la ricerca.`,
    unmatchedTitle: 'Località non più disponibile — alternative aggiornate ogni giorno',
    unmatchedDescription: 'Nessuna offerta attiva per questa località. Esplora oltre 2000 annunci frontalieri su tutto il Ticino con filtri per ruolo, città, contratto e azienda.',
    unmatchedH1: (c) => `Località ${c} — nessun annuncio attivo`,
    unmatchedLede: 'In questo momento non ci sono annunci attivi per la località cercata. Sul job board frontaliere trovi ogni giorno offerte aggiornate in tutto il Ticino, filtrabili per ruolo, città, tipo di contratto e azienda. Iscriviti per ricevere notifiche quando arrivano nuovi annunci compatibili.',
    browseAllLabel: 'Sfoglia tutti gli annunci attivi',
  },
  en: {
    matchedTitle: (c, n) => composePlaceTitle([
      `Jobs in ${c} — ${n} cross-border openings`,
      `Jobs in ${c} — ${n} openings`,
      `Jobs in ${c}`,
    ], undefined, (s) => esc(s).length),
    matchedDescription: (c, n) => `${n} job openings in ${c} for Italian-Swiss cross-border workers. Net salary under Permit G/B, 2026 bilateral agreement tax adjustments, TILO commute map.`,
    matchedH1: (c, n) => `${n} jobs in ${c}`,
    matchedLede: (c, n) => `Find ${n} job openings in ${c}, updated daily. Each listing carries the automatic net-salary calculation under Permit G (commuting from Italy) vs Permit B (Swiss residency), commute timetables to the Ticino border and the tax adjustments introduced by the 2026 Italy-Switzerland bilateral agreement. Filter by role, contract type or employer to narrow your search.`,
    unmatchedTitle: 'Location no longer available — alternatives updated daily',
    unmatchedDescription: 'No active openings for this location. Browse 2000+ cross-border job listings across Ticino filtered by role, city, contract type and employer.',
    unmatchedH1: (c) => `${c} — no active listings`,
    unmatchedLede: 'There are no active listings for the location you searched. Our cross-border job board refreshes daily with new openings across all of Ticino, filtered by role, city, contract type and employer. Subscribe for notifications when matching openings are posted.',
    browseAllLabel: 'Browse all active listings',
  },
  de: {
    matchedTitle: (c, n) => composePlaceTitle([
      `Stellen in ${c} — ${n} aktuelle Inserate`,
      `Stellen in ${c} — ${n} Inserate`,
      `Stellen in ${c}`,
    ], undefined, (s) => esc(s).length),
    matchedDescription: (c, n) => `${n} Stellen in ${c} für italienisch-schweizerische Grenzgänger. Nettolohn Permit G/B, Steuer-Anpassungen Abkommen 2026, TILO-Pendelfahrpläne.`,
    matchedH1: (c, n) => `${n} Stellen in ${c}`,
    matchedLede: (c, n) => `Finden Sie ${n} aktuelle Stellen in ${c}, täglich aktualisiert. Jedes Inserat enthält die automatische Nettolohn-Berechnung unter Permit G (Pendeln aus Italien) vs Permit B (Wohnsitz Schweiz), Pendlerfahrpläne zur Tessiner Grenze und die steuerlichen Anpassungen des neuen italienisch-schweizerischen Abkommens 2026. Filtern Sie nach Rolle, Vertragsart oder Arbeitgeber.`,
    unmatchedTitle: 'Standort nicht mehr verfügbar — täglich aktualisierte Alternativen',
    unmatchedDescription: 'Keine offenen Stellen für diesen Standort. Über 2000 Grenzgänger-Inserate im Tessin, filterbar nach Rolle, Stadt, Vertragsart und Arbeitgeber.',
    unmatchedH1: (c) => `${c} — keine aktiven Inserate`,
    unmatchedLede: 'Es gibt derzeit keine aktiven Inserate für den gesuchten Standort. Unser Grenzgänger-Job-Board wird täglich mit neuen Stellen im gesamten Tessin aktualisiert, filterbar nach Rolle, Stadt, Vertragsart und Arbeitgeber. Abonnieren Sie Benachrichtigungen für passende neue Inserate.',
    browseAllLabel: 'Alle aktiven Stellen ansehen',
  },
  fr: {
    matchedTitle: (c, n) => composePlaceTitle([
      `Emplois à ${c} — ${n} offres frontalières`,
      `Emplois à ${c} — ${n} offres`,
      `Emplois à ${c}`,
    ], undefined, (s) => esc(s).length),
    matchedDescription: (c, n) => `${n} offres d'emploi à ${c} pour les frontaliers italo-suisses. Salaire net Permit G/B, ajustements fiscaux Accord 2026, horaires TILO.`,
    matchedH1: (c, n) => `${n} emplois à ${c}`,
    matchedLede: (c, n) => `Trouvez ${n} offres d'emploi à ${c}, mises à jour quotidiennement. Chaque annonce inclut le calcul automatique du salaire net sous Permit G (frontalier depuis l'Italie) vs Permit B (résidence suisse), les horaires de transport vers la frontière tessinoise et les ajustements fiscaux du nouvel Accord bilatéral italo-suisse 2026. Filtrez par rôle, type de contrat ou employeur.`,
    unmatchedTitle: 'Lieu non disponible — alternatives mises à jour quotidiennement',
    unmatchedDescription: 'Aucune offre active pour ce lieu. Parcourez plus de 2000 annonces frontalières au Tessin, filtrables par rôle, ville, type de contrat et entreprise.',
    unmatchedH1: (c) => `${c} — aucune offre active`,
    unmatchedLede: 'Il n\'y a actuellement aucune offre active pour le lieu recherché. Notre job board frontalier s\'actualise quotidiennement avec de nouvelles offres dans tout le Tessin, filtrables par rôle, ville, type de contrat et employeur. Abonnez-vous pour recevoir des notifications.',
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

function buildHubPath(locale: Locale, citySlug: string): string {
  return `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/${LOC_PREFIX[locale]}-${citySlug}/`.replace(/\/+/g, '/');
}

function withLeadingTrailingSlash(pathname: string): string {
  const clean = `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}/`;
  return clean.replace(/\/+/g, '/');
}

function pathFromHubUrl(entry: HubEntry): string | null {
  try {
    const pathname = new URL(entry.url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    let cursor = 0;
    const expectedLocalePrefix = LOCALE_PREFIX[entry.locale].replace(/^\//, '');
    if (entry.locale !== 'it') {
      if (segments[0] !== expectedLocalePrefix) return null;
      cursor = 1;
    }
    if (segments.length !== cursor + 2) return null;
    const citySegment = segments[cursor + 1];
    const dashIdx = citySegment.indexOf('-');
    if (dashIdx <= 0) return null;
    const prefix = citySegment.slice(0, dashIdx);
    const slug = citySegment.slice(dashIdx + 1);
    if (!LOCATION_SEGMENT_PREFIXES.has(prefix) || slug !== entry.citySlug) return null;
    return withLeadingTrailingSlash(pathname);
  } catch {
    return null;
  }
}

function buildEntryHubPath(entry: HubEntry): string {
  return pathFromHubUrl(entry) ?? buildHubPath(entry.locale, entry.citySlug);
}

function sectionPathFromEntry(entry: HubEntry): string {
  const hubPath = buildEntryHubPath(entry);
  const parts = hubPath.split('/').filter(Boolean);
  const sectionParts = entry.locale === 'it' ? parts.slice(0, 1) : parts.slice(0, 2);
  if (sectionParts.length > 0) return withLeadingTrailingSlash(sectionParts.join('/'));
  return `${LOCALE_PREFIX[entry.locale]}/${SECTION_SLUG[entry.locale]}/`.replace(/\/+/g, '/');
}

function renderMatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const hubPath = buildEntryHubPath(entry);
  const canonicalUrl = `${BASE_URL}${hubPath}`;
  const sectionPath = sectionPathFromEntry(entry);
  const city = entry.displayName;
  const n = entry.jobCount;

  // ── audit:text-html-ratio gate ────────────────────────────────────
  // Bridge pages were ~6.5 KB HTML with ~400 bytes text (~6 %). Append
  // canton-aware prose helper for city-landing slot. Located BELOW the
  // header per CLAUDE.md mobile-first rules.
  const proseOpts = {
    locale: locale as CantonSeoLocale,
    cantonDisplay: locale === 'it' ? 'Ticino' : locale === 'en' ? 'Ticino' : locale === 'de' ? 'Tessin' : 'Tessin',
    slot: 'city-landing' as const,
    entityName: city,
    countHint: n,
    ctaHref: `${BASE_URL}${sectionPath}`.replace(/(?<!:)\/+/g, '/'),
    ctaLabel: copy.browseAllLabel,
  };
  const proseHtml = renderCantonSeoProse(proseOpts);
  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg">
      <h1 class="s-hiC5FI">${esc(copy.matchedH1(city, n))}</h1>
    </header>
    <p class="s-cbFAda">${esc(copy.matchedLede(city, n))}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(`${BASE_URL}${sectionPath}`.replace(/(?<!:)\/+/g, '/'))}">${esc(copy.browseAllLabel)} →</a></p>
    ${proseHtml}
  </main>`;

  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath,
    pageLabel: city,
    canonicalUrl,
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: buildCantonSeoProseFaqItems(proseOpts),
  });

  return buildSeoPageHtml({
    locale,
    title: copy.matchedTitle(city, n),
    description: copy.matchedDescription(city, n),
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd, faqLd],
    bodyHtml,
    distDir,
    seoMainClass: 'cluster-seo-prose',
  });
}

function renderUnmatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  // Canonical points to the section landing for unmatched entries
  // (they consolidate into the section), but the BreadcrumbList still
  // describes the bridge URL the visitor actually landed on.
  const sectionPathOnly = sectionPathFromEntry(entry);
  const canonicalUrl = `${BASE_URL}${sectionPathOnly}`.replace(/(?<!:)\/+/g, '/');
  const sectionPath = canonicalUrl;
  const city = entry.displayName;
  const hubPath = buildEntryHubPath(entry);
  const hubAbsoluteUrl = `${BASE_URL}${hubPath}`;

  // ── audit:text-html-ratio gate ────────────────────────────────────
  // Unmatched location-bridge was even thinner. Same prose helper but
  // with no countHint and a soft CTA back to the section listing.
  const proseOpts = {
    locale: locale as CantonSeoLocale,
    cantonDisplay: locale === 'it' ? 'Ticino' : locale === 'en' ? 'Ticino' : locale === 'de' ? 'Tessin' : 'Tessin',
    slot: 'city-landing' as const,
    entityName: city,
    countHint: null,
    ctaHref: sectionPath,
    ctaLabel: copy.browseAllLabel,
  };
  const proseHtml = renderCantonSeoProse(proseOpts);
  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg">
      <h1 class="s-hiC5FI">${esc(copy.unmatchedH1(city))}</h1>
    </header>
    <p class="s-cbFAda">${esc(copy.unmatchedLede)}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(sectionPath)}">${esc(copy.browseAllLabel)} →</a></p>
    ${proseHtml}
  </main>`;

  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: sectionPathOnly,
    pageLabel: city,
    canonicalUrl: hubAbsoluteUrl,
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: buildCantonSeoProseFaqItems(proseOpts),
  });

  return buildSeoPageHtml({
    locale,
    title: copy.unmatchedTitle,
    description: copy.unmatchedDescription,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd, faqLd],
    bodyHtml,
    distDir,
    seoMainClass: 'cluster-seo-prose',
  });
}

export function locationHubBridgePlugin(rootDir: string): Plugin {
  return {
    name: 'location-hub-bridge',
    apply: 'build',
    enforce: 'post',
    // Issue #4263 item 4 (sibling of the eventsSeoPagesPlugin/legacyRedirectsPlugin/
    // cfHot404BridgePlugin race): the collision guard below (`fs.existsSync(indexTarget)`)
    // only holds if the canonical page producer has actually finished writing by the
    // time this runs, which registration order alone does not guarantee under
    // Rollup's default async-parallel closeBundle. `order:'post'` + `sequential:true`
    // makes Rollup await every earlier-queued closeBundle promise first. Verified
    // against the installed rollup package; mirrors hreflangPostprocessPlugin.ts.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
      const dataPath = path.join(rootDir, 'data', 'gsc-location-hubs.json');
      if (!fs.existsSync(dataPath)) {
        console.warn('\x1b[33m[location-hub-bridge]\x1b[0m data/gsc-location-hubs.json missing — skipping');
        return;
      }
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        console.warn('\x1b[33m[location-hub-bridge]\x1b[0m dist/ missing — skipping');
        return;
      }

      let file: HubsFile;
      try {
        file = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      } catch (err) {
        console.warn('\x1b[33m[location-hub-bridge]\x1b[0m failed to parse data file:', err);
        return;
      }
      if (!Array.isArray(file.hubs) || file.hubs.length === 0) return;

      let emitted = 0;
      let skipped = 0;
      const start = Date.now();

      for (const entry of file.hubs) {
        const hubPath = buildEntryHubPath(entry);
        const indexTarget = path.join(distDir, hubPath, 'index.html');
        const flatTarget = path.join(distDir, hubPath.replace(/\/+$/, '') + '.html');

        if (fs.existsSync(indexTarget)) { skipped++; continue; }

        const html = entry.kind === 'matched'
          ? renderMatchedPage(entry, distDir)
          : renderUnmatchedPage(entry, distDir);

        try {
          fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
          fs.writeFileSync(indexTarget, html, 'utf-8');
          fs.writeFileSync(flatTarget, html, 'utf-8');
          emitted += 2;
        } catch (err) {
          console.warn(`\x1b[33m[location-hub-bridge]\x1b[0m failed to write ${indexTarget}:`, err);
        }
      }

      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `\x1b[36m[location-hub-bridge]\x1b[0m emitted ${emitted} bridge files (${file.hubs.length - skipped} pages, ${skipped} skipped due to collision) in ${dur}s`,
      );
      },
    },
  };
}
