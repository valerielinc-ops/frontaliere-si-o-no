#!/usr/bin/env node
/**
 * fetch-health-premiums.mjs — Download official UFSP/BAG health insurance premiums
 * and commune-to-region mappings, producing data/health-premiums/{year}.json.
 *
 * Data sources:
 *   - Praemien_CH.csv from opendata.bagnet.ch (premiums per canton/region/insurer)
 *     Historical archives use Praemien_{YYYY}_CH.csv or the year-parameterised
 *     BAG asset. The script probes known URL shapes and falls back gracefully
 *     when a past-year archive is not available.
 *   - praemienregionen.xlsx from priminfo.admin.ch (commune→region mapping)
 *
 * Output:
 *   - data/health-premiums/{year}.json  ← canonical multi-year storage (F2 A3 YoY)
 *   - public/data/health-premiums/{year}.json  ← runtime comparator mirror
 *   - data/health-premiums.json  ← legacy flat-file alias for the current-year
 *     dataset; preserved to keep pre-F2-A3 consumers (tests, newsletter,
 *     comparator runtime fetch fallback, robots.txt Allow) working without
 *     a breaking change. Written only when --year matches the dataset year.
 *
 * Schema per insurer entry (F2-LAMal real KIN/JUG/ERW data):
 *   {
 *     // Back-compat aliases for AKL-ERW (adults 26+). Older readers that
 *     // inspect `models.standard` etc. keep working without changes.
 *     standard?: number,
 *     hausarzt?: number,
 *     hmo?: number,
 *     telmed?: number,
 *     byAgeClass: {
 *       KIN?: { standard?, hausarzt?, hmo?, telmed? },  // AKL-KIN (0-18), franchise 0
 *       JUG?: { standard?, hausarzt?, hmo?, telmed? },  // AKL-JUG (19-25), franchise 300
 *       ERW?: { standard?, hausarzt?, hmo?, telmed? },  // AKL-ERW (26+), franchise 300
 *     }
 *   }
 *
 * Usage:
 *   node scripts/fetch-health-premiums.mjs             # current year
 *   node scripts/fetch-health-premiums.mjs --year=2025 # historical archive
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Parse CLI args — support --year=YYYY for historical backfill (F2 A3 YoY).
function parseYearArg(argv) {
  for (const a of argv) {
    const m = /^--year=(\d{4})$/.exec(a);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
const TARGET_YEAR = parseYearArg(process.argv.slice(2));
const CURRENT_YEAR = new Date().getUTCFullYear();
const YEAR_FOR_PATHS = TARGET_YEAR ?? CURRENT_YEAR;

const DATA_DIR = path.join(ROOT, 'data', 'health-premiums');
const PUBLIC_DIR = path.join(ROOT, 'public', 'data', 'health-premiums');
const DATA_OUT = path.join(DATA_DIR, `${YEAR_FOR_PATHS}.json`);
const PUBLIC_OUT = path.join(PUBLIC_DIR, `${YEAR_FOR_PATHS}.json`);
// Legacy flat-file paths — written only when the fetched dataset corresponds
// to the current year, so pre-F2-A3 consumers keep resolving the correct data.
const LEGACY_DATA_OUT = path.join(ROOT, 'data', 'health-premiums.json');
const LEGACY_PUBLIC_OUT = path.join(ROOT, 'public', 'data', 'health-premiums.json');

// ── Data source URLs ──
// BAG exposes the current year's Prämien_CH.csv directly. Historical years
// are packaged as `Archiv_Praemien_{year}.zip` on the same FileGator portal.
// Metadata confirms archives from 2011..2025 are all available.
const PREMIUMS_CURRENT_URL = 'https://opendata.bagnet.ch/?r=/download&path=L1ByYWVtaWVuL1Byw6RtaWVuX0NILmNzdg%3D%3D';
function buildHistoricalArchiveUrl(year) {
  // Path shape: `/Praemien/Archiv_Praemien_{year}.zip` (base64-encoded).
  const p = `/Praemien/Archiv_Praemien_${year}.zip`;
  const b64 = Buffer.from(p, 'utf-8').toString('base64').replace(/=/g, '%3D');
  return `https://opendata.bagnet.ch/?r=/download&path=${b64}`;
}
const REGIONS_XLSX_URL = 'https://www.priminfo.admin.ch/downloads/praemienregionen.xlsx';

// ── Insurer ID → name/website mapping (from BAG official list 2026) ──
const INSURER_DIRECTORY = {
  8: { name: 'CSS', website: 'https://www.css.ch' },
  32: { name: 'Aquilana', website: 'https://www.aquilana.ch' },
  134: { name: 'Einsiedler', website: 'https://www.einsiedler-krankenkasse.ch' },
  194: { name: 'Sumiswalder', website: 'https://www.sumiswalder.ch' },
  246: { name: 'Steffisburg', website: 'https://www.kkst.ch' },
  290: { name: 'Concordia', website: 'https://www.concordia.ch' },
  312: { name: 'Atupri', website: 'https://www.atupri.ch' },
  343: { name: 'Avenir', website: 'https://www.groupemutuel.ch' },
  360: { name: 'Luzerner Hinterland', website: 'https://www.luzernerh.ch' },
  376: { name: 'KPT', website: 'https://www.kpt.ch' },
  455: { name: 'ÖKK', website: 'https://www.oekk.ch' },
  509: { name: 'Sympany', website: 'https://www.sympany.ch' },
  780: { name: 'Glarner', website: 'https://www.glarnerkrankenkasse.ch' },
  820: { name: 'Curaulta', website: 'https://www.curaulta.ch' },
  881: { name: 'EGK', website: 'https://www.egk.ch' },
  923: { name: 'SLKK', website: 'https://www.slkk.ch' },
  941: { name: 'Sodalis', website: 'https://www.sodalis.ch' },
  966: { name: 'Vita Surselva', website: 'https://www.vitasurselva.ch' },
  1040: { name: 'Visperterminen', website: 'https://www.kvv-visp.ch' },
  1113: { name: "Vallée d'Entremont", website: 'https://www.groupemutuel.ch' },
  1318: { name: 'Wädenswil', website: 'https://www.kkwaedenswil.ch' },
  1322: { name: 'Birchmeier', website: 'https://www.birchmeier-kk.ch' },
  1384: { name: 'SWICA', website: 'https://www.swica.ch' },
  1386: { name: 'Galenos', website: 'https://www.galenos.ch' },
  1401: { name: 'Rhenusana', website: 'https://www.rhenusana.ch' },
  1479: { name: 'Mutuel', website: 'https://www.groupemutuel.ch' },
  1507: { name: 'AMB', website: 'https://www.groupemutuel.ch' },
  1509: { name: 'Sanitas', website: 'https://www.sanitas.com' },
  1535: { name: 'Philos', website: 'https://www.groupemutuel.ch' },
  1542: { name: 'Assura', website: 'https://www.assura.ch' },
  1555: { name: 'Visana', website: 'https://www.visana.ch' },
  1560: { name: 'Agrisano', website: 'https://www.agrisano.ch' },
  1562: { name: 'Helsana', website: 'https://www.helsana.ch' },
  1568: { name: 'Sana24', website: 'https://www.sana24.ch' },
};

// Tariff type mapping
const TARIFF_TYPE_MAP = {
  'TAR-BASE': 'standard',
  'TAR-HAM': 'hausarzt',
  'TAR-HMO': 'hmo',
  'TAR-DIV': 'telmed', // alternative models (telmed, pharmacy, etc.)
};

// ── BAG risk / age-class mapping ──
// The BAG Praemien_CH.csv "Altersklasse" column uses three codes:
//   - AKL-KIN: Kinder (age 0-18)
//   - AKL-JUG: Junge Erwachsene (age 19-25)
//   - AKL-ERW: Erwachsene (age 26+)
// Under LAMal art. 61 al. 3, children and young-adult premiums are
// insurer-specific (subject to statutory caps); capturing AKL-KIN / AKL-JUG
// alongside AKL-ERW lets downstream consumers show the real per-insurer
// values instead of deriving them via a flat multiplier.
const AGE_CLASS_MAP = {
  'AKL-KIN': 'KIN',
  'AKL-JUG': 'JUG',
  'AKL-ERW': 'ERW',
};

// Base franchise per age class. BAG publishes premiums with every deductible
// the insurer offers for each risk class; we store only the lowest statutory
// deductible, which is FRA-0 for children and FRA-300 for young adults +
// adults. Consumers that need higher deductibles should use the live BAG
// open-data portal or the comparator.
const BASE_FRANCHISE_BY_AGE_CLASS = {
  KIN: 'FRA-0',
  JUG: 'FRA-300',
  ERW: 'FRA-300',
};

// Cantons with commune-level detail
const COMMUNE_DETAIL_CANTONS = ['TI', 'GR', 'VS'];

// ── CSV parser (no dependencies) ──
function parseCSV(text, separator) {
  const lines = text.split('\n');
  // Remove BOM if present
  if (lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
  // Auto-detect separator: 2026 CSV uses comma, 2025 archive uses semicolon.
  if (!separator) {
    const header = lines[0];
    const commaCount = (header.match(/,/g) || []).length;
    const semiCount = (header.match(/;/g) || []).length;
    separator = semiCount > commaCount ? ';' : ',';
  }
  const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

// ── XLSX parser using SheetJS (installed at runtime in CI) ──
async function parseXLSX(buffer, sheetName) {
  let XLSX;
  try {
    XLSX = await import('xlsx');
  } catch {
    console.error('❌ xlsx package not found. Install with: npm install xlsx');
    console.error('   In CI, this is installed automatically.');
    process.exit(1);
  }
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    const available = workbook.SheetNames.join(', ');
    console.error(`❌ Sheet "${sheetName}" not found. Available: ${available}`);
    process.exit(1);
  }
  // The priminfo XLSX has a note in row 1 and bilingual headers in row 2.
  // We skip row 1 and use explicit column mapping based on position.
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  // Find the header row (contains "BFS" or "Kanton")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    const row = raw[i];
    if (row && row.some(cell => String(cell).includes('BFS'))) { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = 1; // default: row 2
  // Map columns by position: BFS-Nr, Kanton, Gemeinde, Region, Bezirk, PLZ, Ort
  const COLUMN_NAMES = ['bfsNr', 'canton', 'commune', 'region', 'district', 'plz', 'locality'];
  const results = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    for (let j = 0; j < COLUMN_NAMES.length && j < row.length; j++) {
      obj[COLUMN_NAMES[j]] = row[j];
    }
    results.push(obj);
  }
  return results;
}

// ── Download helper ──
async function download(url, label) {
  console.log(`📥 Downloading ${label}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${label}: ${res.status} ${res.statusText}`);
  return res;
}

/**
 * Download the Prämien CSV for the requested year. Current year ships as a
 * direct CSV; historical years come packaged in a ZIP archive containing
 * `Prämien_CH.csv`. Returns { csvText, sourceUrl } or throws NoArchiveError.
 */
class NoArchiveError extends Error {
  constructor(year, reason) {
    super(`No BAG archive reachable for year ${year}: ${reason}`);
    this.year = year;
    this.reason = reason;
  }
}

async function fetchPremiumsCsv(targetYear) {
  // Current year or unspecified → direct CSV.
  if (!targetYear || targetYear === CURRENT_YEAR) {
    const res = await download(PREMIUMS_CURRENT_URL, `Prämien_CH.csv (current year ${CURRENT_YEAR})`);
    const csvText = await res.text();
    return { csvText, sourceUrl: PREMIUMS_CURRENT_URL };
  }
  // Historical year → Archiv_Praemien_{year}.zip → extract Prämien_CH.csv.
  const archiveUrl = buildHistoricalArchiveUrl(targetYear);
  let res;
  try {
    res = await fetch(archiveUrl);
  } catch (err) {
    throw new NoArchiveError(targetYear, `network error fetching ${archiveUrl}: ${err.message}`);
  }
  if (!res.ok) {
    throw new NoArchiveError(targetYear, `${archiveUrl} responded ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!/zip/i.test(contentType)) {
    throw new NoArchiveError(targetYear, `unexpected content-type ${contentType} from ${archiveUrl}`);
  }
  const zipBuf = Buffer.from(await res.arrayBuffer());
  console.log(`   ✅ Downloaded archive ZIP (${(zipBuf.length / 1024 / 1024).toFixed(1)} MB)`);

  // Extract Prämien_CH.csv from the ZIP using the JS unzipper. We lazy-load
  // `adm-zip` (small, zero-dep) to avoid a hard dependency on CI bootstrap.
  let AdmZip;
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch {
    throw new NoArchiveError(targetYear, 'adm-zip package not installed — run `npm install adm-zip` to enable historical backfill');
  }
  let zip;
  try {
    zip = new AdmZip(zipBuf);
  } catch (err) {
    throw new NoArchiveError(targetYear, `failed to open ZIP: ${err.message}`);
  }
  const entries = zip.getEntries();
  const csvEntry = entries.find((e) => /Pr[äa]mien_CH\.csv$/i.test(e.entryName));
  if (!csvEntry) {
    throw new NoArchiveError(
      targetYear,
      `no Prämien_CH.csv inside archive (entries: ${entries.map((e) => e.entryName).join(', ')})`,
    );
  }
  // Decode the CSV. Historical BAG archives (observed on 2025) ship in
  // CP1252/Latin1 with ; separator; modern releases are UTF-8 with comma.
  // Inspect the raw bytes first for the UTF-8 BOM or Latin1-encoded "ä"
  // (0xE4) and pick the matching decoder.
  const rawBuf = csvEntry.getData();
  const looksUtf8 =
    (rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf) ||
    /Prämie|Geschäft/.test(rawBuf.slice(0, 512).toString('utf-8'));
  const csvText = looksUtf8
    ? rawBuf.toString('utf-8')
    : new TextDecoder('windows-1252').decode(rawBuf);
  return { csvText, sourceUrl: `${archiveUrl}#${csvEntry.entryName}` };
}

// ── Main ──
async function main() {
  const yearLabel = TARGET_YEAR ? ` (year ${TARGET_YEAR})` : '';
  console.log(`🏥 Fetching health insurance premiums from UFSP/BAG${yearLabel}...\n`);

  // 1. Download premiums CSV (direct for current year, ZIP archive for past).
  let premiumsText;
  let resolvedCsvUrl;
  try {
    const downloaded = await fetchPremiumsCsv(TARGET_YEAR);
    premiumsText = downloaded.csvText;
    resolvedCsvUrl = downloaded.sourceUrl;
  } catch (err) {
    if (err instanceof NoArchiveError) {
      console.error(`❌ ${err.message}`);
      console.error(`\n💡 Graceful degradation: no ${err.year}.json written. YoY rendering will be skipped for this year.`);
      process.exit(2);
    }
    throw err;
  }
  console.log(`   ✅ Loaded premiums CSV from ${resolvedCsvUrl} (${(premiumsText.length / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Download regions XLSX
  const regionsRes = await download(REGIONS_XLSX_URL, 'praemienregionen.xlsx');
  const regionsBuffer = Buffer.from(await regionsRes.arrayBuffer());
  console.log(`   ✅ Downloaded regions XLSX (${(regionsBuffer.length / 1024).toFixed(0)} KB)\n`);

  // 3. Parse premiums CSV
  console.log('📊 Parsing premiums...');
  const allPremiums = parseCSV(premiumsText);
  console.log(`   ${allPremiums.length} total rows`);

  // Filter: capture all 3 risk classes (KIN / JUG / ERW), without accident
  // cover (employer covers UVG for employed insured), and only the CH
  // territory block (excludes expat/abroad residents). We later group by
  // age class and keep the statutory base franchise per class.
  const relevantPremiums = allPremiums.filter(row =>
    AGE_CLASS_MAP[row['Altersklasse']] &&
    row['Unfalleinschluss'] === 'OHN-UNF' &&
    row['Hoheitsgebiet'] === 'CH'
  );
  const countByClass = { KIN: 0, JUG: 0, ERW: 0 };
  for (const row of relevantPremiums) {
    const cls = AGE_CLASS_MAP[row['Altersklasse']];
    if (cls) countByClass[cls]++;
  }
  console.log(`   ${relevantPremiums.length} premiums total (KIN=${countByClass.KIN}, JUG=${countByClass.JUG}, ERW=${countByClass.ERW})`);

  // 4. Parse regions XLSX — sheet A_COM has commune→region mapping
  console.log('📊 Parsing commune regions...');
  const communeRows = await parseXLSX(regionsBuffer, 'A_COM');
  console.log(`   ${communeRows.length} communes found\n`);

  // Build commune → region lookup for TI and GR
  // Sheet A_COM columns vary but typically: BFS-Nr, Kanton, Gemeinde, Region, Bezirk, PLZ, Ort
  const communeRegionMap = new Map(); // key: "canton-bfsNr" → { name, region, plz, bfsNr }
  const communesByCanton = {}; // canton → [{ name, bfsNr, plz, region }]

  for (const row of communeRows) {
    const bfsNr = row.bfsNr;
    const canton = String(row.canton || '');
    const name = String(row.commune || '');
    const region = row.region;
    const plz = String(row.plz || '');
    const ort = String(row.locality || name);

    if (!canton || !bfsNr) continue;

    // Parse region number (might be number or string like "PR-REG CH1")
    let regionNum;
    if (typeof region === 'string' && region.includes('CH')) {
      regionNum = parseInt(region.replace(/.*CH/, ''), 10);
    } else {
      regionNum = parseInt(region, 10);
    }
    if (isNaN(regionNum)) regionNum = 0;

    const key = `${canton}-${bfsNr}`;
    if (!communeRegionMap.has(key)) {
      communeRegionMap.set(key, {
        name, bfsNr: parseInt(bfsNr, 10), canton, plz, ort, region: regionNum,
      });
    }

    if (COMMUNE_DETAIL_CANTONS.includes(canton)) {
      if (!communesByCanton[canton]) communesByCanton[canton] = [];
      const existing = communesByCanton[canton].find(c => c.bfsNr === parseInt(bfsNr, 10));
      if (!existing) {
        communesByCanton[canton].push({
          name, bfsNr: parseInt(bfsNr, 10), plz, region: regionNum,
        });
      }
    }
  }

  console.log(`   TI communes: ${(communesByCanton['TI'] || []).length}`);
  console.log(`   GR communes: ${(communesByCanton['GR'] || []).length}\n`);

  // 5. Build premiums index
  console.log('🔨 Building premiums index...');

  // Group premiums by canton + region + insurer + age class.
  // Structure:
  //   premiumIndex[canton][regionStr][insurerId][ageClass] = { standard, hausarzt, telmed, hmo }
  // We keep only the statutory base franchise per age class (FRA-0 for KIN,
  // FRA-300 for JUG and ERW) to keep the JSON size bounded and comparable
  // across insurers. Consumers needing higher deductibles link to the live
  // comparator.
  const premiumIndex = {};
  const insurersPerCanton = {};

  for (const row of relevantPremiums) {
    const canton = row['Kanton'];
    const regionStr = row['Region']; // e.g. "PR-REG CH1"
    const insurerId = parseInt(row['Versicherer'], 10);
    const tariffType = TARIFF_TYPE_MAP[row['Tariftyp']];
    const ageClass = AGE_CLASS_MAP[row['Altersklasse']];
    const franchise = row['Franchise'];
    const premium = parseFloat(row['Prämie']);

    if (!tariffType || !ageClass || isNaN(premium)) continue;
    // Keep only the statutory base franchise for each risk class.
    if (franchise !== BASE_FRANCHISE_BY_AGE_CLASS[ageClass]) continue;

    if (!premiumIndex[canton]) premiumIndex[canton] = {};
    if (!premiumIndex[canton][regionStr]) premiumIndex[canton][regionStr] = {};
    if (!premiumIndex[canton][regionStr][insurerId]) premiumIndex[canton][regionStr][insurerId] = {};
    if (!premiumIndex[canton][regionStr][insurerId][ageClass]) {
      premiumIndex[canton][regionStr][insurerId][ageClass] = {};
    }

    // Store the cheapest premium for each (age class, model type) pair —
    // some insurers publish multiple tariffs per model (different provider
    // networks or regional sub-products).
    const bucket = premiumIndex[canton][regionStr][insurerId][ageClass];
    const current = bucket[tariffType];
    if (current === undefined || premium < current) {
      bucket[tariffType] = Math.round(premium * 100) / 100;
    }

    // Track insurers per canton (any age class counts).
    if (!insurersPerCanton[canton]) insurersPerCanton[canton] = new Set();
    insurersPerCanton[canton].add(insurerId);
  }

  // 6. Build output JSON
  const output = {
    fetchedAt: new Date().toISOString(),
    year: parseInt(relevantPremiums[0]?.['Geschäftsjahr'] || new Date().getFullYear(), 10),
    insurers: [],
    communes: communesByCanton,
    premiums: {},
    rankings: { cheapest: [], mostExpensive: [] },
  };

  // Insurer list (only those found in data)
  const allInsurerIds = new Set();
  for (const canton of Object.keys(premiumIndex)) {
    for (const id of (insurersPerCanton[canton] || [])) {
      allInsurerIds.add(id);
    }
  }
  for (const id of [...allInsurerIds].sort((a, b) => a - b)) {
    const dir = INSURER_DIRECTORY[id];
    output.insurers.push({
      id: String(id),
      name: dir?.name || `Insurer ${id}`,
      website: dir?.website || '',
    });
  }
  console.log(`   ${output.insurers.length} insurers discovered`);

  // Shape an insurer × age-class tariff map into the on-disk record.
  // Output for each insurer:
  //   {
  //     standard / hausarzt / telmed / hmo   — back-compat aliases for ERW
  //     byAgeClass: {
  //       KIN: { standard, hausarzt, telmed, hmo },
  //       JUG: { standard, hausarzt, telmed, hmo },
  //       ERW: { standard, hausarzt, telmed, hmo },
  //     }
  //   }
  // The flat top-level fields (ERW values) preserve every existing reader
  // that inspects `models.standard` etc.; new readers should consume
  // `models.byAgeClass[ageClass]` to fetch real KIN / JUG values.
  function shapeInsurerEntry(byAgeClass) {
    const out = {};
    const erw = byAgeClass.ERW;
    if (erw) {
      for (const [model, premium] of Object.entries(erw)) {
        out[model] = premium;
      }
    }
    const compact = {};
    for (const cls of ['KIN', 'JUG', 'ERW']) {
      const models = byAgeClass[cls];
      if (!models || Object.keys(models).length === 0) continue;
      compact[cls] = models;
    }
    out.byAgeClass = compact;
    return out;
  }

  // Commune-level premiums for TI, GR, VS.
  for (const canton of COMMUNE_DETAIL_CANTONS) {
    const communes = communesByCanton[canton] || [];
    for (const commune of communes) {
      const regionStr = `PR-REG CH${commune.region}`;
      const regionPremiums = premiumIndex[canton]?.[regionStr];
      if (!regionPremiums) continue;

      const key = `${commune.plz}-${commune.name}`;
      const insurerPremiums = {};
      for (const [insurerId, byAgeClass] of Object.entries(regionPremiums)) {
        insurerPremiums[insurerId] = shapeInsurerEntry(byAgeClass);
      }
      output.premiums[key] = {
        canton,
        region: commune.region,
        bfsNr: commune.bfsNr,
        insurers: insurerPremiums,
      };
    }
  }

  // Canton-level premiums for all other cantons (average across regions).
  // For each insurer we average per (age class, model) tuple independently.
  for (const [canton, regions] of Object.entries(premiumIndex)) {
    if (COMMUNE_DETAIL_CANTONS.includes(canton)) continue;

    const regionEntries = Object.entries(regions);
    // insurerAverages[insurerId][ageClass][model] = { sum, count }
    const insurerAverages = {};

    for (const [, regionPremiums] of regionEntries) {
      for (const [insurerId, byAgeClass] of Object.entries(regionPremiums)) {
        if (!insurerAverages[insurerId]) insurerAverages[insurerId] = {};
        for (const [ageClass, models] of Object.entries(byAgeClass)) {
          if (!insurerAverages[insurerId][ageClass]) insurerAverages[insurerId][ageClass] = {};
          for (const [model, premium] of Object.entries(models)) {
            if (!insurerAverages[insurerId][ageClass][model]) {
              insurerAverages[insurerId][ageClass][model] = { sum: 0, count: 0 };
            }
            insurerAverages[insurerId][ageClass][model].sum += premium;
            insurerAverages[insurerId][ageClass][model].count += 1;
          }
        }
      }
    }

    const insurerPremiums = {};
    for (const [insurerId, byAgeClass] of Object.entries(insurerAverages)) {
      const flattened = {};
      for (const [ageClass, models] of Object.entries(byAgeClass)) {
        flattened[ageClass] = {};
        for (const [model, { sum, count }] of Object.entries(models)) {
          flattened[ageClass][model] = Math.round((sum / count) * 100) / 100;
        }
      }
      insurerPremiums[insurerId] = shapeInsurerEntry(flattened);
    }

    output.premiums[canton] = {
      type: 'canton',
      canton,
      region: null,
      insurers: insurerPremiums,
    };
  }

  // 7. Build rankings (TI + GR communes only, based on average standard premium)
  console.log('📊 Computing rankings...');
  const communeRankings = [];

  for (const [key, data] of Object.entries(output.premiums)) {
    if (data.type === 'canton') continue;
    const standardPremiums = [];
    for (const models of Object.values(data.insurers)) {
      if (models.standard) standardPremiums.push(models.standard);
    }
    if (standardPremiums.length === 0) continue;
    const avgPremium = Math.round(
      (standardPremiums.reduce((s, p) => s + p, 0) / standardPremiums.length) * 100
    ) / 100;
    communeRankings.push({
      municipality: key,
      canton: data.canton,
      bfsNr: data.bfsNr,
      avgPremium,
      numInsurers: standardPremiums.length,
    });
  }

  communeRankings.sort((a, b) => a.avgPremium - b.avgPremium);
  output.rankings.cheapest = communeRankings.slice(0, 20);
  output.rankings.mostExpensive = communeRankings.slice(-20).reverse();

  if (communeRankings.length > 0) {
    console.log(`   Cheapest: ${communeRankings[0].municipality} (CHF ${communeRankings[0].avgPremium})`);
    console.log(`   Most expensive: ${communeRankings[communeRankings.length - 1].municipality} (CHF ${communeRankings[communeRankings.length - 1].avgPremium})`);
  }

  // 8. Write output — canonical multi-year storage under data/health-premiums/.
  //    Resolve the final year from the dataset itself (CSV "Geschäftsjahr"
  //    column) so the written filename matches the actual payload even when
  //    --year was inferred from the default.
  const datasetYear = output.year;
  const resolvedDataOut = path.join(DATA_DIR, `${datasetYear}.json`);
  const resolvedPublicOut = path.join(PUBLIC_DIR, `${datasetYear}.json`);

  const json = JSON.stringify(output, null, 2);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(resolvedDataOut, json);
  console.log(`\n✅ Written ${resolvedDataOut} (${(json.length / 1024).toFixed(0)} KB)`);

  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(resolvedPublicOut, json);
  console.log(`✅ Written ${resolvedPublicOut}`);

  // Legacy flat-file alias — keep pre-F2-A3 consumers working. Only refresh
  // when the dataset corresponds to the *current* calendar year so we never
  // overwrite production data with a historical backfill.
  if (datasetYear === CURRENT_YEAR) {
    fs.writeFileSync(LEGACY_DATA_OUT, json);
    fs.writeFileSync(LEGACY_PUBLIC_OUT, json);
    console.log(`✅ Refreshed legacy aliases ${LEGACY_DATA_OUT} + ${LEGACY_PUBLIC_OUT}`);
  } else {
    console.log(`ℹ️  Skipped legacy alias refresh (dataset year ${datasetYear} ≠ current ${CURRENT_YEAR}).`);
  }

  // Risk-class coverage: percentage of (record × insurer) pairs with an
  // explicit KIN / JUG / ERW block. Useful to detect BAG feed regressions.
  let totalPairs = 0;
  let kinPairs = 0;
  let jugPairs = 0;
  let erwPairs = 0;
  for (const block of Object.values(output.premiums)) {
    for (const entry of Object.values(block.insurers || {})) {
      totalPairs += 1;
      const bac = entry.byAgeClass || {};
      if (bac.KIN && Object.keys(bac.KIN).length > 0) kinPairs += 1;
      if (bac.JUG && Object.keys(bac.JUG).length > 0) jugPairs += 1;
      if (bac.ERW && Object.keys(bac.ERW).length > 0) erwPairs += 1;
    }
  }
  const pct = (n) => totalPairs > 0 ? ((n / totalPairs) * 100).toFixed(1) : '0.0';

  console.log(`\n📋 Summary:`);
  console.log(`   Year: ${output.year}`);
  console.log(`   Insurers: ${output.insurers.length}`);
  console.log(`   Commune entries: ${Object.keys(output.premiums).filter(k => !output.premiums[k].type).length}`);
  console.log(`   Canton entries: ${Object.keys(output.premiums).filter(k => output.premiums[k].type === 'canton').length}`);
  console.log(`   Ranked communes: ${communeRankings.length}`);
  console.log(`   Risk-class coverage: KIN ${pct(kinPairs)}% · JUG ${pct(jugPairs)}% · ERW ${pct(erwPairs)}% (of ${totalPairs} insurer×location pairs)`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
