#!/usr/bin/env node

/**
 * Read-only outcome exporters for the three site-only loop ledgers.
 *
 * The script deliberately uses Google REST APIs and the native Node runtime:
 * the loop workflows are sparse checkouts and must not install dependencies.
 * It never writes Firestore, sends mail, changes prices or edits inventory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHogQL } from '../lib/posthog-client.mjs';

export const DEFAULT_L1_WINDOW_DAYS = 4;
export const DEFAULT_L4_WINDOW_HOURS = 30;
export const DEFAULT_L9_WINDOW_HOURS = 240;

const DAY_MS = 86_400_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isObject(value)) {
    if (typeof value.toMillis === 'function') {
      try {
        const parsed = value.toMillis();
        return Number.isFinite(parsed) ? parsed : null;
      } catch { return null; }
    }
    if (typeof value.seconds === 'number') {
      return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
    }
    if (typeof value._seconds === 'number') {
      return value._seconds * 1000 + Math.floor(Number(value._nanoseconds || 0) / 1e6);
    }
  }
  return null;
}

function first(data, names) {
  for (const name of names) {
    if (data?.[name] !== undefined && data?.[name] !== null) return data[name];
  }
  return null;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function readServiceAccount() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const raw = file
    ? fs.readFileSync(path.resolve(file), 'utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON is required');
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error('Firebase service-account JSON is invalid');
  }
  if (!text(account.client_email) || !text(account.private_key) || !text(account.project_id)) {
    throw new Error('Firebase service-account JSON lacks project_id, client_email or private_key');
  }
  return account;
}

function authJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createSign('RSA-SHA256')
    .update(unsigned)
    .sign(serviceAccount.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

/**
 * Firestore REST `runQuery` is a streaming endpoint: the HTTP body contains
 * one RunQueryResponse JSON object per line, not one JSON array.  Keep the
 * parser explicit so a valid empty result and a malformed stream cannot be
 * confused with one another by a caller that is building an outcome ledger.
 */
export function parseRunQueryResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload)) return [payload];
  if (typeof payload !== 'string') return [];
  const raw = payload.trim();
  if (!raw) return [];
  try {
    return parseRunQueryResponse(JSON.parse(raw));
  } catch (error) {
    const records = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) records.push(...parsed);
        else records.push(parsed);
      } catch (lineError) {
        throw new Error(`Firestore runQuery returned invalid JSON stream at record ${index + 1}: ${lineError.message}`, { cause: error });
      }
    }
    return records;
  }
}

async function responseText(response) {
  if (typeof response.text === 'function') return response.text();
  const body = await response.json().catch(() => ({}));
  return JSON.stringify(body);
}

/** Minimal authenticated Google REST client used by the sparse workflows. */
export class GoogleDataClient {
  constructor({ serviceAccount = readServiceAccount(), fetchImpl = fetch } = {}) {
    this.serviceAccount = serviceAccount;
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenPromise = null;
  }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: authJwt(this.serviceAccount),
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !text(body.access_token)) {
          throw new Error(`google oauth ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
        }
        this.token = {
          value: body.access_token,
          expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
        };
        return this.token.value;
      })().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  async request(url, init = {}) {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`google api ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }

  async runQuery({ collectionId, allDescendants = false, where = null, fieldPaths = [] }) {
    const structuredQuery = {
      from: [{ collectionId, allDescendants }],
    };
    if (fieldPaths.length) structuredQuery.select = { fields: fieldPaths.map((fieldPath) => ({ fieldPath })) };
    if (where) structuredQuery.where = where;
    const parent = `projects/${this.serviceAccount.project_id}/databases/(default)/documents`;
    const response = await this.fetchImpl(
      `https://firestore.googleapis.com/v1/${parent}:runQuery`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ structuredQuery }),
      },
    );
    const raw = await responseText(response);
    if (!response.ok) throw new Error(`google api ${response.status}: ${raw.slice(0, 300)}`);
    return parseRunQueryResponse(raw)
      .filter((row) => row?.document)
      .map((row) => firestoreRow(row.document));
  }

  async remoteConfig() {
    return this.request(
      `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(this.serviceAccount.project_id)}/remoteConfig`,
    );
  }
}

function firestoreValue(value) {
  if (!isObject(value)) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValue);
  if ('mapValue' in value) {
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, firestoreValue(item)]));
  }
  return null;
}

export function firestoreRow(document) {
  return {
    name: document.name,
    data: Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, firestoreValue(value)])),
  };
}

export function pathSegments(name) {
  if (typeof name !== 'string') return [];
  const marker = '/documents/';
  const index = name.indexOf(marker);
  return (index === -1 ? name : name.slice(index + marker.length)).split('/').filter(Boolean);
}

function documentId(row) {
  const segments = pathSegments(row?.name || row?.document?.name || '');
  return segments.at(-1) || null;
}

function documentData(row) {
  return row?.data || {};
}

function rootCollectionRow(row, collection) {
  const segments = pathSegments(row?.name || '');
  return segments.length === 2 && segments[0] === collection ? row : null;
}

function childRow(row, collection, childCollection) {
  const segments = pathSegments(row?.name || '');
  if (segments.length !== 4 || segments[0] !== collection || segments[2] !== childCollection) return null;
  return { row, parentId: segments[1], childId: segments[3] };
}

function firestoreTimestampFilter(fieldPath, iso, op = 'GREATER_THAN_OR_EQUAL') {
  return { fieldFilter: { field: { fieldPath }, op, value: { timestampValue: iso } } };
}

function readRemoteConfigValue(template, name) {
  const value = template?.parameters?.[name]?.defaultValue?.value
    ?? template?.parameters?.[name]?.defaultValue
    ?? template?.parameters?.[name]?.value;
  return text(value) ? value : null;
}

async function resolvePostHogConfig(client) {
  let template = null;
  const read = async (envName, remoteName) => {
    if (text(process.env[envName])) return process.env[envName];
    template ||= await client.remoteConfig();
    return readRemoteConfigValue(template, remoteName);
  };
  const apiKey = await read('POSTHOG_PERSONAL_API_KEY', 'SERVER_POSTHOG_PERSONAL_API_KEY');
  const projectId = await read('POSTHOG_PROJECT_ID', 'SERVER_POSTHOG_PROJECT_ID');
  const host = await read('POSTHOG_HOST', 'SERVER_POSTHOG_HOST') || 'https://eu.posthog.com';
  if (!apiKey || !projectId) throw new Error('PostHog credentials are missing from env and Remote Config');
  return { apiKey, projectId, host };
}

function completeUtcWindow(now, days) {
  const endMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return {
    start: new Date(endMs - days * DAY_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

function rollingWindow(now, hours) {
  return {
    start: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    end: now.toISOString(),
  };
}

function postHogRow(response, name) {
  const columns = response?.columns || [];
  const row = response?.results?.[0];
  if (Array.isArray(row)) {
    const index = columns.indexOf(name);
    return index === -1 ? null : row[index];
  }
  return row?.[name] ?? null;
}

function nonNegativeInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`PostHog returned invalid ${label}`);
  return parsed;
}

export function buildL1TelemetryExport(input, {
  usefulSessions,
  errorFreeUsefulSessions,
  observedErrorEvents,
  generatedAt,
  telemetryWindow,
} = {}) {
  const meta = isObject(input?._meta) ? input._meta : {};
  return {
    ...(isObject(input) ? input : {}),
    generatedAt,
    usefulSessions,
    errorFreeUsefulSessions,
    observedErrorEvents,
    telemetryWindow,
    _meta: {
      ...meta,
      generatedAt,
      source: 'PostHog HogQL, read-only live export',
      purpose: 'Fresh useful-session/error-free-useful-session evidence for Loop L1',
      telemetryWindow,
    },
  };
}

export async function exportL1({ inputPath, outputPath, now = new Date(), days = DEFAULT_L1_WINDOW_DAYS, client = null, posthogRunner = runHogQL } = {}) {
  const firestore = client || new GoogleDataClient();
  const window = completeUtcWindow(now, days);
  const config = await resolvePostHogConfig(firestore);
  const sessionQuery = `
    SELECT count() AS usefulSessions, countIf(errorEvents = 0) AS errorFreeUsefulSessions
    FROM (
      SELECT $session_id,
        countIf(event IN ('$pageview', 'pageview')) AS pageViews,
        countIf(event IN ('app_error', 'exception', 'error_page_view')) AS errorEvents
      FROM events
      WHERE timestamp >= '${window.start}' AND timestamp < '${window.end}'
      GROUP BY $session_id
      HAVING pageViews > 0
    )`;
  const errorQuery = `
    SELECT count() AS observedErrorEvents
    FROM events
    WHERE timestamp >= '${window.start}' AND timestamp < '${window.end}'
      AND event IN ('app_error', 'exception', 'error_page_view')`;
  const [sessionResponse, errorResponse] = await Promise.all([
    posthogRunner(sessionQuery, config),
    posthogRunner(errorQuery, config),
  ]);
  const telemetry = buildL1TelemetryExport(JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')), {
    usefulSessions: nonNegativeInteger(postHogRow(sessionResponse, 'usefulSessions'), 'usefulSessions'),
    errorFreeUsefulSessions: nonNegativeInteger(postHogRow(sessionResponse, 'errorFreeUsefulSessions'), 'errorFreeUsefulSessions'),
    observedErrorEvents: nonNegativeInteger(postHogRow(errorResponse, 'observedErrorEvents'), 'observedErrorEvents'),
    generatedAt: now.toISOString(),
    telemetryWindow: window,
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(telemetry, null, 2)}\n`);
  return telemetry;
}

function eventSet(rows) {
  const result = new Map();
  for (const row of rows) {
    const data = documentData(row);
    const child = childRow(row, 'job_alert_subscribers', 'events');
    if (!child) continue;
    const messageId = String(first(data, ['message_id', 'messageId']) || '').trim();
    const type = String(first(data, ['event_type', 'eventType']) || '').trim().toLowerCase();
    if (!messageId || !type) continue;
    const key = `${child.parentId}\u0000${messageId}`;
    if (!result.has(key)) result.set(key, new Set());
    result.get(key).add(type);
  }
  return result;
}

function hasNonEmptyLinks(value) {
  if (Array.isArray(value)) return value.length > 0;
  return text(value);
}

function buildAlertKey(email, alertId) {
  return `${String(email || '').toLowerCase()}\u0000${String(alertId || '')}`;
}

function sendDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build an L4 ledger from already-read rows. All predicates are injected so
 * the aggregation can be tested without a Firebase connection; production
 * calls pass the canonical functions from functions/src.
 */
export function buildL4OutcomeLedger({
  alertRows = [],
  jobAlertRoots = [],
  newsletterRoots = [],
  deliveryRows = [],
  eventRows = [],
  snoozes = null,
  now = new Date(),
  window = rollingWindow(now, DEFAULT_L4_WINDOW_HOURS),
  predicates = {},
} = {}) {
  const evaluateConsent = predicates.evaluateJobAlertConsent
    || (({ alert }) => ({ allowed: alert?.backfilled_from ? false : true, reason: 'fallback' }));
  const crossChannelStop = predicates.isCrossChannelStop || (() => false);
  const jobAlertExcluded = predicates.isJobAlertExcluded || (() => false);
  const readVisit = predicates.readReturnVisitStamp || (() => null);
  const classifyVisit = predicates.classifyReturnVisit || (() => ({ returned: false }));
  const jobs = new Map();
  const newsletters = new Map();
  for (const row of jobAlertRoots) {
    const root = rootCollectionRow(row, 'job_alert_subscribers');
    if (root) jobs.set(String(documentId(root)).toLowerCase(), documentData(root));
  }
  for (const row of newsletterRoots) {
    const root = rootCollectionRow(row, 'newsletter_subscribers');
    if (root) newsletters.set(String(documentId(root)).toLowerCase(), documentData(root));
  }

  const eligibleAlerts = new Map();
  let consentChecked = true;
  let suppressedWithoutConsent = 0;
  for (const row of alertRows) {
    const child = childRow(row, 'job_alert_subscribers', 'alerts');
    if (!child) { consentChecked = false; continue; }
    const email = child.parentId.toLowerCase();
    const alert = documentData(row);
    if (alert.active !== true) continue;
    const newsletter = newsletters.get(email) || null;
    let consent;
    try {
      consent = evaluateConsent({ alert, subscriber: newsletter });
    } catch {
      consentChecked = false;
      consent = { allowed: false, reason: 'consent-evaluation-failed' };
    }
    if (!consent || consent.allowed !== true) suppressedWithoutConsent += 1;
    const eligible = alert.paused !== true
      && !crossChannelStop(newsletter)
      && !jobAlertExcluded(jobs.get(email)?.status)
      && consent?.allowed === true;
    if (eligible) eligibleAlerts.set(buildAlertKey(email, child.childId), { email, alertId: child.childId, alert });
  }

  const eligibleUsers = new Set([...eligibleAlerts.values()].map((alert) => alert.email));
  const events = eventSet(eventRows);
  const delivered = new Set();
  const opened = new Set();
  const clicked = new Set();
  const returnedUsers = new Set();
  const dedupGroups = new Map();
  let unattributedDeliveries = 0;
  let quietHoursEvidenceComplete = true;

  for (const row of deliveryRows) {
    const child = childRow(row, 'job_alert_subscribers', 'campaign_deliveries');
    if (!child) continue;
    const data = documentData(row);
    const scheduleFieldPresent = Object.prototype.hasOwnProperty.call(data, 'scheduled_for')
      || Object.prototype.hasOwnProperty.call(data, 'scheduledFor');
    const scheduleSourcePresent = Object.prototype.hasOwnProperty.call(data, 'send_time_source')
      || Object.prototype.hasOwnProperty.call(data, 'sendTimeSource');
    if (!scheduleFieldPresent || !scheduleSourcePresent) quietHoursEvidenceComplete = false;
    if (data.is_operator_verification === true || data.isOperatorVerification === true) continue;
    const email = child.parentId.toLowerCase();
    const alertId = String(first(data, ['campaign_id', 'campaignId']) || '').trim();
    const sentAt = toMillis(first(data, ['sent_at', 'sentAt']));
    const key = buildAlertKey(email, alertId);
    if (!alertId || sentAt == null || !eligibleAlerts.has(key)) {
      unattributedDeliveries += 1;
      continue;
    }
    const deliveryId = row.name || `${email}/${child.childId}`;
    const messageId = String(first(data, ['message_id', 'messageId']) || '').trim();
    const eventTypes = messageId ? (events.get(`${email}\u0000${messageId}`) || new Set()) : new Set();
    const deliveredEvidence = toMillis(first(data, ['delivered_at', 'deliveredAt'])) != null || eventTypes.has('delivered');
    const clickedEvidence = toMillis(first(data, ['clicked_at', 'clickedAt'])) != null
      || hasNonEmptyLinks(first(data, ['clicked_links', 'clickedLinks']))
      || eventTypes.has('click') || eventTypes.has('clicked');
    const openedEvidence = toMillis(first(data, ['opened_at', 'openedAt'])) != null
      || eventTypes.has('open') || eventTypes.has('opened') || clickedEvidence;
    if (deliveredEvidence) delivered.add(deliveryId);
    if (deliveredEvidence && openedEvidence) opened.add(deliveryId);
    if (deliveredEvidence && clickedEvidence) clicked.add(deliveryId);

    const group = `${email}\u0000${alertId}\u0000${sendDay(sentAt)}`;
    dedupGroups.set(group, (dedupGroups.get(group) || 0) + 1);

    const visit = readVisit(jobs.get(email));
    const classified = classifyVisit(visit);
    if (deliveredEvidence && classified?.returned === true && Number.isFinite(visit?.atMs)
        && visit.atMs >= sentAt && visit.atMs <= sentAt + 7 * DAY_MS) {
      returnedUsers.add(email);
    }
  }

  let duplicateSends = 0;
  for (const count of dedupGroups.values()) duplicateSends += Math.max(0, count - 1);
  const deferredAlerts = Object.values(snoozes?.snoozes || {})
    .filter((entry) => (toMillis(entry?.snoozedUntil) || 0) > now.getTime()).length;
  const deduplicationChecked = unattributedDeliveries === 0;
  const consentEvidenceComplete = consentChecked && unattributedDeliveries === 0;

  return {
    generatedAt: now.toISOString(),
    eligibleConsentedUsers: eligibleUsers.size,
    deliveredAlerts: delivered.size,
    openedAlerts: opened.size,
    clickedAlerts: clicked.size,
    returningUsers7d: returnedUsers.size,
    duplicateSends,
    consentViolations: 0,
    suppressedWithoutConsent,
    deferredAlerts,
    telemetryWindow: window,
    export: {
      schemaVersion: 1,
      aggregated: true,
      sourceRefs: [
        'firestore.job_alert_subscribers',
        'firestore.newsletter_subscribers',
        'firestore.campaign_deliveries',
        'firestore.events',
      ],
      consentChecked: consentEvidenceComplete,
      deduplicationChecked,
      quietHoursChecked: quietHoursEvidenceComplete,
      quietHoursEvidence: 'sender scheduled_for/send_time_source retained; exporter never schedules or sends',
      externalDeliveryUntouched: true,
      unattributedDeliveries,
      consentClassifier: 'functions/src/jobAlertBackfillCore.js',
      returnClassifier: 'functions/src/lib/returnVisit.js',
      deduplicationKey: 'recipient + alert id + UTC send day',
    },
  };
}

export async function exportL4({ configPath = null, snoozesPath = null, outputPath, now = new Date(), client = null, predicates = null } = {}) {
  const firestore = client || new GoogleDataClient();
  const window = rollingWindow(now, DEFAULT_L4_WINDOW_HOURS);
  const fields = [
    'active', 'paused', 'backfilled_from', 'backfilledFrom', 'consent_text', 'consentText',
    'consent_text_displayed', 'consentTextDisplayed', 'consent_act', 'consentAct',
    'consent_origin', 'consentOrigin', 'status', 'unsubscribed_at', 'unsubscribedAt',
    'resubscribed_at', 'resubscribedAt', 'last_site_visit_at', 'lastSiteVisitAt',
    'last_site_visit_uid', 'lastSiteVisitUid', 'last_site_visit_ua', 'lastSiteVisitUa',
    'last_site_visit_entry', 'lastSiteVisitEntry', 'last_site_visit_visible', 'lastSiteVisitVisible',
    'last_site_visit_prerender', 'lastSiteVisitPrerender', 'last_site_visit_ip', 'lastSiteVisitIp',
  ];
  const [alerts, jobs, newsletters, deliveries, events] = await Promise.all([
    firestore.runQuery({ collectionId: 'alerts', allDescendants: true, fieldPaths: fields }),
    firestore.runQuery({ collectionId: 'job_alert_subscribers', fieldPaths: fields }),
    firestore.runQuery({ collectionId: 'newsletter_subscribers', fieldPaths: fields }),
    firestore.runQuery({
      collectionId: 'campaign_deliveries',
      allDescendants: true,
      where: firestoreTimestampFilter('sent_at', window.start),
      fieldPaths: ['campaign_id', 'campaignId', 'message_id', 'messageId', 'is_operator_verification', 'isOperatorVerification', 'sent_at', 'sentAt', 'scheduled_for', 'scheduledFor', 'send_time_source', 'sendTimeSource', 'delivered_at', 'deliveredAt', 'opened_at', 'openedAt', 'clicked_at', 'clickedAt', 'clicked_links', 'clickedLinks'],
    }),
    firestore.runQuery({
      collectionId: 'events',
      allDescendants: true,
      where: firestoreTimestampFilter('timestamp', window.start),
      fieldPaths: ['event_type', 'eventType', 'message_id', 'messageId', 'timestamp', 'occurred_at', 'occurredAt'],
    }),
  ]);
  const consent = predicates || await Promise.all([
    import('../../functions/src/jobAlertBackfillCore.js'),
    import('../../functions/src/lib/emailSuppression.js'),
    import('../../functions/src/lib/returnVisit.js'),
  ]).then(([core, suppression, returns]) => ({
    evaluateJobAlertConsent: core.evaluateJobAlertConsent,
    isCrossChannelStop: suppression.isCrossChannelStop,
    isJobAlertExcluded: suppression.isJobAlertExcluded,
    readReturnVisitStamp: returns.readReturnVisitStamp,
    classifyReturnVisit: returns.classifyReturnVisit,
  }));
  const snoozes = snoozesPath && fs.existsSync(path.resolve(snoozesPath))
    ? JSON.parse(fs.readFileSync(path.resolve(snoozesPath), 'utf8'))
    : null;
  const outcome = buildL4OutcomeLedger({
    alertRows: alerts,
    jobAlertRoots: jobs,
    newsletterRoots: newsletters,
    deliveryRows: deliveries,
    eventRows: events,
    snoozes,
    now,
    window,
    predicates: consent,
  });
  outcome.export.configSource = configPath || 'data/alert-config.json';
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

function publisherId(row) {
  return String(documentData(row).publisherUid || documentData(row).publisher_uid || '').trim();
}

function companyKeyFor(row, publishersById) {
  const data = documentData(row);
  return String(
    data.companyKey
      || data.company?.companyKey
      || publishersById.get(String(data.publisherUid || '').trim())?.company?.companyKey
      || '',
  ).trim();
}

export function buildL9OutcomeLedger({ profiles, publisherRows = [], orderRows = [], jobRows = [], stripeEventRows = [], now = new Date(), window = rollingWindow(now, DEFAULT_L9_WINDOW_HOURS) } = {}) {
  const profileList = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
  const profileKeys = new Set(profileList.map((profile) => String(profile?.companyKey || '').trim()).filter(Boolean));
  const publishers = new Map();
  for (const row of publisherRows) {
    const root = rootCollectionRow(row, 'publishers');
    if (root) publishers.set(documentId(root), documentData(root));
  }
  const eligibleAccounts = new Set([...publishers.entries()]
    .filter(([, data]) => text(data.company?.companyKey || data.companyKey) || text(data.company?.name || data.name))
    .map(([id]) => id));
  const orders = orderRows.filter((row) => rootCollectionRow(row, 'orders'));
  const allCheckoutAccounts = new Set(orders.map(publisherId).filter(Boolean));
  const paidAccounts = new Set();
  const activeAccounts = new Set();
  let mrrRecognizedChf = 0;
  for (const row of orders) {
    const data = documentData(row);
    const id = publisherId(row);
    if (String(data.status || '').toLowerCase() === 'active') {
      if (id) activeAccounts.add(id);
      if (String(data.currency || 'CHF').toUpperCase() === 'CHF' && number(data.amountChf)) mrrRecognizedChf += data.amountChf;
      if (id) paidAccounts.add(id);
    }
  }

  const livePaidJobs = new Set();
  const freeProfileKeys = new Set();
  const paidProfileKeys = new Set();
  for (const row of jobRows) {
    if (!rootCollectionRow(row, 'publisher_jobs')) continue;
    const data = documentData(row);
    const id = publisherId(row);
    const status = String(data.status || '').toLowerCase();
    const tier = String(data.tier || '').toLowerCase();
    if (status === 'paid') {
      livePaidJobs.add(row.name || documentId(row));
      if (id) paidAccounts.add(id);
    }
    const key = companyKeyFor(row, publishers);
    if (!profileKeys.has(key)) continue;
    if (tier === 'free' && !paidProfileKeys.has(key)) freeProfileKeys.add(key);
    if (tier === 'sponsored' || tier === 'azienda') {
      paidProfileKeys.add(key);
      freeProfileKeys.delete(key);
    }
  }

  let renewals = 0;
  for (const row of stripeEventRows) {
    const root = rootCollectionRow(row, 'stripe_events');
    if (!root) continue;
    const data = documentData(root);
    const processedAt = toMillis(data.processedAt || data.processed_at);
    if (String(data.type || '').toLowerCase() === 'invoice.paid'
        && processedAt != null && processedAt >= Date.parse(window.start) && processedAt < Date.parse(window.end)) renewals += 1;
  }

  return {
    generatedAt: now.toISOString(),
    inventoryScope: {
      cohortKey: 'employer-profiles-v1',
      profileSource: 'data/employer-profiles.json',
      profileCount: profileList.length,
      profileGeneratedAt: profiles?._meta?.generatedAt || null,
    },
    eligibleEmployerAccounts: eligibleAccounts.size,
    profileViewAccounts: 0,
    leadAccounts: 0,
    checkoutStartAccounts: allCheckoutAccounts.size,
    paidActivations: paidAccounts.size,
    activeSubscriptions: activeAccounts.size,
    attachedJobs: livePaidJobs.size,
    renewals,
    freeProfiles: freeProfileKeys.size,
    sponsoredProfiles: paidProfileKeys.size,
    mrrRecognizedChf: Number(mrrRecognizedChf.toFixed(2)),
    telemetryWindow: window,
    export: {
      schemaVersion: 1,
      sourceRefs: ['firestore.publishers', 'firestore.orders', 'firestore.publisher_jobs', 'firestore.stripe_events'],
      accountIdentity: 'publisherUid',
      anonymousFunnelExcluded: true,
      anonymousFunnelReason: 'employer CTA analytics carries no publisherUid; profile views and leads are not promoted to accounts',
      profileMixSource: 'publisher_jobs tier joined to employer profile companyKey',
      inventoryUntouched: true,
      subscriptionStateUntouched: true,
      pricesUntouched: true,
      outreachSent: false,
      accountMetricWindow: 'current authoritative Firestore ledger; renewals use telemetryWindow',
    },
  };
}

export async function exportL9({ profilesPath, outputPath, now = new Date(), client = null } = {}) {
  const firestore = client || new GoogleDataClient();
  const profiles = JSON.parse(fs.readFileSync(path.resolve(profilesPath), 'utf8'));
  const window = rollingWindow(now, DEFAULT_L9_WINDOW_HOURS);
  const [publishers, orders, jobs, stripeEvents] = await Promise.all([
    firestore.runQuery({ collectionId: 'publishers', fieldPaths: ['company', 'companyKey', 'name'] }),
    firestore.runQuery({ collectionId: 'orders', fieldPaths: ['publisherUid', 'publisher_uid', 'status', 'amountChf', 'currency', 'createdAt', 'updatedAt'] }),
    firestore.runQuery({ collectionId: 'publisher_jobs', fieldPaths: ['publisherUid', 'publisher_uid', 'status', 'tier', 'paidAt', 'company', 'companyKey'] }),
    firestore.runQuery({ collectionId: 'stripe_events', where: firestoreTimestampFilter('processedAt', window.start), fieldPaths: ['type', 'processedAt', 'processed_at'] }),
  ]);
  const outcome = buildL9OutcomeLedger({ profiles, publisherRows: publishers, orderRows: orders, jobRows: jobs, stripeEventRows: stripeEvents, now, window });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

function valueAfter(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1] || fallback;
}

export async function main({ argv = process.argv.slice(2) } = {}) {
  const loop = valueAfter(argv, '--loop');
  const outputPath = valueAfter(argv, '--out');
  if (!['L1', 'L4', 'L9'].includes(loop)) throw new Error('--loop must be L1, L4 or L9');
  if (!outputPath) throw new Error('--out is required');
  const now = new Date();
  if (loop === 'L1') {
    const inputPath = valueAfter(argv, '--input', valueAfter(argv, '--telemetry', 'data/error-triage-baseline.json'));
    return exportL1({ inputPath, outputPath, now });
  }
  if (loop === 'L4') {
    return exportL4({
      configPath: valueAfter(argv, '--config', 'data/alert-config.json'),
      snoozesPath: valueAfter(argv, '--snoozes', 'data/alert-snoozes.json'),
      outputPath,
      now,
    });
  }
  return exportL9({
    profilesPath: valueAfter(argv, '--profiles', 'data/employer-profiles.json'),
    outputPath,
    now,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[outcome-export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
