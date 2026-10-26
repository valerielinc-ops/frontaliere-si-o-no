/**
 * Publish the executable SPA graph under a build-scoped CDN namespace.
 *
 * Stable asset names were introduced to avoid rewriting the very large static
 * HTML corpus, but they made a browser cache part of the module linker: an
 * importer from build N could be resolved beside an exporter from build N+1.
 * Purging the CDN reduces that window but cannot evict a module already held
 * by a browser, and it cannot make a multi-key upload atomic.
 *
 * This plugin keeps the stable URL as a tiny compatibility bootstrap and puts
 * the real JS/CSS graph at:
 *
 *   /assets/releases/<BUILD_ID>/<asset>
 *
 * The release id is embedded in the bootstrap. A cached bootstrap therefore
 * remains safe: it always loads the complete release it was built with. The
 * release directory is additive on the CDN and retained by the janitors for
 * the browser-cache grace period.
 *
 * Blog body modules are intentionally left at their historical stable paths.
 * They are data-only default exports and are loaded through the generated
 * blogBodyLoader table. The release copy of that loader points those leaves
 * back to /assets/ explicitly; all application/code modules stay inside the
 * release namespace.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export const VERSIONED_RELEASES_DIR = 'releases';
export const VERSIONED_RELEASE_ENTRY = 'index-entry.js';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);

function normalizeCdnOrigin(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}
export function normalizeDeployBuildId(raw: string | undefined): string {
  const value = (raw || '').trim();
  return /^\d+$/.test(value) ? value : '';
}

/**
 * Body chunks have a locale qualifier emitted by blogBodyChunkNaming.ts.
 * Their only public contract is `default: BlogBodyTranslations`, so keeping
 * their stable URLs avoids duplicating tens of thousands of payload files in
 * every release while preserving the code-graph isolation.
 */
export function isStableBlogBodyAsset(relativePath: string): boolean {
  const name = path.posix.basename(relativePath);
  return /\.(?:ch\.)?(?:it|en|de|fr)\.js$/.test(name);
}

function walkFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === VERSIONED_RELEASES_DIR) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, relative));
    else if (entry.isFile()) out.push(relative.split(path.sep).join('/'));
  }
  return out.sort();
}

export function versionedAssetPaths(assetsDir: string): string[] {
  return walkFiles(assetsDir).filter((relativePath) => {
    const ext = path.posix.extname(relativePath).toLowerCase();
    if (ext === '.css') return true;
    if (!JAVASCRIPT_EXTENSIONS.has(ext)) return false;
    return !isStableBlogBodyAsset(relativePath);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite absolute CDN / same-origin references in a release module. Rollup
 * leaves static relative imports relative to the containing file, which is
 * exactly what we want after copying the graph. Vite's preload table and a
 * few runtime URLs are absolute, so those need the release prefix too.
 */
export function rewriteReleaseAssetReferences(
  source: string,
  relativeAssetPaths: readonly string[],
  buildId: string,
  cdnOrigin: string,
): string {
  const releasePrefix = `${VERSIONED_RELEASES_DIR}/${buildId}`;
  const paths = relativeAssetPaths
    .map((relativePath) => relativePath.replace(/^\/+/, ''))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (!paths) return source;

  const assetRef = new RegExp(
    `(${escapeRegExp(cdnOrigin)}/assets/|/assets/)(${paths})(?=[?#"'\\s),]|$)`,
    'g',
  );
  return source.replace(assetRef, (_match, prefix: string, assetPath: string) => (
    `${prefix}${releasePrefix}/${assetPath}`
  ));
}

/**
 * Vite emits the body glob as `import("./slug.<locale>.js")`. The loader is
 * copied into the release, while the data leaves remain at /assets/, so the
 * relative hop must go two levels up from /assets/releases/<id>/.
 */
export function pointReleaseBlogBodyImportsAtStableLeaves(source: string): string {
  return source.replace(
    /import\((['"])\.\/([^'"/]+\.(?:ch\.)?(?:it|en|de|fr)\.js)\1\)/g,
    'import($1../../$2$1)',
  );
}

export function buildVersionedBootstrap(cdnOrigin: string, buildId: string): string {
  const origin = JSON.stringify(cdnOrigin);
  const release = JSON.stringify(buildId);
  const entry = `${cdnOrigin}/assets/${VERSIONED_RELEASES_DIR}/${buildId}/${VERSIONED_RELEASE_ENTRY}`;
  return `/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP\n * FRONTALIERE_VERSIONED_ENTRY: ${entry}\n * This stable URL is a build-scoped loader; never import application modules from /assets directly.\n */\nconst FRONTALIERE_CDN_ORIGIN=${origin};\nconst FRONTALIERE_RELEASE_ID=${release};\nconst FRONTALIERE_ENTRY=FRONTALIERE_CDN_ORIGIN+\"/assets/${VERSIONED_RELEASES_DIR}/\"+FRONTALIERE_RELEASE_ID+\"/${VERSIONED_RELEASE_ENTRY}\";\nimport(FRONTALIERE_ENTRY);\n`;
}

export interface VersionedCdnAssetPlan {
  buildId: string;
  cdnOrigin: string;
  releaseDir: string;
  assetPaths: string[];
  stableBlogBodyAssets: string[];
}

export function planVersionedCdnAssets({
  assetsDir,
  cdnOrigin,
  buildId,
}: {
  assetsDir: string;
  cdnOrigin: string;
  buildId: string;
}): VersionedCdnAssetPlan {
  const assetPaths = versionedAssetPaths(assetsDir);
  const allPaths = walkFiles(assetsDir);
  return {
    buildId,
    cdnOrigin,
    releaseDir: path.join(assetsDir, VERSIONED_RELEASES_DIR, buildId),
    assetPaths,
    stableBlogBodyAssets: allPaths.filter(isStableBlogBodyAsset),
  };
}
export function versionedCdnAssetsPlugin(rootDir: string): Plugin {
  return {
    name: 'versioned-cdn-assets',
    apply: 'build',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const cdnOrigin = normalizeCdnOrigin(process.env.ASSET_CDN || '');
        const buildId = normalizeDeployBuildId(process.env.DEPLOY_BUILD_ID);
        if (!cdnOrigin || !buildId) {
          console.log('[versioned-cdn-assets] skipped (requires ASSET_CDN + DEPLOY_BUILD_ID)');
          return;
        }

        const assetsDir = path.resolve(rootDir, 'dist', 'assets');
        const originalEntry = path.join(assetsDir, VERSIONED_RELEASE_ENTRY);
        if (!fs.existsSync(originalEntry)) {
          throw new Error(`[versioned-cdn-assets] missing ${originalEntry}`);
        }

        const plan = planVersionedCdnAssets({ assetsDir, cdnOrigin, buildId });
        if (!plan.assetPaths.includes(VERSIONED_RELEASE_ENTRY)) {
          throw new Error('[versioned-cdn-assets] the SPA entry was not selected for release publishing');
        }

        fs.rmSync(plan.releaseDir, { recursive: true, force: true });
        fs.mkdirSync(plan.releaseDir, { recursive: true });
        const releasePrefix = `${VERSIONED_RELEASES_DIR}/${buildId}`;

        for (const relativePath of plan.assetPaths) {
          const sourcePath = path.join(assetsDir, relativePath);
          const targetPath = path.join(plan.releaseDir, relativePath);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          let source = fs.readFileSync(sourcePath, 'utf-8');
          if (path.posix.basename(relativePath) === 'blogBodyLoader.js') {
            source = pointReleaseBlogBodyImportsAtStableLeaves(source);
          }
          source = rewriteReleaseAssetReferences(source, plan.assetPaths, buildId, cdnOrigin);
          fs.writeFileSync(targetPath, source, 'utf-8');
        }

        fs.writeFileSync(
          originalEntry,
          buildVersionedBootstrap(cdnOrigin, buildId),
          'utf-8',
        );

        console.log(
          `[versioned-cdn-assets] published ${plan.assetPaths.length} executable/style asset(s) ` +
          `under /assets/${releasePrefix}/; kept ${plan.stableBlogBodyAssets.length} article body leaf/leaves stable`,
        );
      },
    },
  };
}
