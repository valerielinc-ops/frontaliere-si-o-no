#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

import {
  buildSocialGrowthScorecard,
  createWeeklySocialHealthSnapshot,
  renderSocialGrowthScorecard,
} from './lib/social-growth-scorecard.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import {
  loadPrivateSocialNativeInsights,
  updatePrivateSocialNativeInsights,
} from './lib/social-native-insights-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICATION_LEDGER_PATHS = Object.freeze({
  instagram: path.join(REPO_ROOT, 'data', 'instagram-posted.json'),
  tiktok: path.join(REPO_ROOT, 'data', 'tiktok-posted.json'),
  linkedinMember: path.join(REPO_ROOT, 'data', 'linkedin-member-posted.json'),
  facebookJobs: path.join(REPO_ROOT, 'data', 'fb-posted-jobs.json'),
  facebookArticles: path.join(REPO_ROOT, 'data', 'fb-posted-articles.json'),
  facebookEvents: path.join(REPO_ROOT, 'data', 'fb-posted-events.json'),
  telegramJobs: path.join(REPO_ROOT, 'data', 'telegram-posted-jobs.json'),
  telegramAnnouncements: path.join(REPO_ROOT, 'data', 'telegram-posted-announcements.json'),
});

function readPublicationLedger(filePath) {
  if (!existsSync(filePath)) return { status: 'ledger-missing', posts: [] };
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    if (Array.isArray(value)) return { status: 'available', posts: value };
    if (Array.isArray(value?.posted)) return { status: 'available', posts: value.posted };
    if (Array.isArray(value?.posts)) return { status: 'available', posts: value.posts };
    return { status: 'ledger-invalid', posts: [] };
  } catch {
    return { status: 'ledger-invalid', posts: [] };
  }
}

export function loadSocialPublicationLedgers(paths = PUBLICATION_LEDGER_PATHS) {
  const loaded = Object.fromEntries(Object.entries(paths).map(([channel, filePath]) => [
    channel,
    readPublicationLedger(filePath),
  ]));
  const combine = (keys) => {
    const ledgers = keys.map((key) => loaded[key] || { status: 'ledger-not-provided', posts: [] });
    const status = ledgers.some((ledger) => ledger.status === 'ledger-invalid') ? 'ledger-invalid'
      : ledgers.some((ledger) => ledger.status !== 'available') ? 'ledger-partial'
        : 'available';
    return {
      status,
      posts: status === 'available'
        ? keys.flatMap((key) => loaded[key].posts
          .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
          .map((row) => ({ ...row, ledgerSource: key })))
        : [],
    };
  };
  return {
    instagram: loaded.instagram,
    tiktok: loaded.tiktok,
    linkedinMember: loaded.linkedinMember,
    facebook: combine(['facebookJobs', 'facebookArticles', 'facebookEvents']),
    telegram: combine(['telegramJobs', 'telegramAnnouncements']),
  };
}

function parseArgs(argv) {
  const options = { json: false, summary: false, persistHealth: false, asOf: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--summary') options.summary = true;
    else if (arg === '--persist-health') options.persistHealth = true;
    else if (arg === '--as-of') options.asOf = new Date(argv[++index]);
    else if (arg.startsWith('--as-of=')) options.asOf = new Date(arg.slice('--as-of='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.asOf.getTime())) throw new Error('--as-of must be a valid date');
  return options;
}

export async function createScorecard(asOf, {
  loadNativeInsights = async () => loadPrivateSocialNativeInsights(await getFirestoreDb()),
  env = process.env,
} = {}) {
  const nativeInsights = await loadNativeInsights();
  const privatePosts = Array.isArray(nativeInsights?.posts) ? nativeInsights.posts : [];
  const tiktokDisplayAnalyticsApproved = env.TIKTOK_DISPLAY_ANALYTICS_APPROVED === 'true';
  const privateAudienceSnapshots = Array.isArray(nativeInsights?.audienceSnapshots) ? nativeInsights.audienceSnapshots : [];
  const visibleAudienceSnapshots = tiktokDisplayAnalyticsApproved
    ? privateAudienceSnapshots
    : privateAudienceSnapshots.filter((row) => row?.channel !== 'tiktok');
  const visibleAudienceBaselines = { ...(nativeInsights?.audienceBaselines || {}) };
  if (!tiktokDisplayAnalyticsApproved) delete visibleAudienceBaselines.tiktok;
  const visibleAudienceGrowthCycles = { ...(nativeInsights?.audienceGrowthCycles || {}) };
  if (!tiktokDisplayAnalyticsApproved) delete visibleAudienceGrowthCycles.tiktok;
  const privateSiteOutcomeSnapshots = Array.isArray(nativeInsights?.siteOutcomeSnapshots) ? nativeInsights.siteOutcomeSnapshots : [];
  const visibleSiteOutcomeSnapshots = tiktokDisplayAnalyticsApproved
    ? privateSiteOutcomeSnapshots
    : privateSiteOutcomeSnapshots.filter((row) => row?.channel !== 'tiktok');
  const visibleSiteOutcomeBaselines = (Array.isArray(nativeInsights?.siteOutcomeBaselines) ? nativeInsights.siteOutcomeBaselines : [])
    .filter((row) => tiktokDisplayAnalyticsApproved || row?.channel !== 'tiktok');
  return buildSocialGrowthScorecard({
    instagramInsights: {
      posts: privatePosts.filter((row) => row.channel === 'instagram')
        .map((row) => ({ ...row, mediaId: row.postId, ...row.metrics })),
    },
    nativeInsights: {
      ...nativeInsights,
      audienceSnapshots: visibleAudienceSnapshots,
      audienceBaselines: visibleAudienceBaselines,
      audienceGrowthCycles: visibleAudienceGrowthCycles,
      siteOutcomeSnapshots: visibleSiteOutcomeSnapshots,
      siteOutcomeBaselines: visibleSiteOutcomeBaselines,
      posts: privatePosts.filter((row) => row.channel !== 'instagram'
        && (row.channel !== 'tiktok' || tiktokDisplayAnalyticsApproved)),
    },
    publicationLedgers: loadSocialPublicationLedgers(),
    audienceSnapshots: visibleAudienceSnapshots,
    sources: {
      ...nativeInsights?.sources,
      tiktok: tiktokDisplayAnalyticsApproved
        ? (nativeInsights?.sources?.tiktok || { status: 'not-collected-yet' })
        : { status: 'policy-review-required' },
      tiktokAudience: tiktokDisplayAnalyticsApproved
        ? (nativeInsights?.sources?.tiktokAudience || { status: 'not-collected-yet' })
        : { status: 'policy-review-required' },
      telegram: nativeInsights?.sources?.telegram || { status: 'member-count-only-no-post-metrics-in-bot-api' },
    },
    asOf,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scorecard = await createScorecard(options.asOf);
  let healthSnapshot = null;
  let healthDeduplicated = false;
  if (options.persistHealth) {
    const db = await getFirestoreDb();
    const current = await loadPrivateSocialNativeInsights(db, { asOf: options.asOf });
    const result = createWeeklySocialHealthSnapshot(scorecard, current.weeklyHealth, options.asOf);
    healthSnapshot = result.snapshot;
    healthDeduplicated = result.deduplicated;
    if (!healthDeduplicated) {
      await updatePrivateSocialNativeInsights(db, (latest) => {
        const merge = createWeeklySocialHealthSnapshot(scorecard, latest.weeklyHealth, options.asOf);
        healthSnapshot = merge.snapshot;
        healthDeduplicated = merge.deduplicated;
        return { ...latest, weeklyHealth: merge.snapshot };
      }, { updatedAt: options.asOf });
    }
  }
  const healthMarkdown = healthSnapshot
    ? [
      '',
      '## Health signals deduplicati',
      '',
      `Settimana UTC: ${healthSnapshot.weekStart}; ${healthDeduplicated ? 'snapshot già registrato' : 'snapshot registrato nel Firestore privato'}.`,
      '',
      ...(healthSnapshot.signals.length
        ? healthSnapshot.signals.map((signal) => `- ${signal.source}: ${signal.status} (settimane: ${signal.occurrenceWeeks}; dal ${signal.firstSeenAt}).`)
        : ['Nessuna fonte stale o parziale rilevata.']),
      '',
    ].join('\n')
    : '';
  const markdown = `${renderSocialGrowthScorecard(scorecard)}${healthMarkdown}`;
  if (options.summary && process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
  }
  process.stdout.write(options.json ? `${JSON.stringify(scorecard)}\n` : markdown);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`social-growth-scorecard: ${String(error?.message || error).slice(0, 180)}`);
    process.exitCode = 1;
  });
}
