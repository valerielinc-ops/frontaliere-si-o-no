import fs from 'node:fs/promises';
import sharp from 'sharp';

const MONTHS = new Map([
  ['janvier', 1],
  ['jan.', 1],
  ['janv.', 1],
  ['février', 2],
  ['fevrier', 2],
  ['fév.', 2],
  ['fev.', 2],
  ['févr.', 2],
  ['fevr.', 2],
  ['mars', 3],
  ['avril', 4],
  ['mai', 5],
  ['juin', 6],
  ['juillet', 7],
  ['août', 8],
  ['aout', 8],
  ['septembre', 9],
  ['sept.', 9],
  ['octobre', 10],
  ['oct.', 10],
  ['novembre', 11],
  ['nov.', 11],
  ['décembre', 12],
  ['decembre', 12],
  ['déc.', 12],
  ['dec.', 12],
]);

const JURA_SOURCE_URL = 'https://www.jura.ch/fr/Autorites/Administration/CHA/SIC/Urgences/Numeros-d-urgence-Urgence.html';
const BASEL_STADT_SOURCE_URL = 'https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt';
const ZURICH_SOURCE_URL = 'https://www.avkz.ch/notfalldienst';
const JURA_COVERAGE_NAME = 'Giura';
const BASEL_STADT_COVERAGE_NAME = 'Basilea Città';
const ZURICH_COVERAGE_NAME = 'Zurigo';
const BASEL_STADT_PHARMACY = Object.freeze({
  id: 'bs-24-stunden-apotheke-basel',
  name: '24 Stunden Apotheke Basel AG',
  city: 'Basel',
});
const ZURICH_PHARMACY = Object.freeze({
  id: 'zh-bellevue-apotheke',
  name: 'Bellevue Apotheke',
  city: 'Zürich',
});
const MOUTIER_SOURCE_NAME_BY_COLOUR = Object.freeze({
  blue: { id: 'ju-moutier-centre-migros', name: 'Centre Migros', city: 'Moutier' },
  green: { id: 'ju-moutier-centre-coop', name: 'Centre Coop', city: 'Moutier' },
  red: { id: 'ju-moutier-gare', name: 'Gare', city: 'Moutier' },
});

const AJOIE_IDENTITIES = Object.freeze({
  AMAVITA: { id: 'ju-ajoie-amavita-porrentruy', name: 'Amavita Porrentruy', city: 'Porrentruy' },
  'MILLIET VILLE': { id: 'ju-ajoie-milliet-ville', name: 'Amavita Milliet Ville', city: 'Porrentruy' },
  BENU: { id: 'ju-ajoie-benu-porrentruy', name: 'Benu Porrentruy', city: 'Porrentruy' },
  ERARD: { id: 'ju-ajoie-erard-alle', name: 'Pharmacie Erard', city: 'Alle' },
  NEUKOMM: { id: 'ju-ajoie-neukomm-courgenay', name: 'Pharmacie Neukomm', city: 'Courgenay' },
  'SUN STORE ESPLANADE': { id: 'ju-ajoie-sun-store-esplanade', name: 'Sun Store Esplanade', city: 'Porrentruy' },
  'SST MILLIET GARE': { id: 'ju-ajoie-sun-store-milliet-gare', name: 'Sun Store Milliet Gare', city: 'Porrentruy' },
});

const DELEMONT_IDENTITY_NAMES = Object.freeze([
  'Pharmacie du Jura',
  'Coop Vitality',
  'Benu-Ville',
  'Amavita Delémont',
  'Sun Store Bassecourt',
  'Benu-Gare',
  'Val Terbi',
  'Amavita Pré Guillaume',
  'Sun Store',
  'Voirol',
  'Tilleul',
  'Pharmacie du Centre',
]);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return normalizeWhitespace(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

function normalizeKey(value) {
  return normalizeWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function monthNumber(value) {
  return MONTHS.get(normalizeWhitespace(value).toLocaleLowerCase('fr')) || null;
}

function parseDateParts(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return date.getUTCFullYear() === Number(match[3])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[1])
    ? `${match[3]}-${match[2]}-${match[1]}`
    : null;
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localIso(dateKey, time) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const lastSundayMarch = (() => {
    const value = new Date(Date.UTC(year, 2, 31));
    value.setUTCDate(31 - value.getUTCDay());
    return value.toISOString().slice(0, 10);
  })();
  const lastSundayOctober = (() => {
    const value = new Date(Date.UTC(year, 9, 31));
    value.setUTCDate(31 - value.getUTCDay());
    return value.toISOString().slice(0, 10);
  })();
  const [hour] = String(time).split(':').map(Number);
  const summerTime = (dateKey > lastSundayMarch && dateKey < lastSundayOctober)
    || (dateKey === lastSundayMarch && hour >= 3)
    || (dateKey === lastSundayOctober && hour < 3);
  const offset = summerTime ? '+02:00' : '+01:00';
  return new Date(`${dateKey}T${time}:00${offset}`).toISOString();
}

function identity(id, name, city, sourceUrl, fetchedAt, cantonCode = 'JU', sourceType = 'official') {
  return {
    id,
    name,
    city,
    cantonCode,
    country: 'CH',
    sourceUrl,
    sourceType,
    lastVerifiedAt: fetchedAt,
  };
}

function duty({ id, pharmacy, coverageName, startsAt, endsAt, dutyType = 'weekend', sourceUrl, fetchedAt, sourceType = 'official' }) {
  const expired = Date.parse(endsAt) <= Date.parse(fetchedAt);
  return {
    id,
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    coverageType: 'canton',
    coverageName,
    startsAt,
    endsAt,
    dutyType,
    status: expired ? 'expired' : 'verified',
    sourceUrl,
    sourceType,
    fetchedAt,
    verifiedAt: fetchedAt,
  };
}

function delemontIdentity(name, sourceUrl, fetchedAt) {
  const known = DELEMONT_IDENTITY_NAMES.find((candidate) => normalizeKey(candidate) === normalizeKey(name));
  if (!known) throw new Error(`Delémont pharmacy identity is not allowlisted: ${name}`);
  const cleanName = known;
  const id = `ju-delemont-${normalizeKey(cleanName).toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-')}`;
  return identity(id, cleanName, 'Delémont', sourceUrl, fetchedAt);
}

function identityForAjoie(rawName, sourceUrl, fetchedAt) {
  const key = normalizeKey(rawName).replace(/^SUN STORE\s+/, 'SUN STORE ');
  const sourceIdentity = AJOIE_IDENTITIES[key] || AJOIE_IDENTITIES[normalizeWhitespace(rawName).toLocaleUpperCase('fr')];
  if (!sourceIdentity) throw new Error(`Ajoie pharmacy identity is not allowlisted: ${rawName}`);
  return identity(sourceIdentity.id, sourceIdentity.name, sourceIdentity.city, sourceUrl, fetchedAt);
}

function extractDelemontRows(text, { sourceUrl, fetchedAt, calendarYear = new Date().getUTCFullYear() } = {}) {
  const rows = [];
  const pharmacies = new Map();
  const lines = String(text || '').split(/\r?\n/);
  let previousMonth = null;
  let currentYear = calendarYear;
  for (const line of lines) {
    if (!/\bdu\s+sam\b/i.test(line) || !/\bau\s+sam\b/i.test(line)) continue;
    const match = /^\s*(.+?)\s+du\s+sam\s+(\d{1,2})\s+([^\s]+).*?au\s+sam\s+(\d{1,2})\s+([^\s]+)\s+à8h/i.exec(line);
    if (!match) continue;
    const name = normalizeWhitespace(match[1]);
    const startMonth = monthNumber(match[3]);
    const endMonth = monthNumber(match[5]);
    if (!startMonth || !endMonth) continue;
    if (previousMonth === null && startMonth === 12) currentYear -= 1;
    else if (previousMonth !== null && startMonth < previousMonth) currentYear += 1;
    const startYear = currentYear;
    const endYear = endMonth < startMonth ? startYear + 1 : startYear;
    const startsOn = isoDate(startYear, startMonth, Number(match[2]));
    const endsOn = isoDate(endYear, endMonth, Number(match[4]));
    if (!startsOn || !endsOn) throw new Error(`Invalid Delémont duty interval: ${line}`);
    const pharmacy = delemontIdentity(name, sourceUrl, fetchedAt);
    pharmacies.set(pharmacy.id, pharmacy);
    rows.push(duty({
      id: `ju-delemont-${startsOn}`,
      pharmacy,
      coverageName: 'Delémont',
      startsAt: localIso(startsOn, '08:00'),
      endsAt: localIso(endsOn, '08:00'),
      sourceUrl,
      fetchedAt,
    }));
    previousMonth = startMonth;
  }
  if (rows.length < 52) throw new Error(`Delémont calendar unexpectedly contains only ${rows.length} weekly rows`);
  return { rows, pharmacies: [...pharmacies.values()] };
}

function extractAjoieRows(text, { sourceUrl, fetchedAt } = {}) {
  const rows = [];
  const pharmacies = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const match = /\bdu\s+(\d{2}\.\d{2}\.\d{4})\s+au\s+(\d{2}\.\d{2}\.\d{4})\s+Pharmacie\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const startsOn = parseDateParts(match[1]);
    const endsOn = parseDateParts(match[2]);
    const rawName = normalizeWhitespace(match[3]);
    if (!startsOn || !endsOn || !rawName) throw new Error(`Invalid Ajoie duty interval: ${line}`);
    const pharmacy = identityForAjoie(rawName, sourceUrl, fetchedAt);
    pharmacies.set(pharmacy.id, pharmacy);
    rows.push(duty({
      id: `ju-ajoie-${startsOn}`,
      pharmacy,
      coverageName: 'Ajoie',
      startsAt: localIso(startsOn, '08:00'),
      endsAt: localIso(endsOn, '08:00'),
      sourceUrl,
      fetchedAt,
    }));
  }
  if (rows.length < 45) throw new Error(`Ajoie calendar unexpectedly contains only ${rows.length} weekly rows`);
  return { rows, pharmacies: [...pharmacies.values()] };
}

export function parseBaselStadtDutyPage({ html, sourceUrl, fetchedAt, calendarYear = new Date().getUTCFullYear() } = {}) {
  if (!Number.isInteger(calendarYear)) throw new Error(`Invalid Basel-Stadt calendar year: ${calendarYear}`);
  const cells = [];
  const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = cellPattern.exec(String(html || '')))) cells.push(stripHtml(match[1]));
  const record = cells.find((value) => /24\s+Stunden\s+Apotheke\s+Basel\s+AG/i.test(value));
  if (!record) throw new Error('Basel-Stadt page did not expose the allowlisted 24-hour pharmacy identity');
  if (!/Petersgraben\s+3\b/i.test(record) || !/4051\s+Basel\b/i.test(record)) {
    throw new Error('Basel-Stadt 24-hour pharmacy address changed or is unresolved');
  }
  if (!/Montag\s*-\s*Sonntag\s+24\s+Stunden/i.test(record)) {
    throw new Error('Basel-Stadt page no longer declares Monday-Sunday 24-hour opening');
  }
  if (!/365\s+Tage\s+durchgehend/i.test(record)) {
    throw new Error('Basel-Stadt page no longer declares year-round opening');
  }

  const pharmacy = identity(
    BASEL_STADT_PHARMACY.id,
    BASEL_STADT_PHARMACY.name,
    BASEL_STADT_PHARMACY.city,
    sourceUrl,
    fetchedAt,
    'BS',
  );
  const rows = [];
  const firstDate = `${calendarYear}-01-01`;
  const lastDate = `${calendarYear}-12-31`;
  for (let date = firstDate; date <= lastDate; date = nextDate(date)) {
    const next = nextDate(date);
    rows.push(duty({
      id: `bs-24-stunden-${date}`,
      pharmacy,
      coverageName: BASEL_STADT_COVERAGE_NAME,
      startsAt: localIso(date, '00:00'),
      endsAt: localIso(next, '00:00'),
      dutyType: '24h',
      sourceUrl,
      fetchedAt,
    }));
  }
  return { rows, pharmacies: [pharmacy], coverageName: BASEL_STADT_COVERAGE_NAME };
}

export function parseZurichDutyPage({ html, sourceUrl, fetchedAt, calendarYear = new Date().getUTCFullYear() } = {}) {
  if (!Number.isInteger(calendarYear)) throw new Error(`Invalid Zürich calendar year: ${calendarYear}`);
  const pageText = stripHtml(String(html || ''));
  if (!/Bellevue\s+Apotheke/i.test(pageText)) {
    throw new Error('Zürich page did not expose the allowlisted Bellevue Apotheke identity');
  }
  if (!/Theaterstrasse\s+14\b/i.test(pageText) || !/Bellevue\s+Apotheke[\s\S]*?Zürich/i.test(pageText)) {
    throw new Error('Zürich Bellevue Apotheke address or city changed or is unresolved');
  }
  if (!/täglich\s+24\s+Stunden\s+geöffnet/i.test(pageText)) {
    throw new Error('Zürich page no longer declares daily 24-hour opening');
  }
  if (!/365\s+Tage\s+im\s+Jahr\s+geöffnet/i.test(pageText)) {
    throw new Error('Zürich page no longer declares year-round opening');
  }

  const pharmacy = identity(
    ZURICH_PHARMACY.id,
    ZURICH_PHARMACY.name,
    ZURICH_PHARMACY.city,
    sourceUrl,
    fetchedAt,
    'ZH',
    'association',
  );
  const rows = [];
  const firstDate = `${calendarYear}-01-01`;
  const lastDate = `${calendarYear}-12-31`;
  for (let date = firstDate; date <= lastDate; date = nextDate(date)) {
    const next = nextDate(date);
    rows.push(duty({
      id: `zh-bellevue-${date}`,
      pharmacy,
      coverageName: ZURICH_COVERAGE_NAME,
      startsAt: localIso(date, '00:00'),
      endsAt: localIso(next, '00:00'),
      dutyType: '24h',
      sourceUrl,
      fetchedAt,
      sourceType: 'association',
    }));
  }
  return { rows, pharmacies: [pharmacy], coverageName: ZURICH_COVERAGE_NAME };
}

function numericWordMatches(bboxHtml) {
  const words = [];
  const re = /<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([^<]+)<\/word>/g;
  let match;
  while ((match = re.exec(String(bboxHtml || '')))) {
    const value = match[5].trim();
    if (!/^(?:[1-9]|[12][0-9]|3[01])$/.test(value)) continue;
    const xMin = Number(match[1]);
    const yMin = Number(match[2]);
    if (yMin < 95 || yMin > 780) continue;
    if (!((xMin > 85 && xMin < 280) || (xMin >= 350 && xMin < 570))) continue;
    words.push({ value: Number(value), xMin, yMin, xMax: Number(match[3]), yMax: Number(match[4]) });
  }
  return words;
}

function monthHeaders(bboxHtml) {
  const headers = [];
  const re = /<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([^<]+)<\/word>/g;
  let match;
  while ((match = re.exec(String(bboxHtml || '')))) {
    const month = monthNumber(match[5].trim());
    if (!month) continue;
    headers.push({ month, xMin: Number(match[1]), yMin: Number(match[2]) });
  }
  return headers;
}

function classifyColour(rawPixels) {
  const counts = { red: 0, green: 0, blue: 0 };
  for (let index = 0; index < rawPixels.length; index += 3) {
    const red = rawPixels[index];
    const green = rawPixels[index + 1];
    const blue = rawPixels[index + 2];
    if (red > 130 && red > green * 1.18 && red > blue * 1.15) counts.red += 1;
    else if (green > 90 && green > red * 1.12 && green > blue * 1.02) counts.green += 1;
    else if (blue > 90 && blue > red * 1.05 && blue > green * 1.02) counts.blue += 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [colour, count] = ranked[0];
  return count >= 4 && count > ranked[1][1] ? colour : null;
}

async function colourForWord(word, image) {
  const scaleX = image.info.width / 595;
  const scaleY = image.info.height / 841.5;
  const left = Math.max(0, Math.floor((word.xMin - 2) * scaleX));
  const top = Math.max(0, Math.floor((word.yMin - 2) * scaleY));
  const width = Math.max(1, Math.ceil((word.xMax - word.xMin + 4) * scaleX));
  const height = Math.max(1, Math.ceil((word.yMax - word.yMin + 4) * scaleY));
  const crop = await sharp(image.data, { raw: image.info })
    .extract({ left, top, width: Math.min(width, image.info.width - left), height: Math.min(height, image.info.height - top) })
    .raw()
    .toBuffer();
  return classifyColour(crop);
}

/**
 * Reads the colour-coded Moutier calendar. The PDF is an image scan, but the
 * date glyphs remain in its text layer. We use the text-layer bounding boxes
 * to sample the rendered glyph colour, rather than relying on fixed calendar
 * cell coordinates.
 */
export async function parseMoutierCalendar({ bboxHtml, imagePath, sourceUrl, fetchedAt, calendarYear = new Date().getUTCFullYear() } = {}) {
  const image = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  const headers = monthHeaders(bboxHtml);
  const entries = new Map();
  for (const word of numericWordMatches(bboxHtml)) {
    const side = word.xMin > 300 ? 'right' : 'left';
    const header = headers
      .filter((candidate) => (candidate.xMin > 300 ? 'right' : 'left') === side && candidate.yMin < word.yMin)
      .sort((a, b) => b.yMin - a.yMin)[0];
    if (!header) continue;
    const colour = await colourForWord(word, image);
    if (!colour) throw new Error(`Moutier calendar date ${word.value} has no pharmacy colour`);
    const year = header.month === 1 && header.yMin > 700 ? calendarYear + 1 : calendarYear;
    const dateKey = isoDate(year, header.month, word.value);
    if (!dateKey) continue;
    if (entries.has(dateKey)) throw new Error(`Moutier calendar contains duplicate coloured date: ${dateKey}`);
    entries.set(dateKey, colour);
  }
  const expectedDates = [];
  const firstDate = `${calendarYear}-01-01`;
  const lastDate = `${calendarYear}-12-31`;
  for (let date = firstDate; date <= lastDate; date = nextDate(date)) expectedDates.push(date);
  const missing = expectedDates.filter((date) => !entries.has(date));
  if (missing.length > 0) throw new Error(`Moutier calendar is missing ${missing.length} coloured dates: ${missing.slice(0, 12).join(', ')}`);

  const pharmacies = new Map();
  const rows = [];
  for (const date of expectedDates) {
    const pharmacy = MOUTIER_SOURCE_NAME_BY_COLOUR[entries.get(date)];
    if (!pharmacy) throw new Error(`Moutier calendar has an unsupported colour on ${date}`);
    const resolved = identity(pharmacy.id, pharmacy.name, pharmacy.city, sourceUrl, fetchedAt);
    pharmacies.set(resolved.id, resolved);
    const next = nextDate(date);
    rows.push(duty({
      id: `ju-moutier-night-${date}`,
      pharmacy: resolved,
      coverageName: 'Moutier',
      startsAt: localIso(date, '18:30'),
      endsAt: localIso(next, '08:00'),
      dutyType: 'night',
      sourceUrl,
      fetchedAt,
    }));
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday === 0) {
      rows.push(duty({
        id: `ju-moutier-sunday-morning-${date}`,
        pharmacy: resolved,
        coverageName: 'Moutier',
        startsAt: localIso(date, '10:00'),
        endsAt: localIso(date, '12:00'),
        dutyType: 'weekend',
        sourceUrl,
        fetchedAt,
      }));
      rows.push(duty({
        id: `ju-moutier-sunday-evening-${date}`,
        pharmacy: resolved,
        coverageName: 'Moutier',
        startsAt: localIso(date, '18:30'),
        endsAt: localIso(date, '19:00'),
        dutyType: 'weekend',
        sourceUrl,
        fetchedAt,
      }));
    }
  }
  return { rows, pharmacies: [...pharmacies.values()] };
}

export function parseJuraCalendars({ delemontText, delemontSourceUrl, ajoieText, ajoieSourceUrl, fetchedAt, moutier, calendarYear = new Date().getUTCFullYear() } = {}) {
  const delemont = extractDelemontRows(delemontText, { sourceUrl: delemontSourceUrl, fetchedAt, calendarYear });
  const ajoie = extractAjoieRows(ajoieText, { sourceUrl: ajoieSourceUrl, fetchedAt });
  const rows = [...delemont.rows, ...ajoie.rows, ...(moutier?.rows || [])]
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  const pharmacies = [...new Map([...delemont.pharmacies, ...ajoie.pharmacies, ...(moutier?.pharmacies || [])].map((entry) => [entry.id, entry])).values()];
  return { rows, pharmacies, coverageName: JURA_COVERAGE_NAME };
}

export {
  BASEL_STADT_COVERAGE_NAME,
  BASEL_STADT_PHARMACY,
  BASEL_STADT_SOURCE_URL,
  JURA_COVERAGE_NAME,
  JURA_SOURCE_URL,
  ZURICH_COVERAGE_NAME,
  ZURICH_PHARMACY,
  ZURICH_SOURCE_URL,
  classifyColour,
  extractAjoieRows,
  extractDelemontRows,
  localIso,
};
