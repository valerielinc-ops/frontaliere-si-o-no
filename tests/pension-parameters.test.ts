/**
 * Parametri previdenziali svizzeri (pipeline D11 «pensioni»): parser delle
 * fonti ufficiali su estratti veri, derivazioni di legge LPP/3a, validatore
 * sul dataset committato, e i due legami che impediscono di tornare alle
 * cifre scadute:
 *   1. le costanti che il sito usa (services/pensionParameters.ts e quelle di
 *      constants.ts, che stanno nel grafo dei build-plugin) coincidono col
 *      dataset;
 *   2. nessuna copia (locali, SEO, build-plugin, componenti) cita piu' i
 *      valori 2023/2024 ritirati (rendita AVS 2'450, LPP 22'050/25'725/88'200,
 *      3a 7'056/35'280), che erano rimasti in pagina dopo l'adeguamento 2025.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import latest from '../data/pension-parameters/latest.json';
import { AC_SALARY_CAP_CHF, DEFAULT_TECH_PARAMS } from '@/constants';
import * as pensionParameters from '@/services/pensionParameters';
import {
  CANTONAL_PUBLIC_PENSION_FUNDS,
  deriveOccupationalLimits,
  parseCantonalCompensationFunds,
  parseMinimumInterestPage,
  parseOldAgePensionLeaflet,
  parsePillar3aPage,
  parseSalaryContributionsLeaflet,
  parseUnemploymentLeaflet,
} from '../scripts/lib/swiss-pension-sources.mjs';
import { assertPensionParametersDataset, buildFederalParameters } from '../scripts/fetch-pension-parameters.mjs';
import { validatePensionParameters } from '../scripts/validate-pension-parameters.mjs';
import { SWISS_CANTON_CODES } from '../scripts/lib/estv-tax-statistics.mjs';

const ROOT = path.resolve(__dirname, '..');

// Estratti testuali dei documenti veri (pdfjs, una riga per linea di base),
// con gli spazi sottili dei PDF.
const LEAFLET_301 = [
  ' 3.01 Leistungen der AHV',
  ' Altersrenten und Hilflosen-',
  ' Stand am 1. Januar 2026',
  ' Rentenansätze',
  ' 21   Welches sind die aktuellen Rentenansätze?',
  ' Altersrente   1 260.–   2 520.–',
  ' Kinderrente   504.–   1 008.–',
].join('\n');
const LEAFLET_201 = [
  ' 2.01 Beiträge',
  ' Stand am 1. Januar 2026',
  ' AHV   8,7 %',
  ' IV   1,4 %',
  ' EO   0,5 %',
  ' Total   10,6 %',
].join('\n');
const LEAFLET_208 = [
  ' 2.08 Beiträge',
  ' Stand am 1. Januar 2025',
  ' Bis zu einem jährlichen Höchstbetrag von 148 200 Franken beträgt der',
  ' Beitragssatz an die ALV 2,2 % des massgebenden Jahreslohnes. Dieser',
].join('\n');
const BSV_3A_HTML =
  '<p>Si può decidere liberamente quanto versare, fino a un massimo di 7258 franchi all’anno se si è salariati e affiliati a un ' +
  'istituto di previdenza o fino al 20 per cento del proprio reddito fino a un massimo di 36 288 franchi all’anno se si è lavoratori indipendenti</p>';
const BSV_LPP_HTML = '<p>Guthaben wird aus den jährlichen Altersgutschriften inklusive eines Zinses von mindestens 1,25 % ab 2024 gebildet</p>';
const FUNDS_HTML =
  '<div class="co-address-content " id="ti-ticino-1"> Nr. 21<br>Kanton: TI<br><br>\n\t\tIstituto delle assicurazioni sociali<br> Via Ghiringhelli 15a<br>' +
  '<table><tr><td>Webseite:</td><td style="padding-left:7px;"><a href="http://www4.ti.ch/dss/ias" target="_blank">x</a></td></tr></table></div>' +
  '<div class="co-address-content " id="ne-1"> Nr. 24<br>Kanton: NE<br><br>\n\t\tAusgleichskasse des Kantons Neuenburg<br>' +
  '<a href="https://www.caisseavsne.ch/de/kontakt/">k</a><a href="https://www.caisseavsne.ch/de">h</a></div>';

describe('parser delle fonti ufficiali', () => {
  it('promemoria 3.01: anno dichiarato e rendite minima/massima', () => {
    expect(parseOldAgePensionLeaflet(LEAFLET_301)).toEqual({ standYear: 2026, minMonthly: 1260, maxMonthly: 2520 });
    // Art. 34 LAVS: la massima e' il doppio della minima; una riga letta male non passa.
    expect(() => parseOldAgePensionLeaflet(LEAFLET_301.replace('2 520', '2 450'))).toThrow(/incoerenti/);
    expect(() => parseOldAgePensionLeaflet('niente')).toThrow(/non trovata/);
  });

  it('promemoria 2.01 e 2.08: aliquote e massimale AD', () => {
    expect(parseSalaryContributionsLeaflet(LEAFLET_201)).toEqual({
      standYear: 2026, avsPct: 8.7, aiPct: 1.4, apgPct: 0.5, totalPct: 10.6, employeePct: 5.3,
    });
    expect(parseUnemploymentLeaflet(LEAFLET_208)).toEqual({ standYear: 2025, salaryCapCHF: 148200, totalPct: 2.2, employeePct: 1.1 });
  });

  it('pagine UFAS: massimali 3a e tasso minimo LPP', () => {
    expect(parsePillar3aPage(BSV_3A_HTML)).toEqual({ withLpp: 7258, withoutLpp: 36288 });
    expect(parseMinimumInterestPage(BSV_LPP_HTML)).toEqual({ ratePct: 1.25, since: 2024 });
  });

  it('elenco ahv-iv.ch delle casse AVS cantonali, anche senza riga «Webseite»', () => {
    expect(parseCantonalCompensationFunds(FUNDS_HTML)).toEqual({
      TI: { number: 21, name: 'Istituto delle assicurazioni sociali', url: 'https://www4.ti.ch/dss/ias' },
      NE: { number: 24, name: 'Ausgleichskasse des Kantons Neuenburg', url: 'https://www.caisseavsne.ch/de' },
    });
  });
});

describe('derivazioni di legge e incrocio con UFAS', () => {
  it('soglie LPP e massimali 3a dalla rendita AVS massima', () => {
    expect(deriveOccupationalLimits(2520)).toEqual({
      avsMaxAnnual: 30240,
      lppEntryThreshold: 22680,
      lppCoordinationDeduction: 26460,
      lppMinCoordinatedSalary: 3780,
      lppMaxInsuredSalary: 90720,
      pillar3aMaxWithLpp: 7258,
      pillar3aMaxWithoutLpp: 36288,
    });
  });

  it('rifiuta fonti incoerenti (3a derivato diverso da quello UFAS)', () => {
    const args = {
      pensions: { standYear: 2026, minMonthly: 1260, maxMonthly: 2520 },
      contributions: parseSalaryContributionsLeaflet(LEAFLET_201),
      unemployment: parseUnemploymentLeaflet(LEAFLET_208),
      pillar3aPage: { withLpp: 7258, withoutLpp: 36288 },
      minimumInterest: { ratePct: 1.25, since: 2024 },
    };
    expect(buildFederalParameters(args).lpp.coordinationDeductionCHF).toBe(26460);
    expect(() => buildFederalParameters({ ...args, pillar3aPage: { withLpp: 7056, withoutLpp: 35280 } })).toThrow(/fonti incoerenti/);
  });
});

describe('dataset committato', () => {
  it('i quattro mirror sono validi e identici', () => {
    // `now` all'anno del dataset: il controllo di copertura del calendario vive
    // nel workflow mensile, non nella suite (non deve scadere da solo).
    const { year } = validatePensionParameters({ root: ROOT, now: new Date(Date.UTC(latest.year, 5, 1)) });
    expect(year).toBe(latest.year);
  });

  it('il controllo di copertura scatta dal 1° febbraio dell\'anno dopo, non in gennaio', () => {
    expect(() => assertPensionParametersDataset(latest, { now: new Date(Date.UTC(latest.year + 1, 0, 20)) })).not.toThrow();
    expect(() => assertPensionParametersDataset(latest, { now: new Date(Date.UTC(latest.year + 1, 1, 2)) })).toThrow(/non coperto/);
  });

  it('copre i 26 cantoni: cassa AVS, imposta sul capitale e casse pensioni curate', () => {
    expect(Object.keys(latest.cantons).sort()).toEqual([...SWISS_CANTON_CODES].sort());
    expect(Object.keys(CANTONAL_PUBLIC_PENSION_FUNDS).sort()).toEqual([...SWISS_CANTON_CODES].sort());
    for (const code of SWISS_CANTON_CODES) {
      const c = latest.cantons[code as keyof typeof latest.cantons];
      expect(c.compensationFund?.url, code).toMatch(/^https:\/\//);
      expect(c.capitalWithdrawalTax?.taxCHF, code).toHaveLength(3);
    }
  });
});

describe('le costanti del sito leggono il dataset', () => {
  const f = latest.federal;
  it('services/pensionParameters.ts', () => {
    expect(pensionParameters.PENSION_PARAMETERS_YEAR).toBe(latest.year);
    expect(pensionParameters.AVS_MAX_MONTHLY_CHF).toBe(f.avs.maxMonthlyCHF);
    expect(pensionParameters.AVS_MIN_MONTHLY_CHF).toBe(f.avs.minMonthlyCHF);
    expect(pensionParameters.LPP_ENTRY_THRESHOLD_CHF).toBe(f.lpp.entryThresholdCHF);
    expect(pensionParameters.LPP_COORDINATION_DEDUCTION_CHF).toBe(f.lpp.coordinationDeductionCHF);
    expect(pensionParameters.LPP_MAX_INSURED_SALARY_CHF).toBe(f.lpp.maxInsuredSalaryCHF);
    expect(pensionParameters.PILLAR_3A_MAX_WITH_LPP_CHF).toBe(f.pillar3a.maxWithLppCHF);
    expect(pensionParameters.PILLAR_3A_MAX_WITHOUT_LPP_CHF).toBe(f.pillar3a.maxWithoutLppCHF);
  });

  it('constants.ts (grafo dei build-plugin) resta allineato al dataset', () => {
    expect(AC_SALARY_CAP_CHF).toBe(f.unemployment.salaryCapCHF);
    expect(DEFAULT_TECH_PARAMS.avsRate).toBeCloseTo(f.contributions.employeePct / 100, 10);
    expect(DEFAULT_TECH_PARAMS.acRate).toBeCloseTo(f.unemployment.employeePct / 100, 10);
  });
});

describe('nessuna copia cita i parametri ritirati', () => {
  // Valori 2023/2024 sostituiti dall'adeguamento del 1° gennaio 2025, con
  // qualunque separatore delle migliaia usato nei quattro locali.
  const RETIRED = /(?<![\d.,'’])(?:2[.,'’   ]?450|1[.,'’   ]225|29[.,'’   ]400|22[.,'’   ]?050|25[.,'’   _]?725|88[.,'’   _]?200|7[.,'’   ]?056|35[.,'’   ]?280)(?![\d])/u;
  const PENSION_CONTEXT = /AVS|AHV|rendit|Rente|rente|pension|LPP|BVG|3a|pilastro|Säule|pilier|coordin|Koordin|soglia|Schwelle|seuil|threshold/iu;
  const DIRS = ['services/locales', 'services/seo', 'build-plugins', 'components'];

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        try {
          fs.statSync(path.join(ROOT, rel));
        } catch {
          continue; // symlink verso un path escluso dal checkout sparse
        }
        yield rel;
      }
    }
  }

  it('locali, SEO, build-plugin e componenti', () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const rel of walk(dir)) {
        const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (RETIRED.test(line) && PENSION_CONTEXT.test(line)) hits.push(`${rel}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
