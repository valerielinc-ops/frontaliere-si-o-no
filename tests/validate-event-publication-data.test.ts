import { describe, expect, it } from 'vitest';
import { validateEventPublicationData } from '../scripts/ci/validate-event-publication-data.mjs';

const event = {
  id: 'source:1',
  title: 'Evento',
  startDate: '2026-11-15',
};

function validValues(): any {
  const dataset = {
    schemaVersion: 1,
    generatedAt: '2026-11-15T12:00:00.000Z',
    totalEvents: 1,
    events: [event],
  };
  return {
    dataset,
    publicDataset: structuredClone(dataset),
    geocodeCache: { lugano: { lat: 46.0037, lng: 8.9511 }, missing: null },
    translationCache: { evento: { en: 'Event', de: null, fr: 'Événement' } },
    imageManifest: { source_1: 'webp' },
    baselineGeocodeCache: { lugano: { lat: 46.0037, lng: 8.9511 } },
    baselineTranslationCache: { evento: { en: 'Event' } },
  };
}

describe('validate-event-publication-data', () => {
  it('accepts complete twin datasets and governed caches', () => {
    expect(validateEventPublicationData(validValues())).toEqual([]);
  });

  it('rejects malformed or truncated publication data', () => {
    const values = validValues();
    values.dataset.totalEvents = 2;
    values.publicDataset.events[0].title = '';
    values.geocodeCache = {};
    values.translationCache = { evento: { es: 'Evento' } };
    values.imageManifest = { '../unsafe': 'svg' };

    const errors = validateEventPublicationData(values);

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('totalEvents'),
      expect.stringContaining('title'),
      expect.stringContaining('deve essere identico'),
      expect.stringContaining('cache troncata'),
      expect.stringContaining('locale non supportata'),
      expect.stringContaining('id immagine non sicuro'),
      expect.stringContaining('estensione immagine non supportata'),
    ]));
  });

  it('rejects duplicate ids and invalid calendar dates', () => {
    const values = validValues();
    values.dataset.events = [event, { ...event, startDate: '2026-02-30' }];
    values.dataset.totalEvents = 2;
    values.publicDataset = structuredClone(values.dataset);

    const errors = validateEventPublicationData(values);

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('id duplicato'),
      expect.stringContaining('startDate'),
    ]));
  });

  it('rejects a future generation timestamp', () => {
    const values = validValues();
    values.dataset.generatedAt = '2026-11-16T12:00:00.000Z';
    values.publicDataset.generatedAt = values.dataset.generatedAt;
    values.now = new Date('2026-11-15T12:00:00.000Z');

    expect(validateEventPublicationData(values)).toEqual(expect.arrayContaining([
      expect.stringContaining('timestamp nel futuro'),
    ]));
  });
});
