#!/usr/bin/env node
/**
 * Batched purge URL lists for SECTION shards just pushed, apex AND origin
 * (#5513, following the same shape locale-shard-purge-urls.mjs established
 * for locale shards under #5483/#5511).
 *
 * WHAT WAS MISSING. deploy.yml's "Push section shards" steps (both legs)
 * force-push the section's shard repo and purged nothing — same class of bug
 * #5511 closed for locale shards, left open there deliberately because it
 * doesn't fit the same shape: a locale shard purge is a fixed 9-path list
 * (18 URLs), well under the free-plan 30-URL `files` purge cap. A section
 * fan-out is dozens of sections × 2 hosts (apex + origin-<section>-<loc>) per
 * leg — hundreds of URLs, always over the cap — so a single `--files=` call
 * cannot cover it; it needs the list split into ≤30-URL batches, one purge
 * call per batch.
 *
 * WHY ONLY THE SECTION ROOT. Same reasoning as locale-shard-purge-urls.mjs
 * and rerender-article-hubs.yml: deep pages are a MISS right after a push and
 * re-fetch the new bytes on their own, so the only thing worth a purge slot
 * is the page hot enough to HOLD a stale entry — the section's own landing.
 * Both root forms (bare + trailing slash) are purged because they are two
 * distinct cache entries, not one: the Worker has an exact route for the bare
 * prefix and GitHub Pages answers it with a 301 that `cacheEverything` stores
 * like any other response.
 *
 * WHY apex AND origin. The entry a visitor is served for a Worker-routed path
 * is keyed on the section's shard origin host (locale-router.js's
 * serveShard()), not the apex — an apex-only purge answers 200 and changes
 * nothing. See scripts/lib/cf-worker-routes.mjs / tests/cf-purge-origin-keyed.test.ts
 * for the measurement that established this for the locale case; the
 * mechanism is identical for section shards (SECTION_ORIGIN instead of
 * SHARD_ORIGIN).
 *
 * Usage:
 *   node scripts/ci/section-shard-purge-urls.mjs <locale> <section...>
 * prints ONE batch's comma-joined URL list per line on stdout (ready to feed
 * one at a time to `cf-purge-cache.mjs --files=`), diagnostics on stderr.
 * A section/locale pair the Worker has no route for is a hard error — not
 * something the caller should ever pass (the CI caller only names sections
 * that just pushed successfully), so a typo surfaces immediately.
 */
import path from 'node:path';
import { SECTION_ORIGIN, SECTION_ROUTES } from '../../infra/cloudflare-worker/locale-router.js';
import { MAX_TARGETED_FILES } from '../lib/cf-purge-limits.mjs';
import { APEX_HOST } from '../lib/cf-worker-routes.mjs';
import { batch } from './purge-changed-cdn-assets.mjs';

export const SECTION_KEYS = Object.keys(SECTION_ORIGIN);

function findRoute(section, locale) {
  return SECTION_ROUTES.find((route) => route.section === section && route.locale === locale) ?? null;
}

/** The root path of `section`'s landing in `locale`, bare + trailing-slash. */
export function sectionShardPurgePaths(section, locale) {
  const route = findRoute(section, locale);
  if (!route) throw new Error(`unsupported section/locale '${section}/${locale}' — no SECTION_ROUTES entry`);
  return [route.prefix, `${route.prefix}/`];
}

/** Apex + section-shard-origin URL for `section`'s root path in `locale`. */
export function sectionShardPurgeUrls(section, locale) {
  const origin = SECTION_ORIGIN[section]?.[locale];
  if (!origin) throw new Error(`unsupported section/locale '${section}/${locale}' — no SECTION_ORIGIN entry`);
  return sectionShardPurgePaths(section, locale).flatMap((pathname) => [
    `https://${APEX_HOST}${pathname}`,
    `https://${origin}${pathname}`,
  ]);
}

/**
 * URLs for every section in `sections` (all pushed this run, for `locale`),
 * split into batches of at most `size` — the cap `cf-purge-cache.mjs --files=`
 * enforces, so a caller can feed each batch to a separate call.
 */
export function sectionShardPurgeBatches(sections, locale, size = MAX_TARGETED_FILES) {
  const urls = sections.flatMap((section) => sectionShardPurgeUrls(section, locale));
  return batch(urls, size);
}

function main() {
  const [locale, ...sections] = process.argv.slice(2);
  if (!locale || sections.length === 0) {
    console.error('Usage: section-shard-purge-urls.mjs <locale> <section...>');
    process.exit(1);
  }
  const batches = sectionShardPurgeBatches(sections, locale);
  console.error(
    `[section-shard-purge-urls] ${locale}: ${sections.length} section(s) → ${batches.length} batch(es) of ≤${MAX_TARGETED_FILES} URLs`,
  );
  for (const urls of batches) process.stdout.write(`${urls.join(',')}\n`);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
