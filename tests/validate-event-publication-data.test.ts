import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHeadJson, validateEventPublicationData } from '../scripts/ci/validate-event-publication-data.mjs';

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

  it('rejects a cache that replaces a baseline key without changing its size', () => {
    const values = validValues();
    values.geocodeCache = { replacement: { lat: 46.0037, lng: 8.9511 }, missing: null };
    values.translationCache = { replacement: { en: 'Replacement' } };

    const errors = validateEventPublicationData(values);

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('geocode-cache.json:$: cache troncata: mancano 1 chiavi presenti su HEAD (lugano)'),
      expect.stringContaining('translation-cache.json:$: cache troncata: mancano 1 chiavi presenti su HEAD (evento)'),
    ]));
  });

  it('returns null only for a missing baseline and propagates an unreadable existing baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'validate-event-publication-data-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'tests'], { cwd: root });
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'cache.json'), '{not-json');
      execFileSync('git', ['add', 'data/cache.json'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

      expect(readHeadJson(root, 'data/missing.json')).toBeNull();
      expect(() => readHeadJson(root, 'data/cache.json')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
