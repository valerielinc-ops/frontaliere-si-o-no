#!/usr/bin/env node

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  SOCIAL_GA4_ACTION_EVENTS,
  SOCIAL_GA4_ACTION_EVENT_CONTRACTS,
  SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS,
  SOCIAL_GA4_DATA_LAG_DAYS,
  SOCIAL_GA4_EVENT_CONTRACT_VERSION,
  isSocialGa4SessionKeyEventRateEligible,
} from '../lib/social-ga4-contract.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
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
const COPY_CONTENT_SUFFIX = /--cp([a-f0-9]{16})-([a-z0-9][a-z0-9-]{0,31})\.([a-z0-9][a-z0-9-]{0,31})(?:\.a([a-z0-9][a-z0-9-]{0,31}))?(?:\.(b|d|f)(?:\.([a-f0-9]{8}))?)?$/;
const SOCIAL_COPY_CONTENT_FILTER = '.*--cp[a-f0-9]{16}-[a-z0-9][a-z0-9-]{0,31}\\.[a-z0-9][a-z0-9-]{0,31}(\\.a[a-z0-9][a-z0-9-]{0,31})?(\\.[bdf](\\.[a-f0-9]{8})?)?$';
export const SOCIAL_COPY_GA4_WINDOW_DAYS = SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS;
export const SOCIAL_COPY_GA4_LAG_DAYS = SOCIAL_GA4_DATA_LAG_DAYS;
export const SOCIAL_COPY_GA4_MINIMUM_SESSIONS = 10;
export const SOCIAL_COPY_GA4_MINIMUM_ACTION_EVENTS = 10;
export const SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION = SOCIAL_GA4_EVENT_CONTRACT_VERSION;
export const SOCIAL_COPY_GA4_ACTION_EVENTS = SOCIAL_GA4_ACTION_EVENTS;
export const SOCIAL_COPY_GA4_ACTION_EVENT_CONTRACTS = SOCIAL_GA4_ACTION_EVENT_CONTRACTS;

function dim(row, index) {
  return String(row?.dimensionValues?.[index]?.value || '').trim();
}

function metric(row, index) {
  const raw = row?.metricValues?.[index]?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function socialCopyGa4ReportIssue(report) {
  if (!report || report.complete !== true || !Array.isArray(report.rows)) return 'incomplete-report';
  const metadata = report.metadata || {};
  if (metadata.dataLossFromOtherRow === true) return 'data-loss-other-row';
  if (metadata.subjectToThresholding === true) return 'subject-to-thresholding';
  if (Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0) return 'sampled-report';
  if (Array.isArray(metadata.dataTruncationReasons) && metadata.dataTruncationReasons.length > 0) return 'truncated-report';
  if (Array.isArray(metadata.schemaRestrictionResponse?.activeMetricRestrictions)
    && metadata.schemaRestrictionResponse.activeMetricRestrictions.length > 0) return 'metric-restricted-report';
  return null;
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
    eventContractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION,
    acceptedRows: 0,
    variants: [],
    actionsAvailable: false,
    siteActions: [],
    actionReportStatus: 'unavailable',
    siteActionRates: [],
    keyEventMetadataStatus: 'unavailable',
    actionRateReportStatus: 'unavailable',
    interpretation: 'Descriptive only; sessions are not impressions and do not establish causality or a winning template.',
  };
}

function normalizePropertyId(value) {
  const raw = String(value || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID).trim();
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;
  if (!/^properties\/\d+$/u.test(property)) throw new Error('invalid GA4 property id');
  return property;
}

/** Read the property's registered per-event session-rate metrics, if available. */
export async function listSocialCopySessionKeyEventMetrics({ token, propertyId, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('GA4 metadata token unavailable');
  const property = normalizePropertyId(propertyId);
  const response = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/${property}/metadata`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GA4 metadata request failed (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data?.metrics)) throw new Error('GA4 metadata response has no metric list');
  return new Set(data.metrics
    .map((item) => String(item?.apiName || '').trim())
    .filter((name) => name.startsWith('sessionKeyEventRate:')));
}

/**
 * Reduce GA4 UTM rows to channel/kind/template aggregates. Page slugs and
 * complete UTM content values are discarded before the brief reaches Codex.
 */
export function buildSocialCopyGa4Brief(report, {
  startDate = '',
  endDate = '',
  minimumSessions = SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
  actionReport = null,
  actionRateReport = null,
  registeredKeyEventNames = null,
  keyEventMetadataStatus = 'unverified',
  actionEventReportStatus = null,
  actionRateReportStatus = 'unavailable',
  minimumActionEvents = SOCIAL_COPY_GA4_MINIMUM_ACTION_EVENTS,
} = {}) {
  const reportIssue = socialCopyGa4ReportIssue(report);
  if (reportIssue) {
    return {
      ...unavailableBrief(reportIssue, { startDate, endDate }),
      actionReportStatus: actionEventReportStatus || 'unavailable',
      keyEventMetadataStatus,
      actionRateReportStatus,
    };
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

    const [, packId, copySlot, templateId, angleId, assignmentCode, experimentIdHash] = match;
    const assignmentMode = ({ b: 'firebase-balanced', d: 'deterministic', f: 'deterministic-fallback' })[assignmentCode]
      || 'legacy-unmarked';
    if (!campaignIdentity.copySlots.includes(copySlot)) continue;
    const key = [source, campaignIdentity.kind, copySlot, packId, templateId, angleId || 'legacy-angle', assignmentMode, experimentIdHash || 'unknown'].join('|');
    const group = groups.get(key) || {
      channel: source,
      kind: campaignIdentity.kind,
      copySlot,
      packId,
      templateId,
      ...(angleId ? { angleId } : {}),
      assignmentMode,
      experimentIdHash: experimentIdHash || null,
      sessions: 0,
      engagedSessions: 0,
      sessionsAvailable: true,
      engagedSessionsAvailable: true,
    };
    const sessions = metric(row, 0);
    const engagedSessions = metric(row, 1);
    if (sessions === null) group.sessionsAvailable = false;
    else group.sessions += sessions;
    if (engagedSessions === null) group.engagedSessionsAvailable = false;
    else group.engagedSessions += engagedSessions;
    groups.set(key, group);
    acceptedRows += 1;
  }

  const variants = [...groups.values()]
    .sort((a, b) => a.channel.localeCompare(b.channel)
      || a.kind.localeCompare(b.kind)
      || a.copySlot.localeCompare(b.copySlot)
      || a.packId.localeCompare(b.packId)
      || String(a.angleId || '').localeCompare(String(b.angleId || ''))
      || a.templateId.localeCompare(b.templateId)
      || a.assignmentMode.localeCompare(b.assignmentMode)
      || String(a.experimentIdHash || '').localeCompare(String(b.experimentIdHash || '')))
    .map((group) => {
      const enoughData = group.sessionsAvailable && group.engagedSessionsAvailable && group.sessions >= minimumSessions;
      return {
        channel: group.channel,
        kind: group.kind,
        copySlot: group.copySlot,
        packId: group.packId,
        templateId: group.templateId,
        ...(group.angleId ? { angleId: group.angleId } : {}),
        assignmentMode: group.assignmentMode,
        experimentIdHash: group.experimentIdHash,
        sessions: group.sessionsAvailable ? group.sessions : null,
        engagedSessions: group.engagedSessionsAvailable ? group.engagedSessions : null,
        eligibleForDescription: enoughData,
        siteEngagedSessionRate: enoughData ? group.engagedSessions / group.sessions : null,
      };
    });

  const siteActions = buildSocialCopyGa4ActionBrief(actionReport, { minimumEvents: minimumActionEvents });
  const keyEventNames = Array.isArray(registeredKeyEventNames)
    ? [...new Set(registeredKeyEventNames.filter((name) => (
      Object.hasOwn(SOCIAL_COPY_GA4_ACTION_EVENTS, name)
    )))]
    : null;
  const rateGroups = buildSocialCopyGa4ActionRateMap(actionRateReport, keyEventNames);
  const siteActionEvents = siteActions.events.map((event) => {
    const registered = keyEventNames?.includes(event.eventName) === true;
    const rate = rateGroups.get(actionIdentityKey(event, event.eventName));
    return {
      ...event,
      liveKeyEventRegistration: keyEventNames === null
        ? 'unverified'
        : registered ? 'registered' : 'not-registered',
      keyEventMetadataStatus,
      sessionKeyEventRate: rate?.eligibleForDescription ? rate.sessionKeyEventRate : null,
      sessionsForSessionKeyEventRate: rate?.eligibleForDescription ? rate.sessions : null,
      eligibleForSessionKeyEventRateDescription: rate?.eligibleForDescription === true,
      sessionKeyEventRateStatus: !isSocialGa4SessionKeyEventRateEligible(event.eventName)
        ? 'excluded-by-event-contract'
        : !registered
        ? keyEventNames === null ? 'registration-unverified' : 'not-a-registered-key-event'
        : rate?.status || actionRateReportStatus,
    };
  });
  const siteActionRates = [...rateGroups.values()].map((rate) => ({
    ...rate.identity,
    eventName: rate.eventName,
    eventMeaning: SOCIAL_COPY_GA4_ACTION_EVENTS[rate.eventName],
    eventContractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION,
    keyEventMetadataStatus,
    liveKeyEventRegistration: 'registered',
    sessions: rate.eligibleForDescription ? rate.sessions : null,
    sessionKeyEventRate: rate.eligibleForDescription ? rate.sessionKeyEventRate : null,
    eligibleForDescription: rate.eligibleForDescription,
    status: rate.status,
  }));
  return {
    schemaVersion: 1,
    source: 'ga4-social-copy-attribution',
    available: true,
    startDate,
    endDate,
    minimumSessions,
    eventContractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION,
    acceptedRows,
    variants,
    actionsAvailable: siteActions.available,
    actionReportStatus: actionEventReportStatus || (actionReport
      ? siteActions.reason || 'available'
      : 'unavailable'),
    actionEventContractVersion: siteActions.contractVersion || SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION,
    siteActions: siteActionEvents,
    siteActionRates,
    keyEventMetadataStatus,
    actionRateReportStatus,
    interpretation: acceptedRows === 0
      ? 'No copy-attributed rows were available; this is missing evidence, not zero traffic or evidence of poor performance.'
      : 'Descriptive only; sessions are not impressions and do not establish causality or a winning template.',
  };
}

function actionIdentityKey(value, eventName) {
  return [
    value.channel,
    value.kind,
    value.copySlot,
    value.packId,
    value.templateId,
    value.angleId || 'legacy-angle',
    value.assignmentMode,
    value.experimentIdHash || 'unknown',
    eventName,
  ].join('|');
}

/**
 * Build weighted, post-copy-cohort session key-event rates. The request has no
 * eventName dimension or event filter, so non-converting sessions remain in
 * the denominator. Only registered, allowlisted events are admitted.
 */
export function buildSocialCopyGa4ActionRateMap(report, registeredEventNames, {
  minimumSessions = SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
} = {}) {
  if (socialCopyGa4ReportIssue(report)
    || !Array.isArray(registeredEventNames) || registeredEventNames.length === 0) return new Map();

  const eventNames = [...new Set(registeredEventNames.filter((name) => (
    Object.hasOwn(SOCIAL_COPY_GA4_ACTION_EVENTS, name) && isSocialGa4SessionKeyEventRateEligible(name)
  )))];
  const groups = new Map();
  for (const row of report.rows) {
    const source = dim(row, 0).toLowerCase();
    const campaign = dim(row, 1);
    const content = dim(row, 2);
    const campaignIdentity = CAMPAIGN_CHANNEL.get(campaign);
    const match = content.match(COPY_CONTENT_SUFFIX);
    if (!campaignIdentity || source !== campaignIdentity.channel || !match) continue;
    const [, packId, copySlot, templateId, angleId, assignmentCode, experimentIdHash] = match;
    if (!campaignIdentity.copySlots.includes(copySlot)) continue;
    const assignmentMode = ({ b: 'firebase-balanced', d: 'deterministic', f: 'deterministic-fallback' })[assignmentCode]
      || 'legacy-unmarked';
    const identity = {
      channel: source,
      kind: campaignIdentity.kind,
      copySlot,
      packId,
      templateId,
      ...(angleId ? { angleId } : {}),
      assignmentMode,
      experimentIdHash: experimentIdHash || null,
    };
    const sessions = metric(row, 0);
    for (const [index, eventName] of eventNames.entries()) {
      const key = actionIdentityKey(identity, eventName);
      const group = groups.get(key) || {
        sessions: 0,
        weightedRateTotal: 0,
        available: true,
        hasPositiveDenominator: false,
        identity,
        eventName,
      };
      const rate = metric(row, index + 1);
      if (sessions === null || rate === null || rate > 1) {
        group.available = false;
      } else if (sessions > 0) {
        group.sessions += sessions;
        group.weightedRateTotal += rate * sessions;
        group.hasPositiveDenominator = true;
      }
      groups.set(key, group);
    }
  }

  return new Map([...groups.entries()].map(([key, group]) => {
    const eligibleForDescription = group.available
      && group.hasPositiveDenominator
      && group.sessions >= minimumSessions;
    return [key, {
      status: !group.available ? 'metric-unavailable'
        : !group.hasPositiveDenominator ? 'no-session-denominator'
          : group.sessions < minimumSessions ? 'insufficient-sessions' : 'available',
      sessions: group.sessions,
      sessionKeyEventRate: eligibleForDescription ? group.weightedRateTotal / group.sessions : null,
      eligibleForDescription,
      identity: group.identity,
      eventName: group.eventName,
    }];
  }));
}

/** Reduce allowlisted event counts to exact copy-arm groups; no user identifiers are queried. */
export function buildSocialCopyGa4ActionBrief(report, {
  minimumEvents = SOCIAL_COPY_GA4_MINIMUM_ACTION_EVENTS,
} = {}) {
  const reportIssue = socialCopyGa4ReportIssue(report);
  if (reportIssue) {
    return { available: false, reason: reportIssue, contractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION, events: [] };
  }
  const groups = new Map();
  for (const row of report.rows) {
    const source = dim(row, 0).toLowerCase();
    const campaign = dim(row, 1);
    const content = dim(row, 2);
    const eventName = dim(row, 3);
    const campaignIdentity = CAMPAIGN_CHANNEL.get(campaign);
    const match = content.match(COPY_CONTENT_SUFFIX);
    const eventMeaning = SOCIAL_COPY_GA4_ACTION_EVENTS[eventName];
    const eventContract = SOCIAL_COPY_GA4_ACTION_EVENT_CONTRACTS[eventName];
    if (!campaignIdentity || source !== campaignIdentity.channel || !match || !eventMeaning || !eventContract) continue;

    const [, packId, copySlot, templateId, angleId, assignmentCode, experimentIdHash] = match;
    if (!campaignIdentity.copySlots.includes(copySlot)) continue;
    const assignmentMode = ({ b: 'firebase-balanced', d: 'deterministic', f: 'deterministic-fallback' })[assignmentCode]
      || 'legacy-unmarked';
    const key = [source, campaignIdentity.kind, copySlot, packId, templateId, angleId || 'legacy-angle', assignmentMode, experimentIdHash || 'unknown', eventName].join('|');
    const group = groups.get(key) || {
      channel: source,
      kind: campaignIdentity.kind,
      copySlot,
      packId,
      templateId,
      ...(angleId ? { angleId } : {}),
      assignmentMode,
      experimentIdHash: experimentIdHash || null,
      eventName,
      eventMeaning,
      eventContractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION,
      ...eventContract,
      attributionGrain: 'aggregate event occurrences by tagged social campaign and exact copy template; not a user-level join',
      eligibleDestinationTags: 'utm_medium=social plus an allowlisted campaign and copy-pack/template suffix; angle ID is present when the publisher emitted one',
      eventCount: 0,
      countAvailable: true,
    };
    const count = metric(row, 0);
    if (count === null) group.countAvailable = false;
    else group.eventCount += count;
    groups.set(key, group);
  }
  const events = [...groups.values()]
    .sort((left, right) => left.channel.localeCompare(right.channel)
      || left.kind.localeCompare(right.kind)
      || left.copySlot.localeCompare(right.copySlot)
      || left.templateId.localeCompare(right.templateId)
      || left.eventName.localeCompare(right.eventName)
      || String(left.experimentIdHash || '').localeCompare(String(right.experimentIdHash || '')))
    .map((group) => {
      const enough = group.countAvailable && group.eventCount >= minimumEvents;
      return {
        channel: group.channel,
        kind: group.kind,
        copySlot: group.copySlot,
        packId: group.packId,
        templateId: group.templateId,
        ...(group.angleId ? { angleId: group.angleId } : {}),
        assignmentMode: group.assignmentMode,
        experimentIdHash: group.experimentIdHash,
        eventName: group.eventName,
        eventMeaning: group.eventMeaning,
        eventContractVersion: group.eventContractVersion,
        funnelStage: group.funnelStage,
        observedAction: group.observedAction,
        keyEventStatus: group.keyEventStatus,
        strongestClaim: group.strongestClaim,
        attributionGrain: group.attributionGrain,
        eligibleDestinationTags: group.eligibleDestinationTags,
        eventCount: group.countAvailable ? group.eventCount : null,
        eligibleForDescription: enough,
      };
    });
  return { available: true, contractVersion: SOCIAL_COPY_GA4_EVENT_CONTRACT_VERSION, events };
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

export function buildSocialCopyGa4ActionRequest({ now = new Date() } = {}) {
  return {
    dateRanges: [ga4DateRange(SOCIAL_COPY_GA4_WINDOW_DAYS, SOCIAL_COPY_GA4_LAG_DAYS, now)],
    dimensions: [
      { name: 'sessionManualSource' },
      { name: 'sessionManualCampaignName' },
      { name: 'sessionManualAdContent' },
      { name: 'eventName' },
    ],
    metrics: [{ name: 'eventCount' }],
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
          {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: Object.keys(SOCIAL_COPY_GA4_ACTION_EVENTS), caseSensitive: true },
            },
          },
        ],
      },
    },
  };
}

export function buildSocialCopyGa4ActionRateRequest({ eventNames = [], now = new Date() } = {}) {
  const registered = [...new Set(eventNames.filter((name) => (
    Object.hasOwn(SOCIAL_COPY_GA4_ACTION_EVENTS, name) && isSocialGa4SessionKeyEventRateEligible(name)
  )))];
  if (registered.length === 0) return null;
  return {
    dateRanges: [ga4DateRange(SOCIAL_COPY_GA4_WINDOW_DAYS, SOCIAL_COPY_GA4_LAG_DAYS, now)],
    dimensions: [
      { name: 'sessionManualSource' },
      { name: 'sessionManualCampaignName' },
      { name: 'sessionManualAdContent' },
    ],
    metrics: [
      { name: 'sessions' },
      ...registered.map((name) => ({ name: `sessionKeyEventRate:${name}` })),
    ],
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
  listKeyEventMetricsImpl = listSocialCopySessionKeyEventMetrics,
} = {}) {
  const dateRange = ga4DateRange(SOCIAL_COPY_GA4_WINDOW_DAYS, SOCIAL_COPY_GA4_LAG_DAYS, now);
  const dates = { startDate: dateRange.startDate, endDate: dateRange.endDate };
  const token = await getTokenImpl();
  if (!token) return unavailableBrief('credentials-unavailable', dates);

  try {
    const reportRequest = {
      token,
      propertyId,
      pageSize: 100_000,
      maxRows: 250_000,
    };
    const report = await runReportImpl({ ...reportRequest, body: buildSocialCopyGa4Request({ now }) });
    let actionReport = null;
    let actionEventReportStatus = 'report-unavailable';
    try {
      actionReport = await runReportImpl({ ...reportRequest, body: buildSocialCopyGa4ActionRequest({ now }) });
      actionEventReportStatus = socialCopyGa4ReportIssue(actionReport) || 'available';
    } catch {
      actionReport = null;
    }
    let registeredKeyEventNames = null;
    let keyEventMetadataStatus = 'unverified';
    let actionRateReport = null;
    let actionRateReportStatus = 'registration-unverified';
    try {
      const metricNames = await listKeyEventMetricsImpl({ token, propertyId });
      registeredKeyEventNames = Object.keys(SOCIAL_COPY_GA4_ACTION_EVENTS).filter((eventName) => (
        metricNames instanceof Set
          ? metricNames.has(`sessionKeyEventRate:${eventName}`)
          : Array.isArray(metricNames) && metricNames.includes(`sessionKeyEventRate:${eventName}`)
      ));
      keyEventMetadataStatus = 'verified';
      if (registeredKeyEventNames.length === 0) {
        actionRateReportStatus = 'no-allowlisted-key-events-registered';
      } else if (!registeredKeyEventNames.some(isSocialGa4SessionKeyEventRateEligible)) {
        actionRateReportStatus = 'no-rate-eligible-key-events';
      } else {
        const rateRequest = buildSocialCopyGa4ActionRateRequest({ eventNames: registeredKeyEventNames, now });
        try {
          actionRateReport = await runReportImpl({ ...reportRequest, body: rateRequest });
          actionRateReportStatus = socialCopyGa4ReportIssue(actionRateReport) || 'available';
        } catch {
          actionRateReportStatus = 'report-unavailable';
        }
      }
    } catch {
      keyEventMetadataStatus = 'unavailable';
      actionRateReportStatus = 'registration-unverified';
    }
    return buildSocialCopyGa4Brief(report, {
      ...dates,
      actionReport,
      actionEventReportStatus,
      actionRateReport,
      registeredKeyEventNames,
      keyEventMetadataStatus,
      actionRateReportStatus,
    });
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
