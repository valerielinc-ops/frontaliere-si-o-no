// tests/scripts/llm-json-repair.test.ts
//
// Regression: publishing a journalist article whose title contains a quoted
// phrase (e.g. `..."tassa sulla salute"...`) crashed FAQ generation with
// "Unterminated string in JSON" because the LLM echoed the quoted phrase
// into a generated FAQ answer without escaping the inner quotes, and the
// quote-toggle string repair (`inStr = !inStr` on every `"`) desynced.
// scripts/batch-add-faq-to-articles.mjs and scripts/create-article.mjs both
// had this bug inlined — fixed once in shared ./lib/llm-json-repair.mjs.

import { describe, expect, it } from 'vitest';
import { stripCodeFences, findMatchingClose, fixJsonStringBody } from '../../scripts/lib/llm-json-repair.mjs';

describe('fixJsonStringBody', () => {
  it('escapes an unescaped inner quote so the string does not terminate early', () => {
    const broken = '{"q":"Cosa dice la Convenzione sulla "tassa sulla salute"?","a":"Risposta."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.q).toBe('Cosa dice la Convenzione sulla "tassa sulla salute"?');
    expect(parsed.a).toBe('Risposta.');
  });

  it('reproduces the original failure scenario: FAQ array echoing a quoted article title', () => {
    const title = 'LA SOSPENSIONE DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA: IL CASO DELLA "TASSA SULLA SALUTE"';
    const broken = `[{"q":"Cosa prevede l'articolo citato in ${title}?","a":"La Convenzione regola il caso della "tassa sulla salute" in modo specifico."}]`;
    const repaired = fixJsonStringBody(broken);
    expect(() => JSON.parse(repaired)).not.toThrow();
    const parsed = JSON.parse(repaired);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].a).toContain('"tassa sulla salute"');
  });

  it('handles two adjacent quoted words followed by the real closing quote', () => {
    const broken = '{"a":"He said "hi""}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('He said "hi"');
  });

  it('still converts literal newlines/CR inside strings', () => {
    const broken = '{"a":"line one\nline two\r"}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('line one\nline two');
  });

  it('preserves already-escaped quotes untouched', () => {
    const valid = '{"a":"already \\"escaped\\" fine"}';
    const repaired = fixJsonStringBody(valid);
    expect(JSON.parse(repaired).a).toBe('already "escaped" fine');
  });

  it('does not repair well-formed JSON with no quirks', () => {
    const valid = '{"q":"Simple question?","a":"Simple answer."}';
    expect(JSON.parse(fixJsonStringBody(valid))).toEqual({ q: 'Simple question?', a: 'Simple answer.' });
  });

  it('converts stray markdown-bold asterisks outside strings to commas when fixAsterisks is set', () => {
    const broken = '{"a":"bold text"***"b":"next"}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    expect(JSON.parse(repaired)).toEqual({ a: 'bold text', b: 'next' });
  });

  it('leaves asterisks inside strings untouched even with fixAsterisks set', () => {
    const valid = '{"a":"**bold** markdown"}';
    const repaired = fixJsonStringBody(valid, { fixAsterisks: true });
    expect(JSON.parse(repaired).a).toBe('**bold** markdown');
  });
});

describe('stripCodeFences', () => {
  it('strips leading/trailing ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced content untouched', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('findMatchingClose', () => {
  it('finds the matching bracket, ignoring brackets inside strings', () => {
    const src = '[{"a":"contains ] and } chars"},{"b":2}]';
    const close = findMatchingClose(src, 0);
    expect(close).toBe(src.length - 1);
  });

  it('returns -1 when unbalanced', () => {
    expect(findMatchingClose('[{"a":1}', 0)).toBe(-1);
  });
});
