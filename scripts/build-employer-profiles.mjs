#!/usr/bin/env node
/**
 * build-employer-profiles.mjs — generate data/employer-profiles.json, the
 * FACTUAL evergreen dataset behind the /aziende/<slug>/ employer-profile pages
 * (build-plugins/employerProfilePagesPlugin.ts, epic #4462 / sub #4463).
 *
 * Source of truth: the assembled active-job corpus data/jobs.json (fallback
 * public/data/jobs.json) + the hiring history data/jobs-stats-history.json.
 *
 * For every company ABOVE the floor (>= MIN_ACTIVE_JOBS active postings) it
 * emits a profile with ONLY corpus-derived facts:
 *   - canonical slug + display name (the company's own name)
 *   - dominant sector (most common job.sector in the group)
 *   - work locations: cantons + cities aggregated from the postings
 *   - salary median (CHF/yr) over the group's real salary bands
 *   - hiring trend: postings added / removed over a trailing window, read
 *     from jobs-stats-history.json (net = added − removed)
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'employer-profiles.json');

/** Min active postings for a full, indexable employer profile page. */
export const MIN_ACTIVE_JOBS = 5;
/** Companies with >= this but < MIN_ACTIVE_JOBS get a below-floor bridge. */
export const BRIDGE_FLOOR = 2;
/** Runaway guard so a crawler mis-aggregation can't balloon the sitemap. */
export const MAX_PROFILES = 1000;
/** Trailing window (days) for the hiring-trend counts. */
export const TREND_WINDOW_DAYS = 28;
/** Min real salary samples for a meaningful median (mirrors realSalaryMedianChf). */
const MIN_SALARY_SAMPLES = 3;
/** Max cities / cantons surfaced per profile (kept lean; long tail dropped). */
const MAX_CITIES = 6;
const MAX_CANTONS = 6;

const SCHEMA_VERSION = 1;

function loadJobs() {
  const p = ['data/jobs.json', 'public/data/jobs.json']
    .map((x) => path.join(ROOT, x))
    .find(fs.existsSync);
  if (!p) throw new Error('jobs.json not found — run scripts/assemble-jobs-dataset.mjs first.');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : raw.jobs || [];
}

/** Annual midpoint of a job's salary band, or null. Mirrors realSalaryMedian.jobSalaryMidpoint. */
function salaryMidpoint(job) {
  const min = typeof job.salaryMin === 'number' ? job.salaryMin : null;
  const max = typeof job.salaryMax === 'number' ? job.salaryMax : null;
  if (min && max) return Math.round((min + max) / 2);
  if (min) return min;
  if (max) return max;
  return null;
}

/** Median of positive salary midpoints (>= MIN_SALARY_SAMPLES), else null. */
function salaryMedian(jobs) {
  const values = [];
  for (const j of jobs) {
    // Exclude explicitly-estimated bands when the corpus marks them (parity
    // with realSalaryMedianChf); today's corpus carries no salarySource so all
    // count, exactly like the site's other median surfaces.
    if (j.salarySource === 'estimated') continue;
    const mid = salaryMidpoint(j);
    if (mid && Number.isFinite(mid) && mid > 0) values.push(mid);
  }
  values.sort((a, b) => a - b);
  if (values.length < MIN_SALARY_SAMPLES) return { median: null, samples: values.length };
  const half = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 1
      ? values[half]
      : Math.round((values[half - 1] + values[half]) / 2);
  return { median, samples: values.length };
}

/** Most frequent non-empty string of `field` in a group (deterministic tie-break). */
function dominant(jobs, field) {
  const counts = new Map();
  for (const j of jobs) {
    const v = String(j[field] || '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best || null;
}

/** Aggregate a field into [{ name, count }] sorted by count desc, name asc. */
function topBy(jobs, pick, limit) {
  const counts = new Map();
  for (const j of jobs) {
    const v = pick(j);
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, limit);
}

function cityLabel(job) {
  const raw = String(job.addressLocality || job.location || '').split(/[,(]/)[0].trim();
  return raw || null;
}

/**
 * Build a slug → { added, removed, net, windowDays } trend map from the hiring
 * history, summing per-company added/removed keys over the trailing window.
 * History rows carry `key`/`name`; we canonicalise BOTH to the profile slug so
 * a row matches regardless of which one aligns.
 */
function buildTrendMap(historyPath) {
  if (!fs.existsSync(historyPath)) return new Map();
  let hist;
  try {
    hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch {
    return new Map();
  }
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
      const removed = Array.isArray(cs.removedKeys)
        ? cs.removedKeys.length
        : Number(cs.removedCount) || 0;
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
  const trendMap = buildTrendMap(path.join(ROOT, 'data', 'jobs-stats-history.json'));

  // Group active jobs by canonical company slug.
  const groups = new Map();
  for (const j of jobs) {
    const company = String(j.company || '').trim();
    if (!company) continue;
    const slug = canonicalCompanyProfileSlug(company, j.companyKey);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(j);
  }

  const profiles = [];
  const belowFloor = [];

  for (const [slug, group] of groups) {
    const activeJobs = group.length;
    if (activeJobs < BRIDGE_FLOOR) continue; // singletons: no page, no bridge.

    const name = dominant(group, 'company') || slug;
    const sector = dominant(group, 'sector');
    const topCanton = topBy(group, (j) => String(j.canton || '').trim().toUpperCase() || null, 1)[0];

    if (activeJobs < MIN_ACTIVE_JOBS) {
      belowFloor.push({
        slug,
        name,
        activeJobs,
        sector,
        canton: topCanton ? topCanton.name : null,
      });
      continue;
    }

    const { median, samples } = salaryMedian(group);
    const cantons = topBy(
      group,
      (j) => String(j.canton || '').trim().toUpperCase() || null,
      MAX_CANTONS,
    );
    const cities = topBy(group, cityLabel, MAX_CITIES);

    profiles.push({
      slug,
      name,
      companyKey: dominant(group, 'companyKey'),
      sector,
      activeJobs,
      cantons,
      cities,
      salaryMedianChf: median,
      salarySamples: samples,
      trend: trendMap.get(slug) || null,
    });
  }

  // Deterministic order: active jobs desc, then slug asc.
  profiles.sort((a, b) => b.activeJobs - a.activeJobs || (a.slug < b.slug ? -1 : 1));
  belowFloor.sort((a, b) => b.activeJobs - a.activeJobs || (a.slug < b.slug ? -1 : 1));

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
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}

export { build };
