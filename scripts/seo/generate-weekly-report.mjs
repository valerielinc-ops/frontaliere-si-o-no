#!/usr/bin/env node
/**
 * generate-weekly-report.mjs — F.3 Weekly SEO cumulative report
 *
 * Reads the N most recent snapshots from data/seo-snapshots/ produced by
 * semrush-snapshot.mjs and computes deltas for the current ISO week:
 *   • keywords in top 3 / 10 / 20 / 50
 *   • new keywords entering top 100
 *   • keywords lost (present previously, gone now)
 *   • estimated traffic delta
 *   • authority / rank evolution
 *
 * Output: docs/seo-reports/week-YYYY-WW.md (Markdown)
 *
 * No data? → emits a "No data yet" template so the pipeline still produces
 * a visible artefact the first time it runs.
 *
 * Idempotent: re-running in the same ISO week overwrites that week's file.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SNAPSHOT_DIR = join(ROOT, 'data', 'seo-snapshots');
const REPORT_DIR = join(ROOT, 'docs', 'seo-reports');

const DATABASES = ['it', 'ch'];

function isoWeekAndYear(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, year: date.getUTCFullYear() };
}

function weekKey(d = new Date()) {
  const { week, year } = isoWeekAndYear(d);
  return `${year}-${String(week).padStart(2, '0')}`;
}

function loadDomainSnapshots(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') out.push({ file: f, data });
    } catch {
      // skip
    }
  }
  return out;
}

function keywordsInBucket(rows, max) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) {
    const pos = Number(r.Po ?? r.position ?? 0);
    if (pos > 0 && pos <= max) n += 1;
  }
  return n;
}

function toPhraseSet(rows) {
  const s = new Set();
  if (!Array.isArray(rows)) return s;
  for (const r of rows) {
    const ph = String(r.Ph ?? r.phrase ?? '').trim();
    if (ph) s.add(ph);
  }
  return s;
}

function sumTraffic(rows) {
  if (!Array.isArray(rows)) return 0;
  let sum = 0;
  for (const r of rows) {
    const t = Number(r.Tr ?? r.traffic ?? 0);
    if (Number.isFinite(t)) sum += t;
  }
  return sum;
}

function computeDeltaForDatabase(latestRows, previousRows) {
  const latestSet = toPhraseSet(latestRows);
  const previousSet = toPhraseSet(previousRows);
  const gained = [...latestSet].filter((p) => !previousSet.has(p));
  const lost = [...previousSet].filter((p) => !latestSet.has(p));
  return {
    top3: keywordsInBucket(latestRows, 3),
    top10: keywordsInBucket(latestRows, 10),
    top20: keywordsInBucket(latestRows, 20),
    top50: keywordsInBucket(latestRows, 50),
    prevTop3: keywordsInBucket(previousRows, 3),
    prevTop10: keywordsInBucket(previousRows, 10),
    prevTop20: keywordsInBucket(previousRows, 20),
    prevTop50: keywordsInBucket(previousRows, 50),
    newTop100: gained.length,
    lostKeywords: lost.length,
    gainedList: gained.slice(0, 20),
    lostList: lost.slice(0, 20),
    trafficEst: sumTraffic(latestRows),
    prevTrafficEst: sumTraffic(previousRows),
  };
}

function formatDelta(current, previous) {
  const cur = Number(current ?? 0);
  const prev = Number(previous ?? 0);
  const d = cur - prev;
  if (d === 0) return '±0';
  return d > 0 ? `+${d}` : `${d}`;
}

function buildReport({ week, latest, previous }) {
  const lines = [];
  lines.push(`# Weekly SEO report — week ${week}`);
  lines.push('');
  lines.push(`Domain: \`frontaliereticino.ch\``);
  lines.push(`Latest snapshot: \`${latest.file}\``);
  lines.push(previous ? `Previous snapshot: \`${previous.file}\`` : 'Previous snapshot: none');
  lines.push('');

  for (const db of DATABASES) {
    const latestRows = latest.data.topKeywords?.[db] ?? [];
    const previousRows = previous?.data?.topKeywords?.[db] ?? [];
    const d = computeDeltaForDatabase(latestRows, previousRows);

    const latestRank = latest.data.domainRanks?.[db] ?? null;
    const previousRank = previous?.data?.domainRanks?.[db] ?? null;

    lines.push(`## Database: ${db.toUpperCase()}`);
    lines.push('');
    lines.push('### Keyword distribution');
    lines.push('');
    lines.push('| Bucket | Current | Previous | Delta |');
    lines.push('|---|---|---|---|');
    lines.push(`| Top 3 | ${d.top3} | ${d.prevTop3} | ${formatDelta(d.top3, d.prevTop3)} |`);
    lines.push(`| Top 10 | ${d.top10} | ${d.prevTop10} | ${formatDelta(d.top10, d.prevTop10)} |`);
    lines.push(`| Top 20 | ${d.top20} | ${d.prevTop20} | ${formatDelta(d.top20, d.prevTop20)} |`);
    lines.push(`| Top 50 | ${d.top50} | ${d.prevTop50} | ${formatDelta(d.top50, d.prevTop50)} |`);
    lines.push('');
    lines.push(`- New keywords entering top 100: **${d.newTop100}**`);
    lines.push(`- Keywords lost: **${d.lostKeywords}**`);
    lines.push(`- Estimated traffic: ${d.trafficEst} (prev ${d.prevTrafficEst}, delta ${formatDelta(d.trafficEst, d.prevTrafficEst)})`);
    lines.push('');

    if (latestRank || previousRank) {
      lines.push('### Domain rank / authority');
      lines.push('');
      lines.push('| Metric | Current | Previous |');
      lines.push('|---|---|---|');
      const curRk = latestRank?.Rk ?? latestRank?.rank ?? 'n/a';
      const prevRk = previousRank?.Rk ?? previousRank?.rank ?? 'n/a';
      const curOt = latestRank?.Ot ?? latestRank?.organic_traffic ?? 'n/a';
      const prevOt = previousRank?.Ot ?? previousRank?.organic_traffic ?? 'n/a';
      lines.push(`| Rank | ${curRk} | ${prevRk} |`);
      lines.push(`| Organic traffic estimate | ${curOt} | ${prevOt} |`);
      lines.push('');
    }

    if (Array.isArray(latestRows) && latestRows.length > 0) {
      lines.push('### Current top keywords');
      lines.push('');
      lines.push('| Keyword | Position | Traffic |');
      lines.push('|---|---|---|');
      for (const r of latestRows.slice(0, 20)) {
        const ph = String(r.Ph ?? r.phrase ?? '').trim();
        const po = r.Po ?? r.position ?? '';
        const tr = r.Tr ?? r.traffic ?? '';
        if (ph) lines.push(`| ${ph} | ${po} | ${tr} |`);
      }
      lines.push('');
    }

    if (d.gainedList.length > 0) {
      lines.push('### New keywords (sample)');
      lines.push('');
      for (const kw of d.gainedList) lines.push(`- ${kw}`);
      lines.push('');
    }
    if (d.lostList.length > 0) {
      lines.push('### Lost keywords (sample)');
      lines.push('');
      for (const kw of d.lostList) lines.push(`- ${kw}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by `scripts/seo/generate-weekly-report.mjs`._');
  lines.push('');
  return lines.join('\n');
}

function noDataTemplate(week) {
  return [
    `# Weekly SEO report — week ${week}`,
    '',
    'No SEMrush snapshots available yet.',
    '',
    'This report will populate once `scripts/seo/semrush-snapshot.mjs` runs',
    'with a valid `SEMRUSH_API_KEY` configured in GitHub Actions.',
    '',
    '_Generated by `scripts/seo/generate-weekly-report.mjs`._',
    '',
  ].join('\n');
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const week = weekKey();
  const reportPath = join(REPORT_DIR, `week-${week}.md`);

  const snapshots = loadDomainSnapshots(SNAPSHOT_DIR);
  if (snapshots.length === 0) {
    writeFileSync(reportPath, noDataTemplate(week));
    console.log(`[generate-weekly-report] no snapshots → wrote placeholder ${reportPath}`);
    return;
  }

  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

  const hasAnyKeywords = DATABASES.some((db) => {
    const rows = latest.data.topKeywords?.[db];
    return Array.isArray(rows) && rows.length > 0;
  });
  if (!hasAnyKeywords) {
    writeFileSync(reportPath, noDataTemplate(week));
    console.log(`[generate-weekly-report] empty snapshot → wrote placeholder ${reportPath}`);
    return;
  }

  const md = buildReport({ week, latest, previous });
  writeFileSync(reportPath, md);
  console.log(`[generate-weekly-report] wrote → ${reportPath}`);
}

try {
  main();
} catch (err) {
  console.error('[generate-weekly-report] fatal:', err);
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    const week = weekKey();
    writeFileSync(
      join(REPORT_DIR, `week-${week}.md`),
      `# Weekly SEO report — week ${week}\n\nReport generation failed: ${err.message}\n`,
    );
  } catch {
    // already reported
  }
  process.exit(0);
}

export {
  loadDomainSnapshots,
  keywordsInBucket,
  toPhraseSet,
  sumTraffic,
  computeDeltaForDatabase,
  formatDelta,
  buildReport,
  noDataTemplate,
  weekKey,
  isoWeekAndYear,
};
