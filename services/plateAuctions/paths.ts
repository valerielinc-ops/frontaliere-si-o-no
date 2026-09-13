import type { Locale } from '@/services/i18n';

export type PlateAuctionPageView = 'hub' | 'canton' | 'detail' | 'rankings';

const BASE_BY_LOCALE: Record<Locale, string> = {
  it: 'aste-targhe-svizzera',
  en: 'swiss-plate-auctions',
  de: 'schweizer-nummernschildauktionen',
  fr: 'encheres-plaques-suisses',
};

const CANTON_SLUGS: Record<string, Record<Locale, string>> = {
  AG: { it: 'argovia-ag', en: 'aargau-ag', de: 'aargau-ag', fr: 'argovie-ag' },
  AI: { it: 'appenzello-interno-ai', en: 'appenzell-inner-ai', de: 'innerrhoden-ai', fr: 'appenzell-interieur-ai' },
  AR: { it: 'appenzello-esterno-ar', en: 'appenzell-outer-ar', de: 'ausserrhoden-ar', fr: 'appenzell-exterieur-ar' },
  BE: { it: 'berna-be', en: 'bern-be', de: 'bern-be', fr: 'berne-be' },
  BL: { it: 'basilea-campagna-bl', en: 'basel-country-bl', de: 'basel-landschaft-bl', fr: 'bale-campagne-bl' },
  BS: { it: 'basilea-citta-bs', en: 'basel-city-bs', de: 'basel-stadt-bs', fr: 'bale-ville-bs' },
  FR: { it: 'friburgo-fr', en: 'fribourg-fr', de: 'freiburg-fr', fr: 'fribourg-fr' },
  GE: { it: 'ginevra-ge', en: 'geneva-ge', de: 'genf-ge', fr: 'geneve-ge' },
  GL: { it: 'glarona-gl', en: 'glarus-gl', de: 'glarus-gl', fr: 'glaris-gl' },
  GR: { it: 'grigioni-gr', en: 'graubunden-gr', de: 'graubuenden-gr', fr: 'grisons-gr' },
  JU: { it: 'giura-ju', en: 'jura-ju', de: 'jura-ju', fr: 'jura-ju' },
  LU: { it: 'lucerna-lu', en: 'lucerne-lu', de: 'luzern-lu', fr: 'lucerne-lu' },
  NE: { it: 'neuchatel-ne', en: 'neuchatel-ne', de: 'neuenburg-ne', fr: 'neuchatel-ne' },
  NW: { it: 'nidvaldo-nw', en: 'nidwalden-nw', de: 'nidwalden-nw', fr: 'nidwald-nw' },
  OW: { it: 'obvaldo-ow', en: 'obwalden-ow', de: 'obwalden-ow', fr: 'obwald-ow' },
  SG: { it: 'san-gallo-sg', en: 'st-gallen-sg', de: 'st-gallen-sg', fr: 'saint-gall-sg' },
  SH: { it: 'sciaffusa-sh', en: 'schaffhausen-sh', de: 'schaffhausen-sh', fr: 'schaffhouse-sh' },
  SO: { it: 'soletta-so', en: 'solothurn-so', de: 'solothurn-so', fr: 'soleure-so' },
  SZ: { it: 'svitto-sz', en: 'schwyz-sz', de: 'schwyz-sz', fr: 'schwytz-sz' },
  TG: { it: 'turgovia-tg', en: 'thurgau-tg', de: 'thurgau-tg', fr: 'thurgovie-tg' },
  TI: { it: 'ticino-ti', en: 'ticino-ti', de: 'tessin-ti', fr: 'tessin-ti' },
  UR: { it: 'uri-ur', en: 'uri-ur', de: 'uri-ur', fr: 'uri-ur' },
  VD: { it: 'vaud-vd', en: 'vaud-vd', de: 'waadt-vd', fr: 'vaud-vd' },
  VS: { it: 'vallese-vs', en: 'valais-vs', de: 'wallis-vs', fr: 'valais-vs' },
  ZG: { it: 'zugo-zg', en: 'zug-zg', de: 'zug-zg', fr: 'zoug-zg' },
  ZH: { it: 'zurigo-zh', en: 'zurich-zh', de: 'zurich-zh', fr: 'zurich-zh' },
};

const RANKING_SEGMENT: Record<Locale, string> = { it: 'classifiche', en: 'rankings', de: 'ranglisten', fr: 'classements' };

export interface PlateAuctionPath {
  locale: Locale;
  view: PlateAuctionPageView;
  canton?: string;
  plate?: string;
}

function localeAndParts(pathname: string): { locale: Locale; parts: string[] } | null {
  let parts: string[];
  try {
    parts = pathname.replace(/\/$/, '').split('/').filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
  if (parts.length === 0) return null;
  const locale = (['en', 'de', 'fr'].includes(parts[0]) ? parts.shift() : 'it') as Locale;
  return { locale, parts };
}

export function plateAuctionBasePath(locale: Locale): string {
  return `${locale === 'it' ? '' : `/${locale}`}/${BASE_BY_LOCALE[locale]}`;
}

export function cantonAuctionSlug(canton: string, locale: Locale): string | undefined {
  return CANTON_SLUGS[canton.toUpperCase()]?.[locale];
}

export function cantonCodeFromAuctionSlug(slug: string): string | undefined {
  const match = slug.match(/-([a-z]{2})$/i);
  const code = match?.[1]?.toUpperCase();
  return code && CANTON_SLUGS[code] ? code : undefined;
}

export function buildPlateAuctionPath({
  locale,
  view = 'hub',
  canton,
  plate,
}: {
  locale: Locale;
  view?: PlateAuctionPageView;
  canton?: string;
  plate?: string;
}): string {
  const base = plateAuctionBasePath(locale);
  if (view === 'rankings') return `${base}/${RANKING_SEGMENT[locale]}/`;
  if (!canton) return `${base}/`;
  const cantonSlug = cantonAuctionSlug(canton, locale) || canton.toLowerCase();
  return `${base}/${cantonSlug}${view === 'detail' && plate ? `/${encodeURIComponent(plate.toLowerCase())}` : ''}/`;
}

export function parsePlateAuctionPath(pathname: string): PlateAuctionPath | null {
  const parsed = localeAndParts(pathname);
  if (!parsed || parsed.parts[0] !== BASE_BY_LOCALE[parsed.locale]) return null;
  const rest = parsed.parts.slice(1);
  if (rest.length === 0) return { locale: parsed.locale, view: 'hub' };
  if (rest[0] === RANKING_SEGMENT[parsed.locale]) return { locale: parsed.locale, view: 'rankings' };
  const canton = cantonCodeFromAuctionSlug(rest[0]);
  if (!canton) return null;
  if (rest[1]) return { locale: parsed.locale, view: 'detail', canton, plate: rest[1].toUpperCase() };
  return { locale: parsed.locale, view: 'canton', canton };
}

export function allPlateAuctionCantonCodes(): string[] {
  return Object.keys(CANTON_SLUGS);
}
