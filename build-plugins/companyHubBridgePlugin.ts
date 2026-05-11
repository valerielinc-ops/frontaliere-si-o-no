/**
 * Company-hub bridge plugin — emits 200 HTML pages for the 15 GSC
 * `Indicizzata Non trovata` URLs of the form
 * `/{locale}/{section}/(azienda|company|unternehmen|firma|entreprise|societe)-{company}/`
 * (Cohort 4).
 *
 * Why these 404 today
 * -------------------
 * JobBoard.tsx renders `<a href>` to company-filtered URLs from the
 * job-detail gate (`buildCompanySearchSlug`). Google crawls them but no
 * build plugin emitted static HTML for the `azienda-*` namespace — the
 * SPA's `parseCompanySlugFilter` handles the filter on hydration, but a
 * cold visit to the URL hits GH Pages' 404 fallback before JS runs.
 *
 * Approach (200, no 301) mirrors locationHubBridgePlugin (PR #89):
 *
 *   matched   (4 URLs, company in jobs.json):
 *     - canonical → self
 *     - body: H1 "Annunci di {Company}" + count + locale lede
 *     - SPA hydrates with company filter → real listings + AdSense
 *
 *   unmatched (11 URLs, company has rotated out or never existed):
 *     - canonical → section landing
 *     - body: "Azienda non disponibile" + browse-all CTA
 *
 * Both: `robots: 'index,follow'`, collision-safe.
 *
 * Sitemap policy: bridge pages NOT added — they're alias filter URLs.
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

const COMP_PREFIX: Record<Locale, string> = {
  it: 'azienda',
  en: 'company',
  de: 'unternehmen',
  fr: 'entreprise',
};

const LOCALE_PREFIX: Record<Locale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const OG_LOCALE: Record<Locale, string> = { it: 'it_IT', en: 'en_US', de: 'de_DE', fr: 'fr_FR' };

interface HubEntry {
  readonly locale: Locale;
  readonly companySlug: string;
  readonly url: string;
  readonly kind: 'matched' | 'unmatched';
  readonly displayName: string;
  readonly jobCount: number;
}

interface HubsFile {
  readonly hubs: HubEntry[];
}

interface BridgeCopy {
  readonly matchedTitle: (c: string, n: number) => string;
  readonly matchedDescription: (c: string, n: number) => string;
  readonly matchedH1: (c: string, n: number) => string;
  readonly matchedLede: (c: string, n: number) => string;
  readonly unmatchedTitle: string;
  readonly unmatchedDescription: string;
  readonly unmatchedH1: (c: string) => string;
  readonly unmatchedLede: string;
  readonly browseAllLabel: string;
}

const COPY: Record<Locale, BridgeCopy> = {
  it: {
    matchedTitle: (c, n) => `Offerte di lavoro ${c} — ${n} annunci attivi`,
    matchedDescription: (c, n) => `${n} annunci attivi di ${c} per frontalieri italo-svizzeri. Stipendio netto Permit G/B, fiscalità Accordo 2026, mappa pendolarismo TILO.`,
    matchedH1: (c, n) => `${n} annunci di ${c}`,
    matchedLede: (c, n) => `Trovi ${n} annunci attivi di ${c} aggiornati ogni giorno. Ogni offerta riporta il calcolo automatico dello stipendio netto Permit G (vivere in Italia) vs Permit B (vivere in Svizzera), le tempistiche di pendolarismo verso il confine ticinese e le agevolazioni fiscali introdotte dal Nuovo Accordo bilaterale italo-svizzero del 2026.`,
    unmatchedTitle: 'Azienda non più attiva — alternative aggiornate ogni giorno',
    unmatchedDescription: 'Nessun annuncio attivo per questa azienda. Esplora oltre 2000 offerte frontaliere su tutto il Ticino, filtrabili per ruolo, città, contratto e azienda.',
    unmatchedH1: (c) => `${c} — nessun annuncio attivo`,
    unmatchedLede: 'In questo momento non ci sono annunci attivi per l\'azienda cercata. Sul job board frontaliere trovi ogni giorno offerte aggiornate in tutto il Ticino, filtrabili per ruolo, città, tipo di contratto e azienda. Iscriviti per ricevere notifiche quando arrivano nuovi annunci compatibili.',
    browseAllLabel: 'Sfoglia tutti gli annunci attivi',
  },
  en: {
    matchedTitle: (c, n) => `Jobs at ${c} — ${n} cross-border openings`,
    matchedDescription: (c, n) => `${n} active openings at ${c} for Italian-Swiss cross-border workers. Permit G/B net salary, 2026 bilateral agreement tax adjustments, TILO commute map.`,
    matchedH1: (c, n) => `${n} openings at ${c}`,
    matchedLede: (c, n) => `Find ${n} active openings at ${c}, updated daily. Each listing carries the automatic net-salary calculation under Permit G (commuting from Italy) vs Permit B (Swiss residency), commute timetables to the Ticino border and the tax adjustments introduced by the 2026 Italy-Switzerland bilateral agreement.`,
    unmatchedTitle: 'Employer no longer active — alternatives updated daily',
    unmatchedDescription: 'No active openings at this employer. Browse 2000+ cross-border job listings across Ticino, filtered by role, city, contract type and employer.',
    unmatchedH1: (c) => `${c} — no active listings`,
    unmatchedLede: 'There are no active listings for the employer you searched. Our cross-border job board refreshes daily with new openings across all of Ticino, filtered by role, city, contract type and employer. Subscribe for notifications when matching openings are posted.',
    browseAllLabel: 'Browse all active listings',
  },
  de: {
    matchedTitle: (c, n) => `Stellen bei ${c} — ${n} aktive Inserate`,
    matchedDescription: (c, n) => `${n} aktive Stellen bei ${c} für italienisch-schweizerische Grenzgänger. Permit G/B Nettolohn, Steuer-Anpassungen Abkommen 2026, TILO-Pendelfahrpläne.`,
    matchedH1: (c, n) => `${n} Inserate von ${c}`,
    matchedLede: (c, n) => `Finden Sie ${n} aktive Stellen bei ${c}, täglich aktualisiert. Jedes Inserat enthält die automatische Nettolohn-Berechnung unter Permit G (Pendeln aus Italien) vs Permit B (Wohnsitz Schweiz), Pendlerfahrpläne zur Tessiner Grenze und die steuerlichen Anpassungen des neuen italienisch-schweizerischen Abkommens 2026.`,
    unmatchedTitle: 'Arbeitgeber nicht mehr aktiv — täglich aktualisierte Alternativen',
    unmatchedDescription: 'Keine offenen Stellen bei diesem Arbeitgeber. Über 2000 Grenzgänger-Inserate im Tessin, filterbar nach Rolle, Stadt, Vertragsart und Arbeitgeber.',
    unmatchedH1: (c) => `${c} — keine aktiven Inserate`,
    unmatchedLede: 'Es gibt derzeit keine aktiven Inserate für den gesuchten Arbeitgeber. Unser Grenzgänger-Job-Board wird täglich mit neuen Stellen im gesamten Tessin aktualisiert, filterbar nach Rolle, Stadt, Vertragsart und Arbeitgeber.',
    browseAllLabel: 'Alle aktiven Stellen ansehen',
  },
  fr: {
    matchedTitle: (c, n) => `Emplois chez ${c} — ${n} offres actives`,
    matchedDescription: (c, n) => `${n} offres actives chez ${c} pour frontaliers italo-suisses. Salaire net Permit G/B, ajustements fiscaux Accord 2026, horaires TILO.`,
    matchedH1: (c, n) => `${n} annonces de ${c}`,
    matchedLede: (c, n) => `Trouvez ${n} offres actives chez ${c}, mises à jour quotidiennement. Chaque annonce inclut le calcul automatique du salaire net sous Permit G (frontalier depuis l'Italie) vs Permit B (résidence suisse), les horaires de transport vers la frontière tessinoise et les ajustements fiscaux du nouvel Accord bilatéral italo-suisse 2026.`,
    unmatchedTitle: 'Employeur non disponible — alternatives mises à jour quotidiennement',
    unmatchedDescription: 'Aucune offre active chez cet employeur. Parcourez plus de 2000 annonces frontalières au Tessin, filtrables par rôle, ville, type de contrat et entreprise.',
    unmatchedH1: (c) => `${c} — aucune offre active`,
    unmatchedLede: 'Il n\'y a actuellement aucune offre active pour l\'employeur recherché. Notre job board frontalier s\'actualise quotidiennement avec de nouvelles offres dans tout le Tessin, filtrables par rôle, ville, type de contrat et employeur.',
    browseAllLabel: 'Parcourir toutes les annonces actives',
  },
};

function esc(value: string): string {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHubPath(locale: Locale, companySlug: string): string {
  return `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/${COMP_PREFIX[locale]}-${companySlug}/`.replace(/\/+/g, '/');
}

function buildSectionCanonical(locale: Locale): string {
  return `${BASE_URL}${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/(?<!:)\/+/g, '/');
}

function renderMatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const hubPath = buildHubPath(locale, entry.companySlug);
  const canonicalUrl = `${BASE_URL}${hubPath}`;
  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px"><h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${esc(copy.matchedH1(entry.displayName, entry.jobCount))}</h1></header>
    <p style="margin:0 0 12px;font-size:15.5px">${esc(copy.matchedLede(entry.displayName, entry.jobCount))}</p>
    <p style="margin:12px 0 0;font-size:14.5px"><a href="${esc(buildSectionCanonical(locale))}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(copy.browseAllLabel)} →</a></p>
  </main>`;
  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/\/+/g, '/'),
    pageLabel: entry.displayName,
    canonicalUrl,
  });
  return buildSeoPageHtml({
    locale, title: copy.matchedTitle(entry.displayName, entry.jobCount),
    description: copy.matchedDescription(entry.displayName, entry.jobCount),
    canonicalUrl, robots: 'index,follow', ogType: 'website', ogLocale: OG_LOCALE[locale],
    hreflangHtml: '', jsonLdScripts: [breadcrumbLd], bodyHtml, distDir, seoMainClass: 'cluster-seo-prose',
  });
}

function renderUnmatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  // Canonical points to the section landing for unmatched entries; the
  // BreadcrumbList still describes the bridge URL the visitor landed on.
  const canonicalUrl = buildSectionCanonical(locale);
  const sectionPath = buildSectionCanonical(locale);
  const hubAbsoluteUrl = `${BASE_URL}${buildHubPath(locale, entry.companySlug)}`;
  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px"><h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${esc(copy.unmatchedH1(entry.displayName))}</h1></header>
    <p style="margin:0 0 12px;font-size:15.5px">${esc(copy.unmatchedLede)}</p>
    <p style="margin:12px 0 0;font-size:14.5px"><a href="${esc(sectionPath)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(copy.browseAllLabel)} →</a></p>
  </main>`;
  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: `${LOCALE_PREFIX[locale]}/${SECTION_SLUG[locale]}/`.replace(/\/+/g, '/'),
    pageLabel: entry.displayName,
    canonicalUrl: hubAbsoluteUrl,
  });
  return buildSeoPageHtml({
    locale, title: copy.unmatchedTitle, description: copy.unmatchedDescription,
    canonicalUrl, robots: 'index,follow', ogType: 'website', ogLocale: OG_LOCALE[locale],
    hreflangHtml: '', jsonLdScripts: [breadcrumbLd], bodyHtml, distDir, seoMainClass: 'cluster-seo-prose',
  });
}

export function companyHubBridgePlugin(rootDir: string): Plugin {
  return {
    name: 'company-hub-bridge',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const dataPath = path.join(rootDir, 'data', 'gsc-company-hubs.json');
      if (!fs.existsSync(dataPath)) {
        console.warn('\x1b[33m[company-hub-bridge]\x1b[0m data/gsc-company-hubs.json missing — skipping');
        return;
      }
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      let file: HubsFile;
      try { file = JSON.parse(fs.readFileSync(dataPath, 'utf-8')); }
      catch (err) { console.warn('\x1b[33m[company-hub-bridge]\x1b[0m parse failed:', err); return; }
      if (!Array.isArray(file.hubs) || file.hubs.length === 0) return;

      let emitted = 0;
      let skipped = 0;
      const start = Date.now();

      for (const entry of file.hubs) {
        const hubPath = buildHubPath(entry.locale, entry.companySlug);
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
          console.warn(`\x1b[33m[company-hub-bridge]\x1b[0m failed to write ${indexTarget}:`, err);
        }
      }

      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `\x1b[36m[company-hub-bridge]\x1b[0m emitted ${emitted} bridge files (${file.hubs.length - skipped} pages, ${skipped} skipped) in ${dur}s`,
      );
    },
  };
}
