/**
 * A purge of a Worker-routed apex path must name the ORIGIN key too (#5483).
 *
 * ─── The defect this encodes ─────────────────────────────────────────────────
 * locale-router.js's serveShard() rewrites the upstream Host to a shard origin
 * and fetches it with `cf: { cacheEverything: true, cacheTtl: 7200 }`. For every
 * path on a Cloudflare Worker route the entry a visitor is served is therefore
 * keyed on `origin-<shard>.frontaliereticino.ch/<path>`, and a
 * `files: ['https://frontaliereticino.ch/<path>']` purge answers 200, prints a
 * ✅, and clears an entry nobody reads.
 *
 * The proof is arithmetic, not "it stayed HIT" — a successful purge followed by
 * an immediate refill has the same signature as a blind one, which is what sent
 * this issue's first diagnosis (and PR #5486) after `Vary: Accept-Encoding`.
 * cf-locale-failover-setup.mjs pins the apex rule to APEX_EDGE_TTL_SECONDS=300
 * and /cerca-lavoro-ticino/ was measured at `age 6333`: 21× that TTL and under
 * the Worker's 7200s ORIGIN_CACHE_TTL. No apex-governed entry can be that old.
 *
 * ─── Why a test and not a comment ────────────────────────────────────────────
 * rerender-article-hubs.yml has done the right thing since #5001, in shell, by
 * hand, with a comment explaining it — and nothing obliged any other caller to
 * follow. deploy.yml's `build-locale` then shipped every en/de/fr shard with no
 * purge at all for months, and the gap was invisible because the thing it
 * violates has no import to follow: the contract lives in wrangler.toml and is
 * consumed by shell. That is the same "contract with no import shape" that let
 * SiteShellContract break the article pages behind a green CI.
 *
 * So this file binds the two ends together: wrangler.toml's route list on one
 * side, the purge lists the deploy actually emits on the other.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APEX_HOST,
  apexPurgeBlindSpots,
  readWorkerRoutePatterns,
  routePatternMatches,
  shardOriginForApexUrl,
  workerRouteForUrl,
} from '../scripts/lib/cf-worker-routes.mjs';
import {
  LANDING_SLUG_KEYS,
  SHARD_LOCALES,
  isSectionPath,
  localeShardPurgePaths,
  localeShardPurgeUrls,
} from '../scripts/ci/locale-shard-purge-urls.mjs';
import {
  SECTION_KEYS,
  sectionShardPurgeBatches,
  sectionShardPurgePaths,
  sectionShardPurgeUrls,
} from '../scripts/ci/section-shard-purge-urls.mjs';
import { MAX_TARGETED_FILES } from '../scripts/lib/cf-purge-limits.mjs';
import { SECTION_ORIGIN, SECTION_ROUTES, SHARD_ORIGIN } from '../infra/cloudflare-worker/locale-router.js';
import { SLUG_TABLES } from '../services/routeSlugs.data.ts';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf-8');
const DEPLOY = read('.github/workflows/deploy.yml');

describe('the Worker route table is readable, and says what is apex-keyed', () => {
  const patterns = readWorkerRoutePatterns();

  it('parses the real routes and not the prose around them', () => {
    // wrangler.toml is mostly comment, and those comments quote route shapes.
    expect(patterns.length).toBeGreaterThan(40);
    expect(patterns).toContain('frontaliereticino.ch/de/*');
    expect(patterns).toContain('frontaliereticino.ch/cerca-lavoro-ticino*');
    expect(patterns.every((p) => p.startsWith(`${APEX_HOST}/`))).toBe(true);
  });

  it('claims the shard paths and leaves the IT passthrough alone', () => {
    const routed = (u: string) => workerRouteForUrl(new URL(u), patterns) !== null;
    // Worker-routed → the served entry is origin-keyed, an apex purge is blind.
    expect(routed('https://frontaliereticino.ch/de/')).toBe(true);
    expect(routed('https://frontaliereticino.ch/de')).toBe(true);
    expect(routed('https://frontaliereticino.ch/cerca-lavoro-ticino/pagina/')).toBe(true);
    // Passthrough → apex-keyed, and a per-URL purge there is the real one
    // (measured: `/` at age 153 against the 300s apex TTL).
    expect(routed('https://frontaliereticino.ch/')).toBe(false);
    expect(routed('https://frontaliereticino.ch/blog/qualcosa/')).toBe(false);
    expect(routed('https://frontaliereticino.ch/aziende/qualcuno/')).toBe(false);
    // Look-alikes must not be swept in by the locale routes.
    expect(routed('https://frontaliereticino.ch/enterprise/')).toBe(false);
  });

  it('a route without a trailing star does not match a query string (#2611)', () => {
    const exact = 'frontaliereticino.ch/de';
    expect(routePatternMatches(exact, new URL('https://frontaliereticino.ch/de'))).toBe(true);
    expect(routePatternMatches(exact, new URL('https://frontaliereticino.ch/de?cb=1'))).toBe(false);
    expect(
      routePatternMatches('frontaliereticino.ch/rss.xml*', new URL('https://frontaliereticino.ch/rss.xml?cb=1')),
    ).toBe(true);
  });
});

describe('the origin a Worker-routed apex path is keyed on', () => {
  it('is the locale shard for a plain locale path', () => {
    expect(shardOriginForApexUrl(new URL('https://frontaliereticino.ch/de/'))).toBe(
      'origin-de.frontaliereticino.ch',
    );
  });

  it('is the SECTION shard for a section path, not the locale shard', () => {
    // The Worker checks matchSection BEFORE LOCALE_RE. Getting this backwards
    // would purge a host that never held the entry — a ✅ with no effect, which
    // is the class of defect this whole file exists for.
    expect(shardOriginForApexUrl(new URL('https://frontaliereticino.ch/de/jobs-im-tessin/x/'))).toBe(
      'origin-ticino-de.frontaliereticino.ch',
    );
    expect(shardOriginForApexUrl(new URL('https://frontaliereticino.ch/cerca-lavoro-zurigo/'))).toBe(
      'origin-zurigo-it.frontaliereticino.ch',
    );
  });

  it('is nothing for paths that are not served from a shard', () => {
    // R2-backed EDGE_PUSHED_FILES and apex passthrough: no origin-* twin exists,
    // so the script must not invent one.
    expect(shardOriginForApexUrl(new URL('https://frontaliereticino.ch/rss.xml'))).toBeNull();
    expect(shardOriginForApexUrl(new URL('https://frontaliereticino.ch/blog/x/'))).toBeNull();
  });
});

describe('apexPurgeBlindSpots flags exactly the purges that change nothing', () => {
  it('flags an apex-only purge of a Worker-routed path', () => {
    const gaps = apexPurgeBlindSpots(['https://frontaliereticino.ch/de/']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].pattern).toBe('frontaliereticino.ch/de/*');
    expect(gaps[0].expectedOrigin).toBe('origin-de.frontaliereticino.ch');
  });

  it('is silent when the same list names the origin twin', () => {
    expect(
      apexPurgeBlindSpots([
        'https://frontaliereticino.ch/de/',
        'https://origin-de.frontaliereticino.ch/de/',
      ]),
    ).toEqual([]);
  });

  it('is silent for the R2 shape, whose companion carries an /edge/ prefix', () => {
    // publish-edge-files.mjs pairs the apex path with cdnKey `/edge/<name>`.
    expect(
      apexPurgeBlindSpots([
        'https://frontaliereticino.ch/rss.xml',
        'https://cdn.frontaliereticino.ch/edge/rss.xml',
      ]),
    ).toEqual([]);
  });

  it('is silent for apex passthrough paths, where the apex purge IS the fix', () => {
    expect(
      apexPurgeBlindSpots(['https://frontaliereticino.ch/', 'https://frontaliereticino.ch/blog/x/']),
    ).toEqual([]);
  });
});

describe('the locale-shard purge list deploy.yml emits', () => {
  it('covers every locale the Worker has a shard origin for', () => {
    // The binding that makes wrangler.toml and the purge list one thing: add a
    // locale route without teaching the generator about it and this fails.
    expect(SHARD_LOCALES.sort()).toEqual(['de', 'en', 'fr']);
    for (const locale of SHARD_LOCALES) {
      const patterns = readWorkerRoutePatterns();
      expect(patterns, `no Worker subtree route for /${locale}`).toContain(
        `frontaliereticino.ch/${locale}/*`,
      );
      expect(patterns, `no Worker exact route for the bare /${locale}`).toContain(
        `frontaliereticino.ch/${locale}`,
      );
      expect(SHARD_ORIGIN[locale]).toBe(`origin-${locale}.frontaliereticino.ch`);
    }
  });

  it.each(SHARD_LOCALES)('%s: has no apex-blind URL and stays under the 30-URL cap', (locale) => {
    const urls = localeShardPurgeUrls(locale);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.length).toBeLessThanOrEqual(MAX_TARGETED_FILES);
    // The point of the whole change.
    expect(apexPurgeBlindSpots(urls)).toEqual([]);
  });

  it.each(SHARD_LOCALES)('%s: every path is Worker-routed and pairs apex with origin', (locale) => {
    const paths = localeShardPurgePaths(locale);
    const urls = localeShardPurgeUrls(locale);
    expect(urls).toHaveLength(paths.length * 2);
    for (const pathname of paths) {
      // A path the Worker does NOT route is apex-keyed, so spending a slot on
      // its origin twin would be cargo-cult rather than a fix.
      expect(
        workerRouteForUrl(new URL(`https://${APEX_HOST}${pathname}`)),
        `${pathname} is not on a Worker route`,
      ).not.toBeNull();
      expect(urls).toContain(`https://${APEX_HOST}${pathname}`);
      expect(urls).toContain(`https://${SHARD_ORIGIN[locale]}${pathname}`);
    }
    // Never a section origin: those shards are pushed by other steps and
    // refreshed by rerender-article-hubs.yml.
    for (const url of urls) {
      const { hostname } = new URL(url);
      expect([APEX_HOST, SHARD_ORIGIN[locale]]).toContain(hostname);
    }
  });

  it.each(SHARD_LOCALES)('%s: never names a path a SECTION shard serves', (locale) => {
    for (const pathname of localeShardPurgePaths(locale)) {
      expect(isSectionPath(pathname), `${pathname} is served by a section shard`).toBe(false);
    }
  });

  it('the section filter is load-bearing, not decorative', () => {
    // SLUG_TABLES.<loc>.blog IS a section prefix (de → 'grenzgaenger-artikel' =
    // articolifrontaliere). A hand-kept allowlist would have shipped it, and the
    // purge would have named origin-de for an entry only
    // origin-articolifrontaliere-de ever held.
    for (const locale of SHARD_LOCALES) {
      const blog = `/${locale}/${SLUG_TABLES[locale].blog}/`;
      expect(isSectionPath(blog), `${blog} should be a section path`).toBe(true);
      expect(localeShardPurgePaths(locale)).not.toContain(blog);
    }
    expect(LANDING_SLUG_KEYS).not.toContain('blog');
    expect(LANDING_SLUG_KEYS).not.toContain('blogCh');
  });
});

describe('the section-shard purge list deploy.yml emits (#5513)', () => {
  const LOCALES = ['it', 'en', 'de', 'fr'] as const;
  // articolifrontaliere/articolisvizzera are real SECTION_ORIGIN entries but
  // are excluded here because deploy.yml's push loop skips them by default
  // (ARTICOLI*_BUILD_EMIT_SKIP defaults to true — they are served by
  // publish-article-fast.mjs / rerender-article-hubs.yml instead), so their
  // shard-ok marker never exists for the CI caller to name them.
  const CANTON_SECTIONS = SECTION_KEYS.filter(
    (s) => s !== 'articolifrontaliere' && s !== 'articolisvizzera',
  );

  it('has a SECTION_ROUTES entry for every section in every locale', () => {
    for (const section of SECTION_KEYS) {
      for (const locale of LOCALES) {
        expect(
          SECTION_ROUTES.some((r) => r.section === section && r.locale === locale),
          `no SECTION_ROUTES entry for ${section}/${locale}`,
        ).toBe(true);
      }
    }
  });

  it.each(LOCALES)('%s: every canton section pairs apex with its own origin, no blind spot', (locale) => {
    for (const section of CANTON_SECTIONS) {
      const urls = sectionShardPurgeUrls(section, locale);
      expect(urls).toHaveLength(4); // 2 paths (bare + slash) × apex+origin
      expect(apexPurgeBlindSpots(urls)).toEqual([]);
      const origin = SECTION_ORIGIN[section][locale];
      for (const pathname of sectionShardPurgePaths(section, locale)) {
        expect(urls).toContain(`https://${APEX_HOST}${pathname}`);
        expect(urls).toContain(`https://${origin}${pathname}`);
      }
    }
  });

  it('throws on a section/locale pair with no route, rather than silently emitting nothing', () => {
    expect(() => sectionShardPurgeUrls('not-a-real-section', 'it')).toThrow();
  });

  it.each(LOCALES)('%s: the full canton fan-out is over the 30-URL cap — the reason batching exists', (locale) => {
    const totalUrls = CANTON_SECTIONS.reduce((n, s) => n + sectionShardPurgeUrls(s, locale).length, 0);
    expect(totalUrls).toBeGreaterThan(MAX_TARGETED_FILES);
  });

  it.each(LOCALES)('%s: batches never exceed the cap and cover every URL exactly once', (locale) => {
    const batches = sectionShardPurgeBatches(CANTON_SECTIONS, locale);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(MAX_TARGETED_FILES);
    const flat = batches.flat();
    const expected = CANTON_SECTIONS.flatMap((s) => sectionShardPurgeUrls(s, locale));
    expect(flat).toEqual(expected);
  });

  it('the cap is a hard boundary: exactly-at-cap yields one batch, one URL over yields two (off-by-one guard)', () => {
    // batch() (reused, not reimplemented) is a plain `for (i += size) slice(i, i+size)`
    // loop — the natural bug in that shape is an off-by-one at the boundary: an
    // empty trailing batch when the list divides evenly, or a dropped last URL
    // when it doesn't. Assert the exact request count at both edges, not just
    // "stays under the cap" (the tests above already cover that loosely).
    const sections = CANTON_SECTIONS.slice(0, 8); // deterministic, real route data
    const totalUrls = sections.flatMap((s) => sectionShardPurgeUrls(s, 'it')).length;
    expect(totalUrls).toBeGreaterThan(1);

    const atCap = sectionShardPurgeBatches(sections, 'it', totalUrls);
    expect(atCap).toHaveLength(1); // no empty trailing batch when the count divides evenly
    expect(atCap[0]).toHaveLength(totalUrls);

    const oneOver = sectionShardPurgeBatches(sections, 'it', totalUrls - 1);
    expect(oneOver.map((b) => b.length)).toEqual([totalUrls - 1, 1]); // the last URL isn't dropped
    expect(oneOver.flat()).toEqual(atCap[0]);
  });

  it('a real batch stays quiet against cf-purge-cache.mjs (no apex-blind-spot warning)', () => {
    const [firstBatch] = sectionShardPurgeBatches(CANTON_SECTIONS.slice(0, 8), 'it');
    const out = execFileSync('node', ['scripts/cf-purge-cache.mjs', `--files=${firstBatch.join(',')}`], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...process.env, CF_API_TOKEN: '' },
    });
    expect(out).not.toContain('Apex purge does not move the served copy');
  });
});

describe('deploy.yml purges where it pushes', () => {
  it('section shard steps purge what they just pushed, on both legs (#5513)', () => {
    // Same shape as the locale assertion below: the purge call must appear
    // AFTER the push it purges, for each leg independently.
    const pushItAt = DEPLOY.indexOf('Push section shards (IT');
    const purgeItAt = DEPLOY.indexOf('section-shard-purge-urls.mjs it');
    const pushNonItAt = DEPLOY.indexOf('Push section shards (non-IT');
    const purgeNonItAt = DEPLOY.indexOf('section-shard-purge-urls.mjs "$LOCALE"');
    expect(pushItAt, 'deploy.yml no longer pushes the IT section shards').toBeGreaterThan(-1);
    expect(purgeItAt, 'the IT leg pushes section shards and purges nothing').toBeGreaterThan(-1);
    expect(purgeItAt, 'the IT purge must run after the IT push').toBeGreaterThan(pushItAt);
    expect(pushNonItAt, 'deploy.yml no longer pushes the non-IT section shards').toBeGreaterThan(-1);
    expect(purgeNonItAt, 'the non-IT leg pushes section shards and purges nothing').toBeGreaterThan(-1);
    expect(purgeNonItAt, 'the non-IT purge must run after the non-IT push').toBeGreaterThan(pushNonItAt);
  });

  it('the section purge is gated on the per-section ok-marker, not the push step outcome', () => {
    // The push step's fan-out returns non-zero when ANY ONE section fails —
    // gating the purge on that outcome would skip every OTHER section that
    // pushed fine (unlike the single-locale push this pattern mirrors).
    expect(DEPLOY).toContain('shard-ok-*-it');
    expect(DEPLOY).toContain('shard-ok-*-"$LOCALE"');
  });

  it('build-locale purges the shard it just force-pushed, after pushing it', () => {
    // The exact hole #5483 was reopened for: the job wrote the shard and purged
    // nothing. `grep -c cf-purge-cache` on main returned 0.
    const pushAt = DEPLOY.indexOf('push-locale-shard.sh');
    const genAt = DEPLOY.indexOf('locale-shard-purge-urls.mjs');
    expect(pushAt, 'deploy.yml no longer pushes a locale shard').toBeGreaterThan(-1);
    expect(genAt, 'deploy.yml pushes the locale shard and purges nothing').toBeGreaterThan(-1);
    expect(genAt, 'the purge runs before the push').toBeGreaterThan(pushAt);
    expect(DEPLOY).toContain('node scripts/cf-purge-cache.mjs "--files=$PURGE_URLS"');
  });

  it('the purge is gated on the ok-marker, not on the step outcome', () => {
    // push-locale-shard.sh exits 0 when it SKIPS (no deploy key / no subtree).
    expect(DEPLOY).toContain('$RUNNER_TEMP/shard-ok-$LOCALE');
  });

  it('rerender-article-hubs.yml still names both halves for the article hubs', () => {
    // The precedent this change generalises. If the origin line is ever dropped
    // there, the hubs go back to an apex-only purge that reports success.
    const hubs = read('.github/workflows/rerender-article-hubs.yml');
    expect(hubs).toContain('https://frontaliereticino.ch/$rel');
    expect(hubs).toContain('https://origin-$shard-$loc.frontaliereticino.ch/$rel');
  });
});

describe('cf-purge-cache.mjs warns before it can print a misleading ✅', () => {
  const runPurge = (files: string[]) =>
    execFileSync('node', ['scripts/cf-purge-cache.mjs', `--files=${files.join(',')}`], {
      cwd: ROOT,
      encoding: 'utf-8',
      // No token → the script is a clean no-op exit 0 and issues no HTTP call.
      // The warning must still fire: a caller building a list locally is the
      // one reader able to fix it.
      env: { ...process.env, CF_API_TOKEN: '' },
    });

  it('annotates an apex-only purge of a Worker-routed path', () => {
    const out = runPurge(['https://frontaliereticino.ch/de/']);
    expect(out).toContain('::warning title=Apex purge does not move the served copy::');
    expect(out).toContain('origin-de.frontaliereticino.ch/de/');
  });

  it('stays quiet on the list deploy.yml actually sends', () => {
    const out = runPurge(localeShardPurgeUrls('de'));
    expect(out).not.toContain('Apex purge does not move the served copy');
  });

  it('stays quiet on a purely apex-keyed purge', () => {
    const out = runPurge(['https://frontaliereticino.ch/', 'https://frontaliereticino.ch/blog/x/']);
    expect(out).not.toContain('Apex purge does not move the served copy');
  });
});
