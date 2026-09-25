import { describe, expect, it } from 'vitest';
import {
  normalizeIssuePage,
  normalizeOpenPrPage,
  scanPaginatedIssuePages,
  scanPaginatedRows,
} from '../scripts/ci/followup-drainer.mjs';

const issue = (number: number) => ({
  number,
  title: `issue ${number}`,
  body: `body ${number}`,
  labels: [{ name: 'agent:fix-queued' }],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const page = (start: number, size: number) =>
  Array.from({ length: size }, (_, index) => issue(start + index));

describe('snapshot issue paginata del drainer', () => {
  it('segue oltre 300 issue e considera completa solo la pagina finale', () => {
    const pages = new Map([
      [1, page(1, 100)],
      [2, page(101, 100)],
      [3, page(201, 100)],
      [4, page(301, 50)],
    ]);
    const requested: number[] = [];
    const scan = scanPaginatedIssuePages((pageNumber) => {
      requested.push(pageNumber);
      return pages.get(pageNumber)!;
    });

    expect(scan.complete).toBe(true);
    expect(scan.reason).toBeNull();
    expect(scan.rows).toHaveLength(350);
    expect(requested).toEqual([1, 2, 3, 4]);
  });

  it('una risposta API malformata dopo una pagina piena resta incompleta e non vuota', () => {
    const scan = scanPaginatedIssuePages((pageNumber) =>
      pageNumber === 1 ? page(1, 100) : { malformed: true });

    expect(scan.complete).toBe(false);
    expect(scan.reason).toBe('malformed');
    expect(scan.rows).toHaveLength(100);
  });

  it('un errore remoto dopo dati parziali non autorizza una decisione sul prefisso letto', () => {
    const scan = scanPaginatedIssuePages((pageNumber) => {
      if (pageNumber === 1) return page(1, 100);
      throw new Error('fixture API failure');
    });

    expect(scan).toMatchObject({ complete: false, reason: 'error' });
    expect(scan.rows).toHaveLength(100);
  });

  it('budget esaurito prima della pagina successiva conserva il prefisso ma blocca lo stage', () => {
    const seenPages: number[] = [];
    const scan = scanPaginatedIssuePages(
      (pageNumber) => {
        seenPages.push(pageNumber);
        return page(1 + ((pageNumber - 1) * 100), 100);
      },
      { beforePage: (pageNumber) => pageNumber === 1 },
    );

    expect(scan).toMatchObject({ complete: false, reason: 'budget', pages: 1 });
    expect(scan.rows).toHaveLength(100);
    expect(seenPages).toEqual([1]);
  });

  it('una lista vuota è valida quando la pagina vuota è stata letta', () => {
    const scan = scanPaginatedIssuePages(() => []);

    expect(scan).toEqual({ complete: true, reason: null, rows: [], pages: 1 });
  });

  it('una pagina piena di sole PR non viene scambiata per la fine del listing', () => {
    const pullRequests = page(1, 100).map((entry) => ({
      ...entry,
      pull_request: { url: `https://api.github.com/repos/o/r/pulls/${entry.number}` },
    }));
    const requested: number[] = [];
    const scan = scanPaginatedIssuePages((pageNumber) => {
      requested.push(pageNumber);
      return pageNumber === 1 ? pullRequests : [];
    });

    expect(scan.complete).toBe(true);
    expect(scan.rows).toEqual([]);
    expect(requested).toEqual([1, 2]);
  });

  it('la mappa PR non ha il vecchio limite 50: una fixture con 51 PR è completa', () => {
    const openPrs = Array.from({ length: 51 }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      body: null,
    }));
    const scan = scanPaginatedRows(() => openPrs, { normalize: normalizeOpenPrPage });

    expect(scan.complete).toBe(true);
    expect(scan.rows).toHaveLength(51);
  });

  it('normalizzazione rifiuta una riga issue senza label o timestamp', () => {
    expect(normalizeIssuePage([{ number: 1, title: 'x', labels: [] }])).toBeNull();
    expect(normalizeIssuePage([{
      ...issue(1),
      updated_at: 'garbage-date',
    }])).toBeNull();
  });
});
