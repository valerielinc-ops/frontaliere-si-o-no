import { describe, expect, it } from 'vitest';
import { buildItalianBorderRecords, buildTicinoCompleteRecords } from '../scripts/lib/pharmacy-border-parser.mjs';

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

  it('drops an alias owned by a canonical slug when preserving a colliding duty record', () => {
    const records = buildTicinoCompleteRecords(
      [{
        name: 'Farmacia Foo',
        address: 'Via Roma 1',
        postalCode: '6900',
        city: 'Lugano',
      }],
      {
        previous: [{
          id: 'ti-duty-only',
          name: 'Farmacia Bar',
          slug: 'farmacia-foo-lugano',
          address: 'Via Centro 2',
          postalCode: '6500',
          city: 'Bellinzona',
          canton: 'Ticino',
          country: 'CH',
          urlAliases: [{ country: 'CH', city: 'Lugano', slug: 'farmacia-foo-lugano' }],
        }],
        fetchedAt: '2026-10-10T10:47:38.013Z',
        requiredIds: ['ti-duty-only'],
      },
    );

    const preserved = records.find((record) => record.id === 'ti-duty-only');
    expect(preserved).toMatchObject({ id: 'ti-duty-only', slug: 'farmacia-foo-lugano-2' });
    expect(preserved).not.toHaveProperty('urlAliases');
  });

  it('retains previous OSM-derived optional fields when the response is empty or unmatched', () => {
    const previousSource = {
      url: 'https://www.openstreetmap.org/node/3279865558',
      sourceType: 'directory',
      checkedAt: '2026-11-02T08:57:51.706Z',
      license: 'OpenStreetMap contributors, ODbL 1.0',
    };
    const previousTicino = {
      id: 'ti-boscolo-airolo',
      name: 'Boscolo',
      slug: 'boscolo-airolo',
      address: 'Piazza Motta',
      postalCode: '6780',
      city: 'Airolo',
      canton: 'Ticino',
      country: 'CH',
      sourceUrl: 'https://www.ofct.ch/biasca-e-valli/',
      sourceType: 'official',
      lastVerifiedAt: '2026-11-02T08:57:51.706Z',
      latitude: 46.5284456,
      longitude: 8.6108544,
      openingHours: [{ dayOfWeek: 'monday', opens: '08:00', closes: '12:00' }],
      fieldSources: { coordinates: previousSource, openingHours: previousSource },
    };

    const [ticino] = buildTicinoCompleteRecords([
      { name: 'Boscolo', address: 'Piazza Motta', postalCode: '6780', city: 'Airolo' },
    ], {
      previous: [previousTicino],
      fetchedAt: '2026-11-02T12:36:56.280Z',
      osmElements: [],
    });

    expect(ticino).toMatchObject({
      latitude: 46.5284456,
      longitude: 8.6108544,
      openingHours: previousTicino.openingHours,
      fieldSources: { coordinates: previousSource, openingHours: previousSource },
    });
    expect(ticino.dataAvailability).toMatchObject({ coordinates: 'verified', openingHours: 'verified' });

    const [italy] = buildItalianBorderRecords([{
      cod_farmacia: '42',
      descrizione_farmacia: 'Farmacia Nuova',
      indirizzo: 'Via Roma 1',
      cap: '22012',
      comune: 'Cernobbio',
      sigla_provincia: 'CO',
      regione: 'Lombardia',
      latitudine: '',
      longitudine: '',
      data_inizio_validita: '01/01/2020',
      data_fine_validita: '-',
    }], {
      fetchedAt: '2026-11-02T12:36:56.280Z',
      asOf: '2026-11-02',
      osmElements: [],
      previous: [{
        id: 'it-msal-42',
        ministryId: '42',
        name: 'Farmacia Vecchia',
        slug: 'farmacia-vecchia-como-42',
        address: 'Via Roma 1',
        postalCode: '22100',
        city: 'Como',
        country: 'IT',
        province: 'CO',
        latitude: 45.8,
        longitude: 9.1,
        fieldSources: { coordinates: previousSource },
      }],
    });

    expect(italy).toMatchObject({ latitude: 45.8, longitude: 9.1, fieldSources: { coordinates: previousSource } });
    expect(italy.dataAvailability).toMatchObject({ coordinates: 'verified' });

    const unrelatedOsmElement = {
      type: 'node',
      id: 999,
      lat: 46.7,
      lon: 8.9,
      tags: { amenity: 'pharmacy', name: 'Unrelated pharmacy', 'addr:postcode': '9999', 'addr:city': 'Other' },
    };
    const [partialTicino] = buildTicinoCompleteRecords([
      { name: 'Boscolo', address: 'Piazza Motta', postalCode: '6780', city: 'Airolo' },
    ], {
      previous: [previousTicino],
      fetchedAt: '2026-11-02T12:36:56.280Z',
      osmElements: [unrelatedOsmElement],
    });
    expect(partialTicino).toMatchObject({
      latitude: 46.5284456,
      longitude: 8.6108544,
      openingHours: previousTicino.openingHours,
      fieldSources: { coordinates: previousSource, openingHours: previousSource },
    });

    const [partialItaly] = buildItalianBorderRecords([{
      cod_farmacia: '42',
      descrizione_farmacia: 'Farmacia Nuova',
      indirizzo: 'Via Roma 1',
      cap: '22012',
      comune: 'Cernobbio',
      sigla_provincia: 'CO',
      regione: 'Lombardia',
      latitudine: '',
      longitudine: '',
      data_inizio_validita: '01/01/2020',
      data_fine_validita: '-',
    }], {
      fetchedAt: '2026-11-02T12:36:56.280Z',
      asOf: '2026-11-02',
      osmElements: [unrelatedOsmElement],
      previous: [{
        id: 'it-msal-42',
        ministryId: '42',
        name: 'Farmacia Vecchia',
        slug: 'farmacia-vecchia-como-42',
        address: 'Via Roma 1',
        postalCode: '22100',
        city: 'Como',
        country: 'IT',
        province: 'CO',
        latitude: 45.8,
        longitude: 9.1,
        fieldSources: { coordinates: previousSource },
      }],
    });
    expect(partialItaly).toMatchObject({ latitude: 45.8, longitude: 9.1, fieldSources: { coordinates: previousSource } });
  });
});
