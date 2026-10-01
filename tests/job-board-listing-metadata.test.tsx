import { afterEach, describe, expect, it } from 'vitest';
import { buildJobBoardListingMetadata, getRenderedJobBoardCount, updateJobBoardListingMetadata } from '../services/seo/jobBoardListingMetadata';
import { selectJobBoardInventory } from '../services/jobBoardInventory';

afterEach(() => { document.head.innerHTML = ''; });

describe('job-board inventory metadata', () => {
  it('scopes canton groups and national totals using the same stable listing identities', () => {
    const jobs = [{ id: 'bs', canton: 'BS' }, { id: 'bl', canton: 'BL' }, { id: 'ti', canton: 'TI' }, { id: 'bs', canton: 'BS' }];
    expect(selectJobBoardInventory(jobs, 'BASILEA').map((job) => job.id)).toEqual(['bs', 'bl']);
    expect(selectJobBoardInventory(jobs, 'TI')).toHaveLength(1);
    expect(selectJobBoardInventory(jobs, '_AGGREGATE_')).toHaveLength(3);
  });

  it('updates title, description and social metadata from the rendered results', () => {
    window.history.replaceState({}, '', '/en/find-jobs-zurich/');
    updateJobBoardListingMetadata('en', 'ZH', 17);
    const expected = buildJobBoardListingMetadata('en', 'ZH', 17);
    expect(document.title).toBe(expected.title);
    expect(document.title).toContain('17');
    expect(document.title).toContain('Zürich');
    expect(document.title).not.toContain('Swiss Italy');
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(expected.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(expected.description);
    expect(getRenderedJobBoardCount(window.location.pathname)).toBe(17);
  });

  it('preserves a confirmed empty result count and the geographic scope', () => {
    window.history.replaceState({}, '', '/cerca-lavoro-svizzera/');
    updateJobBoardListingMetadata('it', '_AGGREGATE_', 0);
    expect(getRenderedJobBoardCount(window.location.pathname)).toBe(0);
    expect(document.title).toContain('Svizzera');
    expect(document.title).not.toContain('_AGGREGATE_');
  });
});
