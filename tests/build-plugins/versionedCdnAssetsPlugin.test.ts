import {
  declareRouteHintEmitter,
  resetRegisteredRouteChunks,
  routeChunksMetaTag,
} from '../../build-plugins/shared/modulePreloads';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVersionedBootstrap,
  staticImportClosure,
  isStableBlogBodyAsset,
  isStableOutOfBandAsset,
  planVersionedCdnAssets,
  pointReleaseBlogBodyImportsAtStableLeaves,
  pointReleaseStableDataImportsAtStableLeaves,
  rewriteReleaseAssetReferences,
  versionedCdnAssetsPlugin,
} from '@/build-plugins/versionedCdnAssetsPlugin';

const CDN = 'https://cdn.frontaliereticino.ch';
const BUILD = '1793012345678';

describe('versioned CDN asset namespace', () => {
  const previousCdn = process.env.ASSET_CDN;
  const previousBuild = process.env.DEPLOY_BUILD_ID;

  afterEach(() => {
    if (previousCdn === undefined) delete process.env.ASSET_CDN;
    else process.env.ASSET_CDN = previousCdn;
    if (previousBuild === undefined) delete process.env.DEPLOY_BUILD_ID;
    else process.env.DEPLOY_BUILD_ID = previousBuild;
  });

  it('recognizes only locale-qualified blog body leaves as stable data assets', () => {
    expect(isStableBlogBodyAsset('article.it.js')).toBe(true);
    expect(isStableBlogBodyAsset('article.ch.de.js')).toBe(true);
    expect(isStableBlogBodyAsset('it-core.js')).toBe(false);
    expect(isStableBlogBodyAsset('newsletterSubscribers.js')).toBe(false);
    expect(isStableOutOfBandAsset('blog-meta-it.js')).toBe(true);
    expect(isStableBlogBodyAsset('blog-meta-it.js')).toBe(false);
    expect(isStableOutOfBandAsset('App.js')).toBe(false);
  });

  it('rewrites absolute module URLs without touching hashed suffixes', () => {
    const source = [
      `const a = "${CDN}/assets/App.js";`,
      'const b = "/assets/shared-services.js";',
      `const c = "${CDN}/assets/App.js.map";`,
    ].join('\n');
    expect(rewriteReleaseAssetReferences(source, ['App.js', 'shared-services.js'], BUILD, CDN)).toBe([
      `const a = "${CDN}/assets/releases/${BUILD}/App.js";`,
      `const b = "/assets/releases/${BUILD}/shared-services.js";`,
      `const c = "${CDN}/assets/App.js.map";`,
    ].join('\n'));
  });

  it('points generated article-body imports back to the stable leaf namespace', () => {
    const source = `import("./first.it.js");import('./second.ch.de.js');import("./App.js");`;
    expect(pointReleaseBlogBodyImportsAtStableLeaves(source)).toBe(
      `import("../../first.it.js");import('../../second.ch.de.js');import("./App.js");`,
    );
  });

  it('keeps independently published article modules at stable paths', () => {
    const source = [
      `import meta from './blog-meta-it.js';`,
      `const data = import("./blog-articles-data.js");`,
      `import { BLOG_SLUGS } from './routerBlogData.js';`,
      `const absolute = "/assets/blog-meta-en.js";`,
    ].join('\n');
    expect(pointReleaseStableDataImportsAtStableLeaves(source)).toBe([
      `import meta from '../../blog-meta-it.js';`,
      `const data = import("../../blog-articles-data.js");`,
      `import { BLOG_SLUGS } from '../../routerBlogData.js';`,
      `const absolute = "/assets/blog-meta-en.js";`,
    ].join('\n'));
  });

  it('emits a literal release hint so the live graph checker can follow the bootstrap', () => {
    const bootstrap = buildVersionedBootstrap(CDN, BUILD);
    expect(bootstrap).toContain(`FRONTALIERE_VERSIONED_ENTRY: ${CDN}/assets/releases/${BUILD}/index-entry.js`);
    expect(bootstrap).toContain('import(FRONTALIERE_ENTRY)');
  });

  it('waits for the hint emitters even when it starts first', async () => {
    resetRegisteredRouteChunks();
    const root = mkdtempSync(join(tmpdir(), 'versioned-cdn-hints-'));
    const assets = join(root, 'dist', 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'index-entry.js'), `import "./App.js";`);
    writeFileSync(join(assets, 'App.js'), '');
    writeFileSync(join(assets, 'JobBoard.js'), '');

    process.env.ASSET_CDN = CDN;
    process.env.DEPLOY_BUILD_ID = BUILD;
    const endEmitter = declareRouteHintEmitter();
    const plugin = versionedCdnAssetsPlugin(root);
    const closing = (plugin.closeBundle as { handler: () => Promise<void> }).handler();
    await Promise.resolve();
    expect(existsSync(join(assets, 'releases', BUILD))).toBe(false);

    routeChunksMetaTag(['JobBoard.js', 'gone.js']);
    endEmitter();
    await closing;

    const bootstrap = readFileSync(join(assets, 'index-entry.js'), 'utf8');
    expect(bootstrap).toContain('const FRONTALIERE_ROUTE_CHUNKS=["JobBoard.js"];');
    resetRegisteredRouteChunks();
    delete process.env.ASSET_CDN;
    delete process.env.DEPLOY_BUILD_ID;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps running after every parallel closeBundle', () => {
    const closeBundle = versionedCdnAssetsPlugin('/nowhere').closeBundle as { order: string; sequential: boolean };
    expect(closeBundle.order).toBe('post');
    expect(closeBundle.sequential).toBe(true);
  });

  it('flattens the static closure and skips dynamic imports and foreign names', () => {
    const sources: Record<string, string> = {
      'index-entry.js': `import"./vendor-react.js";import{a}from"./i18n.js";import("./Lazy.js");`,
      'App.js': `import{b}from"./i18n.js";export{c}from"./router.js";import"./gone.js";`,
      'i18n.js': ``,
      'vendor-react.js': ``,
      'router.js': `import"../../routerBlogData.js";`,
      'Lazy.js': ``,
    };
    const closure = staticImportClosure(['index-entry.js', 'App.js'], new Set(Object.keys(sources)), (a) => sources[a]);
    expect(closure.sort()).toEqual(['App.js', 'i18n.js', 'index-entry.js', 'router.js', 'vendor-react.js']);
  });

  it('turns only allowed names into release preloads, before importing the entry', () => {
    const bootstrap = buildVersionedBootstrap(CDN, BUILD, {
      modules: ['vendor-react.js'],
      routeChunks: ['JobBoard.js'],
    });
    const links: Array<Record<string, string>> = [];
    const order: string[] = [];
    const document = {
      querySelector: () => ({ content: 'vendor-react.js JobBoard.js stale-chunk.js' }),
      createElement: () => ({}),
      head: { appendChild: (link: Record<string, string>) => { links.push(link); order.push('link'); } },
    };
    const run = new Function('document', 'importer', bootstrap.replace('import(FRONTALIERE_ENTRY)', 'importer(FRONTALIERE_ENTRY)'));
    run(document, (url: string) => order.push(url));
    const base = `${CDN}/assets/releases/${BUILD}/`;
    expect(links.map((link) => link.href)).toEqual([`${base}vendor-react.js`, `${base}JobBoard.js`]);
    expect(links.every((link) => link.rel === 'modulepreload' && link.crossOrigin === '')).toBe(true);
    expect(order).toEqual(['link', 'link', `${base}index-entry.js`]);
  });

  it('still starts the app when the preload step throws', () => {
    const bootstrap = buildVersionedBootstrap(CDN, BUILD);
    const entries: string[] = [];
    const document = { querySelector: () => { throw new Error('no DOM'); } };
    const run = new Function('document', 'importer', bootstrap.replace('import(FRONTALIERE_ENTRY)', 'importer(FRONTALIERE_ENTRY)'));
    run(document, (url: string) => entries.push(url));
    expect(entries).toEqual([`${CDN}/assets/releases/${BUILD}/index-entry.js`]);
  });

  it('copies the executable graph and replaces the stable entry with a release bootstrap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'versioned-cdn-assets-'));
    const assets = join(root, 'dist', 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'index-entry.js'), `import "./App.js";const deps=["${CDN}/assets/App.js"];`);
    writeFileSync(join(assets, 'App.js'), `import "./shared.js";`);
    writeFileSync(join(assets, 'shared.js'), 'export const ready = true;');
    writeFileSync(join(assets, 'blog-articles-data.js'), 'export const ARTICLES = [];');
    writeFileSync(join(assets, 'blog-meta-it.js'), 'export default {};');
    writeFileSync(join(assets, 'routerBlogData.js'), 'export const BLOG_SLUGS = {};');
    writeFileSync(join(assets, 'stableConsumer.js'), [
      `import "./blog-meta-it.js";`,
      `import("./blog-articles-data.js");`,
      `import { BLOG_SLUGS } from "./routerBlogData.js";`,
    ].join('\n'));
    writeFileSync(join(assets, 'blogBodyLoader.js'), `import("./first.it.js");`);
    writeFileSync(join(assets, 'first.it.js'), 'export default {};');
    writeFileSync(join(assets, 'index.css'), 'body{color:red}');

    process.env.ASSET_CDN = CDN;
    process.env.DEPLOY_BUILD_ID = BUILD;
    const plugin = versionedCdnAssetsPlugin(root);
    await (plugin.closeBundle as { handler: () => Promise<void> }).handler();

    const release = join(assets, 'releases', BUILD);
    expect(existsSync(join(release, 'index-entry.js'))).toBe(true);
    expect(existsSync(join(release, 'App.js'))).toBe(true);
    expect(existsSync(join(release, 'shared.js'))).toBe(true);
    expect(existsSync(join(release, 'stableConsumer.js'))).toBe(true);
    expect(existsSync(join(release, 'blog-articles-data.js'))).toBe(false);
    expect(existsSync(join(release, 'blog-meta-it.js'))).toBe(false);
    expect(existsSync(join(release, 'routerBlogData.js'))).toBe(false);
    expect(existsSync(join(release, 'index.css'))).toBe(true);
    expect(existsSync(join(release, 'first.it.js'))).toBe(false);
    expect(readFileSync(join(release, 'index-entry.js'), 'utf8')).toContain(
      `/assets/releases/${BUILD}/App.js`,
    );
    expect(readFileSync(join(release, 'blogBodyLoader.js'), 'utf8')).toContain(
      'import("../../first.it.js")',
    );
    expect(readFileSync(join(release, 'stableConsumer.js'), 'utf8')).toContain(
      '../../blog-articles-data.js',
    );
    expect(readFileSync(join(assets, 'index-entry.js'), 'utf8')).toContain(
      `/assets/releases/${BUILD}/index-entry.js`,
    );

    const plan = planVersionedCdnAssets({ assetsDir: assets, cdnOrigin: CDN, buildId: BUILD });
    expect(plan.assetPaths).toEqual([
      'App.js',
      'blogBodyLoader.js',
      'index-entry.js',
      'index.css',
      'shared.js',
      'stableConsumer.js',
    ]);
    expect(plan.stableBlogBodyAssets).toEqual(['first.it.js']);
    expect(plan.stableOutOfBandAssets).toEqual([
      'blog-articles-data.js',
      'blog-meta-it.js',
      'routerBlogData.js',
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
