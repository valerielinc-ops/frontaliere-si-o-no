// scripts/lib/topic-sources/reddit.mjs
//
// Pulls recent self-posts from frontaliere-relevant subreddits, filters for
// high-engagement question posts, and emits Candidates. Uses Reddit's public
// JSON API (no auth, 60 req/min). 1s sleep between calls.
//
// Resilience: each fetch wrapped in try/catch; module never throws. On 429
// we attempt a one-shot Playwright fallback against old.reddit.com.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';
import { FRONTALIERI_DOMAIN_RE } from '../perf-sources/domainTerms.mjs';
import { detectLocale } from './detectLocale.mjs';

// Reddit-specific Ticino/cross-border vocabulary. We accept titles that
// either match the global frontaliere domain OR mention Ticino-life
// concepts that adjacent-relevance for our audience (work/visa/housing/
// healthcare/banking/transport in Ticino+CH context).
const REDDIT_RELEVANCE_RE = /\b(frontalier|grenzg|permess(o|i)?\s*[gbl]|visa|residenc[ye]|relocat|work|jobs?|salar|stipend|tax|fisc|impost|tass[ae]|insurance|assicur|health|sanit|krank|pension|avs|lpp|3a|pilastro|cassa|hospital|doctor|rent|affitt|housing|cas[ae]|mortgage|mutuo|mortgage|bank|bancar|account|conto|chf|euro|cambio|exchange|commute|pendolar|train|treno|sbb|bus|car|auto|frontier[ae]|border|valico|dogana|telelavoro|smart\s*working|telework|switzerland|svizzer|tessin|ticin|lugano|bellinz|chiasso|locarno|mendrisio|men dris|como|varese|milano)/i;

// Reddit increasingly blocks descriptive bot UAs (e.g. `frontaliereticino-bot/1.0`)
// from anonymous endpoints with 403 + empty body. Using a plausible-browser
// UA on a public read-only JSON endpoint stays within their ToS — we don't
// auth, don't scrape comment trees, and obey the per-IP rate limit.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

// Per-endpoint retries with backoff before falling back to Playwright.
const RETRY_DELAYS_MS = [1000, 3000];

const ENDPOINTS = [
  {
    sourceKey: 'redditTicino',
    sub: 'Ticino',
    url: 'https://www.reddit.com/r/Ticino/new.json?limit=100',
    rssUrl: 'https://www.reddit.com/r/Ticino/new/.rss?limit=100',
    fallbackHtml: 'https://old.reddit.com/r/Ticino/new',
    fallbackHtmlModern: 'https://www.reddit.com/r/Ticino/new/',
  },
  {
    sourceKey: 'redditItaly',
    sub: 'italy',
    url:
      'https://www.reddit.com/r/italy/search.json?q=' +
      encodeURIComponent('frontalieri OR grenzgaenger') +
      '&sort=new&limit=50&restrict_sr=1',
    rssUrl:
      'https://www.reddit.com/r/italy/search.rss?q=' +
      encodeURIComponent('frontalieri OR grenzgaenger') +
      '&sort=new&restrict_sr=1',
    fallbackHtml: 'https://old.reddit.com/r/italy/search?q=frontalieri&restrict_sr=on',
    fallbackHtmlModern:
      'https://www.reddit.com/r/italy/search/?q=frontalieri&restrict_sr=1&sort=new',
  },
  {
    sourceKey: 'redditLugano',
    sub: 'Lugano',
    url: 'https://www.reddit.com/r/Lugano/new.json?limit=100',
    rssUrl: 'https://www.reddit.com/r/Lugano/new/.rss?limit=100',
    fallbackHtml: 'https://old.reddit.com/r/Lugano/new',
    fallbackHtmlModern: 'https://www.reddit.com/r/Lugano/new/',
  },
  {
    sourceKey: 'redditSwitzerland',
    sub: 'Switzerland',
    url:
      'https://www.reddit.com/r/Switzerland/search.json?q=' +
      encodeURIComponent('frontalieri OR cross-border worker') +
      '&sort=new&limit=50&restrict_sr=1',
    rssUrl:
      'https://www.reddit.com/r/Switzerland/search.rss?q=' +
      encodeURIComponent('frontalieri OR cross-border worker') +
      '&sort=new&restrict_sr=1',
    fallbackHtml:
      'https://old.reddit.com/r/Switzerland/search?q=frontalieri&restrict_sr=on',
    fallbackHtmlModern:
      'https://www.reddit.com/r/Switzerland/search/?q=frontalieri&restrict_sr=1&sort=new',
  },
];

// Parse Reddit's Atom-format RSS feed into the same shape we get from JSON.
// Atom uses <entry> / <title> / <content type="html">; RSS-2 uses <item>.
// Reddit serves Atom even at .rss URLs, so we handle both.
export function parseRedditRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const blocks = [
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
  ];
  const posts = [];
  for (const m of blocks) {
    const block = m[0];
    const titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
    const title = (titleM?.[1] ?? titleM?.[2] ?? '').replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    // Reddit Atom embeds an HTML preamble in <content> with span tags noting
    // score and comment count. Best-effort parse.
    const contentM = block.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    const content = contentM?.[1] ?? '';
    const scoreM = content.match(/\[score:?\s*(-?\d+)\]/i)
      ?? content.match(/\bscore[^\d]+(\d+)/i);
    const commentsM = content.match(/\[(\d+)\s*comments?\]/i)
      ?? content.match(/(\d+)\s*comments?/i);
    posts.push({
      title,
      score: scoreM ? Number(scoreM[1]) : NaN,
      num_comments: commentsM ? Number(commentsM[1]) : NaN,
      // Atom doesn't expose is_self distinctly — assume self for question
      // posts; passesFilters checks isQuestionTitle anyway.
      is_self: true,
    });
  }
  return posts;
}

const QUESTION_PREFIX = /^(come|quando|quanto|perche|perché|chi|cosa|dove|qualcuno sa|consigli|domanda|ho bisogno|aiuto|where|how|when|how much|anyone)\b/i;

export function isQuestionTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  if (t.endsWith('?')) return true;
  return QUESTION_PREFIX.test(t);
}

export function passesFilters(post) {
  if (!post || typeof post !== 'object') return false;
  if (post.is_self !== true) return false;
  const score = Number(post.score ?? 0);
  const comments = Number(post.num_comments ?? 0);
  if (!(score >= 5)) return false;
  if (!(comments >= 3)) return false;
  if (!isQuestionTitle(post.title)) return false;
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    const res = await f(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const e = new Error(`reddit ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    const res = await f(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const e = new Error(`reddit-rss ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// Pull posts out of a Reddit listing JSON.
export function extractPosts(json) {
  const children = json?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((c) => c?.data)
    .filter((d) => d && typeof d === 'object');
}

async function _scrapeOldReddit(page, htmlUrl) {
  await page.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Use `.thing` (not `.thing.self`) — link-mostly subs (r/Ticino, r/italy)
  // surface question posts as link posts, and `.thing.self` filtering would
  // exclude them. The caller's `passesFilters` does the is_self check after.
  return page.$$eval('.thing', (nodes) =>
    nodes.map((n) => {
      const title = n.querySelector('a.title')?.textContent?.trim() ?? '';
      const score = Number(
        n.querySelector('.score.unvoted')?.getAttribute('title') ?? 0,
      );
      const num_comments = Number(
        (n.querySelector('a.comments')?.textContent ?? '0').match(/\d+/)?.[0] ?? 0,
      );
      // Mark as is_self=true so `passesFilters` accepts: old.reddit's CSS
      // doesn't reliably tag self vs link posts in the `.thing` class chain
      // anymore. The filter's score/comments/question-prefix gates do the
      // real quality work.
      return { title, score, num_comments, is_self: true };
    }),
  );
}

async function _scrapeModernReddit(page, htmlUrl) {
  await page.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Modern Reddit ships posts as `[data-testid="post-container"]`. Wait for
  // at least one before extracting (lazy hydration). Quietly return [] on
  // selector miss.
  try {
    await page.waitForSelector('[data-testid="post-container"]', { timeout: 5000 });
  } catch {
    return [];
  }
  return page.$$eval('[data-testid="post-container"]', (nodes) =>
    nodes.map((n) => {
      const title =
        n.querySelector('h1, h2, h3, [data-testid="post-content"] a')?.textContent?.trim() ?? '';
      // Modern UI buries vote counts behind aria-labels; fall back to
      // visible text. Score/comments often mid-page reload, so we accept
      // 0 as a sentinel and let the upstream filter drop these gracefully.
      const score = Number(
        n.querySelector('[data-testid="vote-score"]')?.textContent?.replace(/[^0-9]/g, '') ?? 0,
      );
      const num_comments = Number(
        n.querySelector('[data-testid="comments-action-button"]')
          ?.textContent?.match(/\d+/)?.[0] ?? 0,
      );
      return { title, score, num_comments, is_self: true };
    }),
  );
}

async function playwrightFallback(endpointOrUrl) {
  // Accept either the legacy string-URL form (old.reddit only) or an
  // endpoint object with both old + modern URLs. The orchestrator below
  // passes the object form; tests passing a string still work.
  const oldUrl =
    typeof endpointOrUrl === 'string'
      ? endpointOrUrl
      : endpointOrUrl?.fallbackHtml;
  const modernUrl =
    typeof endpointOrUrl === 'string' ? null : endpointOrUrl?.fallbackHtmlModern;

  let browser = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();

    let items = [];
    if (oldUrl) {
      try {
        items = await _scrapeOldReddit(page, oldUrl);
      } catch {
        items = [];
      }
    }

    // Second-tier fallback: if old.reddit returned nothing (rendered empty,
    // banned, or selectors changed), try modern Reddit. Same browser context.
    if (items.length === 0 && modernUrl) {
      try {
        items = await _scrapeModernReddit(page, modernUrl);
      } catch {
        items = [];
      }
    }
    return items;
  } catch {
    return [];
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
  }
}

// Subreddit → audience-size baseline (rough public estimates as of 2026).
// Used as an RSS-mode demand baseline so candidates from r/Switzerland (~250k)
// don't tie 1:1 with candidates from r/Lugano (~5k). This is NOT engagement;
// it's just "these subs have different reach, so a fresh post in r/Switzerland
// reaches more eyeballs by default than one in r/Lugano".
const SUBREDDIT_AUDIENCE_BASELINE = {
  Switzerland: 30, // ~250k members
  italy: 25, // ~600k but only frontalieri-restricted search subset
  Ticino: 15, // ~25k
  Lugano: 8, // ~5k
};

function postToCandidate(post, sourceKey, sub) {
  // RSS posts may have NaN score/comments (Atom feed doesn't expose them
  // reliably). Coerce to 0 — the candidate's demandSignals will reflect
  // the lower-confidence source via `redditViaRss`.
  const rawScore = Number(post.score);
  const rawComments = Number(post.num_comments);
  let score = Number.isFinite(rawScore) ? rawScore : 0;
  let comments = Number.isFinite(rawComments) ? rawComments : 0;
  const title = String(post.title || '').trim();
  const norm = normalizeKeyword(title);
  const fromRss = post._source === 'rss';
  // Locale heuristic: r/Switzerland is mixed EN/DE, r/italy IT, r/Ticino IT,
  // r/Lugano IT. detectLocale() reads markers in the title itself for the
  // most accurate per-post tag.
  const locale = detectLocale(title);

  // RSS-mode demand baseline: combine subreddit-audience baseline with a
  // recency decay (newer posts in the RSS feed get a higher score). Without
  // this, every RSS Reddit candidate ties at redditCombined=0 → demandScore=0
  // → totalScore=0.40, with no quality differentiation in the candidate list.
  if (fromRss) {
    const audienceBaseline = SUBREDDIT_AUDIENCE_BASELINE[sub] ?? 5;
    const rssPosition = Number(post._rssPosition ?? 99);
    // Recency decay: position 0 (newest) → full baseline; position 25 → 50%.
    const recencyFactor = Math.max(0.5, 1 - rssPosition * 0.02);
    score = Math.round(audienceBaseline * recencyFactor);
    comments = 0;
  }
  const combined = fromRss ? score : score + comments * 2;
  return {
    id: fnv1a8(norm),
    keyword: title,
    normalizedKeyword: norm,
    angle: null,
    locale,
    sources: [sourceKey],
    demandSignals: {
      redditScore: score,
      redditComments: comments,
      redditCombined: combined,
      redditSubreddit: sub,
      redditViaRss: fromRss,
      redditUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    },
    rationale: fromRss
      ? `Reddit r/${sub} RSS feed — recency-based baseline ${combined} (engagement unavailable)`
      : `Reddit r/${sub}: score ${score}, ${comments} comments`,
  };
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — test override.
 * @param {Function} [opts.sleepFn] — test override.
 * @param {Function} [opts.playwrightFallback] — test override.
 * @returns {Promise<{ ok: boolean, perSubreddit: Record<string, {ok: boolean, candidates: any[], reason?: string}>, candidates: any[] }>}
 */
export async function fetchRedditCandidates(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepFn = opts.sleepFn ?? sleep;
  const fallback = opts.playwrightFallback ?? playwrightFallback;

  const perSubreddit = {};
  const all = [];
  const seenAcross = new Set();

  for (let i = 0; i < ENDPOINTS.length; i++) {
    const ep = ENDPOINTS[i];
    let posts = [];
    let ok = true;
    let reason = null;
    let lastErr = null;

    // Retry the JSON endpoint up to RETRY_DELAYS_MS.length+1 times before
    // falling back to Playwright. 403s in particular are often transient
    // (UA-bucket rotation on Reddit's edge).
    let attempt = 0;
    let success = false;
    while (attempt <= RETRY_DELAYS_MS.length) {
      try {
        const json = await fetchJson(ep.url, fetchImpl);
        posts = extractPosts(json);
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleepFn(RETRY_DELAYS_MS[attempt]);
        }
        attempt++;
      }
    }
    if (!success) {
      ok = false;
      reason = String(lastErr?.message ?? lastErr ?? 'unknown').slice(0, 200);

      // Tier 2: try the public Atom feed. Reddit's RSS endpoints are
      // typically less aggressively rate-limited than the JSON API because
      // Reddit expects RSS readers to hit them. Score / num_comments are
      // unreliable from RSS so we relax those filters and stamp the post
      // with `_source: 'rss'` for downstream attribution.
      if (ep.rssUrl) {
        try {
          const xml = await fetchText(ep.rssUrl, fetchImpl);
          const rssPosts = parseRedditRss(xml).map((p) => ({ ...p, _source: 'rss' }));
          if (rssPosts.length > 0) {
            posts = rssPosts;
            ok = true;
            reason = null;
            success = true;
          }
        } catch {
          /* fall through to Playwright */
        }
      }
    }
    if (!success) {
      // Tier 3: Playwright fallback (old.reddit then modern www.reddit).
      // The fallback receives the whole endpoint so it can try both URLs
      // in one browser context.
      try {
        posts = await fallback(ep);
      } catch {
        posts = [];
      }
    }

    const candidates = [];
    for (const p of posts) {
      // RSS-sourced posts have unreliable score/comments — only enforce the
      // question-title filter on those; for JSON/Playwright keep the full
      // engagement gate.
      const passes = p._source === 'rss' ? isQuestionTitle(p.title) : passesFilters(p);
      if (!passes) continue;
      // RELEVANCE FILTER: drop posts that aren't about cross-border-worker
      // life. r/Lugano had 0/16 frontaliere-relevant titles; r/Ticino had
      // 23%. Without this filter, "Pilates studios?", "What are some bars
      // for a cheap drink?", and dating questions dominate the candidate
      // pool. The regex is broader than FRONTALIERI_DOMAIN_RE because
      // Reddit posts often probe adjacent topics (housing/banking/transport
      // in Ticino) that are still article-worthy for our audience.
      if (!REDDIT_RELEVANCE_RE.test(p.title)) continue;
      const norm = normalizeKeyword(p.title);
      if (!norm || seenAcross.has(norm)) continue;
      seenAcross.add(norm);
      // Stamp position-in-feed onto the post so RSS-sourced candidates can
      // differentiate by recency (RSS lists newest first). Without this all
      // RSS Reddit candidates tie at demandScore=0 / totalScore=0.40.
      const stamped = { ...p, _rssPosition: posts.indexOf(p) };
      candidates.push(postToCandidate(stamped, ep.sourceKey, ep.sub));
    }

    perSubreddit[ep.sourceKey] = candidates.length
      ? { ok: true, candidates }
      : { ok, candidates: [], reason: reason ?? 'no qualifying posts' };
    for (const c of candidates) all.push(c);

    if (i < ENDPOINTS.length - 1) await sleepFn(REQUEST_GAP_MS);
  }

  const overallOk = Object.values(perSubreddit).some(
    (s) => s.ok && s.candidates.length > 0,
  );
  return { ok: overallOk, perSubreddit, candidates: all };
}

export default fetchRedditCandidates;
