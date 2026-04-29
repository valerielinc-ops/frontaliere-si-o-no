#!/usr/bin/env node
/**
 * refresh-weekly-employers-top-pairs.mjs — F5 link-graph utility
 *
 * Generates `data/weekly-employers-top-pairs.json`: the curated list of
 * (company × city) pairs that the SPA footer (`WeeklyEmployersTeaser`)
 * links to so the orphan sitemap closes.
 *
 * Why this exists:
 *   The footer used to hardcode 10 entries. 7 of them pointed at URLs
 *   that the build plugin never materialised — wrong slug ("Swisscom"
 *   instead of "Swisscom Sede Ticino"), wrong city (Allianz Suisse only
 *   qualifies in Bellinzona, footer claimed Lugano), or below the
 *   `MIN_JOBS_PER_COMPANY_IN_CITY = 3` gate. Every wrong link was a 404
 *   served as the SPA homepage shell.
 *
 *   This script enumerates the qualifying pairs from the same logic the
 *   build plugin uses (`build-plugins/weeklyEmployersPlugin.ts ::
 *   enumerateCompanyCityPairs`), picks the top entries with city
 *   diversity, and writes them to a JSON the footer imports statically.
 *   No more drift between footer hrefs and generated pages.
 *
 * Output shape:
 *   {
 *     "generatedAt": "2026-04-29T12:34:56.789Z",
 *     "totalQualifyingPairs": 47,
 *     "topPairs": [
 *       { "company": "EOC Ente Ospedaliero Cantonale",
 *         "companySlug": "eoc-ente-ospedaliero-cantonale",
 *         "city": "bellinzona",
 *         "active": 18 },
 *       ...
 *     ]
 *   }
 *
 * The JS logic here mirrors the canonical TS helpers in
 * `build-plugins/weeklyEmployersPlugin.ts` and `weeklyEmployersData.ts`.
 * `tests/integration/weekly-employers-top-pairs.test.ts` asserts the
 * mirrored output matches `enumerateCompanyCityPairs(jobs)` so drift
 * fails CI.
 *
 * Degradation: if `data/jobs.json` is missing or empty, writes an empty
 * `topPairs` array (the footer renders nothing in that case). Never
 * exits non-zero.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const JOBS_PATH = join(ROOT, 'data', 'jobs.json');
const OUT_PATH = join(ROOT, 'data', 'weekly-employers-top-pairs.json');

const COMPANY_CITY_LIST = [
  'lugano',
  'mendrisio',
  'chiasso',
  'stabio',
  'bellinzona',
  'locarno',
];

const CITY_DISPLAY = {
  lugano: 'Lugano',
  mendrisio: 'Mendrisio',
  chiasso: 'Chiasso',
  stabio: 'Stabio',
  bellinzona: 'Bellinzona',
  locarno: 'Locarno',
};

const MIN_JOBS_PER_COMPANY_IN_CITY = 3;

/** Maximum entries written to the JSON. The footer renders all of them. */
const TOP_N = 10;

/** Soft cap so the footer doesn't fill with the same city repeated. */
const MAX_PER_CITY = 2;

function wordCount(s) {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Mirror of `jobIsActive` in weeklyEmployersPlugin.ts:209. The footer
 * uses the IT-locale active-job count as its qualifying oracle (same as
 * `enumerateCompanyCityPairs`).
 */
function jobIsActive(job, locale) {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  if (nr && typeof nr === 'object' && nr[locale]) return false;
  const localeDesc = job.descriptionByLocale && job.descriptionByLocale[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return wordCount(desc) >= 50;
}

/** Mirror of `jobMatchesCity` in weeklyEmployersPlugin.ts:227. */
function jobMatchesCity(job, city) {
  const needle = CITY_DISPLAY[city].toLowerCase();
  const candidates = [job.addressLocality, job.location]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .filter(Boolean);
  return candidates.some((c) => c.includes(needle));
}

/** Mirror of `normEmployerKey` in weeklyEmployersPlugin.ts:240. */
function normEmployerKey(company, companyKey) {
  const raw = (companyKey || company || '').trim().toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Mirror of `canonicalCompanySlug` in weeklyEmployersData.ts:363. */
function canonicalCompanySlug(company, companyKey) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const keyNorm = norm(companyKey || '');
  const nameNorm = norm(company);
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  return norm(company).replace(/\s+/g, '-');
}

/**
 * Enumerate (city × employer) pairs with ≥3 active IT-locale jobs.
 * Returned shape matches the canonical `enumerateCompanyCityPairs` in
 * `weeklyEmployersPlugin.ts:832` minus internal `employerKey` field.
 */
function enumerateQualifyingPairs(jobs) {
  const pairs = [];
  for (const city of COMPANY_CITY_LIST) {
    const counts = new Map();
    for (const job of jobs) {
      if (!jobIsActive(job, 'it')) continue;
      if (!jobMatchesCity(job, city)) continue;
      const company = String(job.company || '').trim();
      if (!company) continue;
      const key = normEmployerKey(company, job.companyKey);
      if (!key) continue;
      const rec = counts.get(key);
      if (rec) rec.active++;
      else counts.set(key, { employer: company, employerKey: key, active: 1 });
    }
    for (const [, rec] of counts.entries()) {
      if (rec.active < MIN_JOBS_PER_COMPANY_IN_CITY) continue;
      const companySlug = canonicalCompanySlug(rec.employer, rec.employerKey);
      if (!companySlug || !/^[a-z0-9][a-z0-9-]*$/.test(companySlug)) continue;
      pairs.push({
        company: rec.employer,
        companySlug,
        city,
        active: rec.active,
      });
    }
  }
  return pairs;
}

/**
 * Pick the top-N pairs with city diversity:
 *   - Sort by active DESC (highest weekly volume first)
 *   - Cap each city at MAX_PER_CITY entries
 *   - Tie-breaker: companySlug ASC (deterministic)
 */
function pickTopPairs(allPairs) {
  const sorted = [...allPairs].sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active;
    if (a.city !== b.city) return a.city < b.city ? -1 : 1;
    return a.companySlug < b.companySlug ? -1 : 1;
  });
  const perCity = new Map();
  const picked = [];
  for (const pair of sorted) {
    if (picked.length >= TOP_N) break;
    const used = perCity.get(pair.city) || 0;
    if (used >= MAX_PER_CITY) continue;
    picked.push(pair);
    perCity.set(pair.city, used + 1);
  }
  // Backfill if cap left us short (rare — only when a few cities
  // dominate). Relax the per-city cap until TOP_N is reached.
  if (picked.length < TOP_N) {
    const remaining = sorted.filter((p) => !picked.includes(p));
    for (const pair of remaining) {
      if (picked.length >= TOP_N) break;
      picked.push(pair);
    }
  }
  return picked;
}

function loadJobs() {
  if (!existsSync(JOBS_PATH)) {
    console.warn(`[refresh-weekly-employers-top-pairs] ${JOBS_PATH} missing — emitting empty list.`);
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(JOBS_PATH, 'utf-8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.jobs)) return raw.jobs;
    return [];
  } catch (err) {
    console.warn(`[refresh-weekly-employers-top-pairs] failed to read jobs.json: ${err?.message || err}`);
    return [];
  }
}

function main() {
  const jobs = loadJobs();
  const allPairs = enumerateQualifyingPairs(jobs);
  const topPairs = pickTopPairs(allPairs);

  const payload = {
    generatedAt: new Date().toISOString(),
    totalQualifyingPairs: allPairs.length,
    topPairs,
  };

  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  console.log(
    `[refresh-weekly-employers-top-pairs] wrote ${OUT_PATH} — ${topPairs.length} pairs (of ${allPairs.length} qualifying).`,
  );
  for (const p of topPairs) {
    console.log(`  - ${p.company} (${p.companySlug}) × ${p.city} → ${p.active} active`);
  }
}

main();
