#!/usr/bin/env node
// refresh-compat-manifest.mjs — realign data/seo-404-compat/manifest.json's
// `totalPaths` with the shards after a merge/rebase that unioned them without
// going through writeCompatPaths (the `merge=compat-shard` driver cannot update
// the manifest, and a manifest that merges cleanly keeps ONE side's total).
//
// Usage: node scripts/ci/refresh-compat-manifest.mjs [--root DIR] [--check]
//   (default)  rewrite the manifest when its total differs from the shards
//   --check    report only; exit 1 when the manifest lags/leads its shards
// Exit 2 when the shard set itself is invalid (missing/corrupt/duplicate/
// misassigned shard): that is never repaired by re-counting.
import path from 'node:path';
import { refreshCompatManifest } from '../lib/compat-paths-store.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 && args[rootIdx + 1] ? path.resolve(args[rootIdx + 1]) : process.cwd();

try {
  const result = refreshCompatManifest(root, { check });
  if (result.skipped) {
    console.log(`[refresh-compat-manifest] nothing to do (${result.skipped})`);
  } else if (!result.changed) {
    console.log(`[refresh-compat-manifest] manifest already matches its shards (${result.actualTotalPaths} paths)`);
  } else if (check) {
    console.error(
      `[refresh-compat-manifest] manifest declares ${result.declaredTotalPaths} paths but the shards contain ${result.actualTotalPaths}`,
    );
    process.exit(1);
  } else {
    console.log(
      `[refresh-compat-manifest] realigned manifest totalPaths ${result.declaredTotalPaths} -> ${result.actualTotalPaths}`,
    );
  }
} catch (err) {
  console.error(`[refresh-compat-manifest] ${err?.message ?? err}`);
  process.exit(2);
}
