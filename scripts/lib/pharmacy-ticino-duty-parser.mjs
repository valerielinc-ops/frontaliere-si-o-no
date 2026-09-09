#!/usr/bin/env node
/**
 * Parser for the duty table published by the four OFCT Ticino regions.
 *
 * The source exposes local Zurich dates and a pharmacy name/locality, but no
 * machine-readable end time.  OFCT publishes the schedule as an ordered list:
 * a duty starts at the row's local date/time and ends when the next row starts.
 * The last row is intentionally not emitted until a following boundary exists.
 * This avoids inventing an expiry when the source page is truncated.
 */
import { localDateTimeToIso } from '../../services/pharmacies/time.mjs';
import { slugify } from './crawler-template.mjs';
import { OFCT_REGIONS } from './pharmacy-ticino-parser.mjs';

const DUTY_TABLE_ID = 'tabella_mese_corrente_compatta';

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

function cell(rowHtml, className) {
  const match = rowHtml.match(new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'));
  return match ? textify(match[1]) : '';
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
  let rowMatch;
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
    const rowHtml = rowMatch[0];
    const dateText = cell(rowHtml, 'cella_farma_compatta_data');
    const timeText = cell(rowHtml, 'cella_farma_compatta_orario');
    const name = cell(rowHtml, 'cella_farma_compatta_nome');
    const localityText = cell(rowHtml, 'cella_farma_compatta_localita');
    if (!dateText && !timeText && !name && !localityText) continue;
    if (!dateText || !timeText || !name || !localityText) {
      skipped += 1;
      continue;
    }
    const locality = parseLocality(localityText);
    try {
      rows.push({
        dateText,
        timeText,
        startsAt: localDateTimeToIso(dateText, timeText),
        name,
        postalCode: locality.postalCode,
        city: locality.city,
      });
    } catch {
      skipped += 1;
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
  for (let index = 0; index < parsed.rows.length - 1; index += 1) {
    const row = parsed.rows[index];
    const next = parsed.rows[index + 1];
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
