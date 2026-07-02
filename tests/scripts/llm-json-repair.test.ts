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

  it('does not mistake a prose comma after a quoted phrase for a property separator', () => {
    const broken = '{"a":"L\'articolo menziona "tassa sulla salute", che è controversa."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('L\'articolo menziona "tassa sulla salute", che è controversa.');
  });

  it('does not mistake a prose colon after a quoted phrase for a key:value separator', () => {
    const broken = '{"a":"Il termine "tassa": significa imposta."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('Il termine "tassa": significa imposta.');
  });

  it('still treats a comma followed by a real next key as a genuine separator', () => {
    const broken = '{"a":"contains "quoted" text","b":"next"}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('contains "quoted" text');
    expect(parsed.b).toBe('next');
  });

  it('does not mistake a prose colon-then-percentage after a quoted phrase for a key:value separator', () => {
    const broken = '{"a":"La tassa "IVA": 8% del prezzo."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('La tassa "IVA": 8% del prezzo.');
  });

  it('does not mistake a prose colon-then-count after a quoted phrase for a key:value separator', () => {
    const broken = '{"a":"Il costo "extra": 100 franchi al mese."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('Il costo "extra": 100 franchi al mese.');
  });

  it('does not mistake a prose colon-then-negative-number after a quoted phrase for a key:value separator', () => {
    const broken = '{"a":"il calo è "forte": -5% ieri."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('il calo è "forte": -5% ieri.');
  });

  it('still treats a colon followed by a genuine numeric value as a real key:value separator', () => {
    const broken = '{"a":"contains "quoted" text","count":42}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('contains "quoted" text');
    expect(parsed.count).toBe(42);
  });

  it('still treats a colon followed by a genuine boolean value as a real key:value separator', () => {
    const broken = '{"a":"contains "quoted" text","ok":true}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('contains "quoted" text');
    expect(parsed.ok).toBe(true);
  });

  it('does not mistake a prose colon-then-quoted-definition after a quoted term for a key:value separator (round-3 regression)', () => {
    const broken = '{"a":"Il termine "tassa": "un tributo" imposto dallo stato."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('Il termine "tassa": "un tributo" imposto dallo stato.');
  });

  it('does not mistake a prose comma-then-quoted-aside after a quoted term for an array/property separator', () => {
    const broken = '{"a":"il termine "tassa", "un tributo", e discusso."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('il termine "tassa", "un tributo", e discusso.');
  });

  it('still treats a comma followed by a real next key with its own embedded quote as a genuine separator', () => {
    const broken = '{"a":"Il termine "extra" qui.","b":"Anche "questo" qui."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('Il termine "extra" qui.');
    expect(parsed.b).toBe('Anche "questo" qui.');
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
