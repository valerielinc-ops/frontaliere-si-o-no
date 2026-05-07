/**
 * Alert configuration table — drives weatherAlertEvaluator + the
 * weatherAlertPagesPlugin. 8 always-live trigger pages for events that
 * matter to the frontaliere commute. Pages stay indexable; content varies
 * (active vs dormant evergreen baseline).
 */

import type { MeteoSwissAlertType } from '../services/weather/meteoSwissFetcher';

export interface WeatherAlertConfig {
  id: string;
  /** MeteoSwiss official alert type that maps to this page. */
  meteoSwissType: MeteoSwissAlertType;
  /** Region used by MeteoSwiss bulletin (TI, TI-N, TI-S, IT-LECCO, etc.). */
  regionId?: string;
  /** Minimum severity (1=none, 2=moderate, 3=considerable, 4=strong, 5=very strong). */
  minLevel: number;
  /** URL slug per locale. */
  slug: { it: string; en: string; de: string; fr: string };
  /** Page H1 per locale. */
  title: { it: string; en: string; de: string; fr: string };
  /** Localised tagline (≤120 chars per design rule). */
  tagline: { it: string; en: string; de: string; fr: string };
}

export const WEATHER_ALERT_CONFIG: readonly WeatherAlertConfig[] = Object.freeze([
  {
    id: 'snow-gottardo',
    meteoSwissType: 'snow',
    regionId: 'TI-N',
    minLevel: 2,
    slug: { it: 'neve-gottardo', en: 'snow-gotthard', de: 'schnee-gotthard', fr: 'neige-gothard' },
    title: { it: 'Allerta neve sul Gottardo', en: 'Snow alert at Gotthard', de: 'Schneewarnung am Gotthard', fr: 'Alerte neige au Gothard' },
    tagline: {
      it: 'Stato attuale e impatto su commute frontalieri verso Ticino',
      en: 'Current state and commute impact for cross-border workers to Ticino',
      de: 'Aktueller Stand und Pendler-Auswirkungen für Grenzgänger ins Tessin',
      fr: 'État actuel et impact sur les frontaliers vers le Tessin',
    },
  },
  {
    id: 'nebbia-mendrisio',
    meteoSwissType: 'rain',
    regionId: 'TI-S',
    minLevel: 2,
    slug: { it: 'nebbia-mendrisio', en: 'fog-mendrisio', de: 'nebel-mendrisio', fr: 'brouillard-mendrisio' },
    title: { it: 'Nebbia fitta Mendrisiotto', en: 'Dense fog Mendrisio area', de: 'Dichter Nebel Mendrisiotto', fr: 'Brouillard dense Mendrisio' },
    tagline: {
      it: 'Visibilità ridotta sui valichi Chiasso, Stabio, Gaggiolo al mattino',
      en: 'Reduced visibility at Chiasso, Stabio, Gaggiolo crossings in the morning',
      de: 'Reduzierte Sicht an den Übergängen Chiasso, Stabio, Gaggiolo am Morgen',
      fr: 'Visibilité réduite aux passages Chiasso, Stabio, Gaggiolo le matin',
    },
  },
  {
    id: 'gelo-confine',
    meteoSwissType: 'frost',
    regionId: 'TI',
    minLevel: 2,
    slug: { it: 'gelo-confine', en: 'frost-border', de: 'frost-grenze', fr: 'gel-frontiere' },
    title: { it: 'Gelo notturno al confine', en: 'Overnight frost at border', de: 'Nachtfrost an der Grenze', fr: 'Gel nocturne à la frontière' },
    tagline: {
      it: 'Pneumatici invernali e cautela sulle strade prealpine',
      en: 'Winter tyres and caution on pre-Alpine roads',
      de: 'Winterreifen und Vorsicht auf voralpinen Strassen',
      fr: 'Pneus hiver et prudence sur les routes préalpines',
    },
  },
  {
    id: 'vento-forte-mendrisio',
    meteoSwissType: 'wind',
    regionId: 'TI-S',
    minLevel: 2,
    slug: { it: 'vento-forte-mendrisio', en: 'strong-wind-mendrisio', de: 'starkwind-mendrisio', fr: 'vent-fort-mendrisio' },
    title: { it: 'Vento forte sul Mendrisiotto', en: 'Strong wind in the Mendrisio area', de: 'Starker Wind im Mendrisiotto', fr: 'Vent fort sur le Mendrisiotto' },
    tagline: {
      it: 'Raffiche al confine svizzero-italiano, attenzione mezzi alti',
      en: 'Gusts at the Swiss-Italian border, caution for high-sided vehicles',
      de: 'Böen an der schweizerisch-italienischen Grenze, Vorsicht bei hohen Fahrzeugen',
      fr: 'Rafales à la frontière, prudence pour les véhicules hauts',
    },
  },
  {
    id: 'grandine-lecco',
    meteoSwissType: 'thunderstorm',
    regionId: 'IT-LECCO',
    minLevel: 2,
    slug: { it: 'grandine-lecco', en: 'hail-lecco', de: 'hagel-lecco', fr: 'grele-lecco' },
    title: { it: 'Grandine sul Lecchese', en: 'Hail in Lecco area', de: 'Hagel im Lecchese', fr: 'Grêle dans le Lecchese' },
    tagline: {
      it: 'Temporali intensi nelle valli lecchesi, danni a auto e cantieri',
      en: 'Intense thunderstorms in Lecco valleys, vehicle and worksite damage',
      de: 'Heftige Gewitter in den Lecchese-Tälern, Schäden an Autos und Baustellen',
      fr: 'Orages intenses dans les vallées lecchesi, dégâts véhicules et chantiers',
    },
  },
  {
    id: 'ondata-caldo-ticino',
    meteoSwissType: 'heat',
    regionId: 'TI',
    minLevel: 2,
    slug: { it: 'ondata-caldo-ticino', en: 'heatwave-ticino', de: 'hitzewelle-tessin', fr: 'canicule-tessin' },
    title: { it: 'Ondata di caldo in Ticino', en: 'Heatwave in Ticino', de: 'Hitzewelle im Tessin', fr: 'Canicule au Tessin' },
    tagline: {
      it: 'Temperature elevate, lavoro all\'aperto e commute auto a rischio',
      en: 'High temperatures, outdoor work and car commute at risk',
      de: 'Hohe Temperaturen, Arbeit im Freien und Pendelverkehr gefährdet',
      fr: 'Températures élevées, travail extérieur et trajets en voiture à risque',
    },
  },
  {
    id: 'alluvione-rischio',
    meteoSwissType: 'rain',
    regionId: 'TI-N',
    minLevel: 3,
    slug: { it: 'alluvione-rischio', en: 'flood-risk', de: 'hochwasserrisiko', fr: 'risque-inondation' },
    title: { it: 'Rischio alluvione Ticino', en: 'Flood risk Ticino', de: 'Hochwasserrisiko Tessin', fr: 'Risque d\'inondation Tessin' },
    tagline: {
      it: 'Piogge persistenti, fiumi e laghi sotto osservazione cantonale',
      en: 'Persistent rain, rivers and lakes under cantonal monitoring',
      de: 'Anhaltender Regen, Flüsse und Seen unter kantonaler Beobachtung',
      fr: 'Pluies persistantes, rivières et lacs sous surveillance cantonale',
    },
  },
  {
    id: 'ghiaccio-strade',
    meteoSwissType: 'slipperiness',
    regionId: 'TI',
    minLevel: 2,
    slug: { it: 'ghiaccio-strade', en: 'icy-roads', de: 'glaette-strassen', fr: 'verglas-routes' },
    title: { it: 'Ghiaccio sulle strade del confine', en: 'Icy roads at the border', de: 'Glätte auf Grenzstrassen', fr: 'Verglas sur les routes frontalières' },
    tagline: {
      it: 'Tratti scivolosi su valichi e A2, frenate prudenti',
      en: 'Slippery sections at crossings and on the A2, brake carefully',
      de: 'Rutschige Abschnitte an Übergängen und auf der A2, vorsichtig bremsen',
      fr: 'Tronçons glissants aux passages et sur l\'A2, freinez prudemment',
    },
  },
] as const);

export function findAlertConfigById(id: string): WeatherAlertConfig | undefined {
  return WEATHER_ALERT_CONFIG.find((c) => c.id === id);
}
