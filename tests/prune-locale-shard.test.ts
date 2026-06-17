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
