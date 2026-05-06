// scripts/lib/topic-sources/reddit.mjs
//
// Pulls recent self-posts from frontaliere-relevant subreddits, filters for
// high-engagement question posts, and emits Candidates. Uses Reddit's public
// JSON API (no auth, 60 req/min). 1s sleep between calls.
//
// Resilience: each fetch wrapped in try/catch; module never throws. On 429
// we attempt a one-shot Playwright fallback against old.reddit.com.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';

const USER_AGENT = 'frontaliereticino-bot/1.0 (https://frontaliereticino.ch)';
const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

const ENDPOINTS = [
  {
    sourceKey: 'redditTicino',
    sub: 'Ticino',
    url: 'https://www.reddit.com/r/Ticino/new.json?limit=100',
    fallbackHtml: 'https://old.reddit.com/r/Ticino/new',
  },
  {
    sourceKey: 'redditItaly',
    sub: 'italy',
    url:
      'https://www.reddit.com/r/italy/search.json?q=' +
      encodeURIComponent('frontalieri OR grenzgaenger') +
      '&sort=new&limit=50&restrict_sr=1',
    fallbackHtml: 'https://old.reddit.com/r/italy/search?q=frontalieri&restrict_sr=on',
  },
  {
    sourceKey: 'redditLugano',
    sub: 'Lugano',
    url: 'https://www.reddit.com/r/Lugano/new.json?limit=100',
    fallbackHtml: 'https://old.reddit.com/r/Lugano/new',
  },
  {
    sourceKey: 'redditSwitzerland',
    sub: 'Switzerland',
    url:
      'https://www.reddit.com/r/Switzerland/search.json?q=' +
      encodeURIComponent('frontalieri OR cross-border worker') +
      '&sort=new&limit=50&restrict_sr=1',
    fallbackHtml:
      'https://old.reddit.com/r/Switzerland/search?q=frontalieri&restrict_sr=on',
  },
];

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

// Pull posts out of a Reddit listing JSON.
export function extractPosts(json) {
  const children = json?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((c) => c?.data)
    .filter((d) => d && typeof d === 'object');
}

async function playwrightFallback(htmlUrl) {
  let browser = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();
    await page.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const items = await page.$$eval('.thing.self', (nodes) =>
      nodes.map((n) => {
        const title =
          n.querySelector('a.title')?.textContent?.trim() ?? '';
        const score = Number(
          n.querySelector('.score.unvoted')?.getAttribute('title') ?? 0,
        );
        const num_comments = Number(
          (n.querySelector('a.comments')?.textContent ?? '0').match(/\d+/)?.[0] ?? 0,
        );
        return { title, score, num_comments, is_self: true };
      }),
    );
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

function postToCandidate(post, sourceKey, sub) {
  const score = Number(post.score ?? 0);
  const comments = Number(post.num_comments ?? 0);
  const title = String(post.title || '').trim();
  const norm = normalizeKeyword(title);
  return {
    id: fnv1a8(norm),
    keyword: title,
    normalizedKeyword: norm,
    angle: null,
    locale: sub === 'Switzerland' || sub === 'italy' ? 'it' : 'it',
    sources: [sourceKey],
    demandSignals: {
      redditScore: score,
      redditComments: comments,
      redditCombined: score + comments * 2,
      redditSubreddit: sub,
      redditUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    },
    rationale: `Reddit r/${sub}: score ${score}, ${comments} comments`,
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
    try {
      const json = await fetchJson(ep.url, fetchImpl);
      posts = extractPosts(json);
    } catch (e) {
      ok = false;
      reason = String(e?.message ?? e).slice(0, 200);
      // 429 or any error: ONE Playwright fallback attempt.
      try {
        posts = await fallback(ep.fallbackHtml);
      } catch {
        posts = [];
      }
    }

    const candidates = [];
    for (const p of posts) {
      if (!passesFilters(p)) continue;
      const norm = normalizeKeyword(p.title);
      if (!norm || seenAcross.has(norm)) continue;
      seenAcross.add(norm);
      candidates.push(postToCandidate(p, ep.sourceKey, ep.sub));
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
