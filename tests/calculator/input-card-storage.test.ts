// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUTS } from '@/constants';
import { InputCard } from '@/components/calculator/InputCard';
import {
 readBestEffortLocalStorage,
 writeBestEffortLocalStorage,
} from '@/services/storageAvailability';

vi.mock('@/services/i18n', () => ({
 useTranslation: () => ({
  t: (key: string) => key,
  locale: 'it',
 }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/services/NavigationContext', () => ({ useNavigationOptional: () => ({ isFocusMode: false }) }));
vi.mock('@/components/calculator/ProfessionPresetChips', () => ({ default: () => null }));
vi.mock('@/components/shared/CalculatorFormBoxAd', () => ({ default: () => null }));

const INPUT_CARD_SOURCE = readFileSync(
 resolve(__dirname, '..', '..', 'components/calculator/InputCard.tsx'),
 'utf8',
);
const PERMIT_COMPARE_SOURCE = readFileSync(
 resolve(__dirname, '..', '..', 'components/guide/PermitCompare.tsx'),
 'utf8',
);

afterEach(() => {
 cleanup();
 window.localStorage.clear();
});

describe('calculator input storage', () => {
 it('reads and writes the persisted value when browser storage is available', () => {
  const key = 'calculator-input-storage-available';

  writeBestEffortLocalStorage(key, '1');

  expect(window.localStorage.getItem(key)).toBe('1');
  expect(readBestEffortLocalStorage(key)).toBe('1');
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
   expect(readBestEffortLocalStorage('calculator-input-storage-unavailable-before-write')).toBeNull();
   expect(() => writeBestEffortLocalStorage('calculator-input-storage-unavailable', '1')).not.toThrow();
   expect(readBestEffortLocalStorage('calculator-input-storage-unavailable')).toBe('1');
  } finally {
   Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: originalStorage,
   });
  }
 });
});

describe('InputCard with unavailable browser storage', () => {
 it('renders and keeps the desktop expansion interaction usable when storage throws', () => {
  const originalStorage = window.localStorage;
  const getItem = vi.fn(() => { throw new Error('storage unavailable'); });
  const setItem = vi.fn(() => { throw new Error('quota exceeded'); });
  const unavailableStorage = { getItem, setItem } as unknown as Storage;

  Object.defineProperty(window, 'localStorage', {
   configurable: true,
   value: unavailableStorage,
  });

  try {
   expect(() => render(React.createElement(InputCard, {
    inputs: DEFAULT_INPUTS,
    setInputs: vi.fn(),
    onCalculate: vi.fn(),
    exchangeRate: { fetchRate: vi.fn(), loadingRate: false, lastRateUpdate: null } as never,
   }))).not.toThrow();

   const expand = screen.getByRole('button', { name: 'input.compact.expandCta' });
   fireEvent.click(expand);

   expect(screen.queryByRole('button', { name: 'input.compact.expandCta' })).toBeNull();
   expect(setItem).toHaveBeenCalledWith('calc_desktop_expanded', '1');
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
  expect(INPUT_CARD_SOURCE).toContain('readBestEffortLocalStorage(DESKTOP_EXPANDED_KEY)');
  expect(INPUT_CARD_SOURCE).toContain('writeBestEffortLocalStorage(DESKTOP_EXPANDED_KEY, \'1\')');
  expect(INPUT_CARD_SOURCE).toContain('if (readBestEffortLocalStorage(key)) return;');
  expect(INPUT_CARD_SOURCE).toContain('writeBestEffortLocalStorage(key, \'1\')');
  expect(INPUT_CARD_SOURCE).not.toContain('localStorage.getItem');
  expect(INPUT_CARD_SOURCE).not.toContain('localStorage.setItem');
  expect(PERMIT_COMPARE_SOURCE).toContain('if (readBestEffortLocalStorage(key)) return;');
  expect(PERMIT_COMPARE_SOURCE).toContain('writeBestEffortLocalStorage(key, \'1\')');
  expect(PERMIT_COMPARE_SOURCE).not.toContain('localStorage.getItem');
  expect(PERMIT_COMPARE_SOURCE).not.toContain('localStorage.setItem');
 });
});
