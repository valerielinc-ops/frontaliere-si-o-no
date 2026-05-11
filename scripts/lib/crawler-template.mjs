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
 * CREATING A NEW CRAWLER — 4 files needed
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
 * 3. WORKFLOW — .github/workflows/update-jobs-{company-key}.yml
 *    GitHub Actions workflow with dispatch, node setup, crawler run,
 *    housekeeping, commit+push. See update-jobs-lonza.yml as reference.
 *
 * 4. TEST — tests/{company-key}-crawler.test.ts
 *    Parser unit tests: validates job shape, slug format, isCompanyJob(), etc.
 *
 * Use `node scripts/scaffold-crawler.mjs {company-key}` to generate all 4 files.
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
import path from 'node:path';
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

/* ── Shared Utilities (re-exported for parser convenience) ──────────── */

/**
 * Standard slugify function. Parsers should use this to build slugs
 * consistently (lowercase, diacritics stripped, alphanumeric+dash only).
 */
export function slugify(text = '', maxLength = 90) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
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
 * Strip HTML tags and decode common entities. Use for description fields.
 */
export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
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
}

const DEFAULT_UA = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';

/**
 * Fetch JSON with timeout and error handling.
 * When `body` is a plain object/array, it is auto-serialised and Content-Type
 * is set to application/json — no need to stringify or set headers manually.
 * @param {string} url
 * @param {Object} [options] — { method, headers, body, timeoutMs }
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...options.headers };
  let { body } = options;
  if (body != null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof ReadableStream)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  try {
    const res = await fetch(url, {
      method: options.method || (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch HTML with timeout and error handling.
 */
export async function fetchHtml(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA, ...options.headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

  const DATA_JOBS = path.resolve(root, 'data', 'jobs.json');
  const PUBLIC_DATA_JOBS = path.resolve(root, 'public', 'data', 'jobs.json');

  // ─── Step 0: Init ───────────────────────────────────────────
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(companyKey, companyLabel);
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
  const parsedJobs = await fetchJobs();

  if (!parsedJobs || parsedJobs.length === 0) {
    console.log(`\n⚠️ No ${companyLabel} jobs discovered. Keeping existing jobs.`);
    return;
  }

  console.log(`\n🧩 ${companyLabel}: ${parsedJobs.length} jobs parsed. Merging...\n`);

  // ─── Step 3: Merge with slug stability ──────────────────────
  // mergePreserveLocaleData preserves translations, slugByLocale, and previousSlugs
  // from previous crawl runs. This is the KEY to slug stability — without it,
  // every crawl would regenerate slugs and orphan indexed URLs.
  const allJobs = Array.isArray(existingJobs) ? existingJobs : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const mergeOpts = matchKey ? { matchKey } : {};
  const merged = mergePreserveLocaleData(companyExisting, parsedJobs, mergeOpts);
  const clean = merged.sort((a, b) =>
    String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );

  // Write merged dataset (intermediate — Steps 5-6 modify in-place)
  const final = [...others, ...clean];
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(final, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(final, null, 2)}\n`, 'utf-8');
  }

  // ─── Step 4: Diff reporting ─────────────────────────────────
  const afterMergeSnapshot = snapshotJobSlugs(clean);
  const diff = computeCrawlDiff(beforeSnapshot, afterMergeSnapshot);
  printCrawlChangeSummary(diff, companyLabel);
  writeCrawlChangeSummaryToGH(diff, companyLabel);
  printPublishedJobUrls(clean, companyLabel);
  writeJobsSummary(clean, companyLabel);

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

  writeJobsCrawlerSlice(companyKey, sliceJobs);
  writeSummaryCrawlerSlice({
    key: companyKey,
    label: companyLabel,
    generatedAt: new Date().toISOString(),
    total: sliceJobs.length,
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
