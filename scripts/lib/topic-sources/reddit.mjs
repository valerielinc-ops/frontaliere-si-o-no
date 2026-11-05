// scripts/lib/topic-sources/reddit.mjs
//
// Pulls recent self-posts from frontaliere-relevant subreddits, filters for
// high-engagement question posts, and emits Candidates. Reddit data access is
// disabled unless the owner's explicit Data API approval gate is enabled; the
// approved path uses OAuth only. Anonymous JSON/RSS and browser scraping are
// deliberately not fallbacks.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';
import { detectLocale } from './detectLocale.mjs';
import { getAccessToken, userAgent } from '../reddit-client.mjs';
import { isRedditDataApiApproved } from '../social-readiness.mjs';

// Keep this filter on cross-border-work vocabulary. City-only matches used
// to admit unrelated local chatter, so they are intentionally insufficient.
const REDDIT_DOMAIN_RE = /\b(frontalier|grenzg|permess(o|i)?\s*[gbl]|visa|residenc[ye]|relocat|salar|stipend|\btax\b|\bfisc|impost|tass[ae]|insurance|assicur|health|sanit|krank|pension|previdenz|\bavs\b|\bahv\b|\blpp\b|\bbvg\b|3a|3b|pilastro|cassa\s*malat|premio\s*malat|hospital|doctor|medico|affitt|mortgage|mutuo|bank|bancar|account|conto|\bchf\b|\beuro\b|cambio|exchange|commute|pendolar|treno|\bsbb\b|valico|dogana|telelavoro|smart\s*working|telework|switzerland|svizzer|tessin|ticino\s+(lavoro|frontalier|fiscal|tasse|salar|imposta)|busta\s*paga|naspi|disoccupaz|stipendio|crossborder|cross-border|grenz)/i;

const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

// Bounded retries for transient network, rate-limit, and server failures.
const RETRY_DELAYS_MS = [1000, 3000];

const ENDPOINTS = [
  {
    sourceKey: 'redditTicino',
    sub: 'Ticino',
    url: 'https://oauth.reddit.com/r/Ticino/new.json?limit=100',
  },
  {
    sourceKey: 'redditItaly',
    sub: 'italy',
    url:
      'https://oauth.reddit.com/r/italy/search.json?q=' +
      encodeURIComponent(
        'frontalieri OR "permesso G" OR "busta paga svizzera" OR chiasso OR "tasse svizzera"',
      ) +
      '&sort=new&limit=50&restrict_sr=1',
  },
  {
    sourceKey: 'redditLugano',
    sub: 'Lugano',
    url: 'https://oauth.reddit.com/r/Lugano/new.json?limit=100',
  },
  {
    sourceKey: 'redditSwitzerland',
    sub: 'Switzerland',
    url:
      'https://oauth.reddit.com/r/Switzerland/search.json?q=' +
      encodeURIComponent('frontalieri OR cross-border worker') +
      '&sort=new&limit=50&restrict_sr=1',
  },
];

const QUESTION_PREFIX = /^(come|quando|quanto|perche|perché|chi|cosa|dove|qualcuno sa|consigli|domanda|ho bisogno|aiuto|where|how|when|how much|anyone)\b/i;

export function isQuestionTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  if (t.endsWith('?')) return true;
  return QUESTION_PREFIX.test(t);
}

// r/Switzerland search returns mixed EN/DE/FR/IT posts. The English-language
// posts dominate the top scores but produce zero-value candidates for an
// IT-language frontaliere blog ("SBB controllers getting bonuses for fines?").
// Drop only on a CONFIDENT non-IT detection; if detectLocale falls back to 'it'
// (its default for low-confidence input) or throws, keep the post — better to
// over-include than to silently drop borderline IT titles.
//
// Note: `detectLocale` has known false-positives between IT and FR on short
// text — Italian short words like "sa", "la", "un" overlap with French
// markers and tip a clearly-Italian title to 'fr'. The actual noise we want
// out of r/Switzerland is English (and German), so we only drop on those
// two confident detections; 'fr' and 'it' are both kept. Trade-off:
// occasional French post slips through, vs strict "drop EN/DE noise".
export function isItLocaleConfident(title) {
  if (!title || typeof title !== 'string') return true;
  try {
    const locale = detectLocale(title);
    if (locale == null) return true; // null/undefined → fail-safe keep
    return locale !== 'en' && locale !== 'de';
  } catch {
    return true; // detector threw → fail-safe keep
  }
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

async function fetchJson(url, fetchImpl, { token, ua }) {
  const f = fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    const res = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': ua,
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

function postToCandidate(post, sourceKey, sub) {
  const rawScore = Number(post.score);
  const rawComments = Number(post.num_comments);
  const score = Number.isFinite(rawScore) ? rawScore : 0;
  const comments = Number.isFinite(rawComments) ? rawComments : 0;
  const title = String(post.title || '').trim();
  const norm = normalizeKeyword(title);
  // Locale heuristic: r/Switzerland is mixed EN/DE, r/italy IT, r/Ticino IT,
  // r/Lugano IT. detectLocale() reads markers in the title itself for the
  // most accurate per-post tag.
  const locale = detectLocale(title);

  const combined = score + comments * 2;
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
      redditUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    },
    rationale: `Reddit r/${sub}: score ${score}, ${comments} comments`,
  };
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — test override.
 * @param {Function} [opts.sleepFn] — test override.
 * @param {Function} [opts.getAccessTokenFn] — test override.
 * @param {Record<string, string|undefined>} [opts.env] — test override.
 * @returns {Promise<{ ok: boolean, perSubreddit: Record<string, {ok: boolean, candidates: any[], reason?: string}>, candidates: any[] }>}
 */
export async function fetchRedditCandidates(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepFn = opts.sleepFn ?? sleep;
  if (!isRedditDataApiApproved(env)) {
    return emptyResult('reddit_data_api_unapproved', 'disabled');
  }

  const getAccessTokenFn = opts.getAccessTokenFn ?? getAccessToken;
  const token = await getAccessTokenFn(env, fetchImpl);
  if (!token) return emptyResult('reddit_oauth_unavailable', 'unavailable');
  const ua = userAgent(env);

  const perSubreddit = {};
  const all = [];
  const seenAcross = new Set();

  for (let i = 0; i < ENDPOINTS.length; i++) {
    const ep = ENDPOINTS[i];
    let posts = [];
    let lastErr = null;

    let attempt = 0;
    let success = false;
    while (attempt <= RETRY_DELAYS_MS.length) {
      try {
        const json = await fetchJson(ep.url, fetchImpl, { token, ua });
        posts = extractPosts(json);
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        const status = Number(e?.status);
        const retryable = !Number.isInteger(status) || status === 429 || status >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
        await sleepFn(RETRY_DELAYS_MS[attempt]);
        attempt++;
      }
    }
    if (!success) {
      const reason = String(lastErr?.message ?? lastErr ?? 'unknown').slice(0, 200);
      perSubreddit[ep.sourceKey] = { ok: false, candidates: [], reason };
      if (Number(lastErr?.status) === 401 || Number(lastErr?.status) === 403) {
        for (const remaining of ENDPOINTS.slice(i + 1)) {
          perSubreddit[remaining.sourceKey] = {
            ok: false,
            candidates: [],
            reason: 'reddit_oauth_rejected',
          };
        }
        break;
      }
      if (i < ENDPOINTS.length - 1) await sleepFn(REQUEST_GAP_MS);
      continue;
    }

    // r/Switzerland-only locale filter: drop posts whose title is confidently
    // EN/DE/FR. Other endpoints (Ticino, Lugano, Italy) are naturally IT-skewed
    // and do not need this filter — applying it there would risk dropping
    // brand-/proper-noun-heavy IT titles that detectLocale may misclassify.
    if (ep.sourceKey === 'redditSwitzerland') {
      posts = posts.filter((p) => isItLocaleConfident(p?.title));
    }

    const candidates = [];
    for (const p of posts) {
      if (!passesFilters(p)) continue;
      // RELEVANCE FILTER: drop posts that aren't about cross-border-worker
      // life. r/Lugano had 0/16 frontaliere-relevant titles; r/Ticino had
      // 23%. Without this filter, "Pilates studios?", "What are some bars
      // for a cheap drink?", and dating questions dominate the candidate
      // pool. The domain regex is broader than a single frontalieri keyword because
      // Reddit posts often probe adjacent topics (housing/banking/transport
      // in Ticino) that are still article-worthy for our audience.
      if (!REDDIT_DOMAIN_RE.test(p.title)) continue;
      const norm = normalizeKeyword(p.title);
      if (!norm || seenAcross.has(norm)) continue;
      seenAcross.add(norm);
      candidates.push(postToCandidate(p, ep.sourceKey, ep.sub));
    }

    perSubreddit[ep.sourceKey] = candidates.length
      ? { ok: true, candidates }
      : { ok: true, candidates: [], reason: 'no qualifying posts' };
    for (const c of candidates) all.push(c);

    if (i < ENDPOINTS.length - 1) await sleepFn(REQUEST_GAP_MS);
  }

  const overallOk = Object.values(perSubreddit).some(
    (s) => s.ok && s.candidates.length > 0,
  );
  return { ok: overallOk, authMode: 'oauth', perSubreddit, candidates: all };
}

function emptyResult(reason, authMode) {
  const perSubreddit = Object.fromEntries(
    ENDPOINTS.map((endpoint) => [endpoint.sourceKey, { ok: false, candidates: [], reason }]),
  );
  return { ok: false, authMode, perSubreddit, candidates: [] };
}

export default fetchRedditCandidates;
