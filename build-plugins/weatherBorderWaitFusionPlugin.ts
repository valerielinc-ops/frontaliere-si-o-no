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
  const cityFallback = snapshot ? findClosestCity(snapshot, valico) : undefined;
  const current = valicoMeteo?.current ?? cityFallback?.current;

  const heading = locale === 'it' ? 'Condizioni meteo al valico' : locale === 'en' ? 'Weather at the crossing' : locale === 'de' ? 'Wetter am Übergang' : 'Météo au passage';
  const sectionId = `weatherFusion-${valico.id}`;

  const heroHtml = current
    ? `<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:1rem;margin:0 0 12px" aria-live="polite">
<div style="font-size:3.5rem;line-height:1;font-weight:300;color:var(--color-heading);font-variant-numeric:tabular-nums">${Math.round(current.temperature)}°</div>
<div style="font-size:1.125rem;color:var(--color-strong);font-weight:500">${escapeHtml(wmoText(current.weatherCode, locale))}</div>
</div>
<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:14px;color:var(--color-muted)">
${current.windSpeedKmh != null ? `<span style="background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:8px;padding:6px 10px"><strong style="color:var(--color-strong);font-weight:500">${labelWind(locale)}:</strong> ${Math.round(current.windSpeedKmh)} km/h</span>` : ''}
${current.humidity != null ? `<span style="background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:8px;padding:6px 10px"><strong style="color:var(--color-strong);font-weight:500">${labelHumidity(locale)}:</strong> ${current.humidity}%</span>` : ''}
</div>`
    : `<p style="color:var(--color-muted);font-style:italic">${escapeHtml(locale === 'it' ? 'Dati meteo non disponibili' : locale === 'en' ? 'Weather data unavailable' : locale === 'de' ? 'Wetterdaten nicht verfügbar' : 'Données météo indisponibles')}</p>`;

  const activeAlert = findActiveAlertForValico(valico, snapshot);
  const alertBannerHtml = activeAlert ? renderAlertBanner(locale, activeAlert) : '';
  const linkBackHtml = renderLinkBackToAlertHub(locale);

  return `
<section style="margin:0 0 24px" aria-labelledby="${sectionId}" data-valico="${escapeHtml(valico.id)}">
<h2 id="${sectionId}" style="margin:2rem 0 1rem;font-size:1.75rem;line-height:1.2;color:var(--color-heading);font-weight:600">${escapeHtml(heading)}</h2>
${alertBannerHtml}
<div style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:14px;padding:18px 22px">
${heroHtml}
</div>
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
  return `<div role="alert" style="background:var(--color-danger-subtle);border:1px solid var(--color-danger-border);border-radius:14px;padding:14px 18px;margin:0 0 14px;color:var(--color-danger)"><strong style="font-weight:600">${escapeHtml(heading)}: ${escapeHtml(cfg.title[locale])}</strong> · <a href="${alertUrl}" style="color:var(--color-danger);text-decoration:underline">${escapeHtml(linkLabel)} →</a></div>`;
}

function renderLinkBackToAlertHub(locale: Locale): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const hubSlug = locale === 'it' ? 'allerte-meteo' : locale === 'en' ? 'weather-alerts' : locale === 'de' ? 'wetterwarnungen' : 'alertes-meteo';
  const citySlug = locale === 'it' ? 'meteo-frontalieri' : locale === 'en' ? 'commute-weather' : locale === 'de' ? 'pendler-wetter' : 'meteo-frontaliers';
  const allertaLabel = locale === 'it' ? 'Tutte le allerte meteo' : locale === 'en' ? 'All weather alerts' : locale === 'de' ? 'Alle Wetterwarnungen' : 'Toutes les alertes météo';
  const meteoLabel = locale === 'it' ? 'Meteo per altre città' : locale === 'en' ? 'Weather for other cities' : locale === 'de' ? 'Wetter für andere Städte' : 'Météo pour d\'autres villes';
  return `<nav aria-label="${escapeHtml(allertaLabel)}" style="margin:14px 0 0;font-size:14px"><a href="${localePath}/${hubSlug}/" style="color:var(--color-link);text-decoration:none">${escapeHtml(allertaLabel)} →</a> <span style="color:var(--color-muted);margin:0 8px">·</span> <a href="${localePath}/${citySlug}/" style="color:var(--color-link);text-decoration:none">${escapeHtml(meteoLabel)} →</a></nav>`;
}

function injectBeforeMainClose(html: string, section: string): string {
  // Insertion order priority (high → low). Each candidate places the meteo
  // block in a more meaningful position than the previous one.
  // 1. Right BEFORE the "Andamento orario di oggi" / hourly pattern section
  //    — meteo immediately follows the live wait-time card and webcam.
  // 2. Right BEFORE the "Pattern settimanale" section.
  // 3. Right BEFORE the "Informazioni valico" section.
  // 4. Right BEFORE </main> (legacy fallback).
  // 5. Right BEFORE </body> (last resort).
  const candidates = [
    /<section[^>]*aria-labelledby="hourlyToday"/i,
    /<section[^>]*aria-labelledby="weeklyPattern"/i,
    /<section[^>]*aria-labelledby="infoValico"/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m.index !== undefined) {
      return html.slice(0, m.index) + section + html.slice(m.index);
    }
  }
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
