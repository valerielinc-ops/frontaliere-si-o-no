#!/usr/bin/env node
/**
 * post-to-instagram.mjs — Instagram Business account carousel posts:
 *   • yesterday's top-5 most-clicked JOBS   (--only=job,   daily)
 *   • yesterday's top-5 most-read ARTICLES  (--only=article, daily)
 *   • this week's top-5 fastest DOGANE      (--only=border, weekly)
 *
 * Same architecture as scripts/post-to-linkedin-member.mjs (GA4-ranked
 * candidates, a 30-day dedup ledger, fail-soft always exit 0) with one
 * structural difference: Instagram never unfurls a link the way Facebook/
 * LinkedIn/Telegram do, so every post here is an image carousel, never a
 * bare link. That is the one genuinely new piece — see scripts/lib/
 * social-carousel-image.mjs / social-carousel-upload.mjs.
 *
 * job/article run through the SAME candidate ranking as the LinkedIn member
 * poster (scripts/lib/daily-top-content.mjs), just carrying the top 5
 * unposted picks instead of 1 (scripts/lib/daily-top-content.mjs#pickTopNUnposted).
 * border is structurally different — a small, near-static set of ~26 Ticino
 * crossings where "top 5 fastest" barely changes week to week — so it dedups
 * once per ISO week (by weekStart) instead of per-item; see postBorderCarousel.
 *
 * Usage:
 *   npx tsx scripts/post-to-instagram.mjs                  # article + job
 *   npx tsx scripts/post-to-instagram.mjs --dry-run         # print, post nothing
 *   npx tsx scripts/post-to-instagram.mjs --only=job
 *   npx tsx scripts/post-to-instagram.mjs --only=border     # weekly cron only
 *   npx tsx scripts/post-to-instagram.mjs --date=2026-08-23
 *
 * Always via `npx tsx`, never plain `node`: --only=border transitively
 * imports build-plugins/borderWaitData.ts (crossing display names / page
 * links), same split as scripts/post-to-telegram.mjs's border mode.
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   INSTAGRAM_ACCESS_TOKEN          required — Meta App Review for
 *                                    instagram_content_publish not yet
 *                                    granted, so this is unset today and the
 *                                    poster soft-skips. See CLAUDE.md.
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID   required — already set (17841439417386982)
 *   GA4_PROPERTY_ID                 defaults to properties/524485296
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET
 *                                    required to host the carousel images —
 *                                    missing → upload-cdn-file.sh no-ops and
 *                                    this poster soft-skips (no image, no post)
 *
 * Fail-soft by design, same posture as every other channel in this family:
 * any missing credential, GA4 outage, or Graph API error logs and exits 0.
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
  instagramUrl,
  INSTAGRAM_CAMPAIGN_ARTICLE,
  INSTAGRAM_CAMPAIGN_JOB,
  INSTAGRAM_CAMPAIGN_BORDER,
} from './lib/instagram-links.mjs';
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
const LEDGER_PATH = path.join(ROOT, 'data', 'instagram-posted.json');
const POSTED_TRIM_LIMIT = 1000;

/** Same rationale as post-to-linkedin-member.mjs: forever-dedup would slowly
 *  starve the picker as a legitimately-recurring winner gets excluded for good. */
const DEDUP_WINDOW_DAYS = 30;
const CAROUSEL_SIZE = 5;

// Graph API version — check developers.facebook.com/docs/graph-api/changelog
// before the first real run; bump here if it has since been deprecated.
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const CONTAINER_STATUS_MAX_ATTEMPTS = 5;
const CONTAINER_STATUS_DELAY_MS = 2000;

// ─────────────────────────── credentials ───────────────────────────

function getAccessToken() {
  const token = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  return token || null;
}

function getBusinessAccountId() {
  const id = String(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim();
  return id || null;
}

// fetchGa4Day / formatDayIt / buildCarouselCaption moved to
// scripts/lib/ga4-service-account.mjs and scripts/lib/social-post-utils.mjs
// — the LinkedIn member poster (and, for the caption, the TikTok poster)
// need the identical logic (project rule: a helper duplicated literally in
// ≥2 files MUST live in ONE shared module).

// ─────────────────────────── Graph API ───────────────────────────

async function graphPost(pathSuffix, params, accessToken) {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetchRetry(`${GRAPH_API}/${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res?.ok || data.error) {
    return { ok: false, status: res?.status, error: data.error || { message: 'no response body' } };
  }
  return { ok: true, data };
}

async function waitForContainerReady(containerId, accessToken) {
  for (let attempt = 1; attempt <= CONTAINER_STATUS_MAX_ATTEMPTS; attempt++) {
    const res = await fetchRetry(
      `${GRAPH_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    const data = await res?.json().catch(() => ({}));
    const status = data?.status_code;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR' || status === 'EXPIRED') return false;
    await sleep(CONTAINER_STATUS_DELAY_MS);
  }
  return false;
}

/**
 * Full carousel publish: child containers → carousel container → publish.
 * Returns `{ok:true, mediaId}` or `{ok:false, reason}`. Never throws — every
 * Graph API error is caught and reported as a soft failure, same posture as
 * scripts/post-to-linkedin-member.mjs#publish.
 */
async function publishCarousel({ igUserId, accessToken, imageUrls, caption }) {
  const childIds = [];
  for (const imageUrl of imageUrls) {
    const res = await graphPost(`${igUserId}/media`, { image_url: imageUrl, is_carousel_item: 'true' }, accessToken);
    if (!res.ok) return { ok: false, reason: `child container failed: ${res.error?.message || res.status}` };
    childIds.push(res.data.id);
  }

  for (const id of childIds) {
    const ready = await waitForContainerReady(id, accessToken);
    if (!ready) return { ok: false, reason: `child container ${id} never reached FINISHED` };
  }

  const containerRes = await graphPost(
    `${igUserId}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    accessToken,
  );
  if (!containerRes.ok) {
    return { ok: false, reason: `carousel container failed: ${containerRes.error?.message || containerRes.status}` };
  }

  const publishRes = await graphPost(`${igUserId}/media_publish`, { creation_id: containerRes.data.id }, accessToken);
  if (!publishRes.ok) {
    return { ok: false, reason: `publish failed: ${publishRes.error?.message || publishRes.status}` };
  }
  return { ok: true, mediaId: publishRes.data.id };
}

// ─────────────────────────── job/article (daily) ───────────────────────────

async function postGa4Carousel({ kind, day, dryRun, accessToken, igUserId }) {
  const campaign = kind === 'job' ? INSTAGRAM_CAMPAIGN_JOB : INSTAGRAM_CAMPAIGN_ARTICLE;
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
  if (!accessToken || !igUserId) {
    console.log('⚠️  no INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID — skipping (soft)');
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
  const urls = uploadCarouselSlides(slides, { channel: 'instagram', keyPrefix: `${kind}-${day}` });
  if (urls.some((u) => !u)) {
    console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
    return;
  }

  const res = await publishCarousel({ igUserId, accessToken, imageUrls: urls, caption });
  if (!res.ok) {
    console.error(`⚠️  Instagram publish failed: ${res.reason}`);
    return;
  }
  console.log(`✅ posted — ${res.mediaId}`);
  appendLedger(
    LEDGER_PATH,
    picks.map((p) => ({
      id: p.slug,
      kind,
      url: instagramUrl(`${SITE_URL}${p.path}/`, campaign, p.slug),
      day,
      views: p.views,
      ts: new Date().toISOString(),
      instagramMediaId: res.mediaId,
    })),
    POSTED_TRIM_LIMIT,
  );
}

// ─────────────────────────── border (weekly) ───────────────────────────

async function postBorderCarousel({ dryRun, accessToken, igUserId }) {
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
  if (!accessToken || !igUserId) {
    console.log('⚠️  no INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID — skipping (soft)');
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
  const urls = uploadCarouselSlides(slides, { channel: 'instagram', keyPrefix: `border-${weekStart}` });
  if (urls.some((u) => !u)) {
    console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
    return;
  }

  const res = await publishCarousel({ igUserId, accessToken, imageUrls: urls, caption });
  if (!res.ok) {
    console.error(`⚠️  Instagram publish failed: ${res.reason}`);
    return;
  }
  console.log(`✅ posted — ${res.mediaId}`);
  appendLedger(
    LEDGER_PATH,
    [
      {
        id: weekStart,
        kind: 'border',
        url: instagramUrl(buildOggiPath('it', fastest[0].slug), INSTAGRAM_CAMPAIGN_BORDER, weekStart),
        day: weekStart,
        ts: new Date().toISOString(),
        instagramMediaId: res.mediaId,
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

  console.log(`─── Instagram daily/weekly — day ${day}${dryRun ? ' (dry run)' : ''} ───`);

  const accessToken = dryRun ? null : getAccessToken();
  const igUserId = dryRun ? null : getBusinessAccountId();

  // border is weekly and never runs implicitly — only when explicitly asked
  // for (the dedicated weekly cron passes --only=border).
  const kinds = only ? [only] : ['article', 'job'];

  for (const kind of kinds) {
    if (kind === 'border') {
      await postBorderCarousel({ dryRun, accessToken, igUserId });
    } else if (kind === 'job' || kind === 'article') {
      await postGa4Carousel({ kind, day, dryRun, accessToken, igUserId });
    } else {
      console.warn(`⚠️  unknown --only=${kind} — expected job, article or border`);
    }
  }
}

main()
  .catch((err) => {
    // Fail-soft: log and exit 0. See the header.
    console.error(`⚠️  post-to-instagram failed: ${err.message}`);
  })
  .finally(() => process.exit(0));
