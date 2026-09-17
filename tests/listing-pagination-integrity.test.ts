import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createListingPaginationIntegrity } from '../scripts/lib/listing-pagination-integrity.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('listing pagination integrity', () => {
  it('keeps a complete proof for distinct pages and an explicit empty terminal page', () => {
    const integrity = createListingPaginationIntegrity({ getRowKey: (row) => row.id });

    expect(integrity.observe([{ id: 'a' }, { id: 'b' }]).accepted).toBe(true);
    expect(integrity.observe([{ id: 'c' }]).accepted).toBe(true);
    expect(integrity.observe([]).accepted).toBe(true);
    expect(integrity.proven).toBe(true);
  });

  it.each([
    ['a repeated page', [{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }]],
    ['an overlapping page', [{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]],
    ['a page with a missing identity', [{ id: 'a' }], [{ id: '' }]],
    ['a page with a duplicate identity', [{ id: 'a' }], [{ id: 'b' }, { id: 'b' }]],
  ])('%s cannot prove a complete source even when the second page is short', (_label, first, second) => {
    const integrity = createListingPaginationIntegrity({ getRowKey: (row) => row.id });

    expect(integrity.observe(first).accepted).toBe(true);
    expect(integrity.observe(second).accepted).toBe(false);
    expect(integrity.proven).toBe(false);
  });

  it('cannot turn a repeated short page into terminal listing evidence', async () => {
    const { hasAuthoritativeListingPageEvidence } = await import(
      '../scripts/lib/job-listing-evidence.mjs'
    );
    const integrity = createListingPaginationIntegrity({ getRowKey: (row) => row.id });

    expect(integrity.observe([{ id: 'a' }, { id: 'b' }]).accepted).toBe(true);
    expect(integrity.observe([{ id: 'a' }]).accepted).toBe(false);
    expect(hasAuthoritativeListingPageEvidence({
      isTerminalPage: true,
      listingMarkupSeen: true,
      listingRowsSeen: true,
      paginationIntegrityProven: integrity.proven,
    })).toBe(false);
  });

  it('wires strict page identity proof into every crawler with the short-page zero path', () => {
    const runners = [
      ['update-sunrise-jobs.mjs', 'sunriseSourcePaginationIntegrityProven'],
      ['update-board-jobs.mjs', 'boardSourcePaginationIntegrityProven'],
      ['update-damiani-jobs.mjs', 'damianiSourcePaginationIntegrityProven'],
      ['update-skyguide-jobs.mjs', 'skyguideSourcePaginationIntegrityProven'],
    ];

    for (const [file, evidenceField] of runners) {
      const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      expect(source, file).toContain('createListingPaginationIntegrity');
      expect(source, file).toContain(evidenceField);
      expect(source, file).toContain('paginationIntegrity.proven');
    }
  });

  it('does not treat a raw empty Sunrise payload as authoritative empty evidence', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'update-sunrise-jobs.mjs'), 'utf8');
    expect(source).not.toContain('emptyStateObserved: rawRecordCount === 0');
    expect(source).toContain('emptyStateObserved: false');
  });

  it('does not prove Sunrise empty coverage without an explicit empty marker', async () => {
    const { hasAuthoritativeListingPageEvidence } = await import(
      '../scripts/lib/job-listing-evidence.mjs'
    );
    expect(hasAuthoritativeListingPageEvidence({
      isTerminalPage: true,
      listingMarkupSeen: true,
      listingRowsSeen: false,
      emptyStateObserved: false,
      paginationIntegrityProven: true,
    })).toBe(false);
  });

  it('does not accept terminal listing evidence without pagination proof', async () => {
    const { hasAuthoritativeListingPageEvidence } = await import(
      '../scripts/lib/job-listing-evidence.mjs'
    );
    expect(hasAuthoritativeListingPageEvidence({
      isTerminalPage: true,
      listingMarkupSeen: true,
      listingRowsSeen: false,
      emptyStateObserved: true,
    })).toBe(false);
    expect(hasAuthoritativeListingPageEvidence({
      isTerminalPage: true,
      listingMarkupSeen: true,
      listingRowsSeen: false,
      emptyStateObserved: true,
      paginationIntegrityProven: true,
    })).toBe(true);
  });
});
