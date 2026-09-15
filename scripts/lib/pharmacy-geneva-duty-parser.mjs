import { localDateTimeToIso } from '../../services/pharmacies/time.mjs';
import {
  GENEVA_DUTY_RELEASE_CANTON,
  GENEVA_DUTY_RELEASE_COVERAGE_NAME,
  GENEVA_DUTY_RELEASE_MAX_AGE_MS,
  GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS,
  GENEVA_DUTY_RELEASE_SOURCE_KEY,
  GENEVA_DUTY_RELEASE_SOURCE_URL,
  GENEVA_DUTY_RELEASE_TIMEZONE,
  GENEVA_DUTY_RELEASE_VALID_FROM,
  GENEVA_DUTY_RELEASE_VALID_TO,
  validateGenevaDutySourceRegistry,
} from '../../services/pharmacies/genevaReleaseContract.mjs';

export { GENEVA_DUTY_RELEASE_SOURCE_URL } from '../../services/pharmacies/genevaReleaseContract.mjs';

const FRENCH_MONTHS = Object.freeze({
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
});

const FRENCH_WEEKDAYS = '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
const DATE_RANGE_RE = new RegExp(
  `(?:du\\s+)?(?:${FRENCH_WEEKDAYS}\\s+)?(\\d{1,2})\\s+([a-zàâçéèêëîïôûùüÿœæ]+)(?:\\s+(20\\d{2}))?\\s+(?:au|a|à)\\s+(?:${FRENCH_WEEKDAYS}\\s+)?(\\d{1,2})\\s+([a-zàâçéèêëîïôûùüÿœæ]+)\\s+(20\\d{2})`,
  'i',
);
const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*[−–-]\s*(\d{1,2}):(\d{2})/;
const POSTAL_CITY_RE = /^(\d{4})\s+(.+)$/;
const HTML_TEXT_MODULE_RE = /<div\b[^>]*class=["'][^"']*\bet_pb_text\b[^"']*["'][^>]*>[\s\S]*?<div\b[^>]*class=["'][^"']*\bet_pb_text_inner\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function decodeEntities(value) {
  return asText(value)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function textLines(html) {
  return decodeEntities(html)
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function textValue(html) {
  return textLines(html).join(' ');
}

export function normalizeGenevaDutyText(value) {
  return decodeEntities(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validCalendarDate(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    && candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function calendarDate(year, month, day) {
  return validCalendarDate(year, month, day) ? { year, month, day } : null;
}

function dateKey(date) {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return calendarDate(year, month, day);
}

function nextDate(date) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day));
  next.setUTCDate(next.getUTCDate() + 1);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dateKeysBetween(start, end) {
  const keys = [];
  let current = start;
  while (dateKey(current) <= dateKey(end)) {
    keys.push(dateKey(current));
    if (dateKey(current) === dateKey(end)) break;
    current = nextDate(current);
  }
  return keys;
}

function parseDateRange(value) {
  const match = asText(value).replace(/\u00a0/g, ' ').match(DATE_RANGE_RE);
  if (!match) return null;
  const startMonth = FRENCH_MONTHS[match[2].toLocaleLowerCase('fr-FR')];
  const endMonth = FRENCH_MONTHS[match[5].toLocaleLowerCase('fr-FR')];
  const endYear = Number(match[6]);
  const startYear = match[3] ? Number(match[3]) : endYear;
  const start = calendarDate(startYear, startMonth, Number(match[1]));
  const end = calendarDate(endYear, endMonth, Number(match[4]));
  if (!start || !end || dateKey(start) > dateKey(end)) return null;
  return { start, end };
}

function parseTimeRange(value) {
  const match = asText(value).replace(/\u00a0/g, ' ').match(TIME_RANGE_RE);
  if (!match) return null;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if ([startHour, endHour].some((hour) => hour < 0 || hour > 23)
    || [startMinute, endMinute].some((minute) => minute < 0 || minute > 59)) return null;
  return {
    startTime: `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`,
    endTime: `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`,
  };
}

function extractPostalCity(lines) {
  const line = lines.find((candidate) => POSTAL_CITY_RE.test(candidate));
  if (!line) return null;
  const match = line.match(POSTAL_CITY_RE);
  return { postalCode: match[1], city: match[2].trim() };
}

function extractTextBlocks(html) {
  const blocks = [];
  const source = asText(html);
  let match;
  while ((match = HTML_TEXT_MODULE_RE.exec(source)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractHeading(block) {
  const match = asText(block).match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i);
  return match ? textValue(match[1]) : null;
}

function parseCard(name, detailHtml, index) {
  const lines = textLines(detailHtml);
  const detail = lines.join(' ');
  if (/24h\s*\/\s*24\s+et\s+7j\s*\/\s*7/i.test(detail)) {
    return {
      kind: 'permanent',
      index,
      sourceLabel: name,
      detail,
      lines,
    };
  }

  const dateLine = lines.find((line) => DATE_RANGE_RE.test(line));
  const timeLine = lines.find((line) => TIME_RANGE_RE.test(line));
  const range = parseDateRange(dateLine);
  const times = parseTimeRange(timeLine);
  const locality = extractPostalCity(lines);
  if (!range || !times || !locality) {
    return {
      kind: 'invalid',
      index,
      sourceLabel: name,
      detail,
      lines,
    };
  }
  return {
    kind: 'dated',
    index,
    sourceLabel: name,
    detail,
    lines,
    ...range,
    ...times,
    ...locality,
  };
}

export function parseGenevaDutyCards(html) {
  const blocks = extractTextBlocks(html);
  const cards = [];
  const warnings = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const name = extractHeading(blocks[index]);
    if (!name) continue;
    const detailHtml = blocks[index + 1];
    if (!detailHtml || extractHeading(detailHtml)) {
      warnings.push(`source card ${index} has no detail block`);
      cards.push({ kind: 'invalid', index, sourceLabel: name, detail: '', lines: [] });
      continue;
    }
    cards.push(parseCard(name, detailHtml, index));
    index += 1;
  }
  return { cards, warnings };
}

function registrySource(registry) {
  return registry && Array.isArray(registry.sources) && registry.sources.length === 1
    ? registry.sources[0]
    : null;
}

function sourceAliases(source) {
  return Array.isArray(source?.identityAliases)
    ? source.identityAliases
      .filter((alias) => alias && typeof alias.sourceLabel === 'string' && typeof alias.pharmacyId === 'string')
      .map((alias) => ({
        sourceLabel: alias.sourceLabel.trim(),
        pharmacyId: alias.pharmacyId.trim(),
        normalized: normalizeGenevaDutyText(alias.sourceLabel),
      }))
    : [];
}

function resolveIdentity(sourceLabel, source, catalogue) {
  const aliases = sourceAliases(source);
  const normalizedLabel = normalizeGenevaDutyText(sourceLabel);
  const aliasMatches = aliases.filter((alias) => alias.normalized === normalizedLabel);
  if (aliasMatches.length !== 1) {
    return { pharmacy: null, pharmacyId: null, error: aliasMatches.length === 0
      ? `source identity alias is missing for "${sourceLabel}"`
      : `source identity alias is ambiguous for "${sourceLabel}"` };
  }
  if (!Array.isArray(catalogue)) {
    return { pharmacy: null, pharmacyId: aliasMatches[0].pharmacyId, error: 'Geneva identity catalogue is missing; no operational duty rows can be published' };
  }
  const matches = catalogue.filter((pharmacy) => pharmacy?.id === aliasMatches[0].pharmacyId);
  if (matches.length !== 1) {
    return { pharmacy: null, pharmacyId: aliasMatches[0].pharmacyId, error: `source identity ${aliasMatches[0].pharmacyId} is missing or ambiguous in the Geneva catalogue` };
  }
  const pharmacy = matches[0];
  if (pharmacy.country !== 'CH' || !['Geneva', 'Ginevra', GENEVA_DUTY_RELEASE_CANTON].includes(pharmacy.canton)) {
    return { pharmacy: null, pharmacyId: aliasMatches[0].pharmacyId, error: `source identity ${aliasMatches[0].pharmacyId} is outside the Geneva canton` };
  }
  return { pharmacy, pharmacyId: pharmacy.id, error: null };
}

function localDateTimeToGenevaIso(date, time) {
  const dateText = `${String(date.day).padStart(2, '0')}.${String(date.month).padStart(2, '0')}.${date.year}`;
  try {
    return localDateTimeToIso(dateText, time);
  } catch {
    return null;
  }
}

export function localDateTimeToGenevaIsoForTest(dateText, timeText) {
  const parsed = asText(dateText).match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  const date = parsed ? calendarDate(Number(parsed[3]), Number(parsed[2]), Number(parsed[1])) : null;
  return date ? localDateTimeToGenevaIso(date, timeText) : null;
}

function sourceFreshness(fetchedAt, asOf, maxAgeMs = GENEVA_DUTY_RELEASE_MAX_AGE_MS) {
  if (!isIsoTimestamp(fetchedAt) || !isIsoTimestamp(asOf)) return 'unknown';
  const age = Date.parse(asOf) - Date.parse(fetchedAt);
  return age < -60 * 60 * 1000 || age > maxAgeMs ? 'stale' : 'fresh';
}

function dateWithinWindow(date) {
  const key = dateKey(date);
  return key >= GENEVA_DUTY_RELEASE_VALID_FROM && key <= GENEVA_DUTY_RELEASE_VALID_TO;
}

function coverageDays(cards) {
  const days = new Set();
  for (const card of cards.filter((candidate) => candidate.kind === 'dated')) {
    for (const key of dateKeysBetween(card.start, card.end)) days.add(key);
  }
  return days;
}

function uncoveredCalendarDays(days) {
  return dateKeysBetween(
    dateFromKey(GENEVA_DUTY_RELEASE_VALID_FROM),
    dateFromKey(GENEVA_DUTY_RELEASE_VALID_TO),
  ).filter((date) => !days.has(date)).length;
}

function hasGap(days) {
  return uncoveredCalendarDays(days) > 0;
}

function intervalOverlaps(cards) {
  const dated = cards.filter((candidate) => candidate.kind === 'dated');
  return dated.some((current, index) => dated.slice(index + 1).some((next) => {
    const currentStart = Date.UTC(current.start.year, current.start.month - 1, current.start.day);
    const currentEnd = Date.UTC(nextDate(current.end).year, nextDate(current.end).month - 1, nextDate(current.end).day);
    const nextStart = Date.UTC(next.start.year, next.start.month - 1, next.start.day);
    const nextEnd = Date.UTC(nextDate(next.end).year, nextDate(next.end).month - 1, nextDate(next.end).day);
    return currentStart < nextEnd && nextStart < currentEnd;
  }));
}

function dutyId(sourceKey, card, pharmacyId) {
  return `ge-duty-${sourceKey}-${dateKey(card.start)}-${pharmacyId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function toObservedDuty(card, source, identity, fetchedAt) {
  if (!source) return null;
  const startsAt = localDateTimeToGenevaIso(card.start, card.startTime);
  const endsAt = localDateTimeToGenevaIso(card.end, card.endTime);
  if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) return null;
  return {
    id: dutyId(source.key, card, identity.pharmacyId),
    pharmacyId: identity.pharmacyId,
    coverageType: 'canton',
    coverageName: GENEVA_DUTY_RELEASE_COVERAGE_NAME,
    startsAt,
    endsAt,
    dutyType: 'day',
    status: 'verified',
    sourceUrl: GENEVA_DUTY_RELEASE_SOURCE_URL,
    sourceType: 'association',
    fetchedAt,
    verifiedAt: fetchedAt,
  };
}

/**
 * Parses the allowlisted Pharma Genève page. The parser returns resolved
 * observations separately from `duties`: an incomplete or identity-unsafe
 * calendar always returns an empty operational list.
 * @param {string} rawHtml
 * @param {Record<string, unknown>} registry
 * @param {{fetchedAt?: string, asOf?: string, catalogue?: unknown[], maxAgeMs?: number}} options
 */
export function parseGenevaDutySource(rawHtml, registry, {
  fetchedAt = new Date().toISOString(),
  asOf = fetchedAt,
  catalogue,
  maxAgeMs = GENEVA_DUTY_RELEASE_MAX_AGE_MS,
} = {}) {
  const errors = [...validateGenevaDutySourceRegistry(registry)];
  const warnings = [];
  const source = registrySource(registry);
  if (source?.status !== 'active') {
    errors.push(`Geneva duty source is not release-ready (status: ${source?.status || 'unknown'})`);
  }
  const freshness = sourceFreshness(fetchedAt, asOf, maxAgeMs);
  if (freshness === 'unknown') errors.push('source fetch timestamp is missing or invalid');
  if (freshness === 'stale') errors.push('official source fetch is stale');
  if (!isIsoTimestamp(asOf)) errors.push('source evaluation timestamp is missing or invalid');

  const pageText = textValue(rawHtml);
  if (!/Pharmacies\s+de\s+garde\s+2026/i.test(pageText)) errors.push('official source title does not identify the 2026 Geneva duty page');
  const parsed = parseGenevaDutyCards(rawHtml);
  warnings.push(...parsed.warnings);
  const datedCards = parsed.cards.filter((card) => card.kind === 'dated');
  const permanentCards = parsed.cards.filter((card) => card.kind === 'permanent');
  if (permanentCards.length > 0) {
    warnings.push('permanent 24/7 cards are retained as observations only; no dated duty interval is inferred');
  }
  for (const card of parsed.cards.filter((candidate) => candidate.kind === 'invalid')) {
    errors.push(`source card ${card.index} is missing an explicit date range, interval or Geneva locality`);
  }
  if (datedCards.length === 0) errors.push('official source contains no dated Geneva duty window');

  const days = coverageDays(datedCards);
  const outOfWindow = datedCards.filter((card) => !dateWithinWindow(card.start) || !dateWithinWindow(card.end));
  if (outOfWindow.length > 0) errors.push(`official duty window is outside the declared 2026 calendar: ${outOfWindow.length} card(s)`);
  if (intervalOverlaps(datedCards)) errors.push('official duty windows overlap; coverage is conflicting');
  if (days.size < GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS) {
    errors.push(`official calendar coverage is incomplete: ${days.size}/${GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS} distinct calendar days`);
  }
  const uncoveredDays = uncoveredCalendarDays(days);
  if (uncoveredDays > 0) errors.push('official calendar has uncovered days in the declared 2026 window');

  const observedDuties = [];
  const unresolvedIdentities = [];
  const seenIdentityErrors = new Set();
  for (const card of datedCards) {
    const identity = resolveIdentity(card.sourceLabel, source, catalogue);
    if (identity.error) {
      unresolvedIdentities.push(identity.pharmacyId || card.sourceLabel);
      if (!seenIdentityErrors.has(identity.error)) {
        errors.push(identity.error);
        seenIdentityErrors.add(identity.error);
      }
      continue;
    }
    const duty = toObservedDuty(card, source, identity, fetchedAt);
    if (!duty) {
      errors.push(`source card ${card.index} has an invalid ${GENEVA_DUTY_RELEASE_TIMEZONE} boundary`);
      continue;
    }
    observedDuties.push(duty);
  }

  const coverage = errors.length === 0 && days.size === GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS && !hasGap(days)
    ? 'covered'
    : datedCards.length === 0 ? 'not_published' : 'partial';
  const duties = errors.length === 0 && coverage === 'covered' && observedDuties.length > 0
    ? observedDuties
    : [];
  if (duties.length === 0 && !errors.some((error) => error.includes('no operational duty rows'))) {
    errors.push('no operational duty rows published because source validation or identity coverage failed');
  }

  return {
    sourceKey: source?.key || null,
    sourceUrl: source?.officialSourceUrl || null,
    canton: GENEVA_DUTY_RELEASE_CANTON,
    timezone: GENEVA_DUTY_RELEASE_TIMEZONE,
    freshness,
    coverage,
    cards: parsed.cards,
    observations: parsed.cards,
    observedCalendarDays: days.size,
    uncoveredCalendarDays: uncoveredDays,
    observedDuties,
    duties,
    unresolvedIdentities: [...new Set(unresolvedIdentities)].sort(),
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    fetchedAt: isIsoTimestamp(fetchedAt) ? fetchedAt : null,
  };
}
