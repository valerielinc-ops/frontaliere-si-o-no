/**
 * Dataset fiscale per cantone (pipeline D11 «fisco»): parser dei file
 * tariffari ESTV, soglie del validatore e parita' con la copia congelata
 * `data/swiss-canton-tax-burden.json` (che a sua volta e' gemella dei
 * literal di build-plugins/shared/cantonSalaryIndex.ts, vedi
 * tests/swiss-canton-salary-parity.test.ts). Una sola verita' sull'onere: se
 * la serie ESTV automatica e la copia congelata divergono, fallisce qui.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import legacyBurden from '../data/swiss-canton-tax-burden.json';
import {
  SWISS_CANTON_CODES,
  findWithholdingArchiveUrl,
  lookupWithholdingRate,
  parseCapitalTaxExport,
  parseTaxBurdenExport,
  parseWithholdingAuthorityLinks,
  parseWithholdingTariffFile,
  round2,
} from '../scripts/lib/estv-tax-statistics.mjs';
import {
  BURDEN_INCOMES_CHF,
  assertCantonTaxDataset,
  buildWithholdingByCanton,
} from '../scripts/fetch-canton-tax-data.mjs';
import { validateCantonTaxData } from '../scripts/validate-canton-tax-data.mjs';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'canton-tax');

function committedDatasets() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
}

function latestDataset() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'canton-tax', 'latest.json'), 'utf8'));
}

// Righe nel formato D_DVS Nr. 0005 (esempi del documento ESTV, gradini veri).
const TARIFF_LINES = [
  '00TI               20251126',
  '0601TIA0N       20260101000595100000005000 0000000000001010   ',
  '0601TIA0N       20260101000600100000005000 0000000000001015   ',
  '0601TIR0N       20260101000595100000005000 0000000000000800   ',
  '0601TIB2Y       20260101000595100000005000 0200000000000150   ',
  '0601TIX9N       20260101000595100000005000 0000000000009999   ',
  '1101TIHEN       20260101000000100099999900 0000000000002300   ',
  '99               TI00000007',
].join('\n');

describe('parser dei file tariffari ESTV', () => {
  it('legge canton, data file, validita\' e gradini (reddito in centesimi, aliquota in centesimi di punto)', () => {
    const parsed = parseWithholdingTariffFile(TARIFF_LINES);
    expect(parsed.canton).toBe('TI');
    expect(parsed.createdOn).toBe('2025-11-26');
    expect(parsed.validFrom).toBe('2026-01-01');
    expect(parsed.codes.get('A0N')).toEqual([
      { from: 5951, to: 6001, minTax: 0, ratePct: 10.1 },
      { from: 6001, to: 6051, minTax: 0, ratePct: 10.15 },
    ]);
    // Le righe 11 (categorie predefinite) non sono tariffe progressive.
    expect(parsed.codes.has('HEN')).toBe(false);
  });

  it('filtra i codici richiesti e trova il gradino giusto', () => {
    const parsed = parseWithholdingTariffFile(TARIFF_LINES, new Set(['A0N']));
    expect([...parsed.codes.keys()]).toEqual(['A0N']);
    expect(lookupWithholdingRate(parsed.codes.get('A0N'), 6000)).toEqual({ ratePct: 10.1, minTaxCHF: 0 });
    expect(lookupWithholdingRate(parsed.codes.get('A0N'), 6001)).toEqual({ ratePct: 10.15, minTaxCHF: 0 });
    expect(lookupWithholdingRate(parsed.codes.get('A0N'), 9000)).toBeNull();
  });

  it('usa la variante senza imposta di culto se esiste, altrimenti quella con (e lo dichiara)', () => {
    const withN = buildWithholdingByCanton({ TI: TARIFF_LINES }, { incomes: [6000], codes: ['A0', 'R0', 'B2'] });
    expect(withN.TI).toMatchObject({ churchTax: 'N', ratesPct: { A0: [10.1], R0: [8] } });
    // B2 esiste solo con Y: in un cantone che pubblica N non si mescolano le varianti.
    expect(withN.TI?.ratesPct.B2).toBeUndefined();
    const onlyY = buildWithholdingByCanton({ JU: TARIFF_LINES.replace(/TI/g, 'JU').replace(/A0N|R0N/g, 'X9N') }, { incomes: [6000], codes: ['B2'] });
    expect(onlyY.JU).toMatchObject({ churchTax: 'Y', ratesPct: { B2: [1.5] } });
    expect(withN.ZH).toBeNull();
  });
});

describe('parser delle pagine ESTV', () => {
  it('trova l\'archivio tariffe dell\'anno, corrente o in archivio', () => {
    const html =
      '<a href="https://www.estv2.admin.ch/qst/2026/loehne/tar2026.zip">x</a>' +
      '<a href="https://www.estv2.admin.ch/qst/archiv/tar2025.zip">y</a>';
    expect(findWithholdingArchiveUrl(html, 2026)).toBe('https://www.estv2.admin.ch/qst/2026/loehne/tar2026.zip');
    expect(findWithholdingArchiveUrl(html, 2025)).toBe('https://www.estv2.admin.ch/qst/archiv/tar2025.zip');
    expect(findWithholdingArchiveUrl(html, 2024)).toBeNull();
  });

  it('mappa i link alle autorita\' cantonali per nome tedesco del cantone', () => {
    const html =
      '<a href="https://www.ti.ch/fonte">Tessin</a>' +
      '<a href="https://www.gr.ch/q" class="x"><span>Graub&uuml;nden</span></a>' +
      '<a href="https://www.instagram.com/estv">Lernende der ESTV</a>';
    expect(parseWithholdingAuthorityLinks(html)).toEqual({ TI: 'https://www.ti.ch/fonte', GR: 'https://www.gr.ch/q' });
  });

  it('trasforma l\'export dell\'onere in serie per anno, ignorando righe estranee', () => {
    const json = {
      payload: [
        { bfsId: 5002, municipality: 'Bellinzona', canton: 'TI', income: 30000, values: [2.9133, 2.91] },
        { bfsId: 5002, municipality: 'Bellinzona', canton: 'TI', income: 60000, values: [8.9249, 8.92] },
        { bfsId: 1, municipality: 'Vaduz', canton: 'LI', income: 30000, values: [1, 1] },
      ],
    };
    expect(parseTaxBurdenExport(json, { years: [2025, 2026], incomes: [30000, 60000] })).toEqual({
      TI: { municipality: 'Bellinzona', bfsId: 5002, byYear: { '2025': [2.91, 8.92], '2026': [2.91, 8.92] } },
    });
    expect(() => parseTaxBurdenExport({}, { years: [2026], incomes: [30000] })).toThrow(/payload/);
    const dup = { payload: [json.payload[0], { ...json.payload[0], values: [3, 3] }] };
    expect(() => parseTaxBurdenExport(dup, { years: [2025, 2026], incomes: [30000, 60000] })).toThrow(/duplicata/);
  });

  it('imposta sul capitale: una riga per cantone e importo, duplicati rifiutati', () => {
    const row = { bfsId: 5002, municipality: 'Bellinzona', canton: 'TI', income: 100000, values: [4397.4] };
    expect(parseCapitalTaxExport({ payload: [row] }, { capitals: [100000] })).toEqual({
      TI: { municipality: 'Bellinzona', bfsId: 5002, taxCHF: [4397] },
    });
    expect(() => parseCapitalTaxExport({ payload: [row, { ...row, values: [1] }] }, { capitals: [100000] })).toThrow(/duplicata/);
  });

  it('arrotonda come round(x, 2) di Python sul valore binario esatto', () => {
    expect(round2(10.475)).toBe(10.47); // binario 10.47499…
    expect(round2(14.425)).toBe(14.43); // binario 14.42500…07
    expect(round2(3.125)).toBe(3.12); // pareggio esatto → pari
    expect(round2(5.476666666666667)).toBe(5.48);
  });
});

describe('dataset committato', () => {
  it('latest.json e i mirror dell\'anno passano il validatore', () => {
    const latest = latestDataset();
    // `now` fissato all'anno del dataset: il controllo di freschezza vive nel
    // workflow, non qui (un test non deve scadere col calendario).
    const { year } = validateCantonTaxData({ root: ROOT, now: new Date(Date.UTC(latest.year, 5, 1)) });
    expect(year).toBe(latest.year);
  });

  it('copre tutti i 26 cantoni con onere, tariffe e pagina cantonale', () => {
    const ds = latestDataset();
    expect(Object.keys(ds.cantons).sort()).toEqual([...SWISS_CANTON_CODES].sort());
    for (const code of SWISS_CANTON_CODES) {
      expect(ds.cantons[code].burdenPct[String(ds.year)]).toHaveLength(BURDEN_INCOMES_CHF.length);
    }
    for (const code of ['GR', 'TI', 'VS']) expect(ds.cantons[code].withholding.ratesPct.R0).toBeDefined();
  });

  it('il validatore rifiuta un dataset con troppi cantoni senza tariffe o senza onere', () => {
    const ds = structuredClone(latestDataset());
    for (const code of ['AG', 'AI', 'AR']) ds.cantons[code].withholding = null;
    expect(() => assertCantonTaxDataset(ds)).toThrow(/solo per 23\/26/);

    const noBurden = structuredClone(latestDataset());
    delete noBurden.cantons.ZH;
    expect(() => assertCantonTaxDataset(noBurden)).toThrow(/cantoni mancanti: ZH/);

    const decreasing = structuredClone(latestDataset());
    decreasing.cantons.TI.burdenPct[String(decreasing.year)] = [20, 10, 30, 40, 45];
    expect(() => assertCantonTaxDataset(decreasing)).toThrow(/non crescente/);
  });
});

describe('parita\' con data/swiss-canton-tax-burden.json (copia congelata usata dall\'app)', () => {
  const refYear = String(legacyBurden.referenceYear);
  const carrier = committedDatasets().find((ds) => ds.burden.years.map(String).includes(refYear));

  it('almeno un dataset committato copre l\'anno di riferimento della copia congelata', () => {
    expect(carrier, `nessun data/canton-tax/*.json contiene l'onere ${refYear}`).toBeDefined();
  });

  it('stessi redditi di riferimento e stessi capoluoghi', () => {
    expect(carrier!.burden.incomeBracketsCHF).toEqual(legacyBurden.incomeBracketsCHF);
    for (const [code, capital] of Object.entries(legacyBurden.cantonCapital)) {
      expect(carrier!.cantons[code].capital.municipality).toBe(capital);
    }
  });

  it('onere identico, cantone per cantone, al centesimo di punto', () => {
    for (const [code, row] of Object.entries(legacyBurden.totalTaxBurdenPctByCanton)) {
      expect(carrier!.cantons[code].burdenPct[refYear], code).toEqual(row);
    }
  });
});
