import { describe, it, expect } from 'vitest';

import {
  decodeTsStringEscapes,
  repairLegacyDoubleEscapedBreaks,
} from '../packages/articles/engine/shared/tsStringEscapes';

/**
 * The engine lifts `blog.article.<id>.<field>` out of the corpus locale files
 * with a regex rather than a TypeScript parser, so it has to reproduce by hand
 * the value `tsc` would have produced for that literal. Until 2026-08-11 it did
 * that with a chain of `.replace()`, which cannot decode escapes: each pass
 * re-reads the previous pass's output, and the backslash escape — the one that
 * protects every other one — was resolved LAST.
 *
 * The cost was paid in rich results. Measured on corpus `a08f37e8`, 102 of
 * 15,560 `.faq` fields failed the engine's own read (decode -> JSON.parse ->
 * keep pairs with q > 10 and a > 20 chars -> require >= 2), so those articles
 * shipped with neither FAQPage JSON-LD nor the visible accordion — and the
 * `catch` that swallowed the parse error was empty, so nothing said so. Seven of
 * the 102 were caused by this decoder, on data that was written CORRECTLY. The
 * other 95 are corpus-side: 72 carry an unescaped `"` inside the JSON, 23 have
 * fewer than two usable pairs.
 *
 * These tests pin the invariant that makes the class impossible rather than the
 * seven instances: ONE pass, every escape consumed exactly once, output never
 * re-scanned.
 */
describe('decodeTsStringEscapes', () => {
  describe('the three sequences that discriminate a one-pass decoder', () => {
    it('decodes an escaped double quote', () => {
      // Source text `\"` is a TS-escaped quote; its value is a bare `"`.
      expect(decodeTsStringEscapes(String.raw`he said \"hi\"`)).toBe('he said "hi"');
    });

    it('keeps a correctly written JSON escape intact instead of half-decoding it', () => {
      // Source `\\n` is how a JSON newline escape HAS to be spelled inside a
      // single-quoted TS literal; its value is the two characters \ and n.
      // The old chain produced \ + a real newline, and that residual backslash
      // is what made JSON.parse throw on the FAQ. This is the defect itself.
      const decoded = decodeTsStringEscapes(String.raw`line1\\nline2`);
      expect(decoded).toBe('line1\\nline2');
      expect(decoded).not.toContain('\n');
      expect(JSON.parse(`"${decoded}"`)).toBe('line1\nline2');
    });

    it('does not turn a literal backslash followed by n into a newline', () => {
      // Source `\\\\n` -> value `\\n` -> JSON.parse -> the two characters \ and n.
      const decoded = decodeTsStringEscapes(String.raw`x\\\\ny`);
      expect(decoded).toBe(String.raw`x\\ny`);
      expect(JSON.parse(`"${decoded}"`)).toBe(String.raw`x\ny`);
      expect(JSON.parse(`"${decoded}"`)).not.toContain('\n');
    });
  });

  describe('the ordering the chain got wrong', () => {
    it('resolves the backslash escape before the escape it protects, for every JSON letter', () => {
      // Each input is a valid JSON escape spelled for a TS literal. The chain
      // rewrote the inner letter FIRST and left a lone backslash behind, which
      // is an invalid JSON escape.
      for (const letter of ['n', 't', 'r', 'b', 'f']) {
        const sourceText = 'a\\\\' + letter + 'b';
        const decoded = decodeTsStringEscapes(sourceText);
        expect(decoded).toBe('a\\' + letter + 'b');
        expect(() => JSON.parse('"' + decoded + '"')).not.toThrow();
      }
    });

    it('never produces a raw control character inside what will be parsed as JSON', () => {
      // The exact shape of the live failure: a JSON string may not contain a
      // literal newline or tab, only the escaped forms.
      const faqSource = String.raw`[{"q":"question text here","a":"answer\\ttabbed and long enough"}]`;
      const decoded = decodeTsStringEscapes(faqSource);
      expect(() => JSON.parse(decoded)).not.toThrow();
      const parsed = JSON.parse(decoded) as Array<{ a: string }>;
      expect(parsed[0].a).toContain('\t');
    });
  });

  describe('the individual escapes', () => {
    it('maps the modelled ones', () => {
      expect(decodeTsStringEscapes(String.raw`a\nb`)).toBe('a\nb');
      expect(decodeTsStringEscapes(String.raw`a\tb`)).toBe('a b');
      expect(decodeTsStringEscapes(String.raw`a\rb`)).toBe('ab');
      expect(decodeTsStringEscapes(String.raw`l\'impatto`)).toBe("l'impatto");
      expect(decodeTsStringEscapes(String.raw`a\\b`)).toBe(String.raw`a\b`);
    });

    it('decodes \\uXXXX, which the chain left on the page as literal text', () => {
      // Live evidence for why this is not cosmetic, 2026-08-11 on
      // /articoli-frontaliere/permesso-b-imposta-fonte-2026/ :
      //   "soglia dei 120\u00a0000 franchi"  <- rendered exactly like that
      expect(decodeTsStringEscapes(String.raw`120\u00a0000`)).toBe('120\u00a0000');
      expect(decodeTsStringEscapes(String.raw`caff\u00e8`)).toBe('caffè');
    });

    it('passes unmodelled escapes through with the backslash intact', () => {
      // JSON.parse is the component that knows how to read these; swallowing
      // the backslash here would corrupt an otherwise well-formed FAQ.
      expect(decodeTsStringEscapes(String.raw`a\/b`)).toBe(String.raw`a\/b`);
      expect(decodeTsStringEscapes(String.raw`a\qb`)).toBe(String.raw`a\qb`);
      // `\u` not followed by four hex digits must not become U+0000.
      expect(decodeTsStringEscapes(String.raw`a\uZZZZb`)).toBe(String.raw`a\uZZZZb`);
    });

    it('flattens the newline escape to a space when asked, and nothing else', () => {
      // The ONLY difference between the two former decoders: meta values
      // (title/excerpt/imageAlt) are emitted into single-line tags.
      expect(decodeTsStringEscapes(String.raw`a\nb`, { newlineAs: ' ' })).toBe('a b');
      expect(decodeTsStringEscapes(String.raw`a\\b`, { newlineAs: ' ' })).toBe(String.raw`a\b`);
      expect(decodeTsStringEscapes(String.raw`a\"b`, { newlineAs: ' ' })).toBe('a"b');
    });
  });
});

/**
 * End-to-end on two REAL `.faq` values, copied byte for byte out of the corpus
 * at commit a08f37e8. Both must survive the engine's full read after this
 * change; the first one does not survive it today.
 */
describe('real corpus .faq values', () => {
  /** decode -> JSON.parse -> the engine's own pair filter -> its >= 2 threshold. */
  const readsAsFaqPage = (rawSourceText: string): boolean => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeTsStringEscapes(rawSourceText));
    } catch {
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return false;
    const pairs = (parsed as Array<{ q?: string; a?: string }>).filter(
      (p) => p && p.q && p.a && p.q.length > 10 && p.a.length > 20,
    );
    return pairs.length >= 2;
  };

  /**
   * content/blog-body/en/cpi-caso-hospita-rivalutazione-periti.ts
   *
   * Broken by the OLD decoder, not by the corpus: the source spells a JSON tab
   * escape as `\\t`, which is correct. The chain rewrote the `t` first and left
   * `\ ` — an invalid JSON escape — so JSON.parse threw and the article lost
   * its FAQPage schema and its accordion.
   */
  const BROKEN_TODAY = String.raw`[{"q":"What\'\\t3e the meaning of impartialt\\u0000a1 in the Ticino CPI?","a":"Imparzialit\\u0000a1 in the Ticino CPI means ensuring that investigations are conducted without influences or prejudices, ensuring that the conclusions are based on objective analysis and without conflicts of interest."},{"q":"What is the process to reevaluate the appointment of a peritum in the Ticino CPI if conflicts of interest are suspected?","a":"Revaluation is based on cantonal and federal regulations. The parties concerned may request the revision or replacement of the expert to the ICC Committee or to the competent body, which assesses the compatibility of the expert with the investigation."},{"q":"How can I check if a CPI expert has conflicts of interest?","a":"You can consult the official curricula published by the ICC and request information about its past professional activity, verifying any ties with the parties involved or previous assignments that may impair impartiality."}]`;

  /**
   * content/blog-body-ch/de/frontalieri-guerra-fiscale-ticino-bellinzona-blocca-50-miliardi-ristorni.ts
   *
   * Already fine today. Carries a genuine JSON `\"` escape, so it guards the
   * case the old chain happened to get right by accident.
   */
  const WORKING_TODAY = String.raw`[{"q":"Wer hat die vorsorgliche Aussetzung der Italien zustehenden Quellensteuerrückerstattungen angekündigt?","a":"Der Staatsrat des Kantons Tessin"},{"q":"Warum wurde der Anteil der Italien zustehenden Rückvergütungen blockiert?","a":"Als Reaktion auf die sogenannte \\"Gesundheitssteuer\\", die die Region Lombardei den sogenannten alten Grenzgängern mit G-Genehmigung auferlegen will."}]`;

  it('reads the value the old decoder destroyed', () => {
    expect(readsAsFaqPage(BROKEN_TODAY)).toBe(true);
    const pairs = JSON.parse(decodeTsStringEscapes(BROKEN_TODAY)) as Array<{ q: string; a: string }>;
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs[0].q).toContain('Ticino CPI');
  });

  it('still reads the value that already worked, quotes intact', () => {
    expect(readsAsFaqPage(WORKING_TODAY)).toBe(true);
    const pairs = JSON.parse(decodeTsStringEscapes(WORKING_TODAY)) as Array<{ q: string; a: string }>;
    // The escaped quotes in the source must come back as real quotes inside the
    // answer — not as backslashes, and not by breaking the parse.
    expect(pairs.some((p) => p.a.includes('"Gesundheitssteuer"'))).toBe(true);
  });

  it('the fixtures are raw source text, not an already-decoded value', () => {
    // Guards against a future edit "tidying" the fixtures into decoded form,
    // which would make both tests above pass against any decoder at all.
    expect(BROKEN_TODAY).toContain(String.raw`\\t`);
    expect(WORKING_TODAY).toContain(String.raw`\\"`);
  });
});

describe('repairLegacyDoubleEscapedBreaks', () => {
  it('restores the line break the corpus double-escaped, without the stray backslash', () => {
    // What the body path holds after a faithful decode of source `\\n`.
    // Live on 2026-08-11, /articoli-svizzera/zurich-finma-licenziamenti-previdenza/
    // rendered `<h3>In breve\</h3>` because the chain produced \ + a newline.
    expect(repairLegacyDoubleEscapedBreaks(String.raw`## In breve\nZurich ha`)).toBe(
      '## In breve\nZurich ha',
    );
    expect(repairLegacyDoubleEscapedBreaks(String.raw`## In breve\nZurich ha`)).not.toContain('\\');
  });

  it('leaves no stray backslash when the source was escaped one level too many', () => {
    // Adversarial case raised in review on #5602. Source `\\\\n` decodes to two
    // literal backslashes followed by n; a `/\\n/` repair would consume only the
    // last one and leave a stray backslash next to the new line break.
    const decoded = decodeTsStringEscapes(String.raw`fine.\\\\nInizio`);
    expect(decoded).toBe(String.raw`fine.\\nInizio`);
    const repaired = repairLegacyDoubleEscapedBreaks(decoded);
    expect(repaired).toBe('fine.\nInizio');
    expect(repaired).not.toContain('\\');
  });

  it('leaves text that has no literal backslash-n alone', () => {
    expect(repairLegacyDoubleEscapedBreaks('already\nbroken into lines')).toBe(
      'already\nbroken into lines',
    );
    expect(repairLegacyDoubleEscapedBreaks('no escapes here')).toBe('no escapes here');
  });

  it('must NOT be applied to a faq value, where a literal backslash-n is meaningful', () => {
    // Documents the rule the caller implements. Running this over a `.faq`
    // would put a raw newline inside a JSON string and reintroduce exactly the
    // parse failure this change removes.
    const faqJson = String.raw`[{"q":"a","a":"line1\nline2"}]`;
    expect(() => JSON.parse(faqJson)).not.toThrow();
    expect(() => JSON.parse(repairLegacyDoubleEscapedBreaks(faqJson))).toThrow();
  });
});
