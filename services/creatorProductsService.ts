import { getLocale, type Locale } from '@/services/i18n';

export interface CreatorProduct {
  id: string;
  asin: string;
  title: string;
  category: string;
  emoji: string;
  keywordTags: string[];
  payoutPriority: number; // 1-10 (higher = higher expected payout)
  searchQuery: string;
}

const DEFAULT_AMAZON_PARTNER_TAG = 'luigi066-21';

const MARKETPLACE_BY_LOCALE: Record<Locale, string> = {
  it: 'https://www.amazon.it',
  en: 'https://www.amazon.it',
  de: 'https://www.amazon.it',
  fr: 'https://www.amazon.it',
};

const CREATOR_PRODUCTS: CreatorProduct[] = [
  {
    id: 'trading-book',
    asin: '8820383550',
    title: 'Investimenti e finanza personale (libro)',
    category: 'finance',
    emoji: '📈',
    keywordTags: ['cambio', 'chf', 'eur', 'investimenti', 'risparmio', 'borsa', 'frontalieri'],
    payoutPriority: 9,
    searchQuery: 'investimenti finanza personale libro',
  },
  {
    id: 'tax-guide-book',
    asin: '8891657401',
    title: 'Guida fiscale pratica (libro)',
    category: 'tax',
    emoji: '🧾',
    keywordTags: ['tasse', 'irpef', 'credito', 'imposta', 'dichiarazione', '730', 'frontaliere'],
    payoutPriority: 8,
    searchQuery: 'guida fiscale dichiarazione redditi 730 libro',
  },
  {
    id: 'language-course',
    asin: '8869875968',
    title: 'Corso tedesco/francese per lavoro (libro)',
    category: 'career',
    emoji: '🗣️',
    keywordTags: ['lavoro', 'colloquio', 'cv', 'career', 'job', 'tedesco', 'francese'],
    payoutPriority: 8,
    searchQuery: 'corso tedesco lavoro libro',
  },
  {
    id: 'home-office-kit',
    asin: 'B0CKN3TNM3',
    title: 'Supporto laptop + ergonomia home office',
    category: 'productivity',
    emoji: '💻',
    keywordTags: ['smart working', 'lavoro', 'ufficio', 'casa', 'produttività'],
    payoutPriority: 7,
    searchQuery: 'kit ergonomia home office',
  },
  {
    id: 'dashcam',
    asin: 'B0CF9YV5SL',
    title: 'Dashcam per pendolari',
    category: 'transport',
    emoji: '🚗',
    keywordTags: ['traffico', 'frontiera', 'auto', 'pendolare', 'viaggio', 'trasporto'],
    payoutPriority: 7,
    searchQuery: 'dashcam auto full hd',
  },
  {
    id: 'travel-backpack',
    asin: 'B09YVCSLSN',
    title: 'Zaino business viaggio',
    category: 'travel',
    emoji: '🎒',
    keywordTags: ['trasporto', 'lavoro', 'frontalieri', 'viaggio', 'treno'],
    payoutPriority: 6,
    searchQuery: 'zaino business laptop viaggio',
  },
  {
    id: 'tax-software',
    asin: 'B0BGQ7KHYH',
    title: 'Organizzazione documenti fiscali',
    category: 'tax',
    emoji: '📂',
    keywordTags: ['fiscale', 'documenti', 'scadenze', 'dichiarazione', 'moduli'],
    payoutPriority: 8,
    searchQuery: 'software gestione documenti fiscali',
  },
  {
    id: 'budget-planner',
    asin: 'B0B9S4Y4RN',
    title: 'Planner budget annuale',
    category: 'budget',
    emoji: '📒',
    keywordTags: ['budget', 'risparmio', 'stipendio', 'spese', 'franchi', 'euro'],
    payoutPriority: 7,
    searchQuery: 'planner budget mensile agenda',
  },
];


function buildAmazonAffiliateUrl(asin: string, locale: Locale, partnerTag: string): string {
  const marketplace = MARKETPLACE_BY_LOCALE[locale] || MARKETPLACE_BY_LOCALE.it;
  return `${marketplace}/dp/${asin}?tag=${encodeURIComponent(partnerTag)}&linkCode=ll1`;
}

function buildAmazonSearchAffiliateUrl(query: string, locale: Locale, partnerTag: string): string {
  const marketplace = MARKETPLACE_BY_LOCALE[locale] || MARKETPLACE_BY_LOCALE.it;
  const q = query.trim() || 'frontalieri svizzera italia';
  return `${marketplace}/s?k=${encodeURIComponent(q)}&tag=${encodeURIComponent(partnerTag)}&linkCode=ll2`;
}

function buildAmazonImageUrl(asin: string): string {
  const safeAsin = asin.trim();
  // Amazon public CDN pattern (small thumbnail), no API required.
  return `https://images-na.ssl-images-amazon.com/images/P/${encodeURIComponent(safeAsin)}.01._SL160_.jpg`;
}

function isValidAmazonAffiliateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const validHost = host.endsWith('amazon.it') || host.endsWith('amazon.fr');
    const hasTag = Boolean(parsed.searchParams.get('tag'));
    const isSearch = parsed.pathname === '/s' && Boolean(parsed.searchParams.get('k'));
    const isDp = /\/dp\/[A-Z0-9]{8,12}/i.test(parsed.pathname);
    return validHost && hasTag && (isSearch || isDp);
  } catch {
    return false;
  }
}

export interface CreatorProductSuggestion extends CreatorProduct {
  score: number;
  url: string;
  partnerTag: string;
  query: string;
  imageUrl: string;
  keywordHits: number;
}

interface CreatorProductInput {
  contextText: string;
  maxCards?: number;
}

function simpleHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getCreatorProductsForContext({
  contextText,
  maxCards = 2,
}: CreatorProductInput): CreatorProductSuggestion[] {
  const locale = getLocale();
  const normalized = contextText.toLowerCase();
  const partnerTag = DEFAULT_AMAZON_PARTNER_TAG;

  const scored = CREATOR_PRODUCTS.map((product) => {
    const keywordHits = product.keywordTags.reduce((acc, tag) => (normalized.includes(tag) ? acc + 1 : acc), 0);
    const score = keywordHits * 100 + product.payoutPriority * 3;
    const contextualQuery =
      keywordHits > 0
        ? `${product.searchQuery} ${product.keywordTags.filter((tag) => normalized.includes(tag)).slice(0, 2).join(' ')}`
        : product.searchQuery;
    const searchUrl = buildAmazonSearchAffiliateUrl(contextualQuery, locale, partnerTag);
    const fallbackDpUrl = buildAmazonAffiliateUrl(product.asin, locale, partnerTag);
    const url = isValidAmazonAffiliateUrl(searchUrl) ? searchUrl : fallbackDpUrl;
    return {
      ...product,
      score,
      url,
      partnerTag,
      query: contextualQuery.trim(),
      imageUrl: buildAmazonImageUrl(product.asin),
      keywordHits,
    };
  });

  const maxHits = scored.reduce((m, p) => Math.max(m, p.keywordHits), 0);
  const pool = maxHits > 0 ? scored.filter((p) => p.keywordHits > 0) : scored;

  const sorted = pool.sort((a, b) => b.score - a.score);
  const pickCount = Math.max(1, Math.min(maxCards, sorted.length));
  const rotationPoolSize = Math.min(sorted.length, Math.max(pickCount * 3, 6));
  const rotationPool = sorted.slice(0, rotationPoolSize);
  const dayKey = new Date().toISOString().slice(0, 10);
  const rotationStart = simpleHash(`${dayKey}|${locale}|${normalized}`) % rotationPool.length;
  const ranked: CreatorProductSuggestion[] = [];
  for (let i = 0; i < pickCount; i += 1) {
    ranked.push(rotationPool[(rotationStart + i) % rotationPool.length]);
  }

  return ranked;
}
