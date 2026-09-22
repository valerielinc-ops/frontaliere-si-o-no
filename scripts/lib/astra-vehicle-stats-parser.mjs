/**
 * ASTRA/FEDRO vehicle statistics parser.
 *
 * The public IVZ files are deliberately kept outside the browser: some of
 * them are hundreds of megabytes or several gigabytes.  This module contains
 * only deterministic parsing and aggregation so the scheduled worker and its
 * tests share the same rules.
 */

export const ASTRA_ENDPOINTS = Object.freeze({
  overview:
    "https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html",
  neuzu:
    "https://opendata.astra.admin.ch/ivzod/1000-Fahrzeuge_IVZ/1200-Neuzulassungen/1210-Datensaetze_monatlich/NEUZU.txt",
  weekly:
    "https://opendata.astra.admin.ch/ivzod/1000-Fahrzeuge_IVZ/1200-Neuzulassungen/1220-Neuzlassungsbericht_woechentlich/NEUZU_W.xlsx",
  stnr: "https://opendata.astra.admin.ch/ivzod/1000-Fahrzeuge_IVZ/1200-Neuzulassungen/1230-Stammnummerliste_taeglich/STNR.txt",
  best: "https://opendata.astra.admin.ch/ivzod/1000-Fahrzeuge_IVZ/1300-Fahrzeugbestaende/1320-Datensaetze_monatlich/BEST.txt",
  gebr: "https://opendata.astra.admin.ch/ivzod/1000-Fahrzeuge_IVZ/1500-Gebrauchtimporte/GEBR.txt",
});

export const FUEL_KEYS = Object.freeze([
  "electric",
  "plugInHybrid",
  "hybrid",
  "petrol",
  "diesel",
  "gas",
  "other",
]);

export const SWISS_CANTON_CODES = Object.freeze([
  "AG",
  "AI",
  "AR",
  "BE",
  "BL",
  "BS",
  "FR",
  "GE",
  "GL",
  "GR",
  "JU",
  "LU",
  "NE",
  "NW",
  "OW",
  "SG",
  "SH",
  "SO",
  "SZ",
  "TG",
  "TI",
  "UR",
  "VD",
  "VS",
  "ZG",
  "ZH",
]);

const SWISS_CANTON_SET = new Set(SWISS_CANTON_CODES);

const HEADER_ALIASES = Object.freeze({
  canton: [
    "Inverkehrsetzung_Kanton",
    "Erstinverkehrsetzung_Kanton",
    "Kanton",
    "Première_mise_en_circulation_canton",
  ],
  fuel: ["Treibstoff", "Carburant", "Fuel"],
  hybrid: ["Hybridcode", "Code hybride"],
  co2Wltp: ["CO2-WLTP", "CO2 WLTP", "CO2_WLTP", "CO2-Emissionen WLTP"],
  co2Nefz: ["CO2-NEFZ", "CO2 NEFZ", "CO2_NEFZ", "CO2-Emissionen NEFZ"],
  dataAsOf: ["Datenstand", "État des données", "Etat_des_données"],
  periodStart: ["Neuzulassungen_von", "Nouvelles_immatriculations_de"],
  periodEnd: ["Neuzulassungen_bis", "Nouvelles_immatriculations_à"],
  weight: ["Anzahl Fahrzeuge", "Anzahl_Fahrzeuge", "Nombre de véhicules"],
  week: ["Erstinverkehrsetzung_Woche", "Première_mise_en_circulation_semaine"],
  month: ["Erstinverkehrsetzung_Monat", "Première_mise_en_circulation_mois"],
  year: ["Erstinverkehrsetzung_Jahr", "Première_mise_en_circulation_année"],
});

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseNumber(value) {
  const normalized = normalizeText(value)
    .replace(/['’\s]/g, "")
    .replace(",", ".");
  if (!normalized || /^[-–—n/?]+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function findColumn(headers, aliases) {
  const normalized = new Map(
    headers.map((header, index) => [normalizeHeader(header), index]),
  );
  for (const alias of aliases) {
    const index = normalized.get(normalizeHeader(alias));
    if (index !== undefined) return index;
  }
  return -1;
}

export function parseDelimitedLine(line, delimiter = "\t") {
  const fields = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  fields.push(current);
  return fields;
}

export function canonicalFuel(value, hybridCode = "") {
  const fuel = `${normalizeText(value)} ${normalizeText(hybridCode)}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (!fuel.trim()) return "other";
  if (
    fuel.includes("plug") ||
    fuel.includes("ovc-hev") ||
    fuel.includes("ovc-fchv") ||
    (fuel.includes("hybrid") &&
      (fuel.includes("elektr") || fuel.includes("electric"))) ||
    ((fuel.includes("benzin") ||
      fuel.includes("petrol") ||
      fuel.includes("essence") ||
      fuel.includes("diesel")) &&
      (fuel.includes("elektr") || fuel.includes("electric")))
  ) {
    return "plugInHybrid";
  }
  if (
    fuel.includes("elektr") ||
    fuel.includes("electric") ||
    fuel.includes("bev")
  ) {
    return "electric";
  }
  if (
    fuel.includes("hybrid") ||
    fuel.includes("hev") ||
    fuel.includes("fhev")
  ) {
    return "hybrid";
  }
  if (fuel.includes("diesel") || fuel.includes("gazole")) return "diesel";
  if (
    fuel.includes("benzin") ||
    fuel.includes("petrol") ||
    fuel.includes("essence") ||
    fuel.includes("gasoline")
  ) {
    return "petrol";
  }
  if (
    fuel.includes("gas") ||
    fuel.includes("erdgas") ||
    fuel.includes("cng") ||
    fuel.includes("lng") ||
    fuel.includes("lpg") ||
    fuel.includes("autogas")
  ) {
    return "gas";
  }
  return "other";
}

export function normalizeCanton(value) {
  const canton = normalizeText(value).toUpperCase();
  return SWISS_CANTON_SET.has(canton) ? canton : null;
}

function emptyBucket() {
  return {
    total: 0,
    electric: 0,
    plugInHybrid: 0,
    hybrid: 0,
    petrol: 0,
    diesel: 0,
    gas: 0,
    other: 0,
    co2Sum: 0,
    co2Weight: 0,
  };
}

function addToBucket(bucket, weight, fuel, co2) {
  bucket.total += weight;
  bucket[fuel] += weight;
  if (co2 !== null && co2 >= 0) {
    bucket.co2Sum += co2 * weight;
    bucket.co2Weight += weight;
  }
}

/**
 * @returns {{
 *   total: number,
 *   electric: number,
 *   plugInHybrid: number,
 *   hybrid: number,
 *   petrol: number,
 *   diesel: number,
 *   gas: number,
 *   other: number,
 *   averageCo2: number | null,
 *   fuelMix: Array<{key: string, count: number, share: number}>
 * }}
 */
export function finalizeBucket(bucket) {
  const fuels = Object.fromEntries(
    FUEL_KEYS.map((key) => [key, Math.round(bucket[key] || 0)]),
  );
  const total = Math.round(bucket.total || 0);
  return {
    total,
    ...fuels,
    averageCo2:
      bucket.co2Weight > 0
        ? Math.round((bucket.co2Sum / bucket.co2Weight) * 10) / 10
        : null,
    fuelMix: FUEL_KEYS.map((key) => ({
      key,
      count: fuels[key],
      share: total > 0 ? Math.round((fuels[key] / total) * 1000) / 10 : 0,
    })),
  };
}

function createAccumulator(headers, dataset) {
  const columns = {
    canton: findColumn(headers, HEADER_ALIASES.canton),
    fuel: findColumn(headers, HEADER_ALIASES.fuel),
    hybrid: findColumn(headers, HEADER_ALIASES.hybrid),
    co2Wltp: findColumn(headers, HEADER_ALIASES.co2Wltp),
    co2Nefz: findColumn(headers, HEADER_ALIASES.co2Nefz),
    dataAsOf: findColumn(headers, HEADER_ALIASES.dataAsOf),
    periodStart: findColumn(headers, HEADER_ALIASES.periodStart),
    periodEnd: findColumn(headers, HEADER_ALIASES.periodEnd),
    weight: findColumn(headers, HEADER_ALIASES.weight),
    week: findColumn(headers, HEADER_ALIASES.week),
    month: findColumn(headers, HEADER_ALIASES.month),
    year: findColumn(headers, HEADER_ALIASES.year),
  };
  const national = emptyBucket();
  const byCanton = new Map();
  let sourceRows = 0;
  let dataAsOf = null;
  let periodStart = null;
  let periodEnd = null;
  let latestYear = null;
  let latestWeek = null;

  function addRow(row) {
    if (!row || row.every((value) => !normalizeText(value))) return;
    const explicitWeight =
      columns.weight >= 0 ? parseNumber(row[columns.weight]) : null;
    const weight =
      explicitWeight !== null && explicitWeight > 0 ? explicitWeight : 1;
    const fuel = canonicalFuel(
      columns.fuel >= 0 ? row[columns.fuel] : "",
      columns.hybrid >= 0 ? row[columns.hybrid] : "",
    );
    const co2 =
      (columns.co2Wltp >= 0 ? parseNumber(row[columns.co2Wltp]) : null) ??
      (columns.co2Nefz >= 0 ? parseNumber(row[columns.co2Nefz]) : null);
    const canton =
      columns.canton >= 0 ? normalizeCanton(row[columns.canton]) : null;

    // Datasets with a canton column can contain foreign, unknown or blank
    // canton codes. They must not leak into the Swiss national total: the
    // national figure is deliberately the sum of the 26 Swiss cantons. STNR
    // has no canton column, so its rows remain valid national-only signals.
    if (columns.canton >= 0 && !canton) return;

    addToBucket(national, weight, fuel, co2);
    if (canton) {
      if (!byCanton.has(canton)) byCanton.set(canton, emptyBucket());
      addToBucket(byCanton.get(canton), weight, fuel, co2);
    }

    sourceRows += 1;
    if (
      !dataAsOf &&
      columns.dataAsOf >= 0 &&
      normalizeText(row[columns.dataAsOf])
    ) {
      dataAsOf = normalizeText(row[columns.dataAsOf]);
    }
    if (
      !periodStart &&
      columns.periodStart >= 0 &&
      normalizeText(row[columns.periodStart])
    ) {
      periodStart = normalizeText(row[columns.periodStart]);
    }
    if (
      !periodEnd &&
      columns.periodEnd >= 0 &&
      normalizeText(row[columns.periodEnd])
    ) {
      periodEnd = normalizeText(row[columns.periodEnd]);
    }
    const rowYear = columns.year >= 0 ? parseNumber(row[columns.year]) : null;
    const rowWeek = columns.week >= 0 ? parseNumber(row[columns.week]) : null;
    if (
      rowYear !== null &&
      rowWeek !== null &&
      (latestYear === null ||
        rowYear > latestYear ||
        (rowYear === latestYear && rowWeek > latestWeek))
    ) {
      latestYear = rowYear;
      latestWeek = rowWeek;
    }
  }

  return {
    addRow,
    finish() {
      return {
        dataset,
        sourceRows,
        dataAsOf,
        periodStart,
        periodEnd,
        period:
          latestYear !== null && latestWeek !== null
            ? `${latestYear}-W${String(latestWeek).padStart(2, "0")}`
            : null,
        national: finalizeBucket(national),
        byCanton: Object.fromEntries(
          [...byCanton.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([code, bucket]) => [code, finalizeBucket(bucket)]),
        ),
      };
    },
  };
}

export function aggregateRows(headers, rows, { dataset = "unknown" } = {}) {
  const accumulator = createAccumulator(headers, dataset);
  for (const row of rows) accumulator.addRow(row);
  return accumulator.finish();
}

export function createTsvAccumulator(headers, { dataset = "unknown" } = {}) {
  return createAccumulator(headers, dataset);
}

export function aggregateTsv(raw, { dataset = "unknown" } = {}) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) throw new Error(`ASTRA ${dataset}: missing TSV header`);
  const headers = parseDelimitedLine(lines[headerIndex]);
  const accumulator = createAccumulator(headers, dataset);
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim())
      accumulator.addRow(parseDelimitedLine(lines[index]));
  }
  const result = accumulator.finish();
  if (result.sourceRows === 0)
    throw new Error(`ASTRA ${dataset}: no data rows`);
  return result;
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(attributes, name) {
  const match = String(attributes).match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXmlEntities(match[1]) : "";
}

function columnIndexFromReference(reference) {
  const letters =
    String(reference)
      .match(/^([A-Z]+)/i)?.[1]
      ?.toUpperCase() || "";
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function parseSharedStrings(xml) {
  return String(xml)
    .split("<si>")
    .slice(1)
    .map((chunk) => {
      const body = chunk.split("</si>")[0] || "";
      return [...body.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((match) => decodeXmlEntities(match[1]))
        .join("");
    });
}

function parseXmlRow(rowXml, sharedStrings) {
  const values = [];
  for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attributes = match[1];
    const body = match[2];
    const reference = xmlAttribute(attributes, "r");
    const type = xmlAttribute(attributes, "t");
    const index = columnIndexFromReference(reference);
    const inline = body.match(
      /<is>[\s\S]*?<t(?: [^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/,
    );
    const valueNode = body.match(/<v>([\s\S]*?)<\/v>/);
    let value = "";
    if (inline) value = decodeXmlEntities(inline[1]);
    else if (valueNode) value = decodeXmlEntities(valueNode[1]);
    if (type === "s" && value !== "")
      value = sharedStrings[Number(value)] ?? "";
    values[index] = value;
  }
  return values;
}

/**
 * Parse the public NEUZU_W workbook.  The workbook's `Data` sheet is an
 * already aggregated table (Anzahl Fahrzeuge), so the parser weights each
 * row rather than counting it as one vehicle.
 */
export async function aggregateWeeklyXlsx(buffer, { dataset = "weekly" } = {}) {
  let AdmZip;
  try {
    AdmZip = (await import("adm-zip")).default;
  } catch {
    throw new Error(
      "ASTRA weekly parser requires adm-zip; install the project dependencies",
    );
  }
  const zip = new AdmZip(buffer);
  const sharedStrings = parseSharedStrings(
    zip.readAsText("xl/sharedStrings.xml"),
  );
  const dataXml = zip.readAsText("xl/worksheets/sheet10.xml");
  const rowMatches = dataXml.matchAll(/<row\b[\s\S]*?<\/row>/g);
  let headers = null;
  let accumulator = null;
  for (const match of rowMatches) {
    const row = parseXmlRow(match[0], sharedStrings);
    if (!headers) {
      headers = row;
      accumulator = createAccumulator(headers, dataset);
      continue;
    }
    accumulator.addRow(row);
  }
  if (!accumulator)
    throw new Error("ASTRA weekly workbook: missing Data header");
  const result = accumulator.finish();
  if (result.sourceRows === 0)
    throw new Error("ASTRA weekly workbook: no data rows");
  return result;
}

export function mergePeriods(previous, current, limit = 12) {
  const entries = [
    ...(Array.isArray(previous) ? previous : []),
    ...(current ? [current] : []),
  ].filter(Boolean);
  const unique = new Map();
  for (const entry of entries) {
    const key = entry.period || entry.dataAsOf || entry.label;
    if (key) unique.set(String(key), entry);
  }
  return [...unique.values()].slice(-limit);
}

export function toPeriodToken(value) {
  const text = normalizeText(value);
  const date = text.match(/(\d{4})[./-](\d{1,2})/);
  if (date) return `${date[1]}-${String(date[2]).padStart(2, "0")}`;
  const week = text.match(/(\d{4})[^\d]?W(\d{1,2})/i);
  if (week) return `${week[1]}-W${String(week[2]).padStart(2, "0")}`;
  return text || null;
}
