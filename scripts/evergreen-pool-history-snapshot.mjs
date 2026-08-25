#!/usr/bin/env node
/**
 * evergreen-pool-history-snapshot.mjs — turn a
 * `scripts/evergreen-pool-consumption.mjs --json` payload into an
 * append-only history of the evergreen topic pool + a markdown summary
 * (parent #6019 item 2b: the consumption tool from #6445 had no periodic
 * wiring, so the pool's consumption RATE over time was not computable —
 * you need ≥2 dated points for a rate).
 *
 * It does NOT compute the pool itself: it consumes the JSON already
 * produced by `scripts/evergreen-pool-consumption.mjs --json` (array of
 * `{section, poolTotal, poolRemaining, poolConsumed, poolConsumedPct}`).
 * Same pattern as `scripts/funnel-metrics-snapshot.mjs` /
 * `data/funnel-metrics-history.json`.
 *
 * Pipeline (see .github/workflows/evergreen-pool-snapshot.yml):
 *   node scripts/evergreen-pool-consumption.mjs --json > /tmp/pool.json
 *   node scripts/evergreen-pool-history-snapshot.mjs \
 *     --in=/tmp/pool.json \
 *     --history=data/evergreen-pool-history.json \
 *     --summary-out=/tmp/pool-summary.md
 *
 * Flags:
 *   --in=<path>           evergreen-pool-consumption --json output (required)
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
  console.error('evergreen-pool-history-snapshot: --in and --history are required');
  process.exit(2);
}
if (!existsSync(IN)) {
  console.error(`evergreen-pool-history-snapshot: input not found: ${IN}`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(IN, 'utf8'));
} catch (e) {
  console.error(`evergreen-pool-history-snapshot: cannot parse ${IN}: ${e.message}`);
  process.exit(2);
}

const rows = Array.isArray(payload) ? payload : [];
const snapshot = {
  date: new Date().toISOString().slice(0, 10),
  sections: rows.map((r) => ({
    section: r.section,
    poolTotal: r.poolTotal ?? null,
    poolRemaining: r.poolRemaining ?? null,
    poolConsumedPct: r.poolConsumedPct ?? null,
  })),
};

// Append to history (capped, deduped by date — last write wins).
let history = { updatedAt: null, entries: [] };
if (existsSync(HISTORY)) {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) history = parsed;
  } catch (e) {
    console.error(`evergreen-pool-history-snapshot: history unreadable, starting fresh: ${e.message}`);
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
console.error(`evergreen-pool-history-snapshot: appended ${snapshot.date} -> ${HISTORY} (${history.entries.length} entries)`);

// Markdown summary — includes the consumption-rate delta vs the previous
// entry (this is the datum #6446 exists to make computable: no rate with
// <2 points).
const prev = history.entries.length >= 2 ? history.entries[history.entries.length - 2] : null;

function fmt(v, unit = '') {
  if (v === null || v === undefined) return '—';
  return `${v}${unit}`;
}

const lines = [];
lines.push(`### 🌲 Evergreen pool history snapshot — ${snapshot.date}`);
lines.push('');
if (!prev) {
  lines.push('_First snapshot recorded — a consumption rate needs ≥2 dated points, so none is shown yet._');
} else {
  lines.push(`_Rate vs previous snapshot (${prev.date})._`);
}
lines.push('');

for (const s of snapshot.sections) {
  const prevSection = prev?.sections?.find((p) => p.section === s.section) ?? null;
  lines.push(`**${s.section}**`);
  lines.push(`- Pool total: \`${fmt(s.poolTotal)}\``);
  lines.push(`- Pool remaining: \`${fmt(s.poolRemaining)}\``);
  lines.push(`- Pool consumed: \`${fmt(s.poolConsumedPct, '%')}\``);
  if (prevSection && s.poolRemaining != null && prevSection.poolRemaining != null) {
    const consumedSincePrev = prevSection.poolRemaining - s.poolRemaining;
    lines.push(`- Consumed since ${prev.date}: \`${consumedSincePrev}\` topics`);
  }
  lines.push('');
}

lines.push(`Full history: [\`data/evergreen-pool-history.json\`](../blob/main/data/evergreen-pool-history.json) (${history.entries.length} snapshots).`);

const summary = lines.join('\n') + '\n';
if (SUMMARY_OUT) {
  writeFileSync(SUMMARY_OUT, summary);
  console.error(`evergreen-pool-history-snapshot: summary -> ${SUMMARY_OUT}`);
} else {
  process.stdout.write(summary);
}
