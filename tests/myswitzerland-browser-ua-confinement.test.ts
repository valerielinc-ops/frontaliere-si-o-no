import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MYSWITZERLAND_DETAIL_BROWSER_UA } from '../scripts/lib/myswitzerland-detail-transport.mjs';

// The browser User-Agent of the MySwitzerland detail pages is an exception to
// the crawler rule "clearly identifying User-Agent", decided by the owner on
// 2026-10-05 (D1, issue 10710) for that crawler only. This guard reads every
// source under scripts/ from disk: a new file that imports the transport
// module, names the constant or pastes the UA string fails here, even though
// it imports nothing this test knows about (registered in sourceTreeLintTests
// of scripts/ci/run-related-tests.mjs with the scripts/ perimeter).

const ROOT = path.resolve(__dirname, '..');
const MODULE = 'scripts/lib/myswitzerland-detail-transport.mjs';
const CRAWLER = 'scripts/crawl-myswitzerland-events.mjs';
const ALLOWED = new Set([MODULE, CRAWLER]);
const EXT = /\.(?:[cm]?[jt]s|tsx?)$/;

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

const MARKERS = [
  'MYSWITZERLAND_DETAIL_BROWSER_UA',
  'myswitzerland-detail-transport',
  MYSWITZERLAND_DETAIL_BROWSER_UA,
];

describe('MySwitzerland browser User-Agent stays inside its crawler', () => {
  const files = [...walk(path.join(ROOT, 'scripts'))].map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  const users = files.filter((file) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    return MARKERS.some((marker) => text.includes(marker));
  });

  it('scans a non-empty scripts/ tree', () => {
    expect(files).toContain(CRAWLER);
    expect(files).toContain(MODULE);
  });

  it('no file outside the crawler and its transport module uses the exception', () => {
    expect(users.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  it('the crawler imports the transport module (the guard is not vacuous)', () => {
    expect(users).toContain(CRAWLER);
  });

  it('the Algolia index keeps the identifying User-Agent', () => {
    const crawler = readFileSync(path.join(ROOT, CRAWLER), 'utf8');
    const algolia = crawler.slice(crawler.indexOf('async function algoliaQuery'), crawler.indexOf('async function enumerateEventsForLocale'));
    expect(algolia).toContain("'User-Agent': USER_AGENT");
    expect(crawler).toMatch(/const USER_AGENT = '[^']*FrontaliereTicinoBot/);
    expect(crawler).not.toContain(MYSWITZERLAND_DETAIL_BROWSER_UA);
  });
});
