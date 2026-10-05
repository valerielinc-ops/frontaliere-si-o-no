#!/usr/bin/env node
/**
 * fetch-canton-tax-data.mjs — dataset fiscale per cantone (pipeline D11 «fisco»).
 *
 * Produce `data/canton-tax/<anno>.json` + `public/data/canton-tax/<anno>.json`
 * + `public/data/canton-tax/latest.json` (alias stabile per i consumatori via
 * HTTP, es. il corpus `refresh-canton-tax.mjs`).
 *
 * Fonti, tutte ufficiali ESTV (dettagli in scripts/lib/estv-tax-statistics.mjs):
 *   1. onere fiscale % nei 26 capoluoghi a 5 redditi lordi, per l'anno del
 *      dataset e i due precedenti (export JSON di swisstaxcalculator.estv.admin.ch);
 *   2. aliquote dell'imposta alla fonte per cantone, lette dai file tariffari
 *      annuali ESTV (record format D_DVS Nr. 0005) a redditi mensili di
 *      riferimento, per i codici tariffari principali (A0, B0, B2, C0, H1 e,
 *      dove esistono, i codici R/S/T/U dei frontalieri italiani GR/TI/VS);
 *   3. pagina dell'imposta alla fonte di ogni amministrazione cantonale, dalla
 *      pagina ESTV che le elenca.
 * Le scadenze della dichiarazione non sono pubblicate in forma strutturata da
 * nessuna fonte ufficiale: il campo resta `null` con la pagina cantonale di
 * riferimento in `deadlinesSource`. Nessun valore e' stimato o inventato.
 *
 * Il file viene riscritto SOLO se il contenuto (escluso `generatedAt`) cambia:
 * il cron settimanale non produce commit vuoti.
 *
 * Una sola verita' per l'onere: `data/swiss-canton-tax-burden.json` (anno di
 * riferimento 2024, letto dai comparatori e dalle pagine salari) resta la copia
 * congelata che l'app usa, ma `tests/canton-tax-data.test.ts` la confronta con
 * la serie storica di questo dataset: se una delle due diverge il test fallisce.
 *
 * Uso:
 *   node scripts/fetch-canton-tax-data.mjs              # anno corrente
 *   node scripts/fetch-canton-tax-data.mjs --year=2026  # anno esplicito
 *   CANTON_TAX_OUT_DIR=/tmp/x node scripts/fetch-canton-tax-data.mjs  # test/dry
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { httpFetchWithRetry } from './lib/transient-fetch.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  ESTV_TAX_BURDEN_TOOL_URL,
  ESTV_WITHHOLDING_AUTHORITIES_PAGE,
  ESTV_WITHHOLDING_RECORD_FORMAT_URL,
  ESTV_WITHHOLDING_TARIFFS_PAGE,
  SWISS_CANTON_CODES,
  TAX_BURDEN_SCENARIO,
  fetchTaxBurdenByCanton,
  findWithholdingArchiveUrl,
  lookupWithholdingRate,
  parseWithholdingAuthorityLinks,
  parseWithholdingTariffFile,
} from './lib/estv-tax-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CANTON_TAX_SCHEMA_VERSION = 1;
/** Stessi 5 redditi lordi annui di data/swiss-canton-tax-burden.json. */
export const BURDEN_INCOMES_CHF = Object.freeze([30000, 60000, 100000, 150000, 250000]);
/** Anni di serie storica dell'onere oltre all'anno del dataset. */
export const BURDEN_HISTORY_YEARS = 2;
/** Redditi lordi MENSILI (le tariffe alla fonte sono sempre mensili). */
export const WITHHOLDING_MONTHLY_INCOMES_CHF = Object.freeze([4000, 6000, 8000, 10000, 15000]);
/**
 * Codici tariffari pubblicati: gruppo + numero figli. La lettera finale
 * (N = senza imposta di culto, Y = con) si sceglie per cantone: N se esiste,
 * altrimenti Y (JU pubblica solo Y), e la scelta e' scritta nel dataset.
 */
export const WITHHOLDING_TARIFF_CODES = Object.freeze(['A0', 'B0', 'B2', 'C0', 'H1', 'R0', 'S0', 'T0', 'U1']);
/** I codici R/S/T/U esistono solo dove si applica l'accordo frontalieri CH-IT. */
export const ITALIAN_CROSS_BORDER_CANTONS = Object.freeze(['GR', 'TI', 'VS']);
/** Soglia di rifiuto: senza almeno questi cantoni con tariffe, il dataset non si scrive. */
export const MIN_WITHHOLDING_CANTONS = 24;
export const MIN_AUTHORITY_LINKS = 24;

function outDirs() {
  const override = process.env.CANTON_TAX_OUT_DIR;
  if (override) {
    return { dataDir: path.join(override, 'data', 'canton-tax'), publicDir: path.join(override, 'public', 'data', 'canton-tax') };
  }
  return { dataDir: path.join(ROOT, 'data', 'canton-tax'), publicDir: path.join(ROOT, 'public', 'data', 'canton-tax') };
}

function parseYearArg(argv) {
  for (const a of argv) {
    const m = /^--year=(\d{4})$/.exec(a);
    if (m) return Number(m[1]);
  }
  return null;
}

async function fetchText(url, label) {
  const res = await httpFetchWithRetry(url, { headers: { 'user-agent': 'frontaliereticino-data/1.0 (+https://frontaliereticino.ch)' } }, { timeout: 60000, label });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} (${url})`);
  return res.text();
}

async function fetchBuffer(url, label) {
  const res = await httpFetchWithRetry(url, { headers: { 'user-agent': 'frontaliereticino-data/1.0 (+https://frontaliereticino.ch)' } }, { timeout: 120000, label });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} (${url})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Archivio ESTV complessivo (`tar<anno>.zip`) → { sigla: testo del file }.
 * L'archivio contiene uno zip per cantone (`tar<aa><c>.zip`) con dentro il txt.
 */
export async function readWithholdingArchive(buffer) {
  const { default: AdmZip } = await import('adm-zip');
  const outer = new AdmZip(buffer);
  const texts = {};
  for (const entry of outer.getEntries()) {
    const m = /^tar\d{2}([a-z]{2})\.zip$/i.exec(path.basename(entry.entryName));
    if (!m) continue;
    const inner = new AdmZip(entry.getData());
    const txt = inner.getEntries().find((e) => /\.txt$/i.test(e.entryName));
    if (!txt) continue;
    texts[m[1].toUpperCase()] = txt.getData().toString('latin1');
  }
  return texts;
}

/** Pura: testi tariffari → blocco `withholding` per cantone (o null). */
export function buildWithholdingByCanton(textsByCanton, { incomes = WITHHOLDING_MONTHLY_INCOMES_CHF, codes = WITHHOLDING_TARIFF_CODES } = {}) {
  const out = {};
  for (const canton of SWISS_CANTON_CODES) {
    const text = textsByCanton[canton];
    if (!text) {
      out[canton] = null;
      continue;
    }
    const wanted = new Set(codes.flatMap((c) => [`${c}N`, `${c}Y`]));
    const parsed = parseWithholdingTariffFile(text, wanted);
    const churchTax = codes.every((c) => !parsed.codes.has(`${c}N`)) ? 'Y' : 'N';
    const ratesPct = {};
    const minTaxCHF = {};
    for (const code of codes) {
      const brackets = parsed.codes.get(`${code}${churchTax}`);
      if (!brackets) continue;
      const looked = incomes.map((inc) => lookupWithholdingRate(brackets, inc));
      if (looked.some((x) => x === null)) continue;
      ratesPct[code] = looked.map((x) => x.ratePct);
      const mins = looked.map((x) => x.minTaxCHF);
      if (mins.some((v) => v > 0)) minTaxCHF[code] = mins;
    }
    out[canton] = Object.keys(ratesPct).length
      ? {
          validFrom: parsed.validFrom,
          fileCreatedOn: parsed.createdOn,
          churchTax,
          ratesPct,
          ...(Object.keys(minTaxCHF).length ? { minTaxCHF } : {}),
        }
      : null;
  }
  return out;
}

/** Pura: assembla il dataset. Nessun I/O. */
export function buildCantonTaxDataset({ year, burdenYears, burden, withholding, authorityLinks, withholdingArchiveUrl, generatedAt }) {
  const cantons = {};
  for (const code of SWISS_CANTON_CODES) {
    const b = burden[code];
    const authorityUrl = authorityLinks[code] || null;
    cantons[code] = {
      capital: b ? { municipality: b.municipality, bfsId: b.bfsId } : null,
      burdenPct: b ? b.byYear : null,
      withholding: withholding[code] || null,
      withholdingSource: authorityUrl || ESTV_WITHHOLDING_TARIFFS_PAGE,
      taxAuthority: { withholdingUrl: authorityUrl },
      deadlines: null,
      deadlinesSource: authorityUrl,
    };
  }
  return {
    schemaVersion: CANTON_TAX_SCHEMA_VERSION,
    year,
    generatedAt,
    sources: [
      {
        id: 'estv-tax-burden',
        publisher: 'Amministrazione federale delle contribuzioni (ESTV/AFC)',
        url: ESTV_TAX_BURDEN_TOOL_URL,
        note: 'Export JSON ufficiale dello strumento «Steuerbelastung», capoluoghi cantonali',
      },
      {
        id: 'estv-withholding-tariffs',
        publisher: 'Amministrazione federale delle contribuzioni (ESTV/AFC)',
        url: withholdingArchiveUrl || ESTV_WITHHOLDING_TARIFFS_PAGE,
        page: ESTV_WITHHOLDING_TARIFFS_PAGE,
        recordFormat: ESTV_WITHHOLDING_RECORD_FORMAT_URL,
        note: 'Tariffe dell\'imposta alla fonte sui salari fornite dai cantoni, file annuali ESTV',
      },
      {
        id: 'estv-withholding-authorities',
        publisher: 'Amministrazione federale delle contribuzioni (ESTV/AFC)',
        url: ESTV_WITHHOLDING_AUTHORITIES_PAGE,
        note: 'Pagina dell\'imposta alla fonte di ogni amministrazione cantonale',
      },
    ],
    burden: {
      scenario: TAX_BURDEN_SCENARIO.description,
      incomeBracketsCHF: [...BURDEN_INCOMES_CHF],
      years: [...burdenYears],
      unit: 'percent of gross annual income',
    },
    withholding: {
      monthlyIncomesCHF: [...WITHHOLDING_MONTHLY_INCOMES_CHF],
      codes: [...WITHHOLDING_TARIFF_CODES],
      unit: 'percent of gross monthly wage subject to withholding',
      codeLegend: {
        A0: 'persona sola senza figli',
        B0: 'coniugato, unico reddito, senza figli',
        B2: 'coniugato, unico reddito, 2 figli',
        C0: 'coniugato, doppio reddito, senza figli',
        H1: 'persona sola con 1 figlio a carico',
        R0: 'frontaliere italiano (accordo 2023, art. 3 cpv. 1) come A0',
        S0: 'frontaliere italiano (accordo 2023) come B0',
        T0: 'frontaliere italiano (accordo 2023) come C0',
        U1: 'frontaliere italiano (accordo 2023) come H1',
      },
      churchTaxLegend: { N: 'senza imposta di culto', Y: 'con imposta di culto (il cantone non pubblica la variante senza)' },
    },
    deadlines: {
      note: 'Nessuna fonte ufficiale pubblica le scadenze della dichiarazione per cantone in forma strutturata: campo null, vedi deadlinesSource di ogni cantone.',
    },
    cantons,
  };
}

/**
 * Validatore del dataset. Le soglie sono il contratto della pipeline: un
 * dataset che non le rispetta non si scrive (e il workflow fallisce).
 */
export function assertCantonTaxDataset(ds, { expectedYear } = {}) {
  const errors = [];
  if (!ds || typeof ds !== 'object') throw new Error('canton-tax: dataset non e\' un oggetto');
  if (ds.schemaVersion !== CANTON_TAX_SCHEMA_VERSION) errors.push(`schemaVersion ${ds.schemaVersion} != ${CANTON_TAX_SCHEMA_VERSION}`);
  if (!Number.isInteger(ds.year)) errors.push('year mancante');
  if (expectedYear && ds.year !== expectedYear) errors.push(`year ${ds.year} != atteso ${expectedYear}`);
  const years = ds.burden?.years || [];
  if (!years.includes(ds.year)) errors.push(`burden.years non contiene l'anno del dataset ${ds.year}`);
  const cantons = ds.cantons || {};
  const missing = SWISS_CANTON_CODES.filter((c) => !cantons[c]);
  if (missing.length) errors.push(`cantoni mancanti: ${missing.join(',')}`);
  let withholdingCount = 0;
  let authorityCount = 0;
  for (const code of SWISS_CANTON_CODES) {
    const c = cantons[code];
    if (!c) continue;
    // Onere: obbligatorio per tutti i 26 cantoni e per ogni anno della serie.
    for (const y of years) {
      const row = c.burdenPct?.[String(y)];
      if (!Array.isArray(row) || row.length !== BURDEN_INCOMES_CHF.length || row.some((v) => !Number.isFinite(v))) {
        errors.push(`${code} ${y}: onere incompleto`);
        continue;
      }
      if (row.some((v) => v <= 0 || v >= 50)) errors.push(`${code} ${y}: onere fuori intervallo (0,50)%: ${row.join(',')}`);
      for (let i = 1; i < row.length; i++) {
        if (row[i] < row[i - 1]) errors.push(`${code} ${y}: onere non crescente col reddito: ${row.join(',')}`);
      }
    }
    if (c.withholding) {
      withholdingCount++;
      for (const [tariff, rates] of Object.entries(c.withholding.ratesPct || {})) {
        if (!Array.isArray(rates) || rates.length !== WITHHOLDING_MONTHLY_INCOMES_CHF.length) {
          errors.push(`${code} ${tariff}: aliquote incomplete`);
          continue;
        }
        if (rates.some((v) => !Number.isFinite(v) || v < 0 || v >= 50)) errors.push(`${code} ${tariff}: aliquota fuori intervallo: ${rates.join(',')}`);
        for (let i = 1; i < rates.length; i++) {
          if (rates[i] < rates[i - 1]) errors.push(`${code} ${tariff}: aliquota non crescente: ${rates.join(',')}`);
        }
      }
      if (!c.withholding.ratesPct?.A0) errors.push(`${code}: tariffa A0 assente`);
      if (ITALIAN_CROSS_BORDER_CANTONS.includes(code) && !c.withholding.ratesPct?.R0) {
        errors.push(`${code}: tariffa R0 (frontalieri italiani) assente`);
      }
    } else if (!c.withholdingSource) {
      errors.push(`${code}: tariffa null senza withholdingSource`);
    }
    if (c.taxAuthority?.withholdingUrl) authorityCount++;
  }
  if (withholdingCount < MIN_WITHHOLDING_CANTONS) {
    errors.push(`tariffe alla fonte solo per ${withholdingCount}/26 cantoni (minimo ${MIN_WITHHOLDING_CANTONS})`);
  }
  if (authorityCount < MIN_AUTHORITY_LINKS) {
    errors.push(`pagine cantonali dell'imposta alla fonte solo per ${authorityCount}/26 (minimo ${MIN_AUTHORITY_LINKS})`);
  }
  if (errors.length) throw new Error(`canton-tax ${ds.year}: dataset rifiutato\n - ${errors.join('\n - ')}`);
  return true;
}

function stripVolatile(ds) {
  const { generatedAt, ...rest } = ds;
  return rest;
}

/**
 * Se il contenuto (escluso generatedAt) e' identico al file canonico gia'
 * presente, eredita il suo generatedAt: cosi' un run senza novita' non tocca
 * nessun file e i mirror restano byte-identici fra loro.
 */
export function carryGeneratedAt(canonicalPath, dataset) {
  try {
    const prev = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
    if (JSON.stringify(stripVolatile(prev)) === JSON.stringify(stripVolatile(dataset))) {
      return { ...dataset, generatedAt: prev.generatedAt };
    }
  } catch {
    /* assente o illeggibile */
  }
  return dataset;
}

/** Scrive solo se il file su disco differisce. */
export function writeIfChanged(filePath, dataset) {
  const content = `${JSON.stringify(dataset, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return false;
  writeJsonAtomic(filePath, dataset);
  return true;
}

async function resolveBurden(targetYear) {
  // In gennaio l'anno nuovo puo' non essere ancora caricato: si prova l'anno
  // richiesto e, solo se ESTV non lo copre per tutti i 26, quello precedente.
  for (const year of [targetYear, targetYear - 1]) {
    const years = [];
    for (let y = year - BURDEN_HISTORY_YEARS; y <= year; y++) years.push(y);
    try {
      const burden = await fetchTaxBurdenByCanton({ years, incomes: [...BURDEN_INCOMES_CHF] });
      const complete = SWISS_CANTON_CODES.every((c) => burden[c]?.byYear?.[String(year)]?.every((v) => Number.isFinite(v)));
      if (complete) return { year, years, burden };
      console.warn(`⚠️ ESTV: onere ${year} incompleto, provo l'anno precedente`);
    } catch (err) {
      console.warn(`⚠️ ESTV: onere ${year} non disponibile (${err.message})`);
    }
  }
  throw new Error(`ESTV: onere fiscale non disponibile ne' per ${targetYear} ne' per ${targetYear - 1}`);
}

export async function main(argv = process.argv.slice(2)) {
  const targetYear = parseYearArg(argv) || new Date().getUTCFullYear();
  const { year, years, burden } = await resolveBurden(targetYear);
  console.log(`✅ ESTV onere fiscale: ${Object.keys(burden).length} capoluoghi, anni ${years.join(',')}`);

  const tariffsPage = await fetchText(ESTV_WITHHOLDING_TARIFFS_PAGE, 'ESTV pagina tariffe alla fonte');
  const archiveUrl = findWithholdingArchiveUrl(tariffsPage, year);
  let withholding = Object.fromEntries(SWISS_CANTON_CODES.map((c) => [c, null]));
  if (archiveUrl) {
    const texts = await readWithholdingArchive(await fetchBuffer(archiveUrl, `ESTV tariffe ${year}`));
    withholding = buildWithholdingByCanton(texts);
    console.log(`✅ ESTV tariffe alla fonte ${year}: ${Object.values(withholding).filter(Boolean).length}/26 cantoni da ${archiveUrl}`);
  } else {
    console.warn(`⚠️ ESTV: nessun archivio tariffe per ${year} sulla pagina ${ESTV_WITHHOLDING_TARIFFS_PAGE}`);
  }

  const authorityLinks = parseWithholdingAuthorityLinks(
    await fetchText(ESTV_WITHHOLDING_AUTHORITIES_PAGE, 'ESTV link autorita\' cantonali'),
  );
  console.log(`✅ ESTV link imposta alla fonte cantonali: ${Object.keys(authorityLinks).length}/26`);

  const dataset = buildCantonTaxDataset({
    year,
    burdenYears: years,
    burden,
    withholding,
    authorityLinks,
    withholdingArchiveUrl: archiveUrl,
    generatedAt: new Date().toISOString(),
  });
  assertCantonTaxDataset(dataset, { expectedYear: year });

  const { dataDir, publicDir } = outDirs();
  const targets = [path.join(dataDir, `${year}.json`), path.join(publicDir, `${year}.json`)];
  // latest.json segue l'anno piu' recente presente, mai uno storico riscaricato.
  const latestPath = path.join(publicDir, 'latest.json');
  let latestYear = null;
  try {
    latestYear = JSON.parse(fs.readFileSync(latestPath, 'utf8')).year;
  } catch {
    /* assente: si scrive */
  }
  if (!latestYear || year >= latestYear) targets.push(latestPath);
  const final = carryGeneratedAt(targets[0], dataset);
  let changed = 0;
  for (const t of targets) if (writeIfChanged(t, final)) changed++;
  console.log(changed ? `✅ canton-tax ${year}: scritti ${changed} file` : `ℹ️ canton-tax ${year}: nessuna variazione`);
  return { year, changed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
