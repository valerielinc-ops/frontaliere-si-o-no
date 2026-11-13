// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import municipalityMapData from '../data/swiss-municipality-map.json';
import { CANTON_CODES } from '../services/cantonList';
import {
  SwissBubbleMap,
  type CantonJobsData,
  type SwissBubbleMapCopy,
} from '../components/community/SwissBubbleMap';

afterEach(cleanup);

const cantons: CantonJobsData[] = (municipalityMapData.cantons as Array<{ code: string; commonsFile: string }>).map(({ code }) => ({
  cantonCode: code,
  name: code === 'TI' ? 'Ticino' : code === 'ZH' ? 'Zurigo' : code,
  count: code === 'TI' ? 8 : code === 'ZH' ? 42 : 0,
  href: `/cerca-lavoro-svizzera/${code.toLowerCase()}/`,
}));

const copy: SwissBubbleMapCopy = {
  allCantonsHeading: 'Cantoni della Confederazione',
  cantonHeading: (name) => `Comuni con offerte in ${name}`,
  cantonsHeading: 'Tutti i cantoni',
  municipalitiesHeading: 'Comuni con offerte',
  municipalityCount: (count) => `${count} comuni`,
  municipalLogoNote: 'Logo comunale ufficiale; stemma del comune attuale non disponibile.',
  offerCount: (count) => `${count} offerte`,
  viewJobs: 'Visualizza lavori',
  noMunicipalities: 'Nessun comune con offerte.',
  unmappedOffers: (count) => `${count} offerte non localizzate.`,
  closeDetails: (name) => `Chiudi i dettagli di ${name}`,
  mapAriaLabel: 'Mappa della Svizzera',
  cantonsListAriaLabel: 'Elenco dei cantoni',
  municipalitiesListAriaLabel: 'Elenco dei comuni',
  swisstopoAttribution: 'Confini: swisstopo',
  commonsAttribution: 'Stemmi: Wikimedia Commons',
  symbolSource: 'Fonte del simbolo',
};

const totalJobsByCanton = Object.fromEntries(cantons.map(({ cantonCode, count }) => [cantonCode, count]));
const buildCityHref = vi.fn((cantonCode: string, cityName: string) => `/cerca-lavoro-svizzera/${cantonCode.toLowerCase()}/${cityName.toLowerCase()}/`);
const onViewCityJobs = vi.fn();

describe('SwissBubbleMap', () => {
  it('shows all 26 cantons with their symbols and canonical job links', () => {
    render(
      <SwissBubbleMap
        mode="national"
        cantonCodes={[...CANTON_CODES]}
        cantons={cantons}
        cities={[]}
        totalJobsByCanton={totalJobsByCanton}
        locale="it"
        copy={copy}
        buildCityHref={buildCityHref}
        onViewCityJobs={onViewCityJobs}
      />,
    );

    expect(CANTON_CODES).toHaveLength(26);
    expect(screen.getByRole('region', { name: 'Mappa della Svizzera' })).toBeTruthy();
    expect(screen.getAllByTestId(/^map-marker-canton-/)).toHaveLength(26);
    expect(screen.getAllByRole('link', { name: /Visualizza lavori:/i })).toHaveLength(26);
    expect(screen.getByTestId('map-marker-canton-ZH')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Elenco dei cantoni' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Visualizza lavori: Zurigo' }).getAttribute('href')).toBe('/cerca-lavoro-svizzera/zh/');
  });

  it('matches a job locality to the current official municipality and links to its city route', () => {
    render(
      <SwissBubbleMap
        mode="canton"
        cantonCodes={['TI']}
        cantons={cantons}
        cities={[{ cantonCode: 'TI', name: 'Lugano', count: 8 }]}
        totalJobsByCanton={{ TI: 10 }}
        locale="it"
        copy={copy}
        buildCityHref={buildCityHref}
        onViewCityJobs={onViewCityJobs}
      />,
    );

    const lugano = screen.getByTestId('map-marker-municipality-5192');
    fireEvent.click(lugano);

    expect(lugano.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Lugano' })).toBeTruthy();
    expect(screen.getByTestId('swiss-map-canvas').contains(screen.getByTestId('map-marker-details'))).toBe(false);
    expect(within(screen.getByTestId('map-marker-details')).getByRole('link', { name: 'Visualizza lavori' }).getAttribute('href')).toBe('/cerca-lavoro-svizzera/ti/lugano/');
    expect(screen.getByRole('link', { name: 'Visualizza lavori: Lugano' }).getAttribute('href')).toBe('/cerca-lavoro-svizzera/ti/lugano/');
    expect(buildCityHref).toHaveBeenCalledWith('TI', 'Lugano');
    expect(screen.getByText('2 offerte non localizzate.')).toBeTruthy();
  });

  it('explains when a canton has no municipality-level job locations', () => {
    render(
      <SwissBubbleMap
        mode="canton"
        cantonCodes={['TI']}
        cantons={cantons}
        cities={[]}
        totalJobsByCanton={{ TI: 0 }}
        locale="it"
        copy={copy}
        buildCityHref={buildCityHref}
        onViewCityJobs={onViewCityJobs}
      />,
    );

    expect(screen.getByText('Nessun comune con offerte.')).toBeTruthy();
  });

  it('labels the official Haute-Ajoie logo where the current commune has no shared coat of arms', () => {
    render(
      <SwissBubbleMap
        mode="canton"
        cantonCodes={['JU']}
        cantons={cantons}
        cities={[{ cantonCode: 'JU', name: 'Haute-Ajoie', count: 3 }]}
        totalJobsByCanton={{ JU: 3 }}
        locale="it"
        copy={copy}
        buildCityHref={buildCityHref}
        onViewCityJobs={onViewCityJobs}
      />,
    );

    fireEvent.click(screen.getByTestId('map-marker-municipality-6809'));
    expect(within(screen.getByTestId('map-marker-details')).getByText(copy.municipalLogoNote)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Elenco dei comuni' })).getByText(copy.municipalLogoNote)).toBeTruthy();
  });

  it('uses a local action for a municipality without a canonical page', () => {
    const viewJobs = vi.fn();
    render(
      <SwissBubbleMap
        mode="canton"
        cantonCodes={['TI']}
        cantons={cantons}
        cities={[{ cantonCode: 'TI', name: 'Stabio', count: 3 }]}
        totalJobsByCanton={{ TI: 3 }}
        locale="it"
        copy={copy}
        buildCityHref={() => null}
        onViewCityJobs={viewJobs}
      />,
    );

    fireEvent.click(screen.getByTestId('map-marker-municipality-5266'));
    expect(screen.queryByRole('link', { name: /Visualizza lavori/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Visualizza lavori: Stabio/i }));
    expect(viewJobs).toHaveBeenCalledWith('TI', 'Stabio');
  });

  it('keeps a current official symbol and coordinates for every BFS municipality', () => {
    const municipalities = municipalityMapData.municipalities;
    const codes = municipalities.map(({ bfsCode }) => bfsCode);

    expect(municipalityMapData.municipalityCount).toBe(2110);
    expect(new Set(codes).size).toBe(2110);
    expect(municipalityMapData.cantons).toHaveLength(26);
    expect(municipalities.every(({ lat, lng, commonsFile, imageUrl }) => (
      Number.isFinite(lat)
      && Number.isFinite(lng)
      && Boolean(commonsFile || imageUrl)
    ))).toBe(true);
    expect(municipalities.filter(({ kind }) => kind === 'municipal-logo')).toHaveLength(1);
  });
});
