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
import { callLLM, DEFAULT_CHAIN, AI_MODELS, discoverFreeModels } from './lib/ai-models.mjs';

// stdout of this script is a machine-read JSON contract (the workflow pipes it
// into .tmp/smoke.json and `require()`s it). ai-models.mjs emits diagnostic
// chatter via console.log (Firestore score-store load, daily-quota notices,
// etc.); a single such line on stdout corrupts the JSON. Route ALL console.log
// to stderr so library noise can never leak into the payload — the final JSON
// is written with process.stdout.write below, bypassing console entirely.
// (ai-models.mjs does not log during module evaluation, so patching here —
// after the import, before any call into it — catches every runtime log.)
console.log = (...args) => console.error(...args);

// Run multi-provider discovery FIRST so dynamically-added models (OpenRouter,
// Groq, Cerebras, Mistral) are included in the smoke test — otherwise we'd only
// validate the static chain and never catch a bad auto-discovered id.
await discoverFreeModels();

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
    // Classify pre-flight skips FIRST: callLLM now records WHY a model was
    // skipped ("skipped — exhausted", "skipped — no API key …", etc.). Before
    // this, a fully-skipped single-model chain surfaced as a blank-cause
    // "All AI models failed. … Errors: " and was bucketed into generic `error`,
    // making the run undiagnosable. Surface the skip class so the summary tells
    // us the regression is daily-quota exhaustion, not a broken adapter.
    if (/skipped — no API key/i.test(msg)) status = 'no_key';
    else if (/skipped — exhausted/i.test(msg)) status = 'skipped_exhausted';
    else if (/skipped — provider .* cooling down/i.test(msg)) status = 'cooldown';
    else if (/skipped — /i.test(msg)) status = 'skipped';
    else if (m) status = `http_${m[1]}`;
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

// Emit the JSON payload straight to the real stdout (console.log is patched to
// stderr above, so this is the ONLY thing the workflow's `> .tmp/smoke.json`
// redirect captures).
process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
