import { describe, expect, it } from 'vitest';
import { compareNet } from '@/build-plugins/salaryHubContent';
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
