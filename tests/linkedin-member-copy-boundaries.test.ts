// I tre casi limite del post LinkedIn che il reviewer di #6442 aveva segnato
// senza verificarli (follow-up #6450).
//
// Filo comune: il poster e' fail-soft. Un 400 di LinkedIn, una thumbnail
// rifiutata, una parola strippata di troppo non lasciano traccia — il post del
// giorno semplicemente non esce, o esce mutilato, e la run resta verde. Questi
// test sono l'unico posto in cui quei fallimenti diventano visibili.

import { describe, it, expect } from 'vitest';
import { formatCompanyMention, sanitizeMentionLabel, stripViewCounts } from '../scripts/lib/linkedin-member-copy.mjs';
import { convertImageForLinkedIn, MAX_UPLOAD_BYTES } from '../scripts/lib/linkedin-member-media.mjs';

describe('formatCompanyMention — la mention non si rompe sul nome del datore', () => {
  it('le parentesi TONDE restano: sono il nome legale, e non chiudono l etichetta', () => {
    // "(Schweiz) AG" e' la forma standard delle filiali svizzere. L'etichetta
    // di `@[…](urn)` e' delimitata da quadre, quindi le tonde ci stanno
    // dentro: mutilare il nome sarebbe un danno certo per un rischio che non
    // esiste.
    expect(formatCompanyMention('ABC (Schweiz) AG', '12345'))
      .toBe('@[ABC (Schweiz) AG](urn:li:organization:12345)');
  });

  it('le parentesi QUADRE spariscono: sono quelle che chiudono l etichetta in anticipo', () => {
    // Senza sanificazione: `@[ACME [CH] AG](urn:…)` — il parser chiude
    // all'inizio della quadra e il resto diventa testo, o LinkedIn rende 400 e
    // il fail-soft salta il post.
    expect(formatCompanyMention('ACME [CH] AG', '12345'))
      .toBe('@[ACME CH AG](urn:li:organization:12345)');
  });

  it('un a capo nel nome non spezza la sintassi', () => {
    expect(formatCompanyMention('Foo\nBar  AG', '12345'))
      .toBe('@[Foo Bar AG](urn:li:organization:12345)');
  });

  it('senza URN il nome esce nudo e NON sanificato: non c e una sintassi da proteggere', () => {
    expect(formatCompanyMention('ACME [CH] AG', '')).toBe('ACME [CH] AG');
  });

  it('sanitizeMentionLabel e totale: qualunque input rende una etichetta senza quadre', () => {
    for (const raw of ['[', ']', '[]', 'a]b[c', '', '   ', 'normale']) {
      expect(sanitizeMentionLabel(raw)).not.toMatch(/[[\]]/);
    }
  });
});

describe('stripViewCounts — toglie i CONTEGGI, non la parola', () => {
  it('toglie la social proof in tutte le forme che il sito emette', () => {
    expect(stripViewCounts('Guida utile. 1.234 visualizzazioni il 3/4/2026')).toBe('Guida utile.');
    expect(stripViewCounts('📊 30 visualizzazioni')).toBe('');
    expect(stripViewCounts('Visualizzazioni: 1.234')).toBe('');
    expect(stripViewCounts('Articolo 📊 letto molto')).toBe('Articolo letto molto');
  });

  it('NON tocca la parola usata in senso proprio', () => {
    // Il falso positivo che l'alternativa nuda produceva: un excerpt
    // legittimo usciva mutilato e nessuno se ne accorgeva.
    const casi = [
      'una feature di visualizzazione dati',
      'la visualizzazione mobile della pagina resta lenta',
      'Migliorata la visualizzazione delle tabelle',
    ];
    for (const c of casi) expect(stripViewCounts(c)).toBe(c);
  });
});

describe('convertImageForLinkedIn — anche la GIF ha un tetto', () => {
  /** Header GIF89a minimo: basta a farla riconoscere come GIF dal ramo. */
  const gifHead = Buffer.from('GIF89a', 'ascii');

  it('una GIF entro il tetto passa intatta: l animazione E il contenuto', async () => {
    const small = Buffer.concat([gifHead, Buffer.alloc(1024)]);
    const out = await convertImageForLinkedIn(small, { contentType: 'image/gif' });
    expect(out.contentType).toBe('image/gif');
    expect(out.buffer).toBe(small);
  });

  it('il tetto esiste ed e sotto il limite documentato da LinkedIn (10 MB)', () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(10_000_000);
  });

  it('una GIF oltre il tetto NON esce cosi com e', async () => {
    // Prima usciva il buffer originale, dritto al PUT: se l'Images API lo
    // rifiuta, il fail-soft assorbe e il post esce senza card. Ora degrada al
    // primo fotogramma — una thumbnail statica vale piu' di nessuna
    // thumbnail. Un buffer non decodificabile deve comunque NON passare come
    // GIF intatta: quello e' l'invariante, non quale formato ne esce.
    const huge = Buffer.concat([gifHead, Buffer.alloc(MAX_UPLOAD_BYTES + 1)]);
    let out: { buffer: Buffer; contentType: string } | null = null;
    try {
      out = await convertImageForLinkedIn(huge, { contentType: 'image/gif' });
    } catch {
      // sharp rifiuta un finto GIF non decodificabile: anche questo e' «non
      // e' passata intatta», ed e' il verso sicuro.
      return;
    }
    expect(out!.contentType).not.toBe('image/gif');
  });
});
