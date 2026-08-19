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
      // recordScore:false — this is a diagnostic ping, not production usage;
      // its pass/fail must not write to ai_model_scores/_all (see #6065).
      { temperature: 0, maxTokens: 8, chain: [model], retries: 0, recordScore: false }
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

// Mistral `-latest` regression gate (issue #892). The discovery alias pass
// (collectOfferedIds in lib/ai-models.mjs) keeps Mistral `-latest` chain
// entries from being pre-exhausted by reading the provider listing's
// `aliases[]` array. If that field name ever drifts, the alias pass becomes a
// silent no-op and every `-latest` entry gets marked stale for the whole UTC
// day — a degradation no other signal here catches while the rest of the chain
// still passes. So: if the Mistral key is present (the `-latest` chain was
// actually exercised) and EVERY attempted Mistral `-latest` model failed, fail
// the run so the regression surfaces in CI instead of silently shortening the
// chain. No-op without the key (nothing attempted) and emits nothing to stdout
// (still the JSON-only contract). Bare `MISTRAL_API_KEY` check mirrors
// getMistralApiKey() in lib/ai-models.mjs.
const hasMistralKey = Boolean((process.env.MISTRAL_API_KEY || '').trim());
const mistralLatest = results.filter(
  r => r.model.startsWith('mistral/') && /-latest$/.test(r.model),
);
// Pre-flight SKIP statuses are NOT request attempts: the model was never pinged
// because callLLM short-circuited (daily-quota exhausted, provider cooling down,
// missing key, or otherwise skipped). The #892 regression this gate exists to
// catch — the discovery alias pass (aliases[] field) silently no-op'ing so every
// `-latest` entry gets PRE-EXHAUSTED — itself surfaces as `skipped_exhausted`,
// which is indistinguishable here from the benign case where production runs
// simply burned the shared Mistral daily quota earlier in the UTC day. Treating
// `skipped_exhausted` as a "failure" made the gate fire on pure quota exhaustion
// (run 27198839248: all 6 `-latest` skipped_exhausted → false exitCode 1, the
// recurring #1357 failure). Skips are not evidence of an alias regression, so a
// run where the `-latest` chain was never actually exercised must be a no-op.
const SKIP_STATUSES = new Set(['skipped_exhausted', 'cooldown', 'no_key', 'skipped']);
const mistralLatestAttempted = mistralLatest.filter(r => !SKIP_STATUSES.has(r.status));
// The gate's purpose (#892) is to catch a discovery-alias REGRESSION (aliases[]
// field drift). A dead/revoked Mistral API key surfaces as http_401/http_403 on
// EVERY model and is an ENVIRONMENT problem (rotate the key in Remote Config),
// not the code regression this gate exists to detect. Firing on pure auth
// failures opens a "Workflow Failure" issue implying a code bug and burns triage
// quota chasing a secret rotation (issue #1276). So: only trip the regression
// gate when ALL ATTEMPTED `-latest` failures are real (non-auth, non-transient)
// request errors. Transient infrastructure errors (5xx, timeout, net) are not
// evidence of an alias regression — a single 500/timeout on the one model that
// passed the pre-flight would otherwise reproduce the false-positive CI cycle
// the gate was meant to prevent (issue #1645).
const mistralAuthFailures = mistralLatestAttempted.filter(r => r.status === 'http_401' || r.status === 'http_403');
const mistralTransientFailures = mistralLatestAttempted.filter(
  r => r.status === 'timeout' || r.status === 'net' || /^http_5\d\d$/.test(r.status),
);
// HTTP 402 (Payment Required) is Mistral's response for a lapsed/suspended
// subscription — same ENVIRONMENT-problem class as a dead key (401/403), not
// evidence of an alias regression: the discovery alias pass never gets far
// enough to matter when the account itself is rejected. Without this branch
// every model in the chain returns 402 with an identical detail message
// ("Check your subscription on https://admin.mistral.ai/subscription") and
// falls through to the final else-if, misfiring the #892 regression gate on a
// billing issue instead of a code bug (observed run 31087900465 / issue #5245).
const mistralPaymentFailures = mistralLatestAttempted.filter(r => r.status === 'http_402');
const allAttemptedFailed = mistralLatestAttempted.length > 0 && mistralLatestAttempted.every(r => r.status !== 'pass');
const allFailuresAreAuth = mistralLatestAttempted.length > 0 && mistralAuthFailures.length === mistralLatestAttempted.length;
const allFailuresAreTransient = mistralLatestAttempted.length > 0 && mistralTransientFailures.length === mistralLatestAttempted.length;
const allFailuresArePayment = mistralLatestAttempted.length > 0 && mistralPaymentFailures.length === mistralLatestAttempted.length;
if (hasMistralKey && mistralLatest.length > 0 && mistralLatestAttempted.length === 0) {
  // Every `-latest` model was pre-flight skipped (shared daily quota exhausted by
  // earlier production runs, provider cooldown, etc.). The alias chain was never
  // exercised this run, so there is NO regression signal either way — do not fail.
  console.error(
    `\nℹ️  Mistral -latest: all ${mistralLatest.length} model(s) were pre-flight ` +
      `skipped (quota exhausted / cooldown) and never attempted. No alias-regression ` +
      `signal this run (see #892/#1357); not failing the smoke run.`,
  );
} else if (hasMistralKey && allAttemptedFailed && allFailuresAreAuth) {
  // Dead key, not an alias regression. Surface clearly but do NOT fail the run
  // (no code fix would help; the key must be rotated in Remote Config).
  console.error(
    `\n⚠️  Mistral -latest: all ${mistralLatestAttempted.length} attempted -latest ` +
      `model(s) failed with auth errors (401/403). MISTRAL_API_KEY is likely revoked — ` +
      `rotate it in Firebase Remote Config. NOT an alias regression (see #892/#1276); ` +
      `not failing the smoke run.`,
  );
} else if (hasMistralKey && allAttemptedFailed && allFailuresAreTransient) {
  // Transient infrastructure failure (5xx, timeout, network). Not an alias-regression
  // signal — the discovery alias pass cannot be evaluated when the provider is
  // temporarily unreachable. Surface as a warning but do NOT fail (#1645).
  console.error(
    `\n⚠️  Mistral -latest: all ${mistralLatestAttempted.length} attempted ` +
      `-latest model(s) failed with transient infrastructure errors (5xx/timeout/net). ` +
      `Not an alias-regression signal (see #892/#1645); not failing the smoke run. ` +
      `If this recurs, check the Mistral API status.`,
  );
} else if (hasMistralKey && allAttemptedFailed && allFailuresArePayment) {
  // Lapsed/suspended subscription, not an alias regression. Surface clearly but
  // do NOT fail the run (no code fix would help; the subscription must be
  // renewed at https://admin.mistral.ai/subscription).
  console.error(
    `\n⚠️  Mistral -latest: all ${mistralLatestAttempted.length} attempted -latest ` +
      `model(s) failed with HTTP 402 (Payment Required). The Mistral subscription is ` +
      `likely lapsed — check https://admin.mistral.ai/subscription. NOT an alias ` +
      `regression (see #892); not failing the smoke run.`,
  );
} else if (hasMistralKey && allAttemptedFailed) {
  console.error(
    `\n❌ Mistral -latest regression: all ${mistralLatestAttempted.length} attempted ` +
      `-latest model(s) failed (non-auth, non-transient). Likely the discovery alias pass ` +
      `(aliases[] field in lib/ai-models.mjs) is a no-op — see issue #892.`,
  );
  process.exitCode = 1;
}

// Emit the JSON payload straight to the real stdout (console.log is patched to
// stderr above, so this is the ONLY thing the workflow's `> .tmp/smoke.json`
// redirect captures).
process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
