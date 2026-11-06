import { describe, expect, it } from 'vitest';
import {
 normalizeTaxChecklistCompletedIds,
 normalizeTaxChecklistPreferences,
 parseTaxChecklistCompletedIds,
 parseTaxChecklistPreferences,
} from '@/services/taxCalendarState';

const DEADLINE_IDS = new Set(['d1', 'd2', 'h1']);

describe('TaxCalendar persisted checklist state', () => {
  it('keeps only unique, non-empty catalog ids', () => {
    expect(normalizeTaxChecklistCompletedIds(
      ['d2', ' ', 'unknown', 42, ' d1 ', 'd2', null],
      DEADLINE_IDS,
    )).toEqual(['d2', 'd1']);
  });

  it('falls back to an empty completion list for malformed or non-array blobs', () => {
    expect(parseTaxChecklistCompletedIds('{not-json}', DEADLINE_IDS)).toEqual([]);
    expect(parseTaxChecklistCompletedIds(JSON.stringify({ d1: true }), DEADLINE_IDS)).toEqual([]);
  });

  it('accepts only supported profiles while preserving a valid reminder flag', () => {
    expect(normalizeTaxChecklistPreferences({ profile: 'unknown', reminderEnabled: true })).toEqual({
      profile: 'tutti',
      reminderEnabled: true,
    });
    expect(normalizeTaxChecklistPreferences({ profile: 'vecchio', reminderEnabled: false })).toEqual({
      profile: 'vecchio',
      reminderEnabled: false,
    });
  });

  it('uses safe defaults for malformed preferences and non-boolean reminders', () => {
    expect(parseTaxChecklistPreferences('{not-json}')).toEqual({
      profile: 'tutti',
      reminderEnabled: false,
    });
    expect(normalizeTaxChecklistPreferences({ profile: 'nuovo', reminderEnabled: 'yes' })).toEqual({
      profile: 'nuovo',
      reminderEnabled: false,
    });
  });
});
