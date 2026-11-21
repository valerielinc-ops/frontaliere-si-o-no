import { describe, expect, it } from 'vitest';
import { parseJobalinoListingHtml } from '../scripts/lib/jobalino-common.mjs';
import { hasAmbiguousJsonLdSource } from '../scripts/lib/teo-jakob-ag-job-parser.mjs';

describe('Teo Jakob Jobalino parser contracts', () => {
  it('does not treat data-href as the vacancy href', () => {
    const html = [
      '<a class="reflink"',
      ' data-href="https://my.jobalino.ch/public/job/de/abc123/wrong-opening"',
      ' href="/other-opening">',
      '<span class="title">Opening</span>',
      '</a>',
    ].join('');

    expect(parseJobalinoListingHtml(html)).toEqual([]);
  });

  it('rejects ambiguous employer and location JSON-LD arrays', () => {
    expect(hasAmbiguousJsonLdSource({
      hiringOrganization: [{ name: 'Teo Jakob AG' }, { name: 'Other AG' }],
    })).toBe(true);
    expect(hasAmbiguousJsonLdSource({
      jobLocation: [{ address: {} }, { address: {} }],
    })).toBe(true);
    expect(hasAmbiguousJsonLdSource({
      jobLocation: [{ address: [{ streetAddress: 'A' }, { streetAddress: 'B' }] }],
    })).toBe(true);
  });

  it('accepts unambiguous singleton structured-data arrays', () => {
    expect(hasAmbiguousJsonLdSource({
      hiringOrganization: [{ name: 'Teo Jakob AG' }],
      jobLocation: [{ address: [{ addressLocality: 'Lugano' }] }],
    })).toBe(false);
  });
});
