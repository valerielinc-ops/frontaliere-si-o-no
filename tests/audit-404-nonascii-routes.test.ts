// @vitest-environment node
//
// Issue #5244 — "404-risk: URLs that would return a GitHub Pages 404", 85 of
// them, and not one was real.
//
// Every single reported offender carried a percent-encoded non-ASCII byte
// (`88-j%C3%A4hrige-frau-…`, `duba%C3%AF-vers-le-ticino`,
// `un-passaporti-di-fedelt%C3%A0`) and every single one returned HTTP 200 live
// — checked 85/85 on 2026-08-07. The pages were in the shard repos all along:
// `repos/nanakokyobashi-rgb/frontaliere-articolifrontaliere-de/contents/…`
// answers 26552 bytes for the first of them.
//
// The audit could not see them because it listed shard trees with a bare
// `git ls-tree -r --name-only`. Under git's default `core.quotePath=true` any
// path with a non-ASCII byte comes back wrapped in literal double quotes with
// its bytes octal-escaped, which breaks the `/index.html` strip, survives into
// normPath(), and leaves the served set holding a junk `/%22de/…` route
// instead of the real one.
//
// It is worth being precise about why this hid for six recurrences and a
// `needs-human` parking: the offenders LOOK like the publish-skew this audit
// already models (issue #4079). But skew moves between runs, and this does
// not. It is deterministic — the same slugs, every day, for exactly as long as
// they contain an umlaut or an accent.
//
// These tests pin the round-trip on a real git repo, because the bug lived in
// what git printed rather than in any expression the audit evaluated, and no
// amount of unit-testing the pure helpers would have found it.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(resolve(ROOT, 'scripts/audit-404-risk.mjs'), 'utf-8');

/** The script runs main() on import, so the pure helpers are rebuilt from source. */
function loadHelpers() {
  const pick = (name: string) => {
    const start = SCRIPT.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`helper ${name} not found in audit-404-risk.mjs`);
    let i = SCRIPT.indexOf('{', start);
    let depth = 0;
    for (; i < SCRIPT.length; i++) {
      if (SCRIPT[i] === '{') depth++;
      else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  };
  const src = `
    const HOST = 'https://frontaliereticino.ch';
    ${pick('normPath')}
    ${pick('treeEntryToRoute')}
    return { normPath, treeEntryToRoute };
  `;
  // eslint-disable-next-line no-new-func
  return new Function(src)() as {
    normPath: (input: string) => string;
    treeEntryToRoute: (entry: string) => string;
  };
}

const { normPath, treeEntryToRoute } = loadHelpers();

// One of the 85, with the shard entry and the sitemap <loc> that must meet.
const SLUG = '88-jährige-frau-verteidigt-sich-gegen-einen-taschendieb';
const ENTRY = `de/grenzgaenger-artikel/${SLUG}/index.html`;
const SITEMAP_LOC = `https://frontaliereticino.ch/de/grenzgaenger-artikel/${encodeURIComponent(SLUG)}/`;

describe('treeEntryToRoute — a non-ASCII slug must land on its sitemap path', () => {
  it('meets the sitemap where the sitemap already is: percent-encoded', () => {
    // Both sides go through normPath, so both come out encoded. The point is
    // that they come out EQUAL — that equality is the audit's whole verdict.
    expect(treeEntryToRoute(ENTRY)).toBe(normPath(SITEMAP_LOC));
    expect(treeEntryToRoute(ENTRY)).toContain('%C3%A4');
  });

  it('is destroyed by a git-quoted entry — the exact shape of #5244', () => {
    // This is what a bare `git ls-tree --name-only` handed the audit.
    const quoted = '"de/grenzgaenger-artikel/88-j\\303\\244hrige-frau-verteidigt-sich-gegen-einen-taschendieb/index.html"';
    const route = treeEntryToRoute(quoted);
    expect(route).not.toBe(normPath(SITEMAP_LOC));
    // The `/index.html` strip misses (the string ends in `"`), so the junk
    // route keeps it — and the real route is simply absent from the set.
    expect(route).toContain('index.html');
    expect(route).toContain('%22');
  });

  it('leaves ASCII slugs alone either way, which is why only accents broke', () => {
    const ascii = 'de/grenzgaenger-artikel/benzin-preise-tessin/index.html';
    expect(treeEntryToRoute(ascii)).toBe('/de/grenzgaenger-artikel/benzin-preise-tessin');
  });
});

describe('the listing itself — git must hand over raw bytes', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit404-quotepath-'));
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, 'de/grenzgaenger-artikel', SLUG), { recursive: true });
    writeFileSync(join(dir, 'de/grenzgaenger-artikel', SLUG, 'index.html'), '<html></html>');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', [
      '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x',
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('-z survives core.quotePath being forced on, which a runner may do globally', () => {
    // `-z` is not subject to core.quotePath at all — that is why the fix is the
    // flag and not a config override the audit would have to keep winning.
    const out = execFileSync(
      'git',
      ['-C', dir, '-c', 'core.quotePath=true', 'ls-tree', '-r', '--name-only', '-z', 'HEAD'],
      { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
    );
    const entries = out.split('\0').filter(Boolean);
    expect(entries).toEqual([ENTRY]);
    expect(entries.map(treeEntryToRoute)).toEqual([normPath(SITEMAP_LOC)]);
  });

  it('without -z git quotes the path, and the route no longer matches', () => {
    // Pins the defect itself, so a revert of the flag fails here rather than
    // silently reopening #5244 as 85 phantom 404s.
    const out = execFileSync(
      'git',
      ['-C', dir, '-c', 'core.quotePath=true', 'ls-tree', '-r', '--name-only', 'HEAD'],
      { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
    );
    const entries = out.split('\n').filter(Boolean);
    expect(entries[0]).toMatch(/^"/);
    expect(entries.map(treeEntryToRoute)).not.toEqual([normPath(SITEMAP_LOC)]);
  });
});

describe('the audit invokes git the fixed way', () => {
  it('passes -z and splits on NUL', () => {
    expect(SCRIPT).toMatch(/'ls-tree',\s*'-r',\s*'--name-only',\s*'-z',\s*'HEAD'/);
    expect(SCRIPT).toMatch(/stdout\.split\('\\0'\)/);
  });
});
