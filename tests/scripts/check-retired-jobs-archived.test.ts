// @vitest-environment node
/**
 * Observer contract (scripts/ci/check-retired-jobs-archived.mjs): between two
 * revisions, a posting that leaves the active set must be served at head by an
 * active row or by an expired entry WITH a title; an archive record with a
 * title must not vanish. Either gap is a job URL the build turns into the
 * noindex «Offerta non verificata» stub.
 */
import { describe, expect, it } from 'vitest';
import { measureRetiredArchiveCoverage } from '../../scripts/ci/check-retired-jobs-archived.mjs';

type Row = Record<string, any>;
const job = (slug: string, extra: Row = {}): Row => ({ slug, slugByLocale: { it: slug }, title: `T ${slug}`, ...extra });
const map = (entries: Record<string, Row[]>) => new Map(Object.entries(entries));

describe('measureRetiredArchiveCoverage()', () => {
  it('flags a posting that left the active set without an archive record (Locarno shape)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ 'citta-di-locarno': [job('impiegata-ii-50-70'), job('giardiniere')] }),
      baseExpired: map({}),
      headActive: map({ 'citta-di-locarno': [job('giardiniere')] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(1);
    expect(result.retiredUnarchived.map((row) => row.slug)).toEqual(['impiegata-ii-50-70']);
    expect(result.retiredUnarchivedByCrawler).toEqual({ 'citta-di-locarno': 1 });
  });

  it('accepts a retired posting archived with a title, not one archived without', () => {
    const titled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [job('x')] }),
    });
    expect(titled.retiredUnarchived).toEqual([]);

    const untitled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [{ slug: 'x', slugByLocale: { it: 'x' }, title: '', titleByLocale: {} }] }),
    });
    expect(untitled.retiredUnarchived.map((row) => row.slug)).toEqual(['x']);
  });

  it('accepts a renamed posting whose old slug is in its history, and one moved to another crawler', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('old-slug'), job('moved')] }),
      baseExpired: map({}),
      headActive: map({ a: [job('new-slug', { previousSlugs: ['old-slug'] })], b: [job('moved')] }),
      headExpired: map({}),
    });
    expect(result.retiredUnarchived).toEqual([]);
  });

  it('flags an archive that shrinks between two revisions (Rittmeyer shape: 12 records -> [])', () => {
    const records = Array.from({ length: 12 }, (_, n) => job(`sales-engineer-${n}`));
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ 'rittmeyer-ag': records }),
      headActive: map({}),
      headExpired: map({ 'rittmeyer-ag': [] }),
    });
    expect(result.archiveLost).toHaveLength(12);
    expect(result.archiveLostByCrawler).toEqual({ 'rittmeyer-ag': 12 });
  });

  it('does not count an archive record whose posting is active again (ghost reconciliation)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ a: [job('back-again')] }),
      headActive: map({ a: [job('back-again')] }),
      headExpired: map({ a: [] }),
    });
    expect(result.archiveLost).toEqual([]);
  });

  it('skips a posting held out of publication (never had a public URL)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('held', { heldFromPublication: true })] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(0);
    expect(result.retiredUnarchived).toEqual([]);
  });
});
