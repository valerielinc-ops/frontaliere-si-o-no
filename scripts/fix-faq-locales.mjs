#!/usr/bin/env node
/**
 * fix-faq-locales.mjs
 * 
 * Scans EN/DE/FR blog body files for FAQ keys that are still in Italian
 * or missing entirely. Uses the same detection (trigram-based detectLanguage)
 * and translation (freeTranslateWithRetry cascade) as the job crawlers.
 *
 * Usage:
 *   node scripts/fix-faq-locales.mjs [--dry-run] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { freeTranslateWithRetry, isSourcePassthrough, logCascadeSummary } from './lib/free-translate.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ── Section selection (--section=frontaliere|svizzera, default frontaliere) ──
// Switches the body-dir enumeration between the cross-border and the
// Switzerland-wide article sets. frontaliere is byte-identical.
function getSectionArg() {
  let section = 'frontaliere';
  for (const a of args) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  const inlineIdx = args.indexOf('--section');
  if (inlineIdx >= 0 && args[inlineIdx + 1] && !args[inlineIdx + 1].startsWith('--')) {
    section = args[inlineIdx + 1];
  }
  if (!['frontaliere', 'svizzera'].includes(section)) {
    console.error(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
    process.exit(1);
  }
  return section;
}
const SECTION = getSectionArg();
const SECTION_BODY_SUBDIR = SECTION === 'svizzera' ? 'blog-body-ch' : 'blog-body';

const BODY_DIR = resolve(ROOT, `services/locales/${SECTION_BODY_SUBDIR}`);

// ── File helpers ────────────────────────────────────────────

function extractFaqFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  // Escape-aware regex: (?:[^'\\]|\\.)* correctly skips \' sequences
  const faqMatch = content.match(/\.faq['']\s*:\s*[']((?:[^'\\]|\\.)*)[']\s*[,}]/);
  if (!faqMatch) return null;
  try {
    return JSON.parse(faqMatch[1].replace(/\\'/g, "'"));
  } catch { return null; }
}

function hasFaqKey(filePath) {
  if (!existsSync(filePath)) return false;
  return /\.faq['']\s*:/.test(readFileSync(filePath, 'utf-8'));
}

function replaceFaqInFile(filePath, newFaqArray) {
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = JSON.stringify(newFaqArray).replace(/'/g, "\\'");
  // Escape-aware regex + function replacer to avoid $-pattern issues
  content = content.replace(
    /(\.faq['']\s*:\s*[''])((?:[^'\\]|\\.)*)(['']\s*[,}])/,
    (_match, g1, _g2, g3) => g1 + jsonStr + g3
  );
  writeFileSync(filePath, content, 'utf-8');
}

function insertFaqKey(filePath, articleId, faqArray) {
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = JSON.stringify(faqArray).replace(/'/g, "\\'");
  const closingIdx = content.lastIndexOf('};');
  if (closingIdx === -1) return false;
  const faqLine = `    'blog.article.${articleId}.faq': '${jsonStr}',\n`;
  content = content.slice(0, closingIdx) + faqLine + content.slice(closingIdx);
  writeFileSync(filePath, content, 'utf-8');
  return true;
}

// ── Language detection (same as job crawlers) ───────────────

function hasSourcePassthroughField(left, right) {
  return !!left && !!right
    && (isSourcePassthrough(right.q, left.q) || isSourcePassthrough(right.a, left.a));
}

/**
 * Check the unit that the writer actually translates: one FAQ pair.
 *
 * The old aggregate check let one Italian fallback pair hide among otherwise
 * translated pairs. Comparing each output field with its Italian source is
 * deterministic and catches a partial cascade passthrough even when the
 * language detector picks another language for a short FAQ. The previous
 * non-expected-locale check is retained, but applied to each pair instead of
 * the aggregate.
 */
export function wrongLocalePair(faqArray, expectedLocale, sourceFaq = null, sourceLang = 'it') {
  if (expectedLocale === sourceLang) return null;

  for (let index = 0; index < faqArray.length; index++) {
    const pair = faqArray[index];
    if (hasSourcePassthroughField(pair, sourceFaq?.[index])) {
      return { index, detected: sourceLang, via: 'verbatim' };
    }

    const text = `${pair.q} ${pair.a}`;
    if (text.length < 50) continue; // too short to detect
    const detected = detectLanguage(text, expectedLocale);
    if (detected !== expectedLocale) {
      return { index, detected, via: 'lingua' };
    }
  }

  return null;
}

// ── Translation (same cascade as job crawlers) ──────────────

async function translateFaqArray(faqArray, targetLang) {
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

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Scanning for FAQ locale issues...\n');

  const itDir = resolve(BODY_DIR, 'it');
  const itFiles = readdirSync(itDir).filter(f => f.endsWith('.ts'));
  const issues = [];

  for (const file of itFiles) {
    const articleId = basename(file, '.ts');
    const itPath = resolve(BODY_DIR, 'it', file);
    const itFaq = extractFaqFromFile(itPath);
    if (!itFaq || itFaq.length === 0) continue;

    for (const locale of ['en', 'de', 'fr']) {
      const localePath = resolve(BODY_DIR, locale, file);
      if (!existsSync(localePath)) continue;

      if (!hasFaqKey(localePath)) {
        issues.push({ articleId, file, locale, reason: 'missing', itFaq });
      } else {
        const localeFaq = extractFaqFromFile(localePath);
        if (localeFaq && wrongLocalePair(localeFaq, locale, itFaq)) {
          issues.push({ articleId, file, locale, reason: 'wrong_locale', itFaq });
        }
      }
    }
  }

  const byReason = {};
  for (const i of issues) byReason[i.reason] = (byReason[i.reason] || 0) + 1;
  console.log(`Found ${issues.length} FAQ locale issues:`);
  for (const [reason, count] of Object.entries(byReason)) console.log(`  ${reason}: ${count}`);

  if (DRY_RUN) {
    console.log('\n🏁 Dry run — first 50 issues:');
    for (const i of issues.slice(0, 50)) console.log(`  ${i.locale.toUpperCase()} ${i.reason}: ${i.articleId}`);
    if (issues.length > 50) console.log(`  ... and ${issues.length - 50} more`);
    return;
  }

  if (issues.length === 0) {
    console.log('\n✅ All FAQ locales are correct!');
    return;
  }

  const toProcess = issues.slice(0, LIMIT);
  console.log(`\nProcessing ${toProcess.length} issues...\n`);

  let fixed = 0, failed = 0;
  for (let idx = 0; idx < toProcess.length; idx++) {
    const issue = toProcess[idx];
    const label = `[${idx + 1}/${toProcess.length}] [${issue.locale.toUpperCase()}] ${issue.articleId}`;
    try {
      const translated = await translateFaqArray(issue.itFaq, issue.locale);
      if (!translated) {
        console.error(`${label} ❌ Translation produced no valid FAQ`);
        failed++;
        continue;
      }

      // Verify the translation per pair: the cascade falls back per pair.
      const wrong = wrongLocalePair(translated, issue.locale, issue.itFaq);
      if (wrong) {
        console.error(`${label} ❌ Translation still contains source-language FAQ `
          + `(pair ${wrong.index + 1}/${translated.length}: ${wrong.detected}, ${wrong.via})`);
        failed++;
        continue;
      }

      const localePath = resolve(BODY_DIR, issue.locale, issue.file);
      if (issue.reason === 'missing') {
        if (!insertFaqKey(localePath, issue.articleId, translated)) {
          console.error(`${label} ❌ Could not insert FAQ key`);
          failed++;
          continue;
        }
      } else {
        replaceFaqInFile(localePath, translated);
      }

      console.log(`${label} ✅ Fixed (${translated.length} pairs)`);
      fixed++;
    } catch (err) {
      console.error(`${label} ❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${fixed} fixed, ${failed} failed, ${issues.length - toProcess.length} remaining`);
  logCascadeSummary();
}

const shouldRunFaqLocaleScript = process.argv[1] && resolve(process.argv[1]) === __filename;
if (shouldRunFaqLocaleScript) main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
