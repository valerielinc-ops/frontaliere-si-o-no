#!/usr/bin/env node
/**
 * mine-search-location-gaps.mjs — issue #4301
 *
 * Mines on-site `search` events (PostHog, properties.search_term) for
 * PROFESSION × TI-CITY combinations with real search demand that have no
 * dedicated landing page yet. Every profession already has a canton-wide
 * page (`/lavoro-ticino-{profession}/`, build-plugins/professionCantonLandings.ts)
 * and every TI city already has a job hub (`/lavoro-a-{city}/`,
 * build-plugins/cityJobsHub.ts) — but the CROSS of the two (e.g.
 * "autista lugano", a real on-site search) has no page: neither family
 * covers it. This script is the evidence artifact proving that gap and
 * ranking candidates for build-plugins/professionCityLandings.ts (added in
 * this same PR).
 *
 * Reuses (AGENTS.md non-negotiable #6 — no forked taxonomy/regex/query):
 *  - PROFESSION_TAXONOMY / matchProfession / classifySearchTerm /
 *    LOCALITY_TOKENS from scripts/lib/profession-taxonomy.mjs (same
 *    taxonomy scripts/profession-keyword-opportunities.mjs uses weekly).
 *  - fetchOnsiteSearchTerms from scripts/lib/posthog-search-terms.mjs
 *    (same HogQL query + auth as the weekly script).
 *  - extractTsStringArray from scripts/lib/ts-array-extract.mjs, to read
 *    the canonical PROFESSION_IDS / CANTON_ONLY_PROFESSION_IDS catalog
 *    straight from build-plugins/professionLandingsData.ts (never hand-copy
 *    the 24-id list a third time).
 *  - TI_LEGACY_CITY_HUB_KEYS / CITY_HUB_DISPLAY_NAME / jobMatchesCity from
 *    build-plugins/cityJobsHub.ts, resolveJobCanton from
 *    build-plugins/shared/cantonSection.ts — the SAME city-membership +
 *    canton-resolution logic the new professionCityLandings.ts plugin uses
 *    for its own live-inventory floor gate, so this evidence file's
 *    "hasLiveJobs" column agrees with what the plugin will actually render.
 *
 * This script imports .ts modules directly — run it with `tsx`, not plain
 * `node` (precedent: scripts/measure-l2-distribution.mjs).
 *
 * Auth: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID / POSTHOG_HOST via
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)"
 *
 * Output: data/search-location-gaps.json — capped ranked candidate list
 * (professionCityGaps, top 40, min 20) + topRawSearchTerms (top 15, feeds
 * the job-board quick-search chips, components/community/QuickSearchChips.tsx).
 *
 * Usage:
 *   npx tsx scripts/mine-search-location-gaps.mjs [--window-days=90] [--skip-posthog]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySearchTerm, matchProfession } from './lib/profession-taxonomy.mjs';
import { fetchOnsiteSearchTerms } from './lib/posthog-search-terms.mjs';
import { extractTsStringArray } from './lib/ts-array-extract.mjs';
// @ts-ignore — tsx resolves these fine at runtime; this file is itself a
// plain-JS .mjs script (no local tsconfig project), so the TS import
// specifiers are not type-checked here (they ARE inside the real vite/tsc
// build graph via build-plugins' own imports).
import { TI_LEGACY_CITY_HUB_KEYS, CITY_HUB_DISPLAY_NAME, jobMatchesCity } from '../build-plugins/cityJobsHub.ts';
import { resolveJobCanton } from '../build-plugins/shared/cantonSection.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function flag(name) { return process.argv.includes(`--${name}`); }
function opt(name, fallback) {
  const pfx = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(pfx));
  return found ? found.slice(pfx.length) : fallback;
}

const SKIP_POSTHOG = flag('skip-posthog');
const WINDOW_DAYS = Math.max(1, Number(opt('window-days', '90')) || 90);
const OUTPUT_PATH = path.join(ROOT, 'data/search-location-gaps.json');
const JOBS_PATH = path.join(ROOT, 'data/jobs.json');

const PROFESSION_LANDINGS_PATH = path.join(ROOT, 'build-plugins/professionLandingsData.ts');

function loadAnyProfessionIds() {
  const core = extractTsStringArray(PROFESSION_LANDINGS_PATH, 'PROFESSION_IDS');
  const cantonOnly = extractTsStringArray(PROFESSION_LANDINGS_PATH, 'CANTON_ONLY_PROFESSION_IDS');
  return new Set([...core, ...cantonOnly]);
}

/** TI-city display name → the LOCALITY_TOKENS-normalized key used by classifySearchTerm. */
const CITY_KEYS = TI_LEGACY_CITY_HUB_KEYS; // ['lugano','mendrisio','bellinzona','locarno','chiasso']

function loadJobs() {
  try {
    const raw = fs.readFileSync(JOBS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(jobs)) return [];
    console.error(`[jobs] data/jobs.json: ${jobs.length} jobs`);
    return jobs;
  } catch {
    console.error('[jobs] data/jobs.json unreadable — run node scripts/assemble-jobs-dataset.mjs first. Inventory cross-check will read 0 for every combo.');
    return [];
  }
}

async function main() {
  const anyProfessionIds = loadAnyProfessionIds();

  // ─── Mine on-site search terms ──────────────────────────────────────
  let onsiteTerms = [];
  let onsiteEventsTotal = 0;
  if (SKIP_POSTHOG) {
    console.error('[posthog] --skip-posthog: search mining disabled, output will be inventory-only');
  } else {
    onsiteTerms = await fetchOnsiteSearchTerms({ windowDays: WINDOW_DAYS, limit: 2000 });
    onsiteEventsTotal = onsiteTerms.reduce((s, t) => s + t.count, 0);
    console.error(`[posthog] ${onsiteTerms.length} unique terms, ${onsiteEventsTotal} events (${WINDOW_DAYS}d window)`);
  }

  // ─── Classify each term, cross-tab profession x TI-city ─────────────
  const comboCounts = new Map(); // "profession|city" -> { count, examples: Set }
  const rawTermCounts = new Map(); // normalized raw term -> { term, count } (top-N chips source)
  for (const { term, count } of onsiteTerms) {
    const clean = String(term || '').trim();
    if (!clean || clean.length < 2) continue;
    const rawKey = clean.toLowerCase();
    const prevRaw = rawTermCounts.get(rawKey);
    if (prevRaw) prevRaw.count += count;
    else rawTermCounts.set(rawKey, { term: clean, count });

    const { professionId, localityTokens } = classifySearchTerm(clean);
    if (!professionId || !anyProfessionIds.has(professionId)) continue;
    const city = localityTokens.find((t) => CITY_KEYS.includes(t));
    if (!city) continue; // profession-only or non-TI-city locality — already covered by canton family
    const key = `${professionId}|${city}`;
    const entry = comboCounts.get(key) || { professionId, city, count: 0, examples: [] };
    entry.count += count;
    if (entry.examples.length < 3) entry.examples.push(clean);
    comboCounts.set(key, entry);
  }

  // ─── Cross-check live job inventory (same resolveJobCanton +
  // jobMatchesCity + matchProfession the professionCityLandings.ts floor
  // gate will use) ──────────────────────────────────────────────────────
  const jobs = loadJobs();
  const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
  const jobCountByCombo = new Map(); // "profession|city" -> count
  for (const job of tiJobs) {
    const id = matchProfession(String(job.title || ''));
    if (!id || !anyProfessionIds.has(id)) continue;
    for (const city of CITY_KEYS) {
      if (!jobMatchesCity(job, city)) continue;
      const key = `${id}|${city}`;
      jobCountByCombo.set(key, (jobCountByCombo.get(key) || 0) + 1);
    }
  }
  console.error(`[inventory] ${tiJobs.length} TI jobs scanned across ${CITY_KEYS.length} cities`);

  // ─── Rank: mined-demand combos first (desc by search count), then
  // backfill with inventory-only combos (desc by job count) so the file
  // always carries >=20 ranked candidates even in a thin mining window ───
  const MIN_JOBS_FLOOR = 3; // mirrors professionCantonLandings.ts's MIN_JOBS
  const minedRanked = [...comboCounts.values()]
    .map((c) => ({
      professionId: c.professionId,
      city: c.city,
      cityDisplay: CITY_HUB_DISPLAY_NAME[c.city] || c.city,
      searchCount: c.count,
      exampleQueries: c.examples,
      liveJobCount: jobCountByCombo.get(`${c.professionId}|${c.city}`) || 0,
    }))
    .sort((a, b) => b.searchCount - a.searchCount);

  const minedKeys = new Set(minedRanked.map((r) => `${r.professionId}|${r.city}`));
  const inventoryBackfill = [...jobCountByCombo.entries()]
    .filter(([key]) => !minedKeys.has(key))
    .map(([key, liveJobCount]) => {
      const [professionId, city] = key.split('|');
      return {
        professionId,
        city,
        cityDisplay: CITY_HUB_DISPLAY_NAME[city] || city,
        searchCount: 0,
        exampleQueries: [],
        liveJobCount,
      };
    })
    .filter((r) => r.liveJobCount >= MIN_JOBS_FLOOR)
    .sort((a, b) => b.liveJobCount - a.liveJobCount);

  let ranked = minedRanked;
  if (ranked.length < 20) {
    ranked = [...ranked, ...inventoryBackfill].slice(0, Math.max(20, ranked.length));
  }
  ranked = ranked.slice(0, 40).map((r, i) => ({
    rank: i + 1,
    ...r,
    meetsInventoryFloor: r.liveJobCount >= MIN_JOBS_FLOOR,
  }));

  const topRawSearchTerms = [...rawTermCounts.values()]
    .filter((t) => t.term.length >= 3 && t.term.length <= 40)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((t, i) => ({ rank: i + 1, term: t.term, count: t.count }));

  const output = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    posthogEnabled: !SKIP_POSTHOG,
    onsiteEventsTotal,
    uniqueOnsiteTerms: onsiteTerms.length,
    inventoryFloor: MIN_JOBS_FLOOR,
    professionCityGaps: ranked,
    topRawSearchTerms,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.error(`[output] wrote ${ranked.length} profession x city candidates + ${topRawSearchTerms.length} raw terms to ${path.relative(ROOT, OUTPUT_PATH)}`);

  console.log('\nTop profession x city gaps:');
  console.log('rank | professionId | city | search(90d) | liveJobs | floor-met | examples');
  for (const r of ranked.slice(0, 20)) {
    console.log(`${String(r.rank).padStart(4)} | ${r.professionId.padEnd(16)} | ${r.city.padEnd(11)} | ${String(r.searchCount).padStart(6)} | ${String(r.liveJobCount).padStart(5)} | ${r.meetsInventoryFloor ? 'yes' : 'no '} | ${r.exampleQueries.join(', ')}`);
  }
  console.log('\nTop raw search terms (chip candidates):');
  for (const t of topRawSearchTerms.slice(0, 10)) {
    console.log(`${String(t.rank).padStart(4)} | ${String(t.count).padStart(5)} | ${t.term}`);
  }
}

main().catch((err) => {
  console.error('[mine-search-location-gaps] FAILED:', err.message);
  process.exit(1);
});
