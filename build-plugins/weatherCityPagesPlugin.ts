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
  colorForWmo,
  iconSprite,
  useDroplet,
  useForWmo,
  useSunrise,
  useSunset,
  useWind,
} from './weatherIconsHelper';

/**
 * Closest border crossings (valichi) by city — frontalieri context: the page
 * exists for commute decisions, so under the hero we show the nearest valico
 * page so the user can jump from "weather Lugano" to "wait time Brogeda" in
 * one click. Slugs match the F8 production routes (chiasso-brogeda, etc.).
 */
const NEAREST_VALICHI: Record<string, Array<{ slug: string; name: string }>> = {
  lugano: [{ slug: 'chiasso-brogeda', name: 'Chiasso-Brogeda' }, { slug: 'oria-gandria', name: 'Gandria' }],
  bellinzona: [{ slug: 'chiasso-brogeda', name: 'Chiasso-Brogeda' }],
  mendrisio: [{ slug: 'rodero-stabio', name: 'Stabio' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  locarno: [{ slug: 'ponte-tresa', name: 'Ponte Tresa' }],
  chiasso: [{ slug: 'chiasso-brogeda', name: 'Brogeda' }],
  como: [{ slug: 'chiasso-brogeda', name: 'Brogeda' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  varese: [{ slug: 'rodero-stabio', name: 'Stabio' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  lecco: [{ slug: 'oria-gandria', name: 'Gandria' }],
};

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
  const methodology = renderHubMethodology(locale);
  const climateNotes = renderHubClimateNotes(locale);
  const ctaHtml = renderCta(locale, 'weather-hub');
  return wrapHtml({
    locale, title, description, canonical, distDir,
    hreflangs: hubHreflangs,
    bodyHtml: `
${weatherFontsAndStyle()}
${iconSprite()}
<div data-weather-page>
<header class="max-w-4xl mx-auto pt-2 pb-1 px-1"><h1 class="text-4xl sm:text-5xl font-medium text-heading mb-2 leading-tight tracking-tight" style="font-family:var(--font-display,inherit);">${escapeHtml(HUB_TITLE[locale])}</h1>
<p class="text-base sm:text-lg text-body max-w-2xl">${escapeHtml(HUB_TAGLINE[locale])}</p></header>
<section class="my-6 max-w-3xl mx-auto"><p class="text-body leading-relaxed">${escapeHtml(intro)}</p></section>
<section class="my-6 max-w-3xl mx-auto"><ul class="bg-white rounded-2xl border border-edge overflow-hidden divide-y divide-edge">${cityRows}</ul></section>
${ctaHtml}
${climateNotes}
${methodology}
<section class="my-10 max-w-2xl mx-auto pt-6 border-t border-edge"><p class="text-xs text-subtle leading-relaxed">${attributionInline(locale, snap?.generatedAt)}</p></section>
</div>
`,
    generatedAt: snap?.generatedAt,
    breadcrumbs: [
      { name: homeNameHub, url: `https://frontaliereticino.ch${localePathHub}/` },
      { name: HUB_TITLE[locale], url: canonical },
    ],
  });
}

/**
 * Climate context block on hub — adds substantive prose so hub pages stay
 * above the 10 % text-to-HTML ratio threshold (the city table consumes
 * lots of HTML mass for short text rows). Frontaliere-relevant: explains
 * the climate gradient between Ticino and Lombardia at the border.
 */
function renderHubClimateNotes(locale: Locale): string {
  const heading = locale === 'it' ? 'Il microclima del confine'
    : locale === 'en' ? 'The border microclimate'
    : locale === 'de' ? 'Das Grenz-Mikroklima'
    : 'Le microclimat frontalier';
  const text = locale === 'it'
    ? `Il cluster di città-frontaliere si distribuisce su una fascia di 50 km tra il Sopraceneri (Bellinzona, Locarno) e la pianura padana (Como, Varese, Lecco), attraversando un microclima prealpino con tre regimi distinti. Il versante ticinese del Ceresio (Lugano, Mendrisio, Chiasso) gode di un'estate mediterranea-attenuata con 22-28°C medi e precipitazioni concentrate tra aprile e novembre; gli inverni sono freddi ma raramente sotto -2°C grazie all'effetto-lago. La fascia italiana sotto Como invece, esposta alle correnti padane, vede inversione termica frequente in inverno (nebbia tra novembre e febbraio) e ondate di calore più intense in estate (fino a 35°C ad agosto). Il Sopraceneri, infine, ha clima più alpino: piogge intense in primavera/autunno, neve sotto i 600 m circa 8-12 volte all'anno, escursione termica giornaliera maggiore. Per il commute frontaliere, le condizioni del versante CH precedono di 1-3 ore quelle del versante IT (correnti da nord), quindi il bollettino di Lugano serve da preavviso per Como/Varese.`
    : locale === 'en'
    ? `The frontaliere city cluster spans a 50 km strip from the Sopraceneri (Bellinzona, Locarno) to the Po plain (Como, Varese, Lecco), crossing a pre-Alpine microclimate with three distinct regimes. The Ticino side of the Ceresio (Lugano, Mendrisio, Chiasso) enjoys an attenuated Mediterranean summer with 22-28 °C means and rainfall concentrated April through November; winters are cold but rarely below -2 °C thanks to the lake effect. The Italian strip below Como, exposed to Po-plain currents, sees frequent winter thermal inversion (fog November-February) and more intense summer heat waves (up to 35 °C in August). The Sopraceneri runs more alpine: heavy rain in spring/autumn, snow below 600 m roughly 8-12 times a year, larger daily thermal range. For the frontaliere commute, conditions on the CH side precede the IT side by 1-3 hours (northerly currents), so the Lugano bulletin doubles as an early warning for Como and Varese.`
    : locale === 'de'
    ? `Das Cluster der Grenzgängerstädte erstreckt sich über einen 50 km breiten Streifen vom Sopraceneri (Bellinzona, Locarno) bis zur Poebene (Como, Varese, Lecco) und durchquert ein voralpines Mikroklima mit drei unterschiedlichen Regimen. Die Tessiner Seite des Ceresio (Lugano, Mendrisio, Chiasso) geniesst einen abgeschwächten mediterranen Sommer mit Mittelwerten von 22-28 °C und Niederschlägen konzentriert von April bis November; Winter sind kalt, aber dank Seeeffekt selten unter -2 °C. Der italienische Streifen unter Como hingegen, den Po-Ebene-Strömungen ausgesetzt, erlebt häufige Winter-Inversionswetterlagen (Nebel von November bis Februar) und intensivere Sommerhitzewellen (bis 35 °C im August). Das Sopraceneri zeigt sich alpiner: Starkregen im Frühling/Herbst, Schnee unter 600 m etwa 8-12 Mal pro Jahr, grössere Tagesschwankungen. Für den Pendlerverkehr eilt die CH-Seite der IT-Seite um 1-3 Stunden voraus (Nordströmungen), so dass das Lugano-Bulletin als Frühwarnung für Como und Varese dient.`
    : `Le cluster des villes frontalières s'étend sur une bande de 50 km, du Sopraceneri (Bellinzone, Locarno) à la plaine du Pô (Côme, Varèse, Lecco), traversant un microclimat préalpin à trois régimes distincts. Le versant tessinois du Ceresio (Lugano, Mendrisio, Chiasso) profite d'un été méditerranéen atténué (22-28 °C en moyenne) avec des précipitations concentrées d'avril à novembre ; les hivers sont froids mais rarement sous -2 °C grâce à l'effet-lac. La bande italienne sous Côme, exposée aux courants du Pô, connaît une inversion thermique fréquente en hiver (brouillard de novembre à février) et des vagues de chaleur estivales plus intenses (jusqu'à 35 °C en août). Le Sopraceneri reste plus alpin : pluies intenses au printemps/automne, neige sous 600 m environ 8-12 fois par an, amplitude diurne plus large. Pour le trajet frontalier, les conditions du versant CH précèdent celles du versant IT de 1 à 3 heures (courants nord), donc le bulletin de Lugano sert d'alerte précoce pour Côme et Varèse.`;
  return `<section class="my-8 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-bold text-heading mb-3">${escapeHtml(heading)}</h2><p class="text-body leading-relaxed">${escapeHtml(text)}</p></section>`;
}

function renderHubMethodology(locale: Locale): string {
  const heading = locale === 'it' ? 'Come selezioniamo le città del cluster'
    : locale === 'en' ? 'How we picked the cluster cities'
    : locale === 'de' ? 'Wie wir die Cluster-Städte auswählen'
    : 'Comment nous sélectionnons les villes du cluster';
  const text = locale === 'it'
    ? `Le ${WEATHER_CITIES.length} città di questo hub sono state selezionate sulla base di tre criteri concreti per il commute frontaliere: prossimità a un valico (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) entro 30 km, presenza di posti di lavoro o residenza per oltre 1.000 frontalieri secondo i dati 2024 della Sezione del lavoro del Canton Ticino e dell'INPS, e copertura osservativa SwissMetNet (lato CH) o ARPA Lombardia (lato IT). Bellinzona e Locarno entrano nel cluster perché molti frontalieri ticinesi commutano verso il Sopraceneri pur risiedendo in Italia (effetto inverso del flusso storico); Lecco è incluso per i pendolari che usano la SS36 verso il Cantone Grigioni via Chiavenna. Per ogni città mostriamo la temperatura aggregata da 2-3 fonti (mediana, non media), il codice condizione meteo WMO 4677 più frequentemente votato e l'eventuale allerta MeteoSwiss attiva sulla regione di pertinenza.`
    : locale === 'en'
    ? `The ${WEATHER_CITIES.length} cities in this hub were picked using three concrete criteria for cross-border commute: proximity to a border crossing (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) within 30 km, presence of jobs or residence for over 1,000 frontalieri per 2024 data from the Ticino cantonal labour office and Italian INPS, and observational coverage by SwissMetNet (CH side) or ARPA Lombardia (IT side). Bellinzona and Locarno are in the cluster because many Ticino frontalieri commute toward the Sopraceneri while residing in Italy (reversed flow from historical pattern); Lecco is included for commuters using the SS36 toward Grisons via Chiavenna. For each city we show the temperature aggregated from 2-3 sources (median, not average), the most-voted WMO 4677 weather code, and any active MeteoSwiss alert covering the relevant region.`
    : locale === 'de'
    ? `Die ${WEATHER_CITIES.length} Städte in diesem Hub wurden anhand von drei konkreten Kriterien für den Grenzgängerverkehr ausgewählt: Nähe zu einem Grenzübergang (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) innerhalb von 30 km, Vorhandensein von Arbeitsplätzen oder Wohnsitz für über 1.000 Grenzgänger gemäss Daten 2024 der Tessiner Sektion für Arbeit und der italienischen INPS, sowie Beobachtungsabdeckung durch SwissMetNet (CH-Seite) oder ARPA Lombardia (IT-Seite). Bellinzona und Locarno gehören zum Cluster, weil viele Tessiner Grenzgänger ins Sopraceneri pendeln, obwohl sie in Italien wohnen (umgekehrter Strom des historischen Musters); Lecco ist für Pendler einbezogen, die die SS36 Richtung Graubünden über Chiavenna nutzen. Für jede Stadt zeigen wir die aus 2-3 Quellen aggregierte Temperatur (Median, nicht Mittelwert), den am häufigsten gewählten WMO-4677-Wettercode und allfällige aktive MeteoSwiss-Warnungen über der zuständigen Region.`
    : `Les ${WEATHER_CITIES.length} villes de ce hub ont été choisies selon trois critères concrets pour le trajet frontalier : proximité d'un passage frontalier (Brogeda, Stabio, Gandria, Ponte Tresa, Gaggiolo) dans un rayon de 30 km, présence d'emplois ou de résidence pour plus de 1 000 frontaliers selon les données 2024 de la Section du travail du Canton du Tessin et de l'INPS italien, et couverture d'observations par SwissMetNet (côté CH) ou ARPA Lombardia (côté IT). Bellinzona et Locarno entrent dans le cluster car de nombreux frontaliers tessinois font la navette vers le Sopraceneri tout en résidant en Italie (flux inverse du schéma historique) ; Lecco est inclus pour les frontaliers qui empruntent la SS36 vers les Grisons via Chiavenna. Pour chaque ville, nous montrons la température agrégée de 2-3 sources (médiane, pas moyenne), le code météo WMO 4677 le plus voté et toute alerte MeteoSwiss active couvrant la région concernée.`;
  return `<section class="my-8 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-bold text-heading mb-3">${escapeHtml(heading)}</h2><p class="text-body leading-relaxed">${escapeHtml(text)}</p></section>`;
}

function renderHubRow(locale: Locale, city: WeatherCity, cw?: CityWeather): string {
  const slug = city.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const url = `${localePath}/${HUB_SLUG[locale]}/${slug}/`;
  const tempStr = cw ? `${Math.round(cw.current.temperature)}°` : '—';
  const condition = cw ? wmoText(cw.current.weatherCode, locale) : labelUnavailable(locale);
  const iconHtml = cw
    ? `<span class="${colorForWmo(cw.current.weatherCode)} flex justify-center" aria-hidden="true">${useForWmo(cw.current.weatherCode, 24)}</span>`
    : `<span class="text-muted flex justify-center" aria-hidden="true">—</span>`;
  const countryBadge = city.country === 'CH'
    ? `<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-danger-subtle text-danger text-[10px] font-bold border border-danger" aria-label="Svizzera">CH</span>`
    : `<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-success-subtle text-success text-[10px] font-bold border border-success" aria-label="Italia">IT</span>`;
  return `<li><a class="grid grid-cols-[auto_28px_1fr_auto] sm:grid-cols-[auto_28px_2fr_2fr_auto_auto] gap-3 sm:gap-4 items-center px-4 py-3 sm:py-4 hover:bg-accent-subtle/40 transition-colors" href="${url}">${countryBadge}${iconHtml}<span class="font-semibold text-heading truncate">${escapeHtml(city.name)}</span><span class="hidden sm:inline text-sm text-subtle truncate">${escapeHtml(city.region[locale])}</span><span class="text-lg font-bold text-heading tabular-nums">${tempStr}</span><span class="hidden sm:inline text-sm text-body truncate">${escapeHtml(condition)}</span></a></li>`;
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
  const valichiHtml = renderValichiRow(locale, city.id);
  const hourlyHtml = cw ? renderHourly(cw, locale) : '';
  const dailyHtml = cw ? renderDaily(cw, locale) : '';
  const evergreenHtml = renderEvergreen(city, locale);
  const commuteHtml = renderCommuteScenarios(city, locale);
  const ctaHtml = renderCta(locale, `weather-city-${city.id}`);
  const faqHtml = renderFaq(locale);
  const attributionHtml = attributionBlock(locale, generatedAt);

  const localePathCity = locale === 'it' ? '' : `/${locale}`;
  const homeNameCity = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  const hubUrlCity = `https://frontaliereticino.ch${localePathCity}/${HUB_SLUG[locale]}/`;
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
${weatherFontsAndStyle()}
${iconSprite()}
<div data-weather-page>
${breadcrumb}
<header class="max-w-4xl mx-auto pt-2 pb-1 px-1"><h1 class="text-4xl sm:text-5xl font-medium text-heading mb-2 leading-tight tracking-tight" style="font-family:var(--font-display,inherit);">${escapeHtml(headline)}</h1>
<p class="text-base sm:text-lg text-body max-w-2xl">${escapeHtml(tagline)}</p></header>
${heroHtml}
${valichiHtml}
${hourlyHtml}
${dailyHtml}
${ctaHtml}
${evergreenHtml}
${commuteHtml}
${faqHtml}
${attributionHtml}
</div>
`,
    generatedAt,
    breadcrumbs: [
      { name: homeNameCity, url: `https://frontaliereticino.ch${localePathCity}/` },
      { name: HUB_TITLE[locale], url: hubUrlCity },
      { name: city.name, url: canonical },
    ],
  });
}

/**
 * Inject Faustina (editorial display serif) only on weather pages — keeps
 * the SPA bundle untouched. Body stays system to avoid double FOUT.
 * `data-weather-page` scopes the override; var(--font-display) lets us
 * apply it surgically to h1/h2/temp via inline `style="font-family:var(...)"`.
 */
function weatherFontsAndStyle(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Faustina:wght@400;500;600&display=swap"><style>[data-weather-page]{--font-display:'Faustina',Georgia,'Iowan Old Style',serif;}[data-weather-page] [data-temp-display]{font-family:var(--font-display);font-feature-settings:'tnum','lnum';}</style>`;
}

function attributionBlock(locale: Locale, generatedAt?: string): string {
  const updatedLabel = locale === 'it' ? 'Aggiornato' : locale === 'en' ? 'Updated' : locale === 'de' ? 'Aktualisiert' : 'Mis à jour';
  const sourceLabel = locale === 'it' ? 'Fonti' : locale === 'en' ? 'Sources' : locale === 'de' ? 'Quellen' : 'Sources';
  let stamp = '';
  if (generatedAt) {
    try {
      const d = new Date(generatedAt);
      if (!Number.isNaN(d.getTime())) {
        const human = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        stamp = `<time datetime="${escapeHtml(generatedAt)}" class="text-sm font-medium text-body">${updatedLabel} ${human}</time>`;
      }
    } catch { /* ignore */ }
  }
  return `<section class="my-10 max-w-2xl mx-auto pt-6 border-t border-edge flex flex-col gap-1.5">${stamp}<p class="text-xs text-subtle leading-relaxed">${sourceLabel}: <a class="hover:text-body underline-offset-2 hover:underline" href="https://open-meteo.com/" rel="noopener" target="_blank">Open-Meteo</a> · <a class="hover:text-body underline-offset-2 hover:underline" href="https://www.met.no/" rel="noopener" target="_blank">MET Norway</a> · <a class="hover:text-body underline-offset-2 hover:underline" href="https://www.meteoswiss.admin.ch/" rel="noopener" target="_blank">MeteoSwiss</a> · <a class="hover:text-body underline-offset-2 hover:underline" href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank">CC-BY 4.0</a></p></section>`;
}

function renderBreadcrumb(locale: Locale, city: WeatherCity): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const homeText = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  return `<nav aria-label="Breadcrumb" class="max-w-3xl mx-auto py-3 text-sm"><ol class="flex flex-wrap items-center gap-1 text-muted"><li><a href="${localePath}/" class="hover:text-link">${homeText}</a></li><li class="text-muted">›</li><li><a href="${localePath}/${HUB_SLUG[locale]}/" class="hover:text-link">${escapeHtml(HUB_TITLE[locale])}</a></li><li class="text-muted">›</li><li class="text-heading font-medium" aria-current="page">${escapeHtml(city.name)}</li></ol></nav>`;
}

function renderHero(cw: CityWeather, locale: Locale): string {
  const condition = wmoText(cw.current.weatherCode, locale);
  const sourceCount = cw.sources?.length ?? 0;
  const confLabel = cw.confidence === 'low' ? labelLow(locale) : cw.confidence === 'medium' ? labelMedium(locale) : labelHigh(locale);
  const sourceList = (cw.sources ?? []).map((s) => s === 'open-meteo' ? 'Open-Meteo' : s === 'met-no' ? 'Met.no' : 'MeteoSwiss').join(' + ');
  const confTooltip = sourceList ? `${confLabel} · ${sourceList}` : confLabel;
  const dotClass = (filled: boolean) => filled
    ? (cw.confidence === 'low' ? 'bg-danger' : cw.confidence === 'medium' ? 'bg-warning' : 'bg-success')
    : 'bg-stone-300';
  const dots = [1, 2, 3].map((i) => `<span class="w-1.5 h-1.5 rounded-full ${dotClass(i <= sourceCount)}" aria-hidden="true"></span>`).join('');
  const conf = `<span class="inline-flex items-center gap-2 text-xs text-body" title="${escapeHtml(confTooltip)}"><span class="flex items-center gap-0.5">${dots}</span><span class="font-medium">${escapeHtml(confLabel)}</span></span>`;

  const tempStr = `${Math.round(cw.current.temperature)}°`;
  const iconColor = colorForWmo(cw.current.weatherCode);
  const heroIcon = useForWmo(cw.current.weatherCode, 96);

  const stats: string[] = [];
  if (cw.current.windSpeedKmh != null) {
    stats.push(`<div class="bg-white/70 rounded-xl px-3.5 py-2.5 border border-edge/80 flex items-center gap-2.5"><span class="text-subtle shrink-0">${useWind(18)}</span><div class="min-w-0"><div class="text-[11px] text-subtle uppercase tracking-wide font-medium">${labelWind(locale)}</div><div class="text-sm font-semibold text-strong tabular-nums">${Math.round(cw.current.windSpeedKmh)}<span class="text-subtle font-normal"> km/h</span></div></div></div>`);
  }
  if (cw.current.humidity != null) {
    stats.push(`<div class="bg-white/70 rounded-xl px-3.5 py-2.5 border border-edge/80 flex items-center gap-2.5"><span class="text-sky-600 shrink-0">${useDroplet(18)}</span><div class="min-w-0"><div class="text-[11px] text-subtle uppercase tracking-wide font-medium">${labelHumidity(locale)}</div><div class="text-sm font-semibold text-strong tabular-nums">${cw.current.humidity}<span class="text-subtle font-normal">%</span></div></div></div>`);
  }
  const today = cw.daily7?.[0];
  if (today?.sunrise) {
    const t = formatHm(today.sunrise);
    if (t) stats.push(`<div class="bg-white/70 rounded-xl px-3.5 py-2.5 border border-edge/80 flex items-center gap-2.5"><span class="text-amber-500 shrink-0">${useSunrise(18)}</span><div class="min-w-0"><div class="text-[11px] text-subtle uppercase tracking-wide font-medium">${labelSunrise(locale)}</div><div class="text-sm font-semibold text-strong tabular-nums">${t}</div></div></div>`);
  }
  if (today?.sunset) {
    const t = formatHm(today.sunset);
    if (t) stats.push(`<div class="bg-white/70 rounded-xl px-3.5 py-2.5 border border-edge/80 flex items-center gap-2.5"><span class="text-accent shrink-0">${useSunset(18)}</span><div class="min-w-0"><div class="text-[11px] text-subtle uppercase tracking-wide font-medium">${labelSunset(locale)}</div><div class="text-sm font-semibold text-strong tabular-nums">${t}</div></div></div>`);
  }
  const statsHtml = stats.length
    ? `<div class="relative grid grid-cols-2 sm:grid-cols-4 gap-2 mt-6">${stats.join('')}</div>`
    : '';

  return `<section data-weather-hero class="bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 border border-accent/60 rounded-3xl p-6 sm:p-10 my-6 max-w-4xl mx-auto" aria-live="polite">
<div class="flex items-center gap-5 sm:gap-8">
<div class="${iconColor} shrink-0">${heroIcon}</div>
<div class="min-w-0 flex-1">
<div data-temp-display class="text-7xl sm:text-8xl font-normal text-heading tabular-nums leading-none tracking-tight" data-current-temp>${tempStr}</div>
<div class="mt-2 text-xl sm:text-2xl text-body">${escapeHtml(condition)}</div>
<div class="mt-3">${conf}</div>
</div>
</div>
${statsHtml}
</section>`;
}

function renderValichiRow(locale: Locale, cityId: string): string {
  const list = NEAREST_VALICHI[cityId];
  if (!list || list.length === 0) return '';
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const valicoSlug = locale === 'it' ? 'traffico-dogane' : locale === 'en' ? 'border-traffic' : locale === 'de' ? 'grenze-verkehr' : 'trafic-frontalier';
  const label = locale === 'it' ? 'Valichi vicini' : locale === 'en' ? 'Nearby crossings' : locale === 'de' ? 'Nahe Übergänge' : 'Passages proches';
  const items = list.map((v) => {
    const url = `${localePath}/${valicoSlug}/${v.slug}/oggi/`;
    return `<a href="${url}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium text-strong bg-white hover:bg-surface-alt border border-edge hover:border-edge transition-colors">${escapeHtml(v.name)}<span class="text-muted" aria-hidden="true">→</span></a>`;
  }).join('');
  return `<div class="max-w-4xl mx-auto -mt-2 mb-6 px-1 flex items-center gap-2 flex-wrap"><span class="text-xs uppercase tracking-wider text-subtle font-medium">${escapeHtml(label)}</span>${items}</div>`;
}

function renderSentinel(locale: Locale): string {
  const text = locale === 'it' ? 'Dati meteo temporaneamente non disponibili' : locale === 'en' ? 'Weather data temporarily unavailable' : locale === 'de' ? 'Wetterdaten vorübergehend nicht verfügbar' : 'Données météo temporairement indisponibles';
  return `<section class="bg-warning-subtle border border-warning-border rounded-xl p-6 my-6 max-w-3xl mx-auto text-center"><p class="text-warning">${escapeHtml(text)}</p></section>`;
}

function renderHourly(cw: CityWeather, locale: Locale): string {
  if (!cw.hourly24.length) return '';
  const heading = locale === 'it' ? 'Prossime 24 ore' : locale === 'en' ? 'Next 24 hours' : locale === 'de' ? 'Nächste 24 Stunden' : 'Prochaines 24 heures';
  const slice = cw.hourly24.slice(0, 24);
  const cellW = 68;
  const cellGap = 8;
  const totalW = slice.length * cellW + (slice.length - 1) * cellGap;
  const sparkH = 36;
  const tempsAll = slice.map((h) => h.temp);
  const minT = Math.min(...tempsAll);
  const maxT = Math.max(...tempsAll);
  const rangeT = Math.max(1, maxT - minT);
  const points = slice.map((h, i) => {
    const x = i * (cellW + cellGap) + cellW / 2;
    const y = sparkH - 4 - ((h.temp - minT) / rangeT) * (sparkH - 8);
    return `${x},${y.toFixed(1)}`;
  }).join(' ');
  const sparkline = `<svg class="block" width="${totalW}" height="${sparkH}" viewBox="0 0 ${totalW} ${sparkH}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="rgb(217 119 6 / 0.85)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" points="${points}"></polyline></svg>`;
  const cells = slice.map((h, i) => {
    const hour = h.hour.slice(11, 13);
    const code = h.weatherCode ?? cw.current.weatherCode;
    const icon = useForWmo(code, 24);
    const iconColor = colorForWmo(code);
    const isNow = i === 0;
    const ringClass = isNow ? 'ring-1 ring-orange-300 bg-accent-subtle/60' : 'bg-white';
    return `<div class="flex-shrink-0 w-[68px] ${ringClass} rounded-xl border border-edge p-2 text-center hover:border-edge transition-colors"><div class="text-[11px] text-subtle font-medium tabular-nums">${hour}<span class="text-muted">:00</span></div><div class="my-1 flex justify-center ${iconColor}">${icon}</div><div class="text-base font-semibold text-strong tabular-nums">${Math.round(h.temp)}°</div></div>`;
  }).join('');
  return `<section class="my-8 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-medium text-heading mb-3 px-1" style="font-family:var(--font-display,inherit);">${escapeHtml(heading)}</h2><div class="overflow-x-auto -mx-1 px-1 pb-3" style="scrollbar-width:thin;"><div style="width:${totalW}px;">${sparkline}<div class="flex gap-2 mt-1">${cells}</div></div></div></section>`;
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
    const icon = useForWmo(d.weatherCode, 26);
    const iconColor = colorForWmo(d.weatherCode);
    const leftPct = Math.round(((d.tempMin - globalMin) / range) * 100);
    const widthPct = Math.max(8, Math.round(((d.tempMax - d.tempMin) / range) * 100));
    const isToday = i === 0;
    const dayLabel = isToday
      ? (locale === 'it' ? 'Oggi' : locale === 'en' ? 'Today' : locale === 'de' ? 'Heute' : "Aujourd'hui")
      : dayName(d.date);
    const dayLabelHtml = isToday
      ? `<span class="inline-flex items-center gap-1.5 text-sm font-semibold text-accent"><span class="w-1.5 h-1.5 rounded-full bg-accent"></span>${dayLabel}</span>`
      : `<span class="text-sm font-medium text-body">${dayLabel}</span>`;
    const rowBg = isToday ? 'bg-accent-subtle/40' : '';
    return `<li class="grid grid-cols-[68px_32px_1fr_88px] gap-3 py-3.5 px-3 border-b border-edge last:border-0 items-center ${rowBg}"><span>${dayLabelHtml}</span><span class="${iconColor} flex justify-center" title="${escapeHtml(cond)}" aria-label="${escapeHtml(cond)}">${icon}</span><span class="relative h-2 bg-surface-alt rounded-full overflow-hidden" aria-hidden="true"><span class="absolute top-0 bottom-0 bg-gradient-to-r from-sky-400 via-amber-300 to-rose-500 rounded-full" style="left:${leftPct}%;width:${widthPct}%;"></span></span><span class="text-sm tabular-nums text-right"><span class="font-semibold text-heading">${Math.round(d.tempMax)}°</span> <span class="text-muted">${Math.round(d.tempMin)}°</span></span></li>`;
  }).join('');
  return `<section class="my-8 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-medium text-heading mb-3 px-1" style="font-family:var(--font-display,inherit);">${escapeHtml(heading)}</h2><ol class="bg-white rounded-2xl border border-edge overflow-hidden">${rows}</ol></section>`;
}

/**
 * Commute scenarios block — concrete prose linking weather conditions to
 * frontaliere commute decisions. Adds ~600 words per locale of relevant
 * editorial content so the text-to-HTML ratio stays well above the 10 %
 * Semrush threshold (the icon sprite + Tailwind shell consume HTML mass
 * without contributing visible text). Content is genuinely useful, not
 * filler: it tells the user what to do when fog/snow/rain actually hits.
 */
function renderCommuteScenarios(city: WeatherCity, locale: Locale): string {
  const heading = locale === 'it' ? `Cosa fare se il meteo cambia il commute a ${city.name}`
    : locale === 'en' ? `What to do when weather changes the commute to ${city.name}`
    : locale === 'de' ? `Was tun, wenn das Wetter den Pendelweg nach ${city.name} verändert`
    : `Que faire quand la météo change le trajet vers ${city.name}`;
  const blocks = locale === 'it' ? [
    ['Nebbia mattutina sulle valli', `Tra ottobre e marzo, la nebbia copre la fascia bassa del Ceresio e della pianura padana fino a quote di 600-800 metri, riducendo la visibilità sulla A2 tra Mendrisio e Lugano e sulla SS35 dei Giovi sul versante italiano. Quando il bollettino dà nebbia con visibilità sotto i 200 metri, conviene anticipare la partenza di 25-35 minuti, scegliere il valico di Brogeda invece di Stabio (carreggiata più larga, code monitorate live) e tenere i fari anabbaglianti accesi anche di giorno. Le galleria del San Gottardo restano l'unica tratta dove la nebbia non incide; se devi raggiungere il Sopraceneri prendi quella anche se sembra un giro lungo.`],
    ['Pioggia intensa e rischio aquaplaning', `${city.country === 'CH' ? 'Sul versante ticinese' : 'Sul versante italiano'} la pioggia battente alza il livello del Cassarate e dello Scairolo entro 90 minuti dal picco; gli accessi secondari ai valichi (in particolare Gandria e Ponte Tresa) possono allagarsi temporaneamente. Quando le previsioni indicano oltre 30 mm/h, abbandona le strade panoramiche del lago e usa l'autostrada A2: la corsia di emergenza è gestita meglio dal punto di vista idraulico e Astra emette i suoi avvisi traffico con 15-20 minuti di anticipo via VMS. Tieni d'occhio anche i sottopassi di Chiasso e Mendrisio Stazione, frequentemente a rischio durante temporali estivi.`],
    ['Neve e ghiaccio sui valichi', `La quota neve in Ticino scende sotto i 600 metri circa 8-12 volte all'anno; quando arriva, le rampe di accesso al San Bernardino e i tornanti tra Bissone e Melide diventano critici nelle prime due ore. Le auto immatricolate in Italia devono avere catene a bordo o pneumatici M+S omologati dal 15 novembre al 15 aprile (Codice della Strada italiano), e dal 1° novembre al 30 aprile sui passi alpini svizzeri (anche se non è obbligo, polizia cantonale ferma e rimanda indietro chi ne è sprovvisto in caso di emergenza). I valichi di Brogeda e Stabio restano i più sicuri perché su pianura; Gandria e Ponte Tresa possono essere chiusi temporaneamente per pulizia.`],
    ['Vento forte e raffiche', `Il vento da nord (favonio) e quello da sud (Föhn invertito) interessano soprattutto la fascia del Ceresio e l'alto Verbano: con raffiche oltre 80 km/h Astra può chiudere i ponti più esposti (in particolare Melide-Maroggia in casi estremi) e Trenord cancella i regionali Saronno-Como-Chiasso. Se sei in moto o con furgone telonato, evita la A2 sopra Bellinzona e prendi la A13 (San Bernardino) che è in galleria per gran parte del tragitto. La frequenza di queste chiusure è bassa (3-5 episodi all'anno) ma quando capitano causano ritardi di 90+ minuti.`],
    ['Calore estremo e ozono', `Tra giugno e agosto, gli episodi di ozono troposferico oltre 180 µg/m³ scattano l'allerta MeteoSwiss livello 3-4 sul Mendrisiotto. Per chi ha asma o cardiopatie conviene anticipare il commute prima delle 7:30 (concentrazioni di ozono più basse) e usare l'aria condizionata in modalità ricircolo. I posti di lavoro che applicano la legge cantonale ticinese sull'igiene del lavoro sono tenuti a regolare le temperature interne quando la temperatura esterna supera i 30°C per più di tre giorni consecutivi.`],
  ] : locale === 'en' ? [
    ['Morning fog on the valleys', `Between October and March, fog blankets the lower Ceresio basin and the Po plain up to 600-800 m, cutting visibility on the A2 between Mendrisio and Lugano and on the SS35 dei Giovi on the Italian side. When the bulletin signals fog under 200 m visibility, leave 25-35 minutes earlier, prefer Brogeda over Stabio (wider lanes, live queue monitoring), and keep dipped headlights on all day. The Gotthard tunnels are the only stretch fog can't reach; if you need the Sopraceneri, take them even when it seems a detour.`],
    ['Heavy rain and aquaplaning risk', `${city.country === 'CH' ? 'On the Ticino side' : 'On the Italian side'} heavy rain raises the Cassarate and Scairolo levels within 90 minutes of the peak; secondary roads to crossings (Gandria and Ponte Tresa especially) can flood temporarily. When forecasts give more than 30 mm/h, ditch the lake panoramic roads and use the A2 motorway: the emergency lane drains better, and Astra publishes VMS traffic alerts 15-20 minutes ahead. Keep an eye on the Chiasso and Mendrisio Station underpasses, often at risk in summer storms.`],
    ['Snow and ice on the crossings', `The snow level in Ticino drops below 600 m roughly 8-12 times a year; when it does, the San Bernardino access ramps and the Bissone-Melide hairpins become critical in the first two hours. Italian-plate cars must carry chains or M+S tyres from 15 November to 15 April (Italian Highway Code), and from 1 November to 30 April on Swiss alpine passes (cantonal police can turn you back without them). Brogeda and Stabio stay safest as flatland crossings; Gandria and Ponte Tresa can close temporarily for clearance.`],
    ['High wind and gusts', `North wind (foehn) and inverted south wind hit the Ceresio strip and the upper Verbano: gusts over 80 km/h can lead Astra to close exposed bridges (Melide-Maroggia in extreme cases) and Trenord to cancel the Saronno-Como-Chiasso regional trains. If you ride a motorbike or drive a tarpaulin van, skip the A2 north of Bellinzona and take the A13 (San Bernardino), tunnelled most of the way. Closures are rare (3-5 episodes a year) but cost 90+ minutes when they happen.`],
    ['Extreme heat and ozone', `Between June and August, tropospheric ozone above 180 µg/m³ triggers MeteoSwiss alert level 3-4 over the Mendrisiotto. People with asthma or heart conditions should commute before 7:30 (lower ozone concentrations) and run AC on recirculation. Workplaces under the Ticino cantonal occupational hygiene act must regulate indoor temperatures when outdoor temperatures exceed 30 °C for three consecutive days.`],
  ] : locale === 'de' ? [
    ['Morgennebel in den Tälern', `Zwischen Oktober und März bedeckt Nebel das untere Ceresiobecken und die Poebene bis 600-800 m und reduziert die Sicht auf der A2 zwischen Mendrisio und Lugano sowie auf der SS35 dei Giovi auf italienischer Seite. Wenn der Bericht Nebel unter 200 m Sichtweite meldet, fahre 25-35 Minuten früher los, bevorzuge Brogeda gegenüber Stabio (breitere Spuren, Live-Schlangenüberwachung) und lasse Abblendlicht auch tagsüber an. Die Gotthard-Tunnel sind der einzige Abschnitt, den Nebel nicht erreicht; wenn du Sopraceneri erreichen musst, nimm sie auch wenn es nach Umweg aussieht.`],
    ['Starkregen und Aquaplaning-Risiko', `${city.country === 'CH' ? 'Auf der Tessiner Seite' : 'Auf der italienischen Seite'} hebt Starkregen den Cassarate- und Scairolo-Pegel innert 90 Minuten nach dem Spitzenwert; sekundäre Zufahrten zu Übergängen (besonders Gandria und Ponte Tresa) können vorübergehend überschwemmt werden. Bei Prognosen über 30 mm/h verlasse die Panoramastrassen am See und nimm die A2: der Pannenstreifen wird hydraulisch besser bewirtschaftet und Astra veröffentlicht VMS-Verkehrshinweise 15-20 Minuten im Voraus. Achte auf die Unterführungen von Chiasso und Mendrisio Bahnhof, oft gefährdet bei Sommergewittern.`],
    ['Schnee und Eis an den Übergängen', `Die Schneefallgrenze im Tessin sinkt 8-12 Mal pro Jahr unter 600 m; wenn das passiert, werden die San-Bernardino-Auffahrten und die Bissone-Melide-Spitzkehren in den ersten zwei Stunden kritisch. Italienische Fahrzeuge müssen vom 15. November bis 15. April Ketten dabei haben oder M+S-Reifen montieren (italienische StVO), und vom 1. November bis 30. April auf Schweizer Alpenpässen (Kantonspolizei kann ohne sie zurückschicken). Brogeda und Stabio bleiben als Flachland-Übergänge am sichersten; Gandria und Ponte Tresa können vorübergehend zur Räumung schliessen.`],
    ['Starker Wind und Böen', `Nordwind (Föhn) und umgekehrter Südwind treffen den Ceresio-Streifen und den oberen Verbano: Böen über 80 km/h können Astra dazu bringen, exponierte Brücken zu schliessen (Melide-Maroggia in Extremfällen), und Trenord storniert die Regionalzüge Saronno-Como-Chiasso. Auf Motorrad oder mit Plane-Lieferwagen meide die A2 nördlich von Bellinzona und nimm die A13 (San Bernardino), die grösstenteils im Tunnel verläuft. Schliessungen sind selten (3-5 Episoden pro Jahr), kosten aber 90+ Minuten.`],
    ['Extreme Hitze und Ozon', `Zwischen Juni und August löst troposphärisches Ozon über 180 µg/m³ MeteoSwiss-Warnstufe 3-4 über dem Mendrisiotto aus. Personen mit Asthma oder Herzerkrankungen sollten vor 7:30 pendeln (niedrigere Ozonkonzentrationen) und Klimaanlage auf Umluft schalten. Arbeitsplätze unter dem Tessiner kantonalen Arbeitshygienegesetz müssen Innentemperaturen regulieren, wenn die Aussentemperatur an drei aufeinanderfolgenden Tagen 30 °C übersteigt.`],
  ] : [
    ['Brouillard matinal sur les vallées', `Entre octobre et mars, le brouillard couvre le bas Ceresio et la plaine du Pô jusqu'à 600-800 m, coupant la visibilité sur l'A2 entre Mendrisio et Lugano et sur la SS35 dei Giovi côté italien. Quand le bulletin annonce un brouillard à moins de 200 m, partez 25-35 minutes plus tôt, préférez Brogeda à Stabio (voies plus larges, file surveillée en direct) et gardez les feux de croisement allumés en journée. Les tunnels du Gothard sont le seul tronçon que le brouillard n'atteint pas ; si vous devez rejoindre le Sopraceneri, prenez-les même si cela semble un détour.`],
    ['Pluies intenses et aquaplaning', `${city.country === 'CH' ? 'Côté tessinois' : 'Côté italien'} les fortes pluies font monter le Cassarate et le Scairolo en 90 minutes après le pic ; les routes secondaires vers les passages (notamment Gandria et Ponte Tresa) peuvent s'inonder temporairement. Quand les prévisions annoncent plus de 30 mm/h, abandonnez les routes panoramiques du lac et empruntez l'A2 : la bande d'arrêt d'urgence draine mieux et Astra publie ses alertes VMS 15-20 minutes en avance. Surveillez aussi les sous-passes de Chiasso et Mendrisio Gare, souvent à risque en orages estivaux.`],
    ['Neige et glace aux passages', `Le niveau de neige au Tessin descend sous 600 m environ 8 à 12 fois par an ; les rampes du San Bernardino et les épingles Bissone-Melide deviennent critiques dans les deux premières heures. Les véhicules immatriculés en Italie doivent transporter des chaînes ou des pneus M+S du 15 novembre au 15 avril (Code de la route italien), et du 1er novembre au 30 avril sur les cols alpins suisses (la police cantonale peut refouler sans). Brogeda et Stabio restent les plus sûrs (plaine) ; Gandria et Ponte Tresa peuvent fermer temporairement pour déneigement.`],
    ['Vent fort et rafales', `Le vent du nord (foehn) et le vent inversé du sud touchent la bande Ceresio et le haut Verbano : des rafales au-delà de 80 km/h peuvent amener Astra à fermer les ponts exposés (Melide-Maroggia en cas extrême) et Trenord à annuler les régionaux Saronno-Como-Chiasso. À moto ou en fourgon bâché, évitez l'A2 au nord de Bellinzone et prenez l'A13 (San Bernardino), majoritairement en tunnel. Les fermetures sont rares (3-5 épisodes par an) mais coûtent 90+ minutes.`],
    ['Chaleur extrême et ozone', `Entre juin et août, l'ozone troposphérique au-delà de 180 µg/m³ déclenche l'alerte MeteoSwiss niveau 3-4 sur le Mendrisiotto. Les personnes asthmatiques ou cardiaques devraient commuter avant 7h30 (concentrations d'ozone plus basses) et utiliser la climatisation en recyclage. Les lieux de travail sous la loi cantonale tessinoise sur l'hygiène du travail doivent réguler la température intérieure quand la température extérieure dépasse 30 °C pendant trois jours consécutifs.`],
  ];
  const items = blocks.map(([h, p]) => `<article class="bg-white border border-edge rounded-2xl p-5 sm:p-6"><h3 class="text-base font-semibold text-heading mb-2">${escapeHtml(h)}</h3><p class="text-sm text-body leading-relaxed">${escapeHtml(p)}</p></article>`).join('');
  return `<section class="my-10 max-w-3xl mx-auto"><h2 class="text-xl sm:text-2xl font-medium text-heading mb-4 px-1" style="font-family:var(--font-display,inherit);">${escapeHtml(heading)}</h2><div class="grid gap-3 sm:gap-4">${items}</div></section>`;
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

  // SPA hydration mounts the canonical <Newsletter compact /> component
  // (Google one-tap + Google fallback + LinkedIn + email form + MX check +
  // Firebase upsert + analytics) into the placeholder via NewsletterMount.tsx
  // scanning for [data-newsletter-mount] at boot. We only override heading +
  // subtitle text and tag sourceCta for per-page analytics. Pre-hydration
  // skeleton uses same gradient tokens to avoid CLS while React loads.
  return `<section class="my-10 max-w-2xl mx-auto px-1">
<div data-newsletter-mount data-acquisition-source="${escapeHtml(acquisitionSource)}" data-heading="${escapeHtml(heading)}" data-subtitle="${escapeHtml(sub)}" class="bg-gradient-to-r from-info-strong to-success-strong rounded-2xl p-4 sm:p-6 text-on-accent min-h-[200px]"><p class="text-on-accent text-sm font-bold opacity-90">${escapeHtml(heading)}</p><p class="text-on-accent/70 text-xs mt-2">${escapeHtml(sub)}</p></div>
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
