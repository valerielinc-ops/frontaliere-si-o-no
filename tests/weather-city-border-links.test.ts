import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { weatherCityPagesPlugin } from '../build-plugins/weatherCityPagesPlugin';
import { WEATHER_CITIES } from '../data/weatherCities';
import { buildOggiPath, type BorderCrossingSlug, type BorderWaitLocale } from '../build-plugins/borderWaitData';

const crossings: Record<string, BorderCrossingSlug[]> = {
  lugano: ['chiasso-brogeda', 'oria-gandria'], bellinzona: ['chiasso-brogeda'],
  mendrisio: ['rodero-stabio', 'gaggiolo'], locarno: ['ponte-tresa'],
  chiasso: ['chiasso-brogeda'], como: ['chiasso-brogeda', 'gaggiolo'],
  varese: ['rodero-stabio', 'gaggiolo'], lecco: ['oria-gandria'],
};
const hubs = { it: 'meteo-frontalieri', en: 'commute-weather', de: 'pendler-wetter', fr: 'meteo-frontaliers' };
let fixture: string;
beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-border-links-'));
  fs.mkdirSync(path.join(fixture, 'dist'));
  vi.stubEnv('SKIP_WEATHER', '');
  const plugin = weatherCityPagesPlugin(fixture);
  const hook = plugin.closeBundle;
  if (typeof hook !== 'function') throw new Error('Expected the native weather closeBundle function');
  await hook.call({} as never);
});
afterAll(() => {
  vi.unstubAllEnvs();
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('weather pages link directly to the native live crossing routes', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps every city/crossing identity in %s', (locale: BorderWaitLocale) => {
    for (const city of WEATHER_CITIES) {
      const file = path.join(fixture, 'dist', locale === 'it' ? '' : locale, hubs[locale], city.slug[locale], 'index.html');
      const html = fs.readFileSync(file, 'utf8');
      for (const crossing of crossings[city.id]) {
        expect(html, `${locale}/${city.id}/${crossing}`).toContain(`href="${buildOggiPath(locale, crossing)}"`);
      }
      if (locale !== 'it') expect(html).not.toMatch(/href="\/(?:en\/border-traffic|de\/grenze-verkehr|fr\/trafic-frontalier)\//);
    }
  });
});
