#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { collectFacebookAudienceSnapshot } from './lib/facebook-audience-insights.mjs';
import { collectFacebookPostInsights } from './lib/facebook-post-insights.mjs';
import { collectInstagramAudienceSnapshot } from './lib/instagram-audience-insights.mjs';
import { collectSnapshots as collectInstagramPostInsights } from './lib/instagram-insights-snapshot.mjs';
import { getLinkedInMemberAccessToken } from './lib/linkedin-member-access-token.mjs';
import {
  collectLinkedInMemberAudienceSnapshot,
  collectLinkedInMemberFollowerGains,
} from './lib/linkedin-member-audience-insights.mjs';
import {
  collectLinkedInMemberInsights,
  LINKEDIN_MEMBER_ANALYTICS_SCOPE,
  LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV,
} from './lib/linkedin-member-insights.mjs';
import {
  advanceAudienceGrowthCycles,
  freezeEligibleAudienceBaselines,
} from './lib/social-growth-scorecard.mjs';
import {
  loadPrivateSocialNativeInsights,
  mergePrivateSocialAudienceSnapshots,
  mergePrivateSocialFollowerGainSnapshots,
  normalizeInstagramPrivateSnapshots,
  toInstagramBrowserSnapshotDocument,
  updatePrivateSocialNativeInsights,
} from './lib/social-native-insights-store.mjs';
import { validateSocialNativeInsightsDocument } from './lib/social-native-insights-schema.mjs';
import { getTikTokAccessToken } from './lib/tiktok-access-token.mjs';
import { collectTikTokAudienceSnapshot } from './lib/tiktok-audience-insights.mjs';
import { collectTikTokNativeInsights } from './lib/tiktok-native-insights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_RETENTION_DAYS = 100;
const AUDIENCE_HISTORY_RETENTION_DAYS = 130;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON in ${path.relative(ROOT, file)}: ${String(error?.name || 'parse error')}`);
  }
}

function readLedger(name) {
  return readJson(path.join(ROOT, 'data', name), { posted: [] });
}

function readFacebookPublicationLedger() {
  return [
    ['fb-posted-jobs.json', 'facebookJobs'],
    ['fb-posted-articles.json', 'facebookArticles'],
    ['fb-posted-events.json', 'facebookEvents'],
  ].flatMap(([file, ledgerSource]) => {
    const ledger = readLedger(file);
    const rows = Array.isArray(ledger) ? ledger : Array.isArray(ledger?.posted) ? ledger.posted : [];
    return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map((row) => ({ ...row, ledgerSource }));
  });
}

function readJsonLines(name) {
  const file = path.join(ROOT, 'data', name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function utcDay(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function addUtcDays(day, amount) {
  const parsed = Date.parse(`${String(day || '')}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? new Date(parsed + amount * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
}

function hasAudienceSnapshotToday(snapshots, channel, metric, asOf) {
  const day = utcDay(asOf);
  return (Array.isArray(snapshots) ? snapshots : []).some((snapshot) => (
    snapshot?.channel === channel && snapshot?.metric === metric && utcDay(snapshot.snapshotAt) === day
  ));
}

function wasAudienceAttemptedToday(source, asOf) {
  return Boolean(source?.lastAttemptAt && utcDay(source.lastAttemptAt) === utcDay(asOf));
}

function audienceSourceUpdate(result, asOf, { attempted = true, existing = null } = {}) {
  const retryable = new Set(['credentials-missing', 'network-error', 'api-error', 'rate-limited']);
  const snapshotAt = result?.snapshot?.snapshotAt || result?.snapshotAt;
  const available = result?.status === 'available' && result?.snapshot;
  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    status: String(result?.status || 'unavailable'),
    lastCheckedAt: new Date(asOf).toISOString(),
    ...(attempted && !retryable.has(result?.status) ? { lastAttemptAt: new Date(asOf).toISOString() } : {}),
    ...(available ? { lastSuccessAt: new Date(snapshotAt || asOf).toISOString(), latestSnapshotAt: new Date(snapshotAt || asOf).toISOString() } : {}),
    ...(result?.reasonCode ? { reasonCode: result.reasonCode } : {}),
  };
  if (!result?.reasonCode) delete next.reasonCode;
  return next;
}

function followerGainSourceUpdate(result, asOf, { attempted = true, existing = null } = {}) {
  const retryable = new Set(['credentials-missing', 'network-error', 'api-error', 'rate-limited']);
  const snapshots = Array.isArray(result?.snapshots) ? result.snapshots : [];
  const latestSnapshotAt = latestTimestamp(snapshots.map((row) => row.snapshotAt));
  const successful = snapshots.length > 0 && ['available', 'partial'].includes(result?.status);
  const next = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    status: String(result?.status || 'unavailable'),
    lastCheckedAt: new Date(asOf).toISOString(),
    ...(attempted && !retryable.has(result?.status) ? { lastAttemptAt: new Date(asOf).toISOString() } : {}),
    ...(successful ? { lastSuccessAt: new Date(asOf).toISOString() } : {}),
    ...(latestSnapshotAt ? { latestSnapshotAt } : {}),
    ...(result?.reasonCode ? { reasonCode: String(result.reasonCode).slice(0, 80) } : {}),
  };
  if (!result?.reasonCode) delete next.reasonCode;
  return next;
}

function collectorSourceUpdate(existing, result, status, asOf, {
  attempted = true,
  successStatuses = new Set(),
  posts = [],
} = {}) {
  const latestSnapshotAt = latestTimestamp(posts.map((row) => row.snapshotAt));
  const successful = successStatuses.has(result?.status || status);
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    status,
    ...(attempted ? { lastAttemptAt: new Date(asOf).toISOString() } : {}),
    ...(successful ? { lastSuccessAt: new Date(asOf).toISOString() } : {}),
    ...(latestSnapshotAt ? { latestSnapshotAt } : {}),
    ...(result?.reasonCode ? { reasonCode: String(result.reasonCode).slice(0, 80) } : {}),
  };
}

function latestTimestamp(values) {
  return values.map((value) => ({ value, time: Date.parse(String(value || '')) }))
    .filter((row) => Number.isFinite(row.time))
    .sort((left, right) => right.time - left.time)[0]?.value || null;
}

function laterTimestamp(...values) {
  const candidates = values
    .map((value) => ({ value, time: Date.parse(String(value || '')) }))
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => b.time - a.time);
  return candidates[0]?.value;
}

function mergeSourceState(currentValue, incomingValue) {
  const current = typeof currentValue === 'string' ? { status: currentValue } : currentValue || {};
  const incoming = typeof incomingValue === 'string' ? { status: incomingValue } : incomingValue || {};
  const currentTime = laterTimestamp(current.lastCheckedAt, current.lastAttemptAt, current.lastSuccessAt);
  const incomingTime = laterTimestamp(incoming.lastCheckedAt, incoming.lastAttemptAt, incoming.lastSuccessAt);
  const incomingIsPolicyGate = incoming.status === 'policy-review-required';
  if (!incomingIsPolicyGate && currentTime && (!incomingTime || Date.parse(currentTime) >= Date.parse(incomingTime))) {
    return {
      ...current,
      ...Object.fromEntries(['lastAttemptAt', 'lastCheckedAt', 'lastSuccessAt', 'latestSnapshotAt']
        .map((field) => [field, laterTimestamp(current[field], incoming[field])])
        .filter(([, value]) => value)),
    };
  }
  const merged = { ...current, ...incoming };
  for (const field of ['lastAttemptAt', 'lastCheckedAt', 'lastSuccessAt', 'latestSnapshotAt']) {
    const value = laterTimestamp(current[field], incoming[field]);
    if (value) merged[field] = value;
    else delete merged[field];
  }
  return merged;
}

function telegramAudienceSnapshots(history, asOf) {
  const cutoff = new Date(asOf).getTime() - AUDIENCE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return history.flatMap((row) => {
    const date = String(row.date || '').trim();
    const value = Number(row.count);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isSafeInteger(value) || value < 0) return [];
    const snapshotAt = `${date}T12:00:00.000Z`;
    const time = Date.parse(snapshotAt);
    if (time < cutoff || time > new Date(asOf).getTime()) return [];
    return [{
      channel: 'telegram',
      metric: 'members',
      value,
      snapshotAt,
      status: 'available',
      source: 'telegram-bot-member-count',
    }];
  });
}

function parseArgs(argv) {
  const options = { dryRun: false, json: false, skipLinkedIn: false, asOf: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--skip-linkedin') options.skipLinkedIn = true;
    else if (arg === '--as-of') options.asOf = new Date(argv[++index]);
    else if (arg.startsWith('--as-of=')) options.asOf = new Date(arg.slice('--as-of='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.asOf.getTime())) throw new Error('--as-of must be a valid date');
  return options;
}

function snapshotKey(row) {
  return [row.channel, row.postId, row.windowHours || row.windowDays || 'unknown'].join('\u0000');
}

function mergeSnapshots(existing, additions, asOf, { pruneLinkedInMemberPosts = false } = {}) {
  const cutoff = asOf.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byKey = new Map();
  for (const row of [...(Array.isArray(existing?.posts) ? existing.posts : []), ...additions]) {
    if (pruneLinkedInMemberPosts && row.channel === 'linkedin-member') continue;
    const publishedAt = Date.parse(String(row.publishedAt || ''));
    if (!Number.isFinite(publishedAt) || publishedAt < cutoff || publishedAt > asOf.getTime()) continue;
    byKey.set(snapshotKey(row), row);
  }
  return [...byKey.values()].sort((left, right) => (
    String(left.publishedAt).localeCompare(String(right.publishedAt))
      || String(left.channel).localeCompare(String(right.channel))
      || String(left.postId).localeCompare(String(right.postId))
  ));
}

function normalizedSourceStatus(result, successfulStatuses) {
  return successfulStatuses.has(result?.status) ? 'available' : String(result?.status || 'unavailable');
}

function linkedinPostAnalyticsHold(snapshotAt) {
  return {
    status: 'policy-review-required',
    snapshotAt: new Date(snapshotAt).toISOString(),
    posts: [],
    skipped: [],
    scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE,
  };
}

export async function collectSocialNativeInsights({
  env = process.env,
  asOf = new Date(),
  existing = { schemaVersion: 1, posts: [], audienceSnapshots: [], followerGainSnapshots: [], sources: {} },
  fetchInstagram = fetch,
  fetchTikTok = fetch,
  fetchLinkedIn = fetch,
  sleepImpl,
  collectLinkedIn = true,
  getTikTokToken = getTikTokAccessToken,
  getLinkedInToken = getLinkedInMemberAccessToken,
  collectTikTok = collectTikTokNativeInsights,
  collectLinkedInInsights = collectLinkedInMemberInsights,
  collectLinkedInAudience = collectLinkedInMemberAudienceSnapshot,
  collectLinkedInFollowerGains = collectLinkedInMemberFollowerGains,
  collectInstagramAudience = collectInstagramAudienceSnapshot,
  collectInstagramPosts = collectInstagramPostInsights,
  collectFacebookAudience = collectFacebookAudienceSnapshot,
  collectFacebookPosts = collectFacebookPostInsights,
  collectTikTokAudience = collectTikTokAudienceSnapshot,
  fetchFacebook = fetch,
} = {}) {
  const tiktokLedger = readLedger('tiktok-posted.json');
  const linkedinLedger = readLedger('linkedin-member-posted.json');
  const tiktokDisplayAnalyticsApproved = env.TIKTOK_DISPLAY_ANALYTICS_APPROVED === 'true';
  const linkedinPostAnalyticsStorageApproved = env[LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV] === 'true';
  const telegramHistory = readJsonLines('telegram-member-count-history.jsonl');
  const telegramAudienceRows = telegramAudienceSnapshots(telegramHistory, asOf)
    .sort((left, right) => left.snapshotAt.localeCompare(right.snapshotAt));
  const currentAudience = Array.isArray(existing?.audienceSnapshots) ? existing.audienceSnapshots : [];
  const instagramAudienceDue = !hasAudienceSnapshotToday(currentAudience, 'instagram', 'followers', asOf)
    && !wasAudienceAttemptedToday(existing?.sources?.instagramAudience, asOf);
  const facebookAudienceDue = !hasAudienceSnapshotToday(currentAudience, 'facebook', 'followers', asOf)
    && !wasAudienceAttemptedToday(existing?.sources?.facebookAudience, asOf);
  const linkedinAudienceDue = collectLinkedIn
    && !hasAudienceSnapshotToday(currentAudience, 'linkedin-member', 'followers', asOf)
    && !wasAudienceAttemptedToday(existing?.sources?.linkedinAudience, asOf);
  const linkedinFollowerGainsDue = collectLinkedIn
    && !wasAudienceAttemptedToday(existing?.sources?.linkedinFollowerGains, asOf);
  const followerGainEndDate = utcDay(asOf);
  const followerGainStartDate = addUtcDays(followerGainEndDate, -30);
  const tiktokAudienceDue = tiktokDisplayAnalyticsApproved
    && !hasAudienceSnapshotToday(currentAudience, 'tiktok', 'followers', asOf)
    && !wasAudienceAttemptedToday(existing?.sources?.tiktokAudience, asOf);

  const collected = await Promise.allSettled([
    tiktokDisplayAnalyticsApproved
      ? (async () => {
        const accessToken = await getTikTokToken({ env, fetchImpl: fetchTikTok });
        if (!accessToken) {
          return {
            postResult: { status: 'credentials-missing', posts: [], skipped: [], unmatched: [] },
            audienceResult: tiktokAudienceDue ? { status: 'credentials-missing', snapshot: null } : { status: 'not-due-today', snapshot: null },
            audienceAttempted: false,
          };
        }
        const settled = await Promise.allSettled([
          collectTikTok({
            accessToken,
            ledger: tiktokLedger,
            existing,
            asOf,
            fetchImpl: fetchTikTok,
          }),
          tiktokAudienceDue
            ? collectTikTokAudience({ accessToken, asOf, fetchImpl: fetchTikTok })
            : Promise.resolve({ status: 'not-due-today', snapshot: null }),
        ]);
        return {
          postResult: settled[0].status === 'fulfilled'
            ? settled[0].value
            : { status: 'api-error', posts: [], skipped: [], unmatched: [], reasonCode: String(settled[0].reason?.name || 'network-error') },
          audienceResult: settled[1].status === 'fulfilled'
            ? settled[1].value
            : { status: 'api-error', snapshot: null, reasonCode: String(settled[1].reason?.name || 'network-error') },
          audienceAttempted: tiktokAudienceDue,
        };
      })()
      : Promise.resolve({
        postResult: { status: 'policy-review-required', posts: [], skipped: [], unmatched: [] },
        audienceResult: { status: 'policy-review-required', snapshot: null },
        audienceAttempted: false,
      }),
    collectLinkedIn
      ? (async () => {
        const accessToken = await getLinkedInToken({ env, fetchImpl: fetchLinkedIn });
        const postOptions = {
          accessToken,
          ledger: linkedinLedger,
          existing,
          asOf,
          retentionPolicyApproved: linkedinPostAnalyticsStorageApproved,
          ...(sleepImpl ? { sleepImpl } : {}),
          fetchImpl: fetchLinkedIn,
        };
        if (!accessToken) {
          const postResult = linkedinPostAnalyticsStorageApproved
            ? await collectLinkedInInsights(postOptions)
            : linkedinPostAnalyticsHold(asOf);
          return {
            ...postResult,
            audienceResult: linkedinAudienceDue
              ? { status: 'credentials-missing', snapshot: null }
              : { status: 'not-due-today', snapshot: null },
            followerGainResult: linkedinFollowerGainsDue
              ? { status: 'credentials-missing', snapshots: [] }
              : { status: 'not-due-today', snapshots: [] },
            audienceAttempted: false,
            followerGainsAttempted: false,
          };
        }
        const settled = await Promise.allSettled([
          linkedinPostAnalyticsStorageApproved
            ? collectLinkedInInsights(postOptions)
            : Promise.resolve(linkedinPostAnalyticsHold(asOf)),
          linkedinAudienceDue
            ? collectLinkedInAudience({ accessToken, asOf, fetchImpl: fetchLinkedIn })
            : Promise.resolve({ status: 'not-due-today', snapshot: null }),
          linkedinFollowerGainsDue
            ? collectLinkedInFollowerGains({
              accessToken,
              startDate: followerGainStartDate,
              endDate: followerGainEndDate,
              asOf,
              fetchImpl: fetchLinkedIn,
            })
            : Promise.resolve({ status: 'not-due-today', snapshots: [] }),
        ]);
        const postResult = settled[0].status === 'fulfilled'
          ? settled[0].value
          : { status: 'api-error', posts: [], skipped: [], reasonCode: String(settled[0].reason?.name || 'network-error') };
        const audienceResult = settled[1].status === 'fulfilled'
          ? settled[1].value
          : { status: 'api-error', snapshot: null, reasonCode: String(settled[1].reason?.name || 'network-error') };
        const followerGainResult = settled[2].status === 'fulfilled'
          ? settled[2].value
          : { status: 'api-error', snapshots: [], reasonCode: String(settled[2].reason?.name || 'network-error') };
        return {
          ...postResult,
          audienceResult,
          followerGainResult,
          audienceAttempted: linkedinAudienceDue,
          followerGainsAttempted: linkedinFollowerGainsDue,
        };
      })()
      : Promise.resolve({
        status: 'not-collected-this-run',
        posts: [],
        skipped: [],
        audienceResult: { status: 'not-collected-this-run', snapshot: null },
        followerGainResult: { status: 'not-collected-this-run', snapshots: [] },
        audienceAttempted: false,
        followerGainsAttempted: false,
      }),
    instagramAudienceDue
      ? collectInstagramAudience({
        accountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
        accessToken: env.INSTAGRAM_ACCESS_TOKEN,
        asOf,
        fetchImpl: fetchInstagram,
      })
      : Promise.resolve({ status: 'not-due-today', snapshot: null }),
    facebookAudienceDue
      ? collectFacebookAudience({
        pageId: env.FB_PAGE_ID,
        accessToken: env.FB_PAGE_ACCESS_TOKEN,
        asOf,
        fetchImpl: fetchFacebook,
      })
      : Promise.resolve({ status: 'not-due-today', snapshot: null }),
    collectInstagramPosts({
      accountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      ledger: readLedger('instagram-posted.json'),
      existing: toInstagramBrowserSnapshotDocument(existing),
      asOf,
      fetchImpl: fetchInstagram,
    }),
  ]);
  const [tiktokSettled, linkedinSettled, instagramAudienceSettled, facebookAudienceSettled, instagramPostSettled] = collected;
  const tiktokResult = tiktokSettled.status === 'fulfilled'
    ? tiktokSettled.value
    : {
      postResult: { status: 'api-error', posts: [], skipped: [], unmatched: [], reasonCode: String(tiktokSettled.reason?.name || 'network-error') },
      audienceResult: { status: 'api-error', snapshot: null, reasonCode: String(tiktokSettled.reason?.name || 'network-error') },
      audienceAttempted: false,
    };
  const linkedinResult = linkedinSettled.status === 'fulfilled'
    ? linkedinSettled.value
    : {
      status: 'api-error',
      posts: [],
      skipped: [],
      audienceResult: { status: 'api-error', snapshot: null, reasonCode: String(linkedinSettled.reason?.name || 'network-error') },
      followerGainResult: { status: 'api-error', snapshots: [], reasonCode: String(linkedinSettled.reason?.name || 'network-error') },
      audienceAttempted: false,
      followerGainsAttempted: false,
    };
  const instagramAudienceResult = instagramAudienceSettled.status === 'fulfilled'
    ? instagramAudienceSettled.value
    : { status: 'api-error', snapshot: null, reasonCode: String(instagramAudienceSettled.reason?.name || 'network-error') };
  const facebookAudienceResult = facebookAudienceSettled.status === 'fulfilled'
    ? facebookAudienceSettled.value
    : { status: 'api-error', snapshot: null, reasonCode: String(facebookAudienceSettled.reason?.name || 'network-error') };
  const facebookEligibilityStatus = facebookAudienceDue
    ? String(facebookAudienceResult.postInsightsStatus || 'post-insights-eligibility-unverified')
    : String(existing?.sources?.facebook?.eligibilityStatus
      || existing?.sources?.facebook?.postInsightsStatus
      || existing?.sources?.facebook?.status
      || 'post-insights-eligibility-unverified');
  let facebookPostResult;
  try {
    facebookPostResult = await collectFacebookPosts({
      pageId: env.FB_PAGE_ID,
      accessToken: env.FB_PAGE_ACCESS_TOKEN,
      ledger: readFacebookPublicationLedger(),
      existingPosts: existing?.posts,
      eligibilityStatus: facebookEligibilityStatus,
      asOf,
      fetchImpl: fetchFacebook,
    });
  } catch (error) {
    facebookPostResult = {
      status: 'api-error',
      posts: [],
      attempted: 0,
      skipped: 0,
      reasonCode: String(error?.name || 'collector-error').replace(/[^a-z0-9_-]/giu, '_').slice(0, 60),
    };
  }
  const instagramPostResult = instagramPostSettled.status === 'fulfilled'
    ? instagramPostSettled.value
    : { status: 'api-error', additions: [], skipped: [], reasonCode: String(instagramPostSettled.reason?.name || 'network-error') };
  const linkedinAudienceResult = linkedinResult.audienceResult || { status: 'not-collected-this-run', snapshot: null };
  const linkedinFollowerGainResult = linkedinResult.followerGainResult || { status: 'not-collected-this-run', snapshots: [] };
  const tiktokPostResult = tiktokResult.postResult;
  const tiktokAudienceResult = tiktokResult.audienceResult;

  const statuses = {
    instagram: typeof existing?.sources?.instagram?.status === 'string'
      ? existing.sources.instagram.status
      : (existing?.posts || []).some((row) => row.channel === 'instagram') ? 'available' : 'not-collected-yet',
    instagramPostInsights: normalizedSourceStatus(
      instagramPostResult,
      new Set(['snapshots-added', 'nothing-ready', 'nothing-collected']),
    ),
    tiktok: normalizedSourceStatus(tiktokPostResult, new Set(['snapshots-added', 'no-window-matches'])),
    linkedinMember: !linkedinPostAnalyticsStorageApproved
      ? 'policy-review-required'
      : collectLinkedIn
        ? normalizedSourceStatus(linkedinResult, new Set(['snapshots-added', 'backlog-pending', 'no-new-eligible-posts']))
        : String(existing?.sources?.linkedinMember?.status || 'not-collected-yet'),
    facebook: String(facebookPostResult.status || 'unavailable'),
    telegram: 'member-count-only-no-post-metrics-in-bot-api',
    reddit: 'external-devvit-review-required',
    youtubeShorts: 'account-and-oauth-not-configured',
    instagramAudience: instagramAudienceDue
      ? instagramAudienceResult.status
      : String(existing?.sources?.instagramAudience?.status || (hasAudienceSnapshotToday(currentAudience, 'instagram', 'followers', asOf) ? 'available' : 'not-collected-yet')),
    tiktokAudience: !tiktokDisplayAnalyticsApproved
      ? 'policy-review-required'
      : tiktokAudienceDue
        ? tiktokAudienceResult.status
        : String(existing?.sources?.tiktokAudience?.status || (hasAudienceSnapshotToday(currentAudience, 'tiktok', 'followers', asOf) ? 'available' : 'not-collected-yet')),
    facebookAudience: facebookAudienceDue
      ? facebookAudienceResult.status
      : String(existing?.sources?.facebookAudience?.status || (hasAudienceSnapshotToday(currentAudience, 'facebook', 'followers', asOf) ? 'available' : 'not-collected-yet')),
    linkedinAudience: linkedinAudienceDue
      ? linkedinAudienceResult.status
      : String(existing?.sources?.linkedinAudience?.status || (hasAudienceSnapshotToday(currentAudience, 'linkedin-member', 'followers', asOf) ? 'available' : 'not-collected-yet')),
    linkedinFollowerGains: linkedinFollowerGainsDue
      ? linkedinFollowerGainResult.status
      : String(existing?.sources?.linkedinFollowerGains?.status || 'not-collected-yet'),
    telegramAudience: telegramAudienceRows.length ? 'available' : 'history-unavailable',
    youtubeShortsAudience: 'account-and-oauth-not-configured',
    threadsAudience: 'account-and-oauth-not-configured',
  };
  if (tiktokPostResult.status === 'mapping-unavailable') statuses.tiktok = 'api-available-exact-post-ids-missing';

  const instagramPostAdditions = normalizeInstagramPrivateSnapshots({
    windowHours: 72,
    posts: Array.isArray(instagramPostResult.additions) ? instagramPostResult.additions : [],
  });
  const additions = [
    ...instagramPostAdditions,
    ...(tiktokPostResult.posts || []),
    ...(linkedinResult.posts || []),
    ...(facebookPostResult.posts || []),
  ];
  const posts = mergeSnapshots(existing, additions, asOf, {
    pruneLinkedInMemberPosts: !linkedinPostAnalyticsStorageApproved,
  });
  const pendingAudienceSnapshots = [
    ...(instagramAudienceResult.snapshot ? [instagramAudienceResult.snapshot] : []),
    ...(facebookAudienceResult.snapshot ? [facebookAudienceResult.snapshot] : []),
    ...(linkedinAudienceResult.snapshot ? [linkedinAudienceResult.snapshot] : []),
    ...(tiktokAudienceResult.snapshot ? [tiktokAudienceResult.snapshot] : []),
    ...telegramAudienceRows,
  ];
  const audienceSnapshots = mergePrivateSocialAudienceSnapshots(currentAudience, pendingAudienceSnapshots, {
    asOf,
    retentionDays: AUDIENCE_HISTORY_RETENTION_DAYS,
  });
  const pendingFollowerGainSnapshots = Array.isArray(linkedinFollowerGainResult.snapshots)
    ? linkedinFollowerGainResult.snapshots
    : [];
  const followerGainSnapshots = mergePrivateSocialFollowerGainSnapshots(
    existing?.followerGainSnapshots,
    pendingFollowerGainSnapshots,
    { asOf },
  );
  const facebookSourceWithoutStaleReason = Object.fromEntries(
    Object.entries(existing?.sources?.facebook || {}).filter(([key]) => key !== 'reasonCode'
      && (existing?.sources?.facebook?.postInsightsStatus || !['lastSuccessAt', 'latestSnapshotAt'].includes(key))),
  );
  const sourceUpdates = {
    instagramPostInsights: collectorSourceUpdate(
      existing?.sources?.instagramPostInsights,
      instagramPostResult,
      statuses.instagramPostInsights,
      asOf,
      {
        successStatuses: new Set(['snapshots-added', 'nothing-ready', 'nothing-collected']),
        posts: instagramPostAdditions,
      },
    ),
    tiktok: tiktokDisplayAnalyticsApproved
      ? collectorSourceUpdate(existing?.sources?.tiktok, tiktokPostResult, statuses.tiktok, asOf, {
        successStatuses: new Set([
          'snapshots-added', 'partial-snapshots-added', 'partial-no-window-matches',
          'no-window-matches', 'mapping-unavailable',
        ]),
        posts: tiktokPostResult.posts || [],
      })
      : { ...(existing?.sources?.tiktok || {}), status: statuses.tiktok },
    ...(collectLinkedIn || !linkedinPostAnalyticsStorageApproved ? {
      linkedinMember: linkedinPostAnalyticsStorageApproved
        ? {
          ...collectorSourceUpdate(existing?.sources?.linkedinMember, linkedinResult, statuses.linkedinMember, asOf, {
            successStatuses: new Set(['snapshots-added', 'backlog-pending', 'no-new-eligible-posts']),
            posts: linkedinResult.posts || [],
          }),
          postAnalyticsStorageApproved: true,
        }
        : {
          ...(existing?.sources?.linkedinMember || {}),
          status: 'policy-review-required',
          postAnalyticsStorageApproved: false,
          lastCheckedAt: new Date(asOf).toISOString(),
        },
    } : {}),
    facebook: {
      ...collectorSourceUpdate(
        facebookSourceWithoutStaleReason,
        facebookPostResult,
        statuses.facebook,
        asOf,
        { successStatuses: new Set(['available', 'partial', 'no-posts-in-window']), posts: facebookPostResult.posts || [] },
      ),
      eligibilityStatus: facebookEligibilityStatus,
      postInsightsStatus: facebookPostResult.status,
      ...(facebookPostResult.reasonCodes?.length
        ? { reasonCode: facebookPostResult.reasonCodes.join(',').slice(0, 80) }
        : facebookPostResult.reasonCode ? { reasonCode: String(facebookPostResult.reasonCode).slice(0, 80) } : {}),
    },
    instagramAudience: instagramAudienceDue
      ? audienceSourceUpdate(instagramAudienceResult, asOf, { existing: existing?.sources?.instagramAudience })
      : { ...(existing?.sources?.instagramAudience || {}), status: statuses.instagramAudience },
    facebookAudience: facebookAudienceDue
      ? audienceSourceUpdate(facebookAudienceResult, asOf, { existing: existing?.sources?.facebookAudience })
      : { ...(existing?.sources?.facebookAudience || {}), status: statuses.facebookAudience },
    linkedinAudience: linkedinAudienceDue
      ? audienceSourceUpdate(linkedinAudienceResult, asOf, {
        attempted: linkedinResult.audienceAttempted,
        existing: existing?.sources?.linkedinAudience,
      })
      : { ...(existing?.sources?.linkedinAudience || {}), status: statuses.linkedinAudience },
    linkedinFollowerGains: linkedinFollowerGainsDue
      ? followerGainSourceUpdate(linkedinFollowerGainResult, asOf, {
        attempted: linkedinResult.followerGainsAttempted,
        existing: existing?.sources?.linkedinFollowerGains,
      })
      : { ...(existing?.sources?.linkedinFollowerGains || {}), status: statuses.linkedinFollowerGains },
    tiktokAudience: tiktokDisplayAnalyticsApproved && tiktokAudienceDue
      ? audienceSourceUpdate(tiktokAudienceResult, asOf, {
        attempted: tiktokResult.audienceAttempted,
        existing: existing?.sources?.tiktokAudience,
      })
      : { ...(existing?.sources?.tiktokAudience || {}), status: statuses.tiktokAudience },
    telegramAudience: {
      status: statuses.telegramAudience,
      ...(telegramAudienceRows.length ? {
        lastSuccessAt: telegramAudienceRows.at(-1).snapshotAt,
        latestSnapshotAt: telegramAudienceRows.at(-1).snapshotAt,
      } : {}),
    },
    youtubeShortsAudience: statuses.youtubeShortsAudience,
    threadsAudience: statuses.threadsAudience,
  };
  const mergedSources = {
    ...(existing?.sources || {}),
    ...Object.fromEntries(Object.entries(sourceUpdates).map(([name, state]) => [
      name,
      typeof state === 'string' ? { status: state } : state,
    ])),
    ...Object.fromEntries(Object.entries(statuses)
      .filter(([name]) => ['instagram', 'telegram', 'reddit', 'youtubeShorts'].includes(name))
      .map(([name, status]) => [name, { status }])),
  };
  const audienceBaselines = freezeEligibleAudienceBaselines(
    existing?.audienceBaselines,
    audienceSnapshots,
    mergedSources,
    asOf,
  );
  const audienceGrowthCycles = advanceAudienceGrowthCycles(
    existing?.audienceGrowthCycles,
    audienceBaselines,
    audienceSnapshots,
    mergedSources,
    asOf,
  );
  const sourcesChanged = Object.entries(sourceUpdates).some(([name, state]) => {
    const nextState = typeof state === 'string' ? { status: state } : state;
    return JSON.stringify(existing?.sources?.[name] || null) !== JSON.stringify(nextState);
  });
  const next = {
    schemaVersion: 1,
    sources: mergedSources,
    posts,
    audienceSnapshots,
    followerGainSnapshots,
    audienceBaselines,
    audienceGrowthCycles,
    siteOutcomeSnapshots: Array.isArray(existing?.siteOutcomeSnapshots) ? existing.siteOutcomeSnapshots : [],
    siteOutcomeBaselines: Array.isArray(existing?.siteOutcomeBaselines) ? existing.siteOutcomeBaselines : [],
    ...(existing?.weeklyHealth ? { weeklyHealth: existing.weeklyHealth } : {}),
    ...(existing?.communityOutcomes ? { communityOutcomes: existing.communityOutcomes } : {}),
  };
  validateSocialNativeInsightsDocument(next, { asOf });
  const audienceChanged = JSON.stringify(audienceSnapshots) !== JSON.stringify(currentAudience);
  const followerGainsChanged = JSON.stringify(followerGainSnapshots) !== JSON.stringify(existing?.followerGainSnapshots || []);
  const baselineChanged = JSON.stringify(audienceBaselines) !== JSON.stringify(existing?.audienceBaselines || {});
  const growthCyclesChanged = JSON.stringify(audienceGrowthCycles) !== JSON.stringify(existing?.audienceGrowthCycles || {});
  const changed = additions.length > 0 || sourcesChanged || posts.length !== (existing?.posts?.length || 0)
    || audienceChanged || followerGainsChanged || baselineChanged || growthCyclesChanged;
  return {
    status: changed ? 'changed' : 'unchanged',
    changed,
    document: next,
    pendingPosts: additions,
    pendingAudienceSnapshots,
    pendingFollowerGainSnapshots,
    sourceUpdates,
    sources: statuses,
    results: {
      instagramPostInsights: {
        status: instagramPostResult.status,
        posts: instagramPostAdditions.length,
        candidates: instagramPostResult.candidates || 0,
        matched: instagramPostResult.matched || 0,
      },
      tiktok: { status: tiktokPostResult.status, posts: tiktokPostResult.posts?.length || 0, listedVideos: tiktokPostResult.listedVideos || 0, exactLedgerIds: tiktokPostResult.exactLedgerIds || 0 },
      linkedinMember: { status: linkedinResult.status, posts: linkedinResult.posts?.length || 0, remainingEligiblePosts: linkedinResult.remainingEligiblePosts || 0 },
      instagramAudience: { status: instagramAudienceResult.status, snapshot: Boolean(instagramAudienceResult.snapshot) },
      facebookAudience: { status: facebookAudienceResult.status, snapshot: Boolean(facebookAudienceResult.snapshot) },
      facebookPostInsights: {
        status: facebookPostResult.status,
        posts: facebookPostResult.posts?.length || 0,
        attempted: facebookPostResult.attempted || 0,
        skipped: facebookPostResult.skipped || 0,
      },
      linkedinAudience: { status: linkedinAudienceResult.status, snapshot: Boolean(linkedinAudienceResult.snapshot) },
      linkedinFollowerGains: {
        status: linkedinFollowerGainResult.status,
        snapshots: pendingFollowerGainSnapshots.length,
        coverageDays: linkedinFollowerGainResult.coverageDays || 0,
        expectedDays: linkedinFollowerGainResult.expectedDays || 0,
      },
      tiktokAudience: { status: tiktokAudienceResult.status, snapshot: Boolean(tiktokAudienceResult.snapshot) },
      telegramAudience: { status: statuses.telegramAudience, snapshots: telegramAudienceRows.length },
    },
    diagnostics: {
      tiktokSkipped: tiktokPostResult.skipped?.length || 0,
      tiktokUnmatched: tiktokPostResult.unmatched?.length || 0,
      linkedinSkipped: linkedinResult.skipped?.length || 0,
    },
  };
}

function renderSummary(result) {
  const lines = [
    '# Native social insights collection',
    '',
    '| Source | Status | New snapshots | Details |',
    '|---|---|---:|---|',
    `| TikTok Display API | ${result.results.tiktok.status} | ${result.results.tiktok.posts} | listed ${result.results.tiktok.listedVideos}; exact ledger IDs ${result.results.tiktok.exactLedgerIds}; unmatched ${result.diagnostics.tiktokUnmatched} |`,
    `| LinkedIn member analytics | ${result.results.linkedinMember.status} | ${result.results.linkedinMember.posts} | remaining eligible ${result.results.linkedinMember.remainingEligiblePosts}; skipped ${result.diagnostics.linkedinSkipped} |`,
    `| Instagram audience | ${result.results.instagramAudience.status} | ${result.results.instagramAudience.snapshot ? 1 : 0} | account-level value stored privately only |`,
    `| Facebook audience | ${result.results.facebookAudience.status} | ${result.results.facebookAudience.snapshot ? 1 : 0} | Page follower count stored privately only |`,
    `| Facebook post insights | ${result.results.facebookPostInsights.status} | ${result.results.facebookPostInsights.posts} | exact IDs; attempted ${result.results.facebookPostInsights.attempted}; skipped ${result.results.facebookPostInsights.skipped} |`,
    `| LinkedIn member audience | ${result.results.linkedinAudience.status} | ${result.results.linkedinAudience.snapshot ? 1 : 0} | lifetime member follower count stored privately only |`,
    `| LinkedIn follower gains | ${result.results.linkedinFollowerGains.status} | ${result.results.linkedinFollowerGains.snapshots} | ${result.results.linkedinFollowerGains.coverageDays}/${result.results.linkedinFollowerGains.expectedDays} daily observations; channel-level gains, not net or post-attributed; values stored privately only |`,
    `| TikTok audience | ${result.results.tiktokAudience.status} | ${result.results.tiktokAudience.snapshot ? 1 : 0} | requires user.info.stats and eligible-use approval; value stored privately only |`,
    `| Telegram audience | ${result.results.telegramAudience.status} | ${result.results.telegramAudience.snapshots} | member-count history imported; values stored privately only |`,
    `| Facebook post insights | ${result.sources.facebook} | 0 | Fan count is checked without being stored; exact post metrics remain uncollected until an exact-ID probe succeeds |`,
    `| Telegram | ${result.sources.telegram} | 0 | member-count history only |`,
    `| Reddit | ${result.sources.reddit} | 0 | live delivery is external |`,
    `| YouTube Shorts | ${result.sources.youtubeShorts} | 0 | account and OAuth are not configured |`,
    '',
    'Missing permissions, post IDs, or metric fields are recorded as unavailable; they are never converted to zero.',
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = await getFirestoreDb();
  const existing = await loadPrivateSocialNativeInsights(db, { asOf: options.asOf });
  const result = await collectSocialNativeInsights({
    asOf: options.asOf,
    existing,
    collectLinkedIn: !options.skipLinkedIn,
  });
  if (!options.dryRun && result.changed) {
    const saved = await updatePrivateSocialNativeInsights(db, (current) => {
      const sources = {
        ...current.sources,
        ...Object.fromEntries(Object.entries(result.sourceUpdates).map(([name, state]) => [name, mergeSourceState(current.sources?.[name], state)])),
      };
      const audienceSnapshots = mergePrivateSocialAudienceSnapshots(
        current.audienceSnapshots,
        result.pendingAudienceSnapshots,
        { asOf: options.asOf, retentionDays: AUDIENCE_HISTORY_RETENTION_DAYS },
      );
      const audienceBaselines = freezeEligibleAudienceBaselines(
        current.audienceBaselines,
        audienceSnapshots,
        sources,
        options.asOf,
      );
      const audienceGrowthCycles = advanceAudienceGrowthCycles(
        current.audienceGrowthCycles,
        audienceBaselines,
        audienceSnapshots,
        sources,
        options.asOf,
      );
      const followerGainSnapshots = mergePrivateSocialFollowerGainSnapshots(
        current.followerGainSnapshots,
        result.pendingFollowerGainSnapshots,
        { asOf: options.asOf },
      );
      return {
        schemaVersion: 1,
        generatedAt: options.asOf.toISOString(),
        sources,
        posts: mergeSnapshots(current, result.pendingPosts, options.asOf),
        audienceSnapshots,
        audienceBaselines,
        audienceGrowthCycles,
        followerGainSnapshots,
        siteOutcomeSnapshots: Array.isArray(current.siteOutcomeSnapshots) ? current.siteOutcomeSnapshots : [],
        siteOutcomeBaselines: Array.isArray(current.siteOutcomeBaselines) ? current.siteOutcomeBaselines : [],
        ...(current.weeklyHealth ? { weeklyHealth: current.weeklyHealth } : {}),
        ...(current.communityOutcomes ? { communityOutcomes: current.communityOutcomes } : {}),
        ...(current.robotDelivery ? { robotDelivery: current.robotDelivery } : {}),
      };
    }, { updatedAt: options.asOf });
    result.storageBytes = saved.bytes;
  }
  const summary = renderSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY && !options.json) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }
  const safeJson = {
    status: result.status,
    changed: result.changed,
    sources: result.sources,
    results: result.results,
    diagnostics: result.diagnostics,
    ...(Number.isSafeInteger(result.storageBytes) ? { storageBytes: result.storageBytes } : {}),
    persistence: options.dryRun ? 'dry-run' : result.changed ? 'private-firestore' : 'unchanged',
  };
  process.stdout.write(options.json ? `${JSON.stringify(safeJson, null, 2)}\n` : summary);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`social-native-insights: ${String(error?.message || error).slice(0, 180)}`);
    process.exitCode = 1;
  });
}
