/**
 * Pins the verdict-precedence of `categorizeLocaleVerdicts`
 * (scripts/audit-article-corpus-drift.mjs).
 *
 * This logic has been wrong twice. Both regressions had the same shape: a
 * verdict the code could not interpret fell through to `'ok'`, so the audit
 * reported success while having verified nothing — the exact opposite of the
 * fail-loud contract the script states for itself.
 *
 *   1st (PR #4908): no `'unknown'` branch at all.
 *   2nd (PR #4914): a branch that only fired when EVERY locale was
 *      `'unknown'`, so a mix (it=ok, en=unknown) still passed silently.
 *
 * Hence these tests assert the precedence directly rather than the happy
 * path only: the mixed cases are where the bug lived both times.
 */
import { describe, it, expect } from 'vitest';
import { categorizeLocaleVerdicts, DIVERGENT_CATEGORIES } from '../scripts/audit-article-corpus-drift.mjs';
import { assertCorpusObserved } from '../scripts/lib/assert-corpus-observed.mjs';

describe('categorizeLocaleVerdicts — precedence', () => {
  it('reports no-locale-verdicts when the checker printed nothing', () => {
    expect(categorizeLocaleVerdicts({})).toBe('no-locale-verdicts');
    expect(categorizeLocaleVerdicts(undefined)).toBe('no-locale-verdicts');
  });

  it('reports ok only when every locale is genuinely ok', () => {
    expect(categorizeLocaleVerdicts({ it: 'ok', en: 'ok', de: 'ok', fr: 'ok' })).toBe('ok');
  });

  it('reports content-mismatch — real drift outranks everything else', () => {
    expect(
      categorizeLocaleVerdicts({ it: 'content-mismatch', en: 'unknown', de: 'ok', fr: 'render-failure' }),
    ).toBe('content-mismatch');
  });

  // The 2nd-regression case: a single unparseable locale among healthy ones.
  it('reports unrecognized-verdicts when even ONE locale is unknown', () => {
    expect(categorizeLocaleVerdicts({ it: 'ok', en: 'unknown', de: 'ok', fr: 'ok' })).toBe(
      'unrecognized-verdicts',
    );
  });

  // The 1st-regression case.
  it('reports unrecognized-verdicts when every locale is unknown', () => {
    expect(categorizeLocaleVerdicts({ it: 'unknown', en: 'unknown', de: 'unknown', fr: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
  });

  it('lets unknown outrank tolerated noise, so a partial check never reads as a pass', () => {
    expect(categorizeLocaleVerdicts({ it: 'cf-bot-script-only', en: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
    expect(categorizeLocaleVerdicts({ it: 'render-failure', en: 'unknown' })).toBe('unrecognized-verdicts');
    expect(categorizeLocaleVerdicts({ it: 'fetch-or-liveness', en: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
  });

  it('keeps the tolerated-noise ordering among themselves', () => {
    expect(categorizeLocaleVerdicts({ it: 'cf-bot-script-only', en: 'render-failure' })).toBe(
      'ok-cf-bot-script-only',
    );
    expect(categorizeLocaleVerdicts({ it: 'render-failure', en: 'fetch-or-liveness' })).toBe(
      'render-failure',
    );
    expect(categorizeLocaleVerdicts({ it: 'fetch-or-liveness', en: 'ok' })).toBe('fetch-or-liveness');
  });

  it('fails the run for exactly the categories that mean "not verified"', () => {
    // Guards the pairing between the precedence above and the failing set:
    // a category can only be added to one without considering the other.
    // Imports the real Set rather than regex-parsing the source, so a
    // reformat of the literal cannot silently neuter this assertion
    // (reviewer finding on PR #4915).
    expect([...DIVERGENT_CATEGORIES].sort()).toEqual(
      ['content-mismatch', 'no-locale-verdicts', 'unrecognized-verdicts'].sort(),
    );
  });

  it('never fails the run for a category the precedence can return as a pass', () => {
    // The other half of the pairing: every non-divergent category the
    // categorizer can produce must be absent from the failing set.
    for (const c of ['ok', 'ok-cf-bot-script-only', 'render-failure', 'fetch-or-liveness']) {
      expect(DIVERGENT_CATEGORIES.has(c)).toBe(false);
    }
  });
});

/**
 * Terza occorrenza della stessa classe descritta nell'header: l'audit esce 0
 * dichiarando successo dopo aver verificato zero articoli. Le prime due volte
 * era il categorizzatore; qui e' il campione vuoto.
 *
 * Riproduce la run 32620849579 (2026-08-23), l'unico verde in sei run:
 * `corpusSize=0 sampled=0` su entrambe le sezioni, poi `PASS`, poi
 * `conclusion: success`. Senza questo caso il prossimo profilo sparse che
 * ampute l'albero rifabbrica quel verde senza che nessuno lo veda — e questo
 * workflow non ha, per scelta, nessuno step `if: failure()` che apra una issue.
 */
describe('assertSomethingWasObserved — «non ho osservato niente» non e` PASS', () => {
  it('rifiuta la run 32620849579: due sezioni, corpusSize 0, sampled 0', () => {
    expect(() =>
      assertCorpusObserved('[t]', {
        frontaliere: { total: 0, observed: 0 },
        svizzera: { total: 0, observed: 0 },
      }),
    ).toThrow(/zero articoli osservati/);
  });

  it('nomina nel messaggio la sezione e i suoi conteggi, non solo «errore»', () => {
    // Il messaggio E` la diagnosi: la run non ha issue e il report va letto a
    // mano, quindi i numeri devono stare nella riga di log.
    expect(() => assertCorpusObserved('[t]', { svizzera: { total: 0, observed: 0 } })).toThrow(
      /svizzera: total=0 observed=0/,
    );
  });

  it('rifiuta anche il caso senza sezioni selezionate', () => {
    expect(() => assertCorpusObserved('[t]', {})).toThrow(/nessuna sezione selezionata/);
  });

  it('non e` una soglia: un solo articolo osservato passa', () => {
    // Il confronto e` contro zero. Alzare questo numero trasformerebbe una
    // guardia di osservabilita` in un gate sulla dimensione del campione.
    expect(() =>
      assertCorpusObserved('[t]', {
        frontaliere: { total: 3889, observed: 1 },
        svizzera: { total: 0, observed: 0 },
      }),
    ).not.toThrow();
  });

  it('passa quando il campione e` quello della run rossa reale (10 + 10)', () => {
    expect(() =>
      assertCorpusObserved('[t]', {
        frontaliere: { total: 3889, observed: 10 },
        svizzera: { total: 1899, observed: 10 },
      }),
    ).not.toThrow();
  });
});
