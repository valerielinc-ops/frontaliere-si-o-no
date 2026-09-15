import { describe, expect, it, vi } from 'vitest';
import {
  collectOfficialTrafficSignals,
  lambert93ToWgs84,
  mergeSignal,
  parseAtmbBulletinHtml,
  parseAutostradeA9Json,
  parseBisonMeasuredXml,
  parseBisonReferenceCsv,
  parseCcissHtml,
  parseSwissDatexXml,
  parseSwissTrafficLightIntersections,
  parseSwissTrafficLightJson,
} from '../scripts/lib/official-traffic-sources.mjs';

describe('official traffic source parsers', () => {
  it('converts Lambert-93 reference coordinates near Geneva', () => {
    const point = lambert93ToWgs84(651000, 6860000);
    expect(point?.lat).toBeCloseTo(48.46, 1);
    expect(point?.lng).toBeCloseTo(2.33, 1);
  });

  it('maps Bison station speed to an approach signal', () => {
    const csv = [
      'code_pme;source;axe;x_deb;y_deb',
      'GEN-1;DIR;A40;569981.6;6938140',
    ].join('\n');
    const refs = parseBisonReferenceCsv(csv);
    const refPoint = lambert93ToWgs84(569981.6, 6938140);
    expect(refPoint).toBeDefined();

    const xml = `<d2LogicalModel><siteMeasurements><measurementSiteReference id="GEN-1"/><measurementTimeDefault>2026-09-15T08:00:00Z</measurementTimeDefault><basicData xsi:type="TrafficSpeed"><averageVehicleSpeed><speed>12</speed></averageVehicleSpeed></basicData></siteMeasurements></d2LogicalModel>`;
    const signals = parseBisonMeasuredXml(xml, refs, [
      { name: 'Bardonnex', lat: refPoint?.lat ?? 46.14, lng: refPoint?.lng ?? 6.09 },
    ]);
    expect(signals.get('bardonnex')).toMatchObject({
      sourceIds: ['fr-bison-qtv'],
      approachMinutes: 15,
    });
  });

  it('extracts ATMB Bardonnex queue length and delay', () => {
    const signals = parseAtmbBulletinHtml('<p>A41=&gt;BARDONNEX BOUCHON A 12 KM RETARD 4MN</p>');
    expect(signals.get('bardonnex')).toMatchObject({ queueKm: 12, queueMinutes: 4 });
  });

  it('turns an explicitly blocked A9 segment into a conservative signal', () => {
    const signals = parseAutostradeA9Json({
      t_des: 'A9 dir. NORD - Svizzera',
      ftrafficoBloccato: 'true',
      tratte: [{ t_des: 'Como Centro - Chiasso', ftrafficoBloccato: 'true' }],
    }, [{ name: 'Chiasso-Brogeda', lat: 45.84, lng: 9.04 }]);
    expect(signals.get('chiasso-brogeda')).toMatchObject({
      incident: true,
      queueMinutes: 30,
      sourceIds: ['it-autostrade-a9'],
    });
  });

  it('maps a CCISS A9 bulletin to provenance without inventing a duration', () => {
    const signals = parseCcissHtml(
      '<article>A9 Milano-Chiasso code causa traffico intenso</article>',
      [{ name: 'Chiasso-Brogeda', lat: 45.84, lng: 9.04 }],
    );
    expect(signals.get('chiasso-brogeda')).toMatchObject({
      incident: true,
      sourceIds: ['it-cciss'],
    });
    expect(signals.get('chiasso-brogeda')).not.toHaveProperty('queueMinutes');
  });

  it('maps Swiss DATEX coordinates to an incident without inventing minutes', () => {
    const xml = '<d2LogicalModel><publicationTime>2026-09-15T08:00:00Z</publicationTime><location><latitude>45.84</latitude><longitude>9.04</longitude></location><situationRecord><abnormalTrafficType>queue</abnormalTrafficType></situationRecord></d2LogicalModel>';
    const signals = parseSwissDatexXml(xml, [{ name: 'Chiasso-Brogeda', lat: 45.84, lng: 9.04 }]);
    expect(signals.get('chiasso-brogeda')).toMatchObject({ incident: true, sourceIds: ['ch-fedro-datex'] });
    expect(signals.get('chiasso-brogeda')).not.toHaveProperty('queueMinutes');
  });

  it('skips the Swiss call when its quota reservation is denied', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    }) as unknown as Response);
    const reserveSwissRequest = vi.fn().mockResolvedValue({ allowed: false, reason: 'quota' });

    const result = await collectOfficialTrafficSignals({
      swissApiKey: 'opaque-token',
      fetchImpl,
      reserveSwissRequest,
    });

    expect(reserveSwissRequest).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('opentransportdata.swiss'))).toBe(false);
    expect(result.sources.find((source) => source.id === 'ch-astra-traffic-lights')).toMatchObject({
      status: 'skipped',
      reason: 'quota',
    });
  });

  it('maps an OCIT-C spillback snippet through intersection coordinates', () => {
    const intersections = parseSwissTrafficLightIntersections(`
      <Intersections><Intersection><AreaId>TI.CH:01</AreaId>
        <Identification><UnitId><System>1</System><Subsystem>2</Subsystem><Unit>3</Unit></UnitId></Identification>
        <Coordinates><EPSGCode>4326</EPSGCode><Latitude>45.84</Latitude><Longitude>9.04</Longitude></Coordinates>
      </Intersection></Intersections>
    `);
    const signals = parseSwissTrafficLightJson({
      Snippets: [{
        AreaId: 'TI.CH:01',
        UnitId: { System: 1, Subsystem: 2, Unit: 3 },
        Snippet: [{ Timestamp: '2026-09-15T08:00:00Z', Measurements: [{ SpillbackLength: [{ Length: 1250 }] }] }],
      }],
    }, intersections, [{ name: 'Chiasso-Brogeda', lat: 45.84, lng: 9.04 }]);

    expect(signals.get('chiasso-brogeda')).toMatchObject({
      sourceIds: ['ch-astra-traffic-lights'],
      queueKm: 1.25,
      incident: true,
    });
  });

  it('merges provenance and keeps the most conservative explicit signal', () => {
    expect(mergeSignal(
      { sourceIds: ['a'], queueMinutes: 4, incident: false },
      { sourceIds: ['b'], queueMinutes: 8, incident: true },
    )).toMatchObject({ sourceIds: ['a', 'b'], queueMinutes: 8, incident: true });
  });
});
