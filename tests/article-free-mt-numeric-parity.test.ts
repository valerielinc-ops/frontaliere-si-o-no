/**
 * The free-MT article translator must refuse a field whose translation lost the
 * source's figures (#6674).
 *
 * The defect these tests pin: an MT engine summarises a clause and takes its
 * numbers with it, the field ships, and the loss is only noticed later in a sync
 * report on an already-published article. A reader in EN/FR cannot recover a
 * figure that is not on the page.
 *
 * Nothing here pins the wording of a translation. Every case feeds a stub
 * translator whose output is written by the test, and asserts on the DECISION
 * (keep the field / drop it so the caller retranslates), never on prose.
 */
import { describe, it, expect } from 'vitest';
import { translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import {
  droppedNumericFacts,
  numericDivergenceWorthReporting,
  extractNumericFacts,
} from '../scripts/lib/article-locale-lexicon.mjs';

/** Runs the field translator against a fixed output, collecting warnings. */
async function translateTo(output: string, source: string, targetLang = 'en') {
  const warnings: string[] = [];
  const text = await translateFieldFreeMt({
    text: source,
    sourceLang: 'it',
    targetLang,
    fieldType: 'description',
    translate: async () => output,
    onWarn: (msg: string) => warnings.push(msg),
  });
  return { text, warnings };
}

const IT_AMOUNTS = 'La franchigia sale a 10.000 euro dal 2024, contro i 7.500 euro '
  + 'del regime transitorio, e il contributo resta di 2.000 euro.';

describe('translateFieldFreeMt — numeric parity', () => {
  it('keeps a translation that carries every figure across', async () => {
    const { text, warnings } = await translateTo(
      'The allowance rises to 10,000 euros from 2024, against the 7,500 euros of the '
      + 'transitional regime, and the contribution stays at 2,000 euros.',
      IT_AMOUNTS,
    );
    expect(text).not.toBe('');
    expect(warnings).toEqual([]);
  });

  it('drops a translation that summarised the figures away, so the caller retranslates', async () => {
    const { text, warnings } = await translateTo(
      'The allowance rises from 2024 and the contribution is unchanged.',
      IT_AMOUNTS,
    );
    // '' is the module's established "recover this field" signal — the caller's
    // per-field recovery (LLM retry, then IT fallback) takes over from here.
    expect(text).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('perso cifre');
  });

  it('does not fire on a single missing value, which ranges and merged clauses produce', async () => {
    const source = 'Il costo varia da 60.000 euro a 100.000 euro.';
    const { text, warnings } = await translateTo('Costs range up to 100,000 euros.', source);
    expect(text).not.toBe('');
    expect(warnings).toEqual([]);
  });

  it('applies the same rule to dates', async () => {
    const source = 'Le chiusure sono previste il 2 marzo 2026, il 4 marzo 2026 e il 6 marzo 2026.';
    const kept = await translateTo(
      'Closures are scheduled for 2 March 2026, 4 March 2026 and 6 March 2026.',
      source,
    );
    expect(kept.text).not.toBe('');
    const lost = await translateTo('Closures are scheduled for early March.', source);
    expect(lost.text).toBe('');
  });

  it('still refuses a mangled nav-link sentinel, unchanged by this guard', async () => {
    const source = 'Vedi [le regole](nav:regole) e versa 2.000 euro entro il 2026.';
    const { text } = await translateTo('See [the rules](nav:rules) and pay 2,000 euros by 2026.', source);
    // The sentinel came back as prose rather than 0NAV0, so the field is dropped
    // for the pre-existing reason, not the numeric one.
    expect(text).toBe('');
  });

  it('compares against the target locale, so a correct French rendering passes', async () => {
    const { text, warnings } = await translateTo(
      "L'abattement passe à 10 000 € en 2024, contre 7 500 € sous le régime transitoire, "
      + "et la contribution reste de 2 000 €.",
      IT_AMOUNTS,
      'fr',
    );
    expect(text).not.toBe('');
    expect(warnings).toEqual([]);
  });
});

describe('numeric fact extraction — losses that were reported as dropped figures', () => {
  // Both of these were measured on the published corpus: the figure is present
  // on BOTH sides, and the extractor could not see it on one of them.

  it('reads an amount whose currency symbol trails the number', () => {
    // `€` is not a word character, so the old `\b` after the currency could only
    // match when a letter or digit followed the symbol — which in prose it never
    // does. 422 of 1291 French "lost amount" reports were this and nothing else.
    expect([...extractNumericFacts('un abattement de 10 000 € est appliqué', 'fr').amt])
      .toEqual([10000]);
    expect([...extractNumericFacts('una franchigia di 10.000 € si applica', 'it').amt])
      .toEqual([10000]);
    expect([...extractNumericFacts("1,4 million d’euros versés", 'fr').amt])
      .toEqual([1400000]);
  });

  it('still refuses to read a currency name out of the middle of a word', () => {
    expect([...extractNumericFacts('the 12 european markets', 'en').amt]).toEqual([]);
  });

  it('reads a day carrying an ordinal suffix, in each locale spelling', () => {
    expect([...extractNumericFacts('from March 4th, 2026', 'en').date]).toEqual(['2026-03-04']);
    expect([...extractNumericFacts('à partir du 1er janvier 2024', 'fr').date]).toEqual(['2024-01-01']);
    expect([...extractNumericFacts('dal 1° gennaio 2024', 'it').date]).toEqual(['2024-01-01']);
    expect([...extractNumericFacts('ab 1. Januar 2024', 'de').date]).toEqual(['2024-01-01']);
  });

  it('does not read a year-then-percentage list as a number', () => {
    // Pinned because the grouping rules are what make that case work.
    const facts = extractNumericFacts('In 2023, 20% dei frontalieri', 'it');
    expect([...facts.pct]).toEqual([20]);
    expect([...facts.amt]).toEqual([]);
  });
});

describe('droppedNumericFacts — the one definition shared by guard and audit gate', () => {
  it('reports nothing when the threshold is not met', () => {
    expect(numericDivergenceWorthReporting(1, 4)).toBe(false);
    expect(numericDivergenceWorthReporting(2, 4)).toBe(true);
    // Two values are required even when they are the whole set.
    expect(numericDivergenceWorthReporting(1, 1)).toBe(false);
  });

  it('names the kind and the values it found missing', () => {
    const losses = droppedNumericFacts(IT_AMOUNTS, 'The allowance rises from 2024.', 'it', 'en');
    expect(losses).toHaveLength(1);
    expect(losses[0].kind).toBe('amt');
    expect(losses[0].dropped).toEqual(expect.arrayContaining([10000, 7500, 2000]));
  });

  it('is silent on empty input rather than treating it as a total loss', () => {
    expect(droppedNumericFacts('', 'anything', 'it', 'en')).toEqual([]);
    expect(droppedNumericFacts(IT_AMOUNTS, '', 'it', 'en')).toEqual([]);
  });
});
