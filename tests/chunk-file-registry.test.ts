import { beforeEach, describe, expect, it } from 'vitest';
import { chunkFileRegistryPlugin } from '@/build-plugins/chunkFileRegistryPlugin';
import { CHUNK_MANIFEST_FILENAME } from '@/build-plugins/shared/abiChunkNaming';
import {
  builtChunkFilesSnapshot,
  registerBuiltChunkFiles,
  resetBuiltChunkFiles,
  stableChunkFile,
  stableChunkFiles,
} from '@/build-plugins/shared/chunkFiles';

/**
 * The prerendered pages and index.html carry <link rel="modulepreload"> hints
 * for chunks the build plugins look up BY NAME from `closeBundle`. Since chunk
 * filenames are interface-addressed, that lookup must return the real emitted
 * name — a stale `<name>.js` spelling would ship as a 404 hint on ~1.28M pages.
 */
describe('built chunk file registry', () => {
  beforeEach(() => resetBuiltChunkFiles());

  it('falls back to the plain <name>.js spelling when nothing was registered', () => {
    expect(stableChunkFile('it-core')).toBe('it-core.js');
    expect(stableChunkFiles(['it-core', 'it-calculator'])).toEqual(['it-core.js', 'it-calculator.js']);
  });

  it('answers with the real emitted basename once the build registered it', () => {
    registerBuiltChunkFiles([
      { name: 'vendor-react', fileName: 'assets/vendor-react.5a1b2c3d.js' },
      { name: 'it-core', fileName: 'assets/it-core.js' },
    ]);
    expect(stableChunkFile('vendor-react')).toBe('vendor-react.5a1b2c3d.js');
    expect(stableChunkFiles(['it-core', 'vendor-react'])).toEqual(['it-core.js', 'vendor-react.5a1b2c3d.js']);
  });

  it('does not register a name carried by several chunks (blog bodies share a basename across locales)', () => {
    registerBuiltChunkFiles([
      { name: 'some-article', fileName: 'assets/some-article.it.js' },
      { name: 'some-article', fileName: 'assets/some-article.en.js' },
      { name: 'App', fileName: 'assets/App.0f0f0f0f.js' },
    ]);
    expect(builtChunkFilesSnapshot()).toEqual({ App: 'App.0f0f0f0f.js' });
    expect(stableChunkFile('some-article')).toBe('some-article.js');
  });

  it('forgets the previous build on reset', () => {
    registerBuiltChunkFiles([{ name: 'App', fileName: 'assets/App.0f0f0f0f.js' }]);
    resetBuiltChunkFiles();
    expect(stableChunkFile('App')).toBe('App.js');
  });

  it('snapshots in a deterministic (sorted) order so the manifest is byte-stable', () => {
    registerBuiltChunkFiles([
      { name: 'zeta', fileName: 'assets/zeta.js' },
      { name: 'alpha', fileName: 'assets/alpha.12345678.js' },
    ]);
    expect(Object.keys(builtChunkFilesSnapshot())).toEqual(['alpha', 'zeta']);
  });
});

describe('chunkFileRegistryPlugin', () => {
  beforeEach(() => resetBuiltChunkFiles());

  type Hooks = {
    buildStart: () => void;
    generateBundle: (this: { emitFile: (file: unknown) => void }, options: unknown, bundle: Record<string, unknown>) => void;
  };
  const plugin = chunkFileRegistryPlugin() as unknown as Hooks & { enforce: string; apply: string };

  it('runs on every build, before the plugins that read the registry', () => {
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('pre');
  });

  it('registers the emitted chunks in generateBundle and publishes the manifest asset', () => {
    const emitted: unknown[] = [];
    plugin.buildStart();
    plugin.generateBundle.call(
      { emitFile: (file) => emitted.push(file) },
      {},
      {
        'assets/mx.3fa9c0de.js': { type: 'chunk', name: 'mx', fileName: 'assets/mx.3fa9c0de.js' },
        'assets/it-core.js': { type: 'chunk', name: 'it-core', fileName: 'assets/it-core.js' },
        'assets/index.css': { type: 'asset', fileName: 'assets/index.css', name: 'index.css' },
      },
    );

    expect(stableChunkFile('mx')).toBe('mx.3fa9c0de.js');
    expect(stableChunkFile('it-core')).toBe('it-core.js');
    expect(emitted).toHaveLength(1);
    const asset = emitted[0] as { type: string; fileName: string; source: string };
    expect(asset.type).toBe('asset');
    expect(asset.fileName).toBe(CHUNK_MANIFEST_FILENAME);
    expect(JSON.parse(asset.source)).toEqual({ v: 1, chunks: { 'it-core': 'it-core.js', mx: 'mx.3fa9c0de.js' } });
  });
});
