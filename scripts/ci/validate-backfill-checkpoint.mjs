#!/usr/bin/env node
/**
 * Validate the raw slice contract before a resumable history-backfill
 * checkpoint is pushed.
 *
 * A checkpoint does not need the assembled jobs.json to be durable: deploy
 * assembles that derived artifact from the committed slices. It does need the
 * slice inputs to be fail-closed, otherwise a timeout recovery could publish a
 * truncated or oversized archive while the expensive full gate is still
 * pending. Keep this gate independent from assemble-jobs-dataset.mjs so it is
 * cheap enough to run after every bounded batch.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { readJsonFile } from '../lib/read-large-json.mjs';
import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { parseExpiredSliceFileName } from '../lib/expired-slice-names.mjs';
import { EXPIRED_SLICE_SIZE_LIMIT_BYTES } from '../lib/related-search-output-limit.mjs';
import { hasPublishedRouteIdentity } from '../lib/job-identity.mjs';

const ROOT = process.cwd();
const ACTIVE_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const requestedKeys = new Set(
  String(process.env.CRAWLER_KEYS || '')
    .split(/[\s,]+/u)
    .map((key) => key.trim())
    .filter(Boolean),
);

const isParsableExpiredAt = (value) =>
  typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));

// The assembler's metadata-only checkpoint row is deliberately explicit. A
// company/source field on an otherwise malformed job is not proof that the
// row was quarantined; the source marker and owner key are the contract.
function hasQuarantineMetadata(job) {
  return job?.source === 'thin-source-quarantine'
    && typeof job?.companyKey === 'string'
    && job.companyKey.trim() !== '';
}

const failures = [];
let activeRows = 0;
let expiredRows = 0;
const UNREADABLE = Symbol('unreadable');

function fail(message) {
  failures.push(message);
}

function readFile(filePath, label) {
  try {
    return readJsonFile(filePath);
  } catch (error) {
    fail(`${label}: unreadable JSON (${error.message})`);
    return UNREADABLE;
  }
}

function hasValidLocaleRoutes(entry, label) {
  if (entry.slugByLocale === undefined) return true;
  if (!entry.slugByLocale || typeof entry.slugByLocale !== 'object' || Array.isArray(entry.slugByLocale)) {
    fail(`${label}: slugByLocale must be an object of locale route strings`);
    return false;
  }
  let valid = true;
  for (const [locale, slug] of Object.entries(entry.slugByLocale)) {
    if (typeof slug !== 'string') {
      fail(`${label}: slugByLocale.${locale} must be a string`);
      valid = false;
    }
  }
  return valid;
}

if (!fs.existsSync(ACTIVE_DIR)) {
  fail(`missing active slice directory: ${path.relative(ROOT, ACTIVE_DIR)}`);
} else {
  for (const name of listSliceFileNames(ACTIVE_DIR)) {
    const key = name.slice(0, -'.json'.length);
    if (requestedKeys.size > 0 && !requestedKeys.has(key)) continue;
    const filePath = path.join(ACTIVE_DIR, name);
    const parsed = readFile(filePath, `active/${name}`);
    if (parsed === UNREADABLE) continue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) {
      fail(`active/${name}: expected an object with a jobs array`);
      continue;
    }
    if (typeof parsed.crawlerKey !== 'string' || parsed.crawlerKey.trim() !== key) {
      fail(`active/${name}: crawlerKey must equal '${key}'`);
    }
    parsed.jobs.forEach((job, index) => {
      if (!job || typeof job !== 'object' || Array.isArray(job)) {
        fail(`active/${name}.jobs[${index}]: expected an object`);
      } else if (!hasPublishedRouteIdentity(job) && !hasQuarantineMetadata(job)) {
        fail(
          `active/${name}.jobs[${index}]: missing published job identity or `
          + 'documented quarantine metadata',
        );
      }
    });
    if (parsed.crawlerKey === key) {
      activeRows += parsed.jobs.length;
    }
  }
  if (requestedKeys.size > 0) {
    for (const key of requestedKeys) {
      if (!fs.existsSync(path.join(ACTIVE_DIR, `${key}.json`))) {
        fail(`active/${key}.json: requested checkpoint slice is missing`);
      }
    }
  }
}

if (!fs.existsSync(EXPIRED_DIR)) {
  fail(`missing expired slice directory: ${path.relative(ROOT, EXPIRED_DIR)}`);
} else {
  const names = fs.readdirSync(EXPIRED_DIR).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    const parsedName = parseExpiredSliceFileName(name);
    if (!parsedName) {
      fail(`expired/${name}: not a recognised crawler slice or shard`);
      continue;
    }
    if (requestedKeys.size > 0 && !requestedKeys.has(parsedName.key)) continue;

    const filePath = path.join(EXPIRED_DIR, name);
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (error) {
      fail(`expired/${name}: cannot stat file (${error.message})`);
      continue;
    }
    if (size > EXPIRED_SLICE_SIZE_LIMIT_BYTES) {
      fail(
        `expired/${name}: ${size} bytes exceeds ${EXPIRED_SLICE_SIZE_LIMIT_BYTES} byte ceiling`,
      );
    }

    const parsed = readFile(filePath, `expired/${name}`);
    if (parsed === UNREADABLE) continue;
    if (!Array.isArray(parsed)) {
      fail(`expired/${name}: expected a top-level JSON array`);
      continue;
    }

    expiredRows += parsed.length;
    parsed.forEach((entry, index) => {
      const label = `expired/${name}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`${label}: expected an object`);
        return;
      }
      if (typeof entry.slug !== 'string' || entry.slug.trim() === '') {
        fail(`${label}: requires a non-empty slug route identity`);
      }
      hasValidLocaleRoutes(entry, label);
      if (!isParsableExpiredAt(entry.expiredAt)) {
        fail(`${label}: expiredAt is not parsable`);
      }
    });
  }
}

if (failures.length > 0) {
  console.error(
    `\x1b[31m[validate-backfill-checkpoint]\x1b[0m FAIL — ${failures.length} raw slice invariant(s):\n` +
      failures.slice(0, 20).map((failure) => `  - ${failure}`).join('\n') +
      (failures.length > 20 ? `\n  … ${failures.length - 20} more` : ''),
  );
  process.exit(1);
}

console.log(
  `\x1b[32m[validate-backfill-checkpoint]\x1b[0m PASS — ` +
    `${activeRows} active rows, ${expiredRows} expired rows; raw slices are safe to checkpoint`,
);
