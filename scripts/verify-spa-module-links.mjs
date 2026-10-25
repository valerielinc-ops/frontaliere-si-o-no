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

function listJavaScriptAssets(assetsDir) {
  if (!fs.existsSync(assetsDir)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.m?js$/.test(entry.name)) files.push(file);
    }
  };
  visit(assetsDir);
  return files.sort();
}

/**
 * Build the same URL-keyed graph used by the live watchdog, from emitted
 * files. The Map input keeps this function small and directly unit-testable.
 */
export function buildLocalModuleGraph(sources, { base = CDN_ASSETS_BASE } = {}) {
  const modules = new Map();
  for (const [relativePath, source] of sources) {
    const relativeUrl = toPosix(relativePath);
    const moduleUrl = new URL(relativeUrl, base).href;
    modules.set(moduleUrl, parseModuleLinks(source, moduleUrl));
  }

  const served = new Map([...modules.keys()].map((url) => [url, true]));
  for (const mod of modules.values()) {
    for (const ref of mod.imports) {
      if (!served.has(ref.url)) served.set(ref.url, false);
    }
  }
  return { modules, served };
}

export function verifyLocalModuleLinks(assetsDir) {
  const files = listJavaScriptAssets(assetsDir);
  if (files.length === 0) {
    throw new Error(`no JavaScript assets found in ${assetsDir}`);
  }

  const sources = new Map(
    files.map((file) => [
      toPosix(path.relative(assetsDir, file)),
      fs.readFileSync(file, 'utf8'),
    ]),
  );
  const graph = buildLocalModuleGraph(sources);
  return { ...graph, files, broken: linkCheck(graph.modules, graph.served) };
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
  const result = verifyLocalModuleLinks(assetsDir);
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
