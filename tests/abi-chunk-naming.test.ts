import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ABI_HASH_LENGTH,
  GRANDFATHERED_ABI_HASHES,
  abiChunkFileName,
  chunkAbiHash,
  chunkFileInManifest,
  expectedAbiHash,
  isAbiChunkNamingEnabled,
  isChunkManifest,
  namedChunkExports,
  parseAbiSuffix,
  usesInterfaceAddressedNames,
  withAbiSuffix,
} from '@/build-plugins/shared/abiChunkNaming';

/**
 * Pins the interface-addressed chunk naming (build-plugins/shared/abiChunkNaming.mjs)
 * that closes the cross-chunk version-skew SyntaxError class:
 *   "Importing binding name 'isLikelyBot' is not found."  (WebKit)
 *   "does not provide an export named 'x'"                (V8)
 */
describe('chunkAbiHash', () => {
  it('is empty for chunks without a named export — their URL needs no suffix', () => {
    expect(chunkAbiHash([])).toBe('');
    expect(chunkAbiHash(['default'])).toBe('');
    expect(chunkAbiHash(null)).toBe('');
    expect(chunkAbiHash(undefined)).toBe('');
  });

  it('is an 8-hex digest of the named exports', () => {
    expect(chunkAbiHash(['isLikelyBot'])).toMatch(new RegExp(`^[0-9a-f]{${ABI_HASH_LENGTH}}$`));
  });

  it('ignores order, duplicates and `default`', () => {
    const base = chunkAbiHash(['a', 'b', 'c']);
    expect(chunkAbiHash(['c', 'a', 'b'])).toBe(base);
    expect(chunkAbiHash(['a', 'b', 'c', 'c', 'a'])).toBe(base);
    expect(chunkAbiHash(['default', 'a', 'b', 'c'])).toBe(base);
  });

  it('moves when a name is added, removed or renamed', () => {
    const base = chunkAbiHash(['a', 'b']);
    expect(chunkAbiHash(['a', 'b', 'c'])).not.toBe(base);
    expect(chunkAbiHash(['a'])).not.toBe(base);
    expect(chunkAbiHash(['a', 'bb'])).not.toBe(base);
  });

  it('does not collide on names that concatenate to the same string', () => {
    expect(chunkAbiHash(['ab', 'c'])).not.toBe(chunkAbiHash(['a', 'bc']));
  });
});

describe('withAbiSuffix / parseAbiSuffix', () => {
  it('inserts the hash before the extension and round-trips', () => {
    const named = withAbiSuffix('assets/mx.js', ['Analytics', 'isLikelyBot']);
    expect(named).toMatch(/^assets\/mx\.[0-9a-f]{8}\.js$/);
    const parsed = parseAbiSuffix(named);
    expect(parsed?.base).toBe('assets/mx.js');
    expect(parsed?.hash).toBe(chunkAbiHash(['Analytics', 'isLikelyBot']));
  });

  it('leaves default-only chunks and non-JS files untouched', () => {
    expect(withAbiSuffix('assets/it-core.js', ['default'])).toBe('assets/it-core.js');
    expect(withAbiSuffix('assets/index.css', ['x'])).toBe('assets/index.css');
  });

  it('does not mistake locale-keyed or legacy-hashed names for an interface hash', () => {
    expect(parseAbiSuffix('assets/slug.it.js')).toBeNull();
    expect(parseAbiSuffix('assets/slug.ch.fr.js')).toBeNull();
    expect(parseAbiSuffix('assets/blog-meta-it-aB3_x9Yz.js')).toBeNull();
  });
});

describe('expectedAbiHash / abiChunkFileName — which chunks carry a hash', () => {
  it('hashes a shared hub chunk that exports names', () => {
    expect(expectedAbiHash('mx', ['Analytics', 'isLikelyBot'])).toBe(chunkAbiHash(['Analytics', 'isLikelyBot']));
    expect(abiChunkFileName('assets/mx.js', 'mx', ['Analytics', 'isLikelyBot'])).toMatch(/^assets\/mx\.[0-9a-f]{8}\.js$/);
  });

  it('leaves default-only chunks alone', () => {
    expect(abiChunkFileName('assets/it-core.js', 'it-core', ['default'])).toBe('assets/it-core.js');
  });

  it('hashes a lazy page component that other chunks import names from — JobBoard is a real hub', () => {
    // 8 lazy children (JobAlertForm, JobAlertEndCard, …) import hooks and constants that Rollup
    // homed in the JobBoard chunk; it is exactly the shape that broke `isLikelyBot`.
    expect(abiChunkFileName('assets/JobBoard.js', 'JobBoard', ['JobBoard', 'useImpressionTracker'])).toMatch(
      /^assets\/JobBoard\.[0-9a-f]{8}\.js$/,
    );
  });

  it('keeps the chunks a renderer outside the build spells by plain name on that spelling', () => {
    expect(abiChunkFileName('assets/it-core.js', 'it-core', ['default'])).toBe('assets/it-core.js');
    expect(abiChunkFileName('assets/blog-meta-it.js', 'blog-meta-it', ['default'])).toBe('assets/blog-meta-it.js');
    // ... even if one ever gains a named export: the verifier fails the build, nothing is hashed behind its back.
    expect(abiChunkFileName('assets/blog-meta-it.js', 'blog-meta-it', ['default', 'x'])).toBe('assets/blog-meta-it.js');
  });

  it('keeps vendor-react plain while it has its baseline interface, and hashes it the day it differs', () => {
    // The recorded production export set of vendor-react.
    const baseline = [
      'React', 'React$1', 'client', 'commonjsGlobal', 'getAugmentedNamespace',
      'getDefaultExportFromCjs', 'jsxRuntimeExports', 'reactDomExports', 'reactExports', 'requireReact',
    ];
    expect(chunkAbiHash(baseline)).toBe(GRANDFATHERED_ABI_HASHES['vendor-react']);
    expect(abiChunkFileName('assets/vendor-react.js', 'vendor-react', baseline)).toBe('assets/vendor-react.js');
    expect(abiChunkFileName('assets/vendor-react.js', 'vendor-react', [...baseline, 'useId'])).toMatch(
      /^assets\/vendor-react\.[0-9a-f]{8}\.js$/,
    );
    expect(abiChunkFileName('assets/vendor-react.js', 'vendor-react', baseline.slice(1))).toMatch(
      /^assets\/vendor-react\.[0-9a-f]{8}\.js$/,
    );
  });
});

describe('namedChunkExports', () => {
  it('returns the sorted, de-duplicated named exports', () => {
    expect(namedChunkExports(['b', 'default', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('isAbiChunkNamingEnabled — build kill switch', () => {
  it('is on unless SPA_ABI_CHUNK_NAMES=0', () => {
    expect(isAbiChunkNamingEnabled({})).toBe(true);
    expect(isAbiChunkNamingEnabled({ SPA_ABI_CHUNK_NAMES: '1' })).toBe(true);
    expect(isAbiChunkNamingEnabled({ SPA_ABI_CHUNK_NAMES: '0' })).toBe(false);
  });
});

describe('isChunkManifest / chunkFileInManifest', () => {
  const manifest = { v: 1, chunks: { mx: 'mx.3fa9c0de.js' } };

  it('accepts the shape the build publishes and nothing else', () => {
    expect(isChunkManifest(manifest)).toBe(true);
    expect(isChunkManifest({ v: 1, chunks: {} })).toBe(true);
    for (const bad of [null, undefined, 'x', 42, [], {}, { chunks: {} }, { v: 2, chunks: {} }, { v: 1 }, { v: 1, chunks: [] }, { v: 1, chunks: null }]) {
      expect(isChunkManifest(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers with the emitted file, and with undefined — never a guessed <name>.js — for an unlisted chunk', () => {
    // The plain spelling of a renamed chunk is an older generation's retained file (a 200):
    // guessing it would let a probe pass on a deploy whose real file is missing.
    expect(chunkFileInManifest(manifest, 'mx')).toBe('mx.3fa9c0de.js');
    expect(chunkFileInManifest(manifest, 'App')).toBeUndefined();
    expect(chunkFileInManifest({ v: 1, chunks: { App: '' } }, 'App')).toBeUndefined();
  });
});

describe('usesInterfaceAddressedNames — telling the generation apart from its entry', () => {
  it('recognises an entry that imports interface-hashed files', () => {
    expect(usesInterfaceAddressedNames('import{__vitePreload as m}from"./i18n.a56b3675.js";')).toBe(true);
    expect(usesInterfaceAddressedNames("import('./App.e821447c.js')")).toBe(true);
  });

  it('treats an entry from before the scheme (plain names only) as legacy', () => {
    expect(usesInterfaceAddressedNames('import{__vitePreload as m}from"./i18n.js";')).toBe(false);
    expect(usesInterfaceAddressedNames('import("./slug.it.js")')).toBe(false);
    expect(usesInterfaceAddressedNames('')).toBe(false);
    expect(usesInterfaceAddressedNames(null)).toBe(false);
  });
});

describe('chunkFiles.ts stays self-contained (it is mirrored into the publisher repo)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'build-plugins/shared/chunkFiles.ts'), 'utf-8');

  it('keeps a literal copy of ABI_HASH_LENGTH equal to the real one', () => {
    expect(src).toContain(`const ABI_HASH_LENGTH = ${ABI_HASH_LENGTH};`);
  });

  it('imports nothing the publisher repo does not carry', () => {
    // host/shared/chunkFiles.ts is a byte-identical copy; the only sibling it may import is viteAssetHashRx.
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./viteAssetHashRx']);
  });
});

describe('vite.config.ts wiring', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');

  it('keeps export names semantic — the interface hash is computed from them', () => {
    // With the Rollup default (true) internal exports are re-lettered every
    // build, so the hash would rotate on every deploy and every page that
    // preloads a hashed chunk would churn.
    expect(src).toContain('minifyInternalExports: false');
  });

  it('routes chunk names through withAbiSuffix, honouring the kill switch and skipping blog bodies', () => {
    expect(src).toContain('if (m || !isAbiChunkNamingEnabled()) return base;');
    expect(src).toContain("return abiChunkFileName(base, chunk.name ?? '', chunk.exports);");
  });

  it('registers the chunk-file registry as a core plugin (it must run under FAST_BUILD too)', () => {
    expect(src).toContain('chunkFileRegistryPlugin(),');
  });
});

/**
 * The incident, reproduced with the real bundler: two generations of the same
 * app are written over one directory (the CDN with stable names and an
 * additive publish), while the browser still holds an importer chunk from the
 * previous generation.
 */
describe('cross-generation module linking (real Rollup)', () => {
  const workDirs: string[] = [];
  afterAll(() => {
    for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** gen 1: `a` imports foo+bar from the shared module. gen 2: nobody imports `bar` any more. */
  function sources(generation: 1 | 2): Record<string, string> {
    return {
      'entry.js': "export const load = () => Promise.all([import('./a.js'), import('./b.js')]);",
      'a.js': generation === 1
        ? "import { foo, bar } from './shared.js'; export default () => foo() + bar();"
        : "import { foo } from './shared.js'; export default () => foo();",
      'b.js': "import { foo } from './shared.js'; export default () => foo();",
      'shared.js': "export const foo = () => 'foo'; export const bar = () => 'bar'; export const baz = () => 'baz';",
    };
  }

  async function build(generation: 1 | 2, outDir: string, abi: boolean): Promise<void> {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), `abi-src-g${generation}-`));
    workDirs.push(srcDir);
    for (const [file, code] of Object.entries(sources(generation))) {
      fs.writeFileSync(path.join(srcDir, file), code);
    }
    const bundle = await rollup({
      input: path.join(srcDir, 'entry.js'),
      treeshake: { moduleSideEffects: false },
      onwarn: () => {},
    });
    await bundle.write({
      dir: outDir,
      format: 'es',
      // Same output options the site relies on (vite.config.ts).
      minifyInternalExports: false,
      entryFileNames: 'entry.js',
      chunkFileNames: (chunk) => {
        const base = `${chunk.name}.js`;
        // The exact function vite.config.ts calls.
        return abi ? abiChunkFileName(base, chunk.name, chunk.exports) : base;
      },
      manualChunks: (id) => (id.endsWith('shared.js') ? 'shared' : undefined),
    });
    await bundle.close();
  }

  /** Publish gen 1, then gen 2 over it (additive copy), and return the CDN dir + the gen-1 importer the browser cached. */
  async function simulateDeploys(abi: boolean): Promise<{ cdn: string; cachedImporter: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `abi-cdn-${abi ? 'abi' : 'stable'}-`));
    workDirs.push(root);
    const gen1 = path.join(root, 'gen1');
    const gen2 = path.join(root, 'gen2');
    const cdn = path.join(root, 'cdn');
    await build(1, gen1, abi);
    fs.cpSync(gen1, cdn, { recursive: true });
    await build(2, gen2, abi);
    fs.cpSync(gen2, cdn, { recursive: true, force: true });
    return { cdn, cachedImporter: path.join(gen1, 'a.js') };
  }

  /**
   * Link the cached gen-1 importer against the CDN's files in a plain `node`
   * child process: vitest's own `import()` goes through the SSR transform and
   * never performs native ESM linking, which is the step that throws in a browser.
   */
  function linkCachedImporter(cdn: string, cachedImporter: string): string {
    // The browser keeps its cached gen-1 `a.js`; everything it imports comes from the CDN.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-browser-'));
    workDirs.push(dir);
    fs.cpSync(cdn, dir, { recursive: true });
    fs.copyFileSync(cachedImporter, path.join(dir, 'a.js'));
    const runner = path.join(dir, 'link-runner.mjs');
    fs.writeFileSync(
      runner,
      "import(process.argv[2]).then((m) => process.stdout.write(String(m.default())), (e) => { process.stderr.write(e.message); process.exit(1); });",
    );
    try {
      return execFileSync(process.execPath, [runner, pathToFileURL(path.join(dir, 'a.js')).href], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(String((error as { stderr?: string }).stderr || error));
    }
  }

  it('FAILS with stable names — the production error, "does not provide an export named"', async () => {
    const { cdn, cachedImporter } = await simulateDeploys(false);
    expect(() => linkCachedImporter(cdn, cachedImporter)).toThrow(/does not provide an export named 'bar'/);
  });

  it('links with interface-addressed names — the previous generation keeps its own dependency file', async () => {
    const { cdn, cachedImporter } = await simulateDeploys(true);
    expect(linkCachedImporter(cdn, cachedImporter)).toBe('foobar');
  });

  it('gives a chunk whose interface did not change the same URL in both generations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-stable-iface-'));
    workDirs.push(root);
    await build(1, path.join(root, 'gen1'), true);
    await build(2, path.join(root, 'gen2'), true);
    const only = (dir: string, prefix: string) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
    // `b` is default-only in both generations → plain name, identical.
    expect(only(path.join(root, 'gen1'), 'b')).toEqual(only(path.join(root, 'gen2'), 'b'));
    // `shared` lost `bar`'s consumer → its interface changed → its URL moved.
    expect(only(path.join(root, 'gen1'), 'shared')).not.toEqual(only(path.join(root, 'gen2'), 'shared'));
  });
});
