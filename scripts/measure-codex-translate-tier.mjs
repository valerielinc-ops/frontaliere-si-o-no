#!/usr/bin/env node
/**
 * Measure the Codex translation tier of scripts/lib/free-translate.mjs before
 * and after its lanes and adaptive grouping, on the same texts, against a
 * simulated Codex. No network, no broker, no model.
 *
 * BEFORE is the tier as it was, one request per text and one at a time:
 * FREE_TRANSLATE_CODEX_LANES=1 and FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS=1 (the
 * rollback lever). AFTER is the default (2 lanes, groups of up to 5). LANES
 * ONLY keeps one text per request, to show what the lanes alone give.
 *
 * The simulated Codex follows a local measure on gpt-5.6-luna at effort max
 * with the function profile (2026-09-29): one short text 7.1 s, five texts in
 * one request 36.8 s, i.e. 7.1 s plus ~7.4 s per extra text; ~5.9k input
 * tokens of fixed prompt per request, plus the request itself. Time is scaled
 * (SCALE_MS real milliseconds per simulated second), so a run takes a second.
 *
 *   node scripts/measure-codex-translate-tier.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIXED_PROMPT_TOKENS = 5900;
const FIRST_TEXT_S = 7.1;
const EXTRA_TEXT_S = 7.4;
const SCALE_MS = 3;
const IT = "Il permesso G si rinnova ogni cinque anni presso l'ufficio della migrazione del Cantone Ticino.";

export const MODES = Object.freeze({
  before: { FREE_TRANSLATE_CODEX_LANES: '1', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  lanesOnly: { FREE_TRANSLATE_CODEX_LANES: '2', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  after: { FREE_TRANSLATE_CODEX_LANES: '', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '' },
});

const text = (n, lang) => `${IT} Campo ${n} (${lang}).`;

/**
 * `concurrent: true` sends the texts together, like create-article translating
 * EN, DE and FR fields at once; `false` awaits each text before the next.
 */
export const SCENARIOS = Object.freeze([
  { id: 'article-10-fields-x-3-languages', concurrent: true, texts: ['en', 'de', 'fr'].flatMap((lang) => Array.from({ length: 10 }, (_, n) => ({ text: text(n, lang), targetLang: lang }))) },
  { id: 'faq-8-texts', concurrent: true, texts: Array.from({ length: 8 }, (_, n) => ({ text: text(n, 'en'), targetLang: 'en' })) },
  { id: 'one-text-at-a-time-10', concurrent: false, texts: Array.from({ length: 10 }, (_, n) => ({ text: text(n, 'en'), targetLang: 'en' })) },
]);

async function loadTier() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-measure-'));
  const socket = path.join(tmp, 'broker.sock');
  fs.writeFileSync(socket, '');
  for (const key of ['DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY_2', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN',
    'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL', 'MT_LOCAL_OPUSMT', 'ENABLE_CODEX_ARTICLE_FALLBACK',
    'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN', 'FREE_TRANSLATE_CODEX_MAX_MS', 'FREE_TRANSLATE_CODEX_TIER']) process.env[key] = '';
  process.env.DEEPL_API_KEY = 'deepl-finta';
  process.env.AZURE_TRANSLATOR_KEY = 'azure-finta';
  process.env.CODEX_AUTH_BROKER_SOCKET = socket;
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '1000';
  process.env.VITEST = '1';
  // DeepL out of quota and Azure rejected: the Codex tier serves every text.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api-free.deepl.com')) return { ok: false, status: 456, json: async () => ({}), text: async () => '' };
    if (u.includes('api.cognitive.microsofttranslator.com')) return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    throw new Error('offline');
  };
  const ft = await import('./lib/free-translate.mjs');
  return { ft, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function simulatedCodex(stats) {
  return async (messages) => {
    const user = messages.find((m) => m.role === 'user').content;
    const items = user.startsWith('[') ? JSON.parse(user) : null;
    const texts = items ? items.length : 1;
    stats.requests += 1;
    stats.texts += texts;
    stats.inputTokens += FIXED_PROMPT_TOKENS + Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    await new Promise((resolve) => setTimeout(resolve, (FIRST_TEXT_S + EXTRA_TEXT_S * (texts - 1)) * SCALE_MS));
    if (items) return JSON.stringify({ items: items.map(({ id, text: t }) => ({ id, text: `EN ${t}` })) });
    const framed = /^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user);
    return `EN ${framed ? framed[1] : user}`;
  };
}

async function runScenario(ft, scenario, mode) {
  for (const [key, value] of Object.entries(MODES[mode])) process.env[key] = value;
  const stats = { requests: 0, texts: 0, inputTokens: 0 };
  ft.setCodexTranslateCallForTests(simulatedCodex(stats));
  const translate = ({ text: t, targetLang }) => ft.freeTranslate({ text: t, sourceLang: 'it', targetLang, fieldType: 'description' });
  const quiet = console.log;
  console.log = () => {};
  const t0 = Date.now();
  let out;
  try {
    if (scenario.concurrent) {
      out = await Promise.all(scenario.texts.map(translate));
    } else {
      out = [];
      for (const item of scenario.texts) out.push(await translate(item));
    }
  } finally {
    console.log = quiet;
  }
  const translated = out.filter((value, i) => value === `EN ${normalize(scenario.texts[i].text)}`).length;
  return {
    requests: stats.requests,
    simulatedSeconds: Math.round((Date.now() - t0) / SCALE_MS),
    inputTokens: stats.inputTokens,
    translated,
  };
}

const normalize = (value) => value.replace(/\s+/g, ' ').trim();

export async function measureCodexTranslateTier() {
  const { ft, cleanup } = await loadTier();
  try {
    // Warm-up: the first text marks DeepL and Azure exhausted for the process.
    ft.setCodexTranslateCallForTests(async () => 'EN warm-up');
    const quiet = console.log;
    console.log = () => {};
    try { await ft.freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' }); } finally { console.log = quiet; }
    const results = [];
    for (const scenario of SCENARIOS) {
      const row = { scenario: scenario.id, texts: scenario.texts.length };
      for (const mode of Object.keys(MODES)) row[mode] = await runScenario(ft, scenario, mode);
      results.push(row);
    }
    return results;
  } finally {
    ft.setCodexTranslateCallForTests(null);
    for (const key of Object.keys(MODES.after)) process.env[key] = '';
    cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await measureCodexTranslateTier();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('| scenario | texts | BEFORE: requests, s, input tokens | LANES ONLY: requests, s, input tokens | AFTER: requests, s, input tokens |');
    console.log('|---|---|---|---|---|');
    for (const r of results) {
      const cell = (m) => `${m.requests}, ${m.simulatedSeconds}, ${m.inputTokens}`;
      console.log(`| ${r.scenario} | ${r.texts} | ${cell(r.before)} | ${cell(r.lanesOnly)} | ${cell(r.after)} |`);
    }
  }
  process.exit(0);
}
