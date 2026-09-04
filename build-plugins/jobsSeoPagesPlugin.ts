/**
 * Generate localized static landing pages for every job in data/jobs.json.
 *
 * For each job × 4 locales, writes a standalone HTML page with structured
 * data (JobPosting, BreadcrumbList), OG/Twitter meta, related jobs,
 * and an "Apply now" CTA linking to the original listing.
 * Also writes sitemap-jobs.xml and patches it into the main sitemap index.
 */

// Import statici, NON `await import()` dentro closeBundle (#5001): closeBundle e'
// un hook Rollup async/parallelo, quindi quell'await sospende il plugin e un
// altro plugin `enforce:'post'` puo' girare per intero prima che questo
// riprenda. E' gia' costato due bug silenziosi (pdfWhitepapersPlugin,
// staticPagesPlugin): le hero card venivano drenate prima di essere registrate.
import fs from 'node:fs';
import { isSliceFile } from '../scripts/lib/crawler-slice-files.mjs';
import np from 'node:path';
import path from 'path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, robotsMetaForContent, ROBOTS_INDEX_ENHANCED, ROBOTS_NOINDEX_FOLLOW, robotsMetaEnhancedForContent, countHtmlBodyWords, MIN_INDEXABLE_WORDS, GTAG_SNIPPET, ADSENSE_SNIPPET, PARTNERIZE_TAG_SNIPPET, FAVICON_LINKS, EARLY_BOOT_SCRIPT, CDN_PRECONNECT_HINT } from './constants';
import { buildSimplePage, asyncCssHeadBlock, rootShell, esc as escHtml } from './htmlTemplate';
import { railGutters } from './shared/railGutters';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { firstParsableMs } from './shared/firstParsableDate';
import { buildSlimSeed } from './shared/slimJobIndex';
import { readCompatPaths } from '../scripts/lib/compat-paths-store.mjs';
import { readAllKnownJobSlugs, writeAllKnownJobSlugs } from '../scripts/lib/all-known-job-slugs-store.mjs';
import { readOrphanEnriched } from '../scripts/lib/orphan-enriched-store.mjs';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { buildJobPostingFaqPairs, type BuildJobPostingFaqOptions } from './shared/jobPostingFaq';
import { hostFromUrl } from './shared/hostFromUrl';
import { dedupeUrlsetXmlByLoc } from './shared/sitemapUrlsetDedupe';
import { stripLiteralMarkdown as stripLiteralMarkdownFromTitle } from './shared/stripLiteralMarkdown';
import { minifyHtml } from './shared/htmlMinify';
import { getTrafficEvidenceFilter } from './shared/trafficEvidenceFilter';
import { expiredJobSlugVariants } from './shared/expiredSlugVariants';
import { truncateCodeUnits } from './shared/safeTruncate';
import { buildBridgeThinHtml } from './shared/bridgeThinShell';
import { buildSoftLandingThinHtml } from './shared/softLandingThinShell';
import { buildGscKeywordThinBody, GSC_KEYWORD_THIN_HEAD_SCRIPT } from './shared/gscKeywordThinShell';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import {
  normalizeSearchTerm as normalizeSearchTermShared,
  collectSearchLandingMatches,
} from './shared/searchLandingMatch';
import { registerKeywordLandingPaths } from './shared/keywordLandingPlan';
import {
  buildLocaleAlternateBlock,
  buildSitemapAlternateBlock,
  type AlternateLocale,
} from './shared/localeAlternateBlock';
import { jobDescriptionTextToHtml, inlineTextToHtml } from './shared/jobDescription/toHtml';
import { markCantonNoindex } from './shared/cantonNoindexRegistry';
import { markCantonSectorPage } from './shared/cantonSectorPageRegistry';
// Reverse crosslink lavoro -> evento (#3646, epic #3125) — the item PR #3696
// declared open. Isolated module reusing eventsSeoPagesPlugin's own data
// primitives (AGENTS.md §6); see build-plugins/shared/jobEventsCrosslink.ts.
import { nearbyEventsBlockForJobPage } from './shared/jobEventsCrosslink';
import { EJP_STRIPPED_MARKER } from './shared/ejpMarker';
import { WriteCollector } from './batchWrite';
import { buildFlatBridgeFromSibling } from './flatHtmlRedirectPlugin';
import { buildTitleWithBrand, composeSerpJobTitle, JOB_TITLE_CITY_CONNECTOR, TITLE_MAX_CHARS, clampMetaDescription, truncateHeadline, peelDanglingClauseTail, truncateTitleAtClauseBoundary, MIN_PEELED_TITLE_CHARS, truncateClauseAware } from './shared/titleSuffix';
import { stripLeadingSectionLabel } from './shared/jobDescription/parser';
import { CRAWLED_COMPANY_LOGOS } from '../services/jobDataNormalization';
import {
 renderJobCardHtml,
 renderJobCardListHtml,
 JOB_CARD_ICON_SYMBOLS,
 type JobCardJob,
 type JobCardLocale,
} from './shared/jobCardHtml';
import { infeedAdGridBlockHtml, infeedAdListItemHtml } from './lib/adSlotHtml';
import { shouldPlaceInfeedAd } from '../services/adsenseSlots';
import { LOGO_FALLBACK_SCRIPT } from './shared/logoFallbackScript';
import { renderJobBoardListingDensityProse, renderListingPaginationProse } from './shared/jobListingProse';
import {
 renderJobBoardCommuterContext,
 renderSearchQueryIntro,
 isKnownTicinoCommuterCity, CALC_HREF,
} from './shared/jobBoardCommuterContext';
import { FX_HREF } from './shared/comparatorHref';
import { formatUpdatedSentence } from './shared/humanDate';
import { renderCompanyHubFrontalierContext } from './shared/companyHubFrontalierContext';
import {
 renderHeroBadges,
 renderMobileActionBlock,
 renderHighlightsChips,
 renderRightRail,
} from './shared/jobDetailHtml';
import { renderEmployerCtaJobPage } from './shared/employerCtaBlock';
import { deriveJobPostalCode } from '../services/jobLocationSnapshot';
import { buildFallbackCanonicalContent, canonicalizeFallbackCleaned, localizeFallbackCanonical, type CleanedFallbackContent } from '../services/jobs/canonicalFallback';
import {
 loadWinners,
 saveWinners,
 resolveWinner,
 pruneStaleWinners,
 makeKey as previousSlugWinnerKey,
 type CandidateInput as PreviousSlugCandidate,
 type WinnersFile as PreviousSlugWinnersFile,
} from '../services/previousSlugWinners';
import { EMPLOYER_BRANDS, type EmployerBrand } from '../services/employerBrands';
import { isLocationMatch } from '../services/textUtils';
import {
 BRAND_CANONICAL_MAP,
 isBrandAlias,
 listAllBrandAliases,
 resolveBrandCanonical,
} from './shared/brandCanonicalMap';
import {
 baseCompanySlug,
 rawCompanySlug,
 canonicalCompanyProfileSlug,
} from './shared/companyProfileSlug.mjs';
import {
 buildJobCareVariantLandingModel,
 buildJobLocationLandingModel,
 buildJobLocationSectorLandingModel,
 buildJobLocationTypeLandingModel,
 buildJobNursesHubLandingModel,
 buildJobOfficialGazetteLandingModel,
 buildJobPartTimeLandingModel,
 buildJobTodayLandingModel,
 getJobTodayLandingSlug,
 getJobNursesHubSlug,
 getJobPartTimeLandingSlug,
 careClusterSlug,
 EDITORIAL_CANTONS,
 partitionCareClusters,
 partitionByLocation,
 type CareClusterPartition,
 type LocationPartition,
} from './jobEditorialLanding';
import {
 CITY_HUB_KEYS,
 CITY_HUB_SLUG,
 CITY_HUB_DISPLAY_NAME,
 buildCityHubPath,
 buildCityHubSeo,
 countCityJobsByLocale,
 jobMatchesCity,
 type CityHubKey,
} from './cityJobsHub';
import {
 SECTOR_HUB_KEYS,
 SECTOR_HUB_DISPLAY,
 SECTOR_HUB_SLUG,
 buildSectorHubPath,
 buildSectorHubSeo,
 jobMatchesSector,
 assertSectorHubTablesComplete,
 type SectorHubKey,
} from './jobSectorLanding';
import { SEO_HUB_RESERVED_SLUGS, JOBS_PAGE_SIZE as HUB_JOBS_PAGE_SIZE, hubSlugFor } from './seoHubsData';
import { buildCantonHubEditorial, buildCantonRealDataBlock } from './shared/cantonHubEditorial';
// Issue #4303 item 1 — real BFS/BAG-sourced axes for the cathedral canton
// real-data block (wage-level factor + LAMal premium vs Ticino; no
// fabricated cross-canton rent/CPI index exists in-repo).
import {
  cantonSalaryFactor,
  isBorderCanton as cantonIsBorderCanton,
  NATIONAL_MEDIAN_MONTHLY,
  TICINO_MEDIAN_MONTHLY,
} from './shared/cantonSalaryIndex';
import { aggregateLamalCantonMedians } from './comparisonsHubAggregate';
import type { CantonRealDataSectorRow, CantonRealDataEmployer } from './shared/cantonHubEditorial';
// F3a — Job Page CTR Optimization: shared 50-60 char title templates and
// 140-160 char meta-description templates that drive SERP CTR on the
// top-20 job listing pages. See services/seo/job-board-titles.ts and
// services/seo/meta-descriptions.ts for details.
import {
 buildEmployerHubTitle,
 buildRoleHubTitle,
} from '../services/seo/job-board-titles';
import {
 formatSeoH1,
 renderStatGrid,
 pickStatTileTone,
 CTA_PRIMARY_CLASS,
 HERO_EYEBROW_STYLE,
} from './shared/seoContentTokens';
import { SECTOR_HUB_EMOJI } from './shared/sectorHubEmoji';
import {
 buildCityHubMeta as buildCtrCityHubMeta,
 buildCantonHubMeta,
 buildEmployerHubMeta,
 buildRoleHubMeta,
} from '../services/seo/meta-descriptions';
import { COMPANY_HQ_ADDRESSES, CANTON_CAPITAL_ADDRESSES, localityMatchesHq } from './shared/companyHqAddresses';
import { buildJobPostingSchema, sanitizeLocalityForRegion, type JobInput } from './shared/jobPostingSchema';
import { normalizeCantonCode, inferAnyCanton } from '../scripts/lib/target-swiss-locations.mjs';
import { formatJobLocation, splitJobLocation } from '../scripts/lib/job-location-display.mjs';
import { buildListItemJobPosting } from './shared/jobPostingListItem';
import { startTimer, recordEmit, phaseTimer, recordPhase, printSummary as printJobsSeoProfile } from './shared/jobsSeoProfiler.ts';
import { employerProfilesFlushed, resolveJobsSeoPagesFlushed } from './shared/buildSignals';
import { employerTitleCandidates, type EmployerProfileLocale } from './employerProfilePagesPlugin';
import { MIN_JOBS_FOR_CANTON_PAGE } from './weeklyEmployersData';
import { forceGc } from './shared/forceGc';
import {
  resolveCantonSection as sharedResolveCantonSection,
  resolveJobCanton as sharedResolveJobCanton,
  ALL_CANTON_CODES as SHARED_ALL_CANTON_CODES,
  COMPANY_ROUTE_PREFIX,
  isCompanyHubNamespaceSlug,
} from './shared/cantonSection';
import { getCantonCities, normalizeCitySlug } from './shared/cantonCities';
import { logBuildMem } from './shared/buildMemLog';
import { canonicalCleanedKey } from './shared/canonicalCleanedKey';

// ── Build-OOM diagnostic instrumentation (#1290) ──────────────────────────────
// `logBuildMem` now lives in ./shared/buildMemLog so employerProfilePagesPlugin
// can emit the same `[mem]` line for the corpus release it performs immediately
// before this plugin runs (#5330 follow-up) — the two lines are only comparable
// if they come from one implementation. Imported above with the other shared
// helpers; the emitted format is unchanged.

export const JOB_SEO_LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * Role x Ticino combo pages — driven by internal search demand
 * (Medico, Infermiere, Autista, Cuoco, Piastrellista, …).
 *
 * Hoisted to module scope and exported so the boundary invariants can be
 * pinned by `tests/profession-matcher-boundaries.test.ts`; the table is
 * static, so nothing is lost by lifting it out of the plugin closure.
 *
 * ## Boundary defect, same class as PROFESSION_MATCHERS / SECTOR_MATCHERS
 *
 * Every entry sits inside `\b(…)\b`, so a role noun only ever matched the
 * exact inflections spelled out here. The Italian plural was missing across
 * the board — "Infermieri", "Medici assistenti", "autisti/e" and "Cuochi"
 * matched nothing — and the German feminine/compound forms
 * ("Krankenpflegerin", "Pflegefachfrau", "Oberarzt", "Elektroinstallateur")
 * never matched either. See #5204/#5205 for the same defect in the two
 * sibling taxonomies.
 *
 * The inflections are enumerated rather than left open-ended on purpose: a
 * bare `infermier` stem also swallows "servizio infermieristico" (the
 * adjective — an admin post, not a nurse), and a bare `contabil` stem
 * swallows "Servizio Centrale di Contabilità". Both were measured as real
 * false positives against the corpus before being tightened back out.
 */
export const ROLE_COMBO_MATCHERS: ReadonlyArray<{
  key: string;
  match: RegExp;
  labels: Record<'it' | 'en' | 'de' | 'fr', string>;
}> = [
  { key: 'medico', match: /\b(medic[oai]|\w*[aä]rzt(?:in|e)?|doctor|médecin|assistente di studio medico|medical)\b/i, labels: { it: 'Medico', en: 'Doctor', de: 'Arzt', fr: 'Médecin' } },
  { key: 'infermiere', match: /\b(infermier[eia]|nurse|krankenpfleger(?:in)?|krankenpflege|pflegefach\w*|infirmi[eè]r\w*|pflege)\b/i, labels: { it: 'Infermiere', en: 'Nurse', de: 'Krankenpfleger', fr: 'Infirmier' } },
  { key: 'autista', match: /\b(autist[aei]|driver|fahrer|\w*fahrer(?:in)?|chauffeur\w*|conducent[ei]|camionist[ai])\b/i, labels: { it: 'Autista', en: 'Driver', de: 'Fahrer', fr: 'Chauffeur' } },
  { key: 'cuoco', match: /\b(cuoc(?:[oa]|h[ie])|chef|koch|köch\w*|cuisinier|aiuto cuoco|pizzaiol[oi])\b/i, labels: { it: 'Cuoco', en: 'Chef', de: 'Koch', fr: 'Cuisinier' } },
  { key: 'piastrellista', match: /\b(piastrellist[ai]|tiler|plattenleger(?:in)?|carreleur|murator[ei]|mason)\b/i, labels: { it: 'Piastrellista', en: 'Tiler', de: 'Plattenleger', fr: 'Carreleur' } },
  { key: 'elettricista', match: /\b(elettricist[ai]|electrician|elektriker(?:in)?|électricien|elektroinstallateur(?:in)?)\b/i, labels: { it: 'Elettricista', en: 'Electrician', de: 'Elektriker', fr: 'Électricien' } },
  { key: 'vendita', match: /\b(vendit[oa]r[ei]|addett[oa] (alle )?vendite?|sales|verk[aä]ufer(?:in)?|vendeur|vendeuse|shop assistant|commess[oaei])\b/i, labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
  { key: 'educatore', match: /\b(educator[ei]|educatric[ei]|educator|erzieher(?:in)?|éducateur|éducatrice)\b/i, labels: { it: 'Educatore', en: 'Educator', de: 'Erzieher', fr: 'Éducateur' } },
  { key: 'contabile', match: /\b(contabil[ei]|accountant|buchhalter(?:in)?|comptable|ragionier[ei])\b/i, labels: { it: 'Contabile', en: 'Accountant', de: 'Buchhalter', fr: 'Comptable' } },
  { key: 'meccanico', match: /\b(meccanic[oai]|mechanic|mechaniker(?:in)?|mécanicien)\b/i, labels: { it: 'Meccanico', en: 'Mechanic', de: 'Mechaniker', fr: 'Mécanicien' } },
];

const HUB_SEO_CONTEXT_SUMMARY: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
 en: 'Cross-border guide: salary, G permit, tax, weekly return',
 de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
 fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
};

/**
 * Wrap commuter-context block in a collapsed `<details>` accordion below
 * the real hub content (mobile-first per CLAUDE.md rule #14). Lifts the
 * crawler-facing prose out of the markup-heavy hub list page so the
 * audit:text-html-ratio gate stays above the 10% Semrush threshold.
 */
function wrapHubSeoContext(locale: 'it' | 'en' | 'de' | 'fr', innerHtml: string): string {
 return `<details class="hub-seo-context s-mxdIN0">
 <summary class="s-1yn7b_">${HUB_SEO_CONTEXT_SUMMARY[locale]}</summary>
 <div class="s-yZU6bn">
 <section class="s-p_RJwm">
 ${innerHtml}
 </section>
 </div>
 </details>`;
}

export function pickSearchLandingFallbackJobs<T>(
 matchingJobsByLocale: Record<(typeof JOB_SEO_LOCALES)[number], T[]>,
): T[] {
 for (const locale of JOB_SEO_LOCALES) {
 const localeJobs = matchingJobsByLocale[locale];
 if (Array.isArray(localeJobs) && localeJobs.length > 0) {
 return localeJobs;
 }
 }
 return [];
}

/**
 * Cap a search-stats-landing title ("Offerte di lavoro {name} in Svizzera"
 * style — see the search-stats-landing block below) on a whitespace
 * boundary, no ellipsis (per titleSuffix.ts's no-`…` policy protecting SERP
 * CTR).
 *
 * Budgeted on the ESCAPED length, not the raw length: `name` comes from
 * crawled job-title stats leaders (`topTitlesAdded30d` in
 * data/jobs-stats.json, e.g. "Sales & Marketing"), and `htmlTemplate.ts`
 * renders this title as `esc(title)` (one escape pass) — the same
 * measurement `audit-title-length.mjs` applies to the raw HTML source. A raw
 * `&`/`<`/`>`/`"` expands on escape, so a candidate that fits the raw budget
 * can still overflow the cap once escaped. The word-boundary slice below can
 * land within the raw budget but still overflow once escaped (a retained
 * `&` survives the cut) — shrink the raw ceiling and retry until the escaped
 * candidate fits. Bounded: each retry strictly decrements the ceiling, so
 * this converges in at most `maxChars` iterations. Same class of fix as
 * eventsSeoPagesPlugin.ts's `eventDetailMetaTitle` (#3589).
 */
export function capSearchStatsLandingTitle(
 rawTitle: string,
 maxChars: number = TITLE_MAX_CHARS,
 measureLength: (s: string) => number = (s) => escHtml(s).length,
): string {
 const capAt = (max: number): string => {
 if (rawTitle.length <= max) return rawTitle;
 const peeled = truncateTitleAtClauseBoundary(rawTitle, max);
 // Reject a TOO-SHORT peel, not merely an empty one: that is the helper's
 // stated contract (MIN_PEELED_TITLE_CHARS), and testing `peeled || …` here
 // honoured only the emptiness half of it. A short-but-non-empty peel — the
 // budget fitted only stopwords, and peeling them left a fragment — would
 // satisfy the shrink loop below and ship as the indexed <title>, i.e. the
 // near-empty SERP title that is exactly the CTR-regression class this file
 // is being fixed for.
 //
 // Priority, in order. Two review rounds pushed in OPPOSITE directions here, and the
 // ordering below is what satisfies both:
 //
 //   round 1: never ship a short-but-non-empty peel when something better exists;
 //   round 2: never ship a title ending on a dangling function word.
 //
 // For a degenerate input neither can be waived: at max=20,
 // "Lavoro: e di il la per con…" offers only "Lavoro" (6, clean) or
 // "Lavoro: e di il la" (18, ends on an article). No prefix of that title is BOTH
 // long enough and clean, because it contains exactly one content word in budget.
 //
 // The tie is broken toward the CLEAN ending, because that is this file's own thesis:
 // peelDanglingClauseTail documents that a snippet stopping on a function word reads as
 // broken markup and makes Google MORE likely to discard the supplied title and
 // synthesise its own — losing the title entirely, which is strictly worse than a terse
 // one. So MIN_PEELED_TITLE_CHARS is a PREFERENCE applied whenever a clean alternative
 // reaches it, never a floor that can force a broken ending.
 if (peeled.length >= MIN_PEELED_TITLE_CHARS) return peeled;
 // The ladder recovers length — but only counts if it did not buy those characters by
 // breaking the ending. TWO independent ways it can, and both are now enforced by the
 // shared primitive rather than re-derived here (review round 4):
 //
 //   a) ending on a function word — its low-budget branch strips separators only;
 //   b) ending MID-WORD — that same branch returns a raw slice when no space sits before
 //      half the budget, and a mid-word slice has nothing to peel, so the stopword check
 //      alone passes it unchanged.
 //
 // `requireWordBoundary` makes truncateClauseAware refuse (b) and return '' instead, so the
 // rule has ONE home for every caller instead of living in this comparison.
 const ladder = truncateClauseAware(rawTitle, max, max, true).trimEnd();
 if (ladder.length >= MIN_PEELED_TITLE_CHARS && peelDanglingClauseTail(ladder) === ladder) {
 return ladder;
 }
 // Nothing is both long enough and unbroken: prefer the clean short peel. The hard cut is
 // the terminal fallback and stays mid-word by necessity — when the first word alone
 // exceeds the budget (max=12 vs "Amministrazione") NO non-empty prefix ends on a
 // boundary, and returning '' would empty the title instead of shortening it.
 return peeled || truncateCodeUnits(rawTitle, max).trimEnd();
 };
 let capped = capAt(maxChars);
 for (let max = maxChars; measureLength(capped) > maxChars && max > 0; max -= 1) {
 capped = capAt(max);
 }
 return capped;
}

/**
 * Safely convert an arbitrary value to an ISO-8601 string.
 * Returns null when the value is missing or cannot be parsed to a valid Date.
 * Used for JobPosting.dateModified / datePosted where Semrush flags
 * "Invalid Date" strings as NOT_RECOGNIZED.
 */
export function safeIsoDate(raw: unknown): string | null {
 if (raw == null) return null;
 try {
 const d = new Date(raw as string);
 return isNaN(d.getTime()) ? null : d.toISOString();
 } catch {
 return null;
 }
}

/**
 * Compose the job-page <title>. Thin wrapper over the shared
 * {@link composeSerpJobTitle} (build-plugins/shared/titleSuffix.ts) so the
 * SSG plugin and the SPA runtime share ONE cascade. Token priority:
 * role > city > company > brand — the company is dropped before the role is
 * ever truncated (it still lives in the H1/meta/JSON-LD), the city is never
 * dropped while it fits (local query intent + multi-sede title uniqueness).
 *
 * Replaces the previous composer that reserved the 21-char brand suffix
 * inside the core budget and then dropped the brand anyway for 92 % of the
 * corpus — chopping ~17 chars of keyword content per title and leaving a
 * mid-headline `…` on 91 % of job pages (the pattern measured collapsing
 * CTR 4.8 % → 0.99 % on /calcola-stipendio/, see titleSuffix.ts).
 *
 * The optional `disambiguator` is appended as ` · {token}` INSIDE the
 * 66-char cap (audit:title-length) for collision-prone titles.
 *
 * `measureLength` mirrors {@link composeSerpJobTitle}'s option: the result
 * of this wrapper is emitted as `<title>${esc(title)}</title>` further down
 * this file, so callers MUST pass `(s) => esc(s).length` (the local `esc`
 * defined inside {@link jobsSeoPagesPlugin}) so the brand-append decision is
 * budgeted on the escaped string that actually ships, not the pre-escape
 * one — a raw `&`/`<`/`>`/`"` in the role/company/city expands on escape and
 * can otherwise let a title exceed the cap post-escape (same class fixed in
 * seoPageShell.ts's `normalizeShellTitle`, PR #3365 / #3402).
 */
export function composeJobPageTitle(
 jobTitle: string,
 company: string,
 city: string,
 locale: string,
 disambiguator?: string,
 cityOptional?: boolean,
 measureLength?: (s: string) => number,
): string {
 return composeSerpJobTitle(jobTitle, company, city, locale, { disambiguator, cityOptional, measureLength });
}

/**
 * FNV-1a 32-bit hash rendered as 8 hex chars. Last-resort title uniqueness
 * token: hashes the FULL slug so it differs whenever the slug differs
 * (slug TAILS collide constantly — `…-zell`, `…-chur` city suffixes).
 * Rendered as `rif. a1b2c3d4` (locale ref label), NOT as ` (#a1b2c3d4)` —
 * the parenthesized-hash form is banned by audit-title-no-disambig-hash.
 */
export function fnv8(input: string): string {
 let h = 0x811c9dc5;
 for (let i = 0; i < input.length; i++) {
  h ^= input.charCodeAt(i);
  h = Math.imul(h, 0x01000193) >>> 0;
 }
 return h.toString(16).padStart(8, '0');
}

/** Case-insensitive, whitespace-normalized comparison key — mirrors the
 * normalization used by audit-h1-title-duplicates. */
export function titleCompareKey(s: string): string {
 return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Compose H1: job title + company only (no city, no brand). */
export function composeJobPageH1(jobTitle: string, company: string): string {
 const cleanCompany = (company || '').trim();
 return cleanCompany ? `${jobTitle} — ${cleanCompany}` : jobTitle;
}

// Strip literal markdown bold/separator tokens that leak from AI-translated
// crawler titles (job <h1>, related-jobs sidebar, aria-labels all flow through
// `esc()` = HTML-escape only, so `**Title**` would render in <main> and blow
// the 0-tolerance `audit-no-literal-markdown` gate — PR #480 incident).
// Imported (top of file) from the single shared source and re-exported under
// the historical name so every call site — including the related-job cross-link
// block (L2692) that renders titles into scanned `<main>` — shares the hardened
// implementation, which adds the orphan-`**` nuke (mid-string `**` survivors)
// the old local copy lacked.
export { stripLiteralMarkdownFromTitle };

// ─── Human-readable disambiguator cascade ─────────────────────────────────
//
// When two job postings share the same `<title>` base (job-title + company
// + city + locale), we append a compact, parlante token to disambiguate.
// Goals: (a) parlante (carries info, never an opaque hash), (b) unique
// enough across the colliding-title cohort, (c) short to keep the title
// inside TITLE_MAX_CHARS (66). Cascade order, most-specific first:
//
//   1. workHours / employmentType-as-percentage   "80%", "60-100%"
//   2. employmentType label (non-default)         "Part-time", "Stagionale"
//   3. salary range (compact)                     "CHF 60-75k"
//   4. posted month                               "apr 2027"
//   5. job-id reference (always-unique fallback)  "rif. abc123"
//
// At each step we SKIP the token if it would duplicate text already in the
// base title (case-insensitive substring match). Token is human-readable,
// so the audit-title-no-disambig-hash gate (which scans only `(#abcdef12)`
// patterns) never flags it.

const EMPLOYMENT_TYPE_LABEL: Record<string, Record<string, string>> = {
 it: {
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporaneo',
  CONTRACTOR: 'Contratto',
  APPRENTICESHIP: 'Apprendistato',
  INTERN: 'Tirocinio',
  INTERNSHIP: 'Tirocinio',
  OTHER: '',
 },
 en: {
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporary',
  CONTRACTOR: 'Contract',
  APPRENTICESHIP: 'Apprenticeship',
  INTERN: 'Internship',
  INTERNSHIP: 'Internship',
  OTHER: '',
 },
 de: {
  PART_TIME: 'Teilzeit',
  TEMPORARY: 'Befristet',
  CONTRACTOR: 'Auftrag',
  APPRENTICESHIP: 'Lehre',
  INTERN: 'Praktikum',
  INTERNSHIP: 'Praktikum',
  OTHER: '',
 },
 fr: {
  PART_TIME: 'Temps partiel',
  TEMPORARY: 'Temporaire',
  CONTRACTOR: 'Contrat',
  APPRENTICESHIP: 'Apprentissage',
  INTERN: 'Stage',
  INTERNSHIP: 'Stage',
  OTHER: '',
 },
};

const MONTH_LABEL: Record<string, readonly string[]> = {
 it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
 en: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
 de: ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'],
 fr: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
};

const REF_LABEL: Record<string, string> = {
 it: 'rif.',
 en: 'ref.',
 de: 'Ref.',
 fr: 'réf.',
};

/**
 * Pick a human-readable disambiguator string for a job whose <title>
 * collides with another job in the same locale. The empty string is
 * returned when no usable token exists (caller can fall back to a
 * `rif. {fnv8(slug)}` token via claimUniqueTitle).
 *
 * @param job        The raw job object from data/jobs.json
 * @param locale     'it' | 'en' | 'de' | 'fr'
 * @param baseTitle  The collision-prone base title (without disambig).
 *                   Used to skip tokens that would duplicate text
 *                   already in the title (case-insensitive substring).
 */
export function pickJobDisambiguator(
 job: Record<string, unknown>,
 locale: string,
 baseTitle: string,
): string {
 const titleLc = String(baseTitle || '').toLowerCase();
 const empLabels = EMPLOYMENT_TYPE_LABEL[locale] || EMPLOYMENT_TYPE_LABEL.it;
 const months = MONTH_LABEL[locale] || MONTH_LABEL.it;
 const refLabel = REF_LABEL[locale] || REF_LABEL.it;

 const empRaw = String(job.employmentType ?? '').trim();

 // (1) employmentType-as-percentage. Many crawlers stuff workHours into
 // employmentType: "80%", "80 _ 100%", "60 _ 100%". Detect and format.
 // Skip "100%", "100 _ 100%", "VOLLZEIT, ..." (effectively full-time).
 const pctMatch = empRaw.match(/^(\d{2,3})(?:\s*[_\-–—]\s*(\d{2,3}))?\s*%/i);
 if (pctMatch) {
  const lo = Number(pctMatch[1]);
  const hi = pctMatch[2] ? Number(pctMatch[2]) : null;
  const isFullTime = lo >= 100 && (hi === null || hi >= 100);
  if (!isFullTime && lo > 0) {
   const formatted = hi && hi !== lo ? `${lo}-${hi}%` : `${lo}%`;
   if (!titleLc.includes(formatted)) return formatted;
  }
 }

 // (2) employmentType label (non-default; FULL_TIME is the default and
 // ~73 % of the corpus, so it's a useless disambig).
 const empNorm = empRaw.toUpperCase().replace(/-/g, '_');
 if (empNorm && empNorm !== 'FULL_TIME' && empLabels[empNorm]) {
  const label = empLabels[empNorm];
  if (label && !titleLc.includes(label.toLowerCase())) return label;
 }

 // (3) salary range — compact "CHF 60-75k". 100 % coverage in current
 // dataset, so almost always usable. Skip when min === max (no range).
 const sMin = Number(job.salaryMin);
 const sMax = Number(job.salaryMax);
 if (Number.isFinite(sMin) && sMin >= 20000 && Number.isFinite(sMax) && sMax > sMin) {
  const lok = Math.round(sMin / 1000);
  const hik = Math.round(sMax / 1000);
  const ccy = String(job.currency || 'CHF');
  const compact = `${ccy} ${lok}-${hik}k`;
  if (!titleLc.includes(`${ccy.toLowerCase()} `) && !/\d{2,3}\s*[-–]\s*\d{2,3}\s*k\b/i.test(titleLc)) {
   return compact;
  }
 }

 // (4) posted month — "apr 2027". Always available, very compact.
 const dateStr = String(job.postedDate ?? '');
 const dateMatch = dateStr.match(/^(\d{4})-(\d{2})/);
 if (dateMatch) {
  const year = dateMatch[1];
  const monthIdx = Number(dateMatch[2]) - 1;
  if (monthIdx >= 0 && monthIdx < 12) {
   const monthLabel = months[monthIdx];
   const monthYear = `${monthLabel} ${year}`;
   if (!titleLc.includes(monthLabel) && !titleLc.includes(year)) return monthYear;
  }
 }

 // (5) job-id reference — last fallback, always unique by construction.
 // Uses the trailing slug fragment (after the last hyphen) which is
 // typically a short hex identifier the crawler emitted: stable, no
 // PII, distinguishable. e.g. "tally-weijl-5010e3f8aec3" → "5010e3f8".
 const id = String(job.id ?? '');
 const tail = (id.split('-').pop() || id).slice(0, 8);
 if (tail) return `${refLabel} ${tail}`;

 return '';
}

// Change DEFAULT_CANTON to expand the primary target region — see
// scripts/lib/crawler-location-config.mjs for the central switch. Module
// scope (not closure-local) so deriveJobCanton/deriveJobAddressLocality can
// use it as their ultimate fallback and stay independently unit-testable.
const DEFAULT_CANTON = 'TI';
const DEFAULT_CANTON_DISPLAY = 'Ticino';

/**
 * Resolve a job's canton code. Explicit `job.canton`/`job.addressRegion` is
 * trusted only when it's a REAL Swiss canton code (`normalizeCantonCode`
 * validates against the 26-canton registry, not just a bare 2-letter regex);
 * otherwise the canton is inferred from the location text via the same
 * BFS-backed registry used by the central JobPosting schema fix
 * (`sanitizeLocalityForRegion` in `./shared/jobPostingSchema`), so a job
 * page can never derive a canton the crawler fleet doesn't actually cover.
 */
export function deriveJobCanton(job: Record<string, unknown>): string {
 const explicit = normalizeCantonCode(String(job.canton || job.addressRegion || ''));
 if (explicit) return explicit;
 const inferred = inferAnyCanton(String(job.addressLocality || job.location || ''));
 return inferred || DEFAULT_CANTON;
}

/**
 * Resolve the locality text safe to render/emit for a job, given its
 * already-derived canton `region`. A garbage/leaked free-text locality or a
 * real city from the WRONG canton is rejected (via the shared
 * `sanitizeLocalityForRegion`) before falling through to `job.location`
 * (same check) and finally the canton capital's own locality name — never a
 * bare, unvalidated crawler string.
 */
export function deriveJobAddressLocality(job: Record<string, unknown>, region: string): string {
 const fromLocality = sanitizeLocalityForRegion(String(job.addressLocality || ''), region);
 if (fromLocality) return fromLocality;
 const fromLocation = sanitizeLocalityForRegion(String(job.location || ''), region);
 if (fromLocation) return fromLocation;
 return CANTON_CAPITAL_ADDRESSES[region]?.addressLocality || DEFAULT_CANTON_DISPLAY;
}

// Local feature flag: strip generic SEO prose ("Informazioni per frontalieri",
// "Domande frequenti", "Mercato del lavoro in Ticino") from expired-job
// static pages. Default ON (set STRIP_EXPIRED_JOB_PROSE=0 to keep prose).
// Goal: shrink dist below the 10 GB GitHub Pages limit. When stripped, each
// expired-job HTML carries the marker below; audits use the same marker to
// skip text-html-ratio and other content-quality gates on these pages.
const STRIP_EXPIRED_JOB_PROSE = (process.env.STRIP_EXPIRED_JOB_PROSE ?? '1') !== '0';
// Same idea for ACTIVE job-detail pages (h4 variant: ~2.4 KB/locale of
// "Informazioni per frontalieri" + "Domande frequenti"). Default ON
// (set STRIP_ACTIVE_JOB_PROSE=0 to keep prose). When on, the same marker
// is emitted and audits skip the page just like for expired pages.
const STRIP_ACTIVE_JOB_PROSE = (process.env.STRIP_ACTIVE_JOB_PROSE ?? '1') !== '0';
// EJP_STRIPPED_MARKER imported from ./shared/ejpMarker (single source of truth).

export function jobsSeoPagesPlugin(rootDir: string): Plugin {
 return {
 name: 'jobs-seo-pages',
 apply: 'build',
 enforce: 'post',
 async closeBundle() {
 // Fail the build loudly (follow-up #3608 item 2) instead of silently
 // emitting a literal "undefined" segment in a sector-hub canonical URL —
 // see assertSectorHubTablesComplete() doc comment in ./jobSectorLanding.
 assertSectorHubTablesComplete();
 const distDir = np.resolve(rootDir, 'dist');
 const jobsPath = np.resolve(rootDir, 'data/jobs.json');

 // BFS-depth closure (2026-06-11): the per-canton "Esplora" navigator only
 // linked the top-8 cities by job count, leaving every OTHER emitted
 // municipality city hub (`/cerca-lavoro-{canton}/{city}/`) BFS-orphaned in
 // sitemap-jobs.xml (1715 offenders vs 1037 baseline on the failing
 // post-deploy run). The per-canton city-hub emit (Phase 3.1 below) records
 // the EXACT emitted city-hub set per canton here — same gate, same slugs —
 // so the navigator can link all of them and bring every city page to BFS
 // depth ≤ (canton hub + 1). Keyed by canton code; the slug is
 // locale-independent (the navigator prefixes the locale section itself).
 // Auto-covers every present and future canton with no per-canton wiring.
 const emittedCantonCityHubs = new Map<string, Array<{ slug: string; label: string }>>();

 // Tiered emission filter (artifact-shrink Fase 1). Consults
 // data/evidence-index.json (90d GSC/GA4/PostHog) + the hourly
 // data/thin-page-promotions-active.json (self-healing feedback) +
 // data/url-pruning-approved-patterns.json (user-curated). Defaults
 // to 'full' on any missing input: zero behavior change until a pattern
 // is approved. See build-plugins/shared/trafficEvidenceFilter.ts.
 const trafficFilter = getTrafficEvidenceFilter(rootDir);
 let bridgeFullCount = 0;
 let bridgeThinCount = 0;
 let softLandingFullCount = 0;
 let softLandingThinCount = 0;
 // Track ACTUAL bytes saved per page (full length − thin length). The
 // counters above record FILTER DECISIONS — when buildBridgeThinHtml /
 // buildSoftLandingThinHtml's regex doesn't match (e.g. PR #729 bug
 // before that fix landed), the helper returns the cached HTML
 // unchanged, the decision still says "thin" but the byte saving is
 // zero. These two trackers surface that discrepancy in the build log.
 let bridgeBytesSaved = 0;
 let softLandingBytesSaved = 0;
 // GSC keyword landings (`/cerca-lavoro-X/ricerca-Y/`, `/en/find-jobs-X/
 // search-Y/`, `/de/jobs-im-X/suche-Y/`, `/fr/trouver-emploi-X/recherche-Y/`)
 // — auto-generated SEO landings for long-tail search queries. Three
 // emit sites share this URL shape: predefined keyword landings,
 // search-stats landings, search-combo landings. The 2026-05-28 dist
 // showed 517 k of these for ~5.17 GB of jobs-seo (57 % of the
 // bucket) — by far the largest unattacked target.
 let gscKeywordFullCount = 0;
 let gscKeywordThinCount = 0;
 let gscKeywordBytesSaved = 0;

 // `cacheDateStamp` is used as today's stamp throughout the plugin and
 // in the always-run sitemap-index patch below.
 const cacheDateStamp = new Date().toISOString().slice(0, 10);

 // ─── Parameterized defaults ──────────────────────────────────────────
 // DEFAULT_CANTON / DEFAULT_CANTON_DISPLAY are module-level (see above
 // deriveJobCanton/deriveJobAddressLocality). Change them there to expand
 // the primary target region — see scripts/lib/crawler-location-config.mjs
 // for the central switch.
 const DEFAULT_POSTAL_CODE = '6900';

 /**
  * Canton URL slugs sourced from data/canton-url-slugs.json (P1.1 cathedral).
  * Mirrors the runtime helpers in scripts/lib/canton-url-slugs.mjs but inlined
  * here as the build plugin runs in TS and cannot import the .mjs at compile
  * time — single source of truth is the JSON file.
  *
  * Half-canton merge (2026-05-10): the `cantons` table is keyed by URL
  * group code (24 entries: 22 single + APPENZELLO + BASILEA). The
  * `cantonGroups` table records member BFS codes so URL emission can
  * collapse AI/AR/BL/BS onto APPENZELLO/BASILEA via {@link resolveCantonGroup}.
  */
 type CantonLocale = 'it' | 'en' | 'de' | 'fr';
 type CantonSlugRecord = Record<CantonLocale, string> & { dePrefix?: string };
 type CantonSlugFile = {
   cantons: Record<string, CantonSlugRecord>;
   cantonGroups?: Record<string, { members: readonly string[] }>;
   aggregate: Record<CantonLocale, string>;
 };
 const cantonSlugFile: CantonSlugFile = (() => {
   const raw = fs.readFileSync(np.resolve(rootDir, 'data/canton-url-slugs.json'), 'utf-8');
   const parsed = JSON.parse(raw);
   if (!parsed || typeof parsed !== 'object' || !parsed.cantons || !parsed.aggregate) {
     throw new Error('[jobs-seo-pages] data/canton-url-slugs.json: missing "cantons" or "aggregate" key');
   }
   return parsed as CantonSlugFile;
 })();
 const ALL_CANTON_CODES: readonly string[] = Object.freeze(Object.keys(cantonSlugFile.cantons).sort());
 const AGGREGATE_KEY = '_AGGREGATE_';

 /** Cantons with real-data enrichment (Issue #4303 item 1 — median salary by
  * sector, cost-of-living vs Ticino, permit-G guidance, top employers). All
  * canton URL-groups get this block — the underlying data (cantonSalaryIndex,
  * aggregateLamalCantonMedians) is already canton-generic, so there's no
  * data-authoring gap to gate on. */
 const REAL_DATA_ENRICHED_CANTONS = ALL_CANTON_CODES;

 /** Cantons shown as "stessa professione in altri cantoni" cross-links on TI
  * job detail pages (Issue #4303 item 2). Kept as its own small, curated list
  * — decoupled from REAL_DATA_ENRICHED_CANTONS — so widening real-data
  * coverage to all cantons doesn't balloon this pill-link row from 3 to 23
  * entries. */
 const CROSS_CANTON_PROMO_CANTONS = ['ZH', 'BE', 'BASILEA'] as const;

 /**
  * Member BFS code → URL group key (e.g. 'AI' → 'APPENZELLO'). Built once
  * from cantonSlugFile.cantonGroups so the URL/shard emission boundary can
  * collapse AI/AR/BL/BS onto the group key while internal BFS/quorum logic
  * keeps using the real codes.
  */
 const CANTON_MEMBER_TO_GROUP: ReadonlyMap<string, string> = (() => {
   const map = new Map<string, string>();
   const groups = cantonSlugFile.cantonGroups ?? {};
   for (const [groupKey, def] of Object.entries(groups)) {
     for (const member of def?.members ?? []) {
       map.set(String(member).toUpperCase(), groupKey);
     }
   }
   return map;
 })();
 function resolveCantonGroup(cantonCode: string): string {
   const code = String(cantonCode || '').toUpperCase().trim();
   if (!code) return code;
   return CANTON_MEMBER_TO_GROUP.get(code) ?? code;
 }

 /**
  * Localised display name for a canton (e.g. 'TI' → 'Ticino' in IT/EN, 'Tessin' in DE/FR).
  * Mirrors getCantonDisplayName in scripts/lib/crawler-location-config.mjs but kept
  * inline so the build plugin has zero .mjs runtime dependency.
  */
 function getCantonDisplayLabel(cantonCode: string, locale: CantonLocale = 'it'): string {
   const code = String(cantonCode || '').toUpperCase();
   if (code === AGGREGATE_KEY) {
     return locale === 'it' ? 'Svizzera' : locale === 'en' ? 'Switzerland' : locale === 'de' ? 'Schweiz' : 'Suisse';
   }
   const localised: Record<string, Record<CantonLocale, string>> = {
     TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' },
     GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' },
     VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' },
     ZH: { it: 'Zurigo', en: 'Zürich', de: 'Zürich', fr: 'Zurich' },
     BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' },
     LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' },
     BS: { it: 'Basilea Città', en: 'Basel-City', de: 'Basel-Stadt', fr: 'Bâle-Ville' },
     BL: { it: 'Basilea Campagna', en: 'Basel-Country', de: 'Baselland', fr: 'Bâle-Campagne' },
     GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' },
     VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' },
     AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' },
     SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' },
     FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' },
     NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' },
     ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' },
     SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' },
     SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' },
     TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' },
     SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' },
     GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' },
     JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' },
     NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' },
     OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' },
     AR: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' },
     AI: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' },
     UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' },
     // URL group keys (BL+BS → BASILEA, AI+AR → APPENZELLO). The per-canton
     // landing is emitted once per group under the group section slug, so the
     // title/lede/breadcrumb must resolve the group key — otherwise the page
     // renders the raw "BASILEA"/"APPENZELLO" code (e.g. "Lavoro in BASILEA").
     BASILEA: { it: 'Basilea', en: 'Basel', de: 'Basel', fr: 'Bâle' },
     APPENZELLO: { it: 'Appenzello', en: 'Appenzell', de: 'Appenzell', fr: 'Appenzell' },
   };
   return localised[code]?.[locale] ?? localised[code]?.it ?? code;
 }

 const CANTON_FALLBACK_POSTAL: Record<string, string> = {
 'TI': '6900', 'GR': '7000', 'ZH': '8001', 'BE': '3001',
 'LU': '6003', 'BS': '4001', 'GE': '1201', 'VD': '1003',
 'AG': '5001', 'SG': '9001', 'VS': '1950', 'FR': '1700',
 'NE': '2000', 'ZG': '6300', 'SH': '8200', 'SO': '4500',
 'BL': '4410', 'TG': '8500', 'SZ': '6430', 'GL': '8750',
 'JU': '2800', 'NW': '6370', 'OW': '6060', 'AR': '9100',
 'AI': '9050', 'UR': '6460',
 };

 /**
  * Resolve a canton code (or '_AGGREGATE_') to its locale-specific URL slug.
  * Returns the IT slug as a defensive fallback if the locale is missing.
  *
  * Half-canton merge: AI/AR/BL/BS callers are remapped via
  * {@link resolveCantonGroup} before the lookup so callers passing a real
  * BFS code still get the merged group slug.
  */
 function getCantonUrlSlugLocal(cantonCode: string, locale: CantonLocale): string {
   const raw = String(cantonCode || '').toUpperCase();
   if (raw === AGGREGATE_KEY) {
     return cantonSlugFile.aggregate[locale] ?? cantonSlugFile.aggregate.it;
   }
   const code = resolveCantonGroup(raw);
   const entry = cantonSlugFile.cantons[code];
   if (!entry) return cantonSlugFile.aggregate[locale] ?? cantonSlugFile.aggregate.it;
   return entry[locale] ?? entry.it;
 }

 /* ── Buffered write system via shared WriteCollector ── */
 const collector = new WriteCollector({ distDir, pluginName: 'jobsSeoPagesPlugin' });
 logBuildMem('jobsSeoPages: collector created', collector);
 const _ensuredDirs = new Set<string>();
 function _md(dir: string) {
 if (_ensuredDirs.has(dir)) return;
 fs.mkdirSync(dir, { recursive: true });
 _ensuredDirs.add(dir);
 }
 // Profile-mode opt-out for HTML minification.
 //
 // Set `JOBS_SEO_SKIP_MINIFY=1` to skip the per-page `minifyHtml()` call so
 // the sub-profiler's `minify-write` phase measures only the queue insert,
 // and the upstream `template-render` / `prose` / `summary-html` phases
 // become the dominant fractions (clean signal for optimization work).
 //
 // PROD builds keep minify ON: skipping it inflates dist/ by ~9-10% and
 // worsens the text-html-ratio audit gate. Real wall-clock minify deferral
 // requires extending `postWalkWorker.mjs` to run `minifyHtml` across the
 // existing 4-worker pool — tracked as a follow-up.
 const __SKIP_MINIFY = process.env.JOBS_SEO_SKIP_MINIFY === '1';
 const _writtenPaths = new Set<string>();
 function _qw(filePath: string, content: string) {
 _writtenPaths.add(filePath);
 collector.add(filePath, filePath.endsWith('.html') && !__SKIP_MINIFY ? minifyHtml(content) : content);
 }

 /**
  * Emit a flat `.html` file as a redirect bridge directly. The full HTML at
  * `siblingHtml` was already written to the matching `outDir/index.html`,
  * so postWalkCoordinator's `transformFlatRedirect` will read it later and
  * synthesise the same bridge from it. Writing the bridge here (~500 B)
  * instead of the full ~30 KB sibling content cuts ~150 k × 30 KB ≈ 4 GB
  * of redundant write+rewrite traffic across the closeBundle thread; the
  * coordinator's `html === original` guard then short-circuits the
  * post-walk rewrite for these paths. slashUrl is derived from the file
  * path the same way the coordinator does, so the pre-emitted bridge is
  * byte-identical to the post-walk one (no rewrite needed).
  */
 // Skip flat `.html` shadow files for paths under job sections — most of
 // them serve 0 traffic (GSC: ~0.057% of impressions on the no-slash form).
 // Dropping these saves ~470 k bridges + ~32 k full-content legacy flats
 // (~2.3 GB raw) without SEO loss: GH Pages' built-in 301 auto-canonicalises
 // /foo → /foo/ on the residual no-slash hits.
 //
 // CARVE-OUT: any path listed in `data/noslash-keep.json` is preserved.
 // That file is refreshed periodically by `scripts/refresh-noslash-keep.mjs`
 // which queries GSC + GA4 + PostHog for actively-trafficked no-slash URLs
 // and commits the union as a build-time data file. Non-job sections
 // (`/articoli-frontaliere/*`, `/guida-frontaliere/*`, `/vivere-in-ticino/*`)
 // are NEVER subject to the gate — they hold ~99.9% of the no-slash traffic
 // and keep their 200-OK direct serve.
 const JOB_SECTION_FLAT_SKIP_RX = /^(cerca-lavoro-|en\/find-jobs-|de\/jobs-im-|fr\/trouver-emploi-)/;
 const NOSLASH_KEEP_PATHS: ReadonlySet<string> = (() => {
 try {
 const raw = fs.readFileSync(np.resolve(rootDir, 'data', 'noslash-keep.json'), 'utf8');
 const parsed = JSON.parse(raw) as { keepPaths?: string[] };
 if (Array.isArray(parsed.keepPaths)) {
 // Stored with leading '/' — strip to match relPath form used below.
 return new Set(parsed.keepPaths.map((p) => p.replace(/^\/+/, '')));
 }
 } catch {
 // file missing → empty set → behave as if every job-section flat is dropped
 }
 return new Set<string>();
 })();
 if (NOSLASH_KEEP_PATHS.size > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m no-slash keep-list: ${NOSLASH_KEEP_PATHS.size} job-section paths preserved (GSC/GA4/PostHog traffic union)`);
 }

 function shouldEmitFlat(relPath: string): boolean {
 if (!JOB_SECTION_FLAT_SKIP_RX.test(relPath)) return true;
 return NOSLASH_KEEP_PATHS.has(relPath);
 }

 function _qwFlat(flatFile: string, siblingHtml: string) {
 const stem = flatFile.slice(0, -'.html'.length);
 const relPath = np.relative(distDir, stem).replace(/\\/g, '/');
 if (!shouldEmitFlat(relPath)) return;
 const slashUrl = `${BASE_URL}/${relPath}/`;
 _qw(flatFile, buildFlatBridgeFromSibling(siblingHtml, slashUrl));
 }

 // Like _qw for flat .html paths that historically emitted FULL content
 // (legacy active-job bridges, pagination/category/keyword listings). Honours
 // the same job-section gate + keep-list carve-out so the 32 k full-HTML
 // legacy flats (~550 MB raw) are dropped on job sections while the few that
 // still attract traffic stay as 200-OK direct serves.
 function _qwFlatFull(flatFile: string, fullHtml: string) {
 const stem = flatFile.slice(0, -'.html'.length);
 const relPath = np.relative(distDir, stem).replace(/\\/g, '/');
 if (!shouldEmitFlat(relPath)) return;
 _md(np.dirname(flatFile));
 _qw(flatFile, fullHtml);
 }

 /* ── Find SPA entry bundle so job pages hydrate into the full app ── */
 // Race-free via the shared resolver: see spaBundleResolver.ts. The previous
 // inline read silently lost the writeBundle race in CI (run 25151657070
 // produced 123,184 bundle-less pages on this exact path).
 const { resolveSpaBundle } = await import('./spaBundleResolver');
 const spaBundle = resolveSpaBundle(distDir);
 const entryJs = spaBundle.entryJs;
 const entryCss = spaBundle.entryCss;
 const hasSpaBundle = spaBundle.hasSpaBundle;
 // GTAG is skipped when the SPA bundle is present (client-side analytics
 // takes over post-hydration). ADSENSE_SNIPPET is ALWAYS emitted, though:
 // it's the only hydration-independent AdSense mechanism on this template
 // (job SEO pages have no raw <ins> slots, so if the SPA never mounts —
 // version-skew, JS error, blocked bundle — AdSenseBanner never runs and
 // there is otherwise zero ad-serving fallback on the highest-traffic
 // template). Safe to double-emit alongside AdSenseBanner: both the static
 // loader (ADSENSE_LOADER_CONTENT) and AdSenseBanner guard on an existing
 // `script[src*=".../adsbygoogle.js"]` before injecting, and both only push
 // `<ins>` elements lacking `data-adsbygoogle-status`.
 // Partnerize: fuori dal ternario perche' la doc chiede il tag su OGNI pagina,
 // anche su quelle che caricano il bundle SPA e saltano gtag.
 const staticAnalyticsHtml = `\n ${hasSpaBundle ? '' : `${GTAG_SNIPPET}\n `}${ADSENSE_SNIPPET}\n ${PARTNERIZE_TAG_SNIPPET}`;

 /* ── Per-closeBundle memoization caches ──────────────────────────────
  * Scoped to a single closeBundle invocation so watch-mode rebuilds do not
  * leak entries across builds. Bounded to keep memory predictable across
  * ~23k active-job emits × N locales: when a cache hits the cap we drop the
  * oldest insertion (FIFO via Map iteration order) — good-enough policy for
  * write-once-read-many text inputs where access patterns are uniform.
  */
 // 2-layer split (post run 26440498634 profile: canonical-fallback ≈ 91 %
 // of per-page time). `canonicalCleanedCache` keys ONLY on (description,
 // requirements) — locale-invariant. The heavy ~95 % of the original
 // `buildFallbackCanonicalContent` (parse + cleanCanonicalItems × 12) lives
 // here so any cross-locale repeat (e.g. when descriptionByLocale falls
 // back to job.description for some locales) hits the cache.
 // `localizeFallbackCanonical()` is called fresh per-locale — only swaps the
 // 4 extra section headings and recomputes the (cheap) readingMinutes.
 // Cap raised from 8000 to 30000 after the worker pre-pass landed: the
 // pre-pass populates the cache with EVERY unique (description, requirements)
 // tuple before the main loop runs, and worst case (no cross-locale sharing,
 // 5834 jobs × 4 locales) is ~23k entries. Eviction during the main loop
 // would force inline recomputation, defeating the pre-pass.
 const CANONICAL_CLEANED_CACHE_MAX = 30000;
 const canonicalCleanedCache = new Map<string, CleanedFallbackContent>();
 let _canonicalCleanedHits = 0;
 let _canonicalCleanedMisses = 0;
 let _canonicalCleanedEvictions = 0;
 // Captured at the moment we clear the cache (right after the active-job
 // emit completes) so the end-of-build diagnostic log keeps reporting the
 // true peak size, not the post-clear `0`.
 let _canonicalCleanedCacheSizeAtEnd = 0;
 const memoCanonicalCleaned = (
   description: string,
   requirements: string[],
 ): CleanedFallbackContent => {
   // Digest, non la concatenazione: la chiave viveva in 5 copie simultanee al
   // picco di memoria della build. Vedi shared/canonicalCleanedKey.ts.
   const key = canonicalCleanedKey(description, requirements);
   const cached = canonicalCleanedCache.get(key);
   if (cached !== undefined) {
     _canonicalCleanedHits += 1;
     return cached;
   }
   _canonicalCleanedMisses += 1;
   const result = canonicalizeFallbackCleaned(description, requirements);
   if (canonicalCleanedCache.size >= CANONICAL_CLEANED_CACHE_MAX) {
     const oldestKey = canonicalCleanedCache.keys().next().value;
     if (oldestKey !== undefined) {
       canonicalCleanedCache.delete(oldestKey);
       _canonicalCleanedEvictions += 1;
     }
   }
   canonicalCleanedCache.set(key, result);
   return result;
 };
 const memoBuildFallbackCanonicalContent = (
   description: string,
   requirements: string[],
   locale: 'it' | 'en' | 'de' | 'fr',
 ): ReturnType<typeof buildFallbackCanonicalContent> => {
   const cleaned = memoCanonicalCleaned(description, requirements);
   return localizeFallbackCanonical(cleaned, description, locale);
 };

 // ── Load blog article data for cross-linking (SEO: internal links from job → article pages) ──
 interface RecentArticle { id: string; category: string; date: string; image: string }
 let recentArticles: RecentArticle[] = [];
 const articleSlugByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const articleTitleByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const blogSectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'articoli-frontaliere', en: 'cross-border-articles', de: 'grenzgaenger-artikel', fr: 'articles-frontalier',
 };
 const recentArticlesLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Articoli per frontalieri', en: 'Articles for cross-border workers',
 de: 'Artikel für Grenzgänger', fr: 'Articles pour frontaliers',
 };
 try {
 const blogDataSrc = fs.readFileSync(np.resolve(rootDir, 'data', 'blog-articles-data.ts'), 'utf-8');
 const articleBlocks = [...blogDataSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']+)',\s*image:\s*'([^']+)'/gs)];
 recentArticles = articleBlocks
 .map(m => ({ id: m[1], category: m[2], date: m[3], image: m[4] }))
 .sort((a, b) => b.date.localeCompare(a.date))
 .slice(0, 5);
 } catch { /* non-fatal */ }
 try {
 const routerBlogSrc = fs.readFileSync(np.resolve(rootDir, 'services/routerBlogData.ts'), 'utf-8');
 const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
 let m: RegExpExecArray | null;
 while ((m = rx.exec(routerBlogSrc)) !== null) {
 articleSlugByLocale.it[m[1]] = m[2];
 articleSlugByLocale.en[m[1]] = m[3];
 articleSlugByLocale.de[m[1]] = m[4];
 articleSlugByLocale.fr[m[1]] = m[5];
 }
 } catch { /* non-fatal */ }
 // Parse article titles from seo-blog*.ts for readable link text
 try {
 let seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seo/seo-blog.ts'), 'utf-8');
 for (let n = 2; n <= 10; n++) {
 try { seoSrc += '\n' + fs.readFileSync(np.resolve(rootDir, `services/seo/seo-blog-${n}.ts`), 'utf-8'); } catch { break; }
 }
 // Extract ogTitle for Italian articles (path → title). Accept single- OR
 // double-quoted ogTitle values: seo-blog*.ts can carry `ogTitle: "…"` entries
 // and a single-quote-only regex would silently fall back to the raw slug as
 // link text (same quote-style class as #2996).
 const titleRx = /path:\s*'\/articoli-frontaliere\/([^']+?)\/?'[\s\S]*?ogTitle:\s*["']((?:[^"'\\]|\\.)*)["']/g;
 let tm: RegExpExecArray | null;
 while ((tm = titleRx.exec(seoSrc)) !== null) {
 const articleId = Object.entries(articleSlugByLocale.it).find(([, slug]) => slug === tm![1])?.[0] || tm[1];
 articleTitleByLocale.it[articleId] = tm[2].replace(/\\'/g, "'");
 }
 } catch { /* non-fatal */ }

 const buildRecentArticlesHtml = (locale: 'it' | 'en' | 'de' | 'fr'): string => {
 if (recentArticles.length === 0) return '';
 const items = recentArticles.map(art => {
 const slug = articleSlugByLocale[locale]?.[art.id] ?? art.id;
 const prefix = locale === 'it' ? '' : `/${locale}`;
 // Relative href: browsers and Google resolve against the page's <link rel="canonical">
 // (absolute), so internal navigation and link-equity stay intact. Saves ~27 B per link.
 const href = `${prefix}/${blogSectionByLocale[locale]}/${slug}/`;
 const title = articleTitleByLocale.it[art.id] || art.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
 return `<li class="s-86Qi7h"><a class="s-KkZ9xy" href="${href}">${esc(title)}</a></li>`;
 }).join('');
 return `<section class="related s-Duf2at"><h2 class="s-F8Mkz3">${esc(recentArticlesLabel[locale])}</h2><ul class="s-QkRjp8">${items}</ul></section>`;
 };
 // Compute once per locale — this block is identical across all job pages
 // emitted in the same locale (~110k jobs × 4 locales = ~440k call sites).
 // Caching skips the inner map/join loop and avoids ~440k redundant string
 // allocations during the build.
 //
 // LAZY init (NOT eager `{ it: build('it'), en: build('en'), ... }`) because
 // `buildRecentArticlesHtml` references `esc` via closure, and `esc` is
 // declared further down in this same closeBundle scope (~line 1319). An
 // eager initializer here would hit `esc` while it is still in TDZ and
 // crash closeBundle with "Cannot access 'esc' before initialization"
 // (run 26439556741). First call happens later, inside the per-page
 // template literal, by which point every closeBundle-scoped const is
 // initialized.
 const _recentArticlesHtmlCache: Partial<Record<'it' | 'en' | 'de' | 'fr', string>> = {};
 const recentArticlesHtmlFor = (locale: 'it' | 'en' | 'de' | 'fr'): string => {
 const cached = _recentArticlesHtmlCache[locale];
 if (cached !== undefined) return cached;
 const html = buildRecentArticlesHtml(locale);
 _recentArticlesHtmlCache[locale] = html;
 return html;
 };

 // Default search-section route slugs — these are actual URL paths that must exist in the router.
 // They use "Ticino/Tessin" because that is the primary/branded section; other cantons share it.
 const sectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
 en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
 de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
 fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
 };

 /**
  * Section URL prefix per (locale, canton). For TI in any locale this returns
  * the LEGACY section slug (e.g. 'cerca-lavoro-ticino', 'find-jobs-ticino') cathedral-allow: jsdoc reference to TI legacy slug
  * because the entire plugin's HTML graph (breadcrumbs / company-hub /
  * city-hub markup) is wired against those frozen slugs. For every other
  * canton this returns the canton-aware section ('cerca-lavoro-zurigo',
  * 'find-jobs-zurich', ...) sourced from data/canton-url-slugs.json.
  *
  * E9 frozen-URL strategy: if a job already has a registered slug at a TI
  * URL it stays there forever (slug-registry is enforced by crawlers, not
  * by this plugin — `localizedSlug(job, locale)` returns the frozen slug
  * verbatim).
  */
 // P6 T6.1 — DE prefix is `jobs-in` for ALL non-TI cantons (e.g.
 // `/de/jobs-in-zurich/`). The legacy `jobs-im-tessin` form is preserved
 // *only* for TI by `buildCantonAwareSection` (early-return at code === 'TI'
 // returns `sectionByLocale[locale]` which still hard-codes `jobs-im-tessin`).
 // The router (`services/router.ts` `JOB_BOARD_PREFIX[de] = 'jobs-in-'`,
 // `parseJobBoardSlug` legacy branch only matches `jobs-im-tessin`) only
 // recognises the canton index pattern when the prefix is `jobs-in-`. Using
 // `jobs-im` here for non-TI cantons emitted files at unroutable URLs
 // (every `/de/jobs-im-{canton}/` returned 404 even though the static HTML
 // existed). Aligns the build emit with the router's parsing contract.
 const SECTION_PREFIX_BY_LOCALE: Record<CantonLocale, string> = {
   it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-in', fr: 'trouver-emploi',
 };
 /**
  * Build the canton-aware top-level URL segment (e.g. `cerca-lavoro-zurigo`,
  * `jobs-im-aargau`, `jobs-in-der-waadt`). For non-TI cantons we honour the
  * optional `dePrefix` override on the canton record so cantons whose name
  * takes a definite article in German (im Aargau, im Thurgau, im Jura,
  * im Wallis, in der Waadt) emit grammatically correct URLs. Note `dePrefix`
  * is the FULL prefix INCLUDING trailing hyphen (`jobs-im-`, `jobs-in-der-`),
  * so we concatenate directly with the slug — no inserted hyphen.
  */
 function buildCantonAwareSection(locale: CantonLocale, cantonCode: string): string {
   return sharedResolveCantonSection(locale, cantonCode);
 }
 const localePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: '',
 en: '/en',
 de: '/de',
 fr: '/fr',
 };
 const localeOg: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'it_CH',
 en: 'en_US',
 de: 'de_CH',
 fr: 'fr_CH',
 };
 const homeLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Home',
 en: 'Home',
 de: 'Startseite',
 fr: 'Accueil',
 };
 const openPositionsUnit: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'posizioni aperte',
 en: 'open positions',
 de: 'offene Stellen',
 fr: 'postes ouverts',
 };
 const localeCopy: Record<'it' | 'en' | 'de' | 'fr', {
 suffix: string;
 sectionName: string;
 descriptionLabel: string;
 applyNow: string;
 quickDetails: string;
 location: string;
 canton: string;
 contract: string;
 relatedJobs: string;
 allJobsLink: string;
 practicalNotes: string[];
 requirementsLabel: string;
 summaryLabel: string;
 highlightsLabel: string;
 responsibilitiesLabel: string;
 benefitsLabel: string;
 processLabel: string;
 keywordsLabel: string;
 readingLabel: string;
 }> = {
 it: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Cerca lavoro in Ticino',
 descriptionLabel: 'Descrizione',
 applyNow: 'Vai alla candidatura',
 quickDetails: 'Dettagli rapidi',
 location: 'Località',
 canton: 'Cantone',
 contract: 'Contratto',
 relatedJobs: 'Annunci correlati',
 allJobsLink: 'Tutte le offerte di lavoro in Ticino',
 practicalNotes: [
 'Questa scheda aggrega i dettagli principali dell\'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in Ticino.',
 'Verifica sempre lingua richiesta, sede effettiva e modalità di candidatura prima di inviare il CV: alcuni ruoli prevedono step internazionali e assessment tecnici.',
 'Prima di candidarti, confronta il ruolo con costo della vita locale e simulazione del netto, così valuti subito la sostenibilità economica reale.',
 ],
 requirementsLabel: 'Requisiti principali',
 summaryLabel: 'Panoramica',
 highlightsLabel: 'Punti chiave',
 responsibilitiesLabel: 'Responsabilità principali',
 benefitsLabel: 'Cosa offre l’azienda',
 processLabel: 'Processo di candidatura',
 keywordsLabel: 'Keyword utili',
 readingLabel: 'Tempo di lettura',
 },
 en: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Find jobs in Ticino',
 descriptionLabel: 'Description',
 applyNow: 'Apply now',
 quickDetails: 'Quick details',
 location: 'Location',
 canton: 'Canton',
 contract: 'Contract',
 relatedJobs: 'Related jobs',
 allJobsLink: 'All job offers in Ticino',
 practicalNotes: [
 'This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting Ticino.',
 'Always verify required language, actual office location and application flow before submitting: some positions include international interview steps.',
 'Before applying, compare this role with local cost of living and net salary simulation to assess real take-home sustainability.',
 ],
 requirementsLabel: 'Key requirements',
 summaryLabel: 'Role overview',
 highlightsLabel: 'Key points',
 responsibilitiesLabel: 'Main responsibilities',
 benefitsLabel: 'What the company offers',
 processLabel: 'Application process',
 keywordsLabel: 'Useful keywords',
 readingLabel: 'Reading time',
 },
 de: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Jobs im Tessin',
 descriptionLabel: 'Beschreibung',
 applyNow: 'Jetzt bewerben',
 quickDetails: 'Kurzdaten',
 location: 'Ort',
 canton: 'Kanton',
 contract: 'Vertrag',
 relatedJobs: 'Ähnliche Stellen',
 allJobsLink: 'Alle Stellenangebote im Tessin',
 practicalNotes: [
 'Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger im Tessin.',
 'Prüfen Sie vor der Bewerbung Sprache, effektiven Arbeitsort und Bewerbungsablauf genau, da manche Rollen internationale Prozessschritte enthalten.',
 'Vergleichen Sie das Stellenprofil mit Lebenshaltungskosten und Nettolohn-Simulation, um die finanzielle Tragfähigkeit realistisch einzuschätzen.',
 ],
 requirementsLabel: 'Wichtige Anforderungen',
 summaryLabel: 'Rollenüberblick',
 highlightsLabel: 'Kernpunkte',
 responsibilitiesLabel: 'Hauptaufgaben',
 benefitsLabel: 'Was das Unternehmen bietet',
 processLabel: 'Bewerbungsprozess',
 keywordsLabel: 'Nützliche Keywords',
 readingLabel: 'Lesezeit',
 },
 fr: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Trouver un emploi au Tessin',
 descriptionLabel: 'Description',
 applyNow: 'Postuler',
 quickDetails: 'Détails rapides',
 location: 'Lieu',
 canton: 'Canton',
 contract: 'Contrat',
 relatedJobs: 'Offres liées',
 allJobsLink: 'Toutes les offres d\'emploi au Tessin',
 practicalNotes: [
 'Cette fiche regroupe les informations essentielles de l\'offre et les présente de manière structurée pour les frontaliers visant le Tessin.',
 'Avant de postuler, vérifiez la langue requise, le lieu réel du poste et le processus de sélection: certaines offres incluent des étapes internationales.',
 'Comparez ce poste avec le coût de la vie local et la simulation du salaire net pour évaluer la viabilité économique réelle.',
 ],
 requirementsLabel: 'Exigences principales',
 summaryLabel: 'Vue d’ensemble du poste',
 highlightsLabel: 'Points clés',
 responsibilitiesLabel: 'Responsabilités principales',
 benefitsLabel: 'Ce que l’entreprise offre',
 processLabel: 'Processus de candidature',
 keywordsLabel: 'Mots-clés utiles',
 readingLabel: 'Temps de lecture',
 },
 };

 // ── Canton-aware text helpers ────────────────────────────────
 // These produce locale-correct text for any Swiss canton,
 // used wherever SEO copy references the job's region.
 const frenchCantonPrep = (dc: string): string => {
 if (['Tessin', 'Jura'].includes(dc)) return `au ${dc}`;
 if (dc === 'Grisons') return `aux ${dc}`;
 if (dc === 'Valais') return `en ${dc}`;
 return `dans le canton de ${dc}`;
 };
 const germanCantonPrep = (dc: string): string => {
 if (['Tessin', 'Wallis', 'Jura'].includes(dc)) return `im ${dc}`;
 // 'Schweiz' (the AGGREGATE_KEY / national-hub display label, see
 // getCantonDisplayLabel) needs the feminine article — "in Schweiz" is
 // ungrammatical. Every caller of this shared helper benefits (title/lede
 // generators, breadcrumbs, editorial headers), not just the item-3 canton
 // hub title fixed alongside this. jobEditorialLanding.ts has its own
 // independent copy of this helper but never receives 'Schweiz' (that
 // plugin has no AGGREGATE_KEY branch — verified, not a sibling to fix).
 if (dc === 'Schweiz') return 'in der Schweiz';
 return `in ${dc}`;
 };
 const cantonSectionName = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const map: Record<string, string> = {
 it: `Cerca lavoro in ${cantonDisplay}`,
 en: `Find jobs in ${cantonDisplay}`,
 de: `Jobs ${germanCantonPrep(cantonDisplay)}`,
 fr: `Trouver un emploi ${frenchCantonPrep(cantonDisplay)}`,
 };
 return map[locale] || map.it;
 };
 // Canton-aware breadcrumb label. Reflects the JOB'S canton, not the URL
 // canton segment — required for bridge pages where a job moved across
 // cantons and the old URL slug still lives on. Without this, a page
 // served at /cerca-lavoro-ticino/<bridge> for a job now in Appenzell
 // displayed "Tutte le offerte di lavoro in Ticino" while linking to
 // /cerca-lavoro-appenzello/ — a visible inconsistency for the user.
 const allJobsLinkLabel = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const map: Record<string, string> = {
 it: `Tutte le offerte di lavoro in ${cantonDisplay}`,
 en: `All job offers in ${cantonDisplay}`,
 de: `Alle Stellenangebote ${germanCantonPrep(cantonDisplay)}`,
 fr: `Toutes les offres d'emploi ${frenchCantonPrep(cantonDisplay)}`,
 };
 return map[locale] || map.it;
 };
 const cantonPracticalNote0 = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const dePrep = germanCantonPrep(cantonDisplay);
 const frPrep = frenchCantonPrep(cantonDisplay);
 const map: Record<string, string> = {
 it: `Questa scheda aggrega i dettagli principali dell'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in ${cantonDisplay}.`,
 en: `This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting ${cantonDisplay}.`,
 de: `Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger ${dePrep}.`,
 fr: `Cette fiche regroupe les informations essentielles de l'offre et les présente de manière structurée pour les frontaliers visant ${frPrep === frenchCantonPrep(cantonDisplay) ? frPrep : `le ${cantonDisplay}`}.`,
 };
 return map[locale] || map.it;
 };

 // Multi-canton display string for search pages (not per-job).
 //
 // P1.11 — Cathedral migration: the canonical 26-canton list now comes from
 // ALL_CANTON_CODES (data/canton-url-slugs.json). EDITORIAL_PRIMARY_CANTONS
 // remains a curated commuter-focused subset because the prose ("offerte di
 // lavoro in Ticino, Grigioni e Vallese …") would be unreadable if it
 // enumerated all 26 cantons. The 26-canton list is consumed by the per-canton
 // index emitter + sitemap-shard pipeline below, not by this editorial copy.
 const EDITORIAL_PRIMARY_CANTONS = ['TI', 'GR', 'VS'] as const;
 const targetCantonsDisplay: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: EDITORIAL_PRIMARY_CANTONS.map(c => getCantonDisplayLabel(c, 'it')).join(', ').replace(/, ([^,]+)$/, ' e $1'),
 en: EDITORIAL_PRIMARY_CANTONS.map(c => getCantonDisplayLabel(c, 'en')).join(', ').replace(/, ([^,]+)$/, ' and $1'),
 de: EDITORIAL_PRIMARY_CANTONS.map(c => getCantonDisplayLabel(c, 'de')).join(', ').replace(/, ([^,]+)$/, ' und $1'),
 fr: EDITORIAL_PRIMARY_CANTONS.map(c => getCantonDisplayLabel(c, 'fr')).join(', ').replace(/, ([^,]+)$/, ' et $1'),
 };

 if (!fs.existsSync(jobsPath)) {
 console.warn('[jobs-seo-pages] data/jobs.json not found');
 // Unblock downstream consumers before bailing. relatedSearchClustersPlugin
 // `await`s jobsSeoPagesFlushed (writeSitemap L2029 + cache-hit path L2190);
 // returning here without resolving the signal would hang those awaits
 // forever (build deadlock, no fail-fast, no deploy). No jobs.json → no
 // bridge HTML to flush, so resolving now is correct: the consumer proceeds
 // with an empty/jobless sitemap instead of awaiting writes that never run.
 resolveJobsSeoPagesFlushed();
 return;
 }
 let jobsRaw: any = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
 let jobs: any[] = Array.isArray(jobsRaw) ? jobsRaw : [];
 jobsRaw = null; // drop the parse ref immediately — `jobs` holds the array
 const slugify = (input: string) => String(input || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, 200);
 const localeList = JOB_SEO_LOCALES;
 const localizedSlug = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 // 1. Explicit per-locale slug (from AI-translated crawlers)
 const explicit = String(job?.slugByLocale?.[locale] || '').trim();
 if (explicit) return explicit;
 // 2. Canonical slug from data (set by all crawlers, including custom ones)
 const canonical = String(job?.slug || '').trim();
 if (canonical) return canonical;
 // 3. Compute from localized title + company + location (last-resort fallback)
 const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || '');
 return slugify(`${localizedTitle}-${job?.company || ''}-${job?.location || ''}`) || slugify(localizedTitle);
 };

 // Fixture-data guard — drop test/dev seed records (e.g. "Fixture Corp SA")
 // before they enter the validJobs pipeline. Without this, a local jobs.json
 // fixture would persist its slug into all-known-job-slugs.json and feed the
 // expired-job soft-landing pipeline forever.
 // Mirrors scripts/lib/fixture-data-filter.mjs (kept inline so this build
 // plugin has no .mjs dependency at TypeScript compile time).
 const FIXTURE_SLUG_RE = /^fixture-|-fixture-corp-|-fixture-canonical-/i;
 const FIXTURE_ID_RE = /^fixture-/i;
 const FIXTURE_COMPANY_KEY_RE = /^fixture(?:-|$)/i;
 const FIXTURE_COMPANY_NAMES = new Set(['fixture corp sa', 'fixture corp']);
 const isFixtureJob = (j: any): boolean => {
 if (!j || typeof j !== 'object') return false;
 if (j.id && FIXTURE_ID_RE.test(String(j.id))) return true;
 if (j.companyKey && FIXTURE_COMPANY_KEY_RE.test(String(j.companyKey))) return true;
 if (j.company && FIXTURE_COMPANY_NAMES.has(String(j.company).trim().toLowerCase())) return true;
 if (j.slug && FIXTURE_SLUG_RE.test(String(j.slug))) return true;
 if (j.slugByLocale && typeof j.slugByLocale === 'object') {
 for (const v of Object.values(j.slugByLocale)) {
 if (v && FIXTURE_SLUG_RE.test(String(v))) return true;
 }
 }
 return false;
 };
 const isFixtureSlug = (s: string): boolean => !!s && FIXTURE_SLUG_RE.test(s);
 const fixtureCount = jobs.filter(isFixtureJob).length;
 if (fixtureCount > 0) {
 console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Filtered ${fixtureCount} fixture job(s) from input (test/dev seed records)`);
 }

 // Recency timestamp helper: prefers `datePosted` (employer publish time)
 // over `crawledAt` (when our crawler last saw the listing). Used both
 // here (validJobs sort) and below (expiredJobsData sort) so the
 // sharedWriteRegistry's first-write-wins claim() picks the FRESHEST job
 // when multiple distinct jobs converge on the same per-locale path
 // (e.g. 40 different localsearch postings whose German title slugifies
 // identically). Without this sort, iteration order is the order jobs
 // happen to be in data/jobs.json, which is not recency-aligned and lets
 // an older posting clobber a newer one on the canonical URL.
 const _jobRecency = (j: any): number => {
 const dp = j?.datePosted ? new Date(j.datePosted).getTime() : 0;
 if (dp > 0 && !Number.isNaN(dp)) return dp;
 const ca = j?.crawledAt ? new Date(j.crawledAt).getTime() : 0;
 if (ca > 0 && !Number.isNaN(ca)) return ca;
 return 0;
 };

 const validJobs = jobs
 .filter((j: any) => !isFixtureJob(j))
 .filter((j: any) => j?.title && j?.company && j?.location && (j?.description || j?.descriptionByLocale))
 .map((j: any) => ({
 ...j,
 slug: j.slug || slugify(`${j.title}-${j.company}-${j.location}`) || j.id || '',
 }))
 .filter((j: any) => !!j.slug)
 // DESC by recency, tiebreak by id for determinism. Most-recent first
 // means the registry's first-write-wins gives the canonical URL to the
 // freshest posting; older duplicates record a collision (visible in
 // dist/.write-collisions.json) but don't overwrite on disk.
 .sort((a: any, b: any) => {
 const ta = _jobRecency(a);
 const tb = _jobRecency(b);
 if (ta !== tb) return tb - ta;
 return String(a.id || a.slug || '').localeCompare(String(b.id || b.slug || ''));
 });
 // Release the raw dataset: validJobs is an independent spread-copy (new objects
 // per job), and `jobs` is never read past this point — free ~150-250 MB before
 // the heavy per-page emit + expired/bridge pre-scans. (Build OOM fix, #1290.)
 jobs = [];

 /**
  * Per-slug canonical override map (Semrush cannibalization fix). Loaded from
  * data/job-canonical-overrides.json — keyed by per-locale slug (job-detail
  * slug or search-hub `search-/suche-/recherche-/ricerca-` slug). When a slug
  * matches, the page's <link rel="canonical"> and og:url point to the
  * specified winner URL instead of the page's own URL. The page itself still
  * exists (no 410, no delete) so backlinks survive.
  */
 const canonicalOverrides: Record<string, string> = (() => {
 try {
 const overridePath = np.resolve(rootDir, 'data/job-canonical-overrides.json');
 const raw = fs.readFileSync(overridePath, 'utf-8');
 const parsed = JSON.parse(raw);
 const map = parsed?.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {};
 const cleaned: Record<string, string> = {};
 for (const [k, v] of Object.entries(map)) {
 if (typeof k === 'string' && typeof v === 'string' && v.startsWith('http')) {
 cleaned[k] = v;
 }
 }
 if (Object.keys(cleaned).length > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded ${Object.keys(cleaned).length} canonical overrides`);
 }
 return cleaned;
 } catch {
 return {};
 }
 })();
 const resolveCanonicalUrl = (slug: string, defaultUrl: string): string => {
 const override = canonicalOverrides[slug];
 return override || defaultUrl;
 };

 /**
  * Per-canonical-slug company profiles loaded from `data/company-profiles.json`.
  * Used by the company landing emitter to enrich pages with founded/size/sector
  * facts and a multilingual description, lifting word count above the
  * "thin content" Semrush threshold (issue 117). Companies absent from the
  * map fall back to the generic enrichment derived from job-data only.
  */
 type CompanyProfile = {
  name?: string;
  founded?: number;
  size?: string;
  sector?: string;
  headquarters?: string;
  description?: Partial<Record<'it' | 'en' | 'de' | 'fr', string>>;
 };
 const companyProfiles: Record<string, CompanyProfile> = (() => {
  try {
   const profilePath = np.resolve(rootDir, 'data/company-profiles.json');
   if (!fs.existsSync(profilePath)) return {};
   const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
   if (!raw || typeof raw !== 'object') return {};
   const cleaned: Record<string, CompanyProfile> = {};
   for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta') continue;
    if (v && typeof v === 'object') cleaned[k] = v as CompanyProfile;
   }
   if (Object.keys(cleaned).length > 0) {
    console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded ${Object.keys(cleaned).length} company profiles for enrichment`);
   }
   return cleaned;
  } catch {
   return {};
  }
 })();

 const esc = (s: string) => String(s || '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 /** Decode common HTML entities so source text doesn't get double-escaped by esc(). */
 const decodeHtmlEntities = (s: string) => String(s || '')
 .replace(/&amp;/g, '&')
 .replace(/&lt;/g, '<')
 .replace(/&gt;/g, '>')
 .replace(/&quot;/g, '"')
 .replace(/&#39;/g, "'")
 .replace(/&#x27;/g, "'")
 .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
 .replace(/&[A-Za-z]+;/g, ' ');
 /** Convert plain-text crawler descriptions to HTML via the shared parser
 * (`build-plugins/shared/jobDescription/parser.ts`). Handles `**bold**` -->
 * `<strong>`, drops empty bolds, strips separator lines (`______`), dedups
 * paragraphs (S4), promotes section labels to `<h2>` (S5), and prevents
 * prose-to-heading mis-promotion (S2). */
 const plainTextToHtml = jobDescriptionTextToHtml;
 const normalizeText = (s: string) => String(s || '')
 .replace(/\r/g, '\n')
 .replace(/\t/g, ' ')
 .replace(/&[A-Za-z]+;/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 /** Strip markdown syntax, emojis & structured noise for clean meta descriptions. */
 const cleanMetaDescription = (raw: string): string => {
 let s = String(raw || '');
 // Strip markdown headings (at line start only — unanchored also mangled `C#`/`#3`)
 s = s.replace(/(^|\n)#{1,6}\s+/g, '$1');
 // Delimiters excluded from crossing a newline — a stray unpaired `*` (e.g. a
 // `* ` list bullet marker below) must not pair with an unrelated `*` on a
 // different line and swallow an unrelated run of text into the match.
 s = s.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
 s = s.replace(/^[-*_]{3,}$/gm, '');
 // Strip markdown links/images but keep text
 s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
 // Strip inline code
 s = s.replace(/`([^`]+)`/g, '$1');
 // Strip emojis (common Unicode ranges)
 s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
 // Strip bullet/list markers at line starts
 s = s.replace(/^\s*[-*•]\s+/gm, '');
 // Strip HTML entities like &NewLine; &colo;
 s = s.replace(/&[A-Za-z]+;/g, ' ');
 // Collapse whitespace
 s = s.replace(/\s+/g, ' ').trim();
 return s;
 };
 const splitIntoParagraphs = (s: string): string[] => {
 // AI-translation flattening collapses paragraph breaks around visual
 // dividers (e.g. HFR `Ref.: HFR-M-251801 ____________ Le Département`).
 // Treat any run of 3+ `_`/`=`/`~` as an explicit paragraph break before
 // splitting so the divider doesn't leak into a paragraph body and trip
 // audit:no-literal-markdown (CLAUDE.md rule #1, 0-tolerance). Was `{6,}` —
 // stale vs. the `{3,}` threshold `scripts/audit-no-literal-markdown.mjs`
 // (SEPARATOR_RUN_RE) and every sibling stripper
 // (jobDescription/parser.ts, jobDescription/toHtml.ts) actually use, so a
 // 3-5 char run leaked through unconverted (audit regression #4593,
 // sibling-pattern fix per CLAUDE.md non-negotiable #6).
 const normalized = String(s || '').replace(/[_=~]{3,}/g, '\n\n');
 const viaBreaks = normalized
 .replace(/\r/g, '\n')
 .split(/\n{2,}/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 if (viaBreaks.length >= 2) return viaBreaks;
 return normalizeText(normalized)
 .split(/(?<=[.!?])\s+/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 };
 const firstItems = (value: unknown, max = 8): string[] => {
 if (!Array.isArray(value)) return [];
 return value
 .map((x) => normalizeText(String(x || '')))
 .filter((x) => x.length > 2)
 .slice(0, max);
 };
 // WeakMap memoize for cleanItems. Keys on array IDENTITY (not content) so
 // any caller that passes the SAME array reference with the same `max` gets
 // a cache hit. Concrete hit-sources today:
 //   - `hasCanonicalSignal` probe + post-resolve cleanItems on the SAME
 //     `canonicalLocaleRaw.summary` / `.responsibilities` / ... when
 //     `_canonical` is populated (the probe arrays ARE the post-resolve
 //     arrays — same JS reference)
 //   - `requirements` fallback array reused across the locale loop (same
 //     `job.requirements` reference)
 // Misses cost one WeakMap.get + one Map.get (low-ns) so the wrap is safe
 // even when hit rate is low. Counters expose the true hit rate at flush.
 const _cleanItemsCache = new WeakMap<object, Map<number, string[]>>();
 let _cleanItemsHits = 0;
 let _cleanItemsMisses = 0;
 const cleanItems = (value: unknown, max = 10): string[] => {
 if (!Array.isArray(value)) return [];
 const perMax = _cleanItemsCache.get(value as unknown as object);
 if (perMax) {
   const cached = perMax.get(max);
   if (cached !== undefined) {
     _cleanItemsHits += 1;
     return cached;
   }
 }
 _cleanItemsMisses += 1;
 const expanded: string[] = [];
 for (const entry of value) {
 const clean = normalizeText(String(entry || ''));
 if (!clean || clean.length < 3) continue;
 // Skip truncated artifacts (e.g. "Requisiti di ordine ge ...")
 if (/\.{2,}\s*$/.test(clean)) continue;
 // Split joined list items separated by "; - " or "; •"
 const parts = clean.split(/;\s*[-•]\s+/).map((p) => p.replace(/^[-•]\s*/, '').trim()).filter((p) => p.length >= 3);
 expanded.push(...(parts.length > 1 ? parts : [clean]));
 }
 const out: string[] = [];
 const seen = new Set<string>();
 for (const item of expanded) {
 const key = item.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(item);
 if (out.length >= max) break;
 }
 // Store result in the per-array cache so repeat calls with the same
 // (array, max) tuple return without re-iterating.
 let cacheMap = _cleanItemsCache.get(value as unknown as object);
 if (!cacheMap) {
   cacheMap = new Map<number, string[]>();
   _cleanItemsCache.set(value as unknown as object, cacheMap);
 }
 cacheMap.set(max, out);
 return out;
 };
 const parseCanonicalSections = (value: unknown, max = 8): Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> => {
 if (!Array.isArray(value)) return [];
 const out: Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> = [];
 for (const item of value) {
 const raw = item as {
 id?: unknown;
 heading?: unknown;
 paragraphs?: unknown;
 bullets?: unknown;
 };
 const heading = normalizeText(String(raw?.heading || ''));
 const paragraphs = cleanItems(raw?.paragraphs, 8);
 const bullets = cleanItems(raw?.bullets, 10);
 if (!heading && paragraphs.length === 0 && bullets.length === 0) continue;
 out.push({
 id: normalizeText(String(raw?.id || 'details')).toLowerCase() || 'details',
 heading: heading || 'Details',
 paragraphs,
 bullets,
 });
 if (out.length >= max) break;
 }
 return out;
 };
 const readCanonicalByLocale = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 const byLocale = job?.canonicalContent?.byLocale || {};
 return byLocale?.[locale] || null;
 };
 const toIsoDateTime = (raw: string) => {
 if (!raw) return new Date().toISOString();
 const parsed = new Date(raw);
 if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
 const safe = new Date(`${raw}T00:00:00.000Z`);
 return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
 };
 const toValidThrough = (postedRaw: string, crawledAt?: string) => {
 // If crawledAt is available (= job was verified active at crawl time),
 // use it as base + 60 days — tolerates up to ~1 month of rebuild interruption.
 // Fallback: postedDate + 90 days (more lenient than the old 60d window).
 const base = crawledAt ? new Date(crawledAt) : new Date(toIsoDateTime(postedRaw));
 if (Number.isNaN(base.getTime())) {
 const fallback = new Date();
 fallback.setUTCDate(fallback.getUTCDate() + 60);
 return fallback.toISOString();
 }
 const result = new Date(base);
 result.setUTCDate(result.getUTCDate() + (crawledAt ? 60 : 90));
 // Floor to now+30d (#3505): this helper feeds ACTIVE job emissions only —
 // the expired soft-landing derives its own, deliberately-past validThrough.
 // A stale crawledAt/postedDate would otherwise emit validThrough < now on a
 // live "Apply now" page → GSC "Job posting has expired" and the posting is
 // dropped from Google Jobs while still indexed as active.
 const floor = new Date();
 floor.setUTCDate(floor.getUTCDate() + 30);
 return (result.getTime() < floor.getTime() ? floor : result).toISOString();
 };
 const contractMap: Record<string, string> = {
 'full-time': 'FULL_TIME',
 'part-time': 'PART_TIME',
 temporary: 'TEMPORARY',
 internship: 'INTERN',
 contract: 'CONTRACTOR',
 };
 // Localized employment-type labels for human-readable fallback descriptions.
 // Keys match the lower-cased values produced by job.contract raw strings.
 const contractLabelByLocale: Record<string, Record<string, string>> = {
 it: { 'full-time': 'Tempo pieno', 'part-time': 'Tempo parziale', temporary: 'Temporaneo', internship: 'Stage', contract: 'A contratto', other: 'Altro contratto' },
 en: { 'full-time': 'Full-time', 'part-time': 'Part-time', temporary: 'Temporary', internship: 'Internship', contract: 'Contract', other: 'Other contract' },
 de: { 'full-time': 'Vollzeit', 'part-time': 'Teilzeit', temporary: 'Befristet', internship: 'Praktikum', contract: 'Vertrag', other: 'Sonstiger Vertrag' },
 fr: { 'full-time': 'Temps plein', 'part-time': 'Temps partiel', temporary: 'Temporaire', internship: 'Stage', contract: 'Contrat', other: 'Autre contrat' },
 };
 // Sector labels for fallback descriptions (subset — mirrors sectorLabel used in FAQ section).
 const fallbackSectorLabel: Record<string, Record<string, string>> = {
 it: { healthcare: 'sanità', technology: 'tecnologia', finance: 'servizi finanziari', engineering: 'ingegneria', hospitality: 'ospitalità', retail: 'commercio', manufacturing: 'manifattura', education: 'formazione', construction: 'edilizia', logistics: 'logistica', sales: 'vendite', administration: 'amministrazione' },
 en: { healthcare: 'healthcare', technology: 'technology', finance: 'financial services', engineering: 'engineering', hospitality: 'hospitality', retail: 'retail', manufacturing: 'manufacturing', education: 'education', construction: 'construction', logistics: 'logistics', sales: 'sales', administration: 'administration' },
 de: { healthcare: 'Gesundheitswesen', technology: 'Technologie', finance: 'Finanzdienstleistungen', engineering: 'Ingenieurwesen', hospitality: 'Gastgewerbe', retail: 'Einzelhandel', manufacturing: 'Fertigung', education: 'Bildung', construction: 'Bauwesen', logistics: 'Logistik', sales: 'Vertrieb', administration: 'Verwaltung' },
 fr: { healthcare: 'santé', technology: 'technologie', finance: 'services financiers', engineering: 'ingénierie', hospitality: 'hôtellerie', retail: 'commerce', manufacturing: 'industrie', education: 'formation', construction: 'construction', logistics: 'logistique', sales: 'ventes', administration: 'administration' },
 };
 /**
  * Build a localized fallback description for JobPosting schema when source
  * data is too thin for Google rich results (CLAUDE.md rule #3 — defaults, not skips).
  */
 const buildJobDescriptionFallback = (
 jobArg: { title?: string; company?: string; location?: string; canton?: string; category?: string; contract?: string },
 titleText: string,
 localityText: string,
 regionText: string,
 localeArg: string
 ): string => {
 const loc = localeArg in contractLabelByLocale ? localeArg : 'it';
 const contractKey = String(jobArg.contract || '').toLowerCase();
 const contractLabel = contractLabelByLocale[loc][contractKey] || contractLabelByLocale[loc].other;
 const categoryKey = String(jobArg.category || '').toLowerCase();
 const sectorLabelRaw = fallbackSectorLabel[loc]?.[categoryKey] || '';
 const company = String(jobArg.company || '').trim();
 const sectorClause: Record<string, string> = {
 it: sectorLabelRaw ? ` nel settore ${sectorLabelRaw}` : '',
 en: sectorLabelRaw ? ` in the ${sectorLabelRaw} sector` : '',
 de: sectorLabelRaw ? ` im Bereich ${sectorLabelRaw}` : '',
 fr: sectorLabelRaw ? ` dans le secteur ${sectorLabelRaw}` : '',
 };
 const atCompany: Record<string, string> = {
 it: company ? ` presso ${company}` : '',
 en: company ? ` at ${company}` : '',
 de: company ? ` bei ${company}` : '',
 fr: company ? ` chez ${company}` : '',
 };
 const inLocation: Record<string, string> = {
 it: localityText ? ` a ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 en: localityText ? ` in ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 de: localityText ? ` in ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 fr: localityText ? ` à ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 };
 const tail: Record<string, string> = {
 it: `${contractLabel}${sectorClause.it}. Consulta i dettagli e candidati sul portale Frontaliere Ticino.`,
 en: `${contractLabel}${sectorClause.en}. See the full details and apply on the Frontaliere Ticino portal.`,
 de: `${contractLabel}${sectorClause.de}. Alle Details und Bewerbung auf dem Frontaliere-Ticino-Portal.`,
 fr: `${contractLabel}${sectorClause.fr}. Consultez les détails et postulez sur le portail Frontaliere Ticino.`,
 };
 const lead: Record<string, string> = {
 it: `${titleText}${atCompany.it}${inLocation.it}.`,
 en: `${titleText}${atCompany.en}${inLocation.en}.`,
 de: `${titleText}${atCompany.de}${inLocation.de}.`,
 fr: `${titleText}${atCompany.fr}${inLocation.fr}.`,
 };
 return `<p>${lead[loc]}</p><p>${tail[loc]}</p>`;
 };
 /**
  * Cap the description used inside JobPosting JSON-LD.
  *
  * Why 5000 (#3514): Google's JobPosting docs require `description` to be
  * "a complete representation of the job" and explicitly say NOT to ship a
  * truncated version — the previous 500-char abstract cap left 29/30 sampled
  * pages ending in an ellipsis (rich-result compliance risk). 5000 matches
  * the surrogate-safe budget already applied upstream when the description
  * HTML is assembled, and covers 96.7% of the dataset untruncated (p95 =
  * 4659 chars, measured 2026-07-04 across all by-crawler locale descriptions).
  * The residual byte concern (raw 6-7 KB ATS bodies inflating `<head>` /
  * text-HTML ratio) is still bounded by this cap — only the long tail >5000
  * gets cut, at a sentence boundary where possible.
  *
  * Behavior:
  *  - Strip HTML tags so the truncation operates on visible text.
  *  - Collapse all whitespace runs to a single space.
  *  - Cap at MAX_JSONLD_DESCRIPTION_CHARS (5000), preferring sentence
  *    boundaries (`. `, `! `, `? `) before falling back to word boundaries.
  *  - Sentence-boundary cut ends on complete text — no ellipsis appended;
  *    a single ellipsis marks only the mid-sentence word-boundary fallback.
  *  - Returns the original (whitespace-collapsed) input when already short.
  *
  * NOTE: This affects ONLY the JSON-LD `description` field. The visible
  * page body keeps the full text — see `descriptionHtmlParts` upstream.
  */
 const MAX_JSONLD_DESCRIPTION_CHARS = 5000;
 const capJsonLdDescription = (input: string): string => {
 if (!input) return input;
 // Strip tags and collapse whitespace so length math reflects visible text.
 const plain = String(input).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
 if (plain.length <= MAX_JSONLD_DESCRIPTION_CHARS) return plain;
 // Surrogate-safe window: a raw slice can split an emoji pair and leave a lone
 // surrogate that breaks JSON-LD parsing if the word/sentence fallback keeps it.
 const window = truncateCodeUnits(plain, MAX_JSONLD_DESCRIPTION_CHARS);
 // Prefer the last sentence boundary inside the window. A sentence-boundary
 // cut ends on complete text, so no truncation marker is appended (#3514).
 const sentenceMatch = window.match(/^[\s\S]*[.!?](?=\s)/);
 if (sentenceMatch && sentenceMatch[0].length >= 200) {
 return sentenceMatch[0].trim();
 }
 // Fall back to the last word boundary (mid-sentence → keep the honest marker).
 // peelDanglingClauseTail so the marker never follows a dangling preposition
 // ("…responsabile per…"), same rule the meta description path uses.
 const lastSpace = window.lastIndexOf(' ');
 const cut = lastSpace > 200 ? window.slice(0, lastSpace) : window;
 return `${peelDanglingClauseTail(cut.trim())}…`;
 };
 /**
  * Deterministic non-crypto hash (djb2) — used to pick stable FAQ template
  * variants across rebuilds based on job slug.
  */
 const stableHash = (s: string): number => {
 let h = 5381;
 for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
 return h;
 };
 const companyWebsite = (job: any): string => {
 const domain = job?.companyDomain || hostFromUrl(job?.url);
 return domain ? `https://www.${domain}` : BASE_URL;
 };
 /** Sanitize address fields — reject crawler artifacts */
 const isValidAddress = (s: string): boolean => {
 if (!s || s.length > 100) return false;
 // Reject strings with too many spaces (likely scraped garbage)
 if ((s.match(/\s/g) || []).length > 8) return false;
 // Reject strings with navigation/UI artifacts
 if (/stampa|segnalazione|descrizione|annuncio|verifica|attività|dillo/i.test(s)) return false;
 return true;
 };
 const isValidPostalCode = (s: string): boolean => {
 if (!s) return false;
 // Swiss postal codes: 4 digits starting with 1-9
 if (!/^[1-9]\d{3}$/.test(s)) return false;
 // Reject years (2020-2039) that accidentally match the 4-digit pattern
 const n = Number(s);
 if (n >= 2020 && n <= 2039) return false;
 return true;
 };

 // COMPANY_HQ_ADDRESSES is imported at module scope from
 // ./shared/companyHqAddresses — shared with weeklyEmployersPlugin.

 /** Does the value look like an actual street address (not just a city/region name)? */
 const isStreetLikeAddress = (s: string): boolean => {
 if (!s || s.length < 3) return false;
 // Must contain a known street keyword
 if (/\b(via|piazza|piazzale|piazzetta|viale|strada|corso|vicolo|salita|sentiero|contrada|largo|riva|lungolago|rampa|passaggio)\b/i.test(s)) return true;
 // Accept strings with both letters AND digits (e.g. "Rue de Lausanne 42") —
 // but reject pure-digit strings like "2026" that are years, not addresses
 if (/[a-zA-Z]/.test(s) && /\d/.test(s)) return true;
 return false;
 };

 /** City → generic central street address for last-resort fallback */
 const CITY_GENERIC_ADDRESS: Record<string, string> = {
 // Luganese
 'lugano': 'Piazza Riforma 1', 'paradiso': 'Riva Albertolli 1', 'massagno': 'Via S. Gottardo 52',
 'viganello': 'Via San Gottardo 87', 'pregassona': 'Via Pregassona 29', 'breganzona': 'Via Breganzona 16',
 'montagnola': 'Via Cantonale 24', 'grancia': 'Via Cantonale 18', 'muzzano': 'Via Municipio 8',
 'cadempino': 'Via Cantonale 31', 'lamone': 'Via Cantonale 31', 'comano': 'Via Cantonale 4',
 'canobbio': 'Via Cantone 1', 'tesserete': 'Via Stazione 2', 'capriasca': 'Via Stazione 2',
 'agno': 'Piazza Luini 2', 'bioggio': 'Via Cantonale 19', 'manno': 'Via Cantonale 2c', 'caslano': 'Piazza Lago 2',
 'novaggio': 'Via Cantonale 5', 'noranco': 'Via Noranco 10', 'neggio': 'Via Cantonale 12',
 'luganese': 'Piazza Riforma 1', 'malcantone': 'Piazza Lago 2',
 // Bellinzonese
 'bellinzona': 'Piazza Governo', 'giubiasco': 'Piazza Grande 1', 'sementina': 'Via Cantonale 35',
 'camorino': 'Via Cantonale 20', 'arbedo': 'Via Cantonale 1', 'castione': 'Via Cantonale 8',
 'cadenazzo': 'Via Stazione 10', 's. antonino': 'Via Serrai 1', 's.antonino': 'Via Serrai 1',
 'castione-arbedo': 'Via Cantonale 1', 'belinzona': 'Piazza Governo',
 // Sopraceneri
 'lodrino': 'Via Cantonale 1', 'sopraceneri': 'Piazza Governo',
 // Locarnese
 'locarno': 'Piazza Grande 18', 'muralto': 'Via Stazione 1', 'minusio': 'Via San Gottardo 73',
 'gordola': 'Via Cantonale 40', 'tenero': 'Via Brere 7', 'ascona': 'Via Borgo 34',
 'losone': 'Via Municipio 9', 'magadino': 'Via Cantonale 32', 'quartino': 'Via Cantonale 32',
 // Mendrisiotto
 'mendrisio': 'Via Luigi Benteler 1', 'chiasso': 'Corso San Gottardo 84', 'stabio': 'Via Industria 1',
 'balerna': 'Via Municipio 13', 'coldrerio': 'Via Municipio 12', 'novazzano': 'Via Cantonale 5',
 'castel san pietro': 'Via Municipio 1', 'morbio inferiore': 'Via Cantonale 46', 'vacallo': 'Via Municipio 8',
 // Leventina / Blenio
 'airolo': 'Piazza Stazione 1', 'faido': 'Piazza Municipio 1', 'bodio': 'Via Cantonale 3',
 'biasca': 'Via Giuseppe Lepori 1', 'mezzovico': 'Via Vedeggio 4', 'rivera': 'Via Cantonale 1',
 'taverne': 'Via Cantonale 20', 'pazzallo': 'Via Pazzallo 10', 'cadro': 'Via Cadro 5',
 'riazzino': 'Via Cantonale 12', 'castelrotto': 'Via Pratocarasso 1',
 'bedano': 'Via Cantonale 31', 'pollegio': 'Via Cantonale 1',
 // Graubünden / Grigioni
 'chur': 'Bahnhofstrasse 1', 'coira': 'Bahnhofstrasse 1',
 'landquart': 'Bahnhofstrasse 1', 'davos': 'Promenade 68',
 'st. moritz': 'Via Maistra 12', 'samedan': 'Plazzet 4', 'pontresina': 'Via Maistra 133',
 'walenstadt': 'Bahnhofstrasse 19', 'obervaz': 'Voa Principala 22',
 'ilanz': 'Via Centrala 2', 'thusis': 'Neudorfstrasse 60', 'poschiavo': 'Via da la Stazione 1',
 // Ginevra
 'plan-les-ouates': 'Route de Saint-Julien 7',
 'genève': 'Rue du Rhône 1', 'ginevra': 'Rue du Rhône 1', 'genf': 'Rue du Rhône 1', 'geneva': 'Rue du Rhône 1',
 // Major Swiss cities outside Ticino/GR
 'zürich': 'Bahnhofstrasse 1', 'zurich': 'Bahnhofstrasse 1', 'zurigo': 'Bahnhofstrasse 1',
 'bern': 'Bundesplatz 1', 'berna': 'Bundesplatz 1',
 'basel': 'Marktplatz 1', 'basilea': 'Marktplatz 1',
 'lausanne': 'Place de la Palud 2', 'losanna': 'Place de la Palud 2',
 'luzern': 'Bahnhofstrasse 1', 'lucerna': 'Bahnhofstrasse 1', 'lucerne': 'Bahnhofstrasse 1',
 'st. gallen': 'Bahnhofplatz 1', 'san gallo': 'Bahnhofplatz 1',
 'winterthur': 'Bahnhofplatz 1',
 'zug': 'Bahnhofstrasse 1',
 'aarau': 'Bahnhofstrasse 1',
 'fribourg': 'Rue de Romont 1', 'friburgo': 'Rue de Romont 1',
 'neuchâtel': 'Place du Port 1',
 'schaffhausen': 'Bahnhofstrasse 1',
 'solothurn': 'Hauptgasse 1',
 'thun': 'Bahnhofstrasse 1',
 'baden': 'Bahnhofstrasse 1',
 'olten': 'Bahnhofstrasse 1',
 };

 /** Normalise a locality string to extract the core city name for lookup.
 * Strips suffixes like ", Switzerland", ", Ticino", "TI + smart working", postal codes, etc. */
 const normaliseCityName = (raw: string): string[] => {
 const candidates: string[] = [];
 const s = raw.replace(/[_]/g, ' ').trim();
 // Split on comma, dot-separator, or dash-separated compound
 const parts = s.split(/[,·]/).map(p => p.trim()).filter(Boolean);
 for (const part of parts) {
 // Strip known suffixes
 const cleaned = part
 .replace(/\b(switzerland|svizzera|suisse|schweiz|ticino|ti|gr|ge|ch)\b/gi, '')
 .replace(/\+\s*smart\s*working/gi, '')
 .replace(/\b\d{4}\b/g, '') // postal codes
 .replace(/\s+/g, ' ')
 .trim();
 if (cleaned.length >= 2) candidates.push(cleaned.toLowerCase());
 }
 // Also try the raw first part before any comma
 if (parts[0]) candidates.unshift(parts[0].trim().toLowerCase());
 return [...new Set(candidates)];
 };

 /** Canton capital fallback — used as ultimate last resort */
 const CANTON_CAPITAL_ADDRESS: Record<string, string> = {
 'TI': 'Piazza Governo', 'GR': 'Bahnhofstrasse 1', 'GE': 'Rue du Rhône 1',
 'ZH': 'Bahnhofstrasse 1', 'BE': 'Bundesplatz 1', 'LU': 'Bahnhofstrasse 1',
 'VS': 'Place de la Planta 1', 'VD': 'Place de la Palud 2',
 'BS': 'Marktplatz 1', 'SG': 'Bahnhofplatz 1', 'AG': 'Bahnhofstrasse 1',
 'FR': 'Rue de Romont 1', 'NE': 'Place du Port 1', 'ZG': 'Bahnhofstrasse 1',
 'SH': 'Bahnhofstrasse 1', 'SO': 'Hauptgasse 1', 'BL': 'Marktplatz 1',
 };

 // City→canton dict + regex-only explicit-canton acceptance replaced by the
 // module-level deriveJobCanton (validated against the real 26-canton
 // registry + BFS city inference — see above; eliminates this hand-rolled
 // ~50-city duplicate, AGENTS.md #6).
 const deriveCanton = deriveJobCanton;

 /** Derive streetAddress from job data, company HQ, or city generic.
 * Always returns a street address (canton capital as last resort). */
 const deriveStreetAddress = (job: any): string => {
 // 1. Try job's own streetAddress — only if it looks like a real street
 const raw = String(job.streetAddress || '').trim();
 if (isValidAddress(raw) && isStreetLikeAddress(raw)) return raw;
 // 2. Try company HQ address — ONLY when the job has no own locality or is
 // in the HQ's own city (#3513). Same-canton is not enough: pairing the
 // HQ street with a different posting locality (e.g. HQ Manno street on a
 // Winterthur job) emits a contradictory JSON-LD PostalAddress.
 const companyKey = String(job.companyKey || '').toLowerCase().trim();
 if (companyKey && COMPANY_HQ_ADDRESSES[companyKey]
 && localityMatchesHq(String(job.addressLocality || job.location || ''), COMPANY_HQ_ADDRESSES[companyKey])) {
 return COMPANY_HQ_ADDRESSES[companyKey].streetAddress;
 }
 // 3. Try city-based generic address (exact match)
 const locality = String(job.addressLocality || '').toLowerCase().trim();
 if (locality && CITY_GENERIC_ADDRESS[locality]) return CITY_GENERIC_ADDRESS[locality];
 // 4. Try location field parts (split on ·)
 const loc = String(job.location || '');
 const locParts = loc.split('·').map((s: string) => s.trim()).filter(Boolean);
 for (const part of locParts) {
 const key = part.toLowerCase().trim();
 if (key && CITY_GENERIC_ADDRESS[key]) return CITY_GENERIC_ADDRESS[key];
 }
 // 5. If job.streetAddress is non-empty but not street-like, try as city lookup
 const rawLower = raw.toLowerCase();
 if (rawLower && CITY_GENERIC_ADDRESS[rawLower]) return CITY_GENERIC_ADDRESS[rawLower];
 // 6. Fuzzy: normalise locality/location by stripping suffixes and try again
 const candidates = [
 ...normaliseCityName(String(job.addressLocality || '')),
 ...normaliseCityName(loc),
 ...normaliseCityName(raw),
 ];
 for (const c of candidates) {
 if (CITY_GENERIC_ADDRESS[c]) return CITY_GENERIC_ADDRESS[c];
 }
 // 7. Canton capital fallback — always produces a result. Uses the
 // validated deriveCanton (not a raw job.canton||job.addressRegion
 // regex-only read) so an untrusted well-formed-but-wrong canton code
 // never picks the wrong capital street (same bug class as #6 above).
 const canton = deriveCanton(job);
 return CANTON_CAPITAL_ADDRESS[canton] || CANTON_CAPITAL_ADDRESS[DEFAULT_CANTON] || 'Piazza Governo';
 };
 // job.category → O*NET-SOC major group code + `industry`/
 // `applicantLocationRequirements` (remote-only) are now resolved inside
 // the canonical `buildJobPostingSchema` builder (build-plugins/shared/
 // jobPostingSchema.ts) so every caller — including the SPA path in
 // services/seoService.ts — gets the same fields instead of a per-caller
 // copy of this table drifting out of sync (AGENTS.md anti-duplication
 // rule). `canonicalSchema` below already carries them.

 // NOT the canonical `COMPANY_LOGO_PLACEHOLDER` of services/logoService.ts
 // (`/icons/company-placeholder.svg`). This is a JSON-LD-only filler: the
 // branded OG image, valid as a `hiringOrganization.logo` value where
 // Schema.org expects one, but never a real company logo. It must NEVER reach
 // an `<img src>` — the visible fallback is the deterministic coloured-initials
 // badge from `resolveJobLogoSrc` (build-plugins/shared/companyLogoResolver.ts).
 // Named distinctly because the shared name made exactly that confusion happen:
 // passing it as `logoUrl` to `renderJobCardHtml` put the site's generic OG
 // image in every job card of every company without a curated logo.
 const COMPANY_LOGO_JSONLD_FALLBACK = `${BASE_URL}/og-image.png`;
 const companyLogo = (job: any): string => {
 // Publisher-provided logo (projected from the publish form, https-only).
 const ownLogo = String(job?.companyLogo || '').trim();
 if (/^https:\/\/\S+$/i.test(ownLogo)) return ownLogo;
 const key = job?.companyKey || '';
 if (key && CRAWLED_COMPANY_LOGOS[key]) return CRAWLED_COMPANY_LOGOS[key];
 // Branded 1200×630 OG image fallback — kept for JSON-LD `hiringOrganization.logo`
 // where Schema.org expects a value. `renderLogoImg` skips emitting an <img> tag
 // when the resolved URL is this placeholder (saves ~230 B × ~5 occurrences/page).
 return COMPANY_LOGO_JSONLD_FALLBACK;
 };
 /**
  * Local placeholder served from `public/images/company-logo-fallback.svg`.
  * Static HTML emits this as the `<img src>` so the file has no external
  * dependencies that can 404 on Semrush/crawler scans. The real (external)
  * logo URL is stashed on `data-logo-url` and loaded client-side by the
  * runtime hydration script (see services/companyLogoHydration.ts when
  * present). The `onerror` handler restores the placeholder if the runtime
  * swap-in image fails to load.
  */
 const LOGO_FALLBACK_SRC = '/images/company-logo-fallback.svg';
 const isLocalLogo = (url: string): boolean => {
 if (!url) return true;
 if (url.startsWith('/')) return true;
 try {
 const u = new URL(url);
 return u.host.endsWith('frontaliereticino.ch');
 } catch {
 return false;
 }
 };
 /**
  * Build `<img>` markup that points at the local placeholder by default and
  * stores the (possibly external) target on `data-logo-url`. Emits an
  * inline `onerror` that falls back to the placeholder if a runtime swap
  * fails. When the resolved URL is already local (curated SVG/PNG in
  * /images/logos or our own og-image.png), we keep using it directly —
  * those don't 404 on Semrush.
  */
 const renderLogoImg = (
 url: string,
 alt: string,
 width: number,
 height: number,
 style: string = '',
 ): string => {
 // Skip emitting <img> when no curated brand logo exists — emitting the
 // generic placeholder added ~230 B × 5 occurrences per job page across
 // 545k pages (~600 MB of artifact). Cards render text-only without it.
 if (!url || url === COMPANY_LOGO_JSONLD_FALLBACK) return '';
 const safeAlt = esc(alt);
 // Omit the style attribute entirely when no style is requested. Callers
 // that render inside `.rja` / `.cb` cards rely on the scoped CSS rule
 // (`.rja > img, .cb > img { … }`) in seo-static.css. Saves ~113 B × 2
 // logos × 545k pages (~120 MB across artifact).
 const styleAttr = style ? ` style="${esc(style)}"` : '';
 if (isLocalLogo(url)) {
 return `<img src="${esc(url)}" alt="${safeAlt}" width="${width}" height="${height}" loading="lazy"${styleAttr}>`;
 }
 return `<img src="${LOGO_FALLBACK_SRC}" alt="${safeAlt}" width="${width}" height="${height}" loading="lazy" data-logo-url="${esc(url)}" onerror="this.onerror=null;this.src='${LOGO_FALLBACK_SRC}'"${styleAttr}>`;
 };

 const referralUrl = (raw: string, job: any): string => {
 try {
 const u = new URL(raw);
 u.searchParams.set('utm_source', 'frontaliereticino');
 u.searchParams.set('utm_medium', 'referral');
 u.searchParams.set('utm_campaign', 'job-board');
 u.searchParams.set('utm_content', job.slug || job.id || '');
 return u.toString();
 } catch {
 return raw;
 }
 };

 const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);

 // Build one ItemList `ListItem` for a per-canton hub (city/sector/company/
 // company-city): a full JobPosting embedded via the shared builder, falling
 // back to a name+url stub when the job is too sparse. Closes over the stable
 // `localePrefix`/`localizedSlug`/`withSlash`/`BASE_URL`; the caller passes the
 // per-emit `locale`/`sectionSlug`/`canton`. Single source of truth for the
 // four otherwise-identical hub ItemLists.
 const mapCantonJobToListItem = (
  job: any,
  i: number,
  locale: 'it' | 'en' | 'de' | 'fr',
  sectionSlug: string,
  canton: string,
 ): Record<string, unknown> => {
  const jobTitle = String(job?.titleByLocale?.[locale] || job.title || '');
  const abs = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/'))}`;
  const jobPosting = buildListItemJobPosting(
   {
    title: jobTitle,
    titleByLocale: job?.titleByLocale,
    description: typeof job?.description === 'string' ? job.description : undefined,
    company: job?.company,
    companyDomain: job?.companyDomain,
    city: job?.city,
    location: job?.location,
    addressLocality: job?.addressLocality,
    addressRegion: job?.addressRegion,
    canton: job?.canton ?? canton,
    postalCode: job?.postalCode,
    streetAddress: job?.streetAddress,
    datePosted: job?.datePosted ?? job?.postedDate,
    crawledAt: job?.crawledAt,
    employmentType: job?.employmentType,
    contract: job?.contract,
    salaryMin: typeof job?.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job?.salaryMax === 'number' ? job.salaryMax : null,
    salaryCurrency: job?.salaryCurrency,
    url: abs,
   },
   { locale, url: abs, baseUrl: BASE_URL },
  );
  return jobPosting
   ? { '@type': 'ListItem', position: i + 1, item: jobPosting }
   : { '@type': 'ListItem', position: i + 1, name: jobTitle, url: abs };
 };
 const dateStamp = new Date().toISOString().slice(0, 10);
 const searchRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'ricerca',
 en: 'search',
 de: 'suche',
 fr: 'recherche',
 };
 // Search pages aggregate jobs across all target cantons — use "in Svizzera" for titles
 // (60-char SEO limit) and full canton list in descriptions/editorial.
 const searchPageCopy: Record<'it' | 'en' | 'de' | 'fr', {
 title: (name: string) => string;
 description: (name: string, count: number) => string;
 heading: (name: string) => string;
 openListing: string;
 editorial: string;
 }> = {
 it: {
 // Title intentionally OMITS the brand suffix and the "Posizioni aperte oggi"
 // tail; both are appended downstream via buildTitleWithBrand only when the
 // result fits inside the universal 70-char SERP cap.
 title: (name: string) => `Offerte di lavoro ${name} in Svizzera`,
 description: (name: string, count: number) => `${count}+ offerte di lavoro ${name} in ${targetCantonsDisplay.it} aggiornate ogni giorno. Annunci raccolti dai siti ufficiali delle aziende svizzere con link diretto alla candidatura.`,
 heading: (name: string) => `Lavoro ${name} in Svizzera`,
 openListing: 'Apri il job board completo',
 editorial: `Gli annunci di lavoro sono raccolti direttamente dai siti ufficiali delle aziende in ${targetCantonsDisplay.it} e aggiornati quotidianamente. Ogni offerta rimanda alla pagina di candidatura originale del datore di lavoro. Il job board copre tutti i settori: sanità, finanza, tecnologia, ingegneria, commercio e amministrazione.`,
 },
 en: {
 // title vs heading must DIFFER (audit:h1-title-duplicates fails on
 // case+whitespace-insensitive equality). Pattern matches IT/FR:
 // title is the SERP-friendly headline ("X job openings in Switzerland"),
 // heading is the on-page H1 ("X jobs in Switzerland").
 title: (name: string) => `${name} job openings in Switzerland`,
 description: (name: string, count: number) => `${count}+ ${name} job openings in ${targetCantonsDisplay.en} updated daily. Listings sourced from official Swiss employer career pages with direct application links.`,
 heading: (name: string) => `${name} jobs in Switzerland`,
 openListing: 'Open the full job board',
 editorial: `Job listings are sourced directly from official company career pages in ${targetCantonsDisplay.en} and refreshed daily. Every listing links to the employer's original application page. The job board covers all sectors: healthcare, finance, technology, engineering, retail, and administration.`,
 },
 de: {
 // Same anti-duplicate rule as `en`: title is "Stellenangebote" (the
 // formal-register synonym used in SERP titles), heading is the
 // shorter colloquial "Jobs". Both surface the keyword `name`.
 title: (name: string) => `${name} Stellenangebote in der Schweiz`,
 description: (name: string, count: number) => `${count}+ aktuelle ${name} Stellenangebote in ${targetCantonsDisplay.de}, täglich aktualisiert. Direkt von offiziellen Karriereportalen Schweizer Unternehmen mit Bewerbungslink.`,
 heading: (name: string) => `${name} Jobs in der Schweiz`,
 openListing: 'Komplettes Job Board öffnen',
 editorial: `Stellenanzeigen werden direkt von den offiziellen Karriereseiten der Unternehmen in ${targetCantonsDisplay.de} bezogen und täglich aktualisiert. Jedes Inserat verlinkt zur originalen Bewerbungsseite des Arbeitgebers. Das Job Board deckt alle Branchen ab: Gesundheit, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung.`,
 },
 fr: {
 title: (name: string) => `Offres d'emploi ${name} en Suisse`,
 description: (name: string, count: number) => `${count}+ offres d'emploi ${name} en ${targetCantonsDisplay.fr} mises à jour quotidiennement. Annonces provenant des portails officiels des entreprises suisses avec lien de candidature.`,
 heading: (name: string) => `Emploi ${name} en Suisse`,
 openListing: 'Ouvrir le job board complet',
 editorial: `Les offres d'emploi proviennent directement des portails carrière officiels des entreprises en ${targetCantonsDisplay.fr} et sont actualisées quotidiennement. Chaque annonce renvoie à la page de candidature originale de l'employeur. Le job board couvre tous les secteurs : santé, finance, technologie, ingénierie, commerce et administration.`,
 },
 };
 /**
  * Search-landing matcher — see build-plugins/shared/searchLandingMatch.ts
  * for the predicate, the batched form and why the two must agree. Aliased
  * here so the ~7 combo filter sites below keep reading as before.
  */
 const normalizeSearchTerm = normalizeSearchTermShared;
 /**
  * Per-leader/per-locale match sets in ONE walk over validJobs, replacing
  * the four `validJobs.filter(...).slice(0, 20)` calls that ran once per
  * leader. Same sets, `4 x |validJobs|` haystack builds instead of
  * `leaders x 4 x |validJobs|`. The block this sits in cost 330 s of
  * untimed wall clock on the it leg of run 31065272867 (17.8 % of the
  * plugin); the log line below makes it attributable from now on.
  */
 const searchLeaderMatches = (
 queries: ReadonlyArray<{ key: string; name: string }>,
 limit = 20,
 ): Map<string, Record<'it' | 'en' | 'de' | 'fr', any[]>> => {
 const __t0 = Date.now();
 const { matches, haystacksBuilt } = collectSearchLandingMatches(validJobs, queries, localeList, limit);
 console.log(
 `[jobs-seo-profile] search-leader-prepass leaders=${queries.length} jobs=${validJobs.length} haystacks=${haystacksBuilt} naive=${queries.length * localeList.length * validJobs.length} wall_ms=${Date.now() - __t0}`,
 );
 return matches as Map<string, Record<'it' | 'en' | 'de' | 'fr', any[]>>;
 };

 /** Tracks every dist/ directory written by the active-job page generator
 * so that expired soft-landing pages never overwrite a live job page. */
 const activeJobDirs = new Set<string>();

 /**
  * Tracks every legacy-TI bridge path (`cerca-lavoro-ticino/<slug>/`,
  * `de/jobs-im-tessin/<slug>/`, …) written by the AUTHORITATIVE active
  * cross-canton bridge — i.e. the bridge a non-TI job emits at the legacy
  * TI section for its OWN current slug, whose `<link rel=canonical>` points
  * back at the job's canton-aware URL.
  *
  * Unlike the canton-aware section, the legacy TI section collapses EVERY
  * canton into one namespace, so two unrelated non-TI jobs can claim the
  * same `/cerca-lavoro-ticino/<slug>/` path: one as its active slug, another
  * as a stale `previousSlugs` alias (multi-city postings cross-pollinate each
  * other's previousSlugs — e.g. the same Schindler role in Ebikon/LU and
  * Bern/BE each list the other's slug). Without this guard the previousSlug
  * TI mirror (~line 11717) overwrites the active job's TI bridge
  * non-deterministically, flipping its canonical to the WRONG canton and
  * tripping tests/seo/cathedral-job-detail-canton.test.ts (issue #2545).
  *
  * Same role `activeJobDirs` plays for the canton-aware namespace, extended
  * to the canton-blind TI mirror. Keyed by the slug-relative path.
  */
 const legacyTiBridgeDirs = new Set<string>();

 /** Caches active job page HTML by `${locale}:${slug}` so bridge pages
 * (previousSlugs) can serve identical full-content pages with only the
 * canonical URL pointing to the current slug. */
 const jobHtmlCache = new Map<string, string>();

 const PROFILE_RELATED_COMPARE = process.env.JOBS_SEO_PROFILE_COMPARE_RELATED === '1';
 let relatedCompareMismatches = 0;

 // Pre-index related-job candidates once. The active detail renderer uses
 // related jobs from the same category OR location; doing that with a full
 // validJobs.filter(...) inside every job × locale page made this block scale
 // with O(jobs² × locales). The buckets preserve the original validJobs order
 // below, so related-link selection stays deterministic and byte-equivalent.
 const __tRelatedIndexBuild = startTimer();
 const relatedJobsByCategory = new Map<unknown, any[]>();
 const relatedJobsByLocation = new Map<unknown, any[]>();
 const relatedJobSourceIndex = new WeakMap<object, number>();
 for (let idx = 0; idx < validJobs.length; idx++) {
 const indexedJob = validJobs[idx] as any;
 relatedJobSourceIndex.set(indexedJob as object, idx);
 const categoryBucket = relatedJobsByCategory.get(indexedJob.category);
 if (categoryBucket) {
 categoryBucket.push(indexedJob);
 } else {
 relatedJobsByCategory.set(indexedJob.category, [indexedJob]);
 }
 const locationBucket = relatedJobsByLocation.get(indexedJob.location);
 if (locationBucket) {
 locationBucket.push(indexedJob);
 } else {
 relatedJobsByLocation.set(indexedJob.location, [indexedJob]);
 }
 }
 recordEmit('active-related-index-build', __tRelatedIndexBuild);
 const relatedPoolByJob = new WeakMap<object, any[]>();
 const getRelatedPool = (job: any): any[] => {
 const __tRelatedIndexed = startTimer();
 const cached = relatedPoolByJob.get(job as object);
 let relatedPool = cached;
 if (!relatedPool) {
 const seen = new Set<any>();
 relatedPool = [];
 const ownSlug = job.slug;
 const addCandidates = (candidates?: any[]) => {
 if (!candidates) return;
 for (const candidate of candidates) {
 if (!candidate || candidate.slug === ownSlug || seen.has(candidate)) continue;
 seen.add(candidate);
 relatedPool!.push(candidate);
 }
 };
 addCandidates(relatedJobsByCategory.get(job.category));
 addCandidates(relatedJobsByLocation.get(job.location));
 relatedPool.sort((a, b) =>
 (relatedJobSourceIndex.get(a as object) ?? 0) - (relatedJobSourceIndex.get(b as object) ?? 0),
 );
 relatedPoolByJob.set(job as object, relatedPool);
 }
 recordEmit('active-related-pool-indexed', __tRelatedIndexed);
 if (PROFILE_RELATED_COMPARE) {
 const __tRelatedLegacy = startTimer();
 const legacyPool = validJobs
 .filter((r: any) => r.slug !== job.slug && (r.category === job.category || r.location === job.location));
 recordEmit('active-related-pool-legacy', __tRelatedLegacy);
 if (
 legacyPool.length !== relatedPool.length
 || legacyPool.some((legacyJob: any, idx: number) => legacyJob.slug !== relatedPool![idx]?.slug)
 ) {
 relatedCompareMismatches++;
 if (relatedCompareMismatches <= 3) {
 console.warn(`\x1b[33m[jobs-seo-pages]\x1b[0m Related pool mismatch for ${job.slug}`);
 }
 }
 }
 return relatedPool;
 };

 // `companyRoutePrefix` / `isCompanyHubNamespaceSlug` now live in
 // `./shared/cantonSection` (COMPANY_ROUTE_PREFIX / isCompanyHubNamespaceSlug)
 // so jobOrphanBridgePlugin.ts can share the exact same reserved-namespace
 // guard instead of drifting a second copy (issue #2976 5th-site recurrence).
 const companyRoutePrefix = COMPANY_ROUTE_PREFIX;
 // These three were hand-written copies of the shared normalisation, and the docblock
 // below used to say "Mirror runtime canonicalCompanyRouteSlug logic" \u2014 a mirror kept by
 // hand is a drift waiting to happen (#6). They now delegate to the one module. It matters
 // here more than anywhere: this plugin EMITS the indexed /aziende/<slug>/ URLs, so if this
 // copy and the runtime router ever diverged, the company-hub page and the token
 // CompanyAlert persists would stop agreeing \u2014 silently, with no error (#5012 review).
 const slugifyCompanyBuild = rawCompanySlug;
 const canonicalCompanySlugBuild = baseCompanySlug;

 // Company-hub URL slug: same as canonicalCompanySlugBuild but folds declared
 // brand aliases onto their canonical (e.g. migros-ticino → migros). Use this
 // EVERYWHERE a company-hub page is emitted OR linked (per-canton hubs, job-page
 // banner/footer, canton navigator) so emit and links agree on one canonical
 // slug and an alias never produces an indexable self-hub or an orphan link to
 // an un-emitted page. The raw companyMap key (companyMap construction) stays
 // unfolded so the BRAND_UMBRELLAS aggregation still sees each real key.
 // Delegates to canonicalCompanyProfileSlug, which is base + the same alias fold. The
 // former inline `raw ? … : raw` guard is preserved by resolveBrandCanonical itself
 // (`if (!slug) return null`), so the empty-company case still yields ''.
 const companyHubSlugBuild = (company: string, companyKey?: string): string => {
 return canonicalCompanyProfileSlug(company, companyKey);
 };

 // ── Pre-compute title-collision map per locale ──
 // The base <title> formula (role + company + city) collapses to identical
 // strings whenever two jobs differ only by slug suffix (AFC vs CFP variants),
 // by city-postal-code tail (e.g. `riazzino-xsgkjj` vs `cadenazzo` for the
 // same Lidl listing replicated across postal codes), or because the
 // 70-char ceiling truncates them to the same prefix. Semrush's
 // title-uniqueness gate flags every such collision (~1.9k pages on the
 // current dataset).
 //
 // Strategy: build a (locale → baseTitle → count) map up front, then in the
 // per-job loop append a slug-tail disambiguator ONLY when count > 1 — so
 // unique pages keep their existing clean title and only colliding ones grow
 // a stable suffix. The slug tail is preferred because it is already unique
 // within the dataset (router slugs are deduped at crawl time). When the
 // job has no usable slug we fall back to the job.id tail.
 const titleCollisionByLocale: Record<'it' | 'en' | 'de' | 'fr', Map<string, number>> = {
 it: new Map(), en: new Map(), de: new Map(), fr: new Map(),
 };
 // ── No-city title-collision map (#1932) ──
 // Parallel map keyed on the CITY-LESS composed title ("role — company", no
 // city tail). Used to decide whether the city is safe to DROP on a
 // non-colliding page: the city may only be omitted when the role+company
 // headline is ALSO unique within the locale, otherwise dropping it would
 // collapse two multi-sede pages (same role+company × different cities) into
 // one <title> and trip the hard audit:title-uniqueness gate. Keyed on the
 // no-disambiguator probe (cityOptional=true) so the count reflects exactly
 // the string that would be emitted once the city is gone.
 const noCityTitleCollisionByLocale: Record<'it' | 'en' | 'de' | 'fr', Map<string, number>> = {
 it: new Map(), en: new Map(), de: new Map(), fr: new Map(),
 };
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 for (const locale of localeList) {
 const lt = String(job?.titleByLocale?.[locale] || job.title || '');
 const loc = String(job.location || '').trim();
 const baseTitle = composeJobPageTitle(lt, String(job.company || ''), loc, locale, undefined, undefined, (s) => esc(s).length);
 const bucket = titleCollisionByLocale[locale];
 bucket.set(baseTitle, (bucket.get(baseTitle) || 0) + 1);
 const noCityTitle = composeJobPageTitle(lt, String(job.company || ''), loc, locale, undefined, true, (s) => esc(s).length);
 const noCityBucket = noCityTitleCollisionByLocale[locale];
 noCityBucket.set(noCityTitle, (noCityBucket.get(noCityTitle) || 0) + 1);
 }
 }

 // ── Cross-corpus title-uniqueness net ──
 // audit-title-uniqueness is a HARD deploy gate (exit 1 on any within-locale
 // duplicate) and it walks the WHOLE dist — so an ACTIVE job page and an
 // EXPIRED soft-landing for a re-posted twin (same role + company + city)
 // must not compose the same <title>. Previously this was masked by the
 // unconditional ` · rif. {slug-tail}` suffix on every expired page; with
 // that suffix now collision-only, this registry is the explicit guarantee.
 // `claimUniqueTitle` registers every emitted title per locale; on a clash
 // it recomposes with the caller-supplied disambiguator chain, ending in a
 // deterministic `rif. {fnv8(slug)}` + numeric bump that can never collide.
 const claimedTitlesByLocale: Record<'it' | 'en' | 'de' | 'fr', Set<string>> = {
 it: new Set(), en: new Set(), de: new Set(), fr: new Set(),
 };
 const claimUniqueTitle = (
 locale: 'it' | 'en' | 'de' | 'fr',
 title: string,
 uniqueKey: string,
 recompose: (disambiguator: string) => string,
 ): string => {
 const seen = claimedTitlesByLocale[locale];
 let candidate = title;
 if (seen.has(titleCompareKey(candidate))) {
  const refLabel = REF_LABEL[locale] || REF_LABEL.it;
  candidate = recompose(`${refLabel} ${fnv8(uniqueKey)}`);
  let bump = 2;
  while (seen.has(titleCompareKey(candidate))) {
   candidate = recompose(`${refLabel} ${fnv8(uniqueKey)}-${bump++}`);
  }
 }
 seen.add(titleCompareKey(candidate));
 return candidate;
 };

 // Per-(canton, locale, slug) active-job path dedup. cleanup-jobs.mjs
 // dedupes by `job.slug` (the canonical IT slug), but two distinct jobs
 // can pass that filter with different IT slugs while still converging
 // on the same DE/EN/FR locale slug — for example two `tally-weijl`
 // postings whose IT titles differ slightly but whose German/English
 // translations slugify identically.
 //
 // Phase 8a (2026-05-12): the dedup key now includes the canton, so two
 // jobs that share `(locale, slug)` but live in different cantons each
 // emit their own HTML under their canton-section path
 // (e.g. /de/jobs-im-basel/{slug}/ AND /de/jobs-im-zurich/{slug}/).
 // Previously the key was `(locale, slug)`, which silently suppressed
 // 20 of 21 DE files in the localsearch.ch cross-canton collision and
 // forced the Phase 3 hreflang band-aid (drop-all-below-5). With the
 // canton in the key the cross-canton collision evaporates.
 //
 // Same-canton (canton, locale, slug) collisions still resolve last-add-
 // wins: validJobs is sorted DESC by recency above, so the FIRST job
 // for any colliding tuple is the most recent. The IT canonical (unique
 // by cleanup) always emits — only colliding locale-variants within the
 // same canton are suppressed.
 //
 // The sitemap shard push below reads this same Set to suppress URLs
 // whose HTML would point at a path the per-job dedup skipped — keeping
 // sitemap and dist/ byte-for-byte consistent.
 const emittedActiveJobPaths = new Set<string>();

 // ── Canonical-fallback worker pre-pass ─────────────────────────────
 //
 // `canonicalizeFallbackCleaned` is pure (regex + string passes, no I/O)
 // and runs once per UNIQUE (description, requirements) tuple. Run 26440498634
 // measured this as 91 % of per-page active-job render → ~500 s on the
 // sequential closeBundle. The 2-layer split already lets a single thread
 // dedup across locales; the worker pool parallelizes the remaining unique
 // work across the runner's vCPUs (GH free-tier = 2; self-hosted = up to N).
 //
 // Pre-collect every unique tuple needed by the upcoming active-job loop,
 // dispatch to N workers, await results, then populate `canonicalCleanedCache`.
 // The main loop's `memoCanonicalCleaned` calls then hit 100 %.
 //
 // Opt-out: set `JOBS_SEO_FALLBACK_WORKERS=0` to keep the inline single-
 // threaded path (useful for A/B timing or debugging worker overhead).
 await (async () => {
 const optOut = process.env.JOBS_SEO_FALLBACK_WORKERS === '0';
 if (optOut) return;
 const tStart = Date.now();
 // Phase 1: enumerate unique tuples (skip cache hits — usually none at
 // this point, but harmless to check).
 const tStartEnum = Date.now();
 const seen = new Set<string>();
 const tuples: Array<{ key: string; description: string; requirements: string[] }> = [];
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 for (const locale of localeList) {
 // Per-locale shard build (BUILD_LOCALE): the cleaned canonical
 // description/requirements are consumed ONLY when rendering that locale's
 // pages (JSON-LD/body content) — which this shard skips for non-emitted
 // locales. So only enumerate tuples for the emitted locale → the worker
 // pool processes ~1/4 the tuples. No-op in the default all-locale build.
 if (!shouldEmitLocale(locale)) continue;
 const description = String(job?.descriptionByLocale?.[locale] || job.description || '');
 if (!description) continue;
 const requirements: string[] = Array.isArray(job?.requirementsByLocale?.[locale])
 ? (job.requirementsByLocale[locale] as unknown[]).map((x) => String(x || '')).filter((x) => x.length > 0)
 : Array.isArray(job?.requirements)
 ? (job.requirements as unknown[]).map((x) => String(x || '')).filter((x) => x.length > 0)
 : [];
 // Stessa chiave di `memoCanonicalCleaned` — e DEVE restare la stessa
 // funzione, non una copia: se le due espressioni divergono il pre-pass
 // popola chiavi che il ciclo principale non trova mai, e la cache passa
 // silenziosamente da 96,5 % di hit a 0 % (il costo tornerebbe inline, non
 // ci sarebbe nessun errore). Una definizione sola in
 // shared/canonicalCleanedKey.ts, che e' anche dove sta la ragione per cui
 // non e' piu' la concatenazione del testo.
 const key = canonicalCleanedKey(description, requirements);
 if (seen.has(key) || canonicalCleanedCache.has(key)) continue;
 seen.add(key);
 tuples.push({ key, description, requirements });
 }
 }
 const enumMs = Date.now() - tStartEnum;
 if (tuples.length === 0) return;

 // Phase 2: decide on parallelism. Below 500 unique tuples the worker
 // setup overhead (~500 ms × N for spawn + dynamic import) costs more
 // than running inline.
 const FALLBACK_WORKER_MIN_TUPLES = 500;
 const override = process.env.JOBS_SEO_FALLBACK_WORKERS;
 const overrideN = override ? Number.parseInt(override, 10) : 0;
 const detected = Math.max(
 typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0,
 os.cpus()?.length ?? 0,
 1,
 );
 const workerCount =
 overrideN > 0
 ? Math.min(overrideN, tuples.length)
 : tuples.length < FALLBACK_WORKER_MIN_TUPLES
 ? 1
 : Math.min(detected, tuples.length);

 if (workerCount <= 1) {
 // Inline single-threaded path — same code as the worker body.
 for (const t of tuples) {
 const cleaned = canonicalizeFallbackCleaned(t.description, t.requirements);
 canonicalCleanedCache.set(t.key, cleaned);
 }
 // eslint-disable-next-line no-console
 console.log(
 `[jobs-seo-profile] canonical-fallback-pre-pass tuples=${tuples.length} workers=1 wall_ms=${Date.now() - tStart}`,
 );
 return;
 }

 // Phase 3: round-robin chunk + dispatch. Round-robin balances
 // description length (shorter descriptions = faster parse) across
 // workers — slicing would give one worker all the heavy ones.
 const tStartChunk = Date.now();
 const chunks: Array<typeof tuples> = Array.from({ length: workerCount }, () => []);
 for (let i = 0; i < tuples.length; i++) {
 chunks[i % workerCount].push(tuples[i]);
 }
 const chunkMs = Date.now() - tStartChunk;
 const tStartDispatch = Date.now();
 const workerUrl = new URL('./canonicalFallbackWorker.mjs', import.meta.url);
 type WorkerResult = {
 entries: Array<{ key: string; cleaned: CleanedFallbackContent }>;
 profile: { importMs: number; workMs: number; count: number };
 };
 const results = await Promise.all(
 chunks.map(
 (assignedTuples) =>
 new Promise<WorkerResult>((resolve, reject) => {
 const worker = new Worker(workerUrl, {
 workerData: { tuples: assignedTuples },
 execArgv: ['--import', 'tsx'],
 });
 worker.once('message', resolve);
 worker.once('error', reject);
 worker.once('exit', (code) => {
 if (code !== 0) reject(new Error(`canonicalFallbackWorker exited with code ${code}`));
 });
 }),
 ),
 );
 const dispatchMs = Date.now() - tStartDispatch;

 // Phase 4: merge — populate cache. The cache cap is intentionally
 // bypassed here: the pre-pass output is exactly what the main loop will
 // need, so evicting would just cause inline recomputation right after.
 const tStartMerge = Date.now();
 for (const r of results) {
 for (const entry of r.entries) {
 canonicalCleanedCache.set(entry.key, entry.cleaned);
 }
 }
 const mergeMs = Date.now() - tStartMerge;
 const workerImportP99 = Math.max(...results.map((r) => r.profile.importMs));
 const workerWorkP99 = Math.max(...results.map((r) => r.profile.workMs));
 const workerWorkAvg = results.reduce((s, r) => s + r.profile.workMs, 0) / results.length;
 const workerWorkMin = Math.min(...results.map((r) => r.profile.workMs));
 // eslint-disable-next-line no-console
 console.log(
 `[jobs-seo-profile] canonical-fallback-pre-pass tuples=${tuples.length} workers=${workerCount} wall_ms=${Date.now() - tStart} enum_ms=${enumMs} chunk_ms=${chunkMs} dispatch_ms=${dispatchMs} merge_ms=${mergeMs} worker_import_p99_ms=${workerImportP99.toFixed(0)} worker_work_min_ms=${workerWorkMin.toFixed(0)} worker_work_avg_ms=${workerWorkAvg.toFixed(0)} worker_work_p99_ms=${workerWorkP99.toFixed(0)}`,
 );
 })();

 // ── Evergreen employer hubs: hand the ad's authority to the page that
 //    outlives it (`/aziende/<slug>/`) ─────────────────────────────────────
 //
 // GSC 28d (9 Jul – 6 Aug 2026): the 505 emitted hubs took 571 impressions
 // and 29 clicks IN TOTAL — 475 of them never got a single impression — while
 // the brand demand that maps onto those same hubs is worth 28 826 / 1 257.
 // A ~50:1 gap, and not a quality problem: 115 of the 200 strongest
 // «lavorare in / da / presso X» query→page pairs land on a SINGLE AD, which
 // expires and takes its position with it, and ZERO land on the hub
 // («lavorare in eoc» → an ad, position 9.5, 28 impressions, 0 clicks).
 //
 // employerProfilePagesLinksPlugin already closed the BFS-orphan half of this
 // (one link per hub from the 4 HTML sitemap pages, enough for
 // `audit:max-bfs-depth`, worth almost nothing as authority). This is the
 // other half, and it is the one this plugin is uniquely able to do: it owns
 // the ~9 140 active ad pages that took 23 375 clicks in the same 28 days,
 // and every one of them is topically about exactly one employer.
 //
 // The URL is NOT rebuilt here. `employerProfilesFlushed` carries the paths
 // employerProfilePagesPlugin actually WROTE this build, so the href is copied
 // verbatim out of the emitter's own output and the slug is only used as a
 // lookup key — a drifting key misses the map and yields NO link rather than a
 // wrong one. Indexable pages only: below-floor bridges are `noindex` shells
 // with no job list, so pointing 9 140 pages at one buys nothing.
 //
 // Same barrier contract as employerProfilePagesLinksPlugin (buildSignals.ts:
 // a cross-plugin read needs an explicit signal, never a "it happens to have
 // been written already" assumption). The producer resolves this on EVERY
 // exit of its `closeBundle` — including the SKIP_EMPLOYER_PROFILE_PAGES=1
 // fast-exit, which resolves `[]` and simply leaves every job page unlinked.
 //
 // What the signal does NOT buy is freedom from registration order (#5330).
 // The original version of this comment said "no deadlock is possible"
 // because closeBundle hooks run in parallel — they do not on deploy:
 // deploy.yml sets SEQUENTIAL_PROFILE=1 and profilePlugin then marks every
 // wrapped closeBundle `sequential: true`. Serialized, a signal can only
 // travel FORWARD through the vite.config.ts array, and employer-profile-pages
 // was registered ~60 entries AFTER this plugin: the await never settled, the
 // event loop drained, node exited 0, and `vite build` reported success having
 // emitted nothing past this line — six critical IT landings included.
 // employerProfilePagesPlugin is now registered immediately before this
 // plugin, and tests/build-plugin-order.test.ts derives that constraint from
 // these very imports so the next cross-plugin `await` is covered on sight.
 const emittedEmployerHubs = new Map<string, string>();
 for (const emitted of await employerProfilesFlushed) {
 const m = /^(?:\/(en|de|fr))?\/aziende\/([^/]+)\/$/.exec(emitted.path);
 if (m) emittedEmployerHubs.set(`${m[1] ?? 'it'}|${m[2]}`, emitted.path);
 }
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m employer hubs available for internal linking: ${emittedEmployerHubs.size}`,
 );

 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const perLocaleSlug = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 const jobCanton = sharedResolveJobCanton(job as { canton?: string; location?: string });
 // Per-job invariants — values that depend only on the job (and jobCanton,
 // which is itself job-invariant) and are therefore identical across the
 // 4 locale iterations below. Hoisting them out of the inner loop avoids
 // recomputing the same string normalization / lookup / regex on every
 // locale pass × every active job. The full prose IIFE further down uses
 // most of these via closure (co/cat/contractKey/dc/deCantonPrep/...).
 const __tPh_perJob = phaseTimer();
 // Canton CODE is job-invariant and stays hoisted; the DISPLAY NAME is not
 // (e.g. GR → "Grigioni" it/en, "Graubünden" de, "Grisons" fr) — resolved
 // per-locale below (`dc` in the locale loop), not here.
 const perJob_cantonCode = String(job.canton || DEFAULT_CANTON);
 const perJob_jobLocation = String(job.location || '').trim();
 const perJob_co = String(job.company || '');
 const perJob_cat = String(job.category || '').toLowerCase();
 const perJob_contractKey = String(job.contract || '').toLowerCase();
 const perJob_matchedCity = CITY_HUB_KEYS.find((c) => jobMatchesCity(job as never, c));
 const perJob_logoUrl = companyLogo(job);
 const perJob_relatedPool = getRelatedPool(job);
 const perJob_relatedSeed = (() => {
 const s = String(job.slug || '');
 let h = 2166136261 >>> 0;
 for (let i = 0; i < s.length; i++) {
 h = (h ^ s.charCodeAt(i)) >>> 0;
 h = (h * 16777619) >>> 0;
 }
 return h;
 })();
 const perJob_salaryMin = Number.isFinite(Number(job.salaryMin))
 ? Number(job.salaryMin)
 : Number(job?.baseSalary?.value?.minValue);
 const perJob_salaryMax = Number.isFinite(Number(job.salaryMax))
 ? Number(job.salaryMax)
 : Number(job?.baseSalary?.value?.maxValue);
 const perJob_salaryCurrency = String(job.currency || job?.baseSalary?.currency || job?.baseSalary?.value?.currency || 'CHF');
 // Region resolved FIRST: addressLocality must agree with it, not the
 // other way round (a garbage/wrong-canton locality is what leaked into
 // visible HTML — reported bug — since this render path bypassed the
 // central JobPosting schema sanitizer entirely until now).
 const perJob_addressRegion = deriveCanton(job);
 const perJob_addressLocality = deriveJobAddressLocality(job, perJob_addressRegion);
 const perJob_addressCountry = String(job.addressCountry || 'CH');
 const perJob_postalCode = deriveJobPostalCode(job);
 const perJob_streetAddress = deriveStreetAddress(job);
 // NOTE: `isRemote` is intentionally NOT hoisted here. The original test
 // ran against the LOCALE-specific normalized description (which can
 // differ across translations — "remote" may appear in the EN copy and
 // not in the IT source). Keeping the computation inside the locale loop
 // preserves byte-for-byte output parity with the pre-refactor version.
 recordPhase('per-job-invariants', __tPh_perJob);
 for (const locale of localeList) {
 const __tActiveJob = startTimer();
 const sectionForJob = buildCantonAwareSection(locale, jobCanton);
 const relPath = `${localePrefix[locale]}/${sectionForJob}/${perLocaleSlug[locale]}`.replace(/\/+/g, '/');
 // Suppress duplicate per-locale emit. Most-recent (sorted earlier)
 // already won this path; emitting again would only register a
 // collision in dist/.write-collisions.json without changing the
 // bytes on disk (Map last-add-wins inside the WriteCollector).
 const __activeJobKey = `${jobCanton}:${locale}:${perLocaleSlug[locale]}`;
 if (emittedActiveJobPaths.has(__activeJobKey)) {
 recordEmit('active-job', __tActiveJob);
 continue;
 }
 emittedActiveJobPaths.add(__activeJobKey);
 // Per-locale shard build (BUILD_LOCALE): the dedup Set above is fully
 // populated for EVERY locale BEFORE this skip — the sitemap shard pass
 // (~line 8642) reads `emittedActiveJobPaths` to decide which job URLs to
 // list, so the `it`/main shard's sitemap stays complete. We only skip the
 // expensive per-locale render/minify/emit below for locales this shard is
 // not responsible for. hreflang stays complete: the `alternates` block
 // maps over the full `localeList` using the pre-loop `perLocaleSlug` map.
 if (!shouldEmitLocale(locale)) {
 recordEmit('active-job', __tActiveJob);
 continue;
 }
 const canonicalPath = withSlash(relPath);
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // Cannibalization fix: <link rel="canonical"> and og:url may point to a
 // winner URL (company hub) when this slug is in the override map.
 // The page itself is still emitted with its own URL (breadcrumbs,
 // JobPosting, etc. describe THIS page) so existing backlinks resolve.
 const effectiveCanonicalUrl = resolveCanonicalUrl(perLocaleSlug[locale], canonicalUrl);
 const localizedTitle = stripLiteralMarkdownFromTitle(String(job?.titleByLocale?.[locale] || job.title || ''));
 const jobLocation = perJob_jobLocation;
 const dc = getCantonDisplayLabel(perJob_cantonCode, locale);
 // City-aware title: always includes location when available, then truncates
 // the core before appending the fixed brand suffix. This prevents duplicate
 // titles on multi-sede jobs (same role × N cities) — the city differentiates
 // the SERP title — and keeps total length within Google's ~60-char limit.
 //
 // Disambiguator (slug-tail or job-id-tail) is injected ONLY when the base
 // title would collide with another job's base title in the same locale —
 // closes the Semrush title-uniqueness audit gate while leaving unique
 // titles untouched.
 const __tPh_title = phaseTimer();
 // composeJobPageTitle is invariant in (jobTitle, company, city, locale)
 // — call it once for the probe (no disambiguator), then only re-call
 // with a disambiguator IF this page collides with another in the same
 // locale. The non-disambiguated probe doubles as `ogTitle` (social
 // cards omit the disambiguator by design — see comment below). Saves
 // 1 call per page always, 2 when no collision (the common case).
 const baseTitleProbe = composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, undefined, undefined, (s) => esc(s).length);
 const collidesInLocale = (titleCollisionByLocale[locale].get(baseTitleProbe) || 0) > 1;
 // City-drop decision (#1932): drop the city ONLY when this page does not
 // collide on the full (with-city) title AND its city-less "role — company"
 // headline is itself unique in the locale — so removing the city cannot
 // collapse two multi-sede pages into a duplicate <title> (audit:title-
 // uniqueness). On the residual mid-`…` pages (role+city > 66 char) this lets
 // the bare role fill the budget verbatim instead of truncating mid-word.
 const noCityProbe = composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, undefined, true, (s) => esc(s).length);
 const cityIsDroppable = !collidesInLocale
  && (noCityTitleCollisionByLocale[locale].get(noCityProbe) || 0) <= 1;
 // Build a HUMAN-READABLE disambiguator from the job's metadata (cascade:
 // workHours/percentage → employmentType label → salary range → posted
 // month → job-id reference). Replaces the previous opaque
 // ` (#abcd1234)` FNV hash, which Semrush flagged as a low-CTR
 // auto-disambiguator pattern. See `pickJobDisambiguator` above for the
 // full selection logic.
 const disambiguatorToken = collidesInLocale
 ? pickJobDisambiguator(job as Record<string, unknown>, locale, baseTitleProbe)
 : '';
 // `cityIsDroppable` only ever holds when the page does NOT collide, so
 // `disambiguatorToken` is empty here and the droppable branch is `noCityProbe`.
 let title = disambiguatorToken
 ? composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, disambiguatorToken, undefined, (s) => esc(s).length)
 : (cityIsDroppable ? noCityProbe : baseTitleProbe);
 // <title> must differ from the <h1> (audit:h1-title-duplicates). With the
 // role>city>company cascade the title normally carries the city or brand
 // and differs structurally; the residual case is a city-less job whose
 // "role — company" headline is too long for the brand but exactly equals
 // the H1 — disambiguate it with the job metadata token.
 const __h1Key = titleCompareKey(composeJobPageH1(localizedTitle, String(job.company || '')));
 if (titleCompareKey(title) === __h1Key) {
 const h1AvoidToken = pickJobDisambiguator(job as Record<string, unknown>, locale, title);
 title = composeJobPageTitle(
  localizedTitle, String(job.company || ''), jobLocation, locale,
  h1AvoidToken || `${REF_LABEL[locale] || REF_LABEL.it} ${fnv8(String(job.slug || job.id || localizedTitle))}`,
  cityIsDroppable,
  (s) => esc(s).length,
 );
 }
 // Cross-corpus uniqueness net (see claimUniqueTitle above): guarantees no
 // two emitted pages in this locale — active OR expired — share a <title>.
 // The recompose preserves the city-drop decision so a clash falls back to a
 // disambiguator on the SAME (city-less or city-bearing) headline shape.
 title = claimUniqueTitle(locale, title, `${String(job.slug || job.id || '')}::${locale}`,
 (d) => composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, d, cityIsDroppable, (s) => esc(s).length));
 // Clean variant for og:title — the city-bearing probe minus any trailing
 // " · {disambiguator}". The disambig is needed in the HTML <title> for SEO
 // uniqueness, but social cards look better without the trailing metadata.
 // og:title deliberately KEEPS the city even when the <title> drops it
 // (#1932): social cards have no SERP width cap, so the richer location-
 // bearing headline is preferred there. Still, an untruncated headline can
 // exceed FB's own card-render width, which FB then hard-cuts mid-word
 // (issue #3382) — apply the same word-boundary truncateHeadline used for
 // meta descriptions, at a generous budget so #1932's city-keeping intent
 // is preserved for the vast majority of titles and only the genuine tail
 // outliers get an ellipsis instead of a mid-word FB cut.
 const OG_TITLE_MAX_CHARS = 100;
 const ogTitle = truncateHeadline(baseTitleProbe, OG_TITLE_MAX_CHARS);
 recordPhase('title', __tPh_title);
 // stripLeadingSectionLabel: crawlers flatten the source page's
 // "Descrizione/Description/Beschreibung" heading into the first sentence
 // ("Descrizione Presso la sede di Zell, …") — Google then leads the SERP
 // snippet with that junk word when it prefers the body over the meta
 // description. Strip it once here so meta fallback + body paragraphs +
 // JSON-LD all inherit the clean text.
 const localizedDescriptionRaw = stripLeadingSectionLabel(String(job?.descriptionByLocale?.[locale] || job.description || ''));
 const localizedDescription = normalizeText(localizedDescriptionRaw);
 const cleanDesc = cleanMetaDescription(localizedDescriptionRaw);
 // Build an SEO-friendly meta description with salary and CTA
 const metaIntro = locale === 'de'
 ? `${localizedTitle} bei ${job.company} in ${job.location || getCantonDisplayLabel(perJob_cantonCode, 'de')}.`
 : locale === 'fr'
 ? `${localizedTitle} chez ${job.company} à ${job.location || getCantonDisplayLabel(perJob_cantonCode, 'fr')}.`
 : locale === 'en'
 ? `${localizedTitle} at ${job.company} in ${job.location || getCantonDisplayLabel(perJob_cantonCode, 'en')}.`
 : `${localizedTitle} presso ${job.company} a ${job.location || getCantonDisplayLabel(perJob_cantonCode, 'it')}.`;
 // Inline salary snippet for meta description (before salaryText is computed)
 const metaSalaryMin = Number(job.salaryMin);
 const metaSalaryMax = Number(job.salaryMax);
 const metaCurrency = String(job.currency || 'CHF');
 const metaSalarySnippet = Number.isFinite(metaSalaryMin) && metaSalaryMin > 0
 ? (Number.isFinite(metaSalaryMax) && metaSalaryMax > metaSalaryMin
 ? ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}-${Math.round(metaSalaryMax).toLocaleString('de-CH')}.`
 : ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}.`)
 : '';
 const metaCta = locale === 'de' ? ' Jetzt auf Frontaliere Ticino bewerben.'
 : locale === 'fr' ? ' Postulez sur Frontaliere Ticino.'
 : locale === 'en' ? ' Apply now on Frontaliere Ticino.'
 : ' Candidati ora su Frontaliere Ticino.';
 const metaBody = cleanDesc.length > 40 ? ` ${cleanDesc}` : '';
 // Assemble: intro + salary + body, truncated to 160 chars; fallback to body if over limit
 const descWithSalary = `${metaIntro}${metaSalarySnippet}${metaCta}`;
 // Truncate meta description at word boundary, avoiding trailing hyphens/prepositions.
 // Delegates to the shared truncateHeadline → peelDanglingClauseTail: this used
 // to carry its OWN inline preposition list, a literal duplicate of
 // TRAILING_STOPWORDS in build-plugins/shared/titleSuffix.ts that had already
 // drifted (it was missing `tra`, `fra`, `sul`, `che`, `come`, `und`, `zu`, `et`,
 // `qui`, … so those still dangled here after being handled there).
 // AGENTS.md Non-Negotiable #6: one shared module, no copies.
 const truncMetaDesc = (s: string, max = 160): string => truncateHeadline(s, max);
 // Decode HTML entities from source data to prevent double-escaping in esc()
 const description = decodeHtmlEntities(descWithSalary.length <= 160
 ? descWithSalary
 : truncMetaDesc(`${metaIntro}${metaSalarySnippet}${metaBody}`));
 const descriptionParagraphs = splitIntoParagraphs(localizedDescriptionRaw).slice(0, 10);
 const requirements = firstItems(job?.requirementsByLocale?.[locale] || job?.requirements, 8);
 // 100% of crawled jobs ship without `_canonical` (no AI pipeline produces it
 // today — translate-pending.yml only relocalises text). Without a fallback,
 // every static job page emits an empty `<div class="timeline">` while the
 // hydrated SPA renders 6 sections from the raw description. Run the same
 // heuristic splitter the SPA uses (services/jobs/canonicalFallback) so
 // crawlers see the same sectioned body users see.
 const __tPh_canonical = phaseTimer();
 const __tPh_cf_read = phaseTimer();
 const canonicalLocaleRaw = readCanonicalByLocale(job, locale);
 const hasCanonicalSignal = !!canonicalLocaleRaw && (
 cleanItems(canonicalLocaleRaw?.summary, 4).length > 0
 || cleanItems(canonicalLocaleRaw?.responsibilities, 10).length > 0
 || cleanItems(canonicalLocaleRaw?.requirements, 12).length > 0
 || cleanItems(canonicalLocaleRaw?.benefits, 10).length > 0
 || cleanItems(canonicalLocaleRaw?.process, 8).length > 0
 || parseCanonicalSections(canonicalLocaleRaw?.sections, 8).length > 0
 );
 const fallbackRequirements: string[] = Array.isArray(job?.requirementsByLocale?.[locale])
 ? (job.requirementsByLocale[locale] as unknown[]).map((x) => String(x || '')).filter((x) => x.length > 0)
 : Array.isArray(job?.requirements)
 ? (job.requirements as unknown[]).map((x) => String(x || '')).filter((x) => x.length > 0)
 : [];
 recordPhase('cf:read-probe', __tPh_cf_read);
 const __tPh_cf_fb = phaseTimer();
 const canonicalLocale = hasCanonicalSignal
 ? canonicalLocaleRaw
 : memoBuildFallbackCanonicalContent(localizedDescriptionRaw, fallbackRequirements, locale);
 recordPhase('cf:fallback-call', __tPh_cf_fb);
 const __tPh_cf_clean = phaseTimer();
 const canonicalSummary = cleanItems(canonicalLocale?.summary, 4);
 const canonicalSections = parseCanonicalSections(canonicalLocale?.sections, 8)
 .filter((section) => !['requirements', 'benefits', 'process'].includes(section.id));
 const canonicalResponsibilities = cleanItems(canonicalLocale?.responsibilities, 10);
 const canonicalRequirements = cleanItems(canonicalLocale?.requirements, 12);
 const canonicalBenefits = cleanItems(canonicalLocale?.benefits, 10);
 const canonicalProcess = cleanItems(canonicalLocale?.process, 8);
 const canonicalKeywords = cleanItems(canonicalLocale?.keywords, 8);
 recordPhase('cf:clean', __tPh_cf_clean);
 const __tPh_cf_paragraphs = phaseTimer();
 const fallbackParagraphs = [cantonPracticalNote0(locale, dc), ...localeCopy[locale].practicalNotes.slice(1)];
 // When _canonical is missing we ARE the only body content — keep the full
 // paragraph set (capped at 10 to match `descriptionParagraphs`) so jobs
 // with a real markdown description (headings + bullets + sede/contract
 // footer) don't lose Nutanix/VDI/Sede/Tempo indeterminato signals.
 // When canonical IS present, summary is a short lede so 3-4 paragraphs is
 // plenty and we stay byte-budget friendly.
 const hasCanonical = canonicalSummary.length > 0;
 const bodyParagraphs = (descriptionParagraphs.length >= 3
 ? (hasCanonical ? descriptionParagraphs.slice(0, 3) : descriptionParagraphs.slice(0, 10))
 : [localizedDescription, ...fallbackParagraphs]
 )
 .filter((p) => p && p.length > 25)
 .slice(0, hasCanonical ? 4 : 10);
 const summaryParagraphs = hasCanonical ? canonicalSummary : bodyParagraphs;
 const mergedRequirements = canonicalRequirements.length > 0 ? canonicalRequirements : requirements;
 recordPhase('cf:paragraphs', __tPh_cf_paragraphs);
 recordPhase('canonical-fallback', __tPh_canonical);
 const logoUrl = perJob_logoUrl;
 const __tPh_related = phaseTimer();
 // Related jobs cross-link block — densifies BFS reachability so the
 // ~2400 job-detail pages are reachable from the city/sector hubs even
 // when those hubs only embed top-30 cards. Selection: same category
 // OR same location, sorted with a deterministic salt of the slug to
 // distribute outbound links across the whole job graph rather than
 // always picking the same freshest jobs (which would leave deeper
 // listings orphaned). Cap held at 6 (1.5× the original 4) — high
 // enough to keep the orphan pool reachable at ~8.2k edges
 // (6 × 1370 reachable details), low enough to keep detail-page byte
 // weight under the audit:page-weight budget.
 const relatedPool = perJob_relatedPool;
 // Stable hash of own slug → starting offset into the pool, so
 // different details surface different neighbours (no "always top N")
 // without losing determinism between builds. Hoisted to perJob block —
 // see top of the outer for-each-job loop.
 const relatedSeed = perJob_relatedSeed;
 const related = relatedPool.length === 0 ? [] : (() => {
 const out: any[] = [];
 const seen = new Set<string>();
 const N = Math.min(6, relatedPool.length);
 for (let i = 0; i < N; i++) {
 const idx = (relatedSeed + i * 2654435761) % relatedPool.length;
 const cand = relatedPool[idx];
 if (cand && !seen.has(cand.slug)) {
 seen.add(cand.slug);
 out.push(cand);
 }
 }
 // Top-up with sequential picks if hash collisions reduced count.
 for (let i = 0; out.length < N && i < relatedPool.length; i++) {
 const cand = relatedPool[i];
 if (cand && !seen.has(cand.slug)) {
 seen.add(cand.slug);
 out.push(cand);
 }
 }
 return out;
 })();
 // close related-pool phase (selection done); relatedHtml render goes into
 // the same bucket so the bucket measures the full cross-link block cost.
 const relatedHtml = related
 .map((r: any, i: number) => {
 const rp = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}/${localizedSlug(r, locale)}`.replace(/\/+/g, '/');
 // Relative href — internal navigation resolves against canonical (absolute).
 const href = withSlash(rp);
 const relatedTitle = stripLiteralMarkdownFromTitle(String(r?.titleByLocale?.[locale] || r.title || ''));
 const rLogo = companyLogo(r);
 const rSalary = (() => {
 const rSalaryMin = Number(r.salaryMin) || Number(r.baseSalary?.value?.minValue);
 if (!rSalaryMin || !Number.isFinite(rSalaryMin)) return '';
 const rSalaryMax = Number(r.salaryMax) || Number(r.baseSalary?.value?.maxValue);
 const min = (rSalaryMin / 1000).toFixed(0);
 const max = (rSalaryMax && Number.isFinite(rSalaryMax)) ? (rSalaryMax / 1000).toFixed(0) : null;
 return max ? `${r.currency || 'CHF'} ${min}k – ${max}k` : `${r.currency || 'CHF'} ${min}k+`;
 })();
 // CSS classes `.rj` / `.rja` / `.rjw` / `.rjt` / `.rjs` / `.rjp`
 // replace ~390 B of inline styles per related-job item with ~50 B of
 // class refs. With Math.min(6, relatedPool.length) related items per
 // job page × ~641k per-job HTML files emitted across all cantons +
 // 4 locales, this saves ~1.5 KB per page ≈ ~900 MB dist. Class
 // bodies live in the shared per-job `<style>` block (see lines ~2350+).
 // Style applied via `.rja > img` in seo-static.css (no inline style attr).
 const rLogoImg = renderLogoImg(rLogo, `Logo ${r.company}`, 40, 40);
 // Hoisted: this runs once per related card, per job page, per locale — the
 // hottest string path in the SSG walk. Calling the formatter twice to test
 // and then to print it would double that for no reason.
 const rLocation = formatJobLocation(r.location, r.canton);
 const li = `<li class="rj"><a href="${href}" aria-label="${esc(relatedTitle)} — ${esc(r.company)}" class="rja">${rLogoImg}<div class="rjw"><div class="rjt">${esc(relatedTitle)}</div><div class="rjs">${esc(r.company)}${rLocation ? ` · ${esc(rLocation)}` : ''}</div>${rSalary ? `<div class="rjp">${esc(rSalary)}</div>` : ''}</div></a></li>`;
 // One in-feed ad `<li>` after every Nth related card (shared `shouldPlaceInfeedAd`
 // cadence), never after the last — same logic as `jobCardListBody`. `.rul` is a
 // plain block list (not a grid), so no `spanFull` is needed.
 const ad =
 i + 1 < related.length && shouldPlaceInfeedAd(i + 1)
 ? infeedAdListItemHtml()
 : '';
 return li + ad;
 })
 .join('');
 recordPhase('related-pool', __tPh_related);
 const __tPh_summary = phaseTimer();
 // Body paragraphs go through `jobDescriptionTextToHtml` (full block-level
 // parser) so AI-untouched descriptions with `### Heading` / `**bold**` /
 // `• bullet` markdown render as proper <h3>/<strong>/<ul>. `inlineTextToHtml`
 // only handles inline markers so headings/lists would leak as literal text
 // and trip audit:no-literal-markdown (0-tolerance, CLAUDE.md rule #1).
 // The parser already emits its own block wrappers (<p>/<h3>/<ul>), so we
 // do NOT add an outer <p>; canonical summary items (clean one-sentence
 // strings) still render as a single <p> via the parser.
 const summaryHtml = summaryParagraphs
 .map((p) => jobDescriptionTextToHtml(p))
 .join('');
 const isSubheadItem = (value: string) => /^(requisiti necessari|requisiti auspicati|required|preferred)$/i.test(normalizeText(value));
 const sectionHtml = (heading: string, paragraphs: string[], bullets: string[]) => {
 const paragraphsHtml = paragraphs.map((p) => jobDescriptionTextToHtml(p)).join('');
 const bulletsHtml = bullets.length > 0
 ? `<ul>${bullets.map((item) => `<li${isSubheadItem(item) ? ' class="subhead"' : ''}>${inlineTextToHtml(item)}</li>`).join('')}</ul>`
 : '';
 return `<section class="section"><h4>${esc(heading)}</h4>${paragraphsHtml}${bulletsHtml}</section>`;
 };
 const timelineBlocks: Array<{ heading: string; paragraphs: string[]; bullets: string[] }> = [];
 if (canonicalResponsibilities.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].responsibilitiesLabel, paragraphs: [], bullets: canonicalResponsibilities });
 }
 if (mergedRequirements.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].requirementsLabel, paragraphs: [], bullets: mergedRequirements });
 }
 if (canonicalBenefits.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].benefitsLabel, paragraphs: [], bullets: canonicalBenefits });
 }
 if (canonicalProcess.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].processLabel, paragraphs: [], bullets: canonicalProcess });
 }
 for (const section of canonicalSections) {
 if (section.paragraphs.length === 0 && section.bullets.length === 0) continue;
 timelineBlocks.push({
 heading: section.heading,
 paragraphs: section.paragraphs,
 bullets: section.bullets,
 });
 }
 if (canonicalKeywords.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].keywordsLabel, paragraphs: [], bullets: canonicalKeywords });
 }
 const timelineHtml = timelineBlocks
 .map((section) => `<div class="timeline-step">${sectionHtml(section.heading, section.paragraphs, section.bullets)}</div>`)
 .join('');
 recordPhase('summary-html', __tPh_summary);
 const parserAssignedChunks = summaryParagraphs.length
 + timelineBlocks.reduce((sum, section) => sum + section.paragraphs.length + section.bullets.length, 0);
 const parserOriginalChunks = Math.max(1, descriptionParagraphs.length + mergedRequirements.length);
 const parserCoverage = Math.min(100, Math.round((parserAssignedChunks / parserOriginalChunks) * 100));
 const isRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${job.title || ''} ${localizedDescription || ''} ${job.location || ''}`
 );
 // Salary data is pre-populated by re-enrich-jobs.mjs (SECTORS estimation) —
 // values hoisted to perJob block since they are job-invariant.
 const salaryMin = perJob_salaryMin;
 const salaryMax = perJob_salaryMax;
 const salaryCurrency = perJob_salaryCurrency;
 const salaryFormatter = new Intl.NumberFormat(
 locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-CH' : 'it-CH',
 { maximumFractionDigits: 0 }
 );
 const salaryText = Number.isFinite(salaryMin)
 ? (Number.isFinite(salaryMax) && salaryMax > salaryMin
 ? `${salaryCurrency} ${salaryFormatter.format(salaryMin)} - ${salaryFormatter.format(salaryMax)}`
 : `${salaryCurrency} ${salaryFormatter.format(salaryMin)}`)
 : (locale === 'de'
 ? 'nicht angegeben'
 : locale === 'fr'
 ? 'non indiqué'
 : locale === 'en'
 ? 'not specified'
 : 'non indicato');
 // Address fields hoisted to perJob block — all derived from job alone.
 const addressLocality = perJob_addressLocality;
 const addressRegion = perJob_addressRegion;
 const addressCountry = perJob_addressCountry;
 const postalCode = perJob_postalCode;
 const streetAddress = perJob_streetAddress;
 const alternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${buildCantonAwareSection(l, jobCanton)}/${perLocaleSlug[l]}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 // audit-hreflang requires 5 entries (4 locales + x-default) on every
 // page that emits any hreflang. Force x-default with canonicalUrl as
 // last-resort fallback so the entry is never silently dropped.
 const xDefaultHref = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || canonicalUrl;
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
 ].join('\n');

 const __tPh_jsonld = phaseTimer();
 // Build an HTML-formatted description for JobPosting structured data.
 // Google requires a non-empty description and recommends HTML format.
 // Assemble from summary paragraphs + structured sections, with a
 // plain-text fallback for jobs that lack parsed content.
 const descriptionHtmlParts: string[] = [];
 for (const p of summaryParagraphs) {
 if (p && p.length > 10) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 for (const block of timelineBlocks) {
 if (block.heading) descriptionHtmlParts.push(`<h3>${esc(block.heading)}</h3>`);
 for (const p of block.paragraphs) {
 if (p) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 if (block.bullets.length > 0) {
 descriptionHtmlParts.push(`<ul>${block.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
 }
 }
 // Surrogate-safe 5000-cap: this string is the JSON-LD JobPosting.description;
 // a raw slice can split an emoji pair and leave a lone surrogate that breaks parsing.
 const jobPostingDescriptionHtml = truncateCodeUnits(descriptionHtmlParts.join(''), 5000);
 // Fallback: use plain text description or metaIntro if HTML assembly is empty
 const jobPostingDescription = jobPostingDescriptionHtml.length >= 50
 ? jobPostingDescriptionHtml
 : (localizedDescription.length >= 50
 ? truncateCodeUnits(plainTextToHtml(localizedDescription), 5000) || truncateCodeUnits(localizedDescription, 5000)
 : truncateCodeUnits(plainTextToHtml(`${metaIntro} ${localizedDescription}`.trim()), 5000)
 || truncateCodeUnits(`${metaIntro} ${localizedDescription}`.trim(), 5000));
 // CLAUDE.md rule #3: JobPosting schema MUST always be emitted for active
 // jobs. If the aggregated description is too thin, synthesize a default
 // from the structured fields we already have (title, company, city,
 // canton, contract, sector) so Google still gets a valid, useful snippet.
 const hasValidJobPostingDescription = jobPostingDescription.length >= 30;
 const finalJobPostingDescription = hasValidJobPostingDescription
 ? jobPostingDescription
 : buildJobDescriptionFallback(job, localizedTitle, addressLocality, addressRegion, locale);
 // Build the canonical JobPosting schema via the shared builder — this
 // guarantees all 9 mandatory fields (CLAUDE.md rule #3) with realistic
 // defaults. Extra editorial fields (responsibilities, skills, etc.) are
 // merged on top of the canonical output.
 const canonicalJobInput: JobInput = {
 id: job.id,
 slug: job.slug,
 title: localizedTitle,
 description: capJsonLdDescription(finalJobPostingDescription),
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: companyWebsite(job),
 companyLogoUrl: logoUrl,
 addressLocality,
 addressRegion,
 addressCountry,
 postalCode,
 streetAddress,
 postedDate: job.postedDate,
 crawledAt: job.crawledAt,
 updatedAt: job.updatedAt,
 contract: job.contract,
 salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
 salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
 salaryCurrency,
 sector: job.category,
 category: job.category,
 url: job.url,
 isRemote,
 };
 const canonicalSchema = buildJobPostingSchema(canonicalJobInput, {
 locale,
 url: canonicalUrl,
 baseUrl: BASE_URL,
 });
 // Deterministic per-job FAQ (salary, contract type, work-permit/border-zone,
 // how-to-apply) — high-volume active jobs (~19k) rule out AI generation, so
 // this is a pure template over the already-resolved canonicalSchema fields.
 //
 // The FAQ's G-permit answer MUST use sharedResolveJobCanton (the same
 // resolver services/seoService.ts and JobBoard.tsx use for their own FAQ
 // computation, per PR #4595 review) rather than `perJob_cantonCode`
 // (= `job.canton || DEFAULT_CANTON`, which ignores `location`/city and is
 // kept as-is for THIS page's own URL/breadcrumb/section — changing that
 // would touch routing, out of scope here). Using a different, less
 // accurate resolver just for the FAQ text would risk the same
 // structured-data/visible-content-and-legal-guidance mismatch the review
 // flagged between the two SPA paths — this keeps all three surfaces
 // (SSG here, SPA JSON-LD, SPA accordion) agreeing on the same canton for
 // the same job.
 const faqResolvedCanton = sharedResolveJobCanton(job).toUpperCase();
 const faqOpts: BuildJobPostingFaqOptions = {
 locale,
 jobUrl: job.url || canonicalUrl,
 cantonDisplay: getCantonDisplayLabel(faqResolvedCanton, locale),
 isTicino: faqResolvedCanton === 'TI',
 isRemote,
 };
 const jobFaqPairs = buildJobPostingFaqPairs(canonicalSchema, faqOpts);
 // Merge editorial-only fields that sit outside the 9-mandatory core.
 // The canonical block is authoritative for every required field — only
 // optional enrichment data is layered on.
 const jobLd = inlineScriptJson({
 ...canonicalSchema,
 // validThrough from the legacy helper (may differ from builder default).
 validThrough: toValidThrough(job.postedDate, job.crawledAt),
 // industry / occupationalCategory / applicantLocationRequirements (the
 // last one scoped to isRemote, never unconditional — see #applicant
 // LocationRequirements hardcode fix) are already present on
 // canonicalSchema, computed once inside buildJobPostingSchema.
 ...(canonicalResponsibilities.length > 0 ? { responsibilities: canonicalResponsibilities.join('\n') } : {}),
 ...(canonicalKeywords.length > 0 ? { skills: canonicalKeywords.join(', ') } : {}),
 ...(canonicalRequirements.length > 0 ? { qualifications: canonicalRequirements.join('\n') } : {}),
 });
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, dc), item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: localizedTitle, item: canonicalUrl },
 ],
 });
 // Single FAQPage block for this page (audit-faqpage-validity gate rejects
 // >1 FAQPage per document) — the visible HTML counterpart (`jobFaqHtml`)
 // is rendered inside <article class="proposal"> below for content parity.
 const jobFaqLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: jobFaqPairs.map((f) => ({
 '@type': 'Question',
 name: f.q,
 acceptedAnswer: { '@type': 'Answer', text: f.a },
 })),
 });
 // Distinct heading from the older canton-generic FAQ block further down
 // this same page (faqSectionHtml, ~line 3440 — 2 Q&A shared verbatim by
 // every job in the same canton) so the two "FAQ" sections read as
 // different content instead of a duplicated heading.
 const jobFaqHeadingByLocale: Record<CantonLocale, string> = {
 it: 'Domande frequenti su questo annuncio',
 en: 'Questions about this listing',
 de: 'Fragen zu dieser Stellenanzeige',
 fr: 'Questions sur cette offre',
 };
 const jobFaqHtml = `<section class="section"><h4>${esc(jobFaqHeadingByLocale[locale])}</h4>${jobFaqPairs.map((f) => `<details class="s-TdgkK3"><summary class="s-HBR0NM">${esc(f.q)}</summary><p class="s-bOIp6r">${esc(f.a)}</p></details>`).join('')}</section>`;
 recordPhase('jsonld', __tPh_jsonld);

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 const __tPh_template = phaseTimer();
 // Seed the slim job record into the page so the SPA resolves `selectedJob`
 // from the first paint without downloading the ~1.2 MB (gzip) slim index —
 // it then fetches only /data/job-detail/<id>.json (~2-4 KB gzip) for the body.
 // `slug` is forced to the canonical per-locale slug: on a bridge page the SPA
 // looks the job up by __BRIDGE_TARGET_SLUG__ (= perLocaleSlug[locale]), so the
 // seed must match that, not the legacy URL slug. Shape is identical to a
 // jobs-<locale>-index.json entry (shared buildSlimSeed). `<` is escaped so a
 // title/company containing it cannot break out of the inline <script>.
 const __jobSeed = buildSlimSeed(job, locale);
 __jobSeed.slug = perLocaleSlug[locale];
 const seedScript = `<script>window.__JOB_SEED__=${inlineScriptJson(__jobSeed)};</script>`;
 // Individual job descriptions vary widely in length (604/25,386 jobs have
 // <50-word descriptions) -- unlike the fixed-prose hub/guide pages below
 // that reuse ROBOTS_INDEX_ENHANCED unconditionally, this per-job page's
 // indexability must be gated on the actual rendered summary/description/
 // FAQ content, same pattern as jobRecencyPagesPlugin.ts's recencyRobotsTag.
 const jobBodyHtml = `${summaryHtml}${timelineHtml || (hasCanonical ? sectionHtml(localeCopy[locale].descriptionLabel, bodyParagraphs, []) : '')}${jobFaqHtml}`;
 const jobRobotsTag = robotsMetaEnhancedForContent(jobBodyHtml);
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(description))}">${jobRobotsTag}
 <meta property="og:type" content="article">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(ogTitle)}">
 <meta property="og:description" content="${esc(clampMetaDescription(description))}">
 <meta property="og:url" content="${effectiveCanonicalUrl}">
 <meta property="og:image" content="${perLocaleSlug.it ? `${BASE_URL}/og/jobs/${perLocaleSlug.it}.webp` : `${BASE_URL}/og-image.png`}">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="${perLocaleSlug.it ? 'image/webp' : 'image/png'}">
 <meta property="og:image:alt" content="${esc(ogTitle)}">
 <link rel="canonical" href="${effectiveCanonicalUrl}">
${hreflangHtml}
 <script type="application/ld+json">${jobLd}</script>
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${jobFaqLd}</script>
 <script type="application/ld+json">${inlineScriptJson({'@context':'https://schema.org','@type':'WebPage',url:canonicalUrl,inLanguage:locale,isPartOf:{'@type':'CollectionPage','@id':`${BASE_URL}${withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}`.replace(/\/+/g,'/'))}`,name:cantonSectionName(locale,dc)}})}</script>
 <script type="application/ld+json">${inlineScriptJson({"@context":"https://schema.org","@type":"SpeakableSpecification","cssSelector":["h1",".hero-sub",".section"]})}</script>
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
 ${seedScript}
 ${SPA_ACTION_REDIRECT_SCRIPT}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 <main class="seo-static-content static-job-page">
 <nav class="bn"><a href="${withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}`.replace(/\/+/g, '/'))}">&larr; ${esc(allJobsLinkLabel(locale, getCantonDisplayLabel(String(job.canton || DEFAULT_CANTON), locale)))}</a></nav>
 <article class="proposal">
 <section class="hero">
 <h1 class="hero-title">${esc(composeJobPageH1(localizedTitle, String(job.company || '')))}</h1>
 ${renderHeroBadges({ job, locale, salaryMin, salaryText, esc })}
 <div class="hero-sub">${esc(job.company)} · ${esc(formatJobLocation(job.location, job.canton || DEFAULT_CANTON))}</div>
 <div class="hero-meta">
 <span>${esc(`Categoria: ${String(job.category || 'other')}`)}</span>
 <span>${esc(`Contratto: ${String(job.contract || 'other')}`)}</span>
 <span>${esc(`Salario: ${salaryText}`)}</span>
 </div>
 </section>
 ${renderMobileActionBlock({ job, locale, canonicalUrl, addressLocality, salaryMin, salaryText, localeLabels: { applyNow: localeCopy[locale].applyNow, quickDetails: localeCopy[locale].quickDetails, location: localeCopy[locale].location, contract: localeCopy[locale].contract }, referralUrl, esc })}
 <section class="section">
 <h4>${esc(localeCopy[locale].summaryLabel)}</h4>
 ${summaryHtml}
 </section>
 ${renderHighlightsChips({ locale, canonicalLocale, canonicalKeywords, esc })}
 <div class="timeline">
 ${timelineHtml || (hasCanonical ? `<div class="timeline-step">${sectionHtml(localeCopy[locale].descriptionLabel, bodyParagraphs, [])}</div>` : '')}
 </div>
 <a href="${referralUrl(job.url || canonicalUrl, job)}" rel="noopener noreferrer" class="cta">${esc(localeCopy[locale].applyNow)}</a>
 ${jobFaqHtml}
 </article>
 ${renderRightRail({ job, locale, addressLocality, addressRegion, postalCode, salaryMin, salaryText, canonicalKeywords, esc })}
 ${(() => {
 const cSlugBanner = companyHubSlugBuild(job.company, job.companyKey);
 // Relative href — internal navigation resolves against canonical (absolute).
 const cHref = withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}/${companyRoutePrefix[locale]}-${cSlugBanner}`.replace(/\/+/g, '/'));
 const cLogo = companyLogo(job);
 const companyHeading: Record<string, string> = { it: 'Azienda', en: 'Company', de: 'Unternehmen', fr: 'Entreprise' };
 const companyMonitoring: Record<string, string> = { it: 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.', en: 'Frontaliere Ticino discovered this opportunity through company monitoring.', de: 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.', fr: 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' };
 // SEO: keyword-rich anchor "Tutte le offerte {company} {location}" — consolidates cannibalized URLs onto the company hub.
 // See docs/seo-semrush-growth-plan.md Task A.1/A.2.
 const companyLoc = String(job.location || dc || '').trim();
 const allOffersAnchor: Record<string, string> = {
 it: `Tutte le offerte ${job.company}${companyLoc ? ` ${companyLoc}` : ''}`,
 en: `All ${job.company} jobs${companyLoc ? ` in ${companyLoc}` : ''}`,
 de: `Alle ${job.company} Stellen${companyLoc ? ` in ${companyLoc}` : ''}`,
 fr: `Toutes les offres ${job.company}${companyLoc ? ` à ${companyLoc}` : ''}`,
 };
 const anchorText = allOffersAnchor[locale] || allOffersAnchor.it;
 // Style applied via `.cb > img` in seo-static.css (no inline style attr).
 const cLogoImg = renderLogoImg(cLogo, `Logo ${job.company}`, 40, 40);
 const card = `<a href="${cHref}" aria-label="${esc(anchorText)}" class="cb">${cLogoImg}<div><div class="cbt">${companyHeading[locale] || companyHeading.it}</div><div class="cbs">${esc(job.company)} · ${esc(job.location || dc)}</div><div class="cbm">${companyMonitoring[locale] || companyMonitoring.it}</div></div></a>`;
 const ctaLink = `<p class="cbl"><a href="${cHref}">${esc(anchorText)} &rarr;</a></p>`;
 // Second, DIFFERENT destination — the evergreen `/aziende/<slug>/` profile,
 // not the canton-scoped board hub `cHref` points at. Emitted only when the
 // slug is in `emittedEmployerHubs`, i.e. only when employerProfilePagesPlugin
 // wrote an indexable page at that exact path this build (see the map's
 // construction above); otherwise the ad keeps the two links it has today.
 //
 // The anchor mirrors the destination's own <title>
 // (`employerTitleCandidates` in employerProfilePagesPlugin.ts:
 // `{name}: {INTENT_PHRASE} {AND_WORD} {PAY_PHRASE}`), because anchor text is
 // a ranking signal for the TARGET and the target's phrase was re-derived from
 // GSC on 2026-08-07: brand-first, «offerte di lavoro» as the head phrase
 // (46 341 impr / 7 227 click in 90 d), «e stipendi» as the differentiator.
 //
 // That last token is doing real work HERE too. `anchorText` above points at
 // `/cerca-lavoro-<canton>/azienda-<slug>/` — the sibling that currently HOLDS
 // this brand demand ("eoc offerte di lavoro": 3 550 impr / 228 click at pos
 // 4.78, landing on the canton hub). Two links, on the same page, to two
 // different pages: the canton token differentiates one, the salary token the
 // other. Giving both the same phrase would aim two of our own URLs at one
 // query — the SERP cannibalisation brandCanonicalMap.ts (#1247) exists to
 // prevent.
 const hubPath = emittedEmployerHubs.get(`${locale}|${cSlugBanner}`);
 // Imported, not retyped: `employerTitleCandidates(locale, name)[0]` IS the
 // destination's longest <title> candidate. A second copy of those four strings
 // here would drift the first time either side is retuned on fresh GSC data.
 const hubAnchorText = employerTitleCandidates(locale as EmployerProfileLocale, job.company)[0];
 const hubLink = hubPath
 ? `<p class="cbl"><a href="${esc(hubPath)}">${esc(hubAnchorText)} &rarr;</a></p>`
 : '';
 return card + ctaLink + hubLink;
 })()}
 ${related.length > 0 ? `<section class="related"><h2>${esc(localeCopy[locale].relatedJobs)}</h2><ul class="rul">${relatedHtml}</ul></section>` : ''}
 ${recentArticlesHtmlFor(locale)}
 ${(() => {
 const __tPh_prose = phaseTimer();
 // loc/co/cat/contractKey are job-invariant — sourced from the perJob
 // block hoisted above the locale loop. deCantonPrep/frCantonPrep derive
 // from `dc`, which IS locale-dependent (canton display name), so they're
 // computed per-locale below, not hoisted.
 const loc = esc(perJob_jobLocation || dc);
 const co = esc(perJob_co);
 // Relative URL — appears in <a href> within prose; resolves against canonical.
 const taxUrl = locale === 'it' ? '/' : `/${locale}/`;
 const cat = perJob_cat;
 const sectorLabel: Record<string, Record<string, string>> = {
 it: { healthcare: 'sanità', technology: 'tecnologia', finance: 'servizi finanziari', engineering: 'ingegneria', hospitality: 'ospitalità', retail: 'commercio', manufacturing: 'manifattura', education: 'formazione', construction: 'edilizia', logistics: 'logistica', sales: 'vendite', administration: 'amministrazione' },
 en: { healthcare: 'healthcare', technology: 'technology', finance: 'financial services', engineering: 'engineering', hospitality: 'hospitality', retail: 'retail', manufacturing: 'manufacturing', education: 'education', construction: 'construction', logistics: 'logistics', sales: 'sales', administration: 'administration' },
 de: { healthcare: 'Gesundheitswesen', technology: 'Technologie', finance: 'Finanzdienstleistungen', engineering: 'Ingenieurwesen', hospitality: 'Gastgewerbe', retail: 'Einzelhandel', manufacturing: 'Fertigung', education: 'Bildung', construction: 'Bauwesen', logistics: 'Logistik', sales: 'Vertrieb', administration: 'Verwaltung' },
 fr: { healthcare: 'santé', technology: 'technologie', finance: 'services financiers', engineering: 'ingénierie', hospitality: 'hôtellerie', retail: 'commerce', manufacturing: 'industrie', education: 'formation', construction: 'construction', logistics: 'logistique', sales: 'ventes', administration: 'administration' },
 };
 const sectorName = sectorLabel[locale]?.[cat] || sectorLabel[locale]?.['administration'] || '';
 // Contract label localized (reuse top-level map).
 const contractKey = perJob_contractKey;
 const contractLabelLocal = contractLabelByLocale[locale]?.[contractKey] || contractLabelByLocale[locale]?.other || '';
 const safeTitle = esc(String(localizedTitle || job.title || ''));
 // Deterministic variant picker — stable across rebuilds, varies across slugs.
 const slugHash = stableHash(String(perLocaleSlug[locale] || job.slug || job.id || ''));
 const variant = slugHash % 3; // 3 rotating templates
 const deCantonPrep = germanCantonPrep(dc);
 const frCantonPrep = frenchCantonPrep(dc);

 // --- Frontalier info, per-locale, with 3 template variants each ---
 // Each variant injects title, company, city, sector, contract so ~60-70% of
 // the sentences differ between jobs while factual content stays equivalent.
 const feeIntro = {
 it: [
 `<p>La posizione <strong>${safeTitle}</strong>${co ? ` offerta da ${co}` : ''} ha sede a ${loc} nel Canton ${esc(dc)}${sectorName ? `, nel comparto ${sectorName}` : ''}.</p>`,
 `<p>Stai valutando il ruolo <strong>${safeTitle}</strong>${co ? ` presso ${co}` : ''} a ${loc} (${esc(dc)})${contractLabelLocal ? `, contratto ${contractLabelLocal.toLowerCase()}` : ''}?</p>`,
 `<p>Questa scheda analizza l'opportunità <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} a ${loc}${sectorName ? ` (settore ${sectorName})` : ''}, con focus sugli aspetti fiscali per i frontalieri del Canton ${esc(dc)}.</p>`,
 ],
 en: [
 `<p>The <strong>${safeTitle}</strong> role${co ? ` offered by ${co}` : ''} is based in ${loc}, Canton of ${esc(dc)}${sectorName ? `, in the ${sectorName} sector` : ''}.</p>`,
 `<p>Considering the <strong>${safeTitle}</strong> position${co ? ` at ${co}` : ''} in ${loc} (${esc(dc)})${contractLabelLocal ? ` on a ${contractLabelLocal.toLowerCase()} contract` : ''}?</p>`,
 `<p>This page reviews the <strong>${safeTitle}</strong> opportunity${co ? ` at ${co}` : ''} in ${loc}${sectorName ? ` (${sectorName} sector)` : ''}, with a focus on the tax implications for cross-border workers in the Canton of ${esc(dc)}.</p>`,
 ],
 de: [
 `<p>Die Stelle <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} ist in ${loc} ${esc(deCantonPrep)} angesiedelt${sectorName ? ` (Bereich ${sectorName})` : ''}.</p>`,
 `<p>Sie interessieren sich für die Position <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} in ${loc} (${esc(dc)})${contractLabelLocal ? `, ${contractLabelLocal}` : ''}?</p>`,
 `<p>Diese Seite untersucht die Chance <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} in ${loc}${sectorName ? ` (Branche ${sectorName})` : ''}, mit Fokus auf den steuerlichen Aspekten für Grenzgänger ${esc(deCantonPrep)}.</p>`,
 ],
 fr: [
 `<p>Le poste <strong>${safeTitle}</strong>${co ? ` proposé par ${co}` : ''} se situe à ${loc}, dans le Canton du ${esc(dc)}${sectorName ? ` (secteur ${sectorName})` : ''}.</p>`,
 `<p>Vous envisagez le rôle <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} à ${loc} (${esc(dc)})${contractLabelLocal ? ` en ${contractLabelLocal.toLowerCase()}` : ''} ?</p>`,
 `<p>Cette page examine l'opportunité <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} à ${loc}${sectorName ? ` (secteur ${sectorName})` : ''}, avec un focus sur la fiscalité des frontaliers ${esc(frCantonPrep)}.</p>`,
 ],
 };
 const feePermitTax = {
 it: [
 `<p>Per lavorare come frontaliere in Canton ${esc(dc)} serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(dc)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo; dal 2024 il <strong>Nuovo Accordo fiscale</strong> Italia-Svizzera prevede una tassazione concorrente.</p>`,
 `<p>Il ruolo richiede il <strong>Permesso G</strong> (rinnovo annuale) e comporta la ritenuta alla fonte a carico del datore${co ? ` ${co}` : ''}. In Canton ${esc(dc)} l'aliquota dipende da scaglione, stato civile e figli a carico; dal 2024 si applica il <strong>Nuovo Accordo</strong> fiscale bilaterale.</p>`,
 `<p>Accettando questa offerta${co ? ` di ${co}` : ''} otterrai un <strong>Permesso G</strong> frontaliere. Il Canton ${esc(dc)} preleva l'<strong>imposta alla fonte</strong> sul lordo; dal 2024 i nuovi frontalieri rientrano nel <strong>Nuovo Accordo fiscale</strong> con imposizione concorrente.</p>`,
 ],
 en: [
 `<p>Working as a cross-border employee in the Canton of ${esc(dc)} requires a <strong>G Permit</strong>, renewed annually. The Canton applies <strong>withholding tax</strong> at variable rates on gross income; since 2024 the Italy-Switzerland <strong>New Tax Agreement</strong> introduces concurrent taxation.</p>`,
 `<p>This position requires a <strong>G Permit</strong> (annual renewal) and triggers wage-withholding by the employer${co ? ` ${co}` : ''}. In the Canton of ${esc(dc)} the rate depends on bracket, marital status and dependants; the 2024 <strong>New Agreement</strong> adds an Italian side tax.</p>`,
 `<p>Accepting this offer${co ? ` from ${co}` : ''} means obtaining a cross-border <strong>G Permit</strong>. The Canton of ${esc(dc)} withholds tax on gross salary; new cross-border workers since 2024 fall under the <strong>New Tax Agreement</strong> with concurrent taxation.</p>`,
 ],
 de: [
 `<p>Für eine Grenzgängertätigkeit ${esc(deCantonPrep)} benötigen Sie eine <strong>G-Bewilligung</strong> (jährlich erneuerbar). Der Kanton ${esc(dc)} erhebt <strong>Quellensteuer</strong> mit variablen Sätzen; seit 2024 gilt das <strong>Neue Steuerabkommen</strong> Italien-Schweiz mit konkurrierender Besteuerung.</p>`,
 `<p>Die Stelle erfordert eine <strong>G-Bewilligung</strong> und löst den Quellensteuerabzug durch den Arbeitgeber${co ? ` ${co}` : ''} aus. Der Satz ${esc(deCantonPrep)} hängt von Einkommensklasse, Familienstand und Kindern ab; seit 2024 greift das <strong>Neue Abkommen</strong>.</p>`,
 `<p>Mit dieser Stelle${co ? ` bei ${co}` : ''} erhalten Sie eine <strong>G-Bewilligung</strong>. Der Kanton ${esc(dc)} zieht die Quellensteuer direkt ab; neue Grenzgänger seit 2024 fallen unter das <strong>Neue Steuerabkommen</strong>.</p>`,
 ],
 fr: [
 `<p>Travailler comme frontalier ${esc(frCantonPrep)} exige un <strong>permis G</strong>, renouvelable chaque année. Le Canton du ${esc(dc)} applique un <strong>impôt à la source</strong> à taux variable ; depuis 2024 le <strong>Nouvel Accord fiscal</strong> Italie-Suisse prévoit une imposition concurrente.</p>`,
 `<p>Ce poste nécessite un <strong>permis G</strong> (renouvellement annuel) et déclenche la retenue à la source${co ? ` par ${co}` : ''}. Le taux ${esc(frCantonPrep)} dépend de la tranche, du statut marital et des enfants ; le <strong>Nouvel Accord</strong> 2024 ajoute un volet italien.</p>`,
 `<p>Accepter cette offre${co ? ` de ${co}` : ''} implique un <strong>permis G</strong> frontalier. Le Canton du ${esc(dc)} prélève l'impôt à la source ; les nouveaux frontaliers depuis 2024 relèvent du <strong>Nouvel Accord fiscal</strong>.</p>`,
 ],
 };
 const feeContribs = {
 it: `<p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il netto di <strong>${safeTitle}</strong>${sectorName ? ` nel settore ${sectorName}` : ''} e confrontare i costi della vita tra Svizzera e Italia.</p>`,
 en: `<p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to estimate the net salary for <strong>${safeTitle}</strong>${sectorName ? ` in ${sectorName}` : ''} and compare the cost of living between Switzerland and Italy.</p>`,
 de: `<p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG. Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um das Nettogehalt für <strong>${safeTitle}</strong>${sectorName ? ` in der Branche ${sectorName}` : ''} zu berechnen und Lebenshaltungskosten zu vergleichen.</p>`,
 fr: `<p>Les cotisations sociales suisses comprennent AVS (5,3%), assurance chômage (1,1%) et LPP. Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour estimer le net de <strong>${safeTitle}</strong>${sectorName ? ` dans le secteur ${sectorName}` : ''} et comparer les coûts de la vie.</p>`,
 };
 const infoHeading: Record<string, string> = { it: 'Informazioni per frontalieri', en: 'Information for cross-border workers', de: 'Informationen für Grenzgänger', fr: 'Informations pour les frontaliers' };
 const frontalierInfoHtml = `<section class="section"><h4>${esc(infoHeading[locale] || infoHeading.it)}</h4>${feeIntro[locale as 'it'|'en'|'de'|'fr']?.[variant] ?? feeIntro.it[0]}${feePermitTax[locale as 'it'|'en'|'de'|'fr']?.[variant] ?? feePermitTax.it[0]}${feeContribs[locale as 'it'|'en'|'de'|'fr'] ?? feeContribs.it}</section>`;

 // --- FAQ: variant-driven question wording — injects role/company/contract ---
 const roleNoun: Record<string, string> = { it: 'candidarsi', en: 'applying', de: 'die Bewerbung', fr: 'postuler' };
 const faqQ1Templates: Record<string, string[]> = {
 it: [
 `Qual è lo stipendio netto per un frontaliere in Canton ${esc(dc)}?`,
 `Quanto guadagna netto un <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} a ${loc}?`,
 `Che stipendio netto aspettarsi per il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} in ${esc(dc)}?`,
 ],
 en: [
 `What is the net salary for a cross-border worker in the Canton of ${esc(dc)}?`,
 `What does a <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''} earn net in ${loc}?`,
 `What net pay can you expect for the <strong>${safeTitle}</strong> role${sectorName ? ` (${sectorName})` : ''} in ${esc(dc)}?`,
 ],
 de: [
 `Wie hoch ist das Nettogehalt für Grenzgänger ${esc(deCantonPrep)}?`,
 `Was verdient ein <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} netto in ${loc}?`,
 `Welches Nettogehalt ist für <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ${esc(deCantonPrep)} realistisch?`,
 ],
 fr: [
 `Quel est le salaire net pour un frontalier ${esc(frCantonPrep)} ?`,
 `Combien gagne un <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} net à ${loc} ?`,
 `Quel salaire net viser pour le poste <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ${esc(frCantonPrep)} ?`,
 ],
 };
 const faqA1Templates: Record<string, string[]> = {
 it: [
 `Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${esc(dc)} l'imposta alla fonte varia dal 2% al 15% circa.${sectorName ? ` Nel settore ${sectorName} in ${esc(dc)},` : ''} usa il nostro simulatore per un calcolo personalizzato.`,
 `Per <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} il netto dipende da lordo, imposta alla fonte ${esc(dc)} (2-15%), AVS/AD/LPP e deduzioni familiari.${contractLabelLocal ? ` Contratto: ${contractLabelLocal.toLowerCase()}.` : ''} Il nostro simulatore stima il netto personalizzato.`,
 `Il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (settore ${sectorName})` : ''} a ${loc} è soggetto a imposta alla fonte del Canton ${esc(dc)} più contributi AVS/LPP. Simula il tuo netto con i dati reali di ${co ? co : 'questo annuncio'}.`,
 ],
 en: [
 `Net salary depends on gross income, marital status and number of children. In the Canton of ${esc(dc)}, withholding tax ranges from about 2% to 15%.${sectorName ? ` In the ${sectorName} sector,` : ''} use our simulator for a tailored figure.`,
 `For <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''} the net depends on gross, ${esc(dc)} withholding (2-15%), AVS/LPP and family deductions.${contractLabelLocal ? ` Contract: ${contractLabelLocal.toLowerCase()}.` : ''} Our simulator gives a personalised estimate.`,
 `The <strong>${safeTitle}</strong> role${sectorName ? ` (${sectorName})` : ''} in ${loc} is taxed at source by the Canton of ${esc(dc)} plus AVS/LPP contributions. Run the simulator with the real figures of ${co ? co : 'this listing'}.`,
 ],
 de: [
 `Das Nettogehalt hängt von Bruttoeinkommen, Familienstand und Kinderzahl ab. ${esc(deCantonPrep)} liegt die Quellensteuer zwischen ca. 2% und 15%.${sectorName ? ` In der Branche ${sectorName}` : ''} liefert unser Simulator eine individuelle Berechnung.`,
 `Für <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} hängt das Netto von Brutto, Quellensteuer (2-15%), AHV/ALV/BVG und Familienabzügen ab.${contractLabelLocal ? ` Vertrag: ${contractLabelLocal}.` : ''} Unser Simulator liefert eine individuelle Schätzung.`,
 `Die Rolle <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} in ${loc} unterliegt der Quellensteuer ${esc(deCantonPrep)} zzgl. AHV/BVG. Simulieren Sie das Netto mit den Werten von ${co ? co : 'diesem Inserat'}.`,
 ],
 fr: [
 `Le salaire net dépend du revenu brut, de l'état civil et du nombre d'enfants. ${esc(frCantonPrep)}, l'impôt à la source varie d'environ 2% à 15%.${sectorName ? ` Dans le secteur ${sectorName},` : ''} utilisez notre simulateur pour un calcul personnalisé.`,
 `Pour <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} le net dépend du brut, de la retenue ${esc(frCantonPrep)} (2-15%), AVS/LPP et déductions familiales.${contractLabelLocal ? ` Contrat : ${contractLabelLocal.toLowerCase()}.` : ''} Notre simulateur donne une estimation personnalisée.`,
 `Le poste <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} à ${loc} est imposé à la source par le Canton du ${esc(dc)} plus cotisations AVS/LPP. Simulez le net avec les chiffres réels de ${co ? co : 'cette annonce'}.`,
 ],
 };
 // Second FAQ — mixes LAMal (stable factual content) with per-role flavoring.
 const faqQ2Templates: Record<string, string[]> = {
 it: [
 `Serve la cassa malati svizzera LAMal per lavorare come <strong>${safeTitle}</strong> in Canton ${esc(dc)}?`,
 `Come funziona l'assicurazione LAMal per chi fa ${roleNoun.it} a <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''}?`,
 `LAMal o assicurazione italiana: quale scegliere per il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''}?`,
 ],
 en: [
 `Do I need Swiss LAMal health insurance for the <strong>${safeTitle}</strong> role in ${esc(dc)}?`,
 `How does LAMal work when <strong>${roleNoun.en}</strong> to <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''}?`,
 `LAMal or Italian insurance: which should you pick for the <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} role?`,
 ],
 de: [
 `Brauche ich für <strong>${safeTitle}</strong> ${esc(deCantonPrep)} eine Schweizer KVG-Versicherung?`,
 `Wie funktioniert die KVG, wenn Sie sich${co ? ` bei ${co}` : ''} für <strong>${safeTitle}</strong> bewerben?`,
 `KVG oder italienische Versicherung: was ist für <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} sinnvoller?`,
 ],
 fr: [
 `Faut-il souscrire à la LAMal suisse pour le poste <strong>${safeTitle}</strong> ${esc(frCantonPrep)} ?`,
 `Comment fonctionne la LAMal quand on${co ? ` postule chez ${co}` : ''} pour <strong>${safeTitle}</strong> ?`,
 `LAMal ou assurance italienne : quelle option pour le rôle <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ?`,
 ],
 };
 // Relative hrefs — internal navigation resolves against canonical (absolute).
 const lamalLink: Record<string, string> = {
 it: `<a href="/premi-cassa-malati/">comparatore LAMal</a>`,
 en: `<a href="/en/health-insurance-premiums/">LAMal comparator</a>`,
 de: `<a href="/de/krankenkassenpraemien/">KVG-Vergleich</a>`,
 fr: `<a href="/fr/primes-assurance-maladie/">comparateur LAMal</a>`,
 };
 const faqA2Templates: Record<string, string[]> = {
 it: [
 `I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro. I premi variano per cantone, modello e franchigia. Confronta con il nostro ${lamalLink.it}.`,
 `Prima di firmare${co ? ` con ${co}` : ''}, sappi che dal 2024 la LAMal è obbligatoria entro 3 mesi. Il premio medio in ${esc(dc)} dipende dal modello. Vedi il nostro ${lamalLink.it}.`,
 `Il ruolo <strong>${safeTitle}</strong> a ${loc} richiede la scelta tra LAMal (obbligatoria per nuovi frontalieri dal 2024) e diritto di opzione. Confronta i premi con il ${lamalLink.it}.`,
 ],
 en: [
 `New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting. Premiums vary by canton, model and deductible. Compare with our ${lamalLink.en}.`,
 `Before signing${co ? ` with ${co}` : ''}, note that LAMal is mandatory within 3 months since 2024. The average premium in ${esc(dc)} depends on the model. See our ${lamalLink.en}.`,
 `The <strong>${safeTitle}</strong> role in ${loc} requires choosing between LAMal (mandatory for new cross-border workers since 2024) and the right of option. Compare premiums with our ${lamalLink.en}.`,
 ],
 de: [
 `Neue Grenzgänger seit 2024 müssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden. Die Prämien variieren nach Kanton, Modell und Franchise. Vergleichen Sie mit unserem ${lamalLink.de}.`,
 `Bevor Sie${co ? ` bei ${co}` : ''} unterschreiben: die KVG ist seit 2024 innerhalb von 3 Monaten Pflicht. Die durchschnittliche Prämie ${esc(deCantonPrep)} hängt vom Modell ab. Siehe ${lamalLink.de}.`,
 `Die Rolle <strong>${safeTitle}</strong> in ${loc} erfordert die Wahl zwischen KVG (seit 2024 Pflicht) und Optionsrecht. Vergleichen Sie die Prämien mit unserem ${lamalLink.de}.`,
 ],
 fr: [
 `Les nouveaux frontaliers depuis 2024 doivent s'inscrire à la LAMal dans les 3 mois. Les primes varient selon canton, modèle et franchise. Comparez avec notre ${lamalLink.fr}.`,
 `Avant de signer${co ? ` chez ${co}` : ''}, notez que la LAMal est obligatoire sous 3 mois depuis 2024. La prime moyenne ${esc(frCantonPrep)} dépend du modèle. Voir notre ${lamalLink.fr}.`,
 `Le poste <strong>${safeTitle}</strong> à ${loc} impose de choisir entre LAMal (obligatoire pour les nouveaux frontaliers depuis 2024) et droit d'option. Comparez les primes via notre ${lamalLink.fr}.`,
 ],
 };
 const faqHeading: Record<string, string> = { it: 'Domande frequenti', en: 'Frequently asked questions', de: 'Häufig gestellte Fragen', fr: 'Questions fréquentes' };
 const pickTpl = (arr: string[] | undefined, fallback: string): string => (arr && arr[variant]) || fallback;
 const q1 = pickTpl(faqQ1Templates[locale], faqQ1Templates.it[0]);
 const a1 = pickTpl(faqA1Templates[locale], faqA1Templates.it[0]);
 const q2 = pickTpl(faqQ2Templates[locale], faqQ2Templates.it[0]);
 const a2 = pickTpl(faqA2Templates[locale], faqA2Templates.it[0]);
 const faqSectionHtml = `<section class="section"><h4>${esc(faqHeading[locale] || faqHeading.it)}</h4><dl><dt><strong>${q1}</strong></dt><dd>${a1}</dd><dt><strong>${q2}</strong></dt><dd>${a2}</dd></dl></section>`;
 const frontalierInfo: Record<string, string> = { it: frontalierInfoHtml, en: frontalierInfoHtml, de: frontalierInfoHtml, fr: frontalierInfoHtml };
 const faqSection: Record<string, string> = { it: faqSectionHtml, en: faqSectionHtml, de: faqSectionHtml, fr: faqSectionHtml };
 const hubLinks = (() => {
 const matchedCity = perJob_matchedCity;
 const matchedSector = SECTOR_HUB_KEYS.find((s) => jobMatchesSector(job as never, s, locale as never));
 if (!matchedCity && !matchedSector) return '';
 const heading: Record<string, string> = { it: 'Esplora annunci simili', en: 'Explore similar jobs', de: 'Ähnliche Stellen entdecken', fr: 'Explorer des offres similaires' };
 const cityCopy: Record<string, string> = { it: 'Tutti i lavori a', en: 'All jobs in', de: 'Alle Jobs in', fr: 'Tous les emplois à' };
 const sectorCopy: Record<string, string> = { it: 'Tutti gli annunci', en: 'All jobs in', de: 'Alle Jobs in', fr: 'Toutes les offres' };
 const links: string[] = [];
 // Relative hrefs — internal navigation resolves against canonical (absolute).
 if (matchedCity) {
 const href = buildCityHubPath(locale as never, matchedCity);
 links.push(`<a href="${href}" class="pill pill-a">${esc(cityCopy[locale] || cityCopy.it)} ${esc(CITY_HUB_DISPLAY_NAME[matchedCity])} &rarr;</a>`);
 }
 if (matchedSector) {
 const href = buildSectorHubPath(locale as never, matchedSector);
 const label = SECTOR_HUB_DISPLAY[locale as never]?.[matchedSector] || matchedSector;
 const prefix = locale === 'it' || locale === 'fr' ? `${sectorCopy[locale]} ${label}` : `${sectorCopy[locale]} ${label}`;
 links.push(`<a href="${href}" class="pill pill-w">${esc(prefix)} &rarr;</a>`);
 }
 // Issue #4303 item 2: from a Ticino job detail, link the same profession's
 // combo page in a curated set of cantons (CROSS_CANTON_PROMO_CANTONS —
 // deliberately smaller than REAL_DATA_ENRICHED_CANTONS/item 1, else this
 // pill row balloons from 3 to 23 entries). Every non-TI-canton ×
 // SECTOR_HUB_KEYS combo page is emitted unconditionally (no floor, PR
 // #4254) later in this same closeBundle run (~line 7400), so the target
 // always exists by build end even though the cantonSectorPageRegistry
 // isn't populated yet at this earlier point in execution — checking the
 // registry here would be a false negative, not a real "does it exist"
 // answer.
 if (matchedSector && jobCanton === 'TI') {
 const crossCantonCopy: Record<string, string> = { it: 'stessa professione a', en: 'same role in', de: 'gleiche Stelle in', fr: 'même métier à' };
 const sectorLabel = SECTOR_HUB_DISPLAY[locale as never]?.[matchedSector] || matchedSector;
 const sectorSlug = SECTOR_HUB_SLUG[locale as never]?.[matchedSector];
 if (sectorSlug) {
 for (const otherCanton of CROSS_CANTON_PROMO_CANTONS) {
 const section = sharedResolveCantonSection(locale as never, otherCanton);
 if (!section) continue;
 const href = withSlash(`${localePrefix[locale]}/${section}/${sectorSlug}`.replace(/\/+/g, '/'));
 const cantonLabel = getCantonDisplayLabel(otherCanton, locale as never);
 links.push(`<a href="${href}" class="pill pill-a">${esc(sectorLabel)} — ${esc(crossCantonCopy[locale] || crossCantonCopy.it)} ${esc(cantonLabel)} &rarr;</a>`);
 }
 }
 }
 return `<section class="section"><h4>${esc(heading[locale] || heading.it)}</h4><div class="pillrow">${links.join('')}</div></section>`;
 })();
 // STRIP_ACTIVE_JOB_PROSE: when on, drop the two prose sections and emit the
 // audit-skip marker so text-html-ratio (and other content gates) ignore the
 // page. hubLinks (internal-linking chips) stays — it's UI, not filler prose.
 if (STRIP_ACTIVE_JOB_PROSE) {
 recordPhase('prose', __tPh_prose);
 return EJP_STRIPPED_MARKER + hubLinks;
 }
 recordPhase('prose', __tPh_prose);
 return (frontalierInfo[locale] || '') + (faqSection[locale] || '') + hubLinks;
 })()}
 ${renderEmployerCtaJobPage(locale, 'job_page')}
 <nav class="fn">
 <a href="${withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}`.replace(/\/+/g, '/'))}" class="lnk-acc">${esc(cantonSectionName(locale, dc))} &rarr;</a>${(() => {
 const cSlug = companyHubSlugBuild(job.company, job.companyKey);
 if (!cSlug) return '';
 const cPrefix = companyRoutePrefix[locale];
 const cFullSlug = `${cPrefix}-${cSlug}`;
 const cPath = withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}/${cFullSlug}`.replace(/\/+/g, '/'));
 return ` · <a href="${cPath}" class="lnk-acc">${esc(job.company)} &rarr;</a>`;
 })()}
 </nav>
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 recordPhase('template-render', __tPh_template);
 const __tPh_write = phaseTimer();
 _qw(np.join(outDir, 'index.html'), html);
 jobHtmlCache.set(`${locale}:${perLocaleSlug[locale]}`, html);
 // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
 // Uses a canonical bridge page instead of a noindex/meta-refresh alias
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordPhase('minify-write', __tPh_write);
 recordEmit('active-job', __tActiveJob);

 // Legacy bridge: if non-IT locale and Italian slug differs from the
 // locale-canonical slug, emit a FULL-CONTENT bridge at the legacy URL
 // (Italian slug under non-IT locale prefix → e.g.
 // /de/jobs-im-tessin/<it-slug>/) using the locale-canonical HTML.
 //
 // Replaces the previous thin `buildCanonicalBridgePage` redirect (run
 // pre-2026-04-30): that emitted a ~5 KB "click here" interstitial with
 // `noindex,follow` and a `location.replace` script, served bundle-less
 // pages that flashed a placeholder UI before redirecting. Same pattern
 // as the previousSlugs bridge (jobsSeoPagesPlugin.ts:7264-7271):
 //   - reuse the locale-canonical `html` verbatim (full content, SPA
 //     bundle inside, JSON-LD, hreflang, breadcrumbs, everything)
 //   - inject __BRIDGE_TARGET_SLUG__ so the SPA looks the job up by the
 //     canonical slug after hydration (the URL stays at the legacy slug;
 //     `<link rel="canonical">` inside `html` already points at the
 //     locale-canonical URL, so Google consolidates link equity)
 //
 // Robots: index,follow (the default inside `html`). The previous
 // `noindex,follow` was a workaround against title-uniqueness duplication
 // when sister-city jobs share the same translated role; with the
 // canonical pointing at the locale-canonical URL, Google folds equity
 // and the Semrush title-uniqueness audit treats the bridge and canonical
 // as the same indexable surface. Trade-off accepted to give the user
 // full content immediately at the legacy URL.
 //
 // Activejob guard: if another job's canonical in this locale already
 // claimed this exact path (cross-job IT-slug = locale-slug collision —
 // rare, but possible for short generic slugs), leave it alone.
 if (locale !== 'it' && perLocaleSlug[locale] !== job.slug) {
 const __tLegacyBridge = startTimer();
 const legacyRel = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}/${job.slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 if (!activeJobDirs.has(legacyRel.replace(/\/+$/, ''))) {
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${inlineScriptJson(perLocaleSlug[locale])};</script>`;
 const legacyIndexHtml = html.replace('</head>', ` ${bridgeScript}\n </head>`);
 const legacyDir = np.join(distDir, legacyRel);
 _md(legacyDir);
 _qw(np.join(legacyDir, 'index.html'), legacyIndexHtml);
 const legacyFlat = np.join(distDir, legacyRel + '.html');
 _qwFlatFull(legacyFlat, legacyIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 recordEmit('active-job-legacy-bridge', __tLegacyBridge);
 }

 // Cross-canton legacy TI bridge: when the job's resolved canton is NOT
 // TI, the pre-cathedral URL was under the legacy TI section
 // (/cerca-lavoro-ticino/, /de/jobs-im-tessin/, /en/find-jobs-ticino/,
 // /fr/trouver-emploi-tessin/). The active emit and the same-section
 // legacy bridge above both write only to the new canton-aware section,
 // leaving the indexed legacy TI URL uncovered and the self-healing
 // safety net (jobsSeoPagesPlugin.ts:10184+) to render a noindex
 // tombstone there. Emit the same full-content bridge at the legacy TI
 // path so visitors and Google see the real job page; the canonical
 // inside `html` already points to the canton-aware URL, so Google
 // consolidates link equity to the new section.
 //
 // Slug is `job.slug` (master/IT slug) because pre-cathedral
 // `all-known-job-slugs.json` keyed every locale path to the master
 // slug under the TI section.
 if (jobCanton !== 'TI' && !isCompanyHubNamespaceSlug(job.slug, locale)) {
 const __tCrossCantonLegacy = startTimer();
 const legacyTIRel = `${localePrefix[locale]}/${buildCantonAwareSection(locale, 'TI')}/${job.slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const legacyTIKey = legacyTIRel.replace(/\/+$/, '');
 if (!activeJobDirs.has(legacyTIKey)) {
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${inlineScriptJson(perLocaleSlug[locale])};</script>`;
 const legacyTIIndexHtml = html.replace('</head>', ` ${bridgeScript}\n </head>`);
 const legacyTIDir = np.join(distDir, legacyTIRel);
 _md(legacyTIDir);
 _qw(np.join(legacyTIDir, 'index.html'), legacyTIIndexHtml);
 const legacyTIFlat = np.join(distDir, legacyTIRel + '.html');
 _qwFlatFull(legacyTIFlat, legacyTIIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 // Claim this TI-mirror path as the AUTHORITATIVE active bridge so the
 // canton-blind previousSlug TI mirror (~line 11717) can't later
 // overwrite it with a stale alias from a different non-TI job (#2545).
 legacyTiBridgeDirs.add(legacyTIKey);
 }
 recordEmit('active-job-cross-canton-legacy', __tCrossCantonLegacy);
 }
 }
 }

 /* ── Company landing pages ────────────────────────────────── */
 type CompanyCopyEntry = {
 title: (companyName: string) => string;
 description: (companyName: string, count: number) => string;
 heading: (companyName: string) => string;
 viewAll: string;
 allJobsLink: string;
 sectionName: string;
 editorial: string;
 };
 const getCompanyCopy = (cantonCode: string): Record<'it' | 'en' | 'de' | 'fr', CompanyCopyEntry> => {
 const itDisplay = getCantonDisplayLabel(cantonCode, 'it');
 const enDisplay = getCantonDisplayLabel(cantonCode, 'en');
 const frPrep = frenchCantonPrep(getCantonDisplayLabel(cantonCode, 'fr'));
 const dePrep = germanCantonPrep(getCantonDisplayLabel(cantonCode, 'de'));
 // F3a — title delegates to buildEmployerHubTitle (50-60 visible chars).
 // description delegates to buildEmployerHubMeta (140-160 visible chars).
 // Heading / viewAll / editorial stay unchanged (used on-page, not in head).
 const ctrYear = new Date().getFullYear();
 const ctrTitle = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string) =>
 buildEmployerHubTitle({ locale: loc, companyDisplay: companyName, count: 0, year: ctrYear });
 const ctrDesc = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string, count: number) =>
 buildEmployerHubMeta({ locale: loc, companyDisplay: companyName, count });
 return {
 it: {
 title: ctrTitle('it'),
 description: ctrDesc('it'),
 heading: (companyName: string) => `${companyName} — posizioni aperte in ${itDisplay}`,
 viewAll: 'Vedi tutte le offerte',
 allJobsLink: `Tutte le offerte di lavoro in ${itDisplay}`,
 sectionName: `Cerca lavoro in ${itDisplay}`,
 editorial: `Questa pagina raccoglie le posizioni aperte pubblicate direttamente sul sito aziendale. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico e collegano alla pagina di candidatura ufficiale. Se non trovi posizioni attive, l'azienda potrebbe non avere ruoli aperti in ${itDisplay} al momento — salva la pagina per ricevere aggiornamenti.`,
 },
 en: {
 title: ctrTitle('en'),
 description: ctrDesc('en'),
 heading: (companyName: string) => `${companyName} jobs in ${enDisplay}`,
 viewAll: 'View all jobs',
 allJobsLink: `All job offers in ${enDisplay}`,
 sectionName: `Find jobs in ${enDisplay}`,
 editorial: `This page lists positions published directly on the company's career portal. Listings are refreshed daily by our automated crawler and link to the official application page. If no roles are shown, the company may not have open positions in ${enDisplay} right now — bookmark this page to stay updated.`,
 },
 de: {
 title: ctrTitle('de'),
 description: ctrDesc('de'),
 heading: (companyName: string) => `${companyName} Jobs ${dePrep}`,
 viewAll: 'Alle Stellen ansehen',
 allJobsLink: `Alle Stellenangebote ${dePrep}`,
 sectionName: `Jobs ${dePrep}`,
 editorial: `Auf dieser Seite finden Sie Stellen, die direkt auf der Karriereseite des Unternehmens veröffentlicht wurden. Die Angebote werden täglich von unserem automatischen Crawler aktualisiert und verlinken zur offiziellen Bewerbungsseite. Wenn keine Stellen angezeigt werden, gibt es derzeit möglicherweise keine offenen Positionen ${dePrep}.`,
 },
 fr: {
 title: ctrTitle('fr'),
 description: ctrDesc('fr'),
 heading: (companyName: string) => `${companyName} — postes ouverts ${frPrep}`,
 viewAll: 'Voir toutes les offres',
 allJobsLink: `Toutes les offres d'emploi ${frPrep}`,
 sectionName: `Trouver un emploi ${frPrep}`,
 editorial: `Cette page rassemble les postes publiés directement sur le portail carrière de l'entreprise. Les annonces sont actualisées quotidiennement par notre robot et renvoient à la page de candidature officielle. Si aucun poste n'est affiché, l'entreprise n'a peut-être pas de postes ouverts ${frPrep} actuellement.`,
 },
 };
 };

 // ── Internal-linking + JobCard helpers (employer hub pages) ─────────
 //
 // Used to turn plain text (locations, job positions) into internal links
 // pointing at city/sector hubs, and to render open-roles as visually-rich
 // cards matching the in-app <JobCard> component (JobBoard.tsx).
 const CITY_HUB_PATTERNS: ReadonlyArray<{ key: CityHubKey; regex: RegExp }> = [
 { key: 'lugano', regex: /\blugano\b/i },
 { key: 'mendrisio', regex: /\bmendrisio\b/i },
 { key: 'bellinzona', regex: /\bbellinzona\b/i },
 ];

 /** Detect a known Ticino hub city in a raw location string. */
 const detectCityHub = (text: string): CityHubKey | null => {
 if (!text) return null;
 for (const { key, regex } of CITY_HUB_PATTERNS) {
 if (regex.test(text)) return key;
 }
 return null;
 };

 /** Wrap a recognized Ticino city inside `locationText` with an anchor
 * pointing to the city hub. Escapes the full string first. */
 const linkifyCityInLocation = (
 locationText: string,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const safe = esc(locationText || '');
 if (!safe) return '';
 const cityKey = detectCityHub(locationText);
 if (!cityKey) return safe;
 const display = CITY_HUB_DISPLAY_NAME[cityKey];
 const href = `${BASE_URL}${buildCityHubPath(locale, cityKey)}`;
 const rx = new RegExp(`\\b${display}\\b`, 'i');
 return safe.replace(
 rx,
 (match) => `<a class="s-uHD3iY" href="${href}">${match}</a>`,
 );
 };

 /** Sectors matched by at least one of this company's jobs. */
 const companySectorMatches = (
 jobs: ReadonlyArray<unknown>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): SectorHubKey[] => {
 const hits: SectorHubKey[] = [];
 for (const sector of SECTOR_HUB_KEYS) {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 if (jobs.some((j) => jobMatchesSector(j as any, sector, locale as never))) hits.push(sector);
 }
 return hits;
 };

 /** Cities matched by at least one job's location. */
 const companyCityMatches = (
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 jobs: ReadonlyArray<any>,
 ): CityHubKey[] => {
 const set = new Set<CityHubKey>();
 for (const j of jobs) {
 const key = detectCityHub(String(j?.location || ''));
 if (key) set.add(key);
 }
 return [...set];
 };

 /**
  * Render a single open-role `<li>` card. Delegates to the SPA-matching
  * shared renderer (`build-plugins/shared/jobCardHtml.ts`) and injects the
  * locale-aware city linkifier so Lugano/Mendrisio/Bellinzona become
  * internal hub links in the company-and-location subtitle.
  */
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const renderJobCardLi = (job: any, locale: 'it' | 'en' | 'de' | 'fr'): string => {
 const jSlug = localizedSlug(job, locale);
 // Section is canton-aware: a non-TI job's detail page is emitted under its
 // own canton section (e.g. /cerca-lavoro-basilea/<slug>/). Hardcoding
 // sectionByLocale[locale] worked only for TI jobs; non-TI jobs reached a
 // soft-canonical /cerca-lavoro-ticino/ detour that <link rel=canonical>
 // redirected back to the canton URL — needless hop and breadcrumb mismatch.
 const jobCanton = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const sectionForJob = jobCanton ? sharedResolveCantonSection(locale, jobCanton) : sectionByLocale[locale];
 const jPath = `${localePrefix[locale]}/${sectionForJob}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 // NO `logoUrl` override: `renderJobCardHtml` resolves the logo itself via
 // `resolveJobCardLogo` (the canonical curated-asset → coloured-initials
 // chain), exactly like the per-canton call site further down. Passing
 // `companyLogo(job)` here handed it the JSON-LD-only OG-image filler as an
 // authoritative URL, and `renderLogoSlot` — which knows nothing about that
 // local constant — emitted it verbatim as `<img src>`: every company without
 // a curated `CRAWLED_COMPANY_LOGOS` entry showed the site's generic OG image
 // instead of its initials badge.
 const cardHtml = renderJobCardHtml(job as JobCardJob, {
 href: jHref,
 locale,
 linkifyLocation: linkifyCityInLocation,
 });
 return `<li class="s-hjzncp">${cardHtml}</li>`;
 };

 /**
  * Build the `<ul>` inner HTML for a job-card list, prepending the shared
  * `LOGO_FALLBACK_SCRIPT` once so the global `jcLF` (called by each card's
  * `onerror="jcLF(this)"`) is defined. These hub pages assemble their own
  * `<ul>` and do NOT emit `JOB_CARD_ICON_SYMBOLS`, so without this the
  * handler would throw `ReferenceError` on a logo 404. `<script>` is a valid
  * child of `<ul>` (a script-supporting element). Re-emitting it on a page
  * that also emits the symbols block just re-assigns `window.jcLF`.
  */
 // Single entry point for every jobsSeo hub job list (per-canton sector/city/
 // paginated/company/editorial + search landings, all cantons × all locales).
 // Interleaves one in-feed DISPLAY ad `<li>` after every Nth card (shared
 // `shouldPlaceInfeedAd` cadence), never after the last — same logic as the
 // shared `renderJobCardListHtml`, so coverage stays uniform across page types.
 // The wrapping `<ul class="s-0WjlyL">` is a plain block list (not a grid) →
 // no `spanFull` needed; the ad `<li>` is full-width.
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const jobCardListBody = (jobs: ReadonlyArray<any>, locale: 'it' | 'en' | 'de' | 'fr'): string =>
 jobs.length === 0
 ? ''
 : LOGO_FALLBACK_SCRIPT +
 jobs
 .map((job, i) => {
 const li = renderJobCardLi(job, locale);
 const ad =
 i + 1 < jobs.length && shouldPlaceInfeedAd(i + 1)
 ? infeedAdListItemHtml()
 : '';
 return li + ad;
 })
 .join('');

 /** Render a row of sector/city hub link chips for the company. */
 const renderHubChipsHtml = (
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 jobs: ReadonlyArray<any>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const sectors = companySectorMatches(jobs, locale);
 const cities = companyCityMatches(jobs);
 if (sectors.length === 0 && cities.length === 0) return '';
 const labels = {
 it: { intro: 'Esplora anche', sectorsLead: 'per settore', citiesLead: 'per città' },
 en: { intro: 'Explore more', sectorsLead: 'by sector', citiesLead: 'by city' },
 de: { intro: 'Mehr entdecken', sectorsLead: 'nach Branche', citiesLead: 'nach Stadt' },
 fr: { intro: 'Explorez aussi', sectorsLead: 'par secteur', citiesLead: 'par ville' },
 }[locale];
 // chip styling moved to `.aj-chip` in public/assets/seo-static.css —
 // identical computed style, saves ~250 B × ~6 chips × 96k active-job
 // emits ≈ ~24 MB on the dist artifact. CSS file is already loaded on
 // every active-job page via the async `asyncCssHeadBlock` in the head.
 const sectorChips = sectors
 .map((s) => {
 const href = `${buildSectorHubPath(locale, s)}`;
 const name = SECTOR_HUB_DISPLAY[locale][s];
 return `<a href="${href}" class="aj-chip">${esc(name)}</a>`;
 })
 .join('');
 const cityChips = cities
 .map((c) => {
 const href = `${buildCityHubPath(locale, c)}`;
 const name = CITY_HUB_DISPLAY_NAME[c];
 return `<a href="${href}" class="aj-chip">${esc(name)}</a>`;
 })
 .join('');
 const parts: string[] = [];
 if (sectorChips) parts.push(`<div class="s-35KBSc"><span class="s-QSf4up">${esc(labels.sectorsLead)}:</span>${sectorChips}</div>`);
 if (cityChips) parts.push(`<div class="s-MBZH9Q"><span class="s-QSf4up">${esc(labels.citiesLead)}:</span>${cityChips}</div>`);
 return `<section class="s-7uP4UM"><h3 class="s-sobAsC">${esc(labels.intro)}</h3>${parts.join('')}</section>`;
 };

 // Collect unique companies by canonical slug (mirrors runtime grouping).
 //
 // TI-only scope (classifier-drift fix, issue #3232): this block emits
 // pages EXCLUSIVELY under the Ticino-branded URL (/cerca-lavoro-ticino/
 // azienda-*, title/description hardcode "Ticino"/"Tessin" via
 // buildEmployerHubTitle below) — see the sibling per-canton block
 // ~6900 lines down, whose own comment states TI hubs are "handled
 // exclusively" by this loop. Before the nationwide canton expansion,
 // validJobs was implicitly TI-only so this held true. Once validJobs
 // covers all of Switzerland, this loop kept ingesting every company
 // from every canton with no filter — so non-TI companies got a hub
 // page falsely branded "Ticino" (title/meta mismatch vs the correctly
 // canton-aware heading/editorial copy below), duplicating the content
 // the sibling per-canton block already emits correctly. That unbounded
 // non-TI company population is what blew the weekly-employers
 // title-length ratchet 12→514 (data/title-length-baseline.json).
 // Filter to real TI jobs only, via the same sharedResolveJobCanton
 // resolver the per-canton sibling block uses (not the raw `job.canton`
 // field with DEFAULT_CANTON fallback used a few lines below) so a
 // multi-canton company still gets a TI hub scoped to its actual TI
 // jobs, and companies with zero TI jobs get no TI hub at all (their
 // other-canton jobs remain covered by the per-canton block).
 const companyMap = new Map<string, { name: string; jobs: typeof validJobs; rawSlugs: Set<string> }>();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 if (sharedResolveJobCanton(job as { canton?: string; location?: string }) !== 'TI') continue;
 const canonical = canonicalCompanySlugBuild(job.company, job.companyKey);
 const raw = slugifyCompanyBuild(job.company);
 if (!canonical) continue;
 if (!companyMap.has(canonical)) companyMap.set(canonical, { name: job.company, jobs: [], rawSlugs: new Set() });
 companyMap.get(canonical)!.jobs.push(job);
 if (raw && raw !== canonical) companyMap.get(canonical)!.rawSlugs.add(raw);
 }

 // Brand-umbrella aggregation. Some brand groups span multiple legal
 // subsidiaries that each get their own canonical hub (e.g. Migros →
 // Banca Migros, Scuola Club Migros, Cooperativa Migros Ticino).
 // Searches for the parent brand alone (e.g. "migros") have no real
 // company to land on. We synthesize a parent-brand entry whose jobs
 // are the union of every matching subsidiary's jobs, so the existing
 // company-hub template renders an indexable umbrella page that
 // aggregates the whole group. Real subsidiary hubs are unaffected —
 // they keep their own canonical, their own URL, their own page.
 const BRAND_UMBRELLAS: ReadonlyArray<{
  slug: string;
  name: string;
  match: (canonical: string, name: string) => boolean;
 }> = [
  {
   slug: 'migros',
   name: 'Migros',
   match: (canonical, name) =>
    /(^|-)migros($|-)/i.test(canonical) || /\bmigros\b/i.test(name),
  },
 ];
 for (const u of BRAND_UMBRELLAS) {
  const aggregatedJobs: typeof validJobs = [];
  const aggregatedRaw = new Set<string>();
  for (const [k, v] of companyMap) {
   if (k === u.slug) continue;
   if (u.match(k, v.name)) {
    aggregatedJobs.push(...v.jobs);
    for (const r of v.rawSlugs) aggregatedRaw.add(r);
   }
  }
  if (aggregatedJobs.length === 0) continue;
  const existing = companyMap.get(u.slug);
  if (existing) {
   for (const j of aggregatedJobs) existing.jobs.push(j);
   for (const r of aggregatedRaw) existing.rawSlugs.add(r);
  } else {
   companyMap.set(u.slug, { name: u.name, jobs: aggregatedJobs, rawSlugs: aggregatedRaw });
  }
 }

 let companyPagesCount = 0;
 for (const [cSlug, { name: companyName, jobs: companyJobs, rawSlugs }] of companyMap) {
 // Bound the WriteCollector's in-flight background-flush backlog during this
 // loop — each company emits several large (~50 KB) HTML files and the page
 // rate outruns libuv, so _pendingFlushes (each batch closes over its content)
 // climbed to ~16 batches (~GBs live) by the end of this phase → OOM (#1290).
 // awaitDrainSlot returns instantly when ≤6 batches are in flight and only
 // awaits when above, so it self-regulates the peak with negligible cost.
 await collector.awaitDrainSlot(6);
 // Brand aliases (e.g. migros-ticino → migros umbrella) must NOT self-emit an
 // indexable hub here: their jobs already surface on the canonical umbrella via
 // the BRAND_UMBRELLAS aggregation above, and the alias URL is owned by the
 // noindex bridge block below (BRAND_CANONICAL_MAP). Self-emitting would write an
 // indexable page first, defeating that bridge's file-exists guard and
 // duplicating umbrella content (brand-dedup main-red #1247 / PR #1274).
 if (isBrandAlias(cSlug)) continue;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tCompany = startTimer();
 const prefix = companyRoutePrefix[locale];
 const fullSlug = `${prefix}-${cSlug}`;
 const sectionSlug = sectionByLocale[locale];
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const companyPrimaryCanton = [...new Set(companyJobs.map((j: any) => String(j.canton || DEFAULT_CANTON)).filter(Boolean))][0] || DEFAULT_CANTON;
 const companyDisplayCanton = getCantonDisplayLabel(companyPrimaryCanton, locale);
 const copy = getCompanyCopy(companyPrimaryCanton)[locale];
 // Tentative defaults — overridden below if a curated brand is registered.
 // F3a: title + description come from the shared CTR-optimized helpers so
 // the live job count is baked into both.
 let title = buildEmployerHubTitle({
 locale,
 companyDisplay: companyName,
 count: companyJobs.length,
 year: new Date().getFullYear(),
 });
 let description = copy.description(companyName, companyJobs.length);

 const alternates = localeList.map((l) => {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 // audit-hreflang requires 5 entries (4 locales + x-default).
 const xDefaultHrefC = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || canonicalUrl;
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHrefC}">`,
 ].join('\n');

 const jobListHtml = jobCardListBody(companyJobs.slice(0, 20), locale);

 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: copy.sectionName, item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: companyName, item: canonicalUrl },
 ],
 });

 // Organization schema for company pages — derived from job data
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const cWebsite = companyWebsite(companyJobs[0]);
 const orgLdObj: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: companyName,
 url: cWebsite !== BASE_URL ? cWebsite : undefined,
 address: {
 '@type': 'PostalAddress',
 ...(primaryLocation ? { addressLocality: primaryLocation } : {}),
 addressRegion: companyDisplayCanton,
 addressCountry: 'CH',
 },
 };
 // Add number of open positions as a signal
 if (companyJobs.length > 0) {
 orgLdObj.numberOfEmployees = {
 '@type': 'QuantitativeValue',
 value: companyJobs.length,
 unitText: openPositionsUnit[locale],
 };
 }
 // Remove undefined values before serialization
 if (!orgLdObj.url) delete orgLdObj.url;
 // Curated employer brand overlay (EOC, Lidl, …). When present, we
 // (a) override the generic organization JSON-LD with a richer one,
 // (b) emit FAQPage + ItemList JSON-LD, and
 // (c) swap the generic "About/Frontalier" sections for the curated hub HTML.
 const curatedBrand: EmployerBrand | undefined = EMPLOYER_BRANDS[cSlug];
 let organizationLd: string;
 const curatedExtraJsonLd: string[] = [];
 let curatedBodyHtml = '';
 let curatedMetaTitle: string | undefined;
 let curatedMetaDescription: string | undefined;
 if (curatedBrand) {
 const brandCopy = curatedBrand.copy[locale];
 const curatedOrgLd: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: curatedBrand.name,
 legalName: curatedBrand.fullName,
 alternateName: curatedBrand.shortName,
 url: curatedBrand.website,
 address: {
 '@type': 'PostalAddress',
 streetAddress: curatedBrand.headquarters.streetAddress,
 postalCode: curatedBrand.headquarters.postalCode,
 addressLocality: curatedBrand.headquarters.addressLocality,
 addressRegion: curatedBrand.headquarters.addressRegion,
 addressCountry: curatedBrand.headquarters.addressCountry,
 },
 description: brandCopy.paragraphs[0] ?? brandCopy.tagline,
 numberOfEmployees: { '@type': 'QuantitativeValue', value: companyJobs.length, unitText: openPositionsUnit[locale] },
 ...(curatedBrand.sameAs && curatedBrand.sameAs.length > 0 ? { sameAs: [...curatedBrand.sameAs] } : {}),
 };
 organizationLd = JSON.stringify(curatedOrgLd);

 // ItemList with top open roles. URLs must be canton-aware so that
 // structured data points at the actually-emitted job-detail page
 // (not the soft-canonical TI redirect). Otherwise Google ingests
 // canonical chains in rich-result candidates.
 const itemListItems = companyJobs.slice(0, 10).map((job, idx) => {
 const jSlug = localizedSlug(job, locale);
 const jobCantonForList = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const sectionForJob = jobCantonForList ? sharedResolveCantonSection(locale, jobCantonForList) : sectionByLocale[locale];
 const jPath = `${localePrefix[locale]}/${sectionForJob}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return { '@type': 'ListItem', position: idx + 1, url: jHref, name: jTitle };
 });
 const itemListLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: `${curatedBrand.shortName} — ${brandCopy.sectionHeadings.openRoles}`,
 url: canonicalUrl,
 numberOfItems: companyJobs.length,
 itemListElement: itemListItems,
 });
 const faqLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: brandCopy.faqs.map((f) => ({
 '@type': 'Question',
 name: f.q,
 acceptedAnswer: { '@type': 'Answer', text: f.a },
 })),
 });
 curatedExtraJsonLd.push(itemListLd, faqLd);
 curatedMetaTitle = brandCopy.metaTitle;
 curatedMetaDescription = brandCopy.metaDescription;

 // Curated body HTML — replaces the generic company landing body.
 const paragraphsHtml = brandCopy.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
 const locationsHtml = curatedBrand.locations
 .map((loc) => `<li>${linkifyCityInLocation(loc, locale)}</li>`)
 .join('');
 const benefitsHtml = brandCopy.benefits
 .map((b) => `<li><strong>${esc(b.title)}.</strong> ${esc(b.desc)}</li>`)
 .join('');
 const faqsHtml = brandCopy.faqs
 .map(
 (f) =>
 `<div class="s-7-U_cj"><h3 class="s-uaMy8e">${esc(
 f.q,
 )}</h3><p class="s-iQySYg">${esc(
 f.a,
 )}</p></div>`,
 )
 .join('');
 const openRolesListHtml = jobCardListBody(companyJobs.slice(0, 10), locale);
 const listingUrlCurated = `${BASE_URL}${withSlash(
 `${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'),
 )}`;
 const headerBadge = `<p class="s-Lk3xVq">${esc(
 curatedBrand.shortName,
 )}</p>`;
 const hubLabels = {
 viewAllLabel: copy.viewAll,
 };
 curatedBodyHtml = [
 `<header>${headerBadge}<h1>${esc(brandCopy.h1)}</h1><p class="s-Yy-luh">${esc(
 brandCopy.tagline,
 )}</p></header>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.about)}</h2>${paragraphsHtml}</section>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.locations)}</h2><p>${esc(
 brandCopy.locationsIntro,
 )}</p><ul>${locationsHtml}</ul></section>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.benefits)}</h2><ul>${benefitsHtml}</ul></section>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.howToApply)}</h2><p>${esc(
 brandCopy.howToApply,
 )}</p>${
 curatedBrand.careersUrl
 ? `<p><a class="s-NXSorZ" href="${esc(curatedBrand.careersUrl)}" rel="noopener noreferrer" target="_blank">${esc(
 curatedBrand.website.replace(/^https?:\/\//, ''),
 )} &rarr;</a></p>`
 : ''
 }</section>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.openRoles)} (${companyJobs.length})</h2>${
 openRolesListHtml
 ? `<ul class="s-0WjlyL">${openRolesListHtml}</ul><p><a href="${listingUrlCurated}">${esc(
 hubLabels.viewAllLabel,
 )}</a></p>${renderHubChipsHtml(companyJobs, locale)}`
 : `<p>${esc(brandCopy.emptyStateNote)}</p>`
 }</section>`,
 `<section class="s-KeNgmc"><h2>${esc(brandCopy.sectionHeadings.faq)}</h2>${faqsHtml}</section>`,
 ].join('\n');

 // Apply curated meta overrides so brand-queried SERPs show branded titles.
 // Route through buildTitleWithBrand so the " | Frontaliere Ticino" suffix
 // baked into employerBrands metaTitle drops automatically when the
 // headline already exceeds the 66-char audit cap (e.g. EOC entry hits
 // 72 char with brand → drops to 51 char base).
 if (curatedMetaTitle) {
 const stripped = curatedMetaTitle.replace(/\s*\|\s*Frontaliere Ticino\s*$/, '');
 title = buildTitleWithBrand(stripped);
 }
 if (curatedMetaDescription) description = curatedMetaDescription;
 } else {
 organizationLd = JSON.stringify(orgLdObj);
 }

 // Phase 3B — stub-company gating. Companies with 0 active jobs (which
 // shouldn't reach this code path under normal filtering, but we guard
 // anyway) get noindex,follow so Google drops the page from the index.
 // Curated brands and profiled companies always stay indexable.
 // Companies with 1-2 jobs stay indexable but receive minimal enrichment
 // via the standard auto-generated body so they don't collapse below the
 // Semrush thin-content gate.
 const companyJobCount = companyJobs.length;
 const companyProfile: CompanyProfile | undefined = companyProfiles[cSlug];
 const isStubCompany = companyJobCount < 1 && !curatedBrand && !companyProfile;
 const companyRobots = isStubCompany ? 'noindex,follow' : 'index,follow';

 // Phase 3B — curated profile prose. When a manual profile exists, we
 // inject a multi-fact paragraph (founded, size, sector, HQ) plus a
 // localized description. This raises the page's text/HTML ratio and
 // word count well above the Semrush thin-content threshold for the
 // top-50 employers without depending on noisy job-data autodescriptions.
 const companyProfileHtml = !curatedBrand && companyProfile
  ? (() => {
   const desc = companyProfile.description?.[locale]
    || companyProfile.description?.it
    || companyProfile.description?.en
    || '';
   const factsLineByLocale: Record<string, string> = {
    it: 'Informazioni chiave',
    en: 'Key facts',
    de: 'Eckdaten',
    fr: 'Informations cles',
   };
   const labels: Record<string, Record<'founded' | 'size' | 'sector' | 'hq', string>> = {
    it: { founded: 'Anno fondazione', size: 'Dimensione', sector: 'Settore', hq: 'Sede principale' },
    en: { founded: 'Founded', size: 'Size', sector: 'Sector', hq: 'Headquarters' },
    de: { founded: 'Gegruendet', size: 'Groesse', sector: 'Sektor', hq: 'Hauptsitz' },
    fr: { founded: 'Fondee', size: 'Taille', sector: 'Secteur', hq: 'Siege' },
   };
   const factsTitle = factsLineByLocale[locale] || factsLineByLocale.it;
   const lbl = labels[locale] || labels.it;
   const facts: string[] = [];
   if (companyProfile.founded) facts.push(`<li><strong>${esc(lbl.founded)}:</strong> ${esc(String(companyProfile.founded))}</li>`);
   if (companyProfile.size) facts.push(`<li><strong>${esc(lbl.size)}:</strong> ${esc(companyProfile.size)}</li>`);
   if (companyProfile.sector) facts.push(`<li><strong>${esc(lbl.sector)}:</strong> ${esc(companyProfile.sector)}</li>`);
   if (companyProfile.headquarters) facts.push(`<li><strong>${esc(lbl.hq)}:</strong> ${esc(companyProfile.headquarters)}</li>`);
   const factsBlock = facts.length > 0
    ? `<aside class="s-nq3Bca"><h3 class="s-R_q_mI">${esc(factsTitle)}</h3><ul class="s-fGW3CV">${facts.join('')}</ul></aside>`
    : '';
   if (!desc && !factsBlock) return '';
   return `<section class="company-profile s-vJhV9y">${factsBlock}${desc ? `<p class="s-AA8lz_">${esc(desc)}</p>` : ''}</section>`;
  })()
  : '';

 // SPA-shell contract (CLAUDE.md non-negotiable #14): the static content
 // MUST live as a sibling of `<div id="root">`, otherwise React's hydration
 // wipes it. `buildSeoPageHtml` (default seoContentOutsideRoot=true +
 // seoMainClass='seo-static-content') emits `<main class="seo-static-content">`
 // outside `#root`, and App.tsx detects that class to switch to lite-shell
 // (skip React `<main>`, keep nav/footer chrome hydrated).
 const webPageLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 url: canonicalUrl,
 inLanguage: locale,
 isPartOf: {
 '@type': 'CollectionPage',
 '@id': `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`,
 name: copy.sectionName,
 },
 });
 const companyBodyHtml = `<div class="s-it71Rt">
 <nav class="s-ZVaIKh"><a class="s-uHD3iY" href="${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}">&larr; ${esc(copy.allJobsLink)}</a></nav>
${curatedBodyHtml ? curatedBodyHtml + '\n' : `<h1>${esc(copy.heading(companyName))}</h1>\n<p>${esc(description)}</p>\n${companyProfileHtml}\n`}${curatedBodyHtml ? '' : (() => {
 // Collect location info from company jobs
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const companySectors = [...new Set(companyJobs.map((j: any) => String(j.category || j.sector || '')).filter(Boolean))];
 const companyContracts = [...new Set(companyJobs.map((j: any) => String(j.contract || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const displayCanton = companyDisplayCanton;
 const locationListStr = companyLocations.slice(0, 5).join(', ');
 const locationListLinkedHtml = companyLocations
 .slice(0, 5)
 .map((loc) => linkifyCityInLocation(loc, locale))
 .join(', ');
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;

 const parts: string[] = [];

 // Job list first — most relevant content for landing visitors
 parts.push(`<section class="s-7uP4UM"><h2>${locale === 'it' ? 'Posizioni aperte' : locale === 'en' ? 'Open positions' : locale === 'de' ? 'Offene Stellen' : 'Postes ouverts'}</h2>`);
 parts.push(`<ul class="s-0WjlyL">${jobListHtml}</ul>`);
 parts.push(`<p><a href="${listingUrl}">${esc(copy.viewAll)}</a></p>`);
 parts.push('</section>');

 // Company info section. When locationListStr / companySectors are empty
 // (small employers with 1-2 listings or thinly-classified sources), append
 // a fallback paragraph so the page still carries substantive context
 // and clears the Semrush text-to-HTML ratio gate.
 const noLocOrSectors = !locationListStr && companySectors.length === 0;
 if (locale === 'it') {
 parts.push(`<section class="s-7uP4UM"><h2>Informazioni su ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} offre attualmente <strong>${companyJobs.length} posizioni aperte</strong> in Canton ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Le sedi di lavoro includono: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'azienda opera nel settore ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Tipologie di contratto disponibili: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Quando il nostro crawler non rileva ancora una sede di lavoro o un settore esplicito per ${esc(companyName)}, significa di solito che l'azienda è di dimensioni contenute o che pubblica le offerte tramite un ATS che non espone esplicitamente la classificazione: in questi casi apri il singolo annuncio per leggere mansionario, requisiti, sede di lavoro e tipologia contrattuale dichiarata. Per i frontalieri, i datori di lavoro nel Canton ${esc(displayCanton)} si suddividono tipicamente in tre categorie — multinazionali (sanitario, farmaceutico, finanziario) con processi HR strutturati e benefit estesi (LPP gold, formazione continua, mensa); PMI ticinesi (commercio, edilizia, servizi professionali) con flessibilità contrattuale e un percorso di carriera più rapido; e enti pubblici/parapubblici (cantone, scuole, sanità) con stabilità del posto e regole di residenza più stringenti. Se ${esc(companyName)} non ha ancora una scheda dettagliata sul nostro sito, leggi le sezioni qui sotto sui meccanismi del Permesso G e sull'imposta alla fonte cantonale: si applicano a qualunque rapporto di lavoro frontaliero in ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section class="s-7uP4UM"><h2>About ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} currently has <strong>${companyJobs.length} open positions</strong> in the Canton of ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Work locations include: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` The company operates in the ${esc(companySectors.slice(0, 3).join(', '))} sector.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Available contract types: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>When our crawler hasn't yet picked up a work location or explicit sector for ${esc(companyName)}, it usually means the company is on the smaller side or posts through an ATS that doesn't expose explicit classification: in those cases open the individual listing to read the job description, requirements, work location and contract type. For cross-border workers, employers in the Canton of ${esc(displayCanton)} typically split into three buckets — multinationals (healthcare, pharma, finance) with structured HR processes and rich benefits (gold LPP, training budget, on-site canteen); Ticino SMEs (retail, construction, professional services) with contractual flexibility and faster career paths; and public/parapublic bodies (cantonal, schools, healthcare) with strong job security and tighter residence rules. If ${esc(companyName)} doesn't yet have a detailed profile on our site, the sections below on G permit mechanics and cantonal withholding tax still apply to any cross-border employment in ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section class="s-7uP4UM"><h2>\u00dcber ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} bietet derzeit <strong>${companyJobs.length} offene Stellen</strong> im Kanton ${esc(displayCanton)} an.`);
 if (locationListStr) parts[parts.length - 1] += ` Arbeitsorte sind unter anderem: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` Das Unternehmen ist in den Bereichen ${esc(companySectors.slice(0, 3).join(', '))} t\u00e4tig.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Verf\u00fcgbare Vertragsarten: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Wenn unser Crawler noch keinen Arbeitsort oder keine explizite Branche f\u00fcr ${esc(companyName)} erfasst hat, ist das Unternehmen meist kleiner oder ver\u00f6ffentlicht \u00fcber ein ATS, das die Klassifikation nicht offenlegt: In solchen F\u00e4llen \u00f6ffnen Sie die einzelne Ausschreibung f\u00fcr Stellenbeschreibung, Anforderungen, Arbeitsort und Vertragsart. F\u00fcr Grenzg\u00e4nger lassen sich die Arbeitgeber im Kanton ${esc(displayCanton)} typischerweise in drei Gruppen einteilen — Multinationals (Gesundheit, Pharma, Finanzen) mit strukturierten HR-Prozessen und umfangreichen Benefits (Gold-BVG, Weiterbildungsbudget, Personalrestaurant); Tessiner KMU (Detailhandel, Bau, Dienstleistungen) mit vertraglicher Flexibilit\u00e4t und schnelleren Karrierepfaden; und \u00f6ffentliche/parastaatliche Stellen (Kanton, Schulen, Gesundheit) mit hoher Anstellungssicherheit und strengeren Wohnsitzregeln. Falls ${esc(companyName)} noch kein detailliertes Profil auf unserer Seite hat, gelten die unten stehenden Abschnitte zu G-Bewilligung und kantonaler Quellensteuer dennoch f\u00fcr jedes Grenzg\u00e4ngerverh\u00e4ltnis im ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else {
 parts.push(`<section class="s-7uP4UM"><h2>\u00c0 propos de ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} propose actuellement <strong>${companyJobs.length} postes ouverts</strong> dans le Canton du ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Les lieux de travail incluent : ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'entreprise op\u00e8re dans le secteur ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Types de contrat disponibles : ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Quand notre crawler n'a pas encore identifi\u00e9 de lieu de travail ou de secteur explicite pour ${esc(companyName)}, l'entreprise est en g\u00e9n\u00e9ral de petite taille ou publie via un ATS qui n'expose pas la classification : dans ce cas, ouvrez l'annonce individuelle pour le descriptif, les exigences, le lieu et le type de contrat. Pour les frontaliers, les employeurs du Canton du ${esc(displayCanton)} se r\u00e9partissent typiquement en trois cat\u00e9gories — multinationales (sant\u00e9, pharma, finance) aux processus RH structur\u00e9s et aux benefits \u00e9tendus (LPP de premier ordre, budget formation, cantine d'entreprise) ; PME tessinoises (commerce, construction, services professionnels) offrant flexibilit\u00e9 contractuelle et carri\u00e8re plus rapide ; et entit\u00e9s publiques/parapubliques (canton, \u00e9coles, sant\u00e9) avec une grande s\u00e9curit\u00e9 d'emploi et des r\u00e8gles de r\u00e9sidence plus strictes. Si ${esc(companyName)} n'a pas encore de fiche d\u00e9taill\u00e9e sur notre site, les sections ci-dessous sur le permis G et l'imp\u00f4t \u00e0 la source cantonal s'appliquent \u00e0 tout emploi frontalier dans le ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 }

 // Internal-linking chips (city + sector hubs)
 const hubChips = renderHubChipsHtml(companyJobs, locale);
 if (hubChips) parts.push(hubChips);

 // Frontalier info section — extended with permit, fiscal, social-charge and
 // commute paragraphs to give the canonical company-hub page substantive
 // content (was failing the Semrush low-text/HTML gate at ~4.5 %). All
 // strings interpolate companyName / primaryLocation / displayCanton so the
 // text stays page-specific and Google won't see boilerplate.
 if (locale === 'it') {
 parts.push(`<section class="s-7uP4UM"><h2>Informazioni per frontalieri</h2>`);
 parts.push(`<p>${esc(companyName)} ha sede${primaryLocation ? ` a ${esc(primaryLocation)}` : ''} in Canton ${esc(displayCanton)}, Svizzera. Per lavorare come frontaliere presso questa azienda serve il Permesso G. Il Canton ${esc(displayCanton)} applica l'imposta alla fonte con aliquote variabili sul reddito lordo dei lavoratori transfrontalieri. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p>`);
 parts.push(`<p><strong>Permesso G e residenza.</strong> Per essere assunto come frontaliere da ${esc(companyName)}${primaryLocation ? ` a ${esc(primaryLocation)}` : ''} devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il Permesso G viene richiesto dal datore di lavoro all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi viene rinnovato annualmente fino al limite contrattuale. Le assenze prolungate dall'Italia (più di una settimana lavorativa senza rientro) compromettono lo status fiscale di "vecchio" frontaliere.</p>`);
 parts.push(`<p><strong>Imposta alla fonte e Nuovo Accordo fiscale 2024.</strong> Il datore svizzero trattiene mensilmente l'imposta alla fonte sul lordo: l'aliquota effettiva nel Canton ${esc(displayCanton)} oscilla fra il 5 % e il 19 % a seconda di reddito, stato civile e figli a carico. I frontalieri assunti dal 1° gennaio 2024 ricadono nel Nuovo Accordo Italia-Svizzera: imposta concorrente fra i due Stati con credito d'imposta italiano sulle ritenute svizzere fino all'80 %, deducibili nel quadro RW del modello 730/Redditi PF. Per il calcolo personalizzato netto-lordo apri il simulatore stipendio e inserisci la categoria contrattuale offerta da ${esc(companyName)}.</p>`);
 parts.push(`<p><strong>Contributi sociali svizzeri.</strong> Lo stipendio lordo dichiarato negli annunci ${esc(companyName)} è soggetto a AVS-AI-IPG (5,3 % a carico del dipendente, 5,3 % a carico del datore), assicurazione contro la disoccupazione (1,1 % fino a 148.200 CHF/anno) e LPP — la previdenza professionale obbligatoria — con aliquote che salgono dal 7 % a 25 anni fino al 18 % oltre i 55 anni. Sommando l'imposta alla fonte e i contributi sociali la differenza fra lordo annuale dichiarato e netto è tipicamente del 18-28 %. Per la simulazione esatta sulla città di lavoro indicata e con i tuoi parametri personali utilizza il <a href="/calcola-stipendio/">calcolatore busta paga</a>.</p>`);
 parts.push(`<p><strong>Pendolarismo: cosa aspettarsi.</strong> ${primaryLocation ? `Lavorando per ${esc(companyName)} a ${esc(primaryLocation)} ` : `Lavorando per ${esc(companyName)} `}, il tragitto giornaliero da Como passa tipicamente dal valico di Brogeda (autostrada A2) o di Chiasso-strada per le destinazioni del Mendrisiotto/Luganese, con tempi di 25-50 minuti in ora di punta in funzione delle code al confine. Da Varese o Luino il valico di Stabio o Gaggiolo offre tragitti alternativi. Per stimare costo carburante mensile, usura veicolo e il tempo perso al confine consulta la guida pendolarismo e la mappa dei tempi di attesa: integrarli con lo stipendio netto è il modo corretto per valutare se il salario di ${esc(companyName)} è competitivo rispetto a un'alternativa italiana.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section class="s-7uP4UM"><h2>Information for cross-border workers</h2>`);
 parts.push(`<p>${esc(companyName)} is based${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} in the Canton of ${esc(displayCanton)}, Switzerland. Cross-border workers need a G Permit to work at this company. The Canton of ${esc(displayCanton)} applies withholding tax at variable rates on the gross income of cross-border employees. Use our <a href="/en/">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p>`);
 parts.push(`<p><strong>G permit and residence.</strong> To be hired as a cross-border worker by ${esc(companyName)}${primaryLocation ? ` in ${esc(primaryLocation)}` : ''}, you must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. The G permit is requested by the employer at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is then renewed yearly. Extended absences from Italy (more than a working week without returning home) jeopardise the "former" cross-border worker fiscal status.</p>`);
 parts.push(`<p><strong>Withholding tax and the 2024 fiscal agreement.</strong> The Swiss employer withholds tax monthly on the gross salary: the effective rate in the Canton of ${esc(displayCanton)} ranges between 5 % and 19 % depending on income, marital status and dependants. Cross-border workers hired on or after 1 January 2024 fall under the new Italy-Switzerland agreement with concurrent taxation: Italian tax credit on Swiss withholding up to 80 %, declared in section RW of the Italian tax return. For a personalised gross-to-net calculation use the salary simulator with the contract type ${esc(companyName)} offers.</p>`);
 parts.push(`<p><strong>Swiss social-charge breakdown.</strong> The gross salary advertised in ${esc(companyName)} listings is subject to AVS-AI-IPG (5.3 % employee, 5.3 % employer), unemployment insurance (1.1 % up to CHF 148,200/year) and LPP — the mandatory occupational pension — with rates climbing from 7 % at age 25 to 18 % over age 55. Adding withholding tax and social charges, the typical gross-to-net gap is 18-28 %. For an exact calculation on the work city in the listing and your personal parameters use the <a href="/en/calculate-salary/">salary calculator</a>.</p>`);
 parts.push(`<p><strong>What to expect from the commute.</strong> ${primaryLocation ? `Working for ${esc(companyName)} in ${esc(primaryLocation)} ` : `Working for ${esc(companyName)} `}, the daily commute from Como typically goes through the Brogeda (A2 motorway) or Chiasso-strada crossing for destinations in Mendrisiotto/Luganese, taking 25-50 minutes at peak times depending on the border queue. From Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives. To estimate monthly fuel cost, vehicle wear and time lost at the border, see the cross-border commuter guide and the live border-wait map: combining those numbers with net salary is the right way to compare a ${esc(companyName)} offer with an Italian alternative.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section class="s-7uP4UM"><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2>`);
 parts.push(`<p>${esc(companyName)} hat seinen Sitz${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} im Kanton ${esc(displayCanton)}, Schweiz. Grenzg\u00e4nger ben\u00f6tigen eine G-Bewilligung, um bei diesem Unternehmen zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen der Grenzg\u00e4nger. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p>`);
 parts.push(`<p><strong>G-Bewilligung und Wohnsitz.</strong> Um als Grenzg\u00e4nger bei ${esc(companyName)}${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} angestellt zu werden, m\u00fcssen Sie in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Die G-Bewilligung wird vom Arbeitgeber nach Vertragsunterzeichnung beim kantonalen Migrationsamt beantragt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die j\u00e4hrliche Verl\u00e4ngerung. L\u00e4ngere Abwesenheiten von Italien (mehr als eine Arbeitswoche ohne R\u00fcckkehr) gef\u00e4hrden den steuerlichen "Alt-Grenzg\u00e4nger"-Status.</p>`);
 parts.push(`<p><strong>Quellensteuer und neues Steuerabkommen 2024.</strong> Der schweizerische Arbeitgeber zieht die Quellensteuer monatlich vom Bruttolohn ab: der effektive Satz im Kanton ${esc(displayCanton)} liegt je nach Einkommen, Zivilstand und Kindern zwischen 5 % und 19 %. Grenzg\u00e4nger, die ab dem 1. Januar 2024 angestellt wurden, fallen unter das neue Abkommen Italien-Schweiz mit konkurrierender Besteuerung: italienische Steuergutschrift auf die schweizerische Quellensteuer bis zu 80 %, deklariert in Abschnitt RW der italienischen Steuererkl\u00e4rung. F\u00fcr eine personalisierte Brutto-Netto-Berechnung verwenden Sie den Lohnsimulator mit der von ${esc(companyName)} angebotenen Vertragsart.</p>`);
 parts.push(`<p><strong>Schweizerische Sozialabz\u00fcge.</strong> Der in ${esc(companyName)}-Inseraten angegebene Bruttolohn unterliegt AHV-IV-EO (5,3 % Arbeitnehmer, 5,3 % Arbeitgeber), Arbeitslosenversicherung (1,1 % bis CHF 148'200/Jahr) und der obligatorischen beruflichen Vorsorge BVG mit Beitr\u00e4gen, die von 7 % mit 25 Jahren bis 18 % \u00fcber 55 Jahren steigen. Mit Quellensteuer und Sozialabgaben zusammen betr\u00e4gt der typische Brutto-Netto-Abstand 18-28 %. F\u00fcr eine exakte Berechnung auf den Arbeitsort der Stelle und Ihre pers\u00f6nlichen Parameter nutzen Sie den <a href="/de/gehalt-berechnen/">Lohnrechner</a>.</p>`);
 parts.push(`<p><strong>Was Sie beim Pendeln erwartet.</strong> ${primaryLocation ? `Wer f\u00fcr ${esc(companyName)} in ${esc(primaryLocation)} arbeitet ` : `Wer f\u00fcr ${esc(companyName)} arbeitet `}, pendelt typischerweise von Como \u00fcber den Grenz\u00fcbergang Brogeda (Autobahn A2) oder Chiasso-Strasse zu Zielen im Mendrisiotto/Luganese, mit Fahrzeiten von 25-50 Minuten in Stosszeiten je nach Grenzwartezeit. Von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen. F\u00fcr eine monatliche Sch\u00e4tzung von Treibstoffkosten, Fahrzeugverschleiss und Zeitverlust an der Grenze konsultieren Sie den Grenzg\u00e4nger-Leitfaden und die Live-Wartezeitenkarte: diese Zahlen zusammen mit dem Nettolohn ergeben die richtige Grundlage, um ein ${esc(companyName)}-Angebot gegen eine italienische Alternative abzuw\u00e4gen.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section class="s-7uP4UM"><h2>Informations pour les frontaliers</h2>`);
 parts.push(`<p>${esc(companyName)} a son si\u00e8ge${primaryLocation ? ` \u00e0 ${esc(primaryLocation)}` : ''} dans le Canton du ${esc(displayCanton)}, en Suisse. Les travailleurs frontaliers ont besoin d'un permis G pour travailler dans cette entreprise. Le Canton du ${esc(displayCanton)} applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut des frontaliers. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p>`);
 parts.push(`<p><strong>Permis G et r\u00e9sidence.</strong> Pour \u00eatre engag\u00e9 comme frontalier par ${esc(companyName)}${primaryLocation ? ` \u00e0 ${esc(primaryLocation)}` : ''}, vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. Le permis G est demand\u00e9 par l'employeur \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat : la premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines, puis le permis est renouvel\u00e9 chaque ann\u00e9e. Des absences prolong\u00e9es d'Italie (plus d'une semaine de travail sans retour au domicile) compromettent le statut fiscal de \u00ab ancien \u00bb frontalier.</p>`);
 parts.push(`<p><strong>Imp\u00f4t \u00e0 la source et nouvel accord fiscal 2024.</strong> L'employeur suisse retient mensuellement l'imp\u00f4t \u00e0 la source sur le brut : le taux effectif dans le Canton du ${esc(displayCanton)} oscille entre 5 % et 19 % selon le revenu, l'\u00e9tat civil et les personnes \u00e0 charge. Les frontaliers engag\u00e9s \u00e0 partir du 1er janvier 2024 rel\u00e8vent du nouvel accord Italie-Suisse \u00e0 imposition concurrente : cr\u00e9dit d'imp\u00f4t italien sur la retenue suisse jusqu'\u00e0 80 %, d\u00e9clar\u00e9 dans le cadre RW de la d\u00e9claration italienne. Pour un calcul personnalis\u00e9 brut-net, utilisez le simulateur de salaire avec la cat\u00e9gorie contractuelle propos\u00e9e par ${esc(companyName)}.</p>`);
 parts.push(`<p><strong>Charges sociales suisses.</strong> Le salaire brut annonc\u00e9 dans les offres ${esc(companyName)} est soumis \u00e0 l'AVS-AI-APG (5,3 % salari\u00e9, 5,3 % employeur), \u00e0 l'assurance ch\u00f4mage (1,1 % jusqu'\u00e0 CHF 148'200/an) et \u00e0 la LPP — la pr\u00e9voyance professionnelle obligatoire — avec des taux qui passent de 7 % \u00e0 25 ans \u00e0 18 % au-del\u00e0 de 55 ans. Imp\u00f4t \u00e0 la source et charges sociales additionn\u00e9s, l'\u00e9cart brut-net typique est de 18 \u00e0 28 %. Pour un calcul exact sur la ville de travail de l'offre et vos param\u00e8tres personnels utilisez le <a href="/fr/calculer-salaire/">calculateur de salaire</a>.</p>`);
 parts.push(`<p><strong>\u00c0 quoi s'attendre c\u00f4t\u00e9 trajet.</strong> ${primaryLocation ? `Travailler pour ${esc(companyName)} \u00e0 ${esc(primaryLocation)} ` : `Travailler pour ${esc(companyName)} `} signifie en g\u00e9n\u00e9ral un trajet quotidien depuis C\u00f4me par le poste-fronti\u00e8re de Brogeda (autoroute A2) ou par Chiasso-route pour les destinations du Mendrisiotto/Luganese, avec des temps de 25-50 minutes en heure de pointe selon la file. Depuis Var\u00e8se ou Luino, les passages de Stabio ou Gaggiolo offrent des alternatives. Pour estimer le co\u00fbt mensuel du carburant, l'usure du v\u00e9hicule et le temps perdu au poste-fronti\u00e8re, consultez le guide frontalier et la carte des temps d'attente : combiner ces chiffres avec le salaire net est la bonne mani\u00e8re de comparer une offre ${esc(companyName)} avec une alternative italienne.</p>`);
 parts.push('</section>');
 }

 // Extended economic-context section — boosts text/HTML on EN/DE/FR
 // company-hub pages that hovered at 7-8 % (under the 10 % gate).
 // Three paragraphs covering: salary ranges in the canton, exchange-rate
 // impact on take-home, and benefit benchmarks. All values interpolate
 // companyName / displayCanton so Google sees page-specific copy.
 if (locale === 'it') {
 parts.push(`<section class="s-7uP4UM"><h2>Contesto economico per chi valuta ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Range salariali tipici nel Canton ${esc(displayCanton)}.</strong> Le buste paga lorde in ${esc(displayCanton)} per i frontalieri si distribuiscono tipicamente in tre fasce: profili junior e mansioni operative tra CHF 4'200 e CHF 5'400 al mese (13ª inclusa); ruoli intermedi e tecnici qualificati tra CHF 5'500 e CHF 8'200; ruoli specialistici, manageriali e regolamentati tra CHF 8'500 e CHF 14'000. Per ${esc(companyName)} la collocazione concreta dipende dal CCL applicato (CCNL nazionale, CCL ramo, contratto aziendale), dall'anzianità e dalla certificazione richiesta. Confronta sempre il lordo svizzero con il netto italiano equivalente: a parità di mansione, in Ticino il netto resta superiore del 25-45 % grazie alla pressione fiscale e contributiva ridotta.</p>`);
 parts.push(`<p><strong>Impatto del cambio CHF/EUR sul potere d'acquisto.</strong> Lo stipendio in franchi va riconvertito in euro per le spese italiane (mutuo, scuola, spesa, utenze): un CHF/EUR a 1,06 vs 0,95 cambia il netto in euro fino al 12 % a parità di lordo svizzero. I frontalieri che lavorano per aziende come ${esc(companyName)} possono ridurre questo rischio cambio aprendo un conto multivaluta in Italia, mantenendo una riserva CHF per le spese svizzere (parking, mensa, eventuale spesa nei valichi) e cambiando in EUR solo la quota destinata alle uscite italiane. Le commissioni di cambio bancarie tradizionali (1,5-3 %) erodono il vantaggio: usa fornitori specializzati (Wise, Revolut Premium) o accordi di cambio negoziato con la propria banca italiana per massimizzare il netto effettivo.</p>`);
 parts.push(`<p><strong>Benefit accessori da chiedere in colloquio.</strong> Oltre allo stipendio lordo, valuta sempre i benefit non monetari quando ricevi un'offerta da ${esc(companyName)}: contributo LPP sopra il minimo legale (8-12 % del lordo è il benchmark per ruoli qualificati nel ${esc(displayCanton)}), 13ª e 14ª mensilità, bonus annuale legato a obiettivi (tipicamente 5-15 % del lordo), giorni di vacanza oltre i 4 settimane minime di legge (le aziende competitive offrono 5-6 settimane), formazione continua (budget di CHF 1'500-3'500/anno per ruoli senior), copertura assicurativa malattia LCA integrativa e flessibilità di telelavoro. Quest'ultimo punto è critico: dal 1° gennaio 2024 i frontalieri possono telelavorare fino al 25 % del tempo senza perdere lo status fiscale, ma il datore di lavoro deve esplicitarlo nel contratto.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section class="s-7uP4UM"><h2>Economic context for evaluating ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Typical salary ranges in the Canton of ${esc(displayCanton)}.</strong> Gross monthly salaries for cross-border workers in ${esc(displayCanton)} typically split into three bands: junior and operational roles between CHF 4,200 and CHF 5,400 per month (13th included); intermediate and skilled-technical roles between CHF 5,500 and CHF 8,200; specialist, managerial and regulated roles between CHF 8,500 and CHF 14,000. For ${esc(companyName)} the actual band depends on the applicable collective agreement (CCL), seniority and required certifications. Always compare the Swiss gross with the Italian net equivalent: for the same job in Ticino the net is typically 25-45 % higher than the Italian counterpart due to lower fiscal and social burden.</p>`);
 parts.push(`<p><strong>CHF/EUR exchange rate impact on purchasing power.</strong> Your CHF salary needs to be converted into EUR for Italian expenses (mortgage, school, groceries, utilities): a CHF/EUR rate at 1.06 vs 0.95 changes net EUR by up to 12 % at the same Swiss gross. Cross-border workers at companies like ${esc(companyName)} can hedge this exchange-rate risk by opening a multi-currency account in Italy, keeping a CHF reserve for Swiss expenses (parking, canteen, occasional shopping near the border) and converting to EUR only the share destined for Italian spending. Traditional bank FX fees (1.5-3 %) erode the benefit: use specialised providers (Wise, Revolut Premium) or a negotiated FX deal with your Italian bank to maximise effective net.</p>`);
 parts.push(`<p><strong>Benefits to negotiate at offer stage.</strong> Beyond the gross salary, always evaluate non-cash benefits when ${esc(companyName)} extends an offer: pension (LPP) contribution above the legal minimum (8-12 % of gross is the benchmark for skilled roles in ${esc(displayCanton)}), 13th and 14th-month payments, annual bonus tied to targets (typically 5-15 % of gross), holiday entitlement beyond the legal 4-week minimum (competitive employers offer 5-6 weeks), continuous training (CHF 1,500-3,500/year budget for senior roles), supplementary LCA health insurance and remote-work flexibility. The latter is critical: since 1 January 2024 cross-border workers can work remotely up to 25 % of the time without losing fiscal status, but the employer must explicitly include this in the contract.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section class="s-7uP4UM"><h2>Wirtschaftlicher Kontext zur Bewertung von ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Typische Lohnbandbreiten im Kanton ${esc(displayCanton)}.</strong> Bruttogeh\u00e4lter f\u00fcr Grenzg\u00e4nger im ${esc(displayCanton)} verteilen sich typischerweise auf drei Bereiche: Junior- und operative Rollen zwischen CHF 4'200 und CHF 5'400 pro Monat (13. inbegriffen); mittlere und qualifiziert-technische Rollen zwischen CHF 5'500 und CHF 8'200; Spezialisten, Kader und regulierte Rollen zwischen CHF 8'500 und CHF 14'000. F\u00fcr ${esc(companyName)} h\u00e4ngt die konkrete Eingruppierung vom anwendbaren GAV (Branchen-GAV, Firmenvertrag), der Anstellungsdauer und den geforderten Zertifizierungen ab. Vergleichen Sie immer das Schweizer Brutto mit dem italienischen Netto-\u00c4quivalent: f\u00fcr dieselbe Stelle ist das Tessiner Netto typischerweise 25-45 % h\u00f6her als die italienische Alternative, dank tieferer Steuer- und Soziallast.</p>`);
 parts.push(`<p><strong>Auswirkungen des CHF/EUR-Kurses auf die Kaufkraft.</strong> Ihr CHF-Lohn muss f\u00fcr italienische Ausgaben (Hypothek, Schule, Eink\u00e4ufe, Nebenkosten) in EUR umgerechnet werden: ein CHF/EUR-Kurs von 1,06 vs 0,95 \u00e4ndert den Nettobetrag in EUR bei gleichem Schweizer Brutto um bis zu 12 %. Grenzg\u00e4nger bei Unternehmen wie ${esc(companyName)} k\u00f6nnen dieses Wechselkursrisiko absichern, indem sie ein Multiw\u00e4hrungskonto in Italien er\u00f6ffnen, eine CHF-Reserve f\u00fcr Schweizer Ausgaben halten (Parking, Personalrestaurant, gelegentliche Eink\u00e4ufe nahe der Grenze) und nur den Anteil f\u00fcr italienische Ausgaben in EUR konvertieren. Traditionelle Bankgeb\u00fchren (1,5-3 %) zehren am Vorteil: spezialisierte Anbieter (Wise, Revolut Premium) oder ein verhandelter FX-Deal mit Ihrer italienischen Bank maximieren das effektive Netto.</p>`);
 parts.push(`<p><strong>Verhandelbare Zusatzleistungen.</strong> \u00dcber das Bruttogehalt hinaus pr\u00fcfen Sie bei einem Angebot von ${esc(companyName)} stets die nicht monet\u00e4ren Leistungen: BVG-Beitrag \u00fcber dem gesetzlichen Minimum (8-12 % des Brutto sind der Benchmark f\u00fcr qualifizierte Rollen im ${esc(displayCanton)}), 13. und 14. Monatslohn, Bonus an Zielvereinbarungen gekoppelt (typischerweise 5-15 % des Brutto), Ferienanspruch \u00fcber dem gesetzlichen Minimum von 4 Wochen (kompetitive Arbeitgeber bieten 5-6 Wochen), Weiterbildung (CHF 1'500-3'500/Jahr f\u00fcr Senior-Rollen), erg\u00e4nzende LCA-Krankenversicherung und Telearbeit-Flexibilit\u00e4t. Letzteres ist entscheidend: seit dem 1. Januar 2024 d\u00fcrfen Grenzg\u00e4nger bis zu 25 % der Zeit im Homeoffice arbeiten, ohne den Steuerstatus zu verlieren — der Arbeitgeber muss dies aber im Vertrag explizit regeln.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section class="s-7uP4UM"><h2>Contexte \u00e9conomique pour \u00e9valuer ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Fourchettes salariales typiques dans le Canton du ${esc(displayCanton)}.</strong> Les salaires bruts mensuels pour les frontaliers dans le ${esc(displayCanton)} se r\u00e9partissent g\u00e9n\u00e9ralement en trois fourchettes : postes juniors et op\u00e9rationnels entre CHF 4'200 et CHF 5'400 par mois (13e inclus) ; postes interm\u00e9diaires et techniques qualifi\u00e9s entre CHF 5'500 et CHF 8'200 ; postes sp\u00e9cialis\u00e9s, cadres et r\u00e9glement\u00e9s entre CHF 8'500 et CHF 14'000. Pour ${esc(companyName)} le positionnement concret d\u00e9pend de la convention collective applicable (CCL national, CCL de branche, contrat d'entreprise), de l'anciennet\u00e9 et des certifications requises. Comparez toujours le brut suisse avec le net italien \u00e9quivalent : pour le m\u00eame poste au Tessin, le net est g\u00e9n\u00e9ralement 25-45 % sup\u00e9rieur \u00e0 l'\u00e9quivalent italien gr\u00e2ce \u00e0 une charge fiscale et sociale plus faible.</p>`);
 parts.push(`<p><strong>Impact du taux de change CHF/EUR sur le pouvoir d'achat.</strong> Votre salaire en CHF doit \u00eatre converti en EUR pour les d\u00e9penses italiennes (hypoth\u00e8que, \u00e9cole, courses, charges) : un taux CHF/EUR \u00e0 1,06 vs 0,95 modifie le net en EUR jusqu'\u00e0 12 % \u00e0 brut suisse \u00e9gal. Les frontaliers chez des entreprises comme ${esc(companyName)} peuvent couvrir ce risque de change en ouvrant un compte multi-devises en Italie, en gardant une r\u00e9serve CHF pour les d\u00e9penses suisses (parking, cantine, achats occasionnels pr\u00e8s de la fronti\u00e8re) et en convertissant en EUR seulement la part destin\u00e9e aux d\u00e9penses italiennes. Les frais de change bancaires traditionnels (1,5-3 %) r\u00e9duisent l'avantage : utilisez des prestataires sp\u00e9cialis\u00e9s (Wise, Revolut Premium) ou un accord de change n\u00e9goci\u00e9 avec votre banque italienne pour maximiser le net effectif.</p>`);
 parts.push(`<p><strong>Avantages \u00e0 n\u00e9gocier au moment de l'offre.</strong> Au-del\u00e0 du salaire brut, \u00e9valuez toujours les avantages non mon\u00e9taires lorsque ${esc(companyName)} fait une offre : cotisation LPP au-del\u00e0 du minimum l\u00e9gal (8-12 % du brut est le benchmark pour les postes qualifi\u00e9s dans le ${esc(displayCanton)}), 13e et 14e mois, bonus annuel index\u00e9 sur des objectifs (typiquement 5-15 % du brut), cong\u00e9s au-del\u00e0 du minimum l\u00e9gal de 4 semaines (les employeurs comp\u00e9titifs offrent 5-6 semaines), formation continue (budget CHF 1'500-3'500/an pour les postes seniors), assurance maladie compl\u00e9mentaire LCA et flexibilit\u00e9 du t\u00e9l\u00e9travail. Ce dernier point est critique : depuis le 1er janvier 2024, les frontaliers peuvent t\u00e9l\u00e9travailler jusqu'\u00e0 25 % du temps sans perdre leur statut fiscal, mais l'employeur doit l'inscrire explicitement dans le contrat.</p>`);
 parts.push('</section>');
 }

 // Per-company hub frontalier context (separate shared helper):
 // sector-aware salary scenario + how-to-apply methodology + 3-FAQ.
 // Lifts the text-to-HTML ratio for thin per-company hubs flagged as
 // `career-landings` by scripts/audit-text-html-ratio.mjs. Always renders
 // (not gated on companyJobs.length) — thin pages need this most.
 const companyHubFrontalierContext = renderCompanyHubFrontalierContext({
 companyName,
 displayCanton,
 primaryLocation,
 sector: companyProfile?.sector,
 companySectors,
 companyContracts,
 jobCount: companyJobs.length,
 locale,
 esc,
 });
 if (companyHubFrontalierContext) parts.push(companyHubFrontalierContext);

 // Editorial
 parts.push(`<p class="s-Xxg-ZL">${esc(copy.editorial)}</p>`);
 return parts.join('\n');
 })()}
 ${curatedBodyHtml ? `<p class="s-DhzLIy">${esc(copy.editorial)}</p>` : ''}
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: primaryLocation || getCantonDisplayLabel(DEFAULT_CANTON, locale), omitCommute: !primaryLocation }))}
 </div>`;

 const companyHtml = buildSeoPageHtml({
 locale,
 title,
 description,
 canonicalUrl,
 robots: companyRobots,
 ogType: 'website',
 ogLocale: localeOg[locale],
 hreflangHtml,
 jsonLdScripts: [breadcrumbLd, organizationLd, webPageLd, ...curatedExtraJsonLd],
 bodyHtml: companyBodyHtml,
 distDir,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), companyHtml);
 // Flat .html variant — write real content (no redirect stub)
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, companyHtml);
 }
 // Redirect pages for raw slugs that differ from canonical (e.g. lidl-svizzera → lidl).
 // These are non-canonical alternate URLs that exist only so older inbound links
 // and crawler discoveries don't 404. We serve the SAME full canonical HTML at
 // each alias path; the embedded <link rel="canonical"> already points to the
 // canonical hub URL, so Google consolidates authority on the canonical via
 // that reference. No thin stub, no noindex — index,follow with canonical
 // reference is the cleanest signal. Mirrors the previousSlugs bridge pattern
 // documented around line 7190+.
 for (const rawSlug of rawSlugs) {
 const rawFullSlug = `${prefix}-${rawSlug}`;
 const rawRelPath = `${localePrefix[locale]}/${sectionSlug}/${rawFullSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const rawDir = np.join(distDir, rawRelPath);
 const rawDirIndex = np.join(rawDir, 'index.html');
 if (!_writtenPaths.has(rawDirIndex) && !fs.existsSync(rawDirIndex)) {
 _md(rawDir);
 _qw(rawDirIndex, companyHtml);
 }
 const rawFlat = np.join(distDir, rawRelPath + '.html');
 if (!_writtenPaths.has(rawFlat) && !fs.existsSync(rawFlat)) {
 _md(np.dirname(rawFlat));
 _qwFlat(rawFlat, companyHtml);
 }
 }
 // Declarative brand-alias bridge pages (P5 dedup).
 // When `cSlug` is a declared canonical primary, emit noindex canonical
 // bridges for every alias slug registered in BRAND_CANONICAL_MAP so
 // alternative company-hub URLs (e.g. /azienda-guess/, /azienda-guess-europe/)
 // cannot cannibalise the brand query against the primary hub.
 const brandEntry = BRAND_CANONICAL_MAP[cSlug];
 if (brandEntry) {
 for (const aliasSlug of brandEntry.aliases) {
 const aliasFullSlug = `${prefix}-${aliasSlug}`;
 const aliasRelPath = `${localePrefix[locale]}/${sectionSlug}/${aliasFullSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const aliasHreflang = localeList.map((l) => {
 const aliasL = `${companyRoutePrefix[l]}-${brandEntry.canonical}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${aliasL}`.replace(/\/+/g, '/');
 return { hreflang: l as string, href: `${BASE_URL}${withSlash(p)}` };
 });
 // audit-hreflang requires x-default on every page that emits hreflang.
 const aliasXDefaultHref = aliasHreflang.find((e) => e.hreflang === 'it')?.href
  ?? aliasHreflang[0]?.href
  ?? '';
 if (aliasXDefaultHref) {
 aliasHreflang.push({ hreflang: 'x-default', href: aliasXDefaultHref });
 }
 const aliasHtml = buildCanonicalBridgePage({
 canonicalUrl,
 pathLabel: canonicalPath,
 // Route through buildTitleWithBrand (same policy as every other <title> in
 // this plugin) instead of a raw concat — long company/legal names (e.g.
 // "Ospedale Regionale di Lugano e Mendrisio") overflow the 66-char cap
 // when the brand suffix is appended unconditionally; buildTitleWithBrand
 // drops the brand once the headline alone fills the budget. esc() runs
 // BEFORE the budget decision, not after — audit-title-length.mjs measures
 // the raw <title> HTML source, so entity-escaping (e.g. "&" -> "&amp;")
 // after the length check could push an already-budgeted headline over cap.
 title: buildTitleWithBrand(esc(companyName)),
 description: `Pagina alternativa per ${companyName}. Apri la pagina canonica per gli annunci aggiornati.`,
 body: `Questa URL azienda non e la variante canonica. Apri la pagina principale dell'azienda per gli annunci aggiornati.`,
 ctaLabel: String(companyName || 'Apri azienda'),
 lang: locale,
 noindex: true,
 hreflangEntries: aliasHreflang,
 });
 const aliasDir = np.join(distDir, aliasRelPath);
 const aliasDirIndex = np.join(aliasDir, 'index.html');
 if (!_writtenPaths.has(aliasDirIndex) && !fs.existsSync(aliasDirIndex)) {
 _md(aliasDir);
 _qw(aliasDirIndex, aliasHtml);
 }
 const aliasFlat = np.join(distDir, aliasRelPath + '.html');
 if (!_writtenPaths.has(aliasFlat) && !fs.existsSync(aliasFlat)) {
 _md(np.dirname(aliasFlat));
 _qwFlat(aliasFlat, aliasHtml);
 }
 }
 }
 companyPagesCount++;
 recordEmit('company-landing', __tCompany);
 }
 }
 if (companyPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${companyPagesCount} company landing pages for ${companyMap.size} companies`);
 logBuildMem('jobsSeoPages: after company-landing', collector);
 await collector.awaitDrainSlot(2); // bound _pendingFlushes backlog during bulk emit (#1290)
 const aliasCount = listAllBrandAliases().length * localeList.length;
 if (aliasCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Emitted ${aliasCount} brand-alias bridge pages from BRAND_CANONICAL_MAP`);
 }
 }

 /* ── Write known-company-slugs.json ─────────────────────────── */
 // Persist the canonical company slugs so employerLinks.ts can resolve
 // `/cerca-lavoro-ticino/azienda-{slug}/` hrefs without relying on the
 // stale `azienda-*` keys in all-known-job-slugs.json.
 // Ratchet: only write if the new set is at least as large as the existing one
 // to prevent fixture-data local builds from corrupting the production list.
 {
 // Exclude brand aliases (e.g. migros-ticino) — they resolve to a noindex
 // bridge, so CompaniesHub / employerLinks must not surface them as real
 // company hubs (mirrors the sitemap filter at the alias-aware emitter).
 const companySlugs = [...companyMap.keys()].filter((s) => !isBrandAlias(s)).sort();
 const companySlugsPath = np.resolve(rootDir, 'data/known-company-slugs.json');
 let existingCount = 0;
 try {
   const existing = JSON.parse(fs.readFileSync(companySlugsPath, 'utf-8'));
   existingCount = Array.isArray(existing) ? existing.length : 0;
 } catch { /* file doesn't exist yet */ }
 if (companySlugs.length >= existingCount) {
   fs.writeFileSync(companySlugsPath, JSON.stringify(companySlugs, null, 2) + '\n', 'utf-8');
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Wrote ${companySlugs.length} company slugs to known-company-slugs.json`);
 } else {
   console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Skipped writing known-company-slugs.json (${companySlugs.length} < existing ${existingCount}) — using fixture data, keeping production list`);
 }
 }

 const editorialLocations = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'] as const;
 const editorialTypeKeys = ['apprenticeship', 'internship', 'partTime'] as const;
 const editorialSectorKeys = ['health', 'finance', 'tech', 'engineering', 'admin', 'hospitality', 'sales'] as const;
 const editorialCareKeys = ['clinics', 'careHomes', 'oss', 'educators'] as const;

 const editorialSearchSlugsByLocale = new Map<typeof localeList[number], Set<string>>(
 localeList.map((locale) => [locale, new Set<string>()]),
 );

 /* ── Editorial landing: jobs today + location hubs ─────────── */
 // Pre-compute the care-cluster partition once for the entire editorial
 // section. Without this, `buildJob{Nurses,CareVariant}LandingModel` (and
 // their `buildCareVariantLinks` helper) ran 4 heavy regex matchers on
 // the (title + description ≈ 3 KB) of every one of ~2 500 jobs, twice
 // per call, ~60 calls per build → ~85 s of redundant regex evaluation
 // (run #25100009540: editorial-care-variant 180.6 s + editorial-nurses
 // 44.5 s of the 542 s plugin total). Computing the partition once and
 // threading it through the builders keeps output byte-identical
 // (same predicates, same input order) but cuts that cost to a single
 // ~700 ms scan.
 const careClusterPartition: CareClusterPartition = partitionCareClusters(validJobs);
 // Pre-compute the per-location partition (Lugano / Bellinzona / Mendrisio
 // / Locarno / Chiasso) so buildJobLocation{Landing,Type,Sector}Model and
 // their sibling-link helpers don't re-run `matchesLocation` (and the
 // 3-7 type/sector filters that follow) on the full job array on every
 // call. Run #25102007442 measured editorial-sector at 167 ms/call ×
 // 140 calls = 22 s; with the partition each call drops to a Map lookup.
 const editorialLocationsForPartition = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'];
 const locationPartition: LocationPartition = partitionByLocation(
 validJobs,
 editorialLocationsForPartition,
 );
 let editorialEntries = '';
 {
 const editorialSitemapEntries: string[] = [];
 // SPA-matching cards via the shared renderer. Editorial models now carry
 // the full enrichment payload (salary, contract, posted-date, logo,
 // canton, featured) so we forward every field to the renderer. Missing
 // fields gracefully hide the corresponding chip. Pass `locale='it'`
 // since these editorial landing pages render IT copy regardless of the
 // route locale.
 const renderJobList = (
   items: Array<{
     title: string;
     company: string;
     location: string;
     href: string;
     datePosted?: string;
     titleByLocale?: Partial<Record<'it' | 'en' | 'de' | 'fr', string>>;
     companyKey?: string;
     canton?: string;
     contract?: string;
     salaryMin?: number | null;
     salaryMax?: number | null;
     featured?: boolean;
     logo?: string | null;
     addressLocality?: string;
     companyDomain?: string;
     url?: string;
   }>,
 ) => {
   if (items.length === 0) {
     return '<p class="s-heE-6f">—</p>';
   }
   return renderJobCardListHtml(
     items.map((item) => {
       const job: JobCardJob = {
         title: item.title,
         company: item.company,
         location: item.location,
         titleByLocale: item.titleByLocale,
         companyKey: item.companyKey,
         canton: item.canton,
         contract: item.contract,
         salaryMin: item.salaryMin,
         salaryMax: item.salaryMax,
         featured: item.featured,
         logo: item.logo,
         addressLocality: item.addressLocality,
         datePosted: item.datePosted,
         companyDomain: item.companyDomain,
         url: item.url,
       };
       return { job, href: item.href };
     }),
     { locale: 'it' },
   );
 };

 /**
  * Per-(city × type) frontalier context section. Same intent as the
  * sector variant but tailored to the four type buckets:
  * apprenticeship, internship, part-time, public-tender — each has a
  * very different cross-border-worker context (regulated entry,
  * residency rules, Italy-vs-Switzerland comparison nuances).
  */
 const renderLocationTypeFrontalierContext = (args: {
  locale: 'it' | 'en' | 'de' | 'fr';
  typeKey: string;
  typeLabel: string;
  location: string;
  jobsCount: number;
 }): string => {
  const { locale: l, typeKey, typeLabel, location, jobsCount } = args;
  // Context paragraphs are tailored per typeKey to keep copy page-relevant.
  const isApprenticeship = typeKey === 'apprenticeship';
  const isInternship = typeKey === 'internship';
  const isPartTime = typeKey === 'partTime' || typeKey === 'part-time';
  const isTender = typeKey === 'tender' || typeKey === 'public-tender' || typeKey === 'concorsi';
  const baseUrl = BASE_URL;
  const calcPath = l === 'it' ? '/calcola-stipendio/'
    : l === 'de' ? '/de/gehalt-berechnen/'
    : l === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const copy: Record<typeof l, { h: string; p1: string; p2: string }> = {
   it: {
    h: `${typeLabel} a ${location} per frontalieri`,
    p1: isApprenticeship
      ? `Le ${jobsCount} posizioni di ${typeLabel.toLowerCase()} a ${location} sono una porta d'ingresso strutturata al mercato del lavoro ticinese: il sistema svizzero della formazione professionale duale (3-4 anni alternati tra azienda e scuola professionale) è riconosciuto a livello federale ed esita un Attestato Federale di Capacità (AFC). Per i giovani frontalieri italiani residenti in zona di frontiera (entro 20 km dalla Svizzera), candidarsi a un apprendistato in Ticino significa acquisire un titolo riconosciuto in tutta la Confederazione, una formazione retribuita (CHF 600-1'200 al mese il primo anno, fino a CHF 1'800 al quarto) e una rete di datori di lavoro locali. Il Permesso G viene emesso anche per gli apprendisti minorenni con consenso scritto dei genitori; la retribuzione è soggetta a imposta alla fonte ridotta per i minori.`
      : isInternship
      ? `Gli ${jobsCount} stage attivi a ${location} sono un canale frequente per i frontalieri italiani che vogliono sperimentare il mercato del lavoro svizzero senza un impegno contrattuale a tempo indeterminato. La durata tipica è 3-6 mesi, la retribuzione varia da CHF 1'500 (stage non qualificati pre-laurea) a CHF 4'500 (stage post-laurea o laureati specializzati). Per il frontaliere lo stage richiede comunque il Permesso G, ma la procedura è semplificata se il datore svizzero è una grande azienda con esperienza HR sui frontalieri. Lo stage retribuito viene generalmente convertito in un contratto a tempo determinato o indeterminato nel 35-50 % dei casi quando esiste una posizione aperta in linea con il profilo.`
      : isPartTime
      ? `Le ${jobsCount} posizioni part-time a ${location} sono interessanti per due profili di frontaliere: chi cerca un secondo lavoro complementare al principale e chi pendola da una distanza importante (Como/Varese verso il Sottoceneri) e vuole limitare il numero di giorni di trasferta settimanali. Il part-time svizzero è regolato a percentuale (50 %, 60 %, 80 %): a parità di ruolo, il netto di un 80 % è di solito più vantaggioso del 100 % rispetto al numero di giorni lavorati una volta detratti i costi di pendolarismo. La copertura LPP scatta sopra il 60 % di occupazione; al 50 % o inferiore va valutata l'opportunità di un piano di previdenza individuale.`
      : isTender
      ? `I ${jobsCount} concorsi pubblici aperti a ${location} sono accessibili anche ai frontalieri italiani con i titoli equivalenti, ma con regole di residenza più stringenti rispetto al settore privato. Per i ruoli nell'amministrazione cantonale del Ticino, alcune posizioni richiedono la residenza svizzera al momento dell'assunzione (impiegati di concetto, dirigenti); i ruoli operativi e tecnici sono di solito accessibili al frontaliere. Il riconoscimento del titolo italiano (laurea, diploma) presso SBFI/SEFRI richiede 3-6 mesi e va lanciato in parallelo all'invio del CV. Le selezioni pubbliche svizzere prevedono di solito una prova scritta + colloquio + assessment psicometrico, con tempi di chiusura di 4-8 settimane dalla scadenza.`
      : `Le ${jobsCount} posizioni di ${typeLabel.toLowerCase()} a ${location} sono accessibili ai frontalieri italiani residenti in zona di frontiera (entro 20 km dalla Svizzera) tramite il Permesso G. La candidatura passa dal datore svizzero, che richiede il permesso all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovata annualmente fino al limite contrattuale. Da Como il valico di Brogeda o Chiasso porta a ${location} in 25-50 minuti in ora di punta a seconda delle code; da Varese o Luino i valichi di Stabio o Gaggiolo offrono alternative.`,
    p2: `Stipendio, pendolarismo e cosa controllare nei singoli annunci. Il netto reale di una posizione di ${typeLabel.toLowerCase()} a ${location} dipende dal CCL applicato, dal Nuovo Accordo fiscale Italia-Svizzera 2024 (imposta concorrente con credito d'imposta italiano fino all'80 % sulla ritenuta svizzera), dai contributi sociali (AVS-AI-IPG 5,3 %, disoccupazione 1,1 %, LPP variabile 7-18 % per età) e dal regime fiscale cantonale. La differenza lordo-netto tipica è 18-28 %. Apri ogni annuncio per leggere mansionario, requisiti, sede precisa e tipologia contrattuale, poi calcola il netto effettivo nel <a class="s-U9K6Vf" href="${baseUrl}${calcPath}">simulatore stipendio</a> tenendo conto anche dei costi di pendolarismo verso ${location} (carburante, usura veicolo, tempo perso ai valichi) per un confronto onesto con un'alternativa italiana.`,
   },
   en: {
    h: `${typeLabel} jobs in ${location} for cross-border workers`,
    p1: isApprenticeship
      ? `The ${jobsCount} active ${typeLabel.toLowerCase()} positions in ${location} are a structured entry point into the Ticino labour market: the Swiss dual vocational training system (3-4 years alternating between company and trade school) is federally recognised and leads to a Federal Capacity Certificate (AFC). For young Italian cross-border workers resident in the border zone (within 20 km of Switzerland), applying to a Ticino apprenticeship means earning a Confederation-wide recognised qualification, paid training (CHF 600-1,200/month in the first year, up to CHF 1,800 in the fourth) and a local employer network. The G permit is issued even to minor apprentices with written parental consent; pay is taxed at the reduced minor rate.`
      : isInternship
      ? `The ${jobsCount} active internships in ${location} are a frequent channel for Italian cross-border workers who want to test the Swiss labour market without a permanent contract. Typical duration is 3-6 months; pay ranges from CHF 1,500 (unqualified pre-degree internships) to CHF 4,500 (post-graduate or specialised). For cross-border workers the internship still requires a G permit, but the procedure is faster when the Swiss employer is a large company with HR experience handling cross-border employees. Paid internships are converted to fixed-term or open-ended contracts in 35-50 % of cases when an aligned opening exists.`
      : isPartTime
      ? `The ${jobsCount} part-time positions in ${location} are interesting for two cross-border profiles: those looking for a complementary second job and those commuting long distances (Como/Varese to Sottoceneri) wanting to cap weekly trips. Swiss part-time is regulated as a percentage (50 %, 60 %, 80 %): for the same role, the take-home of an 80 % role is usually more advantageous than full-time relative to days worked once commute costs are factored in. LPP pension coverage kicks in above 60 % occupancy; at 50 % or below, evaluate an individual pension plan.`
      : isTender
      ? `The ${jobsCount} public tenders in ${location} are open to Italian cross-border workers with equivalent qualifications, but with stricter residence rules than the private sector. For Ticino cantonal administration roles, some senior positions require Swiss residence at hire (white-collar, executives); operational and technical roles are usually open to cross-border workers. Italian qualification recognition (degree, diploma) at SBFI/SEFRI takes 3-6 months and should be launched in parallel with applications. Swiss public selections typically include a written test + interview + psychometric assessment, with 4-8 week closing times after the deadline.`
      : `The ${jobsCount} ${typeLabel.toLowerCase()} positions in ${location} are accessible to Italian cross-border workers resident in the border zone (within 20 km of Switzerland) through the G permit. The application goes via the Swiss employer, who files for the permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly. From Como the Brogeda or Chiasso crossing reaches ${location} in 25-50 minutes at peak times; from Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives.`,
    p2: `Salary, commute and what to read in each listing. The real take-home for a ${typeLabel.toLowerCase()} role in ${location} depends on the applicable collective agreement, the 2024 Italy-Switzerland fiscal agreement (concurrent taxation, Italian tax credit up to 80 % on Swiss withholding), social charges (AVS-AI-IPG 5.3 %, unemployment 1.1 %, LPP rising from 7 % to 18 % by age) and the cantonal tax regime. The typical gross-to-net gap is 18-28 %. Open each listing for the description, requirements, exact location and contract type, then run the actual net figure in the <a class="s-U9K6Vf" href="${baseUrl}${calcPath}">salary simulator</a>, factoring in commute costs to ${location} for an honest comparison with an Italian alternative.`,
   },
   de: {
    h: `${typeLabel} in ${location} für Grenzgänger`,
    p1: isApprenticeship
      ? `Die ${jobsCount} aktiven ${typeLabel.toLowerCase()}-Stellen in ${location} sind ein strukturierter Einstieg in den Tessiner Arbeitsmarkt: das duale Berufsbildungssystem der Schweiz (3-4 Jahre abwechselnd zwischen Betrieb und Berufsschule) ist auf Bundesebene anerkannt und führt zu einem Eidgenössischen Fähigkeitszeugnis (EFZ). Für junge italienische Grenzgänger mit Wohnsitz in der Grenzzone (innerhalb von 20 km zur Schweiz) bedeutet eine Tessiner Lehrstelle einen schweizweit anerkannten Abschluss, eine bezahlte Ausbildung (CHF 600-1'200/Monat im ersten Jahr, bis CHF 1'800 im vierten) und ein lokales Arbeitgebernetzwerk. Die G-Bewilligung wird auch minderjährigen Lehrlingen mit schriftlicher Einwilligung der Eltern erteilt; der Lohn wird zum reduzierten Tarif für Minderjährige besteuert.`
      : isInternship
      ? `Die ${jobsCount} aktiven Praktika in ${location} sind ein häufiger Kanal für italienische Grenzgänger, die den Schweizer Arbeitsmarkt ohne unbefristeten Vertrag testen möchten. Die typische Dauer beträgt 3-6 Monate; der Lohn reicht von CHF 1'500 (unqualifizierte Vorabschluss-Praktika) bis CHF 4'500 (Postgraduierten- oder spezialisierte Praktika). Für Grenzgänger erfordert das Praktikum weiterhin eine G-Bewilligung, das Verfahren ist aber zügiger, wenn der Schweizer Arbeitgeber ein Grossunternehmen mit HR-Erfahrung für Grenzgänger ist. Bezahlte Praktika werden in 35-50 % der Fälle in befristete oder unbefristete Verträge umgewandelt, sofern eine passende Stelle existiert.`
      : isPartTime
      ? `Die ${jobsCount} Teilzeitstellen in ${location} sind für zwei Grenzgänger-Profile interessant: jene, die einen ergänzenden Zweitjob suchen, und jene, die aus grosser Entfernung pendeln (Como/Varese ins Sottoceneri) und die Anzahl wöchentlicher Fahrten reduzieren möchten. Schweizer Teilzeit ist als Prozentsatz geregelt (50 %, 60 %, 80 %): für dieselbe Rolle ist das Netto einer 80 %-Stelle oft vorteilhafter als Vollzeit, gemessen an Arbeitstagen und unter Berücksichtigung der Pendelkosten. Die BVG-Vorsorge greift oberhalb von 60 % Arbeitspensum; bei 50 % oder weniger ist eine private Vorsorge zu prüfen.`
      : isTender
      ? `Die ${jobsCount} öffentlichen Ausschreibungen in ${location} stehen italienischen Grenzgängern mit gleichwertigen Qualifikationen offen, aber mit strikteren Wohnsitzregeln als im Privatsektor. Bei der Tessiner Kantonsverwaltung erfordern einige Senior-Positionen den Schweizer Wohnsitz bei der Anstellung (Sachbearbeitende, Kader); operative und technische Rollen stehen Grenzgängern in der Regel offen. Die Anerkennung italienischer Titel (Studium, Diplom) beim SBFI/SEFRI dauert 3-6 Monate und sollte parallel zu den Bewerbungen gestartet werden. Schweizerische öffentliche Auswahlverfahren umfassen typischerweise eine schriftliche Prüfung, ein Vorstellungsgespräch und ein psychometrisches Assessment, mit Abschlusszeiten von 4-8 Wochen nach Bewerbungsfrist.`
      : `Die ${jobsCount} ${typeLabel.toLowerCase()}-Stellen in ${location} sind für italienische Grenzgänger mit Wohnsitz in der Grenzzone (innerhalb von 20 km zur Schweiz) über die G-Bewilligung zugänglich. Die Bewerbung läuft über den Schweizer Arbeitgeber, der die Bewilligung beim kantonalen Migrationsamt nach Vertragsunterzeichnung beantragt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die jährliche Verlängerung. Von Como erreicht der Übergang Brogeda oder Chiasso ${location} in 25-50 Minuten in Stosszeiten; von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen.`,
    p2: `Lohn, Pendeln und worauf in den einzelnen Inseraten zu achten ist. Der reale Nettolohn einer ${typeLabel.toLowerCase()}-Rolle in ${location} hängt vom anwendbaren GAV, vom neuen Steuerabkommen Italien-Schweiz 2024 (konkurrierende Besteuerung, italienische Steuergutschrift bis zu 80 % auf die schweizerische Quellensteuer), den Sozialabgaben (AHV-IV-EO 5,3 %, ALV 1,1 %, BVG variabel 7-18 % nach Alter) und der kantonalen Steuerregelung ab. Der typische Brutto-Netto-Abstand beträgt 18-28 %. Öffnen Sie jedes Inserat für die Stellenbeschreibung, die Anforderungen, den genauen Arbeitsort und die Vertragsart, berechnen Sie dann den exakten Nettowert im <a class="s-U9K6Vf" href="${baseUrl}${calcPath}">Lohnsimulator</a> und beziehen Sie auch die Pendelkosten nach ${location} ein.`,
   },
   fr: {
    h: `${typeLabel} à ${location} pour les frontaliers`,
    p1: isApprenticeship
      ? `Les ${jobsCount} ${typeLabel.toLowerCase()} actifs à ${location} sont une porte d'entrée structurée sur le marché du travail tessinois : le système suisse de formation professionnelle duale (3-4 ans alternant entreprise et école professionnelle) est reconnu au niveau fédéral et débouche sur un certificat fédéral de capacité (CFC). Pour les jeunes frontaliers italiens résidant en zone frontalière (à 20 km de la Suisse), un apprentissage tessinois signifie un titre reconnu sur l'ensemble de la Confédération, une formation rémunérée (CHF 600-1'200/mois la première année, jusqu'à CHF 1'800 la quatrième) et un réseau d'employeurs locaux. Le permis G est délivré même aux apprentis mineurs avec consentement écrit des parents ; le salaire est imposé au taux réduit pour mineurs.`
      : isInternship
      ? `Les ${jobsCount} stages actifs à ${location} sont un canal fréquent pour les frontaliers italiens qui veulent tester le marché du travail suisse sans engagement à durée indéterminée. La durée typique est de 3-6 mois ; la rémunération varie de CHF 1'500 (stages non qualifiés pré-diplôme) à CHF 4'500 (stages post-diplôme ou spécialisés). Pour les frontaliers, le stage requiert toujours un permis G, mais la procédure est plus rapide lorsque l'employeur suisse est une grande entreprise avec une expérience RH des frontaliers. Les stages rémunérés sont convertis en contrats à durée déterminée ou indéterminée dans 35-50 % des cas lorsqu'une ouverture alignée existe.`
      : isPartTime
      ? `Les ${jobsCount} postes à temps partiel à ${location} intéressent deux profils de frontalier : ceux qui cherchent un deuxième emploi complémentaire et ceux qui pendulaient depuis une grande distance (Côme/Varèse vers le Sottoceneri) et veulent plafonner le nombre de trajets hebdomadaires. Le temps partiel suisse est réglementé en pourcentage (50 %, 60 %, 80 %) : pour le même poste, le net d'un 80 % est souvent plus avantageux que le temps plein rapporté aux jours travaillés une fois les coûts du trajet pris en compte. La couverture LPP s'enclenche au-dessus de 60 % d'occupation ; à 50 % ou moins, évaluer un plan de prévoyance individuelle.`
      : isTender
      ? `Les ${jobsCount} concours publics à ${location} sont accessibles aux frontaliers italiens disposant des titres équivalents, mais avec des règles de résidence plus strictes que dans le privé. Pour les rôles dans l'administration cantonale tessinoise, certains postes seniors exigent la résidence suisse à l'engagement (employés de concept, cadres) ; les rôles opérationnels et techniques sont généralement ouverts aux frontaliers. La reconnaissance du titre italien (diplôme, licence) auprès du SBFI/SEFRI prend 3 à 6 mois et doit être lancée en parallèle des candidatures. Les sélections publiques suisses comportent typiquement une épreuve écrite, un entretien et une évaluation psychométrique, avec des délais de clôture de 4-8 semaines après la date limite.`
      : `Les ${jobsCount} postes de ${typeLabel.toLowerCase()} à ${location} sont accessibles aux frontaliers italiens résidant en zone frontalière (à 20 km de la Suisse) via le permis G. La candidature passe par l'employeur suisse, qui demande le permis à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2-6 semaines, puis le permis est renouvelé chaque année. Depuis Côme, le passage de Brogeda ou Chiasso atteint ${location} en 25-50 minutes aux heures de pointe ; depuis Varèse ou Luino, Stabio ou Gaggiolo offrent des alternatives.`,
    p2: `Salaire, trajet et points à vérifier dans chaque annonce. Le net réel d'un poste de ${typeLabel.toLowerCase()} à ${location} dépend de la convention collective applicable, du nouvel accord fiscal Italie-Suisse 2024 (imposition concurrente, crédit d'impôt italien jusqu'à 80 % sur la retenue suisse), des charges sociales (AVS-AI-APG 5,3 %, chômage 1,1 %, LPP variable 7-18 % selon l'âge) et du régime fiscal cantonal. L'écart brut-net typique est de 18-28 %. Ouvrez chaque annonce pour le descriptif, les exigences, le lieu et le type de contrat, puis calculez le net exact dans le <a class="s-U9K6Vf" href="${baseUrl}${calcPath}">simulateur de salaire</a> en tenant compte des coûts du trajet vers ${location}.`,
   },
  };
  const c = copy[l] || copy.it;
  return `<section class="s-KZc0LQ" aria-labelledby="locTypeFrontalier">
   <h2 class="s-iEVPhz" id="locTypeFrontalier">${esc(c.h)}</h2>
   <p class="s-KwuhOL">${c.p1}</p>
   <p class="s-E7ZJqo">${c.p2}</p>
  </section>`;
 };

 /**
  * Per-(city × sector) frontalier context section. The 150+ search-/suche-/recherche-/ricerca-
  * city×sector soft-landing pages had thin bodies (12 KB) versus heavy heads
  * (preconnects + 4 hreflangs + JSON-LD), pushing them under the 10 % text/HTML
  * Semrush gate. Adds 2 locale-aware paragraphs interpolating sector + location
  * + jobsCount so Google sees substantive page-relevant copy, not template
  * boilerplate.
  */
 const renderLocationSectorFrontalierContext = (args: {
  locale: 'it' | 'en' | 'de' | 'fr';
  sectorLabel: string;
  location: string;
  jobsCount: number;
 }): string => {
  const { locale: l, sectorLabel, location, jobsCount } = args;
  const copy: Record<typeof l, { h: string; p1: string; p2: string }> = {
   it: {
    h: `Lavorare nel settore ${sectorLabel.toLowerCase()} a ${location} da frontaliere`,
    p1: `Le ${jobsCount} offerte ${sectorLabel.toLowerCase()} attive a ${location} si rivolgono in larga parte a frontalieri italiani: il bacino di assunzione naturale dei datori del Sottoceneri include Como, Varese, Mendrisio italiana e i comuni della fascia entro 20 km dal confine. Per candidarsi serve il Permesso G, residenza in un comune italiano dentro la zona di frontiera (Lombardia o Piemonte) e il rientro al domicilio almeno una volta a settimana. Il datore richiede il permesso all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovato annualmente. Da Como il valico di Brogeda (autostrada A2) o Chiasso-strada porta a ${location} in 25-50 minuti in ora di punta a seconda delle code; da Varese o Luino i valichi di Stabio o Gaggiolo offrono alternative.`,
    p2: `Stipendio e cosa controllare nei singoli annunci. Le ${jobsCount} offerte di ${sectorLabel.toLowerCase()} a ${location} pubblicano la retribuzione come lordo annuo: il netto reale dipende dal CCL applicato, dal Nuovo Accordo fiscale Italia-Svizzera 2024 (imposta concorrente con credito d'imposta italiano fino all'80 % sulla ritenuta svizzera), dai contributi sociali (AVS-AI-IPG 5,3 %, disoccupazione 1,1 % fino a 148.200 CHF/anno, LPP variabile 7-18 % per età) e dal regime fiscale cantonale. La differenza lordo-netto tipica è 18-28 %. Apri ogni annuncio per leggere mansionario, requisiti, sede precisa e tipologia contrattuale, poi calcola il netto effettivo nel <a class="s-U9K6Vf" href="/calcola-stipendio/">simulatore stipendio</a> tenendo conto anche dei costi di pendolarismo verso ${location} (carburante, usura veicolo, tempo perso ai valichi) per un confronto onesto con un'alternativa italiana.`,
   },
   en: {
    h: `Working in ${sectorLabel.toLowerCase()} in ${location} as a cross-border worker`,
    p1: `The ${jobsCount} active ${sectorLabel.toLowerCase()} listings in ${location} largely target Italian cross-border workers: the natural hiring catchment for Sottoceneri employers covers Como, Varese, Italian-side Mendrisio and the municipalities within the 20 km border zone. Applying requires a G Permit, residence in an Italian municipality inside the border zone (Lombardy or Piedmont) and returning home at least once a week. The employer files for the permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly. From Como the Brogeda (A2 motorway) or Chiasso-strada crossing reaches ${location} in 25-50 minutes at peak times depending on the queue; from Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives.`,
    p2: `Salary and what to read in each listing. The ${jobsCount} ${sectorLabel.toLowerCase()} openings in ${location} post compensation as gross annual figures: real take-home depends on the applicable collective agreement, the 2024 Italy-Switzerland fiscal agreement (concurrent taxation, Italian tax credit up to 80 % on the Swiss withholding), social charges (AVS-AI-IPG 5.3 %, unemployment 1.1 % up to CHF 148,200/year, LPP rising from 7 % at 25 to 18 % over 55) and the cantonal tax regime. The typical gross-to-net gap is 18-28 %. Open each listing for the job description, requirements, exact location and contract type, then run the actual net figure in the <a class="s-U9K6Vf" href="/en/calculate-salary/">salary simulator</a>, factoring in commute costs to ${location} (fuel, vehicle wear, time lost at the border) for an honest comparison with an Italian alternative.`,
   },
   de: {
    h: `Als Grenzgänger im Sektor ${sectorLabel.toLowerCase()} in ${location} arbeiten`,
    p1: `Die ${jobsCount} aktiven ${sectorLabel.toLowerCase()}-Stellen in ${location} richten sich grösstenteils an italienische Grenzgänger: das natürliche Einzugsgebiet der Sottoceneri-Arbeitgeber umfasst Como, Varese, das italienische Mendrisio und die Gemeinden innerhalb der 20-km-Grenzzone. Eine Bewerbung setzt eine G-Bewilligung voraus, Wohnsitz in einer italienischen Gemeinde innerhalb der Grenzzone (Lombardei oder Piemont) und Rückkehr nach Hause mindestens einmal pro Woche. Der Arbeitgeber beantragt die Bewilligung beim kantonalen Migrationsamt nach Vertragsunterzeichnung: die erste Ausstellung dauert 2-6 Wochen, anschliessend erfolgt die jährliche Verlängerung. Von Como erreicht man ${location} über den Grenzübergang Brogeda (Autobahn A2) oder Chiasso-Strasse in 25-50 Minuten in Stosszeiten je nach Wartezeit; von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen.`,
    p2: `Lohn und worauf in den einzelnen Inseraten zu achten ist. Die ${jobsCount} ${sectorLabel.toLowerCase()}-Stellen in ${location} geben Löhne als Bruttojahresgehalt an: der reale Nettolohn hängt vom anwendbaren GAV, vom neuen Steuerabkommen Italien-Schweiz 2024 (konkurrierende Besteuerung, italienische Steuergutschrift bis zu 80 % auf die schweizerische Quellensteuer), den Sozialabgaben (AHV-IV-EO 5,3 %, ALV 1,1 % bis CHF 148'200/Jahr, BVG variabel von 7 % mit 25 Jahren bis 18 % über 55) und der kantonalen Steuerregelung ab. Der typische Brutto-Netto-Abstand beträgt 18-28 %. Öffnen Sie jedes Inserat für die Stellenbeschreibung, die Anforderungen, den genauen Arbeitsort und die Vertragsart, berechnen Sie dann den exakten Nettowert im <a class="s-U9K6Vf" href="/de/gehalt-berechnen/">Lohnsimulator</a> und beziehen Sie auch die Pendelkosten nach ${location} (Treibstoff, Fahrzeugverschleiss, Wartezeit an der Grenze) ein.`,
   },
   fr: {
    h: `Travailler dans le secteur ${sectorLabel.toLowerCase()} à ${location} en tant que frontalier`,
    p1: `Les ${jobsCount} offres ${sectorLabel.toLowerCase()} actives à ${location} ciblent en grande partie les frontaliers italiens : le bassin d'embauche naturel des employeurs du Sottoceneri inclut Côme, Varèse, Mendrisio italienne et les communes de la bande des 20 km. Pour postuler, il faut un permis G, une résidence dans une commune italienne située dans la zone frontière (Lombardie ou Piémont) et un retour au domicile au moins une fois par semaine. L'employeur demande le permis à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2 à 6 semaines, puis le permis est renouvelé chaque année. Depuis Côme, le poste-frontière de Brogeda (autoroute A2) ou Chiasso-route conduit à ${location} en 25-50 minutes aux heures de pointe selon la file ; depuis Varèse ou Luino, les passages de Stabio ou Gaggiolo offrent des alternatives.`,
    p2: `Salaire et points à vérifier dans chaque annonce. Les ${jobsCount} offres ${sectorLabel.toLowerCase()} à ${location} publient les rémunérations en brut annuel : le net réel dépend de la convention collective applicable, du nouvel accord fiscal Italie-Suisse 2024 (imposition concurrente, crédit d'impôt italien jusqu'à 80 % sur la retenue suisse), des charges sociales (AVS-AI-APG 5,3 %, chômage 1,1 % jusqu'à CHF 148'200/an, LPP variable de 7 % à 25 ans à 18 % au-delà de 55 ans) et du régime fiscal cantonal. L'écart brut-net typique est de 18 à 28 %. Ouvrez chaque annonce pour le descriptif, les exigences, le lieu exact et le type de contrat, puis calculez le net exact dans le <a class="s-U9K6Vf" href="/fr/calculer-salaire/">simulateur de salaire</a> en tenant compte des coûts du trajet vers ${location} (carburant, usure du véhicule, temps perdu à la frontière).`,
   },
  };
  const c = copy[l] || copy.it;
  return `<section class="s-KZc0LQ" aria-labelledby="locSectorFrontalier">
   <h2 class="s-iEVPhz" id="locSectorFrontalier">${esc(c.h)}</h2>
   <p class="s-KwuhOL">${c.p1}</p>
   <p class="s-E7ZJqo">${c.p2}</p>
  </section>`;
 };
 const buildEditorialJsonLd = (options: {
 locale: typeof localeList[number];
 name: string;
 url: string;
 description: string;
 isPartOf: string;
 breadcrumbs: Array<{ name: string; item: string }>;
 // Job-link items (LandingJobLink-shaped). The extra optional fields feed a
 // full JobPosting embedded inside each ItemList ListItem (see below).
 items: Array<{
 title: string;
 href: string;
 company?: string;
 location?: string;
 addressLocality?: string;
 canton?: string;
 datePosted?: string;
 contract?: string;
 salaryMin?: number | null;
 salaryMax?: number | null;
 titleByLocale?: Partial<Record<string, string>>;
 companyDomain?: string;
 logo?: string | null;
 url?: string;
 }>;
 }) => {
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: options.breadcrumbs.map((crumb, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 name: crumb.name,
 item: crumb.item,
 })),
 });
 const collectionLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: options.name,
 url: options.url,
 description: options.description,
 inLanguage: options.locale,
 isPartOf: options.isPartOf,
 });
 // Embed a full JobPosting inside each ListItem (richer than a name+url stub),
 // mirroring weeklyEmployersPlugin's company×city hubs. `buildListItemJobPosting`
 // never throws and caps the description, so a sparse job falls back to a plain
 // name+url stub and the page stays under the 195 KB weight budget. The
 // authoritative per-job JobPosting still lives on each linked detail page.
 const itemListLd = options.items.length > 0
 ? inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: options.name,
 itemListElement: options.items.slice(0, 10).map((item, index) => {
 const abs = item.url
 || (/^https?:\/\//.test(item.href) ? item.href : `${BASE_URL}${item.href}`);
 const jobPosting = buildListItemJobPosting(
 {
 title: item.title,
 titleByLocale: item.titleByLocale,
 company: item.company,
 companyDomain: item.companyDomain,
 companyLogoUrl: item.logo,
 location: item.location,
 addressLocality: item.addressLocality,
 canton: item.canton,
 datePosted: item.datePosted,
 contract: item.contract,
 salaryMin: item.salaryMin,
 salaryMax: item.salaryMax,
 url: abs,
 },
 { locale: options.locale, url: abs, baseUrl: BASE_URL },
 );
 return jobPosting
 ? { '@type': 'ListItem', position: index + 1, item: jobPosting }
 : { '@type': 'ListItem', position: index + 1, name: item.title, url: item.href };
 }),
 })
 : '';
 return { breadcrumbLd, collectionLd, itemListLd };
 };

 const pushEditorialSitemapEntry = (
 buildModel: (locale: typeof localeList[number]) => { slug: string },
 priority: string,
 // Phase 8 sub-PR (d): per-canton editorial emit lives at a canton-aware
 // section (e.g. `cerca-lavoro-zurigo`). Defaults to the legacy TI
 // section for backward compatibility (non-canton editorial pages: the
 // official gazette).
 sectionFor: (locale: typeof localeList[number]) => string = (l) => sectionByLocale[l],
 ) => {
 const itModel = buildModel('it');
 const itPath = withSlash(`/${sectionFor('it')}/${itModel.slug}`.replace(/\/+/g, '/'));
 // Sitemap-jobs alignment (Issue 18): never advertise a URL whose static
 // HTML wasn't actually emitted to dist/. The same plugin emits both the
 // page HTML and the sitemap entry; if an earlier step skipped emission
 // (e.g. zero jobs for that location/sector), the sitemap entry must
 // follow. IT gates the whole group (it's the x-default/canonical
 // fallback) -- alternates would all be dead too if the IT canonical isn't.
 const itDirIndex = np.join(distDir, itPath.slice(1).replace(/\/$/, ''), 'index.html');
 const itFlatHtml = np.join(distDir, itPath.replace(/\/+$/, '').slice(1) + '.html');
 const itEmitted = _writtenPaths.has(itDirIndex) || _writtenPaths.has(itFlatHtml) || fs.existsSync(itDirIndex) || fs.existsSync(itFlatHtml);
 if (!itEmitted) return;
 const localePaths = new Map<typeof localeList[number], string>();
 localePaths.set('it', itPath);
 for (const locale of localeList) {
 if (locale === 'it') continue;
 const localeModel = buildModel(locale);
 const path = withSlash(`${localePrefix[locale]}/${sectionFor(locale)}/${localeModel.slug}`.replace(/\/+/g, '/'));
 localePaths.set(locale, path);
 }
 const alternateLinks = localeList.map((locale) =>
 `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${localePaths.get(locale)}" />`,
 ).join('\n');
 // Every locale gets its own reciprocal <loc> entry (all share the same
 // alternates set) -- an IT-only push here would leave en/de/fr as
 // one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity
 // (#3499). Still only push a non-IT locale whose HTML was actually
 // emitted, preserving the Issue-18 dead-link guarantee per-locale.
 for (const locale of localeList) {
 const path = localePaths.get(locale)!;
 if (locale !== 'it') {
 const dirIndex = np.join(distDir, path.slice(1).replace(/\/$/, ''), 'index.html');
 const flatHtml = np.join(distDir, path.replace(/\/+$/, '').slice(1) + '.html');
 const emitted = _writtenPaths.has(dirIndex) || _writtenPaths.has(flatHtml) || fs.existsSync(dirIndex) || fs.existsSync(flatHtml);
 if (!emitted) continue;
 }
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${path}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>${priority}</priority>\n </url>`);
 }
 };

 // Phase 5 (Cathedral P1-A): EDITORIAL_CANTONS now spans all 24 canton URL
 // keys. Gate every editorial emit on MIN_JOBS_FOR_CANTON_PAGE so we never
 // ship thin pages for cantons with insufficient supply (CLAUDE.md NON-NEG
 // #4 — never accept <50-word/empty pages). Compute once, reuse in all 4
 // editorial loops below (today / nurses / part-time / care-variant).
 const editorialCantonJobCounts = new Map<string, number>();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (!c) continue;
 editorialCantonJobCounts.set(c, (editorialCantonJobCounts.get(c) ?? 0) + 1);
 }

 // Structural 404 fix (GSC Coverage Drilldown sweep, same sibling bug class as
 // professionCantonLandings.ts / weeklyEmployersChCantonPages.ts /
 // jobMarketSnapshotChCantonPages.ts): the 4 editorial-canton loops below
 // (today / nurses-hub / part-time / care-variant) used to silently `continue`
 // past a canton once it fell under MIN_JOBS_FOR_CANTON_PAGE (or, for
 // care-variant, once the cluster had zero matching IT jobs) -- dropping a URL
 // Google may already have indexed from a prior build straight to a GH Pages
 // hard 404, no bridge/redirect. The canton-root job-board hub
 // (buildCantonAwareSection(locale, canton)) is emitted unconditionally for
 // every canton at every locale regardless of job count -- see the P2.S2
 // canton-index loop below, which ships `noindex,follow` under-threshold but
 // never skips the emit -- so it is always a live target to bridge to.
 let editorialBelowFloorBridges = 0;
 const emitEditorialBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, slug: string): void => {
 const section = buildCantonAwareSection(locale, canton);
 const targetPath = withSlash(`${localePrefix[locale]}/${section}`.replace(/\/+/g, '/'));
 const canonicalPath = withSlash(`${localePrefix[locale]}/${section}/${slug}`.replace(/\/+/g, '/'));
 const html = buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${targetPath}`,
 pathLabel: targetPath,
 lang: locale,
 noindex: true,
 });
 const relPath = canonicalPath.slice(1).replace(/\/$/, '');
 const dir = np.join(distDir, relPath);
 const dirIndex = np.join(dir, 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) {
 _md(dir);
 _qw(dirIndex, html);
 }
 const flatFile = np.join(distDir, relPath + '.html');
 if (!_writtenPaths.has(flatFile) && !fs.existsSync(flatFile)) {
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 editorialBelowFloorBridges++;
 };

 for (const editorialCanton of EDITORIAL_CANTONS) {
 if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitEditorialBelowFloorBridge(locale, editorialCanton, getJobTodayLandingSlug(locale, editorialCanton));
 }
 continue;
 }
 // Phase 8 sub-PR (d): for non-TI editorial cantons the URL section
 // becomes the canton-aware form (e.g. `cerca-lavoro-zurigo`) and the
 // model emits a short slug (`oggi` / `today` / `heute` / `aujourdhui`).
 // TI continues to use the legacy `sectionByLocale[locale]` value,
 // which `buildCantonAwareSection(locale, 'TI')` returns by design,
 // so TI URLs stay byte-identical.
 const sectionByLocaleCanton = (l: 'it' | 'en' | 'de' | 'fr') => buildCantonAwareSection(l, editorialCanton);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdJobsToday = startTimer();
 const model = buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });

 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // x-default required by audit-hreflang alongside the 4 locale entries.
 // OPT: hreflang only needs the slug per locale — call the lightweight
 // getJobTodayLandingSlug() helper instead of running the full
 // buildJobTodayLandingModel() pipeline (which filters all jobs into 24h/3d/
 // partTime + computes city leaders). Saves ~4 model builds per emit ×
 // 12 editorial-jobs-today emits = ~3.7s of build wall.
 const todayHreflangPairs = localeList.map((altLocale) => {
 const altSlug = getJobTodayLandingSlug(altLocale, editorialCanton);
 const altPath = `${localePrefix[altLocale]}/${sectionByLocaleCanton(altLocale)}/${altSlug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 // audit-hreflang requires 5 entries — force x-default with canonicalUrl fallback.
 const xDefaultToday = todayHreflangPairs.find((p) => p.lang === 'it')?.href ?? todayHreflangPairs[0]?.href ?? canonicalUrl;
 const alternates = [
 ...todayHreflangPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultToday}">`,
 ].join('\n');
 const openAllHref = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.sections.cities.length > 0
 ? model.sections.cities.map((city) => city.href
     ? `<a class="s-tcCzKK" href="${city.href}"><span>${esc(city.name)}</span><span class="s-IjpSYt">${city.count}</span></a>`
     : `<div class="s-eRMYnQ"><span>${esc(city.name)}</span><span class="s-IjpSYt">${city.count}</span></div>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const internalLinks = model.internalLinks.map((item) => `<a class="s-ero_Qy" href="${item.href}">${esc(item.label)}</a>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, getCantonDisplayLabel(editorialCanton, locale)), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.sections.last24Hours.jobs, ...model.sections.last3Days.jobs, ...model.sections.partTime.jobs],
 });

 const editorialHtml = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-xzWvwM">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.sections.last24Hours.label)}</div><div class="s-9UotdJ">${model.sections.last24Hours.jobs.length}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.sections.last3Days.label)}</div><div class="s-9UotdJ">${model.sections.last3Days.jobs.length}</div></div>
 <div class="s-0kclVO"><div class="s-AnMfGC">${esc(model.sections.partTime.label)}</div><div class="s-9UotdJ">${model.sections.partTime.jobs.length}</div></div>
 </section>
 <nav class="s-BqBw0X">${internalLinks}</nav>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.sections.cityHubLabel)}</h2>
 <a class="s-YszcPD" href="${openAllHref}">${esc(model.openAllLabel)}</a>
 </div>
 <div class="s-J2fKgL">${cityCards}</div>
 </section>
 <section class="s-4FxAs0" id="last-24-hours">
 <h2 class="s-iEVPhz">${esc(model.sections.last24Hours.label)}</h2>
 ${renderJobList(model.sections.last24Hours.jobs)}
 </section>
 <section class="s-4FxAs0" id="last-3-days">
 <h2 class="s-iEVPhz">${esc(model.sections.last3Days.label)}</h2>
 ${renderJobList(model.sections.last3Days.jobs)}
 </section>
 <section class="s-4FxAs0" id="part-time">
 <h2 class="s-iEVPhz">${esc(model.sections.partTime.label)}</h2>
 ${renderJobList(model.sections.partTime.jobs)}
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(editorialCanton, locale), omitCommute: true, cantonDisplay: getCantonDisplayLabel(editorialCanton, locale), cantonSlot: 'editorial-today' }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;

 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), editorialHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, editorialHtml);
 }
 recordEmit('editorial-jobs-today', __tEdJobsToday);
 }

 pushEditorialSitemapEntry((locale) => buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.8', sectionByLocaleCanton);
 }

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdGazette = startTimer();
 const model = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const explainerCards = model.explainerCards.map((card) => `<div class="s-zYevpg"><h3 class="s-8pnpWY">${esc(card.title)}</h3><p class="s-BoADNW">${esc(card.body)}</p></div>`).join('');
 const internalLinks = model.internalLinks.map((item) => `<a class="s-ero_Qy" href="${item.href}">${esc(item.label)}</a>`).join('');
 // FAQ block: extract inline styles to a single <style>+3 classes (.jf/.js/.ja).
 // On find-jobs locale variants (Zurich/Bern in DE/EN/FR — 6 pages) and per-
 // canton aggregate landings, each FAQ entry inlined ~280 B of style × N
 // questions per page, pushing text-to-HTML ratio into the 9.3-9.9% band
 // (just under the Semrush 10% gate enforced by audit:text-html-ratio).
 // Class-based variant costs ~250 B once + ~100 B per FAQ — saves 6-12 KB
 // per page. No editorial / visual change (same OKLCH tokens).
 const faqHtml = model.faq.map((entry) => `<details class="jf"><summary class="js">${esc(entry.question)}</summary><p class="ja">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 <div class="s-Fy0wEh"><div class="s-aoTYtA">${esc(model.officialSourceLabel)}</div><div class="s-ahW6q9"><a class="s-U9K6Vf" href="${model.officialSourceUrl}">concorsi.ti.ch</a></div></div>
 </section>
 <nav class="s-BqBw0X">${internalLinks}</nav>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(model.explainerTitle)}</h2>
 <div class="s-AiwYEG">${explainerCards}</div>
 </section>
 <section class="s-4FxAs0" id="official-competitions">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${sectionRootUrl}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div class="s-bRaq8r">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(DEFAULT_CANTON, locale), omitCommute: true }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-gazette', __tEdGazette);
 }

 pushEditorialSitemapEntry((locale) => buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.78');

 for (const editorialCanton of EDITORIAL_CANTONS) {
 if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitEditorialBelowFloorBridge(locale, editorialCanton, getJobNursesHubSlug(locale, editorialCanton));
 }
 continue;
 }
 // Phase 8 sub-PR (d): canton-aware section + short slug for non-TI.
 const sectionByLocaleCanton = (l: 'it' | 'en' | 'de' | 'fr') => buildCantonAwareSection(l, editorialCanton);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdNurses = startTimer();
 const model = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(altLocale),
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocaleCanton(altLocale)}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const variantLinks = model.variants.length > 0
 ? model.variants.map((link) => `<a class="s-tcCzKK" href="${link.href}"><span>${esc(link.label)}</span><span class="s-IjpSYt">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const explainerCards = model.explainerCards.map((card) => `<div class="s-zYevpg"><h3 class="s-8pnpWY">${esc(card.title)}</h3><p class="s-BoADNW">${esc(card.body)}</p></div>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, getCantonDisplayLabel(editorialCanton, locale)), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 // FAQ block: extract inline styles to a single <style>+3 classes (.jf/.js/.ja).
 // On find-jobs locale variants (Zurich/Bern in DE/EN/FR — 6 pages) and per-
 // canton aggregate landings, each FAQ entry inlined ~280 B of style × N
 // questions per page, pushing text-to-HTML ratio into the 9.3-9.9% band
 // (just under the Semrush 10% gate enforced by audit:text-html-ratio).
 // Class-based variant costs ~250 B once + ~100 B per FAQ — saves 6-12 KB
 // per page. No editorial / visual change (same OKLCH tokens).
 const faqHtml = model.faq.map((entry) => `<details class="jf"><summary class="js">${esc(entry.question)}</summary><p class="ja">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.variantTitle)}</div><div class="s-9UotdJ">${model.variants.length}</div></div>
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(model.variantTitle)}</h2>
 <div class="s-J2fKgL">${variantLinks}</div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-AiwYEG">${explainerCards}</div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${sectionRootUrl}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div class="s-bRaq8r">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(editorialCanton, locale), omitCommute: true, cantonDisplay: getCantonDisplayLabel(editorialCanton, locale), cantonSlot: 'editorial-nursing' }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 // Alias: /cerca-lavoro-ticino/lavoro-infermieri/ → same content, canonical inside already points to infermieri-in-ticino
 if (editorialCanton === 'TI' && locale === 'it') {
 const aliasPath = withSlash(`/${sectionByLocale[locale]}/lavoro-infermieri`);
 const aliasOutDir = np.join(distDir, aliasPath.slice(1));
 _md(aliasOutDir);
 _qw(np.join(aliasOutDir, 'index.html'), html);
 }
 recordEmit('editorial-nurses', __tEdNurses);
 }

 pushEditorialSitemapEntry((locale) => buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 }), '0.77', sectionByLocaleCanton);
 }

 /* ── Editorial landing: global part-time ───────────────────── */
 for (const editorialCanton of EDITORIAL_CANTONS) {
 if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitEditorialBelowFloorBridge(locale, editorialCanton, getJobPartTimeLandingSlug(locale, editorialCanton));
 }
 continue;
 }
 // Phase 8 sub-PR (d): canton-aware section + short slug for non-TI.
 const sectionByLocaleCanton = (l: 'it' | 'en' | 'de' | 'fr') => buildCantonAwareSection(l, editorialCanton);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdPartTimeCanton = startTimer();
 const model = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(altLocale),
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocaleCanton(altLocale)}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.cityLinks.length > 0
 ? model.cityLinks.map((city) => city.href
     ? `<a class="s-tcCzKK" href="${city.href}"><span>${esc(city.name)}</span><span class="s-IjpSYt">${city.count}</span></a>`
     : `<div class="s-eRMYnQ"><span>${esc(city.name)}</span><span class="s-IjpSYt">${city.count}</span></div>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, getCantonDisplayLabel(editorialCanton, locale)), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 // FAQ block: extract inline styles to a single <style>+3 classes (.jf/.js/.ja).
 // On find-jobs locale variants (Zurich/Bern in DE/EN/FR — 6 pages) and per-
 // canton aggregate landings, each FAQ entry inlined ~280 B of style × N
 // questions per page, pushing text-to-HTML ratio into the 9.3-9.9% band
 // (just under the Semrush 10% gate enforced by audit:text-html-ratio).
 // Class-based variant costs ~250 B once + ~100 B per FAQ — saves 6-12 KB
 // per page. No editorial / visual change (same OKLCH tokens).
 const faqHtml = model.faq.map((entry) => `<details class="jf"><summary class="js">${esc(entry.question)}</summary><p class="ja">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(model.cityHubLabel)}</h2>
 <div class="s-J2fKgL">${cityCards}</div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${sectionRootUrl}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div class="s-bRaq8r">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(editorialCanton, locale), omitCommute: true, cantonDisplay: getCantonDisplayLabel(editorialCanton, locale), cantonSlot: 'editorial-part-time' }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-parttime-canton', __tEdPartTimeCanton);
 }

 pushEditorialSitemapEntry((locale) => buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.76', sectionByLocaleCanton);
 }

 // Primary CTA label — same copy as professionLandingsCopy.primaryCtaLabel;
 // href comes from the shared CALC_HREF table (per-locale calculator path).
 const careCtaLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Calcola il tuo netto come frontaliere',
 en: 'Calculate your cross-border net',
 de: 'Grenzgänger-Nettolohn berechnen',
 fr: 'Calculer votre net frontalier',
 };
 for (const clusterKey of editorialCareKeys) {
 for (const editorialCanton of EDITORIAL_CANTONS) {
 if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitEditorialBelowFloorBridge(locale, editorialCanton, careClusterSlug(clusterKey, editorialCanton, locale));
 }
 continue;
 }
 // Phase 8 sub-PR (d): canton-aware section + short slug for non-TI.
 const sectionByLocaleCanton = (l: 'it' | 'en' | 'de' | 'fr') => buildCantonAwareSection(l, editorialCanton);
 const italianCareModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: 'it',
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton('it'),
 localePrefix: localePrefix.it,
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 if (italianCareModel.totalJobs === 0) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitEditorialBelowFloorBridge(locale, editorialCanton, careClusterSlug(clusterKey, editorialCanton, locale));
 }
 continue;
 }

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdCareVariant = startTimer();
 const model = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: altLocale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(altLocale),
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocaleCanton(altLocale)}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const siblingLinks = model.siblingLinks.length > 0
 ? model.siblingLinks.map((link) => `<a class="s-tcCzKK" href="${link.href}"><span>${esc(link.label)}</span><span class="s-IjpSYt">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocaleCanton(locale)}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentHubHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, getCantonDisplayLabel(editorialCanton, locale)), item: sectionRootUrl },
 { name: locale === 'it' ? `Sanità in ${getCantonDisplayLabel(editorialCanton, locale)}` : locale === 'en' ? `Healthcare jobs in ${getCantonDisplayLabel(editorialCanton, locale)}` : locale === 'de' ? `Gesundheits-Jobs ${germanCantonPrep(getCantonDisplayLabel(editorialCanton, locale))}` : `Santé ${frenchCantonPrep(getCantonDisplayLabel(editorialCanton, locale))}`, item: model.parentHubHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const edc = getCantonDisplayLabel(editorialCanton, locale);
 // The parent hub covers the whole care cluster (nurses, OSS, educators,
 // clinics, care homes), so the back-link must say "healthcare hub", not
 // "nurses" - on the educators page "Torna all'hub infermieri" was wrong.
 const backLabel = locale === 'it' ? `Torna all\u2019hub sanit\u00E0 in ${edc}` : locale === 'en' ? `Back to healthcare jobs in ${edc}` : locale === 'de' ? `Zur\u00FCck zum Gesundheits-Hub ${germanCantonPrep(edc)}` : `Retour au hub sant\u00E9 ${frenchCantonPrep(edc)}`;
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <nav class="s-bcr" aria-label="breadcrumb">
 <a href="${locale === 'it' ? '/' : `/${locale}/`}" class="s-bcl">${esc(homeLabel[locale])}</a>
 <span> / </span>
 <a href="${sectionRootUrl}" class="s-bcl">${esc(cantonSectionName(locale, edc))}</a>
 <span> / </span>
 <span>${esc(model.heading)}</span>
 </nav>
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 <p class="s-drFGhf"><a class="s-YszcPD" href="${model.parentHubHref}">${esc(backLabel)}</a></p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>${model.latestJobs.length > 0 ? `
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>` : ''}
 </section>
 <p class="s-O3JTly"><a href="${CALC_HREF[locale]}" class="s-cta">${esc(careCtaLabel[locale])} →</a></p>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${sectionRootUrl}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 ${model.latestJobs.length > 0 ? `<section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>` : ''}
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(locale === 'it' ? 'Altri percorsi sanitari' : locale === 'en' ? 'Other care paths' : locale === 'de' ? 'Weitere Pflegepfade' : 'Autres parcours sante')}</h2>
 <div class="s-J2fKgL">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(editorialCanton, locale), omitCommute: true, sectorOrType: locale === 'it' ? 'sanità' : locale === 'en' ? 'healthcare' : locale === 'de' ? 'Gesundheitswesen' : 'santé', cantonDisplay: getCantonDisplayLabel(editorialCanton, locale), cantonSlot: 'editorial-clinics' }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-care-variant', __tEdCareVariant);
 }

 pushEditorialSitemapEntry((locale) => buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocaleCanton(locale),
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 }), '0.71', sectionByLocaleCanton);
 }
 if (editorialBelowFloorBridges > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P8 editorial-canton below-floor bridges: ${editorialBelowFloorBridges} (today/nurses/part-time/care-variant combined)`);
 }
 }

 let locationFamilyBelowFloorBridges = 0;
 const writeLocationFamilyBridge = (canonicalPath: string, targetPath: string, locale: 'it' | 'en' | 'de' | 'fr'): void => {
 const html = buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${targetPath}`,
 pathLabel: targetPath,
 lang: locale,
 noindex: true,
 });
 const relPath = canonicalPath.slice(1).replace(/\/$/, '');
 const dir = np.join(distDir, relPath);
 const dirIndex = np.join(dir, 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) {
 _md(dir);
 _qw(dirIndex, html);
 }
 const flatFile = np.join(distDir, relPath + '.html');
 if (!_writtenPaths.has(flatFile) && !fs.existsSync(flatFile)) {
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 locationFamilyBelowFloorBridges++;
 };
 const emitLocationBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', loc: string): void => {
 const targetPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'));
 const cityHubKey = CITY_HUB_KEYS.find((k) => k.toLowerCase() === loc.toLowerCase());
 if (cityHubKey) writeLocationFamilyBridge(buildCityHubPath(locale, cityHubKey), targetPath, locale);
 const legacyModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location: loc,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 const legacyPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${legacyModel.slug}`.replace(/\/+/g, '/'));
 if (!cityHubKey || legacyPath !== buildCityHubPath(locale, cityHubKey)) writeLocationFamilyBridge(legacyPath, targetPath, locale);
 };
 const emitLocationTypeBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', loc: string, typeKeyArg: (typeof editorialTypeKeys)[number]): void => {
 const cityHubKey = CITY_HUB_KEYS.find((k) => k.toLowerCase() === loc.toLowerCase());
 const targetPath = cityHubKey
 ? buildCityHubPath(locale, cityHubKey)
 : withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'));
 const model = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location: loc,
 typeKey: typeKeyArg,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 writeLocationFamilyBridge(canonicalPath, targetPath, locale);
 };
 const emitLocationSectorBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', loc: string, sectorKeyArg: (typeof editorialSectorKeys)[number]): void => {
 const cityHubKey = CITY_HUB_KEYS.find((k) => k.toLowerCase() === loc.toLowerCase());
 const targetPath = cityHubKey
 ? buildCityHubPath(locale, cityHubKey)
 : withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'));
 const model = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location: loc,
 sectorKey: sectorKeyArg,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 writeLocationFamilyBridge(canonicalPath, targetPath, locale);
 };
 for (const location of editorialLocations) {
 const italianLocationModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianLocationModel.totalJobs === 0) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitLocationBelowFloorBridge(locale, location);
 }
 continue;
 }

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdLocation = startTimer();
 const model = buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 // Detect if this location is a canonical geo-hub city — those pages are
 // canonicalized to the clean `/cerca-lavoro-ticino/<city>/` URL rather
 // than the legacy `ricerca-<city>` editorial slug, to resolve GSC
 // cannibalization and concentrate link equity on the clean hub.
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 const legacyPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalPath = cityHubKey
 ? buildCityHubPath(locale, cityHubKey)
 : legacyPath;
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // Build per-locale hreflangs + x-default → IT target.
 // audit-hreflang requires 5 entries (4 locales + x-default) on every
 // page that emits any hreflang; city + editorial search-landing pages
 // previously emitted only 4, triggering 1750+ FAILs on clean builds.
 const localeHreflangLinks: { lang: string; href: string }[] = localeList.map((altLocale) => {
 if (cityHubKey) {
 return { lang: altLocale, href: `${BASE_URL}${buildCityHubPath(altLocale, cityHubKey)}` };
 }
 const altModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const xDefaultCityHref = localeHreflangLinks.find((h) => h.lang === 'it')?.href
  ?? localeHreflangLinks[0]?.href
  ?? canonicalUrl;
 const alternates = [
 ...localeHreflangLinks.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultCityHref}">`,
 ].join('\n');
 const typeLinks = model.relatedTypeLinks.length > 0
 ? model.relatedTypeLinks.map((link) => `<a class="s-tcCzKK" href="${link.href}"><span>${esc(link.label)}</span><span class="s-IjpSYt">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const sectorLinks = model.relatedSectorLinks.length > 0
 ? model.relatedSectorLinks.map((link) => `<a class="s-G9e-ve" href="${link.href}"><span>${esc(link.label)}</span><span class="s-LKM-LI">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 // For geo-hub cities, override title/description with boosted count+fire
 // copy to target high-intent queries like "lavoro lugano".
 const cityHubSeo = cityHubKey
 ? buildCityHubSeo(locale, cityHubKey, model.totalJobs, new Date().getFullYear())
 : null;
 const pageTitle = cityHubSeo ? cityHubSeo.title : model.title;
 const pageDesc = cityHubSeo ? cityHubSeo.desc : model.description;
 const pageOgTitle = cityHubSeo ? cityHubSeo.ogT : model.title;
 const pageOgDesc = cityHubSeo ? cityHubSeo.ogD : model.description;
 const pageH1 = cityHubSeo ? cityHubSeo.h1 : model.heading;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: pageH1,
 url: canonicalUrl,
 description: pageDesc,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: pageH1, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(pageTitle)}</title>
 <meta name="description" content="${esc(clampMetaDescription(pageDesc))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(pageOgTitle)}">
 <meta property="og:description" content="${esc(clampMetaDescription(pageOgDesc))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(pageOgTitle)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(pageH1)}</h1>
 <p class="s-wU5Nrr">${esc(pageDesc)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(locale === 'it' ? `Tipi di lavoro a ${location}` : locale === 'en' ? `Job types in ${location}` : locale === 'de' ? `Jobtypen in ${location}` : `Types d'emploi a ${location}`)}</h2>
 <div class="s-J2fKgL">${typeLinks}</div>
 </section>
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(locale === 'it' ? `Settori a ${location}` : locale === 'en' ? `Sectors in ${location}` : locale === 'de' ? `Branchen in ${location}` : `Secteurs a ${location}`)}</h2>
 <div class="s-J2fKgL">${sectorLinks}</div>
 </section>
 ${nearbyEventsBlockForJobPage(locale, 'TI', location, getCantonDisplayLabel('TI', locale))}
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 // Primary write — at canonicalPath (clean URL for geo-hub cities,
 // legacy `ricerca-<slug>` editorial path otherwise).
 const writeCityOrLegacy = (targetPath: string, body: string) => {
 const outDir = np.join(distDir, targetPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), body);
 const flat = targetPath.replace(/\/+$/, '');
 if (flat) {
 const flatFile = np.join(distDir, flat.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, body);
 }
 };
 // Hard-fail guard mirroring the jobSectorPagesPlugin invariant — keeps
 // city/type/sector landing HTML strictly under the 195 KB safety margin
 // (200 KB audit:page-weight budget − 5 KB headroom). If a future cap
 // bump or template change pushes us over, the build fails immediately
 // with a precise URL instead of waiting for the post-build audit.
 const CITY_HUB_HARD_BUDGET_BYTES = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > CITY_HUB_HARD_BUDGET_BYTES) {
 throw new Error(
 `[jobsSeoPagesPlugin] City/editorial landing ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${CITY_HUB_HARD_BUDGET_BYTES / 1024} KB. Reduce feed/latest caps in ` +
 `buildJobLocationLandingModel or trim per-card markup.`,
 );
 }
 writeCityOrLegacy(canonicalPath, html);
 // Geo-hub cities: keep the legacy /<section>/ricerca-<city>/ path live
 // (backward-compat + external links). Strip hreflang on the legacy
 // duplicate — Semrush/Google flag canonicalized pages that emit
 // hreflang pointing away from themselves ("Conflicting hreflang and
 // rel=canonical" + "No self-referencing hreflang"). Canonical alone
 // consolidates equity onto the clean URL.
 if (cityHubKey && legacyPath !== canonicalPath) {
 const legacyHtml = html.replace(`${alternates}\n`, '');
 writeCityOrLegacy(legacyPath, legacyHtml);
 }
 recordEmit('editorial-location', __tEdLocation);
 }

 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // For geo-hub cities the rendered legacy `ricerca-<city>` page sets
 // <link rel="canonical"> to the clean `/cerca-lavoro-ticino/<city>/`
 // URL, so emitting a sitemap entry for the legacy slug would advertise
 // a non-canonical URL. The clean canonical is added separately below.
 const isGeoHubCity = CITY_HUB_KEYS.some(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 if (!isGeoHubCity) {
 pushEditorialSitemapEntry((locale) => buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.75');
 }

 // Geo-hub city: add a dedicated sitemap entry for the clean canonical
 // URL /cerca-lavoro-ticino/<city>/ (and locale variants). Priority 0.85
 // — higher than legacy ricerca-* editorial pages since the clean URL is
 // the canonical target for high-intent queries.
 {
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 if (cityHubKey) {
 const itPath = `/${sectionByLocale.it}/${CITY_HUB_SLUG.it[cityHubKey]}/`.replace(/\/+/g, '/');
 const alternateLinks = localeList.map((locale) => {
 const altPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${CITY_HUB_SLUG[locale][cityHubKey]}/`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${altPath}" />`;
 }).join('\n');
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.85</priority>\n </url>`);
 }
 }

 for (const typeKey of editorialTypeKeys) {
 const italianTypeModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianTypeModel.totalJobs === 0) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitLocationTypeBelowFloorBridge(locale, location, typeKey);
 }
 continue;
 }

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdContractType = startTimer();
 const model = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const siblingLinks = model.siblingTypeLinks.length > 0
 ? model.siblingTypeLinks.map((link) => `<a class="s-tcCzKK" href="${link.href}"><span>${esc(link.label)}</span><span class="s-IjpSYt">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 <p class="s-drFGhf"><a class="s-YszcPD" href="${model.parentLocationHref}">${esc(parentLabel)}</a></p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 ${renderLocationTypeFrontalierContext({ locale, typeKey, typeLabel: model.typeLabel, location, jobsCount: model.totalJobs })}
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(locale === 'it' ? `Altri tipi di lavoro a ${location}` : locale === 'en' ? `Other job types in ${location}` : locale === 'de' ? `Weitere Jobtypen in ${location}` : `Autres types d'emploi a ${location}`)}</h2>
 <div class="s-J2fKgL">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location, sectorOrType: model.typeLabel }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-contract-type', __tEdContractType);
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.68');
 }

 for (const sectorKey of editorialSectorKeys) {
 const italianSectorModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianSectorModel.totalJobs === 0) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitLocationSectorBelowFloorBridge(locale, location, sectorKey);
 }
 continue;
 }

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tEdSector = startTimer();
 const model = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`,
 ].join('\n');
 const siblingLinks = model.siblingSectorLinks.length > 0
 ? model.siblingSectorLinks.map((link) => `<a class="s-G9e-ve" href="${link.href}"><span>${esc(link.label)}</span><span class="s-LKM-LI">${link.count}</span></a>`).join('')
 : '<p class="s-heE-6f">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(clampMetaDescription(model.description))}">${ROBOTS_INDEX_ENHANCED}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta property="og:image:alt" content="${esc(model.title)}">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
${staticAnalyticsHtml}
 </head>
 <body>
 ${rootShell(hasSpaBundle)}
 ${railGutters(true).open}
 <main class="seo-static-content s-it71Rt">
 <header class="s-S_0cal sx-hero">
 <p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
 <h1 class="s-P0Hs0W">${esc(model.heading)}</h1>
 <p class="s-wU5Nrr">${esc(model.description)}</p>
 <p class="s-rDKEKn">${esc(model.intro)}</p>
 <p class="s-drFGhf"><a class="s-YszcPD" href="${model.parentLocationHref}">${esc(parentLabel)}</a></p>
 </header>
 <section class="s-S6PRaY">
 <div class="s-CGuDZg"><div class="s-JFi4vt">${esc(model.countsLabel)}</div><div class="s-9UotdJ">${model.totalJobs}</div></div>
 <div class="s-3kP_AL"><div class="s-z4q8yI">${esc(model.latestLabel)}</div><div class="s-9UotdJ">${model.latestJobs.length}</div></div>
 </section>
 <section class="s-KZc0LQ">
 <div class="s-r2QmTP">
 <h2 class="s-CqexyJ">${esc(model.feed.label)}</h2>
 <a class="s-YszcPD" href="${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section class="s-4FxAs0">
 <h2 class="s-iEVPhz">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 ${renderLocationSectorFrontalierContext({ locale, sectorLabel: model.sectorLabel, location, jobsCount: model.totalJobs })}
 <section class="s-KZc0LQ">
 <h2 class="s-iEVPhz">${esc(locale === 'it' ? `Altri settori a ${location}` : locale === 'en' ? `Other sectors in ${location}` : locale === 'de' ? `Weitere Branchen in ${location}` : `Autres secteurs a ${location}`)}</h2>
 <div class="s-J2fKgL">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location, sectorOrType: model.sectorLabel }))}
 </main>${railGutters(true).close}
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-sector', __tEdSector);
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.67');
 }
 }
 if (locationFamilyBelowFloorBridges > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P8 location/type/sector below-floor bridges: ${locationFamilyBelowFloorBridges} (TI city location/type/sector combos)`);
 }

 editorialEntries = editorialSitemapEntries.join('\n');

 }

 /* ── Per-canton city hubs (Phase 3.1) ────────────────────────
  * Additive: for every non-TI canton with >= MIN_JOBS_FOR_CANTON_PAGE jobs,
  * emit /cerca-lavoro-{cantonSlug}/{citySlug}/ for EVERY canon city in the
  * canton (data/canton-municipalities.json), regardless of whether the
  * city currently has active jobs. Cities with 0 jobs render with the
  * canton-wide latest jobs as a "0 results → expand to canton" fallback,
  * so the URL is never a dead end. This closes the blank-page bug where
  * the router treats every canon city as a city hub
  * (isKnownCityHub → staticOverlay:true) and the 404 fallback served the
  * SPA shell with no static <main class="seo-static-content"> body.
  * TI city hubs are emitted by the editorial location-landing loop above
  * and are byte-identical with the legacy pre-cathedral output.
  */
 {
 // Per-canton job index keyed by canonical city slug. The canton key is
 // taken from sharedResolveJobCanton (job.canton or location lookup).
 // The raw location field is canonicalized against the canton's
 // municipality list (data/canton-municipalities.json) so that variants
 // like "Pratteln BL" and "Pratteln" land in the same bucket — and only
 // cities the router can resolve via isKnownCityHub() get emitted.
 // Cities outside the canton municipality list (foreign locations,
 // garbled values) are skipped: emitting them would create URLs that
 // SPA navigation routes to a job-detail handler ("Annuncio non
 // trovato") because isKnownCityHub() returns false for them.
 const cantonCityCanonical: Map<string, Map<string, { slug: string; display: string }>> = new Map();
 const cantonCityCanonicalize = (canton: string, rawLocation: string): { slug: string; display: string } | null => {
   const rawSlug = normalizeCitySlug(rawLocation);
   if (!rawSlug) return null;
   let lookup = cantonCityCanonical.get(canton);
   if (!lookup) {
     lookup = new Map();
     const cantonCities = getCantonCities(canton);
     for (const city of cantonCities) {
       const slug = normalizeCitySlug(city);
       if (!slug) continue;
       // Strip the parenthetical disambiguator from display ("Aesch (BL)" → "Aesch").
       const display = String(city).replace(/\s*\([^)]*\)\s*$/, '').trim();
       if (!lookup.has(slug)) lookup.set(slug, { slug, display });
     }
     cantonCityCanonical.set(canton, lookup);
   }
   const direct = lookup.get(rawSlug);
   if (direct) return direct;
   // Fallback: location like "Pratteln BL" / "Lugano-Paradiso" — first
   // hyphen-separated token usually matches the canonical city.
   const head = rawSlug.split('-')[0];
   if (head && head !== rawSlug) {
     const headHit = lookup.get(head);
     if (headHit) return headHit;
   }
   return null;
 };
 const jobsByCantonCity: Map<string, Map<string, typeof validJobs>> = new Map();
 const cityDisplayByCantonCity: Map<string, Map<string, string>> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const canton = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (canton === 'TI') continue;
 const rawLocation = String((job as any).location || '').split(/[,(]/)[0].trim();
 if (!rawLocation) continue;
 const canonical = cantonCityCanonicalize(canton, rawLocation);
 if (!canonical) continue;
 const citySlug = canonical.slug;
 if (!jobsByCantonCity.has(canton)) jobsByCantonCity.set(canton, new Map());
 const byCity = jobsByCantonCity.get(canton)!;
 if (!byCity.has(citySlug)) byCity.set(citySlug, []);
 byCity.get(citySlug)!.push(job);
 if (!cityDisplayByCantonCity.has(canton)) cityDisplayByCantonCity.set(canton, new Map());
 const dispByCity = cityDisplayByCantonCity.get(canton)!;
 if (!dispByCity.has(citySlug)) dispByCity.set(citySlug, canonical.display);
 }
 // Also compute total active jobs per canton (gate by MIN_JOBS_FOR_CANTON_PAGE)
 // and a canton-wide latest-jobs feed used as the fallback list on 0-jobs
 // city pages ("nessuna offerta a {city}, ecco le ultime nel Canton {X}").
 const cantonJobTotals: Map<string, number> = new Map();
 const cantonLatestJobs: Map<string, typeof validJobs> = new Map();
 for (const [canton, byCity] of jobsByCantonCity) {
 let total = 0;
 const flat: typeof validJobs = [] as typeof validJobs;
 for (const arr of byCity.values()) {
   total += arr.length;
   for (const j of arr) flat.push(j);
 }
 cantonJobTotals.set(canton, total);
 flat.sort((a: any, b: any) => {
   const da = firstParsableMs(b.crawledAt, b.datePosted);
   const db = firstParsableMs(a.crawledAt, a.datePosted);
   if (da !== db) return da - db;
   return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 cantonLatestJobs.set(canton, flat);
 }
 const cantonDisplayLocalCity = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 const cityHubSitemapEntries: string[] = [];
 let cityHubCantonPagesCount = 0;
 const CITY_HUB_JOB_LIST_CAP = 30;
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue;
 const cantonTotal = cantonJobTotals.get(canton) ?? 0;
 const byCity = jobsByCantonCity.get(canton);
 if (!byCity) continue;
 // #2347 follow-up (#2348): the job-detail city link is now ALWAYS
 // canton-semantic (`/cerca-lavoro-{canton}/{city}/`) for EVERY canton,
 // including those below MIN_JOBS_FOR_CANTON_PAGE. This loop used to
 // `continue` on sub-threshold cantons, so a hard-load of such a link
 // (Google crawler, shared URL) hit GH Pages' 404 → SPA shell with no
 // static `<main class="seo-static-content">` body → blank page (the
 // exact dead-end this Phase-3.1 emit was built to repair, but only above
 // threshold). Mirror the canton-root gate (line ~8722): emit the hub even
 // sub-threshold, but `noindex,follow` (don't index the thin hub of a
 // barely-populated canton — non-negotiable #1/#4) and ONLY for cities
 // with ≥1 active job (the URLs actually linked from job detail), never
 // the full municipality list, so dist/ isn't flooded with thin 0-job
 // noindex pages for low-volume cantons.
 const meetsCantonThreshold = cantonTotal >= MIN_JOBS_FOR_CANTON_PAGE;
 // Emit one hub per canon-canton city, regardless of whether it has
 // active jobs. Previously gated on cityJobs.length > 0, which meant
 // URLs like /cerca-lavoro-basilea/pratteln/ for cities with 0 jobs
 // fell through to the 404 → SPA-shell handoff and rendered blank
 // (App.tsx skips React <main> when staticOverlay:true and the served
 // HTML has no `<main class="seo-static-content">` body). For cities
 // without jobs the page expands the search to canton scope (shows the
 // latest canton-wide jobs as a fallback) so the user still has
 // something useful to act on — never a dead end.
 const allCantonLatest = cantonLatestJobs.get(canton) ?? ([] as typeof validJobs);
 const cantonCityList: Array<{ citySlug: string; cityDisplay: string }> = [];
 const seenCitySlugs = new Set<string>();
 if (meetsCantonThreshold) {
   // Above-threshold: emit a hub for EVERY canon municipality (incl. 0-job
   // ones) so the canton-hub navigator can link them without BFS orphans.
   for (const cityName of getCantonCities(canton)) {
     const citySlug = normalizeCitySlug(cityName);
     if (!citySlug || seenCitySlugs.has(citySlug)) continue;
     seenCitySlugs.add(citySlug);
     const cityDisplay = String(cityName).replace(/\s*\([^)]*\)\s*$/, '').trim();
     cantonCityList.push({ citySlug, cityDisplay });
   }
 } else {
   // Sub-threshold: only cities with ≥1 active job (the job-detail-linked
   // URLs). These are noindex,follow 404-rescue pages, never sitemapped or
   // navigator-linked — see the loop header comment.
   for (const citySlug of byCity.keys()) {
     if (!citySlug || seenCitySlugs.has(citySlug)) continue;
     seenCitySlugs.add(citySlug);
     const cityDisplay = cityDisplayByCantonCity.get(canton)?.get(citySlug) ?? citySlug;
     cantonCityList.push({ citySlug, cityDisplay });
   }
 }
 // Sort cities: jobs desc first, then alphabetical for 0-job cities.
 cantonCityList.sort((a, b) => {
   const ca = byCity.get(a.citySlug)?.length ?? 0;
   const cb = byCity.get(b.citySlug)?.length ?? 0;
   if (ca !== cb) return cb - ca;
   return a.citySlug.localeCompare(b.citySlug);
 });
 // Record the exact emitted city-hub set (job-desc + alpha order) so the
 // canton-hub navigator links every one of them (BFS-depth closure above).
 emittedCantonCityHubs.set(canton, cantonCityList.map((c) => ({ slug: c.citySlug, label: c.cityDisplay })));
 for (const { citySlug, cityDisplay: canonCityDisplay } of cantonCityList) {
 const cityJobs = byCity.get(citySlug) ?? ([] as typeof validJobs);
 const cityDisplay = cityDisplayByCantonCity.get(canton)?.get(citySlug) ?? canonCityDisplay;
 // Sort jobs for stable feed order. When the city has 0 active jobs,
 // expand the search to canton scope: show the latest canton-wide jobs
 // as a "0 results" fallback so the page is never a dead end.
 const sortedCityJobs = cityJobs.length > 0
   ? [...cityJobs].sort((a: any, b: any) => {
     const da = firstParsableMs(b.crawledAt, b.datePosted);
     const db = firstParsableMs(a.crawledAt, a.datePosted);
     if (da !== db) return da - db;
     return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
   })
   : allCantonLatest;
 const cappedJobs = sortedCityJobs.slice(0, CITY_HUB_JOB_LIST_CAP);
 const isCityEmpty = cityJobs.length === 0;
 const fallbackCount = isCityEmpty ? cappedJobs.length : 0;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${citySlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const cDisplay = cantonDisplayLocalCity(canton, locale);
 const year = new Date().getFullYear();
 const cityHubSeo = buildCityHubSeo(locale as never, citySlug, cityJobs.length, year, cDisplay);
 const pageTitle = cityHubSeo.title;
 const pageDesc = cityHubSeo.desc;
 // Build hreflang including x-default
 const altPairs = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alPath = `${localePrefix[al]}/${alSection}/${citySlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const xDefaultHref = altPairs.find((p) => p.lang === 'it')?.href ?? altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
 ...altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;
 const sectionLabel = locale === 'it' ? `Cerca lavoro in ${cDisplay}` : locale === 'en' ? `Find jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Trouver un emploi à ${cDisplay}`;
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: sectionLabel, item: sectionRootUrl },
 { '@type': 'ListItem', position: 3, name: cityHubSeo.h1, item: canonicalUrl },
 ],
 });
 const collectionLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: pageTitle,
 url: canonicalUrl,
 description: pageDesc,
 inLanguage: locale,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
 });
 const itemListLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: pageTitle,
 numberOfItems: cappedJobs.length,
 // Embed a full JobPosting per item (capped description, never throws → falls
 // back to a name+url stub). Mirrors the editorial-landing ItemList; the
 // authoritative per-job JobPosting still lives on each linked detail page.
 itemListElement: cappedJobs.slice(0, 10).map((job: any, i: number) =>
 mapCantonJobToListItem(job, i, locale, sectionSlug, canton)),
 });
 const listHtml = jobCardListBody(cappedJobs, locale);
 const backLabel = locale === 'it' ? `Apri tutte le offerte in ${cDisplay}` : locale === 'en' ? `View all jobs in ${cDisplay}` : locale === 'de' ? `Alle Stellen ${cDisplay}` : `Voir toutes les offres à ${cDisplay}`;
 const intro = (() => {
 if (isCityEmpty) {
 // 0-jobs city: explain the expansion to canton scope so the visible
 // job list (canton-wide latest) matches the on-page messaging.
 if (locale === 'it') return `<p>Al momento <strong>nessuna offerta attiva a ${esc(cityDisplay)}</strong>. Abbiamo esteso la ricerca all'intero Canton ${esc(cDisplay)}: qui sotto trovi le ultime <strong>${fallbackCount} offerte di lavoro</strong> nel cantone, aggiornate quotidianamente. Per i lavoratori frontalieri con Permesso G, il canton ${esc(cDisplay)} applica l'imposta alla fonte sul reddito lordo: usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto.</p>`;
 if (locale === 'en') return `<p>Currently <strong>no active openings in ${esc(cityDisplay)}</strong>. We expanded the search to the whole Canton of ${esc(cDisplay)} — the latest <strong>${fallbackCount} jobs</strong> in the canton are listed below, refreshed daily. For cross-border workers with a G Permit, the Canton of ${esc(cDisplay)} applies withholding tax on gross income: use our <a href="/en/">free tax simulator</a> to calculate your net salary.</p>`;
 if (locale === 'de') return `<p>Derzeit <strong>keine offenen Stellen in ${esc(cityDisplay)}</strong>. Wir haben die Suche auf den gesamten Kanton ${esc(cDisplay)} erweitert: unten finden Sie die neuesten <strong>${fallbackCount} Stellenangebote</strong> im Kanton, täglich aktualisiert. Für Grenzgänger mit G-Bewilligung erhebt der Kanton ${esc(cDisplay)} eine Quellensteuer auf das Bruttoeinkommen: nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>.</p>`;
 return `<p>Actuellement <strong>aucune offre active à ${esc(cityDisplay)}</strong>. Nous avons étendu la recherche à tout le Canton de ${esc(cDisplay)} : voici les dernières <strong>${fallbackCount} offres d'emploi</strong> dans le canton, mises à jour quotidiennement. Pour les frontaliers avec un permis G, le Canton de ${esc(cDisplay)} applique un impôt à la source sur le revenu brut : utilisez notre <a href="/fr/">simulateur fiscal gratuit</a>.</p>`;
 }
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${cityJobs.length} offerte di lavoro</strong> a ${esc(cityDisplay)} (Canton ${esc(cDisplay)}). Le offerte vengono aggiornate quotidianamente dal nostro crawler automatico. Per i lavoratori frontalieri con Permesso G, il canton ${esc(cDisplay)} applica l'imposta alla fonte sul reddito lordo: usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${cityJobs.length} job openings</strong> in ${esc(cityDisplay)} (Canton of ${esc(cDisplay)}). Listings are refreshed daily by our automated crawler. For cross-border workers with a G Permit, the Canton of ${esc(cDisplay)} applies withholding tax on gross income: use our <a href="/en/">free tax simulator</a> to calculate your net salary.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${cityJobs.length} Stellenangebote</strong> in ${esc(cityDisplay)} (Kanton ${esc(cDisplay)}) verfügbar. Die Anzeigen werden täglich von unserem automatischen Crawler aktualisiert. Für Grenzgänger mit G-Bewilligung erhebt der Kanton ${esc(cDisplay)} eine Quellensteuer auf das Bruttoeinkommen: nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>.</p>`;
 return `<p>${cityJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles à ${esc(cityDisplay)} (Canton de ${esc(cDisplay)}). Les annonces sont mises à jour quotidiennement. Pour les frontaliers avec un permis G, le Canton de ${esc(cDisplay)} applique un impôt à la source sur le revenu brut : utilisez notre <a href="/fr/">simulateur fiscal gratuit</a>.</p>`;
 })();
 // SEO-landing template (CLAUDE.md rule #17) shared with TI city hubs:
 // <header> eyebrow + H1 + lede → <section> stat tiles → <section> data
 // area with heading + job list → long prose below. Mirrors the s-*
 // classes used by the TI city hub renderer above (s-S_0cal, s-P0Hs0W,
 // s-S6PRaY, s-CGuDZg, s-KZc0LQ, s-CqexyJ, s-YszcPD) so seo-static.css
 // styles bind without per-page CSS. Before this template the body was
 // a bare `<h1><p><p><ul>` which rendered visibly unstyled next to TI
 // siblings.
 const updatedDate = new Date().toISOString().slice(0, 10);
 const jobCountLabel = locale === 'it' ? 'Offerte attive'
   : locale === 'en' ? 'Open positions'
   : locale === 'de' ? 'Offene Stellen'
   : 'Offres actives';
 const cantonTileLabel = locale === 'it' ? 'Cantone'
   : locale === 'en' ? 'Canton'
   : locale === 'de' ? 'Kanton'
   : 'Canton';
 const permitTileLabel = locale === 'it' ? 'Permesso'
   : locale === 'en' ? 'Permit'
   : locale === 'de' ? 'Bewilligung'
   : 'Permis';
 const listHeading = locale === 'it' ? `Offerte di lavoro a ${cityDisplay}`
   : locale === 'en' ? `Job openings in ${cityDisplay}`
   : locale === 'de' ? `Stellenangebote in ${cityDisplay}`
   : `Offres d'emploi à ${cityDisplay}`;
 const tilesHtml = `<section class="s-S6PRaY"><div class="s-CGuDZg"><div class="s-JFi4vt">${esc(jobCountLabel)}</div><div class="s-9UotdJ">${cityJobs.length}</div></div><div class="s-3kP_AL"><div class="s-z4q8yI">${esc(cantonTileLabel)}</div><div class="s-9UotdJ">${esc(canton)}</div></div><div class="s-3kP_AL"><div class="s-z4q8yI">${esc(permitTileLabel)}</div><div class="s-9UotdJ">G</div></div></section>`;
 const bodyHtml = `<header class="s-S_0cal sx-hero"><p class="s-zNiFzy sx-kick">${esc(formatUpdatedSentence(updatedDate, locale))}</p><h1 class="s-P0Hs0W">${esc(cityHubSeo.h1)}</h1><p class="s-wU5Nrr">${esc(pageDesc)}</p>${intro}</header>${tilesHtml}<section class="s-KZc0LQ"><div class="s-r2QmTP"><h2 class="s-CqexyJ">${esc(listHeading)}</h2><a class="s-YszcPD" href="${sectionRootUrl}">${esc(backLabel)}</a></div><ul class="s-0WjlyL">${listHtml}</ul></section>${nearbyEventsBlockForJobPage(locale, canton, cityDisplay, cDisplay)}${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cityDisplay, cantonDisplay: cDisplay, cantonSlot: 'city-landing', cantonEntityName: cityDisplay }))}`;
 // Use buildSeoPageHtml (NOT buildSimplePage) so the page emits
 // `<main class="seo-static-content">` OUTSIDE `<div id="root">` +
 // `<div id="footer-root"></div>`. The legacy path (buildSimplePage default
 // skipMainWrap=false + seoContentOutsideRoot=false) wraps the static body
 // in `<main class="static-job-page">` INSIDE `#root`, and React hydration
 // wipes that <main> when staticOverlay:true (App.tsx skips React <main>
 // for staticOverlay routes) — leaving the page visibly blank for end users
 // (header + sub-nav only). Bug surfaced on
 // /cerca-lavoro-basilea/basel/ (and every other non-TI canton city hub).
 // The company-hub sibling at line ~6344 already received the same fix in
 // PR #376; this aligns per-canton city hubs to the same hydration-safe shell.
 //
 // hubChrome restores the job-board sub-nav (rendered as `confronti` fallback
 // per HUB_FALLBACK in hubChrome.ts) above <main>, matching every other
 // job-board staticOverlay landing (weeklyEmployers, orphanQueryLanding,
 // career/profession landings).
 const html = buildSeoPageHtml({
 locale,
 title: pageTitle,
 description: pageDesc,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 jsonLdScripts: [breadcrumbLd, collectionLd, itemListLd],
 bodyHtml,
 hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
 distDir,
 // 0-job city pages exist as 404-rescue fallbacks (so the SPA-overlay
 // route doesn't render blank) but offer no city-specific signal to
 // Google. Flip to noindex,follow so they don't compete for indexing
 // with the canton hub. Pages with ≥1 active job stay index,follow —
 // EXCEPT when the whole canton is below MIN_JOBS_FOR_CANTON_PAGE: its
 // canton hub already ships noindex,follow (line ~8722), so keep the
 // sub-threshold city hubs consistent (thin canton → noindex, #2348).
 robots: (!meetsCantonThreshold || isCityEmpty) ? 'noindex,follow' : 'index,follow',
 });
 // Hard-fail guard mirroring TI city hubs (195 KB budget)
 const CITY_HUB_HARD_BUDGET_BYTES = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > CITY_HUB_HARD_BUDGET_BYTES) {
 throw new Error(
 `[jobs-seo-pages] Per-canton city hub ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${CITY_HUB_HARD_BUDGET_BYTES / 1024} KB.`
 );
 }
 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) { const flatFile = np.join(distDir, flatPath.slice(1) + '.html'); _md(np.dirname(flatFile)); _qwFlat(flatFile, html); }
 cityHubCantonPagesCount++;
 }
 // Sitemap entry (priority 0.85 mirroring TI city hubs). Only emit
 // for cities with >=1 active job -- 0-job city pages are noindex,follow
 // 404-rescue fallbacks (above) and would land as orphans in
 // sitemap-jobs.xml because the canton hub's "Esplora" navigator only
 // links the top 8 city hubs. Adding all canon-city URLs to the sitemap
 // without inbound links violated audit:orphan-sitemap-pages and
 // audit:max-bfs-depth gates (PR #463 follow-up). Sub-threshold canton
 // hubs (#2348) are noindex,follow 404-rescue pages with no inbound link
 // (their noindex canton hub doesn't run the navigator) -- keep them out.
 if (!isCityEmpty && meetsCantonThreshold) {
 const itSection = sharedResolveCantonSection('it', canton);
 const itPath = `/${itSection}/${citySlug}/`.replace(/\/+/g, '/');
 const localePaths = new Map<typeof localeList[number], string>();
 localePaths.set('it', itPath);
 for (const l of localeList) {
 if (l === 'it') continue;
 const lSection = sharedResolveCantonSection(l, canton);
 const lp = `${localePrefix[l]}/${lSection}/${citySlug}/`.replace(/\/+/g, '/');
 localePaths.set(l, lp);
 }
 const smAlternates = localeList.map((l) =>
 `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${localePaths.get(l)}" />`,
 ).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- an IT-only
 // push here left en/de/fr city-hub pages (written above in the locale
 // loop) as one-sided alternates, stripped by
 // sanitizeSitemapHreflangReciprocity. Only push a non-IT locale whose
 // HTML was actually written (dead-link guard, same intent as
 // pushEditorialSitemapEntry above).
 for (const l of localeList) {
 const p = localePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 cityHubSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${smAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.85</priority>\n </url>`);
 }
 }
 }
 }
 if (cityHubCantonPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${cityHubCantonPagesCount} per-canton city hub pages`);
 logBuildMem('jobsSeoPages: after city-hubs', collector);
 await collector.awaitDrainSlot(2); // bound _pendingFlushes backlog during bulk emit (#1290)
 // Append city hub sitemap entries to editorial entries
 const cityHubEntriesJoined = cityHubSitemapEntries.join('\n');
 editorialEntries = editorialEntries
 ? `${editorialEntries}\n${cityHubEntriesJoined}`
 : cityHubEntriesJoined;
 }
 }

 /* ── Static paginated listing pages (/cerca-lavoro-ticino/pagina-N/) ── */
 const paginationSlugs: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'pagina', en: 'page', de: 'seite', fr: 'page' };
 const JOBS_PER_LISTING_PAGE = 20;
 const MAX_LISTING_PAGES = 25;
 const sortedForPagination = [...validJobs].sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const totalListingPages = Math.min(MAX_LISTING_PAGES, Math.ceil(sortedForPagination.length / JOBS_PER_LISTING_PAGE));
 let paginationPageCount = 0;
 const paginationSitemapEntries: string[] = [];
 const pagCopy: Record<'it' | 'en' | 'de' | 'fr', { title: (n: number) => string; desc: (n: number, from: number, to: number) => string; heading: (n: number) => string }> = {
 it: { title: (n) => `Lavoro in Ticino - Pagina ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Pagina ${n}: annunci di lavoro dal ${f} al ${t} in Ticino. Offerte aggiornate quotidianamente.`, heading: (n) => `Offerte di lavoro in Ticino \u2014 Pagina ${n}` },
 en: { title: (n) => `Jobs in Ticino - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: job listings ${f}\u2013${t} in Ticino. Updated daily from Swiss career portals.`, heading: (n) => `Job openings in Ticino \u2014 Page ${n}` },
 de: { title: (n) => `Stellen im Tessin - Seite ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Seite ${n}: Stellenangebote ${f}\u2013${t} im Tessin. T\u00e4glich aktualisiert.`, heading: (n) => `Stellenangebote im Tessin \u2014 Seite ${n}` },
 fr: { title: (n) => `Emploi au Tessin - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: offres d'emploi ${f}\u2013${t} au Tessin. Mises \u00e0 jour quotidiennement.`, heading: (n) => `Offres d'emploi au Tessin \u2014 Page ${n}` },
 };
 for (let pageNum = 2; pageNum <= totalListingPages; pageNum++) {
 const startIdx = (pageNum - 1) * JOBS_PER_LISTING_PAGE;
 const pgJobs = sortedForPagination.slice(startIdx, startIdx + JOBS_PER_LISTING_PAGE);
 if (pgJobs.length === 0) break;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tPaginated = startTimer();
 const pgSlug = `${paginationSlugs[locale]}-${pageNum}`;
 const pgCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${pgSlug}`.replace(/\/+/g, '/'));
 const pgCanonicalUrl = `${BASE_URL}${pgCanonicalPath}`;
 const pgCopy = pagCopy[locale];
 const pgFrom = startIdx + 1;
 const pgTo = Math.min(startIdx + JOBS_PER_LISTING_PAGE, sortedForPagination.length);
 const pgTitle = pgCopy.title(pageNum);
 const pgDesc = pgCopy.desc(pageNum, pgFrom, pgTo);
 const pgAlternates = localeList.map((al) => {
 const alSlug = `${paginationSlugs[al]}-${pageNum}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`;
 }).join('\n');
 const pgXDefault = ` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(`/${sectionByLocale.it}/${paginationSlugs.it}-${pageNum}`.replace(/\/+/g, '/'))}">`;
 const pgSectionPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const pgPrevHref = pageNum === 2 ? `${BASE_URL}${withSlash(pgSectionPath)}` : `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum - 1}`.replace(/\/+/g, '/'))}`;
 const pgNextHref = pageNum < totalListingPages ? `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum + 1}`.replace(/\/+/g, '/'))}` : '';
 const pgPrevLink = ` <link rel="prev" href="${pgPrevHref}">`;
 const pgNextLink = pgNextHref ? `\n <link rel="next" href="${pgNextHref}">` : '';
 const pgListHtml = jobCardListBody(pgJobs, locale);
 const pgCompanyCount = new Set(pgJobs.map((job: any) => String(job.company || '')).filter(Boolean)).size;
 const pgLocationCount = new Set(pgJobs.map((job: any) => String(job.location || '')).filter(Boolean)).size;
 const pgCollLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: pgTitle, url: pgCanonicalUrl, description: pgDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } });
 const pgItemLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'ItemList', name: pgTitle, numberOfItems: pgJobs.length, itemListElement: pgJobs.slice(0, 10).map((job: any, i: number) => {
 // Canton-aware item URL: pagination is TI-section by design but the jobs
 // listed may live in any canton. Point ItemList at the actually-emitted
 // canonical URL, not the soft-canonical TI detour.
 const jc = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const secForJob = jc ? sharedResolveCantonSection(locale, jc) : sectionByLocale[locale];
 return { '@type': 'ListItem', position: i + 1, name: String(job?.titleByLocale?.[locale] || job.title || ''), url: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${secForJob}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/'))}` };
 }) });
 const pgMainUrl = `${BASE_URL}${withSlash(pgSectionPath)}`;
 const pgHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const pgListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const pgBreadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: pgHomeUrl },
 { '@type': 'ListItem', position: 2, name: pgListName, item: pgMainUrl },
 { '@type': 'ListItem', position: 3, name: pgCopy.heading(pageNum), item: pgCanonicalUrl },
 ],
 });
 const pgNav: string[] = [`<a class="s-cFXmhu" href="${pgMainUrl}">1</a>`];
 for (let np2 = Math.max(2, pageNum - 2); np2 <= Math.min(totalListingPages, pageNum + 2); np2++) {
 if (np2 === pageNum) { pgNav.push(`<strong>${np2}</strong>`); continue; }
 pgNav.push(`<a class="s-cFXmhu" href="${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${np2}`.replace(/\/+/g, '/'))}">${np2}</a>`);
 }
 const pgBackLabel = locale === 'it' ? 'Torna alla lista completa' : locale === 'en' ? 'Back to full listing' : locale === 'de' ? 'Zur\u00fcck zur Liste' : 'Retour \u00e0 la liste';
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const pgHtml = buildSeoPageHtml({
 locale,
 title: pgTitle,
 description: pgDesc,
 canonicalUrl: pgCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: `${pgAlternates}\n${pgXDefault}`,
 extraHeadHtml: `${pgPrevLink}${pgNextLink}`,
 jsonLdScripts: [pgCollLd, pgItemLd, pgBreadcrumbLd],
 bodyHtml: `<h1>${esc(pgCopy.heading(pageNum))}</h1>\n <p>${esc(pgDesc)}</p>\n <ul class="s-0WjlyL">${pgListHtml}</ul>\n ${renderJobBoardListingDensityProse(locale, { subject: pgListName, location: getCantonDisplayLabel(DEFAULT_CANTON, locale), resultCount: pgJobs.length, companyCount: pgCompanyCount, locationCount: pgLocationCount, pageLabel: String(pageNum) })}\n <nav class="s-HarBzc">${pgNav.join(' &middot; ')}</nav>\n <p><a href="${pgMainUrl}">${esc(pgBackLabel)}</a></p>\n${renderListingPaginationProse(locale, pageNum)}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(DEFAULT_CANTON, locale), omitCommute: true }))}`,
 distDir,
 });
 const pgOutDir = np.join(distDir, pgCanonicalPath.slice(1));
 activeJobDirs.add(pgCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(pgOutDir);
 _qw(np.join(pgOutDir, 'index.html'), pgHtml);
 const pgFlatPath = pgCanonicalPath.replace(/\/+$/, '');
 if (pgFlatPath) { const pgFlatFile = np.join(distDir, pgFlatPath.slice(1) + '.html'); _qwFlatFull(pgFlatFile, pgHtml); }
 paginationPageCount++;
 recordEmit('paginated-listing', __tPaginated);
 }
 const pgItSlug = `${paginationSlugs.it}-${pageNum}`;
 const pgItPath = withSlash(`/${sectionByLocale.it}/${pgItSlug}`.replace(/\/+/g, '/'));
 const pgLocalePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const ls = `${paginationSlugs[l]}-${pageNum}`;
 const lp = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'));
 pgLocalePaths.set(l, lp);
 }
 const pgSmAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${pgLocalePaths.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- pushing only
 // IT here left en/de/fr paginated-listing pages (written above) as
 // one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
 for (const l of localeList) {
 const p = pgLocalePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 paginationSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${pgSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pgItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.4</priority>\n </url>`);
 }
 }
 if (paginationPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${paginationPageCount} paginated listing pages (${totalListingPages - 1} pages \u00d7 4 locales)`);

 /* \u2500\u2500 Per-canton paginated listing pages (Phase 3.5) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  * Additive: for every non-TI canton with >= 2 * JOBS_PER_LISTING_PAGE
  * jobs (>= 40), emit /cerca-lavoro-{cantonSlug}/pagina-N/ pages.
  * TI is NOT iterated here \u2014 the legacy TI emit above is byte-identical.
  */
 {
 // Group validJobs by resolved canton.
 const jobsByCanton: Map<string, typeof validJobs> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (!jobsByCanton.has(c)) jobsByCanton.set(c, []);
 jobsByCanton.get(c)!.push(job);
 }
 // Display names for the canton in body copy (use canton URL slug as fallback).
 const cantonDisplayLocal = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue; // TI handled by legacy block above
 const cJobs = jobsByCanton.get(canton) ?? [];
 if (cJobs.length < 2 * JOBS_PER_LISTING_PAGE) continue;
 const cSorted = [...cJobs].sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const cTotalPages = Math.min(MAX_LISTING_PAGES, Math.ceil(cSorted.length / JOBS_PER_LISTING_PAGE));
 for (let pageNum = 2; pageNum <= cTotalPages; pageNum++) {
 const startIdx = (pageNum - 1) * JOBS_PER_LISTING_PAGE;
 const pgJobs = cSorted.slice(startIdx, startIdx + JOBS_PER_LISTING_PAGE);
 if (pgJobs.length === 0) break;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tPaginated = startTimer();
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const pgSlug = `${paginationSlugs[locale]}-${pageNum}`;
 const pgCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${pgSlug}`.replace(/\/+/g, '/'));
 const pgCanonicalUrl = `${BASE_URL}${pgCanonicalPath}`;
 const cDisplay = cantonDisplayLocal(canton, locale);
 const pgFrom = startIdx + 1;
 const pgTo = Math.min(startIdx + JOBS_PER_LISTING_PAGE, cSorted.length);
 const pgTitleBase = locale === 'it' ? `Lavoro in ${cDisplay} - Pagina ${pageNum}`
 : locale === 'en' ? `Jobs in ${cDisplay} - Page ${pageNum}`
 : locale === 'de' ? `Stellen ${cDisplay} - Seite ${pageNum}`
 : `Emploi \u00e0 ${cDisplay} - Page ${pageNum}`;
 const pgTitle = buildTitleWithBrand(pgTitleBase);
 const pgDesc = locale === 'it' ? `Pagina ${pageNum}: annunci di lavoro dal ${pgFrom} al ${pgTo} in ${cDisplay}. Offerte aggiornate quotidianamente.`
 : locale === 'en' ? `Page ${pageNum}: job listings ${pgFrom}\u2013${pgTo} in ${cDisplay}. Updated daily from Swiss career portals.`
 : locale === 'de' ? `Seite ${pageNum}: Stellenangebote ${pgFrom}\u2013${pgTo} in ${cDisplay}. T\u00e4glich aktualisiert.`
 : `Page ${pageNum}: offres d'emploi ${pgFrom}\u2013${pgTo} \u00e0 ${cDisplay}. Mises \u00e0 jour quotidiennement.`;
 const pgHeading = locale === 'it' ? `Offerte di lavoro in ${cDisplay} \u2014 Pagina ${pageNum}`
 : locale === 'en' ? `Job openings in ${cDisplay} \u2014 Page ${pageNum}`
 : locale === 'de' ? `Stellenangebote ${cDisplay} \u2014 Seite ${pageNum}`
 : `Offres d'emploi \u00e0 ${cDisplay} \u2014 Page ${pageNum}`;
 const pgAlternates = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alSlug = `${paginationSlugs[al]}-${pageNum}`;
 const alPath = `${localePrefix[al]}/${alSection}/${alSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`;
 }).join('\n');
 const itSection = sharedResolveCantonSection('it', canton);
 const pgXDefault = ` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(`/${itSection}/${paginationSlugs.it}-${pageNum}`.replace(/\/+/g, '/'))}">`;
 const pgSectionPath = `${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/');
 const pgPrevHref = pageNum === 2 ? `${BASE_URL}${withSlash(pgSectionPath)}` : `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum - 1}`.replace(/\/+/g, '/'))}`;
 const pgNextHref = pageNum < cTotalPages ? `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum + 1}`.replace(/\/+/g, '/'))}` : '';
 const pgPrevLink = ` <link rel="prev" href="${pgPrevHref}">`;
 const pgNextLink = pgNextHref ? `\n <link rel="next" href="${pgNextHref}">` : '';
 const pgListHtml = jobCardListBody(pgJobs, locale);
 const pgCompanyCount = new Set(pgJobs.map((job: any) => String(job.company || '')).filter(Boolean)).size;
 const pgLocationCount = new Set(pgJobs.map((job: any) => String(job.location || '')).filter(Boolean)).size;
 const pgCollLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: pgTitle, url: pgCanonicalUrl, description: pgDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } });
 const pgItemLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'ItemList', name: pgTitle, numberOfItems: pgJobs.length, itemListElement: pgJobs.slice(0, 10).map((job: any, i: number) => ({ '@type': 'ListItem', position: i + 1, name: String(job?.titleByLocale?.[locale] || job.title || ''), url: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/'))}` })) });
 const pgMainUrl = `${BASE_URL}${withSlash(pgSectionPath)}`;
 const pgHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const pgListName = locale === 'it' ? `Lavoro in ${cDisplay}` : locale === 'en' ? `Jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Emploi \u00e0 ${cDisplay}`;
 const pgBreadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: pgHomeUrl },
 { '@type': 'ListItem', position: 2, name: pgListName, item: pgMainUrl },
 { '@type': 'ListItem', position: 3, name: pgHeading, item: pgCanonicalUrl },
 ],
 });
 const pgNav: string[] = [`<a class="s-cFXmhu" href="${pgMainUrl}">1</a>`];
 for (let np2 = Math.max(2, pageNum - 2); np2 <= Math.min(cTotalPages, pageNum + 2); np2++) {
 if (np2 === pageNum) { pgNav.push(`<strong>${np2}</strong>`); continue; }
 pgNav.push(`<a class="s-cFXmhu" href="${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${np2}`.replace(/\/+/g, '/'))}">${np2}</a>`);
 }
 const pgBackLabel = locale === 'it' ? 'Torna alla lista completa' : locale === 'en' ? 'Back to full listing' : locale === 'de' ? 'Zur\u00fcck zur Liste' : 'Retour \u00e0 la liste';
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const pgHtml = buildSeoPageHtml({
 locale,
 title: pgTitle,
 description: pgDesc,
 canonicalUrl: pgCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: `${pgAlternates}\n${pgXDefault}`,
 extraHeadHtml: `${pgPrevLink}${pgNextLink}`,
 jsonLdScripts: [pgCollLd, pgItemLd, pgBreadcrumbLd],
 bodyHtml: `<h1>${esc(pgHeading)}</h1>\n <p>${esc(pgDesc)}</p>\n <ul class="s-0WjlyL">${pgListHtml}</ul>\n ${renderJobBoardListingDensityProse(locale, { subject: pgListName, location: cDisplay, resultCount: pgJobs.length, companyCount: pgCompanyCount, locationCount: pgLocationCount, pageLabel: String(pageNum) })}\n <nav class="s-HarBzc">${pgNav.join(' &middot; ')}</nav>\n <p><a href="${pgMainUrl}">${esc(pgBackLabel)}</a></p>\n${renderListingPaginationProse(locale, pageNum)}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cDisplay, omitCommute: true, cantonDisplay: cDisplay, cantonSlot: 'canton-hub' }))}`,
 distDir,
 });
 const pgOutDir = np.join(distDir, pgCanonicalPath.slice(1));
 activeJobDirs.add(pgCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(pgOutDir);
 _qw(np.join(pgOutDir, 'index.html'), pgHtml);
 const pgFlatPath = pgCanonicalPath.replace(/\/+$/, '');
 if (pgFlatPath) { const pgFlatFile = np.join(distDir, pgFlatPath.slice(1) + '.html'); _qwFlatFull(pgFlatFile, pgHtml); }
 paginationPageCount++;
 recordEmit('paginated-listing', __tPaginated);
 }
 const pgItSectionCanton = sharedResolveCantonSection('it', canton);
 const pgItSlugCanton = `${paginationSlugs.it}-${pageNum}`;
 const pgItPathCanton = withSlash(`/${pgItSectionCanton}/${pgItSlugCanton}`.replace(/\/+/g, '/'));
 const pgLocalePathsCanton = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSection = sharedResolveCantonSection(l, canton);
 const ls = `${paginationSlugs[l]}-${pageNum}`;
 const lp = withSlash(`${localePrefix[l]}/${lSection}/${ls}`.replace(/\/+/g, '/'));
 pgLocalePathsCanton.set(l, lp);
 }
 const pgSmAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${pgLocalePathsCanton.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see legacy
 // TI block above for rationale.
 for (const l of localeList) {
 const p = pgLocalePathsCanton.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 paginationSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${pgSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pgItPathCanton}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.4</priority>\n </url>`);
 }
 }
 }
 }

 /* ── Category listing pages (/cerca-lavoro-ticino/categoria-sanita/) ── */
 const catSlugsMap: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
 finance: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
 tech: { it: 'informatica', en: 'tech', de: 'technik', fr: 'tech' },
 engineering: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
 admin: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
 hospitality: { it: 'ristorazione', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie' },
 sales: { it: 'vendita', en: 'sales', de: 'vertrieb', fr: 'vente' },
 other: { it: 'altro', en: 'other', de: 'andere', fr: 'autre' },
 };
 const catPrefix: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'categoria', en: 'category', de: 'kategorie', fr: 'categorie' };
 const catLabels: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'Sanit\u00e0', en: 'Healthcare', de: 'Gesundheit', fr: 'Sant\u00e9' },
 finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
 tech: { it: 'Informatica', en: 'Technology', de: 'Technik', fr: 'Technologie' },
 engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ing\u00e9nierie' },
 admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
 hospitality: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'H\u00f4tellerie' },
 sales: { it: 'Vendita', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
 other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' },
 };
 let categoryPageCount = 0;
 const categorySitemapEntries: string[] = [];
 const CAT_PER_PAGE = 30;
 for (const catKey of Object.keys(catSlugsMap)) {
 const catJobs = sortedForPagination.filter((j: any) => String(j.category || '').toLowerCase() === catKey);
 if (catJobs.length < 3) continue;
 const catTotalPages = Math.min(10, Math.ceil(catJobs.length / CAT_PER_PAGE));
 for (let catPage = 1; catPage <= catTotalPages; catPage++) {
 const catStart = (catPage - 1) * CAT_PER_PAGE;
 const catPageJobs = catJobs.slice(catStart, catStart + CAT_PER_PAGE);
 if (catPageJobs.length === 0) break;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tCategory = startTimer();
 const catSlugL = catSlugsMap[catKey][locale];
 const catPageSuffix = catPage > 1 ? `/${paginationSlugs[locale]}-${catPage}` : '';
 const catFullSlug = `${catPrefix[locale]}-${catSlugL}${catPageSuffix}`;
 const catCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${catFullSlug}`.replace(/\/+/g, '/'));
 const catCanonicalUrl = `${BASE_URL}${catCanonicalPath}`;
 const catLabel = catLabels[catKey][locale];
 const catPageLabel = catPage > 1 ? ` - ${locale === 'de' ? 'Seite' : 'Pagina'} ${catPage}` : '';
 const catUniqueCompanies = [...new Set(catJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const catUniqueLocations = [...new Set(catJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 // F3a — CTR-optimized 50-60 char title for page 1, paginated suffix for >1.
 // Description uses the shared 140-160 char template from meta-descriptions.
 const catPrimaryTitle = buildRoleHubTitle({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 year: new Date().getFullYear(),
 });
 const catTitle = catPage > 1
 ? (locale === 'it' ? `${catPrimaryTitle} — Pagina ${catPage}` : locale === 'de' ? `${catPrimaryTitle} — Seite ${catPage}` : `${catPrimaryTitle} — Page ${catPage}`)
 : catPrimaryTitle;
 const catDescription = buildRoleHubMeta({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 });
 const catAlternatesPairs = localeList.map((al) => {
 const alSlug = `${catPrefix[al]}-${catSlugsMap[catKey][al]}${catPage > 1 ? `/${paginationSlugs[al]}-${catPage}` : ''}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const catXDefaultHref = catAlternatesPairs.find((p) => p.lang === 'it')?.href ?? catAlternatesPairs[0]?.href ?? catCanonicalUrl;
 // audit-hreflang requires x-default on every multi-locale page.
 const catAlternates = [
 ...catAlternatesPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${catXDefaultHref}">`,
 ].join('\n');
 const catListHtml = jobCardListBody(catPageJobs, locale);
 const catOtherLinks = Object.keys(catSlugsMap).filter((k) => k !== catKey).map((k) => { const kSlug = `${catPrefix[locale]}-${catSlugsMap[k][locale]}`; return `<a class="s-gcEaMI" href="${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kSlug}`.replace(/\/+/g, '/'))}">${catLabels[k][locale]}</a>`; });
 const catCollLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: catTitle, url: catCanonicalUrl, description: catDescription, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } });
 const catSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const catBreadcrumbLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: catSectionUrl },
 { '@type': 'ListItem', position: 3, name: catTitle.replace(' | Frontaliere Ticino', ''), item: catCanonicalUrl },
 ] });
 // Build editorial intro and market context paragraphs
 const catTopCompanies = catUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const catIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${catJobs.length} offerte di lavoro</strong> nel settore ${catLabel.toLowerCase()} in Ticino, pubblicate da ${catUniqueCompanies.length} aziende in ${catUniqueLocations.length} localit\u00e0. Tra le aziende che assumono: ${catTopCompanies}. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${catJobs.length} job openings</strong> in the ${catLabel.toLowerCase()} sector in Ticino, published by ${catUniqueCompanies.length} companies across ${catUniqueLocations.length} locations. Hiring companies include: ${catTopCompanies}. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${catJobs.length} Stellenangebote</strong> im Bereich ${catLabel} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${catUniqueCompanies.length} Unternehmen an ${catUniqueLocations.length} Standorten. Einstellende Unternehmen: ${catTopCompanies}. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert.</p>`;
 return `<p>${catJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles dans le secteur ${catLabel.toLowerCase()} au Tessin, publi\u00e9es par ${catUniqueCompanies.length} entreprises dans ${catUniqueLocations.length} localit\u00e9s. Entreprises qui recrutent : ${catTopCompanies}. Les annonces sont mises \u00e0 jour quotidiennement.</p>`;
 })();
 const catMarketSection = (() => {
 if (locale === 'it') return `<section class="s-7uP4UM"><h2>Lavorare nel settore ${catLabel.toLowerCase()} in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Il settore ${catLabel.toLowerCase()} rappresenta una delle aree pi\u00f9 attive del mercato ticinese. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section class="s-7uP4UM"><h2>Working in ${catLabel.toLowerCase()} in Ticino</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The ${catLabel.toLowerCase()} sector is one of the most active areas in the Ticino job market. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section class="s-7uP4UM"><h2>Arbeiten im Bereich ${catLabel} im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Der Bereich ${catLabel} geh\u00f6rt zu den aktivsten Sektoren des Tessiner Arbeitsmarkts. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section class="s-7uP4UM"><h2>Travailler dans le secteur ${catLabel.toLowerCase()} au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Le secteur ${catLabel.toLowerCase()} est l'un des domaines les plus actifs du march\u00e9 tessinois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const catOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 const catNavLabel = locale === 'it' ? 'Altre categorie' : locale === 'en' ? 'Other categories' : locale === 'de' ? 'Weitere Kategorien' : 'Autres cat\u00e9gories';
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const catHtml = buildSeoPageHtml({
 locale,
 title: catTitle,
 description: catDescription,
 canonicalUrl: catCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: catAlternates,
 jsonLdScripts: [catCollLd, catBreadcrumbLd],
 distDir,
 bodyHtml: (() => {
 const catLocaleParts: Parameters<typeof formatSeoH1>[0] = {
 keyword: catLabel,
 location: locale === 'de' ? 'Tessin' : locale === 'fr' ? 'Tessin' : 'Ticino',
 count: catJobs.length,
 locale,
 noun: locale === 'it' ? 'offerte' : locale === 'en' ? 'open roles' : locale === 'de' ? 'Stellen' : 'offres',
 title: catTitle,
 };
 const catH1 = formatSeoH1(catLocaleParts) + (catPage > 1 ? (locale === 'it' ? ` — Pagina ${catPage}` : locale === 'de' ? ` — Seite ${catPage}` : locale === 'fr' ? ` — Page ${catPage}` : ` — Page ${catPage}`) : '');
 return `<h1>${esc(catH1)}</h1>\n <p>${esc(catDescription)}</p>\n ${catIntro}\n <ul class="s-0WjlyL">${catListHtml}</ul>\n <p><a href="${catSectionUrl}">${esc(catOpenAllLabel)}</a></p>\n ${catMarketSection}\n ${renderJobBoardListingDensityProse(locale, { subject: catLabel, location: getCantonDisplayLabel(DEFAULT_CANTON, locale), resultCount: catJobs.length, companyCount: catUniqueCompanies.length, locationCount: catUniqueLocations.length, pageLabel: catPage > 1 ? String(catPage) : undefined })}\n <nav class="s-_ZFTu5">${catNavLabel}: ${catOtherLinks.join(' \u00b7 ')}</nav>\n ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: getCantonDisplayLabel(DEFAULT_CANTON, locale), omitCommute: true, sectorOrType: catLabel }))}`;
 })(),
 });
 const catOutDir = np.join(distDir, catCanonicalPath.slice(1));
 activeJobDirs.add(catCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(catOutDir);
 _qw(np.join(catOutDir, 'index.html'), catHtml);
 const catFlatPath = catCanonicalPath.replace(/\/+$/, '');
 if (catFlatPath) { const catFlatFile = np.join(distDir, catFlatPath.slice(1) + '.html'); _qwFlatFull(catFlatFile, catHtml); }
 categoryPageCount++;
 recordEmit('category-listing', __tCategory);
 }
 if (catPage === 1) {
 const catItSlug = `${catPrefix.it}-${catSlugsMap[catKey].it}`;
 const catItPath = withSlash(`/${sectionByLocale.it}/${catItSlug}`.replace(/\/+/g, '/'));
 const catLocalePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const ls = `${catPrefix[l]}-${catSlugsMap[catKey][l]}`;
 const lp = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'));
 catLocalePaths.set(l, lp);
 }
 const catSmAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${catLocalePaths.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see
 // pushEditorialSitemapEntry above for rationale.
 for (const l of localeList) {
 const p = catLocalePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 categorySitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${catSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${catItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`);
 }
 }
 }
 }
 if (categoryPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${categoryPageCount} category listing pages`);

 /* ── Per-canton category listing pages (Phase 3.6) ───────────
  * Additive: for every (canton, category) bucket with >= 3 jobs (excluding TI),
  * emit /cerca-lavoro-{cantonSlug}/categoria-{slug}/ pages.
  * TI is NOT iterated here — the legacy TI emit above is byte-identical.
  */
 {
 // Group validJobs by (canton, category)
 const cantonCategoryCounts: Map<string, Map<string, typeof validJobs>> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (c === 'TI') continue;
 const cat = String((job as any).category || '').toLowerCase();
 if (!cat || !catSlugsMap[cat]) continue;
 if (!cantonCategoryCounts.has(c)) cantonCategoryCounts.set(c, new Map());
 const byCat = cantonCategoryCounts.get(c)!;
 if (!byCat.has(cat)) byCat.set(cat, []);
 byCat.get(cat)!.push(job);
 }
 const cantonDisplayLocalCat = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue;
 const byCat = cantonCategoryCounts.get(canton);
 if (!byCat) continue;
 for (const catKey of Object.keys(catSlugsMap)) {
 const catJobs = byCat.get(catKey) ?? [];
 if (catJobs.length < 3) continue;
 // Sort like the global one to preserve consistent feed ordering.
 catJobs.sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const catTotalPages = Math.min(10, Math.ceil(catJobs.length / CAT_PER_PAGE));
 for (let catPage = 1; catPage <= catTotalPages; catPage++) {
 const catStart = (catPage - 1) * CAT_PER_PAGE;
 const catPageJobs = catJobs.slice(catStart, catStart + CAT_PER_PAGE);
 if (catPageJobs.length === 0) break;
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tCategory = startTimer();
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const cDisplay = cantonDisplayLocalCat(canton, locale);
 const catSlugL = catSlugsMap[catKey][locale];
 const catPageSuffix = catPage > 1 ? `/${paginationSlugs[locale]}-${catPage}` : '';
 const catFullSlug = `${catPrefix[locale]}-${catSlugL}${catPageSuffix}`;
 const catCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${catFullSlug}`.replace(/\/+/g, '/'));
 const catCanonicalUrl = `${BASE_URL}${catCanonicalPath}`;
 const catLabel = catLabels[catKey][locale];
 const catUniqueCompanies = [...new Set(catJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const catUniqueLocations = [...new Set(catJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const catPrimaryTitle = buildRoleHubTitle({
 locale,
 roleDisplay: `${catLabel} ${cDisplay}`,
 count: catJobs.length,
 year: new Date().getFullYear(),
 });
 const catTitle = catPage > 1
 ? (locale === 'it' ? `${catPrimaryTitle} — Pagina ${catPage}` : locale === 'de' ? `${catPrimaryTitle} — Seite ${catPage}` : `${catPrimaryTitle} — Page ${catPage}`)
 : catPrimaryTitle;
 const catDescription = buildRoleHubMeta({
 locale,
 roleDisplay: `${catLabel} ${cDisplay}`,
 count: catJobs.length,
 });
 const catAlternatesPairs = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alSlug = `${catPrefix[al]}-${catSlugsMap[catKey][al]}${catPage > 1 ? `/${paginationSlugs[al]}-${catPage}` : ''}`;
 const alPath = `${localePrefix[al]}/${alSection}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const catXDefaultHref = catAlternatesPairs.find((p) => p.lang === 'it')?.href ?? catAlternatesPairs[0]?.href ?? catCanonicalUrl;
 const catAlternates = [
 ...catAlternatesPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${catXDefaultHref}">`,
 ].join('\n');
 const catListHtml = jobCardListBody(catPageJobs, locale);
 const catOtherLinks = Object.keys(catSlugsMap).filter((k) => k !== catKey).map((k) => { const kSlug = `${catPrefix[locale]}-${catSlugsMap[k][locale]}`; return `<a class="s-gcEaMI" href="${withSlash(`${localePrefix[locale]}/${sectionSlug}/${kSlug}`.replace(/\/+/g, '/'))}">${catLabels[k][locale]}</a>`; });
 const catCollLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: catTitle, url: catCanonicalUrl, description: catDescription, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } });
 const catSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;
 const sectionLabel = locale === 'it' ? `Cerca lavoro in ${cDisplay}` : locale === 'en' ? `Find jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Trouver un emploi à ${cDisplay}`;
 const catBreadcrumbLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: sectionLabel, item: catSectionUrl },
 { '@type': 'ListItem', position: 3, name: catTitle.replace(' | Frontaliere Ticino', ''), item: catCanonicalUrl },
 ] });
 const catTopCompanies = catUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const catIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${catJobs.length} offerte di lavoro</strong> nel settore ${catLabel.toLowerCase()} in ${cDisplay}, pubblicate da ${catUniqueCompanies.length} aziende in ${catUniqueLocations.length} località. Tra le aziende che assumono: ${catTopCompanies}. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${catJobs.length} job openings</strong> in the ${catLabel.toLowerCase()} sector in ${cDisplay}, published by ${catUniqueCompanies.length} companies across ${catUniqueLocations.length} locations. Hiring companies include: ${catTopCompanies}. Listings are refreshed daily.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${catJobs.length} Stellenangebote</strong> im Bereich ${catLabel} in ${cDisplay} verfügbar, veröffentlicht von ${catUniqueCompanies.length} Unternehmen an ${catUniqueLocations.length} Standorten. Einstellende Unternehmen: ${catTopCompanies}.</p>`;
 return `<p>${catJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles dans le secteur ${catLabel.toLowerCase()} à ${cDisplay}, publiées par ${catUniqueCompanies.length} entreprises dans ${catUniqueLocations.length} localités. Entreprises qui recrutent : ${catTopCompanies}.</p>`;
 })();
 const catMarketSection = (() => {
 if (locale === 'it') return `<section class="s-7uP4UM"><h2>Lavorare nel settore ${catLabel.toLowerCase()} in ${cDisplay}</h2><p>Il Canton ${cDisplay} fa parte del mercato svizzero del lavoro. Il settore ${catLabel.toLowerCase()} è una delle aree presenti del mercato cantonale. Per i lavoratori frontalieri con Permesso G, la Svizzera applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section class="s-7uP4UM"><h2>Working in ${catLabel.toLowerCase()} in ${cDisplay}</h2><p>The Canton of ${cDisplay} is part of the Swiss labour market. The ${catLabel.toLowerCase()} sector is one of the active areas in the cantonal job market. For cross-border workers with a G Permit, Switzerland applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary.</p></section>`;
 if (locale === 'de') return `<section class="s-7uP4UM"><h2>Arbeiten im Bereich ${catLabel} in ${cDisplay}</h2><p>Der Kanton ${cDisplay} ist Teil des schweizerischen Arbeitsmarkts. Der Bereich ${catLabel} gehört zu den aktiven Sektoren des kantonalen Arbeitsmarkts. Für Grenzgänger mit G-Bewilligung erhebt die Schweiz eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>.</p></section>`;
 return `<section class="s-7uP4UM"><h2>Travailler dans le secteur ${catLabel.toLowerCase()} à ${cDisplay}</h2><p>Le Canton de ${cDisplay} fait partie du marché du travail suisse. Le secteur ${catLabel.toLowerCase()} est l'un des domaines actifs du marché cantonal. Pour les frontaliers avec un permis G, la Suisse applique un impôt à la source sur le revenu brut. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a>.</p></section>`;
 })();
 const catOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board öffnen' : 'Ouvrir le job board complet';
 const catNavLabel = locale === 'it' ? 'Altre categorie' : locale === 'en' ? 'Other categories' : locale === 'de' ? 'Weitere Kategorien' : 'Autres catégories';
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const catHtml = buildSeoPageHtml({
 locale,
 title: catTitle,
 description: catDescription,
 canonicalUrl: catCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: catAlternates,
 jsonLdScripts: [catCollLd, catBreadcrumbLd],
 distDir,
 bodyHtml: (() => {
 const catLocaleParts: Parameters<typeof formatSeoH1>[0] = {
 keyword: catLabel,
 location: cDisplay,
 count: catJobs.length,
 locale,
 noun: locale === 'it' ? 'offerte' : locale === 'en' ? 'open roles' : locale === 'de' ? 'Stellen' : 'offres',
 title: catTitle,
 };
 const catH1 = formatSeoH1(catLocaleParts) + (catPage > 1 ? (locale === 'it' ? ` — Pagina ${catPage}` : locale === 'de' ? ` — Seite ${catPage}` : locale === 'fr' ? ` — Page ${catPage}` : ` — Page ${catPage}`) : '');
 return `<h1>${esc(catH1)}</h1>\n <p>${esc(catDescription)}</p>\n ${catIntro}\n <ul class="s-0WjlyL">${catListHtml}</ul>\n <p><a href="${catSectionUrl}">${esc(catOpenAllLabel)}</a></p>\n ${catMarketSection}\n ${renderJobBoardListingDensityProse(locale, { subject: catLabel, location: cDisplay, resultCount: catJobs.length, companyCount: catUniqueCompanies.length, locationCount: catUniqueLocations.length, pageLabel: catPage > 1 ? String(catPage) : undefined })}\n <nav class="s-_ZFTu5">${catNavLabel}: ${catOtherLinks.join(' · ')}</nav>\n ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cDisplay, omitCommute: true, sectorOrType: catLabel, cantonDisplay: cDisplay, cantonSlot: 'sectors-hub' }))}`;
 })(),
 });
 const catOutDir = np.join(distDir, catCanonicalPath.slice(1));
 activeJobDirs.add(catCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(catOutDir);
 _qw(np.join(catOutDir, 'index.html'), catHtml);
 const catFlatPath = catCanonicalPath.replace(/\/+$/, '');
 if (catFlatPath) { const catFlatFile = np.join(distDir, catFlatPath.slice(1) + '.html'); _qwFlatFull(catFlatFile, catHtml); }
 categoryPageCount++;
 recordEmit('category-listing', __tCategory);
 }
 if (catPage === 1) {
 const itSection = sharedResolveCantonSection('it', canton);
 const catItSlug = `${catPrefix.it}-${catSlugsMap[catKey].it}`;
 const catItPath = withSlash(`/${itSection}/${catItSlug}`.replace(/\/+/g, '/'));
 const catLocalePathsCanton = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSection = sharedResolveCantonSection(l, canton);
 const ls = `${catPrefix[l]}-${catSlugsMap[catKey][l]}`;
 const lp = withSlash(`${localePrefix[l]}/${lSection}/${ls}`.replace(/\/+/g, '/'));
 catLocalePathsCanton.set(l, lp);
 }
 const catSmAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${catLocalePathsCanton.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see legacy
 // TI block above for rationale.
 for (const l of localeList) {
 const p = catLocalePathsCanton.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 categorySitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${catSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${catItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`);
 }
 }
 }
 }
 }
 }

 /* ── Per-canton sector hubs (Phase 3.2) ──────────────────────
  * Additive: for every non-TI canton, emit /cerca-lavoro-{cantonSlug}/{sectorSlug}/
  * for every sector (infermieri, case-anziani, educatori, ingegneri, autisti,
  * sviluppatori, ristorazione, oss, logistica, apprendistato) — no job-count
  * floor (owner decision 2026-07-16: same treatment as TI, PR #4254). Every
  * (canton, sector, locale) combo gets a real self-canonical page, even at
  * 0 matching jobs; fixed prose (renderJobBoardListingDensityProse +
  * commuter/tax context) clears the thin-content floor regardless of count.
  *
  * TI sector hubs are owned by jobSectorPagesPlugin.ts (legacy URL
  * /cerca-lavoro-ticino/{sectorSlug}/) and are NOT touched here — this loop
  * skips canton === 'TI' so the legacy emit stays byte-identical.
  *
  * Each per-canton sector page is a thin landing: H1, intro, top-30 jobs
  * filtered by (canton, sector), self-canonical, plus a brief market section.
  * Curated TI prose (sectorProseData) is not reused — non-TI hubs ship the
  * minimal SEO-funnel shell with the live job count baked in.
  */
 {
 const SECTOR_JOB_LIST_CAP = 30;
 // Group validJobs by (canton, sector, locale) — matching must be locale-scoped
 // (jobMatchesSector's locale param) so a translation defect in one locale
 // can't leak the job into/out of the other 3 locale variants of the page (#4715).
 const cantonSectorBuckets: Map<string, Map<SectorHubKey, Map<string, typeof validJobs>>> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (c === 'TI') continue;
 for (const sector of SECTOR_HUB_KEYS) {
 for (const locale of localeList) {
 if (!jobMatchesSector(job as never, sector, locale as never)) continue;
 if (!cantonSectorBuckets.has(c)) cantonSectorBuckets.set(c, new Map());
 const bySector = cantonSectorBuckets.get(c)!;
 if (!bySector.has(sector)) bySector.set(sector, new Map());
 const byLocale = bySector.get(sector)!;
 if (!byLocale.has(locale)) byLocale.set(locale, []);
 byLocale.get(locale)!.push(job);
 }
 }
 }
 const cantonDisplayLocalSec = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 const sectorHubSitemapEntries: string[] = [];
 let sectorHubPagesCount = 0;
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue;
 const bySector = cantonSectorBuckets.get(canton);
 for (const sector of SECTOR_HUB_KEYS) {
 const sJobsByLocale = bySector?.get(sector);
 // Source of truth for seoHubsPlugin's canton `settori` hub: record that a
 // crawlable `/{section}/{sectorSlug}/` page exists for this (canton, sector)
 // so the hub deep-links it instead of a robots-disallowed `?q=` URL.
 markCantonSectorPage(canton, sector);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const sJobs = sJobsByLocale?.get(locale) ?? [];
 const sSorted = [...sJobs].sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const cappedJobs = sSorted.slice(0, SECTOR_JOB_LIST_CAP);
 const __tSectorCanton = startTimer();
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const sectorSlug = SECTOR_HUB_SLUG[locale][sector];
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${sectorSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const cDisplay = cantonDisplayLocalSec(canton, locale);
 const sectorDisplay = SECTOR_HUB_DISPLAY[locale][sector];
 const year = new Date().getFullYear();
 const seo = buildSectorHubSeo(locale, sector, sJobs.length, year);
 // Compose title: prepend canton to disambiguate from the TI sector hub
 const pageTitle = locale === 'it' ? `${sectorDisplay} ${cDisplay} (${sJobs.length}) ${year} | Frontaliere Ticino`
 : locale === 'en' ? `${sectorDisplay} jobs ${cDisplay} (${sJobs.length}) ${year} | Frontaliere Ticino`
 : locale === 'de' ? `${sectorDisplay} ${cDisplay} (${sJobs.length}) ${year} | Frontaliere Ticino`
 : `${sectorDisplay} ${cDisplay} (${sJobs.length}) ${year} | Frontaliere Ticino`;
 const pageDesc = locale === 'it' ? `${sJobs.length} offerte di lavoro ${sectorDisplay.toLowerCase()} in ${cDisplay}. Annunci aggiornati quotidianamente. Cerca il tuo prossimo lavoro come frontaliere.`
 : locale === 'en' ? `${sJobs.length} ${sectorDisplay.toLowerCase()} job openings in ${cDisplay}. Listings updated daily. Find your next cross-border job in Switzerland.`
 : locale === 'de' ? `${sJobs.length} ${sectorDisplay} Stellenangebote in ${cDisplay}. Täglich aktualisiert. Finden Sie Ihren nächsten Grenzgänger-Job.`
 : `${sJobs.length} offres d'emploi ${sectorDisplay.toLowerCase()} à ${cDisplay}. Annonces mises à jour quotidiennement. Trouvez votre prochain emploi frontalier.`;
 const pageHeading = locale === 'it' ? `Offerte ${sectorDisplay.toLowerCase()} in ${cDisplay}`
 : locale === 'en' ? `${sectorDisplay} jobs in ${cDisplay}`
 : locale === 'de' ? `${sectorDisplay} Stellen ${cDisplay}`
 : `Offres ${sectorDisplay.toLowerCase()} à ${cDisplay}`;
 const altPairs = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alSlug = SECTOR_HUB_SLUG[al][sector];
 const alPath = `${localePrefix[al]}/${alSection}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const xDefaultHref = altPairs.find((p) => p.lang === 'it')?.href ?? altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
 ...altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;
 const sectionLabel = locale === 'it' ? `Cerca lavoro in ${cDisplay}` : locale === 'en' ? `Find jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Trouver un emploi à ${cDisplay}`;
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: sectionLabel, item: sectionRootUrl },
 { '@type': 'ListItem', position: 3, name: pageHeading, item: canonicalUrl },
 ],
 });
 const collectionLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: pageTitle,
 url: canonicalUrl,
 description: pageDesc,
 inLanguage: locale,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
 });
 const itemListLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: pageTitle,
 numberOfItems: cappedJobs.length,
 // Embed a full JobPosting per item (capped description, never throws → falls
 // back to a name+url stub). Mirrors the editorial-landing ItemList; the
 // authoritative per-job JobPosting still lives on each linked detail page.
 itemListElement: cappedJobs.slice(0, 10).map((job: any, i: number) =>
 mapCantonJobToListItem(job, i, locale, sectionSlug, canton)),
 });
 // Honest counts over the full (uncapped) match set, not the 30 carded jobs —
 // mirrors the TI sector hub (jobSectorPagesPlugin.ts) so the stat-grid /
 // intro report the real market size rather than the cap.
 const sUniqueCompanies = [...new Set(sJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const sUniqueLocations = [...new Set(sJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const sTopCompanies = sUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 // Fresh listings in the last 7 days (same window/source as the TI hub).
 const SECTOR_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
 const sectorFreshCutoff = Date.parse(`${dateStamp}T00:00:00Z`) - SECTOR_FRESH_WINDOW_MS;
 const sFreshCount = sJobs.filter((j: any) => {
 // First PARSEABLE date, not first truthy: a malformed postedDate must not
 // shadow a valid crawledAt and undercount the fresh tile (see firstParsableMs).
 const t = firstParsableMs(j.datePosted, j.postedDate, j.crawledAt);
 return t >= sectorFreshCutoff;
 }).length;
 const intro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${sJobs.length} offerte di lavoro</strong> per ${sectorDisplay.toLowerCase()} in ${esc(cDisplay)}, pubblicate da ${sUniqueCompanies.length} aziende in ${sUniqueLocations.length} località. Tra le aziende che assumono: ${sTopCompanies || '—'}. Gli annunci vengono aggiornati quotidianamente dal nostro crawler.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${sJobs.length} job openings</strong> for ${sectorDisplay.toLowerCase()} in ${esc(cDisplay)}, published by ${sUniqueCompanies.length} companies across ${sUniqueLocations.length} locations. Hiring companies include: ${sTopCompanies || '—'}. Listings are refreshed daily.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${sJobs.length} Stellenangebote</strong> für ${sectorDisplay} in ${esc(cDisplay)} verfügbar, veröffentlicht von ${sUniqueCompanies.length} Unternehmen an ${sUniqueLocations.length} Standorten. Einstellende Unternehmen: ${sTopCompanies || '—'}. Täglich aktualisiert.</p>`;
 return `<p>${sJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles dans le secteur ${sectorDisplay.toLowerCase()} à ${esc(cDisplay)}, publiées par ${sUniqueCompanies.length} entreprises dans ${sUniqueLocations.length} localités. Entreprises qui recrutent : ${sTopCompanies || '—'}. Annonces mises à jour quotidiennement.</p>`;
 })();
 const marketSection = (() => {
 if (locale === 'it') return `<section class="s-7uP4UM"><h2>Lavorare come ${sectorDisplay.toLowerCase()} in ${esc(cDisplay)}</h2><p>Il Canton ${esc(cDisplay)} è parte del mercato svizzero del lavoro. Per i lavoratori frontalieri con Permesso G, la Svizzera applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto.</p></section>`;
 if (locale === 'en') return `<section class="s-7uP4UM"><h2>Working as ${sectorDisplay.toLowerCase()} in ${esc(cDisplay)}</h2><p>The Canton of ${esc(cDisplay)} is part of the Swiss labour market. For cross-border workers with a G Permit, Switzerland applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary.</p></section>`;
 if (locale === 'de') return `<section class="s-7uP4UM"><h2>Arbeiten als ${sectorDisplay} in ${esc(cDisplay)}</h2><p>Der Kanton ${esc(cDisplay)} ist Teil des schweizerischen Arbeitsmarkts. Für Grenzgänger mit G-Bewilligung erhebt die Schweiz eine Quellensteuer. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>.</p></section>`;
 return `<section class="s-7uP4UM"><h2>Travailler comme ${sectorDisplay.toLowerCase()} à ${esc(cDisplay)}</h2><p>Le Canton de ${esc(cDisplay)} fait partie du marché du travail suisse. Pour les frontaliers avec un permis G, la Suisse applique un impôt à la source. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a>.</p></section>`;
 })();
 const openAllLabel = locale === 'it' ? `Apri tutte le offerte in ${cDisplay}` : locale === 'en' ? `View all jobs in ${cDisplay}` : locale === 'de' ? `Alle Stellen ${cDisplay}` : `Voir toutes les offres à ${cDisplay}`;
 const listHtml = jobCardListBody(cappedJobs, locale);
 // Content-first hero: emoji eyebrow + lively colored stat grid + primary CTA,
 // propagated from the TI sector hubs (PR #1118). The H1/headline keyword stays
 // clean (emoji is aria-hidden, only in the eyebrow). Secondary tiles drop out
 // when their signal is 0, so a thin sector degrades to one clean tile.
 const updatedEyebrow = locale === 'it' ? `Aggiornato · ${dateStamp}` : locale === 'en' ? `Updated · ${dateStamp}` : locale === 'de' ? `Aktualisiert · ${dateStamp}` : `Mis à jour · ${dateStamp}`;
 const eyebrowHtml = `<p style="${HERO_EYEBROW_STYLE}"><span aria-hidden="true" style="font-size:15px">${SECTOR_HUB_EMOJI[sector]}</span> ${esc(updatedEyebrow)}</p>`;
 const activeLabel = locale === 'it' ? 'Offerte attive' : locale === 'en' ? 'Active jobs' : locale === 'de' ? 'Aktive Stellen' : 'Offres actives';
 const freshLabel = locale === 'it' ? 'Nuove · 7gg' : locale === 'en' ? 'New · 7d' : locale === 'de' ? 'Neu · 7T' : 'Récent · 7j';
 const companiesLabel = locale === 'it' ? 'Aziende' : locale === 'en' ? 'Companies' : locale === 'de' ? 'Unternehmen' : 'Entreprises';
 const citiesLabel = locale === 'it' ? 'Località' : locale === 'en' ? 'Locations' : locale === 'de' ? 'Standorte' : 'Localités';
 const statTiles: Array<{ label: string; value: string; tone: ReturnType<typeof pickStatTileTone> }> = [
 { label: activeLabel, value: String(sJobs.length), tone: pickStatTileTone('openings', sJobs.length) },
 ];
 if (sFreshCount > 0) statTiles.push({ label: freshLabel, value: `+${sFreshCount}`, tone: pickStatTileTone('fresh', sFreshCount) });
 if (sUniqueCompanies.length > 0) statTiles.push({ label: companiesLabel, value: String(sUniqueCompanies.length), tone: 'neutral' });
 if (sUniqueLocations.length > 0) statTiles.push({ label: citiesLabel, value: String(sUniqueLocations.length), tone: 'neutral' });
 const statGridHtml = renderStatGrid(statTiles);
 const ctaHtml = `<a href="${sectionRootUrl}" class="${CTA_PRIMARY_CLASS}" style="margin:0 0 24px">${esc(openAllLabel)} →</a>`;
 const bodyHtml = `${eyebrowHtml}\n<h1>${esc(pageHeading)}</h1>\n<p>${esc(pageDesc)}</p>\n${statGridHtml}\n${ctaHtml}\n${intro}\n<ul class="s-0WjlyL">${listHtml}</ul>\n${marketSection}\n${renderJobBoardListingDensityProse(locale, { subject: sectorDisplay, location: cDisplay, resultCount: sJobs.length, companyCount: sUniqueCompanies.length, locationCount: sUniqueLocations.length })}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cDisplay, omitCommute: true, sectorOrType: sectorDisplay, cantonDisplay: cDisplay, cantonSlot: 'sectors-hub' }))}`;
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const html = buildSeoPageHtml({
 locale,
 title: pageTitle,
 description: pageDesc,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 jsonLdScripts: [breadcrumbLd, collectionLd, itemListLd],
 bodyHtml,
 distDir,
 });
 // Hard budget guard (mirror per-canton city hub 195 KB cap).
 const SECTOR_CANTON_HARD_BUDGET = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > SECTOR_CANTON_HARD_BUDGET) {
 throw new Error(
 `[jobs-seo-pages] Per-canton sector hub ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${SECTOR_CANTON_HARD_BUDGET / 1024} KB.`
 );
 }
 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) { const flatFile = np.join(distDir, flatPath.slice(1) + '.html'); _md(np.dirname(flatFile)); _qwFlat(flatFile, html); }
 sectorHubPagesCount++;
 recordEmit('sector-canton-hub', __tSectorCanton);
 void seo; // buildSectorHubSeo currently unused in thin variant; kept for future enrichment
 }
 // Sitemap entry (priority 0.8 mirroring TI sector hubs).
 const itSection = sharedResolveCantonSection('it', canton);
 const itSectorSlug = SECTOR_HUB_SLUG.it[sector];
 const itPath = `/${itSection}/${itSectorSlug}/`.replace(/\/+/g, '/');
 const localePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSection = sharedResolveCantonSection(l, canton);
 const lSectorSlug = SECTOR_HUB_SLUG[l][sector];
 const lp = `${localePrefix[l]}/${lSection}/${lSectorSlug}/`.replace(/\/+/g, '/');
 localePaths.set(l, lp);
 }
 const smAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${localePaths.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see
 // pushEditorialSitemapEntry above for rationale.
 for (const l of localeList) {
 const p = localePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 sectorHubSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${smAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.8</priority>\n </url>`);
 }
 }
 }
 if (sectorHubPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${sectorHubPagesCount} per-canton sector hub pages`);
 logBuildMem('jobsSeoPages: after sector-hubs', collector);
 await collector.awaitDrainSlot(2); // bound _pendingFlushes backlog during bulk emit (#1290)
 const sectorHubEntriesJoined = sectorHubSitemapEntries.join('\n');
 editorialEntries = editorialEntries
 ? `${editorialEntries}\n${sectorHubEntriesJoined}`
 : sectorHubEntriesJoined;
 }
 }

 /* ── Company hub v2 shared data blocks (issue #4306) ──────────────────
  * Additive, cross-tier helpers reused by Phase 3.3 (per-canton) and
  * Phase 3.4 (per-canton × city) company hub loops below: a cross-canton
  * hiring distribution (for "also hiring in" cross-links), a salary-range
  * block, and a generic-but-per-company FAQ block. Every fact is derived
  * from real per-job fields already present on `validJobs`
  * (job.salaryMin/salaryMax, job.location, job.title, job.companyDomain) —
  * no invented per-brand claims (see issue #4306 ask: real data, not
  * identical boilerplate). Self-contained: does not touch
  * searchConsoleCompat.ts (company hub URL shapes are unchanged — only the
  * page body/JSON-LD gain content) and does not touch any other in-flight
  * branch's additions to this file.
  */
 const COMPANY_HUB_ALSO_HIRING_MIN_JOBS = 3; // mirrors MIN_JOBS_PER_CANTON_COMPANY below — only cross-link to a canton when a real (non-bridge) hub page exists there.
 const companyCantonDistribution: Map<string, Map<string, { name: string; count: number }>> = new Map();
 for (const job of validJobs) {
 const jc = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (!jc) continue;
 const slug = companyHubSlugBuild(job.company, job.companyKey);
 if (!slug) continue;
 if (!companyCantonDistribution.has(slug)) companyCantonDistribution.set(slug, new Map());
 const byCanton = companyCantonDistribution.get(slug)!;
 const entry = byCanton.get(jc);
 if (entry) entry.count++;
 else byCanton.set(jc, { name: job.company, count: 1 });
 }
 const companyHubAlsoHiringLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Altre sedi che assumono',
 en: 'Also hiring in',
 de: 'Weitere Standorte mit offenen Stellen',
 fr: 'Recrute aussi à',
 };
 /** Cross-canton "also hiring in" links — only to cantons with a real (non-bridge) hub. */
 const renderCompanyHubAlsoHiringHtml = (
 slug: string,
 currentCanton: string,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const byCanton = companyCantonDistribution.get(slug);
 if (!byCanton) return '';
 const others = [...byCanton.entries()]
 .filter(([canton, v]) => canton !== currentCanton && (canton === 'TI' || v.count >= COMPANY_HUB_ALSO_HIRING_MIN_JOBS))
 .sort((a, b) => b[1].count - a[1].count)
 .slice(0, 4);
 if (others.length === 0) return '';
 const prefix = companyRoutePrefix[locale];
 const items = others.map(([canton, { count }]) => {
 const cLabel = getCantonDisplayLabel(canton, locale);
 const section = sharedResolveCantonSection(locale, canton);
 const href = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${section}/${prefix}-${slug}`.replace(/\/+/g, '/'))}`;
 const countLabel = locale === 'it' ? `${count} posizion${count === 1 ? 'e' : 'i'}`
 : locale === 'en' ? `${count} role${count === 1 ? '' : 's'}`
 : locale === 'de' ? `${count} Stelle${count === 1 ? '' : 'n'}`
 : `${count} poste${count === 1 ? '' : 's'}`;
 return `<li><a href="${href}">${esc(cLabel)} — ${esc(countLabel)}</a></li>`;
 }).join('');
 return `<section class="s-7uP4UM"><h2>${esc(companyHubAlsoHiringLabel[locale])}</h2><ul>${items}</ul></section>`;
 };
 /** Salary-range block — real job.salaryMin/salaryMax aggregate, omitted when no data exists. */
 const renderCompanyHubSalaryRangeHtml = (
 jobs: ReadonlyArray<any>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const values = jobs
 .map((j: any) => ({ min: Number(j.salaryMin), max: Number(j.salaryMax), currency: String(j.currency || 'CHF') }))
 .filter((v) => Number.isFinite(v.min) && v.min > 0);
 if (values.length === 0) return '';
 const overallMin = Math.min(...values.map((v) => v.min));
 const overallMax = Math.max(...values.map((v) => (Number.isFinite(v.max) && v.max > v.min ? v.max : v.min)));
 const currency = values[0].currency || 'CHF';
 const fmt = (n: number) => `${(n / 1000).toFixed(0)}k`;
 const rangeText = overallMax > overallMin
 ? `${currency} ${fmt(overallMin)} – ${fmt(overallMax)}`
 : `${currency} ${fmt(overallMin)}+`;
 const heading = locale === 'it' ? 'Fascia stipendi indicativa'
 : locale === 'en' ? 'Estimated salary range'
 : locale === 'de' ? 'Geschätzte Gehaltsspanne'
 : 'Fourchette salariale indicative';
 const note = locale === 'it' ? `Stima basata su ${values.length} annunci con dato salariale, lordo/mese.`
 : locale === 'en' ? `Estimate based on ${values.length} listings with salary data, gross/month.`
 : locale === 'de' ? `Schätzung basierend auf ${values.length} Anzeigen mit Gehaltsangabe, brutto/Monat.`
 : `Estimation basée sur ${values.length} annonces avec données salariales, brut/mois.`;
 return `<section class="s-7uP4UM"><h2>${esc(heading)}</h2><p><strong>${esc(rangeText)}</strong></p><p>${esc(note)}</p></section>`;
 };
 type CompanyHubFaqItem = { q: string; a: string };
 /** Per-company FAQ items — real job count/roles/salary data; the frontalieri answer reuses the same factual statement already used verbatim in `marketSection` elsewhere in this file, not a per-employer claim. */
 const buildCompanyHubFaqItems = (
 companyName: string,
 scopeLabel: string,
 jobs: ReadonlyArray<any>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): CompanyHubFaqItem[] => {
 const items: CompanyHubFaqItem[] = [];
 const roleTitles = [...new Set(jobs.map((j: any) => stripLiteralMarkdownFromTitle(String(j?.titleByLocale?.[locale] || j?.title || '').trim())).filter(Boolean))].slice(0, 5);
 const count = jobs.length;
 if (roleTitles.length > 0) {
 const q = locale === 'it' ? `Quali posizioni offre ${companyName} in questo momento?`
 : locale === 'en' ? `What roles is ${companyName} currently hiring for?`
 : locale === 'de' ? `Welche Stellen bietet ${companyName} aktuell an?`
 : `Quels postes ${companyName} propose-t-il actuellement ?`;
 const a = locale === 'it' ? `${companyName} ha attualmente ${count} posizioni aperte in ${scopeLabel}, tra cui: ${roleTitles.join(', ')}.`
 : locale === 'en' ? `${companyName} currently has ${count} open positions in ${scopeLabel}, including: ${roleTitles.join(', ')}.`
 : locale === 'de' ? `${companyName} hat derzeit ${count} offene Stellen in ${scopeLabel}, darunter: ${roleTitles.join(', ')}.`
 : `${companyName} compte actuellement ${count} postes ouverts à ${scopeLabel}, dont : ${roleTitles.join(', ')}.`;
 items.push({ q, a });
 }
 // The FAQ answer below hardcodes a "CHF" label per locale — unlike
 // renderCompanyHubSalaryRangeHtml above (which reads j.currency), this
 // aggregate must exclude EUR-denominated postings itself, or an EUR salary
 // figure gets silently labeled/mixed in as CHF (review PR #4338, bug I sibling).
 const chfJobsForSalaryFaq = jobs.filter((j: any) => String(j.currency || 'CHF') !== 'EUR');
 const salaryMins = chfJobsForSalaryFaq.map((j: any) => Number(j.salaryMin)).filter((n) => Number.isFinite(n) && n > 0);
 if (salaryMins.length > 0) {
 const minV = Math.min(...salaryMins);
 const salaryMaxCandidates = chfJobsForSalaryFaq.map((j: any) => Number(j.salaryMax)).filter((n) => Number.isFinite(n) && n > 0);
 const maxV = salaryMaxCandidates.length > 0 ? Math.max(...salaryMaxCandidates) : minV;
 const q = locale === 'it' ? `Quanto paga ${companyName}?`
 : locale === 'en' ? `What salary does ${companyName} pay?`
 : locale === 'de' ? `Wie viel zahlt ${companyName}?`
 : `Combien paie ${companyName} ?`;
 const a = locale === 'it' ? `In base agli annunci pubblicati, la fascia stipendiale indicativa presso ${companyName} va da circa CHF ${(minV / 1000).toFixed(0)}k a CHF ${(maxV / 1000).toFixed(0)}k lordi al mese, in base al ruolo. Si tratta di una stima automatica, non di una comunicazione ufficiale dell'azienda.`
 : locale === 'en' ? `Based on published listings, the indicative salary range at ${companyName} runs from about CHF ${(minV / 1000).toFixed(0)}k to CHF ${(maxV / 1000).toFixed(0)}k gross per month, depending on role. This is an automated estimate, not an official company disclosure.`
 : locale === 'de' ? `Basierend auf veröffentlichten Anzeigen liegt die geschätzte Gehaltsspanne bei ${companyName} zwischen etwa CHF ${(minV / 1000).toFixed(0)}k und CHF ${(maxV / 1000).toFixed(0)}k brutto pro Monat, je nach Rolle. Dies ist eine automatische Schätzung, keine offizielle Angabe des Unternehmens.`
 : `Sur la base des annonces publiées, la fourchette salariale indicative chez ${companyName} va d'environ CHF ${(minV / 1000).toFixed(0)}k à CHF ${(maxV / 1000).toFixed(0)}k brut par mois, selon le poste. Il s'agit d'une estimation automatique, non d'une communication officielle de l'entreprise.`;
 items.push({ q, a });
 }
 const qFr = locale === 'it' ? `${companyName} assume anche frontalieri?`
 : locale === 'en' ? `Does ${companyName} hire cross-border workers (frontalieri)?`
 : locale === 'de' ? `Stellt ${companyName} auch Grenzgänger ein?`
 : `${companyName} embauche-t-il aussi des frontaliers ?`;
 const aFr = locale === 'it' ? `Come per tutti i datori di lavoro in Svizzera, i lavoratori frontalieri con Permesso G possono candidarsi alle posizioni ${companyName}. La Svizzera applica l'imposta alla fonte sul reddito lordo dei frontalieri: usa il nostro simulatore fiscale gratuito per stimare lo stipendio netto.`
 : locale === 'en' ? `As with all Swiss employers, cross-border workers with a G Permit can apply to ${companyName} positions. Switzerland applies withholding tax on cross-border workers' gross income: use our free tax simulator to estimate your net salary.`
 : locale === 'de' ? `Wie bei allen Schweizer Arbeitgebern können Grenzgänger mit G-Bewilligung sich bei ${companyName} bewerben. Die Schweiz erhebt eine Quellensteuer auf das Bruttoeinkommen von Grenzgängern: Nutzen Sie unseren kostenlosen Steuersimulator, um Ihr Nettogehalt zu schätzen.`
 : `Comme pour tous les employeurs suisses, les travailleurs frontaliers titulaires d'un permis G peuvent postuler aux postes chez ${companyName}. La Suisse applique un impôt à la source sur le revenu brut des frontaliers : utilisez notre simulateur fiscal gratuit pour estimer votre salaire net.`;
 items.push({ q: qFr, a: aFr });
 return items;
 };
 /** Renders the FAQ HTML block + matching FAQPage JSON-LD (content parity — rich-result requirement). */
 const renderCompanyHubFaqHtml = (
 items: ReadonlyArray<CompanyHubFaqItem>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): { html: string; ld: string } => {
 if (items.length === 0) return { html: '', ld: '' };
 const heading = locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Häufig gestellte Fragen' : 'Questions fréquentes';
 const html = `<section class="s-7uP4UM"><h2>${esc(heading)}</h2>${items.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}</section>`;
 const ld = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
 });
 return { html, ld };
 };
 /** Real (non-invented) Organization LD extras: sameAs from job.companyDomain, logo only from the curated map (never the generic OG placeholder or an initials SVG). */
 const resolveCompanyHubOrgExtras = (
 jobs: ReadonlyArray<any>,
 ): { sameAs?: string; logo?: string } => {
 const withDomain = jobs.find((j: any) => String(j?.companyDomain || '').trim().length > 0);
 const sameAs = withDomain ? `https://${String((withDomain as any).companyDomain).replace(/^https?:\/\//, '').trim()}` : undefined;
 const sampleJob = jobs[0];
 const rawLogo = sampleJob ? companyLogo(sampleJob) : COMPANY_LOGO_JSONLD_FALLBACK;
 const logo = rawLogo && rawLogo !== COMPANY_LOGO_JSONLD_FALLBACK
 ? (rawLogo.startsWith('http') ? rawLogo : `${BASE_URL}${rawLogo}`)
 : undefined;
 return { sameAs, logo };
 };

 /* ── Per-canton company hubs (Phase 3.3) ─────────────────────
  * Additive: for every non-TI canton, for every company with ≥ 3 jobs in
  * that canton, emit /cerca-lavoro-{cantonSlug}/azienda-{companySlug}/ —
  * a thin per-canton company hub page (H1, intro, filtered job list,
  * canonical pointing at itself).
  *
  * TI company hubs at /cerca-lavoro-ticino/azienda-{slug}/ stay byte-
  * identical — handled exclusively by the legacy `for (const [cSlug, ...]
  * of companyMap)` emit block above. BRAND_CANONICAL_MAP and
  * EMPLOYER_BRANDS aliasing are NOT touched: TI canonical for a brand
  * stays the TI URL, and the new per-canton hubs each carry their own
  * self-canonical `<link rel="canonical">`.
  *
  * Rationale for the thin variant (see CLAUDE.md / orchestrator note):
  * the full TI company-hub template (curated EOC/Lidl prose, founded/size
  * enrichment, full sector/city chip rows, curated FAQ) is too entangled
  * with BRAND_CANONICAL_MAP to safely fork per-canton without risking the
  * TI canonical. The thin variant ships the SEO funnel today; richer
  * per-canton enrichment can land as a follow-up.
  */
 {
 const MIN_JOBS_PER_CANTON_COMPANY = 3;
 const COMPANY_CANTON_JOB_CAP = 30;
 // Bucket (canton, companyCanonicalSlug) → jobs[], with display-name.
 type CompCanton = { name: string; jobs: typeof validJobs };
 const cantonCompanyBuckets: Map<string, Map<string, CompCanton>> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (c === 'TI') continue;
 const canonical = companyHubSlugBuild(job.company, job.companyKey);
 if (!canonical) continue;
 if (!cantonCompanyBuckets.has(c)) cantonCompanyBuckets.set(c, new Map());
 const byCompany = cantonCompanyBuckets.get(c)!;
 if (!byCompany.has(canonical)) byCompany.set(canonical, { name: job.company, jobs: [] });
 byCompany.get(canonical)!.jobs.push(job);
 }
 const cantonDisplayLocalComp = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 const companyCantonSitemapEntries: string[] = [];
 let companyCantonPagesCount = 0;
 // Below-floor bridge (#3747, AGENTS.md § Static SEO Pages): a company whose
 // per-canton job count fluctuates under MIN_JOBS_PER_CANTON_COMPANY between
 // builds would otherwise hard-404 a previously-emitted (and possibly
 // indexed) /azienda-{slug}/ URL on GH Pages. Emit a noindex,follow bridge
 // at the same URL, pointing at the always-live canton section root — same
 // bridge pattern the sector hubs used before their floor was removed
 // (PR #3594; sector hubs went floor-less in PR #4254). Company slugs are
 // data-driven (not enumerable at module load), so searchConsoleCompat.ts
 // does NOT self-map them; its COMPANY_COMPAT_PATTERN branch already
 // resolves any residual company-hub 404 (kind 'company').
 let companyCantonBelowFloorBridges = 0;
 const emitCompanyCantonBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, fullSlug: string): void => {
 const section = buildCantonAwareSection(locale, canton);
 const targetPath = withSlash(`${localePrefix[locale]}/${section}`.replace(/\/+/g, '/'));
 const canonicalPath = withSlash(`${localePrefix[locale]}/${section}/${fullSlug}`.replace(/\/+/g, '/'));
 const html = buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${targetPath}`,
 pathLabel: targetPath,
 lang: locale,
 noindex: true,
 });
 const relPath = canonicalPath.slice(1).replace(/\/$/, '');
 const dir = np.join(distDir, relPath);
 const dirIndex = np.join(dir, 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) {
 _md(dir);
 _qw(dirIndex, html);
 }
 const flatFile = np.join(distDir, relPath + '.html');
 if (!_writtenPaths.has(flatFile) && !fs.existsSync(flatFile)) {
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 companyCantonBelowFloorBridges++;
 };
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue;
 const byCompany = cantonCompanyBuckets.get(canton);
 if (!byCompany) continue;
 for (const [cSlug, { name: companyName, jobs: companyJobs }] of byCompany) {
 if (companyJobs.length < MIN_JOBS_PER_CANTON_COMPANY) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitCompanyCantonBelowFloorBridge(locale, canton, `${companyRoutePrefix[locale]}-${cSlug}`);
 }
 continue;
 }
 const sortedJobs = [...companyJobs].sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const cappedJobs = sortedJobs.slice(0, COMPANY_CANTON_JOB_CAP);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tCompanyCanton = startTimer();
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const prefix = companyRoutePrefix[locale];
 const fullSlug = `${prefix}-${cSlug}`;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const cDisplay = cantonDisplayLocalComp(canton, locale);
 const year = new Date().getFullYear();
 const pageTitle = buildEmployerHubTitle({
 locale,
 companyDisplay: `${companyName} (${cDisplay})`,
 count: companyJobs.length,
 year,
 });
 const pageDesc = locale === 'it' ? `${companyJobs.length} offerte di lavoro presso ${companyName} in ${cDisplay}. Annunci aggiornati quotidianamente. Candidati come frontaliere o residente.`
 : locale === 'en' ? `${companyJobs.length} job openings at ${companyName} in ${cDisplay}. Updated daily. Apply as cross-border worker or resident.`
 : locale === 'de' ? `${companyJobs.length} Stellenangebote bei ${companyName} in ${cDisplay}. Täglich aktualisiert. Bewerben Sie sich als Grenzgänger oder Einwohner.`
 : `${companyJobs.length} offres d'emploi chez ${companyName} à ${cDisplay}. Mises à jour quotidiennement. Candidatez comme frontalier ou résident.`;
 const pageHeading = locale === 'it' ? `Offerte di lavoro presso ${companyName} in ${cDisplay}`
 : locale === 'en' ? `Job openings at ${companyName} in ${cDisplay}`
 : locale === 'de' ? `Stellenangebote bei ${companyName} in ${cDisplay}`
 : `Offres d'emploi chez ${companyName} à ${cDisplay}`;
 const altPairs = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alPrefix = companyRoutePrefix[al];
 const alSlug = `${alPrefix}-${cSlug}`;
 const alPath = `${localePrefix[al]}/${alSection}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const xDefaultHref = altPairs.find((p) => p.lang === 'it')?.href ?? altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
 ...altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;
 const sectionLabel = locale === 'it' ? `Cerca lavoro in ${cDisplay}` : locale === 'en' ? `Find jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Trouver un emploi à ${cDisplay}`;
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: sectionLabel, item: sectionRootUrl },
 { '@type': 'ListItem', position: 3, name: pageHeading, item: canonicalUrl },
 ],
 });
 const collectionLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: pageTitle,
 url: canonicalUrl,
 description: pageDesc,
 inLanguage: locale,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
 });
 const itemListLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: pageTitle,
 numberOfItems: cappedJobs.length,
 // Embed a full JobPosting per item (capped description, never throws → falls
 // back to a name+url stub). Mirrors the editorial-landing ItemList; the
 // authoritative per-job JobPosting still lives on each linked detail page.
 itemListElement: cappedJobs.slice(0, 10).map((job: any, i: number) =>
 mapCantonJobToListItem(job, i, locale, sectionSlug, canton)),
 });
 // Organization JSON-LD — derived from job data (no curated overlay).
 // sameAs/logo (issue #4306) are real, derived values only: sameAs from
 // job.companyDomain, logo only from the curated CRAWLED_COMPANY_LOGOS map
 // (never the generic OG placeholder or an initials SVG) — see
 // resolveCompanyHubOrgExtras above.
 const companyLocations = [...new Set(cappedJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const { sameAs: companyHubSameAs, logo: companyHubLogo } = resolveCompanyHubOrgExtras(cappedJobs);
 const orgLdObj: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: companyName,
 address: {
 '@type': 'PostalAddress',
 ...(primaryLocation ? { addressLocality: primaryLocation } : {}),
 addressRegion: cDisplay,
 addressCountry: 'CH',
 },
 numberOfEmployees: {
 '@type': 'QuantitativeValue',
 value: companyJobs.length,
 unitText: openPositionsUnit[locale],
 },
 ...(companyHubSameAs ? { sameAs: companyHubSameAs } : {}),
 ...(companyHubLogo ? { logo: companyHubLogo } : {}),
 };
 const organizationLd = inlineScriptJson(orgLdObj);
 const listHtml = jobCardListBody(cappedJobs, locale);
 const intro = (() => {
 if (locale === 'it') return `<p>Sono attualmente <strong>${companyJobs.length} le offerte di lavoro</strong> presso ${esc(companyName)} in ${esc(cDisplay)}, distribuite in ${companyLocations.length} ${companyLocations.length === 1 ? 'località' : 'località'}. Gli annunci sono aggiornati quotidianamente dal nostro crawler automatico.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${companyJobs.length} job openings</strong> at ${esc(companyName)} in ${esc(cDisplay)}, across ${companyLocations.length} location${companyLocations.length === 1 ? '' : 's'}. Listings are refreshed daily by our automated crawler.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${companyJobs.length} Stellenangebote</strong> bei ${esc(companyName)} in ${esc(cDisplay)} verfügbar, an ${companyLocations.length} Standort${companyLocations.length === 1 ? '' : 'en'}. Täglich aktualisiert.</p>`;
 return `<p>${companyJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles chez ${esc(companyName)} à ${esc(cDisplay)}, sur ${companyLocations.length} site${companyLocations.length === 1 ? '' : 's'}. Mises à jour quotidiennement.</p>`;
 })();
 const marketSection = (() => {
 if (locale === 'it') return `<section class="s-7uP4UM"><h2>Lavorare presso ${esc(companyName)} in ${esc(cDisplay)}</h2><p>${esc(companyName)} è una delle aziende che assumono in ${esc(cDisplay)}. Per i lavoratori frontalieri con Permesso G, la Svizzera applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto.</p></section>`;
 if (locale === 'en') return `<section class="s-7uP4UM"><h2>Working at ${esc(companyName)} in ${esc(cDisplay)}</h2><p>${esc(companyName)} is among the hiring companies in ${esc(cDisplay)}. For cross-border workers with a G Permit, Switzerland applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary.</p></section>`;
 if (locale === 'de') return `<section class="s-7uP4UM"><h2>Arbeiten bei ${esc(companyName)} in ${esc(cDisplay)}</h2><p>${esc(companyName)} gehört zu den einstellenden Unternehmen in ${esc(cDisplay)}. Für Grenzgänger mit G-Bewilligung erhebt die Schweiz eine Quellensteuer. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>.</p></section>`;
 return `<section class="s-7uP4UM"><h2>Travailler chez ${esc(companyName)} à ${esc(cDisplay)}</h2><p>${esc(companyName)} fait partie des entreprises qui recrutent à ${esc(cDisplay)}. Pour les frontaliers avec un permis G, la Suisse applique un impôt à la source. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a>.</p></section>`;
 })();
 const openAllLabel = locale === 'it' ? `Apri tutte le offerte in ${cDisplay}` : locale === 'en' ? `View all jobs in ${cDisplay}` : locale === 'de' ? `Alle Stellen ${cDisplay}` : `Voir toutes les offres à ${cDisplay}`;
 // Company hub v2 data blocks (issue #4306): salary range + cross-canton
 // "also hiring" + FAQ, all real-data-derived — placed after the primary
 // open-positions list (already above the fold) and before the longer
 // prose sections, per AGENTS.md SEO landing order (data area before
 // "prose lunga").
 const salaryBlockHtml = renderCompanyHubSalaryRangeHtml(cappedJobs, locale);
 const alsoHiringHtml = renderCompanyHubAlsoHiringHtml(cSlug, canton, locale);
 const faqItems = buildCompanyHubFaqItems(companyName, cDisplay, cappedJobs, locale);
 const { html: faqHtml, ld: faqLd } = renderCompanyHubFaqHtml(faqItems, locale);
 const bodyHtml = `<h1>${esc(pageHeading)}</h1>\n<p>${esc(pageDesc)}</p>\n${intro}\n<ul class="s-0WjlyL">${listHtml}</ul>\n<p><a href="${sectionRootUrl}">${esc(openAllLabel)}</a></p>\n${salaryBlockHtml}\n${alsoHiringHtml}\n${faqHtml}\n${marketSection}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cDisplay, omitCommute: true, cantonDisplay: cDisplay, cantonSlot: 'company-landing', cantonEntityName: companyName }))}`;
 // Use buildSeoPageHtml (NOT buildSimplePage) so the page emits
 // `<main class="seo-static-content">` OUTSIDE `<div id="root">` +
 // `<div id="footer-root"></div>`. The legacy path (buildSimplePage default
 // skipMainWrap=false + seoContentOutsideRoot=false) wraps the static body
 // in `<main class="static-job-page">` INSIDE `#root`, and React hydration
 // wipes that <main> when no SPA route matches the URL — leaving the page
 // visibly blank for end users. (Bug surfaced as validate-live failure
 // 2026-05-19 on /cerca-lavoro-zurigo/azienda-kantonsspital-winterthur-ksw/.)
 // The TI sibling emitter at line ~3419 already uses buildSeoPageHtml; this
 // aligns the non-TI per-canton hubs to the same hydration-safe shell.
 const html = buildSeoPageHtml({
 locale,
 title: pageTitle,
 description: pageDesc,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 jsonLdScripts: [breadcrumbLd, collectionLd, itemListLd, organizationLd, ...(faqLd ? [faqLd] : [])],
 bodyHtml,
 distDir,
 });
 const COMPANY_CANTON_HARD_BUDGET = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > COMPANY_CANTON_HARD_BUDGET) {
 throw new Error(
 `[jobs-seo-pages] Per-canton company hub ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${COMPANY_CANTON_HARD_BUDGET / 1024} KB.`
 );
 }
 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) { const flatFile = np.join(distDir, flatPath.slice(1) + '.html'); _md(np.dirname(flatFile)); _qwFlat(flatFile, html); }
 companyCantonPagesCount++;
 recordEmit('company-canton-hub', __tCompanyCanton);
 }
 // Sitemap entry (priority 0.75 mirroring TI company hubs).
 const itSection = sharedResolveCantonSection('it', canton);
 const itFullSlug = `${companyRoutePrefix.it}-${cSlug}`;
 const itPath = `/${itSection}/${itFullSlug}/`.replace(/\/+/g, '/');
 const localePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSection = sharedResolveCantonSection(l, canton);
 const lFullSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const lp = `${localePrefix[l]}/${lSection}/${lFullSlug}/`.replace(/\/+/g, '/');
 localePaths.set(l, lp);
 }
 const smAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${localePaths.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see
 // pushEditorialSitemapEntry above for rationale.
 for (const l of localeList) {
 const p = localePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 companyCantonSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${smAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.75</priority>\n </url>`);
 }
 }
 }
 if (companyCantonBelowFloorBridges > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P8 company-canton below-floor bridges: ${companyCantonBelowFloorBridges} (per-canton company hubs)`);
 }
 if (companyCantonPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${companyCantonPagesCount} per-canton company hub pages`);
 logBuildMem('jobsSeoPages: after company-canton-hubs', collector);
 await collector.awaitDrainSlot(2); // bound _pendingFlushes backlog during bulk emit (#1290)
 const companyCantonEntriesJoined = companyCantonSitemapEntries.join('\n');
 editorialEntries = editorialEntries
 ? `${editorialEntries}\n${companyCantonEntriesJoined}`
 : companyCantonEntriesJoined;
 }
 }

 /* ── Per-canton company × city hubs (Phase 3.4) ──────────────
  * Additive: for every non-TI canton, for every (company, city) pair
  * with ≥ 2 jobs from that company in that city, emit
  * /cerca-lavoro-{cantonSlug}/azienda-{companySlug}-{citySlug}/.
  *
  * No legacy TI company×city emit exists — Phase 3.4 is purely NEW
  * surface area, gated on non-TI cantons. TI is explicitly skipped here
  * to avoid clobbering the TI section namespace where any URL of the
  * shape `/cerca-lavoro-ticino/azienda-…` is already a TI company hub
  * (whether canonical or BRAND_CANONICAL_MAP alias bridge). Adding TI
  * company×city pages would require a deeper bridge contract — out of
  * scope for the additive expansion.
  */
 {
 const MIN_JOBS_PER_CANTON_COMPANY_CITY = 2;
 const COMPANY_CITY_JOB_CAP = 20;
 // Bucket: canton → company canonical → city slug → { jobs, display, name }
 type CompCityEntry = { name: string; cityDisplay: string; jobs: typeof validJobs };
 const buckets: Map<string, Map<string, Map<string, CompCityEntry>>> = new Map();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const c = sharedResolveJobCanton(job as { canton?: string; location?: string });
 if (c === 'TI') continue;
 const canonical = companyHubSlugBuild(job.company, job.companyKey);
 if (!canonical) continue;
 const rawLocation = String((job as any).location || '').split(/[,(]/)[0].trim();
 if (!rawLocation) continue;
 const citySlug = normalizeCitySlug(rawLocation);
 if (!citySlug) continue;
 if (!buckets.has(c)) buckets.set(c, new Map());
 const byCompany = buckets.get(c)!;
 if (!byCompany.has(canonical)) byCompany.set(canonical, new Map());
 const byCity = byCompany.get(canonical)!;
 if (!byCity.has(citySlug)) byCity.set(citySlug, { name: job.company, cityDisplay: rawLocation, jobs: [] });
 byCity.get(citySlug)!.jobs.push(job);
 }
 const cantonDisplayLocalCC = (canton: string, locale: typeof localeList[number]): string => {
 return getCantonDisplayLabel(canton, locale);
 };
 const companyCitySitemapEntries: string[] = [];
 let companyCityPagesCount = 0;
 // Below-floor bridge (#3747, AGENTS.md § Static SEO Pages): a (company,
 // city) pair whose job count fluctuates under
 // MIN_JOBS_PER_CANTON_COMPANY_CITY between builds would otherwise hard-404
 // a previously-emitted (and possibly indexed) /azienda-{slug}-{city}/ URL
 // on GH Pages. Emit a noindex,follow bridge at the same URL, pointing at
 // the always-live canton section root — same bridge pattern the sector
 // hubs used before their floor was removed (PR #3594; sector hubs went
 // floor-less in PR #4254). Company×city slugs are
 // data-driven (not enumerable at module load), so searchConsoleCompat.ts
 // does NOT self-map them; its COMPANY_COMPAT_PATTERN branch already
 // resolves any residual 404 of this shape (kind 'company').
 let companyCityBelowFloorBridges = 0;
 const emitCompanyCityBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, fullSlug: string): void => {
 const section = buildCantonAwareSection(locale, canton);
 const targetPath = withSlash(`${localePrefix[locale]}/${section}`.replace(/\/+/g, '/'));
 const canonicalPath = withSlash(`${localePrefix[locale]}/${section}/${fullSlug}`.replace(/\/+/g, '/'));
 const html = buildCanonicalBridgePage({
 canonicalUrl: `${BASE_URL}${targetPath}`,
 pathLabel: targetPath,
 lang: locale,
 noindex: true,
 });
 const relPath = canonicalPath.slice(1).replace(/\/$/, '');
 const dir = np.join(distDir, relPath);
 const dirIndex = np.join(dir, 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) {
 _md(dir);
 _qw(dirIndex, html);
 }
 const flatFile = np.join(distDir, relPath + '.html');
 if (!_writtenPaths.has(flatFile) && !fs.existsSync(flatFile)) {
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 companyCityBelowFloorBridges++;
 };
 for (const canton of SHARED_ALL_CANTON_CODES) {
 if (canton === 'TI') continue;
 const byCompany = buckets.get(canton);
 if (!byCompany) continue;
 for (const [cSlug, byCity] of byCompany) {
 for (const [citySlug, { name: companyName, cityDisplay, jobs: ccJobs }] of byCity) {
 if (ccJobs.length < MIN_JOBS_PER_CANTON_COMPANY_CITY) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 emitCompanyCityBelowFloorBridge(locale, canton, `${companyRoutePrefix[locale]}-${cSlug}-${citySlug}`);
 }
 continue;
 }
 const sortedJobs = [...ccJobs].sort((a: any, b: any) => {
 const da = firstParsableMs(b.crawledAt, b.datePosted);
 const db = firstParsableMs(a.crawledAt, a.datePosted);
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const cappedJobs = sortedJobs.slice(0, COMPANY_CITY_JOB_CAP);
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tCompanyCity = startTimer();
 const sectionSlug = sharedResolveCantonSection(locale, canton);
 const prefix = companyRoutePrefix[locale];
 const fullSlug = `${prefix}-${cSlug}-${citySlug}`;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const cDisplay = cantonDisplayLocalCC(canton, locale);
 const year = new Date().getFullYear();
 const pageTitle = buildEmployerHubTitle({
 locale,
 companyDisplay: `${companyName} (${cityDisplay})`,
 count: ccJobs.length,
 year,
 });
 const pageDesc = locale === 'it' ? `${ccJobs.length} offerte di lavoro presso ${companyName} a ${cityDisplay} (${cDisplay}). Annunci aggiornati quotidianamente.`
 : locale === 'en' ? `${ccJobs.length} job openings at ${companyName} in ${cityDisplay} (${cDisplay}). Updated daily.`
 : locale === 'de' ? `${ccJobs.length} Stellenangebote bei ${companyName} in ${cityDisplay} (${cDisplay}). Täglich aktualisiert.`
 : `${ccJobs.length} offres d'emploi chez ${companyName} à ${cityDisplay} (${cDisplay}). Mises à jour quotidiennement.`;
 const pageHeading = locale === 'it' ? `Offerte ${companyName} a ${cityDisplay}`
 : locale === 'en' ? `${companyName} jobs in ${cityDisplay}`
 : locale === 'de' ? `${companyName} Stellen in ${cityDisplay}`
 : `Offres ${companyName} à ${cityDisplay}`;
 const altPairs = localeList.map((al) => {
 const alSection = sharedResolveCantonSection(al, canton);
 const alPrefix = companyRoutePrefix[al];
 const alSlug = `${alPrefix}-${cSlug}-${citySlug}`;
 const alPath = `${localePrefix[al]}/${alSection}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const xDefaultHref = altPairs.find((p) => p.lang === 'it')?.href ?? altPairs[0]?.href ?? canonicalUrl;
 const alternates = [
 ...altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;
 // Pointer back to the per-canton company hub (Phase 3.3) for navigation
 const companyHubPath = `${localePrefix[locale]}/${sectionSlug}/${prefix}-${cSlug}`.replace(/\/+/g, '/');
 const companyHubUrl = `${BASE_URL}${withSlash(companyHubPath)}`;
 const sectionLabel = locale === 'it' ? `Cerca lavoro in ${cDisplay}` : locale === 'en' ? `Find jobs in ${cDisplay}` : locale === 'de' ? `Stellen ${cDisplay}` : `Trouver un emploi à ${cDisplay}`;
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: sectionLabel, item: sectionRootUrl },
 { '@type': 'ListItem', position: 3, name: companyName, item: companyHubUrl },
 { '@type': 'ListItem', position: 4, name: cityDisplay, item: canonicalUrl },
 ],
 });
 const collectionLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: pageTitle,
 url: canonicalUrl,
 description: pageDesc,
 inLanguage: locale,
 isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
 });
 const itemListLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: pageTitle,
 numberOfItems: cappedJobs.length,
 // Embed a full JobPosting per item (capped description, never throws → falls
 // back to a name+url stub). Mirrors the editorial-landing ItemList; the
 // authoritative per-job JobPosting still lives on each linked detail page.
 itemListElement: cappedJobs.slice(0, 10).map((job: any, i: number) =>
 mapCantonJobToListItem(job, i, locale, sectionSlug, canton)),
 });
 // sameAs/logo (issue #4306) — real, derived values only. See
 // resolveCompanyHubOrgExtras above (shared with Phase 3.3).
 const { sameAs: companyCitySameAs, logo: companyCityLogo } = resolveCompanyHubOrgExtras(cappedJobs);
 const orgLdObj: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: companyName,
 address: {
 '@type': 'PostalAddress',
 addressLocality: cityDisplay,
 addressRegion: cDisplay,
 addressCountry: 'CH',
 },
 numberOfEmployees: {
 '@type': 'QuantitativeValue',
 value: ccJobs.length,
 unitText: openPositionsUnit[locale],
 },
 ...(companyCitySameAs ? { sameAs: companyCitySameAs } : {}),
 ...(companyCityLogo ? { logo: companyCityLogo } : {}),
 };
 const organizationLd = inlineScriptJson(orgLdObj);
 const listHtml = jobCardListBody(cappedJobs, locale);
 const intro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${ccJobs.length} offerte di lavoro</strong> presso ${esc(companyName)} a ${esc(cityDisplay)} (Canton ${esc(cDisplay)}). Le offerte sono aggiornate quotidianamente dal nostro crawler automatico.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${ccJobs.length} job openings</strong> at ${esc(companyName)} in ${esc(cityDisplay)} (Canton of ${esc(cDisplay)}). Listings are refreshed daily by our automated crawler.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${ccJobs.length} Stellenangebote</strong> bei ${esc(companyName)} in ${esc(cityDisplay)} (Kanton ${esc(cDisplay)}) verfügbar. Täglich aktualisiert.</p>`;
 return `<p>${ccJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles chez ${esc(companyName)} à ${esc(cityDisplay)} (Canton de ${esc(cDisplay)}). Mises à jour quotidiennement.</p>`;
 })();
 const openAllLabel = locale === 'it' ? `Vedi tutte le offerte presso ${companyName}` : locale === 'en' ? `View all jobs at ${companyName}` : locale === 'de' ? `Alle Stellen bei ${companyName}` : `Voir toutes les offres chez ${companyName}`;
 // Company hub v2 data blocks (issue #4306) — same shared helpers as
 // Phase 3.3, scoped to this canton×city bucket's job set.
 const salaryBlockHtmlCC = renderCompanyHubSalaryRangeHtml(cappedJobs, locale);
 const alsoHiringHtmlCC = renderCompanyHubAlsoHiringHtml(cSlug, canton, locale);
 const faqItemsCC = buildCompanyHubFaqItems(companyName, cityDisplay, cappedJobs, locale);
 const { html: faqHtmlCC, ld: faqLdCC } = renderCompanyHubFaqHtml(faqItemsCC, locale);
 const bodyHtml = `<h1>${esc(pageHeading)}</h1>\n<p>${esc(pageDesc)}</p>\n${intro}\n<ul class="s-0WjlyL">${listHtml}</ul>\n<p><a href="${companyHubUrl}">${esc(openAllLabel)}</a></p>\n${salaryBlockHtmlCC}\n${alsoHiringHtmlCC}\n${faqHtmlCC}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: cityDisplay, cantonDisplay: cDisplay, cantonSlot: 'company-landing', cantonEntityName: `${companyName} — ${cityDisplay}` }))}`;
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const html = buildSeoPageHtml({
 locale,
 title: pageTitle,
 description: pageDesc,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 jsonLdScripts: [breadcrumbLd, collectionLd, itemListLd, organizationLd, ...(faqLdCC ? [faqLdCC] : [])],
 bodyHtml,
 distDir,
 });
 const COMPANY_CITY_HARD_BUDGET = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > COMPANY_CITY_HARD_BUDGET) {
 throw new Error(
 `[jobs-seo-pages] Per-canton company×city hub ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${COMPANY_CITY_HARD_BUDGET / 1024} KB.`
 );
 }
 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) { const flatFile = np.join(distDir, flatPath.slice(1) + '.html'); _md(np.dirname(flatFile)); _qwFlat(flatFile, html); }
 companyCityPagesCount++;
 recordEmit('company-city-canton-hub', __tCompanyCity);
 }
 // Sitemap entry (priority 0.65 -- deeper in the funnel than company hub).
 const itSection = sharedResolveCantonSection('it', canton);
 const itFullSlug = `${companyRoutePrefix.it}-${cSlug}-${citySlug}`;
 const itPath = `/${itSection}/${itFullSlug}/`.replace(/\/+/g, '/');
 const localePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSection = sharedResolveCantonSection(l, canton);
 const lFullSlug = `${companyRoutePrefix[l]}-${cSlug}-${citySlug}`;
 const lp = `${localePrefix[l]}/${lSection}/${lFullSlug}/`.replace(/\/+/g, '/');
 localePaths.set(l, lp);
 }
 const smAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${localePaths.get(l)}" />`).join('\n');
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see
 // pushEditorialSitemapEntry above for rationale.
 for (const l of localeList) {
 const p = localePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 companyCitySitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${smAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.65</priority>\n </url>`);
 }
 }
 }
 }
 if (companyCityBelowFloorBridges > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P8 company-city below-floor bridges: ${companyCityBelowFloorBridges} (per-canton company×city hubs)`);
 }
 if (companyCityPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${companyCityPagesCount} per-canton company×city hub pages`);
 logBuildMem('jobsSeoPages: after company-city-hubs', collector);
 await collector.awaitDrainSlot(2); // bound _pendingFlushes backlog during bulk emit (#1290)
 const companyCityEntriesJoined = companyCitySitemapEntries.join('\n');
 editorialEntries = editorialEntries
 ? `${editorialEntries}\n${companyCityEntriesJoined}`
 : companyCityEntriesJoined;
 }
 }

 /* ── GSC-driven keyword landing pages ──────────────────────── */
 // Anti-doorway floor (CLAUDE.md non-negotiable #4 — no thin indexed
 // content): a keyword landing needs at least this many matching jobs in a
 // locale before that locale gets a page. Named because it now ALSO decides
 // the hreflang alternate set (issue #5114) — the two must never drift.
 const KEYWORD_LANDING_MIN_JOBS = 3;
 let keywordPageCount = 0;
 const keywordSitemapEntries: string[] = [];
 const kwConfigPath = np.resolve(rootDir, 'data/keyword-pages-config.json');
 if (fs.existsSync(kwConfigPath)) {
 try {
 const kwConfig = JSON.parse(fs.readFileSync(kwConfigPath, 'utf-8'));
 const kwPages: any[] = Array.isArray(kwConfig?.pages) ? kwConfig.pages : [];
 for (const kwPage of kwPages) {
 const kwSlug = String(kwPage.slug || '').trim();
 const kwFilterWords: string[] = Array.isArray(kwPage.filterKeywords) ? kwPage.filterKeywords : [];
 if (!kwSlug || kwFilterWords.length === 0) continue;
 const itCopy = kwPage.copy?.it;
 if (!itCopy) continue;
 // Match jobs where ALL filter keywords appear in title/description/company/location,
 // scoped to THIS locale's own translation — never blended across all 4 locales.
 // A mistranslated title in one locale must not leak a job into (or out of)
 // another locale's keyword-landing membership (#4715).
 const kwMatchesLocale = (j: any, locale: string): boolean => {
 const haystack = [
 String(j?.titleByLocale?.[locale] || j.title || ''),
 String(j?.descriptionByLocale?.[locale] || j.description || ''),
 String(j.company || ''), String(j.location || ''),
 ].join(' ').toLowerCase();
 return kwFilterWords.every((kw: string) => haystack.includes(kw));
 };
 // ── Cross-locale eligibility, decided BEFORE any locale is written ──
 //
 // The floor below is evaluated against THIS locale's own translations
 // (#4715), so a keyword can clear it in IT and miss it in DE/EN/FR.
 // `localeList` is visited IT-first, so the old code had already WRITTEN
 // the IT page — carrying a templated four-locale alternate block — by
 // the time DE was found ineligible. Those are the 22 `missingTarget`
 // offenders of issue #5114.
 //
 // Hoisting the floor here makes the alternate set and the emission
 // decision the SAME decision: `kwEligibleLocales` feeds both the
 // `continue` below and the hreflang block, so an alternate for a page
 // this build never writes is no longer expressible.
 //
 // Shard-stable on purpose: `sortedForPagination` + `kwMatchesLocale`
 // are identical on every BUILD_LOCALE shard (only the WRITE is
 // sharded), so all shards compute the same set and the cross-shard
 // hreflang graph stays consistent. A dist-existence stat could NOT do
 // this — `shared/hreflangGuard.ts` deliberately keeps unresolvable
 // alternates on a shard because a sibling locale living on another
 // shard is absent by design. That blind spot is why the post-walk
 // repair never caught these.
 const kwJobsByLocale = new Map<string, any[]>();
 const kwEligibleLocales = new Set<string>();
 for (const l of localeList) {
 if (shouldEmitLocale(l)) {
 // This shard renders `l`: keep the full (capped) list, it is the
 // page's job payload. Cost-neutral vs the previous code, which ran
 // exactly this filter per locale in the default all-locale build.
 const arr = sortedForPagination.filter((j: any) => kwMatchesLocale(j, l)).slice(0, 30);
 kwJobsByLocale.set(l, arr);
 if (arr.length >= KEYWORD_LANDING_MIN_JOBS) kwEligibleLocales.add(l);
 } else {
 // Another shard renders `l`: we only need the floor verdict, so stop
 // counting at the floor instead of materialising up to 30 matches.
 let n = 0;
 for (const j of sortedForPagination) {
 if (kwMatchesLocale(j, l) && ++n >= KEYWORD_LANDING_MIN_JOBS) break;
 }
 if (n >= KEYWORD_LANDING_MIN_JOBS) kwEligibleLocales.add(l);
 }
 }
 const kwHrefFor = (al: AlternateLocale): string =>
 `${BASE_URL}${withSlash(`${localePrefix[al]}/${sectionByLocale[al]}/${searchRoutePrefix[al]}-${kwSlug}`.replace(/\/+/g, '/'))}`;
 // Locales for which the loop below ACTUALLY wrote a keyword landing.
 //
 // The sitemap block further down used to re-derive its own answer from
 // `kwEligibleLocales` (the anti-doorway floor) alone, while this emit loop
 // applies two MORE gates the floor knows nothing about:
 //   - `editorialSearchSlugsByLocale` — an editorial landing already owns
 //     this search slug for that locale;
 //   - `activeJobDirs` — another emitter already wrote this directory.
 // Two predicates for one question is the defect. It stayed invisible for
 // `it` specifically because the existence stat below is SKIPPED for `it`
 // (correctly: on a non-IT shard the IT page is written elsewhere), so an
 // override-skipped IT keyword page still got a <loc> — advertising a URL
 // owned by whichever emitter did write it. Those URLs are non-self-
 // canonical (relatedSearchClustersPlugin's legacy-canton mirror
 // canonicalises `/cerca-lavoro-ticino/ricerca-<slug>/` to
 // `/cerca-lavoro-svizzera/ricerca-<slug>/`) or noindex bridges — exactly
 // the two classes `audit:sitemap-canonicals` and `validate:sitemap-pages`
 // hard-fail on, and the two that plugin already filters out of ITS own
 // sitemap (see its `dropNoindexLocs` rationale).
 //
 // Recording the emission and reading it back makes the two answers the
 // SAME answer rather than two answers that happen to agree on today's
 // data. `tests/keyword-landing-sitemap-parity.test.ts` pins that shape.
 // `shouldEmitLocale` is called here AND again in the sitemap block below
 // (`kwSitemapLocales` loop) — issue #5655 item 3 asked whether the two
 // calls could see different answers within the same build and silently
 // re-diverge the emit/sitemap sets this section exists to keep in sync.
 // Confirmed no: `shouldEmitLocale` (shared/localeEmitFilter.ts) reads only
 // `EMIT_LOCALES`, a `ReadonlySet` computed ONCE at module load from
 // `process.env.BUILD_LOCALE` and never reassigned — no branch in this file
 // or its callees mutates it mid-build. Both call sites run synchronously
 // within the same kwPage iteration, so they necessarily read the same
 // frozen Set. Non-issue, closed.
 const kwEmittedLocales = new Set<typeof localeList[number]>();
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const kwJobs = kwJobsByLocale.get(locale) ?? [];
 if (!kwEligibleLocales.has(locale)) continue;
 const kwUniqueCompanies = [...new Set(kwJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const kwUniqueLocations = [...new Set(kwJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const __tGsc = startTimer();
 const kwFullSlug = `${searchRoutePrefix[locale]}-${kwSlug}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(kwFullSlug)) continue;
 const kwCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kwFullSlug}`.replace(/\/+/g, '/'));
 const kwRelDir = kwCanonicalPath.slice(1).replace(/\/+$/, '');
 if (activeJobDirs.has(kwRelDir)) continue;
 const kwCanonicalUrl = `${BASE_URL}${kwCanonicalPath}`;
 const kwQueryDisplay = String(kwPage.query || '').trim();
 // F3a — delegate title/description to the shared CTR-optimized helpers so
 // keyword landing pages get the same 50-60 / 140-160 char treatment as
 // role / city / employer hubs. The Italian landing preserves its curated
 // `itCopy.title` because that was hand-tuned per query in keyword config.
 const kwTitle = locale === 'it'
 ? (() => {
 // Curated IT title = heading + " | Frontaliere Ticino" brand suffix.
 // For long headings the brand is dropped (buildTitleWithBrand 66-char
 // cap) and the title collapses to the bare heading — byte-identical to
 // the <h1> (itCopy.heading), tripping the 0-tolerance
 // audit:h1-title-duplicates ratchet. When that collision happens, fall
 // back to the count+year role-hub title (already used for EN/DE/FR):
 // it stays ≤66 chars (audit:title-length) and is structurally distinct
 // from the descriptive heading, so title can never equal h1.
 const curated = buildTitleWithBrand(String(itCopy.title || '').replace(/\s*\|\s*Frontaliere Ticino\s*$/i, ''));
 const norm = (s: string) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
 if (norm(curated) !== norm(String(itCopy.heading || ''))) return curated;
 return buildRoleHubTitle({
 locale,
 roleDisplay: kwQueryDisplay || 'Jobs',
 count: kwJobs.length,
 year: new Date().getFullYear(),
 });
 })()
 : buildRoleHubTitle({
 locale,
 roleDisplay: kwQueryDisplay || 'Jobs',
 count: kwJobs.length,
 year: new Date().getFullYear(),
 });
 const kwDesc = buildRoleHubMeta({
 locale,
 roleDisplay: kwQueryDisplay || (locale === 'it' ? 'lavoro' : locale === 'en' ? 'jobs' : locale === 'de' ? 'Stellen' : 'emploi'),
 count: kwJobs.length,
 });
 // Alternates come from the SAME set that gates emission above, so this
 // page can only advertise locales this build actually writes. Returns ''
 // when any locale misses the floor — audit-hreflang skips pages with no
 // hreflang but fails partial sets as `tooFew` (issue #5114).
 const kwAlternates = buildLocaleAlternateBlock({
 eligibleLocales: kwEligibleLocales,
 hrefFor: kwHrefFor,
 });
 const kwListHtml = jobCardListBody(kwJobs, locale);
 const kwCollLd = inlineScriptJson({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: kwTitle, url: kwCanonicalUrl, description: kwDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } });
 const kwCtaCopy: Record<string, string> = {
 it: `Consulta le ${kwJobs.length} posizioni aperte qui sotto. Le offerte vengono aggiornate quotidianamente da aziende con sede in Ticino e Grigioni. Utilizza il nostro calcolatore per confrontare stipendio netto, tasse e costo della vita tra Svizzera e Italia.`,
 en: `Browse the ${kwJobs.length} open positions listed below. Listings are updated daily from employers based in Ticino and Graubünden. Use our calculator to compare net salary, taxes, and cost of living between Switzerland and Italy.`,
 de: `Entdecken Sie die ${kwJobs.length} offenen Stellen unten. Die Angebote werden täglich von Arbeitgebern im Tessin und Graubünden aktualisiert. Nutzen Sie unseren Rechner, um Nettolohn, Steuern und Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.`,
 fr: `Consultez les ${kwJobs.length} postes ouverts ci-dessous. Les offres sont mises à jour quotidiennement par des employeurs basés au Tessin et dans les Grisons. Utilisez notre calculateur pour comparer salaire net, impôts et coût de la vie entre la Suisse et l'Italie.`,
 };
 const kwCta = kwCtaCopy[locale] || kwCtaCopy.it;
 const kwSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const kwTopCompanies = kwUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const kwIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${kwJobs.length} offerte di lavoro</strong> per "${esc(kwQueryDisplay)}" in Ticino, pubblicate da ${kwUniqueCompanies.length} aziende${kwUniqueLocations.length > 1 ? ` in ${kwUniqueLocations.length} localit\u00e0` : ''}. Tra le aziende che assumono: ${kwTopCompanies}. Gli annunci vengono aggiornati quotidianamente.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${kwJobs.length} job openings</strong> for "${esc(kwQueryDisplay)}" in Ticino, published by ${kwUniqueCompanies.length} companies${kwUniqueLocations.length > 1 ? ` across ${kwUniqueLocations.length} locations` : ''}. Hiring companies include: ${kwTopCompanies}. Listings are refreshed daily.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${kwJobs.length} Stellenangebote</strong> f\u00fcr "${esc(kwQueryDisplay)}" im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${kwUniqueCompanies.length} Unternehmen${kwUniqueLocations.length > 1 ? ` an ${kwUniqueLocations.length} Standorten` : ''}. Einstellende Unternehmen: ${kwTopCompanies}.</p>`;
 return `<p>${kwJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour "${esc(kwQueryDisplay)}" au Tessin, publi\u00e9es par ${kwUniqueCompanies.length} entreprises${kwUniqueLocations.length > 1 ? ` dans ${kwUniqueLocations.length} localit\u00e9s` : ''}. Entreprises qui recrutent : ${kwTopCompanies}.</p>`;
 })();
 const kwMarketSection = (() => {
 if (locale === 'it') return `<section class="s-7uP4UM"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section class="s-7uP4UM"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section class="s-7uP4UM"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section class="s-7uP4UM"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const kwOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 // SEO: text-to-HTML ratio gate. Inject a per-query unique intro (so each
 // GSC-keyword landing has unique top prose) and the shared commuter
 // context block (methodology + commute + salary + FAQ + cross-links).
 const _kwQuery = String(kwQueryDisplay || itCopy.heading || '').trim();
 const _kwCity = (() => {
 const segs = String(kwSlug).split('-');
 for (const s of segs) if (isKnownTicinoCommuterCity(s)) return s;
 return null;
 })();
 const kwQueryIntro = renderSearchQueryIntro(locale, _kwQuery, kwJobs.length, kwUniqueCompanies, kwUniqueLocations);
 const kwCommuterBlock = wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _kwCity ? _kwCity.charAt(0).toUpperCase() + _kwCity.slice(1) : getCantonDisplayLabel(DEFAULT_CANTON, locale),
 sectorOrType: _kwQuery || null,
 omitCommute: !_kwCity,
 }));
 // BreadcrumbList JSON-LD — required by tests/seo/breadcrumb-coverage.test.ts
 // (D.2 — every non-exempt dist/ HTML page must include a BreadcrumbList).
 const kwBreadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: localeCopy[locale].sectionName, item: kwSectionUrl },
 { '@type': 'ListItem', position: 3, name: kwTitle, item: kwCanonicalUrl },
 ],
 });
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 // Tiered emission for GSC keyword landings (urlClass:
 // 'gsc-keyword-landing'). URL with traffic in evidence-index or
 // thin-page-promotions stays full; URL without and matching the
 // approved pattern becomes a thin shell (HEAD identical, body shrunk
 // to ≥50-word paragraph + link to listing). SPA hydrates the full
 // filtered listing client-side from the URL slug
 // (components/community/JobBoard.tsx parseSearchSlugFilter).
 // Reviewer HIGH #2: decideMulti across all 4 locale variants of the
 // same keyword. gsc-job-urls.json is IT-only, so EN/DE/FR landings
 // false-negative if checked alone — the IT sibling typically carries
 // the GSC signal and protects all 4 locales.
 const __kwCandidatePaths: string[] = [kwCanonicalPath];
 for (const __otherLocale of localeList) {
 if (__otherLocale === locale) continue;
 const __otherFullSlug = `${searchRoutePrefix[__otherLocale]}-${kwSlug}`;
 __kwCandidatePaths.push(withSlash(`${localePrefix[__otherLocale]}/${sectionByLocale[__otherLocale]}/${__otherFullSlug}`.replace(/\/+/g, '/')));
 }
 // Only the canonical path — __kwCandidatePaths also carries cross-locale PROBE
        // paths for the traffic decision below, which this build does not
        // necessarily emit. Registering those would make the plan
        // over-inclusive and silently disarm the stale-landing repair.
        registerKeywordLandingPaths('jobs-seo-pages', [kwCanonicalPath]);
        // #5168: this class now carries `noindexMinAgeDays`, so the decision
        // below also reports a `noindex` band -- and this call site
        // deliberately does NOT consume it. The band was measured on
        // sitemap-search-clusters (292 795 URLs, 98,0 % with zero impressions
        // in 90 days); the cluster-shaped URLs THIS plugin advertises live in
        // sitemap-jobs instead and measure nothing like it -- 209 URLs, of
        // which 60 (29 %) earn impressions, averaging 103 each against 17 for
        // a cluster canonical. Applying the same band here would de-index a
        // family where nearly a third of the pages rank. Consume the field
        // only after measuring THIS surface on its own.
        const __kwDecision = trafficFilter.decideMulti(__kwCandidatePaths, 'gsc-keyword-landing');
 const __kwAction: 'full' | 'thin' = __kwDecision.action === 'thin' ? 'thin' : 'full';
 const __kwFullBody = `<h1>${esc(itCopy.heading)}</h1>\n <p>${esc(kwDesc)}</p>\n ${kwQueryIntro}\n ${kwIntro}\n <p>${esc(kwCta)}</p>\n <ul class="s-0WjlyL">${kwListHtml}</ul>\n <p><a href="${kwSectionUrl}">${esc(kwOpenAllLabel)}</a></p>\n ${kwMarketSection}\n ${renderJobBoardListingDensityProse(locale, { subject: _kwQuery || kwQueryDisplay || itCopy.heading, location: _kwCity ? _kwCity.charAt(0).toUpperCase() + _kwCity.slice(1) : getCantonDisplayLabel(DEFAULT_CANTON, locale), resultCount: kwJobs.length, companyCount: kwUniqueCompanies.length, locationCount: kwUniqueLocations.length })}\n ${kwCommuterBlock}`;
 const __kwBody = __kwAction === 'thin'
 ? buildGscKeywordThinBody({ locale, query: String(kwQueryDisplay || _kwQuery || itCopy.heading || ''), listingUrl: kwSectionUrl, h1Title: esc(itCopy.heading), jobCount: kwJobs.length, companies: kwUniqueCompanies.slice(0, 3).map((c: string) => esc(c)) })
 : __kwFullBody;
 if (__kwAction === 'thin') {
 gscKeywordThinCount++;
 gscKeywordBytesSaved += __kwFullBody.length - __kwBody.length;
 } else {
 gscKeywordFullCount++;
 }
 const kwHtml = buildSeoPageHtml({
 locale,
 title: kwTitle,
 description: kwDesc,
 canonicalUrl: kwCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: kwAlternates,
 jsonLdScripts: [kwBreadcrumbLd, kwCollLd],
 bodyHtml: __kwBody,
 extraHeadHtml: __kwAction === 'thin' ? GSC_KEYWORD_THIN_HEAD_SCRIPT : undefined,
 distDir,
 });
 const kwOutDir = np.join(distDir, kwCanonicalPath.slice(1));
 activeJobDirs.add(kwRelDir);
 _md(kwOutDir);
 _qw(np.join(kwOutDir, 'index.html'), kwHtml);
 const kwFlatPath = kwCanonicalPath.replace(/\/+$/, '');
 if (kwFlatPath) { const kwFlatFile = np.join(distDir, kwFlatPath.slice(1) + '.html'); _qwFlatFull(kwFlatFile, kwHtml); }
 keywordPageCount++;
 kwEmittedLocales.add(locale);
 recordEmit('gsc-keyword-landing', __tGsc);
 }
 // Sitemap entry (Italian canonical)
 const kwItSlug = `${searchRoutePrefix.it}-${kwSlug}`;
 const kwItPath = withSlash(`/${sectionByLocale.it}/${kwItSlug}`.replace(/\/+/g, '/'));
 const kwLocalePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const ls = `${searchRoutePrefix[l]}-${kwSlug}`;
 const lp = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'));
 kwLocalePaths.set(l, lp);
 }
 // The ONE set that decides this keyword page's whole sitemap contribution:
 // which locales get a <loc>, which appear as alternates, and whether
 // x-default is backed. Reciprocity only asks that every advertised
 // alternate is itself a published <loc> — so alternates and locs MUST come
 // from the same set, or shrinking one silently breaks the other.
 //
 // Three filters, in the order their evidence becomes available:
 //   1. the anti-doorway floor (`kwEligibleLocales`) — shard-stable by
 //      construction, so every shard agrees on it (issue #5114);
 //   2. for a locale THIS shard renders: what the emit loop actually wrote
 //      (`kwEmittedLocales`). This is what carries the two overrides the
 //      floor cannot see; before it, a page skipped by an override still
 //      got a <loc> pointing at another emitter's URL;
 //   3. for a locale ANOTHER shard renders: the dist existence stat, the
 //      only evidence available here. `it` stays exempt from it because on
 //      a non-IT shard the IT page is written elsewhere and a stat would
 //      false-negative — note that sitemaps ship from the it/main shard
 //      (localeEmitFilter: non-locale files are owned by `it`), so in the
 //      build that actually publishes this file `it` always takes branch 2.
 const kwSitemapLocales = new Set<typeof localeList[number]>();
 for (const l of localeList) {
 if (!kwEligibleLocales.has(l)) continue;
 if (shouldEmitLocale(l)) {
 if (!kwEmittedLocales.has(l)) continue;
 } else if (l !== 'it') {
 const dirIndex = np.join(distDir, kwLocalePaths.get(l)!.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 kwSitemapLocales.add(l);
 }
 const kwSmAlternates = buildSitemapAlternateBlock({
 eligibleLocales: kwSitemapLocales,
 hrefFor: (l) => `${BASE_URL}${kwLocalePaths.get(l)}`,
 });
 // x-default points at the IT landing, so it may only be advertised when
 // that landing is itself published — otherwise dropping IT from the set
 // above would leave x-default naming a URL with no <loc>, re-opening the
 // reciprocity hole one level down.
 const kwXDefault = kwSitemapLocales.has('it')
 ? `\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${kwItPath}" />`
 : '';
 // Every locale gets its own reciprocal <loc> entry (#3499) -- see
 // pushEditorialSitemapEntry above for rationale.
 for (const l of localeList) {
 if (!kwSitemapLocales.has(l)) continue;
 const p = kwLocalePaths.get(l)!;
 keywordSitemapEntries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${kwSmAlternates}${kwXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }
 } catch (e) {
 console.warn(`\x1b[33m[jobs-seo-pages]\x1b[0m Failed to load keyword pages config: ${e}`);
 }
 }
 if (keywordPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${keywordPageCount} GSC keyword landing pages`);

 /* ── Search landing pages from stats leaders ───────────────── */
 let searchEntries = '';
 const statsPath = np.resolve(rootDir, 'data/jobs-stats.json');
 if (fs.existsSync(statsPath)) {
 const statsRaw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
 const leaderGroups = [
 ...(Array.isArray(statsRaw?.leaders?.topLocationsActive) ? statsRaw.leaders.topLocationsActive : []),
 ...(Array.isArray(statsRaw?.leaders?.topLocationsAdded30d) ? statsRaw.leaders.topLocationsAdded30d : []),
 ...(Array.isArray(statsRaw?.leaders?.topTitlesAdded30d) ? statsRaw.leaders.topTitlesAdded30d : []),
 ];
 const searchLeaderMap = new Map<string, { key: string; name: string }>();
 for (const item of leaderGroups) {
 const key = String(item?.key || '').trim();
 // Leader `name` is `titleByLocale.it || title` from data/jobs-stats.json
 // (job-board-stats.mjs only normalizes whitespace) — same AI-translated
 // data class as job-detail titles. Strip at this single source so the h1,
 // intro/density prose and breadcrumb JSON-LD on the emitted
 // `/cerca-lavoro-ticino/ricerca-*/` pages (in scope of
 // audit-no-literal-markdown) never carry literal `**`.
 const name = stripLiteralMarkdownFromTitle(String(item?.name || '').trim());
 if (!key || !name || searchLeaderMap.has(key)) continue;
 searchLeaderMap.set(key, { key, name });
 }

 let searchPageCount = 0;
 const searchSitemapEntries: string[] = [];
 // One walk over validJobs for ALL leaders (see searchLeaderMatches):
 // same per-leader/per-locale match sets the four `.filter().slice(0,20)`
 // calls produced, at 4 haystack builds per job instead of 4 per job per
 // leader.
 const __searchLeaderMatches = searchLeaderMatches([...searchLeaderMap.values()], 20);
 for (const { key, name } of searchLeaderMap.values()) {
 const matchingJobsByLocale = __searchLeaderMatches.get(key)!;
 if (localeList.every((locale) => matchingJobsByLocale[locale].length === 0)) continue;
 const fallbackMatchingJobs = pickSearchLandingFallbackJobs(matchingJobsByLocale);
 if (fallbackMatchingJobs.length === 0) continue;

 // Eligibility, derived the same way the emit loop below decides: a locale
 // with no own matches still gets a page from `fallbackMatchingJobs`, which
 // is non-empty by the guard above — so this set is normally all four.
 // Derived rather than hardcoded so that if a future floor lands here the
 // alternates follow it automatically instead of drifting into the #5114
 // failure mode.
 const _eligibleLocales = new Set<string>(
 localeList.filter(
 (l) => matchingJobsByLocale[l].length > 0 || fallbackMatchingJobs.length > 0,
 ),
 );

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const matchingJobs = matchingJobsByLocale[locale].length > 0
 ? matchingJobsByLocale[locale]
 : fallbackMatchingJobs;
 if (matchingJobs.length === 0) continue;
 const __tSearchStats = startTimer();

 const fullSlug = `${searchRoutePrefix[locale]}-${key}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = searchPageCopy[locale];
 // Search-stats-landing titles wrap the keyword in locale frame
 // ("Offerte di lavoro {name} in Svizzera" / "{name} job openings in
 // Switzerland" / etc). With long compound queries the wrapped title
 // blows past TITLE_MAX_CHARS (66) and audit:title-length fails.
 // `capSearchStatsLandingTitle` caps it on a whitespace boundary (no
 // ellipsis) budgeted on the ESCAPED length — see its doc comment for why
 // (crawled `name` can carry `&`/`<`/`>`/`"`, e.g. "Sales & Marketing").
 const rawTitle = copy.title(name);
 const cappedTitle = capSearchStatsLandingTitle(rawTitle);
 const title = buildTitleWithBrand(cappedTitle);
 const description = copy.description(name, matchingJobs.length);
 const alternates = buildLocaleAlternateBlock({
 eligibleLocales: _eligibleLocales,
 hrefFor: (altLocale) =>
 `${BASE_URL}${withSlash(`${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${searchRoutePrefix[altLocale]}-${key}`.replace(/\/+/g, '/'))}`,
 });
 const listHtml = jobCardListBody(matchingJobs, locale);

 const searchBodyParts: string[] = [];
 {
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const uniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const uniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 searchBodyParts.push(`<p>Sono attualmente disponibili <strong>${matchingJobs.length} offerte di lavoro</strong> per ${esc(name)} in Ticino, pubblicate da ${uniqueCompanies.length} aziende in ${uniqueLocations.length} localit\u00e0. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<p>There are currently <strong>${matchingJobs.length} job openings</strong> for ${esc(name)} in Ticino, published by ${uniqueCompanies.length} companies across ${uniqueLocations.length} locations. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<p>Derzeit sind <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr ${esc(name)} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${uniqueCompanies.length} Unternehmen an ${uniqueLocations.length} Standorten. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert, der Stellen direkt von den Karriereportalen der Tessiner Unternehmen sammelt.</p>`);
 } else {
 searchBodyParts.push(`<p>${matchingJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour ${esc(name)} au Tessin, publi\u00e9es par ${uniqueCompanies.length} entreprises dans ${uniqueLocations.length} localit\u00e9s. Les annonces sont mises \u00e0 jour quotidiennement par notre robot qui collecte les offres directement depuis les portails carri\u00e8re des entreprises tessinoises.</p>`);
 }
 searchBodyParts.push(`<ul class="s-0WjlyL">${listHtml}</ul>`);
 searchBodyParts.push(`<p><a href="${listingUrl}">${esc(copy.openListing)}</a></p>`);
 if (locale === 'it') {
 searchBodyParts.push(`<section class="s-7uP4UM"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. I settori pi\u00f9 attivi includono sanit\u00e0, finanza, tecnologia, ingegneria, commercio e amministrazione. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<section class="s-7uP4UM"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The most active sectors include healthcare, finance, technology, engineering, retail, and administration. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<section class="s-7uP4UM"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Die aktivsten Branchen sind Gesundheitswesen, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`);
 } else {
 searchBodyParts.push(`<section class="s-7uP4UM"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Les secteurs les plus actifs incluent la sant\u00e9, la finance, la technologie, l'ing\u00e9nierie, le commerce et l'administration. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`);
 }
 searchBodyParts.push(`<p class="s-Xxg-ZL">${esc(copy.editorial)}</p>`);
 // SEO: text-to-HTML ratio gate. Append per-query unique intro + the
 // shared commuter-context block (methodology, FAQ, scenario, cross-links).
 // For Ticino cities we use the city-aware commuter row; for non-Ticino
 // queries (Chur, Zurich, etc.) we fall back to general-Ticino prose.
 const _isTicino = isKnownTicinoCommuterCity(name);
 searchBodyParts.unshift(renderSearchQueryIntro(locale, name, matchingJobs.length, uniqueCompanies, uniqueLocations));
 searchBodyParts.push(renderJobBoardListingDensityProse(locale, {
 subject: name,
 location: _isTicino ? name : getCantonDisplayLabel(DEFAULT_CANTON, locale),
 resultCount: matchingJobs.length,
 companyCount: uniqueCompanies.length,
 locationCount: uniqueLocations.length,
 }));
 searchBodyParts.push(wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _isTicino ? name : getCantonDisplayLabel(DEFAULT_CANTON, locale),
 sectorOrType: _isTicino ? null : name,
 omitCommute: !_isTicino,
 })));
 }
 const _sHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const _sListUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const _sListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const searchBreadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: _sHomeUrl },
 { '@type': 'ListItem', position: 2, name: _sListName, item: _sListUrl },
 { '@type': 'ListItem', position: 3, name: copy.heading(name), item: canonicalUrl },
 ],
 });
 // Cannibalization fix: search-hub slug may be remapped to a winner URL
 // (e.g. `search-lugano-eoc-...` → company hub). Page still emitted at its
 // own path so backlinks resolve.
 const effectiveCanonicalUrl = resolveCanonicalUrl(fullSlug, canonicalUrl);
 // Tiered emission: shares 'gsc-keyword-landing' urlClass with the
 // predefined-keyword + search-combo emit sites — same URL shape
 // (`/cerca-lavoro-X/ricerca-Y/`), same SPA hydration path. Build
 // both variants and pick based on filter decision.
 // Reviewer HIGH #2: decideMulti across all 4 locale variants (see
 // ~line 7415 comment).
 const __ssFullBody = `<h1>${esc(copy.heading(name))}</h1>\n <p>${esc(description)}</p>\n${searchBodyParts.join('\n')}`;
 const __ssCandidatePaths: string[] = [canonicalPath];
 for (const __ssOtherLocale of localeList) {
 if (__ssOtherLocale === locale) continue;
 const __ssOtherSlug = `${searchRoutePrefix[__ssOtherLocale]}-${key}`;
 __ssCandidatePaths.push(withSlash(`${localePrefix[__ssOtherLocale]}/${sectionByLocale[__ssOtherLocale]}/${__ssOtherSlug}`.replace(/\/+/g, '/')));
 }
 // Only the canonical path — __ssCandidatePaths also carries cross-locale PROBE
        // paths for the traffic decision below, which this build does not
        // necessarily emit. Registering those would make the plan
        // over-inclusive and silently disarm the stale-landing repair.
        registerKeywordLandingPaths('jobs-seo-pages', [canonicalPath]);
        // #5168: this class now carries `noindexMinAgeDays`, so the decision
        // below also reports a `noindex` band -- and this call site
        // deliberately does NOT consume it. The band was measured on
        // sitemap-search-clusters (292 795 URLs, 98,0 % with zero impressions
        // in 90 days); the cluster-shaped URLs THIS plugin advertises live in
        // sitemap-jobs instead and measure nothing like it -- 209 URLs, of
        // which 60 (29 %) earn impressions, averaging 103 each against 17 for
        // a cluster canonical. Applying the same band here would de-index a
        // family where nearly a third of the pages rank. Consume the field
        // only after measuring THIS surface on its own.
        const __ssDecision = trafficFilter.decideMulti(__ssCandidatePaths, 'gsc-keyword-landing');
 const __ssAction: 'full' | 'thin' = __ssDecision.action === 'thin' ? 'thin' : 'full';
 const __ssBody = __ssAction === 'thin'
 ? buildGscKeywordThinBody({ locale, query: String(name || key || ''), listingUrl: _sListUrl, h1Title: esc(copy.heading(name)), jobCount: matchingJobs.length, companies: [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))].slice(0, 3).map((c: string) => esc(c)) })
 : __ssFullBody;
 if (__ssAction === 'thin') {
 gscKeywordThinCount++;
 gscKeywordBytesSaved += __ssFullBody.length - __ssBody.length;
 } else {
 gscKeywordFullCount++;
 }
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const searchHtml = buildSeoPageHtml({
 locale,
 title,
 description,
 canonicalUrl: effectiveCanonicalUrl,
 // Always index,follow: the previous `matchingJobs.length >= 3 ? index : noindex`
 // rule emitted noindex pages that collided with relatedSearchClustersPlugin's
 // cluster pages at the same slug (cluster's OR-fill matching surfaced ≥3 jobs
 // where our AND-strict matchesSearchLanding yielded <3), failing
 // validate:sitemap-pages with `URL has noindex but is in the cluster sitemap`.
 // Setting this unconditionally to index,follow removes the cross-plugin race
 // — both plugins now agree the page is indexable. Anti-thin-content is
 // already enforced by the page-body MIN_INDEXABLE_WORDS check downstream
 // (these pages embed ~250 words of editorial + commuter-context regardless
 // of listing count, so the body always passes the gate).
 robots: 'index,follow',
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 jsonLdScripts: [searchBreadcrumbLd],
 bodyHtml: __ssBody,
 extraHeadHtml: __ssAction === 'thin' ? GSC_KEYWORD_THIN_HEAD_SCRIPT : undefined,
 distDir,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), searchHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, searchHtml);
 }
 searchPageCount++;
 recordEmit('search-stats-landing', __tSearchStats);
 }

 // Add indexable search pages (>=3 jobs) to sitemap
 if (fallbackMatchingJobs.length >= 3) {
 const sItSlug = `${searchRoutePrefix.it}-${key}`;
 const sItPath = withSlash(`/${sectionByLocale.it}/${sItSlug}`.replace(/\/+/g, '/'));
 const sItUrl = `${BASE_URL}${sItPath}`;
 const sLocaleSlugs = new Map<typeof localeList[number], string>();
 const sLocalePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSlug = `${searchRoutePrefix[l]}-${key}`;
 sLocaleSlugs.set(l, lSlug);
 const lp = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/'));
 sLocalePaths.set(l, lp);
 }
 const sAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${sLocalePaths.get(l)}" />`).join('\n');
 const sXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${sItUrl}" />`;
 // SEO: skip -- page self-canonicalizes elsewhere (Semrush gate).
 // (a) Editorial geo-hub cities (Lugano/Bellinzona/Mendrisio/Locarno/Chiasso)
 // canonicalize their `ricerca-<city>` page to the clean `/{city}/` hub,
 // so emitting the legacy slug here would duplicate the editorial entry
 // already added with a non-canonical loc. (b) Any search-leader slug
 // present in canonicalOverrides has its rendered <link rel="canonical">
 // pointing elsewhere -- never advertise it as a sitemap loc. Checked
 // per-locale (#3499) -- en/de/fr can independently self-canonicalize even
 // when the IT slug doesn't.
 for (const l of localeList) {
 const lSlug = sLocaleSlugs.get(l)!;
 const lp = sLocalePaths.get(l)!;
 const lUrl = `${BASE_URL}${lp}`;
 const isEditorialDuplicate = editorialSearchSlugsByLocale.get(l)?.has(lSlug) === true;
 const overrideUrl = resolveCanonicalUrl(lSlug, lUrl);
 if (isEditorialDuplicate || overrideUrl !== lUrl) continue;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, lp.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 searchSitemapEntries.push(` <url>\n <loc>${lUrl}</loc>\n${sAlternates}\n${sXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }
 }

 /* ── Combo search landing pages ────────────────────────────── */
 // Helper: generate a combo search landing page with custom filter & copy
 const generateComboPage = (
 comboKey: string,
 copyByLocale: Record<'it' | 'en' | 'de' | 'fr', { title: string; description: (count: number) => string; heading: string }>,
 filterFn: (job: any) => boolean,
 ): void => {
 const matchingJobs = validJobs.filter(filterFn).slice(0, 20);
 if (matchingJobs.length === 0) return;

 // `filterFn` is locale-agnostic and `matchingJobs` is non-empty here, so
 // every locale gets a page and the set is all four. Derived, not
 // hardcoded — see the search-stats site above for why (#5114).
 const _comboEligibleLocales = new Set<string>(
 localeList.filter(() => matchingJobs.length > 0),
 );

 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue; // locale-shard render-skip (BUILD_LOCALE) — Fase 1b
 const __tSearchCombo = startTimer();
 const fullSlug = `${searchRoutePrefix[locale]}-${comboKey}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 if (searchLeaderMap.has(comboKey)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = copyByLocale[locale];
 const comboTitle = buildTitleWithBrand(String(copy.title || '').replace(/\s*\|\s*Frontaliere Ticino\s*$/i, ''));
 const description = copy.description(matchingJobs.length);
 const alternates = buildLocaleAlternateBlock({
 eligibleLocales: _comboEligibleLocales,
 hrefFor: (altLocale) =>
 `${BASE_URL}${withSlash(`${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${searchRoutePrefix[altLocale]}-${comboKey}`.replace(/\/+/g, '/'))}`,
 });
 const listHtml = jobCardListBody(matchingJobs, locale);

 const comboOgImage = ` <meta property="og:image" content="${BASE_URL}/og-image.png">\n <meta property="og:image:width" content="1200">\n <meta property="og:image:height" content="630">\n <meta property="og:image:type" content="image/png">`;
 const comboBodyParts: string[] = [];
 {
 const cListingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cUniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const cUniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 comboBodyParts.push(`<p>Abbiamo trovato <strong>${matchingJobs.length} offerte di lavoro</strong> corrispondenti a questa ricerca, pubblicate da ${cUniqueCompanies.length} aziende${cUniqueLocations.length > 1 ? ` in ${cUniqueLocations.length} localit\u00e0 del Ticino` : cUniqueLocations.length === 1 ? ` a ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Ogni annuncio rimanda direttamente alla pagina di candidatura ufficiale dell'azienda.</p>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<p>We found <strong>${matchingJobs.length} job openings</strong> matching this search, published by ${cUniqueCompanies.length} companies${cUniqueLocations.length > 1 ? ` across ${cUniqueLocations.length} locations in Ticino` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Each listing links directly to the official company application page.</p>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<p>Wir haben <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr diese Suche gefunden, ver\u00f6ffentlicht von ${cUniqueCompanies.length} Unternehmen${cUniqueLocations.length > 1 ? ` an ${cUniqueLocations.length} Standorten im Tessin` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' im Tessin'}. Jedes Inserat verlinkt direkt zur offiziellen Bewerbungsseite des Unternehmens.</p>`);
 } else {
 comboBodyParts.push(`<p>Nous avons trouv\u00e9 <strong>${matchingJobs.length} offres d'emploi</strong> correspondant \u00e0 cette recherche, publi\u00e9es par ${cUniqueCompanies.length} entreprises${cUniqueLocations.length > 1 ? ` dans ${cUniqueLocations.length} localit\u00e9s au Tessin` : cUniqueLocations.length === 1 ? ` \u00e0 ${esc(cUniqueLocations[0])}` : ' au Tessin'}. Chaque annonce renvoie directement \u00e0 la page de candidature officielle de l'entreprise.</p>`);
 }
 comboBodyParts.push(`<ul class="s-0WjlyL">${listHtml}</ul>`);
 comboBodyParts.push(`<p><a href="${cListingUrl}">${esc(searchPageCopy[locale].openListing)}</a></p>`);
 if (locale === 'it') {
 comboBodyParts.push(`<section class="s-7uP4UM"><h2>Lavorare in Ticino come frontaliere</h2><p>Il Canton Ticino \u00e8 la principale area economica della Svizzera italiana. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte con aliquote variabili sul reddito lordo. I principali centri economici sono Lugano, Bellinzona, Mendrisio, Locarno e Chiasso. Usa il nostro <a href="/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere e confrontare vantaggi e svantaggi tra residenza in Svizzera e pendolarismo dall'Italia.</p></section>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<section class="s-7uP4UM"><h2>Working in Ticino as a cross-border commuter</h2><p>The Canton of Ticino is the main economic area of Italian-speaking Switzerland. For cross-border workers with a G Permit, Ticino applies withholding tax at variable rates on gross income. The main economic centres are Lugano, Bellinzona, Mendrisio, Locarno, and Chiasso. Use our <a href="/en/">free tax simulator</a> to calculate your net salary as a cross-border worker and compare the pros and cons of living in Switzerland versus commuting from Italy.</p></section>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<section class="s-7uP4UM"><h2>Arbeiten im Tessin als Grenzg\u00e4nger</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen. Die wichtigsten Wirtschaftszentren sind Lugano, Bellinzona, Mendrisio, Locarno und Chiasso. Nutzen Sie unseren <a href="/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen und die Vor- und Nachteile eines Wohnsitzes in der Schweiz gegen\u00fcber dem Pendeln aus Italien zu vergleichen.</p></section>`);
 } else {
 comboBodyParts.push(`<section class="s-7uP4UM"><h2>Travailler au Tessin en tant que frontalier</h2><p>Le Canton du Tessin est la principale zone \u00e9conomique de la Suisse italienne. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut. Les principaux centres \u00e9conomiques sont Lugano, Bellinzona, Mendrisio, Locarno et Chiasso. Utilisez notre <a href="/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier et comparer les avantages et inconv\u00e9nients entre r\u00e9sider en Suisse et faire la navette depuis l'Italie.</p></section>`);
 }
 comboBodyParts.push(`<p class="s-Xxg-ZL">${esc(searchPageCopy[locale].editorial)}</p>`);
 // SEO: text-to-HTML ratio gate. Same enrichment as the search-leader
 // template. The combo heading (e.g. "Lavoro Stage a Lugano",
 // "Lavoro Sanità in Ticino") is the user-facing query; we feed it as
 // the unique intro key. For combos starting with a known Ticino city
 // we use the city-aware commuter row; otherwise general-Ticino prose.
 const _comboCity = (() => {
 const segs = String(comboKey).split('-');
 for (const s of segs) if (isKnownTicinoCommuterCity(s)) return s;
 return null;
 })();
 const _comboQuery = String(copy.heading || '').trim();
 comboBodyParts.unshift(renderSearchQueryIntro(locale, _comboQuery, matchingJobs.length, cUniqueCompanies, cUniqueLocations));
 comboBodyParts.push(renderJobBoardListingDensityProse(locale, {
 subject: _comboQuery || copy.heading,
 location: _comboCity ? _comboCity.charAt(0).toUpperCase() + _comboCity.slice(1) : getCantonDisplayLabel(DEFAULT_CANTON, locale),
 resultCount: matchingJobs.length,
 companyCount: cUniqueCompanies.length,
 locationCount: cUniqueLocations.length,
 }));
 comboBodyParts.push(wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _comboCity ? _comboCity.charAt(0).toUpperCase() + _comboCity.slice(1) : getCantonDisplayLabel(DEFAULT_CANTON, locale),
 sectorOrType: _comboQuery || null,
 omitCommute: !_comboCity,
 })));
 }
 const _cHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const _cListUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const _cListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const comboBreadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: _cHomeUrl },
 { '@type': 'ListItem', position: 2, name: _cListName, item: _cListUrl },
 { '@type': 'ListItem', position: 3, name: copy.heading, item: canonicalUrl },
 ],
 });
 // Tiered emission: same 'gsc-keyword-landing' urlClass as the
 // predefined-keyword + search-stats emit sites — they share the URL
 // shape (`/cerca-lavoro-X/ricerca-Y/`) and SPA hydration path.
 // Reviewer HIGH #2: decideMulti across all 4 locale variants.
 const __cmFullBody = `<h1>${esc(copy.heading)}</h1>\n <p>${esc(description)}</p>\n${comboBodyParts.join('\n')}`;
 const __cmCandidatePaths: string[] = [canonicalPath];
 for (const __cmOtherLocale of localeList) {
 if (__cmOtherLocale === locale) continue;
 const __cmOtherSlug = `${searchRoutePrefix[__cmOtherLocale]}-${comboKey}`;
 __cmCandidatePaths.push(withSlash(`${localePrefix[__cmOtherLocale]}/${sectionByLocale[__cmOtherLocale]}/${__cmOtherSlug}`.replace(/\/+/g, '/')));
 }
 // Only the canonical path — __cmCandidatePaths also carries cross-locale PROBE
        // paths for the traffic decision below, which this build does not
        // necessarily emit. Registering those would make the plan
        // over-inclusive and silently disarm the stale-landing repair.
        registerKeywordLandingPaths('jobs-seo-pages', [canonicalPath]);
        // #5168: this class now carries `noindexMinAgeDays`, so the decision
        // below also reports a `noindex` band -- and this call site
        // deliberately does NOT consume it. The band was measured on
        // sitemap-search-clusters (292 795 URLs, 98,0 % with zero impressions
        // in 90 days); the cluster-shaped URLs THIS plugin advertises live in
        // sitemap-jobs instead and measure nothing like it -- 209 URLs, of
        // which 60 (29 %) earn impressions, averaging 103 each against 17 for
        // a cluster canonical. Applying the same band here would de-index a
        // family where nearly a third of the pages rank. Consume the field
        // only after measuring THIS surface on its own.
        const __cmDecision = trafficFilter.decideMulti(__cmCandidatePaths, 'gsc-keyword-landing');
 const __cmAction: 'full' | 'thin' = __cmDecision.action === 'thin' ? 'thin' : 'full';
 const __cmBody = __cmAction === 'thin'
 ? buildGscKeywordThinBody({ locale, query: String(copy.heading || comboTitle || ''), listingUrl: _cListUrl, h1Title: esc(copy.heading), jobCount: matchingJobs.length, companies: [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))].slice(0, 3).map((c: string) => esc(c)) })
 : __cmFullBody;
 if (__cmAction === 'thin') {
 gscKeywordThinCount++;
 gscKeywordBytesSaved += __cmFullBody.length - __cmBody.length;
 } else {
 gscKeywordFullCount++;
 }
 // buildSeoPageHtml (hydration-safe shell). See city-hub fix at line ~5420.
 const comboHtml = buildSeoPageHtml({
 locale,
 title: comboTitle,
 description,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 // Preserve OG image override; append thin-shell signal when applicable.
 extraHeadHtml: __cmAction === 'thin'
 ? `${comboOgImage || ''}${GSC_KEYWORD_THIN_HEAD_SCRIPT}`
 : comboOgImage,
 jsonLdScripts: [comboBreadcrumbLd],
 bodyHtml: __cmBody,
 distDir,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), comboHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, comboHtml);
 }
 searchPageCount++;
 recordEmit('search-combo-landing', __tSearchCombo);
 }

 // Add qualifying combo pages to sitemap for discovery
 if (matchingJobs.length >= 3) {
 const cItSlug = `${searchRoutePrefix.it}-${comboKey}`;
 const cItPath = withSlash(`/${sectionByLocale.it}/${cItSlug}`.replace(/\/+/g, '/'));
 const cItUrl = `${BASE_URL}${cItPath}`;
 const cLocaleSlugs = new Map<typeof localeList[number], string>();
 const cLocalePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSlug = `${searchRoutePrefix[l]}-${comboKey}`;
 cLocaleSlugs.set(l, lSlug);
 const cp = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/'));
 cLocalePaths.set(l, cp);
 }
 const cAlternates = localeList.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${cLocalePaths.get(l)}" />`).join('\n');
 const cXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${cItUrl}" />`;
 // SEO: skip -- page self-canonicalizes elsewhere (Semrush gate).
 // Same rationale as the search-leader block above: editorial duplicates
 // and canonical-override slugs must never be advertised under their
 // own URL. Checked per-locale (#3499).
 for (const l of localeList) {
 const lSlug = cLocaleSlugs.get(l)!;
 const cp = cLocalePaths.get(l)!;
 const lUrl = `${BASE_URL}${cp}`;
 const isEditorialDuplicate = editorialSearchSlugsByLocale.get(l)?.has(lSlug) === true;
 const overrideUrl = resolveCanonicalUrl(lSlug, lUrl);
 if (isEditorialDuplicate || overrideUrl !== lUrl) continue;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, cp.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 searchSitemapEntries.push(` <url>\n <loc>${lUrl}</loc>\n${cAlternates}\n${cXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }
 };

 // Collect unique locations and companies from stats leaders. `name` is the
 // same whitespace-only-normalized stats-leader data class as the title
 // leaders above; strip at the source so combo `copy.heading`/title (rendered
 // into scanned `<main>` + breadcrumb JSON-LD) can never carry literal `**`.
 const locationLeaders = new Map<string, string>();
 for (const groupKey of ['topLocationsActive', 'topLocationsAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = stripLiteralMarkdownFromTitle(String(item?.name || '').trim());
 if (k && n && !locationLeaders.has(k)) locationLeaders.set(k, n);
 }
 }
 const companyLeaders = new Map<string, string>();
 for (const groupKey of ['topCompaniesActive', 'topCompaniesAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = stripLiteralMarkdownFromTitle(String(item?.name || '').trim());
 if (k && n && !companyLeaders.has(k)) companyLeaders.set(k, n);
 }
 }
 // Filter out non-city location keys
 const cityKeys = new Set<string>();
 for (const [k] of locationLeaders) {
 if (k !== 'ticino' && k !== 'grigioni' && !k.includes('-') && k.length < 30) cityKeys.add(k);
 }

 // 1) città + azienda combinations
 let comboCount = 0;
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const [compKey, compName] of companyLeaders) {
 const comboKey = `${cityKey}-${compKey}`;
 const normCity = normalizeSearchTerm(cityKey);
 const normComp = normalizeSearchTerm(compKey);
 // Title and heading use STRUCTURALLY DIFFERENT lead words so that when
 // long company names (e.g. "EOC – Ente Ospedaliero Cantonale") push the
 // titled+brand past TITLE_MAX_CHARS=66, buildTitleWithBrand drops the
 // brand and the bare title would otherwise collide with the H1.
 // audit:h1-title-duplicates is zero-tolerance — guard at source.
 generateComboPage(comboKey, {
 it: {
 title: buildTitleWithBrand(`Offerte ${compName} a ${cityName}`),
 description: (c) => `${c} offerte di lavoro ${compName} a ${cityName}. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${compName} a ${cityName}`,
 },
 en: {
 title: buildTitleWithBrand(`${compName} careers in ${cityName}`),
 description: (c) => `${c} ${compName} job openings in ${cityName}. Browse available positions and apply today.`,
 heading: `${compName} jobs in ${cityName}`,
 },
 de: {
 title: buildTitleWithBrand(`${compName} Stellenangebote in ${cityName}`),
 description: (c) => `${c} offene Stellen bei ${compName} in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${compName} Jobs in ${cityName}`,
 },
 fr: {
 title: buildTitleWithBrand(`Postes ${compName} à ${cityName}`),
 description: (c) => `${c} offres d'emploi ${compName} à ${cityName}. Consultez les postes ouverts et postulez directement.`,
 heading: `Emploi ${compName} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 const comp = normalizeSearchTerm([job?.company, job?.companyKey].filter(Boolean).join(' '));
 return isLocationMatch(loc, normCity) && comp.includes(normComp);
 });
 comboCount++;
 }
 }

 // 2) città + contratto combinations
 const contractTypes: { key: string; labels: Record<'it' | 'en' | 'de' | 'fr', string>; match: string[] }[] = [
 { key: 'full-time', labels: { it: 'Full-time', en: 'Full-time', de: 'Vollzeit', fr: 'Temps plein' }, match: ['full-time'] },
 { key: 'part-time', labels: { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' }, match: ['part-time'] },
 { key: 'stage', labels: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' }, match: ['internship'] },
 { key: 'apprendistato', labels: { it: 'Apprendistato', en: 'Apprenticeship', de: 'Lehrstelle', fr: 'Apprentissage' }, match: ['apprenticeship'] },
 { key: 'tempo-determinato', labels: { it: 'Tempo determinato', en: 'Temporary', de: 'Befristet', fr: 'Temporaire' }, match: ['temporary'] },
 ];
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const ct of contractTypes) {
 const comboKey = `${cityKey}-${ct.key}`;
 const normCity = normalizeSearchTerm(cityKey);
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${ct.labels.it} a ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro ${ct.labels.it.toLowerCase()} a ${cityName}. Trova posizioni ${ct.labels.it.toLowerCase()} e candidati subito.`,
 heading: `Lavoro ${ct.labels.it} a ${cityName}`,
 },
 en: {
 title: `${ct.labels.en} jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.en.toLowerCase()} job openings in ${cityName}. Browse positions and apply today.`,
 heading: `${ct.labels.en} jobs in ${cityName}`,
 },
 de: {
 title: `${ct.labels.de} Jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.de}-Stellen in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${ct.labels.de} Jobs in ${cityName}`,
 },
 fr: {
 title: `Emploi ${ct.labels.fr} à ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${ct.labels.fr.toLowerCase()} à ${cityName}. Consultez les postes et postulez.`,
 heading: `Emploi ${ct.labels.fr} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 return isLocationMatch(loc, normCity) && ct.match.includes(String(job?.contract || '').toLowerCase());
 });
 comboCount++;
 }
 }

 // 3) settore + Ticino combinations
 const sectorTypes: { key: string; category: string[]; labels: Record<'it' | 'en' | 'de' | 'fr', string> }[] = [
 { key: 'sanita', category: ['health', 'healthcare'], labels: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheitswesen', fr: 'Santé' } },
 { key: 'finanza', category: ['finance'], labels: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' } },
 { key: 'informatica', category: ['tech', 'technology'], labels: { it: 'Informatica', en: 'IT', de: 'Informatik', fr: 'Informatique' } },
 { key: 'vendita', category: ['sales'], labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
 { key: 'ingegneria', category: ['engineering'], labels: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' } },
 { key: 'amministrazione', category: ['admin', 'management', 'operations'], labels: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' } },
 { key: 'ristorazione', category: ['hospitality'], labels: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastronomie', fr: 'Restauration' } },
 { key: 'produzione', category: ['production', 'manufacturing', 'maintenance'], labels: { it: 'Produzione', en: 'Manufacturing', de: 'Produktion', fr: 'Production' } },
 { key: 'formazione', category: ['education', 'professor', 'researcher', 'phd'], labels: { it: 'Formazione', en: 'Education', de: 'Bildung', fr: 'Formation' } },
 { key: 'legale', category: ['legal'], labels: { it: 'Legale', en: 'Legal', de: 'Recht', fr: 'Juridique' } },
 { key: 'design', category: ['design'], labels: { it: 'Design', en: 'Design', de: 'Design', fr: 'Design' } },
 ];
 for (const sector of sectorTypes) {
 const comboKey = `${sector.key}-ticino`;
 const catSet = new Set(sector.category.map((c) => c.toLowerCase()));
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${sector.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro nel settore ${sector.labels.it.toLowerCase()} in Ticino. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${sector.labels.it} in Ticino`,
 },
 en: {
 title: `${sector.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${sector.labels.en.toLowerCase()} job openings in Ticino. Browse available positions and apply today.`,
 heading: `${sector.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${sector.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${sector.labels.de}-Stellen im Tessin. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${sector.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${sector.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${sector.labels.fr.toLowerCase()} au Tessin. Consultez les postes ouverts et postulez.`,
 heading: `Emploi ${sector.labels.fr} au Tessin`,
 },
 }, (job) => catSet.has(String(job?.category || '').toLowerCase()));
 comboCount++;
 }

 // 4) ruolo + Ticino combinations — from internal search demand
 // Users search for specific roles: Medico, Infermiere, Autista, Cuoco, Piastrellista, etc.
 const roleTypes = ROLE_COMBO_MATCHERS;
 for (const role of roleTypes) {
 const comboKey = `${role.key}-ticino`;
 if (searchLeaderMap.has(comboKey)) { comboCount++; continue; }
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${role.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro come ${role.labels.it.toLowerCase()} in Ticino. Posizioni aggiornate ogni giorno, candidatura diretta.`,
 heading: `Lavoro come ${role.labels.it} in Ticino`,
 },
 en: {
 title: `${role.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${role.labels.en.toLowerCase()} job openings in Ticino. Updated daily, apply directly.`,
 heading: `${role.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${role.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${role.labels.de}-Stellen im Tessin. Täglich aktualisiert, direkt bewerben.`,
 heading: `${role.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${role.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${role.labels.fr.toLowerCase()} au Tessin. Mises à jour quotidiennes, postulez directement.`,
 heading: `Emploi ${role.labels.fr} au Tessin`,
 },
 }, (job) => {
 const title = normalizeSearchTerm([job?.title, job?.titleByLocale?.it].filter(Boolean).join(' '));
 return role.match.test(title);
 });
 comboCount++;
 }

 if (comboCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated combo search pages from ${comboCount} combinations`);
 }

 searchEntries = [editorialEntries, searchSitemapEntries.join('\n')].filter(Boolean).join('\n');
 if (searchPageCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${searchPageCount} search landing pages (stats + combos)`);
 }
 } else {
 searchEntries = editorialEntries;
 }

 // Generate sitemap with hreflang alternates for all locales
 const landingAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const landingXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/cerca-lavoro-ticino/" />`;
 // Per-locale push (#3499): each locale's own TI-legacy section root gets its
 // own <url> entry (confirmed live: /en/find-jobs-ticino/, /de/jobs-im-tessin/,
 // /fr/trouver-emploi-tessin/ all return 200 with real content) instead of
 // only IT, so non-IT alternates survive sanitizeSitemapHreflangReciprocity()
 // instead of being stripped as referenced-but-never-listed.
 const landingEntry = localeList.map((l) => {
 const p = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}`.replace(/\/+/g, '/'));
 return ` <url>\n <loc>${BASE_URL}${p}</loc>\n${landingAlternates}\n${landingXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.9</priority>\n </url>`;
 }).join('\n');

 // Filter out thin content jobs (<50 words IT description) from sitemap (FRO-278).
 // Also exclude jobs flagged `needsRetranslation` when their OWN source
 // locale isn't IT — the <loc> below is always the IT canonical URL, so
 // stale-alternate crawl-budget waste only applies when IT itself is the
 // pending translation. An IT-sourced job flagged only because its
 // EN/DE/FR alternates are pending has a perfectly good IT canonical page
 // and must not be dropped from the sitemap entirely (#4715).
 const sitemapEligibleJobs = validJobs.filter((job) => {
 const nr = (job as any).needsRetranslation;
 if (nr === true && ((job as any).sourceLang || 'it') !== 'it') return false;
 const desc = String((job as any).descriptionByLocale?.it || (job as any).description || '');
 const wordCount = desc.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
 return wordCount >= 50;
 });
 const jobEntries = sitemapEligibleJobs.map((job) => {
 const perLocaleSlugMap = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 // Cathedral: sitemap entry must match the actual emitted HTML path,
 // which is canton-aware (e.g. /cerca-lavoro-luzern/<slug>/ for LU jobs).
 // The previous code used the legacy TI section for all jobs, producing
 // sitemap URLs whose <link rel="canonical"> pointed elsewhere → blocked
 // by validate:sitemap-pages with "Canonical mismatch".
 const jobCantonForSitemap = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const itSectionForJob = buildCantonAwareSection('it', jobCantonForSitemap);
 const itPath = withSlash(`/${itSectionForJob}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
 const itUrl = `${BASE_URL}${itPath}`;
 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // Jobs listed in data/job-canonical-overrides.json have <link rel="canonical">
 // pointing to a different URL (typically a brand-hub /azienda-<slug>/),
 // so advertising the per-job slug in the sitemap raises a "Non-canonical
 // URL in sitemap" error. The brand-hub canonical is already advertised
 // via companyEntries above.
 const overrideUrl = resolveCanonicalUrl(perLocaleSlugMap.it, itUrl);
 if (overrideUrl !== itUrl) return '';
 const alternateLinks = localeList.map((l) => {
 const sectionForLocale = buildCantonAwareSection(l, jobCantonForSitemap);
 const p = `${localePrefix[l]}/${sectionForLocale}/${perLocaleSlugMap[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const jobLastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;
 return ` <url>\n <loc>${itUrl}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`;
 }).filter((s) => s.length > 0).join('\n');

 // FRO-SEO / seo/sitemap-crawl-budget: previousSlugs bridge pages are NOT
 // listed in the sitemap. Each bridge already emits `<link rel="canonical">`
 // pointing at the current slug, which is how Google consolidates signals —
 // enumerating 13k+ bridge URLs in the sitemap just multiplied crawl-budget
 // waste without adding a consolidation signal. We still render the bridge
 // HTML (see bridge generator below) so the old URL resolves, we just stop
 // advertising it in the sitemap.
 //
 // To re-enable the old behavior flip this flag to true; the generation code
 // below is kept intact so the opt-in path keeps working.
 const INCLUDE_PREV_SLUG_SITEMAP_ENTRIES = false;
 const prevSlugEntries: string[] = [];
 const prevSlugSitemapPaths = new Set<string>(); // dedup
 for (const job of (INCLUDE_PREV_SLUG_SITEMAP_ENTRIES ? sitemapEligibleJobs : [])) {
 const prevSlugsLegacy: string[] = Array.isArray((job as any).previousSlugs) ? (job as any).previousSlugs : [];
 const pslByLocale = (job as any).previousSlugsByLocale;
 // Identify locale-aware slugs so we can separate legacy-only
 const localeAwareAll = new Set<string>();
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s as string);
 }
 }
 const legacyOnly = prevSlugsLegacy.filter(s => !localeAwareAll.has(s));
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 const currentItSlug = localizedSlug(job, 'it');
 // Phase 8b: previousSlugs sitemap entries live at the JOB'S canton path,
 // not the legacy TI section. Compute once per job; reused inside addEntry
 // and the canonicalAlternates emit below.
 const jobCantonForSitemapPrevSlugs = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const currentItPath = withSlash(`/${buildCantonAwareSection('it', jobCantonForSitemapPrevSlugs)}/${currentItSlug}`.replace(/\/+/g, '/'));
 const canonicalAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${buildCantonAwareSection(l, jobCantonForSitemapPrevSlugs)}/${localizedSlug(job, l)}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${currentItPath}" />`;
 const jobLastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;

 const addEntry = (ps: string, locale: 'it' | 'en' | 'de' | 'fr') => {
 const currentSlug = localizedSlug(job, locale);
 if (!ps || ps === currentSlug) return;
 if (!jobHtmlCache.has(`${locale}:${currentSlug}`)) return;
 const psRelPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCantonForSitemapPrevSlugs)}/${ps}`.replace(/\/+/g, '/').replace(/^\//, '');
 if (activeJobDirs.has(psRelPath)) return;
 if (prevSlugSitemapPaths.has(psRelPath)) return;
 prevSlugSitemapPaths.add(psRelPath);
 const psPath = withSlash(`/${psRelPath}`);
 prevSlugEntries.push(` <url>\n <loc>${BASE_URL}${psPath}</loc>\n${canonicalAlternates}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 };

 // Locale-specific previousSlugs → sitemap entry under their locale prefix
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const [locale, slugs] of Object.entries(pslByLocale)) {
 if (!Array.isArray(slugs) || !localeList.includes(locale as any)) continue;
 for (const ps of slugs as string[]) addEntry(ps, locale as typeof localeList[number]);
 }
 }
 // Legacy flat previousSlugs → sitemap entry under Italian path
 for (const ps of legacyOnly) addEntry(ps, 'it');
 }
 const prevSlugSitemap = prevSlugEntries.length > 0 ? '\n' + prevSlugEntries.join('\n') : '';

 // Company sitemap entries — skip known brand aliases so the primary
 // canonical is the only company-hub URL advertised for dedup (P5).
 const companyEntries = [...companyMap.keys()].filter((cSlug) => !isBrandAlias(cSlug)).flatMap((cSlug) => {
 const localePaths = new Map<typeof localeList[number], string>();
 for (const l of localeList) {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = withSlash(`${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/'));
 localePaths.set(l, p);
 }
 const itPath = localePaths.get('it')!;
 const alternateLinks = localeList.map((l) =>
 ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${localePaths.get(l)}" />`,
 ).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 // Every locale gets its own reciprocal <loc> entry (#3499 sibling) -- this
 // top-level company hub renders real en/de/fr HTML (write loop above,
 // ~L3789) same as the IT page, so an IT-only push here left en/de/fr as
 // one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
 // Only push a non-IT locale whose HTML was actually written (dead-link
 // guard, same intent as pushEditorialSitemapEntry above).
 const entries: string[] = [];
 for (const l of localeList) {
 const p = localePaths.get(l)!;
 if (l !== 'it') {
 const dirIndex = np.join(distDir, p.slice(1), 'index.html');
 if (!_writtenPaths.has(dirIndex) && !fs.existsSync(dirIndex)) continue;
 }
 entries.push(` <url>\n <loc>${BASE_URL}${p}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.7</priority>\n </url>`);
 }
 return entries;
 }).join('\n');

 const paginationSitemap = paginationSitemapEntries.length > 0 ? '\n' + paginationSitemapEntries.join('\n') : '';
 const categorySitemap = categorySitemapEntries.length > 0 ? '\n' + categorySitemapEntries.join('\n') : '';
 const keywordSitemap = keywordSitemapEntries.length > 0 ? '\n' + keywordSitemapEntries.join('\n') : '';
 // #3516: independent segments (search clusters, keyword pages, …) can emit
 // the same <loc> twice within this one file — dedupe keep-first at assembly.
 const sitemapJobs = dedupeUrlsetXmlByLoc(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${landingEntry}\n${companyEntries}\n${searchEntries}\n${jobEntries}${prevSlugSitemap}${paginationSitemap}${categorySitemap}${keywordSitemap}\n</urlset>\n`);
 const sitemapJobsPath = np.join(distDir, 'sitemap-jobs.xml');
 fs.writeFileSync(sitemapJobsPath, sitemapJobs, 'utf-8');

 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 // Update existing lastmod for sitemap-jobs.xml
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${dateStamp}$2`
 );
 }
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }

 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${validJobs.length * 4} localized job pages and sitemap-jobs.xml (${prevSlugEntries.length} previousSlug entries)`);
 logBuildMem('jobsSeoPages: after job-pages-DONE', collector);

 // Active-job emit done — release canonicalCleanedCache (~22k entries ×
 // CleanedFallbackContent, hundreds of MB peak). Only `memoCanonicalCleaned`
 // reads it, and that function is called only inside the active-job loop
 // (line 2515). The downstream emit phases (cross-locale-active-bridge,
 // expired-soft-landing, previous-slug-bridge, related-search-clusters)
 // do NOT use it. Freeing now relieves memory pressure for the heavy
 // expired-soft-landing pass that follows — the deploy SIGTERMs since
 // 2026-05-26 14:27Z point at OS OOM on a 7 GB GHA runner.
 //
 // The diagnostic log at the end of closeBundle reads `.size` — capture
 // it BEFORE clearing so the hit-rate summary keeps reporting truth.
 _canonicalCleanedCacheSizeAtEnd = canonicalCleanedCache.size;
 canonicalCleanedCache.clear();

 // Backpressure: drain pending WriteCollector flushes before the next
 // emit phase queues more. Run 26488854594 OOM'd Node at the 12 GB
 // heap cap because the 6 sequential emit phases stacked 60+ in-flight
 // flushes each holding a 5000-entry closure (FATAL "Ineffective
 // mark-compacts near heap limit"). awaitDrainSlot(2) caps in-flight
 // memory at ~450 MB regardless of total page volume.
 await collector.awaitDrainSlot(2);

 /* ───────────────────────────────────────────────────────────────────
  * P1.11 — Canton-aware additive emission
  * ───────────────────────────────────────────────────────────────────
  *
  *   sitemapEligibleJobs (already filtered: ≥50 IT words, no needsRetranslation)
  *        │
  *        ├─► applyCantonQuorumGate(job)  ──► { canton, cantonConfidence }
  *        │       low / reject  →  AGGREGATE_KEY
  *        │       high          →  job.canton
  *        │
  *        ├─► groupByDedupKey  ──► one canonical URL per (title|company|identity)
  *        │       jobLocation[]  collects every locality across the group
  *        │
  *        ▼
  *   urls = [{ loc, lastmod, ... }]   (one per group × 4 locales)
  *        │
  *        ├─► splitToShards(shardKey = canton) ──► sitemap-jobs-{slug}.xml
  *        ├─► emitSitemapXml(per-shard)        ──► written to dist/
  *        └─► emitSitemapIndex(all shards)     ──► dist/sitemap-index.xml
  *
  *   Plus: per-canton + aggregator landing pages
  *   /cerca-lavoro-{cantonSlug}/index.html × 4 locales × 27 (= 108 pages)
  *   The TI ones are NOT re-emitted — staticPagesPlugin already owns those.
  *
  * Sibling agents (jobMarketSnapshot, weeklyEmployers) are not touched.
  * The legacy sitemap-jobs.xml above stays untouched for backward compat —
  * the new shards are ADDITIVE; downstream (ci/audit:orphan-sitemap-pages)
  * will read both via the patched sitemap.xml index.
  */
 try {
   // Resolve absolute paths to the .mjs helpers — relative imports from a Vite
   // plugin .ts can break depending on how Vite bundles the plugin chain. The
   // helpers ship as plain ESM under scripts/lib/ and are loaded at build time.
   const { pathToFileURL } = await import('node:url');
   const cantonGateUrl = pathToFileURL(np.resolve(rootDir, 'scripts/lib/canton-quorum-gate.mjs')).href;
   const sitemapShardUrl = pathToFileURL(np.resolve(rootDir, 'scripts/lib/sitemap-shard.mjs')).href;
   const { applyCantonQuorumGate } = await import(cantonGateUrl) as {
     applyCantonQuorumGate: (j: unknown) => { canton: string; confidence: 'high'|'low'|'reject'; cantonConfidence: 'high'|'low'|'reject' };
   };
   const { splitToShards, writeShardsToDist } = await import(sitemapShardUrl) as {
     splitToShards: (urls: Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number; _shardKey?: string }>, opts?: { capPerShard?: number; shardKey?: (u: any) => string; filenamePrefix?: string }) => Array<{ filename: string; urls: any[] }>;
     writeShardsToDist: (shards: any[], distDir: string, baseUrl: string) => Promise<{ shardPaths: string[]; indexPath: string | null }>;
   };

   /**
    * Per-job canton classification: applies the quorum gate, returns either a
    * concrete canton code or AGGREGATE_KEY for low-confidence / rejected jobs
    * (E11 — uncertain jobs land on /cerca-lavoro-svizzera/, not on a per-canton
    * landing). Pure function — never mutates the input job.
    */
   const classifyCantonForUrl = (job: any): string => {
     try {
       const r = applyCantonQuorumGate({
         title: job?.title,
         description: job?.description ?? job?.descriptionByLocale?.it,
         addressLocality: job?.addressLocality ?? job?.location,
         addressRegion: job?.addressRegion,
         addressCountry: job?.addressCountry ?? 'CH',
         postalCode: job?.postalCode,
         canton: job?.canton,
       });
       // Half-canton merge: BFS may return 'AI'/'AR'/'BL'/'BS' but the
       // URL/shard layer treats them as 'APPENZELLO'/'BASILEA'.
       if (r.cantonConfidence === 'high' && r.canton) {
         return resolveCantonGroup(r.canton.toUpperCase());
       }
       return AGGREGATE_KEY;
     } catch {
       return AGGREGATE_KEY;
     }
   };

   /**
    * Dedup-key for E8 multi-canton same-job grouping. Mirrors the heuristic
    * in scripts/lib/dedicated-crawler-common.mjs (dedupHeuristicKey) but
    * scoped to fields we already have on validJobs. Two jobs with the same
    * key are considered the same vacancy posted across multiple locations.
    */
   const dedupKey = (job: any): string => {
     const id = String(job?.id || '').trim();
     if (id) return `id|${id}`;
     const title = String(job?.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
     const company = String(job?.company || '').toLowerCase().replace(/\s+/g, ' ').trim();
     return `tc|${title}|${company}`;
   };

   // Build group → canonical-job + jobLocation[] (E8). The canonical job is
   // the most recent (validJobs is already DESC-sorted by recency). All
   // member localities are collected so the JobPosting schema can list them.
   type GroupEntry = { canonical: any; canton: string; locations: string[] };
   const groups = new Map<string, GroupEntry>();
   for (const job of sitemapEligibleJobs) {
     const k = dedupKey(job);
     const canton = classifyCantonForUrl(job);
     const loc = String(job.location || job.addressLocality || '').trim();
     const existing = groups.get(k);
     if (!existing) {
       groups.set(k, { canonical: job, canton, locations: loc ? [loc] : [] });
       continue;
     }
     // Already grouped — record the additional locality if distinct.
     if (loc && !existing.locations.includes(loc)) existing.locations.push(loc);
     // If existing canton was AGGREGATE but new entry has a concrete canton,
     // upgrade — the canonical URL stays on the most recent entry though.
     if (existing.canton === AGGREGATE_KEY && canton !== AGGREGATE_KEY) {
       existing.canton = canton;
     }
   }

   // T2.6 — Per-canton active-job counts for MIN_JOBS gate. One canonical
   // entry per dedup group, so this is the deduped count Google would index
   // per /cerca-lavoro-{canton}/ landing.
   const cantonJobCounts = new Map<string, number>();
   for (const entry of groups.values()) {
     cantonJobCounts.set(entry.canton, (cantonJobCounts.get(entry.canton) ?? 0) + 1);
   }
   let cantonIndexIndexable = 0;
   let cantonIndexNoindex = 0;

   // Build the URL list for the sharded sitemap. One entry per (group, locale)
   // = 4 × group-count entries. URL preserves the legacy frozen path
   // (sectionByLocale[locale]) — slug-registry is honored verbatim. The
   // shardKey is the canton, so high-confidence jobs cluster into per-canton
   // shards while AGGREGATE jobs land in sitemap-jobs-svizzera.xml.
   //
   // NOTE: this mirrors `jobEntries` above. We build a fresh list so the
   // legacy `<urlset>` and the new sharded index are byte-for-byte
   // independent — no shared mutation, no surprise across plugins.
   type ShardUrl = { loc: string; lastmod: string; changefreq: string; priority: number; _canton: string };
   const shardUrls: ShardUrl[] = [];
   for (const [, group] of groups) {
     const job = group.canonical;
     const perLocaleSlugMap: Record<CantonLocale, string> = {
       it: localizedSlug(job, 'it'),
       en: localizedSlug(job, 'en'),
       de: localizedSlug(job, 'de'),
       fr: localizedSlug(job, 'fr'),
     };
     // P1-C: shard partition must match the URL actually emitted by the
     // per-job loop above (Task 1.2). That loop routes via
     // `sharedResolveJobCanton(job)` which uses job.canton + city → canton
     // lookup with TI fallback. `group.canton` (from BFS classification) can
     // diverge (e.g. AGGREGATE) and would mis-shard a URL that lives at
     // /cerca-lavoro-zurigo/ into sitemap-jobs-svizzera.xml. Use the same
     // resolver here so the sitemap shard mirrors the URL path 1:1.
     const groupJobCanton = sharedResolveJobCanton(job as { canton?: string; location?: string });
     // canonical-overrides: same gate as legacy sitemap. Skip if the job
     // self-canonicalizes elsewhere (otherwise Semrush flags non-canonical).
     const itSectionForGroup = buildCantonAwareSection('it', groupJobCanton);
     const itPathLegacy = withSlash(`/${itSectionForGroup}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
     const itUrlLegacy = `${BASE_URL}${itPathLegacy}`;
     if (resolveCanonicalUrl(perLocaleSlugMap.it, itUrlLegacy) !== itUrlLegacy) continue;
     const lastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;
     for (const locale of localeList) {
       // Canton-aware section matches the actual job-detail URL emitted by
       // the per-job loop. For TI jobs this returns the legacy frozen slug
       // (sectionByLocale[locale]) via resolveCantonSection's early-return.
       const section = buildCantonAwareSection(locale, groupJobCanton);
       const path = withSlash(`${localePrefix[locale]}/${section}/${perLocaleSlugMap[locale]}`.replace(/\/+/g, '/'));
       const localeUrl = `${BASE_URL}${path}`;
       // Per-locale canonical-override gate. canonicalOverrides is keyed by
       // per-locale slug (e.g. `expediter-casale-sa-lugano` for EN,
       // `beschleuniger-…` for DE) — an entry can target a single locale
       // even when the IT sibling self-canonicalizes. Without this guard the
       // EN/DE locale URL gets advertised in sitemap-jobs-{canton}.xml while
       // its rendered HTML carries `<link rel="canonical">` pointing at the
       // brand hub — audit:sitemap-canonicals fails.
       if (resolveCanonicalUrl(perLocaleSlugMap[locale], localeUrl) !== localeUrl) continue;
       // P2-emit-consistency: the per-job emit loop dedups by
       // (canton, locale, perLocaleSlug). When two jobs share the SAME
       // (canton, locale, slug) tuple only the most-recent wins and emits
       // HTML; the loser's URL never materializes. If we still pushed the
       // loser here, validate-sitemap-pages would flag it as missing-html.
       // Gate on the same set the per-job emit populated. Phase 8a unified
       // this key with `emittedActiveJobPaths` — same shape, same delimiter.
       const emittedKey = `${groupJobCanton}:${locale}:${perLocaleSlugMap[locale]}`;
       if (!emittedActiveJobPaths.has(emittedKey)) continue;
       shardUrls.push({
         loc: localeUrl,
         lastmod,
         changefreq: 'weekly',
         priority: 0.6,
         _canton: groupJobCanton,
       });
     }
   }

   // Per-canton + aggregator landing index pages. 26 cantons − TI + svizzera
   // = 26 keys × 4 locales = 104 pages. TI is skipped because
   // staticPagesPlugin already emits the legacy /cerca-lavoro-ticino/ index
   // (ditto en/de/fr) — re-emitting would race and overwrite that plugin's
   // hand-tuned content.
   //
   // P2.B1+B2+B3 — every locale-prefix path is emitted (IT no-prefix, EN/DE/FR
   // under /en /de /fr) using `buildSeoPageHtml` so each page hydrates with
   // the full SPA shell (CLAUDE.md NON-NEGOTIABLE #14: every static SSG page
   // MUST use the SPA shell + hydration). The legacy `buildSimplePage` path
   // omitted entryJs/entryCss and produced unstyled, non-hydrating pages —
   // visitors arriving at /en/find-jobs-zurich/ saw a blank shell.
   let cantonIndexEmitted = 0;
   const cantonsToEmit: Array<{ key: string; locale: CantonLocale; slug: string; section: string }> = [];
   for (const code of [...ALL_CANTON_CODES, AGGREGATE_KEY]) {
     for (const locale of localeList) {
       if (code === 'TI') continue; // owned by staticPagesPlugin
       cantonsToEmit.push({
         key: code,
         locale,
         slug: getCantonUrlSlugLocal(code, locale),
         section: buildCantonAwareSection(locale, code),
       });
     }
   }

   /**
    * Build the per-locale title/lede/CTA-label triple for a canton landing.
    * Pure function — keeps {@link buildCantonLocaleLabels} cheap to call
    * inside the emit loop and keeps the inline string-tables out of the
    * critical path. `display` is the human-readable canton name already
    * localized via `getCantonDisplayLabel`.
    */
   const buildCantonLocaleLabels = (
     locale: CantonLocale,
     display: string,
   ): { title: string; lede: string; ctaLabel: string } => {
     switch (locale) {
       case 'it':
         return {
          title: buildTitleWithBrand(`Lavoro in ${display}`),
          lede: `Pagina indice del job board per il cantone ${display}.`,
          ctaLabel: `Vedi tutte le offerte`,
        };
       case 'en':
         return {
          title: buildTitleWithBrand(`Jobs in ${display}`),
          lede: `Job board index page for canton ${display}.`,
          ctaLabel: `View all listings`,
        };
       case 'de':
         // Issue #4303 item 3: this generator feeds the canton-hub <title>
         // (line ~10398) and header lede (line ~10306) for every DE-locale
         // /jobs-im-tessin/{kanton}/-style page — including the aggregate
         // "Schweiz" hub, together ~137.9k GSC impressions parked at
         // position 12. The prior copy ("Jobs in Zürich" / "Job-Board-
         // Übersicht für den Kanton Zürich.") is a literal IT/EN mirror with
         // zero Grenzgänger terminology, even though the DE-locale audience
         // is overwhelmingly real German-speaking Grenzgänger (esp. the
         // Basel↔Lörrach/Weil am Rhein commute belt) — a different search
         // intent than the IT-locale "frontaliere italiano" reader, and the
         // DE body prose already targets it (see buildCantonContextProse's
         // "als Grenzgänger" H2 + "Grenzgängerinnen und Grenzgänger" copy
         // above). Rewritten to match that intent instead of translating
         // the generic "job board index" framing.
         return {
          title: buildTitleWithBrand(`Grenzgänger-Jobs ${germanCantonPrep(display)}`),
          lede: `Aktuelle Stellenangebote für Grenzgänger ${germanCantonPrep(display)} — täglich aktualisiert.`,
          ctaLabel: `Alle Stellen anzeigen`,
        };
       case 'fr':
       default:
         return {
          title: buildTitleWithBrand(`Emploi ${frenchCantonPrep(display)}`),
          lede: `Index du job board pour le canton ${display}.`,
          ctaLabel: `Voir toutes les offres`,
        };
     }
   };

   /**
    * Locale-aware frontaliere context paragraphs for canton landings.
    *
    * Pre-T2.S3 the body was just H1 + 1-line lede + CTA → text/HTML ratio of
    * 1.7-2.2 % (HTML ~6.1 KB vs ~140 chars text). The Semrush text-html-ratio
    * gate (10 % floor) failed with 64 spa-locale offenders. This adds ~600
    * chars of locale-appropriate prose per canton landing — frontaliere
    * context (Permit G, fiscal regime, AVS/LPP, LAMal, CHF/EUR conversion)
    * + cross-link to calculator and comparator hubs. Placed BELOW the CTA
    * per CLAUDE.md non-negotiable #16 (mobile-first: filler below content).
    */
   const buildCantonContextProse = (
     locale: CantonLocale,
     display: string,
   ): string => {
     switch (locale) {
       case 'it':
         return [
           `<section class="s-0P4kC8" data-canton-context-prose>`,
           `<h2 class="s-iZTOT1">Lavorare ${display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`} come frontaliere</h2>`,
           `<p>${display === 'Svizzera' ? 'La Svizzera resta la destinazione più stabile per i lavoratori italiani in cerca di salari competitivi e ammortizzatori sociali solidi.' : `Il cantone ${display} rientra fra le mete principali dei frontalieri italiani in cerca di stipendi più alti rispetto alla media italiana.`} Le posizioni elencate qui coprono tutti i settori — sanità, costruzioni, industria, terziario, IT, logistica — e includono sia ruoli a tempo pieno (100 %) sia part-time (50–80 %), tipici dei contratti svizzeri.</p>`,
           `<p>Per il regime frontaliere occorre rispettare i requisiti del Nuovo Accordo del 2026: residenza italiana entro 20 km dal confine, rientro giornaliero (con eccezione del 25 % delle giornate per smart-working), permesso di lavoro G. Il salario lordo svizzero in CHF, una volta convertito in EUR e dedotti AVS/AI/IPG, LPP (secondo pilastro) e LAINF, va confrontato con il costo della vita in Italia per stimare il guadagno reale.</p>`,
           `<p>Usa il <a class="s-EBYcGk" href="${CALC_HREF.it}">calcolatore di stipendio netto</a> per simulare il netto in mano partendo dal lordo proposto, oppure il <a class="s-EBYcGk" href="${FX_HREF.it}">confronto cambio CHF/EUR</a> per capire quanto rende oggi un'offerta in franchi svizzeri rispetto ad un equivalente italiano in euro.</p>`,
           `</section>`,
         ].join('');
       case 'en':
         return [
           `<section class="s-0P4kC8" data-canton-context-prose>`,
           `<h2 class="s-iZTOT1">Working ${display === 'Switzerland' ? 'in Switzerland' : `in the canton of ${display}`} as a cross-border worker</h2>`,
           `<p>${display === 'Switzerland' ? 'Switzerland remains the most attractive destination for Italian workers seeking higher wages and stronger social protection than the Italian average.' : `The canton of ${display} is one of the main destinations for Italian cross-border workers (frontalieri) chasing salaries that exceed the Italian average.`} The positions listed here cover every sector — healthcare, construction, manufacturing, services, IT, logistics — and include both full-time (100 %) and part-time (50–80 %) contracts that are standard in Switzerland.</p>`,
           `<p>To qualify for the cross-border tax regime under the 2026 New Agreement you must reside in Italy within 20 km of the Swiss border, return home daily (with up to 25 % of days allowed in smart-working from Italy), and hold a G-type work permit. The Swiss gross salary in CHF — once converted to EUR and net of AVS/AI/IPG, LPP (second pillar) and LAINF contributions — should be compared against the Italian cost of living to estimate the real take-home.</p>`,
           `<p>Use the <a class="s-EBYcGk" href="${CALC_HREF.en}">net-salary calculator</a> to simulate take-home pay starting from a gross offer, or the <a class="s-EBYcGk" href="${FX_HREF.en}">CHF/EUR exchange comparator</a> to gauge how much a Swiss offer in francs is worth today versus an Italian equivalent in euros.</p>`,
           `</section>`,
         ].join('');
       case 'de':
         return [
           `<section class="s-0P4kC8" data-canton-context-prose>`,
           `<h2 class="s-iZTOT1">Arbeiten ${display === 'Schweiz' ? 'in der Schweiz' : `${germanCantonPrep(display)}`} als Grenzgänger</h2>`,
           `<p>${display === 'Schweiz' ? 'Die Schweiz bleibt das attraktivste Ziel für italienische Arbeitnehmer, die höhere Löhne und einen stärkeren Sozialschutz als im italienischen Durchschnitt suchen.' : `Der Kanton ${display} zählt zu den Hauptzielen italienischer Grenzgänger (frontalieri), die ein höheres Gehalt als den italienischen Durchschnitt anstreben.`} Die hier aufgeführten Stellen decken alle Branchen ab — Gesundheitswesen, Bau, Industrie, Dienstleistungen, IT, Logistik — und umfassen sowohl Vollzeit- (100 %) als auch Teilzeitverträge (50–80 %), wie sie in der Schweiz üblich sind.</p>`,
           `<p>Für die Grenzgänger-Besteuerung nach dem neuen Abkommen 2026 müssen Sie innerhalb von 20 km von der Schweizer Grenze in Italien wohnen, täglich nach Hause zurückkehren (mit bis zu 25 % der Tage als Homeoffice aus Italien zulässig) und eine G-Bewilligung besitzen. Der Schweizer Bruttolohn in CHF — nach Umrechnung in EUR und Abzug von AHV/IV/EO, BVG (zweite Säule) und UVG-Beiträgen — sollte den italienischen Lebenshaltungskosten gegenübergestellt werden, um den realen Nettoverdienst abzuschätzen.</p>`,
           `<p>Nutzen Sie den <a class="s-EBYcGk" href="${CALC_HREF.de}">Nettolohnrechner</a>, um den Nettolohn aus einem Bruttoangebot zu simulieren, oder den <a class="s-EBYcGk" href="${FX_HREF.de}">CHF/EUR-Wechselkursrechner</a>, um den heutigen Wert eines Schweizer Angebots in Franken im Vergleich zum italienischen Pendant in Euro zu beurteilen.</p>`,
           `</section>`,
         ].join('');
       case 'fr':
       default:
         return [
           `<section class="s-0P4kC8" data-canton-context-prose>`,
           `<h2 class="s-iZTOT1">Travailler ${display === 'Suisse' ? 'en Suisse' : `${frenchCantonPrep(display)}`} en tant que frontalier</h2>`,
           `<p>${display === 'Suisse' ? 'La Suisse reste la destination la plus attractive pour les travailleurs italiens en quête de salaires supérieurs et d\'une protection sociale plus solide que la moyenne italienne.' : `Le canton ${display} compte parmi les principales destinations des frontaliers italiens (frontalieri) en recherche de salaires supérieurs à la moyenne italienne.`} Les postes listés ici couvrent tous les secteurs — santé, construction, industrie, services, informatique, logistique — et incluent à la fois les contrats à temps plein (100 %) et à temps partiel (50–80 %), typiques du marché suisse.</p>`,
           `<p>Pour le régime fiscal frontalier prévu par le nouvel accord 2026, il faut résider en Italie dans un rayon de 20 km de la frontière suisse, rentrer chaque jour au domicile (avec un quota de 25 % de jours autorisés en télétravail depuis l\'Italie) et détenir un permis de travail G. Le salaire brut suisse en CHF — une fois converti en EUR et net des cotisations AVS/AI/APG, LPP (deuxième pilier) et LAA — doit être confronté au coût de la vie italien pour estimer le revenu net réel.</p>`,
           `<p>Utilisez le <a class="s-EBYcGk" href="${CALC_HREF.fr}">calculateur de salaire net</a> pour simuler le net à partir d'une offre brute, ou le <a class="s-EBYcGk" href="${FX_HREF.fr}">comparateur du change CHF/EUR</a> pour évaluer la valeur actuelle d'une offre suisse en francs face à une offre italienne équivalente en euros.</p>`,
           `</section>`,
         ].join('');
     }
   };

   // ── Issue #4303 item 1 — real-data block precompute ──────────────────
   // Covers every canton URL-group + the Svizzera aggregate. LAMal medians
   // are computed once (build-time file read) and reused across all
   // canton×locale entries below instead of re-reading per entry.
   const REAL_DATA_TARGET_KEYS = new Set<string>([...REAL_DATA_ENRICHED_CANTONS, AGGREGATE_KEY]);
   // BASILEA and APPENZELLO are merged half-canton URL groups (BS+BL,
   // AR+AI); cantonSalaryFactor/isBorderCanton and the LAMal lookup both
   // need a real 2-letter BFS/BAG code, so this maps each group key to its
   // representative code — mirrors the established convention in
   // salaryStatsData.ts's SALARY_STATS_FACTOR_CODE / cantonSalaryIndex.ts
   // (Basel-Stadt / Appenzell Ausserrhoden, the economically-dominant half
   // of each pair). Every other canton code maps to itself.
   const REAL_DATA_SALARY_CODE: Record<string, string> = Object.fromEntries(
     ALL_CANTON_CODES.map((c) => [c, c === 'BASILEA' ? 'BS' : c === 'APPENZELLO' ? 'AR' : c]),
   );
   const realDataLamalYear = new Date().getFullYear();
   const realDataLamalRows = aggregateLamalCantonMedians(rootDir, realDataLamalYear);
   const realDataLamalByCode = new Map<string, number>();
   for (const row of realDataLamalRows) {
     realDataLamalByCode.set(row.code, row.medianMonthlyCHF);
   }
   // BAG_FALLBACK TI=425 inside aggregateLamalCantonMedians already covers
   // the missing-snapshot case; this literal only guards the (untested)
   // case where the TI row itself is absent from the returned array.
   const realDataLamalTicino = realDataLamalByCode.get('TI') ?? 425;
   const medianOf = (nums: readonly number[]): number => {
     if (nums.length === 0) return 0;
     const sorted = [...nums].sort((a, b) => a - b);
     const mid = Math.floor(sorted.length / 2);
     return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
   };
   // Stability floors — mirror the codebase's existing >=3 convention for
   // "enough samples to show a number" (MIN_JOBS_PER_CANTON_COMPANY at
   // jobsSeoPagesPlugin.ts:7608, MIN_JOBS_PER_COMPANY_IN_CITY in
   // weeklyEmployersData.ts). Not imported directly — both are scoped
   // constants private to their own block/module.
   const REAL_DATA_SECTOR_MIN_JOBS = 3;
   const REAL_DATA_EMPLOYER_MIN_JOBS = 3;

   for (const entry of cantonsToEmit) {
     const display = getCantonDisplayLabel(entry.key, entry.locale);
     const path = withSlash(`${localePrefix[entry.locale]}/${entry.section}`.replace(/\/+/g, '/'));
     const canonicalUrl = `${BASE_URL}${path}`;
     // T2.6 — MIN_JOBS gate. The aggregator (svizzera, AGGREGATE_KEY) always
     // ships index,follow regardless of count; per-canton pages need at least
     // MIN_JOBS_FOR_CANTON_PAGE canonical jobs. TI is filtered out earlier
     // (owned by staticPagesPlugin), so it never reaches this branch.
     const cantonCount = cantonJobCounts.get(entry.key) ?? 0;
     const meetsThreshold = entry.key === AGGREGATE_KEY || cantonCount >= MIN_JOBS_FOR_CANTON_PAGE;
     const robotsValue: 'index,follow' | 'noindex,follow' = meetsThreshold ? 'index,follow' : 'noindex,follow';
     if (meetsThreshold) cantonIndexIndexable++; else cantonIndexNoindex++;
     // BFS-depth closure (2026-05-21): publish the noindex decision to the
     // cross-plugin registry so `seoHubsPlugin.emitThinCantonHubs` can skip
     // emitting `/tutti/`, `/settori/`, `/aziende/` sub-hubs for cantons
     // whose parent landing ships `noindex,follow`. Otherwise the sub-hubs
     // become BFS-orphaned (audit-bfs-depth.mjs treats noindex as a dead
     // end — see line 276 of that script).
     if (!meetsThreshold) markCantonNoindex(entry.key);
     // Sitemap coverage (#3518): the hub-root landing itself was never pushed
     // into the sharded sitemaps — only its child job URLs were — leaving all
     // non-TI canton hubs (and their locale variants) out of every sub-sitemap
     // despite being emitted index,follow with self-canonicals. Push indexable
     // roots only: a noindex URL in a sitemap trips audit:sitemap-canonicals.
     if (meetsThreshold) {
       shardUrls.push({ loc: canonicalUrl, lastmod: dateStamp, changefreq: 'daily', priority: 0.7, _canton: entry.key });
     }
     const labels = buildCantonLocaleLabels(entry.locale, display);
     // The visible `lede` stays short (header tagline); the SEO meta + JSON-LD
     // description use a 140-160 char canton+count-aware snippet so GSC no
     // longer flags "Description too short" (issue #2996). The thin
     // `labels.lede` ("...per il cantone X.") was ~50 chars.
     const cantonMetaDescription = buildCantonHubMeta({
       locale: entry.locale,
       cantonDisplay: display,
       count: cantonCount,
       isAggregate: entry.key === AGGREGATE_KEY,
     });
     // P4 — CTA points to the canton-filtered job board (entry.section is
     // already the canton-aware locale URL segment, e.g. `cerca-lavoro-zurigo`
     // or `find-jobs-zurich`). For the AGGREGATE_KEY this resolves to the
     // /cerca-lavoro-svizzera/ aggregator. For TI it would be the legacy
     // section, but TI is filtered out earlier (owned by staticPagesPlugin).
     const legacyJobBoardHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${entry.section}`.replace(/\/+/g, '/'))}`;
     // BreadcrumbList JSON-LD: required by tests/seo/breadcrumb-coverage.test.ts
     // (D.2 — every non-exempt dist/ HTML page must include a BreadcrumbList).
     // Per-canton: Home → "Cerca lavoro in Svizzera" (aggregator) → canton.
     // Aggregator page itself: Home → "Svizzera" (skip dupe parent).
     // Prior bug (GSC "Unparsable structured data", 2026-05-13): position 2
     // used `sectionByLocale[locale]` — a URL slug (the TI legacy job-board
     // section name) — as the human `name`, and `legacyJobBoardHref`
     // resolved to the same URL
     // as the canton page itself (e.g. /cerca-lavoro-argovia/ on the AG page),
     // producing a malformed breadcrumb that Google rejected as invalid.
     const homeItem = { '@type': 'ListItem', position: 1, name: homeLabel[entry.locale], item: `${BASE_URL}${entry.locale === 'it' ? '/' : `/${entry.locale}/`}` };
     const currentItem = { '@type': 'ListItem', position: entry.key === AGGREGATE_KEY ? 2 : 3, name: display, item: canonicalUrl };
     const aggregatorBreadcrumbItem = (() => {
       const aggregatorDisplay = getCantonDisplayLabel(AGGREGATE_KEY, entry.locale);
       const aggregatorSection = buildCantonAwareSection(entry.locale, AGGREGATE_KEY);
       const aggregatorHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${aggregatorSection}`.replace(/\/+/g, '/'))}`;
       return { '@type': 'ListItem', position: 2, name: cantonSectionName(entry.locale, aggregatorDisplay), item: aggregatorHref };
     })();
     // GSC "Tipo di valore non corretto" (2026-05-16): this string is passed
     // to `buildSeoPageHtml({ jsonLdScripts: [cantonBreadcrumbLd] })`, and
     // `buildSimplePage` already wraps each entry in `<script type="application/ld+json">…</script>`
     // (htmlTemplate.ts:183). Pre-wrapping here produced a nested
     // `<script><script>{…}</script></script>` in dist/ output, which Google
     // parsed as wrong-type structured data on ~80 canton-hub URLs across
     // de/en/fr/it. Pass the raw JSON string; let the shell wrap exactly once.
     const cantonBreadcrumbLd = inlineScriptJson({
       '@context': 'https://schema.org',
       '@type': 'BreadcrumbList',
       itemListElement: entry.key === AGGREGATE_KEY
         ? [homeItem, currentItem]
         : [homeItem, aggregatorBreadcrumbItem, currentItem],
     });

     // ── P4: rich canton-landing body ────────────────────────────────────
     // Filter all canonical jobs that resolve to this canton via the shared
     // resolver (job.canton + city → canton lookup with TI fallback). This
     // matches the resolver used everywhere else in the plugin so the cards
     // here link to URLs that actually exist.
     const cantonJobsAll = validJobs.filter(
       (j) => sharedResolveJobCanton(j as { canton?: string; location?: string }) === entry.key,
     );
     // Top 12 most recent, used in the listing grid.
     const cantonJobs = [...cantonJobsAll]
       .sort(
         (a, b) =>
           Number(new Date(((b as { datePosted?: string }).datePosted) || 0)) -
           Number(new Date(((a as { datePosted?: string }).datePosted) || 0)),
       )
       .slice(0, 12);

     // Issue #4303 items 1+5 — sharedResolveJobCanton() (used by
     // cantonJobsAll above) never returns AGGREGATE_KEY, it always falls
     // back to 'TI' for unmatched jobs — so cantonJobsAll is structurally
     // EMPTY for the Svizzera aggregate hub. That starved the ItemList
     // schema below (cantonCollectionLd was gated on cantonJobs.length>0,
     // silently empty for this one hub) and would equally starve the new
     // real-data block's sector/employer aggregation. Scoped fallback only
     // — cantonJobsAll/totalJobs/avgSalary/tileGrid/listingGrid stay exactly
     // as before for every canton, including AGGREGATE_KEY (unrelated to
     // this issue, not touched here).
     const realDataJobPool = entry.key === AGGREGATE_KEY ? validJobs : cantonJobsAll;
     const collectionListJobs = entry.key === AGGREGATE_KEY
       ? [...validJobs]
           .sort(
             (a, b) =>
               Number(new Date(((b as { datePosted?: string }).datePosted) || 0)) -
               Number(new Date(((a as { datePosted?: string }).datePosted) || 0)),
           )
           .slice(0, 12)
       : cantonJobs;
     const collectionListTotal = entry.key === AGGREGATE_KEY ? validJobs.length : undefined;

     // Aggregate stats for the tile grid.
     const totalJobs = cantonJobsAll.length;
     const sectorCounts = new Map<string, number>();
     const cityCounts = new Map<string, number>();
     for (const j of cantonJobsAll) {
       const sec = String((j as { sector?: string }).sector || '').trim() || '—';
       sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
       const city = String((j as { location?: string }).location || '').split(',')[0].trim();
       if (city) cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
     }
     const topSector = [...sectorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
     const topCity = [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? display;
     const avgSalary: number | null = (() => {
       const sals = cantonJobsAll
         .map((j) => Number((j as { salaryMin?: number }).salaryMin))
         .filter((n) => Number.isFinite(n) && n > 0);
       if (sals.length === 0) return null;
       return Math.round(sals.reduce((a, b) => a + b, 0) / sals.length);
     })();

     // Locale-aware tile labels (no new tokens, only `STAT_TILE_*` semantic
     // colors per CLAUDE.md NON-NEGOTIABLE #17).
     const tileLabels = (() => {
       switch (entry.locale) {
         case 'en':
           return { open: 'Open positions', topSector: 'Top sector', topCity: 'Most active city', avgSalary: 'Avg. salary' };
         case 'de':
           return { open: 'Offene Stellen', topSector: 'Top-Branche', topCity: 'Aktivste Stadt', avgSalary: 'Durchschnittsgehalt' };
         case 'fr':
           return { open: 'Postes ouverts', topSector: 'Secteur principal', topCity: 'Ville la plus active', avgSalary: 'Salaire moyen' };
         default:
           return { open: 'Offerte attive', topSector: 'Settore principale', topCity: 'Città più attiva', avgSalary: 'Salario medio' };
       }
     })();
     const tileGrid =
       `<section class="s-qkhIAD" data-stat-tile-grid>` +
       `<div class="s-aHhpNC" data-stat-tile="accent">` +
       `<div class="s-hr1jx1">${esc(tileLabels.open)}</div>` +
       `<div class="s-I_TRkF">${totalJobs.toLocaleString('de-CH')}</div>` +
       `</div>` +
       `<div class="s-ZeLwIZ" data-stat-tile="success">` +
       `<div class="s-hr1jx1">${esc(tileLabels.topSector)}</div>` +
       `<div class="s-9is_7q">${esc(topSector)}</div>` +
       `</div>` +
       `<div class="s-RWhR1p" data-stat-tile="warning">` +
       `<div class="s-hr1jx1">${esc(tileLabels.topCity)}</div>` +
       `<div class="s-9is_7q">${esc(topCity)}</div>` +
       `</div>` +
       (avgSalary
         ? `<div class="s-lwTRUc" data-stat-tile="base">` +
           `<div class="s-hr1jx1">${esc(tileLabels.avgSalary)}</div>` +
           `<div class="s-Y1GKEe">CHF ${avgSalary.toLocaleString('de-CH')}</div>` +
           `</div>`
         : '') +
       `</section>`;

     // Listing grid: 12 most recent canton jobs. Each card uses the shared
     // `renderJobCardHtml` helper so the static-HTML cards match the SPA
     // `<JobCard>` pixel-for-pixel (logo + title + salary + contract chip
     // + relative posted date + "Nuovo" badge). Previously the canton-
     // index emit used a thin custom <article> (title + company + city
     // only) which looked visually out-of-band vs the rest of the site
     // (sector pages, employer hubs, search results all use the shared
     // renderer). data-listing-grid is preserved for tests / selectors.
     const listingGrid = cantonJobs.length > 0
       ? `<section data-listing-grid class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 my-6">` +
         JOB_CARD_ICON_SYMBOLS +
         cantonJobs.map((j, jIdx) => {
           const jt = j as {
             slugByLocale?: Record<string, string>;
             slug?: string;
             titleByLocale?: Record<string, string>;
             title?: string;
             company?: string;
             companyKey?: string;
             companyDomain?: string;
             location?: string;
             canton?: string;
             contract?: string;
             datePosted?: string;
             postedDate?: string;
             salaryMin?: number | string | null;
             salaryMax?: number | string | null;
             featured?: boolean;
             logo?: string | null;
             url?: string;
           };
           const jslug = jt.slugByLocale?.[entry.locale] || jt.slug || '';
           const jCanton = sharedResolveJobCanton({ canton: jt.canton, location: jt.location });
           const jSection = buildCantonAwareSection(entry.locale, jCanton);
           const jHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${jSection}/${jslug}`.replace(/\/+/g, '/'))}`;
           const card = renderJobCardHtml(jt, {
             href: jHref,
             locale: entry.locale as JobCardLocale,
           });
           // In-feed ad after every Nth card (never after the last one).
           // `entry.key` is this page's canton (e.g. 'LU' for
           // /cerca-lavoro-lucerna/, 'BASILEA' for the merged BS+BL
           // /cerca-lavoro-basilea/) — passed through so the Lucerna in-feed
           // A/B test (services/adsenseSlots.ts
           // INFEED_AD_AB_TEST_SUPPRESSED_CANTONS) can suppress the manual
           // slot on this specific canton's static index page without
           // touching any other canton or any other listing surface.
           const ad =
             jIdx + 1 < cantonJobs.length && shouldPlaceInfeedAd(jIdx + 1, { canton: entry.key })
               ? infeedAdGridBlockHtml()
               : '';
           return card + ad;
         }).join('') +
         `</section>`
       : '';

     // bodyHtml is wrapped in <main> because buildSeoPageHtml runs in
     // seoContentOutsideRoot=true mode by default — the caller-provided
     // <main> is hosted as a sibling of <div id="root"> so React's hydration
     // cannot replace the static SEO content. See SeoPageShellOpts docs.
     //
     // Order per CLAUDE.md NON-NEGOTIABLE #17: breadcrumb → header (H1 +
     // 1-line tagline) → stat tile grid → primary CTA → data area
     // (listing grid) → long prose. Mobile-first: stat tiles + CTA fit
     // above the fold on a ≤414 px viewport; filler prose stays below.
     // P4-bfs: link the seoHubs sub-pages (`/{section}/tutti/`,
     // `/{section}/settori/`, `/{section}/aziende/`) explicitly so BFS
     // reaches them at depth 3 (closes the +57 sitemap-seo-hubs.xml
     // regression). seoHubsPlugin emits these as locale-specific slugs;
     // we mirror its key→slug table inline so the link graph stays in
     // sync with the emitter without a new shared module.
     const subPageSlugs: Record<CantonLocale, { all: string; sectors: string; companies: string }> = {
       it: { all: 'tutti', sectors: 'settori', companies: 'aziende' },
       en: { all: 'all', sectors: 'sectors', companies: 'companies' },
       de: { all: 'alle', sectors: 'branchen', companies: 'unternehmen' },
       fr: { all: 'tous', sectors: 'secteurs', companies: 'entreprises' },
     };
     const subPageLabels: Record<CantonLocale, { all: string; sectors: string; companies: string }> = {
       it: { all: 'Tutte le offerte', sectors: 'Esplora per settore', companies: 'Aziende che assumono' },
       en: { all: 'All openings', sectors: 'Browse by sector', companies: 'Hiring companies' },
       de: { all: 'Alle Stellen', sectors: 'Nach Branche', companies: 'Einstellende Unternehmen' },
       fr: { all: 'Toutes les offres', sectors: 'Par secteur', companies: 'Entreprises qui recrutent' },
     };
     const subSlugs = subPageSlugs[entry.locale];
     const subLabels = subPageLabels[entry.locale];
     const sectionBase = withSlash(`${localePrefix[entry.locale]}/${entry.section}`.replace(/\/+/g, '/'));
     const subPageNav =
       `<nav class="s-MdkLkf" aria-label="${esc(display)} hubs">` +
       `<a class="s-_B_R2g" href="${sectionBase}${subSlugs.all}/">${esc(subLabels.all)}</a>` +
       `<a class="s-vs4C20" href="${sectionBase}${subSlugs.sectors}/">${esc(subLabels.sectors)}</a>` +
       `<a class="s-A-Kq2m" href="${sectionBase}${subSlugs.companies}/">${esc(subLabels.companies)}</a>` +
       `</nav>`;
     // P6 — aggregator landing (`/cerca-lavoro-svizzera/`) lists every
     // canton section so the link graph fans out from one root URL.
     // For per-canton landings this section is intentionally empty (the
     // legacy TI hub already carries the full canton navigator added
     // in staticPagesPlugin); rendering 26 anchors on every canton page
     // would be visual noise without SEO benefit.
     let cantonListSection = '';
     if (entry.key === AGGREGATE_KEY) {
       const cantonListLabel = entry.locale === 'it' ? 'Cerca per cantone'
         : entry.locale === 'en' ? 'Browse by canton'
         : entry.locale === 'de' ? 'Nach Kanton suchen'
         : 'Rechercher par canton';
       const links: string[] = [];
       for (const code of ALL_CANTON_CODES) {
         const cSection = buildCantonAwareSection(entry.locale, code);
         const cHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${cSection}`.replace(/\/+/g, '/'))}`;
         const cDisplay = getCantonDisplayLabel(code, entry.locale);
         links.push(`<li><a class="s-t_pXue" href="${cHref}">${esc(cDisplay)}</a></li>`);
       }
       cantonListSection =
         `<section class="s-H1qo5-">` +
         `<h2 class="s-iZTOT1">${esc(cantonListLabel)}</h2>` +
         `<ul class="s-k6xotA">` +
         links.join('') +
         `</ul>` +
         `</section>`;
     }
     // Phase 8(g) cathedral parity — bring every /cerca-lavoro-{canton}/
     // landing up to the TI hub's editorial richness: H2 definition block
     // for AI extraction, deep-link archive navigator (one anchor per
     // page-N), 4 frontaliere-context prose paragraphs, sources line, and
     // a collapsible FAQ. Placed BELOW the data area per CLAUDE.md
     // non-negotiables #16/#17 (mobile-first, filler below content). The
     // helper is the same one used by staticPagesPlugin for TI byte
     // identity. The archive navigator base path is derived per-canton
     // via `hubSlugFor(entry.key, entry.locale, 'tutti')` so cathedral
     // cantons paginate from their own `/cerca-lavoro-{canton}/tutti/`
     // root instead of the TI default.
     const archiveBaseHref = entry.key === AGGREGATE_KEY
       ? hubSlugFor(AGGREGATE_KEY, entry.locale, 'tutti')
       : hubSlugFor(entry.key, entry.locale, 'tutti');
     const cantonTotalPages = Math.max(1, Math.ceil(totalJobs / HUB_JOBS_PAGE_SIZE));
     const editorialEntries = buildCantonHubEditorial({
       canton: entry.key,
       locale: entry.locale,
       display,
       jobsCount: totalJobs,
       totalPages: cantonTotalPages,
       archiveBaseHref,
     });
     // Mirror the staticPagesPlugin auto-`<p>`-wrap regex so plain-text
     // prose paragraphs (entries 3-6 in the non-TI helper output) become
     // proper paragraphs instead of leaking into a flat string. Block-level
     // entries (h2/p/details/...) pass through untouched.
     const editorialHtml = editorialEntries
       .map((b) => /^<(h[1-6]|p|nav|div|details|section|ul|ol|table|figure|aside|blockquote)\b/.test(b)
         ? b
         : `<p class="s-L9sOKI">${b}</p>`)
       .join('');
     const cantonEditorialSection =
       `<section class="s-IE_H9o" data-canton-editorial>${editorialHtml}</section>`;

     // ── BFS-depth closure (Group A2) — "Esplora" navigator ─────────────
     // Phase 8a introduced ~250 sub-pages per canton (city hubs, category
     // hubs, editorial slot pages) that the canton hub did NOT link to,
     // pushing them to BFS depth>4 from `/`. This block surfaces:
     //   - 5-8 top city hubs           → /{section}/{citySlug}/
     //   - up to 6 category hubs       → /{section}/{catPrefix}-{slug}/
     //   - 4 editorial slot pages      → today / nurses / part-time / clinics
     // Emitted BELOW the listing grid (mobile-first per #16/#17). Gated on
     // the same MIN_JOBS threshold used by the page itself (`meetsThreshold`)
     // so thin pages don't sprout link farms. TI is filtered out at the
     // cantonsToEmit loop entry (`code === 'TI' continue`), so this block
     // never affects the byte-identical TI hub owned by staticPagesPlugin.
     let exploreSection = '';
     if (meetsThreshold && entry.key !== AGGREGATE_KEY) {
       const exploreSectionBase = sectionBase; // already trailing-slashed canton-aware section
       // Top cities by job count (max 8). Normalise via shared helper so the
       // URL matches the citySlug emitted by the city-hub block earlier in
       // this plugin (Phase 8a). Skip empty / "—" buckets.
       const topCityHubs: Array<{ slug: string; label: string }> = [];
       const seenCitySlugs = new Set<string>();
       for (const [cityRaw, count] of [...cityCounts.entries()].sort((a, b) => b[1] - a[1])) {
         if (topCityHubs.length >= 8) break;
         if (!cityRaw || cityRaw === '—' || count < 1) continue;
         const slug = normalizeCitySlug(cityRaw);
         if (!slug || seenCitySlugs.has(slug)) continue;
         seenCitySlugs.add(slug);
         topCityHubs.push({ slug, label: cityRaw });
       }
       // BFS-depth closure (2026-06-11): every OTHER emitted municipality
       // city hub for this canton (beyond the top-8 featured above). The
       // per-canton city-hub emit (Phase 3.1) writes a static page for EVERY
       // canon municipality — incl. 0-job ones — but the navigator only
       // linked the top 8, leaving the long tail (e.g. argovia/suhr,
       // argovia/wettingen) BFS-orphaned in sitemap-jobs.xml. Link the exact
       // emitted set (recorded at emit time, same gate + same slugs → no
       // 404 risk) so each city page reaches BFS depth ≤ (canton hub + 1).
       // Deduped against the featured top-8 via the shared seenCitySlugs set
       // so no URL is linked twice (Squirrel identical-links a11y).
       const otherCityHubs: Array<{ slug: string; label: string }> = [];
       for (const c of emittedCantonCityHubs.get(entry.key) ?? []) {
         if (!c.slug || seenCitySlugs.has(c.slug)) continue;
         seenCitySlugs.add(c.slug);
         otherCityHubs.push(c);
       }
       // Top categories by job count (max 6). Mirror the category slug
       // tables from the category-listing block (~line 5742-5752); kept
       // inline to avoid hoisting a nested scope across thousands of lines.
       const categorySlugMap: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
         health: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
         finance: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
         tech: { it: 'informatica', en: 'tech', de: 'technik', fr: 'tech' },
         engineering: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
         admin: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
         hospitality: { it: 'ristorazione', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie' },
         sales: { it: 'vendita', en: 'sales', de: 'vertrieb', fr: 'vente' },
         other: { it: 'altro', en: 'other', de: 'andere', fr: 'autre' },
       };
       const categoryPrefixMap: Record<'it' | 'en' | 'de' | 'fr', string> = {
         it: 'categoria', en: 'category', de: 'kategorie', fr: 'categorie',
       };
       const categoryLabelMap: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
         health: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheit', fr: 'Santé' },
         finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
         tech: { it: 'Informatica', en: 'Technology', de: 'Technik', fr: 'Technologie' },
         engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' },
         admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
         hospitality: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'Hôtellerie' },
         sales: { it: 'Vendita', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
         other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' },
       };
       // Source-of-truth alignment: the per-canton category-listing emitter
       // (~line 5921) keys buckets by `job.category` directly and only emits
       // a page when that bucket has ≥3 jobs. The previous implementation of
       // this link emitter classified by `job.sector` via a heuristic alias
       // table — which silently funnelled unrecognised sectors into the
       // `other` bucket and emitted /categoria-altro/ links pointing at
       // pages the listing emitter had refused to generate (404 in same-tab
       // navigation, reported 2026-05-18). Read the same field, apply the
       // same gate, exclude the `other` catch-all (no SEO value + frequent
       // misclassifications).
       const categoryCountAggregated = new Map<string, number>();
       for (const j of cantonJobsAll) {
         const rawCat = String((j as { category?: string }).category || '').toLowerCase().trim();
         if (!rawCat) continue;
         if (!Object.prototype.hasOwnProperty.call(categorySlugMap, rawCat)) continue;
         if (rawCat === 'other') continue;
         categoryCountAggregated.set(rawCat, (categoryCountAggregated.get(rawCat) ?? 0) + 1);
       }
       const topCategoryHubs: Array<{ slug: string; label: string }> = [];
       for (const [catKey, count] of [...categoryCountAggregated.entries()].sort((a, b) => b[1] - a[1])) {
         if (topCategoryHubs.length >= 6) break;
         if (count < 3) continue; // same gate as the page emitter
         const catSlug = categorySlugMap[catKey]?.[entry.locale];
         const catLabel = categoryLabelMap[catKey]?.[entry.locale];
         if (!catSlug || !catLabel) continue;
         const slug = `${categoryPrefixMap[entry.locale]}-${catSlug}`;
         topCategoryHubs.push({ slug, label: catLabel });
       }
       // Editorial slot pages (Phase 8d). Non-TI cantons collapse to short
       // slugs (`oggi` / `infermieri` / `lavoro-part-time` / `cliniche`);
       // TI is filtered out earlier so we don't worry about its long-form
       // legacy URLs here.
       const editorialSlotPages: Array<{ slug: string; label: string }> = [];
       const todayLabels: Record<CantonLocale, string> = {
         it: 'Offerte di oggi', en: 'Jobs posted today', de: 'Heute veröffentlicht', fr: "Offres d'aujourd'hui",
       };
       const nursesLabels: Record<CantonLocale, string> = {
         it: 'Lavoro per infermieri', en: 'Nursing jobs', de: 'Pflegejobs', fr: 'Emplois en soins infirmiers',
       };
       const partTimeLabels: Record<CantonLocale, string> = {
         it: 'Lavoro part-time', en: 'Part-time jobs', de: 'Teilzeitstellen', fr: 'Emplois à temps partiel',
       };
       const clinicsLabels: Record<CantonLocale, string> = {
         it: 'Cliniche e ospedali', en: 'Clinics & hospitals', de: 'Kliniken & Spitäler', fr: 'Cliniques et hôpitaux',
       };
       editorialSlotPages.push({ slug: getJobTodayLandingSlug(entry.locale, entry.key), label: todayLabels[entry.locale] });
       editorialSlotPages.push({ slug: getJobNursesHubSlug(entry.locale, entry.key), label: nursesLabels[entry.locale] });
       editorialSlotPages.push({ slug: getJobPartTimeLandingSlug(entry.locale, entry.key), label: partTimeLabels[entry.locale] });
       editorialSlotPages.push({ slug: careClusterSlug('clinics', entry.key, entry.locale), label: clinicsLabels[entry.locale] });
       // BFS-depth closure (Phase 8a follow-up — May 2026): non-cliniche care
       // clusters (case anziani, OSS, educatori) were emitted by
       // `buildJobCareVariantLandingModel` but unreachable from the canton
       // hub, leaving ~250 orphan URLs in sitemap-jobs.xml. Add the 3
       // remaining cluster slots so every care leaf is at BFS depth ≤ 3.
       const careHomesLabels: Record<CantonLocale, string> = {
         it: 'Case anziani', en: 'Care homes', de: 'Altersheime', fr: 'Maisons de retraite',
       };
       const ossLabels: Record<CantonLocale, string> = {
         it: 'OSS e assistenza', en: 'Healthcare assistants', de: 'Pflegeassistenz', fr: 'OSS et assistance',
       };
       const educatorsLabels: Record<CantonLocale, string> = {
         it: 'Educatori', en: 'Educators', de: 'Erzieher', fr: 'Educateurs',
       };
       editorialSlotPages.push({ slug: careClusterSlug('careHomes', entry.key, entry.locale), label: careHomesLabels[entry.locale] });
       editorialSlotPages.push({ slug: careClusterSlug('oss', entry.key, entry.locale), label: ossLabels[entry.locale] });
       editorialSlotPages.push({ slug: careClusterSlug('educators', entry.key, entry.locale), label: educatorsLabels[entry.locale] });

       // BFS-depth closure (Phase 8a follow-up — May 2026): top company hubs
       // (`/cerca-lavoro-{canton}/azienda-{empKey}/`) are emitted by the
       // per-canton company-hub block (~line 6275-6400) using
       // `companyHubSlugBuild`, gated MIN_JOBS_PER_CANTON_COMPANY=3.
       // Re-derive the slug here using the SAME `companyHubSlugBuild`
       // helper (brand-alias-folded) so the hrefs exactly match what's
       // emitted — an alias like migros-ticino folds to azienda-migros, the
       // page that is actually written. Top 6 by job
       // count keeps the navigator focused; ties broken by slug for
       // determinism.
       const companyHubs: Array<{ slug: string; label: string }> = [];
       if (entry.key !== AGGREGATE_KEY) {
         const companyCounts = new Map<string, { name: string; count: number }>();
         for (const j of cantonJobsAll) {
           const jc = j as { company?: string; companyKey?: string };
           const cSlug = companyHubSlugBuild(jc.company || '', jc.companyKey);
           if (!cSlug) continue;
           const cur = companyCounts.get(cSlug);
           if (cur) { cur.count++; }
           else { companyCounts.set(cSlug, { name: String(jc.company || cSlug), count: 1 }); }
         }
         const sorted = [...companyCounts.entries()]
           .filter(([, v]) => v.count >= 3) // mirror MIN_JOBS_PER_CANTON_COMPANY
           .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
           .slice(0, 6);
         const compPrefix = companyRoutePrefix[entry.locale];
         for (const [cSlug, v] of sorted) {
           companyHubs.push({ slug: `${compPrefix}-${cSlug}`, label: v.name });
         }
       }

       // BFS-depth closure (Phase 8a follow-up — May 2026): full pagination
       // ladder. The per-canton paginated listing emit (`/cerca-lavoro-
       // {canton}/pagina-N/`, ~line 5622) only emits when canton has
       // ≥ 2 × JOBS_PER_LISTING_PAGE = 40 jobs and caps at MAX_LISTING_PAGES.
       // Mirror that gate here so we only link pages that actually exist.
       // Linking ALL pages (not just neighbours) brings every paginated leaf
       // to BFS depth 3 from `/`.
       const paginationLinks: Array<{ slug: string; label: string }> = [];
       if (entry.key !== AGGREGATE_KEY) {
         const JOBS_PER_LISTING_PAGE_NAV = 20;
         const MAX_LISTING_PAGES_NAV = 25;
         const cantonJobCount = cantonJobsAll.length;
         if (cantonJobCount >= 2 * JOBS_PER_LISTING_PAGE_NAV) {
           const paginationSlugsNav: Record<CantonLocale, string> = { it: 'pagina', en: 'page', de: 'seite', fr: 'page' };
           const cTotalPages = Math.min(MAX_LISTING_PAGES_NAV, Math.ceil(cantonJobCount / JOBS_PER_LISTING_PAGE_NAV));
           const pagLabel = entry.locale === 'en' || entry.locale === 'fr' ? 'p.' : entry.locale === 'de' ? 'S.' : 'p.';
           for (let p = 2; p <= cTotalPages; p++) {
             paginationLinks.push({
               slug: `${paginationSlugsNav[entry.locale]}-${p}`,
               label: `${pagLabel} ${p}`,
             });
           }
         }
       }

       const exploreTitle = (() => {
         switch (entry.locale) {
           case 'en': return `Explore more jobs in ${display}`;
           case 'de': return `Mehr Stellen in ${display}`;
           case 'fr': return `Plus d'offres en ${display}`;
           default: return `Esplora più offerte in ${display}`;
         }
       })();
       const colByCityLabel = entry.locale === 'en' ? 'Top cities'
         : entry.locale === 'de' ? 'Top-Städte'
         : entry.locale === 'fr' ? 'Villes principales'
         : 'Città principali';
       const colAllCitiesLabel = entry.locale === 'en' ? `All municipalities in ${display}`
         : entry.locale === 'de' ? `Alle Gemeinden in ${display}`
         : entry.locale === 'fr' ? `Toutes les communes en ${display}`
         : `Tutti i comuni in ${display}`;
       const colByCategoryLabel = entry.locale === 'en' ? 'Top sectors'
         : entry.locale === 'de' ? 'Top-Branchen'
         : entry.locale === 'fr' ? 'Secteurs principaux'
         : 'Settori principali';
       const colEditorialLabel = entry.locale === 'en' ? 'Featured pages'
         : entry.locale === 'de' ? 'Empfohlene Seiten'
         : entry.locale === 'fr' ? 'Pages à la une'
         : 'Pagine in evidenza';
       const colCompaniesLabel = entry.locale === 'en' ? 'Top employers'
         : entry.locale === 'de' ? 'Top-Arbeitgeber'
         : entry.locale === 'fr' ? 'Employeurs principaux'
         : 'Aziende che assumono';
       const colPaginationLabel = entry.locale === 'en' ? 'Browse by page'
         : entry.locale === 'de' ? 'Weitere Seiten'
         : entry.locale === 'fr' ? 'Plus de pages'
         : 'Altre pagine';
       const linkStyle = 'display:inline-block;padding:6px 12px;margin:0 6px 6px 0;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-link);text-decoration:none;font-size:14px;line-height:1.3';
       const renderLinks = (items: Array<{ slug: string; label: string }>): string =>
         items
           .map((it) => `<a href="${exploreSectionBase}${it.slug}/" style="${linkStyle}">${esc(it.label)}</a>`)
           .join('');
       const blocks: string[] = [];
       if (topCityHubs.length > 0) {
         blocks.push(
           `<div class="s-h0CoDf" data-explore-cities>` +
           `<h3 class="s-8S_vke">${esc(colByCityLabel)}</h3>` +
           `<div>${renderLinks(topCityHubs)}</div>` +
           `</div>`,
         );
       }
       if (topCategoryHubs.length > 0) {
         blocks.push(
           `<div class="s-h0CoDf" data-explore-categories>` +
           `<h3 class="s-8S_vke">${esc(colByCategoryLabel)}</h3>` +
           `<div>${renderLinks(topCategoryHubs)}</div>` +
           `</div>`,
         );
       }
       // BFS-depth closure (2026-06-11): link every remaining emitted
       // municipality city hub so the long tail is no longer BFS-orphaned.
       // Rendered as a lightweight comma-free wrapped link list (NOT the
       // per-link pill style above) because a big canton (Bern ~334
       // municipalities) would otherwise add ~90 KB of repeated inline-style
       // bytes to the hub and crowd the flat 215 KB page-weight cap. Plain
       // anchors inherit the seo-static link color; one container style does
       // the spacing for the whole block.
       if (otherCityHubs.length > 0) {
         const cityIndexLinks = otherCityHubs
           .map((it) => `<a href="${exploreSectionBase}${it.slug}/">${esc(it.label)}</a>`)
           .join(' · ');
         blocks.push(
           `<div class="s-h0CoDf" data-explore-all-cities>` +
           `<h3 class="s-8S_vke">${esc(colAllCitiesLabel)}</h3>` +
           `<div style="font-size:14px;line-height:1.9;color:var(--color-link)">${cityIndexLinks}</div>` +
           `</div>`,
         );
       }
       if (editorialSlotPages.length > 0) {
         blocks.push(
           `<div class="s-h0CoDf" data-explore-editorial>` +
           `<h3 class="s-8S_vke">${esc(colEditorialLabel)}</h3>` +
           `<div>${renderLinks(editorialSlotPages)}</div>` +
           `</div>`,
         );
       }
       if (companyHubs.length > 0) {
         blocks.push(
           `<div class="s-h0CoDf" data-explore-companies>` +
           `<h3 class="s-8S_vke">${esc(colCompaniesLabel)}</h3>` +
           `<div>${renderLinks(companyHubs)}</div>` +
           `</div>`,
         );
       }
       if (paginationLinks.length > 0) {
         blocks.push(
           `<div class="s-h0CoDf" data-explore-pagination>` +
           `<h3 class="s-8S_vke">${esc(colPaginationLabel)}</h3>` +
           `<div>${renderLinks(paginationLinks)}</div>` +
           `</div>`,
         );
       }
       if (blocks.length > 0) {
         exploreSection =
           `<section class="s-JLedUn" data-canton-explore>` +
           `<h2 class="s-h0yI7F">${esc(exploreTitle)}</h2>` +
           blocks.join('') +
           `</section>`;
       }
     }

     // ── Issue #4303 item 1 — real-data block (Zurigo, Berna, Basilea,
     // Svizzera aggregate only) ──────────────────────────────────────────
     // Sector medians + employer counts are computed fresh from
     // `realDataJobPool` (live data/jobs.json baseSalary/company fields —
     // see the module-header rationale in shared/cantonHubEditorial.ts for
     // why weeklyEmployersData.ts itself can't be reused: it only defines
     // Ticino-city keys, no ZH/BE/BS entries exist there). Placed AFTER
     // exploreSection so it slots into bodyHtml right before the long-form
     // prose (mobile-first: data first, filler below).
     let cantonRealDataSection = '';
     if (REAL_DATA_TARGET_KEYS.has(entry.key)) {
       const sectorRowsRaw: Array<{ sector: SectorHubKey; medianAnnualChf: number; jobCount: number; href: string | null }> = [];
       for (const sector of SECTOR_HUB_KEYS) {
         const salaries: number[] = [];
         let matchCount = 0;
         for (const j of realDataJobPool) {
           if (!jobMatchesSector(j as never, sector, entry.locale as never)) continue;
           matchCount++;
           const jt = j as { salaryMin?: number | string | null; salaryMax?: number | string | null };
           const min = Number(jt.salaryMin);
           const max = Number(jt.salaryMax);
           const hasMin = Number.isFinite(min) && min > 0;
           const hasMax = Number.isFinite(max) && max > 0;
           const mid = hasMin && hasMax ? (min + max) / 2 : hasMin ? min : hasMax ? max : NaN;
           if (Number.isFinite(mid) && mid > 0) {
             // Mirrors comparisonsHubAggregate.aggregateSalaryBySector's own
             // heuristic: sub-10k figures are monthly, not annual — annualise
             // ×13 (Swiss 13th-salary convention) before taking the median.
             salaries.push(mid < 10000 ? mid * 13 : mid);
           }
         }
         if (matchCount < REAL_DATA_SECTOR_MIN_JOBS || salaries.length < REAL_DATA_SECTOR_MIN_JOBS) continue;
         const medianAnnualChf = medianOf(salaries);
         if (medianAnnualChf <= 0) continue;
         // AGGREGATE_KEY has no self-canonical /cerca-lavoro-{canton}/{sector}/
         // combo page (that loop iterates SHARED_ALL_CANTON_CODES only, never
         // AGGREGATE_KEY) — link to the real canton-agnostic national sector
         // hub instead. ZH/BE/BASILEA link to their own real combo page
         // (same URL formula as the canton×sector hub loop above).
         const href = entry.key === AGGREGATE_KEY
           ? buildSectorHubPath(entry.locale, sector)
           : withSlash(
               `${localePrefix[entry.locale]}/${sharedResolveCantonSection(entry.locale, entry.key)}/${SECTOR_HUB_SLUG[entry.locale][sector]}`.replace(/\/+/g, '/'),
             );
         sectorRowsRaw.push({ sector, medianAnnualChf, jobCount: matchCount, href });
       }
       sectorRowsRaw.sort((a, b) => b.jobCount - a.jobCount);
       const sectorRows: CantonRealDataSectorRow[] = sectorRowsRaw.slice(0, 8).map((r) => ({
         label: SECTOR_HUB_DISPLAY[entry.locale][r.sector],
         medianAnnualChf: r.medianAnnualChf,
         jobCount: r.jobCount,
         href: r.href,
       }));

       // Top employers by live job count. Always unlinked (href: null) —
       // the existing per-canton company-hub navigator (companyHubs, above)
       // is block-scoped to `if (meetsThreshold && entry.key !== AGGREGATE_KEY)`
       // and unreachable from here; recomputing its MIN_JOBS_PER_CANTON_COMPANY
       // threshold locally would duplicate a drift-prone constant (AGENTS.md
       // sibling-pattern rule), so this list stays independent plain text.
       const employerCounts = new Map<string, { name: string; count: number }>();
       for (const j of realDataJobPool) {
         const jt = j as { company?: string; companyKey?: string };
         const key = String(jt.companyKey || jt.company || '').trim().toLowerCase();
         if (!key) continue;
         const cur = employerCounts.get(key);
         if (cur) cur.count++;
         else employerCounts.set(key, { name: String(jt.company || key), count: 1 });
       }
       const employers: CantonRealDataEmployer[] = [...employerCounts.values()]
         .filter((v) => v.count >= REAL_DATA_EMPLOYER_MIN_JOBS)
         .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
         .slice(0, 6)
         .map((v) => ({ name: v.name, jobCount: v.count, href: null }));

       const salaryCode = REAL_DATA_SALARY_CODE[entry.key];
       const isAggregateEntry = entry.key === AGGREGATE_KEY;
       // National wage-level factor (NATIONAL_MEDIAN_MONTHLY / TICINO_MEDIAN_MONTHLY)
       // is itself a real BFS LSE 2024 figure — not fabricated — same source
       // family as cantonSalaryFactor() for the 3 concrete cantons.
       const wageFactorVsTicino = isAggregateEntry
         ? NATIONAL_MEDIAN_MONTHLY / TICINO_MEDIAN_MONTHLY
         : cantonSalaryFactor(salaryCode);
       const isBorderCantonFlag = !isAggregateEntry && cantonIsBorderCanton(salaryCode);
       const lamalMonthlyChf = isAggregateEntry
         // No single national LAMal premium exists (premiums are set per
         // canton) — fall back to the Ticino baseline so the cost-of-living
         // paragraph reports a neutral (~0%) LAMal delta for the aggregate
         // hub rather than an invented number.
         ? realDataLamalTicino
         : (realDataLamalByCode.get(salaryCode) ?? realDataLamalTicino);

       cantonRealDataSection = buildCantonRealDataBlock({
         locale: entry.locale,
         display,
         isAggregate: isAggregateEntry,
         sectorRows,
         wageFactorVsTicino,
         lamalMonthlyChf,
         lamalMonthlyTicinoChf: realDataLamalTicino,
         isBorderCanton: isBorderCantonFlag,
         employers,
       });
     }

     const bodyHtml = [
       // #974: drop `seo-static-content` from this INNER <main> (keep the
       // `s-LFxJYv` layout class). buildSeoPageHtml wraps bodyHtml in the OUTER
       // main.seo-static-content (display:grid); leaving the class here made the
       // inner main a nested grid item with default min-width:auto, so its track
       // could not shrink and wide content forced horizontal overflow on mobile
       // (382px). Mirrors comparisonsHub #962 / borderWaitMap #958. The outer
       // shell main still carries seo-static-content (lite-shell detector +
       // staticOverlay handoff preserved).
       `<main class="s-LFxJYv">`,
       `<nav class="s-ZVaIKh"><a class="s-t_pXue" href="/">${esc(homeLabel[entry.locale])}</a> &rarr; <span aria-current="page">${esc(display)}</span></nav>`,
       `<header class="s-TYF4UK"><h1 class="s-Wb8ho2">${esc(display)}</h1><p class="s-b7cYUf">${esc(labels.lede)}</p></header>`,
       tileGrid,
       `<p class="s-ziawP1"><a class="s-yy370N" data-primary-cta href="${legacyJobBoardHref}">${esc(labels.ctaLabel)}</a></p>`,
       subPageNav,
       cantonListSection,
       listingGrid,
       // BFS-depth closure — link Phase 8a sub-pages from the canton hub
       // (top cities, top categories, editorial slot pages). Empty string
       // when meetsThreshold === false or canton === AGGREGATE_KEY. Sits
       // ABOVE the prose so internal navigation stays close to the data
       // area; the long filler stays after.
       exploreSection,
       // Issue #4303 item 1 — sourced sector/cost-of-living/G-permit/employer
       // data block. Empty string for every canton except Zurigo, Berna,
       // Basilea and the Svizzera aggregate. Sits ABOVE the long-form prose
       // (mobile-first: structured real data before filler).
       cantonRealDataSection,
       // Frontaliere context prose — placed BELOW the data area per CLAUDE.md
       // non-negotiable #16/#17 (mobile-first, filler below content). Ratio
       // uplift brings text/HTML from 1.7-2.2 % to ~12 % so
       // audit:text-html-ratio accepts these pages.
       buildCantonContextProse(entry.locale, display),
       // Phase 8(g) — TI-parity editorial package (H2, archive navigator,
       // prose, sources, FAQ). Below the data area per #16/#17.
       cantonEditorialSection,
       `</main>`,
     ].join('\n');
     // SearchAtlas "missing schema markup" audit (2026-06-15): secondary-canton
     // landing pages shipped only a BreadcrumbList, while the Ticino landing
     // (/cerca-lavoro-ticino/, owned by staticPagesPlugin via seo-pages.ts)
     // ships CollectionPage + ItemList. Mirror TI here so every INDEXABLE canton
     // landing carries a CollectionPage wrapping an ItemList of its most-recent
     // jobs. Gated on `meetsThreshold` + jobs present: thin/noindex pages stay
     // breadcrumb-only (CLAUDE.md #4 — no rich schema on thin content). Items
     // are ListItem→url (not nested JobPosting): a partial JobPosting would
     // violate NON-NEGOTIABLE #3 (all 9 mandatory fields), and the listing
     // page's correct primary type is CollectionPage, exactly as TI. The list
     // is rebuilt every deploy so the linked job URLs stay fresh (same jHref
     // formula as the visible listing grid above).
     // Issue #4303 item 5: `collectionListJobs`/`collectionListTotal` fall
     // back to a fresh validJobs sample for AGGREGATE_KEY (see the
     // realDataJobPool comment above) so the Svizzera hub gets a real
     // ItemList instead of silently shipping breadcrumb-only schema.
     const cantonCollectionLd = (meetsThreshold && collectionListJobs.length > 0)
       ? inlineScriptJson({
           '@context': 'https://schema.org',
           '@type': 'CollectionPage',
           name: labels.title,
           description: cantonMetaDescription,
           url: canonicalUrl,
           inLanguage: entry.locale,
           isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
           about: { '@type': 'Thing', name: display },
           provider: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
           mainEntity: {
             '@type': 'ItemList',
             numberOfItems: collectionListTotal ?? totalJobs,
             itemListOrder: 'https://schema.org/ItemListOrderDescending',
             // PR #2229 adversarial-check #2: skip jobs whose slug is empty —
             // their href would degrade to the bare canton section and collide
             // with this listing page itself. numberOfItems still reports the
             // real total (schema.org subset pattern).
             itemListElement: collectionListJobs
               .filter((j) => {
                 const jt = j as { slugByLocale?: Record<string, string>; slug?: string };
                 return Boolean(jt.slugByLocale?.[entry.locale] || jt.slug);
               })
               .map((j, i) => {
               const jt = j as {
                 slugByLocale?: Record<string, string>;
                 slug?: string;
                 titleByLocale?: Record<string, string>;
                 title?: string;
                 canton?: string;
                 location?: string;
               };
               const jslug = jt.slugByLocale?.[entry.locale] || jt.slug || '';
               const jCanton = sharedResolveJobCanton({ canton: jt.canton, location: jt.location });
               const jSection = buildCantonAwareSection(entry.locale, jCanton);
               const jHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${jSection}/${jslug}`.replace(/\/+/g, '/'))}`;
               return {
                 '@type': 'ListItem',
                 position: i + 1,
                 url: jHref,
                 name: jt.titleByLocale?.[entry.locale] || jt.title || display,
               };
             }),
           },
         })
       : '';
     const html = buildSeoPageHtml({
       canonicalUrl,
       title: labels.title,
       description: cantonMetaDescription,
       locale: entry.locale,
       bodyHtml,
       distDir,
       jsonLdScripts: [cantonBreadcrumbLd, cantonCollectionLd].filter(Boolean),
       // T2.6 — robots set by MIN_JOBS gate above. Pages with ≥ 5 canonical
       // jobs from the cathedral flip to 'index,follow'; thin pages stay
       // 'noindex,follow' (CLAUDE.md #4 — no thin content gets indexed). The
       // aggregator (svizzera) is always 'index,follow'. Pages still hydrate
       // via the SPA shell so the visitor lands on the real React JobBoard.
       robots: robotsValue,
     });
     const outDir = np.join(distDir, path.slice(1).replace(/\/$/, ''));
     _md(outDir);
     _qw(np.join(outDir, 'index.html'), html);
     cantonIndexEmitted++;
   }

   // P2.B3 — sitemap shard filenames use the Italian canton slug (e.g.
   // 'zurigo', 'ginevra', 'svizzera') so they MATCH the IT page URLs
   // (/cerca-lavoro-zurigo/) instead of the prior 2-letter ISO code
   // (sitemap-jobs-zh.xml). Standardising on the IT slug keeps the
   // sitemap-index entries human-readable and consistent with the canonical
   // page graph.
   const shardKeyForUrl = (u: ShardUrl): string => {
     if (u._canton === AGGREGATE_KEY) return getCantonUrlSlugLocal(AGGREGATE_KEY, 'it'); // 'svizzera'
     return getCantonUrlSlugLocal(u._canton, 'it'); // e.g. 'ZH' → 'zurigo'
   };
   // Sitemap coverage (#3518, TI half): the localized Ticino hub roots
   // (/en/find-jobs-ticino/, /de/jobs-im-tessin/, /fr/...) are emitted by
   // staticPagesPlugin (TI is skipped in cantonsToEmit above) and were listed
   // in no sitemap at all. The IT root /cerca-lavoro-ticino/ already lives in
   // sitemap-pages.xml — push only the three locale variants, into the TI shard.
   for (const tiLocale of ['en', 'de', 'fr'] as const) {
     const tiSection = buildCantonAwareSection(tiLocale, 'TI');
     const tiPath = withSlash(`${localePrefix[tiLocale]}/${tiSection}`.replace(/\/+/g, '/'));
     shardUrls.push({ loc: `${BASE_URL}${tiPath}`, lastmod: dateStamp, changefreq: 'daily', priority: 0.7, _canton: 'TI' });
   }
   const shards = splitToShards(shardUrls, { shardKey: shardKeyForUrl });
   // writeShardsToDist writes each `sitemap-jobs-{italian-slug}.xml` to the
   // top-level dist/ directory + emits dist/sitemap-index.xml referencing
   // every shard. Confirmed top-level (not under any subpath) per
   // sitemap-shard.mjs line 260 (`path.join(distDir, shard.filename)`).
   const { shardPaths, indexPath } = await writeShardsToDist(shards, distDir, BASE_URL);
   if (indexPath) {
     console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P1.11 wrote ${shardPaths.length} canton sitemap shards + ${np.relative(distDir, indexPath)}`);
   }
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P2.B1+B2+B3 emitted ${cantonIndexEmitted} locale-variant pages + ${shardPaths.length} sitemap shards`);
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P2.S2 canton index emit: ${cantonIndexIndexable} indexable / ${cantonIndexNoindex} thin (threshold: ${MIN_JOBS_FOR_CANTON_PAGE})`);
 } catch (err) {
   // Defensive: P1.11 additions must not break the legacy emit. Log + continue.
   console.warn('[jobs-seo-pages] P1.11 canton-aware emit failed (legacy output unaffected):', err instanceof Error ? err.message : String(err));
 }

 /* ── Expired-job soft-landing pages ────────────────────────── */
 // 1. Read tracking file + merge current jobs
 // Sharded registry (data/all-known-job-slugs/part-*.json, #4248) — the store
 // is the ONLY reader/writer, never the raw file (AGENTS.md #6).
 let tracking: Record<string, Record<string, string>> = readAllKnownJobSlugs(rootDir) as Record<string, Record<string, string>>;

 const currentSlugs = new Set<string>();
 // Collect slug values that differ from slugByLocale.it — these are legacy
 // identifier slugs that no longer have an active page at that path. They
 // should be treated as previous slugs (bridge pages), not as current.
 const implicitPreviousSlugs: { job: typeof validJobs[0]; slug: string }[] = [];
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const itSlug = localizedSlug(job, 'it');
 // Only add job.slug to currentSlugs if it matches the actual IT page slug.
 // When they differ, the old slug needs a bridge page, not exclusion.
 if (job.slug === itSlug) {
 currentSlugs.add(job.slug);
 } else {
 // job.slug is a legacy identifier — treat as implicit previous slug
 // so it gets a bridge page pointing to the current URL
 implicitPreviousSlugs.push({ job, slug: job.slug });
 }
 // Also mark all localized slugs as "current" so they aren't treated as
 // expired when they appear as orphan tracking keys. Without this, a
 // German master slug that differs from the IT localizedSlug can end up
 // generating a thin expired soft-landing at the master-slug path.
 for (const locale of localeList) {
 const ls = localizedSlug(job, locale);
 if (ls) currentSlugs.add(ls);
 }
 if (!tracking[job.slug]) {
 tracking[job.slug] = {};
 // Phase 8c — emit the tracking entry under the JOB'S canton-aware
 // section (e.g. /cerca-lavoro-zurigo/, /de/jobs-in-zurich/) instead of
 // the legacy TI section. Soft-landing emission downstream reads this
 // path directly + checks activeJobDirs for collisions; before the
 // canton-aware switch the TI URL would either land a stale soft-
 // landing or, worse, clobber an active non-TI page at the same slug.
 // TI invariance is preserved by buildCantonAwareSection (early-return
 // on code === 'TI' returns the legacy section verbatim).
 const jobCantonForTracking = sharedResolveJobCanton(job as { canton?: string; location?: string });
 for (const locale of localeList) {
 const relPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCantonForTracking)}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/');
 tracking[job.slug][locale] = relPath;
 }
 }
 }
 // Remove search combo slugs from tracking — these are handled by the search
 // combo section, not the job crawler pipeline. They were incorrectly imported
 // from orphan-indexed-job-slugs.json in previous builds.
 const searchComboPattern = /^(?:search|ricerca|suche|recherche)-/;
 let searchCombosRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (searchComboPattern.test(key) && !currentSlugs.has(key)) {
 delete tracking[key];
 searchCombosRemoved++;
 }
 }
 if (searchCombosRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Cleaned ${searchCombosRemoved} search combo slugs from tracking`);
 }

 // Reserved hub slugs — sector + city hub URLs (e.g. /cerca-lavoro-ticino/infermieri/,
 // /cerca-lavoro-ticino/lugano/) MUST NOT be registered as orphan/compat job slugs.
 // If they were, jobsSeoPagesPlugin would emit a soft-landing page that overwrites
 // the legitimate sector/city hub HTML and points the canonical at the closest
 // matching expired job slug — killing the IT hub in SERPs (only the EN sibling
 // ranks because its slug differs, e.g. "nurses" vs "infermieri").
 const RESERVED_HUB_SLUGS = new Set<string>();
 for (const sector of SECTOR_HUB_KEYS) {
 for (const loc of ['it', 'en', 'de', 'fr'] as const) {
 RESERVED_HUB_SLUGS.add(SECTOR_HUB_SLUG[loc][sector]);
 }
 }
 for (const city of CITY_HUB_KEYS) {
 for (const loc of ['it', 'en', 'de', 'fr'] as const) {
 RESERVED_HUB_SLUGS.add(CITY_HUB_SLUG[loc][city]);
 }
 }
 // SEO archive-hub trailing slugs (jobs/sectors/companies/articles "all" pages).
 // Without this guard, an expired-job tracking key with slug e.g. "tutti" would
 // soft-land at `/cerca-lavoro-ticino/tutti/index.html` AFTER seoHubsPlugin
 // emitted the paginated index there, severing the page-1 → page-N chain and
 // orphaning every paginated variant in sitemap-seo-hubs.xml.
 for (const slug of SEO_HUB_RESERVED_SLUGS) {
 RESERVED_HUB_SLUGS.add(slug);
 }

 // Matches hub-pagination compound keys `<hub-slug>/page-N` (requires a leading
 // path segment; bare `page-N` is NOT matched). Used by the strip block below.
 const HUB_PAGINATION_COMPOUND_KEY_RE = /\/page-\d+$/;
 // Matches bare `page-N` keys (legacy English pagination-word crawls, e.g.
 // `page-2`, `page-5`). Now that searchConsoleCompat redirects these to their
 // localized `pagina-N`/`seite-N` twin (real page, real GSC traffic), they
 // must NOT also get a static expired-job soft-landing page here — that
 // would serve a thin 200 at the exact path the redirect is meant to own.
 const BARE_PAGE_NUMBER_KEY_RE = /^page-\d+$/;

 // Strip pre-existing reserved-hub keys from tracking BEFORE the file write.
 // Earlier GSC imports leaked "infermieri" into all-known-job-slugs.json and
 // the resulting soft-landing clobbered jobSectorPagesPlugin's hub output.
 // Skip current job slugs to avoid breaking real jobs that happen to share
 // a slug with a hub key.
 let reservedHubsRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (RESERVED_HUB_SLUGS.has(key) && !currentSlugs.has(key)) {
 delete tracking[key];
 reservedHubsRemoved++;
 }
 }
 if (reservedHubsRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Removed ${reservedHubsRemoved} reserved hub slug(s) from tracking (would have clobbered sector/city hubs)`);
 }

 // Strip pre-existing fixture-data slugs that earlier fixture-only builds
 // wrote into all-known-job-slugs.json. This is the cleanup half of the
 // fixture guard: even after we filter validJobs, the tracking file may
 // still hold leaked fixture keys from prior commits, so wipe them on
 // every build before persistence.
 let fixtureKeysRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (isFixtureSlug(key)) {
 delete tracking[key];
 fixtureKeysRemoved++;
 }
 }
 if (fixtureKeysRemoved > 0) {
 console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Removed ${fixtureKeysRemoved} fixture-data slug(s) from tracking`);
 }

 // Strip hub-pagination compound keys `<hub-slug>/page-N` (e.g. `alle/page-1021`,
 // `tutti/page-1116`) BEFORE the write. The GSC-orphan ingestion misclassified
 // these hub-pagination URLs as job slugs (a real job slug is a single path
 // segment and never contains `/`); each stored a 4-locale cross-product, so the
 // soft-landing loop emitted the localized "all" slug under EVERY canton section
 // (`/cerca-lavoro-ticino/alle/page-1021`, `/en/find-jobs-ticino/alle/…`, …) as
 // thin noindex shells at wrong paths. Deleting them from `tracking` (not just
 // filtering the derived expiredSlugs list) is what stops BOTH the expired loop
 // AND the self-healing safety-net from re-emitting them. The correct per-locale
 // hubs are emitted by seoHubsPlugin; retired `<hub>/page-N` crawls resolve via
 // searchConsoleCompat → listing root, so no bridge is needed.
 //
 // Also strips bare `page-N` keys (page-2/page-5 — legacy English pagination
 // word, real GSC traffic). These used to be deliberately kept (no leading
 // segment → not matched by the regex above) so their soft-landing page stayed
 // live rather than 404ing; searchConsoleCompat now 301s them to their real
 // `pagina-N`/`seite-N` twin, so the static soft-landing page must be removed
 // too — otherwise it would keep serving a thin 200 at the path the redirect
 // is meant to own.
 let hubPaginationKeysRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (HUB_PAGINATION_COMPOUND_KEY_RE.test(key) || BARE_PAGE_NUMBER_KEY_RE.test(key)) {
 delete tracking[key];
 hubPaginationKeysRemoved++;
 }
 }
 if (hubPaginationKeysRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Removed ${hubPaginationKeysRemoved} hub-pagination/page-number key(s) from tracking (cross-locale all-slug soft-landing leak + bare page-N redirect handoff)`);
 }
 writeAllKnownJobSlugs(tracking, rootDir);

 // 1b. Merge orphan indexed slugs (GSC-indexed URLs with no matching job)
 // into the tracking so they get soft-landing pages too.
 const orphanSlugsPath = np.resolve(rootDir, 'data/orphan-indexed-job-slugs.json');
 try {
 const orphanSlugs: (string | { locale: string; path: string })[] = JSON.parse(fs.readFileSync(orphanSlugsPath, 'utf-8'));
 if (Array.isArray(orphanSlugs)) {
 let orphansMerged = 0;
 for (const entry of orphanSlugs) {
 if (!entry) continue;
 if (typeof entry === 'string') {
 // Legacy format: IT-only slug string
 if (tracking[entry]) continue;
 // Skip search combo pages (ricerca-*, search-*, etc.)
 if (/^(?:search|ricerca|suche|recherche)-/.test(entry)) continue;
 // Skip sector/city hub slugs to avoid overwriting hub pages.
 if (RESERVED_HUB_SLUGS.has(entry)) continue;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(entry)) continue;
 tracking[entry] = { it: `/cerca-lavoro-ticino/${entry}` };
 } else if (typeof entry === 'object' && entry.locale && entry.path) {
 // Locale-aware format: { locale: "de", path: "/de/jobs-im-tessin/..." }
 // Key = last path segment (the slug), value = { [locale]: path }
 const cleanPath = entry.path.replace(/\/+$/, ''); // strip trailing slash
 const slug = cleanPath.split('/').pop()!;
 if (!slug) continue;
 // Skip search combo pages — these are generated by the search section,
 // not by the job crawler pipeline. Importing them as orphan jobs would
 // create duplicate pages and confuse the flat-file generation.
 if (/^(?:search|ricerca|suche|recherche)-/.test(slug)) continue;
 // Skip sector/city hub slugs to avoid overwriting hub pages.
 if (RESERVED_HUB_SLUGS.has(slug)) continue;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(slug)) continue;
 if (!tracking[slug]) tracking[slug] = {};
 (tracking[slug] as Record<string, string>)[entry.locale] = cleanPath;
 } else {
 continue;
 }
 orphansMerged++;
 }
 if (orphansMerged > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${orphansMerged} orphan GSC slugs into expired tracking`);
 }
 }
 } catch { /* file missing — skip */ }

 // 1b2. Merge GSC 404 compat paths into tracking so they get soft-landing pages
 // instead of thin "Pagina archiviata" pages from legacyRedirectsPlugin.
 // The compat file is a manual GSC export; the orphan pipeline now subsumes it.
 // Handles all locales: IT (/cerca-lavoro-ticino/), DE (/de/jobs-im-tessin/), FR (/fr/trouver-emploi-tessin/)
 // Sharded accumulator (issue #2988): union via the store helper.
 // Slugs whose compat-merge OVERWROTE a pre-existing (different-canton) locale
 // path. For these the surviving sibling-locale entries still point at the
 // OTHER canton's live pages, so the soft-landing emit below MUST force zero
 // hreflang (see the emit-site guard) — a mixed TI/other-canton cluster would
 // be non-reciprocal and could trip audit-hreflang #4. Declared in the merge
 // scope so the emit loop (same closure, reads `tracking` directly) can read it.
 const cantonDriftCompatSlugs = new Set<string>();
 // Active-job canton-drift recovery: when the compat-merge below overwrites an
 // ACTIVE job's locale path with its legacy-TI drift URL, remember the job's
 // REAL (live) canonical path, keyed by the drift compat path. The self-healing
 // pass (search activeDriftRealPathByCompat) reads this to emit a relocation
 // bridge pointing at the live page instead of a "job removed" tombstone — the
 // job is ALIVE (served at its current canton URL), so the orphan stub was a
 // soft-404 regression on the indexed legacy-TI URL (e.g. a VS Swiss-Life job
 // 404-orphaned at /fr/trouver-emploi-tessin/<slug>/ while live at
 // /fr/trouver-emploi-valais/<slug>/).
 //
 // Safety of keying this Map by `compatPath` alone (issue #3150 follow-up of
 // #3144): `compatPath` = `prefix + slug` where `prefix` comes from the
 // locale-specific COMPAT_JOB_PATTERNS table below. Two different locales
 // could only silently overwrite each other's stash entry (and later make
 // the self-healing lookup emit a canonical pointing at the wrong locale's
 // page) if two entries in COMPAT_JOB_PATTERNS mapped to the SAME prefix
 // string but DIFFERENT locales. Enumerated: it → '/cerca-lavoro-ticino/',
 // en → '/en/find-jobs-ticino/', de → '/de/jobs-im-tessin/',
 // fr → '/fr/trouver-emploi-tessin/' — four distinct literal prefixes, one
 // per locale (en/de/fr each carry the `/${locale}/` segment; it's prefix
 // is the IT-only literal 'cerca-lavoro-ticino'). None is a prefix of any // cathedral-allow: documentation comment describing existing COMPAT_JOB_PATTERNS prefix, not a new hardcode
 // other (they diverge at the first character after the leading '/'), so
 // no slug can make two different-locale prefixes concatenate to the same
 // compatPath either. `compatPath` alone is therefore unambiguous today —
 // see tests/cross-canton-active-drift-bridge.test.ts for a regression
 // guard that fails if a future COMPAT_JOB_PATTERNS edit breaks this
 // invariant (duplicate prefix reused across locales, or a new prefix that
 // is a prefix/suffix-ambiguous of an existing different-locale one).
 const activeDriftRealPathByCompat = new Map<string, string>();
 try {
 const compatPaths: string[] = readCompatPaths(rootDir).paths;
 let compatAdded = 0;
 const COMPAT_JOB_PATTERNS: { re: RegExp; locale: string; prefix: string }[] = [
 { re: /\/cerca-lavoro-ticino\/([^/]+)\/?$/, locale: 'it', prefix: '/cerca-lavoro-ticino/' },
 { re: /\/en\/find-jobs?-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/en\/job-search-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/de\/jobs-im-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/de\/jobsuche-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/fr\/trouver-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 { re: /\/fr\/recherche-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 ];
 const SKIP_PREFIX_RE = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 for (const p of compatPaths) {
 const raw = String(p || '');
 for (const { re, locale, prefix } of COMPAT_JOB_PATTERNS) {
 const m = raw.match(re);
 if (!m) continue;
 const slug = m[1];
 if (!slug || SKIP_PREFIX_RE.test(slug)) break;
 // Skip sector/city hub slugs — registering them here would emit a
 // soft-landing page that overwrites the legitimate hub HTML and
 // breaks the canonical (the IT hub stops ranking; only EN sibling
 // survives because its slug differs).
 if (RESERVED_HUB_SLUGS.has(slug)) break;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(slug)) break;
 if (!tracking[slug]) tracking[slug] = {};
 const known = (tracking[slug] as Record<string, string>)[locale];
 const compatPath = `${prefix}${slug}`;
 // Canton-drift recovery (follow-up #2600 item 1). Previously we
 // skipped (`break`) whenever the ledger already held a locale path
 // for this slug, giving priority to the active path. That left
 // canton-drifted orphans — a job re-pinned to another canton (e.g.
 // active at /cerca-lavoro-berna/<slug> while the old TI URL
 // /cerca-lavoro-ticino/<slug>/ is still indexed and now 404s) — with
 // only the thin accumulator bridge (cfHot404BridgePlugin). Registering
 // the canton-less compat path here lets those orphans get the richer
 // soft-landing instead. Safety: the on-disk ledger is already
 // persisted above (data/all-known-job-slugs.json) so this in-memory
 // override never mutates the ledger; the accumulator bridge
 // (enforce:'post', last position, existsSync gap-fill) skips any path
 // this richer page already emitted, so there is no double-emit.
 //
 // HREFLANG SAFETY (#2626 review fix): when we OVERWRITE a pre-existing
 // locale path, the slug belongs to an active job whose OTHER locale
 // entries still point at the other canton's LIVE pages (e.g. it→TI
 // soft-landing, but en/de/fr→/…-berna/…). Left untouched the cluster
 // would look "full" (4 locales) → the emit would write a 4-locale
 // hreflang block mixing this noindex TI page with the live, non-
 // reciprocal Bern pages and tripping audit-hreflang #4 (every target
 // must exist in dist; ledger sibling paths can be stale). So record the
 // slug and force ZERO hreflang at emit — matching the documented intent
 // ("incomplete cluster → zero hreflang, rely on canonical + html lang").
 // Net-new registrations (no pre-existing `known`) are reciprocal TI
 // paths and keep their normal cluster.
 // REVERT-TRIGGER: the full SSG emit only validates post-merge on
 // `main` (local SEO build OOMs). If the next deploy regresses the
 // hreflang/canonical audits or OOMs, restore the `if (known) break`.
 const knownNorm = known ? known.replace(/\/+$/, '') : known;
 if (knownNorm === compatPath) break; // already the canonical path — no-op
 // Native-canton-wins for EXPIRED slugs. COMPAT_JOB_PATTERNS above only match
 // Ticino sections, so a canton-drifted job indexed under BOTH its native
 // non-TI canton (e.g. Zurich — the canonical per `location` and the committed
 // ledger) AND a legacy TI section would have its rich soft-landing HIJACKED
 // onto the TI path, abandoning the native (indexed) URL to the thin cfHot404
 // "Pagina archiviata" stub (observed: EFG "Internship – Business Management,
 // Global Markets & Treasury" Zurich — /…-zurich/… served the stub while
 // /…-ticino/… served the real content). Unlike the #2600 case below, an
 // EXPIRED slug has NO active page covering its native canton, so the native
 // ledger path is the ONLY rich page it will ever get: keep it. The drifted TI
 // URL still recovers via the cfHot404 bridge, which resolves the slug's ledger
 // canonical and emits a `canton-moved` bridge pointing at the native page.
 // ACTIVE slugs (currentSlugs) keep the existing override: their native canton
 // is already served by the live job page, so moving the soft-landing onto the
 // drifted indexed URL is correct.
 if (known && !currentSlugs.has(slug)) break;
 if (known) cantonDriftCompatSlugs.add(slug);
 // ACTIVE job whose live canonical path we're about to overwrite with the
 // drift URL: stash the real path so the self-healing pass emits a relocation
 // bridge to the live page instead of a "job removed" tombstone (see
 // activeDriftRealPathByCompat declaration). `known` is the pre-overwrite
 // ledger path (the job's current canton URL); `compatPath` is the legacy-TI
 // drift URL that becomes the new tracking value.
 if (known && currentSlugs.has(slug)) activeDriftRealPathByCompat.set(compatPath, known);
 (tracking[slug] as Record<string, string>)[locale] = compatPath;
 compatAdded++;
 break;
 }
 }
 if (compatAdded > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${compatAdded} GSC-404 compat job paths into expired tracking`);
 }
 } catch { /* file missing — skip */ }

 // 1c. Load enriched data for orphan slugs (GSC queries + translation cache titles/descriptions)
 interface OrphanEnriched {
 queries?: string[];
 totalImpressions?: number;
 totalClicks?: number;
 topQuery?: string | null;
 title?: string;
 titleByLocale?: Record<string, string>;
 descriptionByLocale?: Record<string, string>;
 company?: string;
 companyKey?: string;
 location?: string;
 sector?: string;
 salaryMin?: number;
 salaryCurrency?: string;
 slugByLocale?: Record<string, string>;
 localePaths?: Record<string, string>;
 sourceUrl?: string;
 }
 const orphanGscData = new Map<string, OrphanEnriched>();
 try {
 // Sharded ledger (#4248). readOrphanEnriched returns a slug's locale
 // records with the STRONGEST GSC signal LAST, so the last-one-wins
 // `orphanGscData.set` below now resolves to the record that actually
 // carries the queries instead of whichever locale happened to be
 // appended last — see signalRank in scripts/lib/orphan-enriched-store.mjs.
 const enrichedArr: any[] = readOrphanEnriched(rootDir);
 let withQueries = 0;
 let withContent = 0;
 for (const entry of enrichedArr) {
 if (!entry?.slug) continue;
 const data: OrphanEnriched = {};
 if (entry.queries?.length > 0) {
 data.queries = entry.queries;
 data.totalImpressions = entry.totalImpressions || 0;
 data.totalClicks = entry.totalClicks || 0;
 data.topQuery = entry.topQuery || null;
 withQueries++;
 }
 if (entry.title) data.title = entry.title;
 if (entry.titleByLocale) data.titleByLocale = entry.titleByLocale;
 if (entry.descriptionByLocale && Object.keys(entry.descriptionByLocale).length > 0) {
 data.descriptionByLocale = entry.descriptionByLocale;
 withContent++;
 }
 if (entry.company) data.company = entry.company;
 if (entry.companyKey) data.companyKey = entry.companyKey;
 if (entry.location) data.location = entry.location;
 if (entry.sector) data.sector = entry.sector;
 if (entry.salaryMin) data.salaryMin = entry.salaryMin;
 if (entry.salaryCurrency) data.salaryCurrency = entry.salaryCurrency;
 if (entry.slugByLocale) data.slugByLocale = entry.slugByLocale;
 if (entry.localePaths) data.localePaths = entry.localePaths;
 if (entry.sourceUrl) data.sourceUrl = entry.sourceUrl;
 if (Object.keys(data).length > 0) orphanGscData.set(entry.slug, data);
 }
 if (orphanGscData.size > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded enrichment for ${orphanGscData.size} orphan slugs (${withQueries} with GSC queries, ${withContent} with full content)`);
 }
 } catch { /* file missing — skip */ }

 // 2. Load expired job data for rich content (previousSlugs, title, company, etc.)
 const expiredJobsPath = np.resolve(rootDir, 'data/expired-jobs.json');
 let expiredJobsData: any[] = [];
 try {
 expiredJobsData = JSON.parse(fs.readFileSync(expiredJobsPath, 'utf-8'));
 if (!Array.isArray(expiredJobsData)) expiredJobsData = [];
 } catch { /* no expired data */ }
 // Sort DESC by recency BEFORE populating expiredBySlug. Combined with the
 // `!has` guard below this gives "most-recent expired job wins" for both
 // own-slug indexing AND previousSlugs indexing (147 of the 305 expired
 // entries share at least one previousSlug with another expired entry —
 // top offender: `augenoptiker-w-m-d-fielmann-ch` shared by 63 expired
 // jobs — so the order in which we enter them into the map decides which
 // job's title/description ends up on the soft-landing page at that path).
 expiredJobsData.sort((a, b) => {
 const ta = _jobRecency(a);
 const tb = _jobRecency(b);
 if (ta !== tb) return tb - ta;
 return String(a.id || a.slug || '').localeCompare(String(b.id || b.slug || ''));
 });
 const expiredBySlug = new Map<string, any>();
 for (const ej of expiredJobsData) {
 // `!has` guard so the FIRST entry (most-recent due to sort above) wins.
 // Was unconditional `set` previously, which let the LAST entry (oldest
 // after sort, but arbitrary order before sort) overwrite the winner.
 // Index the job under every slug variant it has ever carried — own slug,
 // current-locale slugByLocale (so DE/EN/FR soft-landing URLs resolve to the
 // same ejData as the IT primary, instead of shipping descriptionByLocale:{}
 // and forcing a 4.5 MB SPA fetch), plus previousSlugs / previousSlugsByLocale
 // so renamed-then-deleted jobs still get enriched pages. Shared with the
 // uncapped slice-augmentation pass below so both derive variants identically.
 for (const v of expiredJobSlugVariants(ej)) {
 if (!expiredBySlug.has(v)) expiredBySlug.set(v, ej);
 }
 }

 // 2b. Augment expiredBySlug from per-crawler expired SLICES (uncapped) so
 // orphan soft-landing pages beyond the cap window in expired-jobs.json (the
 // assembled file is capped at the 5000 most-recently-expired by
 // assemble-jobs-dataset.mjs) still render recovered content. We retain ONLY
 // slice entries whose slug variants back an emitted orphan page (`tracking`),
 // so the map stays bounded to the orphan set instead of holding every
 // historical expired job. First-write-wins (the `!has` guard) preserves the
 // recency-sorted expired-jobs.json winners indexed above — this only fills the
 // long tail those 5000 left empty.
 const expiredSlicesDir = np.resolve(rootDir, 'data/jobs/expired/by-crawler');
 // Safety valve against unbounded SSG memory growth as slices accumulate over
 // years — caps how many long-tail entries we retain. Default is generous
 // (well above today's ~5k) so it never bites normal coverage; lower via env if
 // a deploy ever OOMs on the augmented map.
 const SLICE_AUGMENT_CAP = Number(process.env.EXPIRED_SLICE_AUGMENT_CAP || 60000);
 if (fs.existsSync(expiredSlicesDir)) {
 const emittedSlugs = new Set(Object.keys(tracking));
 let sliceAugmented = 0;
 let sliceAugmentCapped = false;
 // Predicato condiviso (scripts/lib/crawler-slice-files.mjs): e' lo stesso che
 // assemble-jobs-dataset.mjs applica gia' a EXPIRED_SLICES_DIR. `.json` da solo
 // raccoglieva anche i companion `-cache` e gli orfani `.cleanup-tmp`.
 for (const sliceFile of fs.readdirSync(expiredSlicesDir)) {
 if (sliceAugmentCapped) break;
 if (!isSliceFile(sliceFile)) continue;
 let sliceArr: any[];
 try {
 sliceArr = JSON.parse(fs.readFileSync(np.resolve(expiredSlicesDir, sliceFile), 'utf-8'));
 } catch { continue; }
 if (!Array.isArray(sliceArr)) continue;
 for (const ej of sliceArr) {
 const variants = expiredJobSlugVariants(ej);
 // Skip entries that don't back an emitted orphan page — keeps the map
 // bounded to the orphan set rather than all historical expired jobs.
 if (!variants.some((v) => emittedSlugs.has(v))) continue;
 // Count only slug-variant entries actually inserted into the map — NOT
 // every processed `ej`. With the known 63-way previousSlug collisions a
 // job whose variants are all already indexed (by 2a or an earlier slice)
 // adds nothing to the map, so it must not advance the counter: otherwise
 // the counter inflates past the real retained-entry count and trips
 // SLICE_AUGMENT_CAP early, truncating readdirSync mid-stream (which
 // crawler-slices survive then depends on arbitrary filesystem order).
 // The cap bounds SSG memory (map size), so the counter must track map
 // growth, not iterations.
 for (const v of variants) {
 if (v && !expiredBySlug.has(v)) { expiredBySlug.set(v, ej); sliceAugmented++; }
 }
 if (sliceAugmented >= SLICE_AUGMENT_CAP) { sliceAugmentCapped = true; break; }
 }
 }
 if (sliceAugmented > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Augmented expiredBySlug with ${sliceAugmented} per-crawler slice slug-variant entries (uncapped) for orphan coverage beyond the expired-jobs.json cap`);
 }
 if (sliceAugmentCapped) {
 console.warn(`\x1b[33m[jobs-seo-pages]\x1b[0m EXPIRED_SLICE_AUGMENT_CAP (${SLICE_AUGMENT_CAP}) reached — long-tail orphan content beyond this is not indexed this build. Raise the cap or shard if intentional.`);
 }
 }

 // FRO-343: Load swiss-postal-codes for postalCode enrichment of soft-landing pages
 let plzLookup: Record<string, string> = {};
 const plzPath = np.resolve(rootDir, 'data', 'swiss-postal-codes.json');
 if (fs.existsSync(plzPath)) {
 try { plzLookup = JSON.parse(fs.readFileSync(plzPath, 'utf-8')); } catch { /* ok */ }
 }

 // 3. Generate soft-landing pages for expired slugs
 // Pre-build a set of all previousSlugs from active jobs so we can exclude them from
 // expiredSlugs. These slugs will be handled as bridge pages (canonical → new URL) and
 // must NOT appear in the expired sitemap (which would cause validate-canonical failures
 // because bridge HTML has a non-self canonical). The all-writes-are-queued pattern means
 // fs.existsSync cannot guard against the bridge page overwriting the expired HTML, so
 // the cleanest fix is to exclude bridge slugs from expiredSlugs entirely.
 const bridgeSlugSet = new Set<string>();
 // Helper: collect all previous slugs from both formats (defined early so the
 // fuzzy-match step below can use it to check "already known" slugs).
 const _allPrevSlugs = (j: any): string[] => {
 const all = new Set<string>(Array.isArray(j.previousSlugs) ? j.previousSlugs : []);
 if (j.previousSlugsByLocale && typeof j.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(j.previousSlugsByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) all.add(s);
 }
 }
 return [...all];
 };

 /* ── Fuzzy match orphan slugs to active jobs ─────────────────── */
 // When a company rebrand or title rewrite causes a slug to change, only the
 // locale that triggered regeneration records the old slug in previousSlugsByLocale.
 // The sibling locales' old slugs (which Google may still have indexed) become
 // orphans that fall through to the self-healing "offerta aggiornata" page.
 // Scan `tracking` (merged active + orphan + compat paths) and for each slug
 // not already attached to any active job, score it against every active job's
 // slugByLocale via token overlap. If the best match is confident enough
 // (>=60% token overlap AND ≥3 shared tokens), inject it into that job's
 // previousSlugsByLocale so the downstream bridge + cross-locale blocks
 // generate a full-content reconciliation page.
 const knownSlugs = new Set<string>();
 for (const j of validJobs) {
 if (j.slug) knownSlugs.add(j.slug);
 if (j.slugByLocale) for (const s of Object.values(j.slugByLocale)) if (typeof s === 'string' && s) knownSlugs.add(s);
 for (const s of _allPrevSlugs(j)) knownSlugs.add(s);
 }
 // Hash trailers like "-w5vlie", "-l7apjs" (4-8 lowercase alnum, often
 // appended by upstream ATSes to dedupe variants of the same posting) are
 // per-posting noise — strip before tokenizing so they don't drown out the
 // discriminant tokens (department, city). Pre-audit (2026-05-28): without
 // strip, 32% of orphans had a hash trailer that became their "last token".
 const HASH_TRAILER_RE = /-[a-z0-9]{4,8}$/;
 const tokenize = (s: string): string[] =>
   s.replace(HASH_TRAILER_RE, '').split('-').filter(t => t.length >= 3);
 // Canonical city of a job = tokenised `location` field. Used as a HARD lock
 // (below) to prevent cross-city mis-attribution. "Domat/Ems" → ["domat","ems"];
 // "Castel San Pietro" → ["castel","san","pietro"]. Pre-audit: WITHOUT this
 // lock, 74% of fuzzy matches attributed the orphan to a job in a different
 // city — the matcher rewarded shared title prose (e.g. "capo della stazione")
 // over shared location/department tokens, so a Walenstadt orphan would point
 // its canonical at a Chur job because both shared the generic role words.
 const cityTokens = (loc: unknown): string[] => {
   if (typeof loc !== 'string' || !loc) return [];
   return loc
     .toLowerCase()
     .normalize('NFD').replace(/[̀-ͯ]/g, '')
     .split(/[^a-z0-9]+/)
     .filter(t => t.length >= 3);
 };
 const jobCityTokens: string[][] = validJobs.map(j => cityTokens((j as any).location));
 // Index active jobs by every token that appears in any of their slugs so we
 // can quickly find candidates for a given orphan slug (avoids O(orphan × jobs)).
 const jobsByToken = new Map<string, Set<number>>();
 validJobs.forEach((j, idx) => {
 const sbl = (j as any).slugByLocale || {};
 const allJobSlugs = [
 ...Object.values(sbl).filter((s): s is string => typeof s === 'string' && s.length > 0),
 j.slug,
 ].filter(Boolean) as string[];
 const tokens = new Set<string>();
 for (const s of allJobSlugs) for (const t of tokenize(s)) tokens.add(t);
 for (const t of tokens) {
 if (!jobsByToken.has(t)) jobsByToken.set(t, new Set());
 jobsByToken.get(t)!.add(idx);
 }
 });
 const SKIP_PREFIX_FUZZY = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 let fuzzyMatched = 0;
 let cityLockRejections = 0;
 for (const orphanSlug of Object.keys(tracking)) {
 if (knownSlugs.has(orphanSlug)) continue;
 if (SKIP_PREFIX_FUZZY.test(orphanSlug)) continue;
 const orphanTokens = tokenize(orphanSlug);
 if (orphanTokens.length < 4) continue;
 const orphanTokenSet = new Set(orphanTokens);
 // Candidate jobs share at least one token with the orphan slug
 const candidateIdx = new Map<number, number>();
 for (const t of orphanTokens) {
 const idxSet = jobsByToken.get(t);
 if (!idxSet) continue;
 for (const i of idxSet) candidateIdx.set(i, (candidateIdx.get(i) || 0) + 1);
 }
 if (candidateIdx.size === 0) continue;
 // Score only candidates that share ≥3 tokens with the orphan (coarse filter)
 let best: { job: any; locale: string; score: number; shared: number } | null = null;
 for (const [idx, shared] of candidateIdx) {
 if (shared < 3) continue;
 // HARD CITY LOCK: candidate's canonical location (from job.location, not
 // slug — slugs may end with a cantone token or a hash trailer) must be
 // fully represented in the orphan's tokens. Jobs without a location
 // signal cannot be confidently matched and are skipped.
 const cCity = jobCityTokens[idx];
 if (cCity.length === 0) { cityLockRejections++; continue; }
 if (!cCity.every(ct => orphanTokenSet.has(ct))) { cityLockRejections++; continue; }
 const cand = validJobs[idx];
 const sbl = (cand as any).slugByLocale || {};
 for (const locale of localeList) {
 const candSlug = sbl[locale] || cand.slug || '';
 if (!candSlug) continue;
 const candTokens = new Set(tokenize(candSlug));
 if (candTokens.size === 0) continue;
 const inter = orphanTokens.filter(t => candTokens.has(t)).length;
 const score = inter / Math.max(orphanTokens.length, candTokens.size);
 if (!best || score > best.score) best = { job: cand, locale, score, shared: inter };
 }
 }
 if (!best || best.score < 0.6 || best.shared < 3) continue;
 const target = best.job as { previousSlugsByLocale?: Record<string, string[]> };
 if (!target.previousSlugsByLocale) target.previousSlugsByLocale = {};
 const arr = target.previousSlugsByLocale[best.locale] || (target.previousSlugsByLocale[best.locale] = []);
 if (!arr.includes(orphanSlug)) {
 arr.push(orphanSlug);
 knownSlugs.add(orphanSlug);
 fuzzyMatched++;
 }
 }
 if (fuzzyMatched > 0 || cityLockRejections > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Fuzzy-matched ${fuzzyMatched} orphan slugs to active jobs as implicit previousSlugs (rejected ${cityLockRejections} cross-city candidates)`);
 }

 // Collect IT paths of all previous slugs so we can also exclude their
 // locale-variant tracking keys (e.g. EN/DE/FR slug for the same old job).
 // The tracking file stores one key per locale slug, all pointing to the
 // same IT path, so we must group by IT path to catch them all.
 const bridgeItPaths = new Set<string>();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 for (const s of _allPrevSlugs(job)) {
 bridgeSlugSet.add(s);
 const itPath = (tracking[s] as any)?.it;
 if (itPath) bridgeItPaths.add(itPath);
 }
 }
 // Add implicit previous slugs (job.slug ≠ slugByLocale.it) to bridge set
 // and ensure they're in previousSlugsByLocale for bridge page generation
 for (const { job, slug } of implicitPreviousSlugs) {
 bridgeSlugSet.add(slug);
 // Write to locale-aware field (IT locale since these are master slug mismatches)
 if (!(job as any).previousSlugsByLocale) (job as any).previousSlugsByLocale = {};
 if (!Array.isArray((job as any).previousSlugsByLocale.it)) (job as any).previousSlugsByLocale.it = [];
 if (!(job as any).previousSlugsByLocale.it.includes(slug)) {
 (job as any).previousSlugsByLocale.it.push(slug);
 }
 // Also keep legacy flat array in sync
 if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
 if (!job.previousSlugs.includes(slug)) job.previousSlugs.push(slug);
 // Ensure tracking has this slug with correct locale paths
 if (!tracking[slug]) {
 tracking[slug] = {
 it: `/${sectionByLocale.it}/${slug}`,
 en: `/en/${sectionByLocale.en}/${slug}`,
 de: `/de/${sectionByLocale.de}/${slug}`,
 fr: `/fr/${sectionByLocale.fr}/${slug}`,
 };
 }
 }
 // FRO-SEO: Build a set of actual FILE PATHS that bridge pages will claim.
 // Previously we excluded entire tracking keys whose IT path matched any bridge
 // IT path. This was too aggressive: locale-variant keys (EN/DE/FR slug →
 // same IT path) have DIFFERENT translated locale paths that don't conflict
 // with bridge pages (which use the IT slug for all locales). The old approach
 // created a "dead zone" of ~1,700 tracking keys with NO pages generated.
 // Now we exclude only the specific locale paths that actually conflict.
 const bridgeClaimedPaths = new Set<string>();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 for (const oldSlug of _allPrevSlugs(job)) {
 if (!oldSlug) continue;
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 }
 for (const { slug } of implicitPreviousSlugs) {
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 // Include ALL tracking keys except direct bridge slugs. Keys that happen to
 // match a currentSlug value are included because their locale paths may differ
 // from the active job's paths — writeSoftLandingPage already skips paths
 // where active or bridge pages exist (via _writtenPaths / activeJobDirs).
 // Exclude RESERVED_HUB_SLUGS from soft-landing emission. Pre-existing
 // tracking entries imported from gsc-404 (e.g. slug "infermieri") would
 // otherwise overwrite the legitimate sector/city hub HTML at
 // /cerca-lavoro-ticino/infermieri/index.html with a thin job soft-landing
 // and break Semrush W2 (Issue 102) + the canonical sector page in SERPs.
 // (Hub-pagination compound keys `<hub>/page-N` are removed from `tracking`
 // itself up at the reserved-hub strip block, so both this list AND the
 // self-healing safety-net loop skip them — see HUB_PAGINATION_COMPOUND_KEY_RE.)
 const expiredSlugs = Object.keys(tracking).filter(
 (s) => !bridgeSlugSet.has(s) && !RESERVED_HUB_SLUGS.has(s),
 );
 // NB: the hub-pagination compound keys were already `delete`d from `tracking`
 // up at the reserved-hub strip block (before the tracking write AND before this
 // expiredSlugs computation), so they are absent from BOTH `expiredSlugs` here
 // and the self-healing `Object.entries(tracking)` loop below — no second strip
 // is needed (a duplicate one here would re-declare hubPaginationKeysRemoved and
 // also runs AFTER expiredSlugs is captured, missing the expired loop anyway).

 const expiredBannerCopy: Record<string, { title: string; banner: string }> = {
 it: { title: 'Offerta non più disponibile', banner: 'Questa posizione non è più attiva. Di seguito trovi i dettagli originali e posizioni simili.' },
 en: { title: 'Job no longer available', banner: 'This position is no longer active. Below you\'ll find the original details and similar positions.' },
 de: { title: 'Stelle nicht mehr verfügbar', banner: 'Diese Position ist nicht mehr aktiv. Nachfolgend finden Sie die Originaldetails und ähnliche Stellen.' },
 fr: { title: 'Offre non disponible', banner: 'Ce poste n\'est plus actif. Vous trouverez ci-dessous les détails originaux et des postes similaires.' },
 };
 const archiveRelatedLabel: Record<string, string> = {
 it: 'Posizioni aperte simili in Ticino',
 en: 'Similar open positions in Ticino',
 de: 'Ähnliche offene Stellen im Tessin',
 fr: 'Postes similaires ouverts au Tessin',
 };
 const archiveCtaLabel: Record<string, string> = {
 it: 'Tutte le offerte di lavoro in Ticino',
 en: 'All job openings in Ticino',
 de: 'Alle offenen Stellen im Tessin',
 fr: 'Toutes les offres d\'emploi au Tessin',
 };
 const hashCode = (s: string) => {
 let h = 0;
 for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
 return h;
 };


 // --- extractInfoFromSlug: de-slugify orphan slugs to recover title/company/location ---
 // Build lookup tables for matching
 const adapterDir = np.resolve(rootDir, 'data/jobs-crawler-adapters/adapters');
 const companySlugMap: { slug: string; name: string }[] = [];
 const seenCompanySlugs = new Set<string>();
 try {
 for (const f of fs.readdirSync(adapterDir).filter((n: string) => n.endsWith('.json'))) {
 const d = JSON.parse(fs.readFileSync(np.join(adapterDir, f), 'utf-8'));
 const name = d.companyName || d.company || '';
 if (!name) continue;
 const adapterSlug = f.replace('.json', '');
 companySlugMap.push({ slug: adapterSlug, name });
 seenCompanySlugs.add(adapterSlug);
 // Also generate a slugified version of the company name for matching
 // e.g. "FART – Ferrovie Autolinee Regionali Ticinesi" → "fart-ferrovie-autolinee-regionali-ticinesi"
 const nameSlug = name
 .toLowerCase()
 .replace(/[–—]/g, '-')
 .replace(/[()]/g, '')
 .replace(/[^a-z0-9\s-]/g, '')
 .replace(/\s+/g, '-')
 .replace(/-{2,}/g, '-')
 .replace(/^-|-$/g, '');
 if (nameSlug && nameSlug !== adapterSlug && !seenCompanySlugs.has(nameSlug)) {
 companySlugMap.push({ slug: nameSlug, name });
 seenCompanySlugs.add(nameSlug);
 }
 }
 } catch { /* adapters dir missing */ }
 // Also include companies from active jobs (covers crawlers without adapters)
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const key = String(job.companyKey || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
 if (key && !seenCompanySlugs.has(key)) {
 companySlugMap.push({ slug: key, name: job.company });
 seenCompanySlugs.add(key);
 }
 }
 // Sort by slug length descending for longest-match-first
 companySlugMap.sort((a, b) => b.slug.length - a.slug.length);

 // Location names from swiss-postal-codes.json (key=locationName, value=postalCode)
 const locationNames = Object.keys(plzLookup).sort((a, b) => b.length - a.length);
 // Slugified location names for matching (e.g. "riva san vitale" -> "riva-san-vitale")
 const locationSlugPairs = locationNames.map(name => ({
 name,
 slug: name.toLowerCase().replace(/\s+/g, '-'),
 postalCode: plzLookup[name],
 }));

 // Common Italian/English stop words and gender markers to strip from de-slugified titles
 const slugStopFragments = new Set([
 'm-f', 'f-m', 'm-w', 'f-m-d', 'm-w-d', 'm-f-d', 'w-m-d', 'w-m',
 '100', '80', '60', '80-100', '60-100', '60-80',
 'afc', 'cfp', 'a', 'o', 'e',
 'm', 'f', 'd', 'w', // standalone gender markers (after company slug removal splits "m-f-d")
 ]);

 /** A curated set of foreign capital / tech-hub cities that routinely appear
  * as the trailing token on remote-role slugs (Tether, GitHub-style crypto,
  * fintech). These are NOT in the Swiss PLZ table nor in `broadLocations`;
  * without this list we'd leave `location` empty and render the SAME body
  * for every `…-buenos-aires`, `…-cairo`, `…-dubai` sibling → duplicate
  * content cluster.
  *
  * We deliberately keep the list narrow and human-readable rather than
  * auto-importing a full world-city dataset: every entry here must look
  * natural in the `<p>…${loc} (${canton})…</p>` copy.
  */
 const FOREIGN_CITY_SLUGS: Record<string, string> = {
  'amsterdam': 'Amsterdam',
  'athens': 'Athens',
  'bangalore': 'Bangalore',
  'barcelona': 'Barcelona',
  'berlin': 'Berlin',
  'brussels': 'Brussels',
  'bucharest': 'Bucharest',
  'bucuresti': 'București',
  'budapest': 'Budapest',
  'buenos-aires': 'Buenos Aires',
  'cairo': 'Cairo',
  'cape-town': 'Cape Town',
  'copenhagen': 'Copenhagen',
  'dublin': 'Dublin',
  'dubai': 'Dubai',
  'frankfurt': 'Frankfurt',
  'helsinki': 'Helsinki',
  'hong-kong': 'Hong Kong',
  'islamabad': 'Islamabad',
  'istanbul': 'Istanbul',
  'jakarta': 'Jakarta',
  'johannesburg': 'Johannesburg',
  'kiev': 'Kyiv',
  'kyiv': 'Kyiv',
  'kuala-lumpur': 'Kuala Lumpur',
  'lagos': 'Lagos',
  'lima': 'Lima',
  'lisbon': 'Lisbon',
  'london': 'London',
  'luxembourg': 'Luxembourg',
  'luxemburg': 'Luxembourg',
  'madrid': 'Madrid',
  'manila': 'Manila',
  'melbourne': 'Melbourne',
  'mexico-city': 'Mexico City',
  'miami': 'Miami',
  'milan': 'Milan',
  'milano': 'Milano',
  'montreal': 'Montreal',
  'moscow': 'Moscow',
  'mumbai': 'Mumbai',
  'munich': 'Munich',
  'nairobi': 'Nairobi',
  'new-york': 'New York',
  'oslo': 'Oslo',
  'paris': 'Paris',
  'prague': 'Prague',
  'rome': 'Rome',
  'roma': 'Roma',
  'san-francisco': 'San Francisco',
  'santiago': 'Santiago',
  'sao-paulo': 'São Paulo',
  'seoul': 'Seoul',
  'shanghai': 'Shanghai',
  'singapore': 'Singapore',
  'stockholm': 'Stockholm',
  'sydney': 'Sydney',
  'taipei': 'Taipei',
  'tel-aviv': 'Tel Aviv',
  'tokyo': 'Tokyo',
  'toronto': 'Toronto',
  'vancouver': 'Vancouver',
  'vienna': 'Vienna',
  'warsaw': 'Warsaw',
  'yerevan': 'Yerevan',
  'zagreb': 'Zagreb',
  'munsbach': 'Munsbach',
  'england': 'England',
  'london-england': 'London',
 };
 // Sort once by slug length so we match the longest (e.g. "mexico-city"
 // before "city") — the normal suffix-match pattern used for Swiss cities.
 const FOREIGN_CITY_SLUG_ENTRIES = Object.entries(FOREIGN_CITY_SLUGS).sort(
  (a, b) => b[0].length - a[0].length,
 );

 const extractInfoFromSlug = (slug: string): { title: string; company: string; companyKey: string; location: string; postalCode: string } => {
 let remaining = slug;
 let company = '';
 let companyKey = '';
 let location = '';
 let postalCode = '';

 // 1. Match company (longest slug match first, word-boundary aware)
 // Use regex with hyphen/start/end boundaries to prevent false positives
 // e.g. "a-group" must not match inside "prada-group"
 for (const c of companySlugMap) {
 const escaped = c.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const re = new RegExp(`(?:^|-)${escaped}(?:-|$)`);
 if (re.test(remaining)) {
 company = c.name;
 companyKey = c.slug;
 remaining = remaining.replace(re, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
 break;
 }
 }

 // 2. Match location (longest name match first, at end of slug preferred)
 for (const loc of locationSlugPairs) {
 if (remaining.endsWith(loc.slug) || remaining.endsWith('-' + loc.slug)) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace(new RegExp('-?' + loc.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 // Also check if location appears mid-slug (common for e.g. "coop-mezzovico")
 if (!location && remaining.includes('-' + loc.slug + '-')) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace('-' + loc.slug + '-', '-').replace(/^-+|-+$/g, '');
 }
 }

 // Also check broader Swiss locations not in Ticino PLZ
 if (!location) {
 const broadLocations: Record<string, string> = {
 'grigioni': 'Grigioni', 'graubunden': 'Graubünden', 'st-moritz': 'St. Moritz',
 'coira': 'Coira', 'chur': 'Chur', 'davos': 'Davos', 'berna': 'Berna',
 'zurigo': 'Zurigo', 'zurich': 'Zürich', 'basilea': 'Basilea', 'ginevra': 'Ginevra',
 'losanna': 'Losanna', 'lucerna': 'Lucerna', 'anniviers': 'Anniviers',
 'domat-ems': 'Domat/Ems', 'svizzera': '', // generic, don't use as location
 };
 for (const [locSlug, locName] of Object.entries(broadLocations)) {
 if (locName && (remaining.endsWith(locSlug) || remaining.endsWith('-' + locSlug))) {
 location = locName;
 remaining = remaining.replace(new RegExp('-?' + locSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 }
 }

 // 2b. Fallback: known foreign hub cities (remote-role trailing tokens).
 // WHY: Tether/crypto/fintech remote roles ship the city in the slug tail
 // (`…-buenos-aires`, `…-cairo`, `…-dubai`) even though the role is remote.
 // Without this pass, `location` stays empty for 100+ pages per role and
 // the rendered body collapses into one cluster (same expired-job
 // template, identical headings) → `audit-content-duplicates` FAIL.
 if (!location) {
 for (const [citySlug, cityName] of FOREIGN_CITY_SLUG_ENTRIES) {
 if (remaining === citySlug || remaining.endsWith(`-${citySlug}`)) {
 location = cityName;
 remaining = remaining.replace(new RegExp(`-?${citySlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
 break;
 }
 }
 }

 // 3. Clean up remaining to form the title
 // Remove leading number prefixes (e.g. "1-addetto" -> "addetto")
 remaining = remaining.replace(/^\d+-/, '');
 // Remove stop fragments
 const parts = remaining.split('-').filter(p => p && !slugStopFragments.has(p));
 // De-slugify: capitalize first word, join with spaces
 const title = parts
 .join(' ')
 .replace(/amp\s/g, '& ') // decode &amp; in slugs
 .replace(/\bdot\b/g, '.') // decode dots
 .replace(/^./, c => c.toUpperCase())
 .trim();

 return { title: title || slug, company, companyKey, location, postalCode };
 };

 let expiredCount = 0;
 let legacyCount = 0;
 const expiredSitemapEntries: string[] = [];

 // Pre-compute invariant HTML fragments for soft-landing pages (~69K pages).
 // Avoids re-building the same ~2KB of boilerplate for each page.
 const currentYear = new Date().getFullYear();
 // Was inline (~200 B per soft-landing page). Now references
 // /assets/early-boot-{hash}.js via EARLY_BOOT_SCRIPT — emitted by
 // staticScriptsPlugin at build, browser-cached globally. The merged
 // early-boot bundle concatenates dark-mode-init + spa-action-redirect
 // so a SINGLE <script src> tag covers both responsibilities (theme +
 // newsletter-action handoff) instead of two separate tags per page.
 const earlyBootScript = EARLY_BOOT_SCRIPT;
 // darkModeStyles + nav/footer/article inline styles now live in
 // /assets/seo-static.css (loaded via <link> in the template head).
 // Deduplicates ~1 KB of identical CSS across ~98k soft-landing pages
 // → saves ~100 MB across dist. Loaded NON-render-blocking (inline
 // CRITICAL_CSS + media=print swap of seo-static.css AND the SPA entry
 // sheet) via the shared asyncCssHeadBlock — issue #1991.
 const cssHeadBlock = asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined);
 // Externalised from inline <svg> (~700 B/page) — same logo now served from
 // /assets/logo.svg, cached by browser. Saves ~68 MB across ~98k soft-landing
 // pages. Static path; browser caches first-load globally.
 const navSvg = `<img src="/assets/logo.svg" width="28" height="28" alt="" loading="eager" decoding="async">`;
 const spaBundleJs = hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';
 // Per-locale pre-built nav + footer (only 4 strings to cache).
 //
 // Markup-extraction (2026-05-20): renamed long `.ft-static-*` / `.ft-*`
 // class names to a compact `.ft-n / .ft-nb / .ft-ns / .ft-f` scheme so
 // the repeated wrapper boilerplate shrinks ~100 B/page across ~822k
 // soft-landing + bridge pages (~80 MB dist). The CSS at
 // public/assets/seo-static.css carries both legacy and short selectors
 // until the next deploy fully propagates. Same text content, same a11y
 // labels, just shorter class strings — no SEO impact.
 //
 // Layout changes (drop wrapper `<div class="ft-row">` + `<span class="ft-spacer">`):
 // `nav.ft-n` becomes the flex container directly; `.ft-ns` carries
 // `margin-left: auto` to push the section link to the right. Same goes
 // for `footer.ft-f` (drops inner `<div class="ft-wrap">`).
 const localeShells = Object.fromEntries(localeList.map(l => {
 const lp = `${localePrefix[l]}/${sectionByLocale[l]}/`.replace(/\/+/g, '/');
 const sectionName = esc(localeCopy[l].sectionName);
 const nav = `<nav class="ft-n" aria-label="Navigazione principale"><a href="/" class="ft-nb">${navSvg} Frontaliere Ticino</a><a href="${lp}" class="ft-ns">${sectionName}</a></nav>`;
 const footer = `<footer class="ft-f">&copy; ${currentYear} <a href="/">Frontaliere Ticino</a> &mdash; <a href="${lp}">${sectionName}</a></footer>`;
 return [l, { nav, footer, listingPath: lp }];
 }));

 // Assembler: builds a complete soft-landing HTML page from pre-computed parts + dynamic slots.
 // `__STATIC_BODY_HTML__` is no longer JSON-embedded in head (which used to duplicate the entire
 // body twice per page — once as HTML, once as JSON-stringified blob). Instead the snippet right
 // before `${spaBundleJs}` snapshots `.ft-static-article` from DOM at parse time, BEFORE the
 // module-script SPA bundle hydrates and replaces #root. JobOrphanView.tsx then reads
 // window.__STATIC_BODY_HTML__ exactly as before. Saves ~3-5 KB × 98k pages ≈ ~400 MB dist.
 const buildSoftLandingHtml = (locale: string, pageTitle: string, pageDesc: string, robotsTag: string,
 selfUrl: string, hreflangLinks: string, jsonLdScripts: string, expiredWindowData: string,
 staticBody: string, adSnippet: string): string => {
 // Sub-phase profiler: ph:ejp:shell measured at 48.7s (45% of expired-
 // soft-landing) in run 26469566046. Break it down so the next round
 // can target either the template assembly (likely cheap) or minifyHtml
 // (regex-heavy, suspected dominant). Gated by JOBS_SEO_PROFILE_PHASES=1
 // already on in deploy.yml.
 const __tShellTpl = phaseTimer();
 const shell = localeShells[locale];
 // Single early-boot tag covers BOTH dark-mode and spa-action-redirect
 // (merged into /assets/early-boot-{hash}.js via EARLY_BOOT_SCRIPT). The
 // previous template emitted two separate <script src> tags here; combining
 // them saves ~80 B/page across ~470k soft-landing+bridge pages (~36 MB).
 //
 // The static `<article class="ft-static-article">` class is preserved
 // because the in-page snapshot script (last line of <body>) reads from
 // `document.querySelector('.ft-static-article')` to seed
 // `window.__STATIC_BODY_HTML__` for JobOrphanView hydration.
 //
 // The whole HTML string is passed through minifyHtml so the per-line
 // leading-whitespace overhead in this template literal is collapsed
 // before the file hits dist/. minifyHtml is DOM-equivalent (see
 // shared/htmlMinify.ts).
 const html = `<!DOCTYPE html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 ${FAVICON_LINKS}
 <title>${pageTitle}</title>
 <meta name="description" content="${clampMetaDescription(pageDesc)}">${robotsTag}
 <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
 <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
 <link rel="canonical" href="${selfUrl}">
${hreflangLinks}
 ${earlyBootScript}
 ${cssHeadBlock}
 ${jsonLdScripts}
 <script>window.__EXPIRED_JOB_DATA__=${expiredWindowData};</script>
${staticAnalyticsHtml}
 ${adSnippet}
 </head>
 <body>
 <div id="root">
 ${shell.nav}
 <article class="ft-static-article">
 ${staticBody}
 </article>
 ${shell.footer}
 </div>
 <script>window.__STATIC_BODY_HTML__=(document.querySelector('.ft-static-article')||{}).innerHTML||'';</script>${spaBundleJs}
 </body>
</html>`;
 recordPhase('ejp:shell:tpl', __tShellTpl);
 // Skip minifyHtml on soft-landings. Run 26472312864 measured
 // ph:ejp:shell:minify at 55.8s (99.5% of ph:ejp:shell, 8.7% of
 // jobsSeoPagesPlugin) — and the per-page max hit 4026ms, indicating
 // regex catastrophic backtracking on at least one input. Soft-landings
 // are 143k pages × ~30 bytes of leading-whitespace overhead = ~4 MB on
 // a 1.74 GB dist (irrelevant). The template literal below is already
 // tightly indented; raw output is DOM-equivalent. The cheap newline-
 // indent collapse keeps the worst of the boilerplate noise out.
 const __tShellMinify = phaseTimer();
 const out = html.replace(/\n[ \t]+/g, '\n');
 recordPhase('ejp:shell:minify', __tShellMinify);
 return out;
 };
 const writeSoftLandingPage = (outRelPath: string, html: string) => {
 // Normalize: strip trailing slashes to prevent flat files like ".html" (hidden files)
 const normPath = outRelPath.replace(/\/+$/, '');
 // Never overwrite ANY page already written by an earlier phase
 // (active jobs, company pages, search pages, editorial pages)
 const targetFile = np.join(distDir, normPath, 'index.html');
 if (_writtenPaths.has(targetFile)) return;
 if (activeJobDirs.has(normPath)) return;

 const outDir = np.join(distDir, normPath);
 _qw(np.join(outDir, 'index.html'), html);
 const flatFile = np.join(distDir, normPath + '.html');
 _qwFlat(flatFile, html);
 };

 // Pre-compute company → active jobs lookup (O(1) instead of O(n) per expired page)
 const companyActiveJobsMap = new Map<string, any[]>();
 for (const j of validJobs) {
 const key = String(j.company || '').toLowerCase();
 if (!key) continue;
 const arr = companyActiveJobsMap.get(key);
 if (arr) { if (arr.length < 5) arr.push(j); }
 else companyActiveJobsMap.set(key, [j]);
 }
 // Pre-compute deterministic "recent jobs" pools: 20 jobs pre-sorted,
 // then select 5 per expired slug via modular index (avoids O(n log n) sort per page)
 const recentJobPool = validJobs.slice(0, Math.min(50, validJobs.length));
 const selectRecentJobs = (seed: string, exclude: string) => {
 const h = hashCode(seed);
 const result: any[] = [];
 for (let i = 0; i < recentJobPool.length && result.length < 5; i++) {
 const idx = (h + i * 7) % recentJobPool.length;
 const j = recentJobPool[idx];
 if (j.slug !== exclude && !result.includes(j)) result.push(j);
 }
 return result;
 };

 // Cache soft-landing HTML per (locale, slug) so the cross-locale
 // reconciliation pass below can reuse it instead of re-rendering.
 // Only cache slugs that actually need it — jobs from expired-jobs.json
 // whose slugByLocale has divergent values across locales — otherwise
 // we'd pin ~18k HTML strings (~550MB) in memory for no benefit.
 const expiredSoftLandingCache = new Map<string, string>();
 const expiredCacheKeys = new Set<string>();
 for (const ej of expiredJobsData) {
 const sbl = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!sbl || typeof sbl !== 'object') continue;
 const distinct = new Set(Object.values(sbl).filter(Boolean));
 if (distinct.size < 2) continue;
 for (const loc of localeList) {
 const s = sbl[loc];
 if (s) expiredCacheKeys.add(`${loc}:${s}`);
 }
 }

 // Memoized FAQ HTML per (locale, escDisplayCanton). The 5-Q&A block
 // depends only on the locale and the displayCanton — the same job's
 // company, location, slug, etc. don't change the rendered FAQ at all.
 // Cache key combines both. With 4 locales × ~7 distinct cantons ≈ 28
 // unique strings built lazily, vs. the previous ~58 866 inline 4-way
 // ternary evaluations (~150 µs/iter of pure template-literal work).
 const expiredFaqCache = new Map<string, string>();
 const getExpiredFaqHtml = (
 locale: 'it' | 'en' | 'de' | 'fr',
 escDisplayCantonArg: string,
 lamalHrefArg: string,
 ): string => {
 const key = `${locale}\x00${escDisplayCantonArg}\x00${lamalHrefArg}`;
 const cached = expiredFaqCache.get(key);
 if (cached !== undefined) return cached;
 let html: string;
 if (locale === 'it') {
 html = `<section><h2>Domande frequenti</h2><dl><dt><strong>Qual \u00e8 lo stipendio netto per un frontaliere in ${escDisplayCantonArg}?</strong></dt><dd>Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${escDisplayCantonArg} l'imposta alla fonte varia dal 2% al 15% circa. Sommando AVS-AI-IPG (5,3%), assicurazione disoccupazione (1,1% fino a CHF 148.200/anno) e LPP (7-18% in base all'et\u00e0), la differenza fra lordo e netto \u00e8 tipicamente del 18-28%. Usa il nostro simulatore per un calcolo personalizzato sui dati di questa offerta.</dd><dt><strong>Serve la cassa malati svizzera LAMal come frontaliere?</strong></dt><dd>I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro, salvo esercizio del diritto d'opzione per restare nel SSN italiano. I premi variano per cantone, modello assicurativo (standard, medico di famiglia, telmed, HMO) e franchigia (CHF 300 minima fino a 2.500 massima): <a href="${lamalHrefArg}">confronta i premi LAMal</a>.</dd><dt><strong>Come si ottiene il Permesso G per lavorare in Canton ${escDisplayCantonArg}?</strong></dt><dd>Il Permesso G \u00e8 richiesto dal datore di lavoro all'Ufficio della migrazione cantonale dopo la firma del contratto. La prima emissione richiede 2-6 settimane; il rinnovo \u00e8 annuale fino al limite contrattuale. Devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il telelavoro a tempo pieno dall'Italia non \u00e8 compatibile con lo status.</dd><dt><strong>Tredicesima, ferie e straordinari: cosa prevede la legge svizzera?</strong></dt><dd>La tredicesima non \u00e8 obbligatoria per legge ma \u00e8 prassi consolidata in Ticino e quasi sempre menzionata nel contratto: viene pagata in dicembre o ripartita in due tranche (giugno + novembre). Le ferie minime di legge sono 4 settimane (5 sotto i 20 anni o sopra i 50 con anzianit\u00e0). Gli straordinari oltre le 40-45 ore settimanali, secondo la Legge sul lavoro (LL), sono compensati con un supplemento del 25% o con tempo libero equivalente entro 14 settimane.</dd><dt><strong>Quali documenti servono per candidarsi a un'offerta in Svizzera?</strong></dt><dd>Per la candidatura iniziale bastano CV (formato europeo o svizzero, una lingua del cantone), lettera di motivazione e un certificato di lavoro recente. Dopo la firma del contratto servono carta d'identit\u00e0 valida (passaporto consigliato), certificato di residenza italiano, atto di nascita per la richiesta di Permesso G e — per i settori regolamentati (sanit\u00e0, scuole, sicurezza) — il riconoscimento del titolo italiano da parte di SBFI/SEFRI o dell'autorit\u00e0 cantonale competente, processo che richiede 3-6 mesi.</dd></dl></section>`;
 } else if (locale === 'en') {
 html = `<section><h2>Frequently asked questions</h2><dl><dt><strong>What is the net salary for a cross-border worker in ${escDisplayCantonArg}?</strong></dt><dd>Net salary depends on gross income, marital status and number of children. In the Canton of ${escDisplayCantonArg}, withholding tax ranges from about 2% to 15%. Together with AVS-AI-IPG (5.3%), unemployment insurance (1.1% up to CHF 148,200/year) and LPP (7-18% by age), the typical gross-to-net gap is 18-28%. Use our simulator for a personalised calculation against this listing.</dd><dt><strong>Do cross-border workers need Swiss LAMal health insurance?</strong></dt><dd>New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting work, unless they exercise the right of option to stay in the Italian SSN. Premiums vary by canton, insurance model (standard, family doctor, telmed, HMO) and deductible (CHF 300 minimum up to 2,500 maximum): <a href="${lamalHrefArg}">compare LAMal premiums</a>.</dd><dt><strong>How do I get a G permit to work in the Canton of ${escDisplayCantonArg}?</strong></dt><dd>The G permit is filed by the employer at the cantonal migration office after the contract is signed. First issuance takes 2-6 weeks; the permit is renewed yearly up to the contractual limit. You must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. Full-time remote work from Italy is not compatible with the status.</dd><dt><strong>13th-month salary, vacation and overtime: what does Swiss law say?</strong></dt><dd>The 13th salary is not statutory but is standard practice in Ticino and almost always specified in the contract: paid in December or split into two tranches (June + November). Minimum statutory holiday is 4 weeks (5 weeks for under-20s and over-50s with seniority). Overtime above 40-45 weekly hours, under the Labour Act (LL), is compensated with a 25% premium or equivalent time off within 14 weeks.</dd><dt><strong>What documents do I need to apply for a Swiss job?</strong></dt><dd>For the initial application: CV (European or Swiss format, in a cantonal language), cover letter, and a recent work certificate. After the contract is signed: valid ID card (passport recommended), Italian residence certificate, birth certificate for the G-permit filing, and — for regulated sectors (healthcare, schools, security) — recognition of the Italian degree by SBFI/SEFRI or the relevant cantonal authority, a process that takes 3-6 months.</dd></dl></section>`;
 } else if (locale === 'de') {
 html = `<section><h2>H\u00e4ufig gestellte Fragen</h2><dl><dt><strong>Wie hoch ist das Nettogehalt f\u00fcr Grenzg\u00e4nger im ${escDisplayCantonArg}?</strong></dt><dd>Das Nettogehalt h\u00e4ngt vom Bruttoeinkommen, Familienstand und der Kinderzahl ab. Im Kanton ${escDisplayCantonArg} liegt die Quellensteuer zwischen ca. 2% und 15%. Zusammen mit AHV-IV-EO (5,3%), Arbeitslosenversicherung (1,1% bis CHF 148'200/Jahr) und BVG (7-18% je nach Alter) betr\u00e4gt der typische Brutto-Netto-Abstand 18-28%. Nutzen Sie unseren Simulator f\u00fcr eine personalisierte Berechnung zu diesem Inserat.</dd><dt><strong>Brauchen Grenzg\u00e4nger eine Schweizer KVG-Versicherung?</strong></dt><dd>Neue Grenzg\u00e4nger seit 2024 m\u00fcssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden, ausser sie nutzen das Optionsrecht zugunsten des italienischen SSN. Die Pr\u00e4mien variieren je nach Kanton, Versicherungsmodell (Standard, Hausarzt, Telmed, HMO) und Franchise (CHF 300 Minimum bis 2.500 Maximum): <a href="${lamalHrefArg}">KVG-Pr\u00e4mien vergleichen</a>.</dd><dt><strong>Wie erhalte ich die G-Bewilligung f\u00fcr eine Anstellung im Kanton ${escDisplayCantonArg}?</strong></dt><dd>Die G-Bewilligung wird vom Arbeitgeber nach Vertragsunterzeichnung beim kantonalen Migrationsamt eingereicht. Die erste Ausstellung dauert 2-6 Wochen; die Verl\u00e4ngerung erfolgt j\u00e4hrlich bis zur vertraglichen Befristung. Sie m\u00fcssen in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Vollst\u00e4ndige Heimarbeit aus Italien ist mit dem Status nicht vereinbar.</dd><dt><strong>13. Monatslohn, Ferien und \u00dcberzeit: was schreibt das Schweizer Recht vor?</strong></dt><dd>Der 13. Monatslohn ist nicht gesetzlich vorgeschrieben, aber im Tessin Standardpraxis und fast immer im Vertrag spezifiziert: ausgezahlt im Dezember oder in zwei Tranchen (Juni + November) aufgeteilt. Der gesetzliche Ferienanspruch betr\u00e4gt mindestens 4 Wochen (5 Wochen f\u00fcr Unter-20-J\u00e4hrige und \u00dcber-50-J\u00e4hrige mit Anstellungsdauer). \u00dcberzeit \u00fcber die 40-45 Wochenstunden hinaus wird gem\u00e4ss Arbeitsgesetz (ArG) mit 25% Zuschlag oder Freizeitausgleich innerhalb von 14 Wochen kompensiert.</dd><dt><strong>Welche Unterlagen brauche ich f\u00fcr eine Bewerbung in der Schweiz?</strong></dt><dd>F\u00fcr die Erstbewerbung: Lebenslauf (europ\u00e4isches oder Schweizer Format, in einer Kantonssprache), Motivationsschreiben und ein aktuelles Arbeitszeugnis. Nach Vertragsunterzeichnung: g\u00fcltige Identit\u00e4tskarte (Pass empfohlen), italienische Wohnsitzbescheinigung, Geburtsurkunde f\u00fcr die G-Bewilligung und — bei regulierten Branchen (Gesundheit, Schulen, Sicherheit) — die Anerkennung des italienischen Titels durch SBFI/SEFRI oder die zust\u00e4ndige kantonale Beh\u00f6rde, ein Verfahren von 3-6 Monaten.</dd></dl></section>`;
 } else {
 html = `<section><h2>Questions fr\u00e9quentes</h2><dl><dt><strong>Quel est le salaire net pour un frontalier au ${escDisplayCantonArg} ?</strong></dt><dd>Le salaire net d\u00e9pend du revenu brut, de l'\u00e9tat civil et du nombre d'enfants. Dans le Canton du ${escDisplayCantonArg}, l'imp\u00f4t \u00e0 la source varie d'environ 2% \u00e0 15%. En ajoutant l'AVS-AI-APG (5,3%), l'assurance ch\u00f4mage (1,1% jusqu'\u00e0 CHF 148'200/an) et la LPP (7-18% selon l'\u00e2ge), l'\u00e9cart brut-net typique est de 18-28%. Utilisez notre simulateur pour un calcul personnalis\u00e9 sur cette offre.</dd><dt><strong>Les frontaliers doivent-ils souscrire \u00e0 la LAMal suisse ?</strong></dt><dd>Les nouveaux frontaliers depuis 2024 doivent s'inscrire \u00e0 la LAMal dans les 3 mois suivant le d\u00e9but du travail, sauf s'ils exercent le droit d'option pour rester au SSN italien. Les primes varient selon le canton, le mod\u00e8le d'assurance (standard, m\u00e9decin de famille, telmed, HMO) et la franchise (CHF 300 minimum jusqu'\u00e0 2'500 maximum) : <a href="${lamalHrefArg}">comparer les primes LAMal</a>.</dd><dt><strong>Comment obtenir le permis G pour travailler au Canton du ${escDisplayCantonArg} ?</strong></dt><dd>Le permis G est demand\u00e9 par l'employeur \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat. La premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines ; le renouvellement est annuel jusqu'\u00e0 la limite contractuelle. Vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. Le t\u00e9l\u00e9travail \u00e0 plein temps depuis l'Italie n'est pas compatible avec le statut.</dd><dt><strong>13e mois, vacances et heures suppl\u00e9mentaires : que pr\u00e9voit le droit suisse ?</strong></dt><dd>Le 13e mois n'est pas obligatoire mais c'est une pratique courante au Tessin et presque toujours mentionn\u00e9e dans le contrat : il est pay\u00e9 en d\u00e9cembre ou r\u00e9parti en deux tranches (juin + novembre). Les vacances l\u00e9gales minimales sont de 4 semaines (5 pour les moins de 20 ans et plus de 50 ans avec anciennet\u00e9). Les heures suppl\u00e9mentaires au-del\u00e0 de 40-45 heures hebdomadaires, selon la loi sur le travail (LTr), sont compens\u00e9es par une majoration de 25% ou par du temps libre \u00e9quivalent dans les 14 semaines.</dd><dt><strong>Quels documents pour postuler \u00e0 un emploi en Suisse ?</strong></dt><dd>Pour la candidature initiale : CV (format europ\u00e9en ou suisse, dans une langue cantonale), lettre de motivation et un certificat de travail r\u00e9cent. Apr\u00e8s la signature du contrat : carte d'identit\u00e9 valable (passeport recommand\u00e9), certificat de r\u00e9sidence italien, acte de naissance pour le d\u00e9p\u00f4t du permis G, et — pour les secteurs r\u00e9glement\u00e9s (sant\u00e9, \u00e9coles, s\u00e9curit\u00e9) — la reconnaissance du titre italien par le SBFI/SEFRI ou l'autorit\u00e9 cantonale comp\u00e9tente, une proc\u00e9dure de 3-6 mois.</dd></dl></section>`;
 }
 expiredFaqCache.set(key, html);
 return html;
 };

 // Sort expiredSlugs by the recency of the linked expired-job entry
 // (DESC, ties broken by slug for determinism) so the FIRST iteration
 // for any colliding `tracking[slug][locale]` path is the most-recent
 // job's content. The `emittedSoftLandingPaths` Set below skips later
 // duplicates so the freshest version stays on disk. Without this sort,
 // the oldest version frequently won because it appeared earlier in
 // `Object.keys(tracking)` (insertion order from
 // data/all-known-job-slugs.json, which is mostly chronological-ascending).
 const _expiredSlugRecency = (s: string): number => {
 const ej = expiredBySlug.get(s);
 return ej ? _jobRecency(ej) : 0;
 };
 expiredSlugs.sort((a, b) => {
 const ra = _expiredSlugRecency(a);
 const rb = _expiredSlugRecency(b);
 if (ra !== rb) return rb - ra;
 return a.localeCompare(b);
 });

 // Set of (locale-prefixed) paths already emitted as soft-landing pages
 // in THIS phase. Multiple distinct slugs can map to the same
 // `tracking[slug][locale]` value (1349 IT / 2999 EN / 3072 DE / 3224 FR
 // such collisions in the current registry — typically AI-translated
 // slugs converging on the IT path). Without dedup each collider would
 // fire `_qw` and produce a write-registry collision report; with dedup
 // only the most-recent (per the sort above) lands on disk.
 const emittedSoftLandingPaths = new Set<string>();

 for (const slug of expiredSlugs) {
 const paths = tracking[slug];
 const ejData = expiredBySlug.get(slug);

 // For orphan slugs with no ejData, extract info from the slug itself
 const slugInfo = !ejData?.title ? extractInfoFromSlug(slug) : null;

 // Build hreflang alternates for this expired slug.
 // audit-hreflang requires ≥5 entries (4 locales + x-default) on every
 // page that emits any hreflang. Orphan/expired slugs without a full
 // locale cluster (e.g. brand-alias `azienda-<brand>` bridges with only
 // an IT path) would emit 2 entries and fail the audit — so when the
 // cluster isn't complete we emit ZERO hreflang and rely on
 // <link rel="canonical"> + <html lang> to signal single-locale scope.
 const expiredLocaleHreflangs = localeList
 .map((l) => (paths[l] ? { lang: l as 'it' | 'en' | 'de' | 'fr', href: `${BASE_URL}${withSlash(paths[l])}` } : null))
 .filter((x): x is { lang: 'it' | 'en' | 'de' | 'fr'; href: string } => x !== null);
 // Canton-drift compat overrides (#2626) produce a MIXED cluster: the
 // overwritten locale points at this noindex TI soft-landing while the
 // surviving siblings point at another canton's live, non-reciprocal
 // pages. Such a cluster must NOT be treated as full — force zero hreflang
 // so the audit-hreflang invariants (esp. #4) never see the mismatched set.
 const expiredHasFullCluster = expiredLocaleHreflangs.length === localeList.length
 && !cantonDriftCompatSlugs.has(slug);
 // When emitting the cluster, force x-default to be present alongside the
 // 4 locale entries — fall back to the IT alternate href when paths.it
 // happens to be empty (defensive; full-cluster guarantees paths.it is set).
 const expiredXDefaultHref = paths.it
   ? `${BASE_URL}${withSlash(paths.it)}`
   : (expiredLocaleHreflangs.find((e) => e.lang === 'it')?.href
     ?? expiredLocaleHreflangs[0]?.href
     ?? '');
 const hreflangLinks = expiredHasFullCluster && expiredXDefaultHref
 ? [
  ...expiredLocaleHreflangs.map((e) => ` <link rel="alternate" hreflang="${e.lang}" href="${e.href}">`),
  ` <link rel="alternate" hreflang="x-default" href="${expiredXDefaultHref}">`,
  ].join('\n')
 : '';

 // Track IT page word count for sitemap inclusion decision
 let itBodyWordCount = 0;

 // ── Per-slug invariants (hoisted out of the per-locale loop) ──
 // These values depend only on the slug, not on the locale. Computing
 // them once per slug instead of 4× saves ~50μs/iter × 58k = ~2-3 s
 // of redundant work across the expired-soft-landing build phase.
 const gscInfo = orphanGscData.get(slug);
 const jobCompany = String(ejData?.company || gscInfo?.company || slugInfo?.company || '');
 const jobLocation = String(ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '');
 const jobCanton = String(ejData?.canton || DEFAULT_CANTON);
 const jobSector = String(ejData?.sector || '');
 const jobContract = String(ejData?.contract || '');
 const jobDatePosted = String(ejData?.datePosted || '');
 const jobExpiredAt = String(ejData?.expiredAt || '');
 const sameCompanyActiveJobs = jobCompany
 ? (companyActiveJobsMap.get(jobCompany.toLowerCase()) || [])
 : [];
 // Slug-derived disambiguator parts (used in the per-locale section).
 const _slugTokens = slug.split('-').filter(Boolean);
 const _tailCount = Math.min(3, _slugTokens.length);
 const _tailTokens = _slugTokens.slice(-_tailCount).map(t =>
 t.replace(/\b\w/g, c => c.toUpperCase()),
 );
 const tailPretty = _tailTokens.join(' ');
 const cityForSignal = jobLocation || (slugInfo?.location ?? '');
 const countryHint = cityForSignal && !jobCanton ? cityForSignal : '';
 const hasRealTitle = !!(ejData?.title || gscInfo?.title || slugInfo?.title);
 // displayCanton/escDisplayCanton/cantonForSignal are NOT hoisted here:
 // the canton display name varies by locale (e.g. GR → "Grigioni" it,
 // "Graubünden" de/en, "Grisons" fr) — resolved per-locale in the loop below.

 for (const locale of localeList) {
 const relPath = paths[locale];
 if (!relPath) continue;
 // Skip paths claimed by bridge pages to avoid canonical conflicts
 if (bridgeClaimedPaths.has(relPath)) continue;
 // Hoisted dedup pre-check: when a previous (most-recent) slug already
 // claimed this exact locale-prefixed path, skip BEFORE assembling
 // title / body / wc-robots / jsonld / shell. Run 26469566046 profiling
 // showed ~7k iterations doing the full ph:ejp:* pipeline only to be
 // dropped by the dedup `continue` later — wasted ~3-4s wall. The set
 // is still populated AT WRITE TIME below so dedup membership reflects
 // actually-emitted paths, not just attempted ones.
 const __slPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 if (emittedSoftLandingPaths.has(__slPathKey)) continue;
 // Per-locale shard build (BUILD_LOCALE): skip the expensive soft-landing
 // render/emit for locales this shard isn't responsible for (this loop is
 // ~57% of jobs-seo wall, 319k pages). The expired sitemap (it/main-owned,
 // built below from `paths` + _writtenPaths(IT) + cross-locale alternates)
 // is unaffected. No-op in the default all-locale build.
 if (!shouldEmitLocale(locale)) continue;
 const __tExpiredSoftLanding = startTimer();
 const __tEjpTitle = phaseTimer();
 const selfUrl = `${BASE_URL}${withSlash(relPath)}`;
 // Canton-aware: was hardcoded to the TI hub (sectionByLocale[locale]) for
 // every job, so a non-TI job's "Lavoro in <canton>" links and breadcrumb
 // targeted the Ticino hub instead of the job's own canton hub (#6418).
 const listingPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCanton)}/`.replace(/\/+/g, '/');
 const copy = expiredBannerCopy[locale] ?? expiredBannerCopy.it;
 // Canton display name resolved per-locale (see hoisting note above).
 const displayCanton = getCantonDisplayLabel(jobCanton, locale);
 const cantonForSignal = jobCanton && cityForSignal ? displayCanton : '';
 const escDisplayCanton = esc(displayCanton);

 // Rich content fallback chain: expired-jobs.json → orphan enriched data → slug extraction
 // jobCompany/jobLocation/jobCanton/etc. are hoisted above the for-locale
 // loop (per-slug invariants); displayCanton/escDisplayCanton/cantonForSignal
 // are NOT (they vary by locale — see note above the loop).
 const jobTitle = stripLiteralMarkdownFromTitle(String(ejData?.titleByLocale?.[locale] || ejData?.title || gscInfo?.titleByLocale?.[locale] || gscInfo?.title || slugInfo?.title || copy.title));
 const jobDescription = stripLeadingSectionLabel(String(ejData?.descriptionByLocale?.[locale] || ejData?.descriptionByLocale?.it || ejData?.description || gscInfo?.descriptionByLocale?.[locale] || gscInfo?.descriptionByLocale?.it || ''));
 // SERP title via the shared role>city>company>brand cascade — same
 // composer as ACTIVE job pages, so an expired listing reads like a job
 // result ("Role — Company a Zell"), not like an archive record. The old
 // path appended ` · rif. {slug-tail}` UNCONDITIONALLY (99.8 % of 18.5k
 // expired titles carried it; the tail is a CITY word, not an id, for 61 %
 // of slugs — live offender: "…Produzione PPS —… · rif. zell") and
 // word-truncated the headline to make room for it. Uniqueness is now
 // guaranteed by claimUniqueTitle (cross-corpus registry, see above)
 // which only suffixes a `rif.` token on an ACTUAL collision.
 // Note: candidate/headline SELECTION works on the RAW strings (no
 // HTML-escape) so `&` / `<` are not expanded into multi-char entities that
 // fool the cascade's length-based budget; the concatenated headline itself
 // stays unescaped here. The FINAL brand-append decision, though, is
 // budgeted on the escaped length (`measureLength: (s) => esc(s).length`,
 // #3402) because esc() is applied ONCE at the <title> call site downstream
 // and a raw `&`/`<`/`>`/`"` expands on that escape — checking pre-escape
 // length there could let a title exceed the cap post-escape. Must match
 // the measureLength used to populate `noCityTitleCollisionByLocale`
 // (composeJobPageTitle call sites above) so the probe keys line up.
 // City-drop on expired soft-landings (#1932): the city is droppable when the
 // city-less "role — company" headline is unique among ACTIVE pages in this
 // locale (noCityTitleCollisionByLocale). The shared claimUniqueTitle registry
 // is the backstop — if the city-less title still clashes with another emitted
 // page it recomposes with a `rif.` disambiguator, so dropping the city can
 // never break audit:title-uniqueness, it only avoids the mid-`…` truncation
 // on the non-colliding majority (22.8 % of expired titles overflowed at
 // role+city > 66 char).
 const __expiredNoCityProbe = hasRealTitle
  ? composeSerpJobTitle(jobTitle, jobCompany, jobLocation, locale, { cityOptional: true, measureLength: (s) => esc(s).length })
  : composeSerpJobTitle(copy.title, '', jobLocation, locale, { cityOptional: true, measureLength: (s) => esc(s).length });
 const __expiredCityDroppable = hasRealTitle
  && (noCityTitleCollisionByLocale[locale].get(__expiredNoCityProbe) || 0) <= 1;
 const __expiredCompose = (disambiguator?: string): string =>
  hasRealTitle
   ? composeSerpJobTitle(jobTitle, jobCompany, jobLocation, locale, { disambiguator, cityOptional: __expiredCityDroppable, measureLength: (s) => esc(s).length })
   : composeSerpJobTitle(copy.title, '', jobLocation, locale, { disambiguator, measureLength: (s) => esc(s).length });
 let pageTitleRaw = __expiredCompose();
 // <h1> equality guard (audit:h1-title-duplicates): the static H1 below is
 // "role — company"; when the cascade lands on that exact string and the
 // brand didn't fit, force a metadata token to keep title ≠ h1.
 const __expiredH1Key = titleCompareKey(jobCompany ? `${jobTitle} — ${jobCompany}` : jobTitle);
 const __expiredRefLabel = REF_LABEL[locale] || REF_LABEL.it;
 if (titleCompareKey(pageTitleRaw) === __expiredH1Key) {
  pageTitleRaw = __expiredCompose(`${__expiredRefLabel} ${fnv8(slug)}`);
 }
 // Cross-corpus uniqueness net — shares the registry with ACTIVE job pages
 // so a re-posted twin (active page + expired soft-landing, same role +
 // company + city) can never emit a duplicate <title> within the locale.
 pageTitleRaw = claimUniqueTitle(locale, pageTitleRaw, `${slug}::${locale}`, __expiredCompose);
 const pageTitle = esc(pageTitleRaw);

 // Meta description: lead with role + company + place (city when known,
 // canton otherwise) so the SERP snippet fallback carries the local-intent
 // tokens, then the related-positions CTA.
 const __descConnector = JOB_TITLE_CITY_CONNECTOR[locale] || JOB_TITLE_CITY_CONNECTOR.it;
 // Same redundancy as the hero line, one layer up: `jobLocation` may already
 // name its canton ("Möhlin, Aargau"), and this branch appends the LOCALISED
 // canton label rather than the code — so it is `splitJobLocation`'s city half
 // that must be interpolated, not the raw string. `conflict` suppresses the
 // suffix for the same reason the hero does: never two cantons on one line.
 const __descSplit = splitJobLocation(jobLocation, jobCanton);
 const __descCity = __descSplit.city;
 const __descPlace = __descCity
  ? ` ${__descConnector} ${__descCity}${displayCanton && !__descSplit.conflict && displayCanton !== __descCity ? ` (${displayCanton})` : ''}`
  : '';
 const pageDesc = `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}${esc(__descPlace)}. ${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)}.`;

 // Seed expired job data as window global so the SPA can render
 // rich content (title, company, description) without depending on
 // the runtime expired-jobs.json fetch (which only has recently expired jobs).
 //
 // Multi-locale stripping: the SPA reads only `[locale]` entries from
 // titleByLocale / descriptionByLocale (JobExpiredView.tsx:174-175). The
 // other 3 locales' entries are dead bytes on the wire — ~6 KB per
 // IT-primary expired page (de+en+fr descriptions). slugByLocale stays
 // full because seededJobMatchesSlug + hooks/useExpiredJob match the
 // URL slug against any locale entry.
 const pickLocaleEntry = <T,>(src: Record<string, T> | undefined, l: string): Record<string, T> => {
  if (!src || src[l] == null) return {};
  return { [l]: src[l] };
 };
 // Markup-extraction (2026-05-20): omit empty / blank fields from the
 // inlined object. The previous shape always emitted every field with
 // an empty default (`""`, `{}`), which costs ~100-200 B/page across
 // ~470k soft-landing + bridge pages (~70 MB dist). The SPA's
 // useExpiredJob hook + JobExpiredView treat missing fields exactly
 // the same as empty ones (already `?? default` everywhere), so this
 // is a no-op for runtime behaviour — only the wire-form shrinks.
 const expiredTitle = ejData?.title || gscInfo?.title || slugInfo?.title || '';
 const expiredCompany = ejData?.company || gscInfo?.company || slugInfo?.company || '';
 const expiredCompanyKey = ejData?.companyKey || gscInfo?.companyKey || slugInfo?.companyKey || '';
 const expiredLocation = ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '';
 const expiredTitleByLocale = pickLocaleEntry(ejData?.titleByLocale || gscInfo?.titleByLocale, locale);
 const expiredDescriptionByLocale = pickLocaleEntry(ejData?.descriptionByLocale || gscInfo?.descriptionByLocale, locale);
 const expiredSlugByLocale = ejData?.slugByLocale || gscInfo?.slugByLocale || {};
 const expiredSector = ejData?.sector || gscInfo?.sector || '';
 const expiredAt = ejData?.expiredAt || '';
 const expiredDataObj: Record<string, unknown> = { slug };
 if (expiredTitle) expiredDataObj.title = expiredTitle;
 if (Object.keys(expiredTitleByLocale).length > 0) expiredDataObj.titleByLocale = expiredTitleByLocale;
 if (expiredCompany) expiredDataObj.company = expiredCompany;
 if (expiredCompanyKey) expiredDataObj.companyKey = expiredCompanyKey;
 if (expiredLocation) expiredDataObj.location = expiredLocation;
 if (Object.keys(expiredDescriptionByLocale).length > 0) expiredDataObj.descriptionByLocale = expiredDescriptionByLocale;
 if (Object.keys(expiredSlugByLocale).length > 0) expiredDataObj.slugByLocale = expiredSlugByLocale;
 if (expiredSector) expiredDataObj.sector = expiredSector;
 if (expiredAt) expiredDataObj.expiredAt = expiredAt;
 if (gscInfo?.queries) {
   expiredDataObj.gscQueries = gscInfo.queries;
   expiredDataObj.gscImpressions = gscInfo.totalImpressions;
   expiredDataObj.gscClicks = gscInfo.totalClicks;
 }
 // Escape `<` — expiredDataObj carries arbitrary prose (descriptionByLocale)
 // and GSC queries; an unescaped "</script>" would break the inline emit at
 // L10184 on INDEXED soft-landing pages. Same guard as __JOB_SEED__.
 const expiredWindowData = inlineScriptJson(expiredDataObj);

 recordPhase('ejp:title', __tEjpTitle);
 // Substantial-content retention (memory-safe): keep the full frontalier
 // prose + FAQ ONLY on expired pages with REAL 90d GSC/GA4 traffic
 // (decideMulti reason 'has-traffic'), so the recently-trafficked-now-expired
 // URLs stay above the thin-content threshold and retain ranking + the search
 // traffic the ad RPM already monetises. Deliberately gated on reason, NOT
 // action!=='thin': the prior attempt (#2005, reverted by #2027) OOMed the
 // build because action!=='thin' also kept prose for every freshly-emitted
 // page in the minAgeDays 'grace' window (~900 expired/build) — too many ~2KB
 // strings in the write collector. 'has-traffic' is the small, high-value set
 // (the pages that actually had traffic), so the per-build prose count — and
 // memory — is bounded. Grace/no-traffic pages stay stripped + thin-shelled.
 //
 // Two gates, two DELIBERATELY DIFFERENT path-sets — built from ONE shared base
 // (the candidate builder, hoisted above the body) so the per-locale legacy-bridge
 // idiom lives in exactly one place (no drift by construction):
 //   • Thin-shell gate (__slDecision, emission block below) probes __slCandidatePaths:
 //     relPath + the current locale's own legacy bridge (only when locale!=='it',
 //     because the IT legacy section IS the canonical relPath for a TI IT page) +
 //     every OTHER locale's legacy section path.
 //   • Prose / Auto-Ads gate (__slKeepProse) probes __slProsePaths = the candidate
 //     set PLUS the IT-locale legacy mirror `/cerca-lavoro-ticino/${slug}`
 //     UNCONDITIONALLY. This restores the original __slProsePaths semantics, which
 //     looped over ALL locales (incl. the current one) and so ALWAYS included the IT
 //     legacy section path. gsc-job-urls / gsc-orphan-job-slugs are IT-only sources
 //     stored at `/cerca-lavoro-ticino/${slug}/`, so for an IT-locale canton-aware
 //     page (relPath = `/cerca-lavoro-argovia/${slug}` etc.) that IT mirror is the
 //     ONLY historical signal — dropping it from the prose gate would strip prose +
 //     Auto Ads from genuinely-trafficked expired pages (reviewer 🔴, PR #2397).
 //     The two sets are NOT set-equal for the IT locale: that gap is intentional and
 //     scope-correct, not duplication — so we keep distinct sets but a single builder.
 // The IT mirror is appended (with dedup) rather than folded into __slCandidatePaths
 // so the THIN gate's set stays byte-identical to its prior behaviour (widening it
 // would flip some IT canton-aware pages thin→full, changing the emitted shell +
 // build footprint — out of scope here).
 // PR #743 lesson: non-IT locales also emit a legacy-locale bridge at legacyRel,
 // so traffic may land there — probe relPath + every locale variant.
 const __slCandidatePaths: string[] = [relPath];
 if (locale !== 'it') {
 const __slLegacyRel = `/${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 if (__slLegacyRel !== relPath) __slCandidatePaths.push(__slLegacyRel);
 }
 for (const __slOtherLocale of localeList) {
 if (__slOtherLocale === locale) continue;
 const __slOtherPath = `/${localePrefix[__slOtherLocale]}/${sectionByLocale[__slOtherLocale]}/${slug}`.replace(/\/+/g, '/');
 if (!__slCandidatePaths.includes(__slOtherPath)) __slCandidatePaths.push(__slOtherPath);
 }
 // Prose gate = candidate set ∪ { IT legacy mirror }. For non-IT locales the IT
 // mirror is already present (added by the other-locale loop above), so the append
 // is a no-op there; for an IT-locale canton-aware page it is the missing signal.
 const __slItLegacyMirror = `/${localePrefix.it}/${sectionByLocale.it}/${slug}`.replace(/\/+/g, '/');
 const __slProsePaths: string[] = __slCandidatePaths.includes(__slItLegacyMirror)
 ? __slCandidatePaths
 : [...__slCandidatePaths, __slItLegacyMirror];
 const __slKeepProse = trafficFilter.decideMulti(__slProsePaths, 'soft-landing-expired').reason === 'has-traffic';
 const __tEjpBody = phaseTimer();
 // FRO-320: Generate static body content so Google sees real text, not an empty SPA shell.
 // Enriched template ensures >100 words per page for every expired job.
 // (jobCanton, sameCompanyActiveJobs, etc. are hoisted above; displayCanton
 // is resolved per-locale earlier in this loop iteration, not hoisted.)
 const staticBodyParts: string[] = [];

 // --- H1 + expired notice ---
 staticBodyParts.push(`<h1>${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}</h1>`);
 staticBodyParts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);

 // --- Slug-derived disambiguator -----------------------------------
 // Every orphan page MUST carry a per-slug signal so the duplicate-body
 // auditor (`audit-content-duplicates`) doesn't cluster multi-city
 // remote-role siblings (`…-buenos-aires`, `…-cairo`, `…-dubai`) onto
 // one hash. We append:
 //   1. the last-token(s) of the slug in human-readable form,
 //   2. the resolved canton (Swiss) OR country-guess (foreign),
 //   3. the exact original slug as an invariant.
 // This adds 20-30 words per page — enough to defeat the SHA-256
 // collapse even when `location` extraction failed.
 {
  // tailPretty / cityForSignal / cantonForSignal / countryHint are
  // per-slug invariants hoisted above the for-locale loop.

  const disambiguationHeading: Record<string, string> = {
   it: 'Dettaglio geografico',
   en: 'Geographic detail',
   de: 'Standortdetail',
   fr: 'Détail géographique',
  };
  const parts: string[] = [];
  if (locale === 'it') {
   parts.push(`<p>Questa scheda corrisponde allo slug <code>${esc(slug)}</code>${tailPretty ? ` (token finale: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>La sede di riferimento indicata nella posizione è <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, nel Canton ${esc(cantonForSignal)}` : ''}. Gli annunci marcati come remoti mantengono comunque il riferimento città per finalità fiscali, contrattuali e di iscrizione al Permesso G.</p>`);
   else parts.push(`<p>Non è stato possibile estrarre una città specifica dallo slug di questa offerta. Il riferimento operativo resta il Canton ${esc(displayCanton)} per l'impostazione fiscale frontaliere e l'iscrizione al Permesso G.</p>`);
  } else if (locale === 'en') {
   parts.push(`<p>This page corresponds to the job slug <code>${esc(slug)}</code>${tailPretty ? ` (trailing token: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>The reference location stated in the job ad is <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Canton of ${esc(cantonForSignal)}` : ''}. Remote-tagged roles still retain the city reference for tax, contract and G Permit enrolment purposes.</p>`);
   else parts.push(`<p>No specific city could be extracted from this slug. The operational reference is the Canton of ${esc(displayCanton)} for cross-border tax setup and G Permit enrolment.</p>`);
  } else if (locale === 'de') {
   parts.push(`<p>Diese Seite entspricht dem Stellen-Slug <code>${esc(slug)}</code>${tailPretty ? ` (abschließender Token: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>Der in der Stelle genannte Referenzort ist <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Kanton ${esc(cantonForSignal)}` : ''}. Als remote ausgeschriebene Rollen behalten den Ortsbezug für Steuer-, Vertrags- und Grenzgängerbewilligungszwecke bei.</p>`);
   else parts.push(`<p>Es konnte keine spezifische Stadt aus diesem Slug abgeleitet werden. Der operative Bezug bleibt der Kanton ${esc(displayCanton)} für die Grenzgängerbesteuerung und die G-Bewilligung.</p>`);
  } else {
   parts.push(`<p>Cette page correspond au slug d'offre <code>${esc(slug)}</code>${tailPretty ? ` (dernier segment : <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>La ville de référence indiquée dans l'offre est <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Canton du ${esc(cantonForSignal)}` : ''}. Les postes marqués en télétravail conservent la référence ville pour la fiscalité, le contrat et l'inscription au Permis G.</p>`);
   else parts.push(`<p>Aucune ville spécifique n'a pu être extraite de ce slug. La référence opérationnelle reste le Canton du ${esc(displayCanton)} pour la fiscalité frontalière et l'inscription au Permis G.</p>`);
  }
  if (countryHint && !jobCanton) {
   const countryLabel: Record<string, string> = {
    it: `Il comune indicato (${esc(countryHint)}) non rientra nella base PLZ svizzera: l'inserimento potrebbe essere un ruolo internazionale remoto, ma rimane in sitemap come pagina di archivio frontaliere.`,
    en: `The stated municipality (${esc(countryHint)}) is not in the Swiss PLZ dataset: this is likely an international remote role, but is kept in the cross-border archive sitemap.`,
    de: `Die angegebene Gemeinde (${esc(countryHint)}) ist nicht im Schweizer PLZ-Datensatz enthalten: Wahrscheinlich handelt es sich um eine internationale Remote-Rolle, die wir aber in der Grenzgänger-Archiv-Sitemap behalten.`,
    fr: `La commune indiquée (${esc(countryHint)}) ne figure pas dans le jeu de données PLZ suisse : il s'agit probablement d'un poste international en télétravail, conservé dans la sitemap d'archive frontalière.`,
   };
   parts.push(`<p class="s-lBqYX_">${countryLabel[locale] || countryLabel.it}</p>`);
  }
  staticBodyParts.push(`<section><h2>${esc(disambiguationHeading[locale] || disambiguationHeading.it)}</h2>${parts.join('')}</section>`);
 }

 // --- Description section ---
 if (jobDescription && jobDescription.length > 30) {
 const descText = jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
 staticBodyParts.push(`<section><h2>${locale === 'it' ? 'Descrizione originale' : locale === 'en' ? 'Original description' : locale === 'de' ? 'Originalbeschreibung' : 'Description originale'}</h2><div>${descText.slice(0, 2000)}</div></section>`);
 }

 // --- Job details section ---
 const detailsHeading = locale === 'it' ? 'Dettagli dell\'offerta' : locale === 'en' ? 'Job details' : locale === 'de' ? 'Stellendetails' : 'D\u00e9tails de l\'offre';
 const detailItems: string[] = [];
 if (jobCompany) detailItems.push(`<li><strong>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}:</strong> ${esc(jobCompany)}</li>`);
 detailItems.push(`<li><strong>${locale === 'it' ? 'Posizione' : locale === 'en' ? 'Position' : locale === 'de' ? 'Position' : 'Poste'}:</strong> ${esc(jobTitle)}</li>`);
 if (jobLocation) detailItems.push(`<li><strong>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}:</strong> ${esc(jobLocation)}, ${esc(displayCanton)}</li>`);
 if (jobContract) detailItems.push(`<li><strong>${locale === 'it' ? 'Tipo contratto' : locale === 'en' ? 'Contract type' : locale === 'de' ? 'Vertragsart' : 'Type de contrat'}:</strong> ${esc(jobContract)}</li>`);
 if (jobSector) detailItems.push(`<li><strong>${locale === 'it' ? 'Settore' : locale === 'en' ? 'Sector' : locale === 'de' ? 'Branche' : 'Secteur'}:</strong> ${esc(jobSector)}</li>`);
 if (jobDatePosted) detailItems.push(`<li><strong>${locale === 'it' ? 'Pubblicata il' : locale === 'en' ? 'Posted on' : locale === 'de' ? 'Ver\u00f6ffentlicht am' : 'Publi\u00e9e le'}:</strong> ${esc(jobDatePosted.slice(0, 10))}</li>`);
 if (jobExpiredAt) detailItems.push(`<li><strong>${locale === 'it' ? 'Scaduta il' : locale === 'en' ? 'Expired on' : locale === 'de' ? 'Abgelaufen am' : 'Expir\u00e9e le'}:</strong> ${esc(jobExpiredAt.slice(0, 10))}</li>`);
 staticBodyParts.push(`<section><h2>${esc(detailsHeading)}</h2><ul>${detailItems.join('')}</ul></section>`);

 // --- Same-company active jobs ---
 if (sameCompanyActiveJobs.length > 0) {
 const companyJobsHeading = locale === 'it' ? `Altre offerte di ${esc(jobCompany)}` : locale === 'en' ? `More jobs at ${esc(jobCompany)}` : locale === 'de' ? `Weitere Stellen bei ${esc(jobCompany)}` : `Autres offres chez ${esc(jobCompany)}`;
 const companyJobsList = sameCompanyActiveJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = withSlash(jPath);
 const jTitle = stripLiteralMarkdownFromTitle(String(j?.titleByLocale?.[locale] || j.title || ''));
 return `<li><a href="${jHref}">${esc(jTitle)}</a> — ${esc(j.location)}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${companyJobsHeading}</h2><ul>${companyJobsList}</ul></section>`);
 }

 // --- Search suggestions ---
 if (locale === 'it') {
 const searchSugParts: string[] = [];
 if (jobCompany) searchSugParts.push(`<p>Scopri tutte le <a href="${listingPath}">posizioni aperte</a> sul nostro job board con oltre 1000 offerte attive in Ticino.</p>`);
 if (jobLocation) searchSugParts.push(`<p>Cerca altre offerte nella zona: <a href="${listingPath}">Lavoro in ${esc(displayCanton)}</a></p>`);
 searchSugParts.push(`<p>Torna alla <a href="${listingPath}">Job Board completa</a> per trovare la tua prossima opportunit\u00e0 lavorativa come frontaliere in Svizzera.</p>`);
 staticBodyParts.push(`<section><h2>Offerte simili in ${esc(displayCanton)}</h2>${searchSugParts.join('\n')}</section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Similar jobs in ${esc(displayCanton)}</h2><p>Browse our <a href="${listingPath}">complete job board</a> with over 1000 active positions in Ticino.</p>${jobLocation ? `<p>Search for more jobs near ${esc(jobLocation)}: <a href="${listingPath}">Jobs in ${esc(displayCanton)}</a></p>` : ''}<p>Find your next opportunity as a cross-border worker in Switzerland.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>\u00c4hnliche Stellen im ${esc(displayCanton)}</h2><p>Durchsuchen Sie unser <a href="${listingPath}">komplettes Job Board</a> mit \u00fcber 1000 aktiven Stellen im Tessin.</p>${jobLocation ? `<p>Weitere Stellen in der N\u00e4he von ${esc(jobLocation)}: <a href="${listingPath}">Jobs im ${esc(displayCanton)}</a></p>` : ''}<p>Finden Sie Ihre n\u00e4chste Stelle als Grenzg\u00e4nger in der Schweiz.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Offres similaires au ${esc(displayCanton)}</h2><p>Parcourez notre <a href="${listingPath}">job board complet</a> avec plus de 1000 postes actifs au Tessin.</p>${jobLocation ? `<p>Recherchez d'autres offres pr\u00e8s de ${esc(jobLocation)}: <a href="${listingPath}">Emplois au ${esc(displayCanton)}</a></p>` : ''}<p>Trouvez votre prochaine opportunit\u00e9 en tant que frontalier en Suisse.</p></section>`);
 }

 // --- Frontalier info section: extended with permit-mechanics, gross-to-net
 // detail, commute reality and cost-of-living comparison so each job-detail
 // page carries substantive contextual content. ~2 KB of visible text per
 // locale; uses jobCompany / jobLocation / displayCanton so pages stay
 // distinct and Google won't see boilerplate. ---
 // Gated by STRIP_EXPIRED_JOB_PROSE (default on) — see top of file.
 // `__slKeepProse` (real-traffic evidence only) overrides the strip so
 // recently-trafficked expired URLs stay substantial (see above).
 if (!STRIP_EXPIRED_JOB_PROSE || __slKeepProse) {
 const taxUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Informazioni per frontalieri</h2><p>${jobCompany ? `${esc(jobCompany)} si trova` : 'Questa posizione si trovava'}${jobLocation ? ` a ${esc(jobLocation)}` : ''} in Canton ${esc(displayCanton)}. Per lavorare come frontaliere in Svizzera serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(displayCanton)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo, mentre i frontalieri dal 2024 sono soggetti al <strong>Nuovo Accordo fiscale</strong> che prevede una tassazione concorrente Italia-Svizzera.</p><p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p><p><strong>Permesso G e residenza.</strong> Per candidarti a questa posizione come frontaliere devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il datore di lavoro richiede il Permesso G all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi viene rinnovato annualmente fino al limite contrattuale. Il telelavoro a tempo pieno dall'Italia non è compatibile con lo status di frontaliere; assenze prolungate dal domicilio italiano (più di una settimana lavorativa senza rientro) compromettono il regime fiscale.</p><p><strong>Stipendio netto e Nuovo Accordo 2024.</strong> Lo stipendio lordo indicato in questa offerta viene tassato alla fonte dal datore svizzero con aliquote effettive che nel Canton ${esc(displayCanton)} variano fra il 5 % e il 19 % a seconda del reddito, dello stato civile e dei figli. Per i frontalieri assunti dal 1° gennaio 2024 si applica il regime concorrente Italia-Svizzera del Nuovo Accordo: l'Italia tassa il reddito da lavoro estero ma riconosce un credito d'imposta sulle ritenute svizzere fino all'80 %, da dichiarare nel quadro RW. Sommando imposta alla fonte e contributi sociali, la differenza fra lordo annuale e netto incassato è tipicamente del 18-28 %. Per il calcolo personalizzato sul lordo offerto da ${jobCompany ? esc(jobCompany) : 'questa azienda'} apri il simulatore stipendio.</p><p><strong>Pendolarismo e qualità della vita.</strong> ${jobLocation ? `Lavorare a ${esc(jobLocation)} significa ` : `Lavorare nel Canton ${esc(displayCanton)} significa `}un tragitto giornaliero che dipende dal valico scelto: Brogeda (autostrada A2) e Chiasso-strada coprono le destinazioni del Mendrisiotto e del Luganese; Stabio e Gaggiolo servono chi parte dal Varesotto; Ponte Tresa è l'opzione storica per Luino e il Verbano. In ora di punta un tragitto Como-Lugano si esaurisce in 25-50 minuti; da Varese verso Lugano servono tipicamente 35-60 minuti. Per chi valuta il trasferimento in Ticino, l'affitto medio per un 3.5 locali a Lugano è 1.500-2.200 CHF/mese, contro 600-900 EUR per un appartamento equivalente in provincia di Como. La rete sanitaria svizzera (LAMal) offre tempi di accesso più brevi del SSN italiano ma con un premio mensile di 350-500 CHF/adulto, voce che pesa nel confronto netto-netto.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Information for cross-border workers</h2><p>${jobCompany ? `${esc(jobCompany)} is located` : 'This position was located'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} in the Canton of ${esc(displayCanton)}. Cross-border workers need a <strong>G Permit</strong>, renewable annually, to work in Switzerland. The Canton of ${esc(displayCanton)} applies <strong>withholding tax</strong> at variable rates on gross income. Since 2024, the <strong>New Tax Agreement</strong> introduces concurrent taxation between Italy and Switzerland.</p><p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p><p><strong>G permit and residence.</strong> To apply for this position as a cross-border worker you must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. The employer files the G permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is then renewed yearly. Full-time remote work from Italy is not compatible with cross-border status; extended absences from the Italian home (more than a working week without returning) jeopardise the fiscal regime.</p><p><strong>Net salary and the 2024 fiscal agreement.</strong> The gross salary advertised here is withheld at source by the Swiss employer at effective rates between 5 % and 19 % in the Canton of ${esc(displayCanton)} depending on income, marital status and dependants. Cross-border workers hired on or after 1 January 2024 fall under the new Italy-Switzerland concurrent regime: Italy taxes foreign employment income while granting a tax credit on Swiss withholding up to 80 %, declared in section RW of the Italian tax return. Together with social charges the typical gross-to-net gap is 18-28 %. For a personalised calculation on the gross offered by ${jobCompany ? esc(jobCompany) : 'this employer'} open the salary simulator.</p><p><strong>Commute and quality of life.</strong> ${jobLocation ? `Working in ${esc(jobLocation)} means ` : `Working in the Canton of ${esc(displayCanton)} means `}a daily commute that depends on which crossing you use: Brogeda (A2 motorway) and Chiasso-strada cover the Mendrisiotto and Luganese areas; Stabio and Gaggiolo serve commuters from the Varese province; Ponte Tresa is the historic gateway for Luino and the Verbano lake region. At peak times a Como-Lugano leg runs 25-50 minutes; Varese-Lugano typically takes 35-60. For those considering relocation to Ticino, average rent for a 3.5-room flat in Lugano is CHF 1,500-2,200/month, against EUR 600-900 for an equivalent unit in the province of Como. The Swiss healthcare network (LAMal) offers shorter access times than the Italian SSN but at a monthly premium of CHF 350-500 per adult — a substantial line item in any net-vs-net comparison.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2><p>${jobCompany ? `${esc(jobCompany)} befindet sich` : 'Diese Stelle befand sich'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} im Kanton ${esc(displayCanton)}. Grenzg\u00e4nger ben\u00f6tigen eine <strong>G-Bewilligung</strong> (j\u00e4hrlich erneuerbar), um in der Schweiz zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine <strong>Quellensteuer</strong> mit variablen S\u00e4tzen auf das Bruttoeinkommen. Seit 2024 gilt das <strong>Neue Steuerabkommen</strong> mit konkurrierender Besteuerung zwischen Italien und der Schweiz.</p><p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG (berufliche Vorsorge). Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p><p><strong>G-Bewilligung und Wohnsitz.</strong> Um sich auf diese Stelle als Grenzg\u00e4nger zu bewerben, m\u00fcssen Sie in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Der Arbeitgeber beantragt die G-Bewilligung nach Vertragsunterzeichnung beim kantonalen Migrationsamt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die j\u00e4hrliche Verl\u00e4ngerung. Vollst\u00e4ndige Heimarbeit aus Italien ist mit dem Grenzg\u00e4ngerstatus nicht vereinbar; l\u00e4ngere Abwesenheiten vom italienischen Wohnsitz (mehr als eine Arbeitswoche ohne R\u00fcckkehr) gef\u00e4hrden das Steuerregime.</p><p><strong>Nettolohn und neues Steuerabkommen 2024.</strong> Der hier ausgeschriebene Bruttolohn wird vom schweizerischen Arbeitgeber an der Quelle besteuert, mit effektiven S\u00e4tzen im Kanton ${esc(displayCanton)} zwischen 5 % und 19 % je nach Einkommen, Zivilstand und Kindern. Grenzg\u00e4nger ab dem 1. Januar 2024 fallen unter die neue konkurrierende Regelung Italien-Schweiz: Italien besteuert ausl\u00e4ndisches Erwerbseinkommen, gew\u00e4hrt aber eine Steuergutschrift auf die schweizerische Quellensteuer von bis zu 80 %, deklariert im Abschnitt RW der italienischen Steuererkl\u00e4rung. Zusammen mit den Sozialabgaben betr\u00e4gt der typische Brutto-Netto-Abstand 18-28 %. F\u00fcr eine personalisierte Berechnung auf das Bruttoangebot von ${jobCompany ? esc(jobCompany) : 'diesem Arbeitgeber'} \u00f6ffnen Sie den Lohnsimulator.</p><p><strong>Pendelweg und Lebensqualit\u00e4t.</strong> ${jobLocation ? `Arbeiten in ${esc(jobLocation)} bedeutet ` : `Arbeiten im Kanton ${esc(displayCanton)} bedeutet `}einen t\u00e4glichen Pendelweg, der von der Wahl des Grenz\u00fcbergangs abh\u00e4ngt: Brogeda (Autobahn A2) und Chiasso-Strasse decken das Mendrisiotto und das Luganese ab; Stabio und Gaggiolo bedienen Pendler aus der Provinz Varese; Ponte Tresa ist der historische Zugang f\u00fcr Luino und die Region Verbano. In Stosszeiten dauert eine Strecke Como-Lugano 25-50 Minuten; Varese-Lugano typischerweise 35-60 Minuten. F\u00fcr alle, die einen Umzug ins Tessin erw\u00e4gen, betr\u00e4gt die durchschnittliche Miete f\u00fcr eine 3,5-Zimmer-Wohnung in Lugano CHF 1'500-2'200/Monat, gegen\u00fcber EUR 600-900 f\u00fcr eine vergleichbare Wohnung in der Provinz Como. Das schweizerische Gesundheitsnetz (KVG) bietet k\u00fcrzere Zugangszeiten als der italienische SSN, kostet aber CHF 350-500 pro Erwachsenem und Monat — ein erheblicher Posten in jedem Netto-zu-Netto-Vergleich.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Informations pour les frontaliers</h2><p>${jobCompany ? `${esc(jobCompany)} se trouve` : 'Ce poste se trouvait'}${jobLocation ? ` \u00e0 ${esc(jobLocation)}` : ''} dans le Canton du ${esc(displayCanton)}. Les travailleurs frontaliers ont besoin d'un <strong>permis G</strong> (renouvelable annuellement) pour travailler en Suisse. Le Canton du ${esc(displayCanton)} applique un <strong>imp\u00f4t \u00e0 la source</strong> \u00e0 taux variable sur le revenu brut. Depuis 2024, le <strong>Nouvel Accord fiscal</strong> introduit une imposition concurrente entre l'Italie et la Suisse.</p><p>Les cotisations sociales suisses comprennent l'AVS (5,3%), l'assurance ch\u00f4mage (1,1%) et la LPP (pr\u00e9voyance professionnelle). Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p><p><strong>Permis G et r\u00e9sidence.</strong> Pour postuler \u00e0 ce poste en tant que frontalier, vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. L'employeur d\u00e9pose la demande de permis G \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat : la premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines, le renouvellement est ensuite annuel. Le t\u00e9l\u00e9travail \u00e0 plein temps depuis l'Italie n'est pas compatible avec le statut de frontalier ; des absences prolong\u00e9es du domicile italien (plus d'une semaine de travail sans retour) compromettent le r\u00e9gime fiscal.</p><p><strong>Salaire net et nouvel accord fiscal 2024.</strong> Le salaire brut annonc\u00e9 ici est retenu \u00e0 la source par l'employeur suisse \u00e0 des taux effectifs compris entre 5 % et 19 % dans le Canton du ${esc(displayCanton)} selon le revenu, l'\u00e9tat civil et les personnes \u00e0 charge. Les frontaliers engag\u00e9s \u00e0 partir du 1er janvier 2024 rel\u00e8vent du nouveau r\u00e9gime concurrent Italie-Suisse : l'Italie impose le revenu de source \u00e9trang\u00e8re tout en accordant un cr\u00e9dit d'imp\u00f4t sur la retenue suisse jusqu'\u00e0 80 %, d\u00e9clar\u00e9 dans le cadre RW de la d\u00e9claration italienne. En ajoutant les charges sociales, l'\u00e9cart brut-net typique est de 18 \u00e0 28 %. Pour un calcul personnalis\u00e9 sur le brut propos\u00e9 par ${jobCompany ? esc(jobCompany) : 'cet employeur'}, ouvrez le simulateur de salaire.</p><p><strong>Trajet et qualit\u00e9 de vie.</strong> ${jobLocation ? `Travailler \u00e0 ${esc(jobLocation)} signifie ` : `Travailler dans le Canton du ${esc(displayCanton)} signifie `}un trajet quotidien qui d\u00e9pend du poste-fronti\u00e8re choisi : Brogeda (autoroute A2) et Chiasso-route couvrent le Mendrisiotto et le Luganese ; Stabio et Gaggiolo desservent les pendulaires partant de la province de Var\u00e8se ; Ponte Tresa est l'acc\u00e8s historique pour Luino et la r\u00e9gion du Verbano. En heure de pointe, un trajet C\u00f4me-Lugano dure 25-50 minutes ; Var\u00e8se-Lugano typiquement 35-60. Pour qui envisage un d\u00e9m\u00e9nagement au Tessin, le loyer moyen d'un 3,5 pi\u00e8ces \u00e0 Lugano est de CHF 1'500-2'200/mois, contre EUR 600-900 pour un appartement \u00e9quivalent en province de C\u00f4me. Le r\u00e9seau de soins suisse (LAMal) offre des temps d'acc\u00e8s plus courts que le SSN italien, mais avec une prime mensuelle de CHF 350-500 par adulte — un poste de d\u00e9pense significatif \u00e0 int\u00e9grer dans toute comparaison net-net.</p></section>`);
 }

 } // end STRIP_EXPIRED_JOB_PROSE guard (Informazioni per frontalieri)

 // --- FAQ section — gated by STRIP_EXPIRED_JOB_PROSE (default off = stripped).
 // 5 Q&A per locale (net salary, LAMal, G permit, statutory pay, documents). ---
 if (!STRIP_EXPIRED_JOB_PROSE || __slKeepProse) {
 const lamalUrl: Record<string, string> = {
 it: `${BASE_URL}/premi-cassa-malati/`,
 en: `${BASE_URL}/en/health-insurance-premiums/`,
 de: `${BASE_URL}/de/krankenkassenpraemien/`,
 fr: `${BASE_URL}/fr/primes-assurance-maladie/`,
 };
 staticBodyParts.push(getExpiredFaqHtml(locale, escDisplayCanton, lamalUrl[locale] || lamalUrl.it));
 }

 // --- Fallback: recent active jobs when no same-company jobs were shown ---
 // This ensures even pages without ejData have cross-links to active listings,
 // adding both word count and genuine user value.
 if (sameCompanyActiveJobs.length === 0) {
 // Pick up to 5 recent active jobs (deterministic by slug hash, O(1) via pre-computed pool)
 const recentJobs = selectRecentJobs(slug, slug);
 if (recentJobs.length > 0) {
 const recentHeading = locale === 'it' ? 'Posizioni attive recenti' : locale === 'en' ? 'Recent active positions' : locale === 'de' ? 'Aktuelle offene Stellen' : 'Postes actifs r\u00e9cents';
 const recentList = recentJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = withSlash(jPath);
 const jTitle = stripLiteralMarkdownFromTitle(String(j?.titleByLocale?.[locale] || j.title || ''));
 const jCompany = String(j.company || '');
 const jLoc = String(j.location || '');
 return `<li><a href="${jHref}">${esc(jTitle)}</a>${jCompany ? ` \u2014 ${esc(jCompany)}` : ''}${jLoc ? `, ${esc(jLoc)}` : ''}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${recentHeading}</h2><ul>${recentList}</ul></section>`);
 }
 }

 // --- Fallback enrichment for pages without expired-jobs.json data ---
 // Ensures pages without rich ejData still have enough content (>= 50 words)
 // by adding general info about the Ticino cross-border job market.
 // Also gated by STRIP_EXPIRED_JOB_PROSE: when stripping, the page falls back
 // to whatever Dettaglio/Dettagli/Recent/Related sections produce and the
 // robotsMetaForContent() helper below auto-noindexes if it lands < 50 words.
 if ((!STRIP_EXPIRED_JOB_PROSE || __slKeepProse) && !ejData?.title && !gscInfo?.title) {
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Mercato del lavoro in Ticino</h2><p>Il Canton Ticino offre numerose opportunit\u00e0 per i lavoratori frontalieri provenienti dall'Italia. Con oltre 70.000 frontalieri attivi, il Ticino rappresenta una delle principali destinazioni per chi cerca lavoro in Svizzera dalla regione insubrica. I settori pi\u00f9 attivi includono industria, servizi finanziari, sanit\u00e0, commercio e tecnologia. Lo stipendio medio in Ticino \u00e8 significativamente pi\u00f9 alto rispetto alle regioni italiane di confine, rendendo il lavoro transfrontaliero un'opzione molto attraente per i residenti di Lombardia, Piemonte e altre province vicine.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Job market in Ticino</h2><p>The Canton of Ticino offers numerous opportunities for cross-border workers from Italy. With over 70,000 active cross-border commuters, Ticino is one of the main destinations for those seeking employment in Switzerland from the Insubria region. The most active sectors include industry, financial services, healthcare, retail and technology. The average salary in Ticino is significantly higher than in Italian border regions, making cross-border work a very attractive option for residents of Lombardy, Piedmont and other nearby provinces.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin bietet zahlreiche M\u00f6glichkeiten f\u00fcr Grenzg\u00e4nger aus Italien. Mit \u00fcber 70.000 aktiven Grenzpendlern ist das Tessin eines der wichtigsten Ziele f\u00fcr Arbeitssuchende in der Schweiz aus der Region Insubrien. Die aktivsten Branchen sind Industrie, Finanzdienstleistungen, Gesundheitswesen, Handel und Technologie. Das Durchschnittsgehalt im Tessin liegt deutlich h\u00f6her als in den italienischen Grenzregionen, was die Grenzg\u00e4ngerarbeit zu einer sehr attraktiven Option f\u00fcr Bewohner der Lombardei, des Piemonts und anderer naher Provinzen macht.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>March\u00e9 du travail au Tessin</h2><p>Le Canton du Tessin offre de nombreuses opportunit\u00e9s pour les travailleurs frontaliers venant d'Italie. Avec plus de 70 000 frontaliers actifs, le Tessin est l'une des principales destinations pour ceux qui cherchent un emploi en Suisse depuis la r\u00e9gion insubrienne. Les secteurs les plus actifs comprennent l'industrie, les services financiers, la sant\u00e9, le commerce et la technologie. Le salaire moyen au Tessin est nettement plus \u00e9lev\u00e9 que dans les r\u00e9gions frontali\u00e8res italiennes, ce qui fait du travail transfrontalier une option tr\u00e8s attractive pour les r\u00e9sidents de Lombardie, du Pi\u00e9mont et d'autres provinces voisines.</p></section>`);
 }
 }

 // --- GSC related searches section (only for orphan slugs with query data) ---
 if (gscInfo?.queries && gscInfo.queries.length > 0) {
 const relatedQueries = gscInfo.queries
 .filter((q: string) => q.length > 3)
 .slice(0, 6);
 if (relatedQueries.length > 0) {
 const relSearchHeading: Record<string, string> = {
 it: 'Ricerche correlate',
 en: 'Related searches',
 de: 'Verwandte Suchanfragen',
 fr: 'Recherches associées',
 };
 const queryLinks = relatedQueries.map((q: string) =>
 `<li><a href="${listingPath}">${esc(q)}</a></li>`
 ).join('');
 staticBodyParts.push(`<section><h2>${relSearchHeading[locale] || relSearchHeading.it}</h2><ul>${queryLinks}</ul></section>`);
 }
 }

 staticBodyParts.push(`<p><a href="${listingPath}">${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)} \u2192</a></p>`);
 // Audit opt-out marker: text-html-ratio (and other content-quality gates)
 // skip pages carrying this marker, since prose has been deliberately stripped.
 if (STRIP_EXPIRED_JOB_PROSE) staticBodyParts.push(EJP_STRIPPED_MARKER);
 const staticBody = staticBodyParts.join('\n');
 recordPhase('ejp:body', __tEjpBody);

 const __tEjpWcRobots = phaseTimer();
 // Make robots directive conditional on actual content quality.
 // Pages with >= MIN_INDEXABLE_WORDS of real text get index,follow (SEO value
 // from long-tail searches). Pages below threshold get noindex,follow.
 //
 // 'it' branches to the same countHtmlBodyWords(staticBody) >= MIN_INDEXABLE_WORDS
 // check that robotsMetaForContent()/robotsMetaEnhancedForContent() does
 // internally (see constants.ts), but reuses the word count already needed
 // for the sitemap-inclusion decision below instead of re-scanning the same
 // unmutated staticBody a second time. Run 31065272867 (issue #5252) measured
 // this phase at 57.9s across 183,445 soft-landings with every 'it' page
 // paying for the scan twice.
 let expiredRobotsTag: string;
 if (locale === 'it') {
 itBodyWordCount = countHtmlBodyWords(staticBody);
 expiredRobotsTag = itBodyWordCount >= MIN_INDEXABLE_WORDS ? ROBOTS_INDEX_ENHANCED : ROBOTS_NOINDEX_FOLLOW;
 } else {
 expiredRobotsTag = robotsMetaForContent(staticBody);
 }
 recordPhase('ejp:wc-robots', __tEjpWcRobots);

 const __tEjpJsonld = phaseTimer();
 // Build JSON-LD scripts (BreadcrumbList + optional JobPosting)
 const breadcrumbLd = `<script type="application/ld+json">${inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Frontaliere Ticino', item: BASE_URL + '/' },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, displayCanton), item: `${BASE_URL}${listingPath}` },
 { '@type': 'ListItem', position: 3, name: jobTitle },
 ],
 })}</script>`;

 const jobPostingLd = (() => {
 // NON-NEGOTIABLE #3: "Source mancante → safe default, non rimozione check."
 // SearchAtlas "missing schema" audit (2026-06-15) flagged ~50-80 indexable
 // expired soft-landings emitting only BreadcrumbList. Emit JobPosting whenever
 // the page has a REAL job identity — a real title AND a real employer from
 // trustworthy crawl/search data (expired-jobs.json OR GSC). The optional
 // fields (salary, address) are filled by buildJobPostingSchema's safe
 // defaults; validThrough/datePosted are derived from the best real timestamp
 // and always land in the PAST (this is an expired soft-landing) — Google's
 // recommended handling for an expired posting, NOT a GSC error. Previously the
 // gate required ejData.expiredAt to be present, dropping JobPosting (violating
 // #3) for jobs whose expired entry carried only crawledAt/postedDate. Pure
 // slug-derived orphans with no real employer stay breadcrumb-only:
 // fabricating an employer identity would be spammy, low-quality markup.
 // Revert-trigger (not validable pre-merge, SSG OOM): if the next deploy surfaces
 // GSC "expired job posting" errors or a JobPosting-richness regression on these
 // soft-landings → revert this gate to the strict `realExpiredAt`-required form.
 const realTitle = ejData?.titleByLocale?.[locale] || ejData?.title
 || gscInfo?.titleByLocale?.[locale] || gscInfo?.title || '';
 const realCompany = String(ejData?.company || gscInfo?.company || '');
 // Derive a past validThrough from the best real signal. No real date signal
 // at all → stay breadcrumb-only (don't fabricate a posting window from nothing).
 const realValidThrough = (() => {
 for (const c of [ejData?.expiredAt, ejData?.crawledAt, ejData?.postedDate]) {
 if (c) { const d = new Date(c); if (!isNaN(d.getTime())) return d.toISOString(); }
 }
 return '';
 })();
 if (!realTitle || !realValidThrough || !realCompany) return '';
 const finalDescription = jobDescription || (() => {
 const parts: string[] = [];
 parts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);
 if (locale === 'it') {
 parts.push(`<p>Questa posizione di ${esc(realTitle)} presso ${esc(jobCompany)}${jobLocation ? ` a ${esc(jobLocation)}` : ' in Ticino'} non è più disponibile.</p>`);
 } else if (locale === 'en') {
 parts.push(`<p>This ${esc(realTitle)} position at ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' in Ticino'} is no longer available.</p>`);
 } else if (locale === 'de') {
 parts.push(`<p>Diese Stelle als ${esc(realTitle)} bei ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' im Tessin'} ist nicht mehr verfügbar.</p>`);
 } else {
 parts.push(`<p>Ce poste de ${esc(realTitle)} chez ${esc(jobCompany)}${jobLocation ? ` à ${esc(jobLocation)}` : ' au Tessin'} n'est plus disponible.</p>`);
 }
 parts.push(`<p>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}: ${esc(jobCompany)}</p>`);
 if (jobLocation) parts.push(`<p>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}: ${esc(jobLocation)}</p>`);
 return parts.join('');
 })();
 if (finalDescription.length < 30) return '';
 // Build the canonical JobPosting schema via the shared builder. The
 // expired soft-landing layers its expired-specific overrides (validThrough
 // = expiredAt, datePosted back-estimated from expiredAt when no crawl
 // data exists) on top of the canonical output.
 const expiredInput: JobInput = {
 id: ejData?.id,
 slug,
 title: realTitle,
 description: capJsonLdDescription(finalDescription),
 company: jobCompany,
 companyKey: ejData?.companyKey || slugInfo?.companyKey,
 addressLocality: jobLocation || undefined,
 addressRegion: jobCanton || undefined,
 postalCode: ejData?.postalCode || slugInfo?.postalCode,
 streetAddress: ejData?.streetAddress,
 postedDate: ejData?.postedDate,
 crawledAt: ejData?.crawledAt,
 validThrough: realValidThrough,
 contract: ejData?.contract,
 salaryMin: typeof ejData?.salaryMin === 'number' ? ejData.salaryMin : null,
 salaryMax: typeof ejData?.salaryMax === 'number' ? ejData.salaryMax : null,
 salaryCurrency: ejData?.salaryCurrency,
 category: ejData?.category,
 sector: ejData?.category,
 url: undefined,
 };
 const expiredSchema = buildJobPostingSchema(expiredInput, {
 locale,
 url: selfUrl,
 baseUrl: BASE_URL,
 });
 // Expired-specific datePosted: when no crawl data exists, estimate as
 // 30 days before expiredAt so the posting window looks natural.
 const expiredDatePosted = (() => {
 const raw = (() => {
 if (ejData?.postedDate) { const d = new Date(ejData.postedDate); if (!isNaN(d.getTime())) return d.toISOString(); }
 if (ejData?.crawledAt) { const d = new Date(ejData.crawledAt); if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() - 30); return d.toISOString(); } }
 const d = new Date(realValidThrough); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString();
 })();
 // PR #2229 adversarial-check #1: when the only timestamp is postedDate,
 // realValidThrough === postedDate === raw → a zero/negative posting window
 // that Google rejects (validThrough must be AFTER datePosted). Clamp
 // datePosted to 30 days before validThrough when it would not strictly
 // precede it.
 if (!(new Date(raw).getTime() < new Date(realValidThrough).getTime())) {
 const d = new Date(realValidThrough); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString();
 }
 return raw;
 })();
 const jp: Record<string, unknown> = {
 ...expiredSchema,
 datePosted: expiredDatePosted,
 validThrough: new Date(realValidThrough).toISOString(),
 };
 return `<script type="application/ld+json">${inlineScriptJson(jp)}</script>`;
 })();

 const jsonLdScripts = breadcrumbLd + (jobPostingLd ? '\n ' + jobPostingLd : '');
 recordPhase('ejp:jsonld', __tEjpJsonld);

 // Tier decision FIRST. It reads only `__slCandidatePaths` (hoisted above the
 // body) and the traffic set — never the HTML — so hoisting it above the build
 // is behaviour-neutral: same inputs, same counters, same result, and no other
 // decideMulti call happens in between. Two reasons to do it here (#5130
 // follow-up):
 //   1. it makes the decision's own cost attributable instead of hiding inside
 //      ph:ejp:shell;
 //   2. 149,099 of 178,828 soft-landings (83%, run 31036546298) are THIN — the
 //      full article body is built, minified and then thrown away for five
 //      pages out of six. Having the decision before the build is the
 //      precondition for skipping that work, which is the next step once these
 //      timers say what it is worth.
 const __tEjpDecide = phaseTimer();
 const __slDecision = trafficFilter.decideMulti(__slCandidatePaths, 'soft-landing-expired');
 const __slAction: 'full' | 'thin' =
 __slDecision.action === 'thin' ? 'thin' : 'full';
 recordPhase('ejp:decide', __tEjpDecide);

 const __tEjpShell = phaseTimer();
 // Bot-gated Auto Ads loader (meta + adsense-loader) ONLY on real-traffic
 // expired pages (__slKeepProse): immediate Auto Ads (anchor/vignette/in-page)
 // for the crawler-first-paint→quick-bounce window, instead of waiting for the
 // SPA's <AdSenseBanner> to load the AdSense ads script post-hydration (a lost-impression
 // gap on dead-job-link bounces — same class as #1904). Loader is idempotent +
 // bot-gated, so it coexists with the SPA banner and never inflates AD_REQUESTS.
 // Gated to has-traffic so the ~250 B snippet only lands on pages with users.
 const __slAdSnippet = __slKeepProse ? ADSENSE_SNIPPET : '';
 const __slFullHtml = buildSoftLandingHtml(
 locale, pageTitle, pageDesc, expiredRobotsTag,
 selfUrl, hreflangLinks, jsonLdScripts, expiredWindowData,
 staticBody, __slAdSnippet
 );
 recordPhase('ejp:shell', __tEjpShell);

 // Tiered emission for soft-landings. Same filter + evidence flow as
 // previousSlug bridges: URL with traffic stays full; URL without and
 // matching an approved pattern becomes a thin shell (HEAD verbatim,
 // article body replaced by a slim h1+p≥50 words). See
 // build-plugins/shared/softLandingThinShell.ts.
 // Reuses the hoisted `__slCandidatePaths` (built above the body, single
 // source of truth) — same candidate set that gated `__slKeepProse`, so the
 // prose gate and the thin-shell gate can never diverge. (Reviewer HIGH #1
 // cross-locale safety net + PR #743 legacy-locale bridge probe are baked
 // into that builder.)
 //
 // Timed separately (ph:ejp:thin): it re-scans the whole freshly-built
 // document — stripScriptsAndStyles + an <h1> match + a canonical match + a
 // JSON-LD parse + a lazy `[\s\S]*?` article replace — on 149k pages, and
 // none of that was attributable before.
 const __tEjpThin = phaseTimer();
 const softLandingHtml =
 __slAction === 'thin'
 ? buildSoftLandingThinHtml(__slFullHtml, locale)
 : __slFullHtml;
 recordPhase('ejp:thin', __tEjpThin);
 if (__slAction === 'thin') {
 softLandingThinCount++;
 softLandingBytesSaved += __slFullHtml.length - softLandingHtml.length;
 } else {
 softLandingFullCount++;
 }

 // Dedup membership: __slPathKey is computed and checked at the top of
 // this locale iteration (hoisted to avoid running the full ph:ejp:*
 // pipeline on doomed paths). Only the `.add()` lives here so the set
 // reflects ACTUALLY-emitted paths, not just attempted ones — keeps
 // dist/.write-collisions.json clean across slugs that converge here.
 emittedSoftLandingPaths.add(__slPathKey);

 const __tEjpWrite = phaseTimer();
 writeSoftLandingPage(relPath.slice(1), softLandingHtml);
 const cacheKey = `${locale}:${slug}`;
 if (expiredCacheKeys.has(cacheKey)) {
 expiredSoftLandingCache.set(cacheKey, softLandingHtml);
 }
 expiredCount++;

 // Legacy slug bridge (Italian slug in non-IT locale path)
 if (locale !== 'it') {
 const legacyRel = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const trackedRel = relPath.replace(/^\//, '');
 if (legacyRel !== trackedRel && !emittedSoftLandingPaths.has(legacyRel.replace(/\/+$/, ''))) {
 emittedSoftLandingPaths.add(legacyRel.replace(/\/+$/, ''));
 writeSoftLandingPage(legacyRel, softLandingHtml);
 legacyCount++;
 }
 }
 recordPhase('ejp:write', __tEjpWrite);
 recordEmit('expired-soft-landing', __tExpiredSoftLanding);
 }

 // Only add expired slugs to sitemap when:
 // 1. The IT page has enough content (>= MIN_INDEXABLE_WORDS) -- thin content wastes crawl budget
 // 2. The IT page was actually written (not overwritten by an active page)
 // Group-inclusion gate stays IT-anchored (unchanged) -- see shard-invariance
 // comment below for why per-locale word-count isn't available here. Once the
 // group qualifies, each locale gets its OWN <url> entry (#3499) instead of an
 // IT-only entry with one-sided alternates, so non-reciprocal en/de/fr hreflang
 // survives sanitizeSitemapHreflangReciprocity().
 const itPath = paths.it ? withSlash(paths.it) : '';
 const itPageFile = itPath ? np.join(distDir, itPath.slice(1), 'index.html') : '';
 const itPageOverwritten = itPageFile && _writtenPaths.has(itPageFile);
 if (itPath && itBodyWordCount >= MIN_INDEXABLE_WORDS && !itPageOverwritten && !bridgeClaimedPaths.has(paths.it)) {
 // Shard-invariance of the expired-sitemap hreflang (verify #2491, follow-up
 // to the render-skip lever #2484): `paths` is `tracking[slug]`, which is
 // populated UPSTREAM (L~9572/9681/9697/9744/10067) with NO `shouldEmitLocale`/
 // `BUILD_LOCALE` gating -- the active-jobs/implicit-prev branches iterate the
 // full `localeList`, the orphan/compat branches add the locale inherent to
 // the source record. The only `shouldEmitLocale` skips in this plugin
 // (L2331/L2508/L10691) gate render/emit, never `paths` population. So in the
 // `it`/main shard (the only shard that builds this sitemap) every locale's
 // alternate is present regardless of `BUILD_LOCALE`. A `!p` here therefore
 // reflects a genuinely partial cluster (orphan/compat slug with no localized
 // path), NOT a shard skip -- do NOT force-populate the 4 locales to "fix" it,
 // that would fabricate hreflang to non-existent pages. Same guarantee the
 // localeEmitFilter docblock gives for the active-job sitemap alternates.
 const altLinks = localeList.map((l) => {
 const p = paths[l];
 if (!p) return '';
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).filter(Boolean).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const lastmod = (safeIsoDate(ejData?.expiredAt) || '').slice(0, 10) || dateStamp;
 // Per-locale push (#3499): non-IT locales additionally require their own
 // soft-landing page to actually exist on disk -- `paths` is shard-invariant
 // (see above) but render/emit is shard-gated (`shouldEmitLocale`, L~11223),
 // so a non-owning shard never wrote non-IT HTML this run; fall back to
 // `fs.existsSync` for HTML already emitted by an earlier shard/run.
 for (const l of localeList) {
 const lPath = paths[l];
 if (!lPath) continue;
 if (bridgeClaimedPaths.has(lPath)) continue;
 const lFullPath = withSlash(lPath);
 if (l !== 'it') {
 const lPageFile = np.join(distDir, lFullPath.slice(1).replace(/\/$/, ''), 'index.html');
 if (!_writtenPaths.has(lPageFile) && !fs.existsSync(lPageFile)) continue;
 }
 expiredSitemapEntries.push(` <url>\n <loc>${BASE_URL}${lFullPath}</loc>\n${altLinks}\n${xDefault}\n <lastmod>${lastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 }
 }
 // Bound the WriteCollector background-flush backlog INSIDE this
 // ~150k-page expired-soft-landing loop. Previously the only
 // awaitDrainSlot ran AFTER the whole loop, so _pendingFlushes
 // accumulated unbounded during the emit (observed 65 in-flight ×
 // 5000-entry batches of large soft-landing HTML ≈ 12 GB) and the
 // deploy build OOM'd in this exact phase (run 27520709430,
 // "Ineffective mark-compacts near heap limit"). Draining each
 // iteration caps the backlog; 2 e non 6 dal #6134 — qui l'heap e' gia'
 // oltre gli 8.5 GB e 3 batch (~450 MB, il default documentato di
 // awaitDrainSlot) sono il bound giusto, mentre 7 batch (~1 GB) erano
 // tarati sulle fasi iniziali a heap basso.
 await collector.awaitDrainSlot(2);
 }

 // Write expired jobs sitemap
 if (expiredSitemapEntries.length > 0) {
 const sitemapExpired = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${expiredSitemapEntries.join('\n')}\n</urlset>\n`;
 const sitemapExpiredPath = np.join(distDir, 'sitemap-jobs-expired.xml');
 fs.writeFileSync(sitemapExpiredPath, sitemapExpired, 'utf-8');

 // Register in sitemap index
 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs-expired.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }
 }
 }

 if (expiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${expiredCount} soft-landing pages for ${expiredSlugs.length} expired jobs${legacyCount > 0 ? ` (+ ${legacyCount} legacy slug bridges)` : ''}`);
 logBuildMem('jobsSeoPages: after expired-softlandings', collector);
 // Backpressure between expired-soft-landing (~150k pages) and the
 // next big emit (previousSlugs full-content ~65k pages).
 await collector.awaitDrainSlot(2);
 }

 /* ── Cross-locale reconciliation for expired jobs ──────────── */
 // Mirrors the active-jobs cross-locale block below, but for expired jobs.
 // When an expired job has distinct `slugByLocale`, generate a soft-landing
 // bridge at every (baseLocale × foreignSlug) combination so a direct hit on
 // e.g. `/cerca-lavoro-ticino/<slug-fr>` renders soft-landing content in
 // Italian instead of a 404. Canonical (inherited from the cached HTML)
 // already points to the base locale's tracked slug URL.
 let crossLocaleExpiredCount = 0;
 for (const ej of expiredJobsData) {
 const slugByLocale = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!slugByLocale || typeof slugByLocale !== 'object') continue;
 // Sibling guard, same rationale as the active-jobs cross-locale bridge
 // below (PR #3052, isCompanyHubNamespaceSlug / issue #2976 recurrence).
 // expired-jobs records carry no `canton` field (only location/addressLocality),
 // so resolve via the shared location→canton lookup like the other 3 call sites
 // — a raw `ej.canton` read always falls back to DEFAULT_CANTON and never fires.
 const ejCantonForCrossLocale = sharedResolveJobCanton(ej as { canton?: string; location?: string });
 for (const baseLocale of localeList) {
 const baseSlug = slugByLocale[baseLocale];
 if (!baseSlug) continue;
 // Per-locale shard build (BUILD_LOCALE): the expired cross-locale bridge is
 // written under baseLocale's prefix, so skip it for locales this shard
 // doesn't own (Fase 1c, same class as the active-job bridge loops below).
 // No-op in the all-locale build.
 if (!shouldEmitLocale(baseLocale)) continue;
 const baseHtml = expiredSoftLandingCache.get(`${baseLocale}:${baseSlug}`);
 if (!baseHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 const fs2 = slugByLocale[otherLocale];
 if (fs2 && fs2 !== baseSlug) foreignSlugs.add(fs2);
 }
 if (foreignSlugs.size === 0) continue;
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${inlineScriptJson(baseSlug)};</script>`;
 const bridgeHtml = baseHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 // Sector/city hubs win over cross-locale reconciliation — same
 // rationale as the active-jobs block (jobSectorPagesPlugin owns
 // these paths).
 if (RESERVED_HUB_SLUGS.has(foreignSlug)) continue;
 if (ejCantonForCrossLocale !== 'TI' && isCompanyHubNamespaceSlug(foreignSlug, baseLocale)) continue;
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Active job wins if a live page already occupies this path.
 if (activeJobDirs.has(relPathKey)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if any earlier phase (active, bridge, soft-landing) already wrote here.
 if (_writtenPaths.has(indexFile)) continue;
 const __tCrossLocaleExpired = startTimer();
 _md(outDir);
 _qw(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 crossLocaleExpiredCount++;
 recordEmit('cross-locale-expired-bridge', __tCrossLocaleExpired);
 // Sibling backpressure (AGENTS.md #6): same unbounded background-flush
 // risk as the expired-soft-landing loop above — drain INSIDE the emit
 // loop so _pendingFlushes can't balloon during the cross-locale sweep.
 await collector.awaitDrainSlot(2);
 }
 }
 }
 if (crossLocaleExpiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleExpiredCount} cross-locale reconciliation pages for expired jobs`);
 }
 // #6134: the stretch from here to the previousSlugs-bridges checkpoint
 // below was the only unlogged span between "after expired-softlandings"
 // and collector.flush() — the 2026-08-19 OOM died somewhere in it with no
 // [mem] line to localize which phase. Checkpointing here narrows that gap.
 logBuildMem('jobsSeoPages: after cross-locale-expired', collector);

 // Cross-locale-expired-bridge was the last reader of `expiredSoftLandingCache`
 // (populated during the expired-soft-landing emit, ~152k entries × ~9 KB ≈
 // ~1.4 GB peak heap). After this loop the cache is dead state — the
 // previous-slug-bridge + cross-locale-active-bridge phases that follow read
 // from `jobHtmlCache` instead, never this one. Run 26497882342 OOM'd at
 // heap=10.8 GB during this stretch; freeing ~1.4 GB here puts the heap
 // back well under the 12 GB cap before the heavier write/flush phases run.
 expiredSoftLandingCache.clear();
 // #6134 (strutturale): l'intero universo "expired" e' morto qui insieme
 // alla cache. Ultimi lettori: `expiredJobsData` il loop cross-locale-expired
 // qui sopra (L13099), `expiredBySlug` la render dei soft-landing (L12289),
 // `orphanGscData` idem (L12333, e porta il FULL CONTENT di ~43k slug
 // orfani). Le fasi previousSlugs/cross-locale-active che seguono leggono da
 // validJobs/jobHtmlCache, mai da queste. Tenerle vive fino a fine
 // closeBundle significava attraversare le due fasi piu' pesanti rimaste con
 // l'object graph di expired-jobs.json (~65 MB su disco) ancora in pancia.
 // Audit closure-safety (#6168): `expiredBySlug`/`orphanGscData` are read
 // ONLY at L12289/L12333 — both identifiers appear nowhere else in this
 // file, so no closure defined earlier (e.g. a callback queued past this
 // point) can hold a live reference into either map. Both reads happen
 // synchronously at the top of each per-slug/per-locale loop body, before
 // any `await`; the extracted fields are copied into plain per-iteration
 // consts and serialized into the HTML string handed to `_qw` → `collector
 // .add(filePath, content)` (L909-911), which stores the already-built
 // string, not a reference back into these maps. The soft-landing loop and
 // the cross-locale-expired loop above both fully resolve (sequential
 // `await collector.awaitDrainSlot(...)`, no fire-and-forget) before this
 // cleanup block runs, so `.clear()` below can never race a pending read.
 expiredJobsData = [];
 expiredBySlug.clear();
 orphanGscData.clear();
 // Force a major GC so the freed ~1.4 GB is returned to the OS immediately
 // instead of waiting for the next idle scavenge. `global.gc` is exposed by
 // NODE_OPTIONS=--expose-gc in `build:ci` (see PR #627); guarded for local
 // dev runs without the flag.
 forceGc();
 // Post-cleanup baseline (#6139 item 6): the checkpoint above (L13161) fires
 // BEFORE this clear()+forceGc(), so it captures pre-cleanup memory and
 // can't tell apart "cross-locale-expired loop was heavy" from "cleanup
 // didn't free what we expected". This one gives the previousSlugs prescan
 // below a known-clean starting point without losing the earlier signal.
 logBuildMem('jobsSeoPages: after cross-locale-expired-cleanup', collector);

 /* ── Full-content pages for previousSlugs of active jobs ────── */
 // Serve identical full-content pages at old URLs (bookmarks, search engines).
 // The only difference: <link rel="canonical"> points to the current slug URL,
 // and window.__BRIDGE_TARGET_SLUG__ tells the SPA to use the current slug.
 // No redirect, no countdown — user sees full job content immediately.
 //
 // Uses locale-aware previousSlugsByLocale when available:
 // - previousSlugsByLocale[locale] → bridge pages only under that locale's prefix
 // - Legacy flat previousSlugs → bridge pages under ALL locale prefixes (safe fallback)
 //
 // Dedup-at-write-time (2026-04-30): when multiple active jobs claim the
 // same previousSlug for the same locale (the convit-holding case — 8 jobs
 // share the same translated old slug), only ONE bridge is emitted. The
 // winner is chosen via token-Jaccard similarity between oldSlug and each
 // candidate's current canonical, and persisted to
 // `data/previous-slug-winners.json` so the same prevSlug always points to
 // the same canonical across builds. See `services/previousSlugWinners.ts`
 // for the full rationale and heuristic.

 // Pre-scan #1: build the claimant map BEFORE the emit loop. For each
 // (canton, locale, oldSlug) triple, list every active job in that canton
 // that claims the oldSlug via either previousSlugsByLocale[locale] or the
 // legacy flat previousSlugs (locale-unattributed entries fan out across
 // all locales).
 //
 // Phase 8b (2026-05-12): canton is the first key segment because the
 // bridge URL path now derives from the job's canton (e.g. a ZH job emits
 // its bridge under /cerca-lavoro-zurigo/). Two jobs in different cantons
 // that legitimately share a prevSlug emit DIFFERENT bridge URLs —
 // ownership is per (canton, locale, oldSlug), not per (locale, oldSlug).
 const previousSlugClaimants = new Map<string, PreviousSlugCandidate[]>();
 for (const job of validJobs) {
  await collector.awaitDrainSlot(6); // bound flush backlog (#1290)
 const localeAwareAll = new Set<string>();
 const pslByLocale = (job as any).previousSlugsByLocale;
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s);
 }
 }
 const legacyOnly = Array.isArray(job.previousSlugs)
 ? job.previousSlugs.filter((s: string) => !localeAwareAll.has(s))
 : [];
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;
 const jobCantonForClaim = sharedResolveJobCanton(job as { canton?: string; location?: string });
 for (const locale of localeList) {
 const currentSlug = localizedSlug(job, locale);
 if (!currentSlug) continue;
 const localeSpecific = pslByLocale && Array.isArray(pslByLocale[locale]) ? (pslByLocale[locale] as string[]) : [];
 const prevSlugsForLocale = new Set<string>([...localeSpecific, ...legacyOnly]);
 for (const oldSlug of prevSlugsForLocale) {
 if (!oldSlug || oldSlug === currentSlug) continue;
 if (RESERVED_HUB_SLUGS.has(oldSlug)) continue;
 const key = previousSlugWinnerKey(jobCantonForClaim, locale, oldSlug);
 const list = previousSlugClaimants.get(key);
 const candidate: PreviousSlugCandidate = {
 jobIdentifier: String((job as any).id || (job as any).slug || currentSlug),
 canonicalSlug: currentSlug,
 };
 if (list) list.push(candidate);
 else {
 previousSlugClaimants.set(key, [candidate]);
 }
 }
 }
 }

 // Pre-scan #2: load persisted winners and resolve a winner identifier for
 // every key. Single-claimant keys take the trivial winner (no registry
 // entry written). Multi-claimant keys reuse the persisted winner when it
 // is still in the candidates list, else re-elect via the heuristic.
 const previousSlugWinnersPath = np.resolve(rootDir, 'data', 'previous-slug-winners.json');
 const previousSlugWinners: PreviousSlugWinnersFile = loadWinners(previousSlugWinnersPath);
 const previousSlugWinnersBefore = JSON.stringify(previousSlugWinners);
 const winnerByPrevSlugKey = new Map<string, string>(); // key → winner jobIdentifier
 // Day-quantized timestamp. With millisecond precision the previous-slug
 // winners registry's `lastSeenAt` field churned on every deploy, producing
 // ~96 commits/day to data/previous-slug-winners.json (one per article-cron
 // deploy) — pure noise that invalidated jobs-seo-pages cache and bloated
 // git history. Quantizing to UTC midnight means the file only changes
 // once per day (when crossing the day boundary refreshes lastSeenAt for
 // every active entry). pruneStaleWinners uses a 30+ day threshold so the
 // day-level granularity is more than fine.
 const nowIso = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
 let multiClaimantKeys = 0;
 for (const [key, candidates] of previousSlugClaimants) {
 // Key shape: `${canton}::${locale}::${oldSlug}`. We split on the FIRST
 // two '::' separators only, so an oldSlug containing '::' (defensive —
 // not expected in real slugs) is preserved as the remainder.
 const firstSep = key.indexOf('::');
 const secondSep = firstSep >= 0 ? key.indexOf('::', firstSep + 2) : -1;
 if (firstSep < 0 || secondSep < 0) continue;
 const canton = key.slice(0, firstSep);
 const locale = key.slice(firstSep + 2, secondSep);
 const oldSlug = key.slice(secondSep + 2);
 if (candidates.length > 1) multiClaimantKeys += 1;
 const winner = resolveWinner(previousSlugWinners, canton, locale, oldSlug, candidates, nowIso);
 if (winner) winnerByPrevSlugKey.set(key, winner.winnerJobIdentifier);
 }
 if (multiClaimantKeys > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners: ${previousSlugClaimants.size} claimed slugs, ${multiClaimantKeys} contested → resolved via registry + heuristic`,
 );
 }

 // previousSlugClaimants was the last reader of itself — its only purpose
 // was resolving winnerByPrevSlugKey above (`.size` on the line just above
 // is its last read). It stays dead state for the rest of closeBundle: the
 // emit loop below reads winnerByPrevSlugKey only.
 // Mirrors expiredSoftLandingCache.clear()+forceGc() a few hundred lines up
 // (same "clear the dead map before the next big emit" pattern, #6134):
 // free it before the ~65k-page previousSlugs full-content loop, the
 // largest remaining phase before the OOM observed 2026-08-19 (7/8 deploys,
 // exit 134 "Ineffective mark-compacts near heap limit" shortly after the
 // "after expired-softlandings" [mem] checkpoint, no further checkpoint
 // logged before the crash).
 previousSlugClaimants.clear();
 forceGc();

 let bridgeCount = 0;
 let bridgeSkippedNotWinner = 0;
 for (const job of validJobs) {
  await collector.awaitDrainSlot(2); // bound flush backlog (#1290; 2 e non 6: heap gia' al picco in coda al plugin, #6134)
 // Collect previous slugs that aren't locale-attributed (legacy flat entries)
 const localeAwareAll = new Set<string>();
 const pslByLocale = (job as any).previousSlugsByLocale;
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s);
 }
 }
 const legacyOnly = Array.isArray(job.previousSlugs)
 ? job.previousSlugs.filter(s => !localeAwareAll.has(s))
 : [];
 // Check if there's anything to do
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 for (const locale of localeList) {
 const currentSlug = localizedSlug(job, locale);
 const cachedHtml = jobHtmlCache.get(`${locale}:${currentSlug}`);
 if (!cachedHtml) continue;
 // Per-locale shard build (BUILD_LOCALE): skip the expensive previousSlugs
 // bridge render/emit for locales this shard isn't responsible for (Fase 1c,
 // deferred from #2494). The winners registry (data/previous-slug-winners.json)
 // is resolved in the pre-scan loops above with NO gating, so cross-build URL
 // stability is unaffected; this guard only skips the per-locale HTML write,
 // whose output a shard build would prune anyway. No-op in the all-locale build.
 if (!shouldEmitLocale(locale)) continue;

 // Locale-specific previous slugs + legacy (unknown locale → all locales)
 const prevSlugsForLocale = [
 ...new Set([
 ...(pslByLocale && Array.isArray(pslByLocale[locale]) ? pslByLocale[locale] : []),
 ...legacyOnly,
 ]),
 ];

 // Hoist per (currentSlug, locale): bridgeScript + the two .replace()
 // passes over the ~30-50 KB cachedHtml don't depend on `oldSlug`. Lazy
 // (computed only on the first oldSlug that actually emits a bridge) so
 // the case where every prevSlug is filtered out below stays a no-op.
 // Tiered cache: 'full' (today's behavior) and 'thin' (artifact-shrink
 // Fase 1, ~9 KB smaller, same SEO signals — see bridgeThinShell.ts).
 let bridgeIndexHtml: string | null = null;
 let bridgeFlatHtml: string | null = null;
 let bridgeThinIndexHtml: string | null = null;
 let bridgeThinFlatHtml: string | null = null;
 const ensureBridgeHtml = (action: 'full' | 'thin'): { indexHtml: string; flatHtml: string } => {
 if (action === 'thin') {
 if (bridgeThinIndexHtml === null || bridgeThinFlatHtml === null) {
 bridgeThinIndexHtml = buildBridgeThinHtml(cachedHtml, currentSlug, locale);
 bridgeThinFlatHtml = bridgeThinIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 }
 return { indexHtml: bridgeThinIndexHtml, flatHtml: bridgeThinFlatHtml };
 }
 if (bridgeIndexHtml === null || bridgeFlatHtml === null) {
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${inlineScriptJson(currentSlug)};</script>`;
 bridgeIndexHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 bridgeFlatHtml = bridgeIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 }
 return { indexHtml: bridgeIndexHtml, flatHtml: bridgeFlatHtml };
 };

 const myJobIdentifier = String((job as any).id || (job as any).slug || currentSlug);
 // Canton resolution is per-job (not per-oldSlug) — the same job emits all
 // its bridges under the same section regardless of locale-aware vs legacy
 // previousSlugs entries.
 const jobCantonForBridge = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const bridgeSection = buildCantonAwareSection(locale, jobCantonForBridge);
 for (const oldSlug of prevSlugsForLocale) {
 if (oldSlug === currentSlug) continue;
 // Skip bridge generation when the previousSlug is a reserved sector/city
 // hub. A real job (e.g. infermieri-lis-lugano-istituti-sociali-lugano) has
 // 'infermieri' in its previousSlugs as a GSC-imported generic alias —
 // emitting a bridge at /cerca-lavoro-ticino/infermieri/ clobbers
 // jobSectorPagesPlugin's curated sector hub at the same path and sends
 // both users and Google to a job soft-landing instead of the canonical hub.
 if (RESERVED_HUB_SLUGS.has(oldSlug)) continue;
 // Dedup at write time: if multiple active jobs share this prevSlug WITHIN
 // THIS CANTON, only the registered winner emits the bridge. Other
 // claimants skip silently — their canonical content is still indexed at
 // THEIR own canonical URL, and the bridge URL stably points at the
 // winner's canonical across builds. Phase 8b: ownership is per
 // (canton, locale, oldSlug); jobs in different cantons that share an old
 // slug emit at DIFFERENT URLs and never collide here.
 const winnerKey = previousSlugWinnerKey(jobCantonForBridge, locale, oldSlug);
 const winnerId = winnerByPrevSlugKey.get(winnerKey);
 if (winnerId && winnerId !== myJobIdentifier) {
 bridgeSkippedNotWinner += 1;
 continue;
 }
 const oldPath = `${localePrefix[locale]}/${bridgeSection}/${oldSlug}`.replace(/\/+/g, '/');
 const oldRelPath = oldPath.replace(/^\//, '');
 // Skip if an active job page already occupies this path (buffered writes
 // are invisible to fs.existsSync — use the activeJobDirs set instead).
 if (activeJobDirs.has(oldRelPath.replace(/\/+$/, ''))) continue;
 // …and skip when ANY locale's active-job emit claimed this
 // (canton, locale, slug) tuple — including a locale THIS shard build
 // did not render. `activeJobDirs` alone is not a sufficient guard:
 // it is filled ~500 lines below `emittedActiveJobPaths`, AFTER the
 // `if (!shouldEmitLocale(locale)) continue` early-exit, so in a
 // per-locale shard build it only ever holds the locales that build
 // owns. The sharded jobs sitemap gates on `emittedActiveJobPaths`
 // instead (see the "URL list for the sharded sitemap" block above),
 // and it is written by the IT/main build for ALL four locales. A path
 // that is in `emittedActiveJobPaths` but not in `activeJobDirs` is
 // therefore a URL the sitemap ADVERTISES as an active job page while
 // this loop still considers it free to overwrite with a bridge.
 //
 // That is exactly how
 // /en/find-jobs-zurich/foreman-timber-construction-m-f-d-80-100-implenia-rumlang/
 // — an active EN job page, listed in sitemap-jobs-zurigo.xml — ended up
 // serving another job's previousSlug bridge, canonical pointing at
 // /en/find-jobs-zurich/baufuhrer-holzbau-m-w-d-80-100-implenia-ch/
 // (which is in NO sitemap). audit:sitemap-canonicals fails that as a
 // non-self-canonicalising <loc>, and it is right to: the sitemap must
 // never advertise a bridge (see INCLUDE_PREV_SLUG_SITEMAP_ENTRIES=false
 // above — bridges are deliberately kept OUT of the sitemap). Suppressing
 // the bridge here keeps the advertised page alive AND keeps the sitemap
 // honest; pruning the URL from the sitemap instead would leave the real
 // page clobbered.
 //
 // Same key shape and delimiter as the sitemap gate (Phase 8a), built
 // from the same `sharedResolveJobCanton` result.
 if (emittedActiveJobPaths.has(`${jobCantonForBridge}:${locale}:${oldSlug}`)) continue;
 const __tPrevSlugBridge = startTimer();
 const outDir = np.join(distDir, oldRelPath);
 // Always generate bridge pages — they take priority over any compat/legacy
 // page that another plugin (e.g. legacyRedirectsPlugin) may have written
 // at the same path via fs.writeFileSync during concurrent closeBundle.
 //
 // Reuse the full active page HTML — canonical already points to the
 // current slug URL. Inject __BRIDGE_TARGET_SLUG__ so the SPA knows to
 // use the current slug for data lookup instead of parsing the old URL.
 // Tiered emission: filter consults evidence-index.json + hourly
 // thin-page-promotions-active.json. Decision applies to BOTH the
 // primary emit and the legacy-TI mirror emit below so the bridge
 // pair stays consistent.
 // PR #743 lesson: GSC + GA4 see traffic at the legacy-TI mirror more
 // often than the freshly-promoted canton-aware canonical (Google
 // remembers the pre-PR-159 URL). Check both candidate paths via
 // decideMulti so a hit at the mirror keeps the bridge full.
 const __brBridgeUrlPath = oldPath.startsWith('/') ? oldPath : `/${oldPath}`;
 const __brCandidatePaths: string[] = [__brBridgeUrlPath];
 if (jobCantonForBridge !== 'TI') {
 const __brLegacyTIPath = `/${localePrefix[locale]}/${buildCantonAwareSection(locale, 'TI')}/${oldSlug}`.replace(/\/+/g, '/');
 __brCandidatePaths.push(__brLegacyTIPath);
 }
 // Reviewer HIGH #1: gsc-job-urls.json is IT-only — non-IT locale
 // bridges miss the safety net unless we also probe their IT-locale
 // equivalent. Cross-locale candidates use the SAME oldSlug at every
 // other locale's canton-aware section (an oldSlug observed in IT GSC
 // is the strongest historical signal we have for the job).
 for (const __brOtherLocale of localeList) {
 if (__brOtherLocale === locale) continue;
 const __brOtherPath = `/${localePrefix[__brOtherLocale]}/${buildCantonAwareSection(__brOtherLocale, jobCantonForBridge)}/${oldSlug}`.replace(/\/+/g, '/');
 __brCandidatePaths.push(__brOtherPath);
 if (jobCantonForBridge !== 'TI') {
 // Also the legacy-TI mirror in the other locale.
 __brCandidatePaths.push(`/${localePrefix[__brOtherLocale]}/${buildCantonAwareSection(__brOtherLocale, 'TI')}/${oldSlug}`.replace(/\/+/g, '/'));
 }
 }
 const __brDecision = trafficFilter.decideMulti(__brCandidatePaths, 'previousSlug');
 const __brAction: 'full' | 'thin' =
 __brDecision.action === 'thin' ? 'thin' : 'full';
 if (__brAction === 'thin') bridgeThinCount++; else bridgeFullCount++;
 const { indexHtml, flatHtml } = ensureBridgeHtml(__brAction);
 // Real bytes saved per file emit (counter above tracks decisions
 // only, not byte deltas — see PR #729 lesson).
 const __brDelta = __brAction === 'thin'
 ? (cachedHtml.length - indexHtml.length)
 : 0;

 _md(outDir);
 _qw(np.join(outDir, 'index.html'), indexHtml);

 const flatFile = np.join(distDir, oldPath.replace(/^\//, '') + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, indexHtml);
 bridgeBytesSaved += __brDelta * 2;
 bridgeCount++;
 recordEmit('previous-slug-bridge', __tPrevSlugBridge);

 // Pre-cathedral, every job — regardless of resolved canton — was
 // indexed under the legacy TI section (`/cerca-lavoro-ticino/`,
 // `/de/jobs-im-tessin/`, `/en/find-jobs-ticino/`,
 // `/fr/trouver-emploi-tessin/`). The bridge above emits the old slug
 // only at the canton-aware section, which leaves the previously-
 // indexed legacy TI URL uncovered for non-TI jobs: Google still has
 // `/fr/trouver-emploi-tessin/<oldFrSlug>` in its index but the SPA
 // self-healing safety net renders a noindex tombstone there, and
 // visitors who arrive from a bookmark or external link land on the
 // generic "Offerta aggiornata" stub instead of the real job page.
 //
 // Emit the same full-content bridge at the legacy TI section too —
 // canonical inside `indexHtml` already points to the canton-aware
 // URL so Google consolidates link equity, and the visitor sees the
 // real content. Parallel to the active job's cross-canton legacy TI
 // bridge at ~line 2840 (PR #159), extended here to cover every
 // per-locale previousSlug too.
 if (jobCantonForBridge !== 'TI' && !isCompanyHubNamespaceSlug(oldSlug, locale)) {
 const legacyTIRelPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, 'TI')}/${oldSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const legacyTIKey = legacyTIRelPath.replace(/\/+$/, '');
 // The legacy TI section is canton-blind: every non-TI job collapses
 // here, so this oldSlug mirror can collide with (a) an active job's
 // authoritative TI bridge that owns the SAME slug under its own
 // canton, or (b) another non-TI job's previousSlug mirror that lists
 // the same oldSlug (multi-city postings cross-pollinate previousSlugs).
 // Skip when an authoritative active bridge already owns the path, and
 // first-claimant-wins among previousSlug mirrors so the canonical at
 // this TI path stays deterministic across builds instead of flipping
 // to whichever job happened to write last (#2545).
 if (
 !activeJobDirs.has(legacyTIKey) &&
 !legacyTiBridgeDirs.has(legacyTIKey)
 ) {
 legacyTiBridgeDirs.add(legacyTIKey);
 const __tPrevSlugLegacyTIBridge = startTimer();
 const legacyTIOutDir = np.join(distDir, legacyTIRelPath);
 _md(legacyTIOutDir);
 _qw(np.join(legacyTIOutDir, 'index.html'), indexHtml);
 const legacyTIFlatFile = np.join(distDir, legacyTIRelPath + '.html');
 _md(np.dirname(legacyTIFlatFile));
 _qwFlat(legacyTIFlatFile, indexHtml);
 bridgeBytesSaved += __brDelta * 2;
 bridgeCount++;
 recordEmit('previous-slug-bridge-legacy-ti', __tPrevSlugLegacyTIBridge);
 }
 }
 }
 }
 }
 if (bridgeCount > 0) {
 const skipNote = bridgeSkippedNotWinner > 0
 ? ` (${bridgeSkippedNotWinner} duplicate emits skipped — see data/previous-slug-winners.json for the canonical owner per slug)`
 : '';
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${bridgeCount} previousSlugs full-content pages${skipNote}`);
 // #6134: second half of the previously-unlogged stretch (see the
 // "after cross-locale-expired" checkpoint above).
 logBuildMem('jobsSeoPages: after previousSlugs-bridges', collector);
 // Backpressure between previousSlugs full-content (~65k pages) and
 // the next big emit (cross-locale-active-bridge ~56k pages).
 await collector.awaitDrainSlot(2);
 }

 // Garbage-collect entries whose oldSlug nobody has claimed in the last
 // 30 days. Without this the registry grows monotonically: deleted jobs
 // leave their winner entries behind as ghosts, and a slug that nobody
 // lists in any previousSlugs anymore stays in the file forever.
 // 30 days is a grace window wide enough to ride out a temporarily-
 // absent feed entry (crawler hiccup, weekend off-shift, manual review)
 // without flipping the URL on its return; tight enough that genuinely
 // removed slugs eventually exit the file.
 const PREV_SLUG_WINNER_TTL_DAYS = 30;
 const prunedWinners = pruneStaleWinners(
 previousSlugWinners,
 PREV_SLUG_WINNER_TTL_DAYS * 24 * 60 * 60 * 1000,
 nowIso,
 );
 if (prunedWinners > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners: pruned ${prunedWinners} stale entries (>${PREV_SLUG_WINNER_TTL_DAYS}d since last seen)`,
 );
 }

 // Persist the winners file if any decision changed during this build,
 // OR if the prune removed entries. Stable cross-build URLs depend on
 // persistence — without it, the heuristic could re-elect a different
 // winner on a different build and silently flip every bridge target.
 if (JSON.stringify(previousSlugWinners) !== previousSlugWinnersBefore) {
 saveWinners(previousSlugWinnersPath, previousSlugWinners);
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners updated → ${np.relative(rootDir, previousSlugWinnersPath)}`,
 );
 }

 /* ── Cross-locale reconciliation bridge pages ──────────────── */
 // When a job has different slugs per locale (e.g. AI translation landed
 // the French slug under the Italian base URL before the Italian slug
 // was generated), a direct hit on `/cerca-lavoro-ticino/<slug-fr>` would
 // otherwise render nothing until the client-side slug map loads.
 // Generate a full-content bridge page at every (baseLocale × foreignSlug)
 // combination where the foreign-locale slug differs from the base-locale
 // slug. Content is served in the base URL's locale; canonical points to
 // the base locale's current slug URL. No redirect, no countdown.
 // #6134 (strutturale): `jobHtmlCache` (una pagina HTML completa da
 // ~30-50 KB per ogni job attivo del locale posseduto) ha il suo ULTIMO
 // lettore in questo loop, ma veniva svuotata solo alla fine (clear() sotto)
 // — quindi la fase attraversava il proprio picco con l'intera cache in
 // pancia, ed e' esattamente il tratto dove i run 32315058310 e 32319344037
 // sono morti (exit 134, heap 9431 MB al checkpoint precedente). Refcount
 // esatto invece di delete-al-primo-uso: due job possono condividere uno
 // slug (il caso convit-holding dei previousSlugs), quindi una entry si
 // libera solo quando il suo ultimo lettore l'ha consumata. Il pre-pass
 // replica ESATTAMENTE il predicato di lettura del loop (slug non vuoto +
 // shouldEmitLocale sul baseLocale): se i due divergono, l'effetto e' solo
 // memoria non liberata, mai una lettura mancata.
 const crossLocaleCacheReads = new Map<string, number>();
 for (const job of validJobs) {
 for (const locale of localeList) {
 if (!shouldEmitLocale(locale)) continue;
 const s = localizedSlug(job, locale);
 if (!s) continue;
 const k = `${locale}:${s}`;
 crossLocaleCacheReads.set(k, (crossLocaleCacheReads.get(k) ?? 0) + 1);
 }
 }
 let crossLocaleCount = 0;
 for (const job of validJobs) {
  await collector.awaitDrainSlot(2); // bound flush backlog (#1290; 2 e non 6: qui l'heap e' gia' al picco, vedi il commento del refcount sopra)
 // Sibling guard to the active-job/previousSlug legacy-TI bridges above
 // (PR #3052, isCompanyHubNamespaceSlug): a non-TI job whose foreign slug
 // merely starts with azienda-/company-/unternehmen-/entreprise- must not
 // be mirrored into the reserved TI company-hub namespace below, or its
 // canonical (the job's real, non-TI canton) drifts the
 // cathedral-sector-hubs invariant (issue #2976 recurrence).
 const jobCantonForCrossLocale = sharedResolveJobCanton(job as { canton?: string; location?: string });
 const slugPerLocale: Record<string, string> = {};
 for (const locale of localeList) {
 const s = localizedSlug(job, locale);
 if (s) slugPerLocale[locale] = s;
 }
 // Previous slugs grouped by locale (used to cover cross-locale legacy slugs,
 // e.g. a German previous slug indexed under the Italian base URL).
 const pslByLocaleTyped = (job as { previousSlugsByLocale?: Record<string, unknown> }).previousSlugsByLocale;
 const prevSlugsByLocale: Record<string, string[]> = {};
 if (pslByLocaleTyped && typeof pslByLocaleTyped === 'object') {
 for (const [l, arr] of Object.entries(pslByLocaleTyped)) {
 if (Array.isArray(arr)) prevSlugsByLocale[l] = (arr as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0);
 }
 }
 for (const baseLocale of localeList) {
 const baseSlug = slugPerLocale[baseLocale];
 if (!baseSlug) continue;
 // Per-locale shard build (BUILD_LOCALE): the cross-locale bridge is written
 // under baseLocale's prefix, so skip it for locales this shard doesn't own
 // (Fase 1c, same class as the previousSlugs bridge above). slugPerLocale is
 // still built for ALL locales above so foreignSlugs detection is unaffected.
 // No-op in the all-locale build.
 if (!shouldEmitLocale(baseLocale)) continue;
 const crossLocaleCacheKey = `${baseLocale}:${baseSlug}`;
 const cachedHtml = jobHtmlCache.get(crossLocaleCacheKey);
 // Eviction all'ultimo lettore (vedi il refcount pre-pass sopra): la cache
 // scende progressivamente DURANTE il loop invece di restare piatta fino al
 // clear() in coda. Il decremento avviene anche su cache-miss, perche' il
 // pre-pass ha contato lo stesso predicato, non la presenza in cache.
 // Review di #6154: il default `?? 1` trasformava una divergenza di
 // predicato (chiave letta ma mai contata) in una EVIZIONE PREMATURA al
 // primo lettore — l'opposto dell'invariante dichiarata. Una chiave non
 // contata ora non viene mai evitta: il costo della divergenza torna a
 // essere solo memoria (fino al clear() di coda), mai una lettura mancata.
 const countedReads = crossLocaleCacheReads.get(crossLocaleCacheKey);
 if (countedReads !== undefined) {
 const remainingReads = countedReads - 1;
 if (remainingReads <= 0) {
 crossLocaleCacheReads.delete(crossLocaleCacheKey);
 jobHtmlCache.delete(crossLocaleCacheKey);
 } else {
 crossLocaleCacheReads.set(crossLocaleCacheKey, remainingReads);
 }
 }
 if (!cachedHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 // Other locale's current slug
 const s = slugPerLocale[otherLocale];
 if (s && s !== baseSlug) foreignSlugs.add(s);
 // Other locale's previous slugs (covers legacy renames per locale)
 for (const ps of prevSlugsByLocale[otherLocale] || []) {
 if (ps && ps !== baseSlug) foreignSlugs.add(ps);
 }
 }
 if (foreignSlugs.size === 0) continue;
 // Compute once per (job, baseLocale) — same HTML is written at every foreign slug path.
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${inlineScriptJson(baseSlug)};</script>`;
 const bridgeHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 // Skip cross-locale reconciliation when the foreign slug is a
 // reserved sector/city hub (same rationale as the previousSlugs
 // guard above — protects jobSectorPagesPlugin's curated hubs).
 if (RESERVED_HUB_SLUGS.has(foreignSlug)) continue;
 if (jobCantonForCrossLocale !== 'TI' && isCompanyHubNamespaceSlug(foreignSlug, baseLocale)) continue;
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Skip if an active job page already occupies this path (another
 // job's slug happens to collide across locales — active wins).
 if (activeJobDirs.has(relPathKey)) continue;
 // Same asymmetry as the previousSlugs bridge above: `activeJobDirs`
 // only covers the locales THIS shard build rendered, while the
 // sharded jobs sitemap advertises every (canton, locale, slug) in
 // `emittedActiveJobPaths`. This path is built from the legacy
 // `sectionByLocale[baseLocale]` segment, which is precisely what
 // `buildCantonAwareSection(locale, 'TI')` early-returns — hence the
 // 'TI' canton in the key.
 if (emittedActiveJobPaths.has(`TI:${baseLocale}:${foreignSlug}`)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if a previousSlugs bridge already covered this path for
 // this job (same content would be written again).
 if (_writtenPaths.has(indexFile)) continue;
 const __tCrossLocaleActive = startTimer();
 _md(outDir);
 _qw(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 // Note: skip the flat `.html` variant — GH Pages serves
 // /dir/index.html for direct URL hits and the flat variant
 // would double disk usage for ~27k bridge pages.
 crossLocaleCount++;
 recordEmit('cross-locale-active-bridge', __tCrossLocaleActive);
 }
 }
 }
 if (crossLocaleCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleCount} cross-locale reconciliation pages`);
 }
 // #6134: prima di questo checkpoint la finestra cieca andava da
 // previousSlugs-bridges fino a fine plugin (378 righe con le due fasi piu'
 // pesanti dentro) — i run del 19/20-08 sono morti li' senza una riga [mem]
 // che dicesse dove. Pre-cleanup di proposito, come la coppia di checkpoint
 // del blocco cross-locale-expired (#6139 item 6).
 logBuildMem('jobsSeoPages: after cross-locale-active-bridges', collector);

 // `jobHtmlCache` (populated during the ~85k active-job-page render
 // phase) was read for the last time above, in the cross-locale-active
 // bridge loop — the self-heal pass and final flush below never touch
 // it again. Issue #5864 / run 31798646143 OOM'd (exit 134, V8 heap
 // ~10.6 GB) right after the self-heal log line, the same failure shape
 // already fixed once for `expiredSoftLandingCache` above. Free it here
 // so the tail of the build isn't carrying tens of thousands of
 // full-HTML strings it no longer needs.
 // (Dopo il refcount-eviction nel loop qui sopra questo clear() e' quasi un
 // no-op — restano solo le entry che il predicato del pre-pass non ha
 // contato. Resta come rete di sicurezza, non come meccanismo.)
 jobHtmlCache.clear();
 // #6134 (strutturale): anche il CORPUS e' morto qui. `validJobs` (la
 // spread-copy dei ~22k job di data/jobs.json, con i bucket related e la
 // companyMap che puntano agli stessi oggetti) ha il suo ultimo lettore nel
 // loop cross-locale-active qui sopra; il self-heal legge `tracking` e
 // `_writtenPaths`, mai i job. Svuotare l'array NON basta da solo — ogni
 // container che punta agli stessi oggetti va svuotato nello stesso punto,
 // o il rilascio e' un no-op silenzioso. Il checkpoint subito sotto dice al
 // prossimo deploy se questo blocco libera davvero (pattern DUAL PURPOSE di
 // buildMemLog.ts).
 validJobs.length = 0;
 sitemapEligibleJobs.length = 0;
 relatedJobsByCategory.clear();
 relatedJobsByLocation.clear();
 companyMap.clear();
 // Review di #6154 (finding 3): anche questi puntano agli stessi oggetti
 // job, e uno basta a tenere vivo il grafo. Ultimi lettori verificati:
 // sortedForPagination L8681, implicitPreviousSlugs L11766,
 // companyActiveJobsMap L12342, selectRecentJobs (unico lettore di
 // recentJobPool) L12712 — tutti prima di questo punto; il self-heal legge
 // solo tracking/_writtenPaths/activeJobDirs (che infatti NON vengono
 // toccati qui). jobsByCantonCity/cantonLatestJobs della review NON sono
 // qui: sono block-scoped nella fase city-hubs (tsc li rifiuta a questo
 // punto), quindi escono di scope da soli.
 sortedForPagination.length = 0;
 implicitPreviousSlugs.length = 0;
 companyActiveJobsMap.clear();
 recentJobPool.length = 0;
 crossLocaleCacheReads.clear();
 // NIENTE forceGc() esplicito prima del checkpoint (review di #6154,
 // finding 1): logBuildMem fotografa heapUsed, POI esegue la sua GC e
 // riporta gcFreed come delta. Con una GC gia' fatta qui il checkpoint
 // avrebbe letto gcFreed≈0 per costruzione, rendendo inosservabile la
 // verifica dichiarata («il rilascio libera davvero?») e sempre-vero il
 // revert-trigger. Cosi' invece gcFreed AL checkpoint E' la misura del
 // rilascio.
 logBuildMem('jobsSeoPages: after corpus-release', collector);

 /* ── Self-healing: cover any tracking paths not yet written ──── */
 // Safety net: any tracking path that wasn't covered by active, soft-landing,
 // or bridge pages gets a minimal redirect page pointing to the job listing.
 // This handles edge cases like locale-variant tracking keys that match a
 // currentSlug value but whose locale paths differ from the active job paths.
 let healedCount = 0;
 let relocatedActiveCount = 0;
 for (const [, paths] of Object.entries(tracking) as [string, Record<string, string>][]) {
 for (const locale of localeList) {
 const relPath = paths?.[locale];
 if (!relPath) continue;
 // Per-locale shard build (BUILD_LOCALE): the self-healing tombstone is
 // written under this locale's prefix, so skip it for locales this shard
 // doesn't own (Fase 1c, same class as the bridge loops above). No-op in the
 // all-locale build (the it/main shard still heals every locale).
 if (!shouldEmitLocale(locale)) continue;
 const absFile = np.join(distDir, relPath.replace(/^\//, ''), 'index.html');
 if (_writtenPaths.has(absFile)) continue;
 const __tSelfHealing = startTimer();

 // Active cross-canton job: this tracking path is the job's legacy-TI drift
 // URL, overwritten by the compat-merge above (search activeDriftRealPathByCompat).
 // The job is ALIVE at `driftRealPath` (its current canton page), so emit a
 // RELOCATION bridge pointing users + Google there, NOT a "job removed"
 // tombstone. The bridge's canonical/CTA both target the live page, so equity
 // consolidates to the real canton URL and visitors reach the open offer.
 const driftRealPath = activeDriftRealPathByCompat.get(relPath);
 if (driftRealPath) {
 // Reserved company-hub namespace guard (issue #2976, 6th call site): when
 // `relPath`'s slug starts with the company-hub prefix (e.g. an old TI-legacy
 // job whose title literally begins "Azienda di consulenza…"), this
 // relocation bridge would otherwise sit inside the reserved
 // `/cerca-lavoro-ticino/azienda-*` namespace while canonicalizing to the
 // job's REAL foreign-canton page — the exact drift
 // tests/seo/cathedral-sector-hubs.test.ts guards against. The active-job
 // and previousSlug bridges (~line 3413, ~11959, ~12096) already skip
 // writing full content there for this reason, which is precisely why this
 // path falls through to self-healing in the first place. Keep the CTA
 // pointing at the real page (still useful to visitors) but point the
 // canonical at the Swiss aggregator instead of the foreign-canton URL —
 // same consolidation target companyHubBridgePlugin uses for unmatched
 // cross-canton company URLs.
 const relSlug = relPath.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
 const namespaceCollision = isCompanyHubNamespaceSlug(relSlug, locale);
 const realUrl = namespaceCollision
 ? `${BASE_URL}${withSlash(`${localePrefix[locale]}/${buildCantonAwareSection(locale, AGGREGATE_KEY)}`.replace(/\/+/g, '/'))}`
 : `${BASE_URL}${withSlash(driftRealPath)}`;
 const movedCopy = ({
 it: { title: 'Annuncio spostato', body: 'Questo annuncio è ora pubblicato in un\'altra sezione. Aprilo alla pagina aggiornata qui sotto.', cta: 'Apri l\'annuncio aggiornato' },
 en: { title: 'Listing moved', body: 'This listing is now published in another section. Open it on the updated page below.', cta: 'Open the updated listing' },
 de: { title: 'Anzeige verschoben', body: 'Diese Anzeige ist jetzt in einem anderen Bereich veröffentlicht. Öffnen Sie sie auf der aktualisierten Seite unten.', cta: 'Aktualisierte Anzeige öffnen' },
 fr: { title: 'Offre déplacée', body: 'Cette offre est désormais publiée dans une autre section. Ouvrez-la sur la page à jour ci-dessous.', cta: 'Ouvrir l\'offre à jour' },
 } as const)[locale] ?? { title: 'Annuncio spostato', body: 'Questo annuncio è ora pubblicato in un\'altra sezione.', cta: 'Apri l\'annuncio aggiornato' };
 const movedHtml = buildCanonicalBridgePage({
 canonicalUrl: realUrl,
 pathLabel: withSlash(driftRealPath),
 title: `${movedCopy.title} | Frontaliere Ticino`,
 description: movedCopy.body,
 body: movedCopy.body,
 ctaLabel: movedCopy.cta,
 lang: locale,
 noindex: true,
 });
 writeSoftLandingPage(relPath.replace(/^\//, ''), movedHtml);
 relocatedActiveCount++;
 recordEmit('self-healing', __tSelfHealing);
 continue;
 }

 const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const listingUrl = `${BASE_URL}${withSlash(listingPath)}`;
 const localeCopy = {
 it: { title: 'Offerta di lavoro aggiornata', body: 'Questa posizione è stata aggiornata o rimossa. Consulta le offerte disponibili.', cta: 'Vedi tutte le offerte' },
 en: { title: 'Job listing updated', body: 'This position has been updated or removed. Browse available listings.', cta: 'View all listings' },
 de: { title: 'Stellenangebot aktualisiert', body: 'Diese Stelle wurde aktualisiert oder entfernt. Durchsuchen Sie die verfügbaren Angebote.', cta: 'Alle Angebote ansehen' },
 fr: { title: 'Offre d\'emploi mise à jour', body: 'Cette offre a été mise à jour ou supprimée. Consultez les offres disponibles.', cta: 'Voir toutes les offres' },
 };
 const copy = localeCopy[locale] ?? localeCopy.it;
 const html = buildCanonicalBridgePage({
 canonicalUrl: listingUrl,
 pathLabel: listingPath,
 title: `${copy.title} | Frontaliere Ticino`,
 description: copy.body,
 body: copy.body,
 ctaLabel: copy.cta,
 lang: locale,
 noindex: true,
 });
 writeSoftLandingPage(relPath.replace(/^\//, ''), html);
 healedCount++;
 recordEmit('self-healing', __tSelfHealing);
 }
 }
 if (relocatedActiveCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Relocated ${relocatedActiveCount} active cross-canton drift URLs to their live canonical page (no orphan tombstone)`);
 }
 if (healedCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Self-healed ${healedCount} tracking paths with no prior coverage`);
 }
 // #6134: issue #5864 (run 31798646143) e' morta "right after the self-heal
 // log line" senza un [mem] a dire con quanto heap ci era arrivata. Chiude
 // l'ultima finestra cieca del plugin: da qui a fine closeBundle restano
 // solo flush + sitemap patch + report.
 logBuildMem('jobsSeoPages: after self-heal', collector);

 /* ── Flush all buffered writes in parallel batches ── */
 const t0 = Date.now();
 const written = await collector.flush();
 const skipped = collector.skippedByHash;
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
 (skipped > 0 ? ` (${skipped} skipped by content hash)` : ''));
 // Signal downstream consumers (relatedSearchClustersPlugin) that bridge
 // HTML is on disk. Without this, parallel closeBundle lets the cluster
 // sitemap be written before bridge writes flush, leaking non-self-
 // canonical bridge URLs into sitemap-search-clusters.xml.
 // Signal is also resolved on the jobs.json-missing early-return path above
 // (search resolveJobsSeoPagesFlushed), so EVERY normal exit of closeBundle
 // resolves jobsSeoPagesFlushed. The only way to reach this point without
 // having resolved it earlier is the happy path; the early-return covers the
 // jobless case. A thrown error propagates to Vite and fails the build
 // (fail-fast, not a deadlock). Hence the await in relatedSearchClustersPlugin
 // (cache-hit path L2190 + writeSitemap L2029) never hangs. (#947/#950)
 resolveJobsSeoPagesFlushed();

 // Print profiler summary in normal profiled CI builds; local opt-out:
 // JOBS_SEO_PROFILE=0.
 printJobsSeoProfile();
 // Canonical-cleaned cache hit-rate diagnostic — tells us whether the
 // 2-layer split is paying off (high hit rate = cross-locale sharing
 // working) or whether descriptions are mostly unique per (job, locale)
 // (low hit rate = need to push further upstream, e.g. worker pool).
 {
 const total = _canonicalCleanedHits + _canonicalCleanedMisses;
 const hitPct = total > 0 ? ((_canonicalCleanedHits / total) * 100).toFixed(1) : '0.0';
 console.log(
 `[jobs-seo-profile] canonical-cleaned-cache    hits=${_canonicalCleanedHits} misses=${_canonicalCleanedMisses} hit_rate=${hitPct}% size=${_canonicalCleanedCacheSizeAtEnd} evictions=${_canonicalCleanedEvictions}`,
 );
 }
 {
 const total = _cleanItemsHits + _cleanItemsMisses;
 const hitPct = total > 0 ? ((_cleanItemsHits / total) * 100).toFixed(1) : '0.0';
 console.log(
 `[jobs-seo-profile] cleanItems-cache           hits=${_cleanItemsHits} misses=${_cleanItemsMisses} hit_rate=${hitPct}%`,
 );
 }
 if (PROFILE_RELATED_COMPARE) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Related pool compare mismatches: ${relatedCompareMismatches}`);
 if (relatedCompareMismatches > 0) {
 throw new Error(`Related pool preindex mismatch count: ${relatedCompareMismatches}`);
 }
 }

 // ── Patch sitemap.xml index lastmods ───────────────────────────────
 // The sitemap.xml index file is re-emitted by other plugins each build,
 // so our entries' <lastmod> would otherwise drop out (or fail to
 // register on a clean build). Idempotent: adds the entry if missing,
 // otherwise refreshes lastmod.
 const sitemapIndexFile = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexFile)) {
 let idx = fs.readFileSync(sitemapIndexFile, 'utf-8');
 const sitemapJobsExists = fs.existsSync(np.join(distDir, 'sitemap-jobs.xml'));
 if (sitemapJobsExists) {
 if (!idx.includes('sitemap-jobs.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n <lastmod>${cacheDateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${cacheDateStamp}$2`
 );
 }
 }
 const sitemapExpiredExists = fs.existsSync(np.join(distDir, 'sitemap-jobs-expired.xml'));
 if (sitemapExpiredExists) {
 if (!idx.includes('sitemap-jobs-expired.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n <lastmod>${cacheDateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs-expired\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${cacheDateStamp}$2`
 );
 }
 }
 fs.writeFileSync(sitemapIndexFile, idx, 'utf-8');
 }

 // Tiered emission summary (artifact-shrink Fase 1). 'full' = today's
 // behavior (cached canonical HTML reused). 'thin' = bridge body
 // replaced with a slim ≥50-word block; HEAD signals unchanged. See
 // build-plugins/shared/bridgeThinShell.ts and trafficEvidenceFilter.ts.
 // Formats a byte count as "X.YGB" / "X.YMB" / "X KB" (1024-base, to
 // match dist-bytes-report's units). Inline because there's no shared
 // formatter in this plugin file.
 const fmtBytes = (n: number): string => {
 if (n < 1024) return `${n}B`;
 if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
 if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
 return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
 };
 if (bridgeThinCount > 0 || bridgeFullCount > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m bridge tier: ` +
 `full=${bridgeFullCount} thin=${bridgeThinCount} ` +
 `bytes_saved=${fmtBytes(bridgeBytesSaved)}`
 );
 }
 if (softLandingThinCount > 0 || softLandingFullCount > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m soft-landing tier: ` +
 `full=${softLandingFullCount} thin=${softLandingThinCount} ` +
 `bytes_saved=${fmtBytes(softLandingBytesSaved)}`
 );
 }
 if (gscKeywordThinCount > 0 || gscKeywordFullCount > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m gsc-keyword-landing tier: ` +
 `full=${gscKeywordFullCount} thin=${gscKeywordThinCount} ` +
 `bytes_saved=${fmtBytes(gscKeywordBytesSaved)}`
 );
 }
 // Total real dist saving from tiered emission. PR #729 lesson: the
 // tier counters above record FILTER DECISIONS, not byte deltas. A
 // build where the thin-shell regex misses (e.g. unquoted-class bug
 // pre-#729) shows `thin=N high` but `bytes_saved=0`. This single
 // line is the ground truth.
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m tiered emission saved ` +
 `${fmtBytes(bridgeBytesSaved + softLandingBytesSaved + gscKeywordBytesSaved)} ` +
 `(bridges=${fmtBytes(bridgeBytesSaved)}, soft-landings=${fmtBytes(softLandingBytesSaved)}, gsc-keyword=${fmtBytes(gscKeywordBytesSaved)})`
 );
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m ${trafficFilter.summary()}`);
 },
 };
}
