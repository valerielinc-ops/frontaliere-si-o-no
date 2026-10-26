#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
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

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readdirSync,
} from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { freeTranslateWithRetry, isSourcePassthrough, logCascadeSummary } from './lib/free-translate.mjs';
import { detectLanguage } from './lib/detect-language.mjs';
import { decodeControlEscapesByField } from './lib/unescape-ts-string.mjs';
import { cleanFaqPairs } from './lib/prompt-placeholder-guard.mjs';

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

const FAQ_KEY_RX = /\.faq\\?['"]\s*:/;
const FAQ_LITERAL_RX = /\.faq\\?['"]\s*:\s*/;

let atomicWriteSequence = 0;

/** Write a locale module as one complete file, never through a truncating write. */
export function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${atomicWriteSequence++}`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function escapeForSingleQuoteTS(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Decode both FAQ literal generations that are present in the repository.
 *
 * New writes escape the outer TypeScript string symmetrically; older writes
 * escaped only apostrophes and therefore need the legacy second attempt. The
 * first decoder is field-aware so JSON escapes such as `\\n` stay available to
 * JSON.parse instead of becoming raw control characters too early.
 */
export function parseFaqLiteral(raw) {
  const decoders = [
    (value) => decodeControlEscapesByField(String(value ?? ''), 'faq'),
    (value) => String(value ?? '').replace(/\\'/g, "'"),
  ];
  for (const decode of decoders) {
    try {
      const parsed = JSON.parse(decode(raw));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try the compatible legacy representation */ }
  }
  return null;
}

/**
 * Locate and decode the FAQ literal without assuming that its outer quote is
 * an apostrophe.  The JSON inside a TypeScript string legitimately contains
 * many quote characters of its own, so a fixed `[^'\"]*` capture either
 * truncates a double-quoted value at `L'immigrazione` or stops at an inner
 * JSON quote.  Try each delimiter candidate and accept the first one whose
 * payload is a valid FAQ array; this also handles legacy escaped delimiters.
 */
function locateFaqLiteral(content) {
  if (typeof content !== 'string') return null;
  const keyMatch = FAQ_LITERAL_RX.exec(content);
  if (!keyMatch) return null;

  const valueOffset = keyMatch.index + keyMatch[0].length;
  const openerMatch = /^\s*(\\?)(['"])/.exec(content.slice(valueOffset));
  if (!openerMatch) return null;

  const openerIndex = valueOffset + openerMatch[0].length - 1;
  const quote = openerMatch[2];
  for (let index = openerIndex + 1; index < content.length; index++) {
    if (content[index] !== quote) continue;
    if (!/^\s*(?:[,}]|$)/.test(content.slice(index + 1))) continue;

    // Some generated fixtures retain an escape before the outer delimiter.
    // Exclude that one escape from the payload while preserving it in the
    // replacement boundary below.
    let payloadEnd = index;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= openerIndex + 1 && content[cursor] === '\\'; cursor--) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) payloadEnd -= 1;

    const parsed = parseFaqLiteral(content.slice(openerIndex + 1, payloadEnd));
    if (Array.isArray(parsed)) {
      return {
        parsed,
        openerIndex,
        closingIndex: payloadEnd,
        quote,
      };
    }
  }
  return null;
}

export function extractFaqFromContent(content) {
  return locateFaqLiteral(content)?.parsed ?? null;
}

/** Replace the payload while preserving the source's outer quote style. */
export function replaceFaqLiteral(content, serializedFaq) {
  const located = locateFaqLiteral(content);
  if (!located) return null;
  let payload = String(serializedFaq ?? '');
  if (located.quote === '"') {
    // Callers historically serialized for a single-quoted literal.  When the
    // existing locale uses double quotes, protect every JSON quote that is
    // not already protected by an odd run of backslashes.  Even runs are the
    // escaped JSON payload (after the TS backslash doubling) and still need
    // one more slash for the outer TypeScript delimiter.
    let escaped = '';
    let slashCount = 0;
    for (const character of payload) {
      if (character === '"' && slashCount % 2 === 0) escaped += '\\';
      escaped += character;
      slashCount = character === '\\' ? slashCount + 1 : 0;
    }
    payload = escaped;
  }
  return content.slice(0, located.openerIndex + 1)
    + payload
    + content.slice(located.closingIndex);
}

/** Keep the engine's readable FAQ floor and reject any dropped/placeholder pair. */
export function prepareFaqForWrite(faqArray, { minPairs = 2 } = {}) {
  const { pairs, dropped } = cleanFaqPairs(faqArray, { minPairs });
  if (!pairs || dropped.length > 0) return null;
  if (pairs.some((pair) => pair.q.length <= 10 || pair.a.length <= 20)) return null;
  return pairs;
}

function extractFaqFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  return extractFaqFromContent(readFileSync(filePath, 'utf-8'));
}

function hasFaqKey(filePath) {
  if (!existsSync(filePath)) return false;
  return FAQ_KEY_RX.test(readFileSync(filePath, 'utf-8'));
}

function replaceFaqInFile(filePath, newFaqArray) {
  const faqToWrite = prepareFaqForWrite(newFaqArray);
  if (!faqToWrite) return false;
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = escapeForSingleQuoteTS(JSON.stringify(faqToWrite));
  // Escape-aware regex + function replacer to avoid $-pattern issues
  const replaced = replaceFaqLiteral(content, jsonStr);
  if (!replaced || replaced === content || JSON.stringify(extractFaqFromContent(replaced)) !== JSON.stringify(faqToWrite)) {
    return false;
  }
  writeFileAtomic(filePath, replaced);
  return true;
}

function insertFaqKey(filePath, articleId, faqArray) {
  const faqToWrite = prepareFaqForWrite(faqArray);
  if (!faqToWrite) return false;
  let content = readFileSync(filePath, 'utf-8');
  const jsonStr = escapeForSingleQuoteTS(JSON.stringify(faqToWrite));
  const closingIdx = content.lastIndexOf('};');
  if (closingIdx === -1) return false;
  const faqLine = `    'blog.article.${articleId}.faq': '${jsonStr}',\n`;
  content = content.slice(0, closingIdx) + faqLine + content.slice(closingIdx);
  if (JSON.stringify(extractFaqFromContent(content)) !== JSON.stringify(faqToWrite)) return false;
  writeFileAtomic(filePath, content);
  return true;
}

// ── Language detection (same as job crawlers) ───────────────

function hasSourcePassthroughField(left, right) {
  return !!left && !!right
    && typeof left.q === 'string' && typeof left.a === 'string'
    && typeof right.q === 'string' && typeof right.a === 'string'
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
  if (!Array.isArray(faqArray)) return { index: 0, detected: 'unknown', via: 'shape' };
  if (Array.isArray(sourceFaq) && faqArray.length !== sourceFaq.length) {
    return { index: Math.min(faqArray.length, sourceFaq.length), detected: 'unknown', via: 'pair-count' };
  }

  for (let index = 0; index < faqArray.length; index++) {
    const pair = faqArray[index];
    if (!pair || typeof pair.q !== 'string' || typeof pair.a !== 'string') {
      return { index, detected: 'unknown', via: 'shape' };
    }
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
  if (!prepareFaqForWrite(faqArray)) return null;
  const results = [];
  for (let index = 0; index < faqArray.length; index++) {
    const pair = faqArray[index];
    const [translatedQ, translatedA] = await Promise.all([
      freeTranslateWithRetry({ text: pair.q, sourceLang: 'it', targetLang }),
      freeTranslateWithRetry({ text: pair.a, sourceLang: 'it', targetLang }),
    ]);
    if (!translatedQ || !translatedA || translatedQ.length <= 10 || translatedA.length <= 20) {
      console.error(`❌ ${targetLang.toUpperCase()} FAQ pair ${index + 1} has no usable translation; locale write skipped`);
      return null;
    }
    results.push({ q: translatedQ, a: translatedA });
  }
  const faqToWrite = prepareFaqForWrite(results);
  if (!faqToWrite) return null;
  const wrong = wrongLocalePair(faqToWrite, targetLang, faqArray);
  return wrong ? null : faqToWrite;
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
    const itHasFaq = hasFaqKey(itPath);
    const itFaq = extractFaqFromFile(itPath);
    if (!itFaq || itFaq.length === 0) {
      if (itHasFaq) console.error(`⚠️  ${articleId}: unreadable or incomplete Italian FAQ; locale repair skipped`);
      continue;
    }
    if (!prepareFaqForWrite(itFaq)) {
      console.error(`⚠️  ${articleId}: Italian FAQ fails the FAQPage write contract; locale repair skipped`);
      continue;
    }

    for (const locale of ['en', 'de', 'fr']) {
      const localePath = resolve(BODY_DIR, locale, file);
      if (!existsSync(localePath)) continue;

      if (!hasFaqKey(localePath)) {
        issues.push({ articleId, file, locale, reason: 'missing', itFaq });
      } else {
        const localeFaq = extractFaqFromFile(localePath);
        if (!localeFaq || !prepareFaqForWrite(localeFaq) || wrongLocalePair(localeFaq, locale, itFaq)) {
          issues.push({ articleId, file, locale, reason: localeFaq ? 'wrong_locale' : 'unreadable', itFaq });
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
        console.error(`${label} ❌ Translation produced no valid locale FAQ; file unchanged`);
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
        if (!replaceFaqInFile(localePath, translated)) {
          console.error(`${label} ❌ Could not replace FAQ key`);
          failed++;
          continue;
        }
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

const shouldRunFaqLocaleScript = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (shouldRunFaqLocaleScript) main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
