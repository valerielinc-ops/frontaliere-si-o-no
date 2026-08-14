/**
 * Generate static redirect pages for high-traffic legacy paths.
 * This prevents avoidable 404s and consolidates crawl signals to canonicals.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, GTAG_SNIPPET } from './constants';
import {
 resolveSearchConsoleCompatTarget,
 JOB_BOARD_PAGINATION_PATTERN,
 SEARCH_COMBO_SEGMENT_PATTERN,
} from './searchConsoleCompat';
import { readCompatPaths } from '../scripts/lib/compat-paths-store.mjs';
import {
 resolveCantonSection,
 resolveJobCanton,
 isCompanyHubNamespaceSlug,
 AGGREGATE_KEY,
 type CantonLocale,
} from './shared/cantonSection';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { loadArticleRedirects, assertNoCrossSourceChains, assertNoInternalChains, ARTICLE_REDIRECTS_FILE } from './shared/articleRedirects.mjs';
import { loadJobsJson } from './shared/loadJobsJson';
import cantonSlugFile from '../data/canton-url-slugs.json';
import { isUnshippablePath, unshippableSectionPrefixes } from './shared/unshippableSections';

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
 'sitemap-blog-ch.xml',
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
 // The hand-authored redirect map. `data/article-redirects.json` is merged into
 // it at closeBundle time (issue #5352) — a `from` declared here wins, and
 // tests/article-rename-redirects.test.ts fails on any key declared twice.
 const redirects: Record<string, string> = {
 '/guida-frontalieri/': '/guida-frontaliere/',
 '/guida-frontalieri/calendario-fiscale/': '/tasse-e-pensione/scadenze-fiscali/',
 '/pianificatore-pensione/': '/tasse-e-pensione/calcola-previdenza/',
 '/simulatore-what-if/': '/calcola-stipendio/cosa-cambia-se/',
 '/calculator/': '/calcola-stipendio/',
 '/stats/': '/statistiche/',
 '/comparatori/': '/compara-servizi/',
 '/comparatori/cambio-valuta/': '/compara-servizi/cambio-franco-euro/',
 // Collassata (#5352, review round 3). Puntava a /statistiche/traffico-dogane/,
 // che la pulizia H.9 piu' sotto ha a sua volta reindirizzato: due hop, con il
 // primo canonical su una pagina noindex. Misurato in produzione prima della
 // fix: /comparatori/traffico-valichi/ → 200 noindex,follow canonical
 // /statistiche/traffico-dogane/ → 200 noindex,follow canonical
 // /guida-frontaliere/tempi-attesa-dogana/ (200 index,follow, la pagina vera).
 // Stessa destinazione di /guida-frontaliere/traffico-valichi/ piu' sotto.
 '/comparatori/traffico-valichi/': '/guida-frontaliere/tempi-attesa-dogana/',
 '/comparatori/banche/': '/compara-servizi/confronta-banche/',
 '/comparatori/operatori-mobili/': '/compara-servizi/confronta-operatori-mobili/',
 '/comparatori/mappa-comuni/': '/guida-frontaliere/mappa-confine/',
 // Never-valid /comparatori/ sub-paths leaked into internal links (issue #2996):
 // LAMal-vs-CMI is a blog article; LAMal-vs-SSN is the health-insurance comparator.
 '/comparatori/lamal-vs-cmi/': '/articoli-frontaliere/lamal-vs-cmi-frontaliere/',
 '/comparatori/confronta-lamal-ssn/': '/compara-servizi/confronta-casse-malati/',
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
 // ── Runaway `generate-article.yml` cleanup (2026-08-06) — four retired articles ──
 // A self-dispatching workflow (now deleted + disabled) wrote five articles straight
 // into the site repo. One (`rimborsi-730-sostituti-imposta`) was carried into the
 // corpus and stays; these four are withdrawn. The corpus mirror already deleted them
 // from BOTH repos, so the next shard deploy drops the pages — without an entry here
 // all 16 URLs (4 articles × 4 locales) would go from 200 to a bare 404 with no signal
 // for the crawler. Verified live 200 on the apex host on 2026-08-06.
 //
 // Why a redirect bridge and not an HTTP 410: nothing in this repo can emit one. The
 // origin is a static shard, `legacyRedirectsPlugin` emits a 200 "Pagina spostata"
 // bridge (`noindex,follow` + canonical + meta-refresh), and infra/cloudflare-worker
 // only upgrades an ALREADY-404 origin response to a 301 — it has no 410 path. The
 // bridge's `noindex` is what de-indexes the retired URL; the target only steers the
 // human. So the real choice here is the target, and it differs per retirement reason.
 //
 // (1) `prezzi-proprieta-svizzera-aumentano` — unpublishable, not merely wrong: it
 // invents five non-existent Swiss laws (LRLO, LIIS, LTI, LFL, a "1972 border law"),
 // attributes never-published prices to ImmoScout24, contradicts its own figures and
 // ends on a literal "*Un agente immobiliare*" placeholder. No article is an
 // equivalent, so pointing it at a topically-adjacent real one would launder the
 // fabrication's link equity onto a page that does not answer the query. It goes to
 // the section root instead — same treatment as the H.9 archival block below.
 '/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/': '/articoli-frontaliere/',
 '/en/cross-border-articles/swiss-property-prices-rise/': '/en/cross-border-articles/',
 '/de/grenzgaenger-artikel/schweizer-immobilienpreise-steigen/': '/de/grenzgaenger-artikel/',
 '/fr/articles-frontalier/prix-immobilier-suisse-augmentent/': '/fr/articles-frontalier/',
 // (2) `caldo-torrido-lavoro-ticino` — true duplicate: the corpus already carries
 // `caldo-lavoro-frontalieri-ticino` off the same ticinonews.ch source. Textbook
 // consolidation onto the surviving original.
 '/articoli-frontaliere/caldo-torrido-lavoro-ticino/': '/articoli-frontaliere/caldo-lavoro-frontalieri-ticino/',
 '/en/cross-border-articles/hot-weather-work-ticino/': '/en/cross-border-articles/heat-work-cross-border-ticino/',
 '/de/grenzgaenger-artikel/heisses-wetter-arbeit-tessin/': '/de/grenzgaenger-artikel/hitze-arbeitsgrenze-tessin/',
 '/fr/articles-frontalier/chaleur-torrida-travail-tessin/': '/fr/articles-frontalier/chaleur-travail-frontalier-tessin/',
 // (3) `lavoro-forzato-catene-svizzere` — true duplicate of the corpus'
 // `lavoro-forzato-svizzera`, same swissinfo.ch source. NB the EN pair differs by a
 // single letter: retired `forced-labour-…` (British) → surviving `forced-labor-…`.
 '/articoli-svizzera/lavoro-forzato-catene-svizzere/': '/articoli-svizzera/lavoro-forzato-svizzera/',
 '/en/swiss-articles/forced-labour-swiss-supply-chains/': '/en/swiss-articles/forced-labor-swiss-supply-chains/',
 '/de/schweiz-artikel/zwangsarbeit-schweizer-lieferketten/': '/de/schweiz-artikel/zwangsarbeit-in-schweizer-lieferketten/',
 '/fr/articles-suisse/travail-force-chaines-approvisionnement-suisse/': '/fr/articles-suisse/travail-force-dans-les-chaines-dapprovisionnement-suisses/',
 // (4) `vivere-maslianico-lavorare-ticino-frontaliere` — substantive tax error: it
 // presents the €10,000 / €7,500 franchigia as an exemption from the SWISS imposta
 // alla fonte, when it is an ITALIAN IRPEF exemption. The search intent ("live in
 // Maslianico, work in Ticino") is legitimate and still served — by the Maslianico
 // border-municipality page, which is generated from controlled municipality data
 // rather than LLM prose and so cannot reproduce the error.
 '/articoli-frontaliere/vivere-maslianico-lavorare-ticino-frontaliere/': '/vivere-in-ticino/comuni-di-frontiera/maslianico/',
 '/en/cross-border-articles/live-maslianico-work-ticino-cross-border/': '/en/living-in-ticino/border-municipalities/maslianico/',
 '/de/grenzgaenger-artikel/in-maslianico-wohnen-arbeiten-tessin-grenzganger/': '/de/leben-im-tessin/grenzgemeinden/maslianico/',
 '/fr/articles-frontalier/vivre-maslianico-travailler-tessin-frontalier/': '/fr/vivre-au-tessin/communes-frontiere/maslianico/',
 // ── Cross-section duplicate retirements, nanako#356 (2026-08-14) — three svizzera
 // articles retired in favour of a frontaliere-section winner chosen on GA4 (the
 // retired side was 0/0/0 pageviews/sessions/users in all three). This entry is
 // also what `scripts/lib/corpus-removal-guard.mjs` reads before it will let
 // `pull-articles-corpus.mjs` remove these ids from packages/articles/content/ —
 // without it here the next sync refuses the removal outright rather than risk an
 // undeclared deletion. See infra/cloudflare-worker/locale-router.js
 // EDGE_RETIRED_PATHS for the serving-path half.
 '/articoli-svizzera/autostrada-riapertura-ticino/': '/articoli-frontaliere/autostrada-a2-mezzovico-interrogazione/',
 '/en/swiss-articles/a2-highway-riopening-ticino/': '/en/cross-border-articles/a2-motorway-mezzovico-interpellation/',
 '/de/schweiz-artikel/a2-autobahn-wiedereroffnung-tessin/': '/de/grenzgaenger-artikel/autobahn-a2-mezzovico-anfrage/',
 '/fr/articles-suisse/autoroute-a2-ouverture-again-tessin/': '/fr/articles-frontalier/autoroute-a2-mezzovico-interpellation/',
 '/articoli-svizzera/effetto-domino-fallite-aziende-svizzera/': '/articoli-frontaliere/fallimenti-aziende-svizzera-1994/',
 '/en/swiss-articles/domino-effect-failed-companies-switzerland/': '/en/cross-border-articles/business-bankruptcies-switzerland-1994/',
 '/de/schweiz-artikel/domino-effekt-gefallene-unternehmen-schweiz/': '/de/grenzgaenger-artikel/unternehmenspleiten-schweiz-1994/',
 '/fr/articles-suisse/effet-domino-filiale-dentreprise-suisse/': '/fr/articles-frontalier/faillites-entreprises-suisse-1994/',
 '/articoli-svizzera/un-matrimonio-che-vale-cento-posti-di-lavoro/': '/articoli-frontaliere/matrimonio-aziendale-vallemaggia-100/',
 '/en/swiss-articles/a-union-of-four-construction-companies-in-vallemaggia/': '/en/cross-border-articles/vallemaggia-business-merger-100-jobs/',
 '/de/schweiz-artikel/eine-verbindung-von-vier-bauunternehmen-in-vallemaggia/': '/de/grenzgaenger-artikel/vallemaggia-firmenfusion-100-jobs/',
 '/fr/articles-suisse/un-mariage-entre-quatre-entreprises-de-construction-en-vallemaggia/': '/fr/articles-frontalier/fusion-entreprise-vallemaggia-100-emplois/',
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
 // Collassata (#5352, review round 3), stessa forma della gemella IT sopra: il
 // bersaglio /fr/primes-assurance-maladie-communes/ticino/ e' a sua volta
 // reindirizzato piu' sotto verso /fr/statistiques/primes-assurance-maladie-communes/.
 // Misurato prima della fix: 200 noindex,follow → 200 noindex,follow → 200
 // index,follow. La destinazione finale non porta il segmento /ticino/, ed e'
 // gia' dov'e' finito l'utente fin qui: collassare non cambia dove si arriva,
 // toglie solo l'hop che perde il segnale.
 '/fr/primes-assurance-maladie/ticino/': '/fr/statistiques/primes-assurance-maladie-communes/',
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
 // ── Cloudflare-confirmed feature-page 404s (2026-06-17 edge sweep) ──
 // Real-traffic 404s on renamed/section-root non-job pages. Destinations
 // verified 200 live. Only the OBSERVED paths are mapped (not the full
 // crossing list) — /tempi-attesa-confine/ and bare /traffico-dogane/.../oggi/
 // were never our own emitted paths, so enumerating all 26 crossings would be
 // speculative (AGENTS.md #6). Border-wait pages were renamed to
 // /guida-frontaliere/tempi-attesa-dogana/<crossing>/ (cf. the section redirect
 // at /statistiche/traffico-dogane/ above); the old slugs also dropped the
 // d-hyphen (ditalia → d-italia, dintelvi → d-intelvi), normalized here.
 '/tempi-attesa-confine/chiasso-brogeda/': '/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/',
 '/traffico-dogane/campione-ditalia-bissone/oggi/': '/guida-frontaliere/tempi-attesa-dogana/campione-d-italia-bissone/',
 '/traffico-dogane/lanzo-dintelvi-arogno/oggi/': '/guida-frontaliere/tempi-attesa-dogana/lanzo-d-intelvi-arogno/',
 // Fuel section-root (no index) → that fuel's localized "today" landing,
 // keeping benzina↔benzina / diesel↔diesel (never cross fuels).
 '/prezzi-benzina/': '/prezzi-benzina/oggi/',
 '/prezzi-diesel/': '/prezzi-diesel/oggi/',

 // ── SPA-only tab routes that hard-404 at the edge (2026-06-17 Googlebot sweep, #2386/#1823) ──
 // These tabs exist only in the SPA router; no build-plugin emits static HTML for
 // them, so GitHub Pages serves 404.html → hard-404 for crawlers and direct hits.
 // Owner decision: do NOT emit noindex SPA shells — REDIRECT each to the correct
 // EXISTING page that already returns 200 (verified live, all 4 locales). The whole
 // class is swept here (AGENTS.md #6): publish/dashboard/employer → live job board;
 // partner-services (thin utility) → home; press-kit → about. (Newsletter
 // preferences are DELIBERATELY excluded from this sweep — see note below.)
 // NB: the publisher section — publish (/pubblica-offerta/, /en/post-a-job/, …),
 // my-listings (/i-miei-annunci/, …) and for-employers (/per-le-aziende/, …) in
 // all 4 locales — is the ACTIVE monetization funnel (Piano Azienda checkout,
 // dashboard, employer landing). It must NOT be legacy-redirected: those routes
 // are served live by the SPA (services/router.ts). The Cathedral-era redirects
 // to the job board were removed — re-adding them takes the publish form offline.
 // Partner services (thin utility tab) → locale home.
 '/servizi-partner/': '/',
 '/en/partner-services/': '/en/',
 '/de/partner-dienste/': '/de/',
 '/fr/services-partenaires/': '/fr/',
 // Press kit → the about page (same org-info class).
 '/stampa/': '/chi-siamo/',
 '/en/press-kit/': '/en/about-us/',
 '/de/pressekit/': '/de/ueber-uns/',
 '/fr/kit-presse/': '/fr/a-propos/',
 // NB: newsletter preferences (/preferenze-newsletter/ + locale variants) are
 // DELIBERATELY NOT redirected. They render a live, token-gated management page
 // (components/pages/NewsletterPreferences.tsx → SubscriptionPreferencesController)
 // reached from the footer + "manage alerts" links in every newsletter and
 // job-alert email (?email=&token=). Redirecting them to the morning landing
 // broke the entire "manage newsletter / job alerts" funnel (issue #2973): users
 // clicking "Gestisci alert" hit a "Pagina spostata" page instead of their
 // alerts. Like the sibling /email-confirmed/ route, the SPA boots from 404.html
 // and renders the page; it is noindex-by-nature (no public inbound links), so a
 // soft-404 status for cold crawler hits is acceptable.
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
 // Issue #4263 item 4: this plugin has NO `enforce` field, so Vite places it in
 // its 'normal' enforce bucket — BEFORE every `enforce:'post'` plugin regardless
 // of registration line (this file is registered at vite.config.ts:241, between
 // eventsSeoPagesPlugin@235 and cantonOrphanRedirectsPlugin@249, but enforce
 // bucketing, not registration line, decides Rollup dispatch order across
 // buckets). This plugin's own gap-fill above (`fs.existsSync(targetFile)`
 // against eventsSeoPagesPlugin's dist output) assumed the opposite ("runs in
 // closeBundle() AFTER eventsSeoPagesPlugin" — see the comment near
 // isCompatResolvableUnderJobPrefix below), which was false: with no ordering
 // hook, Rollup's closeBundle is async-parallel, so this plugin's existsSync
 // check could race eventsSeoPagesPlugin's write non-deterministically.
 // `order:'post'` moves it into Rollup's later hook-order bucket (after every
 // plain-shorthand closeBundle, i.e. after eventsSeoPagesPlugin and every other
 // producer this depends on); `sequential:true` then makes Rollup await every
 // previously-queued closeBundle promise before invoking this handler. Verified
 // against the installed rollup package that this combination (order+sequential
 // on the CONSUMER only, left off the PRODUCER) is what actually enforces the
 // intended order — mirrors hreflangPostprocessPlugin.ts's pattern.
 closeBundle: {
   order: 'post',
   sequential: true,
   handler: async () => {
 // Prima di qualunque cosa, e prima che la mappa cathedral ci scriva dentro:
 // qui `redirects` e' ancora esattamente il letterale scritto a mano sopra.
 // Due delle sue voci formavano una catena a due hop (issue #5352, review
 // round 3) — un batch successivo aveva ripuntato l'anello di mezzo senza che
 // nessuno tornasse a guardare chi ci puntava dentro. Il canonical del primo
 // bridge finiva su una pagina noindex, che non inoltra il segnale.
 assertNoInternalChains(redirects);

 const distDir = path.resolve(rootDir, 'dist');
 let count = 0;
 let compatCount = 0;
 let cathedralCount = 0;
 // Prefixes routed to a shard this build does not push (see the docblock on
 // unshippableSectionPrefixes). Computed ONCE per build, not per redirect:
 // the flags cannot change mid-closeBundle, and a per-entry read would invite
 // exactly the kind of drift the derived-from-SECTION_ROUTES set avoids.
 const unshippablePrefixes = unshippableSectionPrefixes();
 let skippedUnshippable = 0;
 // `/cerca-lavoro-ticino/azienda-{slug}/` (and per-locale equivalents) is the
 // RESERVED company-hub namespace (see isCompanyHubNamespaceSlug). A job whose
 // OWN slug happens to start with that prefix must not get a cathedral bridge
 // page canonicalizing to its foreign-canton URL there — same invariant as the
 // other 6 call sites fixed for issue #2976 (PR validate-dist-company-hub-namespace-6th-site).
 // Fall back to the Switzerland aggregator canonical; the redirect target/CTA
 // still points at the real page, so UX is unaffected.
 const redirectCanonicalOverride = new Map<string, string>();

 // Build hreflang lookup from sitemaps so legacy pages can point to locale variants
 const hreflangMap = buildHreflangMap(rootDir);

 // ── Phase 8.4 (cathedral) — migration map ──
 // Jobs whose canton !== 'TI' are now emitted at canton-aware URLs
 // (e.g. /cerca-lavoro-zurigo/<slug>/). The pre-cathedral URLs at
 // /cerca-lavoro-ticino/<slug>/ no longer have a backing page, so emit
 // 301-style bridge pages pointing to the new canton section URL.
 // TI jobs are unaffected (byte-identical).
 try {
 const jobs = loadJobsJson<{ canton?: string; location?: string; slug?: string; slugByLocale?: Record<string, string> }>(rootDir);
 const locales: CantonLocale[] = ['it', 'en', 'de', 'fr'];
 const localePrefix: Record<CantonLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
 for (const job of jobs) {
 const canton = resolveJobCanton(job);
 if (canton === 'TI') continue;
 const legacyTI: Record<CantonLocale, string> = {
 it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
 en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
 de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
 fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
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
 if (isCompanyHubNamespaceSlug(slug, locale)) {
 const aggregatorSection = resolveCantonSection(locale, AGGREGATE_KEY);
 const aggregatorPath = `${localePrefix[locale]}/${aggregatorSection}/`.replace(/\/+/g, '/');
 redirectCanonicalOverride.set(from, `${BASE_URL}${aggregatorPath}`);
 }
 }
 }
 }
 } catch (err) {
 console.warn('\x1b[33m[legacy-redirects]\x1b[0m cathedral migration map failed:', err);
 }

 // ── Article rename bridges (issue #5352) ──
 // `data/article-redirects.json` was created in 2026-05-27 for exactly this and
 // then never read by anything, so it stayed `{}` for its whole life. It is
 // read HERE, into the map this plugin already had, rather than by a second
 // redirect mechanism: the bridge page, the noindex+canonical shape, the
 // "never overwrite a page another plugin emitted" rule and the flat `.html`
 // twin below are all already correct, and an article rename needs none of
 // them re-invented — only a data entry point that is not a code edit.
 //
 // NOT wrapped in try/catch, unlike the cathedral block above: that map is
 // derived from live job data and a failure there means "skip an optimization",
 // while this one is hand-authored SEO state where a malformed entry means an
 // indexed URL silently keeps 404ing. The validator throws; the build stops.
 let articleRenameCount = 0;
 {
 const fromFile = loadArticleRedirects(rootDir);
 // `parseArticleRedirects` vieta le catene DENTRO il file dati, ma le due mappe
 // si fondono qui in una sola, e una catena si forma altrettanto bene a cavallo:
 // hardcoded `X → A` + dati `A → B` da' `X → A → B`, con il bridge di mezzo
 // 200 `noindex` — un canonical verso una pagina noindex perde il segnale invece
 // di inoltrarlo. Il confronto include anche la mappa cathedral costruita sopra:
 // per costruzione sono URL di job e non possono collidere con un articolo, ma
 // controllarle costa una passata su una mappa gia' in memoria.
 assertNoCrossSourceChains(redirects, fromFile);
 const existingFrom = new Set(Object.keys(redirects).map(withSlash));
 for (const [from, to] of Object.entries(fromFile)) {
 // A hand-written entry in the literal above wins — it is the older, already
 // deployed declaration. The duplicate is a data bug, not a runtime one, so
 // it is reported here and failed in tests/article-rename-redirects.test.ts
 // rather than throwing mid-build.
 if (existingFrom.has(from)) {
 console.warn(`\x1b[33m[legacy-redirects]\x1b[0m ${ARTICLE_REDIRECTS_FILE}: ${from} e' gia' dichiarata nella mappa hardcoded — voce ignorata`);
 continue;
 }
 redirects[from] = to;
 articleRenameCount++;
 }
 }

 const getHreflangHtml = (targetPath: string): string => {
 const targetUrl = `${BASE_URL}${targetPath}`;
 const entries = hreflangMap.get(targetUrl);
 if (!entries || entries.length === 0) return '';
 return '\n' + hreflangLinksHtml(entries);
 };

 // Auto-redirect users to the canonical target (issue #2996, owner decision):
 // a 0-second meta-refresh lands the visitor on the live page without a manual
 // click, and — combined with the canonical link + noindex already on the page —
 // is treated as a 301-equivalent by crawlers. Same pattern already used by
 // cantonOrphanRedirectsPlugin and cfHot404BridgePlugin (cluster redirects).
 const buildCompatHtml = (from: string, to: string, kind: string) => buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${to}`,
 pathLabel: to,
 title: 'Pagina archiviata | Frontaliere Ticino',
 description: `URL legacy o non piu disponibile collegata a ${to}.`,
 body: `Questa URL ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : 'dell annuncio'} non e piu la versione corretta. Ti stiamo portando alla pagina corretta; se non vieni reindirizzato, aprila qui sotto.`,
 ctaLabel: 'Apri la pagina corretta',
 noindex: true,
 hreflangEntries: hreflangMap.get(`${BASE_URL}${to}`),
 }).replace('</head>', ` <meta http-equiv="refresh" content="0; url=${BASE_URL}${to}">\n </head>`);

 for (const [fromRaw, toRaw] of Object.entries(redirects)) {
 const from = withSlash(fromRaw);
 const to = withSlash(toRaw);
 if (from === to || from === '/') continue;

 // Do not emit a bridge onto a prefix this build cannot ship: the file
 // would be written, deleted by the shard rehydrate, and never served.
 // BEFORE mkdirSync on purpose — emitting nothing must also leave no
 // empty directory behind for a dist-walking audit to trip over.
 if (isUnshippablePath(from, unshippablePrefixes)) { skippedUnshippable++; continue; }

 const outDir = path.join(distDir, from.slice(1));
 fs.mkdirSync(outDir, { recursive: true });
 // Skip if a higher-priority plugin already generated this page (e.g. active job or soft-landing)
 if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
 const fromUrl = `${BASE_URL}${from}`;
 const toUrl = `${BASE_URL}${to}`;
 const hreflangTags = getHreflangHtml(to);
 const redirectLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 name: `Redirect ${from} → ${to}`,
 url: fromUrl,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
 mainEntityOfPage: toUrl,
 description: `Pagina legacy reindirizzata verso ${to}`,
 inLanguage: 'it',
 });
 const html = buildCanonicalBridgePage({
 canonicalUrl: redirectCanonicalOverride.get(fromRaw) ?? `${BASE_URL}${to}`,
 pathLabel: to,
 title: 'Pagina spostata',
 description: 'Questa URL legacy ha una pagina canonica aggiornata su Frontaliere Ticino.',
 body: 'Questa URL legacy punta a una pagina aggiornata. Ti stiamo portando alla destinazione corretta; se non vieni reindirizzato, aprila qui sotto.',
 ctaLabel: 'Apri la pagina corretta',
 noindex: true,
 hreflangEntries: hreflangMap.get(`${BASE_URL}${to}`),
 // Auto-redirect users to the canonical (issue #2996, owner decision): a
 // 0-second meta-refresh is a 301-equivalent for crawlers (with the canonical
 // link + noindex) and an instant redirect for users — no dead-end click.
 // Same pattern as cantonOrphanRedirectsPlugin / cfHot404BridgePlugin.
 }).replace('</head>', ` <meta http-equiv="refresh" content="0; url=${BASE_URL}${to}">\n <script type="application/ld+json">${redirectLd}</script>\n </head>`);

 fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
 // Also write a flat .html twin so GitHub Pages serves it for the extension-less
 // URL too. The SPA auth-action script is stripped from the flat file, but the
 // meta-refresh above is intentionally KEPT so the flat twin redirects as well.
 const flatPath = from.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = path.join(distDir, flatPath.slice(1) + '.html');
 fs.mkdirSync(path.dirname(flatFile), { recursive: true });
 const flatHtml = html.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 fs.writeFileSync(flatFile, flatHtml, 'utf-8');
 }
 count++;
 }

 // Sharded accumulator (issue #2988): read the union via the store helper.
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
 // Search-combo slugs and out-of-range pagination leaves are job-section-prefixed
 // (e.g. /cerca-lavoro-svizzera/ricerca-fondo-arbon/) but NEITHER is handled by
 // jobsSeoPagesPlugin or seoHubsPlugin: jobsSeoPagesPlugin explicitly excludes
 // searchComboPattern from its own tracking, and out-of-range individual pagination
 // leaves (a canton's page count shrinking build-over-build) get no bridge from
 // seoHubsPlugin either. Without this exemption isJobPath's skip below makes this
 // resolver's correct handling for both shapes permanently dead code, and the URL
 // is left unresolvable (real 404) — see build-plugins/searchConsoleCompat.ts.
 const isCompatResolvableUnderJobPrefix = (p: string): boolean =>
 SEARCH_COMBO_SEGMENT_PATTERN.test(p) || JOB_BOARD_PAGINATION_PATTERN.test(p);
 let skippedJobPaths = 0;
 {
 const compatPaths = readCompatPaths(rootDir).paths;
 for (const compatPathRaw of compatPaths) {
 const resolution = resolveSearchConsoleCompatTarget(String(compatPathRaw || ''));
 if (!resolution) continue;
 const from = normalize(String(compatPathRaw || ''));
 // Target-existence gap-fill (PR #4252 review): a self-mapped target is not always
 // unconditionally emitted (e.g. an events canton hub only exists when that canton
 // has an upcoming event THIS build — see fallbackPath doc in searchConsoleCompat.ts).
 // This plugin's closeBundle runs AFTER eventsSeoPagesPlugin's, guaranteed by the
 // `order:'post'` + `sequential:true` on the closeBundle hook above (issue #4263
 // item 4) — registration line order in vite.config.ts alone does NOT guarantee
 // this (Rollup's closeBundle is async-parallel by default), so distDir reliably
 // reflects this build's real output only because of that hook config — verify
 // before redirecting there, falling back to the resolver-provided fallbackPath (the
 // Swiss-wide events index, unconditionally emitted whenever any event exists) rather
 // than pointing a bridge page at another 404. Must run BEFORE the self-reference
 // check below, mirroring cfHot404BridgePlugin.ts's identical gap-fill: an unresolved
 // fallback can otherwise land back on `from` itself.
 // Trailing slash on `to` is wrapped with withSlash() right at assignment (not just
 // ad-hoc at the existence-check callsite) — issue #4263 item 3: EVENTS_SECTION_PATTERN's
 // match[0] happens to always include the trailing slash by regex construction today,
 // but `to` is also consumed unwrapped further below (buildCompatHtml's canonicalUrl/
 // pathLabel), so relying on that structural coincidence instead of guaranteeing it here
 // is fragile to a future resolver change. Mirrors cfHot404BridgePlugin.ts's own
 // `let to = withSlash(resolution.canonicalPath);` for the exact same consumption.
 let to = withSlash(resolution.canonicalPath);
 if (resolution.fallbackPath) {
 const targetFile = path.join(distDir, to.slice(1), 'index.html');
 if (!fs.existsSync(targetFile)) {
 to = withSlash(resolution.fallbackPath);
 // The fallback itself is not unconditionally emitted either (e.g. the
 // Swiss-wide events index is skipped when zero events exist sitewide
 // this build, not just for one canton) — verify it too, otherwise this
 // bridges to another 404 (review finding on PR #4252's re-review round).
 const fallbackFile = path.join(distDir, to.slice(1), 'index.html');
 if (!fs.existsSync(fallbackFile)) continue;
 }
 }
 // Skip self-references (normalize strips trailing slash, canonicalPath may have it)
 const fromNorm = from.replace(/\/+$/, '');
 const toNorm = to.replace(/\/+$/, '');
 if (from === '/' || fromNorm === toNorm) continue;
 // Skip job paths — handled by jobsSeoPagesPlugin with enriched content, EXCEPT
 // search-combo/pagination shapes which no plugin ever bridges (see comment above).
 if (isJobPath(from) && !isCompatResolvableUnderJobPrefix(from)) { skippedJobPaths++; continue; }
 // Same unshippable-prefix gate as the static table above. The compat store
 // is fed by Search Console, which reports the article URLs too, so this
 // loop can land on the article sections exactly like the static map can.
 if (isUnshippablePath(from, unshippablePrefixes)) { skippedUnshippable++; continue; }
 const outDir = path.join(distDir, from.slice(1));
 fs.mkdirSync(outDir, { recursive: true });
 // Skip if a higher-priority plugin (e.g. soft-landing pages) already generated this page
 if (fs.existsSync(path.join(outDir, 'index.html'))) continue;
 const html = buildCompatHtml(from, to, resolution.kind);
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
 console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${count} legacy redirect pages${cathedralCount > 0 ? ` (incl. ${cathedralCount} cathedral migration entries: TI-legacy URL → canton URL for jobs whose canton !== 'TI')` : ''}${articleRenameCount > 0 ? ` (incl. ${articleRenameCount} article rename bridges from ${ARTICLE_REDIRECTS_FILE})` : ''}`);
 }
 if (compatCount > 0) {
 console.log(`\x1b[36m[legacy-redirects]\x1b[0m Generated ${compatCount} Search Console compatibility pages${skippedJobPaths > 0 ? ` (skipped ${skippedJobPaths} job paths → handled by jobs plugin)` : ''}`);
 }
 // Always logged when it fires, never silently: a bridge that is not emitted
 // is a redirect that does not exist, and the table still lists it. #5327 is
 // the whole reason this line is here rather than an unremarked `continue`.
 if (skippedUnshippable > 0) {
 console.log(
 `\x1b[33m[legacy-redirects]\x1b[0m Skipped ${skippedUnshippable} bridge page(s) under BUILD_EMIT_SKIP section prefixes (${unshippablePrefixes.join(', ')}) — this build does not push those shards, so an emitted bridge there is never served. The table entries stay; only the emission is skipped.`,
 );
 }
   },
 },
 };
}
