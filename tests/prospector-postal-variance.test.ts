import { describe, expect, it } from 'vitest';

import {
  aggregatePostalVariance,
  freeTextPostalMentions,
  htmlToText,
  summarizeHostPostalVariance,
} from '../scripts/lib/prospector/postal-variance.mjs';

// Shape of a physioswiss detail page: the vacancy's NPA in the body, the
// association's NPA in the footer of every page (#7464).
const physioswissPage = (postal: string, locality: string) => `
  <main>
    <h1>Physiotherapeut/in 80-100%</h1>
    <p>Wir suchen f&uuml;r unser Zentrum in ${postal} ${locality} eine Verst&auml;rkung.</p>
    <p>Das Team freut sich auf Sie.</p>
  </main>
  <footer><address>Physioswiss<br>Stadthof<br>3013 Bern</address></footer>
`;

describe('freeTextPostalMentions', () => {
  it('reads the NPA of the vacancy body and the boilerplate one, in document order', () => {
    const mentions = freeTextPostalMentions(physioswissPage('4528', 'Zuchwil'));
    expect(mentions.map((m) => m.key)).toEqual(['4528 zuchwil', '3013 bern']);
    expect(mentions.every((m) => m.known)).toBe(true);
  });

  it('does not glue a municipality to the words of the next block', () => {
    const [mention] = freeTextPostalMentions('<p>1201 Genève</p><p>Postuler maintenant</p>');
    expect(mention.locality).toBe('Genève');
  });

  it('marks an amount followed by a word as an unknown place, not a municipality', () => {
    // `1271 Euro` is the false positive #7464 names: the shape matches, the
    // gazetteer does not.
    const [mention] = freeTextPostalMentions('<p>Bonus von 1271 Euro pro Jahr</p>');
    expect(mention.key).toBe('1271 euro');
    expect(mention.known).toBe(false);
  });

  it('ignores scripts and NPAs that cannot be Swiss', () => {
    expect(freeTextPostalMentions('<script>var a = "8001 Zürich";</script>')).toEqual([]);
    expect(freeTextPostalMentions('<p>Ref 0815 Bern</p>')).toEqual([]);
  });

  it('deduplicates a place repeated on the same page', () => {
    const mentions = freeTextPostalMentions('<p>3013 Bern</p><p>CH-3013 Bern</p>');
    expect(mentions).toHaveLength(1);
  });
});

describe('htmlToText', () => {
  it('decodes entities and drops markup without joining blocks', () => {
    expect(htmlToText('<p>Z&uuml;rich</p><p>Bern</p>').split('\n').filter(Boolean))
      .toEqual(['Zürich', 'Bern']);
  });
});

describe('summarizeHostPostalVariance', () => {
  const pageOf = (postal: string, locality: string, truth: string) => ({
    url: `https://physioswiss.ch/stelleninserate/${locality.toLowerCase()}/`,
    truth,
    mentions: freeTextPostalMentions(physioswissPage(postal, locality)),
  });

  it('separates the NPA present on every page from the ones that vary', () => {
    const summary = summarizeHostPostalVariance([
      pageOf('4528', 'Zuchwil', 'Zuchwil'),
      pageOf('9472', 'Grabs', 'Grabs'),
      pageOf('4600', 'Olten', 'Olten'),
    ]);
    expect(summary.constant).toEqual(['3013 bern']);
    expect(summary.variable).toEqual(['4528 zuchwil', '4600 olten', '9472 grabs']);
    expect(summary.criterion.precision).toBe(1);
    expect(summary.criterion.recall).toBe(1);
  });

  it('scores the naive first-NPA baseline separately so the criterion can be compared', () => {
    const summary = summarizeHostPostalVariance([
      pageOf('4528', 'Zuchwil', 'Zuchwil'),
      pageOf('9472', 'Grabs', 'Grabs'),
    ]);
    // Here the first NPA happens to be the right one; the point is that the two
    // rates are computed independently, not that the baseline is bad.
    expect(summary.baseline.hits).toBe(2);
    expect(summary.baseline.precision).toBe(1);
  });

  it('counts a wrong prediction as a miss and a boilerplate-only page as no prediction', () => {
    const summary = summarizeHostPostalVariance([
      pageOf('4528', 'Zuchwil', 'Zuchwil'),
      pageOf('9472', 'Grabs', 'Olten'),
      { url: 'https://physioswiss.ch/stelleninserate/x/', truth: 'Bern', mentions: freeTextPostalMentions('<footer>3013 Bern</footer>') },
    ]);
    expect(summary.criterion.hits).toBe(1);
    expect(summary.criterion.misses).toBe(1);
    expect(summary.criterion.noPrediction).toBe(1);
    expect(summary.criterion.precision).toBe(0.5);
    expect(summary.criterion.recall).toBeCloseTo(1 / 3);
  });

  it('does not score pages whose location the listing does not know', () => {
    const summary = summarizeHostPostalVariance([
      pageOf('4528', 'Zuchwil', ''),
      pageOf('9472', 'Grabs', ''),
    ]);
    expect(summary.withTruth).toBe(0);
    expect(summary.withoutTruth).toBe(2);
    expect(summary.criterion.precision).toBeNull();
    expect(summary.criterion.recall).toBeNull();
  });

  it('refuses to call anything constant when a single page was sampled', () => {
    const summary = summarizeHostPostalVariance([pageOf('4528', 'Zuchwil', 'Zuchwil')]);
    expect(summary.measurable).toBe(false);
    expect(summary.constant).toEqual([]);
    expect(summary.criterion.precision).toBeNull();
  });

  it('matches a bare municipality against a listing display string on whole tokens', () => {
    const hit = summarizeHostPostalVariance([
      pageOf('4528', 'Zuchwil', '4528 Zuchwil, SO'),
      pageOf('9472', 'Grabs', 'Grabs'),
    ]);
    expect(hit.criterion.hits).toBe(2);
    // `Berneck` merely contains `Bern`: a substring must not pass for a match.
    const miss = summarizeHostPostalVariance([
      pageOf('3011', 'Bern', 'Berneck'),
      pageOf('9472', 'Grabs', 'Grabs'),
    ]);
    expect(miss.criterion.misses).toBe(1);
    expect(miss.criterion.hits).toBe(1);
  });
});

describe('aggregatePostalVariance', () => {
  it('sums only the measurable hosts and recomputes the rates on the totals', () => {
    const totals = aggregatePostalVariance({
      a: { measurable: true, pages: 5, withTruth: 4, criterion: { hits: 3, misses: 1, noPrediction: 0 }, baseline: { hits: 1, misses: 3, noPrediction: 0 } } as any,
      b: { measurable: true, pages: 6, withTruth: 6, criterion: { hits: 3, misses: 1, noPrediction: 2 }, baseline: { hits: 2, misses: 4, noPrediction: 0 } } as any,
      c: { measurable: false, pages: 1, withTruth: 1, criterion: { hits: 1, misses: 0, noPrediction: 0 }, baseline: { hits: 1, misses: 0, noPrediction: 0 } } as any,
    });
    expect(totals.hosts).toBe(2);
    expect(totals.pages).toBe(11);
    expect(totals.criterion.precision).toBe(0.75);
    expect(totals.criterion.recall).toBe(0.6);
    expect(totals.baseline.precision).toBe(0.3);
  });
});
