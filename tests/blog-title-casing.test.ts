import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeTitleCasing, collapseShoutingTitle } from '../scripts/create-article.mjs';
import blogMetaIt from '../packages/articles/content/blog-meta-it';
import blogMetaEn from '../packages/articles/content/blog-meta-en';
import blogMetaDe from '../packages/articles/content/blog-meta-de';
import blogMetaFr from '../packages/articles/content/blog-meta-fr';
import blogMetaChIt from '../packages/articles/content/blog-meta-ch-it';
import blogMetaChEn from '../packages/articles/content/blog-meta-ch-en';
import blogMetaChDe from '../packages/articles/content/blog-meta-ch-de';
import blogMetaChFr from '../packages/articles/content/blog-meta-ch-fr';

const CREATE_ARTICLE_SOURCE = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
const PUBLISHED_META_FILES = [
  { file: 'blog-meta-it.ts', values: blogMetaIt },
  { file: 'blog-meta-en.ts', values: blogMetaEn },
  { file: 'blog-meta-de.ts', values: blogMetaDe },
  { file: 'blog-meta-fr.ts', values: blogMetaFr },
  { file: 'blog-meta-ch-it.ts', values: blogMetaChIt },
  { file: 'blog-meta-ch-en.ts', values: blogMetaChEn },
  { file: 'blog-meta-ch-de.ts', values: blogMetaChDe },
  { file: 'blog-meta-ch-fr.ts', values: blogMetaChFr },
] as const;

function wouldCollapseShouting(value: string): boolean {
  const normalizedWhitespace = value.replace(/\s+/g, ' ').trim();
  return collapseShoutingTitle(normalizedWhitespace) !== normalizedWhitespace;
}

// Live incident: an article was published with a fully-uppercase IT title
// ("LA SOSPENSIONE DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA:
// IL CASO DELLA \"TASSA SULLA SALUTE\"") because normalizeTitleCasing was only
// wired into the journalist-publish pipeline, never into create-article.mjs's
// own AI-generation path — and even wired in, its old per-word acronym check
// was a no-op on fully-uppercase input (every word trivially equals its own
// uppercase form). Both gaps are fixed; this locks in the fix.
describe('normalizeTitleCasing — shouting (fully-uppercase) titles', () => {
  it('sentence-cases the reported live-incident title, preserving the compound proper noun', () => {
    const shouting = 'LA SOSPENSIONE DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA: IL CASO DELLA "TASSA SULLA SALUTE"';
    expect(normalizeTitleCasing(shouting)).toBe(
      'La sospensione dei ristorni alla prova della convenzione Italia-Svizzera: il caso della "tassa sulla salute"',
    );
  });

  it('preserves known institutional acronyms and CHF in a shouting title', () => {
    expect(normalizeTitleCasing('NUOVO ACCORDO CON LA SVIZZERA E CHF 500')).toBe(
      'Nuovo accordo con la Svizzera e CHF 500',
    );
  });

  it('does not mistake short Italian function words for acronyms', () => {
    expect(normalizeTitleCasing('LA SOSPENSIONE DEI RISTORNI')).toBe('La sospensione dei ristorni');
  });

  it('leaves an already sentence-cased title untouched (no-op)', () => {
    expect(normalizeTitleCasing('AVS e LPP: cosa cambia nel 2026')).toBe('AVS e LPP: cosa cambia nel 2026');
  });

  it('still sentence-cases journalist Title Case input while preserving an inline acronym', () => {
    expect(normalizeTitleCasing('Nuove Regole AVS Per Il Ticino')).toBe('Nuove regole AVS per il Ticino');
  });

  it('still preserves canton/city/country proper nouns in Title Case input (issue #3174)', () => {
    expect(normalizeTitleCasing('Nuove Regole Per Il Ticino')).toBe('Nuove regole per il Ticino');
  });
});

describe('collapseShoutingTitle — locale-agnostic ALL-CAPS guard (EN/DE/FR)', () => {
  it('fixes a shouting translated title without imposing Italian sentence-case grammar', () => {
    expect(collapseShoutingTitle('THE SUSPENSION OF TAX REFUNDS UNDER THE ITALY-SWITZERLAND TREATY')).toBe(
      'The suspension of tax refunds under the italy-switzerland treaty',
    );
  });

  it('fixes a shouting German translated title', () => {
    expect(collapseShoutingTitle('NEUE REGELN FÜR GRENZGÄNGER IM TESSIN')).toBe(
      'Neue regeln für grenzgänger im tessin',
    );
  });

  it('fixes a shouting French translated title', () => {
    expect(collapseShoutingTitle('NOUVELLES RÈGLES POUR LES FRONTALIERS AU TESSIN')).toBe(
      'Nouvelles règles pour les frontaliers au tessin',
    );
  });

  it('preserves known acronyms in a shouting translated title', () => {
    expect(collapseShoutingTitle('NEW AVS AND CHF 500 RULES')).toBe('New AVS and CHF 500 rules');
  });

  it('is a no-op on normally-cased titles', () => {
    expect(collapseShoutingTitle('The New Cross-Border Rules')).toBe('The New Cross-Border Rules');
  });
});

// Reviewer nit (PR #3350): imageAlt is a required LLM schema field, so the
// title-casing fix only reached it via the fallback template branch
// (`!data.imageAlt`, built from the already-corrected title). When the LLM
// returns imageAlt directly it bypassed normalization entirely — if the
// model echoes the same shouting style across the whole field (the observed
// failure mode for this bug class), the fix now runs collapseShoutingTitle
// unconditionally on every data.imageAlt[locale] string before it's saved.
describe('collapseShoutingTitle — applied unconditionally to imageAlt (create-article.mjs validate())', () => {
  it('fixes a fully-shouting imageAlt returned directly by the LLM', () => {
    expect(collapseShoutingTitle('IMMAGINE EDITORIALE RELATIVA ALLA SOSPENSIONE DEI RISTORNI')).toBe(
      'Immagine editoriale relativa alla sospensione dei ristorni',
    );
  });

  it('fixes a fully-shouting imageAlt for every supported locale', () => {
    const shoutingByLocale = {
      it: 'IMMAGINE EDITORIALE RELATIVA ALLA SOSPENSIONE DEI RISTORNI',
      en: 'EDITORIAL IMAGE RELATED TO THE SUSPENSION OF TAX REFUNDS',
      de: 'REDAKTIONELLES BILD ZUR AUSSETZUNG DER STEUERRÜCKERSTATTUNGEN',
      fr: 'IMAGE ÉDITORIALE SUR LA SUSPENSION DES REMBOURSEMENTS FISCAUX',
    };

    expect(Object.fromEntries(
      Object.entries(shoutingByLocale).map(([locale, value]) => [locale, collapseShoutingTitle(value)]),
    )).toEqual({
      it: 'Immagine editoriale relativa alla sospensione dei ristorni',
      en: 'Editorial image related to the suspension of tax refunds',
      de: 'Redaktionelles bild zur aussetzung der steuerrückerstattungen',
      fr: 'Image éditoriale sur la suspension des remboursements fiscaux',
    });
  });

  it('is a no-op on the mixed-case fallback template (already-normalized title embedded)', () => {
    const fallback = 'Immagine editoriale relativa a: La sospensione dei ristorni alla prova della convenzione Italia-Svizzera';
    expect(collapseShoutingTitle(fallback)).toBe(fallback);
  });
});

describe('title-casing wiring and published metadata guard', () => {
  it('keeps the Italian title normalization wired into the validation path', () => {
    expect(CREATE_ARTICLE_SOURCE).toMatch(
      /const casedTitle = normalizeTitleCasing\(itContent\.title\);[\s\S]*?itContent\.title = casedTitle;/,
    );
  });

  it('applies the translated-title guard to EN, DE, and FR before microcopy validation', () => {
    const sectionStart = CREATE_ARTICLE_SOURCE.indexOf('// ── Title length cap on translated locales');
    const sectionEnd = CREATE_ARTICLE_SOURCE.indexOf('  console.error(`  ✅ Articolo assemblato', sectionStart);
    const translatedTitleSection = CREATE_ARTICLE_SOURCE.slice(sectionStart, sectionEnd);

    expect(translatedTitleSection).toMatch(
      /for \(const locale of \['en', 'de', 'fr'\]\) \{[\s\S]*?const uncappedTitle = collapseShoutingTitle\(localeContent\.title\);[\s\S]*?localeContent\.title = uncappedTitle;/,
    );
  });

  it('applies the imageAlt guard to every locale returned by the schema', () => {
    const sectionStart = CREATE_ARTICLE_SOURCE.indexOf('// Guard against a shouting imageAlt');
    const sectionEnd = CREATE_ARTICLE_SOURCE.indexOf('// Sanitize id', sectionStart);
    const imageAltSection = CREATE_ARTICLE_SOURCE.slice(sectionStart, sectionEnd);

    expect(imageAltSection).toMatch(
      /for \(const locale of \['it', 'en', 'de', 'fr'\]\) \{[\s\S]*?if \(typeof data\.imageAlt\[locale\] === 'string'\) \{[\s\S]*?data\.imageAlt\[locale\] = collapseShoutingTitle\(data\.imageAlt\[locale\]\);/,
    );
  });

  it('finds no shouting title or imageAlt in any of the eight published metadata files', () => {
    const offenders = PUBLISHED_META_FILES.flatMap(({ file, values }) =>
      Object.entries(values)
        .filter(([key, value]) => /\.(title|imageAlt)$/.test(key) && wouldCollapseShouting(value))
        .map(([key, value]) => `${file}:${key}=${value}`),
    );

    expect(PUBLISHED_META_FILES).toHaveLength(8);
    expect(offenders).toEqual([]);
  });
});
