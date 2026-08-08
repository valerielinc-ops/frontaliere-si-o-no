import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../scripts/ci/prune-locale-shard.mjs');

let dist: string;

function makeDist(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-prune-'));
  for (const loc of ['en', 'de', 'fr']) {
    fs.mkdirSync(path.join(d, loc, 'job'), { recursive: true });
    fs.writeFileSync(path.join(d, loc, 'job', 'index.html'), '<html></html>');
  }
  fs.mkdirSync(path.join(d, 'cerca-lavoro', 'job'), { recursive: true });
  fs.writeFileSync(path.join(d, 'cerca-lavoro', 'job', 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'assets', 'a.js'), 'x');
  fs.writeFileSync(path.join(d, 'sitemap.xml'), '<urlset/>');
  fs.writeFileSync(path.join(d, 'build-id.txt'), 'id');
  return d;
}

function prune(buildLocale: string | undefined, distDir: string) {
  const env = { ...process.env };
  if (buildLocale === undefined) delete env.BUILD_LOCALE;
  else env.BUILD_LOCALE = buildLocale;
  delete env.GITHUB_STEP_SUMMARY;
  execFileSync('node', [SCRIPT, distDir], { env, stdio: 'pipe' });
}

const top = (d: string) => fs.readdirSync(d).sort();

beforeEach(() => {
  dist = makeDist();
});
afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('prune-locale-shard', () => {
  it('pure locale shard (en) keeps ONLY dist/en', () => {
    prune('en', dist);
    expect(top(dist)).toEqual(['en']);
  });

  it('multi locale shard (en,de) keeps both, drops the rest', () => {
    prune('en,de', dist);
    expect(top(dist)).toEqual(['de', 'en']);
  });

  it('main shard (it) keeps root + shared, drops en/de/fr', () => {
    prune('it', dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'sitemap.xml']);
  });

  it('main+en shard (it,en) keeps root + shared + en, drops de/fr', () => {
    prune('it,en', dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'en', 'sitemap.xml']);
  });

  it('unset BUILD_LOCALE is a no-op (default all-locale build)', () => {
    prune(undefined, dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'de', 'en', 'fr', 'sitemap.xml']);
  });

  it('garbage BUILD_LOCALE is a no-op (never wipes a build)', () => {
    prune('xx', dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'de', 'en', 'fr', 'sitemap.xml']);
  });
});

/**
 * Regression for the fatal `[trunk-guard]` that failed all three validate-dist
 * jobs of run 31240103446 on `dist/{en,de,fr}.html`, blocking the publish and
 * the seven other workflows that source scripts/lib/rehydrate-locale-shards.sh
 * (issue #5327 class).
 *
 * The flat locale-root twin is routed to the locale shard by
 * infra/cloudflare-worker/locale-router.js (`LOCALE_RE` matches `/en`, `/en/*`
 * and `/en.html` alike), so it belongs to `dist/<loc>` and must never outlive
 * it in the main artifact. It used to, because localeOfDistPath() classifies
 * `en.html` as `it` — `rel === 'en'` is false and `rel.startsWith('en/')` is
 * false — so the it build kept the flat file and dropped the
 * `dist/en/index.html` sibling, which is ALSO what stopped the post-walk from
 * rewriting it into a noindex bridge. rehydrate-locale-shards.sh snapshots
 * `$loc` and `$loc.html` as one unit and the shard could not put the flat file
 * back, so the guard rightly called it an indexable trunk orphan.
 *
 * The source-level fix is in staticPagesPlugin.ts (no flat twin for bare
 * locale roots); these cases pin the filesystem-level backstop, which is what
 * holds the line for the ~15 direct-fs emitters that bypass the WriteCollector.
 */
describe('prune-locale-shard — dist/<loc>.html never outlives dist/<loc>', () => {
  const seedLocaleRootFlats = (d: string) => {
    for (const loc of ['en', 'de', 'fr']) {
      fs.writeFileSync(path.join(d, `${loc}.html`), '<html lang="en">homepage</html>');
    }
  };

  it('main shard (it) drops the flat locale roots along with their subtrees', () => {
    seedLocaleRootFlats(dist);
    prune('it', dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'sitemap.xml']);
  });

  it('main+en shard (it,en) keeps en + en.html and drops de/fr both ways', () => {
    seedLocaleRootFlats(dist);
    prune('it,en', dist);
    // en is OWNED here, so neither dist/en nor dist/en.html is a trunk orphan:
    // this artifact serves that locale itself. Only the non-owned pair goes.
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'en', 'en.html', 'sitemap.xml']);
  });

  it('pure locale shard (en) keeps ONLY dist/en — the flat twin is not shard content', () => {
    seedLocaleRootFlats(dist);
    prune('en', dist);
    expect(top(dist)).toEqual(['en']);
  });

  it('unset BUILD_LOCALE (full monolithic build) still prunes nothing', () => {
    seedLocaleRootFlats(dist);
    prune(undefined, dist);
    expect(top(dist)).toEqual([
      'assets', 'build-id.txt', 'cerca-lavoro',
      'de', 'de.html', 'en', 'en.html', 'fr', 'fr.html', 'sitemap.xml',
    ]);
  });
});
