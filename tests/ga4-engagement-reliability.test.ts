import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  engagementConsistency,
  dailyEngagementConsistency,
  fetchDailyEngagementVerdict,
  engagementUnreliableNote,
  engagementUnreliableNoteFromReason,
  GA4_ENGAGED_SESSION_MIN_SECONDS,
  MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS,
  MIN_SESSIONS_FOR_VERDICT,
} from '../scripts/lib/ga4-engagement-reliability.mjs';

// Numeri reali della property 524485296 (issue #6703). Le tre righe
// "as-letto" sono ciò che GA4 riportava il 2026-08-30 e il 2026-09-05 sui
// giorni non ancora elaborati; le righe "riparato" sono le STESSE giornate
// rimisurate dopo l'elaborazione completa.
describe('engagementConsistency — giorni GA4 non elaborati', () => {
  it('marca il 29/08 come letto il 30/08 (engagedSessions 93, durata 246s)', () => {
    const v = engagementConsistency({ sessions: 4226, engagedSessions: 93, averageSessionDuration: 246 });
    expect(v.reliable).toBe(false);
    expect(v.impliedEngagedSessionSeconds).toBeGreaterThan(MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS);
    expect(v.reason).toContain('averageSessionDuration');
  });

  it('marca il 30/08 come letto il 30/08 (engagedSessions 53, durata 373s)', () => {
    expect(engagementConsistency({ sessions: 2135, engagedSessions: 53, averageSessionDuration: 373 }).reliable).toBe(false);
  });

  it('marca il 04/09, stesso pattern ancora live il 05/09', () => {
    expect(engagementConsistency({ sessions: 7943, engagedSessions: 125, averageSessionDuration: 236.47 }).reliable).toBe(false);
  });
});

describe('engagementConsistency — dati coerenti, nessun falso allarme', () => {
  it('non marca il 29/08 riparato (engagedSessions 1841, durata 75s)', () => {
    const v = engagementConsistency({ sessions: 4116, engagedSessions: 1841, averageSessionDuration: 74.98 });
    expect(v.reliable).toBe(true);
    expect(v.reason).toBeNull();
  });

  it('non marca il 30/08 riparato (engagedSessions 1598, durata 101s)', () => {
    expect(engagementConsistency({ sessions: 3316, engagedSessions: 1598, averageSessionDuration: 101 }).reliable).toBe(true);
  });

  it('non marca un engagement genuinamente basso: 25/08, rate 5,3% ma durata media 14s', () => {
    // Picco di traffico a bassa qualità: le due metriche CONCORDANO, quindi il
    // dato è cattivo ma vero — marcarlo qui nasconderebbe un segnale reale.
    const v = engagementConsistency({ sessions: 43773, engagedSessions: 2330, averageSessionDuration: 14.4 });
    expect(v.reliable).toBe(true);
  });

  it('non marca una giornata sana (27/08: rate 41,9%, durata 172s)', () => {
    expect(engagementConsistency({ sessions: 4306, engagedSessions: 1803, averageSessionDuration: 172.43 }).reliable).toBe(true);
  });
});

describe('engagementConsistency — bias verso "affidabile" quando non può giudicare', () => {
  it('input mancante non produce un verdetto', () => {
    expect(engagementConsistency({}).reliable).toBe(true);
    expect(engagementConsistency({ sessions: 1000, engagedSessions: 10 }).reliable).toBe(true);
    expect(engagementConsistency({ averageSessionDuration: 300 }).reliable).toBe(true);
  });

  it('campione sotto la soglia di sessioni non produce un verdetto', () => {
    const tiny = engagementConsistency({
      sessions: MIN_SESSIONS_FOR_VERDICT - 1,
      engagedSessions: 1,
      averageSessionDuration: 900,
    });
    expect(tiny.reliable).toBe(true);
  });

  it('sampleSize copre i report senza conteggio sessioni (per-pagePath)', () => {
    const tiny = engagementConsistency({ engagementRate: 0.02, averageSessionDuration: 300, sampleSize: 5 });
    expect(tiny.reliable).toBe(true);
    const big = engagementConsistency({ engagementRate: 0.02, averageSessionDuration: 300, sampleSize: 5000 });
    expect(big.reliable).toBe(false);
  });

  it('rate fuori dominio o durata negativa non producono un verdetto', () => {
    expect(engagementConsistency({ engagementRate: 1.4, averageSessionDuration: 300, sampleSize: 1000 }).reliable).toBe(true);
    expect(engagementConsistency({ engagementRate: 0.02, averageSessionDuration: -1, sampleSize: 1000 }).reliable).toBe(true);
  });
});

describe('engagementConsistency — casi limite del rate', () => {
  it('rate 0 con durata media sopra i 10s è impossibile per costruzione', () => {
    const v = engagementConsistency({ sessions: 1000, engagedSessions: 0, averageSessionDuration: 120 });
    expect(v.reliable).toBe(false);
    expect(v.impliedEngagedSessionSeconds).toBeNull();
    expect(v.reason).toContain('∞');
  });

  it('rate 0 con durata media sotto i 10s è coerente', () => {
    expect(engagementConsistency({ sessions: 1000, engagedSessions: 0, averageSessionDuration: 4 }).reliable).toBe(true);
  });

  it('rate 1 non è mai incoerente sotto il tetto: implied == durata media', () => {
    const v = engagementConsistency({ sessions: 1000, engagedSessions: 1000, averageSessionDuration: 900 });
    expect(v.reliable).toBe(true);
    expect(v.impliedEngagedSessionSeconds).toBeCloseTo(900, 6);
  });

  it('engagementRate esplicito prevale su engagedSessions/sessions', () => {
    const v = engagementConsistency({
      sessions: 4226,
      engagedSessions: 4000,
      engagementRate: 0.022,
      averageSessionDuration: 246,
    });
    expect(v.reliable).toBe(false);
    expect(v.engagementRate).toBeCloseTo(0.022, 6);
  });
});

describe('dailyEngagementConsistency — la finestra non deve annegare il giorno in lag', () => {
  // 28 giornate sane più le 2 in lag reali della property: è la forma esatta
  // della finestra a 30 giorni che i report interrogano.
  const healthy = Array.from({ length: 28 }, (_, i) => ({
    date: `202608${String(i + 1).padStart(2, '0')}`,
    sessions: 4000,
    engagedSessions: 1800,
    averageSessionDuration: 100,
  }));
  const lagging = [
    { date: '20260904', sessions: 7943, engagedSessions: 125, averageSessionDuration: 236.47 },
    { date: '20260830', sessions: 2135, engagedSessions: 53, averageSessionDuration: 373 },
  ];

  it("sull'aggregato pesato la stessa finestra risulta coerente — per questo l'aggregato non basta", () => {
    // Regressione del difetto: valutare la coerenza sul totale della finestra
    // rende il giorno contaminato invisibile, quindi il guardrail non scatta
    // mai sui numeri che i call-site producono davvero.
    const days = [...healthy, ...lagging];
    const sessions = days.reduce((s, d) => s + d.sessions, 0);
    const engagedSessions = days.reduce((s, d) => s + d.engagedSessions, 0);
    const averageSessionDuration =
      days.reduce((s, d) => s + d.averageSessionDuration * d.sessions, 0) / sessions;
    expect(engagementConsistency({ sessions, engagedSessions, averageSessionDuration }).reliable).toBe(true);
  });

  it('per-giorno marca la finestra e nomina le giornate incoerenti', () => {
    const v = dailyEngagementConsistency([...healthy, ...lagging]);
    expect(v.reliable).toBe(false);
    expect(v.unreliableDates).toEqual(['20260904', '20260830']);
    expect(v.reason).toContain('20260904');
    expect(v.reason).toContain('elaborazione incompleta');
  });

  it('una finestra di sole giornate sane resta affidabile', () => {
    const v = dailyEngagementConsistency(healthy);
    expect(v.reliable).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.unreliableDates).toEqual([]);
  });

  it('input assente o righe vuote non producono un verdetto', () => {
    expect(dailyEngagementConsistency([]).reliable).toBe(true);
    expect(dailyEngagementConsistency().reliable).toBe(true);
    expect(dailyEngagementConsistency([null, undefined]).reliable).toBe(true);
  });
});

describe('engagementUnreliableNoteFromReason', () => {
  it('è null senza motivo', () => {
    expect(engagementUnreliableNoteFromReason(null)).toBeNull();
    expect(engagementUnreliableNoteFromReason('')).toBeNull();
  });

  // Il verdetto che i report propagano viene da dailyEngagementConsistency,
  // che prevale sull'aggregato: la nota va derivabile dal `reason` già
  // calcolato, senza ri-giudicare i totali della finestra (che direbbero
  // "affidabile" proprio nei casi intercettati).
  it('formatta un motivo già calcolato senza ri-giudicare', () => {
    expect(engagementUnreliableNoteFromReason('2 giornate incoerenti nella finestra')).toBe(
      '⚠️ engagement inaffidabile — 2 giornate incoerenti nella finestra',
    );
  });
});

describe('engagementUnreliableNote', () => {
  it('è null quando il dato è coerente', () => {
    expect(engagementUnreliableNote({ sessions: 4306, engagedSessions: 1803, averageSessionDuration: 172.43 })).toBeNull();
  });

  it('è una nota leggibile quando non lo è', () => {
    const note = engagementUnreliableNote({ sessions: 2135, engagedSessions: 53, averageSessionDuration: 373 });
    expect(note).toContain('engagement inaffidabile');
    expect(note).toContain('elaborazione incompleta');
  });
});

// Il generatore di raccomandazioni di scripts/analytics-report.mjs vive dentro
// una funzione lunga e non esportata: non c'e' un punto d'ingresso da chiamare.
// Questo test pinna quindi il sorgente. E' l'unica forma che diventa rossa nella
// PR che toglie il guard, invece che nel report del giorno dopo — dove il
// sintomo (una raccomandazione «Bounce rate alto (98,4%)» su una finestra in
// lag di elaborazione, cioe' proprio #6703) e' indistinguibile da un dato vero.
describe("le raccomandazioni da bounce/durata sono gatate sul verdetto d'affidabilita'", () => {
  const src = readFileSync(
    new URL('../scripts/analytics-report.mjs', import.meta.url),
    'utf8',
  );

  it('il ramo bounceRate > 0.5 consulta engagementReliable', () => {
    expect(src).toContain(
      'if (result.summary.engagementReliable !== false && bounceRate > 0.5) {',
    );
  });

  it('il ramo avgSessionDuration < 60 consulta engagementReliable', () => {
    expect(src).toContain(
      'if (result.summary.engagementReliable !== false && result.summary.avgSessionDuration < 60) {',
    );
  });

  it('il ramo criticalBounce (>70% bounce, >=50 sessioni) consulta engagementReliable', () => {
    expect(src).toContain(
      'if (result.summary?.engagementReliable !== false && result.highBouncePaths',
    );
  });

  // Non vacuo: se un domani i tre rami sparissero, i toContain sopra
  // passerebbero solo restando rossi. Qui verifichiamo che i rami esistano
  // ancora davvero, cosi' il test cade anche se qualcuno li rimuove del tutto.
  it('i tre rami esistono ancora nel sorgente', () => {
    expect(src).toContain('Bounce rate alto (');
    expect(src).toContain('Durata sessione bassa (');
    expect(src).toContain('rivedere contenuto e CTA');
  });
});

// #7508: i tre guard qui sopra testano `!== false`, quindi un ramo d'uscita che
// lascia `engagementReliable` a `undefined` li fa fail-open — la raccomandazione
// «Bounce rate alto» torna proprio quando la rilevazione e' rotta. Il contratto
// inverso, pinnato qui: OGNI uscita d'errore del blocco riepilogo scrive il
// verdetto. Una riscrittura che ne aggiunge una senza marcarla cade qui, non nel
// report del giorno dopo.
describe("i rami d'errore del riepilogo GA4 marcano il verdetto come non calcolato", () => {
  const src = readFileSync(
    new URL('../scripts/analytics-report.mjs', import.meta.url),
    'utf8',
  );
  const start = src.indexOf('// ── 3a. Overall metrics');
  const end = src.indexOf('// ── 3b.', start);
  const block = src.slice(start, end);

  it('il blocco riepilogo e ancora delimitabile nel sorgente', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('GA4 summary:');
  });

  it('la marcatura scrive un verdetto negativo, non lascia un undefined', () => {
    expect(src).toContain('result.summary.engagementReliable = false;');
    expect(src).toContain('verdetto non calcolato:');
  });

  it('ogni `return null` del blocco e preceduto dalla marcatura', () => {
    const segments = block.split('return null;');
    // I due rami HTTP: 403 (permessi) e non-ok generico.
    expect(segments.length - 1).toBe(2);
    for (const before of segments.slice(0, -1)) {
      expect(before.slice(-200)).toContain('markEngagementNotComputed(');
    }
  });

  it('il catch di chiusura del blocco marca il verdetto', () => {
    const tail = block.slice(block.lastIndexOf('} catch ('));
    expect(tail).toContain('markEngagementNotComputed(');
  });
});

// Stessa forma di source-assert dei tre rami di raccomandazione qui sopra, per
// i quattro canali che espongono il bounceRate della STESSA finestra giudicata
// (#7509): tabelle per-device, per-landing-page, diagnostica per sorgente e
// delta week-over-week. Prima uscivano nel JSON e nel print come dato buono.
describe("le tabelle bounce e il delta WoW marcano l'affidabilita' della finestra", () => {
  const src = readFileSync(
    new URL('../scripts/analytics-report.mjs', import.meta.url),
    'utf8',
  );

  it('esiste un solo marcatore condiviso, che legge il verdetto del riepilogo', () => {
    expect(src).toContain('const markEngagementReliability = (rows) => {');
    expect(src).toContain("const reliable = result.summary?.engagementReliable !== false;");
    expect(src).toContain('engagementUnreliableNoteFromReason(result.summary?.engagementUnreliableReason)');
  });

  it('la tabella per-device passa dal marcatore', () => {
    expect(src).toContain('result.devices = markEngagementReliability(');
  });

  it('la tabella per-landing-page passa dal marcatore', () => {
    expect(src).toContain('result.landingPages = markEngagementReliability(');
  });

  it('la diagnostica per sorgente/canale passa dal marcatore', () => {
    expect(src).toContain('const rows = markEngagementReliability(');
    expect(src).toContain('result.emptyLandingDiagnostic = rows;');
  });

  it('il delta WoW del bounceRate consulta entrambe le finestre', () => {
    expect(src).toContain(
      'const deltaBounceReliable = cur.engagementReliable !== false && prev.engagementReliable !== false;',
    );
    expect(src).toContain('engagementReliable: deltaBounceReliable,');
  });

  it('il print avverte su ognuna delle tre tabelle', () => {
    expect(src).toContain('result.devices[0].engagementUnreliableNote');
    expect(src).toContain('result.landingPages[0].engagementUnreliableNote');
    expect(src).toContain('rows[0].engagementUnreliableNote');
  });

  // Non vacuo: i toContain sopra resterebbero verdi anche se le quattro
  // sezioni sparissero del tutto. Qui si pinna che i canali esistano ancora.
  it('i quattro canali esistono ancora nel sorgente', () => {
    expect(src).toContain("log('📱', 'Dispositivi:');");
    expect(src).toContain("log('🚪', 'Top landing pages (dove entrano gli utenti):');");
    expect(src).toContain('Diagnostica landing page vuota');
    expect(src).toContain('deltas.ga4 = {');
  });
});

// scripts/looker-dashboard.gs e' un template da incollare INTERO nell'editor
// Apps Script, un runtime senza module resolution: non puo' importare il
// modulo qui sopra, quindi ne rispecchia formula e soglie. La duplicazione e'
// imposta dal runtime, ma il drift no — questo test la pinna (#7509).
describe('il mirror Apps Script della soglia di affidabilita non drifta', () => {
  const gs = readFileSync(
    new URL('../scripts/looker-dashboard.gs', import.meta.url),
    'utf8',
  );

  it('le tre soglie coincidono con quelle del modulo', () => {
    expect(gs).toContain(`const GA4_ENGAGED_SESSION_MIN_SECONDS = ${GA4_ENGAGED_SESSION_MIN_SECONDS};`);
    expect(gs).toContain(`const MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS = ${MAX_PLAUSIBLE_ENGAGED_SESSION_SECONDS};`);
    expect(gs).toContain(`const MIN_SESSIONS_FOR_VERDICT = ${MIN_SESSIONS_FOR_VERDICT};`);
  });

  it('i quattro fogli che espongono un Bounce Rate scrivono l’avvertenza', () => {
    expect(gs.match(/writeEngagementWarning\(sheet, \d+, startDate, endDate\);/g) ?? []).toHaveLength(4);
    expect(gs).toContain('function windowEngagementVerdict(startDate, endDate) {');
  });

  it('windowEngagementVerdict interroga GA4 per giornata, non sull aggregato', () => {
    expect(gs).toContain("['date']");
    expect(gs).toContain('engagementConsistency(rows[i][1], rows[i][2], rows[i][3])');
  });
});

// #7511: `perf-sources/ga4.mjs` era l'ultimo consumer a emettere il verdetto
// sulla finestra AGGREGATA (una sola richiesta per `pagePath`), cioè proprio
// dove la giornata in lag annega. Il blocco dichiarato era `pagePath × date`
// contro il `limit: 10000` — ma il verdetto di finestra non richiede quel
// prodotto: basta una seconda richiesta aggregata per sola `date`
// (~windowDays righe). Qui si pinna che venga emessa e che prevalga.
describe('fetchGa4ByPage — verdetto engagement per-giorno, non sulla finestra aggregata', () => {
  const PATH = '/articoli-frontaliere/quadro-frontalieri';

  // Riga per-pagePath COERENTE: da sola darebbe `reliable: true`.
  const perPathRows = {
    rows: [
      {
        dimensionValues: [{ value: PATH }],
        metricValues: [{ value: '4306' }, { value: '0.419' }, { value: '172.43' }],
      },
    ],
  };

  const dayRow = (date: string, sessions: number, engaged: number, duration: number) => ({
    dimensionValues: [{ value: date }],
    metricValues: [{ value: String(sessions) }, { value: String(engaged) }, { value: String(duration) }],
  });

  const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

  async function run(second: unknown) {
    const calls: any[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body);
      calls.push(parsed);
      if (calls.length === 1) return okRes(perPathRows);
      if (second instanceof Error) throw second;
      return second;
    };
    const prev = process.env.GA4_PROPERTY_ID;
    process.env.GA4_PROPERTY_ID = '524485296';
    try {
      const { fetchGa4ByPage } = await import('../scripts/lib/perf-sources/ga4.mjs');
      const result = await fetchGa4ByPage({
        windowDays: 30,
        fetchImpl: fetchImpl as any,
        getTokenImpl: async () => 'tok',
      });
      return { calls, result };
    } finally {
      if (prev === undefined) delete process.env.GA4_PROPERTY_ID;
      else process.env.GA4_PROPERTY_ID = prev;
    }
  }

  it('emette due richieste, la seconda aggregata per `date` e senza `pagePath`', async () => {
    const { calls } = await run(okRes({ rows: [dayRow('20260901', 4306, 1803, 172.43)] }));
    expect(calls).toHaveLength(2);
    expect(calls[0].dimensions).toEqual([{ name: 'pagePath' }]);
    expect(calls[1].dimensions).toEqual([{ name: 'date' }]);
    expect(calls[1].metrics.map((m: any) => m.name)).toEqual([
      'sessions',
      'engagedSessions',
      'averageSessionDuration',
    ]);
    // Stesso filtro newsletter-excluded e stessa finestra della prima.
    expect(calls[1].dimensionFilter).toEqual(calls[0].dimensionFilter);
    expect(calls[1].dateRanges).toEqual(calls[0].dateRanges);
    // Nessun prodotto `pagePath × date`: è il blocco che questa forma evita.
    expect(calls[1].dimensions).not.toContainEqual({ name: 'pagePath' });
  });

  it('una sola giornata incoerente marca ogni entry di perPath, benché la riga per-path sia coerente', async () => {
    const { result } = await run(
      okRes({
        rows: [
          dayRow('20260901', 4306, 1803, 172.43),
          dayRow('20260902', 3316, 1598, 101),
          dayRow('20260904', 7943, 125, 236.47), // giornata in lag (#6703)
        ],
      }),
    );
    const entry = result.perPath.get(PATH);
    expect(entry.engagementReliable).toBe(false);
    expect(entry.engagementUnreliableReason).toContain('20260904');
    expect(result.engagement.unreliableDates).toEqual(['20260904']);
  });

  it('finestra pulita: il verdetto per-path resta quello che decide', async () => {
    const { result } = await run(
      okRes({ rows: [dayRow('20260901', 4306, 1803, 172.43), dayRow('20260902', 3316, 1598, 101)] }),
    );
    const entry = result.perPath.get(PATH);
    expect(entry.engagementReliable).toBe(true);
    expect(entry.engagementUnreliableReason).toBeNull();
  });

  it('richiesta per-giorno non-ok: verdetto NON calcolato, non fail-open', async () => {
    const { result } = await run({ ok: false, status: 429, json: async () => ({}), text: async () => 'quota' });
    const entry = result.perPath.get(PATH);
    expect(entry.engagementReliable).toBe(false);
    expect(entry.engagementUnreliableReason).toContain('verdetto non calcolato');
    expect(entry.engagementUnreliableReason).toContain('429');
  });

  it('richiesta per-giorno che lancia: verdetto NON calcolato, e la prima richiesta non va persa', async () => {
    const { result } = await run(new Error('socket hang up'));
    expect(result.rows).toBe(1);
    const entry = result.perPath.get(PATH);
    expect(entry.engagementReliable).toBe(false);
    expect(entry.engagementUnreliableReason).toContain('socket hang up');
  });
});

// La richiesta per-giorno è identica in ogni consumer che interroga GA4 per
// pagina (#7511), quindi vive una volta sola qui. Il contratto che i due
// call-site danno per scontato è pinnato su questo helper.
describe('fetchDailyEngagementVerdict — richiesta per-giorno condivisa', () => {
  const dateRanges = [{ startDate: '2026-08-06', endDate: '2026-09-04' }];
  const filter = { notExpression: { filter: { fieldName: 'sessionMedium' } } };

  it('chiede `date` come unica dimensione e propaga finestra e filtro del report giudicato', async () => {
    const seen: any[] = [];
    await fetchDailyEngagementVerdict({
      runReport: async (body: any) => {
        seen.push(body);
        return { ok: true, status: 200, json: async () => ({ rows: [] }) };
      },
      dateRanges,
      dimensionFilter: filter,
    });
    expect(seen[0].dimensions).toEqual([{ name: 'date' }]);
    expect(seen[0].dateRanges).toBe(dateRanges);
    expect(seen[0].dimensionFilter).toBe(filter);
  });

  it('omette `dimensionFilter` quando il report giudicato non ne ha uno', async () => {
    let body: any;
    await fetchDailyEngagementVerdict({
      runReport: async (b: any) => ((body = b), { ok: true, status: 200, json: async () => ({ rows: [] }) }),
      dateRanges,
    });
    expect('dimensionFilter' in body).toBe(false);
  });

  it('non-ok e throw danno entrambi un verdetto negativo, mai un fail-open', async () => {
    const nonOk = await fetchDailyEngagementVerdict({
      runReport: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      dateRanges,
    });
    expect(nonOk.reliable).toBe(false);
    expect(nonOk.reason).toContain('verdetto non calcolato: HTTP 503');

    const threw = await fetchDailyEngagementVerdict({
      runReport: async () => {
        throw new Error('socket hang up');
      },
      dateRanges,
    });
    expect(threw.reliable).toBe(false);
    expect(threw.reason).toContain('socket hang up');
  });
});

// Sibling della stessa classe (#7511): il guardrail A/B leggeva l'engagement
// sui 7 giorni aggregati delle due pagine, quindi diluiva la giornata in lag
// esattamente come faceva `perf-sources/ga4.mjs`. `fetchGa4Engagement` non
// accetta un `fetchImpl` iniettabile, quindi il contratto si pinna sul
// sorgente — stessa forma dei source-assert qui sopra.
describe("il guardrail A/B AdSense giudica l'engagement per-giorno", () => {
  const src = readFileSync(
    new URL('../scripts/adsense-format-ab-report.mjs', import.meta.url),
    'utf8',
  );

  it('riusa la richiesta per-giorno condivisa invece di riscriverla', () => {
    expect(src).toContain(
      "import { engagementConsistency, fetchDailyEngagementVerdict } from './lib/ga4-engagement-reliability.mjs';",
    );
    expect(src).toContain('const dailyEngagement = await fetchDailyEngagementVerdict({');
  });

  it('la richiesta per-giorno riusa finestra e filtro della richiesta per-pagina', () => {
    expect(src).toContain('dateRanges: body.dateRanges,');
    expect(src).toContain('dimensionFilter: body.dimensionFilter,');
  });

  it('il verdetto per-giorno prevale su quello del singolo lato', () => {
    expect(src).toContain('const effective = dailyEngagement.reliable ? verdict : dailyEngagement;');
    expect(src).toContain('engagementReliable: effective.reliable,');
    expect(src).toContain('engagementUnreliableReason: effective.reason,');
  });

  // Non vacuo: i toContain sopra resterebbero verdi anche se il consumer del
  // verdetto sparisse. Qui si pinna che il delta engagement lo legga ancora.
  it('il delta engagement/bounce resta omesso quando un lato è inaffidabile', () => {
    expect(src).toContain(
      'const engagementUsable = control.engagementReliable !== false && treatment.engagementReliable !== false;',
    );
  });
});
