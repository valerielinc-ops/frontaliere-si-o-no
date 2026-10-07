#!/usr/bin/env node

/**
 * Deterministic licence audit for every image surface published by the site.
 *
 * The audit intentionally has no model dependency. The optional --apply path
 * is the only path that loads the governed image engine, and it always keeps
 * the published URL equal to the URL already assigned to the content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { EVENT_IMAGE_LICENSES, isEventImageSourceAllowed } from '../lib/events-utils.mjs';
import {
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { validateImageCreditRecord } from '../../packages/articles/engine/shared/imageCredits.mjs';
import {
  EVENT_IMAGE_LIBRARY_PREFIX,
  eventImageSeason,
  normalizeEventImageArea,
  normalizeEventImageCategory,
  stableEventImageHash,
} from '../../packages/articles/engine/shared/eventImageLibrary.mjs';
import { SITE_ORIGIN, SITE_OWNED_OG_IMAGE_ALLOWLIST } from '../lib/published-image-policy.mjs';

export const LICENSE_AUDIT_SCHEMA_VERSION = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 20;
export const MAX_EXAMPLES = 10;
export const OLD_HISTORY_MARKER = 'dab77221540a4e369440f762228be7e0be21155d';
export const ALARM_TITLE = 'License audit: non-remediable publication violations';
export const IMAGE_CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';

// These are source prefixes removed by the 2026-10-06 licence decision. The
// list is deliberately explicit: adding a new source requires a code review
// and a corresponding audit fixture.
export const REMOVED_EVENT_IMAGE_SOURCES = Object.freeze([
  'myswitzerland',
  'guidle',
  'tio-agenda',
  'ge-agenda',
  'fr-agenda',
  'nw-agenda',
  'ow-agenda',
  'lu-stadt-agenda',
]);
const LEGACY_CDN_SAMPLE_NAMES = Object.freeze({
  myswitzerland: 'a69e1b346fd84ef9ab9daa73e15df9d9f',
});

const IMAGE_FAMILIES = Object.freeze([
  'blog',
  'places',
  'authors',
  'publisher',
  'social',
  'brands',
  'providers',
  'insurers',
  'logos',
]);
const GENERATED_SCOPES = Object.freeze({
  event: 'event-library',
  blog: 'article-hero',
  place: 'place',
  author: 'editorial-profile',
});

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function examples(items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_EXAMPLES);
}

function countStatuses(items) {
  const counts = {};
  for (const item of items || []) {
    const key = item.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function statusFor({ fail = 0, warn = 0 }) {
  if (fail > 0) return 'fail';
  if (warn > 0) return 'warn';
  return 'pass';
}

export function makeControl({
  id,
  section,
  title,
  threshold,
  counts = {},
  failures = [],
  warnings = [],
  alarm = false,
  remediation = 'none',
}) {
  return {
    id,
    section,
    title,
    threshold,
    status: statusFor({ fail: failures.length, warn: warnings.length }),
    counts,
    examples: examples([...failures, ...warnings]),
    alarm: Boolean(alarm && failures.length),
    remediation,
  };
}

function normalizeEventsDataset(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  return [];
}

function safeGeneratedValidation(record, scope) {
  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record missing'] };
  }
  try {
    return validateGeneratedImageRecord(record, scope ? { scope } : {});
  } catch (error) {
    return { valid: false, errors: [String(error?.message || error)] };
  }
}

function safeCreditValidation(record) {
  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record missing'] };
  }
  try {
    return validateImageCreditRecord(record);
  } catch (error) {
    return { valid: false, errors: [String(error?.message || error)] };
  }
}

function generatedRecordMap(registry, scope) {
  const result = new Map();
  for (const record of registry?.assets || []) {
    if (!record?.imageUrl) continue;
    const validation = safeGeneratedValidation(record, scope);
    result.set(record.imageUrl, {
      record,
      valid: validation.valid,
      errors: validation.errors || [],
    });
  }
  return result;
}

function eventImageUrlIsLibrary(url) {
  return typeof url === 'string' && url.startsWith('/images/events/library/');
}

function eventImageUrlIsAllowedSource(event, eventLicenses = EVENT_IMAGE_LICENSES) {
  const sourceKey = String(event?.sourceKey || '').trim().toLowerCase();
  const license = eventLicenses?.[sourceKey];
  if (!license || !event?.imageUrl) return false;
  const imageLicense = String(event.imageLicense || '').trim();
  const imageLicenseUrl = String(event.imageLicenseUrl || '').trim();
  return imageLicense === license.name || imageLicenseUrl === license.termsUrl;
}

function removedSourceInUrl(url) {
  const value = String(url || '').toLowerCase();
  return REMOVED_EVENT_IMAGE_SOURCES.find((source) => (
    value.includes('/images/events/' + source + '-')
    || value.includes('/images/events/' + source + '/')
  )) || null;
}

export function classifyEventImage({
  event,
  eventRegistryByUrl = new Map(),
  eventLicenses = EVENT_IMAGE_LICENSES,
}) {
  const url = event?.imageUrl;
  if (!url) {
    return {
      status: 'missing',
      valid: true,
      autoRepairable: false,
      reason: 'event has no image; no unlicensed bytes are published',
    };
  }
  const removedSource = removedSourceInUrl(url);
  if (removedSource) {
    return {
      status: 'licenza non ammessa',
      valid: false,
      autoRepairable: true,
      nonRemediable: true,
      reason: 'removed event-image source prefix: ' + removedSource,
    };
  }
  if (eventImageUrlIsLibrary(url)) {
    const entry = eventRegistryByUrl.get(url);
    if (entry?.valid) {
      return {
        status: 'ok',
        valid: true,
        autoRepairable: false,
        reason: 'governed event-library record',
      };
    }
    return {
      status: 'senza record',
      valid: false,
      autoRepairable: true,
      reason: entry ? 'invalid event-library record: ' + entry.errors.join('; ') : 'event-library record missing',
    };
  }
  if (eventImageUrlIsAllowedSource(event, eventLicenses)) {
    return {
      status: 'ok',
      valid: true,
      autoRepairable: false,
      reason: 'licensed source in EVENT_IMAGE_LICENSES',
    };
  }
  return {
    status: 'licenza non ammessa',
    valid: false,
    autoRepairable: true,
    nonRemediable: false,
    reason: 'event image is neither governed library nor an allowed licensed source',
  };
}

function crawlerPolicyFindings(root) {
  const directory = path.join(root, 'scripts');
  if (!fs.existsSync(directory)) return [];
  const findings = [];
  for (const name of fs.readdirSync(directory).filter((item) => /^crawl-.*-events\.mjs$/.test(item)).sort()) {
    const file = path.join(directory, name);
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('mirrorEventImage')) continue;
    const sourceMatch = source.match(/const SOURCE = EVENT_SOURCES\.([A-Za-z0-9_-]+)/);
    const sourceKey = sourceMatch?.[1] || name.replace(/^crawl-/, '').replace(/-events\.mjs$/, '');
    if (isEventImageSourceAllowed(sourceKey)) continue;
    if (!source.includes('isEventImageSourceAllowed')) {
      findings.push({ file: relative(root, file), sourceKey, reason: 'excluded source can reach mirrorEventImage without the policy gate' });
    }
  }
  return findings;
}

function readEventSlices(root) {
  const directory = path.join(root, 'data', 'events', 'by-source');
  if (!fs.existsSync(directory)) return [];
  const slices = [];
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(directory, name);
    const value = readJson(file);
    if (value) slices.push({ file, value });
  }
  return slices;
}

export function auditEventImages({
  events = [],
  eventRegistry = { assets: [] },
  eventLicenses = EVENT_IMAGE_LICENSES,
  crawlerFindings = [],
}) {
  const eventRegistryByUrl = generatedRecordMap(eventRegistry, GENERATED_SCOPES.event);
  const rows = events.map((event) => ({ event, ...classifyEventImage({ event, eventRegistryByUrl, eventLicenses }) }));
  const invalid = rows.filter((row) => !row.valid);
  const missing = rows.filter((row) => row.status === 'missing');
  const failures = invalid.map((row) => ({
    id: row.event?.id || '<event>',
    sourceKey: row.event?.sourceKey || null,
    imageUrl: row.event?.imageUrl || null,
    reason: row.reason,
  }));
  const sourceFailures = crawlerFindings.map((item) => ({ ...item }));
  const imageControl = makeControl({
    id: 'A.events-published-images',
    section: 'A',
    title: 'Eventi pubblicati: immagini governate o fonte con licenza ammessa',
    threshold: 'invalid imageUrl = 0',
    counts: {
      events: rows.length,
      images: rows.length - missing.length,
      governedLibrary: rows.filter((row) => row.reason === 'governed event-library record').length,
      licensedSources: rows.filter((row) => row.reason === 'licensed source in EVENT_IMAGE_LICENSES').length,
      invalid: invalid.length,
      noImage: missing.length,
    },
    failures,
    warnings: missing.map((row) => ({ id: row.event?.id || '<event>', reason: row.reason })),
    alarm: true,
    remediation: 'event-library',
  });
  const crawlerControl = makeControl({
    id: 'A.crawler-image-policy',
    section: 'A',
    title: 'Crawler eventi: nessun emettitore bypassa il gate immagini',
    threshold: 'unguarded excluded-source image calls = 0',
    counts: { findings: sourceFailures.length },
    failures: sourceFailures,
    alarm: true,
    remediation: 'none',
  });
  return {
    rows,
    candidates: invalid.filter((row) => row.autoRepairable)
      .map((row) => eventReplacementCandidate(row.event, row.reason, eventRegistry)),
    controls: [imageControl, crawlerControl],
  };
}

export function auditEventSourceSlices({
  root = process.cwd(),
  slices = [],
  eventRegistry = { assets: [] },
  eventLicenses = EVENT_IMAGE_LICENSES,
}) {
  const eventRegistryByUrl = generatedRecordMap(eventRegistry, GENERATED_SCOPES.event);
  const rows = [];
  for (const slice of slices) {
    for (const event of normalizeEventsDataset(slice?.value || slice)) {
      if (!event?.imageUrl) continue;
      rows.push({
        file: slice?.file || null,
        id: event.id || '<event>',
        sourceKey: event.sourceKey || null,
        event,
        ...classifyEventImage({ event, eventRegistryByUrl, eventLicenses }),
      });
    }
  }
  const invalid = rows.filter((row) => !row.valid);
  return {
    rows,
    control: makeControl({
      id: 'A.event-source-slices',
      section: 'A',
      title: 'Slice eventi: nessuna immagine da fonte esclusa prima dell’assemblaggio',
      threshold: 'invalid imageUrl in source slices = 0',
      counts: {
        slices: slices.length,
        images: rows.length,
        invalid: invalid.length,
        excludedSourceImages: invalid.filter((row) => row.nonRemediable).length,
      },
      failures: invalid.map((row) => ({
        file: row.file ? relative(root, row.file) : null,
        id: row.id,
        sourceKey: row.sourceKey,
        imageUrl: row.event?.imageUrl || null,
        reason: row.reason,
      })),
      alarm: true,
      remediation: 'crawler policy and event-library',
    }),
  };
}

function slugPart(value, fallback = 'generic') {
  const normalized = String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function eventReplacementCandidate(event, reason, eventRegistry) {
  const category = normalizeEventImageCategory(event);
  const area = normalizeEventImageArea(event);
  const season = eventImageSeason(event?.startDate);
  const eventId = String(event?.id || 'event');
  const eventKey = slugPart(eventId, 'event').slice(0, 80) + '-' + stableEventImageHash(eventId).toString(36);
  const assetId = 'audit-event-' + eventKey;
  const imageUrl = EVENT_IMAGE_LIBRARY_PREFIX + assetId + '.webp';
  const existingRecord = (eventRegistry?.assets || []).find((record) => (
    record?.assetId === assetId
    && safeGeneratedValidation(record, GENERATED_SCOPES.event).valid
  )) || null;
  return {
    kind: 'event',
    scope: GENERATED_SCOPES.event,
    key: event?.id || 'unknown-event',
    assetId,
    imageUrl,
    originalImageUrl: event?.imageUrl || null,
    eventId: event?.id || null,
    sourceKey: event?.sourceKey || null,
    category,
    area,
    season,
    reason,
    priority: Number(event?.traffic || event?.priority || 0),
    recency: event?.updatedAt || event?.startDate || '',
    autoRepairable: Boolean(event?.id),
    nonRemediable: !event?.id,
    existingRecord,
  };
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function gitTreeFiles(root, ref, prefix) {
  const output = gitOutput(root, ['ls-tree', '-r', '--name-only', ref, '--', prefix]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function trackedFiles(root, prefix) {
  const output = gitOutput(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', prefix]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function loadPublicImagePaths(root, ref = 'HEAD') {
  const values = new Set([
    ...gitTreeFiles(root, ref, 'public/images'),
    ...trackedFiles(root, 'public/images'),
  ]);
  return [...values].filter((file) => /\.(?:webp|png|jpe?g|gif|svg|ico|avif)$/i.test(file));
}

function parseSourceImageReferences(root) {
  const references = new Set();
  const blogKeys = new Set();
  const sourceFiles = [
    'packages/articles/content/blog-articles-data.ts',
    'packages/articles/content/swiss-articles-data.ts',
    'data/authors.ts',
    'components/guide/FrontierGuide.tsx',
    'scripts/create-article.mjs',
    'scripts/generate-events-digest-article.mjs',
    'scripts/publish-journalist-article.mjs',
    'services/brandLogos.ts',
    'services/jobDataNormalization.ts',
    'data/company-logos-manifest.json',
  ];
  for (const relativeFile of sourceFiles) {
    const file = path.join(root, relativeFile);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const pathRx = /['"]((?:\/images\/|https?:\/\/cdn\.frontaliereticino\.ch\/images\/)[^'"\s]+)['"]/g;
    let match;
    while ((match = pathRx.exec(source))) {
      const value = match[1].replace(/^https?:\/\/cdn\.frontaliereticino\.ch/, '');
      references.add(value);
      if (value.startsWith('/images/blog/')) {
        blogKeys.add(path.basename(value, path.extname(value)));
      }
    }
    if (relativeFile.endsWith('blog-articles-data.ts') || relativeFile.endsWith('swiss-articles-data.ts')) {
      const imageRx = /\bimage:\s*['"]([^'"]+)['"]/g;
      while ((match = imageRx.exec(source))) {
        const value = match[1];
        references.add(value);
        if (value.startsWith('/images/blog/')) {
          blogKeys.add(path.basename(value, path.extname(value)));
        }
      }
    }
  }
  return { references, blogKeys };
}

function collectSocialReferences(root) {
  const values = new Set();
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return [];
  for (const name of fs.readdirSync(dataDir).filter((item) => /(?:tiktok|instagram|linkedin).*queue/i.test(item))) {
    const source = fs.readFileSync(path.join(dataDir, name), 'utf8');
    const rx = /https?:\/\/cdn\.frontaliereticino\.ch\/images\/social\/[^'"\s]+/g;
    for (const match of source.matchAll(rx)) values.add(match[0]);
  }
  return [...values];
}

function parseAuthors(root) {
  const file = path.join(root, 'data', 'authors.ts');
  if (!fs.existsSync(file)) return new Map();
  const source = fs.readFileSync(file, 'utf8');
  const result = new Map();
  const objectRx = /\{\s*kind:\s*'(editorial-profile|real-author)'([\s\S]*?)\n\s*\},/g;
  let match;
  while ((match = objectRx.exec(source))) {
    const body = match[2];
    const slug = body.match(/slug:\s*'([^']+)'/)?.[1];
    const photoPath = body.match(/photoPath:\s*'([^']+)'/)?.[1];
    if (slug && photoPath) result.set(photoPath, { slug, kind: match[1] });
  }
  return result;
}

function parseSourceRegisteredLogoPaths(root) {
  const paths = new Set();
  const manifest = readJson(path.join(root, 'data', 'company-logos-manifest.json'), {});
  for (const value of Object.values(manifest || {})) {
    if (typeof value === 'string' && value.startsWith('/images/')) paths.add(value);
  }
  for (const relativeFile of ['services/brandLogos.ts', 'services/jobDataNormalization.ts']) {
    const file = path.join(root, relativeFile);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const rx = /['"]((?:\/images\/brands\/|\/images\/providers\/|\/images\/insurers\/|\/images\/logos\/)[^'"\s]+)['"]/g;
    let match;
    while ((match = rx.exec(source))) paths.add(match[1]);
  }
  return paths;
}

function pathFamily(file) {
  const match = file.match(/^public\/images\/([^/]+)\/(.+)$/);
  return match ? { family: match[1], relative: match[2], url: '/images/' + match[1] + '/' + match[2] } : null;
}

function loadCreditRecord(root, ledgerItem, url, blogGeneratedByUrl) {
  const recordFile = ledgerItem?.recordFile;
  if (recordFile) {
    const record = readJson(path.join(root, recordFile));
    if (record) {
      const validation = safeCreditValidation(record);
      return { record, valid: validation.valid, errors: validation.errors || [], source: 'record-file' };
    }
  }
  const generated = blogGeneratedByUrl.get(url) || blogGeneratedByUrl.get(ledgerItem?.cover);
  if (generated) {
    return { record: generated.record, valid: generated.valid, errors: generated.errors, source: 'generated-registry' };
  }
  if (ledgerItem?.evidence === 'inferred' || ledgerItem?.status === 'no-credit') {
    return { record: null, valid: true, inferred: true, errors: [], source: 'inferred-ledger' };
  }
  return { record: null, valid: false, errors: ['record missing'], source: 'missing' };
}

export function classifyPublishedImage({
  family,
  url,
  record = null,
  recordValid = null,
  inferred = false,
  referenced = true,
  sourceRegistered = false,
  protectedRealAuthor = false,
}) {
  if (!referenced) {
    return {
      family,
      url,
      status: 'orfano',
      valid: false,
      referenced: false,
      protectedRealAuthor,
      sourceRegistered,
      autoRepairable: false,
      nonRemediable: false,
      reason: 'file has no current content reference',
    };
  }
  if (inferred) {
    return {
      family,
      url,
      status: 'inferred',
      valid: true,
      referenced: true,
      protectedRealAuthor,
      sourceRegistered,
      autoRepairable: false,
      nonRemediable: false,
      reason: 'ledger carries only an inferred provenance record',
    };
  }
  if (sourceRegistered && ['brands', 'providers', 'insurers', 'logos'].includes(family)) {
    return {
      family,
      url,
      status: 'ok',
      valid: true,
      referenced: true,
      protectedRealAuthor,
      sourceRegistered,
      autoRepairable: false,
      nonRemediable: false,
      reason: 'source registration exists; logo inventory is not auto-repaired',
    };
  }
  if (!record || recordValid === false) {
    return {
      family,
      url,
      status: record ? 'licenza non ammessa' : 'senza record',
      valid: false,
      referenced: true,
      protectedRealAuthor,
      sourceRegistered,
      autoRepairable: ['blog', 'places', 'authors'].includes(family) && !protectedRealAuthor,
      nonRemediable: protectedRealAuthor || !['blog', 'places', 'authors'].includes(family),
      reason: record ? 'image record fails the allowed-license validator' : 'no valid image record',
    };
  }
  return {
    family,
    url,
    status: 'ok',
    valid: true,
    referenced: true,
    protectedRealAuthor,
    sourceRegistered,
    autoRepairable: false,
    nonRemediable: false,
    reason: 'validated image record',
  };
}

function blogKeyFromUrl(url) {
  const value = String(url || '');
  const key = path.basename(value, path.extname(value));
  return value.includes('/thumbnails/') ? key.replace(/-(?:480|800)w$/, '') : key;
}

function parentImageUrl(family, url) {
  const value = String(url || '');
  if (!value.includes('/thumbnails/') || !['blog', 'places'].includes(family)) return value;
  return value.replace('/thumbnails/', '/').replace(/-(?:480|800)w(?=\.[^.]+$)/, '');
}

function imageCandidate(item, authorsByPath, ledgerItem) {
  if (!item.autoRepairable) return null;
  const family = item.family;
  const assetId = family === 'blog'
    ? blogKeyFromUrl(item.url)
    : path.basename(item.url, path.extname(item.url));
  const author = family === 'authors' ? authorsByPath.get(item.url) : null;
  return {
    kind: family === 'blog' ? 'article-hero' : family === 'places' ? 'place' : 'editorial-profile',
    scope: family === 'blog' ? GENERATED_SCOPES.blog : family === 'places' ? GENERATED_SCOPES.place : GENERATED_SCOPES.author,
    key: assetId,
    assetId,
    imageUrl: item.url,
    path: item.url,
    family,
    recordFile: family === 'blog'
      ? 'packages/articles/content/image-credits/blog/' + assetId + '.json'
      : null,
    authorKind: author?.kind || null,
    protectedRealAuthor: author?.kind === 'real-author',
    reason: item.reason,
    priority: Number(ledgerItem?.priority || 0),
    recency: ledgerItem?.verifiedAt || ledgerItem?.references?.[0]?.updatedAt || ledgerItem?.references?.[0]?.date || '',
    autoRepairable: true,
    nonRemediable: false,
  };
}

function recordsWithoutFiles(registries, publicUrls) {
  const rows = [];
  for (const [scope, registry] of Object.entries(registries)) {
    for (const record of registry?.assets || []) {
      if (!record?.imageUrl || publicUrls.has(record.imageUrl)) continue;
      rows.push({
        scope,
        assetId: record.assetId || null,
        imageUrl: record.imageUrl,
        reason: 'registry record has no published file',
      });
    }
  }
  return rows;
}

export function auditOtherImages({
  root,
  publicFiles = loadPublicImagePaths(root),
  registries = {},
  ledger = {},
  blogKeys = new Set(),
  references = new Set(),
  authorsByPath = new Map(),
  sourceRegisteredLogoPaths = new Set(),
  socialUrls = [],
}) {
  const generatedByUrl = {
    blog: generatedRecordMap(registries.blog, GENERATED_SCOPES.blog),
    places: generatedRecordMap(registries.shared, GENERATED_SCOPES.place),
    authors: generatedRecordMap(registries.shared, GENERATED_SCOPES.author),
  };
  const inventory = [];
  const candidates = [];
  const publicUrls = new Set();
  const files = publicFiles.map(pathFamily).filter((item) => item && IMAGE_FAMILIES.includes(item.family));

  for (const file of files) {
    publicUrls.add(file.url);
    const ledgerKey = file.family === 'blog' ? blogKeyFromUrl(file.url) : null;
    const ledgerItem = ledgerKey ? ledger.covers?.[ledgerKey] : null;
    const referenceUrl = parentImageUrl(file.family, file.url);
    const referenced = file.family === 'blog'
      ? blogKeys.has(ledgerKey) || ledgerItem?.currentlyPublished === true
      : references.has(file.url) || references.has(referenceUrl) || file.family === 'publisher';
    const author = file.family === 'authors' ? authorsByPath.get(file.url) : null;
    let recordInfo = null;
    if (file.family === 'blog') {
      recordInfo = loadCreditRecord(root, ledgerItem, referenceUrl, generatedByUrl.blog);
    } else if (file.family === 'places' || file.family === 'authors') {
      const generated = generatedByUrl[file.family].get(file.url)
        || generatedByUrl[file.family].get(referenceUrl);
      recordInfo = generated
        ? { record: generated.record, valid: generated.valid, errors: generated.errors }
        : { record: null, valid: false, errors: ['generated registry record missing'] };
    }
    const classified = classifyPublishedImage({
      family: file.family,
      url: file.url,
      record: recordInfo?.record,
      recordValid: recordInfo?.valid,
      inferred: recordInfo?.inferred,
      referenced,
      sourceRegistered: sourceRegisteredLogoPaths.has(file.url),
      protectedRealAuthor: author?.kind === 'real-author',
    });
    const row = {
      ...classified,
      file: file.relative,
      recordSource: recordInfo?.source || null,
      authorKind: author?.kind || null,
      priority: ledgerItem?.priority || 0,
      recency: ledgerItem?.verifiedAt || ledgerItem?.references?.[0]?.date || '',
    };
    if (file.family === 'blog' && file.relative.startsWith('thumbnails/')) {
      // Blog thumbnails deliberately share the hero's ledger record. Repair
      // the hero once when needed; the next audit validates both surfaces.
      row.autoRepairable = false;
    }
    inventory.push(row);
    if (row.autoRepairable && row.referenced) candidates.push(imageCandidate(row, authorsByPath, ledgerItem));
  }

  for (const url of socialUrls) {
    const row = classifyPublishedImage({
      family: 'social',
      url: url.replace(IMAGE_CDN_ORIGIN, ''),
      record: null,
      referenced: true,
    });
    inventory.push({ ...row, file: null, recordSource: null });
  }

  const orphanRecords = recordsWithoutFiles(registries, publicUrls);
  const statusCounts = countStatuses(inventory);
  const publishedUnresolved = inventory.filter((row) => row.referenced && ['senza record', 'licenza non ammessa'].includes(row.status));
  const nonRemediable = publishedUnresolved.filter((row) => row.nonRemediable);
  const inferred = inventory.filter((row) => row.status === 'inferred');
  const orphanFiles = inventory.filter((row) => row.status === 'orfano');
  const logoRows = inventory.filter((row) => ['brands', 'providers', 'insurers', 'logos'].includes(row.family));
  const logoFailures = logoRows.filter((row) => !row.sourceRegistered);

  const publishedControl = makeControl({
    id: 'B.published-image-records',
    section: 'B',
    title: 'Immagini pubblicate: record di licenza ammesso o record generativo valido',
    threshold: 'published missing/unlicensed images = 0 after bounded repair',
    counts: {
      files: inventory.filter((row) => row.file).length,
      published: inventory.filter((row) => row.referenced).length,
      ok: statusCounts.ok || 0,
      inferred: statusCounts.inferred || 0,
      withoutRecord: statusCounts['senza record'] || 0,
      unlicensed: statusCounts['licenza non ammessa'] || 0,
      orphan: statusCounts.orfano || 0,
      autoRepairable: candidates.length,
      nonRemediable: nonRemediable.length,
    },
    failures: publishedUnresolved.map((row) => ({
      family: row.family,
      imageUrl: row.url,
      status: row.status,
      reason: row.reason,
      autoRepairable: row.autoRepairable,
      protectedRealAuthor: row.protectedRealAuthor || false,
    })),
    warnings: [
      ...inferred.map((row) => ({ family: row.family, imageUrl: row.url, status: row.status })),
      ...orphanFiles.map((row) => ({ family: row.family, imageUrl: row.url, status: row.status })),
      ...orphanRecords,
    ],
    alarm: true,
    remediation: 'article-hero/place/editorial-profile; logos are inventory-only',
  });
  const logoControl = makeControl({
    id: 'B.logo-source-inventory',
    section: 'B',
    title: 'Loghi: file presenti e fonte registrata, senza sostituzione automatica',
    threshold: 'unregistered logo file = 0',
    counts: {
      inventory: logoRows.length,
      registered: logoRows.length - logoFailures.length,
      withoutRegisteredSource: logoFailures.length,
    },
    failures: logoFailures.map((row) => ({ family: row.family, imageUrl: row.url, reason: row.reason })),
    alarm: true,
    remediation: 'none; source registration is human-owned',
  });
  const realAuthorControl = makeControl({
    id: 'B.real-author-protection',
    section: 'B',
    title: 'Foto di autori reali: mai rimpiazzate dal motore',
    threshold: 'protected real-author assets are never auto-selected',
    counts: {
      realAuthorFiles: inventory.filter((row) => row.authorKind === 'real-author').length,
      protectedCandidates: inventory.filter((row) => row.protectedRealAuthor).length,
    },
    failures: [],
    warnings: inventory
      .filter((row) => row.authorKind === 'real-author' && row.status !== 'ok')
      .map((row) => ({ imageUrl: row.url, status: row.status, action: 'alarm only' })),
    alarm: false,
    remediation: 'alarm only for real authors',
  });
  return {
    inventory,
    candidates: candidates.filter(Boolean),
    orphanRecords,
    controls: [publishedControl, logoControl, realAuthorControl],
  };
}

function sampleHtmlFiles(directory, limit = 30) {
  if (!directory || !fs.existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    if (files.length >= limit) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(file);
    }
  };
  visit(directory);
  return files;
}

function extractOgImageUrls(source) {
  const urls = [];
  const patterns = [
    /<meta[^>]+property=['"]og:image['"][^>]+content=['"]([^'"]+)['"]/gi,
    /<meta[^>]+content=['"]([^'"]+)['"][^>]+property=['"]og:image['"]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) urls.push(match[1]);
  }
  return [...new Set(urls)];
}

export function auditOgImageSample({
  dist = null,
  knownUrls = new Set(),
  sampleLimit = 30,
}) {
  const files = sampleHtmlFiles(dist, sampleLimit);
  if (!dist || !files.length) {
    return makeControl({
      id: 'B.og-image-sample',
      section: 'B',
      title: 'Campione og:image del build pubblicato',
      threshold: 'sampled og:image values must be registered or site-owned',
      counts: { available: 0, files: 0, images: 0, invalid: 0 },
      warnings: [{ reason: 'dist sample unavailable; build/deploy gate will provide it' }],
      alarm: false,
      remediation: 'validate:og-images',
    });
  }
  const rows = [];
  for (const file of files) {
    for (const url of extractOgImageUrls(fs.readFileSync(file, 'utf8'))) {
      try {
        const absolute = new URL(url, SITE_ORIGIN).href;
        const pathname = new URL(absolute).pathname;
        const siteOwned = SITE_OWNED_OG_IMAGE_ALLOWLIST.some((prefix) => absolute === prefix || absolute.startsWith(prefix));
        const known = knownUrls.has(pathname);
        rows.push({
          file: path.relative(dist, file).split(path.sep).join('/'),
          url,
          pathname,
          valid: known || siteOwned,
          reason: known ? 'published inventory record' : siteOwned ? 'site-owned OG allowlist' : 'OG image is not in the registered inventory',
        });
      } catch {
        rows.push({
          file: path.relative(dist, file).split(path.sep).join('/'),
          url,
          pathname: null,
          valid: false,
          reason: 'invalid og:image URL',
        });
      }
    }
  }
  const invalid = rows.filter((row) => !row.valid);
  return makeControl({
    id: 'B.og-image-sample',
    section: 'B',
    title: 'Campione og:image del build pubblicato',
    threshold: 'sampled og:image values without a registered source = 0',
    counts: { available: 1, files: files.length, images: rows.length, invalid: invalid.length },
    failures: invalid,
    alarm: true,
    remediation: 'validate:og-images',
  });
}

function parseArticleCopyMetrics(root) {
  const candidates = [
    process.env.ARTICLE_COPY_METRICS_FILE,
    'data/article-copy-metrics.json',
    'data/article-overlap-metrics.json',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    const value = readJson(file);
    if (value) return { file: relative(root, file), value };
  }
  return null;
}

function runDescriptionGate(root) {
  try {
    const result = spawnSync(process.execPath, ['scripts/ci/check-event-description-publication.mjs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = String(result.stdout || '') + String(result.stderr || '');
    const jsonLines = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
    const parsed = jsonLines.length ? JSON.parse(jsonLines[jsonLines.length - 1]) : null;
    return {
      ok: result.status === 0 && parsed?.ok !== false,
      exitCode: result.status,
      details: parsed || { output: output.slice(-2000) },
    };
  } catch (error) {
    return { ok: false, exitCode: null, details: { error: String(error?.message || error) } };
  }
}

export function auditTextPublication({
  events = [],
  rewriteCache = { entries: {} },
  descriptionGate = { ok: true, details: {} },
  articleCopyMetrics = null,
}) {
  const withoutDescription = events.filter((event) => !event?.description).length;
  const residualQueue = Object.values(rewriteCache.entries || {})
    .filter((entry) => !entry?.rewrittenAt || !entry?.description || !entry?.descriptionByLocale)
    .length;
  const gateFailures = descriptionGate.ok ? [] : [{
    reason: 'existing event description publication gate failed',
    details: descriptionGate.details,
  }];
  const gateControl = makeControl({
    id: 'C.event-description-publication',
    section: 'C',
    title: 'Nessun testo di fonte nei dati eventi versionati',
    threshold: 'existing gate errors = 0',
    counts: {
      gateOk: descriptionGate.ok ? 1 : 0,
      gateErrors: descriptionGate.ok ? 0 : 1,
      events: events.length,
    },
    failures: gateFailures,
    alarm: true,
    remediation: 'none; reuse scripts/ci/check-event-description-publication.mjs',
  });
  const missingControl = makeControl({
    id: 'C.events-without-rewritten-description',
    section: 'C',
    title: 'Eventi senza descrizione riscritta',
    threshold: 'reported for remediation queue; does not block image repair',
    counts: { events: events.length, withoutDescription, rewritten: events.length - withoutDescription },
    warnings: withoutDescription ? [{ count: withoutDescription }] : [],
    alarm: false,
    remediation: 'description queue',
  });
  const queueControl = makeControl({
    id: 'C.description-rewrite-queue',
    section: 'C',
    title: 'Coda residua delle riscritture eventi',
    threshold: 'entries without complete rewrite = 0',
    counts: { entries: Object.keys(rewriteCache.entries || {}).length, residual: residualQueue },
    failures: residualQueue ? [{ residual: residualQueue }] : [],
    alarm: true,
    remediation: 'none; separate rewrite workflow',
  });
  const metricValue = articleCopyMetrics?.value;
  const metricFailures = metricValue && (
    metricValue.ok === false
    || Number(metricValue.violations || metricValue.overlaps || 0) > 0
  ) ? [{ file: articleCopyMetrics.file, value: metricValue }] : [];
  const metricsControl = makeControl({
    id: 'C.article-anti-copy-metrics',
    section: 'C',
    title: 'Metriche anti-copia articoli, se esposte',
    threshold: 'when available: violations = 0; unavailable is non-blocking',
    counts: {
      available: articleCopyMetrics ? 1 : 0,
      violations: Number(metricValue?.violations || metricValue?.overlaps || 0),
    },
    failures: metricFailures,
    warnings: articleCopyMetrics ? [] : [{ reason: 'metrics not exposed by the repository' }],
    alarm: true,
    remediation: 'none',
  });
  const jobsControl = makeControl({
    id: 'C.job-announcements-excluded',
    section: 'C',
    title: 'Annunci di lavoro esclusi dalla licenza testi per scelta del proprietario',
    threshold: 'explicit owner choice',
    counts: { excluded: true },
    alarm: false,
    remediation: 'by choice',
  });
  return { controls: [gateControl, missingControl, queueControl, metricsControl, jobsControl] };
}

function refContainsCommit(root, marker, ref) {
  const objectExists = spawnSync('git', ['cat-file', '-e', marker + '^{commit}'], {
    cwd: root,
    stdio: 'ignore',
  }).status === 0;
  if (!objectExists) return { known: false, contains: false };
  const status = spawnSync('git', ['merge-base', '--is-ancestor', marker, ref], {
    cwd: root,
    stdio: 'ignore',
  }).status;
  return { known: true, contains: status === 0 };
}

export function auditHistoryResidue({
  root,
  mainRef = 'origin/main',
  refs = [mainRef],
  marker = OLD_HISTORY_MARKER,
  treeFiles = null,
}) {
  const mainFiles = treeFiles || gitTreeFiles(root, mainRef, 'public/images/events');
  const eventPathFailures = mainFiles.map((file) => ({ ref: mainRef, file }));
  const markerRows = [];
  for (const ref of [...new Set(refs.filter(Boolean))]) {
    const result = refContainsCommit(root, marker, ref);
    if (!result.known) {
      markerRows.push({ ref, marker, present: false, object: 'not available locally' });
    } else if (result.contains) {
      markerRows.push({ ref, marker, present: true });
    }
  }
  const eventPathControl = makeControl({
    id: 'D.origin-main-event-path',
    section: 'D',
    title: 'origin/main non contiene il vecchio public/images/events',
    threshold: 'tracked paths under public/images/events = 0',
    counts: { paths: eventPathFailures.length },
    failures: eventPathFailures,
    alarm: true,
    remediation: 'none',
  });
  const markerControl = makeControl({
    id: 'D.history-marker',
    section: 'D',
    title: 'Il commit marcatore non è raggiungibile dai ref ispezionati',
    threshold: 'refs containing old marker = 0; only main and open-PR refs are inspected',
    counts: {
      refsInspected: refs.filter(Boolean).length,
      refsContainingMarker: markerRows.filter((row) => row.present).length,
      markerObjectUnavailable: markerRows.filter((row) => row.object).length,
    },
    failures: markerRows.filter((row) => row.present),
    warnings: markerRows.filter((row) => row.object),
    alarm: true,
    remediation: 'none',
  });
  return { controls: [eventPathControl, markerControl], markerRows };
}

async function probeUrl(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual' });
    return { url, status: Number(response.status || 0) };
  } catch (error) {
    return { url, status: 0, error: String(error?.message || error).slice(0, 180) };
  }
}

function rcloneBinary() {
  const runnerTemp = process.env.RUNNER_TEMP;
  const candidate = runnerTemp ? path.join(runnerTemp, 'rclone-bin', 'rclone') : '';
  if (candidate && fs.existsSync(candidate)) return candidate;
  return 'rclone';
}

function listR2LegacyKeys() {
  const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET'];
  if (required.some((key) => !process.env[key])) {
    return { available: false, reason: 'R2 credentials unavailable' };
  }
  const keys = [];
  const failures = [];
  for (const source of REMOVED_EVENT_IMAGE_SOURCES) {
    let result;
    try {
      result = spawnSync(rcloneBinary(), [
        '--s3-provider=Cloudflare',
        '--s3-access-key-id=' + process.env.R2_ACCESS_KEY_ID,
        '--s3-secret-access-key=' + process.env.R2_SECRET_ACCESS_KEY,
        '--s3-endpoint=' + process.env.R2_S3_ENDPOINT,
        '--s3-region=auto',
        '--s3-no-check-bucket',
        '--contimeout=15s',
        '--timeout=60s',
        'lsf',
        '--files-only',
        ':s3:' + process.env.R2_BUCKET + '/images/events/' + source,
      ], { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      failures.push({ source, reason: 'R2 listing failed: ' + String(error?.message || error).slice(0, 180) });
      continue;
    }
    if (result.status !== 0) {
      failures.push({ source, reason: 'R2 listing failed' });
      continue;
    }
    for (const key of String(result.stdout || '').split('\n').filter(Boolean)) {
      keys.push('images/events/' + key);
    }
  }
  return { available: failures.length === 0, keys, failures };
}

export async function auditRemovedCdnPrefixes({
  probe = false,
  listR2 = false,
  fetchImpl = globalThis.fetch,
  r2Lister = listR2LegacyKeys,
}) {
  if (!probe && !listR2) {
    return makeControl({
      id: 'D.removed-cdn-prefixes',
      section: 'D',
      title: 'Prefissi CDN delle fonti rimosse',
      threshold: 'HTTP sample and R2 inventory must show no live object',
      counts: { skipped: true },
      warnings: [{ reason: 'probe disabled; workflow enables it' }],
      alarm: false,
      remediation: 'probe in workflow',
    });
  }
  const probes = [];
  if (probe && typeof fetchImpl === 'function') {
    for (const source of REMOVED_EVENT_IMAGE_SOURCES) {
      const sampleName = LEGACY_CDN_SAMPLE_NAMES[source] || 'license-audit-probe';
      probes.push(await probeUrl(IMAGE_CDN_ORIGIN + '/images/events/' + source + '-' + sampleName + '.webp', fetchImpl));
    }
  }
  const r2 = listR2 ? r2Lister() : { available: false, skipped: true, keys: [], failures: [] };
  const liveHttp = probes.filter((item) => item.status >= 200 && item.status < 300);
  const badHttp = probes.filter((item) => item.status !== 404 && !(item.status >= 200 && item.status < 300));
  const failures = [
    ...liveHttp.map((item) => ({ ...item, reason: 'removed CDN prefix returned a live HTTP status' })),
    ...(r2.keys || []).map((key) => ({ key, reason: 'removed CDN prefix still exists in R2' })),
  ];
  const warnings = [
    ...badHttp.map((item) => ({ ...item, reason: item.status === 0 ? 'HTTP probe failed' : 'HTTP probe was neither 404 nor 2xx' })),
    ...(r2.failures || []),
    ...(!r2.available && listR2 && !r2.skipped ? [{ reason: r2.reason || 'R2 inventory unavailable' }] : []),
  ];
  return makeControl({
    id: 'D.removed-cdn-prefixes',
    section: 'D',
    title: 'Prefissi CDN delle fonti rimosse',
    threshold: 'live HTTP/R2 objects under removed prefixes = 0',
    counts: {
      prefixes: REMOVED_EVENT_IMAGE_SOURCES.length,
      httpProbes: probes.length,
      httpLive: liveHttp.length,
      r2Keys: (r2.keys || []).length,
      r2Available: r2.available ? 1 : 0,
    },
    failures,
    warnings,
    alarm: true,
    remediation: 'none',
  });
}

function loadAuditContext(root) {
  const eventsDataset = readJson(path.join(root, 'data', 'events.json'), { events: [] });
  const eventLibrary = readJson(path.join(root, 'data', 'event-image-library.json'), { assets: [] });
  const sharedRegistry = readJson(path.join(root, 'data', 'generated-image-registry.json'), { assets: [] });
  const blogRegistry = readJson(path.join(root, 'data', 'blog-generated-image-registry.json'), { assets: [] });
  const ledger = readJson(path.join(root, 'data', 'blog-cover-ledger.json'), { covers: {} });
  const rewriteCache = readJson(path.join(root, 'data', 'events-description-rewrites.json'), { entries: {} });
  const refs = parseSourceImageReferences(root);
  return {
    events: normalizeEventsDataset(eventsDataset),
    eventLibrary,
    sharedRegistry,
    blogRegistry,
    ledger,
    rewriteCache,
    references: refs.references,
    blogKeys: refs.blogKeys,
    authorsByPath: parseAuthors(root),
    sourceRegisteredLogoPaths: parseSourceRegisteredLogoPaths(root),
    socialUrls: collectSocialReferences(root),
    publicFiles: loadPublicImagePaths(root),
  };
}

function selectedSections(value) {
  if (!value || value === 'all') return new Set(['A', 'B', 'C', 'D']);
  const result = new Set(String(value).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean));
  if (![...result].every((item) => ['A', 'B', 'C', 'D'].includes(item))) {
    throw new Error('--sections accepts all or a comma-separated subset of A,B,C,D');
  }
  return result;
}

function mergeControls(controls) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const control of controls) summary[control.status] = (summary[control.status] || 0) + 1;
  return summary;
}

function reportAlarm(controls, actions = null) {
  const failures = controls
    .filter((control) => control.status === 'fail' && control.alarm)
    .flatMap((control) => control.examples.map((example) => ({ control: control.id, ...example })));
  const actionFailures = actions?.failures || [];
  return {
    required: failures.length > 0 || actionFailures.length > 0,
    title: ALARM_TITLE,
    nonRemediableFailures: examples([...failures, ...actionFailures]),
  };
}

export async function runLicenseAudit({
  root = process.cwd(),
  sections = 'all',
  mainRef = 'origin/main',
  refs = [mainRef],
  probeCdn = false,
  listR2 = false,
  fetchImpl = globalThis.fetch,
  r2Lister = listR2LegacyKeys,
  descriptionGate = null,
  dist = null,
}) {
  const selected = selectedSections(sections);
  const context = loadAuditContext(root);
  const controls = [];
  const candidates = [];
  const details = {};
  if (selected.has('A')) {
    const sourceSlices = readEventSlices(root);
    const slicesAudit = auditEventSourceSlices({
      root,
      slices: sourceSlices,
      eventRegistry: context.eventLibrary,
    });
    controls.push(slicesAudit.control);
    const eventsAudit = auditEventImages({
      events: context.events,
      eventRegistry: context.eventLibrary,
      crawlerFindings: crawlerPolicyFindings(root),
    });
    controls.push(...eventsAudit.controls);
    candidates.push(...eventsAudit.candidates);
    details.events = {
      total: context.events.length,
      rows: eventsAudit.rows.length,
      sourceSliceImages: slicesAudit.rows.length,
      statusCounts: countStatuses(eventsAudit.rows),
    };
  }
  if (selected.has('B')) {
    const otherAudit = auditOtherImages({
      root,
      publicFiles: context.publicFiles,
      registries: { shared: context.sharedRegistry, blog: context.blogRegistry },
      ledger: context.ledger,
      blogKeys: context.blogKeys,
      references: context.references,
      authorsByPath: context.authorsByPath,
      sourceRegisteredLogoPaths: context.sourceRegisteredLogoPaths,
      socialUrls: context.socialUrls,
    });
    controls.push(...otherAudit.controls);
    controls.push(auditOgImageSample({
      dist: dist || path.join(root, 'dist'),
      knownUrls: new Set(otherAudit.inventory.map((item) => item.url)),
    }));
    candidates.push(...otherAudit.candidates);
    details.images = {
      inventory: otherAudit.inventory.length,
      statusCounts: countStatuses(otherAudit.inventory),
      orphanRecords: otherAudit.orphanRecords.length,
    };
  }
  if (selected.has('C')) {
    const gate = descriptionGate || runDescriptionGate(root);
    const textAudit = auditTextPublication({
      events: context.events,
      rewriteCache: context.rewriteCache,
      descriptionGate: gate,
      articleCopyMetrics: parseArticleCopyMetrics(root),
    });
    controls.push(...textAudit.controls);
    details.text = { gate: gate.details || gate };
  }
  if (selected.has('D')) {
    const history = auditHistoryResidue({ root, mainRef, refs });
    controls.push(...history.controls);
    controls.push(await auditRemovedCdnPrefixes({
      probe: probeCdn,
      listR2,
      fetchImpl,
      r2Lister,
    }));
    details.history = { markerRows: history.markerRows };
  }
  const summary = mergeControls(controls);
  const report = {
    schemaVersion: LICENSE_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commit: gitOutput(root, ['rev-parse', 'HEAD']) || null,
    mainRef,
    refsInspected: refs.filter(Boolean),
    sections: [...selected].sort(),
    overall: summary.fail ? 'fail' : summary.warn ? 'warn' : 'pass',
    summary,
    controls,
    details,
    remediation: {
      candidateCount: candidates.length,
      autoRepairableCount: candidates.filter((candidate) => candidate?.autoRepairable).length,
      nonRemediableCount: controls.reduce((sum, control) => sum + Number(control.counts?.nonRemediable || 0), 0),
      candidates: candidates.filter(Boolean).sort(compareCandidates),
    },
  };
  report.alarm = reportAlarm(controls);
  return report;
}

function compareCandidates(a, b) {
  return (Number(b?.priority || 0) - Number(a?.priority || 0))
    || String(b?.recency || '').localeCompare(String(a?.recency || ''))
    || String(a?.path || a?.imageUrl || a?.key || '').localeCompare(String(b?.path || b?.imageUrl || b?.key || ''));
}

export function planReplacements(candidates, limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error('replacement limit must be an integer from 1 to ' + MAX_LIMIT);
  }
  const eligible = (candidates || []).filter((candidate) => (
    candidate?.autoRepairable
    && !candidate?.protectedRealAuthor
    && candidate?.kind !== 'real-author'
  )).sort(compareCandidates);
  return {
    requested: eligible.length,
    limit,
    selected: eligible.slice(0, limit),
    deferred: eligible.slice(limit),
  };
}

export function isAutoRepairableCandidate(candidate) {
  return Boolean(
    candidate?.autoRepairable
    && !candidate?.protectedRealAuthor
    && candidate?.authorKind !== 'real-author'
    && candidate?.kind !== 'real-author',
  );
}

export function buildGenerationSpec(candidate) {
  if (!isAutoRepairableCandidate(candidate)) {
    throw new Error('candidate is protected from automatic image replacement');
  }
  const subject = candidate.kind === 'article-hero'
    ? 'editorial illustration for the article ' + candidate.key + ', generic and non-documentary'
    : candidate.kind === 'place'
      ? 'generic editorial illustration of the place represented by ' + candidate.key
      : candidate.kind === 'editorial-profile'
        ? 'abstract illustrated editorial avatar for the newsroom profile ' + candidate.key + ', no real face'
        : 'generic editorial event illustration for ' + candidate.category;
  const spec = {
    scope: candidate.scope,
    subject,
    area: candidate.area || 'Ticino, Lombardy and the Swiss Italian border region',
    season: candidate.season || 'all seasons',
    category: candidate.category || candidate.family || 'editorial',
    variant: 'license-audit-replacement-' + candidate.key,
    assetId: candidate.assetId,
  };
  return {
    ...spec,
    publishedImageUrl: candidate.imageUrl || candidate.path,
  };
}

function ensureSparsePath(root, relativePath) {
  try {
    execFileSync('git', ['sparse-checkout', 'add', relativePath], { cwd: root, stdio: 'ignore' });
  } catch {
    // Non-sparse checkouts and test fixtures do not need this operation.
  }
}

function copyGeneratedFile(root, result, url) {
  if (!result?.filePath || !url || !url.startsWith('/images/')) return null;
  const relativePath = 'public' + url;
  ensureSparsePath(root, relativePath);
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(result.filePath, destination);
  return relativePath;
}

function articleCreditRecord(generated) {
  const record = {
    schema: 1,
    cover: generated.imageUrl,
    source: 'generated-provider',
    commons: {
      title: 'Generated editorial illustration',
      pageUrl: generated.licenseUrl,
      width: generated.width,
      height: generated.height,
      revision: generated.generatedAt,
    },
    author: {
      text: generated.credit,
      name: generated.credit,
      url: null,
      type: 'Organization',
    },
    attribution: null,
    licence: {
      name: 'Generated media — provider terms apply',
      url: generated.licenseUrl,
      family: 'other-attribution',
      attributionRequired: true,
    },
    restrictions: [...(generated.restrictions || [])],
    modified: 'resized',
    fetchedAt: String(generated.generatedAt || '').slice(0, 10),
    status: 'ok',
    curation: null,
    generated,
  };
  const validation = safeCreditValidation(record);
  if (!validation.valid) throw new Error('generated article record invalid: ' + validation.errors.join('; '));
  return record;
}

function updateGeneratedRegistry(root, file, scope, generated) {
  const registryPath = path.join(root, file);
  const current = readJson(registryPath, {
    schema: 1,
    registry: 'editorial-profile-and-place-images',
    cdnPrefix: scope === 'article-hero' ? '/images/blog/' : undefined,
    assetCount: 0,
    assets: [],
  });
  const keyFor = (record) => scope === 'event-library' ? record.assetId : record.imageUrl;
  const assets = new Map((current.assets || []).map((record) => [keyFor(record), record]));
  assets.set(keyFor(generated), generated);
  const registry = {
    ...current,
    assetCount: assets.size,
    generatedAt: new Date().toISOString(),
    assets: [...assets.values()].sort((a, b) => String(a.imageUrl).localeCompare(String(b.imageUrl))),
  };
  const validation = validateGeneratedImageRegistry(registry, { scope });
  if (!validation.valid) throw new Error(file + ' invalid after replacement: ' + validation.errors.join('; '));
  writeJson(registryPath, registry);
}

function updateBlogLedgers(root, candidate, record) {
  const key = candidate.assetId;
  const ledgerPath = path.join(root, 'data', 'blog-cover-ledger.json');
  const queuePath = path.join(root, 'data', 'blog-cover-replacements.json');
  const ledger = readJson(ledgerPath, { schema: 1, covers: {} });
  const queue = readJson(queuePath, { schema: 1, items: {} });
  if (!queue.items || typeof queue.items !== 'object') queue.items = {};
  if (!ledger.covers || typeof ledger.covers !== 'object') ledger.covers = {};
  const ledgerItem = ledger.covers[key] || {
    cover: candidate.imageUrl,
    hash: null,
    published: true,
    historicalPublished: true,
    references: [],
    proofLevel: 5,
    priority: 0,
  };
  ledgerItem.action = 'generated';
  ledgerItem.evidence = 'generated-engine-record';
  ledgerItem.status = 'generated';
  ledgerItem.recordFile = 'packages/articles/content/image-credits/blog/' + key + '.json';
  ledgerItem.generated = {
    provider: record.generated.provider,
    assetId: record.generated.assetId,
    imageUrl: record.generated.imageUrl,
    evidence: 'generated-engine-record',
  };
  ledger.covers[key] = ledgerItem;
  const existing = queue.items?.[key] || {};
  const fromCover = existing.fromCover || candidate.imageUrl;
  const toCover = existing.toCover || candidate.imageUrl;
  if (fromCover !== toCover || fromCover !== candidate.imageUrl) {
    throw new Error(key + ': cross-content image repoint is forbidden');
  }
  queue.items[key] = {
    ...existing,
    mode: 'generated',
    status: 'generated',
    fromCover,
    toCover,
    recordFile: 'packages/articles/content/image-credits/blog/' + key + '.json',
    generatedAssetId: record.generated.assetId,
    provider: record.generated.provider,
    generatedAt: record.generated.generatedAt,
  };
  writeJson(ledgerPath, ledger);
  writeJson(queuePath, queue);
  const recordFile = path.join(root, 'packages', 'articles', 'content', 'image-credits', 'blog', key + '.json');
  ensureSparsePath(root, 'packages/articles/content/image-credits/blog/' + key + '.json');
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

function updateEventDatasets(root, candidate, generated) {
  const eventPaths = [
    path.join(root, 'data', 'events.json'),
    ...fs.existsSync(path.join(root, 'data', 'events', 'by-source'))
      ? fs.readdirSync(path.join(root, 'data', 'events', 'by-source'))
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(root, 'data', 'events', 'by-source', file))
      : [],
  ];
  for (const file of eventPaths) {
    const value = readJson(file);
    if (!value) continue;
    const events = normalizeEventsDataset(value);
    let changed = false;
    for (const event of events) {
      if (!candidate.eventId || event.id !== candidate.eventId) continue;
      event.imageUrl = generated.imageUrl;
      event.imageAssetId = generated.assetId;
      event.imageLicense = generated.license;
      event.imageLicenseUrl = generated.licenseUrl;
      event.imageCredit = generated.credit;
      event.imageProvider = generated.provider;
      changed = true;
    }
    if (changed) writeJson(file, value);
  }
}

async function defaultGenerator(spec, options) {
  const engine = await import('../../packages/articles/engine/shared/generatedImageEngine.mjs');
  return engine.generateImageFromSpec(spec, options);
}

export async function applyLicenseReplacements({
  root = process.cwd(),
  candidates = [],
  limit = DEFAULT_LIMIT,
  generator = defaultGenerator,
  outputDir = path.join(root, '.cache', 'license-audit'),
}) {
  const plan = planReplacements(candidates, limit);
  const generated = [];
  const reused = [];
  const failures = [];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const candidate of plan.selected) {
    try {
      if (candidate.kind === 'event' && candidate.existingRecord) {
        updateEventDatasets(root, candidate, candidate.existingRecord);
        reused.push({
          kind: candidate.kind,
          scope: candidate.scope,
          assetId: candidate.existingRecord.assetId,
          imageUrl: candidate.existingRecord.imageUrl,
          provider: candidate.existingRecord.provider,
          originalImageUrl: candidate.originalImageUrl || null,
        });
        continue;
      }
      const spec = buildGenerationSpec(candidate);
      const scopeDir = path.join(outputDir, candidate.scope);
      const result = await generator(spec, {
        outputDir: scopeDir,
        assetId: candidate.assetId,
        publishedImageUrl: spec.publishedImageUrl,
        maxAttempts: 3,
      });
      if (!result?.record || result.record.imageUrl !== spec.publishedImageUrl) {
        throw new Error(candidate.key + ': generated record must preserve the assigned image URL');
      }
      const generatedValidation = safeGeneratedValidation(result.record, candidate.scope);
      if (!generatedValidation.valid) {
        throw new Error(candidate.key + ': governed record invalid: ' + generatedValidation.errors.join('; '));
      }
      if (candidate.kind === 'article-hero') {
        const record = articleCreditRecord(result.record);
        copyGeneratedFile(root, result, candidate.imageUrl);
        updateGeneratedRegistry(root, 'data/blog-generated-image-registry.json', 'article-hero', result.record);
        updateBlogLedgers(root, candidate, record);
        generated.push({
          kind: candidate.kind,
          scope: candidate.scope,
          assetId: candidate.assetId,
          imageUrl: result.record.imageUrl,
          provider: result.record.provider,
          sha256: result.record.sha256,
          localFile: relative(root, result.filePath),
        });
      } else if (candidate.kind === 'place' || candidate.kind === 'editorial-profile') {
        copyGeneratedFile(root, result, candidate.imageUrl);
        updateGeneratedRegistry(root, 'data/generated-image-registry.json', candidate.scope, result.record);
        generated.push({
          kind: candidate.kind,
          scope: candidate.scope,
          assetId: candidate.assetId,
          imageUrl: result.record.imageUrl,
          provider: result.record.provider,
          sha256: result.record.sha256,
          localFile: relative(root, result.filePath),
        });
      } else if (candidate.kind === 'event') {
        copyGeneratedFile(root, result, candidate.imageUrl);
        updateGeneratedRegistry(root, 'data/event-image-library.json', 'event-library', result.record);
        updateEventDatasets(root, candidate, result.record);
        generated.push({
          kind: candidate.kind,
          scope: candidate.scope,
          assetId: candidate.assetId,
          imageUrl: result.record.imageUrl,
          provider: result.record.provider,
          sha256: result.record.sha256,
          localFile: relative(root, result.filePath),
        });
      }
    } catch (error) {
      failures.push({
        kind: candidate.kind,
        assetId: candidate.assetId,
        imageUrl: candidate.imageUrl || candidate.path || null,
        error: String(error?.message || error).slice(0, 300),
      });
    }
  }
  return {
    requested: plan.requested,
    selected: plan.selected.length,
    deferred: plan.deferred.length,
    generated,
    reused,
    failures,
  };
}

export function buildAlarmRequest(report) {
  if (!report?.alarm?.required) return null;
  return {
    title: ALARM_TITLE,
    label: 'Bug',
    priority: 2,
    workflow: 'license-audit',
    description: report,
  };
}

export function renderMarkdownReport(report) {
  const lines = [
    '# License audit',
    '',
    '- Esito: **' + String(report.overall || '').toUpperCase() + '**',
    '- Commit: ' + (report.commit || 'unknown'),
    '- Sezioni: ' + (report.sections || []).join(', '),
    '- Candidati auto-riparabili: ' + Number(report.remediation?.candidateCount || 0),
    '- Nuove sostituzioni generate: ' + Number(report.actions?.generated?.length || 0),
    '- Record governati riusati: ' + Number(report.actions?.reused?.length || 0),
    '',
    '| ID | Esito | Soglia | Conteggi |',
    '| --- | --- | --- | --- |',
  ];
  for (const control of report.controls || []) {
    lines.push(
      '| ' + control.id + ' | **' + control.status + '** | '
      + String(control.threshold).replace(/\|/g, '\\|') + ' | '
      + JSON.stringify(control.counts).replace(/\|/g, '\\|') + ' |',
    );
  }
  lines.push('', '## Esempi', '');
  for (const control of report.controls || []) {
    if (!control.examples?.length) continue;
    lines.push('- ' + control.id);
    for (const example of control.examples.slice(0, MAX_EXAMPLES)) {
      lines.push('  - ' + JSON.stringify(example));
    }
  }
  if (report.alarm?.required) {
    lines.push('', '## Allarme', '', '- Issue stabile richiesta: ' + ALARM_TITLE + '.');
  } else {
    lines.push('', 'Nessun allarme non rimediabile richiesto.');
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const args = {
    apply: false,
    limit: DEFAULT_LIMIT,
    sections: 'all',
    mainRef: 'origin/main',
    refs: [],
    refsFile: null,
    probeCdn: false,
    listR2: false,
    jsonOut: null,
    markdownOut: null,
    dist: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--limit') args.limit = Number(argv[++index]);
    else if (arg === '--sections') args.sections = argv[++index] || 'all';
    else if (arg === '--ref') args.refs.push(argv[++index]);
    else if (arg === '--main-ref') args.mainRef = argv[++index];
    else if (arg === '--refs-file') args.refsFile = argv[++index];
    else if (arg === '--probe-cdn') args.probeCdn = true;
    else if (arg === '--r2-list') args.listR2 = true;
    else if (arg === '--json-out') args.jsonOut = argv[++index];
    else if (arg === '--markdown-out') args.markdownOut = argv[++index];
    else if (arg === '--dist') args.dist = argv[++index];
    else if (arg === '--help') {
      console.log('Usage: node scripts/audit/license-audit.mjs [--apply] [--limit 1..20] [--sections all|A,B,C,D] [--ref REF] [--refs-file FILE] [--probe-cdn] [--r2-list] [--dist DIR] [--json-out FILE] [--markdown-out FILE]');
      process.exit(0);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
    throw new Error('--limit must be an integer from 1 to ' + MAX_LIMIT);
  }
  if (args.refsFile) {
    const text = fs.readFileSync(args.refsFile, 'utf8');
    args.refs.push(...text.split('\n').map((line) => line.trim()).filter(Boolean));
  }
  args.refs = [...new Set([args.mainRef, ...args.refs])];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const before = await runLicenseAudit({
    root,
    sections: args.sections,
    mainRef: args.mainRef,
    refs: args.refs,
    probeCdn: args.probeCdn,
    listR2: args.listR2,
    dist: args.dist,
  });
  let report = before;
  if (args.apply) {
    const actions = await applyLicenseReplacements({
      root,
      candidates: before.remediation.candidates,
      limit: args.limit,
    });
    if (actions.generated.some((item) => item.kind === 'article-hero')) {
      const result = spawnSync(process.execPath, ['scripts/audit/build-blog-image-credits-index.mjs'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      if (result.status !== 0) {
        actions.failures.push({
          kind: 'article-hero-index',
          error: String(result.stderr || result.stdout || 'image credit index failed').slice(0, 300),
        });
      }
    }
    report = await runLicenseAudit({
      root,
      sections: args.sections,
      mainRef: args.mainRef,
      refs: args.refs,
      probeCdn: args.probeCdn,
      listR2: args.listR2,
      dist: args.dist,
    });
    report.actions = actions;
    report.alarm = reportAlarm(report.controls, actions);
  } else {
    report.actions = { requested: false, generated: [], reused: [], failures: [], selected: 0, deferred: 0 };
  }
  if (args.jsonOut) writeJson(path.resolve(root, args.jsonOut), report);
  const markdown = renderMarkdownReport(report);
  if (args.markdownOut) {
    fs.mkdirSync(path.dirname(path.resolve(root, args.markdownOut)), { recursive: true });
    fs.writeFileSync(path.resolve(root, args.markdownOut), markdown, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  console.error(markdown);
  if (report.overall === 'fail' || report.alarm?.required) process.exitCode = 1;
}

const isDirectRun = (() => {
  try {
    return import.meta.url === new URL('file://' + process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error('[license-audit] ' + String(error?.stack || error));
    process.exitCode = 1;
  });
}
