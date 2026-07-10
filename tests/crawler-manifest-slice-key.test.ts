// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Guard for the slug↔slice-file mismatch class behind the 2026-07 post-#3701
// silent data loss (issues re: medacta-international, efg-international, …).
//
// data/crawler-manifest.json declares JOBS_SLICE_FILE per crawler; the
// crawler-group workflow generator exports it into each background step's env,
// and scripts/lib/git-commit-data.sh scopes its staging/commit to exactly that
// basename. The crawler itself, however, writes its slice under its own
// companyKey (writeJobsCrawlerSlice / crawlerScratchPathFor). When the two
// disagree (manifest said `medacta.json`, crawler writes
// `medacta-international.json`), the commit stages a nonexistent path and the
// crawler's data is silently NEVER committed — the health monitor then reads a
// frozen summary and flags the crawler broken. 33 of 583 manifest entries had
// this mismatch (short legacy slug vs real companyKey).
//
// This test statically extracts every crawler's real key(s) from its update
// script (and the lib parser modules it imports) and asserts the manifest's
// JOBS_SLICE_FILE basename is one of them.
// ─────────────────────────────────────────────────────────────────────────────

type ManifestEntry = {
  slug: string;
  runStep?: { run?: string; env?: Record<string, string> };
  postSteps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
};

function read(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

const pkgScripts: Record<string, string> = JSON.parse(read('package.json')).scripts;
const manifest: ManifestEntry[] = JSON.parse(read('data/crawler-manifest.json')).manifest;

function scriptFor(entry: ManifestEntry): string | null {
  const run = (entry.runStep?.run || '').trim();
  const npm = run.match(/npm run\s+(\S+)/);
  const cmd = npm ? pkgScripts[npm[1]] || '' : run;
  const script = (cmd || run).match(/(scripts\/[\w./-]+\.mjs)/);
  return script ? script[1] : null;
}

/** Collect every plausible crawler key literal from a script, following
 *  relative imports of key constants / parser modules one hop deep. */
function keysFromSource(file: string, depth = 0, seen = new Set<string>()): Set<string> {
  const keys = new Set<string>();
  if (seen.has(file)) return keys;
  seen.add(file);
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return keys;
  }
  for (const m of src.matchAll(/(\w*_KEY|COMPANY_KEY|companyKey)\s*[:=]\s*['"]([^'"]+)['"]/g)) keys.add(m[2]);
  for (const m of src.matchAll(/crawlerScratchPathFor\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
  for (const m of src.matchAll(/write(?:Jobs|Summary)CrawlerSlice\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
  if (depth < 2) {
    for (const m of src.matchAll(/import\s*\{[^}]*\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      if (!/_KEY|job-parser|crawler/.test(m[0])) continue;
      for (const k of keysFromSource(resolve(dirname(file), m[1]), depth + 1, seen)) keys.add(k);
    }
  }
  return keys;
}

function mergedEnv(entry: ManifestEntry): Record<string, string> {
  const env: Record<string, string> = {};
  for (const step of [entry.runStep, ...(entry.postSteps || [])]) {
    if (step?.env) Object.assign(env, step.env);
  }
  return env;
}

describe('crawler-manifest JOBS_SLICE_FILE ↔ crawler key consistency', () => {
  it('every manifest entry declares JOBS_SLICE_FILE (grouped git-commit-data.sh scoping depends on it)', () => {
    const missing = manifest.filter((e) => !mergedEnv(e).JOBS_SLICE_FILE).map((e) => e.slug);
    // Without JOBS_SLICE_FILE the grouped commit path falls back to
    // directory-wide staging in a SHARED workspace — committing every
    // sibling's dirty slice under this crawler's name.
    expect(missing).toEqual([]);
  });

  it("every JOBS_SLICE_FILE basename matches a key its crawler script actually writes", () => {
    const failures: string[] = [];
    const unresolvable: string[] = [];

    for (const entry of manifest) {
      const sliceFile = mergedEnv(entry).JOBS_SLICE_FILE;
      if (!sliceFile) continue; // covered by the test above
      const base = basename(sliceFile, '.json');

      const script = scriptFor(entry);
      if (!script) {
        unresolvable.push(`${entry.slug}: cannot resolve update script from runStep`);
        continue;
      }
      const keys = keysFromSource(resolve(ROOT, script));
      if (keys.size === 0) {
        unresolvable.push(`${entry.slug}: no key literals found in ${script}`);
        continue;
      }
      if (!keys.has(base)) {
        failures.push(
          `${entry.slug}: manifest JOBS_SLICE_FILE=${sliceFile} but ${script} writes key(s) [${[...keys].join(', ')}] — the grouped commit would stage a nonexistent path and silently drop this crawler's data`,
        );
      }
    }

    expect(failures).toEqual([]);
    // As of 2026-07 extraction resolves 583/583 entries. If you add a crawler
    // whose key can't be found by the patterns above, extend keysFromSource
    // (do NOT silently skip: an unverifiable entry is how this bug class
    // shipped in the first place).
    expect(unresolvable).toEqual([]);
  });
});
