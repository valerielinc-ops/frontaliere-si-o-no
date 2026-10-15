/** Identity and scope of the listing inventory, shared by SEO and the SPA. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expandCantonGroup } from './cantonList';
import { DEFAULT_CANTON_DISPLAY, slugifyJobPart } from './relatedSearchClusters';

export interface ListingInventoryJob {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  company?: unknown;
  canton?: string | null;
  location?: unknown;
  addressLocality?: unknown;
}

// Foreign country/city keywords — jobs matching these are EXCLUDED entirely.
// These are locations outside Switzerland that should never appear on a Swiss job board.
const FOREIGN_LOCATION_KEYWORDS = [
 'london', 'paris', 'milan', 'milano', 'berlin', 'munich', 'münchen',
 'frankfurt', 'hamburg', 'vienna', 'wien', 'madrid', 'barcelona',
 'amsterdam', 'brussels', 'bruxelles', 'stockholm', 'oslo', 'copenhagen',
 'tokyo', 'beijing', 'shanghai', 'singapore', 'bangkok', 'mumbai',
 'dubai', 'new york', 'los angeles', 'toronto', 'sydney', 'melbourne',
 'rome', 'roma', 'napoli', 'torino', 'bologna', 'genova', 'palermo',
 'venezia', 'florence', 'firenze', 'kuala lumpur', 'luxembourg',
 'jersey',
 'united kingdom', 'germany', 'france', 'netherlands', 'belgium',
 'austria', 'ireland', 'denmark', 'norway', 'sweden', 'finland',
 'portugal', 'spain', 'poland', 'czech', 'romania', 'hungary',
 'croatia', 'greece', 'japan', 'china', 'india', 'thailand',
 'philippines', 'indonesia', 'malaysia', 'vietnam', 'south korea',
 'taiwan', 'hong kong', 'australia', 'new zealand', 'canada',
 'united states', 'mexico', 'brazil', 'argentina', 'chile',
 'south africa', 'nigeria', 'kenya', 'egypt', 'israel', 'qatar',
 'saudi arabia', 'bahrain', 'liechtenstein',
 'ruggell', 'barberà del vallès', 'barbera del valles',
];
// Swiss cities that contain substrings of foreign city names (e.g. Münchenstein contains München)
const SWISS_FALSE_POSITIVE_GUARD = ['münchenstein', 'münchenbuchsee', 'münchenwiler', 'romanshorn', 'romandie'];
export const isForeignLocation = (locality: string) => {
 const lower = locality.toLowerCase();
 if (SWISS_FALSE_POSITIVE_GUARD.some(s => lower.includes(s))) return false;
 return FOREIGN_LOCATION_KEYWORDS.some(kw => lower.includes(kw));
};

/** Listing identity is independent of description/detail indexability. */
export function isListingInventoryJob(value: unknown): value is ListingInventoryJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as ListingInventoryJob;
  return typeof job.title === 'string' && job.title.trim().length > 0
    && typeof job.company === 'string' && job.company.trim().length > 0
    && !isForeignLocation(String(job.addressLocality || job.location || ''));
}

export function listingInventoryId(job: ListingInventoryJob): string {
  const company = String(job.company || '').trim() || 'Azienda';
  const title = String(job.title || '').trim();
  if (job.id || job.slug) return String(job.id || job.slug);
  // This ID also names a JSON asset: source text may contain slashes, query
  // delimiters or exceed the filesystem's segment limit. Hash only the legacy
  // fallback identity so explicit IDs/slugs and dedup equivalence are retained.
  return `listing-${bytesToHex(sha256(new TextEncoder().encode(`${company}-${title}`)))}`;
}

/** Persist the same route fallback before locale flattening or SPA defaults. */
export function normalizeListingIdentity<T extends ListingInventoryJob>(job: T): T & { id: string; slug: string } {
  const title = String(job.title || '').trim();
  const company = String(job.company || '').trim();
  const location = String(job.location || '').trim() || DEFAULT_CANTON_DISPLAY;
  return {
    ...job,
    // Compute identity before adding a derived slug, preserving dedup semantics.
    id: listingInventoryId(job),
    slug: String(job.slug || '').trim()
      || slugifyJobPart(`${title}-${company}-${location}`)
      || slugifyJobPart(title),
  };
}

export function selectJobBoardInventory<T extends ListingInventoryJob>(jobs: readonly T[], canton: string): T[] {
  const members = new Set(expandCantonGroup(canton));
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (!isListingInventoryJob(job)) return false;
    if (canton !== '_AGGREGATE_' && !members.has(String(job.canton || ''))) return false;
    const id = listingInventoryId(job);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
