#!/usr/bin/env node
/**
 * backfill-ai-search-optimization.mjs — Retrofit existing blog articles
 * with AI Search optimization signals (TL;DR + Fatti chiave) so that the
 * Semrush "AI Search optimization" check stops flagging them as having
 * "1 errore" (issue 223 — A6, 496 affected articles).
 *
 * What it does:
 *   1. Iterates over every IT article body file in
 *      services/locales/blog-body/it/*.ts
 *   2. Skips files that already contain AI-search markers
 *      (## In breve + ## Fatti chiave) detected via hasAiSearchOptimization()
 *   3. For each remaining article, calls the centralized AI client
 *      (scripts/lib/ai-models.mjs) to extract TL;DR + key facts grounded
 *      in the article body — no fabricated facts.
 *   4. Prepends the resulting markdown block to body1 (and to en/de/fr
 *      body1 once translated, when --translate is passed).
 *
 * USAGE
 *   node scripts/backfill-ai-search-optimization.mjs            # DRY-RUN (default)
 *   node scripts/backfill-ai-search-optimization.mjs --apply    # actually write
 *   node scripts/backfill-ai-search-optimization.mjs --limit 20 # first 20 only
 *   node scripts/backfill-ai-search-optimization.mjs --help
 *
 * DRY-RUN OUTPUT
 *   - Total articles scanned
 *   - Articles already optimized (skipped)
 *   - Articles that need backfill
 *   - One sample diff (first non-optimized file)
 *
 * ENVIRONMENT
 *   GH_MODELS_PAT (or other provider keys — see scripts/lib/ai-models.mjs)
 *   Required only when --apply is set.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hasAiSearchOptimization,
  buildAiSearchMarkdown,
  buildBackfillPrompt,
  validateBackfillPayload,
} from './lib/ai-search-template.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BODY_DIR_IT = path.join(ROOT, 'services', 'locales', 'blog-body', 'it');

// ── CLI parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
const HELP = args.includes('--help') || args.includes('-h');
const APPLY = args.includes('--apply');
const LIMIT_RAW = getArg('--limit');
const LIMIT = LIMIT_RAW ? parseInt(LIMIT_RAW, 10) : Infinity;
const SAMPLE = args.includes('--show-sample');

if (HELP) {
  console.log(`backfill-ai-search-optimization.mjs

  --apply         Write changes to disk (default: DRY-RUN)
  --limit N       Process at most N articles
  --show-sample   Print the AI-generated block for the first article
  --help, -h      Show this help

  Required env (only with --apply): GH_MODELS_PAT or other AI provider key.
`);
  process.exit(0);
}

// ── File parsing helpers ────────────────────────────────────────────────

const BODY_KEY_RX = /'blog\.article\.([^']+)\.(body\d+|faq)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

/** Unescape a single-quoted TS string the same way ogPagesPlugin does. */
function unescapeTsString(value) {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\');
}

/** Re-escape a string for embedding in a single-quoted TS literal. */
function escapeForSingleQuoteTS(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Reads a body file and returns { articleId, body1, body2, body3, faq, raw }.
 * Returns null if the file does not contain a recognizable body1 entry.
 */
export function parseBodyFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const fields = {};
  let articleId = null;
  let m;
  BODY_KEY_RX.lastIndex = 0;
  while ((m = BODY_KEY_RX.exec(raw)) !== null) {
    articleId = m[1];
    fields[m[2]] = unescapeTsString(m[3]);
  }
  if (!articleId || !fields.body1) return null;
  return { filePath, articleId, raw, ...fields };
}

/**
 * Lists all IT body files. Exposed for test reuse.
 */
export function listItBodyFiles(dir = BODY_DIR_IT) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
}

/**
 * Returns the list of body files that DO NOT yet have AI-search optimization.
 */
export function findArticlesNeedingBackfill(files) {
  const needing = [];
  const skipped = [];
  for (const filePath of files) {
    const parsed = parseBodyFile(filePath);
    if (!parsed) {
      skipped.push({ filePath, reason: 'unparseable' });
      continue;
    }
    if (hasAiSearchOptimization(parsed.body1)) {
      skipped.push({ filePath, reason: 'already-optimized' });
      continue;
    }
    needing.push(parsed);
  }
  return { needing, skipped };
}

/**
 * Replaces the body1 value in the raw TS source. Pure function, no I/O.
 */
export function replaceBody1(raw, articleId, newBody1) {
  const escaped = escapeForSingleQuoteTS(newBody1);
  const rx = new RegExp(
    `('blog\\.article\\.${articleId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.body1'\\s*:\\s*')((?:[^'\\\\]|\\\\.)*)(')`,
  );
  if (!rx.test(raw)) {
    throw new Error(`replaceBody1: body1 anchor not found for ${articleId}`);
  }
  return raw.replace(rx, `$1${escaped}$3`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const files = listItBodyFiles();
  console.log(`Scanning ${files.length} IT body files in ${path.relative(ROOT, BODY_DIR_IT)}/`);

  const { needing, skipped } = findArticlesNeedingBackfill(files);
  const alreadyOptimized = skipped.filter((s) => s.reason === 'already-optimized').length;

  console.log(`\nResults:`);
  console.log(`  • Total IT articles:        ${files.length}`);
  console.log(`  • Already AI-optimized:     ${alreadyOptimized}`);
  console.log(`  • Need backfill:            ${needing.length}`);
  if (skipped.some((s) => s.reason === 'unparseable')) {
    console.log(`  • Unparseable (skipped):    ${skipped.filter((s) => s.reason === 'unparseable').length}`);
  }

  if (needing.length > 0) {
    const sample = needing[0];
    console.log(`\nSample article needing backfill: ${path.relative(ROOT, sample.filePath)}`);
    console.log(`  body1 first 200 chars: ${sample.body1.slice(0, 200).replace(/\n/g, ' ⏎ ')}…`);
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN: pass --apply to write changes (requires AI provider key).`);
    process.exit(0);
  }

  // ── --apply mode: actually generate + write ───────────────────────────
  const hasKey = Boolean(
    process.env.GH_MODELS_PAT
      || process.env.GEMINI_API_KEY
      || process.env.OPENAI_API_KEY
      || process.env.GROQ_API_KEY
      || process.env.OPENROUTER_API_KEY,
  );
  if (!hasKey) {
    console.error(`\nERROR: --apply requires an AI provider API key in env.`);
    console.error(`Set one of: GH_MODELS_PAT, GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY.`);
    process.exit(1);
  }

  // Lazy-import to keep DRY-RUN free of network/lib dependencies
  const { callLLM, AI_MODELS } = await import('./lib/ai-models.mjs');
  const targets = needing.slice(0, LIMIT);

  let written = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const fullBody = [t.body1, t.body2, t.body3].filter(Boolean).join('\n\n');
    const titleGuess = t.articleId.replace(/-/g, ' ');
    const prompt = buildBackfillPrompt({ title: titleGuess, fullBody, locale: 'it' });
    process.stdout.write(`[${i + 1}/${targets.length}] ${t.articleId}… `);
    try {
      const raw = await callLLM(
        [
          { role: 'system', content: 'Sei un editor SEO esperto. Rispondi SOLO con JSON valido, senza markdown.' },
          { role: 'user', content: prompt },
        ],
        { model: AI_MODELS.GPT4O_MINI, temperature: 0.3, maxTokens: 1500, jsonMode: true },
      );
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
      const valid = validateBackfillPayload(parsed);
      const block = buildAiSearchMarkdown({ tldr: valid.tldr, keyFacts: valid.keyFacts, locale: 'it' });
      const newBody1 = `${block}${t.body1}`;
      const newRaw = replaceBody1(t.raw, t.articleId, newBody1);
      writeFileSync(t.filePath, newRaw, 'utf-8');
      written++;
      console.log('OK');
      if (SAMPLE && i === 0) {
        console.log('\n--- SAMPLE BLOCK ---');
        console.log(block);
        console.log('--- END SAMPLE ---\n');
      }
    } catch (err) {
      failed++;
      console.log(`FAIL (${err.message})`);
    }
  }

  console.log(`\nDone: ${written} written, ${failed} failed, ${targets.length - written - failed} skipped.`);
  if (failed > 0) process.exit(1);
}

// Allow import without execution (for tests)
const isDirectRun = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === __filename; }
  catch { return false; }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
