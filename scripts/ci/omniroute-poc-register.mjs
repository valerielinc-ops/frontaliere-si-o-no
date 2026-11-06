#!/usr/bin/env node
// Registers provider connections into a locally running OmniRoute instance
// (POC only — see .github/workflows/omniroute-poc.yml). When
// OMNIROUTE_PROVIDERS_JSON is set (see scripts/sync-omniroute-providers-rc.mjs
// / scripts/load-rc-env.mjs), registers that full decrypted provider set;
// otherwise falls back to a small curated list. The fallback list includes
// one intentionally-dead key (mistral) to prove OmniRoute's auto fallback
// skips it and still serves the completion via a live provider.

import { resolveOmniRouteAllowlist } from '../lib/omniroute-free-providers.mjs';

const OMNIROUTE_URL = 'http://localhost:20128';

// Tuple shape: [provider, name, envNames|null, presetApiKey|null] — envNames
// resolves the key from process.env (curated fallback), presetApiKey is
// already-decrypted (OMNIROUTE_PROVIDERS_JSON path).
const providersFromJson = (() => {
  const raw = process.env.OMNIROUTE_PROVIDERS_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.map((p) => [p.provider, p.name || p.provider, null, p.apiKey]);
  } catch (e) {
    console.error('⚠️  OMNIROUTE_PROVIDERS_JSON present but invalid, falling back to curated POC list:', e.message);
    return null;
  }
})();

// ── Free-only allowlist ──────────────────────────────────────
// OMNIROUTE_PROVIDERS_JSON carries EVERY apikey connection decrypted from the
// dev machine's OmniRoute install (77 active on 2026-07-29), pay-per-token
// accounts included. Registering the lot had two costs, both measured:
//   1. MONEY RISK — a paid connection is one auto-routing decision away from
//      billing a real account. The project's standing constraint is $0.
//   2. FAILURES — run 30427526187 (send-newsletter): omniroute/auto 97 calls,
//      0 successes, incl. HTTP 400 "Invalid model name passed in
//      model=claude-fable-5".
// The list itself + the override contract live in the shared module, because
// scripts/sync-omniroute-providers-rc.mjs applies the same filter upstream and
// a second copy would drift (AGENTS.md #6).
const { allowlist, filteringOff, malformed } = resolveOmniRouteAllowlist(process.env.OMNIROUTE_PROVIDER_ALLOWLIST);
if (malformed) {
  console.warn(`⚠️  OMNIROUTE_PROVIDER_ALLOWLIST="${process.env.OMNIROUTE_PROVIDER_ALLOWLIST}" has separators but no provider names — treating as misconfigured and keeping the built-in free list (use "" to disable filtering).`);
}

// Small curated set, all free-tier, resolved from env keys already present in
// CI. Used when OMNIROUTE_PROVIDERS_JSON is absent, and as the safety net below
// when the allowlist admits nothing from the JSON payload.
const CURATED_FALLBACK = [
  ['groq', 'Groq (CI POC)', ['GROQ_API_KEY'], null],
  ['openrouter', 'OpenRouter (CI POC)', ['OPENROUTER_API_KEY'], null],
  ['gemini', 'Gemini (CI POC)', ['GEMINI_API_KEY'], null],
  ['mistral', 'Mistral (CI POC, expected dead)', ['MISTRAL_API_KEY'], null],
];

const PROVIDERS_RAW = providersFromJson || CURATED_FALLBACK;

const excluded = [];
const PROVIDERS = filteringOff
  ? PROVIDERS_RAW
  : PROVIDERS_RAW.filter(([provider]) => {
    if (allowlist.has(provider)) return true;
    excluded.push(provider);
    return false;
  });

if (providersFromJson) console.log(`ℹ️  Using OMNIROUTE_PROVIDERS_JSON — ${PROVIDERS_RAW.length} provider connection(s) offered.`);
if (filteringOff) {
  console.log('⚠️  OMNIROUTE_PROVIDER_ALLOWLIST="" — free-only filtering DISABLED, registering every provider (paid accounts included).');
} else {
  console.log(`🆓 Free-only allowlist: ${PROVIDERS.length} kept, ${excluded.length} excluded (paid / non-chat / CLI-bound).`);
  if (excluded.length) console.log(`   excluded: ${[...new Set(excluded)].sort().join(', ')}`);
}

// Safety net: the JSON blob in Remote Config is published by a separate,
// manually-run script, so a future edit there could in principle leave nothing
// that the allowlist admits. Without this, PROVIDERS would be empty, no
// registration would succeed, and the exit(1) at the bottom would fail the
// whole job — in ~32 workflows, none of which set continue-on-error on this
// step. Falling back to the small curated list (all free-tier, resolved from
// env keys already present in CI) keeps OmniRoute degraded-but-alive instead
// of taking the pipeline down. Not a live risk today — the current RC payload
// is 19 providers, all 19 of which pass the filter — but the failure mode is
// invisible until it fires, so it is worth a guard rather than a comment.
if (!filteringOff && PROVIDERS.length === 0 && PROVIDERS_RAW.length > 0) {
  console.warn(
    `⚠️  Allowlist excluded ALL ${PROVIDERS_RAW.length} offered connection(s) — provider names likely changed upstream. ` +
    'Falling back to the curated free-tier list so this step does not take the job down. ' +
    'Fix OMNIROUTE_FREE_PROVIDERS (scripts/lib/omniroute-free-providers.mjs) or OMNIROUTE_PROVIDER_ALLOWLIST in Remote Config.'
  );
  PROVIDERS.push(...CURATED_FALLBACK.filter(([provider]) => allowlist.has(provider)));
}

// A fresh OmniRoute boot (always the case in CI — new sqlite db each run) sets
// requireLogin:true and needs a session cookie for /api/* management routes
// even when INITIAL_PASSWORD is left unset (falls back to an internal default).
// /v1/chat/completions is unaffected — it stays open with no auth.
let cookie = '';
const password = process.env.OMNIROUTE_INITIAL_PASSWORD;
if (password) {
  const loginRes = await fetch(`${OMNIROUTE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.status, await loginRes.text().catch(() => ''));
    process.exit(1);
  }
  const setCookie = loginRes.headers.get('set-cookie');
  cookie = setCookie ? setCookie.split(';')[0] : '';
}

const skipped = [];
const results = [];

for (const [provider, name, envNames, presetApiKey] of PROVIDERS) {
  const apiKey = presetApiKey || envNames?.map((n) => process.env[n]).find((v) => v && v.trim());
  if (!apiKey) {
    skipped.push(provider);
    continue;
  }

  const res = await fetch(`${OMNIROUTE_URL}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ provider, name, apiKey: apiKey.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  results.push(
    res.ok
      ? `  OK   ${provider.padEnd(12)} id=${data.connection?.id || '?'}`
      : `  FAIL ${provider.padEnd(12)} HTTP ${res.status} ${JSON.stringify(data)}`
  );
}

if (skipped.length) console.log('Skipped (no key in env):', skipped.join(', '));
console.log(results.join('\n'));

if (!results.some((line) => line.startsWith('  OK'))) {
  // Name the allowlist explicitly when it is what emptied the list: this step
  // failing hard takes ~32 workflows down with it, so the log must say which
  // knob to turn instead of leaving "POC cannot proceed" as the only clue.
  if (!filteringOff && PROVIDERS.length === 0 && PROVIDERS_RAW.length > 0) {
    console.error(
      `No provider registered: the free-only allowlist excluded all ${PROVIDERS_RAW.length} offered connection(s). ` +
      'Provider names may have changed upstream. Widen FREE_PROVIDERS in this file, ' +
      'or set OMNIROUTE_PROVIDER_ALLOWLIST (CSV) — or "" to disable filtering — in Remote Config.'
    );
    process.exit(1);
  }
  console.error('No provider registered successfully — POC cannot proceed.');
  process.exit(1);
}
