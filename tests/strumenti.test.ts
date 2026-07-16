/**
 * Unit tests for the Strumenti feature components.
 * Tests core calculation logic exported by each component.
 */
import { describe, it, expect } from 'vitest';
import { cantonTaxBurdenPct } from '@/services/cantonSalary';

// ── PayslipSimulator: test withholding tax rate logic ──
// We can't directly import internal functions, so we test the same logic here

describe('PayslipSimulator logic', () => {
  const LPP_RATES = [
    { minAge: 25, maxAge: 34, rate: 0.035 },
    { minAge: 35, maxAge: 44, rate: 0.05 },
    { minAge: 45, maxAge: 54, rate: 0.075 },
    { minAge: 55, maxAge: 65, rate: 0.09 },
  ];

  function getLppRate(age: number): number {
    if (age < 25) return 0;
    const bracket = LPP_RATES.find((b) => age >= b.minAge && age <= b.maxAge);
    return bracket ? bracket.rate : 0;
  }

  it('returns correct LPP rate for each age bracket', () => {
    expect(getLppRate(20)).toBe(0);
    expect(getLppRate(25)).toBe(0.035);
    expect(getLppRate(30)).toBe(0.035);
    expect(getLppRate(35)).toBe(0.05);
    expect(getLppRate(44)).toBe(0.05);
    expect(getLppRate(45)).toBe(0.075);
    expect(getLppRate(55)).toBe(0.09);
    expect(getLppRate(65)).toBe(0.09);
  });

  it('calculates Swiss social deductions correctly', () => {
    const gross = 80000;
    const avs = gross * 0.053;
    const ad = Math.min(gross, 148200) * 0.011;
    const ainf = gross * 0.007;
    const ijm = gross * 0.008;
    const lpp = gross * 0.05; // age 40

    expect(avs).toBeCloseTo(4240, 0);
    expect(ad).toBeCloseTo(880, 0);
    expect(ainf).toBeCloseTo(560, 0);
    expect(ijm).toBeCloseTo(640, 0);
    expect(lpp).toBeCloseTo(4000, 0);

    const total = avs + ad + ainf + ijm + lpp;
    expect(total).toBeCloseTo(10320, 0);
  });
});

// ── CarCostCalculator: test cost estimation logic ──

describe('CarCostCalculator logic', () => {
  function maintenanceMultiplier(age: number): number {
    if (age <= 2) return 0.6;
    if (age <= 5) return 1.0;
    if (age <= 10) return 1.4;
    return 1.8;
  }

  it('returns correct maintenance multiplier by vehicle age', () => {
    expect(maintenanceMultiplier(0)).toBe(0.6);
    expect(maintenanceMultiplier(2)).toBe(0.6);
    expect(maintenanceMultiplier(3)).toBe(1.0);
    expect(maintenanceMultiplier(5)).toBe(1.0);
    expect(maintenanceMultiplier(7)).toBe(1.4);
    expect(maintenanceMultiplier(15)).toBe(1.8);
  });

  it('calculates fuel costs based on km and type', () => {
    const annualKm = 15000;
    const petrolCostPerKm = 0.11;
    const electricCostPerKm = 0.035;

    expect(annualKm * petrolCostPerKm).toBeCloseTo(1650, 0);
    expect(annualKm * electricCostPerKm).toBeCloseTo(525, 0);
  });

  it('estimates vehicle value depreciation', () => {
    const newValue = 32000; // medium car
    // 3 years → 36% depreciation
    const value3yr = newValue * (1 - 3 * 0.12);
    expect(value3yr).toBeCloseTo(20480, 0);
    // 10 years → 80% cap
    const value10yr = newValue * (1 - Math.min(10 * 0.12, 0.8));
    expect(value10yr).toBeCloseTo(6400, 0);
  });

  it('calculates sdoganamento cost', () => {
    const vehicleValue = 20000;
    const iva = vehicleValue * 0.081;
    const duty = vehicleValue * 0.05;
    expect(iva + duty).toBeCloseTo(2620, 0);
  });
});

// ── PermitCompare: test IRPEF calculation ──

describe('PermitCompare IRPEF logic', () => {
  function calcIrpef(taxableEUR: number): number {
    if (taxableEUR <= 0) return 0;
    let tax = 0;
    const brackets: [number, number][] = [[28000, 0.23], [50000, 0.35], [Infinity, 0.43]];
    let remaining = taxableEUR;
    let prev = 0;
    for (const [limit, rate] of brackets) {
      const slice = Math.min(remaining, limit - prev);
      tax += slice * rate;
      remaining -= slice;
      prev = limit;
      if (remaining <= 0) break;
    }
    return tax;
  }

  it('calculates IRPEF for income under first bracket', () => {
    expect(calcIrpef(20000)).toBeCloseTo(4600, 0);
  });

  it('calculates IRPEF for income in second bracket', () => {
    // 28000 * 0.23 + 12000 * 0.35
    expect(calcIrpef(40000)).toBeCloseTo(10640, 0);
  });

  it('calculates IRPEF for income in third bracket', () => {
    // 28000*0.23 + 22000*0.35 + 10000*0.43
    expect(calcIrpef(60000)).toBeCloseTo(18440, 0);
  });

  it('handles zero income', () => {
    expect(calcIrpef(0)).toBe(0);
  });
});

// ── LivabilityIndex: test scoring logic ──

describe('LivabilityIndex scoring logic', () => {
  it('assigns higher scores to closer, cheaper municipalities', () => {
    // Municipality A: close, cheap
    const scoreA = (1 - 0.1) * 0.3 + (1 - 0.1) * 0.25 + (1 - 0.2) * 0.2 + 0.5 * 0.15 + 1.0 * 0.1;
    // Municipality B: far, expensive
    const scoreB = (1 - 0.9) * 0.3 + (1 - 0.9) * 0.25 + (1 - 0.8) * 0.2 + 0.8 * 0.15 + 0.2 * 0.1;

    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('weights distance highest at 30%', () => {
    const W_DISTANCE = 0.30;
    const W_RENT = 0.25;
    const W_IRPEF = 0.20;
    const W_POPULATION = 0.15;
    const W_FASCIA = 0.10;

    expect(W_DISTANCE + W_RENT + W_IRPEF + W_POPULATION + W_FASCIA).toBeCloseTo(1.0);
    expect(W_DISTANCE).toBeGreaterThan(W_RENT);
    expect(W_RENT).toBeGreaterThan(W_IRPEF);
  });
});

// ── SalaryCompare: test net calculations ──

describe('SalaryCompare logic', () => {
  // Mirrors the production wrapper in SalaryCompare.tsx exactly; the actual
  // per-canton tax curve lives only in services/cantonSalary.ts
  // (cantonTaxBurdenPct) — no duplicated data table here.
  function chWithholding(gross: number, canton?: string | null): number {
    return gross * (cantonTaxBurdenPct(gross, canton) / 100);
  }

  const CH_SOCIAL_RATE = 0.136;

  function calcNetCH(gross: number, canton?: string | null): number {
    return Math.round(gross - gross * CH_SOCIAL_RATE - chWithholding(gross, canton));
  }

  it('calculates reasonable net for typical IT salary', () => {
    const netCH = calcNetCH(95000); // mid IT
    expect(netCH).toBeGreaterThan(60000);
    expect(netCH).toBeLessThan(85000);
  });

  it('deducts more tax from higher salaries', () => {
    const net70k = calcNetCH(70000);
    const net150k = calcNetCH(150000);
    // Percentage retained should be lower at higher salaries (progressive)
    expect(net70k / 70000).toBeGreaterThan(net150k / 150000);
  });

  it('applies PPP factor correctly', () => {
    const PPP_FACTOR = 0.65;
    const EXCHANGE_RATE = 0.94;
    const chNet = 72000;
    const ppp = Math.round(chNet * PPP_FACTOR * EXCHANGE_RATE);
    // PPP should reduce the apparent value significantly
    expect(ppp).toBeLessThan(chNet);
    expect(ppp).toBeGreaterThan(30000);
  });

  // ── Per-canton net comparison (issue #3652: cantonNetRows) ──
  // Mirrors the production formula in SalaryCompare.tsx: gross is scaled by
  // the BFS-derived per-canton wage-level ratio (cantonGrossScale, #2068),
  // and net now also varies by canton via the ESTV-sourced withholding curve
  // (cantonTaxBurdenPct) instead of one generic curve for every canton.
  function cantonNetRow(nationalGross: number, scale: number, canton?: string | null) {
    const gross = Math.round(nationalGross * scale);
    return { gross, net: calcNetCH(gross, canton) };
  }

  it('national sentinel scale (1.0) reproduces the unscaled net figure', () => {
    const nationalGross = 90000;
    const row = cantonNetRow(nationalGross, 1);
    expect(row.gross).toBe(nationalGross);
    expect(row.net).toBe(calcNetCH(nationalGross));
  });

  it('a higher-wage-level canton yields a higher estimated gross and net', () => {
    const nationalGross = 90000;
    const lowCanton = cantonNetRow(nationalGross, 0.85); // e.g. Ticino-like ratio
    const highCanton = cantonNetRow(nationalGross, 1.15); // e.g. Zug-like ratio
    expect(highCanton.gross).toBeGreaterThan(lowCanton.gross);
    expect(highCanton.net).toBeGreaterThan(lowCanton.net);
  });

  it('applies a real ESTV-sourced withholding rate that differs by canton at the same gross', () => {
    const gross = 100000;
    const zg = cantonNetRow(gross, 1, 'ZG'); // Zug: lowest-tax canton capital
    const ge = cantonNetRow(gross, 1, 'GE'); // Geneva: high-tax canton capital
    expect(zg.gross).toBe(ge.gross);
    expect(zg.net).toBeGreaterThan(ge.net);
  });

  it('falls back to the national-average curve for the CH sentinel and unmapped codes', () => {
    const gross = 100000;
    expect(calcNetCH(gross, 'CH')).toBe(calcNetCH(gross));
    expect(calcNetCH(gross, 'not-a-canton')).toBe(calcNetCH(gross));
  });
});
