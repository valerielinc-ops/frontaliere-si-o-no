import { describe, expect, it } from 'vitest';
import {
  buildPharmacyDutyCantons,
  importClock,
  validatePharmacyDutyCantons,
} from '../scripts/publish-pharmacy-duty-cantons.mjs';

const T0 = Date.parse('2026-10-05T02:00:00Z');
const iso = (h: number) => new Date(T0 + h * 3600_000).toISOString();

const duty = (over: Record<string, unknown>) => ({
  pharmacyId: 'x',
  coverageName: 'Mendrisiotto',
  dutyType: 'day',
  startsAt: iso(-10),
  endsAt: iso(10),
  status: 'verified',
  sourceUrl: 'https://www.ofct.ch/mendrisiotto/',
  ...over,
});

describe('publish-pharmacy-duty-cantons', () => {
  const inputs = {
    ticino: {
      _source: 'https://www.ofct.ch/farmacieturno/',
      _fetchedAt: iso(0),
      _release: { state: 'fresh' },
      duties: [
        duty({ pharmacyId: 'ti-del-corso-chiasso' }),
        duty({ pharmacyId: 'ti-sconosciuta' }),
        duty({ pharmacyId: 'ti-del-corso-chiasso', status: 'expired', startsAt: iso(-48), endsAt: iso(-24) }),
        duty({ pharmacyId: 'ti-del-corso-chiasso', startsAt: iso(24 * 9), endsAt: iso(24 * 10) }),
      ],
    },
    ticinoCatalogue: { pharmacies: [{ id: 'ti-del-corso-chiasso', name: 'Del Corso', city: 'Chiasso' }] },
    geneva: { _state: 'stale', _releaseReady: false, _fetchedAt: iso(-1), _source: 'https://pharmageneve.swiss/', duties: [duty({ pharmacyId: 'ge-pharma24' })] },
    genevaCatalogue: { pharmacies: [{ id: 'ge-pharma24', name: 'pharma24', city: 'Genève' }] },
    swiss: {
      snapshots: {
        BS: { _state: 'fresh', _releaseReady: true, _fetchedAt: iso(-2), pharmacies: [{ id: 'bs-a', city: 'Basel' }], duties: [duty({ pharmacyId: 'bs-a', pharmacyName: 'Apotheke A' })] },
        BL: { _state: 'fresh', _releaseReady: true, _fetchedAt: iso(-2), pharmacies: [], duties: [duty({ pharmacyId: 'bl-b', pharmacyName: 'Apotheke B' })] },
      },
    },
  };

  it('solo turni verified nella finestra, farmacia risolta, rilasci fresh; BS e BL nello stesso gruppo', () => {
    const doc = buildPharmacyDutyCantons(inputs, { now: importClock(inputs) as number });
    expect(doc.generatedAt).toBe(iso(0));
    expect(doc.cantons.TI.duties).toEqual([
      expect.objectContaining({ pharmacy: 'Del Corso', city: 'Chiasso', startsAt: iso(-10), endsAt: iso(10) }),
    ]);
    expect(doc.cantons.TI.unresolvedDuties).toBe(1);
    // GE non pubblicabile: il cantone c'e', con lo stato, ma senza turni (fail-closed)
    expect(doc.cantons.GE).toMatchObject({ state: 'stale', duties: [] });
    expect(doc.cantons.BASILEA.members).toEqual(['BS', 'BL']);
    expect(doc.cantons.BASILEA.duties.map((d: { pharmacy: string }) => d.pharmacy)).toEqual(['Apotheke A', 'Apotheke B']);
    expect(validatePharmacyDutyCantons(doc)).toEqual([]);
  });

  it('a dati fermi l\'artefatto non cambia: l\'orologio e\' l\'ultima importazione, non Date.now()', () => {
    const a = JSON.stringify(buildPharmacyDutyCantons(inputs, { now: importClock(inputs) as number }));
    const b = JSON.stringify(buildPharmacyDutyCantons(inputs, { now: importClock(inputs) as number }));
    expect(a).toBe(b);
  });

  it('nessun cantone con turni = errore, non un artefatto vuoto', () => {
    const doc = buildPharmacyDutyCantons({ geneva: inputs.geneva, genevaCatalogue: inputs.genevaCatalogue }, { now: T0 });
    expect(validatePharmacyDutyCantons(doc).join('\n')).toMatch(/nessun cantone con turni/);
  });
});
