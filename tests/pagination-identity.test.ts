import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { recordUniquePageProgress } from '../scripts/lib/pagination-identity.mjs';

describe('pagination source identity contract', () => {
  it('records unique progress for a page', () => {
    const seen = new Set<string>();

    expect(recordUniquePageProgress(seen, [{ id: 'a' }, { id: 'b' }], {
      getIdentity: (item) => item.id,
      source: 'test',
      page: 0,
    })).toEqual(['a', 'b']);
    expect([...seen]).toEqual(['a', 'b']);
  });

  it('fails closed on a repeated source identity', () => {
    const seen = new Set(['a']);

    expect(() => recordUniquePageProgress(seen, [{ id: 'b' }, { id: 'a' }], {
      getIdentity: (item) => item.id,
      source: 'test',
      page: 1,
    })).toThrow('duplicate source identity "a"');
    expect([...seen]).toEqual(['a']);
  });

  it('fails closed when a row has no stable identity', () => {
    expect(() => recordUniquePageProgress(new Set(), [{ id: '' }], {
      getIdentity: (item) => item.id,
      source: 'test',
      page: 2,
    })).toThrow('without a stable source identity');
  });

  it('allows a page-boundary overlap only when the page adds new identities', () => {
    const seen = new Set(['a']);

    expect(recordUniquePageProgress(seen, [{ id: 'a' }, { id: 'b' }], {
      getIdentity: (item) => item.id,
      source: 'mutable feed',
      page: 1,
      allowPreviouslySeen: true,
    })).toEqual(['a', 'b']);
    expect([...seen]).toEqual(['a', 'b']);

    expect(() => recordUniquePageProgress(seen, [{ id: 'a' }], {
      getIdentity: (item) => item.id,
      source: 'mutable feed',
      page: 2,
      allowPreviouslySeen: true,
    })).toThrow('page made no unique progress');
    expect([...seen]).toEqual(['a', 'b']);
  });

  it('always rejects duplicate identities within the same page', () => {
    expect(() => recordUniquePageProgress(new Set(['a']), [{ id: 'b' }, { id: 'b' }], {
      getIdentity: (item) => item.id,
      source: 'mutable feed',
      page: 1,
      allowPreviouslySeen: true,
    })).toThrow('duplicate source identity "b"');
  });

  it('is wired into every Post Group pagination loop', () => {
    const postch = readFileSync(new URL('../scripts/update-postch-jobs.mjs', import.meta.url), 'utf8');
    const postauto = readFileSync(new URL('../scripts/lib/postauto-job-parser.mjs', import.meta.url), 'utf8');
    const confederazione = readFileSync(new URL('../scripts/update-confederazione-jobs.mjs', import.meta.url), 'utf8');

    expect(postch).toContain('recordUniquePageProgress(localeIds, jobs');
    expect(postch).toContain('allowPreviouslySeen: true');
    expect(postauto).toContain('recordUniquePageProgress(localeIds, jobs');
    expect(postauto).toContain('allowPreviouslySeen: true');
    expect(postch).toContain('scannedRows >= totalJobs');
    expect(confederazione).toContain('recordUniquePageProgress(sourceIdentities, items');
    expect(confederazione).toContain('sourceIdentities.size >= declaredTotal');
    const postfinance = readFileSync(new URL('../scripts/update-postfinance-jobs.mjs', import.meta.url), 'utf8');
    expect(postfinance).toContain('recordUniquePageProgress(sourceIdentities, pageRecords');
    expect(postfinance).toContain('allowPreviouslySeen: true');
    expect(postfinance).toContain('scannedRows >= total');
    expect(postfinance).toContain('const pageRecords = entries.map((entry) => entry?.response);');
    expect(postfinance).toContain('pageRecords.some((record) => !record)');
    expect(postfinance).toContain('if (!paginationComplete && pageNumber >= RECRUITING_API_MAX_PAGES)');
    expect(postfinance).toContain('if (!page) {');
    expect(postfinance).toContain('if (!Array.isArray(page.jobSearchResult)) {');
  });
});
