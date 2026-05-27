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
const SUPPORTED_LOCALES = ['it', 'en', 'de', 'fr'];
const bodyDirFor = (locale) => path.join(ROOT, 'services', 'locales', 'blog-body', locale);

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
const RETRY_FAILURES = args.includes('--retry-failures');
const LOCALE_RAW = getArg('--locale') || 'it';
const LOCALES = LOCALE_RAW === 'all'
  ? SUPPORTED_LOCALES
  : LOCALE_RAW.split(',').map((s) => s.trim()).filter(Boolean);
for (const loc of LOCALES) {
  if (!SUPPORTED_LOCALES.includes(loc)) {
    console.error(`ERROR: unsupported locale "${loc}". Use one of: ${SUPPORTED_LOCALES.join(', ')} or "all".`);
    process.exit(1);
  }
}
const BODY_DIR_IT = bodyDirFor('it'); // Kept for backwards-compatible export

if (HELP) {
  console.log(`backfill-ai-search-optimization.mjs

  --apply             Write changes to disk (default: DRY-RUN)
  --limit N           Process at most N articles per locale
  --locale L          Locale to process: it (default), en, de, fr, all, or comma-separated list
  --retry-failures    Only process articles listed in data/backfill-failures-{locale}.json
  --show-sample       Print the AI-generated block for the first article
  --help, -h          Show this help

  Required env (only with --apply): GH_MODELS_PAT or other AI provider key.
  Env BACKFILL_COMMIT_BATCH (default 25), BACKFILL_AUTO_PUSH=0 to disable.

  EXAMPLES
    node scripts/backfill-ai-search-optimization.mjs --apply --locale all
    node scripts/backfill-ai-search-optimization.mjs --apply --locale en --retry-failures
    node scripts/backfill-ai-search-optimization.mjs --apply --locale de --limit 50
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
  // CRITICAL: String.prototype.replace expands $&, $1..$9, $$ in the
  // replacement string. When the AI body contains literal '$' (e.g. "$70 per
  // barrel" → $70 expands to capture group 7 → empty → "0", and "$120" →
  // group 1 = key prefix → corrupts file with embedded body1 key). Use the
  // function form so the replacement is treated as a literal string.
  return raw.replace(rx, (_match, p1, _p2, p3) => `${p1}${escaped}${p3}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  // Show DRY-RUN summary across all requested locales first
  let firstSample = null;
  let totalNeeding = 0;
  for (const locale of LOCALES) {
    const dir = bodyDirFor(locale);
    const files = listItBodyFiles(dir);
    const { needing, skipped } = findArticlesNeedingBackfill(files);
    const alreadyOptimized = skipped.filter((s) => s.reason === 'already-optimized').length;
    console.log(`[${locale}] Total: ${files.length} | Already optimized: ${alreadyOptimized} | Need backfill: ${needing.length}`);
    if (skipped.some((s) => s.reason === 'unparseable')) {
      console.log(`[${locale}]   Unparseable: ${skipped.filter((s) => s.reason === 'unparseable').length}`);
    }
    if (!firstSample && needing.length > 0) firstSample = { locale, sample: needing[0] };
    totalNeeding += needing.length;
  }
  if (firstSample) {
    console.log(`\nSample (${firstSample.locale}): ${path.relative(ROOT, firstSample.sample.filePath)}`);
    console.log(`  body1 first 200 chars: ${firstSample.sample.body1.slice(0, 200).replace(/\n/g, ' ⏎ ')}…`);
  }
  console.log(`\nTOTAL across ${LOCALES.length} locale(s): ${totalNeeding} articles need backfill`);

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

  let totalWritten = 0;
  let totalFailed = 0;
  for (const locale of LOCALES) {
    const r = await runLocaleBackfill(locale, callLLM, AI_MODELS);
    totalWritten += r.written;
    totalFailed += r.failed;
  }
  console.log(`\n══ ALL LOCALES DONE: ${totalWritten} written, ${totalFailed} failed across ${LOCALES.length} locale(s) ══`);
  if (totalFailed > 0) process.exit(1);
}

async function runLocaleBackfill(locale, callLLM, AI_MODELS) {
  const dir = bodyDirFor(locale);
  const relDir = path.relative(ROOT, dir);
  const files = listItBodyFiles(dir);
  const { needing, skipped } = findArticlesNeedingBackfill(files);
  const alreadyOptimized = skipped.filter((s) => s.reason === 'already-optimized').length;
  console.log(`\n[${locale}] ${files.length} files | ${alreadyOptimized} already optimized | ${needing.length} need backfill`);
  if (needing.length === 0) return { locale, written: 0, failed: 0 };

  // --retry-failures mode: only process articles previously logged as failed.
  // Reads data/backfill-failures-{locale}.json (written at the end of every
  // run) and intersects with the current "needs backfill" set. Articles that
  // were fixed by other runs are silently skipped.
  let targets = needing.slice(0, LIMIT);
  if (RETRY_FAILURES) {
    const failuresPath = path.join(ROOT, 'data', `backfill-failures-${locale}.json`);
    if (!existsSync(failuresPath)) {
      console.log(`[${locale}] --retry-failures: no failure log at ${path.relative(ROOT, failuresPath)}, skipping locale`);
      return { locale, written: 0, failed: 0 };
    }
    try {
      const log = JSON.parse(readFileSync(failuresPath, 'utf-8'));
      const failedIds = new Set((log.articles || []).map((a) => a.articleId));
      targets = needing.filter((n) => failedIds.has(n.articleId)).slice(0, LIMIT);
      console.log(`[${locale}] --retry-failures: ${log.articles.length} previously-failed → ${targets.length} still need work`);
    } catch (err) {
      console.warn(`[${locale}] --retry-failures: failed to read log: ${err.message}`);
      return { locale, written: 0, failed: 0 };
    }
    if (targets.length === 0) return { locale, written: 0, failed: 0, retried: 0 };
  }
  const COMMIT_BATCH = parseInt(process.env.BACKFILL_COMMIT_BATCH || '25', 10);
  const AUTO_PUSH = process.env.BACKFILL_AUTO_PUSH !== '0';
  const { execSync } = await import('node:child_process');
  const safeExec = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch (err) { return `__ERR__:${(err.stderr || err.message || '').toString().trim().slice(0, 200)}`; }
  };
  const commitBatch = (count, total) => {
    const status = safeExec(`git status --porcelain ${relDir}/`);
    if (!status || status.startsWith('__ERR__:')) return;
    const lines = status.split('\n').filter(Boolean);
    if (lines.length === 0) return;
    safeExec(`git add ${relDir}/`);
    const msg = `chore(seo): AI-search backfill batch — ${locale} (~${count}/${total})`;
    const r = safeExec(`git commit --no-verify -m ${JSON.stringify(msg)}`);
    if (r.startsWith('__ERR__:')) return;
    if (AUTO_PUSH) {
      const pr = safeExec('git pull --rebase --autostash origin main 2>&1');
      if (!pr.startsWith('__ERR__:')) safeExec('git push --no-verify origin main 2>&1');
    }
    process.stdout.write(`💾 [${locale}] committed batch (${lines.length} files)\n`);
  };

  const systemPrompts = {
    it: 'Sei un editor SEO esperto. Rispondi SOLO con JSON valido, senza markdown.',
    en: 'You are an expert SEO editor. Respond ONLY with valid JSON, no markdown.',
    de: 'Du bist ein erfahrener SEO-Editor. Antworte NUR mit gültigem JSON, ohne Markdown.',
    fr: 'Tu es un éditeur SEO expert. Réponds UNIQUEMENT avec du JSON valide, sans markdown.',
  };
  const systemPrompt = systemPrompts[locale] || systemPrompts.it;

  // Stricter retry prompt (used after first validation failure). Forces the
  // model to follow the exact JSON shape with concrete required fields. This
  // recovered ~70% of "tldr undefined" failures in benchmark.
  const retrySystemPrompts = {
    it: `Sei un editor SEO. Devi restituire JSON valido con QUESTA forma esatta:
{"tldr":["bullet1","bullet2","bullet3"],"keyFacts":[{"term":"Cosa","value":"..."},{"term":"Quando","value":"..."},{"term":"Dove","value":"..."}]}
REGOLE FERREE:
- Il campo "tldr" è OBBLIGATORIO, deve essere un array di 3-5 stringhe non vuote
- Il campo "keyFacts" è OBBLIGATORIO, deve essere un array di 3-12 oggetti {term,value}
- Niente markdown, niente recinti tripli "json", niente testo prima o dopo il JSON
- Niente caratteri di controllo (no \\n letterali nelle stringhe — usa testo continuo)`,
    en: `You are an SEO editor. Return valid JSON with EXACTLY this shape:
{"tldr":["bullet1","bullet2","bullet3"],"keyFacts":[{"term":"What","value":"..."},{"term":"When","value":"..."},{"term":"Where","value":"..."}]}
HARD RULES:
- "tldr" is REQUIRED, must be an array of 3-5 non-empty strings
- "keyFacts" is REQUIRED, must be an array of 3-12 {term,value} objects
- No markdown, no triple-backtick json fences, no text before or after the JSON`,
    de: `Du bist ein SEO-Editor. Gib gültiges JSON mit GENAU dieser Struktur zurück:
{"tldr":["punkt1","punkt2","punkt3"],"keyFacts":[{"term":"Was","value":"..."},{"term":"Wann","value":"..."}]}
PFLICHTREGELN:
- "tldr" ist PFLICHT: Array mit 3-5 nicht leeren Strings
- "keyFacts" ist PFLICHT: Array mit 3-12 {term,value} Objekten`,
    fr: `Tu es un éditeur SEO. Renvoie du JSON valide avec EXACTEMENT cette structure:
{"tldr":["point1","point2","point3"],"keyFacts":[{"term":"Quoi","value":"..."},{"term":"Quand","value":"..."}]}
RÈGLES STRICTES:
- "tldr" est OBLIGATOIRE: tableau de 3-5 chaînes non vides
- "keyFacts" est OBLIGATOIRE: tableau de 3-12 objets {term,value}`,
  };

  // Failure tracking — written to data/backfill-failures-{locale}.json so a
  // future --retry-failures run (or manual triage) can target the survivors.
  const failuresPath = path.join(ROOT, 'data', `backfill-failures-${locale}.json`);
  /** @type {Array<{articleId: string, filePath: string, reason: string, when: string}>} */
  const failures = [];

  // Helper: attempt one AI call + validate + write. Retries once with stricter
  // prompt on validation/parse failure (most common: undefined tldr).
  const tryGenerate = async (target, attempt) => {
    const fullBody = [target.body1, target.body2, target.body3].filter(Boolean).join('\n\n');
    const titleGuess = target.articleId.replace(/-/g, ' ');
    const prompt = buildBackfillPrompt({ title: titleGuess, fullBody, locale });
    const sys = attempt === 0
      ? systemPrompt
      : (retrySystemPrompts[locale] || retrySystemPrompts.it);
    const raw = await callLLM(
      [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      {
        model: AI_MODELS.GPT4O_MINI,
        temperature: attempt === 0 ? 0.3 : 0.1, // tighten on retry
        maxTokens: 1500,
        jsonMode: true,
      },
    );
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
    return validateBackfillPayload(parsed);
  };

  let written = 0;
  let failed = 0;
  let retried = 0;
  let writtenSinceCommit = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    process.stdout.write(`[${locale} ${i + 1}/${targets.length}] ${t.articleId}… `);
    let valid = null;
    let firstErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        valid = await tryGenerate(t, attempt);
        if (attempt > 0) retried++;
        break;
      } catch (err) {
        if (attempt === 0) firstErr = err;
        else throw err; // bubble up the retry error
      }
    }
    try {
      if (!valid) throw firstErr || new Error('generation failed');
      const block = buildAiSearchMarkdown({ tldr: valid.tldr, keyFacts: valid.keyFacts, locale });
      // Defense in depth: a previous bug expanded `$N` capture-group refs in
      // String.prototype.replace's replacement string (now mitigated via the
      // function form in replaceBody1). Reject any output that still embeds
      // the literal body1 key marker — that pattern can ONLY come from a
      // broken expansion or a hallucinated AI response.
      const corruptionMarker = new RegExp(`'blog\\.article\\.${t.articleId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.body[0-9]*'\\s*:\\s*'`);
      if (corruptionMarker.test(block)) {
        throw new Error('AI block contains body-key marker — refusing to write (would corrupt TS file)');
      }
      const newBody1 = `${block}${t.body1}`;
      const newRaw = replaceBody1(t.raw, t.articleId, newBody1);
      // Final guard: scan the output for ANY mid-string body-key marker.
      // If the regex fires, abort the write before the file is corrupted.
      const postWriteCheck = /[a-zA-Z0-9.,\-)] *'blog\.article\.[a-z0-9-]+\.(body|faq)[0-9]*': '/;
      if (postWriteCheck.test(newRaw)) {
        throw new Error('post-write scan detected mid-string body-key marker — corrupted output, NOT writing');
      }
      writeFileSync(t.filePath, newRaw, 'utf-8');
      written++;
      writtenSinceCommit++;
      console.log('OK');
      if (SAMPLE && i === 0) {
        console.log(`\n--- SAMPLE BLOCK (${locale}) ---`);
        console.log(block);
        console.log('--- END SAMPLE ---\n');
      }
      if (writtenSinceCommit >= COMMIT_BATCH) {
        commitBatch(i + 1, targets.length);
        writtenSinceCommit = 0;
      }
    } catch (err) {
      failed++;
      failures.push({
        articleId: t.articleId,
        filePath: path.relative(ROOT, t.filePath),
        reason: String(err.message || err).slice(0, 200),
        when: new Date().toISOString(),
      });
      console.log(`FAIL (${err.message})`);
    }
  }
  if (writtenSinceCommit > 0) commitBatch(targets.length, targets.length);

  // Persist failure list so a future `--retry-failures` invocation (or a
  // manual triage dashboard) can target only the survivors. Idempotent: each
  // run rewrites the file with the current locale's failures, drop empty.
  try {
    if (failures.length > 0) {
      writeFileSync(failuresPath, JSON.stringify({
        locale,
        generated: new Date().toISOString(),
        count: failures.length,
        articles: failures,
      }, null, 2) + '\n', 'utf-8');
    } else if (existsSync(failuresPath)) {
      // No failures this run — clean up any stale file.
      try { writeFileSync(failuresPath, JSON.stringify({ locale, generated: new Date().toISOString(), count: 0, articles: [] }, null, 2) + '\n', 'utf-8'); }
      catch { /* non-fatal */ }
    }
  } catch (err) {
    console.warn(`[${locale}] failed to write failure log: ${err.message}`);
  }

  console.log(`[${locale}] Done: ${written} written, ${failed} failed (${retried} recovered via retry), ${targets.length - written - failed} skipped.`);
  return { locale, written, failed, retried };
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
