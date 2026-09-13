#!/usr/bin/env node
/**
 * Fail-closed integrity check for the cross-border pharmacy snapshots.
 *
 * The importer is deliberately allowed to leave optional contact, hours and
 * service fields empty. It is not allowed to publish an incomplete official
 * identity, move a record outside the configured corridor, lose a duty
 * reference, or claim OSM-derived values without ODbL provenance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TICINO_PATH = path.join(ROOT, 'data', 'pharmacies-ticino-complete.json');
const ITALY_PATH = path.join(ROOT, 'data', 'pharmacies-italy-border.json');
const DUTIES_PATH = path.join(ROOT, 'data', 'pharmacy-duties-ticino.json');
const SOURCES_PATH = path.join(ROOT, 'data', 'pharmacy-border-sources.json');
const PROVINCES = new Set(['CO', 'VA', 'VB']);
const COUNTRIES = new Set(['CH', 'IT']);
const OPTIONAL_FIELDS = new Set(['phone', 'website', 'coordinates', 'openingHours', 'services']);
const FIELD_STATUSES = new Set(['verified', 'not_published', 'not_checked']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateBorderSources(registry) {
  const errors = [];
  const sources = registry?.sources;
  if (!sources || typeof sources !== 'object') return ['Border source registry is missing sources'];
  for (const key of ['ticino-complete', 'italy-border', 'osm-enrichment']) {
    const source = sources[key];
    if (!source) {
      errors.push(`Border source registry is missing ${key}`);
      continue;
    }
    if (source.status !== 'active') errors.push(`${key}: source is not active`);
    try {
      if (new URL(source.officialSourceUrl).protocol !== 'https:') errors.push(`${key}: source URL is not HTTPS`);
    } catch {
      errors.push(`${key}: source URL is invalid`);
    }
    if (!source.fetchFrequency) errors.push(`${key}: fetch frequency is missing`);
  }
  if (!/ODbL/i.test(sources['osm-enrichment']?.license || '')) {
    errors.push('osm-enrichment: ODbL licence is missing');
  }
  return errors;
}

export function validateBorderSnapshot({ ticino, italy, duties }) {
  const errors = [];
  const all = [...(ticino?.pharmacies || []), ...(italy?.pharmacies || [])];
  const ids = new Set();
  const slugs = new Set();
  const fail = (message) => errors.push(message);

  if (ticino?._pharmacyCount !== (ticino?.pharmacies || []).length) {
    fail(`Ticino snapshot _pharmacyCount ${(ticino?._pharmacyCount ?? '<missing>')} does not match ${(ticino?.pharmacies || []).length} records`);
  }
  if (italy?._pharmacyCount !== (italy?.pharmacies || []).length) {
    fail(`Italian snapshot _pharmacyCount ${(italy?._pharmacyCount ?? '<missing>')} does not match ${(italy?.pharmacies || []).length} records`);
  }
  if ((ticino?.pharmacies || []).length < 200) fail(`Ticino snapshot has only ${(ticino?.pharmacies || []).length} records (minimum 200)`);
  if ((italy?.pharmacies || []).length < 400) fail(`Italian snapshot has only ${(italy?.pharmacies || []).length} records (minimum 400)`);
  for (const province of PROVINCES) {
    const count = (italy?.pharmacies || []).filter((pharmacy) => pharmacy.province === province).length;
    if (!count) fail(`Italian snapshot has no records for ${province}`);
  }

  for (const pharmacy of all) {
    const label = pharmacy?.id || pharmacy?.name || '<unknown>';
    for (const field of ['id', 'name', 'slug', 'address', 'postalCode', 'city', 'country', 'sourceUrl', 'lastVerifiedAt']) {
      if (typeof pharmacy?.[field] !== 'string' || pharmacy[field].trim() === '') fail(`${label}: missing ${field}`);
    }
    if (ids.has(pharmacy.id)) fail(`${label}: duplicate id`);
    if (slugs.has(pharmacy.slug)) fail(`${label}: duplicate slug`);
    ids.add(pharmacy.id);
    slugs.add(pharmacy.slug);
    if (!COUNTRIES.has(pharmacy.country)) fail(`${label}: unsupported country ${pharmacy.country}`);
    if (pharmacy.country === 'CH' && pharmacy.canton !== 'Ticino') fail(`${label}: non-Ticino Swiss record`);
    if (pharmacy.country === 'IT' && !PROVINCES.has(pharmacy.province)) fail(`${label}: Italian record outside CO/VA/VB`);
    if (!Number.isFinite(Date.parse(pharmacy.lastVerifiedAt))) fail(`${label}: invalid lastVerifiedAt`);
    if (pharmacy.website) {
      try {
        if (new URL(pharmacy.website).protocol !== 'https:') fail(`${label}: website is not HTTPS`);
      } catch {
        fail(`${label}: website is invalid`);
      }
    }

    for (const [field, source] of Object.entries(pharmacy.fieldSources || {})) {
      if (!source || typeof source.url !== 'string' || !source.url.trim()) fail(`${label}: ${field} source has no URL`);
      if (source?.url) {
        try {
          if (new URL(source.url).protocol !== 'https:') fail(`${label}: ${field} source URL is not HTTPS`);
        } catch {
          fail(`${label}: ${field} source URL is invalid`);
        }
      }
      if (!Number.isFinite(Date.parse(source.checkedAt))) fail(`${label}: ${field} source has invalid checkedAt`);
      if (source.license?.includes('ODbL') && source.sourceType !== 'directory') fail(`${label}: ODbL source for ${field} is not marked directory`);
      if (OPTIONAL_FIELDS.has(field) && source.sourceType === 'directory' && !/ODbL/i.test(source.license || '')) fail(`${label}: directory source for ${field} has no ODbL licence`);
    }
    for (const [field, status] of Object.entries(pharmacy.dataAvailability || {})) {
      if (!FIELD_STATUSES.has(status)) fail(`${label}: invalid availability status for ${field}`);
    }
    if (JSON.stringify(pharmacy).match(/farmacia-aperta|federfarma/i)) fail(`${label}: prohibited Farmacia Aperta/Federfarma source text`);
  }

  const swissIds = new Set((ticino?.pharmacies || []).map((pharmacy) => pharmacy.id));
  for (const duty of duties?.duties || []) {
    if (!swissIds.has(duty.pharmacyId)) fail(`duty ${duty.id || '<unknown>'}: unresolved pharmacyId ${duty.pharmacyId}`);
  }
  return errors;
}

export function main() {
  try {
    const errors = [
      ...validateBorderSources(readJson(SOURCES_PATH)),
      ...validateBorderSnapshot({
        ticino: readJson(TICINO_PATH),
        italy: readJson(ITALY_PATH),
        duties: readJson(DUTIES_PATH),
      }),
    ];
    assert(errors.length === 0, errors.join('\n'));
    const ticino = readJson(TICINO_PATH);
    const italy = readJson(ITALY_PATH);
    console.log(`[pharmacy-border-health] OK — Ticino ${ticino.pharmacies.length}; Italy CO/VA/VB ${italy.pharmacies.length}`);
    return 0;
  } catch (error) {
    console.error(`[pharmacy-border-health] FAIL\n${error?.message || error}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
