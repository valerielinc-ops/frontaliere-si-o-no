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
import { stripCodeFences, findMatchingClose, fixJsonStringBody, describeJsonParseError, describeRawForDiagnostics } from '../../scripts/lib/llm-json-repair.mjs';

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

  // Regression (issue #3602): afterSeparatorLooksValid's comma-branch only ever
  // tried interpreting a quoted candidate following a comma as a fresh object
  // KEY (must be followed by ':'), returning false outright otherwise. A comma
  // inside an array separates bare VALUES, not key:value pairs, so this
  // corrupted every plain string-array field (e.g. tags) by merging elements.
  it('does not merge bare string-array elements at a plain comma separator', () => {
    const broken = '{"tags":["a","b"],"body":"ok"}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.body).toBe('ok');
  });

  it('still rejects a comma-then-quoted-aside as an array separator when the fallback value never resolves (no regression from the #3602 fix)', () => {
    const broken = '{"a":"il termine "tassa", "un tributo", e discusso."}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('il termine "tassa", "un tributo", e discusso.');
  });

  // Regression: decideQuoteCloses() unconditionally trusted any quote
  // immediately followed by a '*' run (fixAsterisks) as a genuine closer,
  // without checking that what follows the run looks like a real
  // continuation — unlike the comma/colon branches, which do. Bold markdown
  // routinely sits INSIDE a still-open string right after an earlier stray
  // quote, so this closed the string early and corrupted everything after
  // it, including unrelated sibling JSON keys (issue #3618 item 2).
  it('does not close a string early at a stray quote merely because markdown bold follows, when the bold is literal content still inside the string', () => {
    const broken = '{"a":"testo "citato" **grassetto** fine.","b":"next"}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.a).toBe('testo "citato" **grassetto** fine.');
    expect(parsed.b).toBe('next');
  });

  it('still converts a genuine markdown-bold separator between two bare array string elements', () => {
    const broken = '{"tags":["value1"**"value2"],"c":1}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.tags).toEqual(['value1', 'value2']);
    expect(parsed.c).toBe(1);
  });

  // Regression lock for the exact issue #3618 item 2 repro shape
  // (imagePrompt/imageAlt, the real article-schema field pair this bug hits
  // in production) — the generic 'a'/'b' test above already covers the
  // mechanism, this pins the literal cited shape so it can't silently
  // regress under a future refactor of either field's schema.
  it('does not corrupt imagePrompt/imageAlt when a markdown-bold run precedes a stray unescaped quote inside imagePrompt (issue #3618 item 2 exact repro)', () => {
    const broken =
      '{"imagePrompt":"Un **famoso** spot di pesca "vicino al lago".","imageAlt":{"it":"Vista panoramica"}}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.imagePrompt).toBe('Un **famoso** spot di pesca "vicino al lago".');
    expect(parsed.imageAlt).toEqual({ it: 'Vista panoramica' });
  });

  // Regression: scanValueEnd() treated '{'/'[' as ending the value immediately
  // after the opening bracket instead of finding the matching close. That made
  // the lookahead wrongly reject a preceding string field's real closing quote
  // whenever it was followed by a nested-object field — e.g. the article
  // schema's imagePrompt (string) always followed by imageAlt ({it,en,de,fr}) —
  // corrupting already-valid JSON (run 28751915972).
  it('does not corrupt a valid string field immediately followed by a nested locale object', () => {
    const valid = '{"title":"Test","imagePrompt":"Panoramic view of Lugano.","imageAlt":{"it":"Vista panoramica.","en":"Panoramic view","de":"Panoramablick","fr":"Vue panoramique"}}';
    expect(JSON.parse(valid)).toBeTruthy(); // sanity: input is already valid JSON
    const repaired = fixJsonStringBody(valid, { fixAsterisks: true });
    expect(repaired).toBe(valid);
    expect(JSON.parse(repaired)).toEqual(JSON.parse(valid));
  });

  it('does not corrupt a valid string field immediately followed by a nested array of objects (body3 -> faq shape)', () => {
    const valid = '{"body3":"Step-by-step guide.","faq":[{"q":"Domanda 1?","a":"Risposta 1."},{"q":"Domanda 2?","a":"Risposta 2."}]}';
    const repaired = fixJsonStringBody(valid, { fixAsterisks: true });
    expect(repaired).toBe(valid);
    expect(JSON.parse(repaired)).toEqual(JSON.parse(valid));
  });

  it('still escapes a genuine embedded quote in a string value immediately followed by a nested-object sibling key', () => {
    const broken = '{"imagePrompt":"Scena con la "tassa sulla salute" citata.","imageAlt":{"it":"Vista panoramica","en":"Panoramic view"}}';
    const repaired = fixJsonStringBody(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.imagePrompt).toBe('Scena con la "tassa sulla salute" citata.');
    expect(parsed.imageAlt).toEqual({ it: 'Vista panoramica', en: 'Panoramic view' });
  });

  // Regression: findMatchingClose() walked strings with a naive unescaped-
  // quote toggle. A nested value with an ODD count of stray embedded quotes
  // before its real closer (e.g. a quoted term missing its closing mark)
  // flips the toggle's parity, so the brace-depth counter never reaches (or
  // reaches too early) the true matching '}' — returning -1 and making the
  // '{'/'[' branch of scanValueEnd wrongly reject the *preceding* sibling
  // field's real closing quote, corrupting it (PR #3601 round-1 review).
  it('does not corrupt the preceding sibling field when a nested object value has an odd stray-quote count', () => {
    const broken = '{"imagePrompt":"Scena con la torre.","imageAlt":{"it":"La chiamano torre "di Lugano, simbolo della citta.","en":"Panoramic view"}}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.imagePrompt).toBe('Scena con la torre.');
    expect(parsed.imageAlt.en).toBe('Panoramic view');
  });

  it('does not corrupt the preceding sibling field when a faq array item has an odd stray-quote count', () => {
    const broken = '{"body3":"Testo introduttivo.","faq":[{"q":"Cosa significa "frontaliere nel senso ampio?","a":"Risposta."}]}';
    const repaired = fixJsonStringBody(broken, { fixAsterisks: true });
    const parsed = JSON.parse(repaired);
    expect(parsed.body3).toBe('Testo introduttivo.');
    expect(parsed.faq).toHaveLength(1);
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

describe('describeJsonParseError', () => {
  // Regression: several call sites logged a raw[0:300] snippet of the
  // PRE-repair text next to a JSON.parse() error whose "position N" is
  // computed against the POST-repair string — repairLlmJson/repairJsonArray
  // change the string's length (escaping quotes, collapsing \n, stripping
  // code fences), so the two coordinate systems don't match and the logged
  // snippet never showed the actual failing byte (run 28744325535).
  it('centers the excerpt on the position reported by a real JSON.parse SyntaxError', () => {
    const repaired = '{"a":"ok","b":"bad}'; // missing closing quote before }
    let err: Error;
    try {
      JSON.parse(repaired);
      throw new Error('expected JSON.parse to throw');
    } catch (e) {
      err = e as Error;
    }
    const described = describeJsonParseError(repaired, err);
    expect(described).toMatch(/position \d+/);
    expect(described).toContain('<<HERE>>');
    // The reported position must fall inside the ACTUAL repaired string,
    // not some unrelated pre-repair offset.
    const m = /position (\d+)/.exec(err.message);
    expect(m).not.toBeNull();
  });

  it('falls back to a plain prefix when the error message has no position', () => {
    const described = describeJsonParseError('{"a":1}', new Error('some non-standard parse error'));
    expect(described).toMatch(/^repaired\[0:\d+\]:/);
    expect(described).not.toContain('<<HERE>>');
  });

  it('clamps the window to the string bounds near the end', () => {
    const repaired = '{"a":"short"}';
    const err = new Error(`Unexpected end of JSON input at position ${repaired.length + 50}`);
    const described = describeJsonParseError(repaired, err);
    // Must not throw/slice out of bounds — position is clamped to string length.
    expect(described).toContain(`position ${repaired.length}`);
  });
});

describe('describeRawForDiagnostics', () => {
  it('returns the full string when it fits within maxChars', () => {
    const raw = '{"a":"short"}';
    const result = describeRawForDiagnostics(raw, 4000);
    expect(result).toBe(`raw[0:${raw.length}]: ${raw}`);
  });

  it('splits head+tail when string exceeds maxChars', () => {
    const raw = 'A'.repeat(10000);
    const result = describeRawForDiagnostics(raw, 100);
    expect(result).toMatch(/^raw\[0:50\]\.\.\.\[9950:10000\]/);
    expect(result).toContain('total 10000');
    expect(result).toContain('omitted');
    // head + tail each 50 chars
    expect(result).toContain('A'.repeat(50));
  });

  it('normalises \\r\\n to \\\\n so it does not break log consumers', () => {
    const raw = 'line1\r\nline2\r\nline3';
    const result = describeRawForDiagnostics(raw, 4000);
    expect(result).not.toContain('\r');
    expect(result).toContain('\\n');
    expect(result).toContain('line1\\nline2\\nline3');
  });

  it('normalises bare \\r to \\\\n', () => {
    const raw = 'line1\rline2';
    const result = describeRawForDiagnostics(raw, 4000);
    expect(result).not.toContain('\r');
    expect(result).toContain('line1\\nline2');
  });

  it('handles null/undefined gracefully', () => {
    expect(() => describeRawForDiagnostics(null)).not.toThrow();
    expect(() => describeRawForDiagnostics(undefined)).not.toThrow();
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

  // Regression for repairLlmJson: using lastIndexOf('}') instead of
  // findMatchingClose pulled in a foreign '}' from trailing LLM prose,
  // slicing the JSON at a spurious interior boundary (issue #3615 class).
  it('returns the first balanced close, not the last } in the string, so trailing prose with braces does not corrupt extraction', () => {
    const src = '{"id":"test","content":"val"} trailing {prose}';
    const close = findMatchingClose(src, 0);
    // Should point to the outer } of the JSON object (position 28), not the
    // last } in the string (position 45 in the trailing prose).
    expect(src[close]).toBe('}');
    expect(src.slice(0, close + 1)).toBe('{"id":"test","content":"val"}');
    // lastIndexOf would return 45 (wrong); findMatchingClose returns 28 (correct).
    expect(close).toBeLessThan(src.lastIndexOf('}'));
  });

  // Regression for repairLlmJson: when raw is truncated inside a string
  // literal (LLM hits token limit mid-body), findMatchingClose returns -1
  // so the caller falls back to lastIndexOf — same as before, no regression.
  it('returns -1 for JSON truncated inside an unterminated string literal', () => {
    const truncated = '{"id":"test","content":{"body1":"very long string that never ends...';
    expect(findMatchingClose(truncated, 0)).toBe(-1);
  });
});
