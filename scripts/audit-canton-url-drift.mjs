#!/usr/bin/env node
/**
 * audit-canton-url-drift.mjs — how many already-indexed job URLs changed their
 * canton section since a point in the past, and in which direction.
 *
 * WHY THIS EXISTS
 * A job detail page lives at `/cerca-lavoro-<canton>/<slug>/` (plus the three
 * localised equivalents). The canton segment is derived, not stored with the
 * posting, so when the derivation changes its mind the URL moves and the old
 * one — which Google has already indexed — becomes a 301. Search Console counts
 * those under «Pagina con reindirizzamento»: 188.160 URLs on 2026-08-21, of
 * which a 1.000-URL sample said ~75% were job pages whose section had moved.
 *
 * That number is a stock. It cannot tell you whether the bleeding stopped,
 * because a redirect stays counted long after the cause is fixed. This script
 * measures the FLOW instead: slugs per week that change section, and whether
 * the move was towards or away from the canton of the municipality named in the
 * slug. Run it on a schedule and the series answers "is this getting better".
 *
 * WHAT IT COMPARES
 * `data/all-known-job-slugs/part-NN.json` is an append-only store of every slug
 * ever published, mapping each to its current path per locale. Comparing one
 * shard against its own state N days ago isolates exactly the population that
 * matters: slugs that existed then AND now, i.e. URLs Google has had time to
 * index. New slugs are not drift, and the store never removes.
 *
 * Sharding is by slug hash, so any shard is a uniform random sample of the
 * corpus. Measured 2026-08-24 over 5 shards (44.919 common slugs, 2026-08-17 →
 * 2026-08-24): per-shard rates 0,73% / 0,94% / 0,99% / 0,86% / 0,78% — tight
 * enough that the default sample of 5 is about precision, not representativity.
 *
 * DIRECTION
 * A rate alone cannot separate "the derivation is converging on the truth" from
 * "the derivation is thrashing". Job slugs usually end in the municipality
 * (…-coop-genossenschaft-richterswil), so the municipality's own canton is an
 * independent oracle. Same measurement, 330 of 387 drifts resolvable: 108 moved
 * TOWARDS that canton, 154 away, 68 lateral. Churn, not convergence — which is
 * what made it a defect worth fixing rather than a corpus improving itself.
 *
 * READ-ONLY AND FAIL-SOFT. Exits 0 on every internal failure: a monitor that
 * breaks the branch it watches gets switched off. A run that could not measure
 * says so and writes nothing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Store shard count is fixed by the producer; keep the pad width in one place. */
const SHARD_PAD = 2;

/**
 * The store's per-slug value has carried two shapes over time: a bare path
 * string, and a per-locale object. Both mean the same thing for this audit —
 * only the Italian path is read, because the canton segment is the same
 * decision in all four locales and IT is the one shape guaranteed present.
 *
 * @param {unknown} entry
 * @returns {string} the IT path, or '' when the entry carries none
 */
export function italianPath(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.it === 'string') return entry.it;
  return '';
}

/**
 * First path segment — the canton section (`cerca-lavoro-lucerna`). Returns ''
 * for anything that is not a two-segment job path, so a malformed entry is
 * skipped rather than counted as a drift against ''.
 *
 * @param {string} p
 * @returns {string}
 */
export function sectionOf(p) {
  const segs = String(p || '').split('/').filter(Boolean);
  return segs.length >= 2 ? segs[0] : '';
}

/**
 * Shard ids to sample. Deterministic and evenly spread rather than random: two
 * runs a week apart must measure the same population, or the series compares
 * different samples and its movement means nothing.
 *
 * @param {number} want how many shards to sample
 * @param {number} total shards in the store
 * @returns {string[]} zero-padded ids
 */
export function pickShards(want, total) {
  const n = Math.max(1, Math.min(want, total));
  const step = total / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(String(Math.floor(i * step)).padStart(SHARD_PAD, '0'));
  return [...new Set(out)];
}

/**
 * Canton of the municipality named in the slug, or '' when none is recognisable.
 *
 * Scans right-to-left because the municipality is conventionally the last
 * component (`…-spital-limmattal-schlieren`), and tries 3-token then 2-token
 * then 1-token windows so multi-word names (`sankt gallen`, `le mont sur
 * lausanne`) are found before a shorter accidental match inside them.
 *
 * @param {string} slug
 * @param {(text: string) => string | null} infer inferAnyCanton
 * @returns {string}
 */
export function oracleCantonFromSlug(slug, infer) {
  const toks = String(slug || '').split('-').filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = toks.length - n; i >= 0; i--) {
      const cand = toks.slice(i, i + n).join(' ');
      if (cand.length < 4) continue;
      let got = null;
      try { got = infer(cand); } catch { got = null; }
      if (got) return String(got).toUpperCase();
    }
  }
  return '';
}

/**
 * Was the move towards the slug's own municipality, away from it, or neither?
 * `unresolved` covers both "no municipality in the slug" and "a section this
 * build does not know", so the three real buckets stay clean.
 *
 * @returns {'towards'|'away'|'lateral'|'unresolved'}
 */
export function classifyDirection(oracle, oldCanton, newCanton) {
  if (!oracle || !oldCanton || !newCanton) return 'unresolved';
  if (newCanton === oracle && oldCanton !== oracle) return 'towards';
  if (oldCanton === oracle && newCanton !== oracle) return 'away';
  return 'lateral';
}

/** `cerca-lavoro-lucerna` → `LU`, built from the canton slug registry. */
export function buildSectionToCanton(registry) {
  const table = registry?.cantons ?? registry ?? {};
  const out = {};
  for (const [code, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue;
    const it = value.it;
    if (typeof it === 'string' && it) out[`cerca-lavoro-${it}`] = String(code).toUpperCase();
  }
  return out;
}

/**
 * Compare one shard's two states.
 *
 * @returns {{common: number, drifted: Array<{slug: string, from: string, to: string}>}}
 */
export function diffShard(oldSlugs, newSlugs) {
  const drifted = [];
  let common = 0;
  for (const slug of Object.keys(newSlugs)) {
    const before = oldSlugs[slug];
    if (before === undefined) continue;
    common++;
    const from = sectionOf(italianPath(before));
    const to = sectionOf(italianPath(newSlugs[slug]));
    if (from && to && from !== to) drifted.push({ slug, from, to });
  }
  return { common, drifted };
}

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const days = Math.max(1, Number(arg('days', '7')) || 7);
  const wantShards = Math.max(1, Number(arg('shards', '5')) || 5);
  const historyPath = path.resolve(REPO_ROOT, arg('history', 'data/canton-url-drift-history.jsonl'));
  const ref = arg('ref', 'HEAD');

  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'data/all-known-job-slugs/manifest.json'), 'utf-8'),
  );
  const shardCount = Number(manifest.shardCount) || 32;
  const totalSlugs = Number(manifest.totalSlugs) || 0;

  // Cut-off by date, not by commit count: main takes ~9.700 commits a week from
  // the bots, so any fixed --depth would land somewhere arbitrary.
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const base = git(['rev-list', '-1', `--before=${since}`, ref]).trim();
  if (!base) {
    console.log(`ℹ️  Nessun commit prima di ${since}: storia troppo corta per misurare. Nessuna scrittura.`);
    return;
  }

  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/canton-url-slugs.json'), 'utf-8'));
  const sectionToCanton = buildSectionToCanton(registry);
  const { inferAnyCanton } = await import('./lib/target-swiss-locations.mjs');

  const shards = pickShards(wantShards, shardCount);
  let common = 0;
  const drifted = [];
  const usedShards = [];
  for (const id of shards) {
    const rel = `data/all-known-job-slugs/part-${id}.json`;
    let before;
    try {
      before = JSON.parse(git(['show', `${base}:${rel}`]));
    } catch {
      // A shard that did not exist at the base commit carries no comparable
      // population; skipping it is honest, and `shards` records what was used.
      console.log(`ℹ️  shard ${id}: assente al commit base, saltato`);
      continue;
    }
    const now = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
    const r = diffShard(before.slugs || {}, now.slugs || {});
    common += r.common;
    drifted.push(...r.drifted);
    usedShards.push(id);
  }

  if (!common) {
    console.log('ℹ️  Nessuno slug comune fra le due build: niente da misurare. Nessuna scrittura.');
    return;
  }

  const direction = { towards: 0, away: 0, lateral: 0, unresolved: 0 };
  for (const d of drifted) {
    const oracle = oracleCantonFromSlug(d.slug, inferAnyCanton);
    direction[classifyDirection(oracle, sectionToCanton[d.from], sectionToCanton[d.to])]++;
  }

  const rate = drifted.length / common;
  const record = {
    date: new Date().toISOString().slice(0, 10),
    base: base.slice(0, 11),
    days,
    shards: usedShards,
    common,
    drifted: drifted.length,
    // Ratio, not percent: the consumer formats it. 4 decimals resolves a rate
    // an order of magnitude below today's 0,0086.
    rate: Number(rate.toFixed(4)),
    totalSlugs,
    // What the sample implies for the whole corpus, across the 4 locales — the
    // number that lines up with Search Console's redirect count.
    projectedUrlsPerWindow: Math.round(rate * totalSlugs * 4),
    direction,
  };

  console.log(JSON.stringify(record, null, 2));

  const pct = (rate * 100).toFixed(2);
  const worse = direction.away + direction.lateral;
  const summary = [
    `### Canton URL drift — finestra ${days} giorni`,
    '',
    `| metrica | valore |`,
    `|---|---|`,
    `| slug confrontati | ${common.toLocaleString('it-CH')} (shard ${usedShards.join(', ')}) |`,
    `| hanno cambiato sezione | **${drifted.length.toLocaleString('it-CH')}** — ${pct}% |`,
    `| URL già indicizzati coinvolti | ~${record.projectedUrlsPerWindow.toLocaleString('it-CH')} su ${totalSlugs.toLocaleString('it-CH')} slug × 4 locali |`,
    `| verso il comune dello slug | ${direction.towards} |`,
    `| in allontanamento | ${direction.away} |`,
    `| laterali | ${direction.lateral} |`,
    `| senza oracolo | ${direction.unresolved} |`,
    '',
    direction.towards > worse
      ? '✅ La maggioranza dei movimenti corregge l\'assegnazione.'
      : `⚠️ ${worse} movimenti su ${drifted.length} non migliorano l'assegnazione: è rumore, non convergenza.`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch { /* non-fatal */ }
  } else {
    console.log('\n' + summary);
  }

  if (hasFlag('no-history')) return;
  try {
    fs.appendFileSync(historyPath, JSON.stringify(record) + '\n');
    console.log(`\n📈 storico aggiornato: ${path.relative(REPO_ROOT, historyPath)}`);
  } catch (e) {
    console.log(`⚠️  storico non scritto (${e?.message || e})`);
  }
}

// Fail-soft: a monitor must never be the thing that breaks the branch.
main().catch((e) => {
  console.log(`⚠️  audit-canton-url-drift non ha potuto misurare: ${e?.message || e}`);
});
