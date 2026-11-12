import { describe, expect, it } from 'vitest';
import { buildSwissCityMapHref } from '../services/jobMapRoutes';
import { buildPath } from '../services/router';

describe('buildSwissCityMapHref', () => {
  it('uses the five supported legacy Ticino city routes', () => {
    expect(buildSwissCityMapHref('TI', 'Lugano', 'it')).toBe(buildPath({
      activeTab: 'job-board',
      jobBoardCanton: 'TI',
      jobBoardCity: 'lugano',
    }, 'it'));
  });

  it('does not create a query link for Ticino municipalities without a dedicated route', () => {
    expect(buildSwissCityMapHref('TI', 'Stabio', 'it')).toBeNull();
  });

  it('uses the data-driven city route for a municipality in another canton', () => {
    expect(buildSwissCityMapHref('ZH', 'Zürich', 'de')).toBe(buildPath({
      activeTab: 'job-board',
      jobBoardCanton: 'ZH',
      jobBoardCity: 'zurich',
    }, 'de'));
  });
});
