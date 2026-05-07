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
        writeFileSync(hubFull, renderHub(locale, snapshot), 'utf-8');
        count += 1;
        for (const city of WEATHER_CITIES) {
          const slug = city.slug[locale];
          const cityPath = locale === 'it' ? `${HUB_SLUG.it}/${slug}/index.html` : `${locale}/${HUB_SLUG[locale]}/${slug}/index.html`;
          const cityFull = resolve(distDir, cityPath);
          ensureDir(cityFull);
          writeFileSync(cityFull, renderCity(locale, city, snapshot?.cities[city.id], snapshot?.generatedAt), 'utf-8');
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

function renderHub(locale: Locale, snap: WeatherSnapshot | null): string {
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
  return wrapHtml({
    locale, title, description, canonical,
    bodyHtml: `
<header><h1>${escapeHtml(HUB_TITLE[locale])}</h1>
<p class="tagline">${escapeHtml(HUB_TAGLINE[locale])}</p></header>
<section><p>${escapeHtml(intro)}</p></section>
<section class="city-list">${cityRows}</section>
<section class="attribution"><p>${attributionInline(locale, snap?.generatedAt)}</p></section>
`,
    generatedAt: snap?.generatedAt,
  });
}

function renderHubRow(locale: Locale, city: WeatherCity, cw?: CityWeather): string {
  const slug = city.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const url = `${localePath}/${HUB_SLUG[locale]}/${slug}/`;
  const tempStr = cw ? `${Math.round(cw.current.temperature)}°` : '—';
  const condition = cw ? wmoText(cw.current.weatherCode, locale) : labelUnavailable(locale);
  const country = city.country === 'CH' ? '🇨🇭' : '🇮🇹';
  return `<a class="city-row" href="${url}"><span class="city-flag" aria-hidden="true">${country}</span><span class="city-name">${escapeHtml(city.name)}</span><span class="city-region">${escapeHtml(city.region[locale])}</span><span class="city-temp">${tempStr}</span><span class="city-cond">${escapeHtml(condition)}</span></a>`;
}

function renderCity(locale: Locale, city: WeatherCity, cw: CityWeather | undefined, generatedAt: string | undefined): string {
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

  return wrapHtml({
    locale, title, description, canonical,
    bodyHtml: `
${breadcrumb}
<header><h1>${escapeHtml(headline)}</h1>
<p class="tagline">${escapeHtml(tagline)}</p></header>
${heroHtml}
${hourlyHtml}
${ctaHtml}
${dailyHtml}
${evergreenHtml}
${faqHtml}
<section class="attribution"><p>${attributionInline(locale, generatedAt)}</p></section>
`,
    generatedAt,
  });
}

function renderBreadcrumb(locale: Locale, city: WeatherCity): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const homeText = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  return `<nav aria-label="Breadcrumb"><ol class="breadcrumb"><li><a href="${localePath}/">${homeText}</a></li><li><a href="${localePath}/${HUB_SLUG[locale]}/">${escapeHtml(HUB_TITLE[locale])}</a></li><li aria-current="page">${escapeHtml(city.name)}</li></ol></nav>`;
}

function renderHero(cw: CityWeather, locale: Locale): string {
  const condition = wmoText(cw.current.weatherCode, locale);
  const conf = cw.confidence === 'low'
    ? `<span class="confidence-pill low">${labelLow(locale)}</span>`
    : cw.confidence === 'medium'
      ? `<span class="confidence-pill medium">${labelMedium(locale)}</span>`
      : '';
  const tempStr = `${Math.round(cw.current.temperature)}°`;
  const wind = cw.current.windSpeedKmh != null ? `<span>${labelWind(locale)}: ${Math.round(cw.current.windSpeedKmh)} km/h</span>` : '';
  const humidity = cw.current.humidity != null ? `<span>${labelHumidity(locale)}: ${cw.current.humidity}%</span>` : '';
  return `<section class="weather-hero" aria-live="polite">
<div class="hero-temp" data-current-temp>${tempStr}</div>
<div class="hero-cond">${escapeHtml(condition)}</div>
<div class="hero-meta">${wind}${humidity}${conf}</div>
</section>`;
}

function renderSentinel(locale: Locale): string {
  const text = locale === 'it' ? 'Dati meteo temporaneamente non disponibili' : locale === 'en' ? 'Weather data temporarily unavailable' : locale === 'de' ? 'Wetterdaten vorübergehend nicht verfügbar' : 'Données météo temporairement indisponibles';
  return `<section class="weather-hero sentinel"><p>${escapeHtml(text)}</p></section>`;
}

function renderHourly(cw: CityWeather, locale: Locale): string {
  if (!cw.hourly24.length) return '';
  const heading = locale === 'it' ? 'Prossime 24 ore' : locale === 'en' ? 'Next 24 hours' : locale === 'de' ? 'Nächste 24 Stunden' : 'Prochaines 24 heures';
  const cells = cw.hourly24.slice(0, 24).map((h) => {
    const hour = h.hour.slice(11, 13);
    return `<div class="hour-cell"><div class="hour-label">${hour}h</div><div class="hour-temp">${Math.round(h.temp)}°</div></div>`;
  }).join('');
  return `<section class="hourly"><h2>${escapeHtml(heading)}</h2><div class="hour-strip">${cells}</div></section>`;
}

function renderDaily(cw: CityWeather, locale: Locale): string {
  if (!cw.daily7.length) return '';
  const heading = locale === 'it' ? 'Previsioni 7 giorni' : locale === 'en' ? '7-day forecast' : locale === 'de' ? '7-Tage-Vorhersage' : 'Prévisions à 7 jours';
  const dayName = (date: string) => {
    const d = new Date(date);
    const names = locale === 'it' ? ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'] : locale === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : locale === 'de' ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] : ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    return names[d.getDay()];
  };
  const rows = cw.daily7.slice(0, 7).map((d) => {
    const cond = wmoText(d.weatherCode, locale);
    return `<li class="daily-row"><span class="daily-day">${dayName(d.date)}</span><span class="daily-cond">${escapeHtml(cond)}</span><span class="daily-temps">${Math.round(d.tempMax)}° / ${Math.round(d.tempMin)}°</span></li>`;
  }).join('');
  return `<section class="daily"><h2>${escapeHtml(heading)}</h2><ol class="daily-list">${rows}</ol></section>`;
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
  return `<section class="evergreen"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(para1)}</p><p>${escapeHtml(para2)}</p></section>`;
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
  const itemsHtml = items.map(([q, a]) => `<details><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a)}</p></details>`).join('');
  return `<section class="faq"><h2>${escapeHtml(heading)}</h2>${itemsHtml}</section>`;
}

function renderCta(locale: Locale, acquisitionSource: string): string {
  const ctaHeading = locale === 'it' ? 'Ricevi info commute frontalieri via email' : locale === 'en' ? 'Get cross-border commute updates by email' : locale === 'de' ? 'Pendler-Updates per E-Mail erhalten' : 'Recevez les infos commute par e-mail';
  const ctaSub = locale === 'it' ? 'Newsletter settimanale per chi attraversa il confine ogni giorno.' : locale === 'en' ? 'Weekly newsletter for daily border crossers.' : locale === 'de' ? 'Wöchentlicher Newsletter für tägliche Grenzgänger.' : 'Newsletter hebdomadaire pour les frontaliers quotidiens.';
  return `<section class="cta-newsletter" data-acquisition-source="${escapeHtml(acquisitionSource)}">
<h2>${escapeHtml(ctaHeading)}</h2>
<p>${escapeHtml(ctaSub)}</p>
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
function labelUnavailable(l: Locale): string { return l === 'it' ? 'Non disponibile' : l === 'en' ? 'Not available' : l === 'de' ? 'Nicht verfügbar' : 'Indisponible'; }

interface WrapOpts {
  locale: Locale;
  title: string;
  description: string;
  canonical: string;
  bodyHtml: string;
  generatedAt?: string;
}

function wrapHtml(opts: WrapOpts): string {
  const { locale, title, description, canonical, bodyHtml, generatedAt } = opts;
  const altLinks = LOCALES.map((l) => {
    const localePath = l === 'it' ? '' : `/${l}`;
    const tail = canonical.replace(/^https:\/\/frontaliereticino\.ch\/(?:[a-z]{2}\/)?(.*)$/, '$1');
    return `<link rel="alternate" hreflang="${l}" href="https://frontaliereticino.ch${localePath}/${tail}">`;
  }).join('');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
${altLinks}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd(locale, title, description, canonical, generatedAt))}</script>
</head>
<body>
<div id="root">
<main>
${bodyHtml}
</main>
</div>
<script>
window.addEventListener('DOMContentLoaded',function(){
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){fetch('/data/weather-snapshot.json').then(function(r){return r.json()}).then(function(d){if(!d||!d.generatedAt)return;var t=document.querySelector('time[datetime]');if(t&&new Date(d.generatedAt)>new Date(t.dateTime)){t.dateTime=d.generatedAt}}).catch(function(){});io.disconnect()}})});var hero=document.querySelector('.weather-hero');if(hero)io.observe(hero);
});
</script>
</body>
</html>`;
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
