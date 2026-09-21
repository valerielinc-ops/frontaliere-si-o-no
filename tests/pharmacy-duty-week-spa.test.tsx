// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PharmacyDirectory from '../components/pages/PharmacyDirectory';
import {
  buildDutyWeekModel,
  currentDutyWeekStart,
} from '../services/pharmacies/dutyWeek';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import catalogueJson from '../data/pharmacies-ticino-complete.json';

afterEach(cleanup);

describe('pharmacy duty week SPA route', () => {
  it('renders the five declared Ticino regions in duty tables and the source disclaimer', () => {
    const weekStart = currentDutyWeekStart();
    const model = buildDutyWeekModel(dutiesJson, weekStart, {
      catalogue: catalogueJson,
    });

    render(<PharmacyDirectory page={{ kind: 'duty-week', locale: 'it', weekStart }} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Farmacie di turno in Ticino');
    expect(screen.getByRole('heading', { name: 'Mendrisiotto' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Luganese' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bellinzonese' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Biasca e Valli' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Locarnese' })).toBeInTheDocument();
    expect(screen.queryAllByRole('table')).toHaveLength(model.indexable ? 5 : 0);
    expect(screen.queryByText(/Locarnese, gli altri cantoni/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ofct\.ch/ })).toHaveAttribute('href', 'https://www.ofct.ch/farmacieturno/');
  });
});
