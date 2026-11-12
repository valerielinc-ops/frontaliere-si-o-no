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
