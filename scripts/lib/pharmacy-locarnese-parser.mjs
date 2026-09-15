#!/usr/bin/env node
/**
 * Parser for the Locarnese duty schedule published by
 * `farmacielocarnese.ch`.
 *
 * The source has no stable table id and publishes only a duty calendar:
 * Data / Ora / Farmacia / Località. It does not publish a complete
 * anagraphic for the pharmacies in that calendar. A duty is therefore
 * emitted only when the source name and locality resolve to exactly one
 * existing Ticino catalogue record supplied by the caller.
 *
 * The source exposes starts, not ends. As with the OFCT parser, the next
 * chronological source row is the only safe end boundary; the last row is
 * retained as boundary-only and is never emitted as an interval.
 */
import { localDateTimeToIso } from '../../services/pharmacies/time.mjs';
export { LOCARNESE_REGION } from './pharmacy-duty-regions.mjs';
import { LOCARNESE_REGION } from './pharmacy-duty-regions.mjs';

const DUTY_HEADERS = ['data', 'ora', 'farmacia', 'localita'];
const MISSING_BOUNDARY = Symbol('missingBoundary');
const GENERIC_NAME_TOKENS = new Set(['farmacia', 'farmacie', 'sa', 'sagl', 'snc']);

function decodeEntities(value = '') {
  return String(value || '').replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  });
}

function textify(html = '') {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cells(rowHtml, tagName) {
  const tag = String(tagName || 'td');
  const cellRe = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  return [...String(rowHtml || '').matchAll(cellRe)].map((match) => textify(match[1]));
}

function rows(tableHtml) {
  return [...String(tableHtml || '').matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)]
    .map((match) => match[0]);
}

function normalizedHeader(value) {
  return textify(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isDutyTable(tableHtml) {
  const headerRow = rows(tableHtml).find((rowHtml) => /<th\b/i.test(rowHtml));
  if (!headerRow) return false;
  return cells(headerRow, 'th').map(normalizedHeader).join('|') === DUTY_HEADERS.join('|');
}

function findDutyTable(html) {
  return [...String(html || '').matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)]
    .map((match) => match[0])
    .find(isDutyTable);
}

function markMissingBoundary(row) {
  Object.defineProperty(row, MISSING_BOUNDARY, { value: true });
  return row;
}

/**
 * Extracts raw Locarnese calendar rows.
 *
 * `rows` contain the source date/time and the normalized start instant, but
 * deliberately no address, phone, postal code, or generated pharmacy id.
 * A malformed row blocks the interval immediately before the next valid row,
 * so a source gap cannot silently become an inferred duty boundary.
 */
export function parseLocarneseDutyRows(html) {
  const table = findDutyTable(html);
  if (!table) {
    return {
      rows: [],
      skipped: 0,
      warnings: ['missing Locarnese duty table with Data/Ora/Farmacia/Località headers'],
    };
  }

  const parsedRows = [];
  let skipped = 0;
  let missingBoundary = false;
  for (const rowHtml of rows(table)) {
    const dataCells = cells(rowHtml, 'td');
    if (dataCells.length === 0) continue;
    if (dataCells.length !== 4 || dataCells.some((value) => !value)) {
      skipped += 1;
      missingBoundary = true;
      continue;
    }

    const [dateText, timeText, name, city] = dataCells;
    let startsAt;
    try {
      startsAt = localDateTimeToIso(dateText, timeText);
    } catch {
      skipped += 1;
      missingBoundary = true;
      continue;
    }

    const parsedRow = { dateText, timeText, startsAt, name, city };
    if (missingBoundary) markMissingBoundary(parsedRow);
    parsedRows.push(parsedRow);
    missingBoundary = false;
  }

  const warnings = [];
  if (skipped > 0) warnings.push(`skipped ${skipped} malformed Locarnese duty row(s)`);
  if (parsedRows.length === 0) warnings.push('Locarnese duty table contained no valid rows');
  return { rows: parsedRows, skipped, warnings };
}

function normalizedTokens(value, { dropGeneric = false } = {}) {
  const tokens = textify(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return dropGeneric ? tokens.filter((token) => !GENERIC_NAME_TOKENS.has(token)) : tokens;
}

function containsTokenBag(container, required) {
  const remaining = [...container];
  for (const token of required) {
    const index = remaining.indexOf(token);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function sameCatalogueCity(sourceCity, catalogueCity) {
  const sourceTokens = normalizedTokens(sourceCity);
  const catalogueTokens = normalizedTokens(catalogueCity);
  return sourceTokens.length > 0
    && catalogueTokens.length > 0
    && containsTokenBag(sourceTokens, catalogueTokens);
}

function sameCatalogueName(sourceName, catalogueName, catalogueCity) {
  const sourceTokens = normalizedTokens(sourceName, { dropGeneric: true });
  const catalogueTokens = normalizedTokens(catalogueName, { dropGeneric: true });
  const cityTokens = normalizedTokens(catalogueCity);
  if (sourceTokens.length === 0 || catalogueTokens.length === 0) return false;

  const remaining = [...catalogueTokens];
  for (const token of sourceTokens) {
    const index = remaining.indexOf(token);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.every((token) => cityTokens.includes(token));
}

function catalogueCandidates(row, catalogue) {
  if (!Array.isArray(catalogue)) return [];
  return catalogue.filter((pharmacy) => {
    if (!pharmacy || typeof pharmacy !== 'object') return false;
    if (typeof pharmacy.id !== 'string' || !pharmacy.id.trim()) return false;
    if (typeof pharmacy.name !== 'string' || typeof pharmacy.city !== 'string') return false;
    if (pharmacy.country !== 'CH') return false;
    if (typeof pharmacy.canton !== 'string' || normalizedTokens(pharmacy.canton).join(' ') !== 'ticino') return false;
    return sameCatalogueCity(row.city, pharmacy.city)
      && sameCatalogueName(row.name, pharmacy.name, pharmacy.city);
  });
}

/**
 * Resolves a source row to one existing Ticino catalogue record.
 * Returns `null` for both no-match and ambiguous-match cases: callers must
 * keep the source row unresolved instead of selecting a plausible record.
 */
export function resolveLocarnesePharmacyIdentity(row, catalogue) {
  const candidates = catalogueCandidates(row, catalogue);
  return candidates.length === 1 ? candidates[0] : null;
}

function unresolvedIdentity(row, region, candidates) {
  return {
    name: row.name,
    city: row.city,
    startsAt: row.startsAt,
    sourceUrl: region.url,
    reason: candidates.length > 0
      ? 'ambiguous Ticino catalogue identity'
      : 'no matching Ticino catalogue identity',
    candidateIds: candidates.map((candidate) => candidate.id),
  };
}

function dutyId(region, startsAt, pharmacyId) {
  return `ti-duty-${region.key}-${startsAt}-${pharmacyId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Builds verified/expired `PharmacyDuty`-shaped intervals for Locarnese.
 * Unresolved rows are returned in `unresolved` and never become duties.
 * `catalogue` must be the current Ticino pharmacy catalogue; no anagraphic
 * values are copied from this source because the source does not publish
 * them in a stable, complete form.
 */
export function buildLocarnesePharmacyDuties(
  html,
  region = LOCARNESE_REGION,
  fetchedAt,
  catalogue = [],
) {
  const parsed = parseLocarneseDutyRows(html);
  const warnings = [...parsed.warnings];
  const duties = [];
  const unresolved = [];
  const fetchedAtMs = Date.parse(fetchedAt);

  if (!Number.isFinite(fetchedAtMs)) {
    warnings.push('invalid fetchedAt; no Locarnese duty intervals emitted');
    return { duties, unresolved, skipped: parsed.skipped, warnings };
  }

  const rowsWithMatches = parsed.rows.map((row) => {
    const candidates = catalogueCandidates(row, catalogue);
    const pharmacy = candidates.length === 1 ? candidates[0] : null;
    if (!pharmacy) unresolved.push(unresolvedIdentity(row, region, candidates));
    return { row, pharmacy, candidates };
  });

  // Boundary markers are attached in source order. An out-of-order source
  // would make a later sort pair rows across an unknown gap, so reject the
  // complete sequence instead of manufacturing a plausible interval.
  const nonChronological = rowsWithMatches.some((entry, index) => index > 0
    && Date.parse(entry.row.startsAt) <= Date.parse(rowsWithMatches[index - 1].row.startsAt));
  if (nonChronological) {
    warnings.push(`${region.key}: source rows are not chronological; no duty intervals emitted`);
    return { duties, unresolved, skipped: parsed.skipped, warnings };
  }

  for (let index = 0; index < rowsWithMatches.length - 1; index += 1) {
    const current = rowsWithMatches[index];
    const next = rowsWithMatches[index + 1];
    if (next.row[MISSING_BOUNDARY]) {
      warnings.push(`${region.key}: missing duty boundary before row ${index + 1}`);
      continue;
    }

    const startsAtMs = Date.parse(current.row.startsAt);
    const endsAtMs = Date.parse(next.row.startsAt);
    if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) {
      warnings.push(`${region.key}: non-increasing duty boundary at row ${index + 1}`);
      continue;
    }
    if (!current.pharmacy) continue;

    const endsAt = next.row.startsAt;
    const expired = endsAtMs <= fetchedAtMs;
    duties.push({
      id: dutyId(region, current.row.startsAt, current.pharmacy.id),
      pharmacyId: current.pharmacy.id,
      coverageType: 'region',
      coverageName: region.name,
      startsAt: current.row.startsAt,
      endsAt,
      dutyType: 'day',
      status: expired ? 'expired' : 'verified',
      sourceUrl: region.url,
      sourceType: 'association',
      fetchedAt,
      verifiedAt: expired ? undefined : fetchedAt,
    });
  }

  if (parsed.rows.length > 0) {
    warnings.push(`${region.key}: last source row retained as boundary-only and not published`);
  }
  if (duties.length === 0) warnings.push(`${region.key}: no complete resolved duty intervals found`);
  return { duties, unresolved, skipped: parsed.skipped, warnings };
}
