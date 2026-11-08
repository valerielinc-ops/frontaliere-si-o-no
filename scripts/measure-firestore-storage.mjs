#!/usr/bin/env node
/**
 * Read-only Firestore inventory and storage estimate for the production
 * `(default)` database. Uses only listCollectionIds, runQuery and
 * runAggregationQuery; it never writes to Firestore or Cloud Monitoring.
 *
 *   node scripts/measure-firestore-storage.mjs
 *
 * The report contains collection names, aggregate counts and byte estimates;
 * sampled document values are kept in memory and are never printed or saved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

const PROJECT_ID = 'frontaliere-ticino';
const DATABASE_ID = '(default)';
const API_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents`;
const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const DEFAULT_MAX_READS = 49_999;
const MAX_SAMPLE_SIZE = 20;
const COLLECTION_GROUPS = [
  'alerts',
  'campaign_deliveries',
  'events',
  'private',
  'savedJobs',
  'application_intents',
  'pending_material_copies',
];
const KNOWN_CREATION_FIELDS = new Map([
  ['group:campaign_deliveries', { name: 'sent_at', type: 'timestampValue' }],
  ['group:events', { name: 'timestamp', type: 'timestampValue' }],
  ['root:job_email_ranking_deliveries', { name: 'sent_at', type: 'timestampValue' }],
]);
const FIXED_ID_COLLECTIONS = new Set(['root:config']);
const CREATION_FIELDS = [
  'createdAt', 'created_at', 'receivedAt', 'received_at', 'timestamp', 'ts',
  'occurred_at', 'at', 'created', 'queuedAt', 'recordedAt', 'capturedAt',
  'insertedAt', 'sentAt', 'sent_at', 'eventAt', 'event_at', 'firstSeenAt',
  'lastSeenAt', 'date',
];

const STRING_TYPES = new Set(['stringValue']);
const DATE_FILTER_TYPES = new Set(['timestampValue', 'stringValue', 'integerValue']);

function utf8StringSize(value) {
  return Buffer.byteLength(String(value), 'utf8') + 1;
}

function dataFieldsSize(fields = {}) {
  let total = 0;
  for (const [name, value] of Object.entries(fields)) {
    total += utf8StringSize(name) + firestoreValueSize(value);
  }
  return total;
}

/** Size rules from the Firestore storage-size documentation. */
export function firestoreValueSize(value = {}) {
  if ('stringValue' in value) return utf8StringSize(value.stringValue);
  if ('integerValue' in value || 'doubleValue' in value) return 8;
  if ('booleanValue' in value || 'nullValue' in value) return 1;
  if ('timestampValue' in value) return 8;
  if ('bytesValue' in value) return Buffer.from(value.bytesValue, 'base64').length;
  if ('referenceValue' in value) {
    const relativePath = String(value.referenceValue).split('/documents/').at(-1);
    return firestoreDocumentNameSize(relativePath);
  }
  if ('geoPointValue' in value) return 16;
  if ('vectorValue' in value) {
    const dimensions = value.vectorValue?.values?.length ?? 0;
    return dimensions * 8;
  }
  if ('arrayValue' in value) {
    return (value.arrayValue?.values || []).reduce((sum, item) => sum + firestoreValueSize(item), 0);
  }
  if ('mapValue' in value) {
    // A map follows the document field/value calculation; it has no document
    // name of its own, while the 32-byte document overhead applies per map.
    return dataFieldsSize(value.mapValue?.fields || {}) + 32;
  }
  return 0;
}

export function firestoreDocumentNameSize(relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  return parts.reduce((sum, part) => sum + utf8StringSize(part), 16);
}

export function firestoreDocumentSize(document) {
  const relativePath = String(document.name || '').split('/documents/').at(-1);
  return firestoreDocumentNameSize(relativePath) + dataFieldsSize(document.fields || {}) + 32;
}

function valueType(value) {
  return Object.keys(value || {}).find((key) => key.endsWith('Value')) || 'unknown';
}

function flattenIndexedFields(fields = {}, prefix = '') {
  const result = [];
  for (const [name, value] of Object.entries(fields)) {
    const fieldPath = prefix ? `${prefix}.${name}` : name;
    if ('mapValue' in value) {
      result.push({ fieldPath, value });
      result.push(...flattenIndexedFields(value.mapValue?.fields || {}, fieldPath));
    } else {
      result.push({ fieldPath, value });
    }
  }
  return result;
}

function indexValueSize(value) {
  const type = valueType(value);
  if (STRING_TYPES.has(type)) {
    return Math.min(Buffer.byteLength(String(value.stringValue), 'utf8'), 1500) + 1;
  }
  if (type === 'mapValue' || type === 'arrayValue') {
    return Math.min(firestoreValueSize(value), 1500) + 1;
  }
  return firestoreValueSize(value);
}

function relativeDocumentPath(document) {
  return String(document.name || '').split('/documents/').at(-1);
}

function parentDocumentNameSize(document) {
  const parts = relativeDocumentPath(document).split('/').filter(Boolean);
  return parts.length > 2 ? firestoreDocumentNameSize(parts.slice(0, -2).join('/')) : 0;
}

function singleFieldEntrySize({ document, fieldPath, value, scope }) {
  const documentNameBytes = firestoreDocumentNameSize(relativeDocumentPath(document));
  const parentNameBytes = scope === 'COLLECTION'
    ? parentDocumentNameSize(document)
    : 0;
  const suffixBytes = scope === 'COLLECTION' ? 32 : 48;
  return documentNameBytes + parentNameBytes + utf8StringSize(fieldPath)
    + indexValueSize(value) + suffixBytes;
}

function matchingFieldOverride(config, collectionId, fieldPath) {
  const candidates = (config.fieldOverrides || []).filter((override) =>
    override.collectionGroup === collectionId
    && (override.fieldPath === '*'
      || fieldPath === override.fieldPath
      || fieldPath.startsWith(`${override.fieldPath}.`)));
  return candidates.sort((a, b) => b.fieldPath.length - a.fieldPath.length)[0] || null;
}

function arrayValues(value) {
  return 'arrayValue' in value ? (value.arrayValue?.values || []) : null;
}

function addConfiguredSingleFieldIndexes({ result, document, fieldPath, value, override }) {
  const indexes = override?.indexes;
  if (!override) {
    const values = arrayValues(value);
    if (values) {
      for (let i = 0; i < 2; i += 1) {
        result += singleFieldEntrySize({ document, fieldPath, value, scope: 'COLLECTION' });
      }
      for (const item of values) {
        result += singleFieldEntrySize({ document, fieldPath, value: item, scope: 'COLLECTION' });
      }
      return result;
    }
    for (let i = 0; i < 2; i += 1) {
      result += singleFieldEntrySize({ document, fieldPath, value, scope: 'COLLECTION' });
    }
    return result;
  }

  for (const index of indexes || []) {
    const scope = index.queryScope || 'COLLECTION';
    const values = index.arrayConfig === 'CONTAINS' ? arrayValues(value) : null;
    if (values) {
      for (const item of values) {
        result += singleFieldEntrySize({ document, fieldPath, value: item, scope });
      }
    } else if (index.order) {
      result += singleFieldEntrySize({ document, fieldPath, value, scope });
    }
  }
  return result;
}

function fieldAtPath(fields, fieldPath) {
  if (fieldPath === '__name__') return null;
  return fieldPath.split('.').reduce((current, key) => {
    if (!current || !('mapValue' in current)) return null;
    return current.mapValue?.fields?.[key] || null;
  }, { mapValue: { fields } });
}

function compositeIndexBytes({ document, collectionId, config }) {
  let total = 0;
  for (const index of config.indexes || []) {
    if (index.collectionGroup !== collectionId) continue;
    let entryCount = 1;
    let fieldValueBytes = 0;
    let usable = true;
    for (const field of index.fields || []) {
      const value = fieldAtPath(document.fields || {}, field.fieldPath);
      if (field.fieldPath === '__name__') {
        fieldValueBytes += firestoreDocumentNameSize(relativeDocumentPath(document));
        continue;
      }
      if (!value) {
        usable = false;
        break;
      }
      if (field.arrayConfig === 'CONTAINS') {
        const values = arrayValues(value) || [];
        if (values.length === 0) {
          usable = false;
          break;
        }
        entryCount *= values.length;
        fieldValueBytes += values.reduce((sum, item) => sum + indexValueSize(item), 0) / values.length;
      } else {
        fieldValueBytes += indexValueSize(value);
      }
    }
    if (!usable) continue;
    const collectionScope = index.queryScope === 'COLLECTION';
    const nameAndParent = firestoreDocumentNameSize(relativeDocumentPath(document))
      + (collectionScope ? parentDocumentNameSize(document) : 0);
    total += entryCount * (nameAndParent + fieldValueBytes + 32);
  }
  return total;
}

export function firestoreIndexSize(document, collectionId, config) {
  let bytes = 0;
  for (const { fieldPath, value } of flattenIndexedFields(document.fields || {})) {
    const override = matchingFieldOverride(config, collectionId, fieldPath);
    bytes = addConfiguredSingleFieldIndexes({ result: bytes, document, fieldPath, value, override });
  }
  return bytes + compositeIndexBytes({ document, collectionId, config });
}

export function firestoreSingleFieldIndexBreakdown(document, collectionId, config) {
  return flattenIndexedFields(document.fields || {}).map(({ fieldPath, value }) => ({
    fieldPath,
    bytes: addConfiguredSingleFieldIndexes({
      result: 0,
      document,
      fieldPath,
      value,
      override: matchingFieldOverride(config, collectionId, fieldPath),
    }),
  })).filter((entry) => entry.bytes > 0);
}

function rawFieldTypes(fields = []) {
  const result = new Map();
  for (const name of CREATION_FIELDS) {
    const types = new Set();
    let present = 0;
    let integerMillis = 0;
    let integerSeconds = 0;
    let dateOnlyStrings = 0;
    for (const doc of fields) {
      const value = doc.fields?.[name];
      if (!value) continue;
      const type = valueType(value);
      if (!DATE_FILTER_TYPES.has(type)) continue;
      types.add(type);
      present += 1;
      if (type === 'integerValue') {
        const number = Number(value.integerValue);
        if (Number.isFinite(number) && Math.abs(number) >= 1_000_000_000_000) integerMillis += 1;
        else integerSeconds += 1;
      }
      if (type === 'stringValue' && /^\d{4}-\d{2}-\d{2}$/.test(String(value.stringValue))) dateOnlyStrings += 1;
    }
    if (present) result.set(name, {
      present,
      types: [...types],
      integerUnit: integerMillis >= integerSeconds ? 'milliseconds' : 'seconds',
      dateOnlyStrings: dateOnlyStrings === present,
    });
  }
  return result;
}

function chooseCreationField(documents, source) {
  if (FIXED_ID_COLLECTIONS.has(`${source.scope}:${source.collectionId}`)) return null;
  const known = KNOWN_CREATION_FIELDS.get(`${source.scope}:${source.collectionId}`);
  if (known) return { ...known, observed: null, integerUnit: 'milliseconds', dateOnlyStrings: false };
  const observed = rawFieldTypes(documents);
  for (const name of CREATION_FIELDS) {
    const details = observed.get(name);
    if (details?.types.length === 1) {
      return {
        name,
        type: details.types[0],
        observed: details.present,
        integerUnit: details.integerUnit,
        dateOnlyStrings: details.dateOnlyStrings,
      };
    }
  }
  return null;
}

function dateFilterValue(field, days, now) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  if (field.type === 'timestampValue') return { timestampValue: cutoff.toISOString() };
  if (field.type === 'stringValue') {
    return { stringValue: field.dateOnlyStrings ? cutoff.toISOString().slice(0, 10) : cutoff.toISOString() };
  }
  if (field.type === 'integerValue') {
    const divisor = field.integerUnit === 'seconds' ? 1000 : 1;
    return { integerValue: String(Math.floor(cutoff.getTime() / divisor)) };
  }
  throw new TypeError(`unsupported creation field type: ${field.type}`);
}

function parseMaxReads(argv) {
  const input = argv.find((arg) => arg.startsWith('--max-reads='));
  if (!input) return DEFAULT_MAX_READS;
  const parsed = Number(input.slice('--max-reads='.length));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > DEFAULT_MAX_READS) {
    throw new RangeError(`--max-reads must be an integer from 1 to ${DEFAULT_MAX_READS}`);
  }
  return parsed;
}

function parseIndexConfigPath(argv, defaultPath) {
  const input = argv.find((arg) => arg.startsWith('--index-config='));
  return input ? path.resolve(input.slice('--index-config='.length)) : defaultPath;
}

function queryFor(source, where, limit) {
  return {
    from: [{ collectionId: source.collectionId, ...(source.scope === 'group' ? { allDescendants: true } : {}) }],
    ...(where ? { where } : {}),
    ...(limit ? { limit } : {}),
  };
}

function hasSingleFieldQueryIndex(source, fieldPath, config) {
  const override = matchingFieldOverride(config, source.collectionId, fieldPath);
  if (override) {
    const scope = source.scope === 'group' ? 'COLLECTION_GROUP' : 'COLLECTION';
    if ((override.indexes || []).some((index) =>
      index.queryScope === scope && index.order)) return true;
    return false;
  }
  if (source.scope === 'root') return true;
  return (config.indexes || []).some((index) =>
    index.collectionGroup === source.collectionId
    && index.queryScope === 'COLLECTION_GROUP'
    && index.fields?.length === 1
    && index.fields[0].fieldPath === fieldPath
    && Boolean(index.fields[0].order));
}

function aggregateCount(response) {
  const value = response.find((item) => item.result?.aggregateFields?.count)?.result?.aggregateFields?.count;
  const count = Number(value?.integerValue ?? value?.doubleValue ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Firestore returned an invalid aggregate count');
  return count;
}

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function main() {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is set; refusing an ambiguous database target.');
  }
  const maxReads = parseMaxReads(process.argv.slice(2));
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(os.homedir(), '.config/frontaliere/sa-frontaliere-ticino.json');
  const credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (credentials.project_id !== PROJECT_ID) {
    throw new Error(`Credential project mismatch: expected ${PROJECT_ID}; no Firestore request sent.`);
  }
  const token = await getServiceAccountAccessToken(credentials, DATASTORE_SCOPE);
  const configPath = parseIndexConfigPath(
    process.argv.slice(2),
    fileURLToPath(new URL('../firestore.indexes.json', import.meta.url)),
  );
  const indexConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const startedAt = new Date();
  let estimatedReads = 0;

  async function post(method, body) {
    if (!['listCollectionIds', 'runQuery', 'runAggregationQuery'].includes(method)) {
      throw new Error(`Refusing non-read Firestore method: ${method}`);
    }
    const response = await fetch(`${API_ROOT}:${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`Firestore ${method} failed: HTTP ${response.status}: ${detail}`);
    }
    return response.json();
  }

  const rootCollectionIds = [];
  let pageToken;
  let listCollectionIdsReadsEstimated = 0;
  do {
    const page = await post('listCollectionIds', { pageSize: 1000, ...(pageToken ? { pageToken } : {}) });
    estimatedReads += 1;
    listCollectionIdsReadsEstimated += 1;
    rootCollectionIds.push(...(page.collectionIds || []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const sources = [
    ...rootCollectionIds.sort().map((collectionId) => ({ scope: 'root', collectionId })),
    ...COLLECTION_GROUPS.map((collectionId) => ({ scope: 'group', collectionId })),
  ];
  const reserveAggregationReads = sources.length * 3;
  const availableForSamples = maxReads - estimatedReads - reserveAggregationReads;
  const sampleLimit = Math.min(MAX_SAMPLE_SIZE, Math.floor(availableForSamples / (sources.length * 2)));
  if (sampleLimit < 1) throw new Error('Read budget is too small for the required inventory and aggregate count queries.');

  const samples = new Map();
  for (const source of sources) {
    const response = await post('runQuery', { structuredQuery: queryFor(source, null, sampleLimit) });
    let documents = response.map((item) => item.document).filter(Boolean);
    let reads = Math.max(1, documents.length);
    let sampleReads = reads;
    estimatedReads += reads;
    if (estimatedReads + reserveAggregationReads > maxReads) {
      throw new Error('Read budget guard stopped before aggregate queries.');
    }
    const creationField = chooseCreationField(documents, source);
    const indexAvailable = creationField
      && hasSingleFieldQueryIndex(source, creationField.name, indexConfig);
    if (indexAvailable) {
      const recentResponse = await post('runQuery', {
        structuredQuery: queryFor(source, {
          fieldFilter: {
            field: { fieldPath: creationField.name },
            op: 'GREATER_THAN_OR_EQUAL',
            value: dateFilterValue(creationField, 30, startedAt),
          },
        }, sampleLimit),
      });
      const recentDocuments = recentResponse.map((item) => item.document).filter(Boolean);
      reads = Math.max(1, recentDocuments.length);
      sampleReads += reads;
      estimatedReads += reads;
      if (estimatedReads + reserveAggregationReads > maxReads) {
        throw new Error('Read budget guard stopped while collecting recent sample documents.');
      }
      if (recentDocuments.length) documents = recentDocuments;
    }
    const documentSizes = documents.map(firestoreDocumentSize);
    const indexSizes = documents.map((doc) => firestoreIndexSize(doc, source.collectionId, indexConfig));
    const fieldIndexBytes = new Map();
    for (const document of documents) {
      for (const entry of firestoreSingleFieldIndexBreakdown(document, source.collectionId, indexConfig)) {
        fieldIndexBytes.set(entry.fieldPath, (fieldIndexBytes.get(entry.fieldPath) || 0) + entry.bytes);
      }
    }
    samples.set(`${source.scope}:${source.collectionId}`, {
      documents,
      sampleCount: documents.length,
      reads: sampleReads,
      averageDocumentBytes: documentSizes.length ? Math.round(documentSizes.reduce((a, b) => a + b, 0) / documentSizes.length) : 0,
      p95DocumentBytes: quantile(documentSizes, 0.95),
      averageIndexBytes: indexSizes.length ? Math.round(indexSizes.reduce((a, b) => a + b, 0) / indexSizes.length) : 0,
      p95IndexBytes: quantile(indexSizes, 0.95),
      largestSingleFieldIndexContributors: [...fieldIndexBytes]
        .map(([fieldPath, totalBytes]) => ({
          fieldPath,
          averageBytesPerSampleDocument: Math.round(totalBytes / Math.max(1, documents.length)),
        }))
        .sort((a, b) => b.averageBytesPerSampleDocument - a.averageBytesPerSampleDocument)
        .slice(0, 8),
      creationField,
      creationFilterAvailable: Boolean(indexAvailable),
      creationFieldCandidates: Object.fromEntries(rawFieldTypes(documents)),
    });
  }

  const creationFilterAvailability = new Map();
  const aggregationTasks = sources.flatMap((source) => {
    const sample = samples.get(`${source.scope}:${source.collectionId}`);
    const tasks = [{ source, windowDays: null, field: null, type: null }];
    if (sample.creationField) {
      const indexAvailable = hasSingleFieldQueryIndex(source, sample.creationField.name, indexConfig);
      creationFilterAvailability.set(`${source.scope}:${source.collectionId}`, indexAvailable);
      if (indexAvailable) {
        for (const windowDays of [30, 7]) {
          tasks.push({ source, windowDays, field: sample.creationField.name, type: sample.creationField.type });
        }
      }
    } else {
      creationFilterAvailability.set(`${source.scope}:${source.collectionId}`, false);
    }
    return tasks;
  });

  const aggregates = new Map();
  for (let index = 0; index < aggregationTasks.length; index += 1) {
    const task = aggregationTasks[index];
    const remainingTasks = aggregationTasks.length - index - 1;
    const availableReads = maxReads - estimatedReads - remainingTasks;
    if (availableReads < 1) throw new Error('Read budget guard stopped before the next aggregate query.');
    const entryLimit = Math.max(1, Math.min(2_000_000_000, availableReads * 1000));
    const where = task.field ? {
      fieldFilter: {
        field: { fieldPath: task.field },
        op: 'GREATER_THAN_OR_EQUAL',
        value: dateFilterValue({
          type: task.type,
          integerUnit: samples.get(`${task.source.scope}:${task.source.collectionId}`).creationField.integerUnit,
          dateOnlyStrings: samples.get(`${task.source.scope}:${task.source.collectionId}`).creationField.dateOnlyStrings,
        }, task.windowDays, startedAt),
      },
    } : null;
    const response = await post('runAggregationQuery', {
      structuredAggregationQuery: {
        structuredQuery: queryFor(task.source, where, entryLimit),
        aggregations: [{ count: {}, alias: 'count' }],
      },
    });
    const count = aggregateCount(response);
    const reads = Math.max(1, Math.ceil(count / 1000));
    estimatedReads += reads;
    const truncated = count >= entryLimit;
    aggregates.set(`${task.source.scope}:${task.source.collectionId}:${task.windowDays ?? 'all'}`, {
      count,
      estimatedReads: reads,
      truncated,
    });
  }

  const rootIds = new Set(rootCollectionIds);
  const rows = sources.map((source) => {
    const key = `${source.scope}:${source.collectionId}`;
    const sample = samples.get(key);
    const total = aggregates.get(`${key}:all`);
    const recent30 = aggregates.get(`${key}:30`);
    const recent7 = aggregates.get(`${key}:7`);
    const avgDocBytes = sample.averageDocumentBytes;
    const avgIndexBytes = sample.averageIndexBytes;
    const weeklyNewDocuments = recent7?.count ?? null;
    const weeklyBytes = weeklyNewDocuments === null
      ? null
      : weeklyNewDocuments * (avgDocBytes + avgIndexBytes);
    const overlap = source.scope === 'group' && rootIds.has(source.collectionId);
    return {
      scope: source.scope,
      collection: source.collectionId,
      rootCollectionOverlap: overlap,
      totalDocuments: total.count,
      countReadsEstimate: total.estimatedReads,
      totalTruncated: total.truncated,
      createdField: sample.creationField,
      creationFilterStatus: !sample.creationField
        ? (FIXED_ID_COLLECTIONS.has(key) ? 'fixed_document_ids_not_append_only' : 'no_creation_field_in_sample')
        : creationFilterAvailability.get(key)
          ? 'counted'
          : 'skipped_no_matching_index',
      last30DaysDocuments: recent30?.count ?? null,
      last7DaysDocuments: recent7?.count ?? null,
      sampleDocuments: sample.sampleCount,
      sampleReadsEstimate: sample.reads,
      averageDocumentBytes: avgDocBytes,
      p95DocumentBytes: sample.p95DocumentBytes,
      averageSingleAndCompositeIndexBytes: avgIndexBytes,
      p95SingleAndCompositeIndexBytes: sample.p95IndexBytes,
      largestSingleFieldIndexContributors: sample.largestSingleFieldIndexContributors,
      estimatedBytesPerDocument: avgDocBytes + avgIndexBytes,
      estimatedGrowthBytesPerWeek: weeklyBytes,
      aggregateReadEstimate: total.estimatedReads + (recent30?.estimatedReads || 0) + (recent7?.estimatedReads || 0),
      filteredCountsTruncated: Boolean(recent30?.truncated || recent7?.truncated),
    };
  });

  const rootRowsByCollection = new Map(rows
    .filter((row) => row.scope === 'root')
    .map((row) => [row.collection, row]));
  for (const row of rows) {
    if (!row.rootCollectionOverlap) continue;
    const rootRow = rootRowsByCollection.get(row.collection);
    row.uniqueLast7Documents = Math.max(0, (row.last7DaysDocuments || 0) - (rootRow?.last7DaysDocuments || 0));
    row.estimatedGrowthBytesPerWeek = row.uniqueLast7Documents * row.estimatedBytesPerDocument;
  }
  const measuredGrowthRows = rows.filter((row) => row.estimatedGrowthBytesPerWeek !== null);
  const growthBytesPerWeek = measuredGrowthRows.reduce((sum, row) => sum + row.estimatedGrowthBytesPerWeek, 0);
  const giB = 1024 ** 3;
  const output = {
    project: PROJECT_ID,
    database: DATABASE_ID,
    location: 'europe-west6',
    readOnly: true,
    generatedAt: startedAt.toISOString(),
    measurement: {
      rootCollections: rootCollectionIds.length,
      knownCollectionGroups: COLLECTION_GROUPS,
      sampleLimit: MAX_SAMPLE_SIZE,
      sampleLimitUsed: sampleLimit,
      actualSampleReadsEstimated: rows.reduce((sum, row) => sum + row.sampleReadsEstimate, 0),
      aggregateReadsEstimated: rows.reduce((sum, row) => sum + row.aggregateReadEstimate, 0),
      listCollectionIdsReadsEstimated,
      totalReadsEstimated: estimatedReads,
      maximumAllowedReads: maxReads,
      budgetUnder50k: estimatedReads < 50_000,
      billingEstimate: 'count() billed at one read per up to 1000 index entries, minimum one; query output count is used as a conservative proxy for entries scanned',
      sizeMethod: 'sampled Firestore document size plus computed automatic single-field and firestore.indexes.json composite/fieldOverride entries; excludes internal database metadata',
      weeklyGrowthGiB: growthBytesPerWeek / giB,
      baselineGiBPerWeek: 1.33,
      baselineCoveragePercent: growthBytesPerWeek / giB / 1.33 * 100,
      uniqueGroupCountsSubtractRootCollections: true,
    },
    rows: rows.sort((a, b) => (b.estimatedGrowthBytesPerWeek ?? -1) - (a.estimatedGrowthBytesPerWeek ?? -1)),
  };
  console.log(JSON.stringify(output, null, 2));
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`Firestore storage measurement failed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
