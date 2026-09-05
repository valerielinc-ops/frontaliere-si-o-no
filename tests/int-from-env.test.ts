/**
 * Issue #7344 — `Number(process.env.X || N)` restituisce `NaN` per un valore
 * non numerico, e `NaN` non lancia: si propaga in tetti, limiti di concorrenza
 * e finestre temporali senza rendere rosso niente. La PR #7300 aveva corretto
 * UN sito; qui si pinna il predicato condiviso e il gate che vieta il ritorno
 * del costrutto.
 */
import { describe, expect, it, vi } from 'vitest';
import { intFromEnv } from '../scripts/lib/int-from-env.mjs';
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
