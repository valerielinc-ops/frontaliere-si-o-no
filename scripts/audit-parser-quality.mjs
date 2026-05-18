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
 *   node scripts/audit-parser-quality.mjs --crawler=lidl-svizzera
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const BASELINE_PATH = path.join(ROOT, 'data', 'parser-quality-no-structure-baseline.json');

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
 * SIGNAL 2 — chrome scraping (desc-only fingerprint, ≥95%):
 *   Almost every job — regardless of title — carries the SAME body. That's
 *   the Moncucco-class failure: the parser is grabbing nav/footer/megamenu
 *   instead of the per-job body. Action: inspect detail-page selectors.
 *
 * Threshold rationale: title-aware stays at 80% (the original threshold);
 * desc-only is tightened to 95% so legitimately templated content (companies
 * that publish the same role across many cities — reboot-monkey, lidl-svizzera)
 * doesn't false-positive. A real chrome-scraping parser produces near-100%
 * desc-only duplicates because every job carries the same nav blob.
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
    const ratio = issue.count / issue.total;
    const isNew = !baseRecord;
    const regressed = !!baseRecord && issue.count > baseCount;
    // New crawler entering 95%+ flat territory, or any existing crawler going UP, triggers CRITICAL
    const newOffender = isNew && ratio >= 0.95 && issue.total >= 10;
    if (newOffender || regressed) {
      entry.severity = 'CRITICAL';
      issue.message += newOffender
        ? ` [NEW OFFENDER: ${issue.count}/${issue.total} flat, no baseline tolerance]`
        : ` [REGRESSION: was ${baseCount}, now ${issue.count}]`;
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

function filledLocaleCount(byLocale) {
  if (!byLocale || typeof byLocale !== 'object') return 0;
  return Object.values(byLocale).filter((v) => v && String(v).trim().length > 10).length;
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
 *      <city>" listings; lidl-svizzera: 8 apprendistato in 8 filiali). Titles
 *      ARE distinct (one per city) but the body is templated so post-boilerplate
 *      slices collide. The parser is doing the right thing — flagging it as
 *      "chrome scraping" is a false positive.
 *
 * We separate the two:
 *   - mode 'title-aware'  : title || desc-slice. Catches real duplicate listings
 *                           where multiple postings share the same title AND body
 *                           (bitfinex's Recruitee feed publishes 9× the same role).
 *   - mode 'desc-only'    : the original desc-only slice. Used at a stricter
 *                           threshold to keep chrome-scraping detection alive
 *                           (chrome makes ALL descriptions identical regardless
 *                           of title).
 */
function fingerprintsForCrawler(jobs, mode = 'title-aware') {
  const plain = jobs.map((j) => plainText(j.description).toLowerCase());
  const boilerLen = estimateBoilerplateLength(plain);
  // Only strip when the boilerplate is long enough to be meaningful and not
  // so long that stripping it leaves no signal.
  const stripLen = boilerLen >= 120 ? Math.max(boilerLen - 20, 0) : 0;
  return plain.map((p, i) => {
    const slice = p.slice(stripLen, stripLen + 500);
    if (mode === 'title-aware') {
      const title = plainText(jobs[i]?.title || '').toLowerCase();
      return `${title}||${slice}`;
    }
    return slice;
  });
}

function countDuplicates(fps) {
  const counts = new Map();
  for (const fp of fps) {
    if (fp.length < 20) continue; // skip empty/tiny
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  return [...counts.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0);
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
  const files = fs
    .readdirSync(SLICES_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('.cleanup-tmp'));
  const slices = [];
  for (const file of files) {
    const key = file.replace(/\.json$/, '');
    if (onlyCrawler && key !== onlyCrawler) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SLICES_DIR, file), 'utf8'));
      const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
      slices.push({ key, jobs });
    } catch {
      slices.push({ key, jobs: [], error: 'parse-error' });
    }
  }
  return slices;
}

/* ── Main audit ────────────────────────────────────────────── */
async function main() {
  const slices = loadCrawlerSlices();
  console.log(`\nLoaded ${slices.length} crawler slices from ${SLICES_DIR}\n`);

  const report = {}; // key → { issues[], severity }
  const urlsToCheck = []; // { crawlerKey, url }

  for (const { key, jobs, error } of slices) {
    const issues = [];

    if (error) {
      issues.push({ type: 'parse-error', message: 'Failed to parse crawler JSON file' });
      report[key] = { total: 0, issues, severity: 'CRITICAL' };
      continue;
    }

    if (jobs.length === 0) {
      report[key] = { total: 0, issues: [], severity: 'OK' };
      continue;
    }

    // 1. Thin descriptions
    const thinResults = jobs.map((j) => ({ job: j, reason: isThinDescription(j.description) }));
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
    const nonThinJobs = jobs.filter((j) => !isThinDescription(j.description));
    const noStructure = nonThinJobs.filter((j) => !hasStructuredContent(j.description));
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

    // 4. Missing locale coverage — skip in-flight translations
    const missingLocales = jobs.filter((j) => {
      if (j.needsRetranslation === true) return false;
      const titleCount = filledLocaleCount(j.titleByLocale);
      const descCount = filledLocaleCount(j.descriptionByLocale);
      return titleCount < 2 || descCount < 2;
    });
    if (missingLocales.length > 0) {
      // Calculate how many locales are missing on average
      const avgMissing = Math.round(
        missingLocales.reduce((s, j) => {
          const have = Math.max(filledLocaleCount(j.titleByLocale), filledLocaleCount(j.descriptionByLocale));
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
    // same body across many records, e.g. bitfinex's Recruitee feed posting
    // the same role 9× with different IDs). Templated city-listings stay
    // unflagged because each city has a distinct title.
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
    // already filters out).
    const fpsDescOnly = fingerprintsForCrawler(jobs, 'desc-only');
    const chromeDupes = countDuplicates(fpsDescOnly);
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

    report[key] = { total: jobs.length, issues };
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
    if (types.has('parse-error')) entry.severity = 'CRITICAL';
    // Form-chrome is a hard signal: even one row means the parser is
    // leaking the surrounding page (form, footer, contact info) into the
    // job description. There is no benign source of these phrases — never
    // a false positive — so skip the ratio gate.
    else if (formChromeCount > 0) entry.severity = 'CRITICAL';
    else if (thinRatio >= 0.5 || (thinRatio > 0 && urlFail)) entry.severity = 'CRITICAL';
    else if (entry.issues.length > 0) entry.severity = 'WARNING';
    else entry.severity = 'OK';
    if (entry.severity === 'CRITICAL') {
      const h = [];
      if (formChromeCount > 0) h.push(`${formChromeCount} description(s) contain form/footer/contact chrome — parser is sweeping page boundaries (most likely an unbounded HTML split). Bound extraction to the per-job DOM subtree`);
      if (thinRatio >= 0.5) h.push('Most descriptions are thin — parser likely scraping nav/boilerplate instead of job content');
      if (urlFail) h.push('Detail URLs returning errors — likely site migration or URL structure change');
      if (types.has('parse-error')) h.push('Crawler JSON file could not be parsed');
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

  // Print report
  printReport(report);

  // Write JSON
  const jsonReport = {
    timestamp: new Date().toISOString(),
    crawlersChecked: Object.keys(report).length,
    urlChecksEnabled: !skipUrls,
    crawlers: report,
    summary: {
      critical: Object.values(report).filter((r) => r.severity === 'CRITICAL').length,
      warning: Object.values(report).filter((r) => r.severity === 'WARNING').length,
      ok: Object.values(report).filter((r) => r.severity === 'OK').length,
    },
  };
  const outPath = path.join(ROOT, 'data', 'parser-quality-report.json');
  fs.writeFileSync(outPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nJSON report saved to: data/parser-quality-report.json\n`);
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

  const total = Object.keys(report).length;
  console.log(`\n${total} crawlers checked, ${critical.length} critical, ${warnings.length} warnings`);

  const strict = process.argv.includes('--strict');
  if (strict && critical.length > 0) {
    console.error(`\n❌ --strict: ${critical.length} critical crawler(s) found. Failing.`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
