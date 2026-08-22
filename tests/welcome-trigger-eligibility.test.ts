import { describe, it, expect } from 'vitest';
import { shouldAttemptWelcome, RECENCY_WINDOW_MS } from '../functions/src/lib/welcomeTriggerEligibility.js';

/**
 * Il predicato del trigger Firestore che manda la welcome dal lato server.
 *
 * Due pressioni opposte, ed è per questo che vale la pena pinnarlo: deve
 * scattare sulla conferma appena arrivata (il 43% degli iscritti LinkedIn la
 * perdeva, perché l'invio dipendeva da una fetch del browser durante un
 * redirect OAuth) e NON deve scattare su nient'altro — il documento
 * dell'iscritto viene riscritto da ogni evento dei webhook di consegna, decine
 * di migliaia di volte al mese.
 */

const NOW = Date.parse('2026-08-22T09:00:00Z');
const ts = (ms: number) => ({ toMillis: () => ms });
const minutesAgo = (m: number) => ts(NOW - m * 60_000);

describe('shouldAttemptWelcome', () => {
  it('scatta quando la conferma compare su un documento nuovo', () => {
    // Il caso LinkedIn: il documento nasce già confermato.
    expect(shouldAttemptWelcome({
      before: null,
      after: { email: 'a@b.ch', confirmed_at: minutesAgo(0) },
      nowMs: NOW,
    })).toBe(true);
  });

  it('scatta quando la conferma arriva su un documento che era pending', () => {
    expect(shouldAttemptWelcome({
      before: { email: 'a@b.ch', status: 'pending' },
      after: { email: 'a@b.ch', status: 'confirmed', confirmed_at: minutesAgo(1) },
      nowMs: NOW,
    })).toBe(true);
  });

  it('legge anche la grafia camelCase che scrive la SPA', () => {
    // #5673: 458 documenti portano `confirmedAt`. Leggerne una sola grafia
    // significherebbe non vedere la conferma proprio sul percorso client.
    expect(shouldAttemptWelcome({
      before: null,
      after: { email: 'a@b.ch', confirmedAt: minutesAgo(2) },
      nowMs: NOW,
    })).toBe(true);
  });

  it('non scatta se la welcome è già partita o è in volo', () => {
    // `welcome_sent_at` è il claim scritto in transazione PRIMA della chiamata
    // al provider: copre anche l'invio in corso.
    expect(shouldAttemptWelcome({
      before: null,
      after: { email: 'a@b.ch', confirmed_at: minutesAgo(0), welcome_sent_at: minutesAgo(0) },
      nowMs: NOW,
    })).toBe(false);
  });

  it('non scatta su una scrittura di webhook che non porta la conferma', () => {
    // Il caso che decide il costo: ~87.000 consegne al mese riscrivono questi
    // documenti. Nessuna di quelle scritture deve produrre un invio.
    const confirmed = { email: 'a@b.ch', confirmed_at: minutesAgo(30) };
    expect(shouldAttemptWelcome({
      before: confirmed,
      after: { ...confirmed, last_delivered_at: minutesAgo(0), open_count: 3 },
      nowMs: NOW,
    })).toBe(false);
  });

  it('non ripesca un iscritto confermato fuori dalla finestra', () => {
    expect(shouldAttemptWelcome({
      before: null,
      after: { email: 'a@b.ch', confirmed_at: ts(NOW - RECENCY_WINDOW_MS - 1000) },
      nowMs: NOW,
    })).toBe(false);
    // Al bordo interno invece sì.
    expect(shouldAttemptWelcome({
      before: null,
      after: { email: 'a@b.ch', confirmed_at: ts(NOW - RECENCY_WINDOW_MS + 1000) },
      nowMs: NOW,
    })).toBe(true);
  });

  it('non scatta senza prova di conferma, né su un documento cancellato', () => {
    expect(shouldAttemptWelcome({ before: null, after: { email: 'a@b.ch', status: 'confirmed' }, nowMs: NOW })).toBe(false);
    expect(shouldAttemptWelcome({ before: { email: 'a@b.ch' }, after: null, nowMs: NOW })).toBe(false);
  });

  it('non si ri-innesca dopo il rollback del claim su invio fallito', () => {
    // sendNewsletterWelcomeEmail cancella `welcome_sent_at` quando il provider
    // fallisce. Quella cancellazione è una scrittura in cui la conferma c'era
    // GIÀ prima: se ri-scattasse, un errore permanente diventerebbe un ciclo.
    const confirmed = { email: 'a@b.ch', confirmed_at: minutesAgo(5) };
    expect(shouldAttemptWelcome({
      before: { ...confirmed, welcome_sent_at: minutesAgo(4) },
      after: confirmed,
      nowMs: NOW,
    })).toBe(false);
  });
});
