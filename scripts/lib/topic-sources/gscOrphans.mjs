// scripts/lib/topic-sources/gscOrphans.mjs
//
// Source module for the topic-candidates miner: reads GSC orphan queries
// already synced to repo (`data/gsc-orphan-queries.json`), filters them down
// to the "quick-win" zone (impressions >= 20, position 6-30 if available),
// drops queries that are already covered by an existing IT article title
// (Jaccard >= 0.7), and emits Candidate objects.
//
// Schema match: see docs/superpowers/specs/2026-05-06-smarter-article-generator-design.md
// Phase 2, "topic-candidates.json" + "gscOrphans.mjs" sub-section.
//
// Graceful degradation: never throws. On any read/parse failure, returns
// `{ ok: false, candidates: [], reason }`.

import { readFileSync, existsSync } from 'node:fs';

const ORPHAN_QUERIES_PATH = 'data/gsc-orphan-queries.json';
const BLOG_META_PATH = 'services/locales/blog-meta-it.ts';

const MIN_IMPRESSIONS = 20;
const POSITION_MIN = 6;
const POSITION_MAX = 30;
const MAX_JACCARD_FOR_NEW = 0.7;

function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && t.length >= 2),
  );
}

export function jaccard(a, b) {
  const ta = a instanceof Set ? a : tokenize(a);
  const tb = b instanceof Set ? b : tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// FNV-1a 32-bit, 8-hex output. Stable across runs.
export function fnv1a8(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeKeyword(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract IT article titles from blog-meta-it.ts content. Format is
// `'blog.article.<slug>.title': 'Some title here',` (with optional escaped
// apostrophes). Returns array of title strings.
export function extractItTitles(metaContent) {
  if (!metaContent) return [];
  const titles = [];
  const re = /'blog\.article\.[^']+?\.title':\s*'((?:\\'|[^'])*)'/g;
  let m;
  while ((m = re.exec(metaContent)) !== null) {
    titles.push(m[1].replace(/\\'/g, "'"));
  }
  return titles;
}

function readFileSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.orphanQueriesPath]
 * @param {string} [opts.blogMetaPath]
 * @param {string[]} [opts.existingTitles] — pre-loaded titles (test override).
 * @param {object} [opts.orphanData] — pre-loaded orphan-queries JSON (test override).
 * @returns {Promise<{ ok: boolean, candidates: any[], reason?: string }>}
 */
export async function fetchGscOrphanCandidates(opts = {}) {
  try {
    const orphanData =
      opts.orphanData ??
      (() => {
        const raw = readFileSafe(opts.orphanQueriesPath ?? ORPHAN_QUERIES_PATH);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })();

    if (!orphanData) {
      return {
        ok: false,
        candidates: [],
        reason: 'gsc-orphan-queries.json not found or invalid',
      };
    }

    const titles =
      opts.existingTitles ??
      extractItTitles(readFileSafe(opts.blogMetaPath ?? BLOG_META_PATH) ?? '');
    const titleTokens = titles.map((t) => tokenize(t));

    // Flatten: orphanData is `Record<string, Array<{query, clicks, impressions, position?}>>`
    // Some files may also provide a flat array — handle both.
    const flat = [];
    if (Array.isArray(orphanData)) {
      for (const row of orphanData) flat.push(row);
    } else if (orphanData && typeof orphanData === 'object') {
      for (const arr of Object.values(orphanData)) {
        if (Array.isArray(arr)) for (const row of arr) flat.push(row);
      }
    }

    const seenKeyword = new Set();
    const candidates = [];

    for (const row of flat) {
      if (!row || typeof row !== 'object') continue;
      const query = row.query ?? row.keyword;
      const impressions = Number(row.impressions ?? 0);
      const clicks = Number(row.clicks ?? 0);
      // position is optional in this dataset — when missing we treat the row
      // as inside the band (orphans are by definition poorly-ranked).
      const position =
        row.position == null || row.position === ''
          ? null
          : Number(row.position);

      if (!query || typeof query !== 'string') continue;
      if (!Number.isFinite(impressions) || impressions < MIN_IMPRESSIONS) continue;
      if (
        position != null &&
        Number.isFinite(position) &&
        (position < POSITION_MIN || position > POSITION_MAX)
      ) {
        continue;
      }

      const norm = normalizeKeyword(query);
      if (!norm || seenKeyword.has(norm)) continue;

      const queryTokens = tokenize(norm);
      let maxSim = 0;
      for (const tt of titleTokens) {
        const s = jaccard(queryTokens, tt);
        if (s > maxSim) maxSim = s;
        if (maxSim >= MAX_JACCARD_FOR_NEW) break;
      }
      if (maxSim >= MAX_JACCARD_FOR_NEW) continue;

      seenKeyword.add(norm);
      candidates.push({
        id: fnv1a8(norm),
        keyword: query,
        normalizedKeyword: norm,
        angle: null,
        locale: 'it',
        sources: ['gscOrphans'],
        demandSignals: {
          gscImpressions: impressions,
          gscClicks: clicks,
          gscPosition: position,
        },
        rationale: `GSC: ${impressions} imps${
          position != null ? ` @ pos ${position.toFixed(1)}` : ''
        } in last window — quick-win zone`,
      });
    }

    return { ok: true, candidates };
  } catch (e) {
    return {
      ok: false,
      candidates: [],
      reason: `gscOrphans: ${e.message ?? String(e)}`,
    };
  }
}

export default fetchGscOrphanCandidates;
