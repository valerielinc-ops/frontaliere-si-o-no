import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/fuelPricesService', () => ({
  fetchFuelPrices: vi.fn().mockRejectedValue(new Error('offline in component test')),
  zoneFromAddress: vi.fn(() => 'chiasso'),
}));

import FuelStationMap, { type FuelStationMapPayload } from '@/components/pages/FuelStationMap';
import { fetchFuelPrices } from '@/services/fuelPricesService';

const PAYLOAD: FuelStationMapPayload = {
  locale: 'de',
  fuel: 'benzina',
  updatedAt: '2026-09-07',
  stations: [
    {
      id: 'chiasso-eni-via-foo',
      zone: 'chiasso',
      slug: 'eni-via-foo',
      name: 'Eni Chiasso',
      brand: 'Eni',
      address: 'Via Foo 1, 6830 Chiasso',
      href: '/de/benzinpreis-schweiz/chiasso/tankstellen/eni-via-foo/',
      lat: 45.84,
      lng: 9.02,
      benzinaPriceChf: 1.89,
      dieselPriceChf: 1.98,
    },
    {
      id: 'lugano-tamoil-via-bar',
      zone: 'lugano',
      slug: 'tamoil-via-bar',
      name: 'Tamoil Lugano',
      brand: 'Tamoil',
      address: 'Via Bar 2, 6900 Lugano',
      href: '/de/benzinpreis-schweiz/lugano/tankstellen/tamoil-via-bar/',
      lat: 46.01,
      lng: 8.95,
      benzinaPriceChf: 1.94,
      dieselPriceChf: 2.04,
    },
  ],
};

describe('FuelStationMap', () => {
  it('renders the map, live price list and station actions from the static payload', async () => {
    render(<FuelStationMap payload={PAYLOAD} />);

    await waitFor(() => {
      expect(screen.getByText(/2 Tankstellen/)).toBeInTheDocument();
      expect(screen.getByText('Statischer Tagesstand')).toBeInTheDocument();
    });
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(2);
    expect(screen.getAllByText(/1[,.]89 CHF\/L/)).not.toHaveLength(0);
    expect(screen.getByText('Eni')).toBeInTheDocument();
    expect(screen.getByText('Tamoil')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Preisseite öffnen/ })).toHaveLength(4);
    expect(screen.getAllByRole('link', { name: /Route/ })[0]).toHaveAttribute('target', '_blank');

  });

  it('filters both the list and map markers by zone and search', async () => {
    render(<FuelStationMap payload={PAYLOAD} />);
    await waitFor(() => expect(screen.getByText(/2 Tankstellen/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Chiasso' }));
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(1);
    expect(screen.getByText('Eni')).toBeInTheDocument();
    expect(screen.queryByText('Tamoil')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Alle Regionen' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Tankstelle oder Ort suchen' }), { target: { value: 'Lugano' } });
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(1);
    expect(screen.getByText('Tamoil')).toBeInTheDocument();
    expect(screen.queryByText('Eni')).not.toBeInTheDocument();
  });

  it('merges live prices only into stations with an emitted SEO link', async () => {
    vi.mocked(fetchFuelPrices).mockResolvedValueOnce({
      generatedAt: '2026-09-08T08:00:00.000Z',
      municipalities: [{
        swiss: {
          nearbyStations: [
            {
              id: 'eni-live',
              name: 'Eni Chiasso',
              brand: 'Eni',
              address: 'Via Foo 1, 6830 Chiasso',
              lat: 45.841,
              lng: 9.021,
              sp95PriceChf: 1.85,
            },
            {
              id: 'new-station',
              name: 'Nuova stazione',
              brand: 'Nuovo',
              address: 'Via Nuova 1, 6830 Chiasso',
              lat: 45.842,
              lng: 9.022,
              sp95PriceChf: 1.7,
            },
          ],
        },
      }],
    } as never);

    render(<FuelStationMap payload={PAYLOAD} />);

    await waitFor(() => expect(screen.getByText(/2 Tankstellen/)).toBeInTheDocument());
    expect(screen.getAllByText(/1[,.]85 CHF\/L/)).not.toHaveLength(0);
    expect(screen.queryByText('Nuova')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(2);
  });
});
