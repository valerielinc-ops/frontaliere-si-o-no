#!/usr/bin/env node
/**
 * Build the employer-insights snapshot from the complete, documentable
 * PostHog period.
 *
 * The calculation deliberately starts from the union of events. A pageview
 * is one signal among many, not the admission criterion for an ad. Identity
 * is resolved only through explicit job/company aliases; an unresolved event
 * remains in the residual ledger instead of silently disappearing.
 *
 * Usage:
 *   node scripts/build-employer-insights.mjs
 *   node scripts/build-employer-insights.mjs --days 30
 *   node scripts/build-employer-insights.mjs --company <companyKey>
 *   node scripts/build-employer-insights.mjs --apply
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { JOB_BOARD_SECTION_PREFIX_SOURCE } from './lib/jobBoardSections.mjs';
import {
  baseCompanySlug,
  canonicalCompanyProfileSlug,
  rawCompanySlug,
} from '../build-plugins/shared/companyProfileSlug.mjs';

export const INSIGHTS_SCHEMA_VERSION = 2;
export const DELIVERY_UNAVAILABLE = 'non disponibile';
export const EVENT_QUERY_PAGE_SIZE = 10_000;

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
    if (typeof value.toDate === 'function') return toIso(value.toDate());
    if (typeof value.toMillis === 'function') return toIso(new Date(value.toMillis()));
    if (typeof value._seconds === 'number') return toIso(new Date(value._seconds * 1000 + numberOr(value._nanoseconds, 0) / 1e6));
    if (typeof value.seconds === 'number') return toIso(new Date(value.seconds * 1000 + numberOr(value.nanoseconds, 0) / 1e6));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inWindow(timestamp, window) {
  const iso = toIso(timestamp);
  if (!iso) return true;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const time = Date.parse(iso);
  return Number.isFinite(time) && time >= from && time < to;
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
    eventKey: normalizeText(read(['eventKey', 'event_key', '$insert_id', 'insert_id', 'eventId', 'uuid'], 0)),
    emissionId: normalizeText(read(['emissionId', 'emission_id', 'actionId', 'action_id'], 15)),
    event: eventName,
    timestamp: Array.isArray(source) ? null : toIso(read(['timestamp', 'occurredAt', 'createdAt'], undefined)),
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
 * Collapse only a technical duplicate proven by a stable emission or event
 * key. Rows without either key retain their full observed count and are never
 * guessed to be duplicates. An emission key is shared by the two analytics
 * signals produced by one UI action; it is not inferred from timing or text.
 */
export function collapseTechnicalDuplicates(inputRows = []) {
  const rows = inputRows.map(normalizeEventRow);
  const keptByKey = new Map();
  const kept = [];
  let rawObserved = 0;
  let observed = 0;
  let removed = 0;
  for (const row of rows) {
    const count = Math.max(0, numberOr(row.observed, 1));
    rawObserved += count;
    const dedupKey = row.emissionId
      ? `emission:${row.emissionId}`
      : row.eventKey
        ? `event:${row.eventKey}`
        : '';
    if (!dedupKey) {
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
  return { rows: kept, rawObserved, observed, removed };
}

function pathSegments(pathname) {
  const raw = normalizeText(pathname).split('?')[0].split('#')[0];
  return raw.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment).toLowerCase(); } catch { return segment.toLowerCase(); }
  });
}

function routeIdentity(pathname) {
  const segments = pathSegments(pathname);
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
  return row.event === '$pageview' || row.event === 'pageview';
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
      eventsObserved: 0,
      eventTypes: new Map(),
      trend: new Map(),
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
export function aggregateEmployerEvents(inputRows = [], { catalog, window } = {}) {
  catalog ||= buildIdentityCatalog();
  const effectiveWindow = window || { from: '1970-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z' };
  const windowRows = inputRows
    .map(normalizeEventRow)
    .filter((row) => inWindow(row.timestamp, effectiveWindow));
  const deduped = collapseTechnicalDuplicates(windowRows);
  const states = new Map();
  const residuals = residualLedger();
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
    state.applyClicks += clicks;
    if (job) {
      state.views += views;
      state.visitors += visitors;
      const ad = ensureAd(state, job);
      ad.eventsObserved += count;
      addMetric(ad.eventTypes, sourceRow.event || 'unknown', count);
      ad.views += views;
      ad.visitors += visitors;
      ad.applyClicks += clicks;
      const week = sourceRow.week || (pageview ? weekStart(sourceRow.timestamp) : null);
      if (pageview && week) addMetric(ad.trend, week, views);
    } else if (pageview) {
      state.profileViews += views;
      state.profileVisitors += visitors;
      const week = sourceRow.week || weekStart(sourceRow.timestamp);
      if (week) addMetric(state.profileTrend, week, views);
    }
  }

  const residualTotal = Object.values(residuals).reduce((sum, value) => sum + value, 0);
  const coverage = {
    source: 'posthog',
    status: deduped.observed > 0 ? 'observed' : 'zero_observed',
    rawObserved: deduped.rawObserved,
    observed: deduped.observed,
    attributed,
    residuals,
    residualTotal,
    technicalDuplicatesRemoved: deduped.removed,
    invariant: attributed + residualTotal === deduped.observed,
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
    if (createdAt && !inWindow(createdAt, window)) continue;
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

function serializeTrend(trend) {
  return [...trend.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, views]) => ({ week, views }));
}

function queryCoverageOrDefault(queryCoverage, coverage, window) {
  const query = queryCoverage || {};
  const pageSize = query.pageSize ?? EVENT_QUERY_PAGE_SIZE;
  return {
    limit: pageSize,
    pageSize,
    totalBeforeCut: query.totalBeforeCut ?? query.sourceObserved ?? coverage.rawObserved,
    groupRowsBeforeCut: query.groupRowsBeforeCut ?? query.totalRows ?? null,
    returned: query.returned ?? query.returnedObserved ?? coverage.rawObserved,
    returnedRows: query.returnedRows ?? query.rowsReturned ?? null,
    pages: query.pages ?? null,
    truncated: Boolean(query.truncated),
    queryHash: query.queryHash || null,
    snapshotId: query.snapshotId || null,
    sourceObserved: query.sourceObserved ?? coverage.rawObserved,
    from: window.from,
    to: window.to,
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
  queryCoverage,
  onlyCompanyKey = null,
  additionalWindows = {},
} = {}) {
  if (!catalog) throw new Error('identity catalog required');
  if (!window?.from || !window?.to) throw new Error('explicit window required');
  const aggregate = aggregateEmployerEvents(eventRows, { catalog, window });
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
    const trend = serializeTrend(state.trend);
    const profileTrend = serializeTrend(state.profileTrend);
    const eventLimits = queryCoverageOrDefault(queryCoverage, aggregate.coverage, window);
    const doc = {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      companyKey,
      companyName: state.companyName || catalog.companyNameByKey.get(companyKey) || companyKey,
      generatedAt,
      source: 'posthog',
      window: { ...window, inclusive: '[from,to)' },
      totals: {
        views: state.views,
        visitors: state.visitors,
        profileViews: state.profileViews,
        profileVisitors: state.profileVisitors,
        applyClicks: state.applyClicks,
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
        },
      },
      applicationsCoverage: applicationCoverageOrDefault(evidence),
      limits: {
        adsSerialized: { limit: null, total: ads.length, returned: ads.length, truncated: false },
        events: eventLimits,
      },
      provenance: {
        source: 'posthog',
        buildSha: BUILD_SHA,
        snapshotId: eventLimits.snapshotId,
        queryHash: eventLimits.queryHash,
        identityCatalogSha: catalog.identityCatalogSha,
        window: { ...window },
        rowsReturned: eventLimits.returnedRows,
        returnedObserved: eventLimits.returned,
        totalRows: eventLimits.totalBeforeCut,
        sourceObserved: eventLimits.sourceObserved,
        groupedRowsBeforeCut: eventLimits.groupRowsBeforeCut,
        pages: eventLimits.pages,
        pageSize: eventLimits.pageSize,
        truncated: eventLimits.truncated,
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

const EVENT_KEY_EXPRESSION = "coalesce(toString(properties.$insert_id), toString(properties.$event_id), toString(uuid), '')";
const EVENT_CURSOR_TIMESTAMP_INDEX = 16;

function hogqlString(value) {
  return "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
}

function hogqlTimestamp(value) {
  const raw = String(value ?? '')
    .trim()
    .replace('T', ' ')
    .replace(/(?:Z|[+-]\d\d:\d\d)$/, '');
  const [whole, fraction = ''] = raw.split('.', 2);
  return whole + '.' + fraction.slice(0, 6).padEnd(6, '0');
}

function eventCursorFromRow(row) {
  const timestamp = Array.isArray(row)
    ? row[EVENT_CURSOR_TIMESTAMP_INDEX]
    : row?.cursorTimestamp ?? row?.cursor_timestamp ?? row?.timestamp;
  const eventKey = Array.isArray(row)
    ? row[0]
    : row?.eventKey ?? row?.event_key;
  if (timestamp == null || timestamp === '' || eventKey == null) return null;
  return { timestamp: String(timestamp), eventKey: String(eventKey) };
}

function eventCursorSortKey(cursor) {
  return hogqlTimestamp(cursor.timestamp) + '\u0000' + cursor.eventKey;
}

function eventSelect(window, cursor = null) {
  const from = hogqlDate(window.from);
  const to = hogqlDate(window.to);
  const cursorTimestamp = cursor
    ? 'toDateTime64(' + hogqlString(hogqlTimestamp(cursor.timestamp)) + ', 6)'
    : null;
  const cursorFilter = cursor
    ? '\n      AND (\n        timestamp > ' + cursorTimestamp
      + '\n        OR (timestamp = ' + cursorTimestamp
      + ' AND ' + EVENT_KEY_EXPRESSION + ' > ' + hogqlString(cursor.eventKey) + ')\n      )'
    : '';
  return `
    SELECT
      ${EVENT_KEY_EXPRESSION} AS event_key,
      event,
      toString(toStartOfWeek(timestamp)) AS week,
      properties.$pathname AS path,
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
      toString(timestamp) AS cursor_timestamp
    FROM events
    WHERE timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}')${cursorFilter}
    GROUP BY event_key, event, week, path, job_slug, job_id, provider_id,
             employer_key, item_id, content_type, emission_id, timestamp
    ORDER BY cursor_timestamp, event_key
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

export async function queryEventRows(window, { query: runQuery = hogql, pageSize = EVENT_QUERY_PAGE_SIZE } = {}) {
  const baseQuery = eventSelect(window);
  const queryHash = sha256(baseQuery);
  const [countRows, sourceCountRows] = await Promise.all([
    runQuery('SELECT count() AS total FROM (' + baseQuery + ')'),
    runQuery(eventCountSelect(window)),
  ]);
  const groupedRowsBeforeCut = Math.max(0, Math.trunc(numberOr(countRows?.[0]?.[0] ?? countRows?.[0]?.total, 0)));
  const sourceObserved = Math.max(0, Math.trunc(numberOr(sourceCountRows?.[0]?.[0] ?? sourceCountRows?.[0]?.total, 0)));
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
    if (cursor && eventCursorSortKey(nextCursor) <= eventCursorSortKey(cursor)) {
      throw new Error('posthog keyset cursor did not advance');
    }
    cursor = nextCursor;
    if (pageRows.length < pageSize) break;
    if (groupedRowsBeforeCut > 0 && rows.length >= groupedRowsBeforeCut) break;
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

async function loadApplicationRecords() {
  const db = await getFirestoreDb();
  const records = [];
  let query = db.collection('applications').select('jobId', 'jobSlug', 'createdAt', 'forwardedAt');
  while (true) {
    const snapshot = await query.limit(500).get();
    for (const doc of snapshot.docs) records.push({ id: doc.id, ...doc.data() });
    if (snapshot.empty || snapshot.size < 500) break;
    query = query.startAfter(snapshot.docs.at(-1));
  }
  return records;
}

async function writeDocuments(docs) {
  const { FieldValue } = await import('firebase-admin/firestore');
  const db = await getFirestoreDb();
  let written = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const document of docs.slice(i, i + 400)) {
      batch.set(db.collection('employer_insights').doc(document.companyKey), {
        ...document,
        updatedAt: FieldValue.serverTimestamp(),
      });
      written += 1;
    }
    await batch.commit();
  }
  return written;
}

async function main() {
  const now = new Date().toISOString();
  const explicitTo = arg('--to', now);
  const requestedDays = arg('--days', null);
  let primaryWindow;
  if (requestedDays != null) {
    const days = positiveNumberOr(requestedDays, null);
    if (!days) throw new Error('--days must be a positive number');
    primaryWindow = makeWindow(new Date(Date.parse(explicitTo) - days * 86_400_000), explicitTo, `days:${days}`);
  } else {
    const bounds = await findSourceBounds();
    primaryWindow = makeWindow(arg('--from', bounds.from || '1970-01-01T00:00:00.000Z'), explicitTo, 'cumulative');
  }
  const requestedFrom = arg('--from', null);
  if (requestedFrom) primaryWindow = makeWindow(requestedFrom, explicitTo, requestedDays ? `days:${requestedDays}` : 'explicit');

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
    const queried = await queryEventRows(window);
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
    queryCoverage: primary.queried.coverage,
    onlyCompanyKey: arg('--company', null),
  });
  for (const document of docs) {
    const views = additionalByCompany.get(document.companyKey);
    if (views && Object.keys(views).length) document.additionalWindows = views;
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
