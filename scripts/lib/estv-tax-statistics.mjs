/**
 * estv-tax-statistics.mjs — client minimo per le statistiche ufficiali ESTV
 * (Amministrazione federale delle contribuzioni) usate dalle pipeline dati
 * per categoria (D11): onere fiscale per cantone e tariffe dell'imposta alla
 * fonte.
 *
 * PERCHE' QUESTE FONTI
 * ────────────────────
 * - Onere fiscale: `swisstaxcalculator.estv.admin.ch` espone l'export JSON
 *   della «Steuerbelastung» che l'interfaccia pubblica usa per il suo pulsante
 *   di esportazione (`/delegate/ost-integration/v1/export/income-tax-values/
 *   JSON/<lingua>`). Nessuna autenticazione, nessun robots.txt (l'host serve la
 *   SPA anche su /robots.txt): e' lo stesso documento che un utente scarica a
 *   mano. Verificato il 2026-10-05: per il 2024 riproduce ESATTAMENTE i valori
 *   di `data/swiss-canton-tax-burden.json`, che erano stati estratti a mano
 *   dallo stesso strumento.
 * - Tariffe alla fonte: ESTV pubblica ogni anno i file strutturati per i
 *   sistemi paghe (record format «D_DVS Nr. 0005», righe a larghezza fissa) su
 *   `www.estv2.admin.ch/qst/...`. La pagina che li elenca e' su
 *   `www.estv.admin.ch` (robots: `Disallow:` vuoto). I link si leggono dalla
 *   pagina invece di cablarli, perche' a fine anno il file corrente migra da
 *   `qst/<anno>/loehne/` a `qst/archiv/`.
 *
 * Il modulo non scrive file e non decide soglie: restituisce dati grezzi
 * normalizzati. Le soglie stanno nel validatore del dataset.
 */

import { httpFetchWithRetry } from './transient-fetch.mjs';
import { ALL_CANTON_CODES } from './crawler-location-config.mjs';

export const ESTV_TAX_CALCULATOR_BASE = 'https://swisstaxcalculator.estv.admin.ch';
export const ESTV_TAX_BURDEN_EXPORT_URL = `${ESTV_TAX_CALCULATOR_BASE}/delegate/ost-integration/v1/export/income-tax-values/JSON/DE`;
export const ESTV_TAX_BURDEN_TOOL_URL = `${ESTV_TAX_CALCULATOR_BASE}/#/taxburden/income-wealth-tax`;
export const ESTV_WITHHOLDING_TARIFFS_PAGE = 'https://www.estv.admin.ch/de/quellensteuertarife-import-in-lohnbuchhaltungssysteme';
export const ESTV_WITHHOLDING_AUTHORITIES_PAGE = 'https://www.estv.admin.ch/de/quellensteuer-links-zu-den-kantonalen-behoerden';
export const ESTV_WITHHOLDING_RECORD_FORMAT_URL =
  'https://www.estv.admin.ch/dam/de/sd-web/AvojuyFCZY95/qst-tarife-recordformate-loehne-2025-de.pdf';

/**
 * I 26 cantoni. Riusa l'elenco canonico degli script (nessuna terza copia
 * letterale: AGENTS.md #6), ordinato alfabeticamente come i file ESTV.
 */
export const SWISS_CANTON_CODES = Object.freeze([...ALL_CANTON_CODES].sort());

/**
 * Nomi tedeschi usati da ESTV nella pagina dei link alle autorita' cantonali
 * (testo dell'ancora) → sigla. La pagina e' in tedesco; una voce non mappata
 * fa fallire il parse invece di essere ignorata in silenzio.
 */
export const ESTV_GERMAN_CANTON_NAMES = Object.freeze({
  Aargau: 'AG',
  'Appenzell Ausserrhoden': 'AR',
  'Appenzell Innerrhoden': 'AI',
  'Basel-Land': 'BL',
  'Basel-Landschaft': 'BL',
  'Basel-Stadt': 'BS',
  Bern: 'BE',
  Freiburg: 'FR',
  Genf: 'GE',
  Glarus: 'GL',
  'Graubünden': 'GR',
  Jura: 'JU',
  Luzern: 'LU',
  Neuenburg: 'NE',
  Nidwalden: 'NW',
  Obwalden: 'OW',
  'Sankt Gallen': 'SG',
  'St. Gallen': 'SG',
  Schaffhausen: 'SH',
  Schwyz: 'SZ',
  Solothurn: 'SO',
  Tessin: 'TI',
  Thurgau: 'TG',
  Uri: 'UR',
  Waadt: 'VD',
  Wallis: 'VS',
  Zug: 'ZG',
  'Zürich': 'ZH',
});

/**
 * Scenario dell'onere fiscale: lo stesso di `data/swiss-canton-tax-burden.json`
 * (celibe/nubile senza figli, nessuna confessione, capoluogo cantonale, imposta
 * sul reddito in % del reddito lordo). I codici numerici sono gli enum della SPA
 * ESTV: massExportModelId 1 = SINGLE_WITHOUT_CHILDREN, taxGroup 88 =
 * MAIN_PLACES_OF_THE_CANTONS, confession 4 = NO_CONFESSION, klasse 1 = INCOME,
 * belastungsVergleich 1 = TIME_COMPARISON_MULTI_YEAR, output 2 =
 * TOTAL_TAX_IN_PERCENTAGE.
 */
export const TAX_BURDEN_SCENARIO = Object.freeze({
  massExportModelId: 1,
  taxGroup: 88,
  confession: 4,
  klasse: 1,
  belastungsVergleich: 1,
  output: 2,
  description:
    'Persona sola senza figli, nessuna confessione (niente imposta di culto), capoluogo cantonale, ' +
    'onere totale (federale + cantonale + comunale + imposta personale) in % del reddito lordo da lavoro',
});

/** User-Agent dichiarato di tutte le pipeline dati ufficiali (nessun UA camuffato, D10). */
export const DATA_PIPELINE_USER_AGENT = 'frontaliereticino-data/1.0 (+https://frontaliereticino.ch)';

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': DATA_PIPELINE_USER_AGENT,
};

async function readOk(res, label) {
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res;
}

/**
 * Onere fiscale % per capoluogo cantonale, per piu' anni in una sola richiesta.
 *
 * @returns {Promise<Record<string, {municipality: string, bfsId: number, byYear: Record<string, number[]>}>>}
 *   per sigla: valori nell'ordine di `incomes`, uno per anno.
 */
export async function fetchTaxBurdenByCanton({ years, incomes, fetchImpl } = {}) {
  const body = {
    massExportModelId: TAX_BURDEN_SCENARIO.massExportModelId,
    belastungsVergleich: TAX_BURDEN_SCENARIO.belastungsVergleich,
    taxGroup: TAX_BURDEN_SCENARIO.taxGroup,
    confession: TAX_BURDEN_SCENARIO.confession,
    incomes,
    fortunes: [],
    klasse: TAX_BURDEN_SCENARIO.klasse,
    simKey: null,
    simName: null,
    years,
    output: TAX_BURDEN_SCENARIO.output,
    considerMaximumExposureLimit: false,
    investmentIncome: null,
  };
  const doFetch = fetchImpl || ((url, init) => httpFetchWithRetry(url, init, { timeout: 60000, label: 'ESTV tax burden' }));
  const res = await readOk(
    await doFetch(ESTV_TAX_BURDEN_EXPORT_URL, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
    'ESTV tax burden export',
  );
  const json = await res.json();
  return parseTaxBurdenExport(json, { years, incomes });
}

/** Pura: trasforma l'export ESTV in { sigla: { municipality, bfsId, byYear } }. */
export function parseTaxBurdenExport(json, { years, incomes }) {
  const payload = Array.isArray(json?.payload) ? json.payload : null;
  if (!payload) throw new Error('ESTV tax burden export: payload[] mancante');
  const out = {};
  for (const row of payload) {
    const code = String(row?.canton || '').toUpperCase();
    if (!SWISS_CANTON_CODES.includes(code)) continue;
    const incomeIndex = incomes.indexOf(Number(row.income));
    if (incomeIndex < 0) continue;
    if (!Array.isArray(row.values) || row.values.length !== years.length) {
      throw new Error(`ESTV tax burden export: ${code} ${row.income} ha ${row.values?.length} valori per ${years.length} anni`);
    }
    const entry = (out[code] ||= {
      municipality: String(row.municipality || ''),
      bfsId: Number(row.bfsId) || null,
      byYear: Object.fromEntries(years.map((y) => [String(y), new Array(incomes.length).fill(null)])),
    });
    years.forEach((year, i) => {
      const slot = entry.byYear[String(year)];
      // Una sola riga per (cantone, reddito): un duplicato vuol dire che il
      // formato dell'export e' cambiato, e scegliere in silenzio l'ultima
      // riga pubblicherebbe un numero non verificato.
      if (slot[incomeIndex] !== null) throw new Error(`ESTV tax burden export: riga duplicata ${code} ${row.income} ${year}`);
      const v = Number(row.values[i]);
      slot[incomeIndex] = Number.isFinite(v) ? round2(v) : NaN;
    });
  }
  return out;
}

/**
 * Arrotondamento a 2 decimali sul valore binario ESATTO, con pareggio al pari
 * (lo stesso di `round(x, 2)` in Python, con cui fu estratto a mano
 * `data/swiss-canton-tax-burden.json`). `Math.round(x * 100) / 100` non va:
 * 10.475 (binario 10.47499…) diventa 1047.5 dopo la moltiplicazione e sale a
 * 10.48, e 3.125 (pareggio esatto) sale a 3.13 invece di 3.12 — due scarti
 * misurati su AR e ZG contro il dataset 2024.
 */
export function round2(value) {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1n : 1n;
  const [intPart, frac] = Math.abs(value).toFixed(30).split('.');
  let cents = BigInt(intPart + frac.slice(0, 2));
  const rest = frac.slice(2);
  const half = `5${'0'.repeat(rest.length - 1)}`;
  if (rest > half || (rest === half && cents % 2n === 1n)) cents += 1n;
  return Number(sign * cents) / 100;
}

/**
 * Legge dalla pagina ESTV l'URL dell'archivio complessivo delle tariffe alla
 * fonte (salari) per `year`: `qst/<year>/loehne/tar<year>.zip` finche' e'
 * l'anno corrente, `qst/archiv/tar<year>.zip` dopo.
 */
export function findWithholdingArchiveUrl(html, year) {
  const re = new RegExp(`href="(https://www\\.estv2\\.admin\\.ch/qst/(?:${year}/loehne|archiv)/tar${year}\\.zip)"`, 'g');
  const urls = [...String(html).matchAll(re)].map((m) => m[1]);
  return urls[0] || null;
}

/**
 * Pagina ESTV «Quellensteuer: Links zu den kantonalen Behörden» → sigla → URL
 * della pagina cantonale sull'imposta alla fonte.
 */
export function parseWithholdingAuthorityLinks(html) {
  const out = {};
  const re = /<a [^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of String(html).matchAll(re)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const code = ESTV_GERMAN_CANTON_NAMES[text];
    if (code && !out[code]) out[code] = m[1];
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Parser del file tariffario ESTV (record format D_DVS Nr. 0005, ab 2025).
 * Recordart 06 = tariffa progressiva:
 *   pos 1-2 recordart, 3-4 transazione, 5-6 cantone, 7-16 codice tariffa
 *   (es. `A0N`), 17-24 valido dal (AAAAMMGG), 25-33 reddito imponibile mensile
 *   da (centesimi), 34-42 gradino (centesimi), 44-45 figli, 46-54 imposta minima
 *   (centesimi), 55-59 aliquota (centesimi di punto percentuale).
 * Le righe 00 portano la data di creazione del file.
 *
 * @param {string} text contenuto del file `tar<aa><cantone>.txt`
 * @param {Set<string>} [wantedCodes] codici completi (es. `A0N`) da indicizzare
 * @returns {{ canton: string|null, createdOn: string|null, validFrom: string|null, codes: Map<string, Array<{from:number, to:number, minTax:number, ratePct:number}>> }}
 */
export function parseWithholdingTariffFile(text, wantedCodes = null) {
  const codes = new Map();
  let canton = null;
  let createdOn = null;
  let validFrom = null;
  for (const line of String(text).split(/\r?\n/)) {
    const kind = line.slice(0, 2);
    if (kind === '00') {
      canton = line.slice(2, 4).trim() || canton;
      const d = line.slice(19, 27).trim();
      if (/^\d{8}$/.test(d)) createdOn = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      continue;
    }
    if (kind !== '06') continue;
    if (line.slice(2, 4) === '03') continue; // cancellazione
    const code = line.slice(6, 16).trim();
    if (wantedCodes && !wantedCodes.has(code)) continue;
    const from = Number(line.slice(24, 33)) / 100;
    const step = Number(line.slice(33, 42)) / 100;
    const minTax = Number(line.slice(45, 54)) / 100;
    const ratePct = Number(line.slice(54, 59)) / 100;
    if (![from, step, minTax, ratePct].every(Number.isFinite)) continue;
    const d = line.slice(16, 24);
    if (/^\d{8}$/.test(d)) {
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      if (!validFrom || iso > validFrom) validFrom = iso;
    }
    if (!canton) canton = line.slice(4, 6);
    let list = codes.get(code);
    if (!list) codes.set(code, (list = []));
    list.push({ from, to: from + step, minTax, ratePct });
  }
  for (const list of codes.values()) list.sort((a, b) => a.from - b.from);
  return { canton, createdOn, validFrom, codes };
}

/** Aliquota (%) e imposta minima per un reddito mensile, o null se fuori tabella. */
export function lookupWithholdingRate(brackets, monthlyIncome) {
  if (!Array.isArray(brackets) || brackets.length === 0) return null;
  let lo = 0;
  let hi = brackets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = brackets[mid];
    if (monthlyIncome < b.from) hi = mid - 1;
    else if (monthlyIncome >= b.to) lo = mid + 1;
    else return { ratePct: b.ratePct, minTaxCHF: b.minTax };
  }
  return null;
}
