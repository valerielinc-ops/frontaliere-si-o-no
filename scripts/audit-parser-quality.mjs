#!/usr/bin/env node
/**
 * Audit per-crawler job data for silent parser failures.
 *
 * Checks: thin descriptions, missing structured content, stale URLs,
 * missing locale coverage, duplicate descriptions.
 *
 * Usage:
 *   node scripts/audit-parser-quality.mjs                  # full audit (no URL checks)
 *   node scripts/audit-parser-quality.mjs --skip-urls      # same (explicit)
 *   node scripts/audit-parser-quality.mjs --check-urls     # include URL reachability
 *   node scripts/audit-parser-quality.mjs --check-source-details # compare sampled detail pages
 *   node scripts/audit-parser-quality.mjs --crawler=lidl-svizzera
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  extractDetailFields,
  extractJsonLd,
  selectDetailStructuredRecords,
} from './lib/prospector/extract.mjs';
import { decodeEntities as decodeScrapedHtmlEntities } from './lib/prospector/entities.mjs';
import { resolveSourceBackedSwissGeography } from './lib/prospector/location-evidence.mjs';
import { readAttr } from './lib/html-attr.mjs';
import {
  canonicalSwissCityName,
  findSwissCityInText,
  isCantonOnlyLabel,
  isKnownSwissMunicipality,
  normalizeCantonCode,
  swissMunicipalityCantons,
} from './lib/target-swiss-locations.mjs';
import { isLocationDerivedFromVacancyText } from './lib/crawler-location-config.mjs';
import {
  FOREIGN_COUNTRY_NAME_LABELS,
  ISO_ALPHA2_COUNTRY_CODES,
  SWISS_COUNTRY_LABELS,
} from './lib/prospector/country-inventory.mjs';
import { fetch as undiciFetch } from 'undici';
import { isRobotsDeniedError, mapPool, politeFetch } from './lib/prospector/polite-fetch.mjs';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import { isPublicFetchPolicyError } from './lib/prospector/public-fetch-policy.mjs';
import { transportErrorKind } from './lib/transient-fetch.mjs';
import { partitionCrawlerJobsForActiveMetrics } from './lib/crawler-job-activity.mjs';
import {
  COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS,
  classifySourceDetailObservation,
  createSourceDetailEvidence,
  createSourceDetailEvidenceBundle,
  createSourceDetailEvidenceFailureBundle,
} from './lib/parser-quality-source-detail-replay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const BASELINE_PATH = path.join(ROOT, 'data', 'parser-quality-no-structure-baseline.json');

export const SOURCE_DETAIL_EXTRACTOR_VERSION_FILES = Object.freeze([
  'scripts/lib/prospector/extract.mjs',
  // Reads the vacancy PDF a detail page links or embeds (fetchVacancyPdfText).
  'scripts/lib/pdf-job-content.mjs',
  'scripts/lib/prospector/registrable.mjs',
  'scripts/lib/prospector/entities.mjs',
  'scripts/lib/decode-html-entities.mjs',
  'scripts/lib/html-attr.mjs',
  'scripts/lib/prospector/location-evidence.mjs',
  'scripts/lib/target-swiss-locations.mjs',
  'scripts/lib/crawler-location-config.mjs',
  'scripts/lib/prospector/country-inventory.mjs',
  'scripts/lib/prospector/subdivision-inventory.mjs',
  'data/canton-municipalities.json',
]);
export const SOURCE_DETAIL_NORMALIZER_VERSION_FILES = Object.freeze([
  'scripts/audit-parser-quality.mjs',
  'scripts/lib/parser-quality-source-detail-replay.mjs',
  'scripts/lib/stable-stringify.mjs',
  // `sourceLocationMatches` resolves both sides against the BFS municipality
  // snapshot, so the list and its reader are normalizer inputs too — a replay
  // recorded before a municipality merge must not silently compare differently.
  'scripts/lib/target-swiss-locations.mjs',
  'data/canton-municipalities.json',
]);

function filesSha256(filePaths, readFile) {
  const digest = createHash('sha256');
  for (const filePath of filePaths) {
    const contents = Buffer.from(readFile(path.join(ROOT, filePath)));
    digest.update(`${filePath}\0${contents.byteLength}\0`);
    digest.update(contents);
  }
  return digest.digest('hex');
}

/** Exact code versions persisted with every replayable source-detail sample. */
export function getSourceDetailImplementationVersions({ readFile = fs.readFileSync } = {}) {
  return {
    extractor: filesSha256(SOURCE_DETAIL_EXTRACTOR_VERSION_FILES, readFile),
    normalizer: filesSha256(SOURCE_DETAIL_NORMALIZER_VERSION_FILES, readFile),
  };
}

/**
 * Capture git provenance for the dataset being audited, so a report can be
 * told apart as stale-vs-fresh after the fact (issue #4063 item 3). The
 * audit's `workflow_run` trigger historically fired on the crawler
 * *dispatcher* workflow completing, not on the crawl-and-push actually
 * finishing (dispatch takes minutes; the crawl+push it kicks off can take
 * hours) — so a report could silently read data from BEFORE the latest
 * crawl commit landed, with no way to tell after the fact. Two references:
 *   - repoHeadSha: the commit actually checked out when the audit ran
 *     (GITHUB_SHA in CI, else `git rev-parse HEAD`).
 *   - datasetLastCommit: the most recent commit that touched
 *     data/jobs/by-crawler/ as of repoHeadSha — the true "as-of" freshness
 *     of the audited data, independent of unrelated commits landing on top.
 * Falls back to nulls outside a git checkout rather than throwing —
 * provenance is diagnostic, never load-bearing for the audit's verdict.
 *
 * @returns {{ repoHeadSha: string | null, datasetLastCommit: { sha: string | null, committedAt: string | null } }}
 */
export function getDatasetProvenance() {
  const run = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repoHeadSha = process.env.GITHUB_SHA || null;
  if (!repoHeadSha) {
    try {
      repoHeadSha = run('git rev-parse HEAD');
    } catch {
      repoHeadSha = null;
    }
  }
  let datasetLastCommit = { sha: null, committedAt: null };
  try {
    const out = run('git log -1 --format=%H%x1f%cI -- data/jobs/by-crawler');
    const [sha, committedAt] = out.split('\x1f');
    if (sha) datasetLastCommit = { sha, committedAt: committedAt || null };
  } catch {
    // Not a git checkout (or path untracked) — leave nulls.
  }
  return { repoHeadSha, datasetLastCommit };
}

export function loadNoStructureBaseline(p = BASELINE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { generatedAt: null, perCrawler: {} };
  }
}

/**
 * Escalate duplicate-description warnings to CRITICAL using two complementary
 * signals: real source duplicates (title-aware) and chrome scraping (desc-only).
 *
 * SIGNAL 1 — duplicate listings (title-aware fingerprint, ≥80%):
 *   Many records share the same TITLE *and* same body. Either the source
 *   feed publishes the same role multiple times (bitfinex's Recruitee setup
 *   posts each role 9× with different IDs) or the parser is keeping records
 *   that should have been deduped. Action: dedupe in the parser.
 *
 * SIGNAL 2 — chrome scraping (desc-only fingerprint, ≥95% in the LARGEST
 * single bucket):
 *   Almost every job — regardless of title — collapses into ONE identical
 *   body. That's the Moncucco-class failure: the parser is grabbing
 *   nav/footer/megamenu instead of the per-job body, so every job carries
 *   the same universal blob. Action: inspect detail-page selectors.
 *
 * Threshold rationale: title-aware stays at 80% (the original threshold);
 * desc-only is tightened to 95% so legitimately templated content (companies
 * that publish the same role across many cities — reboot-monkey, lidl-svizzera)
 * doesn't false-positive. A real chrome-scraping parser produces near-100%
 * desc-only duplicates because every job carries the same nav blob.
 *
 * Signal 2 measures the LARGEST single fingerprint bucket, not the sum across
 * all colliding buckets (see largestDuplicateBucket() doc). A retailer that
 * runs MULTIPLE distinct role templates (New Yorker #3721: a "Verkaufsmitarbeiter"
 * template + a separate "Filialleitung" template) can have each template's
 * bucket legitimately dominate its own jobs while the SUM across both
 * templates still clears 95% of the crawler's total — that's still two
 * distinct, real per-role templates, not one universal chrome blob, so it
 * must not trip this signal.
 *
 * Both signals require ≥5 jobs to skip naturally-templated tiny crawlers.
 *
 * @param {Record<string, { total: number, issues: Array<any>, severity?: string, action?: string }>} report
 * @returns {Array<{ key: string, count: number, total: number, ratio: number, kind: string }>} regressions
 */
export function applyDuplicateDescriptionRatchet(report) {
  const regressions = [];
  for (const [key, entry] of Object.entries(report)) {
    const issue = entry.issues.find((i) => i.type === 'duplicate-descriptions');
    const chromeIssue = entry.issues.find((i) => i.type === 'duplicate-descriptions-desc-only');

    // Signal 1: real duplicate listings (title-aware ≥80%)
    if (issue && issue.total >= 5) {
      const ratio = issue.count / issue.total;
      if (ratio >= 0.8) {
        entry.severity = 'CRITICAL';
        issue.message += ` [DUPLICATE LISTINGS: ${(ratio * 100).toFixed(0)}% of jobs share both title and description]`;
        const ratchetAction = `Many records share the same title AND description — the source feed is publishing duplicates (or the parser is not deduping). Add a deduplication step in the parser keyed on (normalized title, description fingerprint).`;
        entry.action = `${entry.action ? entry.action + ' ' : ''}${ratchetAction}`;
        regressions.push({ key, count: issue.count, total: issue.total, ratio, kind: 'duplicate-listings' });
        continue; // don't double-flag chrome on the same crawler
      }
    }

    // Signal 2: chrome scraping (desc-only ≥95%, only when title-aware didn't fire)
    if (chromeIssue && chromeIssue.total >= 5) {
      const chromeRatio = chromeIssue.count / chromeIssue.total;
      if (chromeRatio >= 0.95) {
        entry.severity = 'CRITICAL';
        // Render the chrome signal on the user-facing duplicate-descriptions
        // issue (chromeIssue itself stays hidden). If the user-facing issue
        // doesn't exist (count was below the >1 threshold for rendering),
        // synthesize one so the warning surfaces.
        const renderIssue = issue || (() => {
          const synth = {
            type: 'duplicate-descriptions',
            count: chromeIssue.count,
            total: chromeIssue.total,
            message: `${chromeIssue.count}/${chromeIssue.total} duplicate descriptions`,
          };
          entry.issues.push(synth);
          return synth;
        })();
        renderIssue.message += ` [PARSER LIKELY GRABBING CHROME: ${(chromeRatio * 100).toFixed(0)}% of jobs share a description regardless of title]`;
        const ratchetAction = `Nearly every job carries the same description — parser is probably scraping the page chrome (nav/footer/menu) instead of the per-job body. Inspect the detail-page selectors.`;
        entry.action = `${entry.action ? entry.action + ' ' : ''}${ratchetAction}`;
        regressions.push({ key, count: chromeIssue.count, total: chromeIssue.total, ratio: chromeRatio, kind: 'chrome-scraping' });
      }
    }
  }
  return regressions;
}

/**
 * Apply the no-structured-content ratchet to a parser-quality report.
 *
 * Mutates entries in `report` in place: any crawler whose
 * `no-structured-content` count has increased above its baseline (or that
 * appears NEW at >=95% / >=10 jobs) is escalated to severity CRITICAL.
 *
 * @param {Record<string, { total: number, issues: Array<any>, severity?: string, action?: string }>} report
 * @param {{ generatedAt: string | null, perCrawler: Record<string, { noStructureCount: number, total: number }> }} baseline
 * @returns {Array<{ key: string, was: number, now: number, total: number }>} regressions
 */
export function applyNoStructureRatchet(report, baseline) {
  const regressions = [];
  for (const [key, entry] of Object.entries(report)) {
    const issue = entry.issues.find((i) => i.type === 'no-structured-content');
    if (!issue) continue;
    const baseRecord = baseline?.perCrawler?.[key];
    const baseCount = baseRecord?.noStructureCount ?? 0;
    const baseTotal = baseRecord?.total ?? 0;
    const ratio = issue.count / issue.total;
    const baseRatio = baseTotal > 0 ? baseCount / baseTotal : 0;
    const isNew = !baseRecord;
    // Compare RATIO, not raw count — a healthy crawler that simply discovers more
    // real jobs over time will grow its absolute no-structure count without any
    // actual quality regression. A fixed tolerance absorbs small-baseline-N noise
    // (e.g. 11/12 → 269/270 is the same ~flat rate, not a new regression).
    const REGRESSION_EPSILON = 0.1;
    const regressed = !!baseRecord && ratio > baseRatio + REGRESSION_EPSILON;
    // New crawler entering 95%+ flat territory, or any existing crawler's ratio
    // meaningfully worsening, triggers CRITICAL
    const newOffender = isNew && ratio >= 0.95 && issue.total >= 10;
    if (newOffender || regressed) {
      entry.severity = 'CRITICAL';
      issue.message += newOffender
        ? ` [NEW OFFENDER: ${issue.count}/${issue.total} flat, no baseline tolerance]`
        : ` [REGRESSION: was ${(baseRatio * 100).toFixed(0)}% (${baseCount}/${baseTotal}), now ${(ratio * 100).toFixed(0)}% (${issue.count}/${issue.total})]`;
      const ratchetAction = `Parser strips list structure — descriptions are flat prose. Either preserve <ul><li> in the parser, or rebaseline if intentional via: npm run audit:parser-quality:rebaseline`;
      entry.action = `${entry.action ? entry.action + ' ' : ''}${ratchetAction}`;
      regressions.push({ key, was: baseCount, now: issue.count, total: issue.total });
    }
  }
  return regressions;
}

/* ── Args ──────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const skipUrls = !args.includes('--check-urls');
const checkSourceDetails = args.includes('--check-source-details');
const SOURCE_DETAIL_SAMPLE_SIZE = 2;
const crawlerFlag = args.find((a) => a.startsWith('--crawler='));
const onlyCrawler = crawlerFlag ? crawlerFlag.split('=')[1] : null;
const rebaseline = args.includes('--rebaseline');

/* ── Helpers ───────────────────────────────────────────────── */
function stripHtml(html) {
  // Decode only after tags are gone: an encoded `<` must not become markup
  // that this stripper can accidentally consume. The prospector decoder wraps
  // the shared entity table and also handles numeric references such as &#62;.
  const withoutTags = (html || '').replace(/<[^>]*>/g, ' ');
  return decodeScrapedHtmlEntities(withoutTags);
}

function plainText(html) {
  return stripHtml(html).replace(/\s+/g, ' ').trim();
}

function normalizePlace(value) {
  return plainText(value).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const LOCATION_TOKEN_ALIASES = new Map([
  ['sankt', 'st'], ['saint', 'st'], ['san', 'st'],
  ['geneva', 'geneve'], ['ginevra', 'geneve'], ['genf', 'geneve'],
  ['berne', 'bern'], ['berna', 'bern'],
  ['bale', 'basel'], ['basilea', 'basel'],
  ['freiburg', 'fribourg'], ['friburgo', 'fribourg'],
  ['bienne', 'biel'],
  ['coira', 'chur'], ['cuira', 'chur'],
  ['lucerne', 'luzern'], ['lucerna', 'luzern'],
  ['zurigo', 'zurich'],
  ['argovia', 'aargau'],
  // Esonimo italiano: `San Gallo` (→ `st gallo` dopo `san`→`st`) è St. Gallen.
  ['gallo', 'gallen'],
]);
const LOCATION_NOISE_TOKENS = new Set([
  'ch', 'che', 'suisse', 'schweiz', 'svizzera', 'switzerland',
  'ag', 'ai', 'ar', 'be', 'bl', 'bs', 'fr', 'ge', 'gl', 'gr', 'ju', 'lu',
  'ne', 'nw', 'ow', 'sg', 'sh', 'so', 'sz', 'tg', 'ti', 'ur', 'vd', 'vs',
  'zg', 'zh', 'gva', 'gt', 'country', 'region', 'canton', 'sede',
  'headquarter', 'headquarters', 'office', 'plant', 'site', 'standort',
  // `Worblaufen & Homeoffice` (SuccessFactors helsana): il suffisso di lavoro
  // ibrido non fa parte della località.
  'homeoffice',
]);
const SWISS_REGION_NAMES = new Set([
  'aargau', 'appenzell', 'basel', 'bern', 'fribourg', 'geneve', 'glarus',
  'graubunden', 'jura', 'luzern', 'neuchatel', 'nidwalden', 'obwalden',
  'schaffhausen', 'schwyz', 'solothurn', 'st gallen', 'thurgau', 'ticino',
  'uri', 'valais', 'vaud', 'zug', 'zurich',
]);
const SOURCE_LOCATION_PLACEHOLDERS = new Set([
  'location', 'locations', 'location s', 'search by location',
  'nach standort suchen', 'rechercher par lieu', 'rechercher par lieu district',
  'rechercher par lieu pays', 'nach ort bezirk suchen', 'country region',
  'where', 'lieu de travail', 'arbeitsort', 'dein kontakt',
  'labellocation locale',
]);
// `Switzerland, Remote` (Workday) dice COME si lavora, non DOVE: quando è
// l'unico contenuto oltre al paese non smentisce nessuna località pubblicata.
// Solo come valore intero: `Worblaufen, Remote` nomina ancora un luogo.
const SOURCE_LOCATION_TYPE_ONLY_TOKENS = new Set(['remote']);
const SOURCE_LOCATION_NON_TOPONYM_TOKENS = new Set([
  'any', 'available', 'eor', 'campus', 'location', 'locations', 'region',
  'regions', 'headquarter', 'headquarters', 'office', 'plant', 'site',
  'lpn', 'toi', 'pfi', 'wor', 'ati', 'hfr', 'hopital', 'hospital',
  'hospitals', 'spital', 'kantonsspital', 'fribourgeois', 'freiburger',
  'clinic', 'klinik', 'clinique', 'centre', 'center', 'zentrum',
  'university', 'universitat', 'universitaet',
]);
const SOURCE_LOCATION_REGION_LABELS = new Set([
  'sudostschweiz', 'southeast switzerland', 'suisse orientale',
  'svizzera orientale', 'ostschweiz', 'westschweiz', 'zentralschweiz',
  'nordwestschweiz',
]);

/**
 * Alias-resolved place tokens with the DIGITS kept. `canonicalLocationTokens`
 * drops them because a house number is not a locality, but a postal code is
 * exactly the per-vacancy evidence `namesPostalAddressedLocality` reads, so the
 * postal comparison needs the same spelling normalisation on a text that still
 * carries `8046`.
 */
function aliasedPlaceTokens(value) {
  return normalizePlace(value).split(' ').filter(Boolean)
    .map((token) => LOCATION_TOKEN_ALIASES.get(token) || token);
}

function canonicalLocationTokens(value) {
  const tokens = aliasedPlaceTokens(value)
    .filter((token) => !LOCATION_NOISE_TOKENS.has(token))
    .filter((token) => !/^\d+$/.test(token) && !/^(?:[a-z]\d+|\d+[a-z])$/.test(token));
  return tokens.filter((token, index) => index === 0 || token !== tokens[index - 1]);
}

function tokensEqual(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function endsWithTokens(value, suffix) {
  return suffix.length > 0 && suffix.length <= value.length
    && suffix.every((token, index) => value[value.length - suffix.length + index] === token);
}

function sharesPostalCodeAndLocality(published, source, publishedTokens, sourceTokens) {
  const publishedPostalCodes = String(published).match(/\b\d{4,5}\b/g) || [];
  const sourcePostalCodes = String(source).match(/\b\d{4,5}\b/g) || [];
  if (!sourcePostalCodes.some((code) => publishedPostalCodes.includes(code))) return false;
  const sourceLocalityTokens = sourceTokens.filter((token) => !SWISS_REGION_NAMES.has(token));
  return sourceLocalityTokens.length > 0
    && sourceLocalityTokens.every((token) => publishedTokens.includes(token));
}

function hasCoherentCantonSuffix(value, locality) {
  if (locality.length === 0 || value.length <= locality.length) return false;
  if (!locality.every((token, index) => value[index] === token)) return false;
  return SWISS_REGION_NAMES.has(value.slice(locality.length).join(' '));
}

function isExplicitForeignCountry(value) {
  const normalized = normalizePlace(value);
  if (!normalized) return false;
  if (SWISS_COUNTRY_LABELS.has(normalized)) return false;
  if (ISO_ALPHA2_COUNTRY_CODES.has(normalized.toUpperCase())) return normalized !== 'ch';
  return FOREIGN_COUNTRY_NAME_LABELS.has(normalized);
}

function isSwissCantonCodeInLocation(segment, value) {
  const code = normalizePlace(segment).toUpperCase();
  if (code === 'CH' || !/^[A-Z]{2}$/.test(code)
    || !LOCATION_NOISE_TOKENS.has(code.toLowerCase())) return false;
  const locationWithoutSegment = String(value || '').split(/[,;/|()]+/)
    .filter((part) => normalizePlace(part) !== normalizePlace(segment))
    .join(' ');
  return Boolean(swissMunicipalityKey(locationWithoutSegment))
    || canonicalLocationTokens(locationWithoutSegment).some((token) => SWISS_REGION_NAMES.has(token));
}

function hasExplicitForeignCountry(value, addressCountry = '') {
  if (isExplicitForeignCountry(addressCountry)) return true;
  const locationText = String(value || '');
  return locationText.split(/[,;/|()]+/)
    .map((segment) => segment.trim())
    .some((segment) => isExplicitForeignCountry(segment)
      && !isSwissCantonCodeInLocation(segment, locationText));
}

/**
 * Reject labels that are not a workplace while retaining real foreign places.
 * The audit must not require every valid place to be in the Swiss gazetteer:
 * `Cary`, `King of Prussia` and `Germany, Berlin` are valid contradictions.
 * Instead, clear ATS codes, generic region/organisation labels and values with
 * no geographic evidence become inconclusive; a known Swiss commune or an
 * explicitly foreign country keeps the observation authoritative.
 */
function isUsableSourceLocation(value, context = {}) {
  const normalized = normalizePlace(value);
  if (!normalized || SOURCE_LOCATION_PLACEHOLDERS.has(normalized)) return false;
  const tokens = canonicalLocationTokens(value);
  if (!tokens.some((token) => token.length >= 3)) return false;
  if (tokens.every((token) => SOURCE_LOCATION_TYPE_ONLY_TOKENS.has(token))) return false;
  const swissPlace = Boolean(swissMunicipalityKey(value));
  const foreignPlace = hasExplicitForeignCountry(value, context.addressCountry);
  if (SOURCE_LOCATION_REGION_LABELS.has(normalized)) return false;
  if (tokens.some((token) => SOURCE_LOCATION_NON_TOPONYM_TOKENS.has(token))
    && !swissPlace && !foreignPlace) return false;
  // A postal code is geographic evidence. Other digits in an ATS site code
  // (`TOI L 112`, `Cri-Mon25`, `Zür-Pfi51`) are not.
  if (/\d/.test(normalized) && !/\b\d{4,5}\b/.test(normalized)
    && !swissPlace && !foreignPlace) return false;
  if (tokens.every((token) => token.length <= 3) && !swissPlace && !foreignPlace) return false;
  return true;
}

/**
 * Name of the BFS municipality a free-text location resolves to, or `''`.
 *
 * This is the difference between "one value contains the other" — a predicate
 * that was tried, measured and reverted because it also accepted
 * `Fribourg` ⊂ `Freiburg im Breisgau` — and "both values name the same
 * commune". `findSwissCityInText` scans 3-, 2- and 1-word windows against the
 * 2'110 BFS municipalities plus their aliases, so `Selzach Bohnackerweg 1`
 * and `Baden 48 (Ärzte GAV & UA)` resolve to `selzach`/`baden` while a street,
 * a site code or a German city resolves to nothing. Canton labels are rejected
 * first, so `Basel-Landschaft` and `Appenzell Ausserrhoden` never collapse onto
 * the municipality whose name they begin with.
 */
function swissMunicipalityKey(value) {
  const text = plainText(value);
  if (!text) return '';
  if (!isCantonOnlyLabel(text)) {
    const found = findSwissCityInText(text);
    if (found) return normalizePlace(canonicalSwissCityName(found));
  }
  // Esonimi (`San Gallo`, `Zurigo`): il gazetteer BFS non li conosce, gli
  // alias sì. `San Gallo` è anche il nome italiano del cantone, lo stesso
  // omonimo città/cantone di `St. Gallen`: vale la città, come per la forma
  // tedesca. Solo come corrispondenza ESATTA del valore intero: una scansione
  // a finestre del testo aliasato rifarebbe `Freiburg im Breisgau` → Fribourg,
  // il falso positivo per cui il contenimento fu revertito.
  const aliased = aliasedPlaceTokens(text).join(' ');
  return aliased && aliased !== normalizePlace(text)
    && !isCantonOnlyLabel(aliased) && isKnownSwissMunicipality(aliased)
    ? normalizePlace(canonicalSwissCityName(aliased))
    : '';
}

/**
 * Resolve a municipality when the source appends a site/neighbourhood label
 * that is not itself in the BFS snapshot (`Carouge La Praille`). The exact
 * canton-only guard remains in force, so `Appenzell Ausserrhoden` cannot be
 * reduced to the municipality prefix `Appenzell`.
 */
function municipalityKeyWithDescriptor(value) {
  const text = plainText(value);
  if (!text) return '';
  // `isCantonOnlyLabel` deliberately treats bare ambiguous municipality names
  // such as Carouge as canton-like. An exact BFS municipality membership is
  // stronger evidence and is safe to use here.
  const exact = swissMunicipalityKey(text);
  if (exact) return exact;
  const exactCantons = swissMunicipalityCantons(text);
  if (isCantonOnlyLabel(text) && exactCantons.length === 0) return '';
  if (exactCantons.length > 0) return normalizePlace(canonicalSwissCityName(text));
  const words = text.split(/\s+/).filter(Boolean);
  for (let length = words.length - 1; length > 0; length -= 1) {
    const prefix = words.slice(0, length).join(' ');
    if (swissMunicipalityCantons(prefix).length > 0) {
      return normalizePlace(canonicalSwissCityName(prefix));
    }
  }
  return '';
}

/**
 * A source candidate that repeats the published locality is the trailing
 * region component — not the workplace — when an earlier candidate already
 * named a different commune: `Winterthur, Zürich` and `Lyss, Bern Grossraum`
 * are jobs in Winterthur and Lyss. A canton name in that earlier position is
 * not such a commune even though BFS also lists it as one, because Workday
 * writes the site group first: `Solothurn, Selzach Bohnackerweg 1` is Selzach.
 */
function precededByOtherLocality(sourceCandidates, sourceIndex, ownKey) {
  return sourceCandidates.slice(0, sourceIndex).some((earlier) => {
    const text = plainText(earlier);
    if (!text || SWISS_REGION_NAMES.has(canonicalLocationTokens(earlier).join(' '))) return false;
    const key = swissMunicipalityKey(earlier);
    // `isKnownSwissMunicipality` also answers for the 161 BFS names that exist
    // only in the disambiguated `<City> (XX)` form, whose bare spelling
    // `swissMunicipalityKey` cannot resolve. An earlier `Carouge` must still
    // demote a trailing `Genève`.
    return key ? key !== ownKey : isKnownSwissMunicipality(text);
  });
}

/**
 * Compare locality semantics rather than raw labels. Country/vendor prefixes,
 * postal addresses and the four Swiss language spellings are equivalent, but
 * a city is not allowed to match only the trailing canton component.
 */
export function sourceLocationMatches(published, source) {
  const left = canonicalLocationTokens(published);
  const right = canonicalLocationTokens(source);
  if (!left.length || !right.length) return false;
  if (tokensEqual(left, right)) return true;

  const publishedCandidates = plainText(published).split(/[|;,>:]+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const sourceCandidates = plainText(source).split(/[|;,>:]+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const publishedMunicipality = municipalityKeyWithDescriptor(published);
  for (const publishedCandidate of publishedCandidates) {
    const publishedTokens = canonicalLocationTokens(publishedCandidate);
    if (!publishedTokens.length) continue;
    for (let sourceIndex = 0; sourceIndex < sourceCandidates.length; sourceIndex++) {
      const rawSourceCandidate = sourceCandidates[sourceIndex];
      const sourceTokens = canonicalLocationTokens(rawSourceCandidate);
      if (!sourceTokens.length) continue;
      const publishedHasPostalCode = /\b\d{4,5}\b/.test(publishedCandidate);
      const candidateHasPostalCode = /\b\d{4,5}\b/.test(rawSourceCandidate);
      const sourceMunicipality = municipalityKeyWithDescriptor(rawSourceCandidate);
      const trailingRegion = sourceIndex > 0 && !candidateHasPostalCode
        && precededByOtherLocality(sourceCandidates, sourceIndex, sourceMunicipality);
      // In structured `city, canton` values, a published city must not pass only
      // because it equals the trailing canton (Zürich vs Winterthur, Zürich).
      // A canton name that no earlier candidate contradicts is the locality
      // itself, so `CHE, Zürich, Bahnhofstrasse 20` still matches `Zürich`.
      if (sourceIndex > 0 && tokensEqual(sourceTokens, publishedTokens)
        && !candidateHasPostalCode && SWISS_REGION_NAMES.has(publishedTokens.join(' '))
        && trailingRegion) continue;
      if (publishedMunicipality && publishedMunicipality === sourceMunicipality
        && !trailingRegion) return true;
      if (tokensEqual(sourceTokens, publishedTokens)) return true;
      if (candidateHasPostalCode && endsWithTokens(sourceTokens, publishedTokens)) return true;
      if (publishedHasPostalCode && endsWithTokens(publishedTokens, sourceTokens)) return true;
      if (candidateHasPostalCode && publishedHasPostalCode
        && sharesPostalCodeAndLocality(publishedCandidate, rawSourceCandidate, publishedTokens, sourceTokens)) return true;
      if (hasCoherentCantonSuffix(sourceTokens, publishedTokens)
        || hasCoherentCantonSuffix(publishedTokens, sourceTokens)) return true;
    }
  }
  return false;
}

const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const JOB_LOCATION_CLASS_TOKENS = new Set([
  'job-location', 'job_location', 'job-detail-location', 'job_detail_location',
  'job-region', 'job_region', 'job-detail-region', 'job_detail_region',
  'vacancy-location', 'vacancy_location', 'vacancy-detail-location', 'vacancy_detail_location',
  'vacancy-region', 'vacancy_region', 'vacancy-detail-region', 'vacancy_detail_region',
]);
const JOB_DETAIL_SCOPE_CLASS_TOKENS = new Set([
  'job-detail', 'job_detail', 'job-details', 'job_details', 'job-posting', 'job_posting',
  'vacancy-detail', 'vacancy_detail', 'vacancy-details', 'vacancy_details',
  'vacancy-posting', 'vacancy_posting',
]);
const NON_CURRENT_JOB_SCOPE_CLASS_TOKENS = new Set([
  'job-search-results', 'job_search_results', 'vacancy-search-results', 'vacancy_search_results',
  'related-card', 'related_card', 'job-related-card', 'job_related_card',
  'vacancy-related-card', 'vacancy_related_card', 'job-recommendations', 'job_recommendations',
  'vacancy-recommendations', 'vacancy_recommendations', 'job-card', 'job_card',
  'vacancy-card', 'vacancy_card',
]);

function classTokens(attrs) {
  return [readAttr(attrs, 'class'), readAttr(attrs, 'id')]
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
}

function hasJobScope(attrs) {
  if (/\bJobPosting\b/i.test(readAttr(attrs, 'itemtype'))) return true;
  return classTokens(attrs).some((token) => JOB_DETAIL_SCOPE_CLASS_TOKENS.has(token.toLowerCase()));
}

function hasJobLocationClass(attrs) {
  return classTokens(attrs).some((token) => JOB_LOCATION_CLASS_TOKENS.has(token.toLowerCase()));
}

function hasNonCurrentJobScope(attrs) {
  return classTokens(attrs).some((token) => NON_CURRENT_JOB_SCOPE_CLASS_TOKENS.has(token.toLowerCase()));
}

function elementValue(html, openTagEnd, tagName, attrs) {
  const content = readAttr(attrs, 'content');
  if (content) return plainText(content);
  const closingTag = new RegExp(`</${tagName}\\s*>`, 'ig');
  closingTag.lastIndex = openTagEnd;
  const closing = closingTag.exec(html);
  if (!closing || closing.index - openTagEnd > 1000) return '';
  return plainText(html.slice(openTagEnd, closing.index));
}

function emptyLocationEvidenceCounts() {
  return { jsonld: 0, 'strong-markup': 0 };
}

function addLocationEvidenceCounts(target, counts = {}) {
  for (const evidence of ['jsonld', 'strong-markup']) {
    const value = Number(counts[evidence]);
    if (Number.isFinite(value)) target[evidence] += value;
  }
}

function withLocationEvidenceCounts(observation, beforeGate, afterGate, includeDiagnostics) {
  if (!includeDiagnostics) return observation;
  return {
    ...observation,
    locationEvidenceCounts: { beforeGate, afterGate },
  };
}

/**
 * Return a location only together with the markup scope that makes it
 * authoritative. This prevents a generic footer `addressLocality` from being
 * promoted merely because a different job-scoped location exists later.
 */
export function extractSourceLocationObservation(html = '', pageUrl = '', {
  includeDiagnostics = false,
  recordUrl = '',
} = {}) {
  const allStructuredItems = extractJsonLd(html, pageUrl);
  const renderedTitle = plainText(/<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(html)?.[1] || '');
  const structuredItems = recordUrl
    ? selectDetailStructuredRecords(allStructuredItems, pageUrl, renderedTitle, recordUrl)
    : allStructuredItems;
  const recordIdentityUnresolved = Boolean(recordUrl)
    && allStructuredItems.length > 1
    && structuredItems.length === 0;
  const rawStructuredCandidates = structuredItems
    .flatMap((item) => item.locationCandidates || [])
    .filter((candidate) => plainText(candidate.location));
  const structuredCandidates = rawStructuredCandidates
    .filter((candidate) => isUsableSourceLocation(candidate.location, candidate));
  const structuredBeforeGate = emptyLocationEvidenceCounts();
  const structuredAfterGate = emptyLocationEvidenceCounts();
  structuredBeforeGate.jsonld = Number(rawStructuredCandidates.length > 0);
  structuredAfterGate.jsonld = Number(structuredCandidates.length > 0);
  // A JobPosting may list a foreign tenant/primary office first and the Swiss
  // workplace in a later location. This audit runs on a Swiss corpus: prefer a
  // candidate that independently resolves to Swiss geography, while retaining
  // the first authoritative candidate for foreign-only postings so a bad
  // Swiss default still remains visible.
  const structured = structuredCandidates.find((candidate) => (
    resolveSourceBackedSwissGeography(candidate)
  )) || structuredCandidates.at(0);
  if (structured) {
    return withLocationEvidenceCounts(
      { location: structured.location, evidence: 'jsonld' },
      structuredBeforeGate,
      structuredAfterGate,
      includeDiagnostics,
    );
  }

  // A shared listing/detail response may contain authoritative markup for more
  // than one vacancy. Once the requested row cannot be matched, the remaining
  // DOM is page-wide evidence and must not be attributed to that row.
  if (recordIdentityUnresolved) {
    return withLocationEvidenceCounts(
      { location: '', evidence: 'generic' },
      { jsonld: Number(rawStructuredCandidates.length > 0), 'strong-markup': 0 },
      { jsonld: 0, 'strong-markup': 0 },
      includeDiagnostics,
    );
  }

  const stack = [];
  const domBeforeGate = emptyLocationEvidenceCounts();
  const domAfterGate = emptyLocationEvidenceCounts();
  const tagRx = /<(\/?)\s*([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let match;
  while ((match = tagRx.exec(html))) {
    const [, closing, rawTagName, attrs] = match;
    const tagName = rawTagName.toLowerCase();
    if (closing) {
      const matchingIndex = stack.map((item) => item.tagName).lastIndexOf(tagName);
      if (matchingIndex >= 0) stack.length = matchingIndex;
      continue;
    }

    const blocked = Boolean(stack.at(-1)?.blocked) || hasNonCurrentJobScope(attrs);
    const jobScoped = !blocked && (Boolean(stack.at(-1)?.jobScoped) || hasJobScope(attrs));
    const itemprops = readAttr(attrs, 'itemprop').split(/\s+/);
    if (!blocked && (hasJobLocationClass(attrs) || (jobScoped && itemprops.includes('addressLocality')))) {
      const location = elementValue(html, tagRx.lastIndex, tagName, attrs);
      if (location) {
        domBeforeGate['strong-markup'] = 1;
        if (isUsableSourceLocation(location)) {
          domAfterGate['strong-markup'] = 1;
          return withLocationEvidenceCounts(
            { location, evidence: 'strong-markup' },
            {
              jsonld: structuredBeforeGate.jsonld,
              'strong-markup': domBeforeGate['strong-markup'],
            },
            { ...structuredAfterGate, 'strong-markup': domAfterGate['strong-markup'] },
            includeDiagnostics,
          );
        }
      }
    }

    if (!VOID_HTML_TAGS.has(tagName) && !/\/\s*$/.test(attrs)) stack.push({ tagName, jobScoped, blocked });
  }
  return withLocationEvidenceCounts(
    { location: '', evidence: 'generic' },
    {
      jsonld: structuredBeforeGate.jsonld,
      'strong-markup': domBeforeGate['strong-markup'],
    },
    {
      jsonld: structuredAfterGate.jsonld,
      'strong-markup': domAfterGate['strong-markup'],
    },
    includeDiagnostics,
  );
}

/**
 * A generic `.location` class is common in navigation/search chrome and is not
 * evidence that a published job location is wrong. Contradictions are
 * authoritative only when the page supplies JobPosting JSON-LD or explicitly
 * job/vacancy-scoped location markup; generic observations remain visible in
 * sourceDetailSummary as inconclusive.
 */
export function classifySourceLocationEvidence(html = '', pageUrl = '') {
  return extractSourceLocationObservation(html, pageUrl).evidence;
}

function sourceDescription(job) {
  return job?.descriptionByLocale?.[job?.sourceLang] || job?.description || '';
}

function wordSet(value) {
  return new Set(normalizePlace(value).split(' ').filter((word) => word.length >= 4));
}

/**
 * A postal code immediately followed by the published locality is per-vacancy
 * geography, not a generic fallback: `8046 Zürich` is an address this vacancy
 * states, while `Zürich` alone is also the canton. Normalisation leaves only
 * `[a-z0-9 ]`, so the locality is safe to inline in the pattern.
 *
 * Both sides are compared as ALIAS-RESOLVED tokens, not as the raw normalised
 * strings: the published value is the Italian exonym on the Italian site
 * (`Zurigo`, `Ginevra`, `Berna`) while the page that carries the address is
 * written in German or French, so `8046 Zürich` never spells the published
 * name and the corroboration never fired on a whole language region — a false
 * mismatch that hid the real ones (#7772).
 */
function namesPostalAddressedLocality(value, publishedTokens) {
  if (!publishedTokens.length) return false;
  const haystack = aliasedPlaceTokens(value).join(' ');
  return new RegExp(`(?:^| )\\d{4} ${publishedTokens.join(' ')}(?: |$)`).test(haystack);
}

function structuredAddressIsCoherent(candidate) {
  const postalCode = plainText(candidate?.postalCode || '');
  const localityTokens = canonicalLocationTokens(candidate?.addressLocality || '');
  if (!/^\d{4}$/.test(postalCode) || !localityTokens.length) return false;

  // Some extractors keep the postal code only in `postalCode`, while others
  // repeat it in `location`. When the combined address carries that evidence,
  // require the postal code to sit next to the SAME locality; otherwise an
  // organisation address and a workplace locality can be fused into one
  // apparently valid candidate (#7866). A bare locality plus a separate
  // postalCode field remains valid because there is no contradictory text to
  // inspect (for example `location: 'Zug', postalCode: '6300'`).
  const addressText = [candidate?.location, candidate?.streetAddress]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
  if (!addressText || !/\b\d{4}\b/.test(normalizePlace(addressText))) return true;
  return namesPostalAddressedLocality(addressText, localityTokens);
}

/**
 * The same per-vacancy evidence read off a structured address instead of the
 * prose: a candidate that carries BOTH a postal code and an `addressLocality`
 * resolving to the published BFS municipality states a commune, not a region.
 * A canton that is not a municipality (`Aargau`, `Argovia`) has no BFS key, so
 * it can never be corroborated this way.
 */
function structuredAddressNamesLocality(detail, publishedLocation) {
  const publishedMunicipality = swissMunicipalityKey(publishedLocation);
  if (!publishedMunicipality) return false;
  const candidates = Array.isArray(detail?.locationCandidates) ? detail.locationCandidates : [];
  return candidates.some((candidate) => structuredAddressIsCoherent(candidate)
    && /\b\d{4}\b/.test(plainText(candidate?.postalCode || ''))
    && swissMunicipalityKey(candidate?.addressLocality || '') === publishedMunicipality);
}

/**
 * A structured JobPosting address can use a hamlet, neighbourhood or historical
 * locality that is not in the current BFS municipality list. When its exact
 * postal code is also present in the published location, the page still gives
 * per-vacancy evidence for the same Swiss postal area. Keep this narrower than
 * a free-text alias: only the structured `jobLocation` candidate is eligible.
 */
function structuredAddressSharesPublishedPostalCode(detail, publishedLocation) {
  const publishedPostalCodes = new Set(
    plainText(publishedLocation).match(/\b\d{4}\b/g) || [],
  );
  if (!publishedPostalCodes.size) return false;
  const candidates = Array.isArray(detail?.locationCandidates) ? detail.locationCandidates : [];
  return candidates.some((candidate) => {
    const sourcePostalCode = plainText(candidate?.postalCode || '').match(/\b\d{4}\b/)?.[0];
    return structuredAddressIsCoherent(candidate)
      && Boolean(sourcePostalCode && publishedPostalCodes.has(sourcePostalCode));
  });
}

/**
 * `jobLocation` in an ATS JSON-LD is not always the workplace: on the postings
 * an organisation publishes on behalf of another one it carries the POSTING
 * organisation's seat, constant across vacancies that are worked in different
 * towns. Measured on run 33953283741 (2026-09-05): `jobs.fenaco.com` declares
 * fenaco's `Erlachstrasse 5, 3001 Bern` for a Volg shop whose own detail-page
 * text reads «Die LANDI Wetzikon-Seegräben …», `jobs.coopjobs.ch` declares
 * Coop's `Reservatstrasse 1-3, 8953 Dietikon` for a store in Bern and one in
 * Baden-Dättwil alike, and `jobs.admin.ch` declares Wädenswil for an Agroscope
 * vacancy whose own page states `Arbeitsort: Reckenholzstrasse 191, 8046
 * Zürich`. In all three the PUBLISHED value is the real workplace and the
 * JSON-LD field is a second, different field of the same page — so the
 * comparison observes a disagreement inside the source, not a parser defect,
 * and reporting it as one asks the crawler to publish the tenant's address for
 * every branch (178 `jumbo` and 553 `volg-fenaco` records, issue #7348).
 *
 * The published value is therefore taken as authoritative exactly when the
 * SAME authoritative page names it in the vacancy's own title or description.
 * That is per-vacancy evidence read off the source, not a crawler exemption:
 * it used to be gated on a hand-kept list of one crawler (`kanton-zuerich`),
 * which left every other ATS with the same behaviour permanently red.
 *
 * Two deliberate limits keep it from swallowing the defects the check exists
 * to raise. A bare canton/region name is never corroborated OUT OF PROSE,
 * because that is precisely the generic fallback shape (`swisslog` publishing
 * `Argovia`) — it is corroborated by a postal address or a structured address
 * field that spells it, which is per-vacancy geography and not a fallback.
 * That distinction is what the guard owes the fourteen region names BFS also
 * lists as municipalities (`Bern`, `Zug`, `Basel`, `Zürich`, `Luzern`…, issue
 * #7713): refusing the published value on the region set alone made the cities
 * with the most volume in the dataset un-corroborable BY CONSTRUCTION, even
 * when the page states `3011 Bern` as this vacancy's own workplace. The
 * evidence is therefore weighed BEFORE the region guard, and only a canton
 * that no page ties to a postal address or a BFS locality — the fallback shape
 * the check exists to raise — still falls through it.
 * And only JSON-LD contradictions are eligible: job-scoped
 * rendered markup IS a workplace declaration, so a disagreement with it stays
 * a finding.
 */
export function sourceCorroboratesPublishedLocation(detail, publishedLocation, {
  fields = ['title', 'description'],
} = {}) {
  const normalizedLocation = normalizePlace(publishedLocation);
  if (normalizedLocation.length < 3) return false;
  // The workplace is not always in the prose: the federal portal renders it as
  // a labelled field (`Arbeitsort: Reckenholzstrasse 191, 8046 Zürich`) that
  // neither the title nor the description contains, so the corroboration the
  // page actually offers was unreadable here (#7711). The bare label stays in
  // SOURCE_LOCATION_PLACEHOLDERS — it is the VALUE that is evidence.
  const workplaceLabels = Array.isArray(detail?.workplaceLabels) ? detail.workplaceLabels : [];
  // Postal evidence settles the canton/city homonym the region guard below
  // refuses on prose alone: `Zürich` is a canton, and it is equally the city at
  // `8046 Zürich` that this vacancy states as its own workplace. It is read
  // from every authoritative per-vacancy text of the page, not only from the
  // labelled workplace field — `3011 Bern` in the vacancy's own title or body
  // is the same statement, and restricting it to the label left the homonym
  // cities red on every ATS that has no such field (#7713).
  const publishedTokens = canonicalLocationTokens(publishedLocation);
  const firstPublishedComponent = plainText(publishedLocation).split(',')[0]?.trim() || '';
  const publishedLocalityTokens = swissMunicipalityKey(firstPublishedComponent)
    ? canonicalLocationTokens(firstPublishedComponent)
    : publishedTokens;
  const sourceEvidenceTexts = workplaceLabels.length > 0
    ? workplaceLabels
    : fields.map((field) => detail?.[field] || '');
  const postalAddressed = sourceEvidenceTexts
    .some((value) => namesPostalAddressedLocality(value, publishedLocalityTokens));
  if (postalAddressed) return true;
  if (structuredAddressNamesLocality(detail, publishedLocation)) return true;
  // Canonical tokens, not the raw string: `Argovia` and `Aargau` are the same
  // canton, and only one of the two spellings is in the region set.
  if (SWISS_REGION_NAMES.has(publishedTokens.join(' '))) return false;
  if (!publishedTokens.length) return false;
  // Same alias resolution as the postal branch: the prose of a German or
  // French page names `Freiburg`/`Bienne` for a value published as `Fribourg`
  // or `Biel`, and comparing the raw normalised strings missed it.
  const haystack = aliasedPlaceTokens(sourceEvidenceTexts.join(' ')).join(' ');
  if (!haystack) return false;
  return ` ${haystack} `.includes(` ${publishedTokens.join(' ')} `);
}

/**
 * A structured location and an independent visible workplace can both be
 * authoritative while disagreeing: ATS templates often stamp the employer's
 * registered address into JSON-LD/microdata and render the vacancy workplace
 * separately. Such a page contradicts itself; it cannot prove a crawler
 * mismatch. Keep the check general and evidence-based, rather than teaching
 * it one employer key.
 */
function visibleFieldMatchesLocation(field, location) {
  const value = plainText(field);
  const targetTokens = canonicalLocationTokens(location);
  if (!value || !targetTokens.length) return false;
  if (sourceLocationMatches(location, value)) return true;
  const haystack = ` ${aliasedPlaceTokens(value).join(' ')} `;
  return haystack.includes(` ${targetTokens.join(' ')} `);
}

function sourceHasInternalLocationConflict(detail, publishedLocation, sourceLocation, locationEvidence) {
  if (!['jsonld', 'strong-markup'].includes(locationEvidence)
    || !isUsableSourceLocation(sourceLocation)
    || !publishedLocation) return false;
  const visibleFields = [
    ...(Array.isArray(detail?.workplaceLabels) ? detail.workplaceLabels : []),
    ...(Array.isArray(detail?.headingSublineFields) ? detail.headingSublineFields : []),
    detail?.title,
  ].filter(Boolean);
  const visibleMatchesPublished = visibleFields.some((field) => (
    visibleFieldMatchesLocation(field, publishedLocation)
  ));
  if (!visibleMatchesPublished) return false;
  const visibleMatchesStructured = visibleFields.some((field) => (
    visibleFieldMatchesLocation(field, sourceLocation)
  ));
  return !visibleMatchesStructured;
}

/**
 * Località primaria di una vacancy Workday letta dal suo URL pubblico.
 *
 * Il JSON-LD delle pagine Workday riporta `jobRequisitionLocation`, cioè
 * l'unità organizzativa della richiesta (`CHE-BE Bern`, `GA Glarus-Rheintal`),
 * non il luogo di lavoro: misurato il 2026-09-24 su medtronic (primaria
 * `Luzern, Luzern, Switzerland`, JSON-LD `CHE-BE Bern`) e swiss-life (primaria
 * `Buchs SG`, JSON-LD `GA Glarus-Rheintal`). Il luogo primario Workday è
 * invece nel percorso stesso che Workday genera per la vacancy,
 * `/job/{PrimaryLocation}/{slug}_{req}`: dato per-vacancy della fonte, non
 * un'inferenza del crawler dalla prosa.
 */
export function workdayPrimaryLocationFromUrl(rawUrl = '') {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return ''; }
  if (!/(?:^|\.)myworkdayjobs\.com$/i.test(url.hostname)) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  const jobIndex = parts.findIndex((part) => part.toLowerCase() === 'job');
  // Serve anche il segmento dello slug dopo la località: `/job/{slug}` da solo
  // non porta nessuna località.
  if (jobIndex < 0 || parts.length < jobIndex + 3) return '';
  let segment = parts[jobIndex + 1];
  try { segment = decodeURIComponent(segment); } catch { /* segmento già in chiaro */ }
  return segment.replace(/-+/g, ' ').trim();
}

/**
 * Campi della riga subito sotto il titolo della vacancy (`Oensingen,
 * 01.06.2027, 100%` su jobs.sbb.ch, `Gérance <br> Genève | Taux…` su
 * jobs.livit.ch). Su questi template il JSON-LD dichiara la sede dell'azienda
 * (Hilfikerstrasse 1, 3000 Bern; Altstetterstrasse 124, 8048 Zürich) per ogni
 * vacancy, mentre la località della vacancy è un campo della riga di titolo.
 * Solo se l'H1 è il titolo della vacancy e il campo è breve: una tagline del
 * sito non è un campo della vacancy.
 */
export function vacancyHeadingSublineFields(html = '', vacancyTitle = '') {
  const source = String(html || '');
  const title = normalizePlace(vacancyTitle);
  if (!title) return [];
  const fields = [];
  // Ogni H1 col titolo della vacancy: jobs.sbb.ch lo ripete nell'header
  // sticky prima del blocco titolo che porta la riga della località.
  const headingRx = /<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/gi;
  let heading;
  while ((heading = headingRx.exec(source))) {
    const headingText = normalizePlace(heading[1]);
    if (!headingText || !(headingText.includes(title) || title.includes(headingText))) continue;
    const after = source.slice(headingRx.lastIndex, headingRx.lastIndex + 1500);
    const next = /^\s*<(div|p|h2|h3|span)\b[^>]*>([\s\S]{0,600}?)<\/\1>/i.exec(after);
    if (!next) continue;
    fields.push(...plainText(next[2].replace(/<br\s*\/?>/gi, ' | '))
      .split(/\s*[|,;·•]\s*/)
      .map((field) => field.trim())
      .filter((field) => field && field.length <= 60));
  }
  return fields;
}

/**
 * Una fonte che dice solo il cantone (`Graubünden`, Workday capri-holdings)
 * non può smentire un comune di quel cantone (`Landquart`, lo store «MK
 * Landquart» della stessa vacancy): è meno precisa, non contraria. Resta
 * un'osservazione inconcludente; un comune di un ALTRO cantone resta invece
 * una contraddizione autorevole.
 */
function sourceIsCoarserCantonOfPublished(published, source) {
  const sourceText = plainText(source);
  if (!sourceText || !isCantonOnlyLabel(sourceText)) return false;
  const canton = normalizeCantonCode(sourceText);
  if (!canton) return false;
  const locality = plainText(published).split(',')[0]?.trim() || '';
  return swissMunicipalityCantons(locality).includes(canton);
}

/**
 * Plain text of the source description without the `- ` markers the
 * extractor writes for list items. `extractDetailFields` keeps a vacancy's
 * lists as `- item` lines (so the crawlers that publish its text keep them);
 * those markers are formatting it adds, not text of the source, and counted
 * as characters they grew a source with 50 list items by 100 characters and
 * moved the length ratio of every published text measured against it. The
 * published side is measured exactly as before.
 */
function sourceContentText(value) {
  return plainText(value)
    .replace(/(^|\s)-(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A detail page may publish two source-language bodies separated by an
 * explicit `***` marker (for example a bilingual FR/DE HES-SO ad). The
 * rendered extractor quite correctly sees one page, but the crawler's
 * source-locale slot contains one of those bodies. Compare against the block
 * that materially overlaps the published source text, and only do so when two
 * substantive blocks make that interpretation unambiguous. Thin heading/title
 * fragments around the marker are ignored; unrelated pages remain measured as
 * one source document.
 */
function comparableSourceDescription(value, publishedDescription) {
  const source = sourceContentText(value);
  const blocks = source
    .split(/\*{3,}/)
    .map((block) => sourceContentText(block))
    .filter((block) => block.length >= COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS);
  if (blocks.length < 2) return source;

  const publishedWords = wordSet(publishedDescription);
  if (!publishedWords.size) return source;
  const ranked = blocks.map((block) => {
    const blockWords = wordSet(block);
    let overlap = 0;
    for (const word of publishedWords) if (blockWords.has(word)) overlap += 1;
    const denominator = Math.min(publishedWords.size, blockWords.size);
    return { block, overlap, score: denominator ? overlap / denominator : 0 };
  }).sort((a, b) => b.score - a.score || b.overlap - a.overlap);
  const [best, runnerUp] = ranked;
  if (!best || !runnerUp || best.overlap < 10 || best.score < 0.35 || best.score - runnerUp.score < 0.1) {
    return source;
  }
  return best.block;
}

export function compareSourceDetail(job, detail, {
  locationEvidence = 'jsonld',
  crawlerKey = job?.crawlerKey,
} = {}) {
  const publishedLocation = job?.addressLocality || job?.location || '';
  const sourceLocation = detail?.location || '';
  const publishedDescription = plainText(sourceDescription(job));
  const sourceDescriptionText = comparableSourceDescription(detail?.description || '', publishedDescription);
  const publishedWords = wordSet(publishedDescription);
  const sourceWords = wordSet(sourceDescriptionText);
  let overlap = 0;
  for (const word of publishedWords) if (sourceWords.has(word)) overlap++;
  const locationFromVacancyText = isLocationDerivedFromVacancyText(job);
  const corroborationFields = locationFromVacancyText
    ? ['title']
    : ['title', 'description'];
  // Campi per-vacancy della stessa fonte che il JSON-LD (sede dell'azienda o
  // unità organizzativa) non riporta: il luogo primario nel percorso Workday e
  // la riga sotto il titolo. Come la corroborazione da titolo/descrizione,
  // valgono solo contro il JSON-LD; un markup job-scoped resta una
  // dichiarazione del luogo di lavoro.
  const workdayPrimaryLocation = locationEvidence === 'jsonld'
    ? workdayPrimaryLocationFromUrl(job?.url)
    : '';
  const headingFields = locationEvidence === 'jsonld' && !locationFromVacancyText
    && Array.isArray(detail?.headingSublineFields)
    ? detail.headingSublineFields
    : [];
  const publishedCorroboratedBySource = locationEvidence === 'jsonld'
    && (sourceCorroboratesPublishedLocation(detail, publishedLocation, {
      fields: corroborationFields,
    })
      || Boolean(workdayPrimaryLocation && sourceLocationMatches(publishedLocation, workdayPrimaryLocation))
      || headingFields.some((field) => sourceLocationMatches(publishedLocation, field)));
  const sourceFieldsAgree = sourceLocationMatches(publishedLocation, sourceLocation);
  const sourceCoarserCanton = !sourceFieldsAgree && !publishedCorroboratedBySource
    && sourceIsCoarserCantonOfPublished(publishedLocation, sourceLocation);
  const structuredPostalCodeAgrees = !sourceFieldsAgree
    && structuredAddressSharesPublishedPostalCode(detail, publishedLocation);
  const locationMatchesPublished = sourceFieldsAgree
    || structuredPostalCodeAgrees
    || publishedCorroboratedBySource;
  const sourceInternalLocationConflict = sourceHasInternalLocationConflict(
    detail,
    publishedLocation,
    sourceLocation,
    locationEvidence,
  );
  const circularCorroboration = !sourceFieldsAgree
    && !structuredPostalCodeAgrees
    && !publishedCorroboratedBySource
    && locationEvidence === 'jsonld'
    && locationFromVacancyText
    && sourceCorroboratesPublishedLocation(detail, publishedLocation);
  const locationChecked = Boolean(publishedLocation)
    && isUsableSourceLocation(sourceLocation)
    && locationEvidence !== 'generic'
    && !circularCorroboration
    && !sourceCoarserCanton
    && !sourceInternalLocationConflict;
  const foreignMistralLocation = crawlerKey === 'mistral-ai'
    && locationChecked
    && hasExplicitForeignCountry(sourceLocation, detail?.addressCountry);
  // Mistral's structured source declares a foreign primary office while the
  // Swiss publication remains intentional. Keep this as an inconclusive
  // observation in the replay payload, and scope it by both crawler and
  // explicit country evidence so no other crawler or mismatch is exempted.
  const observation = {
    location: {
      checked: locationChecked && !foreignMistralLocation,
      matchesPublished: locationMatchesPublished,
      inconclusive: Boolean(sourceLocation) && (!locationChecked || foreignMistralLocation),
      evidence: locationEvidence,
      authority: circularCorroboration
        ? 'circular'
        : sourceInternalLocationConflict
          ? 'source-internal-conflict'
        : foreignMistralLocation
          ? 'foreign-source-exempt'
          : (publishedCorroboratedBySource ? 'source-corroborated' : 'source-detail'),
      published: publishedLocation,
      source: sourceLocation,
    },
    description: {
      publishedDescriptionLength: publishedDescription.length,
      sourceDescriptionLength: sourceDescriptionText.length,
      publishedWordCount: publishedWords.size,
      sourceWordCount: sourceWords.size,
      overlapWordCount: overlap,
    },
  };
  const classified = classifySourceDetailObservation(observation);
  return { ...classified, replayObservation: observation };
}

function sanitizeProcessingError(error) {
  const name = String(error?.name || 'Error').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'Error';
  const message = String(error?.message || error || 'source detail processing failed')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/(?:\/[a-z0-9._~-]+){2,}/gi, '[path]')
    .replace(/\b(token|secret|password|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `${name}: ${message || 'source detail processing failed'}`;
}

function processingFailureResult(item, error) {
  return {
    ...item,
    processingFailed: true,
    processingError: sanitizeProcessingError(error),
  };
}

function sourceDetailReportReference(value) {
  if (/^sha256:[a-f0-9]{64}$/.test(String(value))) return String(value);
  try {
    const parsed = new URL(String(value));
    if (!/^https?:$/.test(parsed.protocol)) return '[source-url]';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[source-url]';
  }
}

/**
 * Words with which a page names a PDF as its job advertisement. Vocabulary of
 * the document, not of any one site: gemeinde-st-moritz links
 * «Stelleninserat herunterladen» (…/stellenausschreibungen/…pdf) next to two
 * «Download PDF» links to vote results that are not the vacancy.
 */
const VACANCY_DOCUMENT_WORDS = /stelleninserat|inserat|stellenausschreibung|ausschreibung|stellenbeschrieb|stellenbeschreibung|stellenangebot|jobbeschreibung|job[\s_-]*(?:ad|description|offer)|vacanc|annonce|offre[\s_-]+d[’']?emploi|mise[\s_-]+au[\s_-]+concours|bando|concorso|annuncio/i;
const MAX_VACANCY_PDF_BYTES = 10 * 1024 * 1024;

function isPdfReference(value = '') {
  return /\.pdf(?:[?#]|$)/i.test(String(value));
}

/**
 * The PDF a detail page presents as its vacancy, or null. Either the page
 * EMBEDS it as its content (`iframe`/`embed` src, `object` data — csvm-mustair
 * shows the ad in an iframe and nothing else), or a link names it the job ad
 * in its text, title, aria-label or path. Any other PDF on the page (price
 * lists, vote results, privacy notices) is not the vacancy and is ignored.
 *
 * @returns {{ url: string, embedded: boolean } | null}
 */
export function vacancyPdfLink(html = '', pageUrl = '') {
  const source = String(html || '');
  const resolve = (reference) => {
    try {
      const url = new URL(decodeScrapedHtmlEntities(reference).trim(), pageUrl);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  };
  for (const match of source.matchAll(/<(iframe|embed|object)\b[^>]*>/gi)) {
    const reference = readAttr(match[0], match[1].toLowerCase() === 'object' ? 'data' : 'src');
    if (reference && isPdfReference(reference)) {
      const url = resolve(reference);
      if (url) return { url, embedded: true };
    }
  }
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const opening = `<a${match[1]}>`;
    const href = readAttr(opening, 'href');
    if (!href || !isPdfReference(href)) continue;
    let pathLabel = '';
    try { pathLabel = decodeURIComponent(new URL(decodeScrapedHtmlEntities(href), pageUrl).pathname); } catch { pathLabel = href; }
    const label = [plainText(match[2]), readAttr(opening, 'title'), readAttr(opening, 'aria-label'), pathLabel].join(' ');
    if (VACANCY_DOCUMENT_WORDS.test(label)) {
      const url = resolve(href);
      if (url) return { url, embedded: false };
    }
  }
  return null;
}

const PDF_SIGNATURE = '%PDF-';
const PDF_BASE64_PREFIX = Buffer.from(PDF_SIGNATURE, 'latin1').toString('base64').slice(0, 6);

/**
 * `politeFetch` reads every body as text, which mangles PDF bytes. This
 * transport keeps its URL policy, robots, throttle and redirects (it is the
 * `fetchImpl` politeFetch calls for each hop) and decides on the BYTES, not
 * on the headers or the URL: a body that starts with `%PDF-` comes back as
 * base64, anything else — robots.txt, an HTML error page — as UTF-8 text.
 * Neither the final Content-Type nor the final path is evidence: a `.pdf`
 * link that redirects to `/download?id=…` served as
 * `application/octet-stream` is still the PDF.
 */
export function createPdfSafeFetch(baseFetch = undiciFetch) {
  return async function pdfSafeFetch(url, init) {
    const response = await baseFetch(url, init);
    if (response.status >= 300 && response.status < 400) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    const isPdf = bytes.subarray(0, PDF_SIGNATURE.length).toString('latin1') === PDF_SIGNATURE;
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      headers: response.headers,
      body: null,
      text: async () => (isPdf ? bytes.toString('base64') : bytes.toString('utf8')),
    };
  };
}

/**
 * Text of the vacancy PDF, fetched through the same politeFetch contract as
 * the page. `baseFetch` and `extractTextImpl` exist for tests.
 */
export async function fetchVacancyPdfText(pdfUrl, {
  fetchPage = politeFetch,
  baseFetch = undiciFetch,
  extractTextImpl,
} = {}) {
  const fetched = await fetchPage(pdfUrl, {
    timeoutMs: 20000,
    retries: 1,
    accept: 'application/pdf,*/*;q=0.8',
    fetchImpl: createPdfSafeFetch(baseFetch),
  });
  if (!fetched?.ok || !fetched.body) {
    const refusal = fetched?.blockedByRobots ? 'robots.txt disallows it' : fetched?.policyBlocked ? 'fetch policy refused it' : `status ${fetched?.status || 0}`;
    return { text: '', error: refusal };
  }
  if (!String(fetched.body).startsWith(PDF_BASE64_PREFIX)) return { text: '', error: 'not a pdf' };
  const bytes = Buffer.from(fetched.body, 'base64');
  if (bytes.length > MAX_VACANCY_PDF_BYTES) return { text: '', error: 'pdf too large' };
  if (bytes.subarray(0, PDF_SIGNATURE.length).toString('latin1') !== PDF_SIGNATURE) return { text: '', error: 'not a pdf' };
  const extracted = await extractPdfJobContentFromUrl(pdfUrl, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
    ...(extractTextImpl ? { extractTextImpl } : {}),
  });
  return {
    text: extracted.text || '',
    bodySha256: createHash('sha256').update(bytes).digest('hex'),
    ...(extracted.error ? { error: extracted.error } : {}),
  };
}

/**
 * A page that presents its vacancy as a PDF carries only a teaser in HTML
 * (gemeinde-st-moritz: 233 chars, «Schalter-Öffnungszeiten» included), so a
 * parser that publishes the PDF read as «unrelated» to it. The PDF is one
 * more candidate description of the SAME page and, as for the page's own
 * blocks in `extractDetailFields`, the longest candidate wins — which also
 * keeps the check able to fail: a parser that publishes only the teaser is
 * now compared with the whole ad.
 *
 * When the PDF cannot be read, a LINKED one leaves the HTML reading as it was.
 * An EMBEDDED one is the page's content, so what the HTML still offers is
 * chrome (csvm-mustair: the news-page frame, «Dein Browser unterstützt kein
 * PDF»): that reading is dropped and the sample proves nothing, instead of
 * reporting the published ad as unrelated to the frame around it. csvm's
 * robots.txt disallows /images/, where its PDFs live, so this is the path the
 * audit takes there by its own robots rule.
 */
async function vacancyPdfDescription(html, pageUrl, detail, fetchVacancyPdf) {
  const link = vacancyPdfLink(html, pageUrl);
  if (!link || typeof fetchVacancyPdf !== 'function') return { linkedDocument: null, vacancyPdf: null };
  let pdf;
  try {
    pdf = await fetchVacancyPdf(link.url);
  } catch (error) {
    pdf = { text: '', error: sanitizeProcessingError(error) };
  }
  const text = String(pdf?.text || '').trim();
  const readable = Boolean(text) && /^[a-f0-9]{64}$/.test(String(pdf?.bodySha256 || ''));
  if (!readable) {
    if (link.embedded) detail.description = '';
    return {
      linkedDocument: null,
      vacancyPdf: { outcome: 'unreadable', embedded: link.embedded, reason: String(pdf?.error || 'no text layer').slice(0, 120) },
    };
  }
  if (text.length <= String(detail.description || '').length) {
    return { linkedDocument: null, vacancyPdf: { outcome: 'shorter-than-page', embedded: link.embedded } };
  }
  detail.description = text;
  return {
    linkedDocument: { url: link.url, bodySha256: pdf.bodySha256 },
    vacancyPdf: { outcome: 'read', embedded: link.embedded },
  };
}

function withoutFragment(url = '') {
  const value = String(url || '');
  const at = value.indexOf('#');
  return at < 0 ? value : value.slice(0, at);
}

function queryOf(url = '') {
  try {
    return new URL(withoutFragment(url)).search.replace(/^\?/, '');
  } catch {
    return '';
  }
}

function urlFragment(url = '') {
  const value = String(url || '');
  const at = value.indexOf('#');
  if (at < 0) return '';
  try {
    return decodeURIComponent(value.slice(at + 1));
  } catch {
    return value.slice(at + 1);
  }
}

/**
 * Documents several postings of one crawler point into, told apart only by
 * the URL fragment. The fragment never reaches the server, so fetching any of
 * those URLs returns the same document: a client-side route (Johdi Suite
 * `emplois#offer/4094/…` on ehnv, daler-hopital, h-ju; pi-asp
 * `#position,id=…`; etat-de-vaud `#fr/sites/CX_1/job/5725`) or one page
 * listing every ad (grischapersonal, im-bethesda-spital, oscam `#concorso-…`).
 * On run 36528331656 14 crawlers published such URLs for all their postings.
 * A URL with a fragment that no other posting shares is left alone.
 *
 * @returns {Set<string>} the shared documents, fragment removed
 */
export function sharedSourceDocuments(jobs = []) {
  const byDocument = new Map();
  for (const job of jobs) {
    const url = String(job?.url || '');
    if (!url.includes('#')) continue;
    const document = withoutFragment(url);
    const urls = byDocument.get(document) || new Set();
    urls.add(url);
    byDocument.set(document, urls);
  }
  return new Set([...byDocument].filter(([, urls]) => urls.size > 1).map(([document]) => document));
}

/** `origin + pathname` of a URL, without query or fragment; '' when unparseable. */
function bareDocumentUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

/** Comparable form of a bare document URL: lowercase host, no trailing slash. */
function comparableDocumentUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return '';
  }
}

/**
 * Documents several postings of one crawler point into, told apart only by a
 * query parameter: la-fonte `inizia-con-noi?role=stagiaire-…` and
 * `?role=apprendisti-…`, dxt-commodities `careers/?panel=20897_1` and
 * `?panel=20897_2` (run 36571839273). Unlike a fragment, a query reaches the
 * server and may well select a vacancy (`?jobid=`, `?id=` on most ATS), so a
 * query-only difference is a CANDIDATE: the fetched page has to say it is the
 * bare document (see `pageDeclaresBareDocument`) before the sample is read as
 * a page several postings share.
 *
 * @returns {Set<string>} the candidate documents, as `origin + pathname`
 */
export function querySharedDocumentCandidates(jobs = []) {
  const byDocument = new Map();
  for (const job of jobs) {
    const url = withoutFragment(job?.url || '');
    if (!url.includes('?')) continue;
    const document = bareDocumentUrl(url);
    if (!document) continue;
    const urls = byDocument.get(document) || new Set();
    urls.add(url);
    byDocument.set(document, urls);
  }
  return new Set([...byDocument].filter(([, urls]) => urls.size > 1).map(([document]) => document));
}

/**
 * Whether the page fetched for `pageUrl` declares, through its canonical link,
 * that it is the document without the query: then the query addressed nothing
 * and every posting whose URL differs only by that query landed on the same
 * page. la-fonte serves byte-identical pages for `?role=…` of both roles and
 * for no query at all, canonical `https://www.lafonte.ch/inizia-con-noi`;
 * dxt-commodities' `?panel=…` pages declare `https://dxt.com/careers/`.
 * A canonical that keeps a query, or names another path, confirms nothing.
 */
export function pageDeclaresBareDocument(html = '', pageUrl = '') {
  const source = String(html || '');
  for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
    const rel = readAttr(match[0], 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = readAttr(match[0], 'href');
    if (!href) return false;
    let canonical;
    try {
      canonical = new URL(href, pageUrl);
    } catch {
      return false;
    }
    if (canonical.search) return false;
    return comparableDocumentUrl(canonical.toString()) === comparableDocumentUrl(bareDocumentUrl(pageUrl));
  }
  return false;
}

/**
 * Whether a query candidate landed on a page that several postings share:
 * the page declares the bare document as canonical AND lists this posting and
 * at least one other posting of that document under their own titles. The
 * canonical alone is not enough: a single-page app (a BrassRing
 * `HomeWithPreLoad?jobid=…`) may declare its shell canonical and still read
 * the query in the browser — its static page lists no posting at all, so it
 * stays a per-vacancy URL measured as before.
 */
export function pageListsSharedPostings(html = '', pageUrl = '', title = '', siblingTitles = []) {
  if (!pageDeclaresBareDocument(html, pageUrl)) return false;
  if (!headingSectionBlock(html, title)) return false;
  return (Array.isArray(siblingTitles) ? siblingTitles : [])
    .some((sibling) => plainText(sibling).toLowerCase() !== plainText(title).toLowerCase()
      && Boolean(headingSectionBlock(html, sibling)));
}

/**
 * What a fragment on a shared document is, once `fragmentAnchoredBlock` has
 * found no element with that id in the fetched page (an HTML id may contain
 * `/`, `=`, `?`, `&` or start with a digit, so the syntax alone never decides
 * that a fragment is not an element). A fragment written as a path or a
 * key=value pair (`offer/4094/…`, `fr/sites/CX_1/job/5725`, `position,id=…`,
 * `job.id=…`, `!/…`) and absent from the page is the route of a single-page
 * app: the page has no static place for the posting. Anything else absent
 * from the page is an anchor the page does not have.
 */
export function fragmentKind(url = '') {
  const fragment = urlFragment(url);
  if (!fragment) return 'none';
  if (fragment.startsWith(':~:text=')) return 'text-fragment';
  return /[/=]/.test(fragment) || fragment.startsWith('!') ? 'client-route' : 'anchor';
}

/**
 * The section a text fragment (`#:~:text=…`, the browsers' scroll-to-text
 * address) opens: from the heading whose text is the fragment's start text to
 * the next heading of the same level. It is how a page that lists every ad
 * under its own heading but gives none of them an id or a URL — klinik-
 * seeschau's Joomla list, «the listing IS the detail» — can still address
 * one posting. Returns '' when no heading carries that text.
 */
export function textFragmentBlock(html = '', url = '') {
  const fragment = String(url || '').split('#')[1] || '';
  if (!fragment.startsWith(':~:text=')) return '';
  const directive = fragment.slice(':~:text='.length).split('&')[0];
  const parts = directive.split(',').filter((part) => part && !part.endsWith('-') && !part.startsWith('-'));
  let start = '';
  try {
    start = decodeURIComponent(parts[0] || '');
  } catch {
    return '';
  }
  return headingSectionBlock(html, start);
}

/**
 * The section a heading whose text is `text` opens, to the next heading of
 * the same or a higher rank (at most 30 000 characters when none follows),
 * scripts and styles removed, or ''. The place of one posting on a page that
 * lists several under their titles — what a text fragment addresses, and
 * where a posting whose URL addresses nothing on the page still has its own
 * text: la-fonte lists each role under an `<h4>`, dxt-commodities under the
 * `<h4>` of its accordion panel, grischapersonal under an `<h1>` per table
 * row. A higher-rank heading closes the section too: the last dxt panel is
 * followed by the page's `<h2>`/`<h3>` footer, not by another `<h4>`.
 */
export function headingSectionBlock(html = '', text = '') {
  const wanted = plainText(text).toLowerCase();
  if (!wanted) return '';
  const source = String(html || '');
  for (const match of source.matchAll(/<(h([1-6]))\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (plainText(match[3]).toLowerCase() !== wanted) continue;
    const after = match.index + match[0].length;
    const next = source.slice(after).search(new RegExp(`<h[1-${match[2]}]\\b`, 'i'));
    return source.slice(match.index, next < 0 ? Math.min(source.length, after + 30000) : after + next)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  }
  return '';
}

/**
 * The element a URL fragment names (`id="…"`) inside the fetched page, as the
 * inner HTML of that element, or ''. klinik-gut (`#drz-accordion-id-4367`)
 * and klinik-schuetzen (`#job-PLUT7122`) list every ad on one page but give
 * each its own element: that element IS the vacancy's source.
 */
export function fragmentAnchoredBlock(html = '', url = '') {
  const fragment = urlFragment(url);
  // An HTML id is any non-empty string without whitespace: `offer/4094`,
  // `4367` and `a&b` are all valid, so the id is looked up in the page for
  // every fragment that is not a text directive. In the markup `&` may be
  // written `&amp;`.
  if (!fragment || fragment.startsWith(':~:') || /\s/.test(fragment)) return '';
  const source = String(html || '');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spellings = [...new Set([fragment, fragment.replace(/&/g, '&amp;')])].map(escape).join('|');
  const opening = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid\\s*=\\s*["'](?:${spellings})["'][^>]*>`, 'i').exec(source);
  if (!opening || /\/\s*>$/.test(opening[0])) return '';
  const tag = opening[1].toLowerCase();
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tags.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let match;
  while ((match = tags.exec(source))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return source.slice(opening.index + opening[0].length, match.index);
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return '';
}

/**
 * A posting whose published URL IS the PDF of its advertisement (oscam-
 * castelrotto's «bando di concorso»): the source text is the PDF, read like a
 * linked one and bound by digest in the evidence. A PDF that cannot be read
 * is a fetch failure with its reason, never an empty «match».
 */
async function checkPdfSourceDetail(item, fetchVacancyPdf, evidenceContext) {
  let pdf;
  try {
    pdf = await fetchVacancyPdf(item.url);
  } catch (error) {
    pdf = { text: '', error: sanitizeProcessingError(error) };
  }
  const text = String(pdf?.text || '').trim();
  if (!text || !/^[a-f0-9]{64}$/.test(String(pdf?.bodySha256 || ''))) {
    const reason = String(pdf?.error || 'no text layer');
    return {
      ...item,
      fetchFailed: true,
      status: 0,
      fetchError: reason.slice(0, 240),
      blockedByRobots: /robots/i.test(reason) || undefined,
      policyBlocked: /policy/i.test(reason) || undefined,
    };
  }
  try {
    const comparison = compareSourceDetail(item.job, { title: '', location: '', description: text }, {
      locationEvidence: 'generic',
      crawlerKey: item.crawlerKey,
    });
    const sourceDetailEvidence = evidenceContext
      ? createSourceDetailEvidence({
        crawlerKey: item.crawlerKey,
        sourceUrl: item.url,
        body: `application/pdf sha256:${pdf.bodySha256}`,
        observation: comparison.replayObservation,
        provenance: evidenceContext.provenance,
        versions: evidenceContext.versions,
        linkedDocument: { url: item.url, bodySha256: pdf.bodySha256 },
      })
      : null;
    return {
      ...item,
      ...comparison,
      vacancyPdf: { outcome: 'read', embedded: false, direct: true },
      ...(sourceDetailEvidence ? { sourceDetailEvidence } : {}),
    };
  } catch (error) {
    return processingFailureResult(item, error);
  }
}

export async function checkSourceDetailsBatch(items, concurrency = 3, {
  fetchPage = politeFetch,
  extractDetail = extractDetailFields,
  observeLocation = extractSourceLocationObservation,
  fetchVacancyPdf = fetchVacancyPdfText,
  evidenceContext = null,
} = {}) {
  const results = await mapPool(items, concurrency, async (item) => {
    if (isPdfReference(withoutFragment(item.url))) return checkPdfSourceDetail(item, fetchVacancyPdf, evidenceContext);
    let fetched;
    try {
      fetched = await fetchPage(item.url, { timeoutMs: 10000, retries: 1 });
    } catch (error) {
      // A fetcher that THROWS instead of returning `{ ok: false }` used to land
      // in the same nameless bucket #7351 removes; it carries the kind too —
      // AND the two refusal flags, because a thrown `public-fetch-policy` or
      // robots error carried only its transport kind, collapsed to
      // `transport-other`, and was read downstream as «the source is
      // unreachable»: our own URL bug promoted to a statement by the source,
      // which is the exact hole `fetchFailureFamily()` closes on the
      // non-throwing branch (#7536).
      return {
        ...item,
        fetchFailed: true,
        status: 0,
        fetchError: sanitizeProcessingError(error),
        transportError: transportErrorKind(error),
        policyBlocked: isPublicFetchPolicyError(error) || undefined,
        blockedByRobots: isRobotsDeniedError(error) || undefined,
      };
    }
    if (!fetched.ok || !fetched.body) {
      return {
        ...item,
        fetchFailed: true,
        status: fetched.status || 0,
        // Only meaningful when status is 0: `politeFetch` returns the transport
        // kind (dns/tls/timeout/reset/refused) instead of dropping the error, so
        // a status-less failure still says WHY (#7351).
        transportError: fetched.transportError,
        policyBlocked: fetched.policyBlocked || undefined,
        blockedByRobots: fetched.blockedByRobots || undefined,
      };
    }
    try {
      const recordUrl = item.job?.url || item.url;
      const detail = extractDetail(fetched.body, fetched.url || item.url, { recordUrl });
      detail.headingSublineFields = vacancyHeadingSublineFields(fetched.body, detail.title);
      const locationObservation = observeLocation(
        fetched.body,
        fetched.url || item.url,
        { includeDiagnostics: true, recordUrl },
      );
      if (locationObservation.location) detail.location = locationObservation.location;
      // A document shared by several postings (see sharedSourceDocuments and
      // querySharedDocumentCandidates) is the vacancy's source only where the
      // posting has a place of its own on it: the element or the text its URL
      // fragment names, or else the section under its own title. The whole
      // page is every posting at once, so it is never measured against one.
      let sourceScope = null;
      let sharedBy = null;
      let locationEvidence = locationObservation.evidence;
      const jobUrl = item.job?.url || item.url;
      if (item.sharedDocument) sharedBy = 'fragment';
      else if (item.sharedDocumentCandidate === 'query'
        && pageListsSharedPostings(fetched.body, fetched.url || item.url, item.job?.title, item.siblingTitles)) sharedBy = 'query';
      // Whether the published URL itself leads to the posting on that page.
      // A query the page ignores, or an anchor it does not have, does not:
      // the reader lands on the top of a page listing several postings.
      let urlAddressesPosting = true;
      if (sharedBy) {
        // The fragment addresses the posting on the shared page whatever made
        // the page shared: la-fonte keeps its `?role=` identity and adds the
        // text fragment of the role's title, dxt its `?panel=` and the id of
        // the accordion panel.
        const kind = fragmentKind(jobUrl);
        const clientRoute = kind === 'client-route';
        let addressed = '';
        if (kind === 'text-fragment') addressed = textFragmentBlock(fetched.body, jobUrl);
        else if (kind !== 'none') addressed = fragmentAnchoredBlock(fetched.body, jobUrl);
        if (!addressed && !clientRoute) urlAddressesPosting = false;
        const titled = !addressed && !clientRoute
          ? headingSectionBlock(fetched.body, item.job?.title || '')
          : '';
        const block = addressed || titled;
        if (block) {
          sourceScope = addressed ? 'fragment-anchor' : 'title-heading';
          detail.description = plainText(block);
          const anchoredLocation = observeLocation(block, fetched.url || item.url, { recordUrl });
          detail.location = anchoredLocation.location || '';
          locationEvidence = anchoredLocation.evidence;
        } else {
          // Nothing on the page is this posting's: an app route has no
          // static place for it (informational), an anchor or a query that
          // addresses nothing, on a page without the posting's title, is a
          // defect of the published URL (visible issue).
          sourceScope = clientRoute ? 'client-route' : 'anchor-missing';
          detail.description = '';
          detail.location = '';
          detail.headingSublineFields = [];
          locationEvidence = 'generic';
        }
      }
      const unattributable = sourceScope === 'client-route' || sourceScope === 'anchor-missing';
      const { linkedDocument, vacancyPdf } = unattributable
        ? { linkedDocument: null, vacancyPdf: null }
        : await vacancyPdfDescription(
          fetched.body,
          fetched.url || item.url,
          detail,
          fetchVacancyPdf,
        );
      const comparison = compareSourceDetail(item.job, detail, {
        locationEvidence,
        crawlerKey: item.crawlerKey,
      });
      const sourceDetailEvidence = evidenceContext
        ? createSourceDetailEvidence({
          crawlerKey: item.crawlerKey,
          sourceUrl: fetched.url || item.url,
          body: fetched.body,
          observation: comparison.replayObservation,
          provenance: evidenceContext.provenance,
          versions: evidenceContext.versions,
          linkedDocument,
        })
        : null;
      return {
        ...item,
        ...comparison,
        ...(vacancyPdf ? { vacancyPdf } : {}),
        ...(sourceScope ? { sourceScope } : {}),
        ...(sharedBy ? { sharedBy } : {}),
        ...(urlAddressesPosting ? {} : { urlAddressesPosting: false }),
        // Attached to the RESULT, deliberately not routed through
        // `comparison.replayObservation`: the replay-evidence schema and its
        // strict validator in `classifySourceDetailObservation` would have to
        // grow a field for a signal no replay consumer reads. Only propagated
        // when the extractor actually decided — an injected extractor that
        // omits it leaves the flag absent, and an absent flag keeps the old
        // WARNING (see `applySourceDetailResults`). Silence on a missing
        // signal would be the one failure mode worse than the noise.
        ...(typeof detail.hasStructuredVacancy === 'boolean'
          ? { sourceHasStructuredVacancy: detail.hasStructuredVacancy }
          : {}),
        ...(locationObservation.locationEvidenceCounts
          ? { locationEvidenceCounts: locationObservation.locationEvidenceCounts }
          : {}),
        ...(sourceDetailEvidence ? { sourceDetailEvidence } : {}),
      };
    } catch (error) {
      return processingFailureResult(item, error);
    }
  });
  return results.map((result, index) => result
    ?? processingFailureResult(items[index], new Error('worker returned no result')));
}

/**
 * A fetched detail page is evidence only if something was actually observed on
 * it. With no usable source location AND no comparable source description,
 * `locationMismatch` and `descriptionMismatch` are both false for every
 * possible published value: the sample cannot contradict anything, yet the
 * counters below used to swallow it and the crawler read as clean. That is how
 * a green `--check-source-details` run can prove nothing — measured 208/924
 * fetched samples on run 33953283741 (2026-09-05), plus 366/924 with no
 * location verdict at all. Scored as its own outcome, never as a pass.
 */
export function sourceDetailUnobserved(result) {
  return !result.sourceLocation
    && Number(result.sourceDescriptionLength || 0) < COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS;
}

/**
 * What one identical-description bucket sample proved. `matched` is the only
 * outcome that says "template": the source body was long enough to contradict
 * the published one and did not. A page with less than
 * COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS of body proves neither template nor
 * fallback, so it is counted as `notComparable`, never as a match.
 */
export function duplicateBucketSampleOutcome(result) {
  if (result?.fetchFailed) return 'fetchFailed';
  if (result?.processingFailed) return 'processingFailed';
  if (result?.descriptionMismatch) return 'mismatched';
  if (Number(result?.sourceDescriptionLength || 0) < COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS) return 'notComparable';
  return 'matched';
}

/**
 * Why a source detail page could not be read. `fetchFailed` alone cannot tell
 * «the vacancy is gone, the sample is stale» from «the site refuses our
 * fetcher», and those two demand opposite responses: the first is expected
 * churn, the second is coverage we have lost and can win back. Measured on run
 * 33953283741, the aggregate 155/1079 splits into 102 transport failures, 47
 * 401/403 refusals and only 6 genuinely expired vacancies — i.e. 13,8% of the
 * sample is missing for reasons that are ours to fix, not the source's.
 */
export function fetchFailureCause(status, result = null) {
  const code = Number(status || 0);
  if (code === 404 || code === 410) return 'expired-vacancy';
  if (code === 401 || code === 403) return 'blocked-by-source';
  if (code === 429) return 'rate-limited';
  if (code >= 500) return 'source-server-error';
  if (code === 0) {
    // «transport» on its own is the same disease as «fetchFailed» on its own:
    // an aggregate that names no cause. A DNS failure means the host is gone,
    // a TLS failure means its certificate is broken, a timeout means we may be
    // the ones too slow — three different answers, one old bucket.
    if (result?.blockedByRobots) return 'blocked-by-robots';
    if (result?.policyBlocked) return 'blocked-by-policy';
    return `transport-${result?.transportError || 'other'}`;
  }
  return `http-${code}`;
}

/**
 * The family a cause belongs to, for the per-source pass below. Transport kinds
 * collapse back together here on purpose: a source that is unreachable is one
 * finding whether the socket died of DNS on one sample and of TLS on the next.
 */
export function fetchFailureFamily(cause) {
  if (cause === 'expired-vacancy') return 'expired-vacancy';
  // `blocked-by-policy` is OUR public-URL policy rejecting the request, not the
  // source rejecting us: a crawler emitting non-public or non-canonical URLs
  // would otherwise have its own bug promoted to «that source declines», be
  // subtracted from the unexplained count and go invisible to --strict. It gets
  // a family of its own so it can never be read as a statement by the source.
  if (cause === 'blocked-by-policy') return 'refused-by-us';
  if (String(cause).startsWith('blocked-')) return 'refused-by-source';
  // `unreachable-network` (ENETUNREACH/EHOSTUNREACH) is the runner saying it has
  // NO ROUTE — it never reached the network, so it observed nothing about the
  // source. Left in `source-unreachable` it would be promoted to a source-level
  // finding and subtracted from the unexplained count: a failure of ours
  // certifying itself as a property of the host, which is the self-certifying
  // pattern the source-level split exists to remove (#7536).
  if (cause === 'transport-unreachable-network') return 'unreachable-from-us';
  if (String(cause).startsWith('transport-')) return 'source-unreachable';
  return String(cause);
}

/**
 * Families that can NEVER be promoted to a source-level finding: an expiry is
 * churn, and the two `*-by-us`/`from-us` families are our own faults — reading
 * either as «that source declines» would subtract our bug from the number the
 * `--strict` gate watches, i.e. hide a broken parser behind a host we never
 * actually contacted.
 */
export const NON_SOURCE_LEVEL_FAILURE_FAMILIES = new Set([
  'expired-vacancy',
  'refused-by-us',
  'unreachable-from-us',
]);

/**
 * How many sampled fetches a source must lose before «all of them failed» is
 * evidence of anything. The source-detail sampler draws 2 details per crawler,
 * so 2 is both the floor and the usual case; a single loss stays a per-vacancy
 * failure, which is what keeps a flaky sample out of the source-level bucket.
 */
export const SOURCE_LEVEL_FAILURE_MIN_SAMPLES = 2;

/**
 * The share of the source-detail sample that may fail for a reason nothing
 * explains. Above it the audit's own coverage claim is unproven: the run says
 * «checked 1075» while some of those samples proved nothing and nobody can say
 * why. It is a floor under a regression, not a target, so it sits above the
 * measured rate — but only as far above as the measurements justify.
 *
 * Tightened 5 % → 4,5 % on the first live runs that stamped the number, which
 * is what the 5 % was waiting for (#7630, item 2):
 *   - 40/1077 = 3,714 %  — run 33997497767, 2026-09-05T23:16Z
 *   - 36/1077 = 3,3426 % — run 34020480797, 2026-09-06T08:12Z, first run after
 *     the #7673 merge, i.e. the first one classified by the code that is here
 *
 * The 5 % was set against «a measured 0,93 %», and that figure was never the
 * live rate: it came from replaying artifact parser-quality-report-33969036485
 * whose samples PREDATE the cause split, so the 30 samples our own
 * `public-fetch-policy` refuses and the 30 robots denials were still recorded
 * as `blocked-by-source`, promoted to a source-level finding and subtracted.
 * Live they are `refused-by-us`/scattered and stay unexplained: 30 of the 36
 * are the policy refusals alone. The real rate is ~3,5 %, not ~1 %, and the
 * ceiling has to be read against that.
 *
 * Why 4,5 % and not the measured 3,34 %: the two runs are 0,37 pp apart, and
 * the sampler draws 2 details per crawler, so one crawler moving in or out of
 * the bucket is worth ~0,19 pp. A ceiling pinned to the measurement would go
 * red on that noise; 4,5 % leaves ~0,8 pp over the worse of the two, about
 * four crawlers' worth of slack, and still refuses the 4,6-5,0 % band the old
 * ceiling accepted.
 */
export const SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT = 4.5;

/**
 * Split failures the source explains from failures we still owe an answer for.
 *
 * A refusal is a POLICY of a source when EVERY detail page sampled from that
 * source was refused the same way — 403 on 2 of 2 is that source declining our
 * fetcher, not our parser breaking. The same reading applies to a host that is
 * simply not there any more. What it deliberately does NOT cover is the
 * scattered failure: one sample of two, on a source that answered the other —
 * that one is ours, stays unexplained, and is the number the gate watches.
 *
 * Measured by replaying the 1075 sealed samples of artifact
 * parser-quality-report-33969036485-1 (2026-09-05) through this function:
 * 120/1075 failures = 6 expired vacancies + 104 samples over 52 sources that
 * lost every detail they were sampled on + 10 scattered.
 * Unexplained goes 10,60 % → 0,93 %.
 *
 * That 0,93 % is a property of THAT corpus, not the live rate: those samples
 * predate the cause split, so our own policy refusals and the robots denials
 * were still `blocked-by-source` there and got promoted. On live runs the same
 * function measures ~3,5 % — see SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT.
 */
export function classifySourceLevelFailures(byKey) {
  const sources = {};
  let samples = 0;
  for (const [key, info] of Object.entries(byKey)) {
    if (info.checked < SOURCE_LEVEL_FAILURE_MIN_SAMPLES) continue;
    if (info.fetchFailed !== info.checked) continue;
    const families = Object.keys(info.failureFamilies || {});
    if (families.length !== 1) continue;
    const [family] = families;
    // Neither an expiry nor a failure of ours explains a coverage loss on the
    // source's behalf: all of them stay out of the source-level bucket, and
    // therefore stay counted as unexplained.
    if (NON_SOURCE_LEVEL_FAILURE_FAMILIES.has(family)) continue;
    sources[key] = { family, samples: info.checked };
    samples += info.checked;
  }
  return { sources, samples, sourceCount: Object.keys(sources).length };
}

export function applySourceDetailResults(report, sourceResults, requested = sourceResults.length) {
  const sourceDetailSummary = {
    requested,
    processed: sourceResults.length,
    fetched: 0,
    fetchFailed: 0,
    fetchFailureCauses: {},
    expiredVacancies: 0,
    sourceLevelFailures: { sourceCount: 0, samples: 0, sources: {} },
    unexplainedFetchFailures: 0,
    unexplainedFetchFailureRatePct: 0,
    processingFailed: 0,
    unobserved: 0,
    // Subset of `unobserved` whose source served no JobPosting node at all.
    // `unobserved` stays the TOTAL so the observability rate keeps meaning
    // "fetched pages that yielded nothing" — a mute page yielded nothing
    // either. The split only decides whether it is the PARSER's fault.
    unobservedSourceMute: 0,
    authoritativeLocationChecks: 0,
    authoritativeLocationChecksByEvidence: {
      jsonld: 0,
      'strong-markup': 0,
      other: 0,
    },
    locationEvidenceBeforeGateByEvidence: emptyLocationEvidenceCounts(),
    locationEvidenceAfterGateByEvidence: emptyLocationEvidenceCounts(),
    locationMatches: 0,
    locationMismatches: 0,
    sourceCorroboratedLocationObservations: 0,
    circularCorroborationObservations: 0,
    inconclusiveLocationObservations: 0,
    descriptionMismatches: 0,
    // Outcomes of the identical-description bucket samples (see
    // duplicateBucketSourceSample). Every requested bucket sample lands in
    // exactly one of the five outcomes, so the hidden signal stays measured
    // on every run even though it no longer makes a crawler WARNING.
    duplicateBucketSamples: {
      requested: 0,
      matched: 0,
      mismatched: 0,
      notComparable: 0,
      fetchFailed: 0,
      processingFailed: 0,
    },
    // Detail pages that present the vacancy as a PDF (see vacancyPdfLink):
    // read and used, unreadable (robots, fetch, no text layer), or shorter
    // than what the page already carried.
    vacancyPdfPages: { read: 0, unreadable: 0, shorterThanPage: 0 },
    // Samples on a document several postings share (see sharedSourceDocuments
    // and querySharedDocumentCandidates): read from the element their fragment
    // names, read from the section under their own title, on an app route with
    // no static page for the posting, or behind an anchor or a query that does
    // not lead to the posting (counted whether or not its title was found).
    sharedDocumentSamples: { fragmentAnchored: 0, titleHeading: 0, clientRoute: 0, anchorMissing: 0 },
  };
  const byKey = {};
  for (const result of sourceResults) {
    const key = result.crawlerKey;
    if (!byKey[key]) byKey[key] = {
      checked: 0, fetchFailed: 0, processingFailed: 0, processingErrors: [],
      locationChecked: 0, locationInconclusive: 0, locationMismatches: 0,
      descriptionMismatches: 0, unobserved: 0, unobservedSourceMute: 0,
      circularCorroborationObservations: 0,
      unobservedDetails: [], details: [], failureFamilies: {},
      bucketVerification: null,
      unattributable: 0, anchorMissing: 0, anchorMissingDetails: [],
    };
    const info = byKey[key];
    const sourceReference = sourceDetailReportReference(result.url);
    info.checked++;
    if (result.vacancyPdf) {
      const pdfOutcome = result.vacancyPdf.outcome === 'shorter-than-page' ? 'shorterThanPage' : result.vacancyPdf.outcome;
      if (pdfOutcome in sourceDetailSummary.vacancyPdfPages) sourceDetailSummary.vacancyPdfPages[pdfOutcome]++;
    }
    const bucketSample = result.sampleReason === DUPLICATE_BUCKET_SAMPLE_REASON;
    if (bucketSample) {
      const outcome = duplicateBucketSampleOutcome(result);
      sourceDetailSummary.duplicateBucketSamples.requested++;
      sourceDetailSummary.duplicateBucketSamples[outcome]++;
      info.bucketVerification = {
        outcome,
        bucketSize: Number.isInteger(result.bucketSize) ? result.bucketSize : null,
        source: sourceReference,
      };
    }
    if (result.fetchFailed) {
      info.fetchFailed++;
      sourceDetailSummary.fetchFailed++;
      const cause = fetchFailureCause(result.status, result);
      sourceDetailSummary.fetchFailureCauses[cause] = (sourceDetailSummary.fetchFailureCauses[cause] || 0) + 1;
      const family = fetchFailureFamily(cause);
      info.failureFamilies[family] = (info.failureFamilies[family] || 0) + 1;
      if (family === 'expired-vacancy') sourceDetailSummary.expiredVacancies++;
      continue;
    }
    if (result.processingFailed) {
      info.processingFailed++;
      sourceDetailSummary.processingFailed++;
      info.processingErrors.push(`${sourceReference}: ${result.processingError}`);
      continue;
    }
    sourceDetailSummary.fetched++;
    if (result.sourceScope === 'fragment-anchor') sourceDetailSummary.sharedDocumentSamples.fragmentAnchored++;
    if (result.sourceScope === 'title-heading') sourceDetailSummary.sharedDocumentSamples.titleHeading++;
    // Neither is «unobserved»: the page may well carry a JobPosting, just not
    // this posting's. No verdict on description or location either way.
    if (result.sourceScope === 'client-route') {
      sourceDetailSummary.sharedDocumentSamples.clientRoute++;
      info.unattributable++;
      continue;
    }
    // The published URL does not lead to the posting: a visible defect of
    // the URL. When the page still carries the posting under its own title
    // (`title-heading`), that section is compared below like any source;
    // without it there is nothing of this posting's to compare.
    if (result.sourceScope === 'anchor-missing' || result.urlAddressesPosting === false) {
      sourceDetailSummary.sharedDocumentSamples.anchorMissing++;
      info.anchorMissing++;
      const publishedUrl = result.job?.url || result.url;
      const titled = result.sourceScope === 'title-heading' ? '; the section under its title was compared instead' : '';
      info.anchorMissingDetails.push(result.sharedBy === 'query'
        ? `${sourceReference}?${queryOf(publishedUrl)}: the page this URL shares with other postings ignores the query (it declares the URL without it as canonical)${titled}`
        : `${sourceReference}#${urlFragment(publishedUrl)}: the page this URL shares with other postings has no element with that id${titled}`);
      if (result.sourceScope === 'anchor-missing') continue;
    }
    addLocationEvidenceCounts(
      sourceDetailSummary.locationEvidenceBeforeGateByEvidence,
      result.locationEvidenceCounts?.beforeGate,
    );
    addLocationEvidenceCounts(
      sourceDetailSummary.locationEvidenceAfterGateByEvidence,
      result.locationEvidenceCounts?.afterGate,
    );
    if (sourceDetailUnobserved(result)) {
      sourceDetailSummary.unobserved++;
      // «Nothing was readable» splits into two different statements about two
      // different things. When the response carried no JobPosting node, the
      // sentence is about the SOURCE and it is simply true: there is no
      // structured vacancy to read, so `unobserved` is the correct reading of
      // an unobservable page and not a parser defect. When a JobPosting WAS
      // served and still nothing came out, the sentence is about the PARSER,
      // and that is the finding the 331 warnings were burying — 17 of 21
      // sampled `parses-today` crawlers were the first case, 0 of 21 were
      // "structure present, audit read the wrong field".
      // Absent flag (no boolean from the extractor) counts as the parser case:
      // an unknown must not silence a warning.
      if (result.sourceHasStructuredVacancy === false) {
        info.unobservedSourceMute++;
        sourceDetailSummary.unobservedSourceMute++;
      } else {
        info.unobserved++;
        info.unobservedDetails.push(`${sourceReference}: fetched, but no source location was readable and only ${result.sourceDescriptionLength} chars of source description (< ${COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS}) — this sample can contradict nothing`);
      }
    }
    if (result.locationChecked) {
      info.locationChecked++;
      sourceDetailSummary.authoritativeLocationChecks++;
      const evidence = result.locationEvidence === 'jsonld'
        ? 'jsonld'
        : result.locationEvidence === 'strong-markup'
          ? 'strong-markup'
          : 'other';
      sourceDetailSummary.authoritativeLocationChecksByEvidence[evidence]++;
      if (result.locationMismatch) sourceDetailSummary.locationMismatches++;
      else sourceDetailSummary.locationMatches++;
      // Kept visible: a pass earned because the page names the published place
      // elsewhere is a different fact from a pass earned by the two location
      // fields agreeing, and only the count makes the first one auditable.
      if (result.locationAuthority === 'source-corroborated' && !result.locationMismatch) {
        sourceDetailSummary.sourceCorroboratedLocationObservations++;
      }
    } else if (result.locationInconclusive) {
      info.locationInconclusive++;
      sourceDetailSummary.inconclusiveLocationObservations++;
      if (result.locationAuthority === 'circular') {
        info.circularCorroborationObservations++;
        sourceDetailSummary.circularCorroborationObservations++;
        info.unobservedDetails.push(`${sourceReference}: published "${result.publishedLocation}" is named only in the vacancy text used to derive the locality; the source detail corroborates nothing here`);
      }
    }
    if (result.locationMismatch) {
      info.locationMismatches++;
      info.details.push(`${sourceReference}: published "${result.publishedLocation || 'empty'}", source "${result.sourceLocation}" [${result.locationEvidence}]`);
    }
    if (result.descriptionMismatch) {
      info.descriptionMismatches++;
      sourceDetailSummary.descriptionMismatches++;
      const bucketNote = bucketSample && Number.isInteger(result.bucketSize)
        ? ` (body shared verbatim by ${result.bucketSize} jobs)`
        : '';
      info.details.push(`${sourceReference}: published description ${result.publishedDescriptionLength} chars, source ${result.sourceDescriptionLength} chars${bucketNote}`);
    }
  }
  for (const [key, info] of Object.entries(byKey)) {
    const entry = report[key] || (report[key] = { total: 0, issues: [] });
    if (info.bucketVerification) {
      const bucketIssue = entry.issues.find((issue) => issue.type === 'duplicate-descriptions-desc-only');
      if (bucketIssue) bucketIssue.sourceVerification = info.bucketVerification;
    }
    // Informational, never an issue: the source is an app with no static
    // page per posting, so these samples could not be checked at all.
    if (info.unattributable > 0) entry.sourceDetailUnattributable = info.unattributable;
    if (info.anchorMissing > 0) {
      entry.issues.push({
        type: 'source-detail-anchor-missing',
        count: info.anchorMissing,
        total: info.checked,
        details: info.anchorMissingDetails,
        message: `${info.anchorMissing}/${info.checked} published URLs point into a page several postings share with an anchor that is not on it or a query it ignores — the link does not lead to the posting; publish a per-vacancy URL, an anchor that exists or a text fragment of its title`,
      });
    }
    if (info.processingFailed > 0) {
      entry.issues.push({
        type: 'parse-error', count: info.processingFailed, total: info.checked,
        processingFailed: info.processingFailed, details: info.processingErrors,
        message: `${info.processingFailed}/${info.checked} source detail pages failed during local processing`,
      });
      entry.severity = 'CRITICAL';
    }
    if (info.unobserved > 0 || info.circularCorroborationObservations > 0) {
      const parts = [];
      if (info.unobserved > 0) parts.push(`${info.unobserved}/${info.checked} fetched but observable in neither location nor description`);
      if (info.circularCorroborationObservations > 0) parts.push(`${info.circularCorroborationObservations}/${info.checked} circular locality corroborations`);
      entry.issues.push({
        type: 'source-detail-unobserved',
        count: info.unobserved + info.circularCorroborationObservations,
        total: info.checked,
        unobserved: info.unobserved,
        circularCorroborationObservations: info.circularCorroborationObservations,
        details: info.unobservedDetails,
        message: `${parts.join(', ')} — those samples are inconclusive and prove nothing`,
      });
    }
    const findings = info.locationMismatches + info.descriptionMismatches;
    if (findings > 0) {
      entry.issues.push({
        type: 'source-detail-mismatch', count: findings, total: info.checked,
        locationMismatches: info.locationMismatches,
        locationChecked: info.locationChecked,
        locationInconclusive: info.locationInconclusive,
        descriptionMismatches: info.descriptionMismatches,
        fetchFailed: info.fetchFailed,
        processingFailed: info.processingFailed,
        details: info.details,
        message: `${info.locationMismatches}/${info.locationChecked} authoritative source location mismatches, ${info.descriptionMismatches}/${info.checked} incomplete descriptions`,
      });
    }
  }
  sourceDetailSummary.sourceLevelFailures = classifySourceLevelFailures(byKey);
  sourceDetailSummary.unexplainedFetchFailures = Math.max(
    0,
    sourceDetailSummary.fetchFailed
      - sourceDetailSummary.expiredVacancies
      - sourceDetailSummary.sourceLevelFailures.samples,
  );
  sourceDetailSummary.unexplainedFetchFailureRatePct = requested
    ? Number((100 * sourceDetailSummary.unexplainedFetchFailures / requested).toFixed(4))
    : 0;
  return sourceDetailSummary;
}

/**
 * Render the source-detail counters that `applySourceDetailResults` writes and
 * nothing used to read. Until #7714 the whole location-observation family —
 * and with it `sourceCorroboratedLocationObservations`, the pass opened by
 * #7579 — was written, serialized into the JSON report and never printed: a
 * pass earned because the page names the published place elsewhere looked
 * exactly like a pass earned by the two location fields agreeing. The share
 * over the authoritative checks is the number that says whether the
 * corroboration rule is turning into a free pass, so it is printed, not left
 * to be recomputed by hand from the report.
 */
export function formatSourceDetailObservationLines(summary = {}) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  const authoritative = count(summary.authoritativeLocationChecks);
  const inconclusive = count(summary.inconclusiveLocationObservations);
  const descriptionMismatches = count(summary.descriptionMismatches);
  const processingFailed = count(summary.processingFailed);
  // New summaries carry the exact result count. Keep old hand-built/serialized
  // summaries readable while ensuring every live applySourceDetailResults call
  // reports over the result set, not over a truncated requested count.
  const processed = count(Number.isFinite(summary.processed) ? summary.processed : summary.requested);
  const lines = [];
  if (authoritative > 0 || inconclusive > 0) {
    const matches = count(summary.locationMatches);
    const mismatches = count(summary.locationMismatches);
    const corroborated = count(summary.sourceCorroboratedLocationObservations);
    const circular = count(summary.circularCorroborationObservations);
    const share = authoritative
      ? (100 * corroborated / authoritative).toFixed(1)
      : '0.0';
    lines.push(`Source detail location observations: ${matches}/${authoritative} authoritative checks matched, ${mismatches} mismatched`);
    lines.push(`  corroborated by other page evidence: ${corroborated}/${authoritative} (${share} % of authoritative checks)`);
    if (summary.authoritativeLocationChecksByEvidence) {
      const byEvidence = summary.authoritativeLocationChecksByEvidence;
      const jsonld = count(byEvidence.jsonld);
      const markup = count(byEvidence['strong-markup']);
      const other = count(byEvidence.other);
      const otherSuffix = other > 0 ? `, other ${other}` : '';
      lines.push(`  evidence: JSON-LD ${jsonld}, DOM/label ${markup}${otherSuffix}`);
    }
    if (summary.locationEvidenceBeforeGateByEvidence || summary.locationEvidenceAfterGateByEvidence) {
      const before = summary.locationEvidenceBeforeGateByEvidence || {};
      const after = summary.locationEvidenceAfterGateByEvidence || {};
      lines.push(`  evidence gate: JSON-LD ${count(before.jsonld)}→${count(after.jsonld)}, DOM/label ${count(before['strong-markup'])}→${count(after['strong-markup'])}`);
    }
    lines.push(`  inconclusive: ${inconclusive}`);
    if (circular > 0) lines.push(`  circular corroboration: ${circular} (inconclusive)`);
  }
  if (descriptionMismatches > 0) {
    lines.push(`Source detail description mismatches: ${descriptionMismatches}`);
  }
  if (processingFailed > 0) {
    lines.push(`Source detail processing failures: ${processingFailed}/${processed}`);
  }
  // Printed on every run, and that is the point: the sources reclassified out
  // of WARNING are counted HERE instead of being dropped. The tally is
  // recomputed from this run's fetches, so it can be checked against the run
  // that produced it — never inherited from a snapshot or an allowlist that
  // nobody re-measures.
  const unobserved = count(summary.unobserved);
  const sourceMute = count(summary.unobservedSourceMute);
  if (unobserved > 0) {
    lines.push(`Source detail unobserved split: ${sourceMute} source served no JobPosting structured data (no issue raised), ${unobserved - sourceMute} served one and still read as nothing (parser finding)`);
  }
  // Same reasoning for the identical-description buckets: the hidden signal
  // stopped producing WARNINGs, so what the source said about each bucket is
  // printed here on every run instead of disappearing with the WARNING.
  if (count(summary.duplicateRequestsDropped) > 0) {
    lines.push(`Source detail requests dropped as duplicates of a request of the same crawler: ${count(summary.duplicateRequestsDropped)} (same URL sampled twice — a sampler defect)`);
  }
  const shared = summary.sharedDocumentSamples;
  if (shared && count(shared.fragmentAnchored) + count(shared.titleHeading) + count(shared.clientRoute) + count(shared.anchorMissing) > 0) {
    lines.push(`Source detail samples on a page several postings share: ${count(shared.fragmentAnchored)} read from the element their URL fragment names, ${count(shared.titleHeading)} read from the section under their title, ${count(shared.clientRoute)} on an app route with no static page per posting (informational), ${count(shared.anchorMissing)} behind an anchor or a query that does not lead to the posting (source-detail-anchor-missing)`);
  }
  const pdfPages = summary.vacancyPdfPages;
  if (pdfPages && count(pdfPages.read) + count(pdfPages.unreadable) + count(pdfPages.shorterThanPage) > 0) {
    lines.push(`Source detail pages presenting the vacancy as a PDF: ${count(pdfPages.read)} compared with the PDF, ${count(pdfPages.unreadable)} PDF unreadable (an embedded one leaves the sample unobserved), ${count(pdfPages.shorterThanPage)} PDF shorter than the page body`);
  }
  const bucket = summary.duplicateBucketSamples;
  if (bucket && count(bucket.requested) > 0) {
    lines.push(`Identical-description buckets checked against the source: ${count(bucket.requested)} sampled — ${count(bucket.matched)} carry their source body (template), ${count(bucket.mismatched)} contradicted by it (source-detail-mismatch), ${count(bucket.notComparable)} source body < ${COMPARABLE_SOURCE_DESCRIPTION_MIN_CHARS} chars (proves nothing), ${count(bucket.fetchFailed)} fetch failed, ${count(bucket.processingFailed)} processing failed`);
  }
  return lines;
}

/**
 * Persist either a complete request-bound bundle or an explicit invalid
 * artifact. Bundle failures become CRITICAL parser findings before the common
 * report writer runs, so missing provenance or a tampered/partial result can
 * never abort the audit without leaving replay diagnostics behind.
 */
export function finalizeSourceDetailEvidence(report, sourceResults, evidenceContext) {
  try {
    return createSourceDetailEvidenceBundle(sourceResults, evidenceContext);
  } catch (error) {
    const errorCode = String(error?.code || 'bundle-failed')
      .replace(/[^a-z0-9_-]/gi, '-')
      .slice(0, 64) || 'bundle-failed';
    const crawlerKeys = new Set([
      ...(Array.isArray(evidenceContext?.requestedSamples)
        ? evidenceContext.requestedSamples.map((sample) => sample?.crawlerKey)
        : []),
      ...(Array.isArray(sourceResults) ? sourceResults.map((result) => result?.crawlerKey) : []),
    ].filter((key) => typeof key === 'string' && key));
    if (crawlerKeys.size === 0) crawlerKeys.add('source-detail-evidence');
    for (const key of crawlerKeys) {
      const entry = report[key] || (report[key] = { total: 0, issues: [] });
      entry.issues.push({
        type: 'parse-error',
        count: 1,
        total: 1,
        processingFailed: 1,
        evidenceBundleFailed: true,
        details: [`SourceDetailEvidenceError: ${errorCode}`],
        message: 'source detail evidence could not be sealed; replay is invalid',
      });
      entry.severity = 'CRITICAL';
    }
    return createSourceDetailEvidenceFailureBundle({
      requestedCount: Number.isInteger(evidenceContext?.requestedCount)
        ? evidenceContext.requestedCount
        : Array.isArray(sourceResults) ? sourceResults.length : 0,
      errorCode,
    });
  }
}

/** Run the complete source-detail observer, including the zero-sample case. */
export async function runSourceDetailChecks(report, sourceDetailsToCheck, {
  provenance,
  versions = getSourceDetailImplementationVersions(),
  concurrency = 3,
  checkBatch = checkSourceDetailsBatch,
} = {}) {
  // Last line of defence behind the samplers: the same crawler asking for the
  // same URL twice is one observation, not two, and a single duplicate makes
  // the evidence bundle refuse the whole run. Kept once, counted, printed.
  const seenRequests = new Set();
  const requests = sourceDetailsToCheck.filter(({ crawlerKey, url }) => {
    const identity = `${crawlerKey}\u0000${url}`;
    if (seenRequests.has(identity)) return false;
    seenRequests.add(identity);
    return true;
  });
  const duplicateRequestsDropped = sourceDetailsToCheck.length - requests.length;
  const evidenceContext = {
    provenance,
    versions,
    requestedCount: requests.length,
    requestedSamples: requests.map(({ crawlerKey, url }) => ({ crawlerKey, url })),
  };
  const sourceResults = await checkBatch(requests, concurrency, { evidenceContext });
  const sourceDetailSummary = applySourceDetailResults(report, sourceResults, requests.length);
  sourceDetailSummary.duplicateRequestsDropped = duplicateRequestsDropped;
  return {
    sourceDetailSummary,
    sourceDetailEvidence: finalizeSourceDetailEvidence(report, sourceResults, evidenceContext),
  };
}

/** Source-detail portion of the audit's shared severity contract. */
/**
 * The last rung of the severity chain: once no specific rule has claimed the
 * entry, ANY remaining issue makes the crawler a WARNING. Exported because it
 * is the rule a reclassification has to be measured against — a source that
 * must stop being a WARNING has to emit NO issue, and a test can only prove
 * that by running the same rule the audit runs, not by reading the chain.
 *
 * A `hidden` issue is not a finding: it is an input to a ratchet (today only
 * `duplicate-descriptions-desc-only`, which feeds the ≥95 % chrome ratchet and
 * picks the bucket the source-detail pass verifies) and the report never
 * prints it. Counting it here made 55 crawlers WARNING on run 36528331656 with
 * no line under their name to say why. What that signal can prove is proved
 * elsewhere, visibly: the chrome ratchet synthesizes a visible issue, and a
 * bucket whose body the source contradicts becomes a `source-detail-mismatch`.
 */
export function issueDrivenSeverity(entry) {
  const visible = (entry?.issues || []).filter((issue) => !issue?.hidden);
  return visible.length > 0 ? 'WARNING' : 'OK';
}

/**
 * Severity chain of one crawler entry, before the two ratchets. Exported so a
 * replay or a test derives severity with the rule the audit runs instead of a
 * hand-copied subset of it.
 */
export function assignSeverity(entry) {
  const types = new Set(entry.issues.map((i) => i.type));
  const thin = entry.issues.find((i) => i.type === 'thin-description');
  const thinRatio = thin ? thin.count / thin.total : 0;
  const formChromeCount = thin?.reasons?.['form-chrome'] || 0;
  const urlFail = types.has('stale-urls');
  const sourceIssue = entry.issues.find((i) => i.type === 'source-detail-mismatch');
  const sourceProcessingIssue = entry.issues.find((i) => i.type === 'parse-error' && i.processingFailed > 0);
  const detailSeverity = sourceDetailSeverity(entry);
  if (types.has('parse-error')) entry.severity = 'CRITICAL';
  else if (detailSeverity === 'CRITICAL') entry.severity = 'CRITICAL';
  // Form-chrome is a hard signal: even one row means the parser is
  // leaking the surrounding page (form, footer, contact info) into the
  // job description. There is no benign source of these phrases — never
  // a false positive — so skip the ratio gate.
  else if (formChromeCount > 0) entry.severity = 'CRITICAL';
  else if (thinRatio >= 0.5 || (thinRatio > 0 && urlFail)) entry.severity = 'CRITICAL';
  else if (detailSeverity === 'WARNING') entry.severity = 'WARNING';
  else entry.severity = issueDrivenSeverity(entry);
  if (entry.severity === 'CRITICAL') {
    const h = [];
    if (formChromeCount > 0) h.push(`${formChromeCount} description(s) contain form/footer/contact chrome — parser is sweeping page boundaries (most likely an unbounded HTML split). Bound extraction to the per-job DOM subtree`);
    if (thinRatio >= 0.5) h.push('Most descriptions are thin — parser likely scraping nav/boilerplate instead of job content');
    if (urlFail) h.push('Detail URLs returning errors — likely site migration or URL structure change');
    if (sourceIssue?.locationMismatches > 0) h.push('Published locations disagree with sampled source detail pages — inspect the crawler location selector and remove generic-city fallbacks');
    if (sourceIssue?.descriptionMismatches > 0) h.push('Published descriptions are materially shorter or unrelated to sampled source detail pages — bound extraction to the job-detail content');
    if (sourceProcessingIssue) h.push('Source detail pages were fetched but the audit could not process them — inspect the sanitized per-page errors in the JSON report');
    else if (types.has('parse-error')) h.push('Crawler JSON file could not be parsed');
    entry.action = h.join('. ') + '.';
  }
}

export function sourceDetailSeverity(entry) {
  const issue = entry?.issues?.find((candidate) => candidate.type === 'source-detail-mismatch');
  if (issue?.locationMismatches > 0) return 'CRITICAL';
  if (issue?.descriptionMismatches > 0) return 'WARNING';
  return null;
}

const BOILERPLATE_RE = /^(datore di lavoro|als arbeitgeber|come employer|en tant qu.?employeur|as employer)/i;

/**
 * Phrases that only appear when a parser has leaked the surrounding
 * application form, footer, or contact chrome into the per-job description.
 * A real role description never mentions wpcf7 form-element classes,
 * "I agree to the treatment of my personal information", "Attachment: CV
 * in PDF format", "Send your application" headers, or the standard
 * cookie/privacy policy footers.
 *
 * Added 2026-05-18 after the Centiel After-Sales Technician regression:
 * the regex-split parser ran from the last <h3> to end-of-document and
 * swept in the WordPress Contact Form 7 application widget plus the
 * footer's Centiel Global HQ block. None of the existing checks caught
 * it — ~1000 chars of plain-text labels passed both the 100-char minimum
 * and the 15% tag-soup ratio, and 1/5 contaminated rows was below the
 * duplicate-description threshold.
 */
// Each pattern must be a phrase that ONLY appears in a rendered web
// form / footer widget and never inside a legitimate role description or
// PDF instruction text. "Send your application" was rejected — every
// Centiel role PDF ends with "please send your application to hr@..."
// which is legitimate apply-instruction content. The phrases below are
// widget tells (form labels, WordPress Contact Form 7 classes, exact
// placeholder strings) with no legitimate counterpart in role copy.
const FORM_CHROME_PATTERNS = [
  /Attachment\s*:?\s*CV in PDF format,\s*maximum weight/i,
  /I agree to the treatment of my personal information/i,
  /\bwpcf7[-_]/i,
  /\bDesired Position\b.*\bAfter[- ]?Sales\b/i,
  /A brief presentation\s*\*/i,
  /CORPORATE ENQUIRIES/i,
  /Media\s*&\s*Investor Enquiries/i,
];

export function hasFormChrome(desc) {
  const text = plainText(desc);
  return FORM_CHROME_PATTERNS.some((re) => re.test(text));
}

/**
 * Effective description for content-quality checks: prefer descriptionByLocale
 * over the possibly-stale top-level `description` field, mirroring how
 * production actually renders a job (jobPostingSchema.ts, seoService.ts,
 * JobBoard.tsx all read `descriptionByLocale[locale]` first and only fall
 * back to `description` when that locale's slot is empty — never the other
 * way around).
 *
 * Several dedicated-crawler merge functions (mergeJobs/mergePreserveLocaleData)
 * explicitly preserve descriptionByLocale across re-crawls but do NOT protect
 * the top-level `description` field the same way: a transient detail-page
 * scrape failure on a single run resets `description` to the crawler's thin
 * fallback placeholder (e.g. "{title} presso {company}, {city}") while
 * descriptionByLocale keeps the rich content captured by an earlier
 * successful scrape. Auditing the raw `description` field alone then
 * false-positives on jobs that are actually fine in every locale a user or
 * Google ever sees.
 *
 * Found 2026-07-04 (issue #3432): burkhalter-group's "strict" audit flagged
 * 192/243 jobs as thin descriptions; 191 of those had full, non-thin content
 * in all four descriptionByLocale slots — only the legacy top-level field
 * had gone stale.
 *
 * @param {{ description?: string, descriptionByLocale?: Record<string, string> }} job
 * @returns {string}
 */
export function effectiveDescription(job) {
  const byLocale = job?.descriptionByLocale;
  if (byLocale && typeof byLocale === 'object') {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const candidate = byLocale[locale];
      if (candidate && plainText(candidate).length >= 100) return candidate;
    }
  }
  return job?.description || '';
}

function isThinDescription(desc) {
  const text = plainText(desc);
  if (text.length < 100) return 'too-short';
  if (BOILERPLATE_RE.test(text)) return 'boilerplate';
  // Mostly whitespace / tags — if raw is 5x longer than plain, it's tag soup
  if ((desc || '').length > 200 && text.length < (desc || '').length * 0.15) return 'tag-soup';
  // Form/footer/contact chrome leaked from the page surrounding the job.
  // Treated as thin because the actual role content is buried under noise
  // and the page's text-to-content ratio is destroyed.
  if (hasFormChrome(desc)) return 'form-chrome';
  return false;
}

function hasStructuredContent(desc) {
  const text = stripHtml(desc);
  // Bullet points, numbered lists, <li> tags
  if (/<li[\s>]/i.test(desc)) return true;
  if (/^\s*[-•*]\s/m.test(text)) return true;
  if (/^\s*\d+[.)]\s/m.test(text)) return true;
  return false;
}

const EMPTY_LOCALE_PLACEHOLDER_RE = /^(?:[-–—_.*?]+|n\/?a|none|null|undefined|todo|tbd|pending|placeholder|segnaposto|translation pending|pending translation)$/i;

export function filledLocaleCount(byLocale, { minLength = 11 } = {}) {
  if (!byLocale || typeof byLocale !== 'object') return 0;
  return Object.values(byLocale).filter((value) => {
    const text = String(value || '').trim();
    return text.length >= minLength && !EMPTY_LOCALE_PLACEHOLDER_RE.test(text);
  }).length;
}

/**
 * Build per-job fingerprints for duplicate detection.
 *
 * Two modes are supported because the original "all-jobs-share-the-same-500-char
 * description-slice" heuristic (since replaced by the whole body in both
 * modes) conflates two very different parser problems:
 *
 *   1. CHROME SCRAPING — the parser grabs nav/footer/megamenu instead of the
 *      job body, so dozens of UNRELATED jobs (different titles, different
 *      cities) all carry the same prose. This is the Moncucco regression that
 *      motivated the original ratchet.
 *
 *   2. TEMPLATED SOURCES — the source company publishes the same role across
 *      many cities (reboot-monkey: 142 "Data Center Technician — Switzerland —
 *      <city>" listings; lidl-svizzera: 8 apprendistato in 8 filiali;
 *      fielmann: 37 "Augenoptiker (w/m/d)" across 35 Workday store locations).
 *      The body is templated so templated bodies collide. The parser is
 *      doing the right thing — flagging it as a duplicate listing is a false
 *      positive.
 *
 * We separate the two:
 *   - mode 'title-aware'  : title || location || whole body. Catches real
 *                           duplicate listings where multiple postings share the
 *                           same title AND body AT THE SAME LOCATION (bitfinex's
 *                           Recruitee feed publishes 9× the same role; a feed
 *                           re-posting the same store opening). Including the
 *                           location keeps legitimate multi-store retailers
 *                           unflagged EVEN WHEN their title omits the city
 *                           (fielmann's Workday titles are "Augenoptiker (w/m/d)"
 *                           verbatim across every store) — the original
 *                           title-only fingerprint assumed templated sources
 *                           always carry the city in the title, which is false
 *                           for store-chain feeds. Same role at distinct cities →
 *                           distinct fingerprints → not a duplicate. Same role
 *                           re-posted at the same city → still collides → flagged.
 *   - mode 'desc-only'    : the WHOLE normalized body, no slice. Used at a
 *                           stricter threshold to keep chrome-scraping
 *                           detection alive (chrome makes ALL descriptions
 *                           identical regardless of title).
 *
 * Why desc-only no longer shares the title-aware slice: the slice starts at a
 * crawler-wide offset taken from the longest common prefix of ANY adjacent
 * pair (the former `estimateBoilerplateLength`), and that offset was cut from EVERY
 * job, including the jobs that do not start with it. On run 36528331656 the
 * offset was 911 chars on klinik-lengg (two variants of one role) and 2 588 on
 * helvetia, so the 500-char window of the other jobs landed on their shared
 * closing paragraph: 15 of the 55 crawlers WARNING only for this signal had no
 * two jobs with the same body at all (the Praktikum Neuropsychologie and the
 * FaGe apprenticeship "collided" on the clinic's footer). The same offset ran
 * past the end of shorter bodies and emptied their window, so identical bodies
 * went unseen: jumbo had 30 byte-identical bodies and a count of 2. "Identical
 * body regardless of title" is what this signal documents, so it compares the
 * body — the ≥95 % ratchet sees the same maximum on every crawler of that run
 * (54 %, new-yorker) and 119 → 99 crawlers carry the hidden issue.
 *
 * Why title-aware compares the whole body too (run 36571839273): the same
 * crawler-wide offset plus a 500-character window called two postings "the
 * same" when they differed only outside the window. reboot-monkey publishes
 * each Data Center Technician role twice per city, full-time and freelance
 * (`…-on-site` / `…-on-site-1`): the two bodies differ at character 94
 * («this is a full-time» / «this is a freelance»), before the offset, or at
 * character 3 078 (the requirements list), after the window — 28/106
 * "duplicates", none identical. selecta's two «Chauffeur Kat. C und E» at
 * Kirchberg (Job/4600, Job/4601) differ at character 878: shift 05:00-15:00
 * against 12:00-22:00. A posting that differs in its employment type, shift,
 * rate, street address or reference number is another posting; a re-posting
 * is the same text, and the whole text still collides. Measured on the main
 * slices of 2026-09-29: 32 → 26 crawlers flagged; every bucket that splits
 * differs in its body, and no crawler gains a flag (a whole-body match is
 * also a window match, so the new key can only split buckets).
 */
function jobLocationKey(job) {
  return plainText(job?.location || job?.addressLocality || job?.city || '').toLowerCase();
}

export function fingerprintsForCrawler(jobs, mode = 'title-aware') {
  const plain = jobs.map((j) => plainText(j.description).toLowerCase());
  if (mode === 'desc-only') return plain;
  return plain.map((p, i) => {
    // An empty body is no evidence of a re-posting: without it the key is
    // title + location alone.
    if (!p) return '';
    const title = plainText(jobs[i]?.title || '').toLowerCase();
    const location = jobLocationKey(jobs[i]);
    return `${title}||${location}||${p}`;
  });
}

export function countDuplicates(fps) {
  const counts = new Map();
  for (const fp of fps) {
    if (fp.length < 20) continue; // skip empty/tiny
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  return [...counts.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0);
}

function declaredPostalCode(job) {
  return String(job?.postalCode || '').replace(/\s+/g, '').trim();
}

/**
 * Jobs that collide on the title-aware fingerprint AND may be the same
 * posting. The fingerprint's location is the published locality, so two
 * branches of one chain in the same town collapse into one key: denner's
 * «Verkäufer*in» at Basel 4058 and at Basel 4057 (Filiale 524 and 370) were
 * a "duplicate listing" although each posting names its own shop. Two records
 * that declare DIFFERENT postal codes are two workplaces by their own
 * statement, so they are not a re-posting of each other. A record without a
 * postal code proves nothing either way and still collides with everyone in
 * its bucket — that keeps a posting ingested twice, once with and once
 * without an address (banca-cler, interdiscount on run 36528331656), counted.
 */
export function countDuplicateListings(jobs, fps) {
  const buckets = new Map();
  fps.forEach((fp, index) => {
    if (fp.length < 20) return; // skip empty/tiny
    const members = buckets.get(fp);
    if (members) members.push(index);
    else buckets.set(fp, [index]);
  });
  let count = 0;
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    for (const index of members) {
      const own = declaredPostalCode(jobs[index]);
      const samePosting = members.some((other) => {
        if (other === index) return false;
        const theirs = declaredPostalCode(jobs[other]);
        return !own || !theirs || own === theirs;
      });
      if (samePosting) count++;
    }
  }
  return count;
}

/**
 * Size of the largest single fingerprint bucket (most jobs sharing one exact
 * fingerprint). Used by the desc-only chrome-scraping signal instead of
 * countDuplicates()'s cross-bucket sum.
 *
 * Real chrome scraping produces ONE universal blob — every job, regardless of
 * role, collapses into the same nav/footer text — so the largest bucket alone
 * approaches 100%. A retailer running several distinct role templates (e.g.
 * a sales-associate template + a store-manager template) instead produces
 * MULTIPLE separate buckets, each internally legitimate; summing them can
 * still clear a high percentage-of-total threshold even though no single
 * template dominates. New Yorker #3721: 50/55 jobs share one
 * "Verkaufsmitarbeiter" template and 3/55 share a separate "Filialleitung"
 * template — sum 53/55 (96%) tripped the old sum-based ≥95% chrome ratchet,
 * but the largest bucket is only 50/55 (91%), correctly below it.
 */
export function largestDuplicateBucket(fps) {
  return largestDuplicateBucketMembers(fps).length;
}

/**
 * Indices of the jobs in the largest fingerprint bucket (the first one in job
 * order on a tie; a single job when no fingerprint repeats). Same bucket that
 * largestDuplicateBucket() measures — kept as one function so the bucket the
 * source-detail pass verifies is by construction the one the ratchet counts.
 */
export function largestDuplicateBucketMembers(fps) {
  const buckets = new Map();
  fps.forEach((fp, index) => {
    if (fp.length < 20) return; // skip empty/tiny
    const members = buckets.get(fp);
    if (members) members.push(index);
    else buckets.set(fp, [index]);
  });
  let largest = [];
  for (const members of buckets.values()) {
    if (members.length > largest.length) largest = members;
  }
  return largest;
}

export const DUPLICATE_BUCKET_SAMPLE_REASON = 'identical-description-bucket';

/**
 * The job of the largest identical-description bucket that the source-detail
 * pass should fetch, or null when that pass already covers the bucket.
 *
 * Identical bodies under different titles are two different things that the
 * published data alone cannot tell apart: the source publishing one template
 * for many postings (fachkraft's trades, a retailer's stores, tether's two
 * research roles that share one Recruitee text) or the parser writing the same
 * fallback — a company blurb, a listing teaser — for postings whose detail it
 * did not read (engel-voelkers kept only the Lever intro paragraph and
 * published it for its Senior and its Junior broker). Only the source decides,
 * so one member of the bucket goes through the same comparison as the regular
 * sample: a template matches its own page, a fallback is materially shorter
 * than or unrelated to it and becomes a `source-detail-mismatch`.
 *
 * `jobs.slice(0, sampledCount)` is what the regular sample already fetches:
 * a bucket member there is verified already, and a URL fetched there is not
 * fetched twice (the evidence bundle refuses a duplicate request identity).
 */
export function duplicateBucketSourceSample(jobs, fps, regularIndices = regularSourceSampleIndices(jobs)) {
  const members = largestDuplicateBucketMembers(fps);
  if (members.length < 2) return null;
  const regular = new Set(regularIndices);
  if (members.some((index) => regular.has(index))) return null;
  const regularUrls = new Set(regularIndices.map((index) => jobs[index]?.url));
  const index = members.find((candidate) => jobs[candidate]?.url && !regularUrls.has(jobs[candidate].url));
  return index === undefined ? null : { index, bucketSize: members.length };
}

/**
 * Indices of the regular source-detail sample: the first `size` jobs, in
 * slice order, whose URL no earlier sampled job already has. The evidence
 * bundle binds each request by `crawlerKey:sha256(url)` and refuses a
 * duplicate identity; pwc on 2026-09-29 published the same internship twice
 * as its first two jobs (same URL), `jobs.slice(0, 2)` requested it twice and
 * the refused bundle turned all 589 sampled crawlers into CRITICAL
 * parse-errors (run 36562995006). A repeated URL is skipped for the next job.
 */
export function regularSourceSampleIndices(jobs = [], size = SOURCE_DETAIL_SAMPLE_SIZE) {
  const indices = [];
  const urls = new Set();
  for (let index = 0; index < jobs.length && indices.length < size; index += 1) {
    const url = jobs[index]?.url;
    if (!url || urls.has(url)) continue;
    urls.add(url);
    indices.push(index);
  }
  return indices;
}

/**
 * Every source-detail request of one crawler: the regular sample plus, when
 * a body repeats, one member of the largest identical-body bucket. Each URL
 * is requested at most once (see regularSourceSampleIndices), and a posting
 * on a document other postings share (a URL fragment tells them apart) is
 * marked so — its full URL, fragment included, stays its identity. One that
 * only a query tells apart is marked a candidate, confirmed or not by the
 * page it fetches (see pageDeclaresBareDocument).
 */
export function sourceDetailSamplesForCrawler(crawlerKey, jobs = []) {
  const sharedDocuments = sharedSourceDocuments(jobs);
  const queryCandidates = querySharedDocumentCandidates(jobs);
  const sharedDocumentMark = (job) => {
    if (sharedDocuments.has(withoutFragment(job.url))) return { sharedDocument: true };
    const document = bareDocumentUrl(withoutFragment(job.url));
    if (!queryCandidates.has(document)) return {};
    const siblingTitles = [...new Set(jobs
      .filter((other) => other !== job && other?.url !== job.url
        && bareDocumentUrl(withoutFragment(other?.url || '')) === document)
      .map((other) => String(other?.title || '').trim())
      .filter(Boolean))].slice(0, 20);
    return { sharedDocumentCandidate: 'query', siblingTitles };
  };
  const regularIndices = regularSourceSampleIndices(jobs);
  const samples = regularIndices.map((index) => {
    const job = jobs[index];
    return { crawlerKey, job, url: job.url, ...sharedDocumentMark(job) };
  });
  const bucketSample = duplicateBucketSourceSample(jobs, fingerprintsForCrawler(jobs, 'desc-only'), regularIndices);
  if (bucketSample) {
    const job = jobs[bucketSample.index];
    samples.push({
      crawlerKey,
      job,
      url: job.url,
      sampleReason: DUPLICATE_BUCKET_SAMPLE_REASON,
      bucketSize: bucketSample.bucketSize,
      ...sharedDocumentMark(job),
    });
  }
  return samples;
}

/* ── URL checker with concurrency limit ────────────────────── */
async function checkUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'FrontaliereTicino-AuditBot/1.0' },
    });
    return { url, status: res.status, ok: res.ok };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.code || err.message || 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrlsBatch(urls, concurrency = 3) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(checkUrl));
    results.push(...batchResults);
  }
  return results;
}

/* ── Load crawler slices ───────────────────────────────────── */
function loadCrawlerSlices() {
  const files = listSliceFileNames(SLICES_DIR);
  const slices = [];
  for (const file of files) {
    const key = file.replace(/\.json$/, '');
    if (onlyCrawler && key !== onlyCrawler) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SLICES_DIR, file), 'utf8'));
      const storedJobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      const { activeJobs: jobs, excluded } = partitionCrawlerJobsForActiveMetrics(storedJobs);
      slices.push({ key, jobs, storedTotal: storedJobs.length, excluded });
    } catch {
      slices.push({ key, jobs: [], error: 'parse-error' });
    }
  }
  return slices;
}

/* ── Main audit ────────────────────────────────────────────── */
async function main() {
  const provenance = getDatasetProvenance();
  const slices = loadCrawlerSlices();
  console.log(`\nLoaded ${slices.length} crawler slices from ${SLICES_DIR}\n`);
  console.log(
    `Dataset provenance: repo HEAD ${provenance.repoHeadSha || 'unknown'} — ` +
    `data/jobs/by-crawler last touched ${provenance.datasetLastCommit.committedAt || 'unknown'} ` +
    `(${provenance.datasetLastCommit.sha || 'unknown'})\n`,
  );

  /** @type {Record<string, { total: number, population?: object, issues: any[], severity?: string, action?: string }>} */
  const report = {}; // key → { issues[], severity }
  const urlsToCheck = []; // { crawlerKey, url }
  const sourceDetailsToCheck = []; // { crawlerKey, job, url }
  let sourceDetailSummary = null;
  let sourceDetailEvidence = null;

  for (const { key, jobs, storedTotal = jobs.length, excluded = { grace: 0, expired: 0, total: 0 }, error } of slices) {
    const issues = [];
    const population = { stored: storedTotal, active: jobs.length, excluded };

    if (error) {
      issues.push({ type: 'parse-error', message: 'Failed to parse crawler JSON file' });
      report[key] = { total: 0, population, issues, severity: 'CRITICAL' };
      continue;
    }

    if (jobs.length === 0) {
      report[key] = { total: 0, population, issues: [], severity: 'OK' };
      continue;
    }

    // 1. Thin descriptions — checked against the effective (locale-aware)
    // description, not the raw top-level field (see effectiveDescription doc).
    const thinResults = jobs.map((j) => ({ job: j, reason: isThinDescription(effectiveDescription(j)) }));
    const thinJobs = thinResults.filter((r) => r.reason);
    if (thinJobs.length > 0) {
      const reasons = {};
      for (const { reason } of thinJobs) reasons[reason] = (reasons[reason] || 0) + 1;
      const reasonStr = Object.entries(reasons).map(([r, c]) => `${c} ${r}`).join(', ');
      issues.push({
        type: 'thin-description',
        count: thinJobs.length,
        total: jobs.length,
        reasons,
        message: `${thinJobs.length}/${jobs.length} thin descriptions (${reasonStr})`,
      });
    }

    // 2. Missing structured content (only flag when >=80% lack structure and 5+ jobs)
    const nonThinJobs = jobs.filter((j) => !isThinDescription(effectiveDescription(j)));
    const noStructure = nonThinJobs.filter((j) => !hasStructuredContent(effectiveDescription(j)));
    if (nonThinJobs.length >= 5 && noStructure.length / nonThinJobs.length >= 0.8) {
      issues.push({
        type: 'no-structured-content',
        count: noStructure.length,
        total: nonThinJobs.length,
        message: `${noStructure.length}/${nonThinJobs.length} no structured content (no bullets/lists)`,
      });
    }

    // 3. URL reachability (sample first 2)
    if (!skipUrls) {
      const sampled = jobs.slice(0, 2).filter((j) => j.url);
      for (const j of sampled) {
        urlsToCheck.push({ crawlerKey: key, url: j.url });
      }
    }

    if (checkSourceDetails) sourceDetailsToCheck.push(...sourceDetailSamplesForCrawler(key, jobs));

    // 4. Missing locale coverage — skip in-flight translations
    const missingLocales = jobs.filter((j) => {
      if (j.needsRetranslation === true) return false;
      const titleCount = filledLocaleCount(j.titleByLocale, { minLength: 1 });
      const descCount = filledLocaleCount(j.descriptionByLocale);
      return titleCount < 2 || descCount < 2;
    });
    if (missingLocales.length > 0) {
      // Calculate how many locales are missing on average
      const avgMissing = Math.round(
        missingLocales.reduce((s, j) => {
          const have = Math.max(
            filledLocaleCount(j.titleByLocale, { minLength: 1 }),
            filledLocaleCount(j.descriptionByLocale),
          );
          return s + (4 - have);
        }, 0) / missingLocales.length,
      );
      issues.push({
        type: 'missing-locales',
        count: missingLocales.length,
        total: jobs.length,
        avgMissing,
        message: `${missingLocales.length}/${jobs.length} missing ${avgMissing}+ locales`,
      });
    }

    // 5. Duplicate descriptions — strip common company boilerplate prefix first.
    //
    // Title-aware fingerprint catches REAL duplicate listings (same title +
    // same body AT THE SAME LOCATION, e.g. bitfinex's Recruitee feed posting
    // the same role 9× with different IDs). Templated multi-store listings stay
    // unflagged because the fingerprint includes the location — so a retailer
    // posting one role across many cities (fielmann's 37 "Augenoptiker (w/m/d)"
    // across 35 Workday stores) yields distinct fingerprints even though the
    // title is byte-identical and the body templated.
    //
    // The desc-only chrome signal (handled by applyChromeScrapingRatchet
    // below) keeps the original Moncucco-class detection alive — when ALL
    // descriptions are byte-identical regardless of title, the parser is
    // probably grabbing nav/footer chrome instead of the per-job body.
    const fps = fingerprintsForCrawler(jobs, 'title-aware');
    const dupeCount = countDuplicateListings(jobs, fps);
    if (dupeCount > 1) {
      issues.push({
        type: 'duplicate-descriptions',
        count: dupeCount,
        total: jobs.length,
        message: `${dupeCount}/${jobs.length} duplicate descriptions`,
      });
    }

    // 5b. Chrome-scraping signal — identical bodies at a stricter threshold.
    // Stored separately so applyChromeScrapingRatchet() can escalate without
    // double-flagging templated content (which the title-aware check above
    // already filters out). Uses the LARGEST single bucket, not the sum
    // across all colliding buckets — see largestDuplicateBucket() doc: a
    // retailer with multiple distinct role templates can otherwise trip this
    // even though no single template is a universal chrome blob (#3721).
    const fpsDescOnly = fingerprintsForCrawler(jobs, 'desc-only');
    const chromeDupes = largestDuplicateBucket(fpsDescOnly);
    if (chromeDupes > 1) {
      issues.push({
        type: 'duplicate-descriptions-desc-only',
        count: chromeDupes,
        total: jobs.length,
        // No user-facing message and no severity (issueDrivenSeverity skips
        // hidden issues): this issue feeds applyChromeScrapingRatchet() and
        // chooses the bucket the source-detail pass verifies below. Whether
        // the shared body is the source's template or the parser's fallback
        // is decided there, against the source, never from this count.
        message: '',
        hidden: true,
      });
      // Its source-detail sample is requested with the regular one, by
      // sourceDetailSamplesForCrawler (step 3 above).
    }

    report[key] = { total: jobs.length, population, issues };
  }

  if (checkSourceDetails) {
    if (sourceDetailsToCheck.length > 0) {
      console.log(`Checking ${sourceDetailsToCheck.length} source detail pages (concurrency=3)...\n`);
    }
    ({ sourceDetailSummary, sourceDetailEvidence } = await runSourceDetailChecks(
      report,
      sourceDetailsToCheck,
      { provenance },
    ));
    // Print the observability rate on every run: without it, a source-detail
    // pass is indistinguishable from a source-detail no-op, and the next
    // threshold gets tightened on an intuition instead of on this number.
    if (sourceDetailSummary.fetched > 0) {
      const rate = (sourceDetailSummary.unobserved / sourceDetailSummary.fetched * 100).toFixed(1);
      console.log(`Source detail observability: ${sourceDetailSummary.fetched - sourceDetailSummary.unobserved}/${sourceDetailSummary.fetched} fetched pages yielded an observable field (${rate}% proved nothing)`);
    }
    for (const line of formatSourceDetailObservationLines(sourceDetailSummary)) console.log(line);
    const causes = Object.entries(sourceDetailSummary.fetchFailureCauses).sort((a, b) => b[1] - a[1]);
    if (causes.length > 0) {
      console.log(`Source detail fetch failures: ${sourceDetailSummary.fetchFailed}/${sourceDetailSummary.requested} — ${causes.map(([cause, count]) => `${count} ${cause}`).join(', ')}`);
      const level = sourceDetailSummary.sourceLevelFailures;
      console.log(`  explained: ${sourceDetailSummary.expiredVacancies} expired vacancies, ${level.samples} over ${level.sourceCount} source(s) that failed every sampled detail`);
      console.log(`  unexplained: ${sourceDetailSummary.unexplainedFetchFailures}/${sourceDetailSummary.requested} (${sourceDetailSummary.unexplainedFetchFailureRatePct} %, ceiling ${SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT} %)`);
    }
    console.log('');
  }

  // Run URL checks
  if (!skipUrls && urlsToCheck.length > 0) {
    console.log(`Checking ${urlsToCheck.length} URLs (concurrency=3, 5s timeout)...\n`);
    const urlResults = await checkUrlsBatch(urlsToCheck.map((u) => u.url));
    const byKey = {};
    urlsToCheck.forEach(({ crawlerKey }, i) => {
      const r = urlResults[i];
      if (!byKey[crawlerKey]) byKey[crawlerKey] = { checked: 0, failed: 0, details: [] };
      byKey[crawlerKey].checked++;
      if (!r.ok) { byKey[crawlerKey].failed++; byKey[crawlerKey].details.push(`${r.url} -> ${r.status || r.error}`); }
    });
    for (const [key, info] of Object.entries(byKey)) {
      if (info.failed > 0) {
        report[key].issues.push({ type: 'stale-urls', count: info.failed, total: info.checked, details: info.details, message: `${info.failed}/${info.checked} sampled URLs unreachable` });
      }
    }
  }

  // Assign severity + action hints
  for (const entry of Object.values(report)) assignSeverity(entry);

  // ── Ratchet: regression in no-structured-content escalates to CRITICAL ──
  const noStructBaseline = loadNoStructureBaseline();
  const regressions = applyNoStructureRatchet(report, noStructBaseline);
  if (regressions.length > 0) {
    console.log(`\n🛑 No-structure ratchet: ${regressions.length} crawler(s) regressed or newly flat:`);
    for (const r of regressions) console.log(`   ${r.key}: ${r.was} → ${r.now}/${r.total}`);
  }

  // ── Ratchet: duplicate listings (≥80% title-aware) and chrome scraping (≥95% desc-only) ──
  const dupeRegressions = applyDuplicateDescriptionRatchet(report);
  if (dupeRegressions.length > 0) {
    console.log(`\n🛑 Duplicate-description ratchet: ${dupeRegressions.length} crawler(s) regressed:`);
    for (const r of dupeRegressions) {
      const label = r.kind === 'duplicate-listings' ? 'duplicate-listings' : 'chrome-scraping';
      console.log(`   ${r.key}: ${r.count}/${r.total} (${(r.ratio * 100).toFixed(0)}%) — ${label}`);
    }
  }

  // ── Rebaseline mode: write baseline and exit ──
  if (rebaseline) {
    const perCrawler = {};
    for (const [key, entry] of Object.entries(report)) {
      const issue = entry.issues.find((i) => i.type === 'no-structured-content');
      if (issue) perCrawler[key] = { noStructureCount: issue.count, total: issue.total };
    }
    const newBaseline = { generatedAt: new Date().toISOString(), perCrawler };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
    console.log(`\n✓ Baseline written to data/parser-quality-no-structure-baseline.json with ${Object.keys(perCrawler).length} entries.`);
    process.exit(0);
  }

  process.exitCode = finishAudit(report, {
    strict: args.includes('--strict'),
    provenance,
    urlChecksEnabled: !skipUrls,
    sourceDetailChecksEnabled: checkSourceDetails,
    sourceDetailSummary,
    sourceDetailEvidence,
  });
}

/**
 * Print and persist one complete audit result, then return the CLI exit code.
 * Returning instead of calling process.exit() guarantees that a strict
 * failure cannot interrupt the JSON write used by CI diagnostics.
 */
export function finishAudit(report, {
  strict = false,
  outPath = path.join(ROOT, 'data', 'parser-quality-report.json'),
  provenance = { repoHeadSha: null, datasetLastCommit: { sha: null, committedAt: null } },
  urlChecksEnabled = false,
  sourceDetailChecksEnabled = false,
  sourceDetailSummary = null,
  sourceDetailEvidence = null,
} = {}) {
  printReport(report);
  const summary = {
    critical: Object.values(report).filter((r) => r.severity === 'CRITICAL').length,
    warning: Object.values(report).filter((r) => r.severity === 'WARNING').length,
    ok: Object.values(report).filter((r) => r.severity === 'OK').length,
  };
  const jsonReport = {
    timestamp: new Date().toISOString(),
    datasetProvenance: provenance,
    crawlersChecked: Object.keys(report).length,
    urlChecksEnabled,
    sourceDetailChecksEnabled,
    sourceDetailSummary,
    sourceDetailEvidence,
    crawlers: report,
    summary,
  };
  fs.writeFileSync(outPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nJSON report saved to: ${path.relative(ROOT, outPath) || path.basename(outPath)}\n`);
  // The verdict is computed AFTER the JSON is on disk, and every failing
  // condition is collected before returning: an early `return 1` here would
  // hide the second reason from the run that has to act on it.
  const failures = [];
  if (summary.critical > 0) failures.push(`${summary.critical} critical crawler(s) found`);
  if (sourceDetailSummary && sourceDetailSummary.unexplainedFetchFailureRatePct > SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT) {
    failures.push(
      `${sourceDetailSummary.unexplainedFetchFailures}/${sourceDetailSummary.requested} source detail fetches `
      + `(${sourceDetailSummary.unexplainedFetchFailureRatePct} %) failed for reasons neither an expired vacancy `
      + `nor a source-level refusal explains — over the ${SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT} % ceiling`,
    );
  }
  if (strict && failures.length > 0) {
    console.error(`\n❌ --strict: ${failures.join('; ')}. Failing.`);
    return 1;
  }
  return 0;
}

/* ── Print report ──────────────────────────────────────────── */
function printReport(report) {
  const LINE = '\u2550'.repeat(55);
  console.log(`\n${LINE}`);
  console.log('  JOB PARSER QUALITY AUDIT');
  console.log(LINE);

  const critical = Object.entries(report)
    .filter(([, r]) => r.severity === 'CRITICAL')
    .sort((a, b) => b[1].total - a[1].total);

  const warnings = Object.entries(report)
    .filter(([, r]) => r.severity === 'WARNING')
    .sort((a, b) => b[1].total - a[1].total);

  const okCount = Object.values(report).filter((r) => r.severity === 'OK').length;
  const excluded = Object.entries(report)
    .filter(([, entry]) => Number(entry.population?.excluded?.total) > 0)
    .sort((a, b) => b[1].population.excluded.total - a[1].population.excluded.total);

  if (critical.length > 0) {
    console.log(`\nCRITICAL (parser likely broken):`);
    for (const [key, entry] of critical) {
      console.log(`  ${key} (${entry.total} jobs):`);
      for (const issue of entry.issues) {
        if (issue.hidden) continue;
        console.log(`    \u274C ${issue.message}`);
      }
      if (entry.action) {
        console.log(`    \u2192 ACTION: ${entry.action}`);
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`\nWARNING (data quality issues):`);
    for (const [key, entry] of warnings) {
      console.log(`  ${key} (${entry.total} jobs):`);
      for (const issue of entry.issues) {
        if (issue.hidden) continue;
        console.log(`    \u26A0\uFE0F ${issue.message}`);
      }
    }
  }

  console.log(`\nOK: ${okCount} crawlers passing all checks`);

  if (excluded.length > 0) {
    const excludedTotal = excluded.reduce((sum, [, entry]) => sum + entry.population.excluded.total, 0);
    console.log(`\nExcluded from active-quality metrics: ${excludedTotal} non-active record(s)`);
    for (const [key, entry] of excluded) {
      const { grace, expired } = entry.population.excluded;
      console.log(`  ${key}: ${entry.population.active}/${entry.population.stored} active, ${grace} grace, ${expired} expired`);
    }
  }

  const total = Object.keys(report).length;
  console.log(`\n${total} crawlers checked, ${critical.length} critical, ${warnings.length} warnings`);

}

export { stripHtml };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
