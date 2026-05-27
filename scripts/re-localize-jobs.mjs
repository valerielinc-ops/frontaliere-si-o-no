#!/usr/bin/env node
/**
 * Re-localize jobs whose translated descriptions are truncated compared to source.
 *
 * Identifies jobs where `descriptionByLocale[locale]` is significantly shorter
 * than the source `description`, and re-translates using the centralized AI module
 * to produce FULL translations without summarization.
 *
 * Usage:
 *   node scripts/re-localize-jobs.mjs                   # re-localize all truncated jobs
 *   RELOCALIZE_COMPANY=vf node scripts/re-localize-jobs.mjs  # only VF jobs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, flushScores } from './lib/ai-models.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env and .env.local so API keys are available
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* file may not exist */ }
}
loadEnvFile(path.resolve(ROOT, '.env'));
loadEnvFile(path.resolve(ROOT, '.env.local'));
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

// A localized description is "truncated" if it is less than this fraction of the source
const TRUNCATION_RATIO = 0.40;
// Minimum source description length to bother re-localizing
const MIN_SOURCE_LEN = 300;
// Optional filter: only re-localize jobs matching this company substring
const COMPANY_FILTER = (process.env.RELOCALIZE_COMPANY || '').toLowerCase().trim();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8'); }

function normalizeSpace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function detectLang(text) {
  return detectLanguage(text, 'en');
}

function cleanDescription(desc) {
  return normalizeSpace(
    String(desc || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
      .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
  );
}

/**
 * Translate text via DeepL free API. Returns '' on failure.
 */
async function translateWithDeepL(text, sourceLang, targetLang) {
  if (!DEEPL_API_KEY) return '';
  const clean = normalizeSpace(text || '');
  if (!clean || sourceLang === targetLang) return '';

  const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
  const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
  if (!tgtCode) return '';

  const body = new URLSearchParams();
  body.append('text', clean);
  if (srcCode) body.append('source_lang', srcCode);
  body.append('target_lang', tgtCode);

  try {
    const res = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = data?.translations?.[0]?.text || '';
    if (!translated || translated.toLowerCase() === clean.toLowerCase()) return '';
    return cleanDescription(translated);
  } catch {
    return '';
  }
}

async function translateDescription(description, locale, sourceLang) {
  const clean = cleanDescription(description);
  if (!clean || clean.length < 120) return '';
  if (locale === sourceLang) return clean;

  // Try DeepL first (fast, high quality, saves LLM tokens)
  const deepl = await translateWithDeepL(clean, sourceLang, locale);
  if (deepl && deepl.length >= 120) return deepl;

  // Fallback to LLM
  const prompt = [
    `Translate this job description from ${sourceLang} to ${locale}.`,
    'Rules:',
    '- Keep company names, product names, acronyms unchanged.',
    '- Do not invent or add new facts.',
    '- Preserve the COMPLETE content — translate every paragraph, section, and detail without summarizing or shortening.',
    '- Keep clear paragraphs and preserve meaning.',
    '- Return only translated text, no markdown, no quotes.',
    '',
    clean,
  ].join('\n');

  const text = await callLLM([{ role: 'user', content: prompt }], {
    temperature: 0.1,
    maxTokens: 8192,
    jsonMode: false,
  });
  const translated = cleanDescription(String(text || ''));
  if (translated.length >= 120 && translated.toLowerCase() !== clean.toLowerCase()) {
    return translated;
  }
  return '';
}

async function main() {
  const jobs = readJson(DATA_JOBS);
  console.log(`Loaded ${jobs.length} jobs from data/jobs.json`);

  // Find jobs with truncated localized descriptions
  const toRelocalize = [];
  for (const job of jobs) {
    const srcDesc = cleanDescription(job.description || '');
    if (srcDesc.length < MIN_SOURCE_LEN) continue;
    if (COMPANY_FILTER && !(job.company || '').toLowerCase().includes(COMPANY_FILTER)) continue;

    const sourceLang = detectLang(srcDesc);
    const truncatedLocales = [];
    for (const locale of LOCALES) {
      const localized = cleanDescription(job.descriptionByLocale?.[locale] || '');
      // Mark as truncated if: missing, too short, or significantly shorter than source
      if (!localized || localized.length < 120 || localized.length < srcDesc.length * TRUNCATION_RATIO) {
        if (locale !== sourceLang) {
          truncatedLocales.push(locale);
        }
      }
    }
    // Also check if source locale is missing from descriptionByLocale
    if (!job.descriptionByLocale?.[sourceLang] || cleanDescription(job.descriptionByLocale[sourceLang]).length < srcDesc.length * TRUNCATION_RATIO) {
      truncatedLocales.push(sourceLang);
    }
    if (truncatedLocales.length > 0) {
      toRelocalize.push({ job, srcDesc, sourceLang, truncatedLocales: [...new Set(truncatedLocales)] });
    }
  }

  console.log(`Found ${toRelocalize.length} jobs with truncated localized descriptions`);
  if (toRelocalize.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const entry of toRelocalize) {
    console.log(`\n--- ${entry.job.title} (${entry.job.company}) ---`);
    console.log(`  Source (${entry.sourceLang}): ${entry.srcDesc.length} chars`);
    console.log(`  Truncated locales: ${entry.truncatedLocales.join(', ')}`);
  }

  let updated = 0;
  let failed = 0;

  for (const entry of toRelocalize) {
    const { job, srcDesc, sourceLang, truncatedLocales } = entry;
    if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') {
      job.descriptionByLocale = {};
    }

    for (const locale of truncatedLocales) {
      const before = cleanDescription(job.descriptionByLocale[locale] || '').length;
      try {
        if (locale === sourceLang) {
          // Just copy the full source description
          job.descriptionByLocale[locale] = srcDesc;
          console.log(`  [${locale}] Copied source: ${before} → ${srcDesc.length} chars`);
          updated++;
        } else {
          console.log(`  [${locale}] Translating...`);
          const translated = await translateDescription(srcDesc, locale, sourceLang);
          if (translated && translated.length > before) {
            job.descriptionByLocale[locale] = translated;
            console.log(`  [${locale}] Done: ${before} → ${translated.length} chars`);
            updated++;
          } else {
            console.log(`  [${locale}] Translation too short or failed (${translated.length} chars), keeping existing`);
            failed++;
          }
        }
      } catch (err) {
        console.error(`  [${locale}] ERROR: ${err.message}`);
        failed++;
      }
      // Small delay between AI calls to avoid rate limits
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // Write back
  writeJson(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_JOBS)) {
    writeJson(PUBLIC_JOBS, jobs);
  }

  console.log(`\n=== Done ===`);
  console.log(`Updated: ${updated} locale descriptions`);
  console.log(`Failed: ${failed}`);
  console.log(`Saved to data/jobs.json and public/data/jobs.json`);

  // Flush persistent scores to Firestore before exit
  await flushScores();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
