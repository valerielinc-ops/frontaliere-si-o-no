/**
 * Deterministic event-image taxonomy and assignment.
 *
 * No provider or filesystem dependency belongs here. The site assembler and
 * the renderer can therefore use exactly the same slot selection, while the
 * corpus can mirror this module and use it for its next article/event pass.
 */

import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  isLicensedPhotoRecord,
  validateGeneratedImageRecord,
} from './generatedImageRegistry.mjs';

export const EVENT_IMAGE_LIBRARY_SCHEMA_VERSION = 1;
export const EVENT_IMAGE_LIBRARY_PREFIX = '/images/events/library/';

export const EVENT_IMAGE_LIBRARY_CATEGORIES = Object.freeze([
  'musica',
  'teatro-spettacolo',
  'mostra-museo',
  'cinema',
  'festa-sagra-tradizione',
  'mercato-natale',
  'gastronomia',
  'sport',
  'natura-escursione',
  'famiglia-bambini',
  'conferenza-formazione',
  'generico',
]);

export const EVENT_IMAGE_LIBRARY_AREAS = Object.freeze([
  'ticino-confine',
  'svizzera-urbana',
  'alpi-montagna',
  'laghi',
]);

export const EVENT_IMAGE_LIBRARY_SEASONS = Object.freeze([
  'primavera-estate',
  'autunno-inverno',
]);
export const EVENT_IMAGE_LIBRARY_MAX_VARIANTS = 3;

const CATEGORY_KEYWORDS = Object.freeze([
  ['musica', ['musica', 'music', 'jazz', 'pop', 'rock', 'concerto', 'concerti', 'classica', 'opera', 'danza']],
  ['teatro-spettacolo', ['teatro', 'theater', 'theatre', 'spettacolo', 'cabaret', 'circo', 'comedy']],
  ['mostra-museo', ['mostra', 'mostre', 'exhibition', 'museo', 'museum', 'arte', 'gallery', 'galleria']],
  ['cinema', ['cinema', 'film', 'movie', 'proiezione']],
  ['mercato-natale', ['mercato', 'market', 'flea', 'brocante', 'artigianato', 'natale', 'christmas', 'weihnacht', 'marché']],
  ['festa-sagra-tradizione', ['festa', 'sagra', 'tradizione', 'festival', 'carnevale', 'mercatino', 'folklore', 'patronale']],
  ['gastronomia', ['food', 'gastronomia', 'gastronomie', 'cucina', 'vino', 'wine', 'degustazione', 'enogastronomia', 'ristorazione']],
  ['sport', ['sport', 'sports', 'corsa', 'gara', 'calcio', 'hockey', 'sci', 'bike', 'bici', 'escursione sportiva']],
  ['natura-escursione', ['natura', 'nature', 'escursione', 'escursioni', 'trekking', 'hiking', 'outdoor', 'montagna', 'parco', 'lago']],
  ['famiglia-bambini', ['famiglia', 'family', 'bambini', 'children', 'kids', 'ragazzi', 'infanzia', 'atelier']],
  ['conferenza-formazione', ['conferenza', 'conferenze', 'conference', 'formazione', 'workshop', 'seminario', 'talk', 'incontro', 'lecture']],
]);

const CATEGORY_LABELS = Object.freeze({
  musica: 'musica e concerto',
  'teatro-spettacolo': 'teatro e spettacolo',
  'mostra-museo': 'mostra e museo',
  cinema: 'cinema e proiezione',
  'festa-sagra-tradizione': 'festa, sagra e tradizione',
  'mercato-natale': 'mercato e atmosfera invernale',
  gastronomia: 'gastronomia e territorio',
  sport: 'sport e movimento',
  'natura-escursione': 'natura e paesaggio',
  'famiglia-bambini': 'famiglie e bambini',
  'conferenza-formazione': 'conferenza e formazione',
  generico: 'appuntamento locale',
});

const AREA_LABELS = Object.freeze({
  'ticino-confine': 'Ticino e area di confine italo-svizzera',
  'svizzera-urbana': 'città e quartieri urbani svizzeri',
  'alpi-montagna': 'Alpi, vallate e paesaggio montano',
  laghi: 'rive dei laghi e piccoli centri lacustri',
});

/** English search vocabulary shared by Wikimedia, Pexels and Pixabay. */
export const EVENT_IMAGE_LIBRARY_CATEGORY_SEARCH_TERMS = Object.freeze({
  musica: Object.freeze(['live music concert', 'music stage', 'musical instruments']),
  'teatro-spettacolo': Object.freeze(['theatre stage performance', 'performing arts', 'theater interior']),
  'mostra-museo': Object.freeze(['museum exhibition', 'art gallery interior', 'cultural exhibition']),
  cinema: Object.freeze(['cinema theater', 'movie theater interior', 'film screening']),
  'festa-sagra-tradizione': Object.freeze(['Swiss traditional festival', 'local cultural festival', 'Swiss celebration']),
  'mercato-natale': Object.freeze(['Christmas market', 'Swiss market stalls', 'winter market']),
  gastronomia: Object.freeze(['Swiss food market', 'local cuisine', 'food festival']),
  sport: Object.freeze(['outdoor sports', 'sports activity', 'Swiss sports landscape']),
  'natura-escursione': Object.freeze(['hiking trail', 'nature landscape', 'outdoor excursion']),
  'famiglia-bambini': Object.freeze(['family park', 'children playground', 'family outdoor activity']),
  'conferenza-formazione': Object.freeze(['conference hall', 'lecture auditorium', 'education workshop']),
  generico: Object.freeze(['Swiss local event', 'cultural event', 'Swiss gathering']),
});

export const EVENT_IMAGE_LIBRARY_AREA_SEARCH_TERMS = Object.freeze({
  'ticino-confine': Object.freeze([
    'Lugano Ticino Switzerland',
    'Locarno Ticino Switzerland',
    'Bellinzona Ticino Switzerland',
    'Mendrisio Ticino Switzerland',
    'Como Italy Switzerland border',
    'Varese Italy Switzerland border',
  ]),
  'svizzera-urbana': Object.freeze([
    'Zurich Switzerland',
    'Bern Switzerland',
    'Basel Switzerland',
    'Geneva Switzerland',
    'Lausanne Switzerland',
    'Lucerne Switzerland',
    'St Gallen Switzerland',
  ]),
  'alpi-montagna': Object.freeze([
    'Swiss Alps',
    'Zermatt Switzerland',
    'Engadin Switzerland',
    'Valais Switzerland',
    'Graubunden Switzerland',
    'Davos Switzerland',
  ]),
  laghi: Object.freeze([
    'Lake Lugano Switzerland',
    'Lake Maggiore Switzerland',
    'Lake Geneva Switzerland',
    'Lake Zurich Switzerland',
    'Lake Lucerne Switzerland',
    'Lake Neuchatel Switzerland',
  ]),
});

export const EVENT_IMAGE_LIBRARY_SEASON_SEARCH_TERMS = Object.freeze({
  'primavera-estate': Object.freeze(['spring summer']),
  'autunno-inverno': Object.freeze(['autumn winter']),
});

function searchTermKey(value, terms, fallback, labels = {}) {
  const folded = fold(value);
  if (terms[folded]) return folded;
  return Object.keys(terms).find((key) => folded.includes(fold(key)) || folded === fold(labels[key])) || fallback;
}

/** Build a stable, most-specific-first query set for all licensed photo APIs. */
export function eventImagePhotoSearchQueries({ category, area, season } = {}) {
  const categoryKey = searchTermKey(category, EVENT_IMAGE_LIBRARY_CATEGORY_SEARCH_TERMS, 'generico');
  const areaKey = searchTermKey(area, EVENT_IMAGE_LIBRARY_AREA_SEARCH_TERMS, 'ticino-confine', AREA_LABELS);
  const seasonKey = searchTermKey(season, EVENT_IMAGE_LIBRARY_SEASON_SEARCH_TERMS, 'primavera-estate');
  const categoryTerms = EVENT_IMAGE_LIBRARY_CATEGORY_SEARCH_TERMS[categoryKey];
  const areaTerms = EVENT_IMAGE_LIBRARY_AREA_SEARCH_TERMS[areaKey];
  const seasonTerm = EVENT_IMAGE_LIBRARY_SEASON_SEARCH_TERMS[seasonKey][0];
  const primaryCategory = categoryTerms[0];
  const primaryArea = areaTerms[0];
  return [...new Set([
    ...areaTerms.slice(0, 4).map((place) => `${primaryCategory} ${place} ${seasonTerm}`),
    `${categoryTerms[1] || primaryCategory} ${primaryArea} ${seasonTerm}`,
    `${primaryCategory} ${primaryArea} ${seasonTerm} photograph`,
    `${primaryArea} ${seasonTerm} landscape photograph`,
    `${primaryCategory} ${primaryArea}`,
    `${primaryCategory} Switzerland ${seasonTerm}`,
    `${primaryArea} Switzerland landscape photograph`,
    `Switzerland ${seasonTerm} landscape photograph`,
  ])];
}

const URBAN_CANTONS = new Set(['ZH', 'GE', 'BS', 'BL', 'VD', 'BE', 'AG', 'SG', 'LU', 'ZG', 'SO']);
const ALPINE_CANTONS = new Set(['GR', 'VS', 'UR', 'OW', 'NW', 'GL', 'AI', 'AR']);
const LAKE_CANTONS = new Set(['SZ', 'TG', 'NE', 'FR', 'JU', 'SH']);

function fold(value) {
  return String(value ?? '')
    .toLocaleLowerCase('it-CH')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return [
      value.category,
      value.title,
      value.description,
      value.region,
      value.venue,
      value.comune,
      value.address?.locality,
    ].filter(Boolean).join(' ');
  }
  return '';
}

export function normalizeEventImageCategory(value) {
  const folded = fold(textOf(value));
  if (!folded || folded === 'event' || folded === 'events' || folded === 'appuntamento') return 'generico';
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => folded.includes(fold(keyword)))) return category;
  }
  return 'generico';
}

export function eventImageCategoryLabel(category) {
  return CATEGORY_LABELS[normalizeEventImageCategory(category)] || CATEGORY_LABELS.generico;
}

export function normalizeEventImageArea(eventOrArea) {
  if (typeof eventOrArea === 'string') {
    const explicit = fold(eventOrArea);
    const matched = EVENT_IMAGE_LIBRARY_AREAS.find((area) => fold(area) === explicit);
    if (matched) return matched;
  }
  const event = eventOrArea && typeof eventOrArea === 'object' ? eventOrArea : {};
  const canton = String(event.canton || event.cantonCode || '').trim().toUpperCase();
  if (canton === 'TI' || /ticino|tessin|lugan|locarno|mendrisi|bellinzon|como|varese/i.test(textOf(event))) return 'ticino-confine';
  if (URBAN_CANTONS.has(canton)) return 'svizzera-urbana';
  if (ALPINE_CANTONS.has(canton)) return 'alpi-montagna';
  if (LAKE_CANTONS.has(canton)) return 'laghi';
  return 'laghi';
}

export function eventImageSeason(startDate) {
  const month = Number(String(startDate || '').slice(5, 7));
  return month >= 3 && month <= 8 ? 'primavera-estate' : 'autunno-inverno';
}

/** A tiny stable hash that works in Node and in the browser without crypto imports. */
export function stableEventImageHash(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function eventImageLibrarySlots({ variants = 1 } = {}) {
  const slots = [];
  const variantCount = Math.max(1, Math.min(EVENT_IMAGE_LIBRARY_MAX_VARIANTS, Number(variants) || 1));
  for (const category of EVENT_IMAGE_LIBRARY_CATEGORIES) {
    for (const area of EVENT_IMAGE_LIBRARY_AREAS) {
      for (const season of EVENT_IMAGE_LIBRARY_SEASONS) {
        for (let variantIndex = 1; variantIndex <= variantCount; variantIndex += 1) {
          const variant = String(variantIndex).padStart(2, '0');
          slots.push({
            assetId: variantIndex === 1
              ? `event-${category}-${area}-${season}`
              : `event-${category}-${area}-${season}-v${variant}`,
            category,
            area,
            season,
            variant,
            subject: eventImageCategoryLabel(category),
            areaLabel: AREA_LABELS[area],
          });
        }
      }
    }
  }
  return slots;
}

export function eventImageLibraryVariantSlots() {
  return eventImageLibrarySlots({ variants: EVENT_IMAGE_LIBRARY_MAX_VARIANTS });
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.assets)) return value.assets;
  return [];
}

export function selectEventImageAsset(event, registry) {
  const records = recordsFrom(registry).filter((record) => record?.scope === 'event-library'
    && record?.imageUrl?.startsWith(EVENT_IMAGE_LIBRARY_PREFIX)
    && record?.assetId
    && (record?.license === GENERATED_IMAGE_LICENSE || isLicensedPhotoRecord(record))
    && validateGeneratedImageRecord(record).valid);
  if (!records.length) return null;
  const category = normalizeEventImageCategory(event);
  const area = normalizeEventImageArea(event);
  const season = eventImageSeason(event?.startDate);
  const exact = records.filter((record) => record.category === category && record.area === area && record.season === season);
  const sameCategoryArea = records.filter((record) => record.category === category && record.area === area);
  const sameCategory = records.filter((record) => record.category === category);
  const fallback = records.filter((record) => record.category === 'generico' && record.area === area && record.season === season);
  const candidates = exact.length ? exact : sameCategoryArea.length ? sameCategoryArea : sameCategory.length ? sameCategory : fallback;
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
  const index = stableEventImageHash(`${event?.id || ''}|${category}|${area}|${season}`) % sorted.length;
  return sorted[index];
}

function hasLicensedSourceImage(event, sourceImageAllowed) {
  if (typeof sourceImageAllowed === 'function') return sourceImageAllowed(event) === true;
  return event?.sourceKey === 'openagenda'
    && typeof event?.imageUrl === 'string'
    && event.imageUrl.startsWith('/images/events/openagenda-')
    && typeof event?.imageCredit === 'string'
    && event.imageCredit.trim() !== ''
    && typeof event?.imageLicense === 'string'
    && event.imageLicense.trim() !== ''
    && typeof event?.imageLicenseUrl === 'string'
    && /^https:\/\//i.test(event.imageLicenseUrl);
}

/** Apply the one assignment algorithm at a dataset/render boundary. */
export function assignEventImageAsset(event, registry, { sourceImageAllowed } = {}) {
  if (!event || typeof event !== 'object') return event;
  if (hasLicensedSourceImage(event, sourceImageAllowed)) return event;
  const selected = selectEventImageAsset(event, registry);
  if (!selected) {
    const {
      imageUrl: _imageUrl,
      imageAssetId: _imageAssetId,
      imageLicense: _imageLicense,
      imageLicenseUrl: _imageLicenseUrl,
      imageCredit: _imageCredit,
      imageProvider: _imageProvider,
      imageAuthor: _imageAuthor,
      imageSourcePageUrl: _imageSourcePageUrl,
      imageCopyrightNotice: _imageCopyrightNotice,
      imageAcquireLicensePage: _imageAcquireLicensePage,
      imageModifications: _imageModifications,
      ...withoutImage
    } = event;
    return withoutImage;
  }
  const licensedPhoto = isLicensedPhotoRecord(selected);
  return {
    ...event,
    imageUrl: selected.imageUrl,
    imageAssetId: selected.assetId,
    imageLicense: licensedPhoto ? selected.license : GENERATED_IMAGE_LICENSE,
    imageLicenseUrl: selected.licenseUrl,
    imageCredit: licensedPhoto ? selected.credit : GENERATED_IMAGE_CREDIT,
    imageProvider: selected.provider,
    ...(licensedPhoto ? {
      imageAuthor: selected.author,
      imageSourcePageUrl: selected.sourcePageUrl || selected.pageUrl,
      imageCopyrightNotice: selected.copyrightNotice,
      imageAcquireLicensePage: selected.acquireLicensePage,
      ...(selected.modifications ? { imageModifications: selected.modifications } : {}),
    } : {}),
  };
}
