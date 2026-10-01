import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * rerender-article-corpus.yml is the template-drift safety net for article
 * pages, and its `push.paths` filter is the only thing that makes it reactive.
 * A path filter sees the files a commit CHANGED — so naming a re-export shim
 * or a symlink is naming a file that never changes.
 *
 * That is what the filter did after the #4881 Fase 6 colocation: it listed
 * `build-plugins/ogPagesPlugin.ts` (a shim), `blogContextualLinksPlugin.ts`
 * (a shim) and `shared/articleSectionDescriptors.ts` (a symlink), while the
 * renderer lived in `packages/articles/engine/` and the head snippets came from
 * `build-plugins/constants.ts` through the site-shell bootstrap. Renderer and
 * shell changes re-rendered nothing, and the weekly drift audit (run
 * 36312753890) found the live corpus a template behind.
 *
 * These assertions follow the render path from the driver instead of trusting
 * a hand-kept list: whatever the driver loads, whatever a shim forwards to, and
 * whatever the bootstrap hands the engine must be matched by the filter.
 */

const ROOT = process.cwd();
const WORKFLOW = '.github/workflows/rerender-article-corpus.yml';
const DRIVER = 'scripts/rerender-article-corpus.mjs';
const BOOTSTRAP = 'build-plugins/articlesSiteShellBootstrap.ts';
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts'];

function readPushPaths(): string[] {
  const doc = YAML.parse(fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8'));
  const paths = doc?.on?.push?.paths;
  if (!Array.isArray(paths) || paths.length === 0) throw new Error(`${WORKFLOW} has no on.push.paths`);
  return paths;
}

// GitHub filter syntax as used by this workflow: literal paths and `**`/`*`.
// Anything else (negation, braces, `?`) would need a real matcher, so it is
// rejected rather than silently mis-matched.
function globToRegExp(glob: string): RegExp {
  if (/[!?{}[\]]/.test(glob)) throw new Error(`unsupported filter syntax in ${glob}`);
  const source = glob
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+^$()|\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

const FILTERS = readPushPaths().map((glob) => ({ glob, re: globToRegExp(glob) }));
const isCovered = (rel: string) => FILTERS.some(({ re }) => re.test(rel));

// Tracked-file lookups go through git, not the disk: an agent worktree is a
// sparse checkout without `data/`, and `data/authors.ts` is a render input.
function isTracked(rel: string): boolean {
  const out = execFileSync('git', ['ls-files', '--', rel], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').includes(rel);
}

function resolveModule(fromRel: string, spec: string): string {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const ext of EXTENSIONS) {
    if (isTracked(base + ext)) return base + ext;
  }
  throw new Error(`${fromRel}: cannot resolve ${spec}`);
}

/**
 * The file whose CHANGE alters what `rel` provides: a symlink resolves to its
 * target, a colocation shim (`export * from '…'`) to the module it forwards.
 * Also returns the shim's side-effect imports (the site-shell bootstrap).
 */
function renderSources(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (fs.lstatSync(abs).isSymbolicLink()) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), fs.readlinkSync(abs)));
    return [rel, target];
  }
  const src = fs.readFileSync(abs, 'utf8');
  const forwarded = [...src.matchAll(/^export \* from '([^']+)';$/gm)].map((m) => resolveModule(rel, m[1]));
  if (forwarded.length === 0) return [rel];
  const sideEffects = [...src.matchAll(/^import '(\.[^']+)';$/gm)].map((m) => resolveModule(rel, m[1]));
  return [rel, ...forwarded, ...sideEffects];
}

describe('rerender-article-corpus.yml push filter covers the real article render path', () => {
  it('names only files that exist, so a rename cannot silently empty the filter', () => {
    const stale = FILTERS.filter(({ glob }) => !glob.includes('*') && !isTracked(glob)).map(({ glob }) => glob);
    expect(stale).toEqual([]);
  });

  it('covers every module the driver renders with, behind shims and symlinks', () => {
    const driver = fs.readFileSync(path.join(ROOT, DRIVER), 'utf8');
    const loaded = [...driver.matchAll(/await import\('(\.\.\/build-plugins\/[^']+)'\)/g)].map((m) =>
      resolveModule(DRIVER, m[1]),
    );
    // ogPagesPlugin, flatHtmlRedirect, blogContextualLinks, hreflang,
    // blogImageCdnFinalize, constants, articleSectionDescriptors.
    expect(loaded.length).toBeGreaterThanOrEqual(7);
    const sources = [...new Set(loaded.flatMap(renderSources))];
    // The two colocation shims must have been followed, or this proves nothing.
    expect(sources).toContain('packages/articles/engine/ogPagesPlugin.ts');
    expect(sources).toContain(BOOTSTRAP);
    expect(sources.filter((rel) => !isCovered(rel))).toEqual([]);
  });

  it('covers every module the site-shell bootstrap hands to the engine', () => {
    const src = fs.readFileSync(path.join(ROOT, BOOTSTRAP), 'utf8');
    const imports = [...src.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => resolveModule(BOOTSTRAP, m[1]));
    // constants.ts carries the GTAG/AdSense/Offerwall/Partnerize head snippets
    // the drift run caught out of date; it must stay in this set.
    expect(imports).toContain('build-plugins/constants.ts');
    expect(imports.filter((rel) => !isCovered(rel))).toEqual([]);
  });
});
