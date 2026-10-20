/**
 * lessons-harvester — copertura della finestra.
 *
 * Il difetto chiuso qui: `MAX_PRS=40` / `MAX_ISSUES=120` di default tagliavano
 * in silenzio la «finestra di 14 giorni». Sul sito (70-120 PR mergiate al
 * giorno, 999 nella finestra del 27-09) la lettura copriva le ultime ~12 ore
 * di review e 120 issue su 664: 0 NOVEL / 0 ESCALATE per settimane, mentre la
 * stessa finestra letta per intero dava 1 NOVEL + 2 ESCALATE. Il corpus, con
 * un decimo del volume, ne leggeva abbastanza da produrre lezioni.
 *
 * L'osservatore: la finestra si legge per giorni, un giorno al tetto della
 * search API o fallito e' dichiarato, e nessun tetto implicito sopravvive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  windowDays,
  collectWindow,
  applyCap,
  coverageWarnings,
  fetchDayWithFallback,
  SEARCH_RESULT_CAP,
} from '../scripts/ci/harvest-agent-lessons.mjs';

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ number: from + i }));

describe('windowDays', () => {
  it('copre dal primo giorno a oggi inclusi (14 giorni di finestra = 15 date)', () => {
    const days = windowDays('2026-09-13', '2026-09-27');
    expect(days).toHaveLength(15);
    expect(days[0]).toBe('2026-09-13');
    expect(days.at(-1)).toBe('2026-09-27');
  });

  it('attraversa il cambio di mese', () => {
    expect(windowDays('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });
});

describe('collectWindow — la finestra intera, non le ultime N righe', () => {
  it('unisce giorni che insieme superano il tetto di una singola query (il caso del sito)', () => {
    const days = windowDays('2026-09-13', '2026-09-27');
    // ~80 PR al giorno: 1200 in totale, oltre i 1000 di una query sola e
    // trenta volte i 40 del vecchio default.
    const { items, truncatedDays, failedDays } = collectWindow(days, (d) => rows(days.indexOf(d) * 1000, 80));
    expect(items).toHaveLength(15 * 80);
    expect(truncatedDays).toEqual([]);
    expect(failedDays).toEqual([]);
  });

  it('deduplica per number (una issue aggiornata compare in un solo giorno, ma la unione resta robusta)', () => {
    const { items } = collectWindow(['a', 'b'], () => rows(1, 3));
    expect(items.map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it('un giorno al tetto della search API e un giorno fallito vengono dichiarati, non assorbiti', () => {
    const { truncatedDays, failedDays } = collectWindow(['x', 'y', 'z'], (d) =>
      d === 'x' ? rows(1, SEARCH_RESULT_CAP) : d === 'y' ? null : []);
    expect(truncatedDays).toEqual(['x']);
    expect(failedDays).toEqual(['y']);
  });
});

describe('fetchDayWithFallback — un 504 sulla pagina pesante non costa il giorno', () => {
  type Row = { number: number; comments?: string[] };
  it('usa la lista completa quando risponde', () => {
    const got = fetchDayWithFallback<Row>(() => [{ number: 1, comments: ['a'] }], () => { throw new Error('non deve servire'); }, (r) => r);
    expect(got).toEqual([{ number: 1, comments: ['a'] }]);
  });

  it('ricade sulla lista leggera idratata per elemento (run 36333749234, updated:2026-09-27)', () => {
    const got = fetchDayWithFallback<Row>(() => null, () => [{ number: 7 }, { number: 8 }], (r) => ({ ...r, comments: [`c${r.number}`] }));
    expect(got).toEqual([{ number: 7, comments: ['c7'] }, { number: 8, comments: ['c8'] }]);
  });

  it('null solo se falliscono entrambe, e collectWindow dichiara il giorno mancante', () => {
    const { failedDays } = collectWindow(['2026-09-27'], () => fetchDayWithFallback<Row>(() => null, () => null, (r) => r));
    expect(failedDays).toEqual(['2026-09-27']);
  });
});

describe('applyCap / coverageWarnings', () => {
  it('0 = nessun tetto', () => {
    expect(applyCap(rows(1, 700), 0)).toEqual({ items: rows(1, 700), cut: 0 });
  });

  it('un tetto esplicito taglia e lo dice', () => {
    const { items, cut } = applyCap(rows(1, 700), 120);
    expect(items).toHaveLength(120);
    expect(cut).toBe(580);
    const w = coverageWarnings('fix-issues', { truncatedDays: [], failedDays: [] }, cut);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^::warning::fix-issues: .*580.*PARZIALE/);
  });

  it('una issue idratata senza commenti leggibili rende la vista PARZIALE (review di #10118)', () => {
    const w = coverageWarnings('fix-issues', { truncatedDays: [], failedDays: [] }, 0, [9912, 9913]);
    expect(w).toEqual(['::warning::fix-issues: commenti illeggibili per 2 elementi, vista PARZIALE: #9912, #9913']);
  });

  it('una PR con review troncate e non rilette rende PARZIALE la vista delle PR', () => {
    const w = coverageWarnings('merged PRs', { truncatedDays: [], failedDays: [] }, 0, [10001], 'review');
    expect(w).toEqual(['::warning::merged PRs: review illeggibili per 1 elementi, vista PARZIALE: #10001']);
  });

  it('finestra completa = nessun warning', () => {
    expect(coverageWarnings('issues', { truncatedDays: [], failedDays: [] }, 0)).toEqual([]);
  });
});

describe('nessun tetto implicito nel sorgente', () => {
  const src = readFileSync(new URL('../scripts/ci/harvest-agent-lessons.mjs', import.meta.url), 'utf-8');

  it('MAX_PRS e MAX_ISSUES hanno default 0', () => {
    expect(src).toMatch(/intFromEnv\('MAX_PRS', 0\)/);
    expect(src).toMatch(/intFromEnv\('MAX_ISSUES', 0\)/);
  });

  it('le liste gh della finestra passano da collectWindow, non da un `--search ...:>=` a query singola', () => {
    expect(src).not.toMatch(/--search', `(?:merged|created):>=\$\{sinceDay\}`/);
    expect(src).not.toMatch(/updated:>=\$\{sinceDay\}/);
  });
});
