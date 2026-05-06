// scripts/lib/topic-sources/facebookPages.mjs
//
// Pulls recent posts from a small list of public Ticino/Lombardia news pages
// via the Facebook Graph API. Filters posts mentioning frontaliere-related
// keywords with non-trivial engagement. Emits Candidates whose keyword is
// a 80-char prefix of the post message.
//
// Resilience: every fetch is try/catch'd; module never throws. If
// FB_PAGE_ACCESS_TOKEN is missing or the page list is empty, returns
// `{ ok: false, candidates: [], reason }`.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';

// Public page usernames — Graph API resolves these to numeric IDs. We do NOT
// hardcode numeric IDs because they were not findable in this repo within
// the time budget; if Graph rejects the username, we'll skip that page.
const DEFAULT_PAGES = [
  'tio.ch',
  'CorrieredelTicino',
  'rsicultura', // best-effort RSI cultural page; may not resolve
  'laRegioneTicino',
  'varesenews',
];

const KEYWORD_RE =
  /(frontalier|frontaliere|frontalieri|grenzg(ä|a)nger|permesso\s*g|svizzera-italia|tasse\s*2026)/i;

const MIN_ENGAGEMENT = 20;
const MAX_MESSAGE_PREFIX = 80;

const REQUEST_TIMEOUT_MS = 15000;

async function fetchJson(url, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    const res = await f(url, { signal: ac.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const e = new Error(
        `facebook ${res.status}${txt ? ` ${txt.slice(0, 120)}` : ''}`,
      );
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export function postPassesFilter(post) {
  if (!post || typeof post !== 'object') return false;
  const message = String(post.message ?? '');
  if (!message) return false;
  if (!KEYWORD_RE.test(message)) return false;
  const reactions = Number(post?.reactions?.summary?.total_count ?? 0);
  const comments = Number(post?.comments?.summary?.total_count ?? 0);
  return reactions + comments >= MIN_ENGAGEMENT;
}

export function postToCandidate(post, pageRef) {
  const message = String(post.message ?? '').trim().replace(/\s+/g, ' ');
  const keyword = message.slice(0, MAX_MESSAGE_PREFIX);
  const norm = normalizeKeyword(keyword);
  const reactions = Number(post?.reactions?.summary?.total_count ?? 0);
  const comments = Number(post?.comments?.summary?.total_count ?? 0);
  return {
    id: fnv1a8(norm || keyword),
    keyword,
    normalizedKeyword: norm,
    angle: null,
    locale: 'it',
    sources: ['facebookPages'],
    demandSignals: {
      facebookReactions: reactions,
      facebookComments: comments,
      facebookEngagement: reactions + comments,
      facebookPage: pageRef,
      facebookCreatedTime: post.created_time ?? null,
    },
    rationale: `Facebook ${pageRef}: ${reactions} reactions + ${comments} comments`,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.token] — defaults to process.env.FB_PAGE_ACCESS_TOKEN.
 * @param {string[]} [opts.pages] — page usernames or numeric IDs.
 * @param {Function} [opts.fetchImpl] — test override.
 */
export async function fetchFacebookCandidates(opts = {}) {
  const token = opts.token ?? process.env.FB_PAGE_ACCESS_TOKEN;
  const pages = opts.pages ?? DEFAULT_PAGES;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  if (!token) {
    return { ok: false, candidates: [], reason: 'no FB_PAGE_ACCESS_TOKEN' };
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason: 'no public page IDs configured',
    };
  }

  const all = [];
  const seenNorm = new Set();
  const perPage = {};
  let anyOk = false;

  for (const ref of pages) {
    const url =
      `https://graph.facebook.com/v19.0/${encodeURIComponent(ref)}/posts` +
      `?fields=message,created_time,reactions.summary(total_count),comments.summary(total_count)` +
      `&limit=50&access_token=${encodeURIComponent(token)}`;

    let json = null;
    try {
      json = await fetchJson(url, fetchImpl);
    } catch (e) {
      perPage[ref] = {
        ok: false,
        candidates: 0,
        reason: String(e?.message ?? e).slice(0, 200),
      };
      continue;
    }

    const posts = Array.isArray(json?.data) ? json.data : [];
    let added = 0;
    for (const p of posts) {
      if (!postPassesFilter(p)) continue;
      const cand = postToCandidate(p, ref);
      if (!cand.normalizedKeyword || seenNorm.has(cand.normalizedKeyword)) continue;
      seenNorm.add(cand.normalizedKeyword);
      all.push(cand);
      added++;
    }
    perPage[ref] = { ok: true, candidates: added };
    if (added > 0) anyOk = true;
  }

  return {
    ok: anyOk,
    candidates: all,
    perPage,
    reason: anyOk ? undefined : 'no qualifying FB posts',
  };
}

export default fetchFacebookCandidates;
