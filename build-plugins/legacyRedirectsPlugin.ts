/**
 * Generate static redirect pages for high-traffic legacy paths.
 * This prevents avoidable 404s and consolidates crawl signals to canonicals.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, GTAG_SNIPPET } from './constants';
import { resolveSearchConsoleCompatTarget } from './searchConsoleCompat';
import { resolveCantonSection, resolveJobCanton, type CantonLocale } from './shared/cantonSection';
import cantonSlugFile from '../data/canton-url-slugs.json';
import jobsFile from '../data/jobs.json';

/** Hreflang entry extracted from sitemap XML. */
interface HreflangEntry {
 hreflang: string;
 href: string;
}

/**
 * Parse all sitemap XML files under public/ and build a lookup from
 * canonical URL (with trailing slash) → array of hreflang <link> entries.
 * This lets legacy redirect pages point to the correct locale variants of
 * their target canonical URL.
 */
function buildHreflangMap(rootDir: string): Map<string, HreflangEntry[]> {
 const publicDir = path.resolve(rootDir, 'public');
 const sitemapFiles = [
 'sitemap-pages.xml',
 'sitemap-blog.xml',
 'sitemap-glossario.xml',
 'sitemap-news.xml',
 ];

 const map = new Map<string, HreflangEntry[]>();

 for (const file of sitemapFiles) {
 const filePath = path.join(publicDir, file);
 if (!fs.existsSync(filePath)) continue;

 const xml = fs.readFileSync(filePath, 'utf-8');

 // Extract each <url> block
 const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g);
 if (!urlBlocks) continue;

 for (const block of urlBlocks) {
 // Get <loc>
 const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
 if (!locMatch) continue;
 const loc = locMatch[1].trim();

 // Get all xhtml:link hreflang entries
 const hreflangs: HreflangEntry[] = [];
 const linkRegex = /<xhtml:link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/>/g;
 let linkMatch;
 while ((linkMatch = linkRegex.exec(block)) !== null) {
 hreflangs.push({ hreflang: linkMatch[1], href: linkMatch[2] });
 }

 if (hreflangs.length > 0) {
 map.set(loc, hreflangs);
 }
 }
 }

 return map;
}

/** Generate hreflang <link> tags string from entries. */
function hreflangLinksHtml(entries: HreflangEntry[]): string {
 return entries
 .map(e => ` <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`)
 .join('\n');
}

export function legacyRedirectsPlugin(rootDir: string): Plugin {
 const redirects: Record<string, string> = {
 '/guida-frontalieri/': '/guida-frontaliere/',
 '/guida-frontalieri/calendario-fiscale/': '/tasse-e-pensione/scadenze-fiscali/',
 '/pianificatore-pensione/': '/tasse-e-pensione/calcola-previdenza/',
 '/simulatore-what-if/': '/calcola-stipendio/cosa-cambia-se/',
 '/calculator/': '/calcola-stipendio/',
 '/stats/': '/statistiche/',
 '/comparatori/': '/compara-servizi/',
 '/comparatori/cambio-valuta/': '/compara-servizi/cambio-franco-euro/',
 '/comparatori/traffico-valichi/': '/statistiche/traffico-dogane/',
 '/comparatori/banche/': '/compara-servizi/confronta-banche/',
 '/comparatori/operatori-mobili/': '/compara-servizi/confronta-operatori-mobili/',
 '/comparatori/mappa-comuni/': '/guida-frontaliere/mappa-confine/',
 // Blog articles with changed slugs (old → new canonical)
 // A.4 — NASpI duplicate consolidation (cannibalization fix).
 // Older slug /naspi-disoccupazione-frontalieri/ redirects to the
 // canonical /naspi-ex-frontalieri-2026/ hub.
 '/articoli-frontaliere/naspi-disoccupazione-frontalieri/': '/articoli-frontaliere/naspi-ex-frontalieri-2026/',
 '/articoli-frontaliere/elezioni-comunali-ticino-2026/': '/articoli-frontaliere/elezioni-comunali-ticino/',
 '/en/cross-border-articles/ticino-elections-2026/': '/en/cross-border-articles/municipal-elections-ticino/',
 '/de/grenzgaenger-artikel/gemeindewahlen-tessin-2026/': '/de/grenzgaenger-artikel/gemeindewahlen-tessin/',
 '/fr/articles-frontaliers/elections-communales-tessin-2026/': '/fr/articles-frontalier/elections-municipales-tessin/',
 '/articoli-frontaliere/a9-chiusure-notturne-chiasso-como/': '/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri/',
 // Swiss transit fee refresh 2023 → 2026 (GSC striking-distance query "switzerland transit fee 2026")
 '/articoli-frontaliere/tassa-transito-svizzera-2023/': '/articoli-frontaliere/tassa-transito-svizzera-2026/',
 '/en/cross-border-articles/transit-fee-switzerland-2023/': '/en/cross-border-articles/transit-fee-switzerland-2026/',
 '/de/grenzgaenger-artikel/transitgebuehr-schweiz-2023/': '/de/grenzgaenger-artikel/transitgebuehr-schweiz-2026/',
 '/fr/articles-frontalier/frais-de-transit-suisse-2023/': '/fr/articles-frontalier/frais-de-transit-suisse-2026/',
 '/en/cross-border-articles/speed-controls-ticino-2026/': '/en/cross-border-articles/ticino-speed-controls-2026/',
 // Consolidated Q4 2025 frontalieri duplicates → canonical: frontalieri-ticino-dati-q4-2025
 // ex frontalieri-ticino-calo-2025
 '/articoli-frontaliere/frontalieri-ticino-calo-dati-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
 '/en/cross-border-articles/cross-border-workers-ticino-decline-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
 '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-daten-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
 '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
 // ex frontalieri-ticino-controtendenza-2026
 '/articoli-frontaliere/frontalieri-ticino-dati-calo-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
 '/en/cross-border-articles/cross-border-workers-ticino-data-decline-q4-2025/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
 '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-q4-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
 '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-q4-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
 // ex frontalieri-ticino-calo-q4-2025
 '/articoli-frontaliere/frontalieri-ticino-calo-dati-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
 '/en/cross-border-articles/cross-border-workers-ticino-decline-q4-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
 '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-q4-2025-daten/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
 '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-q4-2025/': '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-fin-2025/',
 // FR articles-frontalier (without trailing 's') — Google indexed both variants
 '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
 '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
 '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
 // ── Bing blocked URLs (2026-03-27) — old slugs → current canonical ──
 // IT: category or slug renames
 '/compara-servizi/cambio-valuta/': '/compara-servizi/cambio-franco-euro/',
 '/vivere-in-ticino/aziende-ticino/': '/vivere-in-ticino/aziende-svizzera-italiana/',
 '/vivere-in-ticino/asili-nido-ticino/': '/vivere-in-ticino/confronta-asili-nido/',
 '/vivere-in-ticino/dialetto-ticinese/': '/dialetto-ticinese/',
 '/vivere-in-ticino/prezzi-benzina-confine/': '/statistiche/prezzi-benzina-confine/',
 '/vivere-in-ticino/permessi-lavoro-svizzera/': '/guida-frontaliere/permessi-di-lavoro/',
 '/statistiche/osservatorio-stipendi-ticino/': '/statistiche/osservatorio-stipendi-lavori-ticino/',
 // Legacy SALARY_HUB_PATH (renamed to /statistiche/confronta-stipendi/).
 // Previously linked from ~6.9k /premi-cassa-malati/{canton}/{fascia}/ pages via
 // build-plugins/shared/relatedLinks.ts. Commit ad103562c renamed the canonical,
 // but already-deployed HTML retained the broken anchor. Redirect closes the 404.
 '/stipendi-frontalieri-ticino/': '/statistiche/confronta-stipendi/',
 '/en/cross-border-salaries-ticino/': '/en/statistics/compare-salaries/',
 '/de/grenzgaenger-loehne-tessin/': '/de/statistiken/gehaelter-vergleichen/',
 '/fr/salaires-frontaliers-tessin/': '/fr/statistiques/comparer-salaires/',
 '/statistiche/panoramica-mercato-lavoro/': '/statistiche/',
 '/statistiche/tasso-disoccupazione/': '/statistiche/disoccupazione-svizzera/',
 '/tasse-e-pensione/aliquote-imposta-fonte/': '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/',
 '/tasse-e-pensione/pianificazione-pensionistica/': '/tasse-e-pensione/calcola-previdenza/',
 '/tasse-e-pensione/calendario-fiscale/': '/tasse-e-pensione/scadenze-fiscali/',
 // B.1 — festivita-ticino canonical variant with year suffix (301 → evergreen slug)
 '/tasse-e-pensione/festivita-ticino-2026/': '/tasse-e-pensione/festivita-ticino/',
 '/en/taxes-and-pension/ticino-holidays-2026/': '/en/taxes-and-pension/ticino-holidays/',
 '/de/steuern-und-rente/tessiner-feiertage-2026/': '/de/steuern-und-rente/tessiner-feiertage/',
 '/fr/impots-et-retraite/jours-feries-tessin-2026/': '/fr/impots-et-retraite/jours-feries-tessin/',
 '/calcola-stipendio/simulazione-busta-paga/': '/calcola-stipendio/simula-busta-paga/',
 '/calcola-stipendio/what-if-scenario/': '/calcola-stipendio/cosa-cambia-se/',
 '/guida-frontaliere/comuni-confine/': '/vivere-in-ticino/comuni-di-frontiera/',
 '/contatti/': '/chi-siamo/',
 // H.9 (Workstream H, SEMrush issue 4) — archival cleanup of four "Pagina archiviata"
 // entries that previously resolved via SECTION_FALLBACKS to section roots. Each now
 // redirects to its active equivalent with a proper "Pagina spostata" bridge page.
 '/vivere-in-ticino/vivere-in-svizzera/': '/vivere-in-ticino/',
 '/statistiche/traffico-dogane/': '/guida-frontaliere/tempi-attesa-dogana/',
 '/guida-frontaliere/comuni-di-frontiera/': '/vivere-in-ticino/comuni-di-frontiera/',
 '/calcola-stipendio/confronta-permesso-g-vs-b/': '/guida-frontaliere/confronta-permesso-g-vs-b/',
 // EN: old slugs
 '/en/salary-calculator/': '/en/calculate-salary/',
 '/en/job-search-ticino/': '/en/find-jobs-ticino/',
 '/en/compare-services/health-insurance/': '/en/service-comparison/compare-health-insurance/',
 // DE: old slugs
 '/de/gehaltsrechner/': '/de/gehalt-berechnen/',
 '/de/stellensuche-tessin/': '/de/jobs-im-tessin/',
 // FR: old slugs
 '/fr/calculateur-salaire/': '/fr/calculer-salaire/',

 // ── Semrush 4xx (2026-04-23) — FR legacy paths reported as 404 ──
 // Cluster B: missing FR slugs + slug variants Google indexed.
 // NOTE: '/fr/salaires-frontaliers-tessin/' is already declared above; do not duplicate.
 '/fr/glossaire/': '/fr/glossaire-frontalier/',
 '/fr/comparer-services/assurance-maladie/': '/fr/comparer-services/comparer-caisses-maladie/',
 '/fr/primes-assurance-maladie/ticino/': '/fr/primes-assurance-maladie-communes/ticino/',
 '/fr/prix-diesel/aujourdhui/': '/fr/prix-gasoil-suisse/aujourd-hui/',
 '/fr/prix-diesel/aujourd-hui/': '/fr/prix-gasoil-suisse/aujourd-hui/',
 // FR recency-hub slug variant Google indexed (/3-derniers-jours/ → canonical /derniers-3-jours/)
 '/fr/trouver-emploi-tessin/3-derniers-jours/': '/fr/trouver-emploi-tessin/derniers-3-jours/',

 // ── Semrush 4xx (2026-04-25, issue 2) — 42 legacy paths reported as 404 ──
 // IT old slugs renamed/removed
 '/calcolatore/': '/calcola-stipendio/',
 '/costo-della-vita/': '/compara-servizi/costo-della-vita/',
 '/fisco-frontalieri/': '/tasse-e-pensione/',
 // Locale-agnostic legacy → CH-wide aggregator section (cathedral).
 '/job-board/': `/${resolveCantonSection('it', '_AGGREGATE_')}/`,
 '/statistiche/confronta-premi/': '/statistiche/premi-malattia-comuni/',
 '/tasse-svizzere-guida-frontaliere/': '/tasse-e-pensione/',
 '/tfr-calculator/': '/tfr-liquidazione-frontaliere/',
 '/tredicesima-svizzera/': '/calcolo-tredicesima-frontaliere/',
 // IT guida-frontaliere old/renamed sub-pages
 '/guida-frontaliere/avs-lpp-frontalieri/': '/tasse-e-pensione/calcola-previdenza/',
 '/guida-frontaliere/secondo-pilastro-frontalieri/': '/tasse-e-pensione/calcola-previdenza/',
 '/guida-frontaliere/diritto-lavoro-frontalieri/': '/guida-frontaliere/',
 '/guida-frontaliere/diritto-opzione-lamal/': '/guida-frontaliere/lamal-frontalieri/',
 '/guida-frontaliere/disoccupazione-frontalieri/': '/guida-frontaliere/disoccupazione-transfrontaliera/',
 '/guida-frontaliere/nuova-legge-frontalieri-2024/': '/guida-frontaliere/',
 '/guida-frontaliere/nuova-legge-frontalieri-2026/': '/guida-frontaliere/',
 '/guida-frontaliere/permesso-g/': '/guida-frontaliere/permessi-di-lavoro/',
 '/guida-frontaliere/permessi-lavoro/': '/guida-frontaliere/permessi-di-lavoro/',
 '/guida-frontaliere/trasferimento-auto/': '/guida-frontaliere/trasferire-auto-svizzera/',
 '/guida-frontaliere/traffico-valichi/': '/guida-frontaliere/tempi-attesa-dogana/',
 '/guida-frontaliere/assegni-familiari-frontalieri/': '/guida-frontaliere/',
 // DE old/missing slugs → current DE canonicals
 '/de/dienste-vergleichen': '/de/service-vergleich/',
 '/de/glossar': '/de/grenzgaenger-glossar/',
 '/de/grenzgaenger-leitfaden/': '/de/grenzgaenger-ratgeber/',
 '/de/grenzgaenger-ratgeber/neues-grenzgaengergesetz-2026/': '/de/grenzgaenger-ratgeber/',
 '/de/krankenkassenpraemien/ticino/': '/de/statistiken/krankenkassentraemien-nach-gemeinde/',
 '/de/leitfaden/bewilligung-g/': '/de/grenzgaenger-ratgeber/arbeitsbewilligungen/',
 '/de/leitfaden/neues-grenzgaenger-gesetz-2026/': '/de/grenzgaenger-ratgeber/',
 '/de/steuern-und-rente/': '/de/grenzgaenger-besteuerung-leitfaden-2026/',
 '/de/tessin-arbeitsmarkt/': '/de/jobs-im-tessin/',
 // EN old slugs
 '/en/compare-services/': '/en/service-comparison/',
 '/en/cross-border-guide/new-frontalieri-law-2026/': '/en/new-cross-border-agreement-2026/',
 '/en/frontier-articles': '/en/cross-border-articles/',
 '/en/frontier-guide': '/en/cross-border-guide/',
 '/en/glossary': '/en/cross-border-glossary/',
 '/en/guide/new-cross-border-law-2026/': '/en/new-cross-border-agreement-2026/',
 '/en/guide/permit-g/': '/en/cross-border-guide/compare-permit-g-vs-b/',
 // FR old slugs
 '/fr/comparer-services/': '/fr/comparaison-services/',
 '/fr/guide-frontalier/nouvelle-loi-frontaliers-2026/': '/fr/guide-frontalier/',
 '/fr/guide/nouvelle-loi-frontalier-2026/': '/fr/guide-frontalier/',
 '/fr/guide/permis-g/': '/fr/guide-frontalier/comparer-permis-g-vs-b/',
 '/fr/primes-assurance-maladie-communes/ticino/': '/fr/statistiques/primes-assurance-maladie-communes/',

 // Job slugs migrated from German to Italian
 '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-coop-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-coop-grigioni/',
 '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-interdiscount-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-interdiscount-grigioni/',
 '/cerca-lavoro-ticino/logistiker-in-efz-coop-grigioni/': '/cerca-lavoro-ticino/operatore-logistico-in-afc-coop-grigioni/',
 '/cerca-lavoro-ticino/detailhandelsfachfrau-mann-efz-gestalten-von-einkaufserlebnissen-jumbo-grigioni/': '/cerca-lavoro-ticino/specialista-del-commercio-al-dettaglio-afc-creazione-di-esperienze-di-acquisto-jumbo-grigioni/',
 '/cerca-lavoro-ticino/nachwuchskader-verkauf-coop-grigioni/': '/cerca-lavoro-ticino/vendita-quadri-junior-coop-grigioni/',
 '/cerca-lavoro-ticino/galenica-amavita-pharma-assistent-w-m-d-ascona/': '/cerca-lavoro-ticino/assistente-farmaceutico-f-m-d-amavita-galenica-ascona/',
 '/cerca-lavoro-ticino/kundenbetreuer-in-customer-center-mit-begeisterungsfahigkeit-und-noch-viel-mehr-pioniergei/': '/cerca-lavoro-ticino/responsabile-dell-assistenza-clienti-nel-customer-center-con-entusiasmo-e-molto-piu-spirit/',
 };

 const normalize = (p: string): string => {
 if (!p.startsWith('/')) return `/${p.replace(/^\/+/, '')}`;
 return p;
 };
 const withSlash = (p: string): string => {
 const n = normalize(p);
 return n === '/' ? n : (n.endsWith('/') ? n : `${n}/`);
 };

 return {
 name: 'legacy-redirects',
 apply: 'build',
 async closeBundle() {
 const distDir = path.resolve(rootDir, 'dist');
 let count = 0;
 let compatCount = 0;
 let cathedralCount = 0;

 // Build hreflang lookup from sitemaps so legacy pages can point to locale variants
 const hreflangMap = buildHreflangMap(rootDir);

 // ── Phase 8.4 (cathedral) — migration map ──
 // Jobs whose canton !== 'TI' are now emitted at canton-aware URLs
 // (e.g. /cerca-lavoro-zurigo/<slug>/). The pre-cathedral URLs at
 // /cerca-lavoro-ticino/<slug>/ no longer have a backing page, so emit
 // 301-style bridge pages pointing to the new canton section URL.
 // TI jobs are unaffected (byte-identical).
 try {
 const jobs = jobsFile as Array<{ canton?: string; location?: string; slug?: string; slugByLocale?: Record<string, string> }>;
 const locales: CantonLocale[] = ['it', 'en', 'de', 'fr'];
 const localePrefix: Record<CantonLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
 for (const job of jobs) {
 const canton = resolveJobCanton(job);
 if (canton === 'TI') continue;
 const legacyTI: Record<CantonLocale, string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
 };
 for (const locale of locales) {
 const slug = job.slugByLocale?.[locale] || job.slug;
 if (!slug) continue;
 const newSection = resolveCantonSection(locale, canton);
 const from = `${localePrefix[locale]}/${legacyTI[locale]}/${slug}/`.replace(/\/+/g, '/');
 const to = `${localePrefix[locale]}/${newSection}/${slug}/`.replace(/\/+/g, '/');
 if (from === to) continue;
 if (!redirects[from]) {
 redirects[from] = to;
 cathedralCount++;
 }
 }
 }
 } catch (err) {
 console.warn('\x1b[33m[legacy-redirects]\x1b[0m cathedral migration map failed:', err);
 }

 const getHreflangHtml = (targetPath: string): string => {
 const targetUrl = `${BASE_URL}${targetPath}`;
 const entries = hreflangMap.get(targetUrl);
 if (!entries || entries.length === 0) return '';
 return '\n' + hreflangLinksHtml(entries);
 };

 const buildCompatHtml = (from: string, to: string, kind: string) => buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${to}`,
 pathLabel: to,
 title: 'Pagina archiviata | Frontaliere Ticino',
 description: `URL legacy o non piu disponibile collegata a ${to}.`,
 body: `Questa URL ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : 'dell annuncio'} non e piu la versione corretta. Abbiamo mantenuto una pagina compatibile per evitare un errore e aiutare Google a consolidare la canonical.`,
 ctaLabel: 'Apri la pagina corretta',
 noindex: true,
 hreflangEntries: hreflangMap.get(`${BASE_URL}${to}`),
 });

 for (const [fromRaw, toRaw] of Object.entries(redirects)) {
 const from = withSlash(fromRaw);
 const to = withSlash(toRaw);
 if (from === to || from === '/') continue;

 const outDir = path.join(distDir, from.slice(1));
 fs.mkdirSync(outDir, { recursive: true });
 // Skip if a higher-priority plugin already generated this page (e.g. active job or soft-landing)
 if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
 const fromUrl = `${BASE_URL}${from}`;
 const toUrl = `${BASE_URL}${to}`;
 const hreflangTags = getHreflangHtml(to);
 const redirectLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 name: `Redirect ${from} → ${to}`,
 url: fromUrl,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL },
 mainEntityOfPage: toUrl,
 description: `Pagina legacy reindirizzata verso ${to}`,
 inLanguage: 'it',
 });
 const html = buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${to}`,
 pathLabel: to,
 title: 'Pagina spostata',
 description: 'Questa URL legacy ha una pagina canonica aggiornata su Frontaliere Ticino.',
 body: 'Questa URL legacy punta a una pagina aggiornata. Apri la destinazione canonica qui sotto.',
 ctaLabel: 'Apri la pagina corretta',
 noindex: true,
 hreflangEntries: hreflangMap.get(`${BASE_URL}${to}`),
 }).replace('</head>', `<script type="application/ld+json">${redirectLd}</script>\n </head>`);

 fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
 // Also write flat .html to avoid GitHub Pages 301 redirect
 // Flat files must NOT contain location.replace (Google classifies as redirect)
 const flatPath = from.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = path.join(distDir, flatPath.slice(1) + '.html');
 fs.mkdirSync(path.dirname(flatFile), { recursive: true });
 const flatHtml = html.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 fs.writeFileSync(flatFile, flatHtml, 'utf-8');
 }
 count++;
 }

 const compatPathsPath = path.resolve(rootDir, 'data/seo-404-compat-paths.json');
 // Job URL patterns handled exclusively by jobsSeoPagesPlugin (active + bridge + soft-landing + self-healing).
 // Writing thin compat pages for job paths is harmful: if jobsSeoPagesPlugin's flush fails,
 // the thin compat page survives and Google indexes it instead of enriched content.
 // Canton-aware: every per-canton job-board section across all 4 locales,
 // plus the TI-legacy/DE-stellenangebote/FR-emplois historical aliases.
 // Anything starting with one of these prefixes is owned by jobsSeoPagesPlugin
 // (active job, bridge, soft-landing) and must NOT be overwritten by compat HTML.
 const JOB_SECTION_PREFIXES: string[] = (() => {
 const locales: CantonLocale[] = ['it', 'en', 'de', 'fr'];
 const prefixByLocale: Record<CantonLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
 const codes = Object.keys((cantonSlugFile as { cantons: Record<string, unknown> }).cantons || {});
 const out = new Set<string>();
 for (const loc of locales) {
 for (const code of [...codes, '_AGGREGATE_']) {
 const section = resolveCantonSection(loc, code);
 out.add(`${prefixByLocale[loc]}/${section}/`);
 }
 }
 out.add('/de/stellenangebote-tessin/');
 out.add('/fr/emplois-tessin/');
 return Array.from(out);
 })();
 const isJobPath = (p: string): boolean => JOB_SECTION_PREFIXES.some(prefix => p.startsWith(prefix));
 let skippedJobPaths = 0;
 if (fs.existsSync(compatPathsPath)) {
 const compatPathsRaw = JSON.parse(fs.readFileSync(compatPathsPath, 'utf-8'));
 const compatPaths = Array.isArray(compatPathsRaw?.paths) ? compatPathsRaw.paths : [];
 for (const compatPathRaw of compatPaths) {
 const resolution = resolveSearchConsoleCompatTarget(String(compatPathRaw || ''));
 if (!resolution) continue;
 const from = normalize(String(compatPathRaw || ''));
 // Skip self-references (normalize strips trailing slash, canonicalPath may have it)
 const fromNorm = from.replace(/\/+$/, '');
 const toNorm = resolution.canonicalPath.replace(/\/+$/, '');
 if (from === '/' || fromNorm === toNorm) continue;
 // Skip job paths — handled by jobsSeoPagesPlugin with enriched content
 if (isJobPath(from)) { skippedJobPaths++; continue; }
 const outDir = path.join(distDir, from.slice(1));
 fs.mkdirSync(outDir, { recursive: true });
 // Skip if a higher-priority plugin (e.g. soft-landing pages) already generated this page
 if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
 const html = buildCompatHtml(from, resolution.canonicalPath, resolution.kind);
 fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
 const flatPath = from.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = path.join(distDir, flatPath.slice(1) + '.html');
 fs.mkdirSync(path.dirname(flatFile), { recursive: true });
 if (!fs.existsSync(flatFile)) {
 const flatHtml = html.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 fs.writeFileSync(flatFile, flatHtml, 'utf-8');
 }
 }
 compatCount++;
 }
 }

 if (count > 0) {
 console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${count} legacy redirect pages${cathedralCount > 0 ? ` (incl. ${cathedralCount} cathedral migration entries: TI-legacy URL → canton URL for jobs whose canton !== 'TI')` : ''}`);
 }
 if (compatCount > 0) {
 console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${compatCount} Search Console compatibility pages${skippedJobPaths > 0 ? ` (skipped ${skippedJobPaths} job paths → handled by jobs plugin)` : ''}`);
 }
 },
 };
}
