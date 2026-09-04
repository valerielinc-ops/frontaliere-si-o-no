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
import { extractDetailFields, extractJsonLd } from './lib/prospector/extract.mjs';
import { readAttr } from './lib/html-attr.mjs';
import { mapPool, politeFetch } from './lib/prospector/polite-fetch.mjs';
import { partitionCrawlerJobsForActiveMetrics } from './lib/crawler-job-activity.mjs';
import {
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
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');
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
]);
const LOCATION_NOISE_TOKENS = new Set([
  'ch', 'che', 'suisse', 'schweiz', 'svizzera', 'switzerland',
  'ag', 'ai', 'ar', 'be', 'bl', 'bs', 'fr', 'ge', 'gl', 'gr', 'ju', 'lu',
  'ne', 'nw', 'ow', 'sg', 'sh', 'so', 'sz', 'tg', 'ti', 'ur', 'vd', 'vs',
  'zg', 'zh', 'gva', 'gt', 'country', 'region', 'canton', 'sede',
  'headquarter', 'headquarters', 'office', 'plant', 'site',
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

function canonicalLocationTokens(value) {
  const tokens = normalizePlace(value).split(' ').filter(Boolean)
    .map((token) => LOCATION_TOKEN_ALIASES.get(token) || token)
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

function hasCoherentCantonSuffix(value, locality) {
  if (locality.length === 0 || value.length <= locality.length) return false;
  if (!locality.every((token, index) => value[index] === token)) return false;
  return SWISS_REGION_NAMES.has(value.slice(locality.length).join(' '));
}

function isUsableSourceLocation(value) {
  const normalized = normalizePlace(value);
  if (!normalized || SOURCE_LOCATION_PLACEHOLDERS.has(normalized)) return false;
  return canonicalLocationTokens(value).some((token) => token.length >= 3);
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
  for (const publishedCandidate of publishedCandidates) {
    const publishedTokens = canonicalLocationTokens(publishedCandidate);
    if (!publishedTokens.length) continue;
    for (let sourceIndex = 0; sourceIndex < sourceCandidates.length; sourceIndex++) {
      const rawSourceCandidate = sourceCandidates[sourceIndex];
      const sourceTokens = canonicalLocationTokens(rawSourceCandidate);
      if (!sourceTokens.length) continue;
      const publishedHasPostalCode = /\b\d{4,5}\b/.test(publishedCandidate);
      const candidateHasPostalCode = /\b\d{4,5}\b/.test(rawSourceCandidate);
      // In structured `city, canton` values, a published city must not pass only
      // because it equals the trailing canton (Zürich vs Winterthur, Zürich).
      if (sourceIndex > 0 && tokensEqual(sourceTokens, publishedTokens)
        && !candidateHasPostalCode && SWISS_REGION_NAMES.has(publishedTokens.join(' '))) continue;
      if (tokensEqual(sourceTokens, publishedTokens)) return true;
      if (candidateHasPostalCode && endsWithTokens(sourceTokens, publishedTokens)) return true;
      if (publishedHasPostalCode && endsWithTokens(publishedTokens, sourceTokens)) return true;
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

/**
 * Return a location only together with the markup scope that makes it
 * authoritative. This prevents a generic footer `addressLocality` from being
 * promoted merely because a different job-scoped location exists later.
 */
export function extractSourceLocationObservation(html = '', pageUrl = '') {
  const structured = extractJsonLd(html, pageUrl).find((item) => isUsableSourceLocation(item.location));
  if (structured) return { location: structured.location, evidence: 'jsonld' };

  const stack = [];
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
      if (isUsableSourceLocation(location)) return { location, evidence: 'strong-markup' };
    }

    if (!VOID_HTML_TAGS.has(tagName) && !/\/\s*$/.test(attrs)) stack.push({ tagName, jobScoped, blocked });
  }
  return { location: '', evidence: 'generic' };
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

const LISTING_WORKPLACE_OVER_ADMIN_JSONLD = new Set([
  // Solique exposes the workplace in its listing API, while ktzh detail
  // JSON-LD can contain the administrative district office instead. Require
  // the rendered job title to corroborate the listing value before preferring
  // it, so an actually wrong listing location still fails the audit.
  'kanton-zuerich',
]);

function titleCorroboratesPublishedLocation(title, publishedLocation) {
  const normalizedTitle = normalizePlace(title);
  const normalizedLocation = normalizePlace(publishedLocation);
  if (!normalizedTitle || normalizedLocation.length < 2) return false;
  return ` ${normalizedTitle} `.includes(` ${normalizedLocation} `);
}

export function compareSourceDetail(job, detail, {
  locationEvidence = 'jsonld',
  locationPolicy = 'source-detail',
} = {}) {
  const publishedLocation = job?.addressLocality || job?.location || '';
  const sourceLocation = detail?.location || '';
  const publishedDescription = plainText(sourceDescription(job));
  const sourceDescriptionText = plainText(detail?.description || '');
  const publishedWords = wordSet(publishedDescription);
  const sourceWords = wordSet(sourceDescriptionText);
  let overlap = 0;
  for (const word of publishedWords) if (sourceWords.has(word)) overlap++;
  const listingWorkplaceCorroborated = locationPolicy === 'listing-workplace-over-admin-jsonld'
    && locationEvidence === 'jsonld'
    && titleCorroboratesPublishedLocation(detail?.title || '', publishedLocation);
  const locationMatchesPublished = sourceLocationMatches(publishedLocation, sourceLocation)
    || listingWorkplaceCorroborated;
  const locationChecked = Boolean(publishedLocation)
    && isUsableSourceLocation(sourceLocation)
    && locationEvidence !== 'generic';
  const observation = {
    location: {
      checked: locationChecked,
      matchesPublished: locationMatchesPublished,
      inconclusive: Boolean(sourceLocation) && !locationChecked,
      evidence: locationEvidence,
      authority: listingWorkplaceCorroborated ? 'listing-workplace' : 'source-detail',
      published: publishedLocation,
      source: sourceLocation,
    },
    description: {
      publishedDescriptionLength: publishedDescription.length,
      sourceDescriptionLength: sourceDescriptionText.length,
      publishedWordCount: publishedWords.size,
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

export async function checkSourceDetailsBatch(items, concurrency = 3, {
  fetchPage = politeFetch,
  extractDetail = extractDetailFields,
  observeLocation = extractSourceLocationObservation,
  evidenceContext = null,
} = {}) {
  const results = await mapPool(items, concurrency, async (item) => {
    let fetched;
    try {
      fetched = await fetchPage(item.url, { timeoutMs: 10000, retries: 1 });
    } catch (error) {
      return { ...item, fetchFailed: true, status: 0, fetchError: sanitizeProcessingError(error) };
    }
    if (!fetched.ok || !fetched.body) return { ...item, fetchFailed: true, status: fetched.status || 0 };
    try {
      const detail = extractDetail(fetched.body, fetched.url || item.url);
      const locationObservation = observeLocation(fetched.body, fetched.url || item.url);
      if (locationObservation.location) detail.location = locationObservation.location;
      const locationEvidence = locationObservation.evidence;
      const locationPolicy = LISTING_WORKPLACE_OVER_ADMIN_JSONLD.has(item.crawlerKey)
        ? 'listing-workplace-over-admin-jsonld'
        : 'source-detail';
      const comparison = compareSourceDetail(item.job, detail, { locationEvidence, locationPolicy });
      const sourceDetailEvidence = evidenceContext
        ? createSourceDetailEvidence({
          crawlerKey: item.crawlerKey,
          sourceUrl: fetched.url || item.url,
          body: fetched.body,
          observation: comparison.replayObservation,
          provenance: evidenceContext.provenance,
          versions: evidenceContext.versions,
        })
        : null;
      return { ...item, ...comparison, ...(sourceDetailEvidence ? { sourceDetailEvidence } : {}) };
    } catch (error) {
      return processingFailureResult(item, error);
    }
  });
  return results.map((result, index) => result
    ?? processingFailureResult(items[index], new Error('worker returned no result')));
}

export function applySourceDetailResults(report, sourceResults, requested = sourceResults.length) {
  const sourceDetailSummary = {
    requested,
    fetched: 0,
    fetchFailed: 0,
    processingFailed: 0,
    authoritativeLocationChecks: 0,
    locationMatches: 0,
    locationMismatches: 0,
    inconclusiveLocationObservations: 0,
    descriptionMismatches: 0,
  };
  const byKey = {};
  for (const result of sourceResults) {
    const key = result.crawlerKey;
    if (!byKey[key]) byKey[key] = {
      checked: 0, fetchFailed: 0, processingFailed: 0, processingErrors: [],
      locationChecked: 0, locationInconclusive: 0, locationMismatches: 0,
      descriptionMismatches: 0, details: [],
    };
    const info = byKey[key];
    const sourceReference = sourceDetailReportReference(result.url);
    info.checked++;
    if (result.fetchFailed) {
      info.fetchFailed++;
      sourceDetailSummary.fetchFailed++;
      continue;
    }
    if (result.processingFailed) {
      info.processingFailed++;
      sourceDetailSummary.processingFailed++;
      info.processingErrors.push(`${sourceReference}: ${result.processingError}`);
      continue;
    }
    sourceDetailSummary.fetched++;
    if (result.locationChecked) {
      info.locationChecked++;
      sourceDetailSummary.authoritativeLocationChecks++;
      if (result.locationMismatch) sourceDetailSummary.locationMismatches++;
      else sourceDetailSummary.locationMatches++;
    } else if (result.locationInconclusive) {
      info.locationInconclusive++;
      sourceDetailSummary.inconclusiveLocationObservations++;
    }
    if (result.locationMismatch) {
      info.locationMismatches++;
      info.details.push(`${sourceReference}: published "${result.publishedLocation || 'empty'}", source "${result.sourceLocation}" [${result.locationEvidence}]`);
    }
    if (result.descriptionMismatch) {
      info.descriptionMismatches++;
      sourceDetailSummary.descriptionMismatches++;
      info.details.push(`${sourceReference}: published description ${result.publishedDescriptionLength} chars, source ${result.sourceDescriptionLength} chars`);
    }
  }
  for (const [key, info] of Object.entries(byKey)) {
    const entry = report[key] || (report[key] = { total: 0, issues: [] });
    if (info.processingFailed > 0) {
      entry.issues.push({
        type: 'parse-error', count: info.processingFailed, total: info.checked,
        processingFailed: info.processingFailed, details: info.processingErrors,
        message: `${info.processingFailed}/${info.checked} source detail pages failed during local processing`,
      });
      entry.severity = 'CRITICAL';
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
  return sourceDetailSummary;
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
  const evidenceContext = {
    provenance,
    versions,
    requestedCount: sourceDetailsToCheck.length,
    requestedSamples: sourceDetailsToCheck.map(({ crawlerKey, url }) => ({ crawlerKey, url })),
  };
  const sourceResults = await checkBatch(sourceDetailsToCheck, concurrency, { evidenceContext });
  return {
    sourceDetailSummary: applySourceDetailResults(
      report,
      sourceResults,
      sourceDetailsToCheck.length,
    ),
    sourceDetailEvidence: finalizeSourceDetailEvidence(report, sourceResults, evidenceContext),
  };
}

/** Source-detail portion of the audit's shared severity contract. */
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

function descFingerprint(desc) {
  return plainText(desc).toLowerCase().slice(0, 500);
}

/**
 * Estimate the length of a shared boilerplate prefix across jobs of the same
 * crawler. We sort plain-text descriptions and take the longest common prefix
 * of any adjacent pair: if the crawler leaks a company intro into every job,
 * that intro will show up as a long prefix on most neighbouring pairs.
 *
 * We only strip the prefix when it looks like real boilerplate — short enough
 * compared to the full description. If a pair is essentially identical end to
 * end (prefix ≈ description length), those are real duplicates and should be
 * flagged, not masked.
 */
function estimateBoilerplateLength(plain) {
  if (plain.length < 2) return 0;
  const sorted = [...plain].sort();
  let maxPrefix = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const max = Math.min(a.length, b.length);
    let j = 0;
    while (j < max && a.charCodeAt(j) === b.charCodeAt(j)) j++;
    // Guard: if the pair is nearly identical end-to-end, treat as a real
    // duplicate (don't let it inflate the boilerplate estimate).
    if (j >= Math.min(a.length, b.length) * 0.9) continue;
    if (j > maxPrefix) maxPrefix = j;
  }
  return maxPrefix;
}

/**
 * Build per-job fingerprints for duplicate detection.
 *
 * Two modes are supported because the original "all-jobs-share-the-same-500-char
 * description-slice" heuristic conflates two very different parser problems:
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
 *      The body is templated so post-boilerplate slices collide. The parser is
 *      doing the right thing — flagging it as a duplicate listing is a false
 *      positive.
 *
 * We separate the two:
 *   - mode 'title-aware'  : title || location || desc-slice. Catches real
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
 *   - mode 'desc-only'    : the original desc-only slice. Used at a stricter
 *                           threshold to keep chrome-scraping detection alive
 *                           (chrome makes ALL descriptions identical regardless
 *                           of title).
 */
function jobLocationKey(job) {
  return plainText(job?.location || job?.addressLocality || job?.city || '').toLowerCase();
}

export function fingerprintsForCrawler(jobs, mode = 'title-aware') {
  const plain = jobs.map((j) => plainText(j.description).toLowerCase());
  const boilerLen = estimateBoilerplateLength(plain);
  // Only strip when the boilerplate is long enough to be meaningful and not
  // so long that stripping it leaves no signal.
  const stripLen = boilerLen >= 120 ? Math.max(boilerLen - 20, 0) : 0;
  return plain.map((p, i) => {
    const slice = p.slice(stripLen, stripLen + 500);
    if (mode === 'title-aware') {
      const title = plainText(jobs[i]?.title || '').toLowerCase();
      const location = jobLocationKey(jobs[i]);
      return `${title}||${location}||${slice}`;
    }
    return slice;
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
  const counts = new Map();
  for (const fp of fps) {
    if (fp.length < 20) continue; // skip empty/tiny
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) {
    if (c > max) max = c;
  }
  return max;
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

    if (checkSourceDetails) {
      const sampled = jobs.slice(0, SOURCE_DETAIL_SAMPLE_SIZE).filter((j) => j.url);
      for (const job of sampled) sourceDetailsToCheck.push({ crawlerKey: key, job, url: job.url });
    }

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
    const dupeCount = countDuplicates(fps);
    if (dupeCount > 1) {
      issues.push({
        type: 'duplicate-descriptions',
        count: dupeCount,
        total: jobs.length,
        message: `${dupeCount}/${jobs.length} duplicate descriptions`,
      });
    }

    // 5b. Chrome-scraping signal — desc-only slice at a stricter threshold.
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
        // No user-facing message: this issue exists only to feed
        // applyChromeScrapingRatchet(). We don't render warnings for it.
        message: '',
        hidden: true,
      });
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
  for (const entry of Object.values(report)) {
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
    else if (entry.issues.length > 0) entry.severity = 'WARNING';
    else entry.severity = 'OK';
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
  if (strict && summary.critical > 0) {
    console.error(`\n❌ --strict: ${summary.critical} critical crawler(s) found. Failing.`);
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
