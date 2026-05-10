/**
 * Internationalized Path-based Router Service (SEO-friendly)
 *
 * Uses clean URLs with history.pushState for proper SEO indexing.
 * URLs change based on the active locale (it / en / de / fr).
 * GitHub Pages SPA support via 404.html redirect.
 *
 * Navigation structure (Proposal H):
 * CALCOLATORE (8) — fiscal simulator, what-if, payslip, RAL, bonus, parental, residency, salary-quiz
 * CONFRONTI (8) — exchange, banks, health, mobile, shopping, cost-of-living, jobs, renovation
 * FISCO (7) — tax-return, calendar, holidays, ristorni, pension, pillar3, quiz
 * GUIDA (8) — first-day, permits, border/traffic, unemployment, car-transfer, car-cost, permit G vs B, border-map
 * VITA (8) — living-ch, living-it, companies, schools, nursery, places, transport, municipalities
 * STATISTICHE (6) — overview, livability, jobs-observatory, salary-compare, traffic-history
 */

import { getLocale, type Locale } from './i18n';
import {
 CITY_HUB_KEYS,
 CITY_HUB_DISPLAY_NAME,
 CITY_HUB_SLUG,
 type CityHubKey,
} from '../build-plugins/cityJobsHub';
import {
 SECTOR_HUB_KEYS,
 SECTOR_HUB_SLUG,
 type SectorHubKey,
} from '../build-plugins/jobSectorLanding';
import {
 buildJobCareVariantLandingModel,
 buildJobLocationLandingModel,
 buildJobLocationSectorLandingModel,
 buildJobLocationTypeLandingModel,
 buildJobNursesHubLandingModel,
 buildJobOfficialGazetteLandingModel,
 buildJobPartTimeLandingModel,
 buildJobSectorRegionLandingModel,
 buildJobTodayLandingModel,
 resolveEditorialJobLandingDescriptor,
} from '../build-plugins/jobEditorialLanding';
import { JOB_RECENCY_LANDING_SLUGS as RECENCY_LANDING_SLUGS } from '../build-plugins/jobRecencyLanding';
import { FUEL_DAILY_ROUTES, isFuelDailyPath } from '../build-plugins/fuelDailyData';
import { HEALTH_PREMIUMS_ROUTES, isHealthPremiumsPath } from '../build-plugins/healthPremiumsData';
import { JOB_MARKET_SNAPSHOT_ROUTES, isJobMarketSnapshotPath } from '../build-plugins/jobMarketSnapshotData';
import { parseOrphanLandingPath as ORPHAN_LANDING_ROUTES } from '../build-plugins/orphanQueryData';
import { WEEKLY_EMPLOYERS_ROUTES, parseCompanyCityPath, parseWeeklyEmployersPath, parseWeeklyEmployersTopHubPath } from '../build-plugins/weeklyEmployersData';
import { BORDER_WAIT_ROUTES, isBorderWaitPath, parseBorderWaitPath } from '../build-plugins/borderWaitData';
import { NURSING_LANDING_ROUTES, isNursingLandingPath, parseNursingLandingPath } from '../build-plugins/nursingLandingsData';
import { CAREER_LANDING_ROUTES, isCareerLandingPath, parseCareerLandingPath } from '../build-plugins/careerLandingsData';
import { PROFESSION_LANDING_ROUTES, isProfessionLandingPath, parseProfessionLandingPath } from '../build-plugins/professionLandingsData';
import {
  COST_OF_LIVING_LANDING_ROUTES,
  isCostOfLivingLandingPath,
  parseCostOfLivingLandingPath,
} from '../build-plugins/costOfLivingLandingsData';
import {
  COMPARISONS_HUB_ROUTES,
  isComparisonsHubPath,
  parseComparisonsHubPath,
} from '../build-plugins/comparisonsHubData';
import {
  FAQ_HUB_ROUTES,
  isFaqHubPath,
  parseFaqHubPath,
} from '../data/faq-hub/routes';
import { isSeoHubPath, localeFromHubPath } from '../build-plugins/seoHubsData';

// ── Workstream C SemRush landings ────────────────────────────
// Five static-HTML-only long-tail SEO pages (Workstream C of the SemRush
// growth plan). Canonical paths live under the existing Guida / Vita in
// Ticino sections but there is no SPA sub-tab for each: they are deep-link
// landing pages. Declared here so the URL parser can return a staticOverlay
// route and prevent the SPA from rewriting the URL or replacing the static
// content with a generic sub-tab view. Mirrors the SEO_METADATA canonicalPath.
const SEMRUSH_LANDINGS: ReadonlyArray<{ key: string; path: string; tab: 'guida' | 'vita' }> = [
  { key: 'tassa-salute-frontalieri', path: '/guida-frontaliere/tassa-salute-frontalieri/', tab: 'guida' },
  { key: 'lamal-frontalieri', path: '/guida-frontaliere/lamal-frontalieri/', tab: 'guida' },
  { key: 'outlet-fox-town-mendrisio', path: '/vita-in-ticino/outlet-svizzera-fox-town-mendrisio/', tab: 'vita' },
  { key: 'ponti-2026-ticino', path: '/vita-in-ticino/ponti-2026-ticino/', tab: 'vita' },
  { key: 'vacanze-scolastiche-ticino-2026', path: '/vita-in-ticino/vacanze-scolastiche-ticino-2026/', tab: 'vita' },
];
const SEMRUSH_LANDING_ROUTES = new Set(SEMRUSH_LANDINGS.map((l) => l.path));

// ── Static-overlay SEO pages (annual/market reports, border-wait map, salary-hub
//    evergreen articles). All emitted via `buildSeoPageHtml` with
//    `seoContentOutsideRoot: true`, so the SPA must NOT replace them on hydrate.
//    Listing the full URL set here lets parsePath flag them with
//    `staticOverlay: true` (mirrors fuel-daily / health-premiums pattern).
const ANNUAL_REPORT_PATHS = new Set([
  '/report/frontalieri-2026/',
  '/en/report/cross-border-workers-2026/',
  '/de/report/grenzgaenger-2026/',
  '/fr/report/frontaliers-2026/',
]);

const MARKET_REPORT_PATHS = new Set([
  '/reports/mercato-lavoro-frontalieri-ticino-2026/',
  '/en/reports/ticino-cross-border-job-market-2026/',
  '/de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026/',
  '/fr/reports/marche-emploi-frontaliers-tessin-2026/',
]);

const BORDER_WAIT_MAP_PATHS = new Set([
  '/guida-frontaliere/mappa-live-valichi/',
  '/en/cross-border-guide/live-border-crossings-map/',
  '/de/grenzgaenger-ratgeber/live-grenzuebergaenge-karte/',
  '/fr/guide-frontalier/carte-live-passages-frontaliers/',
]);

// FR-only salary calculator landing emitted by frSalaireNetLandingPlugin.
// Source of truth: build-plugins/frSalaireNetLandingPlugin.ts URL_PATH.
// The page is statically generated with `seoContentOutsideRoot: true`;
// without staticOverlay the SPA falls into the calculator default sub-tab
// and replaces the bespoke landing body with the generic calculator UI.
const FR_SALAIRE_NET_PATHS = new Set([
  '/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/',
]);

// 8 evergreen salary-hub articles × 4 locales = 32 URLs.
// Source of truth: build-plugins/salaryHubArticles.ts EVERGREEN_ARTICLES[].slugs.
// If the build adds/renames an article, add/rename the path here too — there's
// a regression test (tests/router.test.ts) that round-trips parsePath against
// every static-overlay route.
const SALARY_HUB_ARTICLE_PATHS = new Set([
  // IT — /guida-frontaliere/{slug}/
  '/guida-frontaliere/guida-completa-calcolo-stipendio-frontaliere-2026/',
  '/guida-frontaliere/nuovo-vs-vecchio-frontaliere-differenze-fiscali/',
  '/guida-frontaliere/imposta-alla-fonte-ticino-tabelle-a-b-c-h/',
  '/guida-frontaliere/quanto-incidono-figli-stipendio-netto-frontaliere/',
  '/guida-frontaliere/frontaliere-entro-o-oltre-20km-cosa-cambia/',
  '/guida-frontaliere/da-50000-a-150000-chf-come-cambia-netto-frontaliere/',
  '/guida-frontaliere/sposato-o-single-impatto-tasse-frontaliere/',
  '/guida-frontaliere/costo-nascosto-cambio-chf-eur-stipendio-netto/',
  // EN — /en/cross-border-guide/{slug}/
  '/en/cross-border-guide/complete-guide-crossborder-salary-calculation-2026/',
  '/en/cross-border-guide/new-vs-old-crossborder-worker-tax-differences/',
  '/en/cross-border-guide/withholding-tax-ticino-tables-a-b-c-h/',
  '/en/cross-border-guide/how-children-affect-crossborder-worker-net-salary/',
  '/en/cross-border-guide/crossborder-within-or-over-20km-what-changes/',
  '/en/cross-border-guide/from-50000-to-150000-chf-how-net-changes-crossborder/',
  '/en/cross-border-guide/married-or-single-impact-on-crossborder-taxes/',
  '/en/cross-border-guide/hidden-cost-chf-eur-exchange-net-salary/',
  // DE — /de/grenzgaenger-ratgeber/{slug}/
  '/de/grenzgaenger-ratgeber/kompletter-leitfaden-gehaltsberechnung-grenzgaenger-2026/',
  '/de/grenzgaenger-ratgeber/neuer-vs-alter-grenzgaenger-steuerliche-unterschiede/',
  '/de/grenzgaenger-ratgeber/quellensteuer-tessin-tabellen-a-b-c-h/',
  '/de/grenzgaenger-ratgeber/wie-kinder-nettogehalt-grenzgaenger-beeinflussen/',
  '/de/grenzgaenger-ratgeber/grenzgaenger-innerhalb-oder-ueber-20km-was-aendert-sich/',
  '/de/grenzgaenger-ratgeber/von-50000-bis-150000-chf-wie-sich-netto-aendert-grenzgaenger/',
  '/de/grenzgaenger-ratgeber/verheiratet-oder-ledig-auswirkung-steuern-grenzgaenger/',
  '/de/grenzgaenger-ratgeber/versteckte-kosten-chf-eur-wechselkurs-nettogehalt/',
  // FR — /fr/guide-frontalier/{slug}/
  '/fr/guide-frontalier/guide-complet-calcul-salaire-frontalier-2026/',
  '/fr/guide-frontalier/nouveau-vs-ancien-frontalier-differences-fiscales/',
  '/fr/guide-frontalier/impot-source-tessin-baremes-a-b-c-h/',
  '/fr/guide-frontalier/impact-enfants-salaire-net-frontalier/',
  '/fr/guide-frontalier/frontalier-moins-ou-plus-20km-ce-qui-change/',
  '/fr/guide-frontalier/de-50000-a-150000-chf-comment-le-net-change-frontalier/',
  '/fr/guide-frontalier/marie-ou-celibataire-impact-impots-frontalier/',
  '/fr/guide-frontalier/cout-cache-change-chf-eur-salaire-net/',
]);

// ── Route types ──────────────────────────────────────────────

export type ActiveTab = 'calculator' | 'confronti' | 'fisco' | 'guida' | 'vita' | 'stats' | 'feedback' | 'privacy' | 'terms' | 'data-deletion' | 'api-status' | 'gamification' | 'forum' | 'contact' | 'partners' | 'consulting' | 'press-kit' | 'job-board' | 'profile' | 'morning' | 'blog' | 'admin' | 'glossario' | 'faq' | 'sitemap' | 'dialetto' | 'contracts' | 'tfr-calculator' | 'permit-quiz' | 'tredicesima' | 'weekly-digest' | 'tool-of-week' | 'email-confirmed' | 'newsletter-preferences' | 'sindacati' | 'chi-siamo' | 'correzioni' | 'metodologia' | 'tassazione-hub' | 'autore';

export type CalcolatoreSubTab = 'calculator' | 'whatif' | 'payslip' | 'ral' | 'bonus' | 'parental-leave' | 'residency' | 'salary-quiz';
export type ConfrontiSubTab = 'exchange' | 'banks' | 'health' | 'mobile' | 'shopping' | 'cost-of-living' | 'jobs' | 'renovation';
export type FiscoSubTab = 'tax-return' | 'calendar' | 'holidays' | 'ristorni' | 'pension' | 'pillar3' | 'quiz' | 'tax-credit' | 'withholding-rates' | 'new-frontier-tax-sim';
export type GuidaSubTab = 'first-day' | 'permits' | 'border' | 'unemployment' | 'car-transfer' | 'car-cost' | 'permit-compare' | 'border-map';
export type VitaSubTab = 'living-ch' | 'living-it' | 'companies' | 'schools' | 'nursery' | 'places' | 'transport' | 'municipalities';
export type StatsSubTab = 'overview' | 'livability' | 'jobs-observatory' | 'salary-compare' | 'traffic-history' | 'unemployment' | 'mortgage' | 'fuel-prices' | 'health-premiums';

// ── Border crossing deep links (indexable URLs) ─────────────

export const ALL_BORDER_CROSSING_IDS = [
 'chiasso-centro',
 'chiasso-brogeda',
 'chiasso-strada',
 'maslianico-pizzamiglio',
 'maslianico-roggiana',
 'bizzarone-novazzano',
 'ronago-novazzano',
 'crociale-dei-mulini',
 'drezzo-pedrinate',
 'lanzo-d-intelvi-arogno',
 'campione-d-italia-bissone',
 'oria-gandria',
 'gaggiolo',
 'san-pietro',
 'clivio-ligornetto',
 'rodero-stabio',
 'saltrio-arzo',
 'ponte-tresa',
 'porto-ceresio-brusino',
 'cremenaga-ponte-cremenaga',
 'luino-fornasette',
 'zenna-dirinella',
 'biegno-indemini',
 'dumenza-cassinone',
] as const;

export type BorderCrossingId = (typeof ALL_BORDER_CROSSING_IDS)[number];

const BORDER_CROSSING_ID_SET = new Set<string>(ALL_BORDER_CROSSING_IDS as readonly string[]);

// ── SEO landing routes (long-tail) ──────────────────────────

export type SeoLandingId =
 | 'salary-40000'
 | 'salary-60000'
 | 'salary-80000'
 | 'salary-100000'
 | 'salary-120000'
 | 'salary-60000-old'
 | 'salary-60000-new'
 | 'salary-80000-old'
 | 'salary-80000-new'
 | 'salary-100000-old'
 | 'salary-100000-new'
 | 'salary-60000-married-2kids'
 | 'salary-80000-married-2kids'
 | 'salary-100000-married-2kids'
 | 'salary-80000-over20km'
 | 'salary-80000-within20km'
 | 'salary-60000-over20km'
 | 'salary-60000-within20km'
 | 'salary-100000-over20km'
 | 'salary-100000-within20km'
 | 'new-frontier-over20km'
 | 'net-comparison-2025-2026-within20km'
 | 'net-comparison-g-vs-b-within20km'
 | 'net-comparison-2025-2026-over20km'
 | 'net-comparison-g-vs-b-over20km';

export const ALL_SEO_LANDING_IDS: SeoLandingId[] = [
 'salary-40000',
 'salary-60000',
 'salary-80000',
 'salary-100000',
 'salary-120000',
 'salary-60000-old',
 'salary-60000-new',
 'salary-80000-old',
 'salary-80000-new',
 'salary-100000-old',
 'salary-100000-new',
 'salary-60000-married-2kids',
 'salary-80000-married-2kids',
 'salary-100000-married-2kids',
 'salary-80000-over20km',
 'salary-80000-within20km',
 'salary-60000-over20km',
 'salary-60000-within20km',
 'salary-100000-over20km',
 'salary-100000-within20km',
 'new-frontier-over20km',
 'net-comparison-2025-2026-within20km',
 'net-comparison-g-vs-b-within20km',
 'net-comparison-2025-2026-over20km',
 'net-comparison-g-vs-b-over20km',
];

const SEO_LANDING_SLUGS: Record<Locale, Record<SeoLandingId, string>> = {
 it: {
 'salary-40000': 'stipendio-netto-40000-chf',
 'salary-60000': 'stipendio-netto-60000-chf',
 'salary-80000': 'stipendio-netto-80000-chf',
 'salary-100000': 'stipendio-netto-100000-chf',
 'salary-120000': 'stipendio-netto-120000-chf',
 'salary-60000-old': 'stipendio-netto-60000-chf-vecchio-frontaliere',
 'salary-60000-new': 'stipendio-netto-60000-chf-nuovo-frontaliere-2026',
 'salary-80000-old': 'stipendio-netto-80000-chf-vecchio-frontaliere',
 'salary-80000-new': 'stipendio-netto-80000-chf-nuovo-frontaliere-2026',
 'salary-100000-old': 'stipendio-netto-100000-chf-vecchio-frontaliere',
 'salary-100000-new': 'stipendio-netto-100000-chf-nuovo-frontaliere-2026',
 'salary-60000-married-2kids': 'stipendio-netto-60000-chf-sposato-2-figli',
 'salary-80000-married-2kids': 'stipendio-netto-80000-chf-sposato-2-figli',
 'salary-100000-married-2kids': 'stipendio-netto-100000-chf-sposato-2-figli',
 'salary-80000-over20km': 'stipendio-netto-80000-chf-residenza-oltre-20km',
 'salary-80000-within20km': 'stipendio-netto-80000-chf-residenza-entro-20km',
 'salary-60000-over20km': 'stipendio-netto-60000-chf-residenza-oltre-20km',
 'salary-60000-within20km': 'stipendio-netto-60000-chf-residenza-entro-20km',
 'salary-100000-over20km': 'stipendio-netto-100000-chf-residenza-oltre-20km',
 'salary-100000-within20km': 'stipendio-netto-100000-chf-residenza-entro-20km',
 'new-frontier-over20km': 'nuovi-frontalieri-oltre-20-km',
 'net-comparison-2025-2026-within20km': 'confronto-netto-2025-2026-entro-20km',
 'net-comparison-g-vs-b-within20km': 'confronto-permesso-g-vs-b-entro-20km',
 'net-comparison-2025-2026-over20km': 'confronto-netto-2025-2026-oltre-20km',
 'net-comparison-g-vs-b-over20km': 'confronto-permesso-g-vs-b-oltre-20km',
 },
 en: {
 'salary-40000': 'net-salary-40000-chf',
 'salary-60000': 'net-salary-60000-chf',
 'salary-80000': 'net-salary-80000-chf',
 'salary-100000': 'net-salary-100000-chf',
 'salary-120000': 'net-salary-120000-chf',
 'salary-60000-old': 'net-salary-60000-chf-old-cross-border-worker',
 'salary-60000-new': 'net-salary-60000-chf-new-cross-border-worker-2026',
 'salary-80000-old': 'net-salary-80000-chf-old-cross-border-worker',
 'salary-80000-new': 'net-salary-80000-chf-new-cross-border-worker-2026',
 'salary-100000-old': 'net-salary-100000-chf-old-cross-border-worker',
 'salary-100000-new': 'net-salary-100000-chf-new-cross-border-worker-2026',
 'salary-60000-married-2kids': 'net-salary-60000-chf-married-2-children',
 'salary-80000-married-2kids': 'net-salary-80000-chf-married-2-children',
 'salary-100000-married-2kids': 'net-salary-100000-chf-married-2-children',
 'salary-80000-over20km': 'net-salary-80000-chf-residence-over-20km',
 'salary-80000-within20km': 'net-salary-80000-chf-residence-within-20km',
 'salary-60000-over20km': 'net-salary-60000-chf-residence-over-20km',
 'salary-60000-within20km': 'net-salary-60000-chf-residence-within-20km',
 'salary-100000-over20km': 'net-salary-100000-chf-residence-over-20km',
 'salary-100000-within20km': 'net-salary-100000-chf-residence-within-20km',
 'new-frontier-over20km': 'new-cross-border-workers-over-20km',
 'net-comparison-2025-2026-within20km': 'net-comparison-2025-2026-within-20km',
 'net-comparison-g-vs-b-within20km': 'permit-g-vs-b-comparison-within-20km',
 'net-comparison-2025-2026-over20km': 'net-comparison-2025-2026-over-20km',
 'net-comparison-g-vs-b-over20km': 'permit-g-vs-b-comparison-over-20km',
 },
 de: {
 'salary-40000': 'nettogehalt-40000-chf',
 'salary-60000': 'nettogehalt-60000-chf',
 'salary-80000': 'nettogehalt-80000-chf',
 'salary-100000': 'nettogehalt-100000-chf',
 'salary-120000': 'nettogehalt-120000-chf',
 'salary-60000-old': 'nettogehalt-60000-chf-alter-grenzgaenger',
 'salary-60000-new': 'nettogehalt-60000-chf-neuer-grenzgaenger-2026',
 'salary-80000-old': 'nettogehalt-80000-chf-alter-grenzgaenger',
 'salary-80000-new': 'nettogehalt-80000-chf-neuer-grenzgaenger-2026',
 'salary-100000-old': 'nettogehalt-100000-chf-alter-grenzgaenger',
 'salary-100000-new': 'nettogehalt-100000-chf-neuer-grenzgaenger-2026',
 'salary-60000-married-2kids': 'nettogehalt-60000-chf-verheiratet-2-kinder',
 'salary-80000-married-2kids': 'nettogehalt-80000-chf-verheiratet-2-kinder',
 'salary-100000-married-2kids': 'nettogehalt-100000-chf-verheiratet-2-kinder',
 'salary-80000-over20km': 'nettogehalt-80000-chf-wohnsitz-ueber-20km',
 'salary-80000-within20km': 'nettogehalt-80000-chf-wohnsitz-bis-20km',
 'salary-60000-over20km': 'nettogehalt-60000-chf-wohnsitz-ueber-20km',
 'salary-60000-within20km': 'nettogehalt-60000-chf-wohnsitz-bis-20km',
 'salary-100000-over20km': 'nettogehalt-100000-chf-wohnsitz-ueber-20km',
 'salary-100000-within20km': 'nettogehalt-100000-chf-wohnsitz-bis-20km',
 'new-frontier-over20km': 'neue-grenzgaenger-ueber-20-km',
 'net-comparison-2025-2026-within20km': 'nettovergleich-2025-2026-bis-20km',
 'net-comparison-g-vs-b-within20km': 'vergleich-bewilligung-g-vs-b-bis-20km',
 'net-comparison-2025-2026-over20km': 'nettovergleich-2025-2026-ueber-20km',
 'net-comparison-g-vs-b-over20km': 'vergleich-bewilligung-g-vs-b-ueber-20km',
 },
 fr: {
 'salary-40000': 'salaire-net-40000-chf',
 'salary-60000': 'salaire-net-60000-chf',
 'salary-80000': 'salaire-net-80000-chf',
 'salary-100000': 'salaire-net-100000-chf',
 'salary-120000': 'salaire-net-120000-chf',
 'salary-60000-old': 'salaire-net-60000-chf-ancien-frontalier',
 'salary-60000-new': 'salaire-net-60000-chf-nouveau-frontalier-2026',
 'salary-80000-old': 'salaire-net-80000-chf-ancien-frontalier',
 'salary-80000-new': 'salaire-net-80000-chf-nouveau-frontalier-2026',
 'salary-100000-old': 'salaire-net-100000-chf-ancien-frontalier',
 'salary-100000-new': 'salaire-net-100000-chf-nouveau-frontalier-2026',
 'salary-60000-married-2kids': 'salaire-net-60000-chf-marie-2-enfants',
 'salary-80000-married-2kids': 'salaire-net-80000-chf-marie-2-enfants',
 'salary-100000-married-2kids': 'salaire-net-100000-chf-marie-2-enfants',
 'salary-80000-over20km': 'salaire-net-80000-chf-residence-plus-20km',
 'salary-80000-within20km': 'salaire-net-80000-chf-residence-moins-20km',
 'salary-60000-over20km': 'salaire-net-60000-chf-residence-plus-20km',
 'salary-60000-within20km': 'salaire-net-60000-chf-residence-moins-20km',
 'salary-100000-over20km': 'salaire-net-100000-chf-residence-plus-20km',
 'salary-100000-within20km': 'salaire-net-100000-chf-residence-moins-20km',
 'new-frontier-over20km': 'nouveaux-frontaliers-plus-20-km',
 'net-comparison-2025-2026-within20km': 'comparaison-net-2025-2026-moins-20km',
 'net-comparison-g-vs-b-within20km': 'comparaison-permis-g-vs-b-moins-20km',
 'net-comparison-2025-2026-over20km': 'comparaison-net-2025-2026-plus-20km',
 'net-comparison-g-vs-b-over20km': 'comparaison-permis-g-vs-b-plus-20km',
 },
};

const SEO_LANDING_REVERSE: Record<Locale, Record<string, SeoLandingId>> = {
 it: Object.fromEntries(Object.entries(SEO_LANDING_SLUGS.it).map(([k, v]) => [v, k as SeoLandingId])) as Record<string, SeoLandingId>,
 en: Object.fromEntries(Object.entries(SEO_LANDING_SLUGS.en).map(([k, v]) => [v, k as SeoLandingId])) as Record<string, SeoLandingId>,
 de: Object.fromEntries(Object.entries(SEO_LANDING_SLUGS.de).map(([k, v]) => [v, k as SeoLandingId])) as Record<string, SeoLandingId>,
 fr: Object.fromEntries(Object.entries(SEO_LANDING_SLUGS.fr).map(([k, v]) => [v, k as SeoLandingId])) as Record<string, SeoLandingId>,
};

// ── Salary Hub pattern detection (programmatic SEO pages) ─────
const SALARY_HUB_PATTERNS = [
 /^stipendio-netto-\d+-chf/,   // IT
 /^net-salary-\d+-chf/,        // EN
 /^nettogehalt-\d+-chf/,       // DE
 /^salaire-net-\d+-chf/,       // FR
];
function isSalaryHubSlug(slug: string): boolean {
 return SALARY_HUB_PATTERNS.some(rx => rx.test(slug));
}

// ── Glossary term deep links (indexable URLs) ───────────────

export type GlossaryTermId =
 | 'impostaAllaFonte'
 | 'irpef'
 | 'franchigia'
 | 'ristorni'
 | 'doppiaimposizione'
 | 'addizionaleRegionale'
 | 'addizionaleComunale'
 | 'deduzioni'
 | 'lohnausweis'
 | 'cu'
 | 'ral'
 | 'modello730'
 | 'redditiPF'
 | 'avs'
 | 'lpp'
 | 'terzoPilastro'
 | 'rendita'
 | 'capitaleLPP'
 | 'prestazioneLiberoPassaggio'
 | 'lamal'
 | 'cmu'
 | 'ssn'
 | 'franchigia_assicurativa'
 | 'modelliAssicurativi'
 | 'ainp'
 | 'permessoG'
 | 'permessoB'
 | 'permessoC'
 | 'permessoL'
 | 'accordoFrontalieri'
 | 'nuovoAccordo2024'
 | 'tassoCambio'
 | 'multiValuta'
 | 'bonifico'
 | 'sepa'
 | 'ccnl'
 | 'ipg'
 | 'ac'
 | 'naspi'
 | 'assegniFamiliari'
 | 'tredicesima';

export const ALL_GLOSSARY_TERM_IDS: GlossaryTermId[] = [
 'impostaAllaFonte',
 'irpef',
 'franchigia',
 'ristorni',
 'doppiaimposizione',
 'addizionaleRegionale',
 'addizionaleComunale',
 'deduzioni',
 'lohnausweis',
 'cu',
 'ral',
 'modello730',
 'redditiPF',
 'lamal',
 'cmu',
 'ssn',
 'franchigia_assicurativa',
 'modelliAssicurativi',
 'ainp',
 'permessoG',
 'permessoB',
 'permessoC',
 'permessoL',
 'accordoFrontalieri',
 'nuovoAccordo2024',
 'avs',
 'lpp',
 'terzoPilastro',
 'tassoCambio',
 'rendita',
 'capitaleLPP',
 'prestazioneLiberoPassaggio',
 'multiValuta',
 'bonifico',
 'sepa',
 'ccnl',
 'ipg',
 'ac',
 'naspi',
 'assegniFamiliari',
 'tredicesima',
];

function defaultGlossaryTermSlug(termId: GlossaryTermId): string {
 return termId
 .replace(/_/g, '-')
 .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
 .replace(/([a-zA-Z])(\d)/g, '$1-$2')
 .replace(/(\d)([a-zA-Z])/g, '$1-$2')
 .toLowerCase()
 .replace(/-+/g, '-')
 .replace(/^-|-$/g, '');
}

const GLOSSARY_TERM_SLUG_OVERRIDES: Record<Locale, Partial<Record<GlossaryTermId, string>>> = {
 it: {
 impostaAllaFonte: 'imposta-alla-fonte',
 terzoPilastro: 'terzo-pilastro',
 tassoCambio: 'tasso-di-cambio',
 permessoG: 'permesso-g',
 permessoB: 'permesso-b',
 },
 en: {
 impostaAllaFonte: 'withholding-tax',
 franchigia: 'tax-allowance',
 ristorni: 'tax-refunds',
 permessoG: 'permit-g',
 permessoB: 'permit-b',
 terzoPilastro: 'third-pillar',
 tassoCambio: 'exchange-rate',
 },
 de: {
 impostaAllaFonte: 'quellensteuer',
 franchigia: 'steuerfreibetrag',
 ristorni: 'rueckerstattungen',
 permessoG: 'bewilligung-g',
 permessoB: 'bewilligung-b',
 terzoPilastro: 'dritte-saeule',
 tassoCambio: 'wechselkurs',
 },
 fr: {
 impostaAllaFonte: 'impot-a-la-source',
 franchigia: 'franchise-fiscale',
 ristorni: 'ristournes',
 permessoG: 'permis-g',
 permessoB: 'permis-b',
 terzoPilastro: 'troisieme-pilier',
 tassoCambio: 'taux-de-change',
 },
};

const GLOSSARY_TERM_SLUGS: Record<Locale, Record<GlossaryTermId, string>> = (['it', 'en', 'de', 'fr'] as const).reduce(
 (acc, locale) => {
 const overrides = GLOSSARY_TERM_SLUG_OVERRIDES[locale];
 const table = Object.fromEntries(
 ALL_GLOSSARY_TERM_IDS.map((termId) => [termId, overrides?.[termId] || defaultGlossaryTermSlug(termId)])
 ) as Record<GlossaryTermId, string>;
 acc[locale] = table;
 return acc;
 },
 {} as Record<Locale, Record<GlossaryTermId, string>>
);

const GLOSSARY_TERM_REVERSE: Record<Locale, Record<string, GlossaryTermId>> = {
 it: Object.fromEntries(Object.entries(GLOSSARY_TERM_SLUGS.it).map(([k, v]) => [v, k as GlossaryTermId])) as Record<string, GlossaryTermId>,
 en: Object.fromEntries(Object.entries(GLOSSARY_TERM_SLUGS.en).map(([k, v]) => [v, k as GlossaryTermId])) as Record<string, GlossaryTermId>,
 de: Object.fromEntries(Object.entries(GLOSSARY_TERM_SLUGS.de).map(([k, v]) => [v, k as GlossaryTermId])) as Record<string, GlossaryTermId>,
 fr: Object.fromEntries(Object.entries(GLOSSARY_TERM_SLUGS.fr).map(([k, v]) => [v, k as GlossaryTermId])) as Record<string, GlossaryTermId>,
};

/** All navigable tabs that should appear in SiteSearch */
export const ALL_NAVIGABLE_TABS: string[] = ['calculator', 'feedback', 'stats', 'confronti', 'fisco', 'guida', 'vita', 'forum', 'contact', 'profile', 'gamification', 'morning', 'blog', 'glossario', 'dialetto', 'sitemap'];
export const ALL_CALCOLATORE_SUBTABS: string[] = ['calculator', 'whatif', 'payslip', 'ral', 'bonus', 'parental-leave', 'residency', 'salary-quiz'];
export const ALL_CONFRONTI_SUBTABS: string[] = ['exchange', 'banks', 'health', 'mobile', 'shopping', 'cost-of-living', 'jobs', 'renovation'];
export const ALL_FISCO_SUBTABS: string[] = ['tax-return', 'calendar', 'holidays', 'ristorni', 'pension', 'pillar3', 'quiz', 'tax-credit', 'withholding-rates', 'new-frontier-tax-sim'];
export const ALL_GUIDA_SUBTABS: string[] = ['first-day', 'permits', 'border', 'unemployment', 'car-transfer', 'car-cost', 'permit-compare', 'border-map'];
export const ALL_VITA_SUBTABS: string[] = ['living-ch', 'living-it', 'companies', 'schools', 'nursery', 'places', 'transport', 'municipalities'];
export const ALL_STATS_SUBTABS: string[] = ['overview', 'livability', 'jobs-observatory', 'salary-compare', 'traffic-history', 'unemployment', 'mortgage', 'fuel-prices', 'health-premiums'];

// Legacy exports for backward compat
export const ALL_COMPARATORI_SUBTABS = ALL_CONFRONTI_SUBTABS;
export const ALL_GUIDE_SECTIONS = ALL_GUIDA_SUBTABS;
export type StrumentiSubTab = 'car-cost' | 'permit-compare';
export const ALL_STRUMENTI_SUBTABS: string[] = ['car-cost', 'permit-compare'];

/** Valid blog article IDs for individual article routing */

type _BlogId1 = 'stipendio-netto-2026' | 'lamal-vs-cmi' | 'primo-giorno-frontaliere' | 'tredicesima-frontaliere' | 'pilastro-3a-frontaliere' | 'comuni-migliori-frontalieri' | 'costo-vita-ticino-vs-lombardia' | 'tassa-salute-tensioni-ticino' | 'casa-oltre-confine-ticino' | 'franco-forte-stipendio-frontalieri' | 'cu-2026-novita-frontalieri' | 'telelavoro-italia-svizzera-ratifica' | 'telelavoro-accordo-definitivo-italia' | 'stop-ristorni-tassa-salute' | 'cu-telelavoro-regole-frontalieri' | 'smood-chiusura-impatto-lavoro' | 'disoccupazione-svizzera-ticino-gennaio' | 'riscaldamento-casa-ticino-norme' | 'sostituzione-caldaia-ticino-2026' | 'hic-sunt-leones-confini-ticino' | 'carnevale-bambini-lugano-2026' | 'arte-anima-ticino-frontalieri' | 'arca-russa-chiasso-cultura-frontaliere' | 'rsi-mostra-storia-ticino' | 'carnevale-bambini-lugano-tinguely' | 'daniela-rebuzzi-mostra-caslano' | 'corpi-in-prestito-arte-agno' | 'rsi-storia-svizzera-italiana-mostra' | 'rauschenberg-arte-mendrisiotto' | 'nakba-mostra-giubiasco-ticino' | 'de-andre-anime-salve-locarno' | 'sentimento-osservazione-masi-lugano' | 'rsi-archivio-gottardo-2026' | 'carnevale-blenio-chiescia-bosc' | 'tf-permesso-integrazione-ticino' | 'tassazione-individuale-lavoro-ticino' | 'ristorni-scontro-gobbi-berna' | 'frontalieri-ticino-dati-q4-2025' | 'pendolarismo-affitto-tempo-ticino' | 'centrodestra-stop-ristorni-2026' | 'calo-entrate-irregolari-chiasso' | 'frontalieri-salari-polemica-ticino' | 'ristorni-frontalieri-scontro-ticino-lombardia' | 'tredicesima-avs-iva-contributi' | 'tredicesima-avs-finanziamento-misto' | 'tredicesima-avs-finanziamento-scontro' | 'ristorni-imprese-allarme-ticino' | 'denaro-non-dichiarato-dogana-brogeda' | 'frontalieri-salari-dibattito-ticino' | 'tredicesima-avs-stipendio-iva' | 'stop-ristorni-mozione-partiti' | 'partiti-ticino-stop-ristorni' | 'conti-federali-aumento-iva-ticino' | 'tredicesima-avs-stipendi-iva' | 'ristorni-lombardia-reazione' | 'truffa-falso-bancario-ticino' | 'dazi-usa-impatto-ticino' | 'sanita-ticino-tagli-orselina' | 'dumping-salari-architetti-ticino' | 'tredicesima-avs-finanziamento-contributi' | 'tredicesima-avs-stipendio-trattenute' | 'scambio-dati-polizia-ticino' | 'tredicesima-avs-finanziamento-misto-proposta' | 'frontalieri-ticino-dati-ingannevoli' | 'tredicesima-avs-finanziamento-busta-paga' | 'permesso-s-salari-bassi-ticino' | 'ristorni-reazione-lombardia' | 'tredicesima-avs-busta-paga-frontaliere' | 'acqua-mendrisiotto-prezzi-2026' | 'cooperazione-giudiziaria-svizzera-italia' | 'sanita-locarnese-licenziamenti' | 'legionellosi-ticino-allarme' | 'prezzi-dinamici-ticino-futuro' | 'lugano-manifestazioni-regole-polemica' | 'addizionale-irpef-mappa-comuni' | 'mappa-fiscale-comuni-frontiera' | 'maternita-paternita-frontaliere-guida' | 'guida-contributi-sociali-svizzera' | 'costo-vivere-lugano-trasferirsi' | 'calcolo-pensione-avs-inps' | 'simulazione-fiscale-frontaliere-2026' | 'lamal-cmi-scelta-frontaliere-2026' | 'credito-imposta-doppia-tassazione' | 'costo-reale-auto-frontaliere' | 'congedo-genitori-frontaliere-ticino' | 'costo-pendolare-auto-ticino-2026' | 'guida-dichiarazione-redditi-frontalieri' | 'checklist-documenti-lavoro-svizzera' | 'asilo-nido-frontaliere-ticino' | 'locarno-stop-residenze-secondarie' | 'costo-vita-svizzera-mappa' | 'sicurezza-lavoro-audit-suva' | 'costo-vivere-mappa-comuni' | 'architetti-sottopagati-ticino' | 'calo-frontalieri-non-tassa-salute' | 'maternita-cassazione-diritti-frontalieri' | 'galenica-bichsel-ristrutturazione-lavoro' | 'dazi-trump-export-ticinese' | 'campione-italia-fine-dissesto' | 'gavetta-tossica-architetti-ticino' | 'eurocity-bloccato-caos-pendolari' | 'sicurezza-lavoro-controlli-svizzera' | 'startup-investimenti-boom-ticino' | 'long-covid-malattia-professionale' | 'accordo-ue-svizzera-mercato-interno' | 'fonderie-svizzere-crisi-2025' | 'salario-minimo-ticino-accordo' | 'trasporti-pubblici-crescita-svizzera' | 'cantieri-notturni-lugano-marzo-2026' | 'supsi-nuova-direttrice-formazione' | 'bps-suisse-risultati-bper' | 'aiuti-energia-proroga-taglio' | 'salario-minimo-sociale-ticino-dibattito' | 'bps-suisse-utili-consigli-crisi' | 'accordo-ue-voto-obbligatorio-ticino' | 'accordo-ue-svizzera-impatto-frontalieri' | 'locarno-stop-case-vacanza' | 'bilaterali-ue-svizzera-firma' | 'aumento-iva-esercito-impatto-spesa' | 'maternita-paternita-ticino' | 'valposchiavo-turismo-2025' | 'frontalieri-economia-ticino' | 'inflazione-frontalieri-ticino' | 'aprire-conto-bancario-frontaliere' | 'ristorni-fiscali-ticino' | 'contributi-sociali-busta-paga' | 'strada-incidenti-vezia-cureglia' | 'assicurazione-malattia-famiglia' | 'frontalieri-calo-economia-ticinese' | 'usi-startup-centre-ranking' | 'sciopero-treni-tilo-febbraio-2026' | 'piscina-chiasso-copertura-2026' | 'centrale-elettrica-grono-attiva' | 'naspi-frontaliere-italia-requisiti' | 'prelievo-secondo-pilastro-frontaliere' | 'accordo-ue-frontalieri-ticino' | 'ristorni-congelati-ticino-italia' | 'naspi-ex-frontalieri-2026' | 'mutuo-casa-frontalieri-italia' | 'piscina-chiasso-investimento' | 'ristorni-congelati-gobbi-2026' | 'asilo-nido-ticino-guida-2026' | 'ristorni-salute-2026-ticino' | 'tassa-salute-scontro-ticino-berna' | 'piscina-chiasso-rinnovo-sicurezza' | 'disagi-tilo-sciopero-italia' | 'abbonamenti-sconti-treni-ticino' | 'bonus-famiglia-frontalieri-2026' | 'smart-working-frontalieri-2026' | 'confronto-assicurazioni-auto' | 'permesso-b-vs-g-differenze' | 'spese-sanitarie-frontalieri' | 'dichiarazione-redditi-ticino-2026' | 'migranti-seghezzone-risparmi' | 'cantieri-traffico-frontiera' | 'salario-minimo-ps-compromesso' | 'cocaina-lusso-perquisizioni-ticino' | 'calcolo-tasse-entro-confine' | 'riforma-giustizia-pace-ticino' | 'cantieri-a9-disagi-frontiera' | 'revoca-uso-acqua-magliaso' | 'malattie-rare-ticino-2026' | 'frontaliers-sabotage-varese' | 'ristorni-congelati-scontro-ticino' | 'tassazione-individuale-lavoro-donne' | 'diversita-religiosa-ticino-2026' | 'voto-corrispondenza-ticino-2026' | 'cantiere-viale-geno-como' | 'controlli-velocita-ticino-2026' | 'sanremo-2026-aiello-gassmann' | 'violenza-adolescenti-ticino' | 'comuni-frontalieri-distanza' | 'elezioni-comunali-ticino' | 'eroina-auto-chiasso-brogeda' | 'olio-chimica-produzione' | 'incidente-mortale-frontaliere' | 'svizzera-mediazione-iran-2026' | 'sanremo-frontalieri-impatti' | 'lavorare-germania-educatori' | 'porto-ceresio-lungolago-lavori' | 'casa-hockey-ticino-2026' | 'tassazione-individuale-svizzera' | 'cinema-frontaliers-ticino-varese' | 'minimo-salariale-ticino-accordo-ps' | 'chiasso-fede-adulti-integrazione' | 'sicurezza-confine-ticino-brogeda' | 'stipendi-manager-energia-ticino' | 'lavoro-educatori-germania-alternativa' | 'gandria-lusso-immobiliare-ticino' | 'vandalismo-bus-frontalieri-ticino' | 'ticino-voto-anti-dumping' | 'controlli-stradali-ticino-frontalieri' | 'comuni-confine-nuove-regole' | 'tragedia-stradale-frontaliere' | 'chiasso-como-cantieri-a9-disagi' | 'chiasso-comunita-evoluzione-sociale' | 'tragedia-pendolare-ticino' | 'a9-como-chiasso-disagi-notturni';
type _BlogId2 = 'economia-svizzera-ripresa-2026' | 'confine-fiscale-nuovi-comuni' | 'confine-a9-disagi-marzo' | 'autostrada-a9-disagi-frontalieri' | 'chiusure-a9-trasporti-speciali' | 'salari-ticino-voto-frontalieri' | 'lutto-porlezza-frontaliere' | 'frontalieri-confine-disparita-fiscale' | 'iniziativa-anti-dumping-voto' | 'nestle-bonus-lombardia-welfare' | 'frontiera-a9-disagi-marzo-2026' | 'mercato-lavoro-ticino-frena-2025' | 'confini-comunali-impatto-fiscale' | 'franco-forte-impatto-frontalieri' | 'incidente-giovane-frontaliere' | 'a9-chiasso-como-cantieri-frontalieri' | 'salario-minimo-compromesso-ticino' | 'compromesso-salario-minimo-condizioni' | 'chiasso-comunita-cambiamento-valori' | 'pendolarismo-fatale-frontaliere-porlezza' | 'salario-minimo-ticino-trattative' | 'trevano-campus-riqualifica' | 'lavena-sagrato-nuovo-investimento' | 'sportello-lavoro-varese-frontalieri-ticino' | 'controlli-stradali-intensivi-frontiera' | 'radar-confine-ticino-marzo' | 'controlli-frontiera-ticino-rafforzati' | 'lavori-risanamento-a13-cadenazzo-2026' | 'salario-minimo-ticino-intesa-storica' | 'sicurezza-stradale-ticino-marzo' | 'a13-cantieri-frontalieri-ticino' | 'bns-utile-calo-2025-impatto-ticino' | 'polizia-cantonale-nuovi-gendarmi' | 'competenze-tecniche-frontalieri-ticino' | 'polizia-cantonale-reclutamento-2026' | 'mercato-auto-febbraio-2026' | 'como-nuovi-poliziotti-2026' | 'sesto-calende-sicurezza-frontalieri' | 'nessun-prelievo-avs-sulle-mance' | 'imposizione-individuale-donne-ticino' | 'tassa-salute-frontalieri-vantaggio-ticino' | 'docenti-frontalieri-permesso-lavoro' | 'iniziativa-anti-dumping-ticino-2026' | 'comuni-confine-fiscalita-disparita' | 'tassa-salute-berna-ticino' | 'ai-lombardia-impatto-ticino' | 'crisi-golfo-carburanti-ticino' | 'rincari-benzina-frontalieri-ticino' | 'crisi-olio-prezzi-benzina-ticino' | 'ai-lombardia-ticino-frontaliere-2026' | 'benzina-ticino-oriente' | 'kuhne-nagel-tagli-posti-ticino-2026' | 'vini-ticinesi-collaborazione' | 'hockey-chiasso-wild-boars-bis' | 'svincolo-a2-biasca-rischi-frontaliere' | 'accordi-svizzera-ue-parmelin-bruxelles' | 'lavori-linea-locarno-cadenazzo-2026' | 'spirit-varesini-valico-tassa-2026' | 'borse-in-rosso-prezzo-petrolio-ticino' | 'frontaliers-sabotage-varese-successo' | 'disoccupazione-svizzera-2026' | 'infermieri-svizzera-frontalieri-ticino' | 'successo-farmaceutica-ticino' | 'utile-bns-2025-ticino' | 'banche-ticino-disoccupazione' | 'medio-vedeggio-gruppo-lavoro-aggregazione' | 'lugano-airport-fondi-salvati-2026' | 'made-in-italy-doganali-ticino-2026' | 'mercato-lavoro-ticino-q4-2025' | 'dichiarazione-imposta-digitale-ticino-26' | 'tilo-25-milioni-passeggeri-2025' | 'tassa-salute-lombardia-rinvio' | 'tilo-record-passeggeri-2025' | 'trasporti-lombardia-ticino-record-tilo' | 'confusione-tassa-salute-frontalieri' | 'carburante-ticino-costo-aumenti' | 'cpi-caso-hospita-rivalutazione-periti' | 'casellario-giudiziale-ue-ticino' | 'salario-minimo-per-il-controprogetto-la-strada-e-in-discesa' | 'tassa-salute-lombardia-frontalieri' | 'franco-forte-problemi-economici' | 'carburante-prezzo-salito-opportunismo' | 'frontalieri-tassa-salute-teatro' | 'disoccupazione-stabile-svizzera-2026' | 'dazi-usa-rimborsi-ritardi' | 'votazioni-8-marzo-iniziativa-ssr-aperto' | 'ticino-spitex-contributo-pressione' | 'stalking-swiss-2026-ticino' | 'pirati-strada-ticino-italiani-2026' | 'comuni-locarno-futuro-aggregazione' | 'costi-cure-domicilio-ticino-2026' | 'lugano-park-ride-bus-sovvenzioni-2026' | 'crisi-turismo-golfo-persico' | 'turisti-ticinesi-bloccati-medio-oriente' | 'svizzeri-bloccati-medio-oriente' | 'ticino-prevenzione-incendi-scuole-2026' | 'varese-india-export-2026' | 'autotrasporto-rincari-confine-2026' | 'carburanti-rincari-confine-ticino' | 'votazioni-imposizione-ticino-2026' | 'imposizione-individuale-ticino-2026' | 'no-iniziativa-antidumping-ticino' | 'dumping-salariale-ticino-no-iniziativa' | 'incidente-viadotto-brogeda-como' | 'iniziativa-contro-dumping-ticino' | 'dumping-salariale-iniziativa-mps' | 'imposizione-individuale-rivoluzione-fiscale' | 'votazioni-federali-tassazione-individuale' | 'universita-ticino-frontalieri' | 'franco-svizzero-frontalieri-ricchi-2026' | 'energia-costi-ticino-rincari-2026' | 'ticino-carburante-alle-stelle-quadri-berna-riduca-tasse' | 'un-test-per-dare-un-nome-al-dolore' | 'aumentare-gia-il-prezzo-della-benzina' | 'furti-supermercati-ponte-tresa' | 'ladri-intercettati-lavena-ponte-tresa' | 'dumping-salariale-ticino-no' | 'sospensione-costi-utenti-ticino' | 'investimento-pedone-bioggio' | 'tir-colonna-disagi-valico-brogeda' | 'iniziative-cassa-malati-costituzionalista-ticino' | 'investimenti-sicurezza-turismo-valsolda-26' | 'premio-la-rondine-2026-ticino' | 'tassi-ipotecari-ticino-medio-oriente-2026' | 'aumento-export-bellico-svizzero-ticino' | 'assicurazione-auto-rincari-2026' | 'ticino-biglietti-senza-contanti' | 'aziende-como-assumono-lavoratori' | 'a2-giornico-cantiere-disagi-frontalieri' | 'tassa-traffico-pesante-camion-elettrici' | 'logistica-sostenibile-a22' | 'problemi-rotaia-bellinzona-lugano' | 'carpooling-aziendale-ticino' | 'energia-ets-von-der-leyen' | 'permesso-g-apprendisti-frontali' | 'assegni-familiari-frontalieri-ticino' | 'dagatra-incontro-migranti-chiasso' | 'ufficio-postale-chiasso-trasloco' | 'confine-tesissimo-assegni-familiari' | 'chiasso-jazz-festival-2026' | 'apprendisti-frontalieri-riforma-permesso-g' | 'chiasso-piano-regolatore-telefonia' | 'pensione-et-ticino-sentiero' | 'paradosso-ticino-lavoro' | 'lavena-ponte-tresa-giro-spaccio' | 'apertura-pesca-ticino' | 'cassa-malati-franchigia-minima-ticino' | 'trin-tunnel-grave-frontalieri' | 'chiasso-verde-sufficiente' | 'comitati-malpensa-cuv-2026' | 'borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta' | 'iran-tajani-non-tratta-navi' | 'accordi-bilaterali-3-parlamento' | 'viaggio-delle-batterie-verso-seconda-vita' | 'bilaterali-iii-parlamento-ticino-2026' | 'affitti-rialzo-crisi-ticino-2026' | 'bilaterali-iii-ticino-parlamento-2026' | 'truffa-lavoro-svizzera-anticipo-2026' | 'ticino-carburanti-prezzo-potere-acquisto' | 'aumento-franchigia-minima' | 'ticino-swissminiatur-inaugura-miniera-doro-sessa' | 'lavena-ponte-tresa-addio-antonio-cannavale' | 'gravincidente-stradale-regina-feriti' | 'scende-limite-nevicate-ticino' | 'ticino-no-anti-dumping' | 'chiusa-val-bedretto' | 'un-passaporto-di-fedelt' | 'chiusure-autostrada-confine-ticino-2026' | 'swissminiatur-miniera-doro-sessa' | 'sondaggio-tamedia-iva-esercito-avs' | 'inverno-ticino-nevicate-2026' | 'franchigia-minima-sanitario-ticino' | 'svizzera-recessione-cieslakiewicz' | 'nevicate-strade-bloccate-ticino' | 'bilaterali-terza-fase-parlamento-ticino' | 'cane-morto-binarie-campo-calcio' | 'swissminiatur-miniera-sessa-2026' | 'crescita-misera-libera-circolazione' | 'treni-varese-milano-ceresio-express' | 'caro-carburante-benzina-ticino' | 'guida-cambio-franco-euro-frontaliere' | 'guida-pensione-frontaliere-avs-lpp' | 'vivere-svizzera-vs-italia-frontaliere' | 'dumping-salariale-diritti-lavoratore-ticino' | 'malattia-frontaliere-guida-assicurazione' | 'strumenti-frontaliere-guida-comparatori' | 'bilaterali-iii-cassis-ticino' | 'fermato-brogeda-cocaina' | 'dominicano-auto-svizzera-arresto' | 'salari-bassi-rischio-povert' | 'ticino-svolta-per-apprendisti' | 'bellinzona-crescita-qualita-vita' | 'crisi-spermatozoi-svizzera-ticino' | 'droga-brogeda-sequestro-cocaina' | 'bellinzona-auscultazione-2026' | 'lombardia-affitto-famiglie-varesine' | 'malcantone-fai-di-primavera-2026' | 'sicurezza-privata-chiasso-nebiopoli' | 'sfruttamento-corsieri-ticino-2026';
type _BlogId3 = 'lavoro-economia-2026' | 'sequestro-cocaina-brogeda-2026' | 'infiltrazioni-criminali-ticino-grigioni' | 'turismo-luganese-formazione' | 'walter-bonatti-in-capo-al-mondo' | 'sargans-teenage-robbery-catch' | 'com-aziende-lavoro-como' | 'cabov-precipita-forte-vento' | 'gadda-incalza-governo-frontalieri' | 'centovallina-riapertura-treni' | 'truffe-chiamate-shock-ticino' | 'spazi-verdi-in-citta-rilassamento' | 'camedo-buffet-eventi-ticino' | 'berna-discute-approvvigionamento-economico-e-13esima-avs' | 'visita-ticinese-coira-criminalita-organizzata' | 'annunci-lavoro-dumping-ticino-governo' | 'controlli-cantieri-mendrisio' | 'catastrofi-ticino-prontezza-2026' | 'tredicesima-avs-soluzione-mista-stati' | 'lo-statuto-s-non-deve-trasformarsi-in-permesso-b' | 'consiglio-stati-soluzione-mista-13esima-avs' | 'frode-cassa-compensazione-avs-ticino' | 'deputazione-ticinese-italofoni-2024' | 'kebab-case-turismo-ticino' | 'droga-al-confine-ticino-2025' | 'incidente-stradale-laghi' | 'vivere-piu-lungo-ticino' | 'giustizia-in-bilico-2026' | 'ampliamento-parco-eolico-san-gottardo-digital-2026' | 'eolico-gottardo-ampliamento-2026' | 'contrabbando-ai-confine-aumentano-droga-e-sigarette' | 'salute-prevenzione-burocrazia-svizzera' | 'telefonate-choc-truffa-anziani-ticino' | 'ubs-fusione-credit-suisse-ticino' | 'salari-minimi-ccl-ticino-2026' | 'strutture-dedicate-migranti-ticino' | 'contratti-collettivi-salari-ticino' | 'tutela-sovranita-dati-sanitari' | 'nomine-annullate-sims-tram' | 'tassa-automobilisti-svizzera' | 'lavoro-richiedenti-asilo-ucraini-ticino' | 'riforma-scolastica-ticino-difficolta' | 'tassa-transito-parlamento-ticino' | 'inclusione-migranti-ticino' | 'franco-svizzero-impatti-ticino' | 'tassa-transito-automobilisti-ticino' | 'nubifragio-coira-mesolcina-ristoro' | 'lotta-violenza-di-genere-ticino' | 'tassa-transito-svizzera-2023' | 'controlli-cantieri-mendrisiotto' | 'acinque-lancia-piano-genitorialita' | 'danni-riparati-centovallina' | 'porrentruy-piscina-comunale-divieto' | 'sanita-fontana-fedriga' | 'ampliamento-parco-eolico-san-gottardo' | 'cure-a-domicilio-tassa-ticino' | 'kebab-case-ticino-nubifragio-grigioni' | 'kebab-case-rossi-bruxelles-ticino' | 'rinnovo-concessioni-snl-2026' | 'globalisti-fuga-medio-oriente-ticino' | 'guasto-tra-parabiago-e-rho' | 'tassa-transito-ticino-pedemontana' | 'franco-svizzero-a-valori-record-2026' | 'taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi' | 'farmaci-competitiva-europa' | 'controlli-cantieri-mendrisiotto-2026' | 'byd-expansion-ticino-2026' | 'controllo-affitti-nazionale-ticino' | 'cioccolato-meno-ma-pagato-di-piu' | 'diesel-aumento-prezzi-svizzera-2026' | 'sanita-manifesto-varese-2026' | 'iva-bassa-svizzera-immagine-ingannevole' | 'divieto-smartphone-scuola-ticino' | 'la-navigazione-rafforza-offerta-2026' | 'sanita-integrativa-lombardia-ticino' | 'fatture-mediche-gonfiate-ticino' | 'divieto-cellulari-scuola-ticino' | 'violenza-donne-consiglio-europa-ticino' | 'trojani-capo-servizi-esercito-ticino' | 'funivia-monteviasco-orari-corsi' | 'ricchi-fuga-medio-oriente-ticino' | 'divieto-cellulari-scuola-ticino-2024' | 'sindacati-contro-snl-ticino-2026' | 'aumento-iva-costo-ticino-2026' | 'acquarossa-nuovo-polo-filovia-2026' | 'ritardo-sconto-carburante-ticino-2026' | 'lavori-a8-castellanza-notturni-2026' | 'quanto-costa-la-discriminazione' | 'divieto-smartphone-scuola-ticino-2026' | 'carenza-farmaci-ticino' | 'lago-maggiore-accesso-tutto-l-anno' | 'spiagge-libere-sul-lago-maggiore' | 'snl-stagione-green-concessione' | 'smartphone-a-scuola-e-nuove-direttive' | 'infortuni-sul-lavoro-protesi-hi-tech' | 'bellinzona-scomparsa-ricerche-ticino-piemonte' | 'cure-domicilio-ticino-politica' | 'navigazione-lago-lugano-2026' | 'parco-vedeggio-comuni-firman' | 'stop-export-materiale-bellico' | 'gestione-scontri-frontali-ticino' | 'auto-intrusione-frontalieri-ticino' | 'rischio-lugano-young-boys' | 'bossi-morto-ticino-frontalieri' | 'ogm-fallimento-ticino' | 'passaggio-statuto-s-permesso-b' | 'chiusure-notturne-autostrada' | 'morte-bimbo-efamilia-ticino' | 'fondi-hcap-restituiti' | 'bellinzona-paese-dormitorio' | 'ticino-attenti-ai-radar-2026' | 'sequestro-stupefacenti-ecuador' | 'nuovi-radar-ticino-multe' | 'rifugiati-ucraini-assistenza-2027' | 'cannabis-sequestro-ticino' | 'pfaffikon-kanton-schwyz-franzosi-einbrecher' | 'riapertura-casetta-chiosco-davesco' | 'giovani-ticino-comuni-innovazioni' | 'domeniche-senza-auto-ticino-2026' | 'chiusure-notturne-a4-ticino' | 'svizzera-frontalieri-franco-lavoro' | 'svizzera-cern-ricerca-chip' | 'cannabis-sequestro-ticino-2026' | 'svizzeri-dubitano-difesa-paese' | 'controlli-radar-ticino' | 'frontalieri-casa-zurigo' | 'lugano-sicurezza-2025' | 'chiasso-ora-terra-2026' | 'radar-ticino-riduzione' | 'nomine-sims-illegittime' | 'funivia-monte-lema-stagione-2026' | 'crescita-economica-ticino-2026' | 'giustizia-referendum-ticino' | 'ora-legale-permanente-ticino' | 'como-asfaltature-war-costs' | 'apprendisti-frontalieri-permessi-g' | 'crescita-sicurezza-ticino-2025' | 'sesto-calende-centro-sportivo' | 'chiasso-missione-emergenza' | 'ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio' | 'lavena-ponte-tresa-verde' | 'chiasso-missione-emergenza-luci-blu' | 'aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica' | 'carburanti-prezzo-rialzo-ticino' | 'guida-michelin-ticino' | 'eurospin-luino-occhio-al-cambio' | 'lavena-ponte-tresa-territorio-poroso' | 'fusione-valle-calanca-comuni' | 'lavoro-carceri-ticino' | 'lavena-ponte-tresa-annaffiatoi' | 'bossi-commemorazione-bagarrata' | 'corsi-a-b-scuola-media-ticino' | 'ticino-confine-droga' | 'franco-svizzero-minimi-euro' | 'benzina-conveniente' | 'piu-interventi-soccorso-meno-vittime-montagna-ticino-2025' | 'nei-test-neonati-ticinesi' | 'aggregazione-rischio-basso-mendrisiotto' | 'congresso-svizzera-italia-varese-2026' | 'processo-mendrisio-19-capit' | 'prezzi-carburanti-ticino-marzo-2026' | 'via-francisca-cammino' | 'lavoro-sommerso-varesotto' | 'rissa-lavena-ponte-tres' | 'magliaso-zona-educativa-ripresa' | 'cassa-malati-leghista-applicata-subito' | 'ronte-tresa-rissa' | 'a9-chiasso-como-chiusure-frontalieri' | 'code-nord-san-gottardo' | 'trattative-acordo-usa-oltre-31-marzo' | 'occhiali-intelligenti-ticino-innovazione' | 'trattative-dazi-non-valido-31-marzo' | 'trippa-dogana-novazzano' | 'lavori-rete-ferroviaria-tilo' | 'tassa-mensa-asilo-chiasso' | 'sindacati-ticino-leonardo-cascina-costa' | 'chiasso-tassa-refezione-scuola-infanzia' | 'ict-reatto-commissione-tri' | 'furbata-dogana-argento' | 'best-cross-border-worker-calculator-switzerland' | 'ambasciatore-italiano-ritorno-berna' | 'aumento-contingente-uova-svizzera' | 'lavori-notturni-via-lavizzari' | 'limite-popolazione-10-milioni-ticino' | 'settanta-chili-di-mozzarella' | 'contrabbando-ticino-2026' | 'mobilita-infermieri-ticino' | 'san-gottardo-code-giovedi-santo' | 'como-lago-pasqua-boom-prenotazioni' | 'camion-panne-san-gottardo-traffico-bloccato' | 'aumento-inchieste-penali-2025' | 'dogana-chiasso-centro-tecnologico' | 'permessi-dubbi-roveredo-insoddisfatta' | 'permesso-g-vantaggi-svantaggi' | 'lamal-vs-ssn-decisione' | 'trovare-lavoro-ticino' | 'guida-completa-frontaliere' | 'permessi-dimora-diversi-opinioni' | 'chiasso-zanzara-tigre-strategia-2026' | 'trasferimento-ufficio-postale-chiasso';
type _BlogId4 = 'esame-complementare-passerella-aperte-pre-iscrizioni' | 'gasolio-costi-pullman-ticino-lago-como' | 'turismo-pasquale-ticino-2026' | 'mozzarella-clandestina-2026-ricerca' | 'accordi-svizzera-ue-2026' | 'vacanze-di-pasqua-san-gottardo' | 'medici-manca-verbano-ticino-2026' | 'italia-taglia-accise-benzinai-preoccupati' | 'aumento-mezzi-pubblici-ticino' | 'ladri-di-auto-scappano-con-40-chiavi-e-una-skoda' | 'incendi-boschivi-ticino-2026' | 'benzina-ticino-taglio-accise' | 'abolizione-imposta-valore-locativo-2029' | 'contrabbando-pokemon-ticino' | 'sconto-benzina-ticino' | 'anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare' | 'supsi-bachelor-sostenibilita-2027' | 'lavena-ponte-tresa-bicicletta-grave' | 'roveredo-permessi-anticrimine' | 'pasqua-messaggio-di-avvenire' | 'tramonto-a-cadenazzo' | 'traffico-san-gottardo-2026' | 'auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate' | 'nestle-200-posti-lombardia' | 'la-quinta-svizzera-che-ha-un-debole-per-milano' | 'comuni-investono-turismo-ticino' | 'agriscambio' | 'galleria-del-ceneri-chiusa-per-problemi-tecnici' | 'corso-pastori-ticino' | 'diventare-pastore-ticino' | 'trump-intesa-o-inferno' | 'coop-richiama-formaggi-salmonelle' | 'scambio-abiti-bellinzona' | 'protesta-costi-cure-domicilio' | 'acqua-non-potabile-lavizzara' | 'nuova-direttrice-servizi-sociali-bellinzona' | 'riaperta-galleria-monte-ceneri' | 'ucraini-in-ticino-aiuti-incognite' | 'fuga-da-dubai-ticino-alternativa' | 'tax-free-come-cresce' | 'traffico-san-gottardo-pasquetta-2026' | 'controlli-auto-immatricolate-grigioni' | 'locarno-magadino-trasporto' | 'prezzi-benzina-ticino' | 'lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone' | 'raffica-chiusure-a9-2026' | 'conflitto-medio-oriente-energia-ticino' | 'lavoro-notte-lincendio-laveno-mombello' | 'prevenzione-maschile-centro-beccaria' | 'controlli-varese-esposto-espulsione' | 'incidente-arogno-31enne-gravi-condizioni' | 'carburanti-ticino-aumento-prezzi' | 'provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026' | 'turisti-in-como-ztl' | 'niederlander-droga-ticino' | 'stop-agli-artigiani-per-caso' | 'incendi-nel-luganese-arrestato-un-piromane' | 'front-alieri-soci-sagl-nodi-fiscali-2026' | 'benzina-cara-ticino' | 'incidente-rampa-a9-chiasso-2026' | 'tilo-s50-lavori-mal-pensa-varese-2026' | 'tilo-s50-modifiche-aprile' | 'consiglio-federale-ferma-perequazione-2030' | 'camionisti-furbetti-governo-ticino-2026' | 'multe-vignetta-chiasso-2024' | 'petizione-aromat-svizzera' | 'frontalieri-tassa-salute-scontro' | 'multe-vignetta-chiasso-pasqua-2026' | 'tasse-ticino-frontalieri-perequazione-2026' | 'asili-bellinzona-progetto-pilota-orario-prolungato-2027' | 'multe-vignetta-chiasso-2026' | 'servizio-trasfusionale-locarno-chiusura-24-giugno' | 'ritardi-disoccupazione-ticino' | 'benzina-lombardia-frontalieri-ticinesi-2026' | 'diploma-usa-non-riconosciuto-ticino' | 'discover-eu-2026-frontalieri-ticino' | 'banche-svizzere-pronti-clienti-golfo-2026' | 'fertilizzanti-crisi-hormuz-rincari-ticino-40' | 'tassa-salute-frontalieri-lombardia-isola-2026' | 'reclutamento-infermieri-lombardia' | 'autostrada-a9-chiude-de-notti-2026' | 'multa-vignetta-pasqua-chiasso-2024' | 'salva-venti-anni-monito-infarti' | 'marchi-migros-riduzione-frontalieri-ticino' | 'disagi-tilo-mendrisio-malpensa-2026' | 'cpb-forfettario-semplificato-soglia-150mila' | 'verbano-livello-max-accordo-ticino-2026' | 'tassa-salute-frontalieri-lombardia-minacce-ticino' | 'lavoro-frontalieri-ticino-scarse-incastri' | 'visione-politica-fuga-giovani-ticino' | 'cure-a-domicilio-atlas-protesta-18-aprile' | 'frontalieri-salari-perequazione-ricchezza-2026' | 'acqua-potabile-lavizzara-piano-peccia-monti-rima' | 'giovani-fuga-ticino' | 'svizzera-alleanza-porti-europei-anti-droga' | 'glarona-domeniche-senzauto-ticino-frontalieri' | 'controlli-frontalieri-ponte-chiasso-2025' | 'frontalieri-ticino-dati-ust-2025' | 'bibo-app-mezzi-pubblici-2026' | 'varese-frontalieri-7000-postivacanti-2026' | 'iniziative-cassa-malati-governo-ticinese-insoddisfazione-lega-ps' | 'fermo-treni-gallarate-sesto-aprile-2026' | 'bibo-sistema-biglietti-digitali-mezzi-2026' | 'infermieri-ticinesi-ricerca-lavoro-milano' | 'tappa-campione-ditalia-2025-commissione' | 'nuova-strategia-zanzara-tigre-chiasso-2026' | 'lombardia-7mln-talenti-pmi-frontalieri' | 'slowup-ticino-2026-giornata-senz-auto' | 'bike-sharing-como-riapre-30-aprile' | 'progetto-ticosa-parcheggi-acinque-frontalieri' | 'asili-nido-bellinzona-iniziativa-firme-2026' | 'cannabis-medica-rimborsi-casse-malati-ticino' | 'asili-nido-pubblici-ticino-iniziativa-popolare-2026' | 'berna-limita-acquisto-immobili-stranieri-2026' | 'riforma-cassa-malati-ticino-2029' | 'slowup-strade-trasporti-limiti-2026' | 'petrolio-e-gas-svizzera-approvvigionamento-2026' | 'fuochi-allaperto-ticino-grazie-normativa-2024' | 'governo-limita-acquisti-immobiliari-estero-2026' | 'incidente-cassano-magnago-frontalieri-ticinesi' | 'wirt-sorpreso-einbrecher-marokkaner-ticino' | 'irania-nazionale-italia-riqualifica-2026' | 'collaborazione-imprese-istituzioni-frontalieri-ticino' | 'ribaltone-mps-lovaglio-frontalieri-ticino' | 'giro-italia-2026-bellinzona-cari-tappa' | 'infortunio-locarnese-operaio-frontaliero-decede' | 'film-swiss-sabotage-frontalieri-ticinesi' | 'pendolare-inverso-altdorf-lugano-problemi' | 'centro-breggia-risparmio-casa-arriva-balerna' | 'blocco-droga-confine-brogeda-2026' | 'ffs-collegamenti-estivi-rimini-francia-2026' | 'strumenti-comune-chiasso-assunzione-residenti' | 'petizione-chiasso-ritorno-alla-natura-2025' | 'congresso-varese-2026-fisco-lavoro-ticino' | 'psicoterapia-digitale-deprexis-rimborsata-2026' | 'deputato-varesino-ferrara-forno-massacro-2026' | 'tassa-salute-ticino-riforme-invece-aggravi' | 'chiassolitteratura-venti-anniversario-2026' | 'finanze-2025-fragile-ticino' | 'tassa-salute-frontalieri-lombardia-rinvio-2026' | 'arresto-droga-confine-brogeda-2026' | 'manutenzione-ustat-servizi-chiusure-31-12-2025' | 'confine-italia-svizzera-6-regole-doganali' | 'due-arresti-brogeda-smuggling-droga-2024' | 'tutela-frontalieri-specie-invasive-ticino-2026' | 'usi-supsi-25-milioni-casse-malati' | 'lega-ticino-solidarieta-casa-propria-2026' | 'moon-stars-resident-discount-locarno-card' | 'scoperta-quantita-marijuana-colverde-confine-ticino' | 'controlli-serali-lavena-ponte-tresa-15-aprile-2026' | 'svizzera-canada-mercati-alternativi-trump' | 'iniziative-casse-malati-61-milioni-ticino' | 'allentamenti-affitti-brevi-ticino-2025' | 'fuoriuscita-ammoniaca-rapelli-stabio' | 'ia-selezione-personale-ticino' | 'swiss-market-index-vedi-breve-rimbalzo' | 'sussidi-cassa-malati-mendrisio-rallentamenti' | 'sussidi-cassa-malati-mendrisio-ritardi' | 'varese-economia-frontalieri-ticino-2026' | 'lombardia-investimento-moda-ticinesi-next-fashion' | 'svizzera-usa-nuovi-negoziati-commerciali-2026' | 'aumento-kerosene-voli-cancellati-frontalieri-ticino' | 'radar-controlli-velocita-ticino-aprile-2026' | 'nuove-tratte-estive-ffs-ticino-2026' | 'malpensa-carburante-rischio-frontalieri-2026' | 'nuovo-potabilizzatore-mobile-emergenza-ticino' | 'nuovo-potabilizzatore-mobile-ticino-emergenza' | 'palaraiffeisen-porta-aperte-lugano-2026' | 'fashion-outlet-landquart-15-nuovi-negozi-expansion' | 'salario-minimo-25-chf-ticino' | 'confindustria-varese-paciaroni-2026' | 'finanza-ticino-si-reinventa-economia-dati' | 'coppa-del-mondo-orientamento-locarnese-2026' | 'grigioni-governo-2026-nove-candidati' | 'svizzera-usa-accordo-commerciale-2026' | 'risoluzione-federviti-vino-ticinese-2025' | 'iniziative-cassa-malati-piano-lega-ticino' | 'chiusura-ramo-a8-a9-notte-lavori-2026' | 'ia-swiss-re-produttivita-ceo-berger' | 'rinascita-praterie-sommerse-laghi-ticino' | 'fuga-ammoniaca-stabio-rapelli-allerta-ticino' | 'inaugurazione-ail-arena-lugano-30-31-maggio' | 'sussidi-cassa-malati-mendrisio-ritardi-2026' | 'alloggi-frontalieri-ticino-crisi-2025' | 'grandine-bellinzonese-allerta-lugano-chiasso-19-aprile-2026' | 'sportello-dipendenze-digitali-ticino-2024' | 'tasse-agevolate-milionari-ticino-golfo' | 'infermiere-pratiche-avanzate-ticino-2024' | 'caos-medioriente-e-impatti-costruzione-ticino' | 'parmelin-washington-dazi-usa-2026' | 'gang-colombiani-verbano-arresti-ticino-2026' | 'parmelin-accordo-investimenti-bahrein-2026' | 'palazzo-civico-collegiata-accessibilita-bellinzona-2026' | 'roche-farmaci-obesita-ticino-2026' | 'chiusure-autostrada-a9-lombardia-2026' | 'capre-dogana-gandria-incidenti-2026' | 'lavori-autostrade-ticino-aprile-2026' | 'militari-treni-ticino-20-euro' | 'just-eat-migros-ticino-consegna-2026' | 'capre-dogana-gandria-intervento-30-marzo';
type _BlogId5 = 'assistente-ai-frontalieri' | 'costi-cure-domocilio-ticino-2026' | 'salario-minimo-ticino-2027-2029' | 'cure-domocilio-ticino-2026' | 'asili-nido-bellinzona-sussidi-2026' | 'giovani-scomparsi-7-cantoni' | 'svizzeri-italiani-cucina-preferita' | 'svizzera-chiude-investitori-immobiliari-stranieri' | 'salario-minimo-ticino-2027-2029-nuove-regole' | 'cybercrimepolice-ticino-italiano-2026' | 'azienda-assume-autisti-lombardia-800-euro' | 'bancastato-walking-mendrisio-2026' | 'whp-premia-aziende-ticino-2026' | 'rapina-milano-frontaliere-ticino-2026' | 'frontalieri-contributo-sanitario-2026' | 'bellinzona-calcio-licenza-negata-finanze' | 'mozione-salute-vigili-fuoco-lombardia' | 'cuasso-monte-ospedale-frontalieri-chiusura' | 'tassa-salute-frontalieri-lombardia-2026' | 'donne-arte-chiasso-2026' | 'cameradi-commercio-2026-integrazione' | 'basiletti-main-draw-chiasso-2026' | 'ticino-trasporto-pubblico-priorita' | 'omaggio-angeli-ponte-chiasso' | 'dogana-chiasso-traffico-2026' | 'integrazione-lavoro-stranieri-ticino-2026' | 'salario-minimo-ticino-2029-4000-franchi' | 'guasti-trenord-aprile-2026' | 'ponte-chiasso-sanita-2026' | 'soloaffitti-como-frontalieri-ticino' | 'aumenti-stipendi-medici-infermieri-lombardia' | 'svincolo-a2-sigirino-ritardo' | 'salari-svizzera-aumentati-2025' | 'academy-fnma-autisti-bus-2026' | 'patentino-digitale-lombardia-2026' | 'chiamate-shock-arresti-locarnese-2024' | 'valbianca-in-forti-difficolta-airolo-mette-1-5-milioni-e-aumenta-il-moltiplicatore' | 'aumento-stipendi-frontalieri-lombardia-2026' | 'cantieri-sottoceneri-estate-2024' | 'ricarica-auto-elettriche-campione-2026' | 'cena-spring-avsi-libano-castiglione' | 'permessi-dimora-grigioni-cambia-prassi' | 'divario-salariale-frontalieri-ticino-2026' | 'bandecchi-quarti-chiasso-2026' | 'cantello-peduncolo-gaggiolo-2026' | 'assegno-educativo-mendrisio-2026' | 'grigioni-permessi-dimora-2026' | 'aumento-stipendi-medici-infermieri-lombardia-2026' | 'dividere-lavoratori-salari-2026' | 'lufthansa-bagaglio-gratuito-eliminato' | 'como-frazione-tavernola-banditi-assaltano-gioielleria-e-si-dileguano' | 'regione-lombardia-aumento-stipendi-medici-infermieri' | 'divario-salari-ticino-frontalieri-2026' | 'aufenthaltsbewilligung-b-quellensteuer-2026' | 'g-bewilligung-leitfaden-grenzgaenger-2026' | 'quellensteuer-schweiz-2026-hub' | 'economia-svizzera-rischio-burocrazia' | 'samira-de-stefano-semifinale-chiasso' | 'omaggio-angeli-ponte-chiasso-2026' | 'polizia-stabio-futuro-incerto' | 'settimana-corta-ticino-2026' | 'comco-ia-criteri-2026' | 'autista-belga-20-ore-thurgau-intervento' | 'ust-neuchatel-telelavoro-300-dipendenti' | 'cartaelettronica-varese-2026' | 'frode-crediti-covid-ticino-3334-casi' | 'frontalieri-tassa-salute-lombardia' | 'casa-ticino-2026-piu-difficile' | 'sicurezza-frontalieri-ticino-2024' | 'vacanze-estive-2026-costi-guerra' | 'irb-bellinzona-valore-aggiunto-ticino' | 'incentivo-remigrazione-frontalieri-ticino' | 'confederazione-cantoni-ridiscutono-compiti-2026' | 'asili-nido-bellinzona-asp-2026' | 'lavena-ponte-tresa-battesimo-civico-2026' | 'ferrovia-tilo-s40-fermi-italia-personale' | 'grigioni-stretta-permessi-dimora-2026' | 'spese-cura-frontalieri-ufas-2026' | 'miliardari-dubai-svizzera-lugano' | 'crans-montana-spese-cura-italiani-ufas-2026' | 'alleanza-clima-ticino-comuni' | 'marketing-territoriale-varese-35000-euro' | 'nuova-tassa-frontalieri-2026' | 'crans-montana-fatture-cure-italiani-2026' | 'svizzeri-shopping-como-700-milioni' | 'apprendisti-ticino-incidenti-2026' | 'fiorenzo-dado-le-sue-tre-p-e-gli-statali-nella-morsa-politica' | 'medici-senza-permesso-svizzera-2026' | 'crans-montana-spese-cura-italiani-2026' | 'lombardia-aumenta-stipendi-sanitari-2026' | 'petizione-gioventu-comunista-tassa-esenzione-militare' | 'petizione-tassa-esenzione-militare-ticino' | 'immigrazione-svizzera-60-anni-2026' | 'supermercati-ticino-2026' | 'latte-ticino-crisi-politica-ritardo' | 'maria-timofeeva-trionfa-chiasso-2026' | 'crans-montana-cure-italiani-2026' | 'costi-salute-svizzera-frontalieri-2026' | 'imposta-ocse-multinazionali-obiettivi-lontani' | 'settimana-corta-svizzera-frontalieri' | 'adulti-genitori-sostegno-finanziario-ticino-2026' | 'swiss-lufthansa-economy-basic-2026' | 'twint-account-frode-frontalieri' | 'costi-sanitari-ticino-2024-4-percento' | 'cybersicurezza-industriale-ticino-2026' | 'redditi-varesotti-2024-luvinate' | 'chiusure-autostrade-ticino-2026' | 'accordo-navigazione-costanza-2026' | 'comunita-energetica-rinnovabile-luinese-400-kw' | 'chiusura-notturna-a8-gallarate-29-aprile-2026' | 'sovranita-latte-ticino' | 'chiasso-scoperta-enti-primo-intervento' | 'tennis-donne-open-di-chiasso-a-marija-glebovna-timofeeva-il-titolo' | 'foreste-sommerse-lago-como-lugano' | 'grigioni-viabilita-olimpica-2026' | 'mobilita-sostenibile-citta-vivibili-2026' | 'relazioni-italo-svizzere-2026' | 'integrazione-inclusione-ticino-2026' | 'reddito-como-2024-frontalieri' | 'st-moritz-case-accessibili-2026' | 'ex-gas-macello-residenze-secondarie' | 'contratto-lago-lands-lake-2026' | 'controlli-velocita-ticino-aprile-maggio' | 'finanze-pubbliche-ticino-2026-preoccupazioni' | 'premi-non-oltre-10-percento' | 'guerra-iran-industria-alimentare-svizzera' | 'bollini-rossi-traffico-san-gottardo-2026' | 'treno-guasto-bellinzona-2026' | 'elezioni-como-frontalieri-2026' | 'teatro-architettura-mendrisio-stagione-2026' | 'frontalieri-arresto-maggia-truffa' | 'study-china-ticino-frontalieri' | 'treno-senza-biglietto-frontalieri-ticino' | 'polizia-stradale-varese-1600-patenti' | 'agricoltori-varesini-sfide-burocrazia' | 'nuove-banconote-euro-restyling-2026' | 'amazon-made-in-italy-days-2026-ticino' | 'carburanti-ticino-confronto-2024' | 'nuovo-contratto-edilizia-ticino-2026-2031' | 'primo-maggio-varese-2026-lavoro-dignitoso' | 'fallimenti-fotovoltaico-clienti-ticino' | 'coop-svizzera-insetti-commestibili-2026' | 'controlli-frontalieri-airolo-2026' | 'fallimenti-startup-svizzera-2026' | 'limite-velocita-30-ticino-inquinamento-acustico' | 'varese-parcheggi-ospedale-sette-laghi-2026' | 'zecche-ticino-2026-18000-punture' | 'lavoratori-pensionati-ticino-2026' | 'calcio-dnb-bellinzona-vittoria-stade-nyonnais' | 'svizzera-indipendenza-energetica-importazioni-2026' | 'nuove-misure-violenza-domestica-svizzera' | 'ruag-ia-svizzera-difesa-2026' | 'nuove-leggi-violenza-domestica-2027' | 'regione-lombardia-casa-popolari-6-4-milioni' | 'prevenzione-violenza-domestica-san-gallo-2026' | 'zurigo-economia-svizzera-crescita-media-2026' | 'swisscom-minacce-cyber-2026' | 'svizzera-istruzioni-uso-2026' | 'reparto-securizzato-pasture-consenso-cantone-comuni' | 'nuovo-ccnl-edilizia-ticino-2026-2031' | 'morcote-eventi-2026-scalinata-caccia-tesoro' | 'svizzera-credito-energetico-2026' | 'oftalmologi-svizzeri-messico-vista' | 'rumore-traffico-svizzera-frontalieri' | 'bandiera-svizzera-scarpe-on-controversia' | 'incontro-solidarieta-sicurezza-bioggio' | 'infermieri-ticino-frontalieri-2026' | 'deepfake-legge-svizzera-2026' | 'ticinesi-missione-ucraina-2026' | 'frontalieri-massagno-salario-scandaloso' | 'cure-infermieristiche-190mila-firme-2026' | 'maxi-spiegamento-fiamme-gialle-comasco-2026' | 'riforma-medici-famiglia-sumai-organizzazione' | 'lavoratori-pensionati-ticino-2026-2046' | 'universita-varese-intelligenza-artificiale-2026' | 'visite-gratuite-prevenzione-tumore-seno-gallarate-lilt' | 'frontalieri-mozione-sirica-ticino-2024' | 'corsi-gratuiti-varese-sociale-2026' | 'solaro-rifiuti-differenziata-tariffazione-puntuale' | 'svizzera-disoccupazione-frontalieri-quadri' | 'corteo-maggio-lugano-traffico-2024' | 'incidenti-mortali-lavoro-svizzera-2026' | 'coldiretti-brennero-made-italy-2026' | 'ticino-tedeschi-turismo-2026' | 'universita-ticino-tagli-contributi-2026' | 'chiasso-arresti-furto-biciclette-2026' | 'sicurezza-lavoro-ats-insubria-2026' | 'furto-biciclette-giubiasco-2026' | 'osservatori-traffico-lago-como-2026' | 'sicurezza-lavoro-ats-insubria-varese-como-2026' | 'furto-biciclette-benzina-chiasso-2026' | 'bando-formazione-professionale-plr-2026' | 'lavoratori-pensionati-svizzera-2026' | 'met-svizzera-insoddisfatta-sistema-2026' | 'nuovi-esperti-gestione-energia-varese' | 'negoziati-falliti-stretto-hormuz-2026' | 'roadmap-violenza-domestica-bilancio-positivo' | 'benessere-integrita-allievi-bellinzona-2026' | 'cosa-significa-made-switzerland' | 'equans-licenziamenti-monteceneri-19-dipendenti' | 'verdi-ticino-cantonali-2026' | 'borse-studio-bracco-lombardia-2026' | 'sportello-me-te-cunardo-marchirolo-2026' | 'accordo-edilizia-ticino-2026-2031' | 'equans-rivera-19-licenziamenti' | 'controlli-finanza-comasco-226-persone' | 'auto-cinesi-svizzera-2026' | 'dengue-sistema-rapido-individuazione' | 'aprile-secco-siccita-ticino-2026' | 'multa-svapo-stazioni-ticino-2026' | 'svizzera-disoccupazione-frontalieri-quadri-2026' | 'allerta-gialla-temporali-varese-2026' | 'ostetriche-eoc-mendrisio-2026' | 'modello-zurigo-violenza-domestica' | 'sepolti-con-animali-domestici-berna-2026' | 'swiss-guasti-voli-frontalieri-ticino-2026' | 'banca-ditalia-varese-10-anni-dopo' | 'svizzeri-contributo-clima-acquisti-online-2026' | 'passeggiata-lago-inverno-ascona-2026' | 'notifiche-frontalieri-ticino-2026' | 'minacce-informatiche-svizzera-2026' | 'gamberetti-torneo-madrid-2026' | 'carburanti-tpl-ticino-2026' | 'scoperta-africa-materia-castronno-2026' | 'universita-ticino-numero-chiuso-2026' | 'pedaggi-autostrada-lombardia-frontalieri' | 'semaforo-paradiso-melide-2026' | 'zurigo-economia-svizzera-crescita' | 'frontalieri-trottinetti-velocita-polizia' | 'ats-insubria-soluzioni-ospedali-2026' | 'avis-lombardia-dono-sangue-privati-2026' | 'varese-moto-storiche-2026' | 'nuovo-contratto-edilizia-ticino-2026' | 'viabilita-varese-racordo-chiuso-2026' | 'furti-biciclette-mendrisiotto-2026' | 'per-giumai-acquisti-monte-piaroi-2026' | 'rovine-magliaso-scuole-nuove-2026' | 'bns-ubs-misure-non-estreme-2026' | 'nuovi-maestri-lavoro-varese-leonardo-2026' | 'cambio-guardia-pro-velo-ticino-sabbadini-vitali' | 'nuovo-ambulatorio-ecocardiografia-busto-arsizio' | 'velafrica-bici-usate-lugano-2026' | 'ospedale-varese-acqua-calda-oncologia' | 'cinque-nordafricani-festnati-auto-aarau' | 'doppio-sequestro-discariche-abusive-varese' | 'sfida-comuni-coop-2026-attivita-fisica' | 'cina-tutela-lavoratori-nuove-occupazioni' | 'usi-ticino-tagli-bilancio-2026' | 'campione-ditalia-elezioni-sindaco-2026' | 'gioventu-dibatte-500-studenti-gara' | 'tallero-doro-80-anni-nuovo-design' | 'conservatorio-bellinzona-valori-musicali' | 'national-geographic-scuola-einaudi-varese' | 'benessere-scolastico-bellinzona-2026' | 'mendrisio-capitale-culturale-opportunita' | 'permesso-g-pro-contro-2026' | 'iniziativa-salari-ticino' | 'cantieri-traffico-a9-ticino' | 'pro-velo-ticino-cambiamento-presidenza-2026' | 'nomine-sims-fallimento' | 'crans-montana-fatture-scontro-roma-2026' | 'ticino-calimero-sindrome-2026' | 'salario-minimo-mediano-ticino-2026' | 'padroncini-lavoratori-stabili-bassi-2025' | 'bcc-busto-garolfo-2-milioni-territorio' | 'nuova-legge-polizia-ticino-controllo-periodico' | 'malpensa-parigi-galline-frontalieri' | 'borsa-zurigo-frontalieri-27-aprile-2026' | 'colpi-arma-da-fuoco-como-ferito-frontaliere' | 'disagi-trenord-tilo-s40-25-aprile-2024' | 'scommesse-guerra-trump-prediction-market' | 'furti-lusso-murten-2026' | 'gestione-illecita-rifiuti-varese-arcisate-2026' | 'frontalieri-ticino-crescita-2026' | 'trasparenza-iniziative-popolari-ticino-2026' | 'tristan-brenn-fischer-decisione' | 'svizzera-brevetti-innovazione-2026' | 'frontalieri-rega-boglia-intervento' | 'equans-licenziamenti-monteceneri-2026' | 'momenti-paura-velivolo-swiss-2026' | 'allerta-meteo-ticino-lombardia-2026' | 'rottamazione-quinquies-scadenza-30-aprile' | 'architettura-sostenibile-ticino-2026' | 'sisa-contro-tagli-governo-2024' | 'pista-ciclopedonale-bodio-giornico-2026' | 'momoride-carpooling-benefico-ticino-2026' | 'kit-escursionisti-montagna-pulita' | 'moda-sostenibile-bellinzona-9-maggio' | 'fuga-ammoniaca-chiasso-controllo' | 'chiasso-ammoniaca-stadio-ghiaccio' | 'fuga-ammoniaca-chiasso-pista-ghiaccio' | 'biglietto-trenord-whatsapp-ticino' | 'tassa-aerei-sostegno-treni' | 'comune-como-appuntamenti-cie-2026' | 'auto-elettriche-ricarica-breganzona' | 'universita-insubria-4-4-milioni-ricerca' | 'airpack-lombardia-41-lavoratori' | 'tassa-aerei-trasporto-pubblico' | 'settimanaprofessionale-ticino-2024' | 'colazione-equo-ticino-9-maggio-2026' | 'costo-energia-varese-impatti-frontalieri' | 'ospedali-varesini-cambiamenti-20-anni' | 'sunrise-integra-hbb-ssr-2026' | 'infermieri-lavoro-ore-settimanali' | 'sorveglianza-telecomunicazioni-ticino-2026' | 'spese-bancarie-titoli-frontalieri' | 'bicicletta-insubria-varese-2026' | 'montessori-green-food-week-2026' | 'passi-solidarieta-porto-ceresio-2026' | 'processo-karimova-archiviazione-parziale' | 'cardiocentro-lugano-ristrutturazione-2026' | 'ex-capo-esercito-kaiser-partner-privatbank' | 'nuove-regole-centri-estivi-saronno-2026' | 'ex-sede-banca-ditalia-vendita-varese' | '139-frontalieri-ticino-special-olympics' | 'gastrobellinzona-andrea-giuliani' | 'infermieri-ticino-ore-lavorative-2026' | 'dezonare-terreni-blenio-2026' | 'dfp-bankitalia-margini-debito-ue-2026' | 'momoride-carpooling-benefico-ticino-2024' | 'borse-zurigo-flessione-2026' | 'traffico-droga-arresti-svizzera-estero-2026' | 'caslano-2025-bilancio-avanzamento' | 'lombardia-piano-ciclabile-115-milioni' | 'sam-mendrisiotto-25-anni-emergenze' | 'nidi-extrascolastico-ticino-un-servizio' | 'ticinesi-parigi-roland-garros' | 'locarno-landquart-rifiuti-1000-tonnellate' | 'stipendi-svizzeri-crescono-2025' | 'tassa-traffico-pesante-lacune-controlli' | 'quadri-interpella-consiglio-frontiere-tasse' | 'fenealuil-decreto-lavoro-2026' | 'bilancio-val-mara-2025-avanzamento-616mila' | 'ambulatorio-cardio-metabolico-villa-san-giuseppe' | 'riforma-ue-disoccupazione-frontalieri' | 'casse-malati-dado-scissione-dossier' | 'iliad-piu-veloci-rete-mobili' | 'formazione-ferrero-ministero-2026' | 'frontalieri-bellinzonese-truffe-16-mesi' | 'decreto-lavoro-meloni-2026-frontalieri' | 'calcio-dnb-belli-crisi' | 'berset-sostegno-reynard-crans-montana' | 'biasca-roller-hockey-uttigen-2026' | 'vuoto-ginevra-olympic-basket' | 'nuova-pista-ciclopedonale-bodio-giornico-2026' | 'lago-como-edition-hotel-lusso' | 'momoride-carpooling-sfida-collettiva' | 'nuove-scuole-vernate-neggio-2026' | 'casse-malati-ticino-divise-2026' | 'cina-spostamenti-frontalieri-primo-maggio' | 'lugano-cultura-digitale-2024' | 'fondazione-xenia-patto-generazionale' | 'europa-dal-basso-regioni-podcast-bianchi' | 'viggi-bando-giovani-comunit-2026' | 'furti-centro-pacchi-cadenazzo' | 'fattura-miliardaria-energia-medio-oriente' | 'riforma-infermieri-ticino-2026' | 'emergenza-casa-como-analisi' | 'iniziativa-f-35-ticino-2026' | 'giro-e-angera-verbania-2026' | 'iniziative-casse-malati-dado-scissione-dossier' | 'moschea-pregassona-udc-interroga-municipio' | 'como-area-camper-26-posti-lavori' | 'caricabatteria-unico-portatili-2024' | 'ufficio-open-space-stress-frontalieri' | 'estival-pagamento-caduta-stile-lugano' | 'giornata-contro-rumore-lugano-2024' | 'estival-jazz-lugano-pagamento-2024' | 'varese-sostenibilita-csr-camera-commercio' | 'lombardia-30-milioni-quartiere-efficientamento' | 'moschea-lugano-pregassona-2026' | 'fuga-ammoniaca-chiasso-causa-trovata' | 'unitas-80-anni-innovazione-inclusione' | 'dfp-giorgetti-deficit-ridotto' | 'castiglione-olona-ufficio-postale-riaperto' | 'programmi-educativi-bellinzona-2026' | 'aeroporti-milano-boom-fatturato-197-milioni' | 'servizio-clienti-bancario-promossi-bocciati' | 'agricoltura-spaziale-svizzera-ricerca' | 'ubs-lobbying-parlamento-ticino-2026' | 'nuovo-presidente-gastro-bellinzona' | 'varese-ospedale-parcheggi-personale-2026' | 'coalizione-sanitario-volonta-calpestata' | 'volo-swiss-evacuato-passeggeri-bagaglio' | 'banche-golfo-frontalieri-ticino-2026' | 'rilanciare-commercio-saronno-2026' | 'lugano-aggressione-abitazione-2024' | 'furti-chiese-ticino-rumeni-fermati' | 'attentato-washington-trump-2026' | 'casa-montana-nante-governo-regolare' | 'neuchatel-palloncini-lanterne-vietati' | 'vaud-parlamento-dimissioni-dittli' | 'rogo-san-fermo-battaglia-2024' | 'terremoto-san-gallo-2026' | 'infermieri-indipendenti-ticino-2026' | 'deposito-carrozzeria-sequestrato-como-2026' | 'agesp-rifiuti-primo-maggio-2026' | 'stop-cinese-acquisizione-manus-implicazioni' | 'gita-cuore-soncino-saronno-point' | 'decreto-lavoro-meloni-frontalieri-ticino' | 'othermovie-lugano-2026-god-witness' | 'emporio-solidarieta-olgiate-olona' | 'estival-jazz-lugano-cambia-formula-2026' | 'eurovision-ballad-ticino-2026' | 'unitas-ottantesimo-futuro-ticino' | 'como-io-ho-segnalato-ma-il-comune-non-ne-vuole-sapere' | 'ucraina-russia-droni-2026' | 'play-suisse-novita-streaming-2026' | 'dehors-como-ricorso-tar-20-maggio' | 'bruno-breguet-scomparsa-ufficializzata' | 'profumo-prato-tagliato-grido-aiuto-piante' | 'novartis-calo-utile-2026' | 'taglio-accise-proroga-meloni-2026' | 'fedpol-arresto-corruzione-2026' | 'momoride-benefico-mendrisiotto-2024' | 'uzbekistan-oro-gas-ticino-implicazioni' | 'attentato-washington-trump-2026-analisi' | 'spese-militari-2025-aumento-2900-miliardi' | 'karimova-processo-bellinzona-2026' | 'truffe-sentimentali-zurigo-2026' | 'esposizione-segughi-malvaglia-2026' | 'ragazza-morta-campo-perquisita-casa-amico' | 'violenza-domestica-misure-urgenti' | 'robot-umanoidi-maratona-fascinazione' | 'guida-svizzera-frontalieri-ticino' | 'commesse-pubbliche-servizi-essenziali-2026' | 'frontalieri-ticino-sentono-criminali' | 'esubero-leventina-zone-edificabili-2026' | 'varese-corsi-net-opportunita-rete-sinergie-2026' | 'centri-responsabilita-frontalieri-ticino' | 'incontro-sem-cantone-comuni-annullato' | 'centrosinistra-varese-patto-2027' | 'magadino-parco-giochi-nuova-area-ludica' | 'incidente-valle-verzasca-2026' | 'guida-affettuosa-separazione-ticino-2026' | 'processo-tentato-omicidio-chiasso-2026' | 'varese-cultura-2030-ecosistema-culturale' | 'casa-montana-nante-ricorso-tram' | 'atleti-ticinesi-vittoria-arcegno-ascona' | 'malnate-comitati-quartiere-bilancio-partecipativo' | 'casa-montana-nante-voto-validato' | 'furti-cantine-luganese-condannato' | 'varese-corsi-parlare-pubblico-2026' | 'svizzera-10-milioni-votazione-ticino' | 'lombardia-tassa-sanitaria-frontalieri-2026' | '730-precompilato-frontalieri-ticino-2026' | 'tosatura-pecore-riparazione-vestiti-bellinzona-2026' | 'geopolitica-sindacato-nuovi-equilibri-varese' | 'ferrara-m5s-beko-cassinetta-verifica' | 'azienda-comasca-fotovoltaico-25-tonnellate-co2' | 'citta-fiore-orticolario-tricolore-2026' | 'friborgogotteron-spareggio-titolo-hockey' | 'como-verdi-elogio-rapinese-alberi' | 'petrolio-gas-svizzera-approvvigionamento-sicuro' | 'von-der-leyen-ue-energia-500-milioni-giorno' | 'svizzera-cashless-bns-sistema-equo' | 'avs-dati-digitale-frontalieri' | 'scorte-carburante-svizzera-2026' | 'swiss-duty-free-addio-30-settembre' | 'momoride-carpooling-frontalieri-benefici' | 'swiss-duty-free-fine-vendite-bordo' | 'incidente-aarau-18enne-frontaliere' | 'san-gallo-vince-thun-ritardo-festa' | 'hupac-busto-utile-positivo-collegamenti' | 'hupac-bilancio-positivo-2025' | 'infermieri-orario-lavoro-ticino-2026' | 'rumore-traffico-svizzera-500-morti-anno' | 'frontalieri-ticino-parchi-vandalismo-2026' | 'spacchettamento-casse-malati-2026' | 'athora-italia-previdenza-complementare-2026' | 'annuario-impresari-2026-ticino' | 'via-francisca-10-anni-turismo-ticino' | 'scuola-viganello-gaza-gemellaggio-2026' | 'digitalizzazione-avs-ai-frontalieri' | 'celti-tradate-parco-pineta-2026' | 'canapa-losanna-bilancio-positivo-2026' | 'estival-jazz-marti-ritiro-2026' | 'licata-lombardia-bulgaria-opportunita' | 'maroggia-servizi-postali-2026' | 'gemellaggio-scuole-viganello-gaza-2026' | 'laurent-morel-nominato-direttore-ef-svizzera' | 'san-gottardo-secondo-tubo-caduto-diaframma' | 'venditti-estival-lugano-2026' | 'accordo-syndicom-vsm-2026' | 'philipp-plein-mendrisio-interrogazione' | 'mercatino-primavera-lugano-2026' | 'italia-svizzera-ricerca-2026' | 'ricerca-italiana-ginevra-2026' | 'svizzera-serbia-cooperazione-2026' | 'chi-finanzia-politica-svizzera-2026' | 'accordo-lago-maggiore-italia-svizzera-2026' | 'webinar-ai-azienda-strategia-casi-concreti' | 'comunita-montana-valli-verbano-incontri-natura-cambia' | 'innalzamento-lago-maggiore-140-metri' | 'guardie-svizzere-giuramento-vaticano-2026' | 'apprendistato-varese-2-7-ingressi-lavoro' | 'casa-hockey-lugano-ambri-2026' | 'swiss-duty-free-cambia-vendite-2026' | 'tutor-sapiens-apprendistato-terzo-livello' | 'tunnel-tonale-viabilita-lombardia' | 'spring-giubiasco-sport-convivialita-2026' | 'carnago-forza-italia-pendolarismo' | 'usa-svizzera-frizioni-commerciali-2026' | 'terremoto-gottardo-frontalieri' | 'benzina-record-annuale-svizzera-2026' | 'giovane-gambizzato-como-2026' | 'andre-wyss-nuovo-presidente-ffs' | 'moncucco-risultati-positivi-2025' | 'bellinzona-datore-lavoro-conciliabilita' | 'mendrisio-conti-positivi-2025' | 'criminalita-organizzata-svizzera-2026' | 'stazioni-sciistiche-ticino-contributi-2026' | 'ubs-keller-sutter-lobbismo-2026' | 'daverio-gazzada-assistenza-medica-2026' | 'trivella-san-gottardo-zona-faglia' | 'ambulatori-medici-temporanei-varese-2026' | 'copernicus-clima-2025-europa' | 'credinvest-bank-crescita-2026' | 'riforma-frontalieri-costi-svizzera' | 'conciliabilita-vita-lavoro-bellinzona-2026' | 'chiasso-assassinio-mancato-15-anni-carcere' | 'lite-dogana-ponte-chiasso-ferito-contuso' | 'intesa-sanpaolo-premia-10-imprese-vincenti' | 'pillola-giorno-dopo-consulenza-nazionale' | 'sindaci-verbania-baveno-cannobio-opposizione' | 'mendrisio-bilancio-positivo-2025' | 'terzo-frigo-tenero-anti-spreco' | 'frontalieri-disoccupazione-stato-lavoro' | 'lavoro-openjobmetis-2026-opportunita' | 'openjobmetis-materia-castronno-2026' | 'vaiolo-delle-scimmie-ticino-2026' | 'maroggia-postale-domestico-2024' | 'convegno-milano-mafia-italia-svizzera-2026' | 'gruppo-moncucco-2025-risultati' | 'distretto-benessere-campo-fiori-2026' | 'chiusure-ospedale-circolo-varese-2026' | 'svizzera-overtourism-lucerna-grindelwald' | 'alluvione-lavizzara-piano-pericoli-approvato' | 'bedretto-lab-microterremoti-ricerca' | 'microterremoto-ticino-successo-test' | 'festa-famiglie-lugano-2026' | 'stop-milioni-casse-malati-club-sportivi' | 'delusi-svizzera-frontalieri-abbandonati' | 'separazioni-ticino-famiglie-monoparentali' | 'dichiarazione-precompilata-2026-disponibile' | 'moncucco-utile-raddoppiato-2026' | 'domenica-natura-spazio-tradate-2026' | 'lago-maggiore-innalzamento-2026' | 'usa-critica-svizzera-bio-duopolio' | 'dl-bollette-novita-consumatori-2026' | 'bonus-sicurezza-2026-frontalieri-ticino' | 'palma-muralto-ristrutturazione-strategia-2024' | 'gev-ticino-ambiente-2026' | 'siccita-lombardia-riserve-idriche-2026' | 'fed-powell-addio-tassi-invariati' | 'ubs-utile-3-miliardi-2026' | 'borse-europee-zurigo-trimestrali' | 'supsi-20-nuovi-professori-2026' | 'italian-e-bike-tragedy-bern' | 'violenza-sessuale-conseguenze-ticino' | 'mendrisio-bilancio-positivo-2025-analisi' | 'ubs-credit-suisse-integrazione-risultati-2026' | 'varese-digitale-3d-visita' | 'varesotto-paperoni-lago-maggiore-2026' | 'regione-lombardia-4-4-milioni-insubria' | 'luve-hyperscaler-ai-accordo-100-milioni' | 'social-media-frontalieri-ticino' | 'stazioni-sciistiche-ticino-credito-dati-2026' | 'lavori-notturni-via-clemente-maraini' | 'parcheggi-ospedale-circolo-varese-2026' | 'mani-pulite-vite-salvate-asst-iniziativa' | 'manager-insubria-rasizza-battioni-4-maggio' | 'lavoro-etico-convegno-liuc-ucid' | '1maggio-eremo-monastero-legge-varese' | 'vergiate-color-run-2026-non-competitiva' | 'due-scuole-due-mondi-un-solo-legame' | 'camion-incastrato-grantola-2026' | 'vedano-olona-medici-servizio-instabile' | 'elmec-innovation-summit-brunello-2026' | 'scuola-austriaca-bitcoin-lugano-2026' | 'domus-san-donato-autonomia-terza-eta' | 'moda-sostenibile-varese-2026' | 'sciopero-fame-timoc-terreno-conteso' | 'ispra-pranzo-solidale-oratorio-2026' | 'malpensa-contanti-sequestri-370mila-euro' | 'grigioni-stretta-permessi-mafia-roveredo' | 'restringimento-a2-ritardi-2026' | 'repressione-cinese-svizzera-ong-critiche' | 'traffico-intenso-a2-lugano-ritardi' | 'ritardi-a2-tra-chiasso-lugano' | 'a2-corsia-ritardi-lugano-2026' | 'aquanexa-visita-acquedotto-alfa-laveno' | 'bollino-rosso-a2-chiasso-lugano-2026' | 'pnrr-disabilita-medio-olona-715mila-euro' | 'problemi-casellario-giudiziale-varese-2026' | 'comco-inchieste-pubblicita-online-2026' | 'glaciazione-demografica-ticino-2026' | 'a2-traffico-ritardi-lugano-2026' | 'roberto-grassi-nuovo-presidente-liuc-castellanza' | 'ia-selezione-personale-rischi-ticino' | 'denatalita-ticino-azione-urgente-2026' | 'beko-cassinetta-risultati-2026' | 'samantha-bourgoin-apisuisse-2026' | 'birdwatching-monteviasco-2026' | 'gallarate-bilancio-cassani-2026' | 'certificazione-greco-antico-lombardia-2026' | 'rokj-lugano-serata-solidale' | 'varese-fogliaro-san-giuseppe-2026' | 'polizia-ticinese-fase-progettuale-conclusa' | 'a2-melide-chiusure-notturne-lavori' | 'sanzioni-ue-imprese-italiane-2026' | 'varese-lavoro-specializzato-paradosso-2026' | 'varese-competenze-lavoro-2026' | 'kof-barometro-ripresa-economica-2026' | 'parita-paura-frontalieri-ticino' | 'presunti-maltrattamenti-asilo-chiasso' | 'commercio-dettaglio-ricavi-ticino-2026' | 'contibellinzona-2025-risultati' | 'italia-inadempiente-crediti-sanitari' | 'settore-alberghiero-ricavi-2025' | 'berna-skopje-scambi-economici-2026' | 'conti-bellinzona-2025-balzo-11-milioni' | 'contibellinzona2025risultati' | 'disoccupazione-ticino-usi-2026' | 'cessione-bper-bcc-varese-2026' | 'innalzamento-livello-verbano-impatti-economici' | 'barometro-kof-ripresa-modesta-2026' | 'inflazione-aprile-2026-italia' | 'azienda-bardello-cerca-operatore-cnc' | 'divario-irpef-pensionati-2026' | 'comco-inchieste-keyword-bidding-2026' | 'dezonamenti-ticino-2026-confronti' | 'pizza-bibita-costi-citta' | 'education-day-confindustria-varese-2026' | 'riforma-polizia-ticino-progetto-fermo' | 'ffs-siemens-nuovi-treni-ticino' | 'passaporto-poste-italiane-uffici' | 'comco-indaga-pubblicita-motori-ricerca' | 'record-passeggeri-treni-svizzera-2026' | 'ferrovia-svizzera-300-progetti-2026' | 'bce-tassi-invariati-30-aprile-2026' | 'aumenti-tariffe-sunrise-2026' | 'settore-ict-ticino-riconoscimento-istituzioni' | 'bce-tassi-inflazione-ticino-2026' | 'microterremoto-artificiale-ticino-2026' | 'flotilla-svizzera-gaza-2026' | 'clausole-sunrise-illegittime-2026' | 'lidl-formazione-duale-gdo-ticino' | 'lugano-red-carpet-contribuenti-2026' | 'trenord-disservizi-frontalieri-2026' | 'pulmino-elettrico-granello-cislago-2026' | 'ambrogio-castiglioni-digital-industries-world' | 'aumento-spese-carburante-air-france-2026' | 'trenord-ritardi-frontalieri-2026' | 'polizia-ticinese-progetto-concluso' | 'bike-sharing-como-gratis-giugno' | 'guerra-iran-industria-alimentare-2026' | 'rientro-a2-incubo-30-aprile-2026' | 'ultimo-giorno-funivia-santis-2026' | 'primo-maggio-varese-acli-lavoro-dignitoso' | 'crans-montana-700-dossier-consultori' | 'perequazione-ticino-frontalieri-2026' | 'viabilita-camion-travedona-2026' | 'casa-comunita-luino-punto-unico-accesso' | 'bellinzona-2025-consuntivo-risultati' | 'iniziativa-democrazia-respinta-2026' | 'primo-maggio-varese-2026-storia-e-trasformazioni' | 'primo-bilancio-centri-violenza-2026' | 'addio-giovanni-salandin-cgil-frontalieri' | 'guardia-medica-como-ponte-maggio-2026' | 'bilancio-provincia-varese-1-5-milioni' | 'varese-citta-piu-verde-2026' | 'denuncia-strisce-pedonali-como-2026' | 'emergenza-acqua-lombardia-2026' | 'bambino-annegato-morcote-30-aprile-2026' | 'solaro-chiude-ambulatorio-medico' | 'piano-pandemico-2025-2029-approvato' | 'polizia-ticino-progetto-zali-comuni' | 'ffs-siemens-116-treni-suburbani-ticino-2026' | 'chiusure-melide-autostrada-2026' | 'webuild-csc-rinnovo-sede-onu-ginevra' | 'migranti-pasture-progetto-congelato' | 'ricavi-alberghi-ticino-2025-crescita' | 'controllo-finanze-ticino-2026' | 'swiss-market-index-verde-2026' | 'bcc-crowdfunding-100mila-euro' | 'truffatrice-seriale-como-lecco-2026' | 'passaporto-musei-svizzera-30-anni-record' | 'confindustria-como-arte-cultura-salute-13-maggio' | 'sunrise-pratiche-abusive-fermate-2026' | 'proroga-accise-carburanti-2026' | 'polizia-ticinese-progetto-abbandonato-2026' | 'summer-camp-malnate-tenuta-novella' | 'liuc-golf-frontalieri-accordo-2026' | 'pillola-giorno-dopo-vendita-libera-2026' | 'isolino-virginia-riapre-2026' | 'sostenibilita-salone-csr-varese-2026' | 'film-the-sea-varese-gaza-2026' | 'crans-montana-nuovo-solco-italia-svizzera-2026' | 'eurodreams-vincita-rendita-22mila-franchi' | 'piano-casa-meloni-emergenza-abitativa' | 'targhe-personalizzabili-quadri-approvazione' | 'trenord-indennizzi-pendolari-como-2026' | 'ponte-brivio-cantiere-14-milioni' | 'ponte-maggio-villa-panza-laboratori-bambini' | 'furti-luoghi-culto-bellinzonese' | 'hockey-nl-psicodramma-davos-2025-2026-friborgogotteron' | 'made-in-switzerland-2026' | 'dialogo-popoli-colori-mondo-busto-arsizio' | 'cavalli-droni-esercito-svizzero-2026' | 'raiffeisen-bioggio-rinnovo-2026' | 'percorso-giubiasco-qui-allora-2026' | 'nomina-docenti-comunali-ticino-2026' | 'cardano-settimana-ecologica-raee-2026' | 'grassi-liuc-sfide-complesse' | 'ciclabile-saronno-rovello-porro-2026' | 'fiera-asparago-cantello-2026' | 'cinque-cose-asparago-cantello-2026' | 'sigarette-elettroniche-adolescenti-ticino-2026' | 'processo-bellinzona-merci-russia-2026' | 'trump-riduce-truppe-italia-spagna' | 'whisky-scozzese-dazi-trump-carlo-camilla' | 'incidente-fino-mornasco-30-aprile-2026' | 'galleria-gottardo-secondo-tubo-2026' | 'varese-bilancio-2026-avanzo-record' | 'nuovo-direttore-controllo-finanze-ticino' | 'riapre-ufficio-postale-casale-litta' | 'furti-chiese-negozi-ticino-arresti' | 'audit-polizia-ticino-2026' | 'tassa-salute-frontalieri-lombardia-piemonte' | 'zonaprotetta-40-anni-sessualita-consapevole' | 'cina-turismo-interno-2026' | 'mondiali-2026-iran-italia-fifa' | 'crystal-palace-finale-conference-rayo' | 'trump-cina-russia-patto-2026' | 'primo-maggio-unita-sindacale-marghera' | 'primo-maggio-sindacati-piazza-2026' | 'spasso-weekend-1-maggio-varese-2026' | 'prevenzione-dipendenze-ticino-2026' | 'concertone-primo-maggio-roma-artisti-2026' | 'mondo-radio-piange-alberto-davoli' | 'rendiconto-banca-interpretazione-2026' | 'inchiesta-arbitri-roccchi-inter-roma' | 'dramma-canton-ticino-bimbo-annega-piscina' | 'gioco-oca-giornico-rischi-disastri' | 'primo-maggio-2026-ticino-solidarieta' | 'piano-freddo-como-200-persone-172-notti' | 'como-studenti-polizia-on-road-2026' | 'ticinosentieri-nuove-nomine-2026' | 'ufficio-postale-val-mara-chiusura' | 'controversia-bandiera-svizzera-scarpe-on' | 'giovani-sigarette-elettroniche-ticino-2026' | 'frontalieri-disoccupazione-svizzera-2026' | 'cbt-italia-ciclisti-mercato' | 'maserati-tridente-centenario-2026' | 'iniziativa-10-milioni-sostenibile' | 'click-fatture-servizio-hot' | 'festa-fragole-camorino-beneficenza' | 'lite-notturna-brogeda-2026' | 'crans-montana-fatture-ospedali-2026' | 'crans-montana-aiuto-vittime-700-dossier' | 'zanzara-tigre-losone-2026' | 'rive-libere-minusio-tenero-2026' | 'berna-senza-pubblicita-iniziativa-2026' | 'lago-maggiore-sale-ambiente-2026' | '25-centimetri-lago-maggiore-frontalieri' | 'lungolago-como-parapetti-rapinese-sertori' | 'como-napoli-sinigaglia-divieti-posteggi' | 'primo-maggio-varese-2026-lavoro-diritti' | 'algerini-libici-auto-polizia-arresti' | 'rete-stradale-mendrisio-interventi-urgenti' | 'lavori-autostradali-a8-milano-varese' | 'primo-maggio-2026-ticino-sindacati' | 'como-arresto-frontaliere-tunisino' | 'indagine-soccorsi-crans-montana-2026' | 'crans-montana-italia-parte-civile-2026' | 'gysin-candidata-capogruppo-verdi' | 'sesto-calende-strade-cantieri-2026' | 'jans-udc-iniziativa-10-milioni' | 'lago-maggiore-135-metri-frontalieri' | 'anziani-truffati-arresto-como-ticino' | 'bellinzonesi-germania-karate-2026' | 'chiusura-notturna-a9-lomazzo-chiasso' | 'como-festa-lavoro-diritti-salari' | 'denuncia-soccorsi-crans-montana-2026' | 'incidente-cantu-due-feriti' | 'primo-maggio-torino-tensioni-askatasuna' | '142-violenza-ticino-2026' | 'primo-maggio-2026-traffico-gottardo' | 'incidente-e-roller-lugano-2026' | 'processo-campione-dicembre-2026' | 'ingresso-gratuito-museo-costume-bagno' | 'lavori-autostradali-a8-chiusure' | 'festa-danzante-ticino-2026-spettacoli' | 'pregassona-festa-400-fonio-iniziativa-udc' | '142-numero-aiuto-vittime-ticino' | 'ponte-l-acqua-ticino-2026' | 'nuovo-canile-varese-duni-2026' | 'festa-fritti-glam-varese-2026' | 'alta-mesolcina-sfida-movimento-2026' | 'flotilla-gaza-varese-presidio-montegrappa' | 'orso-valposchiavo-2026-ritorno' | 'gallarate-borse-studio-2026' | 'primo-maggio-2026-ticino-sindacati-iniziativa-udc' | 'lavoro-scende-piazza-lugano-2026' | 'radar-ticino-velocita-2026' | 'primo-maggio-zurigo-basilea-2026' | 'rive-libere-ascona-2026' | 'mezzi-pesanti-biandronno-2026' | 'trump-dazi-ue-frontalieri-ticino' | 'balerna-consiglio-comunale-centenario' | 'confsal-manifesto-lavoro-dignita-salari' | 'usa-iran-nucleare-sanzioni-2026' | 'sicurezza-locali-pubblici-convegno-ville-ponti' | 'sospetta-fuga-gas-londra-metro-chiusa' | 'cassis-aragchi-colloquio-iran' | 'colosso-35-tonnellate-legnano' | 'riapre-villa-visconti-lainate-2026' | 'teheran-proposta-pakistan-mediatori' | 'inflazione-svizzera-frontalieri-ticino' | '142-linea-aiuto-vittime-violenza-ticino' | 'collisione-cadegliano-varese-ferito-54enne' | 'congresso-lugano-cancro-prostata-2024' | 'circolo-albate-riapertura-2026' | 'aranno-incidente-moto-ricoverato-uomo' | 'como-viaggio-nel-tempo-2026' | 'como-volta-faro-rapinese-6-milioni' | 'controlli-velocita-ticino-maggio-2024' | 'primo-maggio-ticino-salari-2024' | 'sosta-selvaggia-moltrasio-2026' | 'svizzera-hockey-sconfitta-svezia' | 'lambrugo-incidente-74enne-ospedale' | 'delia-bella-ciao-concertone-2026' | 'funivia-santis-ammodernamento-2026' | 'cinque-curiosita-brevetti-svizzeri-2026' | 'liberta-stampa-minimi-25-anni' | 'villaggio-angelo-busto-arsizio' | 'chiese-ticino-derubate-2026' | 'sindacati-ticino-1-maggio-2026' | 'polizia-ticino-abbandono-progetto-2026' | 'tragedia-vico-morcote-bimbo-piscina' | 'crans-montana-soccorso-denunciato' | 'ia-meteo-eventi-estremi' | 'tentato-assassinio-chiasso-2026' | 'primo-maggio-2026-svizzera-cortei' | 'guardie-svizzere-2025-intenso' | 'siccit-estate-2026-ticino' | 'polizia-ticino-progetto-abbandono-2026' | 'iniziativa-democrazia-respinta-nazionale' | 'uisp-scuola-dante-varese-2026' | 'ricostruzione-capanna-soveltra-avanza' | 'processo-quadroni-ex-capo-posto-contesta-accuse' | 'docente-arrestato-giubiasco-proroga' | 'angelo-custode-ia-colpo-sonno' | 'agenzia-formativa-varese-dimissioni-2026' | 'presentazione-libro-odio-massacro-varese' | 'fattura-miliardaria-energia-2026' | 'arco-e-frecce-per-far-centro' | 'museo-paesaggio-verbania-gratis-2026' | 'biandronno-incontro-astuti-licata-2026' | 'gratis-museo-costume-bagno-2026' | 'ippodromo-varese-svicc-allenatori' | 'luigi-bignami-insubria-scienza-2026' | 'busto-arsizio-carcere-denuncia-strada' | 'bracconaggio-ittico-lago-maggiore-ispra-2026' | 'maggiolone-social-park-cassano-magnago' | 'grassi-1925-marchio-storico' | 'lati-industria-termoplastici-premiata-intesanpaolo' | 'progettare-sala-riunioni-ufficio' | 'giovani-agenti-como-polizia-locale' | 'gallarate-fondazione-scuole-materne-2026' | 'formula-1-riparte-rischi-polemiche' | 'unitalsi-busto-varese-malati-spiritualita' | 'isola-artica-islanda-pugliese' | 'cioccolato-illumina-bellinzona-2026' | 'varese-luna-park-schiranna-2026' | 'mera-longhi-130-anni-dolcezza-varese' | 'girometta-doro-andrea-chiodi-varese-2026' | 'concerto-luino-vivaldi-bach-2026' | 'musica-antica-san-cassiano-2026' | 'cinque-mostre-maggio-gallarate-verbania-2026' | 'mal-dislanda-materia-castronno-2026' | 'frontaliere-pensione-avs-inps-2026-errori-comuni' | 'attivisti-flotilla-israele-interrogati' | 'massiccio-intervento-polizia-lugano-2026' | 'giovani-rematori-ceresio-2026' | 'permesso-g-b-2026-20km-frontalieri' | 'cure-domicilio-pensionati-ticino-2026' | 'libriamoci-varese-studenti-2026' | 'vino-alto-ticino-scudellate-2026' | 'corteo-pro-palestina-lungolago-lugano' | 'divieti-social-media-minori' | 'primo-maggio-baume-schneider-sanita-avs' | 'migros-immigrazione-necessaria-offerta' | 'vico-morcote-tragedia-bambino-pool' | 'limiti-eta-smartphone-social-media' | 'volandia-battesimo-volo-elicottero-2026' | 'banche-golfo-preparano-frontalieri' | 'papa-paperino-cuasso-monte' | 'venezia-serie-a-promozione-2026' | 'meloni-governo-longevo-2026' | 'abbonamento-newsletter-ticino' | 'varese-arrampicata-salewa-cube-2026' | 'migros-immigrazione-necessaria-2026' | 'nuova-viabilit-travedona-monate-2026' | 'graudio-flash-2-maggio-2026' | 'investimenti-immobiliari-italia-estero-2026' | 'carenza-carburante-svizzera-2026' | 'ermotti-respinge-accuse-lobbying-ubs' | 'addio-alex-zanardi-2001-incidente-vita' | 'caronno-varesino-campetto-dante-mercanti-2026' | 'confederazione-valuta-sistemi-difesa-aerea' | 'penuria-carburante-svizzera-2026' | 'vittoria-bagatin-tappa-turchia' | 'taglio-accise-carburanti-22-maggio' | 'aiuti-svizzera-ucraina-2026' | 'bus-elettrici-lugano-problemi-utenti' | 'gala-sorriso-solidarieta-ospedale-del-ponte' | 'varese-incendio-palazzo-frontalieri' | 'carenza-carburante-svizzera-frontalieri' | 'scontro-polizia-lugano-spray-urticante' | 'saronno-bar-licenza-sospesa-rissa' | 'movieri-traffico-ss340-2026' | 'doppietta-frontalieri-santonino-2026' | 'taglio-accise-carburanti-maggio-2026' | 'yoga-meditazione-villa-lago-como' | 'como-cantu-creativity-week-2026' | 'commercio-al-dettaglio-mini-flessione-marzo-2026' | 'rissa-lugano-pensilina-botta-feriti-2026' | 'rissa-lugano-primo-maggio-2026' | 'protezione-vittime-142-ticino-2026' | 'golasecca-esplorazione-passeggiata-2026' | 'marcia-zurigo-disabilita-uguaglianza' | 'nuovi-posti-moto-lago-como' | 'guardia-medica-somma-lombardo-lonate-pozzolo' | 'panchina-bianca-varese-2026' | 'furti-chiese-bellinzonese-arresti-2026' | 'a4-milano-brescia-diviazione-obbligatoria-2026' | 'editto-canonizzazione-don-roberto-malgesini' | 'beat-jans-10-milioni-comunicazione' | 'a4-milano-brescia-chiusura-notturna-2026' | 'via-giannino-landoni-fagnano-olona-inaugurazione' | 'scontri-lugano-pensilina-2024' | 'gordola-santa-maria-ricorso-2026' | 'vino-amaro-vallese-2026' | 'beatificazione-don-roberto-malgesini-2026' | 'lago-segrino-camper-2026' | 'cavalli-esercito-svizzero-costi' | 'svizzera-hockey-sconfitta-finlandia' | 'pd-como-sfiducia-maccabeo-2026' | 'patriot-ritardo-svizzera-valuta-alternative' | 'bambini-carabinieri-como-2026' | 'incendio-malpensa-terminal-1-2-maggio-2026' | 'parcheggio-abusivo-como-villa-olmo' | 'svizzera-caccia-evasori-fiscali-2026' | 'landsgemeinde-glarona-2026' | 'aeroporto-lugano-costi-interpellanza' | 'agricoltura-ticino-allarme-2024' | 'seco-dazi-segreti-washington' | 'frontaliere-cambio-chf-eur-strategia-2026-simulazione-pratica' | 'laghi-lombardi-sicurezza-estate-2026' | 'riforma-commissioni-federali-2026' | 'piogge-intense-ceresio-2026' | 'incendio-langnau-due-case-garage' | 'domenica-corriere-piccaluga-lavoro-salari-economia' | 'campagna-iraniana-allarma-svizzera' | 'area-sosta-fantasma-sicurezza-autostrada' | 'aumento-prezzi-carburanti-maggio-2026' | 'incendio-bellinzona-appartamento-evacuato' | 'permesso-g-vs-b-2026-famiglia-figli' | 'incendio-bellinzona-via-borromini-evacuati' | 'polizia-bandi-4500-posti-2026' | 'casse-malati-alloggi-landsgemeinde-2026' | 'dancing-shoes-albertoni-cinelli-collaboration' | 'landsgemeinde-glarona-2026-finanze-alloggi' | 'como-vivibile-frontalieri-2026' | 'calcio-dnb-bellinzona-ultimo-appello' | 'parcheggi-cernobbio-ticino-residenti' | 'vandalismo-bar-bellinzona-2026' | 'brebbia-19enne-grave-incidente-fabbrica' | 'aeroporto-lugano-costi-interpellanza-2025' | 'incendio-malpensa-terminal-1-risolto' | 'maillard-uss-udc-iniziativa-1-maggio-2026' | 'cervelat-salsiccia-nazionale-svizzera' | 'amare-politica-luino-2026' | 'cassis-araghchi-colloquio-2026' | 'corsi-vela-adulti-luino-avav-2026' | 'incendio-bellinzona-via-borromini-evacuati-10-persone' | 'agricoltura-ticino-prodotti-locali-eventi-2026' | 'turismo-como-frontalieri-2026' | 'omegna-ciclista-precipita-scarpata-ricovero-rosso' | 'usa-missili-germania-2026' | 'mensa-solidarieta-degrado-sicurezza-2026' | 'laboratorio-estivo-museo-moesano-2026' | 'varese-lago-perduto-memoria-comunita' | 'rischi-petrolio-lugano-3-maggio-2026' | 'lavori-a9-lomazzo-saronno-chiusura-notte' | 'petrolio-uccide-protesta-vezia-2026' | 'sun-valley-festival-malvaglia-2026' | 'pulizia-lago-lemano-2026' | 'crans-montana-fondi-avvocati-vittime' | 'disordini-pensilina-botta-lugano-2026' | 'scontri-pensilina-lugano-violenza' | 'neutalia-bilancio-2025-crescita-ricavi' | 'life-run-gallarate-2026-successo' | 'usa-petrolio-export-hormuz-impatti-ticino' | 'marchirolo-primo-maggio-2026' | 'schianto-a9-turate-feriti-frontalieri' | 'inter-scudetto-chivu-2026' | 'tragedia-lago-como-frontalieri' | 'incidente-autolaghi-donna-ferita' | 'incidente-a9-turate-feriti-frontalieri' | 'varese-trento-playoff-basket-2026' | 'varese-caduta-canale-frontaliere' | 'incidente-a2-lodrino-frontalieri' | 'league-ticino-border-closure-proposal-2026' | 'petrolio-gas-sicuro-ticino-2026' | 'negoziati-stallo-iran-usa-2026' | 'inter-scudetto-2026-frontalieri' | 'austriaci-ferma-verifica-2026' | 'statua-volta-como-2026' | 'scia-luminosa-ticino-2026' | 'fiaccola-sacconago-speranza-amicizia' | 'ingorgo-taxi-boat-como-2026' | 'controlli-cantu-movida-nero-2026' | 'como-napoli-pareggio-2026' | 'varese-incontro-violenza-psicologica-disturbi-alimentari' | 'retromarcia-contromano-faido-chiggiogna-2026' | 'lugano-young-boys-cornaredo-2026' | 'tragedia-falleatsche-frontalieri' | 'verbania-clandestino-espulsione-2026' | 'cof-lanzo-igiene-mani-2026' | 'grasshopper-zeidler-allenatore-2026' | 'disordini-pensilina-lugano-intervento-veloce' | 'disordini-pensilina-lugano-intervento-veloce-2026' | 'teresina-cerini-100-anni-coglio' | 'svizzera-cechia-rigori-4-maggio-2026' | 'orso-valposchiavo-frontalieri-2026' | 'thun-campionato-calcio-2026' | 'scudetto-varese-frontalieri-2026' | 'anguria-pannelli-incendio-ticino-2026' | 'tiro-sportivo-veterani-junghi-2026' | 'fc-thun-campionato-2026-ticino' | 'incidente-maloja-frontaliere-2026' | 'thun-campionato-calcio-2026-festa-thun' | 'varese-playoff-lavagnese-2026' | 'casa-hockey-ticino-novita' | 'tessile-arte-giovani-generazioni-como' | 'crans-montana-incendio-riciclaggio-2026' | 'antonelli-vince-gp-miami-2026' | 'tre-morti-hantavirus-nave-atlantico' | 'juve-verona-1-1-frontalieri-2026' | 'immigrazione-modello-svizzera-2026' | 'csoa-molino-rimozione-macerie-lugano' | 'incidente-riazzino-ciclista-condanna' | 'sergi-presidenza-basket-ticino-2026' | 'ginnastica-artistica-ticino-2026' | 'italia-sospetti-var-minetti-quirinale' | 'azzate-koningsdag-console-olandese-2026' | 'confine-vacallo-clandestini-2026' | 'morte-alex-zanardi-impatti-frontalieri' | 'premio-walo-2026-frontalieri' | 'stresa-espulsione-egiziano-2026' | 'stati-canaglia-2026-aggiornamento-lista' | 'melenchon-candidatura-presidenziali-2027' | 'lugano-renato-steffen-goal-staffa' | 'tribunale-federale-giudici-conviventi-2026' | 'varese-celebra-san-vittore-girometta-oro-2026' | 'iran-invita-sacrificio-frontalieri-2026' | 'piccaluga-udc-dialogo-apertura' | 'bonifici-ritardo-frontalieri-ticino' | 'noleggio-auto-frontalieri-ticino-2026' | 'aargau-festnahmen-2-mag-2026' | 'gambarogno-contributi-costruzione-ricorrenti' | 'lavena-brano-musicale-leone-xiv' | 'giornata-liberta-stampa-unesco-minacce-autocensura' | 'russotto-bellinzona-frontalieri-2026' | 'democrazia-finisce-quando-ticino' | 'belotti-sport-test-scarpe-trail-running-2026' | 'pericoli-minori-iniziativa-10-milioni' | 'agrinatura-sold-out-2026' | 'mezzo-milione-luganese-sviluppo-2026' | 'raccolti-2000-euro-parco-matteo' | 'moleno-piazza-green-chiesa-migliorata' | 'arresto-frauenfeld-30enne-barricato' | 'mercato-lavoro-kof-ripresa-2026' | 'vendite-auto-ticino-2026-stabili-elettrico' | 'indice-pmi-svizzera-ottimismo-2026' | 'campo-talenti-tenero-25-anni' | 'aeroporto-zurigo-traffico-crescita-2026' | 'ffs-ascensione-pentecoste-2026' | 'stralugano-percorsi-frontalieri-2026' | 'camelie-locarno-record-visitatori-2026' | 'disastri-museo-leventina-gioco-oca' | 'ndrangheta-ticino-antimafia-italiana' | 'nuove-accise-carburanti-2026' | 'ponti-primaverili-traffico-ticino-2026' | 'lidl-svizzera-ceo-elvetico' | 'calcio-alpino-ticino-2026' | 'ponti-primaverili-traffico-2026' | 'perbacco-bianchi-bellinzona-2026' | 'bianconeri-corto-muso-2026' | 'stangata-nascosta-tasse-immobiliari' | 'caro-benzina-varese-accise-2026' | 'meloni-cooperazione-mediterraneo-immigrazione' | 'nuovo-questore-varese-sicurezza-frontalieri' | 'nuovo-questore-varese-sicurezza-frontalieri-2026' | 'franzolini-fenealuil-piano-casa' | 'parco-biumo-inaugurazione-2026' | 'parcheggi-blu-como-residenti' | 'proposte-cernobbio-2026-tessile' | 'confisca-preventiva-mafie-svizzera' | 'ospedale-erba-cura-oncologiche-2026' | 'mezzo-milione-franchi-progetti-luganese-2026' | 'tragedia-bellinzona-folgorazione-2026' | 'sicurezza-varese-monte-santo-intervento-comune' | 'arresto-albanese-cocaina-capolago' | 'banca-grigionese-denuncia-centinaia-milioni' | 'parcheggi-blu-como-residenti-difficolta' | 'gallarate-fs-security-2027' | 'incendio-chiasso-palazzina-evacuati-30' | 'mcdonalds-lamone-apertura-2026' | 'maxi-piano-traffico-lago-como-2026' | 'incendio-chiasso-evacuati-trentina-persone' | 'lotta-zanzara-tigre-mendrisio' | 'inaugurato-nuovo-cardiocentro-ticino' | 'guardia-finanza-carburanti-como-2026' | 'nuovo-centenario-chiasso-luciano-bordignon' | 'g7-evian-frontiere-chiuse-2026' | 'distributori-carburante-ticino-2026' | 'dona-spesa-nova-coop-2026' | 'littizzetto-critica-svizzera-crans-montana' | 'fondazione-cariplo-varese-5-milioni-2025' | 'varese-milano-rallentamenti-treni-maggio-2026' | 'controlli-carburanti-como-guardia-finanza' | 'banca-piazza-petruzzella-abt-2026' | 'swiss-market-index-crescita-2026' | 'comco-keyword-bidding-inchieste' | 'autolaghi-chiusura-barriere-antirumore-2026' | 'festa-mamma-solidarieta-2026' | 'a8-chiusure-gallarate-frontalieri' | 'costi-aeroporto-lugano-2026' | 'ladies-run-lugano-2026' | 'crans-montana-meloni-parmelin-2026' | 'gabbiano-bonaparte-ticino-2026' | 'buoni-ristorante-mamme-monoparentali-ticino' | 'incendio-chiasso-operai-ricoverati' | 'hodler-dipinto-eredita-frontalieri' | 'staffette-rossocrociate-pechino-2027' | 'ecolight-camarda-presidente-2026-2028' | 'boom-viaggiatori-treni-2026-ticino' | 'neutralizzazione-stime-immobiliari-2026' | 'neutralizzazione-stime-immobiliari-2026-ticino' | 'barometro-kof-aprile-2026-prospettive-modeste' | 'elicottero-mezzovico-frontalieri' | 'ospedale-universitario-ticino-2026' | 'legge-quadro-florovivaismo-varese-2026' | 'policonsumo-ticino-2026' | 'crack-house-ingrado-2026' | 'jashari-milan-bocciatura' | 'mendrisio-senso-citta-rossini-lorenzon' | 'incendio-chiasso-operai-feriti' | 'luino-bilancio-2025-avanzo-26-milioni' | 'nuovo-cardiocentro-lugano-realta' | 'spazi-autogestione-lugano-ghisletta' | 'svizzera-volare-aviazione-civile' | 'tangenziale-verde-somma-lombardo-2026' | 'inaugurazione-parchetto-biumo-via-arconati' | 'mendrisio-capitale-culturale-2026' | 'falsi-preti-barasso-truffe-anziani' | 'bando-restauro-beni-culturali-lombardia' | 'insieme-ad-andrea-si-puo-ricerca-leucemie-infantili' | 'scuola-chiude-fino-mornasco-2026' | 'como-turismo-sostenibile-10-maggio' | 'nuovo-allenatore-orsi-serge-aubin' | 'asta-villa-geno-como-400mila-euro' | 'mercato-agricolo-besozzo-superiore' | 'intelligenza-artificiale-robotica-varese-2026' | 'frontalieri-rifiuti-lac-lemano' | 'cazzago-brabbia-camminan-mangiando-2026' | 'lot-polish-60-anni-malpensa-varsavia' | 'auto-truccate-polizia-zugo-2026' | 'spirometrie-gratuite-bambini-varese-2026' | 'blackdamp-memoria-sacrificio-ed-emigrazione-nuovo-romanzo-storico-lucia-tiziani' | 'incidente-a8-castellanza-busto-arsizio-2026' | 'elicottero-mezzovico-incidente-2026' | 'inarzo-festa-oasi-palude-brabbia-2026' | 'mondiali-hockey-svizzera-2026' | 'comanorun-record-801-iscritti' | 'comano-run-record-2026' | 'moria-pesci-berneck-2026' | 'festival-meraviglia-laveno-luino-2026' | 'meraviglia-festival-laveno-luino-2026' | 'udc-cultura-indipendente-spesa-giustificata' | 'scontri-lugano-politica-toni' | 'svizzera-istruzioni-uso-frontalieri' | 'prigioni-ticino-sovraffollate-2026' | 'folgorato-stazione-bellinzona-morto-uomo' | 'lupo-tempo-attesa-finito-agire' | 'processo-binningen-morte-moglie-2026' | 'gianni-morandi-locarno-2026' | 'tensioni-geopolitiche-elettrico-ticino' | 'crans-montana-disgelo-italia-svizzera' | 'thun-vince-calcio-programmazione' | 'cliche-politici-giovani-ticino' | 'lugano-ingaggia-olle-lycksell-2026' | 'questionario-scuole-ticino-2026' | 'scuola-como-chiusura-socco' | 'rischio-benzina-svizzera-frontalieri' | 'mense-scolastiche-ticino-prezzi-2026' | 'inflazione-ticino-aprile-2026' | 'pubblicita-ambiente-amsterdam-svizzera' | 'como-tunisino-denunciato-aggressione' | 'internazionali-ticino-2026' | 'il-valore-del-vicino-ciclo-incontri-economia-prossimita' | 'carburante-svizzera-scorte-2026' | 'como-nuoto-750mila-euro-tribunale' | 'arresto-cocaina-mendrisio-albanese' | 'guerra-frena-viaggi-estero-2026' | 'lavori-soddisfazione-svizzeri-ticino' | 'benzina-19-euro-5-maggio-2026' | 'passo-gottardo-riaperto-ascensione' | 'passo-gottardo-riapre-anticipo-8-maggio' | 'furti-auto-ticino-2026' | 'lamone-nono-mcdonalds-ticino' | 'stagflazione-imprese-varesine-2026' | 'permessi-dimora-grigioni-mafie' | 'caseifici-aperti-ticino-2026' | 'campagna-dss-appropriatezza-sanitaria' | 'parco-ticino-controlli-maggio-2026' | 'pasto-vegetale-gratis-ticino-2026' | 'mercatino-rancate-mendrisio-2026' | 'kof-prospettive-lavoro-ticino-2026' | 'cornaredo-miliardo-promesse-cemento' | 'ladies-run-lugano-chiusure-stradali-2026' | 'furti-auto-ticino-2026-axa' | 'malpensafiere-hub-imprese-2026' | 'olgiate-olona-alloggio-domotico-disabili-2026' | 'swiss-voice-tour-tenero-2026' | 'guida-svizzera-frontalieri-2026' | 'iniziativa-caos-comitato-ticino-2026' | 'ospedale-zurigo-mancanze-cardiochirurgia' | 'libretto-digitale-militare-ticino-2026' | 'bici-bellinzona-valli-strategia' | 'dipendenti-statali-ticino-soddisfazione-2026' | 'fitness-ticino-record-2026' | 'education-day-varese-studenti' | 'truck-lavoro-etico-varese-studenti-visori-3d' | 'bici-miliardi-varese-percorsi-ciclabili' | 'assicurazione-dentaria-obbligatoria-ticino-2026' | 'incidente-fornasette-2026' | 'lavoro-agenzia-lombardia-frontalieri' | 'condizioni-utilizzo-tvsvizzera' | 'nuovo-ccnl-assolavoro-welfare-lavoratori' | 'dipendenti-cantonali-soddisfazione-erre-dipi' | 'frontalieri-disoccupati-svizzera-indennita' | 'somministrazione-occupazione-qualita-bottini' | 'misoexperience-festival-sport-2024' | 'servizio-civile-legge-nefasta-frontalieri' | 'furto-carrefour-como-marocchini-arrestati' | 'svizzera-italia-nuova-fase-relazioni' | 'moschea-cantu-frontalieri-2026' | 'lago-como-monte-san-primo-5-milioni' | 'mistero-palazzo-como-7-milioni' | 'palestre-svizzera-record-2026' | 'aarau-arresto-somalier-auto-delitto' | 'expat-ticino-sventa-truffa-hacker' | 'tragedia-braunwald-camminatore-disperso' | '20mila-firme-autostrada-pedaggio' | 'incendio-casciago-varese-2026' | 'varese-spacciatore-arresto-frontalieri' | 'incendio-cassano-magnago-sgombero' | 'furti-auto-ticino-2026-axa-segnalazioni' | 'minoteries-chiude-zollbruck-28-dipendenti' | 'gottardo-riapre-8-maggio-2026' | 'agricoltura-precisione-pesticidi-2026' | 'hondius-hantavirus-frontalieri' | 'tajani-parmelin-crans-montana-2026' | 'carburante-ticino-guerra-2026' | 'udc-sostenibilita-lavoro-ticino-2026' | 'a13-lumino-san-vittore-compensazione-ambientale' | 'divieto-petardi-svizzera-frontalieri' | 'salotto-ciani-lugano-2026' | 'hockey-lugano-nuovi-giocatori-2026' | 'incidente-fornasette-2026-ribaltamento-auto' | 'accesso-dossier-mengele' | 'tragedia-stazione-bellinzona-frontalieri' | 'pompieri-lugano-24-ore-2026' | 'nathan-borradori-ambri-2030' | 'conducente-folla-ricoverato-psichiatria-2026' | 'dipendenti-cantonali-soddisfazione-2026' | 'casse-malati-ticino-leghista-socialista' | 'morto-rene-groebli-fotografo-98-anni' | 'food-truck-festival-locarno-2026' | 'hendsichen-arresto-francese-autodiebstahl' | 'bper-risiko-bancario-crescita-mercato' | 'svizzeri-felici-salute-mentale-costi' | 'liuc-innovazione-2026-frontalieri' | 'colombi-addio-corriere-ticino' | 'ospedale-zurigo-cardiochirurgia-scandalo' | 'locarno-abitanti-domiciliati-2026' | 'cure-dentarie-ticino-2026' | 'bilancio-voto-canone-ssr-2026' | 'votazioni-cure-dentarie-ticino-2024' | 'casa-artigianato-dongio-sostegno' | 'cnhi-mendrisio-dipendenti-allarme' | 'swiss-made-regole-frontalieri' | 'cucina-tipica-lombarda-legge-2026' | 'estate-chiasso-2026-eventi' | 'petrolio-inflazione-svizzera-2026' | 'negozi-varese-frontalieri-occupazione' | 'app-guida-ticino-silicon-valley-2026' | 'mesolcina-festival-sport-2026' | 'goldbarren-zurigo-zoll-confiscati' | 'negozio-danese-arese-2026' | 'varese-summer-experience-2026-frontalieri' | 'malpensa-rumore-casorate-sempione-2026' | 'primo-maggio-monito-svizzera-10-milioni' | 'bambini-tecnologia-varese-2026' | 'ticino-benzina-frontalieri-2026' | 'nomine-meloni-consob-antitrust-2026' | 'crociere-ticino-rodano-senna-2026' | 'tunesier-algerier-autoknacker-wuerenlos' | 'servizio-civile-errore-voto-2026' | 'parita-salariale-ticino-2026' | 'lavori-chiasso-franscini-2026' | 'posta-castel-san-pietro-negozio-alimentari' | 'sicuritalia-assunzioni-lombardia-veneto-2026' | 'volandia-record-presenze-maggio-2026' | 'swissquote-trading-day-lugano-2026' | 'liberalizzazione-cannabis-minori-tutelati' | 'afghano-arresto-zug-chiasso' | 'sicurezza-commerciali-locarno-2026' | 'roveredo-carnevale-tutti-2026' | 'fnma-recruiting-day-saronno-2026' | 'sportello-energetico-verbano-2026' | 'vittima-folgorata-bellinzona-2026' | 'bilaterali-iii-doppia-maggioranza' | 'tassa-immigrazione-frontalieri-2026' | 'bilaterali-iii-modifica-costituzionale' | 'screening-senologico-45-anni-ticino' | 'g7-evian-controlli-frontiere-ticino' | 'menaggio-test-automobilisti-guai' | 'votazioni-ticino-14-giugno-2024' | 'borse-ticino-londra-verde' | 'bagni-bellinzona-riaprono-novita-2026' | 'swiss-market-index-entusiasmo-2026' | 'trump-export-limits-petrol-2026' | 'riapertura-bagno-bellinzona-2026' | 'partita-cornaredo-blocchi-stradali-2026' | 'fondi-europei-ticino-2026' | 'friborgo-hockey-mondiale-2026' | 'pagare-vittime-crans-montana-2026' | 'e-bike-parcheggi-sicuri-losanna-2026' | 'furti-serie-automobili-luganese-arrestato' | 'como-taccheggio-rapina-doppio-arresto' | 'bellinzona-bagno-pubblico-riapre-2026' | 'udc-bilaterali-2026-frontalieri' | 'centro-pasture-balerna-asilo' | '300-persone-pasto-vegetale-lugano-2026' | 'svizzera-treno-multa-20000-franchi' | 'decreto-lavoro-coldiretti-varese-2026' | 'swiss-300-uscite-volontarie-2026' | 'parmelin-stop-fatture-mediche-crans-montana' | 'luino-sanita-massarenti-2026' | 'siss-problemi-lombardia-frontalieri' | 'swiss-risultati-trimestre-frontalieri' | 'poliani-digital-innovation-hub-2026' | 'nespresso-svizzera-dazi-2026' | 'fondazione-bignasca-aiuti-2025' | 'assegni-figli-frontalieri-2026' | 'integrazione-studenti-gaza-italia-2026' | 'ladro-seriale-ticino-arresto-carte-credito' | 'varese-solidale-convegno-poverta-sanitaria-alimentare-2026' | 'centri-famiglia-altovaresotto-2026' | 'immigrazione-svizzera-invecchiamento-2026' | 'bocconi-avvelenati-ticino-segnalazioni' | 'nuova-vita-albergo-corecco-quinto' | 'alessandro-logistica-swissskills-2025' | 'ladri-auto-lusso-ticino-2026' | 'tuberkulose-caso-saint-maurice-2024' | 'fondazione-bignasca-aiuti-2026' | 'lusso-immobiliare-svizzera-2026' | 'chiasso-valore-economico-aggregazione' | 'governance-partecipativa-ssn-2026' | 'ssn-accessibile-frontalieri-ticino-2026' | 'hantavirus-crociera-isolamento' | 'nuovo-tunnel-lukmanier-sicurezza' | 'hantavirus-oms-passeggeri-sudafrica' | 'contrabbandiera-ciclostorica-2026' | 'liberta-dovery-autocensura-mendrisio' | 'case-lusso-svizzera-2026' | 'chiasso-conti-2025-disavanzo-avanzo' | 'quartiere-gera-iragna-pianificazione' | 'crans-montana-italia-risarcimento-300000-euro' | 'mariano-comense-assale-ferisce-barista-denunciato' | 'roveredo-patriziato-sciopera-gestione-criminalit' | 'varese-friuli-solidarieta-2026' | 'natura-tavola-cucina-vegetale-lugano-2024' | 'cambiamenti-commissione-magistrati-ticino-2026' | 'ticinese-timone-afro-pfingsten' | 'varese-corsi-nuovi-orizzonti-2026' | 'due-ticinesi-guardie-svizzere-2026' | 'hantavirus-zurigo-ricovero-crocerista' | 'bellinzona-valli-bici-velocita' | 'varese-riapre-via-mulini-grassi' | 'addio-passaporto-usa-berna' | 'odermatt-dottorato-honoris-causa' | 'cottarelli-liceo-manzoni-geopolitica' | 'teletext-ticino-fuori-uso-2024' | 'bayern-bayer-differenze-champions-2026' | '9-maggio-europa-bandiera-unione' | 'scuole-materne-gallarate-crisi-piano-2026' | 'regazzi-rieletto-usam-burocrazia-udc' | 'ex-casa-comunale-lopagno-vendita' | 'ascensione-pentecoste-viaggi-2026' | 'veglia-preghiera-omofobia-ticino-2026' | 'parcheggi-digitali-lugano-2024' | 'rimpatrio-famiglia-curda-riazzino' | 'varese-strisce-pedonali-invisibili-2026' | 'furti-self-service-ticino-2026' | 'varese-arresto-spacciatore-frontaliere' | 'uboldo-tetto-scoperchiato-maltempo-2026' | 'spreco-alimentare-giovani-social' | 'nuova-axenstrasse-svitto-2026' | 'spreco-alimentare-svizzera-obiettivo-fallito' | 'elon-musk-svizzero-processo-friburgo' | 'fedpol-talpa-accesso-dossier-inchiesta' | 'frode-reddito-cittadinanza-varese-2026' | 'frontalieri-ticino-calo-2026' | 'temporali-ticino-traffico-2024' | 'progetto-prossimita-locarno-2026' | 'media-svizzera-codice-condotta-ia' | 'cassis-italia-cornado-risarcimento' | 'disoccupazione-ticino-aprile-2026' | 'ticino-pernottamenti-controtendenza-2026' | 'lonza-cede-micro-macinazione-stabio' | 'agricoltura-sociale-ticino-strategie-2026' | 'arresto-droga-capolago-2026' | 'lugano-saluta-stadio-cornaredo-2024' | 'giro-ditalia-ticino-strade-chiuse' | 'montagne-neve-riapertura-passo-novena' | 'lucerna-paradiso-fiscale-frontalieri' | 'spring-pride-saronno-2026' | 'mengele-svizzera-1961-verifica' | 'hantavirus-zurigo-crocerista-frontalieri' | 'cassis-cornado-crans-montana-risarcimento' | 'liberta-riunione-cedu-condanna-svizzera' | 'galleria-italo-svizzera-enigmista' | 'svizzera-deroghe-costi-sanitari-crans-montana' | 'svizzera-2100-scenari-frontalieri' | 'sbb-controllers-bonuses-fines-ticino-2026' | 'nuovo-farmaco-leucemia-linfatica-cronica' | 'registro-imprese-varese-30-anni' | 'castellanza-investimenti-2025' | 'svizzera-elettricita-inverno-2026' | 'hantavirus-svizzera-frontalieri-2026' | 'cedu-condanna-svizzera-diritti-manifestante' | 'autista-stellato-fabio-giorgianni-premio' | 'accordo-editori-sindacati-svizzera-tedesca' | 'svizzera-minaccia-ibrida-russa-2026' | 'nottambuli-ticino-orari-societa' | 'economia-circolare-lavoro-carcere-varese' | 'gavirate-incidente-frontalieri-2026' | 'cedu-condanna-svizzera-liberta-manifestazione' | 'spaccio-droga-busto-18mila-euro' | 'incendio-auto-a2-camorino' | 'cultura-pari-opportunita-ticino-2024' | 'confisca-patrimoni-mafiosi-svizzera-2026' | 'ia-svizzera-uso-frontalieri-2026' | 'suini-svizzera-compenso-allevatori' | 'polizia-svizzera-inseguimento-italia' | 'disoccupazione-ticino-2026-effetti-guerra' | 'record-organi-importati-2025' | 'svizzera-hockey-finlandia-2026' | 'tax-free-dirinella-orari-ridotti' | 'lombardia-chiede-completamento-alptransit' | 'campagna-politica-frontalieri-15-milioni-franchi' | 'colf-badanti-ticino-2029' | 'turismo-varesotto-2026-frontalieri' | 'filtri-pfas-san-antonino-2024' | 'traduzione-documenti-finanziari-visto' | 'filtrazione-carbone-attivo-san-antonino' | 'edilizia-ticino-resiste-investimenti-geopolitica' | 'adeguati-assetti-imprese-ticino-2026' | 'accuse-svizzera-italia-2026' | 'elcom-preoccupata-inverno-2026' | 'balerna-2025-cifre-nere-frontalieri' | 'nuove-regole-scambio-informazioni-ader-enti-creditori' | 'varese-solidale-2026-frontalieri' | 'festa-mamma-palazzo-lombardia-2026' | 'casse-malati-frontalieri-ticino' | 'artekrea-open-days-varese-2026' | 'sanremo-eurovision-campione-2026' | 'morbio-inferiore-raccolta-vegetali-2026' | 'centromedico-bellinzona-frontalieri' | 'lugano-passteggia-iscrizioni-aperte' | 'pfas-filtrazione-san-antonino-2026' | 'incendio-auto-bellinzona-sud-2026' | 'pari-opportunita-cultura-lugano-2026' | 'brasile-mari-froes-leo-middea-lugano' | 'cross-border-teleworking-2026' | 'fiera-antiquariato-mendrisio-2026' | 'cure-dentarie-accessibili-ticino-2026' | 'dolores-poretti-91-anni-frontalieri' | 'costruzioni-ticino-impresari-investimenti-rapidi' | 'ex-pazienti-oncologici-aiutano-malati-ticino' | 'picnic-stadio-cornaredo' | 'malessere-polizia-cantonale-audit' | 'desiderio-non-chiede-permesso-bufera-sui-cartelloni-di-un-locale-erotico' | 'friburgo-finale-europa-manzambi' | 'legal-insurance-utilita-sicurezza' | 'trump-dazi-corte-commercio-2026' | 'lipsia-pirata-strada-frontalieri' | 'lula-trump-riunione-democrazia-sovranita' | 'delitto-garlasco-chiara-omicidio-2026' | 'hondius-frontalieri-ticino-2026' | 'harrods-risarcimenti-vittime-al-fayed' | 'trump-ue-accordo-commerciale-4-luglio' | 'ginevra-manifestazione-frontalieri-2026' | 'josi-fischer-lettera-cuore' | 'votazione-popolare-lamal-frontalieri' | 'maxi-blitz-cocaina-atlantico-30-tonnellate' | 'giudici-federali-indagine-2026' | 'centromedico-castello-chirurgia-ambulatoriale' | 'arresto-commissario-fedpol-mafia' | 'processo-broker-vip-retrocessioni' | 'durisch-dado-blocco-frontalieri-ticino' | 'frontalieri-lugano-chiarezza-2026' | 'sgombero-macerie-lugano-amianto' | 'lamanotesa-ch-dolore-bene-condiviso' | 'lamal-low-cost-premi-bassi-2026' | 'grigioni-fattura-italia-olimpiadi' | 'untersander-ginevra-2026' | 'dati-precalcolati-isa-2026-frontalieri' | 'frontalieri-ticino-stabili-2026-q1' | 'ricorso-patente-lavoro-varese-2026' | 'aggregazione-comuni-vedeggio-2026' | 'giardino-ferroviario-balerna-2026' | 'vertigini-montagna-frontalieri' | 'real-madrid-caos-rissa-tchouameni-valverde' | 'bioblitz-groane-2026-frontalieri' | 'joris-begevoord-intervista-aebr-2026' | 'frontalieri-ticino-pokerce-dimezzati' | 'frontalieri-orari-lavorativi-residenzialita' | 'lumen-claro-premiati-varese-1989' | 'grandine-cislago-protezione-civile-2026' | 'edoardo-leo-teatro-intred-varese-2026' | 'locarno-zanzara-tigre-campagna-rilancia-2026' | 'legge-foti-critica-economia-ticino' | 'progetto-eiger-palace-lugano-2026' | 'cartelle-pagamento-cassazione-2026' | 'crd-output-floor-ii-pilastro' | 'ultimo-svizzero-rientra-incendio-crans-montana' | 'universita-insubria-premia-frontalieri' | 'incendio-gallarate-frontalieri-2026' | 'cardada-cimetta-riapre-bikers-2024' | 'frontalieri-ticino-8-maggio-2026' | 'adam-walder-titolo-nazionale-under-14' | 'fart-2025-frontalieri-transporti' | 'rimborso-cure-dentarie-ticino-2026' | 'bolla-immobiliare-ticino-2026' | 'imprinting-saggio-architettura-italiana' | 'pagaiate-internazionali-grigioni-ticino-2026' | 'aquile-mannheim-coppa-spengler-2026' | 'incentivi-assunzioni-2026-sgravi-contributivi' | 'ddl-caregiver-frontalieri-ticino-2026' | 'simona-waltert-ticino-frontalieri' | 'bonnie-tyler-coma-farmacologico-2026' | 'nuovo-accordo-immobili-frontalieri-2026' | 'nuova-riforma-avs-2024-frontalieri' | 'lohnausweis-frontalieri-ticino' | 'emigrazione-cassa-pensione-risparmio-imposte' | 'nuovo-accordo-frontalieri-pilastro-2026' | 'chiasso-dogana-tempi-attesa' | 'stipendi-neolaureati-svizzera-austria-germania' | 'nuove-basi-lpp-2025-frontalieri' | 'aumenti-stipendi-svizzera-2026' | 'lista-morosi-cassa-malati-ticino' | 'falegnami-stipendi-2025' | 'tasse-mance-frontalieri-ticino' | 'tasse-aeree-kerosene-2026' | 'nuovo-accordo-cremona-fisco-2026' | 'lapo-elkann-lucerna-2024' | 'impatriati-fiscalita-frontalieri' | 'svizzeri-ottimisti-finanze-2026' | 'emolumenti-svizzera-tassazione-italia' | 'assicurazione-malattie-pilota-ticino' | 'revoca-permesso-g-steiner-ticino' | 'rientro-lento-a2-frontalieri' | 'addio-tutto-compreso-ai-costi' | 'arcidiacono-curia-lugano-2026' | 'simone-grossi-frontaliere-visp' | 'blackout-internet-iran-70-giorni' | 'rafforzare-sicurezza-bellinzona-2026' | 'austria-ticino-ambasciatori-2026' | 'isa-liquidazione-frontalieri-2026' | 'malattie-renali-campagna-cl3ar-milano' | 'hantavirus-ginevrino-isolamento-frontalieri' | 'pentagono-ufo-documenti-inediti-2026' | 'croce-rossa-160-anni-tagli-educatori' | 'servizi-dentari-scolastici-conflitti-interesse' | 'pensioni-svantaggio-tasse-frontalieri' | 'takahashia-japonica-ticino-2026' | 'onorificenze-austriache-lugano-2024' | 'votazioni-svizzera-10-milioni-frontalieri' | 'modifiche-regolamento-antincendio-ticino-2026' | 'crans-montana-ore-straordinarie-non-pagate' | 'lugano-calcio-frontalieri-2026' | 'premiate-classi-acqua-vita-2026' | 'biasca-ucraina-aiuto-medico-2026' | 'criptovalute-frontalieri-timing-perfetto' | 'super-ricco-tasse-frontalieri-ticino' | 'interroll-acquisisce-royal-apollo-group' | 'alpini-paracadutisti-genova-2026' | 'casa-hockey-lugano-frontalieri' | 'papa-leone-incontra-madre-frontaliere' | 'svizzera-sconfitta-svezia-frontalieri' | 'tregua-ucraina-improbabile-cremlino' | 'incidente-tuta-alare-svizzera-2026' | 'ghiacciai-svizzera-frontalieri' | 'frontalieri-luino-caserma-fornasette' | 'black-list-morosi-cassa-malati-ticino' | 'documentario-claire-ghiringhelli-lugano' | 'malpensa-pista-riapre-frontalieri' | 'peter-magyar-ungheria-volta-pagina' | 'potere-dacquisto-ticino-2024';

export type BlogArticleId = _BlogId1 | _BlogId2 | _BlogId3 | _BlogId4 | _BlogId5;

export interface AppRoute {
 activeTab: ActiveTab;
 calcolatoreSubTab?: CalcolatoreSubTab;
 confrontiSubTab?: ConfrontiSubTab;
 fiscoSubTab?: FiscoSubTab;
 /** Country section for tax-return guide: Italia (730/IRPEF) or Svizzera (imposta alla fonte/TDR). */
 taxReturnCountry?: 'italia' | 'svizzera';
 guidaSubTab?: GuidaSubTab;
 /** Optional border crossing deep link under guida/border (e.g. /guida/.../border-waiting-times/chiasso-brogeda). */
 borderCrossing?: BorderCrossingId;
 vitaSubTab?: VitaSubTab;
 statsSubTab?: StatsSubTab;
 blogArticle?: BlogArticleId;
 /** Unresolved blog slug when blog data hasn't loaded yet (lazy-loaded). */
 blogSlug?: string;
 /** SEO landing identifier for long-tail routes (e.g. /calcola-stipendio/stipendio-netto-80000-chf). */
 seoLanding?: SeoLandingId;
 /** Glossary term deep-link (e.g. /glossario/imposta-alla-fonte). */
 glossaryTerm?: GlossaryTermId;
 // Legacy fields — kept for backward compat during transition
 comparatoriSubTab?: string;
 strumentiSubTab?: string;
 simulatorSubTab?: string;
 pensionSubTab?: string;
 guideSection?: string;
 /** Job detail slug under job-board route (e.g. /cerca-lavoro-ticino/software-engineer-...). */
 jobSlug?: string;
 /**
  * Canonical geo-hub key when the URL matches a city-hub path
  * (e.g. /cerca-lavoro-ticino/lugano/ → `jobBoardCity: 'lugano'`).
  * When set, {@link jobSlug} is also populated with the corresponding
  * localized editorial-landing slug (e.g. `ricerca-lugano`) so client-side
  * rendering shows the full location landing UI. `jobBoardCity` takes
  * precedence in {@link buildPath} so the emitted URL uses the clean slug.
  */
 jobBoardCity?: 'lugano' | 'mendrisio' | 'bellinzona' | 'locarno' | 'chiasso';
 /**
  * Canonical sector-hub key when the URL matches a sector-hub path
  * (e.g. /cerca-lavoro-ticino/infermieri/ → `jobBoardSector: 'infermieri'`).
  * Takes precedence over {@link jobSlug} in {@link buildPath} so the emitted
  * URL uses the clean sector slug.
  */
 jobBoardSector?: SectorHubKey;
 /** URL fragment identifier (without #). Used for anchor-linking to page sections. */
 hash?: string;
 /** Salary Hub slug — pre-computed scenario page loaded from static HTML, routed to calculator tab. */
 salaryHubSlug?: string;
 /** Author profile slug when activeTab === 'autore' (e.g. /autori/marco-ferrari/). */
 author?: string;
 /**
  * When true, this route was matched against a build-time static SEO page
  * (fuel-daily, weekly-employers, job-market-snapshot, health-premiums,
  * border-wait, orphan-query, plus per-station / IT-city / sector /
  * company-city extensions). The URL is already canonical and the page
  * body is statically rendered as a sibling of `#root` (see
  * `seoContentOutsideRoot` in build-plugins/htmlTemplate.ts).
  *
  * Effects:
  *   - `pushRoute()` becomes a no-op (so the SPA doesn't rewrite the URL
  *     to the generic comparator/tab path on initial render).
  *   - App.tsx detects the static `<main class="seo-static-content">` and
  *     renders only the header+footer chrome, never the route's full tab
  *     content — preventing the bait-and-switch where the per-station/
  *     per-canton page would visually flip to the generic comparator.
  */
 staticOverlay?: boolean;
}

// ── Internationalized slug maps ──────────────────────────────

interface SlugTable {
 // top-level section slugs
 calcolatore: string;
 confronti: string;
 fisco: string;
 guida: string;
 vita: string;
 stats: string;
 feedback: string;
 privacy: string;
 terms: string;
 dataDeletion: string;
 apiStatus: string;
 newsletter: string;
 gamification: string;
 morning: string;
 forum: string;
 contact: string;
 partners: string;
 consulting: string;
 pressKit: string;
 jobBoard: string;
 profile: string;
 dashboard: string;
 // calcolatore sub-tab slugs
 whatif: string;
 payslip: string;
 ral: string;
 bonus: string;
 parentalLeave: string;
 residency: string;
 permitCompare: string;
 // confronti sub-tab slugs
 exchange: string;
 banks: string;
 health: string;
 mobile: string;
 shopping: string;
 costOfLiving: string;
 jobs: string;
 renovation: string;
 // fisco sub-tab slugs
 taxReturn: string;
 taxReturnItalia: string;
 taxReturnSvizzera: string;
 calendar: string;
 holidays: string;
 ristorni: string;
 pension: string;
 pillar3: string;
 quiz: string;
 taxCredit: string;
 withholdingRates: string;
 newFrontierTaxSim: string;
 // guida sub-tab slugs
 firstDay: string;
 permits: string;
 border: string;
 unemployment: string;
 carTransfer: string;
 carCost: string;
 municipalities: string;
 borderMap: string;
 // vita sub-tab slugs
 livingCH: string;
 livingIT: string;
 companies: string;
 schools: string;
 nursery: string;
 places: string;
 transport: string;
 // stats sub-tab slugs
 livability: string;
 jobsObservatory: string;
 salaryCompare: string;
 trafficHistory: string;
 unemploymentStats: string;
 mortgageComparison: string;
 fuelPrices: string;
 healthPremiums: string;
 // calcolatore extra slugs
 salaryQuiz: string;
 // top-level extra slugs
 blog: string;

 // glossario standalone page
 glossario: string;
 // dialetto standalone page
 dialetto: string;
 // faq standalone page
 faq: string;
 // sitemap standalone page
 sitemap: string;
 // contracts / CCNL guide standalone page
 contracts: string;
 // TFR / Liquidazione calculator standalone page
 tfrCalculator: string;
 // Quiz Permesso B o G standalone page
 permitQuiz: string;
 // Tredicesima / Quattordicesima calculator standalone page
 tredicesima: string;
 // Weekly digest + Tool of the week
 weeklyDigest: string;
 toolOfWeek: string;
 // Email confirmed welcome page
 emailConfirmed: string;
 // Newsletter preferences (HMAC-authed opt-out page)
 newsletterPreferences: string;
 // hidden admin route
 admin: string;
 // About / Chi Siamo page (E-E-A-T)
 chiSiamo: string;
 // Public corrections policy + log (Google News compliance B1)
 correzioni: string;
 // Editorial methodology page (Google News compliance — A3)
 metodologia: string;
 // Trade unions guide
 sindacati: string;
 // Definitive guide page (SEO pillar content)
 guidaCompleta: string;
 // Taxation hub pillar page (SEO pillar content — P4)
 tassazioneHub: string;
 // legacy slugs (for backward compat parsing)
 costs: string;
 salarySurvey: string;
 comparatori: string;
 strumenti: string;
 guide: string;
}

const SLUG_TABLES: Record<Locale, SlugTable> = {
 it: {
 calcolatore: 'calcola-stipendio',
 confronti: 'compara-servizi',
 fisco: 'tasse-e-pensione',
 guida: 'guida-frontaliere',
 vita: 'vivere-in-ticino',
 stats: 'statistiche',
 feedback: 'supporto',
 privacy: 'privacy',
 terms: 'termini-di-servizio',
 dataDeletion: 'eliminazione-dati',
 apiStatus: 'stato-api',
 newsletter: 'newsletter',
 gamification: 'gamificazione',
 morning: 'buongiorno-frontaliere',
 forum: 'community',
 contact: 'contattaci',
 partners: 'servizi-partner',
 consulting: 'consulenza',
 pressKit: 'stampa',
 jobBoard: 'cerca-lavoro-ticino',
 profile: 'profilo',
 dashboard: 'dashboard',
 whatif: 'cosa-cambia-se',
 payslip: 'simula-busta-paga',
 ral: 'confronta-retribuzione-ral',
 bonus: 'stima-bonus-frontaliere',
 parentalLeave: 'verifica-congedo-parentale',
 residency: 'simula-cambio-residenza',
 permitCompare: 'confronta-permesso-g-vs-b',
 exchange: 'cambio-franco-euro',
 banks: 'confronta-banche',
 health: 'confronta-casse-malati',
 mobile: 'confronta-operatori-mobili',
 shopping: 'confronta-prezzi-spesa',
 costOfLiving: 'costo-della-vita',
 jobs: 'confronta-offerte-lavoro',
 renovation: 'calcola-bonus-ristrutturazione',
 taxReturn: 'dichiarazione-redditi',
 taxReturnItalia: 'dichiarazione-redditi-italia',
 taxReturnSvizzera: 'dichiarazione-redditi-svizzera',
 calendar: 'scadenze-fiscali',
 holidays: 'festivita-ticino',
 ristorni: 'ristorni-fiscali',
 pension: 'calcola-previdenza',
 pillar3: 'simula-terzo-pilastro',
 quiz: 'quiz-fiscale',
 taxCredit: 'credito-imposta',
 withholdingRates: 'aliquote-imposta-alla-fonte-ticino-2026',
 newFrontierTaxSim: 'simulazione-tasse-nuovi-frontalieri',
 firstDay: 'primo-giorno-lavoro',
 permits: 'permessi-di-lavoro',
 border: 'tempi-attesa-dogana',
 unemployment: 'disoccupazione-transfrontaliera',
 carTransfer: 'trasferire-auto-svizzera',
 carCost: 'costo-auto-pendolare',
 municipalities: 'comuni-di-frontiera',
 borderMap: 'mappa-confine',
 livingCH: 'vivere-in-svizzera',
 livingIT: 'vivere-in-italia',
 companies: 'aziende-svizzera-italiana',
 schools: 'scuole-svizzera-italiana',
 nursery: 'confronta-asili-nido',
 places: 'attrazioni-svizzera-italiana',
 transport: 'trasporti-frontalieri',
 livability: 'migliori-comuni-frontiera',
 jobsObservatory: 'osservatorio-stipendi-lavori-ticino',
 salaryCompare: 'confronta-stipendi',
 trafficHistory: 'storico-traffico-dogane',
 unemploymentStats: 'disoccupazione-svizzera',
 mortgageComparison: 'confronto-mutui',
 fuelPrices: 'prezzi-benzina-confine',
 healthPremiums: 'premi-malattia-comuni',
 salaryQuiz: 'quanto-guadagneresti-in-svizzera',
 blog: 'articoli-frontaliere',

 glossario: 'glossario-frontaliere',
 dialetto: 'dialetto-ticinese',
 faq: 'domande-frequenti-frontalieri',
 sitemap: 'mappa-del-sito',
 contracts: 'contratti-lavoro-svizzera',
 sindacati: 'sindacati-frontalieri',
 guidaCompleta: 'guida-completa-lavoro-frontaliere-svizzera-2026',
 tassazioneHub: 'guida-tassazione-frontalieri-2026',
 tfrCalculator: 'tfr-liquidazione-frontaliere',
 permitQuiz: 'quiz-permesso-b-o-g',
 tredicesima: 'calcolo-tredicesima-frontaliere',
 weeklyDigest: 'digest-settimanale',
 toolOfWeek: 'strumento-della-settimana',
 emailConfirmed: 'benvenuto-frontaliere',
 newsletterPreferences: 'preferenze-newsletter',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'chi-siamo',
 correzioni: 'correzioni',
 metodologia: 'metodologia',
 costs: 'costi-pendolarismo',
 salarySurvey: 'sondaggio-stipendi',
 comparatori: 'comparatori',
 strumenti: 'strumenti',
 guide: 'guida-frontalieri',
 },
 en: {
 calcolatore: 'calculate-salary',
 confronti: 'service-comparison',
 fisco: 'taxes-and-pension',
 guida: 'cross-border-guide',
 vita: 'living-in-ticino',
 stats: 'statistics',
 feedback: 'support',
 privacy: 'privacy',
 terms: 'terms-of-service',
 dataDeletion: 'data-deletion',
 apiStatus: 'api-status',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'good-morning',
 forum: 'community',
 contact: 'contact-us',
 partners: 'partner-services',
 consulting: 'consulting',
 pressKit: 'press-kit',
 jobBoard: 'find-jobs-ticino',
 profile: 'profile',
 dashboard: 'dashboard',
 whatif: 'what-if-scenarios',
 payslip: 'estimate-payslip',
 ral: 'compare-gross-salary',
 bonus: 'simulate-bonus',
 parentalLeave: 'estimate-parental-leave',
 residency: 'simulate-residency-change',
 permitCompare: 'compare-permit-g-vs-b',
 exchange: 'chf-eur-exchange-rate',
 banks: 'compare-banks',
 health: 'compare-health-insurance',
 mobile: 'compare-mobile-plans',
 shopping: 'compare-grocery-prices',
 costOfLiving: 'cost-of-living',
 jobs: 'compare-job-offers',
 renovation: 'calculate-renovation-bonus',
 taxReturn: 'tax-return-guide',
 taxReturnItalia: 'tax-return-italy',
 taxReturnSvizzera: 'tax-return-switzerland',
 calendar: 'tax-deadlines',
 holidays: 'ticino-public-holidays',
 ristorni: 'tax-refunds',
 pension: 'calculate-retirement',
 pillar3: 'simulate-third-pillar',
 quiz: 'tax-quiz',
 taxCredit: 'tax-credit',
 withholdingRates: 'ticino-withholding-tax-rates-2026',
 newFrontierTaxSim: 'tax-simulation-new-cross-border-workers',
 firstDay: 'first-day-at-work',
 permits: 'work-permits-guide',
 border: 'border-waiting-times',
 unemployment: 'unemployment-benefits',
 carTransfer: 'transfer-car-to-switzerland',
 carCost: 'commuting-car-costs',
 municipalities: 'border-municipalities',
 borderMap: 'border-map',
 livingCH: 'living-in-switzerland',
 livingIT: 'living-in-italy',
 companies: 'companies-southern-switzerland',
 schools: 'schools-southern-switzerland',
 nursery: 'compare-nurseries',
 places: 'attractions-southern-switzerland',
 transport: 'cross-border-transport',
 livability: 'best-border-towns',
 jobsObservatory: 'ticino-jobs-salary-observatory',
 salaryCompare: 'compare-salaries',
 trafficHistory: 'border-traffic-history',
 unemploymentStats: 'unemployment-switzerland',
 mortgageComparison: 'mortgage-comparison',
 fuelPrices: 'border-fuel-prices',
 healthPremiums: 'health-insurance-premiums-by-commune',
 salaryQuiz: 'how-much-would-you-earn-in-switzerland',
 blog: 'cross-border-articles',

 glossario: 'cross-border-glossary',
 dialetto: 'ticinese-dialect',
 faq: 'cross-border-faq',
 sitemap: 'site-map',
 contracts: 'swiss-employment-contracts',
 tfrCalculator: 'tfr-severance-pay-calculator',
 permitQuiz: 'permit-b-or-g-quiz',
 tredicesima: 'thirteenth-salary-calculator',
 weeklyDigest: 'weekly-digest',
 toolOfWeek: 'tool-of-the-week',
 emailConfirmed: 'welcome',
 newsletterPreferences: 'newsletter-preferences',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'about-us',
 correzioni: 'corrections',
 metodologia: 'methodology',
 sindacati: 'trade-unions-cross-border-workers',
 guidaCompleta: 'complete-guide-cross-border-work-switzerland-2026',
 tassazioneHub: 'cross-border-taxation-guide-2026',
 costs: 'commuting-costs',
 salarySurvey: 'salary-survey',
 comparatori: 'comparators',
 strumenti: 'tools',
 guide: 'frontier-guide',
 },
 de: {
 calcolatore: 'gehalt-berechnen',
 confronti: 'service-vergleich',
 fisco: 'steuern-und-vorsorge',
 guida: 'grenzgaenger-ratgeber',
 vita: 'leben-im-tessin',
 stats: 'statistiken',
 feedback: 'hilfe',
 privacy: 'datenschutz',
 terms: 'nutzungsbedingungen',
 dataDeletion: 'daten-loeschen',
 apiStatus: 'api-status',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'guten-morgen',
 forum: 'gemeinschaft',
 contact: 'kontakt',
 partners: 'partner-dienste',
 consulting: 'beratung',
 pressKit: 'pressekit',
 jobBoard: 'jobs-im-tessin',
 profile: 'profil',
 dashboard: 'dashboard',
 whatif: 'was-waere-wenn',
 payslip: 'lohnabrechnung-simulieren',
 ral: 'bruttogehalt-vergleichen',
 bonus: 'bonus-simulieren',
 parentalLeave: 'elternzeit-simulieren',
 residency: 'wohnsitzwechsel-simulieren',
 permitCompare: 'bewilligung-g-vs-b',
 exchange: 'chf-eur-wechselkurs',
 banks: 'banken-vergleichen',
 health: 'krankenkassen-vergleichen',
 mobile: 'mobilfunk-vergleichen',
 shopping: 'einkaufspreise-vergleichen',
 costOfLiving: 'lebenshaltungskosten',
 jobs: 'stellenangebote-vergleichen',
 renovation: 'renovierungs-bonus-berechnen',
 taxReturn: 'steuererklaerung',
 taxReturnItalia: 'steuererklaerung-italien',
 taxReturnSvizzera: 'steuererklaerung-schweiz',
 calendar: 'steuerfristen',
 holidays: 'tessin-feiertage',
 ristorni: 'steuerrueckerstattung',
 pension: 'rente-berechnen',
 pillar3: 'dritte-saeule-simulieren',
 quiz: 'steuer-quiz',
 taxCredit: 'steuergutschrift',
 withholdingRates: 'quellensteuer-tessin-2026',
 newFrontierTaxSim: 'steuerberechnung-neue-grenzgaenger',
 firstDay: 'erster-arbeitstag',
 permits: 'arbeitsbewilligungen',
 border: 'wartezeiten-grenze',
 unemployment: 'arbeitslosengeld',
 carTransfer: 'auto-in-schweiz-ummelden',
 carCost: 'pendler-autokosten',
 municipalities: 'grenzgemeinden',
 borderMap: 'grenzkarte',
 livingCH: 'leben-in-der-schweiz',
 livingIT: 'leben-in-italien',
 companies: 'unternehmen-suedschweiz',
 schools: 'schulen-suedschweiz',
 nursery: 'kinderkrippen-vergleichen',
 places: 'ausflugsziele-suedschweiz',
 transport: 'grenzpendler-verkehr',
 livability: 'beste-grenzgemeinden',
 jobsObservatory: 'stellen-und-lohn-observatorium-tessin',
 salaryCompare: 'gehaelter-vergleichen',
 trafficHistory: 'grenzverkehr-verlauf',
 unemploymentStats: 'arbeitslosigkeit-schweiz',
 mortgageComparison: 'hypotheken-vergleich',
 fuelPrices: 'spritpreise-grenze',
 healthPremiums: 'krankenkassentraemien-nach-gemeinde',
 salaryQuiz: 'verdienst-in-der-schweiz',
 blog: 'grenzgaenger-artikel',

 glossario: 'grenzgaenger-glossar',
 dialetto: 'tessiner-dialekt',
 faq: 'grenzgaenger-faq',
 sitemap: 'seitenplan',
 contracts: 'schweizer-arbeitsvertraege',
 tfrCalculator: 'tfr-abfindung-grenzgaenger-rechner',
 permitQuiz: 'quiz-bewilligung-b-oder-g',
 tredicesima: 'dreizehnter-monatslohn-rechner',
 weeklyDigest: 'woechentlicher-bericht',
 toolOfWeek: 'werkzeug-der-woche',
 emailConfirmed: 'willkommen',
 newsletterPreferences: 'newsletter-einstellungen',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'ueber-uns',
 correzioni: 'korrekturen',
 metodologia: 'methodik',
 sindacati: 'gewerkschaften-grenzgaenger',
 guidaCompleta: 'komplettanleitung-grenzgaenger-arbeit-schweiz-2026',
 tassazioneHub: 'grenzgaenger-besteuerung-leitfaden-2026',
 costs: 'pendelkosten',
 salarySurvey: 'gehaltsumfrage',
 comparatori: 'vergleiche',
 strumenti: 'werkzeuge',
 guide: 'grenzgaenger-guide',
 },
 fr: {
 calcolatore: 'calculer-salaire',
 confronti: 'comparaison-services',
 fisco: 'impots-et-retraite',
 guida: 'guide-frontalier',
 vita: 'vivre-au-tessin',
 stats: 'statistiques',
 feedback: 'assistance',
 privacy: 'confidentialite',
 terms: 'conditions-utilisation',
 dataDeletion: 'suppression-donnees',
 apiStatus: 'etat-api',
 newsletter: 'newsletter',
 gamification: 'gamification',
 morning: 'bonjour-frontalier',
 forum: 'communaute',
 contact: 'contactez-nous',
 partners: 'services-partenaires',
 consulting: 'consultation',
 pressKit: 'kit-presse',
 jobBoard: 'trouver-emploi-tessin',
 profile: 'profil',
 dashboard: 'tableau-de-bord',
 whatif: 'scenarios-hypothetiques',
 payslip: 'simuler-fiche-de-paie',
 ral: 'comparer-salaire-brut',
 bonus: 'estimer-bonus',
 parentalLeave: 'simuler-conge-parental',
 residency: 'simuler-changement-residence',
 permitCompare: 'comparer-permis-g-vs-b',
 exchange: 'taux-change-chf-eur',
 banks: 'comparer-banques',
 health: 'comparer-caisses-maladie',
 mobile: 'comparer-forfaits-mobiles',
 shopping: 'comparer-prix-courses',
 costOfLiving: 'cout-de-la-vie',
 jobs: 'comparer-offres-emploi',
 renovation: 'calculer-bonus-renovation',
 taxReturn: 'declaration-revenus',
 taxReturnItalia: 'declaration-revenus-italie',
 taxReturnSvizzera: 'declaration-revenus-suisse',
 calendar: 'echeances-fiscales',
 holidays: 'jours-feries-tessin',
 ristorni: 'ristornes-fiscaux',
 pension: 'calculer-pension',
 pillar3: 'simuler-troisieme-pilier',
 quiz: 'quiz-fiscal',
 taxCredit: 'credit-impot',
 withholdingRates: 'baremes-impot-a-la-source-tessin-2026',
 newFrontierTaxSim: 'simulation-impots-nouveaux-frontaliers',
 firstDay: 'premier-jour-travail',
 permits: 'permis-de-travail',
 border: 'temps-attente-douane',
 unemployment: 'allocations-chomage',
 carTransfer: 'transferer-voiture-suisse',
 carCost: 'cout-voiture-pendulaire',
 municipalities: 'communes-frontiere',
 borderMap: 'carte-frontiere',
 livingCH: 'vivre-en-suisse',
 livingIT: 'vivre-en-italie',
 companies: 'entreprises-suisse-italienne',
 schools: 'ecoles-suisse-italienne',
 nursery: 'comparer-creches',
 places: 'decouvrir-suisse-italienne',
 transport: 'transports-frontaliers',
 livability: 'meilleures-communes-frontiere',
 jobsObservatory: 'observatoire-emplois-salaires-tessin',
 salaryCompare: 'comparer-salaires',
 trafficHistory: 'historique-trafic-frontiere',
 unemploymentStats: 'chomage-suisse',
 mortgageComparison: 'comparaison-hypotheques',
 fuelPrices: 'prix-essence-frontiere',
 healthPremiums: 'primes-assurance-maladie-communes',
 salaryQuiz: 'combien-gagneriez-vous-en-suisse',
 blog: 'articles-frontalier',

 glossario: 'glossaire-frontalier',
 dialetto: 'dialecte-tessinois',
 faq: 'faq-frontaliers',
 sitemap: 'plan-du-site',
 contracts: 'contrats-travail-suisses',
 tfrCalculator: 'tfr-indemnite-licenciement-frontalier',
 permitQuiz: 'quiz-permis-b-ou-g',
 tredicesima: 'calculateur-treizieme-salaire',
 weeklyDigest: 'digest-hebdomadaire',
 toolOfWeek: 'outil-de-la-semaine',
 emailConfirmed: 'bienvenue',
 newsletterPreferences: 'preferences-newsletter',
 admin: 'gestione-contenuti-xk9mp2q',
 chiSiamo: 'a-propos',
 correzioni: 'corrections',
 metodologia: 'methodologie',
 sindacati: 'syndicats-frontaliers',
 guidaCompleta: 'guide-complet-travail-frontalier-suisse-2026',
 tassazioneHub: 'guide-imposition-frontaliers-2026',
 costs: 'couts-pendulaire',
 salarySurvey: 'sondage-salaires',
 comparatori: 'comparateurs',
 strumenti: 'outils',
 guide: 'guide-frontaliers',
 },
};

// ── Reverse lookup helpers ───────────────────────────────────

type SubSlugMap<T extends string> = Record<string, T>;
type TopLevelSlugMap = Record<string, { tab: ActiveTab; sub?: string }>;

const CALCOLATORE_SUB_TO_SLUG: Record<CalcolatoreSubTab, keyof SlugTable & string> = {
 calculator: 'calcolatore',
 whatif: 'whatif',
 payslip: 'payslip',
 ral: 'ral',
 bonus: 'bonus',
 'parental-leave': 'parentalLeave',
 residency: 'residency',
 'salary-quiz': 'salaryQuiz',
};

const CONFRONTI_SUB_TO_SLUG: Record<ConfrontiSubTab, keyof SlugTable & string> = {
 exchange: 'exchange',
 banks: 'banks',
 health: 'health',
 mobile: 'mobile',
 shopping: 'shopping',
 'cost-of-living': 'costOfLiving',
 jobs: 'jobs',
 renovation: 'renovation',
};

const FISCO_SUB_TO_SLUG: Record<FiscoSubTab, keyof SlugTable & string> = {
 'tax-return': 'taxReturn',
 calendar: 'calendar',
 holidays: 'holidays',
 ristorni: 'ristorni',
 pension: 'pension',
 pillar3: 'pillar3',
 quiz: 'quiz',
 'tax-credit': 'taxCredit',
 'withholding-rates': 'withholdingRates',
 'new-frontier-tax-sim': 'newFrontierTaxSim',
};

const GUIDA_SUB_TO_SLUG: Record<GuidaSubTab, keyof SlugTable & string> = {
 'first-day': 'firstDay',
 permits: 'permits',
 border: 'border',
 unemployment: 'unemployment',
 'car-transfer': 'carTransfer',
 'car-cost': 'carCost',
 'permit-compare': 'permitCompare',
 'border-map': 'borderMap',
};

const VITA_SUB_TO_SLUG: Record<VitaSubTab, keyof SlugTable & string> = {
 'living-ch': 'livingCH',
 'living-it': 'livingIT',
 companies: 'companies',
 schools: 'schools',
 nursery: 'nursery',
 places: 'places',
 transport: 'transport',
 municipalities: 'municipalities',
};

const STATS_KEYS: { key: keyof SlugTable; id: StatsSubTab }[] = [
 { key: 'stats', id: 'overview' },
 { key: 'livability', id: 'livability' },
 { key: 'jobsObservatory', id: 'jobs-observatory' },
 { key: 'salaryCompare', id: 'salary-compare' },
 { key: 'trafficHistory', id: 'traffic-history' },
 { key: 'unemploymentStats', id: 'unemployment' },
 { key: 'mortgageComparison', id: 'mortgage' },
 { key: 'fuelPrices', id: 'fuel-prices' },
 { key: 'healthPremiums', id: 'health-premiums' }
];
const LEGACY_STATS_KEYS: { key: keyof SlugTable; id: StatsSubTab }[] = [
 { key: 'salarySurvey', id: 'salary-compare' }
];

function buildSubReverse<T extends string>(table: SlugTable, mapping: Record<T, keyof SlugTable & string>): SubSlugMap<T> {
 const map: SubSlugMap<T> = {};
 for (const [subTab, slugKey] of Object.entries(mapping) as [T, keyof SlugTable & string][]) {
 map[table[slugKey]] = subTab;
 }
 return map;
}

function buildLocaleReverses<T extends string>(mapping: Record<T, keyof SlugTable & string>): Record<Locale, SubSlugMap<T>> {
 return {
 it: buildSubReverse(SLUG_TABLES.it, mapping),
 en: buildSubReverse(SLUG_TABLES.en, mapping),
 de: buildSubReverse(SLUG_TABLES.de, mapping),
 fr: buildSubReverse(SLUG_TABLES.fr, mapping),
 };
}

// ── Job slug cross-locale translation ──
// Maps any-locale job slug → per-locale slugs (populated by JobBoard after loading jobs).
let _jobSlugMap: Map<string, Record<string, string>> | null = null;
let _jobSlugMapPromise: Promise<void> | null = null;

/** Register the job slug map so the router can translate job slugs across locales. */
export function registerJobSlugMap(jobs: Array<{ slug?: string; slugByLocale?: Partial<Record<string, string>>; previousSlugs?: string[]; previousSlugsByLocale?: Partial<Record<string, string[]>> }>): void {
 const map = new Map<string, Record<string, string>>();
 for (const job of jobs) {
 const byLocale = job.slugByLocale;
 if (!byLocale) continue;
 const record: Record<string, string> = {};
 for (const [loc, s] of Object.entries(byLocale)) {
 if (s) record[loc] = s;
 }
 // Also include the default slug
 if (job.slug) record['_default'] = job.slug;
 // Index by every locale slug + default slug
 for (const s of Object.values(record)) {
 if (s) map.set(s, record);
 }
 // Index legacy slug aliases so old URLs resolve to current job
 if (Array.isArray(job.previousSlugs)) {
 for (const alias of job.previousSlugs) {
 if (alias && !map.has(alias)) map.set(alias, record);
 }
 }
 // Index locale-aware previous slugs
 if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(job.previousSlugsByLocale)) {
 if (Array.isArray(arr)) {
 for (const alias of arr) {
 if (alias && !map.has(alias)) map.set(alias, record);
 }
 }
 }
 }
 }
 _jobSlugMap = map;

 // Do NOT rewrite the browser URL when the slug belongs to a different
 // locale than the current path. The content is resolved correctly by
 // JobBoard via slugByLocale/previousSlugs, and the canonical <link>
 // (built from buildPath with the current locale) already points to the
 // properly localized URL. Rewriting here would cause indexed
 // cross-locale URLs to visibly redirect, which we want to avoid.
}

/** Translate a job slug to the given locale (returns undefined if unknown). */
function translateJobSlug(slug: string, targetLocale: string): string | undefined {
 if (!_jobSlugMap) return undefined;
 const record = _jobSlugMap.get(slug);
 if (!record) return undefined;
 return record[targetLocale] || record['_default'];
}

/**
 * Public export: translate any-locale job slug to the target locale.
 * Returns undefined if the slug map is not yet loaded or the slug is not found.
 * Used by App.tsx to sync jobSlug state when locale switches.
 */
export function getLocalizedJobSlug(slug: string, targetLocale: string): string | undefined {
 return translateJobSlug(slug, targetLocale);
}

export async function ensureJobSlugMapLoaded(): Promise<void> {
 if (_jobSlugMap) return;
 if (!_jobSlugMapPromise) {
 _jobSlugMapPromise = fetch('/data/jobs-slug-map.json')
 .then(r => r.ok ? r.json() : Promise.reject(r.status))
 .then((data: Array<{ slug?: string; slugByLocale?: Partial<Record<string, string>>; previousSlugs?: string[]; previousSlugsByLocale?: Partial<Record<string, string[]>> }>) => {
 registerJobSlugMap(data);
 })
 .finally(() => {
 _jobSlugMapPromise = null;
 });
 }
 await _jobSlugMapPromise;
}

// Defer job slug map loading — only preload when user navigates to job-board tab.
// The JobBoard component will trigger loading via registerJobSlugMap().
// This saves ~800ms of main-thread blocking on initial page load.
if (typeof window !== 'undefined') {
 // Use requestIdleCallback (or setTimeout fallback) so it doesn't block LCP
 const deferLoad = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 4000);
 deferLoad(() => {
 ensureJobSlugMapLoaded().catch(() => { /* non-critical — JobBoard will register later */ });
 });
}

// ── Lazy-loaded blog data (code-split into routerBlogData.ts) ──
let _blogSlugs: Record<BlogArticleId, Record<Locale, string>> | null = null;
let _reverseBlog: Record<Locale, Record<string, BlogArticleId>> | null = null;
let _blogDataPromise: Promise<void> | null = null;

/** Trigger lazy load of blog slug data. Safe to call multiple times. */
export function preloadBlogData(): Promise<void> {
 if (_blogSlugs) return Promise.resolve();
 if (!_blogDataPromise) {
 _blogDataPromise = import('./routerBlogData').then(m => {
 _blogSlugs = m.BLOG_SLUGS;
 _reverseBlog = m.REVERSE_BLOG;
 });
 }
 return _blogDataPromise;
}

/** Resolve a blog slug to an article ID (returns undefined if data not loaded or slug unknown). */
export function resolveBlogSlug(slug: string, locale: Locale): BlogArticleId | undefined {
 return _reverseBlog?.[locale]?.[slug];
}

const REVERSE_CALCOLATORE = buildLocaleReverses(CALCOLATORE_SUB_TO_SLUG);
const REVERSE_CONFRONTI = buildLocaleReverses(CONFRONTI_SUB_TO_SLUG);
// Widened to Record<string, string> because tax-return country variants
// ('tax-return-italia', 'tax-return-svizzera') are intermediate sentinel values
// resolved in parsePath before casting to FiscoSubTab.
const REVERSE_FISCO: Record<Locale, Record<string, string>> = buildLocaleReverses(FISCO_SUB_TO_SLUG);
const REVERSE_GUIDA = buildLocaleReverses(GUIDA_SUB_TO_SLUG);
const REVERSE_VITA = buildLocaleReverses(VITA_SUB_TO_SLUG);

// ── Legacy sub-slug aliases (old slugs that were renamed for SEO) ──
// These allow old bookmarked/indexed sub-URLs to still resolve correctly.
// Calcolatore legacy sub-slugs
REVERSE_CALCOLATORE.it['calcola-busta-paga'] = 'payslip';
REVERSE_CALCOLATORE.it['calcola-bonus-frontaliere'] = 'bonus';
REVERSE_CALCOLATORE.it['calcola-congedo-parentale'] = 'parental-leave';
REVERSE_CALCOLATORE.it['confronta-stipendio-ral'] = 'ral';
REVERSE_CALCOLATORE.en['calculate-payslip'] = 'payslip';
REVERSE_CALCOLATORE.en['calculate-bonus'] = 'bonus';
REVERSE_CALCOLATORE.en['calculate-parental-leave'] = 'parental-leave';
REVERSE_CALCOLATORE.de['lohnabrechnung-berechnen'] = 'payslip';
REVERSE_CALCOLATORE.de['bonus-berechnen'] = 'bonus';
REVERSE_CALCOLATORE.de['elternzeit-berechnen'] = 'parental-leave';
REVERSE_CALCOLATORE.fr['calculer-fiche-de-paie'] = 'payslip';
REVERSE_CALCOLATORE.fr['calculer-bonus'] = 'bonus';
REVERSE_CALCOLATORE.fr['calculer-conge-parental'] = 'parental-leave';
// Fisco legacy sub-slugs
REVERSE_FISCO.it['calcola-pensione'] = 'pension';
REVERSE_FISCO.en['calculate-pension'] = 'pension';
REVERSE_FISCO.fr['calculer-retraite'] = 'pension';
// Tax-return country variants
REVERSE_FISCO.it['dichiarazione-redditi-italia'] = 'tax-return-italia';
REVERSE_FISCO.it['dichiarazione-redditi-svizzera'] = 'tax-return-svizzera';
REVERSE_FISCO.en['tax-return-italy'] = 'tax-return-italia';
REVERSE_FISCO.en['tax-return-switzerland'] = 'tax-return-svizzera';
REVERSE_FISCO.de['steuererklaerung-italien'] = 'tax-return-italia';
REVERSE_FISCO.de['steuererklaerung-schweiz'] = 'tax-return-svizzera';
REVERSE_FISCO.fr['declaration-revenus-italie'] = 'tax-return-italia';
REVERSE_FISCO.fr['declaration-revenus-suisse'] = 'tax-return-svizzera';
REVERSE_FISCO.it['aliquote-imposta-alla-fonte-ticino-2026'] = 'withholding-rates';
REVERSE_FISCO.en['ticino-withholding-tax-rates-2026'] = 'withholding-rates';
REVERSE_FISCO.de['quellensteuer-tessin-2026'] = 'withholding-rates';
REVERSE_FISCO.fr['baremes-impot-a-la-source-tessin-2026'] = 'withholding-rates';
// Guida legacy sub-slugs (IT only)
REVERSE_GUIDA.it['disoccupazione-frontaliere'] = 'unemployment';
REVERSE_GUIDA.it['costo-auto-frontaliere'] = 'car-cost';
// Vita legacy sub-slugs
REVERSE_VITA.it['aziende-canton-ticino'] = 'companies';
REVERSE_VITA.it['scuole-canton-ticino'] = 'schools';
REVERSE_VITA.it['cosa-vedere-ticino'] = 'places';
REVERSE_VITA.en['ticino-companies'] = 'companies';
REVERSE_VITA.en['schools-in-ticino'] = 'schools';
REVERSE_VITA.en['things-to-do-ticino'] = 'places';
REVERSE_VITA.de['unternehmen-tessin'] = 'companies';
REVERSE_VITA.de['schulen-im-tessin'] = 'schools';
REVERSE_VITA.de['ausflugsziele-tessin'] = 'places';
REVERSE_VITA.fr['entreprises-tessin'] = 'companies';
REVERSE_VITA.fr['ecoles-au-tessin'] = 'schools';
REVERSE_VITA.fr['que-voir-tessin'] = 'places';

function buildStatsReverse(table: SlugTable): SubSlugMap<StatsSubTab> {
 const map: SubSlugMap<StatsSubTab> = {};
 for (const { key, id } of STATS_KEYS) {
 if (id !== 'overview') map[table[key]] = id;
 }
 for (const { key, id } of LEGACY_STATS_KEYS) {
 map[table[key]] = id;
 }
 return map;
}

const REVERSE_STATS: Record<Locale, SubSlugMap<StatsSubTab>> = {
 it: buildStatsReverse(SLUG_TABLES.it),
 en: buildStatsReverse(SLUG_TABLES.en),
 de: buildStatsReverse(SLUG_TABLES.de),
 fr: buildStatsReverse(SLUG_TABLES.fr),
};

// ── Legacy URL resolution ────────────────────────────────────

interface LegacyRedirect {
 tab: ActiveTab;
 subField: string;
 subValue: string;
}

// ── Legacy slug constants (never change these) ──────────────
// These are old slugs from before the SEO-friendly slug rewrite.
// They're used to resolve bookmarked/indexed old URLs.
const LEGACY_SLUGS: Record<Locale, {
 comparatori: string;
 confronti: string;
 guide: string;
 pension: string;
 pillar3: string;
 strumenti: string;
 whatif: string;
 payslip: string;
 costs: string;
 carCost: string;
 permitCompare: string;
 livability: string;
 salaryCompare: string;
 // Old sub-slugs under /comparatori or /guida-frontalieri
 subSlugs: Record<string, { tab: ActiveTab; subField: string; subValue: string }>;
}> = {
 it: {
 comparatori: 'comparatori',
 confronti: 'confronta-servizi',
 guide: 'guida-frontalieri',
 pension: 'pianificatore-pensione',
 pillar3: 'terzo-pilastro',
 strumenti: 'strumenti',
 whatif: 'simulatore-what-if',
 payslip: 'busta-paga',
 costs: 'costi-pendolarismo',
 carCost: 'costo-auto',
 permitCompare: 'permesso-g-vs-b',
 livability: 'vivibilita-comuni',
 salaryCompare: 'confronto-stipendi',
 subSlugs: {
 'cambio-valuta': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'exchange' },
 'operatori-mobili': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'mobile' },
 'banche': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'banks' },
 'assicurazione-sanitaria': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'health' },
 'assicurazioni-sanitarie': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'health' },
 'trasporti': { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-cost' },
 'offerte-lavoro': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'jobs' },
 'spesa-transfrontaliera': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'shopping' },
 'costo-vita': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'cost-of-living' },
 'costo-della-vita': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'cost-of-living' },
 'asili-nido': { tab: 'vita', subField: 'vitaSubTab', subValue: 'nursery' },
 'traffico-dogane': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 'traffico-valichi': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 'confronto-ral': { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'ral' },
 'congedo-genitoriale': { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'parental-leave' },
 'mappa-comuni': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border-map' },
 'cambio-residenza': { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'residency' },
 'bonus-ristrutturazione': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'renovation' },
 'calcolo-bonus': { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'bonus' },
 'sondaggio-stipendi': { tab: 'stats', subField: 'statsSubTab', subValue: 'salary-compare' },
 // Old guide sub-slugs
 'comuni-frontiera': { tab: 'vita', subField: 'vitaSubTab', subValue: 'municipalities' },
 'valichi-frontiera': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 'vivere-in-svizzera': { tab: 'vita', subField: 'vitaSubTab', subValue: 'living-ch' },
 'vivere-in-italia': { tab: 'vita', subField: 'vitaSubTab', subValue: 'living-it' },
 'calendario-fiscale': { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'calendar' },
 'festivita-ticino': { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'holidays' },
 'permessi-lavoro': { tab: 'guida', subField: 'guidaSubTab', subValue: 'permits' },
 'aziende-ticino': { tab: 'vita', subField: 'vitaSubTab', subValue: 'companies' },
 'posti-da-visitare': { tab: 'vita', subField: 'vitaSubTab', subValue: 'places' },
 'scuole-ticino': { tab: 'vita', subField: 'vitaSubTab', subValue: 'schools' },
 'disoccupazione': { tab: 'guida', subField: 'guidaSubTab', subValue: 'unemployment' },
 'primo-giorno': { tab: 'guida', subField: 'guidaSubTab', subValue: 'first-day' },
 'dichiarazione-redditi': { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'tax-return' },
 'trasferimento-auto': { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-transfer' },
 'ristorni-fiscali': { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'ristorni' },
 },
 },
 en: {
 comparatori: 'comparators',
 confronti: 'compare-services',
 guide: 'frontier-guide',
 pension: 'pension-planner',
 pillar3: 'third-pillar',
 strumenti: 'tools',
 whatif: 'what-if-simulator',
 payslip: 'payslip-simulator',
 costs: 'commuting-costs',
 carCost: 'car-cost',
 permitCompare: 'permit-g-vs-b',
 livability: 'livability-index',
 salaryCompare: 'salary-comparison',
 subSlugs: {
 'currency-exchange': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'exchange' },
 'mobile-operators': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'mobile' },
 'banks': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'banks' },
 'health-insurance': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'health' },
 'transport': { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-cost' },
 'job-offers': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'jobs' },
 'cross-border-shopping': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'shopping' },
 'cost-of-living': { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'cost-of-living' },
 'border-traffic': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 },
 },
 de: {
 comparatori: 'vergleiche',
 confronti: 'dienste-vergleichen',
 guide: 'grenzgaenger-ratgeber',
 pension: 'rentenplaner',
 pillar3: 'dritte-saeule',
 strumenti: 'werkzeuge',
 whatif: 'was-waere-wenn',
 payslip: 'lohnabrechnung',
 costs: 'pendelkosten',
 carCost: 'autokosten',
 permitCompare: 'bewilligung-g-vs-b',
 livability: 'lebensqualitaet-index',
 salaryCompare: 'gehaltsvergleich-branche',
 subSlugs: {
 'grenzverkehr': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 },
 },
 fr: {
 comparatori: 'comparateurs',
 confronti: 'comparer-services',
 guide: 'guide-frontalier',
 pension: 'planificateur-retraite',
 pillar3: 'troisieme-pilier',
 strumenti: 'outils',
 whatif: 'simulateur-hypothetique',
 payslip: 'fiche-de-paie',
 costs: 'couts-pendulaire',
 carCost: 'cout-voiture',
 permitCompare: 'permis-g-vs-b',
 livability: 'indice-habitabilite',
 salaryCompare: 'comparaison-salaires',
 subSlugs: {
 'trafic-frontiere': { tab: 'guida', subField: 'guidaSubTab', subValue: 'border' },
 },
 },
};

function buildTopLevelReverse(table: SlugTable, locale: Locale): TopLevelSlugMap {
 const legacy = LEGACY_SLUGS[locale];
 const map: TopLevelSlugMap = {
 [table.calcolatore]: { tab: 'calculator' },
 [table.confronti]: { tab: 'confronti' },
 [table.fisco]: { tab: 'fisco' },
 [table.guida]: { tab: 'guida' },
 [table.vita]: { tab: 'vita' },
 [table.stats]: { tab: 'stats' },
 [table.feedback]: { tab: 'feedback' },
 [table.privacy]: { tab: 'privacy' },
 [table.terms]: { tab: 'terms' },
 [table.chiSiamo]: { tab: 'chi-siamo' },
 [table.correzioni]: { tab: 'correzioni' },
 [table.metodologia]: { tab: 'metodologia' },
 [table.dataDeletion]: { tab: 'data-deletion' },
 [table.apiStatus]: { tab: 'api-status' },
 [table.newsletter]: { tab: 'feedback' },
 [table.gamification]: { tab: 'gamification' },
 [table.dashboard]: { tab: 'profile' },
 [table.forum]: { tab: 'forum' },
 [table.contact]: { tab: 'contact' },
 [table.partners]: { tab: 'partners' },
 [table.consulting]: { tab: 'consulting' },
 [table.pressKit]: { tab: 'press-kit' as const },
 [table.jobBoard]: { tab: 'job-board' },
 [table.profile]: { tab: 'profile' },
 [table.morning]: { tab: 'morning' },
 [table.blog]: { tab: 'blog' },
 [table.glossario]: { tab: 'glossario' },
 [table.dialetto]: { tab: 'dialetto' },
 [table.faq]: { tab: 'faq' },
 [table.sitemap]: { tab: 'sitemap' },
 [table.contracts]: { tab: 'contracts' },
 [table.tfrCalculator]: { tab: 'tfr-calculator' },
 [table.permitQuiz]: { tab: 'permit-quiz' },
 [table.tredicesima]: { tab: 'tredicesima' },
 [table.weeklyDigest]: { tab: 'weekly-digest' },
 [table.toolOfWeek]: { tab: 'tool-of-week' },
 [table.emailConfirmed]: { tab: 'email-confirmed' },
 [table.newsletterPreferences]: { tab: 'newsletter-preferences' },
 [table.admin]: { tab: 'admin' },
 [table.sindacati]: { tab: 'sindacati' },
 [table.tassazioneHub]: { tab: 'tassazione-hub' },
 [table.whatif]: { tab: 'calculator', sub: 'whatif' },
 [table.payslip]: { tab: 'calculator', sub: 'payslip' },
 };
 // Legacy top-level slugs — only add if not already a key
 if (!map[legacy.comparatori]) map[legacy.comparatori] = { tab: 'confronti' };
 if (!map[legacy.confronti]) map[legacy.confronti] = { tab: 'confronti' };
 if (!map[legacy.strumenti]) map[legacy.strumenti] = { tab: 'guida' };
 if (!map[legacy.guide]) map[legacy.guide] = { tab: 'guida' };
 if (!map[legacy.pension]) map[legacy.pension] = { tab: 'fisco', sub: 'pension' };
 if (!map[legacy.whatif]) map[legacy.whatif] = { tab: 'calculator', sub: 'whatif' };
 if (!map[legacy.payslip]) map[legacy.payslip] = { tab: 'calculator', sub: 'payslip' };
 // Also add table-level legacy entries if different
 if (!map[table.comparatori]) map[table.comparatori] = { tab: 'confronti' };
 if (!map[table.strumenti]) map[table.strumenti] = { tab: 'guida' };
 if (!map[table.guide]) map[table.guide] = { tab: 'guida' };
 if (!map[table.pension]) map[table.pension] = { tab: 'fisco', sub: 'pension' };
 // Hardcoded legacy: IT once used bare 'confronti' as a parent slug
 if (locale === 'it' && !map['confronti']) map['confronti'] = { tab: 'confronti' };
 // GA4/bookmark legacy: bare English path names from old routing
 if (!map['calculator']) map['calculator'] = { tab: 'calculator' };
 if (!map['stats']) map['stats'] = { tab: 'stats' };
 if (!map['guide']) map['guide'] = { tab: 'guida' };
 // Intuitive-URL aliases: users guess these slugs from the tab label
 if (!map['fisco']) map['fisco'] = { tab: 'fisco' };
 if (locale === 'en' && !map['taxes']) map['taxes'] = { tab: 'fisco' };
 if (locale === 'de' && !map['steuern']) map['steuern'] = { tab: 'fisco' };
 if (locale === 'fr' && !map['fiscalite']) map['fiscalite'] = { tab: 'fisco' };
 // Job-board intuitive aliases: users type the bare word instead of the
 // full SEO slug (e.g. /lavoro instead of /cerca-lavoro-ticino).
 if (locale === 'it' && !map['lavoro']) map['lavoro'] = { tab: 'job-board' };
 if (locale === 'en' && !map['jobs']) map['jobs'] = { tab: 'job-board' };
 if (locale === 'de' && !map['jobs']) map['jobs'] = { tab: 'job-board' };
 if (locale === 'fr' && !map['emploi']) map['emploi'] = { tab: 'job-board' };
 return map;
}

const REVERSE_TOP: Record<Locale, TopLevelSlugMap> = {
 it: buildTopLevelReverse(SLUG_TABLES.it, 'it'),
 en: buildTopLevelReverse(SLUG_TABLES.en, 'en'),
 de: buildTopLevelReverse(SLUG_TABLES.de, 'de'),
 fr: buildTopLevelReverse(SLUG_TABLES.fr, 'fr'),
};

// ── Locale detection from path ───────────────────────────────

function detectLocaleFromPath(parts: string[]): [Locale, string[]] {
 if (parts.length > 0 && ['en', 'de', 'fr'].includes(parts[0])) {
 return [parts[0] as Locale, parts.slice(1)];
 }
 return ['it', parts];
}

function localePrefix(locale: Locale): string {
 return locale === 'it' ? '' : `/${locale}`;
}

function resolveLegacyUrl(first: string, second: string | undefined, table: SlugTable, locale: Locale): LegacyRedirect | null {
 const legacy = LEGACY_SLUGS[locale];

 // Old /comparatori/... or /confronti/... → split across confronti, calcolatore, fisco, guida, vita
 if (first === legacy.comparatori || first === table.comparatori || (locale === 'it' && first === 'confronti')) {
 if (!second) return { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'exchange' };
 // Check hardcoded legacy sub-slugs first
 const legSub = legacy.subSlugs[second];
 if (legSub) return legSub;
 // Then check current reverse tables
 const revConfronti = REVERSE_CONFRONTI[locale];
 if (revConfronti[second]) return { tab: 'confronti', subField: 'confrontiSubTab', subValue: revConfronti[second] };
 const revCalc = REVERSE_CALCOLATORE[locale];
 if (revCalc[second]) return { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: revCalc[second] };
 const revFisco = REVERSE_FISCO[locale];
 if (revFisco[second]) return { tab: 'fisco', subField: 'fiscoSubTab', subValue: revFisco[second] };
 const revGuida = REVERSE_GUIDA[locale];
 if (revGuida[second]) return { tab: 'guida', subField: 'guidaSubTab', subValue: revGuida[second] };
 const revVita = REVERSE_VITA[locale];
 if (revVita[second]) return { tab: 'vita', subField: 'vitaSubTab', subValue: revVita[second] };
 if (second === legacy.costs) return { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'cost-of-living' };
 return { tab: 'confronti', subField: 'confrontiSubTab', subValue: 'exchange' };
 }

 // Old /guida-frontalieri/... → split between guida, vita, fisco
 if (first === legacy.guide || first === table.guide) {
 if (!second) return { tab: 'guida', subField: 'guidaSubTab', subValue: 'first-day' };
 const legSub = legacy.subSlugs[second];
 if (legSub) return legSub;
 const revGuida = REVERSE_GUIDA[locale];
 if (revGuida[second]) return { tab: 'guida', subField: 'guidaSubTab', subValue: revGuida[second] };
 const revVita = REVERSE_VITA[locale];
 if (revVita[second]) return { tab: 'vita', subField: 'vitaSubTab', subValue: revVita[second] };
 const revFisco = REVERSE_FISCO[locale];
 if (revFisco[second]) return { tab: 'fisco', subField: 'fiscoSubTab', subValue: revFisco[second] };
 return { tab: 'guida', subField: 'guidaSubTab', subValue: 'first-day' };
 }

 // Old /pianificatore-pensione/... → now under fisco
 if (first === legacy.pension || first === table.pension) {
 if (second === legacy.pillar3 || second === table.pillar3) return { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'pillar3' };
 return { tab: 'fisco', subField: 'fiscoSubTab', subValue: 'pension' };
 }

 // Old /strumenti/... → split between guida and calcolatore
 if (first === legacy.strumenti || first === table.strumenti) {
 if (!second) return { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-cost' };
 if (second === legacy.carCost || second === table.carCost) return { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-cost' };
 if (second === legacy.permitCompare || second === table.permitCompare) return { tab: 'guida', subField: 'guidaSubTab', subValue: 'permit-compare' };
 if (second === legacy.payslip || second === table.payslip) return { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'payslip' };
 if (second === legacy.livability || second === table.livability) return { tab: 'stats', subField: 'statsSubTab', subValue: 'livability' };
 if (second === legacy.salaryCompare || second === table.salaryCompare) return { tab: 'stats', subField: 'statsSubTab', subValue: 'salary-compare' };
 return { tab: 'guida', subField: 'guidaSubTab', subValue: 'car-cost' };
 }

 // Old standalone slugs that are now sub-tabs
 if (first === legacy.whatif) return { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'whatif' };
 if (first === legacy.payslip) return { tab: 'calculator', subField: 'calcolatoreSubTab', subValue: 'payslip' };

 return null;
}

// ── Public API ───────────────────────────────────────────────

export interface ParseResult {
 route: AppRoute;
 locale: Locale;
 /** Set when the URL could not be matched to any known route */
 notFoundPath?: string;
}

export function parsePath(pathname: string): ParseResult {
 const path = pathname.replace(/\/$/, '').toLowerCase() || '/';
 const allParts = path.split('/').filter(Boolean);
 const [locale, parts] = detectLocaleFromPath(allParts);

 const table = SLUG_TABLES[locale];
 const revTop = REVERSE_TOP[locale];

 // Fuel-daily static SEO pages (F6) — /prezzi-diesel/oggi/, /en/diesel-price-switzerland/today/, etc.
 // These are build-time static HTML rendered OUTSIDE `#root` (see
 // build-plugins/htmlTemplate.ts seoContentOutsideRoot). Soft-nav still
 // resolves to the fuel-prices Statistiche tab so internal SPA <a> clicks
 // land on a usable view, but `staticOverlay: true` tells App.tsx + pushRoute
 // to leave the URL alone and skip the React main render so the static
 // content stays visible.

 // Weather city pages (PR2) — /meteo-frontalieri/{city}/ + 4-locale variants.
 // Always-static SSG, no SPA equivalent: route to Statistiche tab with
 // staticOverlay so SPA doesn't replace SSG content with a generic fallback.
 if (/^\/(meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers)\/?$/.test(pathname) ||
     /^\/(en|de|fr)\/(meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers)\/?$/.test(pathname) ||
     /^\/(meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers)\/[a-z-]+\/?$/.test(pathname) ||
     /^\/(en|de|fr)\/(meteo-frontalieri|commute-weather|pendler-wetter|meteo-frontaliers)\/[a-z-]+\/?$/.test(pathname)) {
   const localeMatch = pathname.match(/^\/(en|de|fr)\//);
   const inferredLocale = (localeMatch ? localeMatch[1] : 'it') as Locale;
   return { route: { activeTab: 'stats', staticOverlay: true }, locale: inferredLocale };
 }


 // Weather alert pages (PR3) — /allerte/{type}/ + 4-locale variants
 // (alerts, warnungen, alertes). Plus hub /allerte-meteo/ + variants.
 if (/^\/(allerte-meteo|weather-alerts|wetterwarnungen|alertes-meteo)\/?$/.test(pathname) ||
     /^\/(en|de|fr)\/(allerte-meteo|weather-alerts|wetterwarnungen|alertes-meteo)\/?$/.test(pathname) ||
     /^\/(allerte|alerts|warnungen|alertes)\/[a-z-]+\/?$/.test(pathname) ||
     /^\/(en|de|fr)\/(allerte|alerts|warnungen|alertes)\/[a-z-]+\/?$/.test(pathname)) {
   const localeMatch = pathname.match(/^\/(en|de|fr)\//);
   const inferredLocale = (localeMatch ? localeMatch[1] : 'it') as Locale;
   return { route: { activeTab: 'stats', staticOverlay: true }, locale: inferredLocale };
 }

 if (FUEL_DAILY_ROUTES.includes(pathname.endsWith('/') ? pathname : `${pathname}/`) || isFuelDailyPath(pathname)) {
   return { route: { activeTab: 'stats', statsSubTab: 'fuel-prices', staticOverlay: true }, locale };
 }

 // Health-premium landings (F2) — /premi-cassa-malati/{canton}/{age}/ + localised variants.
 // Build-time static HTML; staticOverlay leaves the per-canton/per-age content
 // visible so the SPA doesn't replace it with the generic Statistiche sub-tab.
 if (HEALTH_PREMIUMS_ROUTES.includes(pathname.endsWith('/') ? pathname : `${pathname}/`) || isHealthPremiumsPath(pathname)) {
   return { route: { activeTab: 'stats', statsSubTab: 'health-premiums', staticOverlay: true }, locale };
 }

 // Weekly "Aziende che assumono" per-city hub (F5) — build-time static HTML.
 // staticOverlay keeps the per-city/per-company content visible (otherwise
 // the SPA would render the generic job-board listing in its place).
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (WEEKLY_EMPLOYERS_ROUTES.includes(normalized)) {
     const parsed = parseWeeklyEmployersPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
   const weeklyEmployersMatch = parseWeeklyEmployersPath(pathname);
   if (weeklyEmployersMatch) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: weeklyEmployersMatch.locale as Locale };
   }
   // Top-hub section root (`/aziende-che-assumono/` and locale equivalents).
   // Without this match the SPA hydration falls back to the calculator
   // landing and the static SSG content is wiped on first paint — bug
   // reported 2026-05-07. The hub is emitted by weeklyEmployersPlugin's
   // renderTopHubPage and pairs with `staticOverlay: true` so App.tsx
   // doesn't replace the dist HTML.
   const weeklyEmployersTopHub = parseWeeklyEmployersTopHubPath(pathname);
   if (weeklyEmployersTopHub) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: weeklyEmployersTopHub.locale as Locale };
   }
   // D-2 Expansion B: per-company × per-city hub (e.g.
   // /aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/).
   const companyCityMatch = parseCompanyCityPath(pathname);
   if (companyCityMatch) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: companyCityMatch.locale as Locale };
   }
 }

 // Job-market snapshot static SEO pages (F4) — /mercato-lavoro-ticino/, weekly + monthly archives.
 // staticOverlay keeps the per-snapshot/per-sector page content visible.
 if (JOB_MARKET_SNAPSHOT_ROUTES.includes(pathname.endsWith('/') ? pathname : `${pathname}/`) || isJobMarketSnapshotPath(pathname)) {
   return { route: { activeTab: 'stats', statsSubTab: 'jobs-observatory', staticOverlay: true }, locale };
 }

 // Border-wait static SEO pages (F8) — /traffico-dogane/{crossing}/oggi/, hubs, archives.
 // staticOverlay keeps the per-crossing static content visible. The
 // borderCrossing deep-link is preserved so a future popstate (back into
 // the SPA from elsewhere) lands on the right marker.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (BORDER_WAIT_ROUTES.includes(normalized) || isBorderWaitPath(pathname)) {
     const parsed = parseBorderWaitPath(pathname);
     const targetLocale: Locale = (parsed?.locale as Locale) || locale;
     if (parsed?.crossing && BORDER_CROSSING_ID_SET.has(parsed.crossing)) {
       return {
         route: {
           activeTab: 'guida',
           guidaSubTab: 'border',
           borderCrossing: parsed.crossing as BorderCrossingId,
           staticOverlay: true,
         },
         locale: targetLocale,
       };
     }
     return { route: { activeTab: 'guida', guidaSubTab: 'border', staticOverlay: true }, locale: targetLocale };
   }
 }

 // Annual report static SEO page — /report/frontalieri-2026/ + locale variants.
 // Emitted via buildSeoPageHtml (seoContentOutsideRoot:true); staticOverlay
 // keeps the static content visible (otherwise SPA falls into notFoundPath
 // and renders the 404 helper inside #root). Mirrors fuel-daily pattern.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (ANNUAL_REPORT_PATHS.has(normalized)) {
     return { route: { activeTab: 'stats', staticOverlay: true }, locale };
   }
 }

 // Market report static SEO page — /reports/{slug}-2026/ + locale variants.
 // Same staticOverlay contract as the annual report above.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (MARKET_REPORT_PATHS.has(normalized)) {
     return { route: { activeTab: 'stats', staticOverlay: true }, locale };
   }
 }

 // Border-wait live map hub — /guida-frontaliere/mappa-live-valichi/ + locale
 // variants. Without staticOverlay the URL falls into the generic guida tab
 // (first-day fallback) and the SPA replaces the map. Routes to the border
 // sub-tab so back-nav lands on a usable view.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (BORDER_WAIT_MAP_PATHS.has(normalized)) {
     return { route: { activeTab: 'guida', guidaSubTab: 'border', staticOverlay: true }, locale };
   }
 }

 // FR salary calculator landing — /fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/.
 // Without staticOverlay the SPA's calculator tab parser treats the trailing
 // segment as an unknown sub-tab slug, falls back to the default calculator
 // view and replaces the bespoke landing body. Mirrors the F6 / health-premiums
 // contract: keep the static HTML visible, route to calculator for back-nav.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (FR_SALAIRE_NET_PATHS.has(normalized)) {
     return {
       route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', staticOverlay: true },
       locale: 'fr',
     };
   }
 }

 // Salary-hub evergreen articles (8 × 4 locales) — /guida-frontaliere/{slug}/
 // and locale variants. Without staticOverlay the unknown slug under the guida
 // tab falls back to first-day, and the SPA replaces the article body.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (SALARY_HUB_ARTICLE_PATHS.has(normalized)) {
     return { route: { activeTab: 'guida', guidaSubTab: 'first-day', staticOverlay: true }, locale };
   }
 }

 // Nursing / healthcare SEO landings (P2) — /lavoro-infermieri-svizzera/,
 // /lavoro-oss-svizzera/, /lavoro-sanitario-ticino/ + locale variants. Pages
 // are statically generated with `seoContentOutsideRoot: true`; staticOverlay
 // keeps the per-landing content visible so the SPA doesn't replace it.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (NURSING_LANDING_ROUTES.includes(normalized) || isNursingLandingPath(pathname)) {
     const parsed = parseNursingLandingPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
 }

 // AE-2 — Career quick-win landings (/agenzie-del-lavoro-lugano/,
 // /concorsi-pubblici-lugano/, /stage-lugano/, /contratti-lavoro-frontalieri/
 // + locale variants). Same static-overlay + seoContentOutsideRoot contract
 // as the nursing landings; the plugin renders the editorial body outside
 // #root so the SPA doesn't replace it with a generic job-board view.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (CAREER_LANDING_ROUTES.includes(normalized) || isCareerLandingPath(pathname)) {
     const parsed = parseCareerLandingPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
 }

 // AE-4 — Cost-of-living city landings (/costo-vita-<city>-ticino/ + locale
 // variants). 6 cities × 4 locales = 24 URLs. Pages are generated with
 // `seoContentOutsideRoot: true`; staticOverlay keeps the per-city content
 // visible so the SPA does not replace it with the generic confronti hub.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (COST_OF_LIVING_LANDING_ROUTES.includes(normalized) || isCostOfLivingLandingPath(pathname)) {
     const parsed = parseCostOfLivingLandingPath(pathname);
     if (parsed) {
       return {
         route: { activeTab: 'confronti', confrontiSubTab: 'cost-of-living', staticOverlay: true },
         locale: parsed.locale as Locale,
       };
     }
   }
 }

 // AE-3 — Profession landings (10 professions × 4 locales = 40 URLs). Same
 // static-overlay pattern as nursing: the plugin renders a 500+ word page
 // outside `#root` and this staticOverlay route prevents the SPA from
 // replacing it with the generic job-board UI.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (PROFESSION_LANDING_ROUTES.includes(normalized) || isProfessionLandingPath(pathname)) {
     const parsed = parseProfessionLandingPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
 }

 // AE-7 — Comparisons hub (/confronti-frontalieri/ + locale variants). Same
 // static-overlay pattern as the nursing landings: the plugin renders a
 // dense 5-table comparison page outside `#root` and this staticOverlay
 // route prevents the SPA from replacing it with the generic confronti hub.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (COMPARISONS_HUB_ROUTES.includes(normalized) || isComparisonsHubPath(pathname)) {
     const parsed = parseComparisonsHubPath(pathname);
     if (parsed) {
       return {
         route: { activeTab: 'confronti', confrontiSubTab: 'health', staticOverlay: true },
         locale: parsed.locale as Locale,
       };
     }
   }
 }

 // Phase 2-UI — SEO hub pages (jobs/sectors/companies/articles + paginated variants).
 // Static HTML emitted by build-plugins/seoHubsPlugin; staticOverlay leaves the
 // body untouched while the SPA chrome (header + footer) hydrates over #root.
 if (isSeoHubPath(pathname)) {
   const hubLocale = localeFromHubPath(pathname);
   // Articles hub maps to blog tab; everything else to job-board.
   const isArticles = /\/articoli-frontaliere\/|\/cross-border-articles\/|\/grenzgaenger-artikel\/|\/articles-frontalier\//.test(pathname);
   return {
     route: isArticles
       ? { activeTab: 'blog', staticOverlay: true }
       : { activeTab: 'job-board', staticOverlay: true },
     locale: hubLocale as Locale,
   };
 }

 // AE-5 — 100-Q&A FAQ hub (/domande-frequenti-frontalieri/ + locale variants).
 // Hosted under the `guida` top-level tab with `permits` sub-tab pre-selected
 // for the SPA chrome. staticOverlay keeps the build-time 100-entry HTML
 // body visible outside `#root`.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (FAQ_HUB_ROUTES.includes(normalized) || isFaqHubPath(pathname)) {
     const parsed = parseFaqHubPath(pathname);
     if (parsed) {
       return {
         route: { activeTab: 'guida', guidaSubTab: 'permits', staticOverlay: true },
         locale: parsed.locale as Locale,
       };
     }
   }
 }

 if (parts.length === 0) {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, locale };
 }

 // Workstream C SemRush long-tail landings — static HTML generated from
 // `canonicalPath` in SEO_METADATA by staticPagesPlugin. Each landing lives
 // under an existing top-level section (Guida / Vita in Ticino) but is NOT
 // reachable via SPA sub-tab navigation: they are deep-link-only pages. The
 // staticOverlay flag prevents the SPA from rewriting the URL + replacing
 // the static content with a generic sub-tab view (bait-and-switch bug).
 // Extension 3 task 2 — same pattern as fuel-daily / weekly-employers / etc.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (SEMRUSH_LANDING_ROUTES.has(normalized)) {
     const landing = SEMRUSH_LANDINGS.find((l) => l.path === normalized);
     if (landing) {
       const base = landing.tab === 'guida'
         ? { activeTab: 'guida' as const, guidaSubTab: 'first-day' as const }
         : { activeTab: 'vita' as const, vitaSubTab: 'living-ch' as const };
       return { route: { ...base, staticOverlay: true }, locale: 'it' };
     }
   }
 }

 // Orphan-query cluster landings (F3b): /ricerca/<slug>/, /en/search/<slug>/, …
 // Pages are statically generated; staticOverlay keeps the per-cluster static
 // content visible (otherwise the SPA would render the generic job-board listing).
 const orphanMatch = ORPHAN_LANDING_ROUTES(pathname);
 if (orphanMatch) {
 return { route: { activeTab: 'job-board', staticOverlay: true }, locale: orphanMatch.locale as Locale };
 }

 const first = parts[0];
 const second = parts[1];
 const third = parts[2];

 // Check top-level slug
 const topMatch = revTop[first];
 if (topMatch) {
 if (topMatch.sub === 'whatif') {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'whatif' }, locale };
 }
 if (topMatch.sub === 'payslip') {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' }, locale };
 }
 if (topMatch.sub === 'pension') {
 const sub2 = second === table.pillar3 ? 'pillar3' : 'pension';
 return { route: { activeTab: 'fisco', fiscoSubTab: sub2 as FiscoSubTab }, locale };
 }

 // For tabs with sub-tabs: resolve sub-tab from slug
 // Must check both current and legacy top-level slugs
 if (topMatch.tab === 'calculator') {
 // If it's the current calcolatore slug, resolve sub-tab normally
 if (first === table.calcolatore) {
 const revCalc = REVERSE_CALCOLATORE[locale];
 const sub = second ? (revCalc[second] || 'calculator') : 'calculator';
 // Cross-tab redirect: old calcolatore/permit-compare → guida/permit-compare
 if (sub === 'calculator' && second === table.permitCompare) {
 return { route: { activeTab: 'guida', guidaSubTab: 'permit-compare' }, locale };
 }
 if (sub === 'calculator' && second) {
 const landing = SEO_LANDING_REVERSE[locale][second];
 if (landing) {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: landing }, locale };
 }
 // Salary Hub pattern: stipendio-netto-XXXXX-chf-* / net-salary-XXXXX-chf-* / etc.
 // Build-time static HTML rendered OUTSIDE `#root` (see salaryHubPlugin.ts
 // → seoPageShell → seoContentOutsideRoot). staticOverlay: true tells
 // App.tsx + pushRoute to leave the URL alone and skip the React main
 // render so the per-scenario static content stays visible (otherwise the
 // SPA would replace it with the generic Calcolatore tab and collapse the
 // layout into a narrow column). Mirrors the fuel-daily pattern above.
 if (isSalaryHubSlug(second)) {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', salaryHubSlug: second, staticOverlay: true }, locale };
 }
 }
 return { route: { activeTab: 'calculator', calcolatoreSubTab: sub as CalcolatoreSubTab }, locale };
 }
 // Legacy top-level slug pointing to calculator — delegate to legacy resolver
 }

 if (topMatch.tab === 'confronti') {
 if (first === table.confronti || first === LEGACY_SLUGS[locale].confronti || (locale === 'it' && first === 'confronti')) {
 const revConfronti = REVERSE_CONFRONTI[locale];
 const sub = second ? (revConfronti[second] || 'exchange') : 'exchange';
 return { route: { activeTab: 'confronti', confrontiSubTab: sub as ConfrontiSubTab }, locale };
 }
 }

 if (topMatch.tab === 'fisco') {
 if (first === table.fisco) {
 const revFisco = REVERSE_FISCO[locale];
 const sub = second ? (revFisco[second] || 'tax-return') : 'tax-return';
 // Country variant: tax-return-italia / tax-return-svizzera
 if (sub === 'tax-return-italia')
 return { route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'italia' }, locale };
 if (sub === 'tax-return-svizzera')
 return { route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'svizzera' }, locale };
 return { route: { activeTab: 'fisco', fiscoSubTab: sub as FiscoSubTab }, locale };
 }
 }

 if (topMatch.tab === 'guida') {
 if (first === table.guida) {
 const revGuida = REVERSE_GUIDA[locale];
 const sub = second ? (revGuida[second] || 'first-day') : 'first-day';
 // Cross-tab redirect: old guida/municipalities → vita/municipalities
 if (sub === 'first-day' && second === table.municipalities) {
 return { route: { activeTab: 'vita', vitaSubTab: 'municipalities' }, locale };
 }
 // Border crossing deep link: guida/border/<crossing-id>
 if (sub === 'border' && third && BORDER_CROSSING_ID_SET.has(third)) {
 return { route: { activeTab: 'guida', guidaSubTab: 'border', borderCrossing: third as BorderCrossingId }, locale };
 }
 return { route: { activeTab: 'guida', guidaSubTab: sub as GuidaSubTab }, locale };
 }
 }

 if (topMatch.tab === 'vita') {
 if (first === table.vita) {
 const revVita = REVERSE_VITA[locale];
 const sub = second ? (revVita[second] || 'living-ch') : 'living-ch';
 return { route: { activeTab: 'vita', vitaSubTab: sub as VitaSubTab }, locale };
 }
 }

 if (topMatch.tab === 'stats') {
 if (first === table.stats) {
 const revStats = REVERSE_STATS[locale];
 const sub = second ? (revStats[second] || 'overview') : 'overview';
 return { route: { activeTab: 'stats', statsSubTab: sub as StatsSubTab }, locale };
 }
 }

 if (topMatch.tab === 'blog') {
 if (first === table.blog) {
 if (second) {
 const articleId = _reverseBlog?.[locale]?.[second] as BlogArticleId | undefined;
 if (articleId) {
 return { route: { activeTab: 'blog', blogArticle: articleId }, locale };
 }
 // Blog data not loaded yet — store raw slug for deferred resolution
 return { route: { activeTab: 'blog', blogSlug: second }, locale };
 }
 return { route: { activeTab: 'blog' }, locale };
 }
 }

 if (topMatch.tab === 'job-board') {
 if (first === table.jobBoard) {
 const rawSecond = second ? second.trim() : undefined;
 // Clean geo-hub URL: /cerca-lavoro-ticino/lugano/ (and locale variants).
 // Rewrite to the editorial location-landing slug so the client renders
 // the already-built location landing UI, while preserving the city
 // identifier for canonical URL generation in buildPath().
 if (rawSecond) {
 // Sector hub (infermieri / case-anziani / educatori) — clean canonical URLs.
 // staticOverlay tells App.tsx to skip the React main render so the
 // build-time SEO HTML stays visible (lite-shell mode). Without this
 // flag the page survives only because the runtime DOM probe detects
 // `main.seo-static-content`; if that file is ever missing or stripped,
 // the SPA would fall through to a generic JobBoard listing without
 // sector filtering — silently breaking the per-sector landing page.
 const sectorHit = SECTOR_HUB_KEYS.find((s) => SECTOR_HUB_SLUG[locale][s] === rawSecond);
 if (sectorHit) {
 return {
 route: {
 activeTab: 'job-board',
 jobBoardSector: sectorHit as SectorHubKey,
 staticOverlay: true,
 },
 locale,
 };
 }
 const cityHit = CITY_HUB_KEYS.find((c) => CITY_HUB_SLUG[locale][c] === rawSecond);
 if (cityHit) {
 const editorialPrefix: Record<Locale, string> = {
 it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche',
 };
 const editorialSlug = `${editorialPrefix[locale]}-${CITY_HUB_DISPLAY_NAME[cityHit as CityHubKey].toLowerCase()}`;
 return {
 route: {
 activeTab: 'job-board',
 jobBoardCity: cityHit as CityHubKey,
 jobSlug: editorialSlug,
 },
 locale,
 };
 }
 }
 // Editorial landing slugs — must be checked before the generic jobSlug
 // fallthrough so these URLs don't get routed to a job-detail view (either
 // showing the "Annuncio non trovato" banner, or — when the slug happens
 // to read like a job title, e.g. /cerca-lavoro-ticino/lavoro-part-time/ —
 // a synthetic job-detail page whose H1 is derived from the slug, while
 // the static HTML emitted at build time has the proper hub content).
 // The single descriptor call subsumes the previous narrower guards for
 // `today` and `recency` and adds coverage for every editorial landing
 // emitted by jobEditorialLanding.ts:
 //   - official-gazette  (foglio-ufficiale-offerte-di-lavoro-ticino, …)
 //   - nurses-hub        (lavoro-infermieri-ticino, …)
 //   - part-time         (lavoro-part-time / part-time-jobs / teilzeit-jobs / emploi-temps-partiel)
 //   - care-variant      (case-anziani / case-cura / RSA cluster slugs)
 //   - location-only     (ricerca-lugano / search-bellinzona / suche-lugano / recherche-locarno)
 //   - location-type     (ricerca-lugano-part-time, …)
 //   - location-sector   (ricerca-lugano-sanita, …)
 //   - sector-region     (ricerca-sanita-ticino, …)
 // All of these have static HTML on disk and the SPA must NOT re-render
 // over them. staticOverlay tells App.tsx to skip the React main render
 // so the build-time SEO HTML stays visible (lite-shell mode).
 if (rawSecond && resolveEditorialJobLandingDescriptor(rawSecond)) {
 return { route: { activeTab: 'job-board', staticOverlay: true }, locale };
 }
 const jobSlug = rawSecond;
 return { route: { activeTab: 'job-board', ...(jobSlug ? { jobSlug } : {}) }, locale };
 }
 }

 if (topMatch.tab === 'glossario') {
 if (first === table.glossario) {
 if (second) {
 const term = GLOSSARY_TERM_REVERSE[locale][second];
 if (term) return { route: { activeTab: 'glossario', glossaryTerm: term }, locale };
 }
 return { route: { activeTab: 'glossario' }, locale };
 }
 }

 // For legacy top-level slugs with sub-slugs, delegate to legacy resolver
 if (second) {
 const legacy = resolveLegacyUrl(first, second, table, locale);
 if (legacy) {
 const route: AppRoute = { activeTab: legacy.tab };
 (route as unknown as Record<string, unknown>)[legacy.subField] = legacy.subValue;
 return { route, locale };
 }
 }

 // Simple tabs (no sub-tabs) or legacy top-level without sub-slug
 // For legacy tab slugs, return with default sub-tab
 if (topMatch.tab === 'confronti' && !second) return { route: { activeTab: 'confronti', confrontiSubTab: 'exchange' }, locale };
 if (topMatch.tab === 'fisco' && !second) return { route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' }, locale };
 if (topMatch.tab === 'guida' && !second) return { route: { activeTab: 'guida', guidaSubTab: 'first-day' }, locale };
 if (topMatch.tab === 'vita' && !second) return { route: { activeTab: 'vita', vitaSubTab: 'living-ch' }, locale };
 if (topMatch.tab === 'stats' && !second) return { route: { activeTab: 'stats', statsSubTab: 'overview' }, locale };
 if (topMatch.tab === 'calculator' && !second) return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, locale };

 return { route: { activeTab: topMatch.tab as ActiveTab }, locale };
 }

 // Legacy URL resolution (for URLs where the top-level slug isn't in REVERSE_TOP at all)
 const legacy = resolveLegacyUrl(first, second, table, locale);
 if (legacy) {
 const route: AppRoute = { activeTab: legacy.tab };
 (route as unknown as Record<string, unknown>)[legacy.subField] = legacy.subValue;
 return { route, locale };
 }

 // Fallback: try all locales (for bookmarked URLs in wrong locale)
 for (const tryLocale of (['it', 'en', 'de', 'fr'] as Locale[])) {
 if (tryLocale === locale) continue;
 const tryTop = REVERSE_TOP[tryLocale];
 const tryMatch = tryTop[first];
 if (tryMatch) {
 const rebuilt = `/${tryLocale === 'it' ? '' : tryLocale + '/'}${parts.join('/')}`;
 return parsePath(rebuilt);
 }
 }

 // OAuth callback routes are handled by App.tsx useEffect — don't flag as 404
 if (pathname.startsWith('/auth/')) {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, locale };
 }

 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, locale, notFoundPath: pathname };
}

export function parseHashToPath(hash: string): string | null {
 if (!hash || hash === '#' || hash === '#/') return null;
 const path = hash.replace(/^#\/?/, '').toLowerCase();
 const parts = path.split('/').filter(Boolean);
 if (parts.length === 0) return null;

 const locale = getLocale();
 const table = SLUG_TABLES[locale];
 const prefix = localePrefix(locale);

 if (parts[0] === 'calculator') {
 if (parts[1] === 'whatif') return `${prefix}/${table.calcolatore}/${table.whatif}`;
 return '/';
 }
 if (parts[0] === 'comparatori') {
 const subKey = parts[1];
 if (subKey) {
 for (const [sub, slugKey] of Object.entries(CONFRONTI_SUB_TO_SLUG)) {
 if (sub === subKey) return `${prefix}/${table.confronti}/${table[slugKey]}`;
 }
 for (const [sub, slugKey] of Object.entries(CALCOLATORE_SUB_TO_SLUG)) {
 if (sub === subKey) return `${prefix}/${table.calcolatore}/${table[slugKey]}`;
 }
 }
 return `${prefix}/${table.confronti}`;
 }
 if (parts[0] === 'pensione') {
 return parts[1] === 'pillar3'
 ? `${prefix}/${table.fisco}/${table.pillar3}`
 : `${prefix}/${table.fisco}/${table.pension}`;
 }
 if (parts[0] === 'guida') {
 const guida = GUIDA_SUB_TO_SLUG[parts[1] as GuidaSubTab];
 if (guida) return `${prefix}/${table.guida}/${table[guida]}`;
 const vita = VITA_SUB_TO_SLUG[parts[1] as VitaSubTab];
 if (vita) return `${prefix}/${table.vita}/${table[vita]}`;
 return `${prefix}/${table.guida}`;
 }
 if (parts[0] === 'statistiche') {
 if (parts[1] === 'sondaggio-stipendi') return `${prefix}/${table.stats}/${table.salaryCompare}`;
 if (parts[1] === 'ristorni-fiscali') return `${prefix}/${table.stats}/${table.ristorni}`;
 return `${prefix}/${table.stats}`;
 }
 if (parts[0] === 'supporto') return `${prefix}/${table.feedback}`;
 if (parts[0] === 'privacy') return `${prefix}/${table.privacy}`;
 if (parts[0] === 'data-deletion') return `${prefix}/${table.dataDeletion}`;
 if (parts[0] === 'api-status') return `${prefix}/${table.apiStatus}`;

 return null;
}

export function buildPath(route: AppRoute, locale?: Locale): string {
 const lang = locale || getLocale();
 const table = SLUG_TABLES[lang];
 const prefix = localePrefix(lang);
 const hashSuffix = route.hash ? `#${route.hash}` : '';
 const localizeEditorialJobSlug = (jobSlug?: string): string | undefined => {
 const slug = String(jobSlug || '').trim();
 if (!slug) return undefined;
 const descriptor = resolveEditorialJobLandingDescriptor(slug);
 if (!descriptor) {
 // Try to translate a regular job detail slug to the target locale
 return translateJobSlug(slug, lang) || slug;
 }
 if (descriptor.kind === 'today') {
 return buildJobTodayLandingModel({
 jobs: [],
 locale: lang,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'recency') {
 // Locale-switch for recency hubs (last-3-days / since-yesterday).
 // Pure slug lookup — no model rebuild needed.
 return RECENCY_LANDING_SLUGS[descriptor.variant][lang];
 }
 if (descriptor.kind === 'official-gazette') {
 return buildJobOfficialGazetteLandingModel({
 jobs: [],
 locale: lang,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'nurses-hub') {
 return buildJobNursesHubLandingModel({
 jobs: [],
 locale: lang,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'part-time') {
 return buildJobPartTimeLandingModel({
 jobs: [],
 locale: lang,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'care-variant') {
 return buildJobCareVariantLandingModel({
 jobs: [],
 locale: lang,
 clusterKey: descriptor.clusterKey,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'location') {
 return buildJobLocationLandingModel({
 jobs: [],
 locale: lang,
 location: descriptor.location,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'location-sector') {
 return buildJobLocationSectorLandingModel({
 jobs: [],
 locale: lang,
 location: descriptor.location,
 sectorKey: descriptor.sectorKey,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 if (descriptor.kind === 'sector-region') {
 return buildJobSectorRegionLandingModel({
 jobs: [],
 locale: lang,
 sectorKey: descriptor.sectorKey,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 }
 return buildJobLocationTypeLandingModel({
 jobs: [],
 locale: lang,
 location: descriptor.location,
 typeKey: descriptor.typeKey,
 localizedSlug: () => '',
 baseUrl: '',
 sectionSlug: table.jobBoard,
 localePrefix: prefix,
 }).slug;
 };
 const finish = (rawPath: string): string => {
 const [pathPart, hashPart = ''] = rawPath.split('#');
 const normalizedPath = pathPart === '/' ? '/' : `${pathPart.replace(/\/+$/, '')}/`;
 return hashPart ? `${normalizedPath}#${hashPart}` : normalizedPath;
 };

 switch (route.activeTab) {
 case 'calculator': {
 const sub = route.calcolatoreSubTab || 'calculator';
 if (route.seoLanding) {
 const landingSlug = SEO_LANDING_SLUGS[lang][route.seoLanding];
 return finish(`${prefix}/${table.calcolatore}/${landingSlug}${hashSuffix}`);
 }
 // Homepage (calculator main tab): use locale root (/ for IT, /en/ for others)
 // so canonical & hreflang point to the root, not /calcola-stipendio
 if (sub === 'calculator') return finish((lang === 'it' ? '/' : `/${lang}/`) + hashSuffix);
 const slugKey = CALCOLATORE_SUB_TO_SLUG[sub];
 return finish((slugKey ? `${prefix}/${table.calcolatore}/${table[slugKey]}` : `${prefix}/${table.calcolatore}`) + hashSuffix);
 }
 case 'confronti': {
 const sub = route.confrontiSubTab || 'exchange';
 const slugKey = CONFRONTI_SUB_TO_SLUG[sub];
 return finish(`${prefix}/${table.confronti}/${table[slugKey]}${hashSuffix}`);
 }
 case 'fisco': {
 const sub = route.fiscoSubTab || 'tax-return';
 const slugKey = FISCO_SUB_TO_SLUG[sub];
 if (sub === 'tax-return') {
 // Country variant: /tasse-e-pensione/dichiarazione-redditi-{italia|svizzera}
 if (route.taxReturnCountry === 'italia')
 return finish(`${prefix}/${table.fisco}/${table.taxReturnItalia}${hashSuffix}`);
 if (route.taxReturnCountry === 'svizzera')
 return finish(`${prefix}/${table.fisco}/${table.taxReturnSvizzera}${hashSuffix}`);
 // Default: /tasse-e-pensione (no sub-slug)
 return finish(`${prefix}/${table.fisco}${hashSuffix}`);
 }
 return finish(`${prefix}/${table.fisco}/${table[slugKey]}${hashSuffix}`);
 }
 case 'guida': {
 const sub = route.guidaSubTab || 'first-day';
 const slugKey = GUIDA_SUB_TO_SLUG[sub];
 const base = (sub === 'first-day'
 ? `${prefix}/${table.guida}`
 : `${prefix}/${table.guida}/${table[slugKey]}`);
 if (sub === 'border' && route.borderCrossing) {
 return finish(`${base}/${route.borderCrossing}${hashSuffix}`);
 }
 return finish(`${base}${hashSuffix}`);
 }
 case 'vita': {
 const sub = route.vitaSubTab || 'living-ch';
 const slugKey = VITA_SUB_TO_SLUG[sub];
 return finish((sub === 'living-ch'
 ? `${prefix}/${table.vita}`
 : `${prefix}/${table.vita}/${table[slugKey]}`) + hashSuffix);
 }
 case 'stats': {
 const sub = route.statsSubTab || 'overview';
 const statsEntry = STATS_KEYS.find(s => s.id === sub);
 return finish((sub === 'overview'
 ? `${prefix}/${table.stats}`
 : `${prefix}/${table.stats}/${table[statsEntry!.key]}`) + hashSuffix);
 }
 case 'feedback':
 return finish(`${prefix}/${table.feedback}${hashSuffix}`);
 case 'privacy':
 return finish(`${prefix}/${table.privacy}${hashSuffix}`);
 case 'terms':
 return finish(`${prefix}/${table.terms}${hashSuffix}`);
 case 'chi-siamo':
 return finish(`${prefix}/${table.chiSiamo}${hashSuffix}`);
 case 'correzioni':
 return finish(`${prefix}/${table.correzioni}${hashSuffix}`);
 case 'metodologia':
 return finish(`${prefix}/${table.metodologia}${hashSuffix}`);
 case 'sindacati':
 return finish(`${prefix}/${table.sindacati}${hashSuffix}`);
 case 'tassazione-hub':
 return finish(`${prefix}/${table.tassazioneHub}${hashSuffix}`);
 case 'data-deletion':
 return finish(`${prefix}/${table.dataDeletion}${hashSuffix}`);
 case 'api-status':
 return finish(`${prefix}/${table.apiStatus}${hashSuffix}`);
 case 'gamification':
 return finish(`${prefix}/${table.gamification}${hashSuffix}`);
 case 'forum':
 return finish(`${prefix}/${table.forum}${hashSuffix}`);
 case 'contact':
 return finish(`${prefix}/${table.contact}${hashSuffix}`);
 case 'partners':
 return finish(`${prefix}/${table.partners}${hashSuffix}`);
 case 'consulting':
 return finish(`${prefix}/${table.consulting}${hashSuffix}`);
 case 'press-kit':
 return finish(`${prefix}/${table.pressKit}${hashSuffix}`);
 case 'job-board': {
 // When a sector hub is set, emit the clean canonical URL
 // (e.g. /cerca-lavoro-ticino/infermieri/). Precedes jobSlug so
 // Google indexes the clean sector hub URL as canonical.
 if (route.jobBoardSector && SECTOR_HUB_SLUG[lang as keyof typeof SECTOR_HUB_SLUG]) {
 const sectorSlug = SECTOR_HUB_SLUG[lang as keyof typeof SECTOR_HUB_SLUG][route.jobBoardSector];
 return finish(`${prefix}/${table.jobBoard}/${sectorSlug}${hashSuffix}`);
 }
 // When a geo-hub city is set, emit the clean canonical URL
 // (e.g. /cerca-lavoro-ticino/lugano/) — this takes precedence
 // over jobSlug so Google indexes the clean URL as canonical.
 if (route.jobBoardCity && CITY_HUB_SLUG[lang as keyof typeof CITY_HUB_SLUG]) {
 const citySlug = CITY_HUB_SLUG[lang as keyof typeof CITY_HUB_SLUG][route.jobBoardCity];
 return finish(`${prefix}/${table.jobBoard}/${citySlug}${hashSuffix}`);
 }
 return finish(route.jobSlug
 ? `${prefix}/${table.jobBoard}/${localizeEditorialJobSlug(route.jobSlug) || route.jobSlug}${hashSuffix}`
 : `${prefix}/${table.jobBoard}${hashSuffix}`);
 }
 case 'profile':
 return finish(`${prefix}/${table.profile}${hashSuffix}`);
 case 'morning':
 return finish(`${prefix}/${table.morning}${hashSuffix}`);
 case 'blog': {
 const article = route.blogArticle;
 if (article) {
 const slug = _blogSlugs?.[article]?.[lang] ?? article;
 return finish(`${prefix}/${table.blog}/${slug}${hashSuffix}`);
 }
 return finish(`${prefix}/${table.blog}${hashSuffix}`);
 }
 case 'admin':
 return finish(`${prefix}/${table.admin}${hashSuffix}`);
 case 'glossario':
 if (route.glossaryTerm) {
 const termSlug = GLOSSARY_TERM_SLUGS[lang][route.glossaryTerm];
 return finish(`${prefix}/${table.glossario}/${termSlug}${hashSuffix}`);
 }
 return finish(`${prefix}/${table.glossario}${hashSuffix}`);
 case 'faq':
 return finish(`${prefix}/${table.faq}${hashSuffix}`);
 case 'dialetto':
 return finish(`${prefix}/${table.dialetto}${hashSuffix}`);
 case 'sitemap':
 return finish(`${prefix}/${table.sitemap}${hashSuffix}`);
 case 'contracts':
 return finish(`${prefix}/${table.contracts}${hashSuffix}`);
 case 'tfr-calculator':
 return finish(`${prefix}/${table.tfrCalculator}${hashSuffix}`);
 case 'permit-quiz':
 return finish(`${prefix}/${table.permitQuiz}${hashSuffix}`);
 case 'tredicesima':
 return finish(`${prefix}/${table.tredicesima}${hashSuffix}`);
 case 'weekly-digest':
 return finish(`${prefix}/${table.weeklyDigest}${hashSuffix}`);
 case 'tool-of-week':
 return finish(`${prefix}/${table.toolOfWeek}${hashSuffix}`);
 case 'email-confirmed':
 return finish(`${prefix}/${table.emailConfirmed}${hashSuffix}`);
 case 'newsletter-preferences':
 return finish(`${prefix}/${table.newsletterPreferences}${hashSuffix}`);
 default:
 return finish((prefix || '/') + hashSuffix);
 }
}

export function buildAllLocalePaths(route: AppRoute): Record<Locale, string> {
 return {
 it: buildPath(route, 'it'),
 en: buildPath(route, 'en'),
 de: buildPath(route, 'de'),
 fr: buildPath(route, 'fr'),
 };
}

export function getSeoSection(route: AppRoute): string {
 switch (route.activeTab) {
 case 'calculator': {
 if (route.seoLanding) return `landing-${route.seoLanding}`;
 const sub = route.calcolatoreSubTab || 'calculator';
 const map: Record<string, string> = {
 calculator: 'calculator', whatif: 'whatif', payslip: 'payslip',
 ral: 'ral', bonus: 'bonus', 'parental-leave': 'parental-leave',
 residency: 'residency', 'salary-quiz': 'salaryQuiz',
 };
 return map[sub] || 'calculator';
 }
 case 'confronti':
 return route.confrontiSubTab || 'exchange';
 case 'fisco': {
 const sub = route.fiscoSubTab || 'tax-return';
 if (sub === 'tax-return' && route.taxReturnCountry) {
 return `tax-return-${route.taxReturnCountry}`;
 }
 const map: Record<string, string> = {
 'tax-return': 'tax-return', calendar: 'calendar', holidays: 'holidays',
 ristorni: 'ristorni', pension: 'pension', pillar3: 'pillar3', quiz: 'quiz', 'tax-credit': 'taxCredit', 'withholding-rates': 'withholdingRates', 'new-frontier-tax-sim': 'newFrontierTaxSim',
 };
 return map[sub] || 'fisco';
 }
 case 'guida': {
 const sub = route.guidaSubTab;
 if (!sub) return 'guide';
 if (sub === 'border' && route.borderCrossing) {
 return `valico-${route.borderCrossing}`;
 }
 const map: Record<string, string> = {
 'first-day': 'firstDay', permits: 'permits', border: 'border',
 unemployment: 'unemployment', 'car-transfer': 'carTransfer',
 'car-cost': 'car-cost', 'permit-compare': 'permit-compare', 'border-map': 'border-map',
 };
 return map[sub] || 'guide';
 }
 case 'vita': {
 const sub = route.vitaSubTab || 'living-ch';
 const map: Record<string, string> = {
 'living-ch': 'livingCH', 'living-it': 'livingIT', companies: 'companies',
 schools: 'schools', nursery: 'nursery', places: 'places', transport: 'transport',
 municipalities: 'municipalities',
 };
 return map[sub] || 'livingCH';
 }
 case 'stats': {
 const ss = route.statsSubTab || 'overview';
 const map: Record<string, string> = { livability: 'livability', 'jobs-observatory': 'jobsObservatory', traffic: 'traffic', 'salary-compare': 'salaryCompare', 'traffic-history': 'trafficHistory', unemployment: 'unemploymentStats', mortgage: 'mortgageComparison', 'fuel-prices': 'fuelPrices', 'health-premiums': 'healthPremiums' };
 return map[ss] || 'stats';
 }
 case 'job-board':
 return route.jobSlug ? `jobboard-${route.jobSlug}` : 'jobboard';
 case 'feedback':
 return 'feedback';
 case 'profile':
 return 'dashboard';
 case 'blog':
 return route.blogArticle ? `blog-${route.blogArticle}` : 'blog';
 case 'glossario':
 return route.glossaryTerm ? `glossario-${route.glossaryTerm}` : 'glossario';
 case 'faq':
 return 'faq';
 case 'dialetto':
 return 'dialetto';
 case 'sitemap':
 return 'sitemap';
 case 'contracts':
 return 'contracts';
 case 'tfr-calculator':
 return 'tfr-calculator';
 case 'permit-quiz':
 return 'permit-quiz';
 case 'tredicesima':
 return 'tredicesima';
 case 'weekly-digest':
 return 'weekly-digest';
 case 'tool-of-week':
 return 'tool-of-week';
 case 'email-confirmed':
 return 'email-confirmed';
 case 'newsletter-preferences':
 return 'newsletter-preferences';
 case 'tassazione-hub':
 return 'tassazione-hub';
 case 'autore':
 return route.author ? `autore-${route.author}` : 'autore';
 default:
 return route.activeTab;
 }
}

/** Check if path is a locale root (/, /en/, /de/, /fr/) — these are canonical homepage URLs */
function isLocaleRoot(path: string): boolean {
 return path === '/' || /^\/(?:en|de|fr)\/?$/.test(path);
}

/** Check if route is the default homepage (calculator main tab) */
function isDefaultHome(route: AppRoute): boolean {
 return route.activeTab === 'calculator' && (!route.calcolatoreSubTab || route.calcolatoreSubTab === 'calculator');
}

/**
 * Query params that must survive cross-route navigation (newsletter autologin,
 * campaign tracking, OAuth callbacks, analytics). Anything not on this list
 * (e.g. JobBoard's `q` / `page`) gets dropped when the user navigates away
 * from the page that produced it, so it doesn't leak into unrelated routes.
 */
const PRESERVED_QUERY_PARAMS = new Set<string>([
 'ne', 'newsletter_email', 'email', 'ac', 'at', 'authToken', 'action', 'target',
 'campaign_id', 'message_id', 'variant', 'section_id', 'link_label', 'subscriber_locale',
 'code', 'state', 'error',
 'debug', 'status',
]);

function preservedSearch(currentSearch: string): string {
 if (!currentSearch) return '';
 try {
 const params = new URLSearchParams(currentSearch);
 const kept = new URLSearchParams();
 params.forEach((value, key) => {
 if (PRESERVED_QUERY_PARAMS.has(key) || key.startsWith('utm_')) {
 kept.append(key, value);
 }
 });
 const qs = kept.toString();
 return qs ? `?${qs}` : '';
 } catch {
 return '';
 }
}

export function pushRoute(route: AppRoute): void {
 // Static SEO overlay routes (per-station fuel, per-canton health, per-city
 // employers, per-cluster orphan landings, etc.) are matched against URLs
 // that already canonicalise the page. Rewriting the URL to the generic
 // tab path on hydration was the root cause of the bait-and-switch UX bug
 // — see AppRoute.staticOverlay for the full design.
 if (route.staticOverlay) return;
 const newUrl = buildPath(route);
 const [newPath, newHash] = newUrl.split('#');
 const currentPath = window.location.pathname;
 const currentHash = window.location.hash.slice(1); // strip leading #
 // Same path → keep the full query string (intra-page filters like
 // JobBoard's ?q=/?page= must survive). Cross-path → only carry forward
 // allowlisted params (autologin, campaign tracking, OAuth, utm_*).
 const samePath = currentPath.replace(/\/$/, '') === newPath.replace(/\/$/, '');
 const search = samePath ? window.location.search : preservedSearch(window.location.search);
 // Root paths (/, /en/, /de/, /fr/) are canonical for the homepage — don't redirect to calculator slug
 if (isLocaleRoot(currentPath) && isDefaultHome(route) && !newHash) return;
 if (currentPath !== newPath || (newHash ?? '') !== currentHash) {
 const hashPart = newHash ? `#${newHash}` : '';
 history.pushState({ route }, '', newPath + search + hashPart);
 }
}

export function replaceRoute(route: AppRoute): void {
 if (route.staticOverlay) return;
 const newUrl = buildPath(route);
 const [newPath, newHash] = newUrl.split('#');
 const currentPath = window.location.pathname;
 const currentHash = window.location.hash.slice(1);
 const samePath = currentPath.replace(/\/$/, '') === newPath.replace(/\/$/, '');
 const search = samePath ? window.location.search : preservedSearch(window.location.search);
 if (isLocaleRoot(currentPath) && isDefaultHome(route) && !newHash) return;
 if (currentPath !== newPath || (newHash ?? '') !== currentHash) {
 const hashPart = newHash ? `#${newHash}` : '';
 history.replaceState({ route }, '', newPath + search + hashPart);
 }
}

export function updatePathForLocale(newLocale: Locale): void {
 const currentPath = window.location.pathname;
 const search = window.location.search;
 const { route } = parsePath(currentPath);
 // Static SEO overlay routes (per-station, per-canton, etc.) are matched
 // against URLs that ALREADY canonicalise the page in the visited locale.
 // Rewriting them on locale boot would resurrect the bait-and-switch bug
 // — the URL would flip to e.g. `/statistiche/prezzi-benzina-confine/` even
 // though the static SEO content is the per-station detail. Preserve the
 // canonical URL; the per-locale alternates are emitted as <link rel="alternate">.
 if (route.staticOverlay) return;
 let nextRoute = route;
 // When switching locale from a root path on the homepage, navigate to the new locale's root
 if (isLocaleRoot(currentPath) && isDefaultHome(route)) {
 const newRoot = newLocale === 'it' ? '/' : `/${newLocale}/`;
 if (currentPath !== newRoot) {
 history.replaceState({ route }, '', newRoot + search);
 }
 return;
 }
 if (route.activeTab === 'job-board' && route.jobSlug) {
 const translatedSlug = translateJobSlug(route.jobSlug, newLocale);
 if (translatedSlug && translatedSlug !== route.jobSlug) {
 nextRoute = { ...route, jobSlug: translatedSlug };
 }
 }
 const newPath = buildPath(nextRoute, newLocale);
 const currentStateRoute = history.state?.route;
 const stateNeedsSync = JSON.stringify(currentStateRoute || null) !== JSON.stringify(nextRoute);
 if (currentPath !== newPath || stateNeedsSync) {
 history.replaceState({ route: nextRoute }, '', newPath + search);
 }
}

// ── Anchor fragment scrolling ──────────────────────────────

/**
 * Scroll to the element matching the current URL hash fragment.
 * Uses a MutationObserver to detect when lazy-loaded components
 * render the target element, with a hard timeout fallback.
 */
export function scrollToAnchor(hash?: string): boolean {
 const id = hash ?? window.location.hash.slice(1);
 if (!id) return false;

 const tryScroll = (): boolean => {
 const el = document.getElementById(id);
 if (el) {
 el.scrollIntoView({ behavior: 'smooth', block: 'start' });
 return true;
 }
 return false;
 };

 // Immediate attempt — works when component is already rendered
 if (tryScroll()) return true;

 // Watch for DOM mutations (lazy-loaded components rendering)
 if (typeof MutationObserver !== 'undefined') {
 let found = false;
 const observer = new MutationObserver(() => {
 if (!found && tryScroll()) {
 found = true;
 observer.disconnect();
 }
 });
 observer.observe(document.body, { childList: true, subtree: true });
 // Hard timeout: stop observing after 4s
 setTimeout(() => {
 if (!found) {
 observer.disconnect();
 tryScroll(); // One last attempt
 }
 }, 4000);
 } else {
 // Fallback for environments without MutationObserver (e.g. tests)
 const delays = [100, 300, 800, 2000];
 delays.forEach((ms) => setTimeout(() => tryScroll(), ms));
 }

 return false;
}

/**
 * Read the current URL hash as a typed value from a set of valid keys.
 * Returns the matching key or the provided default.
 */
export function getHashSection<T extends string>(validKeys: readonly T[], fallback: T): T {
 const hash = window.location.hash.slice(1);
 return (validKeys as readonly string[]).includes(hash) ? (hash as T) : fallback;
}

// ── WorkPermitsGuide section-anchor slugs ──────────────────

/** Internal section keys used by WorkPermitsGuide */
export type PermitSectionKey =
 | 'requirements' | 'documents' | 'rights' | 'limitations'
 | 'family' | 'tax' | 'status-change' | 'renewal' | 'tips';

const PERMIT_SECTION_SLUGS: Record<PermitSectionKey, Record<Locale, string>> = {
 'requirements': { it: 'requisiti', en: 'requirements', de: 'voraussetzungen', fr: 'conditions' },
 'documents': { it: 'documenti', en: 'documents', de: 'dokumente', fr: 'documents' },
 'rights': { it: 'diritti', en: 'rights', de: 'rechte', fr: 'droits' },
 'limitations': { it: 'limitazioni', en: 'limitations', de: 'einschraenkungen', fr: 'limitations' },
 'family': { it: 'famiglia', en: 'family', de: 'familie', fr: 'famille' },
 'tax': { it: 'fiscalita', en: 'tax', de: 'steuern', fr: 'fiscalite' },
 'status-change': { it: 'cambio-stato', en: 'status-change', de: 'statuswechsel', fr: 'changement-statut'},
 'renewal': { it: 'rinnovo', en: 'renewal', de: 'verlaengerung', fr: 'renouvellement' },
 'tips': { it: 'consigli', en: 'tips', de: 'tipps', fr: 'conseils' },
};

const ALL_SECTION_KEYS: readonly PermitSectionKey[] = Object.keys(PERMIT_SECTION_SLUGS) as PermitSectionKey[];

/** Reverse map: translated slug → internal section key (for current locale). */
export function parsePermitSectionHash(hash?: string): PermitSectionKey | null {
 const raw = hash ?? window.location.hash.slice(1);
 if (!raw) return null;
 const locale = getLocale();
 for (const key of ALL_SECTION_KEYS) {
 if (PERMIT_SECTION_SLUGS[key][locale] === raw) return key;
 }
 // Fallback: accept any locale's slug (shared links across locales)
 for (const key of ALL_SECTION_KEYS) {
 for (const loc of ['it', 'en', 'de', 'fr'] as Locale[]) {
 if (PERMIT_SECTION_SLUGS[key][loc] === raw) return key;
 }
 }
 return null;
}

/** Get the translated slug for a section key in the current locale. */
export function getPermitSectionSlug(key: PermitSectionKey): string {
 return PERMIT_SECTION_SLUGS[key]?.[getLocale()] ?? key;
}
