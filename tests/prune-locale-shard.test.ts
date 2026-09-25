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
    // The locale HOMEPAGE: a root-level file, not part of the subtree, that
    // the shard origin serves for the extensionless `/<loc>` (issue #5327).
    fs.writeFileSync(path.join(d, `${loc}.html`), '<html></html>');
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
  it('pure locale shard (en) keeps dist/en AND its homepage en.html (#5327)', () => {
    // en.html was deleted here — `keep` held the bare directory name, and
    // 'en.html' !== 'en'. push-locale-shard.sh:196 stages it right after this
    // step ("homepage at /{loc}"), so its `[ -f "$dist_dir/$loc.html" ]` could
    // never be true and the shard shipped without it: /en.html → 404 live.
    prune('en', dist);
    expect(top(dist)).toEqual(['en', 'en.html']);
  });

  it('multi locale shard (en,de) keeps both subtrees and both homepages', () => {
    prune('en,de', dist);
    expect(top(dist)).toEqual(['de', 'de.html', 'en', 'en.html']);
  });

  it('main shard (it) drops en/de/fr AND their homepages (#5327)', () => {
    // The other half: the main shard kept en.html after dropping dist/en/.
    // With no index.html sibling left, flatHtmlRedirectPlugin had nothing to
    // bridge against, so it stayed a fully INDEXABLE EN page sitting on the
    // origin that the edge never asks for that path — the trunk-guard's
    // "built under a prefix this build does not ship to the shard".
    prune('it', dist);
    expect(top(dist)).toEqual(['assets', 'build-id.txt', 'cerca-lavoro', 'sitemap.xml']);
  });

  it('main+en shard (it,en) keeps root + shared + en + en.html, drops de/fr', () => {
    prune('it,en', dist);
    expect(top(dist)).toEqual([
      'assets', 'build-id.txt', 'cerca-lavoro', 'en', 'en.html', 'sitemap.xml',
    ]);
  });

  it('unset BUILD_LOCALE is a no-op (default all-locale build)', () => {
    prune(undefined, dist);
    expect(top(dist)).toEqual([
      'assets', 'build-id.txt', 'cerca-lavoro',
      'de', 'de.html', 'en', 'en.html', 'fr', 'fr.html', 'sitemap.xml',
    ]);
  });

  it('garbage BUILD_LOCALE is a no-op (never wipes a build)', () => {
    prune('xx', dist);
    expect(top(dist)).toEqual([
      'assets', 'build-id.txt', 'cerca-lavoro',
      'de', 'de.html', 'en', 'en.html', 'fr', 'fr.html', 'sitemap.xml',
    ]);
  });

  it('never mistakes a root file that merely starts with a locale token', () => {
    // `enigma.html` is ordinary IT content; matching by prefix would move it
    // to the EN shard and 404 it on the apex.
    fs.writeFileSync(path.join(dist, 'enigma.html'), '<html></html>');
    prune('en', dist);
    expect(top(dist)).toEqual(['en', 'en.html']);
  });
});
