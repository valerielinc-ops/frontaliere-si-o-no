/** Identity and scope of the listing inventory, shared by SEO and the SPA. */
import { expandCantonGroup } from './cantonList';

export interface ListingInventoryJob {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  company?: unknown;
  canton?: string | null;
}

export function listingInventoryId(job: ListingInventoryJob): string {
  const company = String(job.company || '').trim() || 'Azienda';
  const title = String(job.title || '').trim();
  return String(job.id || job.slug || `${company}-${title}`);
}

export function selectJobBoardInventory<T extends ListingInventoryJob>(jobs: readonly T[], canton: string): T[] {
  const members = new Set(expandCantonGroup(canton));
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (canton !== '_AGGREGATE_' && !members.has(String(job.canton || ''))) return false;
    const id = listingInventoryId(job);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
