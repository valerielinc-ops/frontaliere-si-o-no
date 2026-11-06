import { describe, expect, it } from 'vitest';
import {
  MIN_SOURCE_BODY_WORDS,
  meetsSourceBodyFloor,
  sourceBodyWordCount,
} from '../scripts/lib/source-body-floor.mjs';

const words = (n: number, word = 'Aufgabe') => Array.from({ length: n }, () => word).join(' ');

describe('source body word floor (issue 5253, NN #4)', () => {
  it('is 50 words', () => {
    expect(MIN_SOURCE_BODY_WORDS).toBe(50);
  });

  it('counts words, not markdown markers, tags or punctuation', () => {
    expect(sourceBodyWordCount('## Titel\n\n- eins\n- zwei\n**drei** — vier')).toBe(5);
    expect(sourceBodyWordCount('<p>eins <b>zwei</b></p><ul><li>drei</li></ul>')).toBe(3);
    expect(sourceBodyWordCount('')).toBe(0);
  });

  it('rejects a 49-word body however many characters it has', () => {
    const long49 = words(49, 'Verantwortungsbewusstsein');
    expect(long49.length).toBeGreaterThan(1000);
    expect(meetsSourceBodyFloor(long49)).toBe(false);
  });

  it('accepts a 50-word body', () => {
    expect(meetsSourceBodyFloor(words(50))).toBe(true);
  });
});
