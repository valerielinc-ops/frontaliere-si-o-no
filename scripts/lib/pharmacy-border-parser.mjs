/**
 * Parsers and normalisers for the cross-border pharmacy catalogue.
 *
 * The catalogue deliberately has two layers of provenance:
 * - the official ministry/cantonal source is the identity and address source;
 * - OpenStreetMap is an optional, ODbL-licensed enrichment for coordinates,
 *   opening hours and a small set of explicitly tagged services.
 *
 * No value is inferred from a neighbouring pharmacy or copied from a
 * directory whose terms prohibit automated reuse.
 */

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const OSM_DAY_NAMES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const OSM_SOURCE_TYPE = 'directory';
const OSM_LICENSE = 'OpenStreetMap contributors, ODbL 1.0';
const TICINO_ADDRESS_OVERRIDES = new Map([
  ['6573|magadino|farmacia-del-gambarogno-sa', {
    address: 'Via Cantonale 94',
    url: 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Elenchi_e_Indirizzi/Farmacie_per_localita_20231204.pdf',
  }],
  ['6760|faido|farmacia-delle-alpi', {
    address: 'Via Fontana di Scribar 2',
    url: 'https://www.faido.ch/index.php?id_item=51&lng=1&node=498&rif=aa5e41b3ae&vis=3',
  }],
]);

export const ITALY_BORDER_PROVINCES = Object.freeze(['CO', 'VA', 'VB']);
export const TICINO_PHARMACY_PDF_URL = 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Elenchi_e_Indirizzi/Lista_Farmacie.pdf';
export const ITALY_PHARMACY_DATASET_PAGE = 'https://www.dati.salute.gov.it/it/dataset/farmacie/';
export const OSM_BORDER_QUERY_BBOX = '45.3,7.0,46.7,10.8';

function text(value) {
  let result = String(value ?? '').trim();
  // The Ministry export occasionally contains UTF-8 decoded as Windows-1252
  // (`Ã¨`, `Â¿`) and uses backticks for apostrophes. Repair that at the input
  // boundary so the public catalogue never exposes the transport artefact.
  if (/[ÃÂ]/.test(result)) {
    const repaired = Buffer.from(result, 'latin1').toString('utf8');
    if (!repaired.includes('\uFFFD')) result = repaired;
  }
  return result
    .replace(/\u0096/g, '–')
    .replace(/\u00bf/g, "'")
    .replace(/`/g, "'")
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function normalizeText(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function slugifyPharmacy(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseItalianDate(value) {
  const raw = text(value);
  if (!raw || raw === '-') return null;
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error(`Invalid Italian validity date: ${raw}`);
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid Italian validity date: ${raw}`);
  }
  return iso;
}

function parseNumber(value) {
  const parsed = Number.parseFloat(text(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function displayName(value) {
  return text(value)
    .toLocaleLowerCase('it-CH')
    .replace(/(^|[\s'’/-])([a-zà-ÿ])/g, (_all, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('it-CH')}`);
}

function normalizeTicinoCity(value) {
  const city = text(value);
  const aliases = new Map([
    ['Morbio Inf.', 'Morbio Inferiore'],
    ['S. Antonino', "Sant'Antonino"],
  ]);
  return aliases.get(city) || city;
}

function stripLocationSuffix(value) {
  return text(value).replace(/\s+\b\d{4}\s{2,}.*$/, '').trim();
}

function isPdfBoundary(line) {
  const value = text(line);
  return !value
    || line.startsWith('\f')
    || /Ufficio del farmacista cantonale|Farmacie aperte al pubblico|^Stato:|^\d{4}\s+Mendrisio/.test(value);
}

function isPdfRecordStart(line) {
  return /^ Farmacia\b/.test(line) && !line.includes('Indirizzo');
}

/**
 * Parses the fixed-width table in the canton PDF after `pdftotext -layout`.
 * The PDF wraps long names/addresses over adjacent lines and repeats its
 * header after each page, hence the explicit boundary handling.
 */
export function parseTicinoPdfText(pdfText) {
  const lines = String(pdfText || '').replace(/\r/g, '').split('\n');
  const starts = lines.map((line, index) => (isPdfRecordStart(line) ? index : -1)).filter((index) => index >= 0);
  const rows = [];
  const warnings = [];

  for (const start of starts) {
    let begin = start;
    const leadingLines = [];
    for (let index = start - 1; index >= 0; index -= 1) {
      if (isPdfRecordStart(lines[index])) {
        // Without a blank/page boundary these lines belong to the preceding
        // wrapped record (the PDF sometimes places two records back to back).
        leadingLines.length = 0;
        break;
      }
      if (isPdfBoundary(lines[index])) {
        if (leadingLines.length) begin = index + 1;
        break;
      }
      leadingLines.unshift(lines[index]);
    }

    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (isPdfBoundary(lines[index]) || isPdfRecordStart(lines[index])) {
        end = index;
        break;
      }
    }

    const recordLines = lines.slice(begin, end);
    let postalCode;
    let city;
    for (const line of recordLines) {
      const location = line.match(/\b(\d{4})\s{2,}(.+?)\s*$/);
      if (location) {
        postalCode = location[1];
        city = normalizeTicinoCity(location[2]);
        break;
      }
    }

    const names = [];
    const addresses = [];
    for (const line of recordLines) {
      const trimmed = text(line);
      if (!trimmed) continue;

      if (/^\s{20,}/.test(line)) {
        const address = line.replace(/\s*\b\d{4}\s{2,}.*$/, '').trim();
        if (address) addresses.push(address);
        continue;
      }

      if (/^\s*Farmacia\b/.test(line)) {
        const parts = trimmed.split(/\s{2,}/);
        names.push(parts[0]);
        const possibleAddress = parts.slice(1)
          .slice(0, parts.slice(1).findIndex((part) => /^\d{4}\b/.test(part)) < 0
            ? parts.length
            : parts.slice(1).findIndex((part) => /^\d{4}\b/.test(part)))
          .map(stripLocationSuffix)
          .filter(Boolean)
          .join(' ');
        if (possibleAddress) addresses.push(possibleAddress);
        continue;
      }

      // Non-indented continuation lines are mostly part of the pharmacy name
      // (e.g. “Ascona”, “SA”, “Figlio”), but the PDF can still put an address
      // continuation in the second fixed-width column on that line.
      const continuation = trimmed.split(/\s{2,}/);
      names.push(continuation[0]);
      if (continuation.length > 1) addresses.push(continuation.slice(1).join(' '));
    }

    const name = names.join(' ').replace(/\s+/g, ' ').trim();
    const address = addresses.join(' ').replace(/\s+/g, ' ').trim();
    if (!name || !postalCode || !city) {
      warnings.push(`record ${start + 1}: missing name, postal code or city`);
      continue;
    }
    rows.push({ name, address, postalCode, city });
  }

  return { rows, warnings };
}

function dayIndexes(dayExpression) {
  const result = new Set();
  for (const part of text(dayExpression).split(',')) {
    const range = part.trim().split(/-|\.\./);
    if (range.length === 2) {
      const from = OSM_DAY_NAMES.indexOf(range[0]);
      const to = OSM_DAY_NAMES.indexOf(range[1]);
      if (from >= 0 && to >= from) {
        for (let index = from; index <= to; index += 1) result.add(index);
      }
      continue;
    }
    const index = OSM_DAY_NAMES.indexOf(range[0]);
    if (index >= 0) result.add(index);
  }
  return [...result];
}

/** Converts the common OSM opening_hours subset into the site's day/interval model. */
export function parseOsmOpeningHours(value) {
  const raw = text(value);
  if (!raw || raw === 'off' || raw === 'closed' || raw === 'unknown') return [];

  const intervals = [];
  const add = (dayIndex, opens, closes) => {
    const item = { dayOfWeek: DAY_NAMES[dayIndex], opens, closes };
    if (!intervals.some((candidate) => candidate.dayOfWeek === item.dayOfWeek && candidate.opens === opens && candidate.closes === closes)) {
      intervals.push(item);
    }
  };
  const addRange = (dayIndex, opens, closes) => {
    const [openHour, openMinute] = opens.split(':').map(Number);
    const [closeHour, closeMinute] = closes.split(':').map(Number);
    const opensAt = openHour * 60 + openMinute;
    const closesAt = closeHour * 60 + closeMinute;
    if (closesAt < opensAt) {
      add(dayIndex, opens, '24:00');
      add((dayIndex + 1) % DAY_NAMES.length, '00:00', closes);
      return;
    }
    add(dayIndex, opens, closes);
  };

  for (const chunk of raw.split(';')) {
    const segment = chunk.trim();
    if (!segment) continue;
    if (segment === '24/7') {
      DAY_NAMES.forEach((_day, index) => add(index, '00:00', '24:00'));
      continue;
    }

    const match = segment.match(/^([A-Z][a-z](?:[-,.][A-Z][a-z])*)\s+(.+)$/);
    if (!match) continue;
    const days = dayIndexes(match[1]);
    const times = [...match[2].matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)];
    if (!times.length) continue;
    for (const day of days) {
      for (const [, opens, closes] of times) addRange(day, opens.padStart(5, '0'), closes.padStart(5, '0'));
    }
  }
  return intervals;
}

function osmUrl(element) {
  return `https://www.openstreetmap.org/${element.type}/${element.id}`;
}

function safeExternalUrl(value) {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function osmRecord(element) {
  const tags = element?.tags || {};
  const latitude = parseNumber(element.lat ?? element.center?.lat);
  const longitude = parseNumber(element.lon ?? element.center?.lon);
  return { element, tags, latitude, longitude };
}

function streetNumber(value) {
  const match = text(value).match(/\b\d+[a-z]?\b/i);
  return match ? match[0].toLowerCase() : '';
}

function streetCore(value) {
  return normalizeText(value)
    .replace(/^(viale|piazza|corso|largo|vicolo|strada|contrada|via)/, '')
    .replace(/\d+[a-z]?/g, '');
}

function sameTicinoLocation(left, right) {
  return text(left.postalCode) === text(right.postalCode) && sameTicinoStreetLocation(left, right);
}

function sameTicinoStreetLocation(left, right) {
  const leftNumber = streetNumber(left.address);
  const rightNumber = streetNumber(right.address);
  const leftStreet = streetCore(left.address);
  const rightStreet = streetCore(right.address);
  return Boolean(
    normalizeText(left.city) === normalizeText(right.city)
    && leftNumber
    && leftNumber === rightNumber
    && leftStreet
    && leftStreet === rightStreet,
  );
}

function meaningfulTokens(value) {
  return new Set(text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !['farmacia', 'farmacie', 'sagl', 'snc', 'dott', 'dr', 'sa', 'e', 'di'].includes(token)));
}

function osmScore(pharmacy, candidate) {
  const tags = candidate.tags;
  let score = 0;
  if (text(pharmacy.postalCode) && text(pharmacy.postalCode) === text(tags['addr:postcode'])) score += 6;
  if (normalizeText(pharmacy.city) && normalizeText(pharmacy.city) === normalizeText(tags['addr:city'])) score += 4;
  if (streetNumber(pharmacy.address) && streetNumber(pharmacy.address) === streetNumber(tags['addr:street'] + ' ' + tags['addr:housenumber'])) score += 5;
  if (tags['addr:street'] && normalizeText(pharmacy.address).includes(normalizeText(tags['addr:street']))) score += 4;
  const pharmacyName = normalizeText(pharmacy.name);
  const osmName = normalizeText(tags.name);
  if (pharmacyName && osmName && (pharmacyName.includes(osmName) || osmName.includes(pharmacyName))) score += 6;
  const osmTokens = meaningfulTokens(tags.name);
  const overlap = [...meaningfulTokens(pharmacy.name)].filter((token) => osmTokens.has(token)).length;
  score += overlap * 3;
  return score;
}

function setFieldSource(record, field, element, checkedAt) {
  record.fieldSources ||= {};
  record.fieldSources[field] = {
    url: osmUrl(element),
    sourceType: OSM_SOURCE_TYPE,
    checkedAt,
    license: OSM_LICENSE,
  };
}

function applyOsmEnrichment(pharmacy, candidates, checkedAt, usedElementKeys = new Set()) {
  const osm = candidates.map(osmRecord).filter((candidate) => candidate.tags.amenity === 'pharmacy');
  let match;
  if (pharmacy.country === 'IT' && pharmacy.ministryId) {
    match = osm.find((candidate) => text(candidate.tags['ref:msal']) === text(pharmacy.ministryId) && !usedElementKeys.has(`${candidate.element.type}/${candidate.element.id}`));
  }
  if (!match) {
    const ranked = osm
      .map((candidate) => ({ candidate, score: osmScore(pharmacy, candidate) }))
      .filter((entry) => entry.score >= (pharmacy.country === 'CH' ? 14 : 12))
      .filter((entry) => !usedElementKeys.has(`${entry.candidate.element.type}/${entry.candidate.element.id}`))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];
    // Do not attach optional fields when two nearby OSM records are equally
    // plausible. An omitted enrichment is safer than a wrong phone or map.
    if (best && (!second || best.score - second.score >= 3)) match = best.candidate;
  }
  if (!match) return pharmacy;
  usedElementKeys.add(`${match.element.type}/${match.element.id}`);

  const tags = match.tags;
  if (pharmacy.country === 'IT' && pharmacy.latitude === undefined && match.latitude !== undefined && match.longitude !== undefined) {
    pharmacy.latitude = match.latitude;
    pharmacy.longitude = match.longitude;
    setFieldSource(pharmacy, 'coordinates', match.element, checkedAt);
  } else if (pharmacy.country === 'CH' && match.latitude !== undefined && match.longitude !== undefined) {
    pharmacy.latitude = match.latitude;
    pharmacy.longitude = match.longitude;
    setFieldSource(pharmacy, 'coordinates', match.element, checkedAt);
  }
  if (!pharmacy.phone && tags.phone) {
    pharmacy.phone = text(tags.phone);
    setFieldSource(pharmacy, 'phone', match.element, checkedAt);
  }
  const website = safeExternalUrl(tags.website);
  if (!pharmacy.website && website) {
    pharmacy.website = website;
    setFieldSource(pharmacy, 'website', match.element, checkedAt);
  }
  const openingHours = parseOsmOpeningHours(tags.opening_hours);
  if (!pharmacy.openingHours?.length && openingHours.length) {
    pharmacy.openingHours = openingHours;
    setFieldSource(pharmacy, 'openingHours', match.element, checkedAt);
  }
  const services = [];
  if (tags.dispensing === 'yes') services.push('Dispensazione di medicinali');
  if (tags.wheelchair === 'yes') services.push('Accesso senza barriere');
  if (tags.delivery === 'yes') services.push('Consegna a domicilio');
  if (!pharmacy.services?.length && services.length) {
    pharmacy.services = services;
    setFieldSource(pharmacy, 'services', match.element, checkedAt);
  }
  return pharmacy;
}

function availability(pharmacy, officialFieldsNotPublished = false) {
  const sourceStatus = (field, value) => value ? 'verified' : (officialFieldsNotPublished ? 'not_published' : 'not_checked');
  return {
    address: sourceStatus('address', pharmacy.address),
    phone: sourceStatus('phone', pharmacy.phone),
    website: sourceStatus('website', pharmacy.website),
    coordinates: sourceStatus('coordinates', pharmacy.latitude !== undefined && pharmacy.longitude !== undefined),
    openingHours: sourceStatus('openingHours', pharmacy.openingHours?.length),
    services: sourceStatus('services', pharmacy.services?.length),
  };
}

function uniqueSlug(base, used) {
  const safe = base || 'farmacia';
  let slug = safe;
  let suffix = 2;
  while (used.has(slug)) slug = `${safe}-${suffix++}`;
  used.add(slug);
  return slug;
}

function isStableSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function italianUrlAliasKey(alias) {
  return `${text(alias.country)}|${text(alias.province).toUpperCase()}|${normalizeText(alias.city)}|${text(alias.slug)}`;
}

function addItalianUrlAlias(aliases, alias, current) {
  if (!alias || alias.country !== 'IT' || !text(alias.province) || !text(alias.city) || !isStableSlug(alias.slug)) return;
  const normalized = {
    country: 'IT',
    province: text(alias.province).toUpperCase(),
    city: text(alias.city),
    slug: alias.slug,
  };
  if (normalized.province === current.province && normalizeText(normalized.city) === normalizeText(current.city) && normalized.slug === current.slug) return;
  const key = italianUrlAliasKey(normalized);
  if (!aliases.some((candidate) => italianUrlAliasKey(candidate) === key)) aliases.push(normalized);
}

export function buildItalianBorderRecords(rawRecords, { fetchedAt, asOf, osmElements = [], datasetUrl = ITALY_PHARMACY_DATASET_PAGE, previous = [] }) {
  const previousByMinistryId = new Map(
    (previous || [])
      .filter((record) => record?.country === 'IT' && text(record.ministryId))
      .map((record) => [text(record.ministryId), record]),
  );
  const candidates = [];
  for (const raw of rawRecords || []) {
    const province = text(raw.sigla_provincia).toUpperCase();
    if (!ITALY_BORDER_PROVINCES.includes(province)) continue;
    const starts = parseItalianDate(raw.data_inizio_validita);
    const ends = parseItalianDate(raw.data_fine_validita);
    if (!starts || starts > asOf || (ends && ends < asOf)) continue;

    const name = text(raw.descrizione_farmacia);
    const city = displayName(raw.comune);
    const ministryId = text(raw.cod_farmacia);
    candidates.push({
      raw,
      province,
      name,
      city,
      ministryId,
      baseSlug: slugifyPharmacy(`${name.slice(0, 90)} ${city} ${ministryId}`),
      previousRecord: previousByMinistryId.get(ministryId),
    });
  }

  // Reserve every previous canonical slug before allocating a slug to a new
  // ministry record. That way a new pharmacy cannot take a still-live slug
  // before the record that owns it gets its stable URL back.
  const reservedSlugs = new Set(
    candidates
      .map(({ previousRecord }) => previousRecord?.slug)
      .filter(isStableSlug),
  );
  const previousSlugOwners = new Map();
  for (const candidate of candidates) {
    const previousSlug = candidate.previousRecord?.slug;
    if (isStableSlug(previousSlug) && !previousSlugOwners.has(previousSlug)) {
      previousSlugOwners.set(previousSlug, candidate.ministryId);
    }
  }

  const usedSlugs = new Set();
  const usedOsmElementKeys = new Set();
  const records = [];
  for (const candidate of candidates) {
    const { raw, province, name, city, ministryId, baseSlug, previousRecord } = candidate;
    const previousSlug = previousRecord?.slug;
    const stableSlug = isStableSlug(previousSlug) && previousSlugOwners.get(previousSlug) === ministryId
      ? previousSlug
      : undefined;
    let slug;
    if (stableSlug && !usedSlugs.has(stableSlug)) {
      usedSlugs.add(stableSlug);
      slug = stableSlug;
    } else {
      let uniqueBase = baseSlug || 'farmacia';
      let suffix = 2;
      while (usedSlugs.has(uniqueBase) || reservedSlugs.has(uniqueBase)) uniqueBase = `${baseSlug || 'farmacia'}-${suffix++}`;
      usedSlugs.add(uniqueBase);
      slug = uniqueBase;
    }
    const urlAliases = [];
    for (const alias of previousRecord?.urlAliases || []) addItalianUrlAlias(urlAliases, alias, { province, city, slug });
    addItalianUrlAlias(urlAliases, {
      country: 'IT',
      province: previousRecord?.province,
      city: previousRecord?.city,
      slug: previousSlug,
    }, { province, city, slug });
    const record = {
      id: `it-msal-${ministryId}`,
      ministryId,
      name,
      slug,
      address: text(raw.indirizzo),
      postalCode: text(raw.cap),
      city,
      country: 'IT',
      province,
      region: displayName(raw.regione),
      latitude: parseNumber(raw.latitudine),
      longitude: parseNumber(raw.longitudine),
      sourceUrl: datasetUrl,
      sourceType: 'official',
      lastVerifiedAt: fetchedAt,
      dataAvailability: {},
      ...(urlAliases.length ? { urlAliases } : {}),
    };
    applyOsmEnrichment(record, osmElements, fetchedAt, usedOsmElementKeys);
    record.dataAvailability = availability(record, true);
    records.push(record);
  }
  return records.sort((a, b) => `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`, 'it'));
}

function matchPreviousTicino(row, previous) {
  const scoreCandidate = (candidate) => {
    let score = 0;
    const address = normalizeText(row.address);
    const candidateAddress = normalizeText(candidate.address);
    const name = normalizeText(row.name);
    const candidateName = normalizeText(candidate.name);
    if (address && candidateAddress && (address.includes(candidateAddress) || candidateAddress.includes(address))) score += 12;
    if (streetCore(row.address) && streetCore(row.address) === streetCore(candidate.address)) score += 8;
    if (name && candidateName && (name.includes(candidateName) || candidateName.includes(name))) score += 8;
    if (streetNumber(row.address) && streetNumber(row.address) === streetNumber(candidate.address)) score += 4;
    return score;
  };
  const sameCity = previous.filter((candidate) => text(candidate.postalCode) === row.postalCode && normalizeText(candidate.city) === normalizeText(row.city));
  const scored = sameCity.map((candidate) => ({ candidate, score: scoreCandidate(candidate) })).sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 8) return scored[0].candidate;

  // Locality names can change in the cantonal feed (e.g. Giubiasco versus
  // Bellinzona) while the same postal address remains the stable identity.
  // Reconcile that case only with an exact street core + house number; never
  // use geographic proximity or a city-name guess as a replacement.
  const sameAddress = previous
    .filter((candidate) => text(candidate.postalCode) === row.postalCode && sameTicinoLocation(row, candidate))
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
    .sort((a, b) => b.score - a.score);
  if (sameAddress[0]?.score >= 12) return sameAddress[0].candidate;

  // A canton can correct a CAP without moving the physical site (the current
  // PDF lists Via Trevano 1 as 6904 while the duty feed still references the
  // previous 6900 record). Exact city/street/house-number identity is a safe
  // reconciliation and keeps already-published duty IDs resolvable.
  const sameStreet = previous
    .filter((candidate) => sameTicinoStreetLocation(row, candidate))
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
    .sort((a, b) => b.score - a.score);
  return sameStreet[0]?.score >= 12 ? sameStreet[0].candidate : undefined;
}

export function buildTicinoCompleteRecords(pdfRows, { previous = [], fetchedAt, osmElements = [], requiredIds = [] }) {
  const usedIds = new Set();
  const usedSlugs = new Set();
  const usedOsmElementKeys = new Set();
  const records = [];
  for (const row of pdfRows || []) {
    const previousRecord = matchPreviousTicino(row, previous);
    const baseSlug = slugifyPharmacy(`${row.name} ${row.city}`);
    const addressOverride = TICINO_ADDRESS_OVERRIDES.get(`${row.postalCode}|${normalizeText(row.city)}|${slugifyPharmacy(row.name)}`);
    const address = row.address || addressOverride?.address || previousRecord?.address || '';
    const idBase = previousRecord?.id || `ti-ofct-${row.postalCode}-${baseSlug}`;
    let id = idBase;
    let idSuffix = 2;
    while (usedIds.has(id)) id = `${idBase}-${idSuffix++}`;
    const slug = uniqueSlug(previousRecord?.slug || baseSlug, usedSlugs);
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const record = {
      id,
      name: row.name,
      slug,
      address,
      postalCode: row.postalCode,
      city: row.city,
      canton: 'Ticino',
      country: 'CH',
      ...(previousRecord?.phone ? { phone: previousRecord.phone } : {}),
      sourceUrl: previousRecord?.sourceUrl || TICINO_PHARMACY_PDF_URL,
      sourceType: 'official',
      lastVerifiedAt: fetchedAt,
      dataAvailability: {},
    };
    if (addressOverride && !row.address) {
      record.fieldSources = { address: { url: addressOverride.url, sourceType: 'official', checkedAt: fetchedAt } };
    }
    applyOsmEnrichment(record, osmElements, fetchedAt, usedOsmElementKeys);
    record.dataAvailability = availability(record, true);
    records.push(record);
  }
  // Duty data is a separate, already-verified source. If the canton PDF
  // changes a name/address between snapshots, retain only the previous
  // records that are still referenced by a published duty, so the duty card
  // never degrades into an unresolved pharmacy id.
  for (const requiredId of requiredIds) {
    if (usedIds.has(requiredId)) continue;
    const previousRecord = previous.find((candidate) => candidate.id === requiredId);
    if (!previousRecord) continue;

    // If the official PDF renamed or regrouped a locality, the current row may
    // already be present under a newly generated id. Transfer the stable duty
    // identity to that exact physical location instead of publishing two
    // cards for one pharmacy.
    const replacement = records.find((candidate) => sameTicinoLocation(candidate, previousRecord) || sameTicinoStreetLocation(candidate, previousRecord));
    if (replacement) {
      usedIds.delete(replacement.id);
      replacement.id = requiredId;
      usedIds.add(requiredId);
      continue;
    }

    const preserved = {
      ...previousRecord,
      dataAvailability: previousRecord.dataAvailability || availability(previousRecord, true),
    };
    applyOsmEnrichment(preserved, osmElements, fetchedAt, usedOsmElementKeys);
    preserved.dataAvailability = availability(preserved, true);
    preserved.slug = uniqueSlug(preserved.slug || slugifyPharmacy(`${preserved.name} ${preserved.city}`), usedSlugs);
    usedIds.add(preserved.id);
    records.push(preserved);
  }
  return records.sort((a, b) => `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`, 'it'));
}

export function buildOsmQuery() {
  return `[out:json][timeout:50];(nwr[amenity=pharmacy](${OSM_BORDER_QUERY_BBOX}););out center tags;`;
}
