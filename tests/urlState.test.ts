import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encodeSimulationParams,
  decodeSimulationParams,
  buildShareURL,
  hasSimulationParams,
  cleanSimulationParams,
} from '@/services/urlStateService';
import { DEFAULT_INPUTS } from '@/constants';
import type { SimulationInputs } from '@/types';

describe('urlStateService', () => {
  // ── encodeSimulationParams ──────────────────────────────────────────

  describe('encodeSimulationParams', () => {
    it('returns empty string for default inputs', () => {
      const result = encodeSimulationParams(DEFAULT_INPUTS as SimulationInputs);
      expect(result).toBe('');
    });

    it('encodes only changed numeric fields', () => {
      const inputs = { ...DEFAULT_INPUTS, annualIncomeCHF: 85000, age: 42 } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toContain('reddito=85000');
      expect(result).toContain('eta=42');
      // Should NOT include default values
      expect(result).not.toContain('famiglia=');
      expect(result).not.toContain('figli=');
    });

    it('encodes string enum fields', () => {
      const inputs = { ...DEFAULT_INPUTS, frontierWorkerType: 'OLD' as const, maritalStatus: 'MARRIED' as const } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toContain('tipo=OLD');
      expect(result).toContain('stato=MARRIED');
    });

    it('encodes boolean fields as 1/0', () => {
      const inputs = { ...DEFAULT_INPUTS, spouseWorks: true } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toContain('coniuge-lavora=1');
    });

    it('encodes technical params only when changed', () => {
      const inputs = { ...DEFAULT_INPUTS, avsRate: 0.06 } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toContain('avs=0.06');
      // Other tech params should not appear
      expect(result).not.toContain('ac=');
      expect(result).not.toContain('laa=');
    });

    it('starts with ? when there are params', () => {
      const inputs = { ...DEFAULT_INPUTS, children: 3 } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toMatch(/^\?/);
    });

    it('encodes custom expenses as base64url', () => {
      const inputs = {
        ...DEFAULT_INPUTS,
        expensesCH: [
          { id: '1', label: 'Affitto', amount: 1500, frequency: 'MONTHLY' as const },
          { id: '2', label: 'Spesa', amount: 400, frequency: 'MONTHLY' as const },
        ],
      } as SimulationInputs;
      const result = encodeSimulationParams(inputs);
      expect(result).toContain('spese-ch=');
    });
  });

  // ── decodeSimulationParams ──────────────────────────────────────────

  describe('decodeSimulationParams', () => {
    it('returns null for empty search string', () => {
      expect(decodeSimulationParams('')).toBeNull();
    });

    it('returns null for unrelated params', () => {
      expect(decodeSimulationParams('?debug=api&status=check')).toBeNull();
    });

    it('decodes numeric fields', () => {
      const result = decodeSimulationParams('?reddito=85000&eta=42');
      expect(result).toEqual(expect.objectContaining({
        annualIncomeCHF: 85000,
        age: 42,
      }));
    });

    it('decodes string enum fields with validation', () => {
      const result = decodeSimulationParams('?tipo=OLD&stato=MARRIED&zona=OVER_20KM');
      expect(result).toEqual(expect.objectContaining({
        frontierWorkerType: 'OLD',
        maritalStatus: 'MARRIED',
        distanceZone: 'OVER_20KM',
      }));
    });

    it('rejects invalid enum values', () => {
      const result = decodeSimulationParams('?tipo=INVALID&stato=SINGLE');
      expect(result).not.toHaveProperty('frontierWorkerType');
      expect(result).toHaveProperty('maritalStatus', 'SINGLE');
    });

    it('decodes boolean fields', () => {
      const result = decodeSimulationParams('?coniuge-lavora=1');
      expect(result).toEqual(expect.objectContaining({ spouseWorks: true }));

      const result2 = decodeSimulationParams('?coniuge-lavora=0');
      expect(result2).toEqual(expect.objectContaining({ spouseWorks: false }));
    });

    it('decodes technical params', () => {
      const result = decodeSimulationParams('?avs=0.06&addizionale=0.025');
      expect(result).toEqual(expect.objectContaining({
        avsRate: 0.06,
        itAddizionaleRate: 0.025,
      }));
    });

    it('ignores NaN numeric values', () => {
      const result = decodeSimulationParams('?reddito=abc&eta=42');
      expect(result).not.toHaveProperty('annualIncomeCHF');
      expect(result).toHaveProperty('age', 42);
    });
  });

  // ── Roundtrip Tests ─────────────────────────────────────────────────

  describe('encode → decode roundtrip', () => {
    it('roundtrips user-facing fields', () => {
      const inputs = {
        ...DEFAULT_INPUTS,
        annualIncomeCHF: 85000,
        age: 28,
        children: 2,
        familyMembers: 4,
        frontierWorkerType: 'OLD' as const,
        distanceZone: 'OVER_20KM' as const,
        maritalStatus: 'MARRIED' as const,
        spouseWorks: true,
        healthInsuranceCHF: 350,
        customExchangeRate: 1.08,
        monthsBasis: 13,
        netWealthCHF: 50000,
      } as SimulationInputs;

      const encoded = encodeSimulationParams(inputs);
      const decoded = decodeSimulationParams(encoded);

      expect(decoded).toEqual(expect.objectContaining({
        annualIncomeCHF: 85000,
        age: 28,
        children: 2,
        familyMembers: 4,
        frontierWorkerType: 'OLD',
        distanceZone: 'OVER_20KM',
        maritalStatus: 'MARRIED',
        spouseWorks: true,
        healthInsuranceCHF: 350,
        customExchangeRate: 1.08,
        monthsBasis: 13,
        netWealthCHF: 50000,
      }));
    });

    it('roundtrips technical params', () => {
      const inputs = {
        ...DEFAULT_INPUTS,
        avsRate: 0.055,
        lppRate45_54: 0.08,
        itWorkDeduction: 2000,
      } as SimulationInputs;

      const encoded = encodeSimulationParams(inputs);
      const decoded = decodeSimulationParams(encoded);

      expect(decoded).toEqual(expect.objectContaining({
        avsRate: 0.055,
        lppRate45_54: 0.08,
        itWorkDeduction: 2000,
      }));
    });

    it('roundtrips expenses', () => {
      const inputs = {
        ...DEFAULT_INPUTS,
        expensesCH: [
          { id: '1', label: 'Affitto', amount: 1500, frequency: 'MONTHLY' as const },
        ],
        expensesIT: [
          { id: '2', label: 'Mutuo', amount: 800, frequency: 'MONTHLY' as const },
          { id: '3', label: 'IMU', amount: 600, frequency: 'ANNUAL' as const },
        ],
      } as SimulationInputs;

      const encoded = encodeSimulationParams(inputs);
      const decoded = decodeSimulationParams(encoded);

      expect(decoded!.expensesCH).toHaveLength(1);
      expect(decoded!.expensesCH![0]).toEqual(expect.objectContaining({
        label: 'Affitto',
        amount: 1500,
        frequency: 'MONTHLY',
      }));
      expect(decoded!.expensesIT).toHaveLength(2);
      expect(decoded!.expensesIT![1]).toEqual(expect.objectContaining({
        label: 'IMU',
        amount: 600,
        frequency: 'ANNUAL',
      }));
    });
  });

  // ── buildShareURL ───────────────────────────────────────────────────

  describe('buildShareURL', () => {
    const CANONICAL_ORIGIN = 'https://frontaliereticino.ch';

    it('builds a full URL with canonical origin and path', () => {
      const inputs = { ...DEFAULT_INPUTS, annualIncomeCHF: 90000 } as SimulationInputs;
      const url = buildShareURL(inputs, '/calcola-stipendio');
      expect(url).toContain(CANONICAL_ORIGIN);
      expect(url).toContain('/calcola-stipendio');
      expect(url).toContain('reddito=90000');
    });

    it('uses canonical origin regardless of window.location', () => {
      const inputs = { ...DEFAULT_INPUTS, children: 2 } as SimulationInputs;
      const url = buildShareURL(inputs);
      expect(url).toContain(CANONICAL_ORIGIN);
      expect(url).toContain('figli=2');
    });

    it('returns URL without query params for default inputs', () => {
      const url = buildShareURL(DEFAULT_INPUTS as SimulationInputs, '/calcola-stipendio');
      expect(url).toBe(`${CANONICAL_ORIGIN}/calcola-stipendio`);
    });
  });

  // ── hasSimulationParams ─────────────────────────────────────────────

  describe('hasSimulationParams', () => {
    it('returns false for empty search', () => {
      expect(hasSimulationParams('')).toBe(false);
    });

    it('returns false for unrelated params', () => {
      expect(hasSimulationParams('?debug=api&lang=en')).toBe(false);
    });

    it('returns true for simulation params', () => {
      expect(hasSimulationParams('?reddito=85000')).toBe(true);
      expect(hasSimulationParams('?tipo=OLD')).toBe(true);
      expect(hasSimulationParams('?spese-ch=abc')).toBe(true);
    });

    it('returns true when mixed with other params', () => {
      expect(hasSimulationParams('?debug=api&eta=42')).toBe(true);
    });
  });

  // ── cleanSimulationParams ───────────────────────────────────────────

  describe('cleanSimulationParams', () => {
    beforeEach(() => {
      // Reset URL to a known state
      window.history.replaceState(null, '', '/');
    });

    it('removes simulation params from URL', () => {
      window.history.replaceState(null, '', '/?reddito=85000&eta=42');
      cleanSimulationParams();
      expect(window.location.search).toBe('');
    });

    it('preserves non-simulation params', () => {
      window.history.replaceState(null, '', '/?debug=api&reddito=85000');
      cleanSimulationParams();
      expect(window.location.search).toBe('?debug=api');
    });

    it('does nothing when no simulation params present', () => {
      window.history.replaceState(null, '', '/?debug=api');
      cleanSimulationParams();
      expect(window.location.search).toBe('?debug=api');
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles zero values correctly', () => {
      const inputs = { ...DEFAULT_INPUTS, children: 2, netWealthCHF: 0 } as SimulationInputs;
      const encoded = encodeSimulationParams(inputs);
      // children default is 0, so 2 should appear as non-default
      expect(encoded).toContain('figli=2');
      // netWealthCHF default is 0, so it should NOT appear
      expect(encoded).not.toContain('patrimonio=');
    });

    it('handles decimal exchange rates', () => {
      const inputs = { ...DEFAULT_INPUTS, customExchangeRate: 0.9534 } as SimulationInputs;
      const encoded = encodeSimulationParams(inputs);
      const decoded = decodeSimulationParams(encoded);
      expect(decoded!.customExchangeRate).toBe(0.9534);
    });

    it('only includes fields present in URL (partial decode)', () => {
      const decoded = decodeSimulationParams('?eta=30');
      expect(decoded).toEqual({ age: 30 });
      // Should NOT include defaults for missing fields
      expect(decoded).not.toHaveProperty('annualIncomeCHF');
    });
  });
});
