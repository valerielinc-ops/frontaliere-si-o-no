#!/usr/bin/env node
/**
 * post-to-tiktok.mjs — TikTok Business account carousel posts:
 *   • yesterday's top-5 most-clicked JOBS   (--only=job,   daily)
 *   • yesterday's top-5 most-read ARTICLES  (--only=article, daily)
 *   • this week's top-5 fastest DOGANE      (--only=border, weekly)
 *
 * Sibling of scripts/post-to-instagram.mjs — same ranking, same dedup ledger
 * shape, same carousel image, different publish API. See that file's header
 * for the shared architecture; only what's genuinely TikTok-specific is
 * duplicated here (the project's own precedent for per-channel posters —
 * see scripts/lib/social-post-utils.mjs's header on what stays shared vs
 * per-channel).
 *
 * ── TikTok Content Posting API — what's DIFFERENT from Instagram ──────────
 * 1. Photo/carousel posts use a dedicated JSON endpoint (not the same media
 *    endpoint as video), and only accept JPEG/WEBP — never PNG. See
 *    scripts/lib/social-carousel-image.mjs (already renders JPEG).
 * 2. The image URLs' DOMAIN must be verified in the TikTok developer console
 *    (DNS or .well-known file) before PULL_FROM_URL works at all — a
 *    one-time setup step, not something this script can do.
 * 3. Publishing is a two-call async flow: `content/init/` returns a
 *    `publish_id` immediately, then `status/fetch/` is polled until the
 *    post is PUBLISH_COMPLETE (or FAILED) — see waitForPublishComplete.
 * 4. An "unaudited" app (the only kind that exists before TikTok completes
 *    app review) can only post with `privacy_level: SELF_ONLY` — PUBLIC
 *    posting 400s until the audit is granted. TIKTOK_PRIVACY_LEVEL below
 *    defaults to the safe pre-audit value; the owner can override once
 *    audited.
 * 5. Access tokens last 24h (vs LinkedIn member's ~60 days) — this is a
 *    daily/weekly cron, so getAccessToken() below refreshes via
 *    TIKTOK_REFRESH_TOKEN before falling back to the static
 *    TIKTOK_ACCESS_TOKEN, same shape as post-to-linkedin-member.mjs. TikTok
 *    may rotate the refresh token on use (per its own docs, "the returned
 *    refresh_token may [be a new] one"); this script does not persist a
 *    rotated token back to Remote Config — same known limitation as the
 *    LinkedIn member poster. Re-run scripts/tiktok-auth.mjs if refresh
 *    starts failing near the 365-day refresh-token expiry.
 *
 * The exact request/response shape below is written from TikTok's published
 * Content Posting API docs, cross-checked field-by-field against the docs a
 * second time when scripts/tiktok-auth.mjs was added (including the
 * `publicaly_available_post_id` misspelling in TikTok's own response, which
 * is intentional here, not a bug) — but still never exercised against a live
 * call, because TIKTOK_ACCESS_TOKEN is not minted until the owner runs
 * scripts/tiktok-auth.mjs and TikTok's app review is still pending (see
 * CLAUDE.md). Re-check developers.tiktok.com/doc/content-posting-api-reference-direct-post
 * against this code the first time a real token is available, before
 * trusting the first non-dry-run post.
 *
 * Usage:
 *   npx tsx scripts/post-to-tiktok.mjs                     # article + job
 *   npx tsx scripts/post-to-tiktok.mjs --dry-run             # print, post nothing
 *   npx tsx scripts/post-to-tiktok.mjs --only=job
 *   npx tsx scripts/post-to-tiktok.mjs --only=border          # weekly cron only
 *   npx tsx scripts/post-to-tiktok.mjs --date=2026-08-23
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   TIKTOK_ACCESS_TOKEN    required unless the refresh trio below is set —
 *                           mint both via `node scripts/tiktok-auth.mjs`.
 *                           ABSENT until the owner runs that helper, so the
 *                           poster soft-skips until then.
 *   TIKTOK_REFRESH_TOKEN   + TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET →
 *                           auto-refresh before each run (see point 5 above)
 *   TIKTOK_PRIVACY_LEVEL   optional, defaults to SELF_ONLY (see point 4 above)
 *   GA4_PROPERTY_ID        defaults to properties/524485296
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET
 *                           required to host the carousel images — missing
 *                           → upload-cdn-file.sh no-ops and this soft-skips
 *
 * Fail-soft by design, same posture as every other channel in this family.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_URL,
  loadLedger,
  appendLedger,
  loadJobSections,
  loadJobIndex,
  formatDayIt,
  buildCarouselCaption,
} from './lib/social-post-utils.mjs';
import {
  tiktokUrl,
  TIKTOK_CAMPAIGN_ARTICLE,
  TIKTOK_CAMPAIGN_JOB,
  TIKTOK_CAMPAIGN_BORDER,
} from './lib/tiktok-links.mjs';
import {
  previousReportDay,
  rankCandidates,
  pickTopNUnposted,
} from './lib/daily-top-content.mjs';
import { fetchGa4PageReport, fetchRetry, sleep } from './lib/ga4-service-account.mjs';
import { renderCarouselSlides } from './lib/social-carousel-image.mjs';
import { uploadCarouselSlides } from './lib/social-carousel-upload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'tiktok-posted.json');
const POSTED_TRIM_LIMIT = 1000;

const DEDUP_WINDOW_DAYS = 30;
const CAROUSEL_SIZE = 5;

const TIKTOK_API = 'https://open.tiktokapis.com/v2';
const PUBLISH_STATUS_MAX_ATTEMPTS = 6;
const PUBLISH_STATUS_DELAY_MS = 3000;

// ─────────────────────────── credentials ───────────────────────────

/**
 * Resolve the TikTok user access token, refreshing first when possible.
 *
 * Mirrors post-to-linkedin-member.mjs's getAccessToken(): try the
 * refresh_token grant when the trio is present, fall back to the static
 * token. Necessary here in a way it barely is for LinkedIn — TikTok access
 * tokens last 24h (see header point 5), so a purely-static token would work
 * on the first cron run after `tiktok-auth.mjs` and fail every run after.
 */
async function getAccessToken() {
  const refreshToken = String(process.env.TIKTOK_REFRESH_TOKEN || '').trim();
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || '').trim();
  const staticToken = String(process.env.TIKTOK_ACCESS_TOKEN || '').trim() || null;

  if (refreshToken && clientKey && clientSecret) {
    try {
      const res = await fetch(`${TIKTOK_API}/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_key: clientKey,
          client_secret: clientSecret,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        console.log(`🔄 access token refreshed (expires in ${data.expires_in}s)`);
        return data.access_token;
      }
      console.warn(`⚠️  token refresh failed (${res.status}) — falling back to the static token`);
    } catch (err) {
      console.warn(`⚠️  token refresh threw: ${err.message}`);
    }
  }
  return staticToken;
}

function getPrivacyLevel() {
  // SELF_ONLY is the only level an unaudited app is allowed to use — see
  // header point 4. Override via env once TikTok grants the app audit.
  return String(process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY').trim();
}

// ─────────────────────────── Content Posting API ───────────────────────────

async function tiktokPost(pathSuffix, body, accessToken) {
  const res = await fetchRetry(`${TIKTOK_API}${pathSuffix}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res?.ok || data?.error?.code !== 'ok') {
    return { ok: false, status: res?.status, error: data?.error || { message: 'no response body' } };
  }
  return { ok: true, data: data.data };
}

async function waitForPublishComplete(publishId, accessToken) {
  for (let attempt = 1; attempt <= PUBLISH_STATUS_MAX_ATTEMPTS; attempt++) {
    const res = await tiktokPost('/post/publish/status/fetch/', { publish_id: publishId }, accessToken);
    if (!res.ok) return { ok: false, reason: res.error?.message || `status ${res.status}` };
    const status = res.data?.status;
    if (status === 'PUBLISH_COMPLETE') return { ok: true, postId: res.data?.publicaly_available_post_id?.[0] || publishId };
    if (status === 'FAILED') return { ok: false, reason: res.data?.fail_reason || 'FAILED' };
    await sleep(PUBLISH_STATUS_DELAY_MS);
  }
  return { ok: false, reason: 'status never reached PUBLISH_COMPLETE within the poll budget' };
}

/**
 * Full photo-carousel publish: init (PULL_FROM_URL, all image URLs at once —
 * unlike Instagram, TikTok's photo endpoint takes the whole set in one call,
 * no per-image child container) → poll until PUBLISH_COMPLETE.
 */
async function publishCarousel({ accessToken, imageUrls, caption }) {
  const initRes = await tiktokPost(
    '/post/publish/content/init/',
    {
      post_info: {
        title: caption,
        privacy_level: getPrivacyLevel(),
        disable_duet: true,
        disable_comment: false,
        disable_stitch: true,
        auto_add_music: true,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: imageUrls,
      },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    },
    accessToken,
  );
  if (!initRes.ok) return { ok: false, reason: `init failed: ${initRes.error?.message || initRes.status}` };

  const publishId = initRes.data?.publish_id;
  if (!publishId) return { ok: false, reason: 'init succeeded but returned no publish_id' };

  return waitForPublishComplete(publishId, accessToken);
}

// ─────────────────────────── job/article (daily) ───────────────────────────

async function postGa4Carousel({ kind, day, dryRun, accessToken }) {
  const campaign = kind === 'job' ? TIKTOK_CAMPAIGN_JOB : TIKTOK_CAMPAIGN_ARTICLE;
  const ledger = loadLedger(LEDGER_PATH);
  const cutoff = Date.now() - DEDUP_WINDOW_DAYS * 86400000;
  const recent = new Set(
    ledger.posted
      .filter((e) => e?.kind === kind)
      .filter((e) => {
        const ts = Date.parse(e?.ts ?? '');
        return Number.isFinite(ts) ? ts >= cutoff : true;
      })
      .map((e) => e?.id)
      .filter(Boolean),
  );

  const rows = await fetchGa4PageReport(day);
  if (!rows) {
    console.log(`ℹ️  ${kind}: no GA4 data available — skipping`);
    return;
  }
  const jobSections = kind === 'job' ? loadJobSections() : undefined;
  const jobIndex = kind === 'job' ? loadJobIndex() : null;
  if (kind === 'job' && jobIndex.size === 0) {
    console.log('ℹ️  jobs dataset unavailable (run scripts/assemble-jobs-dataset.mjs) — skipping job carousel');
    return;
  }
  const { articles, jobs } = rankCandidates(rows, {
    jobSections,
    isJobSlug: kind === 'job' ? (slug) => jobIndex.has(slug) : undefined,
  });
  const candidates = kind === 'job' ? jobs : articles;

  const { picks, skipped } = pickTopNUnposted(candidates, recent, CAROUSEL_SIZE);
  if (picks.length === 0) {
    console.log(`ℹ️  ${kind}: no unposted candidate for ${day} — skipping`);
    return;
  }
  if (skipped) console.log(`↪️  ${kind}: skipped ${skipped} already-posted candidate(s)`);
  if (picks.length < CAROUSEL_SIZE) {
    console.log(`ℹ️  ${kind}: only ${picks.length}/${CAROUSEL_SIZE} unposted candidates — posting a shorter carousel`);
  }

  const slideItems = picks.map((p) => {
    const job = kind === 'job' ? jobIndex.get(p.slug) : null;
    const title = job ? [job.title, job.company].filter(Boolean).join(' — ') : p.title || p.slug.replace(/-/g, ' ');
    return { title, statLabel: 'Visualizzazioni', statValue: String(p.views), footerNote: job?.location || '' };
  });
  const captionPicks = picks.map((p, i) => ({ title: slideItems[i].title, statValue: `${p.views} visualizzazioni` }));
  const caption = buildCarouselCaption({ kind, dayLabel: formatDayIt(day), picks: captionPicks });

  console.log(`\n─── ${kind} carousel (${picks.length} slides) ───`);
  console.log(caption);
  console.log('───');

  if (dryRun) return;
  if (!accessToken) {
    console.log('⚠️  no TIKTOK_ACCESS_TOKEN — skipping (soft)');
    return;
  }

  const slides = await renderCarouselSlides({
    kicker: kind === 'job' ? 'LAVORI PIÙ CLICCATI' : 'ARTICOLI PIÙ LETTI',
    title: kind === 'job' ? 'I lavori più cliccati' : 'Gli articoli più letti',
    subtitle: formatDayIt(day),
    items: slideItems,
  });
  if (!slides) {
    console.log('⚠️  card fonts unavailable (public/fonts) — skipping (soft)');
    return;
  }
  const urls = uploadCarouselSlides(slides, { channel: 'tiktok', keyPrefix: `${kind}-${day}` });
  if (urls.some((u) => !u)) {
    console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
    return;
  }

  const res = await publishCarousel({ accessToken, imageUrls: urls, caption });
  if (!res.ok) {
    console.error(`⚠️  TikTok publish failed: ${res.reason}`);
    return;
  }
  console.log(`✅ posted — ${res.postId}`);
  appendLedger(
    LEDGER_PATH,
    picks.map((p) => ({
      id: p.slug,
      kind,
      url: tiktokUrl(`${SITE_URL}${p.path}/`, campaign, p.slug),
      day,
      views: p.views,
      ts: new Date().toISOString(),
      tiktokPostId: res.postId,
    })),
    POSTED_TRIM_LIMIT,
  );
}

// ─────────────────────────── border (weekly) ───────────────────────────

async function postBorderCarousel({ dryRun, accessToken }) {
  const { computeRanking, computeWeekWindow } = await import('./lib/border-wait-ranking.mjs');
  const { BORDER_WAIT_CROSSINGS, BORDER_CROSSING_DISPLAY, isTicinoCrossing, buildOggiPath } = await import(
    '../build-plugins/borderWaitData.ts'
  );
  const { fmtMinutes } = await import('../services/borderWaitFormat.ts');

  const historyDir = path.join(ROOT, 'data', 'border-wait-history');
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  const { weekStart, weekEnd } = computeWeekWindow(todayIso);

  const ledger = loadLedger(LEDGER_PATH);
  const alreadyPostedThisWeek = ledger.posted.some((e) => e?.kind === 'border' && e?.id === weekStart);
  if (alreadyPostedThisWeek) {
    console.log(`ℹ️  border: week of ${weekStart} already posted — skipping (weekly cadence, not daily)`);
    return;
  }

  const ranking = computeRanking(historyDir, todayIso);
  const known = ranking.filter((r) => BORDER_WAIT_CROSSINGS.includes(r.slug) && isTicinoCrossing(r.slug));
  const fastest = known.slice(0, CAROUSEL_SIZE);
  if (fastest.length === 0) {
    console.log('ℹ️  border: not enough ranked crossings yet — skipping');
    return;
  }

  const slideItems = fastest.map((r) => ({
    title: BORDER_CROSSING_DISPLAY[r.slug] || r.slug,
    statLabel: 'Attesa media',
    statValue: fmtMinutes(r.avgMinutes),
  }));
  const dayLabel = `${weekStart} – ${weekEnd}`;
  const caption = buildCarouselCaption({
    kind: 'border',
    dayLabel,
    picks: fastest.map((r, i) => ({ title: slideItems[i].title, statValue: fmtMinutes(r.avgMinutes) })),
  });

  console.log(`\n─── border carousel (${fastest.length} slides) ───`);
  console.log(caption);
  console.log('───');

  if (dryRun) return;
  if (!accessToken) {
    console.log('⚠️  no TIKTOK_ACCESS_TOKEN — skipping (soft)');
    return;
  }

  const slides = await renderCarouselSlides({
    kicker: 'CLASSIFICA DOGANE',
    title: 'Le dogane più veloci',
    subtitle: dayLabel,
    items: slideItems,
  });
  if (!slides) {
    console.log('⚠️  card fonts unavailable (public/fonts) — skipping (soft)');
    return;
  }
  const urls = uploadCarouselSlides(slides, { channel: 'tiktok', keyPrefix: `border-${weekStart}` });
  if (urls.some((u) => !u)) {
    console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
    return;
  }

  const res = await publishCarousel({ accessToken, imageUrls: urls, caption });
  if (!res.ok) {
    console.error(`⚠️  TikTok publish failed: ${res.reason}`);
    return;
  }
  console.log(`✅ posted — ${res.postId}`);
  appendLedger(
    LEDGER_PATH,
    [
      {
        id: weekStart,
        kind: 'border',
        url: tiktokUrl(buildOggiPath('it', fastest[0].slug), TIKTOK_CAMPAIGN_BORDER, weekStart),
        day: weekStart,
        ts: new Date().toISOString(),
        tiktokPostId: res.postId,
      },
    ],
    POSTED_TRIM_LIMIT,
  );
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  const dateArg = args.find((a) => a.startsWith('--date='));
  const day = dateArg ? dateArg.split('=')[1] : previousReportDay();

  console.log(`─── TikTok daily/weekly — day ${day}${dryRun ? ' (dry run)' : ''} ───`);

  const accessToken = dryRun ? null : await getAccessToken();

  // border is weekly and never runs implicitly — only when explicitly asked
  // for (the dedicated weekly cron passes --only=border).
  const kinds = only ? [only] : ['article', 'job'];

  for (const kind of kinds) {
    if (kind === 'border') {
      await postBorderCarousel({ dryRun, accessToken });
    } else if (kind === 'job' || kind === 'article') {
      await postGa4Carousel({ kind, day, dryRun, accessToken });
    } else {
      console.warn(`⚠️  unknown --only=${kind} — expected job, article or border`);
    }
  }
}

main()
  .catch((err) => {
    // Fail-soft: log and exit 0. See the header.
    console.error(`⚠️  post-to-tiktok failed: ${err.message}`);
  })
  .finally(() => process.exit(0));
