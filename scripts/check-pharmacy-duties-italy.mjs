#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ITALY_DUTY_MAX_AGE_HOURS,
  ITALY_DUTY_PROVINCES,
  ITALY_DUTY_TIMEZONE,
  verifyItalyReleaseSnapshots,
} from './lib/pharmacy-italy-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..');
const DEFAULT_DUTIES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy.json');
const DEFAULT_STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-status.json');
const DEFAULT_SOURCES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-sources.json');

function argumentValue(prefix, fallback) {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function checkFreshness(timestamp, now, maxAgeHours = ITALY_DUTY_MAX_AGE_HOURS) {
  if (!isIso(timestamp)) return false;
  const ageHours = (now.getTime() - Date.parse(timestamp)) / 3_600_000;
  return ageHours >= -1 && ageHours <= maxAgeHours;
}

export function checkItalyDutyData({ duties, status, sources, now = new Date() }) {
  const errors = [];
  const sourceList = Array.isArray(sources?.sources) ? sources.sources : [];
  const sourceByProvince = new Map();
  for (const source of sourceList) {
    if (!ITALY_DUTY_PROVINCES.includes(source?.province)) errors.push(`source ${source?.key || '<unknown>'}: unsupported province`);
    if (source?.sourceType !== 'official' || !/^https:\/\//i.test(source?.officialSourceUrl || '')) {
      errors.push(`source ${source?.key || '<unknown>'}: source must be official HTTPS`);
    }
    if (sourceByProvince.has(source?.province)) errors.push(`source: duplicate province ${source?.province}`);
    sourceByProvince.set(source?.province, source);
  }
  for (const province of ITALY_DUTY_PROVINCES) {
    if (!sourceByProvince.has(province)) errors.push(`source: missing province ${province}`);
  }

  if (duties?._timezone !== ITALY_DUTY_TIMEZONE || status?._timezone !== ITALY_DUTY_TIMEZONE) {
    errors.push(`snapshot timezone must be ${ITALY_DUTY_TIMEZONE}`);
  }
  if (duties?._scope?.country !== 'IT' || status?._scope?.country !== 'IT') errors.push('snapshot country must be IT');
  if (!checkFreshness(duties?._fetchedAt, now) || !checkFreshness(status?._fetchedAt, now)) {
    errors.push('snapshot fetchedAt is stale, missing, or in the future');
  }

  const provinceStatuses = status?._provinces && typeof status._provinces === 'object' ? status._provinces : {};
  for (const province of ITALY_DUTY_PROVINCES) {
    const entry = provinceStatuses[province];
    if (!entry) {
      errors.push(`status: missing province ${province}`);
      continue;
    }
    if (entry.province !== province) errors.push(`status.${province}: province mismatch`);
    if (entry.state !== 'fresh' || entry.freshness !== 'fresh' || entry.coverage !== 'covered') {
      errors.push(`status.${province}: source is not fresh and covered`);
    }
    if (!checkFreshness(entry.fetchedAt, now)) errors.push(`status.${province}: fetchedAt is stale`);
    if (!Number.isInteger(entry.dutyCount) || entry.dutyCount < 1) errors.push(`status.${province}: no duty rows`);
    if (Array.isArray(entry.errors) && entry.errors.length > 0) errors.push(`status.${province}: source errors present`);
  }
  if (Array.isArray(status?._errors) && status._errors.length > 0) errors.push('status: errors present');
  if (Array.isArray(duties?._errors) && duties._errors.length > 0) errors.push('duties: errors present');

  const seen = new Set();
  for (const [index, duty] of (Array.isArray(duties?.duties) ? duties.duties : []).entries()) {
    if (!ITALY_DUTY_PROVINCES.includes(duty?.province)) errors.push(`duties[${index}]: missing or ambiguous province`);
    if (!duty?.pharmacyId || duty?.sourceType !== 'official' || !/^https:\/\//i.test(duty?.sourceUrl || '')) {
      errors.push(`duties[${index}]: missing official identity/source`);
    }
    if (!isIso(duty?.startsAt) || !isIso(duty?.endsAt) || Date.parse(duty.endsAt) <= Date.parse(duty.startsAt)) {
      errors.push(`duties[${index}]: invalid interval`);
    }
    if (!isIso(duty?.fetchedAt)) errors.push(`duties[${index}]: invalid fetchedAt`);
    const key = `${duty?.province}|${duty?.pharmacyId}|${duty?.startsAt}|${duty?.endsAt}`;
    if (seen.has(key)) errors.push(`duties[${index}]: duplicate interval`);
    seen.add(key);
  }
  if (!Array.isArray(duties?.duties) || duties.duties.length === 0) errors.push('duties: empty dataset');

  errors.push(...verifyItalyReleaseSnapshots({ duties, status }));
  if (duties?._release?.state !== 'fresh') errors.push(`release: state is ${String(duties?._release?.state)}`);
  return errors;
}

async function main() {
  const duties = await readJson(argumentValue('--duties=', DEFAULT_DUTIES_PATH));
  const status = await readJson(argumentValue('--status=', DEFAULT_STATUS_PATH));
  const sources = await readJson(argumentValue('--sources=', DEFAULT_SOURCES_PATH));
  const nowValue = argumentValue('--now=', null);
  const now = nowValue ? new Date(nowValue) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`invalid --now value ${nowValue}`);
  const errors = checkItalyDutyData({ duties, status, sources, now });
  if (errors.length > 0) {
    for (const error of errors) console.error(`[check-pharmacy-duties-italy] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-pharmacy-duties-italy] OK release=${duties._release.releaseId} duties=${duties.duties.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
