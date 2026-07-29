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
const { allowlist, filteringOff } = resolveOmniRouteAllowlist(process.env.OMNIROUTE_PROVIDER_ALLOWLIST);

const PROVIDERS_RAW = providersFromJson || [
  ['groq', 'Groq (CI POC)', ['GROQ_API_KEY'], null],
  ['openrouter', 'OpenRouter (CI POC)', ['OPENROUTER_API_KEY'], null],
  ['gemini', 'Gemini (CI POC)', ['GEMINI_API_KEY'], null],
  ['mistral', 'Mistral (CI POC, expected dead)', ['MISTRAL_API_KEY'], null],
];

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
