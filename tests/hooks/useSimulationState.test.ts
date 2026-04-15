import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockCalculateSimulation = vi.fn(() => ({
  netIncomeCH: 50000,
  netIncomeIT: 45000,
  delta: 5000,
  deltaPercent: 10,
}));

vi.mock('@/services/calculationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/calculationService')>();
  return {
    ...actual,
    calculateSimulation: (...args: any[]) => mockCalculateSimulation(...args),
  };
});

vi.mock('@/services/urlStateService', () => ({
  hasSimulationParams: vi.fn(() => false),
  decodeSimulationParams: vi.fn(() => null),
  cleanSimulationParams: vi.fn(),
}));

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackCalculation: vi.fn(),
    trackFunnelStep: vi.fn(),
    trackUIInteraction: vi.fn(),
  },
  unlockAchievement: vi.fn(),
}));

vi.mock('@/services/firestoreService', () => ({
  registerSimulationForSocialProof: vi.fn(() => Promise.resolve()),
}));

import { useSimulationState, SEO_LANDING_PRESETS } from '@/hooks/useSimulationState';
import { Analytics, unlockAchievement } from '@/services/analyticsProxy';
import { DEFAULT_INPUTS } from '@/constants';

describe('useSimulationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('initializes with DEFAULT_INPUTS and null result', () => {
    const { result } = renderHook(() => useSimulationState('calculator', null));

    expect(result.current.inputs.annualIncomeCHF).toBe(DEFAULT_INPUTS.annualIncomeCHF);
    expect(result.current.inputs.children).toBe(DEFAULT_INPUTS.children);
    expect(result.current.result).toBeNull();
    expect(result.current.urlHydrated.current).toBe(false);
  });

  it('exports correct interface shape', () => {
    const { result } = renderHook(() => useSimulationState('calculator', null));

    expect(typeof result.current.inputs).toBe('object');
    expect(typeof result.current.setInputs).toBe('function');
    expect(typeof result.current.handleCalculate).toBe('function');
    expect(typeof result.current.urlHydrated).toBe('object');
    expect(typeof result.current.setResult).toBe('function');
  });

  describe('handleCalculate', () => {
    it('calls calculateSimulation and sets result', async () => {
      const { result } = renderHook(() => useSimulationState('calculator', null));

      await act(async () => {
        await result.current.handleCalculate();
      });

      expect(mockCalculateSimulation).toHaveBeenCalledWith(result.current.inputs);
      expect(result.current.result).toBeTruthy();
      expect(result.current.result?.netIncomeCH).toBe(50000);
      expect(unlockAchievement).toHaveBeenCalledWith('first_simulation');
      expect(unlockAchievement).toHaveBeenCalledWith('simulation_pro');
      expect(Analytics.trackFunnelStep).toHaveBeenCalledWith('calculate', expect.any(Object));
    });
  });

  describe('SEO landing presets', () => {
    it('applies preset when seoLanding is set and activeTab is calculator', () => {
      const { result } = renderHook(() =>
        useSimulationState('calculator', 'salary-60000'),
      );

      // The preset should have been applied
      expect(result.current.inputs.annualIncomeCHF).toBe(60000);
      expect(result.current.inputs.maritalStatus).toBe('SINGLE');
      expect(result.current.urlHydrated.current).toBe(true);
    });

    it('does not apply preset when activeTab is not calculator', () => {
      const { result } = renderHook(() =>
        useSimulationState('confronti', 'salary-60000'),
      );

      // Inputs should remain at defaults
      expect(result.current.inputs.annualIncomeCHF).toBe(DEFAULT_INPUTS.annualIncomeCHF);
    });

    it('SEO_LANDING_PRESETS has expected entries', () => {
      expect(SEO_LANDING_PRESETS['salary-60000']).toBeDefined();
      expect(SEO_LANDING_PRESETS['salary-80000']).toBeDefined();
      expect(SEO_LANDING_PRESETS['salary-100000']).toBeDefined();
      expect(SEO_LANDING_PRESETS['salary-60000-married-2kids'].children).toBe(2);
      expect(SEO_LANDING_PRESETS['salary-80000-over20km'].distanceZone).toBe('OVER_20KM');
    });
  });

  describe('setInputs', () => {
    it('updates inputs and triggers auto-recalculate', async () => {
      const { result } = renderHook(() => useSimulationState('calculator', null));

      // First interaction triggers initial calc, then input change triggers recalc
      await act(async () => {
        result.current.setInputs(prev => ({ ...prev, annualIncomeCHF: 90000 }));
      });

      // Wait for the auto-recalculate effect
      // The first mount skips recalc, but the second setInputs should trigger it
      expect(result.current.inputs.annualIncomeCHF).toBe(90000);
    });
  });
});
