import { describe, expect, it } from 'vitest';
import { isListingInventoryJob, normalizeListingIdentity, selectJobBoardInventory } from '../services/jobBoardInventory';

const valid = { id: 'one', title: 'Ingegnere', company: 'Esempio SA', canton: 'ZH', location: 'Zürich' };

describe('shared job listing eligibility', () => {
  it('requires a real title and company but not a description or locality', () => {
    expect(isListingInventoryJob(valid)).toBe(true);
    expect(isListingInventoryJob({ ...valid, location: undefined })).toBe(true);
    for (const job of [null, undefined, false, {}, { ...valid, company: undefined },
      { ...valid, company: '  ' }, { ...valid, title: '' }, { ...valid, title: 4 }]) {
      expect(isListingInventoryJob(job)).toBe(false);
    }
  });

  it('preserves foreign-city exclusions, Swiss exceptions and locality precedence', () => {
    expect(isListingInventoryJob({ ...valid, location: 'London' })).toBe(false);
    expect(isListingInventoryJob({ ...valid, location: 'Zürich', addressLocality: 'London' })).toBe(false);
    expect(isListingInventoryJob({ ...valid, location: 'London', addressLocality: 'Zürich' })).toBe(true);
    for (const location of ['Münchenstein', 'Münchenbuchsee', 'Münchenwiler', 'Romanshorn', 'Romandie']) {
      expect(isListingInventoryJob({ ...valid, location })).toBe(true);
    }
  });

  it('keeps a stable fallback identity and route before locale flattening', () => {
    const raw = { title: 'Cuoco', company: 'Acme' };
    expect(normalizeListingIdentity(raw)).toMatchObject({ ...raw, id: expect.stringMatching(/^listing-[a-f0-9]{64}$/), slug: 'cuoco-acme-ticino' });
    expect(normalizeListingIdentity(raw).id).toBe(normalizeListingIdentity({ ...raw, location: 'Zürich' }).id);
    const unsafe = normalizeListingIdentity({ title: 'Developer (m/f/d) #1?'.repeat(30), company: 'Acme' });
    expect(unsafe.id).toMatch(/^listing-[a-f0-9]{64}$/);
    expect(normalizeListingIdentity({ ...raw, slug: 'existing' })).toMatchObject({ id: 'existing', slug: 'existing' });
  });

  it('deduplicates eligible members without mutating the input and keeps listing-only jobs', () => {
    const jobs = Object.freeze([valid, { ...valid, id: 'missing', company: '' }, valid,
      { ...valid, id: 'other', canton: 'TI' }]);
    expect(selectJobBoardInventory(jobs, 'ZH')).toEqual([valid]);
    expect(selectJobBoardInventory(jobs, '_AGGREGATE_')).toHaveLength(2);
    expect(jobs).toHaveLength(4);
    expect(selectJobBoardInventory([], 'ZH')).toEqual([]);
    expect(selectJobBoardInventory([{ ...valid, canton: 'BL' }, { ...valid, id: 'bs', canton: 'BS' }], 'BASILEA')).toHaveLength(2);
  });
});
