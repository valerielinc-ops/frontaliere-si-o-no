#!/usr/bin/env node
/**
 * fix-faq-locales.mjs
 * 
 * Scans EN/DE/FR blog body files for FAQ keys that are still in Italian.
 * Re-translates them to the correct locale using the same AI pipeline.
 * Also fills in missing FAQ for locales that have the IT version.
 *
 * Usage:
 *   node scripts/fix-faq-locales.mjs [--dry-run] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const BODY_DIR = resolve(ROOT, 'services/locales/blog-body');

// Italian detection heuristics — common Italian words/patterns unlikely in EN/DE/FR
const ITALIAN_MARKERS = [
  /\bdell['']/i, /\bnella\b/i, /\bquesto\b/i, /\bquali\b/i,
  /\bviene\b/i, /\bsono\b/i, /\banche\b/i, /\bdella\b/i,
  /\bdelle\b/i, /\bdegli\b/i, /\bperché\b/i, /\bil ruolo\b/i,
  /\bl['']aumento\b/i, /\bfrontalieri\b/i, /\blavoro\b/i,
  /\bricerca\b/i, /\bpossono\b/i, /\bquanto\b/i, /\brischi\b/i,
  /\bimpatto\b/i, /\bimporto\b/i, /\bcosa\b/i, /\bcome\b/i,
  /\bdopo\b/i, /\bprima\b/i, /\bstato\b/i, /\bavere\b/i,
  /\bessere\b/i, /\bsulla\b/i, /\bsulle\b/i, /\bsugli\b/i,
  /\bquando\b/i, /\bdovr[àa]\b/i, /\bpuò\b/i, /\bsarà\b/i,
];

function isLikelyItalian(text) {
  let hits = 0;
  for (const marker of ITALIAN_MARKERS) {
    if (marker.test(text)) hits++;
  }
  // Need at least 3 Italian markers to flag — avoid false positives on loanwords
  return hits >= 3;
}

function extractFaqFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const faqMatch = content.match(/\.faq['']\s*:\s*[''`](.+?)[''`]\s*[,}]/s);
  if (!faqMatch) return null;
  try {
    // Unescape the string value (it's inside a TS string literal)
    const raw = faqMatch[1].replace(/\\'/g, "'");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function replaceFaqInFile(filePath, newFaqArray) {
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = JSON.stringify(newFaqArray).replace(/'/g, "\\'");
  content = content.replace(
    /(\.faq['']\s*:\s*[''`])(.+?)([''`]\s*[,}])/s,
    `$1${jsonStr}$3`
  );
  writeFileSync(filePath, content, 'utf-8');
}

// ── AI Translation ──────────────────────────────────────────

let callFaqModel, repairJsonArray, extractFaqArray, validateFaq;

async function initAI() {
  // Dynamically import from batch script helpers
  const aiModels = await import('./lib/ai-models.mjs');
  const { callSingleModel, AI_MODELS, resetExhaustedModel } = aiModels;

  const FAQ_MODELS = [
    'google/gemini-2.5-flash',
    'google/gemini-2.0-flash',
    'google/gemini-2.5-flash-lite',
  ];

  let lastCallTime = 0;
  async function rateLimitedDelay() {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    const gap = 4500; // 4.5s between calls
    if (elapsed < gap) await new Promise(r => setTimeout(r, gap - elapsed));
    lastCallTime = Date.now();
  }

  callFaqModel = async (messages, opts) => {
    for (const modelId of FAQ_MODELS) {
      try {
        resetExhaustedModel(modelId);
        await rateLimitedDelay();
        return await callSingleModel(modelId, messages, opts);
      } catch (err) {
        console.error(`  Model ${modelId} failed: ${err.message}`);
      }
    }
    // Fallback chain
    for (const m of AI_MODELS.filter(m => !FAQ_MODELS.includes(m.id)).slice(0, 5)) {
      try {
        await rateLimitedDelay();
        return await callSingleModel(m.id, messages, opts);
      } catch (err) {
        console.error(`  Fallback ${m.id} failed: ${err.message}`);
      }
    }
    throw new Error('All AI models failed for translation');
  };

  // Reuse from batch script
  repairJsonArray = (raw) => {
    if (!raw || typeof raw !== 'string') return '[]';
    let s = raw.trim();
    // Remove markdown code fences
    s = s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    // If it starts with {, try to extract array
    if (s.startsWith('{') && !s.startsWith('[')) {
      const arrMatch = s.match(/\[[\s\S]*\]/);
      if (arrMatch) return arrMatch[0];
    }
    return s;
  };

  extractFaqArray = (parsed) => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      // Try common wrapper keys
      for (const key of ['faq', 'faqs', 'FAQ', 'questions', 'data', 'results']) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
      // Single {q, a} object
      if (parsed.q && parsed.a) return [parsed];
    }
    return null;
  };

  validateFaq = (faq) => {
    if (!Array.isArray(faq)) return null;
    const valid = faq.filter(pair =>
      pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
      pair.q.length > 10 && pair.a.length > 20
    ).slice(0, 7);
    return valid.length >= 1 ? valid : null;
  };
}

async function translateFaq(faqArray, targetLang) {
  const langName = targetLang === 'en' ? 'English' : targetLang === 'de' ? 'German' : 'French';

  const prompt = `Translate these FAQ pairs from Italian to ${langName}. Keep the exact same JSON array format. Maintain the meaning, tone, and factual accuracy. Use natural phrasing in the target language, not literal translation. Use straight apostrophes ('), never curly quotes.

${JSON.stringify(faqArray)}

Respond ONLY with the translated JSON array (no markdown, no code fences):
[{"q":"...","a":"..."}]`;

  const raw = await callFaqModel(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3, maxTokens: 2000, jsonMode: true },
  );

  const parsed = JSON.parse(repairJsonArray(raw));
  const faq = extractFaqArray(parsed);
  if (!faq) throw new Error('Translation response is not a FAQ array');
  return validateFaq(faq);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Scanning for FAQ locale issues...\n');

  const itFiles = readdirSync(resolve(BODY_DIR, 'it')).filter(f => f.endsWith('.ts'));
  const issues = []; // { articleId, locale, reason: 'italian_text' | 'missing' }

  for (const file of itFiles) {
    const articleId = basename(file, '.ts');
    const itFaq = extractFaqFromFile(resolve(BODY_DIR, 'it', file));
    if (!itFaq || itFaq.length === 0) continue;

    for (const locale of ['en', 'de', 'fr']) {
      const localePath = resolve(BODY_DIR, locale, file);
      if (!existsSync(localePath)) continue;

      const localeFaq = extractFaqFromFile(localePath);
      if (!localeFaq) {
        issues.push({ articleId, file, locale, reason: 'missing', itFaq });
      } else {
        // Check if the FAQ text is actually Italian
        const allText = localeFaq.map(p => `${p.q} ${p.a}`).join(' ');
        if (isLikelyItalian(allText)) {
          issues.push({ articleId, file, locale, reason: 'italian_text', itFaq });
        }
      }
    }
  }

  console.log(`Found ${issues.length} FAQ locale issues:`);
  const byReason = {};
  for (const i of issues) {
    byReason[i.reason] = (byReason[i.reason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`  ${reason}: ${count}`);
  }

  if (DRY_RUN) {
    console.log('\n🏁 Dry run — listing issues:');
    for (const i of issues.slice(0, 50)) {
      console.log(`  ${i.locale.toUpperCase()} ${i.reason}: ${i.articleId}`);
    }
    return;
  }

  if (issues.length === 0) {
    console.log('\n✅ All FAQ locales are correct!');
    return;
  }

  // Group by locale for efficient batching
  const toProcess = issues.slice(0, LIMIT);
  console.log(`\nProcessing ${toProcess.length} issues...`);

  await initAI();

  let fixed = 0, failed = 0;
  for (const issue of toProcess) {
    const label = `[${issue.locale.toUpperCase()}] ${issue.articleId}`;
    try {
      const translated = await translateFaq(issue.itFaq, issue.locale);
      if (!translated) {
        console.error(`${label} ❌ Translation produced invalid FAQ`);
        failed++;
        continue;
      }

      const localePath = resolve(BODY_DIR, issue.locale, issue.file);
      if (issue.reason === 'missing') {
        // Need to insert FAQ key into the file
        let content = readFileSync(localePath, 'utf-8');
        const jsonStr = JSON.stringify(translated).replace(/'/g, "\\'");
        // Insert before the closing `};`
        const closingIdx = content.lastIndexOf('};');
        if (closingIdx === -1) {
          console.error(`${label} ❌ Could not find closing }; in file`);
          failed++;
          continue;
        }
        const faqKey = `    'blog.article.${issue.articleId}.faq': '${jsonStr}',\n`;
        content = content.slice(0, closingIdx) + faqKey + content.slice(closingIdx);
        writeFileSync(localePath, content, 'utf-8');
      } else {
        replaceFaqInFile(localePath, translated);
      }

      console.error(`${label} ✅ Fixed (${translated.length} pairs)`);
      fixed++;
    } catch (err) {
      console.error(`${label} ❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${fixed} fixed, ${failed} failed, ${issues.length - toProcess.length} remaining`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
