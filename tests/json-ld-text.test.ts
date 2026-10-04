import { describe, expect, it } from 'vitest';
import { escapeControlCharsInJsonStrings, parseJsonLdText } from '../scripts/lib/json-ld-text.mjs';

describe('parseJsonLdText', () => {
  it('parses a well-formed block unchanged', () => {
    expect(parseJsonLdText('{"@type":"Event","name":"A\\nB"}')).toEqual({ '@type': 'Event', name: 'A\nB' });
  });

  it('repairs raw control characters inside string literals as their JSON escapes', () => {
    const raw = '{\n  "@type": "Event",\n  "description": "Line 1\nLine 2\r\n\tTab\u0001end"\n}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseJsonLdText(raw)).toEqual({ '@type': 'Event', description: 'Line 1\nLine 2\r\n\tTab\u0001end' });
  });

  it('respects escaped quotes and backslashes while tracking string boundaries', () => {
    const raw = '{"a":"say \\"hi\\"\nthere","b":"C:\\\\dir\n"}';
    expect(parseJsonLdText(raw)).toEqual({ a: 'say "hi"\nthere', b: 'C:\\dir\n' });
  });

  it('tolerates a BOM and an HTML comment wrapper', () => {
    expect(parseJsonLdText('\uFEFF <!-- {"@type":"Event"} -->')).toEqual({ '@type': 'Event' });
  });

  it('still throws on a block that is malformed for any other reason', () => {
    expect(() => parseJsonLdText('{not json')).toThrow();
    expect(() => parseJsonLdText('{"a":"x\ny",}')).toThrow();
  });

  it('leaves whitespace between tokens alone', () => {
    expect(escapeControlCharsInJsonStrings('{\n\t"a": 1\n}')).toBe('{\n\t"a": 1\n}');
  });
});
