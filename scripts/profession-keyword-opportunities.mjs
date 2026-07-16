#!/usr/bin/env node
/**
 * profession-keyword-opportunities.mjs — weekly "professioni da attaccare"
 * gap ranking (#3396). Feeder for generate-keyword-pages-config.mjs (#3393).
 *
 * Demand signals:
 *   A. on-site search — PostHog `search` events, `search_term` property,
 *      rolling window (default 60 days). Pure intent, unfiltered by Google.
 *   B. crawler job titles — data/jobs.json when present, otherwise the
 *      committed data/jobs/by-crawler/*.json shards. Real market supply.
 *   C. (optional, free) GSC impressions/clicks from the committed
 *      data/gsc-orphan-queries.json.
 *
 * Coverage subtracted (a profession we already serve is not a gap):
 *   - PROFESSION_IDS in build-plugins/professionLandingsData.ts
 *   - nursing hubs in build-plugins/nursingLandingsData.ts
 *   - slugs + filterKeywords in data/keyword-pages-config.json
 *
 * Output:
 *   - data/profession-keyword-opportunities.json (committed weekly by
 *     .github/workflows/profession-keyword-opportunities.yml)
 *   - markdown report on stdout (workflow pipes it into the dedup issue)
 *
 * Zero-Claude by contract: HogQL + parsing + regex only (AGENTS.md quota
 * frugality). Deterministic given the same inputs.
 *
 * Usage:
 *   node scripts/profession-keyword-opportunities.mjs [--skip-posthog]
 *     [--window-days=60] [--markdown-out=path.md]
 *
 * Auth (signal A only): POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID /
 * POSTHOG_HOST via scripts/load-rc-env.mjs. --skip-posthog (or missing
 * creds with SKIP allowed) degrades to signals B+C only.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  PROFESSION_TAXONOMY,
  classifySearchTerm,
  matchProfession,
  normalizeText,
  stemToken,
} from './lib/profession-taxonomy.mjs';
import { extractTsStringArray } from './lib/ts-array-extract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data/jobs.json');
const BY_CRAWLER_DIR = path.join(ROOT, 'data/jobs/by-crawler');
const GSC_PATH = path.join(ROOT, 'data/gsc-orphan-queries.json');
const KEYWORD_CONFIG_PATH = path.join(ROOT, 'data/keyword-pages-config.json');
const PROFESSION_LANDINGS_PATH = path.join(ROOT, 'build-plugins/professionLandingsData.ts');
const NURSING_LANDINGS_PATH = path.join(ROOT, 'build-plugins/nursingLandingsData.ts');
const OUTPUT_PATH = path.join(ROOT, 'data/profession-keyword-opportunities.json');

// Ranking knobs — documented, deterministic. Double validation (demand AND
// supply) is what makes a landing convert right away, so it dominates the
// sort; the score only orders within the same validation bucket.
const DOUBLE_VALIDATED_MIN_ONSITE = 10; // searches in window
const DOUBLE_VALIDATED_MIN_JOBS = 3; // live matching job ads (mirrors jobsSeoPagesPlugin's ≥3 gate)
const JOB_COUNT_SCORE_CAP = 150; // huge generic supply must not drown intent
const MAX_UNMAPPED_REPORTED = 30;

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const SKIP_POSTHOG = flag('skip-posthog');
const WINDOW_DAYS = Math.max(1, Number(opt('window-days', '60')) || 60);
const MARKDOWN_OUT = opt('markdown-out', '');

// ── Signal A: on-site search (PostHog HogQL) ─────────────────────────────

async function fetchOnsiteSearchTerms() {
  if (SKIP_POSTHOG) {
    console.error('[signal A] --skip-posthog: on-site search signal disabled');
    return null;
  }
  const HOST = process.env.POSTHOG_HOST || 'https://eu.posthog.com';
  const PID = process.env.POSTHOG_PROJECT_ID;
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!KEY || !PID) {
    throw new Error(
      'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID missing — load via scripts/load-rc-env.mjs or pass --skip-posthog',
    );
  }
  const query = `
    SELECT lower(toString(properties.search_term)) AS term, count() AS n
    FROM events
    WHERE event = 'search'
      AND notEmpty(toString(properties.search_term))
      AND timestamp > now() - INTERVAL ${WINDOW_DAYS} DAY
    GROUP BY term
    ORDER BY n DESC
    LIMIT 1000
  `.trim();
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const json = await r.json();
  return (json.results || []).map(([term, n]) => ({ term: String(term), count: Number(n) || 0 }));
}

// ── Signal B: crawler job titles ─────────────────────────────────────────

function loadJobs() {
  if (fs.existsSync(JOBS_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
      if (Array.isArray(jobs) && jobs.length > 0) {
        console.error(`[signal B] data/jobs.json: ${jobs.length} jobs`);
        return jobs;
      }
    } catch {
      console.error('[signal B] data/jobs.json unreadable, falling back to by-crawler shards');
    }
  }
  // by-crawler shards are the committed source of truth when the assembled
  // dataset is absent (it is generated in CI, not committed).
  const seen = new Set();
  const jobs = [];
  let shards = 0;
  for (const file of fs.readdirSync(BY_CRAWLER_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try {
      const raw = fs.readFileSync(path.join(BY_CRAWLER_DIR, file), 'utf-8');
      if (!raw.trim()) continue;
      parsed = JSON.parse(raw);
    } catch {
      continue; // a single bad shard must not sink the weekly run
    }
    const shardJobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
    if (!Array.isArray(shardJobs)) continue;
    shards++;
    for (const job of shardJobs) {
      if (!job || typeof job.title !== 'string') continue;
      const key = typeof job.url === 'string' && job.url ? job.url : `${file}:${job.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  console.error(`[signal B] by-crawler shards: ${jobs.length} jobs from ${shards} shards`);
  return jobs;
}

// ── Signal C: GSC impressions (committed orphan queries) ─────────────────

function loadGscByProfession() {
  const byProfession = new Map();
  if (!fs.existsSync(GSC_PATH)) return byProfession;
  let gscData;
  try {
    gscData = JSON.parse(fs.readFileSync(GSC_PATH, 'utf-8'));
  } catch {
    return byProfession;
  }
  for (const queries of Object.values(gscData)) {
    if (!Array.isArray(queries)) continue;
    for (const q of queries) {
      if (!q || typeof q.query !== 'string' || !q.query.trim()) continue;
      const id = matchProfession(q.query);
      if (!id) continue;
      const agg = byProfession.get(id) || { impressions: 0, clicks: 0 };
      agg.impressions += Number(q.impressions) || 0;
      agg.clicks += Number(q.clicks) || 0;
      byProfession.set(id, agg);
    }
  }
  return byProfession;
}

// ── Coverage ─────────────────────────────────────────────────────────────
//
// extractTsStringArray lives in scripts/lib/ts-array-extract.mjs — shared
// with scripts/mine-search-location-gaps.mjs (issue #4301) so the two
// scripts don't fork the same TS-array-literal regex (AGENTS.md #6).

/**
 * Build the covered-profession set. A taxonomy entry is covered when a
 * dedicated landing (profession/nursing) or an existing keyword page
 * already targets it.
 */
function buildCoverage() {
  const covered = new Map(); // professionId -> reason

  for (const id of extractTsStringArray(PROFESSION_LANDINGS_PATH, 'PROFESSION_IDS')) {
    const matched = matchProfession(id) || (PROFESSION_TAXONOMY.some((e) => e.id === id) ? id : null);
    if (matched) covered.set(matched, `profession landing /lavoro-ticino-${id}/`);
  }

  // Canton-only professions (#3657): shipped ONLY as per-canton landings
  // (build-plugins/professionCantonLandings.ts), no Ticino-bespoke page, so
  // they never surface via the PROFESSION_IDS loop above. Without this, the
  // weekly report would re-flag them as "opportunities" forever even though
  // they're already live (every non-TI canton × these 5 ids × 4 locales).
  for (const id of extractTsStringArray(PROFESSION_LANDINGS_PATH, 'CANTON_ONLY_PROFESSION_IDS')) {
    const matched = matchProfession(id) || (PROFESSION_TAXONOMY.some((e) => e.id === id) ? id : null);
    if (matched) covered.set(matched, `canton profession landing /lavoro-{canton}-${id}/`);
  }

  const NURSING_TO_PROFESSION = { nurses: 'infermiere', oss: 'oss' }; // healthcare-ticino is a sector hub, not a profession
  for (const id of extractTsStringArray(NURSING_LANDINGS_PATH, 'NURSING_LANDING_IDS')) {
    const mapped = NURSING_TO_PROFESSION[id];
    if (mapped && !covered.has(mapped)) covered.set(mapped, `nursing landing (${id})`);
  }

  if (fs.existsSync(KEYWORD_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
      for (const page of config.pages || []) {
        const surface = [page.query || '', ...(page.filterKeywords || [])].join(' ');
        const id = matchProfession(surface);
        if (id && !covered.has(id)) covered.set(id, `keyword page /${page.slug}/`);
      }
    } catch {
      console.error('[coverage] keyword-pages-config.json unreadable — skipping that layer');
    }
  }

  return covered;
}

// ── Main ─────────────────────────────────────────────────────────────────

const onsiteTerms = await fetchOnsiteSearchTerms();
const jobs = loadJobs();
const gscByProfession = loadGscByProfession();
const covered = buildCoverage();

// Aggregate signal A per profession + collect locality/unmapped buckets.
const onsiteByProfession = new Map();
const localityTermCounts = new Map();
const unmappedTermCounts = new Map();
let onsiteEventsTotal = 0;
for (const { term, count } of onsiteTerms || []) {
  onsiteEventsTotal += count;
  const { professionId, isPureLocality } = classifySearchTerm(term);
  if (professionId) {
    onsiteByProfession.set(professionId, (onsiteByProfession.get(professionId) || 0) + count);
  } else if (isPureLocality) {
    const key = normalizeText(term);
    localityTermCounts.set(key, (localityTermCounts.get(key) || 0) + count);
  } else {
    const key = normalizeText(term);
    // 1-4 char fragments are typing noise, not demand.
    if (key.length >= 5) unmappedTermCounts.set(key, (unmappedTermCounts.get(key) || 0) + count);
  }
}

// Aggregate signal B per profession (+ canton split = the locality
// dimension on the supply side, feeds profession × canton pairs).
//
// Two distinct counts per profession:
//  - count: loose multi-lingual alias match on the title — the DEMAND-side
//    market size, used for ranking/score only.
//  - feedFilterCount: literal `feedFilter` substring on the same haystack
//    jobsSeoPagesPlugin filters with (title/description/company/location/
//    titleByLocale). This is what the emitted page would actually show, so
//    it — not the loose count — gates doubleValidated: the loose matcher
//    counts DE/FR/EN ads a `filterKeywords: [feedFilter]` page can never
//    surface (e.g. "filialleiter" for responsabile-negozio).
const jobsByProfession = new Map();
const pluginHaystack = (job) => [
  String(job.title || ''),
  String(job.description || ''),
  String(job.company || ''),
  String(job.location || ''),
  ...Object.values(job.titleByLocale || {}),
].join(' ').toLowerCase();
for (const job of jobs) {
  const id = matchProfession(job.title);
  const haystack = pluginHaystack(job);
  for (const entry of PROFESSION_TAXONOMY) {
    const loose = entry.id === id;
    const literal = haystack.includes(entry.feedFilter);
    if (!loose && !literal) continue;
    const agg = jobsByProfession.get(entry.id) || { count: 0, feedFilterCount: 0, cantons: new Map() };
    if (loose) {
      agg.count += 1;
      const canton = typeof job.canton === 'string' && job.canton ? job.canton.toUpperCase() : '??';
      agg.cantons.set(canton, (agg.cantons.get(canton) || 0) + 1);
    }
    if (literal) agg.feedFilterCount += 1;
    jobsByProfession.set(entry.id, agg);
  }
}

// Rank: every taxonomy entry with any signal, coverage subtracted.
const scoreOf = (onsite, jobCount, gsc) =>
  onsite * 3 + Math.min(jobCount, JOB_COUNT_SCORE_CAP) + Math.round((gsc?.impressions || 0) / 25);

const opportunities = [];
const coveredRows = [];
for (const entry of PROFESSION_TAXONOMY) {
  const onsite = onsiteByProfession.get(entry.id) || 0;
  const jobAgg = jobsByProfession.get(entry.id);
  const jobCount = jobAgg ? jobAgg.count : 0;
  const feedFilterJobCount = jobAgg ? jobAgg.feedFilterCount : 0;
  const gsc = gscByProfession.get(entry.id);
  if (onsite === 0 && jobCount === 0 && feedFilterJobCount === 0 && !gsc) continue;
  const row = {
    id: entry.id,
    label: entry.label,
    feedFilter: entry.feedFilter,
    onsiteCount: onsite,
    jobCount,
    // Jobs a fed keyword page would ACTUALLY list (literal feedFilter
    // substring, same semantics as jobsSeoPagesPlugin). Gates the feed:
    // below the plugin's ≥3 threshold the page would silently never emit.
    feedFilterJobCount,
    cantons: jobAgg
      ? Object.fromEntries([...jobAgg.cantons.entries()].sort((a, b) => b[1] - a[1]))
      : {},
    gscImpressions: gsc ? gsc.impressions : 0,
    gscClicks: gsc ? gsc.clicks : 0,
    doubleValidated: onsite >= DOUBLE_VALIDATED_MIN_ONSITE
      && jobCount >= DOUBLE_VALIDATED_MIN_JOBS
      && feedFilterJobCount >= DOUBLE_VALIDATED_MIN_JOBS,
    score: scoreOf(onsite, jobCount, gsc),
  };
  if (covered.has(entry.id)) {
    coveredRows.push({ ...row, coveredBy: covered.get(entry.id) });
  } else {
    opportunities.push(row);
  }
}
const byPriority = (a, b) =>
  Number(b.doubleValidated) - Number(a.doubleValidated) || b.score - a.score;
opportunities.sort(byPriority);
coveredRows.sort(byPriority);

const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([term, count]) => ({ term, count }));

const output = {
  generatedAt: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  signals: {
    onsiteSearch: onsiteTerms ? { uniqueTerms: onsiteTerms.length, totalEvents: onsiteEventsTotal } : null,
    crawlerJobs: jobs.length,
    gscQueriesFile: fs.existsSync(GSC_PATH),
  },
  opportunities,
  covered: coveredRows,
  localityDemand: topN(localityTermCounts, 25),
  unmappedSearchTerms: topN(unmappedTermCounts, MAX_UNMAPPED_REPORTED),
};

// Skip the write when nothing but the timestamp changed, so the weekly
// workflow's `git diff --cached --quiet` guard actually holds and identical
// rankings don't produce a no-op commit on main every Monday.
const stripTimestamp = (obj) => JSON.stringify({ ...obj, generatedAt: null });
let unchanged = false;
if (fs.existsSync(OUTPUT_PATH)) {
  try {
    unchanged = stripTimestamp(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'))) === stripTimestamp(output);
  } catch { /* unreadable previous file → rewrite */ }
}
if (unchanged) {
  console.error(`${OUTPUT_PATH} unchanged (timestamp-only diff) — not rewritten`);
} else {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.error(`Wrote ${OUTPUT_PATH}: ${opportunities.length} opportunities, ${coveredRows.length} covered`);
}

// ── Markdown report (stdout / --markdown-out) ────────────────────────────

const md = [];
md.push('## Professioni da attaccare — gap ranking settimanale');
md.push('');
md.push(`Finestra: ${WINDOW_DAYS} giorni · on-site search: ${onsiteTerms ? `${onsiteEventsTotal} eventi, ${onsiteTerms.length} termini unici` : '_disattivato_'} · annunci crawler: ${jobs.length}`);
md.push('');
md.push('Doppia validazione = c\'è chi cerca on-site **e** ci sono annunci reali da mostrare → landing converte subito.');
md.push('');
md.push('| # | Professione | On-site (60g) | Annunci | Match filtro | Cantoni top | GSC impr. | Score | Doppia val. |');
md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
opportunities.slice(0, 20).forEach((o, i) => {
  const cantonTop = Object.entries(o.cantons).slice(0, 3).map(([c, n]) => `${c}:${n}`).join(' ') || '—';
  md.push(`| ${i + 1} | ${o.label} (\`${o.id}\`) | ${o.onsiteCount} | ${o.jobCount} | ${o.feedFilterJobCount} | ${cantonTop} | ${o.gscImpressions} | ${o.score} | ${o.doubleValidated ? '✅' : '—'} |`);
});
if (opportunities.length === 0) md.push('| — | _nessun gap: tutte le professioni con segnale sono già coperte_ | | | | | | | |');
md.push('');
md.push(`<details><summary>Già coperte (${coveredRows.length}) — escluse dal ranking</summary>`);
md.push('');
md.push('| Professione | Copertura | On-site | Annunci |');
md.push('| --- | --- | --- | --- |');
coveredRows.forEach((o) => md.push(`| ${o.label} | ${o.coveredBy} | ${o.onsiteCount} | ${o.jobCount} |`));
md.push('');
md.push('</details>');
md.push('');
md.push(`<details><summary>Domanda località (dimensione separata, ${output.localityDemand.length})</summary>`);
md.push('');
output.localityDemand.forEach(({ term, count }) => md.push(`- \`${term}\` — ${count}`));
md.push('');
md.push('</details>');
md.push('');
md.push(`<details><summary>Termini non mappati (candidati tassonomia, top ${output.unmappedSearchTerms.length})</summary>`);
md.push('');
output.unmappedSearchTerms.forEach(({ term, count }) => md.push(`- \`${term}\` — ${count}`));
md.push('');
md.push('</details>');
md.push('');
md.push('_Generato da `scripts/profession-keyword-opportunities.mjs` (zero-Claude, deterministico). Dati: `data/profession-keyword-opportunities.json`._');

const markdown = md.join('\n') + '\n';
if (MARKDOWN_OUT) {
  fs.writeFileSync(MARKDOWN_OUT, markdown, 'utf-8');
  console.error(`Wrote markdown report → ${MARKDOWN_OUT}`);
} else {
  console.log(markdown);
}
