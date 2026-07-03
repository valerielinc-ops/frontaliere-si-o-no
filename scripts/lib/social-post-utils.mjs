/**
 * Channel-agnostic helpers shared by the social job schedulers.
 *
 * These utilities are deliberately free of any Facebook / Reddit / channel
 * specifics: they sanitize job text, pick the most-recent never-posted jobs,
 * build the canonical IT job-board URL, and read/write a JSON "posted" ledger
 * parameterized by file path so any social channel can keep its own dedup
 * state. They are imported by both `schedule-fb-jobs-daily.mjs` and
 * `schedule-reddit-jobs-daily.mjs` so the same logic is never duplicated
 * across schedulers (project rule: a regex/constant/helper duplicated
 * literally in ≥2 files MUST live in ONE shared module).
 *
 * Channel-specific formatting (FB captions/hashtags, Reddit titles/markdown,
 * place-id lookup, API run loops) stays in the per-channel scripts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ── Constants ───────────────────────────────────────────────

export const SITE_URL = 'https://frontaliereticino.ch';
export const JOB_BOARD_PREFIX_IT = '/cerca-lavoro-ticino/';

// ── Sanitization helpers ────────────────────────────────────

export function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')                  // HTML tags
    // Markdown headings — match at line start (multiline) AND inline
    // (after whitespace) so leftovers from HTML→text flattening like
    // "Avviare... ## Tasks - Si installa..." are also cleaned.
    .replace(/(^|\s)#{1,6}\s+/gm, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // markdown bold
    .replace(/\*([^*]+)\*/g, '$1')             // markdown italic
    .replace(/(^|\s)[-*+]\s+/gm, '$1')         // markdown list bullets
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Section labels that often leak into the body when a job description
// uses HTML headings/lists. Stripped only when they appear at the very start
// of the body, optionally followed by `:` or `-`.
const LEADING_SECTION_LABELS = [
  'descrizione',
  'description',
  'descrição',
  'beschreibung',
  'beschrijving',
  'mansioni',
  'compiti',
  'profilo',
  'profile',
  'profil',
  'requisiti',
  'requirements',
  'about us',
  'chi siamo',
  'who we are',
  'job description',
  'about the job',
  'company description',
  "l'offerta",
  'l offerta',
  'la posizione',
  'le tue mansioni',
  'i tuoi compiti',
  'le tue responsabilità',
];

export function stripLeadingSectionLabel(s) {
  if (!s) return '';
  const sorted = [...LEADING_SECTION_LABELS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^(?:${escaped.join('|')})\\s*[:\\-–—]?\\s+`, 'i');
  return s.replace(re, '').trim();
}

export function stripDiacritics(s) {
  if (!s) return '';
  // Strip U+0300–U+036F (Combining Diacritical Marks) after NFD decomposition.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function truncateBody(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  // Try to truncate at last sentence break before maxLen.
  const window = text.slice(0, maxLen);
  const lastSentence = Math.max(
    window.lastIndexOf('.'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
  );
  if (lastSentence >= Math.floor(maxLen * 0.5)) {
    return window.slice(0, lastSentence + 1).trim();
  }
  // Fall back to last space.
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLen * 0.5)) {
    return window.slice(0, lastSpace).trim() + '…';
  }
  // Reserve one char for the ellipsis so the result never exceeds maxLen.
  // Matters for hard-limited fields (e.g. Reddit's 300-char title cap):
  // appending '…' to a full maxLen window would yield maxLen+1 and be
  // rejected at submit time.
  return window.slice(0, maxLen - 1).trim() + '…';
}

// ── Job selection ───────────────────────────────────────────

export function recencyTs(job) {
  const candidates = [job?.firstSeenAt, job?.crawledAt, job?.postedDate];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Filter never-posted jobs from `jobs`, sort by recency descending, take
 * top `limit`. Mirrors the selection rule of submit-google-indexing-jobs.
 *
 * @param {Array<object>} jobs
 * @param {Set<string>} postedSet — set of jobIds already posted
 * @param {number} limit
 */
export function selectUnpostedJobs(jobs, postedSet, limit) {
  if (!Array.isArray(jobs)) return [];
  const list = jobs.filter((j) => {
    if (!j || !j.id) return false;
    if (postedSet.has(j.id)) return false;
    // Skip jobs flagged by the translate-pending workflow as still
    // needing translation. Without this, the scheduler picks up
    // German/French source titles and emits e.g. "Verkäufer*in" or
    // "Transportdisponent*in" as the post headline — wrong language
    // for an Italian audience. CLAUDE.md documents this same flag for
    // locale-completeness checks.
    if (j.needsRetranslation === true) return false;
    return true;
  });
  list.sort((a, b) => recencyTs(b) - recencyTs(a));
  return list.slice(0, Math.max(0, limit | 0));
}

// ── URL building ────────────────────────────────────────────

/**
 * Build the canonical IT-locale job-board URL for a job. The site's
 * Italian-language job pages live under `JOB_BOARD_PREFIX_IT`. Slug source
 * order: slugByLocale.it → slug. Returns null when the job has no slug.
 */
export function buildJobUrl(job) {
  const slug = job?.slugByLocale?.it || job?.slug;
  if (!slug) return null;
  return `${SITE_URL}${JOB_BOARD_PREFIX_IT}${slug}/`;
}

// ── Posted-jobs ledger I/O ──────────────────────────────────

/**
 * Read a posted-jobs ledger from `filePath`. Returns
 * `{schemaVersion:1, posted:[]}` on missing file, malformed JSON, or shape
 * mismatch — never throws. Channel-agnostic: each scheduler passes its own
 * ledger path.
 *
 * @param {string} filePath
 */
export function loadLedger(filePath) {
  try {
    if (!existsSync(filePath)) return { schemaVersion: 1, posted: [] };
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posted)) {
      return { schemaVersion: 1, posted: [] };
    }
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      posted: parsed.posted,
    };
  } catch {
    return { schemaVersion: 1, posted: [] };
  }
}

/**
 * Append entries to the ledger at `filePath` and write it back. Trims to the
 * last `trimLimit` entries. No-op (and never throws) when `entries` is empty
 * or not an array. Channel-agnostic: each scheduler passes its own ledger
 * path and trim cap.
 *
 * @param {string} filePath
 * @param {Array<object>} entries
 * @param {number} [trimLimit=1000]
 */
export function appendLedger(filePath, entries, trimLimit = 1000) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const current = loadLedger(filePath);
  const merged = current.posted.concat(entries);
  const trimmed = merged.slice(Math.max(0, merged.length - trimLimit));
  const out = { schemaVersion: 1, posted: trimmed };
  writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

// ── Article (blog) social helpers ───────────────────────────
// Shared by the manual `post-to-facebook.mjs` CLI and the scheduled
// `schedule-fb-articles-daily.mjs` cron so the FB article caption/URL logic
// lives in ONE place (project rule: a helper/constant duplicated literally in
// ≥2 files MUST be extracted). Job-specific caption/hashtag logic stays in the
// per-job scheduler; this block is the blog-article twin.

// Localized (IT) URL hub slug per article section. Mirrors the `indexSlug.it`
// of `services/articleSections.ts` and the inline hub map in
// `.github/workflows/generate-article.yml`. IT-only because the FB audience
// reads Italian and the canonical og:url is the IT page.
export const ARTICLE_HUB_SLUG_IT = {
  frontaliere: 'articoli-frontaliere',
  svizzera: 'articoli-svizzera',
};

// FB Place ID used to geo-anchor article posts for FB Search discovery.
// 106534719384213 = "Lugano, Switzerland" (verified live) — the canonical
// city for the cross-border / Ticino audience. Kept identical to the value
// the per-deploy poster used so the scheduled poster is behaviourally a
// drop-in replacement.
export const ARTICLE_PLACE_ID = '106534719384213';

// category → user-facing hashtag line / emoji. Default covers articles with no
// (or an unknown) category. Values byte-identical to the historical
// post-to-facebook.mjs maps so captions don't drift after the cutover.
export const ARTICLE_CATEGORY_HASHTAGS = {
  fiscale: '#frontalieri #ticino #tasse #fisco #svizzera #italia',
  pratico: '#frontalieri #ticino #lavoro #svizzera #guidapratica',
  novita: '#frontalieri #ticino #news #svizzera #italia #novità',
  pensione: '#frontalieri #ticino #pensione #AVS #previdenza',
};
export const DEFAULT_ARTICLE_HASHTAGS = '#frontalieri #ticino #lavoro #svizzera #italia';
export const ARTICLE_CATEGORY_EMOJI = {
  fiscale: '📊',
  pratico: '📋',
  novita: '🗞️',
  pensione: '🏦',
};

/**
 * Build the canonical IT-locale article URL. Always trailing-slash (site
 * convention — the no-slash form serves a JS redirect bridge with no OG meta,
 * which the FB crawler can't follow). Returns null when section/slug missing.
 *
 * @param {'frontaliere'|'svizzera'} section
 * @param {string} slugIt
 */
export function buildArticleUrl(section, slugIt) {
  const hub = ARTICLE_HUB_SLUG_IT[section];
  if (!hub || !slugIt) return null;
  return `${SITE_URL}/${hub}/${slugIt}/`;
}

/**
 * Build the FB caption for a blog article. Mirrors the original
 * post-to-facebook.mjs message format byte-for-byte:
 *
 *   {emoji} {ogTitle}
 *
 *   {ogDescription}
 *
 *   👉 Leggi l'articolo completo:
 *
 *   {hashtags}
 *
 * @param {{ ogTitle: string, ogDescription?: string, category?: string }} article
 */
export function buildArticleCaption({ ogTitle, ogDescription, category }) {
  const emoji = ARTICLE_CATEGORY_EMOJI[category] || '📰';
  const hashtags = ARTICLE_CATEGORY_HASHTAGS[category] || DEFAULT_ARTICLE_HASHTAGS;
  const description = ogDescription || '';
  return [
    `${emoji} ${ogTitle}`,
    '',
    description,
    '',
    `👉 Leggi l'articolo completo:`,
    '',
    hashtags,
  ].join('\n').trim();
}

// ── Landing-page pre-flight (immediate posters) ─────────────

const PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * HEAD-check that a just-built landing page is actually live before an
 * immediate (non-scheduled) poster links to it. Immediate posters link to
 * per-comune / per-article pages emitted at build time; if the deploy is
 * slow or retrying, the page can still 404 at click-time — posting anyway
 * would burn the click on a dead link with zero ad impression.
 *
 * HEAD-only (cheap, no body), bounded by a timeout via AbortController (same
 * pattern as `scripts/probe-5xx.mjs`) so one slow/hanging comune can't stall
 * the whole batch — callers should run these concurrently (Promise.allSettled).
 *
 * Fails safe: a clean 4xx OR a network error/timeout both count as "not
 * live" and the caller should skip the post. A missing/ambiguous status
 * (e.g. a minimal test mock, or a 5xx which may just be a transient CDN
 * blip) is treated as live so it never blocks posting on something that
 * isn't actually a dead link.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isLandingPageLive(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || PREFLIGHT_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: controller.signal });
    if (res && typeof res.status === 'number' && res.status >= 400 && res.status < 500) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
