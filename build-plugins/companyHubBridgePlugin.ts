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
import { renderCantonSeoProse, buildCantonSeoProseFaqItems, type CantonSeoLocale } from './shared/cantonSeoProse';
import type { Locale } from '../services/i18n';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { COMPANY_ROUTE_PREFIX } from './shared/cantonSection';
import { buildCanonicalBridgePage } from './constants';
import { isBrandAlias, resolveBrandCanonical } from './shared/brandCanonicalMap';
import { buildTitleWithBrand, composePlaceTitle } from './shared/titleSuffix';

const BASE_URL = 'https://frontaliereticino.ch';

const SECTION_SLUG: Record<Locale, string> = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
  en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
  de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
  fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
};

// `COMP_PREFIX` is the same {it,en,de,fr}->prefix mapping as
// `COMPANY_ROUTE_PREFIX` in shared/cantonSection.ts (single source of truth,
// also used by jobsSeoPagesPlugin.ts / jobOrphanBridgePlugin.ts) — aliased
// under the local name to avoid touching the ~10 downstream `COMP_PREFIX[locale]`
// call sites in this file.
const COMP_PREFIX: Record<Locale, string> = COMPANY_ROUTE_PREFIX;
const COMPANY_SEGMENT_PREFIXES = new Set(['azienda', 'company', 'unternehmen', 'firma', 'entreprise', 'societe']);

const LOCALE_PREFIX: Record<Locale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const OG_LOCALE: Record<Locale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };

// Switzerland-wide aggregator hub used as canonical target for unmatched
// (`Azienda non più attiva`) bridges. The aggregator covers every canton,
// not just TI, so it is the safe consolidation target for cross-canton
// company URLs (e.g. `azienda-grace-la-margna-st-moritz` → GR canton).
const AGGREGATOR_SLUG: Record<Locale, string> = {
  it: 'cerca-lavoro-svizzera',
  en: 'find-jobs-switzerland',
  de: 'jobs-in-schweiz',
  fr: 'trouver-emploi-suisse',
};

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
    matchedTitle: (c, n) => composePlaceTitle([
      `Offerte di lavoro ${c} — ${n} annunci attivi`,
      `Offerte di lavoro ${c} — ${n} annunci`,
      `Offerte di lavoro ${c}`,
    ], undefined, (s) => esc(s).length),
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
    matchedTitle: (c, n) => composePlaceTitle([
      `Jobs at ${c} — ${n} cross-border openings`,
      `Jobs at ${c} — ${n} openings`,
      `Jobs at ${c}`,
    ], undefined, (s) => esc(s).length),
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
    matchedTitle: (c, n) => composePlaceTitle([
      `Stellen bei ${c} — ${n} aktive Inserate`,
      `Stellen bei ${c} — ${n} Inserate`,
      `Stellen bei ${c}`,
    ], undefined, (s) => esc(s).length),
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
    matchedTitle: (c, n) => composePlaceTitle([
      `Emplois chez ${c} — ${n} offres actives`,
      `Emplois chez ${c} — ${n} offres`,
      `Emplois chez ${c}`,
    ], undefined, (s) => esc(s).length),
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
    const companySegment = segments[cursor + 1];
    const dashIdx = companySegment.indexOf('-');
    if (dashIdx <= 0) return null;
    const prefix = companySegment.slice(0, dashIdx);
    const slug = companySegment.slice(dashIdx + 1);
    if (!COMPANY_SEGMENT_PREFIXES.has(prefix) || slug !== entry.companySlug) return null;
    return withLeadingTrailingSlash(pathname);
  } catch {
    return null;
  }
}

function buildEntryHubPath(entry: HubEntry): string {
  return pathFromHubUrl(entry) ?? buildHubPath(entry.locale, entry.companySlug);
}

function sectionPathFromEntry(entry: HubEntry): string {
  const hubPath = buildEntryHubPath(entry);
  const parts = hubPath.split('/').filter(Boolean);
  const sectionParts = entry.locale === 'it' ? parts.slice(0, 1) : parts.slice(0, 2);
  if (sectionParts.length > 0) return withLeadingTrailingSlash(sectionParts.join('/'));
  return `${LOCALE_PREFIX[entry.locale]}/${SECTION_SLUG[entry.locale]}/`.replace(/\/+/g, '/');
}

function buildAggregatorCanonical(locale: Locale): string {
  return `${BASE_URL}${LOCALE_PREFIX[locale]}/${AGGREGATOR_SLUG[locale]}/`.replace(/(?<!:)\/+/g, '/');
}

// Reverse-derive [sectionSlug, locale] tuples from the cathedral-allowed
// SECTION_SLUG map above so the cathedral-no-ti-hardcodes guard only has
// to track a single canonical source for the TI legacy section literals.
const SECTION_TO_LOCALE: ReadonlyArray<readonly [string, Locale]> =
  (Object.entries(SECTION_SLUG) as Array<[Locale, string]>).map(
    ([loc, slug]) => [slug, loc] as const,
  );

/**
 * Slug-segment normalizer mirroring runtime `slugifyCompany` in
 * components/community/JobBoard.tsx so auto-discovered bridge URLs match
 * the slugs that `buildCompanySearchSlug` produces from job-detail pages.
 */
function slugifyCompanyName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/**
 * Title-case helper for derived display names when the crawler dataset
 * does not provide a real `job.company` string (orphan-only entries).
 */
function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((p) => (p.length <= 2 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

interface ParsedCompanyHubUrl {
  readonly locale: Locale;
  readonly companySlug: string;
}

/**
 * Parse `/[locale-prefix]/{section}/{compPrefix}-{slug}/` URLs (absolute or
 * path-only). Returns null when the URL does not match a company-hub shape.
 */
function parseCompanyHubUrl(rawUrl: string): ParsedCompanyHubUrl | null {
  if (!rawUrl) return null;
  let pathname: string;
  try {
    pathname = rawUrl.startsWith('http')
      ? new URL(rawUrl).pathname
      : (rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`);
  } catch { return null; }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  let cursor = 0;
  if (['en', 'de', 'fr'].includes(segments[0])) cursor = 1;
  const sectionSeg = segments[cursor];
  const companySeg = segments[cursor + 1];
  if (!sectionSeg || !companySeg) return null;
  const sectionLocale = (segments[0] === 'en' || segments[0] === 'de' || segments[0] === 'fr')
    ? segments[0] as Locale
    : (SECTION_TO_LOCALE.find(([s]) => s === sectionSeg)?.[1] ?? 'it');
  const dashIdx = companySeg.indexOf('-');
  if (dashIdx <= 0) return null;
  const prefix = companySeg.slice(0, dashIdx);
  const slug = companySeg.slice(dashIdx + 1);
  if (!COMPANY_SEGMENT_PREFIXES.has(prefix)) return null;
  if (!slug) return null;
  return { locale: sectionLocale, companySlug: slug };
}

/**
 * Auto-discover company-hub orphan URLs from the broadest available data
 * sources, so the bridge plugin covers every `azienda-*` (or locale
 * equivalent) URL that Google has indexed OR that the crawler has ever
 * generated, even when the company is no longer in `data/jobs.json`.
 *
 * Sources (union):
 *  1. `data/gsc-job-urls.json`             — GSC-confirmed indexed URLs.
 *  2. `data/orphan-pages-audit.json`       — sitemap-derived orphan examples.
 *  3. `data/orphan-indexed-job-slugs.json` — indexed slugs whose company segment we approximate.
 *  4. `data/jobs/by-crawler/<key>.json`    — forward coverage for every crawler-known company.
 *
 * Entries are always emitted as `kind: 'unmatched'` because the canonical
 * company landing for in-dataset companies is already emitted by
 * `jobsSeoPagesPlugin`; the bridge's existing `fs.existsSync` guard skips
 * any auto-discovered slug whose canonical HTML was already written.
 */
export function autoDiscoverCompanyHubs(rootDir: string): HubEntry[] {
  const seen = new Map<string, HubEntry>(); // key = `${locale}::${companySlug}`
  const displayNameByItSlug = new Map<string, string>();

  // (4) Crawler universe — seeds display names for matching IT slugs and,
  // critically, seeds a bridge entry for EVERY locale (not just IT).
  //
  // Previously this only registered `it::${slug}`, so a company whose jobs
  // never surfaced in `data/gsc-job-urls.json` / `data/orphan-pages-audit.json`
  // (issue #3310) got an IT bridge page but no en/de/fr equivalent — a real
  // 404 on JobBoard.tsx's own company-filter links, which render identically
  // in every locale. The company-hub URL shape is locale-symmetric
  // (`buildHubPath` / `COMP_PREFIX` / `SECTION_SLUG` all key on the same 4
  // locales), so the crawler universe must seed all 4, matching the coverage
  // GSC/orphan-audit already prove exists for these URLs (e.g. the historical
  // `/en|de|fr/.../company|unternehmen|entreprise-*` hits in
  // `data/evidence-index.json` and `data/cf-hot-404s.json`).
  const crawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler');
  if (fs.existsSync(crawlerDir)) {
    for (const file of fs.readdirSync(crawlerDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(crawlerDir, file), 'utf-8'));
        const jobs: Array<{ company?: string; companyKey?: string }> = Array.isArray(raw?.jobs)
          ? raw.jobs
          : [];
        const sample = jobs.find((j) => j?.company);
        if (!sample?.company) continue;
        const slug = slugifyCompanyName(sample.company);
        if (!slug) continue;
        displayNameByItSlug.set(slug, sample.company);
        const seedSlug = (candidateSlug: string): void => {
          for (const locale of Object.keys(LOCALE_PREFIX) as Locale[]) {
            const key = `${locale}::${candidateSlug}`;
            if (!seen.has(key)) {
              seen.set(key, {
                locale,
                companySlug: candidateSlug,
                url: `${BASE_URL}${buildHubPath(locale, candidateSlug)}`,
                kind: 'unmatched',
                displayName: sample.company as string,
                jobCount: 0,
              });
            }
          }
        };
        seedSlug(slug);
        // ALSO seed the crawler's stable `companyKey` slug when it differs
        // from the display-name slug (issue: hub-bridge slug drift). Almost
        // half the crawler universe (204/414 companies) has a companyKey
        // that diverges from slugifyCompanyName(company) — e.g. company
        // "Ostschweizer Kinderspital" / companyKey "kispi-sg" — because
        // companyKey is often a shorter/older stable id (sometimes the
        // literal legacy URL slug that got indexed/linked before the
        // company's display name changed or before brand-alias folding was
        // introduced), while the display name alone slugifies to something
        // else entirely ("ostschweizer-kinderspital"). Without this, any
        // historically-indexed `azienda-{companyKey}` URL for such a company
        // never gets a bridge candidate from the crawler-universe source and
        // dead-ends at the origin unless GSC/orphan-audit happens to have
        // recorded it separately.
        const keySlug = slugifyCompanyName(sample.companyKey || '');
        if (keySlug && keySlug !== slug) seedSlug(keySlug);
      } catch { /* skip malformed crawler file */ }
    }
  }

  const ingestUrl = (rawUrl: string): void => {
    const parsed = parseCompanyHubUrl(rawUrl);
    if (!parsed) return;
    const key = `${parsed.locale}::${parsed.companySlug}`;
    if (seen.has(key)) return;
    const display =
      displayNameByItSlug.get(parsed.companySlug) ?? humanizeSlug(parsed.companySlug);
    seen.set(key, {
      locale: parsed.locale,
      companySlug: parsed.companySlug,
      url: rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}${withLeadingTrailingSlash(rawUrl)}`,
      kind: 'unmatched',
      displayName: display,
      jobCount: 0,
    });
  };

  // (1) GSC indexed URLs.
  const gscUrlsPath = path.join(rootDir, 'data', 'gsc-job-urls.json');
  if (fs.existsSync(gscUrlsPath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(gscUrlsPath, 'utf-8'));
      if (Array.isArray(arr)) for (const u of arr) ingestUrl(String(u));
    } catch { /* skip */ }
  }

  // (2) sitemap-derived orphan examples.
  const orphanAuditPath = path.join(rootDir, 'data', 'orphan-pages-audit.json');
  if (fs.existsSync(orphanAuditPath)) {
    try {
      const audit = JSON.parse(fs.readFileSync(orphanAuditPath, 'utf-8'));
      const perSitemap = audit?.perSitemap;
      if (perSitemap && typeof perSitemap === 'object') {
        for (const entry of Object.values<any>(perSitemap)) {
          const examples = Array.isArray(entry?.examples) ? entry.examples : [];
          for (const u of examples) ingestUrl(String(u));
        }
      }
    } catch { /* skip */ }
  }

  return [...seen.values()];
}

function renderMatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  const hubPath = buildEntryHubPath(entry);
  const canonicalUrl = `${BASE_URL}${hubPath}`;
  const sectionPath = sectionPathFromEntry(entry);
  // ── audit:text-html-ratio gate (Semrush "low text/HTML") ──────────
  // The matched bridge page was emitting ~6.5 KB of HTML with ~400 bytes
  // of visible prose (~6 % ratio). Append the canton-aware SEO prose
  // helper (intro + methodology + permit context + 4 FAQ + cross-links)
  // BELOW the data block so mobile-first content positioning is
  // preserved (CLAUDE.md non-negotiables #15/#17).
  const proseOpts = {
    locale: locale as CantonSeoLocale,
    // The bridge plugin targets TI-section URLs (cerca-lavoro-ticino/);
    // canton display is Ticino for every entry in this plugin's data file.
    cantonDisplay: locale === 'it' ? 'Ticino' : locale === 'en' ? 'Ticino' : locale === 'de' ? 'Tessin' : 'Tessin',
    slot: 'company-landing' as const,
    entityName: entry.displayName,
    countHint: entry.jobCount,
    ctaHref: `${BASE_URL}${sectionPath}`.replace(/(?<!:)\/+/g, '/'),
    ctaLabel: copy.browseAllLabel,
  };
  const proseHtml = renderCantonSeoProse(proseOpts);
  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg"><h1 class="s-hiC5FI">${esc(copy.matchedH1(entry.displayName, entry.jobCount))}</h1></header>
    <p class="s-cbFAda">${esc(copy.matchedLede(entry.displayName, entry.jobCount))}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(`${BASE_URL}${sectionPath}`.replace(/(?<!:)\/+/g, '/'))}">${esc(copy.browseAllLabel)} →</a></p>
    ${proseHtml}
  </main>`;
  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath,
    pageLabel: entry.displayName,
    canonicalUrl,
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: buildCantonSeoProseFaqItems(proseOpts),
  });
  return buildSeoPageHtml({
    locale, title: copy.matchedTitle(entry.displayName, entry.jobCount),
    description: copy.matchedDescription(entry.displayName, entry.jobCount),
    canonicalUrl, robots: 'index,follow', ogType: 'website', ogLocale: OG_LOCALE[locale],
    hreflangHtml: '', jsonLdScripts: [breadcrumbLd, faqLd], bodyHtml, distDir, seoMainClass: 'cluster-seo-prose',
  });
}

function renderUnmatchedPage(entry: HubEntry, distDir: string): string {
  const locale = entry.locale;
  const copy = COPY[locale];
  // Canonical points to the Switzerland-wide aggregator so cross-canton
  // company URLs (e.g. /azienda-grace-la-margna-st-moritz/ → GR) consolidate
  // onto the Swiss-wide hub instead of the TI section landing. The
  // BreadcrumbList still describes the bridge URL the visitor landed on.
  const canonicalUrl = buildAggregatorCanonical(locale);
  const sectionPath = `${BASE_URL}${sectionPathFromEntry(entry)}`.replace(/(?<!:)\/+/g, '/');
  const hubAbsoluteUrl = `${BASE_URL}${buildEntryHubPath(entry)}`;
  // ── audit:text-html-ratio gate ────────────────────────────────────
  // Unmatched bridge pages emitted ~6.4 KB of HTML with ~350 bytes
  // visible text (~5.4 % ratio). Append canton-aware prose helper for
  // company-landing slot. Same mobile-first positioning as matched.
  const proseOpts = {
    locale: locale as CantonSeoLocale,
    cantonDisplay: locale === 'it' ? 'Ticino' : locale === 'en' ? 'Ticino' : locale === 'de' ? 'Tessin' : 'Tessin',
    slot: 'company-landing' as const,
    entityName: entry.displayName,
    countHint: null,
    ctaHref: sectionPath,
    ctaLabel: copy.browseAllLabel,
  };
  const proseHtml = renderCantonSeoProse(proseOpts);
  const bodyHtml = `<main class="cluster-seo-prose s-zry6VY">
    <header class="s-v0ohjg"><h1 class="s-hiC5FI">${esc(copy.unmatchedH1(entry.displayName))}</h1></header>
    <p class="s-cbFAda">${esc(copy.unmatchedLede)}</p>
    <p class="s-elb1Sb"><a class="s-nF5mos" href="${esc(sectionPath)}">${esc(copy.browseAllLabel)} →</a></p>
    ${proseHtml}
  </main>`;
  const breadcrumbLd = buildBridgeBreadcrumbLd({
    locale,
    baseUrl: BASE_URL,
    sectionLabel: JOBS_SECTION_LABEL[locale],
    sectionPath: sectionPathFromEntry(entry),
    pageLabel: entry.displayName,
    canonicalUrl: hubAbsoluteUrl,
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: buildCantonSeoProseFaqItems(proseOpts),
  });
  return buildSeoPageHtml({
    locale, title: copy.unmatchedTitle, description: copy.unmatchedDescription,
    canonicalUrl, robots: 'index,follow', ogType: 'website', ogLocale: OG_LOCALE[locale],
    hreflangHtml: '', jsonLdScripts: [breadcrumbLd, faqLd], bodyHtml, distDir, seoMainClass: 'cluster-seo-prose',
  });
}

// autoDiscoverCompanyHubs() seeds candidates straight from the crawler
// universe (data/jobs/by-crawler/*.json), independent of BRAND_CANONICAL_MAP,
// so a declared alias slug (e.g. `migros-ticino`) can be discovered here too.
// jobsSeoPagesPlugin owns the correct noindex→primary bridge for that slug,
// but its emission is data-dependent (BRAND_UMBRELLAS aggregation must find
// a qualifying entry); when it doesn't fire for a given build, this plugin's
// `fs.existsSync` skip-guard sees no file and falls through to
// `renderUnmatchedPage`, wrongly canonicalizing the alias to the
// Switzerland-wide aggregator instead of the brand primary (issue #3232
// recurrence, tests/seo/brand-dedup.test.ts). Bridging to the SAME primary
// here — via the same `buildCanonicalBridgePage` helper jobsSeoPagesPlugin
// uses for its own alias pages — makes the two emitters agree regardless of
// write order, closing the race structurally instead of one build at a time.
function renderBrandAliasBridge(entry: HubEntry, canonicalSlug: string): string {
  const primaryHubPath = buildHubPath(entry.locale, canonicalSlug);
  const companyName = entry.displayName;
  return buildCanonicalBridgePage({
    canonicalUrl: `${BASE_URL}${primaryHubPath}`,
    pathLabel: primaryHubPath,
    title: buildTitleWithBrand(esc(companyName)),
    description: `Pagina alternativa per ${companyName}. Apri la pagina canonica per gli annunci aggiornati.`,
    body: `Questa URL azienda non e la variante canonica. Apri la pagina principale dell'azienda per gli annunci aggiornati.`,
    ctaLabel: String(companyName || 'Apri azienda'),
    lang: entry.locale,
    noindex: true,
  });
}

export function companyHubBridgePlugin(rootDir: string): Plugin {
  return {
    name: 'company-hub-bridge',
    apply: 'build',
    enforce: 'post',
    // Issue #4263 item 4 (sibling of the eventsSeoPagesPlugin/legacyRedirectsPlugin/
    // cfHot404BridgePlugin race): this plugin's own docblock states "the bridge's
    // existing fs.existsSync guard skips any auto-discovered slug whose canonical
    // HTML was already written [by jobsSeoPagesPlugin]" — that guard only holds if
    // jobsSeoPagesPlugin has actually finished writing by the time this runs, which
    // registration order alone does not guarantee under Rollup's default
    // async-parallel closeBundle. `order:'post'` + `sequential:true` makes Rollup
    // await every earlier-queued closeBundle promise first. Verified against the
    // installed rollup package; mirrors hreflangPostprocessPlugin.ts.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Curated cohort 4 hubs (15 manually-classified URLs). May be absent
      // on greenfield checkouts — auto-discovery still runs.
      const curatedPath = path.join(rootDir, 'data', 'gsc-company-hubs.json');
      const curatedHubs: HubEntry[] = (() => {
        if (!fs.existsSync(curatedPath)) return [];
        try {
          const parsed = JSON.parse(fs.readFileSync(curatedPath, 'utf-8')) as HubsFile;
          return Array.isArray(parsed?.hubs) ? parsed.hubs : [];
        } catch (err) {
          console.warn('\x1b[33m[company-hub-bridge]\x1b[0m parse of gsc-company-hubs.json failed:', err);
          return [];
        }
      })();

      // Auto-discovered hubs from GSC URLs, orphan-pages-audit, and the
      // crawler universe. Curated entries always win on conflict so
      // hand-classified matched/unmatched data stays authoritative.
      const discovered = autoDiscoverCompanyHubs(rootDir);
      const curatedKeys = new Set(curatedHubs.map((h) => `${h.locale}::${h.companySlug}`));
      const merged: HubEntry[] = [
        ...curatedHubs,
        ...discovered.filter((h) => !curatedKeys.has(`${h.locale}::${h.companySlug}`)),
      ];
      if (merged.length === 0) return;

      let emitted = 0;
      let skipped = 0;
      const start = Date.now();

      for (const entry of merged) {
        const hubPath = buildEntryHubPath(entry);
        const indexTarget = path.join(distDir, hubPath, 'index.html');
        const flatTarget = path.join(distDir, hubPath.replace(/\/+$/, '') + '.html');
        if (fs.existsSync(indexTarget)) { skipped++; continue; }

        const brandCanonicalSlug = resolveBrandCanonical(entry.companySlug);
        const html = (brandCanonicalSlug && isBrandAlias(entry.companySlug))
          ? renderBrandAliasBridge(entry, brandCanonicalSlug)
          : entry.kind === 'matched'
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
        `\x1b[36m[company-hub-bridge]\x1b[0m emitted ${emitted} bridge files (${merged.length - skipped} pages from ${curatedHubs.length} curated + ${discovered.length} auto-discovered, ${skipped} skipped) in ${dur}s`,
      );
      },
    },
  };
}
