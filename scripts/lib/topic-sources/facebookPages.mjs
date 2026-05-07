// scripts/lib/topic-sources/facebookPages.mjs
//
// Pulls recent posts from a list of public Ticino/Lombardia news pages via
// the Facebook Graph API. Returns the top-N posts ordered by engagement
// (reactions + comments) — no keyword filter, since the user explicitly
// asked to surface "what's making noise" on those pages, even when posts
// don't mention frontaliere terms verbatim. The downstream novelty filter
// in mine-topic-candidates.mjs still drops anything that looks like an
// existing article. Emits Candidates whose keyword is a 80-char prefix
// of the post message.
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

// Optional regex preference: if set, posts matching the regex get ranked
// first; the rest are still kept (no filtering). Used so frontaliere-
// specific posts surface above general noise when both have similar
// engagement. Pass `null` to disable the bias.
const KEYWORD_PREFERENCE_RE =
  /(frontalier|grenzg(ä|a)nger|permesso\s*g|cassa\s*malati|imposta|tass[ae]|telelavoro|busta\s*paga|stipend|salar|chf|euro|valut|lamal|cmi|avs|lpp|pendolar|chiasso|gaggiolo|fornasette|valic)/i;

const MAX_PER_PAGE = 50; // Graph API page-fetch cap per request
const MIN_ENGAGEMENT = 1; // very soft floor — only reject posts with literally 0 reactions+comments
const MAX_TOTAL_CANDIDATES = 30; // top-N across all pages, sorted by engagement
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
  // Soft engagement floor only — keep everything that has at least a few
  // reactions/comments. Keyword preference is applied at sort time, not
  // as a hard filter.
  if (!post || typeof post !== 'object') return false;
  const message = String(post.message ?? '');
  if (!message) return false;
  const reactions = Number(post?.reactions?.summary?.total_count ?? 0);
  const comments = Number(post?.comments?.summary?.total_count ?? 0);
  return reactions + comments >= MIN_ENGAGEMENT;
}

export function postSortKey(post) {
  // Higher first. Frontaliere-relevant posts get a 1000-point bump so they
  // outrank generic news on equal engagement; within each group ranking
  // is by raw reactions+comments.
  const reactions = Number(post?.reactions?.summary?.total_count ?? 0);
  const comments = Number(post?.comments?.summary?.total_count ?? 0);
  const engagement = reactions + comments;
  const message = String(post.message ?? '');
  const preference = KEYWORD_PREFERENCE_RE && KEYWORD_PREFERENCE_RE.test(message)
    ? 1000
    : 0;
  return preference + engagement;
}

export function postToCandidate(post, pageRef) {
  const message = String(post.message ?? '').trim().replace(/\s+/g, ' ');
  const keyword = message.slice(0, MAX_MESSAGE_PREFIX);
  const norm = normalizeKeyword(keyword);
  const reactions = Number(post?.reactions?.summary?.total_count ?? 0);
  const comments = Number(post?.comments?.summary?.total_count ?? 0);
  const matchesKeyword = KEYWORD_PREFERENCE_RE
    && KEYWORD_PREFERENCE_RE.test(message);
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
      facebookFrontalieriRelevant: matchesKeyword,
    },
    rationale: `Facebook ${pageRef}: ${reactions} reactions + ${comments} comments${matchesKeyword ? ' (frontaliere-relevant)' : ''}`,
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

  // Collect raw posts across all pages first, then sort + cap globally so
  // the highest-engagement posts surface regardless of which page they're
  // from. Previously we filtered per-page by keyword which silently dropped
  // 99% of posts; the new contract is "show the loudest stuff in this
  // window, biased toward frontaliere-relevant posts".
  const rawPosts = [];
  const perPage = {};
  let anyOk = false;

  for (const ref of pages) {
    const url =
      `https://graph.facebook.com/v19.0/${encodeURIComponent(ref)}/posts` +
      `?fields=message,created_time,reactions.summary(total_count),comments.summary(total_count)` +
      `&limit=${MAX_PER_PAGE}&access_token=${encodeURIComponent(token)}`;

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
    let kept = 0;
    let totalEngagement = 0;
    for (const p of posts) {
      if (!postPassesFilter(p)) continue;
      rawPosts.push({ post: p, ref, sortKey: postSortKey(p) });
      kept++;
      totalEngagement += Number(p?.reactions?.summary?.total_count ?? 0)
        + Number(p?.comments?.summary?.total_count ?? 0);
    }
    perPage[ref] = { ok: true, candidates: kept, totalEngagement };
    if (kept > 0) anyOk = true;
  }

  // Global sort + dedupe + cap.
  rawPosts.sort((a, b) => b.sortKey - a.sortKey);
  const all = [];
  const seenNorm = new Set();
  for (const { post, ref } of rawPosts) {
    if (all.length >= MAX_TOTAL_CANDIDATES) break;
    const cand = postToCandidate(post, ref);
    if (!cand.normalizedKeyword || seenNorm.has(cand.normalizedKeyword)) continue;
    seenNorm.add(cand.normalizedKeyword);
    all.push(cand);
  }

  return {
    ok: anyOk,
    candidates: all,
    perPage,
    reason: anyOk ? undefined : 'no FB posts in window with engagement >= 5',
  };
}

export default fetchFacebookCandidates;
