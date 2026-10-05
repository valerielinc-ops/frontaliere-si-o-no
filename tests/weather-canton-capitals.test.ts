import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEATHER_CANTON_CAPITALS } from '../data/weatherCantonCapitals';
import { WEATHER_CITIES } from '../data/weatherCities';
import { parseWeatherSnapshot } from '../services/weather/types';

const ROOT = path.resolve(__dirname, '..');
/** I 26 cantoni: i capoluoghi coprono tutti tranne TI, gia' nel cluster con pagina. */
const CANTONS = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'];

describe('capoluoghi cantonali nello snapshot meteo (P9f)', () => {
  it('ogni cantone svizzero ha almeno una citta\' nello snapshot, col suo codice', () => {
    const covered = new Set([...WEATHER_CANTON_CAPITALS.map((c) => c.canton), ...WEATHER_CITIES.filter((c) => c.country === 'CH').map((c) => c.canton)]);
    expect([...covered].sort()).toEqual(CANTONS);
    for (const c of WEATHER_CITIES.filter((x) => x.country === 'CH')) expect(c.canton, c.id).toBe('TI');
    for (const c of WEATHER_CITIES.filter((x) => x.country === 'IT')) expect(c.canton, c.id).toBeUndefined();
  });

  it('id unici e diversi da quelli delle citta\' con pagina, coordinate dentro la Svizzera', () => {
    const ids = [...WEATHER_CITIES.map((c) => c.id), ...WEATHER_CANTON_CAPITALS.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of WEATHER_CANTON_CAPITALS) {
      expect(c.lat, c.id).toBeGreaterThan(45.8);
      expect(c.lat, c.id).toBeLessThan(47.85);
      expect(c.lng, c.id).toBeGreaterThan(5.9);
      expect(c.lng, c.id).toBeLessThan(10.5);
    }
  });

  it('i capoluoghi non generano pagine: il plugin delle pagine meteo itera solo WEATHER_CITIES', () => {
    const plugin = fs.readFileSync(path.join(ROOT, 'build-plugins/weatherCityPagesPlugin.ts'), 'utf8');
    expect(plugin).not.toMatch(/weatherCantonCapitals|WEATHER_CANTON_CAPITALS/);
    expect(WEATHER_CITIES).toHaveLength(8);
  });

  it('il parser dello snapshot conserva canton e name (mergeWithPrevious li riprende dal giro precedente)', () => {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/weather-snapshot.json'), 'utf8'));
    const lugano = snap.cities.lugano;
    const withFields = { ...snap, cities: { ...snap.cities, zurich: { ...lugano, cityId: 'zurich', canton: 'ZH', name: 'Zürich', hourly24: [] } } };
    const parsed = parseWeatherSnapshot(withFields);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cities.zurich).toMatchObject({ canton: 'ZH', name: 'Zürich', hourly24: [] });
    // una registrazione senza i campi resta valida e senza campi inventati
    expect(parsed.value.cities.como.canton).toBeUndefined();
  });

  it('peso: con l\'orario solo per le citta\' con pagina lo snapshot resta nel budget di 200 KiB del writer', () => {
    // Misura riproducibile: ogni capoluogo riceve la STESSA risposta (quella di
    // Lugano nello snapshot committato) e si serializza come update-weather.ts
    // (JSON indentato a 2). Baseline: orario per tutti; PR: orario omesso ai capoluoghi.
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/weather-snapshot.json'), 'utf8'));
    const lugano = snap.cities.lugano;
    const build = (dropHourly: boolean) => {
      const cities: Record<string, unknown> = { ...snap.cities };
      for (const c of WEATHER_CANTON_CAPITALS) {
        cities[c.id] = { ...lugano, cityId: c.id, canton: c.canton, name: c.name, hourly24: dropHourly ? [] : lugano.hourly24 };
      }
      return Buffer.byteLength(JSON.stringify({ ...snap, cities }, null, 2));
    };
    const baseline = build(false);
    const pr = build(true);
    console.log(`[weather-snapshot bytes] baseline orario-per-tutti=${baseline} pr=${pr} budget=204800`);
    expect(pr).toBeLessThanOrEqual(200 * 1024);
  });
});
