import { describe, expect, it } from 'vitest';
import { compareNet, generatePageHtml } from '@/build-plugins/salaryHubContent';
import { calculateSimulation } from '@/services/calculationService';
import { generateAllScenarios, scenarioToInputs, type SalaryHubScenario } from '@/build-plugins/salaryHubScenarios';
import type { SimulationResult } from '@/types';

const result = (chNet: number, itNet: number): SimulationResult =>
  ({
    chResident: { netIncomeAnnual: chNet },
    itResident: { netIncomeAnnual: itNet },
    exchangeRate: 1.1,
  }) as unknown as SimulationResult;

describe('compareNet', () => {
  it('premia il permesso B quando il residente netta di piu', () => {
    expect(compareNet(result(56440, 47789))).toMatchObject({ winner: 'resident', gapCHF: 8651 });
  });

  it('premia il permesso G quando il frontaliere netta di piu', () => {
    expect(compareNet(result(103160, 115760))).toMatchObject({ winner: 'frontier', gapCHF: 12600 });
  });

  it('dichiara parita sotto il franco', () => {
    expect(compareNet(result(50000, 50000.4))).toEqual({ winner: 'tie', gapCHF: 0, gapEUR: 0 });
  });

  it('converte il divario in euro al cambio della simulazione', () => {
    expect(compareNet(result(100, 200)).gapEUR).toBeCloseTo(110);
  });
});

describe('salary hub withholding FAQ', () => {
  it.each([
    ['it', 'Imposta alla fonte Ticino'],
    ['en', 'Ticino withholding tax'],
    ['de', 'Tessiner Quellensteuer'],
    ['fr', 'Impôt à la source tessinois'],
  ] as const)('ties both ordinary and cross-border rates to table amounts in %s', (locale, rowLabel) => {
    const scenario: SalaryHubScenario = {
      salary: 80_000,
      frontierType: 'NEW',
      maritalStatus: 'SINGLE',
      children: 0,
      distanceZone: 'WITHIN_20KM',
    };
    const result = calculateSimulation(scenarioToInputs(scenario));
    const html = generatePageHtml(scenario, result, locale, generateAllScenarios(), '/tmp');
    const faqScripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const faq = faqScripts
      .map((match) => JSON.parse(match[1]))
      .find((json) => json['@type'] === 'FAQPage');
    const answer = faq.mainEntity.find((item: { acceptedAnswer: { text: string } }) =>
      item.acceptedAnswer.text.includes(locale === 'en' ? 'ordinary Ticino withholding tax' : locale === 'de' ? 'ordentliche Tessiner Quellensteuer' : locale === 'fr' ? "impôt ordinaire à la source tessinois" : 'imposta ordinaria alla fonte ticinese'),
    ).acceptedAnswer.text as string;

    const withholdingRow = [...html.matchAll(/<tr>\s*<td>\s*([^<]*?)\s*<\/td>\s*<td class=(?:"num"|num)>\s*([^<]*)\s*<\/td>\s*<td class=(?:"num"|num)>\s*([^<]*)\s*<\/td>\s*<\/tr>/g)]
      .find((match) => match[1].toLowerCase().includes(rowLabel.toLowerCase()));
    expect(withholdingRow).toBeDefined();
    const rowAmounts = [withholdingRow![2], withholdingRow![3]].map((cell) => Number(cell.replace(/[^\d]/g, '')));
    expect(rowAmounts[1]).toBe(Math.round(rowAmounts[0] * 0.8));
    const faqAmounts = [...answer.matchAll(/CHF\s*([\d][\d.,’'\u202f ]*)\s*\((\d{1,2}[.,]\d{2})\s*%\)/g)];
    expect(faqAmounts).toHaveLength(2);

    for (const [index, match] of faqAmounts.entries()) {
      const faqAmount = Number(match[1].replace(/[^\d]/g, ''));
      const statedRate = Number(match[2].replace(',', '.'));
      const tableAmount = rowAmounts[index];
      expect(faqAmount).toBe(tableAmount);
      expect(statedRate).toBeCloseTo((tableAmount / scenario.salary) * 100, 2);
    }
  });
});
