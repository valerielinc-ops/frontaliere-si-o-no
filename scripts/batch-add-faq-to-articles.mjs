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
import { callLLM, initScoreStore, getStats, flushScores } from './lib/ai-models.mjs';

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
  // Extract array
  const start = c.indexOf('[');
  const end = c.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) c = c.slice(start, end + 1);
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

/** Discover all articles that need FAQ across all 4 locales */
function discoverArticles() {
  const itDir = resolve(BODY_DIR, 'it');
  const files = readdirSync(itDir).filter(f => f.endsWith('.ts')).sort();
  const articles = [];

  for (const file of files) {
    const itPath = `${BODY_DIR}/it/${file}`;
    const itContent = read(itPath);
    const articleId = extractArticleId(itContent);
    if (!articleId) {
      console.error(`⚠️  Cannot extract article ID from ${file}, skipping`);
      continue;
    }

    // Check ALL 4 locales — only process if NONE have .faq
    let anyHasFaq = false;
    for (const locale of LOCALES) {
      const localePath = `${BODY_DIR}/${locale}/${file}`;
      if (existsSync(resolve(localePath))) {
        const locContent = read(localePath);
        if (hasFaqKey(locContent)) {
          anyHasFaq = true;
          break;
        }
      }
    }

    if (!anyHasFaq) {
      articles.push({ id: articleId, file, itContent });
    }
  }

  return articles;
}

// ── FAQ generation via AI ────────────────────────────────────

async function generateFaqIT(articleId, bodyText) {
  const prompt = `Sei un esperto di lavoro transfrontaliero Svizzera-Italia. Leggi questo articolo e genera 3-5 coppie FAQ (domanda/risposta) in italiano.

REGOLE:
- Ogni domanda deve essere una query di ricerca naturale che un frontaliere potrebbe digitare su Google
- Ogni risposta deve essere concisa e autosufficiente (40-80 parole), con dati concreti
- Le FAQ devono coprire i punti chiave dell'articolo
- Usa apostrofi diritti ('), mai virgolette curve
- NON ripetere il titolo dell'articolo nelle domande

ARTICOLO:
${bodyText.slice(0, 6000)}

Rispondi SOLO con un JSON array (no markdown, no code fences):
[{"q":"Domanda 1?","a":"Risposta 1."},{"q":"Domanda 2?","a":"Risposta 2."}]`;

  const raw = await callLLM(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5, maxTokens: 2000, jsonMode: true },
  );

  const parsed = JSON.parse(repairJsonArray(raw));
  if (!Array.isArray(parsed)) throw new Error('FAQ response is not an array');
  return parsed;
}

async function translateFaq(faqArray, targetLang) {
  const langName = targetLang === 'en' ? 'English' : targetLang === 'de' ? 'German' : 'French';

  const prompt = `Translate these FAQ pairs from Italian to ${langName}. Keep the exact same JSON array format. Maintain the meaning, tone, and factual accuracy. Use natural phrasing in the target language, not literal translation. Use straight apostrophes ('), never curly quotes.

${JSON.stringify(faqArray)}

Respond ONLY with the translated JSON array (no markdown, no code fences):
[{"q":"...","a":"..."}]`;

  const raw = await callLLM(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3, maxTokens: 2000, jsonMode: true },
  );

  const parsed = JSON.parse(repairJsonArray(raw));
  if (!Array.isArray(parsed)) throw new Error(`Translation to ${targetLang} is not an array`);
  return parsed;
}

/** Validate FAQ array: min 2 pairs, q>10 chars, a>20 chars */
function validateFaq(faq) {
  if (!Array.isArray(faq)) return null;
  const valid = faq
    .filter(pair =>
      pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
      pair.q.length > 10 && pair.a.length > 20
    )
    .slice(0, 7); // Cap at 7 pairs
  return valid.length >= 2 ? valid : null;
}

// ── File modification ────────────────────────────────────────

/**
 * Insert FAQ key into a body file.
 * Finds the last body key line and appends the FAQ key after it, before `};`
 */
function insertFaqIntoBodyFile(filePath, articleId, faqArray) {
  let content = read(filePath);

  // Already has FAQ? Skip.
  if (hasFaqKey(content)) return false;

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

  // 3. Validate
  const validFaq = validateFaq(itFaq);
  if (!validFaq) {
    console.error(`${label} ❌ FAQ validation failed (got ${itFaq?.length || 0} pairs)`);
    return { success: false, error: 'Validation failed' };
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
      if (translations[i].status === 'fulfilled') {
        faqForLocale = validateFaq(translations[i].value);
        if (!faqForLocale) {
          console.error(`${label} ⚠️  ${locale.toUpperCase()} FAQ validation failed, using Italian fallback`);
          faqForLocale = validFaq;
        } else {
          console.error(`${label} ✅ ${locale.toUpperCase()} translated (${faqForLocale.length} pairs)`);
        }
      } else {
        console.error(`${label} ⚠️  ${locale.toUpperCase()} translation failed: ${translations[i].reason?.message}, using Italian fallback`);
        faqForLocale = validFaq;
      }

      insertFaqIntoBodyFile(localePath, articleId, faqForLocale);
    }
  }

  return { success: true, faqCount: validFaq.length };
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

  // 1. Discover articles needing FAQ
  console.error('📂 Scanning articles...');
  const allArticles = discoverArticles();
  console.error(`   Found ${allArticles.length} articles without FAQ`);

  // 2. Load progress and filter already-completed
  const progress = loadProgress();
  const completedSet = new Set(progress.completed);
  const pendingArticles = allArticles.filter(a => !completedSet.has(a.id));
  console.error(`   Already completed: ${progress.completed.length}`);
  console.error(`   Pending: ${pendingArticles.length}`);

  // 3. Apply limit
  const toProcess = pendingArticles.slice(0, LIMIT);
  console.error(`   Will process: ${toProcess.length}`);
  console.error('');

  if (toProcess.length === 0) {
    console.error('✅ Nothing to process — all articles have FAQ or are completed.');
    return;
  }

  // 4. Dry run — just list articles
  if (DRY_RUN) {
    console.error('── DRY RUN — would process: ──');
    for (const article of toProcess) {
      const bodyText = extractBodyContent(article.itContent);
      console.error(`  • ${article.id} (${bodyText.length} chars body)`);
    }
    console.error('');
    console.error(`Total: ${toProcess.length} articles`);
    const estimatedCalls = toProcess.length * (SKIP_TRANSLATE ? 1 : 4);
    console.error(`Estimated API calls: ${estimatedCalls}`);
    return;
  }

  // 5. Process articles with concurrency control
  let successCount = 0;
  let failCount = 0;
  let totalFaq = 0;

  const tasks = toProcess.map((article, i) => async () => {
    const num = `[${i + 1}/${toProcess.length}]`;
    console.error(`\n${num} Processing ${article.id}...`);

    const result = await processArticle(article.id, article.file, article.itContent);

    if (result.success) {
      successCount++;
      totalFaq += result.faqCount || 0;
      progress.completed.push(article.id);
    } else {
      failCount++;
      progress.failed.push({ id: article.id, error: result.error, at: new Date().toISOString() });
    }

    // Save progress after each article
    saveProgress(progress);
    return result;
  });

  await runWithConcurrency(tasks, CONCURRENCY);

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
  console.error(`  Articles processed: ${successCount + failCount}`);
  console.error(`  ✅ FAQ generated:   ${successCount} (${totalFaq} total FAQ pairs)`);
  console.error(`  ❌ Failed:          ${failCount}`);
  console.error(`  🤖 AI calls:        ${stats.calls || 0}`);
  console.error(`  🔄 AI fallbacks:    ${stats.fallbacks || 0}`);
  console.error(`  📊 Total completed: ${progress.completed.length}/${allArticles.length}`);
  console.error('═══════════════════════════════════════════════════════════');

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
