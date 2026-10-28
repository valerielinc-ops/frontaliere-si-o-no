/**
 * Reconcile sitemap XML after locale/section shard rehydration.
 *
 * The Vite sitemap-alias hook runs before the deploy workflow reconstructs
 * the logical dist from shard artifacts. A shard can therefore replace a
 * sitemap URL's HTML with a noindex or non-self-canonical document after the
 * build-time reconciliation has already finished. Reuse the same final-dist
 * predicate here so the validators inspect the artifact that will actually
 * be served.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_URL } from '../../build-plugins/constants';
import {
  buildSitemapIndexXml,
  discoverSitemapFiles,
  reconcileFinalSitemapsWithDist,
} from '../../build-plugins/sitemapAliasPlugin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = path.join(repoRoot, 'dist');

async function main(): Promise<void> {
  if (!fs.existsSync(distDir)) {
    throw new Error(`reconcile-rehydrated-sitemaps: dist/ not found at ${distDir}`);
  }

  await reconcileFinalSitemapsWithDist(distDir, []);

  // The reconciler can remove an emptied shard. Keep sitemap.xml in sync with
  // the files that remain in the assembled dist before any consumer reads it.
  const discovered = await discoverSitemapFiles(distDir);
  fs.writeFileSync(
    path.join(distDir, 'sitemap.xml'),
    buildSitemapIndexXml(discovered, BASE_URL),
    'utf8',
  );
  console.log(
    `[rehydrated-sitemaps] reconciled final dist and indexed ${discovered.length} sitemap file(s)`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `reconcile-rehydrated-sitemaps failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
