import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  engagementConsistency,
  dailyEngagementConsistency,
  engagementUnreliableNote,
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
