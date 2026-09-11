#!/usr/bin/env node
/**
 * Parser for the duty table published by the four OFCT Ticino regions.
 *
 * The source exposes local Zurich dates and a pharmacy name/locality, but no
 * machine-readable end time. OFCT publishes the schedule as a list: a duty
 * starts at the row's local date/time and ends when the next chronological row
 * starts. The last row is intentionally not emitted until a following boundary
 * exists. This avoids inventing an expiry when the source page is truncated.
 */
import { localDateTimeToIso } from '../../services/pharmacies/time.mjs';
import { slugify } from './crawler-template.mjs';
import { OFCT_REGIONS } from './pharmacy-ticino-parser.mjs';

const DUTY_TABLE_ID = 'tabella_mese_corrente_compatta';
const SOURCE_INDEX = Symbol('sourceIndex');
const MISSING_BOUNDARY = Symbol('missingBoundary');

function decodeEntities(str = '') {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function textify(html = '') {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classAttribute(openingTag) {
  const match = String(openingTag).match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function cell(rowHtml, className) {
  const openingRe = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let opening;
  while ((opening = openingRe.exec(rowHtml)) !== null) {
    const classes = classAttribute(opening[0]).split(/\s+/).filter(Boolean);
    if (!classes.some((value) => value.toLowerCase() === String(className).toLowerCase())) continue;

    const tagName = escapeRegExp(opening[1]);
    const closeRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    closeRe.lastIndex = openingRe.lastIndex;
    let depth = 1;
    let tag;
    while ((tag = closeRe.exec(rowHtml)) !== null) {
      if (/^<\//.test(tag[0])) {
        depth -= 1;
        if (depth === 0) return textify(rowHtml.slice(openingRe.lastIndex, tag.index));
      } else if (!/\/\s*>$/.test(tag[0])) {
        depth += 1;
      }
    }
    return '';
  }
  return '';
}

function parseLocality(value) {
  const match = String(value || '').match(/^(\d{4})\s+(.+)$/);
  return match ? { postalCode: match[1], city: match[2].trim() } : { postalCode: '', city: String(value || '').trim() };
}

export function parsePharmacyDutyRows(html) {
  const tableMatch = String(html || '').match(
    new RegExp(`id=["']${DUTY_TABLE_ID}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i'),
  );
  if (!tableMatch) return { rows: [], skipped: 0, warnings: [`missing #${DUTY_TABLE_ID}`] };

  const rows = [];
  let skipped = 0;
  let missingBoundary = false;
  let sourceIndex = 0;
  let rowMatch;
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
    const rowHtml = rowMatch[0];
    const dateText = cell(rowHtml, 'cella_farma_compatta_data');
    const timeText = cell(rowHtml, 'cella_farma_compatta_orario');
    const name = cell(rowHtml, 'cella_farma_compatta_nome');
    const localityText = cell(rowHtml, 'cella_farma_compatta_localita');
    if (!dateText && !timeText && !name && !localityText) continue;
    const currentSourceIndex = sourceIndex;
    sourceIndex += 1;
    if (!dateText || !timeText || !name || !localityText) {
      skipped += 1;
      missingBoundary = true;
      continue;
    }
    const locality = parseLocality(localityText);
    try {
      const parsedRow = {
        dateText,
        timeText,
        startsAt: localDateTimeToIso(dateText, timeText),
        name,
        postalCode: locality.postalCode,
        city: locality.city,
      };
      Object.defineProperty(parsedRow, SOURCE_INDEX, { value: currentSourceIndex });
      if (missingBoundary) Object.defineProperty(parsedRow, MISSING_BOUNDARY, { value: true });
      rows.push(parsedRow);
      missingBoundary = false;
    } catch {
      skipped += 1;
      missingBoundary = true;
    }
  }
  const warnings = [];
  if (skipped > 0) warnings.push(`skipped ${skipped} malformed duty row(s)`);
  return { rows, skipped, warnings };
}

function makePharmacyId(name, city) {
  return `ti-${slugify(`${name} ${city}`)}`;
}

export function markDutyConflicts(duties) {
  const sorted = [...duties].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const conflicts = new Set();
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.coverageName === current.coverageName && Date.parse(current.startsAt) < Date.parse(previous.endsAt)) {
      conflicts.add(previous.id);
      conflicts.add(current.id);
    }
  }
  return duties.map((duty) => conflicts.has(duty.id) ? { ...duty, status: 'conflicting' } : duty);
}

export function buildPharmacyDuties(html, region, fetchedAt, pharmacyIds = new Set()) {
  const parsed = parsePharmacyDutyRows(html);
  const warnings = [...parsed.warnings];
  const duties = [];
  const rows = [...parsed.rows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (let index = 0; index < rows.length - 1; index += 1) {
    const row = rows[index];
    const next = rows[index + 1];
    if (next[MISSING_BOUNDARY] || Math.abs(next[SOURCE_INDEX] - row[SOURCE_INDEX]) > 1) {
      warnings.push(`${region.key}: missing duty boundary before row ${index + 1}`);
      continue;
    }
    if (Date.parse(next.startsAt) <= Date.parse(row.startsAt)) {
      warnings.push(`${region.key}: non-increasing duty boundary at row ${index + 1}`);
      continue;
    }
    const pharmacyId = makePharmacyId(row.name, row.city);
    const endsAt = next.startsAt;
    const isExpired = Date.parse(endsAt) <= Date.parse(fetchedAt);
    duties.push({
      id: `ti-duty-${region.key}-${row.startsAt}-${pharmacyId}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
      pharmacyId,
      coverageType: 'region',
      coverageName: region.name,
      startsAt: row.startsAt,
      endsAt,
      dutyType: 'day',
      status: isExpired ? 'expired' : (pharmacyIds.has(pharmacyId) ? 'verified' : 'pending_review'),
      sourceUrl: region.url,
      sourceType: 'official',
      fetchedAt,
      verifiedAt: !isExpired && pharmacyIds.has(pharmacyId) ? fetchedAt : undefined,
    });
  }
  if (parsed.rows.length > 0) warnings.push(`${region.key}: last source row retained as boundary-only and not published`);
  if (duties.length === 0) warnings.push(`${region.key}: no complete duty intervals found`);
  return { duties: markDutyConflicts(duties), skipped: parsed.skipped, warnings };
}

export function regionForDutyUrl(url) {
  return OFCT_REGIONS.find((region) => region.url === url) || null;
}
