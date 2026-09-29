import { describe, expect, it } from 'vitest';
import { textFragmentUrl } from '../scripts/lib/text-fragment-url.mjs';

describe('textFragmentUrl', () => {
  it('addresses an ad by its heading on a list page (klinik-seeschau)', () => {
    expect(textFragmentUrl('https://www.klinik-seeschau.ch/karriere/offene-stellen.html/59', 'Dipl. Pflegefachfrau/-mann (HF) ab 50 %'))
      .toBe('https://www.klinik-seeschau.ch/karriere/offene-stellen.html/59#:~:text=Dipl.%20Pflegefachfrau%2F%2Dmann%20(HF)%20ab%2050%20%25');
  });

  it('encodes the characters the text directive reserves and replaces an existing fragment', () => {
    const url = textFragmentUrl('https://www.oscam.ch/lavoraconnoi/#concorso-generale-2026', 'Concorso generale 2026 - medici, infermieri & tecnici');
    expect(url).toBe('https://www.oscam.ch/lavoraconnoi/#:~:text=Concorso%20generale%202026%20%2D%20medici%2C%20infermieri%20%26%20tecnici');
    expect(decodeURIComponent(url.split('#:~:text=')[1])).toBe('Concorso generale 2026 - medici, infermieri & tecnici');
  });

  it('leaves the page URL alone when there is no text', () => {
    expect(textFragmentUrl('https://example.test/jobs#old', '  ')).toBe('https://example.test/jobs');
  });
});
