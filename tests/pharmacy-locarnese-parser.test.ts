import { describe, expect, it } from 'vitest';

import pharmacies from '../data/pharmacies-ticino-complete.json';
import { localDateTimeToIso } from '../services/pharmacies/time.mjs';
import {
  LOCARNESE_REGION,
  buildLocarnesePharmacyDuties,
  parseLocarneseDutyRows,
  resolveLocarnesePharmacyIdentity,
} from '../scripts/lib/pharmacy-locarnese-parser.mjs';

const NOW = new Date();
const ZURICH_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function sourceDate(daysFromNow: number): string {
  const date = new Date(NOW.getTime() + daysFromNow * 24 * 60 * 60 * 1000);
  const parts = Object.fromEntries(
    ZURICH_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year}`;
}

const LOCARNESE_CATALOGUE = pharmacies.pharmacies.filter((pharmacy) =>
  ['Ascona', 'Locarno', 'Losone', 'Tenero'].includes(pharmacy.city),
);

const LIVE_SHAPE_HTML = `
<div class="gridview-wrapper">
  <table class="table table-sm bg-light text-dark">
    <thead>
      <tr><th>Data</th><th>Ora</th><th>Farmacia</th><th>Località</th></tr>
    </thead>
    <tbody>
      <tr style="font-weight:bold;border-top:2px solid #000;">
        <td>${sourceDate(1)}</td><td>08:00</td><td>Amavita Centro</td><td>Ascona</td>
      </tr>
      <tr>
        <td>${sourceDate(4)}</td><td>18:30</td><td>Soldati</td><td>Locarno</td>
      </tr>
      <tr>
        <td>${sourceDate(8)}</td><td>08:00</td><td>Stella d&#039; Oro</td><td>Tenero</td>
      </tr>
    </tbody>
  </table>
</div>
<table><thead><tr><th>Numero</th><th>Contatto</th></tr></thead><tbody><tr><td>144</td><td>Ambulanza</td></tr></tbody></table>
`;

describe('Locarnese pharmacy duty parser', () => {
  it('parses the observed server-rendered table and maps names to the Ticino catalogue', () => {
    const parsed = parseLocarneseDutyRows(LIVE_SHAPE_HTML);

    expect(parsed.skipped).toBe(0);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toMatchObject({
      dateText: sourceDate(1),
      timeText: '08:00',
      name: 'Amavita Centro',
      city: 'Ascona',
      startsAt: localDateTimeToIso(sourceDate(1), '08:00'),
    });
    expect(parsed.rows[2].name).toBe("Stella d' Oro");

    const amavita = resolveLocarnesePharmacyIdentity(parsed.rows[0], LOCARNESE_CATALOGUE);
    expect(amavita).toMatchObject({
      id: 'ti-ofct-6612-farmacia-amavita-centro-ascona-ascona',
      name: 'Farmacia Amavita Centro Ascona',
      city: 'Ascona',
    });

    const result = buildLocarnesePharmacyDuties(
      LIVE_SHAPE_HTML,
      LOCARNESE_REGION,
      NOW.toISOString(),
      LOCARNESE_CATALOGUE,
    );
    expect(result.unresolved).toEqual([]);
    expect(result.duties).toHaveLength(2);
    expect(result.duties[0]).toMatchObject({
      pharmacyId: 'ti-ofct-6612-farmacia-amavita-centro-ascona-ascona',
      coverageType: 'region',
      coverageName: 'Locarnese',
      dutyType: 'day',
      status: 'verified',
      sourceUrl: LOCARNESE_REGION.url,
      sourceType: 'official',
      startsAt: localDateTimeToIso(sourceDate(1), '08:00'),
      endsAt: localDateTimeToIso(sourceDate(4), '18:30'),
      fetchedAt: NOW.toISOString(),
      verifiedAt: NOW.toISOString(),
    });
    expect(result.duties[1].pharmacyId).toBe('ti-ofct-6600-farmacia-soldati-sa-locarno');
    expect(result.warnings).toContain('locarnese: last source row retained as boundary-only and not published');
  });

  it('fails closed for empty and malformed source shapes', () => {
    const empty = parseLocarneseDutyRows('');
    expect(empty.rows).toEqual([]);
    expect(empty.skipped).toBe(0);
    expect(empty.warnings[0]).toContain('missing Locarnese duty table');

    const malformed = `
      <table class="table table-sm">
        <thead><tr><th>Data</th><th>Ora</th><th>Farmacia</th><th>Località</th></tr></thead>
        <tbody>
          <tr><td>${sourceDate(1)}</td><td>08:00</td><td>Soldati</td><td>Locarno</td></tr>
          <tr><td>${sourceDate(4)}</td><td>18:30</td><td>Riga incompleta</td></tr>
          <tr><td>${sourceDate(8)}</td><td>08:00</td><td>Solduno</td><td>Locarno Solduno</td></tr>
          <tr><td>${sourceDate(12)}</td><td>08:00</td><td>Amavita Centro</td><td>Ascona</td></tr>
        </tbody>
      </table>`;

    const parsed = parseLocarneseDutyRows(malformed);
    expect(parsed.skipped).toBe(1);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.warnings).toContain('skipped 1 malformed Locarnese duty row(s)');

    const result = buildLocarnesePharmacyDuties(
      malformed,
      LOCARNESE_REGION,
      NOW.toISOString(),
      LOCARNESE_CATALOGUE,
    );
    expect(result.duties).toHaveLength(1);
    expect(result.duties[0]).toMatchObject({
      pharmacyId: 'ti-ofct-6600-farmacia-solduno-locarno',
      startsAt: localDateTimeToIso(sourceDate(8), '08:00'),
      endsAt: localDateTimeToIso(sourceDate(12), '08:00'),
    });
    expect(result.duties.some((duty) => duty.startsAt === localDateTimeToIso(sourceDate(1), '08:00'))).toBe(false);
    expect(result.warnings).toContain('locarnese: missing duty boundary before row 1');
  });

  it('returns unresolved identities and emits no duty for unknown or ambiguous catalogue matches', () => {
    const row = {
      dateText: sourceDate(1),
      timeText: '08:00',
      startsAt: localDateTimeToIso(sourceDate(1), '08:00'),
      name: 'Farmacia Mistero',
      city: 'Losone',
    };
    expect(resolveLocarnesePharmacyIdentity(row, LOCARNESE_CATALOGUE)).toBeNull();

    const html = `
      <table>
        <thead><tr><th>Data</th><th>Ora</th><th>Farmacia</th><th>Località</th></tr></thead>
        <tbody>
          <tr><td>${sourceDate(1)}</td><td>08:00</td><td>Farmacia Mistero</td><td>Losone</td></tr>
          <tr><td>${sourceDate(4)}</td><td>18:30</td><td>Centro</td><td>Losone</td></tr>
        </tbody>
      </table>`;
    const ambiguousCatalogue = [
      { id: 'ti-centro-a', name: 'Farmacia Centro', city: 'Losone', country: 'CH', canton: 'Ticino' },
      { id: 'ti-centro-b', name: 'Farmacia Centro Losone SA', city: 'Losone', country: 'CH', canton: 'Ticino' },
    ];
    const result = buildLocarnesePharmacyDuties(
      html,
      LOCARNESE_REGION,
      NOW.toISOString(),
      ambiguousCatalogue,
    );

    expect(result.duties).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        name: 'Farmacia Mistero',
        city: 'Losone',
        sourceUrl: LOCARNESE_REGION.url,
        reason: 'no matching Ticino catalogue identity',
        candidateIds: [],
      }),
      expect.objectContaining({
        name: 'Centro',
        city: 'Losone',
        reason: 'ambiguous Ticino catalogue identity',
        candidateIds: ['ti-centro-a', 'ti-centro-b'],
      }),
    ]);
  });
});
