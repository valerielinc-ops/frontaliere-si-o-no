#!/usr/bin/env node
/**
 * Queue one controlled Instagram Reel experiment.
 *
 * This is intentionally separate from post-to-instagram.mjs: a Reel is a
 * different creative treatment, a different ledger cohort and a different
 * transport (the local browser robot). The workflow reserves two controlled
 * experiment slots per week without silently adding a third daily post.
 *
 * Usage:
 *   npx tsx scripts/post-to-instagram-reel.mjs --dry-run
 *   npx tsx scripts/post-to-instagram-reel.mjs --kind=article --date=2026-10-10
 *
 * The normal path queues the vertical MP4 when SOCIAL_ROBOT_MODE is `dry` or
 * `live`. The robot uploads that MP4 through Instagram's Reel composer; the
 * regular Instagram Graph API carousel path is deliberately not reused here.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_URL,
  loadLedger,
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
import { renderCarouselVideo } from './lib/social-carousel-video.mjs';
import { uploadCarouselSlides, uploadCarouselVideo } from './lib/social-carousel-upload.mjs';
import {
  buildQueueEntry,
  deliverSocialPost,
  enqueuePost,
  loadQueue,
  queuePathFor,
  resolveSocialRobotMode,
  socialPublishRoute,
} from './lib/social-publish-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'instagram-posted.json');
const QUEUE_PATH = queuePathFor(ROOT, 'instagram');
const DEDUP_WINDOW_DAYS = 30;

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
    title: job ? [job.title, job.company].filter(Boolean).join(' — ') : pick.title || pick.slug.replace(/-/g, ' '),
    views: pick.views,
    slug: pick.slug,
    path: pick.path,
  };
}

async function queueReel({ kind, day, dryRun, robotMode }) {
  const ledger = loadLedger(LEDGER_PATH);
  const pending = pendingInstagramReel(loadQueue(QUEUE_PATH));
  if (pending) {
    const creativeId = pending.ledgerEntries?.[0]?.creativeId || 'creative non specificata';
    console.log(`ℹ️  Instagram Reel già in coda: ${pending.id} (${creativeId}) — preservato fino a pubblicazione o scadenza`);
    return 'skipped';
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

  const creative = chooseInstagramReelCreative({ kind, day });
  const item = buildItem(kind, pick, jobIndex);
  const content = buildInstagramReelContent({ kind, dayLabel: formatDayIt(day), item, creative });
  console.log(`\n─── Instagram Reel (${kind}, ${creative.id}) ───`);
  console.log(content.caption);
  console.log('───');
  if (dryRun) return 'dry-run';

  const route = socialPublishRoute({ mode: robotMode, apiReady: false });
  if (!route.render) {
    console.log('ℹ️  SOCIAL_ROBOT_MODE=off — Reel not queued');
    return 'skipped';
  }

  const slides = await renderReelSlides({ slides: content.slides });
  if (!slides) {
    console.log('⚠️  Reel fonts unavailable — skipping (soft)');
    return 'skipped';
  }

  const keyPrefix = `reel-${kind}-${day}-${creative.id}`;
  const coverUrls = uploadCarouselSlides([slides[0]], { channel: 'instagram', keyPrefix });
  if (coverUrls.some((url) => !url)) {
    console.log('⚠️  Reel cover failed to reach the CDN — skipping');
    return 'skipped';
  }

  let rendered;
  try {
    rendered = renderCarouselVideo(slides);
  } catch (err) {
    console.log(`⚠️  Reel MP4 unavailable: ${err.message}`);
    return 'skipped';
  }
  const videoUrl = uploadCarouselVideo(rendered.buffer, { channel: 'instagram', keyPrefix });
  if (!videoUrl) {
    console.log('⚠️  Reel MP4 failed to reach the CDN — skipping');
    return 'skipped';
  }

  const sourceId = sourceIdFor({ kind, slug: pick.slug });
  const ledgerEntries = [{
    id: `${kind}:${sourceId}`,
    kind: 'reel',
    sourceKind: kind,
    sourceId,
    url: instagramUrl(sourceUrlFor(pick), INSTAGRAM_CAMPAIGN_REEL, `${creative.id}-${pick.slug}`),
    day,
    views: pick.views,
    ...instagramReelLedgerFields(creative),
  }];
  const video = {
    url: videoUrl,
    bytes: rendered.bytes,
    sha256: rendered.sha256,
    durationMs: rendered.durationMs,
    width: rendered.width,
    height: rendered.height,
  };

  await deliverSocialPost({
    route,
    label: 'Instagram Reel',
    publish: async () => ({ ok: false, reason: 'Instagram Reel API path is intentionally disabled for this browser experiment' }),
    recordPublished: () => {},
    enqueue: () => enqueuePost(
      QUEUE_PATH,
      buildQueueEntry({
        channel: 'instagram',
        kind: 'reel',
        day,
        caption: content.caption,
        imageUrls: coverUrls,
        video,
        ledgerEntries,
      }),
    ),
    dequeue: () => {},
  });
  console.log(`🗂️  Instagram Reel queued: reel-${day} (${creative.id})`);
  return 'queued';
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
  await queueReel({ ...args, robotMode });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`❌ Instagram Reel experiment: ${err.message}`);
    process.exit(1);
  });
