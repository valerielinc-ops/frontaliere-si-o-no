#!/usr/bin/env node
/**
 * bfs-announcement-article-exists.mjs — existence probe for the BFS quarterly
 * announcement article, used by `.github/workflows/refresh-bfs-stats.yml`.
 *
 * WHY (issue #5846, deferred from #5817). The workflow's «Raise editorial
 * signal for the new quarter» step had ONE condition,
 * `steps.refresh.outputs.new_quarter != ''`, and never checked whether the
 * article it asks for already existed. Because that step calls
 * `github-issue-creator.mjs --reopen-within-hours 720`, a run created after a
 * human closed the issue REOPENS it — which is exactly what happened on
 * 2026-08-12 at 20:02:04Z while the article for that quarter was already live
 * (20:21:13Z). No staleness guard would have held that run back, nor should
 * one: the run was legitimately newer than the close. The missing condition is
 * about the ARTICLE, not about time.
 *
 * THE KEY. `scripts/create-article.mjs` records every generated article in the
 * corpus' `data/article-source-urls.json` as `<normalized source URL> →
 * <article id>` (`recordSourceUrl`, which skips only `evergreen://`), and for a
 * BFS article the source URL is the synthetic per-quarter dedup key
 * `stats-bfs://<quarter>` — the same string `refresh-bfs-stats.yml` dispatches.
 * `normalizeNewsUrl` lowercases, so the stored key is lowercase. Verified
 * against the corpus on 2026-08-14:
 *
 *     "stats-bfs://2026-q2": "frontaliere-ticino-statistica-2026-q2"
 *
 * That makes the probe EXACT rather than heuristic: no title matching, no date
 * windows, no slug guessing. The published API surface
 * (`articles.json` / `meta-<locale>.json`) carries no `sourceUrl` field, so it
 * cannot answer this question — the ledger in the corpus repo is the only place
 * the mapping exists, which is why this reads the repo and not the CDN.
 *
 * WHICH REPO. Generation moved to `nanakokyobashi-rgb/frontaliere-articles`
 * with the 2026-08-02 cutover (#4974 item 3), so the ledger that matters is the
 * corpus', never this repo's copy.
 *
 * FAIL OPEN, ALWAYS. Every failure mode — no token, network error, HTTP != 200,
 * malformed JSON, unreadable ledger — reports `exists=false` and exits 0, so
 * the editorial signal is RAISED. Suppressing a real signal because a fetch
 * blipped would lose a quarter's announcement silently; raising a redundant one
 * costs a duplicate-looking issue that dedups on its own title. The asymmetry is
 * deliberate and `tests/refresh-bfs-announcement-existence-guard.test.ts`
 * pins it.
 *
 * LEDGER VALUE SHAPE. `recordSourceUrl` originally stored a plain string
 * (`<key> → <article id>`). The corpus started writing richer entries —
 * `{ articleId, ts, keyForm }` — for newer keys (observed 2026-08-19 on
 * `stats-bfs://2026-q2` itself: `{"articleId":"frontalieri-ticino-crescita-q2-2026",...}`).
 * A probe that only accepted a bare string read that shape as "key absent" —
 * the exact false negative this script exists to prevent, on the one quarter
 * it was written to catch. Both shapes are read; `articleId` is the field
 * that identifies the article either way.
 *
 * Output (GITHUB_OUTPUT): `exists=true|false`, plus `article_id=<id>` when found.
 *
 * Env:
 *   NEW_QUARTER         required, e.g. `2026-Q2`. Empty → exists=false.
 *   GITHUB_PAT_NANAKO   optional; loaded from Firebase Remote Config by
 *                       `scripts/load-rc-env.mjs`, NOT from Actions secrets.
 *                       Absent → unauthenticated read, which still works while
 *                       the corpus is public and degrades to fail-open if not.
 *   GITHUB_OUTPUT       optional, Actions step output file.
 */

import fs from 'node:fs';

const CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const LEDGER_PATH = 'data/article-source-urls.json';
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Mirror of `normalizeNewsUrl` in scripts/create-article.mjs for the
 * `stats-bfs://` shape: lowercase, no trailing slash. The generic function
 * routes through `new URL()`, which lowercases the host and leaves an empty
 * pathname for this scheme — same result as this direct form, which is used
 * here so the probe carries no dependency on the generator module.
 */
export function ledgerKeyForQuarter(quarter) {
  const q = String(quarter || '').trim();
  if (!q) return '';
  return `stats-bfs://${q}`.toLowerCase().replace(/\/$/, '');
}

/**
 * Extracts the article id from a ledger entry regardless of shape: legacy
 * plain string, or the richer `{ articleId, ts, keyForm }` object newer
 * entries use. Returns `undefined` when the entry is absent or carries no
 * usable id, so callers can keep a single `typeof === 'string'` truthiness
 * check downstream.
 */
export function articleIdFromLedgerEntry(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.articleId === 'string') {
    return entry.articleId;
  }
  return undefined;
}

function setOutput(exists, articleId) {
  console.log(`exists=${exists}`);
  if (articleId) console.log(`article_id=${articleId}`);
  if (process.env.GITHUB_OUTPUT) {
    let line = `exists=${exists}\n`;
    if (articleId) line += `article_id=${articleId}\n`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  }
}

async function fetchLedger() {
  const headers = {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'frontaliere-bfs-announcement-probe',
  };
  // `Accept: application/vnd.github.raw` is not optional: the contents API
  // returns `encoding: none` with an EMPTY body above 1 MB, which would read as
  // "ledger has no such key" — i.e. a silent false negative in the direction
  // that suppresses the signal. The raw media type streams the file at any size.
  const token = process.env.GITHUB_PAT_NANAKO || '';
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `https://api.github.com/repos/${CORPUS_REPO}/contents/${LEDGER_PATH}?ref=main`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${LEDGER_PATH} from ${CORPUS_REPO}`);
  const body = await res.text();
  if (!body.trim()) throw new Error(`empty body reading ${LEDGER_PATH} (encoding:none?)`);
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${LEDGER_PATH} is not a JSON object`);
  }
  return parsed;
}

async function main() {
  const quarter = String(process.env.NEW_QUARTER || '').trim();
  if (!quarter) {
    console.error('NEW_QUARTER vuoto — niente da verificare.');
    setOutput(false);
    return;
  }
  const key = ledgerKeyForQuarter(quarter);
  try {
    const ledger = await fetchLedger();
    const articleId = articleIdFromLedgerEntry(ledger[key]);
    if (typeof articleId === 'string' && articleId.trim()) {
      console.error(`✅ Articolo di annuncio gia' presente per ${quarter}: ${key} → ${articleId}`);
      setOutput(true, articleId.trim());
      return;
    }
    console.error(`ℹ️  Nessun articolo per ${quarter} (chiave cercata: ${key}) — il segnale editoriale va alzato.`);
    setOutput(false);
  } catch (err) {
    // Fail open: an unreadable ledger must never silence the quarter.
    console.error(`⚠️  Ledger del corpus non leggibile (${err && err.message}) — fail open, il segnale editoriale viene alzato.`);
    setOutput(false);
  }
}

await main();
