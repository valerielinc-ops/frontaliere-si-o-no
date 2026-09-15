import { createHash } from 'node:crypto';

/**
 * Parser for the official annual duty calendars used by the Italian border
 * connector.  The Ministry catalogue is used only as an identity authority;
 * it is deliberately not treated as a duty source.
 */

export const ITALY_DUTY_TIMEZONE = 'Europe/Rome';
export const ITALY_DUTY_PROVINCES = Object.freeze(['CO', 'VA', 'VB']);
export const ITALY_DUTY_START_TIME = '08:30';
export const ITALY_DUTY_MAX_AGE_HOURS = 72;

const ITALIAN_MONTHS = Object.freeze({
  gen: 1,
  gennaio: 1,
  feb: 2,
  febbraio: 2,
  mar: 3,
  marzo: 3,
  apr: 4,
  aprile: 4,
  mag: 5,
  maggio: 5,
  giu: 6,
  giugno: 6,
  lug: 7,
  luglio: 7,
  ago: 8,
  agosto: 8,
  set: 9,
  settembre: 9,
  ott: 10,
  ottobre: 10,
  nov: 11,
  novembre: 11,
  dic: 12,
  dicembre: 12,
});

const PROVINCE_MARKERS = Object.freeze([
  { province: 'CO', pattern: /\b(?:provincia\s+di\s+como|province?\s*[=:]\s*co|como)\b/i },
  { province: 'VA', pattern: /\b(?:provincia\s+di\s+varese|province?\s*[=:]\s*va|varese)\b/i },
  { province: 'VB', pattern: /\b(?:provincia\s+del?\s+verbano|province?\s*[=:]\s*vb|verbano\s+cusio\s+ossola|asl\s+vco|\bvco\b)\b/i },
]);

const DUTY_LINE_RE = /^\s*DUTY\|([^\r\n]+)$/i;
const DATE_LINE_RE = /^\s*(\d{1,2}[/.]\d{1,2}[/.]\d{4})\b(.*)$/;
const VARESE_DAY_MARKER_RE = /^\s*(\d{1,2})\s+(.+)$/;
const VARESE_MONTH_RE = /\b(Gennaio|Febbraio|Marzo|Aprile|Maggio|Giugno|Luglio|Agosto|Settembre|Ottobre|Novembre|Dicembre)\s+(20\d{2})\b/i;
const VCO_CORRECTION_RE = /\b(\d{1,2})[-.](gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\b.*?leggasi\s+(.+)$/i;

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function normalizeItalyDutyText(value) {
  return asText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;|&/gi, ' e ')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseCalendarDate(value, fallbackYear = null) {
  const raw = asText(value).trim();
  const full = raw.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (full) {
    const [, day, month, year] = full;
    return validCalendarParts(Number(year), Number(month), Number(day))
      ? { year: Number(year), month: Number(month), day: Number(day) }
      : null;
  }
  const compact = raw.match(/^(\d{1,2})[-/.]([a-zàèéìòù]+)$/i);
  if (compact && Number.isInteger(fallbackYear)) {
    const month = ITALIAN_MONTHS[compact[2].toLocaleLowerCase('it-IT')];
    return month && validCalendarParts(fallbackYear, month, Number(compact[1]))
      ? { year: fallbackYear, month, day: Number(compact[1]) }
      : null;
  }
  return null;
}

function validCalendarParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function datePartsToText(parts) {
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`;
}

function nextLocalDate(parts) {
  const candidate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 86_400_000);
  return { year: candidate.getUTCFullYear(), month: candidate.getUTCMonth() + 1, day: candidate.getUTCDate() };
}

function dateTimeParts(date) {
  const result = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: ITALY_DUTY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

/** Convert an unambiguous Europe/Rome local date/time to an ISO instant. */
export function localDateTimeToItalyIso(dateText, timeText = ITALY_DUTY_START_TIME) {
  const date = parseCalendarDate(dateText);
  const time = asText(timeText).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !time || Number(time[1]) > 23 || Number(time[2]) > 59) return null;

  const targetUtcMs = Date.UTC(date.year, date.month - 1, date.day, Number(time[1]), Number(time[2]), 0, 0);
  let guessMs = targetUtcMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = dateTimeParts(new Date(guessMs));
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
    guessMs = targetUtcMs - (representedAsUtc - guessMs);
  }

  const result = new Date(guessMs);
  const roundTrip = dateTimeParts(result);
  if (roundTrip.year !== date.year || roundTrip.month !== date.month || roundTrip.day !== date.day
    || roundTrip.hour !== Number(time[1]) || roundTrip.minute !== Number(time[2])) return null;
  return result.toISOString();
}

function extractProvinceHints(rawText) {
  const hints = new Set();
  for (const marker of PROVINCE_MARKERS) {
    if (marker.pattern.test(rawText)) hints.add(marker.province);
  }
  return [...hints];
}

export function resolveItalyDutyProvince(rawText, expectedProvince) {
  const expected = asText(expectedProvince).trim().toUpperCase();
  const hints = extractProvinceHints(asText(rawText));
  if (!ITALY_DUTY_PROVINCES.includes(expected)) {
    return { province: null, hints, error: 'source province is missing or unsupported' };
  }
  if (hints.some((province) => province !== expected)) {
    return { province: null, hints, error: `source contains a province marker outside ${expected}` };
  }
  if (hints.length > 1) {
    return { province: null, hints, error: 'source contains ambiguous province markers' };
  }
  return { province: expected, hints, error: null };
}

function validOfficialSource(source) {
  return source && source.sourceType === 'official'
    && typeof source.officialSourceUrl === 'string'
    && /^https:\/\//i.test(source.officialSourceUrl)
    && ITALY_DUTY_PROVINCES.includes(source.province)
    && typeof source.key === 'string'
    && typeof source.format === 'string';
}

function sourceAliases(source) {
  return Array.isArray(source.identityAliases)
    ? source.identityAliases
      .filter((alias) => alias && typeof alias.sourceLabel === 'string' && typeof alias.pharmacyId === 'string')
      .map((alias) => ({
        ...alias,
        normalized: normalizeItalyDutyText(alias.sourceLabel),
      }))
      .filter((alias) => alias.normalized)
      .sort((left, right) => right.normalized.length - left.normalized.length)
    : [];
}

function parseKeyValueLine(value) {
  const fields = {};
  for (const part of asText(value).split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    fields[part.slice(0, separator).trim().toLowerCase()] = part.slice(separator + 1).trim();
  }
  return fields;
}

function findAliases(line, aliases) {
  const normalizedLine = normalizeItalyDutyText(line);
  return aliases.filter((alias) => normalizedLine.includes(alias.normalized));
}

function makeRawRecord({ date, alias, province, rawLine, source }) {
  return {
    date,
    pharmacyId: alias.pharmacyId,
    label: alias.sourceLabel,
    province,
    rawLine: rawLine.trim(),
    sourceKey: source.key,
  };
}

function parseExplicitDutyLines(lines, source, province, aliases, warnings) {
  const records = [];
  for (const line of lines) {
    const match = line.match(DUTY_LINE_RE);
    if (!match) continue;
    const fields = parseKeyValueLine(match[1]);
    if (fields.province !== province) {
      warnings.push(`explicit duty row has missing or conflicting province: ${line.trim()}`);
      continue;
    }
    const date = parseCalendarDate(fields.date);
    if (!date) {
      warnings.push(`explicit duty row has invalid date: ${line.trim()}`);
      continue;
    }
    const idMatches = aliases.filter((candidate) => candidate.pharmacyId === fields.pharmacyid);
    const labelMatches = aliases.filter((candidate) => candidate.normalized === normalizeItalyDutyText(fields.label));
    const matches = idMatches.length > 0 ? idMatches : labelMatches;
    if (matches.length === 0) {
      warnings.push(`explicit duty row has no catalogue identity: ${line.trim()}`);
      continue;
    }
    if (matches.length > 1) {
      warnings.push(`explicit duty row has ambiguous catalogue identity: ${line.trim()}`);
      continue;
    }
    records.push(makeRawRecord({ date, alias: matches[0], province, rawLine: line, source }));
  }
  return records;
}

function parseComoCalendar(lines, source, province, aliases, warnings) {
  const records = [];
  for (const line of lines) {
    const match = line.match(DATE_LINE_RE);
    if (!match) continue;
    const date = parseCalendarDate(match[1]);
    if (!date) {
      warnings.push(`Como calendar row has invalid date: ${line.trim()}`);
      continue;
    }
    for (const alias of findAliases(match[2], aliases)) {
      records.push(makeRawRecord({ date, alias, province, rawLine: line, source }));
    }
  }
  return records;
}

function parseVareseCalendar(lines, source, province, aliases, warnings) {
  const records = [];
  let month = null;
  let year = null;
  let block = [];

  const flush = (day, rawLine) => {
    if (!month || !year || !Number.isInteger(day)) return;
    const date = parseCalendarDate(`${day}/${month}/${year}`);
    if (!date) {
      warnings.push(`Varese calendar row has invalid date: ${day}/${month}/${year}`);
      return;
    }
    const sourceText = block.join(' ');
    for (const alias of findAliases(sourceText, aliases)) {
      records.push(makeRawRecord({ date, alias, province, rawLine: rawLine || sourceText, source }));
    }
  };

  for (const line of lines) {
    const monthMatch = line.match(VARESE_MONTH_RE);
    if (monthMatch) {
      month = ITALIAN_MONTHS[monthMatch[1].toLocaleLowerCase('it-IT')];
      year = Number(monthMatch[2]);
      block = [];
      continue;
    }
    const dayMarker = line.match(VARESE_DAY_MARKER_RE);
    if (dayMarker && Number(dayMarker[1]) >= 1 && Number(dayMarker[1]) <= 31) {
      block.push(dayMarker[2]);
      flush(Number(dayMarker[1]), line);
      block = [];
      continue;
    }
    if (line.trim()) block.push(line);
  }
  return records;
}

function parseVcoCalendar(lines, source, province, aliases, warnings) {
  const records = [];
  let explicitRows = 0;
  for (const line of lines) {
    const match = line.match(VCO_CORRECTION_RE);
    if (!match) continue;
    explicitRows += 1;
    const date = parseCalendarDate(`${match[1]}-${match[2]}`, source.calendarYear);
    if (!date) {
      warnings.push(`VCO correction row has invalid date: ${line.trim()}`);
      continue;
    }
    for (const alias of findAliases(match[3], aliases)) {
      records.push(makeRawRecord({ date, alias, province, rawLine: line, source }));
    }
  }
  if (explicitRows === 0) {
    warnings.push('VCO calendar has no explicit date rows; rotation-only entries are not published');
  }
  return records;
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.date.year}-${record.date.month}-${record.date.day}|${record.pharmacyId}|${record.province}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCataloguePharmacy(pharmacyId, catalogue) {
  const pharmacies = Array.isArray(catalogue) ? catalogue : catalogue?.pharmacies;
  if (!Array.isArray(pharmacies)) return null;
  const matches = pharmacies.filter((pharmacy) => pharmacy?.id === pharmacyId && pharmacy?.country === 'IT');
  return matches.length === 1 ? matches[0] : null;
}

function dutyId(source, date, pharmacyId) {
  return `it-duty-${source.key}-${date.year}${String(date.month).padStart(2, '0')}${String(date.day).padStart(2, '0')}-${pharmacyId}`;
}

function recordsToDuties(records, source, province, fetchedAt, catalogue, warnings) {
  const duties = [];
  for (const record of dedupeRecords(records)) {
    const pharmacy = resolveCataloguePharmacy(record.pharmacyId, catalogue);
    if (!pharmacy) {
      warnings.push(`${source.key}: source identity ${record.pharmacyId} is missing from the Italian Ministry catalogue`);
      continue;
    }
    const startsAt = localDateTimeToItalyIso(datePartsToText(record.date), ITALY_DUTY_START_TIME);
    const endsAt = localDateTimeToItalyIso(datePartsToText(nextLocalDate(record.date)), ITALY_DUTY_START_TIME);
    if (!startsAt || !endsAt) {
      warnings.push(`${source.key}: invalid Europe/Rome boundary for ${datePartsToText(record.date)}`);
      continue;
    }
    duties.push({
      id: dutyId(source, record.date, pharmacy.id),
      pharmacyId: pharmacy.id,
      province,
      coverageType: 'province',
      coverageName: source.name,
      startsAt,
      endsAt,
      dutyType: '24h',
      status: 'verified',
      sourceUrl: source.officialSourceUrl,
      sourceType: 'official',
      fetchedAt,
      verifiedAt: fetchedAt,
    });
  }
  return duties;
}

function sourceFreshness(source, fetchedAt, asOf) {
  if (!isIsoTimestamp(fetchedAt) || !isIsoTimestamp(asOf)) return 'unknown';
  const ageHours = (Date.parse(asOf) - Date.parse(fetchedAt)) / 3_600_000;
  if (ageHours < -1 || ageHours > Number(source.maxAgeHours || ITALY_DUTY_MAX_AGE_HOURS)) return 'stale';
  return 'fresh';
}

function sourceValidity(source, asOf) {
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime())) return false;
  const asOfDate = date.toISOString().slice(0, 10);
  return (!source.validFrom || asOfDate >= source.validFrom) && (!source.validTo || asOfDate <= source.validTo);
}

/**
 * Parse one official source.  A source is single-province by contract; no
 * province is inferred from city, CAP, distance, or a third-party directory.
 */
export function parseItalyDutySource(rawText, source, {
  fetchedAt = new Date().toISOString(),
  asOf = fetchedAt,
  catalogue = [],
} = {}) {
  const warnings = [];
  const errors = [];
  const lines = asText(rawText).split(/\r?\n/);

  if (!validOfficialSource(source)) {
    errors.push('invalid official source definition');
    return { duties: [], warnings, errors, records: [], province: null, freshness: 'unknown', coverage: 'not_published' };
  }
  const provinceResult = resolveItalyDutyProvince(rawText, source.province);
  if (provinceResult.error) {
    errors.push(provinceResult.error);
    return { duties: [], warnings, errors, records: [], province: null, freshness: 'unknown', coverage: 'not_published' };
  }
  if (!isIsoTimestamp(fetchedAt)) {
    errors.push('invalid fetchedAt timestamp');
    return { duties: [], warnings, errors, records: [], province: provinceResult.province, freshness: 'unknown', coverage: 'not_published' };
  }
  if (!sourceValidity(source, asOf)) {
    errors.push('official calendar is outside its declared validity window');
  }

  const aliases = sourceAliases(source);
  const explicitRecords = parseExplicitDutyLines(lines, source, provinceResult.province, aliases, warnings);
  let records = explicitRecords;
  if (records.length === 0) {
    if (source.format === 'como-calendar-v1') records = parseComoCalendar(lines, source, provinceResult.province, aliases, warnings);
    if (source.format === 'varese-calendar-v1') records = parseVareseCalendar(lines, source, provinceResult.province, aliases, warnings);
    if (source.format === 'vco-calendar-v1') records = parseVcoCalendar(lines, source, provinceResult.province, aliases, warnings);
  }

  const freshness = sourceFreshness(source, fetchedAt, asOf);
  if (freshness === 'stale') errors.push('official source fetch is stale');
  let duties = recordsToDuties(records, source, provinceResult.province, fetchedAt, catalogue, warnings);
  // A malformed, unresolved, or ambiguous row invalidates the whole
  // provincial feed. Keeping the other rows would make a partial official
  // calendar look complete to the release checker.
  const fatalWarnings = warnings.filter((warning) => /missing or conflicting province|invalid date|no catalogue identity|ambiguous catalogue identity|invalid Europe\/Rome boundary|source identity .* missing/i.test(warning));
  if (fatalWarnings.length > 0) {
    errors.push(...fatalWarnings.map((warning) => `source row is not publishable: ${warning}`));
  }
  if (errors.length > 0) duties = [];
  const coverage = duties.length > 0 ? 'covered' : 'not_published';
  if (coverage !== 'covered') errors.push('zero unambiguous duty rows resolved against the Ministry catalogue');

  return {
    duties,
    warnings,
    errors,
    records,
    province: provinceResult.province,
    freshness,
    coverage,
    sourceKey: source.key,
    fetchedAt,
  };
}

export function parseItalyDutyRows(rawText, source, options = {}) {
  return parseItalyDutySource(rawText, source, options);
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release payload contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  throw new Error(`release payload contains unsupported value ${typeof value}`);
}

export function canonicalItalyDutyJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256ItalyDutyPayload(value) {
  return createHash('sha256').update(canonicalItalyDutyJson(value)).digest('hex');
}

function withoutRelease(snapshot) {
  const { _release: _ignored, ...payload } = snapshot || {};
  return payload;
}

function releaseProvinceStatuses(status) {
  const configured = status && status._provinces && typeof status._provinces === 'object' && !Array.isArray(status._provinces)
    ? status._provinces
    : {};
  return Object.fromEntries(ITALY_DUTY_PROVINCES.map((province) => [province, configured[province] || {
    province,
    state: 'not_published',
    freshness: 'unknown',
    coverage: 'not_published',
    dutyCount: 0,
    sourceUrl: '',
    fetchedAt: null,
  }]));
}

function releaseState(duties, status, provinces) {
  const errors = [
    ...(Array.isArray(duties?._errors) ? duties._errors : []),
    ...(Array.isArray(status?._errors) ? status._errors : []),
  ];
  const entries = Object.values(provinces);
  if (status?._allSourcesFailed === true || entries.every((entry) => entry.coverage === 'not_published')) return 'not_published';
  if (errors.length > 0 || entries.some((entry) => entry.state === 'conflicting')) return 'partial';
  if (entries.some((entry) => entry.freshness === 'stale')) return 'stale';
  if (entries.some((entry) => entry.coverage !== 'covered' || entry.freshness !== 'fresh')) return 'not_published';
  return 'fresh';
}

/** Shared Node-side release builder used by importer and checker. */
export function buildItalyReleaseContract({ duties, status, evaluatedAt }) {
  const provinces = releaseProvinceStatuses(status);
  const body = {
    version: 1,
    timezone: ITALY_DUTY_TIMEZONE,
    state: releaseState(duties, status, provinces),
    evaluatedAt,
    scope: { country: 'IT', provinces: [...ITALY_DUTY_PROVINCES] },
    snapshots: {
      duties: {
        path: 'data/pharmacy-duties-italy.json',
        sha256: sha256ItalyDutyPayload(withoutRelease(duties)),
        fetchedAt: isIsoTimestamp(duties?._fetchedAt) ? duties._fetchedAt : null,
      },
      status: {
        path: 'data/pharmacy-duties-italy-status.json',
        sha256: sha256ItalyDutyPayload(withoutRelease(status)),
        fetchedAt: isIsoTimestamp(status?._fetchedAt) ? status._fetchedAt : null,
      },
    },
    provinces,
  };
  return { ...body, releaseId: `pharmacy-italy-v1-${sha256ItalyDutyPayload(body)}` };
}

export function buildAtomicItalyDutySnapshots({ duties, status, evaluatedAt }) {
  const cleanDuties = withoutRelease(duties);
  const cleanStatus = withoutRelease(status);
  const release = buildItalyReleaseContract({ duties: cleanDuties, status: cleanStatus, evaluatedAt });
  return {
    duties: { ...cleanDuties, _release: release },
    status: { ...cleanStatus, _release: release },
    release,
  };
}

export function verifyItalyReleaseSnapshots({ duties, status }) {
  const errors = [];
  const dutiesRelease = duties?._release;
  const statusRelease = status?._release;
  if (!dutiesRelease || typeof dutiesRelease !== 'object') errors.push('duties: missing release');
  if (!statusRelease || typeof statusRelease !== 'object') errors.push('status: missing release');
  if (!dutiesRelease || !statusRelease) return errors;
  if (dutiesRelease.releaseId !== statusRelease.releaseId) errors.push('releaseId differs between duties and status');
  if (dutiesRelease.timezone !== ITALY_DUTY_TIMEZONE || statusRelease.timezone !== ITALY_DUTY_TIMEZONE) errors.push('release timezone mismatch');
  const expected = buildItalyReleaseContract({
    duties: withoutRelease(duties),
    status: withoutRelease(status),
    evaluatedAt: dutiesRelease.evaluatedAt,
  });
  if (dutiesRelease.releaseId !== expected.releaseId) errors.push('releaseId does not match the release contract');
  if (canonicalItalyDutyJson({ ...dutiesRelease, releaseId: undefined }) !== canonicalItalyDutyJson({ ...expected, releaseId: undefined })) {
    errors.push('release metadata does not match the payload contract');
  }
  if (dutiesRelease.snapshots?.duties?.sha256 !== sha256ItalyDutyPayload(withoutRelease(duties))) errors.push('duties payload hash mismatch');
  if (dutiesRelease.snapshots?.status?.sha256 !== sha256ItalyDutyPayload(withoutRelease(status))) errors.push('status payload hash mismatch');
  return errors;
}
