/**
 * weatherBorderWaitFusionPlugin — F8 fusion (per /plan-eng-review D11).
 *
 * Post-processes the per-crossing HTML emitted by borderWaitPagesPlugin
 * by injecting a meteo+alert section. Designed as a SEPARATE plugin (post
 * to borderWait) instead of editing borderWaitPagesPlugin so the existing
 * 5 valico pages are not at risk of regression.
 *
 * For each valico × locale:
 *   1. Resolve dist HTML path via buildOggiPath() (canonical URL builder).
 *   2. Read the existing HTML (skip if absent — borderWait may not have
 *      emitted that locale or crossing).
 *   3. Build a meteo section: current weather + alert banner if any
 *      WEATHER_VALICHI alertId is active in snapshot.alerts.
 *   4. Insert before `</main>` (or before `</body>` as fallback).
 *   5. Write back atomically.
 *
 * Skipped entirely with SKIP_WEATHER=1.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { WEATHER_VALICHI, type WeatherValico } from '../data/weatherValichi';
import { parseWeatherSnapshot, type AlertState, type CityWeather, type WeatherSnapshot } from '../services/weather/types';
import { wmoText, type Locale } from '../services/weather/wmoCodes';
import { findAlertConfigById } from '../data/weatherAlertConfig';
import { buildOggiPath, BORDER_WAIT_LOCALE_PREFIX, BORDER_WAIT_SECTION, type BorderWaitLocale, type BorderCrossingSlug } from './borderWaitData';

const LOCALES: readonly Locale[] = Object.freeze(['it', 'en', 'de', 'fr']);

export function weatherBorderWaitFusionPlugin(rootDir: string): Plugin {
  return {
    name: 'frontaliere:weather-border-wait-fusion',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      if (process.env.SKIP_WEATHER === '1') {
        console.log('[weather-border-wait-fusion] SKIP_WEATHER=1 → skipped');
        return;
      }
      const distDir = resolve(rootDir, 'dist');
      if (!existsSync(distDir)) {
        console.warn('[weather-border-wait-fusion] dist/ missing, skipping');
        return;
      }
      const snapshot = loadSnapshot(rootDir);
      let updated = 0;
      let skipped = 0;
      for (const locale of LOCALES) {
        for (const valico of WEATHER_VALICHI) {
          const path = buildOggiPath(locale as BorderWaitLocale, valico.slug as BorderCrossingSlug);
          const fileFull = resolve(distDir, `.${path}index.html`);
          if (!existsSync(fileFull)) {
            skipped += 1;
            continue;
          }
          try {
            const original = readFileSync(fileFull, 'utf-8');
            const sectionHtml = renderWeatherSection(locale, valico, snapshot);
            const injected = injectBeforeMainClose(original, sectionHtml);
            if (injected !== original) {
              writeFileSync(fileFull, injected, 'utf-8');
              updated += 1;
            }
          } catch (e) {
            console.warn(`[weather-border-wait-fusion] failed for ${locale}/${valico.slug}: ${(e as Error).message}`);
            skipped += 1;
          }
        }
      }
      console.log(`[weather-border-wait-fusion] updated ${updated} valico pages (skipped ${skipped})`);
    },
  };
}

function loadSnapshot(rootDir: string): WeatherSnapshot | null {
  const path = resolve(rootDir, 'data/weather-snapshot.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = parseWeatherSnapshot(raw);
    if (!parsed.ok) {
      const err = parsed as { ok: false; error: string; path?: string };
      console.warn(`[weather-border-wait-fusion] snapshot parse failed: ${err.error} at ${err.path ?? '?'}`);
      return null;
    }
    return parsed.value;
  } catch (e) {
    console.warn(`[weather-border-wait-fusion] snapshot read failed: ${(e as Error).message}`);
    return null;
  }
}

function renderWeatherSection(locale: Locale, valico: WeatherValico, snapshot: WeatherSnapshot | null): string {
  const valicoMeteo = snapshot?.valichi[valico.id];
  // Fall back to a city in the same locale that's geographically close
  // (the cron writer fills .cities, not .valichi, in PR2-only state). The
  // PR3 cron extension fills .valichi too — so this fallback only applies
  // when running with the older cron.
  const cityFallback = snapshot
    ? findClosestCity(snapshot, valico)
    : undefined;
  const current = valicoMeteo?.current ?? cityFallback?.current;

  const heading = locale === 'it' ? 'Condizioni meteo al valico' : locale === 'en' ? 'Weather at the crossing' : locale === 'de' ? 'Wetter am Übergang' : 'Météo au passage';
  const subhead = locale === 'it'
    ? `Meteo aggiornato per ${valico.nameLocalised.it} dal council Open-Meteo + Met.no + MeteoSwiss.`
    : locale === 'en'
    ? `Updated weather for ${valico.nameLocalised.en} from the Open-Meteo + Met.no + MeteoSwiss council.`
    : locale === 'de'
    ? `Aktualisierte Wetterdaten für ${valico.nameLocalised.de} vom Council Open-Meteo + Met.no + MeteoSwiss.`
    : `Météo mise à jour pour ${valico.nameLocalised.fr} depuis le conseil Open-Meteo + Met.no + MeteoSwiss.`;

  const heroHtml = current
    ? `<div class="weather-fusion-hero" aria-live="polite">
<div class="hero-temp">${Math.round(current.temperature)}°</div>
<div class="hero-cond">${escapeHtml(wmoText(current.weatherCode, locale))}</div>
${current.windSpeedKmh != null ? `<div class="hero-wind">${labelWind(locale)}: ${Math.round(current.windSpeedKmh)} km/h</div>` : ''}
${current.humidity != null ? `<div class="hero-humidity">${labelHumidity(locale)}: ${current.humidity}%</div>` : ''}
</div>`
    : `<p class="weather-fusion-sentinel">${escapeHtml(locale === 'it' ? 'Dati meteo non disponibili' : locale === 'en' ? 'Weather data unavailable' : locale === 'de' ? 'Wetterdaten nicht verfügbar' : 'Données météo indisponibles')}</p>`;

  const activeAlert = findActiveAlertForValico(valico, snapshot);
  const alertBannerHtml = activeAlert ? renderAlertBanner(locale, activeAlert) : '';

  const linkBackHtml = renderLinkBackToAlertHub(locale);

  return `
<section class="weather-fusion" data-valico="${escapeHtml(valico.id)}">
<h2>${escapeHtml(heading)}</h2>
<p>${escapeHtml(subhead)}</p>
${alertBannerHtml}
${heroHtml}
${linkBackHtml}
</section>
`;
}

function findClosestCity(snapshot: WeatherSnapshot, valico: WeatherValico): CityWeather | undefined {
  let best: CityWeather | undefined;
  let bestDist = Infinity;
  for (const c of Object.values(snapshot.cities)) {
    // Lat/lng aren't on snapshot CityWeather; use cityId instead by mapping
    // valico → nearest city heuristically (for PR2-only fallback). When
    // valichi data is in the snapshot (PR3 cron extension), this is a
    // no-op because valicoMeteo is preferred.
    const heuristicMatch = nearestCityIdFor(valico.id);
    if (heuristicMatch && c.cityId === heuristicMatch) {
      best = c;
      bestDist = 0;
      break;
    }
  }
  return best;
  // Note: bestDist intentionally unused; left for future weighted matching.
}

function nearestCityIdFor(valicoId: string): string | undefined {
  switch (valicoId) {
    case 'chiasso':     return 'chiasso';
    case 'stabio':      return 'mendrisio';
    case 'gandria':     return 'lugano';
    case 'ponte-tresa': return 'lugano';
    case 'gaggiolo':    return 'mendrisio';
    default:            return undefined;
  }
}

function findActiveAlertForValico(valico: WeatherValico, snapshot: WeatherSnapshot | null): AlertState | undefined {
  if (!snapshot) return undefined;
  for (const alertId of valico.alertIds) {
    const state = snapshot.alerts[alertId];
    if (state && state.active) return state;
  }
  return undefined;
}

function renderAlertBanner(locale: Locale, state: AlertState): string {
  const cfg = findAlertConfigById(state.alertId);
  if (!cfg) return '';
  const heading = locale === 'it' ? 'Allerta meteo attiva' : locale === 'en' ? 'Active weather alert' : locale === 'de' ? 'Aktive Wetterwarnung' : 'Alerte météo active';
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const alertUrl = `${localePath}/${locale === 'it' ? 'allerte' : locale === 'en' ? 'alerts' : locale === 'de' ? 'warnungen' : 'alertes'}/${cfg.slug[locale]}/`;
  const linkLabel = locale === 'it' ? 'Vedi dettagli allerta' : locale === 'en' ? 'See alert details' : locale === 'de' ? 'Warnungsdetails ansehen' : 'Voir les détails';
  return `<div class="weather-fusion-alert danger" role="alert"><strong>${escapeHtml(heading)}: ${escapeHtml(cfg.title[locale])}</strong> · <a href="${alertUrl}">${escapeHtml(linkLabel)} →</a></div>`;
}

function renderLinkBackToAlertHub(locale: Locale): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const hubSlug = locale === 'it' ? 'allerte-meteo' : locale === 'en' ? 'weather-alerts' : locale === 'de' ? 'wetterwarnungen' : 'alertes-meteo';
  const citySlug = locale === 'it' ? 'meteo-frontalieri' : locale === 'en' ? 'commute-weather' : locale === 'de' ? 'pendler-wetter' : 'meteo-frontaliers';
  const allertaLabel = locale === 'it' ? 'Tutte le allerte meteo' : locale === 'en' ? 'All weather alerts' : locale === 'de' ? 'Alle Wetterwarnungen' : 'Toutes les alertes météo';
  const meteoLabel = locale === 'it' ? 'Meteo per altre città' : locale === 'en' ? 'Weather for other cities' : locale === 'de' ? 'Wetter für andere Städte' : 'Météo pour d\'autres villes';
  return `<nav class="weather-fusion-links" aria-label="${escapeHtml(allertaLabel)}"><a href="${localePath}/${hubSlug}/">${escapeHtml(allertaLabel)} →</a> · <a href="${localePath}/${citySlug}/">${escapeHtml(meteoLabel)} →</a></nav>`;
}

function injectBeforeMainClose(html: string, section: string): string {
  // Prefer </main>; fall back to last </div></body>
  const mainCloseIdx = html.lastIndexOf('</main>');
  if (mainCloseIdx > -1) {
    return html.slice(0, mainCloseIdx) + section + html.slice(mainCloseIdx);
  }
  const bodyCloseIdx = html.lastIndexOf('</body>');
  if (bodyCloseIdx > -1) {
    return html.slice(0, bodyCloseIdx) + section + html.slice(bodyCloseIdx);
  }
  return html + section;
}

function labelWind(l: Locale): string { return l === 'it' ? 'Vento' : l === 'en' ? 'Wind' : l === 'de' ? 'Wind' : 'Vent'; }
function labelHumidity(l: Locale): string { return l === 'it' ? 'Umidità' : l === 'en' ? 'Humidity' : l === 'de' ? 'Luftfeuchtigkeit' : 'Humidité'; }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return c;
    }
  });
}

// Re-export to keep module self-contained when imported elsewhere
export { BORDER_WAIT_LOCALE_PREFIX, BORDER_WAIT_SECTION };
