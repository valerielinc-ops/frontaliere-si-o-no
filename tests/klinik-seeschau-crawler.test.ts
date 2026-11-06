import { describe, expect, it } from 'vitest';
import { klinikSeeschauMatchKey } from '../scripts/lib/klinik-seeschau-job-parser.mjs';
import { textFragmentUrl } from '../scripts/lib/text-fragment-url.mjs';

// Issue 5253: #10334 moved the published URL from an invented `#job-<hash>`
// anchor to the text fragment of the ad's heading. The id (digest of the
// title) did not change, so it is the merge key: the stored record and the
// fresh one are the same posting, translations and slugs included.
describe('klinikSeeschauMatchKey', () => {
  const PAGE = 'https://www.klinik-seeschau.ch/karriere/offene-stellen.html/59';

  it('matches a stored #job-<hash> record with the same posting under its text fragment', () => {
    const stored = { id: 'klinik-seeschau-8c5af93f2c34', url: `${PAGE}#job-8c5af93f2c34` };
    const fresh = { id: 'klinik-seeschau-8c5af93f2c34', url: textFragmentUrl(PAGE, 'Dipl. Pflegefachfrau/-mann (HF) ab 50 %') };
    expect(klinikSeeschauMatchKey(fresh)).toBe(klinikSeeschauMatchKey(stored));
  });

  it('keeps two postings of the page apart', () => {
    expect(klinikSeeschauMatchKey({ id: 'klinik-seeschau-8c5af93f2c34' }))
      .not.toBe(klinikSeeschauMatchKey({ id: 'klinik-seeschau-00cb0e8ba1bb' }));
  });
});
