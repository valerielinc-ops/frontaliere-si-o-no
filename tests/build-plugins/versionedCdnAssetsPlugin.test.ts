import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVersionedBootstrap,
  isStableBlogBodyAsset,
  planVersionedCdnAssets,
  pointReleaseBlogBodyImportsAtStableLeaves,
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

  it('emits a literal release hint so the live graph checker can follow the bootstrap', () => {
    const bootstrap = buildVersionedBootstrap(CDN, BUILD);
    expect(bootstrap).toContain(`FRONTALIERE_VERSIONED_ENTRY: ${CDN}/assets/releases/${BUILD}/index-entry.js`);
    expect(bootstrap).toContain('import(FRONTALIERE_ENTRY)');
  });

  it('copies the executable graph and replaces the stable entry with a release bootstrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'versioned-cdn-assets-'));
    const assets = join(root, 'dist', 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'index-entry.js'), `import "./App.js";const deps=["${CDN}/assets/App.js"];`);
    writeFileSync(join(assets, 'App.js'), `import "./shared.js";`);
    writeFileSync(join(assets, 'shared.js'), 'export const ready = true;');
    writeFileSync(join(assets, 'blogBodyLoader.js'), `import("./first.it.js");`);
    writeFileSync(join(assets, 'first.it.js'), 'export default {};');
    writeFileSync(join(assets, 'index.css'), 'body{color:red}');

    process.env.ASSET_CDN = CDN;
    process.env.DEPLOY_BUILD_ID = BUILD;
    const plugin = versionedCdnAssetsPlugin(root);
    (plugin.closeBundle as { handler: () => void }).handler();

    const release = join(assets, 'releases', BUILD);
    expect(existsSync(join(release, 'index-entry.js'))).toBe(true);
    expect(existsSync(join(release, 'App.js'))).toBe(true);
    expect(existsSync(join(release, 'shared.js'))).toBe(true);
    expect(existsSync(join(release, 'index.css'))).toBe(true);
    expect(existsSync(join(release, 'first.it.js'))).toBe(false);
    expect(readFileSync(join(release, 'index-entry.js'), 'utf8')).toContain(
      `/assets/releases/${BUILD}/App.js`,
    );
    expect(readFileSync(join(release, 'blogBodyLoader.js'), 'utf8')).toContain(
      'import("../../first.it.js")',
    );
    expect(readFileSync(join(assets, 'index-entry.js'), 'utf8')).toContain(
      `/assets/releases/${BUILD}/index-entry.js`,
    );

    const plan = planVersionedCdnAssets({ assetsDir: assets, cdnOrigin: CDN, buildId: BUILD });
    expect(plan.assetPaths).toEqual(['App.js', 'blogBodyLoader.js', 'index-entry.js', 'index.css', 'shared.js']);
    expect(plan.stableBlogBodyAssets).toEqual(['first.it.js']);
    rmSync(root, { recursive: true, force: true });
  });
});
