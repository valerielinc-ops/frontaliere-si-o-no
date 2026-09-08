/**
 * La frase `retention` del blocco leve afferma un FATTO, non una stima: «di
 * ogni franco lordo in più resta netta <fascia>». Quel fatto presuppone che
 * `calculateSimulation` sia monotona crescente su `salary` a parità delle
 * altre quattro dimensioni, e che il netto cresca MENO del lordo.
 *
 * PERCHÉ UN TEST E NON UN COMMENTO
 * ---------------------------------------------------------------------------
 * Fino a questa issue (#7728) quell'invariante non era osservato da nulla:
 * misurato sul dominio pubblicato regge (0 violazioni su 408 coppie
 * adiacenti), ma è un invariante VERO E NON OSSERVATO — una soglia IRPEF
 * riscritta, una tabella alla fonte aggiornata o un contributo che cambia
 * scaglione possono romperlo senza che nulla diventi rosso, e la pagina
 * pubblicherebbe una fascia inventata invece di tacere.
 *
 * LE DUE METÀ
 * ---------------------------------------------------------------------------
 * 1. la monotonia sul dominio pubblicato — tutte le combinazioni × tutti i
 *    gradini, non un campione: è una proprietà dei bordi della scala tanto
 *    quanto del mezzo (a 40 000 CHF le detrazioni familiari sono al massimo, a
 *    150 000 no);
 * 2. la guardia in `scenarioLeverSentences`, che è la rete SOTTO il punto 1:
 *    se la monotonia si rompe comunque, la frase dev'essere OMESSA, non
 *    ripiegata su un'altra fascia né sostituita da `retentionTop` (che
 *    dichiarerebbe il falso: «sopra non c'è un gradino» mentre c'è).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateAllScenarios,
  scenarioToInputs,
  SALARY_LEVELS,
  type SalaryHubScenario,
} from '@/build-plugins/salaryHubScenarios';
import { calculateSimulation } from '@/services/calculationService';
import { scenarioLeverSentences } from '@/build-plugins/shared/scenarioLeverComparison';

const RETENTION_PREFIX = 'Salendo al gradino di RAL successivo';
const RETENTION_TOP_PREFIX = 'Questa è la RAL più alta della scala pubblicata';

const scenarios = generateAllScenarios();

const netItalian = (scenario: SalaryHubScenario): number =>
  calculateSimulation(scenarioToInputs(scenario)).itResident.netIncomeAnnual;

const salaryStepUp = (salary: number): number | null => {
  const idx = SALARY_LEVELS.indexOf(salary as (typeof SALARY_LEVELS)[number]);
  return idx < 0 ? null : (SALARY_LEVELS[idx + 1] ?? null);
};

const inputFor = (scenario: SalaryHubScenario) => ({
  scenario,
  allScenarios: scenarios,
  chResidentNetAnnual: calculateSimulation(scenarioToInputs(scenario)).chResident.netIncomeAnnual,
  itResidentNetAnnual: netItalian(scenario),
  locale: 'it' as const,
});

describe('retention: monotonia di calculateSimulation su salary', () => {
  it('il netto cresce col lordo, e meno del lordo, su ogni coppia adiacente pubblicata', () => {
    const violations: string[] = [];
    let checked = 0;

    for (const scenario of scenarios) {
      const nextSalary = salaryStepUp(scenario.salary);
      if (nextSalary === null) continue;
      checked += 1;

      const retention =
        (netItalian({ ...scenario, salary: nextSalary }) - netItalian(scenario)) /
        (nextSalary - scenario.salary);

      // (0, 1]: sotto 0 il netto scenderebbe salendo di RAL, sopra 1
      // resterebbe netto più del lordo aggiunto. Entrambi renderebbero falsa
      // la frase, non solo imprecisa.
      if (!(retention > 0 && retention <= 1)) {
        violations.push(
          `${scenario.salary}→${nextSalary} ${scenario.frontierType}/${scenario.maritalStatus}/` +
            `${scenario.children}figli/${scenario.distanceZone}: retention=${retention.toFixed(4)}`,
        );
      }
    }

    // Il dominio pubblicato è 432 combinazioni su 18 gradini di RAL: 408
    // coppie adiacenti. Se il conteggio cala, il test sta misurando meno di
    // quel che dice.
    expect(checked).toBe(408);
    expect(violations).toEqual([]);
  });

  it('ogni pagina non di vertice emette la frase, quelle di vertice emettono retentionTop', () => {
    const topSalary = SALARY_LEVELS[SALARY_LEVELS.length - 1];

    for (const scenario of scenarios) {
      const sentences = scenarioLeverSentences(inputFor(scenario));
      const hasRetention = sentences.some((s) => s.startsWith(RETENTION_PREFIX));
      const hasTop = sentences.some((s) => s.startsWith(RETENTION_TOP_PREFIX));

      if (scenario.salary === topSalary) {
        expect(hasTop, `${scenario.salary} dovrebbe essere di vertice`).toBe(true);
        expect(hasRetention).toBe(false);
      } else {
        // La guardia non sta silenziando pagine legittime: con la monotonia
        // intatta la frase c'è su tutte.
        expect(hasRetention, `frase retention assente a ${scenario.salary} CHF`).toBe(true);
        expect(hasTop).toBe(false);
      }
    }
  });
});

describe('retention: la guardia omette la frase se la monotonia si rompe', () => {
  /**
   * Il motore va sostituito PRIMA che il modulo delle leve venga importato: il
   * suo `netCache` è memoizzato a livello di modulo, quindi senza
   * `resetModules` la seconda metà del file leggerebbe i netti veri già in
   * cache e il test passerebbe senza aver mai esercitato la guardia.
   */
  async function sentencesWithNet(
    netOf: (annualIncomeCHF: number) => number,
    scenario: SalaryHubScenario,
  ): Promise<string[]> {
    vi.resetModules();
    vi.doMock('@/services/calculationService', () => ({
      calculateSimulation: (inputs: { annualIncomeCHF: number }) => ({
        itResident: { netIncomeAnnual: netOf(inputs.annualIncomeCHF) },
        chResident: { netIncomeAnnual: netOf(inputs.annualIncomeCHF) },
      }),
    }));
    const mod = await import('@/build-plugins/shared/scenarioLeverComparison');
    try {
      return mod.scenarioLeverSentences({
        scenario,
        allScenarios: scenarios,
        chResidentNetAnnual: netOf(scenario.salary),
        itResidentNetAnnual: netOf(scenario.salary),
        locale: 'it',
      });
    } finally {
      vi.doUnmock('@/services/calculationService');
      vi.resetModules();
    }
  }

  const midScenario = scenarios.find((s) => s.salary === 80_000)!;

  it('retention negativa: nessuna frase, e nessun ripiego su retentionTop', async () => {
    // Netto che SCENDE salendo di RAL.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sentences = await sentencesWithNet((gross) => 200_000 - gross, midScenario);

    expect(sentences.some((s) => s.startsWith(RETENTION_PREFIX))).toBe(false);
    expect(sentences.some((s) => s.startsWith(RETENTION_TOP_PREFIX))).toBe(false);
    // Il resto del blocco resta: la guardia toglie una frase, non l'intero <ul>.
    expect(sentences.length).toBeGreaterThan(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('retention fuori range'));
    warning.mockRestore();
  });

  it('retention > 1: nessuna frase, e nessun ripiego su retentionTop', async () => {
    // Netto che cresce PIÙ del lordo.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sentences = await sentencesWithNet((gross) => gross * 3, midScenario);

    expect(sentences.some((s) => s.startsWith(RETENTION_PREFIX))).toBe(false);
    expect(sentences.some((s) => s.startsWith(RETENTION_TOP_PREFIX))).toBe(false);
    expect(sentences.length).toBeGreaterThan(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('retention fuori range'));
    warning.mockRestore();
  });
});
