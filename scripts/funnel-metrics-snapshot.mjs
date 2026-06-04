#!/usr/bin/env node
/**
 * funnel-metrics-snapshot.mjs — turn a revenue-monitor JSON payload into a
 * compact, append-only funnel-metrics snapshot + a markdown summary for the
 * RPM/CLS tracker issues (#886, #855, #888, #857).
 *
 * It does NOT fetch anything itself: it consumes the JSON already produced by
 * `scripts/revenue-monitor.mjs --json` (which is fail-soft and aggregates
 * AdSense RPM, GSC avg position + CTR-by-bucket, and PostHog CLS p75
 * mobile/desktop). This keeps a single source of truth for the field data and
 * zero duplicated API logic — and zero Claude usage.
 *
 * Pipeline (see .github/workflows/funnel-metrics-snapshot.yml):
 *   node scripts/revenue-monitor.mjs --json > /tmp/revenue.json
 *   node scripts/funnel-metrics-snapshot.mjs \
 *     --in=/tmp/revenue.json \
 *     --history=data/funnel-metrics-history.json \
 *     --summary-out=/tmp/funnel-summary.md
 *
 * Behaviour:
 *   - Reads the revenue JSON, extracts only the funnel-relevant fields.
 *   - Appends one dated entry to the history file (capped to MAX_ENTRIES so the
 *     accumulator stays small — this is a metrics log, not the fat job data).
 *   - Writes a markdown summary (current snapshot + tracker-relevant deltas).
 *   - Always exits 0 unless the input is unreadable: a partial snapshot (e.g.
 *     PostHog down but GSC/AdSense fine) is still committed and surfaced.
 *
 * Flags:
 *   --in=<path>           revenue-monitor --json output (required)
 *   --history=<path>      history JSON to append to (required)
 *   --summary-out=<path>  markdown summary destination (optional)
 *   --max-entries=<n>     history cap (default 104 ≈ 2y weekly)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

const IN = flag('in');
const HISTORY = flag('history');
const SUMMARY_OUT = flag('summary-out');
const MAX_ENTRIES = parseInt(flag('max-entries', '104'), 10) || 104;

if (!IN || !HISTORY) {
  console.error('funnel-metrics-snapshot: --in and --history are required');
  process.exit(2);
}
if (!existsSync(IN)) {
  console.error(`funnel-metrics-snapshot: input not found: ${IN}`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(IN, 'utf8'));
} catch (e) {
  console.error(`funnel-metrics-snapshot: cannot parse ${IN}: ${e.message}`);
  process.exit(2);
}

const cur = payload.current || {};
const adsense = cur.adsense || null;
const gsc = cur.gsc || null;
const posthog = cur.posthog || null;
const errors = Array.isArray(cur.errors) ? cur.errors : [];
const warnings = Array.isArray(cur.warnings) ? cur.warnings : [];

// Compact snapshot: only the fields the trackers care about.
const snapshot = {
  date: new Date().toISOString().slice(0, 10),
  generatedAt: payload.generatedAt || new Date().toISOString(),
  // CLS field data (#886, #855)
  cls: posthog
    ? {
        p75Mobile: posthog.clsP75Mobile ?? null,
        p75Desktop: posthog.clsP75Desktop ?? null,
        window: posthog.window ?? null,
      }
    : null,
  // GSC ranking + CTR (#888)
  gsc: gsc
    ? {
        avgPosition: gsc.avgPosition ?? null,
        clicksPerDay: gsc.clicksPerDay ?? null,
        ctrByBucket: gsc.ctrByBucket ?? null,
      }
    : null,
  // AdSense RPM (#857 content-mix dilution; per-platform is the granularity
  // AdSense exposes here — true per-category RPM is not available via the API).
  adsense: adsense
    ? {
        rpmCHF: adsense.rpmCHF ?? null,
        desktopRpmCHF: adsense.desktopRpmCHF ?? null,
        revenuePerDayCHF: adsense.revenuePerDayCHF ?? null,
      }
    : null,
  sourcesOk: {
    cls: !!posthog,
    gsc: !!gsc,
    adsense: !!adsense,
  },
  errors,
  warnings,
};

// Append to history (capped, deduped by date — last write wins).
let history = { updatedAt: null, entries: [] };
if (existsSync(HISTORY)) {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) history = parsed;
  } catch (e) {
    console.error(`funnel-metrics-snapshot: history unreadable, starting fresh: ${e.message}`);
  }
}
history.entries = history.entries.filter((e) => e.date !== snapshot.date);
history.entries.push(snapshot);
history.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
if (history.entries.length > MAX_ENTRIES) {
  history.entries = history.entries.slice(history.entries.length - MAX_ENTRIES);
}
history.updatedAt = new Date().toISOString();

mkdirSync(dirname(HISTORY), { recursive: true });
writeFileSync(HISTORY, JSON.stringify(history, null, 2) + '\n');
console.error(`funnel-metrics-snapshot: appended ${snapshot.date} -> ${HISTORY} (${history.entries.length} entries)`);

// Markdown summary for the tracker issue comments.
function fmt(v, unit = '') {
  if (v === null || v === undefined) return '—';
  return `${v}${unit}`;
}

const prev = history.entries.length >= 2 ? history.entries[history.entries.length - 2] : null;
function delta(curV, prevV, { higherIsBetter = true } = {}) {
  if (curV == null || prevV == null) return '';
  const d = curV - prevV;
  if (Math.abs(d) < 1e-9) return ' (→)';
  const better = higherIsBetter ? d > 0 : d < 0;
  const sign = d > 0 ? '+' : '';
  return ` (${better ? '🟢' : '🔴'} ${sign}${Number(d.toFixed(3))} vs ${prevV})`;
}

const lines = [];
lines.push(`### 📊 Funnel metrics snapshot — ${snapshot.date}`);
lines.push('');
lines.push('_Field data auto-collected weekly by `funnel-metrics-snapshot.yml` (revenue-monitor → PostHog/GSC/AdSense). These trackers are now data-backed._');
lines.push('');

lines.push('**CLS p75 (PostHog `$web_vitals`, last 7d)** — #886, #855');
if (snapshot.cls) {
  const m = snapshot.cls.p75Mobile;
  const d = snapshot.cls.p75Desktop;
  lines.push(`- Mobile: \`${fmt(m)}\`${delta(m, prev?.cls?.p75Mobile, { higherIsBetter: false })}`);
  lines.push(`- Desktop: \`${fmt(d)}\`${delta(d, prev?.cls?.p75Desktop, { higherIsBetter: false })}`);
} else {
  lines.push('- _unavailable this run (PostHog source skipped/errored — see notes)_');
}
lines.push('');

lines.push('**GSC ranking & CTR (last 7d)** — #888');
if (snapshot.gsc) {
  lines.push(`- Avg position: \`${fmt(snapshot.gsc.avgPosition)}\`${delta(snapshot.gsc.avgPosition, prev?.gsc?.avgPosition, { higherIsBetter: false })}`);
  lines.push(`- Clicks/day: \`${fmt(snapshot.gsc.clicksPerDay)}\``);
  if (snapshot.gsc.ctrByBucket && Object.keys(snapshot.gsc.ctrByBucket).length) {
    lines.push('- CTR by URL bucket (high-CPC = `/fisco/`, `/calcola-stipendio/`, `/guida-frontaliere/`):');
    for (const [bucket, ctr] of Object.entries(snapshot.gsc.ctrByBucket)) {
      const prevCtr = prev?.gsc?.ctrByBucket?.[bucket];
      lines.push(`  - \`${bucket}\`: ${fmt(ctr, '%')}${delta(ctr, prevCtr, { higherIsBetter: true })}`);
    }
  }
} else {
  lines.push('- _unavailable this run (GSC source skipped/errored — see notes)_');
}
lines.push('');

lines.push('**AdSense RPM (last 7d)** — #857');
if (snapshot.adsense) {
  lines.push(`- RPM (CHF): \`${fmt(snapshot.adsense.rpmCHF)}\`${delta(snapshot.adsense.rpmCHF, prev?.adsense?.rpmCHF, { higherIsBetter: true })}`);
  lines.push(`- Desktop RPM (CHF): \`${fmt(snapshot.adsense.desktopRpmCHF)}\`${delta(snapshot.adsense.desktopRpmCHF, prev?.adsense?.desktopRpmCHF, { higherIsBetter: true })}`);
  lines.push(`- Revenue/day (CHF): \`${fmt(snapshot.adsense.revenuePerDayCHF)}\``);
  lines.push('- _Note: AdSense exposes RPM per platform (mobile/desktop), not per content category. For content-mix dilution use CTR-by-bucket above as the category proxy._');
} else {
  lines.push('- _unavailable this run (AdSense source skipped/errored — see notes)_');
}
lines.push('');

if (errors.length || warnings.length) {
  lines.push('**Source notes**');
  for (const w of warnings) lines.push(`- ⚪ ${w}`);
  for (const e of errors) lines.push(`- ⚠️ ${e}`);
  lines.push('');
}

lines.push(`Full history: [\`data/funnel-metrics-history.json\`](../blob/main/data/funnel-metrics-history.json) (${history.entries.length} snapshots).`);

const summary = lines.join('\n') + '\n';
if (SUMMARY_OUT) {
  writeFileSync(SUMMARY_OUT, summary);
  console.error(`funnel-metrics-snapshot: summary -> ${SUMMARY_OUT}`);
} else {
  process.stdout.write(summary);
}
