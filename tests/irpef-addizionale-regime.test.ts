/**
 * Issue #4875 (item A) — the addizionale comunale IRPEF is not one scale.
 *
 * 51 of the 518 border comuni carry `irpefAddizionale: 0`, and they are
 * exactly the `province: 'AO'` rows — the whole Valle d'Aosta, a
 * special-statute region that levies no comunal surcharge. Ranking, colouring
 * and printing that `0` raw told the reader those comuni were the cheapest on
 * the list, for a tax they are not subject to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUNICIPALITIES } from '@/data/municipalities';
import {
  NO_SURCHARGE_PROVINCES,
  formatIrpefAddizionale,
  irpefFiscalScore,
  irpefRateRange,
  leviesIrpefAddizionale,
  noSurchargeLabel,
  noSurchargeNote,
} from '@/services/irpefAddizionaleRegime';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('the zero rate is a regime, not a value', () => {
  it('every zero-rate comune is in a no-surcharge province, and vice versa', () => {
    const zeros = MUNICIPALITIES.filter((m) => m.irpefAddizionale === 0);
    const noSurcharge = MUNICIPALITIES.filter((m) => NO_SURCHARGE_PROVINCES.has(m.province));
    expect(zeros.length).toBeGreaterThan(0);
    expect(new Set(zeros.map((m) => m.name))).toEqual(new Set(noSurcharge.map((m) => m.name)));
  });

  it('no comune outside the no-surcharge regime has a zero rate', () => {
    for (const m of MUNICIPALITIES) {
      if (leviesIrpefAddizionale(m)) expect(m.irpefAddizionale).toBeGreaterThan(0);
    }
  });
});

describe('irpefRateRange excludes the no-surcharge regime', () => {
  it('never reports a floor of 0 for the real dataset', () => {
    const { min, max } = irpefRateRange(MUNICIPALITIES);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThanOrEqual(min);
  });

  it('returns a zero range for an empty / all-exempt list', () => {
    expect(irpefRateRange([])).toEqual({ min: 0, max: 0 });
    expect(irpefRateRange([{ province: 'AO', irpefAddizionale: 0 }])).toEqual({ min: 0, max: 0 });
  });
});

describe('irpefFiscalScore keeps the exempt comuni off the axis', () => {
  const { min, max } = irpefRateRange(MUNICIPALITIES);

  it('returns null for an exempt comune instead of the top score', () => {
    expect(irpefFiscalScore({ province: 'AO', irpefAddizionale: 0 }, min, max)).toBeNull();
  });

  it('scores the cheapest applicable rate 1 and the dearest 0', () => {
    expect(irpefFiscalScore({ province: 'CO', irpefAddizionale: min }, min, max)).toBeCloseTo(1);
    expect(irpefFiscalScore({ province: 'CO', irpefAddizionale: max }, min, max)).toBeCloseTo(0);
  });

  it('scores a mid rate between the two', () => {
    const mid = (min + max) / 2;
    const score = irpefFiscalScore({ province: 'CO', irpefAddizionale: mid }, min, max);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('degenerate range (single applicable rate) scores 1, not NaN', () => {
    expect(irpefFiscalScore({ province: 'CO', irpefAddizionale: 0.55 }, 0.55, 0.55)).toBe(1);
  });
});

describe('display never shows a bare 0%', () => {
  it('formats an applicable rate as a percentage', () => {
    expect(formatIrpefAddizionale({ province: 'CO', irpefAddizionale: 0.55 })).toBe('0.55%');
  });

  it('returns null for the exempt regime so callers must decide', () => {
    expect(formatIrpefAddizionale({ province: 'AO', irpefAddizionale: 0 })).toBeNull();
  });

  it.each(['it', 'en', 'de', 'fr'])('has a native label and note for %s', (locale) => {
    expect(noSurchargeLabel(locale).length).toBeGreaterThan(0);
    expect(noSurchargeNote(locale).length).toBeGreaterThan(40);
  });

  it('falls back to Italian for an unknown locale', () => {
    expect(noSurchargeLabel('es')).toBe(noSurchargeLabel('it'));
    expect(noSurchargeNote('es')).toBe(noSurchargeNote('it'));
  });
});

describe('no consumer prints or ranks the raw field any more (Non-Negotiable #6)', () => {
  const consumers = [
    'components/guide/BorderMunicipalitiesMap.tsx',
    'components/guide/FrontierGuide.tsx',
    'components/guide/PermitCompare.tsx',
    'components/pages/UserProfile.tsx',
    'components/vita/LivabilityIndex.tsx',
    'components/vita/LivabilityMap.tsx',
  ];

  it.each(consumers)('%s renders through the shared component', (rel) => {
    const src = read(rel);
    expect(src, `${rel} still prints a bare rate`).not.toMatch(/irpefAddizionale\}\s*%/);
    expect(src).toContain('IrpefAddizionaleValue');
  });

  it('the map colour scale asks the shared predicate first', () => {
    const src = read('components/guide/BorderMunicipalitiesMap.tsx');
    const caseBody = /case 'irpef': \{[\s\S]*?\n \}/.exec(src)?.[0] || '';
    expect(caseBody).toContain('leviesIrpefAddizionale');
    expect(caseBody.indexOf('leviesIrpefAddizionale')).toBeLessThan(caseBody.indexOf('MAP_COLORS.success'));
  });

  it('the livability ranking normalises over the applicable range only', () => {
    const src = read('components/vita/LivabilityIndex.tsx');
    expect(src).toContain('irpefRateRange(municipalities)');
    expect(src).toContain('irpefFiscalScore(m, minIrpef, maxIrpef)');
    expect(src).not.toMatch(/Math\.min\(\.\.\.irpefs\)/);
  });

  it('the tax simulators still receive the raw number (the tax really is 0 there)', () => {
    expect(read('components/calculator/ResidencySimulator.tsx')).toContain('irpefComunale: m.irpefAddizionale');
    expect(read('components/calculator/SeasonalNaspiSimulator.tsx')).toContain('comune.irpefAddizionale');
  });

  it('the data file documents the caveat where the field is declared', () => {
    const src = read('data/municipalities.ts');
    const decl = src.indexOf('irpefAddizionale: number;');
    expect(decl).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, decl - 1600), decl)).toContain('irpefAddizionaleRegime');
  });
});
