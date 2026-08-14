/**
 * professionCityLandings.ts — profession x city landing pages
 * (issue #4301 TI cities, issue #4488 major CH cities).
 *
 * Emits `/lavoro-{city}-{role}/` (+ /en/jobs-, /de/arbeit-, /fr/travail-) for
 * each (city, profession) pair with at least MIN_JOBS real active jobs in
 * the corpus, across the 5 legacy TI hubs plus the 6 major non-TI cities
 * (Zürich, Basel, Bern, Luzern, Genève, Lausanne — PROFESSION_CITY_DEFS).
 * Mined evidence for the TI gap: data/search-location-gaps.json
 * (scripts/mine-search-location-gaps.mjs) — real on-site search terms like
 * "ingegnere lugano" / "autista bellinzona"; the extra-TI demand
 * (e.g. "ergoterapista zurigo") is visible in
 * data/profession-keyword-opportunities.json.
 *
 * Modeled directly on professionCantonLandings.ts: same MIN_JOBS floor gate,
 * same all-or-nothing 4-locale word-count guard, same below-floor bridge
 * pattern — except the bridge target here is the always-live city hub
 * (cityHubTarget → TI legacy `/cerca-lavoro-ticino/{city}/` or canton-aware
 * `/cerca-lavoro-{canton}/{city}/`), which jobsSeoPagesPlugin.ts emits
 * unconditionally per (canton, city, locale) regardless of that city's own
 * job count (falls back to canton-wide jobs as filler when empty), making it
 * a safe always-live redirect target — the same role salaryStatsBridge.ts's
 * target plays for the canton family.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords, buildCanonicalBridgePage } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { WriteCollector } from './batchWrite';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { buildDayStampIso } from './shared/buildDayStamp';
import { cleanSitemapFiles } from './shared/distNamespaceCleanup';
import {
  CITY_HUB_DISPLAY_NAME,
  CITY_HUB_LOCALE_PREFIX,
  buildCityHubPath,
  type CityHubKey,
} from './cityJobsHub';
import { getCantonDisplayName } from './shared/cantonDisplay';
import { resolveCantonSection } from './shared/cantonSection';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
} from './shared/cantonSeoProse';
import { cantonAnnualMedianChf } from './shared/cantonSalaryIndex';
import {
  aggregateProfessionJobsByCity,
  type ProfessionJobsSnapshot,
} from './professionJobsAggregate';
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeyword,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  buildProfessionCityPath,
  PROFESSION_CITY_KEYS,
  getProfessionCityDef,
  type ProfessionCityDef,
} from './professionCityData';
import { isProfessionCantonPath } from './professionCantonData';
import {
  H2_STYLE,
  BREADCRUMB_CLASS,
  BREADCRUMB_LINK_CLASS,
  CTA_PRIMARY_CLASS,
  renderStatGrid,
  pickStatTileTone,
  differentiateH1FromTitle,
} from './shared/seoContentTokens';
import { resolveProfessionCitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';

/** Minimum real active jobs for a (city, profession) page to be emitted. */
const MIN_JOBS = 3;
const SITEMAP_FILE = 'sitemap-profession-cities.xml';

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH',
};

/** Localised profession label (Title-cased role keyword is good enough). */
function professionLabel(locale: ProfessionLocale, id: ProfessionId): string {
  const role = professionRoleKeyword(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface Copy {
  eyebrow: string;
  h1: (role: string, city: string) => string;
  lede: (count: number, role: string, city: string) => string;
  tileLive: string;
  tileFresh: string;
  tileMedian: string;
  employersHeading: (city: string) => string;
  noSalary: string;
  cta: (city: string) => string;
  breadcrumbHome: string;
  breadcrumbTicino: string;
  metaTitle: (role: string, city: string) => string;
  metaDesc: (count: number, role: string, city: string) => string;
  perYear: string;
}

const COPY: Record<ProfessionLocale, Copy> = {
  it: {
    eyebrow: 'Offerte di lavoro per professione',
    h1: (r, c) => `Lavoro come ${r} a ${c}`,
    lede: (n, r, c) => `${n} offerte attive per ${r} a ${c} e dintorni, da datori di lavoro svizzeri reali.`,
    tileLive: 'Offerte attive',
    tileFresh: 'Pubblicate (30 gg)',
    tileMedian: 'Stipendio mediano lordo/anno',
    employersHeading: (c) => `Chi assume a ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Vedi tutte le offerte a ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbTicino: 'Ticino',
    metaTitle: (r, c) => `Lavoro ${r} ${c} — offerte e stipendio`,
    metaDesc: (n, r, c) => `${n} offerte per ${r} a ${c}: datori reali, stipendio mediano e candidatura diretta. Aggiornato ogni 12 ore.`,
    perYear: '/anno',
  },
  en: {
    eyebrow: 'Jobs by profession',
    h1: (r, c) => `${r} jobs in ${c}`,
    lede: (n, r, c) => `${n} active ${r} openings in ${c} and surrounding area, from real Swiss employers.`,
    tileLive: 'Active openings',
    tileFresh: 'Posted (30 days)',
    tileMedian: 'Median gross salary/year',
    employersHeading: (c) => `Who is hiring in ${c}`,
    noSalary: 'n/a',
    cta: (c) => `See all openings in ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbTicino: 'Ticino',
    metaTitle: (r, c) => `${r} jobs ${c} — openings and salary`,
    metaDesc: (n, r, c) => `${n} ${r} openings in ${c}: real employers, median salary and direct apply. Updated every 12 hours.`,
    perYear: '/yr',
  },
  de: {
    eyebrow: 'Stellen nach Beruf',
    h1: (r, c) => `${r}-Stellen in ${c}`,
    lede: (n, r, c) => `${n} aktive ${r}-Stellen in ${c} und Umgebung, von echten Schweizer Arbeitgebern.`,
    tileLive: 'Aktive Stellen',
    tileFresh: 'Veröffentlicht (30 Tage)',
    tileMedian: 'Medianlohn brutto/Jahr',
    employersHeading: (c) => `Wer in ${c} einstellt`,
    noSalary: 'k.A.',
    cta: (c) => `Alle Stellen in ${c} ansehen`,
    breadcrumbHome: 'Home',
    breadcrumbTicino: 'Tessin',
    metaTitle: (r, c) => `${r} Stellen ${c} — Angebote und Lohn`,
    metaDesc: (n, r, c) => `${n} ${r}-Stellen in ${c}: echte Arbeitgeber, Medianlohn und Direktbewerbung. Alle 12 Stunden aktualisiert.`,
    perYear: '/Jahr',
  },
  fr: {
    eyebrow: 'Emplois par profession',
    h1: (r, c) => `Emploi ${r} à ${c}`,
    lede: (n, r, c) => `${n} offres actives pour ${r} à ${c} et environs, d'employeurs suisses réels.`,
    tileLive: 'Offres actives',
    tileFresh: 'Publiées (30 j)',
    tileMedian: 'Salaire médian brut/an',
    employersHeading: (c) => `Qui recrute à ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Voir toutes les offres à ${c}`,
    breadcrumbHome: 'Accueil',
    breadcrumbTicino: 'Tessin',
    metaTitle: (r, c) => `Emploi ${r} ${c} — offres et salaire`,
    metaDesc: (n, r, c) => `${n} offres ${r} à ${c} : employeurs réels, salaire médian et candidature directe. Mis à jour toutes les 12 heures.`,
    perYear: '/an',
  },
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtChf(n: number, locale: ProfessionLocale): string {
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/**
 * Resolve the canton context for a city key. Unknown keys degrade to a
 * TI-shaped def so `renderProfessionCityPage` / `renderBelowFloorBridge` keep
 * their legacy behaviour when called outside the enumerated set.
 */
function resolveCityDef(cityKey: CityHubKey): ProfessionCityDef {
  return (
    getProfessionCityDef(cityKey) ?? {
      key: cityKey,
      display: CITY_HUB_DISPLAY_NAME[cityKey] ?? cityKey,
      cantonUrlKey: 'TI',
      cantonBfs: 'TI',
      isTi: true,
    }
  );
}

/**
 * Always-live city hub path — the below-floor bridge + CTA target. TI keeps the
 * frozen legacy slug (`/cerca-lavoro-ticino/{city}/`); every non-TI city maps to
 * the canton-aware hub (`/cerca-lavoro-{canton}/{city}/`) jobsSeoPagesPlugin.ts
 * emits unconditionally for every (canton, city, locale).
 */
function cityHubTarget(locale: ProfessionLocale, def: ProfessionCityDef): string {
  if (def.isTi) return buildCityHubPath(locale, def.key);
  return `${CITY_HUB_LOCALE_PREFIX[locale]}/${resolveCantonSection(locale, def.cantonUrlKey)}/${def.key}/`.replace(
    /\/+/g,
    '/',
  );
}

/** Canton section root (`/cerca-lavoro-{canton}/`) — the non-TI breadcrumb crumb target. */
function cantonSectionRoot(locale: ProfessionLocale, def: ProfessionCityDef): string {
  return `${CITY_HUB_LOCALE_PREFIX[locale]}/${resolveCantonSection(locale, def.cantonUrlKey)}/`.replace(/\/+/g, '/');
}

interface BridgeCopy {
  title: (role: string, city: string) => string;
  body: (role: string, city: string) => string;
  cta: (city: string) => string;
}

const BRIDGE_COPY: Record<ProfessionLocale, BridgeCopy> = {
  it: {
    title: (r, c) => `Lavoro ${r} ${c}`,
    body: (r, c) => `Al momento non ci sono abbastanza offerte attive per ${r} a ${c} da mostrare una pagina dedicata. Consulta tutte le offerte attive a ${c}.`,
    cta: (c) => `Vai alle offerte a ${c}`,
  },
  en: {
    title: (r, c) => `${r} jobs in ${c}`,
    body: (r, c) => `There aren't enough active ${r} openings in ${c} right now for a dedicated page. See all active openings in ${c}.`,
    cta: (c) => `Go to ${c} openings`,
  },
  de: {
    title: (r, c) => `${r}-Stellen in ${c}`,
    body: (r, c) => `In ${c} gibt es derzeit nicht genug aktive ${r}-Stellen fur eine eigene Seite. Alle aktiven Stellen in ${c} ansehen.`,
    cta: (c) => `Zu den Stellen in ${c}`,
  },
  fr: {
    title: (r, c) => `Emplois ${r} à ${c}`,
    body: (r, c) => `Il n'y a pas assez d'offres actives pour ${r} à ${c} pour une page dediee actuellement. Consultez toutes les offres actives à ${c}.`,
    cta: (c) => `Voir les offres à ${c}`,
  },
};

/**
 * Below-floor bridge: a (city, profession) pair that doesn't meet MIN_JOBS
 * this build gets a noindex,follow canonical bridge instead of a hard 404 —
 * same rationale as professionCantonLandings.ts's renderBelowFloorBridge.
 * The bridge targets the always-live city hub (cityHubTarget → TI legacy or
 * canton-aware `/cerca-lavoro-{canton}/{city}/`), emitted unconditionally for
 * every (canton, city, locale) by jobsSeoPagesPlugin.ts regardless of job
 * counts, so it's always a safe redirect target.
 */
function renderBelowFloorBridge(locale: ProfessionLocale, cityKey: CityHubKey, id: ProfessionId): string {
  const def = resolveCityDef(cityKey);
  const cityDisplay = def.display;
  const role = professionLabel(locale, id);
  const copy = BRIDGE_COPY[locale];
  const targetPath = cityHubTarget(locale, def);
  const targetUrl = `${BASE_URL}${targetPath}`;
  // Every hreflang alternate points at the city hub's OWN localized URL
  // (not the below-floor page's URL) — that hub is the only guaranteed-live
  // target across all 4 locales, same invariant as salaryStatsBridge.ts.
  const hreflangEntries: Array<{ hreflang: string; href: string }> = PROFESSION_LOCALES.map((loc) => ({
    hreflang: loc,
    href: `${BASE_URL}${cityHubTarget(loc, def)}`,
  }));
  hreflangEntries.push({ hreflang: 'x-default', href: `${BASE_URL}${cityHubTarget('it', def)}` });
  const html = buildCanonicalBridgePage({
    canonicalUrl: targetUrl,
    pathLabel: targetPath,
    title: copy.title(role, cityDisplay),
    description: copy.body(role, cityDisplay),
    body: copy.body(role, cityDisplay),
    ctaLabel: copy.cta(cityDisplay),
    lang: locale,
    noindex: true,
    hreflangEntries,
  });
  return html.replace(
    '</head>',
    `    <meta http-equiv="refresh" content="0; url=${targetUrl}">\n  </head>`,
  );
}

export function renderProfessionCityPage(opts: {
  locale: ProfessionLocale;
  cityKey: CityHubKey;
  id: ProfessionId;
  snapshot: ProfessionJobsSnapshot;
  distDir: string;
}): { html: string; words: number } {
  const { locale, cityKey, id, snapshot, distDir } = opts;
  const c = COPY[locale];
  const def = resolveCityDef(cityKey);
  const cityDisplay = def.display;
  const role = professionLabel(locale, id);
  const canonicalPath = buildProfessionCityPath(locale, cityKey, id);
  const homeHref = locale === 'it' ? '/' : `${PROFESSION_LOCALE_PREFIX[locale]}/`;

  // Second breadcrumb crumb = the canton. TI keeps the frozen 'Ticino'/'Tessin'
  // label linked to home (issue #4301 byte-freeze); a non-TI city links to its
  // live canton section root (`/cerca-lavoro-{canton}/`).
  const cantonCrumbLabel = def.isTi ? c.breadcrumbTicino : getCantonDisplayName(def.cantonUrlKey, locale);
  const cantonCrumbHref = def.isTi ? homeHref : cantonSectionRoot(locale, def);

  // Real corpus median for this city+profession; fall back to the canton-wide
  // BFS annual median when the matched jobs carry no salary data.
  const median = snapshot.medianSalaryChf && snapshot.medianSalaryChf > 0 ? snapshot.medianSalaryChf : cantonAnnualMedianChf(def.cantonBfs);
  const medianStr = median > 0 ? `CHF ${fmtChf(median, locale)}` : c.noSalary;

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_CLASS}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${cantonCrumbHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(cantonCrumbLabel)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(role)} · ${esc(cityDisplay)}</span>
</nav>`;

  const tiles = renderStatGrid([
    { label: c.tileLive, value: String(snapshot.liveCount), tone: pickStatTileTone('openings', snapshot.liveCount) },
    { label: c.tileFresh, value: String(snapshot.fresh30Count), tone: pickStatTileTone('fresh', snapshot.fresh30Count) },
    { label: c.tileMedian, value: median > 0 ? `${medianStr}${c.perYear}` : medianStr, tone: 'accent' },
  ]);

  const employers = snapshot.topEmployers.length > 0
    ? `<h2 style="${H2_STYLE}">${esc(c.employersHeading(cityDisplay))}</h2>
<ul class="flex flex-wrap gap-2 my-2">${snapshot.topEmployers
        .map((e) => `<li class="rounded-full bg-surface-alt px-3 py-1 text-sm">${esc(e.name)} <span class="text-subtle">(${e.count})</span></li>`)
        .join('')}</ul>`
    : '';

  // CTA + prose link to the city hub itself — the always-live, broader
  // listing for this city (also the below-floor bridge target).
  const ctaHref = cityHubTarget(locale, def);

  const proseOpts = {
    locale: locale as CantonSeoLocale,
    cantonDisplay: def.isTi ? (locale === 'it' || locale === 'en' ? 'Ticino' : 'Tessin') : getCantonDisplayName(def.cantonUrlKey, locale),
    slot: 'city-landing' as const,
    entityName: cityDisplay,
    countHint: snapshot.liveCount,
    ctaHref,
    ctaLabel: c.cta(cityDisplay),
  };
  const prose = renderCantonSeoProse(proseOpts);

  // ── Stessa collisione di professionCantonLandings.ts, qui ancora LATENTE ──
  //
  // Il secondo candidato del `<title>` e' `BRIDGE_COPY[locale].title`, e per
  // due locali quel template e' identico a `COPY[locale].h1`:
  //
  //   en   h1 `${r} jobs in ${c}`      ==  bridge title
  //   de   h1 `${r}-Stellen in ${c}`   ==  bridge title
  //
  // Oggi `audit:h1-title-duplicates` misura ZERO offender in questa famiglia,
  // e non perche' il difetto non ci sia: perche' nessuna coppia
  // professione+citta' ha ancora sforato i 66 caratteri. E' la stessa forma
  // che sul gemello per cantone e' gia' viva (Schaffhausen + «Optiker
  // optometrist» = 67 caratteri). Il primo nome di citta' lungo la accende.
  //
  // Ripararla solo dove si vede lascerebbe il gemello armato — ed e'
  // precisamente la ragione per cui il repo controlla i pattern fratelli.
  // Ambito: solo l'elemento `<h1>` (breadcrumb e JSON-LD tengono l'headline
  // non taggato), come `bfsSalaryLandingsPlugin.ts`.
  const pageTitle = composePlaceTitle(
    [c.metaTitle(role, cityDisplay), BRIDGE_COPY[locale].title(role, cityDisplay)],
    TITLE_MAX_CHARS,
    (s) => esc(s).length,
  );
  const h1Display = differentiateH1FromTitle(c.h1(role, cityDisplay), pageTitle, locale);

  const header = `<header class="sx-hero"><p class="sx-kick text-sm font-semibold text-accent"><span class="lh-emoji" aria-hidden="true">💼</span>${esc(c.eyebrow)} · ${esc(cityDisplay)}</p><h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${esc(h1Display)}</h1><p class="text-base text-body mt-2 max-w-prose">${esc(c.lede(snapshot.liveCount, role, cityDisplay))}</p></header>`;

  const main = `<div class="cl-fun">${breadcrumb}
${header}
${tiles}
${employers}
<p class="my-4"><a href="${esc(ctaHref)}" class="${CTA_PRIMARY_CLASS}">${esc(c.cta(cityDisplay))} →</a></p>
${prose}${endOfContentMultiplexHtml({ indexable: true })}</div>`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: cantonCrumbLabel, item: `${BASE_URL}${cantonCrumbHref}` },
      { '@type': 'ListItem', position: 3, name: c.h1(role, cityDisplay), item: `${BASE_URL}${canonicalPath}` },
    ],
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: buildCantonSeoProseFaqItems(proseOpts),
  };

  const hreflangPaths = {
    it: buildProfessionCityPath('it', cityKey, id),
    en: buildProfessionCityPath('en', cityKey, id),
    de: buildProfessionCityPath('de', cityKey, id),
    fr: buildProfessionCityPath('fr', cityKey, id),
  } as HreflangPaths;

  // Budget-aware cascade — `metaTitle` (with the "— offerte e stipendio"
  // suffix) fits most role×city combos but a longer role keyword (esp. DE
  // compounds like "Radiologietechniker") + a longer city name can clear
  // TITLE_MAX_CHARS (66). Falls back to the shorter `title` template
  // (already defined for the below-floor bridge, no suffix) instead of
  // truncating — same "shrink the boilerplate, never the role/place" policy
  // as employerProfilePagesPlugin.ts / composeSerpJobTitle (audit:title-length
  // regression #4593, this family never had a fallback before).
  // Calcolato sopra come `pageTitle`, prima dell'header, cosi' l'H1 si
  // confronta con la stringa ESATTA che finisce nel `<title>` (confrontarlo
  // con `c.metaTitle(...)` compilerebbe e non scatterebbe mai: il caso che
  // collide e' quello in cui il metaTitle viene scartato).
  const html = buildSeoPageHtml({
    locale,
    title: pageTitle,
    description: c.metaDesc(snapshot.liveCount, role, cityDisplay),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: main,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(faqLd)],
    ogLocale: OG_LOCALE[locale],
    robots: 'index,follow',
    distDir,
  });

  return { html, words: countHtmlBodyWords(html) };
}

export interface ProfessionCityEmitResult {
  pagesWritten: number;
  pagesSkippedForJobs: number;
  pagesSkippedForWordCount: number;
  /** Below-floor pairs bridged to the city hub instead of left to 404. */
  bridgesWritten: number;
  emittedPaths: string[];
}

function buildSitemap(paths: readonly string[], dateStamp: string): string {
  const entries = paths
    .map((p) => `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) {
      idx = idx.replace('</sitemapindex>', `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_FILE}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`);
    } else {
      idx = idx.replace(
        new RegExp(`(<loc>${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${SITEMAP_FILE}</loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(</lastmod>)`),
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[profession-cities] failed to patch sitemap index', err);
  }
}

/** Drop the <sitemap> entry for this family from the index (zero-emit build). */
function removeSitemapFromIndex(distDir: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    const idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) return;
    const cleaned = idx.replace(
      new RegExp(`\\s*<sitemap>\\s*<loc>[^<]*${SITEMAP_FILE}</loc>\\s*<lastmod>[^<]*</lastmod>\\s*</sitemap>`),
      '',
    );
    fs.writeFileSync(indexPath, cleaned, 'utf-8');
  } catch (err) {
    console.warn('[profession-cities] failed to prune sitemap index', err);
  }
}

export async function emitProfessionCityPages(opts: { rootDir: string; distDir: string }): Promise<ProfessionCityEmitResult> {
  const result: ProfessionCityEmitResult = { pagesWritten: 0, pagesSkippedForJobs: 0, pagesSkippedForWordCount: 0, bridgesWritten: 0, emittedPaths: [] };
  const byCity = aggregateProfessionJobsByCity(opts.rootDir);
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'professionCityLandings' });

  for (const cityKey of PROFESSION_CITY_KEYS) {
    // No early `continue` on a missing city bucket: a city with zero matched
    // jobs this build must still get bridges for every profession, or a
    // previously-live page for that city would 404 with no recovery path.
    const perProfession = byCity[cityKey];
    for (const id of PROFESSION_IDS) {
      // Collision guard (audit:sitemap-canonicals regression #4593): for a
      // handful of (locale, city) pairs the city slug byte-matches the
      // canton slug at that SAME locale (e.g. EN/DE "basel" city == "basel"
      // canton; FR "geneve" city == "geneve" canton — CITY_HUB_SLUG has no
      // non-TI entries so the city slug is locale-invariant, while the
      // canton slug varies by locale, so only some locales collide). When
      // that happens, `buildProfessionCityPath` and `buildProfessionCantonPath`
      // produce the IDENTICAL URL — professionCantonLandings (registered
      // FIRST in vite.config.ts) already owns that path with a real,
      // self-canonical page; this family must never write to it (was
      // silently overwriting the canton page's HTML with a below-floor
      // bridge whose canonical pointed elsewhere, while the CANTON sitemap
      // still listed the URL as self-canonical — the sitemap/HTML mismatch
      // `audit:sitemap-canonicals` flags). Checked per-locale via the
      // canton family's own exported path index — no hand-maintained slug
      // collision table to drift out of sync.
      const reservedLocales = new Set(
        PROFESSION_LOCALES.filter((locale) => isProfessionCantonPath(buildProfessionCityPath(locale, cityKey, id))),
      );
      if (reservedLocales.size === PROFESSION_LOCALES.length) {
        // Every locale for this (city, profession) pair collides — the
        // canton family owns the URL in all 4 locales, nothing left for
        // this family to emit (not even a bridge — there's no city-only
        // slot to redirect from).
        continue;
      }
      const emittableLocales = PROFESSION_LOCALES.filter((locale) => !reservedLocales.has(locale));

      const snapshot = perProfession?.[id];
      if (!snapshot || snapshot.liveCount < MIN_JOBS) {
        result.pagesSkippedForJobs++;
        for (const locale of emittableLocales) {
          const canonicalPath = buildProfessionCityPath(locale, cityKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderBelowFloorBridge(locale, cityKey, id));
          result.bridgesWritten++;
        }
        continue;
      }
      // Render all 4 locales first, emit ALL-OR-NOTHING (same rationale as
      // professionCantonLandings.ts): a single locale dropping below the
      // words gate while the others ship would dangle hreflang at a missing
      // target. hreflang itself still references all 4 buildProfessionCityPath
      // URLs unconditionally (including any reserved one) — that URL is real
      // and live, just served by the canton family instead of this one, so
      // it's a valid cross-locale alternate exactly like a below-floor
      // bridge's hub target.
      const rendered = PROFESSION_LOCALES.map((locale) => ({
        locale,
        ...renderProfessionCityPage({ locale, cityKey, id, snapshot, distDir: opts.distDir }),
      }));
      if (rendered.some((r) => r.words < MIN_INDEXABLE_WORDS)) {
        result.pagesSkippedForWordCount += PROFESSION_LOCALES.length;
        // Same below-floor-bridge treatment as the liveCount<MIN_JOBS branch
        // above (sibling bug class, see professionCantonLandings.ts): a bare
        // `continue` here leaves this pair's slot empty for a locale-
        // partitioned CI build to fill with a different verdict per locale.
        for (const locale of emittableLocales) {
          const canonicalPath = buildProfessionCityPath(locale, cityKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderBelowFloorBridge(locale, cityKey, id));
          result.bridgesWritten++;
        }
        continue;
      }
      for (const r of rendered) {
        if (reservedLocales.has(r.locale)) continue;
        const canonicalPath = buildProfessionCityPath(r.locale, cityKey, id);
        const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), r.html);
        result.pagesWritten++;
        result.emittedPaths.push(canonicalPath);
      }
    }
  }

  await collector.flush();

  cleanSitemapFiles(opts.distDir, [SITEMAP_FILE]);
  const dateStamp = buildDayStampIso();
  if (result.emittedPaths.length > 0) {
    fs.writeFileSync(np.join(opts.distDir, SITEMAP_FILE), buildSitemap(result.emittedPaths, dateStamp), 'utf-8');
    patchSitemapIndex(opts.distDir, dateStamp);
  } else {
    removeSitemapFromIndex(opts.distDir);
  }
  return result;
}

export function professionCityLandings(rootDir: string): Plugin {
  return {
    name: 'profession-city-landings',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_CITIES === '1') {
        resolveProfessionCitiesFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const res = await emitProfessionCityPages({ rootDir, distDir });
      // eslint-disable-next-line no-console
      console.log(`[profession-cities] emitted ${res.pagesWritten} pages, ${res.bridgesWritten} below-floor bridges (${res.pagesSkippedForJobs} pairs below job floor, ${res.pagesSkippedForWordCount} below word gate)`);
      // Hand emitted canonical paths to professionCityLinksPlugin so it can
      // de-orphan exactly the pages shipped (CLAUDE.md regola #5: close
      // orphans with real internal links, not by relaxing the gate).
      resolveProfessionCitiesFlushed(res.emittedPaths);
    },
  };
}
