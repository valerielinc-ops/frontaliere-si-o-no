#!/usr/bin/env node
/**
 * post-to-instagram.mjs — Instagram Business account carousel posts:
 *   • yesterday's top-5 most-clicked JOBS   (--only=job,   daily)
 *   • yesterday's top-5 most-read ARTICLES  (--only=article, daily)
 *   • this week's top-5 fastest DOGANE      (--only=border, weekly)
 *
 * Same candidate selection as scripts/post-to-linkedin-member.mjs (GA4-ranked
 * content and a 30-day dedup ledger), with one
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
 *   INSTAGRAM_ACCESS_TOKEN          required for live publishing through
 *                                    Meta's official Instagram Graph API.
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID   required — already set (17841439417386982)
 *   SOCIAL_ROBOT_MODE               retained for legacy configuration only;
 *                                   Instagram browser delivery is held and
 *                                   this publisher always requires Graph API.
 *   INSTAGRAM_CAROUSEL_BACKGROUND_AB_* Firebase-controlled four-arm background
 *                                   test; absent/invalid values keep the navy
 *                                   control and retries keep the same arm
 *   GA4_PROPERTY_ID                 defaults to properties/524485296
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET
 *                                    required to host carousel images; missing
 *                                    credentials fail the live workflow
 *
 * Live publishing fails visibly when Graph credentials or readiness are
 * missing, or rendering, CDN upload, or Graph delivery fails. Empty candidate
 * sets and cadence-cap holds remain ordinary skips.
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
} from './lib/social-post-utils.mjs';
import {
  instagramUrl,
  INSTAGRAM_CAMPAIGN_ARTICLE,
  INSTAGRAM_CAMPAIGN_JOB,
  INSTAGRAM_CAMPAIGN_BORDER,
} from './lib/instagram-links.mjs';
import {
  chooseInstagramCreative,
  buildInstagramCaption,
  buildInstagramCarouselProductionKit,
  instagramSocialVisualCopy,
  instagramCreativeContent,
  instagramCreativeLedgerFields,
} from './lib/instagram-creative.mjs';
import {
  assignInstagramCarouselBackground,
  instagramCarouselBackgroundLedgerFields,
} from './lib/instagram-carousel-background.mjs';
import {
  previousReportDay,
  rankCandidates,
  pickTopNUnposted,
} from './lib/daily-top-content.mjs';
import { fetchGa4PageReport } from './lib/ga4-service-account.mjs';
import { renderCarouselSlides } from './lib/social-carousel-image.mjs';
import { uploadCarouselSlides } from './lib/social-carousel-upload.mjs';
import {
  deliverSocialPost,
  dequeuePosts,
  queuePathFor,
  socialPublishRoute,
  isPublishedForKindDay,
} from './lib/social-publish-queue.mjs';
import { publishCarousel } from './lib/instagram-publish.mjs';
import { assertInstagramPublishReady } from './lib/instagram-publish-readiness.mjs';
import { buildSocialCopyBlockContext, loadSocialCopyPack, markSocialCopyAssignmentPublished, releaseUnpublishedSocialCopyAssignmentBestEffort, selectSocialCopyForPublish, socialCopyLedgerFields, socialCopyTrackingContent } from './lib/social-copy-pack.mjs';
import {
  markSocialPublishReservationPublished,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from './lib/social-publish-reservations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'instagram-posted.json');
const QUEUE_PATH = queuePathFor(ROOT, 'instagram');
const POSTED_TRIM_LIMIT = 1000;
const SOCIAL_COPY_PACK = loadSocialCopyPack({
  onWarning: (message) => console.warn(`⚠️  ${message}`),
});

/** Same rationale as post-to-linkedin-member.mjs: forever-dedup would slowly
 *  starve the picker as a legitimately-recurring winner gets excluded for good. */
const DEDUP_WINDOW_DAYS = 30;
const CAROUSEL_SIZE = 5;

// ─────────────────────────── credentials ───────────────────────────

function getAccessToken() {
  const token = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  return token || null;
}

function getBusinessAccountId() {
  const id = String(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim();
  return id || null;
}

// fetchGa4Day / formatDayIt moved to scripts/lib/ga4-service-account.mjs;
// Instagram-specific creative copy lives in scripts/lib/instagram-creative.mjs
// so the treatment, CTA and measurement metadata stay in one pure module.

// ─────────────────────────── Graph API ───────────────────────────
//
// The request/response layer lives in scripts/lib/instagram-publish.mjs so
// that tests/instagram-graph-publish-contract.test.ts can drive the whole
// three-step carousel flow against mocked payloads — this file calls main() at
// module scope and cannot be imported from a test. See that lib's header.

// ─────────────────────────── delivery ───────────────────────────
//
// Official Graph API only. The browser robot is policy-held for Instagram;
// SOCIAL_ROBOT_MODE cannot route a feed post around the API publisher.

async function deliver({ route, kind, day, caption, urls, ledgerEntries, publish, onAccepted, igUserId }) {
  const publishAt = new Date();
  const reservationKey = socialPublishReservationKey('instagram', 'post', `${kind}-${day}`);
  let reservationHeld = false;
  let deliveryRoute = route;
  if (route.api) {
    let results;
    try {
      results = await reserveSocialPublishBatch({
        platform: 'instagram',
        accountId: igUserId,
        repoRoot: ROOT,
        reservations: [{
          key: reservationKey,
          publishAt,
          nativeContentFingerprint: socialPublishContentFingerprint('instagram', { caption }),
        }],
        now: publishAt,
      });
    } catch (error) {
      const fatal = new Error(`Instagram shared publication gate failed: ${error.message}`, { cause: error });
      fatal.code = 'SOCIAL_PUBLISH_RESERVATION_REQUIRED';
      throw fatal;
    }
    if (results[0]?.allowed) {
      reservationHeld = true;
    } else {
      console.warn(`🛑 Instagram publication held for ${kind}-${day}: ${results[0]?.reason || 'daily-cap'}`);
      deliveryRoute = { ...route, api: false };
    }
  }

  const releaseReservation = async (reason) => {
    if (!reservationHeld) return;
    try {
      await releaseSocialPublishReservation({
        platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt,
      });
      reservationHeld = false;
    } catch (error) {
      console.warn(`⚠️ Instagram reservation remains held for ${kind}-${day} after ${reason}: ${error.message}`);
    }
  };

  const outcome = await deliverSocialPost({
    route: deliveryRoute,
    label: 'Instagram',
    publish: async () => {
      const result = await publish();
      if (result?.ok === false && result?.uncertain !== true) {
        await releaseReservation('definite Graph API rejection');
      }
      return result;
    },
    recordPublished: async (res) => {
      if (typeof res?.mediaId !== 'string' || !res.mediaId.trim()) {
        throw new Error('Instagram publisher returned success without a media ID');
      }
      console.log(`✅ posted — ${res.mediaId}`);
      const ts = new Date().toISOString();
      appendLedger(
        LEDGER_PATH,
        ledgerEntries.map((e) => ({
          ...e,
          ts,
          instagramMediaId: res.mediaId,
          instagramStoryImageUrl: urls[0],
        })),
        POSTED_TRIM_LIMIT,
      );
      if (reservationHeld) {
        try {
          await markSocialPublishReservationPublished({
            platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt, publishedAt: ts,
          });
        } catch (error) {
          console.warn(`⚠️ Instagram reservation remains held after accepted post ${kind}-${day}: ${error.message}`);
        }
      }
      await onAccepted?.(res, ts);
    },
    enqueue: () => {
      throw new Error('Instagram browser delivery is disabled for feed posts');
    },
    // The API covered this kind: an older queued post of it must not reach the robot.
    dequeue: () => dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind }),
  });
  if (outcome === 'api-uncertain') {
    const error = new Error(`Instagram ${kind}-${day} publish outcome is uncertain; reservation retained for reconciliation`);
    error.code = 'SOCIAL_PUBLISH_OUTCOME_UNCERTAIN';
    throw error;
  }
  if (outcome === 'api-failed') {
    const error = new Error(`Instagram ${kind}-${day} Graph API publish failed`);
    error.code = 'SOCIAL_PUBLISH_API_FAILED';
    throw error;
  }
  return outcome;
}

// ─────────────────────────── job/article (daily) ───────────────────────────

async function postGa4Carousel({ kind, day, dryRun, accessToken, igUserId }) {
  const campaign = kind === 'job' ? INSTAGRAM_CAMPAIGN_JOB : INSTAGRAM_CAMPAIGN_ARTICLE;
  const ledger = loadLedger(LEDGER_PATH);
  if (!dryRun && isPublishedForKindDay(ledger, { kind, day })) {
    const queueId = `${kind}-${day}`;
    dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind, queueId });
    console.log(`ℹ️  ${kind}: post ${queueId} già pubblicato — nessun replay e coda stale ripulita`);
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

  const sourceItems = picks.map((p) => {
    const job = kind === 'job' ? jobIndex.get(p.slug) : null;
    const sourceTitle = kind === 'job'
      ? (typeof job?.title === 'string' && job.title.trim()
        ? [job.title, typeof job.company === 'string' ? job.company : ''].filter(Boolean).join(' — ')
        : '')
      : typeof p.title === 'string' ? p.title : '';
    return { sourceId: p.slug, title: sourceTitle };
  });
  const slideItems = picks.map((p, index) => {
    const job = kind === 'job' ? jobIndex.get(p.slug) : null;
    const title = sourceItems[index].title || p.slug.replace(/-/g, ' ');
    return { title, statLabel: 'Visualizzazioni', statValue: String(p.views), footerNote: job?.location || '' };
  });
  const captionPicks = picks.map((p, i) => ({ title: slideItems[i].title, statValue: `${p.views} visualizzazioni` }));
  const dayLabel = formatDayIt(day);
  const creative = chooseInstagramCreative({ kind, day });
  const background = assignInstagramCarouselBackground({
    kind,
    day,
    creativeId: creative.id,
    objective: creative.objective,
  });
  const route = socialPublishRoute({ apiReady: Boolean(accessToken && igUserId), apiOnly: true });
  const socialCopy = await selectSocialCopyForPublish({
    pack: SOCIAL_COPY_PACK,
    channel: 'instagram',
    kind,
    expectedObjective: creative.objective,
    assignmentKey: kind + ':' + day,
    blockContext: buildSocialCopyBlockContext({ sourceClass: kind, scheduledDate: day }),
    allowExperimentExposure: route.api,
    dryRun,
  });
  let reservedCopy = socialCopy;
  let deliveryStarted = false;
  let publishRejected = false;
  try {
  const visualCopy = instagramSocialVisualCopy(creative, socialCopy);
  const productionKit = buildInstagramCarouselProductionKit({
    kind,
    dayLabel,
    items: slideItems,
    sourceItems,
    creative,
    backgroundVariant: background.id,
    visualCopy,
    caption: buildInstagramCaption({ kind, dayLabel, picks: captionPicks, creative, socialCopy }),
  });
  if (!productionKit.valid) {
    throw new Error('Instagram carousel source does not fit the verified renderer contract');
  }
  const caption = productionKit.caption;

  console.log(`\n─── ${kind} carousel (${picks.length} slides + CTA, creative: ${creative.id}, background: ${background.id}) ───`);
  console.log(caption);
  console.log('───');

  if (dryRun) return;
  if (!route.render) {
    throw new Error('Instagram Graph API credentials are required for live publishing');
  }

  const slides = await renderCarouselSlides(productionKit.renderInput);
  if (!slides) {
    throw new Error('Instagram carousel fonts are unavailable');
  }
  const urls = uploadCarouselSlides(slides, { channel: 'instagram', keyPrefix: `${kind}-${day}` });
  if (urls.some((u) => !u)) {
    throw new Error('Instagram carousel image upload failed; refusing to publish an incomplete carousel');
  }

  const ledgerEntries = picks.map((p) => ({
    id: p.slug,
    kind,
    url: instagramUrl(`${SITE_URL}${p.path}/`, campaign, socialCopyTrackingContent(
      instagramCreativeContent(creative, p.slug, background.id),
      socialCopy,
    )),
    day,
    views: p.views,
    ...instagramCreativeLedgerFields(creative),
    ...instagramCarouselBackgroundLedgerFields(background),
    ...socialCopyLedgerFields(socialCopy, { fallbackHook: creative.lead, fallbackCta: creative.cta }),
  }));
  await deliver({
    route,
    kind,
    day,
    igUserId,
    caption,
    urls,
    ledgerEntries,
    publish: async () => {
      deliveryStarted = true;
      const result = await publishCarousel({ igUserId, accessToken, imageUrls: urls, caption });
      publishRejected = result?.ok === false && result?.uncertain !== true;
      return result;
    },
    onAccepted: async (result, publishedAt) => {
      reservedCopy = null;
      if (!route.api) return;
      try {
        await markSocialCopyAssignmentPublished(socialCopy, { postId: result?.mediaId, publishedAt });
      } catch (error) {
        console.warn('⚠️  accepted Instagram post could not close its copy assignment:', error.message);
      }
    },
  });
  } finally {
    // A thrown API request has an unknown delivery outcome. Keep its stable
    // assignment until the ledger can reconcile it; release only certain
    // skips before the publish attempt.
    if (deliveryStarted && route.api && !publishRejected) reservedCopy = null;
    await releaseUnpublishedSocialCopyAssignmentBestEffort(reservedCopy, {
      reason: 'Instagram carousel skipped before delivery',
      onFailure: (err) => console.warn('⚠️', `could not release social-copy reservation for Instagram ${kind}: ${err.message}`),
    });
  }
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
  const creative = chooseInstagramCreative({ kind: 'border', day: weekStart });
  const background = assignInstagramCarouselBackground({
    kind: 'border',
    day: weekStart,
    creativeId: creative.id,
    objective: creative.objective,
  });
  const route = socialPublishRoute({ apiReady: Boolean(accessToken && igUserId), apiOnly: true });
  const socialCopy = await selectSocialCopyForPublish({
    pack: SOCIAL_COPY_PACK,
    channel: 'instagram',
    kind: 'border',
    expectedObjective: creative.objective,
    assignmentKey: 'border:' + weekStart,
    blockContext: buildSocialCopyBlockContext({ sourceClass: 'border', scheduledDate: weekStart }),
    allowExperimentExposure: route.api,
    dryRun,
  });
  let reservedCopy = socialCopy;
  let deliveryStarted = false;
  let publishRejected = false;
  try {
  const visualCopy = instagramSocialVisualCopy(creative, socialCopy);
  const productionKit = buildInstagramCarouselProductionKit({
    kind: 'border',
    dayLabel,
    items: slideItems,
    sourceItems: fastest.map((crossing) => ({
      sourceId: crossing.slug,
      title: BORDER_CROSSING_DISPLAY[crossing.slug] || '',
    })),
    creative,
    backgroundVariant: background.id,
    visualCopy,
    caption: buildInstagramCaption({
      kind: 'border',
      dayLabel,
      picks: fastest.map((r, i) => ({ title: slideItems[i].title, statValue: fmtMinutes(r.avgMinutes) })),
      creative,
      socialCopy,
    }),
  });
  if (!productionKit.valid) {
    throw new Error('Instagram carousel source does not fit the verified renderer contract');
  }
  const caption = productionKit.caption;

  console.log(`\n─── border carousel (${fastest.length} slides + CTA, creative: ${creative.id}, background: ${background.id}) ───`);
  console.log(caption);
  console.log('───');

  if (dryRun) return;
  if (!route.render) {
    throw new Error('Instagram Graph API credentials are required for live publishing');
  }

  const slides = await renderCarouselSlides(productionKit.renderInput);
  if (!slides) {
    throw new Error('Instagram carousel fonts are unavailable');
  }
  const urls = uploadCarouselSlides(slides, { channel: 'instagram', keyPrefix: `border-${weekStart}` });
  if (urls.some((u) => !u)) {
    throw new Error('Instagram carousel image upload failed; refusing to publish an incomplete carousel');
  }

  const ledgerEntries = [
    {
      id: weekStart,
      kind: 'border',
      url: instagramUrl(
        buildOggiPath('it', fastest[0].slug),
        INSTAGRAM_CAMPAIGN_BORDER,
        socialCopyTrackingContent(
          instagramCreativeContent(creative, weekStart, background.id),
          socialCopy,
        ),
      ),
      day: weekStart,
      ...instagramCreativeLedgerFields(creative),
      ...instagramCarouselBackgroundLedgerFields(background),
      ...socialCopyLedgerFields(socialCopy, { fallbackHook: creative.lead, fallbackCta: creative.cta }),
    },
  ];
  await deliver({
    route,
    kind: 'border',
    day: weekStart,
    igUserId,
    caption,
    urls,
    ledgerEntries,
    publish: async () => {
      deliveryStarted = true;
      const result = await publishCarousel({ igUserId, accessToken, imageUrls: urls, caption });
      publishRejected = result?.ok === false && result?.uncertain !== true;
      return result;
    },
    onAccepted: async (result, publishedAt) => {
      reservedCopy = null;
      if (!route.api) return;
      try {
        await markSocialCopyAssignmentPublished(socialCopy, { postId: result?.mediaId, publishedAt });
      } catch (error) {
        console.warn('⚠️  accepted Instagram post could not close its copy assignment:', error.message);
      }
    },
  });
  } finally {
    if (deliveryStarted && route.api && !publishRejected) reservedCopy = null;
    await releaseUnpublishedSocialCopyAssignmentBestEffort(reservedCopy, {
      reason: 'Instagram border carousel skipped before delivery',
      onFailure: (err) => console.warn('⚠️', `could not release social-copy reservation for Instagram border: ${err.message}`),
    });
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

  console.log(`─── Instagram daily/weekly — day ${day}${dryRun ? ' (dry run)' : ''} ───`);

  const accessToken = dryRun ? null : getAccessToken();
  const igUserId = dryRun ? null : getBusinessAccountId();
  if (!dryRun && (!accessToken || !igUserId)) {
    const error = new Error('Instagram live publishing is unavailable: configure the approved Graph API token and business account ID in Remote Config');
    error.code = 'SOCIAL_PUBLISH_CREDENTIALS_REQUIRED';
    throw error;
  }
  if (!dryRun) await assertInstagramPublishReady();

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

let exitCode = 0;
main()
  .catch((err) => {
    console.error(`⚠️  post-to-instagram failed: ${err.message}`);
    exitCode = 1;
  })
  .finally(() => process.exit(exitCode));
