import { describe, expect, it } from 'vitest';
import { buildPharmacyDuties, parsePharmacyDutyRows } from '../scripts/lib/pharmacy-ticino-duty-parser.mjs';

const REGION = { key: 'mendrisiotto', name: 'Mendrisiotto', url: 'https://www.ofct.ch/mendrisiotto/' };
const HTML = `<table id="tabella_mese_corrente_compatta"><tr><th>Data</th></tr><tr class="di_turno"><td class="cella_farma_compatta_data">08/09/2026</td><td class="cella_farma_compatta_orario">08:00</td><td class="cella_farma_compatta_nome">Alchemilla</td><td class="cella_farma_compatta_localita">6850 Mendrisio</td></tr><tr class="di_turno"><td class="cella_farma_compatta_data">12/09/2026</td><td class="cella_farma_compatta_orario">08:00</td><td class="cella_farma_compatta_nome">Amavita Neuroni</td><td class="cella_farma_compatta_localita">6826 Riva San Vitale</td></tr></table>`;

describe('OFCT Ticino duty parser', () => {
  it('parses local Zurich date/time and locality fields', () => {
    const result = parsePharmacyDutyRows(HTML);
    expect(result.skipped).toBe(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ name: 'Alchemilla', postalCode: '6850', city: 'Mendrisio' });
    expect(result.rows[0].startsAt).toBe('2026-09-08T06:00:00.000Z');
  });

  it('uses the next source row as the end boundary and does not invent the last one', () => {
    const result = buildPharmacyDuties(HTML, REGION, '2026-09-09T00:00:00.000Z', new Set(['ti-alchemilla-mendrisio', 'ti-amavita-neuroni-riva-san-vitale']));
    expect(result.duties).toHaveLength(1);
    expect(result.duties[0]).toMatchObject({ coverageType: 'region', coverageName: 'Mendrisiotto', status: 'verified', sourceType: 'official' });
    expect(result.duties[0].endsAt).toBe('2026-09-12T06:00:00.000Z');
    expect(result.warnings).toContain('mendrisiotto: last source row retained as boundary-only and not published');
  });

  it('keeps an unrecognised pharmacy pending review', () => {
    const result = buildPharmacyDuties(HTML, REGION, '2026-09-09T00:00:00.000Z', new Set());
    expect(result.duties[0].status).toBe('pending_review');
    expect(result.duties[0].verifiedAt).toBeUndefined();
  });
});
