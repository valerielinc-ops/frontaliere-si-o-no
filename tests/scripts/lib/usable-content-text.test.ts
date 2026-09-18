/**
 * Presence predicates for the serialized `null` marker (site twin of
 * nanakokyobashi-rgb/frontaliere-articles#831 item 4 / #822).
 *
 * Imports the shipped module — a copy of the regex here would pass while
 * create-article drifted back to `.trim()`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hasUsableContentText,
  hasUsableTranslatedText,
  isLiteralNullString,
  isNullStringForLocale,
  localeHasNullAsWord,
  normalizeLocaleTag,
} from '../../../scripts/lib/usable-content-text.mjs';
import {
  normalizeItalianContentFromPayload,
  validateItalianPayload,
} from '../../../scripts/create-article.mjs';

const CREATE_SRC = readFileSync(
  resolve(__dirname, '../../../scripts/create-article.mjs'),
  'utf8',
);

const NULL_GRAPHS = ['null', 'NULL', 'Null', ' null ', '"null"', "'null'", '" null "'];
const REAL_TEXT = ["nullita' contrattuale", '"Il messaggio 8412"', 'annullato', 'null e non solo'];

describe('normalizeLocaleTag / localeHasNullAsWord', () => {
  it('cuts region/script subtags so de-CH stays on the German exception', () => {
    for (const tag of ['de', 'de-CH', 'de_DE', 'DE-ch', ' de-AT ', 'de-Latn-CH']) {
      expect(normalizeLocaleTag(tag)).toBe('de');
      expect(localeHasNullAsWord(tag)).toBe(true);
    }
  });

  it('fails closed on missing or non-German locales', () => {
    for (const tag of ['en-GB', 'fr-CH', 'it-CH', undefined, null, '', '   ', 42, {}]) {
      expect(localeHasNullAsWord(tag as string)).toBe(false);
    }
  });
});

describe('hasUsableContentText (source / machine sentinel)', () => {
  it('rejects every graph of the serialized null marker', () => {
    for (const v of NULL_GRAPHS) {
      expect(isLiteralNullString(v), v).toBe(true);
      expect(hasUsableContentText(v), v).toBe(false);
    }
  });

  it('keeps real prose, including text that merely contains null', () => {
    for (const v of REAL_TEXT) {
      expect(isLiteralNullString(v), v).toBe(false);
      expect(hasUsableContentText(v), v).toBe(true);
    }
  });

  it('rejects blank and non-string values without throwing', () => {
    for (const v of ['', '   ', null, undefined, 42, {}]) {
      expect(hasUsableContentText(v)).toBe(false);
    }
  });
});

describe('hasUsableTranslatedText (model output, per locale)', () => {
  it('rejects serialized lowercase null in every locale', () => {
    for (const v of ['null', ' null ', '"null"', "'null'"]) {
      for (const loc of ['de', 'en', 'fr', undefined]) {
        expect(hasUsableTranslatedText(v, loc), `${JSON.stringify(v)}/${loc}`).toBe(false);
      }
    }
  });

  it('keeps German Null/NULL as the word for zero, and only there', () => {
    for (const v of ['Null', 'NULL', '"Null"']) {
      expect(hasUsableTranslatedText(v, 'de')).toBe(true);
      expect(hasUsableTranslatedText(v, 'DE')).toBe(true);
      expect(isNullStringForLocale(v, 'de')).toBe(false);
      for (const loc of ['en', 'fr', 'it', undefined]) {
        expect(hasUsableTranslatedText(v, loc), `${JSON.stringify(v)}/${loc}`).toBe(false);
      }
      expect(hasUsableContentText(v), v).toBe(false);
    }
  });

  it('does not treat Null inside a sentence as a marker', () => {
    for (const loc of ['de', 'en', 'fr', undefined]) {
      expect(hasUsableTranslatedText('Null Grad Celsius', loc)).toBe(true);
    }
  });
});

describe('normalizeItalianContentFromPayload', () => {
  it('empties a RAW body1 of "null" instead of keeping it as content', () => {
    const block = normalizeItalianContentFromPayload({
      content: {
        it: {
          title: 'Imposta alla fonte',
          excerpt: 'Il messaggio 8412.',
          body1: 'null',
          body2: 'Il Consiglio di Stato ha approvato il messaggio.',
          body3: 'Le aliquote restano invariate per i frontalieri.',
        },
      },
    });
    expect(block).not.toBeNull();
    expect(block.body1).toBe('');
    expect(block.body2.startsWith('Il Consiglio')).toBe(true);
  });

  it('does not treat a payload of only null-markers as content', () => {
    expect(normalizeItalianContentFromPayload({
      content: { it: { title: 'null', excerpt: 'NULL', body1: 'Null', body2: '"null"', body3: ' null ' } },
    })).toBeNull();
  });
});

describe('validateItalianPayload', () => {
  const ok = {
    title: 'Imposta alla fonte per i frontalieri',
    excerpt: 'Cosa cambia con il messaggio 8412.',
    body1: 'Il Consiglio di Stato ha approvato il messaggio.',
    body2: 'Le aliquote restano invariate per i frontalieri residenti in Italia e attivi nel Cantone.',
    body3: 'La notifica diventa trimestrale.',
  };

  it('throws qualityReject on a literal null field instead of publishing it', () => {
    expect(() => validateItalianPayload({ ...ok, body1: 'null' })).toThrow(/Campo body1 mancante/);
    let caught: (Error & { qualityReject?: boolean }) | undefined;
    try {
      validateItalianPayload({ ...ok, title: 'NULL' });
    } catch (err) {
      caught = err as Error & { qualityReject?: boolean };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.qualityReject).toBe(true);
  });

  it('throws qualityReject on a non-string field instead of TypeError', () => {
    let caught: (Error & { qualityReject?: boolean }) | undefined;
    try {
      validateItalianPayload({ ...ok, excerpt: { text: 'nope' } } as never);
    } catch (err) {
      caught = err as Error & { qualityReject?: boolean };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.name).not.toBe('TypeError');
    expect(caught?.qualityReject).toBe(true);
  });

  it('accepts a complete Italian payload', () => {
    expect(() => validateItalianPayload(ok)).not.toThrow();
  });
});

describe('create-article.mjs wires the shipped predicates', () => {
  it('does not keep the null-blind presence gates on the IT / translation path', () => {
    expect(CREATE_SRC).toContain('hasUsableContentText');
    expect(CREATE_SRC).toContain('hasUsableTranslatedText');
    expect(CREATE_SRC).not.toMatch(
      /if \(!contentIt\?\.\[field\] \|\| contentIt\[field\]\.trim\(\)\.length < 1\)/,
    );
    expect(CREATE_SRC).not.toMatch(
      /if \(data\.content\[locale\]\[field\]\) continue;/,
    );
  });
});

describe('repair-object-object-bodies.mjs', () => {
  it('uses the machine-sentinel predicate on free-MT output', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../scripts/repair-object-object-bodies.mjs'),
      'utf8',
    );
    expect(src).toContain('hasUsableContentText');
    expect(src).not.toMatch(/const out = typeof raw === 'string' \? raw : ''/);
  });
});
