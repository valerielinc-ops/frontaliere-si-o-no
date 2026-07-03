import { describe, expect, it } from 'vitest';
import { normalizeTitleCasing, collapseShoutingTitle } from '../scripts/create-article.mjs';

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

  it('preserves known acronyms in a shouting translated title', () => {
    expect(collapseShoutingTitle('NEW AVS AND CHF 500 RULES')).toBe('New AVS and CHF 500 rules');
  });

  it('is a no-op on normally-cased titles', () => {
    expect(collapseShoutingTitle('The New Cross-Border Rules')).toBe('The New Cross-Border Rules');
  });
});
