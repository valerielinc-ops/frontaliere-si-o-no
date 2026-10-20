import { describe, expect, it } from 'vitest';

import { extractHreflangAlternates } from '../../scripts/lib/hreflang-alternates.mjs';

const BASE = 'https://frontaliereticino.ch';

describe('shared hreflang alternate extraction', () => {
  it('keeps quote-flexible locale/href pairs while detaching retained hrefs from the head', () => {
    const html = `<head><link rel=alternate hreflang=en href=${BASE}/en/guide/><link rel="alternate" hreflang="x-default" href="${BASE}/guida/"></head>`;

    expect(extractHreflangAlternates(html)).toEqual(new Map([
      ['en', `${BASE}/en/guide/`],
      ['x-default', `${BASE}/guida/`],
    ]));
  });

  it('resets the shared matcher between pages', () => {
    const first = `<link rel=alternate hreflang=en href=${BASE}/en/first/>`;
    const second = `<link rel=alternate hreflang=de href=${BASE}/de/zweite/>`;

    expect(extractHreflangAlternates(first)).toEqual(new Map([['en', `${BASE}/en/first/`]]));
    expect(extractHreflangAlternates(second)).toEqual(new Map([['de', `${BASE}/de/zweite/`]]));
  });
});
