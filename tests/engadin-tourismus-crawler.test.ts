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

  it('strips malformed query-string artifacts appended to job detail links (#3421)', () => {
    // Regression for #3421: the site's TYPO3 cache was observed appending a
    // malformed query string (`print=1'a'a=0&cHash=...`) onto "Mehr lesen"
    // links. The prior cleanup regex only stripped the literal `print=1` and
    // `cHash=...` substrings, leaving the `'a'a=0` garbage glued onto the
    // slug (e.g. `...m-w-d%27a%27a%3D0`), which 404s on the live site.
    const html = `
      <a class="more" title="Digital Customer Support Specialist 100% m/w/d" href="/ueber-uns/jobs/jobs/digital-customer-support-specialist-100-m-w-d?print=1%27a%27a%3D0&amp;cHash=607906faf2457921397857578c0e791a">Mehr lesen</a>
    `;

    const listings = __internals.parseListingPage(html);

    expect(listings).toEqual([
      {
        title: 'Digital Customer Support Specialist 100% m/w/d',
        url: 'https://www.engadintourismus.ch/ueber-uns/jobs/jobs/digital-customer-support-specialist-100-m-w-d',
      },
    ]);
  });
});
