import { describe, expect, it } from 'vitest';
import {
  answerMessage,
  parseNumberAnswer,
  safePattern,
  sanitizeValidation,
  validateAnswer,
} from '../functions/src/lib/answerRules.js';

const TODAY = '2026-09-30';

describe('answer rules written with the questions', () => {
  it('keeps only safe patterns, anchored to the whole answer', () => {
    expect(safePattern('\\d{1,2} mesi')).toBe('^(?:\\d{1,2} mesi)$');
    expect(safePattern('^\\d+$')).toBe('^(?:\\d+)$');
    // Nested quantifiers and backreferences can run for minutes: dropped.
    expect(safePattern('(a+)+$')).toBe('');
    expect(safePattern('(\\w*)*x')).toBe('');
    expect(safePattern('(a)\\1')).toBe('');
    expect(safePattern('[')).toBe('');
    expect(safePattern('a'.repeat(201))).toBe('');
  });

  it('drops a rule that refuses its own example, and keeps the rest consistent', () => {
    const rule = sanitizeValidation({ pattern: '\\d+ anni', minLength: 10, maxLength: 5, min: 9, max: 1, minDate: 'today', example: 'tre anni', message: 'Numero di anni.' }, { type: 'text' });
    expect(rule).toMatchObject({ pattern: '', minLength: 0, maxLength: 5, min: null, max: null, minDate: '', example: 'tre anni', message: 'Numero di anni.' });
    expect(sanitizeValidation({ min: 0, max: 50 }, { type: 'number' })).toMatchObject({ min: 0, max: 50, maxLength: 500 });
    expect(sanitizeValidation({ minDate: 'today' }, { type: 'date' }).minDate).toBe('today');
    expect(sanitizeValidation(undefined, { type: 'choice' })).toMatchObject({ pattern: '', maxLength: 500 });
  });

  it('reads Swiss amounts as numbers', () => {
    expect(parseNumberAnswer("80'000")).toBe(80000);
    expect(parseNumberAnswer('80 000')).toBe(80000);
    expect(parseNumberAnswer('80.000')).toBe(80000);
    expect(parseNumberAnswer('4,5')).toBe(4.5);
    expect(parseNumberAnswer('CHF 80k')).toBeNaN();
  });

  it('checks an answer against its type and rule, the same in the browser and on the server', () => {
    const date = { type: 'date', minDate: TODAY, validation: sanitizeValidation({ minDate: 'today' }, { type: 'date' }) };
    expect(validateAnswer('2027-01-01', date, { todayIso: TODAY })).toEqual({ ok: true });
    expect(validateAnswer('1985-09-12', date, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'date_too_early' });
    expect(validateAnswer('2026-02-30', date, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'not_a_date' });
    const years = { type: 'number', validation: sanitizeValidation({ min: 0, max: 50, message: 'Tra 0 e 50.' }, { type: 'number' }) };
    expect(validateAnswer('12', years, { todayIso: TODAY })).toEqual({ ok: true });
    expect(validateAnswer('120', years, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'too_large', message: 'Tra 0 e 50.' });
    expect(validateAnswer('dodici', years, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'not_a_number' });
    const permit = { type: 'choice', options: ['G', 'B'], validation: null };
    expect(validateAnswer('C', permit, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'not_an_option' });
    const salary = { type: 'text', required: true, validation: sanitizeValidation({ pattern: '.*\\d.*', example: "CHF 80'000", message: 'Indica un importo.' }, { type: 'text' }) };
    expect(validateAnswer("CHF 85'000", salary, { todayIso: TODAY })).toEqual({ ok: true });
    expect(validateAnswer('da concordare', salary, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'pattern' });
    expect(validateAnswer('', salary, { todayIso: TODAY })).toMatchObject({ ok: false, reason: 'required' });
  });

  it('explains a failure with the rule’s message or a default in the candidate’s language', () => {
    const salary = { validation: { example: "CHF 80'000", message: 'Indica un importo.' } };
    expect(answerMessage({ ok: false, reason: 'pattern', message: 'Indica un importo.' }, salary, 'it')).toBe('Indica un importo.');
    expect(answerMessage({ ok: false, reason: 'pattern', message: '' }, salary, 'de')).toBe("Prüf das Format der Antwort. (CHF 80'000)");
    expect(answerMessage({ ok: false, reason: 'date_too_early', message: 'x' }, {}, 'fr')).toBe('La date ne peut pas être dans le passé.');
    expect(answerMessage({ ok: true }, {}, 'it')).toBe('');
  });
});
