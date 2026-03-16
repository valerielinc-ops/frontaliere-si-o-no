#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const VF_KEY = 'vf-international-the-north-face-timberland';
const LOCALES = ['it', 'en', 'de', 'fr'];
const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };
const MAX_PER_RUN = Number(process.env.JOBS_VF_LOCALIZE_LIMIT || 5);
const ONLY_SLUG = String(process.env.JOBS_VF_LOCALIZE_SLUG || '').trim();

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanDescription(value = '') {
  return normalize(String(value || '').replace(/<[^>]+>/g, ' '));
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function detectLang(text = '', fallback = 'en') {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (/( das | und | bei uns | stellenbeschreibung | arbeitsort )/.test(t)) return 'de';
  if (/( the | with | requirements | apply now )/.test(t)) return 'en';
  if (/( il | la | con | requisiti | candidati )/.test(t)) return 'it';
  if (/( le | la | avec | exigences | poste )/.test(t)) return 'fr';
  return fallback;
}

function isVfJob(job = {}) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(String(job?.company || '')).toLowerCase();
  return key.includes(VF_KEY) || company.includes('vf international') || company.includes('the north face');
}

function chunkText(text = '', maxChars = 1800) {
  const clean = cleanDescription(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const out = [];
  let i = 0;
  while (i < clean.length) {
    out.push(clean.slice(i, i + maxChars));
    i += maxChars;
  }
  return out;
}

async function translateChunk({ text, sourceLang = 'auto', targetLang }) {
  const q = normalize(text);
  if (!q) return '';
  const query = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang || 'auto',
    tl: targetLang,
    dt: 't',
    q,
  });
  const endpoint = `${GOOGLE_TRANSLATE_ENDPOINT}?${query.toString()}`;
  try {
    const res = await fetch(endpoint, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return '';
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    const segments = Array.isArray(parsed?.[0]) ? parsed[0] : [];
    return cleanDescription(
      segments.map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('')
    );
  } catch {
    return '';
  }
}

async function translateText({ text, sourceLang = 'en', targetLang = 'it', minChars = 1 }) {
  const clean = cleanDescription(text);
  if (!clean) return '';
  if (sourceLang === targetLang) return clean;
  // Try DeepL first (higher quality than Google Translate)
  if (DEEPL_API_KEY) {
    const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
    const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
    if (tgtCode) {
      try {
        const body = new URLSearchParams();
        body.append('text', clean);
        if (srcCode) body.append('source_lang', srcCode);
        body.append('target_lang', tgtCode);
        const res = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: {
            'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          const data = await res.json();
          const deepl = cleanDescription(data?.translations?.[0]?.text || '');
          if (deepl && deepl.length >= minChars && deepl.toLowerCase() !== clean.toLowerCase()) {
            return deepl;
          }
        }
      } catch { /* fall through to Google Translate */ }
    }
  }
  // Fallback to Google Translate
  const chunks = chunkText(clean, 1800);
  if (chunks.length === 0) return '';
  const translated = [];
  for (const chunk of chunks) {
    let ok = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      ok = await translateChunk({ text: chunk, sourceLang, targetLang });
      if (ok) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
    if (!ok) return '';
    translated.push(ok);
  }
  const merged = cleanDescription(translated.join('\n\n'));
  if (merged.length < minChars) return '';
  if (merged.toLowerCase() === clean.toLowerCase()) return '';
  return merged;
}

async function localizeJob(job) {
  const out = { ...job };
  const sourceTitle = normalize(job?.title || '');
  const sourceDescription = cleanDescription(job?.description || '');
  const sourceLang = detectLang(`${sourceTitle} ${sourceDescription}`, 'en');

  out.titleByLocale = { ...(job?.titleByLocale || {}) };
  out.descriptionByLocale = { ...(job?.descriptionByLocale || {}) };

  for (const locale of LOCALES) {
    if (!out.titleByLocale[locale]) out.titleByLocale[locale] = sourceTitle;
    if (!out.descriptionByLocale[locale] && locale === sourceLang) {
      out.descriptionByLocale[locale] = sourceDescription;
    }
  }

  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const currentTitle = normalize(out.titleByLocale[locale] || '');
    if (!currentTitle || currentTitle.toLowerCase() === sourceTitle.toLowerCase()) {
      // eslint-disable-next-line no-await-in-loop
      const translatedTitle = await translateText({
        text: sourceTitle,
        sourceLang,
        targetLang: locale,
        minChars: 2,
      });
      if (translatedTitle) out.titleByLocale[locale] = translatedTitle;
    }

    const currentDesc = cleanDescription(out.descriptionByLocale[locale] || '');
    const mustTranslateDesc =
      !currentDesc ||
      currentDesc.length < 120 ||
      currentDesc.toLowerCase() === sourceDescription.toLowerCase();
    if (!mustTranslateDesc) continue;
    // eslint-disable-next-line no-await-in-loop
    const translatedDesc = await translateText({
      text: sourceDescription,
      sourceLang,
      targetLang: locale,
      minChars: 120,
    });
    if (translatedDesc) out.descriptionByLocale[locale] = translatedDesc;
  }

  return out;
}

function readJobs(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error(`${filePath} must contain an array`);
  return data;
}

function writeJobs(filePath, jobs) {
  fs.writeFileSync(filePath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
}

async function main() {
  const jobs = readJobs(DATA_JOBS);
  const vfCandidates = jobs.filter((job) => isVfJob(job));
  const selected = vfCandidates.filter((job) => {
    if (ONLY_SLUG && job?.slug !== ONLY_SLUG) return false;
    const source = cleanDescription(job?.description || '');
    if (!source || source.length < 120) return false;
    const sourceLang = detectLang(`${job?.title || ''} ${source}`, 'en');
    return LOCALES.some((locale) => {
      if (locale === sourceLang) return false;
      const localized = cleanDescription(job?.descriptionByLocale?.[locale] || '');
      return !localized || localized.length < 120 || localized.toLowerCase() === source.toLowerCase();
    });
  }).slice(0, Math.max(1, MAX_PER_RUN));

  if (selected.length === 0) {
    console.log('ℹ️ No VF jobs need localization in current selection.');
    return;
  }

  const bySlug = new Map(jobs.map((job) => [job.slug, job]));
  let done = 0;
  for (const job of selected) {
    done += 1;
    console.log(`🌐 [${done}/${selected.length}] Localizing: ${job.slug}`);
    // eslint-disable-next-line no-await-in-loop
    const localized = await localizeJob(job);
    bySlug.set(job.slug, localized);
  }

  const updated = jobs.map((job) => bySlug.get(job.slug) || job);
  writeJobs(DATA_JOBS, updated);
  writeJobs(PUBLIC_JOBS, updated);

  console.log(`✅ Localized VF jobs updated: ${selected.length}`);
}

main().catch((error) => {
  console.error(`❌ localize-vf-existing-jobs failed: ${error?.message || error}`);
  process.exit(1);
});
