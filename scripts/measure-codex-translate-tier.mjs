#!/usr/bin/env node
/**
 * Measure the Codex translation tier of scripts/lib/free-translate.mjs before
 * and after its lanes and adaptive grouping. The default scenarios use a
 * simulated Codex; --real invokes the local Codex CLI with the broker's
 * function profile and measures the requested translate-pending modes.
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
 *   node scripts/measure-codex-translate-tier.mjs --real --input <json|-> [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const FIXED_PROMPT_TOKENS = 5900;
const FIRST_TEXT_S = 7.1;
const EXTRA_TEXT_S = 7.4;
const SCALE_MS = 3;
const IT = "Il permesso G si rinnova ogni cinque anni presso l'ufficio della migrazione del Cantone Ticino.";
const REAL_CODEX_MODEL = 'gpt-5.6-luna';
const REAL_CODEX_EFFORT = 'max';
const FUNCTION_PROFILE_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'multi_agent', 'image_generation', 'browser_use',
  'computer_use', 'apps', 'plugins', 'view_image', 'goals', 'sleep_tool',
  'tool_suggest', 'skill_search',
]);

export const MODES = Object.freeze({
  before: { FREE_TRANSLATE_CODEX_LANES: '1', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  lanesOnly: { FREE_TRANSLATE_CODEX_LANES: '2', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  after: { FREE_TRANSLATE_CODEX_LANES: '', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '' },
});

/** Configurazioni richieste per la misura reale della riserva translate-pending. */
export const REAL_MODES = Object.freeze({
  oneLaneOneText: { FREE_TRANSLATE_CODEX_LANES: '1', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  twoLanes: { FREE_TRANSLATE_CODEX_LANES: '2', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  threeLanes: { FREE_TRANSLATE_CODEX_LANES: '3', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '1' },
  threeLanesBatch5: { FREE_TRANSLATE_CODEX_LANES: '3', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '5' },
  threeLanesBatch10: { FREE_TRANSLATE_CODEX_LANES: '3', FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS: '10' },
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

async function loadTier({ real = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-measure-'));
  const socket = path.join(tmp, 'broker.sock');
  fs.writeFileSync(socket, '');
  for (const key of ['DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY_2', 'GOOGLE_APPLICATION_CREDENTIALS', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN',
    'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL', 'MT_LOCAL_OPUSMT', 'ENABLE_CODEX_ARTICLE_FALLBACK',
    'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN', 'FREE_TRANSLATE_CODEX_MAX_MS', 'FREE_TRANSLATE_CODEX_TIER']) process.env[key] = '';
  process.env.DEEPL_API_KEY = 'deepl-finta';
  process.env.AZURE_TRANSLATOR_KEY = 'azure-finta';
  process.env.CODEX_AUTH_BROKER_SOCKET = socket;
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '1000';
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = real ? '7200000' : '';
  process.env.FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS = real ? '480000' : '';
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
    stats.requestSizes.push(texts);
    stats.inputTokens += FIXED_PROMPT_TOKENS + Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    await new Promise((resolve) => setTimeout(resolve, (FIRST_TEXT_S + EXTRA_TEXT_S * (texts - 1)) * SCALE_MS));
    if (items) return JSON.stringify({ items: items.map(({ id, text: t }) => ({ id, text: `EN ${t}` })) });
    const framed = /^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user);
    return `EN ${framed ? framed[1] : user}`;
  };
}

function promptFromMessages(messages, jsonOnly = false) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  const prompt = [system ? `System instructions:\n${system}` : '', user].filter(Boolean).join('\n\n');
  return jsonOnly
    ? `${prompt}\n\nReturn exactly one valid JSON object and no Markdown fences or commentary.`
    : prompt;
}

function requestTextCount(messages) {
  const user = messages.find((m) => m.role === 'user')?.content || '';
  if (!user.startsWith('[')) return 1;
  try {
    const parsed = JSON.parse(user);
    return Array.isArray(parsed) ? parsed.length : 1;
  } catch {
    return 1;
  }
}

/**
 * Invoca la CLI Codex locale con lo stesso profilo function usato dal broker
 * CI. Il callback sostituisce solo il trasporto, lasciando a free-translate
 * corsie, grouping, schema e gate di qualità.
 */
function realCodex(stats) {
  return async (messages, opts = {}) => {
    const batchSize = requestTextCount(messages);
    stats.requests += 1;
    stats.texts += batchSize;
    stats.requestSizes.push(batchSize);
    const startedAt = Date.now();
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-real-'));
    const workspace = path.join(runtimeRoot, 'workspace');
    const outputPath = path.join(runtimeRoot, 'last-message.txt');
    const instructionsPath = path.join(runtimeRoot, 'function-instructions.md');
    const schema = opts.jsonSchema?.schema || null;
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(instructionsPath,
      'You are a stateless text-processing function called by a batch job. Read the request, produce the requested output directly, and never use tools, run commands or ask questions.\n',
      { mode: 0o600 });

    const args = [
      'exec', '--ephemeral', '--strict-config', '--ignore-rules',
      '--cd', workspace, '--skip-git-repo-check',
      '--model', REAL_CODEX_MODEL,
      '-c', `model_reasoning_effort=${REAL_CODEX_EFFORT}`,
      '-c', 'shell_environment_policy.ignore_default_excludes=false',
      '-c', 'shell_environment_policy.inherit=none',
      '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
      '--output-last-message', outputPath,
      '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`,
      '-c', 'include_permissions_instructions=false',
      '-c', 'include_environment_context=false',
      '-c', 'web_search="disabled"',
      ...FUNCTION_PROFILE_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ];
    if (schema) {
      const schemaPath = path.join(runtimeRoot, 'output-schema.json');
      fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      args.push('--output-schema', schemaPath);
    }
    args.push('-');

    const env = {
      PATH: process.env.PATH || path.dirname(process.execPath),
      CODEX_HOME: process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex'),
      TMPDIR: path.join(runtimeRoot, 'tmp'),
    };
    fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
    for (const key of ['HOME', 'LANG', 'LC_ALL', 'TERM']) {
      if (process.env[key]) env[key] = process.env[key];
    }

    const configuredTimeout = Number(process.env.FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS) || 480000;
    const remaining = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) - Date.now() : Infinity;
    const timeoutMs = Math.max(1, Math.min(configuredTimeout, remaining));
    const prompt = promptFromMessages(messages, !!opts.jsonMode || !!schema);

    try {
      return await new Promise((resolve, reject) => {
        let stderr = '';
        let settled = false;
        let timer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stats.requestSeconds.push(Number(((Date.now() - startedAt) / 1000).toFixed(1)));
          if (error) reject(error);
          else resolve(value);
        };
        let child;
        try {
          child = spawn(process.env.CODEX_BIN || 'codex', args, {
            cwd: workspace,
            env,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } catch (error) {
          finish(error);
          return;
        }
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        child.once('error', (error) => finish(error));
        child.once('close', (code) => {
          if (code !== 0) {
            finish(new Error(`codex exec exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
            return;
          }
          try {
            const result = fs.readFileSync(outputPath, 'utf8').trim();
            if (!result) throw new Error('codex exec returned an empty last message');
            if (/\b(?:sorry|cannot|can't|unable|refuse|refused)\b/i.test(result)) stats.refusals += 1;
            finish(null, result);
          } catch (error) {
            finish(error);
          }
        });
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`codex exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdin.end(prompt);
      });
    } catch (error) {
      stats.errors += 1;
      throw error;
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  };
}

function readMeasureTexts(inputPath) {
  const raw = inputPath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const values = Array.isArray(parsed) ? parsed : parsed?.texts;
  if (!Array.isArray(values) || values.length === 0) throw new Error('input must be a non-empty JSON array of translation texts');
  return values.map((item, index) => {
    const value = typeof item === 'string' ? { text: item } : item;
    if (!value || typeof value.text !== 'string' || !value.text.trim()) throw new Error(`input item ${index + 1} has no text`);
    return {
      text: value.text,
      sourceLang: value.sourceLang || 'it',
      targetLang: value.targetLang || 'en',
      fieldType: value.fieldType || 'description',
    };
  });
}

function isEcho(value, source) {
  return normalize(value).toLowerCase() === normalize(source).toLowerCase();
}

async function runScenario(ft, scenario, mode, { real = false, modes = real ? REAL_MODES : MODES } = {}) {
  const modeSet = modes;
  for (const [key, value] of Object.entries(modeSet[mode])) process.env[key] = value;
  const stats = { requests: 0, texts: 0, inputTokens: 0, requestSeconds: [], requestSizes: [], refusals: 0, errors: 0 };
  ft.setCodexTranslateCallForTests(real ? realCodex(stats) : simulatedCodex(stats));
  const translate = ({ text: t, sourceLang = 'it', targetLang = 'en', fieldType = 'description' }) =>
    ft.freeTranslate({ text: t, sourceLang, targetLang, fieldType });
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
  const translated = out.filter((value, i) => value && !isEcho(value, scenario.texts[i].text)).length;
  const echoes = out.filter((value, i) => value && isEcho(value, scenario.texts[i].text)).length;
  const elapsedSeconds = (Date.now() - t0) / 1000;
  return {
    requests: stats.requests,
    requestSizes: stats.requestSizes,
    requestSeconds: stats.requestSeconds,
    simulatedSeconds: Math.round((Date.now() - t0) / SCALE_MS),
    wallSeconds: Number(elapsedSeconds.toFixed(1)),
    textsTranslated: translated,
    textsPerMinute: Number((translated / Math.max(elapsedSeconds / 60, 0.001)).toFixed(2)),
    echoes,
    refusals: stats.refusals,
    rejected: scenario.texts.length - translated,
    qualityOk: echoes === 0 && stats.refusals === 0 && translated === scenario.texts.length,
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

export async function measureRealCodexTranslateTier(texts, { real = true, modes = REAL_MODES } = {}) {
  const { ft, cleanup } = await loadTier({ real });
  try {
    // Warm-up only the premium-provider stubs; it must not spend a real Codex call.
    ft.setCodexTranslateCallForTests(async () => 'EN warm-up');
    const quiet = console.log;
    console.log = () => {};
    try { await ft.freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' }); } finally { console.log = quiet; }
    const scenario = { id: 'real-ad-slice', concurrent: true, texts };
    const rows = [];
    for (const mode of Object.keys(modes)) rows.push({ mode, ...(await runScenario(ft, scenario, mode, { real, modes })) });
    return {
      measuredAt: new Date().toISOString(),
      transport: real ? 'codex-cli' : 'simulated',
      model: REAL_CODEX_MODEL,
      effort: REAL_CODEX_EFFORT,
      texts: texts.length,
      rows,
    };
  } finally {
    ft.setCodexTranslateCallForTests(null);
    for (const key of Object.keys(REAL_MODES.oneLaneOneText)) process.env[key] = '';
    cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const real = process.argv.includes('--real');
  if (real) {
    const inputIndex = process.argv.indexOf('--input');
    const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : '';
    if (!inputPath) throw new Error('--real requires --input <json-file|->');
    const results = await measureRealCodexTranslateTier(readMeasureTexts(inputPath), { real: !process.argv.includes('--simulate') });
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('| configurazione | testi | secondi totali | tradotti | testi/min | richieste | testi per richiesta | secondi per richiesta | qualità |');
      console.log('|---|---:|---:|---:|---:|---:|---|---|---|');
      for (const r of results.rows) {
        const quality = `${r.qualityOk ? 'OK' : 'FAIL'} (${r.echoes} eco, ${r.refusals} rifiuti, ${r.rejected} rifiutati)`;
        console.log(`| ${r.mode} | ${results.texts} | ${r.wallSeconds} | ${r.textsTranslated} | ${r.textsPerMinute} | ${r.requests} | ${r.requestSizes.join(', ')} | ${r.requestSeconds.join(', ')} | ${quality} |`);
      }
    }
  } else {
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
  }
  process.exit(0);
}
