import { describe, expect, it } from 'vitest';
import { buildTicinoCompleteRecords } from '../scripts/lib/pharmacy-border-parser.mjs';

describe('buildTicinoCompleteRecords', () => {
  it('reconciles an exact pharmacy identity across locality labels and retains its old detail URL', () => {
    // The two previous records and the PDF row mirror the live Castagnola/Lugano
    // collision reported by the 2026-10-10 pharmacy health run.
    const previousOfctRecord = {
      id: 'ti-farmacia-castagnola-castagnola',
      name: 'Farmacia Castagnola',
      slug: 'farmacia-castagnola-castagnola',
      address: 'Strada di Gandria 4',
      postalCode: '6976',
      city: 'Castagnola',
      canton: 'Ticino',
      country: 'CH',
      sourceUrl: 'https://www.ofct.ch/luganese/',
      sourceType: 'official',
      lastVerifiedAt: '2026-08-31T04:26:29.114Z',
    };
    const previousPdfRecord = {
      ...previousOfctRecord,
      id: 'ti-ofct-6976-farmacia-castagnola-lugano',
      slug: 'farmacia-castagnola-lugano',
      city: 'Lugano',
      sourceUrl: 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Elenchi_e_Indirizzi/Lista_Farmacie.pdf',
      lastVerifiedAt: '2026-10-10T10:47:38.013Z',
    };

    const records = buildTicinoCompleteRecords(
      [{
        name: 'Farmacia Castagnola',
        address: 'Strada di Gandria 4',
        postalCode: '6976',
        city: 'Lugano',
      }],
      {
        previous: [previousOfctRecord, previousPdfRecord],
        fetchedAt: '2026-10-10T10:47:38.013Z',
        requiredIds: [previousOfctRecord.id],
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: previousOfctRecord.id,
      name: 'Farmacia Castagnola',
      slug: 'farmacia-castagnola-lugano',
      city: 'Lugano',
      urlAliases: [{
        country: 'CH',
        city: 'Castagnola',
        slug: 'farmacia-castagnola-castagnola',
      }],
    });
  });
});
