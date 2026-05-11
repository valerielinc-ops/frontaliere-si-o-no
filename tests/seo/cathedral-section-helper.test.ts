import { describe, it, expect } from 'vitest';
import { resolveCantonSection, resolveJobCanton } from '../../build-plugins/shared/cantonSection';

describe('resolveCantonSection — TI legacy invariance', () => {
  it.each(['it','en','de','fr'] as const)('TI returns frozen legacy slug for %s', (locale) => {
    const legacy = { it: 'cerca-lavoro-ticino', en: 'find-jobs-ticino', de: 'jobs-im-tessin', fr: 'trouver-emploi-tessin' } as const;
    expect(resolveCantonSection(locale, 'TI')).toBe(legacy[locale]);
  });
});

describe('resolveCantonSection — canton-aware emission', () => {
  it('ZH IT → cerca-lavoro-zurigo', () => {
    expect(resolveCantonSection('it', 'ZH')).toBe('cerca-lavoro-zurigo');
  });
  it('AG DE → jobs-im-aargau (definite article preserved)', () => {
    expect(resolveCantonSection('de', 'AG')).toBe('jobs-im-aargau');
  });
  it('VD DE → jobs-in-der-waadt', () => {
    expect(resolveCantonSection('de', 'VD')).toBe('jobs-in-der-waadt');
  });
  it('AGGREGATE_KEY → cerca-lavoro-svizzera', () => {
    expect(resolveCantonSection('it', '_AGGREGATE_')).toBe('cerca-lavoro-svizzera');
  });
  it('Half-canton AI/AR collapses to APPENZELLO group', () => {
    expect(resolveCantonSection('it', 'AI')).toBe('cerca-lavoro-appenzello');
    expect(resolveCantonSection('it', 'AR')).toBe('cerca-lavoro-appenzello');
  });
  it('BL/BS collapses to BASILEA group', () => {
    expect(resolveCantonSection('it', 'BL')).toBe('cerca-lavoro-basilea');
    expect(resolveCantonSection('it', 'BS')).toBe('cerca-lavoro-basilea');
  });
});

describe('resolveJobCanton', () => {
  it('returns job.canton when present', () => {
    expect(resolveJobCanton({ canton: 'ZH', location: 'Zurich' })).toBe('ZH');
  });
  it('falls back to city → canton lookup', () => {
    expect(resolveJobCanton({ canton: '', location: 'Zurich' })).toBe('ZH');
  });
  it('defaults to TI when canton unresolved', () => {
    expect(resolveJobCanton({ canton: '', location: '' })).toBe('TI');
  });
});
