#!/usr/bin/env node

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  runGa4ReportPaged,
} from '../lib/ga4-service-account.mjs';

const CHANNEL_CAMPAIGNS = Object.freeze({
  facebook: Object.freeze({
    facebook_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article']) }),
    facebook_event: Object.freeze({ kind: 'event', copySlots: Object.freeze(['event', 'digest']) }),
    facebook_job: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job']) }),
  }),
  instagram: Object.freeze({
    instagram_daily_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article']) }),
    instagram_daily_job: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job']) }),
    instagram_weekly_border: Object.freeze({ kind: 'border', copySlots: Object.freeze(['border']) }),
    instagram_reel_experiment: Object.freeze({ kind: 'reel', copySlots: Object.freeze(['reel']) }),
  }),
  linkedin: Object.freeze({
    linkedin_member_daily_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article']) }),
    linkedin_member_daily_job: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job']) }),
    linkedin_company_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article']) }),
  }),
  telegram: Object.freeze({
    jobs_digest: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job']) }),
    border_ranking: Object.freeze({ kind: 'border', copySlots: Object.freeze(['border']) }),
  }),
  reddit: Object.freeze({
    reddit_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article']) }),
    reddit_job: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job']) }),
  }),
  tiktok: Object.freeze({
    tiktok_daily_article: Object.freeze({ kind: 'article', copySlots: Object.freeze(['article', 'video']) }),
    tiktok_daily_job: Object.freeze({ kind: 'job', copySlots: Object.freeze(['job', 'video']) }),
    tiktok_weekly_border: Object.freeze({ kind: 'border', copySlots: Object.freeze(['border', 'video']) }),
  }),
});

const CAMPAIGN_CHANNEL = new Map(
  Object.entries(CHANNEL_CAMPAIGNS).flatMap(([channel, campaigns]) =>
    Object.entries(campaigns).map(([campaign, identity]) => [campaign, { channel, ...identity }]),
  ),
);
const COPY_CONTENT_SUFFIX = /--cp([a-f0-9]{16})-([a-z0-9][a-z0-9-]{0,31})\.([a-z0-9][a-z0-9-]{0,31})(?:\.(b|d|f)(?:\.([a-f0-9]{8}))?)?$/;
const SOCIAL_COPY_CONTENT_FILTER = '.*--cp[a-f0-9]{16}-[a-z0-9][a-z0-9-]{0,31}\\.[a-z0-9][a-z0-9-]{0,31}(\\.[bdf](\\.[a-f0-9]{8})?)?$';
export const SOCIAL_COPY_GA4_WINDOW_DAYS = 30;
export const SOCIAL_COPY_GA4_LAG_DAYS = 2;
export const SOCIAL_COPY_GA4_MINIMUM_SESSIONS = 10;

function dim(row, index) {
  return String(row?.dimensionValues?.[index]?.value || '').trim();
}

function metric(row, index) {
  const value = Number(row?.metricValues?.[index]?.value || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function unavailableBrief(reason, { startDate = '', endDate = '' } = {}) {
  return {
    schemaVersion: 1,
    source: 'ga4-social-copy-attribution',
    available: false,
    reason,
    startDate,
    endDate,
    minimumSessions: SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
    acceptedRows: 0,
    variants: [],
    interpretation: 'Descriptive only; sessions are not impressions and do not establish causality or a winning template.',
  };
}

/**
 * Reduce GA4 UTM rows to channel/kind/template aggregates. Page slugs and
 * complete UTM content values are discarded before the brief reaches Codex.
 */
export function buildSocialCopyGa4Brief(report, {
  startDate = '',
  endDate = '',
  minimumSessions = SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
} = {}) {
  if (!report || report.complete !== true || !Array.isArray(report.rows)) {
    return unavailableBrief('incomplete-report', { startDate, endDate });
  }

  const groups = new Map();
  let acceptedRows = 0;
  for (const row of report.rows) {
    const source = dim(row, 0).toLowerCase();
    const campaign = dim(row, 1);
    const content = dim(row, 2);
    const campaignIdentity = CAMPAIGN_CHANNEL.get(campaign);
    const match = content.match(COPY_CONTENT_SUFFIX);
    if (!campaignIdentity || source !== campaignIdentity.channel || !match) continue;

    const [, packId, copySlot, templateId, assignmentCode, experimentIdHash] = match;
    const assignmentMode = ({ b: 'firebase-balanced', d: 'deterministic', f: 'deterministic-fallback' })[assignmentCode]
      || 'legacy-unmarked';
    if (!campaignIdentity.copySlots.includes(copySlot)) continue;
    const key = [source, campaignIdentity.kind, copySlot, packId, templateId, assignmentMode, experimentIdHash || 'unknown'].join('|');
    const group = groups.get(key) || {
      channel: source,
      kind: campaignIdentity.kind,
      copySlot,
      packId,
      templateId,
      assignmentMode,
      experimentIdHash: experimentIdHash || null,
      sessions: 0,
      engagedSessions: 0,
    };
    group.sessions += metric(row, 0);
    group.engagedSessions += metric(row, 1);
    groups.set(key, group);
    acceptedRows += 1;
  }

  const variants = [...groups.values()]
    .sort((a, b) => a.channel.localeCompare(b.channel)
      || a.kind.localeCompare(b.kind)
      || a.copySlot.localeCompare(b.copySlot)
      || a.packId.localeCompare(b.packId)
      || a.templateId.localeCompare(b.templateId)
      || a.assignmentMode.localeCompare(b.assignmentMode)
      || String(a.experimentIdHash || '').localeCompare(String(b.experimentIdHash || '')))
    .map((group) => {
      const enoughData = group.sessions >= minimumSessions;
      return {
        channel: group.channel,
        kind: group.kind,
        copySlot: group.copySlot,
        packId: group.packId,
        templateId: group.templateId,
        assignmentMode: group.assignmentMode,
        experimentIdHash: group.experimentIdHash,
        sessions: group.sessions,
        engagedSessions: group.engagedSessions,
        eligibleForDescription: enoughData,
        siteEngagedSessionRate: enoughData ? group.engagedSessions / group.sessions : null,
      };
    });

  return {
    schemaVersion: 1,
    source: 'ga4-social-copy-attribution',
    available: true,
    startDate,
    endDate,
    minimumSessions,
    acceptedRows,
    variants,
    interpretation: acceptedRows === 0
      ? 'No copy-attributed rows were available; this is missing evidence, not zero traffic or evidence of poor performance.'
      : 'Descriptive only; sessions are not impressions and do not establish causality or a winning template.',
  };
}

export function buildSocialCopyGa4Request({ now = new Date() } = {}) {
  return {
    dateRanges: [ga4DateRange(SOCIAL_COPY_GA4_WINDOW_DAYS, SOCIAL_COPY_GA4_LAG_DAYS, now)],
    dimensions: [
      { name: 'sessionManualSource' },
      { name: 'sessionManualCampaignName' },
      { name: 'sessionManualAdContent' },
    ],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: 'sessionManualMedium',
              stringFilter: { value: 'social', matchType: 'EXACT', caseSensitive: false },
            },
          },
          {
            filter: {
              fieldName: 'sessionManualAdContent',
              stringFilter: { value: SOCIAL_COPY_CONTENT_FILTER, matchType: 'FULL_REGEXP', caseSensitive: false },
            },
          },
        ],
      },
    },
  };
}

export async function collectSocialCopyGa4Brief({
  now = new Date(),
  propertyId,
  getTokenImpl = () => getServiceAccountToken([GA4_READONLY_SCOPE], {
    logInfo: () => {},
    logError: () => {},
  }),
  runReportImpl = runGa4ReportPaged,
} = {}) {
  const dateRange = ga4DateRange(SOCIAL_COPY_GA4_WINDOW_DAYS, SOCIAL_COPY_GA4_LAG_DAYS, now);
  const dates = { startDate: dateRange.startDate, endDate: dateRange.endDate };
  const token = await getTokenImpl();
  if (!token) return unavailableBrief('credentials-unavailable', dates);

  try {
    const report = await runReportImpl({
      token,
      body: buildSocialCopyGa4Request({ now }),
      propertyId,
      pageSize: 100_000,
      maxRows: 250_000,
    });
    return buildSocialCopyGa4Brief(report, dates);
  } catch {
    return unavailableBrief('report-unavailable', dates);
  }
}

export async function run() {
  const brief = await collectSocialCopyGa4Brief();
  process.stdout.write(JSON.stringify(brief));
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  run().catch(() => {
    process.stdout.write(JSON.stringify(unavailableBrief('report-unavailable')));
  });
}
