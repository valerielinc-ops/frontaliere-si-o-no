/**
 * Standard Crawler Template — runStandardCrawlerPipeline()
 *
 * THE ONLY SANCTIONED WAY to build a new job crawler.
 * All new crawlers MUST use this template. Do not copy-paste Rapelli or other old crawlers.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE — 7-step pipeline
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Step 0: Init          — Timer, summary guard, banner
 *   Step 1: Snapshot      — Read existing jobs from per-crawler slice
 *   Step 2: Fetch         — Call parser's fetchJobs() to get source-locale jobs
 *   Step 3: Merge         — mergePreserveLocaleData() preserves translations + slug stability
 *   Step 4: Diff          — Report new/updated/removed/unchanged counts
 *   Step 5: AI Localize   — Translate titles+descriptions to 4 locales via AI
 *   Step 6: Validate      — Check locale coverage, trusted domains, slug quality
 *   Step 7: Slice+Assemble — Write per-crawler slice → assemble global dataset
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SLUG STABILITY — Critical invariants (lessons learned from production bugs)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. The parser sets ONLY source-locale slug: `slugByLocale: { [sourceLang]: slug }`
 *    Other locale slugs are derived by the AI localization step or translate-pending.
 *
 * 2. mergePreserveLocaleData preserves slugByLocale from previous runs.
 *    Never regenerate slugs unconditionally — use isSlugStable() for comparison.
 *
 * 3. writeJobsCrawlerSlice (in assemble-jobs-dataset.mjs) has a FINAL safety net
 *    that strips any previousSlug that matches an active slug. This prevents
 *    self-redirecting bridge pages.
 *
 * 4. The housekeeping step (cleanup-jobs.mjs) auto-skips locale hardening when
 *    JOBS_HOUSEKEEPING_SCOPE is set — avoids double-hardening in separate processes.
 *
 * 5. regenerate-slugs-by-locale.mjs (Phase 3 of translate-pending) also has
 *    a safety net. ALL code paths that write to slice files MUST sanitize
 *    previousSlugs before writing.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CREATING A NEW CRAWLER — 3 files + 1 manifest entry
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. PARSER — scripts/lib/{company-key}-job-parser.mjs
 *    Must export: COMPANY_KEY, COMPANY_NAME, fetchAll{PascalKey}Jobs(),
 *    is{PascalKey}Job(), isTrustedDomain(). Optional: COMPANY_DOMAIN, matchKey().
 *    Import slugify, stripHtml, normalizeSpace from this template — don't duplicate.
 *    See scripts/lib/hopital-du-valais-job-parser.mjs as reference (first template user).
 *
 * 2. RUNNER — scripts/update-{company-key}-jobs.mjs
 *    ~30 lines: imports parser + this template, calls runStandardCrawlerPipeline().
 *
 * 3. WORKFLOW STEPS — data/crawler-manifest.json entry (NOT a standalone
 *    workflow file — consolidation, 2026-07). scaffold-crawler.mjs upserts an
 *    entry describing the dispatch, node setup, crawler run, housekeeping,
 *    commit+push steps into the shared manifest; run
 *    `node scripts/generate-crawler-group-workflows.mjs` afterwards to fold
 *    the new crawler into one of the 23 `.github/workflows/crawler-group-*.yml`
 *    workflows (each bundles ~25 crawlers as concurrent background steps in
 *    ONE job — see that script's header for why).
 *
 * 4. TEST — tests/{company-key}-crawler.test.ts
 *    Parser unit tests: validates job shape, slug format, isCompanyJob(), etc.
 *
 * Use `node scripts/scaffold-crawler.mjs {company-key}` to generate the
 * parser/runner/test + upsert the manifest entry, then run
 * `node scripts/generate-crawler-group-workflows.mjs` to regenerate the
 * group workflows.
 *
 * IMPORTANT: After building the parser, always verify generated URLs by opening
 * them in a browser. SPA career portals (ServiceNow, Workday, SuccessFactors)
 * often require extra path segments or tokens beyond the job ID — without them
 * the URL may silently redirect to the homepage instead of showing the job.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ParsedJob CONTRACT — What fetchJobs() must return
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Each job from fetchJobs() must have these fields (source locale only):
 *
 *   REQUIRED:
 *     id             — Unique stable ID: '{companyKey}-{hash}' (hash from URL or unique field)
 *     slug           — Source-locale slug: slugify(title + company + location)
 *     slugByLocale   — { [sourceLang]: slug } — ONLY source locale, others filled by pipeline
 *     company        — Company display name (e.g. 'Lonza')
 *     companyKey     — Kebab-case key matching COMPANY_KEY (e.g. 'lonza')
 *     title          — Job title in source language
 *     titleByLocale  — { [sourceLang]: title }
 *     description    — Job description text (HTML stripped)
 *     descriptionByLocale — { [sourceLang]: description }
 *     location       — City name (e.g. 'Visp', 'Lugano')
 *     canton         — Swiss canton code ('TI', 'VS', 'GR', etc.)
 *     url            — Canonical job URL on the company's career site.
 *                      MUST be a URL that actually resolves to the job page when
 *                      opened in a browser. Always verify by navigating to it —
 *                      SPA portals (e.g. ServiceNow UXF) may require extra path
 *                      segments or parameters beyond the job ID.
 *     source         — Parser attribution string
 *     sourceLang     — ISO 639-1 code: 'it', 'en', 'de', 'fr'
 *     crawledAt      — ISO 8601 timestamp
 *
 *   RECOMMENDED:
 *     companyDomain  — Company domain (e.g. 'lonza.com')
 *     addressLocality — Same as location
 *     postalCode     — Swiss postal code (e.g. '6900'). Fallback: '6900' (Lugano)
 *     addressRegion  — Canton code (same as canton, e.g. 'TI')
 *     addressCountry — 'CH'
 *     country        — 'CH'
 *     category       — Job category (e.g. 'Ingegneria', 'Amministrazione')
 *     contract       — 'full-time' or 'part-time'
 *     employmentType — Schema.org type: 'FULL_TIME', 'PART_TIME', 'OTHER'
 *     experienceLevel — 'junior', 'mid', 'senior', 'intern'
 *     sector         — Industry sector
 *     currency       — 'CHF'
 *     postedDate     — ISO date string (YYYY-MM-DD)
 *     applyUrl       — Direct application URL
 *     featured       — Boolean (default false)
 *     slugDisambiguator — Stable suffix for companies with duplicate title+company+location
 *                         jobs. Use stableSlugHash(job) from dedicated-crawler-common.mjs
 *                         or a deterministic ID prefix (e.g. first 8 chars of a UUID from
 *                         the job URL). The pipeline (hardenJobLocaleFields, regenerate-
 *                         slugs-by-locale) re-appends this suffix whenever it rebuilds
 *                         slugs, preventing churn. Only needed when the same company posts
 *                         identical-title roles in the same city.
 *
 *   NEVER SET BY PARSER (filled by pipeline):
 *     titleByLocale.{otherLocale}
 *     descriptionByLocale.{otherLocale}
 *     slugByLocale.{otherLocale}
 *     previousSlugs / previousSlugsByLocale
 *     needsRetranslation
 *     qualityScore
 */
import fs from 'node:fs';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import path from 'node:path';
import { crawlerScratchPathFor } from './crawler-scratch-path.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from '../jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from '../assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
  detectLang,
  deriveLocalizedSlug,
} from './dedicated-crawler-common.mjs';
import { archiveRemovedJobsToSlice } from './expired-jobs-archive.mjs';
import {
  RETRYABLE_STATUS,
  WAF_IP_BLOCK_STATUS,
  isTransientFetchError,
  isConnectionLevelFetchError,
  fetchWithRetry,
} from './transient-fetch.mjs';
import { fetchHtmlViaJinaWithRetry, rescueHtmlIfChallenged } from './jina-proxy.mjs';

// Re-export the shared transient-fetch primitives so existing importers of
// crawler-template keep working and the ATS clients share one classifier.
export { RETRYABLE_STATUS, WAF_IP_BLOCK_STATUS, isTransientFetchError, isConnectionLevelFetchError, fetchWithRetry };

/* ── Shared Utilities (re-exported for parser convenience) ──────────── */

/**
 * Standard slugify function. Parsers should use this to build slugs
 * consistently (lowercase, diacritics stripped, alphanumeric+dash only).
 * Trims at word boundary when the cap would split a token.
 */
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

export function slugify(text = '', maxLength = 90) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(base, maxLength);
}

/**
 * Build a standard job slug: title-company-location.
 * The result is a clean kebab-case string — no mandatory suffix convention.
 */
export function buildJobSlug(title, companySuffix, maxLength = 90) {
  return slugify(`${title} ${companySuffix}`, maxLength);
}

/**
 * Collapse whitespace runs into single spaces and trim.
 * 87 parsers duplicate this — import from here instead.
 */
export function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a regex fragment matching a `class` attribute that carries `token`
 * (a regex alternation like `tasks` or `tasks|profile`) as a whole class name,
 * tolerant of quote style and multi-class lists. Matches `class="tasks"`,
 * `class='tasks'`, `class=tasks`, `class="tasks col-6"`, `class="col-6 tasks"`.
 *
 * Shared selector helper for dedicated crawler parsers (Solique, Dualoo
 * tenants, jobalino, …): a vendor markup tweak (extra utility class, single
 * quotes, attr reorder) must NOT silently match nothing → '' → thin-source
 * fail → degraded/de-indexed JobPosting. Centralized here so the four+ parsers
 * that share this construct cannot drift (issue #2118 / PR #2149).
 *
 * @param {string} token regex alternation of whole class names
 * @returns {string} a regex fragment (no anchors; embed inside a larger pattern)
 */
export function classAttrRx(token) {
  return `class=["']?[^"'>]*\\b(?:${token})\\b`;
}

/**
 * Bullet-preserving normalizer for descriptions.
 *
 * Collapses runs of spaces/tabs to a single space but PRESERVES newline
 * structure, so `\n• item` lines extracted from `<li>` tags by `stripHtml`
 * survive into the final output. Use this instead of `normalizeSpace` when
 * normalizing multi-line content (descriptions, detail-page bodies).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeDescriptionSpace(value = '') {
  return String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Restore line-start bullet markers in job descriptions.
 *
 * The audit's `hasStructuredContent` requires bullets to be at line-start
 * (`/^\s*[-•*]\s/m`). HTML→text pipelines often produce inline bullets
 * (`Aufgaben: • Item • Item`) when downstream `normalizeSpace`/`stripHtml`
 * collapses newlines, OR multi-paragraph "list" sections (header followed
 * by ≥3 short consecutive lines) without explicit bullet markers.
 *
 * This helper:
 *   1. Inserts `\n` before every inline `•` (idempotent — already-line-start
 *      bullets are left alone).
 *   2. If still no line-start bullet found, scans for runs of ≥3 consecutive
 *      non-empty lines ≤200 chars (typical "PROFILE / Requirements" lists)
 *      and prepends `• ` to each item. The first short line of a run is
 *      treated as a section heading and left bullet-free.
 *
 * Idempotent: safe to call multiple times. Returns input unchanged when
 * structure is already present or input is empty/non-string.
 *
 * @param {string} text
 * @returns {string}
 */
// Common job-posting section headers across IT/DE/FR/EN. When these appear
// inline inside a flattened description, we insert a paragraph break so the
// text-to-list normalizer below has line boundaries to work with.
const SECTION_HEADER_PATTERNS = [
  // German (Swiss federal job postings — jobs.admin.ch, Prospective.ch JobBooster)
  /\b(Diesen Beitrag kannst du leisten|Das macht dich einzigartig|Das bieten wir|Dein Einsatz für Sicherheit und Freiheit|Ihre Aufgaben|Ihr Profil|Wir bieten|Anforderungen|Aufgaben|Ihre Hauptaufgaben|Ihre Verantwortung|Was Sie erwartet|Was wir bieten|Ihre Qualifikationen|Ihr neues Aufgabengebiet)\b/g,
  // Italian (EOC, AIL, etc.)
  /\b(Le sue mansioni|Le tue mansioni|I suoi compiti|I tuoi compiti|Il profilo richiesto|Profilo richiesto|Profilo ricercato|Requisiti necessari|Requisiti richiesti|Requisiti|Offriamo|Cosa offriamo|Le sue responsabilità|Le tue responsabilità|Cosa farà|Mansioni principali|Competenze richieste|Cerchiamo|Stiamo cercando)\b/g,
  // French
  /\b(Vos tâches|Vos missions|Votre mission|Votre profil|Nous offrons|Nous proposons|Vos responsabilités|Vos compétences|Profil recherché|Exigences|Compétences requises)\b/g,
  // English
  /\b(Your responsibilities|Your tasks|Your profile|We offer|What we offer|Requirements|Qualifications|What you'll do|What you bring|Job description|Profile|Responsibilities)\b/g,
];

export function normalizeDescriptionBullets(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // 1. Inline ' • ' → '\n• ' (only when not already line-start)
  out = out.replace(/([^\n\r])[ \t]+•[ \t]+/g, '$1\n• ');
  if (/^\s*[-•*]\s/m.test(out)) return out;

  // 2. When the text is a single-line/long paragraph blob, try to split at
  // known section-header phrases (DE/IT/FR/EN) so the run-detector below has
  // line boundaries. We insert '\n• ' BEFORE the header so the header itself
  // becomes a line-start bulleted item — that satisfies the audit and keeps
  // the original wording intact.
  for (const pattern of SECTION_HEADER_PATTERNS) {
    out = out.replace(pattern, (match, _g1, offset, src) => {
      // Don't double-insert if already at line start
      const prevChar = offset > 0 ? src[offset - 1] : '\n';
      if (prevChar === '\n') return match;
      return `\n• ${match}`;
    });
  }
  if (/^\s*[-•*]\s/m.test(out)) return out;

  // 2. Detect runs of ≥3 consecutive non-empty short lines (≤200 chars)
  const lines = out.split(/\n/);
  const inRun = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || t.length > 200) { i++; continue; }
    let j = i;
    while (j < lines.length) {
      const tj = lines[j].trim();
      if (!tj || tj.length > 200) break;
      j++;
    }
    if (j - i >= 3) {
      for (let k = i; k < j; k++) inRun[k] = true;
    }
    i = j;
  }

  // First short line of a run = section heading; leave bullet-free.
  let prevWasInRun = false;
  for (let k = 0; k < lines.length; k++) {
    if (!inRun[k]) { prevWasInRun = false; continue; }
    const t = lines[k].trim();
    if (!prevWasInRun && t.length <= 35 && !/[.!?]$/.test(t)) {
      // section heading — keep as-is
      prevWasInRun = true;
      continue;
    }
    lines[k] = lines[k].replace(t, '• ' + t);
    prevWasInRun = true;
  }
  return lines.join('\n');
}

/**
 * Idempotent clean-up of crawler artifacts in job descriptions. Runs at
 * assemble-time (`scripts/assemble-jobs-dataset.mjs`) alongside
 * `normalizeDescriptionBullets`. Defensive against malformed input from
 * AI translation: drops empty `**...**` bolds, strips standalone separator
 * lines (`______`, `=====`), strips trailing inline separator runs, and
 * dedupes consecutive identical paragraphs.
 *
 * Mirrors the runtime parser in `build-plugins/shared/jobDescription/parser.ts`
 * but operates on raw text BEFORE the renderer parses. Cleaning here keeps
 * the assembled dataset (`data/jobs.json`) tidy without rewriting every
 * by-crawler source file.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanCrawlerArtifacts(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. Drop empty / whitespace-only bolds (e.g. "** **", "**  **", "** : **")
  s = s.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');
  // 1a. Odd `**` count (source truncated the closing marker) survives the
  // pair-matching replace above untouched — same gap guarded in the runtime
  // parser (build-plugins/shared/jobDescription/parser.ts) and
  // free-translate.mjs; mirrored here so a stray marker can't reach
  // data/jobs.json even before any renderer runs (#4553).
  const doubleStars = (s.match(/\*\*/g) || []).length;
  if (doubleStars % 2 !== 0) {
    s = s.replace(/\*\*/g, '');
  }

  // 1b. Convert mid-line separator runs (3+ `_`/`=`/`~`) to paragraph breaks.
  // AI-translation flattening occasionally collapses paragraph boundaries
  // around visual dividers, producing patterns like
  // `Ref.: HFR-M-251801 _______________________________________ Le Département…`
  // on a single line. Step 2 below only catches WHOLE separator-only lines,
  // step 3 only TRAILING runs — neither catches mid-line. Splitting here
  // restores the original paragraph structure so the rest of the pipeline
  // (and audit:no-literal-markdown, CLAUDE.md rule #1, 0-tolerance) stays
  // clean even when the runtime parser is bypassed. Was `{6,}` — stale vs.
  // the `{3,}` threshold `scripts/audit-no-literal-markdown.mjs`
  // (SEPARATOR_RUN_RE) and every other stripper in this codebase
  // (jobDescription/parser.ts, jobDescription/toHtml.ts,
  // jobsSeoPagesPlugin.ts) actually use, so a 3-5 char mid-line run leaked
  // through unconverted (audit regression #4593, sibling-pattern fix per
  // CLAUDE.md non-negotiable #6).
  s = s.replace(/[_=~]{3,}/g, '\n\n');

  // 2. Strip standalone separator-only lines ("______", "===", "----")
  s = s
    .split('\n')
    .filter((line) => !/^[\s_\-=*•·~]{3,}$/.test(line))
    .join('\n');

  // 3. Strip trailing inline separator runs ("Be part of something. ______")
  s = s
    .split('\n')
    .map((line) => line.replace(/\s+[_\-=~*]{3,}\s*$/g, '').trimEnd())
    .join('\n');

  // 4. Truncate at first inline JS widget signature. SAP SF, TYPO3 ke_search,
  // Freeform widgets and similar parsers occasionally leak `<script>` content
  // when callers strip tags without first deleting `<script>...</script>`
  // blocks. The body text starts with the JS source which the
  // validate-jobs-quality gate flags as code_in_description. Cut everything
  // from that boundary onward — defensive mirror of stripHtml() above.
  {
    const fnMatch = s.match(/(?:\n|^|\s)(?:\/\/\s*<!\[CDATA\[|\$\(|jQuery\(|function\s+\w*\s*\(|\(function\s*\()/);
    if (fnMatch && fnMatch.index > 0) s = s.slice(0, fnMatch.index).trimEnd();
    const varMatch = s.match(/(?:\n|^|\s)(?:const|let|var)\s+\w+\s*=\s*(?:window|document|new\s+Object|\{|\[|document\.querySelectorAll|new\s+XMLHttpRequest)/);
    if (varMatch && varMatch.index > 0) s = s.slice(0, varMatch.index).trimEnd();
  }

  // 5. Dedup consecutive identical paragraphs (Panoramica/Descrizione artifact)
  const paragraphs = s.split(/\n{2,}/);
  const out = [];
  const norm = (p) =>
    p
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const seen = new Set();
  for (const p of paragraphs) {
    const t = p.trim();
    if (!t) continue;
    const key = norm(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }

  return out.join('\n\n');
}

// Shared with build-plugins and tests — the implementation lives in a
// zero-dependency module so the vite config graph doesn't inherit crawler deps.
export { stripScriptsAndStyles } from './strip-scripts-styles.mjs';

/**
 * Strip HTML tags and decode common entities. Use for description fields.
 */
export function stripHtml(html = '') {
  const stripped = String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
  // Truncate at first inline JS widget signature — SAP SF / Freeform widgets
  // embed `function NAME(...)` blocks at the end that aren't wrapped in
  // <script> tags and survive the strip.
  const fnMatch = stripped.match(/(?:\n|^)\s*(?:\/\/\s*<!\[CDATA\[|\$\(|jQuery\(|function\s+\w*\s*\(|\(function\s*\()/);
  if (fnMatch && fnMatch.index > 0) return stripped.slice(0, fnMatch.index).trimEnd();
  const varMatch = stripped.match(/(?:\n|^)\s*var\s+\w+\s*=\s*(?:window|document|new\s+Object|\{)/);
  if (varMatch && varMatch.index > 0) return stripped.slice(0, varMatch.index).trimEnd();
  return stripped;
}

const DEFAULT_UA = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';

// RETRYABLE_STATUS / isTransientFetchError / fetchWithRetry now live in
// ./transient-fetch.mjs (imported + re-exported above) so the ATS clients share
// the SAME classifier. `sleep` stays local — used by the polite-delay paths.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch JSON with timeout and error handling.
 * When `body` is a plain object/array, it is auto-serialised and Content-Type
 * is set to application/json — no need to stringify or set headers manually.
 *
 * A 200 response whose body is NOT valid JSON (the signature of a WAF/CDN
 * "challenge" page served on an otherwise-OK status, e.g. a WordPress REST
 * listing intermittently returning `<html>…` — #4247 Bucher + Suter) is
 * tagged retryable and re-attempted through the SAME backoff loop as a
 * transient HTTP status, instead of failing the whole crawler on one blip.
 * This does NOT proxy through Jina Reader (unlike fetchHtml() below) —
 * Jina always returns HTML, which would corrupt every retry of a JSON
 * response too, so a plain same-URL retry is the only safe rescue here.
 * @param {string} url
 * @param {Object} [options] — { method, headers, body, timeoutMs }
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const headers = { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...options.headers };
  let { body } = options;
  if (body != null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof ReadableStream)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: options.method || (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        const err = new Error(`Invalid JSON from ${url}: ${parseErr?.message || parseErr}`);
        err.retryable = true;
        err.cause = parseErr;
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }, options);
}

/**
 * Fetch HTML with timeout and error handling.
 */
export async function fetchHtml(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const html = await fetchWithRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': DEFAULT_UA, ...options.headers },
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          err.retryable = RETRYABLE_STATUS.has(res.status);
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    }, options);
    // 200-but-challenge: the IP-reputation WAF (SiteGround sgcaptcha / Cloudflare,
    // the cambiavalute class #1363) served a challenge page on a 200 to the
    // datacenter egress IP. The fetch "succeeded" HTTP-wise so the connection
    // rescue below never fires — re-fetch the real page through Jina's clean IP.
    // Genuine pages pass through unchanged (zero cost).
    return await rescueHtmlIfChallenged(html, url, { timeoutMs });
  } catch (err) {
    // Route to the Jina Reader proxy (reliable egress + real browser → raw HTML)
    // so the data IS collected rather than failing. Two distinct cases qualify:
    //
    //  1. Connection-level failure (no HTTP response ever received): the runner's
    //     datacenter egress can't reach an otherwise-healthy site (~1-3% of
    //     fetches/wave; sites return 200 from a clean IP).
    //
    //  2. IP-reputation WAF hard status (403/406/415/451): the server DID respond,
    //     but with an anti-bot fence keyed on the DATACENTER egress IP, not on the
    //     content — the same source returns a normal 200/301 to a residential/Jina
    //     IP (observed: air-zermatt.ch/jobs → HTTP 415 from CI, 301→200 from a
    //     clean IP, #2025). The earlier "a 4xx means egress works, Jina can't
    //     help" reasoning does NOT hold for this class: Jina's clean IP clears the
    //     fence. Genuine 4xx (404/410 gone, 401 auth) are NOT in the set — Jina
    //     can't help there, so they propagate unchanged. If Jina also fails it
    //     returns null and the ORIGINAL error re-throws, so behaviour for a real
    //     break is unchanged (just one extra proxy attempt).
    //
    // (fetchJson is intentionally NOT proxied — Jina returns HTML, which would
    // corrupt a JSON response.)
    if (isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status)) {
      // Retry the proxy itself: Jina's egress IP can be transiently 429'd or
      // WAF-blocked (200 challenge/empty body) — a retry lands on a different
      // Jina IP and usually succeeds. Returns null on exhaustion → safe-fail by
      // re-throwing the original error (dataset preserved). Body validation +
      // original-error preservation live in the shared helper.
      const html = await fetchHtmlViaJinaWithRetry(url, { timeoutMs });
      if (html != null) return html;
    }
    throw err;
  }
}

/**
 * Fetch HTML while persisting cookies across the redirect chain.
 *
 * Native `fetch` follows redirects automatically but DROPS Set-Cookie between
 * hops (it has no cookie jar), so it cannot clear cookie-challenge WAFs. The
 * Airlock Gateway "AL_CHK" cookie-check fronting Swiss defense/gov sites such as
 * www.ruag.ch sets a cookie and 307-redirects to /cookie-check; without the
 * cookie resent on the follow-up hop the chain dead-ends at HTTP 400 (so the
 * facet listing yields zero links). This helper follows redirects MANUALLY with
 * a per-attempt cookie jar, resending accumulated cookies on each hop exactly as
 * a browser would, so the challenge completes and the real page is returned.
 *
 * Use it for listing/index fetches behind such a challenge. fetchHtml() stays
 * the default for plain pages — it also carries the Jina IP-block fallback this
 * helper deliberately omits (a cookie wall is not an IP-reputation block).
 *
 * By default the cookie jar is fresh per call (and per retry attempt within a
 * call) — right for a challenge that completes within one redirect chain.
 * Callers that need the session to survive ACROSS several SEPARATE calls
 * (e.g. a paginated listing where page 2 must resend the cookie page 1 set —
 * Umantis/KSA, issue #4057) can pass their own `Map` via `options.cookieJar`;
 * it is read AND mutated in place, so it carries forward to the next call
 * instead of being discarded.
 *
 * @param {string} url
 * @param {Object} [options] — { timeoutMs, headers, maxRedirects, cookieJar }
 */
export async function fetchHtmlWithCookies(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const maxRedirects = options.maxRedirects ?? 8;
  return fetchWithRetry(async () => {
    const jar = options.cookieJar instanceof Map ? options.cookieJar : new Map();
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        const cookieHeader = jar.size
          ? [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
          : undefined;
        res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': DEFAULT_UA,
            Accept: 'text/html,application/xhtml+xml',
            ...options.headers,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      // Absorb every Set-Cookie into the jar so the next hop resends them.
      for (const cookie of res.headers.getSetCookie?.() ?? []) {
        const nameValue = cookie.split(';')[0];
        const eqIdx = nameValue.indexOf('=');
        if (eqIdx > 0) jar.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.arrayBuffer().catch(() => {}); // drain body to free the socket
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${currentUrl}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      return await res.text();
    }
    throw new Error(`Too many redirects (>${maxRedirects}) fetching ${url}`);
  }, options);
}

/**
 * Terminal `.catch` handler for crawlers that run a CUSTOM main() instead of
 * runStandardCrawlerPipeline (which has its own connection-level guard).
 *
 * A connection-level fetch failure (egress could not reach an otherwise-healthy
 * source; no HTTP response received) is INFRA, not a source change. Exiting 1
 * here opens a "Crawler Failure" issue every run and risks de-indexing a live
 * employer. We instead exit 0 and preserve the existing slice — the same
 * outcome as an empty fetch. A *persistent* outage is still surfaced by the
 * crawler-health monitor (3 consecutive 0-job runs → broken issue), so nothing
 * is silently buried. A thrown HTTP status (403/404/5xx) means the server DID
 * respond → genuine break → exit 1 so it surfaces immediately.
 *
 * Usage: `main().catch((err) => exitCrawlerOnError(err, 'Company Label'));`
 */
/**
 * Warn when a single-shot listing fetch (fixed page-size/limit query param,
 * no offset pagination) comes back with exactly `cap` results — the
 * canonical signal that the real listing count may have exceeded the
 * hardcoded cap and been silently truncated (issue #3436). If the API
 * response carries its own `total`/`count` metadata, pass it as `total` for
 * a precise check instead of the `count === cap` heuristic.
 *
 * Pure logging — never throws, never changes control flow.
 */
export function warnIfListingAtCap({ label, count, cap, total }) {
  if (typeof total === 'number' && total > count) {
    console.warn(
      `⚠️  ${label}: API reports ${total} total listings but only ${count} were fetched (cap=${cap}). Listing is truncated — add pagination.`,
    );
    return true;
  }
  if (typeof total !== 'number' && count === cap) {
    console.warn(
      `⚠️  ${label}: fetched exactly the cap (${cap}) with no total/count field to verify completeness. If the real listing count ever exceeds ${cap}, jobs will be silently dropped — verify live count or add pagination.`,
    );
    return true;
  }
  return false;
}

export function exitCrawlerOnError(err, label = 'crawler') {
  if (isConnectionLevelFetchError(err)) {
    console.log(
      `\n⚠️ ${label}: connection-level fetch failure after retries + proxy fallback (${err?.message || err}). Keeping existing jobs (no de-index).`,
    );
    process.exit(0);
  }
  console.error(`❌ ${label} crawler failed: ${err?.message || err}`);
  process.exit(1);
}

/**
 * Verify that a URL resolves without redirecting to a different path.
 * Useful for validating SPA job detail URLs that may silently redirect
 * to the homepage when a required path segment is missing.
 * Returns true if the URL stays on the same path; false if it redirects.
 */
export async function verifyUrlNoRedirect(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA, ...options.headers },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    const samePath = new URL(finalUrl).pathname === new URL(url).pathname;
    return { ok: res.ok, redirected: !samePath, finalUrl };
  } catch {
    return { ok: false, redirected: false, finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Config Types ───────────────────────────────────────────────────── */

/**
 * @typedef {Object} CrawlerConfig
 * @property {string}   companyKey          — Unique kebab-case key (e.g. 'lonza')
 * @property {string}   companyLabel        — Display name for logs (e.g. 'Lonza')
 * @property {Function} fetchJobs           — async () => ParsedJob[]. Source-locale only.
 * @property {Function} isCompanyJob        — (job) => boolean. Matches this company's jobs.
 * @property {string}   [root]              — Project root (default: cwd)
 * @property {string}   [defaultSourceLang] — Fallback source language (default: 'it')
 * @property {Function} [isTrustedDomain]   — (url) => boolean. For URL validation.
 * @property {Function} [matchKey]          — Custom URL matching for merge dedup
 * @property {Object}   [baseCrawlerOpts]   — Extra options for runDedicatedBaseCrawler
 */

/* ── Pipeline ───────────────────────────────────────────────────────── */

/**
 * Run the standard 7-step crawler pipeline.
 *
 * This is the ONLY function crawlers need to call. All complexity
 * (merging, slug stability, AI localization, validation, assembly)
 * is handled internally.
 *
 * @param {CrawlerConfig} config
 */
export async function runStandardCrawlerPipeline(config) {
  const {
    companyKey,
    companyLabel,
    root = path.resolve(process.cwd()),
    fetchJobs,
    isCompanyJob,
    defaultSourceLang = 'it',
    isTrustedDomain,
    matchKey,
    baseCrawlerOpts = {},
  } = config;

  if (!companyKey || !companyLabel || !fetchJobs || !isCompanyJob) {
    throw new Error('CrawlerConfig missing required fields: companyKey, companyLabel, fetchJobs, isCompanyJob');
  }

  const DATA_JOBS = crawlerScratchPathFor(companyKey);

  // ─── Step 0: Init ───────────────────────────────────────────
  setCrawlerStartTime();
  // `counts.discovered` (issue #5945, mirrors update-baronie-jobs.mjs) lets a
  // fetchJobs() that attaches an optional `.discoveredCount` property to its
  // returned array report the pre-filter candidate count — even on the
  // "0 jobs after filtering" early return below — so check-crawler-health can
  // classify "found candidates, filtered to 0" as healthy instead of broken,
  // without a human adding the slug to EMPTY_OK_CRAWLERS. Parsers that don't
  // set `.discoveredCount` leave counts.discovered null — unchanged behaviour.
  const counts = { discovered: null };
  registerCrawlerSummaryGuard(companyKey, companyLabel, counts);
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${companyLabel} — Standard Crawler Pipeline`);
  console.log('═══════════════════════════════════════════════\n');

  // ─── Step 1: Snapshot ───────────────────────────────────────
  // Read from per-crawler slice (preferred) or monolithic jobs.json (fallback).
  const existingJobs = readExistingCrawlerJobs(companyKey, DATA_JOBS);
  const companyExisting = existingJobs.filter(isCompanyJob);
  const beforeSnapshot = snapshotJobSlugs(companyExisting);

  // ─── Step 2: Fetch ──────────────────────────────────────────
  // Parser returns source-locale jobs only. DO NOT set non-source locale fields.
  let parsedJobs;
  try {
    parsedJobs = await fetchJobs();
  } catch (err) {
    // Connection-level fetch failure = the runner's datacenter egress could not
    // reach an otherwise-healthy source (transient IP-reputation / egress block,
    // ~1-3% of fetches per wave; sites return 200 from a clean IP). This is
    // INFRA, not a source change: hard-failing here would open a "Crawler
    // Failure" issue every run AND risk de-indexing a live employer's TI/GR
    // pages. Preserve the existing slice and soft-exit instead — exactly the
    // same outcome as an empty fetch. A *persistent* outage is still caught by
    // the crawler-health monitor (3 consecutive 0-job runs → broken issue).
    //
    // Connection-level ONLY (no HTTP response ever received): a thrown HTTP
    // status (403 anti-bot, 404 source-gone, persistent 5xx) means the server
    // DID respond — that is a genuine break and MUST still surface, so it
    // propagates. The fetchHtml layer has already exhausted its Jina clean-IP
    // fallback before re-throwing a connection-level error here, so this is the
    // last-resort guard after the proxy could not help either.
    if (isConnectionLevelFetchError(err)) {
      console.log(
        `\n⚠️ ${companyLabel}: connection-level fetch failure after retries + proxy fallback (${err.message}). Keeping existing jobs.`,
      );
      return;
    }
    // Anti-bot fence exhausted across realistic-UA + Jina clean IP + Playwright
    // (err.antiBotExhausted, set by the jobup feed client). The clean Jina IP
    // being blocked too makes this an IP-reputation/WAF transient, not a source
    // change — same soft-exit semantics as a connection-level failure: keep the
    // existing slice, no de-index, no "Crawler Failure" issue every run. A
    // persistent outage is still caught by the crawler-health monitor.
    if (err?.antiBotExhausted) {
      console.log(
        `\n⚠️ ${companyLabel}: anti-bot fence exhausted (UA + Jina + Playwright) for ${err.message}. Keeping existing jobs.`,
      );
      return;
    }
    throw err;
  }

  if (Number.isFinite(parsedJobs?.discoveredCount)) {
    counts.discovered = parsedJobs.discoveredCount;
  }

  if (!parsedJobs || parsedJobs.length === 0) {
    console.log(`\n⚠️ No ${companyLabel} jobs discovered. Keeping existing jobs.`);
    return;
  }

  console.log(`\n🧩 ${companyLabel}: ${parsedJobs.length} jobs parsed. Merging...\n`);

  // ─── Step 3: Merge with slug stability ──────────────────────
  // mergePreserveLocaleData preserves translations, slugByLocale, and previousSlugs
  // from previous crawl runs. This is the KEY to slug stability — without it,
  // every crawl would regenerate slugs and orphan indexed URLs.
  const mergeOpts = matchKey ? { matchKey } : {};
  const merged = mergePreserveLocaleData(companyExisting, parsedJobs, mergeOpts);
  const clean = merged.sort((a, b) =>
    String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );

  // Write merged dataset (intermediate — Steps 5-6 modify in-place). DATA_JOBS
  // is a scratch path scoped to THIS crawler's own companyKey (see derivation
  // above), so it never holds another company's jobs — no lock or
  // merge-with-others read-back needed, unlike the shared data/jobs.json this
  // replaced.
  writeJsonAtomic(DATA_JOBS, clean);

  // ─── Step 4: Diff reporting ─────────────────────────────────
  const afterMergeSnapshot = snapshotJobSlugs(clean);
  const diff = computeCrawlDiff(beforeSnapshot, afterMergeSnapshot);
  printCrawlChangeSummary(diff, companyLabel);
  writeCrawlChangeSummaryToGH(diff, companyLabel);
  printPublishedJobUrls(clean, companyLabel);
  writeJobsSummary(clean, companyLabel);

  // ─── Step 4b: Archive removed jobs to per-crawler expired slice ──
  // mergePreserveLocaleData drops entries not present in the fresh fetch
  // (it iterates only freshJobs). Without this archival those drops leave
  // indexed Google URLs returning 404 instead of JobExpiredView. Captures
  // `diff.removedJobs` (full job objects, with slug + locale data) into
  // `data/jobs/expired/by-crawler/<companyKey>.json` so the build plugin
  // can emit the soft-landing page.
  if (diff.removedJobs && diff.removedJobs.length > 0) {
    const archived = archiveRemovedJobsToSlice(diff.removedJobs, companyKey);
    if (archived > 0) {
      console.log(
        `📦 Archived ${archived} removed jobs → data/jobs/expired/by-crawler/${companyKey}.json`,
      );
    }
  }

  // ─── Step 5: AI Localization ────────────────────────────────
  // Translates titles + descriptions to all 4 locales via AI.
  // Uses translation cache (SHA256-based) for ~90% hit rate on re-runs.
  // Sets needsRetranslation=true for jobs that couldn't be translated.
  console.log(`\n🌐 Running AI localization for ${companyLabel} jobs...`);
  await runDedicatedBaseCrawler({
    root,
    companyKeys: companyKey,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
    dataJobsPath: DATA_JOBS,
    ...baseCrawlerOpts,
  });

  // ─── Step 6: Validation ─────────────────────────────────────
  // Checks: locale coverage, URL domains, slug format, description quality.
  // Strict mode (default) fails the crawler if validation finds issues.
  const validateOpts = {
    strictEnvVar: `JOBS_${companyKey.toUpperCase().replace(/-/g, '_')}_STRICT`,
    label: companyLabel,
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${companyLabel} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, defaultSourceLang),
    deriveSlug: deriveLocalizedSlug,
  };
  if (isTrustedDomain) {
    validateOpts.isTrustedDomain = isTrustedDomain;
    validateOpts.untrustedDomainReason = `url_not_${companyKey}_domain`;
  }
  validateDedicatedLocaleCoverage(validateOpts);

  // ─── Step 7: Slice + Assemble ───────────────────────────────
  // writeJobsCrawlerSlice has a FINAL safety net that strips any
  // previousSlug matching an active slug — defense against all upstream bugs.
  const durationMs = getCrawlerElapsedMs();
  const sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const sliceJobs = Array.isArray(sliceRaw) ? sliceRaw.filter(isCompanyJob) : [];

  // Evidence-gated write (#5016/#5017). Identical to writeJobsCrawlerSlice
  // until the anti-shrink guard trips; then the disappearing jobs are probed
  // at their own source URLs and the smaller slice is accepted ONLY if every
  // one of them is provably gone. A degraded/blocked source still fails here
  // exactly as before — the threshold is unchanged, the proof is the addition.
  await writeJobsCrawlerSliceVerified(companyKey, sliceJobs);
  writeSummaryCrawlerSlice({
    key: companyKey,
    label: companyLabel,
    generatedAt: new Date().toISOString(),
    total: sliceJobs.length,
    discovered: counts.discovered,
    written: sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs,
    avgDurationMs: durationMs,
    durationHistory: [durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();

  // ─── Done ───────────────────────────────────────────────────
  console.log(`\n✅ ${companyLabel} crawler complete. ${sliceJobs.length} jobs.`);
}