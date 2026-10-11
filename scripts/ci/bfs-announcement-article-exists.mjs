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
 * THE KEY. `scripts/create-article.mjs` records generated articles in the
 * corpus' `data/article-source-urls.json` as `<normalized source URL> →
 * <article id>`. For a BFS article the source URL is the synthetic per-quarter
 * key `stats-bfs://<quarter>` — the same string the site dispatches. This is
 * the exact proof when the key is still in the corpus ledger, but the generator
 * deliberately retains only its last 500 URL entries. An announcement can be
 * older than that FIFO window while still being published, so a missing key is
 * NOT proof that the article is absent.
 *
 * FALLBACK. When the exact key is missing, read the published manifest and the
 * complete Italian frontaliere article index over HTTP. A published index entry
 * is accepted only when the ledger's candidate ID is present in it, or its
 * title/excerpt jointly identify the requested quarter, BFS and frontalieri.
 * The manifest count must match the index count and array length; incomplete or
 * stale data fails open and raises the editorial signal.
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

import fs, { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ARTICLES_API_BASE } from '../lib/articles-api-base.mjs';

const CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const LEDGER_PATH = 'data/article-source-urls.json';
const PUBLISHED_INDEX_PATH = 'data/blog-index-frontaliere-it-full.json';
const ARTICLES_API = ARTICLES_API_BASE.replace(/\/$/, '');
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

/** The index is usable only when it proves that the published list is whole. */
export function isCompletePublishedIndex(index, expectedArticleCount) {
  return Number.isSafeInteger(expectedArticleCount)
    && expectedArticleCount > 0
    && index?.section === 'frontaliere'
    && index?.locale === 'it'
    && index.count === expectedArticleCount
    && index.total === expectedArticleCount
    && Array.isArray(index.articles)
    && index.articles.length === expectedArticleCount;
}

/**
 * Resolve an announcement only from a complete, public index. An ID from the
 * exact source ledger is authoritative once it is present in the published
 * index. If the bounded ledger has evicted the key, use a narrow metadata
 * fallback: quarter + BFS + frontalieri must all occur in the same entry.
 */
export function articleIdFromPublishedIndex(index, quarter, expectedArticleCount, ledgerArticleId = '') {
  if (!isCompletePublishedIndex(index, expectedArticleCount)) return undefined;

  const match = String(quarter || '').trim().match(/^(\d{4})-Q([1-4])$/i);
  if (!match) return undefined;
  const [, year, quarterNumber] = match;
  const quarterPattern = new RegExp(`\\b${year}\\s*[-–]?\\s*Q${quarterNumber}\\b|\\bQ${quarterNumber}\\s+${year}\\b`, 'i');
  const ledgerId = String(ledgerArticleId || '').trim();
  const articles = index.articles;

  if (ledgerId && articles.some((article) => article?.id === ledgerId)) return ledgerId;

  const found = articles.find((article) => {
    const id = typeof article?.id === 'string' ? article.id.trim() : '';
    if (!id) return false;
    const evidence = [article.title, article.excerpt]
      .filter((value) => typeof value === 'string')
      .join('\n');
    return quarterPattern.test(evidence)
      && /\bBFS\b|ufficio\s+federale\s+di\s+statistica/i.test(evidence)
      && /\bfrontalier\w*\b/i.test(evidence);
  });
  return found?.id?.trim() || undefined;
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

async function fetchPublishedIndex() {
  const headers = { Accept: 'application/json', 'User-Agent': 'frontaliere-bfs-announcement-probe' };
  const manifestUrl = `${ARTICLES_API}/manifest.json`;
  const manifestResponse = await fetch(manifestUrl, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status} reading published manifest`);
  const manifest = await manifestResponse.json();
  const expectedArticleCount = manifest?.counts?.articles;
  const indexBytes = manifest?.files?.[PUBLISHED_INDEX_PATH];
  if (!Number.isSafeInteger(expectedArticleCount) || expectedArticleCount < 1) {
    throw new Error('published manifest has no valid counts.articles');
  }
  if (!Number.isSafeInteger(indexBytes) || indexBytes < 1) {
    throw new Error(`published manifest does not list ${PUBLISHED_INDEX_PATH}`);
  }
  if (typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.commit)) {
    throw new Error('published manifest has no valid corpus commit');
  }

  const indexUrl = `${ARTICLES_API}/${PUBLISHED_INDEX_PATH}?commit=${encodeURIComponent(manifest.commit)}`;
  const indexResponse = await fetch(indexUrl, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!indexResponse.ok) throw new Error(`HTTP ${indexResponse.status} reading ${PUBLISHED_INDEX_PATH}`);
  const index = await indexResponse.json();
  if (!isCompletePublishedIndex(index, expectedArticleCount)) {
    throw new Error(`${PUBLISHED_INDEX_PATH} is incomplete or disagrees with manifest counts`);
  }
  return { index, expectedArticleCount };
}

async function main() {
  const quarter = String(process.env.NEW_QUARTER || '').trim();
  if (!quarter) {
    console.error('NEW_QUARTER vuoto — niente da verificare.');
    setOutput(false);
    return;
  }
  const key = ledgerKeyForQuarter(quarter);
  let ledgerArticleId = '';
  try {
    const ledger = await fetchLedger();
    ledgerArticleId = articleIdFromLedgerEntry(ledger[key])?.trim() || '';
  } catch (err) {
    // The public API below can still prove publication when the ledger is unavailable.
    console.error(`⚠️  Ledger del corpus non leggibile (${err && err.message}) — verifico comunque l'API pubblicata.`);
  }

  try {
    const { index, expectedArticleCount } = await fetchPublishedIndex();
    const articleId = articleIdFromPublishedIndex(index, quarter, expectedArticleCount, ledgerArticleId);
    if (articleId) {
      const proof = ledgerArticleId === articleId ? 'ledger + API pubblicata' : 'API pubblicata';
      console.error(`✅ Articolo di annuncio gia' pubblicato per ${quarter} (${proof}): ${articleId}`);
      setOutput(true, articleId);
      return;
    }
    console.error(`ℹ️  Nessun articolo BFS pubblicato per ${quarter} (chiave ledger: ${key}) — il segnale editoriale va alzato.`);
    setOutput(false);
  } catch (err) {
    // Fail open: an incomplete/unavailable public API must never silence the quarter.
    console.error(`⚠️  API articoli del corpus non leggibile (${err && err.message}) — fail open, il segnale editoriale viene alzato.`);
    setOutput(false);
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) await main();
