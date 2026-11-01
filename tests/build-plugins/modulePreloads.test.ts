/**
 * Gate: a page's HTML never preloads a root /assets/ alias.
 *
 * The executable graph is under /assets/releases/<BUILD_ID>/, so a root preload
 * is a second download of a module nobody executes. Live 2026-10-31: 1 to 6
 * duplicated modules per page (JobBoard.js 0.59 MB, it-core.js 0.23 MB).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  declareRouteHintEmitter,
  getRegisteredRouteChunks,
  resetRegisteredRouteChunks,
  routeChunksMetaTag,
  routeHintEmittersSettled,
} from '../../build-plugins/shared/modulePreloads';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8');

describe('routeChunksMetaTag', () => {
  beforeEach(() => resetRegisteredRouteChunks());

  it('drops repeats and empty entries, keeping order', () => {
    expect(routeChunksMetaTag(['A.js', '', null, 'B.js', 'A.js', undefined])).toBe(
      '<meta name="frontaliere-route-chunks" content="A.js B.js">',
    );
  });

  it('emits nothing for an empty list', () => {
    expect(routeChunksMetaTag([null, ''])).toBe('');
  });

  it('registers every hinted chunk for the bootstrap allowlist', () => {
    routeChunksMetaTag(['B.js']);
    routeChunksMetaTag(['A.js', 'B.js']);
    expect(getRegisteredRouteChunks()).toEqual(['A.js', 'B.js']);
  });
});

describe('routeHintEmittersSettled', () => {
  beforeEach(() => resetRegisteredRouteChunks());

  it('resolves at once when no emitter is active', async () => {
    await expect(routeHintEmittersSettled()).resolves.toBeUndefined();
  });

  it('waits for the last active emitter', async () => {
    const endFirst = declareRouteHintEmitter();
    const endSecond = declareRouteHintEmitter();
    let settled = false;
    const waiting = routeHintEmittersSettled().then(() => { settled = true; });
    endFirst();
    await Promise.resolve();
    expect(settled).toBe(false);
    endSecond();
    await waiting;
    expect(settled).toBe(true);
  });

  it.each(['build-plugins/staticPagesPlugin.ts', 'build-plugins/preloadLocalePlugin.ts'])(
    '%s declares itself at buildStart and ends in a finally',
    (file) => {
      const source = read(file);
      expect(source).toContain('endRouteHints = declareRouteHintEmitter();');
      expect(source).toMatch(/finally \{[^}]*endRouteHints\(\);/);
    },
  );
});

describe('no HTML emitter preloads a root alias', () => {
  it.each(['build-plugins/staticPagesPlugin.ts', 'build-plugins/preloadLocalePlugin.ts'])('%s', (file) => {
    const emitted = read(file)
      .split('\n')
      .filter((line) => /<link rel="modulepreload"/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    expect(emitted).toEqual([]);
  });

  it('Vite does not inject the entry dependencies into the HTML', () => {
    expect(read('vite.config.ts')).toMatch(/if \(hostType === 'html'\) return \[\];/);
  });

  it('the static page head merges core and route chunks into one hint', () => {
    expect(read('build-plugins/staticPagesPlugin.ts')).toMatch(/routeChunksMetaTag\(\[\.\.\.corePreloadChunks, \.\.\.routeChunks\]\)/);
  });
});
