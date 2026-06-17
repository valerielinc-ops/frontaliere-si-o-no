import { describe, it, expect } from 'vitest';
import { supersedeCrawledByPublisher, supersedeKey } from '../scripts/lib/publisher-supersede.mjs';
import { PUBLISHER_SOURCE_KEY } from '../scripts/lib/publisherJobProjection.mjs';

const pub = (companyKey: string, title: string, location = '', extra = {}) => ({ source: PUBLISHER_SOURCE_KEY, companyKey, title, location, ...extra });
const crawled = (companyKey: string, title: string, location = '', extra = {}) => ({ source: 'acme-crawler', companyKey, title, location, ...extra });

describe('supersedeCrawledByPublisher', () => {
  it('drops the crawled duplicate of an employer-published ad (same company + role)', () => {
    const jobs = [pub('casale-sa', 'Ingegnere di processo'), crawled('casale-sa', 'Ingegnere di processo')];
    const { jobs: out, superseded } = supersedeCrawledByPublisher(jobs);
    expect(superseded).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe(PUBLISHER_SOURCE_KEY);
  });

  it('matches across title casing/diacritics/punctuation (normalized)', () => {
    const jobs = [pub('sintetica-sa', 'Front Desk & Office Support'), crawled('sintetica-sa', 'front desk  & office  support')];
    expect(supersedeCrawledByPublisher(jobs).superseded).toBe(1);
  });

  it('does NOT drop an unrelated crawled role from a company that sponsors a different role', () => {
    const jobs = [pub('casale-sa', 'Ingegnere di processo'), crawled('casale-sa', 'Addetto pulizie')];
    const { jobs: out, superseded } = supersedeCrawledByPublisher(jobs);
    expect(superseded).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('drops ONLY the crawled duplicate at the published location, not other cities (SEO safety)', () => {
    // Employer publishes the role for Lugano only; same role is crawled in
    // Lugano + Bellinzona + Locarno. Only the Lugano crawled page is superseded.
    const jobs = [
      pub('x', 'Magazziniere', 'Lugano'),
      crawled('x', 'Magazziniere', 'Lugano'),
      crawled('x', 'Magazziniere', 'Bellinzona'),
      crawled('x', 'Magazziniere', 'Locarno'),
    ];
    const { jobs: out, superseded } = supersedeCrawledByPublisher(jobs);
    expect(superseded).toBe(1);
    const remainingLocs = out.filter((j) => j.source !== PUBLISHER_SOURCE_KEY).map((j) => j.location).sort();
    expect(remainingLocs).toEqual(['Bellinzona', 'Locarno']);
  });

  it('never drops the employer\'s own publisher ad even if duplicated', () => {
    const jobs = [pub('x', 'Ruolo'), pub('x', 'Ruolo')];
    expect(supersedeCrawledByPublisher(jobs).superseded).toBe(0);
  });

  it('returns the list unchanged when there are no publisher jobs', () => {
    const jobs = [crawled('a', 'Uno'), crawled('b', 'Due')];
    const res = supersedeCrawledByPublisher(jobs);
    expect(res.superseded).toBe(0);
    expect(res.jobs).toBe(jobs); // same reference, no work done
  });

  it('does not match jobs missing companyKey or title (no false supersede)', () => {
    const jobs = [pub('', 'Ruolo'), crawled('', 'Ruolo'), { source: 'c', companyKey: 'z' } as any];
    expect(supersedeCrawledByPublisher(jobs).superseded).toBe(0);
    expect(supersedeKey({ companyKey: '', title: 'x' } as any)).toBeNull();
  });

  it('drops multiple crawled duplicates of the same published role', () => {
    const jobs = [pub('a', 'Ruolo'), crawled('a', 'Ruolo'), crawled('a', 'ruolo')];
    const { superseded, jobs: out } = supersedeCrawledByPublisher(jobs);
    expect(superseded).toBe(2);
    expect(out).toHaveLength(1);
  });
});
