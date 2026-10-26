// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
 readCalculatorInputStorage,
 writeCalculatorInputStorage,
} from '@/services/calculatorInputStorage';

const INPUT_CARD_SOURCE = readFileSync(
 resolve(__dirname, '..', '..', 'components/calculator/InputCard.tsx'),
 'utf8',
);

afterEach(() => {
 window.localStorage.clear();
});

describe('calculator input storage', () => {
 it('reads and writes the persisted value when browser storage is available', () => {
  const key = 'calculator-input-storage-available';

  writeCalculatorInputStorage(key, '1');

  expect(window.localStorage.getItem(key)).toBe('1');
  expect(readCalculatorInputStorage(key)).toBe('1');
 });

 it('keeps calculator preferences usable when browser storage throws', () => {
  const originalStorage = window.localStorage;
  const unavailableStorage = {
   getItem: () => { throw new Error('storage unavailable'); },
   setItem: () => { throw new Error('quota exceeded'); },
  } as unknown as Storage;

  Object.defineProperty(window, 'localStorage', {
   configurable: true,
   value: unavailableStorage,
  });

  try {
   expect(readCalculatorInputStorage('calculator-input-storage-unavailable-before-write')).toBeNull();
   expect(() => writeCalculatorInputStorage('calculator-input-storage-unavailable', '1')).not.toThrow();
   expect(readCalculatorInputStorage('calculator-input-storage-unavailable')).toBe('1');
  } finally {
   Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: originalStorage,
   });
  }
 });
});

describe('InputCard storage wiring', () => {
 it('routes initialization, preference writes, and easter-egg deduplication through the safe accessors', () => {
  expect(INPUT_CARD_SOURCE).toContain('readCalculatorInputStorage(DESKTOP_EXPANDED_KEY)');
  expect(INPUT_CARD_SOURCE).toContain('writeCalculatorInputStorage(DESKTOP_EXPANDED_KEY, \'1\')');
  expect(INPUT_CARD_SOURCE).toContain('if (readCalculatorInputStorage(key)) return;');
  expect(INPUT_CARD_SOURCE).toContain('writeCalculatorInputStorage(key, \'1\')');
  expect(INPUT_CARD_SOURCE).not.toContain('localStorage.getItem');
  expect(INPUT_CARD_SOURCE).not.toContain('localStorage.setItem');
 });
});
