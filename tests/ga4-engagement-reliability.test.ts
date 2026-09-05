import { describe, it, expect } from 'vitest';
import {
  engagementConsistency,
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
