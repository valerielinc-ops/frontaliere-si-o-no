#!/usr/bin/env node
/**
 * fetch-pension-parameters.mjs — parametri previdenziali svizzeri (pipeline
 * D11 «pensioni»).
 *
 * Produce `data/pension-parameters/<anno>.json`,
 * `data/pension-parameters/latest.json` (letto a build time dai componenti
 * del sito tramite services/pensionParameters.ts),
 * `public/data/pension-parameters/<anno>.json` e
 * `public/data/pension-parameters/latest.json` (alias stabile per il corpus
 * via CDN).
 *
 * Contenuto e fonti (dettagli e motivazioni in scripts/lib/swiss-pension-sources.mjs):
 *   federal  rendite AVS minima/massima (promemoria 3.01), contributi AVS/AI/IPG
 *            (2.01), contributo e massimale AD (2.08), soglie LPP e massimali 3a
 *            derivati per legge dalla rendita massima e confrontati con la
 *            pagina UFAS sul 3a, tasso d'interesse minimo LPP (pagina UFAS),
 *            aliquota minima di conversione 6,8% (art. 14 cpv. 2 LPP);
 *   cantons  cassa di compensazione AVS cantonale (elenco ufficiale ahv-iv.ch),
 *            cassa pensioni pubblica del cantone (lista curata e verificata),
 *            imposta sul prelievo di capitale nel capoluogo (ESTV).
 *
 * L'anno del dataset e' quello DICHIARATO dal promemoria 3.01 («Stand am 1.
 * Januar <anno>»), non quello del calendario: il dataset non afferma mai cifre
 * per un anno che la fonte non copre. Il validatore fa fallire il workflow se
 * dopo gennaio l'anno corrente non e' coperto.
 *
 * Uso:
 *   node scripts/fetch-pension-parameters.mjs
 *   PENSION_PARAMETERS_OUT_DIR=/tmp/x node scripts/fetch-pension-parameters.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { httpFetchWithRetry } from './lib/transient-fetch.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  CAPITAL_TAX_SCENARIO,
  DATA_PIPELINE_USER_AGENT,
  ESTV_CAPITAL_TAX_TOOL_URL,
  SWISS_CANTON_CODES,
  fetchCapitalWithdrawalTaxByCanton,
} from './lib/estv-tax-statistics.mjs';
import {
  AHV_IV_CANTONAL_FUNDS_URL,
  AHV_IV_LEAFLETS,
  BSV_OCCUPATIONAL_PENSION_URL,
  BSV_PILLAR_3A_URL,
  CANTONAL_PUBLIC_PENSION_FUNDS,
  CANTONAL_PUBLIC_PENSION_FUNDS_VERIFIED_AT,
  FEDLEX_BVG_URL,
  deriveOccupationalLimits,
  parseCantonalCompensationFunds,
  parseMinimumInterestPage,
  parseOldAgePensionLeaflet,
  parsePillar3aPage,
  parseSalaryContributionsLeaflet,
  parseUnemploymentLeaflet,
} from './lib/swiss-pension-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PENSION_PARAMETERS_SCHEMA_VERSION = 1;
export const CAPITAL_WITHDRAWAL_AMOUNTS_CHF = Object.freeze([100000, 250000, 500000]);
/** Art. 14 cpv. 2 LPP: aliquota minima di conversione nella parte obbligatoria. */
export const LPP_MIN_CONVERSION_RATE_PCT = 6.8;
export const MIN_COMPENSATION_FUNDS = 26;
export const MIN_CAPITAL_TAX_CANTONS = 26;

function outDirs() {
  const override = process.env.PENSION_PARAMETERS_OUT_DIR;
  const root = override || ROOT;
  return {
    dataDir: path.join(root, 'data', 'pension-parameters'),
    publicDir: path.join(root, 'public', 'data', 'pension-parameters'),
  };
}

async function fetchOk(url, label, timeout = 60000) {
  const res = await httpFetchWithRetry(url, { headers: { 'user-agent': DATA_PIPELINE_USER_AGENT } }, { timeout, label });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} (${url})`);
  return res;
}

/**
 * PDF → testo, una riga per linea di base del documento (pdfjs-dist, gia'
 * dipendenza del sito). Le tabelle dei promemoria escono «etichetta valore
 * valore» sulla stessa riga, che e' la forma che i parser si aspettano.
 */
export async function pdfToText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const doc = await task.promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform[5];
      out += lastY !== null && Math.abs(y - lastY) > 2 ? '\n' : ' ';
      out += item.str;
      lastY = y;
    }
    out += '\n';
  }
  await task.destroy();
  return out;
}

async function leafletText(url, label) {
  const res = await fetchOk(url, label);
  return pdfToText(Buffer.from(await res.arrayBuffer()));
}

/** Pura: assembla il blocco federale e lo verifica contro le fonti incrociate. */
export function buildFederalParameters({ pensions, contributions, unemployment, pillar3aPage, minimumInterest }) {
  const derived = deriveOccupationalLimits(pensions.maxMonthly);
  if (derived.pillar3aMaxWithLpp !== pillar3aPage.withLpp || derived.pillar3aMaxWithoutLpp !== pillar3aPage.withoutLpp) {
    throw new Error(
      `massimali 3a derivati (${derived.pillar3aMaxWithLpp}/${derived.pillar3aMaxWithoutLpp}) ` +
        `diversi da quelli UFAS (${pillar3aPage.withLpp}/${pillar3aPage.withoutLpp}): fonti incoerenti, dataset rifiutato`,
    );
  }
  return {
    avs: {
      minMonthlyCHF: pensions.minMonthly,
      maxMonthlyCHF: pensions.maxMonthly,
      maxAnnualCHF: derived.avsMaxAnnual,
      fullContributionYears: 44,
      asOf: pensions.standYear,
      source: AHV_IV_LEAFLETS.oldAgePensions,
    },
    contributions: {
      avsPct: contributions.avsPct,
      aiPct: contributions.aiPct,
      apgPct: contributions.apgPct,
      totalPct: contributions.totalPct,
      employeePct: contributions.employeePct,
      asOf: contributions.standYear,
      source: AHV_IV_LEAFLETS.salaryContributions,
    },
    unemployment: {
      totalPct: unemployment.totalPct,
      employeePct: unemployment.employeePct,
      salaryCapCHF: unemployment.salaryCapCHF,
      asOf: unemployment.standYear,
      source: AHV_IV_LEAFLETS.unemploymentContributions,
    },
    lpp: {
      entryThresholdCHF: derived.lppEntryThreshold,
      coordinationDeductionCHF: derived.lppCoordinationDeduction,
      minCoordinatedSalaryCHF: derived.lppMinCoordinatedSalary,
      maxInsuredSalaryCHF: derived.lppMaxInsuredSalary,
      minInterestRatePct: minimumInterest.ratePct,
      minInterestRateSince: minimumInterest.since,
      minConversionRatePct: LPP_MIN_CONVERSION_RATE_PCT,
      derivation: 'soglie art. 2, 7 e 8 LPP: 3/4, 7/8, 1/8 e 3 volte la rendita AVS massima annua; conversione minima art. 14 cpv. 2 LPP',
      source: FEDLEX_BVG_URL,
      interestSource: BSV_OCCUPATIONAL_PENSION_URL,
    },
    pillar3a: {
      maxWithLppCHF: derived.pillar3aMaxWithLpp,
      maxWithoutLppCHF: derived.pillar3aMaxWithoutLpp,
      derivation: 'art. 7 cpv. 1 OPP3: 8% e 40% del limite superiore LPP',
      source: BSV_PILLAR_3A_URL,
    },
  };
}

/** Pura: assembla il dataset. */
export function buildPensionParametersDataset({ year, federal, compensationFunds, capitalTax, generatedAt }) {
  const cantons = {};
  for (const code of SWISS_CANTON_CODES) {
    const tax = capitalTax[code];
    cantons[code] = {
      compensationFund: compensationFunds[code] ? { name: compensationFunds[code].name, url: compensationFunds[code].url } : null,
      publicPensionFund: CANTONAL_PUBLIC_PENSION_FUNDS[code] || null,
      capitalWithdrawalTax: tax ? { municipality: tax.municipality, bfsId: tax.bfsId, taxCHF: tax.taxCHF } : null,
    };
  }
  return {
    schemaVersion: PENSION_PARAMETERS_SCHEMA_VERSION,
    year,
    generatedAt,
    sources: [
      { id: 'ahv-iv-leaflets', publisher: "Centro d'informazione AVS/AI con l'UFAS", url: AHV_IV_LEAFLETS.oldAgePensions, note: 'Promemoria 3.01, 2.01, 2.08: URL permanenti, anno dichiarato in copertina' },
      { id: 'bsv-pillar-3a', publisher: 'Ufficio federale delle assicurazioni sociali (UFAS/BSV)', url: BSV_PILLAR_3A_URL },
      { id: 'bsv-occupational', publisher: 'Ufficio federale delle assicurazioni sociali (UFAS/BSV)', url: BSV_OCCUPATIONAL_PENSION_URL },
      { id: 'fedlex-bvg', publisher: 'Raccolta sistematica del diritto federale', url: FEDLEX_BVG_URL },
      { id: 'ahv-iv-cantonal-funds', publisher: "Centro d'informazione AVS/AI", url: AHV_IV_CANTONAL_FUNDS_URL },
      { id: 'estv-capital-tax', publisher: 'Amministrazione federale delle contribuzioni (ESTV/AFC)', url: ESTV_CAPITAL_TAX_TOOL_URL },
      { id: 'public-pension-funds', publisher: 'Siti delle casse pensioni cantonali', url: null, note: `Lista curata, verificata il ${CANTONAL_PUBLIC_PENSION_FUNDS_VERIFIED_AT}` },
    ],
    federal,
    capitalWithdrawalTax: {
      scenario: CAPITAL_TAX_SCENARIO.description,
      amountsCHF: [...CAPITAL_WITHDRAWAL_AMOUNTS_CHF],
      year,
    },
    publicPensionFundsVerifiedAt: CANTONAL_PUBLIC_PENSION_FUNDS_VERIFIED_AT,
    cantons,
  };
}

/**
 * Validatore. `now` serve al controllo di copertura dell'anno corrente, che
 * vale dal 1° febbraio: in gennaio i promemoria possono non essere ancora
 * ristampati con il nuovo «Stand».
 */
export function assertPensionParametersDataset(ds, { now = null } = {}) {
  const errors = [];
  if (!ds || typeof ds !== 'object') throw new Error('pension-parameters: dataset non e\' un oggetto');
  if (ds.schemaVersion !== PENSION_PARAMETERS_SCHEMA_VERSION) errors.push(`schemaVersion ${ds.schemaVersion}`);
  const year = ds.year;
  if (!Number.isInteger(year)) errors.push('year mancante');
  const f = ds.federal || {};
  if (f.avs?.asOf !== year) errors.push(`rendite AVS dichiarate per ${f.avs?.asOf}, dataset ${year}`);
  if (!(f.avs?.minMonthlyCHF > 0) || f.avs?.maxMonthlyCHF !== f.avs?.minMonthlyCHF * 2) errors.push('rendite AVS incoerenti');
  if (!(f.avs?.maxMonthlyCHF >= 2000 && f.avs?.maxMonthlyCHF <= 4000)) errors.push(`rendita AVS massima fuori intervallo: ${f.avs?.maxMonthlyCHF}`);
  for (const [k, block] of [['contributi', f.contributions], ['AD', f.unemployment]]) {
    if (!Number.isInteger(block?.asOf) || block.asOf > year || block.asOf < year - 3) {
      errors.push(`${k}: promemoria dell'anno ${block?.asOf}, troppo vecchio o futuro per il ${year}`);
    }
  }
  if (!(f.contributions?.employeePct > 0 && f.contributions?.employeePct < 10)) errors.push('quota AVS/AI/IPG del lavoratore fuori intervallo');
  if (!(f.unemployment?.salaryCapCHF > 100000)) errors.push('massimale AD fuori intervallo');
  const d = deriveOccupationalLimits(f.avs?.maxMonthlyCHF || 0);
  if (f.lpp?.entryThresholdCHF !== d.lppEntryThreshold || f.lpp?.coordinationDeductionCHF !== d.lppCoordinationDeduction || f.lpp?.maxInsuredSalaryCHF !== d.lppMaxInsuredSalary) {
    errors.push('soglie LPP non coerenti con la rendita AVS massima');
  }
  if (f.pillar3a?.maxWithLppCHF !== d.pillar3aMaxWithLpp || f.pillar3a?.maxWithoutLppCHF !== d.pillar3aMaxWithoutLpp) {
    errors.push('massimali 3a non coerenti con la rendita AVS massima');
  }
  if (!(f.lpp?.minInterestRatePct > 0 && f.lpp?.minInterestRatePct < 5)) errors.push('tasso minimo LPP fuori intervallo');
  const cantons = ds.cantons || {};
  const missing = SWISS_CANTON_CODES.filter((c) => !cantons[c]);
  if (missing.length) errors.push(`cantoni mancanti: ${missing.join(',')}`);
  const funds = SWISS_CANTON_CODES.filter((c) => cantons[c]?.compensationFund?.name && /^https:\/\//.test(cantons[c]?.compensationFund?.url || '')).length;
  if (funds < MIN_COMPENSATION_FUNDS) errors.push(`casse di compensazione AVS: ${funds}/26 (minimo ${MIN_COMPENSATION_FUNDS})`);
  let taxes = 0;
  for (const code of SWISS_CANTON_CODES) {
    const t = cantons[code]?.capitalWithdrawalTax?.taxCHF;
    if (!Array.isArray(t)) continue;
    if (t.length !== CAPITAL_WITHDRAWAL_AMOUNTS_CHF.length || t.some((v) => !Number.isFinite(v) || v <= 0)) {
      errors.push(`${code}: imposta sul capitale incompleta`);
      continue;
    }
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= CAPITAL_WITHDRAWAL_AMOUNTS_CHF[i] * 0.25) errors.push(`${code}: imposta sul capitale oltre il 25%: ${t[i]}`);
      if (i > 0 && t[i] < t[i - 1]) errors.push(`${code}: imposta sul capitale non crescente`);
    }
    taxes++;
  }
  if (taxes < MIN_CAPITAL_TAX_CANTONS) errors.push(`imposta sul capitale: ${taxes}/26 (minimo ${MIN_CAPITAL_TAX_CANTONS})`);
  if (now) {
    const calendarYear = now.getUTCFullYear();
    const graceOver = now.getUTCMonth() >= 1; // da febbraio
    if (year > calendarYear) errors.push(`anno ${year} nel futuro`);
    if (year < calendarYear && (graceOver || year < calendarYear - 1)) {
      errors.push(`anno corrente ${calendarYear} non coperto: le fonti dichiarano ancora il ${year}`);
    }
  }
  if (errors.length) throw new Error(`pension-parameters ${year}: dataset rifiutato\n - ${errors.join('\n - ')}`);
  return true;
}

function stripVolatile(ds) {
  const { generatedAt, ...rest } = ds;
  return rest;
}

function carryGeneratedAt(canonicalPath, dataset) {
  try {
    const prev = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
    if (JSON.stringify(stripVolatile(prev)) === JSON.stringify(stripVolatile(dataset))) return { ...dataset, generatedAt: prev.generatedAt };
  } catch {
    /* assente o illeggibile */
  }
  return dataset;
}

function writeIfChanged(filePath, dataset) {
  const content = `${JSON.stringify(dataset, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return false;
  writeJsonAtomic(filePath, dataset);
  return true;
}

export async function main() {
  const [pensionsText, contributionsText, unemploymentText] = await Promise.all([
    leafletText(AHV_IV_LEAFLETS.oldAgePensions, 'promemoria 3.01'),
    leafletText(AHV_IV_LEAFLETS.salaryContributions, 'promemoria 2.01'),
    leafletText(AHV_IV_LEAFLETS.unemploymentContributions, 'promemoria 2.08'),
  ]);
  const pensions = parseOldAgePensionLeaflet(pensionsText);
  if (!pensions.standYear) throw new Error('promemoria 3.01: anno di validita\' («Stand am») non trovato');
  const year = pensions.standYear;
  const federal = buildFederalParameters({
    pensions,
    contributions: parseSalaryContributionsLeaflet(contributionsText),
    unemployment: parseUnemploymentLeaflet(unemploymentText),
    pillar3aPage: parsePillar3aPage(await (await fetchOk(BSV_PILLAR_3A_URL, 'UFAS 3a')).text()),
    minimumInterest: parseMinimumInterestPage(await (await fetchOk(BSV_OCCUPATIONAL_PENSION_URL, 'UFAS LPP')).text()),
  });
  console.log(`✅ parametri federali ${year}: AVS ${federal.avs.minMonthlyCHF}-${federal.avs.maxMonthlyCHF}, LPP soglia ${federal.lpp.entryThresholdCHF}, 3a ${federal.pillar3a.maxWithLppCHF}`);

  const compensationFunds = parseCantonalCompensationFunds(await (await fetchOk(AHV_IV_CANTONAL_FUNDS_URL, 'casse AVS cantonali')).text());
  console.log(`✅ casse di compensazione AVS cantonali: ${Object.keys(compensationFunds).length}/26`);
  const capitalTax = await fetchCapitalWithdrawalTaxByCanton({ year, capitals: [...CAPITAL_WITHDRAWAL_AMOUNTS_CHF] });
  console.log(`✅ ESTV imposta sul prelievo di capitale ${year}: ${Object.keys(capitalTax).length}/26`);

  const dataset = buildPensionParametersDataset({ year, federal, compensationFunds, capitalTax, generatedAt: new Date().toISOString() });
  assertPensionParametersDataset(dataset);

  const { dataDir, publicDir } = outDirs();
  const targets = [path.join(dataDir, `${year}.json`), path.join(publicDir, `${year}.json`)];
  let latestYear = null;
  try {
    latestYear = JSON.parse(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8')).year;
  } catch {
    /* assente */
  }
  if (!latestYear || year >= latestYear) targets.push(path.join(dataDir, 'latest.json'), path.join(publicDir, 'latest.json'));
  const final = carryGeneratedAt(targets[0], dataset);
  let changed = 0;
  for (const t of targets) if (writeIfChanged(t, final)) changed++;
  console.log(changed ? `✅ pension-parameters ${year}: scritti ${changed} file` : `ℹ️ pension-parameters ${year}: nessuna variazione`);
  return { year, changed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
