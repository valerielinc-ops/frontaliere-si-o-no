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
import type { Locale } from '../services/i18n';

const BASE_URL = 'https://frontaliereticino.ch';

const SECTION_SLUG: Record<Locale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const LOC_PREFIX: Record<Locale, string> = {
  it: 'localita',
  en: 'location',
  de: 'standort',
  fr: 'localite',
};

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
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
    matchedTitle: (c, n) => `Offerte di lavoro a ${c} — ${n} annunci aggiornati`,
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
    matchedTitle: (c, n) => `Jobs in ${c} — ${n} cross-border openings`,
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
    matchedTitle: (c, n) => `Stellen in ${c} — ${n} aktuelle Inserate`,
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
    matchedTitle: (c, n) => `Emplois à ${c} — ${n} offres frontalières`,
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

function buildSectionCanonical(locale: Locale): string {
  return `${BASE_URL}${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/(?<!:)\/+/g, '/');
}

function renderMatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const hubPath = buildHubPath(locale, entry.citySlug);
  const canonicalUrl = `${BASE_URL}${hubPath}`;
  const city = entry.displayName;
  const n = entry.jobCount;

  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px">
      <h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${esc(copy.matchedH1(city, n))}</h1>
    </header>
    <p style="margin:0 0 12px;font-size:15.5px">${esc(copy.matchedLede(city, n))}</p>
    <p style="margin:12px 0 0;font-size:14.5px"><a href="${esc(buildSectionCanonical(locale))}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(copy.browseAllLabel)} →</a></p>
  </main>`;

  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/\/+/g, '/'),
    pageLabel: city,
    canonicalUrl,
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
    jsonLdScripts: [breadcrumbLd],
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
  const canonicalUrl = buildSectionCanonical(locale);
  const sectionPath = buildSectionCanonical(locale);
  const city = entry.displayName;
  const hubPath = buildHubPath(locale, entry.citySlug);
  const hubAbsoluteUrl = `${BASE_URL}${hubPath}`;

  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px">
      <h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${esc(copy.unmatchedH1(city))}</h1>
    </header>
    <p style="margin:0 0 12px;font-size:15.5px">${esc(copy.unmatchedLede)}</p>
    <p style="margin:12px 0 0;font-size:14.5px"><a href="${esc(sectionPath)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(copy.browseAllLabel)} →</a></p>
  </main>`;

  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/\/+/g, '/'),
    pageLabel: city,
    canonicalUrl: hubAbsoluteUrl,
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
    jsonLdScripts: [breadcrumbLd],
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
    async closeBundle() {
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
        const hubPath = buildHubPath(entry.locale, entry.citySlug);
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
  };
}
