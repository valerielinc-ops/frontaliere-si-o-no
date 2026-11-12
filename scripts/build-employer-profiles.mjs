#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * build-employer-profiles.mjs — generate data/employer-profiles.json, the
 * FACTUAL evergreen dataset behind the /aziende/<slug>/ employer-profile pages
 * (build-plugins/employerProfilePagesPlugin.ts, epic #4462 / sub #4463).
 *
 * Source of truth: the assembled active-job corpus data/jobs.json (fallback
 * public/data/jobs.json) + the logical monthly-sharded hiring history store.
 *
 * For every company ABOVE the floor (>= MIN_ACTIVE_JOBS active postings) it
 * emits a profile with ONLY corpus-derived facts:
 *   - canonical slug + display name (the company's own name)
 *   - dominant sector (most common job.sector in the group)
 *   - work locations: cantons + cities aggregated from the postings
 *   - salary median (CHF/yr) over the group's real salary bands
 *   - hiring trend: postings added / removed over a trailing window, read
 *     from the job stats history store (net = added − removed)
 *
 * NO editorial judgement, NO generated prose, NO PII — the page templates own
 * the localized (factual) copy; this file is pure numbers + labels
 * (brand-safety, issue #4463).
 *
 * Companies in the BRIDGE band (BRIDGE_FLOOR..MIN_ACTIVE_JOBS-1 active jobs)
 * are recorded in `belowFloor` with a minimal record so the plugin can emit a
 * noindex,follow bridge at the same URL instead of a silent 404 (AGENTS.md §
 * Static SEO Pages) — and so searchConsoleCompat.ts can self-map the slug.
 *
 * Deterministic + rerunnable:
 *   node scripts/build-employer-profiles.mjs           # write dataset
 *   node scripts/build-employer-profiles.mjs --check   # exit 1 if stale
 *   node scripts/build-employer-profiles.mjs --stats   # print summary only
 */
import fs from 'node:fs';
import { readJsonFile } from './lib/read-large-json.mjs';
import { reportedSalarySummary } from '../build-plugins/shared/realSalaryMedian.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { MIN_ACTIVE_JOBS, BRIDGE_FLOOR, MAX_PROFILES } from '../build-plugins/shared/employerProfileConfig.mjs';
import {
  buildEmployerProfileRecord,
  compareEmployerRecords,
  groupJobsByEmployerSlug,
} from '../build-plugins/shared/employerProfileRecords.mjs';
import { readJobsStatsHistory } from './lib/job-stats-history-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'employer-profiles.json');

// Floors shared with the SSG plugin — ONE definition (employerProfileConfig.mjs).
// MAX_PROFILES lives there too: the plugin fills snapshot gaps from the live
// corpus and must respect the same runaway cap.
export { MIN_ACTIVE_JOBS, BRIDGE_FLOOR, MAX_PROFILES };
/** Trailing window (days) for the hiring-trend counts. */
export const TREND_WINDOW_DAYS = 28;

const SCHEMA_VERSION = 1;

// Grouping, the reserved-slug guard and the per-employer aggregates (dominant
// sector/name, cantons, cities, salary median) live in
// build-plugins/shared/employerProfileRecords.mjs so the SSG plugin derives
// exactly the same record when it fills a gap in this snapshot.

function loadJobs() {
  const p = ['data/jobs.json', 'public/data/jobs.json']
    .map((x) => path.join(ROOT, x))
    .find(fs.existsSync);
  if (!p) throw new Error('jobs.json not found — run scripts/assemble-jobs-dataset.mjs first.');
  // data/jobs.json can exceed V8's 512 MB string limit: readJsonFile parses it
  // item by item past that size instead of failing with ERR_STRING_TOO_LONG.
  const raw = readJsonFile(p);
  return Array.isArray(raw) ? raw : raw.jobs || [];
}

/**
 * Build a slug → { added, removed, net, windowDays } trend map from the hiring
 * history, summing per-company added/removed keys over the trailing window.
 * History rows carry `key`/`name`; we canonicalise BOTH to the profile slug so
 * a row matches regardless of which one aligns.
 */
function buildTrendMap(hist) {
  const entries = Array.isArray(hist.entries) ? hist.entries : [];
  if (entries.length === 0) return new Map();
  const dated = entries.filter((e) => e && e.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastDate = new Date(`${dated[dated.length - 1].date}T00:00:00Z`).getTime();
  const cutoff = lastDate - TREND_WINDOW_DAYS * 24 * 3600 * 1000;

  const acc = new Map(); // slug → { added, removed }
  for (const e of dated) {
    const t = new Date(`${e.date}T00:00:00Z`).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    for (const cs of e.companyStats || []) {
      const slug =
        canonicalCompanyProfileSlug(cs.name || '', cs.key || '') ||
        canonicalCompanyProfileSlug(cs.key || '', '');
      if (!slug) continue;
      const added = Array.isArray(cs.addedKeys) ? cs.addedKeys.length : 0;
      const removed = Math.max(
        Array.isArray(cs.removedKeys) ? cs.removedKeys.length : 0,
        Number(cs.removedCount) || 0,
      );
      const cur = acc.get(slug) || { added: 0, removed: 0 };
      cur.added += added;
      cur.removed += removed;
      acc.set(slug, cur);
    }
  }
  const out = new Map();
  for (const [slug, v] of acc) {
    if (v.added === 0 && v.removed === 0) continue;
    out.set(slug, {
      added: v.added,
      removed: v.removed,
      net: v.added - v.removed,
      windowDays: TREND_WINDOW_DAYS,
    });
  }
  return out;
}

function build() {
  const jobs = loadJobs();
  const trendMap = buildTrendMap(readJobsStatsHistory(ROOT));
  const groups = groupJobsByEmployerSlug(jobs);

  const profiles = [];
  const belowFloor = [];

  for (const [slug, group] of groups) {
    const built = buildEmployerProfileRecord(slug, group, {
      salarySummary: reportedSalarySummary,
      trend: trendMap.get(slug) || null,
    });
    if (!built) continue; // singletons: no page, no bridge.
    if (built.band === 'belowFloor') {
      belowFloor.push(built.record);
      continue;
    }
    profiles.push(built.record);
  }

  // Deterministic order: active jobs desc, then slug asc.
  profiles.sort(compareEmployerRecords);
  belowFloor.sort(compareEmployerRecords);

  const capped = profiles.slice(0, MAX_PROFILES);

  return {
    _meta: {
      purpose:
        'Factual per-company profiles for the evergreen /aziende/<slug>/ employer pages ' +
        '(build-plugins/employerProfilePagesPlugin.ts). Corpus-derived facts only — no ' +
        'editorial judgement, no PII. Regenerate: node scripts/build-employer-profiles.mjs.',
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      floor: MIN_ACTIVE_JOBS,
      bridgeFloor: BRIDGE_FLOOR,
      trendWindowDays: TREND_WINDOW_DAYS,
      sourceJobs: jobs.length,
      aboveFloorCount: capped.length,
      belowFloorCount: belowFloor.length,
    },
    profiles: capped,
    belowFloor,
  };
}

function stableStringify(dataset) {
  // Re-emit generatedAt-agnostic for --check comparisons.
  return JSON.stringify(dataset, null, 2) + '\n';
}

function withoutTimestamp(dataset) {
  const clone = JSON.parse(JSON.stringify(dataset));
  if (clone._meta) delete clone._meta.generatedAt;
  return clone;
}

function main() {
  const argv = process.argv.slice(2);
  const dataset = build();
  const meta = dataset._meta;

  if (argv.includes('--stats')) {
    console.log(
      `[employer-profiles] ${meta.aboveFloorCount} above-floor (>=${meta.floor}) profiles, ` +
        `${meta.belowFloorCount} below-floor bridges, from ${meta.sourceJobs} active jobs.`,
    );
    return;
  }

  if (argv.includes('--check')) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('[employer-profiles] --check: data/employer-profiles.json missing.');
      process.exit(1);
    }
    const current = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    const a = JSON.stringify(withoutTimestamp(current));
    const b = JSON.stringify(withoutTimestamp(dataset));
    if (a !== b) {
      console.error(
        '[employer-profiles] --check: data/employer-profiles.json is STALE — ' +
          'run `node scripts/build-employer-profiles.mjs` and commit.',
      );
      process.exit(1);
    }
    console.log('[employer-profiles] --check: dataset up to date.');
    return;
  }

  fs.writeFileSync(OUT_PATH, stableStringify(dataset), 'utf8');
  console.log(
    `[employer-profiles] wrote ${path.relative(ROOT, OUT_PATH)} — ` +
      `${meta.aboveFloorCount} profiles + ${meta.belowFloorCount} bridges ` +
      `(floor ${meta.floor}, ${meta.sourceJobs} active jobs).`,
  );
}

const isMain =
  process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  main();
}

export { build, buildTrendMap };
