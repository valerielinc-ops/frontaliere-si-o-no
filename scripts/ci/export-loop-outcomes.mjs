#!/usr/bin/env node

/**
 * Read-only outcome exporters for the site-only loop ledgers.
 *
 * The script deliberately uses Google REST APIs and the native Node runtime:
 * the loop workflows are sparse checkouts and must not install dependencies.
 * It never writes Firestore, sends mail, changes prices or edits inventory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
} from '../lib/ga4-service-account.mjs';

export const DEFAULT_L1_WINDOW_DAYS = 4;
export const DEFAULT_L5_WINDOW_DAYS = 8;
export const DEFAULT_L3_WINDOW_DAYS = 4;
export const L4_RETURN_WINDOW_DAYS = 7;
export const L4_GA4_LAG_DAYS = 2;
export const L4_DELIVERY_CONTRACT_VERSION = 1;
export const L4_DELIVERY_LOOKBACK_DAYS = L4_RETURN_WINDOW_DAYS + L4_GA4_LAG_DAYS + 1;
export const DEFAULT_L4_WINDOW_HOURS = L4_DELIVERY_LOOKBACK_DAYS * 24;
export const DEFAULT_L9_WINDOW_HOURS = 240;

/**
 * L4's return cohort is read from GA4's native session campaign dimension.
 * Job-alert links already emit `utm_campaign=alert_<alertId>`, so this
 * contract needs no custom dimension and does not depend on PostHog.
 */
export const L4_GA4_RETURN_CONTRACT = Object.freeze({
  dimension: 'sessionCampaignName',
  metric: 'totalUsers',
  campaignParameter: 'utm_campaign',
  campaignPrefix: 'alert_',
  returnWindowDays: L4_RETURN_WINDOW_DAYS,
  lagDays: L4_GA4_LAG_DAYS,
  source: 'GA4 Data API',
});

/**
 * The L5 export reads exact event-session counts from GA4. Firebase
 * Analytics receives the same decision-moment events as the application
 * mirror, while this read-only exporter avoids making PostHog quota or
 * retention the measurement gate. Keep the event contract explicit so the
 * validator and the application instrumentation cannot silently drift apart.
 *
 * No custom dimension is involved. The application sends the next-action
 * event to GA4 only after a completion in the same GA4 session
 * (`services/analytics.ts`, `logDecisionMoment`), so the sessions holding a
 * next action are a subset of the sessions holding a completion and GA4's
 * native `sessions` metric per event name is the whole measurement. A
 * session-key dimension would need one of the property's 50 EVENT-scoped
 * slots, which a monitor must never depend on.
 *
 * `nextActionGateEffectiveFrom` is the first GA4 calendar date on which the
 * gate is the only producer of next-action events. Earlier days hold events
 * sent without the gate (and bundles cached at the edge keep sending them for
 * a while after the deploy), so they are not a subset measurement and never
 * enter the window: the export starts at this date or stays unavailable.
 */
export const L5_DECISION_EVENT_CONTRACT = Object.freeze({
  completionEvent: 'decision_moment_completed',
  nextActionEvent: 'decision_moment_next_action',
  completionSurfaceProperty: 'decision_surface',
  completionTaskProperty: 'task_id',
  nextActionSurfaceProperty: 'decision_surface',
  nextActionIdProperty: 'action_id',
  nextActionGate: 'emitted only after a completion in the same GA4 session',
  nextActionGateEffectiveFrom: '2026-10-05',
  sessionMetric: 'sessions',
  source: 'GA4 Data API',
});

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

function authJwt(serviceAccount, scope = 'https://www.googleapis.com/auth/cloud-platform') {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope,
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
  constructor({
    serviceAccount = readServiceAccount(),
    fetchImpl = fetch,
    oauthScope = 'https://www.googleapis.com/auth/cloud-platform',
  } = {}) {
    this.serviceAccount = serviceAccount;
    this.fetchImpl = fetchImpl;
    this.oauthScope = oauthScope;
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
            assertion: authJwt(this.serviceAccount, this.oauthScope),
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

export function completeUtcWindow(now, days) {
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw new Error('days must be an integer between 1 and 31');
  }
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

export function postHogRow(response, name) {
  const columns = response?.columns || [];
  const row = response?.results?.[0];
  if (Array.isArray(row)) {
    const index = columns.indexOf(name);
    return index === -1 ? null : row[index];
  }
  return row?.[name] ?? null;
}

function isoDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(label + ' must be a valid date');
  return date.toISOString();
}

function writeJsonFile(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(value, null, 2) + '\n');
}

export function buildL5DecisionMomentExport({
  eligibleDecisionSessions,
  nextUsefulActions,
  generatedAt,
  telemetryWindow,
  eventContract = L5_DECISION_EVENT_CONTRACT,
} = {}) {
  const eligible = nonNegativeCount(eligibleDecisionSessions, 'eligibleDecisionSessions');
  const next = nonNegativeCount(nextUsefulActions, 'nextUsefulActions');
  // The client gate makes next-action sessions a subset of completion
  // sessions. A larger numerator means the gate is not what produced the
  // data, so the export must not be recorded as a measurement.
  if (next > eligible) throw new Error('GA4 returned nextUsefulActions greater than eligibleDecisionSessions');
  const generated = isoDate(generatedAt, 'L5 generatedAt');
  return {
    schemaVersion: 1,
    loopId: 'L5',
    generatedAt: generated,
    independent: true,
    eligibleDecisionSessions: eligible,
    nextUsefulActions: next,
    metrics: {
      eligibleDecisionSessions: eligible,
      nextUsefulActions: next,
    },
    telemetryWindow,
    scope: {
      denominator: 'distinct GA4 sessions with an explicit decision_moment_completed event',
      numerator: 'distinct GA4 sessions with an explicit decision_moment_next_action event, sent only after a completion in the same GA4 session',
      surface: 'declared decision surfaces',
    },
    evidence: {
      source: 'GA4 Data API exact event-session export',
      sourceRefs: ['decision-surfaces', 'ga4-decision-surface'],
      sessionMetric: eventContract.sessionMetric,
      settledWindow: true,
      eventContract: { ...eventContract },
    },
    export: {
      readOnly: true,
      publishedDataUntouched: true,
      noDarkPatterns: true,
      noUnsupportedTimingPromise: true,
      noInvasivePersonalization: true,
    },
    _meta: {
      generatedAt: generated,
      source: 'GA4 Data API exact event-session export',
      purpose: 'Fresh completed-task and next-useful-action evidence for Loop L5',
      telemetryWindow,
    },
  };
}

/**
 * Clamp the settled L5 window to the days on which the client gate was live.
 * A window that ends before the gate has no gated day at all: that is not a
 * measurement, so the caller records the outcome as unavailable.
 */
export function l5GatedDateRange(range, gateDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(gateDate ?? ''))) {
    throw new Error('L5 event contract requires nextActionGateEffectiveFrom as YYYY-MM-DD');
  }
  if (gateDate > range.endDate) {
    throw new Error(
      `L5 next-action gate is effective from ${gateDate}: the settled window ends ${range.endDate} and holds no gated day yet`,
    );
  }
  return {
    startDate: gateDate > range.startDate ? gateDate : range.startDate,
    endDate: range.endDate,
  };
}

export async function exportL5({
  outputPath,
  now = new Date(),
  days = DEFAULT_L5_WINDOW_DAYS,
  propertyId = null,
  client = null,
  eventContract = L5_DECISION_EVENT_CONTRACT,
} = {}) {
  const range = l5GatedDateRange(ga4DateRange(Number(days), 2, now), eventContract.nextActionGateEffectiveFrom);
  const analytics = client || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
  const counts = await fetchL5DecisionMomentCounts({
    client: analytics,
    startDate: range.startDate,
    endDate: range.endDate,
    propertyId,
    eventContract,
  });
  const outcome = buildL5DecisionMomentExport({
    eligibleDecisionSessions: counts.eligibleDecisionSessions,
    nextUsefulActions: counts.nextUsefulActions,
    generatedAt: now,
    telemetryWindow: { ...range, lagDays: 2, source: 'GA4 settled calendar dates' },
    eventContract,
  });
  writeJsonFile(outputPath, outcome);
  return outcome;
}

/**
 * L1 reads GA4 because PostHog product events are hard-stopped
 * (`POSTHOG_EVENT_SAMPLE_RATE = 0` in `services/posthogQuota.ts`): a HogQL
 * count of `$pageview` there succeeds and returns zero, which looks like a
 * real measurement. Every name below is a native GA4 event name, so the report
 * needs no custom dimension (the property's EVENT-scoped slots are full).
 *
 * `errorFreeUsefulSessions` is a declared LOWER BOUND: GA4 cannot intersect
 * two event filters on the same session without a session-key dimension, so
 * the export subtracts every session holding an error event from the useful
 * sessions. A session with an error but no `page_view` lowers the bound; it
 * can never raise it.
 */
export const L1_GA4_EVENT_CONTRACT = Object.freeze({
  usefulSessionEvent: 'page_view',
  errorEvents: Object.freeze(['app_error', 'exception', 'error_page_view']),
  sessionMetric: 'sessions',
  errorEventMetric: 'eventCount',
  method: 'errorFreeUsefulSessions = max(0, sessions with page_view - sessions with any error event); '
    + 'a lower bound, because an error session without page_view is subtracted too',
  source: 'GA4 Data API',
});

export function buildL1TelemetryExport(input, {
  usefulSessions,
  errorFreeUsefulSessions,
  observedErrorEvents,
  errorSessions = null,
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
    evidence: {
      source: 'GA4 Data API exact event-session export',
      sourceRefs: ['ga4-error-telemetry'],
      sessionMetric: L1_GA4_EVENT_CONTRACT.sessionMetric,
      eventFilters: {
        usefulSessions: L1_GA4_EVENT_CONTRACT.usefulSessionEvent,
        errorSessions: [...L1_GA4_EVENT_CONTRACT.errorEvents],
      },
      errorSessions,
      method: L1_GA4_EVENT_CONTRACT.method,
      errorFreeIsLowerBound: true,
      settledWindow: true,
    },
    _meta: {
      ...meta,
      generatedAt,
      source: 'GA4 Data API, read-only live export',
      purpose: 'Fresh useful-session/error-free-useful-session evidence for Loop L1',
      telemetryWindow,
    },
  };
}

/**
 * Keep a credential outage observable without turning it into a clean run.
 * The loop validator will classify the null session counts as partial and the
 * evidence recorder can still persist the fail-closed decision.
 */
export function buildUnavailableL1TelemetryExport({
  generatedAt = new Date().toISOString(),
  reason = 'read-only telemetry export unavailable',
} = {}) {
  return {
    generatedAt,
    usefulSessions: null,
    errorFreeUsefulSessions: null,
    observedErrorEvents: null,
    independent: false,
    export: {
      schemaVersion: 1,
      sourceRefs: ['ga4-error-telemetry'],
      readOnly: true,
      unavailable: true,
      mutationsPerformed: false,
    },
    _meta: {
      generatedAt,
      source: 'GA4 Data API, read-only live export unavailable',
      purpose: 'Explicit fail-closed placeholder for Loop L1',
      reason,
    },
  };
}

function l1ErrorSessionsBody({ startDate, endDate, errorEvents = L1_GA4_EVENT_CONTRACT.errorEvents }) {
  return {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: L1_GA4_EVENT_CONTRACT.sessionMetric }, { name: L1_GA4_EVENT_CONTRACT.errorEventMetric }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: [...errorEvents], caseSensitive: true },
      },
    },
    limit: 1,
  };
}

/**
 * Read the two L1 totals from one settled GA4 window: sessions holding a
 * `page_view`, and sessions/events holding any error event. Both reports go
 * through the exact-total reader, so a thresholded, sampled or multi-row
 * report fails the export instead of becoming a measured rate.
 */
export async function fetchL1SessionCounts({ client, startDate, endDate, propertyId } = {}) {
  if (!text(startDate) || !text(endDate)) {
    throw new Error('L1 GA4 report requires startDate and endDate');
  }
  const report = (body) => client.request(
    `https://analyticsdata.googleapis.com/v1beta/${normalizeGa4PropertyId(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const [usefulReport, errorReport] = await Promise.all([
    report(ga4EventSessionsBody({ eventName: L1_GA4_EVENT_CONTRACT.usefulSessionEvent, startDate, endDate })),
    report(l1ErrorSessionsBody({ startDate, endDate })),
  ]);
  const [usefulValue] = exactGa4TotalMetricValues(usefulReport, 'GA4 L1 report for page_view', 1);
  const [errorSessionsValue, errorEventsValue] = exactGa4TotalMetricValues(errorReport, 'GA4 L1 report for error events', 2);
  const usefulSessions = nonNegativeCount(usefulValue, 'sessions for page_view');
  const errorSessions = nonNegativeCount(errorSessionsValue, 'sessions for error events');
  const observedErrorEvents = nonNegativeCount(errorEventsValue, 'eventCount for error events');
  return {
    usefulSessions,
    errorSessions,
    observedErrorEvents,
    errorFreeUsefulSessions: Math.max(0, usefulSessions - errorSessions),
  };
}

/**
 * Export L1's useful-session outcome from GA4 without writing GA4, Firestore
 * or published data. Same settled two-day window as L3 and L5.
 */
export async function exportL1({ inputPath, outputPath, now = new Date(), days = DEFAULT_L1_WINDOW_DAYS, propertyId = null, client = null } = {}) {
  const analytics = client || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
  const range = ga4DateRange(days, 2, now);
  const counts = await fetchL1SessionCounts({ client: analytics, ...range, propertyId });
  const telemetry = buildL1TelemetryExport(JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')), {
    usefulSessions: counts.usefulSessions,
    errorFreeUsefulSessions: counts.errorFreeUsefulSessions,
    observedErrorEvents: counts.observedErrorEvents,
    errorSessions: counts.errorSessions,
    generatedAt: now.toISOString(),
    telemetryWindow: { ...range, lagDays: 2, source: 'GA4 settled calendar dates' },
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(telemetry, null, 2)}\n`);
  return telemetry;
}

export function buildUnavailableL5DecisionMomentExport({
  generatedAt = new Date().toISOString(),
  reason = 'read-only decision-moment export unavailable',
} = {}) {
  return {
    generatedAt,
    independent: false,
    eligibleDecisionSessions: null,
    nextUsefulActions: null,
    evidence: {
      source: 'GA4 Data API read-only export unavailable',
      sourceRefs: ['decision-surfaces', 'ga4-decision-surface'],
      sessionMetric: L5_DECISION_EVENT_CONTRACT.sessionMetric,
      eventContract: { ...L5_DECISION_EVENT_CONTRACT },
    },
    export: {
      schemaVersion: 1,
      purpose: 'L5 decision-moment outcome',
      readOnly: true,
      publishedDataUntouched: true,
      unavailable: true,
    },
    _meta: {
      generatedAt,
      source: 'GA4 Data API read-only export unavailable',
      purpose: 'Explicit fail-closed placeholder; never a measured outcome',
      reason,
    },
  };
}

function normalizeGa4PropertyId(raw) {
  const value = raw || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  return value.startsWith('properties/') ? value : `properties/${value}`;
}

function ga4EventSessionsBody({ eventName, startDate, endDate }) {
  return {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: 'sessions' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { value: eventName, matchType: 'EXACT' },
      },
    },
    limit: 1,
  };
}

function nonNegativeCount(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`GA4 returned invalid ${label}`);
  return parsed;
}

/** Read one exact GA4 event-session count without mutating the source. */
export async function fetchGa4EventSessions({ client, eventName, startDate, endDate, propertyId, bodyBuilder = ga4EventSessionsBody } = {}) {
  const data = await client.request(
    `https://analyticsdata.googleapis.com/v1beta/${normalizeGa4PropertyId(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyBuilder({ eventName, startDate, endDate })),
    },
  );
  const value = data?.rows?.[0]?.metricValues?.[0]?.value ?? 0;
  return nonNegativeCount(value, `sessions for ${eventName}`);
}

/**
 * Read one exact L5 event-session count. Unlike the generic reader this one
 * refuses a thresholded, sampled or multi-row report: L5 publishes the number
 * as an independent measurement, so an approximated total is not evidence.
 */
export async function fetchL5EventSessions({ client, eventName, startDate, endDate, propertyId } = {}) {
  if (!text(eventName) || !text(startDate) || !text(endDate)) {
    throw new Error('L5 decision-moment report requires eventName, startDate and endDate');
  }
  const report = await client.request(
    `https://analyticsdata.googleapis.com/v1beta/${normalizeGa4PropertyId(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ga4EventSessionsBody({ eventName, startDate, endDate })),
    },
  );
  const [value] = exactGa4TotalMetricValues(report, `GA4 L5 report for ${eventName}`, 1);
  return nonNegativeCount(value, `sessions for ${eventName}`);
}

/**
 * Return the metric values of a dimensionless GA4 total, refusing any report
 * that is thresholded, sampled, folded into "(other)" or split into rows:
 * loop monitors publish these numbers as independent measurements.
 */
function exactGa4TotalMetricValues(report, label, metricCount) {
  const metadata = report?.metadata || {};
  if (
    metadata.subjectToThresholding
    || metadata.dataLossFromOtherRow
    || (Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0)
  ) {
    throw new Error(`${label} is incomplete or thresholded`);
  }
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  if (rows.length > 1) {
    throw new Error(`${label} returned ${rows.length} rows for a dimensionless total`);
  }
  // GA4 omits the row entirely when the event never occurred in the window.
  if (rows.length === 0) return Array.from({ length: metricCount }, () => 0);
  const metricValues = Array.isArray(rows[0]?.metricValues) ? rows[0].metricValues : [];
  if (metricValues.length !== metricCount) {
    throw new Error(`${label} returned ${metricValues.length} metric values, expected ${metricCount}`);
  }
  return metricValues.map((metric) => metric?.value ?? 0);
}

function l4Ga4ReturnBody({ startDate, endDate, campaignNames }) {
  return {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: L4_GA4_RETURN_CONTRACT.metric }],
    dimensionFilter: {
      filter: {
        fieldName: L4_GA4_RETURN_CONTRACT.dimension,
        inListFilter: { values: [...campaignNames], caseSensitive: true },
      },
    },
    limit: 1,
  };
}

/**
 * Read one settled, unique-user GA4 return total for the mature alert cohort.
 * The campaign names are the exact values emitted by the alert UTM producer;
 * filtering them before asking for `totalUsers` keeps one user counted once
 * even when that user received more than one alert in the cohort.
 */
export async function fetchL4ReturnUsers({
  client,
  startDate,
  endDate,
  campaignNames = [],
  propertyId = null,
} = {}) {
  if (!text(startDate) || !text(endDate)) throw new Error('L4 GA4 return report requires startDate and endDate');
  const names = [...new Set(campaignNames.map((name) => String(name || '').trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('L4 GA4 return report requires at least one campaign name');
  const report = await client.request(
    `https://analyticsdata.googleapis.com/v1beta/${normalizeGa4PropertyId(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l4Ga4ReturnBody({ startDate, endDate, campaignNames: names })),
    },
  );
  const [value] = exactGa4TotalMetricValues(report, 'GA4 L4 return report', 1);
  return nonNegativeCount(value, 'totalUsers for L4 return cohort');
}

export function buildL3OutcomeExport({
  eligibleJobSessions,
  validHandoffs,
  generatedAt,
  telemetryWindow,
} = {}) {
  return {
    generatedAt,
    independent: true,
    eligibleJobSessions,
    validHandoffs,
    telemetryWindow,
    evidence: {
      source: 'GA4 Data API exact event-session export joined with L3 crawler summaries',
      sourceRefs: ['job-crawler-summaries', 'application-handoff'],
      sessionMetric: 'distinct GA4 sessions',
      eventFilters: {
        eligibleJobSessions: 'job_qualified_session',
        validHandoffs: 'job_apply_handoff',
      },
      settledWindow: true,
    },
    export: {
      schemaVersion: 1,
      sourceRefs: ['ga4.job_qualified_session', 'ga4.job_apply_handoff'],
      handoffIsNotApplication: true,
      applicationSubmissionSource: 'not available from site telemetry',
      publishedDataUntouched: true,
      readOnly: true,
    },
  };
}

/** Explicitly unavailable L3 input; never a zero application or handoff rate. */
export function buildUnavailableL3OutcomeExport({
  generatedAt = new Date().toISOString(),
  reason = 'read-only application-handoff export unavailable',
} = {}) {
  return {
    generatedAt,
    independent: false,
    eligibleJobSessions: null,
    validHandoffs: null,
    applications: null,
    evidence: {
      source: 'GA4 Data API read-only export unavailable',
      sourceRefs: ['job-crawler-summaries', 'application-handoff'],
      status: 'unavailable',
    },
    export: {
      schemaVersion: 1,
      sourceRefs: ['ga4.job_qualified_session', 'ga4.job_apply_handoff'],
      handoffIsNotApplication: true,
      publishedDataUntouched: true,
      readOnly: true,
      unavailable: true,
      mutationsPerformed: false,
    },
    _meta: {
      generatedAt,
      source: 'GA4 Data API read-only export unavailable',
      purpose: 'Explicit fail-closed placeholder for Loop L3',
      reason,
    },
  };
}

/**
 * Export L3's independent outcome from GA4 without writing GA4, Firestore,
 * job records or published corpus data. The two event counts are queried
 * independently with exact event filters and a two-day settled window.
 */
export async function exportL3({ outputPath, now = new Date(), days = DEFAULT_L3_WINDOW_DAYS, propertyId = null, client = null } = {}) {
  const analytics = client || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
  const range = ga4DateRange(days, 2, now);
  const [eligibleJobSessions, validHandoffs] = await Promise.all([
    fetchGa4EventSessions({ client: analytics, eventName: 'job_qualified_session', ...range, propertyId }),
    fetchGa4EventSessions({ client: analytics, eventName: 'job_apply_handoff', ...range, propertyId }),
  ]);
  const outcome = buildL3OutcomeExport({
    eligibleJobSessions,
    validHandoffs,
    generatedAt: now.toISOString(),
    telemetryWindow: { ...range, lagDays: 2, source: 'GA4 settled calendar dates' },
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

/**
 * Read the two L5 event-session counts from the same settled GA4 window.
 * Each report is filtered on one exact event name; no join is needed because
 * the application only sends the next-action event inside a session that
 * already holds a completion.
 */
export async function fetchL5DecisionMomentCounts({
  client,
  startDate,
  endDate,
  propertyId = null,
  eventContract = L5_DECISION_EVENT_CONTRACT,
} = {}) {
  const [eligibleDecisionSessions, nextUsefulActions] = await Promise.all([
    fetchL5EventSessions({ client, eventName: eventContract.completionEvent, startDate, endDate, propertyId }),
    fetchL5EventSessions({ client, eventName: eventContract.nextActionEvent, startDate, endDate, propertyId }),
  ]);
  return { eligibleDecisionSessions, nextUsefulActions };
}

// Event types that prove a message reached the inbox, grouped by what they
// prove. An open or a click cannot happen on an undelivered message.
const L4_EVIDENCE_CLASS = Object.freeze({
  delivered: 'delivered',
  open: 'open',
  opened: 'open',
  click: 'click',
  clicked: 'click',
});
// Recipient-window join bounds (#8409): the webhook may store a provider id
// that differs from the reference saved at send time, so an event of the same
// recipient and provider is accepted shortly after the send.
const L4_RECIPIENT_WINDOW_BEFORE_MS = 60_000;
const L4_RECIPIENT_WINDOW_AFTER_MS = 72 * 3_600_000;

function normalizedProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function eventSet(rows) {
  const byMessage = new Map();
  const byRecipient = new Map();
  for (const row of rows) {
    const data = documentData(row);
    const child = childRow(row, 'job_alert_subscribers', 'events');
    if (!child) continue;
    const email = child.parentId.toLowerCase();
    const messageId = String(first(data, ['message_id', 'messageId']) || '').trim();
    const type = String(first(data, ['event_type', 'eventType']) || '').trim().toLowerCase();
    if (!type) continue;
    if (messageId) {
      const key = `${email}\u0000${messageId}`;
      if (!byMessage.has(key)) byMessage.set(key, new Set());
      byMessage.get(key).add(type);
    }
    const evidenceClass = L4_EVIDENCE_CLASS[type];
    // Fall through to the next field when one is present but unparseable,
    // so an empty occurred_at still uses the server timestamp.
    const occurredAtMs = toMillis(data.occurred_at) ?? toMillis(data.occurredAt) ?? toMillis(data.timestamp);
    if (!evidenceClass || occurredAtMs == null) continue;
    if (!byRecipient.has(email)) byRecipient.set(email, []);
    byRecipient.get(email).push({
      messageKey: messageId ? `${email}\u0000${messageId}` : null,
      evidenceClass,
      provider: normalizedProvider(data.provider),
      occurredAtMs,
      consumed: false,
    });
  }
  for (const list of byRecipient.values()) list.sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  return { byMessage, byRecipient };
}

/**
 * Claim, for one delivery, the earliest unconsumed event of each evidence
 * class sent to the same recipient by the same provider inside the window.
 * Events already joined by message id to some delivery are never reused, and
 * a claimed event cannot support a second delivery.
 */
function claimRecipientWindowEvidence({ events, email, provider, sentAt, idJoinedKeys }) {
  const claimed = new Set();
  const list = events.byRecipient.get(email) || [];
  for (const event of list) {
    if (event.occurredAtMs > sentAt + L4_RECIPIENT_WINDOW_AFTER_MS) break;
    if (event.consumed || claimed.has(event.evidenceClass)) continue;
    if (event.occurredAtMs < sentAt - L4_RECIPIENT_WINDOW_BEFORE_MS) continue;
    if (event.messageKey && idJoinedKeys.has(event.messageKey)) continue;
    if (provider && event.provider && provider !== event.provider) continue;
    event.consumed = true;
    claimed.add(event.evidenceClass);
  }
  return claimed;
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
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

function readDeliveryConsentEvidence(data, sentAt) {
  const checked = first(data, ['consent_checked', 'consentChecked']);
  const allowed = first(data, ['consent_allowed', 'consentAllowed']);
  // `false/false` was the legacy shape written when the sender had no
  // consentProof at all. Only a recorded check that explicitly denied consent
  // is a refusal; everything else without a valid allow proof is missing.
  if (checked === true && allowed === false) return { status: 'refused' };
  const checkedAt = toMillis(first(data, ['consent_checked_at', 'consentCheckedAt']));
  const version = Number(first(data, ['outcome_contract_version', 'outcomeContractVersion']));
  const basis = first(data, ['consent_basis', 'consentBasis']);
  const clockSkewMs = 5 * 60_000;
  if (
    checked === true
    && allowed === true
    && version === L4_DELIVERY_CONTRACT_VERSION
    && checkedAt != null
    && checkedAt <= sentAt + clockSkewMs
    && text(basis)
  ) return { status: 'valid', checkedAt, basis: String(basis).trim() };
  return { status: 'missing' };
}

function buildL4ReturnCohort(attributed, delivered, now) {
  const deliveredAttributed = attributed.filter((delivery) => delivered.has(delivery.deliveryId));
  const maturityMs = (L4_RETURN_WINDOW_DAYS + L4_GA4_LAG_DAYS) * DAY_MS;
  const settledBefore = now.getTime() - maturityMs;
  const mature = deliveredAttributed.filter((delivery) => delivery.sentAt <= settledBefore);
  const pending = deliveredAttributed.filter((delivery) => delivery.sentAt > settledBefore);
  const campaignNames = [...new Set(mature.map((delivery) => `${L4_GA4_RETURN_CONTRACT.campaignPrefix}${delivery.alertId}`))].sort();
  const cohortStartMs = mature.length > 0 ? Math.min(...mature.map((delivery) => delivery.sentAt)) : null;
  const cohortEndMs = mature.length > 0
    ? Math.max(...mature.map((delivery) => delivery.sentAt + L4_RETURN_WINDOW_DAYS * DAY_MS))
    : null;
  const insufficientUntilMs = pending.length > 0
    ? Math.min(...pending.map((delivery) => delivery.sentAt + maturityMs))
    : null;
  return {
    campaignNames,
    cohortStartDate: cohortStartMs == null ? null : sendDay(cohortStartMs),
    cohortEndDate: cohortEndMs == null ? null : sendDay(cohortEndMs),
    insufficientUntil: insufficientUntilMs == null ? null : new Date(insufficientUntilMs).toISOString(),
    matureDeliveryRows: mature.length,
    pendingDeliveryRows: pending.length,
    status: campaignNames.length > 0 ? 'ready' : 'insufficient',
  };
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
  ga4ReturnUsers7d = null,
} = {}) {
  const evaluateConsent = predicates.evaluateJobAlertConsent
    || (({ alert }) => ({ allowed: alert?.backfilled_from ? false : true, reason: 'fallback' }));
  const crossChannelStop = predicates.isCrossChannelStop || (() => false);
  const jobAlertExcluded = predicates.isJobAlertExcluded || (() => false);
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
  // Every alert row read, consented or not: tells a delivery whose alert row
  // is gone apart from one whose alert exists but has no consent.
  const knownAlertKeys = new Set();
  let consentChecked = true;
  let suppressedWithoutConsent = 0;
  for (const row of alertRows) {
    const child = childRow(row, 'job_alert_subscribers', 'alerts');
    if (!child) { consentChecked = false; continue; }
    const email = child.parentId.toLowerCase();
    const alert = documentData(row);
    const newsletter = newsletters.get(email) || null;
    let consent;
    try {
      consent = evaluateConsent({ alert, subscriber: newsletter });
    } catch {
      consentChecked = false;
      consent = { allowed: false, reason: 'consent-evaluation-failed' };
    }
    const alertKey = buildAlertKey(email, child.childId);
    knownAlertKeys.add(alertKey);
    if (alert.active !== true) continue;
    if (!consent || consent.allowed !== true) suppressedWithoutConsent += 1;
    const eligible = alert.paused !== true
      && !crossChannelStop(newsletter)
      && !jobAlertExcluded(jobs.get(email)?.status)
      && consent?.allowed === true;
    if (eligible) eligibleAlerts.set(alertKey, { email, alertId: child.childId, alert });
  }

  const eligibleUsers = new Set([...eligibleAlerts.values()].map((alert) => alert.email));
  const events = eventSet(eventRows);
  const delivered = new Set();
  const opened = new Set();
  const clicked = new Set();
  const dedupGroups = new Map();
  let deduplicationLedgerComplete = true;
  let unattributedDeliveries = 0;
  const unattributedDeliveryReasons = {
    missingAlertId: 0,
    missingSentAt: 0,
    consentNotAllowed: 0,
    missingConsentEvidence: 0,
    noConsentedAlert: 0,
  };
  // Diagnostic split for rows whose alert id cannot be proven against the
  // consent/delivery ledger. It never attributes a row.
  const noConsentedAlertCauses = {
    alertRowMissing: 0,
    consentNotAllowed: 0,
    missingConsentEvidence: 0,
  };
  let quietHoursEvidenceComplete = true;
  let deliveryRowCount = 0;
  const deliveryRowsByProvider = {};
  const deliveredByProvider = {};
  const unattributedDeliveryShapes = {};
  const deliveryEvidenceByJoin = {
    deliveredAt: 0,
    messageId: 0,
    recipientWindow: 0,
    impliedByEngagement: 0,
    none: 0,
  };
  const attributed = [];
  let consentViolations = 0;
  // Message keys of every delivery row, operator-verification and unattributed
  // rows included: their id-joined events must not be claimed by the
  // recipient-window join of an attributed delivery.
  const deliveryMessageKeys = new Set();

  for (const row of deliveryRows) {
    const child = childRow(row, 'job_alert_subscribers', 'campaign_deliveries');
    if (!child) continue;
    const data = documentData(row);
    const rowMessageId = String(first(data, ['message_id', 'messageId']) || '').trim();
    const messageKey = rowMessageId ? `${child.parentId.toLowerCase()}\u0000${rowMessageId}` : null;
    if (messageKey) deliveryMessageKeys.add(messageKey);
    const scheduleFieldPresent = Object.prototype.hasOwnProperty.call(data, 'scheduled_for')
      || Object.prototype.hasOwnProperty.call(data, 'scheduledFor');
    const scheduleSourcePresent = Object.prototype.hasOwnProperty.call(data, 'send_time_source')
      || Object.prototype.hasOwnProperty.call(data, 'sendTimeSource');
    if (!scheduleFieldPresent || !scheduleSourcePresent) quietHoursEvidenceComplete = false;
    if (data.is_operator_verification === true || data.isOperatorVerification === true) continue;
    const provider = normalizedProvider(data.provider);
    deliveryRowCount += 1;
    incrementCount(deliveryRowsByProvider, provider || 'unknown');
    const email = child.parentId.toLowerCase();
    const alertId = String(first(data, ['campaign_id', 'campaignId']) || '').trim();
    const sentAt = toMillis(first(data, ['sent_at', 'sentAt']));
    const key = buildAlertKey(email, alertId);
    const consentEvidence = sentAt == null ? { status: 'missing' } : readDeliveryConsentEvidence(data, sentAt);
    const knownAlert = knownAlertKeys.has(key);

    // Deduplication is a delivery-ledger invariant, independent of whether
    // the same row can be attributed to a consented alert. Record every
    // keyable delivery before the consent gate below.
    if (!alertId || sentAt == null) {
      deduplicationLedgerComplete = false;
    } else {
      const group = `${email}\u0000${alertId}\u0000${sendDay(sentAt)}`;
      dedupGroups.set(group, (dedupGroups.get(group) || 0) + 1);
    }

    if (!alertId || sentAt == null || !knownAlert || consentEvidence.status !== 'valid') {
      unattributedDeliveries += 1;
      // Shape only (id length), never the id itself: enough to tell an alert
      // id from an id of another nature without exporting identifiers.
      incrementCount(unattributedDeliveryShapes, String(alertId.length));
      if (!alertId) unattributedDeliveryReasons.missingAlertId += 1;
      else if (sentAt == null) unattributedDeliveryReasons.missingSentAt += 1;
      else if (!knownAlert) {
        unattributedDeliveryReasons.noConsentedAlert += 1;
        noConsentedAlertCauses.alertRowMissing += 1;
      } else if (consentEvidence.status === 'refused') {
        consentViolations += 1;
        unattributedDeliveryReasons.consentNotAllowed += 1;
        noConsentedAlertCauses.consentNotAllowed += 1;
      } else {
        unattributedDeliveryReasons.missingConsentEvidence += 1;
        noConsentedAlertCauses.missingConsentEvidence += 1;
      }
      continue;
    }
    const deliveryId = row.name || `${email}/${child.childId}`;
    attributed.push({ deliveryId, data, email, alertId, sentAt, provider, messageKey, consentEvidence });
  }

  // Events joined by message id belong to their delivery row (attributed or
  // not) and are never offered to the recipient-window join of another one.
  const idJoinedKeys = new Set([...deliveryMessageKeys]
    .filter((messageKey) => events.byMessage.has(messageKey)));
  // Oldest send first, so each window event is claimed by the earliest
  // delivery it can belong to.
  attributed.sort((a, b) => a.sentAt - b.sentAt || (a.deliveryId < b.deliveryId ? -1 : a.deliveryId > b.deliveryId ? 1 : 0));

  for (const { deliveryId, data, email, sentAt, provider, messageKey } of attributed) {
    const eventTypes = messageKey ? (events.byMessage.get(messageKey) || new Set()) : new Set();
    const windowClasses = eventTypes.size === 0
      ? claimRecipientWindowEvidence({ events, email, provider, sentAt, idJoinedKeys })
      : new Set();
    const deliveredAtEvidence = toMillis(first(data, ['delivered_at', 'deliveredAt'])) != null;
    const clickedEvidence = toMillis(first(data, ['clicked_at', 'clickedAt'])) != null
      || hasNonEmptyLinks(first(data, ['clicked_links', 'clickedLinks']))
      || eventTypes.has('click') || eventTypes.has('clicked')
      || windowClasses.has('click');
    const openedEvidence = toMillis(first(data, ['opened_at', 'openedAt'])) != null
      || eventTypes.has('open') || eventTypes.has('opened') || windowClasses.has('open')
      || clickedEvidence;
    // An open or a click implies the message was delivered.
    const deliveredEvidence = deliveredAtEvidence || eventTypes.has('delivered')
      || windowClasses.size > 0 || openedEvidence;
    let join = 'none';
    if (deliveredAtEvidence) join = 'deliveredAt';
    else if (eventTypes.has('delivered')) join = 'messageId';
    else if (windowClasses.size > 0) join = 'recipientWindow';
    else if (openedEvidence) join = 'impliedByEngagement';
    deliveryEvidenceByJoin[join] += 1;
    if (deliveredEvidence && !delivered.has(deliveryId)) {
      delivered.add(deliveryId);
      incrementCount(deliveredByProvider, provider || 'unknown');
    }
    if (deliveredEvidence && openedEvidence) opened.add(deliveryId);
    if (deliveredEvidence && clickedEvidence) clicked.add(deliveryId);
  }

  let duplicateSends = 0;
  for (const count of dedupGroups.values()) duplicateSends += Math.max(0, count - 1);
  const deferredAlerts = Object.values(snoozes?.snoozes || {})
    .filter((entry) => (toMillis(entry?.snoozedUntil) || 0) > now.getTime()).length;
  const returnCohort = buildL4ReturnCohort(attributed, delivered, now);
  const measuredReturningUsers = ga4ReturnUsers7d == null || returnCohort.status !== 'ready'
    ? null
    : nonNegativeCount(ga4ReturnUsers7d, 'returningUsers7d');
  const deduplicationChecked = deduplicationLedgerComplete && duplicateSends === 0;
  const consentEvidenceComplete = consentChecked && unattributedDeliveries === 0;
  const returnMeasurement = measuredReturningUsers == null
    ? {
      status: 'insufficient',
      source: L4_GA4_RETURN_CONTRACT.source,
      dimension: L4_GA4_RETURN_CONTRACT.dimension,
      metric: L4_GA4_RETURN_CONTRACT.metric,
      cohortStartDate: returnCohort.cohortStartDate,
      cohortEndDate: returnCohort.cohortEndDate,
      insufficientUntil: returnCohort.insufficientUntil,
      reason: returnCohort.status === 'ready'
        ? 'GA4 return report has not been read for the mature cohort'
        : 'no settled consented delivery cohort is available',
    }
    : {
      status: 'observed',
      source: L4_GA4_RETURN_CONTRACT.source,
      dimension: L4_GA4_RETURN_CONTRACT.dimension,
      metric: L4_GA4_RETURN_CONTRACT.metric,
      campaignParameter: L4_GA4_RETURN_CONTRACT.campaignParameter,
      cohortStartDate: returnCohort.cohortStartDate,
      cohortEndDate: returnCohort.cohortEndDate,
      matureDeliveryRows: returnCohort.matureDeliveryRows,
      returningUsers7d: measuredReturningUsers,
    };

  const outcome = {
    generatedAt: now.toISOString(),
    eligibleConsentedUsers: eligibleUsers.size,
    deliveredAlerts: delivered.size,
    openedAlerts: opened.size,
    clickedAlerts: clicked.size,
    returningUsers7d: measuredReturningUsers,
    duplicateSends,
    consentViolations,
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
        'ga4-alert-return',
      ],
      consentChecked: consentEvidenceComplete,
      deduplicationChecked,
      quietHoursChecked: quietHoursEvidenceComplete,
      quietHoursEvidence: 'sender scheduled_for/send_time_source retained; exporter never schedules or sends',
      externalDeliveryUntouched: true,
      unattributedDeliveries,
      unattributedDeliveryReasons,
      noConsentedAlertCauses,
      unattributedDeliveryShapes,
      deliveryRows: deliveryRowCount,
      deliveryRowsByProvider,
      deliveredByProvider,
      deliveryEvidenceByJoin,
      deliveryEvidenceJoin: deliveryRowCount === 0 ? 'no-deliveries' : (delivered.size === 0 ? 'empty' : 'joined'),
      consentClassifier: 'functions/src/jobAlertBackfillCore.js',
      returnMeasurement,
      returnClassifier: 'GA4 sessionCampaignName filtered by utm_campaign=alert_<alertId>',
      deduplicationKey: 'recipient + alert id + UTC send day',
    },
  };
  Object.defineProperty(outcome, '_returnCohort', { value: returnCohort, enumerable: false });
  return outcome;
}

export async function exportL4({
  configPath = null,
  snoozesPath = null,
  outputPath,
  now = new Date(),
  client = null,
  analyticsClient = null,
  propertyId = null,
  predicates = null,
} = {}) {
  const firestore = client || new GoogleDataClient();
  const window = rollingWindow(now, DEFAULT_L4_WINDOW_HOURS);
  const fields = [
    'active', 'paused', 'backfilled_from', 'backfilledFrom', 'consent_given', 'consentGiven', 'consent_text', 'consentText',
    'consent_text_displayed', 'consentTextDisplayed', 'consent_act', 'consentAct',
    'consent_origin', 'consentOrigin', 'status', 'unsubscribed_at', 'unsubscribedAt',
    'resubscribed_at', 'resubscribedAt',
  ];
  const [alerts, jobs, newsletters, deliveries, events] = await Promise.all([
    firestore.runQuery({ collectionId: 'alerts', allDescendants: true, fieldPaths: fields }),
    firestore.runQuery({ collectionId: 'job_alert_subscribers', fieldPaths: fields }),
    firestore.runQuery({ collectionId: 'newsletter_subscribers', fieldPaths: fields }),
    firestore.runQuery({
      collectionId: 'campaign_deliveries',
      allDescendants: true,
      where: firestoreTimestampFilter('sent_at', window.start),
      fieldPaths: ['campaign_id', 'campaignId', 'message_id', 'messageId', 'is_operator_verification', 'isOperatorVerification', 'sent_at', 'sentAt', 'scheduled_for', 'scheduledFor', 'send_time_source', 'sendTimeSource', 'consent_checked', 'consentChecked', 'consent_allowed', 'consentAllowed', 'consent_basis', 'consentBasis', 'consent_checked_at', 'consentCheckedAt', 'outcome_contract_version', 'outcomeContractVersion', 'delivered_at', 'deliveredAt', 'opened_at', 'openedAt', 'clicked_at', 'clickedAt', 'clicked_links', 'clickedLinks', 'provider'],
    }),
    firestore.runQuery({
      collectionId: 'events',
      allDescendants: true,
      where: firestoreTimestampFilter('timestamp', window.start),
      fieldPaths: ['event_type', 'eventType', 'message_id', 'messageId', 'timestamp', 'occurred_at', 'occurredAt', 'provider'],
    }),
  ]);
  const consent = predicates || await Promise.all([
    import('../../functions/src/jobAlertBackfillCore.js'),
    import('../../functions/src/lib/emailSuppression.js'),
  ]).then(([core, suppression]) => ({
    evaluateJobAlertConsent: core.evaluateJobAlertConsent,
    isCrossChannelStop: suppression.isCrossChannelStop,
    isJobAlertExcluded: suppression.isJobAlertExcluded,
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
  const returnCohort = outcome._returnCohort;
  if (returnCohort?.campaignNames?.length > 0) {
    const analytics = analyticsClient || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
    const returningUsers7d = await fetchL4ReturnUsers({
      client: analytics,
      startDate: returnCohort.cohortStartDate,
      endDate: returnCohort.cohortEndDate,
      campaignNames: returnCohort.campaignNames,
      propertyId,
    });
    outcome.returningUsers7d = returningUsers7d;
    outcome.export.returnMeasurement = {
      status: 'observed',
      source: L4_GA4_RETURN_CONTRACT.source,
      dimension: L4_GA4_RETURN_CONTRACT.dimension,
      metric: L4_GA4_RETURN_CONTRACT.metric,
      campaignParameter: L4_GA4_RETURN_CONTRACT.campaignParameter,
      cohortStartDate: returnCohort.cohortStartDate,
      cohortEndDate: returnCohort.cohortEndDate,
      matureDeliveryRows: returnCohort.matureDeliveryRows,
      returningUsers7d,
    };
  }
  outcome.export.configSource = configPath || 'data/alert-config.json';
  if (outcome.export.deliveryEvidenceJoin === 'empty') {
    // Aggregates only: the reason must be readable in the run log.
    console.warn(`L4: join consegna-evento vuoto, deliveredAlerts a zero con invii ${JSON.stringify({
      deliveryRows: outcome.export.deliveryRows,
      deliveryRowsByProvider: outcome.export.deliveryRowsByProvider,
      deliveryEvidenceByJoin: outcome.export.deliveryEvidenceByJoin,
    })}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return outcome;
}

/** Explicitly unavailable L4 input; no delivery or return metric is inferred. */
export function buildUnavailableL4OutcomeExport({
  generatedAt = new Date().toISOString(),
  reason = 'read-only alert delivery export unavailable',
} = {}) {
  return {
    generatedAt,
    independent: false,
    eligibleConsentedUsers: null,
    deliveredAlerts: null,
    openedAlerts: null,
    clickedAlerts: null,
    returningUsers7d: null,
    duplicateSends: null,
    consentViolations: null,
    suppressedWithoutConsent: null,
    deferredAlerts: null,
    evidence: {
      source: 'Firestore read-only alert delivery export unavailable',
      sourceRefs: ['consent-delivery', 'ga4-alert-return'],
      status: 'unavailable',
    },
    export: {
      schemaVersion: 1,
      readOnly: true,
      unavailable: true,
      mutationsPerformed: false,
      sourceRefs: ['consent-delivery', 'ga4-alert-return'],
      returnMeasurement: {
        status: 'unavailable',
        source: 'GA4 Data API',
        reason: 'Firestore alert-delivery export unavailable',
      },
      externalDeliveryUntouched: true,
    },
    _meta: {
      generatedAt,
      source: 'Firestore read-only alert delivery export unavailable',
      purpose: 'Explicit fail-closed placeholder for Loop L4',
      reason,
    },
  };
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
    .filter(([, data]) => profileKeys.has(companyKeyFor({ data }, publishers)))
    .map(([id]) => id));
  const orders = orderRows.filter((row) => rootCollectionRow(row, 'orders'));
  const allCheckoutAccounts = new Set(orders.map(publisherId).filter((id) => eligibleAccounts.has(id)));
  const paidAccounts = new Set();
  const activeAccounts = new Set();
  let mrrRecognizedChf = 0;
  for (const row of orders) {
    const data = documentData(row);
    const id = publisherId(row);
    if (String(data.status || '').toLowerCase() === 'active') {
      if (!eligibleAccounts.has(id)) continue;
      activeAccounts.add(id);
      if (String(data.currency || 'CHF').toUpperCase() === 'CHF' && number(data.amountChf)) mrrRecognizedChf += data.amountChf;
      paidAccounts.add(id);
    }
  }

  const livePaidJobs = new Set();
  const freeProfileKeys = new Set();
  const paidProfileKeys = new Set();
  for (const row of jobRows) {
    if (!rootCollectionRow(row, 'publisher_jobs')) continue;
    const data = documentData(row);
    const status = String(data.status || '').toLowerCase();
    const tier = String(data.tier || '').toLowerCase();
    const key = companyKeyFor(row, publishers);
    if (!profileKeys.has(key)) continue;
    if (status === 'paid') {
      // A paid inventory job proves attachment only. Billing activation must
      // come from the authoritative order/subscription ledger above; joining
      // this set here would turn inventory into a false paid outcome.
      livePaidJobs.add(row.name || documentId(row));
    }
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
    independent: true,
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
  if (!['L1', 'L3', 'L4', 'L5', 'L9'].includes(loop)) {
    throw new Error('--loop must be L1, L3, L4, L5 or L9');
  }
  if (!outputPath) throw new Error('--out is required');
  const now = new Date();
  if (loop === 'L1') {
    const inputPath = valueAfter(argv, '--input', valueAfter(argv, '--telemetry', 'data/error-triage-baseline.json'));
    if (argv.includes('--unavailable')) {
      const outcome = buildUnavailableL1TelemetryExport({
        generatedAt: now.toISOString(),
        reason: valueAfter(argv, '--reason', 'read-only telemetry export unavailable'),
      });
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
      return outcome;
    }
    const days = Number(valueAfter(argv, '--days', DEFAULT_L1_WINDOW_DAYS));
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
    return exportL1({
      inputPath,
      outputPath,
      now,
      days,
      propertyId: valueAfter(argv, '--property', null),
    });
  }
  if (loop === 'L3') {
    const days = Number(valueAfter(argv, '--days', DEFAULT_L3_WINDOW_DAYS));
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
    if (argv.includes('--unavailable')) {
      const outcome = buildUnavailableL3OutcomeExport({
        generatedAt: now.toISOString(),
        reason: valueAfter(argv, '--reason', 'read-only application-handoff export unavailable'),
      });
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
      return outcome;
    }
    return exportL3({
      outputPath,
      now,
      days,
      propertyId: valueAfter(argv, '--property', null),
    });
  }
  if (loop === 'L4') {
    if (argv.includes('--unavailable')) {
      const outcome = buildUnavailableL4OutcomeExport({
        generatedAt: now.toISOString(),
        reason: valueAfter(argv, '--reason', 'read-only alert delivery export unavailable'),
      });
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
      return outcome;
    }
    return exportL4({
      configPath: valueAfter(argv, '--config', 'data/alert-config.json'),
      snoozesPath: valueAfter(argv, '--snoozes', 'data/alert-snoozes.json'),
      outputPath,
      now,
    });
  }
  if (loop === 'L5') {
    if (argv.includes('--unavailable')) {
      const outcome = buildUnavailableL5DecisionMomentExport({
        generatedAt: now.toISOString(),
        reason: valueAfter(argv, '--reason', 'read-only decision-moment export unavailable'),
      });
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
      return outcome;
    }
    return exportL5({
      outputPath,
      now,
      days: Number(valueAfter(argv, '--days', DEFAULT_L5_WINDOW_DAYS)),
      propertyId: valueAfter(argv, '--property', null),
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
