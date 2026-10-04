import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * La metà di CHIUSURA del monitor CWV (scripts/cwv-monitor-check.mjs).
 *
 * Il monitor coniava `CWV Regression (<metric>, <device>): <path>` dopo due
 * finestre consecutive sopra soglia, ma non aveva il simmetrico: quando la
 * metrica rientrava `main()` ritornava `ok` senza guardare le issue aperte, e
 * l'issue 9583 (INP, guarita) è rimasta aperta per settimane con 15 commenti
 * di sweep. Se uno di questi test diventa rosso, il titolo del guasto è:
 * «CWV monitor: issue aperta con due finestre valide consecutive sotto soglia»
 * — oppure, nel verso opposto, un chiuditore che chiude su una misura vuota,
 * sotto-campionata o non confrontabile.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const {
  TARGET_PAGES,
  MIN_SAMPLES_PER_METRIC,
  evaluateConsecutiveRecovery,
  evaluateConsecutiveRegression,
  parseCwvIssueTitle,
  cwvRecoveryVerdict,
  cwvMeasuredTitles,
  reconcileCwvIssues,
  loadHistory,
  saveHistory,
  main,
} = await import('../scripts/cwv-monitor-check.mjs');
const { ga4DateRange } = await import('../scripts/lib/ga4-service-account.mjs');

type Row = Record<string, unknown>;
const N = MIN_SAMPLES_PER_METRIC + 20;

/** Una finestra settimanale nel formato che il monitor registra oggi. */
function week(startDate: string, endDate: string, over: Row = {}, devices: Record<string, Row> = {}): Row {
  return {
    date: endDate,
    source: 'ga4',
    window: { startDate, endDate, days: 7, lagDays: 2, timezone: 'Europe/Zurich' },
    minimumSamples: MIN_SAMPLES_PER_METRIC,
    cls_p75: 0.05,
    cls_n: N,
    inp_p75: 150,
    inp_n: N,
    devices,
    ...over,
  };
}
const W1: [string, string] = ['2026-09-21', '2026-09-27'];
const W2: [string, string] = ['2026-09-28', '2026-10-04'];
const historyFor = (key: string, weeks: Row[]) => {
  const page = TARGET_PAGES.find((p: { key: string }) => p.key === key);
  return { pages: { [key]: { path: page.path, weeks } } };
};

/** I/O finto della riconciliazione: registra ogni scrittura. */
function fakeIo(issues: Row[]) {
  const writes = { comments: [] as Array<[number, string]>, closed: [] as number[], labelsRemoved: [] as Array<[number, string]> };
  const io = {
    listOpenIssues: vi.fn(async () => issues),
    readIssue: vi.fn(async (n: number) => issues.find((i) => i.number === n) ?? null),
    listComments: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    comment: vi.fn(async (n: number, body: string) => { writes.comments.push([n, body]); return true; }),
    close: vi.fn(async (n: number) => { writes.closed.push(n); return { number: n, persisted: true }; }),
    removeLabel: vi.fn(async (n: number, label: string) => { writes.labelsRemoved.push([n, label]); return true; }),
  };
  return { io, writes };
}
const quiet = () => {};

describe('evaluateConsecutiveRecovery', () => {
  it('due finestre valide sotto soglia → recovery con i due punti', () => {
    const weeks = [week(...W1, { inp_p75: 432 }), week(...W2, { inp_p75: 384 })];
    const r = evaluateConsecutiveRecovery(weeks, 'inp_p75', 500);
    expect(r?.previous.inp_p75).toBe(432);
    expect(r?.current.inp_p75).toBe(384);
    expect(r?.device).toBe('all');
  });

  it('una sotto e una sopra → null (in entrambi gli ordini)', () => {
    expect(evaluateConsecutiveRecovery([week(...W1, { inp_p75: 640 }), week(...W2, { inp_p75: 384 })], 'inp_p75', 500)).toBeNull();
    expect(evaluateConsecutiveRecovery([week(...W1, { inp_p75: 384 }), week(...W2, { inp_p75: 640 })], 'inp_p75', 500)).toBeNull();
  });

  it('finestra corrente con n = 12 → null: un campione insufficiente non è guarigione', () => {
    const weeks = [week(...W1, { inp_p75: 300 }), week(...W2, { inp_p75: 300, inp_n: 12 })];
    expect(evaluateConsecutiveRecovery(weeks, 'inp_p75', 500)).toBeNull();
  });

  it('finestra sourceUnavailable → null', () => {
    const weeks = [week(...W1, { inp_p75: 300 }), week(...W2, { inp_p75: 300, sourceUnavailable: 'query failed (Error)' })];
    expect(evaluateConsecutiveRecovery(weeks, 'inp_p75', 500)).toBeNull();
  });

  it('sorgenti diverse (PostHog poi GA4) → null', () => {
    const weeks = [week(...W1, { inp_p75: 300, source: 'posthog', window: { startDate: W1[0], endDate: W1[1], days: 7, lagDays: 2, timezone: 'Europe/Zurich' } }), week(...W2, { inp_p75: 300 })];
    expect(evaluateConsecutiveRecovery(weeks, 'inp_p75', 500)).toBeNull();
  });

  it('finestre sovrapposte → null', () => {
    const weeks = [week('2026-09-24', '2026-09-30', { inp_p75: 300 }), week('2026-09-27', '2026-10-03', { inp_p75: 300 })];
    expect(evaluateConsecutiveRecovery(weeks, 'inp_p75', 500)).toBeNull();
  });

  it('una sola finestra o nessuna soglia → null', () => {
    expect(evaluateConsecutiveRecovery([week(...W2)], 'inp_p75', 500)).toBeNull();
    expect(evaluateConsecutiveRecovery([week(...W1), week(...W2)], 'inp_p75', undefined)).toBeNull();
  });

  it('legge il device del titolo, non l\'aggregato: desktop ancora sopra non guarisce', () => {
    const dev = (cls: number) => ({ desktop: { cls_p75: cls, cls_n: N, inp_p75: 100, inp_n: N } });
    const weeks = [week(...W1, { cls_p75: 0.05 }, dev(0.3)), week(...W2, { cls_p75: 0.05 }, dev(0.3))];
    expect(evaluateConsecutiveRecovery(weeks, 'cls_p75', 0.1, 'all')).not.toBeNull();
    expect(evaluateConsecutiveRecovery(weeks, 'cls_p75', 0.1, 'desktop')).toBeNull();
  });

  it('è il complemento esatto della regressione sulla stessa coppia valida', () => {
    for (const [a, b] of [[0.05, 0.05], [0.2, 0.2], [0.05, 0.2], [0.1, 0.1]]) {
      const weeks = [week(...W1, { cls_p75: a }), week(...W2, { cls_p75: b })];
      const both = [evaluateConsecutiveRecovery(weeks, 'cls_p75', 0.1), evaluateConsecutiveRegression(weeks, 'cls_p75', 0.1)];
      expect(both.filter(Boolean).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('parseCwvIssueTitle', () => {
  it('forma attuale con device', () => {
    expect(parseCwvIssueTitle('CWV Regression (INP, mobile): /cerca-lavoro-svizzera/'))
      .toEqual({ metric: 'INP', device: 'mobile', path: '/cerca-lavoro-svizzera/', legacy: false });
  });

  it('forma precedente senza device → device `all`', () => {
    expect(parseCwvIssueTitle('CWV Regression (CLS): /p/'))
      .toEqual({ metric: 'CLS', device: 'all', path: '/p/', legacy: true });
  });

  it('titoli non interpretabili → null', () => {
    for (const t of ['CWV Regression (FID): /p/', 'CWV Regression (CLS, phone): /p/', 'CWV Regression (CLS): ', 'CWV field regression on a tracked page (#5001 watchlist)']) {
      expect(parseCwvIssueTitle(t)).toBeNull();
    }
  });
});

describe('cwvRecoveryVerdict', () => {
  it('replay 9583 (INP /cerca-lavoro-svizzera/, 432 poi 384, soglia 500) → pulito e completo', () => {
    // Valori rimisurati dalla verifica c12 (GA4, p75 pesato), messi su due
    // finestre settimanali NON sovrapposte come le registra il monitor.
    const history = historyFor('cerca_lavoro_svizzera', [
      week(...W1, { inp_p75: 432, inp_n: 195 }), week(...W2, { inp_p75: 384, inp_n: 183 }),
    ]);
    const v = cwvRecoveryVerdict({ title: 'CWV Regression (INP): /cerca-lavoro-svizzera/' }, history);
    expect(v).toMatchObject({ clean: true, complete: true, measure: W2[1] });
    expect(v.evidence).toContain('432 (n=195, ga4)');
    expect(v.evidence).toContain('384 (n=183, ga4)');
    expect(v.evidence).toContain('soglia ≤ 500ms');
    // Titolo nella forma precedente: una recidiva apre il titolo con il device.
    expect(v.evidence).toContain('CWV Regression (INP, <device>): /cerca-lavoro-svizzera/');
    const current = cwvRecoveryVerdict({ title: 'CWV Regression (INP, all): /cerca-lavoro-svizzera/' }, history);
    expect(current.evidence).not.toContain('<device>');
  });

  it('replay 8868 (CLS /cerca-lavoro-ticino/ 0,286 sopra 0,1) → completo ma non pulito', () => {
    const history = historyFor('cerca_lavoro_ticino', [
      week(...W1, { cls_p75: 0.258, cls_n: 200 }), week(...W2, { cls_p75: 0.286, cls_n: 178 }),
    ]);
    expect(cwvRecoveryVerdict({ title: 'CWV Regression (CLS): /cerca-lavoro-ticino/' }, history))
      .toMatchObject({ clean: false, complete: true });
  });

  it('path non più fra i TARGET_PAGES, metrica senza soglia, titolo illeggibile → incompleto', () => {
    const history = historyFor('cerca_lavoro_svizzera', [week(...W1), week(...W2)]);
    expect(cwvRecoveryVerdict({ title: 'CWV Regression (CLS): /pagina-rimossa/' }, history).complete).toBe(false);
    // /cerca-lavoro-svizzera/ ha solo una soglia INP.
    expect(cwvRecoveryVerdict({ title: 'CWV Regression (CLS): /cerca-lavoro-svizzera/' }, history).complete).toBe(false);
    expect(cwvRecoveryVerdict({ title: 'CWV Regression (CLS, phone): /cerca-lavoro-svizzera/' }, history).complete).toBe(false);
  });

  it('storia legacy senza sorgente né finestra (quella su main fino al 23-09) → incompleto', () => {
    const legacy = (date: string) => ({ date, cls_p75: 0.05, cls_n: 200, inp_p75: 150, inp_n: 200 });
    const history = historyFor('cerca_lavoro_svizzera', [legacy('2026-09-16'), legacy('2026-09-23')]);
    expect(cwvRecoveryVerdict({ title: 'CWV Regression (INP): /cerca-lavoro-svizzera/' }, history).complete).toBe(false);
  });
});

describe('reconcileCwvIssues', () => {
  it('replay 9583: chiude con un commento che porta i due punti e la soglia', async () => {
    const history = historyFor('cerca_lavoro_svizzera', [
      week(...W1, { inp_p75: 432, inp_n: 195 }), week(...W2, { inp_p75: 384, inp_n: 183 }),
    ]);
    const issue = { number: 9583, title: 'CWV Regression (INP): /cerca-lavoro-svizzera/', state: 'OPEN', labels: ['cwv-regression'] };
    const { io, writes } = fakeIo([issue]);
    const out = await reconcileCwvIssues({ history, regressions: [], io, log: quiet });
    expect(io.listOpenIssues).toHaveBeenCalledWith({ label: 'cwv-regression' });
    expect(out.closed).toEqual([9583]);
    expect(writes.closed).toEqual([9583]);
    const [, body] = writes.comments.find(([n]) => n === 9583)!;
    expect(body).toContain('2026-09-21→2026-09-27 = 432 (n=195, ga4)');
    expect(body).toContain('2026-09-28→2026-10-04 = 384 (n=183, ga4)');
    expect(body).toContain('device all');
    expect(body).toContain('soglia ≤ 500ms');
  });

  it('replay 8868: keep e `maybe-resolved` tolta, anche col titolo nella forma precedente', async () => {
    const devices = (cls: number) => ({ desktop: { cls_p75: cls, cls_n: 90, inp_p75: 100, inp_n: 90 } });
    const history = historyFor('cerca_lavoro_ticino', [
      week(...W1, { cls_p75: 0.258, cls_n: 200 }, devices(0.3)),
      week(...W2, { cls_p75: 0.286, cls_n: 178 }, devices(0.305)),
    ]);
    const regressions = [{ metric: 'CLS', device: 'desktop', path: '/cerca-lavoro-ticino/' }];
    expect(cwvMeasuredTitles(history, regressions).has('CWV Regression (CLS): /cerca-lavoro-ticino/')).toBe(true);
    const issue = {
      number: 8868, title: 'CWV Regression (CLS): /cerca-lavoro-ticino/', state: 'OPEN',
      labels: ['cwv-regression', 'maybe-resolved'],
    };
    const { io, writes } = fakeIo([issue]);
    const out = await reconcileCwvIssues({ history, regressions, io, log: quiet });
    expect(out.decisions).toEqual([expect.objectContaining({ number: 8868, action: 'keep' })]);
    expect(writes.labelsRemoved).toEqual([[8868, 'maybe-resolved']]);
    expect(writes.closed).toEqual([]);
  });

  it('8868 sopra soglia sull\'aggregato anche senza regressioni per device → keep, label tolta', async () => {
    const history = historyFor('cerca_lavoro_ticino', [
      week(...W1, { cls_p75: 0.258, cls_n: 200 }), week(...W2, { cls_p75: 0.286, cls_n: 178 }),
    ]);
    const issue = { number: 8868, title: 'CWV Regression (CLS): /cerca-lavoro-ticino/', state: 'OPEN', labels: ['maybe-resolved'] };
    const { io, writes } = fakeIo([issue]);
    const out = await reconcileCwvIssues({ history, regressions: [], io, log: quiet });
    expect(out.decisions[0].action).toBe('keep');
    expect(writes.labelsRemoved).toEqual([[8868, 'maybe-resolved']]);
  });

  it('titolo non interpretabile o path rimosso → nessuna scrittura', async () => {
    const history = historyFor('cerca_lavoro_svizzera', [week(...W1), week(...W2)]);
    const { io, writes } = fakeIo([
      { number: 1, title: 'CWV Regression (CLS, phone): /cerca-lavoro-svizzera/', state: 'OPEN', labels: [] },
      { number: 2, title: 'CWV Regression (INP): /pagina-rimossa/', state: 'OPEN', labels: [] },
    ]);
    const out = await reconcileCwvIssues({ history, regressions: [], io, log: quiet });
    expect(out.decisions.map((d: Row) => d.action)).toEqual(['keep', 'keep']);
    expect(writes.comments).toEqual([]);
    expect(writes.closed).toEqual([]);
  });

  it('nessuna coppia di finestre confrontabili → non legge nemmeno le issue', async () => {
    const { io } = fakeIo([]);
    const out = await reconcileCwvIssues({ history: historyFor('home', [week(...W2)]), regressions: [], io, log: quiet });
    expect(out).toBeNull();
    expect(io.listOpenIssues).not.toHaveBeenCalled();
  });
});

describe('main(): la riconciliazione gira anche senza regressioni', () => {
  const NOW = new Date('2026-10-06T08:00:00Z');
  const historyFile = path.join(tmpdir(), `cwv-monitor-recovery-${process.pid}.json`);
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  /** GA4 sotto ogni soglia per tutte le pagine target, campione sufficiente. */
  const ga4Rows = () => {
    const rows = TARGET_PAGES.flatMap((p: { path: string }) => [
      { path: p.path, device: 'mobile', metric: 'CLS', value: 0.02, count: N },
      { path: p.path, device: 'mobile', metric: 'INP', value: 120, count: N },
    ]);
    return Object.assign(rows, { coverage: { timeZone: 'Europe/Zurich' } });
  };
  /** La finestra della settimana prima, già registrata e sotto soglia. */
  const seedPreviousWeek = () => {
    const current = ga4DateRange(7, 2, NOW);
    const prevNow = new Date(NOW.getTime() - 7 * 86_400_000);
    const prev = ga4DateRange(7, 2, prevNow);
    expect(prev.endDate < current.startDate).toBe(true);
    const pages: Record<string, Row> = {};
    for (const p of TARGET_PAGES) {
      const dev = { cls_p75: 0.02, cls_n: N, inp_p75: 120, inp_n: N };
      pages[p.key] = { path: p.path, weeks: [week(prev.startDate, prev.endDate, { date: prevNow.toISOString().slice(0, 10), cls_p75: 0.02, inp_p75: 120 }, { mobile: dev })] };
    }
    saveHistory(historyFile, { pages });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CWV_MONITOR_HISTORY_FILE = historyFile;
    process.env.CWV_MONITOR_HISTORY_FILE_ALLOW_CI = '1';
    delete process.env.GITHUB_RUN_ID;
    seedPreviousWeek();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv.splice(0, process.argv.length, ...originalArgv);
    rmSync(historyFile, { force: true });
  });

  const run = (io: ReturnType<typeof fakeIo>['io']) => main({
    now: NOW,
    checkLivenessImpl: async () => ({ alive: false, reason: 'PostHog senza web_vitals dal 16-09' }),
    ga4FallbackImpl: async () => ga4Rows(),
    reconcileIo: io,
  });

  it('zero regressioni + una issue chiudibile → la chiude', async () => {
    const issue = { number: 9583, title: 'CWV Regression (INP, mobile): /cerca-lavoro-svizzera/', state: 'OPEN', labels: ['cwv-regression'] };
    const { io, writes } = fakeIo([issue]);
    const result = await run(io);
    expect(result.status).toBe('ok');
    expect(result.regressions).toEqual([]);
    expect(writes.closed).toEqual([9583]);
    expect(writes.comments[0][1]).toMatch(/INP p75 field, device mobile, \/cerca-lavoro-svizzera\/, soglia ≤ 500ms/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('--dry-run stampa la decisione senza scrivere né la storia né le issue', async () => {
    process.argv.push('--dry-run');
    const before = JSON.stringify(loadHistory(historyFile));
    const issue = { number: 9583, title: 'CWV Regression (INP, mobile): /cerca-lavoro-svizzera/', state: 'OPEN', labels: ['cwv-regression'] };
    const { io, writes } = fakeIo([issue]);
    const result = await run(io);
    expect(result.reconciled.decisions).toEqual([expect.objectContaining({ number: 9583, action: 'close' })]);
    expect(writes.comments).toEqual([]);
    expect(writes.closed).toEqual([]);
    expect(JSON.stringify(loadHistory(historyFile))).toBe(before);
  });

  it('sorgente non disponibile → nessuna riconciliazione', async () => {
    const { io } = fakeIo([]);
    const result = await main({
      now: NOW,
      checkLivenessImpl: async () => ({ alive: false, reason: 'dead' }),
      ga4FallbackImpl: async () => [],
      reconcileIo: io,
    });
    expect(result.status).toBe('source-unavailable');
    expect(io.listOpenIssues).not.toHaveBeenCalled();
  });
});
