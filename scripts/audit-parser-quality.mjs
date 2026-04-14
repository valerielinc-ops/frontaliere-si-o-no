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

/* ── Args ──────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const skipUrls = !args.includes('--check-urls');
const crawlerFlag = args.find((a) => a.startsWith('--crawler='));
const onlyCrawler = crawlerFlag ? crawlerFlag.split('=')[1] : null;

/* ── Helpers ───────────────────────────────────────────────── */
function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');
}

function plainText(html) {
  return stripHtml(html).replace(/\s+/g, ' ').trim();
}

const BOILERPLATE_RE = /^(datore di lavoro|als arbeitgeber|come employer|en tant qu.?employeur|as employer)/i;

function isThinDescription(desc) {
  const text = plainText(desc);
  if (text.length < 100) return 'too-short';
  if (BOILERPLATE_RE.test(text)) return 'boilerplate';
  // Mostly whitespace / tags — if raw is 5x longer than plain, it's tag soup
  if ((desc || '').length > 200 && text.length < (desc || '').length * 0.15) return 'tag-soup';
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
  const files = fs.readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json'));
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

    // 4. Missing locale coverage
    const missingLocales = jobs.filter((j) => {
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

    // 5. Duplicate descriptions
    const fpMap = new Map();
    for (const j of jobs) {
      const fp = descFingerprint(j.description);
      if (fp.length < 20) continue; // skip empty/tiny
      fpMap.set(fp, (fpMap.get(fp) || 0) + 1);
    }
    const dupeCount = [...fpMap.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0);
    if (dupeCount > 1) {
      issues.push({
        type: 'duplicate-descriptions',
        count: dupeCount,
        total: jobs.length,
        message: `${dupeCount}/${jobs.length} duplicate descriptions`,
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
    const urlFail = types.has('stale-urls');
    if (types.has('parse-error')) entry.severity = 'CRITICAL';
    else if (thinRatio >= 0.5 || (thinRatio > 0 && urlFail)) entry.severity = 'CRITICAL';
    else if (entry.issues.length > 0) entry.severity = 'WARNING';
    else entry.severity = 'OK';
    if (entry.severity === 'CRITICAL') {
      const h = [];
      if (thinRatio >= 0.5) h.push('Most descriptions are thin — parser likely scraping nav/boilerplate instead of job content');
      if (urlFail) h.push('Detail URLs returning errors — likely site migration or URL structure change');
      if (types.has('parse-error')) h.push('Crawler JSON file could not be parsed');
      entry.action = h.join('. ') + '.';
    }
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
        console.log(`    \u26A0\uFE0F ${issue.message}`);
      }
    }
  }

  console.log(`\nOK: ${okCount} crawlers passing all checks`);

  const total = Object.keys(report).length;
  console.log(`\n${total} crawlers checked, ${critical.length} critical, ${warnings.length} warnings`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(0); // exit 0 — audit, not gate
});
