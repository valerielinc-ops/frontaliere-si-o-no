/**
 * WMO 4677 weather code mapping — exhaustive table covering all 27 codes
 * documented by WMO. Single source of truth for icons (lucide), emoji
 * (body-text use only, never UI), and i18n keys. Plain text fallback per
 * locale included for SSR/SEO body content.
 *
 * Ranges follow Open-Meteo / Met.no mapping convention:
 *   0      Clear sky
 *   1-3    Partly to overcast
 *   45-48  Fog
 *   51-57  Drizzle (light/mod/heavy + freezing)
 *   61-67  Rain (light/mod/heavy + freezing)
 *   71-77  Snow (light/mod/heavy + grains)
 *   80-82  Rain showers (slight/mod/violent)
 *   85-86  Snow showers (slight/heavy)
 *   95-99  Thunderstorm (with/without hail)
 */

import type { LucideIcon } from 'lucide-react';
import {
  Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle,
  CloudRain, CloudSnow, CloudHail, CloudLightning,
} from 'lucide-react';

export type WmoCode = number;

interface WmoEntry {
  /** lucide-react icon component to render in UI. */
  icon: LucideIcon;
  /** dark variant used when isDay === false (e.g. Moon vs Sun). */
  iconNight?: LucideIcon;
  /** i18n key (already exists in services/locales/*-core.ts). */
  i18nKey: string;
  /** Plain text fallback per-locale for SEO body / aria-label. */
  text: { it: string; en: string; de: string; fr: string };
  /** Emoji for body-text use only — NEVER as UI element. */
  emoji: string;
}

const ENTRIES: Record<number, WmoEntry> = {
  0: {
    icon: Sun, iconNight: Moon,
    i18nKey: 'morning.weather.clear',
    text: { it: 'Sereno', en: 'Clear', de: 'Klar', fr: 'Clair' },
    emoji: '☀️',
  },
  1: {
    icon: CloudSun, iconNight: CloudMoon,
    i18nKey: 'morning.weather.mainlyClear',
    text: { it: 'Prevalentemente sereno', en: 'Mainly clear', de: 'Vorwiegend klar', fr: 'Plutôt clair' },
    emoji: '🌤️',
  },
  2: {
    icon: CloudSun, iconNight: CloudMoon,
    i18nKey: 'morning.weather.partlyCloudy',
    text: { it: 'Parzialmente nuvoloso', en: 'Partly cloudy', de: 'Teilweise bewölkt', fr: 'Partiellement nuageux' },
    emoji: '⛅',
  },
  3: {
    icon: Cloud,
    i18nKey: 'morning.weather.overcast',
    text: { it: 'Coperto', en: 'Overcast', de: 'Bedeckt', fr: 'Couvert' },
    emoji: '☁️',
  },
  45: {
    icon: CloudFog,
    i18nKey: 'morning.weather.fog',
    text: { it: 'Nebbia', en: 'Fog', de: 'Nebel', fr: 'Brouillard' },
    emoji: '🌫️',
  },
  48: {
    icon: CloudFog,
    i18nKey: 'morning.weather.fog',
    text: { it: 'Nebbia con brina', en: 'Depositing rime fog', de: 'Reifablagernder Nebel', fr: 'Brouillard givrant' },
    emoji: '🌫️',
  },
  51: {
    icon: CloudDrizzle,
    i18nKey: 'morning.weather.drizzle',
    text: { it: 'Pioviggine leggera', en: 'Light drizzle', de: 'Leichter Sprühregen', fr: 'Bruine légère' },
    emoji: '🌦️',
  },
  53: {
    icon: CloudDrizzle,
    i18nKey: 'morning.weather.drizzle',
    text: { it: 'Pioviggine moderata', en: 'Moderate drizzle', de: 'Mäßiger Sprühregen', fr: 'Bruine modérée' },
    emoji: '🌦️',
  },
  55: {
    icon: CloudDrizzle,
    i18nKey: 'morning.weather.drizzle',
    text: { it: 'Pioviggine intensa', en: 'Dense drizzle', de: 'Starker Sprühregen', fr: 'Bruine dense' },
    emoji: '🌦️',
  },
  56: {
    icon: CloudDrizzle,
    i18nKey: 'morning.weather.drizzle',
    text: { it: 'Pioviggine gelata leggera', en: 'Light freezing drizzle', de: 'Leichter gefrierender Sprühregen', fr: 'Bruine verglaçante légère' },
    emoji: '🌧️',
  },
  57: {
    icon: CloudDrizzle,
    i18nKey: 'morning.weather.drizzle',
    text: { it: 'Pioviggine gelata intensa', en: 'Dense freezing drizzle', de: 'Starker gefrierender Sprühregen', fr: 'Bruine verglaçante dense' },
    emoji: '🌧️',
  },
  61: {
    icon: CloudRain,
    i18nKey: 'morning.weather.rain',
    text: { it: 'Pioggia leggera', en: 'Slight rain', de: 'Leichter Regen', fr: 'Pluie légère' },
    emoji: '🌧️',
  },
  63: {
    icon: CloudRain,
    i18nKey: 'morning.weather.rain',
    text: { it: 'Pioggia moderata', en: 'Moderate rain', de: 'Mäßiger Regen', fr: 'Pluie modérée' },
    emoji: '🌧️',
  },
  65: {
    icon: CloudRain,
    i18nKey: 'morning.weather.rain',
    text: { it: 'Pioggia intensa', en: 'Heavy rain', de: 'Starker Regen', fr: 'Pluie forte' },
    emoji: '🌧️',
  },
  66: {
    icon: CloudRain,
    i18nKey: 'morning.weather.rain',
    text: { it: 'Pioggia gelata leggera', en: 'Light freezing rain', de: 'Leichter gefrierender Regen', fr: 'Pluie verglaçante légère' },
    emoji: '🌧️',
  },
  67: {
    icon: CloudRain,
    i18nKey: 'morning.weather.rain',
    text: { it: 'Pioggia gelata intensa', en: 'Heavy freezing rain', de: 'Starker gefrierender Regen', fr: 'Pluie verglaçante forte' },
    emoji: '🌧️',
  },
  71: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snow',
    text: { it: 'Nevicate leggere', en: 'Slight snow', de: 'Leichter Schneefall', fr: 'Neige légère' },
    emoji: '🌨️',
  },
  73: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snow',
    text: { it: 'Nevicate moderate', en: 'Moderate snow', de: 'Mäßiger Schneefall', fr: 'Neige modérée' },
    emoji: '🌨️',
  },
  75: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snow',
    text: { it: 'Nevicate intense', en: 'Heavy snow', de: 'Starker Schneefall', fr: 'Neige forte' },
    emoji: '❄️',
  },
  77: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snow',
    text: { it: 'Granuli di neve', en: 'Snow grains', de: 'Schneegriesel', fr: 'Grésil' },
    emoji: '❄️',
  },
  80: {
    icon: CloudRain,
    i18nKey: 'morning.weather.showers',
    text: { it: 'Rovesci leggeri', en: 'Slight showers', de: 'Leichte Regenschauer', fr: 'Averses légères' },
    emoji: '🌦️',
  },
  81: {
    icon: CloudRain,
    i18nKey: 'morning.weather.showers',
    text: { it: 'Rovesci moderati', en: 'Moderate showers', de: 'Mäßige Regenschauer', fr: 'Averses modérées' },
    emoji: '🌦️',
  },
  82: {
    icon: CloudRain,
    i18nKey: 'morning.weather.showers',
    text: { it: 'Rovesci violenti', en: 'Violent showers', de: 'Heftige Regenschauer', fr: 'Averses violentes' },
    emoji: '🌧️',
  },
  85: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snowShowers',
    text: { it: 'Rovesci di neve leggeri', en: 'Slight snow showers', de: 'Leichte Schneeschauer', fr: 'Averses de neige légères' },
    emoji: '🌨️',
  },
  86: {
    icon: CloudSnow,
    i18nKey: 'morning.weather.snowShowers',
    text: { it: 'Rovesci di neve intensi', en: 'Heavy snow showers', de: 'Starke Schneeschauer', fr: 'Averses de neige fortes' },
    emoji: '❄️',
  },
  95: {
    icon: CloudLightning,
    i18nKey: 'morning.weather.thunderstorm',
    text: { it: 'Temporale', en: 'Thunderstorm', de: 'Gewitter', fr: 'Orage' },
    emoji: '⛈️',
  },
  96: {
    icon: CloudHail,
    i18nKey: 'morning.weather.thunderstorm',
    text: { it: 'Temporale con grandine leggera', en: 'Thunderstorm with slight hail', de: 'Gewitter mit leichtem Hagel', fr: 'Orage avec grêle légère' },
    emoji: '⛈️',
  },
  99: {
    icon: CloudHail,
    i18nKey: 'morning.weather.thunderstorm',
    text: { it: 'Temporale con grandine intensa', en: 'Thunderstorm with heavy hail', de: 'Gewitter mit starkem Hagel', fr: 'Orage avec starkem Hagel' },
    emoji: '⛈️',
  },
};

const FALLBACK: WmoEntry = ENTRIES[0];

export type Locale = 'it' | 'en' | 'de' | 'fr';

export function entryFor(code: WmoCode): WmoEntry {
  return ENTRIES[code] ?? FALLBACK;
}

export function wmoIcon(code: WmoCode, isDay: boolean): LucideIcon {
  const e = entryFor(code);
  return !isDay && e.iconNight ? e.iconNight : e.icon;
}

export function wmoI18nKey(code: WmoCode): string {
  return entryFor(code).i18nKey;
}

export function wmoText(code: WmoCode, locale: Locale): string {
  return entryFor(code).text[locale];
}

export function wmoEmoji(code: WmoCode): string {
  return entryFor(code).emoji;
}

export function isKnownWmoCode(code: number): boolean {
  return code in ENTRIES;
}

export function allWmoCodes(): number[] {
  return Object.keys(ENTRIES).map(Number).sort((a, b) => a - b);
}
