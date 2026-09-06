/**
 * Issue #7344 — `Number(process.env.X || N)` restituisce `NaN` per un valore
 * non numerico, e `NaN` non lancia: si propaga in tetti, limiti di concorrenza
 * e finestre temporali senza rendere rosso niente. La PR #7300 aveva corretto
 * UN sito; qui si pinna il predicato condiviso e il gate che vieta il ritorno
 * del costrutto.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { intFromEnv, positiveIntFromEnv } from '../scripts/lib/int-from-env.mjs';
import { findViolations, lineHasNumberEnvFallback } from '../scripts/ci/check-number-env-fallback.mjs';

describe('intFromEnv — comportamento', () => {
  it('un valore non numerico NON diventa NaN: cade sul default e lo dice', () => {
    const warn = vi.fn();
    for (const raw of ['abc', '30s', '8_000', '$UNRESOLVED', '1,5', 'NaN']) {
      expect(intFromEnv('X', 42, { env: { X: raw }, warn }), `${raw} accettato`).toBe(42);
    }
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    expect(warn.mock.calls[0][0]).toContain('X=');
  });

  it('assente o vuota cade sul default IN SILENZIO: non impostarla e legittimo', () => {
    const warn = vi.fn();
    expect(intFromEnv('X', 42, { env: {}, warn })).toBe(42);
    expect(intFromEnv('X', 42, { env: { X: '' }, warn })).toBe(42);
    expect(intFromEnv('X', 42, { env: { X: '   ' }, warn })).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lo zero esplicito SOPRAVVIVE: e un valore, non un modo di dire «non impostata»', () => {
    // `Number('')` fa 0 e `Number.isFinite(0)` e' vero: senza intercettare la
    // stringa vuota PRIMA, un `X=''` azzererebbe un tetto invece di lasciarlo
    // al default. E senza distinguere i due casi, un `X=0` deliberato (spendi
    // zero) verrebbe rimpiazzato dal default.
    expect(intFromEnv('BUDGET', 4500, { env: { BUDGET: '0' }, warn: vi.fn() })).toBe(0);
    expect(intFromEnv('BUDGET', 4500, { env: { BUDGET: '' }, warn: vi.fn() })).toBe(4500);
  });

  it('accetta interi validi, con spazi e segno; rifiuta i frazionari', () => {
    expect(intFromEnv('X', 1, { env: { X: '2000' } })).toBe(2000);
    expect(intFromEnv('X', 1, { env: { X: ' 2000 ' } })).toBe(2000);
    expect(intFromEnv('X', 1, { env: { X: '-5' } })).toBe(-5);
    expect(intFromEnv('X', 1, { env: { X: '12.5' }, warn: vi.fn() })).toBe(1);
    expect(intFromEnv('X', 1, { env: { X: 'Infinity' }, warn: vi.fn() })).toBe(1);
  });

  it('il default puo essere un intero calcolato: e il valore, non una stringa', () => {
    expect(intFromEnv('X', 5 * 60 * 1000, { env: {} })).toBe(300_000);
    // Il costrutto vecchio faceva `Number('2')` e rendeva 2; il default deve
    // restare dello stesso tipo anche quando la variabile e' assente.
    expect(typeof intFromEnv('X', 2, { env: {} })).toBe('number');
  });
});

describe('check-number-env-fallback — il gate che impedisce il rientro', () => {
  it('riconosce il costrutto vietato, e solo quello', () => {
    expect(lineHasNumberEnvFallback('const a = Number(process.env.X || 8000);')).toBe(true);
    expect(lineHasNumberEnvFallback('  timeoutMs: Number( process.env.FOO_MS || 120_000 ),')).toBe(true);
    // La forma con l'alternativa FUORI non e' il difetto: li' NaN e' falsy e
    // cade sul default per costruzione.
    expect(lineHasNumberEnvFallback('const a = Number(process.env.X) || 8000;')).toBe(false);
    expect(lineHasNumberEnvFallback('const a = process.env.X || 8000;')).toBe(false);
  });

  it('non flagga la stessa stringa dentro un commento', () => {
    expect(lineHasNumberEnvFallback(" * `Number(process.env.X || 8000)` non e' `Number(process.env.X) || 8000`")).toBe(false);
    expect(lineHasNumberEnvFallback('// era Number(process.env.X || 4500)')).toBe(false);
    expect(lineHasNumberEnvFallback('const a = 1; // Number(process.env.X || 8000)')).toBe(false);
  });

  it('l albero corrente non contiene piu il costrutto', () => {
    expect(findViolations()).toEqual([]);
  });
});

/**
 * Corpus #884 — `intFromEnv` chiude il buco del `NaN`, ma un conteggio
 * NEGATIVO o ZERO e' un intero finito: lo attraversa e spegne comunque la
 * regola. `slice(0, -5)` scarta dalla coda, `i += 0` non avanza mai.
 */
describe('positiveIntFromEnv — il conteggio che non puo essere <= 0', () => {
  it('rifiuta zero e negativi, che intFromEnv accetta come interi validi', () => {
    const warn = vi.fn();
    // La differenza col fratello: qui e' proprio questo il difetto da chiudere.
    expect(intFromEnv('MAX', 100, { env: { MAX: '-5' }, warn: vi.fn() })).toBe(-5);
    expect(positiveIntFromEnv('MAX', 100, { env: { MAX: '-5' }, warn })).toBe(100);
    expect(positiveIntFromEnv('MAX', 100, { env: { MAX: '0' }, warn })).toBe(100);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    expect(warn.mock.calls[0][0]).toContain('intero positivo');
  });

  it('rifiuta frazionari e non numerici, come il fratello', () => {
    const warn = vi.fn();
    for (const raw of ['0.5', '12.5', 'tre', '30s', 'Infinity', 'NaN']) {
      expect(positiveIntFromEnv('MAX', 25, { env: { MAX: raw }, warn }), `${raw} accettato`).toBe(25);
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('assente o vuota cade sul default IN SILENZIO', () => {
    const warn = vi.fn();
    expect(positiveIntFromEnv('MAX', 25, { env: {}, warn })).toBe(25);
    expect(positiveIntFromEnv('MAX', 25, { env: { MAX: '' }, warn })).toBe(25);
    expect(positiveIntFromEnv('MAX', 25, { env: { MAX: '  ' }, warn })).toBe(25);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accetta gli interi positivi, con spazi', () => {
    expect(positiveIntFromEnv('MAX', 25, { env: { MAX: '7' } })).toBe(7);
    expect(positiveIntFromEnv('MAX', 25, { env: { MAX: ' 100000 ' } })).toBe(100000);
  });
});

describe('i call site dove un conteggio non positivo SPEGNE la regola', () => {
  // Il criterio (corpus #884): il valore finisce in uno `slice`, in un indice,
  // o nel passo di un `for`. Pinnati per nome perche' un ritorno al costrutto
  // grezzo su QUESTI file e' il guasto silenzioso, non una preferenza di stile.
  const SLICE_BOUND = [
    ['scripts/create-article.mjs', 'GOOGLE_NEWS_INJECT_MAX'],
    ['scripts/update-afry-jobs.mjs', 'AFRY_MAX_DETAIL_PAGES'],
    ['scripts/update-amag-jobs.mjs', 'AMAG_MAX_DETAIL_PAGES'],
    ['scripts/update-axa-jobs.mjs', 'AXA_MAX_DETAIL_PAGES'],
    ['scripts/update-convit-jobs.mjs', 'CONVIT_MAX_DETAIL_PAGES'],
    ['scripts/update-engelvoelkers-jobs.mjs', 'ENGELVOELKERS_MAX_DETAIL_PAGES'],
    ['scripts/update-hitachi-energy-jobs.mjs', 'HITACHI_MAX_DETAIL_PAGES'],
    ['scripts/update-hitachi-energy-jobs.mjs', 'HITACHI_MAX_PAGES'],
    ['scripts/update-hoval-jobs.mjs', 'HOVAL_MAX_DETAIL_PAGES'],
    ['scripts/update-mtic-jobs.mjs', 'MTIC_MAX_DETAIL_PAGES'],
    ['scripts/update-tarchini-group-jobs.mjs', 'TARCHINI_MAX_DETAIL_PAGES'],
    ['scripts/update-aldi-suisse-jobs.mjs', 'JOBS_CRAWLER_CONCURRENCY'],
    ['scripts/update-denner-jobs.mjs', 'JOBS_CRAWLER_CONCURRENCY'],
    ['scripts/update-burkhalter-jobs.mjs', 'JOBS_CRAWLER_CONCURRENCY'],
    ['scripts/update-denner-jobs.mjs', 'JOBS_DENNER_MAX_PAGES'],
    ['scripts/update-migros-jobs.mjs', 'JOBS_MIGROS_MAX_PAGES'],
    ['scripts/update-giorgio-armani-jobs.mjs', 'ARMANI_MAX_LISTING_PAGES'],
  ];

  it.each(SLICE_BOUND)('%s legge %s con positiveIntFromEnv', (file, env) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(src).toContain(`positiveIntFromEnv('${env}'`);
    expect(src).not.toContain(`Number(process.env.${env})`);
    expect(src).toMatch(/import \{[^}]*positiveIntFromEnv[^}]*\} from '\.\/lib\/int-from-env\.mjs';/);
  });
});
