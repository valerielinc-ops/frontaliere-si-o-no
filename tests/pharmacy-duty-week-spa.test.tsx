// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PharmacyDirectory from '../components/pages/PharmacyDirectory';

afterEach(cleanup);

describe('pharmacy duty week SPA route', () => {
  it('renders the five declared Ticino regions in duty tables and the source disclaimer', () => {
    render(<PharmacyDirectory page={{ kind: 'duty-week', locale: 'it', weekStart: '2026-09-14' }} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Farmacie di turno in Ticino');
    expect(screen.getByRole('heading', { name: 'Mendrisiotto' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Luganese' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bellinzonese' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Biasca e Valli' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Locarnese' })).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(5);
    expect(screen.queryByText(/Locarnese, gli altri cantoni/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ofct\.ch/ })).toHaveAttribute('href', 'https://www.ofct.ch/farmacieturno/');
  });
});
