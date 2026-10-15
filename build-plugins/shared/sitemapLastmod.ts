import { sourceDateIso } from '../../services/dataFreshness';

/** Only call with a substantive source update, never a crawl or build clock. */
export function renderSitemapLastmod(sourceModifiedAt?: string | null): string {
  const iso = sourceDateIso(sourceModifiedAt);
  return iso ? `<lastmod>${iso.slice(0, 10)}</lastmod>` : '';
}
