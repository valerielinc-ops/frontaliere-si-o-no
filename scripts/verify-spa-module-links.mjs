#!/usr/bin/env node
/**
 * Build-time equivalent of the live CDN module-link check.
 *
 * Stable asset filenames make a mixed-generation deploy possible: an importer
 * from generation N can be loaded beside its exporter from generation N-1.
 * Vite/Rollup can still finish that build successfully because each generation
 * is internally valid. The browser is the first place that resolves the named
 * binding across the two files, unless we check the complete emitted graph.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CDN_ASSETS_BASE,
  linkCheck,
  parseModuleLinks,
} from './ci/cdn-chunk-graph.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function listAssets(assetsDir, pattern) {
  if (!fs.existsSync(assetsDir)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && pattern.test(entry.name)) files.push(file);
    }
  };
  visit(assetsDir);
  return files.sort();
}

function listJavaScriptAssets(assetsDir) {
  return listAssets(assetsDir, /\.m?js$/);
}

function listServedAssetFiles(assetsDir) {
  return listAssets(assetsDir, /\.(?:m?js|css)$/);
}

function isReleaseAsset(file, assetsDir) {
  const relative = toPosix(path.relative(assetsDir, file));
  return relative === 'releases' || relative.startsWith('releases/');
}

/**
 * Build the same URL-keyed graph used by the live watchdog, from emitted
 * files. The Map input keeps this function small and directly unit-testable.
 * `assetPaths` adds emitted non-JavaScript assets (currently CSS) to the
 * served set without pretending they are JavaScript modules to parse.
 */
export function buildLocalModuleGraph(sources, { base = CDN_ASSETS_BASE, assetPaths = [] } = {}) {
  const modules = new Map();
  for (const [relativePath, source] of sources) {
    const relativeUrl = toPosix(relativePath);
    const moduleUrl = new URL(relativeUrl, base).href;
    modules.set(moduleUrl, parseModuleLinks(source, moduleUrl));
  }

  const served = new Map([...modules.keys()].map((url) => [url, true]));
  for (const relativePath of assetPaths) {
    const relativeUrl = toPosix(relativePath);
    const assetUrl = new URL(relativeUrl, base).href;
    served.set(assetUrl, true);
  }
  for (const mod of modules.values()) {
    for (const ref of mod.imports) {
      if (!served.has(ref.url)) served.set(ref.url, false);
    }
  }
  return { modules, served };
}

export function verifyLocalModuleLinks(assetsDir) {
  const files = listJavaScriptAssets(assetsDir);
  const servedAssetFiles = listServedAssetFiles(assetsDir);
  if (files.length === 0) {
    throw new Error(`no JavaScript assets found in ${assetsDir}`);
  }

  const sources = new Map(
    files.map((file) => [
      toPosix(path.relative(assetsDir, file)),
      fs.readFileSync(file, 'utf8'),
    ]),
  );
  const assetPaths = servedAssetFiles.map((file) => toPosix(path.relative(assetsDir, file)));
  const graph = buildLocalModuleGraph(sources, { assetPaths });
  return { ...graph, files, broken: linkCheck(graph.modules, graph.served) };
}

/**
 * Verify a build-scoped release without treating the old stable copies of
 * application chunks as a second, active graph.
 *
 * Production CDN builds deliberately leave those root-level copies in the
 * staging tree for compatibility with older content, then replace only the
 * stable entry with a bootstrap. Their imports therefore point at the old
 * stable entry and are not expected to link against the bootstrap anymore.
 * The release graph is the executable graph to validate; root-level assets
 * remain in the served set so stable article/data leaves are still checked for
 * existence, and any stable JS module reached by a named/static import is
 * parsed recursively for export validation.
 */
export function verifyVersionedModuleLinks(assetsDir, releaseDir) {
  const files = listJavaScriptAssets(releaseDir);
  const servedAssetFiles = listServedAssetFiles(releaseDir);
  if (files.length === 0) {
    throw new Error(`no JavaScript assets found in ${releaseDir}`);
  }

  const releaseRelativeDir = toPosix(path.relative(assetsDir, releaseDir)).replace(/\/+$/, '');
  const releaseBase = new URL(`${releaseRelativeDir}/`, CDN_ASSETS_BASE).href;
  const sources = new Map(
    files.map((file) => [
      toPosix(path.relative(releaseDir, file)),
      fs.readFileSync(file, 'utf8'),
    ]),
  );
  const releaseAssetPaths = servedAssetFiles.map((file) => toPosix(path.relative(releaseDir, file)));
  const graph = buildLocalModuleGraph(sources, {
    base: releaseBase,
    assetPaths: releaseAssetPaths,
  });

  const stableFiles = listServedAssetFiles(assetsDir).filter(
    (file) => !isReleaseAsset(file, assetsDir),
  );
  const stableModules = new Map();
  for (const file of stableFiles) {
    const relative = toPosix(path.relative(assetsDir, file));
    const url = new URL(relative, CDN_ASSETS_BASE).href;
    graph.served.set(url, true);
    if (/\.m?js$/.test(file)) stableModules.set(url, file);
  }

  // A release may intentionally import stable data modules. Parse those
  // modules only when the active graph reaches them; parsing every stable
  // article-body leaf would turn this post-build check into another full
  // corpus walk, while their dynamic/default contract needs only existence.
  const pending = [];
  const queued = new Set();
  const enqueueStableDependencies = (module) => {
    for (const ref of module.imports) {
      if (!['static', 'reexport', 'reexport-all', 'preload'].includes(ref.kind)) continue;
      if (!stableModules.has(ref.url) || queued.has(ref.url) || graph.modules.has(ref.url)) continue;
      queued.add(ref.url);
      pending.push(ref.url);
    }
  };
  for (const module of graph.modules.values()) enqueueStableDependencies(module);

  while (pending.length > 0) {
    const url = pending.shift();
    const file = stableModules.get(url);
    if (!file || graph.modules.has(url)) continue;
    const module = parseModuleLinks(fs.readFileSync(file, 'utf8'), url);
    graph.modules.set(url, module);
    enqueueStableDependencies(module);
  }

  // Stable modules may introduce a missing dependency after the initial
  // release-only graph was built. Keep the same explicit false marker used by
  // buildLocalModuleGraph so linkCheck reports that 404 as a broken module.
  for (const module of graph.modules.values()) {
    for (const ref of module.imports) {
      if (!graph.served.has(ref.url)) graph.served.set(ref.url, false);
    }
  }

  return {
    ...graph,
    files: [...files, ...[...graph.modules.keys()]
      .filter((url) => stableModules.has(url))
      .map((url) => stableModules.get(url))],
    broken: linkCheck(graph.modules, graph.served),
  };
}

function assetLabel(url) {
  try {
    return new URL(url).pathname.replace(/^\/assets\//, '');
  } catch {
    return url;
  }
}

export function formatBrokenLinks(broken) {
  return broken.map(({ from, to, name, reason }) => {
    const binding = name ? ` '${name}'` : '';
    return `- ${assetLabel(from)} → ${assetLabel(to)}${binding} (${reason})`;
  });
}

function main() {
  const assetsDir = path.resolve(process.cwd(), 'dist', 'assets');
  const deployBuildId = (process.env.DEPLOY_BUILD_ID || '').trim();
  const assetCdn = (process.env.ASSET_CDN || '').trim();
  const releaseDir = deployBuildId && assetCdn
    ? path.join(assetsDir, 'releases', deployBuildId)
    : null;
  const result = releaseDir
    ? verifyVersionedModuleLinks(assetsDir, releaseDir)
    : verifyLocalModuleLinks(assetsDir);
  if (result.broken.length > 0) {
    console.error(
      `[verify-spa-module-links] ${result.broken.length} broken module link(s) in ${assetsDir}:\n` +
        formatBrokenLinks(result.broken).join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[verify-spa-module-links] ok — ${result.files.length} JavaScript asset(s) linked`);
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}
