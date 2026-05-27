#!/usr/bin/env node
/**
 * dry-run-target-cantons-flip.mjs
 * ================================
 *
 * Decision D8 + E9 dry-run.
 *
 * Before flipping `TARGET_CANTONS` from ['TI','GR','VS'] to all 26 cantons,
 * we want a per-bucket impact report so we know:
 *
 *   (a) NEW           — slugs that would be added (new ZH crawler OR existing
 *                       crawler whose jobs the old gate filtered out).
 *   (b) PRESERVED     — slug already in registry, gate canton MATCHES current.
 *   (c) RECLASSIFIED  — slug already in registry, gate canton DIFFERS from
 *                       current. URL pattern stays frozen per E9, but the
 *                       internal canton tag would change → REGRESSION risk.
 *   (d) REJECTED      — gate returns 'reject' (Liechtenstein / non-CH).
 *   (e) UNCERTAIN     — gate returns 'low' confidence → emit at
 *                       /cerca-lavoro-svizzera/ per E11.
 *
 * Inputs (read-only):
 *   - data/slug-registry.json        (immutable fingerprint → slug map)
 *   - data/jobs/by-crawler/*.json    (per-crawler job slices)
 *
 * Output:
 *   - Console summary
 *   - data/dry-run-cathedral-flip-report.json (idempotent overwrite)
 *
 * CLI flags:
 *   --limit N       process only the first N jobs (testing)
 *   --canton CODE   only consider jobs currently tagged with CODE (testing)
 *
 * Exit code:
 *   0 — normal
 *   1 — reclassified bucket > 5% of total processed (yellow flag for human review)
 *   2 — fatal IO/parse error
 *
 * Safe to re-run: writes to a temp file then renames, never mutates inputs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyCantonQuorumGate } from './lib/canton-quorum-gate.mjs';
import { fingerprintJob } from './lib/dedicated-crawler-common.mjs';

// ─── Paths ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SLUG_REGISTRY_PATH = path.join(PROJECT_ROOT, 'data', 'slug-registry.json');
const BY_CRAWLER_DIR = path.join(PROJECT_ROOT, 'data', 'jobs', 'by-crawler');
const REPORT_PATH = path.join(PROJECT_ROOT, 'data', 'dry-run-cathedral-flip-report.json');

const RECLASSIFIED_HARD_THRESHOLD_PCT = 5;
const TOP_EXAMPLES_PER_BUCKET = 5;

// ─── CLI parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { limit: Infinity, canton: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1] !== undefined) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
      i += 1;
    } else if (a === '--canton' && argv[i + 1] !== undefined) {
      args.canton = String(argv[i + 1]).toUpperCase();
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: node scripts/dry-run-target-cantons-flip.mjs [--limit N] [--canton CODE]',
      '',
      '  --limit N       Process only the first N jobs (after canton filter).',
      '  --canton CODE   Only process jobs currently tagged with this canton (e.g. TI).',
      '',
      'Writes data/dry-run-cathedral-flip-report.json and prints a summary.',
      '',
    ].join('\n'),
  );
}

// ─── Slug-registry helpers ────────────────────────────────────────────────

/**
 * Load the slug-registry as a Map<fingerprint, entry>. Returns empty map if
 * the file is missing.
 */
async function loadSlugRegistry() {
  let raw;
  try {
    raw = await fs.readFile(SLUG_REGISTRY_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.warn(`[dry-run] slug-registry missing at ${SLUG_REGISTRY_PATH} — treating as empty.`);
      return new Map();
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse slug-registry.json: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[dry-run] slug-registry is not an object — treating as empty.');
    return new Map();
  }
  const m = new Map();
  for (const [k, v] of Object.entries(parsed)) {
    if (v && typeof v === 'object') m.set(k, v);
  }
  return m;
}

/**
 * Look up the canton currently associated with a registry entry. Older
 * registry entries do not carry a canton tag — in that case we return ''
 * and the bucketing falls through to PRESERVED only when both sides are
 * empty.
 */
function registryCantonOf(entry) {
  if (!entry) return '';
  if (typeof entry.canton === 'string') return entry.canton.toUpperCase();
  return '';
}

// ─── Crawler shard streaming ──────────────────────────────────────────────

/**
 * Yield {crawlerKey, job} pairs from data/jobs/by-crawler/*.json. Reads one
 * file at a time, parses, yields jobs, drops the reference. Memory footprint
 * is one crawler shard at a time.
 */
async function* streamByCrawlerJobs() {
  let entries;
  try {
    entries = await fs.readdir(BY_CRAWLER_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.warn(`[dry-run] ${BY_CRAWLER_DIR} missing — nothing to scan.`);
      return;
    }
    throw err;
  }
  const shardFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();

  for (const file of shardFiles) {
    const filePath = path.join(BY_CRAWLER_DIR, file);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      console.warn(`[dry-run] failed to read ${file}: ${err.message}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[dry-run] failed to parse ${file}: ${err.message}`);
      continue;
    }
    const crawlerKey =
      (parsed && typeof parsed.crawlerKey === 'string' && parsed.crawlerKey) ||
      file.replace(/\.json$/, '');
    const jobs = Array.isArray(parsed?.jobs)
      ? parsed.jobs
      : Array.isArray(parsed)
      ? parsed
      : [];
    for (const job of jobs) {
      if (job && typeof job === 'object') {
        yield { crawlerKey, job };
      }
    }
  }
}

// ─── Bucketing ────────────────────────────────────────────────────────────

/**
 * Classify a single job into one of: new | preserved | reclassified | rejected | uncertain.
 *
 * `currentCanton` is the canton tag stored on the job today (from the old gate,
 * TARGET_CANTONS=['TI','GR','VS']). `registryEntry` is the slug-registry value
 * (or undefined if not yet registered).
 */
function classify({ job, gateResult, registryEntry }) {
  const currentCanton = (job.canton || '').toUpperCase();
  const newCanton = (gateResult.canton || '').toUpperCase();

  if (gateResult.confidence === 'reject') {
    return { bucket: 'rejected', reason: 'gate=reject (non-CH or Liechtenstein)' };
  }
  if (gateResult.confidence === 'low') {
    return { bucket: 'uncertain', reason: 'gate=low; emit at /cerca-lavoro-svizzera/ per E11' };
  }

  // High-confidence outcome from here on.
  if (!registryEntry) {
    return {
      bucket: 'new',
      reason: currentCanton
        ? `not in registry; gate=${newCanton} (was tagged ${currentCanton})`
        : `not in registry; gate=${newCanton}`,
    };
  }

  const registeredCanton = registryCantonOf(registryEntry) || currentCanton;
  if (newCanton && registeredCanton && newCanton !== registeredCanton) {
    return {
      bucket: 'reclassified',
      reason: `registry canton=${registeredCanton}, gate canton=${newCanton}`,
      oldCanton: registeredCanton,
      newCanton,
    };
  }
  return { bucket: 'preserved', reason: `gate canton=${newCanton} matches existing` };
}

// ─── Report writer ────────────────────────────────────────────────────────

async function writeReportAtomically(report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const tmpPath = `${REPORT_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(tmpPath, payload, 'utf8');
  try {
    await fs.rename(tmpPath, REPORT_PATH);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('[dry-run] Loading slug-registry...');
  const registry = await loadSlugRegistry();
  console.log(`[dry-run] slug-registry entries: ${registry.size}`);

  /** @type {Record<string, Array<object>>} */
  const buckets = {
    new: [],
    preserved: [],
    reclassified: [],
    rejected: [],
    uncertain: [],
  };
  const summary = {
    newSlugs: 0,
    preservedCorrect: 0,
    reclassified: 0,
    rejected: 0,
    uncertain: 0,
  };
  const crawlerSet = new Set();
  let processed = 0;

  console.log('[dry-run] Streaming by-crawler jobs...');
  for await (const { crawlerKey, job } of streamByCrawlerJobs()) {
    if (processed >= args.limit) break;

    const currentCanton = (typeof job.canton === 'string' ? job.canton : '').toUpperCase();
    if (args.canton && currentCanton !== args.canton) continue;

    crawlerSet.add(crawlerKey);

    const gateResult = applyCantonQuorumGate(job);
    let fp = '';
    try {
      fp = fingerprintJob(job);
    } catch {
      /* ignore — fp empty means treated as new */
    }
    const registryEntry = fp ? registry.get(fp) : undefined;

    const { bucket, reason, oldCanton, newCanton } = classify({
      job,
      gateResult,
      registryEntry,
    });

    const slug =
      (registryEntry && registryEntry.canonicalSlug) ||
      (typeof job.slug === 'string' ? job.slug : '') ||
      '';
    const title = typeof job.title === 'string' ? job.title : '';

    const baseRecord = {
      slug,
      canton: gateResult.canton || '',
      crawler: crawlerKey,
      title,
      reason,
    };

    if (bucket === 'reclassified') {
      buckets.reclassified.push({
        slug,
        oldCanton: oldCanton || currentCanton || '',
        newCanton: newCanton || '',
        crawler: crawlerKey,
        title,
        urlPreserved: true, // E9: registry slug pattern is FROZEN
        reason,
      });
      summary.reclassified += 1;
    } else {
      buckets[bucket].push(baseRecord);
      if (bucket === 'new') summary.newSlugs += 1;
      else if (bucket === 'preserved') summary.preservedCorrect += 1;
      else if (bucket === 'rejected') summary.rejected += 1;
      else if (bucket === 'uncertain') summary.uncertain += 1;
    }

    processed += 1;
  }

  // ─── Build report ──────────────────────────────────────────────────────
  const report = {
    _generatedAt: new Date().toISOString(),
    _inputCounts: {
      slugRegistry: registry.size,
      byCrawlerJobs: processed,
      crawlersScanned: crawlerSet.size,
    },
    _summary: summary,
    _filters: {
      limit: Number.isFinite(args.limit) ? args.limit : null,
      canton: args.canton || null,
    },
    buckets,
  };

  await writeReportAtomically(report);

  // ─── Console summary ──────────────────────────────────────────────────
  const pct = (n) => (processed === 0 ? '0.0' : ((n / processed) * 100).toFixed(1));
  console.log('');
  console.log('─── Cathedral flip dry-run summary ───');
  console.log(`Processed jobs:       ${processed}`);
  console.log(`Crawlers scanned:     ${crawlerSet.size}`);
  console.log(`Slug-registry entries: ${registry.size}`);
  console.log('');
  console.log(`(a) NEW slugs:         ${summary.newSlugs}  (${pct(summary.newSlugs)}%)`);
  console.log(`(b) PRESERVED:         ${summary.preservedCorrect}  (${pct(summary.preservedCorrect)}%)`);
  console.log(`(c) RECLASSIFIED:      ${summary.reclassified}  (${pct(summary.reclassified)}%)  ← regression risk`);
  console.log(`(d) REJECTED:          ${summary.rejected}  (${pct(summary.rejected)}%)`);
  console.log(`(e) UNCERTAIN (low):   ${summary.uncertain}  (${pct(summary.uncertain)}%)`);
  console.log('');
  for (const [name, arr] of Object.entries(buckets)) {
    if (arr.length === 0) continue;
    console.log(`Top ${Math.min(TOP_EXAMPLES_PER_BUCKET, arr.length)} examples — ${name}:`);
    for (const ex of arr.slice(0, TOP_EXAMPLES_PER_BUCKET)) {
      const tag =
        name === 'reclassified'
          ? `${ex.oldCanton}→${ex.newCanton}`
          : ex.canton || '?';
      console.log(`  [${tag}] ${ex.crawler} :: ${ex.slug || '(no slug)'} — ${ex.title || ''}`);
    }
    console.log('');
  }
  console.log(`Report written to: ${REPORT_PATH}`);

  // ─── Exit code ────────────────────────────────────────────────────────
  const reclassifiedPct = processed === 0 ? 0 : (summary.reclassified / processed) * 100;
  if (reclassifiedPct > RECLASSIFIED_HARD_THRESHOLD_PCT) {
    console.error('');
    console.error(
      `[dry-run] reclassified=${reclassifiedPct.toFixed(2)}% > ${RECLASSIFIED_HARD_THRESHOLD_PCT}% — yellow flag, human review required.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[dry-run] fatal:', err && err.stack ? err.stack : err);
  process.exit(2);
});
