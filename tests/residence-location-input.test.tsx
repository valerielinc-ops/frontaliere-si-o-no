import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
vi.mock('@/services/i18n', () => ({ useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }) }));
const loader = vi.hoisted(() => vi.fn());
vi.mock('@/services/residenceLocalities', async importOriginal => ({ ...await importOriginal<any>(), loadResidenceLocalities: loader }));
import ResidenceLocationInput from '../components/community/ResidenceLocationInput';
function Form({ initial = '' }) { const [value, setValue] = useState(initial); return <><ResidenceLocationInput value={value} onChange={setValue} /><output data-testid="saved">{value}</output></>; }
afterEach(() => { cleanup(); loader.mockReset(); });

it('selects an accented town by keyboard and keeps the explicit country on save', async () => {
  loader.mockResolvedValue(['Tiranë (Tirana)']);
  render(<Form />);
  fireEvent.change(screen.getByLabelText('jobBoard.concierge.residenceCountry'), { target: { value: 'AL' } });
  await waitFor(() => expect(loader).toHaveBeenCalledWith('AL'));
  const town = screen.getByLabelText('jobBoard.concierge.location');
  fireEvent.change(town, { target: { value: 'Tirane' } });
  await screen.findByRole('option', { name: 'Tiranë (Tirana)' });
  fireEvent.keyDown(town, { key: 'ArrowDown' }); fireEvent.keyDown(town, { key: 'Enter' });
  expect(screen.getByTestId('saved').textContent).toBe('Tiranë (Tirana), Albania');
});

it('keeps a failed catalogue usable with a manually entered town and clears it on a country switch', async () => {
  loader.mockRejectedValue(new Error('offline'));
  render(<Form initial="Como, Italia" />);
  await screen.findByText('jobBoard.concierge.residenceUnavailable');
  fireEvent.change(screen.getByLabelText('jobBoard.concierge.location'), { target: { value: 'Unlisted village' } });
  expect(screen.getByTestId('saved').textContent).toBe('Unlisted village, Italia');
  fireEvent.change(screen.getByLabelText('jobBoard.concierge.residenceCountry'), { target: { value: 'FR' } });
  expect(screen.getByLabelText('jobBoard.concierge.location')).toHaveValue('');
  expect(screen.getByTestId('saved').textContent).toBe('');
});

it('ignores a late country catalogue after the user has chosen another country', async () => {
  let finish!: (value: string[]) => void;
  loader.mockImplementation((country: string) => country === 'IT' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(['Paris']));
  render(<Form initial="Como, Italia" />);
  fireEvent.change(screen.getByLabelText('jobBoard.concierge.residenceCountry'), { target: { value: 'FR' } });
  await waitFor(() => expect(loader).toHaveBeenCalledWith('FR'));
  finish(['Milano']);
  fireEvent.change(screen.getByLabelText('jobBoard.concierge.location'), { target: { value: 'Mi' } });
  await waitFor(() => expect(screen.queryByRole('option', { name: 'Milano' })).toBeNull());
});


it('disables both controls during a save and exposes the existing field validation error', () => {
  loader.mockResolvedValue([]);
  render(<ResidenceLocationInput value="Como, Italia" onChange={() => {}} disabled error="Check the residence" />);
  expect(screen.getByLabelText('jobBoard.concierge.residenceCountry')).toBeDisabled();
  expect(screen.getByLabelText('jobBoard.concierge.location')).toBeDisabled();
  expect(screen.getByLabelText('jobBoard.concierge.location')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('Check the residence');
});
