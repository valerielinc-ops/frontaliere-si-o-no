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
export const ITALY_DUTY_MINIMUM_CALENDAR_DAYS = 300;

/**
 * Le fonti provinciali NON sono omogenee, e trattarle come tali e' il difetto
 * che ha tenuto questo import rosso dalla sua prima run.
 *
 * - `full-calendar`: la fonte pubblica il calendario annuale completo, un giorno
 *   per riga (Como, Varese). Per queste la copertura in giorni e' misurabile e
 *   il minimo si applica.
 * - `corrections-only`: la fonte pubblica solo i CAMBI TURNO con data esplicita
 *   su una rotazione di base che il parser deliberatamente non espande (VCO, che
 *   lo dichiara nelle proprie `notes`). Misurata sul PDF reale: 14 righe su 7
 *   giorni distinti. Un minimo in giorni-calendario e un modello
 *   corrections-only sono mutuamente esclusivi per costruzione, quindi il
 *   minimo NON si applica a queste fonti.
 */
export const ITALY_DUTY_COVERAGE_MODELS = Object.freeze(['full-calendar', 'corrections-only']);
export const ITALY_DUTY_PUBLICATION_CLASSES = Object.freeze(['required', 'best-effort']);

/** Modello di copertura dichiarato dalla fonte; default fail-closed. */
export function sourceCoverageModel(source) {
  return ITALY_DUTY_COVERAGE_MODELS.includes(source?.coverageModel)
    ? source.coverageModel
    : 'full-calendar';
}

/**
 * Classe di pubblicazione. Default `required`: una fonte che non la dichiara
 * resta bloccante, cosi' un errore di registry non declassa una provincia in
 * silenzio.
 */
export function sourcePublicationClass(source) {
  return ITALY_DUTY_PUBLICATION_CLASSES.includes(source?.publication)
    ? source.publication
    : 'required';
}

/** Chiave `YYYY-MM-DD` di una data di calendario gia' validata. */
export function calendarDateKey(date) {
  return date.year + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0');
}

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
  if (hints.length === 0) {
    return { province: null, hints, error: 'source province marker is missing' };
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
    && typeof source.rawUrl === 'string'
    && /^https:\/\//i.test(source.rawUrl)
    && ITALY_DUTY_PROVINCES.includes(source.province)
    && typeof source.key === 'string'
    && typeof source.format === 'string'
    && ITALY_DUTY_COVERAGE_MODELS.includes(sourceCoverageModel(source))
    && ITALY_DUTY_PUBLICATION_CLASSES.includes(sourcePublicationClass(source))
    // Il minimo in giorni-calendario vale solo per una fonte che PUBBLICA un
    // calendario completo. Una fonte corrections-only non puo' soddisfarlo per
    // costruzione, quindi pretenderlo la rendeva "invalid official source".
    && (sourceCoverageModel(source) === 'corrections-only'
      || (Number.isInteger(source.minimumCalendarDays)
        && source.minimumCalendarDays >= ITALY_DUTY_MINIMUM_CALENDAR_DAYS));
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

function parseExplicitDutyLines(lines, source, province, aliases, warnings, calendarDays) {
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
    // Per una fonte a righe esplicite il "calendario" SONO le righe di turno:
    // la data entra nel conteggio prima del match sull'anagrafica.
    calendarDays.add(calendarDateKey(date));
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

function parseComoCalendar(lines, source, province, aliases, warnings, calendarDays) {
  const records = [];
  for (const line of lines) {
    const match = line.match(DATE_LINE_RE);
    if (!match) continue;
    const date = parseCalendarDate(match[1]);
    if (!date) {
      warnings.push(`Como calendar row has invalid date: ${line.trim()}`);
      continue;
    }
    // La copertura si misura QUI, sulle righe-data, non sulle righe che hanno
    // fatto match con gli alias: il calendario di Como copre 365 giorni
    // distinti, ma solo ~5 farmacie del catalogo vi compaiono.
    calendarDays.add(calendarDateKey(date));
    for (const alias of findAliases(match[2], aliases)) {
      records.push(makeRawRecord({ date, alias, province, rawLine: line, source }));
    }
  }
  return records;
}

function parseVareseCalendar(lines, source, province, aliases, warnings, calendarDays) {
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
    // Come Como: il giorno conta per la copertura anche quando nessun alias
    // compare nel blocco di quel giorno.
    calendarDays.add(calendarDateKey(date));
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

function parseVcoCalendar(lines, source, province, aliases, warnings, calendarDays) {
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
    // Fonte corrections-only: i giorni sono solo i cambi turno con data
    // esplicita (misurati: 7). Il minimo in giorni non si applica a VCO.
    calendarDays.add(calendarDateKey(date));
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

function resolveCataloguePharmacy(pharmacyId, province, catalogue) {
  const pharmacies = Array.isArray(catalogue) ? catalogue : catalogue?.pharmacies;
  if (!Array.isArray(pharmacies)) return null;
  const matches = pharmacies.filter((pharmacy) => pharmacy?.id === pharmacyId
    && pharmacy?.country === 'IT'
    && pharmacy?.province === province);
  return matches.length === 1 ? matches[0] : null;
}

function dutyId(source, date, pharmacyId) {
  return `it-duty-${source.key}-${date.year}${String(date.month).padStart(2, '0')}${String(date.day).padStart(2, '0')}-${pharmacyId}`;
}

function recordsToDuties(records, source, province, fetchedAt, catalogue, warnings) {
  const duties = [];
  for (const record of dedupeRecords(records)) {
    const pharmacy = resolveCataloguePharmacy(record.pharmacyId, province, catalogue);
    if (!pharmacy) {
      warnings.push(`${source.key}: source identity ${record.pharmacyId} is missing from or has a province mismatch in the Italian Ministry catalogue`);
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
  const parts = dateTimeParts(date);
  const asOfDate = [
    parts.year,
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
  if (source.validFrom && !isSourceCalendarDate(source.validFrom)) return false;
  if (source.validTo && !isSourceCalendarDate(source.validTo)) return false;
  return (!source.validFrom || asOfDate >= source.validFrom) && (!source.validTo || asOfDate <= source.validTo);
}

function isSourceCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return validCalendarParts(year, month, day);
}

function sourceCalendarDateWithinValidity(source, date) {
  const value = [
    date.year,
    String(date.month).padStart(2, '0'),
    String(date.day).padStart(2, '0'),
  ].join('-');
  return (!source.validFrom || value >= source.validFrom) && (!source.validTo || value <= source.validTo);
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
    return { duties: [], observedDuties: [], warnings, errors, records: [], province: null, freshness: 'unknown', coverage: 'not_published' };
  }
  const provinceResult = resolveItalyDutyProvince(rawText, source.province);
  if (provinceResult.error) {
    errors.push(provinceResult.error);
    return { duties: [], observedDuties: [], warnings, errors, records: [], province: null, freshness: 'unknown', coverage: 'not_published' };
  }
  if (!isIsoTimestamp(fetchedAt)) {
    errors.push('invalid fetchedAt timestamp');
    return { duties: [], observedDuties: [], warnings, errors, records: [], province: provinceResult.province, freshness: 'unknown', coverage: 'not_published' };
  }
  if (!sourceValidity(source, asOf)) {
    errors.push('official calendar is outside its declared validity window');
  }

  const aliases = sourceAliases(source);
  // I giorni-calendario OSSERVATI nella fonte, raccolti dai parser di layout
  // indipendentemente dal match sull'anagrafica. Vedi il commento sul gate piu'
  // sotto: derivarli dalle righe di turno era il difetto.
  const calendarDays = new Set();
  const explicitRecords = parseExplicitDutyLines(lines, source, provinceResult.province, aliases, warnings, calendarDays);
  let records = explicitRecords;
  if (records.length === 0) {
    if (source.format === 'como-calendar-v1') records = parseComoCalendar(lines, source, provinceResult.province, aliases, warnings, calendarDays);
    if (source.format === 'varese-calendar-v1') records = parseVareseCalendar(lines, source, provinceResult.province, aliases, warnings, calendarDays);
    if (source.format === 'vco-calendar-v1') records = parseVcoCalendar(lines, source, provinceResult.province, aliases, warnings, calendarDays);
  }

  const freshness = sourceFreshness(source, fetchedAt, asOf);
  if (freshness === 'stale') errors.push('official source fetch is stale');
  const dedupedRecords = dedupeRecords(records);
  const observedDuties = recordsToDuties(dedupedRecords, source, provinceResult.province, fetchedAt, catalogue, warnings);
  // COPERTURA DEL CALENDARIO, non copertura dell'anagrafica.
  //
  // Questo valore era calcolato su `dedupedRecords`, che contiene SOLO le righe
  // che hanno fatto match con uno dei 5-6 `identityAliases` del catalogo, e
  // veniva poi confrontato con `minimumCalendarDays: 300`, che descrive
  // l'ampiezza del CALENDARIO. Le due grandezze non sono confrontabili: in una
  // rotazione provinciale ogni farmacia aliasata e' di turno ~14-16 volte
  // l'anno, quindi il numero non poteva superare ~70 e il gate era
  // insoddisfacibile per costruzione. Misurato sui PDF reali: Como pubblica 365
  // giorni distinti e Varese 355, mentre il parser riportava 71 e 70. Il parser
  // non perdeva righe: non gliele si era mai chieste.
  const observedCalendarDays = calendarDays.size;
  const outOfWindowRecords = dedupedRecords.filter((record) => !sourceCalendarDateWithinValidity(source, record.date));
  if (outOfWindowRecords.length > 0) {
    errors.push('official duty date is outside its declared validity window: ' + outOfWindowRecords.length + ' row(s)');
  }
  const minimumCalendarDays = Number(source.minimumCalendarDays);
  let incompleteCalendar = false;
  // Il minimo vale solo per una fonte che pubblica un calendario completo. Una
  // fonte `corrections-only` pubblica per definizione i soli cambi turno, quindi
  // un minimo in giorni la marcherebbe incompleta per sempre.
  const appliesCalendarMinimum = sourceCoverageModel(source) === 'full-calendar';
  if (appliesCalendarMinimum && Number.isInteger(minimumCalendarDays) && minimumCalendarDays > 0 && observedCalendarDays < minimumCalendarDays) {
    incompleteCalendar = true;
    errors.push('official calendar coverage is incomplete: ' + observedCalendarDays + '/' + minimumCalendarDays + ' distinct calendar days');
  }
  let duties = observedDuties;
  // A malformed, unresolved, or ambiguous row invalidates the whole
  // provincial feed. Keeping the other rows would make a partial official
  // calendar look complete to the release checker.
  const fatalWarnings = warnings.filter((warning) => /missing or conflicting province|invalid date|no catalogue identity|ambiguous catalogue identity|invalid Europe\/Rome boundary|source identity .* missing/i.test(warning));
  if (fatalWarnings.length > 0) {
    errors.push(...fatalWarnings.map((warning) => `source row is not publishable: ${warning}`));
  }
  if (errors.length > 0) duties = [];
  const coverage = errors.length === 0 && duties.length > 0 && !incompleteCalendar
    ? 'covered'
    : incompleteCalendar ? 'partial' : 'not_published';
  if (coverage !== 'covered') {
    errors.push(incompleteCalendar
      ? 'no operational duty rows published because official calendar coverage is incomplete'
      : observedDuties.length === 0
        ? 'zero unambiguous duty rows resolved against the Ministry catalogue'
        : 'no operational duty rows published because source validation failed');
  }

  return {
    duties,
    observedDuties,
    warnings,
    errors,
    records,
    province: provinceResult.province,
    freshness,
    coverage,
    sourceKey: source.key,
    fetchedAt,
    // Esposti perche' il difetto era proprio una misura sbagliata: renderla
    // leggibile nello status e nei test evita di doverla dedurre dagli errori.
    observedCalendarDays,
    minimumCalendarDays: appliesCalendarMinimum && Number.isInteger(minimumCalendarDays) ? minimumCalendarDays : null,
    coverageModel: sourceCoverageModel(source),
    publication: sourcePublicationClass(source),
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
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
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
    // Provincia assente dallo status: resta bloccante.
    publication: 'required',
  }]));
}

function releaseState(duties, status, provinces) {
  // `_errors` contiene SOLO gli errori delle fonti `required`. Gli errori delle
  // fonti `best-effort` vivono in `_bestEffortErrors`: restano nello snapshot e
  // visibili al monitor, ma non decidono lo stato della release. Senza questa
  // separazione una sola provincia irraggiungibile azzerava le altre due, che
  // e' esattamente cosa accadeva a CO e VA per colpa di VB.
  const errors = [
    ...(Array.isArray(duties?._errors) ? duties._errors : []),
    ...(Array.isArray(status?._errors) ? status._errors : []),
  ];
  const entries = Object.values(provinces);
  // Una provincia che non dichiara la classe e' `required` (fail-closed).
  const required = entries.filter((entry) => sourcePublicationClass(entry) === 'required');
  // Se il registry non dichiarasse NESSUNA fonte required, ricadiamo su tutte:
  // meglio un rosso che una release verde che non ha verificato niente.
  const deciding = required.length > 0 ? required : entries;
  if (status?._allSourcesFailed === true || deciding.every((entry) => entry.coverage === 'not_published')) return 'not_published';
  if (errors.length > 0 || deciding.some((entry) => entry.state === 'conflicting')) return 'partial';
  if (deciding.some((entry) => entry.freshness === 'stale')) return 'stale';
  if (deciding.some((entry) => entry.coverage !== 'covered' || entry.freshness !== 'fresh')) return 'not_published';
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
  const expectedDutiesHash = sha256ItalyDutyPayload(withoutRelease(duties));
  const expectedStatusHash = sha256ItalyDutyPayload(withoutRelease(status));
  if (dutiesRelease.snapshots?.duties?.sha256 !== expectedDutiesHash
    || statusRelease.snapshots?.duties?.sha256 !== expectedDutiesHash) {
    errors.push('duties payload hash mismatch');
  }
  if (dutiesRelease.snapshots?.status?.sha256 !== expectedStatusHash
    || statusRelease.snapshots?.status?.sha256 !== expectedStatusHash) {
    errors.push('status payload hash mismatch');
  }
  if (canonicalItalyDutyJson({ ...dutiesRelease, releaseId: undefined })
    !== canonicalItalyDutyJson({ ...statusRelease, releaseId: undefined })) {
    errors.push('release metadata differs between duties and status');
  }
  if (canonicalItalyDutyJson({ ...expected, releaseId: undefined })
    !== canonicalItalyDutyJson({ ...statusRelease, releaseId: undefined })) {
    errors.push('status release metadata does not match the payload contract');
  }
  return errors;
}
