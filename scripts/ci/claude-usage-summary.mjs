#!/usr/bin/env node
// Parse claude-code-action's `execution_file` and emit EXACT token/cost
// metrics for the run, so per-workflow Claude burn is measurable (not estimated).
// Writes a markdown table to $GITHUB_STEP_SUMMARY + a grep-able CLAUDE_USAGE
// line to stdout (queryable via `gh run view --log`).
// Usage: node scripts/ci/claude-usage-summary.mjs <execution_file> [label]
// Best-effort: never throws, never fails the job.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function finiteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function finiteNumber(value) {
  return finiteNumberOrNull(value) ?? 0;
}

/**
 * Parse one grep-able line emitted by this script.
 *
 * `parsed=false` is deliberately retained as a record but is excluded from
 * cost/token aggregates: a skipped or failed Claude step is not a zero-cost
 * Claude run. This is the same distinction used by the #7267 cost audit.
 */
export function parseClaudeUsageLine(line) {
  const match = String(line ?? '').trim().match(
    /^CLAUDE_USAGE workflow="([^"]*)" parsed=(true|false) input=([0-9]+(?:\.[0-9]+)?) output=([0-9]+(?:\.[0-9]+)?) cache_create=([0-9]+(?:\.[0-9]+)?) cache_read=([0-9]+(?:\.[0-9]+)?) total_tokens=([0-9]+(?:\.[0-9]+)?) cost_usd=([0-9]+(?:\.[0-9]+)?) turns=([0-9]+(?:\.[0-9]+)?) duration_ms=([0-9]+(?:\.[0-9]+)?)$/,
  );
  if (!match) return null;
  const [, workflow, parsed, input, output, cacheCreate, cacheRead, totalTokens, costUsd, turns, durationMs] = match;
  const values = [input, output, cacheCreate, cacheRead, totalTokens, costUsd, turns, durationMs].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return {
    workflow,
    parsed: parsed === 'true',
    input: values[0],
    output: values[1],
    cacheCreate: values[2],
    cacheRead: values[3],
    totalTokens: values[4],
    costUsd: values[5],
    turns: values[6],
    durationMs: values[7],
  };
}

function aggregateRecords(records) {
  const parsedRecords = records.filter((record) => record.parsed);
  const totalCostUsd = parsedRecords.reduce((sum, record) => sum + record.costUsd, 0);
  const totals = parsedRecords.reduce((sum, record) => ({
    input: sum.input + record.input,
    output: sum.output + record.output,
    cacheCreate: sum.cacheCreate + record.cacheCreate,
    cacheRead: sum.cacheRead + record.cacheRead,
    totalTokens: sum.totalTokens + record.totalTokens,
  }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, totalTokens: 0 });
  const costs = parsedRecords.map((record) => record.costUsd).sort((a, b) => a - b);
  const middle = Math.floor(costs.length / 2);
  const medianCostUsd = costs.length === 0 ? null : costs.length % 2 === 1
    ? costs[middle]
    : (costs[middle - 1] + costs[middle]) / 2;
  const cacheInput = totals.input + totals.cacheCreate + totals.cacheRead;

  return {
    lines: records.length,
    parsedRuns: parsedRecords.length,
    unparsedLines: records.length - parsedRecords.length,
    totalCostUsd,
    meanCostUsd: parsedRecords.length > 0 ? totalCostUsd / parsedRecords.length : null,
    medianCostUsd,
    cacheReadShare: cacheInput > 0 ? totals.cacheRead / cacheInput : null,
    totals,
  };
}

/**
 * Aggregate the exact `CLAUDE_USAGE` records from a comparison window.
 * Cache-read share uses input + cache-create + cache-read, matching the
 * baseline convention recorded for #7267 rather than all tokens including
 * output.
 */
export function aggregateClaudeUsage(lines) {
  const records = Array.from(lines ?? [], parseClaudeUsageLine).filter(Boolean);
  const summary = aggregateRecords(records);
  const byWorkflow = new Map();
  for (const record of records) {
    const group = byWorkflow.get(record.workflow) || [];
    group.push(record);
    byWorkflow.set(record.workflow, group);
  }
  summary.byWorkflow = Object.fromEntries(
    [...byWorkflow.entries()].map(([workflow, group]) => [workflow, aggregateRecords(group)]),
  );
  return summary;
}

function addUsage(target, u) {
  if (!u || typeof u !== 'object') return;
  target.input_tokens += finiteNumber(u.input_tokens);
  target.output_tokens += finiteNumber(u.output_tokens);
  target.cache_creation_input_tokens += finiteNumber(u.cache_creation_input_tokens);
  target.cache_read_input_tokens += finiteNumber(u.cache_read_input_tokens);
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

function main() {
  const file = process.argv[2];
  const label = process.argv[3] || process.env.GITHUB_WORKFLOW || 'claude';
  const t = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, cost_usd: 0, num_turns: 0, duration_ms: 0 };

  let parsed = false;
  try {
    if (file && fs.existsSync(file)) {
      const msgs = parseMessages(fs.readFileSync(file, 'utf8'));
      const result = [...msgs].reverse().find((m) => m && m.type === 'result');
      if (result) {
        addUsage(t, result.usage);
        t.cost_usd = finiteNumberOrNull(result.total_cost_usd) ?? finiteNumber(result.cost_usd);
        t.num_turns = finiteNumber(result.num_turns);
        t.duration_ms = finiteNumber(result.duration_ms);
        parsed = true;
      }
      if (!parsed) {
        for (const m of msgs) {
          const u = m?.message?.usage || m?.usage;
          if (u) { addUsage(t, u); parsed = true; }
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
    `turns=${t.num_turns} duration_ms=${t.duration_ms}`,
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
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main();
}
