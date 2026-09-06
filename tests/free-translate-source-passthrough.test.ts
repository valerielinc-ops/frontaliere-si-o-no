import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  freeTranslate,
  getCascadeStats,
  logCascadeSummary,
  isSourcePassthrough,
} from '@/scripts/lib/free-translate.mjs';
import { translateWithMyMemory } from '@/scripts/lib/mymemory-translate.mjs';

vi.mock('@/scripts/lib/mymemory-translate.mjs', () => ({
  translateWithMyMemory: vi.fn(),
}));

/**
 * La cascata MT poteva rendere la SORGENTE ITALIANA verbatim e nessuno se ne
 * accorgeva: a valle `translateFieldFreeMt` scarta il vuoto, il marker `null` e
 * la sentinella nav mangled, e un passthrough italiano non e' nessuna delle
 * tre — e' testo perfettamente valido, quindi passava. Il 2026-09-06 la stessa
 * classe di difetto ha colpito tre scrittori diversi
 * (`retranslate-blocking-bodies.mjs` nanako#994, `repair-object-object-bodies.mjs`
 * #7704, `batch-add-faq-to-articles.mjs` #7710) proprio perche' ognuno doveva
 * difendersi da solo.
 *
 * Questo file pinna i DUE versi, che e' il punto: la guardia deve rifiutare il
 * passthrough E deve lasciar passare intatto tutto il resto. Il verso positivo
 * da solo si soddisfa rifiutando tutto.
 *
 * Le asserzioni guardano la RAGIONE (il bucket `tierPassthroughs`, la riga di
 * `logCascadeSummary`), non solo il valore di ritorno. `freeTranslate` rende ''
 * per DUE motivi diversi — «ho rifiutato una non-traduzione» e «i motori sono
 * giu'» — e sul solo valore di ritorno sono indistinguibili: l'ultimo caso di
 * questo file pinna proprio quella differenza, ed e' l'unico che si accorge di
 * una guardia che etichetta come passthrough un fallimento di rete.
 *
 * Falsificazione misurata il 2026-09-06 su questo file, nei due versi:
 *   · aggancio rimosso da `tryTier` (difetto reintrodotto) → 3 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `false` (regola spenta) → 4 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `true` (rifiuta tutto) → 3 rossi, tutti
 *     nei casi inversi: le asserzioni che pinnano il comportamento legittimo
 *     mordono davvero, non sono decorative.
 */

const IT = [
  '## In breve',
  '- I frontalieri residenti entro venti chilometri dal confine restano nel vecchio regime fiscale',
  '- La soglia dei quarantacinque giorni di telelavoro vale dal primo gennaio',
  '',
  'Chi ha iniziato a lavorare in Svizzera dopo il 2023 rientra fra i nuovi frontalieri e paga le imposte in entrambi i Paesi.',
].join('\n');

const EN = [
  '## In brief',
  '- Cross-border workers living within twenty kilometres of the border stay in the old tax regime',
  '- The forty-five day teleworking threshold applies from the first of January',
  '',
  'Anyone who started working in Switzerland after 2023 falls under the new cross-border worker rules and pays tax in both countries.',
].join('\n');

/** Delta dei contatori: sono globali di modulo e non c'e' un reset esportato. */
function statsSnapshot() {
  const s = getCascadeStats();
  return {
    hits: s.tierHits.myMemory || 0,
    passthroughs: s.tierPassthroughs.myMemory || 0,
  };
}

describe('freeTranslate — guardia «uscita == sorgente»', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(translateWithMyMemory).mockReset();
    // Ogni tier sotto MyMemory parla via `fetch` globale. Farlo fallire rende
    // il test deterministico e OFFLINE: senza, il caso "passthrough rifiutato"
    // proseguirebbe la cascata fino a LibreTranslate/HuggingFace/Mozhi e il
    // verdetto dipenderebbe da endpoint pubblici. I tier SOPRA MyMemory
    // (DeepL, Azure, Google Cloud, LT self-hosted) escono '' da soli senza
    // chiave/URL in env, quindi non serve toccarli.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline nel test'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('rifiuta il motore che rende la sorgente verbatim, e lo dice come passthrough non come errore', async () => {
    // IL DIFETTO: il motore risponde 200 con l'italiano d'ingresso.
    vi.mocked(translateWithMyMemory).mockResolvedValue(IT);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toBe('');
    // La RAGIONE, non solo l'esito: il tier e' contato come passthrough e NON
    // come hit. Senza questa riga il caso resterebbe verde anche con la guardia
    // rimossa dal giorno in cui i motori sono giu'.
    expect(after.passthroughs - before.passthroughs).toBe(1);
    expect(after.hits - before.hits).toBe(0);
  });

  it('rifiuta anche il passthrough con spaziatura e maiuscole cambiate (confronto normalizzato, non `===`)', async () => {
    const mangled = IT.replace(/ /g, '  ').replace('## In breve', '## IN BREVE');
    vi.mocked(translateWithMyMemory).mockResolvedValue(mangled);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });

    expect(out).toBe('');
    expect(statsSnapshot().passthroughs - before.passthroughs).toBe(1);
  });

  it('nomina il passthrough nel sommario della cascata', async () => {
    vi.mocked(translateWithMyMemory).mockResolvedValue(IT);
    await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'fr', fieldType: 'description' });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
    logCascadeSummary();
    logSpy.mockRestore();

    const summary = lines.join('\n');
    expect(summary).toMatch(/Tier passthrough/);
    expect(summary).toMatch(/myMemory=\d+/);
  });

  // ── IL VERSO INVERSO: cio' che NON deve cambiare ───────────────────────────

  it('lascia passare una traduzione vera e la conta come hit', async () => {
    vi.mocked(translateWithMyMemory).mockResolvedValue(EN);
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toContain('cross-border workers'.split(' ')[0]);
    expect(out).not.toBe('');
    expect(after.hits - before.hits).toBe(1);
    expect(after.passthroughs - before.passthroughs).toBe(0);
  });

  it('non tocca il passthrough LEGITTIMO sourceLang === targetLang', async () => {
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'it', fieldType: 'description' });

    // Questo ramo esce PRIMA della cascata ed e' l'identita' voluta: renderla
    // '' spegnerebbe ogni chiamante che normalizza testo senza tradurlo.
    expect(out).toBe(IT);
    expect(translateWithMyMemory).not.toHaveBeenCalled();
    expect(statsSnapshot().passthroughs - before.passthroughs).toBe(0);
  });

  it('non spaccia un motore GIU\' per un passthrough', async () => {
    // I due esiti che valgono entrambi '' e che il chiamante deve poter
    // distinguere: qui la cascata fallisce davvero (nessun tier risponde) e il
    // bucket dei passthrough NON si deve muovere. E' il caso che si accorge di
    // una guardia troppo entusiasta, che sul solo valore di ritorno non si
    // vedrebbe: `out` e' '' in tutti e due i modi.
    vi.mocked(translateWithMyMemory).mockResolvedValue('');
    const before = statsSnapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = statsSnapshot();

    expect(out).toBe('');
    expect(after.passthroughs - before.passthroughs).toBe(0);
    expect(after.hits - before.hits).toBe(0);
  });
});

describe('isSourcePassthrough', () => {
  it('e\' vero solo quando i due testi sono lo stesso testo', () => {
    expect(isSourcePassthrough(IT, IT)).toBe(true);
    expect(isSourcePassthrough(IT, `  ${IT.toUpperCase()}  `)).toBe(true);
    expect(isSourcePassthrough(IT, EN)).toBe(false);
    expect(isSourcePassthrough(IT, `${IT} coda in piu'`)).toBe(false);
  });

  it('una sorgente vuota non e\' un passthrough', () => {
    // Altrimenti ogni chiamata con testo vuoto verrebbe contata come rifiuto e
    // il bucket direbbe che la guardia lavora dove non c'e' niente da tradurre.
    expect(isSourcePassthrough('', '')).toBe(false);
    expect(isSourcePassthrough('   ', 'qualcosa')).toBe(false);
  });
});
