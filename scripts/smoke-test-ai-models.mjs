#!/usr/bin/env node
/**
 * smoke-test-ai-models.mjs — single ping per model in DEFAULT_CHAIN.
 *
 * Sends one minimal prompt ("Reply with 'ok'.") to every model in the
 * default chain and records: pass / 404 / 401 / 429 / 4xx / 5xx / other.
 *
 * Usage: node scripts/smoke-test-ai-models.mjs > /tmp/smoke.json
 *
 * Requires the same env that ai-models.mjs needs (load-rc-env.mjs first).
 */
import { callLLM, DEFAULT_CHAIN, AI_MODELS } from './lib/ai-models.mjs';

const MODELS = [...new Set(DEFAULT_CHAIN)];
console.error(`Smoke-testing ${MODELS.length} models, one-by-one…`);

const results = [];
for (const model of MODELS) {
  const t0 = Date.now();
  let status = 'unknown';
  let detail = '';
  try {
    const out = await callLLM(
      [{ role: 'user', content: "Reply with 'ok'." }],
      { temperature: 0, maxTokens: 8, chain: [model], retries: 0 }
    );
    status = out ? 'pass' : 'empty';
    detail = String(out || '').slice(0, 60);
  } catch (e) {
    const msg = String(e?.message || e);
    detail = msg.slice(0, 220);
    const m = msg.match(/\bHTTP\s+(\d{3})\b/);
    if (m) status = `http_${m[1]}`;
    else if (/timeout|ETIMEDOUT|abort/i.test(msg)) status = 'timeout';
    else if (/ENOTFOUND|ECONNRESET|ECONN/i.test(msg)) status = 'net';
    else if (/No API key|missing.+key/i.test(msg)) status = 'no_key';
    else if (/all_models_failed|All models failed/i.test(msg)) status = 'all_failed';
    else status = 'error';
  }
  const ms = Date.now() - t0;
  results.push({ model, status, ms, detail });
  const tag = status === 'pass' ? '✅' : status === 'empty' ? '⚠️' : '❌';
  console.error(`${tag} ${model.padEnd(80)} ${status.padEnd(12)} ${ms}ms`);
}

const summary = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});
console.error('\n--- SUMMARY ---');
console.error(JSON.stringify(summary, null, 2));

const dead = results.filter(r => /^http_404$/.test(r.status));
if (dead.length) {
  console.error('\n--- DEAD MODELS (404) ---');
  for (const d of dead) console.error(`  ${d.model}  →  ${d.detail}`);
}

console.log(JSON.stringify({ summary, results }, null, 2));
