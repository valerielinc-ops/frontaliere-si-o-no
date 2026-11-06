import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_INPUTS } from '@/constants';
import CalcolatoreTabContent from '@/components/tabs/CalcolatoreTabContent';

const viewport = vi.hoisted(() => ({ desktop: false, setInputs: vi.fn(), fetchRate: vi.fn(async () => 1.07123) }));
vi.mock('@/services/exchangeRateService', () => ({ fetchExchangeRate: viewport.fetchRate }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => viewport.desktop }));
vi.mock('@/services/NavigationContext', () => ({ useNavigation: () => ({ calcolatoreSubTab: 'calculator' }) }));
vi.mock('@/services/TabContentContext', () => ({ useTabContent: () => ({
 inputs: DEFAULT_INPUTS, setInputs: viewport.setInputs, result: {}, isResultStale: false, handleCalculate: vi.fn(),
 showDeferredHomeWidgets: false, seoLanding: null, userProfile: null, navigateTo: vi.fn(),
}) }));
vi.mock('@/components/calculator/MobileCalcLayout', () => ({ default: () => <div data-testid="mobile-calculator" /> }));
vi.mock('@/components/calculator/InputCard', () => ({ InputCard: () => <div data-testid="desktop-input" /> }));
vi.mock('@/components/calculator/ResultsView', () => ({ ResultsView: () => <div data-testid="desktop-result" /> }));
vi.mock('@/components/shared/DesktopTopBanner', () => ({ default: () => null }));
vi.mock('@/components/shared/AdSenseBanner', () => ({ default: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('calculator responsive mounting', () => {
 it('keeps the desktop calculation subtree unmounted on mobile and restores it on resize', async () => {
  viewport.desktop = false;
  const { rerender } = render(<CalcolatoreTabContent />);
  await screen.findByTestId('mobile-calculator');
  await waitFor(() => expect(viewport.setInputs).toHaveBeenCalled());
  const updateRate = viewport.setInputs.mock.calls[0][0];
  expect(updateRate(DEFAULT_INPUTS).customExchangeRate).toBe(1.07123);
  expect(viewport.fetchRate).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('desktop-input')).not.toBeInTheDocument();
  expect(screen.queryByTestId('desktop-result')).not.toBeInTheDocument();
  viewport.desktop = true;
  rerender(<CalcolatoreTabContent />);
  await screen.findByTestId('desktop-result');
  expect(screen.getByTestId('desktop-input')).toBeInTheDocument();
  expect(screen.queryByTestId('mobile-calculator')).not.toBeInTheDocument();
  viewport.desktop = false;
  rerender(<CalcolatoreTabContent />);
  await waitFor(() => expect(screen.getByTestId('mobile-calculator')).toBeInTheDocument());
  expect(screen.queryByTestId('desktop-result')).not.toBeInTheDocument();
  expect(viewport.fetchRate).toHaveBeenCalledTimes(1);
 });
});
