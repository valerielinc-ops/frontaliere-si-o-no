/**
 * Cron writer — updates data/weather-snapshot.json with fresh council
 * results for all cities + valichi, plus MeteoSwiss official alert states.
 * Invoked by .github/workflows/update-weather.yml every 4h. Run via:
 *
 *     npx tsx scripts/update-weather.ts
 *
 * Honors the rebase-retry pattern (see project_workflow_push_race_pattern
 * memory) for the git push step. Met.no If-Modified-Since cache lives in
 * data/.weather-cache/ (gitignored).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchCouncilCity, fetchMeteoSwissAlerts, alertItemsToStates,
  parseWeatherSnapshot,
  type WeatherSnapshot, type CityWeather, type AlertState,
} from '../services/weatherService';
import type { MetNoCacheEntry } from '../services/weather/metNoFetcher';
import { WEATHER_CITIES } from '../data/weatherCities';
import type { MeteoSwissAlertType } from '../services/weather/meteoSwissFetcher';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SNAPSHOT_PATH = resolve(REPO_ROOT, 'data/weather-snapshot.json');
const SIZE_BUDGET_BYTES = 200 * 1024;
const CACHE_DIR = resolve(REPO_ROOT, 'data/.weather-cache');

interface AlertConfigEntry {
  id: string;
  type: MeteoSwissAlertType;
  regionId?: string;
  minLevel?: number;
}

const ALERT_CONFIG: AlertConfigEntry[] = [
  { id: 'snow-gottardo', type: 'snow', regionId: 'TI-N', minLevel: 2 },
  { id: 'nebbia-mendrisio', type: 'rain', regionId: 'TI-S', minLevel: 2 },
  { id: 'gelo-confine', type: 'frost', regionId: 'TI', minLevel: 2 },
  { id: 'vento-forte-mendrisio', type: 'wind', regionId: 'TI-S', minLevel: 2 },
  { id: 'grandine-lecco', type: 'thunderstorm', regionId: 'IT-LECCO', minLevel: 2 },
  { id: 'ondata-caldo-ticino', type: 'heat', regionId: 'TI', minLevel: 2 },
  { id: 'alluvione-rischio', type: 'rain', regionId: 'TI-N', minLevel: 3 },
  { id: 'ghiaccio-strade', type: 'slipperiness', regionId: 'TI', minLevel: 2 },
];

async function readMetNoCache(lat: number, lng: number): Promise<MetNoCacheEntry | undefined> {
  const file = cachePath(lat, lng);
  try {
    const content = await readFile(file, 'utf-8');
    return JSON.parse(content) as MetNoCacheEntry;
  } catch {
    return undefined;
  }
}

async function writeMetNoCache(lat: number, lng: number, entry: MetNoCacheEntry): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(lat, lng), JSON.stringify(entry), 'utf-8');
}

function cachePath(lat: number, lng: number): string {
  return resolve(CACHE_DIR, `met-no-${lat.toFixed(4)}-${lng.toFixed(4)}.json`);
}

async function gather(): Promise<WeatherSnapshot> {
  const cities: Record<string, CityWeather> = {};
  const valichi: Record<string, never> = {}; // PR3 fills these

  // Sequential city loop with 1.5s gap to honor Met.no fair-use rate limit
  // even though Promise.allSettled fans out the 3 sources within each city.
  for (const c of WEATHER_CITIES) {
    try {
      const cw = await fetchCouncilCity({
        cityId: c.id,
        lat: c.lat,
        lng: c.lng,
        metNoCache: { read: readMetNoCache, write: writeMetNoCache },
      });
      cities[c.id] = cw;
      console.error(`[ok] ${c.id}: ${cw.current.temperature}°C confidence=${cw.confidence} sources=${cw.sources.join('+')}`);
    } catch (err) {
      console.error(`[fail] ${c.id}: ${(err as Error).message}`);
    }
    await sleep(1500);
  }

  let alerts: Record<string, AlertState> = {};
  try {
    const result = await fetchMeteoSwissAlerts();
    if (result.ok && result.items) {
      const states = alertItemsToStates(result.items, ALERT_CONFIG);
      for (const s of states) alerts[s.alertId] = s;
      const activeCount = states.filter((s) => s.active).length;
      console.error(`[alerts] fetched ${result.items.length} items → ${activeCount}/${states.length} active`);
    } else {
      console.error(`[alerts] fetch failed: ${result.error ?? 'unknown'}`);
      // Render dormant default for every alert so the snapshot stays well-formed.
      for (const cfg of ALERT_CONFIG) {
        alerts[cfg.id] = {
          alertId: cfg.id,
          active: false,
          trigger: 'none',
          confidence: 'low',
          source: 'MeteoSwiss (unreachable)',
        };
      }
    }
  } catch (err) {
    console.error(`[alerts] exception: ${(err as Error).message}`);
    for (const cfg of ALERT_CONFIG) {
      alerts[cfg.id] = {
        alertId: cfg.id, active: false, trigger: 'none', confidence: 'low', source: 'MeteoSwiss (exception)',
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    cities,
    alerts,
    valichi,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function loadPreviousSnapshot(): Promise<WeatherSnapshot | null> {
  try {
    const text = await readFile(SNAPSHOT_PATH, 'utf-8');
    const json: unknown = JSON.parse(text);
    const parsed = parseWeatherSnapshot(json);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function mergeWithPrevious(fresh: WeatherSnapshot, previous: WeatherSnapshot | null): WeatherSnapshot {
  if (!previous) return fresh;
  // For each city missing in fresh, fall back to previous (preserves last-known
  // good data when a cron run has partial failure). The aggregator already
  // marks confidence=low for partial sources; here we are about overall
  // city absence from the snapshot.
  const cities = { ...fresh.cities };
  for (const [id, cw] of Object.entries(previous.cities)) {
    if (!(id in cities)) cities[id] = cw;
  }
  const alerts = { ...fresh.alerts };
  // Alerts: prefer fresh (MeteoSwiss authoritative) but if fresh has trigger=none
  // and previous had active, keep the fresh decision (event truly ended). No
  // inversion logic.
  return { ...fresh, cities, alerts };
}

async function main(): Promise<void> {
  console.error(`[start] update-weather at ${new Date().toISOString()}`);
  const fresh = await gather();
  const previous = await loadPreviousSnapshot();
  const merged = mergeWithPrevious(fresh, previous);

  // Validate before writing
  const parsed = parseWeatherSnapshot(merged);
  if (!parsed.ok) {
    const err = parsed as { ok: false; error: string; path?: string };
    console.error(`[fatal] snapshot validation failed: ${err.error} at ${err.path ?? '?'}`);
    process.exit(1);
  }

  const json = JSON.stringify(parsed.value, null, 2);
  const sizeBytes = Buffer.byteLength(json, 'utf-8');
  if (sizeBytes > SIZE_BUDGET_BYTES) {
    console.error(`[warn] snapshot ${sizeBytes} bytes exceeds budget ${SIZE_BUDGET_BYTES} — emitting compact form`);
    await writeFile(SNAPSHOT_PATH, JSON.stringify(parsed.value), 'utf-8');
  } else {
    await writeFile(SNAPSHOT_PATH, json, 'utf-8');
  }

  const cityCount = Object.keys(parsed.value.cities).length;
  const activeAlerts = Object.values(parsed.value.alerts).filter((a) => a.active).length;
  console.error(`[done] cities=${cityCount} alerts-active=${activeAlerts} bytes=${sizeBytes}`);
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
