#!/usr/bin/env node
/**
 * Publish one controlled Instagram Reel through the official Graph API.
 *
 * This is intentionally separate from post-to-instagram.mjs: a Reel is a
 * different creative treatment and ledger cohort. The workflow reserves two
 * controlled experiment slots per week without adding a third daily post.
 *
 * Usage:
 *   npx tsx scripts/post-to-instagram-reel.mjs --dry-run
 *   npx tsx scripts/post-to-instagram-reel.mjs --kind=article --date=2026-10-10
 *
 * The normal path sends the vertical MP4 to Instagram's Graph API, waits for
 * container processing, and records the exact published media ID. Reels never
 * fall back to browser automation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_URL,
  loadLedger,
  appendLedger,
  loadJobIndex,
  loadJobSections,
  formatDayIt,
} from './lib/social-post-utils.mjs';
import { instagramUrl, INSTAGRAM_CAMPAIGN_REEL } from './lib/instagram-links.mjs';
import {
  chooseInstagramReelCreative,
  buildInstagramReelContent,
  instagramReelLedgerFields,
} from './lib/instagram-reel-creative.mjs';
import { previousReportDay, rankCandidates, pickTopNUnposted } from './lib/daily-top-content.mjs';
import { fetchGa4PageReport } from './lib/ga4-service-account.mjs';
import { pendingInstagramReel, recentInstagramReel } from './lib/instagram-reel-queue.mjs';
import { renderReelSlides } from './lib/social-reel-image.mjs';
import { renderAnswerVideo } from './lib/social-carousel-video.mjs';
import { planAnswerTimeline, synthesizeAnswerVoice } from './lib/tiktok-answer-format.mjs';
import { uploadCarouselSlides, uploadCarouselVideo } from './lib/social-carousel-upload.mjs';
import {
  buildQueueEntry,
  dequeuePosts,
  loadQueue,
  queuePathFor,
  resolveSocialRobotMode,
  socialPublishRoute,
  isPublishedForKindDay,
} from './lib/social-publish-queue.mjs';
import { publishReel as publishInstagramReel } from './lib/instagram-publish.mjs';
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
const DEDUP_WINDOW_DAYS = 30;
const POSTED_TRIM_LIMIT = 1000;
const SOCIAL_COPY_PACK = loadSocialCopyPack({
  onWarning: (message) => console.warn(`⚠️  ${message}`),
});

function parseArgs(argv) {
  const args = { dryRun: false, kind: 'article', day: previousReportDay() };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--kind=')) args.kind = arg.slice('--kind='.length);
    else if (arg.startsWith('--date=')) args.day = arg.slice('--date='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['article', 'job'].includes(args.kind)) throw new Error('--kind must be article or job');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) throw new Error('--date must be YYYY-MM-DD');
  return args;
}

function sourceIdFor(entry) {
  return entry.slug;
}

function sourceUrlFor(pick) {
  return `${SITE_URL}${pick.path}/`;
}

function recentReelSources(ledger, kind, now = Date.now()) {
  const cutoff = now - DEDUP_WINDOW_DAYS * 86400000;
  return new Set(
    ledger.posted
      .filter((entry) => entry?.kind === 'reel' && entry?.sourceKind === kind)
      .filter((entry) => {
        const ts = Date.parse(entry?.ts ?? '');
        return Number.isFinite(ts) ? ts >= cutoff : true;
      })
      .map((entry) => entry?.sourceId)
      .filter(Boolean),
  );
}

function buildItem(kind, pick, jobIndex) {
  const job = kind === 'job' ? jobIndex.get(pick.slug) : null;
  return {
    title: kind === 'job'
      ? (typeof job?.title === 'string' && job.title.trim()
        ? [job.title, typeof job.company === 'string' ? job.company : ''].filter(Boolean).join(' — ')
        : '')
      : pick.title,
    views: pick.views,
    slug: pick.slug,
    path: pick.path,
  };
}

async function publishReelSlot({ kind, day, dryRun, robotMode }) {
  const ledger = loadLedger(LEDGER_PATH);
  if (!dryRun && isPublishedForKindDay(ledger, { kind: 'reel', day })) {
    dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind: 'reel' });
    console.log(`ℹ️  Reel ${day} già pubblicato — nessun replay e coda browser stale rimossa`);
    return 'already-published';
  }

  const accessToken = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim() || null;
  const igUserId = String(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim() || null;
  const route = socialPublishRoute({ mode: robotMode, apiReady: Boolean(accessToken && igUserId), apiOnly: true });
  const pending = pendingInstagramReel(loadQueue(QUEUE_PATH));
  if (pending) {
    const creativeId = pending.ledgerEntries?.[0]?.creativeId || 'creative non specificata';
    if (!dryRun && isPublishedForKindDay(ledger, { kind: 'reel', day: pending.day })) {
      dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind: 'reel', queueId: pending.id });
      console.log(`ℹ️  Reel legacy ${pending.id} risulta già pubblicato — coda stale rimossa senza replay`);
      return 'already-published-legacy-queue';
    }
    if (dryRun) {
      console.log(`ℹ️  Instagram Reel legacy in coda: ${pending.id} (${creativeId}) — dry run, nessuna pubblicazione`);
      return 'dry-run';
    }
    if (!route.api) {
      console.log(`⚠️  Instagram Reel ${pending.id} resta in coda: INSTAGRAM_ACCESS_TOKEN o INSTAGRAM_BUSINESS_ACCOUNT_ID mancante`);
      return 'credentials-missing';
    }
    if (!pending.video?.url || !pending.imageUrls?.[0] || !Array.isArray(pending.ledgerEntries)) {
      console.log(`⚠️  Instagram Reel legacy ${pending.id} non ha video, cover o ledger validi; resta in coda per diagnosi`);
      return 'invalid-legacy-queue-entry';
    }
    const publishAt = new Date();
    const reservationKey = socialPublishReservationKey('instagram', 'post', pending.id);
    const reservation = await reserveSocialPublishBatch({
      platform: 'instagram',
      accountId: igUserId,
      repoRoot: ROOT,
      reservations: [{
        key: reservationKey,
        publishAt,
        nativeContentFingerprint: socialPublishContentFingerprint('instagram', { caption: pending.caption }),
      }],
      now: publishAt,
    });
    if (!reservation[0]?.allowed) {
      console.log(`🛑 Instagram Reel ${pending.id} held by shared daily cap (${reservation[0]?.reason || 'reservation-denied'})`);
      return 'cap-held';
    }
    const result = await publishInstagramReel({
      igUserId,
      accessToken,
      videoUrl: pending.video.url,
      coverUrl: pending.imageUrls[0],
      caption: pending.caption,
    });
    if (!result.ok) {
      if (result.uncertain !== true) {
        try {
          await releaseSocialPublishReservation({
            platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt,
          });
        } catch (error) {
          console.warn(`⚠️ Instagram Reel reservation remains held after definite API rejection: ${error.message}`);
        }
      }
      console.log(`⚠️  Instagram Reel ${pending.id} outcome Graph API non certo: ${result.reason}`);
      return result.uncertain === true ? 'api-uncertain' : 'api-failed';
    }
    const ts = new Date().toISOString();
    appendLedger(LEDGER_PATH, pending.ledgerEntries.map((entry) => ({
      ...entry,
      ts,
      queueId: pending.id,
      instagramMediaId: result.mediaId,
      instagramStoryImageUrl: pending.imageUrls[0],
      instagramVideoUrl: pending.video.url,
    })), POSTED_TRIM_LIMIT);
    try {
      await markSocialPublishReservationPublished({
        platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt, publishedAt: ts,
      });
    } catch (error) {
      console.warn(`⚠️ Instagram Reel reservation remains held after accepted post: ${error.message}`);
    }
    dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind: 'reel', queueId: pending.id });
    console.log(`✅ Instagram Reel legacy pubblicato via Graph API — ${result.mediaId}`);
    return 'published-legacy-queue';
  }
  const recent = recentInstagramReel(ledger);
  if (recent) {
    const creativeId = recent.creativeId || 'creative non specificata';
    console.log(`ℹ️  Instagram Reel recente: ${recent.queueId || recent.id || 'voce senza id'} (${creativeId}) — attendere 72 ore prima della prossima coorte`);
    return 'skipped';
  }

  const rows = await fetchGa4PageReport(day);
  if (!rows) {
    console.log(`ℹ️  ${kind}: no GA4 data available — skipping Reel`);
    return 'skipped';
  }

  const jobSections = kind === 'job' ? loadJobSections() : undefined;
  const jobIndex = kind === 'job' ? loadJobIndex() : new Map();
  if (kind === 'job' && jobIndex.size === 0) {
    console.log('ℹ️  jobs dataset unavailable — skipping Reel');
    return 'skipped';
  }

  const { articles, jobs } = rankCandidates(rows, {
    jobSections,
    isJobSlug: kind === 'job' ? (slug) => jobIndex.has(slug) : undefined,
  });
  const candidates = kind === 'job' ? jobs : articles;
  const { picks } = pickTopNUnposted(candidates, recentReelSources(ledger, kind), 1);
  const pick = picks[0];
  if (!pick) {
    console.log(`ℹ️  ${kind}: no unposted Reel candidate for ${day} — skipping`);
    return 'skipped';
  }

  const creative = chooseInstagramReelCreative({ kind });
  const item = buildItem(kind, pick, jobIndex);
  const socialCopy = await selectSocialCopyForPublish({
    pack: SOCIAL_COPY_PACK,
    channel: 'instagram',
    kind,
    format: 'reel',
    expectedObjective: creative.objective,
    assignmentKey: kind + ':' + day,
    blockContext: buildSocialCopyBlockContext({ sourceClass: kind, scheduledDate: day }),
    allowExperimentExposure: true,
    dryRun,
  });
  let reservedCopy = socialCopy;
  let deliveryStarted = false;
  let publishRejected = false;
  try {
  const content = buildInstagramReelContent({ kind, dayLabel: formatDayIt(day), item, creative, socialCopy });
  if (!content.productionKit.valid) {
    console.log('⚠️  Instagram Reel source text or metric does not fit the verified renderer contract — skipping');
    return 'content-invalid';
  }
  console.log(`\n─── Instagram Reel (${kind}, ${creative.id}) ───`);
  console.log(content.caption);
  console.log('───');
  if (dryRun) return 'dry-run';

  if (!route.api) {
    console.log('⚠️  Instagram Reel non pubblicabile: INSTAGRAM_ACCESS_TOKEN o INSTAGRAM_BUSINESS_ACCOUNT_ID mancante');
    return 'credentials-missing';
  }

  const slides = await renderReelSlides(content.productionKit.renderInput);
  if (!slides) {
    console.log('❌ Reel fonts unavailable — the scheduled Reel could not be rendered');
    return 'render-failed';
  }

  const keyPrefix = `reel-${kind}-${day}-${creative.id}`;
  const coverUrls = uploadCarouselSlides([slides[0]], { channel: 'instagram', keyPrefix });
  if (coverUrls.some((url) => !url)) {
    console.log('❌ Reel cover failed to reach the CDN');
    return 'cover-upload-failed';
  }

  let rendered;
  try {
    const { wav, seconds } = await synthesizeAnswerVoice(content.productionKit.voiceScript);
    const spokenCards = content.productionKit.subtitles.map((text) => ({ text }));
    const durations = planAnswerTimeline(spokenCards, seconds);
    rendered = renderAnswerVideo(slides, durations, wav);
  } catch (err) {
    console.log(`❌ Reel narration or MP4 unavailable: ${err.message}`);
    return 'voice-render-failed';
  }
  const videoUrl = uploadCarouselVideo(rendered.buffer, { channel: 'instagram', keyPrefix });
  if (!videoUrl) {
    console.log('❌ Reel MP4 failed to reach the CDN');
    return 'video-upload-failed';
  }

  const sourceId = sourceIdFor({ kind, slug: pick.slug });
  const ledgerEntries = [{
    id: `${kind}:${sourceId}`,
    kind: 'reel',
    sourceKind: kind,
    sourceId,
    url: instagramUrl(
      sourceUrlFor(pick),
      INSTAGRAM_CAMPAIGN_REEL,
      socialCopyTrackingContent(`${creative.id}-${pick.slug}`, socialCopy),
    ),
    day,
    views: pick.views,
    ...instagramReelLedgerFields(creative),
    ...socialCopyLedgerFields(socialCopy, { fallbackHook: creative.lead, fallbackCta: creative.cta }),
  }];
  const video = {
    url: videoUrl,
    bytes: rendered.bytes,
    sha256: rendered.sha256,
    durationMs: rendered.durationMs,
    width: rendered.width,
    height: rendered.height,
  };

  const queueEntry = buildQueueEntry({
    channel: 'instagram',
    kind: 'reel',
    day,
    caption: content.caption,
    imageUrls: coverUrls,
    video,
    ledgerEntries,
  });
  const publishAt = new Date();
  const reservationKey = socialPublishReservationKey('instagram', 'post', queueEntry.id);
  const reservation = await reserveSocialPublishBatch({
    platform: 'instagram',
    accountId: igUserId,
    repoRoot: ROOT,
    reservations: [{
      key: reservationKey,
      publishAt,
      nativeContentFingerprint: socialPublishContentFingerprint('instagram', { caption: queueEntry.caption }),
    }],
    now: publishAt,
  });
  if (!reservation[0]?.allowed) {
    console.log(`🛑 Instagram Reel ${queueEntry.id} held by shared daily cap (${reservation[0]?.reason || 'reservation-denied'})`);
    return 'cap-held';
  }
  deliveryStarted = true;
  const result = await publishInstagramReel({
    igUserId,
    accessToken,
    videoUrl: queueEntry.video.url,
    coverUrl: queueEntry.imageUrls[0],
    caption: queueEntry.caption,
  });
  publishRejected = result?.ok === false && result?.uncertain !== true;
  if (!result?.ok) {
    if (publishRejected) {
      try {
        await releaseSocialPublishReservation({
          platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt,
        });
      } catch (error) {
        console.warn(`⚠️ Instagram Reel reservation remains held after explicit API rejection: ${error.message}`);
      }
    }
    console.log(`⚠️  Instagram Reel outcome Graph API non certo: ${result?.reason || 'errore senza dettaglio'}`);
    return result?.uncertain === true ? 'api-uncertain' : 'api-failed';
  }

  reservedCopy = null;
  const ts = new Date().toISOString();
  appendLedger(LEDGER_PATH, ledgerEntries.map((entry) => ({
    ...entry,
    ts,
    queueId: queueEntry.id,
    instagramMediaId: result.mediaId,
    instagramStoryImageUrl: coverUrls[0],
    instagramVideoUrl: videoUrl,
  })), POSTED_TRIM_LIMIT);
  try {
    await markSocialPublishReservationPublished({
      platform: 'instagram', accountId: igUserId, key: reservationKey, publishAt, publishedAt: ts,
    });
  } catch (error) {
    console.warn(`⚠️ Instagram Reel reservation remains held after accepted post: ${error.message}`);
  }
  dequeuePosts(QUEUE_PATH, { channel: 'instagram', kind: 'reel' });
  try {
    await markSocialCopyAssignmentPublished(socialCopy, { postId: result.mediaId, publishedAt: ts });
  } catch (error) {
    console.warn('⚠️  accepted Instagram Reel could not close its copy assignment:', error.message);
  }
  console.log(`✅ Instagram Reel published via Graph API — ${result.mediaId} (${creative.id})`);
  return 'published';
  } finally {
    if (deliveryStarted && !publishRejected) reservedCopy = null;
    await releaseUnpublishedSocialCopyAssignmentBestEffort(reservedCopy, {
      reason: 'Instagram Reel skipped before API acceptance',
      onFailure: (error) => console.warn('⚠️', `could not release social-copy reservation for Instagram Reel: ${error.message}`),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('npx tsx scripts/post-to-instagram-reel.mjs [--dry-run] [--kind=article|job] [--date=YYYY-MM-DD]');
    return 0;
  }
  const robotMode = resolveSocialRobotMode();
  console.log(`─── Instagram Reel experiment — day ${args.day}${args.dryRun ? ' (dry run)' : ''} ───`);
  console.log(`ℹ️  SOCIAL_ROBOT_MODE=${robotMode}`);
  const status = await publishReelSlot({ ...args, robotMode });
  const failedStatuses = new Set([
    'credentials-missing',
    'invalid-legacy-queue-entry',
    'api-failed',
    'api-uncertain',
    'content-invalid',
    'render-failed',
    'voice-render-failed',
    'cover-upload-failed',
    'video-render-failed',
    'video-upload-failed',
  ]);
  return failedStatuses.has(status) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`❌ Instagram Reel experiment: ${err.message}`);
    process.exit(1);
  });
