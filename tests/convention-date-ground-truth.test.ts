/**
 * La Convenzione Italia-Svizzera contro le doppie imposizioni e' del 9 marzo
 * 1976 (RS 0.672.945.41, «Convenzione del 9 marzo 1976» su Fedlex). Il
 * generatore dettava «9 DICEMBRE 1976 (NON marzo)» e sia il suo gate sia la
 * denylist del corpus bocciavano la data giusta. Stesso test del repo
 * frontaliere-articles (generator/tests/convention-date-ground-truth.test.mjs).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { mentionsWrongConventionDate, CONVENTION_DATE_IT } from '../scripts/lib/article-factuality-gates.mjs';
import { INCORRECT_FACTS, scanWrongConventionDate } from '../scripts/lib/article-fabrication-patterns.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('data della Convenzione italo-svizzera', () => {
  it.each([
    'La Convenzione italo-svizzera contro le doppie imposizioni, firmata il 9 dicembre 1976, resta in vigore.',
    "Firmata il 9 Dicembre 1976, la Convenzione regola il credito d'imposta.",
    'Convenzione doppie imposizioni: 09/12/1976',
    'Convenzione IT-CH del 9.12.1976',
  ])('rifiuta il 9 dicembre 1976: %s', (text) => {
    expect(mentionsWrongConventionDate(text)).toBe(true);
  });

  it.each([
    'La Convenzione italo-svizzera contro le doppie imposizioni del 9 marzo 1976 resta in vigore.',
    'Convenzione doppie imposizioni: 9/3/1976',
    'La Convenzione citata nel verbale del 19 dicembre 1976.',
    "Il 9 dicembre 1976 e' una data qualunque.\nLa Convenzione e' del 9 marzo 1976.",
  ])('accetta la data giusta e non scatta fuori contesto: %s', (text) => {
    expect(mentionsWrongConventionDate(text)).toBe(false);
  });

  it('espone la data giusta', () => {
    expect(CONVENTION_DATE_IT).toBe('9 marzo 1976');
    expect(mentionsWrongConventionDate(undefined)).toBe(false);
  });

  it('la denylist del corpus non rifiuta il 9 marzo 1976', () => {
    const correct = 'La Convenzione italo-svizzera del 9 marzo 1976 regola il credito d\'imposta.';
    expect(INCORRECT_FACTS.filter(({ pattern }) => pattern.test(correct))).toEqual([]);
  });

  it('la denylist del corpus rifiuta il 9 dicembre 1976', () => {
    const wrong = 'La Convenzione italo-svizzera del 9 dicembre 1976 regola il credito d\'imposta.';
    expect(INCORRECT_FACTS.filter(({ pattern }) => pattern.test(wrong)).length).toBeGreaterThan(0);
  });

  it.each([
    ['it', 'firmata il 9 dicembre 1976', 'firmata il 9 marzo 1976'],
    ['it', 'Convenzione del 09/12/1976', 'Convenzione del 09/03/1976'],
    ['en', 'signed on 9 December 1976', 'signed on 9 March 1976'],
    ['en', 'signed on December 9, 1976', 'signed on March 9, 1976'],
    ['de', 'unterzeichnet am 9. Dezember 1976', 'unterzeichnet am 9. März 1976'],
    ['fr', 'signée le 9 décembre 1976', 'signée le 9 mars 1976'],
  ])('il controllo cross-locale (%s) rifiuta «%s» e accetta «%s»', (locale, wrong, correct) => {
    expect(scanWrongConventionDate(wrong, locale)).toHaveLength(1);
    expect(scanWrongConventionDate(correct, locale)).toEqual([]);
  });

  it('create-article.mjs non detta piu\' la data sbagliata e il gate usa il predicato', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/create-article.mjs'), 'utf-8');
    const offenders = src.split('\n').filter((line) => mentionsWrongConventionDate(line) || /DICEMBRE\s+1976/.test(line));
    expect(offenders).toEqual([]);
    expect((src.match(/9\s+marzo\s+1976/gi) || []).length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('Convenzione 9/3/1976');
    expect(src).toContain('if (mentionsWrongConventionDate(articleText))');
  });
});
