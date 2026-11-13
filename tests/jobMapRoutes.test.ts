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

  it('uses the data-driven city route for a municipality in Ticino', () => {
    expect(buildSwissCityMapHref('TI', 'Stabio', 'it')).toBe(buildPath({
      activeTab: 'job-board',
      jobBoardCanton: 'TI',
      jobBoardCity: 'stabio',
    }, 'it'));
  });

  it('uses the data-driven city route for a municipality in another canton', () => {
    expect(buildSwissCityMapHref('ZH', 'Zürich', 'de')).toBe(buildPath({
      activeTab: 'job-board',
      jobBoardCanton: 'ZH',
      jobBoardCity: 'zurich',
    }, 'de'));
  });

  it('falls back when a locality has no canonical city hub', () => {
    expect(buildSwissCityMapHref('ZH', 'Not a Zurich municipality', 'de')).toBeNull();
  });

  it('does not infer a canton when the canton code is empty', () => {
    expect(buildSwissCityMapHref('', 'Zürich', 'de')).toBeNull();
  });
});
