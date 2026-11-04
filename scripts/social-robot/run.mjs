#!/usr/bin/env node
/**
 * run.mjs — the Mac-host social worker. Instagram browser publishing and
 * browser Insights are held; eligible Instagram community work uses Graph API.
 * TikTok delivery is held by the current platform policy guard.
 *
 *   node scripts/social-robot/run.mjs                    # dry run (default)
 *   node scripts/social-robot/run.mjs --publish          # eligible Graph community actions, if RC says live
 *   node scripts/social-robot/run.mjs --platform=tiktok  # policy-held, no upload
 *   node scripts/social-robot/run.mjs --login            # only opens a browser for an allowed browser channel
 *
 * Instagram feed delivery and Insights never use Chrome. Business Suite Inbox
 * is not used; eligible community actions and static Stories use Graph API.
 * TikTok's current
 * Content Sharing Guidelines make this internal team uploader ineligible, so
 * the browser robot skips TikTok even when a pending queue exists.
 *
 * Browser publishing is policy-held. Instagram feed/Reels use their scheduled
 * Graph publishers; this worker runs permitted Graph community actions and
 * reconciles historical queue confirmations. It stores its delivery heartbeat
 * and community outcomes in private Firestore.
 *
 * Effective mode = the command line AND Remote Config: --publish enables
 * permitted Graph community actions only when SOCIAL_ROBOT_MODE is `live`;
 * `off` stops them; absent or `dry` previews without a browser or publish.
 *
 * Env:
 *   SOCIAL_ROBOT_MODE          off | dry | live (Remote Config; launchd.sh loads it)
 *   SOCIAL_ROBOT_SITE_REPO     the site checkout whose origin/main holds the queue
 *                              (default: the repository this file is in)
 *   SOCIAL_ROBOT_STATE_DIR     profile, journal, diagnostics
 *                              (default: ~/Library/Application Support/frontaliere/social-robot)
 *   SOCIAL_ROBOT_BROWSER_PATH  browser binary (default: Google Chrome, else cached Chromium)
 *   SOCIAL_ROBOT_INSIGHTS_SOURCE graph | off (legacy `browser` resolves to Graph)
 *                              native Insights are collected by the Graph workflow
 *   INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID
 *                              Graph community credentials, loaded from RC
 *   FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN
 *                              optional Conversations API credentials
 *   TRUSTED_GH_BIN / PATH      `gh` = the workspace coordinator shim
 *
 * Install the twice-a-day launchd job: bash scripts/social-robot/launchd.sh install
 */
import { realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { resolveInstagramCommunityMode, runInstagramCommunityAutomation } from '../lib/instagram-community-automation.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { mergeInstagramCommunityOutcomeSnapshots } from '../lib/instagram-community-outcomes.mjs';
import { buildSocialRobotDeliverySnapshot } from '../lib/social-robot-delivery-health.mjs';
import { SOCIAL_CHANNELS, resolveSocialRobotMode } from '../lib/social-publish-queue.mjs';
import { partitionAutomatedDeliveryChannels } from '../lib/social-automation-policy.mjs';
import {
  mergePrivateInstagramStoryState,
  updatePrivateSocialNativeInsights,
} from '../lib/social-native-insights-store.mjs';
import { acquireLock, defaultStateDir, diagnosticsDir, downloadsDir, openProfile, pruneRobotState, resolveBrowserLaunch } from './lib/browser.mjs';
import { START_JITTER_MAX_MS, fileJournalStore, randomBetween } from './lib/cadence.mjs';
import { DEFAULT_TIKTOK_USERNAME, FLOWS, INSTAGRAM_HOME, captureDiagnostics, classifyError, findTikTokPublishedPost, resolveTikTokMusicVariant, stepTracker } from './lib/flows.mjs';
import { SITE_REPO, downloadEntryFiles, ghConfirmDispatcher, gitMainReader, runRobot } from './lib/robot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opts = { mode: 'dry-run', platforms: [...SOCIAL_CHANNELS], login: false, jitter: false, help: false };
  for (const arg of argv) {
    if (arg === '--publish') opts.mode = 'publish';
    else if (arg === '--dry-run') opts.mode = 'dry-run';
    else if (arg === '--login') opts.login = true;
    else if (arg === '--jitter') opts.jitter = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--platform=')) {
      const value = arg.slice('--platform='.length);
      opts.platforms = value === 'all' ? [...SOCIAL_CHANNELS] : value.split(',');
      for (const p of opts.platforms) if (!SOCIAL_CHANNELS.includes(p)) throw new Error(`unknown platform: ${p}`);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const stamp = (at) => new Date(at).toISOString().replace(/[:.]/g, '-');

export function runHasErrors({ results = [], confirmationRetries = [], community = null, insights = null, deliveryTelemetry = null } = {}) {
  return (Array.isArray(results) && results.some((r) => r.outcome === 'error' || r.outcome === 'unconfirmed'))
    || (Array.isArray(confirmationRetries) && confirmationRetries.some((retry) => retry.confirmDispatched !== true))
    || deliveryTelemetry?.status === 'write-failed'
    || community?.status === 'api-error'
    || community?.status === 'partial'
    || community?.status === 'credentials-missing'
    || community?.status === 'capability-unavailable'
    || community?.status === 'login-required'
    || community?.status === 'browser-unavailable'
    || community?.outcomesPersisted === false
    || insights?.status === 'api-error'
    || insights?.status === 'login-required'
    || insights?.status === 'page-error';
}

export function filterAutomatedDeliveryPlatforms(platforms) {
  return partitionAutomatedDeliveryChannels(platforms);
}

async function login({ stateDir, platforms }) {
  const delivery = filterAutomatedDeliveryPlatforms(platforms);
  for (const held of delivery.held) console.warn(`⏸️  ${held.channel}: ${held.reason}`);
  if (delivery.allowed.length === 0) return;
  const context = await openProfile({ stateDir });
  for (const p of delivery.allowed) {
    const page = await context.newPage();
    await page.goto(INSTAGRAM_HOME).catch(() => {});
  }
  console.log('🔑 Log in on every tab, then close the browser window. Nothing is read or saved but the profile itself.');
  await new Promise((resolve) => context.on('close', resolve));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readUsage());
    return 0;
  }
  const stateDir = defaultStateDir();
  const release = acquireLock(stateDir);
  if (!release) {
    console.log('ℹ️  another robot run holds the profile — skipping');
    return 0;
  }
  try {
    if (opts.login) {
      await login({ stateDir, platforms: opts.platforms });
      return 0;
    }
    const requestedPlatforms = [...opts.platforms];
    const delivery = filterAutomatedDeliveryPlatforms(requestedPlatforms);
    opts.platforms = delivery.allowed;
    for (const held of delivery.held) {
      console.warn(`⏸️  ${held.channel}: ${held.reason}`);
    }
    const stateCleanup = pruneRobotState(stateDir);
    if (stateCleanup.errors.length) {
      throw new Error('social robot state cleanup failed: ' + stateCleanup.errors.join('; '));
    }
    const rcMode = resolveSocialRobotMode();
    const launch = delivery.allowed.length ? resolveBrowserLaunch() : null;
    console.log(`─── social robot — ${opts.mode}, SOCIAL_ROBOT_MODE=${rcMode}, browser ${launch?.kind || 'disabled by delivery policy'} ───`);
    if (opts.jitter) await new Promise((r) => setTimeout(r, randomBetween(Math.random, { min: 0, max: START_JITTER_MAX_MS })));

    const repoDir = process.env.SOCIAL_ROBOT_SITE_REPO || path.resolve(__dirname, '..', '..');
    const reader = gitMainReader({ repoDir });
    let context = null;
    const page = async () => {
      context ||= await openProfile({ stateDir, launch });
      return context.pages()[0] || context.newPage();
    };
    try {
      const robotStartedAt = new Date();
      const robotResult = await runRobot({
        cliMode: opts.mode,
        rcMode,
        platforms: opts.platforms,
        confirmationPlatforms: requestedPlatforms,
        reader,
        socialPublishAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
        socialPublishRepoRoot: repoDir,
        journalStore: fileJournalStore(stateDir),
        fetchImages: (entry) => downloadEntryFiles(entry, path.join(downloadsDir(stateDir), entry.channel, entry.id)),
        cleanupFiles: ({ entry }) => {
          const directory = path.join(downloadsDir(stateDir), entry.channel, entry.id);
          rmSync(directory, { recursive: true, force: true });
        },
        // --jitter marks the unattended launchd run: there a queue entry gets
        // one dry run, not one per window; by hand every --dry-run runs.
        repeatDryRun: !opts.jitter,
        diagnosticsFor: (channel, entry, at) => path.join(diagnosticsDir(stateDir), `${stamp(at)}-${channel}-${entry?.id || 'none'}`),
        publishWith: async (channel, entry, files, { dryRun, human, diagnosticsDir: dir }) => {
          const p = await page();
          const step = stepTracker();
          const snap = (label) => captureDiagnostics(p, dir, label, { channel, queueId: entry.id, step: step.get() });
          try {
            return await FLOWS[channel]({
              page: p,
              files,
              caption: entry.caption,
              video: entry.video,
              dryRun,
              human,
              snap,
              step,
              musicVariant: channel === 'tiktok' ? resolveTikTokMusicVariant({ queueId: entry.id }) : undefined,
              targetUsername: channel === 'tiktok' ? (process.env.TIKTOK_USERNAME || DEFAULT_TIKTOK_USERNAME) : undefined,
            });
          } catch (err) {
            const e = classifyError(err);
            e.step ||= step.get();
            await captureDiagnostics(p, dir, 'error', { channel, queueId: entry.id, step: e.step, errorClass: e.errorClass, message: e.message });
            throw e;
          }
        },
        findPublishedPost: async (channel, attempt) => {
          if (channel !== 'tiktok') return null;
          return findTikTokPublishedPost({ page: await page(), caption: attempt.caption });
        },
        dispatchConfirm: ghConfirmDispatcher({ ghBin: process.env.TRUSTED_GH_BIN || 'gh' }),
        reportIssue: ({ title, description, labels }) => {
          process.env.GH_REPO ||= SITE_REPO;
          return createGithubIssue({ title, description, priority: 2, labels, workflow: 'social-robot (Mac host)' });
        },
        resolveIssue: ({ title }) => {
          process.env.GH_REPO ||= SITE_REPO;
          return resolveGithubIssue(title, { workflow: 'social-robot (Mac host)', exactTitle: true });
        },
      });
      const { results, confirmationRetries } = robotResult;
      const deliverySnapshotAt = new Date();
      const deliveryQueues = {};
      const deliveryLedgers = {};
      const deliveryChannels = [
        ...delivery.allowed.map((channel) => ({ channel, state: 'eligible' })),
        ...delivery.held.map(({ channel }) => ({ channel, state: 'policy-held' })),
      ];
      for (const { channel } of deliveryChannels) {
        try {
          deliveryQueues[channel] = reader.readQueue(channel);
        } catch {
          deliveryQueues[channel] = null;
        }
        try {
          deliveryLedgers[channel] = reader.readLedger(channel);
        } catch {
          deliveryLedgers[channel] = null;
        }
      }
      const deliverySnapshot = buildSocialRobotDeliverySnapshot({
        startedAt: robotStartedAt,
        recordedAt: deliverySnapshotAt,
        mode: rcMode,
        dryRun: robotResult.dryRun,
        channels: deliveryChannels,
        results,
        confirmationRetries,
        queues: deliveryQueues,
        ledgers: deliveryLedgers,
      });
      let deliveryTelemetry = { status: 'write-failed' };
      try {
        const db = await getFirestoreDb();
        await updatePrivateSocialNativeInsights(db, (current) => ({
          ...current,
          generatedAt: deliverySnapshot.recordedAt,
          sources: {
            ...current.sources,
            socialRobotDelivery: {
              ...(current.sources?.socialRobotDelivery || {}),
              status: deliverySnapshot.coverage === 'complete' ? 'available' : 'partial',
              lastAttemptAt: deliverySnapshot.recordedAt,
              latestSnapshotAt: deliverySnapshot.recordedAt,
              ...(deliverySnapshot.coverage === 'complete'
                ? { lastSuccessAt: deliverySnapshot.recordedAt }
                : {}),
            },
          },
          robotDelivery: deliverySnapshot,
        }), { updatedAt: deliverySnapshotAt });
        deliveryTelemetry = { status: 'persisted' };
      } catch (error) {
        console.warn(`⚠️  social robot delivery telemetry could not be persisted (${error.name || 'error'})`);
      }
      let community = null;
      let insights = null;
      if (requestedPlatforms.includes('instagram')) {
        const configuredCommunityMode = resolveInstagramCommunityMode({ ...process.env, SOCIAL_ROBOT_MODE: rcMode });
        const communityMode = opts.mode === 'publish' || configuredCommunityMode === 'off'
          ? configuredCommunityMode
          : 'dry';
        community = await runInstagramCommunityAutomation({
          accountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
          accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
          ledger: reader.readLedger('instagram'),
          statePath: path.join(stateDir, 'instagram-community-state.json'),
          reservationRepoRoot: repoDir,
          mode: communityMode,
          log: console,
        });
        const publishedStories = Array.isArray(community?.publishedStories) ? community.publishedStories : [];
        if (community?.outcomes || publishedStories.length > 0) {
          try {
            const db = await getFirestoreDb();
            const asOf = new Date();
            await updatePrivateSocialNativeInsights(db, (current) => ({
              ...current,
              ...(community?.outcomes ? {
                communityOutcomes: mergeInstagramCommunityOutcomeSnapshots(current.communityOutcomes, community.outcomes),
              } : {}),
              ...mergePrivateInstagramStoryState(current, {
                publicationAdditions: publishedStories,
                asOf,
              }),
            }), { updatedAt: asOf });
            community.outcomesPersisted = true;
            community.storyPublicationsPersisted = true;
          } catch (error) {
            community.outcomesPersisted = false;
            community.storyPublicationsPersisted = false;
            community.errors = [...(Array.isArray(community.errors) ? community.errors : []), `private outcome persistence failed: ${String(error?.message || error).replace(/access_token[=:][^\s&]+/giu, 'access_token=[REDACTED]').slice(0, 180)}`];
            if (!['api-error', 'partial', 'credentials-missing', 'login-required', 'browser-unavailable'].includes(community.status)) {
              community.status = 'partial';
            }
          }
        }
        if (community) {
          community.storyPublicationCount = publishedStories.length;
          delete community.publishedStories;
        }
        insights = { status: 'disabled', source: 'instagram-graph-native-collector' };
      }
      console.log(JSON.stringify({ results, community, insights, deliveryTelemetry }));
      return runHasErrors({ results, confirmationRetries, community, insights, deliveryTelemetry }) ? 1 : 0;
    } finally {
      if (context) await context.close().catch(() => {});
    }
  } finally {
    release();
  }
}

function readUsage() {
  return [
    'node scripts/social-robot/run.mjs [--dry-run | --publish] [--platform=instagram|tiktok|all] [--jitter]',
    'node scripts/social-robot/run.mjs --login [--platform=...]',
    '',
    '--publish enables eligible Graph community actions only when Remote Config SOCIAL_ROBOT_MODE=live. Instagram browser delivery stays held.',
    '--jitter (the launchd job) waits up to 20 minutes before its scheduled Graph community pass.',
  ].join('\n');
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ social robot: ${err.message}`);
      process.exit(1);
    });
}
