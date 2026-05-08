/**
 * BFS cross-border worker statistics — CSV parser.
 *
 * Parses the SDMX REST CSV (DF_GGS_6) and extracts the four chart datasets
 * shown on /statistiche/. Pure-function module: no I/O, no Firestore, no
 * fetch. Same shape as services/statsService.ts so client and cron worker
 * agree on the Firestore document layout.
 *
 * CSV column indices (from header):
 *   0  STRUCTURE
 *   1  STRUCTURE_ID
 *   2  STRUCTURE_NAME
 *   3  ACTION
 *   4  FREQ
 *   5  Frequency of observation
 *   6  WORK_CANTON          ← canton code ("21" = Ticino, "_T" = Total)
 *   7  Swiss cantons
 *   8  SEX                  ← "_T" | "1" male | "2" female
 *   9  Gender
 *  10  AGE_CLASS            ← "_T" | "Y15T19" | …
 *  11  Age groups
 *  12  TIME_PERIOD          ← "2024-Q3"
 *  13  Quartal
 *  14  OBS_VALUE            ← numeric string
 */

const CSV_URL =
  'https://disseminate.stats.swiss/rest/data/CH1.GGS,DF_GGS_6,/all' +
  '?dimensionAtObservation=AllDimensions&format=csvfilewithlabels';

const TICINO = '21';

const COL_CANTON = 6;
const COL_SEX = 8;
const COL_AGE = 10;
const COL_AGE_LABEL = 11;
const COL_PERIOD = 12;
const COL_VALUE = 14;

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(raw) {
  const lines = raw.split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 15) continue;
    const canton = cols[COL_CANTON];
    if (canton !== TICINO) continue;
    const val = parseFloat(cols[COL_VALUE]);
    if (Number.isNaN(val)) continue;
    rows.push({
      canton,
      sex: cols[COL_SEX],
      ageClass: cols[COL_AGE],
      ageLabel: cols[COL_AGE_LABEL],
      period: cols[COL_PERIOD],
      value: Math.round(val),
    });
  }
  return rows;
}

function extractTrend(rows, count = 20) {
  const totals = rows
    .filter((r) => r.sex === '_T' && r.ageClass === '_T')
    .sort((a, b) => a.period.localeCompare(b.period));
  return totals.slice(-count).map((r) => ({ year: r.period, frontalieri: r.value }));
}

function extractAgeDistribution(rows) {
  const totalRows = rows.filter((r) => r.sex === '_T' && r.ageClass === '_T');
  if (totalRows.length === 0) return [];
  const latestPeriod = totalRows.sort((a, b) => b.period.localeCompare(a.period))[0].period;
  const ageRows = rows
    .filter(
      (r) =>
        r.sex === '_T' &&
        r.ageClass !== '_T' &&
        r.ageClass !== '-9' &&
        r.period === latestPeriod,
    )
    .sort((a, b) => a.ageClass.localeCompare(b.ageClass));
  return ageRows.map((r) => ({
    name: r.ageLabel.replace(' years', '').replace(' or older', '+'),
    value: r.value,
  }));
}

function extractGenderTrend(rows, count = 20) {
  const maleMap = new Map();
  const femaleMap = new Map();
  for (const r of rows) {
    if (r.ageClass !== '_T') continue;
    if (r.sex === '1') maleMap.set(r.period, r.value);
    else if (r.sex === '2') femaleMap.set(r.period, r.value);
  }
  const periods = [...new Set([...maleMap.keys(), ...femaleMap.keys()])]
    .sort()
    .slice(-count);
  return periods
    .filter((p) => maleMap.has(p) && femaleMap.has(p))
    .map((p) => ({ year: p, Uomini: maleMap.get(p), Donne: femaleMap.get(p) }));
}

function extractGenderSnapshot(rows) {
  const totalRows = rows.filter((r) => r.sex === '_T' && r.ageClass === '_T');
  if (totalRows.length === 0) return [];
  const latestPeriod = totalRows.sort((a, b) => b.period.localeCompare(a.period))[0].period;
  const male = rows.find((r) => r.sex === '1' && r.ageClass === '_T' && r.period === latestPeriod);
  const female = rows.find((r) => r.sex === '2' && r.ageClass === '_T' && r.period === latestPeriod);
  if (!male || !female) return [];
  const total = male.value + female.value;
  return [
    {
      name: 'Uomini',
      value: male.value,
      pct: ((male.value / total) * 100).toFixed(1),
      color: '#3b82f6',
    },
    {
      name: 'Donne',
      value: female.value,
      pct: ((female.value / total) * 100).toFixed(1),
      color: '#ec4899',
    },
  ];
}

/**
 * Parse CSV text → structured stats datasets + the latest quarter token
 * (e.g. "2026-Q1") which the cron worker uses for new-quarter detection.
 */
export function buildStatsFromCSV(raw) {
  const rows = parseCSV(raw);
  if (rows.length === 0) return null;
  const trend = extractTrend(rows);
  if (trend.length === 0) return null;
  const ages = extractAgeDistribution(rows);
  const genderTrend = extractGenderTrend(rows);
  const genderSnapshot = extractGenderSnapshot(rows);
  const latestQuarter = trend[trend.length - 1].year;
  return { trend, ages, genderTrend, genderSnapshot, latestQuarter };
}

export async function fetchBfsCsv() {
  const res = await fetch(CSV_URL, {
    headers: { 'User-Agent': 'frontaliereticino.ch/refresh-bfs-stats (+admin@frontaliereticino.ch)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`BFS CSV HTTP ${res.status}`);
  return res.text();
}

export const BFS_CSV_URL = CSV_URL;
export const BFS_SOURCE_URL =
  'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi/imprese-addetti/statistica-frontalieri.html';
