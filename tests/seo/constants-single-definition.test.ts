// @vitest-environment node
/**
 * Every build-time module must PARSE — the duplicate-declaration guard.
 *
 * WHAT HAPPENED. PR #5187 and PR #5170 each added a `replaceRobotsMeta` helper
 * to `build-plugins/constants.ts`, independently, within hours of each other.
 * Both authors saw the collision coming and both wrote the same note: whoever
 * lands second should delete their copy, the two are byte-identical by design.
 *
 * Neither did. `main` shipped with two `const ROBOTS_META_TAG_RE` and two
 * `export function replaceRobotsMeta` in one module — which is not a style
 * problem, it is a hard esbuild error ("the symbol has already been declared")
 * in the single file that every build plugin imports. The site build could not
 * run.
 *
 * WHY NO TEST CAUGHT IT. Neither branch had a duplicate *on its own*: each was
 * green, correctly, right up to the moment they converged. The defect existed
 * only in the merge result, which is precisely the state no PR's CI evaluates.
 * A note in a docblock is not a merge strategy — it depends on a human
 * remembering at the exact moment two branches meet.
 *
 * So the guard is placed where the defect actually lives: on the merged tree.
 * Parsing is the cheapest possible check and catches the whole class — duplicate
 * declarations, half-applied conflict resolutions, stray markers — across every
 * build-time module, not just the one that broke this time.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['build-plugins', 'services', path.join('packages', 'articles', 'engine')];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => {
  const abs = path.join(ROOT, d);
  try {
    return statSync(abs).isDirectory() ? walk(abs) : [];
  } catch {
    return [];
  }
});

describe('build-time modules parse', () => {
  it('scans a non-trivial number of files (guards against a vacuous sweep)', () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('no module has a duplicate declaration or a syntax error', () => {
    const failures: string[] = [];

    for (const file of FILES) {
      const rel = path.relative(ROOT, file);
      try {
        transformSync(readFileSync(file, 'utf8'), {
          loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
          jsx: 'automatic',
          // ESM, so a duplicate top-level function declaration is an error
          // rather than a silent last-one-wins overwrite.
          format: 'esm',
        });
      } catch (err) {
        const message = (err as Error).message.replace(/\s+/g, ' ').slice(0, 300);
        failures.push(`${rel} → ${message}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('constants.ts exports each helper exactly once', () => {
  // Targeted assertion for the specific symbol that collided, so a regression
  // names the symbol instead of only reporting a parse failure.
  const src = readFileSync(path.join(ROOT, 'build-plugins', 'constants.ts'), 'utf8');

  for (const symbol of [
    'replaceRobotsMeta',
    'normalizeRobotsDirective',
    'robotsMetaForContent',
    'robotsMetaEnhancedForContent',
  ]) {
    it(`declares ${symbol} once`, () => {
      const declarations = src.match(new RegExp(`^export function ${symbol}\\b`, 'gm')) ?? [];
      expect(declarations).toHaveLength(1);
    });
  }

  it('declares ROBOTS_META_TAG_RE once', () => {
    const declarations = src.match(/^const ROBOTS_META_TAG_RE\b/gm) ?? [];
    expect(declarations).toHaveLength(1);
  });
});
