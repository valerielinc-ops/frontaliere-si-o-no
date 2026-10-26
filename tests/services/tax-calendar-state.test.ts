import { describe, expect, it } from 'vitest';
import { normalizeTaxCalendarPreferences, normalizeTaxChecklistIds } from '@/services/taxCalendarState';

describe('tax calendar persisted state', () => {
  it('keeps only known checklist ids and removes duplicates', () => {
    expect(normalizeTaxChecklistIds(['d1', 'unknown', 'd1', 42, 'd2'], new Set(['d1', 'd2']))).toEqual(['d1', 'd2']);
    expect(normalizeTaxChecklistIds({ bad: true }, new Set(['d1']))).toEqual([]);
  });

  it('falls back to supported preferences only', () => {
    expect(normalizeTaxCalendarPreferences({ profile: 'nuovo', reminderEnabled: true })).toEqual({ profile: 'nuovo', reminderEnabled: true });
    expect(normalizeTaxCalendarPreferences({ profile: 'admin', reminderEnabled: 'yes' })).toEqual({ profile: 'tutti', reminderEnabled: false });
    expect(normalizeTaxCalendarPreferences([])).toEqual({ profile: 'tutti', reminderEnabled: false });
  });
});
