#!/usr/bin/env node
/**
 * post-to-tiktok.mjs — TikTok content preview; automated delivery is held:
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
 * 1. Photo/carousel posts on the existing API path use a dedicated JSON
 *    endpoint (not the same media endpoint as video), and only accept
 *    JPEG/WEBP — never PNG. See scripts/lib/social-carousel-image.mjs.
 *    The Playwright queue path additionally prepares an MP4 from those same
 *    JPEG slides because TikTok's web upload accepts video only.
 * 2. The image URLs' DOMAIN must be verified in the TikTok developer console
 *    (DNS or .well-known file) before PULL_FROM_URL works at all — a
 *    one-time setup step, not something this script can do.
 * 3. Publishing is a two-call async flow: `content/init/` returns a
 *    `publish_id` immediately, then `status/fetch/` is polled until the
 *    post is PUBLISH_COMPLETE (or FAILED) — see waitForPublishComplete.
 * 4. The current TikTok guidelines reject an internal uploader for accounts
 *    managed by the developer or team. The scheduled API route and browser
 *    queue are held regardless of token or audit status; the legacy request
 *    implementation below is not an authorization to publish.
 * 5. TikTok user-token rotation remains implemented for the separate
 *    read-only insights collector. This publisher does not load or refresh
 *    TikTok credentials while automated delivery is held.
 *
 * The exact request/response shape below is written from TikTok's published
 * Content Posting API docs, cross-checked field-by-field against the docs a
 * second time when scripts/tiktok-auth.mjs was added (including the
 * `publicaly_available_post_id` misspelling in TikTok's own response, which
 * is intentional here, not a bug) — but still never exercised against a live
 * call. The route remains held until TikTok confirms an eligible use case and
 * the creator-facing client meets current requirements. A token or API audit
 * does not clear this internal team workflow.
 *
 * Usage:
 *   npx tsx scripts/post-to-tiktok.mjs                     # article + job
 *   npx tsx scripts/post-to-tiktok.mjs --dry-run             # print, post nothing
 *   npx tsx scripts/post-to-tiktok.mjs --only=job
 *   npx tsx scripts/post-to-tiktok.mjs --only=border          # weekly cron only
 *   npx tsx scripts/post-to-tiktok.mjs --date=2026-08-23
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   TikTok tokens are not read by this scheduled publisher while the policy
 *   hold is active. Read-only insights use their separate collector/workflow.
 *   SOCIAL_ROBOT_MODE      off | dry (default) | live — API or the
 *                          Playwright robot's queue (data/tiktok-queue.json);
 *                          see scripts/lib/social-publish-queue.mjs
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
  buildTikTokCaption,
  buildCarouselSlideCopy,
} from './lib/social-post-utils.mjs';
import {
  tiktokUrl,
  tiktokContentId,
  TIKTOK_CAMPAIGN_ARTICLE,
  TIKTOK_CAMPAIGN_JOB,
  TIKTOK_CAMPAIGN_BORDER,
} from './lib/tiktok-links.mjs';
import {
  previousReportDay,
  rankCandidates,
  pickTopNUnposted,
} from './lib/daily-top-content.mjs';
import { fetchGa4PageReport } from './lib/ga4-service-account.mjs';
import { renderAnswerCards, renderCarouselSlides } from './lib/social-carousel-image.mjs';
import { ARTICLES_API_BASE } from './lib/articles-api-base.mjs';
import { uploadCarouselSlides, uploadCarouselVideo } from './lib/social-carousel-upload.mjs';
import {
  articleBodyApiPath,
  buildAnswerCaption,
  buildAnswerCards,
  buildAnswerVoiceScript,
  parseArticleFaq,
  planAnswerTimeline,
  selectAnswerFaq,
  synthesizeAnswerVoice,
} from './lib/tiktok-answer-format.mjs';
import {
  renderAnswerVideo,
  renderCarouselVideo,
  renderMotionGraphicVideo,
  renderHookThreeSlidesVideo,
  renderSingleStatVideo,
} from './lib/social-carousel-video.mjs';
import {
  TIKTOK_VIDEO_CREATIVE_VARIANTS,
  isTikTokAnswerFormatAssigned,
  resolveTikTokVideoCreativeVariant,
  tiktokVideoCreativeLedgerFields,
  tiktokVideoCreativeLabel,
} from './lib/tiktok-video-creative.mjs';
import {
  buildQueueEntry,
  deliverSocialPost,
  dequeuePosts,
  enqueuePost,
  queuePathFor,
  resolveSocialRobotMode,
  socialPublishRoute,
  isPublishedForKindDay,
} from './lib/social-publish-queue.mjs';
import { publishCarousel } from './lib/tiktok-publish.mjs';
import { shouldHoldAutomatedSocialDelivery, socialAutomatedDeliveryPolicy } from './lib/social-automation-policy.mjs';
import {
  loadSocialCopyPack,
  releaseSocialCopyAssignment,
  selectSocialCopyForPublish,
  socialCopyLedgerFields,
  socialCopyTrackingContent,
} from './lib/social-copy-pack.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'tiktok-posted.json');
const QUEUE_PATH = queuePathFor(ROOT, 'tiktok');
const POSTED_TRIM_LIMIT = 1000;
const SOCIAL_COPY_PACK = loadSocialCopyPack({
  onWarning: (message) => console.warn(`⚠️  ${message}`),
});

const DEDUP_WINDOW_DAYS = 30;
const CAROUSEL_SIZE = 5;
const ANSWER_CANDIDATE_POOL = 30;

// ─────────────────────────── credentials ───────────────────────────

// ─────────────────────────── Content Posting API ───────────────────────────
//
// The request/response layer lives in scripts/lib/tiktok-publish.mjs so that
// tests/tiktok-content-posting-contract.test.ts can drive the whole two-call
// async flow against mocked payloads — this file calls main() at module scope
// and cannot be imported from a test. See that lib's header.

// ─────────────────────────── delivery ───────────────────────────
//
// API or the Playwright robot's queue, chosen by the Remote Config switch
// SOCIAL_ROBOT_MODE — see scripts/lib/social-publish-queue.mjs. The ledger is
// written here only for an API publish; a queued post reaches the ledger once
// the robot has seen TikTok's confirmation (scripts/social-robot/confirm.mjs).

async function deliver({ route, kind, day, caption, urls, video, ledgerEntries, publish, onAccepted }) {
  const creativeLedgerEntries = video?.creativeVariant
    ? ledgerEntries.map((entry) => ({ ...entry, ...tiktokVideoCreativeLedgerFields(video.creativeVariant) }))
    : ledgerEntries;
  return deliverSocialPost({
    route,
    label: 'TikTok',
    publish,
    recordPublished: (res) => {
      const postId = typeof res?.postId === 'string' && res.postId.trim() ? res.postId.trim() : null;
      const publishId = typeof res?.publishId === 'string' && res.publishId.trim() ? res.publishId.trim() : null;
      if (!postId && !publishId) {
        throw new Error('TikTok publisher returned success without a publish or native post ID');
      }
      onAccepted?.();
      console.log(`✅ TikTok publish accepted${postId ? ` — ${postId}` : ` — operation ${publishId} (native post ID unavailable)`}`);
      const ts = new Date().toISOString();
      appendLedger(
        LEDGER_PATH,
        creativeLedgerEntries.map((e) => ({
          ...e,
          ts,
          ...(postId ? { tiktokPostId: postId } : {}),
          ...(publishId ? { tiktokPublishId: publishId } : {}),
        })),
        POSTED_TRIM_LIMIT,
      );
    },
    enqueue: () => {
      enqueuePost(
        QUEUE_PATH,
        buildQueueEntry({ channel: 'tiktok', kind, day, caption, imageUrls: urls, video, ledgerEntries: creativeLedgerEntries }),
      );
      onAccepted?.();
    },
    // The API covered this kind: an older queued post of it must not reach the robot.
    dequeue: () => dequeuePosts(QUEUE_PATH, { channel: 'tiktok', kind }),
  });
}

async function releaseUnpublishedCopyAssignment(copy, reason) {
  if (copy?.copyAssignmentMode !== 'firebase-balanced') return;
  const released = await releaseSocialCopyAssignment(copy);
  if (!released) throw new Error(`TikTok copy assignment could not be released: ${reason}`);
}

function prepareTikTokVideo(slides, keyPrefix, queueId) {
  try {
    const creativeVariant = resolveTikTokVideoCreativeVariant({ queueId });
    const renderers = {
      [TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL]: renderCarouselVideo,
      [TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT]: renderMotionGraphicVideo,
      [TIKTOK_VIDEO_CREATIVE_VARIANTS.HOOK]: renderHookThreeSlidesVideo,
      [TIKTOK_VIDEO_CREATIVE_VARIANTS.SPOTLIGHT]: renderSingleStatVideo,
    };
    const render = renderers[creativeVariant] || renderCarouselVideo;
    const rendered = render(slides);
    const url = uploadCarouselVideo(rendered.buffer, { channel: 'tiktok', keyPrefix });
    if (!url) return null;
    console.log(`🎬 TikTok video: ${tiktokVideoCreativeLabel(creativeVariant)} (${creativeVariant})`);
    return {
      url,
      bytes: rendered.bytes,
      sha256: rendered.sha256,
      durationMs: rendered.durationMs,
      width: rendered.width,
      height: rendered.height,
      creativeVariant,
    };
  } catch (err) {
    console.warn(`⚠️  TikTok video unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Build the spoken answer from the first ranked article with a usable FAQ.
 * Any failure returns null, and the post keeps the slide format: the queue
 * entry always records the creative that was really rendered.
 */
async function prepareTikTokAnswer(candidates, queueId, socialCopy) {
  if (!isTikTokAnswerFormatAssigned({ queueId })) return null;
  try {
    for (const pick of candidates) {
      const apiPath = articleBodyApiPath(pick.path);
      if (!apiPath) continue;
      const response = await fetch(`${ARTICLES_API_BASE}/${apiPath}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const faq = selectAnswerFaq(parseArticleFaq(await response.json()));
      if (!faq) continue;
      const cards = buildAnswerCards(faq, socialCopy);
      const { wav, seconds } = await synthesizeAnswerVoice(buildAnswerVoiceScript(cards));
      const images = await renderAnswerCards(cards, { footer: 'frontaliereticino.ch' });
      if (!images) return null;
      const creativeVariant = TIKTOK_VIDEO_CREATIVE_VARIANTS.ANSWER;
      const rendered = renderAnswerVideo(images, planAnswerTimeline(cards, seconds), wav);
      const url = uploadCarouselVideo(rendered.buffer, { channel: 'tiktok', keyPrefix: queueId });
      if (!url) return null;
      console.log(`🎬 TikTok video: ${tiktokVideoCreativeLabel(creativeVariant)} (${creativeVariant}) — ${faq.question}`);
      return {
        pick,
        caption: buildAnswerCaption(faq, socialCopy),
        video: {
          url,
          bytes: rendered.bytes,
          sha256: rendered.sha256,
          durationMs: rendered.durationMs,
          width: rendered.width,
          height: rendered.height,
          creativeVariant,
        },
      };
    }
    console.log('ℹ️  TikTok answer: no ranked article has a usable FAQ — slide format');
  } catch (err) {
    console.warn(`⚠️  TikTok answer unavailable, slide format: ${err.message}`);
  }
  return null;
}

// ─────────────────────────── job/article (daily) ───────────────────────────

async function postGa4Carousel({ kind, day, dryRun, accessToken, robotMode }) {
  const campaign = kind === 'job' ? TIKTOK_CAMPAIGN_JOB : TIKTOK_CAMPAIGN_ARTICLE;
  const ledger = loadLedger(LEDGER_PATH);
  if (!dryRun && isPublishedForKindDay(ledger, { kind, day })) {
    const queueId = `${kind}-${day}`;
    dequeuePosts(QUEUE_PATH, { channel: 'tiktok', kind, queueId });
    console.log(`ℹ️  ${kind}: post TikTok ${queueId} già pubblicato — nessun replay e coda stale ripulita`);
    return;
  }
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
  const dayLabel = formatDayIt(day);
  const route = socialPublishRoute({
    mode: robotMode,
    apiReady: Boolean(accessToken),
  });
  if (!dryRun && !route.render) {
    console.log('⚠️  no TIKTOK_ACCESS_TOKEN — skipping (soft)');
    return;
  }
  const socialCopyFormat = route.enqueue ? 'video' : kind;
  const socialCopy = await selectSocialCopyForPublish({
    pack: SOCIAL_COPY_PACK,
    channel: 'tiktok',
    kind,
    format: socialCopyFormat,
    assignmentKey: kind + '-' + day,
    dryRun,
  });
  let reservedCopy = socialCopy;
  try {
    let caption = buildTikTokCaption({ kind, dayLabel, picks: captionPicks, socialCopy });

    console.log(`\n─── ${kind} carousel (${picks.length} slides) ───`);
    console.log(caption);
    console.log('───');

    if (dryRun) return;

    let slides = await renderCarouselSlides(buildCarouselSlideCopy({ kind, dayLabel, items: slideItems, socialCopy }));
    if (!slides) {
      console.log('⚠️  card fonts unavailable (public/fonts) — skipping (soft)');
      return;
    }
    const queueId = `${kind}-${day}`;
    // The whole ranking, not the five slides: the best question may rank sixth.
    const answer = route.enqueue && kind === 'article'
      ? await prepareTikTokAnswer(pickTopNUnposted(candidates, recent, ANSWER_CANDIDATE_POOL).picks, queueId, socialCopy)
      : null;
    let appliedSocialCopy = socialCopy;
    const video = answer?.video ?? (route.enqueue ? prepareTikTokVideo(slides, queueId, queueId) : null);
    if (route.enqueue && !video) {
      await releaseUnpublishedCopyAssignment(reservedCopy, 'video preparation failed');
      reservedCopy = null;
      if (!route.api) {
        console.log('⚠️  TikTok robot transport needs an MP4 — skipping this post');
        return;
      }
      console.log('⚠️  TikTok MP4 unavailable — preserving the API path without queue fallback');
      appliedSocialCopy = await selectSocialCopyForPublish({
        pack: SOCIAL_COPY_PACK,
        channel: 'tiktok',
        kind,
        assignmentKey: kind + '-' + day,
        dryRun,
      });
      reservedCopy = appliedSocialCopy;
      caption = buildTikTokCaption({ kind, dayLabel, picks: captionPicks, socialCopy: appliedSocialCopy });
    }
    if (JSON.stringify(appliedSocialCopy) !== JSON.stringify(socialCopy)) {
      slides = await renderCarouselSlides(buildCarouselSlideCopy({ kind, dayLabel, items: slideItems, socialCopy: appliedSocialCopy }));
      if (!slides) {
        console.log('⚠️  fallback carousel fonts unavailable (public/fonts) — skipping (soft)');
        return;
      }
    }
    const urls = uploadCarouselSlides(slides, { channel: 'tiktok', keyPrefix: `${kind}-${day}` });
    if (urls.some((u) => !u)) {
      console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
      return;
    }

    const ledgerEntries = (answer ? [answer.pick] : picks).map((p) => ({
      id: p.slug,
      kind,
      url: tiktokUrl(
        `${SITE_URL}${p.path}/`,
        campaign,
        socialCopyTrackingContent(tiktokContentId(p.slug, video?.creativeVariant), appliedSocialCopy),
      ),
      day,
      views: p.views,
      ...socialCopyLedgerFields(appliedSocialCopy),
    }));
    await deliver({
      route: video ? route : { ...route, enqueue: false },
      kind,
      day,
      caption: answer?.caption ?? caption,
      urls,
      video,
      ledgerEntries,
      publish: async () => {
        try {
          return await publishCarousel({ accessToken, imageUrls: urls, caption });
        } catch (err) {
          // The request may have reached TikTok even if its response was lost.
          reservedCopy = null;
          throw err;
        }
      },
      onAccepted: () => { reservedCopy = null; },
    });
  } finally {
    await releaseUnpublishedCopyAssignment(reservedCopy, 'TikTok carousel did not reach API or queue delivery');
  }
}

// ─────────────────────────── border (weekly) ───────────────────────────

async function postBorderCarousel({ dryRun, accessToken, robotMode }) {
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
  const route = socialPublishRoute({
    mode: robotMode,
    apiReady: Boolean(accessToken),
  });
  if (!dryRun && !route.render) {
    console.log('⚠️  no TIKTOK_ACCESS_TOKEN — skipping (soft)');
    return;
  }
  const socialCopyFormat = route.enqueue ? 'video' : 'border';
  const socialCopy = await selectSocialCopyForPublish({
    pack: SOCIAL_COPY_PACK,
    channel: 'tiktok',
    kind: 'border',
    format: socialCopyFormat,
    assignmentKey: 'border-' + weekStart,
    dryRun,
  });
  let reservedCopy = socialCopy;
  try {
    let caption = buildTikTokCaption({
      kind: 'border',
      dayLabel,
      picks: fastest.map((r, i) => ({ title: slideItems[i].title, statValue: fmtMinutes(r.avgMinutes) })),
      socialCopy,
    });

    console.log(`\n─── border carousel (${fastest.length} slides) ───`);
    console.log(caption);
    console.log('───');

    if (dryRun) return;

    let slides = await renderCarouselSlides(buildCarouselSlideCopy({ kind: 'border', dayLabel, items: slideItems, socialCopy }));
    if (!slides) {
      console.log('⚠️  card fonts unavailable (public/fonts) — skipping (soft)');
      return;
    }
    const queueId = `border-${weekStart}`;
    let appliedSocialCopy = socialCopy;
    const video = route.enqueue ? prepareTikTokVideo(slides, queueId, queueId) : null;
    if (route.enqueue && !video) {
      await releaseUnpublishedCopyAssignment(reservedCopy, 'border video preparation failed');
      reservedCopy = null;
      if (!route.api) {
        console.log('⚠️  TikTok robot transport needs an MP4 — skipping this post');
        return;
      }
      console.log('⚠️  TikTok MP4 unavailable — preserving the API path without queue fallback');
      appliedSocialCopy = await selectSocialCopyForPublish({
        pack: SOCIAL_COPY_PACK,
        channel: 'tiktok',
        kind: 'border',
        assignmentKey: 'border-' + weekStart,
        dryRun,
      });
      reservedCopy = appliedSocialCopy;
      caption = buildTikTokCaption({
        kind: 'border',
        dayLabel,
        picks: fastest.map((r, i) => ({ title: slideItems[i].title, statValue: fmtMinutes(r.avgMinutes) })),
        socialCopy: appliedSocialCopy,
      });
    }
    if (JSON.stringify(appliedSocialCopy) !== JSON.stringify(socialCopy)) {
      slides = await renderCarouselSlides(buildCarouselSlideCopy({ kind: 'border', dayLabel, items: slideItems, socialCopy: appliedSocialCopy }));
      if (!slides) {
        console.log('⚠️  fallback carousel fonts unavailable (public/fonts) — skipping (soft)');
        return;
      }
    }
    const urls = uploadCarouselSlides(slides, { channel: 'tiktok', keyPrefix: `border-${weekStart}` });
    if (urls.some((u) => !u)) {
      console.log('⚠️  one or more carousel images failed to reach the CDN — skipping this post rather than shipping a broken carousel');
      return;
    }

    const ledgerEntries = [
      {
        id: weekStart,
        kind: 'border',
        url: tiktokUrl(
          buildOggiPath('it', fastest[0].slug),
          TIKTOK_CAMPAIGN_BORDER,
          socialCopyTrackingContent(tiktokContentId(weekStart, video?.creativeVariant), appliedSocialCopy),
        ),
        day: weekStart,
        ...socialCopyLedgerFields(appliedSocialCopy),
      },
    ];
    await deliver({
      route: video ? route : { ...route, enqueue: false },
      kind: 'border',
      day: weekStart,
      caption,
      urls,
      video,
      ledgerEntries,
      publish: async () => {
        try {
          return await publishCarousel({ accessToken, imageUrls: urls, caption });
        } catch (err) {
          reservedCopy = null;
          throw err;
        }
      },
      onAccepted: () => { reservedCopy = null; },
    });
  } finally {
    await releaseUnpublishedCopyAssignment(reservedCopy, 'TikTok border post did not reach API or queue delivery');
  }
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

  const deliveryPolicy = socialAutomatedDeliveryPolicy('tiktok');
  if (shouldHoldAutomatedSocialDelivery('tiktok', { dryRun })) {
    console.warn(`⏸️  ${deliveryPolicy.reason} Use --dry-run for content preview; native insights remain on their separate read-only workflow.`);
    return;
  }

  const robotMode = resolveSocialRobotMode();
  console.log(`ℹ️  SOCIAL_ROBOT_MODE=${robotMode} (Remote Config; see scripts/lib/social-publish-queue.mjs)`);

  const accessToken = null;

  // border is weekly and never runs implicitly — only when explicitly asked
  // for (the dedicated weekly cron passes --only=border).
  const kinds = only ? [only] : ['article', 'job'];

  for (const kind of kinds) {
    if (kind === 'border') {
      await postBorderCarousel({ dryRun, accessToken, robotMode });
    } else if (kind === 'job' || kind === 'article') {
      await postGa4Carousel({ kind, day, dryRun, accessToken, robotMode });
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
