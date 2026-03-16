/**
 * Shared helper: print published job URLs, compute crawl diffs, and write
 * GitHub Actions Job Summary with change details.
 *
 * Usage (ESM):
 *   import {
 *     printPublishedJobUrls, writeJobsSummary,
 *     snapshotJobSlugs, computeCrawlDiff,
 *     printCrawlChangeSummary, writeCrawlChangeSummaryToGH,
 *   } from './jobs-url-helper.mjs';
 */
import fs from 'node:fs';
import {
  createEmptyCrawlerSummaryStore,
  readCrawlerSummaryStore,
  resolveCrawlerSummaryStorePath,
  writeCrawlerSummaryStore,
} from './lib/crawler-summary-store.mjs';

const BASE_URL = 'https://www.frontaliereticino.ch';
const JOB_PATH = 'cerca-lavoro-ticino';
const DATA_SUMMARIES_PATH = resolveCrawlerSummaryStorePath();

/** Build the published URL for a job */
function jobUrl(job) {
  const localizedSlug = job?.slugByLocale?.it;
  const rawSlug = localizedSlug || job?.slug || job?.id || 'unknown';
  const slug = String(rawSlug).trim().replace(/^\/+|\/+$/g, '');
  return `${BASE_URL}/${JOB_PATH}/${slug}/`;
}

function toSummaryEntry(job) {
  return {
    title: job?.title || '—',
    company: job?.company || '—',
    location: job?.location || '—',
    url: jobUrl(job),
    slug: job?.slug || job?.id || '',
  };
}

function normalizeSummaryKey(label = '') {
  const normalized = String(label || 'generic-crawler')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'generic-crawler';
}

function readSummaryStore(filePath) {
  return readCrawlerSummaryStore(filePath, { allowMissing: true });
}

function writeSummaryStore(filePath, payload) {
  writeCrawlerSummaryStore(filePath, payload);
}

function persistCrawlChangeSummary(diff, label = '') {
  const key = normalizeSummaryKey(label);
  const cleanLabel = label || 'Generic Crawler';
  const total = diff.newJobs.length + diff.updatedJobs.length + diff.removedJobs.length + diff.unchangedCount;
  const durationMs = Math.round(process.uptime() * 1000);
  const current = readSummaryStore(DATA_SUMMARIES_PATH) || createEmptyCrawlerSummaryStore();
  const prev = current.summaries.find((s) => s?.key === key);
  // Keep rolling history of last 10 durations for average calculation
  const prevHistory = Array.isArray(prev?.durationHistory) ? prev.durationHistory : [];
  const durationHistory = [durationMs, ...prevHistory].slice(0, 10);
  const avgDurationMs = Math.round(durationHistory.reduce((a, b) => a + b, 0) / durationHistory.length);

  const entry = {
    key,
    label: cleanLabel,
    generatedAt: new Date().toISOString(),
    total,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs,
    avgDurationMs,
    durationHistory,
    newJobs: diff.newJobs.slice(0, 30).map(toSummaryEntry),
    updatedJobs: diff.updatedJobs.slice(0, 30).map(toSummaryEntry),
    removedJobs: diff.removedJobs.slice(0, 30).map(toSummaryEntry),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30).map(toSummaryEntry),
  };

  const filtered = current.summaries.filter((summary) => summary?.key !== key);
  const payload = {
    updatedAt: entry.generatedAt,
    summaries: [entry, ...filtered].slice(0, 120),
  };
  writeSummaryStore(DATA_SUMMARIES_PATH, payload);
}

// ─── Existing helpers (kept for backward compat) ────────────────────────

/**
 * Print published site URLs for each job to stdout.
 * @param {Array<{slug?: string; title?: string; company?: string}>} jobs
 * @param {string} [label] - Optional label (e.g. 'Coop', 'Migros')
 */
export function printPublishedJobUrls(jobs, label = '') {
  if (!jobs || jobs.length === 0) return;
  const tag = label ? ` — ${label}` : '';
  console.log(`\n🔗 URL pubblicati sul sito (${jobs.length} offerte${tag}):`);
  for (const job of jobs) {
    console.log(`  ${jobUrl(job)}`);
  }
}

/**
 * Append a Markdown table of published job URLs to the GitHub Actions Job Summary.
 * No-ops when not running in CI (GITHUB_STEP_SUMMARY unset).
 * @param {Array<{slug?: string; title?: string; company?: string}>} jobs
 * @param {string} [label] - Section header label
 */
export function writeJobsSummary(jobs, label = '') {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile || !jobs || jobs.length === 0) return;

  const tag = label ? ` — ${label}` : '';
  let md = `\n## 🔗 Offerte pubblicate (${jobs.length}${tag})\n\n`;
  md += '| Titolo | Azienda | Sede | URL |\n';
  md += '|---|---|---|---|\n';
  for (const job of jobs) {
    const url = jobUrl(job);
    const title = (job.title || '—').replace(/\|/g, '∣');
    const company = (job.company || '—').replace(/\|/g, '∣');
    const location = (job.location || '—').replace(/\|/g, '∣');
    md += `| ${title} | ${company} | ${location} | [Vedi](${url}) |\n`;
  }
  try {
    fs.appendFileSync(summaryFile, md);
  } catch { /* non-blocking */ }
}

// ─── Crawl diff helpers ─────────────────────────────────────────────────

/**
 * Take a snapshot of job slugs from an array of jobs.
 * Returns a Map<slug, job> for efficient lookup.
 * @param {Array<{slug?: string; id?: string}>} jobs
 * @returns {Map<string, object>}
 */
export function snapshotJobSlugs(jobs) {
  const map = new Map();
  for (const job of (jobs || [])) {
    const slug = job?.slug || job?.id;
    if (slug) map.set(slug, job);
  }
  return map;
}

/**
 * Compute what changed between two snapshots of jobs.
 * @param {Map<string, object>} beforeMap - from snapshotJobSlugs
 * @param {Map<string, object>} afterMap  - from snapshotJobSlugs
 * @returns {{ newJobs: object[], removedJobs: object[], updatedJobs: object[], unchangedCount: number }}
 */
export function computeCrawlDiff(beforeMap, afterMap) {
  const newJobs = [];
  const updatedJobs = [];
  const removedJobs = [];
  const unchangedJobs = [];

  // Find new and updated jobs
  for (const [slug, afterJob] of afterMap) {
    const beforeJob = beforeMap.get(slug);
    if (!beforeJob) {
      newJobs.push(afterJob);
    } else {
      // Consider updated if title or description changed
      const titleChanged = (beforeJob.title || '') !== (afterJob.title || '');
      const descChanged = (beforeJob.description || '').slice(0, 200) !== (afterJob.description || '').slice(0, 200);
      const locChanged = (beforeJob.location || '') !== (afterJob.location || '');
      if (titleChanged || descChanged || locChanged) {
        updatedJobs.push(afterJob);
      } else {
        unchangedJobs.push(afterJob);
      }
    }
  }

  // Find removed jobs
  for (const [slug, beforeJob] of beforeMap) {
    if (!afterMap.has(slug)) {
      removedJobs.push(beforeJob);
    }
  }

  return { newJobs, removedJobs, updatedJobs, unchangedJobs, unchangedCount: unchangedJobs.length };
}

/**
 * Print a summary of what changed to console.
 * @param {{ newJobs: object[], removedJobs: object[], updatedJobs: object[], unchangedCount: number }} diff
 * @param {string} [label]
 */
export function printCrawlChangeSummary(diff, label = '') {
  const tag = label ? ` — ${label}` : '';
  const total = diff.newJobs.length + diff.updatedJobs.length + diff.removedJobs.length + diff.unchangedCount;
  const active = total - diff.removedJobs.length;
  const durationSec = (process.uptime()).toFixed(1);
  persistCrawlChangeSummary(diff, label);
  console.log(`\n📋 Riepilogo crawler${tag}:`);
  console.log(`  📊 Offerte attive: ${active}${diff.removedJobs.length > 0 ? ` (${diff.removedJobs.length} rimosse)` : ''}`);
  console.log(`  🆕 Nuove: ${diff.newJobs.length}`);
  console.log(`  🔄 Aggiornate: ${diff.updatedJobs.length}`);
  console.log(`  ❌ Rimosse: ${diff.removedJobs.length}`);
  console.log(`  ✅ Invariate: ${diff.unchangedCount}`);
  console.log(`  ⏱️  Durata: ${durationSec}s`);

  if (diff.newJobs.length > 0) {
    console.log(`\n  🆕 Nuovi link creati:`);
    for (const job of diff.newJobs) {
      const title = job.title || '—';
      const company = job.company || '—';
      console.log(`    + ${title} (${company})`);
      console.log(`      ${jobUrl(job)}`);
    }
  }

  if (diff.updatedJobs.length > 0) {
    console.log(`\n  🔄 Link aggiornati:`);
    for (const job of diff.updatedJobs) {
      const title = job.title || '—';
      console.log(`    ~ ${title}`);
      console.log(`      ${jobUrl(job)}`);
    }
  }

  if (diff.removedJobs.length > 0) {
    console.log(`\n  ❌ Link rimossi:`);
    for (const job of diff.removedJobs) {
      const title = job.title || '—';
      const company = job.company || '—';
      console.log(`    - ${title} (${company})`);
      console.log(`      ${jobUrl(job)}`);
    }
  }
}

/**
 * Write a crawl change summary to GitHub Actions Job Summary.
 * No-ops when not running in CI.
 * @param {{ newJobs: object[], removedJobs: object[], updatedJobs: object[], unchangedCount: number }} diff
 * @param {string} [label]
 */
export function writeCrawlChangeSummaryToGH(diff, label = '') {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  const tag = label ? ` — ${label}` : '';
  const total = diff.newJobs.length + diff.updatedJobs.length + diff.removedJobs.length + diff.unchangedCount;
  let md = `\n## 📋 Riepilogo crawler${tag}\n\n`;
  md += `| Metrica | Conteggio |\n|---|---:|\n`;
  md += `| Totale offerte | ${total} |\n`;
  md += `| 🆕 Nuove | **${diff.newJobs.length}** |\n`;
  md += `| 🔄 Aggiornate | ${diff.updatedJobs.length} |\n`;
  md += `| ❌ Rimosse | ${diff.removedJobs.length} |\n`;
  md += `| ✅ Invariate | ${diff.unchangedCount} |\n\n`;

  if (diff.newJobs.length > 0) {
    md += `### 🆕 Nuovi link creati (${diff.newJobs.length})\n\n`;
    md += '| Titolo | Azienda | Sede | URL |\n|---|---|---|---|\n';
    for (const job of diff.newJobs) {
      const url = jobUrl(job);
      const title = (job.title || '—').replace(/\|/g, '∣');
      const company = (job.company || '—').replace(/\|/g, '∣');
      const location = (job.location || '—').replace(/\|/g, '∣');
      md += `| ${title} | ${company} | ${location} | [Vedi](${url}) |\n`;
    }
    md += '\n';
  }

  if (diff.removedJobs.length > 0) {
    md += `### ❌ Link rimossi (${diff.removedJobs.length})\n\n`;
    md += '| Titolo | Azienda | Sede |\n|---|---|---|\n';
    for (const job of diff.removedJobs) {
      const title = (job.title || '—').replace(/\|/g, '∣');
      const company = (job.company || '—').replace(/\|/g, '∣');
      const location = (job.location || '—').replace(/\|/g, '∣');
      md += `| ${title} | ${company} | ${location} |\n`;
    }
    md += '\n';
  }

  if (diff.updatedJobs.length > 0) {
    md += `### 🔄 Link aggiornati (${diff.updatedJobs.length})\n\n`;
    md += '| Titolo | Azienda | URL |\n|---|---|---|\n';
    for (const job of diff.updatedJobs.slice(0, 50)) {
      const url = jobUrl(job);
      const title = (job.title || '—').replace(/\|/g, '∣');
      const company = (job.company || '—').replace(/\|/g, '∣');
      md += `| ${title} | ${company} | [Vedi](${url}) |\n`;
    }
    if (diff.updatedJobs.length > 50) {
      md += `| _…e altri ${diff.updatedJobs.length - 50}_ | | |\n`;
    }
    md += '\n';
  }

  try {
    fs.appendFileSync(summaryFile, md);
  } catch { /* non-blocking */ }
}
