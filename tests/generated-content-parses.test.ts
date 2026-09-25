// @vitest-environment node
/**
 * generated-content-parses.test.ts
 *
 * Every machine-written module under `packages/articles/content/` and
 * `services/locales/` must parse as TypeScript.
 *
 * Why this exists
 * ---------------
 * Both corpora are machine-written: strings are emitted as single-quoted TS
 * literals, so any raw apostrophe that reaches the file terminates the
 * literal and turns the module into a hard esbuild parse error. On 2026-07-29
 * one such body (`blog-body-ch/fr/frontaliere-insegnante-scuola-ticino-
 * stipendio-requisiti.ts`, "l'expérience" written unescaped while completing a
 * truncated sentence) reached `main` through a normal PR and only surfaced
 * 52 minutes into the deploy build:
 *
 *   ERROR: Expected "}" but found "expérience"
 *
 * Nothing in the PR gate looked at the corpus — `check-seo-pages-syntax.mjs`
 * parsed only seo-pages.ts/seoService.ts, and the vitest suite only ever read
 * these files as text (word counts, fabrication guards), never as code. This
 * test closes that gap: a corrupted body now fails the suite in seconds
 * instead of a burning a full deploy build.
 *
 * Same class as issue #2834 (an in-place edit that left seo-pages.ts
 * unparseable), one directory over.
 */
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
/**
 * Both hold machine-written `Record<string, string>` modules built from
 * single-quoted literals. services/locales symlinks the two article body dirs;
 * collectTsFiles() does not follow symlinked directories, so each file is
 * visited once, under its real path.
 */
const GENERATED_TS_DIRS = ['packages/articles/content', 'services/locales'].map((d) =>
  path.join(REPO_ROOT, d),
);

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('generated content modules', () => {
  const files = GENERATED_TS_DIRS.flatMap(collectTsFiles);

  it('finds the generated corpus on disk', () => {
    // Guards against the walk silently going empty (renamed/moved corpus),
    // which would make the parse assertion below vacuously green.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('every module parses as TypeScript', () => {
    const failures: string[] = [];

    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file);
      try {
        transformSync(fs.readFileSync(file, 'utf-8'), { loader: 'ts', sourcefile: rel });
      } catch (err) {
        const e = err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }>; message?: string };
        const first = e.errors?.[0];
        const where = first?.location ? `:${first.location.line}:${first.location.column}` : '';
        failures.push(`${rel}${where} — ${first?.text ?? e.message ?? 'parse error'}`);
      }
    }

    expect(
      failures,
      `Unparseable generated modules (an unescaped apostrophe in a single-quoted string is the usual cause):\n${failures.join('\n')}`,
    ).toEqual([]);
  }, 180_000);
});
