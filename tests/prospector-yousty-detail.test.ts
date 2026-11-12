import { describe, expect, it } from 'vitest';
import { extractRuntimeDetailFields } from '../scripts/lib/prospector/detail-extract.mjs';

const PROFILE_URL = 'https://www.yousty.ch/de-CH/lehrstellen/profile/8804713-automobil-mechatroniker-in-efz-nutzfahrzeuge-triengen-lu-grund-ag-fahrzeuge';
const PROFILE_HTML = `
  <html>
    <body>
      <div>Navigation address: Limmatstrasse 21, 8005 Zürich</div>
      <noscript>
        <h1>Lehrstelle bei Grund AG Fahrzeuge in Triengen als Automobil-Mechatroniker/in EFZ Nutzfahrzeuge</h1>
        <h2>Lehrstellenbeschreibung</h2>
        <div>
          <p>Die Lehre zum Automobilmechatroniker ist eine anspruchsvolle Ausbildung in der Fahrzeugbranche.</p>
          <p>Du arbeitest an Nutzfahrzeugen und profitierst von einer fachkundigen Betreuung im Team.</p>
        </div>
        <h2>Dein Arbeitsort</h2>
        <div>Grund 2, 6234 Triengen</div>
      </noscript>
    </body>
  </html>
`;

describe('Yousty Prospector detail extraction', () => {
  it('uses the vacancy noscript body and workplace when JobPosting JSON-LD is absent', () => {
    const detail = extractRuntimeDetailFields(
      { platform: 'yousty.ch' },
      PROFILE_HTML,
      PROFILE_URL,
      { recordUrl: PROFILE_URL, recordTitle: 'Automobil-Mechatroniker/in EFZ Nutzfahrzeuge, Triengen' },
    );

    expect(detail.description).toContain('anspruchsvolle Ausbildung');
    expect(detail.locationCandidates).toEqual([{
      location: '6234 Triengen',
      addressLocality: 'Triengen',
      addressCountry: 'CH',
      postalCode: '6234',
      streetAddress: 'Grund 2',
    }]);
    expect(detail.location).toBe('6234 Triengen');
  });

  it('clears generic chrome location evidence when the native workplace is absent', () => {
    const detail = extractRuntimeDetailFields(
      { platform: 'yousty.ch' },
      `
        <html>
          <body>
            <div class="company-address">Limmatstrasse 21, 8005 Zürich</div>
            <noscript>
              <h2>Lehrstellenbeschreibung</h2>
              <div><p>Eine abwechslungsreiche Lehrstelle mit einer ausführlichen Beschreibung für interessierte Lernende.</p></div>
              <h2>Dein Arbeitsort</h2>
              <div>Keine feste Zuordnung</div>
            </noscript>
          </body>
        </html>
      `,
      PROFILE_URL,
    );

    expect(detail.locationCandidates).toEqual([]);
    expect(detail.location).toBe('');
    expect(detail.addressLocality).toBe('');
    expect(detail.addressRegion).toBe('');
    expect(detail.addressCountry).toBe('');
    expect(detail.country).toBe('');
    expect(detail.postalCode).toBe('');
    expect(detail.streetAddress).toBe('');
  });

  it('keeps the native Yousty address ahead of a configured generic location label', () => {
    const detail = extractRuntimeDetailFields(
      { platform: 'yousty.ch', detailLocationLabel: 'Dein Arbeitsort' },
      `
        <noscript>
          <h2>Lehrstellenbeschreibung</h2>
          <div><p>Eine abwechslungsreiche Lehrstelle mit einer ausführlichen Beschreibung für interessierte Lernende.</p></div>
          <h2>Dein Arbeitsort</h2>
          <p>Bahnhofstrasse 1, 8000 Zürich</p>
        </noscript>
      `,
      PROFILE_URL,
    );

    expect(detail.location).toBe('8000 Zürich');
    expect(detail.locationCandidates).toEqual([expect.objectContaining({
      postalCode: '8000',
      streetAddress: 'Bahnhofstrasse 1',
    })]);
    expect(detail.postalCode).toBe('8000');
    expect(detail.streetAddress).toBe('Bahnhofstrasse 1');
  });

  it('does not apply Yousty noscript semantics to another platform', () => {
    const detail = extractRuntimeDetailFields(
      { platform: 'example.test' },
      PROFILE_HTML,
      PROFILE_URL,
      { recordUrl: PROFILE_URL, recordTitle: 'Automobil-Mechatroniker/in EFZ Nutzfahrzeuge, Triengen' },
    );

    expect(detail.locationCandidates).not.toContainEqual(expect.objectContaining({
      streetAddress: 'Grund 2',
    }));
  });
});
