// L'osservatore di #5831 item 4 — il round-trip fra il titolo che
// `differentiateH1FromTitle` CONFRONTA e il titolo che `buildSeoPageHtml`
// EMETTE.
//
// ─── La domanda del reviewer, e perche' non bastava rispondere a parole ────
//
// La review di #5816 ha chiesto: `differentiateH1FromTitle` riceve il
// `pageTitle` PRE-brand e ci strippa via il suffisso prima di confrontarlo
// con l'h1. Ma il `<title>` che finisce davvero in pagina lo costruisce
// `buildSeoPageHtml` → `normalizeShellTitle` → `buildTitleWithBrand`. Se
// quella catena applicasse al testo una trasformazione ULTERIORE al solo
// suffisso — un troncamento, un `…`, un cambio di case — allora il confronto
// userebbe una stringa che in pagina non esiste, e le duplicazioni
// `<title>`===`<h1>` rientrerebbero SENZA che il gate deploy-blocking
// `audit:h1-title-duplicates` (baseline 0) le veda.
//
// Tracciata: la risposta e' NO. `normalizeShellTitle` fa esattamente (1)
// strip del brand, (2) `trim`, (3) ri-append condizionale del brand;
// `buildTitleWithBrand` non tronca mai (docblock di `titleSuffix.ts`, punto
// 3: la headline oltre il cap e' restituita VERBATIM, perche' il `…` a meta'
// headline aveva fatto crollare il CTR di `/calcola-stipendio/` dal 4,8% allo
// 0,99%).
//
// Solo che quella garanzia viveva in un commento, e un commento non fallisce.
// Questi test la rendono eseguibile: chiunque aggiunga un troncamento a
// `normalizeShellTitle` o a `buildTitleWithBrand` trova il rosso qui invece
// di scoprirlo da un ratchet SEO tre settimane dopo.
//
// ─── Perche' NON importa seoPageShell.ts ──────────────────────────────────
//
// `seoPageShell` → `htmlTemplate` → `constants` legge `public/assets/**` a
// module scope, quindi qualunque test che lo importi e' rosso in worktree
// sparse e verde in CI. `normalizeShellTitle` e' stato spostato nel modulo
// foglia `titleSuffix.ts` proprio per questo: e' LA STESSA funzione che
// `buildSeoPageHtml` chiama (unica definizione, nessuna copia), ma
// raggiungibile senza quella superficie.
import { describe, it, expect } from 'vitest';
import {
  normalizeShellTitle,
  escapeForBudget,
  buildTitleWithBrand,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
} from '../../build-plugins/shared/titleSuffix';
import { differentiateH1FromTitle } from '../../build-plugins/shared/seoContentTokens';
import { escHtml } from '../../build-plugins/shared/htmlEscape';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * Headline scelte per coprire ENTRAMBI i rami di `buildTitleWithBrand`, che
 * e' il punto in cui pre-brand e post-brand potrebbero divergere:
 *
 *  - `brandKept`: headline + 21 char di brand entro il cap 66 → il brand
 *    viene appeso, quindi il `<title>` finale ≠ la stringa confrontata;
 *  - `brandDropped`: headline gia' oltre il cap → il brand viene LASCIATO
 *    CADERE e il `<title>` finale e' byte-identico all'h1. E' esattamente il
 *    caso che ha fatto nascere `differentiateH1FromTitle`.
 */
const HEADLINES: Array<{ label: string; text: string }> = [
  { label: 'brandKept/corta', text: 'Stipendio netto frontaliere' },
  { label: 'brandKept/al limite', text: 'Lavoro frontalieri Ticino 2026 oggi' },
  { label: 'brandDropped/lunga', text: 'Calcolo stipendio netto frontaliere Ticino 2026 con imposta alla fonte' },
  { label: 'brandDropped/appena oltre', text: 'Offerte di lavoro per frontalieri a Lugano e dintorni' },
  { label: 'entita HTML', text: 'Rossi & Figli Sagl — offerte "aperte" <oggi>' },
  { label: 'spazi multipli', text: 'Stipendio   netto    frontaliere' },
  { label: 'spazi ai bordi', text: '   Frontalieri Ticino 2026   ' },
  { label: 'brand gia cotto dentro', text: 'Stipendio netto frontaliere | Frontaliere Ticino' },
];

describe('normalizeShellTitle — le uniche trasformazioni sono brand + trim (#5831 item 4)', () => {
  it('non tronca MAI: la headline oltre il cap esce verbatim, senza ellissi', () => {
    for (const { label, text } of HEADLINES) {
      const out = normalizeShellTitle(text);
      const withoutBrand = out.endsWith(TITLE_BRAND_SUFFIX)
        ? out.slice(0, -TITLE_BRAND_SUFFIX.length)
        : out;
      // Il testo della headline sopravvive integro: nessun `…`, nessun taglio.
      expect(withoutBrand, label).toBe(text.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '').trim());
      expect(out, label).not.toContain('…');
    }
  });

  it('il brand viene appeso solo se ci sta, e mai due volte', () => {
    for (const { label, text } of HEADLINES) {
      const out = normalizeShellTitle(text);
      const occurrences = out.split(TITLE_BRAND_SUFFIX).length - 1;
      expect(occurrences, `${label} — brand ripetuto`).toBeLessThanOrEqual(1);
      if (occurrences === 1) {
        // Se c'e', il totale rispetta il cap SERP.
        expect(out.length, `${label} — cap`).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      }
    }
  });

  it('e\' idempotente: ri-normalizzare un titolo gia\' finale non lo cambia', () => {
    // Se non lo fosse, il confronto pre-brand e quello post-brand
    // divergerebbero al secondo giro — ed e' proprio la classe di divergenza
    // che il reviewer sospettava.
    for (const { label, text } of HEADLINES) {
      const once = normalizeShellTitle(text);
      expect(normalizeShellTitle(once), label).toBe(once);
    }
  });
});

describe('differentiateH1FromTitle vede la STESSA stringa che finisce in pagina', () => {
  it('decide identicamente sul titolo pre-brand e sul <title> finale post-brand', () => {
    // IL test. Per ogni headline e ogni locale, differenziare l'h1 usando il
    // titolo che il callsite passa (pre-brand) deve dare lo stesso risultato
    // che usando il `<title>` realmente emesso da buildSeoPageHtml. Qualunque
    // trasformazione aggiuntiva nella catena del titolo rompe questa uguaglianza.
    for (const { label, text } of HEADLINES) {
      const finalTitle = normalizeShellTitle(text);
      for (const locale of LOCALES) {
        // Caso h1 === title: e' quello che deve far scattare il differenziatore.
        expect(
          differentiateH1FromTitle(text, finalTitle, locale),
          `${label}/${locale} — pre-brand vs post-brand divergono`,
        ).toBe(differentiateH1FromTitle(text, text, locale));
      }
    }
  });

  it('quando il brand cade, h1 e title collidono e il tag viene applicato', () => {
    // Il caso che ha creato il difetto: headline oltre il cap → niente brand
    // → `<title>` byte-identico all'`<h1>` → Semrush "Duplicate H1 and title".
    const long = 'Calcolo stipendio netto frontaliere Ticino 2026 con imposta alla fonte';
    const finalTitle = normalizeShellTitle(long);
    expect(finalTitle).toBe(long); // brand caduto: la premessa del test
    for (const locale of LOCALES) {
      const h1 = differentiateH1FromTitle(long, finalTitle, locale);
      expect(h1, locale).not.toBe(finalTitle);
      expect(h1.startsWith(long), locale).toBe(true);
    }
  });

  it('quando il brand resta, non collidono e l\'h1 NON viene toccato', () => {
    const short = 'Stipendio netto frontaliere';
    const finalTitle = normalizeShellTitle(short);
    expect(finalTitle).toBe(short + TITLE_BRAND_SUFFIX); // brand presente
    for (const locale of LOCALES) {
      // Lo strip del brand dentro differentiateH1FromTitle riporta al testo
      // originale, quindi la collisione viene comunque vista e differenziata.
      expect(differentiateH1FromTitle(short, finalTitle, locale)).toBe(
        differentiateH1FromTitle(short, short, locale),
      );
    }
    // …e un h1 genuinamente diverso resta intatto in entrambe le forme.
    for (const locale of LOCALES) {
      expect(differentiateH1FromTitle('Un h1 completamente diverso', finalTitle, locale))
        .toBe('Un h1 completamente diverso');
    }
  });

  it('lo strip del brand di differentiateH1FromTitle copre la forma emessa da normalizeShellTitle', () => {
    // Le due funzioni hanno regex di strip indipendenti (`[|·]` di la',
    // solo `|` di qua). Questo pinna che la forma REALMENTE emessa cade
    // nell'intersezione: se qualcuno cambiasse il separatore del brand da una
    // parte sola, il confronto smetterebbe di vedere le collisioni.
    const emitted = normalizeShellTitle('Stipendio netto frontaliere');
    expect(emitted).toContain(TITLE_BRAND_SUFFIX);
    expect(differentiateH1FromTitle('Stipendio netto frontaliere', emitted, 'it'))
      .not.toBe('Stipendio netto frontaliere');
  });
});

describe('il budget di lunghezza si misura sulla stringa ESCAPED', () => {
  it('l\'escape inline di titleSuffix.ts e\' equivalente a escHtml, carattere per carattere', () => {
    // `normalizeShellTitle` non importa `escHtml` di proposito: titleSuffix.ts
    // e' `mode: identical` e il suo gemello sul corpus non ha
    // `host/shared/htmlEscape.ts`, quindi l'import romperebbe la copia. Il
    // prezzo di quella scelta e' una duplicazione, e questo test e' cio' che
    // impedisce alle due copie di divergere in silenzio: se qualcuno
    // aggiungesse (o togliesse) una sostituzione da una sola parte, il budget
    // del cap SERP smetterebbe di corrispondere all'escape reso a valle.
    const probes = [
      'Rossi & Figli Sagl',
      'Offerte "aperte" <oggi>',
      '&<>"',
      '&amp; gia\' escapato',
      'nessun carattere speciale',
      'a&b<c>d"e',
      '"""',
      '<<<',
      '',
    ];
    for (const probe of probes) {
      // Confronto DIRETTO sulle due funzioni, non sul titolo che ne esce:
      // una versione precedente di questo test confrontava l'output di
      // `normalizeShellTitle`, e restava VERDE se si toglieva la sostituzione
      // di `"` — perche' su probe corte il brand ci sta comunque e le due
      // stringhe finali coincidono. Provato per mutazione: quella forma era
      // una guardia morta.
      expect(escapeForBudget(probe), JSON.stringify(probe)).toBe(escHtml(probe));
    }
    // Sweep carattere per carattere su tutto l'ASCII stampabile: nessuna
    // sostituzione puo' essere aggiunta o tolta da una sola parte.
    for (let code = 32; code < 127; code += 1) {
      const ch = String.fromCharCode(code);
      expect(escapeForBudget(ch), `U+${code.toString(16)}`).toBe(escHtml(ch));
    }
  });

  it('una headline che sta sotto il cap PRIMA dell\'escape e sopra DOPO perde il brand', () => {
    // La ragione per cui il budget e' escaped e non grezzo: htmlTemplate rende
    // il titolo attraverso `esc()` esattamente una volta, quindi un `&` grezzo
    // costa 5 caratteri in pagina, non 1.
    // raw=43, escaped=47: col budget grezzo 43+21=64 sta nel cap 66, con
    // quello escaped 47+21=68 no. La finestra fra i due e' il difetto che il
    // budget escaped chiude.
    const withEntities = 'Rossi & Figli Sagl: offerte aperte a Lugano';
    expect(withEntities.length + TITLE_BRAND_SUFFIX.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(escHtml(withEntities).length + TITLE_BRAND_SUFFIX.length).toBeGreaterThan(TITLE_MAX_CHARS);

    // Col budget grezzo il brand ci starebbe…
    const rawBudget = buildTitleWithBrand(withEntities, TITLE_BRAND_SUFFIX, undefined, (s) => s.length);
    expect(rawBudget).toBe(withEntities + TITLE_BRAND_SUFFIX);
    // …col budget escaped no, ed e' quello che normalizeShellTitle usa.
    expect(normalizeShellTitle(withEntities)).not.toBe(rawBudget);
    expect(normalizeShellTitle(withEntities)).toBe(withEntities);
  });
});
