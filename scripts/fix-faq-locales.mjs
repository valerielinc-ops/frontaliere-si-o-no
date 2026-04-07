#!/usr/bin/env node
/**
 * fix-faq-locales.mjs
 * 
 * Scans EN/DE/FR blog body files for FAQ keys that are still in Italian.
 * Re-translates them using the free translation cascade (DeepL, Azure,
 * MyMemory, Lingva, etc.) — same pipeline as job crawlers.
 * Also fills in missing FAQ for locales that have the IT version.
 *
 * Usage:
 *   node scripts/fix-faq-locales.mjs [--dry-run] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';

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
  return hits >= 3;
}

function extractFaqFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const faqMatch = content.match(/\.faq['']\s*:\s*[''`](.+?)[''`]\s*[,}]/s);
  if (!faqMatch) return null;
  try {
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

// ── Translation using free cascade (same as job crawlers) ───

async function translateFaqPair(pair, targetLang) {
  const [translatedQ, translatedA] = await Promise.all([
    freeTranslateWithRetry({ text: pair.q, sourceLang: 'it', targetLang }),
    freeTranslateWithRetry({ text: pair.a, sourceLang: 'it', targetLang }),
  ]);

  if (!translatedQ || !translatedA) return null;
  return { q: translatedQ, a: translatedA };
}

async function translateFaqArray(faqArray, targetLang) {
  const results = [];
  for (const pair of faqArray) {
    try {
      const translated = await translateFaqPair(pair, targetLang);
      if (translated && translated.q.length > 10 && translated.a.length > 20) {
        results.push(translated);
      } else {
        // Keep Italian as fallback for this pair
        results.push(pair);
      }
    } catch (err) {
      console.error(`  Translation error: ${err.message}`);
      results.push(pair); // Keep Italian for this pair
    }
  }
  return results.length > 0 ? results : null;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Scanning for FAQ locale issues...\n');

  const itFiles = readdirSync(resolve(BODY_DIR, 'it')).filter(f => f.endsWith('.ts'));
  const issues = [];

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

      const localePath = resolve(BODY_DIR, issue.locale, issue.file);
      if (issue.reason === 'missing') {
        let content = readFileSync(localePath, 'utf-8');
        const jsonStr = JSON.stringify(translated).replace(/'/g, "\\'");
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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
