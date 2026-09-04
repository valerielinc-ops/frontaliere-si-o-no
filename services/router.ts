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
import { SLUG_TABLES, type SlugTable } from './routeSlugs.data';
import { cdnDataUrl } from './cdnDataBase';
import { buildJobSlugRecord, jobSlugShardKey, jobSlugShardPath } from './jobSlugShards';
import { resolveCantonGroup as resolveCantonGroupShared } from './cantonList';
import {
 CITY_HUB_KEYS,
 CITY_HUB_DISPLAY_NAME,
 CITY_HUB_SLUG,
 isKnownCityHub,
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
 careClusterSlug,
 getJobNursesHubSlug,
 getJobPartTimeLandingSlug,
 getJobTodayLandingSlug,
 resolveEditorialJobLandingDescriptor,
} from '../build-plugins/jobEditorialLanding';
import { JOB_RECENCY_LANDING_SLUGS as RECENCY_LANDING_SLUGS } from '../build-plugins/jobRecencyLanding';
import { FUEL_DAILY_ROUTES, isFuelDailyPath } from '../build-plugins/fuelDailyData';
import { HEALTH_PREMIUMS_ROUTES, isHealthPremiumsPath } from '../build-plugins/healthPremiumsData';
import { JOB_MARKET_SNAPSHOT_ROUTES, isJobMarketSnapshotPath } from '../build-plugins/jobMarketSnapshotData';
import { isSalaryStatsPath, parseSalaryStatsPath } from '../build-plugins/salaryStatsData';
import { isExchangeSsgPath, parseExchangeSsgPath } from './exchangeSsgPaths';
import { parseOrphanLandingPath as ORPHAN_LANDING_ROUTES } from '../build-plugins/orphanQueryData';
import { WEEKLY_EMPLOYERS_ROUTES, parseCompanyCityPath, parseWeeklyEmployersPath, parseWeeklyEmployersTopHubPath } from '../build-plugins/weeklyEmployersData';
import { BORDER_WAIT_ROUTES, isBorderWaitPath, parseBorderWaitPath } from '../build-plugins/borderWaitData';
import { NURSING_LANDING_ROUTES, isNursingLandingPath, parseNursingLandingPath } from '../build-plugins/nursingLandingsData';
import { CAREER_LANDING_ROUTES, isCareerLandingPath, parseCareerLandingPath } from '../build-plugins/careerLandingsData';
import { PROFESSION_LANDING_ROUTES, isProfessionLandingPath, parseProfessionLandingPath } from '../build-plugins/professionLandingsData';
import { FRONTALIERE_PILLAR_ROUTES, isFrontalierePillarPath, parseFrontalierePillarPath } from '../build-plugins/frontalierePillarData';
import { isProfessionCantonPath, parseProfessionCantonPath } from '../build-plugins/professionCantonData';
import { isSalaryProfessionCantonPath, parseSalaryProfessionCantonPath } from '../build-plugins/salaryProfessionCantonData';
import { isProfessionCityPath, parseProfessionCityPath } from '../build-plugins/professionCityData';
import { isHealthFacilityPath, parseHealthFacilityPath } from '../build-plugins/healthFacilitiesData';
import { isChCantonSnapshotPath, parseChCantonSnapshotPath } from '../build-plugins/jobMarketSnapshotChCantonPathsData';
import { parseChCantonEmployersPath } from '../build-plugins/weeklyEmployersChCantonPathsData';
import { isSectionPagePath, parseSectionPagePath } from '../build-plugins/sectionPagesPathsData';
import { isFiscalHubPath, parseFiscalHubPath, parseFiscalMunicipalityPath } from '../build-plugins/fiscalMunicipalityData';
import {
  isFrenchBorderMunicipalityHubPath,
  parseFrenchBorderMunicipalityHubPath,
  parseFrenchBorderMunicipalityPath,
} from '../build-plugins/frenchBorderMunicipalityData';
import {
  isGermanBorderMunicipalityHubPath,
  parseGermanBorderMunicipalityHubPath,
  parseGermanBorderMunicipalityPath,
} from '../build-plugins/germanBorderMunicipalityData';
import {
  isLiechtensteinBorderMunicipalityHubPath,
  parseLiechtensteinBorderMunicipalityHubPath,
  parseLiechtensteinBorderMunicipalityPath,
} from '../build-plugins/liechtensteinBorderMunicipalityData';
import {
  isAustrianBorderMunicipalityHubPath,
  parseAustrianBorderMunicipalityHubPath,
  parseAustrianBorderMunicipalityPath,
} from '../build-plugins/austrianBorderMunicipalityData';
import {
  COST_OF_LIVING_LANDING_ROUTES,
  isCostOfLivingLandingPath,
  parseCostOfLivingLandingPath,
} from '../build-plugins/costOfLivingLandingsData';
import {
  HOLIDAY_LANDING_ROUTES,
  isHolidaysLandingPath,
  parseHolidaysLandingPath,
} from '../build-plugins/holidaysLandingsData';
import {
  isTopicClusterHubPath,
  isTopicIndexPath,
  resolveTopicClusterHubSection,
  resolveTopicIndexSection,
} from '../build-plugins/topicClusterHubsData';
import {
  SALARY_LANDING_ROUTES,
  isSalaryLandingPath,
  parseSalaryLandingPath,
} from '../build-plugins/bfsSalaryLandingsData';
import {
  MINWAGE_LANDING_ROUTES,
  isMinWageLandingPath,
  parseMinWageLandingPath,
} from '../build-plugins/minimumWageLandingsData';
import {
  COMPARISONS_HUB_ROUTES,
  isComparisonsHubPath,
  parseComparisonsHubPath,
} from '../build-plugins/comparisonsHubData';
import {
  FAQ_HUB_ROUTES,
  isFaqHubPath,
  parseFaqHubPath,
  parseFaqEntryPath,
} from '../data/faq-hub/routes';
import { isSeoHubPath, localeFromHubPath } from '../build-plugins/seoHubsData';
import {
  CANTON_URL_SLUGS,
  JOB_BOARD_CANTON_AGGREGATE,
  getJobBoardSlugForCanton,
  getAggregatorJobBoardSlug,
  parseJobBoardSlug,
} from './jobBoardSlugs';
// Re-exported so every existing importer of the router keeps working —
// the definitions moved to the leaf module, the public surface did not.
export {
  JOB_BOARD_CANTON_AGGREGATE,
  getJobBoardSlugForCanton,
  getAggregatorJobBoardSlug,
  parseJobBoardSlug,
};

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
  '/guida-frontaliere/fiscalita/',
  // EN — /en/cross-border-guide/{slug}/
  '/en/cross-border-guide/complete-guide-crossborder-salary-calculation-2026/',
  '/en/cross-border-guide/new-vs-old-crossborder-worker-tax-differences/',
  '/en/cross-border-guide/withholding-tax-ticino-tables-a-b-c-h/',
  '/en/cross-border-guide/how-children-affect-crossborder-worker-net-salary/',
  '/en/cross-border-guide/crossborder-within-or-over-20km-what-changes/',
  '/en/cross-border-guide/from-50000-to-150000-chf-how-net-changes-crossborder/',
  '/en/cross-border-guide/married-or-single-impact-on-crossborder-taxes/',
  '/en/cross-border-guide/hidden-cost-chf-eur-exchange-net-salary/',
  '/en/cross-border-guide/taxation/',
  // DE — /de/grenzgaenger-ratgeber/{slug}/
  '/de/grenzgaenger-ratgeber/kompletter-leitfaden-gehaltsberechnung-grenzgaenger-2026/',
  '/de/grenzgaenger-ratgeber/neuer-vs-alter-grenzgaenger-steuerliche-unterschiede/',
  '/de/grenzgaenger-ratgeber/quellensteuer-tessin-tabellen-a-b-c-h/',
  '/de/grenzgaenger-ratgeber/wie-kinder-nettogehalt-grenzgaenger-beeinflussen/',
  '/de/grenzgaenger-ratgeber/grenzgaenger-innerhalb-oder-ueber-20km-was-aendert-sich/',
  '/de/grenzgaenger-ratgeber/von-50000-bis-150000-chf-wie-sich-netto-aendert-grenzgaenger/',
  '/de/grenzgaenger-ratgeber/verheiratet-oder-ledig-auswirkung-steuern-grenzgaenger/',
  '/de/grenzgaenger-ratgeber/versteckte-kosten-chf-eur-wechselkurs-nettogehalt/',
  '/de/grenzgaenger-ratgeber/besteuerung/',
  // FR — /fr/guide-frontalier/{slug}/
  '/fr/guide-frontalier/guide-complet-calcul-salaire-frontalier-2026/',
  '/fr/guide-frontalier/nouveau-vs-ancien-frontalier-differences-fiscales/',
  '/fr/guide-frontalier/impot-source-tessin-baremes-a-b-c-h/',
  '/fr/guide-frontalier/impact-enfants-salaire-net-frontalier/',
  '/fr/guide-frontalier/frontalier-moins-ou-plus-20km-ce-qui-change/',
  '/fr/guide-frontalier/de-50000-a-150000-chf-comment-le-net-change-frontalier/',
  '/fr/guide-frontalier/marie-ou-celibataire-impact-impots-frontalier/',
  '/fr/guide-frontalier/cout-cache-change-chf-eur-salaire-net/',
  '/fr/guide-frontalier/fiscalite/',
]);

// ── Route types ──────────────────────────────────────────────

export type ActiveTab = 'calculator' | 'confronti' | 'fisco' | 'guida' | 'vita' | 'stats' | 'feedback' | 'privacy' | 'terms' | 'data-deletion' | 'api-status' | 'gamification' | 'forum' | 'contact' | 'partners' | 'consulting' | 'press-kit' | 'job-board' | 'profile' | 'morning' | 'blog' | 'admin' | 'glossario' | 'faq' | 'sitemap' | 'dialetto' | 'contracts' | 'tfr-calculator' | 'permit-quiz' | 'frontaliere-wizard' | 'tredicesima' | 'weekly-digest' | 'tool-of-week' | 'email-confirmed' | 'newsletter-preferences' | 'sindacati' | 'chi-siamo' | 'correzioni' | 'metodologia' | 'tassazione-hub' | 'autore' | 'publish' | 'publisher-dashboard' | 'for-employers' | 'employer-insights' | 'journalist-dashboard' | 'subscribe' | 'followed-companies';

export type CalcolatoreSubTab = 'calculator' | 'whatif' | 'payslip' | 'ral' | 'bonus' | 'parental-leave' | 'residency' | 'salary-quiz';
export type ConfrontiSubTab = 'exchange' | 'banks' | 'health' | 'mobile' | 'shopping' | 'cost-of-living' | 'jobs' | 'renovation';
export type FiscoSubTab = 'tax-return' | 'calendar' | 'holidays' | 'ristorni' | 'pension' | 'pillar3' | 'quiz' | 'tax-credit' | 'withholding-rates' | 'new-frontier-tax-sim';
export type GuidaSubTab = 'first-day' | 'permits' | 'border' | 'unemployment' | 'car-transfer' | 'car-cost' | 'permit-compare' | 'border-map';
export type VitaSubTab = 'living-ch' | 'living-it' | 'companies' | 'schools' | 'nursery' | 'places' | 'transport' | 'municipalities';
export type StatsSubTab = 'overview' | 'livability' | 'jobs-observatory' | 'salary-compare' | 'traffic-history' | 'unemployment' | 'mortgage' | 'fuel-prices' | 'health-premiums';

// ── Border crossing deep links (indexable URLs) ─────────────

/**
 * Slug IDs for `/guida/border/{id}` deep links (SPA route matching) and
 * `/traffico-dogane/{id}/oggi/` static pages. Hand-kept mirror of
 * `data/borderCrossings.ts` — must match `build-plugins/borderWaitData.ts`'s
 * `BorderCrossingSlug`/`BORDER_WAIT_CROSSINGS` 1:1 (duplicated there rather
 * than imported, to avoid a cycle: that file imports from this one).
 *
 * New crossing → add its slug (must equal `slugifyCrossingName(name)` from
 * `services/borderCrossingSlug.ts`, the single implementation every caller
 * imports) to this array AND to
 * `build-plugins/borderWaitData.ts` (see the "Adding a new crossing"
 * checklist above `BorderCrossingRegion` there for the full list of maps
 * that need an entry too). Missing it here just means the SPA deep-link
 * route (`/guida/border/{id}`) 404s for that crossing — the static
 * `/traffico-dogane/...` pages are driven entirely by borderWaitData.ts, not
 * this array — but keep both in sync regardless, per the file comments on
 * both sides.
 *
 * As of #4545 this array mirrors the complete `data/borderCrossings.ts`
 * set (143). Sempione and the rest of the Grigioni/Vallese alpine corridor,
 * previously called out here as a known gap, are now wired.
 */
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
 'camedo',
 'piaggio-valmara',
 // Germania — BS (7)
 'basel-weil-am-rhein-hiltalingerstrasse',
 'basel-weil-am-rhein-autostrada-a2-a5',
 'basel-weil-am-rhein-freiburgerstrasse',
 'riehen-weil-am-rhein',
 'riehen-lorrach-stetten',
 'inzlingen-riehen',
 'grenzach-wyhlen-riehen',
 // Germania — AG (7)
 'rheinfelden-rheinfelden-ag-autostrada-a861-a3',
 'rheinfelden-rheinfelden-ag-alte-rheinbrucke',
 'bad-sackingen-stein-ag',
 'laufenburg-laufenburg-ag',
 'waldshut-tiengen-koblenz-ag',
 'kussaberg-bad-zurzach-ag',
 'hohentengen-am-hochrhein-kaiserstuhl-ag',
 // Germania — ZH (10)
 'hohentengen-am-hochrhein-wasterkingen',
 'klettgau-wil-zh',
 'dettighofen-wil-zh',
 'dettighofen-rafz',
 'lottstetten-rafz-landstrasse',
 'lottstetten-rafz-schaffhausener-strasse',
 'lottstetten-nack',
 'jestetten-rheinau',
 'jestetten-laufen-uhwiesen-dorfstrasse',
 'jestetten-laufen-uhwiesen-grenzstrasse',
 // Germania — SH (39)
 'jestetten-neuhausen-am-rheinfall-zollstrasse',
 'jestetten-wilchingen',
 'klettgau-trasadingen',
 'stuhlingen-schleitheim',
 'blumberg-beggingen',
 'blumberg-bargen-sh-autostrasse-h4',
 'tengen-thayngen-l188',
 'gottmadingen-thayngen-ebringerstrasse',
 'gottmadingen-thayngen-autostrada-a81-a4',
 'dorflingen-gottmadingen-randegg',
 'ramsen-moskau-rielasingen-worblingen',
 'ohningen-stein-am-rhein',
 'gailingen-am-hochrhein-dorflingen',
 'lottstetten-rudlingen',
 'jestetten-neuhausen-am-rheinfall-buchweg',
 'klettgau-wilchingen',
 'eggingen-hallau',
 'stuhlingen-hallau',
 'blumberg-bargen-sh-alte-bargener-strasse',
 'bargen-sh-tengen',
 'merishausen-tengen',
 'opfertshofen-tengen',
 'tengen-thayngen-wiechserstrasse',
 'hilzingen-thayngen-schlattergasse',
 'hilzingen-thayngen-barzheimer-strasse',
 'dorflingen-gailingen-am-hochrhein-hinterdorf',
 'busingen-am-hochrhein-dorflingen-l202',
 'busingen-am-hochrhein-dorflingen-busingerstrasse',
 'busingen-am-hochrhein-dorflingen-siedlerstrasse',
 'busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse',
 'busingen-am-hochrhein-schaffhausen-stemmer',
 'busingen-am-hochrhein-schaffhausen-felsgasse',
 'busingen-am-hochrhein-schaffhausen-vogelingasschen',
 'busingen-am-hochrhein-schaffhausen-rheinhaldenstrasse',
 'gailingen-am-hochrhein-ramsen-sh',
 'gottmadingen-buch-sh',
 'gottmadingen-buch-blindenhausen-sh',
 'gottmadingen-ramsen-hofenacker',
 'rielasingen-worblingen-ramsen-hofenacker',
 // Germania — TG (4)
 'diessenhofen-gailingen-am-hochrhein',
 'konstanz-tagerwilen-gottlieber-strasse',
 'konstanz-tagerwilen-autostrada-b33n-a7',
 'konstanz-kreuzlingen',
 // Austria — SG (8)
 'rheineck-gai-au',
 'st-margrethen-hochst',
 'au-lustenau',
 'widnau-lustenau',
 'diepoldsau-hohenems',
 'kriessern-mader',
 'montlingen-koblach',
 'ruthi-meiningen',
 // Austria — GR (2)
 'martina-nauders',
 'samnaun-spiss',
 // Liechtenstein — SG (5)
 'trubbach-balzers',
 'sevelen-vaduz',
 'buchs-schaan',
 'haag-bendern',
 'salez-ruggell',
 // Liechtenstein — GR (1)
 'st-luzisteig',
 // Francia — GE (10)
 'bardonnex',
 'ferney-voltaire-grand-saconnex',
 'meyrin-cern',
 'thonex-vallard',
 'moillesulaz',
 'perly',
 'anieres',
 'sauverny',
 'hermance',
 'landecy',
 // Francia — VD (6)
 'vallorbe-jougne',
 'la-cure-les-rousses',
 'l-auberson-les-fourgs',
 'le-brassus-bois-d-amont',
 'crassier-divonne',
 'chavannes-de-bogis-divonne',
 // Francia — NE (3)
 'les-verrieres',
 'col-des-roches',
 'biaufond',
 // Francia — JU (3)
 'boncourt-delle',
 'fahy-abbevillers',
 'goumois',
 // Francia — VS (3)
 'le-chatelard-vallorcine',
 'saint-gingolph',
 'morgins-chatel',
 // Italia — GR (6)
 'passo-dello-spluga',
 'castasegna-villa-di-chiavenna',
 'campocologno-tirano',
 'tunnel-munt-la-schera',
 'forcola-di-livigno',
 'giogo-di-santa-maria',
 // Italia — VS (2)
 'sempione',
 'traforo-del-gran-san-bernardo',
 // Austria — SG (de-collided second Widnau-Lustenau, #4890)
 'widnau-lustenau-schmitterbrucke',
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
 | 'net-comparison-g-vs-b-over20km'
 | 'seasonal-vs-annual-naspi';

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
 'seasonal-vs-annual-naspi',
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
 'seasonal-vs-annual-naspi': 'lavoro-stagionale-vs-annuale-naspi-frontalieri',
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
 'seasonal-vs-annual-naspi': 'seasonal-vs-annual-work-naspi-cross-border-workers',
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
 'seasonal-vs-annual-naspi': 'saisonarbeit-vs-ganzjahresarbeit-naspi-grenzgaenger',
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
 'seasonal-vs-annual-naspi': 'travail-saisonnier-vs-annuel-naspi-frontaliers',
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

/**
 * Valid blog article IDs for individual article routing.
 *
 * Re-exported from the corpus package, where the literal union now lives:
 * create-article appends to it on every publish, so it is corpus data, and
 * keeping it here meant the generator wrote into the site on every run
 * (#4974 item 3). Importers of this module are unaffected.
 */
import type { BlogArticleId } from './blogArticleIds';
export type { BlogArticleId };

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
 /**
  * Which article section the `blog` tab is showing: the cross-border
  * (`frontaliere`, default/absent) hub or the Switzerland-wide (`svizzera`)
  * mirror. Drives the sub-tab toggle, the index slug and the registry the
  * shared component reads. See `services/articleSections.ts`.
  */
 blogSection?: 'frontaliere' | 'svizzera';
 /** Selected svizzera-section article id (loosely typed; validated via REVERSE_SWISS). */
 swissArticle?: string;
 /** Unresolved svizzera article slug when swiss data hasn't loaded yet. */
 swissSlug?: string;
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
  * Company key path segment for the private per-company insights page
  * (`/azienda/<companyKey>/?t=<token>`). Carried in the route so locale-boot
  * canonicalization (updatePathForLocale, pushRoute) reconstructs the segment
  * instead of collapsing the URL to the empty-key `/azienda/` — which made the
  * page read an empty key and render "Link non valido o scaduto".
  */
 companyKey?: string;
 /**
  * Canonical geo-hub key when the URL matches a city-hub path
  * (e.g. /cerca-lavoro-ticino/lugano/ → `jobBoardCity: 'lugano'`).
  * When set, {@link jobSlug} is also populated with the corresponding
  * localized editorial-landing slug (e.g. `ricerca-lugano`) so client-side
  * rendering shows the full location landing UI. `jobBoardCity` takes
  * precedence in {@link buildPath} so the emitted URL uses the clean slug.
  *
  * Widened from a TI-only literal union to `string` (P1.3, 2026-05-10) to
  * accommodate cities outside Ticino under the new per-canton slugs
  * (e.g. `/cerca-lavoro-zurigo/zurich/`). Existing TI city values
  * (`'lugano' | 'mendrisio' | 'bellinzona' | 'locarno' | 'chiasso'`) keep
  * their semantics — downstream code that did `CITY_HUB_SLUG[locale][city]`
  * continues to work because `cityHit` is still typed via `CITY_HUB_KEYS`
  * lookup before assignment. For non-TI cantons, the city string is
  * passed through opaquely (no CITY_HUB_SLUG lookup; static-overlay HTML
  * provides the rendering).
  */
 jobBoardCity?: string;
 /**
  * Canton ISO code (`'ZH'`, `'GE'`, …) when the URL is the per-canton
  * job-board variant introduced in P1.3, e.g. `/cerca-lavoro-zurigo/…`
  * → `jobBoardCanton: 'ZH'`. The reserved sentinel `'_AGGREGATE_'`
  * marks the Switzerland-wide aggregator (`/cerca-lavoro-svizzera/`,
  * `/find-jobs-switzerland/`, `/jobs-in-schweiz/`,
  * `/trouver-emploi-suisse/`). Absent (`undefined`) means the legacy
  * Ticino-only slug `table.jobBoard` matched, preserving every pre-P1.3
  * URL (`/cerca-lavoro-ticino/…` etc.) unchanged.
  */
 jobBoardCanton?: string;
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
  * When true, this URL is a build-time static SEO page with NO equivalent
  * SPA view (fuel-daily/{station}, weekly-employers/{city}, job-market
  * snapshots, health-premiums/{canton}, border-wait/{crossing}, orphan-query
  * landings, salary-hub long-tail, known `seoLanding` aliases, plus all the
  * per-leaf extensions). The page body is statically rendered as a sibling
  * of `#root` via `buildSeoPageHtml` (`seoContentOutsideRoot: true`).
  *
  * Effects:
  *   - `pushRoute()` becomes a no-op so the SPA doesn't rewrite the URL to
  *     the generic comparator/tab path on initial render.
  *   - App.tsx skips the React `<main id="main-content">`; the static
  *     `<main class="seo-static-content">` owns the page body. Top nav +
  *     sub-tab nav + footer still hydrate so the chrome stays interactive.
  *
  * IMPORTANT: leave `staticOverlay` FALSY when the URL also resolves to a
  * real SPA sub-tab (e.g. /calcola-stipendio/confronta-retribuzione-ral
  * → `calcolatoreSubTab: 'ral'`). The router's `REVERSE_*` slug maps already
  * win over the SEO landing branch in that case; App.tsx then renders the
  * SPA sub-tab AND hides the static fallback so end users get the
  * interactive view while crawlers (no JS) keep receiving the rich static
  * HTML. See CLAUDE.md rule #14.
  */
 staticOverlay?: boolean;
}

// ── Internationalized slug maps ──────────────────────────────
// SlugTable interface + SLUG_TABLES data live in ./routeSlugs.data (#4315 —
// centralized so Node scripts/build plugins outside this TSX graph can share
// the same table instead of hand-copying it).

// ── Per-canton job-board slugs (P1.3 Cathedral CH-wide expansion) ─────
//
// Background. Pre-P1.3 the project had ONE Ticino-only job-board route
// per locale (`SLUG_TABLES[locale].jobBoard` → `cerca-lavoro-ticino`,
// `find-jobs-ticino`, `jobs-im-tessin`, `trouver-emploi-tessin`). The
// Cathedral expansion adds 25 additional canton variants + a
// Switzerland-wide aggregator while keeping every legacy URL alive.
//
// Routing dispatch tree:
//
//                                 /<first-segment>/...
//                                          │
//        ┌─────────────────────────────────┼──────────────────────────────┐
//        ▼                                 ▼                              ▼
//   first === table.jobBoard       parseJobBoardSlug(first)          (other slugs)
//   (LEGACY Ticino path,           returns { cantonCode, isAggregator }
//    untouched — every            │
//    /cerca-lavoro-ticino/…       ▼
//    URL keeps working)        cantonCode set      isAggregator
//                                  │                   │
//                                  ▼                   ▼
//                       jobBoardCanton: 'ZH',   jobBoardCanton: '_AGGREGATE_'
//                       jobBoardCity?: <slug>   (Switzerland-wide)
//                       jobSlug?: <slug>
//
// City-vs-job disambiguation inside the per-canton branch matches the
// legacy heuristic: a known `CITY_HUB_KEYS` entry → `jobBoardCity`;
// anything else → `jobSlug`. For non-TI cantons there is no CITY_HUB
// counterpart yet, so the city test only triggers for Ticino cities
// reached via a non-TI prefix (which is itself an invalid combo and
// caught by the build-time generator). Everything else falls through
// to `jobSlug`.



// Member BFS canton code → URL group key (`'AI' → 'APPENZELLO'`, `'BS' →
// 'BASILEA'`) now lives in services/cantonList.ts as `resolveCantonGroup`.
// Half-canton merge (2026-05-10): AI+AR collapse into a single URL group
// `APPENZELLO`; BL+BS into `BASILEA`. Internal BFS/quorum logic still tags jobs
// with the real BFS code; call {@link resolveCantonGroup} at the URL-emission
// boundary to collapse onto the group key.

/**
 * Resolve a real BFS canton code to its URL canton group key. AI/AR collapse
 * to `APPENZELLO`; BL/BS collapse to `BASILEA`; every other code (and the
 * `_AGGREGATE_` sentinel) round-trips unchanged.
 *
 * Thin re-export of the shared implementation in `services/cantonList.ts`.
 * It used to invert `CANTON_URL_SLUGS.cantonGroups` into its own private
 * member→group map; `services/jobCantonShards.ts` then needed the same
 * inversion for shard addressing, and a second copy of a normalisation whose
 * absence had already caused half-canton 404s is precisely the drift AGENTS.md
 * §6 forbids. One implementation now, consumed from both.
 *
 * Kept as a named export because callers (build plugins, tests, the canton URL
 * builder below) import it from the router.
 */
export function resolveCantonGroup(cantonCode: string): string {
 return resolveCantonGroupShared(cantonCode);
}

/**
 * Per-locale set of canton URL slugs (e.g. `it: {'ticino','zurigo',...}`,
 * `de: {'tessin','zurich','aargau',...}`) used ONLY to validate the canton
 * segment of an events-page URL (see `matchEventsCantonLocale` below).
 * Sourced from the SAME `data/canton-url-slugs.json` table
 * `eventsBasePathForCanton` (scripts/lib/events-utils.mjs) uses to emit those
 * pages — one canton→slug dictionary, §6.
 */
const EVENTS_CANTON_SLUGS: Record<Locale, ReadonlySet<string>> = (() => {
 const out: Record<Locale, Set<string>> = { it: new Set(), en: new Set(), de: new Set(), fr: new Set() };
 for (const record of Object.values(CANTON_URL_SLUGS.cantons)) {
  (['it', 'en', 'de', 'fr'] as const).forEach((loc) => {
   const slug = record[loc];
   if (slug) out[loc].add(slug);
  });
 }
 return out;
})();

/** Events-page URL shape per locale — `{canton}` then 0-2 dynamic segments
 * (comune, or comune+event-slug, or a digest slug). Mirrors the localized
 * base-path builders in scripts/lib/events-utils.mjs (`EVENTS_LOCALIZED_SEGMENT`). */
const EVENTS_PATH_PATTERN: Record<Locale, RegExp> = {
 it: /^\/eventi\/([a-z0-9-]+)((?:\/[a-z0-9-]+){0,2})\/?$/,
 en: /^\/en\/events\/([a-z0-9-]+)((?:\/[a-z0-9-]+){0,2})\/?$/,
 de: /^\/de\/veranstaltungen\/([a-z0-9-]+)((?:\/[a-z0-9-]+){0,2})\/?$/,
 fr: /^\/fr\/evenements\/([a-z0-9-]+)((?:\/[a-z0-9-]+){0,2})\/?$/,
};

/**
 * Match a pathname against every locale's events URL shape and validate the
 * canton segment against {@link EVENTS_CANTON_SLUGS}. Returns the matched
 * locale, or `null` when the pathname isn't an events page OR the canton
 * segment isn't a known canton slug for that locale (e.g. a stray
 * `/eventi/not-a-canton/` falls through to normal 404 handling instead of
 * being claimed here). Generalizes the legacy TI-only
 * `/^\/eventi\/ticino(...)?$/`-style regexes (issue #3125 canton rollout).
 */
function matchEventsCantonLocale(pathname: string): Locale | null {
 for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  const m = EVENTS_PATH_PATTERN[locale].exec(pathname);
  if (m && EVENTS_CANTON_SLUGS[locale].has(m[1])) return locale;
 }
 return null;
}

/**
 * Swiss-wide events index hub (issue #3645, F3): the canton-less landing
 * page one level above every `/eventi/<canton>/` hub matched above. Kept as
 * a SEPARATE, stand-alone pattern rather than folding into
 * `EVENTS_PATH_PATTERN` so the existing (high-traffic) canton/comune matcher
 * is untouched. `EVENTS_PATH_PATTERN`'s canton-segment group requires at
 * least one char (`[a-z0-9-]+`), so a bare `/eventi/` never matches it —
 * these two patterns are mutually exclusive by construction, no ordering
 * dependency between them. Literal segments mirror
 * scripts/lib/events-utils.mjs's `EVENTS_LOCALIZED_SEGMENT`/
 * `EVENTS_INDEX_PATH` (same duplication trade-off `EVENTS_PATH_PATTERN`
 * above already accepts: a RegExp needs a literal, can't import the runtime
 * string) — tests/router.test.ts guards against drift.
 */
const EVENTS_INDEX_PATTERN: Record<Locale, RegExp> = {
 it: /^\/eventi\/?$/,
 en: /^\/en\/events\/?$/,
 de: /^\/de\/veranstaltungen\/?$/,
 fr: /^\/fr\/evenements\/?$/,
};

function matchEventsIndexLocale(pathname: string): Locale | null {
 for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  if (EVENTS_INDEX_PATTERN[locale].test(pathname)) return locale;
 }
 return null;
}

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
export type JobSlugMapRecord = Record<string, string> & {
 // Optional metadata used by SPA bridge resolution. `_id` is the job id, `_canton`
 // the canton code (uppercase). Both are looked up via `getJobMetaForSlug` so the
 // SPA can lazy-fetch the right canton shard when a bridge slug points to a job
 // that isn't in the initial referrer-aware load (e.g. /cerca-lavoro-ticino/<bridge>
 // for a job now in AI). Underscore-prefixed to avoid colliding with locale keys.
 _id?: string;
 _canton?: string;
};

let _jobSlugMap: Map<string, JobSlugMapRecord> | null = null;
let _jobSlugMapPromise: Promise<void> | null = null;
// True only after the FULL monolith (/data/jobs-slug-map.json) has loaded.
// Shard loads and registerJobSlugMap merges leave this false so corpus-wide
// consumers (UserProfile applied-jobs links, stats-page leader links) can
// still request the whole map via ensureJobSlugMapLoaded().
let _jobSlugMapFull = false;
// Shard keys ("00".."ff") whose /data/jobs-slug-map/<key>.json file has been
// fetched and merged — powers per-slug readiness (isJobSlugReady).
const _loadedJobSlugShards = new Set<string>();
const _jobSlugShardPromises = new Map<string, Promise<void>>();

/** Merge one lookup record into the in-memory map. Field-level merge: newer
 * values win, older extra fields survive (a full record loaded from a shard
 * can enrich one registered from slim listing jobs, and vice versa). */
function mergeJobSlugRecord(map: Map<string, JobSlugMapRecord>, key: string, record: JobSlugMapRecord): void {
 const existing = map.get(key);
 map.set(key, existing && existing !== record ? { ...existing, ...record } : record);
}

/**
 * Register job slug records so the router can translate job slugs across
 * locales and resolve bridge metadata. Record building lives in
 * services/jobSlugShards.ts (buildJobSlugRecord) — shared with the build-time
 * shard emitter (localeJobsSplitPlugin) so the two cannot drift; meta is
 * stored under reserved keys (record._id = job.id, record._canton) to avoid
 * colliding with locale keys.
 *
 * MERGES into the existing map (never replaces): the map is fed from multiple
 * partial sources — the full monolith, on-demand shards
 * (ensureJobSlugEntriesLoaded) and JobBoard's loaded jobs — so a later partial
 * registration must not wipe earlier entries. (The historic replace semantics
 * meant a slim `/data/jobs-${locale}-index.json` payload could wipe the full
 * map and break cross-canton bridge resolution — e.g.
 * /cerca-lavoro-ticino/<SZ-job-slug>/ rendered JobOrphanView even though the
 * job was alive in another canton. Merging keeps that fix by construction,
 * and slim jobs — which carry slug/previousSlugs but no slugByLocale — now
 * additionally CONTRIBUTE their id + canton meta instead of being skipped.)
 */
export function registerJobSlugMap(jobs: Array<{ id?: string; canton?: string; slug?: string; slugByLocale?: Partial<Record<string, string>>; previousSlugs?: string[]; previousSlugsByLocale?: Partial<Record<string, string[]>> }>): void {
 if (!Array.isArray(jobs) || jobs.length === 0) return;
 const map = _jobSlugMap ?? new Map<string, JobSlugMapRecord>();
 for (const job of jobs) {
 const built = buildJobSlugRecord(job);
 if (!built) continue;
 // Current slugs (every locale slug + default slug) always (over)write.
 for (const key of built.primaryKeys) {
 mergeJobSlugRecord(map, key, built.record);
 }
 // Legacy slug aliases only fill gaps so old URLs resolve to the current
 // job without ever shadowing another job's live slug.
 for (const alias of built.aliasKeys) {
 if (!map.has(alias)) map.set(alias, built.record);
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

/**
 * Look up metadata for a job slug (id + canton).
 * Used by JobBoard to lazy-fetch the right canton shard when a bridge slug
 * points to a job whose canton was not in the initial referrer-aware load.
 * Returns undefined if the slug map is not yet loaded or the slug is not found.
 */
export function getJobMetaForSlug(slug: string): { id?: string; canton?: string; canonicalSlug?: string } | undefined {
 if (!_jobSlugMap) return undefined;
 const record = _jobSlugMap.get(slug);
 if (!record) return undefined;
 return { id: record._id, canton: record._canton, canonicalSlug: record['_default'] };
}

/**
 * Load the FULL slug-map monolith (/data/jobs-slug-map.json, ~12 MB raw /
 * ~1.5 MB br). Only for corpus-wide consumers that need arbitrary slugs
 * resolvable synchronously afterwards (UserProfile applied-jobs links,
 * stats-page leader links). Per-slug consumers (bridge resolution, locale
 * switch on a job page) should use ensureJobSlugEntriesLoaded instead —
 * it fetches a ~16 KB br shard (issue #3526).
 */
export async function ensureJobSlugMapLoaded(): Promise<void> {
 if (_jobSlugMapFull) return;
 if (!_jobSlugMapPromise) {
 _jobSlugMapPromise = fetch(cdnDataUrl('/data/jobs-slug-map.json'))
 .then(r => r.ok ? r.json() : Promise.reject(r.status))
 .then((data: Array<{ id?: string; canton?: string; slug?: string; slugByLocale?: Partial<Record<string, string>>; previousSlugs?: string[]; previousSlugsByLocale?: Partial<Record<string, string[]>> }>) => {
 registerJobSlugMap(data);
 _jobSlugMapFull = true;
 })
 .finally(() => {
 _jobSlugMapPromise = null;
 });
 }
 await _jobSlugMapPromise;
}

/** Fetch + merge one shard file, deduping in-flight requests per shard. */
function loadJobSlugShard(shardKey: string): Promise<void> {
 const inFlight = _jobSlugShardPromises.get(shardKey);
 if (inFlight) return inFlight;
 const promise = fetch(cdnDataUrl(jobSlugShardPath(shardKey)))
 .then(r => r.ok ? r.json() : Promise.reject(r.status))
 .then((data: Record<string, JobSlugMapRecord>) => {
 const map = _jobSlugMap ?? new Map<string, JobSlugMapRecord>();
 for (const [key, record] of Object.entries(data)) {
 if (record && typeof record === 'object') mergeJobSlugRecord(map, key, record);
 }
 _jobSlugMap = map;
 _loadedJobSlugShards.add(shardKey);
 })
 .finally(() => {
 _jobSlugShardPromises.delete(shardKey);
 });
 _jobSlugShardPromises.set(shardKey, promise);
 return promise;
}

/**
 * Ensure the given slugs are resolvable via the slug map by fetching only the
 * shard files (/data/jobs-slug-map/<key>.json, ~16 KB br each) that cover
 * them — instead of the ~1.5 MB br monolith (issue #3526). Aliases
 * (previousSlugs / previousSlugsByLocale) are shard keys too, so every slug
 * that resolved through the monolith resolves through its shard.
 *
 * Zero-loss fallback: if any shard fetch fails (older deploy without shards,
 * CDN propagation lag), the full monolith is loaded exactly as before.
 */
export async function ensureJobSlugEntriesLoaded(slugs: ReadonlyArray<string>): Promise<void> {
 if (_jobSlugMapFull) return;
 const wanted = new Set<string>();
 for (const raw of slugs) {
 const slug = typeof raw === 'string' ? raw.trim() : '';
 if (slug) wanted.add(jobSlugShardKey(slug));
 }
 const missing = [...wanted].filter(k => !_loadedJobSlugShards.has(k));
 if (missing.length === 0) return;
 try {
 await Promise.all(missing.map(loadJobSlugShard));
 } catch {
 await ensureJobSlugMapLoaded();
 }
}

/** Returns true once the job slug map has been loaded into memory.
 * NB: true means "some records are available", not "the full corpus is" —
 * partial sources (shards, JobBoard registrations) also flip it. */
export function isJobSlugMapReady(): boolean {
 return _jobSlugMap !== null;
}

/**
 * Per-slug readiness: true when the map can AUTHORITATIVELY answer for this
 * slug — either the slug's shard (or the full monolith) has been loaded, so
 * a miss means the slug really is unknown (orphan), or the slug is already
 * present in the map from a partial registration. Used by the JobBoard
 * bridge-in-flight guard to show a skeleton instead of flashing
 * JobOrphanView while resolution is still possible.
 */
export function isJobSlugReady(slug: string): boolean {
 if (_jobSlugMapFull) return true;
 if (_jobSlugMap?.has(slug)) return true;
 return _loadedJobSlugShards.has(jobSlugShardKey(slug));
}

/**
 * Ensure the slug map covers the job slug of the given (default: current)
 * URL, if any. Cheap per-slug shard fetch used before locale switches
 * (LanguageSelector) so updatePathForLocale / getLocalizedJobSlug can
 * translate the current job slug without downloading the monolith.
 */
export async function ensureJobSlugMapForPath(pathname?: string): Promise<void> {
 try {
 const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
 if (!path) return;
 const { route } = parsePath(path);
 if (route.jobSlug) await ensureJobSlugEntriesLoaded([route.jobSlug]);
 } catch {
 // Non-critical: translation falls back to the untranslated slug, exactly
 // as when the map has not loaded yet.
 }
}

// Job slug map loading policy (issue #3526): NO route pays a blanket
// per-pageview slug-map download. Job-detail URLs eagerly fetch only the
// ~16 KB br shard covering the URL's slug; every other route loads nothing —
// per-slug consumers (bridge resolution, locale switch, applied-jobs links,
// stats leader links) ensure what they need on demand via
// ensureJobSlugEntriesLoaded / ensureJobSlugMapLoaded. The previous
// idle-time full-monolith load made the SPA transfer ~1.5 MB br (12+ MB
// JSON.parse) on effectively every page view, homepage included.
if (typeof window !== 'undefined') {
 // Job-detail URLs (e.g. /cerca-lavoro-ticino/<slug>/) need the slug's shard
 // eagerly to resolve cross-canton bridges before render. Without it, the
 // SPA flashes JobOrphanView ("Questo annuncio non è più disponibile") for
 // the few hundred ms between hydration and bridge fetch — see
 // JobBoard.tsx bridge-in-flight guard. Detect via path shape: any segment
 // matching a known job-board slug prefix followed by another non-empty
 // segment is a candidate detail page; return that candidate slug.
 const jobDetailSlugFromLocation = (): string | null => {
 try {
 const segments = window.location.pathname.split('/').filter(Boolean);
 if (segments.length < 2) return null;
 // Strip optional locale prefix
 const start = ['en', 'de', 'fr'].includes(segments[0]) ? 1 : 0;
 const candidate = segments[start];
 if (!candidate) return null;
 // Match "cerca-lavoro-*" (IT), "find-jobs-*" (EN), "jobs-in-*" (DE),
 // "trouver-emploi-*" (FR) — see SLUG_TABLES and getJobBoardSlug.
 if (!/^(cerca-lavoro|find-jobs|jobs-in|trouver-emploi)/.test(candidate)) return null;
 // Must have at least one more segment (the job slug or city/sector)
 if (segments.length <= start + 1) return null;
 // Static SEO families under the job-board hub are NOT job-detail pages:
 // related-search clusters (ricerca-/search-/suche-/recherche-, ~517k pages),
 // company hubs (azienda-/company-/unternehmen-/entreprise-), category
 // listings (categoria-/category-/kategorie-/categorie-) and pagination
 // (pagina-N/page-N/seite-N). None of them renders a single job detail, so
 // even the small shard fetch is skipped; worst case (a real job slug
 // starting with one of these prefixes) degrades softly: the JobBoard
 // bridge effect ensures the slug's shard on demand and the
 // bridge-in-flight guard covers the gap.
 const second = segments[start + 1];
 if (/^(ricerca|search|suche|recherche|azienda|company|unternehmen|entreprise|categoria|category|kategorie|categorie|pagina|page|seite)-/.test(second)) return null;
 try {
 return decodeURIComponent(second);
 } catch {
 return second;
 }
 } catch {
 return null;
 }
 };
 const eagerSlug = jobDetailSlugFromLocation();
 if (eagerSlug) {
 // Eager: kick the shard fetch right away. Cheap parallel work; the
 // network is mostly idle while the JS bundle parses.
 ensureJobSlugEntriesLoaded([eagerSlug]).catch(() => { /* non-critical — the JobBoard bridge effect retries on demand */ });
 }
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
 // packages/articles/content/routerBlogData.ts (issue #4881 Fase 6) can't
 // import the real BlogArticleId literal union (confinement) — it exports
 // REVERSE_BLOG as Record<ArticleLocale, Record<string, string>>. Only this
 // module (the site) knows which ids are valid, so narrow here.
 _reverseBlog = m.REVERSE_BLOG as Record<Locale, Record<string, BlogArticleId>>;
 });
 }
 return _blogDataPromise;
}

// ── Slug pairs learned at RUNTIME, for articles this build never shipped ──
//
// `_reverseBlog`/`_blogSlugs` above come from the bundle, so an article
// published after the last deploy is in neither and its URL resolves to
// nothing (issue #4974 item 3 — on 17 live pages the h1 flipped from the
// article title to "Guida Frontaliere" post-hydration, measured 2026-08-04).
// `services/runtimeArticleResolution.ts` learns those pairs from the JSON the
// corpus publishes and deposits them here.
//
// Kept in SEPARATE maps, deliberately: the bundled maps stay exactly what the
// build produced and are still consulted FIRST, and `preloadBlogData`'s
// `if (_blogSlugs) return` fast path can't be tripped by a runtime write. A
// runtime pair only ever answers a question the bundle already failed.
const _runtimeReverseBlog: Partial<Record<Locale, Record<string, string>>> = {};
const _runtimeBlogSlugs: Record<string, Partial<Record<Locale, string>>> = {};
const _runtimeReverseSwiss: Partial<Record<Locale, Record<string, string>>> = {};
const _runtimeSwissSlugs: Record<string, Partial<Record<Locale, string>>> = {};

function learnSlugs(
 reverse: Partial<Record<Locale, Record<string, string>>>,
 forward: Record<string, Partial<Record<Locale, string>>>,
 id: string,
 slugs: Partial<Record<Locale, string>>,
): void {
 if (!id) return;
 const known = forward[id] ?? (forward[id] = {});
 for (const [locale, slug] of Object.entries(slugs) as Array<[Locale, string | undefined]>) {
 if (!slug) continue;
 known[locale] = slug;
 (reverse[locale] ?? (reverse[locale] = {}))[slug] = id;
 }
}

/**
 * Register an article id ↔ slug pair discovered at runtime.
 *
 * Both directions matter. The reverse one is what lets the URL resolve at all;
 * the FORWARD one is what stops `buildPath` from rewriting the URL once it
 * does. `pushRoute` fires on the very state update that adopts the article and
 * `buildPath` falls back to the raw id when it has no slug — on the 176
 * frontaliere articles whose Italian slug differs from their id, that would
 * swap a working URL for a 404.
 */
export function learnRuntimeBlogSlugs(id: string, slugs: Partial<Record<Locale, string>>): void {
 learnSlugs(_runtimeReverseBlog, _runtimeBlogSlugs, id, slugs);
}

/** Same, for the Switzerland-wide (svizzera) mirror section. */
export function learnRuntimeSwissSlugs(id: string, slugs: Partial<Record<Locale, string>>): void {
 learnSlugs(_runtimeReverseSwiss, _runtimeSwissSlugs, id, slugs);
}

/** Resolve a blog slug to an article ID (returns undefined if data not loaded or slug unknown). */
export function resolveBlogSlug(slug: string, locale: Locale): BlogArticleId | undefined {
 return (_reverseBlog?.[locale]?.[slug]
 ?? _runtimeReverseBlog[locale]?.[slug]) as BlogArticleId | undefined;
}

// ── Lazy-loaded svizzera (Switzerland-wide) article data (routerSwissData.ts) ──
let _swissSlugs: Record<string, Record<Locale, string>> | null = null;
let _reverseSwiss: Record<Locale, Record<string, string>> | null = null;
let _swissDataPromise: Promise<void> | null = null;

/** Trigger lazy load of svizzera article slug data. Safe to call multiple times. */
export function preloadSwissData(): Promise<void> {
 if (_swissSlugs) return Promise.resolve();
 if (!_swissDataPromise) {
 _swissDataPromise = import('./routerSwissData').then(m => {
 _swissSlugs = m.SWISS_SLUGS;
 _reverseSwiss = m.REVERSE_SWISS;
 });
 }
 return _swissDataPromise;
}

/** Resolve a svizzera article slug to its id (undefined if data not loaded or slug unknown). */
export function resolveSwissSlug(slug: string, locale: Locale): string | undefined {
 return _reverseSwiss?.[locale]?.[slug] ?? _runtimeReverseSwiss[locale]?.[slug];
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
 [table.subscribe]: { tab: 'subscribe' },
 [table.metodologia]: { tab: 'metodologia' },
 [table.dataDeletion]: { tab: 'data-deletion' },
 [table.apiStatus]: { tab: 'api-status' },
 [table.newsletter]: { tab: 'feedback' },
 [table.gamification]: { tab: 'gamification' },
 [table.dashboard]: { tab: 'profile' },
 [table.forum]: { tab: 'forum' },
 [table.contact]: { tab: 'contact' },
 [table.publish]: { tab: 'publish' },
 [table.publisherDashboard]: { tab: 'publisher-dashboard' },
 [table.journalistDashboard]: { tab: 'journalist-dashboard' },
 [table.forEmployers]: { tab: 'for-employers' },
 [table.partners]: { tab: 'partners' },
 [table.consulting]: { tab: 'consulting' },
 [table.pressKit]: { tab: 'press-kit' as const },
 [table.jobBoard]: { tab: 'job-board' },
 [table.profile]: { tab: 'profile' },
 [table.morning]: { tab: 'morning' },
 [table.blog]: { tab: 'blog' },
 [table.blogCh]: { tab: 'blog' },
 [table.glossario]: { tab: 'glossario' },
 [table.dialetto]: { tab: 'dialetto' },
 [table.faq]: { tab: 'faq' },
 [table.sitemap]: { tab: 'sitemap' },
 [table.contracts]: { tab: 'contracts' },
 [table.tfrCalculator]: { tab: 'tfr-calculator' },
 [table.permitQuiz]: { tab: 'permit-quiz' },
 [table.frontaliereWizard]: { tab: 'frontaliere-wizard' },
 [table.tredicesima]: { tab: 'tredicesima' },
 [table.weeklyDigest]: { tab: 'weekly-digest' },
 [table.toolOfWeek]: { tab: 'tool-of-week' },
 [table.emailConfirmed]: { tab: 'email-confirmed' },
 [table.newsletterPreferences]: { tab: 'newsletter-preferences' },
 // "Le mie aziende seguite" (#5012). A distinct top-level segment
 // (`aziende-seguite`), NOT a child of the employer-profile family: that one
 // matches `^/aziende/<slug>/` exactly, so the two namespaces cannot collide.
 [table.followedCompanies]: { tab: 'followed-companies' },
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
 /**
  * Set when the URL is a recognisable variant of a canonical route but
  * lives at a non-canonical path (e.g. a TI-form editorial slug nested
  * under a non-TI canton section). App.tsx should `window.location.replace`
  * to this canonical URL so the user lands on the real page (and Google
  * eventually drops the orphan from its index).
  */
 redirectTo?: string;
}

/**
 * Hub-index slugs (page-1 of the seoHubs paginated indexes) emitted under
 * every per-canton job-board section as `/cerca-lavoro-{canton}/{slug}/`.
 * Accepts every locale variant since URL → locale resolution upstream may
 * tolerate slight mismatches (defensive).
 */
const CANTON_HUB_EXACT_SLUGS: ReadonlySet<string> = new Set([
  // tutti / all / alle / tous
  'tutti', 'all', 'alle', 'tous',
  // settori / sectors / branchen / secteurs
  'settori', 'sectors', 'branchen', 'secteurs',
  // aziende / companies / unternehmen / entreprises
  'aziende', 'companies', 'unternehmen', 'entreprises',
]);

/**
 * Slug-prefix patterns for per-canton static SEO pages emitted by
 * jobsSeoPagesPlugin: pagination (`pagina-N` / `page-N` / `seite-N`),
 * per-company hubs (`azienda-X` / `company-X` / `unternehmen-X` /
 * `entreprise-X`) and category listings (`categoria-X` / `category-X` /
 * `kategorie-X` / `categorie-X`). All three families wrap real HTML files
 * on disk and must not be misrouted to the SPA's job-detail view.
 */
const CANTON_PAGINATION_RE = /^(?:pagina|page|seite)-\d+$/;
const CANTON_COMPANY_PREFIX_RE = /^(?:azienda|company|unternehmen|entreprise)-[a-z0-9][a-z0-9-]*$/;
const CANTON_CATEGORY_PREFIX_RE = /^(?:categoria|category|kategorie|categorie)-[a-z0-9][a-z0-9-]*$/;

/**
 * Returns true iff `slug` is a canonical static-SEO sub-page under a
 * per-canton job-board section (e.g. `/cerca-lavoro-basilea/<slug>/`).
 * Caller pairs this with `staticOverlay: true` so the SPA click
 * interceptor falls through to a native navigation (the file is served
 * from `dist/` and renders standalone via the SPA shell).
 */
function isCantonStaticOverlaySlug(slug: string): boolean {
  if (!slug) return false;
  if (CANTON_HUB_EXACT_SLUGS.has(slug)) return true;
  if (CANTON_PAGINATION_RE.test(slug)) return true;
  if (CANTON_COMPANY_PREFIX_RE.test(slug)) return true;
  if (CANTON_CATEGORY_PREFIX_RE.test(slug)) return true;
  return false;
}

/** First-segment word for author profile pages (`/autori/{slug}/`), per locale — mirrors services/seo/seo-authors.ts AUTHOR_SLUG_BY_LOCALE. */
const AUTHOR_PATH_SEGMENT: Record<Locale, string> = {
  it: 'autori',
  en: 'authors',
  de: 'autoren',
  fr: 'auteurs',
};

export function parsePath(pathname: string): ParseResult {
 const path = pathname.replace(/\/$/, '').toLowerCase() || '/';
 const allParts = path.split('/').filter(Boolean);
 const [locale, parts] = detectLocaleFromPath(allParts);

 const table = SLUG_TABLES[locale];
 const revTop = REVERSE_TOP[locale];

 // Per-company "stats proof" page (/azienda/<companyKey>/) — private, reached
 // only via the HMAC-tokenized link in cold-outreach emails (?t=…), noindex,
 // not in site nav. The companyKey is a path segment; EmployerInsightsPage reads
 // it + the token itself. Any non-empty second segment is a valid company key.
 if (parts[0] === 'azienda' && parts[1]) {
   return { route: { activeTab: 'employer-insights', companyKey: decodeURIComponent(parts[1]) }, locale };
 }

 // Author profile pages (Google News E-E-A-T, PR #3166) — /autori/{slug}/
 // + locale variants (/en/authors/, /de/autoren/, /fr/auteurs/). This branch
 // was missing entirely, so the SPA fell through to the final notFoundPath
 // fallback on hydrate and replaced the correct static HTML with the generic
 // "Pagina non trovata" screen for every author page (reported live for
 // /autori/samuele-valente/, but affects all authors, e.g. marco-ferrari).
 if (parts[0] === AUTHOR_PATH_SEGMENT[locale] && parts[1]) {
   return { route: { activeTab: 'autore', author: decodeURIComponent(parts[1]) }, locale };
 }

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

 // CHF/EUR exchange SSG vertical (epic #4452) — hub /cambio-franco-euro/ +
 // curated amount pages /cambio-franco-euro/{amount}-franchi-in-euro/ (+
 // EN/DE/FR variants, e.g. /en/chf-eur-exchange/4500-chf-to-eur/). This
 // branch was missing entirely, so hydration fell through to the final
 // notFoundPath fallback, replacing the correct static HTML with the
 // generic "Pagina non trovata" screen and rewriting the URL back to '/'
 // (reported live for /cambio-franco-euro/4500-franchi-in-euro/, linked
 // from the calculator results cross-link — affects every hub/amount page
 // in all 4 locales). staticOverlay keeps the static content visible and
 // hydrates to the exchange comparator sub-tab.
 if (isExchangeSsgPath(pathname)) {
   const parsed = parseExchangeSsgPath(pathname);
   return { route: { activeTab: 'confronti', confrontiSubTab: 'exchange', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }

 // Per-canton salary statistics landings (F-salary) — /stipendi-{canton}/ +
 // localised variants. Build-time static HTML; staticOverlay keeps the
 // per-canton salary content visible (hydrates to the salary-compare sub-tab).
 if (isSalaryStatsPath(pathname)) {
   const parsed = parseSalaryStatsPath(pathname);
   return { route: { activeTab: 'stats', statsSubTab: 'salary-compare', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }

 // Salary-intent profession×canton landings (#4461) — /stipendio-{prof}-{canton}/
 // + localised variants. Build-time static HTML; staticOverlay keeps the
 // profession-specific salary content visible (hydrates to salary-compare).
 if (isSalaryProfessionCantonPath(pathname)) {
   const parsed = parseSalaryProfessionCantonPath(pathname);
   return { route: { activeTab: 'stats', statsSubTab: 'salary-compare', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
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
   // Per-canton "aziende che assumono" (weeklyEmployersChCantonPages.ts) —
   // /cerca-lavoro-{canton}/aziende-che-assumono/ (+ locale variants). Same
   // failure mode as the other gaps in this file: this branch was missing
   // entirely, so hydration fell through to notFoundPath. Every enumerated
   // (locale, canton) pair has a live target — full page or below-floor
   // bridge at the identical URL — so recognising the whole set is safe.
   const chCantonEmployersMatch = parseChCantonEmployersPath(pathname);
   if (chCantonEmployersMatch) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: chCantonEmployersMatch.locale as Locale };
   }
 }

 // Publisher ad detail pages — /lavoro/<slug>/ + /en|/de|/fr variants
 // (build-plugins/publisherAdPagesPlugin.ts). Original paid-content pages
 // emitted with full JobPosting structured data, OUTSIDE the SPA job dataset
 // (source: data/jobs/by-crawler/publisher-submitted.json). Without
 // staticOverlay the bare `lavoro` alias routes the second segment to a
 // job-board jobSlug lookup that misses → SPA renders "Annuncio non trovato"
 // and the static page is wiped on hydrate (and the in_house "Candidati ora"
 // CTA self-links to this same URL, so a click would trigger the same wipe).
 // The slug is always a single locale-agnostic segment (detailPath uses a
 // literal `/lavoro/` for every locale); bare `/lavoro/` (the job-board alias)
 // and `/lavoro-…/` SEO landings are NOT matched.
 // Publisher ad APPLY page — /lavoro/<slug>/candidatura/ (+ locale variants).
 // Deliberately NO staticOverlay: the emitted page is a 200-status stub
 // (publisherAdPagesPlugin renderApplyStub) and the SPA must replace it with
 // the job-board detail view, which mounts PublisherApplyForm for
 // in_house/forward_email ads. jobSlug deep-links the detail; the slug map
 // carries id+canton so the job resolves even when its canton shard isn't
 // part of the initial referrer-aware fetch.
 {
   const applyMatch = path.match(/^(?:\/(en|de|fr))?\/lavoro\/([a-z0-9][a-z0-9-]*)\/candidatura\/?$/);
   if (applyMatch) {
     return { route: { activeTab: 'job-board', jobSlug: applyMatch[2] }, locale };
   }
 }

 if (/^\/lavoro\/[a-z0-9][a-z0-9-]*\/?$/.test(path) ||
     /^\/(en|de|fr)\/lavoro\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
   return { route: { activeTab: 'job-board', staticOverlay: true }, locale };
 }

 // Evergreen employer-profile pages — /aziende/<slug>/ + /en|/de|/fr variants
 // (build-plugins/employerProfilePagesPlugin.ts, epic #4462). Single literal
 // `/aziende/` segment for every locale (mirrors the `/lavoro/` publisher
 // family). Without staticOverlay the SPA has no route for these single-segment
 // paths → it renders a 404 view that wipes the static SEO content on hydrate.
 // staticOverlay keeps the emitted employer-profile / below-floor-bridge body
 // visible while the SPA hydrates only header + footer (lite shell).
 if (/^\/aziende\/[a-z0-9][a-z0-9-]*\/?$/.test(path) ||
     /^\/(en|de|fr)\/aziende\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
   return { route: { activeTab: 'job-board', staticOverlay: true }, locale };
 }

 // Job-market snapshot static SEO pages (F4) — /mercato-lavoro-ticino/, weekly + monthly archives.
 // staticOverlay keeps the per-snapshot/per-sector page content visible.
 if (JOB_MARKET_SNAPSHOT_ROUTES.includes(pathname.endsWith('/') ? pathname : `${pathname}/`) || isJobMarketSnapshotPath(pathname)) {
   return { route: { activeTab: 'stats', statsSubTab: 'jobs-observatory', staticOverlay: true }, locale };
 }

 // Per-canton job-market snapshot static SEO pages (T2.5) —
 // /cerca-lavoro-{canton}/snapshot/ (+ locale variants). Same page family as
 // the Ticino snapshot above, one per non-TI canton. This branch was missing
 // entirely (same failure mode as the exchange/health-facilities gaps below):
 // hydration fell through to notFoundPath, replacing the live static HTML
 // with the generic "Pagina non trovata" screen. Every enumerated (locale,
 // canton) pair has a live target — full snapshot or below-floor bridge at
 // the identical URL (renderBelowFloorBridge in the plugin) — so recognising
 // the whole enumerable set here is safe.
 if (isChCantonSnapshotPath(pathname)) {
   const parsed = parseChCantonSnapshotPath(pathname);
   return { route: { activeTab: 'stats', statsSubTab: 'jobs-observatory', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }

 // Google-News topic section pages (sectionPagesPlugin.ts) — /fisco/,
 // /lavoro-frontaliere/, /salari/, /cambio-valuta/, /trasporti/,
 // /pensioni/, /dogana/ (+ locale variants, 28 URLs total). This branch
 // was missing entirely: 24 of the 28 fell through to the notFoundPath
 // catch-all, and the other 4 (/fisco/, /de/steuern/, /fr/fiscalite/, plus
 // the top-level intuitive-alias fallback) silently resolved to the LIVE
 // interactive fisco tab instead, wiping the static article-list content
 // on hydrate either way — same SSG-hydration-gap bug class as the
 // exchange-rate/canton-snapshot fixes above. Placed before the
 // REVERSE_TOP alias lookup further below so it takes priority over the
 // accidental `/fisco/` collision too. No dedicated nav tab exists for a
 // topic-filtered article list, so this maps onto the existing `blog` tab
 // (closest conceptual match) with staticOverlay to keep the emitted HTML
 // visible post-hydration.
 if (isSectionPagePath(pathname)) {
   const parsed = parseSectionPagePath(pathname);
   return { route: { activeTab: 'blog', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }

 // Per-municipality FISCAL guide pages (epic #4482/#4484,
 // fiscalMunicipalityPagesPlugin.ts) — hub index at
 // /tasse-frontalieri-comune/ (+ locale variants) plus per-comune detail
 // pages at /tasse-frontalieri-comune/{slug}/ (above-floor page OR
 // below-floor noindex bridge, same URL either way — self-mapping, per
 // fiscalMunicipalityData.ts). This branch was missing entirely: same
 // SSG-hydration-gap bug class as the section-pages/canton-snapshot fixes
 // above, hydration fell through to notFoundPath for every one of these
 // URLs. Routed to the existing `fisco` tab — same precedent as the
 // taxation-hub pillar page below (activeTab: 'fisco', staticOverlay:
 // true) — since this is a tax-guide content family, not the vita/
 // border-municipality family it cross-links.
 if (isFiscalHubPath(pathname)) {
   const parsed = parseFiscalHubPath(pathname);
   return { route: { activeTab: 'fisco', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }
 {
   const parsed = parseFiscalMunicipalityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'fisco', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Per-municipality FRANCE border pages (issue #4545,
 // frenchBorderMunicipalityPagesPlugin.ts) — hub index at
 // /vivere-in-francia-lavorare-in-svizzera/ (+ locale variants) plus
 // per-commune detail pages at /vivere-in-francia-lavorare-in-svizzera/{slug}/
 // (above-floor page OR below-floor noindex bridge, same URL either way —
 // self-mapping, per frenchBorderMunicipalityData.ts). Routed to the
 // existing `vita` tab with NO sub-tab (same self-contained pattern as the
 // fiscal branch above, mirroring frenchBorderMunicipalityData.ts's
 // architectural note — no bespoke locale-rewrite needed here).
 if (isFrenchBorderMunicipalityHubPath(pathname)) {
   const parsed = parseFrenchBorderMunicipalityHubPath(pathname);
   return { route: { activeTab: 'vita', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }
 {
   const parsed = parseFrenchBorderMunicipalityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'vita', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Per-municipality GERMANY border pages (issue #4882,
 // germanBorderMunicipalityPagesPlugin.ts) — hub index at
 // /vivere-in-germania-lavorare-in-svizzera/ (+ locale variants) plus
 // per-commune detail pages, same self-mapping/above-below-floor pattern as
 // the FRANCE branch above (see germanBorderMunicipalityData.ts). Routed to
 // the existing `vita` tab with NO sub-tab.
 if (isGermanBorderMunicipalityHubPath(pathname)) {
   const parsed = parseGermanBorderMunicipalityHubPath(pathname);
   return { route: { activeTab: 'vita', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }
 {
   const parsed = parseGermanBorderMunicipalityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'vita', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Per-municipality LIECHTENSTEIN border pages (issue #4884,
 // liechtensteinBorderMunicipalityPagesPlugin.ts) — hub index at
 // /vivere-in-liechtenstein-lavorare-in-svizzera/ (+ locale variants) plus
 // per-Gemeinde detail pages, same self-mapping/above-below-floor pattern as
 // the FRANCE/GERMANY branches above (see liechtensteinBorderMunicipalityData.ts).
 // Routed to the existing `vita` tab with NO sub-tab.
 if (isLiechtensteinBorderMunicipalityHubPath(pathname)) {
   const parsed = parseLiechtensteinBorderMunicipalityHubPath(pathname);
   return { route: { activeTab: 'vita', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }
 {
   const parsed = parseLiechtensteinBorderMunicipalityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'vita', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Per-municipality AUSTRIA border pages (issue #4883,
 // austrianBorderMunicipalityPagesPlugin.ts) — hub index at
 // /vivere-in-austria-lavorare-in-svizzera/ (+ locale variants) plus
 // per-Gemeinde detail pages, same self-mapping/above-below-floor pattern as
 // the FRANCE/GERMANY/LIECHTENSTEIN branches above (see
 // austrianBorderMunicipalityData.ts). Unlike its siblings this regime has
 // NO favourable frontalieri tax treatment — abrogated 2006/2007, ordinary
 // taxation applies — but the routing shape is identical.
 // Routed to the existing `vita` tab with NO sub-tab.
 if (isAustrianBorderMunicipalityHubPath(pathname)) {
   const parsed = parseAustrianBorderMunicipalityHubPath(pathname);
   return { route: { activeTab: 'vita', staticOverlay: true }, locale: (parsed?.locale ?? locale) as Locale };
 }
 {
   const parsed = parseAustrianBorderMunicipalityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'vita', staticOverlay: true }, locale: parsed.locale as Locale };
   }
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

 // Taxation hub pillar — /guida-tassazione-frontalieri-2026/ + locale variants.
 // Standalone editorial SEO landing emitted by build-plugins/editorialContent.ts
 // outside #root. Without staticOverlay the SPA hydration mapped the route to
 // `activeTab: 'tassazione-hub'`, for which App.tsx has no rendering branch —
 // it fell through to the FeedbackSection fallback (the "report a bug" page),
 // wiping the static pillar content on first paint. Route to the fisco tab so
 // back-nav lands on a usable view, and keep staticOverlay so the SSG HTML
 // stays visible.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (
     normalized === '/guida-tassazione-frontalieri-2026/' ||
     normalized === '/en/cross-border-taxation-guide-2026/' ||
     normalized === '/de/grenzgaenger-besteuerung-leitfaden-2026/' ||
     normalized === '/fr/guide-imposition-frontaliers-2026/'
   ) {
     return { route: { activeTab: 'fisco', staticOverlay: true }, locale };
   }
 }

 // Communications list — /comunicazioni/ + locale twins (#5712). Source of
 // truth for the four paths: services/communicationChannels.ts
 // COMMUNICATIONS_PAGE_PATH, which the build plugin emits from. The page is
 // named INSIDE every consent formula (services/consentTexts.ts), so a
 // visitor arrives here by clicking a notice — and without staticOverlay the
 // SPA would treat the URL as unknown on hydrate, hide
 // `main.seo-static-content` and render NotFoundSuggestions over a page that
 // exists. Routed to `privacy` for back-nav: it is the disclosure family this
 // page belongs to.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   const commsPaths: Record<string, Locale> = {
     '/comunicazioni/': 'it',
     '/en/communications/': 'en',
     '/de/mitteilungen/': 'de',
     '/fr/communications/': 'fr',
   };
   const commsLocale = commsPaths[normalized];
   if (commsLocale) {
     return { route: { activeTab: 'privacy', staticOverlay: true }, locale: commsLocale };
   }
 }

 // Pharmacy coverage hub — /farmacie/ + locale twins (#6399). Source of
 // truth for the four paths: services/pharmacies/types.ts
 // PHARMACY_HUB_PATH, which build-plugins/pharmacyHubPlugin.ts emits from.
 // Without staticOverlay the SPA would treat the URL as unknown on
 // hydrate, hide `main.seo-static-content` and render NotFoundSuggestions
 // over a page that exists. Routed to `vita` for back-nav: daily-life
 // services is the closest existing tab family.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   const pharmacyPaths: Record<string, Locale> = {
     '/farmacie/': 'it',
     '/en/pharmacies/': 'en',
     '/de/apotheken/': 'de',
     '/fr/pharmacies/': 'fr',
   };
   const pharmacyLocale = pharmacyPaths[normalized];
   if (pharmacyLocale) {
     return { route: { activeTab: 'vita', staticOverlay: true }, locale: pharmacyLocale };
   }
 }

 // Self-certification forms guide — /moduli/autocertificazione-candidatura/
 // (IT-only, source of truth: build-plugins/selfCertificationFormsPlugin.ts
 // LANDING_URL_PATH). Emitted via buildSeoPageHtml (seoContentOutsideRoot:
 // true); without staticOverlay this path is unmatched anywhere else in
 // parsePath, falls through to the final notFoundPath fallback, and the SPA
 // hides `main.seo-static-content` + renders NotFoundSuggestions inside
 // #root on hydrate — the guide + PDF links vanish for real users. Routed to
 // guida/first-day for back-nav, mirroring the salary-hub article pattern.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (normalized === '/moduli/autocertificazione-candidatura/') {
     return { route: { activeTab: 'guida', guidaSubTab: 'first-day', staticOverlay: true }, locale: 'it' };
   }
 }

 // Border-municipality static SEO pages — one page per Italian comune under
 // the municipalities hub. The build emits the actual page body outside
 // #root; staticOverlay keeps SPA navigation from replacing it with the
 // generic "Comuni di Frontiera" sub-tab.
 if (
   /^\/vivere-in-ticino\/comuni-di-frontiera\/[a-z0-9-]+\/?$/.test(pathname) ||
   /^\/en\/living-in-ticino\/border-municipalities\/[a-z0-9-]+\/?$/.test(pathname) ||
   /^\/de\/leben-im-tessin\/grenzgemeinden\/[a-z0-9-]+\/?$/.test(pathname) ||
   /^\/fr\/vivre-au-tessin\/communes-frontiere\/[a-z0-9-]+\/?$/.test(pathname)
 ) {
   const localeMatch = pathname.match(/^\/(en|de|fr)\//);
   const targetLocale = (localeMatch ? localeMatch[1] : 'it') as Locale;
   return { route: { activeTab: 'vita', vitaSubTab: 'municipalities', staticOverlay: true }, locale: targetLocale };
 }

 // Nationwide events pages (issue #2963 + per-event detail #3125, canton
 // rollout #3125) — /eventi/{canton}/ hub + /{comune}/ + /questo-weekend/
 // digest (1 segment) + per-event detail /{comune}/{event-slug}/ (2
 // segments), build-emitted outside #root. staticOverlay keeps the SPA from
 // replacing the static agenda body on back-nav. Routed to the `vita` hub
 // (living-in-Ticino theme) to match the page's hubChrome. The canton segment
 // is matched against `EVENTS_CANTON_SLUGS` (derived from the SAME
 // `data/canton-url-slugs.json` table the events SSG plugin's
 // `eventsBasePathForCanton` uses, §6) instead of a hardcoded `ticino`/
 // `tessin` literal, so any canton's events pages are routable once emitted.
 {
   const eventsLocale = matchEventsCantonLocale(pathname);
   if (eventsLocale) {
     return { route: { activeTab: 'vita', vitaSubTab: 'places', staticOverlay: true }, locale: eventsLocale };
   }
 }

 // Swiss-wide events index hub (issue #3645, F3) — bare /eventi/ + locale
 // variants, one level above every canton hub matched just above. Separate
 // branch (not folded into the block above) since it's a wholly separate,
 // mutually-exclusive pattern — see `EVENTS_INDEX_PATTERN`'s docblock.
 {
   const eventsIndexLocale = matchEventsIndexLocale(pathname);
   if (eventsIndexLocale) {
     return { route: { activeTab: 'vita', vitaSubTab: 'places', staticOverlay: true }, locale: eventsIndexLocale };
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

 // #4480 — Frontaliere public-holiday landings (/giorni-festivi-ticino/ +
 // /giorni-festivi-svizzera-italia/ + locale variants). 2 page types × 4
 // locales = 8 URLs. Static HTML emitted outside `#root`; staticOverlay keeps
 // the per-page calendar visible so the SPA doesn't replace it with the guide.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (HOLIDAY_LANDING_ROUTES.includes(normalized) || isHolidaysLandingPath(pathname)) {
     const parsed = parseHolidaysLandingPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'guida', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
 }

 // #5001 — article topic hubs: /{section-hub}/{argomenti|topics|themen|sujets}/
 // /{topic}/ (+ /page-N/), both article sections × 4 locales. Static HTML
 // emitted outside `#root`.
 //
 // This branch MUST stay ahead of the `topMatch.tab === 'blog'` article-slug
 // parser further down: that one reads the segment after the section hub as an
 // article slug, so `/articoli-frontaliere/argomenti/tasse-e-imposte/` would
 // resolve to a `blogSlug: 'argomenti'` that never exists, and the hub would
 // hydrate into a deferred-article view instead of staying on screen.
 //
 // #5436 — plus the bare index one level up, `/{section-hub}/{segment}/`
 // itself: 8 more URLs, same treatment. It is a SEPARATE predicate and not a
 // widened `isTopicClusterHubPath`, because that helper also drives
 // searchConsoleCompat's hub-canonical resolution and an index is not a hub
 // (see `buildTopicIndexPath`). The slug trap above bites it one segment
 // shorter: `/articoli-frontaliere/argomenti/` reads as `blogSlug:
 // 'argomenti'` exactly, so without this the page would 404 into the SPA's
 // deferred-article view after hydration even though the static HTML is there.
 if (isTopicClusterHubPath(pathname) || isTopicIndexPath(pathname)) {
   const section =
     resolveTopicClusterHubSection(pathname) ?? resolveTopicIndexSection(pathname);
   return {
     route: {
       activeTab: 'blog',
       ...(section === 'svizzera' ? { blogSection: 'svizzera' as const } : {}),
       staticOverlay: true,
     },
     locale,
   };
 }

 // #4481 — BFS salary-by-age / salary-by-education landings
 // (/stipendio-medio-svizzera-30-anni/, /stipendio-svizzera-laurea/ + locale
 // variants). 5 ages + 4 education levels × 4 locales = 36 URLs. Static HTML
 // emitted outside `#root`; staticOverlay keeps the per-page content visible.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (SALARY_LANDING_ROUTES.includes(normalized) || isSalaryLandingPath(pathname)) {
     const parsed = parseSalaryLandingPath(pathname);
     if (parsed) {
       return {
         route: { activeTab: 'stats', statsSubTab: 'salary-compare', staticOverlay: true },
         locale: parsed.locale as Locale,
       };
     }
   }
 }

 // #4479 — Swiss minimum-wage landings (/salario-minimo/ hub + per-canton
 // /salario-minimo/{ticino,ginevra,…}/ + /salario-minimo/contratti-collettivi/
 // + locale variants). 7 page types × 4 locales = 28 URLs. Static HTML emitted
 // outside `#root`; staticOverlay keeps the per-page content visible so the SPA
 // doesn't replace it with a generic fallback.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (MINWAGE_LANDING_ROUTES.includes(normalized) || isMinWageLandingPath(pathname)) {
     const parsed = parseMinWageLandingPath(pathname);
     if (parsed) {
       return {
         route: { activeTab: 'stats', statsSubTab: 'salary-compare', staticOverlay: true },
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

 // Pillar hub "frontaliere" (#3393) — 1 page × 4 locales. Orchestrates the
 // topic cluster (permits, salary, taxes, health, profession landings);
 // static HTML emitted by frontalierePillarPlugin outside #root, so the
 // staticOverlay route keeps it visible after SPA hydrate.
 {
   const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
   if (FRONTALIERE_PILLAR_ROUTES.includes(normalized) || isFrontalierePillarPath(pathname)) {
     const parsed = parseFrontalierePillarPath(pathname);
     if (parsed) {
       return { route: { activeTab: 'guida', staticOverlay: true }, locale: parsed.locale as Locale };
     }
   }
 }

 // Per-canton profession landings (/lavoro-{canton}-{role}/ + locale variants).
 // Build-time static HTML (gated on real job count); staticOverlay hydrates to
 // the job board so the SPA doesn't replace the per-canton/profession content.
 if (isProfessionCantonPath(pathname)) {
   const parsed = parseProfessionCantonPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Profession x TI-city landings (/lavoro-{city}-{role}/ + locale variants,
 // issue #4301). Same static-overlay pattern as the per-canton family above.
 if (isProfessionCityPath(pathname)) {
   const parsed = parseProfessionCityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
   }
 }

 // Health-facilities hub (/strutture-sanitarie/{slug}/ + locale variants,
 // epic #4455). This branch was missing entirely — same failure mode as the
 // exchange-vertical bug (notFoundPath fallback + URL rewritten to '/').
 // Static HTML emitted by healthFacilitiesPlugin; staticOverlay hydrates to
 // the job board so the SPA doesn't replace the facility content.
 if (isHealthFacilityPath(pathname)) {
   const parsed = parseHealthFacilityPath(pathname);
   if (parsed) {
     return { route: { activeTab: 'job-board', staticOverlay: true }, locale: parsed.locale as Locale };
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
   const isSwissArticles = /\/articoli-svizzera\/|\/swiss-articles\/|\/schweiz-artikel\/|\/articles-suisse\//.test(pathname);
   return {
     route: isSwissArticles
       ? { activeTab: 'blog', blogSection: 'svizzera', staticOverlay: true }
       : isArticles
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
   // Per-question pages, `<hub>/<entry id>/` (issue #5008). Same chrome and
   // the same staticOverlay contract as the hub: the build-time answer stays
   // visible outside `#root` instead of being replaced by a generic sub-tab
   // view. Matched structurally, so the router does not have to bundle the
   // 340 KB question corpus to recognise 412 URLs.
   const entry = parseFaqEntryPath(pathname);
   if (entry) {
     return {
       route: { activeTab: 'guida', guidaSubTab: 'permits', staticOverlay: true },
       locale: entry.locale as Locale,
     };
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

 // ── Per-canton job-board routes (P1.3, 2026-05-10) ────────────────
 //
 // Backward-compat preservation: the legacy `first === table.jobBoard`
 // branch further down (~line 2390) still runs FIRST for the Ticino
 // slug because `table.jobBoard` is registered in `revTop` and
 // `topMatch.tab === 'job-board'` resolves it. We only intercept here
 // when the URL is a NEW per-canton or aggregator slug that is NOT in
 // `revTop` (so `topMatch` would otherwise be undefined and the route
 // would fall through to a 404).
 //
 // Match precedence:
 //   1. legacy `table.jobBoard` (handled by the standard topMatch flow)
 //   2. parseJobBoardSlug() match (per-canton or aggregator) — THIS BLOCK
 //   3. everything else (other tabs)
 if (first && first !== table.jobBoard) {
   const jobBoardCantonMatch = parseJobBoardSlug(first, locale);
   if (jobBoardCantonMatch) {
     const { cantonCode, isAggregator } = jobBoardCantonMatch;
     const rawSecond = second ? second.trim() : undefined;
     // City-vs-job disambiguation: known CITY_HUB key → jobBoardCity,
     // anything else → jobSlug. Mirrors the legacy Ticino branch so
     // `/cerca-lavoro-zurigo/zurich/` and similar resolve consistently.
     // Sector hub matches are also honoured for parity with TI.
     if (rawSecond) {
       const sectorHit = SECTOR_HUB_KEYS.find(
         (s) => SECTOR_HUB_SLUG[locale][s] === rawSecond,
       );
       if (sectorHit) {
         return {
           route: {
             activeTab: 'job-board',
             jobBoardCanton: cantonCode,
             jobBoardSector: sectorHit as SectorHubKey,
             staticOverlay: true,
           },
           locale,
         };
       }
       // P1.3 Phase 2 — data-driven city match. `isKnownCityHub` consults
       // `data/canton-municipalities.json` so any of the 26 cantons can
       // route `/<section>/<city>/` to `jobBoardCity`. For TI the legacy
       // 5-city set continues to match (BFS municipalities include
       // Lugano/Mendrisio/Bellinzona/Locarno/Chiasso). Non-aggregator
       // cantons only — aggregator pages (`_AGGREGATE_`) don't have a
       // single canton scope, so a known city slug must be unambiguous
       // across cantons (handled inside `isKnownCityHub`).
       const cantonForCityLookup = cantonCode !== '_AGGREGATE_' ? cantonCode : undefined;
       if (isKnownCityHub(rawSecond, cantonForCityLookup)) {
         // Build emits a real per-city static HTML at this path (city-jobs-hub
         // plugin) with the jobs already filtered and ranked for the city.
         // staticOverlay:true keeps that SSR content visible — without it the
         // SPA hydration replaces the 3 city-filtered cards with a generic
         // canton-wide SERP (jobBoardCity is currently a dead field downstream).
         return {
           route: {
             activeTab: 'job-board',
             jobBoardCanton: cantonCode,
             jobBoardCity: rawSecond,
             staticOverlay: true,
           },
           locale,
         };
       }
       // Editorial-landing slugs (today / nurses-hub / part-time / care-
       // variant / official-gazette). The descriptor resolver accepts
       // every canton variant — TI long-form (`offerte-di-lavoro-ticino-
       // oggi`) and the short non-TI form (`oggi`). If the URL nests a
       // foreign canton's slug under this canton's section (e.g.
       // `/cerca-lavoro-basilea/offerte-di-lavoro-ticino-oggi/`), no
       // static HTML exists at that path, so the SPA would otherwise
       // fall through to the empty job-detail view. Redirect to this
       // canton's own canonical slug — the build emits that page.
       const editorialDescriptor = cantonCode !== '_AGGREGATE_'
         ? resolveEditorialJobLandingDescriptor(rawSecond)
         : null;
       if (editorialDescriptor) {
         const canonicalSlug: string | null = (() => {
           if (editorialDescriptor.kind === 'today') return getJobTodayLandingSlug(locale, cantonCode);
           if (editorialDescriptor.kind === 'nurses-hub') return getJobNursesHubSlug(locale, cantonCode);
           if (editorialDescriptor.kind === 'part-time') return getJobPartTimeLandingSlug(locale, cantonCode);
           if (editorialDescriptor.kind === 'care-variant') return careClusterSlug(editorialDescriptor.clusterKey, cantonCode, locale);
           // official-gazette only emitted for TI; recency variants don't
           // have per-canton slug variants. Let these fall through to the
           // static-overlay branch so the existing handler renders the
           // build-time HTML if present.
           return null;
         })();
         if (canonicalSlug && canonicalSlug !== rawSecond) {
           const sectionForRedirect = first;
           const localePref = locale === 'it' ? '' : `/${locale}`;
           const redirectTo = `${localePref}/${sectionForRedirect}/${canonicalSlug}/`.replace(/\/+/g, '/');
           return {
             route: { activeTab: 'job-board', jobBoardCanton: cantonCode, staticOverlay: true },
             locale,
             redirectTo,
           };
         }
         // Canonical slug for this canton — render the static overlay
         // (the build emits the HTML at this exact path).
         return {
           route: { activeTab: 'job-board', jobBoardCanton: cantonCode, staticOverlay: true },
           locale,
         };
       }
       // Build-time static SEO pages emitted under /cerca-lavoro-{canton}/:
       // hub indexes (tutti/settori/aziende + locale equivalents) from
       // seoHubsPlugin; pagination (pagina-N / page-N / seite-N) from
       // jobsSeoPagesPlugin (per-canton paginated listings); company hubs
       // (azienda-/company-/unternehmen-/entreprise-) and category listings
       // (categoria-/category-/kategorie-/categorie-) likewise emitted by
       // jobsSeoPagesPlugin. All exist as real HTML on disk and hydrate
       // the SPA shell. Without staticOverlay the click interceptor would
       // intercept these links and treat the trailing slug as a `jobSlug`
       // → JobBoard renders "Annuncio non trovato" while a new-tab open
       // works (browser loads the static HTML directly). Returning
       // staticOverlay:true lets the click interceptor fall through to
       // native navigation so the static page is fetched as designed.
       if (isCantonStaticOverlaySlug(rawSecond)) {
          return {
            route: { activeTab: 'job-board', jobBoardCanton: cantonCode, staticOverlay: true },
            locale,
          };
        }
       // Non-city second segment: treat as a job detail slug. We pass it
       // through as `jobSlug` so the existing job-detail rendering path
       // handles it. Build-time SEO pages provide static-overlay
       // disambiguation when needed.
       return {
         route: {
           activeTab: 'job-board',
           jobBoardCanton: cantonCode,
           jobSlug: rawSecond,
         },
         locale,
       };
     }
     // Bare canton (or aggregator) URL — index page for that canton.
     // `isAggregator` is destructured to satisfy lint (no-unused) and
     // signal to readers that the cantonCode === '_AGGREGATE_' case is
     // intentionally handled by the same return shape.
     void isAggregator;
     return {
       route: {
         activeTab: 'job-board',
         jobBoardCanton: cantonCode,
       },
       locale,
     };
   }
 }

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
 // Salary-hub scenario index: `/calcola-stipendio/scenari/` (locale variants).
 // Emitted by build-plugins/salaryHubIndex.ts as a rich curated landing
 // (~100KB body, 425 scenarios, locale switcher). Without staticOverlay
 // the SPA mounts the default calculator over the index. SCENARIO_INDEX_PATH
 // is the source of truth in salaryHubIndex.ts; the slugs are stable.
 const SCENARIO_INDEX_SLUG: Record<Locale, string> = { it: 'scenari', en: 'scenarios', de: 'szenarien', fr: 'scenarios' };
 if (second === SCENARIO_INDEX_SLUG[locale]) {
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', staticOverlay: true }, locale };
 }
 const landing = SEO_LANDING_REVERSE[locale][second];
 if (landing) {
 // staticOverlay: true keeps the SSG body (rendered by
 // staticPagesPlugin → buildSalaryLandingBody) visible after React
 // hydration. The SPA still mounts but App.tsx skips the calculator
 // sub-tab render for these routes — users land on the mobile-first
 // SEO-landing template (breadcrumb, tiles, comparative table, FAQ)
 // and reach the live calculator via the primary CTA.
 return { route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: landing, staticOverlay: true }, locale };
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
 // NB (review PR #4324): NIENTE staticOverlay per border/border-map — le loro
 // pagine statiche sono emesse DENTRO #root dal fallback shell di
 // staticPagesPlugin (nessun main.seo-static-content fuori dal root):
 // con staticOverlay l'hydration cancella il contenuto e App.tsx non monta
 // il <main> SPA → pagina permanentemente vuota per gli utenti JS.
 // Il fix CLS per queste route richiede prima il contratto overlay vero
 // (emissione fuori da #root), tracciato come follow-up.
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
 if (first === table.blogCh) {
 if (second) {
 const swissId = _reverseSwiss?.[locale]?.[second];
 if (swissId) {
 return { route: { activeTab: 'blog', blogSection: 'svizzera', swissArticle: swissId }, locale };
 }
 // Swiss data not loaded yet — store raw slug for deferred resolution
 return { route: { activeTab: 'blog', blogSection: 'svizzera', swissSlug: second }, locale };
 }
 return { route: { activeTab: 'blog', blogSection: 'svizzera' }, locale };
 }
 }

 if (topMatch.tab === 'job-board') {
 if (first === table.jobBoard) {
 const rawSecond = second ? second.trim() : undefined;
 // P7.1 — legacy /cerca-lavoro-ticino/ MUST set jobBoardCanton='TI'
 // so JobBoard pre-filters to TI jobs only. Without this, the user
 // landed on the legacy URL and saw ALL jobs (the aggregator behavior
 // belongs to /cerca-lavoro-svizzera/).
 // The legacy table.jobBoard slug is TI-anchored across all 4 locales:
 //   IT: cerca-lavoro-ticino    EN: find-jobs-ticino
 //   DE: jobs-im-tessin         FR: trouver-emploi-tessin
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
 jobBoardCanton: 'TI',
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
 jobBoardCanton: 'TI',
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
 return { route: { activeTab: 'job-board', jobBoardCanton: 'TI', staticOverlay: true }, locale };
 }
 // Related-search cluster landings (build-plugins/relatedSearchClustersPlugin.ts):
 // emit `/cerca-lavoro-ticino/ricerca-{slug}/` (locale variants) with rich
 // curated job-list HTML. Cluster slugs are generated dynamically from
 // `data/related-search-enriched.json` — listing every one in the router
 // prefix. The slug is passed through as `jobSlug`; JobBoard's
 // `parseSearchSlugFilter` (services/relatedSearchClusters.ts) detects the
 // `ricerca-`/`search-`/`suche-`/`recherche-` prefix and populates the search
 // bar + result grid. Returning `staticOverlay: true` here breaks the page
 // because the SPA must hydrate the interactive search view for users —
 // the static body is only the pre-hydration first paint (App.tsx hides
 // `main.cluster-seo-prose` at hydration).
 //
 // Build-time static SEO pages emitted under /cerca-lavoro-ticino/:
 // company hubs (azienda-/company-/unternehmen-/entreprise-), category
 // listings (categoria-/category-/kategorie-/categorie-), and pagination
 // (pagina-N / page-N / seite-N). Mirrored from the canton-aware branch
 // (~line 2542). Without this check, the legacy TI parsing fell through
 // to `jobSlug = rawSecond` → JobBoard parseCompanySlugFilter treats the
 // azienda- prefix as a runtime company filter → React main replaces the
 // static main → user sees an empty filtered list (the TI shard often
 // doesn't contain the cross-canton entity, e.g. Genossenschaft Migros
 // Ostschweiz on `/cerca-lavoro-ticino/azienda-migros/` — the static
 // page lists 26 SG/GR/VS jobs but the SPA filtered list shows 0).
 if (rawSecond && isCantonStaticOverlaySlug(rawSecond)) {
 return { route: { activeTab: 'job-board', jobBoardCanton: 'TI', staticOverlay: true }, locale };
 }
 // Bare search-index hub (/cerca-lavoro-ticino/ricerca/ + /…/ricerca/page-N/,
 // and the en/search · de/suche · fr/recherche locale variants): relatedSearch-
 // ClustersPlugin emits a CURATED static index of ~465 city-grouped cluster
 // links (H1, breadcrumbs, structured data). Unlike the `ricerca-{slug}` cluster
 // landings — which DO hydrate an interactive search view (handled below) — the
 // BARE hub has no interactive SPA equivalent: jobSlug=`ricerca` has no hyphen so
 // parseSearchSlugFilter never matches it, and JobBoard renders a generic/empty
 // view that TEARS DOWN the curated static list — a progressive re-render that
 // bounced the footer (live desktop CLS ~0.7 on /cerca-lavoro-ticino/ricerca/)
 // and dropped the SEO content. staticOverlay keeps the static index visible
 // (lite-shell), like the fuel-daily / health-premiums / weekly-employers hubs.
 // Exact-equality match excludes the hyphenated `ricerca-{slug}` landings.
 const SEARCH_HUB_PREFIX: Record<Locale, string> = { it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche' };
 if (rawSecond === SEARCH_HUB_PREFIX[locale]) {
   return { route: { activeTab: 'job-board', jobBoardCanton: 'TI', staticOverlay: true }, locale };
 }
 const jobSlug = rawSecond;
 // P7.1 — legacy /cerca-lavoro-ticino/{slug?} → always TI canton filter.
 // Bare hub root (no jobSlug) is a build-time static page emitted by
 // professionLandingsLinksPlugin with `<aside data-ae3-profession-links>`
 // + curated city/sector hub links. The CLS 0.702 incident on the bare
 // root (Lighthouse 2026-05-28) was caused by the OLD HTML shape:
 // `<div id="root"><main id="main-content">${179KB static body}</main></div>`.
 // React's `createRoot(...).render(<App/>)` cancelled the 179KB on
 // hydration → grosso shift. PR #765 fixed the shape: bare root now emits
 // `<div id="root"></div>` empty + `<main class="seo-static-content">`
 // OUTSIDE root. React hydrates the empty `#root` with JobBoard and
 // App.tsx's useLayoutEffect (App.tsx:204-212) flips the sibling
 // `<main class="seo-static-content">` to `display:none` synchronously
 // BEFORE paint. Same DOM choreography as every other canton job-board
 // hub (`/cerca-lavoro-basilea/`, `/cerca-lavoro-zurigo/`, etc.) which
 // already sit at staticOverlay=false and Lighthouse-pass. Without
 // staticOverlay here the bare root behaves identically: search bar +
 // canton filters + interactive job cards visible above the fold.
 return { route: { activeTab: 'job-board', jobBoardCanton: 'TI', ...(jobSlug ? { jobSlug } : {}) }, locale };
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
 case 'subscribe':
 return finish(`${prefix}/${table.subscribe}${hashSuffix}`);
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
 case 'publish':
 return finish(`${prefix}/${table.publish}${hashSuffix}`);
 case 'publisher-dashboard':
 return finish(`${prefix}/${table.publisherDashboard}${hashSuffix}`);
 case 'journalist-dashboard':
 return finish(`${prefix}/${table.journalistDashboard}${hashSuffix}`);
 case 'for-employers':
 return finish(`${prefix}/${table.forEmployers}${hashSuffix}`);
 case 'employer-insights':
 // Per-company stats page; the real per-company link (with ?t=token) is
 // generated server-side (scripts/lib/employer-insights-token.mjs). The
 // companyKey segment MUST be re-emitted so locale-boot canonicalization
 // (updatePathForLocale → buildPath) doesn't collapse the URL to the
 // empty-key `/azienda/` and break the token-gated read.
 return finish(`${prefix}/azienda/${route.companyKey ? `${encodeURIComponent(route.companyKey)}/` : ''}${hashSuffix}`);
 case 'autore':
 return finish(`${prefix}/${AUTHOR_PATH_SEGMENT[lang]}/${route.author ? `${encodeURIComponent(route.author)}/` : ''}${hashSuffix}`);
 case 'partners':
 return finish(`${prefix}/${table.partners}${hashSuffix}`);
 case 'consulting':
 return finish(`${prefix}/${table.consulting}${hashSuffix}`);
 case 'press-kit':
 return finish(`${prefix}/${table.pressKit}${hashSuffix}`);
 case 'job-board': {
 // P1.3 cathedral: per-canton + aggregator URL emission. Resolves jobBoard
 // base segment from route.jobBoardCanton (2-letter ISO code or
 // _AGGREGATE_ sentinel). Falls back to legacy table.jobBoard (TI default)
 // when canton not set, preserving backward-compat for all existing
 // /cerca-lavoro-ticino/{slug} URLs.
 const jobBoardLocale = lang as 'it' | 'en' | 'de' | 'fr';
 // Canton-aware section resolution. Precedence:
 //   1. explicit route.jobBoardCanton (set by the parser, JobBoard, hub links);
 //   2. by-construction fallback — when no explicit canton but the jobSlug
 //      maps to a KNOWN job, use that job's canton. This keeps every per-job
 //      link canton-correct across ALL buildPath callers (blog teasers,
 //      profile applications, salary/board leaders, chatbot, sitemap, …)
 //      without per-call-site plumbing, so the link-canton class can't drift;
 //   3. legacy TI default (table.jobBoard) — when the slug map isn't loaded
 //      or the slug isn't a known job (company/location/search/city slugs),
 //      preserving backward-compat for all existing /cerca-lavoro-ticino/{slug}.
 const resolvedJobBoardCanton =
 route.jobBoardCanton
 || (route.jobSlug ? getJobMetaForSlug(route.jobSlug)?.canton : undefined);
 const jobBoardBase = resolvedJobBoardCanton
 ? (resolvedJobBoardCanton === JOB_BOARD_CANTON_AGGREGATE
 ? getAggregatorJobBoardSlug(jobBoardLocale)
 : getJobBoardSlugForCanton(resolvedJobBoardCanton, jobBoardLocale))
 : table.jobBoard;
 // When a sector hub is set, emit the clean canonical URL
 // (e.g. /cerca-lavoro-ticino/infermieri/). Precedes jobSlug so
 // Google indexes the clean sector hub URL as canonical.
 if (route.jobBoardSector && SECTOR_HUB_SLUG[lang as keyof typeof SECTOR_HUB_SLUG]) {
 const sectorSlug = SECTOR_HUB_SLUG[lang as keyof typeof SECTOR_HUB_SLUG][route.jobBoardSector];
 return finish(`${prefix}/${jobBoardBase}/${sectorSlug}${hashSuffix}`);
 }
 // When a geo-hub city is set, emit the clean canonical URL
 // (e.g. /cerca-lavoro-ticino/lugano/) — this takes precedence
 // over jobSlug so Google indexes the clean URL as canonical.
 // jobBoardCity is now string (P1.3 widening); legacy CITY_HUB_SLUG only
 // holds TI cities, fallback to direct emission for new-canton cities.
 if (route.jobBoardCity) {
 const cityTable = CITY_HUB_SLUG[lang as keyof typeof CITY_HUB_SLUG];
 const citySlug = cityTable
 ? (cityTable as Record<string, string>)[route.jobBoardCity]
 : undefined;
 return finish(`${prefix}/${jobBoardBase}/${citySlug || route.jobBoardCity}${hashSuffix}`);
 }
 return finish(route.jobSlug
 ? `${prefix}/${jobBoardBase}/${localizeEditorialJobSlug(route.jobSlug) || route.jobSlug}${hashSuffix}`
 : `${prefix}/${jobBoardBase}${hashSuffix}`);
 }
 case 'profile':
 return finish(`${prefix}/${table.profile}${hashSuffix}`);
 case 'morning':
 return finish(`${prefix}/${table.morning}${hashSuffix}`);
 case 'blog': {
 // Switzerland-wide (svizzera) mirror section.
 if (route.blogSection === 'svizzera') {
 const swissId = route.swissArticle;
 if (swissId) {
 const slug = _swissSlugs?.[swissId]?.[lang] ?? _runtimeSwissSlugs[swissId]?.[lang] ?? swissId;
 return finish(`${prefix}/${table.blogCh}/${slug}${hashSuffix}`);
 }
 if (route.swissSlug) {
 return finish(`${prefix}/${table.blogCh}/${route.swissSlug}${hashSuffix}`);
 }
 return finish(`${prefix}/${table.blogCh}${hashSuffix}`);
 }
 const article = route.blogArticle;
 if (article) {
 const slug = _blogSlugs?.[article]?.[lang] ?? _runtimeBlogSlugs[article]?.[lang] ?? article;
 return finish(`${prefix}/${table.blog}/${slug}${hashSuffix}`);
 }
 // Defense-in-depth: when the lazy-loaded blog data hasn't resolved the
 // slug yet, parsePath returns `blogSlug` instead of `blogArticle`.
 // Preserve it in the URL so a stray `pushRoute(route)` during the
 // resolution window doesn't strip the slug and rewrite the URL to the
 // hub root (e.g. /articoli-frontaliere/<slug>/ → /articoli-frontaliere/).
 if (route.blogSlug) {
 return finish(`${prefix}/${table.blog}/${route.blogSlug}${hashSuffix}`);
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
 case 'frontaliere-wizard':
 return finish(`${prefix}/${table.frontaliereWizard}${hashSuffix}`);
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
 case 'followed-companies':
 return finish(`${prefix}/${table.followedCompanies}${hashSuffix}`);
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
 if (route.blogSection === 'svizzera') {
 return route.swissArticle ? `blog-${route.swissArticle}` : 'blog';
 }
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
 case 'frontaliere-wizard':
 return 'frontaliere-wizard';
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
 case 'followed-companies':
 return 'followed-companies';
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

function borderMunicipalitySlugFromStaticPath(pathname: string): string | null {
 const normalizedPath = pathname.replace(/\/+$/, '');
 for (const locale of ['it', 'en', 'de', 'fr'] as Locale[]) {
 const table = SLUG_TABLES[locale];
 const prefix = localePrefix(locale);
 const basePath = `${prefix}/${table.vita}/${table.municipalities}`.replace(/\/+/g, '/');
 if (!normalizedPath.startsWith(`${basePath}/`)) continue;
 const slug = normalizedPath.slice(basePath.length + 1);
 return /^[a-z0-9-]+$/.test(slug) ? slug : null;
 }
 return null;
}

function buildBorderMunicipalityStaticPath(slug: string, locale: Locale): string {
 const table = SLUG_TABLES[locale];
 const prefix = localePrefix(locale);
 return `${prefix}/${table.vita}/${table.municipalities}/${slug}/`.replace(/\/+/g, '/');
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
 if (route.staticOverlay) {
 const municipalitySlug = borderMunicipalitySlugFromStaticPath(currentPath);
 if (municipalitySlug) {
 const newPath = buildBorderMunicipalityStaticPath(municipalitySlug, newLocale);
 if (currentPath !== newPath) {
 window.location.assign(newPath + search + window.location.hash);
 }
 }
 return;
 }
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
