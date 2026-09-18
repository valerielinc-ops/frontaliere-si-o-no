#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ITALY_DUTY_MAX_AGE_HOURS,
  ITALY_DUTY_MINIMUM_CALENDAR_DAYS,
  ITALY_DUTY_PROVINCES,
  ITALY_DUTY_TIMEZONE,
  sourceCoverageModel,
  sourcePublicationClass,
  verifyItalyReleaseSnapshots,
} from './lib/pharmacy-italy-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..');
const DEFAULT_DUTIES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy.json');
const DEFAULT_STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-status.json');
const DEFAULT_SOURCES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-sources.json');
const DEFAULT_CATALOGUE_PATH = resolve(REPO_ROOT, 'data/pharmacies-italy-border.json');

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

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function checkFreshness(timestamp, now, maxAgeHours = ITALY_DUTY_MAX_AGE_HOURS) {
  if (!isIso(timestamp)) return false;
  const ageHours = (now.getTime() - Date.parse(timestamp)) / 3_600_000;
  return ageHours >= -1 && ageHours <= maxAgeHours;
}

function sameHttpsHost(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === 'https:' && rightUrl.protocol === 'https:'
      && leftUrl.hostname === rightUrl.hostname;
  } catch {
    return false;
  }
}

export function checkItalyDutyData({ duties, status, sources, catalogue, now = new Date() }) {
  const errors = [];
  const sourceList = Array.isArray(sources?.sources) ? sources.sources : [];
  const sourceByProvince = new Map();
  const expectedProvinces = [...ITALY_DUTY_PROVINCES];
  const sourceTimezone = sources?._timezone ?? sources?.timezone;
  const sourceScope = sources?._scope ?? sources?.scope;
  if (sourceTimezone !== ITALY_DUTY_TIMEZONE) errors.push(`source registry timezone must be ${ITALY_DUTY_TIMEZONE}`);
  if (sourceScope?.country !== 'IT'
    || JSON.stringify(sourceScope?.provinces) !== JSON.stringify(expectedProvinces)) {
    errors.push('source registry scope must be IT/CO,VA,VB');
  }
  if (sourceList.length !== expectedProvinces.length) errors.push('source registry must contain exactly one source per province');
  for (const source of sourceList) {
    if (!ITALY_DUTY_PROVINCES.includes(source?.province)) errors.push(`source ${source?.key || '<unknown>'}: unsupported province`);
    if (source?.sourceType !== 'official' || !/^https:\/\//i.test(source?.officialSourceUrl || '')) {
      errors.push(`source ${source?.key || '<unknown>'}: source must be official HTTPS`);
    }
    if (!/^https:\/\//i.test(source?.rawUrl || '')) {
      errors.push(`source ${source?.key || '<unknown>'}: rawUrl must be official HTTPS`);
    }
    if (!sameHttpsHost(source?.officialSourceUrl, source?.rawUrl)) {
      errors.push(`source ${source?.key || '<unknown>'}: rawUrl host must match the official source host`);
    }
    // Il minimo in giorni-calendario vale solo per una fonte `full-calendar`.
    // Una fonte `corrections-only` pubblica i soli cambi turno, quindi non puo'
    // dichiarare 300 giorni senza mentire: pretenderlo la marcava invalida.
    if (sourceCoverageModel(source) === 'full-calendar'
      && (!Number.isInteger(source?.minimumCalendarDays) || source.minimumCalendarDays < ITALY_DUTY_MINIMUM_CALENDAR_DAYS)) {
      errors.push(`source ${source?.key || '<unknown>'}: minimumCalendarDays must be at least 300`);
    }
    if (sourceCoverageModel(source) === 'corrections-only' && source?.minimumCalendarDays !== undefined) {
      errors.push(`source ${source?.key || '<unknown>'}: corrections-only source must not declare minimumCalendarDays`);
    }
    if (!isCalendarDate(source?.validFrom) || !isCalendarDate(source?.validTo)
      || source.validFrom > source.validTo) {
      errors.push(`source ${source?.key || '<unknown>'}: validity window is missing or inverted`);
    }
    if (/farmacia[-_ ]aperta/i.test(JSON.stringify({ officialSourceUrl: source?.officialSourceUrl, rawUrl: source?.rawUrl }))) {
      errors.push(`source ${source?.key || '<unknown>'}: Farmacia Aperta cannot be a duty source`);
    }
    if (sourceByProvince.has(source?.province)) errors.push(`source: duplicate province ${source?.province}`);
    sourceByProvince.set(source?.province, source);
  }
  for (const province of ITALY_DUTY_PROVINCES) {
    if (!sourceByProvince.has(province)) errors.push(`source: missing province ${province}`);
  }
  if (sources?.thirdPartyLinkOut?.policy !== 'link-out-only'
    || !/^https:\/\//i.test(sources?.thirdPartyLinkOut?.url || '')) {
    errors.push('thirdPartyLinkOut must be an HTTPS link-out-only entry');
  }

  if (duties?._timezone !== ITALY_DUTY_TIMEZONE || status?._timezone !== ITALY_DUTY_TIMEZONE) {
    errors.push(`snapshot timezone must be ${ITALY_DUTY_TIMEZONE}`);
  }
  if (duties?._scope?.country !== 'IT' || status?._scope?.country !== 'IT') errors.push('snapshot country must be IT');
  if (!checkFreshness(duties?._fetchedAt, now) || !checkFreshness(status?._fetchedAt, now)) {
    errors.push('snapshot fetchedAt is stale, missing, or in the future');
  }

  const dutyRows = Array.isArray(duties?.duties) ? duties.duties : [];
  const dutyCountsByProvince = new Map(ITALY_DUTY_PROVINCES.map((province) => [province, 0]));
  for (const duty of dutyRows) {
    if (dutyCountsByProvince.has(duty?.province)) {
      dutyCountsByProvince.set(duty.province, dutyCountsByProvince.get(duty.province) + 1);
    }
  }
  const provinceStatuses = status?._provinces && typeof status._provinces === 'object' ? status._provinces : {};
  for (const province of ITALY_DUTY_PROVINCES) {
    const entry = provinceStatuses[province];
    if (!entry) {
      errors.push(`status: missing province ${province}`);
      continue;
    }
    if (entry.province !== province) errors.push(`status.${province}: province mismatch`);
    // Una provincia `best-effort` puo' legittimamente non pubblicare: la sua
    // fonte e' dichiarata irraggiungibile dai runner e il suo errore vive in
    // `_bestEffortErrors`. Restano verificati gli invarianti di INTEGRITA'
    // (forma dei campi e coerenza del conteggio con le righe pubblicate): la
    // provincia e' degradata, non esente dai controlli strutturali.
    const bestEffort = sourcePublicationClass(entry) === 'best-effort';
    if (!bestEffort && (entry.state !== 'fresh' || entry.freshness !== 'fresh' || entry.coverage !== 'covered')) {
      errors.push(`status.${province}: source is not fresh and covered`);
    }
    if (!Array.isArray(entry.errors)) errors.push(`status.${province}: errors must be an array`);
    if (!Array.isArray(entry.warnings)) errors.push(`status.${province}: warnings must be an array`);
    if (!bestEffort && !checkFreshness(entry.fetchedAt, now)) errors.push(`status.${province}: fetchedAt is stale`);
    const effectiveDutyCount = dutyCountsByProvince.get(province) || 0;
    if (!bestEffort && (!Number.isInteger(entry.dutyCount) || entry.dutyCount < 1)) errors.push(`status.${province}: no duty rows`);
    if (entry.dutyCount !== effectiveDutyCount) {
      errors.push(`status.${province}: dutyCount ${entry.dutyCount} does not match duties rows ${effectiveDutyCount}`);
    }
    if (!bestEffort && Array.isArray(entry.errors) && entry.errors.length > 0) errors.push(`status.${province}: source errors present`);
  }
  if (Array.isArray(status?._errors) && status._errors.length > 0) errors.push('status: errors present');
  if (Array.isArray(duties?._errors) && duties._errors.length > 0) errors.push('duties: errors present');

  const catalogueRows = Array.isArray(catalogue?.pharmacies) ? catalogue.pharmacies : null;
  if (!catalogueRows) errors.push('catalogue: missing Italian Ministry snapshot');
  const catalogueById = new Map();
  for (const pharmacy of catalogueRows || []) {
    const records = catalogueById.get(pharmacy?.id) || [];
    records.push(pharmacy);
    catalogueById.set(pharmacy?.id, records);
  }
  if (catalogueRows) {
    for (const source of sourceList) {
      for (const alias of Array.isArray(source?.identityAliases) ? source.identityAliases : []) {
        const identities = catalogueById.get(alias?.pharmacyId) || [];
        if (identities.length !== 1 || identities[0]?.country !== 'IT') {
          errors.push('source ' + (source?.key || '<unknown>') + ': alias '
            + (alias?.pharmacyId || '<unknown>') + ' is missing or ambiguous in the Ministry catalogue');
        } else if (identities[0].province !== source.province) {
          errors.push('source ' + (source?.key || '<unknown>') + ': alias '
            + (alias?.pharmacyId || '<unknown>') + ' province does not match ' + source.province);
        }
      }
    }
  }

  const seen = new Set();
  for (const [index, duty] of dutyRows.entries()) {
    if (!ITALY_DUTY_PROVINCES.includes(duty?.province)) errors.push(`duties[${index}]: missing or ambiguous province`);
    if (!duty?.pharmacyId || duty?.sourceType !== 'official' || !/^https:\/\//i.test(duty?.sourceUrl || '')) {
      errors.push(`duties[${index}]: missing official identity/source`);
    }
    const source = sourceByProvince.get(duty?.province);
    if (source && duty.sourceUrl !== source.officialSourceUrl) errors.push(`duties[${index}]: sourceUrl does not match the province source`);
    if (source && duty.coverageName !== source.name) errors.push(`duties[${index}]: coverageName does not match the province source`);
    const identities = catalogueById.get(duty?.pharmacyId) || [];
    if (identities.length !== 1 || identities[0]?.country !== 'IT') {
      errors.push(`duties[${index}]: pharmacyId is missing or ambiguous in the Ministry catalogue`);
    } else if (identities[0].province !== duty.province) {
      errors.push(`duties[${index}]: pharmacyId province does not match duty province`);
    }
    if (duty.status !== 'verified' || !isIso(duty.verifiedAt)) errors.push(`duties[${index}]: duty is not verified`);
    if (sources?.thirdPartyLinkOut?.url && duty.sourceUrl === sources.thirdPartyLinkOut.url) {
      errors.push(`duties[${index}]: third-party link-out was used as a duty source`);
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
  const catalogue = await readJson(argumentValue('--catalogue=', DEFAULT_CATALOGUE_PATH));
  const nowValue = argumentValue('--now=', null);
  const now = nowValue ? new Date(nowValue) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`invalid --now value ${nowValue}`);
  const errors = checkItalyDutyData({ duties, status, sources, catalogue, now });
  if (errors.length > 0) {
    for (const error of errors) console.error(`[check-pharmacy-duties-italy] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-pharmacy-duties-italy] OK release=${duties._release.releaseId} duties=${duties.duties.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
