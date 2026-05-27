#!/usr/bin/env node
// =============================================================================
// import-swiss-hospitals.mjs
// -----------------------------------------------------------------------------
// One-time scraper for the public hospital directory at welches-spital.ch.
// Replacement for LinkedIn discovery (deferred for ToS reasons in autonomous
// orchestration runs).
//
// Usage:
//   node scripts/import-swiss-hospitals.mjs
//
// Output:
//   data/swiss-hospitals.json
//
// Behaviour:
//   - Polite UA, 2-3s delay between any sub-page fetches.
//   - Graceful failure: on 404, network error, or unknown HTML structure the
//     script writes a minimal output with `_error` and exits 0 (the autonomous
//     orchestrator must NOT crash on a transient outside-world failure).
//   - Native fetch (Node >= 18; project requires Node 22+).
//   - No new npm dependencies — pure regex parsing of the listing page is
//     sufficient for the simple <ul>/<li>/<a> structure exposed by
//     welches-spital.ch.
// =============================================================================

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

const SOURCE_URL = 'https://welches-spital.ch/schweiz/';
const OUTPUT_PATH = resolve(REPO_ROOT, 'data', 'swiss-hospitals.json');
const USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const POLITE_DELAY_MS = 2500;        // 2.5 s between any sub-fetch

// --- Cantonal abbreviations (German + French + Italian variants) -------------
// The directory groups hospitals per canton; we map common spellings to ISO.
const CANTON_LOOKUP = {
  'aargau': 'AG', 'argovia': 'AG', 'argovie': 'AG',
  'appenzell-ausserrhoden': 'AR', 'appenzell-innerrhoden': 'AI',
  'basel-landschaft': 'BL', 'basel-stadt': 'BS', 'basilea-citta': 'BS', 'basilea-campagna': 'BL',
  'bern': 'BE', 'berna': 'BE', 'berne': 'BE',
  'fribourg': 'FR', 'freiburg': 'FR', 'friburgo': 'FR',
  'genf': 'GE', 'geneve': 'GE', 'ginevra': 'GE',
  'glarus': 'GL', 'glarona': 'GL',
  'graubuenden': 'GR', 'grigioni': 'GR', 'grisons': 'GR',
  'jura': 'JU',
  'luzern': 'LU', 'lucerna': 'LU', 'lucerne': 'LU',
  'neuenburg': 'NE', 'neuchatel': 'NE',
  'nidwalden': 'NW',
  'obwalden': 'OW',
  'schaffhausen': 'SH', 'sciaffusa': 'SH',
  'schwyz': 'SZ', 'svitto': 'SZ',
  'solothurn': 'SO', 'soletta': 'SO', 'soleure': 'SO',
  'st-gallen': 'SG', 'sankt-gallen': 'SG', 'san-gallo': 'SG',
  'tessin': 'TI', 'ticino': 'TI',
  'thurgau': 'TG', 'turgovia': 'TG',
  'uri': 'UR',
  'waadt': 'VD', 'vaud': 'VD',
  'wallis': 'VS', 'valais': 'VS', 'vallese': 'VS',
  'zug': 'ZG', 'zugo': 'ZG',
  'zuerich': 'ZH', 'zurich': 'ZH', 'zurigo': 'ZH',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Slugify a freeform string for canton-key matching.
 */
function slug(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de,it;q=0.8,en;q=0.5',
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
 * Decode common HTML entities. Tiny helper — no full parser needed.
 */
function decodeEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&([a-z]+);/gi, ' ');
}

/**
 * Strip tags and collapse whitespace.
 */
function textify(html = '') {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Valid Swiss canton ISO codes — used to filter the `collapse{XX}` class hint.
const VALID_CANTON_ISO = new Set([
  'AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW',
  'SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH',
]);

/**
 * Parse the welches-spital.ch listing page.
 *
 * Real structure (verified May 2026):
 *   <div class="collapse show collapseBE" ...>
 *     <h3>Akutsomatische Spitäler</h3>
 *     <p class="hosplist blue_click_list">
 *       <a href="/inselspital-bern-qualitaet/">Inselspital Bern (Teil der Insel Gruppe)</a>
 *     </p>
 *     <p class="hosplist blue_click_list">
 *       <a href="/alle-bewertungen/?hid=399">Hôpital de Moutier, Swiss Medical Network</a>
 *     </p>
 *     <h3>Rehabilitationskliniken, ...</h3>
 *     ...
 *   </div>
 *
 * Strategy:
 *   1. Split the HTML into per-canton blocks using `collapse{XX}` class as the
 *      ISO canton code.
 *   2. Inside each block, capture every `<a href="...">name</a>` and classify:
 *        - "/{slug}-qualitaet/"          → has a dedicated detail page
 *        - "/alle-bewertungen/?hid=N"    → no detail page, only review listing
 *   3. Track the most recent <h3> as the hospital category (akut, reha, psych...).
 *   4. Skip duplicate (canton, slug-or-hid) pairs.
 */
function parseHospitals(html) {
  if (!html) return [];

  const hospitals = [];
  const seen = new Set();

  // Pattern: each canton block opens with `class="...collapse{ISO}..."`.
  // We slice the document on these markers to scope canton context.
  const blockRe = /class=["'][^"']*collapse([A-Z]{2})[^"']*["'][\s\S]*?(?=class=["'][^"']*collapse[A-Z]{2}|<footer|$)/g;

  let blockMatch;
  while ((blockMatch = blockRe.exec(html)) !== null) {
    const canton = blockMatch[1];
    if (!VALID_CANTON_ISO.has(canton)) continue;
    const blockHtml = blockMatch[0];

    // Walk through the block sequentially: capture <h3>...</h3> (category) and
    // every <a href="...">label</a>. We need order, hence a single regex with
    // alternation.
    const tokenRe = /<h3[^>]*>([\s\S]*?)<\/h3>|<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let currentCategory = null;
    let t;
    while ((t = tokenRe.exec(blockHtml)) !== null) {
      const [, h3Inner, href, anchorInner] = t;

      if (h3Inner !== undefined) {
        currentCategory = textify(h3Inner) || null;
        continue;
      }
      if (!href) continue;

      // Only links to hospital pages (detail or review listing).
      const isDetail  = /^\/[a-z0-9-]+-qualitaet\/?$/i.test(href);
      const isReview  = /^\/alle-bewertungen\/\?(?:fc=\d+&)?hid=\d+/i.test(href);
      if (!isDetail && !isReview) continue;

      const name = textify(anchorInner);
      if (!name || name.length < 3) continue;

      // Build a stable dedupe key.
      let key;
      let hospitalSlug = null;
      if (isDetail) {
        const m = href.match(/^\/([a-z0-9-]+)-qualitaet\/?$/i);
        hospitalSlug = m ? m[1] : null;
        key = `${canton}::slug::${hospitalSlug}`;
      } else {
        const m = href.match(/hid=(\d+)/);
        const hid = m ? m[1] : 'unknown';
        key = `${canton}::hid::${hid}`;
      }
      if (seen.has(key)) continue;
      seen.add(key);

      hospitals.push({
        name,
        canton,
        category: currentCategory,
        city: null,            // not on listing page; would require detail fetch
        url: href.startsWith('http')
          ? href
          : `https://welches-spital.ch${href}`,
        type: isDetail ? 'detail-page' : 'review-only',
        _slug: hospitalSlug,
      });
    }
  }

  return hospitals;
}

/**
 * Optionally enrich each hospital by fetching its detail page (city, type).
 * Polite: serial, with POLITE_DELAY_MS between requests.
 *
 * To stay well under any rate-limit threshold on a single one-time crawl we
 * only fetch a small sample — full enrichment can be done in a follow-up
 * dedicated workflow if/when needed.
 */
async function enrichSample(hospitals, sampleSize = 0) {
  if (sampleSize <= 0) return hospitals;

  const enriched = [...hospitals];
  const limit = Math.min(sampleSize, enriched.length);

  for (let i = 0; i < limit; i += 1) {
    const h = enriched[i];
    await sleep(POLITE_DELAY_MS);
    const html = await fetchHtml(h.url);
    if (!html) continue;

    // Best-effort city extraction — look for "Adresse" / "Indirizzo" line
    const cityMatch = html.match(/\b(\d{4})\s+([A-Z][A-Za-zÀ-ÿ '\-]+)/);
    if (cityMatch) {
      enriched[i] = { ...h, city: cityMatch[2].trim() };
    }
  }
  return enriched;
}

async function main() {
  console.log(`[import-swiss-hospitals] Fetching ${SOURCE_URL} ...`);

  const fetchedAt = new Date().toISOString();
  const html = await fetchHtml(SOURCE_URL);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });

  if (!html) {
    const minimal = {
      _source: SOURCE_URL,
      _fetchedAt: fetchedAt,
      _hospitalCount: 0,
      _error: 'fetch failed (network error / non-2xx). See stderr for details.',
      hospitals: [],
    };
    await writeFile(OUTPUT_PATH, JSON.stringify(minimal, null, 2) + '\n', 'utf8');
    console.warn(`[import-swiss-hospitals] Wrote empty placeholder to ${OUTPUT_PATH}`);
    return;
  }

  const parsed = parseHospitals(html);

  if (parsed.length === 0) {
    console.warn(
      '[import-swiss-hospitals] no hospitals found, structure may have changed'
    );
  }

  // For autonomous run we keep enrichment off (sampleSize=0) to avoid hammering.
  // Set HOSPITAL_SAMPLE=N env var to enable a sampled enrichment locally.
  const sampleSize = Number.parseInt(process.env.HOSPITAL_SAMPLE || '0', 10) || 0;
  const finalList = await enrichSample(parsed, sampleSize);

  const output = {
    _source: SOURCE_URL,
    _fetchedAt: fetchedAt,
    _hospitalCount: finalList.length,
    _userAgent: USER_AGENT,
    hospitals: finalList,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(
    `[import-swiss-hospitals] Wrote ${finalList.length} hospitals to ${OUTPUT_PATH}`
  );
}

main().catch((err) => {
  // Last-ditch safety: never crash the autonomous orchestrator on this script.
  console.error('[import-swiss-hospitals] fatal:', err);
  process.exit(0);
});
