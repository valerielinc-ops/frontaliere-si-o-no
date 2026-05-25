import { describe, expect, it } from 'vitest';
import { __internals } from '../scripts/lib/engadin-tourismus-job-parser.mjs';

describe('Engadin Tourismus crawler parser', () => {
  it('strips malformed style blocks before JSDOM parsing', () => {
    const html = `
      <style>@media (min-width: 1px) { :is(.broken { color: red; }</style>
      <a class="more" title="Lehrstelle Kauffrau/Kaufmann EFZ" href="/ueber-uns/jobs/jobs/lehrstelle-kauffrau-kaufmann-efz">Mehr lesen</a>
    `;

    const listings = __internals.parseListingPage(html);

    expect(listings).toEqual([
      {
        title: 'Lehrstelle Kauffrau/Kaufmann EFZ',
        url: 'https://www.engadintourismus.ch/ueber-uns/jobs/jobs/lehrstelle-kauffrau-kaufmann-efz',
      },
    ]);
  });
});
