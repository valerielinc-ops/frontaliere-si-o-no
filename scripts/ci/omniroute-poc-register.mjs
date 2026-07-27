#!/usr/bin/env node
// Registers a small representative set of provider connections into a locally
// running OmniRoute instance (POC only — see .github/workflows/omniroute-poc.yml).
// Includes one intentionally-dead key (mistral) to prove OmniRoute's auto
// fallback skips it and still serves the completion via a live provider.

const OMNIROUTE_URL = 'http://localhost:20128';

const PROVIDERS = [
  ['groq', 'Groq (CI POC)', ['GROQ_API_KEY']],
  ['openrouter', 'OpenRouter (CI POC)', ['OPENROUTER_API_KEY']],
  ['gemini', 'Gemini (CI POC)', ['GEMINI_API_KEY']],
  ['mistral', 'Mistral (CI POC, expected dead)', ['MISTRAL_API_KEY']],
];

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

for (const [provider, name, envNames] of PROVIDERS) {
  const apiKey = envNames.map((n) => process.env[n]).find((v) => v && v.trim());
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
  console.error('No provider registered successfully — POC cannot proceed.');
  process.exit(1);
}
