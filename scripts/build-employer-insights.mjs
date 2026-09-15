#!/usr/bin/env node
/**
 * Build the employer-insights snapshot from a complete, documentable
 * analytics period.
 *
 * The calculation deliberately starts from the union of events. A pageview
 * is one signal among many, not the admission criterion for an ad. Identity
 * is resolved only through explicit job/company aliases; an unresolved event
 * remains in the residual ledger instead of silently disappearing.
 *
 * Usage:
 *   node scripts/build-employer-insights.mjs --source posthog --days 30
 *   node scripts/build-employer-insights.mjs --source ga4
 *   node scripts/build-employer-insights.mjs --source posthog --company <companyKey>
 *   node scripts/build-employer-insights.mjs --source posthog --apply
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { writeEmployerInsightsDocuments } from './lib/employer-insights-firestore.mjs';
import { assertEmployerInsightsSource } from './lib/employer-insights-contract.mjs';
import {
  GA4_READONLY_SCOPE,
  getServiceAccountToken,
  runGa4Report,
} from './lib/ga4-service-account.mjs';
import {
  ANALYTICS_PROCESSING_LAG_DAYS,
  settledEndDate,
} from './lib/analytics-settled-window.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { JOB_BOARD_SECTION_PREFIX_SOURCE } from './lib/jobBoardSections.mjs';
import {
  baseCompanySlug,
  canonicalCompanyProfileSlug,
  rawCompanySlug,
} from '../build-plugins/shared/companyProfileSlug.mjs';
import { isJobBoardSectorHubPath } from '../build-plugins/shared/jobSectorSlugs.mjs';

export const INSIGHTS_SCHEMA_VERSION = 2;
export const DELIVERY_UNAVAILABLE = 'non disponibile';
export const EVENT_QUERY_PAGE_SIZE = 10_000;
export const GA4_EVENT_QUERY_PAGE_SIZE = 100_000;
const DAY_MS = 86_400_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function resolveBuildSha() {
  const configured = process.env.GITHUB_SHA || process.env.BUILD_SHA || process.env.SITE_BUILD_SHA;
  if (configured) return configured;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

const BUILD_SHA = resolveBuildSha();
const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

const JOB_BOARD_SECTION_RX = new RegExp(`^(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*$`);
const HISTORICAL_JOB_SECTION_RX = /^(?:lavoro|find-jobs?|job-search|jobs?|offerte(?:-di)?-lavoro|offres-(?:d-)?emploi|emplois|recherche-emploi|stellen(?:angebot|angebote)|arbeits(?:stellen|angebote)|jobsuche)(?:-[a-z-]+)?$/;
const COMPANY_HUB_SEGMENTS = new Set([
  'azienda', 'aziende', 'company', 'companies', 'unternehmen', 'entreprise', 'entreprises',
]);
const COMPANY_HUB_PREFIXES = [
  'azienda-', 'aziende-', 'company-', 'companies-', 'unternehmen-', 'entreprise-', 'entreprises-',
];
const APPLY_CONTENT_TYPES = new Set([
  'job_board_apply',
  'job_board_apply_header_logo',
  'job_board_apply_header_title',
]);

const argv = process.argv.slice(2);
const arg = (flag, fallback = undefined) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const numberOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const positiveNumberOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeAlias(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the source value */ }
  return decoded
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function aliasesFor(value) {
  const alias = normalizeAlias(value);
  return new Set([alias].filter(Boolean));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'object') {
    try {
      if (typeof value.toDate === 'function') return toIso(value.toDate());
      if (typeof value.toMillis === 'function') return toIso(new Date(value.toMillis()));
      if (typeof value._seconds === 'number') return toIso(new Date(value._seconds * 1000 + numberOr(value._nanoseconds, 0) / 1e6));
      if (typeof value.seconds === 'number') return toIso(new Date(value.seconds * 1000 + numberOr(value.nanoseconds, 0) / 1e6));
    } catch {
      return null;
    }
  }
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function inWindow(timestamp, window) {
  const iso = toIso(timestamp);
  if (!iso) return false;
  try {
    const from = Date.parse(window?.from);
    const to = Date.parse(window?.to);
    const time = Date.parse(iso);
    return Number.isFinite(from) && Number.isFinite(to)
      && Number.isFinite(time) && time >= from && time < to;
  } catch {
    return false;
  }
}

function weekStart(timestamp) {
  const iso = toIso(timestamp);
  if (!iso) return null;
  const date = new Date(iso);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function normalizeWeek(value) {
  return normalizeText(value).replace('T', ' ').slice(0, 10);
}

function unwrapList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.jobs)) return raw.jobs;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function loadJsonJobs() {
  const monolith = ['data/jobs.json', 'public/data/jobs.json']
    .map((relative) => path.join(ROOT, relative))
    .find((candidate) => fs.existsSync(candidate));
  if (monolith) return unwrapList(JSON.parse(fs.readFileSync(monolith, 'utf8')));

  const directories = [
    path.join(ROOT, 'data', 'jobs', 'by-crawler'),
    path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler'),
  ];
  const jobs = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
      try { jobs.push(...unwrapList(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')))); } catch { /* one broken slice is residual input */ }
    }
  }
  if (!jobs.length) throw new Error('job dataset not found');
  return jobs;
}

function loadCompanyRegistry() {
  const file = path.join(ROOT, 'data', 'crawler-companies-auto.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : Array.isArray(raw?.companies) ? raw.companies : Object.values(raw || {});
  } catch { return []; }
}

function mergeJobs(jobs) {
  const byId = new Map();
  for (const raw of jobs || []) {
    if (!raw || typeof raw !== 'object') continue;
    const canonicalSlug = normalizeText(raw.slug) || normalizeText(raw.slugByLocale?.it);
    const id = normalizeText(raw.id || raw.jobId || raw.providerId) || `${normalizeAlias(raw.companyKey || raw.company)}:${normalizeAlias(canonicalSlug)}`;
    if (!id || id.endsWith(':')) continue;
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, { ...raw, id });
      continue;
    }
    const merged = { ...previous, ...raw, id };
    merged.previousSlugs = [...new Set([...(previous.previousSlugs || []), ...(raw.previousSlugs || [])])];
    merged.slugByLocale = { ...(previous.slugByLocale || {}), ...(raw.slugByLocale || {}) };
    merged.previousSlugsByLocale = { ...(previous.previousSlugsByLocale || {}), ...(raw.previousSlugsByLocale || {}) };
    byId.set(id, merged);
  }
  return [...byId.values()];
}

function jobAliases(job) {
  const values = [job.slug, ...Object.values(job.slugByLocale || {})];
  if (Array.isArray(job.previousSlugs)) values.push(...job.previousSlugs);
  for (const aliases of Object.values(job.previousSlugsByLocale || {})) {
    if (Array.isArray(aliases)) values.push(...aliases);
  }
  return new Set(values.flatMap((value) => [...aliasesFor(value)]));
}

function companyAliases(companyKey, companyName, extras = []) {
  const values = [companyKey, companyName, ...extras];
  if (companyName) {
    values.push(baseCompanySlug(companyName, companyKey));
    values.push(rawCompanySlug(companyName));
    values.push(canonicalCompanyProfileSlug(companyName, companyKey));
  }
  return new Set(values.flatMap((value) => [...aliasesFor(value)]));
}

function addToSetMap(map, alias, value) {
  if (!alias) return;
  if (!map.has(alias)) map.set(alias, new Set());
  map.get(alias).add(value);
}

function collisionStats(map) {
  const values = [...map.values()];
  const colliding = values.filter((set) => set.size > 1);
  return {
    aliases: values.length,
    collidingAliases: colliding.length,
    collisionBindings: colliding.reduce((sum, set) => sum + set.size, 0),
  };
}

/**
 * Build the explicit identity catalog used by event and application
 * attribution. The collision counts are retained for the payload: they are
 * a measurement of ambiguity in the readable catalog, not an unreported
 * fallback.
 */
export function buildIdentityCatalog(inputJobs = [], inputCompanies = []) {
  const jobs = mergeJobs(inputJobs?.jobs || inputJobs);
  const companies = Array.isArray(inputCompanies) ? inputCompanies : unwrapList(inputCompanies);
  const jobsById = new Map();
  const jobAliasToIds = new Map();
  const companyNameByKey = new Map();
  const companyAliasToKeys = new Map();

  for (const company of companies) {
    if (!company || typeof company !== 'object') continue;
    const key = normalizeAlias(company.key || company.companyKey || company.name);
    if (!key) continue;
    const name = normalizeText(company.name) || key;
    if (!companyNameByKey.has(key)) companyNameByKey.set(key, name);
    const extras = [
      ...(Array.isArray(company.previousSlugs) ? company.previousSlugs : []),
      ...(Array.isArray(company.aliases) ? company.aliases : []),
      ...Object.values(company.previousSlugsByLocale || {}).flatMap((values) => Array.isArray(values) ? values : []),
    ];
    for (const alias of companyAliases(key, name, extras)) addToSetMap(companyAliasToKeys, alias, key);
  }

  for (const sourceJob of jobs) {
    const jobId = normalizeText(sourceJob.id || sourceJob.jobId || sourceJob.providerId) || `${normalizeAlias(sourceJob.companyKey || sourceJob.company)}:${normalizeAlias(sourceJob.slug)}`;
    const companyKey = normalizeAlias(sourceJob.companyKey || sourceJob.company);
    if (!jobId || !companyKey) continue;
    const job = {
      ...sourceJob,
      id: jobId,
      companyKey,
      company: normalizeText(sourceJob.company) || companyNameByKey.get(companyKey) || companyKey,
      slug: normalizeText(sourceJob.slug) || normalizeText(sourceJob.slugByLocale?.it),
    };
    jobsById.set(jobId, job);
    if (!companyNameByKey.has(companyKey)) companyNameByKey.set(companyKey, job.company);
    const companyExtras = [
      sourceJob.companySlug,
      ...(Array.isArray(sourceJob.companySlugs) ? sourceJob.companySlugs : []),
      ...(Array.isArray(sourceJob.previousCompanySlugs) ? sourceJob.previousCompanySlugs : []),
      ...Object.values(sourceJob.previousCompanySlugsByLocale || {}).flatMap((values) => Array.isArray(values) ? values : []),
    ];
    for (const alias of companyAliases(companyKey, job.company, companyExtras)) addToSetMap(companyAliasToKeys, alias, companyKey);
    for (const alias of jobAliases(job)) addToSetMap(jobAliasToIds, alias, jobId);
  }

  const identityRows = [...jobsById.values()].map((job) => ({
    id: job.id,
    companyKey: job.companyKey,
    aliases: [...jobAliases(job)].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const jobCollisions = collisionStats(jobAliasToIds);
  const companyCollisions = collisionStats(companyAliasToKeys);

  return {
    jobsById,
    jobAliasToIds,
    companyAliasToKeys,
    companyNameByKey,
    collisions: {
      jobAliases: jobCollisions.collidingAliases,
      jobAliasBindings: jobCollisions.collisionBindings,
      companyAliases: companyCollisions.collidingAliases,
      companyAliasBindings: companyCollisions.collisionBindings,
    },
    identityCatalogSha: sha256(stableJson(identityRows)),
  };
}

/** Compatibility name for scripts that used the old loader during diagnosis. */
export function loadJobMaps() {
  return buildIdentityCatalog(loadJsonJobs(), loadCompanyRegistry());
}

function field(row, name, index) {
  if (Array.isArray(row)) return row[index];
  if (row && Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  if (row?.properties && Object.prototype.hasOwnProperty.call(row.properties, name)) return row.properties[name];
  return undefined;
}

function normalizeEventRow(source) {
  const eventName = normalizeText(field(source, 'event', 1) ?? field(source, 'eventName', 1));
  const properties = source?.properties || {};
  const read = (names, index) => {
    for (const name of names) {
      const value = field(source, name, index);
      if (value !== undefined && value !== null && value !== '') return value;
      if (properties[name] !== undefined && properties[name] !== null && properties[name] !== '') return properties[name];
    }
    return '';
  };
  const observedValue = field(source, 'observed', 10) ?? field(source, 'count', 10);
  const personsValue = field(source, 'persons', 11) ?? field(source, 'distinctPersons', 11) ?? field(source, 'visitors', 11);
  const sessionsValue = field(source, 'sessions', 12) ?? field(source, 'distinctSessions', 12);
  const viewsValue = field(source, 'views', 13);
  const clicksValue = field(source, 'clicks', 14);
  return {
    emissionId: normalizeText(read(['emissionId', 'emission_id', 'actionId', 'action_id'], 15)),
    event: eventName,
    timestamp: toIso(read(['timestamp', 'occurredAt', 'createdAt'], 16)),
    week: normalizeWeek(read(['week', 'wk'], 2)),
    path: normalizeText(read(['path', '$pathname', 'pathname'], 3)),
    jobSlug: normalizeText(read(['jobSlug', 'job_slug', 'slug'], 4)),
    jobId: normalizeText(read(['jobId', 'job_id'], 5)),
    providerId: normalizeText(read(['providerId', 'provider_job_id'], 6)),
    employerKey: normalizeText(read(['employerKey', 'employer_key', 'companyKey', 'company_key'], 7)),
    itemId: normalizeText(read(['itemId', 'item_id'], 8)),
    contentType: normalizeText(read(['contentType', 'content_type'], 9)),
    views: viewsValue == null || viewsValue === '' ? null : Math.max(0, numberOr(viewsValue, 0)),
    clicks: clicksValue == null || clicksValue === '' ? null : Math.max(0, numberOr(clicksValue, 0)),
    observed: Math.max(0, numberOr(observedValue, 1)),
    persons: Math.max(0, numberOr(personsValue, 0)),
    sessions: Math.max(0, numberOr(sessionsValue, 0)),
  };
}

function eventSignature(row) {
  return stableJson({
    event: row.event,
    timestamp: row.timestamp,
    week: row.week,
    path: row.path,
    jobSlug: row.jobSlug,
    jobId: row.jobId,
    providerId: row.providerId,
    employerKey: row.employerKey,
    itemId: row.itemId,
    contentType: row.contentType,
    emissionId: row.emissionId,
    observed: row.observed,
    persons: row.persons,
    sessions: row.sessions,
    views: row.views,
    clicks: row.clicks,
  });
}

function technicalDuplicateIdentityRank(row) {
  return [
    row.jobId ? 1 : 0,
    row.providerId ? 1 : 0,
    row.jobSlug ? 1 : 0,
    row.employerKey ? 1 : 0,
    row.event === 'job_apply' ? 1 : 0,
  ];
}

function compareTechnicalDuplicateRows(candidate, current) {
  const candidateRank = technicalDuplicateIdentityRank(candidate);
  const currentRank = technicalDuplicateIdentityRank(current);
  for (let index = 0; index < candidateRank.length; index += 1) {
    if (candidateRank[index] !== currentRank[index]) return candidateRank[index] - currentRank[index];
  }
  const candidateSignature = eventSignature(candidate);
  const currentSignature = eventSignature(current);
  return candidateSignature < currentSignature ? -1 : candidateSignature > currentSignature ? 1 : 0;
}

/**
 * Collapse only a technical duplicate proven by a stable emission id. Rows
 * without that id retain their full observed count and are marked as
 * unavailable for deduplication. Pagination uses the ordered grouped fields;
 * no provider identifier is an emission-id substitute.
 */
export function collapseTechnicalDuplicates(inputRows = []) {
  const rows = inputRows.map(normalizeEventRow);
  const keptByKey = new Map();
  const kept = [];
  let rawObserved = 0;
  let observed = 0;
  let removed = 0;
  let dedupUnavailable = 0;
  for (const row of rows) {
    const count = Math.max(0, numberOr(row.observed, 1));
    rawObserved += count;
    const dedupKey = row.emissionId ? `emission:${row.emissionId}` : '';
    if (!dedupKey) {
      dedupUnavailable += count;
      kept.push({ ...row, observed: count });
      observed += count;
      continue;
    }
    const retained = count > 0 ? 1 : 0;
    const candidate = { ...row, observed: retained };
    const existing = keptByKey.get(dedupKey);
    if (!existing) {
      const entry = { row: candidate, index: kept.length };
      keptByKey.set(dedupKey, entry);
      kept.push(candidate);
      observed += retained;
      removed += Math.max(0, count - retained);
      continue;
    }

    removed += count;
    if (compareTechnicalDuplicateRows(candidate, existing.row) > 0) {
      kept[existing.index] = candidate;
      observed += retained - existing.row.observed;
      existing.row = candidate;
    }
  }
  return { rows: kept, rawObserved, observed, removed, dedupUnavailable };
}

function pathSegments(pathname) {
  const raw = normalizeText(pathname).split('?')[0].split('#')[0];
  return raw.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment).toLowerCase(); } catch { return segment.toLowerCase(); }
  });
}

function routeIdentity(pathname) {
  const segments = pathSegments(pathname);
  // Sector hubs deliberately share the `/section/<slug>/` shape with job
  // details. Their page views have no employer/job identity and must remain
  // residual traffic; resolving the hub slug against the job catalog would
  // inflate an employer's denominator (e.g. `/infermieri/` versus the LIS
  // detail slug) while apply clicks remain correctly attributed.
  if (isJobBoardSectorHubPath(pathname)) return null;
  for (const segment of segments) {
    const prefix = COMPANY_HUB_PREFIXES.find((candidate) => segment.startsWith(candidate) && segment.length > candidate.length);
    if (prefix) return { kind: 'company', alias: segment.slice(prefix.length) };
  }
  for (let i = 0; i < segments.length - 1; i++) {
    if (COMPANY_HUB_SEGMENTS.has(segments[i])) return { kind: 'company', alias: segments[i + 1] };
  }
  const sectionIndex = segments.findIndex((segment) => JOB_BOARD_SECTION_RX.test(segment) || HISTORICAL_JOB_SECTION_RX.test(segment));
  if (sectionIndex >= 0 && segments[sectionIndex + 1]) return { kind: 'job', alias: segments[sectionIndex + 1] };
  return null;
}

function resolveUnique(map, value) {
  for (const alias of aliasesFor(value)) {
    const values = map.get(alias);
    if (!values) continue;
    if (values.size === 1) return { value: [...values][0], ambiguous: false };
    if (values.size > 1) return { value: null, ambiguous: true };
  }
  return null;
}

function resolveJobById(catalog, value) {
  const key = normalizeText(value);
  if (!key) return null;
  const job = catalog.jobsById.get(key);
  return job ? { job, ambiguous: false } : null;
}

function resolveJobAlias(catalog, alias, companyKey = null) {
  const result = resolveUnique(catalog.jobAliasToIds, alias);
  if (!result) return null;
  if (!result.ambiguous) return result;
  if (!companyKey) return result;
  const candidates = [...(catalog.jobAliasToIds.get(normalizeAlias(alias)) || [])]
    .map((jobId) => catalog.jobsById.get(jobId))
    .filter((job) => job?.companyKey === companyKey);
  if (candidates.length === 1) return { value: candidates[0].id, ambiguous: false };
  return result;
}

/** Resolve one event without a company-name substring fallback. */
export function resolveEventIdentity(sourceRow, catalog) {
  const row = normalizeEventRow(sourceRow);
  const route = routeIdentity(row.path);
  const jobIdResult = resolveJobById(catalog, row.jobId) || resolveJobById(catalog, row.providerId);
  if (jobIdResult) return { scope: 'job', job: jobIdResult.job, row };

  const explicitJobAliases = [...new Set([
    row.jobSlug,
    route?.kind === 'job' ? route.alias : '',
  ].map(normalizeAlias).filter(Boolean))];
  const explicitCompanyAlias = row.employerKey || (route?.kind === 'company' ? route.alias : '')
    || (row.itemId ? row.itemId.split('_')[0] : '');
  const companyResult = explicitCompanyAlias
    ? resolveUnique(catalog.companyAliasToKeys, explicitCompanyAlias)
    : null;
  const companyKey = companyResult?.value || null;
  if (explicitJobAliases.length) {
    let ambiguousJobAlias = false;
    for (const explicitJobAlias of explicitJobAliases) {
      const jobResult = resolveJobAlias(catalog, explicitJobAlias, companyKey);
      if (jobResult?.value) return { scope: 'job', job: catalog.jobsById.get(jobResult.value), row };
      if (jobResult?.ambiguous) ambiguousJobAlias = true;
    }
    if (ambiguousJobAlias) return { residual: 'ambiguous_job_alias', row };
    if (companyResult?.ambiguous) return { residual: 'ambiguous_company_alias', row };
    if (companyKey) return { scope: 'company', companyKey, row, identityFallback: 'explicit_company_alias' };
    return { residual: 'unknown_job_alias', row };
  }

  if (row.jobId || row.providerId) {
    if (companyResult?.ambiguous) return { residual: 'ambiguous_company_alias', row };
    if (companyKey) return { scope: 'company', companyKey, row, identityFallback: 'explicit_company_alias' };
    return { residual: 'unknown_job_id', row };
  }

  if (explicitCompanyAlias) {
    if (companyResult?.ambiguous) return { residual: 'ambiguous_company_alias', row };
    if (companyKey) return { scope: 'company', companyKey, row };
    return { residual: 'unknown_company_alias', row };
  }

  return { residual: 'unidentified_event', row };
}

function isPageview(row) {
  return row.event === '$pageview' || row.event === 'pageview' || row.event === 'page_view';
}

function isApplyClick(row) {
  return row.event === 'job_apply' || (row.event === 'select_content' && APPLY_CONTENT_TYPES.has(row.contentType));
}

function ensureCompanyState(states, catalog, companyKey) {
  if (!states.has(companyKey)) {
    states.set(companyKey, {
      ads: new Map(),
      views: 0,
      visitors: 0,
      profileViews: 0,
      profileVisitors: 0,
      applyClicks: 0,
      applyClickUsers: 0,
      eventsObserved: 0,
      eventTypes: new Map(),
      trend: new Map(),
      applyClickTrend: new Map(),
      profileTrend: new Map(),
      companyPaths: new Set(),
    });
  }
  const state = states.get(companyKey);
  if (!state.companyName) state.companyName = catalog.companyNameByKey.get(companyKey) || companyKey;
  return state;
}

function canonicalJobSlug(job) {
  return normalizeText(job.slug) || normalizeText(job.slugByLocale?.it) || [...jobAliases(job)][0] || job.id;
}

function jobPath(job) {
  const section = resolveCantonSection('it', resolveJobCanton(job));
  return `/${section}/${canonicalJobSlug(job)}/`;
}

function ensureAd(state, job) {
  if (!state.ads.has(job.id)) {
    state.ads.set(job.id, {
      jobId: job.id,
      slug: canonicalJobSlug(job),
      title: normalizeText(job.title) || normalizeText(job.titleByLocale?.it) || canonicalJobSlug(job),
      path: jobPath(job),
      views: 0,
      visitors: 0,
      applyClicks: 0,
      applyClickUsers: 0,
      eventsObserved: 0,
      eventTypes: new Map(),
      trend: new Map(),
    });
  }
  return state.ads.get(job.id);
}

function addMetric(map, key, amount) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function residualLedger() {
  return Object.create(null);
}

function addResidual(residuals, reason, amount) {
  residuals[reason] = (residuals[reason] || 0) + amount;
}

/** Aggregate the event union and return both metrics and the coverage ledger. */
export function aggregateEmployerEvents(inputRows = [], { catalog, window, source = 'posthog' } = {}) {
  catalog ||= buildIdentityCatalog();
  const effectiveWindow = window || { from: '1970-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z' };
  const normalizedRows = inputRows.map(normalizeEventRow);
  const invalidTimestampRows = normalizedRows.filter((row) => !row.timestamp);
  const windowRows = normalizedRows
    .filter((row) => row.timestamp && inWindow(row.timestamp, effectiveWindow));
  const deduped = collapseTechnicalDuplicates(windowRows);
  const invalidTimestampDeduped = collapseTechnicalDuplicates(invalidTimestampRows);
  const states = new Map();
  const residuals = residualLedger();
  for (const sourceRow of invalidTimestampDeduped.rows) {
    addResidual(residuals, 'invalid_timestamp', Math.max(0, numberOr(sourceRow.observed, 1)));
  }
  let attributed = 0;
  let eventRowsAttributed = 0;

  for (const sourceRow of deduped.rows) {
    const count = Math.max(0, numberOr(sourceRow.observed, 1));
    const resolved = resolveEventIdentity(sourceRow, catalog);
    if (resolved.residual) {
      addResidual(residuals, resolved.residual, count);
      continue;
    }
    const job = resolved.job;
    const companyKey = job?.companyKey || resolved.companyKey;
    if (!companyKey) {
      addResidual(residuals, 'unidentified_event', count);
      continue;
    }
    attributed += count;
    eventRowsAttributed += 1;
    const state = ensureCompanyState(states, catalog, companyKey);
    state.eventsObserved += count;
    addMetric(state.eventTypes, sourceRow.event || 'unknown', count);
    if (sourceRow.path) state.companyPaths.add(sourceRow.path);
    const pageview = isPageview(sourceRow);
    const applyClick = isApplyClick(sourceRow);
    const views = pageview ? (sourceRow.views == null ? count : numberOr(sourceRow.views, count)) : 0;
    const visitors = pageview ? numberOr(sourceRow.visitors || sourceRow.persons, 0) : 0;
    const clicks = applyClick ? (sourceRow.clicks == null ? count : numberOr(sourceRow.clicks, count)) : 0;
    // GA4/PostHog expose users per grouped row, not a cross-window user union.
    // Keep the observed units for context, but never present them as named or
    // globally unique people.
    const applyClickUsers = applyClick ? numberOr(sourceRow.persons, 0) : 0;
    state.applyClicks += clicks;
    state.applyClickUsers += applyClickUsers;
    if (job) {
      state.views += views;
      state.visitors += visitors;
      const ad = ensureAd(state, job);
      ad.eventsObserved += count;
      addMetric(ad.eventTypes, sourceRow.event || 'unknown', count);
      ad.views += views;
      ad.visitors += visitors;
      ad.applyClicks += clicks;
      ad.applyClickUsers += applyClickUsers;
      const week = sourceRow.week || ((pageview || applyClick) ? weekStart(sourceRow.timestamp) : null);
      if (pageview && week) addMetric(ad.trend, week, views);
      if (applyClick && week) addMetric(state.applyClickTrend, week, clicks);
    } else if (pageview) {
      state.profileViews += views;
      state.profileVisitors += visitors;
      const week = sourceRow.week || weekStart(sourceRow.timestamp);
      if (week) addMetric(state.profileTrend, week, views);
    }
  }

  const residualTotal = Object.values(residuals).reduce((sum, value) => sum + value, 0);
  const rawObserved = deduped.rawObserved + invalidTimestampDeduped.rawObserved;
  const observed = deduped.observed + invalidTimestampDeduped.observed;
  const coverage = {
    source,
    status: observed > 0 ? 'observed' : 'zero_observed',
    rawObserved,
    observed,
    attributed,
    residuals,
    residualTotal,
    technicalDuplicatesRemoved: deduped.removed + invalidTimestampDeduped.removed,
    dedupUnavailable: deduped.dedupUnavailable + invalidTimestampDeduped.dedupUnavailable,
    deduplication: {
      key: 'emission_id',
      status: (deduped.dedupUnavailable + invalidTimestampDeduped.dedupUnavailable) > 0 ? 'dedup non disponibile' : 'available',
      unavailableCount: deduped.dedupUnavailable + invalidTimestampDeduped.dedupUnavailable,
    },
    invariant: attributed + residualTotal === observed,
    attributedRows: eventRowsAttributed,
  };
  return { states, coverage, dedupedRows: deduped.rows };
}

function emptyApplicationEvidence(status = 'source_unavailable') {
  return {
    source: 'firestore',
    status,
    available: status !== 'source_unavailable',
    byJob: new Map(),
    observed: 0,
    attributed: 0,
    residuals: residualLedger(),
    residualTotal: 0,
    technicalDuplicatesRemoved: 0,
    retentionDays: 90,
    invariant: true,
  };
}

/** Aggregate submit proofs from the applications collection for one window. */
export function aggregateApplicationEvidence(records = [], { window, catalog } = {}) {
  if (records && !Array.isArray(records) && Array.isArray(records.records)) records = records.records;
  catalog ||= buildIdentityCatalog();
  const evidence = emptyApplicationEvidence('zero_observed');
  const seenIds = new Set();
  for (const source of records || []) {
    const id = normalizeText(source?.id || source?.applicationId);
    if (id && seenIds.has(id)) {
      evidence.technicalDuplicatesRemoved += 1;
      continue;
    }
    if (id) seenIds.add(id);
    const createdAt = toIso(source?.createdAt || source?.submittedAt);
    if (!createdAt) {
      evidence.observed += 1;
      addResidual(evidence.residuals, 'invalid_timestamp', 1);
      continue;
    }
    if (!inWindow(createdAt, window)) continue;
    evidence.observed += 1;
    const jobIdResult = resolveJobById(catalog, source?.jobId || source?.publisherJobId);
    const slugResult = !jobIdResult ? resolveUnique(catalog.jobAliasToIds, source?.jobSlug || source?.slug) : null;
    const job = jobIdResult?.job || (slugResult?.value ? catalog.jobsById.get(slugResult.value) : null);
    if (!job) {
      addResidual(evidence.residuals, slugResult?.ambiguous ? 'ambiguous_application_job_alias' : 'unknown_application_job', 1);
      continue;
    }
    evidence.attributed += 1;
    const forwardedAt = toIso(source?.forwardedAt);
    const previous = evidence.byJob.get(job.id) || { applications: 0, forwardedAt: null, forwarded: 0 };
    previous.applications += 1;
    if (forwardedAt && (!previous.forwardedAt || forwardedAt > previous.forwardedAt)) previous.forwardedAt = forwardedAt;
    if (forwardedAt) previous.forwarded += 1;
    evidence.byJob.set(job.id, previous);
  }
  evidence.residualTotal = Object.values(evidence.residuals).reduce((sum, value) => sum + value, 0);
  evidence.status = evidence.observed > 0 ? 'observed' : 'zero_observed';
  evidence.retentionDays = 90;
  evidence.window = window || null;
  evidence.invariant = evidence.attributed + evidence.residualTotal === evidence.observed;
  return evidence;
}

function applicationStatusFor(evidence) {
  if (!evidence || evidence.status === 'source_unavailable') return { applications: null, forwardedAt: null, status: 'source_unavailable' };
  return { applications: 0, forwardedAt: null, status: 'zero_observed' };
}

function serializeEventTypes(types) {
  return Object.fromEntries([...types.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function serializeTrend(trend, extras = {}) {
  const weeks = new Set(trend.keys());
  for (const extra of Object.values(extras)) {
    for (const week of extra.keys()) weeks.add(week);
  }
  return [...weeks]
    .sort((a, b) => a.localeCompare(b))
    .map((week) => {
      const point = { week, views: trend.get(week) || 0 };
      for (const [name, extra] of Object.entries(extras)) {
        if (extra.has(week)) point[name] = extra.get(week) || 0;
      }
      return point;
    });
}

function queryCoverageOrDefault(queryCoverage, coverage, window) {
  const query = queryCoverage || {};
  const pageSize = query.pageSize ?? EVENT_QUERY_PAGE_SIZE;
  return {
    limit: pageSize,
    pageSize,
    totalBeforeCut: query.totalBeforeCut ?? query.sourceObserved ?? coverage.rawObserved,
    groupRowsBeforeCut: query.groupRowsBeforeCut ?? query.totalRows ?? null,
    returned: query.returned ?? coverage.rawObserved,
    returnedRows: query.returnedRows ?? query.rowsReturned ?? null,
    pages: query.pages ?? null,
    truncated: Boolean(query.truncated),
    queryHash: query.queryHash || null,
    snapshotId: query.snapshotId || null,
    sourceObserved: query.sourceObserved ?? coverage.rawObserved,
    sourceResponse: query.sourceResponse ?? null,
    sourceResponseRows: query.sourceResponseRows ?? null,
    groupedResponse: query.groupedResponse ?? null,
    groupedResponseRows: query.groupedResponseRows ?? null,
    from: window.from,
    to: window.to,
  };
}

/**
 * Serialize a complete dry-run envelope without changing the calculation.
 * The workflow validates this envelope before it is allowed to call --apply.
 */
export function buildDryRunPayload({
  documents = [],
  generatedAt,
  source,
  window,
  queryCoverage = {},
} = {}) {
  if (!Array.isArray(documents)) throw new Error('dry-run documents must be an array');
  if (!window?.from || !window?.to || !window?.timezone) throw new Error('dry-run window must include from, to and timezone');
  assertEmployerInsightsSource(source);
  const normalizedCoverage = queryCoverageOrDefault(queryCoverage, { rawObserved: null }, window);
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    generatedAt,
    source,
    window,
    coverage: {
      source,
      sourceObserved: normalizedCoverage.sourceObserved,
      totalRows: normalizedCoverage.groupRowsBeforeCut,
      returnedRows: normalizedCoverage.returnedRows,
      returned: normalizedCoverage.returned,
      pages: normalizedCoverage.pages,
      pageSize: normalizedCoverage.pageSize,
      truncated: normalizedCoverage.truncated,
      queryHash: normalizedCoverage.queryHash,
      snapshotId: normalizedCoverage.snapshotId,
      sourceResponse: normalizedCoverage.sourceResponse,
      sourceResponseRows: normalizedCoverage.sourceResponseRows,
      groupedResponse: normalizedCoverage.groupedResponse,
      groupedResponseRows: normalizedCoverage.groupedResponseRows,
    },
    documents,
  };
}

function applicationCoverageOrDefault(evidence) {
  const app = evidence || emptyApplicationEvidence();
  return {
    source: app.source,
    status: app.status,
    available: app.available,
    observed: app.observed,
    attributed: app.attributed,
    residuals: { ...app.residuals },
    residualTotal: app.residualTotal,
    technicalDuplicatesRemoved: app.technicalDuplicatesRemoved,
    retentionDays: app.retentionDays ?? 90,
    window: app.window || null,
    invariant: app.invariant,
  };
}

function selectWindowSummary(doc) {
  return {
    window: doc.window,
    totals: doc.totals,
    trend: doc.trend,
    topAd: doc.topAd,
    ads: doc.ads,
    profileTrend: doc.profileTrend,
    applicationsCoverage: doc.applicationsCoverage,
    coverage: doc.coverage,
    limits: doc.limits,
  };
}

/**
 * @param {{
 *   eventRows?: any[],
 *   catalog?: any,
 *   window?: {from: string, to: string, kind?: string, timezone?: string},
 *   applicationEvidence?: any,
 *   generatedAt?: string,
 *   queryCoverage?: any,
 *   onlyCompanyKey?: string|null,
 *   additionalWindows?: Record<string, any>,
 * }} options
 * @returns {any[]}
 */
export function buildInsightsDocuments({
  eventRows = [],
  catalog,
  window,
  applicationEvidence,
  generatedAt = new Date().toISOString(),
  source = 'posthog',
  queryCoverage,
  onlyCompanyKey = null,
  additionalWindows = {},
} = {}) {
  if (!catalog) throw new Error('identity catalog required');
  if (!window?.from || !window?.to) throw new Error('explicit window required');
  assertEmployerInsightsSource(source);
  const aggregate = aggregateEmployerEvents(eventRows, { catalog, window, source });
  const evidence = Array.isArray(applicationEvidence)
    ? aggregateApplicationEvidence(applicationEvidence, { catalog, window })
    : applicationEvidence || emptyApplicationEvidence();
  const states = aggregate.states;

  // A valid catalog is an observed population when the event query returns
  // no rows. Keep that state visible as zero_observed instead of conflating it
  // with a missing company or an unavailable source. A non-empty residual
  // result remains residual-only, so an ambiguous alias cannot manufacture a
  // company document.
  if (aggregate.coverage.observed === 0) {
    for (const companyKey of catalog.companyNameByKey.keys()) {
      ensureCompanyState(states, catalog, companyKey);
    }
  }

  for (const [jobId, app] of (evidence.byJob instanceof Map ? evidence.byJob.entries() : [])) {
    const job = catalog.jobsById.get(jobId);
    if (!job) continue;
    const state = ensureCompanyState(states, catalog, job.companyKey);
    const ad = ensureAd(state, job);
    ad.applicationEvidence = app;
  }

  const docs = [];
  for (const [companyKey, state] of states.entries()) {
    if (onlyCompanyKey && companyKey !== normalizeAlias(onlyCompanyKey)) continue;
    const ads = [...state.ads.values()].map((ad) => {
      const app = ad.applicationEvidence;
      const unavailable = applicationStatusFor(evidence);
      return {
        jobId: ad.jobId,
        slug: ad.slug,
        title: ad.title,
        path: ad.path,
        views: ad.views,
        visitors: ad.visitors,
        applyClicks: ad.applyClicks,
        applyClickUsers: ad.applyClickUsers,
        eventsObserved: ad.eventsObserved,
        eventTypes: serializeEventTypes(ad.eventTypes),
        applications: app ? app.applications : unavailable.applications,
        applicationsStatus: app ? 'observed' : unavailable.status,
        forwardedAt: app?.forwardedAt || unavailable.forwardedAt,
        delivery: DELIVERY_UNAVAILABLE,
        trend: serializeTrend(ad.trend),
      };
    }).sort((a, b) => b.views - a.views || a.slug.localeCompare(b.slug));
    const totalsApplications = evidence.status === 'source_unavailable'
      ? null
      : ads.reduce((sum, ad) => sum + numberOr(ad.applications, 0), 0);
    const forwardedAt = ads.map((ad) => ad.forwardedAt).filter(Boolean).sort().at(-1) || null;
    const jobTrend = ads.flatMap((ad) => ad.trend);
    for (const point of jobTrend) addMetric(state.trend, point.week, point.views);
    const trend = serializeTrend(state.trend, { applyClicks: state.applyClickTrend });
    const profileTrend = serializeTrend(state.profileTrend);
    const eventLimits = queryCoverageOrDefault(queryCoverage, aggregate.coverage, window);
    const doc = {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      companyKey,
      companyName: state.companyName || catalog.companyNameByKey.get(companyKey) || companyKey,
      generatedAt,
      source,
      window: { ...window, inclusive: '[from,to)' },
      totals: {
        views: state.views,
        visitors: state.visitors,
        profileViews: state.profileViews,
        profileVisitors: state.profileVisitors,
        applyClicks: state.applyClicks,
        applyClickUsers: state.applyClickUsers,
        adsCount: ads.length,
        applications: totalsApplications,
        applicationsStatus: evidence.status === 'source_unavailable'
          ? 'source_unavailable'
          : totalsApplications > 0 ? 'observed' : 'zero_observed',
        forwardedAt,
        delivery: DELIVERY_UNAVAILABLE,
      },
      topAd: ads[0] ? { slug: ads[0].slug, title: ads[0].title, views: ads[0].views } : null,
      ads,
      trend,
      profileTrend,
      coverage: {
        ...aggregate.coverage,
        sourceResponse: eventLimits.sourceResponse,
        sourceResponseRows: eventLimits.sourceResponseRows,
        residuals: { ...aggregate.coverage.residuals },
        identityResolution: {
          method: 'explicit_alias',
          substringFallback: false,
          catalogSha: catalog.identityCatalogSha,
          collisions: { ...catalog.collisions },
          visitors: {
            identifier: 'person_id',
            aggregation: 'sum_distinct_per_event_group',
            globalUnique: false,
          },
          applyClickUsers: {
            identifier: 'person_id',
            aggregation: 'sum_per_apply_event_group',
            globalUnique: false,
            pii: false,
          },
        },
      },
      applicationsCoverage: applicationCoverageOrDefault(evidence),
      limits: {
        adsSerialized: { limit: null, total: ads.length, returned: ads.length, truncated: false },
        events: eventLimits,
      },
      provenance: {
        source,
        buildSha: BUILD_SHA,
        snapshotId: eventLimits.snapshotId,
        queryHash: eventLimits.queryHash,
        identityCatalogSha: catalog.identityCatalogSha,
        window: { ...window },
        rowsReturned: eventLimits.returnedRows,
        returned: eventLimits.returned,
        totalRows: eventLimits.totalBeforeCut,
        sourceObserved: eventLimits.sourceObserved,
        groupedRowsBeforeCut: eventLimits.groupRowsBeforeCut,
        pages: eventLimits.pages,
        pageSize: eventLimits.pageSize,
        truncated: eventLimits.truncated,
        sourceResponse: eventLimits.sourceResponse,
        sourceResponseRows: eventLimits.sourceResponseRows,
        groupedResponse: eventLimits.groupedResponse,
        groupedResponseRows: eventLimits.groupedResponseRows,
      },
    };
    if (Object.keys(additionalWindows).length) doc.additionalWindows = additionalWindows;
    docs.push(doc);
  }
  docs.sort((a, b) => b.totals.views - a.totals.views || a.companyKey.localeCompare(b.companyKey));
  return docs;
}

async function hogql(query) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');
  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!response.ok) throw new Error(`posthog ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()).results || [];
}

function hogqlDate(iso) {
  return String(iso).replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// Every grouped event row needs a cursor discriminator that cannot be empty.
// PostHog installations expose the identity in different places, so prefer
// the stable provider ids and fall back to the complete grouped identity.
const EVENT_KEY_EXPRESSION = [
  'coalesce(',
  "nullIf(toString(properties.$insert_id), ''),",
  "nullIf(toString(properties.$event_id), ''),",
  "nullIf(toString(uuid), ''),",
  "concat(toString(timestamp), '|', toString(event), '|',",
  "coalesce(toString(properties.$pathname), ''), '|',",
  "coalesce(toString(properties.job_slug), ''), '|',",
  "coalesce(toString(properties.job_id), ''), '|',",
  "coalesce(toString(properties.publisher_job_id), ''), '|',",
  "coalesce(toString(properties.employer_key), ''), '|',",
  "coalesce(toString(properties.item_id), ''), '|',",
  "coalesce(toString(properties.content_type), ''), '|',",
  "coalesce(toString(properties.emission_id), ''))",
  ')',
].join(' ');

const EVENT_CURSOR_TIMESTAMP_INDEX = 16;
const EVENT_CURSOR_FIELDS = [
  { name: 'event', index: 17, alias: 'cursor_event', expression: 'toString(event)', objectKeys: ['cursor_event', 'event'] },
  { name: 'week', index: 18, alias: 'cursor_week', expression: 'toString(toStartOfWeek(timestamp))', objectKeys: ['cursor_week', 'week'] },
  { name: 'path', index: 19, alias: 'cursor_path', expression: "coalesce(toString(properties.$pathname), '')", objectKeys: ['cursor_path', 'path'] },
  { name: 'jobSlug', index: 20, alias: 'cursor_job_slug', expression: "coalesce(toString(properties.job_slug), '')", objectKeys: ['cursor_job_slug', 'jobSlug', 'job_slug'] },
  { name: 'jobId', index: 21, alias: 'cursor_job_id', expression: "coalesce(toString(properties.job_id), '')", objectKeys: ['cursor_job_id', 'jobId', 'job_id'] },
  { name: 'providerId', index: 22, alias: 'cursor_provider_id', expression: "coalesce(toString(properties.publisher_job_id), '')", objectKeys: ['cursor_provider_id', 'providerId', 'provider_id'] },
  { name: 'employerKey', index: 23, alias: 'cursor_employer_key', expression: "coalesce(toString(properties.employer_key), '')", objectKeys: ['cursor_employer_key', 'employerKey', 'employer_key'] },
  { name: 'itemId', index: 24, alias: 'cursor_item_id', expression: "coalesce(toString(properties.item_id), '')", objectKeys: ['cursor_item_id', 'itemId', 'item_id'] },
  { name: 'contentType', index: 25, alias: 'cursor_content_type', expression: "coalesce(toString(properties.content_type), '')", objectKeys: ['cursor_content_type', 'contentType', 'content_type'] },
  { name: 'emissionId', index: 26, alias: 'cursor_emission_id', expression: "coalesce(toString(properties.emission_id), '')", objectKeys: ['cursor_emission_id', 'emissionId', 'emission_id'] },
  { name: 'eventKey', index: 27, alias: 'cursor_event_key', expression: EVENT_KEY_EXPRESSION, objectKeys: ['cursor_event_key', 'eventKey', 'event_key'] },
];

function hogqlString(value) {
  return "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
}

function hogqlTimestamp(value) {
  const match = String(value ?? '').trim().match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) throw new Error('invalid PostHog cursor timestamp');
  const [, datePart, hour, minute, second, rawFraction = '', zone = ''] = match;
  const fraction = rawFraction.slice(0, 6).padEnd(6, '0');
  if (!zone || zone === 'Z') return `${datePart} ${hour}:${minute}:${second}.${fraction}`;

  const sign = zone[0] === '+' ? 1 : -1;
  const offsetDigits = zone.slice(1).replace(':', '');
  const offsetHours = Number(offsetDigits.slice(0, 2));
  const offsetMinutes = Number(offsetDigits.slice(2, 4));
  if (offsetHours > 23 || offsetMinutes > 59) throw new Error('invalid PostHog cursor timestamp offset');
  const [year, month, day] = datePart.split('-').map(Number);
  const base = Date.UTC(year, month - 1, day, Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(base)) throw new Error('invalid PostHog cursor timestamp');
  const utc = new Date(base - sign * (offsetHours * 60 + offsetMinutes) * 60_000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} `
    + `${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}.${fraction}`;
}

function cursorFieldValue(row, field) {
  if (Array.isArray(row)) return row[field.index];
  for (const key of field.objectKeys) {
    if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
  }
  return undefined;
}

function eventCursorFromRow(row) {
  const timestamp = Array.isArray(row)
    ? row[EVENT_CURSOR_TIMESTAMP_INDEX]
    : row?.cursorTimestamp ?? row?.cursor_timestamp ?? row?.timestamp;
  const values = EVENT_CURSOR_FIELDS.map((field) => [field.name, cursorFieldValue(row, field)]);
  const eventKey = values.find(([name]) => name === 'eventKey')?.[1];
  if (
    timestamp == null
    || timestamp === ''
    || values.some(([, value]) => value == null)
    || eventKey === ''
  ) return null;
  return {
    timestamp: String(timestamp),
    ...Object.fromEntries(values.map(([name, value]) => [name, String(value)])),
  };
}

function compareCursorText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'));
}

function compareEventCursors(left, right) {
  const timestampResult = compareCursorText(hogqlTimestamp(left.timestamp), hogqlTimestamp(right.timestamp));
  if (timestampResult !== 0) return timestampResult;
  for (const field of EVENT_CURSOR_FIELDS) {
    const result = compareCursorText(left[field.name], right[field.name]);
    if (result !== 0) return result;
  }
  return 0;
}

function eventCursorFilter(cursor, cursorTimestamp) {
  const clauses = EVENT_CURSOR_FIELDS.map((field, index) => {
    const equalPrefix = EVENT_CURSOR_FIELDS
      .slice(0, index)
      .map((prefix) => `${prefix.expression} = ${hogqlString(cursor[prefix.name])}`)
      .join('\n        AND ');
    return `${equalPrefix ? equalPrefix + '\n        AND ' : ''}${field.expression} > ${hogqlString(cursor[field.name])}`;
  });
  return '\n      AND (\n        timestamp > ' + cursorTimestamp
    + '\n        OR (timestamp = ' + cursorTimestamp
    + '\n          AND (\n            ' + clauses.join('\n            OR ')
    + '\n          )\n        )\n      )';
}

function eventSelect(window, cursor = null) {
  const from = hogqlDate(window.from);
  const to = hogqlDate(window.to);
  const cursorTimestamp = cursor
    ? 'toDateTime64(' + hogqlString(hogqlTimestamp(cursor.timestamp)) + ', 6)'
    : null;
  const cursorFilter = cursor
    ? eventCursorFilter(cursor, cursorTimestamp)
    : '';
  const cursorSelect = EVENT_CURSOR_FIELDS
    .map((field) => `${field.expression} AS ${field.alias}`)
    .join(',\n      ');
  const cursorOrder = EVENT_CURSOR_FIELDS.map((field) => field.alias).join(', ');
  return `
    SELECT
      '' AS unused_cursor_slot,
      event,
      toString(toStartOfWeek(timestamp)) AS week,
      coalesce(toString(properties.$pathname), '') AS path,
      coalesce(toString(properties.job_slug), '') AS job_slug,
      coalesce(toString(properties.job_id), '') AS job_id,
      coalesce(toString(properties.publisher_job_id), '') AS provider_id,
      coalesce(toString(properties.employer_key), '') AS employer_key,
      coalesce(toString(properties.item_id), '') AS item_id,
      coalesce(toString(properties.content_type), '') AS content_type,
      count() AS observed,
      count(DISTINCT person_id) AS persons,
      count(DISTINCT properties.$session_id) AS sessions,
      countIf(event IN ('$pageview', 'pageview')) AS views,
      countIf(event = 'job_apply' OR (event = 'select_content' AND properties.content_type IN ('job_board_apply','job_board_apply_header_logo','job_board_apply_header_title'))) AS clicks,
      coalesce(toString(properties.emission_id), '') AS emission_id,
      toString(timestamp) AS timestamp,
      ${cursorSelect}
    FROM events
    WHERE timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}')${cursorFilter}
    GROUP BY event, week, path, job_slug, job_id, provider_id,
             employer_key, item_id, content_type, emission_id, timestamp,
             ${EVENT_KEY_EXPRESSION}
    ORDER BY cursor_timestamp, ${cursorOrder}
  `.trim();
}

function eventCountSelect(window) {
  return `
    SELECT count() AS total
    FROM events
    WHERE timestamp >= toDateTime('${hogqlDate(window.from)}')
      AND timestamp < toDateTime('${hogqlDate(window.to)}')
  `.trim();
}

function readPostHogCountResult(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`posthog ${label} count response unavailable`);
  }
  const first = rows[0];
  const raw = Array.isArray(first) ? first[0] : first?.total;
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`posthog ${label} count response invalid`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`posthog ${label} count response invalid`);
  }
  return {
    count: Math.max(0, Math.trunc(value)),
    response: 'present',
    rawRows: rows.length,
  };
}

export async function queryEventRows(window, { query: runQuery = hogql, pageSize = EVENT_QUERY_PAGE_SIZE } = {}) {
  const baseQuery = eventSelect(window);
  const queryHash = sha256(baseQuery);
  const [countRows, sourceCountRows] = await Promise.all([
    runQuery('SELECT count() AS total FROM (' + baseQuery + ')'),
    runQuery(eventCountSelect(window)),
  ]);
  const groupedCount = readPostHogCountResult(countRows, 'grouped');
  const sourceCount = readPostHogCountResult(sourceCountRows, 'source');
  const groupedRowsBeforeCut = groupedCount.count;
  const sourceObserved = sourceCount.count;
  const rows = [];
  let pages = 0;
  let cursor = null;
  while (true) {
    const pageRows = await runQuery(eventSelect(window, cursor) + ' LIMIT ' + pageSize);
    rows.push(...pageRows);
    pages += 1;
    if (!pageRows.length) break;
    const nextCursor = eventCursorFromRow(pageRows.at(-1));
    if (!nextCursor) throw new Error('posthog page missing keyset cursor');
    if (cursor && compareEventCursors(nextCursor, cursor) <= 0) {
      throw new Error('posthog keyset cursor did not advance');
    }
    cursor = nextCursor;
    if (groupedRowsBeforeCut > 0 && rows.length >= groupedRowsBeforeCut) break;
    if (groupedRowsBeforeCut === 0 && pageRows.length < pageSize) break;
  }
  const truncated = rows.length < groupedRowsBeforeCut;
  const returnedObserved = rows.reduce((sum, row) => sum + Math.max(0, numberOr(Array.isArray(row) ? row[10] : row.observed, 1)), 0);
  return {
    rows,
    coverage: {
      pageSize,
      totalRows: groupedRowsBeforeCut,
      groupRowsBeforeCut: groupedRowsBeforeCut,
      totalBeforeCut: sourceObserved,
      rowsReturned: rows.length,
      returned: returnedObserved,
      returnedRows: rows.length,
      pages,
      truncated,
      queryHash,
      snapshotId: sha256(`${queryHash}:${window.from}:${window.to}`),
      sourceObserved,
      sourceResponse: sourceCount.response,
      sourceResponseRows: sourceCount.rawRows,
      groupedResponse: groupedCount.response,
      groupedResponseRows: groupedCount.rawRows,
    },
  };
}

/** Do not hand a partial event snapshot to the document builder. */
export function assertCompleteEventCoverage(coverage) {
  if (coverage?.truncated) {
    throw new Error(
      `employer insights event query truncated (${coverage.rowsReturned ?? 0}/${coverage.totalRows ?? 0} grouped rows)`,
    );
  }
}

const GA4_INSIGHTS_EVENTS = ['page_view', 'job_apply'];

function ga4DateForValue(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`GA4 ${label} is not a valid date`);
  return parsed.toISOString().slice(0, 10);
}

function ga4DateForWindowEnd(window) {
  const end = Date.parse(window.to) - DAY_MS;
  if (!Number.isFinite(end)) throw new Error('GA4 window.to is not a valid date');
  return ga4DateForValue(new Date(end), 'window.to');
}

function ga4DimensionValue(row, index) {
  const cell = row?.dimensionValues?.[index];
  const value = cell && typeof cell === 'object' ? cell.value : cell;
  return value === '(not set)' || value === '(other)' ? '' : normalizeText(value);
}

function ga4MetricValue(row, index) {
  const cell = row?.metricValues?.[index];
  const value = cell && typeof cell === 'object' ? cell.value : cell;
  return Math.max(0, numberOr(value, 0));
}

function ga4DayTimestamp(value) {
  const compact = String(value || '').replaceAll('-', '');
  if (!/^\d{8}$/.test(compact)) throw new Error(`GA4 row has invalid date: ${value || '<missing>'}`);
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00.000Z`;
}

function exactGa4EventExpression(eventName) {
  return {
    filter: {
      fieldName: 'eventName',
      stringFilter: { value: eventName, matchType: 'EXACT' },
    },
  };
}

/**
 * Keep the GA4 report contract in one place. `pagePath` is intentional: the
 * static gtag pageview has no custom employer parameters, so the existing
 * explicit route aliases can still attribute that signal without guessing.
 */
export function buildGa4EventQueryBody(window, { limit = GA4_EVENT_QUERY_PAGE_SIZE, offset = 0 } = {}) {
  const startDate = ga4DateForValue(window?.from, 'window.from');
  const endDate = ga4DateForWindowEnd(window);
  if (Date.parse(`${startDate}T00:00:00.000Z`) >= Date.parse(`${endDate}T00:00:00.000Z`) + DAY_MS) {
    throw new Error('GA4 window has no complete date');
  }
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'date' },
      { name: 'eventName' },
      { name: 'customEvent:employer_key' },
      { name: 'customEvent:job_slug' },
      { name: 'pagePath' },
    ],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
      { name: 'sessions' },
    ],
    dimensionFilter: {
      orGroup: { expressions: GA4_INSIGHTS_EVENTS.map(exactGa4EventExpression) },
    },
    orderBys: [
      { dimension: { dimensionName: 'date' } },
      { dimension: { dimensionName: 'eventName' } },
      { dimension: { dimensionName: 'customEvent:employer_key' } },
      { dimension: { dimensionName: 'customEvent:job_slug' } },
      { dimension: { dimensionName: 'pagePath' } },
    ],
    limit,
    offset,
  };
}

/** Convert one GA4 row into the event shape consumed by the shared aggregator. */
export function normalizeGa4EventRows(rows = []) {
  return rows.map((row) => {
    const event = ga4DimensionValue(row, 1);
    if (!GA4_INSIGHTS_EVENTS.includes(event)) throw new Error(`GA4 row has unsupported event: ${event || '<missing>'}`);
    const timestamp = ga4DayTimestamp(ga4DimensionValue(row, 0));
    const observed = ga4MetricValue(row, 0);
    return {
      event,
      timestamp,
      week: weekStart(timestamp),
      path: ga4DimensionValue(row, 4),
      jobSlug: ga4DimensionValue(row, 3),
      jobId: '',
      providerId: '',
      employerKey: ga4DimensionValue(row, 2),
      itemId: '',
      contentType: '',
      views: event === 'page_view' ? observed : 0,
      clicks: event === 'job_apply' ? observed : 0,
      observed,
      persons: ga4MetricValue(row, 1),
      sessions: ga4MetricValue(row, 2),
      emissionId: '',
    };
  });
}

/**
 * Read the complete selected GA4 event set. GA4 paginates with offset rather
 * than the PostHog keyset used above; rowCount and the data-loss marker are
 * retained so a high-cardinality `(other)`/short page fails closed.
 */
export async function queryGa4EventRows(
  window,
  {
    token,
    propertyId,
    report = runGa4Report,
    pageSize = GA4_EVENT_QUERY_PAGE_SIZE,
  } = {},
) {
  if (!token) throw new Error('GA4 service-account token is required');
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > GA4_EVENT_QUERY_PAGE_SIZE) {
    throw new Error(`GA4 pageSize must be an integer between 1 and ${GA4_EVENT_QUERY_PAGE_SIZE}`);
  }
  const firstBody = buildGa4EventQueryBody(window, { limit: pageSize, offset: 0 });
  const queryHash = sha256(stableJson({ ...firstBody, offset: 0 }));
  const rawRows = [];
  let totalRows = null;
  let offset = 0;
  let pages = 0;
  let dataLossFromOtherRow = false;

  while (true) {
    const data = await report({
      token,
      propertyId,
      body: { ...firstBody, offset },
    });
    const reportedRows = Number(data?.rowCount);
    if (Number.isFinite(reportedRows) && reportedRows >= 0) {
      if (totalRows !== null && totalRows !== reportedRows) {
        throw new Error(`GA4 rowCount changed during pagination: ${totalRows} → ${reportedRows}`);
      }
      totalRows = Math.trunc(reportedRows);
    }
    dataLossFromOtherRow ||= data?.metadata?.dataLossFromOtherRow === true;
    const pageRows = Array.isArray(data?.rows) ? data.rows : [];
    rawRows.push(...pageRows);
    pages += 1;
    offset += pageRows.length;

    if (!pageRows.length) break;
    if (totalRows !== null && offset >= totalRows) break;
    if (totalRows === null && pageRows.length < pageSize) break;
  }

  totalRows ??= rawRows.length;
  const rows = normalizeGa4EventRows(rawRows);
  const returned = rows.reduce((sum, row) => sum + row.observed, 0);
  const identityRows = rows.filter((row) => row.employerKey);
  const identityObserved = identityRows.reduce((sum, row) => sum + row.observed, 0);
  return {
    rows,
    coverage: {
      pageSize,
      totalRows,
      groupRowsBeforeCut: totalRows,
      totalBeforeCut: returned,
      rowsReturned: rows.length,
      returned,
      returnedRows: rows.length,
      pages,
      truncated: dataLossFromOtherRow || rows.length < totalRows,
      dataLossFromOtherRow,
      identityRows: identityRows.length,
      identityObserved,
      queryHash,
      snapshotId: sha256(`${queryHash}:${window.from}:${window.to}`),
      sourceObserved: returned,
    },
  };
}

async function findSourceBounds() {
  const rows = await hogql('SELECT min(timestamp) AS source_from, max(timestamp) AS source_to FROM events');
  const row = rows?.[0] || [];
  return { from: toIso(row[0] ?? row.source_from), max: toIso(row[1] ?? row.source_to) };
}

function makeWindow(from, to, kind) {
  const fromIso = toIso(from);
  const toIsoValue = toIso(to);
  if (!fromIso || !toIsoValue || Date.parse(fromIso) >= Date.parse(toIsoValue)) throw new Error(`invalid window ${kind}`);
  return { from: fromIso, to: toIsoValue, kind, timezone: 'UTC' };
}

function ga4SettledExclusiveEnd(now = new Date()) {
  const settled = settledEndDate(now, ANALYTICS_PROCESSING_LAG_DAYS);
  const end = Date.UTC(settled.getUTCFullYear(), settled.getUTCMonth(), settled.getUTCDate()) + DAY_MS;
  return new Date(end).toISOString();
}

export async function loadApplicationRecords(db = null) {
  const firestore = db || await getFirestoreDb();
  const records = [];
  let query = firestore.collection('applications')
    .select('jobId', 'jobSlug', 'createdAt', 'forwardedAt')
    .orderBy('__name__');
  while (true) {
    const snapshot = await query.limit(500).get();
    for (const doc of snapshot.docs) records.push({ id: doc.id, ...doc.data() });
    if (snapshot.empty || snapshot.size < 500) break;
    query = query.startAfter(snapshot.docs.at(-1));
  }
  return records;
}

async function writeDocuments(docs) {
  const db = await getFirestoreDb();
  const result = await writeEmployerInsightsDocuments(db, docs);
  return result.documentsWritten;
}

async function main() {
  const source = arg('--source', null);
  if (!source) throw new Error('--source is required (posthog or ga4)');
  assertEmployerInsightsSource(source);
  const now = new Date().toISOString();
  const requestedTo = arg('--to', null);
  const requestedFrom = arg('--from', null);
  const requestedDays = arg('--days', null);
  const explicitTo = requestedTo || (source === 'ga4' ? ga4SettledExclusiveEnd() : now);
  let primaryWindow;
  if (requestedDays != null) {
    const days = positiveNumberOr(requestedDays, null);
    if (!days) throw new Error('--days must be a positive number');
    primaryWindow = makeWindow(new Date(Date.parse(explicitTo) - days * 86_400_000), explicitTo, `days:${days}`);
  } else if (source === 'ga4') {
    // GA4's Data API is eventually consistent; never include the two newest
    // calendar days in the scheduled snapshot. The feed begins at the
    // instrumentation window instead of pretending old, unattributed rows
    // prove employer coverage.
    const days = 30;
    primaryWindow = makeWindow(
      new Date(Date.parse(explicitTo) - days * DAY_MS),
      explicitTo,
      `ga4-settled-days:${days}`,
    );
  } else {
    const bounds = await findSourceBounds();
    primaryWindow = makeWindow(requestedFrom || bounds.from || '1970-01-01T00:00:00.000Z', explicitTo, 'cumulative');
  }
  if (requestedFrom) primaryWindow = makeWindow(requestedFrom, explicitTo, requestedDays ? `days:${requestedDays}` : 'explicit');

  const ga4Options = source === 'ga4'
    ? {
      token: await getServiceAccountToken([GA4_READONLY_SCOPE]),
      propertyId: process.env.GA4_PROPERTY_ID,
    }
    : null;
  if (source === 'ga4' && !ga4Options.token) {
    throw new Error('GA4 source requires a readable service-account token');
  }

  const additional = new Map();
  for (const days of [30, 90]) {
    const from = new Date(Date.parse(primaryWindow.to) - days * 86_400_000).toISOString();
    const window = makeWindow(from, primaryWindow.to, `days:${days}`);
    if (window.from === primaryWindow.from && window.to === primaryWindow.to) continue;
    additional.set(`${days}d`, window);
  }

  const catalog = buildIdentityCatalog(loadJsonJobs(), loadCompanyRegistry());
  const applicationRecords = hasFlag('--apply') ? await loadApplicationRecords() : null;
  const windows = [['primary', primaryWindow], ...[...additional.entries()]];
  const builds = [];
  for (const [label, window] of windows) {
    const queried = source === 'ga4'
      ? await queryGa4EventRows(window, ga4Options)
      : await queryEventRows(window);
    assertCompleteEventCoverage(queried.coverage);
    if (source === 'ga4' && queried.coverage.identityObserved <= 0) {
      throw new Error(`GA4 employer identity feed unavailable for ${window.from} → ${window.to}`);
    }
    const evidence = hasFlag('--apply')
      ? aggregateApplicationEvidence(applicationRecords, { window, catalog })
      : emptyApplicationEvidence();
    builds.push({ label, window, queried, evidence });
  }

  const primary = builds[0];
  const additionalByCompany = new Map();
  for (const { label, window, queried, evidence } of builds.slice(1)) {
    const documents = buildInsightsDocuments({
      eventRows: queried.rows,
      catalog,
      window,
      applicationEvidence: evidence,
      generatedAt: now,
      source,
      queryCoverage: queried.coverage,
      onlyCompanyKey: arg('--company', null),
    });
    for (const document of documents) {
      if (!additionalByCompany.has(document.companyKey)) additionalByCompany.set(document.companyKey, {});
      additionalByCompany.get(document.companyKey)[label] = selectWindowSummary(document);
    }
  }
  const docs = buildInsightsDocuments({
    eventRows: primary.queried.rows,
    catalog,
    window: primary.window,
    applicationEvidence: primary.evidence,
    generatedAt: now,
    source,
    queryCoverage: primary.queried.coverage,
    onlyCompanyKey: arg('--company', null),
  });
  for (const document of docs) {
    const views = additionalByCompany.get(document.companyKey);
    if (views && Object.keys(views).length) document.additionalWindows = views;
  }

  const jsonOutputPath = arg('--json-out', null);
  if (jsonOutputPath) {
    const payload = buildDryRunPayload({
      documents: docs,
      generatedAt: now,
      source,
      window: primary.window,
      queryCoverage: primary.queried.coverage,
    });
    const temporaryPath = `${jsonOutputPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, jsonOutputPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
      throw error;
    }
    console.log(`Dry-run JSON written to ${jsonOutputPath}.`);
  }

  console.log(`Built insights for ${docs.length} companies (window ${primary.window.from} → ${primary.window.to}).`);
  console.log(`Coverage: observed ${docs[0]?.coverage.observed || 0}, attributed ${docs[0]?.coverage.attributed || 0}, residual ${docs[0]?.coverage.residualTotal || 0}, technical duplicates removed ${docs[0]?.coverage.technicalDuplicatesRemoved || 0}.`);
  const sample = arg('--company', null) ? docs.find((doc) => doc.companyKey === normalizeAlias(arg('--company'))) : docs[0];
  if (sample) console.log('SAMPLE:', JSON.stringify(sample, null, 1).slice(0, 1800));
  if (!hasFlag('--apply')) {
    console.log('\n(dry-run — pass --apply to write Firestore employer_insights/*)');
    return;
  }
  const written = await writeDocuments(docs);
  console.log(`Wrote ${written} docs to employer_insights/.`);
}

function hasFlag(flag) {
  return argv.includes(flag);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
