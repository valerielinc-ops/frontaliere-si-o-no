#!/usr/bin/env node
// =============================================================================
// import-pharmacies-ticino.mjs
// -----------------------------------------------------------------------------
// One-time importer for the Ticino pharmacy anagraphic listed per-region on
// ofct.ch (Ordine dei Farmacisti del Cantone Ticino), the source verified in
// #6398 (docs/data-sources/farmacie-turno-ticino.md). Populates the initial
// `Pharmacy` dataset for the #6173 pharmacy-portal MVP (item "Import
// iniziale elenco farmacie Ticino" in #6400) — a prerequisite for the
// canton/city/detail pages, which have nothing to render without it.
//
// Usage:
//   node scripts/import-pharmacies-ticino.mjs
//
// Output:
//   data/pharmacies-ticino.json
//
// Behaviour:
//   - Polite UA, 10s delay between region fetches (ofct.ch robots.txt
//     declares `crawl-delay: 10`, see the verification doc above).
//   - Graceful failure per region: a fetch error or structure drift on one
//     region logs a warning and is skipped, it never aborts the whole run
//     (the autonomous orchestrator must not crash on a transient
//     outside-world failure).
//   - Native fetch (Node >= 18; project requires Node 22+), regex-based HTML
//     parsing (scripts/lib/pharmacy-ticino-parser.mjs) — no new dependency.
//   - Locarnese is out of scope: separate domain/template, network access
//     verified (#6740) but no dedicated parser exists yet — no anagraphic
//     table published there (see the verification doc's "Verdetto").
//   - Write guard: if every region fetch fails, the result is empty and the
//     write is skipped (existing dataset preserved) rather than overwriting
//     a good dataset with `pharmacies: []` (#6739).
// =============================================================================

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFCT_REGIONS, buildPharmacyRecords, dedupePharmaciesById } from './lib/pharmacy-ticino-parser.mjs';
import { classifyMalformedRowDrift } from './lib/malformed-row-observability.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const OUTPUT_PATH = resolve(REPO_ROOT, 'data', 'pharmacies-ticino.json');
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const CRAWL_DELAY_MS = 10_000; // ofct.ch robots.txt: crawl-delay 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch HTML with a polite UA and a generous timeout.
 * Returns null on network failure / non-2xx — caller handles gracefully.
 */
async function fetchHtml(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it,de;q=0.8,en;q=0.5',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn(`[fetch] ${url} → HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[fetch] ${url} → ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the pharmacy count from a previously-written output file, if any.
 * Returns 0 when the file is missing or unreadable (nothing to preserve).
 */
async function readPreviousPharmacyCount() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.pharmacies) ? parsed.pharmacies.length : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const pharmacies = [];
  const errors = [];
  const warnings = [];
  let skippedMalformedRows = 0;

  for (let i = 0; i < OFCT_REGIONS.length; i += 1) {
    const region = OFCT_REGIONS[i];
    if (i > 0) await sleep(CRAWL_DELAY_MS);

    console.log(`[import-pharmacies-ticino] Fetching ${region.name} (${region.url}) ...`);
    const html = await fetchHtml(region.url);
    if (!html) {
      errors.push(`${region.key}: fetch failed`);
      continue;
    }

    const { records, skipped } = buildPharmacyRecords(html, region, fetchedAt);
    if (skipped > 0) {
      skippedMalformedRows += skipped;
      const diagnostic = classifyMalformedRowDrift(records.length, skipped);
      const warning = `${region.key}: skipped ${skipped}/${diagnostic.total} malformed row(s)`;
      console.warn(`[import-pharmacies-ticino] ${warning}`);
      warnings.push(warning);
      if (records.length > 0 && diagnostic.severity === 'error') {
        errors.push(`${region.key}: malformed-row drift ${skipped}/${diagnostic.total}`);
      }
    }
    if (records.length === 0) {
      console.warn(`[import-pharmacies-ticino] ${region.key}: no pharmacies found, structure may have changed`);
      errors.push(`${region.key}: zero pharmacies parsed`);
      continue;
    }
    pharmacies.push(...records);
  }

  // Dedupe by id (a pharmacy chain entry could in theory repeat across
  // region pages if OFCT ever overlaps boundaries).
  const { deduped: dedupedUnsorted, collisions: dedupCollisions } = dedupePharmaciesById(pharmacies);
  const deduped = dedupedUnsorted.sort((a, b) => a.name.localeCompare(b.name, 'it'));

  if (deduped.length === 0) {
    const previousCount = await readPreviousPharmacyCount();
    if (previousCount > 0) {
      console.error(
        `[import-pharmacies-ticino] All ${OFCT_REGIONS.length} regions failed (${errors.join('; ')}) — ` +
          `refusing to overwrite the existing ${previousCount}-pharmacy dataset with an empty one. Skipping write.`,
      );
      // exitCode stays 0: per the "Behaviour" note above, an all-regions
      // transient failure must not crash the autonomous orchestrator.
      return;
    }
  }

  const output = {
    _source: 'https://www.ofct.ch/',
    _sourceRegions: OFCT_REGIONS.map((r) => r.url),
    _fetchedAt: fetchedAt,
    _userAgent: USER_AGENT,
    _pharmacyCount: deduped.length,
    _errors: errors,
    _warnings: warnings,
    _dedupCollisions: dedupCollisions,
    _skippedMalformedRows: skippedMalformedRows,
    pharmacies: deduped,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`[import-pharmacies-ticino] Wrote ${deduped.length} pharmacies to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  // Last-ditch safety: never crash the autonomous orchestrator on this script.
  console.error('[import-pharmacies-ticino] fatal:', err);
  process.exit(0);
});
