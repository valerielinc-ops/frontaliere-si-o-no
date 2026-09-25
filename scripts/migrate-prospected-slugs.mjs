#!/usr/bin/env node
/**
 * Migrate the six dedicated prospector families to the canonical
 * title/company/location slug base plus the URL-derived disambiguator.
 *
 * The default is a read-only preflight. Pass --apply only after the complete
 * cross-slice plan has passed validation. Every retired active slug is copied
 * into its locale-aware history before the new route is written.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  addPreviousSlugForLocale,
  cleanPreviousSlugsPerLocale,
  fingerprintJob,
  loadSlugRegistry,
} from './lib/dedicated-crawler-common.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import { buildSlug } from './lib/regenerate-slugs-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const HISTORY_CAP = 20;

export const TARGET_CRAWLERS = Object.freeze([
  'accor',
  'ete',
  'gmo',
  'michaelpage',
  'okjob',
  'recruitingapp-2649',
]);

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

function requiredString(value, field, jobId) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Cannot migrate ' + jobId + ': missing required ' + field);
  }
  return value;
}

function urlDisambiguator(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
}

/**
 * Produce a side-effect-free migration plan for one live job.
 * Requiring every currently live locale route and every localized title is
 * deliberate: a partial plan could silently strand an indexed URL.
 */
export function planProspectedSlugMigration(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('Cannot migrate an invalid job record');
  }

  const jobId = String(job.id || '<unknown>');
  const url = requiredString(job.url, 'detail URL', jobId);
  const masterSlug = requiredString(job.slug, 'master active slug', jobId);
  if (!job.slugByLocale || typeof job.slugByLocale !== 'object' || Array.isArray(job.slugByLocale)) {
    throw new Error('Cannot migrate ' + jobId + ': missing slugByLocale');
  }
  if (!job.titleByLocale || typeof job.titleByLocale !== 'object' || Array.isArray(job.titleByLocale)) {
    throw new Error('Cannot migrate ' + jobId + ': missing titleByLocale');
  }

  const oldSlugByLocale = {};
  for (const locale of LOCALES) {
    oldSlugByLocale[locale] = requiredString(job.slugByLocale[locale], 'active slug for ' + locale, jobId);
  }

  const company = requiredString(job.company, 'company', jobId);
  const location = requiredString(job.location || job.addressLocality, 'location', jobId);
  const nextSlugByLocale = {};
  for (const locale of LOCALES) {
    const title = requiredString(job.titleByLocale[locale], 'title for ' + locale, jobId);
    const nextSlug = buildSlug(title, company, location, urlDisambiguator(url));
    if (!nextSlug) {
      throw new Error('Cannot migrate ' + jobId + ': canonical slug is empty for ' + locale);
    }
    nextSlugByLocale[locale] = nextSlug;
  }

  return {
    jobId,
    masterSlug,
    oldSlugByLocale,
    nextSlugByLocale,
    slugDisambiguator: urlDisambiguator(url),
  };
}

/**
 * Apply a validated plan in place and preserve all active routes that it
 * retires. This function is idempotent and keeps the legacy flat history in
 * sync through the shared locale-aware helper.
 */
export function applyProspectedSlugMigration(job, plan = planProspectedSlugMigration(job)) {
  const before = JSON.stringify(job);
  const oldItSlug = plan.oldSlugByLocale.it;

  for (const locale of LOCALES) {
    const oldSlug = plan.oldSlugByLocale[locale];
    const nextSlug = plan.nextSlugByLocale[locale];
    if (oldSlug !== nextSlug) {
      addPreviousSlugForLocale(job, locale, oldSlug, HISTORY_CAP, 'migrate-prospected-slugs');
    }
  }

  // Some historical slices carried a master slug that was not mirrored in
  // slugByLocale.it. Preserve that route as well instead of assuming it away.
  if (plan.masterSlug !== plan.nextSlugByLocale.it && plan.masterSlug !== oldItSlug) {
    addPreviousSlugForLocale(job, 'it', plan.masterSlug, HISTORY_CAP, 'migrate-prospected-slugs');
  }

  job.slugByLocale = {
    ...(job.slugByLocale || {}),
    ...plan.nextSlugByLocale,
  };
  job.slug = plan.nextSlugByLocale.it;
  job.slugDisambiguator = plan.slugDisambiguator;
  cleanPreviousSlugsPerLocale(job);

  return {
    ...plan,
    changed: JSON.stringify(job) !== before,
  };
}

function addSlugOwner(ownerMap, key, owner) {
  const owners = ownerMap.get(key) || new Set();
  owners.add(owner);
  ownerMap.set(key, owners);
}

function cloneSlugOwnerMap(ownerMap) {
  const copy = new Map();
  for (const [key, owners] of ownerMap) {
    copy.set(key, owners instanceof Set ? new Set(owners) : new Set([owners]));
  }
  return copy;
}

function activeJobOwner(job, fallback) {
  const id = String(job?.id || '').trim();
  return id ? 'job:' + id : fallback;
}

function registryOwner(job) {
  const fingerprint = typeof job?.url === 'string' && job.url.trim()
    ? fingerprintJob(job)
    : '';
  return fingerprint ? 'registry:' + fingerprint : '';
}

function activeSlugsByLocale(job, locale) {
  const values = locale === 'it'
    ? [job?.slug, job?.slugByLocale?.it]
    : [job?.slugByLocale?.[locale]];
  return values
    .map((slug) => String(slug || '').trim())
    .filter(Boolean);
}

/**
 * Build the active `(locale, slug) -> owner` map used by the migration
 * preflight. Keeping this pure makes the cross-slice collision rule directly
 * testable without writing cron data.
 */
export function buildProspectedSlugOwnerMap(records) {
  const owners = new Map();
  for (const record of records) {
    const job = record.job || record;
    const owner = record.owner || activeJobOwner(job, record.fallbackOwner || 'active:<unknown>');
    for (const locale of LOCALES) {
      for (const slug of activeSlugsByLocale(job, locale)) {
        addSlugOwner(owners, locale + ':' + slug, owner);
      }
    }
  }
  return owners;
}

function readActiveSlugOwners() {
  const activeRecords = [];
  for (const fileName of listSliceFileNames(SLICES_DIR)) {
    const filePath = path.join(SLICES_DIR, fileName);
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || !Array.isArray(payload.jobs)) {
      throw new Error('Invalid active crawler slice: ' + filePath);
    }
    const crawlerKey = fileName.replace(/\.json$/, '');
    payload.jobs.forEach((job, index) => {
      activeRecords.push({
        job,
        owner: activeJobOwner(job, crawlerKey + ':index:' + index),
      });
    });
  }

  const owners = buildProspectedSlugOwnerMap(activeRecords);
  const registry = loadSlugRegistry();
  for (const [fingerprint, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') continue;
    const owner = 'registry:' + fingerprint;
    const slugByLocale = entry.slugByLocale && typeof entry.slugByLocale === 'object'
      ? entry.slugByLocale
      : {};
    for (const locale of LOCALES) {
      const slugs = locale === 'it'
        ? [slugByLocale.it, entry.canonicalSlug]
        : [slugByLocale[locale]];
      for (const slug of slugs.map((value) => String(value || '').trim()).filter(Boolean)) {
        addSlugOwner(owners, locale + ':' + slug, owner);
      }
    }
  }
  return owners;
}

function entryOwners(entry) {
  return new Set([
    entry.owner || activeJobOwner(entry.job, entry.crawlerKey + ':' + entry.plan.jobId),
    entry.registryOwner || registryOwner(entry.job),
  ].filter(Boolean));
}

/**
 * Reject collisions before any slice is written. A route is identified by
 * locale plus slug because each locale has its own public URL prefix.
 */
export function validateProspectedSlugPlans(entries, activeSlugOwners = new Map()) {
  const seen = cloneSlugOwnerMap(activeSlugOwners);
  for (const entry of entries) {
    const owners = entryOwners(entry);
    for (const locale of LOCALES) {
      const slug = entry.plan.nextSlugByLocale[locale];
      const key = locale + ':' + slug;
      const previousOwners = seen.get(key) || new Set();
      const previousOwner = [...previousOwners].find((owner) => !owners.has(owner));
      if (previousOwner) {
        throw new Error(
          'Refusing prospected slug migration: ' + key + ' is claimed by '
          + previousOwner + ' and ' + [...owners].find((owner) => owner !== previousOwner),
        );
      }
      addSlugOwner(seen, key, [...owners][0]);
    }
  }
  return entries;
}

function readEntries() {
  const entries = [];
  for (const crawlerKey of TARGET_CRAWLERS) {
    const filePath = path.join(SLICES_DIR, crawlerKey + '.json');
    if (!fs.existsSync(filePath)) {
      throw new Error('Missing target crawler slice: ' + filePath);
    }
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || !Array.isArray(payload.jobs)) {
      throw new Error('Invalid target crawler slice: ' + filePath);
    }
    for (const job of payload.jobs) {
      entries.push({
        crawlerKey,
        filePath,
        payload,
        job,
        plan: planProspectedSlugMigration(job),
        owner: activeJobOwner(job, crawlerKey + ':index:' + entries.length),
        registryOwner: registryOwner(job),
      });
    }
  }
  return validateProspectedSlugPlans(entries, readActiveSlugOwners());
}

export function needsProspectedSlugMigration(job, plan) {
  return (
    plan.slugDisambiguator !== String(job.slugDisambiguator || '').trim()
    || plan.masterSlug !== plan.nextSlugByLocale.it
    || LOCALES.some((locale) => plan.oldSlugByLocale[locale] !== plan.nextSlugByLocale[locale])
  );
}

export function main({ apply = process.argv.includes('--apply') } = {}) {
  const entries = readEntries();
  const changed = entries.filter((entry) => needsProspectedSlugMigration(entry.job, entry.plan));

  if (apply) {
    const changedFiles = new Set();
    for (const entry of changed) {
      const result = applyProspectedSlugMigration(entry.job, entry.plan);
      if (result.changed) changedFiles.add(entry.filePath);
    }
    for (const filePath of changedFiles) {
      const payload = entries.find((entry) => entry.filePath === filePath).payload;
      writeJsonAtomic(filePath, payload);
    }
  }

  const mode = apply ? 'Applied' : 'Dry run';
  console.log(mode + ' prospected slug migration: ' + changed.length + ' of ' + entries.length + ' jobs, ' + TARGET_CRAWLERS.length + ' slices.');
  if (!apply && changed.length > 0) {
    console.log('Re-run with --apply to write the validated plan.');
  }
  return { entries, changed: changed.length, applied: apply };
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === entrypoint) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
