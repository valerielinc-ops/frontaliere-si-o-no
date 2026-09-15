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
import { runHogQL } from '../lib/posthog-client.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
} from '../lib/ga4-service-account.mjs';

export const DEFAULT_L1_WINDOW_DAYS = 4;
export const DEFAULT_L3_WINDOW_DAYS = 4;
export const DEFAULT_L4_WINDOW_HOURS = 30;
export const DEFAULT_L5_WINDOW_DAYS = 7;
export const DEFAULT_L7_WINDOW_DAYS = 7;
export const DEFAULT_L9_WINDOW_HOURS = 240;

const DAY_MS = 86_400_000;
const L7_EVENT_NAMES = Object.freeze([
  'experiment_assignment',
  'experiment_exposure',
  'experiment_outcome',
  'experiment_guardrail',
]);
const L7_DEFAULT_POLICY = Object.freeze({
  outcomeId: 'registered-experiment-outcome',
  primaryMetric: 'registered_outcome_per_eligible_cohort',
  minimumSample: 200,
  guardrails: ['persistent assignment', 'minimum sample', 'explicit expiry', 'no automatic price change'],
  candidateTtlHours: 168,
  sourceRefs: ['experiment-assignment-exposure-outcome'],
  assignmentMethod: 'stable-sha256',
  assignmentKey: 'experiment-session-id',
});

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

function isoDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(label + ' must be a valid date');
  return date.toISOString();
}

function quoteHogQLString(value) {
  return "'" + String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
}

function postHogAggregate(response, label) {
  const columns = Array.isArray(response?.columns) ? response.columns : [];
  const row = response?.results?.[0];
  if (Array.isArray(row)) {
    return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  }
  if (isObject(row)) return row;
  throw new Error('PostHog returned no ' + label + ' aggregate row');
}

function writeJsonFile(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(value, null, 2) + '\n');
}

/**
 * The L5 outcome contract is deliberately narrower than generic UI activity:
 * a completed calculator task is the denominator, and a same-session compare
 * or CTA event is the next useful action. The scope is written into the
 * evidence object so the resulting number cannot be mistaken for an
 * unqualified all-surface conversion rate.
 */
export function buildL5DecisionMomentQuery({ start, end } = {}) {
  if (!text(start) || !text(end)) throw new Error('L5 decision-moment query requires start and end');
  return [
    'SELECT countIf(completionRecords > 0) AS eligibleDecisionSessions,',
    '  countIf(completionRecords > 0 AND nextUsefulAt > completedAt) AS nextUsefulActions',
    'FROM (',
    '  SELECT $session_id,',
    '    countIf(event = \'simulation_complete\'',
    '      OR (event = \'funnel_step\' AND properties.funnel = \'calculator\'',
    '        AND properties.step = \'simulation_complete\')) AS completionRecords,',
    '    minIf(timestamp, event = \'simulation_complete\'',
    '      OR (event = \'funnel_step\' AND properties.funnel = \'calculator\'',
    '        AND properties.step = \'simulation_complete\')) AS completedAt,',
    '    maxIf(timestamp, (event = \'funnel_step\' AND properties.step = \'compare\'',
    '        AND (properties.funnel = \'calculator\'',
    '          OR (properties.funnel = \'main_conversion\' AND properties.from_tab = \'calculator\')))',
    '      OR (event = \'cta_click\' AND properties.cta_id LIKE \'calculator%\')) AS nextUsefulAt',
    '  FROM events',
    '  WHERE event IN (\'funnel_step\', \'simulation_complete\', \'cta_click\')',
    '    AND timestamp >= \'' + start + '\' AND timestamp < \'' + end + '\'',
    '  GROUP BY $session_id',
    ')',
  ].join('\n');
}

export function buildL5DecisionMomentExport({
  eligibleDecisionSessions,
  nextUsefulActions,
  generatedAt,
  telemetryWindow,
} = {}) {
  const eligible = nonNegativeInteger(eligibleDecisionSessions, 'eligibleDecisionSessions');
  const next = nonNegativeInteger(nextUsefulActions, 'nextUsefulActions');
  if (next > eligible) throw new Error('PostHog returned nextUsefulActions greater than eligibleDecisionSessions');
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
      denominator: 'distinct PostHog sessions with simulation_complete or funnel_step calculator/simulation_complete',
      numerator: 'denominator sessions with calculator compare transition or calculator CTA click after completion',
      surface: 'calculator',
    },
    evidence: {
      source: 'posthog-decision-surface-export',
      sourceRefs: ['decision-surfaces', 'posthog'],
      eventContract: {
        completed: 'simulation_complete or funnel_step:funnel=calculator,step=simulation_complete',
        nextUseful: 'funnel_step:step=compare from calculator or cta_click:cta_id starts calculator',
        ordering: 'nextUsefulAt > completedAt',
        joinKey: '$session_id',
      },
    },
    _meta: {
      generatedAt: generated,
      source: 'PostHog HogQL, read-only live export',
      purpose: 'Fresh completed-task and next-useful-action evidence for Loop L5',
      telemetryWindow,
    },
  };
}

export async function exportL5({
  outputPath,
  now = new Date(),
  days = DEFAULT_L5_WINDOW_DAYS,
  client = null,
  posthogRunner = runHogQL,
} = {}) {
  const firestore = client || new GoogleDataClient();
  const window = rollingWindow(now, Number(days) * 24);
  const config = await resolvePostHogConfig(firestore);
  const response = await posthogRunner(buildL5DecisionMomentQuery(window), config);
  const aggregate = postHogAggregate(response, 'L5 decision-moment');
  const outcome = buildL5DecisionMomentExport({
    eligibleDecisionSessions: aggregate.eligibleDecisionSessions,
    nextUsefulActions: aggregate.nextUsefulActions,
    generatedAt: now,
    telemetryWindow: window,
  });
  writeJsonFile(outputPath, outcome);
  return outcome;
}

function normalizeL7Policy(policy = {}) {
  const outcome = isObject(policy.outcome) ? policy.outcome : {};
  const allocation = isObject(policy.allocationPolicy) ? policy.allocationPolicy : {};
  const contamination = isObject(allocation.contaminationPolicy) ? allocation.contaminationPolicy : {};
  const lifecycle = isObject(policy.lifecycle) ? policy.lifecycle : {};
  const configuredSourceRefs = Array.isArray(outcome.sourceRefs)
    ? outcome.sourceRefs.filter(text).map((sourceRef) => sourceRef.trim())
    : [];
  const sourceRefs = configuredSourceRefs.length ? configuredSourceRefs : L7_DEFAULT_POLICY.sourceRefs;
  return {
    outcomeId: text(outcome.outcomeId) ? outcome.outcomeId.trim() : L7_DEFAULT_POLICY.outcomeId,
    primaryMetric: text(policy.primaryMetric) ? policy.primaryMetric.trim() : L7_DEFAULT_POLICY.primaryMetric,
    minimumSample: integer(policy.minimumSample) ? policy.minimumSample : L7_DEFAULT_POLICY.minimumSample,
    guardrails: Array.isArray(policy.guardrails) && policy.guardrails.length
      ? policy.guardrails.filter(text).map((guardrail) => guardrail.trim())
      : L7_DEFAULT_POLICY.guardrails,
    candidateTtlHours: number(lifecycle.candidateTtlHours) && lifecycle.candidateTtlHours > 0
      ? lifecycle.candidateTtlHours
      : L7_DEFAULT_POLICY.candidateTtlHours,
    sourceRefs,
    assignmentMethod: text(allocation.assignmentMethod) ? allocation.assignmentMethod.trim() : L7_DEFAULT_POLICY.assignmentMethod,
    assignmentKey: text(allocation.assignmentKey) ? allocation.assignmentKey.trim() : L7_DEFAULT_POLICY.assignmentKey,
    contaminationKey: text(contamination.key) ? contamination.key.trim() : (
      text(allocation.assignmentKey) ? allocation.assignmentKey.trim() : L7_DEFAULT_POLICY.assignmentKey
    ),
  };
}

function readL7Policy(registryPath, policyOverride = null) {
  if (policyOverride) return normalizeL7Policy(policyOverride);
  const registry = JSON.parse(fs.readFileSync(path.resolve(registryPath), 'utf8'));
  const policy = Array.isArray(registry.loops)
    ? registry.loops.find((loop) => loop?.loopId === 'L7')
    : null;
  if (!policy) throw new Error('loop-fleet registry has no L7 policy: ' + registryPath);
  return normalizeL7Policy(policy);
}

export function buildL7ExperimentLedgerQuery({ start, end, policy = {} } = {}) {
  if (!text(start) || !text(end)) throw new Error('L7 experiment query requires start and end');
  const normalizedPolicy = normalizeL7Policy(policy);
  const assignmentEvent = quoteHogQLString('experiment_assignment');
  const exposureEvent = quoteHogQLString('experiment_exposure');
  const outcomeEvent = quoteHogQLString('experiment_outcome');
  const guardrailEvent = quoteHogQLString('experiment_guardrail');
  const assignmentValidity = [
    'properties.assignment_method = ' + quoteHogQLString(normalizedPolicy.assignmentMethod),
    'properties.assignment_key = ' + quoteHogQLString(normalizedPolicy.assignmentKey),
    'properties.persistent = true',
  ].join(' AND ');
  const exposureValidity = 'properties.variant IS NOT NULL';
  const outcomeValidity = [
    'properties.outcome_id = ' + quoteHogQLString(normalizedPolicy.outcomeId),
    'properties.primary_metric = ' + quoteHogQLString(normalizedPolicy.primaryMetric),
  ].join(' AND ');
  const guardrailValidity = [
    'properties.guardrail_checked = true',
    '(properties.breach = true OR properties.breach = false)',
  ].join(' AND ');
  const contaminationValidity = [
    'properties.contamination_checked = true',
    '(properties.contaminated = true OR properties.contaminated = false)',
  ].join(' AND ');
  // HogQL exposes `toDateTime` but not the safe `*OrNull` variants.  Route
  // malformed timestamp shapes to the epoch; a calendar value that still
  // cannot be parsed aborts the export instead of being marked verified.
  const expiryPattern = quoteHogQLString('^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$');
  const expiryDate = 'toDateTime(if(match(properties.expires_at, ' + expiryPattern + ') = 1, properties.expires_at, ' + quoteHogQLString('1970-01-01T00:00:00Z') + '))';
  const expiryValidity = [
    'match(properties.expires_at, ' + expiryPattern + ') = 1',
    expiryDate + ' > timestamp',
    expiryDate + ' <= addHours(timestamp, ' + normalizedPolicy.candidateTtlHours + ')',
  ].join(' AND ');
  const completeAssignmentSessionPredicate = [
    'assignmentRecords > 0',
    'invalidEligibilityRecords = 0',
    'invalidAssignmentRecords = 0',
    'persistentAssignmentRecords = assignmentRecords',
    'invalidContaminationRecords = 0',
    'invalidExpiryRecords = 0',
    'exposureRecords > 0',
    'invalidExposureRecords = 0',
    'outcomeRecords > 0',
    'invalidOutcomeRecords = 0',
    'guardrailRecords > 0',
    'invalidGuardrailRecords = 0',
    'guardrailBreachRecords = 0',
  ].join(' AND ');
  return [
    'SELECT',
    '  sum(eventCount) AS sourceEventCount,',
    '  countIf(assignmentRecords > 0 AND invalidEligibilityRecords = 0) AS eligibleCohort,',
    '  countIf(assignmentRecords > 0) AS assignments,',
    '  countIf(' + completeAssignmentSessionPredicate + ') AS completeAssignmentSessions,',
    '  countIf(validExposureRecords > 0) AS exposures,',
    '  countIf(validOutcomeRecords > 0) AS primaryOutcomes,',
    '  sum(guardrailBreachRecords) AS guardrailBreaches,',
    '  countIf(assignmentRecords > 0 AND persistentAssignmentRecords = assignmentRecords) AS persistentAssignments,',
    '  sum(contaminatedAssignments) AS contaminatedAssignments,',
    '  countIf(assignmentRecords > 0 AND invalidAssignmentRecords = 0) AS assignmentContract,',
    '  countIf(assignmentRecords > 0 AND exposureRecords > 0 AND invalidExposureRecords = 0) AS exposureContract,',
    '  countIf(assignmentRecords > 0 AND outcomeRecords > 0 AND invalidOutcomeRecords = 0) AS outcomeContract,',
    '  countIf(assignmentRecords > 0 AND guardrailRecords > 0 AND invalidGuardrailRecords = 0) AS guardrailContract,',
    '  countIf(assignmentRecords > 0 AND invalidContaminationRecords = 0) AS contaminationContract,',
    '  countIf(assignmentRecords > 0 AND invalidExpiryRecords = 0) AS expiryContract,',
    '  min(firstSeenAt) AS firstSeenAt,',
    '  max(lastSeenAt) AS lastSeenAt',
    'FROM (',
    '  SELECT $session_id,',
    '    count() AS eventCount,',
    '    sum(if(event = ' + assignmentEvent + ', 1, 0)) AS assignmentRecords,',
    '    sum(if(event = ' + assignmentEvent + ', if(properties.eligible = true, 0, 1), 0)) AS invalidEligibilityRecords,',
    '    sum(if(event = ' + exposureEvent + ', 1, 0)) AS exposureRecords,',
    '    sum(if(event = ' + exposureEvent + ' AND ' + exposureValidity + ', 1, 0)) AS validExposureRecords,',
    '    sum(if(event = ' + outcomeEvent + ', 1, 0)) AS outcomeRecords,',
    '    sum(if(event = ' + outcomeEvent + ' AND ' + outcomeValidity + ', 1, 0)) AS validOutcomeRecords,',
    '    sum(if(event = ' + guardrailEvent + ', 1, 0)) AS guardrailRecords,',
    '    sum(if(event = ' + guardrailEvent + ' AND properties.breach = true, 1, 0)) AS guardrailBreachRecords,',
    '    sum(if(event = ' + assignmentEvent + ' AND properties.persistent = true, 1, 0)) AS persistentAssignmentRecords,',
    '    sum(if(event = ' + assignmentEvent + ' AND properties.contaminated = true, 1, 0)) AS contaminatedAssignments,',
    '    sum(if(event = ' + assignmentEvent + ', if(' + assignmentValidity + ', 0, 1), 0)) AS invalidAssignmentRecords,',
    '    sum(if(event = ' + exposureEvent + ', if(' + exposureValidity + ', 0, 1), 0)) AS invalidExposureRecords,',
    '    sum(if(event = ' + outcomeEvent + ', if(' + outcomeValidity + ', 0, 1), 0)) AS invalidOutcomeRecords,',
    '    sum(if(event = ' + guardrailEvent + ', if(' + guardrailValidity + ', 0, 1), 0)) AS invalidGuardrailRecords,',
    '    sum(if(event = ' + assignmentEvent + ', if(' + contaminationValidity + ', 0, 1), 0)) AS invalidContaminationRecords,',
    '    sum(if(event = ' + assignmentEvent + ', if(' + expiryValidity + ', 0, 1), 0)) AS invalidExpiryRecords,',
    '    min(timestamp) AS firstSeenAt,',
    '    max(timestamp) AS lastSeenAt',
    '  FROM events',
    '  WHERE event IN (' + L7_EVENT_NAMES.map(quoteHogQLString).join(', ') + ')',
    '    AND properties.loop_id = ' + quoteHogQLString('L7'),
    '    AND timestamp >= ' + quoteHogQLString(start) + ' AND timestamp < ' + quoteHogQLString(end),
    '  GROUP BY $session_id',
    ')',
  ].join('\n');
}

function l7MetricValues(aggregate, sourceObserved) {
  const names = [
    'eligibleCohort',
    'assignments',
    'exposures',
    'primaryOutcomes',
    'guardrailBreaches',
    'persistentAssignments',
    'contaminatedAssignments',
  ];
  if (!sourceObserved) return Object.fromEntries(names.map((name) => [name, null]));
  return Object.fromEntries(names.map((name) => [
    name,
    nonNegativeInteger(aggregate[name] ?? 0, name),
  ]));
}

function l7DurationDays(aggregate, sourceObserved) {
  if (!sourceObserved) return null;
  if (number(aggregate.durationDays) && aggregate.durationDays > 0) return Number(aggregate.durationDays);
  const firstSeen = new Date(aggregate.firstSeenAt);
  const lastSeen = new Date(aggregate.lastSeenAt);
  if (!Number.isFinite(firstSeen.getTime()) || !Number.isFinite(lastSeen.getTime())) return null;
  const days = (lastSeen.getTime() - firstSeen.getTime()) / DAY_MS;
  return days > 0 ? Number(days.toFixed(3)) : null;
}

export function buildL7ExperimentLedger({
  aggregate = {},
  generatedAt,
  telemetryWindow,
  policy = {},
} = {}) {
  const normalizedPolicy = normalizeL7Policy(policy);
  const generated = isoDate(generatedAt, 'L7 generatedAt');
  const sourceEventCount = nonNegativeInteger(aggregate.sourceEventCount ?? 0, 'sourceEventCount');
  const sourceObserved = sourceEventCount > 0;
  const values = l7MetricValues(aggregate, sourceObserved);
  const durationDays = l7DurationDays(aggregate, sourceObserved);
  const assignments = values.assignments;
  const exposures = values.exposures;
  const eligibleCohort = values.eligibleCohort;
  const completeAssignmentSessions = nonNegativeInteger(
    aggregate.completeAssignmentSessions ?? 0,
    'completeAssignmentSessions',
  );
  const contracts = {
    assignment: nonNegativeInteger(aggregate.assignmentContract ?? 0, 'assignmentContract'),
    exposure: nonNegativeInteger(aggregate.exposureContract ?? 0, 'exposureContract'),
    outcome: nonNegativeInteger(aggregate.outcomeContract ?? 0, 'outcomeContract'),
    guardrail: nonNegativeInteger(aggregate.guardrailContract ?? 0, 'guardrailContract'),
    contamination: nonNegativeInteger(aggregate.contaminationContract ?? 0, 'contaminationContract'),
    expiry: nonNegativeInteger(aggregate.expiryContract ?? 0, 'expiryContract'),
  };
  const contractsComplete = sourceObserved
    && assignments !== null
    && assignments > 0
    && eligibleCohort >= normalizedPolicy.minimumSample
    && assignments >= normalizedPolicy.minimumSample
    && eligibleCohort === assignments
    && exposures !== null
    && exposures > 0
    && exposures >= normalizedPolicy.minimumSample
    && values.primaryOutcomes !== null
    && values.primaryOutcomes > 0
    && values.primaryOutcomes <= exposures
    && values.guardrailBreaches === 0
    && values.persistentAssignments === assignments
    && values.contaminatedAssignments === 0
    && completeAssignmentSessions >= assignments
    && durationDays !== null
    && contracts.assignment >= assignments
    && contracts.exposure >= assignments
    && contracts.outcome >= assignments
    && contracts.guardrail >= assignments
    && contracts.contamination >= assignments
    && contracts.expiry >= assignments;
  const preRegistration = {
    outcomeId: normalizedPolicy.outcomeId,
    primaryMetric: normalizedPolicy.primaryMetric,
    minimumSample: normalizedPolicy.minimumSample,
    guardrails: normalizedPolicy.guardrails,
    expiresAt: new Date(new Date(generated).getTime() + normalizedPolicy.candidateTtlHours * 3_600_000).toISOString(),
  };
  const assignmentLedger = {
    persistent: contractsComplete,
    method: normalizedPolicy.assignmentMethod,
    key: normalizedPolicy.assignmentKey,
  };
  const contaminationPolicy = {
    controlled: contractsComplete,
    key: normalizedPolicy.contaminationKey,
  };
  return {
    schemaVersion: 1,
    loopId: 'L7',
    generatedAt: generated,
    independent: contractsComplete,
    status: contractsComplete ? 'observed' : (sourceObserved ? 'unverified' : 'missing'),
    sourceEventCount,
    eligibleCohort: values.eligibleCohort,
    assignments: values.assignments,
    exposures: values.exposures,
    completeAssignmentSessions,
    primaryOutcomes: values.primaryOutcomes,
    guardrailBreaches: values.guardrailBreaches,
    persistentAssignments: values.persistentAssignments,
    contaminatedAssignments: values.contaminatedAssignments,
    durationDays,
    metrics: values,
    preRegistration,
    assignmentLedger,
    contaminationPolicy,
    contracts,
    telemetryWindow,
    scope: {
      assignment: 'experiment_assignment with explicit loop_id, stable method/key, persistence and expiry',
      exposure: 'experiment_exposure with explicit loop_id and variant',
      outcome: 'experiment_outcome with registered outcome id and primary metric',
      guardrails: 'experiment_guardrail with guardrail_checked and breach fields',
      joinKey: '$session_id, which is the registered experiment-session-id',
    },
    evidence: {
      source: 'posthog-experiment-ledger-export',
      sourceRefs: normalizedPolicy.sourceRefs,
      status: contractsComplete ? 'verified' : (sourceObserved ? 'unverified' : 'missing'),
      sourceEventCount,
      telemetryWindow,
      eventContract: {
        events: [...L7_EVENT_NAMES],
        requiredProperties: [
          'loop_id',
          'assignment_method',
          'assignment_key',
          'persistent',
          'expires_at',
          'contamination_checked',
          'contaminated',
          'guardrail_checked',
          'breach',
        ],
      },
    },
    reason: contractsComplete
      ? 'explicit PostHog experiment ledger satisfies the registered assignment, exposure, outcome and guardrail contract'
      : (sourceObserved
        ? 'PostHog contains experiment events, but the registered ledger contract is incomplete; allocation remains disabled'
        : 'no canonical L7 experiment ledger events were observed; allocation remains disabled'),
    _meta: {
      generatedAt: generated,
      source: 'PostHog HogQL, read-only live export',
      purpose: 'Independent assignment, exposure, outcome and guardrail evidence for Loop L7',
      telemetryWindow,
    },
  };
}

export async function exportL7({
  registryPath = 'data/loop-fleet/loop-registry.json',
  outputPath,
  now = new Date(),
  days = DEFAULT_L7_WINDOW_DAYS,
  client = null,
  posthogRunner = runHogQL,
  policy = null,
} = {}) {
  const firestore = client || new GoogleDataClient();
  const window = rollingWindow(now, Number(days) * 24);
  const resolvedPolicy = policy || readL7Policy(registryPath);
  const config = await resolvePostHogConfig(firestore);
  const response = await posthogRunner(buildL7ExperimentLedgerQuery({ ...window, policy: resolvedPolicy }), config);
  const aggregate = postHogAggregate(response, 'L7 experiment ledger');
  const outcome = buildL7ExperimentLedger({
    aggregate,
    generatedAt: now,
    telemetryWindow: window,
    policy: resolvedPolicy,
  });
  writeJsonFile(outputPath, outcome);
  return outcome;
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

/**
 * Read one exact GA4 event-session count. The event emitter validates the
 * destination before recording `job_apply_handoff`; this exporter preserves
 * that event as a handoff and never upgrades it to an application submission.
 */
export async function fetchL3EventSessions({ client, eventName, startDate, endDate, propertyId } = {}) {
  const data = await client.request(
    `https://analyticsdata.googleapis.com/v1beta/${normalizeGa4PropertyId(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ga4EventSessionsBody({ eventName, startDate, endDate })),
    },
  );
  const value = data?.rows?.[0]?.metricValues?.[0]?.value ?? 0;
  return nonNegativeCount(value, `sessions for ${eventName}`);
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

/**
 * Export L3's independent outcome from GA4 without writing GA4, Firestore,
 * job records or published corpus data. The two event counts are queried
 * independently with exact event filters and a two-day settled window.
 */
export async function exportL3({ outputPath, now = new Date(), days = DEFAULT_L3_WINDOW_DAYS, propertyId = null, client = null } = {}) {
  const analytics = client || new GoogleDataClient({ oauthScope: GA4_READONLY_SCOPE });
  const range = ga4DateRange(days, 2, now);
  const [eligibleJobSessions, validHandoffs] = await Promise.all([
    fetchL3EventSessions({ client: analytics, eventName: 'job_qualified_session', ...range, propertyId }),
    fetchL3EventSessions({ client: analytics, eventName: 'job_apply_handoff', ...range, propertyId }),
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
  const consentedAlerts = new Map();
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
    if (consent?.allowed === true) {
      // Delivery attribution is historical: an alert can be paused, deleted or
      // suppressed after a message was sent without invalidating the consent
      // that authorized that message. Current active/suppression state remains
      // the source for the eligible-user denominator below.
      consentedAlerts.set(alertKey, { email, alertId: child.childId, alert });
    }
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
  const returnedUsers = new Set();
  const dedupGroups = new Map();
  let unattributedDeliveries = 0;
  const unattributedDeliveryReasons = {
    missingAlertId: 0,
    missingSentAt: 0,
    noConsentedAlert: 0,
  };
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
    if (!alertId || sentAt == null || !consentedAlerts.has(key)) {
      unattributedDeliveries += 1;
      if (!alertId) unattributedDeliveryReasons.missingAlertId += 1;
      else if (sentAt == null) unattributedDeliveryReasons.missingSentAt += 1;
      else unattributedDeliveryReasons.noConsentedAlert += 1;
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
      unattributedDeliveryReasons,
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
    'active', 'paused', 'backfilled_from', 'backfilledFrom', 'consent_given', 'consentGiven', 'consent_text', 'consentText',
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
      // A paid inventory job proves attachment only. Billing activation must
      // come from the authoritative order/subscription ledger above; joining
      // this set here would turn inventory into a false paid outcome.
      livePaidJobs.add(row.name || documentId(row));
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
  if (!['L1', 'L3', 'L4', 'L5', 'L7', 'L9'].includes(loop)) {
    throw new Error('--loop must be L1, L3, L4, L5, L7 or L9');
  }
  if (!outputPath) throw new Error('--out is required');
  const now = new Date();
  if (loop === 'L1') {
    const inputPath = valueAfter(argv, '--input', valueAfter(argv, '--telemetry', 'data/error-triage-baseline.json'));
    return exportL1({ inputPath, outputPath, now });
  }
  if (loop === 'L3') {
    const days = Number(valueAfter(argv, '--days', DEFAULT_L3_WINDOW_DAYS));
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
    return exportL3({
      outputPath,
      now,
      days,
      propertyId: valueAfter(argv, '--property', null),
    });
  }
  if (loop === 'L4') {
    return exportL4({
      configPath: valueAfter(argv, '--config', 'data/alert-config.json'),
      snoozesPath: valueAfter(argv, '--snoozes', 'data/alert-snoozes.json'),
      outputPath,
      now,
    });
  }
  if (loop === 'L5') {
    return exportL5({
      outputPath,
      now,
      days: valueAfter(argv, '--days', DEFAULT_L5_WINDOW_DAYS),
    });
  }
  if (loop === 'L7') {
    return exportL7({
      registryPath: valueAfter(argv, '--registry', 'data/loop-fleet/loop-registry.json'),
      outputPath,
      now,
      days: valueAfter(argv, '--days', DEFAULT_L7_WINDOW_DAYS),
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
