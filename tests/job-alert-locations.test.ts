import { describe, expect, it } from 'vitest';
import {
  getJobAlertLocationLabel,
  normalizeJobAlertLocationValue,
  normalizeJobAlertLocationValues,
} from '@/services/jobAlertLocations';

describe('job alert location values', () => {
  it.each([
    ['Lugano', 'lugano'],
    ['LUGANO', 'lugano'],
    ['Basel', 'basel'],
    ['Zürich', 'zurich'],
    ['Coira / Chur', 'coira'],
    ['Chur', 'coira'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeJobAlertLocationValue(input)).toBe(expected);
  });

  it('deduplicates route labels and canonical slugs before they enter state', () => {
    expect(normalizeJobAlertLocationValues(['Lugano', 'lugano', 'Basel', ''])).toEqual([
      'lugano',
      'basel',
    ]);
  });

  it('keeps display labels separate from stored values', () => {
    expect(getJobAlertLocationLabel('lugano')).toBe('Lugano');
    expect(getJobAlertLocationLabel('basel')).toBe('Basel');
  });
});
