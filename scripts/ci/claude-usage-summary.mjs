#!/usr/bin/env node
// Parse claude-code-action's `execution_file` and emit EXACT token/cost
// metrics for the run, so per-workflow Claude burn is measurable (not estimated).
// Writes a markdown table to $GITHUB_STEP_SUMMARY + a grep-able CLAUDE_USAGE
// line to stdout (queryable via `gh run view --log`).
// Usage: node scripts/ci/claude-usage-summary.mjs <execution_file> [label]
// Best-effort: never throws, never fails the job.
import fs from 'node:fs';

const file = process.argv[2];
const label = process.argv[3] || process.env.GITHUB_WORKFLOW || 'claude';

const t = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, cost_usd: 0, num_turns: 0, duration_ms: 0 };

function addUsage(u) {
  if (!u || typeof u !== 'object') return;
  t.input_tokens += u.input_tokens || 0;
  t.output_tokens += u.output_tokens || 0;
  t.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  t.cache_read_input_tokens += u.cache_read_input_tokens || 0;
}
function parseMessages(raw) {
  const s = raw.trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.messages)) return j.messages;
    return [j];
  } catch {
    const out = [];
    for (const line of s.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out;
  }
}

let parsed = false;
try {
  if (file && fs.existsSync(file)) {
    const msgs = parseMessages(fs.readFileSync(file, 'utf8'));
    const result = [...msgs].reverse().find((m) => m && m.type === 'result');
    if (result) {
      addUsage(result.usage);
      t.cost_usd = result.total_cost_usd || result.cost_usd || 0;
      t.num_turns = result.num_turns || 0;
      t.duration_ms = result.duration_ms || 0;
      parsed = true;
    }
    if (!parsed) {
      for (const m of msgs) {
        const u = m?.message?.usage || m?.usage;
        if (u) { addUsage(u); parsed = true; }
      }
    }
  }
} catch (e) {
  console.log(`[claude-usage] non-fatal parse error: ${String(e).slice(0, 120)}`);
}

const totalIn = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
const grand = totalIn + t.output_tokens;
const fmt = (n) => n.toLocaleString('en-US');

console.log(
  `CLAUDE_USAGE workflow="${label}" parsed=${parsed} ` +
  `input=${t.input_tokens} output=${t.output_tokens} ` +
  `cache_create=${t.cache_creation_input_tokens} cache_read=${t.cache_read_input_tokens} ` +
  `total_tokens=${grand} cost_usd=${t.cost_usd.toFixed(4)} ` +
  `turns=${t.num_turns} duration_ms=${t.duration_ms}`
);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const md = parsed
    ? [`### 🤖 Claude usage — ${label}`, '', '| metric | value |', '|---|---:|',
       `| input tokens | ${fmt(t.input_tokens)} |`,
       `| cache write tokens | ${fmt(t.cache_creation_input_tokens)} |`,
       `| cache read tokens | ${fmt(t.cache_read_input_tokens)} |`,
       `| output tokens | ${fmt(t.output_tokens)} |`,
       `| **total tokens** | **${fmt(grand)}** |`,
       `| turns | ${t.num_turns} |`,
       `| **cost (USD, list price)** | **$${t.cost_usd.toFixed(4)}** |`, '',
       '_Cost is list-price equivalent; actual billing is the Max subscription (OAuth), $0 marginal. Use token figures to compare/optimize workflows._', ''].join('\n')
    : `### 🤖 Claude usage — ${label}\n\n_No execution_file metrics available (step skipped/failed before Claude ran, or output empty)._\n`;
  try { fs.appendFileSync(summary, md + '\n'); } catch { /* best effort */ }
}
