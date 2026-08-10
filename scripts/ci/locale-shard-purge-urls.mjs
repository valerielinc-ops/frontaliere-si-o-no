#!/usr/bin/env node
/**
 * The bounded purge list for ONE locale shard, apex AND origin (#5483).
 *
 * WHAT WAS MISSING. deploy.yml's `build-locale` job force-pushes the en/de/fr
 * shard to `frontaliere-<loc>` and purged NOTHING — not the apex, not the
 * origin. Verified on main before this landed:
 *
 *   git show origin/main:.github/workflows/deploy.yml | grep -c cf-purge-cache  →  0
 *
 * So every deploy left the hottest page of each non-IT locale served from the
 * PREVIOUS build for up to the Worker's ORIGIN_CACHE_TTL (7200s). Measured on
 * /de/: 9 internal links served against the 45 the freshly-pushed origin
 * carried — 36 destinations that existed and were unreachable from the page
 * that links to them.
 *
 * And an apex-only purge would NOT have fixed it: the entry a visitor is served
 * for a Worker-routed path is keyed on the shard origin host. See
 * scripts/lib/cf-worker-routes.mjs for the measurement that establishes it, and
 * .github/workflows/rerender-article-hubs.yml for the one caller that already
 * did this correctly (for the article hubs only).
 *
 * ─── WHY THIS LIST AND NOT "EVERY PAGE THIS DEPLOY TOUCHED" ──────────────────
 * The free-plan `files` purge takes 30 URLs per call and a locale shard is
 * hundreds of thousands of pages, so purging what changed is not an option; the
 * only question is which bounded set is worth the call. The same reasoning
 * rerender-article-hubs.yml already wrote down: deep pages heal on their own
 * (they are MISS right after a push and re-fetch the new bytes), so what is
 * worth a slot is the set that is hot enough to HOLD an entry and that carries
 * the internal-link graph — the locale home plus its pillar hubs.
 *
 * Both root forms are listed because they are two entries, not one: the Worker
 * has an exact route for the bare `/de` and GitHub Pages answers it with a 301
 * that `cacheEverything` stores like any other response.
 *
 * ─── THE FILTER THAT IS NOT OPTIONAL ─────────────────────────────────────────
 * A locale path is NOT automatically served by origin-<loc>. SECTION_ROUTES
 * re-targets `/de/jobs-im-tessin/…` to origin-ticino-de, and — the one that
 * would actually have bitten — SLUG_TABLES.de.blog is 'grenzgaenger-artikel',
 * which is the articolifrontaliere SECTION prefix. Naming it here would emit a
 * purge for a host that never held that entry: a ✅ that means nothing, which
 * is the exact class of defect this issue is about. Every candidate is passed
 * through the Worker's own table rather than through a hand-kept exclusion.
 *
 * Every landing is additionally required to EXIST in the pushed shard tree, so
 * a slug that this build did not emit costs no slot and produces no misleading
 * success line.
 *
 * Usage:
 *   node scripts/ci/locale-shard-purge-urls.mjs <en|de|fr> [distDir]
 * prints the comma-joined URL list on stdout (ready for `--files=`), diagnostics
 * on stderr. Empty stdout = nothing to purge, which is a normal outcome.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SLUG_TABLES } from '../../services/routeSlugs.data.ts';
import { SECTION_ROUTES, SHARD_ORIGIN } from '../../infra/cloudflare-worker/locale-router.js';
import { MAX_TARGETED_FILES } from '../lib/cf-purge-limits.mjs';
import { APEX_HOST } from '../lib/cf-worker-routes.mjs';

/**
 * SlugTable keys for the locale's pillar hubs: the six primary-nav sections
 * that the locale home links to and that link onward into the shard, plus the
 * glossary (the densest single outbound-link page in a locale).
 *
 * Deliberately NOT `blog`/`blogCh`: those resolve to the two article SECTION
 * prefixes and are served by origin-articoli*-<loc>, whose freshness is already
 * closed by rerender-article-hubs.yml.
 */
export const LANDING_SLUG_KEYS = [
  'calcolatore',
  'confronti',
  'fisco',
  'guida',
  'vita',
  'stats',
  'glossario',
];

export const SHARD_LOCALES = Object.keys(SHARD_ORIGIN);

/** True when the Worker re-targets this path to a SECTION shard origin. */
export function isSectionPath(pathname) {
  return SECTION_ROUTES.some(
    (route) =>
      pathname === route.prefix ||
      pathname === `${route.prefix}.html` ||
      pathname.startsWith(`${route.prefix}/`),
  );
}

/**
 * The apex paths worth purging after this locale's shard push.
 *
 * `distDir` is the built shard tree (deploy.yml passes `dist`, whose
 * `<locale>/` subtree is exactly what push-locale-shard.sh copied into the
 * shard repo). Pass null to skip the existence check — the shape the test uses,
 * since it asserts the SELECTION, not one runner's build output.
 */
export function localeShardPurgePaths(locale, distDir = null) {
  if (!SHARD_ORIGIN[locale]) throw new Error(`unsupported shard locale '${locale}' (expected ${SHARD_LOCALES.join('|')})`);
  const emitted = (rel) => distDir === null || existsSync(path.join(distDir, rel));

  if (!emitted(path.join(locale, 'index.html'))) return [];
  const paths = [`/${locale}`, `/${locale}/`];

  const table = SLUG_TABLES[locale];
  for (const key of LANDING_SLUG_KEYS) {
    const slug = table?.[key];
    if (!slug) continue;
    const pathname = `/${locale}/${slug}/`;
    if (isSectionPath(pathname)) continue;
    if (!emitted(path.join(locale, slug, 'index.html'))) continue;
    paths.push(pathname);
  }
  return paths;
}

/**
 * Apex + shard-origin URL for every selected path.
 *
 * The apex half is not redundant with the origin half: the Worker warms an
 * APEX-keyed copy in the Cache API on every happy-path 200, and that copy is
 * what the fail-open / stale-if-error paths serve. Purging one and not the
 * other leaves whichever half was skipped on the previous build.
 */
export function localeShardPurgeUrls(locale, distDir = null) {
  const origin = SHARD_ORIGIN[locale];
  return localeShardPurgePaths(locale, distDir).flatMap((pathname) => [
    `https://${APEX_HOST}${pathname}`,
    `https://${origin}${pathname}`,
  ]);
}

function main() {
  const [locale, distDir = null] = process.argv.slice(2);
  if (!locale) {
    console.error('Usage: locale-shard-purge-urls.mjs <en|de|fr> [distDir]');
    process.exit(1);
  }
  const urls = localeShardPurgeUrls(locale, distDir);
  if (urls.length === 0) {
    console.error(`[locale-shard-purge-urls] ${locale}: no shard landing found under ${distDir}/${locale} — nothing to purge`);
    return;
  }
  // A hard error, never a truncation: a silently dropped URL is a page left
  // stale with no signal, the same posture cf-purge-cache.mjs takes on its cap.
  if (urls.length > MAX_TARGETED_FILES) {
    console.error(
      `[locale-shard-purge-urls] ${locale}: ${urls.length} URLs is over the ${MAX_TARGETED_FILES}-URL cap. ` +
        'Shrink LANDING_SLUG_KEYS or batch the call — do not truncate.',
    );
    process.exit(1);
  }
  console.error(`[locale-shard-purge-urls] ${locale}: ${urls.length}/${MAX_TARGETED_FILES} URLs (${urls.length / 2} paths × apex+origin)`);
  process.stdout.write(urls.join(','));
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
