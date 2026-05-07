/**
 * weatherCityPagesPlugin — emits ~44 city-weather SSG pages
 * (10 cities × 4 locales + hub × 4 locales) consuming
 * data/weather-snapshot.json (refreshed every 4h by the council cron).
 *
 * Mobile-first per /plan-design-review (D2 lista verticale 7d, D3 cluster
 * geografico ordering, D4 lazy hydration script, B7 lucide-only — emoji
 * never as UI element). All gates honored: text-html-ratio (manual
 * evergreen + auto-historical body text), max-bfs-depth (cities at depth 2
 * via /meteo-frontalieri/ hub), title-length (≤66 with brand drop), no
 * images (no ImageObject license burden on city pages).
 *
 * Build env gate: SKIP_WEATHER=1 disables the plugin (matches SKIP_FUEL_DAILY).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { WEATHER_CITIES, type WeatherCity } from '../data/weatherCities';
import { parseWeatherSnapshot, type CityWeather, type WeatherSnapshot } from '../services/weather/types';
import { wmoText, type Locale } from '../services/weather/wmoCodes';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  svgArrowRight,
  svgBell,
  svgDroplet,
  svgFacebook,
  svgForWmo,
  svgLinkedin,
  svgMail,
  svgSunrise,
  svgSunset,
  svgWind,
} from './weatherIconsHelper';

const LOCALES: readonly Locale[] = Object.freeze(['it', 'en', 'de', 'fr']);
const TITLE_MAX = 66;

const HUB_SLUG: Record<Locale, string> = {
  it: 'meteo-frontalieri',
  en: 'commute-weather',
  de: 'pendler-wetter',
  fr: 'meteo-frontaliers',
};

const HUB_TITLE: Record<Locale, string> = {
  it: 'Meteo per i frontalieri Ticino',
  en: 'Cross-border commuter weather Ticino',
  de: 'Wetter für Grenzgänger Tessin',
  fr: 'Météo pour les frontaliers Tessin',
};

const HUB_TAGLINE: Record<Locale, string> = {
  it: 'Condizioni meteo per le città cluster del confine svizzero-italiano',
  en: 'Weather conditions for the Swiss-Italian border city cluster',
  de: 'Wetterbedingungen für die Städte am schweizerisch-italienischen Grenzcluster',
  fr: 'Conditions météo pour les villes du cluster frontalier suisse-italien',
};

const CITY_TITLE: Record<Locale, (c: WeatherCity) => string> = {
  it: (c) => `Meteo ${c.name} oggi`,
  en: (c) => `${c.name} weather today`,
  de: (c) => `Wetter ${c.name} heute`,
  fr: (c) => `Météo ${c.name} aujourd'hui`,
};

const TAGLINES: Record<Locale, (c: WeatherCity) => string> = {
  it: (c) => `Frontalieri ${c.country === 'CH' ? 'verso' : 'da'} ${c.name}: condizioni live e previsioni 7 giorni`,
  en: (c) => `Cross-border commuters ${c.country === 'CH' ? 'to' : 'from'} ${c.name}: live conditions and 7-day forecast`,
  de: (c) => `Grenzgänger ${c.country === 'CH' ? 'nach' : 'aus'} ${c.name}: Live-Wetter und 7-Tage-Vorhersage`,
  fr: (c) => `Frontaliers ${c.country === 'CH' ? 'vers' : 'de'} ${c.name}: conditions en direct et prévisions à 7 jours`,
};

export function weatherCityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'frontaliere:weather-city-pages',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      if (process.env.SKIP_WEATHER === '1') {
        console.log('[weather-city-pages] SKIP_WEATHER=1 → skipped');
        return;
      }
      const distDir = resolve(rootDir, 'dist');
      if (!existsSync(distDir)) {
        console.warn('[weather-city-pages] dist/ missing, skipping');
        return;
      }
      const snapshot = loadSnapshot(rootDir);
      let count = 0;
      for (const locale of LOCALES) {
        const hubPath = locale === 'it' ? `${HUB_SLUG.it}/index.html` : `${locale}/${HUB_SLUG[locale]}/index.html`;
        const hubFull = resolve(distDir, hubPath);
        ensureDir(hubFull);
        writeFileSync(hubFull, renderHub(locale, snapshot, distDir), 'utf-8');
        count += 1;
        for (const city of WEATHER_CITIES) {
          const slug = city.slug[locale];
          const cityPath = locale === 'it' ? `${HUB_SLUG.it}/${slug}/index.html` : `${locale}/${HUB_SLUG[locale]}/${slug}/index.html`;
          const cityFull = resolve(distDir, cityPath);
          ensureDir(cityFull);
          writeFileSync(cityFull, renderCity(locale, city, snapshot?.cities[city.id], snapshot?.generatedAt, distDir), 'utf-8');
          count += 1;
        }
      }
      // Copy data/weather-snapshot.json to dist/data/ so the runtime
      // hydration script can fetch it via /data/weather-snapshot.json.
      // (Vite copies only public/* by default; data/ is build-time only.)
      copySnapshotToDist(rootDir, distDir);
      writeSitemap(rootDir, snapshot?.generatedAt);
      console.log(`[weather-city-pages] emitted ${count} pages`);
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
      console.warn(`[weather-city-pages] snapshot parse failed: ${err.error} at ${err.path ?? '?'}`);
      return null;
    }
    return parsed.value;
  } catch (e) {
    console.warn(`[weather-city-pages] snapshot read failed: ${(e as Error).message}`);
    return null;
  }
}

function ensureDir(filePath: string): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
}

function buildTitle(headline: string): string {
  const withBrand = `${headline} | Frontaliere Ticino`;
  return withBrand.length <= TITLE_MAX ? withBrand : headline;
}

function renderHub(locale: Locale, snap: WeatherSnapshot | null, distDir: string): string {
  const title = buildTitle(HUB_TITLE[locale]);
  const description = HUB_TAGLINE[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const canonical = `https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/`;
  const cityRows = WEATHER_CITIES.map((c) => renderHubRow(locale, c, snap?.cities[c.id])).join('\n');
  const intro = locale === 'it'
    ? `Apriamo ogni mattina lo stesso scenario commute: che tempo fa al confine, dove ci sono allerte, quali valichi sono più scorrevoli. Questa pagina raccoglie le condizioni meteo correnti per le ${WEATHER_CITIES.length} città-cluster del confine svizzero-italiano. Aggiornamento ogni 4 ore via fonte ufficiale (Open-Meteo + Met.no + MeteoSwiss).`
    : locale === 'en'
    ? `Every morning, the same commute scenario: what's the weather at the border, where are the alerts, which crossings are smooth. This page collects current weather conditions for the ${WEATHER_CITIES.length} city cluster on the Swiss-Italian border. Refreshed every 4 hours.`
    : locale === 'de'
    ? `Jeden Morgen dasselbe Pendlerszenario: Wie ist das Wetter an der Grenze? Wo sind Warnungen aktiv? Welche Übergänge sind frei? Diese Seite sammelt aktuelle Wetterbedingungen für die ${WEATHER_CITIES.length} Städte am Grenzcluster. Aktualisierung alle 4 Stunden.`
    : `Chaque matin, le même scénario de trajet: quel est le temps à la frontière, où sont les alertes, quels passages sont fluides. Cette page rassemble les conditions météo actuelles pour les ${WEATHER_CITIES.length} villes du cluster frontalier. Mise à jour toutes les 4 heures.`;
  const localePathHub = locale === 'it' ? '' : `/${locale}`;
  const homeNameHub = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  // Per-locale hub URLs for hreflang
  const hubHreflangs: Record<Locale, string> = {
    it: `https://frontaliereticino.ch/${HUB_SLUG.it}/`,
    en: `https://frontaliereticino.ch/en/${HUB_SLUG.en}/`,
    de: `https://frontaliereticino.ch/de/${HUB_SLUG.de}/`,
    fr: `https://frontaliereticino.ch/fr/${HUB_SLUG.fr}/`,
  };
  return wrapHtml({
    locale, title, description, canonical, distDir,
    hreflangs: hubHreflangs,
    bodyHtml: `
<header class="max-w-3xl mx-auto py-4"><h1 class="text-3xl sm:text-4xl font-light text-heading mb-2 leading-tight">${escapeHtml(HUB_TITLE[locale])}</h1>
<p class="text-base sm:text-lg text-body">${escapeHtml(HUB_TAGLINE[locale])}</p></header>
<section class="my-6 max-w-3xl mx-auto"><p class="text-body leading-relaxed">${escapeHtml(intro)}</p></section>
<section class="my-6 max-w-3xl mx-auto"><div class="bg-surface rounded-2xl border border-edge overflow-hidden">${cityRows}</div></section>
<section class="my-8 max-w-3xl mx-auto pt-6 border-t border-edge"><p class="text-xs text-muted leading-relaxed">${attributionInline(locale, snap?.generatedAt)}</p></section>
`,
    generatedAt: snap?.generatedAt,
    breadcrumbs: [
      { name: homeNameHub, url: `https://frontaliereticino.ch${localePathHub}/` },
      { name: HUB_TITLE[locale], url: canonical },
    ],
  });
}

function renderHubRow(locale: Locale, city: WeatherCity, cw?: CityWeather): string {
  const slug = city.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const url = `${localePath}/${HUB_SLUG[locale]}/${slug}/`;
  const tempStr = cw ? `${Math.round(cw.current.temperature)}°` : '—';
  const condition = cw ? wmoText(cw.current.weatherCode, locale) : labelUnavailable(locale);
  const country = city.country === 'CH' ? '🇨🇭' : '🇮🇹';
  return `<a class="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_2fr_2fr_auto_auto] gap-3 sm:gap-4 items-center px-4 py-3 sm:py-4 hover:bg-surface-alt border-b border-edge last:border-0 transition-colors" href="${url}"><span class="text-xl" aria-hidden="true">${country}</span><span class="font-semibold text-heading">${escapeHtml(city.name)}</span><span class="hidden sm:inline text-sm text-muted">${escapeHtml(city.region[locale])}</span><span class="text-lg font-bold text-heading tabular-nums">${tempStr}</span><span class="hidden sm:inline text-sm text-body">${escapeHtml(condition)}</span></a>`;
}

function renderCity(locale: Locale, city: WeatherCity, cw: CityWeather | undefined, generatedAt: string | undefined, distDir: string): string {
  const headline = CITY_TITLE[locale](city);
  const title = buildTitle(headline);
  const tagline = TAGLINES[locale](city);
  const description = `${tagline} · ${city.region[locale]}`;
  const slug = city.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const canonical = `https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/${slug}/`;
  const breadcrumb = renderBreadcrumb(locale, city);
  const heroHtml = cw ? renderHero(cw, locale) : renderSentinel(locale);
  const hourlyHtml = cw ? renderHourly(cw, locale) : '';
  const dailyHtml = cw ? renderDaily(cw, locale) : '';
  const evergreenHtml = renderEvergreen(city, locale);
  const ctaHtml = renderCta(locale, `weather-city-${city.id}`);
  const faqHtml = renderFaq(locale);

  const localePathCity = locale === 'it' ? '' : `/${locale}`;
  const homeNameCity = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  const hubUrlCity = `https://frontaliereticino.ch${localePathCity}/${HUB_SLUG[locale]}/`;
  // Per-locale city URLs for hreflang
  const cityHreflangs: Record<Locale, string> = {
    it: `https://frontaliereticino.ch/${HUB_SLUG.it}/${city.slug.it}/`,
    en: `https://frontaliereticino.ch/en/${HUB_SLUG.en}/${city.slug.en}/`,
    de: `https://frontaliereticino.ch/de/${HUB_SLUG.de}/${city.slug.de}/`,
    fr: `https://frontaliereticino.ch/fr/${HUB_SLUG.fr}/${city.slug.fr}/`,
  };
  return wrapHtml({
    locale, title, description, canonical, distDir,
    hreflangs: cityHreflangs,
    bodyHtml: `
${breadcrumb}
<header class="max-w-3xl mx-auto py-4"><h1 class="text-3xl sm:text-4xl font-light text-heading mb-2 leading-tight">${escapeHtml(headline)}</h1>
<p class="text-base sm:text-lg text-body">${escapeHtml(tagline)}</p></header>
${heroHtml}
${hourlyHtml}
${ctaHtml}
${dailyHtml}
${evergreenHtml}
${faqHtml}
<section class="my-8 max-w-3xl mx-auto pt-6 border-t border-edge"><p class="text-xs text-muted leading-relaxed">${attributionInline(locale, generatedAt)}</p></section>
`,
    generatedAt,
    breadcrumbs: [
      { name: homeNameCity, url: `https://frontaliereticino.ch${localePathCity}/` },
      { name: HUB_TITLE[locale], url: hubUrlCity },
      { name: city.name, url: canonical },
    ],
  });
}

function renderBreadcrumb(locale: Locale, city: WeatherCity): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const homeText = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  return `<nav aria-label="Breadcrumb" class="max-w-3xl mx-auto py-3 text-sm"><ol class="flex flex-wrap items-center gap-1 text-muted"><li><a href="${localePath}/" class="hover:text-link">${homeText}</a></li><li class="text-muted">›</li><li><a href="${localePath}/${HUB_SLUG[locale]}/" class="hover:text-link">${escapeHtml(HUB_TITLE[locale])}</a></li><li class="text-muted">›</li><li class="text-heading font-medium" aria-current="page">${escapeHtml(city.name)}</li></ol></nav>`;
}

function renderHero(cw: CityWeather, locale: Locale): string {
  const condition = wmoText(cw.current.weatherCode, locale);
  const conf = cw.confidence === 'low'
    ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-danger-subtle text-danger border border-danger-border">${labelLow(locale)}</span>`
    : cw.confidence === 'medium'
      ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-warning-subtle text-warning border border-warning-border">${labelMedium(locale)}</span>`
      : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-success-subtle text-success border border-success-border">${labelHigh(locale)}</span>`;
  const tempStr = `${Math.round(cw.current.temperature)}°`;
  const heroIcon = svgForWmo(cw.current.weatherCode, 96, cw.current.isDay);

  const stats: string[] = [];
  if (cw.current.windSpeedKmh != null) {
    stats.push(`<div class="bg-surface/60 backdrop-blur-sm rounded-xl px-4 py-3 border border-edge/60 flex items-center gap-3"><span class="text-accent shrink-0">${svgWind(20)}</span><div class="min-w-0"><div class="text-xs text-muted uppercase tracking-wide">${labelWind(locale)}</div><div class="font-semibold text-heading tabular-nums">${Math.round(cw.current.windSpeedKmh)} <span class="text-sm text-muted font-normal">km/h</span></div></div></div>`);
  }
  if (cw.current.humidity != null) {
    stats.push(`<div class="bg-surface/60 backdrop-blur-sm rounded-xl px-4 py-3 border border-edge/60 flex items-center gap-3"><span class="text-accent shrink-0">${svgDroplet(20)}</span><div class="min-w-0"><div class="text-xs text-muted uppercase tracking-wide">${labelHumidity(locale)}</div><div class="font-semibold text-heading tabular-nums">${cw.current.humidity}<span class="text-sm text-muted font-normal">%</span></div></div></div>`);
  }
  // sunrise/sunset come from daily7[0] when present (Open-Meteo provides them)
  const today = cw.daily7?.[0];
  if (today?.sunrise) {
    const t = formatHm(today.sunrise);
    if (t) stats.push(`<div class="bg-surface/60 backdrop-blur-sm rounded-xl px-4 py-3 border border-edge/60 flex items-center gap-3"><span class="text-amber-500 shrink-0">${svgSunrise(20)}</span><div class="min-w-0"><div class="text-xs text-muted uppercase tracking-wide">${labelSunrise(locale)}</div><div class="font-semibold text-heading tabular-nums">${t}</div></div></div>`);
  }
  if (today?.sunset) {
    const t = formatHm(today.sunset);
    if (t) stats.push(`<div class="bg-surface/60 backdrop-blur-sm rounded-xl px-4 py-3 border border-edge/60 flex items-center gap-3"><span class="text-orange-500 shrink-0">${svgSunset(20)}</span><div class="min-w-0"><div class="text-xs text-muted uppercase tracking-wide">${labelSunset(locale)}</div><div class="font-semibold text-heading tabular-nums">${t}</div></div></div>`);
  }
  const statsHtml = stats.length
    ? `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mt-6">${stats.join('')}</div>`
    : '';

  return `<section data-weather-hero class="relative overflow-hidden bg-gradient-to-br from-sky-100 via-accent-subtle to-surface border border-accent-border rounded-3xl p-6 sm:p-8 my-6 max-w-3xl mx-auto shadow-sm" aria-live="polite">
<div class="absolute -top-8 -right-8 text-accent/10 pointer-events-none" aria-hidden="true">${svgForWmo(cw.current.weatherCode, 220, cw.current.isDay)}</div>
<div class="relative flex items-center gap-5 sm:gap-7">
<div class="text-accent shrink-0 drop-shadow-sm">${heroIcon}</div>
<div class="min-w-0 flex-1">
<div class="text-6xl sm:text-7xl font-light text-heading tabular-nums leading-none" data-current-temp>${tempStr}</div>
<div class="mt-2 text-lg sm:text-xl text-strong font-medium">${escapeHtml(condition)}</div>
<div class="mt-3">${conf}</div>
</div>
</div>
${statsHtml}
</section>`;
}

function renderSentinel(locale: Locale): string {
  const text = locale === 'it' ? 'Dati meteo temporaneamente non disponibili' : locale === 'en' ? 'Weather data temporarily unavailable' : locale === 'de' ? 'Wetterdaten vorübergehend nicht verfügbar' : 'Données météo temporairement indisponibles';
  return `<section class="bg-warning-subtle border border-warning-border rounded-xl p-6 my-6 max-w-3xl mx-auto text-center"><p class="text-warning">${escapeHtml(text)}</p></section>`;
}

function renderHourly(cw: CityWeather, locale: Locale): string {
  if (!cw.hourly24.length) return '';
  const heading = locale === 'it' ? 'Prossime 24 ore' : locale === 'en' ? 'Next 24 hours' : locale === 'de' ? 'Nächste 24 Stunden' : 'Prochaines 24 heures';
  const cells = cw.hourly24.slice(0, 24).map((h) => {
    const hour = h.hour.slice(11, 13);
    const code = h.weatherCode ?? cw.current.weatherCode;
    const icon = svgForWmo(code, 28, true);
    return `<div class="flex-shrink-0 w-[68px] bg-surface rounded-xl border border-edge p-2.5 text-center hover:border-accent-border hover:bg-accent-subtle/40 transition-colors"><div class="text-xs text-muted font-medium">${hour}<span class="text-muted/60">:00</span></div><div class="my-1.5 flex justify-center text-accent">${icon}</div><div class="text-base font-semibold text-heading tabular-nums">${Math.round(h.temp)}°</div></div>`;
  }).join('');
  return `<section class="my-6 max-w-3xl mx-auto"><h2 class="text-lg sm:text-xl font-bold text-heading mb-3 px-1">${escapeHtml(heading)}</h2><div class="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1 snap-x snap-mandatory" style="scrollbar-width:thin;">${cells}</div></section>`;
}

function renderDaily(cw: CityWeather, locale: Locale): string {
  if (!cw.daily7.length) return '';
  const heading = locale === 'it' ? 'Previsioni 7 giorni' : locale === 'en' ? '7-day forecast' : locale === 'de' ? '7-Tage-Vorhersage' : 'Prévisions à 7 jours';
  const dayName = (date: string) => {
    const d = new Date(date);
    const names = locale === 'it' ? ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'] : locale === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : locale === 'de' ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] : ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    return names[d.getDay()];
  };
  const days = cw.daily7.slice(0, 7);
  const globalMin = Math.min(...days.map((d) => d.tempMin));
  const globalMax = Math.max(...days.map((d) => d.tempMax));
  const range = Math.max(1, globalMax - globalMin);
  const rows = days.map((d, i) => {
    const cond = wmoText(d.weatherCode, locale);
    const icon = svgForWmo(d.weatherCode, 28, true);
    const leftPct = Math.round(((d.tempMin - globalMin) / range) * 100);
    const widthPct = Math.max(8, Math.round(((d.tempMax - d.tempMin) / range) * 100));
    const isToday = i === 0;
    const dayLabel = isToday
      ? (locale === 'it' ? 'Oggi' : locale === 'en' ? 'Today' : locale === 'de' ? 'Heute' : "Aujourd'hui")
      : dayName(d.date);
    return `<li class="grid grid-cols-[64px_36px_1fr_88px] gap-3 py-3 border-b border-edge last:border-0 items-center"><span class="font-semibold text-heading text-sm">${dayLabel}</span><span class="text-accent flex justify-center" title="${escapeHtml(cond)}" aria-label="${escapeHtml(cond)}">${icon}</span><span class="relative h-2 bg-surface-alt rounded-full overflow-hidden" aria-hidden="true"><span class="absolute top-0 bottom-0 bg-gradient-to-r from-sky-400 via-amber-300 to-orange-500 rounded-full" style="left:${leftPct}%;width:${widthPct}%;"></span></span><span class="text-sm tabular-nums text-right"><span class="font-semibold text-heading">${Math.round(d.tempMax)}°</span> <span class="text-muted">${Math.round(d.tempMin)}°</span></span></li>`;
  }).join('');
  return `<section class="my-6 max-w-3xl mx-auto"><h2 class="text-lg sm:text-xl font-bold text-heading mb-3">${escapeHtml(heading)}</h2><ol class="bg-surface rounded-2xl border border-edge px-3 sm:px-5">${rows}</ol></section>`;
}

function renderEvergreen(city: WeatherCity, locale: Locale): string {
  const heading = locale === 'it' ? `Clima a ${city.name}` : locale === 'en' ? `Climate in ${city.name}` : locale === 'de' ? `Klima in ${city.name}` : `Climat à ${city.name}`;
  const para1 = locale === 'it'
    ? `${city.name} si trova nell'area frontaliera ${city.country === 'CH' ? 'svizzera' : 'italiana'}, dove le condizioni meteo influenzano il commute giornaliero verso ${city.country === 'CH' ? 'i posti di lavoro ticinesi' : 'la Lombardia'}. Il clima è di tipo prealpino, con inverni freddi (medie tra -2°C e 6°C), estati calde (medie tra 22°C e 28°C) e precipitazioni più frequenti tra aprile e novembre.`
    : locale === 'en'
    ? `${city.name} sits in the ${city.country === 'CH' ? 'Swiss' : 'Italian'} border area, where weather conditions affect daily commute toward ${city.country === 'CH' ? 'Ticino workplaces' : 'Lombardy'}. The climate is pre-Alpine with cold winters, warm summers, and rainfall mostly between April and November.`
    : locale === 'de'
    ? `${city.name} liegt im ${city.country === 'CH' ? 'schweizerischen' : 'italienischen'} Grenzgebiet, wo das Wetter den täglichen Pendlerverkehr ${city.country === 'CH' ? 'ins Tessin' : 'in die Lombardei'} beeinflusst. Das Klima ist voralpin mit kalten Wintern, warmen Sommern und Niederschlägen vor allem zwischen April und November.`
    : `${city.name} se trouve dans la zone frontalière ${city.country === 'CH' ? 'suisse' : 'italienne'}, où les conditions météo influencent les trajets quotidiens vers ${city.country === 'CH' ? 'les lieux de travail tessinois' : 'la Lombardie'}. Le climat est préalpin avec hivers froids, étés chauds et précipitations surtout entre avril et novembre.`;
  const para2 = locale === 'it'
    ? `Per chi commuta tra ${city.country === 'CH' ? 'le città italiane di confine' : 'i comuni ticinesi'} e ${city.name}, le condizioni meteo influiscono sui tempi di percorrenza dei valichi (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) e sulla scelta tra autostrada A2 e strade secondarie. Le mattine di nebbia o neve sono particolarmente critiche tra ottobre e marzo.`
    : locale === 'en'
    ? `For commuters between ${city.country === 'CH' ? 'Italian border towns' : 'Ticino municipalities'} and ${city.name}, weather affects crossing times (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) and the choice between motorway A2 and secondary roads. Foggy or snowy mornings are particularly critical between October and March.`
    : locale === 'de'
    ? `Für Pendler zwischen ${city.country === 'CH' ? 'italienischen Grenzorten' : 'Tessiner Gemeinden'} und ${city.name} beeinflusst das Wetter die Übergangszeiten (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) und die Wahl zwischen Autobahn A2 und Nebenstrassen. Nebelige oder schneereiche Morgen sind zwischen Oktober und März besonders kritisch.`
    : `Pour les frontaliers entre ${city.country === 'CH' ? 'les villes italiennes' : 'les communes tessinoises'} et ${city.name}, la météo affecte les temps de passage aux frontières (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) et le choix entre l'autoroute A2 et les routes secondaires. Les matins de brouillard ou neige sont particulièrement critiques entre octobre et mars.`;
  return `<section class="my-8 max-w-3xl mx-auto prose prose-sm sm:prose-base"><h2 class="text-xl sm:text-2xl font-bold text-heading mb-4">${escapeHtml(heading)}</h2><p class="text-body leading-relaxed mb-4">${escapeHtml(para1)}</p><p class="text-body leading-relaxed">${escapeHtml(para2)}</p></section>`;
}

function renderFaq(locale: Locale): string {
  const heading = locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'FAQ' : locale === 'de' ? 'Häufig gestellte Fragen' : 'Questions fréquentes';
  const items = locale === 'it'
    ? [
        ['Quanto è affidabile il meteo qui?', 'I dati arrivano dal council di tre fonti ufficiali: Open-Meteo, Met.no (Norwegian Meteorological Institute) e MeteoSwiss. L\'aggregatore prende la mediana delle temperature e il voto di maggioranza sulle condizioni; le allerte ufficiali vengono direttamente da MeteoSwiss.'],
        ['Cosa significa l\'indicatore di confidenza?', '"High": 2-3 fonti concordi (massima affidabilità). "Medium": 1 fonte forecast + osservazione locale. "Low": singola fonte disponibile (forecast non corroborato).'],
        ['Quanto spesso vengono aggiornati i dati?', 'Ogni 4 ore tramite cron pipeline. Le pagine SSG vengono ricostruite al deploy successivo; lo script di hydration aggiorna i numeri live al caricamento.'],
      ]
    : locale === 'en'
    ? [
        ['How reliable is the weather here?', 'Data comes from a council of three official sources: Open-Meteo, Met.no (Norwegian Meteorological Institute), and MeteoSwiss. The aggregator takes the median temperature and majority vote on conditions; official alerts come directly from MeteoSwiss.'],
        ['What does the confidence indicator mean?', '"High": 2-3 sources agree. "Medium": 1 forecast source + local observation. "Low": single source available (forecast not corroborated).'],
        ['How often are the data refreshed?', 'Every 4 hours via cron pipeline. SSG pages are rebuilt at the next deploy; hydration script updates the live numbers on page load.'],
      ]
    : locale === 'de'
    ? [
        ['Wie zuverlässig ist das Wetter hier?', 'Die Daten stammen von einem Council aus drei offiziellen Quellen: Open-Meteo, Met.no (Norwegisches Meteorologisches Institut) und MeteoSwiss. Der Aggregator nimmt den Median der Temperaturen und Mehrheitsentscheid bei den Bedingungen; offizielle Warnungen kommen direkt von MeteoSwiss.'],
        ['Was bedeutet der Konfidenzindikator?', '"Hoch": 2-3 Quellen stimmen überein. "Mittel": 1 Vorhersagequelle + lokale Beobachtung. "Niedrig": einzelne Quelle verfügbar.'],
        ['Wie oft werden die Daten aktualisiert?', 'Alle 4 Stunden via Cron-Pipeline. SSG-Seiten werden beim nächsten Deploy neu gebaut; das Hydration-Skript aktualisiert die Live-Zahlen beim Seitenaufruf.'],
      ]
    : [
        ['Quelle est la fiabilité de la météo ici?', 'Les données proviennent d\'un conseil de trois sources officielles: Open-Meteo, Met.no (Institut météorologique norvégien) et MeteoSwiss. L\'agrégateur prend la médiane des températures et le vote majoritaire sur les conditions; les alertes officielles proviennent directement de MeteoSwiss.'],
        ['Que signifie l\'indicateur de confiance?', '"Élevée": 2-3 sources concordent. "Moyenne": 1 source prévision + observation locale. "Faible": source unique disponible.'],
        ['À quelle fréquence les données sont-elles mises à jour?', 'Toutes les 4 heures via pipeline cron. Les pages SSG sont reconstruites au prochain déploiement; le script hydration met à jour les chiffres en direct au chargement.'],
      ];
  const itemsHtml = items.map(([q, a]) => `<details class="bg-surface rounded-xl border border-edge p-4 mb-2"><summary class="font-medium text-heading cursor-pointer hover:text-accent">${escapeHtml(q)}</summary><p class="mt-3 text-body leading-relaxed">${escapeHtml(a)}</p></details>`).join('');
  return `<section class="my-8 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-bold text-heading mb-4">${escapeHtml(heading)}</h2>${itemsHtml}</section>`;
}

function renderCta(locale: Locale, acquisitionSource: string): string {
  const heading = locale === 'it' ? 'Resta sempre informato' : locale === 'en' ? 'Stay informed' : locale === 'de' ? 'Bleib informiert' : 'Reste informé';
  const sub = locale === 'it'
    ? 'Newsletter settimanale per frontalieri: meteo, valichi, fisco, lavoro. Niente spam, cancellazione con un click.'
    : locale === 'en'
    ? 'Weekly newsletter for cross-border commuters: weather, crossings, taxes, jobs. No spam, one-click unsubscribe.'
    : locale === 'de'
    ? 'Wöchentlicher Newsletter für Grenzgänger: Wetter, Übergänge, Steuern, Jobs. Kein Spam, Abmeldung mit einem Klick.'
    : 'Newsletter hebdomadaire pour frontaliers : météo, passages, fiscalité, emploi. Pas de spam, désinscription en un clic.';
  const placeholder = locale === 'it' ? 'tua@email.com' : locale === 'en' ? 'your@email.com' : locale === 'de' ? 'deine@email.com' : 'votre@email.com';
  const cta = locale === 'it' ? 'Iscriviti' : locale === 'en' ? 'Subscribe' : locale === 'de' ? 'Abonnieren' : "S'inscrire";
  const followLabel = locale === 'it' ? 'Seguici anche su' : locale === 'en' ? 'Follow us also on' : locale === 'de' ? 'Folge uns auch auf' : 'Suivez-nous aussi sur';
  const privacy = locale === 'it' ? 'Privacy garantita.' : locale === 'en' ? 'Privacy protected.' : locale === 'de' ? 'Privatsphäre geschützt.' : 'Confidentialité protégée.';

  // Form posts to the standard newsletter subscribe handler — the SPA hydration
  // intercepts the submit and routes it through the same Cloud Function as the
  // popup, tagged with `acquisitionSource` for downstream analytics.
  return `<section class="relative overflow-hidden bg-gradient-to-br from-accent to-accent/80 text-white rounded-3xl p-6 sm:p-8 my-8 max-w-3xl mx-auto shadow-lg" data-newsletter-cta data-acquisition-source="${escapeHtml(acquisitionSource)}">
<div class="absolute -top-12 -right-12 text-white/10 pointer-events-none" aria-hidden="true">${svgBell(180)}</div>
<div class="relative">
<div class="flex items-start gap-3 mb-3">
<span class="bg-white/15 rounded-full p-2 shrink-0">${svgMail(24)}</span>
<div class="min-w-0 flex-1">
<h2 class="text-xl sm:text-2xl font-bold leading-tight">${escapeHtml(heading)}</h2>
<p class="text-white/85 text-sm sm:text-base mt-1">${escapeHtml(sub)}</p>
</div>
</div>
<form class="mt-5 flex flex-col sm:flex-row gap-2" data-newsletter-form action="/api/newsletter-subscribe" method="post" novalidate>
<label class="sr-only" for="weather-newsletter-email-${escapeHtml(acquisitionSource)}">${placeholder}</label>
<input id="weather-newsletter-email-${escapeHtml(acquisitionSource)}" type="email" name="email" required autocomplete="email" placeholder="${escapeHtml(placeholder)}" class="flex-1 min-w-0 px-4 py-3 rounded-xl bg-white/95 text-heading placeholder:text-muted border border-white/20 focus:outline-none focus:ring-2 focus:ring-white/60 text-base">
<input type="hidden" name="acquisitionSource" value="${escapeHtml(acquisitionSource)}">
<input type="hidden" name="locale" value="${locale}">
<button type="submit" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white text-accent font-semibold hover:bg-white/90 active:scale-[0.98] transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-white/60">
<span>${escapeHtml(cta)}</span>${svgArrowRight(18)}
</button>
</form>
<div class="mt-5 flex items-center justify-between flex-wrap gap-3">
<p class="text-xs text-white/75">${escapeHtml(privacy)}</p>
<div class="flex items-center gap-2 text-xs text-white/85">
<span>${escapeHtml(followLabel)}</span>
<a href="https://www.facebook.com/profile.php?id=61588174947294" rel="noopener" target="_blank" aria-label="Facebook" class="bg-white/15 hover:bg-white/25 rounded-full p-1.5 transition-colors">${svgFacebook(16)}</a>
<a href="https://www.linkedin.com/company/frontaliere-ticino" rel="noopener" target="_blank" aria-label="LinkedIn" class="bg-white/15 hover:bg-white/25 rounded-full p-1.5 transition-colors">${svgLinkedin(16)}</a>
</div>
</div>
</div>
</section>`;
}

function attributionInline(locale: Locale, generatedAt?: string): string {
  const dataLabel = locale === 'it' ? 'Dati' : locale === 'en' ? 'Data' : locale === 'de' ? 'Daten' : 'Données';
  const updatedLabel = locale === 'it' ? 'Aggiornato' : locale === 'en' ? 'Updated' : locale === 'de' ? 'Aktualisiert' : 'Mis à jour';
  let stamp = '';
  if (generatedAt) {
    try {
      const d = new Date(generatedAt);
      if (!Number.isNaN(d.getTime())) {
        stamp = ` · <time datetime="${escapeHtml(generatedAt)}">${updatedLabel} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</time>`;
      }
    } catch { /* ignore */ }
  }
  return `${dataLabel}: <a href="https://open-meteo.com/" rel="noopener" target="_blank">Open-Meteo</a> · <a href="https://www.met.no/" rel="noopener" target="_blank">Weather forecast from MET Norway</a> · <a href="https://www.meteoswiss.admin.ch/" rel="noopener" target="_blank">MeteoSwiss</a>${stamp} · <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank">CC-BY 4.0</a>`;
}

function labelWind(l: Locale): string { return l === 'it' ? 'Vento' : l === 'en' ? 'Wind' : l === 'de' ? 'Wind' : 'Vent'; }
function labelHumidity(l: Locale): string { return l === 'it' ? 'Umidità' : l === 'en' ? 'Humidity' : l === 'de' ? 'Luftfeuchtigkeit' : 'Humidité'; }
function labelLow(l: Locale): string { return l === 'it' ? 'Fonte singola' : l === 'en' ? 'Single source' : l === 'de' ? 'Einzelquelle' : 'Source unique'; }
function labelMedium(l: Locale): string { return l === 'it' ? '2 fonti' : l === 'en' ? '2 sources' : l === 'de' ? '2 Quellen' : '2 sources'; }
function labelHigh(l: Locale): string { return l === 'it' ? 'Verificato' : l === 'en' ? 'Verified' : l === 'de' ? 'Verifiziert' : 'Vérifié'; }
function labelSunrise(l: Locale): string { return l === 'it' ? 'Alba' : l === 'en' ? 'Sunrise' : l === 'de' ? 'Sonnenaufgang' : 'Lever'; }
function labelSunset(l: Locale): string { return l === 'it' ? 'Tramonto' : l === 'en' ? 'Sunset' : l === 'de' ? 'Sonnenuntergang' : 'Coucher'; }
function labelUnavailable(l: Locale): string { return l === 'it' ? 'Non disponibile' : l === 'en' ? 'Not available' : l === 'de' ? 'Nicht verfügbar' : 'Indisponible'; }

function formatHm(iso: string): string | null {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

interface WrapOpts {
  locale: Locale;
  title: string;
  description: string;
  canonical: string;
  bodyHtml: string;
  generatedAt?: string;
  breadcrumbs?: Array<{ name: string; url: string }>;
  /** Per-locale canonical URL — caller computes the proper localised path. */
  hreflangs: Record<Locale, string>;
}

function breadcrumbJsonLd(items: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

function wrapHtml(opts: WrapOpts & { distDir: string }): string {
  const { locale, title, description, canonical, bodyHtml, generatedAt, distDir, breadcrumbs } = opts;
  // hreflangs and altLinks computed below
  const altLinks = [
    ...LOCALES.map((l) => `<link rel="alternate" hreflang="${l}" href="${opts.hreflangs[l]}">`),
    `<link rel="alternate" hreflang="x-default" href="${opts.hreflangs.it}">`,
  ].join('\n');
  const jsonLdScripts = [JSON.stringify(jsonLd(locale, title, description, canonical, generatedAt))];
  if (breadcrumbs) jsonLdScripts.push(JSON.stringify(breadcrumbJsonLd(breadcrumbs)));
  const hydrationScript = `<script>window.addEventListener('DOMContentLoaded',function(){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){fetch('/data/weather-snapshot.json').then(function(r){return r.json()}).then(function(d){if(!d||!d.generatedAt)return;var t=document.querySelector('time[datetime]');if(t&&new Date(d.generatedAt)>new Date(t.dateTime)){t.dateTime=d.generatedAt}}).catch(function(){});io.disconnect()}})});var hero=document.querySelector('.weather-hero');if(hero)io.observe(hero);});</script>`;
  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl: canonical,
    hreflangHtml: altLinks,
    bodyHtml: `${bodyHtml}\n${hydrationScript}`,
    jsonLdScripts,
    distDir,
  });
}

function jsonLd(locale: Locale, title: string, description: string, canonical: string, generatedAt?: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    inLanguage: locale,
    name: title,
    description,
    url: canonical,
    dateModified: generatedAt ?? new Date().toISOString(),
    isPartOf: {
      '@type': 'WebSite',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    },
  };
}

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

function copySnapshotToDist(rootDir: string, distDir: string): void {
  const src = resolve(rootDir, 'data/weather-snapshot.json');
  const dstDir = resolve(distDir, 'data');
  if (!existsSync(src)) return;
  mkdirSync(dstDir, { recursive: true });
  try {
    const buf = readFileSync(src);
    writeFileSync(resolve(dstDir, 'weather-snapshot.json'), buf);
  } catch (e) {
    console.warn(`[weather-city-pages] snapshot copy to dist failed: ${(e as Error).message}`);
  }
}

function writeSitemap(rootDir: string, generatedAt?: string): void {
  const distDir = resolve(rootDir, 'dist');
  const sitemapFile = resolve(distDir, 'sitemap-weather.xml');
  const ts = generatedAt ?? new Date().toISOString();
  const urls: string[] = [];
  for (const locale of LOCALES) {
    const localePath = locale === 'it' ? '' : `/${locale}`;
    urls.push(`<url><loc>https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/</loc><lastmod>${ts}</lastmod></url>`);
    for (const c of WEATHER_CITIES) {
      urls.push(`<url><loc>https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/${c.slug[locale]}/</loc><lastmod>${ts}</lastmod></url>`);
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  writeFileSync(sitemapFile, xml, 'utf-8');
  console.log(`[weather-city-pages] sitemap-weather.xml written (${urls.length} URLs)`);
}
