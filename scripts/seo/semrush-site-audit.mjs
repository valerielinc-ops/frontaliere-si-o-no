#!/usr/bin/env node
/**
 * semrush-site-audit.mjs — H.10 Weekly SEMrush Site Audit snapshot
 *
 * Fetches the latest site-audit snapshot from SEMrush Projects API and:
 *   1. Saves to data/seo-snapshots/site-audit-YYYY-MM-DD.json
 *   2. Diffs vs previous site-audit snapshot
 *   3. Writes reports/site-audit-diff-YYYY-MM-DD.md
 *
 * Regression flags:
 *   • quality_score < 85
 *   • errors > baseline (previous snapshot errors count)
 * Regressions are logged to stderr and emitted in the diff report.
 * The script still exits 0 so the overall workflow keeps running; upstream
 * alerting (GitHub issue, Linear, Slack) is handled by F.2 separately.
 *
 * Usage:
 *   node scripts/seo/semrush-site-audit.mjs              # API
 *   node scripts/seo/semrush-site-audit.mjs --dry-run    # no HTTP, stub
 *
 * Environment:
 *   SEMRUSH_API_KEY     — required for non-dry-run mode
 *   SEMRUSH_PROJECT_ID  — optional; if unset we cannot resolve the audit
 *                         and fall back to an empty snapshot (exit 0)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SNAPSHOT_DIR = join(ROOT, 'data', 'seo-snapshots');
const REPORTS_DIR = join(ROOT, 'reports');

const QUALITY_FLOOR = 85;

function isoDate(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function emptySnapshot(date, reason) {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    date,
    reason,
    projectId: null,
    qualityScore: null,
    errors: null,
    warnings: null,
    notices: null,
    issues: [],
  };
}

/**
 * Find the most recent site-audit snapshot older than the one at `todayPath`.
 * Returns the parsed JSON or null.
 */
function findPreviousSnapshot(snapshotDir, todayPath) {
  if (!existsSync(snapshotDir)) return null;
  const files = readdirSync(snapshotDir)
    .filter((f) => f.startsWith('site-audit-') && f.endsWith('.json'))
    .filter((f) => join(snapshotDir, f) !== todayPath)
    .sort()
    .reverse();
  for (const f of files) {
    try {
      const raw = readFileSync(join(snapshotDir, f), 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return { file: f, data };
    } catch {
      // skip corrupt files
    }
  }
  return null;
}

function diffCount(current, previous) {
  if (current == null || previous == null) return null;
  return current - previous;
}

function formatDelta(n) {
  if (n == null) return 'n/a';
  if (n === 0) return '±0';
  return n > 0 ? `+${n}` : `${n}`;
}

function buildDiffReport({ today, current, previous, regressions }) {
  const lines = [];
  lines.push(`# Site Audit Diff — ${today}`);
  lines.push('');
  lines.push(`Source: SEMrush Site Audit snapshot for \`frontaliereticino.ch\`.`);
  lines.push('');

  if (regressions.length > 0) {
    lines.push('## Regressions detected');
    lines.push('');
    for (const r of regressions) lines.push(`- ${r}`);
    lines.push('');
  } else {
    lines.push('## No regressions detected');
    lines.push('');
  }

  lines.push('## Scores');
  lines.push('');
  lines.push('| Metric | Current | Previous | Delta |');
  lines.push('|---|---|---|---|');
  const prev = previous?.data ?? null;
  const rows = [
    ['Quality score', current.qualityScore, prev?.qualityScore],
    ['Errors', current.errors, prev?.errors],
    ['Warnings', current.warnings, prev?.warnings],
    ['Notices', current.notices, prev?.notices],
  ];
  for (const [label, cur, pr] of rows) {
    lines.push(`| ${label} | ${cur ?? 'n/a'} | ${pr ?? 'n/a'} | ${formatDelta(diffCount(cur, pr))} |`);
  }
  lines.push('');

  if (Array.isArray(current.issues) && current.issues.length > 0) {
    lines.push('## Top issues');
    lines.push('');
    const top = current.issues.slice(0, 20);
    lines.push('| Check ID | Count | Severity |');
    lines.push('|---|---|---|');
    for (const issue of top) {
      lines.push(
        `| ${issue.id ?? 'n/a'} | ${issue.count ?? 0} | ${issue.severity ?? 'n/a'} |`,
      );
    }
    lines.push('');
  }

  if (previous) {
    lines.push(`Previous snapshot: \`${previous.file}\``);
  } else {
    lines.push('Previous snapshot: none (first run).');
  }
  lines.push('');
  return lines.join('\n');
}

async function fetchLatestAudit(apiKey, projectId) {
  // SEMrush Projects API — Site Audit results (v1).
  // Endpoint format documented at https://developer.semrush.com/api/v1/projects/
  const url = new URL(`https://api.semrush.com/reports/v1/projects/${projectId}/siteaudit/campaign/`);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

function normaliseAudit(raw) {
  // Defensive mapping — the SEMrush payload shape can vary across plans.
  const snap = {
    qualityScore: null,
    errors: null,
    warnings: null,
    notices: null,
    issues: [],
  };
  if (!raw || typeof raw !== 'object') return snap;
  snap.qualityScore = raw.qualityScore ?? raw.quality_score ?? raw.qs ?? null;
  snap.errors = raw.errors ?? raw.total_errors ?? null;
  snap.warnings = raw.warnings ?? raw.total_warnings ?? null;
  snap.notices = raw.notices ?? raw.total_notices ?? null;
  const issuesRaw = Array.isArray(raw.issues) ? raw.issues
    : Array.isArray(raw.defects) ? raw.defects
      : [];
  snap.issues = issuesRaw.map((i) => ({
    id: i.check_id ?? i.id ?? null,
    count: i.count ?? i.value ?? 0,
    severity: i.severity ?? i.type ?? null,
  }));
  return snap;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const today = isoDate();
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const snapshotPath = join(SNAPSHOT_DIR, `site-audit-${today}.json`);
  const reportPath = join(REPORTS_DIR, `site-audit-diff-${today}.md`);

  const apiKey = process.env.SEMRUSH_API_KEY;
  const projectId = process.env.SEMRUSH_PROJECT_ID;

  let current = emptySnapshot(today, null);

  if (dryRun) {
    console.log('[semrush-site-audit] --dry-run: skipping API calls');
    current = { ...emptySnapshot(today, 'dry-run') };
  } else if (!apiKey) {
    console.warn('[semrush-site-audit] SEMRUSH_API_KEY not set — writing empty snapshot');
    current = emptySnapshot(today, 'no-api-key');
  } else if (!projectId) {
    console.warn('[semrush-site-audit] SEMRUSH_PROJECT_ID not set — writing empty snapshot');
    current = emptySnapshot(today, 'no-project-id');
  } else {
    try {
      const raw = await fetchLatestAudit(apiKey, projectId);
      const norm = normaliseAudit(raw);
      current = {
        version: 1,
        capturedAt: new Date().toISOString(),
        date: today,
        projectId,
        ...norm,
      };
    } catch (err) {
      console.error(`[semrush-site-audit] fetch failed: ${err.message}`);
      current = emptySnapshot(today, `fetch-error: ${err.message}`);
    }
  }

  writeFileSync(snapshotPath, JSON.stringify(current, null, 2));

  const previous = findPreviousSnapshot(SNAPSHOT_DIR, snapshotPath);
  const regressions = [];
  if (current.qualityScore != null && current.qualityScore < QUALITY_FLOOR) {
    regressions.push(`quality_score=${current.qualityScore} is below floor ${QUALITY_FLOOR}`);
  }
  if (previous?.data && current.errors != null && previous.data.errors != null) {
    if (current.errors > previous.data.errors) {
      regressions.push(`errors rose from ${previous.data.errors} → ${current.errors}`);
    }
  }

  const md = buildDiffReport({ today, current, previous, regressions });
  writeFileSync(reportPath, md);

  console.log(`[semrush-site-audit] wrote → ${snapshotPath}`);
  console.log(`[semrush-site-audit] wrote → ${reportPath}`);
  if (regressions.length > 0) {
    console.warn(`[semrush-site-audit] ${regressions.length} regression(s) detected`);
  }
}

main().catch((err) => {
  console.error('[semrush-site-audit] fatal:', err);
  try {
    const today = isoDate();
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    mkdirSync(REPORTS_DIR, { recursive: true });
    const snap = emptySnapshot(today, `fatal: ${err.message}`);
    writeFileSync(join(SNAPSHOT_DIR, `site-audit-${today}.json`), JSON.stringify(snap, null, 2));
    writeFileSync(
      join(REPORTS_DIR, `site-audit-diff-${today}.md`),
      `# Site Audit Diff — ${today}\n\nScript failed: ${err.message}\n`,
    );
  } catch (inner) {
    console.error('[semrush-site-audit] could not write fallback:', inner);
  }
  process.exit(0);
});

export {
  QUALITY_FLOOR,
  emptySnapshot,
  findPreviousSnapshot,
  diffCount,
  formatDelta,
  buildDiffReport,
  normaliseAudit,
  isoDate,
};
