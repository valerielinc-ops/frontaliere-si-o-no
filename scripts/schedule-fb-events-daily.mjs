#!/usr/bin/env node
/**
 * Daily Facebook poster for Swiss events, nationwide (chained feature on
 * issue #2963, generalized to all cantons in #3647 — F5/5 of #3125).
 *
 * Picks the few SOONEST upcoming events from data/events.json that haven't been
 * posted yet, and posts each to the Facebook Page linking to OUR per-comune
 * events landing page for the event's own canton (`/eventi/<cantone>/<comune>/`,
 * TI kept at its original `/eventi/ticino/<comune>/`) so the post drives traffic
 * into the SEO funnel. Each post is geo-anchored with the event comune's FB
 * Place ID (data/fb-place-ids.json) for local-discovery reach — the same
 * mechanism the jobs poster uses, reusing its `loadPlaceIds`/`lookupPlaceId`.
 *
 * Channel-agnostic primitives (ledger, sanitization, canton naming) come from
 * scripts/lib/social-post-utils.mjs — no logic is duplicated (AGENTS.md §6).
 *
 * Posts immediately (like the articles poster), low-volume, time-relevant.
 * Exit code is always 0 (CI-soft) unless an unexpected crash occurs.
 *
 * Usage:
 *   FB_PAGE_ID=… FB_PAGE_ACCESS_TOKEN=… node scripts/schedule-fb-events-daily.mjs
 *   DRY_RUN=1 node scripts/schedule-fb-events-daily.mjs       # no POST, prints plan
 *
 * Env:
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN — Graph API credentials (required for POST)
 *   FB_EVENT_VOLUME                  — events per run (default 3, max 10)
 *   DRY_RUN=1                        — plan only
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEventsDataset, upcomingEvents, slugifyComune, isoDay, weekendWindow, weekendEvents, eventsBasePathForCanton, resolveCantonUrlKey, UNRESOLVED_CANTON_KEY, UNRESOLVED_CANTON_LABEL } from './lib/events-utils.mjs';
import { loadLedger, appendLedger, stripDiacritics, truncateBody, SITE_URL, isLandingPageLive, CANTON_NAME_BY_CODE, MONTHS_IT } from './lib/social-post-utils.mjs';
import { loadPlaceIds, lookupPlaceId, rescrapeOgAndVerify } from './schedule-fb-jobs-daily.mjs';
import { facebookUrl, FACEBOOK_CAMPAIGN_EVENT } from './lib/facebook-links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const LEDGER_PATH = path.join(REPO_ROOT, 'data', 'fb-posted-events.json');
const DEFAULT_VOLUME = 3;
const MAX_VOLUME = 10;
const FB_MESSAGE_HARD_LIMIT = 600;

const CATEGORY_EMOJI = {
  arte: '🎨', musica: '🎵', teatro: '🎭', cinema: '🎬', feste: '🎉',
  musei: '🏛️', conferenze: '🎤', sport: '⚽', appuntamenti: '📌', sociale: '🤝',
};

// MONTHS_IT now lives in ./lib/social-post-utils.mjs (imported above) — was
// duplicated here and in the Telegram border digest (project rule §6).

/** "sab 4 luglio" style Italian date from an ISO YYYY-MM-DD (no Date tz drift). */
function humanDateIt(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const day = Number(m[3]);
  const month = MONTHS_IT[Number(m[2]) - 1] || '';
  return `${day} ${month}`;
}

/** Hashtag-safe token: diacritic-free, alnum only. */
function tagWord(s) {
  return stripDiacritics(String(s || '')).replace(/[^A-Za-z0-9]/g, '');
}

/** Italian display name for a canton code; blank/unresolved routes to the canton-neutral bucket's shared copy, never Ticino (#3739 round-2). */
function cantonDisplayName(canton) {
  // A blank canton is treated the same as the explicit sentinel below — the
  // per-event poster (buildEventUrl/buildEventCaption) never resolves a
  // canton hint before calling this, unlike selectWeekendDigests's callers,
  // so blank must degrade to "altri cantoni", not silently become Ticino.
  const code = String(canton || UNRESOLVED_CANTON_KEY).toUpperCase();
  // #3739: the weekend-digest canton-neutral bucket sentinel isn't a real BFS
  // code, so CANTON_NAME_BY_CODE would never resolve it — captioned as the
  // shared "altri cantoni" copy instead (captions here are Italian-only).
  if (code === UNRESOLVED_CANTON_KEY) return UNRESOLVED_CANTON_LABEL.it;
  return CANTON_NAME_BY_CODE[code] || '';
}

/** Canonical IT events URL for an event: comune page when known, else the canton hub — the canton-neutral hub when the canton itself is blank/unresolved (#3739 round-2), never Ticino's. */
export function buildEventUrl(event) {
  const base = eventsBasePathForCanton(event?.canton || UNRESOLVED_CANTON_KEY).it;
  if (event?.comune) return `${SITE_URL}${base}/${slugifyComune(event.comune)}/`;
  return `${SITE_URL}${base}/`;
}

/**
 * Build the FB caption for one event:
 *
 *   {emoji} {title}
 *   📍 {comune}  📅 {date}{ · time}
 *
 *   👉 Scopri gli eventi a {comune}:
 *
 *   {hashtags}
 */
export function buildEventCaption(event) {
  const emoji = CATEGORY_EMOJI[event?.category] || '📅';
  const title = String(event?.title || '').trim();
  const cantonName = cantonDisplayName(event?.canton) || 'Ticino';
  const comune = String(event?.comune || cantonName).trim();
  const when = humanDateIt(event?.startDate);
  const time = event?.startTime ? ` · ${event.startTime}` : '';

  const metaChunks = [`📍 ${comune}`];
  if (when) metaChunks.push(`📅 ${when}${time}`);

  const cantonTag = tagWord(cantonName);
  const tags = [`#eventi${cantonTag}`];
  const comuneTag = tagWord(comune);
  if (comuneTag && comuneTag.toLowerCase() !== cantonTag.toLowerCase()) tags.push(`#${comuneTag}`);
  const catTag = event?.category ? tagWord(event.category) : '';
  if (catTag) tags.push(`#${catTag}`);
  tags.push(`#${cantonTag}`, '#frontalieri');
  const hashtags = [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 5).join(' ');

  const cta = event?.comune ? `👉 Scopri gli eventi a ${comune}:` : `👉 Scopri gli eventi in ${cantonName}:`;
  const parts = [`${emoji} ${truncateBody(title, 150)}`, metaChunks.join('  '), '', cta, '', hashtags];
  let out = parts.join('\n').trim();
  if (out.length > FB_MESSAGE_HARD_LIMIT) out = out.slice(0, FB_MESSAGE_HARD_LIMIT);
  return out;
}

// isLandingPageLive moved to ./lib/social-post-utils.mjs (shared with the
// articles poster, AGENTS.md §6 — no duplicate pre-flight logic per channel).
// Re-exported here for backward-compat with existing test imports.
export { isLandingPageLive };

/** Select the soonest-starting upcoming events not yet in `postedSet`. */
export function selectUnpostedEvents(events, postedSet, limit) {
  if (!Array.isArray(events)) return [];
  // upcomingEvents already sorts ascending by startDate then title.
  return events.filter((e) => e && e.id && !postedSet.has(e.id)).slice(0, Math.max(0, limit | 0));
}

/** Canonical URL of a canton's weekend digest landing page (matches the SSG plugin). */
export function buildWeekendDigestUrl(canton) {
  const base = eventsBasePathForCanton(canton).it;
  return `${SITE_URL}${base}/questo-weekend/`;
}

/** Canonical URL of the Ticino weekend digest landing page (legacy default, unchanged). */
export const WEEKEND_DIGEST_URL = buildWeekendDigestUrl('TI');

/**
 * Roundup caption for one canton's weekend digest post. Mirrors
 * `buildEventCaption`'s style (the bare URL is NOT inlined — FB renders the
 * link card from the POST's `link` field). Lists how many events and a few
 * comuni/highlights. `canton` defaults to 'TI' (legacy MVP scope).
 */
export function buildWeekendDigestCaption(events, todayIso, canton = 'TI') {
  const list = Array.isArray(events) ? events : [];
  const comuni = [...new Set(list.map((e) => e?.comune).filter(Boolean))];
  const n = list.length;
  const cantonName = cantonDisplayName(canton) || 'Ticino';
  const cantonTag = tagWord(cantonName);
  const headline = `🎉 Cosa fare questo weekend in ${cantonName}`;
  const comuneTail = comuni.length ? ` — ${comuni.slice(0, 4).join(', ')}${comuni.length > 4 ? '…' : ''}` : '';
  const count = `📅 ${n} ${n === 1 ? 'evento' : 'eventi'} tra sabato e domenica${comuneTail}.`;
  const highlights = list.slice(0, 3).map((e) => {
    const emoji = CATEGORY_EMOJI[e?.category] || '•';
    const t = truncateBody(String(e?.title || '').trim(), 60);
    return `${emoji} ${t}${e?.comune ? ` (${e.comune})` : ''}`;
  });

  const tags = [`#eventi${cantonTag}`, '#weekend', `#${cantonTag}`, '#frontalieri'];
  for (const c of comuni.slice(0, 2)) {
    const tag = tagWord(c);
    if (tag && tag.toLowerCase() !== cantonTag.toLowerCase()) tags.push(`#${tag}`);
  }
  const hashtags = [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 6).join(' ');

  const parts = [headline, '', count];
  if (highlights.length) parts.push('', ...highlights);
  parts.push('', '👉 Programma completo, comune per comune:', '', hashtags);
  let out = parts.join('\n').trim();
  if (out.length > FB_MESSAGE_HARD_LIMIT) out = out.slice(0, FB_MESSAGE_HARD_LIMIT);
  return out;
}

/**
 * Build one weekend-digest payload PER canton that has weekend events,
 * generalizing the original Ticino-only roundup (issue #3647, F5/5 of #3125)
 * now that events span multiple cantons (#3644/#3645). Ticino always sorts
 * first (legacy/highest-volume canton), the rest by event count descending.
 *
 * Cantons already posted for this weekend are filtered out BEFORE capping at
 * `maxCantons` — capping first would starve a canton pushed past the cap: the
 * same top-N slice would be recomputed and re-filtered to the same
 * already-posted set on every later run, never reaching the next candidates.
 * Filtering first lets a twice-daily cron drain further down the sorted
 * canton list across multiple runs.
 *
 * Returns `[]` when there is nothing left to post (no weekend events at all,
 * or every canton with weekend events already posted this weekend).
 */
export function selectWeekendDigests(events, todayIso, postedSet, maxCantons = MAX_VOLUME) {
  const { start } = weekendWindow(todayIso);
  const weekend = weekendEvents(events, todayIso);
  if (weekend.length === 0) return [];

  const byCanton = new Map();
  for (const e of weekend) {
    // #3739: an event with no resolved canton must NOT fold into Ticino's
    // bucket (that mislabels it and posts it to the Ticino weekend roundup)
    // — it gets its own canton-neutral bucket instead, matching
    // eventsSeoPagesPlugin.ts's byCanton/pastEventsByCanton grouping loops.
    // resolveCantonUrlKey also collapses half-cantons (AI/AR, BL/BS) onto
    // their shared URL group key — buildWeekendDigestUrl('BL') and ('BS')
    // resolve to the SAME landing page, so grouping by the raw code would
    // post two duplicate roundups to that one page in the same run. Same
    // resolver buildWeekendDigestUrl (via eventsBasePathForCanton) uses
    // internally, so the grouping key always matches the page it links to.
    const canton = e?.canton ? resolveCantonUrlKey(e.canton) : UNRESOLVED_CANTON_KEY;
    if (!byCanton.has(canton)) byCanton.set(canton, []);
    byCanton.get(canton).push(e);
  }

  const cantons = [...byCanton.keys()]
    .filter((canton) => {
      const id = canton === 'TI' ? `weekend-digest-${start}` : `weekend-digest-${canton}-${start}`;
      return !(postedSet && postedSet.has(id));
    })
    .sort((a, b) => {
      if (a === 'TI') return -1;
      if (b === 'TI') return 1;
      return byCanton.get(b).length - byCanton.get(a).length;
    })
    .slice(0, Math.max(0, maxCantons | 0));

  return cantons.map((canton) => {
    const cantonEvents = byCanton.get(canton);
    const id = canton === 'TI' ? `weekend-digest-${start}` : `weekend-digest-${canton}-${start}`;
    return {
      id,
      url: buildWeekendDigestUrl(canton),
      message: buildWeekendDigestCaption(cantonEvents, todayIso, canton),
      placeId: null,
      canton,
      // Mark the events the roundup covers so they are ledgered too — the Sat/Sun
      // per-event poster then skips them instead of re-posting what the digest
      // already covered (keeps the "no flooding" guarantee across the weekend).
      coveredIds: cantonEvents.map((e) => e?.id).filter(Boolean),
    };
  });
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.repoRoot]
 * @param {(...a: unknown[]) => void} [opts.log]
 * @param {(...a: unknown[]) => void} [opts.warn]
 * @param {string} [opts.todayIso]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const volume = Math.min(MAX_VOLUME, Math.max(1, Number(env.FB_EVENT_VOLUME) || DEFAULT_VOLUME));
  const pageId = env.FB_PAGE_ID;
  const token = env.FB_PAGE_ACCESS_TOKEN;
  const ledgerPath = path.join(repoRoot, 'data', 'fb-posted-events.json');

  log('🗓️', `FB events daily poster — volume=${volume}, dry=${dryRun}`);

  const dataset = loadEventsDataset(path.join(repoRoot, 'data', 'events.json'));
  const todayIso = opts.todayIso || isoDay(new Date());
  const upcoming = upcomingEvents(dataset.events, todayIso);
  if (upcoming.length === 0) {
    log('ℹ️', 'no upcoming events, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }

  const ledger = loadLedger(ledgerPath);
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // On the weekly digest day (Friday by default; FB_EVENTS_DIGEST_DOW overrides,
  // 0=Sun…6=Sat, set <0 to disable) post ONE weekend roundup linking to the
  // /questo-weekend/ landing instead of individual per-event posts — covers the
  // weekend in a single post without flooding the Page. The cron fires mid-day
  // UTC (08:50/16:50), which is still Friday in both UTC and Europe/Zurich, so
  // the UTC-based getUTCDay() never straddles the day boundary.
  const rawDow = env.FB_EVENTS_DIGEST_DOW;
  let digestDow = 5;
  if (rawDow != null && rawDow !== '') {
    digestDow = Number(rawDow);
    if (!Number.isInteger(digestDow)) {
      warn('⚠️', `FB_EVENTS_DIGEST_DOW='${rawDow}' is not an integer 0-6 — weekend digest disabled this run`);
    }
  }
  const isDigestDay =
    Number.isInteger(digestDow) && digestDow >= 0 && digestDow <= 6 && new Date(`${todayIso}T00:00:00Z`).getUTCDay() === digestDow;
  const weekendStart = weekendWindow(todayIso).start;

  // The schedule cron fires twice a day: once a canton's roundup is posted and
  // ledgered, a later digest-day run MUST stay silent for it — NOT fall through
  // to per-event posting, which would re-post the same weekend events the
  // roundup already covers (the very flooding this digest avoids). Only a
  // digest day with NO weekend events at all (nationwide) falls back to
  // per-event posts (so a quiet Friday isn't mute).
  let digestsThisRun = [];
  if (isDigestDay) {
    const weekend = weekendEvents(dataset.events, todayIso);
    if (weekend.length > 0) {
      digestsThisRun = selectWeekendDigests(dataset.events, todayIso, postedSet, volume);
      if (digestsThisRun.length === 0) {
        log('ℹ️', `weekend digest(s) already posted for weekend-${weekendStart} — staying silent`);
        return { ok: true, posted: 0, dryRun, payloads: [] };
      }
    }
  }

  const placeIds = loadPlaceIds(repoRoot);
  let payloads;
  if (digestsThisRun.length > 0) {
    log('🎉', `weekend digest day — posting roundup for ${digestsThisRun.length} canton(s): ${digestsThisRun.map((d) => d.canton).join(', ')}`);
    payloads = digestsThisRun;
  } else {
    const candidates = selectUnpostedEvents(upcoming, postedSet, volume);
    payloads = candidates.map((event) => ({
      id: event.id,
      url: buildEventUrl(event),
      message: buildEventCaption(event),
      placeId: lookupPlaceId(event.comune, placeIds),
      comune: event.comune || null,
    }));
  }
  if (payloads.length === 0) {
    log('ℹ️', 'nothing to post, exiting');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }
  const placed = payloads.filter((p) => p.placeId).length;
  log('📍', `place tag resolved for ${placed}/${payloads.length} payloads`);

  if (dryRun) {
    log('🏃', `DRY_RUN — would post ${payloads.length} event(s)`);
    for (const p of payloads) log('  •', `${p.url}${p.placeId ? ` [place=${p.placeId}]` : ''}\n${p.message}\n`);
    return { ok: true, posted: 0, dryRun: true, payloads };
  }

  if (!pageId || !token) {
    warn('⚠️', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing — skipping');
    return { ok: false, posted: 0, dryRun, payloads };
  }
  if (typeof fetchImpl !== 'function') {
    warn('⚠️', 'no fetch impl available — skipping');
    return { ok: false, posted: 0, dryRun, payloads };
  }

  // Pre-flight: confirm each landing page is actually live before posting a
  // link to it (see `isLandingPageLive` doc — deploy can lag the events crawl
  // by more than the gap to this cron). Runs concurrently so a single slow
  // comune can't stall the rest of the batch.
  const preflight = await Promise.allSettled(
    payloads.map((p) => isLandingPageLive(p.url, { fetchImpl })),
  );
  const liveSet = new Set();
  payloads.forEach((p, i) => {
    const outcome = preflight[i];
    const live = outcome.status === 'fulfilled' ? outcome.value : false;
    if (live) {
      liveSet.add(p);
    } else {
      warn('🚧', `landing page not live yet for "${p.comune || (p.canton ? `weekend digest (${p.canton})` : 'weekend digest')}" (${p.url}) — skipping post ${p.id}`);
    }
  });
  payloads = payloads.filter((p) => liveSet.has(p));
  if (payloads.length === 0) {
    log('ℹ️', 'all landing pages failed the pre-flight check, nothing to post');
    return { ok: true, posted: 0, dryRun, payloads: [] };
  }

  const TRANSIENT = new Set([1, 2, 4, 17]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let posted = 0;
  for (const p of payloads) {
    // OG rescrape + verify og_object.image resolved (issue #3382) — shared
    // with the jobs scheduler so the retry/backoff logic isn't duplicated.
    // See the articles scheduler: tag before the rescrape, keep `p.url` bare
    // because it is the ledger's dedup key.
    const link = facebookUrl(p.url, FACEBOOK_CAMPAIGN_EVENT, p.id);
    await rescrapeOgAndVerify(fetchImpl, link, token, warn);

    const apiUrl = `${GRAPH_BASE}/${pageId}/feed`;
    const body = () => {
      const b = new URLSearchParams({ message: p.message, link, access_token: token });
      if (p.placeId) b.append('place', p.placeId);
      return b;
    };

    let data = null;
    let res = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        res = await fetchImpl(apiUrl, { method: 'POST', body: body() });
        data = await res.json();
      } catch (err) {
        warn('⚠️', `POST failed for ${p.id} (attempt ${attempt}): ${err.message}`);
        data = null;
      }
      if (res?.ok && data?.id) break;
      if (attempt < 2 && TRANSIENT.has(data?.error?.code)) {
        warn('⏳', `FB transient error ${data?.error?.code} for ${p.id}, retrying in 2s`);
        await sleep(2000);
        continue;
      }
      break;
    }

    if (res?.ok && data?.id) {
      posted += 1;
      const now = new Date().toISOString();
      const entries = [{ id: p.id, url: p.url, postId: data.id, postedAt: now }];
      // A weekend roundup also ledgers the events it covers, so the Sat/Sun
      // per-event poster won't re-post them individually.
      for (const coveredId of p.coveredIds || []) {
        if (coveredId !== p.id) entries.push({ id: coveredId, viaDigest: p.id, postedAt: now });
      }
      appendLedger(ledgerPath, entries);
      log('✅', `posted ${p.id} → ${data.id}${p.coveredIds?.length ? ` (covers ${p.coveredIds.length} events)` : ''}`);
    } else {
      warn('⚠️', `FB API error for ${p.id}: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }

  log('🏁', `posted ${posted}/${payloads.length} events`);
  return { ok: true, posted, dryRun, payloads };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run()
    .then((r) => process.exit(r.ok ? 0 : 0))
    .catch((err) => {
      console.error(`[fb-events] failed: ${err?.message || err}`);
      process.exit(0);
    });
}
