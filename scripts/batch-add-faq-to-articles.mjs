#!/usr/bin/env node
/**
 * batch-add-faq-to-articles.mjs — Add AI-generated FAQ to existing blog articles.
 *
 * Scans all 720 blog articles, generates 3-5 FAQ pairs per article via AI,
 * translates to EN/DE/FR, and writes the FAQ key to all 4 locale body files.
 *
 * Usage:
 *   node scripts/batch-add-faq-to-articles.mjs                  # process all articles
 *   node scripts/batch-add-faq-to-articles.mjs --limit 10       # process first 10
 *   node scripts/batch-add-faq-to-articles.mjs --dry-run         # preview without API calls
 *   node scripts/batch-add-faq-to-articles.mjs --concurrency 5   # 5 parallel articles
 *   node scripts/batch-add-faq-to-articles.mjs --skip-translate   # Italian FAQ only
 *   node scripts/batch-add-faq-to-articles.mjs --help             # show help
 *
 * Requires: GH_MODELS_PAT env var (or other AI provider keys — uses centralized ai-models.mjs)
 *
 * Progress is saved to data/batch-faq-progress.json for resumability.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { execSync } from 'child_process';
import { callLLM, callSingleModel, AI_MODELS, initScoreStore, getStats, flushScores, resetExhaustedModel } from './lib/ai-models.mjs';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

// ── CLI argument parsing ─────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const HELP = args.includes('--help') || args.includes('-h');
const DRY_RUN = args.includes('--dry-run');
const SKIP_TRANSLATE = args.includes('--skip-translate');
const LIMIT = getArg('--limit') ? parseInt(getArg('--limit'), 10) : Infinity;
const CONCURRENCY = getArg('--concurrency') ? parseInt(getArg('--concurrency'), 10) : 3;

if (HELP) {
  console.log(`
batch-add-faq-to-articles.mjs — Add AI-generated FAQ to existing blog articles

USAGE:
  node scripts/batch-add-faq-to-articles.mjs [options]

OPTIONS:
  --help, -h        Show this help message
  --dry-run         Preview what would be done without making API calls or modifying files
  --limit N         Process only the first N articles (useful for testing)
  --concurrency N   Number of articles to process in parallel (default: 3)
  --skip-translate  Only generate Italian FAQ, skip EN/DE/FR translation

ENVIRONMENT:
  GH_MODELS_PAT     GitHub Models token (required, or other AI provider keys)
  See scripts/lib/ai-models.mjs for all supported providers.

PROGRESS:
  Progress is saved to data/batch-faq-progress.json after each article.
  Re-running the script will skip already-completed articles.
  Delete the progress file to start fresh.

EXAMPLES:
  # Test with 5 articles first
  node scripts/batch-add-faq-to-articles.mjs --limit 5

  # Full run, higher concurrency
  node scripts/batch-add-faq-to-articles.mjs --concurrency 5

  # Preview only
  node scripts/batch-add-faq-to-articles.mjs --dry-run

  # Italian FAQ only (no translation cost)
  node scripts/batch-add-faq-to-articles.mjs --skip-translate --limit 10
`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────────
const LOCALES = ['it', 'en', 'de', 'fr'];
const BODY_DIR = 'services/locales/blog-body';
const PROGRESS_FILE = 'data/batch-faq-progress.json';

// ── Helpers ──────────────────────────────────────────────────

function read(filePath) {
  return readFileSync(resolve(filePath), 'utf-8');
}

function write(filePath, content) {
  writeFileSync(resolve(filePath), content, 'utf-8');
}

/** Same escaping as create-article.mjs buildBodyFile() */
function escapeForSingleQuoteTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/** Strip markdown fences and extract JSON array from LLM output */
function repairJsonArray(s) {
  let c = s.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  // Try to extract array first
  const arrStart = c.indexOf('[');
  const arrEnd = c.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    c = c.slice(arrStart, arrEnd + 1);
  } else {
    // No array brackets — try object wrapping (model may return {"faq": [...]})
    const objStart = c.indexOf('{');
    const objEnd = c.lastIndexOf('}');
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      c = c.slice(objStart, objEnd + 1);
    }
  }
  // Fix literal newlines inside strings
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') { continue; }
    out += ch;
  }
  return out;
}

/** Extract FAQ array from various LLM response shapes:
 *  - direct array: [...]
 *  - wrapped object: {"faq": [...]} or {"faqs": [...]} or {"questions": [...]}
 *  - single-key object with array value: {"anything": [...]}
 *  - object with q/a keys directly: {"q":"...","a":"..."} → wrap as [obj]
 */
function extractFaqArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    // Try known keys first
    for (const key of ['faq', 'faqs', 'questions', 'data', 'results', 'items']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Fallback: first array-valued property
    const vals = Object.values(parsed);
    const arrVal = vals.find((v) => Array.isArray(v));
    if (arrVal) return arrVal;
    // Single Q&A object: {"q": "...", "a": "..."}
    if (typeof parsed.q === 'string' && typeof parsed.a === 'string') return [parsed];
    // Numbered keys: {"1": {"q":"...","a":"..."}, "2": {...}}
    const numVals = Object.values(parsed).filter((v) => v && typeof v === 'object' && v.q && v.a);
    if (numVals.length >= 2) return numVals;
  }
  return null;
}

/** Last-resort: extract Q&A pairs from plain text using regex patterns */
function extractFaqFromText(raw) {
  const pairs = [];
  // Pattern: **D: ...** / **R: ...** or "Domanda: ... Risposta: ..."
  const qaPat = /(?:domanda|question|q)\s*[:.]?\s*["""]?(.{15,200}?)["""]?\s*(?:risposta|answer|a)\s*[:.]?\s*["""]?(.{20,500}?)["""]?\s*(?=(?:domanda|question|q)\s*[:.]\s|$)/gis;
  let m;
  while ((m = qaPat.exec(raw)) !== null) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() });
  }
  if (pairs.length >= 2) return pairs;
  // Pattern: numbered "1. Q: ... A: ..."
  const numPat = /\d+\.\s*(?:Q|D)[:.]\s*(.{15,200}?)\s*(?:A|R)[:.]\s*(.{20,500}?)(?=\d+\.\s*(?:Q|D)[:.]\s|$)/gis;
  while ((m = numPat.exec(raw)) !== null) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() });
  }
  return pairs.length >= 2 ? pairs : null;
}

/** Load progress file or create empty state */
function loadProgress() {
  if (existsSync(resolve(PROGRESS_FILE))) {
    try {
      return JSON.parse(read(PROGRESS_FILE));
    } catch {
      console.error('⚠️  Corrupted progress file, starting fresh');
    }
  }
  return { completed: [], failed: [], startedAt: new Date().toISOString() };
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  write(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

/** Incremental git commit — saves work so CI timeout doesn't lose progress */
let _lastCommitStep = 0;
const COMMIT_EVERY = 25;

function gitCommitAndPush(label) {
  try {
    execSync(
      'git add services/locales/blog-body/ && git add -f data/batch-faq-progress.json 2>/dev/null; ' +
      `git diff --cached --quiet || git commit -m "❓ FAQ batch checkpoint (${label})"`,
      { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
    );
    // Push if GITHUB_PAT is available (CI environment)
    const pat = process.env.GITHUB_PAT;
    const repo = process.env.GITHUB_REPOSITORY;
    if (pat && repo) {
      execSync(
        `git push https://x-access-token:${pat}@github.com/${repo}.git HEAD:main`,
        { cwd: ROOT, stdio: 'pipe', timeout: 60000 }
      );
      console.error(`💾 Checkpoint pushed: ${label}`);
    } else {
      console.error(`💾 Checkpoint committed (no push — local): ${label}`);
    }
  } catch (err) {
    console.error(`⚠️  Checkpoint failed: ${err.message?.slice(0, 100)}`);
  }
}

function commitIfNeeded(currentStep) {
  if ((currentStep - _lastCommitStep) >= COMMIT_EVERY) {
    _lastCommitStep = currentStep;
    gitCommitAndPush(`step ${currentStep}`);
  }
}

// Graceful shutdown: commit+push on SIGTERM (GitHub Actions sends this before kill)
process.on('SIGTERM', () => {
  console.error('\n⚠️  SIGTERM — saving progress...');
  gitCommitAndPush('interrupted');
  process.exit(0);
});

// ── Article discovery ────────────────────────────────────────

/** Extract article ID from a body file's content by scanning for the key pattern */
function extractArticleId(fileContent) {
  const match = fileContent.match(/'blog\.article\.([a-z0-9-]+)\.body1'/);
  return match ? match[1] : null;
}

/** Check if a body file already has a .faq key */
function hasFaqKey(fileContent) {
  return /\.faq'\s*:/.test(fileContent);
}

/** Read and concatenate body1+body2+body3 from file content */
function extractBodyContent(fileContent) {
  const bodies = [];
  for (const n of ['body1', 'body2', 'body3']) {
    const re = new RegExp(`\\.${n}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 's');
    const m = fileContent.match(re);
    if (m) {
      // Unescape the TS string: \\' → ', \\n → newline, \\\\ → backslash
      bodies.push(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
    }
  }
  return bodies.join('\n\n');
}

/** Check if FAQ text is in the wrong locale (same logic as job crawlers) */
function isWrongLocale(faqArray, expectedLocale) {
  const allText = faqArray.map(p => `${p.q} ${p.a}`).join(' ');
  if (allText.length < 50) return false;
  const detected = detectLanguage(allText, expectedLocale);
  return detected !== expectedLocale;
}

function extractFaqFromContent(fileContent) {
  const faqMatch = fileContent.match(/\.faq['']\s*:\s*[''`](.+?)[''`]\s*[,}]/s);
  if (!faqMatch) return null;
  try {
    return JSON.parse(faqMatch[1].replace(/\\'/g, "'"));
  } catch { return null; }
}

const MIN_FAQ_PAIRS = 3;

/**
 * Discover articles that need work:
 * - needsGeneration: IT has no .faq key → needs AI generation
 * - needsTopUp: IT .faq exists but < MIN_FAQ_PAIRS → needs extra AI pairs
 * - needsTranslation: EN/DE/FR missing or wrong locale
 */
function discoverArticles() {
  const itDir = resolve(BODY_DIR, 'it');
  const files = readdirSync(itDir).filter(f => f.endsWith('.ts')).sort();
  const needsGeneration = [];
  const needsTopUp = [];
  const needsTranslation = [];

  for (const file of files) {
    const itPath = `${BODY_DIR}/it/${file}`;
    const itContent = read(itPath);
    const articleId = extractArticleId(itContent);
    if (!articleId) continue;

    const itHasFaq = hasFaqKey(itContent);

    if (!itHasFaq) {
      needsGeneration.push({ id: articleId, file, itContent });
      continue;
    }

    // IT FAQ exists — check pair count and locale translations
    const itFaq = extractFaqFromContent(itContent);
    if (!itFaq || itFaq.length === 0) continue;

    // Top-up: not enough pairs
    if (itFaq.length < MIN_FAQ_PAIRS) {
      needsTopUp.push({ id: articleId, file, itContent, existingFaq: itFaq });
    }

    // Translation: check each non-IT locale
    const missingLocales = [];
    for (const locale of ['en', 'de', 'fr']) {
      const localePath = `${BODY_DIR}/${locale}/${file}`;
      if (!existsSync(resolve(localePath))) continue;
      const locContent = read(localePath);
      if (!hasFaqKey(locContent)) {
        missingLocales.push(locale);
      } else {
        const localeFaq = extractFaqFromContent(locContent);
        if (localeFaq && isWrongLocale(localeFaq, locale)) {
          missingLocales.push(locale);
        }
      }
    }

    if (missingLocales.length > 0) {
      needsTranslation.push({ id: articleId, file, itFaq, missingLocales });
    }
  }

  return { needsGeneration, needsTopUp, needsTranslation };
}

// ── FAQ generation via AI ────────────────────────────────────

// Preferred models for FAQ (Gemini free tier — reliable JSON output)
const FAQ_MODELS = [
  AI_MODELS.GEMINI_FLASH,
  AI_MODELS.GEMINI_2_FLASH,
  AI_MODELS.GEMINI_FLASH_LITE,
];

// Rate limiter: space out calls to avoid 503 on Gemini free tier (15 RPM)
let _lastCallMs = 0;
async function rateLimitedDelay() {
  const minGapMs = 4500; // ~13 RPM max, safe for Gemini free tier
  const elapsed = Date.now() - _lastCallMs;
  if (elapsed < minGapMs) {
    await new Promise((r) => setTimeout(r, minGapMs - elapsed));
  }
  _lastCallMs = Date.now();
}

async function callFaqModel(messages, opts = {}) {
  await rateLimitedDelay();
  // Try Gemini models first — force-clear exhaustion from previous runs
  // (ScoreStore persists exhaustion to Firestore, but with rate limiting we're safe)
  for (const model of FAQ_MODELS) {
    try {
      resetExhaustedModel(model);
      return await callSingleModel(messages, { ...opts, model, maxRetriesPerModel: 4, backoffMs: 5000 });
    } catch {
      // Model genuinely failed — try next Gemini variant
    }
  }
  // All Gemini failed — fall back to general chain
  return callLLM(messages, opts);
}

async function generateFaqIT(articleId, bodyText) {
  const prompt = `Sei un esperto di lavoro transfrontaliero Svizzera-Italia. Leggi questo articolo e genera ESATTAMENTE 5 coppie FAQ (domanda/risposta) in italiano. Il MINIMO ASSOLUTO è 3 coppie.

REGOLE:
- Genera ALMENO 3 coppie, idealmente 5
- Ogni domanda deve essere una query di ricerca naturale che un frontaliere potrebbe digitare su Google
- Ogni risposta deve essere concisa e autosufficiente (40-80 parole), con dati concreti
- Le FAQ devono coprire aspetti DIVERSI dell'articolo
- Usa apostrofi diritti ('), mai virgolette curve
- NON ripetere il titolo dell'articolo nelle domande

ARTICOLO:
${bodyText.slice(0, 6000)}

Rispondi SOLO con un JSON array (no markdown, no code fences):
[{"q":"Domanda 1?","a":"Risposta 1."},{"q":"Domanda 2?","a":"Risposta 2."}]`;

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens: 2000, jsonMode: true },
  );

  const repaired = repairJsonArray(raw);
  let parsed;
  try {
    parsed = JSON.parse(repaired);
  } catch (parseErr) {
    // Try extracting Q&A pairs via regex as last resort
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 2) return regexFaq;
    console.error(`  [JSON parse failed] ${parseErr.message} — raw[0:300]: ${raw.slice(0, 300).replace(/\n/g, '\\n')}`);
    throw parseErr;
  }
  const faq = extractFaqArray(parsed);
  if (!faq) {
    // Try extracting from raw text as last resort
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 2) return regexFaq;
    console.error(`  [extractFaqArray null] type=${typeof parsed} keys=${parsed ? Object.keys(parsed).join(',') : 'N/A'} raw[0:300]: ${raw.slice(0, 300).replace(/\n/g, '\\n')}`);
    throw new Error('FAQ response is not an array');
  }
  return faq;
}

/**
 * Generate additional FAQ pairs to reach MIN_FAQ_PAIRS (3-5).
 * Provides existing FAQ so AI avoids duplicates.
 */
async function generateTopUpFaqIT(articleId, bodyText, existingFaq) {
  const needed = MIN_FAQ_PAIRS - existingFaq.length;
  const existingQs = existingFaq.map(p => p.q).join('\n- ');

  const prompt = `Sei un esperto di lavoro transfrontaliero Svizzera-Italia. Leggi questo articolo e genera esattamente ${needed + 2} coppie FAQ (domanda/risposta) NUOVE in italiano.

DOMANDE GIÀ ESISTENTI (NON ripeterle né riformularle):
- ${existingQs}

REGOLE:
- Le nuove FAQ devono coprire aspetti DIVERSI da quelli già presenti
- Ogni domanda deve essere una query di ricerca naturale che un frontaliere potrebbe digitare su Google
- Ogni risposta deve essere concisa e autosufficiente (40-80 parole), con dati concreti
- Usa apostrofi diritti ('), mai virgolette curve

ARTICOLO:
${bodyText.slice(0, 6000)}

Rispondi SOLO con un JSON array (no markdown, no code fences):
[{"q":"Domanda 1?","a":"Risposta 1."},{"q":"Domanda 2?","a":"Risposta 2."}]`;

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens: 2000, jsonMode: true },
  );

  const repaired = repairJsonArray(raw);
  let parsed;
  try {
    parsed = JSON.parse(repaired);
  } catch (parseErr) {
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 1) return regexFaq;
    throw parseErr;
  }
  const faq = extractFaqArray(parsed);
  if (!faq) {
    const regexFaq = extractFaqFromText(raw);
    if (regexFaq && regexFaq.length >= 1) return regexFaq;
    throw new Error('Top-up FAQ response is not an array');
  }

  // Deduplicate: remove any pair whose question is too similar to existing ones
  const existingLower = existingFaq.map(p => p.q.toLowerCase());
  return faq.filter(p => {
    const qLower = p.q.toLowerCase();
    return !existingLower.some(eq => eq === qLower || eq.includes(qLower) || qLower.includes(eq));
  });
}

async function translateFaq(faqArray, targetLang) {
  const results = [];
  for (const pair of faqArray) {
    const [translatedQ, translatedA] = await Promise.all([
      freeTranslateWithRetry({ text: pair.q, sourceLang: 'it', targetLang }),
      freeTranslateWithRetry({ text: pair.a, sourceLang: 'it', targetLang }),
    ]);
    if (translatedQ && translatedA && translatedQ.length > 10 && translatedA.length > 20) {
      results.push({ q: translatedQ, a: translatedA });
    } else {
      results.push(pair); // Keep Italian pair as fallback
    }
  }
  return results.length > 0 ? results : null;
}

/** Validate FAQ array: min 1 pair, q>10 chars, a>20 chars */
function validateFaq(faq) {
  if (!Array.isArray(faq)) return null;
  const valid = faq
    .filter(pair =>
      pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
      pair.q.length > 10 && pair.a.length > 20
    )
    .slice(0, 7); // Cap at 7 pairs
  return valid.length >= 1 ? valid : null;
}

// ── File modification ────────────────────────────────────────

/** Replace existing FAQ value in a body file */
function replaceFaqInBodyFile(filePath, faqArray) {
  let content = read(filePath);
  const jsonStr = JSON.stringify(faqArray).replace(/'/g, "\\'");
  const replaced = content.replace(
    /(\.faq'\s*:\s*')(.+?)('\s*[,])/s,
    `$1${jsonStr}$3`
  );
  if (replaced === content) return false;
  write(filePath, replaced);
  return true;
}

/**
 * Insert FAQ key into a body file.
 * Finds the last body key line and appends the FAQ key after it, before `};`
 */
function insertFaqIntoBodyFile(filePath, articleId, faqArray) {
  let content = read(filePath);

  // Already has FAQ? Replace instead of insert.
  if (hasFaqKey(content)) {
    return replaceFaqInBodyFile(filePath, faqArray);
  }

  const faqJsonStr = JSON.stringify(faqArray);
  const escapedFaq = escapeForSingleQuoteTS(faqJsonStr);
  const faqLine = `    'blog.article.${articleId}.faq': '${escapedFaq}',`;

  // Strategy: insert before the closing `};`
  // Find the last property line (body3 or similar) and insert after it
  const closingMatch = content.match(/^(\s*)\};\s*$/m);
  if (!closingMatch) {
    console.error(`  ⚠️  Cannot find closing }; in ${filePath}`);
    return false;
  }

  // Insert FAQ line before the `};` line
  content = content.replace(
    /(\n)((\s*)\};\s*\n\s*export default)/,
    `\n${faqLine}\n$2`,
  );

  // Verify the insertion worked
  if (!hasFaqKey(content)) {
    // Fallback: more aggressive replacement
    content = read(filePath);
    content = content.replace(
      /(\.body3':\s*'(?:[^'\\]|\\.)*',)\n(\};)/s,
      `$1\n${faqLine}\n$2`,
    );
  }

  if (!hasFaqKey(content)) {
    console.error(`  ❌ Failed to insert FAQ into ${filePath}`);
    return false;
  }

  write(filePath, content);
  return true;
}

// ── Process single article ───────────────────────────────────

async function processArticle(articleId, file, itBodyContent) {
  const label = `[${articleId}]`;

  // 1. Extract Italian body text
  const bodyText = extractBodyContent(itBodyContent);
  if (!bodyText || bodyText.length < 100) {
    console.error(`${label} ⚠️  Body text too short (${bodyText?.length || 0} chars), skipping`);
    return { success: false, error: 'Body too short' };
  }

  // 2. Generate Italian FAQ
  console.error(`${label} 🇮🇹 Generating FAQ...`);
  let itFaq;
  try {
    itFaq = await generateFaqIT(articleId, bodyText);
  } catch (err) {
    // Retry once
    console.error(`${label} ⚠️  First attempt failed: ${err.message}, retrying...`);
    try {
      itFaq = await generateFaqIT(articleId, bodyText);
    } catch (retryErr) {
      console.error(`${label} ❌ FAQ generation failed: ${retryErr.message}`);
      return { success: false, error: retryErr.message };
    }
  }

  // 3. Validate — need at least MIN_FAQ_PAIRS for new articles
  const validFaq = validateFaq(itFaq);
  if (!validFaq || validFaq.length < MIN_FAQ_PAIRS) {
    console.error(`${label} ❌ FAQ validation failed (got ${validFaq?.length || itFaq?.length || 0} pairs, need ≥${MIN_FAQ_PAIRS})`);
    return { success: false, error: `Only ${validFaq?.length || 0} pairs (need ≥${MIN_FAQ_PAIRS})` };
  }
  console.error(`${label} ✅ ${validFaq.length} FAQ pairs generated`);

  // 4. Write Italian FAQ
  const itPath = `${BODY_DIR}/it/${file}`;
  if (!insertFaqIntoBodyFile(itPath, articleId, validFaq)) {
    return { success: false, error: 'Failed to write IT FAQ' };
  }

  // 5. Translate to EN, DE, FR (parallel)
  if (!SKIP_TRANSLATE) {
    const translations = await Promise.allSettled([
      translateFaq(validFaq, 'en'),
      translateFaq(validFaq, 'de'),
      translateFaq(validFaq, 'fr'),
    ]);

    const localeMap = { 0: 'en', 1: 'de', 2: 'fr' };

    for (let i = 0; i < translations.length; i++) {
      const locale = localeMap[i];
      const localePath = `${BODY_DIR}/${locale}/${file}`;

      if (!existsSync(resolve(localePath))) {
        console.error(`${label} ⚠️  ${locale} body file missing, skipping`);
        continue;
      }

      let faqForLocale;
      if (translations[i].status === 'fulfilled' && translations[i].value) {
        faqForLocale = translations[i].value;
        console.error(`${label} ✅ ${locale.toUpperCase()} translated (${faqForLocale.length} pairs)`);
      } else {
        const reason = translations[i].status === 'rejected' ? translations[i].reason?.message : 'null result';
        console.error(`${label} ⚠️  ${locale.toUpperCase()} translation failed: ${reason}, using Italian fallback`);
        faqForLocale = validFaq;
      }

      insertFaqIntoBodyFile(localePath, articleId, faqForLocale);
    }
  }

  return { success: true, faqCount: validFaq.length };
}

// ── Process article top-up (existing FAQ < MIN_FAQ_PAIRS) ────

async function processTopUp(articleId, file, itContent, existingFaq) {
  const label = `[${articleId}] [TOP-UP ${existingFaq.length}→${MIN_FAQ_PAIRS}+]`;

  const bodyText = extractBodyContent(itContent);
  if (!bodyText || bodyText.length < 100) {
    console.error(`${label} ⚠️  Body too short, skipping`);
    return { success: false, error: 'Body too short' };
  }

  // 1. Generate additional FAQ pairs
  console.error(`${label} 🇮🇹 Generating ${MIN_FAQ_PAIRS - existingFaq.length}+ extra FAQ pairs...`);
  let newPairs;
  try {
    newPairs = await generateTopUpFaqIT(articleId, bodyText, existingFaq);
  } catch (err) {
    console.error(`${label} ❌ Top-up generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (!newPairs || newPairs.length === 0) {
    console.error(`${label} ❌ No new pairs generated`);
    return { success: false, error: 'No new pairs' };
  }

  // 2. Merge: existing + new, cap at 7
  const merged = [...existingFaq, ...newPairs].slice(0, 7);
  const validMerged = validateFaq(merged);
  if (!validMerged || validMerged.length < MIN_FAQ_PAIRS) {
    console.error(`${label} ❌ Merged FAQ still only ${validMerged?.length || 0} pairs`);
    return { success: false, error: 'Not enough pairs after merge' };
  }
  console.error(`${label} ✅ ${existingFaq.length} existing + ${newPairs.length} new = ${validMerged.length} total`);

  // 3. Write updated IT FAQ
  const itPath = `${BODY_DIR}/it/${file}`;
  if (!replaceFaqInBodyFile(itPath, validMerged)) {
    return { success: false, error: 'Failed to write updated IT FAQ' };
  }

  // 4. Translate and update all locales
  if (!SKIP_TRANSLATE) {
    for (const locale of ['en', 'de', 'fr']) {
      const localePath = `${BODY_DIR}/${locale}/${file}`;
      if (!existsSync(resolve(localePath))) continue;

      try {
        const translated = await translateFaq(validMerged, locale);
        if (translated) {
          insertFaqIntoBodyFile(localePath, articleId, translated);
          console.error(`${label} ✅ ${locale.toUpperCase()} translated (${translated.length} pairs)`);
        } else {
          insertFaqIntoBodyFile(localePath, articleId, validMerged);
          console.error(`${label} ⚠️  ${locale.toUpperCase()} translation failed, using Italian`);
        }
      } catch (err) {
        insertFaqIntoBodyFile(localePath, articleId, validMerged);
        console.error(`${label} ⚠️  ${locale.toUpperCase()} error: ${err.message}, using Italian`);
      }
    }
  }

  return { success: true, faqCount: validMerged.length };
}

// ── Process translation-only (IT FAQ ok, locale missing/wrong) ──

async function processTranslation(articleId, file, itFaq, missingLocales) {
  const label = `[${articleId}] [TRANSLATE ${missingLocales.join(',')}]`;
  let fixed = 0;

  for (const locale of missingLocales) {
    const localePath = `${BODY_DIR}/${locale}/${file}`;
    if (!existsSync(resolve(localePath))) continue;

    try {
      const translated = await translateFaq(itFaq, locale);
      if (translated) {
        insertFaqIntoBodyFile(localePath, articleId, translated);
        console.error(`${label} ✅ ${locale.toUpperCase()} (${translated.length} pairs)`);
        fixed++;
      } else {
        console.error(`${label} ⚠️  ${locale.toUpperCase()} translation null`);
      }
    } catch (err) {
      console.error(`${label} ❌ ${locale.toUpperCase()}: ${err.message}`);
    }
  }

  return { success: fixed > 0, faqCount: fixed };
}

// ── Concurrency control ──────────────────────────────────────

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const currentIdx = idx++;
      results[currentIdx] = await tasks[currentIdx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.error('═══════════════════════════════════════════════════════════');
  console.error('  batch-add-faq-to-articles.mjs');
  console.error('═══════════════════════════════════════════════════════════');
  console.error(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.error(`  Concurrency: ${CONCURRENCY}`);
  console.error(`  Limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
  console.error(`  Translate: ${SKIP_TRANSLATE ? 'NO (Italian only)' : 'YES (all 4 locales)'}`);
  console.error('');

  // Initialize AI model scoring
  if (!DRY_RUN) {
    await initScoreStore();
  }

  // 1. Discover articles needing work
  console.error('📂 Scanning articles...');
  const { needsGeneration, needsTopUp, needsTranslation } = discoverArticles();
  console.error(`   🆕 Need generation:  ${needsGeneration.length}`);
  console.error(`   📈 Need top-up (<${MIN_FAQ_PAIRS} pairs): ${needsTopUp.length}`);
  console.error(`   🌐 Need translation: ${needsTranslation.length}`);

  // 2. Load progress and filter already-completed (only for generation)
  const progress = loadProgress();
  const completedSet = new Set(progress.completed);
  const pendingGeneration = needsGeneration.filter(a => !completedSet.has(a.id));
  console.error(`   Already generated:  ${progress.completed.length}`);
  console.error(`   Pending generation: ${pendingGeneration.length}`);

  const totalWork = pendingGeneration.length + needsTopUp.length + needsTranslation.length;
  if (totalWork === 0) {
    console.error('\n✅ Nothing to process — all articles have ≥3 FAQ pairs in all locales.');
    return;
  }

  // 3. Apply limit (generation first, then top-up, then translation)
  let remaining = LIMIT;
  const genSlice = pendingGeneration.slice(0, remaining);
  remaining -= genSlice.length;
  const topUpSlice = needsTopUp.slice(0, remaining);
  remaining -= topUpSlice.length;
  const transSlice = needsTranslation.slice(0, remaining);
  console.error(`   Will process: ${genSlice.length} gen + ${topUpSlice.length} top-up + ${transSlice.length} translate`);
  console.error('');

  // 4. Dry run
  if (DRY_RUN) {
    console.error('── DRY RUN ──');
    if (genSlice.length > 0) {
      console.error('\n🆕 Generation:');
      for (const a of genSlice) console.error(`  • ${a.id}`);
    }
    if (topUpSlice.length > 0) {
      console.error(`\n📈 Top-up (to ≥${MIN_FAQ_PAIRS} pairs):`);
      for (const a of topUpSlice) console.error(`  • ${a.id} (${a.existingFaq.length} → ${MIN_FAQ_PAIRS}+)`);
    }
    if (transSlice.length > 0) {
      console.error('\n🌐 Translation:');
      for (const a of transSlice) console.error(`  • ${a.id} [${a.missingLocales.join(',')}]`);
    }
    return;
  }

  // 5. Process all work
  let successCount = 0;
  let failCount = 0;
  let totalFaq = 0;
  let step = 0;
  const totalSteps = genSlice.length + topUpSlice.length + transSlice.length;

  // 5a. Generation tasks
  const genTasks = genSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 🆕 ${article.id}`);
    const result = await processArticle(article.id, article.file, article.itContent);
    if (result.success) {
      successCount++;
      totalFaq += result.faqCount || 0;
      progress.completed.push(article.id);
    } else {
      failCount++;
      progress.failed.push({ id: article.id, error: result.error, at: new Date().toISOString() });
    }
    saveProgress(progress);
    commitIfNeeded(step);
    return result;
  });

  // 5b. Top-up tasks
  const topUpTasks = topUpSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 📈 ${article.id} (${article.existingFaq.length} pairs)`);
    const result = await processTopUp(article.id, article.file, article.itContent, article.existingFaq);
    if (result.success) {
      successCount++;
      totalFaq += result.faqCount || 0;
    } else {
      failCount++;
    }
    commitIfNeeded(step);
    return result;
  });

  // 5c. Translation tasks
  const transTasks = transSlice.map((article) => async () => {
    step++;
    console.error(`\n[${step}/${totalSteps}] 🌐 ${article.id} [${article.missingLocales.join(',')}]`);
    const result = await processTranslation(article.id, article.file, article.itFaq, article.missingLocales);
    if (result.success) successCount++;
    else failCount++;
    commitIfNeeded(step);
    return result;
  });

  await runWithConcurrency([...genTasks, ...topUpTasks, ...transTasks], CONCURRENCY);

  // 6. Flush AI model scores
  try {
    await flushScores();
  } catch {
    // Non-critical
  }

  // 7. Summary
  const stats = getStats();
  console.error('\n═══════════════════════════════════════════════════════════');
  console.error('  SUMMARY');
  console.error('═══════════════════════════════════════════════════════════');
  console.error(`  Total processed:    ${successCount + failCount}`);
  console.error(`  ✅ Succeeded:       ${successCount}`);
  console.error(`  ❌ Failed:          ${failCount}`);
  console.error(`  🆕 Generated:       ${genSlice.length}`);
  console.error(`  📈 Top-ups:         ${topUpSlice.length}`);
  console.error(`  🌐 Translations:    ${transSlice.length}`);
  console.error(`  🤖 AI calls:        ${stats.calls || 0}`);
  console.error(`  🔄 AI fallbacks:    ${stats.fallbacks || 0}`);
  console.error(`  📊 Total completed: ${progress.completed.length}/${needsGeneration.length + progress.completed.length}`);
  console.error('═══════════════════════════════════════════════════════════');

  // Translation cascade stats
  try { logCascadeSummary(); } catch { /* optional */ }

  if (failCount > 0) {
    console.error('\n❌ Failed articles:');
    for (const f of progress.failed.slice(-failCount)) {
      console.error(`  • ${f.id}: ${f.error}`);
    }
  }
}

main().catch(err => {
  console.error(`\n💥 Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
