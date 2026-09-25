#!/usr/bin/env node

/**
 * audit-cron-dispatch-delay.mjs — reads the cron-slot measurements and answers
 * the one question they exist for: which slot would fire a daily send EARLIEST
 * in the UTC day (#3798 Fase 1 follow-up).
 *
 * Two modes:
 *
 *   --from-history (default)  Summarise data/cron-dispatch-history.jsonl, the
 *                             paired daily samples written by
 *                             scripts/ci/probe-cron-dispatch-delay.mjs. Needs
 *                             no credentials and no network.
 *   --scan                    Re-run the repo-wide audit live against the
 *                             Actions API: every workflow with a fixed-hour
 *                             cron, delay = run.created_at − nominal minute.
 *                             This is the audit from 2026-08-05, kept as code
 *                             so the next person reads a number instead of
 *                             rebuilding the methodology.
 *
 * WHY THE METRIC IS "EFFECTIVE START", NOT "DELAY"
 * ------------------------------------------------
 * scripts/lib/send-schedule.mjs computeScheduledSendAt schedules each
 * subscriber for the NEXT occurrence of their preferred hour. Every subscriber
 * whose hour has already passed when the run fires is therefore pushed onto
 * tomorrow's slot and receives ~24h-old content. So the cost of a slot is the
 * share of the base already past its hour at the effective start — which
 * `deferralShare` below estimates — and a punctual-but-late slot loses to a
 * drifty-but-early one. Ranking by delay alone gets this backwards.
 *
 * The default estimate assumes preferred hours are spread uniformly across the
 * day, which needs no credentials and is enough to separate candidates that are
 * hours apart. Pass --hour-histogram <file.json> (a `{"0": n, "1": n, …}` map of
 * preferred_send_hour_utc counts) to score against the real distribution.
 *
 * Read-only. Sends nothing, writes nothing.
 *
 * Usage:
 *   node scripts/ci/audit-cron-dispatch-delay.mjs
 *   node scripts/ci/audit-cron-dispatch-delay.mjs --compare 23:17 00:33
 *   node scripts/ci/audit-cron-dispatch-delay.mjs --hour-histogram /tmp/hours.json
 *   node scripts/ci/audit-cron-dispatch-delay.mjs --scan --days 30
 *   node scripts/ci/audit-cron-dispatch-delay.mjs --json
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutputPath } from '../lib/resolve-output-path.mjs';
import { DEFAULT_HISTORY_FILE } from './probe-cron-dispatch-delay.mjs';

const MINUTES_PER_DAY = 1440;

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function readHistory(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Share of subscribers whose preferred hour has already passed at `minute` of
 * the UTC day — i.e. who get deferred to tomorrow and receive ~24h-old content.
 *
 * Hour h is "already passed" when h*60 <= minute. Hour 0 counts as passed for
 * any start after 00:00, which is correct: computeScheduledSendAt applies a
 * 15-minute anti-race lead, so a slot at exactly h*60 is not reachable anyway.
 *
 * @param {number} minuteOfDay
 * @param {Record<string number>|null} hourHistogram - counts keyed by UTC hour; null → uniform
 * @returns {number} 0..1
 */
export function deferralShare(minuteOfDay, hourHistogram = null) {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY, minuteOfDay));
  if (!hourHistogram) return m / MINUTES_PER_DAY;
  let total = 0;
  let passed = 0;
  for (let h = 0; h < 24; h++) {
    const n = Number(hourHistogram[h] ?? hourHistogram[String(h)] ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;
    if (h * 60 <= m) passed += n;
  }
  return total > 0 ? passed / total : m / MINUTES_PER_DAY;
}

/** Group history records by nominal slot and summarise each. */
export function summarizeBySlot(records, hourHistogram = null) {
  const bySlot = new Map();
  for (const r of records) {
    if (!r?.slot || r.suspect) continue;
    if (!bySlot.has(r.slot)) bySlot.set(r.slot, []);
    bySlot.get(r.slot).push(r);
  }
  const out = [];
  for (const [slot, rows] of bySlot) {
    const delays = rows.map((r) => r.dispatch_delay_minutes).filter((n) => Number.isFinite(n));
    const starts = rows.map((r) => r.effective_start_minute_of_utc_day).filter((n) => Number.isFinite(n));
    const medianStart = quantile(starts, 0.5);
    out.push({
      slot,
      samples: rows.length,
      suspect: records.filter((r) => r.slot === slot && r.suspect).length,
      delayMedian: quantile(delays, 0.5),
      delayP90: quantile(delays, 0.9),
      delayMax: delays.length ? Math.max(...delays) : null,
      startMedianMinute: medianStart,
      startP90Minute: quantile(starts, 0.9),
      deferralShareMedian: medianStart == null ? null : deferralShare(medianStart, hourHistogram),
    });
  }
  // Rank by the decision metric: earliest median effective start wins.
  return out.sort((a, b) => (a.startMedianMinute ?? Infinity) - (b.startMedianMinute ?? Infinity));
}

/**
 * Pair two slots by the UTC day their runs SERVE, so day-to-day swings in
 * GitHub's global backlog cancel instead of being mistaken for a slot effect.
 *
 * A 23:17 run and the 00:33 run of the next morning belong to the same night,
 * so pairing on calendar date would never match them. Both are keyed by the
 * date of the nominal instant rounded FORWARD to the next midnight — the
 * "delivery day" both slots are feeding.
 * @returns {{pairs: Array, medianDeltaMinutes: number|null, aWinsShare: number|null}}
 */
export function pairedComparison(records, slotA, slotB) {
  const key = (r) => {
    const nominal = new Date(r.nominal_at);
    // Late-evening slots serve the following day; anything from 00:00 on serves its own day.
    const serves = new Date(nominal);
    if (nominal.getUTCHours() >= 12) serves.setUTCDate(serves.getUTCDate() + 1);
    return serves.toISOString().slice(0, 10);
  };
  const byDayA = new Map();
  const byDayB = new Map();
  for (const r of records) {
    if (r?.suspect || !Number.isFinite(r?.effective_start_minute_of_utc_day)) continue;
    if (r.slot === slotA) byDayA.set(key(r), r);
    else if (r.slot === slotB) byDayB.set(key(r), r);
  }
  const pairs = [];
  for (const [day, a] of byDayA) {
    const b = byDayB.get(day);
    if (!b) continue;
    pairs.push({
      day,
      aStartMinute: a.effective_start_minute_of_utc_day,
      bStartMinute: b.effective_start_minute_of_utc_day,
      deltaMinutes: a.effective_start_minute_of_utc_day - b.effective_start_minute_of_utc_day,
    });
  }
  if (!pairs.length) return { pairs, medianDeltaMinutes: null, aWinsShare: null };
  return {
    pairs,
    medianDeltaMinutes: quantile(pairs.map((p) => p.deltaMinutes), 0.5),
    aWinsShare: pairs.filter((p) => p.deltaMinutes < 0).length / pairs.length,
  };
}

const fmtMinute = (m) => (m == null ? '—' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
const fmtPct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);

export function renderHistoryReport(summaries, comparison, { slotA, slotB, totalRecords, hourHistogram }) {
  const lines = [];
  lines.push('⏱  Cron dispatch-delay canary (#3798 Fase 1 follow-up)');
  lines.push(`   ${totalRecords} sample(s); ranked by EFFECTIVE START in the UTC day — earlier is better,`);
  lines.push('   because computeScheduledSendAt defers every subscriber whose hour already passed.');
  lines.push(`   Deferral share estimated against ${hourHistogram ? 'the supplied preferred-hour histogram' : 'a uniform preferred-hour distribution'}.`);
  lines.push('');
  lines.push('  slot    n   delay med    p90     max   eff.start med   p90     deferred');
  lines.push('  ----- ---- ----------  ------  ------  -------------  ------  --------');
  for (const s of summaries) {
    lines.push(
      `  ${s.slot.padEnd(5)} ${String(s.samples).padStart(4)} ${(s.delayMedian == null ? '—' : `${s.delayMedian.toFixed(0)}m`).padStart(10)} ${(s.delayP90 == null ? '—' : `${s.delayP90.toFixed(0)}m`).padStart(7)} ${(s.delayMax == null ? '—' : `${s.delayMax.toFixed(0)}m`).padStart(7)}  ${fmtMinute(s.startMedianMinute).padStart(13)} ${fmtMinute(s.startP90Minute).padStart(7)}  ${fmtPct(s.deferralShareMedian).padStart(8)}`,
    );
  }
  if (summaries.some((s) => s.suspect > 0)) {
    lines.push('');
    lines.push(`  ⚠️  ${summaries.reduce((n, s) => n + s.suspect, 0)} suspect sample(s) (>12h late — likely a skipped occurrence) excluded from the stats but kept in the file.`);
  }
  lines.push('');
  if (comparison.medianDeltaMinutes == null) {
    lines.push(`  → ${slotA} vs ${slotB}: no paired days yet. The canary needs at least one night where both slots fired.`);
  } else {
    const better = comparison.medianDeltaMinutes < 0 ? slotA : slotB;
    lines.push(`  → ${slotA} vs ${slotB} (${comparison.pairs.length} paired night(s)): median effective start differs by ${comparison.medianDeltaMinutes.toFixed(0)} min; ${slotA} starts earlier on ${fmtPct(comparison.aWinsShare)} of nights.`);
    lines.push(`     Earlier slot on the paired sample: ${better}.`);
  }
  lines.push('');
  lines.push('  Decide only once the sample is wide enough to be boring (≥14 paired nights).');
  lines.push('  If the earlier slot wins, move send-job-alerts.yml onto it — nothing else changes.');
  return lines.join('\n');
}

// ── --scan: the repo-wide live audit, kept reproducible ──────────────────────

async function ghJson(url, token) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) return null;
  return res.json();
}

/** Extract fixed-hour daily crons (`M H * * *`) from a workflow file's text. */
export function extractFixedHourCrons(text) {
  return [...String(text).matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)]
    .map((m) => m[1].trim().split(/\s+/))
    .filter((p) => p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]))
    .map((p) => ({ minute: Number(p[0]), hour: Number(p[1]) }));
}

async function runScan(argv) {
  const repo = process.env.GITHUB_REPOSITORY || 'valerielinc-ops/frontaliere-si-o-no';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const dir = argValue(argv, '--workflows') || '.github/workflows';
  const limit = Number(argValue(argv, '--limit') || 30);

  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const rows = [];
  for (const file of files) {
    const crons = extractFixedHourCrons(readFileSync(path.join(dir, file), 'utf8'));
    if (!crons.length) continue;
    const data = await ghJson(`https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=${limit}&event=schedule`, token);
    for (const run of data?.workflow_runs || []) {
      const created = new Date(run.created_at);
      let best = null;
      for (const slot of crons) {
        for (const backDay of [0, 1]) {
          const nominal = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate() - backDay, slot.hour, slot.minute));
          if (nominal > created) continue;
          const delay = (created - nominal) / 60000;
          if (best === null || delay < best.delay) best = { delay, hour: slot.hour, minute: slot.minute };
        }
      }
      if (best && best.delay <= 12 * 60) {
        rows.push({ file, slotHour: best.hour, delayMinutes: best.delay, startMinute: created.getUTCHours() * 60 + created.getUTCMinutes() });
      }
    }
  }

  const byHour = new Map();
  for (const r of rows) {
    if (!byHour.has(r.slotHour)) byHour.set(r.slotHour, []);
    byHour.get(r.slotHour).push(r);
  }
  console.log(`\n⏱  Repo-wide cron dispatch audit — ${rows.length} scheduled runs across ${new Set(rows.map((r) => r.file)).size} workflows\n`);
  console.log('  slot-h  workflows     n   delay med    p90   eff.start med');
  console.log('  ------  ---------  ----  ----------  -----  -------------');
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
    const rs = byHour.get(h);
    const delays = rs.map((r) => r.delayMinutes);
    const starts = rs.map((r) => r.startMinute);
    console.log(`    ${String(h).padStart(2, '0')}h  ${String(new Set(rs.map((r) => r.file)).size).padStart(9)}  ${String(rs.length).padStart(4)}  ${`${quantile(delays, 0.5).toFixed(0)}m`.padStart(10)} ${`${quantile(delays, 0.9).toFixed(0)}m`.padStart(6)}  ${fmtMinute(quantile(starts, 0.5)).padStart(13)}`);
  }
  console.log('\n  Hours with no row have no workflow scheduled there — that is exactly the gap');
  console.log('  the canary fills for 23:00. See --from-history.\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--scan')) return runScan(argv);

  // `--file` resta esplicito e prevale. L'override d'ambiente passa dallo
  // STESSO resolver del suo scrittore (scripts/ci/probe-cron-dispatch-delay.mjs,
  // issue #7291): senza, lettore e scrittore potrebbero risolvere due percorsi
  // diversi in silenzio — l'audit leggerebbe un file che il probe non scrive.
  const file = argValue(argv, '--file') || resolveOutputPath({
    label: 'audit-cron-dispatch-delay',
    envVar: 'CRON_DISPATCH_HISTORY_FILE',
    canonicalPath: DEFAULT_HISTORY_FILE,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  });
  const records = readHistory(file);

  const histPath = argValue(argv, '--hour-histogram');
  const hourHistogram = histPath && existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : null;

  const compareIdx = argv.indexOf('--compare');
  const slotA = compareIdx >= 0 ? argv[compareIdx + 1] : '23:17';
  const slotB = compareIdx >= 0 ? argv[compareIdx + 2] : '00:33';

  const summaries = summarizeBySlot(records, hourHistogram);
  const comparison = pairedComparison(records, slotA, slotB);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ file, totalRecords: records.length, summaries, comparison: { slotA, slotB, ...comparison } }, null, 2));
    return;
  }

  if (!records.length) {
    console.log(`\n⏱  No samples yet in ${file}. The canary writes one line per scheduled run; check back after a few nights.\n`);
    return;
  }
  console.log(`\n${renderHistoryReport(summaries, comparison, { slotA, slotB, totalRecords: records.length, hourHistogram })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`❌ audit failed: ${err?.message || err}`);
    process.exit(1);
  });
}
