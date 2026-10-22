import { matchExistingCrawler } from '../crawler-source-hosts.mjs';

/**
 * A vacancy overlap is terminal duplicate evidence only when the complete
 * runtime population was observed. URLs from a partial fetch can overlap a
 * real crawler by chance and must leave the candidate retryable.
 *
 * @param {string[]} urls
 * @param {any} ownership
 * @param {{ threshold?: number, exclude?: string }} [options]
 * @param {{ complete?: boolean }|null|undefined} observation
 */
export function matchExistingCrawlerForCompleteSnapshot(urls, ownership, options = {}, observation) {
  if (observation?.complete !== true) return null;
  return matchExistingCrawler(urls, ownership, options);
}
